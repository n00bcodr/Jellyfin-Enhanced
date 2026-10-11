using System.Reflection;
using System.Runtime.ExceptionServices;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Sources;
using static JE.Tests.FakeImportLookup;
using static JE.Tests.ListPlaceholdersHarness;

namespace JE.Tests;

// Review round 1, track d2 (linked-list sync): removals that would take unresolved or new playlist entries with them
// (F18, F22), narrowing a season placeholder (order F19, the placeholder cap F20), a failing post-apply hook (F21),
// whole-season grouping of exact sources (F23) and import keys outside the fetched list (F30).
[Collection("Plugin singleton")]
public class ListPlaceholdersReviewR1d2Tests
{
    private static readonly CancellationToken None = CancellationToken.None;
    private const string Url = "https://mdblist.com/lists/me/dc";
    private const string ChronoUrl = "https://chronolists.com/dctv";

    /// <summary>Jellyfin's playlist removal: rebuilds the playlist from the entries it can resolve (so every unresolved
    /// entry goes too) and removes every copy of each id; a collection only loses the given ids.</summary>
    private sealed class JellyfinLikeRemover(FakeListHost host) : IListEntryRemover
    {
        public List<Guid> Removed { get; } = new();

        public Task RemoveAsync(ListInfo list, IReadOnlyList<Guid> itemIds)
        {
            Removed.AddRange(itemIds);
            var playlist = list.Kind == ListKinds.Playlist;
            host.Lists[list.Id].Raw.RemoveAll(r => (playlist && !r.Resolved) || (r.ItemId.HasValue && itemIds.Contains(r.ItemId.Value)));
            return Task.CompletedTask;
        }
    }

    /// <summary>The Jellyfin host as the sync service sees it, with a hook right before each item-access check (the
    /// sync's only one is the linker check of a drop plan, between reading the playlist and removing from it).</summary>
    public class HostProxy : DispatchProxy
    {
        public IListPlaceholderHost Target { get; set; } = null!;

        public Action? BeforeAccessCheck { get; set; }

        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
        {
            if (targetMethod!.Name == nameof(IListPlaceholderHost.CanAccessItem))
            {
                BeforeAccessCheck?.Invoke();
            }

            try
            {
                return targetMethod.Invoke(Target, args);
            }
            catch (TargetInvocationException ex)
            {
                ExceptionDispatchInfo.Capture(ex.InnerException!).Throw();
                throw;
            }
        }
    }

    private sealed class World : IDisposable
    {
        public ListPlaceholdersHarness H { get; }
        public User Owner { get; }
        public FakeListHost.FakeList List { get; }
        public Guid InLibrary { get; }
        public Guid InLibrary2 { get; }
        public JellyfinLikeRemover Remover { get; }
        public ListSourceService Sources { get; }
        public HostProxy Host { get; }

        public World(bool seerr = false)
        {
            H = new ListPlaceholdersHarness(seerr: seerr);
            H.Plugin.Plugin.Configuration.ListPlaceholdersSyncEnabled = true;
            Owner = H.NewUser("owner");
            List = H.Host.AddPlaylist(Owner);
            InLibrary = H.Host.AddItem(tmdb: 862);
            InLibrary2 = H.Host.AddItem(tmdb: 863);
            H.Library.Matches[("movie", 862)] = new LibraryMatch(InLibrary, "movie", Array.Empty<Guid>(), true);
            H.Library.Matches[("movie", 863)] = new LibraryMatch(InLibrary2, "movie", Array.Empty<Guid>(), true);
            foreach (var id in new[] { 1, 2, 3, 862, 863 })
            {
                H.Lookup.Details[("movie", id)] = new TitleDetails(FakeImportLookup.Movie(id, "Movie " + id, "2020-01-01"), null, null, "Released", null, Array.Empty<SeasonFacts>());
            }

            // Its own sync service over a remover that behaves like Jellyfin's playlist manager.
            Remover = new JellyfinLikeRemover(H.Host);
            var proxy = DispatchProxy.Create<IListPlaceholderHost, HostProxy>();
            Host = (HostProxy)(object)proxy;
            Host.Target = H.Host;
            Sources = new ListSourceService(H.Store, H.Access, H.Service, proxy, Remover, H.Fetcher, H.ImportResolver, H.Users.Object, H.Plugin.Core.Logger);
        }

        public ListAccess Access => H.AccessFor(List, Owner);

        public string Id => Access.ListIdN;

        public ListDoc Doc => H.Store.Load(Id)!;

        public List<RawEntry> Raw => H.Host.Lists[List.Info.Id].Raw;

        public void Source(params SourceItem[] items) => H.Fetcher.Items = items.ToList();

        public static SourceItem M(int tmdb) => new("movie", tmdb, null, null, "Movie " + tmdb, 2020, null, null, null);

        public async Task Link(bool removeDropped = true, string url = Url)
        {
            var outcome = await Sources.LinkAsync(Access, new LinkSourceRequest { Url = url, SyncEnabled = true, RemoveDropped = removeDropped }, None);
            Assert.Equal(200, outcome.StatusCode);
        }

        public Task<SourceSyncResultDto> Sync(CancellationToken? token = null) => Sources.SyncAsync(Id, background: true, token ?? None);

        public void Dispose() => H.Dispose();
    }

    private static SourceItem Soap(int e) => new("tv", 5, null, 1005, "Soap", 2020, 1, e, null) { Details = new SourceItemDetails("Ep " + e, "2020-01-01", null, null, "Season 1") };

    private static SourceItem Film(int id) => new("movie", id, null, null, "Movie " + id, 2020, null, null, null) { Details = new SourceItemDetails(null, "2020-01-01", null, null, null) };

    // ── F18: Jellyfin's playlist removal drops every unresolved entry ──────────────

    [Fact]
    public async Task F18_ASyncRemovalNeverTakesAnUnresolvedPlaylistEntryWithIt()
    {
        using var w = new World();
        w.Source(World.M(862), World.M(1));
        await w.Link();
        await w.Sync();
        var dangling = Guid.NewGuid();
        w.Raw.Add(new RawEntry(dangling, false)); // e.g. its file is on a drive that isn't mounted right now

        w.Source(World.M(1), World.M(2));
        var result = await w.Sync();

        Assert.Equal("ok", result.State);
        Assert.Contains(new RawEntry(dangling, false), w.Raw); // still in the playlist
        Assert.Empty(w.Remover.Removed); // the real removal is held back (kept and reported) ...
        Assert.Contains(w.InLibrary, w.H.Host.Resolved(w.List.Info.Id));
        Assert.Equal(1, result.Kept);
        Assert.True(w.Doc.Source!.Owned.ContainsKey("movie|862||")); // ... and retried by a later sync

        // Once the entry resolves again (or an editor removes it), the sync removes what it owns.
        w.Raw.Remove(new RawEntry(dangling, false));
        var later = await w.Sync();
        Assert.Equal(1, later.Removed);
        Assert.Equal(new[] { w.InLibrary }, w.Remover.Removed);
        Assert.False(w.Doc.Source!.Owned.ContainsKey("movie|862||"));
    }

    // ── F22: a copy added natively while the sync awaited the parental check ──────

    [Fact]
    public async Task F22_ACopyAddedWhileTheSyncCheckedTheLinkerIsNotRemoved()
    {
        using var w = new World();
        w.Source(World.M(862), World.M(1));
        await w.Link();
        await w.Sync();
        var fired = false;
        w.Host.BeforeAccessCheck = () =>
        {
            if (!fired)
            {
                fired = true;
                w.Raw.Add(new RawEntry(w.InLibrary, true)); // an editor adds a second copy in Jellyfin meanwhile
            }
        };

        w.Source(World.M(2));
        var result = await w.Sync();

        Assert.True(fired);
        Assert.Equal("ok", result.State);
        Assert.Equal(2, w.H.Host.Resolved(w.List.Info.Id).Count(id => id == w.InLibrary)); // both copies stay
        Assert.Empty(w.Remover.Removed);
        Assert.Equal(1, result.Kept);
        Assert.DoesNotContain(w.Doc.Items, p => p.TmdbId == 1); // the dropped placeholder still goes
    }

    [Fact]
    public void F18F22_TheRecheckKeepsCopiesAndHoldsPlaylistRemovalsBackWhileAnEntryIsUnresolved()
    {
        Guid once = Guid.NewGuid(), twice = Guid.NewGuid(), gone = Guid.NewGuid();
        DropPlan Plan()
        {
            var plan = new DropPlan();
            plan.ItemIds.AddRange(new[] { once, twice, gone });
            return plan;
        }

        var raw = new List<RawEntry> { new(once, true), new(twice, true), new(twice, true) };
        var plain = Plan();
        ListSourceProvenance.RecheckItemDrops(plain, raw, isPlaylist: true);
        Assert.Equal(new[] { once }, plain.ItemIds); // the gone one is simply left out
        Assert.Equal(1, plain.Kept);

        raw.Add(new RawEntry(Guid.NewGuid(), false));
        var held = Plan();
        ListSourceProvenance.RecheckItemDrops(held, raw, isPlaylist: true);
        Assert.Equal((0, 2), (held.ItemIds.Count, held.Kept));

        // A collection only loses the given ids: an unresolved entry doesn't hold anything back.
        var collection = Plan();
        ListSourceProvenance.RecheckItemDrops(collection, raw, isPlaylist: false);
        Assert.Equal(new[] { once }, collection.ItemIds);
    }

    // ── F21: the post-apply hook fails after Jellyfin was changed ─────────────────

    [Fact]
    public async Task F21_ACancelledSyncStillSavesWhatItAddedAndItsOwnership()
    {
        using var w = new World(seerr: true);
        w.Source(World.M(862), World.M(1));
        await w.Link();
        await w.Sync();
        w.Owner.MaxParentalRatingScore = 10;
        w.H.MovieCertifications[1] = "PG";
        w.H.MovieCertifications[2] = "PG";
        using var cts = new CancellationTokenSource();
        var fired = false;
        w.Host.BeforeAccessCheck = () =>
        {
            if (!fired)
            {
                fired = true;
                cts.Cancel(); // server shutdown while the sync checks what it would remove
            }
        };

        // Adds the library movie 863 (real) and Movie 2 (placeholder), then awaits the parental check of the drops.
        w.Source(World.M(863), World.M(2));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => w.Sync(cts.Token));

        Assert.True(fired);
        Assert.Contains(w.InLibrary2, w.H.Host.Resolved(w.List.Info.Id));
        var doc = w.Doc;
        Assert.Contains(doc.Items, p => p.TmdbId == 2); // the placeholder it added was saved
        Assert.Equal(new[] { w.InLibrary2.ToString("N") }, doc.Source!.Owned["movie|863||"].ItemIds); // and owned
        Assert.NotNull(doc.Source.Owned["movie|2||"].PhId);
        Assert.Contains(ListPlaceholderOrder.PlaceholderToken(doc.Items.Single(p => p.TmdbId == 2).Id), doc.Order);

        // The next sync adds nothing again and does the removals the cancelled one didn't get to.
        var next = await w.Sync();
        Assert.Equal(("ok", 0, 2), (next.State, next.Added, next.Removed));
        Assert.DoesNotContain(w.InLibrary, w.H.Host.Resolved(w.List.Info.Id));
        Assert.Contains(w.InLibrary2, w.H.Host.Resolved(w.List.Info.Id));
    }

    // ── F19: a narrowed season's extra placeholders keep their place ─────────────

    [Fact]
    public async Task F19_TheExtraPlaceholdersOfANarrowedLongSeasonGoRightAfterIt()
    {
        using var w = new World();
        w.H.Fetcher.Exact = true;
        w.H.Fetcher.Provider = "chronolists";
        w.H.Lookup.AddShow(Tv(5, "Soap", "2020-01-01"), new SeasonFacts(1, 150, "2020-01-01", "Season 1"));
        var all = Enumerable.Range(1, 150).Select(Soap).ToList();
        w.H.Fetcher.Items = all.Append(Film(1)).Append(Film(2)).ToList();
        await w.Link(url: ChronoUrl);
        await w.Sync();
        var season = w.Doc.Items.Single(p => p.TmdbId == 5);
        Assert.Equal(PlaceholderKinds.Season, season.Kind);
        Assert.Equal(3, w.Doc.Order.Count);

        // 1x07 leaves the watch order: 149 episodes stay → two episodes placeholders (100 + 49).
        w.H.Fetcher.Items = all.Where(i => i.Episode != 7).Append(Film(1)).Append(Film(2)).ToList();
        var result = await w.Sync();

        Assert.Equal(("ok", 1), (result.State, result.Removed));
        var doc = w.Doc;
        var soaps = doc.Items.Where(p => p.TmdbId == 5).ToList();
        Assert.Equal(2, soaps.Count);
        var first = soaps.Single(p => p.Id == season.Id);
        var extra = soaps.Single(p => p.Id != season.Id);
        Assert.Equal((100, 49), (first.Episodes.Count, extra.Episodes.Count));
        string Token(int tmdb) => ListPlaceholderOrder.PlaceholderToken(doc.Items.Single(p => p.TmdbId == tmdb).Id);
        Assert.Equal(
            new[] { ListPlaceholderOrder.PlaceholderToken(first.Id), ListPlaceholderOrder.PlaceholderToken(extra.Id), Token(1), Token(2) },
            doc.Order);
    }

    // ── F20: narrowing never takes a list over the placeholder cap ────────────────

    [Fact]
    public void F20_ASeasonIsNotNarrowedWhenTheExtraPlaceholderWouldExceedTheCap()
    {
        ListDoc FullDoc(out Placeholder season, out Placeholder ownedMovie)
        {
            season = Ph("{\"kind\":\"season\",\"tmdbId\":5,\"title\":\"Soap\",\"seasonNumber\":1,\"episodeTotal\":150}");
            var doc = new ListDoc { ListKind = ListKinds.Playlist, Source = new ListSource { RemoveDropped = true } };
            doc.Items.Add(season);
            foreach (var e in Enumerable.Range(1, 150))
            {
                ListSourceProvenance.RecordAdded(doc.Source, $"tv|5|1|{e}", season.Id, null);
            }

            ownedMovie = Movie(100000);
            doc.Items.Add(ownedMovie);
            ListSourceProvenance.RecordAdded(doc.Source, "movie|100000||", ownedMovie.Id, null);
            for (var i = 1; doc.Items.Count < ListPlaceholderStore.MaxPlaceholders; i++)
            {
                doc.Items.Add(Movie(200000 + i));
            }

            doc.Order = doc.Items.Select(p => ListPlaceholderOrder.PlaceholderToken(p.Id)).ToList();
            return doc;
        }

        var staying = Enumerable.Range(1, 150).Where(e => e != 7).Select(e => $"tv|5|1|{e}").ToList();

        // The list is full: splitting the 149 remaining episodes needs one more placeholder → the season stays whole.
        var full = FullDoc(out var season, out _);
        var plan = ListSourceProvenance.PlanDrops(full, staying.Append("movie|100000||").ToList(), new Dictionary<string, int>());
        ListSourceProvenance.ApplyDrops(full, plan, Array.Empty<string>());
        Assert.Equal(ListPlaceholderStore.MaxPlaceholders, full.Items.Count);
        Assert.Equal(PlaceholderKinds.Season, season.Kind);
        Assert.Equal(1, plan.Kept); // reported: 1x07 stays in the list through the season placeholder
        Assert.False(full.Source!.Owned.ContainsKey("tv|5|1|7"));

        // A placeholder the same sync drops makes room: the season is narrowed and split.
        var roomy = FullDoc(out var season2, out var movie);
        var plan2 = ListSourceProvenance.PlanDrops(roomy, staying, new Dictionary<string, int>());
        ListSourceProvenance.ApplyDrops(roomy, plan2, Array.Empty<string>());
        Assert.DoesNotContain(movie, roomy.Items);
        Assert.Equal(PlaceholderKinds.Episodes, season2.Kind);
        Assert.Equal(ListPlaceholderStore.MaxPlaceholders, roomy.Items.Count);
    }

    // ── F23: a whole-season placeholder needs TMDB's episode count ────────────────

    [Fact]
    public void F23_ARunIsNotAWholeSeasonJustBecauseTheListHasNoLaterEpisode()
    {
        // The source lists only Strange New Worlds 3x01 (a crossover): that's one episode, not all of season 3.
        var snw = new SourceItem("tv", 103516, null, 382767, "Star Trek: Strange New Worlds", 2022, 3, 1, null);
        var items = new[] { Film(1), snw, Film(2) };
        var groups = ListSourceGroups.Group(items.Select((item, i) => (item, i)).ToList(), ListSourceGroups.Facts(items));
        Assert.Equal(PlaceholderKinds.Episodes, groups[1].Kind);
        Assert.Equal(new[] { "tv|103516|3|1" }, groups[1].Keys);
    }

    [Fact]
    public void F23_ARunIsAWholeSeasonOnlyWhenItCoversTmdbsEpisodeCount()
    {
        static SourceItem Ep(int e) => new("tv", 103516, null, 382767, "Star Trek: Strange New Worlds", 2022, 3, e, null);
        var all = Enumerable.Range(1, 10).Select(Ep).ToList();
        var facts = ListSourceGroups.Facts(all);
        facts.SeasonEpisodes[(103516, 3)] = 10;
        Assert.Equal(PlaceholderKinds.Season, Assert.Single(ListSourceGroups.Group(all.Select((item, i) => (item, i)).ToList(), facts)).Kind);

        var firstThree = all.Take(3).ToList();
        Assert.Equal(PlaceholderKinds.Episodes, Assert.Single(ListSourceGroups.Group(firstThree.Select((item, i) => (item, i)).ToList(), facts)).Kind);
        var single = new List<SourceItem> { Ep(1) };
        var oneEpisodeSeason = ListSourceGroups.Facts(single);
        oneEpisodeSeason.SeasonEpisodes[(103516, 3)] = 1;
        Assert.Equal(PlaceholderKinds.Season, Assert.Single(ListSourceGroups.Group(single.Select((item, i) => (item, i)).ToList(), oneEpisodeSeason)).Kind);
    }

    [Fact]
    public async Task F23_TheSyncOnlyAddsASeasonPlaceholderWhenTmdbConfirmsTheRunIsTheWholeSeason()
    {
        using var w = new World();
        w.H.Fetcher.Exact = true;
        w.H.Fetcher.Provider = "chronolists";
        w.H.Lookup.AddShow(Tv(5, "Soap", "2020-01-01"), new SeasonFacts(1, 10, "2020-01-01", "Season 1"));
        w.H.Lookup.AddShow(Tv(6, "Opera", "2020-01-01"), new SeasonFacts(1, 3, "2020-01-01", "Season 1"));
        static SourceItem Opera(int e) => new("tv", 6, null, 1006, "Opera", 2020, 1, e, null) { Details = new SourceItemDetails("Ep " + e, "2020-01-01", null, null, "Season 1") };
        // Soap: E1–E3 of a 10-episode season (the list has nothing later); Opera: all three episodes of its season.
        w.H.Fetcher.Items = new List<SourceItem> { Soap(1), Soap(2), Soap(3), Film(1), Opera(1), Opera(2), Opera(3) };
        await w.Link(url: ChronoUrl);

        Assert.Equal("ok", (await w.Sync()).State);

        var soap = w.Doc.Items.Single(p => p.TmdbId == 5);
        Assert.Equal((PlaceholderKinds.Episodes, 3), (soap.Kind, soap.Episodes.Count));
        Assert.Equal(PlaceholderKinds.Season, w.Doc.Items.Single(p => p.TmdbId == 6).Kind);
    }

    // ── F30: an import entry's own key must be in the fetched list ────────────────

    [Fact]
    public void F30_AnImportEntryWhoseKeyIsNotInTheFetchedListIsNotOwned()
    {
        var spec = new SourceLinkSpec("list", Url, "mdblist", "DC", true, true)
        {
            Keys = new HashSet<string>(StringComparer.Ordinal) { "movie|1||", "movie|2||" },
        };
        var entries = new List<ApplyEntry> { new(0, null, Movie(1)), new(1, null, Movie(999)), new(2, null, Movie(2)) };
        var keys = new Dictionary<int, string> { [0] = "movie|1||", [1] = "movie|999||", [2] = "movie|2||" };
        var sent = new Dictionary<int, IReadOnlyList<string>> { [2] = new[] { "movie|2||", "movie|998||" } };

        var plan = ListSourceService.PlanImportKeys(spec, entries, keys, sent, new[] { "movie|1||", "movie|999||", "movie|2||" });

        Assert.Equal(new[] { "movie|1||" }, plan.EntryKeys[0]);
        Assert.False(plan.EntryKeys.ContainsKey(1)); // added as present: never owned, never removed by a sync
        Assert.Equal(new[] { "movie|2||" }, plan.EntryKeys[2]);
        Assert.Equal(new[] { "movie|1||", "movie|2||" }, plan.SnapshotKeys); // sent, not skipped: never declined
    }
}
