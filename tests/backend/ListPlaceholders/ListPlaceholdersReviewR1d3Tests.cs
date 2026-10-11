using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Import;
using static JE.Tests.FakeImportLookup;

namespace JE.Tests;

// Review round 1 (track d3): the Seerr account cache follows the Seerr instance, "A or B" alternatives resolve
// concurrently without sharing mutable state, a namesake from another year only stops counting when the top title is
// far better known, an explicit id of the wrong type is never a sure match, and a failed season call is retried.
[Collection("Plugin singleton")]
public class ListPlaceholdersReviewR1d3Tests
{
    private static Task<ResolveResponse> Resolve(ListImportResolver resolver, Jellyfin.Database.Implementations.Entities.User user, params ImportEntryDto[] entries) =>
        resolver.ResolveAsync(entries, new ImportResolveOptions
        {
            Caller = user,
            LibraryUsers = new[] { user },
            Context = new ImportCallContext("test", false),
            EmptyRetryDelay = TimeSpan.FromMilliseconds(1),
            Deadline = TimeSpan.FromSeconds(20),
        }, CancellationToken.None).ContinueWith(t => t.Result.Response, TaskScheduler.Default);

    [Fact]
    public async Task TheSeerrAccountCacheBelongsToOneSeerrInstance()
    {
        using var plugin = new ApiPluginFixture();
        var config = plugin.Plugin.Configuration;
        var known = "c799f011678d4423bd7c07d24c672de8";
        var calls = new List<string>();
        using var transport = new IntegrationTransport((request, _) =>
        {
            lock (calls)
            {
                calls.Add(request.RequestUri!.Host + request.RequestUri.AbsolutePath);
            }

            // Only "old.test" with key "old-key" knows the user; every other instance/key answers "not found".
            var key = request.Headers.TryGetValues("X-Api-Key", out var values) ? values.Single() : null;
            if (request.RequestUri!.Host == "old.test" && key == "old-key" && request.RequestUri.AbsolutePath == "/api/v1/user/jellyfin/" + known)
            {
                return Task.FromResult(IntegrationTransport.Response("{\"id\":2,\"jellyfinUserId\":\"" + known + "\"}"));
            }

            return Task.FromResult(request.RequestUri.AbsolutePath == "/api/v1/user"
                ? IntegrationTransport.Response("{\"results\":[]}")
                : IntegrationTransport.Response("{\"message\":\"User not found.\"}", 404));
        });
        var link = new SeerrUserLink(transport, plugin.Core.Logger);
        var user = FakeListHost.MakeUser("linked");
        user.Id = Guid.ParseExact(known, "N");

        config.JellyseerrUrls = "http://old.test";
        config.JellyseerrApiKey = "old-key";
        Assert.True(await link.IsAllowedAsync(user, CancellationToken.None));
        Assert.True(await link.IsAllowedAsync(user, CancellationToken.None));
        Assert.Single(calls); // cached for this instance

        // Another Seerr: the positive answer of the old one must not carry over.
        config.JellyseerrUrls = "http://new.test";
        Assert.False(await link.IsAllowedAsync(user, CancellationToken.None));
        Assert.Contains("new.test/api/v1/user/jellyfin/" + known, calls);

        // Same URL, another key (another Seerr behind the same address, or a rotated key): asked again too.
        config.JellyseerrUrls = "http://old.test";
        config.JellyseerrApiKey = "other-key";
        Assert.False(await link.IsAllowedAsync(user, CancellationToken.None));

        // Back to the original instance: its own cached answer still serves.
        config.JellyseerrApiKey = "old-key";
        var before = calls.Count;
        Assert.True(await link.IsAllowedAsync(user, CancellationToken.None));
        Assert.Equal(before, calls.Count);
    }

    /// <summary>Answers every search empty after all <see cref="Barrier"/> participants arrived (alternatives in lockstep).</summary>
    private sealed class LockstepLookup : IImportLookup
    {
        public Barrier? Barrier { get; set; }

        public bool IsConfigured => true;

        public bool CanFindImdbEpisodes => false;

        public Task<LookupResult<IReadOnlyList<TitleHit>>> SearchAsync(string query, ImportCallContext context, CancellationToken cancellationToken) =>
            Task.Run(() =>
            {
                // Release every alternative's continuation at the same moment on its own thread.
                Barrier?.SignalAndWait(TimeSpan.FromSeconds(5));
                return new LookupResult<IReadOnlyList<TitleHit>>(LookupStatus.Ok, Array.Empty<TitleHit>());
            });

        public Task<LookupResult<TitleDetails>> GetDetailsAsync(string mediaType, int tmdbId, ImportCallContext context, CancellationToken cancellationToken) =>
            Task.FromResult(LookupResult<TitleDetails>.NotFound);

        public Task<LookupResult<IReadOnlyList<EpisodeFacts>>> GetSeasonAsync(int tvTmdbId, int season, ImportCallContext context, CancellationToken cancellationToken) =>
            Task.FromResult(LookupResult<IReadOnlyList<EpisodeFacts>>.NotFound);

        public Task<LookupResult<ImdbEpisodeFind>> FindImdbEpisodeAsync(string imdbId, CancellationToken cancellationToken) =>
            Task.FromResult(LookupResult<ImdbEpisodeFind>.NotFound);
    }

    [Fact]
    public async Task AlternativesResolvingAtTheSameMomentReportEachReasonOnce()
    {
        using var h = new ListPlaceholdersHarness();
        var user = h.NewUser("u");
        var lookup = new LockstepLookup();
        var resolver = new ListImportResolver(lookup, h.Library, h.Access, h.Limiter, h.Plugin.Core.Logger);
        // Four id-only alternatives Seerr doesn't know: each adds "notFound" right after its (simultaneous) answer.
        var entry = new ImportEntryDto
        {
            Title = "One or Two or Three or Four",
            Alternatives = Enumerable.Range(1, 4).Select(i => new ImportAlternativeDto { Ids = new ImportIdsDto { Imdb = "tt000000" + i } }).ToList(),
        };

        for (var round = 0; round < 400; round++)
        {
            lookup.Barrier = new Barrier(4);
            var result = Assert.Single((await Resolve(resolver, user, entry)).Results);
            Assert.True(result.State != "transient", $"round {round}: transient");
            Assert.Equal(new[] { "alternatives", "noMatch", "notFound" }, result.Reasons);
            lookup.Barrier.Dispose();
        }
    }

    [Fact]
    public async Task ANamesakeFromTheNextYearStillCountsUnlessTheTopTitleIsFarBetterKnown()
    {
        using var h = new ListPlaceholdersHarness();
        var user = h.NewUser("u");
        // "Dune (2020)" in a guide that means the 2021 film: an obscure 2020 "Dune" (155) beats it (144) on the year alone.
        h.Lookup.AddSearch("Dune", Movie(900001, "Dune", "2020-05-01", 10, 1), Movie(438631, "Dune", "2021-09-15", 12000, 80));
        // The well-known title with the line's year next to an unknown namesake a year off is still sure (cf. "The Flash").
        h.Lookup.AddSearch("Wonder Woman", Movie(297762, "Wonder Woman", "2017-05-30", 19000, 60), Movie(900002, "Wonder Woman", "2016-01-01", 5, 1));

        var response = await Resolve(h.ImportResolver, user, new ImportEntryDto { Title = "Dune", Year = 2020, TypeHint = "movie" }, new ImportEntryDto { Title = "Wonder Woman", Year = 2017, TypeHint = "movie" });

        var dune = response.Results[0];
        Assert.Equal(900001, dune.Match!.TmdbId);
        Assert.Equal(ImportScoring.Levels.Low, dune.Confidence); // never auto-accepted
        Assert.Contains("closeMatch", dune.Reasons);
        Assert.Equal((297762, ImportScoring.Levels.High), (response.Results[1].Match!.TmdbId, response.Results[1].Confidence));
    }

    [Fact]
    public async Task AnExplicitIdOfTheWrongTypeIsNeverASureMatch()
    {
        using var h = new ListPlaceholdersHarness();
        var user = h.NewUser("u");
        // "Peacemaker S01E08" whose IMDb link points at a film.
        h.Lookup.AddSearch("imdb:tt9999901", Movie(500001, "Peacemaker", "1997-09-26", 800));
        h.Lookup.AddSearch("imdb:tt9999902", Movie(500002, "The Peacemaker", "1997-09-26", 800));
        // A TMDB movie link on a line typed as TV.
        h.Lookup.Details[("movie", 500003)] = new TitleDetails(Movie(500003, "Peacemaker", "1997-09-26", 800), null, null, null, null, Array.Empty<SeasonFacts>());

        var response = await Resolve(
            h.ImportResolver,
            user,
            new ImportEntryDto { Title = "Peacemaker", Episodes = new List<ImportEpisodeDto> { new() { S = 1, E = 8 } }, Ids = new ImportIdsDto { Imdb = "tt9999901" } },
            new ImportEntryDto { Title = "Peacemaker", TypeHint = "tv", Ids = new ImportIdsDto { Imdb = "tt9999902" } },
            new ImportEntryDto { Title = "Peacemaker", TypeHint = "tv", Ids = new ImportIdsDto { Tmdb = 500003, TmdbType = "movie" } });

        Assert.All(response.Results, r =>
        {
            Assert.Equal("movie", r.Match!.MediaType);
            Assert.Equal(ImportScoring.Levels.Low, r.Confidence);
            Assert.Contains("typeMismatch", r.Reasons);
        });
        Assert.Equal("episodes", response.Results[0].Kind);
    }

    [Fact]
    public async Task ASeasonCallFailingWithAServerErrorIsRetriedNotAMissingSeason()
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.JellyseerrEnabled = true;
        plugin.Plugin.Configuration.JellyseerrUrls = "http://seerr.test";
        plugin.Plugin.Configuration.JellyseerrApiKey = "import-key";
        var fail = true;
        var calls = 0;
        using var transport = new IntegrationTransport((request, _) =>
        {
            Interlocked.Increment(ref calls);
            // Seerr's season route answers every upstream failure (a TMDB 429/timeout too) with this 500.
            return Task.FromResult(fail
                ? IntegrationTransport.Response("{\"message\":\"Unable to retrieve season.\"}", 500)
                : IntegrationTransport.Response("{\"episodes\":[{\"episodeNumber\":8,\"seasonNumber\":1,\"name\":\"It's Cow or Never\",\"airDate\":\"2022-02-17\"}]}"));
        });
        var lookup = new SeerrImportLookup(transport, new SeerrCallLimiter(4, TimeSpan.Zero, TimeProvider.System), plugin.Core.Logger);
        var context = new ImportCallContext("test", false);

        Assert.Equal(LookupStatus.Transient, (await lookup.GetSeasonAsync(110492, 1, context, CancellationToken.None)).Status);
        fail = false;
        var season = await lookup.GetSeasonAsync(110492, 1, context, CancellationToken.None);
        Assert.Equal(LookupStatus.Ok, season.Status); // the failure wasn't cached
        Assert.Equal(8, Assert.Single(season.Value!).Episode);
        Assert.Equal(2, calls);
    }
}
