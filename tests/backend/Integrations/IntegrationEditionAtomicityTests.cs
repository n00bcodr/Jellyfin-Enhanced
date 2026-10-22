using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using P = JE.Tests.IntegrationEditionPressTests;
using M = JE.Tests.IntegrationEditionMaskedTests;
using N = JE.Tests.IntegrationNotificationsTests;
using L = JE.Tests.IntegrationRequestLedgerTests;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class IntegrationEditionAtomicityTests
{
    private static readonly TitleKey Firefly = TitleKey.Parse("tv:tvdb:78874")!;

    [Fact]
    public async Task AnAskInPreparationCannotReuseTheKeyASearchTakesMeanwhile()
    {
        using var p = new P.PressRig(false);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        p.Policy.Before = (_, _) => { entered.TrySetResult(); return resume.Task; };
        var askTask = p.Requests.CreateAsync(p.Rig.Admin.UserId, new CreateRequest("racing-key", new MutationInput { Key = Firefly.ToString(), Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 3) } }), default);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var instance = p.Rig.Arr.Instance("SonarrZ").Id;
        var result = await p.Manage.SearchCheckedAsync(p.Rig.Admin, null, instance, Firefly.WithEpisode(1, 3), "racing-key", default);
        Assert.Equal(PressChecks.Conflict, result.Refusal);
        resume.TrySetResult();
        var ask = await askTask;
        Assert.True(ask.HttpStatus is 200 or 201 && p.Ledger.ForTitle(Firefly.ToString()).Count == 1 && p.Rig.Sonarr.Writes.All(w => w.Path != "/api/v3/command"),
            $"The search succeeded and {p.Rig.Sonarr.Writes.Count(w => w.Path == "/api/v3/command")} command ran, but the concurrent ask returned {ask.HttpStatus}/{ask.Reason}, wants={p.Ledger.ForTitle(Firefly.ToString()).Count}.");
    }

    [Fact]
    public async Task ASearchKeyStillBelongsToTheSearchAfterARestart()
    {
        using var r = new L.Rig();
        var runner = new ArrActionRunner(r.Audit, new ArrConfirmationTokens());
        var action = await runner.RunAsync(new ArrActionRequest { UserId = r.Admin, IdempotencyKey = "before-restart", Action = "movie.search", InstanceId = "r1", Target = "movie:603", Execute = _ => Task.FromResult<ArrError?>(null) });
        Assert.Equal(ArrActionStatus.Succeeded, action.Status);
        r.Reopen();
        var restarted = new ArrActionRunner(r.Audit, new ArrConfirmationTokens());
        var ask = await r.Create(r.Admin, client: "before-restart");
        Assert.True(ask.HttpStatus == 409 && ask.Reason == PressChecks.Conflict, $"Search key accepted as an ask after restart: {ask.HttpStatus}/{ask.Reason}");
    }

    private static FakeArr.Host AddHolder(P.PressRig p)
    {
        var rows = JsonNode.Parse(p.Config.SonarrInstances)!.AsArray();
        var row = (JsonObject)rows.First(x => (string?)x!["Name"] == "SonarrZ")!.DeepClone();
        row["Id"] = Guid.NewGuid().ToString("N"); row["Name"] = "Late holder"; row["Url"] = "http://late-holder.invalid:8989"; row["IsDefault"] = false; row["ApiKey"] = "synthetic-fixture";
        rows.Add(row); p.Config.SonarrInstances = rows.ToJsonString();
        return p.Rig.Arr.Add("late-holder.invalid", "Sonarr");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ANewHoldersSeasonPackMakesItsNamedEpisodesUnderWay(bool pack)
    {
        using var p = new P.PressRig(false);
        p.Rig.Sonarr.Episodes.Add(M.Aired(104, 4));
        var late = AddHolder(p);
        var page = await p.Page(p.Rig.Member, p.StandardPage);
        var copy = P.CopyOf(page);
        var series = (JsonObject)p.Rig.Sonarr.Series[0].DeepClone();
        series["id"] = 44; series["path"] = "/data/tv/LateFirefly"; late.Series.Add(series);
        var episode = M.Aired(4404, 4); episode["seriesId"] = 44; late.Episodes.Add(episode);
        var queue = FakeArr.SonarrQueueRow(4404, "new-pack", 1, 4, "Firefly", 78874);
        queue["seriesId"] = 44;
        if (pack) queue["episodeId"] = null;
        queue["seasonNumber"] = 1;
        if (pack) queue["episode"] = null;
        late.Queue.Add(queue);
        var input = new MutationInput { Key = Firefly.ToString(), Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 4) } };
        var expect = Wiring.Body<PressIntent>(P.Intent(p.StandardPage, "get", new[] { 4 }, copy, "standard").ToJsonString());
        var (status, body) = P.Read(await p.Asks(p.Rig.Member).Create(new CreateRequest("pack-check", input, expect), default));
        Assert.True(status == 409 && P.Code(body) == PressChecks.Changed, $"pack={pack}: {status} {body}");
        Assert.Empty(p.Ledger.ForTitle(Firefly.ToString()));
    }

    private sealed class RestoreOnSecondUser : INotifyUsers
    {
        private readonly INotifyUsers _inner;
        private readonly Action _restore;
        private int _count;
        public RestoreOnSecondUser(INotifyUsers inner, Action restore) { _inner = inner; _restore = restore; }
        public IReadOnlyList<Guid> Admins() => _inner.Admins();
        public bool Exists(Guid user) => _inner.Exists(user);
        public bool IsActive(Guid user) { if (++_count == 2) _restore(); return _inner.IsActive(user); }
        public string? Name(Guid user) => _inner.Name(user);
        public string? ItemName(Guid item) => _inner.ItemName(item);
    }

    [Fact]
    public async Task ASeerrScanCannotCommitSeenStatePastARestoreThatLostItsNotification()
    {
        using var r = await N.Started();
        r.Request(7, 693134, r.Emma, status: 1, created: r.Arr.Now.UtcDateTime);
        r.Request(8, 603, r.Sam, status: 1, created: r.Arr.Now.UtcDateTime);
        await r.Step();
        r.Phones(r.Emma, r.Sam);
        var snapshot = r.Db.Snapshot()!;
        foreach (var row in r.Seerr.Requests) row["status"] = 3;
        r.Arr.Now = r.Arr.Now.AddMinutes(1);
        await r.Requests.RefreshAsync(default);
        var restored = false;
        var users = new RestoreOnSecondUser(r.Users, () => {
            Assert.DoesNotContain(r.Inbox(r.Emma).Concat(r.Inbox(r.Sam)), n => n.Kind == "declined");
            r.Db.ReplaceWith(snapshot); restored = true;
        });
        using var service = new NotificationService(r.NotifyStore, r.Status, r.Requests, r.View, r.Feed, r.Store, users, r.Dispatcher, null, null, () => r.Config, () => r.Arr.Now, r.Hub, r.Bridge);
        Assert.False(service.ScanRequests(r.Arr.Now));
        Assert.True(restored);
        Assert.All(r.NotifyStore.SeerrSeen().Values, s => Assert.Equal(1, s));
        r.Open();
        await r.Step();
        Assert.Equal(2, r.Inbox(r.Emma).Count(n => n.Kind == "declined") + r.Inbox(r.Sam).Count(n => n.Kind == "declined"));
        Assert.Equal(4, r.Db.Read(c => { using var cmd = c.CreateCommand(); cmd.CommandText = "SELECT COUNT(*) FROM deliveries d JOIN notifications n ON n.id=d.notification_id WHERE n.kind='declined'"; return Convert.ToInt32(cmd.ExecuteScalar()); }));
        await r.Step();
        Assert.Equal(2, r.Inbox(r.Emma).Count(n => n.Kind == "declined") + r.Inbox(r.Sam).Count(n => n.Kind == "declined"));
    }

    [Fact]
    public async Task AnOlderLookCannotOverwriteANewerCommittedQuality()
    {
        var title = TitleKey.Parse("movie:tmdb:693134")!;
        using var r = await N.Started(x => x.Request(41, 693134, x.Emma, is4k: true));
        var item = Guid.NewGuid();
        var old = r.Arr.Now.UtcDateTime.AddDays(-30);
        const string path = "/media/movies/Dune/Dune.mkv";
        r.View.AddCopy(title, new JfCopy { ItemId = item, Path = path, DateCreated = old });
        var before = r.View.AddSource(item, 1920, 1080, path, old);
        await r.Step(title.ToString());
        using var release = new ManualResetEventSlim();
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var pause = 1;
        DateTimeOffset Clock()
        {
            if (new System.Diagnostics.StackTrace().GetFrames().Any(f => f.GetMethod()?.Name == "Baselines") && Interlocked.Exchange(ref pause, 0) == 1)
            {
                reached.TrySetResult();
                Assert.True(release.Wait(TimeSpan.FromSeconds(15)));
            }
            return r.Arr.Now;
        }
        using var service = new NotificationService(r.NotifyStore, r.Status, r.Requests, r.View, r.Feed, r.Store, r.Users, r.Dispatcher, null, null, () => r.Config, Clock, r.Hub, r.Bridge);
        service.RebuildInterest();
        r.View.SourcesByItem[item][0] = new JfSource { SourceId = before.SourceId, ItemId = before.ItemId, BackingItemId = before.BackingItemId, Path = path, DateCreated = old, Width = 1280, Height = 720 };
        r.View.Rev++;
        var stale = Task.Run(() => service.SetFollowAsync(r.Emma, title, true, default));
        try
        {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
            r.View.SourcesByItem[item][0] = new JfSource { SourceId = before.SourceId, ItemId = before.ItemId, BackingItemId = before.BackingItemId, Path = path, DateCreated = old, Width = 3840, Height = 2160 };
            r.View.Rev++;
            var newer = service.TickAsync(default, force: true);
            await Task.Delay(50);
            Assert.False(newer.IsCompleted);
            release.Set();
            await Task.WhenAll(stale, newer).WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Contains("3840x2160", r.NotifyStore.Watch(r.Emma.UserId, title.ToString(), "m4k|sources")?.Known ?? "");
            Assert.Single(r.Inbox(r.Emma));
        }
        finally { release.Set(); }
        var known = r.NotifyStore.Watch(r.Emma.UserId, title.ToString(), "m4k|sources")?.Known ?? "";
        Assert.True(known.Contains("3840x2160"), "An older look overwrote committed 4K evidence; now720=" + known.Contains("1280x720"));
        Assert.Equal("ready", r.NotifyStore.Watch(r.Emma.UserId, title.ToString(), "m4k")?.Stage);
    }

    [Fact]
    public async Task AHouseholdSearchRetryMustCompareItsModeToo()
    {
        using var p = new P.PressRig(false);
        var method = typeof(IntegrationEditionPressIdentityTests).GetMethod("FiftyOneMissing", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic)!;
        var setup = (Task<(PressIntent, System.Collections.Concurrent.ConcurrentDictionary<string, DateTimeOffset>)>)method.Invoke(null, new object[] { p })!;
        var (intent, _) = await setup;
        var initial = await p.Search.SearchAsync(p.Rig.Member, Firefly.WithSeason(1).ToString(), "mode-retry", default, intent);
        Assert.Equal("searched", initial.Outcome.Reason);
        var retry = await p.Search.SearchAsync(p.Rig.Member, Firefly.WithSeason(1).ToString(), "mode-retry", default, intent with { Mode = "get" });
        Assert.True(retry.Outcome.HttpStatus == 409 && retry.Outcome.Reason == PressChecks.Conflict,
            $"Changed mode got the old search receipt: {retry.Outcome.HttpStatus}/{retry.Outcome.Reason}");
    }
}
