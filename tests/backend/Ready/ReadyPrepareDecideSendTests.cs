using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using World = JE.Tests.ReadyProvenanceAndWaitsTests.World;

namespace JE.Tests;

/// <summary>
/// 4f round 8 (4f-r7-1, D53): prepare, then decide, then send. Every alert that goes out, or is counted in a summary, is judged
/// on the settings, rules and evidence as they are after the last await before that send: a batch's awaited preparation all
/// runs first, then one synchronous final decision per member, then the send (or the commit) from that pass's survivors only.
/// Unknown waits (never settled as sent); refused is suppressed. Through the real NotificationService, RequestLedger,
/// RequestService and NotifyDispatcher over a real acquire.db; each change is made inside a later member's (or another
/// person's) awaited preparation, after the earlier members were looked at.
/// </summary>
[Collection("Plugin singleton")]
public class ReadyPrepareDecideSendTests
{
    private const string Dune = "movie:tmdb:693134";

    private static readonly string[] Keys = Enumerable.Range(0, 5).Select(i => "movie:tmdb:" + (7100 + i)).ToArray();

    private static string Name(string key) => "Film " + key.Split(':')[^1];

    private static ReadyHides TitleRules(params string[] keys) => new(Array.Empty<Guid>(), Array.Empty<Guid>(), keys);

    // Quiet hours from an hour ago to an hour from now (UTC): held sends come due two hours on.
    private static void Quiet(World w, StatusViewer who)
        => w.Rig.Prefs(who, p =>
        {
            p.QuietHours = true;
            p.QuietFrom = w.Rig.Arr.Now.UtcDateTime.AddHours(-1).ToString("HH:mm", System.Globalization.CultureInfo.InvariantCulture);
            p.QuietTo = w.Rig.Arr.Now.UtcDateTime.AddHours(1).ToString("HH:mm", System.Globalization.CultureInfo.InvariantCulture);
            p.UtcOffsetMinutes = 0;
        });

    // Five of the kid's requests declined during their quiet hours: five bell rows, each with a phone and an e-mail delivery
    // held until the quiet hours end (one batch of five per channel then). Returns each title's notification id.
    private static async Task<Dictionary<string, long>> FiveHeldDeclines(World w)
    {
        var kid = w.Rig.Kid;
        var ids = new List<string>();
        for (var i = 0; i < Keys.Length; i++) ids.Add(await w.Ask(kid, Keys[i], "kid-" + i));
        Quiet(w, kid);
        foreach (var id in ids) await w.Decide(id, NotifyKind.Declined);
        await w.Step(true);
        var rows = w.Rig.Inbox(kid).Where(r => r.Kind == NotifyKind.Declined).ToDictionary(r => r.Key!, r => r.Id);
        Assert.Equal(Keys.OrderBy(k => k), rows.Keys.OrderBy(k => k));
        Assert.All(rows.Values, id => Assert.All(w.Deliveries(id), d => Assert.Equal("pending", d.Status)));
        Assert.False(w.Told("said no"));
        Assert.False(w.Told("new notifications"));
        return rows;
    }

    // Runs once, inside the dispatcher's awaited preparation of the LAST member of the first channel's batch of five (after
    // the four before it were prepared and looked at); the change gets the titles in the order they were prepared.
    private static void DuringTheLastPreparation(World w, Action<IReadOnlyList<string>> change)
    {
        var kid = w.Rig.Kid.UserId;
        var order = new List<string>();
        w.Policy.Visibility = (who, input) =>
        {
            if (who == kid && order.Count < 5)
            {
                order.Add(input.Key);
                if (order.Count == 5) change(order);
            }

            return Task.CompletedTask;
        };
    }

    private static int Messages(World w) => w.Rig.Pushes.Count + w.Rig.Mail.Sent.Count;

    private static void AssertStatus(World w, long notification, string status)
        => Assert.All(w.Deliveries(notification), d => Assert.Equal(status, d.Status));

    // ================================================================== the summary (4f-r7-1)

    [Theory]
    [InlineData("hidden")]
    [InlineData("unreadable")]
    [InlineData("kind_off")]
    [InlineData("revoked")]
    [InlineData("notifications_off")]
    public async Task AChangeDuringTheLastMembersPreparationCountsForEveryMemberOfTheSummary(string change)
    {
        using var w = await ReadyProvenanceAndWaitsTests.JeWorld();
        var kid = w.Rig.Kid;
        var rows = await FiveHeldDeclines(w);
        string? hidden = null;
        DuringTheLastPreparation(w, order =>
        {
            switch (change)
            {
                case "hidden":
                    // The kid hides the first title of the batch.
                    hidden = order[0];
                    w.Privacy.Rules[kid.UserId] = TitleRules(hidden);
                    break;
                case "unreadable":
                    w.Privacy.Rules[kid.UserId] = null;
                    break;
                case "kind_off":
                    w.Rig.Prefs(kid, p => p.Declined = false);
                    break;
                case "revoked":
                    // The kid's library access is taken away: no title nobody has yet would be visible to them now.
                    w.Policy.Adjust = (user, input, facts) => user == kid.UserId ? facts with { Visible = false } : facts;
                    break;
                default:
                    w.Rig.Config.ArrNotificationsEnabled = false;
                    break;
            }
        });

        w.Rig.Arr.Now = w.Rig.Arr.Now.AddHours(2);
        await w.Dispatcher.RunOnceAsync(default);

        switch (change)
        {
            case "hidden":
                // That one is suppressed on both channels; the summary counts the other four.
                AssertStatus(w, rows[hidden!], "suppressed");
                foreach (var (key, id) in rows.Where(r => r.Key != hidden)) AssertStatus(w, id, "sent");
                Assert.Equal(2, Messages(w));
                Assert.True(w.Told("4 new notifications"));
                Assert.False(w.Told("5 new notifications"));
                break;
            case "unreadable":
            case "notifications_off":
                // Nothing goes out and nothing is settled; all of them go once it can be (one summary per channel).
                Assert.Equal(0, Messages(w));
                foreach (var id in rows.Values) AssertStatus(w, id, "pending");
                w.Policy.Visibility = null;
                w.Privacy.Rules.Remove(kid.UserId);
                w.Rig.Config.ArrNotificationsEnabled = true;
                w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(6);
                await w.Dispatcher.RunOnceAsync(default);
                foreach (var id in rows.Values) AssertStatus(w, id, "sent");
                Assert.Equal(2, Messages(w));
                Assert.True(w.Told("5 new notifications"));
                break;
            default:
                // Refused for every member: all suppressed, nothing sent.
                Assert.Equal(0, Messages(w));
                foreach (var id in rows.Values) AssertStatus(w, id, "suppressed");
                break;
        }
    }

    [Fact]
    public async Task SurvivorsBelowTheSummaryThresholdGoOneByOneAndOnlyTheSurvivorsGo()
    {
        using var w = await ReadyProvenanceAndWaitsTests.JeWorld();
        var kid = w.Rig.Kid;
        var rows = await FiveHeldDeclines(w);
        string[] hidden = Array.Empty<string>();
        DuringTheLastPreparation(w, order =>
        {
            hidden = new[] { order[0], order[1] };
            w.Privacy.Rules[kid.UserId] = TitleRules(hidden);
        });

        w.Rig.Arr.Now = w.Rig.Arr.Now.AddHours(2);
        await w.Dispatcher.RunOnceAsync(default);

        // Three survive: under the summary threshold, each goes on its own (decided again right before its own send).
        Assert.False(w.Told("new notifications"));
        Assert.Equal(3, w.Rig.Pushes.Count);
        Assert.Equal(3, w.Rig.Mail.Sent.Count);
        foreach (var key in hidden)
        {
            AssertStatus(w, rows[key], "suppressed");
            Assert.False(w.Told(Name(key)));
        }

        foreach (var key in Keys.Except(hidden))
        {
            AssertStatus(w, rows[key], "sent");
            Assert.True(w.Told(Name(key)));
        }
    }

    [Fact]
    public async Task NothingChangingSendsOneSummaryPerChannelAndSettlesEveryMemberAsSent()
    {
        // Control.
        using var w = await ReadyProvenanceAndWaitsTests.JeWorld();
        var rows = await FiveHeldDeclines(w);
        DuringTheLastPreparation(w, _ => { });
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddHours(2);
        await w.Dispatcher.RunOnceAsync(default);
        foreach (var id in rows.Values) AssertStatus(w, id, "sent");
        Assert.Single(w.Rig.Pushes);
        Assert.Single(w.Rig.Mail.Sent);
        Assert.True(w.Told("5 new notifications"));
    }

    [Fact]
    public async Task AMemberUnknownFromTheStartIsPostponedAndTheRestAreSummarized()
    {
        // Control: one title's rating can't be verified for the kid's parental limit; it waits, the other four go.
        using var w = await ReadyProvenanceAndWaitsTests.JeWorld();
        var kid = w.Rig.Kid;
        var rows = await FiveHeldDeclines(w);
        var unknown = Keys[2];
        w.Policy.Adjust = (user, input, facts) => user == kid.UserId && input.Key == unknown ? facts with { Visible = false, VisibilityUnknown = true } : facts;
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddHours(2);
        await w.Dispatcher.RunOnceAsync(default);
        AssertStatus(w, rows[unknown], "pending");
        foreach (var (key, id) in rows.Where(r => r.Key != unknown)) AssertStatus(w, id, "sent");
        Assert.True(w.Told("4 new notifications"));
        Assert.Equal(2, Messages(w));

        // Verified later: it goes on its own.
        w.Policy.Adjust = null;
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(6);
        await w.Dispatcher.RunOnceAsync(default);
        AssertStatus(w, rows[unknown], "sent");
        Assert.True(w.Told(Name(unknown)));
    }

    // ================================================================== the sweep: other looped decisions with an await

    [Theory]
    [InlineData("kind_off")]
    [InlineData("notifications_off")]
    [InlineData("hidden")]
    public async Task AWaitingOutcomeIsDecidedAfterItsOwnPreparation(string change)
    {
        // The wait queue's retry: prepared (awaited), then the requester's switches, the request and the title decided.
        using var w = await ReadyProvenanceAndWaitsTests.JeWorld();
        var kid = w.Rig.Kid;
        w.Privacy.Rules[kid.UserId] = null;
        await w.Decide(await w.Ask(kid, Keys[0], "kid-0"), NotifyKind.Declined);
        await w.Step(true);
        Assert.Equal(1L, w.Count("SELECT COUNT(*) FROM alert_waits"));
        w.Privacy.Rules.Remove(kid.UserId);
        w.Policy.Visibility = (who, input) =>
        {
            if (who != kid.UserId) return Task.CompletedTask;
            if (change == "kind_off") w.Rig.Prefs(kid, p => p.Declined = false);
            else if (change == "notifications_off") w.Rig.Config.ArrNotificationsEnabled = false;
            else w.Privacy.Rules[kid.UserId] = TitleRules(Keys[0]);
            return Task.CompletedTask;
        };
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(6);
        await w.Service.RetryAlertWaitsAsync(w.Rig.Arr.Now, default);
        Assert.Equal(0, w.Rows(kid, NotifyKind.Declined));
        if (change == "notifications_off")
        {
            // Left waiting (not dropped): told once notifications are back on.
            Assert.Equal(1L, w.Count("SELECT COUNT(*) FROM alert_waits"));
            w.Policy.Visibility = null;
            w.Rig.Config.ArrNotificationsEnabled = true;
            await w.Step(true);
            Assert.Equal(1, w.Rows(kid, NotifyKind.Declined));
        }
        else
        {
            Assert.Equal(0L, w.Count("SELECT COUNT(*) FROM alert_waits"));
        }
    }

    [Theory]
    [InlineData("kind_off", false)]
    [InlineData("kind_off", true)]
    [InlineData("notifications_off", false)]
    public async Task ARequestersNoticeIsDecidedAfterItsPreparationAndTitleLookup(string change, bool duringLookup)
    {
        // The ledger's notices: the title lookup and the preparation are awaited, then the requester's switches and the
        // request decided (the notice and its notification commit together from that decision).
        using var w = await ReadyProvenanceAndWaitsTests.JeWorld();
        var kid = w.Rig.Kid;
        var id = await w.Ask(kid, Keys[0], "kid-0");
        await w.Step(true);
        void Change()
        {
            if (change == "kind_off") w.Rig.Prefs(kid, p => p.Declined = false);
            else w.Rig.Config.ArrNotificationsEnabled = false;
        }

        if (duringLookup)
        {
            w.OnMeta = viewer =>
            {
                if (viewer.UserId == kid.UserId) Change();
                return Task.CompletedTask;
            };
        }
        else
        {
            w.Policy.Visibility = (who, input) =>
            {
                if (who == kid.UserId) Change();
                return Task.CompletedTask;
            };
        }

        await w.Decide(id, NotifyKind.Declined);
        await w.Service.DeliverRequestNoticesAsync(w.Rig.Arr.Now, default);
        Assert.Equal(0, w.Rows(kid, NotifyKind.Declined));
        if (change == "notifications_off")
        {
            // The notice is left for the next round (not consumed): told once notifications are back on.
            w.OnMeta = null;
            w.Policy.Visibility = null;
            w.Rig.Config.ArrNotificationsEnabled = true;
            await w.Step(true);
            Assert.Equal(1, w.Rows(kid, NotifyKind.Declined));
        }
        else
        {
            Assert.Equal(0L, w.Count("SELECT COUNT(*) FROM request_notices WHERE kind='declined'"));
        }
    }

    // A second administrator, Sam (asked after Jake: the administrators' order).
    private static StatusViewer SecondAdmin(World w)
    {
        var sam = w.Rig.Sam;
        w.Rig.Users.AdminIds.Add(sam.UserId);
        w.Rig.Users.Names[sam.UserId] = "Sam";
        w.Policy.People[sam.UserId] = new(sam.UserId, "Admin", true, true, true, true, "p1", "je", "inst", "g1", 1000, 7, 0, "{}");
        return sam;
    }

    [Theory]
    [InlineData("sight", false)]
    [InlineData("sight", true)]
    [InlineData("demoted", false)]
    public async Task AnAskIsDecidedForEveryAdministratorAfterEveryAdministratorsPreparation(string change, bool duringLookup)
    {
        // A new ask waiting for an OK: each administrator's view is prepared and the title looked up for them (awaited); the
        // administrators who are told are decided after all of it. Jake loses sight of the title (or his administrator
        // rights) while Sam's is prepared, or while Jake's own title lookup is awaited.
        using var w = await ReadyProvenanceAndWaitsTests.JeWorld();
        var admin = w.Rig.Admin;
        var sam = SecondAdmin(w);
        void Change()
        {
            if (change == "sight") w.Policy.Adjust = (user, input, facts) => user == admin.UserId ? facts with { Visible = false } : facts;
            else w.Rig.Users.AdminIds.Remove(admin.UserId);
        }

        if (duringLookup)
        {
            w.OnMeta = viewer =>
            {
                if (viewer.UserId == admin.UserId) Change();
                return Task.CompletedTask;
            };
        }
        else
        {
            w.Policy.Visibility = (who, input) =>
            {
                if (who == sam.UserId) Change();
                return Task.CompletedTask;
            };
        }

        await w.Ask(w.Rig.Kid, Keys[0], "kid-0");
        await w.Service.DeliverRequestNoticesAsync(w.Rig.Arr.Now, default);
        Assert.Equal(1, w.Rows(sam, NotifyKind.Approval));
        Assert.Equal(0, w.Rows(admin, NotifyKind.Approval));
    }

    [Fact]
    public async Task NoChangeTellsEveryAdministratorWhoCanSeeTheAsk()
    {
        // Control.
        using var w = await ReadyProvenanceAndWaitsTests.JeWorld();
        var sam = SecondAdmin(w);
        await w.Ask(w.Rig.Kid, Keys[0], "kid-0");
        await w.Service.DeliverRequestNoticesAsync(w.Rig.Arr.Now, default);
        Assert.Equal(1, w.Rows(sam, NotifyKind.Approval));
        Assert.Equal(1, w.Rows(w.Rig.Admin, NotifyKind.Approval));
    }

    [Theory]
    [InlineData("sight")]
    [InlineData("demoted")]
    [InlineData("none")]
    public async Task ARemindIsDecidedForEveryAdministratorAfterEveryAdministratorsPreparation(string change)
    {
        using var w = new World(await IntegrationNotificationsTests.Started(r => r.Request(1, 693134, r.Emma)), jeMode: false);
        w.Rig.Radarr.Queue.Add(FakeArr.RadarrQueueRow(2, 693134, "Dune Part Two", state: "importBlocked", status: "warning"));
        await w.Rig.Store.RefreshForEventAsync(w.Rig.Arr.Instance("RadarrZ").Id, ArrSnapshotKind.Queue, force: true);
        var admin = w.Rig.Admin;
        var sam = SecondAdmin(w);
        w.Policy.Visibility = (who, input) =>
        {
            if (who != sam.UserId) return Task.CompletedTask;
            if (change == "sight") w.Policy.Adjust = (user, i, facts) => user == admin.UserId ? facts with { Visible = false } : facts;
            else if (change == "demoted") w.Rig.Users.AdminIds.Remove(admin.UserId);
            return Task.CompletedTask;
        };
        Assert.Equal("ok", (await w.Service.RemindAsync(w.Rig.Emma, TitleKey.Parse(Dune)!, null, default)).Code);
        Assert.Equal(1, w.Rows(sam, NotifyKind.Remind));
        Assert.Equal(change == "none" ? 1 : 0, w.Rows(admin, NotifyKind.Remind));
    }

    [Theory]
    [InlineData("unfollowed")]
    [InlineData("none")]
    public async Task EachPersonsInterestInAnArrivalIsDecidedAfterTheLooksBeforeIt(string change)
    {
        // Ready: a title's interests are listed, then each person's look is awaited in turn. Whoever is looked at second is
        // judged by their interest as it is when their look runs, not as it was listed before the first look.
        using var w = new World(await IntegrationNotificationsTests.Started(r =>
        {
            r.Request(1, 693134, r.Emma);
            r.Request(2, 693134, r.Sam);
        }), jeMode: false);
        var emma = w.Rig.Emma;
        var sam = w.Rig.Sam;
        await w.Service.EvaluateAsync(new[] { Dune }, null, default);
        w.Rig.Arrive(Dune);
        var first = (Guid?)null;
        w.Rig.View.OnViewer = user =>
        {
            if (first != null || (user != emma.UserId && user != sam.UserId)) return;
            first = user;
            // The other one stops following what they asked for.
            if (change == "unfollowed") w.Rig.Prefs(user == emma.UserId ? sam : emma, p => p.AutoFollowRequests = false);
        };
        await w.Service.EvaluateAsync(new[] { Dune }, null, default);
        w.Rig.View.OnViewer = null;
        Assert.NotNull(first);
        var second = first == emma.UserId ? sam : emma;
        Assert.Equal(1, w.Rows(first == emma.UserId ? emma : sam, NotifyKind.Ready));
        Assert.Equal(change == "none" ? 1 : 0, w.Rows(second, NotifyKind.Ready));
    }

    [Fact]
    public async Task SeerrDeclinesArePreparedBeforeAnyIsDecided()
    {
        // Control (already prepare-then-decide): the kid hides the first decline's title while the second is prepared.
        using var w = new World(await IntegrationNotificationsTests.Started(), jeMode: false);
        var kid = w.Rig.Kid.UserId;
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(1);
        w.Rig.Seerr.Requests.Add(FakeSeerr.Request(7, "movie", 7100, 1, kid, w.Rig.Arr.Now.UtcDateTime, userName: "Kid"));
        w.Rig.Seerr.Requests.Add(FakeSeerr.Request(8, "movie", 7101, 1, kid, w.Rig.Arr.Now.UtcDateTime, userName: "Kid"));
        await w.Step(false);
        w.Rig.Seerr.Requests.Clear();
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(1);
        w.Rig.Seerr.Requests.Add(FakeSeerr.Request(7, "movie", 7100, 3, kid, w.Rig.Arr.Now.UtcDateTime.AddMinutes(-1), w.Rig.Arr.Now.UtcDateTime, userName: "Kid"));
        w.Rig.Seerr.Requests.Add(FakeSeerr.Request(8, "movie", 7101, 3, kid, w.Rig.Arr.Now.UtcDateTime.AddMinutes(-1), w.Rig.Arr.Now.UtcDateTime, userName: "Kid"));
        var prepared = 0;
        w.Policy.Visibility = (who, input) =>
        {
            if (who == kid && ++prepared == 2) w.Privacy.Rules[kid] = TitleRules("movie:tmdb:7100");
            return Task.CompletedTask;
        };
        await w.Step(false);
        await w.Step(false);
        Assert.Equal(2, prepared);
        Assert.Equal(new[] { "movie:tmdb:7101" }, w.Rig.Inbox(w.Rig.Kid).Where(r => r.Kind == NotifyKind.Declined).Select(r => r.Key));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task TheAdministratorsOutageAlertIsDecidedOnTheSettingsAfterTheAttentionRead(bool lowered)
    {
        // The administrators' checks await the admin tools' Needs attention read (cold snapshots: the arr is called); the
        // outage threshold is the one set when that read is back. Radarr has been down for 5 minutes; the threshold is 10, and
        // the administrator lowers it to 1 while the read is under way.
        using var rig = new IntegrationNotificationsTests.Rig();
        var radarr = rig.Arr.Hosts["radarr.lan"];
        var instance = rig.Arr.Instance("RadarrZ");
        radarr.FailWith = 503;
        rig.Config.ArrNotifyAdminDownMinutes = 10;
        rig.NotifyStore.SetMeta("down:" + instance.Id, rig.Arr.Now.AddMinutes(-5).ToUnixTimeMilliseconds().ToString(System.Globalization.CultureInfo.InvariantCulture));
        var called = false;
        radarr.Before = (path, ct) =>
        {
            called = true;
            if (lowered) rig.Config.ArrNotifyAdminDownMinutes = 1;
            return Task.CompletedTask;
        };
        await rig.Service.AdminChecksAsync(default);
        Assert.True(called);
        Assert.Equal(lowered ? 1 : 0, rig.Inbox(rig.Admin).Count(n => n.Kind == NotifyKind.InstanceDown));
    }
}
