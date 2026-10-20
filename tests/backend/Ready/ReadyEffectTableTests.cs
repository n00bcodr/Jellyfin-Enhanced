using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using World = JE.Tests.ReadyProvenanceAndWaitsTests.World;

namespace JE.Tests;

/// <summary>
/// 4f round 10 (4f-r9-1, 4f-r9-2, D53): one verdict → effect table at every action site, and every alert carries its own
/// origin. The native message's claim: notifications switched off during its session re-read is Off (nothing is done: the
/// delivery stays pending, no attempt is claimed), and the message goes once when they are back on; it was suppressed for good.
/// A deferred episode batch: each member keeps its own arrival; at the flush the members older than the catch-up limit are
/// dropped and the fresh ones told; it was told whole, with no origin at all.
/// </summary>
[Collection("Plugin singleton")]
public class ReadyEffectTableTests
{
    private const string Severance = "tv:tvdb:371980";

    [Fact]
    public async Task NotificationsSwitchedOffDuringTheClaimsSessionReReadLeaveTheNativeMessagePendingAndItGoesOnceWhenBackOn()
    {
        using var w = new ReadyMessagesTests.World();
        w.Sessions.Add(w.Emma.UserId, "tv", w.At.UtcDateTime);
        var n = w.Queue(w.Emma);
        var once = true;
        w.Sessions.OnReread = _ =>
        {
            if (!once) return;
            once = false;
            w.Config.ArrNotificationsEnabled = false;
        };

        await w.Dispatcher.RunOnceAsync(default);
        Assert.Empty(w.Sessions.Sent);
        Assert.Equal("pending", w.Status(n));
        Assert.Equal(0L, w.Scalar("SELECT COUNT(*) FROM ready_message_attempts"));

        // Still off: nothing.
        await w.Dispatcher.RunOnceAsync(default);
        Assert.Empty(w.Sessions.Sent);
        Assert.Equal("pending", w.Status(n));

        // Back on (within the message's ten minutes): delivered, once.
        w.Config.ArrNotificationsEnabled = true;
        w.At = w.At.AddMinutes(2);
        w.Sessions.Add(w.Emma.UserId, "tv", w.At.UtcDateTime);
        await w.Dispatcher.RunOnceAsync(default);
        Assert.Single(w.Sessions.Sent);
        Assert.Equal("sent", w.Status(n));
        await w.Dispatcher.RunOnceAsync(default);
        Assert.Single(w.Sessions.Sent);
    }

    [Fact]
    public async Task ASeerrAskThatMustWaitIsPostponedInTheWaitQueueAndToldOnceSeerrCanBeReadAgain()
    {
        // The table at the Seerr scan: Wait = postpone. Seerr's list stops being readable between two administrators' gates in
        // the same scan (Seerr switched off while Jake's view of the title is evaluated): Sam's ask waits in the wait queue and
        // the change is seen; once Seerr is back, Sam is told once. It was dropped (the change seen, nothing kept for Sam).
        var w = new World(await IntegrationNotificationsTests.Started(), jeMode: false);
        using (w)
        {
            var sam = w.Rig.Sam;
            w.Rig.Users.AdminIds.Add(sam.UserId);
            w.Rig.Users.Names[sam.UserId] = "Sam";
            w.Policy.People[sam.UserId] = new(sam.UserId, "Admin", true, true, true, true, "p1", "je", "inst", "g1", 1000, 7, 0, "{}");
            w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(1);
            var once = false;
            w.Policy.Adjust = (user, input, facts) =>
            {
                if (user == w.Rig.Admin.UserId && !once && w.Rig.Config.JellyseerrEnabled && w.Rig.Seerr.Requests.Count > 0)
                {
                    once = true;
                    w.Rig.Config.JellyseerrEnabled = false;
                }

                return facts;
            };
            w.Rig.Seerr.Requests.Add(FakeSeerr.Request(7, "movie", 7100, 1, w.Rig.Kid.UserId, w.Rig.Arr.Now.UtcDateTime, userName: "Kid"));
            await w.Step(false);
            Assert.True(once);
            Assert.Equal(1, w.Rows(w.Rig.Admin, NotifyKind.Approval));
            Assert.Equal(0, w.Rows(sam, NotifyKind.Approval));
            Assert.Equal(1L, w.Count("SELECT COUNT(*) FROM alert_waits WHERE source='seerr-ask'"));

            w.Policy.Adjust = null;
            w.Rig.Config.JellyseerrEnabled = true;
            w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(6);
            await w.Step(false);
            await w.Step(false);
            Assert.Equal(1, w.Rows(sam, NotifyKind.Approval));
            Assert.Equal(1, w.Rows(w.Rig.Admin, NotifyKind.Approval));
            Assert.Equal(0L, w.Count("SELECT COUNT(*) FROM alert_waits"));
        }
    }

    // Severance followed by Emma, S1E1 here long ago; S1E2 arrives now and is batched (the window closes in ten minutes).
    private static async Task<(World W, Guid Series, DateTimeOffset Start)> Batched()
    {
        var w = new World(await IntegrationNotificationsTests.Started(), jeMode: false);
        var series = Guid.NewGuid();
        var start = w.Rig.Arr.Now;
        w.Rig.View.AddCopy(TitleKey.Parse(Severance)!, new JfCopy { ItemId = series, Path = "/tv/Severance", DateCreated = start.UtcDateTime.AddDays(-30) });
        w.Rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = start.UtcDateTime.AddDays(-30) });
        Assert.Equal("ok", await w.Service.SetFollowAsync(w.Rig.Emma, TitleKey.Parse(Severance)!, true, default));
        w.Rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 2, DateCreated = start.UtcDateTime });
        await w.Service.EvaluateAsync(new[] { Severance }, null, default);
        Assert.Equal(0, w.Rows(w.Rig.Emma, NotifyKind.Episodes));
        Assert.Equal(1L, w.Count("SELECT COUNT(*) FROM batches"));

        // Notifications switched off before the flush: the batch is left as it is.
        w.Rig.Config.ArrNotificationsEnabled = false;
        w.Rig.Arr.Now = start.AddMinutes(11);
        w.Service.FlushBatches(w.Rig.Arr.Now);
        Assert.Equal(0, w.Rows(w.Rig.Emma, NotifyKind.Episodes));
        Assert.Equal(1L, w.Count("SELECT COUNT(*) FROM batches"));
        return (w, series, start);
    }

    private static Dictionary<string, string> Payload(World w)
    {
        var json = (string)w.Rig.Db.Read(c => NotifyStore.Scalar(c, "SELECT payload FROM notifications WHERE kind='episodes'", Array.Empty<(string, object?)>(), null))!;
        return JsonSerializer.Deserialize<Dictionary<string, string>>(json)!;
    }

    [Fact]
    public async Task AnEpisodeBatchDeferredAcrossTheCatchUpLimitDropsItsStaleMembersAndTellsTheFreshOnes()
    {
        var (w, series, start) = await Batched();
        using (w)
        {
            // S1E3 arrives two days later, while notifications are still off.
            var e3 = Guid.NewGuid();
            w.Rig.View.AddEpisode(series, new JfEpisode { ItemId = e3, Season = 1, Episode = 3, DateCreated = start.UtcDateTime.AddDays(2) });

            // Back on three days and an hour after S1E2 arrived: the look joins S1E3 to the open batch, and the flush tells S1E3
            // alone (S1E2 is past the catch-up limit; S1E3 isn't).
            w.Rig.Arr.Now = start + NotificationService.ArrivalFreshFor + TimeSpan.FromHours(1);
            w.Rig.Config.ArrNotificationsEnabled = true;
            await w.Service.EvaluateAsync(new[] { Severance }, null, default);
            w.Service.FlushBatches(w.Rig.Arr.Now);

            Assert.Equal(1, w.Rows(w.Rig.Emma, NotifyKind.Episodes));
            var p = Payload(w);
            Assert.Equal("1", p["count"]);
            Assert.Equal("single", p["mode"]);
            Assert.Equal("3", p["episode"]);
            var items = JsonSerializer.Deserialize<List<JsonElement>>(p["episodeItems"])!;
            Assert.Equal(new[] { 3 }, items.Select(i => i.GetProperty("Episode").GetInt32()).ToArray());
            Assert.Equal(0L, w.Count("SELECT COUNT(*) FROM batches"));
        }
    }

    [Fact]
    public async Task AnEpisodeBatchWhoseEveryMemberIsPastTheCatchUpLimitIsDroppedUntold()
    {
        var (w, _, start) = await Batched();
        using (w)
        {
            w.Rig.Arr.Now = start + NotificationService.ArrivalFreshFor + TimeSpan.FromHours(1);
            w.Rig.Config.ArrNotificationsEnabled = true;
            w.Service.FlushBatches(w.Rig.Arr.Now);
            Assert.Equal(0, w.Rows(w.Rig.Emma, NotifyKind.Episodes));
            Assert.Equal(0L, w.Count("SELECT COUNT(*) FROM batches"));
        }
    }

    [Fact]
    public async Task AFreshDeferredEpisodeBatchIsToldWholeOnceNotificationsAreBack()
    {
        var (w, _, start) = await Batched();
        using (w)
        {
            w.Rig.Arr.Now = start + NotificationService.ArrivalFreshFor - TimeSpan.FromHours(1);
            w.Rig.Config.ArrNotificationsEnabled = true;
            w.Service.FlushBatches(w.Rig.Arr.Now);
            Assert.Equal(1, w.Rows(w.Rig.Emma, NotifyKind.Episodes));
            Assert.Equal("2", Payload(w)["episode"]);
        }
    }
}
