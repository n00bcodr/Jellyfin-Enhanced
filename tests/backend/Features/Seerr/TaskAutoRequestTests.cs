using System.Globalization;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Moq;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Seerr.Services;

namespace JE.Tests.Features.Seerr;

[Collection("Plugin singleton")]
public class TaskAutoRequestTests
{
    [Theory]
    [InlineData(2, false, false, 0)]
    [InlineData(3, false, false, 0)]
    [InlineData(5, false, false, 0)]
    [InlineData(1, true, false, 0)]
    [InlineData(1, false, false, 1)]
    [InlineData(1, false, true, 2)]
    public async Task MovieCollectionDecisionsDeduplicateSuccessAndRetryFailure(int status, bool futureRelease, bool failFirst, int expectedPosts)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.AutoMovieRequestEnabled = true;
        config.JellyseerrEnabled = true;
        config.TMDB_API_KEY = "test-tmdb";
        config.JellyseerrUrls = "http://seerr.test";
        config.JellyseerrApiKey = "test-seerr";
        config.AutoMovieRequestCheckReleaseDate = true;
        config.AutoMovieRequestQualityMode = "custom";
        config.AutoMovieRequestCustomServerId = 0;
        config.AutoMovieRequestCustomProfileId = 7;
        config.AutoMovieRequestCustomRootFolder = "/movies";
        var user = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(user.Id)).Returns(user);
        var movie = new Movie { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "123" } };
        var posts = new List<(string? Identity, string Body)>();
        var lookups = 0;
        using var transport = new IntegrationTransport(async (request, ct) =>
        {
            switch (request.RequestUri!.AbsolutePath)
            {
                case "/3/movie/123": return IntegrationTransport.Response("{\"belongs_to_collection\":{\"id\":9,\"name\":\"Saga\"}}");
                case "/api/v1/collection/9": return IntegrationTransport.Response(JsonSerializer.Serialize(new { parts = new[] { new { id = 123, title = "First", releaseDate = "2000-01-01", mediaInfo = new { status = 5 } }, new { id = 124, title = "Second", releaseDate = futureRelease ? "2999-01-01" : "2001-01-01", mediaInfo = new { status } } } }));
                case "/api/v1/service/radarr": return IntegrationTransport.Response("[{\"id\":0,\"name\":\"Radarr\",\"is4k\":false,\"isDefault\":true}]");
                case "/api/v1/user":
                    lookups++;
                    return IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new[] { new { id = 22, jellyfinUserId = user.Id.ToString("N").ToUpperInvariant() } } }));
                case "/api/v1/request":
                    posts.Add((request.Headers.GetValues("X-Api-User").Single(), await request.Content!.ReadAsStringAsync(ct)));
                    return IntegrationTransport.Response("{}", failFirst && posts.Count == 1 ? 500 : 201);
                default: throw new InvalidOperationException("Unexpected URL " + request.RequestUri);
            }
        });
        var service = new AutoMovieRequestService(transport, f.Core.Logger, users.Object, null!);
        await service.CheckMovieForCollectionRequestAsync(movie, user.Id);
        await service.CheckMovieForCollectionRequestAsync(movie, user.Id);
        Assert.Equal(expectedPosts, posts.Count);
        Assert.Equal(expectedPosts > 0 ? 1 : 0, lookups);
        foreach (var post in posts)
        {
            Assert.Equal("22", post.Identity);
            using var payload = JsonDocument.Parse(post.Body);
            Assert.Equal("movie", payload.RootElement.GetProperty("mediaType").GetString());
            Assert.Equal(124, payload.RootElement.GetProperty("mediaId").GetInt32());
            Assert.Equal(0, payload.RootElement.GetProperty("serverId").GetInt32());
            Assert.Equal(7, payload.RootElement.GetProperty("profileId").GetInt32());
            Assert.Equal("/movies", payload.RootElement.GetProperty("rootFolder").GetString());
            Assert.False(payload.RootElement.TryGetProperty("is4k", out _));
        }
        if (expectedPosts == 1)
        {
            service.ClearRequestCache();
            await service.CheckMovieForCollectionRequestAsync(movie, user.Id);
            Assert.Equal(2, posts.Count);
            Assert.Equal(1, lookups);
        }
    }

    [Theory]
    [InlineData("fa-IR", true)][InlineData("fa-IR", false)]
    [InlineData("th-TH", true)][InlineData("th-TH", false)]
    public async Task MovieCollectionReleaseDateIsReadAsGregorianUnderNonGregorianCulture(string culture, bool released)
    {
        // A year either side of today: read as a Persian year a past date lands centuries ahead,
        // and read as a Thai Buddhist year a future date lands centuries ago.
        var releaseDate = DateTime.UtcNow.AddYears(released ? -1 : 1).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        Assert.Equal(released ? 1 : 0, await NextCollectionMovieRequests(releaseDate, CultureInfo.GetCultureInfo(culture)));
    }

    [Fact]
    public async Task MovieCollectionReleasedTodayInServerTimeIsRequested()
    {
        // A date-only release day starts at the server's local midnight. A UTC cutoff would treat this
        // title as unreleased when the test runs ahead of UTC in the hours after local midnight.
        var today = DateTime.Now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        Assert.Equal(1, await NextCollectionMovieRequests(today, CultureInfo.CurrentCulture));
    }

    // Runs the collection check for an available first movie whose sequel has the given release date,
    // under the given culture, and returns how many requests reached Seerr.
    private static async Task<int> NextCollectionMovieRequests(string releaseDate, CultureInfo culture)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.AutoMovieRequestEnabled = true;
        config.JellyseerrEnabled = true;
        config.TMDB_API_KEY = "test-tmdb";
        config.JellyseerrUrls = "http://seerr.test";
        config.JellyseerrApiKey = "test-seerr";
        config.AutoMovieRequestCheckReleaseDate = true;
        config.AutoMovieRequestQualityMode = "custom";
        config.AutoMovieRequestCustomServerId = 0;
        config.AutoMovieRequestCustomProfileId = 7;
        config.AutoMovieRequestCustomRootFolder = "/movies";
        var user = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(user.Id)).Returns(user);
        var movie = new Movie { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "123" } };
        var posts = 0;
        using var transport = new IntegrationTransport((request, _) =>
        {
            switch (request.RequestUri!.AbsolutePath)
            {
                case "/3/movie/123": return Task.FromResult(IntegrationTransport.Response("{\"belongs_to_collection\":{\"id\":9,\"name\":\"Saga\"}}"));
                case "/api/v1/collection/9": return Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new { parts = new[] { new { id = 123, title = "First", releaseDate = "2000-01-01", mediaInfo = new { status = 5 } }, new { id = 124, title = "Second", releaseDate, mediaInfo = new { status = 1 } } } })));
                case "/api/v1/service/radarr": return Task.FromResult(IntegrationTransport.Response("[{\"id\":0,\"name\":\"Radarr\",\"is4k\":false,\"isDefault\":true}]"));
                case "/api/v1/user": return Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new[] { new { id = 22, jellyfinUserId = user.Id.ToString("N") } } })));
                case "/api/v1/request":
                    Interlocked.Increment(ref posts);
                    return Task.FromResult(IntegrationTransport.Response("{}", 201));
                default: throw new InvalidOperationException("Unexpected URL " + request.RequestUri);
            }
        });
        var old = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = culture;
            await new AutoMovieRequestService(transport, f.Core.Logger, users.Object, null!).CheckMovieForCollectionRequestAsync(movie, user.Id);
        }
        finally { CultureInfo.CurrentCulture = old; }
        return posts;
    }

    // Seerr's /service/radarr list for the quality-mode tests: server 0 is the default non-4K server,
    // server 1 is a 4K server.
    private const string RadarrServers = "[{\"id\":0,\"name\":\"Radarr\",\"is4k\":false,\"isDefault\":true},{\"id\":1,\"name\":\"Radarr 4K\",\"is4k\":true,\"isDefault\":true}]";

    [Theory]
    // 4K server: the request carries is4k with the chosen server, profile and root folder.
    [InlineData("custom", 1, "ok", "{\"mediaType\":\"movie\",\"mediaId\":124,\"serverId\":1,\"profileId\":7,\"rootFolder\":\"/movies\",\"is4k\":true}", 1)]
    // Non-4K server, unknown id, failed or unreadable lookup: the body is the one sent before is4k was resolved.
    [InlineData("custom", 0, "ok", "{\"mediaType\":\"movie\",\"mediaId\":124,\"serverId\":0,\"profileId\":7,\"rootFolder\":\"/movies\"}", 1)]
    [InlineData("custom", 5, "ok", "{\"mediaType\":\"movie\",\"mediaId\":124,\"serverId\":5,\"profileId\":7,\"rootFolder\":\"/movies\"}", 1)]
    [InlineData("custom", 1, "error", "{\"mediaType\":\"movie\",\"mediaId\":124,\"serverId\":1,\"profileId\":7,\"rootFolder\":\"/movies\"}", 2)]
    [InlineData("custom", 1, "throw", "{\"mediaType\":\"movie\",\"mediaId\":124,\"serverId\":1,\"profileId\":7,\"rootFolder\":\"/movies\"}", 2)]
    [InlineData("custom", 1, "html", "{\"mediaType\":\"movie\",\"mediaId\":124,\"serverId\":1,\"profileId\":7,\"rootFolder\":\"/movies\"}", 2)]
    // Custom mode without a server, and the other modes, never read the server list.
    [InlineData("custom", -1, "ok", "{\"mediaType\":\"movie\",\"mediaId\":124,\"profileId\":7,\"rootFolder\":\"/movies\"}", 0)]
    [InlineData("default", 1, "ok", "{\"mediaType\":\"movie\",\"mediaId\":124}", 0)]
    [InlineData("original", 1, "ok", "{\"mediaType\":\"movie\",\"mediaId\":124,\"serverId\":3,\"profileId\":4,\"rootFolder\":\"/hd\"}", 0)]
    public async Task QualityModeRequestBodyRoutesCustom4kServerAsA4kRequest(string mode, int serverId, string lookup, string expectedBody, int expectedListReads)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.AutoMovieRequestEnabled = true;
        config.JellyseerrEnabled = true;
        config.TMDB_API_KEY = "test-tmdb";
        config.JellyseerrUrls = "http://seerr.test";
        config.JellyseerrApiKey = "test-seerr";
        config.AutoMovieRequestCheckReleaseDate = false;
        config.AutoMovieRequestQualityMode = mode;
        config.AutoMovieRequestCustomServerId = serverId;
        config.AutoMovieRequestCustomProfileId = 7;
        config.AutoMovieRequestCustomRootFolder = "/movies";
        var user = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(user.Id)).Returns(user);
        var movie = new Movie { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "123" } };
        var bodies = new List<string>();
        var listReads = 0;
        using var transport = new IntegrationTransport(async (request, ct) =>
        {
            switch (request.RequestUri!.AbsolutePath)
            {
                case "/3/movie/123": return IntegrationTransport.Response("{\"belongs_to_collection\":{\"id\":9,\"name\":\"Saga\"}}");
                case "/api/v1/collection/9": return IntegrationTransport.Response(JsonSerializer.Serialize(new { parts = new[] { new { id = 123, title = "First", releaseDate = "2000-01-01", mediaInfo = new { status = 5 } }, new { id = 124, title = "Second", releaseDate = "2001-01-01", mediaInfo = new { status = 1 } } } }));
                // The watched movie's own request, read by "original" mode.
                case "/api/v1/movie/123": return IntegrationTransport.Response("{\"mediaInfo\":{\"requests\":[{\"serverId\":3,\"profileId\":4,\"rootFolder\":\"/hd\",\"is4k\":false}]}}");
                case "/api/v1/service/radarr":
                    listReads++;
                    return lookup switch
                    {
                        "ok" => IntegrationTransport.Response(RadarrServers),
                        "error" => IntegrationTransport.Response("{}", 500),
                        "html" => IntegrationTransport.Response("<html></html>", 200, "text/html"),
                        _ => throw new HttpRequestException("connection refused"),
                    };
                case "/api/v1/user": return IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new[] { new { id = 22, jellyfinUserId = user.Id.ToString("N") } } }));
                case "/api/v1/request":
                    bodies.Add(await request.Content!.ReadAsStringAsync(ct));
                    return IntegrationTransport.Response("{}", 201);
                default: throw new InvalidOperationException("Unexpected URL " + request.RequestUri);
            }
        });
        var service = new AutoMovieRequestService(transport, f.Core.Logger, users.Object, null!);
        await service.CheckMovieForCollectionRequestAsync(movie, user.Id);
        // A second request within the cache window reuses a server list it read successfully.
        service.ClearRequestCache();
        await service.CheckMovieForCollectionRequestAsync(movie, user.Id);
        Assert.Equal(new[] { expectedBody, expectedBody }, bodies);
        Assert.Equal(expectedListReads, listReads);
    }

    [Fact]
    public async Task OriginalMode4kRequestStillFollowsFallbackSetting()
    {
        // "original" copies is4k from the watched movie's request, and AutoMovieRequestFallbackOn4k
        // still turns that into a default request; neither path reads the Radarr server list.
        foreach (var fallback in new[] { true, false })
        {
            using var f = new ApiPluginFixture();
            var config = f.Plugin.Configuration;
            config.AutoMovieRequestEnabled = true;
            config.JellyseerrEnabled = true;
            config.TMDB_API_KEY = "test-tmdb";
            config.JellyseerrUrls = "http://seerr.test";
            config.JellyseerrApiKey = "test-seerr";
            config.AutoMovieRequestCheckReleaseDate = false;
            config.AutoMovieRequestQualityMode = "original";
            config.AutoMovieRequestFallbackOn4k = fallback;
            var user = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
            var users = new Mock<IUserManager>();
            users.Setup(u => u.GetUserById(user.Id)).Returns(user);
            var movie = new Movie { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "123" } };
            string? body = null;
            using var transport = new IntegrationTransport(async (request, ct) =>
            {
                switch (request.RequestUri!.AbsolutePath)
                {
                    case "/3/movie/123": return IntegrationTransport.Response("{\"belongs_to_collection\":{\"id\":9,\"name\":\"Saga\"}}");
                    case "/api/v1/collection/9": return IntegrationTransport.Response(JsonSerializer.Serialize(new { parts = new[] { new { id = 123, title = "First", releaseDate = "2000-01-01", mediaInfo = new { status = 5 } }, new { id = 124, title = "Second", releaseDate = "2001-01-01", mediaInfo = new { status = 1 } } } }));
                    case "/api/v1/movie/123": return IntegrationTransport.Response("{\"mediaInfo\":{\"requests\":[{\"serverId\":1,\"profileId\":9,\"rootFolder\":\"/uhd\",\"is4k\":true}]}}");
                    case "/api/v1/user": return IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new[] { new { id = 22, jellyfinUserId = user.Id.ToString("N") } } }));
                    case "/api/v1/request":
                        body = await request.Content!.ReadAsStringAsync(ct);
                        return IntegrationTransport.Response("{}", 201);
                    default: throw new InvalidOperationException("Unexpected URL " + request.RequestUri);
                }
            });
            await new AutoMovieRequestService(transport, f.Core.Logger, users.Object, null!).CheckMovieForCollectionRequestAsync(movie, user.Id);
            Assert.Equal(fallback
                ? "{\"mediaType\":\"movie\",\"mediaId\":124}"
                : "{\"mediaType\":\"movie\",\"mediaId\":124,\"serverId\":1,\"profileId\":9,\"rootFolder\":\"/uhd\",\"is4k\":true}", body);
        }
    }

    private const string Custom4kBody = "{\"mediaType\":\"movie\",\"mediaId\":124,\"serverId\":1,\"profileId\":7,\"rootFolder\":\"/movies\",\"is4k\":true}";
    private const string Original4kBody = "{\"mediaType\":\"movie\",\"mediaId\":124,\"serverId\":1,\"profileId\":9,\"rootFolder\":\"/uhd\",\"is4k\":true}";
    private const string DefaultBody = "{\"mediaType\":\"movie\",\"mediaId\":124}";

    [Theory]
    // A 4K request is blocked by a pending, processing or available 4K copy (status4k), like status blocks
    // today; once the 4K copy is gone the next play sends the expected body.
    [InlineData("custom", 1, 2, false, true, Custom4kBody)]
    [InlineData("custom", 1, 3, false, true, Custom4kBody)]
    [InlineData("custom", 1, 5, false, true, Custom4kBody)]
    [InlineData("original", -1, 2, false, true, Original4kBody)]
    [InlineData("original", -1, 5, false, true, Original4kBody)]
    // Other 4K states still request.
    [InlineData("custom", 1, 1, false, false, Custom4kBody)]
    [InlineData("custom", 1, 4, false, false, Custom4kBody)]
    // A non-4K request ignores status4k.
    [InlineData("custom", 0, 2, false, false, "{\"mediaType\":\"movie\",\"mediaId\":124,\"serverId\":0,\"profileId\":7,\"rootFolder\":\"/movies\"}")]
    [InlineData("custom", 0, 5, false, false, "{\"mediaType\":\"movie\",\"mediaId\":124,\"serverId\":0,\"profileId\":7,\"rootFolder\":\"/movies\"}")]
    [InlineData("default", -1, 2, false, false, DefaultBody)]
    [InlineData("default", -1, 5, false, false, DefaultBody)]
    // The 4K fallback turns an original 4K request into a default one, so status4k doesn't block it.
    [InlineData("original", -1, 2, true, false, DefaultBody)]
    public async Task FourKRequestHonoursCollectionStatus4k(string mode, int serverId, int status4k, bool fallback, bool blocked, string expectedBody)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.AutoMovieRequestEnabled = true;
        config.JellyseerrEnabled = true;
        config.TMDB_API_KEY = "test-tmdb";
        config.JellyseerrUrls = "http://seerr.test";
        config.JellyseerrApiKey = "test-seerr";
        config.AutoMovieRequestCheckReleaseDate = false;
        config.AutoMovieRequestQualityMode = mode;
        config.AutoMovieRequestFallbackOn4k = fallback;
        config.AutoMovieRequestCustomServerId = serverId;
        config.AutoMovieRequestCustomProfileId = 7;
        config.AutoMovieRequestCustomRootFolder = "/movies";
        var user = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(user.Id)).Returns(user);
        var movie = new Movie { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "123" } };
        int? nextStatus4k = status4k;
        var bodies = new List<string>();
        using var transport = new IntegrationTransport(async (request, ct) =>
        {
            switch (request.RequestUri!.AbsolutePath)
            {
                case "/3/movie/123": return IntegrationTransport.Response("{\"belongs_to_collection\":{\"id\":9,\"name\":\"Saga\"}}");
                case "/api/v1/collection/9": return IntegrationTransport.Response(JsonSerializer.Serialize(new { parts = new object[] { new { id = 123, title = "First", releaseDate = "2000-01-01", mediaInfo = new { status = 5 } }, new { id = 124, title = "Second", releaseDate = "2001-01-01", mediaInfo = new { status = 1, status4k = nextStatus4k } } } }));
                // The watched movie's own 4K request, read by "original" mode.
                case "/api/v1/movie/123": return IntegrationTransport.Response("{\"mediaInfo\":{\"requests\":[{\"serverId\":1,\"profileId\":9,\"rootFolder\":\"/uhd\",\"is4k\":true}]}}");
                case "/api/v1/service/radarr": return IntegrationTransport.Response(RadarrServers);
                case "/api/v1/user": return IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new[] { new { id = 22, jellyfinUserId = user.Id.ToString("N") } } }));
                case "/api/v1/request":
                    bodies.Add(await request.Content!.ReadAsStringAsync(ct));
                    return IntegrationTransport.Response("{}", 201);
                default: throw new InvalidOperationException("Unexpected URL " + request.RequestUri);
            }
        });
        var service = new AutoMovieRequestService(transport, f.Core.Logger, users.Object, null!);
        await service.CheckMovieForCollectionRequestAsync(movie, user.Id);
        if (blocked)
        {
            Assert.Empty(bodies);
            // A blocked 4K request leaves no per-user cache entry, so once the 4K request is gone the
            // next play requests again within the hour.
            nextStatus4k = null;
            await service.CheckMovieForCollectionRequestAsync(movie, user.Id);
        }
        Assert.Equal(new[] { expectedBody }, bodies);
    }

    [Fact]
    public async Task RadarrServerListCacheFollowsApiKeyAndKeepsSeerrDetailsOutOfTheLog()
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.AutoMovieRequestEnabled = true;
        config.JellyseerrEnabled = true;
        config.TMDB_API_KEY = "test-tmdb";
        config.JellyseerrUrls = "http://seerr-admin:url-secret@seerr.test";
        config.JellyseerrApiKey = "seerr-key-one";
        config.AutoMovieRequestCheckReleaseDate = false;
        config.AutoMovieRequestQualityMode = "custom";
        config.AutoMovieRequestCustomServerId = 1;
        var user = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(user.Id)).Returns(user);
        var movie = new Movie { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "123" } };
        var listKeys = new List<string>();
        var lookup = "ok";
        var bodies = new List<string>();
        using var transport = new IntegrationTransport(async (request, ct) =>
        {
            switch (request.RequestUri!.AbsolutePath)
            {
                case "/3/movie/123": return IntegrationTransport.Response("{\"belongs_to_collection\":{\"id\":9,\"name\":\"Saga\"}}");
                case "/api/v1/collection/9": return IntegrationTransport.Response(JsonSerializer.Serialize(new { parts = new[] { new { id = 123, title = "First", releaseDate = "2000-01-01", mediaInfo = new { status = 5 } }, new { id = 124, title = "Second", releaseDate = "2001-01-01", mediaInfo = new { status = 1 } } } }));
                case "/api/v1/service/radarr":
                    listKeys.Add(request.Headers.GetValues("X-Api-Key").Single());
                    return lookup switch
                    {
                        "ok" => IntegrationTransport.Response(RadarrServers),
                        "unexpected" => IntegrationTransport.Response("{}"),
                        // The real .NET form: the host and port without a scheme.
                        _ => throw new HttpRequestException(HttpRequestError.ConnectionError, "Connection refused (seerr.test:80)"),
                    };
                case "/api/v1/user": return IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new[] { new { id = 22, jellyfinUserId = user.Id.ToString("N") } } }));
                case "/api/v1/request":
                    bodies.Add(await request.Content!.ReadAsStringAsync(ct));
                    return IntegrationTransport.Response("{}", 201);
                default: throw new InvalidOperationException("Unexpected URL " + request.RequestUri);
            }
        });
        var service = new AutoMovieRequestService(transport, f.Core.Logger, users.Object, null!);
        async Task Play()
        {
            service.ClearRequestCache();
            await service.CheckMovieForCollectionRequestAsync(movie, user.Id);
        }

        await Play();
        await Play();
        Assert.Equal(new[] { "seerr-key-one" }, listKeys);
        // A new key behind the same URL reads the list again instead of reusing the old key's entry.
        config.JellyseerrApiKey = "seerr-key-two";
        await Play();
        Assert.Equal(new[] { "seerr-key-one", "seerr-key-two" }, listKeys);
        // Failed reads are not cached and log neither the Seerr URL nor the key.
        config.JellyseerrApiKey = "seerr-key-three";
        lookup = "throw";
        await Play();
        lookup = "unexpected";
        await Play();
        Assert.Equal(new[] { "seerr-key-one", "seerr-key-two", "seerr-key-three", "seerr-key-three" }, listKeys);
        Assert.Equal(5, bodies.Count);
        var log = string.Concat(Directory.GetFiles(f.Core.Root, "JellyfinEnhanced_*.log").Select(File.ReadAllText));
        Assert.Contains("Error reading Radarr server list from Seerr URL #1: HttpRequestException error=ConnectionError", log, StringComparison.Ordinal);
        Assert.DoesNotContain("Connection refused", log, StringComparison.Ordinal);
        Assert.Contains("Unexpected Radarr server list from Seerr URL #1", log, StringComparison.Ordinal);
        Assert.DoesNotContain("seerr.test", log, StringComparison.Ordinal);
        Assert.DoesNotContain("url-secret", log, StringComparison.Ordinal);
        Assert.DoesNotContain("seerr-key-", log, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(false, true)][InlineData(true, false)][InlineData(true, true)]
    public async Task DisabledAutomaticRequestsDoNotConsultUsersOrNetwork(bool feature, bool seerr)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.AutoMovieRequestEnabled = feature;
        config.AutoSeasonRequestEnabled = feature;
        config.JellyseerrEnabled = seerr;
        // Everything else a request needs is configured, so only the switches can stop it.
        config.TMDB_API_KEY = "test-tmdb";
        config.JellyseerrUrls = "http://seerr.test";
        config.JellyseerrApiKey = "test-seerr";
        var user = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(user.Id)).Returns(user);
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("{}", 404)));
        var movie = new Movie { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "123" } };
        await new AutoMovieRequestService(transport, f.Core.Logger, users.Object, null!).CheckMovieForCollectionRequestAsync(movie, user.Id);
        var movieCalls = transport.Calls;
        await new AutoSeasonRequestService(transport, f.Core.Logger, users.Object, null!, null!).CheckEpisodeCompletionAsync(new Episode(), user.Id);
        var enabled = feature && seerr;
        // The enabled control proves this setup reaches the user lookup and the TMDB request.
        users.Verify(u => u.GetUserById(user.Id), enabled ? Times.Exactly(2) : Times.Never());
        Assert.Equal(enabled ? 1 : 0, movieCalls);
        Assert.Equal(movieCalls, transport.Calls);
    }
    [Theory]
    [InlineData(7, 10, 1, false, 0)]
    [InlineData(8, 10, 1, false, 1)]
    [InlineData(10, 0, 1, false, 0)]
    [InlineData(10, 10, 5, false, 0)]
    [InlineData(10, 10, 1, true, 0)]
    [InlineData(8, 10, 1, false, 0, true, false)]
    [InlineData(8, 10, 1, false, 1, true, true)]
    [InlineData(8, 10, 1, false, 2, false, false, true)]
    public async Task SeasonThresholdAvailabilityAndExistingRequestsControlAutomaticRequest(int episodeNumber, int nextEpisodeCount, int nextStatus, bool existingRequest, int expectedPosts, bool requireWatched = false, bool priorPlayed = false, bool failFirst = false)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.AutoSeasonRequestEnabled = true;
        config.JellyseerrEnabled = true;
        config.JellyseerrUrls = "http://seerr.test";
        config.JellyseerrApiKey = "test";
        config.AutoSeasonRequestThresholdValue = 2;
        config.AutoSeasonRequestRequireAllWatched = requireWatched;
        var user = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(user.Id)).Returns(user);
        var series = new Series { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "42" } };
        var episode = new Episode { Id = Guid.NewGuid(), SeriesId = series.Id, ParentIndexNumber = 1, IndexNumber = episodeNumber };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById(series.Id)).Returns(series);
        var priorEpisode = new Episode { Id = Guid.NewGuid(), SeriesId = series.Id, ParentIndexNumber = 1, IndexNumber = 1 };
        library.Setup(l => l.GetItemsResult(It.IsAny<InternalItemsQuery>())).Returns(new MediaBrowser.Model.Querying.QueryResult<BaseItem> { Items = new BaseItem[] { priorEpisode, episode } });
        var data = new Mock<IUserDataManager>();
        data.Setup(d => d.GetUserData(user, priorEpisode)).Returns(new UserItemData { Key = "prior", Played = priorPlayed });
        var previousLibrary = BaseItem.LibraryManager;
        BaseItem.LibraryManager = library.Object;
        try
        {
            var posts = new List<string>();
            using var transport = new IntegrationTransport(async (request, ct) =>
            {
                if (request.RequestUri!.AbsolutePath == "/api/v1/tv/42")
                    return IntegrationTransport.Response(JsonSerializer.Serialize(new
                    {
                        numberOfSeasons = 2,
                        seasons = new[] { new { seasonNumber = 1, episodeCount = 10, status = 5 }, new { seasonNumber = 2, episodeCount = nextEpisodeCount, status = nextStatus } },
                        mediaInfo = new { requests = existingRequest ? new[] { new { seasons = new[] { new { seasonNumber = 2 } } } } : Array.Empty<object>() }
                    }));
                if (request.RequestUri.AbsolutePath == "/api/v1/user")
                    return IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new[] { new { id = 22, jellyfinUserId = user.Id.ToString() } } }));
                if (request.Method == HttpMethod.Post)
                {
                    posts.Add(await request.Content!.ReadAsStringAsync(ct));
                    return IntegrationTransport.Response("{}", failFirst && posts.Count == 1 ? 500 : 201);
                }
                throw new InvalidOperationException("Unexpected URL " + request.RequestUri);
            });
            var service = new AutoSeasonRequestService(transport, f.Core.Logger, users.Object, data.Object, library.Object);
            await service.CheckEpisodeCompletionAsync(episode, user.Id);
            await service.CheckEpisodeCompletionAsync(episode, user.Id);
            Assert.Equal(expectedPosts, posts.Count);
            foreach (var post in posts)
            {
                using var payload = JsonDocument.Parse(post);
                Assert.Equal("tv", payload.RootElement.GetProperty("mediaType").GetString());
                Assert.Equal(42, payload.RootElement.GetProperty("mediaId").GetInt32());
                Assert.Equal(2, Assert.Single(payload.RootElement.GetProperty("seasons").EnumerateArray()).GetInt32());
            }
        }
        finally { BaseItem.LibraryManager = previousLibrary; }
    }

}
