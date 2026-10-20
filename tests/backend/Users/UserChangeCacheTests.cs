using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Data.Events.Users;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Api.Controllers;
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

/// <summary>
/// A user's policy changed with no host event: Jellyfin 10.11 saves a policy (the Dashboard's user page) without
/// publishing UserUpdated, and both versions save UpdateUserAsync without one. The caches keyed by a user's authority
/// must still apply the change to the next request. Users are fresh objects per lookup, as Jellyfin's
/// GetUserById reads them from its database on both versions.
/// </summary>
internal static class UserChange
{
    /// <summary>A user as Jellyfin's database returns them: a new object, every folder, not hidden.</summary>
    public static User Read(Guid id, string name = "alice", Action<User>? policy = null)
    {
        var user = new User(name, "default", "default") { Id = id };
        user.SetPermission(PermissionKind.EnableAllFolders, true);
        user.SetPermission(PermissionKind.IsHidden, false);
        user.SetPermission(PermissionKind.IsDisabled, false);
        policy?.Invoke(user);
        return user;
    }

    /// <summary>Each authority field a policy POST can change (see UserAuthority).</summary>
    public static readonly Dictionary<string, Action<User>> Changes = new()
    {
        ["parental"] = u => u.MaxParentalRatingScore = 10,
        ["blockedTag"] = u => u.SetPreference(PreferenceKind.BlockedTags, ["second"]),
        ["allowedTag"] = u => u.SetPreference(PreferenceKind.AllowedTags, ["first"]),
        ["unrated"] = u => u.SetPreference(PreferenceKind.BlockUnratedItems, [UnratedItem.Movie]),
        ["folders"] = u => { u.SetPermission(PermissionKind.EnableAllFolders, false); u.SetPreference(PreferenceKind.EnabledFolders, [Guid.NewGuid().ToString("N")]); },
        ["blockedFolders"] = u => u.SetPreference(PreferenceKind.BlockedMediaFolders, [Guid.NewGuid().ToString("N")]),
    };

    /// <summary>Whether any of <see cref="Changes"/> restricts the user (what the library stand-in filters by).</summary>
    public static bool Restricted(User u)
        => u.MaxParentalRatingScore.HasValue
            || (u.GetPreference(PreferenceKind.BlockedTags)?.Length ?? 0) > 0
            || (u.GetPreference(PreferenceKind.AllowedTags)?.Length ?? 0) > 0
            || u.GetPreferenceValues<UnratedItem>(PreferenceKind.BlockUnratedItems).Length > 0
            || !u.HasPermission(PermissionKind.EnableAllFolders)
            || u.GetPreferenceValues<Guid>(PreferenceKind.BlockedMediaFolders).Length > 0;

    /// <summary>
    /// Jellyfin's user policy POST (Dashboard → Users → user → save) as it runs on a server: inside JE's MVC bracket,
    /// with <paramref name="write"/> as the save, and no host event (10.11 publishes none for a policy).
    /// </summary>
    public static Task PolicyPost(Guid person, Action write)
    {
        var context = JellyfinUserBracketHarness.Context<UserController>("UpdateUserPolicy", new Dictionary<string, object?> { ["userId"] = person });
        return JellyfinUserBracketHarness.New().OnActionExecutionAsync(context, () =>
        {
            write();
            return JellyfinUserBracketHarness.Done(context);
        });
    }
}

/// <summary>
/// GET /tag-cache and the reviews routes, end to end, after a policy change no event announced: the response
/// reflects the change on the very next request (before: up to the 60 s access TTL, the 15 s author TTL).
/// </summary>
[Collection("Plugin singleton")]
public class UserChangeEndpointTests
{
    private sealed class Endpoint : IDisposable
    {
        public readonly ApiPluginFixture Fixture = new();
        public readonly Guid AliceId = Guid.NewGuid(), BobId = Guid.NewGuid();
        public readonly Guid First = Guid.NewGuid(), Second = Guid.NewGuid();
        public readonly Dictionary<Guid, User> Current = new();
        public int AccessQueries;
        public readonly TagCacheService Cache;
        public readonly JellyfinEnhancedController Controller;
        private readonly ServiceProvider _provider;

        public Endpoint()
        {
            Fixture.Plugin.Configuration.TagCacheServerMode = true;
            Fixture.Plugin.Configuration.SpoilerBlurEnabled = false;
            Fixture.Plugin.Configuration.ShowUserReviews = false;
            Fixture.Plugin.Configuration.HideReviewsFromHiddenUsers = true;
            Fixture.Plugin.Configuration.HideReviewsFromDisabledUsers = true;
            Current[AliceId] = UserChange.Read(AliceId);
            Current[BobId] = UserChange.Read(BobId, "bob");
            var users = new Mock<IUserManager>();
            // Jellyfin reads the user from its database on every call: a new object each time.
            users.Setup(x => x.GetUserById(It.IsAny<Guid>())).Returns((Guid id) => Current.TryGetValue(id, out var u) ? Clone(u) : null);
            var library = new Mock<ILibraryManager>();
            library.Setup(x => x.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
            {
                if (q.IsPlayed == true || q.User == null) return [];
                Interlocked.Increment(ref AccessQueries);
                return UserChange.Restricted(q.User) ? [First] : [First, Second];
            });
            Directory.CreateDirectory(Fixture.Core.ConfigRoot);
            File.WriteAllText(Path.Combine(Fixture.Core.ConfigRoot, "tag-cache.json"), JsonSerializer.Serialize(new
            {
                SchemaVersion = 8, Version = 9, LastModified = 200,
                Items = new Dictionary<string, TagCacheEntry>
                {
                    [First.ToString("N")] = new() { Type = "Movie", Genres = ["First secret"], LastUpdated = 100 },
                    [Second.ToString("N")] = new() { Type = "Movie", Genres = ["Second secret"], LastUpdated = 200 },
                }
            }));
            Cache = new TagCacheService(library.Object, Fixture.Core.Paths.Object, Mock.Of<ILocalizationManager>(), Fixture.Core.Logger);
            Cache.LoadFromDisk();
            var services = new ServiceCollection();
            services.AddLogging();
            services.AddControllers().AddJsonOptions(options =>
            {
                options.JsonSerializerOptions.PropertyNamingPolicy = null;
                options.JsonSerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
            });
            _provider = services.BuildServiceProvider();
            var resolver = new SpoilerUserResolver(Fixture.Core.Manager, library.Object, Fixture.Core.Logger, null!);
            var userData = Mock.Of<IUserDataManager>();
            Controller = ApiAssetTests.Controller(Fixture.Core, users.Object, Cache, library.Object, userData, Fixture.Core.Manager, resolver,
                new SpoilerTagDataStripper(library.Object, userData, resolver));
        }

        // A copy with the same policy (the database's next read of an unchanged user).
        private static User Clone(User u)
        {
            var copy = UserChange.Read(u.Id, u.Username);
            copy.MaxParentalRatingScore = u.MaxParentalRatingScore;
            foreach (var kind in new[] { PermissionKind.EnableAllFolders, PermissionKind.IsHidden, PermissionKind.IsDisabled, PermissionKind.IsAdministrator })
                copy.SetPermission(kind, u.HasPermission(kind));
            foreach (var kind in new[] { PreferenceKind.BlockedTags, PreferenceKind.AllowedTags, PreferenceKind.EnabledFolders, PreferenceKind.BlockedMediaFolders, PreferenceKind.BlockUnratedItems })
                copy.SetPreference(kind, u.GetPreference(kind) ?? []);
            return copy;
        }

        public void SignIn(Guid caller) => Controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext { RequestServices = _provider, User = global::JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(caller, false) }
        };

        public async Task<string> TagCache(Guid caller, long? since = null)
        {
            SignIn(caller);
            var http = Controller.HttpContext;
            http.Request.Method = "GET";
            http.Request.Headers.Accept = "application/json";
            using var stream = new MemoryStream();
            http.Response.Body = stream;
            var result = Controller.GetTagCache(caller, since);
            await result.ExecuteResultAsync(new ActionContext(http, new RouteData(), new ActionDescriptor()));
            Assert.Equal(200, http.Response.StatusCode);
            return System.Text.Encoding.UTF8.GetString(stream.ToArray());
        }

        public int Reviews(Guid caller)
        {
            SignIn(caller);
            var ok = Assert.IsType<OkObjectResult>(Controller.GetItemReviews("movie", "42"));
            using var json = JsonDocument.Parse(JsonSerializer.Serialize(ok.Value));
            return json.RootElement.GetProperty("reviews").GetArrayLength();
        }

        public void Dispose()
        {
            Cache.Dispose();
            _provider.Dispose();
            Fixture.Dispose();
        }
    }

    private static string FilterRevision(string body)
    {
        using var json = JsonDocument.Parse(body);
        return json.RootElement.GetProperty("filterRevision").GetString()!;
    }

    [Theory]
    [InlineData("parental")]
    [InlineData("blockedTag")]
    [InlineData("allowedTag")]
    [InlineData("unrated")]
    [InlineData("folders")]
    [InlineData("blockedFolders")]
    public async Task ASilentPolicyWriteNarrowsTheTagCacheOnTheNextRequest(string change)
    {
        using var endpoint = new Endpoint();
        var before = await endpoint.TagCache(endpoint.AliceId);
        Assert.Contains("Second secret", before);
        // Control: the user read again, unchanged, is served from the cached access set.
        Assert.Contains("Second secret", await endpoint.TagCache(endpoint.AliceId));
        Assert.Equal(1, endpoint.AccessQueries);

        // 10.11's policy save: no UserUpdated, no InvalidateUserAccess, no bracket (another plugin's write).
        endpoint.Current[endpoint.AliceId] = UserChange.Read(endpoint.AliceId, policy: UserChange.Changes[change]);
        var after = await endpoint.TagCache(endpoint.AliceId);
        Assert.Contains("First secret", after);
        Assert.DoesNotContain("Second secret", after);
        Assert.NotEqual(FilterRevision(before), FilterRevision(after));
        // A delta from the old copy carries the new filter revision too (the client drops its copy).
        Assert.Equal(FilterRevision(after), FilterRevision(await endpoint.TagCache(endpoint.AliceId, since: 200)));
        // The narrowed set is cached in turn, and lifting the limit widens it again on the next request.
        Assert.Equal(2, endpoint.AccessQueries);
        endpoint.Current[endpoint.AliceId] = UserChange.Read(endpoint.AliceId);
        Assert.Contains("Second secret", await endpoint.TagCache(endpoint.AliceId));
        Assert.Equal(3, endpoint.AccessQueries);
    }

    [Fact]
    public async Task OneUsersSilentChangeLeavesAnotherUsersCachedAccess()
    {
        using var endpoint = new Endpoint();
        await endpoint.TagCache(endpoint.AliceId);
        await endpoint.TagCache(endpoint.BobId);
        Assert.Equal(2, endpoint.AccessQueries);
        endpoint.Current[endpoint.AliceId] = UserChange.Read(endpoint.AliceId, policy: UserChange.Changes["parental"]);
        Assert.DoesNotContain("Second secret", await endpoint.TagCache(endpoint.AliceId));
        Assert.Contains("Second secret", await endpoint.TagCache(endpoint.BobId));
        Assert.Equal(3, endpoint.AccessQueries);
    }

    [Theory]
    [InlineData(PermissionKind.IsHidden)]
    [InlineData(PermissionKind.IsDisabled)]
    public async Task AnAuthorHiddenOrDisabledFromTheDashboardDisappearsFromReviewsOnTheNextRequest(PermissionKind flag)
    {
        using var endpoint = new Endpoint();
        endpoint.Fixture.Core.Manager.UpsertReview(endpoint.BobId.ToString("N"), "movie", "42", "Great", 4, "2026-10-20T00:00:00Z");
        Assert.Equal(1, endpoint.Reviews(endpoint.AliceId));
        Assert.Equal(1, endpoint.Reviews(endpoint.AliceId));

        // The Dashboard's policy save on 10.11: inside JE's bracket, no host event.
        await UserChange.PolicyPost(endpoint.BobId, () => endpoint.Current[endpoint.BobId] = UserChange.Read(endpoint.BobId, "bob", u => u.SetPermission(flag, true)));
        Assert.Equal(0, endpoint.Reviews(endpoint.AliceId));
        // Restored the same way: the review is back on the next request.
        await UserChange.PolicyPost(endpoint.BobId, () => endpoint.Current[endpoint.BobId] = UserChange.Read(endpoint.BobId, "bob"));
        Assert.Equal(1, endpoint.Reviews(endpoint.AliceId));
    }

    [Fact]
    public async Task TheReviewChipOnPostersDropsAnAuthorHiddenWithNoEvent()
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.ShowUserReviews = true;
        plugin.Plugin.Configuration.ShowUserRatingOnPosters = true;
        plugin.Plugin.Configuration.HideReviewsFromHiddenUsers = true;
        var viewer = UserChange.Read(Guid.NewGuid(), "viewer");
        var authorId = Guid.NewGuid();
        var author = UserChange.Read(authorId, "author");
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(authorId)).Returns(() => author);
        plugin.Core.Manager.UpsertReview(authorId.ToString("N"), "movie", "42", "Great", 4, "2026-10-20T00:00:00Z");
        using var ratings = new PosterTagReviewRatings(plugin.Core.Manager, new PosterTagUserCache(users.Object), plugin.Core.Logger);
        var entry = new TagCacheEntry { Type = "Movie", TmdbId = "42" };
        Assert.Equal(1, ratings.Get(entry, viewer).Count);
        Assert.Equal(1, ratings.Get(entry, viewer).Count);
        // The Dashboard's policy save on 10.11 (bracketed, no event): before, the chip kept counting for the 30 s TTL.
        await UserChange.PolicyPost(authorId, () => author = UserChange.Read(authorId, "author", u => u.SetPermission(PermissionKind.IsHidden, true)));
        Assert.Equal(0, ratings.Get(entry, viewer).Count);
    }
}

/// <summary>
/// The caches that hold a user (review authors, poster tags, Spoiler Guard's next episode, native details' revision):
/// a bracketed policy write with no host event, and JE's own writes, reach the next lookup. Lookups are counted, so
/// these run with the other tests that move Jellyfin user versions (a global bracket elsewhere would add a lookup).
/// </summary>
[Collection("Jellyfin user versions")]
public class UserChangeAuthorCacheTests
{
    [Fact]
    public async Task ABracketedPolicyWriteWithNoEventMissesTheReviewAuthorCache()
    {
        var id = Guid.NewGuid();
        var current = UserChange.Read(id, "author");
        var calls = 0;
        User? Lookup(Guid _) { calls++; return current; }
        Assert.False(ReviewAuthorCache.Resolve(id, Lookup)!.HasPermission(PermissionKind.IsHidden));
        Assert.False(ReviewAuthorCache.Resolve(id, Lookup)!.HasPermission(PermissionKind.IsHidden));
        Assert.Equal(1, calls);

        await UserChange.PolicyPost(id, () => current = UserChange.Read(id, "author", u => u.SetPermission(PermissionKind.IsHidden, true)));
        Assert.True(ReviewAuthorCache.Resolve(id, Lookup)!.HasPermission(PermissionKind.IsHidden));
        Assert.True(ReviewAuthorCache.Resolve(id, Lookup)!.HasPermission(PermissionKind.IsHidden));
        Assert.Equal(2, calls);
    }

    [Fact]
    public async Task JesOwnWriteAndALookupRacingABracketNeverLeaveTheOldAuthor()
    {
        var id = Guid.NewGuid();
        var current = UserChange.Read(id, "author");
        var calls = 0;
        User? Lookup(Guid _) { calls++; return current; }
        ReviewAuthorCache.Resolve(id, Lookup);

        // Maintenance mode's disable: JE's own write, inside the person's version bracket.
        await JellyfinUserVersions.Mutate(id, () => { current = UserChange.Read(id, "author", u => u.SetPermission(PermissionKind.IsDisabled, true)); return Task.CompletedTask; });
        Assert.True(ReviewAuthorCache.Resolve(id, Lookup)!.HasPermission(PermissionKind.IsDisabled));
        Assert.Equal(2, calls);

        // A lookup made while a write is in flight may have read the old user: it is not kept.
        await JellyfinUserVersions.Mutate(id, () =>
        {
            Assert.True(ReviewAuthorCache.Resolve(id, Lookup)!.HasPermission(PermissionKind.IsDisabled));
            current = UserChange.Read(id, "author");
            return Task.CompletedTask;
        });
        Assert.Equal(3, calls);
        Assert.False(ReviewAuthorCache.Resolve(id, Lookup)!.HasPermission(PermissionKind.IsDisabled));
        Assert.Equal(4, calls);

        // Control: another person's change leaves this author cached.
        await JellyfinUserVersions.Mutate(Guid.NewGuid(), () => Task.CompletedTask);
        ReviewAuthorCache.Resolve(id, Lookup);
        Assert.Equal(4, calls);
    }

    [Fact]
    public async Task PosterTagUsersFollowEventsBracketsAndJesOwnWrites()
    {
        var id = Guid.NewGuid();
        var current = UserChange.Read(id);
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(id)).Returns(() => current);
        var cache = new PosterTagUserCache(users.Object);
        Assert.Null(cache.Get(id)!.MaxParentalRatingScore);
        Assert.Null(cache.Get(id)!.MaxParentalRatingScore);
        users.Verify(u => u.GetUserById(id), Times.Once);

        // 12.2's policy save: an event (before: no invalidation at all, the 30 s TTL only).
        current = UserChange.Read(id, policy: UserChange.Changes["parental"]);
        await new JellyfinUserChangeVersion().OnEvent(new UserUpdatedEventArgs(current));
        Assert.Equal(10, cache.Get(id)!.MaxParentalRatingScore);
        users.Verify(u => u.GetUserById(id), Times.Exactly(2));

        // 10.11's: the bracket, no event.
        await UserChange.PolicyPost(id, () => current = UserChange.Read(id));
        Assert.Null(cache.Get(id)!.MaxParentalRatingScore);
        users.Verify(u => u.GetUserById(id), Times.Exactly(3));

        // JE's own write (maintenance mode).
        await JellyfinUserVersions.Mutate(id, () => { current = UserChange.Read(id, policy: u => u.SetPermission(PermissionKind.IsDisabled, true)); return Task.CompletedTask; });
        Assert.True(cache.Get(id)!.HasPermission(PermissionKind.IsDisabled));
        Assert.True(cache.Get(id)!.HasPermission(PermissionKind.IsDisabled));
        users.Verify(u => u.GetUserById(id), Times.Exactly(4));
    }

    [Fact]
    public async Task SpoilerGuardsNextEpisodeIsRecomputedAfterTheViewersPolicyChanges()
    {
        using var core = new CoreFixture();
        var user = Guid.NewGuid();
        var series = Guid.NewGuid();
        using var next = new SpoilerNextUnwatchedService(
            Mock.Of<ILibraryManager>(), Mock.Of<IUserManager>(), Mock.Of<IUserDataManager>(), core.Logger);
        var computed = 0;
        next.BoundaryComputerForTest = (_, _) => { computed++; return null; };
        next.GetBoundary(user, series);
        next.GetBoundary(user, series);
        Assert.Equal(1, computed);
        await UserChange.PolicyPost(user, () => { });
        next.GetBoundary(user, series);
        Assert.Equal(2, computed);
        await JellyfinUserVersions.Mutate(Guid.NewGuid(), () => Task.CompletedTask);
        next.GetBoundary(user, series);
        Assert.Equal(2, computed);
    }

#if !NET9_0
    [Fact]
    public void NativeDetailsRevisionFollowsTheViewerAsJustRead()
    {
        var policy = new Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails.NativeDetailsPolicy(null!, null!, null!);
        var id = Guid.NewGuid();
        var before = policy.Revision(UserChange.Read(id));
        Assert.Equal(before, policy.Revision(UserChange.Read(id)));
        // Artwork grants carry the revision: a parental limit set a moment ago ends them now, not 5 s later.
        var limited = policy.Revision(UserChange.Read(id, policy: UserChange.Changes["parental"]));
        Assert.NotEqual(before, limited);
        Assert.NotEqual(limited, policy.Revision(UserChange.Read(id, policy: u => u.SetPermission(PermissionKind.IsDisabled, true))));
        Assert.Equal(before, policy.Revision(UserChange.Read(id)));
    }
#endif

    /// <summary>
    /// The known limit, stated by test (docs/arr/arr-features.md "Known limits of the user-change check"): the user
    /// version moves for a write inside JE's bracket with no host event, and does NOT move for a silent write outside
    /// any bracket (another plugin calling UpdateUserAsync, or UpdatePolicyAsync on 10.11).
    /// </summary>
    [Fact]
    public async Task TheBracketMovesTheUserVersionWithNoHostEventAndASilentWriteOutsideItDoesNot()
    {
        var person = Guid.NewGuid();
        var store = new Mock<IUserManager>(MockBehavior.Strict);
        // A host save that publishes nothing (10.11's UpdatePolicyAsync; UpdateUserAsync on both).
        store.Setup(u => u.UpdatePolicyAsync(person, It.IsAny<MediaBrowser.Model.Users.UserPolicy>())).Returns(Task.CompletedTask);

        var before = JellyfinUserVersions.Sample(person);
        await UserChange.PolicyPost(person, () => store.Object.UpdatePolicyAsync(person, new MediaBrowser.Model.Users.UserPolicy()).GetAwaiter().GetResult());
        var bracketed = JellyfinUserVersions.Sample(person);
        Assert.True(FactVersion.Settled(bracketed));
        Assert.NotEqual(before, bracketed);

        await store.Object.UpdatePolicyAsync(person, new MediaBrowser.Model.Users.UserPolicy());
        Assert.Equal(bracketed, JellyfinUserVersions.Sample(person));
        store.Verify(u => u.UpdatePolicyAsync(person, It.IsAny<MediaBrowser.Model.Users.UserPolicy>()), Times.Exactly(2));
    }
}
