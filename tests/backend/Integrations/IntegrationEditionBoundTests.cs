using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.AutoRequest;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

/// <summary>
/// A copy lookup that reaches its scan bound (D53, edition round 6). Only rows the viewer may observe count toward the
/// bound, so retained or hidden rows never change an answer; a lookup that does reach a bound reports no eligible copy
/// for that read only (never cached, never Ready or fulfilled), and every reader still answers: the Requests page,
/// details and arrival reads, a notification round (single alerts and summaries) and the auto-request recipes.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEditionBoundTests
{
    private static readonly TitleKey Matrix = TitleKey.Parse("movie:tmdb:603")!;
    private static readonly TitleKey Firefly = TitleKey.Parse("tv:tvdb:78874")!;

    /// <summary>Past every page of the native work ceiling (and past round 5's 1,000-row bound).</summary>
    internal const int PastTheCeiling = 10_001;

    /// <summary>
    /// The native rows of one provider id (a TMDB movie id by default): <paramref name="orphans"/> rows retained from removed paths, then
    /// <paramref name="hidden"/> live rows in a library nobody but administrators may open, then the live 4K copy
    /// when <paramref name="live"/>. Every other query answers nothing (an absent title). Pages like Jellyfin.
    /// </summary>
    internal static List<BaseItem> Rows(IntegrationEditionOrphanTests.Library l, int orphans, int hidden = 0, bool live = true, string id = "603", string provider = "Tmdb")
    {
        var rows = IntegrationEditionOrphanTests.PagedRows(l, orphans, false, live: false);
        if (hidden > 0)
        {
            var locked = new CollectionFolder { Id = Guid.NewGuid(), Name = "Locked" };
            l.AddRoot(locked);
            l.Denied.Add(locked.Id);
            for (var n = 0; n < hidden; n++)
            {
                var row = new IntegrationEditionOrphanTests.MovieFile { Id = Guid.NewGuid(), Name = $"B hidden {n:D5}", Path = $"/media/Locked/{n}.mkv" };
                l.Items[row.Id] = row; l.Parents[row.Id] = new() { locked }; rows.Add(row);
            }
        }
        if (live) rows.Add(l.Uhd);
        l.Manager.Setup(m => m.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
            q.IncludeItemTypes.Contains(BaseItemKind.Episode) || q.IncludeItemTypes.Contains(BaseItemKind.Season) ? new List<BaseItem>()
            : q.HasAnyProviderId?.GetValueOrDefault(provider) == id ? rows.Skip(q.StartIndex ?? 0).Take(q.Limit ?? int.MaxValue).ToList()
            : new List<BaseItem>());
        return rows;
    }

    private static int NativeReads(IntegrationEditionOrphanTests.Library l) => l.Manager.Invocations.Count(i => i.Method.Name == "GetItemList");

    private static T As<T>(ControllerBase controller, StatusViewer viewer, T made) where T : ControllerBase
    {
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("Jellyfin-UserId", viewer.UserId.ToString()), new Claim(ClaimTypes.Role, viewer.IsAdmin ? "Administrator" : "User") }, "test")),
            },
        };
        return made;
    }

    private static ArrStatusController StatusController(ArrStatusService service, StatusViewer viewer)
    {
        var controller = new ArrStatusController(service);
        return As(controller, viewer, controller);
    }

    /// <summary>The status, body and caching headers of one response.</summary>
    private static (int Status, string Body, string CacheControl, bool ETag) Answer(ControllerBase controller, IActionResult result)
    {
        var headers = controller.Response.Headers;
        return result switch
        {
            FileContentResult file => (200, System.Text.Encoding.UTF8.GetString(file.FileContents), headers.CacheControl.ToString(), headers.ContainsKey("ETag")),
            ObjectResult obj => (obj.StatusCode ?? 200, JsonSerializer.Serialize(obj.Value), headers.CacheControl.ToString(), headers.ContainsKey("ETag")),
            StatusCodeResult code => (code.StatusCode, string.Empty, headers.CacheControl.ToString(), headers.ContainsKey("ETag")),
            _ => throw new InvalidOperationException(result.GetType().Name),
        };
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void RowsTheViewerCantObserveNeverCountTowardTheScanBound(bool libraryContext)
    {
        using var l = new IntegrationEditionOrphanTests.Library();
        using var rig = new IntegrationEditionAvailabilityTests.Rig(IntegrationEditionAvailabilityTests.Layout.OneItem, IntegrationEditionAvailabilityTests.Has.Hd, true);
        var viewer = libraryContext ? StatusViewer.Library : l.Person(rig.Member);
        // 1,001 rows retained from removed paths ahead of the live copy: none of them counts, the copy is found.
        Rows(l, 1_001);
        Assert.Equal(l.Uhd.Id, Assert.Single(l.View.Copies(Matrix, viewer).Seen).ItemId);
        var editions = new EditionAvailability(l.View, () => rig.Arr.Plugin.Plugin.Configuration, (k, v) => l.View.Copies(k, v).Display);
        Assert.True(editions.Available(viewer, Matrix, Edition.FourK));
    }

    [Fact]
    public async Task ArrivalForAKeyWithOnlyHiddenOrRetainedRowsAnswersExactlyLikeAnAbsentKey()
    {
        using var l = new IntegrationEditionOrphanTests.Library();
        using var lab = new IntegrationRequestArrivalsTests.Lab(fourK: true, jellyfin: l.View);
        var viewer = l.Person(lab.Emma); l.Person(lab.Admin); l.Person(lab.Kid);
        Rows(l, 0, live: false);
        await lab.Warm();
        (int, string, string, bool) Arrival()
        {
            var controller = StatusController(lab.Status, viewer);
            return Answer(controller, controller.GetArrival(Matrix.ToString(), null));
        }
        var absent = Arrival();
        Assert.Equal((200, "{\"itemId\":null}", "private, no-store", false), absent);
        // Live copies only in a library the viewer can't open, then rows retained from removed paths past the work
        // ceiling: the same status, body and headers as a title Jellyfin doesn't have.
        Rows(l, 0, hidden: 1_001, live: false);
        Assert.Equal(absent, Arrival());
        Rows(l, PastTheCeiling, live: false);
        Assert.Equal(absent, Arrival());
        Rows(l, PastTheCeiling, hidden: 5, live: false);
        Assert.Equal(absent, Arrival());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ABoundReadReportsNoCopyForThatReadOnlyAndIsNeverCachedOrCredited(bool partial)
    {
        using var l = new IntegrationEditionOrphanTests.Library();
        using var lab = new IntegrationRequestArrivalsTests.Lab(fourK: true, jellyfin: l.View);
        var viewer = l.Person(lab.Emma); l.Person(lab.Admin); l.Person(lab.Kid);
        Rows(l, 25, live: false);
        await lab.Warm();
        lab.Policy.Adjust = (_, _, policy) => policy with { Can4k = true };
        var request = await lab.Ask(lab.Emma, new MutationInput { Key = Matrix.ToString(), Variant = "4k" });
        await lab.Outbox.TickAsync(default);
        // The live 4K copy lies past the work ceiling; with a partial hit, an eligible copy also comes first.
        var rows = Rows(l, PastTheCeiling);
        if (partial) rows.Insert(0, l.Hd);
        // Incomplete: what it saw is kept (the HD copy of the partial hit), and pages show no copy.
        var bounded = l.View.Copies(Matrix, viewer);
        Assert.Equal(CopyLookupOutcome.Incomplete, bounded.Outcome);
        Assert.Empty(bounded.Display);
        Assert.Equal(partial ? new[] { l.Hd.Id } : Array.Empty<Guid>(), bounded.Seen.Select(c => c.ItemId));
        Assert.False(lab.Status.Editions.Available(viewer, Matrix, Edition.FourK));

        lab.Status.Cache.Clear();
        var controller = StatusController(lab.Status, viewer);
        var detail = Answer(controller, await controller.GetStatuses(null, Matrix.ToString(), default, detail: true));
        Assert.Equal(200, detail.Status);
        Assert.NotEqual("ready", JsonDocument.Parse(detail.Body).RootElement.GetProperty("items")[0].GetProperty("stage").GetString());
        Assert.Equal(0, lab.Status.Cache.Count);
        // The details page of the copy itself answers too (its own item is there), and nothing is kept: the next read
        // scans again.
        var reads = NativeReads(l);
        var item = StatusController(lab.Status, viewer);
        var page = Answer(item, await item.GetItemStatus(l.Uhd.Id.ToString("N"), default));
        Assert.Equal(200, page.Status);
        Assert.Single(JsonDocument.Parse(page.Body).RootElement.GetProperty("items").EnumerateArray());
        Assert.True(NativeReads(l) > reads);
        Assert.Equal(0, lab.Status.Cache.Count);
        var again = StatusController(lab.Status, viewer);
        reads = NativeReads(l);
        Assert.Equal(detail.Body, Answer(again, await again.GetStatuses(null, Matrix.ToString(), default, detail: true)).Body);
        Assert.True(NativeReads(l) > reads);
        Assert.Equal(0, lab.Status.Cache.Count);

        Assert.Equal(0, await lab.Fulfilment.CheckAsync(new[] { Matrix.ToString() }, default));
        Assert.NotEqual("fulfilled", lab.Ledger.Find(request)!.Status);
        // No native item event: the first conclusive read is Ready, and only then is the request fulfilled.
        rows.Clear(); rows.Add(l.Uhd);
        Assert.True(lab.Status.Editions.Available(viewer, Matrix, Edition.FourK));
        using var body = JsonDocument.Parse((await lab.Status.ForKeyDetailAsync(viewer, Matrix, default)).Json);
        Assert.Equal("ready", body.RootElement.GetProperty("items")[0].GetProperty("stage").GetString());
        Assert.Equal(1, await lab.Fulfilment.CheckAsync(new[] { Matrix.ToString() }, default));
        Assert.Equal("fulfilled", lab.Ledger.Find(request)!.Status);
    }

    [Fact]
    public async Task TheRequestsPageWithABoundTitleRendersEveryRequestFromTheLedger()
    {
        using var l = new IntegrationEditionOrphanTests.Library();
        using var lab = new IntegrationRequestArrivalsTests.Lab(fourK: true, jellyfin: l.View);
        var viewer = l.Person(lab.Emma); l.Person(lab.Admin); l.Person(lab.Kid);
        Rows(l, 0, live: false);
        await lab.Warm();
        lab.Policy.Adjust = (_, _, policy) => policy with { Can4k = true };
        await lab.Ask(lab.Emma, new MutationInput { Key = Matrix.ToString(), Variant = "4k" });
        await lab.Ask(lab.Emma, new MutationInput { Key = Firefly.ToString(), Scope = "seasons", Seasons = new[] { 1 } });
        Rows(l, PastTheCeiling);
        // The page as served: titles and Play links from the viewer's own copies (the ledger's meta lookup).
        var hub = new RequestsHubService(lab.Status, lab.Model, () => lab.Config, lab.Ledger, lab.Projection.MetaAsync);
        lab.Status.Cache.Clear();
        var controller = new RequestsHubController(hub, null!);
        As(controller, viewer, controller);
        var page = Answer(controller, await controller.GetHub(default));
        Assert.Equal(200, page.Status);
        var mine = JsonDocument.Parse(page.Body).RootElement.GetProperty("mine").EnumerateArray().Select(e => e.GetProperty("key").GetString()).ToList();
        Assert.Contains(Matrix.ToString(), mine);
        Assert.Contains(Firefly.ToString(), mine);
        Assert.Equal(0, lab.Status.Cache.Count);
    }

    [Fact]
    public async Task ANotificationRoundDeliversEveryOtherAlertAndKeepsTheBoundOnePending()
    {
        using var l = new IntegrationEditionOrphanTests.Library();
        using var rig = await IntegrationNotificationsTests.Started();
        rig.Phones(rig.Emma);
        const string bound = "movie:tmdb:693134";
        var rows = Rows(l, PastTheCeiling, live: false, id: "693134");
        rig.View.CopiesFrom = (key, viewer, aliases) => key.Title.ToString() == bound ? l.View.Copies(key, viewer, aliases) : null;
        rig.View.Routed = l.View;
        long Ready(string key, string title)
            => rig.NotifyStore.Add(rig.Emma.UserId, "ready|" + key, NotifyKind.Ready, key, null, new Dictionary<string, string> { ["title"] = title },
                new[] { (NotifyChannel.Ntfy, rig.Arr.Now) }, rig.Arr.Now)!.Value;
        void Have(string key) => rig.View.AddCopy(TitleKey.Parse(key)!, new JfCopy { ItemId = Guid.NewGuid(), Path = "/media/" + key, LibraryName = "Movies" });

        // One by one: the bound alert first (oldest), another after it.
        Ready(bound, "Dune: Part Two");
        Have("movie:tmdb:45745");
        Ready("movie:tmdb:45745", "Sintel");
        await rig.Dispatcher.RunOnceAsync(default);
        Assert.Equal("Sintel is ready to watch", (string?)Assert.Single(rig.Pushes).Body["title"]);
        Assert.Equal(1, rig.NotifyStore.DeliveryStats(rig.Arr.Now).Pending);
        await rig.Dispatcher.RunOnceAsync(default);
        Assert.Single(rig.Pushes);

        // A summary round (four or more due for one person and channel): the others go out as one summary.
        rig.Pushes.Clear();
        rig.Arr.Now += TimeSpan.FromMinutes(16); // past the 15-minute wait of an alert a bound read held
        foreach (var tmdb in new[] { 1, 2, 3, 4 })
        {
            Have("movie:tmdb:" + tmdb);
            Ready("movie:tmdb:" + tmdb, "Film " + tmdb);
        }
        await rig.Dispatcher.RunOnceAsync(default);
        Assert.Equal("4 new notifications", (string?)Assert.Single(rig.Pushes).Body["title"]);
        Assert.Equal(1, rig.NotifyStore.DeliveryStats(rig.Arr.Now).Pending);

        // The first conclusive read sends it.
        rig.Pushes.Clear();
        rows.Clear(); rows.Add(l.Uhd);
        rig.Arr.Now += TimeSpan.FromMinutes(16); // past the 15-minute wait of an alert a bound read held
        await rig.Dispatcher.RunOnceAsync(default);
        Assert.Equal("Dune: Part Two is ready to watch", (string?)Assert.Single(rig.Pushes).Body["title"]);
        Assert.Equal(0, rig.NotifyStore.DeliveryStats(rig.Arr.Now).Pending);
    }

    [Fact]
    public async Task AnAdministratorsAskAlertWhoseVisibilityCheckMeetsABoundReadWaitsThenGoesOut()
    {
        using var l = new IntegrationEditionOrphanTests.Library();
        const string dune = "movie:tmdb:693134";
        var rows = Rows(l, PastTheCeiling, live: false, id: "693134");
        using var rig = await IntegrationNotificationsTests.Started();
        rig.Phones(rig.Admin);
        rig.Prefs(rig.Admin, p => p.AdminAlerts = true);
        // The policy's visibility check reads the title's copies as RequestPolicy does: a copy they can open, or a
        // proven absence (an incomplete lookup that saw nothing fails closed).
        var policy = new IntegrationRequestLedgerTests.Policy();
        policy.People[rig.Admin.UserId] = new(rig.Admin.UserId, "Admin", true, true, true, true, "p1", "je", "inst", "g1", 7, 7, 0, "{}");
        policy.Adjust = (user, input, facts) => l.View.Copies(TitleKey.Parse(input.Key)!, rig.View.Viewer(user)!) is var lookup && (lookup.SeenOpenable != null || lookup.IsProvenAbsent) ? facts : facts with { Visible = false };
        using var dispatcher = new NotifyDispatcher(rig.NotifyStore, new NtfySender(rig.Ntfy), new EmailSender(rig.Mail), null, () => rig.Config, () => rig.Arr.Now, rig.Users, rig.View, rig.Status.Aliases, null, policy);
        rig.NotifyStore.Add(rig.Admin.UserId, "approval|bound|1", NotifyKind.Approval, dune, null, new Dictionary<string, string> { ["title"] = "Dune: Part Two", ["user"] = "Kid" },
            new[] { (NotifyChannel.Ntfy, rig.Arr.Now) }, rig.Arr.Now);
        await dispatcher.RunOnceAsync(default);
        Assert.Empty(rig.Pushes);
        Assert.Equal(1, rig.NotifyStore.DeliveryStats(rig.Arr.Now).Pending);
        rows.Clear(); rows.Add(l.Uhd);
        rig.Arr.Now += TimeSpan.FromMinutes(16); // past the 15-minute wait of an alert a bound read held
        await dispatcher.RunOnceAsync(default);
        Assert.Single(rig.Pushes);
        Assert.Equal(0, rig.NotifyStore.DeliveryStats(rig.Arr.Now).Pending);
    }

    [Fact]
    public async Task ALookAtAFollowedTitleOnABoundReadRemembersNothingAndTheFirstConclusiveLookIsItsBaseline()
    {
        using var l = new IntegrationEditionOrphanTests.Library();
        const string dune = "movie:tmdb:693134";
        var rows = Rows(l, PastTheCeiling, live: false, id: "693134");
        using var rig = await IntegrationNotificationsTests.Started(r =>
        {
            r.Request(1, 693134, r.Emma);
            r.View.CopiesFrom = (key, viewer, aliases) => key.Title.ToString() == dune ? l.View.Copies(key, viewer, aliases) : null;
            r.View.Routed = l.View;
        });
        rig.Service.RebuildInterest();
        await rig.Service.EvaluateAsync(new[] { dune }, null, default);
        Assert.Null(rig.NotifyStore.Watch(rig.Emma.UserId, dune, "m"));
        Assert.Empty(rig.Inbox(rig.Emma));
        // Not "not here" either: the first conclusive look is the title's first look, remembered as usual.
        rows.Clear(); rows.Add(l.Uhd);
        await rig.Service.EvaluateAsync(new[] { dune }, null, default);
        Assert.NotNull(rig.NotifyStore.Watch(rig.Emma.UserId, dune, "m"));
    }

    [Fact]
    public async Task ANewEpisodesBatchMetByABoundReadIsKeptForTheNextRoundNotDroppedAsGone()
    {
        using var l = new IntegrationEditionOrphanTests.Library();
        const string severance = "tv:tvdb:371980";
        using var rig = await IntegrationNotificationsTests.Started();
        var series = Guid.NewGuid();
        rig.View.AddCopy(TitleKey.Parse(severance)!, new JfCopy { ItemId = series, Path = "/tv/Severance", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Emma, TitleKey.Parse(severance)!, true, default));
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime });
        await rig.Step(severance);
        Assert.NotNull(rig.NotifyStore.Batch(rig.Emma.UserId, severance));
        // When the batch is due, the series' copy lookup reaches its bound: the batch stays, nothing is told.
        Rows(l, PastTheCeiling, live: false, id: "371980", provider: "Tvdb");
        rig.View.CopiesFrom = (key, viewer, aliases) => key.Title.ToString() == severance ? l.View.Copies(key, viewer, aliases) : null;
        rig.View.Routed = l.View;
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        Assert.Equal(0, rig.Service.FlushBatches(rig.Arr.Now));
        Assert.NotNull(rig.NotifyStore.Batch(rig.Emma.UserId, severance));
        Assert.Empty(rig.Inbox(rig.Emma));
        // The next conclusive round tells it.
        rig.View.CopiesFrom = null;
        Assert.Equal(1, rig.Service.FlushBatches(rig.Arr.Now));
        Assert.Equal("episodes", Assert.Single(rig.Inbox(rig.Emma)).Kind);
    }

    [Fact]
    public async Task DiscoverShowsABoundTitleAsNotInTheLibraryForThatAnswerOnlyAndKeepsNothing()
    {
        using var l = new IntegrationEditionOrphanTests.Library();
        using var rig = new IntegrationRequestDiscoverTests.Rig();
        rig.Tmdb["trending/movie/week"] = IntegrationRequestDiscoverTests.Page(IntegrationRequestDiscoverTests.Movie(603, "The Matrix"), IntegrationRequestDiscoverTests.Movie(1, "One"));
        var rows = Rows(l, PastTheCeiling);
        rig.R.View.CopiesFrom = (key, viewer, aliases) => key.Title.ToString() == Matrix.ToString() ? l.View.Copies(key, viewer, aliases) : null;
        rig.R.View.Routed = l.View;
        JsonElement Card(JsonElement body) => body.GetProperty("answer").GetProperty("results").EnumerateArray().Single(e => e.GetProperty("key").GetString() == Matrix.ToString());
        var (status, body, _) = await rig.Discover(rig.R.Member, "trending");
        Assert.Equal(200, status);
        Assert.Equal(2, body.GetProperty("answer").GetProperty("results").GetArrayLength());
        Assert.False(Card(body).GetProperty("inLibrary").GetBoolean());
        // Nothing kept: the next answer reads TMDB and Jellyfin again, and the first conclusive one is kept.
        var reads = rig.Reads.Count;
        await rig.Discover(rig.R.Member, "trending");
        Assert.Equal(reads + 1, rig.Reads.Count);
        rows.Clear(); rows.Add(l.Uhd);
        (_, body, _) = await rig.Discover(rig.R.Member, "trending");
        Assert.True(Card(body).GetProperty("inLibrary").GetBoolean());
        Assert.Equal(l.Uhd.Id.ToString("N"), Card(body).GetProperty("itemId").GetString());
        await rig.Discover(rig.R.Member, "trending");
        Assert.Equal(reads + 2, rig.Reads.Count);
    }

    [Fact]
    public async Task TheRecipesAskNothingOnABoundReadAndDecideOnTheNextRun()
    {
        using var l = new IntegrationEditionOrphanTests.Library();
        using var lab = new IntegrationRequestArrivalsTests.Lab(fourK: true, jellyfin: l.View);
        var viewer = l.Person(lab.Emma); l.Person(lab.Admin); l.Person(lab.Kid);
        Rows(l, PastTheCeiling);
        var recorder = new AutoRequestRecorder(lab.Requests, l.View, null, () => lab.Arr.Now);
        Assert.Null(recorder.InLibrary(Matrix, viewer.UserId));
        Rows(l, PastTheCeiling, id: "78874", provider: "Tvdb");
        Assert.Null(recorder.EpisodesInLibrary(Firefly, 1, viewer.UserId));
        // Hidden rows alone never stop it: a conclusive answer either way.
        Rows(l, 1_001);
        Assert.Equal(true, recorder.InLibrary(Matrix, viewer.UserId));
        Rows(l, 1_001, live: false);
        Assert.Equal(false, recorder.InLibrary(Matrix, viewer.UserId));
        await Task.CompletedTask;
    }
}
