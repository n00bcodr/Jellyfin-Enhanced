using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ListsC1CompletionMigrationTests
{
    private const string Show = """
        {"id":1399,"name":"Show","first_air_date":"2011-04-17","status":"Ended","in_production":false,
         "external_ids":{"imdb_id":"tt0944947","tvdb_id":121361},"poster_path":null,"overview":"Show.",
         "last_episode_to_air":{"show_id":1399,"season_number":1,"episode_number":2,"air_date":"2011-04-24"},"next_episode_to_air":null,
         "seasons":[{"season_number":1,"episode_count":2,"air_date":"2011-04-17"}]}
        """;
    private const string Season = """
        {"id":100,"season_number":1,"air_date":"2011-04-17","poster_path":null,
         "episodes":[{"show_id":1399,"season_number":1,"episode_number":1,"air_date":"2011-04-17"},
                     {"show_id":1399,"season_number":1,"episode_number":2,"air_date":"2011-04-24"}]}
        """;

    [Theory]
    [InlineData("season")]
    [InlineData("series")]
    [InlineData("episodes")]
    public async Task LegacyColdReloadRetainsFactsDuringOutageAndRetiresAfterCoherentRefresh(string kind)
    {
        using var h = new ListsHarness();
        h.Plugin.Plugin.Configuration.ArrRequestBackend = "je";
        var owner = h.NewUser("owner");
        var access = h.AccessFor(h.Host.AddPlaylist(owner), owner);
        var series = h.Host.AddSeries(tmdb: 1399);
        h.Host.AddEpisode(series, 1, 1); h.Host.AddEpisode(series, 1, 2);
        var seasonField = kind == "series" ? "" : ",\"seasonNumber\":1";
        var episodeField = kind == "episodes" ? ",\"episodes\":[{\"s\":1,\"e\":1},{\"s\":1,\"e\":2}]" : "";
        var p = ListsHarness.Ph($$"""{"kind":"{{kind}}","tmdbId":1399{{seasonField}}{{episodeField}},"title":"Show"}""");
        if (kind == "episodes")
        {
            p.Episodes = new[] { 1, 2 }.Select(e => new PlaceholderEpisode { S = 1, E = e }).ToList();
        }
        var legacy = JsonNode.Parse(JsonSerializer.Serialize(p))!.AsObject();
        legacy.Remove("completionAuthority");
        p = JsonSerializer.Deserialize<Placeholder>(legacy.ToJsonString())!;
        p.InProduction = false;
        p.Expected = new[] { 1, 2 }.Select(e => new PlaceholderEpisode { S = 1, E = e, AirDate = "2011-04-24" }).ToList();
        p.EpisodeTotal = 2;
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
        doc.Items.Add(p); doc.Order.Add(ListsHarness.P(p.Id)); h.Store.Save(doc);
        await h.Consent(access);
        var cold = new ListStore(h.Store.DirectoryPath, h.Plugin.Core.Logger);
        using (var outage = new ListSwapService(cold, h.Host, h.Users.Object, h.Resolver, h.Metadata, h.Plugin.Core.Logger,
            preferences: h.Preferences, access: h.Access))
        {
            var pass = await outage.RunListPassAsync(access.ListIdN, null, MetadataMode.New, default);
            Assert.Equal(0, pass.Retired);
        }
        var retained = Assert.Single(cold.Load(access.ListIdN)!.Items);
        Assert.Equal(2, retained.Expected.Count); Assert.Equal(2, retained.EpisodeTotal);
        Assert.False(PlaceholderProgress.HasCompleteExpected(retained));
        if (kind == "series") Assert.Null(ListRules.RequestInput(retained));
        h.Plugin.Plugin.Configuration.TMDB_API_KEY = "test";
        using var transport = new IntegrationTransport((r, _) => Task.FromResult(IntegrationTransport.Response(
            r.RequestUri!.AbsolutePath.Contains("/season/", StringComparison.Ordinal) ? Season : Show)));
        using var cache = new TmdbResponseCache(transport, TimeProvider.System);
        var tmdb = new TmdbListMetadataSource(cache, h.Plugin.Core.Logger);
        var facts = await tmdb.FetchAsync(retained, TimeSpan.Zero, DateTime.UtcNow, default);
        Assert.NotNull(facts); Assert.False(facts.Partial);
        var source = new ListMetadataSources(h.Metadata, tmdb);
        using var refresh = new ListSwapService(cold, h.Host, h.Users.Object, h.Resolver, source, h.Plugin.Core.Logger,
            preferences: h.Preferences, access: h.Access);
        var refreshed = await refresh.RunListPassAsync(access.ListIdN, null, MetadataMode.New | MetadataMode.Completion, default);
        var remaining = cold.Load(access.ListIdN)!.Items.FirstOrDefault();
        Assert.True(refreshed.Retired == 1, $"retired={refreshed.Retired}; remaining production={remaining?.InProduction}; uncertain={remaining?.ExpectedUncertain}; facts partial={facts.Partial}");
        Assert.Empty(new ListStore(h.Store.DirectoryPath, h.Plugin.Core.Logger).Load(access.ListIdN)!.Items);
    }

    [Fact]
    public void PositiveProofSurvivesSerializationButNotAnIdentityChangeOrPartialRefresh()
    {
        using var h = new ListsHarness();
        var p = ListsHarness.Ph("{\"kind\":\"series\",\"tmdbId\":1399,\"title\":\"Show\"}");
        using var show = JsonDocument.Parse(Show);
        using var season = JsonDocument.Parse(Season);
        var facts = ListMetadataService.FromTv(p, TmdbListMetadataSource.Camelize(show.RootElement), TmdbListMetadataSource.Camelize(season.RootElement), DateTime.UtcNow, DateTime.UtcNow);
        ListMetadataService.Apply(p, facts);
        p.Filled.AddRange(new[] { 1, 2 }.Select(e => new FilledEpisode { S = 1, E = e, ItemId = Guid.NewGuid().ToString("N") }));
        Assert.True(PlaceholderProgress.IsComplete(p, DateTime.UtcNow));
        var restored = JsonSerializer.Deserialize<Placeholder>(JsonSerializer.Serialize(p))!;
        Assert.True(PlaceholderProgress.IsComplete(restored, DateTime.UtcNow));
        restored.TmdbId = 1400;
        Assert.False(PlaceholderProgress.HasCompleteExpected(restored));
        ListMetadataService.Apply(p, new PlaceholderMetadata { Partial = true, FetchedAtUtc = DateTime.UtcNow });
        Assert.False(PlaceholderProgress.IsComplete(p, DateTime.UtcNow));
        Assert.Equal(2, p.Expected.Count);
    }
    [Fact]
    public void MutableDisplayFactsCannotRewriteReconciledCompletionObligations()
    {
        using var h = new ListsHarness();
        var p = ListsHarness.Ph("{\"kind\":\"series\",\"tmdbId\":1399,\"title\":\"Show\"}");
        using var show = JsonDocument.Parse(Show);
        using var season = JsonDocument.Parse(Season);
        ListMetadataService.Apply(p, ListMetadataService.FromTv(p, TmdbListMetadataSource.Camelize(show.RootElement), TmdbListMetadataSource.Camelize(season.RootElement), DateTime.UtcNow, DateTime.UtcNow));
        p.Filled.Add(new FilledEpisode { S = 1, E = 1, ItemId = Guid.NewGuid().ToString("N") });
        p.Expected.RemoveAll(e => e.E == 2);
        p.EpisodeTotal = 1;
        Assert.False(PlaceholderProgress.IsComplete(p, DateTime.UtcNow));
        p.Filled.Add(new FilledEpisode { S = 1, E = 2, ItemId = Guid.NewGuid().ToString("N") });
        p.Expected.Clear(); p.EpisodeTotal = 0; p.InProduction = true;
        Assert.True(PlaceholderProgress.IsComplete(p, DateTime.UtcNow));
    }

    [Fact]
    public async Task SeriesCannotIgnoreSeasonRowsNamingAnExtraAiredEpisode()
    {
        using var h = new ListsHarness();
        h.Plugin.Plugin.Configuration.ArrRequestBackend = "je";
        h.Plugin.Plugin.Configuration.TMDB_API_KEY = "test";
        var owner = h.NewUser("owner");
        var access = h.AccessFor(h.Host.AddPlaylist(owner), owner);
        var series = h.Host.AddSeries(tmdb: 1399);
        h.Host.AddEpisode(series, 1, 1); h.Host.AddEpisode(series, 1, 2);
        var p = ListsHarness.Ph("{\"kind\":\"series\",\"tmdbId\":1399,\"title\":\"Show\"}");
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
        doc.Items.Add(p); doc.Order.Add(ListsHarness.P(p.Id)); h.Store.Save(doc);
        await h.Consent(access);
        var extra = JsonNode.Parse(Season)!;
        extra["episodes"]!.AsArray().Add(JsonNode.Parse("{\"show_id\":1399,\"season_number\":1,\"episode_number\":3,\"air_date\":\"2011-04-24\"}"));
        using var transport = new IntegrationTransport((r, _) => Task.FromResult(IntegrationTransport.Response(
            r.RequestUri!.AbsolutePath.Contains("/season/", StringComparison.Ordinal) ? extra.ToJsonString() : Show)));
        using var cache = new TmdbResponseCache(transport, TimeProvider.System);
        var source = new ListMetadataSources(h.Metadata, new TmdbListMetadataSource(cache, h.Plugin.Core.Logger));
        using var swap = new ListSwapService(h.Store, h.Host, h.Users.Object, h.Resolver, source, h.Plugin.Core.Logger,
            preferences: h.Preferences, access: h.Access);
        var result = await swap.RunListPassAsync(access.ListIdN, null, MetadataMode.New | MetadataMode.Completion, default);
        Assert.Equal(0, result.Retired);
        Assert.Single(h.Store.Load(access.ListIdN)!.Items);
    }

}
