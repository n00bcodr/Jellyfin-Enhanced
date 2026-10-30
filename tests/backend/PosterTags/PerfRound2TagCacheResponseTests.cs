using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
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
                SchemaVersion = 14, Version = 9, LastModified = 200,
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
            "tag-cache" => endpoint.Controller.GetTagCache(alice),
            "tag-data" => endpoint.Controller.GetTagData(alice, [item.ToString()]),
            "item-stats" => endpoint.Controller.GetItemStatsByItemId(alice, item),
            "file-size" => endpoint.Controller.GetFileSizeByItemId(alice, item),
            _ => endpoint.Controller.GetWatchProgressByItemId(alice, item),
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
        // tracks count once, untagged ones not at all); streams stay audio/video only.
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
        var ok = Assert.IsType<OkObjectResult>(endpoint.Controller.GetTagData(Guid.Empty, [movie.Id.ToString()]));
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(ok.Value));
        var item = json.RootElement.GetProperty("Items")[0];
        Assert.Equal(["eng", "fre"], item.GetProperty("SubtitleLanguages").EnumerateArray().Select(v => v.GetString()!).ToArray());
        Assert.DoesNotContain(item.GetProperty("MediaStreams").EnumerateArray(), s => s.GetProperty("Type").GetString() == "Subtitle");
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
        var tagData = Assert.IsType<OkObjectResult>(endpoint.Controller.GetTagData(Guid.Empty, [series.Id.ToString()]));
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
        var result = await endpoint.Controller.GetStatusTagsSeries(ids, service);
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
        var episodes = new BaseItem[] { Make(1, new DateTime(2026, 10, 1), new DateTime(2026, 10, 20)), Make(2, new DateTime(2026, 10, 8), new DateTime(2026, 10, 21)) };
        endpoint.Library.Setup(x => x.GetItemById<BaseItem>(season.Id, It.IsAny<User>())).Returns(season);
        endpoint.Library.Setup(x => x.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => q.User == endpoint.Alice && q.Limit == null ? episodes : []); // the facts query; the representative-episode scan pages
        endpoint.SignIn(endpoint.Alice);
        var ok = Assert.IsType<OkObjectResult>(endpoint.Controller.GetTagData(Guid.Empty, [season.Id.ToString()], latestEpisode: true));
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(ok.Value));
        var items = json.RootElement.GetProperty("Items");
        var seasonItem = items[0];
        Assert.Equal(new DateTimeOffset(2026, 10, 21, 0, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds(), seasonItem.GetProperty("LatestEpisodeAdded").GetInt64());
        Assert.Equal(2, seasonItem.GetProperty("LatestEpisodeIndex").GetProperty("Episode").GetInt32());
        Assert.Equal(2, seasonItem.GetProperty("SeasonPremiere").GetProperty("Season").GetInt32());
        Assert.Equal(2, seasonItem.GetProperty("SeasonAddedSpan").GetProperty("Count").GetInt32());

        // Without the flag nothing is queried for the facts.
        var plain = Assert.IsType<OkObjectResult>(endpoint.Controller.GetTagData(Guid.Empty, [season.Id.ToString()]));
        Assert.DoesNotContain("SeasonAddedSpan\":{", JsonSerializer.Serialize(plain.Value));
    }
}
