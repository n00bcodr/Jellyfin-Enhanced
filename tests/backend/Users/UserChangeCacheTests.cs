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
        user.SetPermission(PermissionKind.EnableAllChannels, true);
        user.SetPermission(PermissionKind.EnableLiveTvAccess, true);
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
        // Round 1 review: what the first fingerprint left out.
        ["allChannels"] = u => { u.SetPermission(PermissionKind.EnableAllChannels, false); u.SetPreference(PreferenceKind.EnabledChannels, []); },
        ["enabledChannels"] = u => u.SetPreference(PreferenceKind.EnabledChannels, [Guid.NewGuid().ToString("N")]),
        ["blockedChannels"] = u => u.SetPreference(PreferenceKind.BlockedChannels, [Guid.NewGuid().ToString("N")]),
        ["liveTv"] = u => u.SetPermission(PermissionKind.EnableLiveTvAccess, false),
        ["schedule"] = u => u.AccessSchedules.Add(new AccessSchedule(DynamicDayOfWeek.Monday, 8, 20, u.Id)),
    };

    /// <summary>Whether the user may open every channel (what the library stand-in shows channel items by).</summary>
    public static bool ChannelsOpen(User u)
        => u.HasPermission(PermissionKind.EnableAllChannels) && (u.GetPreference(PreferenceKind.BlockedChannels)?.Length ?? 0) == 0;

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

    /// <summary>The same POST, still running until <paramref name="saved"/> completes (the save in flight).</summary>
    public static Task PolicyPostUntil(Guid person, Task saved)
    {
        var context = JellyfinUserBracketHarness.Context<UserController>("UpdateUserPolicy", new Dictionary<string, object?> { ["userId"] = person });
        return JellyfinUserBracketHarness.New().OnActionExecutionAsync(context, async () =>
        {
            await saved;
            return await JellyfinUserBracketHarness.Done(context);
        });
    }

    /// <summary>
    /// Someone signing in by name (Jellyfin's AuthenticateUserByName), as MVC runs it: JE's attribution filter around
    /// JE's bracket, which holds every person's version until it returns (the person isn't known before it runs), here
    /// when <paramref name="done"/> completes. Its answer names <paramref name="person"/> (a successful sign-in's user);
    /// with none, the answer can't tell whom it was about.
    /// </summary>
    public static Task SignInByName(Task done, Guid? person = null, IUserManager? users = null)
    {
        var context = JellyfinUserBracketHarness.Context<UserController>("AuthenticateUserByName", new Dictionary<string, object?> { ["request"] = new object() });
        return Action(context, () => done, person == null ? null : new MediaBrowser.Controller.Authentication.AuthenticationResult { User = new MediaBrowser.Model.Dto.UserDto { Id = person.Value } }, users);
    }

    /// <summary>An action through both filters, as MVC nests them: <paramref name="during"/> is the action, its answer <paramref name="answer"/>.</summary>
    public static Task Action(Microsoft.AspNetCore.Mvc.Filters.ActionExecutingContext context, Func<Task> during, object? answer, IUserManager? users = null, Exception? thrown = null)
        => new UserChangeAttribution(users ?? Mock.Of<IUserManager>()).OnActionExecutionAsync(context, async () =>
        {
            Microsoft.AspNetCore.Mvc.Filters.ActionExecutedContext? executed = null;
            await JellyfinUserBracketHarness.New().OnActionExecutionAsync(context, async () =>
            {
                await during();
                return executed = new Microsoft.AspNetCore.Mvc.Filters.ActionExecutedContext(context, new List<Microsoft.AspNetCore.Mvc.Filters.IFilterMetadata>(), new object())
                {
                    Result = answer == null ? new NoContentResult() : new ObjectResult(answer),
                    Exception = thrown,
                };
            });
            return executed!;
        });

    /// <summary>A new HTTP request as the server sees it (HttpContextAccessor's current context); null ends it.</summary>
    public static void Request(HttpContext? http) => new HttpContextAccessor().HttpContext = http;
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
        public readonly System.Collections.Concurrent.ConcurrentDictionary<Guid, int> Reads = new();
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
            users.Setup(x => x.GetUserById(It.IsAny<Guid>())).Returns((Guid id) =>
            {
                Reads.AddOrUpdate(id, 1, (_, n) => n + 1);
                return Current.TryGetValue(id, out var u) ? Clone(u) : null;
            });
            var library = new Mock<ILibraryManager>();
            library.Setup(x => x.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
            {
                if (q.IsPlayed == true || q.User == null) return [];
                Interlocked.Increment(ref AccessQueries);
                // Second is a channel's item: gone with a parental limit or without channel access.
                return UserChange.Restricted(q.User) || !UserChange.ChannelsOpen(q.User) ? [First] : [First, Second];
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
            copy.SubtitleMode = u.SubtitleMode;
            foreach (var kind in Enum.GetValues<PermissionKind>()) copy.SetPermission(kind, u.HasPermission(kind));
            foreach (var kind in Enum.GetValues<PreferenceKind>()) copy.SetPreference(kind, u.GetPreference(kind) ?? []);
            foreach (var schedule in u.AccessSchedules) copy.AccessSchedules.Add(new AccessSchedule(schedule.DayOfWeek, schedule.StartHour, schedule.EndHour, u.Id));
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

    /// <summary>
    /// Round 1 review (SEC-R1-1): the fingerprint left out channel access, so a channel revoked by the Dashboard's
    /// policy save on 10.11 (bracketed, no event) kept the old access set, the channel's item and the old filter
    /// revision for up to 60 s. Also with no bracket at all (another plugin's save): the user as just read decides.
    /// </summary>
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AChannelRevokedWithNoEventLeavesTheTagCacheOnTheNextRequest(bool bracketed)
    {
        using var endpoint = new Endpoint();
        var before = await endpoint.TagCache(endpoint.AliceId);
        Assert.Contains("Second secret", before);
        Assert.Contains("Second secret", await endpoint.TagCache(endpoint.AliceId));
        Assert.Equal(1, endpoint.AccessQueries);

        void Revoke() => endpoint.Current[endpoint.AliceId] = UserChange.Read(endpoint.AliceId, policy: UserChange.Changes["allChannels"]);
        if (bracketed) await UserChange.PolicyPost(endpoint.AliceId, Revoke);
        else Revoke();
        var after = await endpoint.TagCache(endpoint.AliceId);
        Assert.Contains("First secret", after);
        Assert.DoesNotContain("Second secret", after);
        Assert.NotEqual(FilterRevision(before), FilterRevision(after));
        Assert.Equal(FilterRevision(after), FilterRevision(await endpoint.TagCache(endpoint.AliceId, since: 200)));
        Assert.Equal(2, endpoint.AccessQueries);
    }

    /// <summary>
    /// The access set is keyed by the fingerprint AND the person's own version: a bracketed save of them recomputes it
    /// once even when it changed nothing the fingerprint reads; someone else's sign-in (in flight or done) doesn't.
    /// </summary>
    [Fact]
    public async Task TheAccessSetFollowsThePersonsVersionButNotSomeoneElsesSignIn()
    {
        using var endpoint = new Endpoint();
        await endpoint.TagCache(endpoint.AliceId);
        Assert.Equal(1, endpoint.AccessQueries);
        await UserChange.PolicyPost(endpoint.AliceId, () => endpoint.Current[endpoint.AliceId] = UserChange.Read(endpoint.AliceId, policy: u => u.SubtitleMode = SubtitlePlaybackMode.Always));
        await endpoint.TagCache(endpoint.AliceId);
        await endpoint.TagCache(endpoint.AliceId);
        Assert.Equal(2, endpoint.AccessQueries);

        var done = new TaskCompletionSource();
        var signIn = UserChange.SignInByName(done.Task);
        await endpoint.TagCache(endpoint.AliceId);
        done.SetResult();
        await signIn;
        await endpoint.TagCache(endpoint.AliceId);
        Assert.Equal(2, endpoint.AccessQueries);
    }

    /// <summary>
    /// Control: one request reads each review author once, however many of their reviews it counts, even while the
    /// author's own save is in flight (no cached entry may be served then): before, one database read per review.
    /// </summary>
    [Fact]
    public async Task ARequestReadsEachReviewAuthorOnce()
    {
        using var endpoint = new Endpoint();
        endpoint.Fixture.Plugin.Configuration.ShowUserReviews = true;
        var keys = new List<string>();
        for (var i = 1; i <= 20; i++)
        {
            endpoint.Fixture.Core.Manager.UpsertReview(endpoint.BobId.ToString("N"), "movie", i.ToString(System.Globalization.CultureInfo.InvariantCulture), "Fine", 4, "2026-10-20T00:00:00Z");
            keys.Add("movie:" + i.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }

        var saved = new TaskCompletionSource();
        var save = UserChange.PolicyPostUntil(endpoint.BobId, saved.Task);
        try
        {
            endpoint.SignIn(endpoint.AliceId);
            UserChange.Request(endpoint.Controller.HttpContext);
            endpoint.Reads.Clear();
            var ok = Assert.IsType<OkObjectResult>(endpoint.Controller.GetReviewRatings(string.Join(',', keys)));
            Assert.Contains("\"count\":1", JsonSerializer.Serialize(ok.Value));
            Assert.Equal(1, endpoint.Reads.GetValueOrDefault(endpoint.BobId));

            // The next request reads again: a read is never handed to another request.
            endpoint.SignIn(endpoint.AliceId);
            UserChange.Request(endpoint.Controller.HttpContext);
            endpoint.Controller.GetReviewRatings(string.Join(',', keys));
            Assert.Equal(2, endpoint.Reads.GetValueOrDefault(endpoint.BobId));
        }
        finally
        {
            UserChange.Request(null);
            saved.SetResult();
            await save;
        }
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
    /// Round 1 review (B1): while someone signs in by name, JE's bracket holds every person's version (the person isn't
    /// known before it runs). That is someone's sign-in, not a change to everyone: cached users stay served while it runs
    /// (before: every get read the user again, 100 warm gets → 100 reads) and after it, when its answer names the person
    /// it was about. That person is read again (a sign-in can change them: an authentication plugin's sync); when the
    /// answer can't tell, every cached user is read once more, then served again.
    /// </summary>
    [Fact]
    public async Task SomeoneSigningInDoesNotMakeEveryCachedUserReadAgain()
    {
        var author = Guid.NewGuid();
        var viewer = Guid.NewGuid();
        var other = Guid.NewGuid();
        var authorReads = 0;
        User? Lookup(Guid id) { authorReads++; return UserChange.Read(id, "author"); }
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(It.IsAny<Guid>())).Returns((Guid id) => UserChange.Read(id));
        var posters = new PosterTagUserCache(users.Object);
        void Warm(int times)
        {
            for (var i = 0; i < times; i++)
            {
                Assert.NotNull(ReviewAuthorCache.Resolve(author, Lookup));
                Assert.NotNull(posters.Get(author));
                Assert.NotNull(posters.Get(viewer));
            }
        }

        Warm(1);
        var done = new TaskCompletionSource();
        var signIn = UserChange.SignInByName(done.Task, other);
        Assert.False(FactVersion.Settled(JellyfinUserVersions.Sample(author)));
        Warm(100);
        Assert.Equal(1, authorReads);
        users.Verify(u => u.GetUserById(author), Times.Once);
        users.Verify(u => u.GetUserById(viewer), Times.Once);

        done.SetResult();
        await signIn;
        Warm(100);
        Assert.Equal(1, authorReads);
        users.Verify(u => u.GetUserById(author), Times.Once);
        users.Verify(u => u.GetUserById(viewer), Times.Once);

        // The author signs in: their entries are read again (once), the viewer's aren't.
        await UserChange.SignInByName(Task.CompletedTask, author);
        Warm(100);
        Assert.Equal(2, authorReads);
        users.Verify(u => u.GetUserById(author), Times.Exactly(2));
        users.Verify(u => u.GetUserById(viewer), Times.Once);

        // A change whose person can't be told: every cached user is read once more.
        await UserChange.SignInByName(Task.CompletedTask);
        Warm(100);
        Assert.Equal(3, authorReads);
        users.Verify(u => u.GetUserById(author), Times.Exactly(3));
        users.Verify(u => u.GetUserById(viewer), Times.Exactly(2));
    }

    /// <summary>
    /// A failed sign-in by name (Jellyfin throws) touched only the user of that name: only they are read again; a name
    /// nobody has touched nobody.
    /// </summary>
    [Fact]
    public async Task AFailedSignInIsAboutTheUserOfThatName()
    {
        var author = Guid.NewGuid();
        var viewer = Guid.NewGuid();
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(It.IsAny<Guid>())).Returns((Guid id) => UserChange.Read(id));
        users.Setup(u => u.GetUserByName("author")).Returns(() => UserChange.Read(author, "author"));
        var posters = new PosterTagUserCache(users.Object);
        posters.Get(author);
        posters.Get(viewer);
        async Task Fail(string name)
        {
            var context = JellyfinUserBracketHarness.Context<UserController>("AuthenticateUserByName", new Dictionary<string, object?> { ["request"] = new { Username = name, Pw = "wrong" } });
            await UserChange.Action(context, () => Task.CompletedTask, null, users.Object, new System.Security.Authentication.AuthenticationException("Invalid username or password entered."));
        }

        await Fail("nobody");
        posters.Get(author);
        posters.Get(viewer);
        users.Verify(u => u.GetUserById(author), Times.Once);
        await Fail("author");
        posters.Get(author);
        posters.Get(viewer);
        users.Verify(u => u.GetUserById(author), Times.Exactly(2));
        users.Verify(u => u.GetUserById(viewer), Times.Once);
    }

    /// <summary>The attribution filter covers exactly the actions JE's bracket holds for every person.</summary>
    [Theory]
    [InlineData("AuthenticateUserByName", true, false)]
    [InlineData("AuthenticateWithQuickConnect", true, false)]
    [InlineData("CreateUserByName", true, false)]
    [InlineData("UpdateUserPolicy", false, true)]
    [InlineData("UpdateUserConfiguration", false, true)]
    [InlineData("GetUsers", false, false)]
    public async Task TheAttributionCoversTheActionsBracketedForEveryone(string action, bool everyone, bool signedIn)
    {
        var person = Guid.NewGuid();
        var other = Guid.NewGuid();
        var args = new Dictionary<string, object?>();
        if (action == "UpdateUserPolicy") args["userId"] = person;
        var context = JellyfinUserBracketHarness.Context<UserController>(action, args, signedIn ? person : null);
        var seenEveryone = false;
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(other)).Returns(() => UserChange.Read(other, "other"));
        var posters = new PosterTagUserCache(users.Object);
        posters.Get(other);
        var before = UserAuthority.Take(other);
        await UserChange.Action(context, () => { seenEveryone = !FactVersion.Settled(JellyfinUserVersions.Sample(other)); return Task.CompletedTask; }, null);
        Assert.Equal(everyone, seenEveryone);
        // Bracketed for everyone, with no person in its answer: every cached user is read again; otherwise nobody else is.
        Assert.Equal(!everyone, UserAuthority.Unchanged(other, before));
    }

    /// <summary>
    /// While the person's OWN change is in flight nothing cached for them may be served, so every get would read them:
    /// reads are coalesced within one request (a page of posters → one read), and never handed to another request.
    /// </summary>
    [Fact]
    public async Task ReadsWithinOneRequestAreCoalescedAndNeverHandedToAnother()
    {
        var author = Guid.NewGuid();
        var authorReads = 0;
        User? Lookup(Guid id) { Interlocked.Increment(ref authorReads); return UserChange.Read(id, "author"); }
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(author)).Returns(() => UserChange.Read(author, "author"));
        var posters = new PosterTagUserCache(users.Object);
        var saved = new TaskCompletionSource();
        var save = UserChange.PolicyPostUntil(author, saved.Task);
        try
        {
            UserChange.Request(new DefaultHttpContext());
            for (var i = 0; i < 100; i++)
            {
                Assert.NotNull(ReviewAuthorCache.Resolve(author, Lookup));
                Assert.NotNull(posters.Get(author));
            }

            // One read for the request, whichever cache asked first (both are Jellyfin's GetUserById in the server).
            int Reads() => authorReads + users.Invocations.Count(i => i.Method.Name == nameof(IUserManager.GetUserById));
            Assert.Equal(1, Reads());

            UserChange.Request(new DefaultHttpContext());
            ReviewAuthorCache.Resolve(author, Lookup);
            posters.Get(author);
            Assert.Equal(2, Reads());
        }
        finally
        {
            UserChange.Request(null);
            saved.SetResult();
            await save;
        }
    }

    /// <summary>
    /// A read still in flight is never handed to a later request: the request after the Dashboard's save reads the new
    /// author itself, and the old read, stored when it finishes, isn't served afterwards (its stamp predates the save).
    /// </summary>
    [Fact]
    public async Task AReadInFlightIsNeverHandedToALaterRequest()
    {
        var author = Guid.NewGuid();
        var current = UserChange.Read(author, "author");
        var reads = 0;
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        User? Lookup(Guid _)
        {
            var seen = current;
            if (Interlocked.Increment(ref reads) == 1)
            {
                entered.Set();
                release.Wait(TimeSpan.FromSeconds(10));
            }

            return seen;
        }

        var first = Task.Run(() =>
        {
            UserChange.Request(new DefaultHttpContext());
            return ReviewAuthorCache.Resolve(author, Lookup);
        });
        Assert.True(entered.Wait(TimeSpan.FromSeconds(10)));
        await UserChange.PolicyPost(author, () => current = UserChange.Read(author, "author", u => u.SetPermission(PermissionKind.IsHidden, true)));
        try
        {
            UserChange.Request(new DefaultHttpContext());
            Assert.True(ReviewAuthorCache.Resolve(author, Lookup)!.HasPermission(PermissionKind.IsHidden));
            Assert.Equal(2, reads);
            release.Set();
            Assert.False((await first)!.HasPermission(PermissionKind.IsHidden));
            UserChange.Request(new DefaultHttpContext());
            Assert.True(ReviewAuthorCache.Resolve(author, Lookup)!.HasPermission(PermissionKind.IsHidden));
        }
        finally
        {
            release.Set();
            UserChange.Request(null);
        }
    }

    /// <summary>Round 1 review (SEC-R1-1): what the first fingerprint left out moves it now.</summary>
    [Theory]
    [InlineData("allChannels")]
    [InlineData("enabledChannels")]
    [InlineData("blockedChannels")]
    [InlineData("liveTv")]
    [InlineData("schedule")]
    public void TheFingerprintCoversChannelsLiveTvAndSchedules(string change)
    {
        var user = UserChange.Read(Guid.NewGuid());
        var before = UserAuthority.Fingerprint(user);
        Assert.Equal(before, UserAuthority.Fingerprint(UserChange.Read(user.Id)));
        UserChange.Changes[change](user);
        Assert.NotEqual(before, UserAuthority.Fingerprint(user));
    }

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

/// <summary>
/// Round 1 review (B2): Spoiler Guard's next-episode boundary follows the viewer's access. With a parental limit hiding
/// S1E1, the boundary is S2E1, whose title advanced mode reveals; after a SILENT widening (no event, no bracket: the
/// limit lifted by other code) S1E1 is next, and S2E1 must be stripped on the very next request (before: the stale
/// boundary kept revealing S2E1's title for up to 5 minutes).
/// </summary>
[Collection("Plugin singleton")]
public class UserChangeSpoilerBoundaryTests
{
    [Fact]
    public async Task ASilentWideningMovesTheBoundaryBeforeTheNextReveal()
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.SpoilerBlurEnabled = true;
        plugin.Plugin.Configuration.SpoilerAdvancedMode = true;
        plugin.Plugin.Configuration.SpoilerReplaceTitle = true;
        var viewer = Guid.NewGuid();
        var series = Guid.NewGuid();
        var s1e1 = new MediaBrowser.Controller.Entities.TV.Episode { Id = Guid.NewGuid(), ParentIndexNumber = 1, IndexNumber = 1, SeriesId = series };
        var s2e1 = new MediaBrowser.Controller.Entities.TV.Episode { Id = Guid.NewGuid(), ParentIndexNumber = 2, IndexNumber = 1, SeriesId = series };
        var current = UserChange.Read(viewer, "viewer", u => u.MaxParentalRatingScore = 10);
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(viewer)).Returns(() => current);
        var library = new Mock<ILibraryManager>();
        // S1E1 is rated above the viewer's limit: their query starts at S2E1.
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
            q.User?.MaxParentalRatingScore != null ? new BaseItem[] { s2e1 } : new BaseItem[] { s1e1 });
        var data = Mock.Of<IUserDataManager>();
        using var next = new SpoilerNextUnwatchedService(library.Object, users.Object, data, plugin.Core.Logger);
        var identities = new RequestIdentityService(Mock.Of<MediaBrowser.Controller.Session.ISessionManager>(), users.Object,
            new SpoilerIdentityService(users.Object, plugin.Core.Logger), plugin.Core.Logger);
        var resolver = new SpoilerUserResolver(plugin.Core.Manager, library.Object, plugin.Core.Logger, identities);
        var filter = new SpoilerFieldStripFilter(resolver, library.Object, users.Object, data, next);
        var state = new Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserSpoilerBlur();
        state.Series[series.ToString("N")] = new();
        plugin.Core.Manager.SaveUserConfiguration(viewer.ToString("N"), "spoilerblur.json", state);
        try
        {
            async Task<string> Title()
            {
                var dto = new MediaBrowser.Model.Dto.BaseItemDto
                {
                    Id = s2e1.Id, SeriesId = series, Type = BaseItemKind.Episode, Name = "Secret S2E1", Overview = "Secret plot",
                    ParentIndexNumber = 2, IndexNumber = 1, UserData = new MediaBrowser.Model.Dto.UserItemDataDto { Key = "k", Played = false },
                };
                var http = new DefaultHttpContext { User = new System.Security.Claims.ClaimsPrincipal(new System.Security.Claims.ClaimsIdentity([new System.Security.Claims.Claim("Jellyfin-UserId", viewer.ToString())], "Test")) };
                var descriptor = new ActionDescriptor { RouteValues = new Dictionary<string, string?> { ["controller"] = "Items", ["action"] = "GetItems" } };
                var context = new ActionContext(http, new RouteData(), descriptor, new Microsoft.AspNetCore.Mvc.ModelBinding.ModelStateDictionary());
                var result = new ObjectResult(dto);
                await filter.OnActionExecutionAsync(new Microsoft.AspNetCore.Mvc.Filters.ActionExecutingContext(context, [], new Dictionary<string, object?>(), this),
                    () => Task.FromResult(new Microsoft.AspNetCore.Mvc.Filters.ActionExecutedContext(context, [], this) { Result = result }));
                return dto.Name!;
            }

            Assert.Equal("Secret S2E1", await Title());
            Assert.Equal("Secret S2E1", await Title());
            current = UserChange.Read(viewer, "viewer");
            Assert.Equal("Season 2, Episode 1", await Title());
        }
        finally
        {
            SpoilerUserResolver.InvalidateUser(viewer.ToString("N"));
        }
    }

    [Fact]
    public void AnEpisodeAddedOrRenumberedMovesTheBoundary()
    {
        using var core = new CoreFixture();
        var viewer = Guid.NewGuid();
        var series = Guid.NewGuid();
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(viewer)).Returns(() => UserChange.Read(viewer));
        var library = new Mock<ILibraryManager>();
        using var next = new SpoilerNextUnwatchedService(library.Object, users.Object, Mock.Of<IUserDataManager>(), core.Logger);
        var computed = 0;
        next.BoundaryComputerForTest = (_, _) => { computed++; return null; };
        next.GetBoundary(viewer, series);
        next.GetBoundary(viewer, series);
        Assert.Equal(1, computed);
        var episode = new MediaBrowser.Controller.Entities.TV.Episode { Id = Guid.NewGuid(), SeriesId = series, ParentIndexNumber = 1, IndexNumber = 1 };
        library.Raise(l => l.ItemAdded += null, library.Object, new ItemChangeEventArgs { Item = episode });
        next.GetBoundary(viewer, series);
        Assert.Equal(2, computed);
        library.Raise(l => l.ItemUpdated += null, library.Object, new ItemChangeEventArgs { Item = episode });
        next.GetBoundary(viewer, series);
        Assert.Equal(3, computed);
        // Another series' change leaves this one cached.
        library.Raise(l => l.ItemRemoved += null, library.Object, new ItemChangeEventArgs { Item = new MediaBrowser.Controller.Entities.TV.Episode { SeriesId = Guid.NewGuid() } });
        next.GetBoundary(viewer, series);
        Assert.Equal(3, computed);
    }
}
