using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using static JE.Tests.ListPlaceholdersHarness;
using R = Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.ListPlaceholderAutoRequestRules;

namespace JE.Tests;

// The pure decisions of list auto-requests: trigger, list windows, the requested season, Seerr status, request bodies.
public class ListPlaceholdersAutoRequestRulesTests
{
    private static readonly long Minute = TimeSpan.FromMinutes(1).Ticks;

    [Theory]
    [InlineData(0, PlaybackPhase.Start, 0L, true)]
    [InlineData(0, PlaybackPhase.Progress, 30L, true)] // a missed start: the first event of the session triggers
    [InlineData(0, PlaybackPhase.Start, null, true)]
    [InlineData(5, PlaybackPhase.Start, 0L, false)]
    [InlineData(5, PlaybackPhase.Progress, 4L, false)]
    [InlineData(5, PlaybackPhase.Progress, 5L, true)]
    [InlineData(5, PlaybackPhase.Start, 40L, true)] // resuming past the threshold
    [InlineData(5, PlaybackPhase.Stop, 6L, true)]
    [InlineData(5, PlaybackPhase.Stop, 1L, false)]
    [InlineData(5, PlaybackPhase.Progress, null, false)]
    public void TriggerIsPlaybackStartForZeroMinutesElseThePositionThreshold(int minutes, PlaybackPhase phase, long? positionMinutes, bool expected)
    {
        Assert.Equal(expected, R.ShouldTrigger(phase, positionMinutes * Minute, minutes));
    }

    [Theory]
    [InlineData(-3, 1)]
    [InlineData(0, 1)]
    [InlineData(4, 4)]
    [InlineData(99, 10)]
    public void CountIsClampedToOneThroughTen(int configured, int expected) => Assert.Equal(expected, R.ClampCount(configured));

    [Theory]
    [InlineData(-1, 0)]
    [InlineData(0, 0)]
    [InlineData(45, 45)]
    [InlineData(10_000, 600)]
    public void MinutesAreClampedToZeroThroughSixHundred(int configured, int expected) => Assert.Equal(expected, R.ClampMinutes(configured));

    [Fact]
    public void PlaylistWindowStartsAfterTheFirstCopyAndSkipsRowsTheUserCantSee()
    {
        Guid a = Guid.NewGuid(), b = Guid.NewGuid(), hidden = Guid.NewGuid();
        var order = new List<string> { P("before"), E(a), P("p1"), E(hidden), E(b), P("p2"), E(a, 1), P("p3") };

        Assert.Equal(new[] { "p1", "p2", "p3" }, R.PlaylistWindow(order, a, id => id != hidden));
        // Window of 3 entries after the anchor: p1, b, p2 (the hidden row doesn't count).
        Assert.Equal(new[] { "p1", "p2" }, R.PlaylistWindow(order, a, id => id != hidden, window: 3));
        // A visible row counts: p1, hidden, b with everything visible.
        Assert.Equal(new[] { "p1" }, R.PlaylistWindow(order, a, _ => true, window: 3));
        Assert.Equal(new[] { "p2", "p3" }, R.PlaylistWindow(order, b, _ => true));
        Assert.Null(R.PlaylistWindow(order, Guid.NewGuid(), _ => true));
        Assert.Empty(R.PlaylistWindow(new List<string> { P("x"), E(b) }, b, _ => true)!);
    }

    [Fact]
    public void CollectionWindowMergesRealChildrenAndPlaceholdersByDate()
    {
        Guid cars = Guid.NewGuid(), cars2 = Guid.NewGuid(), series = Guid.NewGuid(), undated = Guid.NewGuid();
        var real = new List<DatedEntry>
        {
            new(cars2, new DateTime(2011, 6, 24)),
            new(undated, null),
            new(cars, new DateTime(2006, 6, 9)),
            new(series, new DateTime(2022, 9, 8)),
        };
        var planes = Ph("{\"kind\":\"movie\",\"tmdbId\":1,\"title\":\"Planes\",\"releaseDate\":\"2013-08-09\"}");
        var sameDay = Ph("{\"kind\":\"movie\",\"tmdbId\":2,\"title\":\"Same Day\",\"releaseDate\":\"2011-06-24\"}");
        var tba = Ph("{\"kind\":\"movie\",\"tmdbId\":3,\"title\":\"Cars 4\"}");
        var early = Ph("{\"kind\":\"movie\",\"tmdbId\":4,\"title\":\"Early\",\"releaseDate\":\"2000-01-01\"}");
        var placeholders = new List<Placeholder> { tba, planes, sameDay, early };

        // Order: early(2000) Cars(2006) Cars2(2011) SameDay(2011, real first) Planes(2013) Series(2022) undated-real Cars4(TBA)
        Assert.Equal(new[] { sameDay.Id, planes.Id, tba.Id }, R.CollectionWindow(real, placeholders, new List<Guid> { cars }));
        Assert.Equal(new[] { sameDay.Id }, R.CollectionWindow(real, placeholders, new List<Guid> { cars }, window: 2));
        // An episode anchors at its series.
        Assert.Equal(new[] { tba.Id }, R.CollectionWindow(real, placeholders, new List<Guid> { Guid.NewGuid(), series }));
        Assert.Null(R.CollectionWindow(real, placeholders, new List<Guid> { Guid.NewGuid() }));
    }

    [Fact]
    public void PlaceholdersHiddenFromTheUserTakeNoWindowSlot()
    {
        Guid a = Guid.NewGuid(), b = Guid.NewGuid();
        var order = new List<string> { E(a), P("r1"), P("r2"), P("r3"), E(b), P("g1"), P("g2") };
        Func<string, bool> shown = id => !id.StartsWith('r');

        // Window of 2: without the filter only r1, r2 fit; in the user's projection (A2) the hidden ones vanish.
        Assert.Equal(new[] { "r1", "r2" }, R.PlaylistWindow(order, a, _ => true, window: 2));
        Assert.Equal(new[] { "g1" }, R.PlaylistWindow(order, a, _ => true, window: 2, placeholderVisible: shown));
        Assert.Equal(new[] { "g1", "g2" }, R.PlaylistWindow(order, a, _ => true, window: 3, placeholderVisible: shown));

        var real = new List<DatedEntry> { new(a, new DateTime(2000, 1, 1)) };
        var hidden1 = Ph("{\"kind\":\"movie\",\"tmdbId\":1,\"title\":\"R1\",\"releaseDate\":\"2001-01-01\"}");
        var hidden2 = Ph("{\"kind\":\"movie\",\"tmdbId\":2,\"title\":\"R2\",\"releaseDate\":\"2002-01-01\"}");
        var visible = Ph("{\"kind\":\"movie\",\"tmdbId\":3,\"title\":\"G\",\"releaseDate\":\"2003-01-01\"}");
        var placeholders = new List<Placeholder> { hidden1, hidden2, visible };
        Assert.Equal(new[] { hidden1.Id }, R.CollectionWindow(real, placeholders, new List<Guid> { a }, window: 1));
        Assert.Equal(new[] { visible.Id }, R.CollectionWindow(real, placeholders, new List<Guid> { a }, window: 1, placeholderVisible: id => id == visible.Id));
    }

    [Fact]
    public void RequestedSeasonFollowsTheKind()
    {
        Assert.Null(R.RequestSeason(Movie(1)));
        Assert.Equal(3, R.RequestSeason(Ph("{\"kind\":\"season\",\"tmdbId\":5,\"title\":\"S\",\"seasonNumber\":3}")));
        Assert.Equal(2, R.RequestSeason(Ph("{\"kind\":\"episodes\",\"tmdbId\":5,\"title\":\"E\",\"seasonNumber\":2,\"episodes\":[{\"s\":2,\"e\":8}]}")));
        var series = Ph("{\"kind\":\"series\",\"tmdbId\":5,\"title\":\"Show\"}");
        Assert.Equal(1, R.RequestSeason(series));
        Assert.Equal(1, R.RequestSeason(series, tvDetails: Json("{\"seasons\":[{\"seasonNumber\":0},{\"seasonNumber\":1},{\"seasonNumber\":2}]}")));
        // No season 1 (year-numbered seasons): the lowest regular season, from Seerr or from the stored expected set.
        Assert.Equal(2019, R.RequestSeason(series, tvDetails: Json("{\"seasons\":[{\"seasonNumber\":0},{\"seasonNumber\":2020},{\"seasonNumber\":2019}]}")));
        Assert.Equal(1, R.RequestSeason(series, tvDetails: Json("{\"seasons\":[]}")));
        series.Expected = new List<PlaceholderEpisode> { Ep(2020, 1, "2020-01-01"), Ep(2019, 1, "2019-01-01") };
        Assert.Equal(2019, R.RequestSeason(series));
    }

    [Fact]
    public void PartlyFilledPlaceholdersRequestTheSeasonThatIsStillMissing()
    {
        // A season (or episodes) placeholder keeps asking for its own season, however much of it is in the list.
        var season = Ph("{\"kind\":\"season\",\"tmdbId\":5,\"title\":\"S2\",\"seasonNumber\":2}");
        season.Filled = new List<FilledEpisode> { Fill(2, 1), Fill(2, 2) };
        Assert.Equal(2, R.RequestSeason(season));
        var episodes = Ph("{\"kind\":\"episodes\",\"tmdbId\":5,\"title\":\"E\",\"seasonNumber\":3,\"episodes\":[{\"s\":3,\"e\":4},{\"s\":3,\"e\":5}]}");
        episodes.Filled = new List<FilledEpisode> { Fill(3, 4) };
        Assert.Equal(3, R.RequestSeason(episodes));
    }

    [Fact]
    public void RequestBodiesAlwaysCarryIs4kFalse()
    {
        using var movie = JsonDocument.Parse(R.BuildRequestBody("movie", 550, null));
        Assert.Equal("movie", movie.RootElement.GetProperty("mediaType").GetString());
        Assert.Equal(550, movie.RootElement.GetProperty("mediaId").GetInt32());
        Assert.False(movie.RootElement.GetProperty("is4k").GetBoolean());
        Assert.False(movie.RootElement.TryGetProperty("seasons", out _));

        using var tv = JsonDocument.Parse(R.BuildRequestBody("tv", 1399, 2));
        Assert.Equal("tv", tv.RootElement.GetProperty("mediaType").GetString());
        Assert.Equal(1399, tv.RootElement.GetProperty("mediaId").GetInt32());
        Assert.Equal(2, Assert.Single(tv.RootElement.GetProperty("seasons").EnumerateArray()).GetInt32());
        Assert.False(tv.RootElement.GetProperty("is4k").GetBoolean());
        Assert.Equal(4, tv.RootElement.EnumerateObject().Count()); // no advanced fields

        Assert.Equal("movie|550", R.RequestKey("movie", 550, null));
        Assert.Equal("tv|1399|2", R.RequestKey("tv", 1399, 2));
    }

    [Theory]
    [InlineData(JellyseerrPermission.REQUEST, "movie", true)]
    [InlineData(JellyseerrPermission.REQUEST, "tv", true)]
    [InlineData(JellyseerrPermission.ADMIN, "tv", true)]
    [InlineData(JellyseerrPermission.REQUEST_MOVIE, "movie", true)]
    [InlineData(JellyseerrPermission.REQUEST_MOVIE, "tv", false)]
    [InlineData(JellyseerrPermission.REQUEST_TV, "tv", true)]
    [InlineData(JellyseerrPermission.REQUEST_TV, "movie", false)]
    [InlineData(JellyseerrPermission.REQUEST_4K, "movie", false)]
    [InlineData(JellyseerrPermission.NONE, "movie", false)]
    public void RequestPermissionMirrorsSeerr(JellyseerrPermission permissions, string mediaType, bool expected) =>
        Assert.Equal(expected, R.CanRequest(permissions, mediaType));

    [Theory]
    [InlineData("{}", 1)]
    [InlineData("{\"mediaInfo\":{\"status\":1}}", 1)]
    [InlineData("{\"mediaInfo\":{\"status\":7}}", 7)]
    [InlineData("{\"mediaInfo\":{\"status\":2}}", 2)]
    [InlineData("{\"mediaInfo\":{\"status\":5}}", 5)]
    [InlineData("{\"mediaInfo\":{\"status\":6}}", 6)]
    [InlineData("{\"mediaInfo\":{\"status\":1,\"requests\":[{\"status\":2,\"is4k\":false}]}}", 3)]
    [InlineData("{\"mediaInfo\":{\"status\":1,\"requests\":[{\"status\":1}]}}", 2)]
    [InlineData("{\"mediaInfo\":{\"status\":1,\"requests\":[{\"status\":3,\"is4k\":false}]}}", 1)] // declined
    [InlineData("{\"mediaInfo\":{\"status\":1,\"requests\":[{\"status\":1,\"is4k\":true}]}}", 1)] // 4K only
    public void MovieStatusComesFromTheMediaRowAndActiveRequests(string details, int expected) =>
        Assert.Equal(expected, R.SeerrStatus(Json(details), "movie", null));

    [Theory]
    [InlineData("{}", 1)]
    [InlineData("{\"mediaInfo\":{\"status\":4,\"seasons\":[{\"seasonNumber\":1,\"status\":5},{\"seasonNumber\":2,\"status\":1}]}}", 1)]
    [InlineData("{\"mediaInfo\":{\"status\":4,\"seasons\":[{\"seasonNumber\":2,\"status\":5}]}}", 5)]
    [InlineData("{\"mediaInfo\":{\"status\":2,\"seasons\":[],\"requests\":[{\"status\":1,\"is4k\":false,\"seasons\":[{\"seasonNumber\":2}]}]}}", 2)]
    [InlineData("{\"mediaInfo\":{\"status\":3,\"seasons\":[],\"requests\":[{\"status\":2,\"seasons\":[{\"seasonNumber\":2}]}]}}", 3)]
    [InlineData("{\"mediaInfo\":{\"status\":2,\"seasons\":[],\"requests\":[{\"status\":1,\"seasons\":[{\"seasonNumber\":1}]}]}}", 1)] // other season
    [InlineData("{\"mediaInfo\":{\"status\":2,\"seasons\":[],\"requests\":[{\"status\":1,\"is4k\":true,\"seasons\":[{\"seasonNumber\":2}]}]}}", 1)]
    [InlineData("{\"mediaInfo\":{\"status\":1,\"seasons\":[],\"requests\":[{\"status\":3,\"seasons\":[{\"seasonNumber\":2}]}]}}", 1)] // declined
    [InlineData("{\"mediaInfo\":{\"status\":6,\"seasons\":[]}}", 6)]
    [InlineData("{\"mediaInfo\":{\"status\":5,\"seasons\":[]}}", 5)] // available, no season rows
    [InlineData("{\"mediaInfo\":{\"status\":4,\"seasons\":[{\"seasonNumber\":2,\"status\":7}]}}", 7)] // deleted → requestable
    public void TvStatusIsSeasonLevel(string details, int expected) =>
        Assert.Equal(expected, R.SeerrStatus(Json(details), "tv", 2));

    [Theory]
    [InlineData(1, false)]
    [InlineData(2, true)]
    [InlineData(3, true)]
    [InlineData(4, true)]
    [InlineData(5, true)]
    [InlineData(6, true)]
    [InlineData(7, false)]
    public void StatusesTwoThroughSixAreAlreadyHandled(int status, bool handled) => Assert.Equal(handled, R.IsHandledStatus(status));

    private static PlaceholderEpisode Ep(int s, int e, string? airDate) => new() { S = s, E = e, AirDate = airDate };

    private static FilledEpisode Fill(int s, int e) => new() { ItemId = Guid.NewGuid().ToString("N"), S = s, E = e };

    private static JsonElement Json(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }
}
