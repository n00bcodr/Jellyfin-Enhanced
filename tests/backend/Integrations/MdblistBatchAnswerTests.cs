using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Globalization;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

/// <summary>
/// "A few of my movies never get the Rotten Tomatoes tag, on the poster or the details page (Aliens, Black Hawk Down,
/// The Bourne Ultimatum, Deadpool); Dune: Part Two has every rating on its details page but none on its poster."
/// Rating tags, the fetch task and the tag cache read MDBList through its batch endpoint, the details page through
/// the single-title one. A batch answer is matched back by each element's ids.tmdb; MDBList's batch can leave a
/// requested title out, or return it with an empty ratings array (the documented batch example), while the
/// single-title answer for the same id has every score.
/// </summary>
[Collection("Plugin singleton")]
public class MdblistBatchAnswerTests
{
    // Production-shaped MDBList media items (GET /tmdb/movie/{id} and each element of POST /tmdb/movie/).
    private static object Item(string title, int year, long tmdb, string imdb, int tomatoes, bool scored = true) => new
    {
        title, year, type = "movie", score = 84, score_average = 84,
        ids = new { imdb, trakt = tmdb + 1000, tmdb, tvdb = (int?)null, mal = (int?)null },
        ratings = !scored ? Array.Empty<object>() : new object[]
        {
            new { source = "imdb", value = 8.1, score = 81, votes = 700000, url = 90605 },
            new { source = "tomatoes", value = tomatoes, score = tomatoes, votes = 90, url = "/m/" + imdb, fresh = 1 },
            new { source = "popcorn", value = 90, score = 90, votes = 250000, url = (string?)null },
            new { source = "tmdb", value = 78, score = 78, votes = 9000, url = (string?)null },
        },
    };

    private static readonly Dictionary<long, object> Single = new()
    {
        [679] = Item("Aliens", 1986, 679, "tt0090605", 97),
        [855] = Item("Black Hawk Down", 2001, 855, "tt0265086", 77),
        [2503] = Item("The Bourne Ultimatum", 2007, 2503, "tt0440963", 92),
        [293660] = Item("Deadpool", 2016, 293660, "tt1431045", 85),
        [693134] = Item("Dune: Part Two", 2024, 693134, "tt15239678", 92),
    };

    private static IntegrationTransport Mdblist(List<string> calls, Func<long[], IEnumerable<object>> batch) => new(async (request, _) =>
    {
        var path = request.RequestUri!.AbsolutePath;
        if (path == "/user") return IntegrationTransport.Response("{\"rate_limit\":1000,\"rate_limit_remaining\":1000,\"rate_limit_reset\":0}");
        lock (calls) calls.Add($"{request.Method} {path}");
        if (request.Method == HttpMethod.Post)
        {
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
            var ids = body.RootElement.GetProperty("ids").EnumerateArray().Select(v => v.GetInt64()).ToArray();
            return IntegrationTransport.Response(JsonSerializer.Serialize(batch(ids)));
        }
        var id = long.Parse(path.Split('/').Last());
        return IntegrationTransport.Response(Single.TryGetValue(id, out var item) ? JsonSerializer.Serialize(item) : "{\"response\":false,\"error\":\"Movie not found\"}");
    });

    private static JellyfinEnhancedController DetailsPage(ApiPluginFixture plugin, IntegrationTransport transport, MdblistService service)
    {
        var controller = ApiAssetTests.Controller(plugin.Core, transport, service);
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([
            new Claim("Jellyfin-UserId", Guid.NewGuid().ToString()), new Claim(ClaimTypes.Role, "User")], "test"));
        return controller;
    }

    private static double? DetailsPageTomatoes(OkObjectResult answer)
    {
        var json = JsonSerializer.Deserialize<JsonElement>(JsonSerializer.Serialize(answer.Value));
        return json.GetProperty("Ratings").EnumerateArray().Where(r => r.GetProperty("Source").GetString() == "tomatoes")
            .Select(r => (double?)r.GetProperty("Score").GetDouble()).FirstOrDefault();
    }

    [Fact]
    public async Task ATitleTheBatchAnswerLeavesOutOrReturnsWithoutScoresGetsItsScoresOnPosterAndDetailsPage()
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.MdblistRatingsEnabled = true;
        plugin.Plugin.Configuration.MdblistApiKey = "admin-key";
        var calls = new List<string>();
        // The batch answer has Aliens and Deadpool, leaves Black Hawk Down out and returns The Bourne Ultimatum with
        // "ratings": [] (as MDBList's own batch example does), in an order of its own.
        using var transport = Mdblist(calls, ids => ids.Where(id => id != 855).Reverse()
            .Select(id => id == 2503 ? Item("The Bourne Ultimatum", 2007, 2503, "tt0440963", 92, scored: false) : Single[id]));
        using var service = new MdblistService(transport, plugin.Core.Paths.Object, plugin.Core.Logger);

        // The poster path: one batch for the page's titles.
        await service.WarmTagRatingsAsync([("movie", "679"), ("movie", "855"), ("movie", "2503"), ("movie", "293660")], default);

        foreach (var (id, tomatoes) in new[] { ("679", 97d), ("855", 77d), ("2503", 92d), ("293660", 85d) })
        {
            Assert.True(service.GetCachedEntry("movie", id) is { Found: true, Confirmed: true }, $"movie {id} has MDBList's answer");
            Assert.Equal(tomatoes, TagSourceRatings.FromMdblist(service.GetCachedEntry("movie", id))?.RtCritic);
        }

        // The details page reads the same answer, without asking MDBList again.
        var callsAfterWarm = calls.Count;
        var details = DetailsPage(plugin, transport, service);
        foreach (var (id, tomatoes) in new[] { ("855", 77d), ("2503", 92d) })
            Assert.Equal(tomatoes, DetailsPageTomatoes(Assert.IsType<OkObjectResult>(await details.GetMdblistRatings("movie", id, default))));
        Assert.Equal(callsAfterWarm, calls.Count);
        Assert.Equal(["POST /tmdb/movie/", "GET /tmdb/movie/855", "GET /tmdb/movie/2503"], calls);
    }

    [Fact]
    public async Task AnAnswerThatIsNotAListConfirmsNoTitleAndKeepsTheLastGoodScores()
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.MdblistApiKey = "admin-key";
        var calls = new List<string>();
        using var transport = new IntegrationTransport((request, _) =>
        {
            if (request.RequestUri!.AbsolutePath == "/user") return Task.FromResult(IntegrationTransport.Response("{\"rate_limit\":1000,\"rate_limit_remaining\":1000}"));
            lock (calls) calls.Add($"{request.Method} {request.RequestUri.AbsolutePath}");
            return Task.FromResult(IntegrationTransport.Response("{\"response\":false,\"error\":\"API Limit Reached!\"}"));
        });
        using var service = new MdblistService(transport, plugin.Core.Paths.Object, plugin.Core.Logger);
        var eightDaysAgo = DateTimeOffset.UtcNow.AddDays(-8).ToUnixTimeMilliseconds();
        service.MergeMediaBatchIntoCache("movie", ["679"], new Dictionary<string, MdblistCacheEntry>
        {
            ["679"] = new() { Found = true, Confirmed = true, FetchedAtUnixMs = eightDaysAgo, Ratings = [new() { Source = "tomatoes", Score = 97 }] },
        });

        await service.WarmTagRatingsAsync([("movie", "679"), ("movie", "855")], default);

        Assert.Equal(["POST /tmdb/movie/"], calls);
        Assert.Equal(97, TagSourceRatings.FromMdblist(service.GetCachedEntry("movie", "679"))?.RtCritic);
        Assert.False(service.GetCachedEntry("movie", "855")!.Confirmed);
    }

    [Fact]
    public async Task ScoresTheDetailsPageLooksUpReachTheTitlesPosterInTheServerTagCache()
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.MdblistRatingsEnabled = true;
        plugin.Plugin.Configuration.MdblistApiKey = "admin-key";
        plugin.Plugin.Configuration.TagCacheServerMode = true;
        var calls = new List<string>();
        using var transport = Mdblist(calls, ids => ids.Select(id => Single[id]));
        using var service = new MdblistService(transport, plugin.Core.Paths.Object, plugin.Core.Logger);
        var dune = new Movie { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "693134" } };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
            q.IncludeItemTypes.Contains(Jellyfin.Data.Enums.BaseItemKind.Movie) ? new[] { dune.Id } : Array.Empty<Guid>());
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new BaseItem[] { dune });
        using var cache = new TagCacheService(library.Object, plugin.Core.Paths.Object, Mock.Of<ILocalizationManager>(), plugin.Core.Logger,
            new MatroskaLanguageCache(plugin.Core.Paths.Object, plugin.Core.Logger), service);
        // Built before MDBList had answered for the title: the poster's entry has no scores yet.
        cache.BuildFullCache(null, default);
        Assert.True(cache.TryGetEntry(dune.Id, out var before));
        Assert.Null(before.Ratings);

        var answer = Assert.IsType<OkObjectResult>(await DetailsPage(plugin, transport, service).GetMdblistRatings("movie", "693134", default));
        Assert.Equal(92, DetailsPageTomatoes(answer));

        Assert.True(cache.TryGetEntry(dune.Id, out var after));
        Assert.Equal(92, after.Ratings?.RtCritic);
        Assert.Equal(["GET /tmdb/movie/693134"], calls);
    }

    private sealed class Movie : MediaBrowser.Controller.Entities.Movies.Movie
    {
        public override List<MediaBrowser.Model.Dto.MediaSourceInfo> GetMediaSources(bool enablePathSubstitution) => [];
    }
}
