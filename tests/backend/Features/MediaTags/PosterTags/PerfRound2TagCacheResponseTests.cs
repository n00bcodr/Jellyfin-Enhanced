using Jellyfin.Data.Enums;
using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
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
using Jellyfin.Plugin.JellyfinEnhanced.Features.Admin.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags;
using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard;
using Jellyfin.Plugin.JellyfinEnhanced.Features.SpoilerGuard.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Tmdb;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Maintenance;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Platform;

namespace JE.Tests.Features.MediaTags;

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
        public readonly JePlatformController Controller;
        private readonly ServiceProvider _provider;

        public Endpoint(Func<Endpoint, Dictionary<string, TagCacheEntry>>? extraItems = null)
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
                SchemaVersion = TagCacheService.CurrentCacheSchemaVersion, Version = 9, LastModified = 200,
                Items = new Dictionary<string, TagCacheEntry>
                {
                    [First.ToString("N")] = new() { Type = "Movie", Genres = ["First secret"], LastUpdated = 100 },
                    [Second.ToString("N")] = new() { Type = "Movie", Genres = ["Second secret"], LastUpdated = 200 },
                    [Episode.ToString("N")] = new() { Type = "Episode", SeriesId = SeriesId.ToString("N"), Genres = ["Episode secret"], LastUpdated = 150 }
                }.Concat(extraItems?.Invoke(this) ?? []).ToDictionary()
            }));
            Cache = new TagCacheService(Library.Object, Fixture.Core.Paths.Object, Mock.Of<ILocalizationManager>(), Fixture.Core.Logger, new MatroskaLanguageCache(Fixture.Core.Paths.Object, Fixture.Core.Logger));
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
            HttpContext = new DefaultHttpContext { RequestServices = _provider, User = global::JE.Tests.Features.SpoilerGuard.PrivacyPolicyTests.Principal(caller.Id, admin) }
        };

        public async Task<(int Status, string ETag, string Body)> Read(User caller, Guid? route = null, long? since = null, string? validator = null, bool admin = false, string? known = null, string? after = null, int? limit = null)
        {
            SignIn(caller, admin);
            var http = Controller.HttpContext;
            http.Request.Method = "GET";
            http.Request.Headers.Accept = "application/json";
            if (validator != null) http.Request.Headers.IfNoneMatch = validator;
            using var stream = new MemoryStream();
            http.Response.Body = stream;
            var result = ApiAssetTests.SiblingOf<JeMediaTagsController>(Controller).GetTagCache(route ?? caller.Id, since, known, after, limit);
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

    private static string FilterRevision(string body)
    {
        using var json = JsonDocument.Parse(body);
        return json.RootElement.GetProperty("filterRevision").GetString()!;
    }

    // A delta with nothing changed since the client's copy: no entries at all.
    private static void AssertEmptyDelta(string body)
    {
        using var json = JsonDocument.Parse(body);
        Assert.Equal(0, json.RootElement.GetProperty("count").GetInt32());
        Assert.Empty(json.RootElement.GetProperty("items").EnumerateObject());
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

    [Theory]
    [InlineData("tag-cache")]
    [InlineData("tag-data")]
    [InlineData("item-stats")]
    [InlineData("file-size")]
    [InlineData("watch-progress")]
    public async Task NonAdminCannotReadAnotherUsersPerUserData(string route)
    {
        using var endpoint = new Endpoint();
        endpoint.SignIn(endpoint.Bob);
        var alice = endpoint.Alice.Id;
        var item = endpoint.First;
        IActionResult result = route switch
        {
            "tag-cache" => ApiAssetTests.SiblingOf<JeMediaTagsController>(endpoint.Controller).GetTagCache(alice),
            "tag-data" => ApiAssetTests.SiblingOf<JeMediaTagsController>(endpoint.Controller).GetTagData(alice, [item.ToString()]),
            "item-stats" => ApiAssetTests.SiblingOf<JeDetailsProvidersController>(endpoint.Controller).GetItemStatsByItemId(alice, item),
            "file-size" => ApiAssetTests.SiblingOf<JeDetailsProvidersController>(endpoint.Controller).GetFileSizeByItemId(alice, item),
            _ => ApiAssetTests.SiblingOf<JeDetailsProvidersController>(endpoint.Controller).GetWatchProgressByItemId(alice, item),
        };
        Assert.IsType<ForbidResult>(result);
        if (route != "tag-cache") return;
        // Controls: an administrator may read Alice's cache, and Bob still reads his own.
        var admin = await endpoint.Read(endpoint.Bob, route: alice, admin: true);
        Assert.Equal(200, admin.Status); Assert.Contains("First secret", admin.Body); Assert.DoesNotContain("Second secret", admin.Body);
        Assert.Contains("Second secret", (await endpoint.Read(endpoint.Bob)).Body);
    }

    [Fact]
    public async Task DeltaRevalidationAfterAccessRevocationReturnsTheNewFilterRevision()
    {
        // A delta (?since=) holds only entries changed since the client's copy, so it
        // can't say an entry was revoked: only the filter revision tells the client to
        // replace its stored copy. Here both deltas are empty, so the revision is all
        // that differs, and the old validator must not get a 304.
        using var endpoint = new Endpoint();
        endpoint.AliceAccess = [endpoint.First, endpoint.Second];
        var full = await endpoint.Read(endpoint.Alice);
        Assert.Contains("Second secret", full.Body);
        var delta = await endpoint.Read(endpoint.Alice, since: 200);
        Assert.Equal(200, delta.Status);
        AssertEmptyDelta(delta.Body);
        Assert.Equal(304, (await endpoint.Read(endpoint.Alice, since: 200, validator: delta.ETag)).Status);
        endpoint.AliceAccess = [endpoint.First];
        endpoint.Cache.InvalidateUserAccess();
        var revoked = await endpoint.Read(endpoint.Alice, since: 200, validator: delta.ETag);
        Assert.Equal(200, revoked.Status);
        Assert.NotEqual(delta.ETag, revoked.ETag);
        Assert.NotEqual(FilterRevision(delta.Body), FilterRevision(revoked.Body));
        AssertEmptyDelta(revoked.Body);
    }

    private static string[]? Visible(string body)
    {
        using var json = JsonDocument.Parse(body);
        return json.RootElement.TryGetProperty("visible", out var visible) ? visible.EnumerateArray().Select(v => v.GetString()!).ToArray() : null;
    }

    private static string FilterBase(string body)
    {
        using var json = JsonDocument.Parse(body);
        return json.RootElement.GetProperty("filterBase").GetString()!;
    }

    [Fact]
    public async Task AnAccessOnlyChangeSendsTheIdsTheUserCanStillSeeAndKeepsTheFilterBase()
    {
        // A delta can correct a copy whose only change is access: it lists every id the user can see (never
        // one they cannot), and the filter without access stays the same, so the client drops the rest
        // instead of downloading everything again.
        using var endpoint = new Endpoint();
        endpoint.AliceAccess = [endpoint.First, endpoint.Second];
        var full = await endpoint.Read(endpoint.Alice);
        Assert.Null(Visible(full.Body));
        var current = await endpoint.Read(endpoint.Alice, since: 200, known: FilterRevision(full.Body));
        Assert.Null(Visible(current.Body));
        endpoint.AliceAccess = [endpoint.First];
        endpoint.Cache.InvalidateUserAccess();
        var revoked = await endpoint.Read(endpoint.Alice, since: 200, known: FilterRevision(full.Body));
        Assert.NotEqual(FilterRevision(full.Body), FilterRevision(revoked.Body));
        Assert.Equal(FilterBase(full.Body), FilterBase(revoked.Body));
        Assert.Equal([endpoint.First.ToString("N")], Visible(revoked.Body)!);
        AssertEmptyDelta(revoked.Body);
        // Asked again under the new filter: nothing more to reconcile.
        Assert.Null(Visible((await endpoint.Read(endpoint.Alice, since: 200, known: FilterRevision(revoked.Body))).Body));
    }

    private static JsonElement? Item(string body, Guid id)
    {
        using var json = JsonDocument.Parse(body);
        return json.RootElement.GetProperty("items").TryGetProperty(id.ToString("N"), out var item) ? item.Clone() : null;
    }

    [Fact]
    public async Task AnAccessOnlyDeltaResendsTheVisibleEntriesWhoseFactsDependOnAccess()
    {
        // The series' latest-episode date and the season's quality summary come from an episode Alice can
        // lose while still seeing the series and the season. Their LastUpdated never moves, so a reconciling
        // delta must carry them freshly projected; an unrelated entry does not ride along. (Collection-made
        // facts follow the same rule: OnlyEntriesProjectedThroughAccessRideAlongAReconcile.)
        var seriesKey = Guid.NewGuid();
        var seasonKey = Guid.NewGuid();
        using var endpoint = new Endpoint(e => new()
        {
            [seriesKey.ToString("N")] = new() { Type = "Series", DateCreated = 100, LatestEpisodeAdded = 5000, LatestEpisodeId = e.Episode.ToString("N"), LastUpdated = 120 },
            [seasonKey.ToString("N")] = new() { Type = "Season", SeriesId = e.SeriesId.ToString("N"), AudioLanguages = ["ja"], QualityEpisodeIds = [e.Episode.ToString("N")], LastUpdated = 130 }
        });
        endpoint.AliceAccess = [endpoint.First, seriesKey, endpoint.Episode, seasonKey];
        var full = await endpoint.Read(endpoint.Alice);
        Assert.Equal(5000, Item(full.Body, seriesKey)!.Value.GetProperty("LatestEpisodeAdded").GetInt64());
        Assert.Equal("ja", Item(full.Body, seasonKey)!.Value.GetProperty("AudioLanguages")[0].GetString());

        // Alice loses the episode; the series and the season stay visible.
        endpoint.AliceAccess = [endpoint.First, seriesKey, seasonKey];
        endpoint.Cache.InvalidateUserAccess();
        var revoked = await endpoint.Read(endpoint.Alice, since: 200, known: FilterRevision(full.Body));
        Assert.Equal(FilterBase(full.Body), FilterBase(revoked.Body));
        Assert.Equal(new[] { endpoint.First, seriesKey, seasonKey }.Select(id => id.ToString("N")).Order(StringComparer.Ordinal), Visible(revoked.Body)!);
        var series = Item(revoked.Body, seriesKey);
        Assert.NotNull(series);
        Assert.False(series!.Value.TryGetProperty("LatestEpisodeAdded", out _));
        var season = Item(revoked.Body, seasonKey);
        Assert.NotNull(season);
        Assert.False(season!.Value.TryGetProperty("AudioLanguages", out var languages) && languages.GetArrayLength() > 0);
        Assert.Null(Item(revoked.Body, endpoint.First));
        Assert.DoesNotContain(endpoint.Episode.ToString("N"), revoked.Body);

        // Under the new filter nothing rides along; granting them back re-sends both with their facts.
        AssertEmptyDelta((await endpoint.Read(endpoint.Alice, since: 200, known: FilterRevision(revoked.Body))).Body);
        endpoint.AliceAccess = [endpoint.First, seriesKey, endpoint.Episode, seasonKey];
        endpoint.Cache.InvalidateUserAccess();
        var granted = await endpoint.Read(endpoint.Alice, since: 200, known: FilterRevision(revoked.Body));
        Assert.Equal(5000, Item(granted.Body, seriesKey)!.Value.GetProperty("LatestEpisodeAdded").GetInt64());
        Assert.Equal("ja", Item(granted.Body, seasonKey)!.Value.GetProperty("AudioLanguages")[0].GetString());
        Assert.Equal(FilterRevision(full.Body), FilterRevision(granted.Body));
    }

    [Fact]
    public void OnlyEntriesProjectedThroughAccessRideAlongAReconcile()
    {
        Assert.False(TagCacheService.ProjectsAccess(new TagCacheEntry { Type = "Movie", Genres = ["Drama"] }));
        Assert.True(TagCacheService.ProjectsAccess(new TagCacheEntry { Type = "Season", QualityEpisodeIds = ["e"] }));
        Assert.True(TagCacheService.ProjectsAccess(new TagCacheEntry { Type = "Series", StatusEpisodeIds = ["e"] }));
        Assert.True(TagCacheService.ProjectsAccess(new TagCacheEntry { Type = "Series", LatestEpisodeId = "e" }));
        Assert.True(TagCacheService.ProjectsAccess(new TagCacheEntry { Type = "Movie", Leaving = new TagLeaving { Collections = "c" } }));
        Assert.False(TagCacheService.ProjectsAccess(new TagCacheEntry { Type = "Movie", Leaving = new TagLeaving { DeleteAt = 1 } }));
        Assert.True(TagCacheService.ProjectsAccess(new TagCacheEntry { Type = "Movie", CustomTags = [CustomTagRuleSet.MatchCollection + ":Favourites"] }));
        Assert.False(TagCacheService.ProjectsAccess(new TagCacheEntry { Type = "Movie", CustomTags = ["tag:Favourites"] }));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task APagedFullLoadHoldsEveryEntryOnceInBoundedPagesUnderOneFilter(bool guard)
    {
        // 250 more movies (Alice sees all but every fifth): pages of at most 100, sorted, every visible entry
        // exactly once, each page with the full load's version and filter revision (Spoiler Guard included).
        var movies = Enumerable.Range(0, 250).Select(_ => Guid.NewGuid()).ToArray();
        using var endpoint = new Endpoint(e => movies.ToDictionary(id => id.ToString("N"), id => new TagCacheEntry { Type = "Movie", Genres = ["Drama"], LastUpdated = 120 }));
        endpoint.AliceAccess = [endpoint.First, endpoint.Episode, .. movies.Where((_, i) => i % 5 != 0)];
        if (guard) endpoint.GuardSeries();
        var full = await endpoint.Read(endpoint.Alice);
        using var fullJson = JsonDocument.Parse(full.Body);
        var expected = fullJson.RootElement.GetProperty("items").EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetRawText());
        var seen = new List<string>();
        string? after = null;
        var pages = 0;
        do
        {
            var page = await endpoint.Read(endpoint.Alice, after: after, limit: 100);
            Assert.Equal(200, page.Status);
            using var json = JsonDocument.Parse(page.Body);
            var root = json.RootElement;
            Assert.Equal(fullJson.RootElement.GetProperty("version").GetInt64(), root.GetProperty("version").GetInt64());
            Assert.Equal(FilterRevision(full.Body), root.GetProperty("filterRevision").GetString());
            var items = root.GetProperty("items").EnumerateObject().ToList();
            Assert.InRange(items.Count, 1, 100);
            foreach (var item in items)
            {
                Assert.Equal(expected[item.Name], item.Value.GetRawText());
                seen.Add(item.Name);
            }
            after = root.TryGetProperty("next", out var next) ? next.GetString() : null;
            if (after != null) Assert.Equal(items[^1].Name, after);
            pages++;
        }
        while (after != null && pages < 10);
        Assert.Equal(3, pages);
        Assert.Equal(expected.Keys.Order(StringComparer.Ordinal), seen);
        Assert.Equal(seen.Order(StringComparer.Ordinal), seen);
        Assert.DoesNotContain(movies[0].ToString("N"), seen);
        // The guarded, unwatched episode is stripped on every page exactly as in the full load.
        Assert.Equal(!guard, expected[endpoint.Episode.ToString("N")].Contains("Episode secret", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TheVisibleIdsNeverNameAnItemTheUserCannotSee()
    {
        var hidden = Guid.NewGuid();
        using var endpoint = new Endpoint(_ => new() { [hidden.ToString("N")] = new() { Type = "Movie", Genres = ["Hidden secret"], LastUpdated = 300 } });
        var delta = await endpoint.Read(endpoint.Alice, since: 100, known: "stale");
        Assert.Equal([endpoint.First.ToString("N")], Visible(delta.Body)!);
        Assert.DoesNotContain(hidden.ToString("N"), delta.Body);
        Assert.DoesNotContain(endpoint.Second.ToString("N"), delta.Body);
    }

    [Fact]
    public async Task AnUnreadableSpoilerStateKeepsTheGuardAndTheFileWhereItIs()
    {
        using var endpoint = new Endpoint();
        endpoint.AliceAccess = [endpoint.First, endpoint.Episode];
        endpoint.GuardSeries();
        Assert.DoesNotContain("Episode secret", (await endpoint.Read(endpoint.Alice)).Body);

        // Alice's file can no longer be read (cut short by a full disk, a share that dropped).
        var path = Path.Combine(endpoint.Fixture.Core.ConfigRoot, endpoint.Alice.Id.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName);
        File.WriteAllText(path, "{\"Series\":{");
        SpoilerUserResolver.InvalidateUser(endpoint.Alice.Id.ToString("N"));
        var unreadable = await endpoint.Read(endpoint.Alice);
        Assert.Equal(200, unreadable.Status);
        Assert.DoesNotContain("Episode secret", unreadable.Body);
        // A read never moves the file aside: it is still there, as it was.
        Assert.Equal("{\"Series\":{", File.ReadAllText(path));
        Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(path)!, "*.corrupt-*"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData(300L)]
    public async Task RevalidationSeesAGuardedEpisodeBecomingWatched(long? since)
    {
        // Watching a guarded episode changes neither the cache version, the
        // guarded set (filter revision) nor the entry count — only the entry
        // itself, now unstripped. A full load and a delta (which always carries
        // guarded entries) must both answer the old validator with the new body.
        using var endpoint = new Endpoint();
        endpoint.AliceAccess = [endpoint.First, endpoint.Episode];
        endpoint.GuardSeries();
        var guarded = await endpoint.Read(endpoint.Alice, since: since);
        Assert.Equal(200, guarded.Status);
        Assert.Contains(endpoint.Episode.ToString("N"), guarded.Body); Assert.DoesNotContain("Episode secret", guarded.Body);
        Assert.Equal(304, (await endpoint.Read(endpoint.Alice, since: since, validator: guarded.ETag)).Status);
        endpoint.AlicePlayed.Add(endpoint.Episode);
        var watched = await endpoint.Read(endpoint.Alice, since: since, validator: guarded.ETag);
        Assert.Equal(200, watched.Status);
        Assert.Contains("Episode secret", watched.Body);
        Assert.Equal(FilterRevision(guarded.Body), FilterRevision(watched.Body));
    }

    [Fact]
    public async Task QualitySummariesAreUserScopedOnCacheAndBatchAndNeverExposeContributors()
    {
        var seriesId = Guid.NewGuid();
        var lowId = Guid.NewGuid();
        using var endpoint = new Endpoint(e => new()
        {
            [seriesId.ToString("N")] = new()
            {
                Type = "Series", StreamData = new() { Streams = [new() { Type = "Video", Height = 2160 }] },
                QualityEpisodeIds = [e.Episode.ToString("N"), lowId.ToString("N")],
                QualitySummary = SeriesQualityAggregation.Build([
                    new(e.Episode.ToString("N"), 100, new() { Streams = [new() { Type = "Video", Height = 2160 }] }),
                    new(lowId.ToString("N"), 200, new() { Streams = [new() { Type = "Video", Height = 1080 }] })]), LastUpdated = 120,
            },
            [lowId.ToString("N")] = new() { Type = "Episode", SeasonNumber = 1, PremiereDate = 200, StreamData = new() { Streams = [new() { Type = "Video", Height = 1080 }] }, LastUpdated = 120 },
        });
        endpoint.AliceAccess = [seriesId, lowId];
        var response = await endpoint.Read(endpoint.Alice);
        Assert.DoesNotContain("QualityEpisodeIds", response.Body);
        using var cacheJson = JsonDocument.Parse(response.Body);
        var container = cacheJson.RootElement.GetProperty("items").GetProperty(seriesId.ToString("N"));
        Assert.Equal("1080p", container.GetProperty("QualitySummary").GetProperty("Categories").GetProperty("resolution").GetProperty("Best").GetString());
        var series = new Series { Id = seriesId };
        endpoint.Library.Setup(x => x.GetItemById<BaseItem>(seriesId, endpoint.Alice)).Returns(series);
        endpoint.Library.Setup(x => x.GetItemList(It.IsAny<InternalItemsQuery>())).Returns([]);
        var batch = Assert.IsType<OkObjectResult>(ApiAssetTests.SiblingOf<JeMediaTagsController>(endpoint.Controller).GetTagData(endpoint.Alice.Id, [seriesId.ToString()]));
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(batch.Value));
        Assert.Equal("1080p", json.RootElement.GetProperty("Items")[0].GetProperty("QualitySummary").GetProperty("Categories").GetProperty("resolution").GetProperty("Best").GetString());
        Assert.DoesNotContain("QualityEpisodeIds", JsonSerializer.Serialize(batch.Value));
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
        var tagData = Assert.IsType<OkObjectResult>(ApiAssetTests.SiblingOf<JeMediaTagsController>(endpoint.Controller).GetTagData(Guid.Empty, [series.Id.ToString()]));
        var json = JsonSerializer.Serialize(tagData.Value);
        Assert.Contains(series.Id.ToString(), json); Assert.DoesNotContain("Series secret", json);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SpoilerGuardHideTagsStripsLogosFromGuardedCacheEntriesOnLoadsAndDeltas(bool guard)
    {
        var guardedEpisode = Guid.NewGuid();
        var openMovie = Guid.NewGuid();
        using var endpoint = new Endpoint(e => new()
        {
            [guardedEpisode.ToString("N")] = new() { Type = "Episode", SeriesId = e.SeriesId.ToString("N"), Logos = [new() { Kind = "network", Name = "Guarded Network" }], LastUpdated = 130 },
            [openMovie.ToString("N")] = new() { Type = "Movie", Logos = [new() { Kind = "provider", Name = "Open Provider" }], LastUpdated = 130 },
        });
        endpoint.AliceAccess = [guardedEpisode, openMovie];
        if (guard) endpoint.GuardSeries();
        foreach (var since in new long?[] { null, 100 })
        {
            var body = (await endpoint.Read(endpoint.Alice, since: since)).Body;
            Assert.Contains("Open Provider", body);
            Assert.Equal(!guard, body.Contains("Guarded Network", StringComparison.Ordinal));
        }

        if (!guard) return;
        // Watched: the episode is no longer stripped, its logo returns.
        endpoint.AlicePlayed.Add(guardedEpisode);
        Assert.Contains("Guarded Network", (await endpoint.Read(endpoint.Alice)).Body);
    }

    [Theory]
    [InlineData("off")]
    [InlineData("hide-tags")]
    [InlineData("ratings-only")]
    public async Task SpoilerGuardHideTagsStripsLogosFromEveryBatchStub(string policy)
    {
        using var endpoint = new Endpoint();
        var config = endpoint.Fixture.Plugin.Configuration;
        config.LogoTagsEnabled = true;
        endpoint.Cache.OnLogoSettingsChanged();
        await endpoint.Cache.LogoWorkQueue.WaitAsync(TimeSpan.FromSeconds(10));
        var series = new Series { Id = endpoint.SeriesId, Name = "Guarded show", Studios = ["Series Network"] };
        var episode = new TagCacheSubtitleLanguagesTests.Episode { Id = endpoint.Episode, SeriesId = endpoint.SeriesId, Name = "Guarded episode" };
        var movie = new TagCacheSubtitleLanguagesTests.Movie { Id = Guid.NewGuid(), Name = "Guarded movie", Studios = ["Movie Studio"] };
        var open = new TagCacheSubtitleLanguagesTests.Movie { Id = Guid.NewGuid(), Name = "Open movie", Studios = ["Open Studio"] };
        foreach (var item in new BaseItem[] { series, episode, movie, open })
            endpoint.Library.Setup(x => x.GetItemById<BaseItem>(item.Id, It.IsAny<User>())).Returns(item);
        endpoint.Library.Setup(x => x.GetItemById<BaseItem>(series.Id)).Returns(series); // the episode's logo owner
        endpoint.Library.Setup(x => x.GetItemList(It.IsAny<InternalItemsQuery>())).Returns([]);
        if (policy != "off")
        {
            config.SpoilerBlurEnabled = true;
            config.SpoilerStripTags = true;
            config.SpoilerStripRatings = true;
            var state = new UserSpoilerBlur();
            state.Series[series.Id.ToString("N")] = new();
            state.Movies[movie.Id.ToString("N")] = new();
            // The user's own "don't hide tags for me" keeps the logos (ratings are still stripped).
            if (policy == "ratings-only") state.Prefs = new SpoilerBlurUserPrefs { HideTags = false };
            endpoint.Fixture.Core.Manager.SaveUserConfiguration(endpoint.Alice.Id.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName, state);
        }

        endpoint.SignIn(endpoint.Alice);
        var ok = Assert.IsType<OkObjectResult>(ApiAssetTests.SiblingOf<JeMediaTagsController>(endpoint.Controller).GetTagData(Guid.Empty, new[] { series.Id, episode.Id, movie.Id, open.Id }.Select(id => id.ToString()).ToArray()));
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(ok.Value));
        string[] LogoNames(Guid id)
        {
            var logos = json.RootElement.GetProperty("Items").EnumerateArray().Single(i => i.GetProperty("Id").GetGuid() == id).GetProperty("Logos");
            return logos.ValueKind == JsonValueKind.Null ? [] : logos.EnumerateArray().Select(l => l.GetProperty("name").GetString()!).ToArray();
        }

        var stripped = policy == "hide-tags";
        Assert.Equal(stripped ? [] : ["Series Network"], LogoNames(series.Id));
        Assert.Equal(stripped ? [] : ["Series Network"], LogoNames(episode.Id));
        Assert.Equal(stripped ? [] : ["Movie Studio"], LogoNames(movie.Id));
        Assert.Equal(["Open Studio"], LogoNames(open.Id));
    }

    [Fact]
    public async Task SubtitleLanguagesReachTagCacheAndTagDataAndFollowTheSpoilerStrip()
    {
        var subbed = Guid.NewGuid();
        var guardedEpisode = Guid.NewGuid();
        using var endpoint = new Endpoint(e => new()
        {
            [subbed.ToString("N")] = new() { Type = "Movie", AudioLanguages = ["eng"], SubtitleLanguages = ["eng", "fre"], LastUpdated = 120 },
            [guardedEpisode.ToString("N")] = new() { Type = "Episode", SeriesId = e.SeriesId.ToString("N"), AudioLanguages = ["eng"], SubtitleLanguages = ["spa"], LastUpdated = 130 },
        });
        endpoint.AliceAccess = [endpoint.First, subbed, guardedEpisode];
        var open = await endpoint.Read(endpoint.Alice);
        Assert.Contains("\"SubtitleLanguages\":[\"eng\",\"fre\"]", open.Body);
        Assert.Contains("\"SubtitleLanguages\":[\"spa\"]", open.Body);
        // Bob's access set leaves both entries out entirely.
        Assert.DoesNotContain("SubtitleLanguages", (await endpoint.Read(endpoint.Bob)).Body);

        // Spoiler Guard's tag strip drops subtitle languages together with the audio ones,
        // and the strip fingerprint (part of filterRevision) changes with it.
        endpoint.GuardSeries();
        var guarded = await endpoint.Read(endpoint.Alice);
        Assert.Contains("\"SubtitleLanguages\":[\"eng\",\"fre\"]", guarded.Body);
        Assert.DoesNotContain("\"spa\"", guarded.Body);
        Assert.NotEqual(FilterRevision(open.Body), FilterRevision(guarded.Body));

        // /tag-data: one language per subtitle track language (forced / SDH / external
        // tracks count once, untagged ones not at all); streams retain subtitle accessibility facts.
        var movie = new TagCacheSubtitleLanguagesTests.Movie
        {
            Id = Guid.NewGuid(), Name = "Subbed",
            Sources = [new() { MediaStreams = [
                new() { Type = MediaBrowser.Model.Entities.MediaStreamType.Audio, Language = "eng" },
                new() { Type = MediaBrowser.Model.Entities.MediaStreamType.Subtitle, Language = "eng", IsForced = true },
                new() { Type = MediaBrowser.Model.Entities.MediaStreamType.Subtitle, Language = "ENG", IsHearingImpaired = true },
                new() { Type = MediaBrowser.Model.Entities.MediaStreamType.Subtitle, Language = "fre", IsExternal = true },
                new() { Type = MediaBrowser.Model.Entities.MediaStreamType.Subtitle, Language = "und" },
            ] }],
        };
        endpoint.Library.Setup(x => x.GetItemById<BaseItem>(movie.Id, It.IsAny<User>())).Returns(movie);
        endpoint.SignIn(endpoint.Alice);
        var ok = Assert.IsType<OkObjectResult>(ApiAssetTests.SiblingOf<JeMediaTagsController>(endpoint.Controller).GetTagData(Guid.Empty, [movie.Id.ToString()]));
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(ok.Value));
        var item = json.RootElement.GetProperty("Items")[0];
        Assert.Equal(["eng", "fre"], item.GetProperty("SubtitleLanguages").EnumerateArray().Select(v => v.GetString()!).ToArray());
        Assert.Contains(item.GetProperty("MediaStreams").EnumerateArray(), s => s.GetProperty("Type").GetString() == "Subtitle" && s.GetProperty("IsHearingImpaired").GetBoolean());
        Assert.Equal(new[] { "eng" }, item.GetProperty("SdhSubtitleLanguages").EnumerateArray().Select(v => v.GetString()!).ToArray());
    }

    [Fact]
    public async Task CustomTagMatchesFollowTheSpoilerTagStripInTheCacheAndTheBatch()
    {
        var plainMovie = Guid.NewGuid();
        var guardedEpisode = Guid.NewGuid();
        var twist = CustomTagRuleSet.RuleId(new CustomTagRule { Match = "tag", Value = "Twist", Label = "Twist" }, null);
        using var endpoint = new Endpoint(e => new()
        {
            [plainMovie.ToString("N")] = new() { Type = "Movie", CustomTags = [twist], LastUpdated = 120 },
            [guardedEpisode.ToString("N")] = new() { Type = "Episode", SeriesId = e.SeriesId.ToString("N"), CustomTags = [twist], LastUpdated = 130 },
        });
        endpoint.Fixture.Plugin.Configuration.CustomTagRules = CustomTagRuleSet.Normalize([new CustomTagRule { Match = "tag", Value = "Twist", Label = "Twist" }]);
        endpoint.AliceAccess = [endpoint.First, plainMovie, guardedEpisode];
        static string[]? Matches(string body, Guid id)
        {
            using var json = JsonDocument.Parse(body);
            return json.RootElement.GetProperty("items").GetProperty(id.ToString("N")).TryGetProperty("CustomTags", out var tags) && tags.ValueKind == JsonValueKind.Array
                ? tags.EnumerateArray().Select(t => t.GetString()!).ToArray() : null;
        }

        var open = await endpoint.Read(endpoint.Alice);
        Assert.Equal([twist], Matches(open.Body, guardedEpisode));

        // Guard on with the tag strip: the guarded episode loses its matches like its genres (full
        // load and the delta's guarded rider), the unguarded movie keeps them, and the strip
        // fingerprint (part of filterRevision) changes, so stored copies are replaced.
        endpoint.GuardSeries();
        var guarded = await endpoint.Read(endpoint.Alice);
        Assert.Null(Matches(guarded.Body, guardedEpisode));
        Assert.Equal([twist], Matches(guarded.Body, plainMovie));
        Assert.NotEqual(FilterRevision(open.Body), FilterRevision(guarded.Body));
        Assert.Null(Matches((await endpoint.Read(endpoint.Alice, since: 500)).Body, guardedEpisode));

        // A ratings-only strip leaves them, as it leaves genres.
        endpoint.Fixture.Plugin.Configuration.SpoilerStripTags = false;
        endpoint.Fixture.Plugin.Configuration.SpoilerStripRatings = true;
        Assert.Equal([twist], Matches((await endpoint.Read(endpoint.Alice)).Body, guardedEpisode));

        // /tag-data: the guarded series' stub follows the same switch.
        var series = new Series { Id = endpoint.SeriesId, Name = "Show", Tags = ["Twist"] };
        endpoint.Library.Setup(x => x.GetItemById<BaseItem>(series.Id, It.IsAny<User>())).Returns(series);
        endpoint.Library.Setup(x => x.GetItemList(It.IsAny<InternalItemsQuery>())).Returns([]);
        string[]? Batch()
        {
            endpoint.SignIn(endpoint.Alice);
            var ok = Assert.IsType<OkObjectResult>(ApiAssetTests.SiblingOf<JeMediaTagsController>(endpoint.Controller).GetTagData(Guid.Empty, [series.Id.ToString()]));
            using var json = JsonDocument.Parse(JsonSerializer.Serialize(ok.Value));
            var item = json.RootElement.GetProperty("Items")[0];
            Assert.Equal(series.Id.ToString(), item.GetProperty("Id").GetString());
            return item.GetProperty("CustomTags").ValueKind == JsonValueKind.Array ? item.GetProperty("CustomTags").EnumerateArray().Select(t => t.GetString()!).ToArray() : null;
        }

        Assert.Equal([twist], Assert.IsType<string[]>(Batch()));
        endpoint.Fixture.Plugin.Configuration.SpoilerStripTags = true;
        Assert.Null(Batch());
    }

    [Fact]
    public void BatchAnswersAndTheBootstrapStateWhatHideTagsStripsForTheUser()
    {
        // The web batch fallback keeps answers across page loads only under "none" and
        // drops ones stamped with another revision, so a guard set from another client
        // is never bypassed by a copy from before it (js/tags/customtags.js).
        using var endpoint = new Endpoint();
        string? Revision(object? body, params string[] path)
        {
            using var json = JsonDocument.Parse(JsonSerializer.Serialize(body));
            var node = json.RootElement;
            foreach (var key in path) node = node.GetProperty(key);
            return node.ValueKind == JsonValueKind.Null ? null : node.GetString();
        }

        string? Batch()
        {
            endpoint.SignIn(endpoint.Alice);
            return Revision(Assert.IsType<OkObjectResult>(ApiAssetTests.SiblingOf<JeMediaTagsController>(endpoint.Controller).GetTagData(Guid.Empty, [Guid.NewGuid().ToString()])).Value, "StripRevision");
        }

        var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<MediaBrowser.Controller.Session.ISessionManager>(), endpoint.Fixture.Core.Paths.Object, endpoint.Fixture.Core.Logger);
        var bootstrap = ApiAssetTests.Controller(endpoint.Fixture.Core, maintenance, endpoint.Fixture.Core.Manager, endpoint.Library.Object);
        bootstrap.ControllerContext.HttpContext.User = global::JE.Tests.Features.SpoilerGuard.PrivacyPolicyTests.Principal(endpoint.Alice.Id, false);
        string? Bootstrap() => Revision(Assert.IsType<JsonResult>(bootstrap.GetBootstrap()).Value, "Prefetched", "TagStripRevision");

        Assert.Equal((SpoilerTagDataStripper.NoTagStrip, SpoilerTagDataStripper.NoTagStrip), (Batch(), Bootstrap()));

        endpoint.GuardSeries();
        var guarded = Batch();
        Assert.StartsWith("g2:", guarded);
        Assert.Equal(guarded, Bootstrap());

        // Another guarded title (from any client) changes it; the same set in another order or case does not.
        var state = endpoint.Fixture.Core.Manager.GetUserConfiguration<UserSpoilerBlur>(endpoint.Alice.Id.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName);
        state.Movies[endpoint.First.ToString("N")] = new();
        endpoint.Fixture.Core.Manager.SaveUserConfiguration(endpoint.Alice.Id.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName, state);
        var more = Batch();
        Assert.NotEqual(guarded, more);
        Assert.Equal(more, Bootstrap());
        var shuffled = new UserSpoilerBlur();
        shuffled.Movies[endpoint.First.ToString("N").ToUpperInvariant()] = new();
        shuffled.Series[endpoint.SeriesId.ToString("N")] = new();
        Assert.Equal(more, SpoilerTagDataStripper.TagStripRevision(SpoilerTagDataStripper.CreatePolicy(endpoint.Fixture.Plugin.Configuration, shuffled)));

        // Ratings-only and title-only strips still invalidate every shared fallback group.
        endpoint.Fixture.Plugin.Configuration.SpoilerStripTags = false;
        endpoint.Fixture.Plugin.Configuration.SpoilerStripRatings = true;
        var ratingsOnly = Batch();
        Assert.StartsWith("g2:", ratingsOnly);
        Assert.NotEqual(more, ratingsOnly);
        Assert.Equal(ratingsOnly, Bootstrap());
        endpoint.Fixture.Plugin.Configuration.SpoilerStripTags = true;
        state.Prefs = new SpoilerBlurUserPrefs { HideTags = false };
        endpoint.Fixture.Core.Manager.SaveUserConfiguration(endpoint.Alice.Id.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName, state);
        Assert.Equal(ratingsOnly, Batch());
        Assert.Equal(ratingsOnly, Bootstrap());
        endpoint.Fixture.Plugin.Configuration.SpoilerStripRatings = false;
        endpoint.Fixture.Plugin.Configuration.SpoilerReplaceTitle = true;
        var titleOnly = Batch();
        Assert.StartsWith("g2:", titleOnly);
        Assert.NotEqual(ratingsOnly, titleOnly);
        Assert.Equal(titleOnly, Bootstrap());
        state.Prefs = new SpoilerBlurUserPrefs { HideTags = false, ReplaceEpisodeTitles = false, HideEpisodeDescriptions = false, HideRatings = false };
        endpoint.Fixture.Core.Manager.SaveUserConfiguration(endpoint.Alice.Id.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName, state);
        Assert.Equal((SpoilerTagDataStripper.NoTagStrip, SpoilerTagDataStripper.NoTagStrip), (Batch(), Bootstrap()));

        // Unguarded again: back to "none", so kept copies are trusted once more.
        endpoint.Fixture.Core.Manager.SaveUserConfiguration(endpoint.Alice.Id.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName, new UserSpoilerBlur());
        Assert.Equal((SpoilerTagDataStripper.NoTagStrip, SpoilerTagDataStripper.NoTagStrip), (Batch(), Bootstrap()));
    }

    [Fact]
    public async Task LatestEpisodeDateOnlyReachesUsersWhoCanSeeThatEpisodeAndItsIdNeverDoes()
    {
        // The series entry's "New Episode" date came from Episode. Alice can see
        // the series but not that episode (parental rating, blocked tag, ...).
        var seriesKey = Guid.NewGuid();
        using var endpoint = new Endpoint(e => new()
        {
            [seriesKey.ToString("N")] = new() { Type = "Series", DateCreated = 100, LatestEpisodeAdded = 5000, LatestEpisodeId = e.Episode.ToString("N"), LastUpdated = 120 }
        });
        Assert.True(endpoint.Cache.TryGetEntry(seriesKey, out var shared)); // read back from the snapshot
        Assert.Equal(endpoint.Episode.ToString("N"), shared.LatestEpisodeId);
        endpoint.AliceAccess = [endpoint.First, seriesKey];

        var hidden = await endpoint.Read(endpoint.Alice);
        using (var json = JsonDocument.Parse(hidden.Body))
        {
            var entry = json.RootElement.GetProperty("items").GetProperty(seriesKey.ToString("N"));
            Assert.Equal(100, entry.GetProperty("DateCreated").GetInt64());
            Assert.False(entry.TryGetProperty("LatestEpisodeAdded", out _));
        }
        Assert.DoesNotContain("LatestEpisodeId", hidden.Body);
        Assert.DoesNotContain(endpoint.Episode.ToString("N"), hidden.Body);
        Assert.Equal(5000, shared.LatestEpisodeAdded); // the shared entry is untouched

        endpoint.AliceAccess = [endpoint.First, seriesKey, endpoint.Episode];
        endpoint.Cache.InvalidateUserAccess();
        var visible = await endpoint.Read(endpoint.Alice);
        using (var json = JsonDocument.Parse(visible.Body))
        {
            Assert.Equal(5000, json.RootElement.GetProperty("items").GetProperty(seriesKey.ToString("N")).GetProperty("LatestEpisodeAdded").GetInt64());
        }
        Assert.DoesNotContain("LatestEpisodeId", visible.Body);
        // Seeing the episode changes the fingerprint, so a stored copy without the date is replaced.
        Assert.NotEqual(FilterRevision(hidden.Body), FilterRevision(visible.Body));
    }

    [Fact]
    public void GuardedSeriesStubKeepsTheTmdbIdForTrendingButNoProviderIds()
    {
        using var endpoint = new Endpoint();
        endpoint.GuardSeries();
        var series = new Series { Id = endpoint.SeriesId, Name = "Show", Genres = ["Series secret"], ProviderIds = new Dictionary<string, string> { ["Tmdb"] = "4242", ["Imdb"] = "tt0001" } };
        endpoint.Library.Setup(x => x.GetItemById<BaseItem>(series.Id, It.IsAny<User>())).Returns(series);
        endpoint.Library.Setup(x => x.GetItemList(It.IsAny<InternalItemsQuery>())).Returns([]);
        endpoint.SignIn(endpoint.Alice);
        var tagData = Assert.IsType<OkObjectResult>(ApiAssetTests.SiblingOf<JeMediaTagsController>(endpoint.Controller).GetTagData(Guid.Empty, [series.Id.ToString()]));
        var json = JsonSerializer.Serialize(tagData.Value);
        Assert.DoesNotContain("Series secret", json); // still the strip stub
        Assert.Contains("\"TmdbId\":\"4242\"", json);
        Assert.DoesNotContain("tt0001", json);
    }
    [Fact]
    public async Task StatusFactSourceIdsNeverReachTheClient()
    {
        var seasonKey = Guid.NewGuid();
        using var endpoint = new Endpoint(e => new()
        {
            [seasonKey.ToString("N")] = new()
            {
                Type = "Season", DateCreated = 100, LastUpdated = 120, LatestEpisodeAired = 900, NextEpisodePremiere = 1800,
                LatestEpisodeIndex = new() { Season = 2, Episode = 5 }, StatusEpisodeIds = [e.Episode.ToString("N")],
            }
        });
        endpoint.AliceAccess = [endpoint.First, seasonKey, endpoint.Episode];
        var read = await endpoint.Read(endpoint.Alice);
        using var json = JsonDocument.Parse(read.Body);
        var entry = json.RootElement.GetProperty("items").GetProperty(seasonKey.ToString("N"));
        Assert.Equal(900, entry.GetProperty("LatestEpisodeAired").GetInt64());
        Assert.Equal(5, entry.GetProperty("LatestEpisodeIndex").GetProperty("Episode").GetInt32());
        Assert.False(entry.TryGetProperty("StatusEpisodeIds", out _));
        Assert.False(entry.TryGetProperty("NextEpisodePremiere", out _));
    }

    /// <summary>GET status-tags/series through the endpoint fixture, with a TMDB transport that records its calls.</summary>
    private static async Task<(IActionResult Result, List<string> Upstream)> SeriesLookup(Endpoint endpoint, User? caller, string? ids, int status = 200)
    {
        var upstream = new List<string>();
        using var transport = new IntegrationTransport((request, _) =>
        {
            lock (upstream) upstream.Add(request.RequestUri!.AbsolutePath);
            return Task.FromResult(IntegrationTransport.Response("""{"status":"Ended","last_episode_to_air":{"air_date":"2026-10-28","season_number":2,"episode_number":10,"episode_type":"finale"}}""", status));
        });
        using var tmdbCache = new TmdbResponseCache(transport, TimeProvider.System);
        var service = new StatusTagsSeriesService(tmdbCache, endpoint.Fixture.Core.Logger);
        if (caller != null) endpoint.SignIn(caller);
        else endpoint.Controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() };
        var result = await ApiAssetTests.SiblingOf<JeMediaTagsController>(endpoint.Controller).GetStatusTagsSeries(ids, service);
        return (result, upstream);
    }

    [Fact]
    public async Task SeriesLookupMarks429ForRetryWithoutHttpCaching()
    {
        using var endpoint = new Endpoint();
        endpoint.Fixture.Plugin.Configuration.StatusTagsEnabled = true;
        endpoint.Fixture.Plugin.Configuration.TMDB_API_KEY = "key";
        var series = new Series { Id = Guid.NewGuid(), ProviderIds = new Dictionary<string, string> { ["Tmdb"] = "100" } };
        endpoint.Library.Setup(x => x.GetItemById<BaseItem>(series.Id, endpoint.Alice)).Returns(series);
        var (result, upstream) = await SeriesLookup(endpoint, endpoint.Alice, series.Id.ToString(), 429);
        var payload = Assert.IsType<Dictionary<string, object>>(Assert.IsType<OkObjectResult>(result).Value);
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(payload));
        Assert.True(json.RootElement.GetProperty(series.Id.ToString("N")).GetProperty("retry").GetBoolean());
        Assert.Equal("private, no-store", endpoint.Controller.Response.Headers.CacheControl);
        Assert.Single(upstream);
    }

    [Fact]
    public async Task SeriesLookupAnswersOnlyForSeriesTheCallerCanSeeWithATmdbId()
    {
        using var endpoint = new Endpoint();
        endpoint.Fixture.Plugin.Configuration.StatusTagsEnabled = true;
        endpoint.Fixture.Plugin.Configuration.TMDB_API_KEY = "key";
        var visible = new Series { Id = Guid.NewGuid(), Name = "Visible", ProviderIds = new Dictionary<string, string> { ["Tmdb"] = "100" } };
        var hidden = new Series { Id = Guid.NewGuid(), Name = "Hidden", ProviderIds = new Dictionary<string, string> { ["Tmdb"] = "200" } };
        var noTmdb = new Series { Id = Guid.NewGuid(), Name = "No TMDB" };
        var movie = new MediaBrowser.Controller.Entities.Movies.Movie { Id = Guid.NewGuid(), Name = "Movie", ProviderIds = new Dictionary<string, string> { ["Tmdb"] = "300" } };
        foreach (var item in new BaseItem[] { visible, noTmdb, movie })
        {
            endpoint.Library.Setup(x => x.GetItemById<BaseItem>(item.Id, endpoint.Alice)).Returns(item);
        }
        // Through the user: the hidden series resolves for Bob only.
        endpoint.Library.Setup(x => x.GetItemById<BaseItem>(hidden.Id, endpoint.Bob)).Returns(hidden);

        var ids = string.Join(',', visible.Id.ToString(), hidden.Id.ToString("N"), noTmdb.Id.ToString(), movie.Id.ToString(), "not-a-guid");
        var (result, upstream) = await SeriesLookup(endpoint, endpoint.Alice, ids);
        var payload = Assert.IsType<Dictionary<string, object>>(Assert.IsType<OkObjectResult>(result).Value);
        Assert.Equal([visible.Id.ToString("N")], payload.Keys);
        var json = JsonSerializer.Serialize(payload);
        Assert.Contains("\"type\":\"finale\"", json);
        Assert.Contains("\"status\":\"Ended\"", json);
        Assert.Equal(["/3/tv/100"], upstream);
    }

    [Fact]
    public async Task SeriesLookupNeedsASignedInUserAndAtMostFiftyIds()
    {
        using var endpoint = new Endpoint();
        endpoint.Fixture.Plugin.Configuration.StatusTagsEnabled = true;
        endpoint.Fixture.Plugin.Configuration.TMDB_API_KEY = "key";
        var one = Guid.NewGuid().ToString();
        Assert.IsType<ForbidResult>((await SeriesLookup(endpoint, null, one)).Result);
        Assert.IsType<BadRequestObjectResult>((await SeriesLookup(endpoint, endpoint.Alice, null)).Result);
        Assert.IsType<BadRequestObjectResult>((await SeriesLookup(endpoint, endpoint.Alice, " , ")).Result);
        var fiftyOne = string.Join(',', Enumerable.Range(0, 51).Select(_ => Guid.NewGuid().ToString()));
        Assert.IsType<BadRequestObjectResult>((await SeriesLookup(endpoint, endpoint.Alice, fiftyOne)).Result);
        var fifty = string.Join(',', Enumerable.Range(0, 50).Select(_ => Guid.NewGuid().ToString()));
        Assert.IsType<OkObjectResult>((await SeriesLookup(endpoint, endpoint.Alice, fifty)).Result);
    }

    [Theory]
    [InlineData(false, "key")]
    [InlineData(true, "")]
    public async Task SeriesLookupIsEmptyWithStatusTagsOffOrNoTmdbKey(bool statusTags, string apiKey)
    {
        using var endpoint = new Endpoint();
        endpoint.Fixture.Plugin.Configuration.StatusTagsEnabled = statusTags;
        endpoint.Fixture.Plugin.Configuration.TMDB_API_KEY = apiKey;
        var series = new Series { Id = Guid.NewGuid(), Name = "Show", ProviderIds = new Dictionary<string, string> { ["Tmdb"] = "100" } };
        endpoint.Library.Setup(x => x.GetItemById<BaseItem>(series.Id, endpoint.Alice)).Returns(series);
        var (result, upstream) = await SeriesLookup(endpoint, endpoint.Alice, series.Id.ToString());
        Assert.Empty(Assert.IsType<Dictionary<string, object>>(Assert.IsType<OkObjectResult>(result).Value));
        Assert.Empty(upstream);
    }

    [Fact]
    public async Task GuardedEpisodesAndSeasonsLoseTheAirDatesThePremiereAndFinaleBadgesRead()
    {
        var seasonKey = Guid.NewGuid();
        using var endpoint = new Endpoint(e => new()
        {
            [seasonKey.ToString("N")] = new()
            {
                Type = "Season", SeriesId = e.SeriesId.ToString("N"), DateCreated = 100, LastUpdated = 120, LatestEpisodeAdded = 700,
                LatestEpisodeAired = 900, LatestEpisodeIndex = new() { Season = 3, Episode = 5 }, SeasonPremiere = new() { Season = 3, Aired = 800 },
                SeasonAddedSpan = new() { First = 600, Last = 700, Count = 5 },
            }
        });
        // The seeded episode gets an air date of its own.
        Assert.True(endpoint.Cache.TryGetEntry(endpoint.Episode, out var episodeEntry));
        episodeEntry.PremiereDate = 950;
        endpoint.AliceAccess = [endpoint.First, seasonKey, endpoint.Episode];
        endpoint.GuardSeries();
        var read = await endpoint.Read(endpoint.Alice);
        using var json = JsonDocument.Parse(read.Body);
        var items = json.RootElement.GetProperty("items");
        var season = items.GetProperty(seasonKey.ToString("N"));
        Assert.False(season.TryGetProperty("LatestEpisodeAired", out _));
        Assert.False(season.TryGetProperty("LatestEpisodeIndex", out _));
        Assert.False(season.TryGetProperty("SeasonPremiere", out _));
        Assert.Equal(700, season.GetProperty("LatestEpisodeAdded").GetInt64()); // added dates are not spoilers
        Assert.Equal(5, season.GetProperty("SeasonAddedSpan").GetProperty("Count").GetInt32());
        Assert.False(items.GetProperty(endpoint.Episode.ToString("N")).TryGetProperty("PremiereDate", out _));
    }

    [Fact]
    public void TagDataFallbackSendsTheSameFactsThroughTheUser()
    {
        using var endpoint = new Endpoint();
        var season = new Season { Id = Guid.NewGuid(), Name = "Season 2", IndexNumber = 2, SeriesId = endpoint.SeriesId, DateCreated = new DateTime(2020, 1, 1) };
        Episode Make(int number, DateTime aired, DateTime added) => new()
        {
            Id = Guid.NewGuid(), Name = "E" + number, IndexNumber = number, ParentIndexNumber = 2, PremiereDate = aired, DateCreated = added, SeasonId = season.Id, SeriesId = endpoint.SeriesId,
        };
        var episodes = new[] { Make(1, new DateTime(2026, 10, 1), new DateTime(2026, 10, 20)), Make(2, new DateTime(2026, 10, 8), new DateTime(2026, 10, 21)) };
        var fake = new EpisodeQueryFake(episodes);
        endpoint.Library.Setup(x => x.GetItemById<BaseItem>(season.Id, It.IsAny<User>())).Returns(season);
        // The facts queries (sorted episode queries of the season); the representative-episode scan finds nothing here.
        endpoint.Library.Setup(x => x.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => q.User == endpoint.Alice && q.OrderBy.Count > 0 && !RepresentativeScan(q) ? fake.List(q) : []);
        endpoint.Library.Setup(x => x.GetCount(It.Is<InternalItemsQuery>(q => q.ParentId == season.Id))).Returns((InternalItemsQuery q) => q.User == endpoint.Alice ? fake.Count(q) : 0);
        endpoint.SignIn(endpoint.Alice);
        var ok = Assert.IsType<OkObjectResult>(ApiAssetTests.SiblingOf<JeMediaTagsController>(endpoint.Controller).GetTagData(Guid.Empty, [season.Id.ToString()], latestEpisode: true));
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(ok.Value));
        var items = json.RootElement.GetProperty("Items");
        var seasonItem = items[0];
        Assert.Equal(new DateTimeOffset(2026, 10, 21, 0, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds(), seasonItem.GetProperty("LatestEpisodeAdded").GetInt64());
        Assert.Equal(2, seasonItem.GetProperty("LatestEpisodeIndex").GetProperty("Episode").GetInt32());
        Assert.Equal(2, seasonItem.GetProperty("SeasonPremiere").GetProperty("Season").GetInt32());
        Assert.Equal(2, seasonItem.GetProperty("SeasonAddedSpan").GetProperty("Count").GetInt32());

        // Without the flag nothing is queried for the facts.
        var plain = Assert.IsType<OkObjectResult>(ApiAssetTests.SiblingOf<JeMediaTagsController>(endpoint.Controller).GetTagData(Guid.Empty, [season.Id.ToString()]));
        Assert.DoesNotContain("SeasonAddedSpan\":{", JsonSerializer.Serialize(plain.Value));
    }

    /// <summary>A box set whose members are whatever the test says each user may see (Jellyfin filters them through the user). Named as its kind: Jellyfin reads an item's kind from its type name.</summary>
    private sealed class BoxSet : MediaBrowser.Controller.Entities.Movies.BoxSet
    {
        public Dictionary<Guid, BaseItem[]> Seen { get; } = [];
        public bool Unreadable { get; set; }
        public override IReadOnlyList<BaseItem> GetChildren(User user, bool includeLinkedChildren, InternalItemsQuery? query)
            => Unreadable ? throw new InvalidOperationException("unreadable") : Seen.TryGetValue(user.Id, out var members) ? members : [];
    }

    /// <summary>
    /// Upstream 324b5c92. The fallback gives a collection its newest member's added date ("Just Added" reads it, never
    /// the collection's own date), from the members the asking user can see, and only when the Status renderer asks.
    /// </summary>
    [Fact]
    public void TagDataFallbackGivesACollectionTheNewestMemberTheUserCanSee()
    {
        using var endpoint = new Endpoint();
        long Ms(DateTime date) => new DateTimeOffset(date, TimeSpan.Zero).ToUnixTimeMilliseconds();
        var old = new MediaBrowser.Controller.Entities.Movies.Movie { Id = Guid.NewGuid(), Name = "Old", DateCreated = new DateTime(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc) };
        var arrival = new MediaBrowser.Controller.Entities.Movies.Movie { Id = Guid.NewGuid(), Name = "Arrival", DateCreated = new DateTime(2026, 10, 29, 0, 0, 0, DateTimeKind.Utc) };
        // Kinds that never supply the date: one the tags do not cover, and a collection inside the collection.
        var album = new MediaBrowser.Controller.Entities.Audio.MusicAlbum { Id = Guid.NewGuid(), Name = "Album", DateCreated = new DateTime(2026, 10, 30, 0, 0, 0, DateTimeKind.Utc) };
        var inner = new MediaBrowser.Controller.Entities.Movies.BoxSet { Id = Guid.NewGuid(), Name = "Inner", DateCreated = new DateTime(2026, 10, 30, 0, 0, 0, DateTimeKind.Utc) };
        // Recreated by last night's scan: the collection's own date is the newest of all.
        var box = new BoxSet { Id = Guid.NewGuid(), Name = "Box", DateCreated = new DateTime(2026, 10, 30, 6, 0, 0, DateTimeKind.Utc) };
        box.Seen[endpoint.Alice.Id] = [old, arrival, album, inner];
        box.Seen[endpoint.Bob.Id] = [old, album, inner];
        var empty = new BoxSet { Id = Guid.NewGuid(), Name = "Empty", DateCreated = new DateTime(2026, 10, 30, 6, 0, 0, DateTimeKind.Utc) };
        endpoint.Library.Setup(x => x.GetItemById<BaseItem>(box.Id, It.IsAny<User>())).Returns(box);
        endpoint.Library.Setup(x => x.GetItemById<BaseItem>(empty.Id, It.IsAny<User>())).Returns(empty);
        endpoint.Library.Setup(x => x.GetItemList(It.IsAny<InternalItemsQuery>())).Returns([]);
        JsonElement[] Ask(User user, bool latestEpisode)
        {
            endpoint.SignIn(user);
            var ok = Assert.IsType<OkObjectResult>(ApiAssetTests.SiblingOf<JeMediaTagsController>(endpoint.Controller).GetTagData(Guid.Empty, [box.Id.ToString(), empty.Id.ToString()], latestEpisode: latestEpisode));
            return [.. JsonDocument.Parse(JsonSerializer.Serialize(ok.Value)).RootElement.GetProperty("Items").EnumerateArray()];
        }

        var alice = Ask(endpoint.Alice, true);
        Assert.Equal("BoxSet", alice[0].GetProperty("Type").GetString());
        Assert.Equal(Ms(arrival.DateCreated), alice[0].GetProperty("LatestEpisodeAdded").GetInt64());
        Assert.Equal(Ms(box.DateCreated), alice[0].GetProperty("DateCreated").GetInt64()); // its own date is still sent, as before
        Assert.Equal(JsonValueKind.Null, alice[1].GetProperty("LatestEpisodeAdded").ValueKind); // no member, no date
        // Bob cannot see the arrival: his answer is the older member, not the hidden one.
        Assert.Equal(Ms(old.DateCreated), Ask(endpoint.Bob, true)[0].GetProperty("LatestEpisodeAdded").GetInt64());
        // Without the flag the members are not read.
        Assert.Equal(JsonValueKind.Null, Ask(endpoint.Alice, false)[0].GetProperty("LatestEpisodeAdded").ValueKind);
        // One unreadable collection does not fail the batch: it has no date, and the other item is still answered.
        box.Unreadable = true;
        var afterFailure = Ask(endpoint.Alice, true);
        Assert.Equal(2, afterFailure.Length);
        Assert.Equal(JsonValueKind.Null, afterFailure[0].GetProperty("LatestEpisodeAdded").ValueKind);
    }

    /// <summary>The representative-episode scan (by sort name), which these tests leave empty.</summary>
    private static bool RepresentativeScan(InternalItemsQuery q) => q.OrderBy.Any(o => o.OrderBy == ItemSortBy.SortName);

    [Fact]
    public void TagDataSeriesFactsReadAFewEpisodesNotEveryOne()
    {
        using var endpoint = new Endpoint();
        var series = new Series { Id = endpoint.SeriesId, Name = "Long runner" };
        var episodes = Enumerable.Range(1, 20).SelectMany(s => Enumerable.Range(1, 25).Select(e => new Episode
        {
            Id = Guid.NewGuid(), Name = $"S{s}E{e}", ParentIndexNumber = s, IndexNumber = e, SeriesId = series.Id, SeasonId = Guid.NewGuid(),
            PremiereDate = new DateTime(2000 + s, 1, 1).AddDays(e * 7), DateCreated = new DateTime(2020, 1, 1).AddDays(s * 30 + e),
        })).ToArray();
        var fake = new EpisodeQueryFake(episodes);
        endpoint.Library.Setup(x => x.GetItemById<BaseItem>(series.Id, It.IsAny<User>())).Returns(series);
        endpoint.Library.Setup(x => x.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => q.User == endpoint.Alice && q.ParentId == series.Id && !RepresentativeScan(q) ? fake.List(q) : []);
        endpoint.SignIn(endpoint.Alice);
        var ok = Assert.IsType<OkObjectResult>(ApiAssetTests.SiblingOf<JeMediaTagsController>(endpoint.Controller).GetTagData(Guid.Empty, [series.Id.ToString()], latestEpisode: true));
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(ok.Value));
        var item = json.RootElement.GetProperty("Items")[0];
        Assert.Equal(new DateTimeOffset(2020, 1, 1, 0, 0, 0, TimeSpan.Zero).AddDays(20 * 30 + 25).ToUnixTimeMilliseconds(), item.GetProperty("LatestEpisodeAdded").GetInt64());
        Assert.Equal(20, item.GetProperty("LatestEpisodeIndex").GetProperty("Season").GetInt32());
        Assert.Equal(25, item.GetProperty("LatestEpisodeIndex").GetProperty("Episode").GetInt32());
        Assert.True(item.GetProperty("LatestEpisodeIndex").GetProperty("IsLast").GetBoolean());
        Assert.Equal(20, item.GetProperty("SeasonPremiere").GetProperty("Season").GetInt32());
        // 500 episodes in the series; the facts read one capped page and a few sorted ones.
        Assert.InRange(fake.Materialised, 1, StatusTagsEpisodeLookup.SmallContainer + 40);
    }
}
