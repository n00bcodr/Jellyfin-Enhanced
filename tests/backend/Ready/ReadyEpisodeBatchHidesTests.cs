using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;

namespace JE.Tests;

/// <summary>
/// 4f review round 2 (security-3 = behaviour-1): a batch of new episodes is checked against the recipient's Hidden Content
/// per episode, not only at its series. Episodes they hid are left out, the count, seasons and wording are worked out again
/// from what is left, and a batch with nothing left isn't sent, on the TV message and on every channel sharing the batch
/// (ntfy, e-mail and the bell).
/// </summary>
[Collection("Plugin singleton")]
public class ReadyEpisodeBatchHidesTests
{
    private const string Show = "tv:tvdb:371980";

    private sealed class Batch : IDisposable
    {
        public IntegrationNotificationsTests.Rig Rig { get; } = new();
        public FakeReadySessionHost Sessions { get; } = new();
        public FakeReadyPrivacy Privacy { get; } = new();
        public NotifyDispatcher Dispatcher { get; }
        public Guid Series { get; } = Guid.NewGuid();
        public Guid Season { get; } = Guid.NewGuid();
        public Guid[] Episodes { get; } = { Guid.NewGuid(), Guid.NewGuid() };
        public long Notification { get; }

        public Batch()
        {
            var rig = Rig;
            rig.Config.ArrPhase4Enabled = true;
            rig.Config.ArrPhase4ReadyMessagesEnabled = true;
            rig.Phones(rig.Emma);
            rig.Prefs(rig.Emma, p => p.NativeReadyMessages = true);
            rig.View.AddCopy(TitleKey.Parse(Show)!, new JfCopy { ItemId = Series, Path = "/tv/severance" });
            rig.View.AddSeason(Series, new JfSeason { ItemId = Season, Season = 1 });
            for (var i = 0; i < 2; i++) rig.View.AddEpisode(Series, new JfEpisode { ItemId = Episodes[i], Season = 1, Episode = i + 1 });
            Sessions.Add(rig.Emma.UserId, "tv", rig.Arr.Now.UtcDateTime);
            var channel = new ReadyNativeChannel(new ReadyPlaylistStore(rig.Db), new ReadySessionMessages(Sessions, () => rig.Arr.Now.UtcDateTime), Privacy, rig.View, null, () => rig.Arr.Now);
            Dispatcher = new NotifyDispatcher(rig.NotifyStore, new NtfySender(rig.Ntfy), new EmailSender(rig.Mail), null, () => rig.Config, () => rig.Arr.Now, rig.Users, rig.View, rig.Status.Aliases, native: channel);
            // "Season 1 is ready" (all 2 episodes of season 1), on the TV, the phone, e-mail and the bell.
            var payload = new Dictionary<string, string>
            {
                ["title"] = "Severance", ["year"] = "2022", ["count"] = "2", ["seasons"] = "1", ["mode"] = "season", ["season"] = "1",
                ["episodeItems"] = JsonSerializer.Serialize(Episodes.Select((e, i) => new { ItemId = e, Season = 1, Episode = i + 1 })),
            };
            Notification = rig.NotifyStore.Add(rig.Emma.UserId, "eps|" + Guid.NewGuid().ToString("N"), NotifyKind.Episodes, Show, Season.ToString("N"), payload,
                new[] { (NotifyChannel.DisplayMessage, rig.Arr.Now), (NotifyChannel.Ntfy, rig.Arr.Now), (NotifyChannel.Email, rig.Arr.Now) }, rig.Arr.Now)!.Value;
        }

        public void Hide(params Guid[] items) => Privacy.Rules[Rig.Emma.UserId] = new ReadyHides(items, Array.Empty<Guid>(), Array.Empty<string>());

        public IReadOnlyList<(string Channel, string Status)> Deliveries()
        {
            using var c = new SqliteConnection("Data Source=" + Rig.Db.FilePath + ";Pooling=False");
            c.Open();
            using var cmd = c.CreateCommand();
            cmd.CommandText = "SELECT channel, status FROM deliveries WHERE notification_id=$n ORDER BY id";
            cmd.Parameters.AddWithValue("$n", Notification);
            using var r = cmd.ExecuteReader();
            var list = new List<(string, string)>();
            while (r.Read()) list.Add((r.GetString(0), r.GetString(1)));
            Assert.Equal(3, list.Count);
            return list;
        }

        public JsonElement Bell()
        {
            var controller = new NotifyController(Rig.Service, Dispatcher, new NtfySender(Rig.Ntfy), new EmailSender(Rig.Mail), Rig.Users)
            {
                ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
                Config = () => Rig.Config,
                Now = () => Rig.Arr.Now,
            };
            controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", Rig.Emma.UserId.ToString())], "test"));
            var result = (ObjectResult)controller.GetInbox(null, null);
            return JsonDocument.Parse(JsonSerializer.Serialize(result.Value)).RootElement.GetProperty("items")[0];
        }

        public void Dispose()
        {
            Dispatcher.Dispose();
            Rig.Dispose();
        }
    }

    [Fact]
    public async Task WithNothingHiddenTheSeasonGoesOutAsBefore()
    {
        using var b = new Batch();
        await b.Dispatcher.RunOnceAsync(default);
        var sent = Assert.Single(b.Sessions.Sent);
        Assert.Equal("Severance: Season 1 is ready", sent.Header);
        Assert.Contains(b.Rig.Pushes, p => (string)p.Body["title"]! == "Severance: Season 1 is ready");
        Assert.Contains(b.Rig.Mail.Sent, m => m.Subject.Contains("Severance: Season 1 is ready", StringComparison.Ordinal));
        Assert.Equal("2", b.Bell().GetProperty("params").GetProperty("count").GetString());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task EveryEpisodeHiddenSendsNothingAnywhere(bool atTheLastMoment)
    {
        using var b = new Batch();
        if (atTheLastMoment) b.Sessions.OnReread = _ => b.Hide(b.Episodes);
        else b.Hide(b.Episodes);
        await b.Dispatcher.RunOnceAsync(default);
        Assert.Empty(b.Sessions.Sent);
        Assert.All(b.Deliveries().Where(d => d.Channel == NotifyChannel.DisplayMessage), d => Assert.Equal("suppressed", d.Status));
        if (!atTheLastMoment)
        {
            // The phone and e-mail share the batch: nothing sent there either, and the bell no longer names it.
            Assert.DoesNotContain(b.Rig.Pushes, p => p.Body.ToJsonString().Contains("Severance", StringComparison.Ordinal));
            Assert.DoesNotContain(b.Rig.Mail.Sent, m => m.Subject.Contains("Severance", StringComparison.Ordinal) || m.Text.Contains("Severance", StringComparison.Ordinal));
            Assert.All(b.Deliveries(), d => Assert.Equal("suppressed", d.Status));
            var bell = b.Bell();
            Assert.Equal(JsonValueKind.Null, bell.GetProperty("key").ValueKind);
            Assert.Equal(JsonValueKind.Null, bell.GetProperty("itemId").ValueKind);
            Assert.False(bell.GetProperty("params").TryGetProperty("title", out _));
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task OneEpisodeHiddenLeavesTheOtherAsASingleEpisode(bool atTheLastMoment)
    {
        using var b = new Batch();
        if (atTheLastMoment) b.Sessions.OnReread = _ => b.Hide(b.Episodes[0]);
        else b.Hide(b.Episodes[0]);
        await b.Dispatcher.RunOnceAsync(default);
        var sent = Assert.Single(b.Sessions.Sent);
        Assert.Equal("Severance: episode 2 is ready", sent.Header);
        Assert.Equal("Season 1, episode 2.", sent.Text);
        if (!atTheLastMoment)
        {
            Assert.Contains(b.Rig.Pushes, p => (string)p.Body["title"]! == "Severance: episode 2 is ready");
            Assert.DoesNotContain(b.Rig.Pushes, p => p.Body.ToJsonString().Contains("Season 1 is ready", StringComparison.Ordinal));
            Assert.Contains(b.Rig.Mail.Sent, m => m.Subject.Contains("Severance: episode 2 is ready", StringComparison.Ordinal));
            var bell = b.Bell().GetProperty("params");
            Assert.Equal(("1", "single", "2"), (bell.GetProperty("count").GetString(), bell.GetProperty("mode").GetString(), bell.GetProperty("episode").GetString()));
            Assert.Equal(b.Episodes[1].ToString("N"), b.Bell().GetProperty("itemId").GetString());
        }
    }

    [Fact]
    public async Task AHiddenSeriesHidesTheWholeBatchOnEveryChannel()
    {
        using var b = new Batch();
        b.Privacy.Rules[b.Rig.Emma.UserId] = new ReadyHides(new[] { b.Series }, new[] { b.Series }, Array.Empty<string>(), new[] { b.Series });
        await b.Dispatcher.RunOnceAsync(default);
        Assert.Empty(b.Sessions.Sent);
        Assert.All(b.Deliveries(), d => Assert.Equal("suppressed", d.Status));
        Assert.Equal(JsonValueKind.Null, b.Bell().GetProperty("key").ValueKind);
    }

    [Fact]
    public async Task HiddenContentThatCantBeReadSendsNoBatchAnywhere()
    {
        using var b = new Batch();
        b.Privacy.Rules[b.Rig.Emma.UserId] = null;
        await b.Dispatcher.RunOnceAsync(default);
        Assert.Empty(b.Sessions.Sent);
        Assert.Empty(b.Rig.Pushes);
        Assert.Empty(b.Rig.Mail.Sent);
        // Round 3: the TV message is never held; the phone and e-mail wait until the rules can be read (never sent before).
        Assert.Equal(new[] { (NotifyChannel.DisplayMessage, "suppressed"), (NotifyChannel.Ntfy, "pending"), (NotifyChannel.Email, "pending") }, b.Deliveries());
        Assert.Equal(JsonValueKind.Null, b.Bell().GetProperty("key").ValueKind);
    }

    // Live (12.2): a batch whose episodes were all hidden before it was gathered still became a bell row, and its toast said
    // "Something you follow: 2 new episodes ready". The producer applies Hidden Content per episode too.
    [Theory]
    [InlineData(2)]
    [InlineData(1)]
    public async Task ABatchGatheredAfterTheEpisodesWereHiddenLeavesThemOutFromTheStart(int hiddenCount)
    {
        const string show = "tv:tvdb:371980";
        var series = Guid.NewGuid();
        using var rig = await IntegrationNotificationsTests.Started(r =>
        {
            r.Request(1, 95396, r.Emma, type: "tv", tvdb: 371980, seasons: new[] { 2 });
            r.View.AddCopy(TitleKey.Parse(show)!, new JfCopy { ItemId = series, DateCreated = r.Arr.Now.UtcDateTime.AddDays(-30) });
            r.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = r.Arr.Now.UtcDateTime.AddDays(-30) });
        });
        var privacy = new FakeReadyPrivacy();
        var channel = new ReadyNativeChannel(new ReadyPlaylistStore(rig.Db), new ReadySessionMessages(new FakeReadySessionHost(), () => rig.Arr.Now.UtcDateTime), privacy, rig.View, null, () => rig.Arr.Now);
        using var dispatcher = new NotifyDispatcher(rig.NotifyStore, new NtfySender(rig.Ntfy), new EmailSender(rig.Mail), null, () => rig.Config, () => rig.Arr.Now, rig.Users, rig.View, rig.Status.Aliases, native: channel);
        using var service = new NotificationService(rig.NotifyStore, rig.Status, rig.Requests, rig.View, rig.Feed, rig.Store, rig.Users, dispatcher, null, null, () => rig.Config, () => rig.Arr.Now, rig.Hub, rig.Bridge);
        var files = new[] { Guid.NewGuid(), Guid.NewGuid() };
        for (var i = 0; i < 2; i++) rig.View.AddEpisode(series, new JfEpisode { ItemId = files[i], Season = 2, Episode = i + 1, DateCreated = rig.Arr.Now.UtcDateTime });
        privacy.Rules[rig.Emma.UserId] = new ReadyHides(files.Take(hiddenCount), Array.Empty<Guid>(), Array.Empty<string>());
        async Task Step()
        {
            await rig.Requests.RefreshAsync(default);
            await service.TickAsync(default);
            await service.EvaluateAsync(new[] { show }, null, default);
            service.FlushBatches(rig.Arr.Now);
        }
        await Step();
        rig.Arr.Now += TimeSpan.FromMinutes(11);
        await Step();
        var rows = rig.Inbox(rig.Emma).Where(r => r.Kind == NotifyKind.Episodes).ToList();
        if (hiddenCount == 2)
        {
            Assert.Empty(rows);
            return;
        }
        var payload = NotifyDispatcher.Payload(Assert.Single(rows).Payload);
        Assert.Equal(("1", "single", "2"), (payload["count"], payload["mode"], payload["episode"]));
        Assert.DoesNotContain(files[0].ToString(), Assert.Single(rows).Payload, StringComparison.OrdinalIgnoreCase);
    }
}
