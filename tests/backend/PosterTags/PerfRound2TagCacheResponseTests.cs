using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
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
    [Fact]
    public async Task ExecutedResponsesAndValidatorsRemainUserIsolatedAfterAccessChanges()
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.TagCacheServerMode = true;
        fixture.Plugin.Configuration.SpoilerBlurEnabled = false;
        fixture.Plugin.Configuration.ShowUserReviews = false;
        var alice = new User("alice", "default", "default") { Id = Guid.NewGuid() };
        var bob = new User("bob", "default", "default") { Id = Guid.NewGuid() };
        var first = Guid.NewGuid(); var second = Guid.NewGuid();
        Guid[] aliceAccess = [first];
        var users = new Mock<IUserManager>();
        users.Setup(x => x.GetUserById(alice.Id)).Returns(alice);
        users.Setup(x => x.GetUserById(bob.Id)).Returns(bob);
        var library = new Mock<ILibraryManager>();
        library.Setup(x => x.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => q.User == alice ? aliceAccess : [second]);
        Directory.CreateDirectory(fixture.Core.ConfigRoot);
        File.WriteAllText(Path.Combine(fixture.Core.ConfigRoot, "tag-cache.json"), JsonSerializer.Serialize(new
        {
            SchemaVersion = 7, Version = 9, LastModified = 200,
            Items = new Dictionary<string, TagCacheEntry>
            {
                [first.ToString("N")] = new() { Type = "Movie", Genres = ["First secret"], LastUpdated = 100 },
                [second.ToString("N")] = new() { Type = "Movie", Genres = ["Second secret"], LastUpdated = 200 }
            }
        }));
        using var cache = new TagCacheService(library.Object, fixture.Core.Paths.Object, Mock.Of<ILocalizationManager>(), fixture.Core.Logger);
        cache.LoadFromDisk();
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddControllers().AddJsonOptions(options =>
        {
            options.JsonSerializerOptions.PropertyNamingPolicy = null;
            options.JsonSerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
        });
        using var provider = services.BuildServiceProvider();
        var controller = ApiAssetTests.Controller(fixture.Core, users.Object, cache);

        async Task<(int Status, string ETag, string Body)> Read(User user, string? validator = null)
        {
            var http = new DefaultHttpContext { RequestServices = provider };
            http.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", user.Id.ToString())], "test"));
            http.Request.Method = "GET";
            http.Request.Headers.Accept = "application/json";
            if (validator != null) http.Request.Headers.IfNoneMatch = validator;
            using var stream = new MemoryStream();
            http.Response.Body = stream;
            controller.ControllerContext = new ControllerContext { HttpContext = http };
            var result = controller.GetTagCache(user.Id);
            await result.ExecuteResultAsync(new ActionContext(http, new RouteData(), new ActionDescriptor()));
            return (http.Response.StatusCode, http.Response.Headers.ETag.ToString(), System.Text.Encoding.UTF8.GetString(stream.ToArray()));
        }

        var a = await Read(alice);
        Assert.Equal(200, a.Status); Assert.NotEmpty(a.ETag);
        Assert.Contains("First secret", a.Body); Assert.DoesNotContain("Second secret", a.Body);
        using (var body = JsonDocument.Parse(a.Body))
        {
            Assert.Equal(1, body.RootElement.GetProperty("count").GetInt32());
            Assert.Equal("Movie", body.RootElement.GetProperty("items").GetProperty(first.ToString("N")).GetProperty("Type").GetString());
            Assert.False(body.RootElement.TryGetProperty("reviewRatings", out _));
        }
        var aAgain = await Read(alice, a.ETag);
        Assert.Equal(304, aAgain.Status); Assert.Empty(aAgain.Body);
        var b = await Read(bob, a.ETag);
        Assert.Equal(200, b.Status); Assert.NotEqual(a.ETag, b.ETag);
        Assert.Contains("Second secret", b.Body); Assert.DoesNotContain("First secret", b.Body);
        Assert.Equal(304, (await Read(bob, b.ETag)).Status);
        aliceAccess = [second];
        cache.InvalidateUserAccess();
        var changed = await Read(alice, a.ETag);
        Assert.Equal(200, changed.Status);
        Assert.Contains("Second secret", changed.Body); Assert.DoesNotContain("First secret", changed.Body);
        Assert.NotEqual(a.ETag, changed.ETag);
    }
}
