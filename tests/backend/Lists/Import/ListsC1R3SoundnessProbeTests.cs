using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ListsC1R3SoundnessProbeTests
{
    private const string Show = """
      {"id":1399,"name":"Show","first_air_date":"2011-04-17","status":"Ended","in_production":false,
       "external_ids":{"imdb_id":"tt0944947","tvdb_id":121361},"poster_path":null,"overview":"Show.",
       "last_episode_to_air":{"season_number":1,"episode_number":2,"air_date":"2011-04-24"},"next_episode_to_air":null,
       "seasons":[{"season_number":1,"episode_count":2,"air_date":"2011-04-17"},
                  {"season_number":2,"episode_count":2,"air_date":"2012-04-01"}]}
      """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task IncompleteSeriesEvidenceCannotRetireAnOmittedAiredCoordinate(bool undatedLast)
    {
        using var h = new ListsHarness();
        h.Plugin.Plugin.Configuration.ArrRequestBackend = "je";
        h.Plugin.Plugin.Configuration.TMDB_API_KEY = "test";
        var show = undatedLast ? Show.Replace("\"air_date\":\"2011-04-24\"", "\"air_date\":null", StringComparison.Ordinal)
            .Replace("\"next_episode_to_air\":null", "\"next_episode_to_air\":{\"season_number\":2,\"episode_number\":1,\"air_date\":\"2012-04-01\"}", StringComparison.Ordinal) : Show;
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response(show)));
        using var cache = new TmdbResponseCache(transport, TimeProvider.System);
        var source = new TmdbListMetadataSource(cache, h.Plugin.Core.Logger);
        var sources = new ListMetadataSources(h.Metadata, source);
        var p = ListsHarness.Ph("{\"kind\":\"series\",\"tmdbId\":1399,\"title\":\"Show\"}");
        var facts = await source.FetchAsync(p, TimeSpan.Zero, DateTime.UtcNow, default);
        Assert.NotNull(facts);
        var owner = h.NewUser("owner");
        var access = h.AccessFor(h.Host.AddPlaylist(owner), owner);
        var series = h.Host.AddSeries(tmdb:1399);
        if (undatedLast) h.Host.AddEpisode(series, 2, 1);
        else { h.Host.AddEpisode(series, 1, 1); h.Host.AddEpisode(series, 1, 2); }
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
        doc.Items.Add(p); doc.Order.Add(ListsHarness.P(p.Id)); h.Store.Save(doc);
        await h.Consent(access);
        using var swap = new ListSwapService(h.Store, h.Host, h.Users.Object, h.Resolver, sources, h.Plugin.Core.Logger,
            preferences:h.Preferences, access:h.Access);
        var pass = await swap.RunListPassAsync(access.ListIdN, null, MetadataMode.New, default);
        Assert.True(pass.Retired == 0, $"retired={pass.Retired}; partial={facts.Partial}; expected={System.Text.Json.JsonSerializer.Serialize(facts.Expected)}");
        Assert.Single(h.Store.Load(access.ListIdN)!.Items);
    }

    [Fact]
    public async Task LegacyExpectationsWithoutReconciledAuthorityCannotRetireDuringMetadataOutage()
    {
        using var h = new ListsHarness();
        h.Plugin.Plugin.Configuration.ArrRequestBackend = "je";
        var owner = h.NewUser("owner");
        var access = h.AccessFor(h.Host.AddPlaylist(owner), owner);
        var series = h.Host.AddSeries(tmdb:1399);
        h.Host.AddEpisode(series, 1, 1); h.Host.AddEpisode(series, 1, 2);
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
        var p = ListsHarness.Ph("{\"kind\":\"series\",\"tmdbId\":1399,\"title\":\"Show\"}");
        // This is exactly the authority the pre-fix count-2 / last-E8 bug could persist.
        p.Expected = new[] { 1, 2 }.Select(e => new PlaceholderEpisode { S = 1, E = e, AirDate = "2011-04-24" }).ToList();
        p.EpisodeTotal = 2; p.InProduction = false;
        doc.Items.Add(p); doc.Order.Add(ListsHarness.P(p.Id)); h.Store.Save(doc);
        await h.Consent(access);
        Assert.DoesNotContain("expectedUncertain", File.ReadAllText(Path.Combine(h.Store.DirectoryPath, access.ListIdN + ".json")));
        var reloaded = new ListStore(h.Store.DirectoryPath, h.Plugin.Core.Logger);
        Assert.Single(reloaded.Load(access.ListIdN)!.Items);
        using var swap = new ListSwapService(reloaded, h.Host, h.Users.Object, h.Resolver, h.Metadata, h.Plugin.Core.Logger,
            preferences:h.Preferences, access:h.Access);
        var pass = await swap.RunListPassAsync(access.ListIdN, null, MetadataMode.New, default);
        Assert.True(pass.Retired == 0, $"legacy marker absent; no provider available; retired={pass.Retired}");
        Assert.Single(reloaded.Load(access.ListIdN)!.Items);
    }
}
