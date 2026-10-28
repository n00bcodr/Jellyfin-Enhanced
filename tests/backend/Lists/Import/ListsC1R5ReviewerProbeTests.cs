using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Xunit.Abstractions;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ListsC1R5ReviewerProbeTests(ITestOutputHelper output)
{
    [Theory]
    [InlineData("season", "ordinal_gap")]
    [InlineData("series", "ordinal_gap")]
    public async Task AdvertisedS1AndS3WithDeclaredTwoSeasonsCannotRetire(string kind, string scenario)
    {
        using var h = new ListsHarness();
        h.Plugin.Plugin.Configuration.ArrRequestBackend = "je";
        h.Plugin.Plugin.Configuration.TMDB_API_KEY = "test";
        var show = JsonNode.Parse("""
          {"id":1399,"name":"Show","first_air_date":"2011-04-17","status":"Ended","in_production":false,
           "external_ids":{"imdb_id":"tt0944947","tvdb_id":121361},"poster_path":null,"overview":"Show.",
           "last_episode_to_air":{"season_number":1,"episode_number":2,"air_date":"2011-04-24"},"next_episode_to_air":null,
           "number_of_seasons":1,"seasons":[{"season_number":1,"episode_count":2,"air_date":null}]}
          """)!;
        var season = JsonNode.Parse("""
          {"id":100,"season_number":1,"air_date":"2099-01-01","poster_path":null,
           "episodes":[{"show_id":1399,"season_number":1,"episode_number":1,"air_date":"2011-04-17"},
                       {"show_id":1399,"season_number":1,"episode_number":2,"air_date":"2011-04-24"}]}
          """)!;
        season["air_date"] = "2011-04-17";
        show["seasons"]![0]!["air_date"] = "2011-04-17";
        if (scenario == "ordinal_gap")
        {
            show["number_of_seasons"] = 2;
            show["seasons"]!.AsArray().Add(JsonNode.Parse("""{"season_number":3,"episode_count":1,"air_date":"2012-04-01"}"""));
            show["last_episode_to_air"] = JsonNode.Parse("""{"season_number":3,"episode_number":1,"air_date":"2012-04-01"}""");
        }
        if (scenario == "wrong_row_season") season["episodes"]![1]!["season_number"] = 2;
        if (scenario == "empty_detail") season["episodes"] = new JsonArray();
        if (scenario == "unparseable_count") show["number_of_seasons"] = "not-a-count";
        if (scenario == "unparseable_production") show["in_production"] = "not-a-bool";
        if (scenario == "show_premiere_future") show["first_air_date"] = "2099-01-01";
        var third = """{"season_number":3,"air_date":"2012-04-01","poster_path":null,"episodes":[{"show_id":1399,"season_number":3,"episode_number":1,"air_date":"2012-04-01"}]}""";
        using var transport = new IntegrationTransport((r, _) => Task.FromResult(IntegrationTransport.Response(
            r.RequestUri!.AbsolutePath.EndsWith("/season/3", StringComparison.Ordinal) ? third : r.RequestUri!.AbsolutePath.Contains("/season/", StringComparison.Ordinal) ? season.ToJsonString() : show.ToJsonString())));
        using var cache = new TmdbResponseCache(transport, TimeProvider.System);
        var tmdb = new TmdbListMetadataSource(cache, h.Plugin.Core.Logger);
        var p = ListsHarness.Ph(kind == "series" ? """{"kind":"series","tmdbId":1399,"title":"Show"}"""
            : """{"kind":"season","seasonNumber":1,"tmdbId":1399,"title":"Show"}""");
        var facts = await tmdb.FetchAsync(p, TimeSpan.Zero, DateTime.UtcNow, default);
        Assert.NotNull(facts);
        var owner = h.NewUser("owner");
        var access = h.AccessFor(h.Host.AddPlaylist(owner), owner);
        var series = h.Host.AddSeries(tmdb:1399);
        h.Host.AddEpisode(series, 1, 1);
        h.Host.AddEpisode(series, 1, 2);
        if (scenario == "ordinal_gap") h.Host.AddEpisode(series, 3, 1);
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
        doc.Items.Add(p); doc.Order.Add(ListsHarness.P(p.Id)); h.Store.Save(doc);
        await h.Consent(access);
        using var swap = new ListSwapService(h.Store, h.Host, h.Users.Object, h.Resolver,
            new ListMetadataSources(h.Metadata, tmdb), h.Plugin.Core.Logger, preferences:h.Preferences, access:h.Access);
        var result = await swap.RunListPassAsync(access.ListIdN, null, MetadataMode.New | MetadataMode.Completion, default);
        output.WriteLine($"kind={kind} scenario={scenario} partial={facts.Partial} reason={facts.Completion?.Reason} retired={result.Retired}");
        Assert.True(result.Retired == 0, $"kind={kind} scenario={scenario} partial={facts.Partial} reason={facts.Completion?.Reason} retired={result.Retired}");
    }
}
