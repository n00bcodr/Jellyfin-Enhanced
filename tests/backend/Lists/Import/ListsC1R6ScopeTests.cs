using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ListsC1R6ScopeTests
{
    internal static CompletionEvidence ReviewerCase(string kind)
    {
        var e = ListsC1R4TotalityTests.Coherent(kind);
        return e with { DeclaredSeasonCount = 2,
            Seasons = e.Seasons.Append(new CompletionSeason(2, 2, null)).ToArray() };
    }

    private static Placeholder Filled(CompletionEvidence e)
    {
        var r = CompletionEvaluator.Reconcile(e, DateTime.UtcNow);
        var p = ListsHarness.Ph(e.Kind == "series" ? "{\"kind\":\"series\",\"tmdbId\":1399,\"title\":\"Show\"}"
            : "{\"kind\":\"season\",\"seasonNumber\":1,\"tmdbId\":1399,\"title\":\"Show\"}");
        p.CompletionAuthority = r.Authority; p.CompletionReason = r.Reason;
        p.Filled.AddRange(new[] { 1, 2 }.Select(n => new FilledEpisode { S = 1, E = n, ItemId = "filled" }));
        return p;
    }

    [Fact]
    public void CountOnlySeasonTwoCannotProveSeriesCoverage()
    {
        var e = ReviewerCase("series");
        Assert.Contains("series_season_detail_uncovered", CompletionEvaluator.Disagreements(e));
        var p = Filled(e);
        var verdict = CompletionEvaluator.Read(p, ListsC1R4TotalityTests.Today);
        Assert.Equal("unknown", verdict.State);
        Assert.Equal("series_season_detail_uncovered", verdict.Reason);
        Assert.Null(ListRules.RequestInput(p));
    }

    [Fact]
    public void CountOnlyUnselectedSeasonAllowsCompleteSeasonOneWithScopedReasonAfterReload()
    {
        var p = Filled(ReviewerCase("season"));
        Assert.Empty(CompletionEvaluator.Disagreements(ReviewerCase("season")));
        p = JsonSerializer.Deserialize<Placeholder>(JsonSerializer.Serialize(p))!;
        var verdict = CompletionEvaluator.Read(p, ListsC1R4TotalityTests.Today);
        Assert.True(verdict.IsComplete);
        Assert.Equal("season 1 complete; series unknown: season 2 has no detail evidence", verdict.Reason);
        var input = Assert.IsType<Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.MutationInput>(ListRules.RequestInput(p));
        Assert.Equal(new[] { 1 }, input.Seasons);
    }

    [Fact]
    public void UnselectedEvidenceMayBeAbsentButCannotContradictItsAdvertisedCount()
    {
        var e = ReviewerCase("season") with { Next = new PlaceholderEpisode { S = 2, E = 3 } };
        Assert.Contains("coordinate_count_contradiction", CompletionEvaluator.Disagreements(e));
        Assert.Null(CompletionEvaluator.Reconcile(e, DateTime.UtcNow).Authority);
    }

    [Fact]
    public void FutureEmptyExceptionRequiresTrailingOrdinalEvenWithoutNamedLast()
    {
        var e = ReviewerCase("season") with { DeclaredSeasonCount = 3, Last = null,
            Seasons = new[] { new CompletionSeason(1, 2, "2011-04-17"), new CompletionSeason(2, 0, "2099-01-01"),
                new CompletionSeason(3, 1, "2012-04-01") } };
        Assert.Contains("season_range_uncovered", CompletionEvaluator.Disagreements(e));
        Assert.Null(CompletionEvaluator.Reconcile(e, DateTime.UtcNow).Authority);
    }

    [Theory]
    [InlineData("series", "series complete")]
    [InlineData("episodes", "season 1 episodes complete")]
    public void OtherCompleteReasonsNameTheirScope(string kind, string reason)
    {
        var e = ListsC1R4TotalityTests.Coherent(kind);
        var p = new Placeholder { Kind = kind, TmdbId = 1399, SeasonNumber = e.Season,
            Episodes = e.ExplicitScope?.Select(c => new PlaceholderEpisode { S = c.S, E = c.E }).ToList() ?? new(),
            CompletionAuthority = CompletionEvaluator.Reconcile(e, DateTime.UtcNow).Authority };
        p.Filled.AddRange(new[] { 1, 2 }.Select(n => new FilledEpisode { S = 1, E = n }));
        Assert.Equal(reason, CompletionEvaluator.Read(p, ListsC1R4TotalityTests.Today).Reason);
    }

    [Theory]
    [InlineData(false, "season", false)]
    [InlineData(true, "season", false)]
    [InlineData(false, "series", false)]
    [InlineData(true, "series", false)]
    [InlineData(false, "season", true)]
    [InlineData(true, "season", true)]
    public async Task FutureEmptyTrailingSeasonDoesNotBlockEarlierSeasonButInteriorHoleDoes(bool admin, string kind, bool interior)
    {
        using var h = new ListsHarness();
        var cfg = h.Plugin.Plugin.Configuration;
        cfg.ArrRequestBackend = "je"; cfg.JellyseerrEnabled = false; cfg.JellyseerrUrls = ""; cfg.JellyseerrApiKey = "";
        cfg.TMDB_API_KEY = "test";
        var show = JsonNode.Parse("""
          {"id":1399,"name":"Show","status":"Returning Series","in_production":true,"number_of_seasons":2,
           "first_air_date":"2011-04-17","external_ids":{"imdb_id":"tt0944947","tvdb_id":121361},"poster_path":null,"overview":"Show.",
           "last_episode_to_air":{"season_number":1,"episode_number":2,"air_date":"2011-04-24"},"next_episode_to_air":null,
           "seasons":[{"season_number":1,"episode_count":2,"air_date":"2011-04-17"},
                      {"season_number":2,"episode_count":0,"air_date":"2099-01-01"}]}
          """)!;
        const string detail = """
          {"season_number":1,"air_date":"2011-04-17","poster_path":null,
           "episodes":[{"show_id":1399,"season_number":1,"episode_number":1,"air_date":"2011-04-17"},
                       {"show_id":1399,"season_number":1,"episode_number":2,"air_date":"2011-04-24"}]}
          """;
        if (interior)
        {
            show["number_of_seasons"] = 3;
            show["seasons"]!.AsArray().Add(JsonNode.Parse("""{"season_number":3,"episode_count":1,"air_date":"2012-04-01"}"""));
            show["last_episode_to_air"] = JsonNode.Parse("""{"season_number":3,"episode_number":1,"air_date":"2012-04-01"}""");
        }
        using var transport = new IntegrationTransport((r, _) =>
        {
            Assert.Equal("api.themoviedb.org", r.RequestUri!.Host);
            return Task.FromResult(IntegrationTransport.Response(r.RequestUri.AbsolutePath.Contains("/season/") ? detail : show.ToJsonString()));
        });
        using var cache = new TmdbResponseCache(transport, TimeProvider.System);
        var tmdb = new TmdbListMetadataSource(cache, h.Plugin.Core.Logger);
        var p = ListsHarness.Ph(kind == "series" ? "{\"kind\":\"series\",\"tmdbId\":1399,\"title\":\"Show\"}"
            : "{\"kind\":\"season\",\"seasonNumber\":1,\"tmdbId\":1399,\"title\":\"Show\"}");
        var facts = await tmdb.FetchAsync(p, TimeSpan.Zero, DateTime.UtcNow, default);
        Assert.NotNull(facts);
        var owner = h.NewUser("owner", admin: admin);
        var access = h.AccessFor(h.Host.AddPlaylist(owner), owner);
        var native = h.Host.AddSeries(tmdb: 1399);
        h.Host.AddEpisode(native, 1, 1); h.Host.AddEpisode(native, 1, 2);
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
        doc.Items.Add(p); doc.Order.Add(ListsHarness.P(p.Id)); h.Store.Save(doc);
        await h.Consent(access);
        using var swap = new ListSwapService(h.Store, h.Host, h.Users.Object, h.Resolver,
            new ListMetadataSources(h.Metadata, tmdb), h.Plugin.Core.Logger, preferences: h.Preferences, access: h.Access);
        var result = await swap.RunListPassAsync(access.ListIdN, null, MetadataMode.New | MetadataMode.Completion, default);
        Assert.True(result.Retired == (kind == "season" && !interior ? 1 : 0),
            $"kind={kind} interior={interior} partial={facts.Partial} reason={facts.Completion?.Reason} retired={result.Retired}");
        if (kind == "series" || interior)
        {
            var retained = Assert.Single(h.Store.Load(access.ListIdN)!.Items);
            Assert.Equal("unknown", CompletionEvaluator.Read(retained, DateTime.UtcNow).State);
            if (kind == "series") Assert.Null(ListRules.RequestInput(retained));
        }
        else Assert.Empty(h.Store.Load(access.ListIdN)!.Items);
        Assert.Empty(h.SeerrCalls);
    }

    private sealed class FreshGrant(CompletionAuthority authority) : IListMetadataSource
    {
        public int Reads { get; private set; }
        public bool Available => true;
        public bool PostersAvailable => false;
        public Task<PlaceholderMetadata?> FetchAsync(Placeholder p, TimeSpan age, DateTime today, CancellationToken ct)
        {
            Reads++;
            return Task.FromResult<PlaceholderMetadata?>(new PlaceholderMetadata { FetchedAtUtc = DateTime.UtcNow,
                InProduction = false, Completion = new CompletionReconciliation(authority, null) });
        }
        public Task<string?> FetchTmdbPosterAsync(Placeholder p, CancellationToken ct) => Task.FromResult<string?>(null);
        public Task<(string? Poster, bool Answered)> ReadTmdbPosterAsync(Placeholder p, CancellationToken ct)
            => Task.FromResult<(string?, bool)>((null, false));
    }

    [Fact]
    public async Task SeasonAuthorityCannotRetireOrDeriveSeriesThroughFreshSwapAndColdStore()
    {
        using var h = new ListsHarness();
        h.Plugin.Plugin.Configuration.ArrRequestBackend = "je";
        h.Plugin.Plugin.Configuration.JellyseerrEnabled = false;
        h.Plugin.Plugin.Configuration.JellyseerrUrls = "";
        h.Plugin.Plugin.Configuration.JellyseerrApiKey = "";
        var season = Filled(ReviewerCase("season"));
        Assert.True(CompletionEvaluator.Read(season, DateTime.UtcNow).IsComplete);
        var source = new FreshGrant(season.CompletionAuthority!);
        var p = ListsHarness.Ph("{\"kind\":\"series\",\"tmdbId\":1399,\"title\":\"Show\"}");
        p.CompletionAuthority = season.CompletionAuthority;
        var owner = h.NewUser("owner");
        var access = h.AccessFor(h.Host.AddPlaylist(owner), owner);
        var show = h.Host.AddSeries(tmdb: 1399);
        h.Host.AddEpisode(show, 1, 1); h.Host.AddEpisode(show, 1, 2);
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
        doc.Items.Add(p); doc.Order.Add(ListsHarness.P(p.Id)); h.Store.Save(doc);
        await h.Consent(access);
        var cold = new ListStore(h.Store.DirectoryPath, h.Plugin.Core.Logger);
        using var swap = new ListSwapService(cold, h.Host, h.Users.Object, h.Resolver, source,
            h.Plugin.Core.Logger, preferences: h.Preferences, access: h.Access);
        var result = await swap.RunListPassAsync(access.ListIdN, null, MetadataMode.New | MetadataMode.Completion, default);
        Assert.True(source.Reads > 0); // Freshness must not be the reason the mismatched grant was rejected.
        Assert.Equal(0, result.Retired);
        var retained = Assert.Single(new ListStore(h.Store.DirectoryPath, h.Plugin.Core.Logger).Load(access.ListIdN)!.Items);
        Assert.Equal(2, retained.Filled.Count);
        Assert.Equal("authority_invalid_or_scope_changed", CompletionEvaluator.Read(retained, DateTime.UtcNow).Reason);
        Assert.Empty(CompletionEvaluator.ScopeSeasons(retained));
        Assert.Null(ListRules.RequestInput(retained)); // Real default derivation; no separately supplied scope.
        Assert.Empty(h.SeerrCalls);
    }
}
