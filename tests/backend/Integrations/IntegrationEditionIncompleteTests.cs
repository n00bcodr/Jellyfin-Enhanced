using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Jellyfin.Plugin.JellyfinEnhanced.Services.AutoRequest;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Globalization;
using Moq;

namespace JE.Tests;

/// <summary>
/// A copy lookup that stops at its work ceiling is incomplete, not proof of absence (D53, edition round 7). Pages may
/// show it as "not found" (never cached, never Ready or fulfilled), but nothing that asserts absence acts on it: the
/// absent-title rules of requests, Discover and status by key, "since removed" and "declined", the recipes and
/// collection gaps, and a notification's "can no longer open". What the scan did see is acted on: a copy the viewer
/// can't open keeps the title hidden from them, one they can open counts as present.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEditionIncompleteTests
{
    private static readonly TitleKey Matrix = TitleKey.Parse("movie:tmdb:603")!;

    /// <summary>
    /// The native rows of one title, by shape. <c>absent</c>: none (proven absent). <c>hidden</c>: one live copy the
    /// viewer can't open, nothing else (complete). <c>hiddenFirst</c> / <c>visibleFirst</c>: that copy (hidden, or one they
    /// can open) first, then rows retained from removed paths past the work ceiling. <c>nothingSeen</c>: only retained
    /// rows past the ceiling. <c>visible</c>: one copy they can open (complete).
    /// </summary>
    internal static List<BaseItem> Shape(IntegrationEditionOrphanTests.Library l, string shape, string id = "603")
    {
        var past = shape is "hiddenFirst" or "visibleFirst" or "nothingSeen";
        var rows = IntegrationEditionBoundTests.Rows(l, past ? IntegrationEditionBoundTests.PastTheCeiling : 0, live: false, id: id);
        if (shape is "hidden" or "hiddenFirst" or "visibleFirst" or "visible") rows.Insert(0, l.Hd);
        if (shape is "hidden" or "hiddenFirst") l.Denied.Add(l.Hd.Id);
        else l.Denied.Remove(l.Hd.Id);
        return rows;
    }

    /// <summary>The real request policy over a member's Jellyfin, The Matrix routed to the real view's lookup.</summary>
    private sealed class PolicyRig : IDisposable
    {
        public FakeArr Arr { get; } = new();
        public FakeJellyfinView Jf { get; } = new();
        public StatusViewer Member { get; }
        public RequestPolicy Policy { get; }
        public RequestService Service { get; }
        public RequestLedger Ledger { get; }
        private readonly ArrStateStore _store;
        private readonly AcquireDatabase _db;

        public PolicyRig(IntegrationEditionOrphanTests.Library l)
        {
            Arr.Add("movies.invalid", "Radarr");
            Arr.Configure(("Movies", ArrKind.Radarr, "http://movies.invalid", "test-key"));
            var config = Arr.Plugin.Plugin.Configuration;
            config.ArrIntegrationEnabled = true; config.ArrPhase1Enabled = true; config.ArrPhase3Enabled = true; config.ArrRequestBackend = "je"; config.ArrRequestDefaultRole = "Member";
            Member = Jf.AddUser(false);
            Jf.CopiesFrom = (key, viewer, aliases) => key.Title.ToString() == Matrix.ToString() ? l.View.Copies(key, viewer, aliases) : null;
            Jf.Routed = l.View;
            var users = new Mock<IUserManager>(); users.Setup(u => u.GetUserById(Member.UserId)).Returns((User)Member.Handle!);
            var server = new Mock<IServerConfigurationManager>(); server.SetupGet(s => s.Configuration).Returns(new ServerConfiguration { MetadataCountryCode = "US" });
            var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response()));
            var parental = new SeerrParentalFilter(transport, users.Object, new Mock<ILocalizationManager>().Object, server.Object, Arr.Plugin.Core.Logger);
            _store = Arr.Store();
            var libraries = new ArrInstanceLibraries(_store, new FakeLibraryAccess()) { Parental = parental };
            var aliases = new TitleAliases(_store, null);
            Policy = new RequestPolicy(Jf, _store, libraries, aliases, parental, Arr.Factory, new UnavailableRequestBackend());
            _db = new AcquireDatabase(Path.Combine(Arr.Plugin.Core.Root, "incomplete-" + Guid.NewGuid().ToString("N") + ".db"));
            Ledger = new RequestLedger(_db);
            Service = new RequestService(Ledger, Policy, Jf, new ArrChangeFeed(), aliases);
        }

        public void Dispose()
        {
            _db.Dispose();
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            _store.Dispose();
            Arr.Dispose();
        }
    }

    [Theory]
    [InlineData("hiddenFirst", false)] // the reviewers' case: the hidden copy seen first, then 10,001 retained rows
    [InlineData("nothingSeen", false)] // not proven absent: the absent-title rule doesn't apply
    [InlineData("visibleFirst", true)] // a copy they can open was seen: present
    [InlineData("absent", true)]       // control: a proven absence still takes the absent-title rule
    [InlineData("hidden", false)]      // control: a complete lookup with a hidden copy
    [InlineData("visible", true)]      // control
    public async Task RequestPolicyTakesTheAbsentTitleRuleOnlyForAProvenAbsence(string shape, bool allowed)
    {
        using var l = new IntegrationEditionOrphanTests.Library();
        using var rig = new PolicyRig(l);
        Shape(l, shape);
        var facts = rig.Policy.Evaluate(rig.Member.UserId, IntegrationRequestLedgerTests.Movie());
        Assert.Equal(allowed, facts.Visible);
        Assert.Equal(allowed ? null : "not_visible_to_user", facts.Refusal);
        var outcome = await rig.Service.CreateAsync(rig.Member.UserId, new CreateRequest(Guid.NewGuid().ToString("N"), IntegrationRequestLedgerTests.Movie()), default);
        Assert.Equal(allowed ? 201 : 403, outcome.HttpStatus);
        Assert.Equal(allowed ? 1 : 0, rig.Ledger.List(rig.Member.UserId, false).Count);
    }

    [Theory]
    [InlineData("hiddenFirst", false, false)] // the reviewers' case: the hidden copy keeps the title hidden from the kid
    [InlineData("nothingSeen", false, false)] // not proven absent: hidden (fails closed)
    [InlineData("visibleFirst", true, false)] // seen and theirs: shown; the page still reads it as not found for that answer
    [InlineData("absent", true, false)]       // control: an absent title they may see by its rating
    [InlineData("hidden", false, false)]      // control
    [InlineData("visible", true, true)]       // control
    public async Task DiscoverHidesATitleFromAKidUnlessItsAbsenceIsProvenOrTheirCopyWasSeen(string shape, bool shown, bool inLibrary)
    {
        using var l = new IntegrationEditionOrphanTests.Library();
        using var rig = new IntegrationRequestDiscoverTests.Rig();
        rig.Tmdb["trending/movie/week"] = IntegrationRequestDiscoverTests.Page(IntegrationRequestDiscoverTests.Movie(603, "The Matrix"), IntegrationRequestDiscoverTests.Movie(1, "One"));
        var kid = rig.AddLimitedKid();
        rig.R.View.CopiesFrom = (key, viewer, aliases) => key.Title.ToString() == Matrix.ToString() ? l.View.Copies(key, viewer, aliases) : null;
        rig.R.View.Routed = l.View;
        Shape(l, shape);
        var (status, body, _) = await rig.Discover(kid, "trending");
        Assert.Equal(200, status);
        var cards = body.GetProperty("answer").GetProperty("results").EnumerateArray().ToList();
        Assert.Contains(cards, c => c.GetProperty("key").GetString() == "movie:tmdb:1");
        var card = cards.SingleOrDefault(c => c.GetProperty("key").GetString() == Matrix.ToString());
        Assert.Equal(shown, card.ValueKind == JsonValueKind.Object);
        if (shown) Assert.Equal(inLibrary, card.GetProperty("inLibrary").GetBoolean());
    }

    [Theory]
    [InlineData("visibleFirst", 1)] // a copy the kid can open was seen: they may read the title by key
    [InlineData("hiddenFirst", 0)]
    [InlineData("nothingSeen", 0)]
    [InlineData("absent", 0)]       // control: no verified rating for an absent title
    [InlineData("visible", 1)]      // control
    public async Task StatusByKeyActsOnTheCopiesTheLookupSaw(string shape, int items)
    {
        using var l = new IntegrationEditionOrphanTests.Library();
        using var lab = new IntegrationRequestArrivalsTests.Lab(fourK: true, jellyfin: l.View);
        ((User)lab.Kid.Handle!).MaxParentalRatingScore = 10;
        var kid = l.Person(lab.Kid); l.Person(lab.Admin); l.Person(lab.Emma);
        Assert.True(kid.HasParentalLimit);
        IntegrationEditionBoundTests.Rows(l, 0, live: false);
        await lab.Warm();
        Shape(l, shape);
        lab.Status.Cache.Clear();
        using var doc = JsonDocument.Parse((await lab.Status.ForKeyDetailAsync(kid, Matrix, default)).Json);
        Assert.Equal(items, doc.RootElement.GetProperty("items").GetArrayLength());
    }

    [Fact]
    public async Task AFulfilled4kRequestWhoseCopyLiesPastTheCeilingIsNeverSinceRemoved()
    {
        using var l = new IntegrationEditionOrphanTests.Library();
        using var lab = new IntegrationRequestArrivalsTests.Lab(fourK: true, jellyfin: l.View);
        var emma = l.Person(lab.Emma); l.Person(lab.Admin); l.Person(lab.Kid);
        var rows = IntegrationEditionBoundTests.Rows(l, 0, live: false);
        await lab.Warm();
        lab.Policy.Adjust = (_, _, policy) => policy with { Can4k = true };
        var request = await lab.Ask(lab.Emma, new MutationInput { Key = Matrix.ToString(), Variant = "4k" });
        await lab.Outbox.TickAsync(default);
        // The 4K copy arrives and the request is fulfilled.
        rows.Add(l.Uhd);
        Assert.Equal(1, await lab.Fulfilment.CheckAsync(new[] { Matrix.ToString() }, default));
        Assert.Equal("fulfilled", lab.Ledger.Find(request)!.Status);
        // Radarr lets go of it (the files stay), and the copy now sorts behind 10,001 retained rows.
        foreach (var host in new[] { "radarr.lan", "radarr4k.lan" }) { lab.Arr.Hosts[host].Movies.Clear(); lab.Arr.Hosts[host].Queue.Clear(); }
        foreach (var name in new[] { "RadarrZ", "Radarr4kZ" })
        {
            Assert.True((await lab.Store.RefreshLibraryNowAsync(lab.Arr.Instance(name), default)).Ok);
            lab.Store.RequestRefresh(lab.Arr.Instance(name).Id, ArrSnapshotKind.Queue);
        }
        lab.Arr.Now += TimeSpan.FromHours(1);
        await lab.Warm();
        rows = IntegrationEditionBoundTests.Rows(l, IntegrationEditionBoundTests.PastTheCeiling);
        lab.Status.Cache.Clear();
        var row = (await lab.Page(emma))[Matrix.ToString()];
        Assert.NotEqual(HubGroup.Removed, row.GetProperty("group").GetString());
        Assert.NotEqual(StatusReasonCode.Removed, row.GetProperty("status").GetProperty("reason").GetProperty("code").GetString());
        var scoped = (await lab.Status.ComposeForAsync(emma, new[] { Matrix }, null, default)).Single().Status;
        Assert.NotEqual(StatusReasonCode.Removed, scoped.Reason.Code);
        Assert.Equal(0, lab.Status.Cache.Count);
        Assert.Equal("fulfilled", lab.Ledger.Find(request)!.Status);
        // Control: once it is proven gone, it says so.
        rows.Clear();
        lab.Status.Cache.Clear();
        row = (await lab.Page(emma))[Matrix.ToString()];
        Assert.Equal((HubGroup.Removed, StatusReasonCode.Removed), (row.GetProperty("group").GetString(), row.GetProperty("status").GetProperty("reason").GetProperty("code").GetString()));
    }

    [Fact]
    public async Task ADeclinedRequestIsNotReadAsDeclinedOverACopyTheLookupCouldNotFinish()
    {
        using var l = new IntegrationEditionOrphanTests.Library();
        using var lab = new IntegrationRequestArrivalsTests.Lab(jellyfin: l.View);
        var kid = l.Person(lab.Kid); l.Person(lab.Admin); l.Person(lab.Emma);
        var rows = IntegrationEditionBoundTests.Rows(l, 0, live: false);
        lab.Radarr.Movies.Clear(); lab.Radarr.Queue.Clear();
        await lab.Warm();
        // A kid's ask waits for an OK, and is declined.
        var request = await lab.Ask(lab.Kid, new MutationInput { Key = Matrix.ToString() });
        Assert.Equal(200, (await lab.Requests.DeclineAsync(request, lab.Admin.UserId, "Not now", default)).HttpStatus);
        async Task<TitleStatus> Status() => (await lab.Status.ComposeForAsync(kid, new[] { Matrix }, null, default)).Single().Status;
        // Control: proven absent, it reads as declined.
        lab.Status.Cache.Clear();
        Assert.Equal(StatusReasonCode.Declined, (await Status()).Reason.Code);
        // The copy behind the work ceiling: not "declined" (nor anything else that says it isn't here because of that).
        rows = IntegrationEditionBoundTests.Rows(l, IntegrationEditionBoundTests.PastTheCeiling);
        lab.Status.Cache.Clear();
        Assert.NotEqual(StatusReasonCode.Declined, (await Status()).Reason.Code);
        rows.Clear(); rows.Add(l.Hd);
        lab.Status.Cache.Clear();
        Assert.Equal(StatusStage.Ready, (await Status()).Stage);
    }

    [Theory]
    [InlineData("visibleFirst", true)] // seen and theirs: in the library, the recipe asks nothing
    [InlineData("hiddenFirst", null)]  // not proven that none is theirs: decided on the next run
    [InlineData("nothingSeen", null)]
    [InlineData("absent", false)]      // control
    [InlineData("hidden", false)]      // control: only a copy they can't open
    [InlineData("visible", true)]      // control
    public async Task TheRecipesActOnACopyTheLookupSawAndWaitOtherwise(string shape, bool? inLibrary)
    {
        using var l = new IntegrationEditionOrphanTests.Library();
        using var lab = new IntegrationRequestArrivalsTests.Lab(fourK: true, jellyfin: l.View);
        var viewer = l.Person(lab.Emma); l.Person(lab.Admin); l.Person(lab.Kid);
        Shape(l, shape);
        var recorder = new AutoRequestRecorder(lab.Requests, l.View, null, () => lab.Arr.Now);
        Assert.Equal(inLibrary, recorder.InLibrary(Matrix, viewer.UserId));
        await Task.CompletedTask;
    }

    [Theory]
    [InlineData("visibleFirst", 1, 0)] // seen and theirs: they have it
    [InlineData("hiddenFirst", 0, 0)]  // never offered as missing: a hidden copy was seen
    [InlineData("nothingSeen", 0, 0)]  // never offered as missing: not proven absent
    [InlineData("absent", 0, 1)]       // control
    [InlineData("hidden", 0, 0)]       // control
    [InlineData("visible", 1, 0)]      // control
    public async Task CollectionGapsOfferOnlyMoviesProvenAbsent(string shape, int have, int missing)
    {
        using var l = new IntegrationEditionOrphanTests.Library();
        var person = new FakeJellyfinView().AddUser(false);
        var viewer = l.Person(person);
        Shape(l, shape);
        var box = Guid.NewGuid();
        const string body = "{\"id\":10,\"parts\":[{\"id\":603,\"title\":\"The Matrix\",\"release_date\":\"1999-03-31\"}]}";
        var gaps = new CollectionGapsService(l.View, (_, id) => id == box ? new BoxSetRef(id, 10) : null, null, null,
            (_, _, _) => Task.FromResult<string?>(body), (_, _, _) => Task.FromResult(true), () => new DateTimeOffset(2026, 10, 19, 0, 0, 0, TimeSpan.Zero));
        var result = (await gaps.ForCollectionAsync(viewer, box, null, default)).Gaps!;
        Assert.Equal((have, missing), (result.Have, result.Missing.Count));
    }

    [Theory]
    [InlineData("visibleFirst", 1, 0)] // a copy the recipient can open was seen: the alert goes out
    [InlineData("hiddenFirst", 0, 1)]  // not proven they can't: it waits (never suppressed on this read)
    [InlineData("nothingSeen", 0, 1)]
    [InlineData("absent", 0, 0)]       // control: proven gone for them: suppressed
    public async Task AReadyAlertGoesOutOnASeenCopyAndWaitsOnAnUnfinishedLookup(string shape, int sent, int pending)
    {
        using var l = new IntegrationEditionOrphanTests.Library();
        using var rig = await IntegrationNotificationsTests.Started();
        rig.Phones(rig.Emma);
        const string key = "movie:tmdb:693134";
        Shape(l, shape, id: "693134");
        rig.View.CopiesFrom = (k, viewer, aliases) => k.Title.ToString() == key ? l.View.Copies(k, viewer, aliases) : null;
        rig.View.Routed = l.View;
        rig.NotifyStore.Add(rig.Emma.UserId, "ready|" + key, NotifyKind.Ready, key, null, new Dictionary<string, string> { ["title"] = "Dune: Part Two" },
            new[] { (NotifyChannel.Ntfy, rig.Arr.Now) }, rig.Arr.Now);
        await rig.Dispatcher.RunOnceAsync(default);
        Assert.Equal(sent, rig.Pushes.Count);
        Assert.Equal(pending, rig.NotifyStore.DeliveryStats(rig.Arr.Now).Pending);
    }
}
