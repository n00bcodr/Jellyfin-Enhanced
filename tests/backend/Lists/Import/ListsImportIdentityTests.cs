using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Moq;
using static JE.Tests.FakeImportLookup;

namespace JE.Tests;

// Track 4c2a review round 2 (4c2-R2-B1; D53 rule 2, identity by every known id): the physical-title check is asked with
// every id a candidate or source entry carries (TMDB, TVDB, IMDb; the season and episode scope), through the PRODUCTION
// reader (NativeDetailsPolicy on 12, NativeDetailsLibrary on 10.11) over an in-memory library whose only copy of a title
// is held under its TVDB or IMDb id, in a library the viewer can't open. Such a title, season or episode is never offered
// as absent: not as a candidate (top, alternative or not enriched), and not as a source entry; the admin still gets it.
[Collection("Plugin singleton")]
public class ListsImportIdentityTests
{
    private static readonly CancellationToken None = CancellationToken.None;

    /// <summary>
    /// The library as Jellyfin answers the production reader: items with their provider ids (any library, no user on the
    /// query; HasAnyProviderId matches any one of the ids; HasTmdbId/HasTvdbId/HasImdbId filter on a provider being set),
    /// seasons and episodes under their parents, and per-viewer visibility (GetItemById with the user).
    /// </summary>
    internal sealed class Library
    {
        private readonly List<BaseItem> _items = new();
        private readonly Dictionary<Guid, HashSet<Guid>> _hiddenFrom = new();

        public Mock<ILibraryManager> Manager { get; } = new();

        public Library()
        {
            Manager.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns<InternalItemsQuery>(Query);
            Manager.Setup(l => l.GetItemById<BaseItem>(It.IsAny<Guid>(), It.IsAny<User>()))
                .Returns<Guid, User>((id, user) => _items.FirstOrDefault(i => i.Id == id) is { } item && !(_hiddenFrom.TryGetValue(id, out var users) && users.Contains(user.Id)) ? item : null);
        }

        public T Add<T>(T item, params (string Provider, string Id)[] ids)
            where T : BaseItem
        {
            item.Id = Guid.NewGuid();
            foreach (var (provider, id) in ids)
            {
                item.ProviderIds[provider] = id;
            }

            _items.Add(item);
            return item;
        }

        public Season Season(Series series, int number) => Add(new Season { Name = "Season " + number, IndexNumber = number, SeriesId = series.Id });

        public Episode Episode(Season season, int number) => Add(new Episode { Name = "E" + number, IndexNumber = number, ParentIndexNumber = season.IndexNumber, SeasonId = season.Id, SeriesId = season.SeriesId });

        /// <summary>The viewer can't open the item (nor what sits under it: Jellyfin's own access check walks the parents).</summary>
        public void HideFrom(User viewer, params BaseItem[] items)
        {
            foreach (var item in items)
            {
                foreach (var under in _items.Where(i => i.Id == item.Id || (i is Season s && s.SeriesId == item.Id) || (i is Episode e && (e.SeriesId == item.Id || e.SeasonId == item.Id))))
                {
                    if (!_hiddenFrom.TryGetValue(under.Id, out var users))
                    {
                        _hiddenFrom[under.Id] = users = new HashSet<Guid>();
                    }

                    users.Add(viewer.Id);
                }
            }
        }

        private List<BaseItem> Query(InternalItemsQuery q)
        {
            IEnumerable<BaseItem> items = _items;
            if (q.IncludeItemTypes is { Length: > 0 } types)
            {
                items = items.Where(i => types.Contains(i.GetBaseItemKind()));
            }

            if (q.HasAnyProviderId is { Count: > 0 } any)
            {
                items = items.Where(i => any.Any(p => i.ProviderIds.TryGetValue(p.Key, out var v) && string.Equals(v, p.Value, StringComparison.OrdinalIgnoreCase)));
            }

            items = Has(items, q.HasTmdbId, "Tmdb");
            items = Has(items, q.HasTvdbId, "Tvdb");
            items = Has(items, q.HasImdbId, "Imdb");
            if (q.AncestorIds is { Length: > 0 } ancestors)
            {
                items = items.Where(i => i is Season s ? ancestors.Contains(s.SeriesId) : i is Episode e && (ancestors.Contains(e.SeasonId) || ancestors.Contains(e.SeriesId)));
            }

            if (q.Limit is int limit)
            {
                items = items.Take(limit);
            }

            return items.ToList();
        }

        private static IEnumerable<BaseItem> Has(IEnumerable<BaseItem> items, bool? wanted, string provider) =>
            wanted is bool has ? items.Where(i => (i.ProviderIds.TryGetValue(provider, out var v) && !string.IsNullOrEmpty(v)) == has) : items;
    }

    private static IImportPhysicalTitles Reader(ImportHarness h, Library library)
    {
        var physical = new NativeDetailsLibrary(library.Manager.Object, null, null);
#if !NET9_0
        var users = new Mock<IUserManager>();
        var parental = new Jellyfin.Plugin.JellyfinEnhanced.Services.SeerrParentalFilter(new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("{}", 404))),
            users.Object, Mock.Of<MediaBrowser.Model.Globalization.ILocalizationManager>(), Mock.Of<MediaBrowser.Controller.Configuration.IServerConfigurationManager>(), h.Plugin.Core.Logger);
        var policy = new NativeDetailsPolicy(parental, Mock.Of<INativeDetailsSource>(), Mock.Of<Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.IJellyfinLibraryAccess>(), null, null, physical);
        return new LibraryImportPhysicalTitles(policy);
#else
        _ = h;
        return new LibraryImportPhysicalTitles(physical, Mock.Of<Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.IArrJellyfinView>());
#endif
    }

    private sealed class Household : IDisposable
    {
        public Household()
        {
            H = new ImportHarness(physical: h => Reader(h, Library));
            Viewer = H.NewUser("viewer");
            Admin = H.NewUser("admin", admin: true);
        }

        public Library Library { get; } = new();
        public ImportHarness H { get; }
        public User Viewer { get; }
        public User Admin { get; }

        public void Dispose() => H.Dispose();
    }

    private static ImportEntryDto E(string title, int? year = null, string? type = null, int? season = null, params (int S, int E)[] episodes) => new()
    {
        Title = title,
        Year = year,
        TypeHint = type,
        Season = season,
        Episodes = episodes.Length == 0 ? null : episodes.Select(e => new ImportEpisodeDto { S = e.S, E = e.E }).ToList(),
    };

    private static async Task<ResolveResponse> Resolve(ImportHarness h, User user, params ImportEntryDto[] entries) =>
        (await h.ImportResolver.ResolveAsync(entries, new ImportResolveOptions
        {
            Caller = user,
            LibraryUsers = new[] { user },
            Context = new ImportCallContext(user.Id.ToString("N"), false),
            EmptyRetryDelay = TimeSpan.FromMilliseconds(1),
        }, None)).Response;

    private static bool Offers(ResolveResponse response, int tmdb) => response.Results.Any(r => r.Candidates.Any(c => c.TmdbId == tmdb));

    private static void Arrow(ImportHarness h, int seasons = 2)
    {
        var arrow = Tv(1412, "Arrow", "2012-10-10", 5000);
        h.Lookup.AddSearch("Arrow", arrow);
        h.Lookup.Details[("tv", 1412)] = new TitleDetails(arrow, "tt2193021", 257655, "Ended", false,
            Enumerable.Range(1, seasons).Select(s => new SeasonFacts(s, 23, (2011 + s) + "-10-10", "Season " + s)).ToList());
        h.Lookup.Seasons[(1412, 1)] = Enumerable.Range(1, 23).Select(e => new EpisodeFacts(1, e, "Ep " + e, "2012-11-01")).ToList();
    }

    // ── Candidates ──────────────────────────────────────────────────────

    [Fact]
    public async Task ASeriesHeldOnlyUnderItsTvdbIdInALibraryTheViewerCantOpenIsNeverACandidate()
    {
        using var t = new Household();
        Arrow(t.H);
        var copy = t.Library.Add(new Series { Name = "Arrow" }, ("Tvdb", "257655"));
        t.Library.HideFrom(t.Viewer, copy);

        var forViewer = await Resolve(t.H, t.Viewer, E("Arrow", null, "tv"));
        var forAdmin = await Resolve(t.H, t.Admin, E("Arrow", null, "tv"));

        Assert.False(Offers(forViewer, 1412), "Arrow, held only under TVDB 257655 where the viewer can't look, was offered as absent");
        Assert.DoesNotContain("1412", JsonSerializer.Serialize(forViewer), StringComparison.Ordinal);
        Assert.True(Offers(forAdmin, 1412));
    }

    [Fact]
    public async Task AMovieHeldOnlyUnderItsImdbIdIsNeverACandidateEvenFromATitleSearch()
    {
        using var t = new Household();
        var hit = Movie(49521, "Man of Steel", "2013-06-12", 16680);
        t.H.Lookup.AddSearch("Man of Steel", hit);
        t.H.Lookup.Details[("movie", 49521)] = new TitleDetails(hit, "tt0770828", null, "Released", false, Array.Empty<SeasonFacts>());
        var copy = t.Library.Add(new Movie { Name = "Man of Steel" }, ("Imdb", "tt0770828"));
        t.Library.HideFrom(t.Viewer, copy);

        var forViewer = await Resolve(t.H, t.Viewer, E("Man of Steel", 2013, "movie"));
        var forAdmin = await Resolve(t.H, t.Admin, E("Man of Steel", 2013, "movie"));

        Assert.False(Offers(forViewer, 49521));
        Assert.True(Offers(forAdmin, 49521));
    }

    [Fact]
    public async Task AnAlternativeHeldOnlyUnderItsTvdbIdIsLeftOutAndTheOtherStays()
    {
        using var t = new Household();
        Arrow(t.H);
        var flash = Tv(60735, "The Flash", "2014-10-07", 9000);
        t.H.Lookup.AddSearch("The Flash", flash);
        t.H.Lookup.Details[("tv", 60735)] = new TitleDetails(flash, "tt3107288", 279121, "Ended", false, Array.Empty<SeasonFacts>());
        var copy = t.Library.Add(new Series { Name = "Arrow" }, ("Tvdb", "257655"));
        t.Library.HideFrom(t.Viewer, copy);
        var line = E("Arrow or The Flash", null, "tv");
        line.Alternatives = new List<ImportAlternativeDto> { new() { Title = "Arrow" }, new() { Title = "The Flash" } };

        var response = await Resolve(t.H, t.Viewer, line);

        Assert.Equal(new[] { 60735 }, response.Results[0].Candidates.Select(c => c.TmdbId).Distinct());
    }

    [Fact]
    public async Task ASeasonAndAnEpisodeHeldOnlyUnderATvdbCopyAreNeverOfferedAsAbsent()
    {
        using var t = new Household();
        Arrow(t.H);
        // The viewer's own copy (TMDB-tagged) holds season 1 episodes 1–4; a second copy, only under TVDB and in a library
        // the viewer can't open, holds season 1 episode 5 and season 2.
        var mine = t.Library.Add(new Series { Name = "Arrow" }, ("Tmdb", "1412"));
        var mineS1 = t.Library.Season(mine, 1);
        foreach (var e in Enumerable.Range(1, 4))
        {
            t.Library.Episode(mineS1, e);
        }

        var hidden = t.Library.Add(new Series { Name = "Arrow" }, ("Tvdb", "257655"));
        var hiddenS1 = t.Library.Season(hidden, 1);
        t.Library.Episode(hiddenS1, 5);
        t.Library.Episode(t.Library.Season(hidden, 2), 1);
        t.Library.HideFrom(t.Viewer, hidden);
        var lines = new[] { E("Arrow", null, "tv", season: 2), E("Arrow", null, "tv", 1, (1, 5)), E("Arrow", null, "tv", 1, (1, 4)) };

        var forViewer = await Resolve(t.H, t.Viewer, lines);
        var forAdmin = await Resolve(t.H, t.Admin, lines);

        Assert.Equal(new[] { false, false, true }, forViewer.Results.Select(r => r.Candidates.Any(c => c.TmdbId == 1412)));
        Assert.All(forAdmin.Results, r => Assert.Equal(1412, r.Match!.TmdbId));
    }

    [Fact]
    public async Task AVisibleCopyUnderAnotherIdKeepsTheTitleOffered()
    {
        using var t = new Household();
        Arrow(t.H);
        t.Library.Add(new Series { Name = "Arrow" }, ("Tvdb", "257655")); // visible to everyone

        var forViewer = await Resolve(t.H, t.Viewer, E("Arrow", null, "tv"));

        Assert.True(Offers(forViewer, 1412));
    }

    // ── Source entries ──────────────────────────────────────────────────

    [Fact]
    public async Task SourceEntriesAreCheckedUnderEveryIdTheyCarry()
    {
        using var t = new Household();
        Arrow(t.H);
        var manOfSteel = Movie(49521, "Man of Steel", "2013-06-12");
        t.H.Lookup.Details[("movie", 49521)] = new TitleDetails(manOfSteel, "tt0770828", null, "Released", false, Array.Empty<SeasonFacts>());
        t.H.Lookup.AddSearch("imdb:tt0770828", manOfSteel);
        var arrow = t.Library.Add(new Series { Name = "Arrow" }, ("Tvdb", "257655"));
        var steel = t.Library.Add(new Movie { Name = "Man of Steel" }, ("Imdb", "tt0770828"));
        t.Library.HideFrom(t.Viewer, arrow, steel);
        t.H.Fetcher.Items = new List<SourceItem>
        {
            new("tv", 1412, "tt2193021", 257655, "Arrow", 2012, null, null, null), // all three ids (MDBList, Trakt)
            new("movie", null, "tt0770828", null, "Man of Steel", 2013, null, null, null), // IMDb only (IMDb lists)
            new("movie", 1, null, null, "Other", 2001, null, null, null),
        };

        var forViewer = ImportHarness.Ok<SourceFetchResponse>(await t.H.Sources.FetchAsync(t.Viewer, "https://mdblist.com/lists/a/b", None));
        var forAdmin = ImportHarness.Ok<SourceFetchResponse>(await t.H.Sources.FetchAsync(t.Admin, "https://mdblist.com/lists/a/b", None));

        Assert.Equal(new[] { "movie|1||" }, forViewer.Entries.Select(e => e.SourceKey));
        Assert.True(forViewer.CountsHidden);
        Assert.Equal(3, forAdmin.Entries.Count);
    }

    [Fact]
    public async Task ATmdbOnlySourceEntryWhoseOnlyCopyIsUnderTvdbIsLeftOut()
    {
        using var t = new Household();
        Arrow(t.H);
        var arrow = t.Library.Add(new Series { Name = "Arrow" }, ("Tvdb", "257655"));
        t.Library.HideFrom(t.Viewer, arrow);
        t.H.Fetcher.Items = new List<SourceItem>
        {
            new("tv", 1412, null, null, "Arrow", 2012, null, null, null), // TMDB lists and charts carry the TMDB id only
            new("movie", 1, null, null, "Other", 2001, null, null, null),
        };

        var forViewer = ImportHarness.Ok<SourceFetchResponse>(await t.H.Sources.FetchAsync(t.Viewer, "https://www.themoviedb.org/list/7", None));

        Assert.Equal(new[] { "movie|1||" }, forViewer.Entries.Select(e => e.SourceKey));
    }

    [Fact]
    public async Task AWatchOrderEpisodeHeldOnlyUnderATvdbCopyIsLeftOut()
    {
        using var t = new Household();
        Arrow(t.H, seasons: 1);
        t.H.Lookup.AddShow(Tv(1412, "Arrow", "2012-10-10"), new SeasonFacts(1, 3, "2012-10-10", "Season 1"));
        t.H.Fetcher.Exact = true;
        t.H.Fetcher.Provider = "chronolists";
        SourceItem Ep(int e) => new("tv", 1412, null, null, "Arrow", 2012, 1, e, null) { Details = new SourceItemDetails("E" + e, "2012-10-1" + e, "/a.jpg", null, "Season 1") };
        t.H.Fetcher.Items = new List<SourceItem> { Ep(1), Ep(2), Ep(3) };
        var mine = t.Library.Add(new Series { Name = "Arrow" }, ("Tmdb", "1412"));
        var s1 = t.Library.Season(mine, 1);
        t.Library.Episode(s1, 1);
        var hidden = t.Library.Add(new Series { Name = "Arrow" }, ("Tvdb", "257655"));
        t.Library.Episode(t.Library.Season(hidden, 1), 2);
        t.Library.HideFrom(t.Viewer, hidden);
        t.H.Lookup.Details[("tv", 1412)] = new TitleDetails(Tv(1412, "Arrow", "2012-10-10"), "tt2193021", 257655, "Ended", false, new[] { new SeasonFacts(1, 3, "2012-10-10", "Season 1") });

        var response = ImportHarness.Ok<SourceFetchResponse>(await t.H.Sources.FetchAsync(t.Viewer, "https://chronolists.com/dctv", None));

        Assert.Equal(new[] { "tv|1412|1|1", "tv|1412|1|3" }, response.SnapshotKeys);
        Assert.DoesNotContain("tv|1412|1|2", JsonSerializer.Serialize(response), StringComparison.Ordinal);
    }

    // ── The completion of an identity fails (the lookup is down) ───────

    [Fact]
    public async Task ACandidateWhoseIdsCantBeCompletedLeavesItsEntryRetryableNeverOffered()
    {
        using var t = new Household();
        var hit = Movie(49521, "Man of Steel", "2013-06-12", 16680);
        t.H.Lookup.AddSearch("Man of Steel", hit);
        t.H.Lookup.TransientDetails.Add(("movie", 49521));
        var copy = t.Library.Add(new Movie { Name = "Man of Steel" }, ("Imdb", "tt0770828")); // only IMDb: the TMDB id can't find it
        t.Library.HideFrom(t.Viewer, copy);

        var response = await Resolve(t.H, t.Viewer, E("Man of Steel", 2013, "movie"));

        Assert.Equal("transient", response.Results[0].State);
        Assert.Empty(response.Results[0].Candidates);
        Assert.False(response.Complete);
    }

    [Fact]
    public async Task ASourceEntryWhoseIdsCantBeCompletedIsLeftOutWithCountsHidden()
    {
        using var t = new Household();
        t.Library.Add(new Movie { Name = "Something else" }, ("Imdb", "tt0000001")); // a copy no TMDB id can find
        t.H.Lookup.TransientDetails.Add(("movie", 49521));
        t.H.Fetcher.Items = new List<SourceItem>
        {
            new("movie", 49521, null, null, "Man of Steel", 2013, null, null, null),
            new("movie", 1, null, null, "Other", 2001, null, null, null),
        };
        t.H.Lookup.Details[("movie", 1)] = new TitleDetails(Movie(1, "Other", "2001-01-01"), "tt0000002", null, "Released", false, Array.Empty<SeasonFacts>());

        var response = ImportHarness.Ok<SourceFetchResponse>(await t.H.Sources.FetchAsync(t.Viewer, "https://mdblist.com/lists/a/b", None));

        Assert.Equal(new[] { "movie|1||" }, response.Entries.Select(e => e.SourceKey));
        Assert.True(response.CountsHidden);
    }

    [Fact]
    public async Task WhenEveryCopyCarriesATmdbIdNoIdentityIsLookedUp()
    {
        using var t = new Household();
        Arrow(t.H);
        t.Library.Add(new Series { Name = "Arrow" }, ("Tmdb", "1412"), ("Tvdb", "257655"));
        var before = t.H.Lookup.Log.Count(l => l.StartsWith("details:", StringComparison.Ordinal));

        var response = await Resolve(t.H, t.Viewer, E("Arrow", null, "tv"));

        Assert.True(Offers(response, 1412));
        // Only the resolver's own enrichment of the top TV candidate: the physical check needed no lookup.
        Assert.Equal(before + 1, t.H.Lookup.Log.Count(l => l.StartsWith("details:", StringComparison.Ordinal)));
    }
}
