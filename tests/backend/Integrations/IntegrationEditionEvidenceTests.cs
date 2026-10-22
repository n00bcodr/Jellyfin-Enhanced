using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using N = JE.Tests.IntegrationNotificationsTests;

namespace JE.Tests;

/// <summary>
/// Arrival evidence never becomes less informative, and an event commits with the evidence it consumes (D53, edition round 22).
/// A look that reads a file before Jellyfin has probed it ("-") keeps the last known quality of that same file, so HD, then
/// unprobed, then 4K is one 4K upgrade; and the source baseline an upgrade is judged against is written in the same
/// transaction as its notification (a movie) or its batch (episodes), so a failed write leaves the upgrade to announce once.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEditionEvidenceTests
{
    private static readonly TitleKey Series = TitleKey.Parse("tv:tvdb:371980")!;
    private static readonly TitleKey Movie = TitleKey.Parse("movie:tmdb:693134")!;

    private static async Task Observe(N.Rig r, TitleKey title)
    {
        await r.Step(title.ToString());
        r.Arr.Now = r.Arr.Now.AddMinutes(11);
        await r.Step();
    }

    private static JfSource Probed(JfSource s, int? w, int? h) => new() { SourceId = s.SourceId, ItemId = s.ItemId, BackingItemId = s.BackingItemId, Path = s.Path, DateCreated = s.DateCreated, Width = w, Height = h };

    /// <summary>An old HD copy (movie, or a 4K-requested series' S02E01) the interest has seen; returns the item whose source changes.</summary>
    internal static async Task<(N.Rig Rig, TitleKey Title, Guid Item, JfSource Before)> OldHd(bool movie)
    {
        var r = await N.Started(x =>
        {
            if (movie) x.Request(41, 693134, x.Emma, is4k: true);
            else
            {
                N.FourKSonarr(x);
                x.Request(30, 95396, x.Emma, type: "tv", tvdb: 371980, seasons: new[] { 2 }, is4k: true);
            }
        });
        var title = movie ? Movie : Series;
        var copy = Guid.NewGuid();
        var old = r.Arr.Now.UtcDateTime.AddDays(-30);
        r.View.AddCopy(title, new JfCopy { ItemId = copy, Path = movie ? "/media/movies/Dune/Dune.mkv" : "/media/tv/Severance", DateCreated = old });
        Guid item;
        if (movie) { item = copy; r.View.AddSource(item, 1920, 1080, "/media/movies/Dune/Dune.mkv", old); }
        else item = r.View.AddEpisodeFile(copy, title, 2, 1, 1920, 1080, old);
        var before = r.View.SourcesByItem[item].Single();
        await Observe(r, title);
        Assert.Empty(r.Inbox(r.Emma));
        return (r, title, item, before);
    }

    // Review r21 B2: the same file is first seen unprobed (no streams yet), then probed as 4K. Movie and episode; the cells
    // without the unprobed look are controls (a direct HD -> 4K upgrade is announced on base too).
    [Theory]
    [InlineData(true, false)]
    [InlineData(false, false)]
    [InlineData(true, true)]
    [InlineData(false, true)]
    public async Task AKnownHdToFourKUpgradeSurvivesAnUnprobedLookInBetween(bool movie, bool intermediate)
    {
        var (r, title, item, before) = await OldHd(movie);
        using var _ = r;
        if (intermediate)
        {
            r.View.SourcesByItem[item][0] = Probed(before, null, null);
            r.View.Rev++;
            await Observe(r, title);
            Assert.Empty(r.Inbox(r.Emma));
        }
        r.View.SourcesByItem[item][0] = Probed(before, 3840, 2160);
        r.View.Rev++;
        Assert.True(r.Status.Editions.Available(r.Emma, movie ? title : title.WithEpisode(2, 1), Edition.FourK));
        await Observe(r, title);
        await Observe(r, title);
        var notice = Assert.Single(r.Inbox(r.Emma));
        Assert.Equal("4k", JsonSerializer.Deserialize<Dictionary<string, string>>(notice.Payload)!["variant"]);
    }

    // Control: a file first seen unprobed and then probed as 4K was never known as anything else, so it proves no upgrade
    // (an old file isn't announced as new); and a quality that stays unknown stays silent.
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AnUnprobedFirstLookProvesNoUpgrade(bool movie)
    {
        var r = await N.Started(x =>
        {
            if (movie) x.Request(41, 693134, x.Emma, is4k: true);
            else
            {
                N.FourKSonarr(x);
                x.Request(30, 95396, x.Emma, type: "tv", tvdb: 371980, seasons: new[] { 2 }, is4k: true);
            }
        });
        using var _ = r;
        var title = movie ? Movie : Series;
        var copy = Guid.NewGuid();
        var old = r.Arr.Now.UtcDateTime.AddDays(-30);
        r.View.AddCopy(title, new JfCopy { ItemId = copy, Path = movie ? "/media/movies/Dune/Dune.mkv" : "/media/tv/Severance", DateCreated = old });
        var item = movie ? copy : r.View.AddEpisodeFile(copy, title, 2, 1, 1920, 1080, old);
        if (movie) r.View.AddSource(item, 1920, 1080, "/media/movies/Dune/Dune.mkv", old);
        var before = r.View.SourcesByItem[item].Single();
        r.View.SourcesByItem[item][0] = Probed(before, null, null);
        r.View.Rev++;
        await Observe(r, title);
        r.View.SourcesByItem[item][0] = Probed(before, 3840, 2160);
        r.View.Rev++;
        await Observe(r, title);
        await Observe(r, title);
        Assert.Empty(r.Inbox(r.Emma));
    }

    private static void Sql(N.Rig r, string sql) => r.Db.Write((c, t) => { using var cmd = c.CreateCommand(); cmd.Transaction = t; cmd.CommandText = sql; return cmd.ExecuteNonQuery(); });

    // Review r21 S5: the 4K upgrade's notification can't be written (the insert aborts). Nothing of the look may be kept: after
    // a restart the still-4K title is the same upgrade, announced once.
    [Fact]
    public async Task AFailedUpgradeNotificationRemainsAnUpgradeOnRetry()
    {
        const string name = "movie:tmdb:693134";
        using var r = await N.Started(x => x.Request(41, 693134, x.Emma, is4k: true));
        var title = TitleKey.Parse(name)!;
        var item = Guid.NewGuid();
        var old = r.Arr.Now.UtcDateTime.AddDays(-30);
        r.View.AddCopy(title, new JfCopy { ItemId = item, Path = "/media/movies/Dune/Dune.mkv", DateCreated = old });
        r.View.AddSource(item, 1920, 1080, "/media/movies/Dune/Dune.mkv", old);
        await r.Step(name);
        Assert.Empty(r.Inbox(r.Emma));
        r.View.SourcesByItem[item].Clear();
        r.View.AddSource(item, 3840, 2160, "/media/movies/Dune/Dune.mkv", old);
        r.View.Rev++;
        r.Arr.Now = r.Arr.Now.AddMinutes(5);
        Sql(r, "CREATE TRIGGER evidence_notify_failure BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'simulated write outage'); END");
        await r.Step(name);
        Assert.Empty(r.Inbox(r.Emma));
        Assert.NotEqual("ready", r.NotifyStore.Watch(r.Emma.UserId, name, "m4k")!.Value.Stage);
        Assert.DoesNotContain("3840x2160", r.NotifyStore.Watch(r.Emma.UserId, name, "m4k|sources")?.Known ?? string.Empty);
        Sql(r, "DROP TRIGGER evidence_notify_failure");
        r.Open();
        await r.Step(name);
        await r.Step(name);
        Assert.Single(r.Inbox(r.Emma), n => n.Kind == "ready");
    }

    // The episode form of the same failure: the 4K episode's batch can't be written. The known episodes, the marks AND the
    // source baseline roll back together, so after a restart the episode is still an upgrade and is announced once.
    [Fact]
    public async Task AFailedEpisodeBatchRemainsAnUpgradeOnRetry()
    {
        var (r, title, item, before) = await OldHd(movie: false);
        using var _ = r;
        r.View.SourcesByItem[item][0] = Probed(before, 3840, 2160);
        r.View.Rev++;
        Sql(r, "CREATE TRIGGER evidence_batch_failure BEFORE INSERT ON batches BEGIN SELECT RAISE(ABORT, 'simulated write outage'); END");
        await Observe(r, title);
        Assert.Empty(r.Inbox(r.Emma));
        Assert.DoesNotContain("3840x2160", r.NotifyStore.Watch(r.Emma.UserId, title.ToString(), "eps4k|sources")?.Known ?? string.Empty);
        Sql(r, "DROP TRIGGER evidence_batch_failure");
        r.Open();
        await Observe(r, title);
        await Observe(r, title);
        var notice = Assert.Single(r.Inbox(r.Emma));
        Assert.Equal("4k", JsonSerializer.Deserialize<Dictionary<string, string>>(notice.Payload)!["variant"]);
    }

    // Ordinary Seerr notices: a decline whose notification can't be written must not be recorded as seen; once the database
    // takes writes again it is told once.
    [Fact]
    public async Task ADeclineWhoseNoticeFailedIsToldOnceLater()
    {
        using var r = await N.Started();
        r.Arr.Now = r.Arr.Now.AddMinutes(1);
        r.Seerr.Requests.Add(FakeSeerr.Request(7, "movie", 693134, 1, r.Emma.UserId, r.Arr.Now.UtcDateTime, userName: "Emma"));
        await r.Step();
        r.Seerr.Requests.RemoveAll(x => (int)x["id"]! == 7);
        r.Arr.Now = r.Arr.Now.AddMinutes(1);
        r.Seerr.Requests.Add(FakeSeerr.Request(7, "movie", 693134, 3, r.Emma.UserId, r.Arr.Now.UtcDateTime.AddMinutes(-1), r.Arr.Now.UtcDateTime, userName: "Emma"));
        Sql(r, "CREATE TRIGGER evidence_decline_failure BEFORE INSERT ON notifications WHEN NEW.kind = 'declined' BEGIN SELECT RAISE(ABORT, 'simulated write outage'); END");
        await Record.ExceptionAsync(() => r.Step());
        Assert.Empty(r.Inbox(r.Emma));
        Sql(r, "DROP TRIGGER evidence_decline_failure");
        r.Open();
        await r.Step();
        await r.Step();
        Assert.Equal("declined", Assert.Single(r.Inbox(r.Emma)).Kind);
    }
}
