using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Globalization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class PerfRound2TagCacheResponseTests
{
    /// <summary>
    /// GET /tag-cache over a real TagCacheService: two movies (one per user by
    /// default) and an episode of a series Alice can put under Spoiler Guard.
    /// Library access and Alice's played items are mutable per test.
    /// </summary>
    private sealed class Endpoint : IDisposable
    {
        public readonly ApiPluginFixture Fixture = new();
        public readonly User Alice = new("alice", "default", "default") { Id = Guid.NewGuid() };
        public readonly User Bob = new("bob", "default", "default") { Id = Guid.NewGuid() };
        public readonly Guid First = Guid.NewGuid(), Second = Guid.NewGuid(), Episode = Guid.NewGuid(), SeriesId = Guid.NewGuid();
        public Guid[] AliceAccess;
        public readonly HashSet<Guid> AlicePlayed = [];
        public readonly Mock<ILibraryManager> Library = new();
        public readonly TagCacheService Cache;
        public readonly JellyfinEnhancedController Controller;
        private readonly ServiceProvider _provider;

        public Endpoint()
        {
            Fixture.Plugin.Configuration.TagCacheServerMode = true;
            Fixture.Plugin.Configuration.SpoilerBlurEnabled = false;
            Fixture.Plugin.Configuration.ShowUserReviews = false;
            AliceAccess = [First];
            var users = new Mock<IUserManager>();
            users.Setup(x => x.GetUserById(Alice.Id)).Returns(Alice);
            users.Setup(x => x.GetUserById(Bob.Id)).Returns(Bob);
            Library.Setup(x => x.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
                q.IsPlayed == true ? (q.User == Alice ? [.. q.ItemIds.Where(AlicePlayed.Contains)] : [])
                : q.User == Alice ? AliceAccess : [Second]);
            Directory.CreateDirectory(Fixture.Core.ConfigRoot);
            File.WriteAllText(Path.Combine(Fixture.Core.ConfigRoot, "tag-cache.json"), JsonSerializer.Serialize(new
            {
                SchemaVersion = 7, Version = 9, LastModified = 200,
                Items = new Dictionary<string, TagCacheEntry>
                {
                    [First.ToString("N")] = new() { Type = "Movie", Genres = ["First secret"], LastUpdated = 100 },
                    [Second.ToString("N")] = new() { Type = "Movie", Genres = ["Second secret"], LastUpdated = 200 },
                    [Episode.ToString("N")] = new() { Type = "Episode", SeriesId = SeriesId.ToString("N"), Genres = ["Episode secret"], LastUpdated = 150 }
                }
            }));
            Cache = new TagCacheService(Library.Object, Fixture.Core.Paths.Object, Mock.Of<ILocalizationManager>(), Fixture.Core.Logger);
            Cache.LoadFromDisk();
            var services = new ServiceCollection();
            services.AddLogging();
            services.AddControllers().AddJsonOptions(options =>
            {
                options.JsonSerializerOptions.PropertyNamingPolicy = null;
                options.JsonSerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
            });
            _provider = services.BuildServiceProvider();
            var resolver = new SpoilerUserResolver(Fixture.Core.Manager, Library.Object, Fixture.Core.Logger, null!);
            var userData = Mock.Of<IUserDataManager>();
            Controller = ApiAssetTests.Controller(Fixture.Core, users.Object, Cache, Library.Object, userData, Fixture.Core.Manager, resolver,
                new SpoilerTagDataStripper(Library.Object, userData, resolver));
        }

        /// <summary>Alice guards the episode's series; genres are stripped from unwatched episodes.</summary>
        public void GuardSeries()
        {
            Fixture.Plugin.Configuration.SpoilerBlurEnabled = true;
            Fixture.Plugin.Configuration.SpoilerStripTags = true;
            var state = new UserSpoilerBlur();
            state.Series[SeriesId.ToString("N")] = new();
            Fixture.Core.Manager.SaveUserConfiguration(Alice.Id.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName, state);
        }

        public void SignIn(User caller, bool admin = false) => Controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext { RequestServices = _provider, User = global::JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(caller.Id, admin) }
        };

        public async Task<(int Status, string ETag, string Body)> Read(User caller, Guid? route = null, long? since = null, string? validator = null, bool admin = false)
        {
            SignIn(caller, admin);
            var http = Controller.HttpContext;
            http.Request.Method = "GET";
            http.Request.Headers.Accept = "application/json";
            if (validator != null) http.Request.Headers.IfNoneMatch = validator;
            using var stream = new MemoryStream();
            http.Response.Body = stream;
            var result = Controller.GetTagCache(route ?? caller.Id, since);
            await result.ExecuteResultAsync(new ActionContext(http, new RouteData(), new ActionDescriptor()));
            return (http.Response.StatusCode, http.Response.Headers.ETag.ToString(), System.Text.Encoding.UTF8.GetString(stream.ToArray()));
        }

        public void Dispose()
        {
            Cache.Dispose();
            _provider.Dispose();
            Fixture.Dispose();
        }
    }

    [Fact]
    public async Task ExecutedResponsesAndValidatorsRemainUserIsolatedAfterAccessChanges()
    {
        using var endpoint = new Endpoint();
        var (alice, bob, first, second) = (endpoint.Alice, endpoint.Bob, endpoint.First, endpoint.Second);

        var a = await endpoint.Read(alice);
        Assert.Equal(200, a.Status); Assert.NotEmpty(a.ETag);
        Assert.Contains("First secret", a.Body); Assert.DoesNotContain("Second secret", a.Body);
        using (var body = JsonDocument.Parse(a.Body))
        {
            Assert.Equal(1, body.RootElement.GetProperty("count").GetInt32());
            Assert.Equal("Movie", body.RootElement.GetProperty("items").GetProperty(first.ToString("N")).GetProperty("Type").GetString());
            Assert.False(body.RootElement.TryGetProperty("reviewRatings", out _));
        }
        var aAgain = await endpoint.Read(alice, validator: a.ETag);
        Assert.Equal(304, aAgain.Status); Assert.Empty(aAgain.Body);
        var b = await endpoint.Read(bob, validator: a.ETag);
        Assert.Equal(200, b.Status); Assert.NotEqual(a.ETag, b.ETag);
        Assert.Contains("Second secret", b.Body); Assert.DoesNotContain("First secret", b.Body);
        Assert.Equal(304, (await endpoint.Read(bob, validator: b.ETag)).Status);
        endpoint.AliceAccess = [second];
        endpoint.Cache.InvalidateUserAccess();
        var changed = await endpoint.Read(alice, validator: a.ETag);
        Assert.Equal(200, changed.Status);
        Assert.Contains("Second secret", changed.Body); Assert.DoesNotContain("First secret", changed.Body);
        Assert.NotEqual(a.ETag, changed.ETag);
    }

    [Fact]
    public async Task EmptyRouteUserStillAppliesTheCallersOwnSpoilerGuard()
    {
        // An empty route id resolves to the caller; their Spoiler Guard state must
        // be the one applied, not the (absent) state of the empty id.
        using var endpoint = new Endpoint();
        endpoint.AliceAccess = [endpoint.First, endpoint.Episode];
        endpoint.GuardSeries();
        var own = await endpoint.Read(endpoint.Alice, route: Guid.Empty);
        Assert.Equal(200, own.Status);
        Assert.Contains(endpoint.Episode.ToString("N"), own.Body); Assert.DoesNotContain("Episode secret", own.Body);

        var series = new Series { Id = endpoint.SeriesId, Name = "Show", Genres = ["Series secret"] };
        endpoint.Library.Setup(x => x.GetItemById<BaseItem>(series.Id, It.IsAny<User>())).Returns(series);
        endpoint.Library.Setup(x => x.GetItemList(It.IsAny<InternalItemsQuery>())).Returns([]); // no episodes: the unguarded projection still completes
        endpoint.SignIn(endpoint.Alice);
        var tagData = Assert.IsType<OkObjectResult>(endpoint.Controller.GetTagData(Guid.Empty, [series.Id.ToString()]));
        var json = JsonSerializer.Serialize(tagData.Value);
        Assert.Contains(series.Id.ToString(), json); Assert.DoesNotContain("Series secret", json);
    }
}
