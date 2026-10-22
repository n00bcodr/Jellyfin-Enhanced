using System.Text.Json;
using Jellyfin.Data;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Model.Entities;
using static JE.Tests.IntegrationNotificationsTests;

namespace JE.Tests;

/// <summary>
/// Hardening of the notifications ("Requests &amp; downloads", phase 2): the recipient and the
/// settings checked again when a held delivery finally goes out (deleted, disabled, demoted or
/// restricted users; channels and kinds of alert switched off; notifications switched off mid-round),
/// a deleted user's rows removed even with notifications off; one title told once whichever ids it
/// is followed or asked for under (movies and series, in either order, across a restart); the Ready
/// and new-episode transitions all-or-nothing under a database fault; a batch that keeps failing
/// dropped without holding up the others; the Seerr server's identity (a replaced Seerr is recorded
/// afresh, telling nobody); Seerr lists read incompletely changing nothing; stopping waits for the
/// work in flight; and the arrival tracker keeping fresh entries when it is full.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationNotifyHardeningTests
{
    private const string Dune = "movie:tmdb:693134";

    [Fact]
    public async Task EpisodeDeliveriesStoredWithoutFileIdsKeepTheirParentVisibilityCheck()
    {
        using var rig = await Started();
        rig.Phones(rig.Emma);
        var series = Guid.NewGuid();
        rig.View.AddCopy(TitleKey.Parse("tv:tvdb:371980")!, new JfCopy { ItemId = series });
        // Adapted in edition round 20: an older alert is checked by its scope too, so Season 2 plays two episodes for her.
        rig.View.AddEpisodeFile(series, TitleKey.Parse("tv:tvdb:371980")!, 2, 1, 1920, 1080, rig.Arr.Now.UtcDateTime);
        rig.View.AddEpisodeFile(series, TitleKey.Parse("tv:tvdb:371980")!, 2, 2, 1920, 1080, rig.Arr.Now.UtcDateTime);
        var id = rig.NotifyStore.Add(rig.Emma.UserId, "older-episode-batch", NotifyKind.Episodes, "tv:tvdb:371980", series.ToString("N"),
            new Dictionary<string, string> { ["title"] = "Severance", ["mode"] = "many", ["count"] = "2", ["seasons"] = "2" },
            new[] { (NotifyChannel.Ntfy, rig.Arr.Now) }, rig.Arr.Now);
        Assert.NotNull(id);
        await rig.Dispatcher.RunOnceAsync(default);
        Assert.Equal("Severance: 2 new episodes ready", (string?)Assert.Single(rig.Pushes).Body["title"]);
        Assert.Equal(("sent", 1), Deliveries(rig, rig.Emma).Select(d => (d.Status, d.Attempts)).Single());
    }

    [Fact]
    public async Task ASeriesKnownOnlyByTmdbUsesItsSeerrAliasToFindTheSonarrDownload()
    {
        const string tmdb = "tv:tmdb:95396";
        var series = Guid.NewGuid();
        using var rig = await Started(r =>
        {
            r.Request(1, 95396, r.Emma, type: "tv", tvdb: 371980);
            r.View.AddItem(new JfItemRef { ItemId = series, Kind = "series", Key = TitleKey.Parse(tmdb) });
            r.View.AddCopy(TitleKey.Parse(tmdb)!, new JfCopy { ItemId = series });
            var row = FakeArr.SonarrQueueRow(51, "episode", 2, 1, "Severance", 371980, tmdb: null);
            row["seriesId"] = 5;
            row["series"]!["id"] = 5;
            r.Sonarr.Queue.Add(row);
            r.Sonarr.Series[0]["seasons"] = System.Text.Json.Nodes.JsonNode.Parse("[{\"seasonNumber\":2,\"monitored\":true,\"statistics\":{\"totalEpisodeCount\":1}}]");
            var episode = FakeArr.Episode(51, "2020-01-01T00:00:00Z", tvdb: 371980, episode: 1, season: 2);
            episode["seriesId"] = 5;
            r.Sonarr.Episodes.Add(episode);
        });
        foreach (var body in new[] {
            await rig.Status.ForBatchAsync(rig.Emma, new[] { series }, Array.Empty<TitleKey>(), default),
            await rig.Status.ForItemAsync(rig.Emma, series, default) })
        {
            var status = JsonDocument.Parse(body.Json).RootElement.GetProperty("items")[0];
            Assert.Equal(tmdb, status.GetProperty("key").GetString());
            Assert.Equal("tv:tvdb:371980", status.GetProperty("liveKey").GetString());
            Assert.True(status.GetProperty("stage").GetString() == "downloading", System.Text.Encoding.UTF8.GetString(body.Json));
            Assert.Equal(75, status.GetProperty("progress").GetProperty("percent").GetInt32());
        }
        rig.View.CopiesByKey.Clear();
        var user = (Jellyfin.Database.Implementations.Entities.User)rig.Sam.Handle!;
        user.SetPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.EnableAllFolders, false);
        var rows = ArrRegistryMigration.Parse(rig.Config.SonarrInstances)!;
        rows[0].LinkedLibraryIds = [Guid.NewGuid().ToString("N")];
        rig.Config.SonarrInstances = ArrRegistryMigration.Serialize(rows);
        var hidden = await rig.Status.ForBatchAsync(rig.Sam, Array.Empty<Guid>(), new[] { TitleKey.Parse(tmdb)! }, default);
        Assert.Empty(JsonDocument.Parse(hidden.Json).RootElement.GetProperty("items").EnumerateArray());
        Assert.False(rig.Status.MayFollow(rig.Sam, TitleKey.Parse(tmdb)!));
    }

    [Fact]
    public async Task FollowingAnAbsentTitleInAHiddenLibraryIsRefusedUntilItIsTheViewersOwnRequest()
    {
        using var rig = await Started();
        var user = (Jellyfin.Database.Implementations.Entities.User)rig.Sam.Handle!;
        user.SetPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.EnableAllFolders, false);
        var rows = ArrRegistryMigration.Parse(rig.Config.RadarrInstances)!;
        rows[0].LinkedLibraryIds = [Guid.NewGuid().ToString("N")];
        rig.Config.RadarrInstances = ArrRegistryMigration.Serialize(rows);
        await rig.Status.ForBatchAsync(rig.Sam, Array.Empty<Guid>(), new[] { TitleKey.Parse(Dune)! }, default);
        var controller = new NotifyController(rig.Service, rig.Dispatcher, new NtfySender(rig.Ntfy), new EmailSender(rig.Mail), rig.Users)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
            Config = () => rig.Config,
            Now = () => rig.Arr.Now,
        };
        controller.HttpContext.User = TestCallers.Principal(rig.Sam.UserId, admin: false);
        var refused = Assert.IsType<ObjectResult>(await controller.PutFollow(new FollowRequest { Key = Dune, On = true }, default));
        Assert.Equal(403, refused.StatusCode);
        Assert.Equal("not_allowed", JsonSerializer.SerializeToElement(refused.Value).GetProperty("code").GetString());
        Assert.Empty(rig.NotifyStore.Follows(rig.Sam.UserId));
        rig.Request(1, 693134, rig.Sam);
        await rig.Requests.RefreshAsync(default);
        Assert.IsType<OkObjectResult>(await controller.PutFollow(new FollowRequest { Key = Dune, On = true }, default));
        Assert.Single(rig.NotifyStore.Follows(rig.Sam.UserId));
    }

    [Theory]
    [InlineData(0, false)]
    [InlineData(1, false)]
    [InlineData(2, false)]
    [InlineData(0, true)]
    [InlineData(1, true)]
    public async Task EpisodeDeliveriesHeldByQuietHoursRecheckEveryFileAndRenderOnlyVisibleNumbers(int visibleCount, bool seasonPack)
    {
        const string show = "tv:tvdb:371980";
        var series = Guid.NewGuid();
        using var rig = await Started(r =>
        {
            r.Request(1, 95396, r.Emma, type: "tv", tvdb: 371980, seasons: new[] { 2 });
            r.View.AddCopy(TitleKey.Parse(show)!, new JfCopy { ItemId = series, DateCreated = r.Arr.Now.UtcDateTime.AddDays(-30) });
            r.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = r.Arr.Now.UtcDateTime.AddDays(-30) });
            r.View.AddSeason(series, new JfSeason { ItemId = Guid.NewGuid(), Season = 2 });
            if (seasonPack) r.Sonarr.Series[0]["seasons"] = System.Text.Json.Nodes.JsonNode.Parse("[{\"seasonNumber\":2,\"monitored\":true,\"statistics\":{\"totalEpisodeCount\":2}}]");
        });
        rig.Phones(rig.Emma);
        QuietAllDay(rig, rig.Emma);
        var files = new[] { Guid.NewGuid(), Guid.NewGuid() };
        for (var i = 0; i < 2; i++) rig.View.AddEpisode(series, new JfEpisode { ItemId = files[i], Season = 2, Episode = i + 1, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(show);
        rig.Arr.Now += TimeSpan.FromMinutes(11);
        await rig.Step(show);
        Assert.Equal(seasonPack ? "season" : "many", Params(Assert.Single(rig.Inbox(rig.Emma)).Payload)["mode"]);
        Assert.Equal(2, Deliveries(rig, rig.Emma).Count(d => d.Status == "pending"));
        var episodes = rig.View.EpisodesBySeries[series];
        for (var i = visibleCount; i < 2; i++)
        {
            var index = episodes.FindIndex(e => e.Episode.ItemId == files[i]);
            episodes[index] = (episodes[index].Episode, new HashSet<Guid> { rig.Admin.UserId });
        }
        Assert.NotNull(rig.View.Resolve(series, rig.Emma));
        QuietAllDay(rig, rig.Emma, on: false);
        rig.Arr.Now += TimeSpan.FromDays(1);
        await rig.Dispatcher.RunOnceAsync(default);
        rig.Arr.Now += TimeSpan.FromHours(8);
        await rig.Dispatcher.RunOnceAsync(default);
        if (visibleCount == 0)
        {
            Assert.Empty(rig.Pushes);
            Assert.Empty(rig.Mail.Sent);
            Assert.All(Deliveries(rig, rig.Emma), d => Assert.Equal(("suppressed", 0), (d.Status, d.Attempts)));
        }
        else
        {
            var push = Assert.Single(rig.Pushes).Body;
            Assert.Single(rig.Mail.Sent);
            Assert.Equal(visibleCount == 1 ? "Severance: episode 1 is ready" : "Severance: 2 new episodes ready", (string?)push["title"]);
            Assert.Equal(visibleCount == 1 ? "Season 2, episode 1." : "Season 2.", (string?)push["message"]);
            if (visibleCount == 1) Assert.Contains(files[0].ToString("N"), (string?)push["click"]);
            Assert.All(Deliveries(rig, rig.Emma), d => Assert.Equal(("sent", 1), (d.Status, d.Attempts)));
        }
    }

    [Fact]
    public async Task ACombinedFileWithMoreThanFiftyEpisodesIsFullyBatchedOnceAcrossARestart()
    {
        const string show = "tv:tvdb:371980";
        var series = Guid.NewGuid();
        using var rig = await Started(r =>
        {
            r.Request(1, 95396, r.Emma, type: "tv", tvdb: 371980, seasons: new[] { 1 });
            r.View.AddCopy(TitleKey.Parse(show)!, new JfCopy { ItemId = series, DateCreated = r.Arr.Now.UtcDateTime.AddDays(-30) });
            r.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = r.Arr.Now.UtcDateTime.AddDays(-30) });
        });
        rig.Phones(rig.Emma);
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 2, EpisodeEnd = 61, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(show);
        rig.Open();
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step(show);
        var told = Assert.Single(rig.Inbox(rig.Emma));
        Assert.Equal(("episodes", "60"), (told.Kind, Params(told.Payload)["count"]));
        Assert.Single(rig.Pushes);
        rig.Open();
        await rig.Step(show);
        Assert.Single(rig.Inbox(rig.Emma));
        Assert.Single(rig.Pushes);
    }

    [Theory]
    [InlineData(int.MaxValue)]
    [InlineData(100000)]
    public async Task AnEnormousHiddenCombinedFileSuppressesPendingTailEpisodesWithoutExpansion(int end)
    {
        const string show = "tv:tvdb:371980";
        var series = Guid.NewGuid();
        using var rig = await Started(r =>
        {
            r.Request(1, 95396, r.Kid, type: "tv", tvdb: 371980, seasons: new[] { 1 });
            r.View.AddCopy(TitleKey.Parse(show)!, new JfCopy { ItemId = series, DateCreated = r.Arr.Now.UtcDateTime.AddDays(-30) });
        });
        foreach (var number in new[] { 60, 5000 })
            rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = number, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(show);
        Assert.NotNull(rig.NotifyStore.Batch(rig.Kid.UserId, show));
        rig.View.EpisodesBySeries[series].Clear();
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, EpisodeEnd = end }, rig.Admin.UserId);
        var clock = System.Diagnostics.Stopwatch.StartNew();
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step(show);
        Assert.Empty(rig.Inbox(rig.Kid));
        Assert.Null(rig.NotifyStore.Batch(rig.Kid.UserId, show));
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(5));
    }

    [Theory]
    [InlineData(int.MaxValue)]
    [InlineData(100000)]
    public async Task EnormousVisibleCombinedFilesMatchPendingTailEpisodesAndBoundDiscovery(int end)
    {
        const string show = "tv:tvdb:371980";
        var series = Guid.NewGuid();
        using var rig = await Started(r =>
        {
            r.Request(1, 95396, r.Emma, type: "tv", tvdb: 371980, seasons: new[] { 1 });
            r.View.AddCopy(TitleKey.Parse(show)!, new JfCopy { ItemId = series, DateCreated = r.Arr.Now.UtcDateTime.AddDays(-30) });
        });
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 5000, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(show);
        rig.View.EpisodesBySeries[series].Clear();
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, EpisodeEnd = end, DateCreated = rig.Arr.Now.UtcDateTime });
        var clock = System.Diagnostics.Stopwatch.StartNew();
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        Assert.Equal(1, rig.Service.FlushBatches(rig.Arr.Now));
        var told = Assert.Single(rig.Inbox(rig.Emma));
        Assert.Equal("5000", Params(told.Payload)["episode"]);
        await rig.Step(show);
        var batch = rig.NotifyStore.Batch(rig.Emma.UserId, show);
        Assert.NotNull(batch);
        using var payload = JsonDocument.Parse(batch!.Value.Episodes);
        Assert.Equal(EpisodeRange.MaxSyntheticEpisodes, payload.RootElement.GetProperty("Episodes").GetArrayLength());
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task ActualSonarrEpisodesBeyondSyntheticRowsAreDiscoveredByRangeMembership()
    {
        const string show = "tv:tvdb:371980";
        var series = Guid.NewGuid();
        using var rig = await Started(r =>
        {
            r.Request(1, 95396, r.Emma, type: "tv", tvdb: 371980, seasons: new[] { 1 });
            r.View.AddCopy(TitleKey.Parse(show)!, new JfCopy { ItemId = series, DateCreated = r.Arr.Now.UtcDateTime.AddDays(-30) });
            var episode = FakeArr.Episode(5000, "2026-01-01T00:00:00Z", episode: 5000);
            episode["seriesId"] = 5;
            r.Sonarr.Episodes.Add(episode);
        });
        var instance = Assert.Single(rig.Store.Instances(ArrKind.Sonarr));
        var read = await rig.Store.GetEpisodesAsync(instance, 5, default);
        Assert.NotNull(read.Value);
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, EpisodeEnd = int.MaxValue, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(show);
        using var batch = JsonDocument.Parse(rig.NotifyStore.Batch(rig.Emma.UserId, show)!.Value.Episodes);
        var episodes = batch.RootElement.GetProperty("Episodes").EnumerateArray().ToArray();
        Assert.Equal(EpisodeRange.MaxSyntheticEpisodes + 1, episodes.Length);
        Assert.Contains(episodes, e => e.GetProperty("E").GetInt32() == 5000);
    }

    [Fact]
    public async Task ACombinedFileEndingAtTheLastIntegerHasABoundedWatchBaselineAcrossReads()
    {
        const string show = "tv:tvdb:371980";
        var series = Guid.NewGuid();
        using var rig = await Started(r =>
        {
            r.Request(1, 95396, r.Emma, type: "tv", tvdb: 371980, seasons: new[] { 1 });
            r.View.AddCopy(TitleKey.Parse(show)!, new JfCopy { ItemId = series, DateCreated = r.Arr.Now.UtcDateTime.AddDays(-30) });
            r.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = int.MaxValue - 2, EpisodeEnd = int.MaxValue, DateCreated = r.Arr.Now.UtcDateTime.AddDays(-30) });
        });
        var clock = System.Diagnostics.Stopwatch.StartNew();
        await rig.Step(show);
        Assert.Empty(rig.Inbox(rig.Emma));
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(5));
    }

    private static Dictionary<string, string> Params(string payload) => JsonSerializer.Deserialize<Dictionary<string, string>>(payload)!;

    // Every delivery of a user: channel, status and attempts.
    private static List<(string Channel, string Status, int Attempts)> Deliveries(Rig rig, StatusViewer user) => rig.Db.Read(c =>
    {
        var list = new List<(string, string, int)>();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT d.channel, d.status, d.attempts FROM deliveries d JOIN notifications n ON n.id=d.notification_id WHERE n.user_id=$u ORDER BY d.id";
        cmd.Parameters.AddWithValue("$u", user.UserId.ToString("N"));
        using var r = cmd.ExecuteReader();
        while (r.Read()) list.Add((r.GetString(0), r.GetString(1), r.GetInt32(2)));
        return list;
    });

    private static int Rows(Rig rig, string table) => rig.Db.Read(c =>
    {
        using var cmd = c.CreateCommand();
        cmd.CommandText = $"SELECT COUNT(*) FROM {table}";
        return Convert.ToInt32(cmd.ExecuteScalar());
    });

    private static void QuietAllDay(Rig rig, StatusViewer user, bool on = true)
        => rig.Prefs(user, p => { p.QuietHours = on; p.QuietFrom = "00:00"; p.QuietTo = "23:59"; p.UtcOffsetMinutes = 0; });

    // A SQLite trigger failing every insert into a table (a database error at the worst moment).
    private static void FailInserts(Rig rig, string table, bool on) => rig.Db.Write((c, t) =>
    {
        using var cmd = c.CreateCommand();
        cmd.Transaction = t;
        cmd.CommandText = on
            ? $"CREATE TRIGGER h2_fail_{table} BEFORE INSERT ON {table} BEGIN SELECT RAISE(ABORT, 'disk full'); END"
            : $"DROP TRIGGER h2_fail_{table}";
        return cmd.ExecuteNonQuery();
    });

    private static async Task Until(Func<bool> check, int ms = 5000)
    {
        var end = DateTime.UtcNow.AddMilliseconds(ms);
        while (!check() && DateTime.UtcNow < end) await Task.Delay(10);
    }

    // ------------------------------------------------------------------ C05: the recipient, again, at send time

    [Theory]
    [InlineData("deleted")]
    [InlineData("disabled")]
    [InlineData("demoted")]
    [InlineData("restricted")]
    public async Task AnAlertHeldByQuietHoursIsSuppressedWithNoRetriesWhenItsRecipientMayNoLongerHaveIt(string change)
    {
        using var rig = await Started(r => r.Request(1, 693134, r.Emma));
        var admin = change == "demoted";
        var who = admin ? rig.Admin : rig.Emma;
        rig.Phones(who);
        QuietAllDay(rig, who);
        await rig.Step(Dune);
        var item = rig.Arrive(Dune);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        // A request waiting for an OK (the administrators' alert) and Dune arriving (Emma's Ready).
        rig.Seerr.Requests.Add(FakeSeerr.Request(7, "movie", 4242, 1, rig.Sam.UserId, rig.Arr.Now.UtcDateTime, userName: "Sam"));
        await rig.Step(Dune);
        Assert.Equal(2, Deliveries(rig, who).Count(d => d.Status == "pending"));
        switch (change)
        {
            case "deleted": rig.Users.Gone.Add(who.UserId); break;
            case "disabled": rig.Users.Disabled.Add(who.UserId); break;
            case "demoted": rig.Users.AdminIds.Clear(); break;
            default:
                rig.View.CopiesByKey[Dune] = new() { (new JfCopy { ItemId = item, Path = "/media/" + Dune, LibraryName = "Movies" }, new HashSet<Guid> { rig.Admin.UserId }) };
                break;
        }
        QuietAllDay(rig, who, on: false);
        // The deliveries come due (before any housekeeping removes a deleted user's rows).
        rig.Arr.Now = rig.Arr.Now.AddDays(1);
        await rig.Dispatcher.RunOnceAsync(default);
        rig.Arr.Now = rig.Arr.Now.AddHours(8);
        await rig.Dispatcher.RunOnceAsync(default);
        Assert.Empty(rig.Pushes);
        Assert.Empty(rig.Mail.Sent);
        Assert.All(Deliveries(rig, who), d => Assert.Equal(("suppressed", 0), (d.Status, d.Attempts)));
        Assert.Equal(2, Deliveries(rig, who).Count);
        Assert.Empty(rig.NotifyStore.DeliveryStats(rig.Arr.Now).Problems);
    }

    [Theory]
    [InlineData("server-ntfy")]
    [InlineData("user-ntfy")]
    [InlineData("server-email")]
    [InlineData("user-email")]
    public async Task AChannelSwitchedOffAfterTheAlertWasQueuedIsSuppressedNotRetried(string off)
    {
        using var rig = await Started(r => r.Request(1, 693134, r.Emma));
        rig.Phones(rig.Emma);
        QuietAllDay(rig, rig.Emma);
        await rig.Step(Dune);
        rig.Arrive(Dune);
        await rig.Step(Dune);
        Assert.Equal(new[] { "pending", "pending" }, Deliveries(rig, rig.Emma).Select(d => d.Status));
        switch (off)
        {
            case "server-ntfy": rig.Config.ArrNtfyEnabled = false; break;
            case "user-ntfy": rig.Prefs(rig.Emma, p => p.Ntfy = false); break;
            case "server-email": rig.Config.ArrEmailEnabled = false; break;
            default: rig.Prefs(rig.Emma, p => p.Email = false); break;
        }
        QuietAllDay(rig, rig.Emma, on: false);
        rig.Arr.Now = rig.Arr.Now.AddDays(1);
        await rig.Step();
        var channel = off.EndsWith("ntfy", StringComparison.Ordinal) ? NotifyChannel.Ntfy : NotifyChannel.Email;
        var other = channel == NotifyChannel.Ntfy ? NotifyChannel.Email : NotifyChannel.Ntfy;
        var deliveries = Deliveries(rig, rig.Emma);
        Assert.Equal(("suppressed", 0), deliveries.Where(d => d.Channel == channel).Select(d => (d.Status, d.Attempts)).Single());
        Assert.Equal("sent", deliveries.Single(d => d.Channel == other).Status);
        // Not a failure: nothing for the administrators to look into, nothing to retry later.
        var stats = rig.NotifyStore.DeliveryStats(rig.Arr.Now);
        Assert.Equal((0, 0), (stats.Pending, stats.Failed24h));
        Assert.Empty(stats.Problems);
    }

    [Theory]
    [InlineData("ready")]
    [InlineData("declined")]
    public async Task AKindOfAlertSwitchedOffAfterItWasQueuedIsNotSent(string kind)
    {
        using var rig = await Started(r => r.Request(1, 693134, r.Emma));
        rig.Phones(rig.Emma);
        QuietAllDay(rig, rig.Emma);
        await rig.Step(Dune);
        if (kind == "ready")
        {
            rig.Arrive(Dune);
        }
        else
        {
            rig.Seerr.Requests.Clear();
            rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
            rig.Seerr.Requests.Add(FakeSeerr.Request(1, "movie", 693134, 3, rig.Emma.UserId, Asked, rig.Arr.Now.UtcDateTime, userName: "Emma"));
        }
        await rig.Step(Dune);
        Assert.Equal(kind, Assert.Single(rig.Inbox(rig.Emma)).Kind);
        rig.Prefs(rig.Emma, p =>
        {
            p.QuietHours = false;
            if (kind == "ready") p.Ready = false;
            else p.Declined = false;
        });
        rig.Arr.Now = rig.Arr.Now.AddDays(1);
        await rig.Step();
        Assert.Empty(rig.Pushes);
        Assert.Empty(rig.Mail.Sent);
        Assert.All(Deliveries(rig, rig.Emma), d => Assert.Equal(("suppressed", 0), (d.Status, d.Attempts)));
    }

    private static readonly DateTime Asked = new(2026, 10, 12, 9, 0, 0, DateTimeKind.Utc);

    [Fact]
    public async Task NotificationsSwitchedOffMidRoundLeaveTheRestPendingUntilTheyAreBack()
    {
        using var rig = await Started(r =>
        {
            r.Request(1, 693134, r.Emma);
            r.Request(2, 693134, r.Sam);
        });
        rig.Prefs(rig.Emma, p => { p.Ntfy = true; p.NtfyTopic = "je-topic-emma1"; });
        rig.Prefs(rig.Sam, p => { p.Ntfy = true; p.NtfyTopic = "je-topic-sam12"; });
        await rig.Step(Dune);
        // The administrator switches notifications off while the first push is on its way.
        rig.OnPush = () =>
        {
            rig.Config.ArrNotificationsEnabled = false;
            return Task.CompletedTask;
        };
        rig.Arrive(Dune);
        await rig.Step(Dune);
        Assert.Single(rig.Pushes);
        var all = Deliveries(rig, rig.Emma).Concat(Deliveries(rig, rig.Sam)).ToList();
        Assert.Equal(new[] { ("pending", 0), ("sent", 1) }, all.Select(d => (d.Status, d.Attempts)).OrderBy(x => x.Item1));
        // Back on: the rest goes out.
        rig.OnPush = null;
        rig.Config.ArrNotificationsEnabled = true;
        await rig.Dispatcher.RunOnceAsync(default);
        Assert.Equal(2, rig.Pushes.Count);
    }

    [Fact]
    public async Task ADeletedUsersRowsGoEvenWithNotificationsOffAndNothingIsCreatedWhereNothingWasKept()
    {
        using var rig = await Started(r => r.Request(1, 693134, r.Emma));
        rig.Phones(rig.Emma, rig.Sam);
        // The Seerr requests seen keep no user: their states are all that's compared.
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        rig.Request(2, 4243, rig.Emma, status: 1);
        await rig.Step();
        Assert.True(rig.NotifyStore.SeerrSeen().ContainsKey(1));
        Assert.True(rig.NotifyStore.SeerrSeen().ContainsKey(2));
        Assert.Equal(0, SeerrSeenOf(rig, null));
        // An earlier version noted Emma on her request (and Sam on another one).
        LegacySeerrSeenUser(rig, 1, rig.Emma.UserId);
        LegacySeerrSeenUser(rig, 2, rig.Sam.UserId);
        Assert.Equal(1, SeerrSeenOf(rig, rig.Emma.UserId));
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse("movie:tmdb:4242")!, true, default));
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Sam, TitleKey.Parse("movie:tmdb:4242")!, true, default));
        Assert.True(rig.Service.SendTest(rig.Emma.UserId));
        rig.Config.ArrNotificationsEnabled = false;
        rig.Users.Gone.Add(rig.Emma.UserId);
        Assert.True(NotifyUserPurge.Purge(rig.NotifyStore, rig.Emma.UserId, null) > 0);
        Assert.Empty(rig.NotifyStore.Follows(rig.Emma.UserId));
        Assert.Empty(rig.Inbox(rig.Emma));
        Assert.False(rig.NotifyStore.Prefs(rig.Emma.UserId).Ntfy);
        Assert.Empty(Deliveries(rig, rig.Emma));
        // Others keep theirs.
        Assert.Single(rig.NotifyStore.Follows(rig.Sam.UserId));
        Assert.True(rig.NotifyStore.Prefs(rig.Sam.UserId).Ntfy);
        // Her id no longer stands against her request; its state stays (it tells what's new).
        Assert.Equal(0, SeerrSeenOf(rig, rig.Emma.UserId));
        Assert.True(rig.NotifyStore.SeerrSeen().ContainsKey(1));
        // Housekeeping clears the ids earlier versions noted for anyone.
        Assert.Equal(1, SeerrSeenOf(rig, rig.Sam.UserId));
        rig.NotifyStore.Purge(rig.Arr.Now, _ => true);
        Assert.Equal(0, SeerrSeenOf(rig, null));
        Assert.True(rig.NotifyStore.SeerrSeen().ContainsKey(2));
        // A server that never used the database: nothing to remove, and it is not created for it.
        var path = Path.Combine(Path.GetTempPath(), "je-h2-" + Guid.NewGuid().ToString("N"), AcquireDatabase.FileName);
        using var unused = new AcquireDatabase(path);
        var store = new NotifyStore(unused);
        Assert.Equal(0, NotifyUserPurge.Purge(store, rig.Emma.UserId, null));
        Assert.False(File.Exists(path));
        // ... but the deletion is noted: a write already on its way for her (her settings, saved as she
        // was deleted) that creates the database keeps nothing of hers. Others' writes stay.
        store.SavePrefs(rig.Emma.UserId, new NotifyPrefs { Ntfy = true }, rig.Arr.Now);
        store.SavePrefs(rig.Sam.UserId, new NotifyPrefs { Ntfy = true }, rig.Arr.Now);
        Assert.True(File.Exists(path));
        Assert.False(store.Prefs(rig.Emma.UserId).Ntfy);
        Assert.True(store.Prefs(rig.Sam.UserId).Ntfy);
        Assert.DoesNotContain(rig.Emma.UserId, store.AllPrefs().Keys);
    }

    private static void LegacySeerrSeenUser(Rig rig, int request, Guid user) => rig.Db.Write((c, t) =>
    {
        using var cmd = c.CreateCommand();
        cmd.Transaction = t;
        cmd.CommandText = "UPDATE seerr_seen SET user_id=$u WHERE request_id=$r";
        cmd.Parameters.AddWithValue("$u", user.ToString("N"));
        cmd.Parameters.AddWithValue("$r", request);
        return cmd.ExecuteNonQuery();
    });

    // Seerr requests seen noted against a user (any user when null).
    private static int SeerrSeenOf(Rig rig, Guid? user) => rig.Db.Read(c =>
    {
        using var cmd = c.CreateCommand();
        cmd.CommandText = user == null ? "SELECT COUNT(*) FROM seerr_seen WHERE user_id IS NOT NULL" : "SELECT COUNT(*) FROM seerr_seen WHERE user_id=$u";
        if (user != null) cmd.Parameters.AddWithValue("$u", user.Value.ToString("N"));
        return Convert.ToInt32(cmd.ExecuteScalar());
    });

    // Rows a user has in each per-user table.
    private static Dictionary<string, int> RowsOf(Rig rig, Guid user) => rig.Db.Read(c =>
    {
        var counts = new Dictionary<string, int>();
        foreach (var table in new[] { "follows", "notify_prefs", "watch", "notifications", "batches", "marks", "email_codes" })
        {
            using var cmd = c.CreateCommand();
            cmd.CommandText = $"SELECT COUNT(*) FROM {table} WHERE user_id=$u";
            cmd.Parameters.AddWithValue("$u", user.ToString("N"));
            counts[table] = Convert.ToInt32(cmd.ExecuteScalar());
        }
        return counts;
    });

    [Fact]
    public async Task AUserDeletedRightAfterARoundCheckedThemKeepsNothingTheRoundWroteAfterwards()
    {
        using var rig = await Started(r => r.Request(1, 693134, r.Emma));
        rig.Phones(rig.Emma, rig.Sam);
        var emma = rig.Emma.UserId;
        Assert.Contains(RowsOf(rig, emma), x => x.Key == "watch" && x.Value > 0);
        // The round checks Emma, then deletion immediately suppresses later writes while its
        // database purge waits behind the ordered observation. No callback synchronously re-enters the gate.
        Task<int>? purge = null;
        rig.View.OnViewer = id =>
        {
            if (id != emma || rig.Users.Gone.Contains(emma)) return;
            rig.Users.Gone.Add(emma);
            rig.NotifyStore.NoteDeleted(emma);
            purge = Task.Run(() => NotifyUserPurge.Purge(rig.NotifyStore, emma, null));
        };
        rig.Arrive(Dune);
        await rig.Step(Dune);
        rig.View.OnViewer = null;
        Assert.NotNull(purge); await purge!.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Contains(emma, rig.Users.Gone);
        Assert.All(RowsOf(rig, emma), x => Assert.True(x.Value == 0, x.Key + " has " + x.Value + " rows of the deleted user"));
        Assert.Empty(Deliveries(rig, rig.Emma));
        // Other writes composed for her a moment later leave nothing either; others keep theirs.
        rig.NotifyStore.SetFollow(emma, Dune, "title", muted: false, remove: false, rig.Arr.Now);
        rig.NotifyStore.SetMark(emma, "late", rig.Arr.Now);
        rig.NotifyStore.SetFollow(rig.Sam.UserId, Dune, "title", muted: false, remove: false, rig.Arr.Now);
        Assert.All(RowsOf(rig, emma), x => Assert.Equal(0, x.Value));
        Assert.Single(rig.NotifyStore.Follows(rig.Sam.UserId));
        Assert.True(rig.NotifyStore.Prefs(rig.Sam.UserId).Ntfy);
    }

    // ------------------------------------------------------------------ C18: one title, one Ready / one batch

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task APagedSeerrAliasReachedThroughSonarrIsOneEpisodeBatchAndKeepsTheRequestedVariant(bool only4k)
    {
        const string tvdb = "tv:tvdb:4243";
        const string tmdb = "tv:tmdb:9243";
        const string imdb = "tv:imdb:tt009243";
        var series = Guid.NewGuid();
        using var rig = await Started(r =>
        {
            r.Sonarr.Series.Add(FakeArr.SeriesRow(10, 4243, "Alias Show", tmdb: 9243));
            r.Seerr.PageCap = 25;
            r.Request(50, 9243, r.Emma, type: "tv", seasons: new[] { 1, 2 }, is4k: only4k);
            r.Seerr.Requests[^1]["media"]!["imdbId"] = "tt009243";
            if (only4k) r.Seerr.Requests[^1]["media"]!["jellyfinMediaId4k"] = series.ToString("N");
            // This request's aliases live beyond the first page and lack Sonarr's TVDB id.
            for (var id = 51; id <= 80; id++) r.Seerr.Requests.Add(FakeSeerr.Request(id, "movie", 10000 + id, 2, null, Asked));
        });
        rig.Phones(rig.Emma);
        foreach (var key in new[] { tvdb, tmdb, imdb })
        {
            var all = new[] { key }.Concat(rig.Status.Aliases.Of(TitleKey.Parse(key)!).Select(k => k.ToString())).ToHashSet();
            Assert.True(all.SetEquals(new[] { tvdb, tmdb, imdb }));
            Assert.Equal(tvdb, rig.Status.Aliases.Canonical(TitleKey.Parse(key)!).ToString());
        }
        rig.View.AddCopy(TitleKey.Parse(imdb)!, new JfCopy { ItemId = series, Path = "/srv/uhd/Alias Show", DateCreated = rig.Arr.Now.UtcDateTime });
        if (only4k)
        {
            var standard = Guid.NewGuid();
            rig.View.AddCopy(TitleKey.Parse(tmdb)!, new JfCopy { ItemId = standard, Path = "/srv/hd/Alias Show", DateCreated = rig.Arr.Now.UtcDateTime });
            rig.View.AddEpisode(standard, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 9, DateCreated = rig.Arr.Now.UtcDateTime });
        }
        rig.View.Rev++;
        await rig.Step(tvdb, tmdb, imdb);
        Assert.Empty(rig.Inbox(rig.Emma));
        foreach (var season in new[] { 1, 2 })
        {
            var id = Guid.NewGuid();
            rig.View.AddEpisode(series, new JfEpisode { ItemId = id, Season = season, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
            // The "/srv/uhd" copy's files are 2160p (a 4K request's arrival is a file with 4K dimensions, D44).
            rig.View.AddSource(id, 3840, 2160);
        }
        await rig.Step(imdb, tmdb, tvdb);
        rig.Open();
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step(tvdb, tmdb, imdb);
        var told = Assert.Single(rig.Inbox(rig.Emma));
        var p = Params(told.Payload);
        Assert.Equal(("episodes", "many", "2", "1, 2", series.ToString("N")), (told.Kind, p["mode"], p["count"], p["seasons"], told.ItemId));
        Assert.Equal(only4k, p.TryGetValue("variant", out var variant) && variant == "4k");
        Assert.Single(rig.Pushes);
        Assert.Single(rig.Mail.Sent);
    }

    [Fact]
    public async Task AliasResolutionKeepsTheLastCompleteSeerrListAndDropsAliasesFromAReplacedSource()
    {
        using var rig = await Started(r =>
        {
            r.Sonarr.Series.Add(FakeArr.SeriesRow(10, 4243, "Alias Show", tmdb: 9243));
            r.Seerr.PageCap = 1;
            r.Request(1, 9243, r.Emma, type: "tv");
            r.Seerr.Requests[^1]["media"]!["imdbId"] = "tt009243";
            r.Request(2, 5151, r.Sam);
        });
        var key = TitleKey.Parse("tv:tvdb:4243")!;
        bool Has(string alias) => rig.Status.Aliases.Of(key).Any(k => k.ToString() == alias);
        Assert.True(Has("tv:imdb:tt009243"));
        var revision = rig.Requests.Revision;
        rig.Arr.Now = rig.Arr.Now.AddMinutes(31);
        rig.Seerr.Requests[0]["media"]!["imdbId"] = "tt009244";
        rig.Seerr.BeforePage = skip =>
        {
            if (skip > 0) rig.Seerr.Requests.RemoveAll(r => (int)r["id"]! == 2);
        };
        Assert.False(await rig.Requests.RefreshAsync(default));
        Assert.NotNull(rig.Requests.State.IncompleteReason);
        Assert.Equal(revision, rig.Requests.Revision);
        Assert.True(Has("tv:imdb:tt009243"));
        Assert.False(Has("tv:imdb:tt009244"));
        rig.Seerr.BeforePage = null;
        Assert.True(await rig.Requests.RefreshAsync(default));
        Assert.False(Has("tv:imdb:tt009243"));
        Assert.True(Has("tv:imdb:tt009244"));
        rig.Config.JellyseerrUrls = "http://other-seerr.lan:5055";
        rig.Seerr.FailWith = 503;
        Assert.True(rig.Requests.Due());
        Assert.False(await rig.Requests.RefreshAsync(default));
        Assert.False(Has("tv:imdb:tt009244"));
        // The arr alias still works while the replacement Seerr has not loaded.
        Assert.Contains(rig.Status.Aliases.Of(key), k => k.ToString() == "tv:tmdb:9243");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ARequestChangeUnderAnotherAliasDoesNotDropAnEpisodeFromAContinuingInterest(bool decline)
    {
        const string tvdb = "tv:tvdb:4243";
        const string tmdb = "tv:tmdb:9243";
        var series = Guid.NewGuid();
        using var rig = await Started(r =>
        {
            r.Sonarr.Series.Add(FakeArr.SeriesRow(10, 4243, "Alias Show", tmdb: 9243));
            r.Request(1, 9243, r.Emma, type: "tv");
            r.View.AddCopy(TitleKey.Parse(tvdb)!, new JfCopy { ItemId = series, Path = "/tv/Alias Show", DateCreated = r.Arr.Now.UtcDateTime.AddDays(-30) });
            r.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = r.Arr.Now.UtcDateTime.AddDays(-30) });
        });
        rig.Phones(rig.Emma);
        rig.Prefs(rig.Emma, p => p.Declined = false);
        if (decline) Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(tvdb)!, true, default));
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(tvdb, tmdb);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        // A concurrent arrival must join the open batch, rather than become a new first-look baseline.
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 3, DateCreated = rig.Arr.Now.UtcDateTime });
        if (decline)
        {
            // The TMDB request ends, but the TVDB follow is still an interest in this title.
            rig.Seerr.Requests[0]["status"] = 3;
            rig.Seerr.Requests[0]["updatedAt"] = rig.Arr.Now.UtcDateTime.ToString("o");
        }
        else
        {
            // A request under TVDB is additional to the already-known active TMDB request.
            rig.Request(2, 9243, rig.Emma, type: "tv", tvdb: 4243, created: rig.Arr.Now.UtcDateTime);
        }
        await rig.Step(tmdb, tvdb);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(10);
        await rig.Step(tvdb, tmdb);
        var told = Assert.Single(rig.Inbox(rig.Emma));
        Assert.Equal(("episodes", "many", "2", series.ToString("N")), (told.Kind, Params(told.Payload)["mode"], Params(told.Payload)["count"], told.ItemId));
        Assert.Single(rig.Pushes);
        Assert.Single(rig.Mail.Sent);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AQueuedReadyWithoutAnItemIdRechecksVisibilityThroughTheSharedAliases(bool restricted)
    {
        const string imdb = "movie:imdb:tt693134";
        using var rig = await Started(r => r.Request(1, 693134, r.Emma));
        rig.Phones(rig.Emma);
        QuietAllDay(rig, rig.Emma);
        await rig.Step(Dune);
        rig.Arrive(imdb);
        await rig.Step(Dune);
        Assert.Single(rig.Inbox(rig.Emma));
        // Legacy queued notifications can carry the title key without a concrete item link.
        rig.Db.Write((c, t) =>
        {
            using var cmd = c.CreateCommand();
            cmd.Transaction = t;
            cmd.CommandText = "UPDATE notifications SET item_id=NULL WHERE kind='ready'";
            return cmd.ExecuteNonQuery();
        });
        if (restricted) rig.View.CopiesByKey[imdb][0] = (rig.View.CopiesByKey[imdb][0].Copy, new HashSet<Guid> { rig.Admin.UserId });
        QuietAllDay(rig, rig.Emma, on: false);
        rig.Arr.Now = rig.Arr.Now.AddDays(1);
        await rig.Dispatcher.RunOnceAsync(default);
        Assert.All(Deliveries(rig, rig.Emma), d => Assert.Equal((restricted ? "suppressed" : "sent", restricted ? 0 : 1), (d.Status, d.Attempts)));
        Assert.Equal(restricted ? 0 : 1, rig.Pushes.Count);
        Assert.Equal(restricted ? 0 : 1, rig.Mail.Sent.Count);
    }

    [Fact]
    public async Task TurningOffATitleThroughItsArrAliasMutesTheSeerrRequestUnderAnotherId()
    {
        const string tvdb = "tv:tvdb:4243";
        const string tmdb = "tv:tmdb:9243";
        var series = Guid.NewGuid();
        using var rig = await Started(r =>
        {
            r.Sonarr.Series.Add(FakeArr.SeriesRow(10, 4243, "Alias Show", tmdb: 9243));
            r.Request(1, 9243, r.Emma, type: "tv");
            r.View.AddCopy(TitleKey.Parse(tvdb)!, new JfCopy { ItemId = series, Path = "/tv/Alias Show", DateCreated = r.Arr.Now.UtcDateTime.AddDays(-30) });
        });
        rig.Phones(rig.Emma);
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(tvdb)!, false, default));
        Assert.True(Assert.Single(rig.NotifyStore.Follows(rig.Emma.UserId)).Muted);
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(tmdb, tvdb);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step(tvdb, tmdb);
        Assert.Empty(rig.Inbox(rig.Emma));
        Assert.Empty(rig.Pushes);
        Assert.Empty(rig.Mail.Sent);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AnImdbFollowAndATmdbRequestNothingTiesTogetherAreToldOnceInEitherOrderAndAcrossARestart(bool imdbFirst)
    {
        // 12 Angry Men: no arr holds it and Seerr's request names no IMDb id.
        const string tmdb = "movie:tmdb:389";
        const string imdb = "movie:imdb:tt0050083";
        using var rig = await Started(r => r.Request(40, 389, r.Emma));
        rig.Phones(rig.Emma);
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(imdb)!, true, default));
        var order = imdbFirst ? new[] { imdb, tmdb } : new[] { tmdb, imdb };
        await rig.Step(order);
        var item = Guid.NewGuid();
        foreach (var key in new[] { tmdb, imdb }) rig.View.AddCopy(TitleKey.Parse(key)!, new JfCopy { ItemId = item, Path = "/media/12 Angry Men", LibraryName = "Movies", DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.Rev++;
        await rig.Step(order);
        await rig.Step(order.Reverse().ToArray());
        rig.Open();
        await rig.Step(order);
        var told = Assert.Single(rig.Inbox(rig.Emma));
        Assert.Equal(("ready", item.ToString("N")), (told.Kind, told.ItemId));
        Assert.Single(rig.Pushes);
        Assert.Single(rig.Mail.Sent);
        // A new file of it (an upgrade, a new item id) tells nobody again.
        rig.View.CopiesByKey.Clear();
        await rig.Step(order);
        var upgrade = Guid.NewGuid();
        foreach (var key in new[] { tmdb, imdb }) rig.View.AddCopy(TitleKey.Parse(key)!, new JfCopy { ItemId = upgrade, Path = "/media/12 Angry Men 2160p", LibraryName = "Movies", DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.Rev++;
        await rig.Step(order);
        Assert.Single(rig.Inbox(rig.Emma));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ASeriesFollowedUnderTwoIdsNothingTiesTogetherIsOneBatchAndASecondRealBatchStillGoes(bool tvdbFirst)
    {
        // No Sonarr holds it, no Seerr request names it: two follows, one Jellyfin series.
        const string tvdb = "tv:tvdb:4243";
        const string tmdb = "tv:tmdb:9243";
        using var rig = await Started();
        rig.Phones(rig.Emma);
        var series = Guid.NewGuid();
        foreach (var key in new[] { tvdb, tmdb }) rig.View.AddCopy(TitleKey.Parse(key)!, new JfCopy { ItemId = series, Path = "/tv/Unknown Show", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(tvdb)!, true, default));
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(tmdb)!, true, default));
        var order = tvdbFirst ? new[] { tvdb, tmdb } : new[] { tmdb, tvdb };
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 3, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(order);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step(order);
        var batch = Assert.Single(rig.Inbox(rig.Emma));
        Assert.Equal(("episodes", "many", "2"), (batch.Kind, Params(batch.Payload)["mode"], Params(batch.Payload)["count"]));
        Assert.Single(rig.Pushes);
        // The next episode is another batch (once again).
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 4, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(order.Reverse().ToArray());
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step(order);
        Assert.Equal(2, rig.Inbox(rig.Emma).Count);
        Assert.Equal(("single", "4"), (Params(rig.Inbox(rig.Emma)[0].Payload)["mode"], Params(rig.Inbox(rig.Emma)[0].Payload)["episode"]));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ASeasonFollowAndASeriesFollowUnderIdsNothingTiesTogetherShareOneBatchInEitherOrder(bool tvdbFirst)
    {
        // Season 1 followed from the details page (TVDB), the whole series from Seerr's modal (TMDB):
        // no Sonarr, no Seerr request ties the ids together, one Jellyfin series has both.
        const string tvdb = "tv:tvdb:4243";
        const string tmdb = "tv:tmdb:9243";
        using var rig = await Started();
        rig.Phones(rig.Emma);
        var series = Guid.NewGuid();
        foreach (var key in new[] { tvdb, tmdb }) rig.View.AddCopy(TitleKey.Parse(key)!, new JfCopy { ItemId = series, Path = "/tv/Unknown Show", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(tvdb + ":s1")!, true, default));
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(tmdb)!, true, default));
        var order = tvdbFirst ? new[] { tvdb, tmdb } : new[] { tmdb, tvdb };
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 5, DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(order);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step(order);
        var batch = Assert.Single(rig.Inbox(rig.Emma));
        Assert.Equal(("episodes", "many", "2", "1, 2"), (batch.Kind, Params(batch.Payload)["mode"], Params(batch.Payload)["count"], Params(batch.Payload)["seasons"]));
        Assert.Equal(series.ToString("N"), batch.ItemId);
        Assert.Single(rig.Pushes);
        // The next window is its own batch, again one.
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 6, DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(order.Reverse().ToArray());
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step(order);
        Assert.Equal(2, rig.Inbox(rig.Emma).Count);
        Assert.Equal(2, rig.Pushes.Count);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ASeriesSeenAsTwoCopiesUnderOneIdAndOneCopyUnderTheOtherIsOneBatchInEitherOrder(bool tvdbFirst)
    {
        // Two Jellyfin series items: A has only the TVDB id (listed first), B has both. The new episodes
        // are in B: the batch is B's whichever id is looked at first (not the first copy the TVDB id lists).
        const string tvdb = "tv:tvdb:4244";
        const string tmdb = "tv:tmdb:9244";
        using var rig = await Started();
        rig.Phones(rig.Emma);
        var a = Guid.NewGuid();
        var b = Guid.NewGuid();
        rig.View.AddCopy(TitleKey.Parse(tvdb)!, new JfCopy { ItemId = a, Path = "/tv/Unknown Show A", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        foreach (var key in new[] { tvdb, tmdb }) rig.View.AddCopy(TitleKey.Parse(key)!, new JfCopy { ItemId = b, Path = "/tv/Unknown Show B", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        foreach (var series in new[] { a, b }) rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(tvdb + ":s1")!, true, default));
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(tmdb)!, true, default));
        var order = tvdbFirst ? new[] { tvdb, tmdb } : new[] { tmdb, tvdb };
        await rig.Step(order);
        rig.View.AddEpisode(b, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 5, DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.AddEpisode(b, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(order);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step(order);
        var batch = Assert.Single(rig.Inbox(rig.Emma));
        Assert.Equal(("episodes", "many", "2", "1, 2"), (batch.Kind, Params(batch.Payload)["mode"], Params(batch.Payload)["count"], Params(batch.Payload)["seasons"]));
        Assert.Equal(b.ToString("N"), batch.ItemId);
        Assert.Single(rig.Pushes);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AnEpisodeOnlyTheJoiningIdSeesIsStillToldWithTheBatchItJoined(bool tvdbFirst)
    {
        // The TMDB id sees only B, the TVDB id sees A and B. A batch opened through the TMDB id (for B) and
        // joined through the TVDB id with an episode only A has still tells that episode when it is sent.
        const string tvdb = "tv:tvdb:4245";
        const string tmdb = "tv:tmdb:9245";
        using var rig = await Started();
        rig.Phones(rig.Emma);
        var a = Guid.NewGuid();
        var b = Guid.NewGuid();
        rig.View.AddCopy(TitleKey.Parse(tvdb)!, new JfCopy { ItemId = a, Path = "/tv/Unknown Show A", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        foreach (var key in new[] { tvdb, tmdb }) rig.View.AddCopy(TitleKey.Parse(key)!, new JfCopy { ItemId = b, Path = "/tv/Unknown Show B", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        foreach (var series in new[] { a, b }) rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(tvdb + ":s1")!, true, default));
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(tmdb)!, true, default));
        var order = tvdbFirst ? new[] { tvdb, tmdb } : new[] { tmdb, tvdb };
        await rig.Step(order);
        rig.View.AddEpisode(a, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 6, DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.AddEpisode(b, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(order);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step(order);
        var batch = Assert.Single(rig.Inbox(rig.Emma));
        Assert.Equal(("episodes", "2", "1, 2"), (batch.Kind, Params(batch.Payload)["count"], Params(batch.Payload)["seasons"]));
        Assert.Single(rig.Pushes);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task TwoOpenBatchesThatTurnOutToBeOneSeriesMidWindowAreSentAsOne(bool linkThroughTmdb)
    {
        const string tvdb = "tv:tvdb:4246";
        const string tmdb = "tv:tmdb:9246";
        using var rig = await Started();
        rig.Phones(rig.Emma);
        var a = new JfCopy { ItemId = Guid.NewGuid(), Path = "/tv/Unknown Show A", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) };
        var b = new JfCopy { ItemId = Guid.NewGuid(), Path = "/tv/Unknown Show B", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) };
        rig.View.AddCopy(TitleKey.Parse(tvdb)!, a);
        rig.View.AddCopy(TitleKey.Parse(tmdb)!, b);
        rig.View.AddEpisode(a.ItemId, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        rig.View.AddEpisode(b.ItemId, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(tvdb + ":s1")!, true, default));
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(tmdb + ":s2")!, true, default));
        await rig.Step(tvdb, tmdb);
        rig.View.AddEpisode(a.ItemId, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.AddEpisode(b.ItemId, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(tvdb, tmdb);
        Assert.Equal(2, Rows(rig, "batches"));
        rig.Arr.Now = rig.Arr.Now.AddMinutes(2);
        rig.View.AddCopy(TitleKey.Parse(linkThroughTmdb ? tmdb : tvdb)!, linkThroughTmdb ? a : b);
        rig.View.AddEpisode(linkThroughTmdb ? b.ItemId : a.ItemId, new JfEpisode { ItemId = Guid.NewGuid(), Season = linkThroughTmdb ? 2 : 1, Episode = 3, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(tvdb, tmdb);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(9);
        await rig.Step(tvdb, tmdb);
        var batch = Assert.Single(rig.Inbox(rig.Emma));
        Assert.Equal(("episodes", "3", "1, 2"), (batch.Kind, Params(batch.Payload)["count"], Params(batch.Payload)["seasons"]));
        Assert.Single(rig.Pushes);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step(tvdb, tmdb);
        Assert.Single(rig.Inbox(rig.Emma));
        Assert.Single(rig.Pushes);
    }

    [Fact]
    public async Task AnEpisodeOfAMergedBatchOnlyItsOwnIdSeesIsStillTold()
    {
        // The TVDB id sees A and C, the TMDB id sees B. S1E2 is only in C. A gains the TMDB id mid-window:
        // the TVDB batch is merged into the TMDB one, whose id doesn't see C; S1E2 is still told.
        const string tvdb = "tv:tvdb:4248";
        const string tmdb = "tv:tmdb:9248";
        using var rig = await Started();
        rig.Phones(rig.Emma);
        var a = new JfCopy { ItemId = Guid.NewGuid(), Path = "/tv/Unknown Show A", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) };
        var b = new JfCopy { ItemId = Guid.NewGuid(), Path = "/tv/Unknown Show B", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) };
        var c = new JfCopy { ItemId = Guid.NewGuid(), Path = "/tv/Unknown Show C", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) };
        rig.View.AddCopy(TitleKey.Parse(tvdb)!, a);
        rig.View.AddCopy(TitleKey.Parse(tvdb)!, c);
        rig.View.AddCopy(TitleKey.Parse(tmdb)!, b);
        foreach (var series in new[] { a, c }) rig.View.AddEpisode(series.ItemId, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        rig.View.AddEpisode(b.ItemId, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(tvdb + ":s1")!, true, default));
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(tmdb + ":s2")!, true, default));
        await rig.Step(tvdb, tmdb);
        rig.View.AddEpisode(c.ItemId, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.AddEpisode(b.ItemId, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(tvdb, tmdb);
        Assert.Equal(2, Rows(rig, "batches"));
        rig.Arr.Now = rig.Arr.Now.AddMinutes(2);
        rig.View.AddCopy(TitleKey.Parse(tmdb)!, a);
        rig.View.AddEpisode(b.ItemId, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 3, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(tvdb, tmdb);
        Assert.Equal(1, Rows(rig, "batches"));
        rig.Arr.Now = rig.Arr.Now.AddMinutes(9);
        await rig.Step(tvdb, tmdb);
        var batch = Assert.Single(rig.Inbox(rig.Emma));
        Assert.Equal(("episodes", "3", "1, 2"), (batch.Kind, Params(batch.Payload)["count"], Params(batch.Payload)["seasons"]));
        Assert.Single(rig.Pushes);
    }

    [Fact]
    public async Task MergedBatchesKeepTheEarliestWindow()
    {
        const string tvdb = "tv:tvdb:4247";
        const string tmdb = "tv:tmdb:9247";
        using var rig = await Started();
        rig.Phones(rig.Emma);
        var a = new JfCopy { ItemId = Guid.NewGuid(), Path = "/tv/Unknown Show A", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) };
        var b = new JfCopy { ItemId = Guid.NewGuid(), Path = "/tv/Unknown Show B", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) };
        rig.View.AddCopy(TitleKey.Parse(tvdb)!, a);
        rig.View.AddCopy(TitleKey.Parse(tmdb)!, b);
        rig.View.AddEpisode(a.ItemId, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        rig.View.AddEpisode(b.ItemId, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(tvdb + ":s1")!, true, default));
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(tmdb + ":s2")!, true, default));
        await rig.Step(tvdb, tmdb);
        var first = rig.Arr.Now;
        rig.View.AddEpisode(a.ItemId, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(tvdb, tmdb);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(5);
        rig.View.AddEpisode(b.ItemId, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(tvdb, tmdb);
        Assert.Equal(2, Rows(rig, "batches"));
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        rig.View.AddCopy(TitleKey.Parse(tmdb)!, a);
        rig.View.AddEpisode(b.ItemId, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 3, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(tvdb, tmdb);
        var merged = rig.NotifyStore.Batch(rig.Emma.UserId, tmdb)!.Value;
        Assert.Equal((first, first.AddMinutes(10)), (merged.FirstAt, merged.DueAt));
        rig.Arr.Now = first.AddMinutes(9);
        await rig.Step(tvdb, tmdb);
        Assert.Empty(rig.Inbox(rig.Emma));
        rig.Arr.Now = first.AddMinutes(10);
        await rig.Step(tvdb, tmdb);
        var batch = Assert.Single(rig.Inbox(rig.Emma));
        Assert.Equal(("episodes", "3", "1, 2"), (batch.Kind, Params(batch.Payload)["count"], Params(batch.Payload)["seasons"]));
        Assert.Single(rig.Pushes);
        rig.Arr.Now = first.AddMinutes(16);
        await rig.Step(tvdb, tmdb);
        Assert.Single(rig.Inbox(rig.Emma));
        Assert.Single(rig.Pushes);
    }

    [Fact]
    public async Task ASeriesAskedForAgainAfterItWasRemovedIsToldAgainWhenItsEpisodesComeBack()
    {
        const string show = "tv:tvdb:4243";
        using var rig = await Started(r => r.Request(1, 9243, r.Emma, type: "tv", tvdb: 4243));
        var series = Guid.NewGuid();
        var e1 = Guid.NewGuid();
        rig.View.AddCopy(TitleKey.Parse(show)!, new JfCopy { ItemId = series, Path = "/tv/Unknown Show", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        await rig.Step(show);
        rig.View.AddEpisode(series, new JfEpisode { ItemId = e1, Season = 1, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(show);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step(show);
        Assert.Single(rig.Inbox(rig.Emma), n => n.Kind == "episodes");
        // The series is deleted from Jellyfin, then Seerr clears the request.
        rig.Arr.Now = rig.Arr.Now.AddDays(60);
        rig.View.CopiesByKey.Clear();
        rig.View.EpisodesBySeries.Clear();
        rig.View.Rev++;
        await rig.Step(show);
        rig.Seerr.Requests.Clear();
        await rig.Step(show);
        // Asked for again; it comes back at the same path (the same item ids).
        rig.Seerr.Requests.Add(FakeSeerr.Request(2, "tv", 9243, 2, rig.Emma.UserId, rig.Arr.Now.UtcDateTime, tvdb: 4243, userName: "Emma"));
        await rig.Step(show);
        rig.View.AddCopy(TitleKey.Parse(show)!, new JfCopy { ItemId = series, Path = "/tv/Unknown Show", DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.AddEpisode(series, new JfEpisode { ItemId = e1, Season = 1, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.Rev++;
        await rig.Step(show);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step(show);
        Assert.Equal(2, rig.Inbox(rig.Emma).Count(n => n.Kind == "episodes"));
    }

    // ------------------------------------------------------------------ C80: all or nothing

    [Fact]
    public async Task ADatabaseFaultRollsTheReadyTransitionBackAndAfterARestartItIsToldOnce()
    {
        using var rig = await Started(r => r.Request(1, 693134, r.Emma));
        rig.Phones(rig.Emma);
        await rig.Step(Dune);
        var before = rig.NotifyStore.Watch(rig.Emma.UserId, Dune, "m");
        FailInserts(rig, "deliveries", on: true);
        rig.Arrive(Dune);
        await rig.Step(Dune);
        // Nothing of it was written: no inbox row, no "handled" marks, the watch still at its old stage.
        Assert.Empty(rig.Inbox(rig.Emma));
        Assert.Null(rig.NotifyStore.MarkAt(rig.Emma.UserId, "ready|" + Dune + "|m"));
        Assert.Equal(before?.Stage, rig.NotifyStore.Watch(rig.Emma.UserId, Dune, "m")?.Stage);
        FailInserts(rig, "deliveries", on: false);
        rig.Open();
        await rig.Step(Dune);
        await rig.Step(Dune);
        Assert.Equal("ready", Assert.Single(rig.Inbox(rig.Emma)).Kind);
        Assert.Single(rig.Pushes);
        Assert.Single(rig.Mail.Sent);
    }

    [Fact]
    public async Task ADatabaseFaultRollsNewEpisodesAndTheirBatchBackAndTheyAreToldOnceAfterARestart()
    {
        const string show = "tv:tvdb:4243";
        using var rig = await Started();
        var series = Guid.NewGuid();
        rig.View.AddCopy(TitleKey.Parse(show)!, new JfCopy { ItemId = series, Path = "/tv/Unknown Show", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(show)!, true, default));
        // The episodes' marks, the known set and the batch: none of them survives a failed batch write.
        FailInserts(rig, "batches", on: true);
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(show);
        Assert.Equal("1:1", rig.NotifyStore.Watch(rig.Emma.UserId, show, "eps")!.Value.Known);
        Assert.Null(rig.NotifyStore.MarkAt(rig.Emma.UserId, "ep|" + show + ":s1:e2"));
        FailInserts(rig, "batches", on: false);
        rig.Open();
        await rig.Step(show);
        // The batch's notification can't be written when its window closes: the batch stays.
        FailInserts(rig, "notifications", on: true);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step();
        Assert.Empty(rig.Inbox(rig.Emma));
        Assert.NotNull(rig.NotifyStore.Batch(rig.Emma.UserId, show));
        FailInserts(rig, "notifications", on: false);
        rig.Open();
        rig.Arr.Now = rig.Arr.Now.AddMinutes(2);
        await rig.Step();
        await rig.Step(show);
        Assert.Equal(("episodes", "single", "2"), (Assert.Single(rig.Inbox(rig.Emma)).Kind, Params(rig.Inbox(rig.Emma)[0].Payload)["mode"], Params(rig.Inbox(rig.Emma)[0].Payload)["episode"]));
        Assert.Null(rig.NotifyStore.Batch(rig.Emma.UserId, show));
    }

    [Fact]
    public async Task ABatchThatKeepsFailingIsDroppedAfterItsTriesWithoutHoldingUpAnother()
    {
        const string bad = "tv:tvdb:4243";
        const string good = "tv:tvdb:4244";
        using var rig = await Started();
        var badSeries = Guid.NewGuid();
        var goodSeries = Guid.NewGuid();
        foreach (var (key, series) in new[] { (bad, badSeries), (good, goodSeries) })
        {
            rig.View.AddCopy(TitleKey.Parse(key)!, new JfCopy { ItemId = series, Path = "/tv/" + key, DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
            rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
            Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(key)!, true, default));
            rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        }
        await rig.Step(bad, good);
        Assert.NotNull(rig.NotifyStore.Batch(rig.Emma.UserId, bad));
        // From now on one series can't be read: its batch fails every time its turn comes.
        rig.View.FailEpisodesOf = badSeries;
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step();
        Assert.Equal(TitleKey.Parse(good)!.ToString(), Assert.Single(rig.Inbox(rig.Emma)).Key);
        for (var i = 1; i < NotificationService.MaxBatchTries; i++)
        {
            Assert.NotNull(rig.NotifyStore.Batch(rig.Emma.UserId, bad));
            rig.Arr.Now = rig.Arr.Now.AddSeconds(61);
            await rig.Step();
        }
        Assert.Null(rig.NotifyStore.Batch(rig.Emma.UserId, bad));
        Assert.Single(rig.Inbox(rig.Emma));
    }

    // ------------------------------------------------------------------ C33 / C39: the Seerr server's identity

    [Fact]
    public async Task AnotherSeerrServerIsRecordedAfreshTellingNobodyAndOnlyItsNewRequestsAreNews()
    {
        using var rig = await Started(r =>
        {
            r.Request(7, 4242, r.Emma, status: 1);
            r.Request(8, 693134, r.Emma, status: 2);
        });
        rig.Phones(rig.Admin, rig.Emma);
        // On server A: request 11 waits for an OK (the administrator hears about it).
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        rig.Seerr.Requests.Add(FakeSeerr.Request(11, "movie", 5151, 1, rig.Sam.UserId, rig.Arr.Now.UtcDateTime, userName: "Sam"));
        await rig.Step();
        Assert.Single(rig.Inbox(rig.Admin), n => n.Kind == "approval");
        var oldSource = rig.Requests.Source;

        // Seerr B replaces A. Its request ids are other requests: 7 is someone's declined one, 9 was
        // made yesterday (after A's baseline) and waits for an OK.
        rig.Config.JellyseerrUrls = "http://seerr-b.lan:5055";
        rig.Seerr.Requests.Clear();
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        rig.Seerr.Requests.Add(FakeSeerr.Request(7, "movie", 6161, 3, rig.Emma.UserId, rig.Arr.Now.UtcDateTime.AddHours(-2), rig.Arr.Now.UtcDateTime.AddHours(-1), userName: "Emma"));
        rig.Seerr.Requests.Add(FakeSeerr.Request(9, "movie", 7171, 1, rig.Sam.UserId, rig.Arr.Now.UtcDateTime.AddMinutes(-30), userName: "Sam"));
        await rig.Step();
        await rig.Step();
        Assert.NotEqual(oldSource, rig.Requests.Source);
        Assert.DoesNotContain(rig.Inbox(rig.Emma), n => n.Kind == "declined");
        Assert.Single(rig.Inbox(rig.Admin), n => n.Kind == "approval");
        Assert.Equal(rig.Requests.Source, rig.NotifyStore.Meta(NotifyStore.SeerrSourceKey));

        // B's own new request 11 (A's 11 was told already) still reaches the administrator.
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        rig.Seerr.Requests.Add(FakeSeerr.Request(11, "movie", 8181, 1, rig.Emma.UserId, rig.Arr.Now.UtcDateTime, userName: "Emma"));
        await rig.Step();
        Assert.Equal(2, rig.Inbox(rig.Admin).Count(n => n.Kind == "approval"));
        Assert.Equal("Emma", Params(rig.Inbox(rig.Admin).First(n => n.Kind == "approval").Payload)["user"]);
        // And a decline on B is told.
        rig.Seerr.Requests.RemoveAll(r => (int)r["id"]! == 11);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        rig.Seerr.Requests.Add(FakeSeerr.Request(11, "movie", 8181, 3, rig.Emma.UserId, rig.Arr.Now.UtcDateTime.AddMinutes(-1), rig.Arr.Now.UtcDateTime, userName: "Emma"));
        await rig.Step();
        Assert.Single(rig.Inbox(rig.Emma), n => n.Kind == "declined");

        // A restart keeps B as the server seen: nothing is recorded afresh, nothing told twice.
        var baseline = rig.NotifyStore.Meta("seerr_baseline");
        rig.Open();
        await rig.Step();
        Assert.Equal(baseline, rig.NotifyStore.Meta("seerr_baseline"));
        Assert.Single(rig.Inbox(rig.Emma), n => n.Kind == "declined");
    }

    [Fact]
    public async Task TheSameSeerrListedInAnotherOrderIsNotAnotherServerAndNothingIsRecordedAfreshUntilANewOneLoads()
    {
        using var rig = await Started(r => r.Request(7, 4242, r.Emma, status: 1));
        var source = rig.Requests.Source;
        var baseline = rig.NotifyStore.Meta("seerr_baseline");
        // Two addresses of the same server, in either order, with a trailing slash: the same Seerr.
        rig.Config.JellyseerrUrls = FakeSeerr.Url + "\nhttp://seerr-alias.lan:5055";
        await rig.Step();
        var both = rig.Requests.Source;
        rig.Config.JellyseerrUrls = "http://SEERR-ALIAS.lan:5055/\n" + FakeSeerr.Url + "/";
        var revision = rig.Requests.Revision;
        await rig.Step();
        Assert.Equal(both, rig.Requests.Source);
        Assert.Equal(revision, rig.Requests.Revision);
        Assert.NotEqual(source, both);
        // Another server that doesn't answer yet: the old list is forgotten, but nothing is recorded
        // afresh until the new one has been read.
        var seen = rig.NotifyStore.Meta(NotifyStore.SeerrSourceKey);
        rig.Config.JellyseerrUrls = "http://seerr-c.lan:5055";
        rig.Seerr.FailWith = 503;
        await rig.Step();
        Assert.False(rig.Requests.Loaded);
        Assert.Empty(rig.Requests.All);
        Assert.Equal(seen, rig.NotifyStore.Meta(NotifyStore.SeerrSourceKey));
        Assert.Equal(baseline != null, rig.NotifyStore.Meta("seerr_baseline") != null);
        rig.Seerr.FailWith = 0;
        await rig.Step();
        Assert.True(rig.Requests.Loaded);
        Assert.NotEqual(seen, rig.NotifyStore.Meta(NotifyStore.SeerrSourceKey));
        Assert.Empty(rig.Inbox(rig.Admin));
    }

    [Fact]
    public async Task ASeerrListAnnouncedBeforeItCouldBeReadIsComparedOnceItIsEvenWhenItIsEmpty()
    {
        using var rig = await Started(r => r.Request(7, 4242, r.Emma, status: 1));
        rig.Phones(rig.Admin);
        // Another server that can't be read yet: A's list goes (announced), nothing to compare.
        rig.Config.JellyseerrUrls = "http://seerr-b.lan:5055";
        rig.Seerr.FailWith = 503;
        await rig.Step();
        // B answers with an empty list: nothing changed on the feed, but it is B's list now.
        rig.Seerr.Requests.Clear();
        rig.Seerr.FailWith = 0;
        await rig.Step();
        Assert.Equal(rig.Requests.Source, rig.NotifyStore.Meta(NotifyStore.SeerrSourceKey));
        // Its first request is news for the administrator.
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        rig.Seerr.Requests.Add(FakeSeerr.Request(1, "movie", 5151, 1, rig.Emma.UserId, rig.Arr.Now.UtcDateTime, userName: "Emma"));
        await rig.Step();
        Assert.Single(rig.Inbox(rig.Admin), n => n.Kind == "approval");
    }

    [Fact]
    public async Task AnEmptySeerrReplacedByAnotherEmptyOneIsNotedAndItsFirstRequestIsNews()
    {
        // A, with no requests, is baselined; then JE is pointed at B, empty too.
        using var rig = await Started();
        rig.Phones(rig.Admin);
        var a = rig.Requests.Source;
        Assert.Equal(a, rig.NotifyStore.Meta(NotifyStore.SeerrSourceKey));
        rig.Config.JellyseerrUrls = "http://seerr-b.lan:5055";
        await rig.Step();
        Assert.NotEqual(a, rig.Requests.Source);
        Assert.Equal(rig.Requests.Source, rig.NotifyStore.Meta(NotifyStore.SeerrSourceKey));
        // B's first request waits for an OK: the administrator hears about it.
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        rig.Seerr.Requests.Add(FakeSeerr.Request(1, "movie", 5151, 1, rig.Emma.UserId, rig.Arr.Now.UtcDateTime, userName: "Emma"));
        await rig.Step();
        Assert.Single(rig.Inbox(rig.Admin), n => n.Kind == "approval");
    }

    [Fact]
    public async Task SeerrRequestsNoLongerHeldBelowTheReadWindowAreForgottenAndAreNotNewsWhenSeenAgain()
    {
        // Seerr holds as many requests as are read (nobody's: no interest to look at); all are seen.
        const int max = SeerrRequestReadModel.MaxRequests;
        using var rig = await Started(r =>
        {
            for (var i = 1; i <= max; i++) r.Seerr.Requests.Add(FakeSeerr.Request(i, "movie", 100_000 + i, 2, null, new DateTime(2026, 10, 1, 9, 0, 0, DateTimeKind.Utc).AddMinutes(i)));
        });
        rig.Phones(rig.Admin, rig.Emma);
        rig.Requests.HeldBelowWindow = 10;
        Assert.Equal(max, rig.NotifyStore.SeerrSeen().Count);
        Assert.Null(rig.NotifyStore.Meta(NotifyStore.SeerrForgottenBelowKey));
        // 25 more: the window moves past 1..25, of which only 16..25 are still held. 1..15 still exist
        // in Seerr but can't be compared again while it holds this many: what was seen of them is
        // forgotten (the table stays the size of the list held), and nothing is taken for gone.
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        for (var i = max + 1; i <= max + 25; i++) rig.Seerr.Requests.Add(FakeSeerr.Request(i, "movie", 100_000 + i, 2, null, rig.Arr.Now.UtcDateTime));
        await rig.Step();
        Assert.Equal(16, rig.Requests.Current.Floor);
        var seen = rig.NotifyStore.SeerrSeen();
        Assert.Equal(max + 10, seen.Count);
        Assert.False(seen.ContainsKey(15));
        Assert.True(seen.ContainsKey(16));
        Assert.Equal("16", rig.NotifyStore.Meta(NotifyStore.SeerrForgottenBelowKey));
        // One really removed above the floor is gone; two more move the window and the floor up by
        // one, and 16 is forgotten too.
        rig.Seerr.Requests.RemoveAll(r => (int)r["id"]! == 500);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        for (var i = max + 26; i <= max + 27; i++) rig.Seerr.Requests.Add(FakeSeerr.Request(i, "movie", 100_000 + i, 2, null, rig.Arr.Now.UtcDateTime));
        await rig.Step();
        Assert.Equal(17, rig.Requests.Current.Floor);
        seen = rig.NotifyStore.SeerrSeen();
        Assert.False(seen.ContainsKey(500));
        Assert.False(seen.ContainsKey(16));
        Assert.True(seen.ContainsKey(17));
        Assert.Equal(max + 10, seen.Count);
        Assert.Equal("17", rig.NotifyStore.Meta(NotifyStore.SeerrForgottenBelowKey));

        // Seerr shrinks below the cap: the forgotten ones are listed again, unknown. Even made after
        // the baseline (one waiting for an OK, one declined) they are old, not news.
        rig.Seerr.Requests.RemoveAll(r => (int)r["id"]! > 100);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        rig.Seerr.Requests.RemoveAll(r => (int)r["id"]! is 3 or 4);
        rig.Seerr.Requests.Add(FakeSeerr.Request(3, "movie", 5151, 1, rig.Sam.UserId, rig.Arr.Now.UtcDateTime.AddMinutes(-1), userName: "Sam"));
        rig.Seerr.Requests.Add(FakeSeerr.Request(4, "movie", 6161, 3, rig.Emma.UserId, rig.Arr.Now.UtcDateTime.AddMinutes(-1), rig.Arr.Now.UtcDateTime, userName: "Emma"));
        await rig.Step();
        Assert.Null(rig.Requests.Current.Floor);
        Assert.Equal(100, rig.NotifyStore.SeerrSeen().Count);
        Assert.Empty(rig.Inbox(rig.Admin));
        Assert.Empty(rig.Inbox(rig.Emma));
        // Recorded now: a later change of one of them is news as usual.
        rig.Seerr.Requests.RemoveAll(r => (int)r["id"]! == 3);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        rig.Seerr.Requests.Add(FakeSeerr.Request(3, "movie", 5151, 3, rig.Sam.UserId, rig.Arr.Now.UtcDateTime.AddMinutes(-2), rig.Arr.Now.UtcDateTime, userName: "Sam"));
        rig.Phones(rig.Sam);
        await rig.Step();
        Assert.Single(rig.Inbox(rig.Sam), n => n.Kind == "declined");
    }

    // ------------------------------------------------------------------ C77: an incomplete Seerr read changes nothing

    [Fact]
    public async Task AnIncompleteSeerrReadKeepsWhatWasSeenAndTheWatchesAndTheRequestIsNotNewAfterwards()
    {
        // 150 requests (two pages); Emma's request 50 for Dune sits right where a removal shifts the second page.
        using var rig = await Started(r =>
        {
            for (var i = 1; i <= 150; i++)
            {
                if (i == 50) r.Request(50, 693134, r.Emma);
                else r.Request(i, 10_000 + i, r.Sam, created: Asked.AddMinutes(-i));
            }
        });
        await rig.Step(Dune);
        Assert.NotNull(rig.NotifyStore.Watch(rig.Emma.UserId, Dune, "m"));
        Assert.True(rig.NotifyStore.SeerrSeen().ContainsKey(50));
        // Request 120 is removed while the pages are read (after the first page): Seerr's count
        // changes between pages and request 50 slides out of view.
        var removed = false;
        rig.Seerr.BeforePage = skip =>
        {
            if (skip != 100 || removed) return;
            removed = true;
            rig.Seerr.Requests.RemoveAll(r => (int)r["id"]! == 120);
        };
        rig.Seerr.Requests.First(r => (int)r["id"]! == 130)["updatedAt"] = rig.Arr.Now.UtcDateTime.ToString("o");
        await rig.Step(Dune);
        Assert.NotNull(rig.Requests.State.IncompleteReason);
        Assert.Null(rig.Requests.State.LastError);
        Assert.True(rig.NotifyStore.SeerrSeen().ContainsKey(50));
        Assert.Contains(rig.Requests.All, r => r.Id == 50);
        // The next read is complete: 120 is gone, 50 never was; Emma's watch is still there.
        rig.Seerr.BeforePage = null;
        await rig.Step(Dune);
        Assert.Null(rig.Requests.State.IncompleteReason);
        Assert.DoesNotContain(rig.Requests.All, r => r.Id == 120);
        Assert.True(rig.NotifyStore.SeerrSeen().ContainsKey(50));
        Assert.NotNull(rig.NotifyStore.Watch(rig.Emma.UserId, Dune, "m"));
        Assert.Empty(rig.Inbox(rig.Admin));
    }

    // ------------------------------------------------------------------ C46: stopping waits for the work in flight

    [Fact]
    public async Task StoppingWaitsForTheLookInProgressAndWritesNothingAfterwards()
    {
        const string show = "tv:tvdb:4243";
        using var rig = await Started();
        var series = Guid.NewGuid();
        rig.View.AddCopy(TitleKey.Parse(show)!, new JfCopy { ItemId = series, Path = "/tv/Unknown Show", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(show)!, true, default));
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Sam, TitleKey.Parse(show)!, true, default));
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        rig.View.OnEpisodes = () =>
        {
            entered.Set();
            release.Wait(TimeSpan.FromSeconds(20));
        };
        await rig.Service.StartAsync(default);
        rig.Service.Observe(new[] { show });
        rig.Arr.Now = rig.Arr.Now.AddSeconds(5);
        Assert.True(entered.Wait(TimeSpan.FromSeconds(10)));
        using var patience = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var stop = rig.Service.StopAsync(patience.Token);
        await Task.Delay(300);
        Assert.False(stop.IsCompleted);
        release.Set();
        await stop.WaitAsync(TimeSpan.FromSeconds(10));
        rig.View.OnEpisodes = null;
        var rows = Rows(rig, "marks") + Rows(rig, "watch") + Rows(rig, "batches") + Rows(rig, "notifications");
        await Task.Delay(300);
        Assert.Equal(rows, Rows(rig, "marks") + Rows(rig, "watch") + Rows(rig, "batches") + Rows(rig, "notifications"));
        // Only one of the two viewers was looked at: the look stopped between them.
        Assert.Single(new[] { rig.Emma, rig.Sam }, u => rig.NotifyStore.Batch(u.UserId, show) != null);
        rig.Service.Dispose();
        rig.Service.Dispose();
    }

    [Fact]
    public async Task StoppingReturnsWhenJellyfinStopsWaitingEvenIfALookIsStuck()
    {
        const string show = "tv:tvdb:4243";
        using var rig = await Started();
        var series = Guid.NewGuid();
        rig.View.AddCopy(TitleKey.Parse(show)!, new JfCopy { ItemId = series, Path = "/tv/Unknown Show", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(show)!, true, default));
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        rig.View.OnEpisodes = () =>
        {
            entered.Set();
            release.Wait(TimeSpan.FromSeconds(20));
        };
        await rig.Service.StartAsync(default);
        rig.Service.Observe(new[] { show });
        rig.Arr.Now = rig.Arr.Now.AddSeconds(5);
        Assert.True(entered.Wait(TimeSpan.FromSeconds(10)));
        using var patience = new CancellationTokenSource(TimeSpan.FromMilliseconds(200));
        await rig.Service.StopAsync(patience.Token).WaitAsync(TimeSpan.FromSeconds(5));
        release.Set();
        rig.View.OnEpisodes = null;
        await rig.Service.StopAsync(default).WaitAsync(TimeSpan.FromSeconds(10));
    }

    [Fact]
    public async Task StoppingTheDispatcherWaitsForTheSendInProgressAndStartsNoOther()
    {
        using var rig = await Started(r =>
        {
            r.Request(1, 693134, r.Emma);
            r.Request(2, 693134, r.Sam);
        });
        rig.Prefs(rig.Emma, p => { p.Ntfy = true; p.NtfyTopic = "je-topic-emma1"; });
        rig.Prefs(rig.Sam, p => { p.Ntfy = true; p.NtfyTopic = "je-topic-sam12"; });
        await rig.Step(Dune);
        rig.Arrive(Dune);
        await rig.Requests.RefreshAsync(default);
        await rig.Service.TickAsync(default);
        await rig.Service.EvaluateAsync(new[] { Dune }, null, default);
        Assert.Equal(2, rig.NotifyStore.DeliveryStats(rig.Arr.Now).Pending);
        var entered = new TaskCompletionSource();
        var release = new TaskCompletionSource();
        rig.OnPush = async () =>
        {
            entered.TrySetResult();
            await release.Task;
        };
        await rig.Dispatcher.StartAsync(default);
        rig.Dispatcher.Wake();
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        using var patience = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var stop = rig.Dispatcher.StopAsync(patience.Token);
        await Task.Delay(300);
        Assert.False(stop.IsCompleted);
        release.SetResult();
        await stop.WaitAsync(TimeSpan.FromSeconds(10));
        await Task.Delay(200);
        // The send in progress either finished or was cancelled with the stop (then it is tried again
        // after the restart); no other one was started.
        Assert.Equal(1, rig.Ntfy.Calls);
        Assert.True(rig.Pushes.Count <= 1);
        var all = Deliveries(rig, rig.Emma).Concat(Deliveries(rig, rig.Sam)).ToList();
        Assert.Equal(2, all.Count);
        Assert.DoesNotContain(all, d => d.Status == "failed" || d.Attempts > 1);
        Assert.Contains(all, d => d.Status == "pending" && d.Attempts == 0);
        Assert.Equal(rig.Pushes.Count, all.Count(d => d.Status == "sent"));
        rig.Dispatcher.Dispose();
        rig.Dispatcher.Dispose();
    }

    // ------------------------------------------------------------------ C104: arrivals keep the fresh entries

    [Fact]
    public async Task ASeerrOnlyTitlesUpdateStillCountsAsItsArrivalWhenTheTrackerIsFull()
    {
        // 12 Angry Men: only Seerr knows it (Emma asked); Jellyfin adds the item first and reads its ids later.
        using var rig = await Started(r => r.Request(40, 389, r.Emma));
        rig.Service.RebuildInterest();
        await rig.Service.TickAsync(default, force: true);
        // A big scan has added thousands of items; then the film; then the scan goes on.
        for (var i = 0; i < 4990; i++) rig.Service.ItemAdded(new Movie { Id = Guid.NewGuid() });
        rig.Arr.Now = rig.Arr.Now.AddSeconds(1);
        var movie = new Movie { Id = Guid.NewGuid() };
        rig.Service.ItemAdded(movie);
        rig.Arr.Now = rig.Arr.Now.AddSeconds(1);
        for (var i = 0; i < 1000; i++) rig.Service.ItemAdded(new Movie { Id = Guid.NewGuid() });
        Assert.True(rig.Service.RecentlyAdded.Count <= 5000);
        movie.SetProviderId(MetadataProvider.Tmdb, "389");
        Assert.False(rig.Service.HasDirty("movie:tmdb:389"));
        rig.Service.ItemUpdated(movie);
        Assert.True(rig.Service.HasDirty("movie:tmdb:389"));
        // Past the window it is no longer an arrival (and the sweep forgets it).
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        rig.Service.RecentlyAdded.Prune();
        Assert.False(rig.Service.RecentlyAdded.IsRecent(movie.Id));
    }
}
