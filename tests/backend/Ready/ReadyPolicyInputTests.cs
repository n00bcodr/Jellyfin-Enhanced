using System.Collections.Concurrent;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using World = JE.Tests.ReadyProvenanceAndWaitsTests.World;

namespace JE.Tests;

/// <summary>
/// 4f round 7, rules 2 and 3, through the real NotificationService, RequestLedger, RequestService, NotifyDispatcher and
/// NotifyController over a real acquire.db:
/// <list type="bullet">
/// <item><description>Every policy input travels end to end: an outcome alert (declined, OK'd; Seerr and Jellyfin Enhanced;
/// told at once, held for quiet hours, or queued while evidence can't be read) is judged by the request's own edition (4K or
/// standard), part and routing, at production, in the wait queue, at every send and in the bell.</description></item>
/// <item><description>Missing evidence waits: an absent title's rating not verified yet for a parental limit (cold caches, a
/// failed lookup, more than a round's preparation) is never a refusal and is never consumed; it is prepared and decided
/// later. Preparation and consumption share one bound.</description></item>
/// </list>
/// </summary>
[Collection("Plugin singleton")]
public class ReadyPolicyInputTests
{
    private const string Dune = "movie:tmdb:693134";

    private static ReadyHides TitleRule(string key) => new(Array.Empty<Guid>(), Array.Empty<Guid>(), new[] { key });

    // The kid may open only the 4K libraries: a title nobody has yet is visible to them only as a 4K request (its edition
    // decides the instance, and so the libraries, it would land in).
    private static void FourKOnly(World w)
    {
        var kid = w.Rig.Kid.UserId;
        w.Policy.People[kid] = w.Policy.People[kid] with { Can4k = true };
        w.Policy.Adjust = (user, input, facts) => user == kid && input.Variant != "4k" ? facts with { Visible = false } : facts;
    }

    // Cold caches: the kid's view of an absent title is unverified until its rating was prepared for them (each preparation
    // succeeds unless Fail says otherwise); a definite answer only after that.
    private sealed class Ratings
    {
        public ConcurrentDictionary<string, int> Prepared { get; } = new(StringComparer.Ordinal);
        public Func<string, bool>? Fail { get; set; }
        public int Calls;

        public void Install(World w, params Guid[] users)
        {
            w.Policy.Visibility = (who, input) =>
            {
                Interlocked.Increment(ref Calls);
                if (users.Contains(who) && Fail?.Invoke(input.Key) != true) Prepared[who.ToString("N") + input.Key] = 1;
                return Task.CompletedTask;
            };
            var inner = w.Policy.Adjust;
            w.Policy.Adjust = (who, input, facts) =>
            {
                facts = inner?.Invoke(who, input, facts) ?? facts;
                return users.Contains(who) && facts.Visible && !Prepared.ContainsKey(who.ToString("N") + input.Key) ? facts with { Visible = false, VisibilityUnknown = true } : facts;
            };
        }
    }

    // Quiet hours from an hour ago to an hour from now (UTC): held sends come due two hours on.
    private static void Quiet(World w, StatusViewer who, bool on)
        => w.Rig.Prefs(who, p =>
        {
            p.QuietHours = on;
            p.QuietFrom = w.Rig.Arr.Now.UtcDateTime.AddHours(-1).ToString("HH:mm", System.Globalization.CultureInfo.InvariantCulture);
            p.QuietTo = w.Rig.Arr.Now.UtcDateTime.AddHours(1).ToString("HH:mm", System.Globalization.CultureInfo.InvariantCulture);
            p.UtcOffsetMinutes = 0;
        });

    private static JsonElement BellRow(World w, StatusViewer who, string kind)
        => Assert.Single(w.Bell(who.UserId).EnumerateArray(), r => r.GetProperty("kind").GetString() == kind);

    // A Seerr request of the kid's, seen pending first, then declined (as Seerr's list changes).
    private static async Task SeerrDecline(World w, int id, int tmdb, bool is4k)
    {
        var kid = w.Rig.Kid.UserId;
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(1);
        w.Rig.Seerr.Requests.Add(FakeSeerr.Request(id, "movie", tmdb, 1, kid, w.Rig.Arr.Now.UtcDateTime, is4k: is4k, userName: "Kid"));
        await w.Step(false);
        w.Rig.Seerr.Requests.RemoveAll(r => (int)r["id"]! == id);
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(1);
        w.Rig.Seerr.Requests.Add(FakeSeerr.Request(id, "movie", tmdb, 3, kid, w.Rig.Arr.Now.UtcDateTime.AddMinutes(-1), w.Rig.Arr.Now.UtcDateTime, is4k: is4k, userName: "Kid"));
    }

    // ================================================================== rule 2: the edition travels end to end

    [Theory]
    [InlineData("now")]
    [InlineData("held")]
    [InlineData("queued")]
    public async Task ASeerr4kDeclineForA4kOnlyRequesterIsJudgedAsA4kRequestEverywhere(string how)
    {
        // 4f-r6-behaviour-1: the decline was judged by the STANDARD target's libraries (no variant in its payload).
        using var w = new World(await IntegrationNotificationsTests.Started(), jeMode: false);
        var kid = w.Rig.Kid;
        FourKOnly(w);
        if (how == "held") Quiet(w, kid, true);
        if (how == "queued") w.Privacy.Rules[kid.UserId] = null;
        await SeerrDecline(w, 7, 693134, is4k: true);
        await w.Step(true);
        await w.Step(true);
        if (how == "held")
        {
            Assert.Equal("4k", BellRow(w, kid, NotifyKind.Declined).GetProperty("params").GetProperty("variant").GetString());
            Assert.False(w.Told("said no"));
            w.Rig.Arr.Now = w.Rig.Arr.Now.AddHours(2);
            await w.Dispatcher.RunOnceAsync(default);
        }
        else if (how == "queued")
        {
            Assert.Equal(0, w.Rows(kid, NotifyKind.Declined));
            w.Privacy.Rules.Remove(kid.UserId);
            w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(6);
            await w.Step(true);
        }

        Assert.Equal(1, w.Rows(kid, NotifyKind.Declined));
        Assert.True(w.Told("said no to Dune"));
        Assert.Equal(Dune, BellRow(w, kid, NotifyKind.Declined).GetProperty("key").GetString());
    }

    [Theory]
    [InlineData("now")]
    [InlineData("held")]
    [InlineData("queued")]
    public async Task AJe4kDeclineForA4kOnlyRequesterIsJudgedAsA4kRequestEverywhere(string how)
    {
        using var w = await ReadyProvenanceAndWaitsTests.JeWorld();
        var kid = w.Rig.Kid;
        FourKOnly(w);
        var made = await w.Requests!.CreateAsync(kid.UserId, new("kid-dune-4k", new MutationInput { Key = Dune, Variant = "4k" }), default);
        Assert.NotNull(made.RequestId);
        if (how == "held") Quiet(w, kid, true);
        if (how == "queued") w.Privacy.Rules[kid.UserId] = null;
        await w.Decide(made.RequestId!, NotifyKind.Declined);
        await w.Step(true);
        if (how == "held")
        {
            Assert.False(w.Told("said no"));
            w.Rig.Arr.Now = w.Rig.Arr.Now.AddHours(2);
            await w.Dispatcher.RunOnceAsync(default);
        }
        else if (how == "queued")
        {
            Assert.Equal(0, w.Rows(kid, NotifyKind.Declined));
            w.Privacy.Rules.Remove(kid.UserId);
            w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(6);
            await w.Step(true);
        }

        Assert.Equal(1, w.Rows(kid, NotifyKind.Declined));
        Assert.True(w.Told("said no to Dune"));
        Assert.Equal(Dune, BellRow(w, kid, NotifyKind.Declined).GetProperty("key").GetString());
    }

    [Fact]
    public async Task AStandardDeclineForA4kOnlyRequesterIsToldNowhere()
    {
        // Control: the edition is honoured both ways (the standard libraries stay closed to them).
        using var w = new World(await IntegrationNotificationsTests.Started(), jeMode: false);
        var kid = w.Rig.Kid;
        FourKOnly(w);
        await SeerrDecline(w, 7, 693134, is4k: false);
        await w.Step(true);
        await w.Step(true);
        Assert.Equal(0, w.Rows(kid, NotifyKind.Declined));
        Assert.False(w.Told("Dune"));
        Assert.Equal(0L, w.Count("SELECT COUNT(*) FROM alert_waits"));
    }

    [Theory]
    [InlineData("now")]
    [InlineData("held")]
    public async Task AnOkRoutedByTheAdministratorIsJudgedByWhereItWasRouted(string how)
    {
        // The administrator OK'd the kid's request into the kids' instance (the only one whose libraries the kid may open):
        // the OK is judged by that routing, as the kid's Requests page judges its card, not by the default target.
        using var w = await ReadyProvenanceAndWaitsTests.JeWorld();
        var kid = w.Rig.Kid;
        var id = await w.Ask(kid, Dune, "kid-dune");
        w.Policy.Adjust = (user, input, facts) => user == kid.UserId && input.InstanceId != "kids" ? facts with { Visible = false } : facts with { InstanceId = input.InstanceId ?? facts.InstanceId };
        if (how == "held") Quiet(w, kid, true);
        var routed = new MutationInput { Key = Dune, InstanceId = "kids" };
        var outcome = await w.Requests!.ApproveAsync(id, w.Rig.Admin.UserId, new ApproveRequest(routed), default);
        Assert.Equal(200, outcome.HttpStatus);
        await w.Step(true);
        if (how == "held")
        {
            w.Rig.Arr.Now = w.Rig.Arr.Now.AddHours(2);
            await w.Dispatcher.RunOnceAsync(default);
        }

        Assert.Equal(1, w.Rows(kid, NotifyKind.Approved));
        Assert.True(w.Told("OK'd Dune"));
        Assert.Equal(Dune, BellRow(w, kid, NotifyKind.Approved).GetProperty("key").GetString());
    }

    // ================================================================== rule 3: missing evidence waits

    [Fact]
    public async Task ThreeHundredAndTenSeerrDeclinesWithColdCachesAreAllToldAndNoneIsRefused()
    {
        // 4f-r6-behaviour-2: preparation took 300 a round, consumption all: the rest were refused and marked seen.
        using var w = new World(await IntegrationNotificationsTests.Started(), jeMode: false);
        var kid = w.Rig.Kid;
        // Cold for the kid (their declines) and for the administrator (the asks waiting for an OK).
        var ratings = new Ratings();
        ratings.Install(w, kid.UserId, w.Rig.Admin.UserId);
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(1);
        for (var i = 0; i < 310; i++) w.Rig.Seerr.Requests.Add(FakeSeerr.Request(100 + i, "movie", 5000 + i, 1, kid.UserId, w.Rig.Arr.Now.UtcDateTime, userName: "Kid"));
        await w.Step(false);
        await w.Step(false);
        // The administrator's asks: every one told (310, over two rounds), none left out for an unprepared rating.
        Assert.Equal(310, w.Rows(w.Rig.Admin, NotifyKind.Approval));
        w.Rig.Seerr.Requests.Clear();
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(1);
        for (var i = 0; i < 310; i++)
            w.Rig.Seerr.Requests.Add(FakeSeerr.Request(100 + i, "movie", 5000 + i, 3, kid.UserId, w.Rig.Arr.Now.UtcDateTime.AddMinutes(-1), w.Rig.Arr.Now.UtcDateTime, userName: "Kid"));
        for (var i = 0; i < 3; i++) await w.Step(false);
        Assert.Equal(310, w.Rows(kid, NotifyKind.Declined));
        Assert.Equal(0L, w.Count("SELECT COUNT(*) FROM alert_waits"));
    }

    [Fact]
    public async Task ThreeHundredAndTenJeDeclinesWithColdCachesAreAllTold()
    {
        using var w = await ReadyProvenanceAndWaitsTests.JeWorld();
        var kid = w.Rig.Kid;
        // Asked and declined one by one (a person has at most a hundred waiting); the notices are told in later rounds, by
        // when every rating has gone cold.
        for (var i = 0; i < 310; i++) await w.Decide(await w.Ask(kid, "movie:tmdb:" + (5000 + i), "kid-" + i), NotifyKind.Declined);
        var ratings = new Ratings();
        ratings.Install(w, kid.UserId);
        for (var i = 0; i < 5; i++) await w.Step(false);
        Assert.Equal(310, w.Rows(kid, NotifyKind.Declined));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ADeclineWhoseRatingLookupFailsWaitsAndIsToldWhenItWorks(bool seerr)
    {
        using var w = seerr ? new World(await IntegrationNotificationsTests.Started(), jeMode: false) : await ReadyProvenanceAndWaitsTests.JeWorld();
        var kid = w.Rig.Kid;
        var ratings = new Ratings { Fail = _ => true };
        string? id = seerr ? null : await w.Ask(kid, Dune, "kid-dune");
        ratings.Install(w, kid.UserId);
        if (seerr) await SeerrDecline(w, 7, 693134, is4k: false);
        else await w.Decide(id!, NotifyKind.Declined);
        await w.Step(true);
        await w.Step(true);
        Assert.Equal(0, w.Rows(kid, NotifyKind.Declined));
        Assert.Equal(1L, w.Count("SELECT COUNT(*) FROM alert_waits"));

        // The lookup works again; nothing else changes (no new revision, no new notice).
        ratings.Fail = null;
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(6);
        await w.Step(true);
        Assert.Equal(1, w.Rows(kid, NotifyKind.Declined));
        Assert.True(w.Told("said no to Dune"));
    }

    [Fact]
    public async Task AHeldDeclineWhoseRatingWentColdIsPreparedAndSentNotSuppressed()
    {
        using var w = await ReadyProvenanceAndWaitsTests.JeWorld();
        var kid = w.Rig.Kid;
        var id = await w.Ask(kid, Dune, "kid-dune");
        var ratings = new Ratings();
        ratings.Install(w, kid.UserId);
        Quiet(w, kid, true);
        await w.Decide(id, NotifyKind.Declined);
        await w.Step(true);
        var row = Assert.Single(w.Rig.Inbox(kid), n => n.Kind == NotifyKind.Declined);

        // The rating facts expired meanwhile (a restart, the cache's lifetime): the send prepares them before deciding.
        ratings.Prepared.Clear();
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddHours(2);
        await w.Dispatcher.RunOnceAsync(default);
        Assert.All(w.Deliveries(row.Id), d => Assert.Equal("sent", d.Status));
        Assert.True(w.Told("said no to Dune"));
    }

    [Fact]
    public async Task AHeldDeclineWhoseRatingCantBeVerifiedWaitsInsteadOfBeingSuppressed()
    {
        using var w = await ReadyProvenanceAndWaitsTests.JeWorld();
        var kid = w.Rig.Kid;
        var id = await w.Ask(kid, Dune, "kid-dune");
        var ratings = new Ratings();
        ratings.Install(w, kid.UserId);
        Quiet(w, kid, true);
        await w.Decide(id, NotifyKind.Declined);
        await w.Step(true);
        var row = Assert.Single(w.Rig.Inbox(kid), n => n.Kind == NotifyKind.Declined);
        ratings.Prepared.Clear();
        ratings.Fail = _ => true;
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddHours(2);
        await w.Dispatcher.RunOnceAsync(default);
        Assert.All(w.Deliveries(row.Id), d => Assert.Equal("pending", d.Status));

        ratings.Fail = null;
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(6);
        await w.Dispatcher.RunOnceAsync(default);
        Assert.All(w.Deliveries(row.Id), d => Assert.Equal("sent", d.Status));
    }

    [Fact]
    public async Task ABellRowWhoseRatingWentColdIsWithheldOnlyUntilItIsPrepared()
    {
        using var w = await ReadyProvenanceAndWaitsTests.JeWorld();
        var kid = w.Rig.Kid;
        var id = await w.Ask(kid, Dune, "kid-dune");
        var ratings = new Ratings();
        ratings.Install(w, kid.UserId);
        await w.Decide(id, NotifyKind.Declined);
        await w.Step(false);
        Assert.Equal(Dune, BellRow(w, kid, NotifyKind.Declined).GetProperty("key").GetString());

        // Cold again: this read withholds the title (never consumed); the next round prepares it; the next read names it.
        ratings.Prepared.Clear();
        Assert.Equal(JsonValueKind.Null, BellRow(w, kid, NotifyKind.Declined).GetProperty("key").ValueKind);
        await w.Step(false);
        Assert.Equal(Dune, BellRow(w, kid, NotifyKind.Declined).GetProperty("key").GetString());
    }

    [Fact]
    public async Task ADefiniteParentalRefusalIsStillARefusal()
    {
        // Control: a verified rating the limit refuses is not "unknown": told nowhere, nothing waits.
        using var w = await ReadyProvenanceAndWaitsTests.JeWorld();
        var kid = w.Rig.Kid;
        var id = await w.Ask(kid, Dune, "kid-dune");
        w.Policy.Adjust = (user, input, facts) => user == kid.UserId && input.Key == Dune ? facts with { Visible = false } : facts;
        await w.Decide(id, NotifyKind.Declined);
        await w.Step(true);
        Assert.Equal(0, w.Rows(kid, NotifyKind.Declined));
        Assert.Equal(0L, w.Count("SELECT COUNT(*) FROM alert_waits"));
        Assert.Equal(0L, w.Count("SELECT COUNT(*) FROM request_notices"));
    }

    [Fact]
    public async Task AHiddenTitleIsStillWithheldWhateverItsRating()
    {
        using var w = await ReadyProvenanceAndWaitsTests.JeWorld();
        var kid = w.Rig.Kid;
        var id = await w.Ask(kid, Dune, "kid-dune");
        w.Privacy.Rules[kid.UserId] = TitleRule(Dune);
        await w.Decide(id, NotifyKind.Declined);
        await w.Step(true);
        Assert.Equal(0, w.Rows(kid, NotifyKind.Declined));
        Assert.False(w.Told("Dune"));
    }
}
