using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Moq;

namespace JE.Tests;

// Track 4c2a review round 3 (4c2-R3-6, 4c2-R3-7; D53 rule 2 at the candidate): identity is completed ONCE, on the
// candidate or source entry, and every consumer takes the completed ids: the physical-title check, "in library",
// Spoiler Guard, the review's ids, the placeholder built from the candidate and the snapshot keys. Each runs through the
// production modules: the resolver and the source preview, the real Spoiler Guard viewer policy, the real library
// lookup (ListResolver over the list host) and the real physical reader over an in-memory library. The library's only
// copy of a title carries an id the candidate isn't known by, so only a completed identity reaches it.
[Collection("Plugin singleton")]
public class ListsImportIdentityR3Tests
{
    private static readonly CancellationToken None = CancellationToken.None;

    private const int ArrowTmdb = 1412;
    private const int ArrowTvdb = 257655;
    private const string ArrowImdb = "tt2193021";
    private const int SteelTmdb = 49521;
    private const string SteelImdb = "tt0770828";

    /// <summary>
    /// One household: the list host (Spoiler Guard's and "in library"'s view of the library) and the in-memory library
    /// of the production physical reader hold the same copies; Spoiler Guard is on, the viewer policy is the production one.
    /// </summary>
    private sealed class World : IDisposable
    {
        public World()
        {
            H = new ImportHarness(realLibrary: true, physical: h => Reader(h, Library));
            Viewer = H.NewUser("viewer");
            Admin = H.NewUser("admin", admin: true);
            var logger = H.Plugin.Core.Logger;
            H.Plugin.Plugin.Configuration.SpoilerBlurEnabled = true;
            var spoilers = new SpoilerUserResolver(H.Plugin.Core.Manager, Mock.Of<ILibraryManager>(), logger, null!);
            var policy = new UserImportViewerPolicy(H.Plugin.Core.Manager, H.Host, logger, spoilers);
            var physical = Reader(H, Library);
            Resolver = new ListImportResolver(H.Lookup, new ResolverListLibraryLookup(H.Lists.Resolver, H.Host), H.Access, H.Limiter, logger, policy, physical);
            Preview = new ListSourcePreview(H.Fetcher, Resolver, H.Access, logger, policy, physical);
            Titles();
        }

        public ListsImportIdentityTests.Library Library { get; } = new();
        public ImportHarness H { get; }
        public User Viewer { get; }
        public User Admin { get; }
        public ListImportResolver Resolver { get; }
        public ListSourcePreview Preview { get; }

        /// <summary>A series copy carrying only the given ids (in the list host and the physical library alike).</summary>
        public Guid Series(int? tmdb, int? tvdb, string? imdb, bool hidden, params (int S, int E)[] episodes)
        {
            var id = H.Host.AddSeries(tmdb, tvdb, imdb);
            var copy = Library.Add(new Series { Name = "Arrow" }, Ids(tmdb, tvdb, imdb));
            foreach (var group in episodes.GroupBy(e => e.S))
            {
                var season = Library.Season(copy, group.Key);
                foreach (var (s, e) in group)
                {
                    H.Host.AddEpisode(id, s, e);
                    Library.Episode(season, e);
                }
            }

            if (hidden)
            {
                H.Host.Hide(id, Viewer);
                Library.HideFrom(Viewer, copy);
            }

            return id;
        }

        /// <summary>A movie copy carrying only the given ids.</summary>
        public Guid Movie(int? tmdb, string? imdb, bool hidden)
        {
            var id = H.Host.AddMovie(tmdb, imdb);
            var copy = Library.Add(new Movie { Name = "Man of Steel" }, Ids(tmdb, null, imdb));
            if (hidden)
            {
                H.Host.Hide(id, Viewer);
                Library.HideFrom(Viewer, copy);
            }

            return id;
        }

        /// <summary>The viewer turned Spoiler Guard on for this library copy (a series or a movie).</summary>
        public void Guard(Guid copy, bool movie)
        {
            var state = new UserSpoilerBlur();
            var key = copy.ToString("N");
            if (movie)
            {
                state.Movies[key] = new SpoilerBlurMovieEntry { MovieId = key };
            }
            else
            {
                state.Series[key] = new SpoilerBlurSeriesEntry { SeriesId = key };
            }

            var user = Viewer.Id.ToString("N");
            H.Plugin.Core.Manager.SaveUserConfiguration(user, "spoilerblur.json", state);
            SpoilerUserResolver.InvalidateUser(user);
        }

        public async Task<ResolveResponse> Resolve(User user, params ImportEntryDto[] entries) =>
            (await Resolver.ResolveAsync(entries, new ImportResolveOptions
            {
                Caller = user,
                LibraryUsers = new[] { user },
                Context = new ImportCallContext(user.Id.ToString("N"), false),
                EmptyRetryDelay = TimeSpan.FromMilliseconds(1),
            }, None)).Response;

        public async Task<SourceFetchResponse> Fetch(User user, string url) =>
            ImportHarness.Ok<SourceFetchResponse>(await Preview.FetchAsync(user, new SourceFetchRequest { Url = url }, None));

        public void Dispose()
        {
            H.Plugin.Plugin.Configuration.SpoilerBlurEnabled = false;
            SpoilerUserResolver.InvalidateUser(Viewer.Id.ToString("N"));
            H.Dispose();
        }

        // Arrow (TMDB 1412, TVDB 257655, IMDb tt2193021) and Man of Steel (TMDB 49521, IMDb tt0770828), as the title
        // lookup knows them: searchable by title and by each external id, details with every id.
        private void Titles()
        {
            var arrow = new TitleHit("tv", ArrowTmdb, "Arrow", null, "2012-10-10", null, "Oliver Queen comes home.", 10, 5000);
            foreach (var query in new[] { "Arrow", "tvdb:" + ArrowTvdb, "imdb:" + ArrowImdb })
            {
                H.Lookup.AddSearch(query, arrow);
            }

            H.Lookup.Details[("tv", ArrowTmdb)] = new TitleDetails(arrow, ArrowImdb, ArrowTvdb, "Ended", false, new[] { new SeasonFacts(1, 23, "2012-10-10", "Season 1") });
            H.Lookup.Seasons[(ArrowTmdb, 1)] = Enumerable.Range(1, 23).Select(e => new EpisodeFacts(1, e, "Episode title " + e, "2012-10-1" + (e % 10))).ToList();

            var steel = new TitleHit("movie", SteelTmdb, "Man of Steel", null, "2013-06-12", null, "Clark Kent finds out.", 10, 16680);
            foreach (var query in new[] { "Man of Steel", "imdb:" + SteelImdb })
            {
                H.Lookup.AddSearch(query, steel);
            }

            H.Lookup.Details[("movie", SteelTmdb)] = new TitleDetails(steel, SteelImdb, null, "Released", false, Array.Empty<SeasonFacts>());
        }

        private static (string, string)[] Ids(int? tmdb, int? tvdb, string? imdb)
        {
            var ids = new List<(string, string)>();
            if (tmdb.HasValue)
            {
                ids.Add(("Tmdb", tmdb.Value.ToString(System.Globalization.CultureInfo.InvariantCulture)));
            }

            if (tvdb.HasValue)
            {
                ids.Add(("Tvdb", tvdb.Value.ToString(System.Globalization.CultureInfo.InvariantCulture)));
            }

            if (imdb != null)
            {
                ids.Add(("Imdb", imdb));
            }

            return ids.ToArray();
        }
    }

    private static IImportPhysicalTitles Reader(ImportHarness h, ListsImportIdentityTests.Library library)
    {
        var physical = new NativeDetailsLibrary(library.Manager.Object, null, null);
#if !NET9_0
        var users = new Mock<IUserManager>();
        var parental = new SeerrParentalFilter(new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("{}", 404))),
            users.Object, Mock.Of<MediaBrowser.Model.Globalization.ILocalizationManager>(), Mock.Of<MediaBrowser.Controller.Configuration.IServerConfigurationManager>(), h.Plugin.Core.Logger);
        var policy = new NativeDetailsPolicy(parental, Mock.Of<INativeDetailsSource>(), Mock.Of<Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.IJellyfinLibraryAccess>(), null, null, physical);
        return new LibraryImportPhysicalTitles(policy);
#else
        _ = h;
        return new LibraryImportPhysicalTitles(physical, Mock.Of<Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.IArrJellyfinView>());
#endif
    }

    private static ImportEntryDto E(string title, int? year = null, string? type = null, int? season = null, ImportIdsDto? ids = null, params (int S, int E)[] episodes) => new()
    {
        Title = title,
        Year = year,
        TypeHint = type,
        Season = season,
        Ids = ids,
        Episodes = episodes.Length == 0 ? null : episodes.Select(e => new ImportEpisodeDto { S = e.S, E = e.E }).ToList(),
    };

    // ── 4c2-R3-6: Spoiler Guard by every id ─────────────────────────────

    [Fact]
    public async Task ASeriesGuardedThroughACopyCarryingOnlyItsTvdbIdIsGuarded()
    {
        using var w = new World();
        var copy = w.Series(null, ArrowTvdb, null, hidden: false, (1, 1));
        w.Guard(copy, movie: false);

        var response = await w.Resolve(w.Viewer, E("Arrow", type: "tv"), E("Arrow", type: "tv", season: 1, episodes: (1, 1)));

        var series = response.Results[0].Match!;
        var episode = response.Results[1].Match!;
        Assert.Equal(ArrowTmdb, series.TmdbId);
        Assert.True(series.SpoilerGuarded == true, "Arrow is guarded through its TVDB-only library copy, but the review showed its overview");
        Assert.Null(series.Overview);
        Assert.True(episode.SpoilerGuarded == true);
        Assert.All(episode.Episodes!, e => Assert.Null(e.Title));
        Assert.DoesNotContain("Oliver Queen", JsonSerializer.Serialize(response), StringComparison.Ordinal);
        Assert.DoesNotContain("Episode title", JsonSerializer.Serialize(response), StringComparison.Ordinal);
    }

    [Fact]
    public async Task AMovieGuardedThroughACopyCarryingOnlyItsImdbIdIsGuarded()
    {
        using var w = new World();
        var copy = w.Movie(null, SteelImdb, hidden: false);
        w.Guard(copy, movie: true);

        var response = await w.Resolve(w.Viewer, E("Man of Steel", 2013, "movie"));

        var match = response.Results[0].Match!;
        Assert.Equal(SteelTmdb, match.TmdbId);
        Assert.True(match.SpoilerGuarded == true, "Man of Steel is guarded through its IMDb-only library copy, but the review showed its overview");
        Assert.Null(match.Overview);
    }

    [Fact]
    public async Task AGuardedTitleTheViewerDoesntGuardStaysUnguarded()
    {
        using var w = new World();
        var other = w.Series(null, 999999, null, hidden: false);
        w.Guard(other, movie: false);
        w.Series(null, ArrowTvdb, null, hidden: false);

        var response = await w.Resolve(w.Viewer, E("Arrow", type: "tv"));

        Assert.Null(response.Results[0].Match!.SpoilerGuarded);
        Assert.Equal("Oliver Queen comes home.", response.Results[0].Match!.Overview);
    }

    // ── 4c2-R3-7: "in library" by every id ──────────────────────────────

    [Fact]
    public async Task AnOwnedMovieHeldOnlyUnderItsImdbIdIsInTheLibraryWhenFoundByATitleSearch()
    {
        using var w = new World();
        var copy = w.Movie(null, SteelImdb, hidden: false);

        var response = await w.Resolve(w.Viewer, E("Man of Steel", 2013, "movie"));

        var match = response.Results[0].Match!;
        Assert.Equal(SteelTmdb, match.TmdbId);
        Assert.True(match.InLibrary != null, "Man of Steel is in the library under its IMDb id, but the review offered it as missing");
        Assert.Equal(copy.ToString("N"), match.InLibrary!.ItemId);
        Assert.Equal(SteelImdb, match.ImdbId);
    }

    // ── The completion runs once, before the consumers ──────────────────

    [Fact]
    public async Task OneCompletionPerIdentityServesEveryEntryAndConsumerOfACall()
    {
        using var w = new World();
        var copy = w.Movie(null, SteelImdb, hidden: false);
        w.Guard(copy, movie: true);

        var response = await w.Resolve(w.Viewer, E("Man of Steel", 2013, "movie"), E("Man of Steel", type: "movie"), E(string.Empty, type: "movie", ids: new ImportIdsDto { Tmdb = SteelTmdb, TmdbType = "movie" }));

        Assert.All(response.Results, r => Assert.True(r.Match!.InLibrary != null && r.Match.SpoilerGuarded == true && r.Match.ImdbId == SteelImdb));
        // The two title searches complete through one details lookup; the explicit TMDB entry brings its own details.
        Assert.Equal(2, w.H.Lookup.Log.Count(l => l == "details:movie/" + SteelTmdb));
    }

    [Fact]
    public void ACandidateWithoutACompletedIdentityIsGuardedAndBuildsNoPlaceholder()
    {
        var raw = new ImportCandidateDto { MediaType = "movie", TmdbId = SteelTmdb, Title = "Man of Steel", Overview = "Clark Kent finds out." };
        var viewer = new ImportViewer(new HashSet<string>(), _ => false);

        viewer.Apply(raw);

        Assert.True(raw.SpoilerGuarded);
        Assert.Null(raw.Overview);
        Assert.Null(ImportPlaceholders.FromCandidate(raw, PlaceholderKinds.Movie, null, null, null));
    }

    // ── The consumer table: every consumer sees the completed identity ──

    /// <summary>How a candidate is known (the cell) and which single id the library's only copy carries.</summary>
    public enum Known
    {
        /// <summary>A series named by its TVDB id only; the copy carries only its IMDb id.</summary>
        SeriesByTvdb,

        /// <summary>A series named by its IMDb id only; the copy carries only its TVDB id.</summary>
        SeriesByImdb,

        /// <summary>A movie found by a title search (TMDB only); the copy carries only its IMDb id.</summary>
        MovieByTitle,

        /// <summary>A movie named by its IMDb id only; the copy carries only its TMDB id.</summary>
        MovieByImdb,

        /// <summary>A watch-order episode (exact source, TMDB only); the copy carries only its TVDB id.</summary>
        WatchOrderEpisode,
    }

    /// <summary>The consumers of a candidate's identity.</summary>
    public enum Consumer
    {
        Physical,
        InLibrary,
        SpoilerGuard,
        ReviewIds,
        Placeholder,
        SnapshotKeys,
    }

    public static IEnumerable<object[]> Table() =>
        from known in Enum.GetValues<Known>()
        from consumer in Enum.GetValues<Consumer>()
        select new object[] { known, consumer };

    [Theory]
    [MemberData(nameof(Table))]
    public async Task EveryConsumerSeesTheCompletedIdentity(Known known, Consumer consumer)
    {
        using var w = new World();
        var movie = known is Known.MovieByTitle or Known.MovieByImdb;
        var hidden = consumer is Consumer.Physical or Consumer.SnapshotKeys;
        var copy = known switch
        {
            Known.SeriesByTvdb => w.Series(null, null, ArrowImdb, hidden, (1, 1)),
            Known.SeriesByImdb => w.Series(null, ArrowTvdb, null, hidden, (1, 1)),
            Known.MovieByTitle => w.Movie(null, SteelImdb, hidden),
            Known.MovieByImdb => w.Movie(SteelTmdb, null, hidden),
            _ => w.Series(null, ArrowTvdb, null, hidden, (1, 1)),
        };
        if (consumer == Consumer.SpoilerGuard)
        {
            w.Guard(copy, movie);
        }

        var tmdb = movie ? SteelTmdb : ArrowTmdb;
        if (known == Known.WatchOrderEpisode || consumer == Consumer.SnapshotKeys)
        {
            await SourceCell(w, known, consumer, tmdb, copy);
            return;
        }

        var entry = known switch
        {
            Known.SeriesByTvdb => E(string.Empty, type: "tv", ids: new ImportIdsDto { Tvdb = ArrowTvdb }),
            Known.SeriesByImdb => E(string.Empty, type: "tv", ids: new ImportIdsDto { Imdb = ArrowImdb }),
            Known.MovieByTitle => E("Man of Steel", 2013, "movie"),
            _ => E(string.Empty, type: "movie", ids: new ImportIdsDto { Imdb = SteelImdb }),
        };
        var forViewer = await w.Resolve(w.Viewer, entry);
        var match = forViewer.Results[0].Match;
        switch (consumer)
        {
            case Consumer.Physical:
                Assert.False(forViewer.Results[0].Candidates.Any(c => c.TmdbId == tmdb), $"{known}: held where the viewer can't look, but offered as absent");
                Assert.Equal(tmdb, (await w.Resolve(w.Admin, entry)).Results[0].Match!.TmdbId);
                break;
            case Consumer.InLibrary:
                Assert.True(match?.InLibrary?.ItemId == copy.ToString("N"), $"{known}: in the library, but offered as missing");
                break;
            case Consumer.SpoilerGuard:
                Assert.True(match?.SpoilerGuarded == true, $"{known}: guarded through its library copy, but not guarded in the review");
                Assert.Null(match!.Overview);
                break;
            case Consumer.ReviewIds:
                AssertCompleted(known, match!.TmdbId, match.TvdbId, match.ImdbId);
                break;
            case Consumer.Placeholder:
                var placeholder = ImportPlaceholders.FromCandidate(match!, movie ? PlaceholderKinds.Movie : PlaceholderKinds.Series, null, null, null)!;
                AssertCompleted(known, placeholder.TmdbId, placeholder.TvdbId, placeholder.ImdbId);
                break;
        }
    }

    // A source entry known the same way: the snapshot keys (non-exact sources), or the prepared candidate of a watch order.
    private static async Task SourceCell(World w, Known known, Consumer consumer, int tmdb, Guid copy)
    {
        SourceItem item;
        string url;
        if (known == Known.WatchOrderEpisode)
        {
            w.H.Fetcher.Exact = true;
            w.H.Fetcher.Provider = "chronolists";
            url = "https://chronolists.com/dctv";
            item = new SourceItem("tv", ArrowTmdb, null, null, "Arrow", 2012, 1, 1, null) { Details = new SourceItemDetails("Episode title 1", "2012-10-10", "/a.jpg", "An overview", "Season 1") };
        }
        else
        {
            url = "https://mdblist.com/lists/a/b";
            item = known switch
            {
                Known.SeriesByTvdb => new SourceItem("tv", null, null, ArrowTvdb, "Arrow", 2012, null, null, null),
                Known.SeriesByImdb => new SourceItem("tv", null, ArrowImdb, null, "Arrow", 2012, null, null, null),
                Known.MovieByTitle => new SourceItem("movie", SteelTmdb, null, null, "Man of Steel", 2013, null, null, null),
                _ => new SourceItem("movie", null, SteelImdb, null, "Man of Steel", 2013, null, null, null),
            };
        }

        var other = new SourceItem("movie", 1, null, null, "Other", 2001, null, null, null);
        w.H.Lookup.Details[("movie", 1)] = new TitleDetails(new TitleHit("movie", 1, "Other", null, "2001-01-01", null, null, 1, 1), "tt0000002", null, "Released", false, Array.Empty<SeasonFacts>());
        w.H.Fetcher.Items = new List<SourceItem> { item, other };
        var key = item.Key!;

        if (consumer is Consumer.Physical or Consumer.SnapshotKeys)
        {
            var forViewer = await w.Fetch(w.Viewer, url);
            var forAdmin = await w.Fetch(w.Admin, url);
            var viewerKeys = forViewer.Grouped ? forViewer.SnapshotKeys! : forViewer.Entries.Select(e => e.SourceKey!).ToList();
            var adminKeys = forAdmin.Grouped ? forAdmin.SnapshotKeys! : forAdmin.Entries.Select(e => e.SourceKey!).ToList();
            Assert.DoesNotContain(key, viewerKeys);
            Assert.DoesNotContain(key, JsonSerializer.Serialize(forViewer), StringComparison.Ordinal);
            Assert.True(forViewer.CountsHidden);
            Assert.Null(forViewer.Snapshot);
            Assert.Contains(key, adminKeys);
            return;
        }

        var response = await w.Fetch(w.Viewer, url);
        var prepared = response.Entries.Single(e => e.SourceKey == key).Prepared!.Match!;
        switch (consumer)
        {
            case Consumer.InLibrary:
                Assert.True(prepared.InLibrary != null, $"{known}: in the library, but the prepared entry says missing");
                break;
            case Consumer.SpoilerGuard:
                Assert.True(prepared.SpoilerGuarded == true, $"{known}: guarded through its library copy, but the prepared entry isn't");
                Assert.All(prepared.Episodes!, e => Assert.Null(e.Title));
                break;
            case Consumer.ReviewIds:
                AssertCompleted(known, prepared.TmdbId, prepared.TvdbId, prepared.ImdbId);
                break;
            case Consumer.Placeholder:
                var placeholder = ImportPlaceholders.FromCandidate(prepared, PlaceholderKinds.Episodes, 1, new[] { 1 }, null)!;
                AssertCompleted(known, placeholder.TmdbId, placeholder.TvdbId, placeholder.ImdbId);
                break;
        }

        _ = tmdb;
        _ = copy;
    }

    private static void AssertCompleted(Known known, int? tmdb, int? tvdb, string? imdb)
    {
        var movie = known is Known.MovieByTitle or Known.MovieByImdb;
        Assert.Equal(movie ? SteelTmdb : ArrowTmdb, tmdb);
        Assert.True((movie ? null : (int?)ArrowTvdb) == tvdb, $"{known}: TVDB id {tvdb?.ToString() ?? "none"}, not the completed one");
        Assert.True((movie ? SteelImdb : ArrowImdb) == imdb, $"{known}: IMDb id {imdb ?? "none"}, not the completed one");
    }
}
