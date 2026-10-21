using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Globalization;
using Microsoft.AspNetCore.Http;
using Microsoft.CodeAnalysis.CSharp;
using Moq;

namespace JE.Tests;

/// <summary>
/// Review round 4 (COREUC-R4-2, -3): one read of a person is one stamp, their version AND the instant they were read on
/// the monotonic clock, and every value computed from the read lives from that instant, never past the deadline of a
/// cache it came through. Driven through each held read's production path: request coalescing (ReadOncePerRequest), the
/// held caches (GetHeldStamped) and the 4K memo behind IStampLibraryAccess.
/// </summary>
[Collection("Jellyfin user versions")]
public class UserCacheReadInstantTests
{
    private static readonly long Second = TimeSpan.FromSeconds(1).Ticks;

    private static User Read(Guid id, bool allFolders) => UserChange.Read(id, policy: u => u.SetPermission(PermissionKind.EnableAllFolders, allFolders));

    [Fact]
    public void TheFourKBadgeEndsWithinItsLifeOfTheReadNotOfItsFirstUse()
    {
        var now = 0L;
        using var clock = MonotonicClock.Use(() => now);
        var (viewer, copy) = (Guid.NewGuid(), Guid.NewGuid());
        var current = Read(viewer, allFolders: true);
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(viewer)).Returns(() => current);
        var posterUsers = new PosterTagUserCache(users.Object);
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById<BaseItem>(copy, It.IsAny<User>()))
            .Returns((Guid _, User u) => u.HasPermission(PermissionKind.EnableAllFolders) ? new Movie { Id = copy } : null);
        using var stamps = new JellyfinStampLibrary(library.Object, Mock.Of<IUserDataManager>(), posterUsers);
        using var resolver = new AcquisitionStampResolver(stamps, null!, () => null, () => DateTimeOffset.UtcNow);
        var check = typeof(AcquisitionStampResolver).GetMethod("CanOpen", BindingFlags.Instance | BindingFlags.NonPublic, [typeof(Guid), typeof(Guid)])!;
        bool CanOpen() => (bool)check.Invoke(resolver, [viewer, copy])!;
        try
        {
            // A poster load reads the viewer at 0 s (the user cache keeps them for 30 s) ...
            UserChange.Request(new DefaultHttpContext());
            Assert.NotNull(posterUsers.Get(viewer));
            // ... their 4K library is taken away silently (straight into Jellyfin's database: no event, no bracket) ...
            now = Second;
            current = Read(viewer, allFolders: false);
            // ... and the first 4K check comes near the end of that read's life: it answers from the read (as designed).
            now = 29 * Second;
            UserChange.Request(new DefaultHttpContext());
            Assert.True(CanOpen());
            // 30 s after the READ the badge is gone (before: the memo lived 30 s from its first use, until 59 s).
            now = 30 * Second + Second / 2;
            UserChange.Request(new DefaultHttpContext());
            Assert.False(CanOpen());
        }
        finally
        {
            UserChange.Request(null);
        }
    }

    [Fact]
    public void AReadCoalescedIntoALaterUseStillLivesFromTheRead()
    {
        var now = 0L;
        using var clock = MonotonicClock.Use(() => now);
        var id = Guid.NewGuid();
        var current = Read(id, allFolders: true);
        var reads = 0;
        User Lookup(Guid _) { reads++; return current; }
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(id)).Returns(() => Lookup(id));
        var posterUsers = new PosterTagUserCache(users.Object);
        try
        {
            // A request reads the person at 0 s; later in the same request each held cache first asks for them and gets
            // that read (request coalescing).
            UserChange.Request(new DefaultHttpContext());
            Assert.NotNull(UserAuthority.ReadOncePerRequest(id, Lookup).User);
            now = 14 * Second;
            Assert.True(ReviewAuthorCache.Resolve(id, Lookup)!.HasPermission(PermissionKind.EnableAllFolders));
            now = 29 * Second;
            Assert.True(posterUsers.Get(id)!.HasPermission(PermissionKind.EnableAllFolders));
            Assert.Equal(1, reads);
            // A silent change (no event, no bracket).
            current = Read(id, allFolders: false);

            // Review authors keep a read 15 s: 16 s after the read it is read again (before: 15 s from the coalesced use).
            now = 16 * Second;
            UserChange.Request(new DefaultHttpContext());
            Assert.False(ReviewAuthorCache.Resolve(id, Lookup)!.HasPermission(PermissionKind.EnableAllFolders));
            // Poster users keep a read 30 s: 31 s after the request's first read it is read again (before: until 59 s).
            now = 31 * Second;
            UserChange.Request(new DefaultHttpContext());
            Assert.False(posterUsers.Get(id)!.HasPermission(PermissionKind.EnableAllFolders));
        }
        finally
        {
            UserChange.Request(null);
        }
    }

    [Fact]
    public void AStampHandedOnCarriesItsReadAndTheHoldingEntrysDeadline()
    {
        var now = 0L;
        using var clock = MonotonicClock.Use(() => now);
        var id = Guid.NewGuid();
        var user = UserChange.Read(id);
        var held = new UserAccessCache<Guid, User?>(TimeSpan.FromSeconds(15), 16);
        var (_, first) = held.GetHeldStamped(id, id, () => UserAuthority.ReadOncePerRequest(id, _ => user));
        Assert.Equal(0, first.ReadAt);
        Assert.Equal(15 * Second, first.Until);
        now = 10 * Second;
        var (_, hit) = held.GetHeldStamped(id, id, () => throw new InvalidOperationException("served from the entry"));
        Assert.Equal(0, hit.ReadAt);
        Assert.Equal(15 * Second, hit.Until);
        // A downstream cache with a longer life (30 s) still ends with the entry it came through.
        var downstream = new UserAccessCache<Guid, bool>(TimeSpan.FromSeconds(30), 16);
        downstream.GetHeld(id, id, () => (true, hit));
        now = 15 * Second;
        var recomputed = 0;
        downstream.GetHeld(id, id, () => { recomputed++; return (false, UserAuthority.ReadOncePerRequest(id, _ => user).Stamp); });
        Assert.Equal(1, recomputed);
    }
}

/// <summary>Review round 4 (COREUC-R4-3): every cache lifetime is counted on the monotonic clock, never the wall clock.</summary>
public class UserCacheClockTests
{
    [Fact]
    public void TheLifetimeClockIsMonotonicNotTheWallClock() => Monotonic(new UserAccessCache<Guid, int>(TimeSpan.FromSeconds(30), 4));

    [Fact]
    public void TheWrittenStateClockIsMonotonicToo() => Monotonic(new WrittenStateCache<Guid, int>(TimeSpan.FromSeconds(30), 4));

    private static void Monotonic(object made)
    {
        {
            var field = made.GetType().GetField("_ticks", BindingFlags.Instance | BindingFlags.NonPublic);
            Assert.NotNull(field);
            var ticks = ((Func<long>)field.GetValue(made)!)();
            // Setting the wall clock back 60 s and forward 40 s would move a wall-clock lifetime; a monotonic one can't be
            // set at all: it is the time since the host started, never today's date.
            Assert.True(Math.Abs(ticks - DateTime.UtcNow.Ticks) > TimeSpan.FromDays(365).Ticks, made.GetType().Name + " counts lifetimes on the wall clock");
            Assert.InRange(ticks - Stopwatch.GetElapsedTime(0).Ticks, -TimeSpan.FromSeconds(5).Ticks, TimeSpan.FromSeconds(5).Ticks);
        }
    }

    [Fact]
    public void TheTicketHelpersNeverReadTheWallClock()
    {
        var root = Path.Combine(IntegrationAutoRequestLedgerTests.Root(), "Jellyfin.Plugin.JellyfinEnhanced", "Helpers");
        foreach (var file in new[] { "UserAccessCache.cs", "InvalidationLedger.cs", "WrittenStateCache.cs" })
        {
            var path = Path.Combine(root, file);
            if (!File.Exists(path)) continue;
            var code = string.Join('\n', File.ReadAllLines(path).Where(l => !l.TrimStart().StartsWith("//", StringComparison.Ordinal)));
            foreach (var wall in new[] { "DateTime.", "DateTimeOffset.", "Environment.TickCount" })
                Assert.False(code.Contains(wall, StringComparison.Ordinal), file + " reads " + wall);
        }
    }
}

/// <summary>
/// Review round 4 (COREUC-R4-5): state JE writes itself (a person's Spoiler Guard and Hidden Content files, the server's
/// single-user answer) is on the ticket protocol: a read from before a write's invalidation is never kept.
/// </summary>
[Collection("Plugin singleton")]
public class UserCacheWrittenStateTests
{
    [Fact]
    public void ASpoilerGuardOptInDuringAnInFlightStateReadProtectsAtOnce()
    {
        using var core = new CoreFixture();
        var (user, movie) = (Guid.NewGuid(), Guid.NewGuid());
        var idN = user.ToString("N");
        core.Manager.SaveUserConfiguration(idN, SpoilerBlurImageFilter.SpoilerBlurFileName, new UserSpoilerBlur());
        var resolver = new SpoilerUserResolver(core.Manager, Mock.Of<ILibraryManager>(), core.Logger, null!);
        var raced = false;
        core.Manager.AfterRead = (who, file) =>
        {
            if (raced || file != SpoilerBlurImageFilter.SpoilerBlurFileName || !string.Equals(who, idN, StringComparison.OrdinalIgnoreCase)) return;
            raced = true;
            // The person opts the movie in while a request holds the (empty) state it just read: the write path saves,
            // then invalidates.
            var state = new UserSpoilerBlur();
            state.Movies[movie.ToString("N")] = new SpoilerBlurMovieEntry { MovieId = movie.ToString("N"), MovieName = "Opted in" };
            core.Manager.SaveUserConfiguration(idN, SpoilerBlurImageFilter.SpoilerBlurFileName, state);
            SpoilerUserResolver.InvalidateUser(idN);
        };
        try
        {
            // That request answers from its own read ...
            Assert.False(resolver.IsMovieInSpoilerScope(resolver.LoadUserState(new DefaultHttpContext(), user), movie));
            Assert.True(raced);
            // ... the next one is protected at once (before: the old empty state, put back after the invalidation, for 30 s).
            Assert.True(resolver.IsMovieInSpoilerScope(resolver.LoadUserState(new DefaultHttpContext(), user), movie));
        }
        finally
        {
            core.Manager.AfterRead = null;
        }
    }

    [Fact]
    public void AHiddenContentSaveDuringAnInFlightReadHidesAtOnce()
    {
        // D46: the filter reads the person's Hidden Content strictly, once per request (HiddenContentPolicy.Load under the
        // document's lock): no cache across requests that a read from before the save could be put back into.
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.HiddenContentEnabled = true;
        var core = plugin.Core;
        var (user, item) = (Guid.NewGuid(), Guid.NewGuid());
        var idN = user.ToString("N");
        core.Manager.SaveUserConfiguration(idN, "hidden-content.json", new UserHiddenContent());
        var filter = new HiddenContentResponseFilter(core.Manager, core.Logger);
        var load = typeof(HiddenContentResponseFilter).GetMethod("LoadHiddenContentPolicy", BindingFlags.Instance | BindingFlags.NonPublic)!;
        bool Hides() => ((HiddenContentPolicy)load.Invoke(filter, [new DefaultHttpContext(), user])!).GlobalKeys().Contains(item.ToString("N"));
        // A read in flight holds the document's lock (as HiddenContentPolicy.Load does while it reads); a save, which takes
        // the same lock, starts during it.
        var document = core.Manager.GetUserFileLock(idN, "hidden-content.json");
        Task save;
        lock (document)
        {
            save = Task.Run(() =>
            {
                lock (document)
                {
                    core.Manager.SaveUserConfiguration(idN, "hidden-content.json", new UserHiddenContent
                    {
                        Items = new() { ["entry"] = new HiddenContentItem { ItemId = item.ToString("N"), Type = "Movie", HideScope = "global" } },
                    });
                }
                HiddenContentResponseFilter.InvalidateUser(idN);
            });
            // The save waits for the read, which answers from the document as it was ...
            Assert.False(save.Wait(TimeSpan.FromMilliseconds(200)));
            Assert.False(Hides());
        }

        Assert.True(save.Wait(TimeSpan.FromSeconds(10)));
        // ... and the next request hides at once (before: the old read, put back after the invalidation, for 30 s).
        Assert.True(Hides());
    }

    [Fact]
    public void AUserCreatedDuringTheSingleUserCheckIsNeverMistakenForTheOnlyOne()
    {
        var (a, b) = (UserChange.Read(Guid.NewGuid()), UserChange.Read(Guid.NewGuid(), "bob"));
        var all = new List<User> { a };
        RequestIdentityService? service = null;
        var users = new Mock<IUserManager>();
        var enumerations = 0;
        User[] Enumerate()
        {
            var seen = all.ToArray();
            if (enumerations++ == 0)
            {
                // B is created while the enumeration that saw only A runs; the user-created event invalidates.
                all.Add(b);
                service!.InvalidateUserTopology();
            }

            return seen;
        }
#if NET9_0
        users.SetupGet(u => u.Users).Returns(Enumerate);
#else
        users.Setup(u => u.GetUsers()).Returns(Enumerate);
#endif
        using var core = new CoreFixture();
        service = new RequestIdentityService(Mock.Of<ISessionManager>(), users.Object, null!, core.Logger);
        var single = typeof(RequestIdentityService).GetMethod("TryGetSingleUserId", BindingFlags.Instance | BindingFlags.NonPublic)!;
        Assert.Equal(a.Id, (Guid?)single.Invoke(service, []));
        // Two users now: no single-user shortcut (before: "only A", put back after the reset, for 60 s).
        Assert.Null((Guid?)single.Invoke(service, []));
        Assert.Equal(2, enumerations);
    }

    [Fact]
    public void AWrittenStateReadIsKeptOnlyWhenNoWriteInvalidatedItSinceItBegan()
    {
        var now = 0L;
        using var clock = MonotonicClock.Use(() => now);
        var cache = new WrittenStateCache<string, int>(TimeSpan.FromSeconds(30), 4, StringComparer.OrdinalIgnoreCase);
        var ticket = cache.Begin();
        cache.Invalidate("A");
        cache.Set("a", ticket, 1);
        Assert.False(cache.TryGet("a", out _));
        // Stored before the write's invalidation: ended by it, even though the store came first.
        ticket = cache.Begin();
        cache.Set("a", ticket, 2);
        Assert.True(cache.TryGet("A", out var kept) && kept == 2);
        cache.Invalidate("a");
        Assert.False(cache.TryGet("a", out _));
        // Someone else's write leaves it; everything does not.
        ticket = cache.Begin();
        cache.Set("a", ticket, 3);
        cache.Invalidate("b");
        Assert.True(cache.TryGet("a", out _));
        cache.InvalidateAll();
        Assert.False(cache.TryGet("a", out _));
        // Its life runs from the read, on the monotonic clock; GetOrRead takes the ticket before the read.
        ticket = cache.Begin();
        now = TimeSpan.FromSeconds(29).Ticks;
        cache.Set("a", ticket, 4);
        now = TimeSpan.FromSeconds(30).Ticks;
        Assert.False(cache.TryGet("a", out _));
        Assert.Equal(5, cache.GetOrRead("a", () => { cache.Invalidate("a"); return 5; }));
        Assert.False(cache.TryGet("a", out _));
        // Bounded.
        for (var i = 0; i < 10; i++) cache.Set("k" + i, cache.Begin(), i);
        Assert.True(cache.Count <= 4);
        // Too many records end every read begun before them rather than forget one.
        var rolled = new WrittenStateCache<string, int>(TimeSpan.FromMinutes(1), 4, null, 2, null);
        ticket = rolled.Begin();
        rolled.Set("a", ticket, 1);
        for (var i = 0; i < 5; i++) rolled.Invalidate("x" + i);
        Assert.False(rolled.TryGet("a", out _));
    }
}

/// <summary>
/// Review round 4 (COREUC-R4-4, a recurrence of R3-2's class): a decision and its key come from one snapshot. A keyed
/// computation decides with the viewer it was keyed by, never a later read of them by id.
/// </summary>
[Collection("Plugin singleton")]
public class UserCacheOneSnapshotTests
{
    private static (SeerrParentalFilter Parental, IntegrationTransport Transport) Parental(FakeArr arr, Func<Guid, User> current)
    {
        var config = arr.Plugin.Plugin.Configuration;
        config.JellyseerrEnabled = true; config.JellyseerrUrls = "http://seerr.invalid"; config.JellyseerrApiKey = "test-seerr";
        var ratings = new Dictionary<string, string> { ["101"] = "G", ["102"] = "R" };
        var transport = new IntegrationTransport((request, _) =>
        {
            var id = request.RequestUri!.AbsolutePath.Split('/').Last();
            if (!ratings.TryGetValue(id, out var rating)) return Task.FromResult(IntegrationTransport.Response("{}", 500));
            return Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new
            { id = int.Parse(id), releases = new { results = new[] { new { iso_3166_1 = "US", release_dates = new[] { new { type = 3, certification = rating } } } } }, keywords = new { keywords = Array.Empty<object>() }, genres = Array.Empty<object>() })));
        });
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(It.IsAny<Guid>())).Returns((Guid id) => current(id));
        var localization = new Mock<ILocalizationManager>();
        localization.Setup(l => l.GetRatingScore("G", "US")).Returns(new MediaBrowser.Model.Entities.ParentalRatingScore(1, null));
        localization.Setup(l => l.GetRatingScore("R", "US")).Returns(new MediaBrowser.Model.Entities.ParentalRatingScore(18, null));
        var server = new Mock<IServerConfigurationManager>(); server.SetupGet(s => s.Configuration).Returns(new ServerConfiguration { MetadataCountryCode = "US" });
        return (new SeerrParentalFilter(transport, users.Object, localization.Object, server.Object, arr.Plugin.Core.Logger), transport);
    }

    [Fact]
    public async Task AWidenedThenRestoredLimitAroundADiscoverLoadNeverFilesAnAdultTitleUnderTheNarrowLimit()
    {
        using var arr = new FakeArr();
        using var rig = new IntegrationRequestDiscoverTests.Rig();
        var kid = rig.AddLimitedKid();
        var viewer = rig.R.View.Users[kid];
        var limited = (User)viewer.Handle!; limited.MaxParentalRatingScore = 5;
        var widened = UserChange.Read(kid, policy: u => u.MaxParentalRatingScore = 18);
        var current = limited;
        var (parental, transport) = Parental(arr, _ => current);
        using var _transport = transport;
        var page = IntegrationRequestDiscoverTests.Page(IntegrationRequestDiscoverTests.Movie(101, "Rated G"), IntegrationRequestDiscoverTests.Movie(102, "Rated R"));
        var discover = new DiscoverService(rig.R.Service, null, DiscoverService.ParentalCheck(parental),
            (path, query, ct) =>
            {
                // The administrator widens the kid's limit while the page is read ...
                current = widened;
                return Task.FromResult<string?>(page);
            },
            (_, _) => Array.Empty<RecentTitle>(), _ => HiddenTitles.None, () => rig.Now);

        string[] Keys(DiscoverAnswer? answer) => answer!.Results.Select(c => c.Key).ToArray();
        Assert.Equal(new[] { "movie:tmdb:101" }, Keys(await discover.DiscoverAsync(viewer, "trending", "movie", 1, null, default)));
        // ... and restores it. A fresh request of the limit-5 viewer: never the 18-rated card (before: the answer decided
        // with the widened read was filed under the limit-5 key and served for 2 minutes).
        current = limited;
        Assert.Equal(new[] { "movie:tmdb:101" }, Keys(await discover.DiscoverAsync(viewer, "trending", "movie", 1, null, default)));
    }

    [Fact]
    public async Task TheArrStatusAbsentTitleCheckDecidesWithTheViewerItIsKeyedBy()
    {
        using var arr = new FakeArr();
        var config = arr.Plugin.Plugin.Configuration;
        config.ArrIntegrationEnabled = true; config.ArrPhase1Enabled = true; config.ArrPhase3Enabled = true;
        var jf = new FakeJellyfinView();
        var viewer = jf.AddUser(false, parental: true);
        var limited = (User)viewer.Handle!; limited.MaxParentalRatingScore = 5;
        var widened = UserChange.Read(viewer.UserId, policy: u => u.MaxParentalRatingScore = 18);
        var current = limited;
        var (parental, transport) = Parental(arr, _ => current);
        using var _transport = transport;
        // The rating is known (read once for the kid).
        Assert.False(await parental.MaySeeAbsentAsync("movie", 102, SeerrParentalFilter.PolicyFor(limited), default));
        using var store = arr.Store();
        var libraries = new ArrInstanceLibraries(store, new FakeLibraryAccess()) { Parental = parental };
        // The status answer is keyed by the viewer read at the start (limit 5); the limit is widened meanwhile.
        current = widened;
        Assert.False(libraries.MaySeeAbsent(viewer, TitleKey.Parse("movie:tmdb:102")!));
        // The widened viewer, as read, may see it.
        Assert.True(libraries.MaySeeAbsent(ArrJellyfinView.ViewerOf(widened), TitleKey.Parse("movie:tmdb:102")!));
    }
}

/// <summary>Review round 4: the scans behind the shape (COREUC-R4-4, -5, -7), with their plants.</summary>
public class UserCacheRound4ScanTests
{
    private const string Resolver = "Services/Acquire/Stamps/AcquisitionStampResolver.cs";
    private const string Fixed = "? _access.GetHeld((user, item), user, () => access.CanOpenAsRead(user, item))";
    private const string Filter = "Services/SpoilerGuard/SpoilerBlurImageFilter.cs";

    [Theory]
    [InlineData("() => Read()", true)]
    [InlineData("() => { return Read(); }", true)]
    [InlineData("(() => { return (Read()); })", true)]
    [InlineData("delegate { return Read(); }", true)]
    [InlineData("() => (Read().Value, Take())", false)]
    [InlineData("() => { var r = Read(); return (r.Value, r.Stamp); }", false)]
    [InlineData("() => { Log(); return Read(); }", false)]
    [InlineData("Read", false)]
    public void AHeldReadIsOneCallInAnyOfItsEquivalentForms(string read, bool accepted)
        => Assert.Equal(accepted, UserCacheScan.OneCall(SyntaxFactory.ParseExpression(read)));

    [Fact]
    public void TheStampScanAcceptsABlockLambdaWithOneReturnAndStillFailsThePlants()
    {
        var block = WriteGateWalk.Plugin.With(Resolver, s => s.Replace(Fixed, "? _access.GetHeld((user, item), user, () => { return access.CanOpenAsRead(user, item); })", StringComparison.Ordinal));
        Assert.Empty(UserCacheScan.StampSources(block));
        var anonymous = WriteGateWalk.Plugin.With(Resolver, s => s.Replace(Fixed, "? _access.GetHeld((user, item), user, delegate { return access.CanOpenAsRead(user, item); })", StringComparison.Ordinal));
        Assert.Empty(UserCacheScan.StampSources(anonymous));
        var parts = WriteGateWalk.Plugin.With(Resolver, s => s.Replace(Fixed, "? _access.GetHeld((user, item), user, () => { var r = access.CanOpenAsRead(user, item); return (r.CanOpen, r.Read); })", StringComparison.Ordinal));
        Assert.Contains(UserCacheScan.StampSources(parts), p => p.Contains("GetHeld's read must return the value and its version from one call", StringComparison.Ordinal));
    }

    [Fact]
    public void AnInvalidateOnlyCacheFails()
    {
        // Round 4's Spoiler Guard state as it was: read, stored, removed on a write.
        var planted = WriteGateWalk.Plugin.With(Filter, s => s.Replace(
            "        private static readonly TimeSpan SeasonWatchedCacheTtl",
            "        private static readonly System.Collections.Concurrent.ConcurrentDictionary<Guid, int> _plantedState = new();\n"
            + "        internal static int PlantedRead(Guid user, Func<int> read) => _plantedState.TryGetValue(user, out var v) ? v : (_plantedState[user] = read());\n"
            + "        internal static void PlantedInvalidate(Guid user) => _plantedState.TryRemove(user, out _);\n"
            + "        private static readonly TimeSpan SeasonWatchedCacheTtl", StringComparison.Ordinal));
        var registry = UserCacheRegistryTests.Registry().Append(new UserCacheRegistryTests.Row("SpoilerBlurImageFilter._plantedState", "both", "independent", "user", "the person's state (JE data, invalidated on every write), not Jellyfin access")).ToList();
        var problems = UserCacheRegistryTests.Problems(planted, registry);
        Assert.Contains(problems, p => p.StartsWith("SpoilerBlurImageFilter._plantedState: independent because it is \"invalidated on write\"", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.StartsWith("SpoilerBlurImageFilter._plantedState is dropped outside the code that fills it (SpoilerBlurImageFilter.PlantedInvalidate", StringComparison.Ordinal));
        // On the ticket protocol (declared as the helper and listed so) it passes.
        var ticketed = WriteGateWalk.Plugin.With(Filter, s => s.Replace(
            "        private static readonly TimeSpan SeasonWatchedCacheTtl",
            "        private static readonly WrittenStateCache<Guid, int> _plantedState = new(TimeSpan.FromSeconds(30), 16);\n"
            + "        internal static void PlantedInvalidate(Guid user) => _plantedState.Invalidate(user);\n"
            + "        private static readonly TimeSpan SeasonWatchedCacheTtl", StringComparison.Ordinal));
        Assert.Empty(UserCacheRegistryTests.Problems(ticketed, UserCacheRegistryTests.Registry().Append(new UserCacheRegistryTests.Row("SpoilerBlurImageFilter._plantedState", "both", "ticketed", "user", "planted")).ToList()));
    }

    [Fact]
    public void AWriteDispositionTheCodeDoesntKeepFails()
    {
        var rows = UserCacheRegistryTests.Registry().Select(r => r.Member switch
        {
            "ListStore._index" => r with { Rules = "write:locked=_cacheLock" },
            "JellyfinBridge._missing" => r with { Rules = "write:fenced=_noSuchGeneration" },
            "PosterTagTileCache._map" => r with { Rules = "write:invalidated-on-write" },
            "AcquisitionStampFeeder._pending" => r with { Rules = string.Empty },
            _ => r,
        }).ToList();
        var problems = UserCacheRegistryTests.Problems(WriteGateWalk.Plugin, rows);
        Assert.Contains(problems, p => p.StartsWith("ListStore._index: locked by _cacheLock, but ", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.StartsWith("JellyfinBridge._missing: fenced by _noSuchGeneration, but ", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.StartsWith("PosterTagTileCache._map: unknown write disposition", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.StartsWith("AcquisitionStampFeeder._pending is dropped outside the code that fills it", StringComparison.Ordinal));
        // The generation fence of the "not in Jellyfin" list, removed from one drop: caught.
        var unfenced = WriteGateWalk.Plugin.With("Services/Acquire/JellyfinBridge.cs", s =>
        {
            var at = s.IndexOf("lock (_lock) { _missingGeneration++; _missing = null; }", StringComparison.Ordinal);
            return s[..at] + "lock (_lock) { _missing = null; }" + s[(at + "lock (_lock) { _missingGeneration++; _missing = null; }".Length)..];
        });
        Assert.Contains(UserCacheRegistryTests.Problems(unfenced, UserCacheRegistryTests.Registry()), p => p.StartsWith("JellyfinBridge._missing: fenced by _missingGeneration, but JellyfinBridge.RunBatchAsync drops it without it", StringComparison.Ordinal));
    }

    [Fact]
    public void AKeyedComputationThatReadsTheUserAgainByIdFails()
    {
        var registry = UserCacheRegistryTests.Registry();
        // Discover's rating check as it was: a read of the person by id inside the projection.
        var discover = WriteGateWalk.Plugin.With("Services/Acquire/Requests/DiscoverService.cs", s => s.Replace(
            "                ParentalCheck(parental),", "                (kind, id, viewer, ct) => parental.MaySeeAbsentAsync(kind, id, viewer.UserId.ToString(\"N\", CultureInfo.InvariantCulture), ct),", StringComparison.Ordinal));
        Assert.Contains(UserCacheRegistryTests.Problems(discover, registry), p => p.StartsWith("DiscoverService._cache: DiscoverService..ctor reads the user by id (SeerrParentalFilter.MaySeeAbsentAsync", StringComparison.Ordinal));
        // The feed audience's viewer as it was: another read of the user it decides with.
        var feed = WriteGateWalk.Plugin.With("Services/Arr/Live/ArrFeedAudience.cs", s => s.Replace(
            "var viewer = Acquire.ArrJellyfinView.ViewerOf(user);", "var viewer = _view.Viewer(user.Id) ?? Acquire.ArrJellyfinView.ViewerOf(user);", StringComparison.Ordinal));
        Assert.Contains(UserCacheRegistryTests.Problems(feed, registry), p => p.StartsWith("ArrFeedAudience._cache: ArrFeedAudience.Decide reads the user by id (IArrJellyfinView.Viewer", StringComparison.Ordinal)
            || p.StartsWith("ArrFeedAudience._cache: ArrFeedAudience.Cached → ArrFeedAudience.Decide reads the user by id (IArrJellyfinView.Viewer", StringComparison.Ordinal));
        // The arr status absent-title check as it was: the parental filter's read by id, reached from the status service.
        var status = WriteGateWalk.Plugin.With("Services/Acquire/ArrInstanceLibraries.cs", s => s.Replace(
            "            return MaySeeAbsentAs(viewer, key.IsMovie ? \"movie\" : \"tv\", tmdb ?? 0);",
            "            return Parental?.MaySeeAbsent(key.IsMovie ? \"movie\" : \"tv\", tmdb ?? 0, viewer.UserId.ToString(\"N\"), out _) == true;", StringComparison.Ordinal));
        Assert.Contains(UserCacheRegistryTests.Problems(status, registry), p => p.StartsWith("ArrStatusCache._map: ArrStatusService.", StringComparison.Ordinal) && p.Contains("ArrInstanceLibraries.MaySeeAbsent", StringComparison.Ordinal) && p.Contains("SeerrParentalFilter.MaySeeAbsent", StringComparison.Ordinal));
        // A second read in the member allowed one.
        var twice = WriteGateWalk.Plugin.With("Services/Arr/Live/ArrFeedAudience.cs", s => s.Replace(
            "            if (titles.Count == 0) return own;\n            changes = titles;",
            "            if (titles.Count == 0) return own;\n            if (Helpers.ArrCaller.Find(userId, _userManager) == null) return own;\n            changes = titles;", StringComparison.Ordinal));
        Assert.Contains(UserCacheRegistryTests.Problems(twice, registry), p => p.StartsWith("ArrFeedAudience._cache: ArrFeedAudience.Visible reads the user by id (ArrCaller.Find", StringComparison.Ordinal));
    }
}
