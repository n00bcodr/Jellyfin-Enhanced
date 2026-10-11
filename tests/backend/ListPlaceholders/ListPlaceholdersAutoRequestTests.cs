using System.Globalization;
using System.Net.Http;
using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.EventHandlers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using static JE.Tests.ListPlaceholdersHarness;

namespace JE.Tests;

// List auto-requests end to end against an in-memory Jellyfin and a synthetic Seerr: trigger, list windows, eligibility,
// the pre-POST status re-check, Seerr's 202/409 answers, dedupe and the request bodies sent as the playing user.
[Collection("Plugin singleton")]
public class ListPlaceholdersAutoRequestTests
{
    private const string Past = "2001-01-01";
    private const string Future = "2999-01-01";

    /// <summary>A synthetic Seerr: users, movie/tv/season details and a request endpoint that records every POST.</summary>
    private sealed class FakeSeerr
    {
        public Dictionary<Guid, (int Id, long Permissions)> Users { get; } = new();
        public Dictionary<int, string> Movies { get; } = new();
        public Dictionary<int, string> Tv { get; } = new();
        public Dictionary<(int, int), string> Seasons { get; } = new();
        public List<(string? User, JsonElement Body)> Posts { get; } = new();
        public List<string> Gets { get; } = new();
        public Func<JsonElement, int> PostStatus { get; set; } = _ => 201;
        public int UserLookups;

        public static string MovieJson(int id, string? releaseDate, int? status = null, string? certification = null) =>
            "{\"id\":" + id + (releaseDate == null ? string.Empty : ",\"releaseDate\":\"" + releaseDate + "\"")
            + (status == null ? string.Empty : ",\"mediaInfo\":{\"mediaType\":\"movie\",\"tmdbId\":" + id + ",\"status\":" + status + ",\"status4k\":1,\"seasons\":[]}")
            + (certification == null ? string.Empty : ",\"releases\":{\"results\":[{\"iso_3166_1\":\"US\",\"release_dates\":[{\"certification\":\"" + certification + "\",\"type\":3}]}]}")
            + "}";

        public static string TvJson(int id, string? firstAirDate, string seasons, string? mediaInfo = null) =>
            "{\"id\":" + id + (firstAirDate == null ? string.Empty : ",\"firstAirDate\":\"" + firstAirDate + "\"")
            + ",\"seasons\":[" + seasons + "]" + (mediaInfo == null ? string.Empty : ",\"mediaInfo\":" + mediaInfo) + "}";

        public HttpResponseMessage Handle(HttpRequestMessage request)
        {
            var path = request.RequestUri!.AbsolutePath;
            if (request.Method == HttpMethod.Post && path == "/api/v1/request")
            {
                var body = JsonDocument.Parse(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult()).RootElement.Clone();
                var user = request.Headers.TryGetValues("X-Api-User", out var values) ? values.Single() : null;
                lock (Posts)
                {
                    Posts.Add((user, body));
                }

                var status = PostStatus(body);
                var mediaType = body.GetProperty("mediaType").GetString();
                var tmdbId = body.GetProperty("mediaId").GetInt32();
                return status switch
                {
                    201 => IntegrationTransport.Response(
                        "{\"id\":900,\"status\":1,\"type\":\"" + mediaType + "\",\"is4k\":false,\"media\":{\"mediaType\":\"" + mediaType + "\",\"tmdbId\":" + tmdbId
                        + ",\"status\":2,\"status4k\":1,\"seasons\":[]},\"seasons\":"
                        + (body.TryGetProperty("seasons", out var s) ? "[{\"seasonNumber\":" + s[0].GetInt32() + ",\"status\":1}]" : "[]") + "}",
                        201),
                    202 => IntegrationTransport.Response("{\"message\":\"No seasons available to request\"}", 202),
                    409 => IntegrationTransport.Response("{\"message\":\"Request for this media already exists.\"}", 409),
                    403 => IntegrationTransport.Response("{\"message\":\"Movie Quota exceeded.\"}", 403),
                    _ => IntegrationTransport.Response("{\"message\":\"boom\"}", status),
                };
            }

            lock (Gets)
            {
                Gets.Add(request.RequestUri.PathAndQuery);
            }

            if (path == "/api/v1/user")
            {
                Interlocked.Increment(ref UserLookups);
                var rows = Users.Select(u => "{\"id\":" + u.Value.Id + ",\"permissions\":" + u.Value.Permissions + ",\"jellyfinUserId\":\"" + u.Key.ToString("N") + "\"}");
                return IntegrationTransport.Response("{\"pageInfo\":{},\"results\":[" + string.Join(',', rows) + "]}");
            }

            if (path is "/api/v1/media" or "/api/v1/request")
            {
                return IntegrationTransport.Response("{\"pageInfo\":{\"pages\":1},\"results\":[]}");
            }

            var parts = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 4 && parts[2] == "movie" && Movies.TryGetValue(int.Parse(parts[3], CultureInfo.InvariantCulture), out var movie))
            {
                return IntegrationTransport.Response(movie);
            }

            if (parts.Length == 4 && parts[2] == "tv" && Tv.TryGetValue(int.Parse(parts[3], CultureInfo.InvariantCulture), out var tv))
            {
                return IntegrationTransport.Response(tv);
            }

            if (parts.Length == 6 && parts[2] == "tv" && parts[4] == "season"
                && Seasons.TryGetValue((int.Parse(parts[3], CultureInfo.InvariantCulture), int.Parse(parts[5], CultureInfo.InvariantCulture)), out var season))
            {
                return IntegrationTransport.Response(season);
            }

            return IntegrationTransport.Response("{\"message\":\"Unable to retrieve movie.\"}", 500);
        }
    }

    private sealed class FakeLibrary : IAutoRequestLibrary
    {
        public Dictionary<Guid, DateTime?> Dates { get; } = new();

        public DateTime? GetPremiereDate(Guid itemId) => Dates.TryGetValue(itemId, out var date) ? date : null;
    }

    private sealed class Fixture : IDisposable
    {
        public ListPlaceholdersHarness H { get; } = new(seerr: true);
        public FakeSeerr Seerr { get; } = new();
        public FakeLibrary Library { get; } = new();
        public SeerrRequestGateway Gateway { get; }
        public ListPlaceholderAutoRequestService Service { get; }
        public User Owner { get; }
        public User Viewer { get; }

        public Fixture(int count = 3, int minutes = 5, bool onlyReleased = true, TimeProvider? time = null)
        {
            var config = H.Plugin.Plugin.Configuration;
            config.ListPlaceholdersAutoRequestEnabled = true;
            config.ListPlaceholdersAutoRequestCount = count;
            config.ListPlaceholdersAutoRequestMinutes = minutes;
            config.ListPlaceholdersAutoRequestOnlyReleased = onlyReleased;
            H.Reply = Seerr.Handle;
            Gateway = new SeerrRequestGateway(H.Transport, H.Plugin.Core.Logger);
            Service = new ListPlaceholderAutoRequestService(H.Store, H.Access, H.Host, Library, Gateway, H.Index, H.Users.Object, H.Plugin.Core.Logger, time ?? TimeProvider.System);
            Owner = H.NewUser("owner");
            Viewer = H.NewUser("viewer");
            Seerr.Users[Owner.Id] = (1, 2);   // ADMIN
            Seerr.Users[Viewer.Id] = (2, 32); // REQUEST
        }

        /// <summary>A public playlist owned by <see cref="Owner"/> with these real items and placeholders, in this order.</summary>
        public FakeListHost.FakeList Playlist(params object[] entries)
        {
            var list = H.Host.AddPlaylist(Owner, openAccess: true);
            Fill(list, entries);
            return list;
        }

        public void Fill(FakeListHost.FakeList list, params object[] entries)
        {
            var doc = new ListDoc { ListId = list.Info.Id.ToString("N"), ListKind = list.Info.Kind };
            var counts = new Dictionary<Guid, int>();
            foreach (var entry in entries)
            {
                if (entry is Guid id)
                {
                    list.Raw.Add(new RawEntry(id, true));
                    counts.TryGetValue(id, out var k);
                    doc.Order.Add(E(id, k));
                    counts[id] = k + 1;
                }
                else
                {
                    var placeholder = (Placeholder)entry;
                    doc.Items.Add(placeholder);
                    doc.Order.Add(P(placeholder.Id));
                }
            }

            if (list.Info.Kind == ListKinds.Collection)
            {
                doc.Order.Clear();
            }

            H.Store.Save(doc);
        }

        public PlayedItem Played(Guid id, BaseItemKind kind = BaseItemKind.Movie, Guid? series = null, Guid? season = null) =>
            new(id, kind, "Played", series, season);

        public List<(string? User, string Key)> PostKeys() =>
            Seerr.Posts.Select(p => (p.User, p.Body.GetProperty("mediaType").GetString() == "tv"
                ? $"tv|{p.Body.GetProperty("mediaId").GetInt32()}|{p.Body.GetProperty("seasons")[0].GetInt32()}"
                : $"movie|{p.Body.GetProperty("mediaId").GetInt32()}")).ToList();

        public void Dispose()
        {
            Service.Dispose();
            H.Dispose();
        }
    }

    private static Placeholder Tv(string kind, int tmdb, int? season = null, string? releaseDate = null, string episodes = "")
    {
        var json = "{\"kind\":\"" + kind + "\",\"tmdbId\":" + tmdb + ",\"title\":\"" + kind + " " + tmdb + "\""
            + (season == null ? string.Empty : ",\"seasonNumber\":" + season)
            + (releaseDate == null ? string.Empty : ",\"releaseDate\":\"" + releaseDate + "\"")
            + (episodes.Length == 0 ? string.Empty : ",\"episodes\":[" + episodes + "]") + "}";
        return Ph(json);
    }

    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = DateTimeOffset.UtcNow;

        public override DateTimeOffset GetUtcNow() => Now;
    }

    private static PlaceholderEpisode Ep(int s, int e, string? airDate) => new() { S = s, E = e, AirDate = airDate };

    private static FilledEpisode Filled(Guid itemId, int s, int e) => new() { ItemId = itemId.ToString("N"), S = s, E = e };

    private static Placeholder Custom(string title) => Ph("{\"kind\":\"custom\",\"title\":\"" + title + "\"}");

    [Fact]
    public async Task PlayingAListItemRequestsTheNextEligiblePlaceholdersAsThePlayingUser()
    {
        using var f = new Fixture(count: 3);
        var played = f.H.Host.AddItem(BaseItemKind.Movie);
        var released = Movie(101, Past);
        var custom = Custom("Rumoured sequel");
        var tba = Movie(102);
        var unreleased = Movie(103, Future);
        var season = Tv("season", 201, season: 2, releaseDate: Past);
        var series = Tv("series", 202, releaseDate: Past);
        var beyond = Movie(104, Past);
        var duplicate = Movie(101, Past);
        var before = Movie(105, Past);
        f.Seerr.Movies[101] = FakeSeerr.MovieJson(101, Past);
        f.Seerr.Movies[102] = FakeSeerr.MovieJson(102, null);
        f.Seerr.Movies[103] = FakeSeerr.MovieJson(103, Future);
        f.Seerr.Movies[104] = FakeSeerr.MovieJson(104, Past);
        f.Seerr.Tv[201] = FakeSeerr.TvJson(201, Past, "{\"seasonNumber\":1,\"airDate\":\"2001-01-01\"},{\"seasonNumber\":2,\"airDate\":\"2002-01-01\"}");
        f.Seerr.Tv[202] = FakeSeerr.TvJson(202, Past, "{\"seasonNumber\":0},{\"seasonNumber\":1,\"airDate\":\"2001-01-01\"}");
        f.Playlist(before, played, custom, released, tba, unreleased, duplicate, season, series, beyond);

        var run = await f.Service.RunAsync(f.Viewer.Id, f.Played(played), CancellationToken.None);

        // Placeholders before the item are ignored; custom/TBA/unreleased are skipped without counting; the same
        // title is requested once; the count stops at 3 (beyond is not requested).
        Assert.Equal(new[] { "movie|101", "tv|201|2", "tv|202|1" }, run.Requested);
        Assert.Equal(new[] { ("2", "movie|101"), ("2", "tv|201|2"), ("2", "tv|202|1") }, f.PostKeys().Select(p => (p.User ?? "-", p.Key)));
        Assert.All(f.Seerr.Posts, p => Assert.False(p.Body.GetProperty("is4k").GetBoolean()));
        Assert.Contains(run.Skipped, s => s.PlaceholderId == custom.Id);
        Assert.Contains(run.Skipped, s => s.PlaceholderId == tba.Id && s.Reason.Contains("TBA", StringComparison.Ordinal));
        Assert.Contains(run.Skipped, s => s.PlaceholderId == unreleased.Id && s.Reason.Contains(Future, StringComparison.Ordinal));
        Assert.Contains(run.Skipped, s => s.PlaceholderId == duplicate.Id);
        Assert.DoesNotContain(f.Seerr.Gets, g => g.EndsWith("/104", StringComparison.Ordinal) || g.EndsWith("/105", StringComparison.Ordinal));
        // Results went into the shared Seerr status index (pending).
        Assert.Equal(2, f.H.Index.Lookup("movie", 101).StatusFor(null));
        Assert.Equal(2, f.H.Index.Lookup("tv", 201).StatusFor(2));
        Assert.Equal(1, f.Seerr.UserLookups);

        // Playing again within 6 h: nothing new is requested for this user.
        var again = await f.Service.RunAsync(f.Viewer.Id, f.Played(played), CancellationToken.None);
        Assert.Equal(new[] { "movie|104" }, again.Requested);
        Assert.Equal(4, f.Seerr.Posts.Count);
    }

    [Fact]
    public async Task OnlyReleasedOffAlsoRequestsUnreleasedAndTbaTitles()
    {
        using var f = new Fixture(count: 5, onlyReleased: false);
        var played = f.H.Host.AddItem();
        var tba = Movie(102);
        var unreleased = Movie(103, Future);
        f.Seerr.Movies[102] = FakeSeerr.MovieJson(102, null);
        f.Seerr.Movies[103] = FakeSeerr.MovieJson(103, Future);
        f.Playlist(played, tba, unreleased, Custom("still skipped"));

        var run = await f.Service.RunAsync(f.Viewer.Id, f.Played(played), CancellationToken.None);

        Assert.Equal(new[] { "movie|102", "movie|103" }, run.Requested);
    }

    [Fact]
    public async Task TheStoredReleaseDatesDecideAndUnreleasedTitlesCostNoSeerrCall()
    {
        using var f = new Fixture(count: 5);
        var played = f.H.Host.AddItem();
        var stillFuture = Movie(101, Future);          // stored: future (Seerr's newer date waits for the metadata refresh)
        var released = Movie(102, Past);               // stored: released
        var tba = Movie(103);                          // stored: TBA
        // Episodes: the metadata service stores the first listed episode's air date as the release date (C4).
        var episodes = Tv("episodes", 301, season: 3, releaseDate: Past, episodes: "{\"s\":3,\"e\":8,\"airDate\":\"" + Past + "\"}");
        f.Seerr.Movies[101] = FakeSeerr.MovieJson(101, Past);
        f.Seerr.Movies[102] = FakeSeerr.MovieJson(102, Future);
        f.Seerr.Movies[103] = FakeSeerr.MovieJson(103, Past);
        f.Seerr.Tv[301] = FakeSeerr.TvJson(301, Past, "{\"seasonNumber\":3,\"airDate\":\"2014-10-07\"}");
        f.Playlist(played, stillFuture, released, tba, episodes);

        var run = await f.Service.RunAsync(f.Viewer.Id, f.Played(played), CancellationToken.None);

        Assert.Equal(new[] { "movie|102", "tv|301|3" }, run.Requested); // episodes → the season they're in
        Assert.Contains(run.Skipped, s => s.PlaceholderId == stillFuture.Id && s.Reason == "not released (" + Future + ")");
        Assert.Contains(run.Skipped, s => s.PlaceholderId == tba.Id && s.Reason == "not released (TBA)");
        // Only the D3 status checks of the candidates that passed the release check reached Seerr.
        Assert.Equal(
            new[] { "/api/v1/movie/102", "/api/v1/tv/301" },
            f.Seerr.Gets.Where(g => g.StartsWith("/api/v1/movie/", StringComparison.Ordinal) || g.StartsWith("/api/v1/tv/", StringComparison.Ordinal)));
    }

    [Fact]
    public async Task APartlyFilledSeasonRequestsItsOwnSeason()
    {
        using var f = new Fixture(count: 1);
        var e1 = f.H.Host.AddItem(BaseItemKind.Episode);
        var e2 = f.H.Host.AddItem(BaseItemKind.Episode);
        var season = Tv("season", 401, season: 2, releaseDate: Past);
        season.Filled = new List<FilledEpisode> { Filled(e1, 2, 1), Filled(e2, 2, 2) };
        f.Seerr.Tv[401] = FakeSeerr.TvJson(401, Past, "{\"seasonNumber\":1,\"episodeCount\":8},{\"seasonNumber\":2,\"episodeCount\":8}");
        f.Playlist(e1, e2, season);

        var run = await f.Service.RunAsync(f.Viewer.Id, f.Played(e2, BaseItemKind.Episode), CancellationToken.None);

        Assert.Equal(new[] { "tv|401|2" }, run.Requested);
    }

    [Fact]
    public async Task ASeriesPlaceholderRequestsSeasonOneHoweverMuchOfItIsInTheList()
    {
        // Review F15 (user request: series placeholder → season 1; Auto Season Requests continues later seasons).
        using var f = new Fixture(count: 5);
        var played = f.H.Host.AddItem(BaseItemKind.Episode);
        var s1e1 = f.H.Host.AddItem(BaseItemKind.Episode);
        var s1e2 = f.H.Host.AddItem(BaseItemKind.Episode);
        // 701: S1 is in the list and S2 has aired episodes missing → still season 1.
        var partly = Tv("series", 701, releaseDate: Past);
        partly.Expected = new List<PlaceholderEpisode> { Ep(1, 1, Past), Ep(1, 2, Past), Ep(2, 1, Past) };
        partly.Filled = new List<FilledEpisode> { Filled(s1e1, 1, 1), Filled(s1e2, 1, 2) };
        // 702: every aired episode is in the list → still season 1 (Seerr's status check decides).
        var caughtUp = Tv("series", 702, releaseDate: Past);
        caughtUp.Expected = new List<PlaceholderEpisode> { Ep(1, 1, Past), Ep(2, 1, Future) };
        caughtUp.Filled = new List<FilledEpisode> { Filled(s1e1, 1, 1) };
        // 703: expected set not known yet, S1 in the list, Seerr lists S2 → still season 1.
        var pending = Tv("series", 703, releaseDate: Past);
        pending.Filled = new List<FilledEpisode> { Filled(s1e1, 1, 1), Filled(s1e2, 1, 2) };
        // 704: no season 1 (year-numbered seasons, known only from Seerr) → the lowest regular season.
        var yearly = Tv("series", 704, releaseDate: Past);
        f.Seerr.Tv[701] = FakeSeerr.TvJson(701, Past, "{\"seasonNumber\":1},{\"seasonNumber\":2}");
        f.Seerr.Tv[702] = FakeSeerr.TvJson(702, Past, "{\"seasonNumber\":1},{\"seasonNumber\":2}");
        f.Seerr.Tv[703] = FakeSeerr.TvJson(703, Past, "{\"seasonNumber\":1,\"episodeCount\":2,\"airDate\":\"2001-01-01\"},{\"seasonNumber\":2,\"episodeCount\":8,\"airDate\":\"2002-01-01\"}");
        f.Seerr.Tv[704] = FakeSeerr.TvJson(704, Past, "{\"seasonNumber\":0},{\"seasonNumber\":2020},{\"seasonNumber\":2019}");
        f.Playlist(played, s1e1, s1e2, partly, caughtUp, pending, yearly);

        var run = await f.Service.RunAsync(f.Viewer.Id, f.Played(played, BaseItemKind.Episode), CancellationToken.None);

        Assert.Equal(new[] { "tv|701|1", "tv|702|1", "tv|703|1", "tv|704|2019" }, run.Requested);
    }

    // A show without a season 1 (year-numbered seasons): a series placeholder requests its lowest regular season.
    private const string Seasons601 =
        "{\"seasonNumber\":0,\"episodeCount\":4,\"airDate\":\"2001-01-01\"},{\"seasonNumber\":2020,\"episodeCount\":2,\"airDate\":\"2020-01-01\"},{\"seasonNumber\":2019,\"episodeCount\":10,\"airDate\":\"2019-01-01\"}";

    [Fact]
    public async Task ASeriesWhoseSeasonComesFromSeerrIsDedupedOnThatSeasonNotTheProvisionalOne()
    {
        // The key "season 1" of the show is handled (Seerr: available) by an S1 placeholder earlier in the same run.
        // Without an expected set the series placeholder's provisional season is S1; its real season, 2019 (the show
        // has no season 1), only comes from the Seerr details and must still be requested.
        using var f = new Fixture(count: 1);
        var played = f.H.Host.AddItem(BaseItemKind.Episode);
        var s1 = Tv("season", 601, 1, Past);
        var series = Tv("series", 601, releaseDate: Past);
        f.Seerr.Tv[601] = FakeSeerr.TvJson(601, Past, Seasons601, "{\"mediaType\":\"tv\",\"tmdbId\":601,\"status\":4,\"seasons\":[{\"seasonNumber\":1,\"status\":5}]}");
        f.Playlist(played, s1, series);

        var run = await f.Service.RunAsync(f.Viewer.Id, f.Played(played, BaseItemKind.Episode), CancellationToken.None);

        Assert.Equal(new[] { "tv|601|2019" }, run.Requested);
        Assert.Contains(run.Skipped, s => s.PlaceholderId == s1.Id && s.Reason.StartsWith("Seerr status 5", StringComparison.Ordinal));

        // Next playback within 6 h: S1 is handled for this user and 2019 was requested — the series is skipped on 2019.
        var again = await f.Service.RunAsync(f.Viewer.Id, f.Played(played, BaseItemKind.Episode), CancellationToken.None);
        Assert.Empty(again.Requested);
        Assert.Contains(again.Skipped, s => s.PlaceholderId == series.Id && s.Reason == "already handled for this user in the last 6 h");
        Assert.Single(f.Seerr.Posts);
    }

    [Fact]
    public async Task ASeriesWhoseSeasonComesFromSeerrIsSkippedOnTheUsersHandledSeasonAfterTheDetails()
    {
        // The user's 6 h window holds S1 only: the series (provisional S1, real 2019) is still requested.
        using var f = new Fixture(count: 1);
        var played = f.H.Host.AddItem(BaseItemKind.Episode);
        var s1 = Tv("season", 601, 1, Past);
        f.Seerr.Tv[601] = FakeSeerr.TvJson(601, Past, Seasons601);
        var list = f.Playlist(played, s1);
        var first = await f.Service.RunAsync(f.Viewer.Id, f.Played(played, BaseItemKind.Episode), CancellationToken.None);
        Assert.Equal(new[] { "tv|601|1" }, first.Requested);

        var series = Tv("series", 601, releaseDate: Past);
        list.Raw.Clear();
        f.Fill(list, played, series);

        var run = await f.Service.RunAsync(f.Viewer.Id, f.Played(played, BaseItemKind.Episode), CancellationToken.None);

        Assert.Equal(new[] { "tv|601|2019" }, run.Requested);
        Assert.Equal(new[] { "tv|601|1", "tv|601|2019" }, f.PostKeys().Select(p => p.Key));
    }

    [Theory]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(6)]
    public async Task ThePrePostStatusCheckSkipsHandledTitlesWithoutCountingThem(int status)
    {
        using var f = new Fixture(count: 1);
        var played = f.H.Host.AddItem();
        f.Seerr.Movies[101] = FakeSeerr.MovieJson(101, Past, status: status);
        f.Seerr.Movies[102] = FakeSeerr.MovieJson(102, Past, status: 7); // deleted → requestable again
        f.Playlist(played, Movie(101, Past), Movie(102, Past));

        var run = await f.Service.RunAsync(f.Viewer.Id, f.Played(played), CancellationToken.None);

        Assert.Equal(new[] { "movie|102" }, run.Requested);
        Assert.Single(f.Seerr.Posts);
        Assert.Equal(status, f.H.Index.Lookup("movie", 101).StatusFor(null)); // the details row refreshed the index
    }

    [Fact]
    public async Task TvSeasonsAreCheckedAtSeasonLevel()
    {
        using var f = new Fixture(count: 5);
        var played = f.H.Host.AddItem(BaseItemKind.Episode);
        f.Seerr.Tv[401] = FakeSeerr.TvJson(
            401,
            Past,
            "{\"seasonNumber\":1,\"airDate\":\"2001-01-01\"},{\"seasonNumber\":2,\"airDate\":\"2002-01-01\"},{\"seasonNumber\":3,\"airDate\":\"2003-01-01\"}",
            "{\"mediaType\":\"tv\",\"tmdbId\":401,\"status\":4,\"seasons\":[{\"seasonNumber\":1,\"status\":5}],\"requests\":[{\"status\":2,\"is4k\":false,\"seasons\":[{\"seasonNumber\":2}]}]}");
        f.Playlist(played, Tv("season", 401, 1, Past), Tv("season", 401, 2, Past), Tv("season", 401, 3, Past));

        var run = await f.Service.RunAsync(f.Viewer.Id, f.Played(played, BaseItemKind.Episode), CancellationToken.None);

        Assert.Equal(new[] { "tv|401|3" }, run.Requested); // S1 available, S2 approved
    }

    [Theory]
    [InlineData(202)]
    [InlineData(409)]
    public async Task SeerrsAlreadyRequestedAnswersDontCount(int answer)
    {
        using var f = new Fixture(count: 1);
        var played = f.H.Host.AddItem();
        f.Seerr.Movies[101] = FakeSeerr.MovieJson(101, Past);
        f.Seerr.Movies[102] = FakeSeerr.MovieJson(102, Past);
        f.Seerr.PostStatus = body => body.GetProperty("mediaId").GetInt32() == 101 ? answer : 201;
        f.Playlist(played, Movie(101, Past), Movie(102, Past));

        var run = await f.Service.RunAsync(f.Viewer.Id, f.Played(played), CancellationToken.None);

        Assert.Equal(new[] { "movie|101" }, run.AlreadyRequested);
        Assert.Equal(new[] { "movie|102" }, run.Requested);
        Assert.Equal(2, f.Seerr.Posts.Count);

        // Already requested counts as handled for this user: no second POST within 6 h.
        await f.Service.RunAsync(f.Viewer.Id, f.Played(played), CancellationToken.None);
        Assert.Equal(2, f.Seerr.Posts.Count);
    }

    [Theory]
    [InlineData(403, "seerr refused")]
    [InlineData(500, "seerr error 500")]
    public async Task ARefusedOrFailedPostStopsTheRunAndIsRetriedNextTime(int answer, string reason)
    {
        using var f = new Fixture(count: 3);
        var played = f.H.Host.AddItem();
        f.Seerr.Movies[101] = FakeSeerr.MovieJson(101, Past);
        f.Seerr.Movies[102] = FakeSeerr.MovieJson(102, Past);
        f.Seerr.PostStatus = _ => answer;
        f.Playlist(played, Movie(101, Past), Movie(102, Past));

        var run = await f.Service.RunAsync(f.Viewer.Id, f.Played(played), CancellationToken.None);
        Assert.Equal(reason, run.StoppedReason);
        Assert.Empty(run.Requested);
        Assert.Single(f.Seerr.Posts);

        f.Seerr.PostStatus = _ => 201;
        var retry = await f.Service.RunAsync(f.Viewer.Id, f.Played(played), CancellationToken.None);
        Assert.Equal(new[] { "movie|101", "movie|102" }, retry.Requested);
    }

    // R4-6: the admin points JE at another Seerr while a run is going (there, the run's Seerr user id may be someone
    // else): nothing more is sent, neither the details read nor the request, and the reservation is released.
    [Theory]
    [InlineData("/api/v1/user")]
    [InlineData("/api/v1/movie/101")]
    public async Task ARunStopsWhenTheSeerrConfigurationChanges(string changedDuring)
    {
        using var f = new Fixture(count: 3);
        var played = f.H.Host.AddItem();
        f.Seerr.Movies[101] = FakeSeerr.MovieJson(101, Past);
        f.Seerr.Movies[102] = FakeSeerr.MovieJson(102, Past);
        f.Playlist(played, Movie(101, Past), Movie(102, Past));
        f.H.Reply = request =>
        {
            if (request.RequestUri!.AbsolutePath == changedDuring)
            {
                f.H.Plugin.Plugin.Configuration.JellyseerrUrls = "http://other-seerr.test";
            }

            return f.Seerr.Handle(request);
        };

        var run = await f.Service.RunAsync(f.Viewer.Id, f.Played(played), CancellationToken.None);
        Assert.Equal("seerr config changed", run.StoppedReason);
        Assert.Empty(f.Seerr.Posts);
        Assert.Empty(run.Requested);
        Assert.Equal(changedDuring == "/api/v1/user" ? 0 : 1, f.Seerr.Gets.Count(g => g.StartsWith("/api/v1/movie/", StringComparison.Ordinal)));

        // The next run resolves the account on the new Seerr and requests both.
        f.H.Reply = f.Seerr.Handle;
        var next = await f.Service.RunAsync(f.Viewer.Id, f.Played(played), CancellationToken.None);
        Assert.Equal(new[] { "movie|101", "movie|102" }, next.Requested);
    }

    // R5-6: the admin adds the user to JE's Seerr import blocklist while a run is going: nothing more is requested as them.
    [Fact]
    public async Task ARunStopsWhenTheUserIsExcludedFromSeerrMidRun()
    {
        using var f = new Fixture(count: 3);
        var played = f.H.Host.AddItem();
        f.Seerr.Movies[101] = FakeSeerr.MovieJson(101, Past);
        f.Seerr.Movies[102] = FakeSeerr.MovieJson(102, Past);
        f.Playlist(played, Movie(101, Past), Movie(102, Past));
        f.H.Reply = request =>
        {
            if (request.RequestUri!.AbsolutePath == "/api/v1/movie/101")
            {
                f.H.Plugin.Plugin.Configuration.JellyseerrImportBlockedUsers = f.Viewer.Id.ToString("D");
            }

            return f.Seerr.Handle(request);
        };

        var run = await f.Service.RunAsync(f.Viewer.Id, f.Played(played), CancellationToken.None);
        Assert.Equal("account blocked", run.StoppedReason);
        Assert.Empty(f.Seerr.Posts);
        Assert.Empty(run.Requested);

        // The next run stops before any Seerr call for a title.
        f.H.Reply = f.Seerr.Handle;
        Assert.Equal("account blocked", (await f.Service.RunAsync(f.Viewer.Id, f.Played(played), CancellationToken.None)).StoppedReason);
    }

    // R5-7: an answer that arrives after the admin switched Seerr is the old Seerr's: its status is not recorded for the
    // new one, nor marked handled for the user, and a request it accepted doesn't refresh the new one's index.
    [Theory]
    [InlineData("GET")]
    [InlineData("POST")]
    public async Task AnAnswerFromTheSeerrConfiguredBeforeIsNotRecordedForTheNewOne(string changedDuring)
    {
        using var f = new Fixture(count: 3);
        var played = f.H.Host.AddItem();
        f.Seerr.Movies[101] = FakeSeerr.MovieJson(101, Past, status: changedDuring == "GET" ? 5 : null);
        f.Seerr.Movies[102] = FakeSeerr.MovieJson(102, Past);
        f.Playlist(played, Movie(101, Past), Movie(102, Past));
        f.H.Reply = request =>
        {
            if (request.Method.Method == changedDuring && request.RequestUri!.AbsolutePath is "/api/v1/movie/101" or "/api/v1/request")
            {
                f.H.Plugin.Plugin.Configuration.JellyseerrUrls = "http://other-seerr.test";
            }

            return f.Seerr.Handle(request);
        };

        var run = await f.Service.RunAsync(f.Viewer.Id, f.Played(played), CancellationToken.None);
        Assert.Equal("seerr config changed", run.StoppedReason);
        Assert.NotEqual(5, f.H.Index.Lookup("movie", 101).StatusFor(null));
        Assert.Equal(changedDuring == "POST" ? 1 : 0, f.Seerr.Posts.Count);
        Assert.DoesNotContain(f.Seerr.Gets, g => g == "/api/v1/movie/102");
        if (changedDuring == "POST")
        {
            Assert.Equal(new[] { "movie|101" }, run.Requested);
            Assert.NotEqual(2, f.H.Index.Lookup("movie", 101).StatusFor(null));
            return;
        }

        // On the new Seerr movie 101 isn't requested: the next run requests it (it was never marked handled).
        f.Seerr.Movies[101] = FakeSeerr.MovieJson(101, Past);
        f.H.Reply = f.Seerr.Handle;
        var next = await f.Service.RunAsync(f.Viewer.Id, f.Played(played), CancellationToken.None);
        Assert.Equal(new[] { "movie|101", "movie|102" }, next.Requested);
    }

    [Fact]
    public async Task RestrictedUsersNeverRequestTitlesTheirParentalControlsHide()
    {
        using var f = new Fixture(count: 3);
        var kid = f.H.NewUser("kid", maxRating: 10);
        f.Seerr.Users[kid.Id] = (3, 32);
        var played = f.H.Host.AddItem();
        f.Seerr.Movies[101] = FakeSeerr.MovieJson(101, Past, certification: "R");
        f.Seerr.Movies[102] = FakeSeerr.MovieJson(102, Past, certification: "G");
        // 103: Seerr can't return its details, so the rating can't be verified → hidden (fail closed).
        f.Playlist(played, Movie(101, Past), Movie(103, Past), Movie(102, Past));

        var run = await f.Service.RunAsync(kid.Id, f.Played(played), CancellationToken.None);

        Assert.Equal(new[] { "movie|102" }, run.Requested);
        Assert.Equal("3", Assert.Single(f.Seerr.Posts).User);
        // Hidden ones are dropped from the kid's projection before the window is taken (A2), so never even considered.
        Assert.Empty(run.Skipped);
    }

    [Fact]
    public async Task UsersWithoutRequestRightsOrSeerrAccountsRequestNothing()
    {
        using var f = new Fixture(count: 3);
        var played = f.H.Host.AddItem();
        f.Seerr.Movies[101] = FakeSeerr.MovieJson(101, Past);
        f.Seerr.Tv[201] = FakeSeerr.TvJson(201, Past, "{\"seasonNumber\":1,\"airDate\":\"2001-01-01\"}");
        f.Playlist(played, Tv("season", 201, 1, Past), Movie(101, Past));

        // Movie-only permission: the season is skipped, the movie requested.
        var movieOnly = f.H.NewUser("movies-only");
        f.Seerr.Users[movieOnly.Id] = (4, 262144); // REQUEST_MOVIE
        var run = await f.Service.RunAsync(movieOnly.Id, f.Played(played), CancellationToken.None);
        Assert.Equal(new[] { "movie|101" }, run.Requested);

        // Not linked to Seerr.
        var stranger = f.H.NewUser("stranger");
        var unlinked = await f.Service.RunAsync(stranger.Id, f.Played(played), CancellationToken.None);
        Assert.Equal("account unlinked", unlinked.StoppedReason);

        // Excluded by JE's import blocklist: no Seerr lookup at all.
        var blocked = f.H.NewUser("blocked");
        f.Seerr.Users[blocked.Id] = (5, 2);
        f.H.Plugin.Plugin.Configuration.JellyseerrImportBlockedUsers = blocked.Id.ToString("D");
        var lookups = f.Seerr.UserLookups;
        var blockedRun = await f.Service.RunAsync(blocked.Id, f.Played(played), CancellationToken.None);
        Assert.Equal("account blocked", blockedRun.StoppedReason);
        Assert.Equal(lookups, f.Seerr.UserLookups);
        Assert.Single(f.Seerr.Posts);
    }

    [Fact]
    public async Task ListsTheUserCantSeeOrWithoutTheItemAreIgnored()
    {
        using var f = new Fixture(count: 3);
        var played = f.H.Host.AddItem();
        f.Seerr.Movies[101] = FakeSeerr.MovieJson(101, Past);
        f.Seerr.Movies[102] = FakeSeerr.MovieJson(102, Past);
        var privateList = f.H.Host.AddPlaylist(f.Owner, openAccess: false);
        f.Fill(privateList, played, Movie(101, Past));
        f.Playlist(f.H.Host.AddItem(), Movie(102, Past)); // doesn't contain the item

        var run = await f.Service.RunAsync(f.Viewer.Id, f.Played(played), CancellationToken.None);
        Assert.Equal("no lists", run.StoppedReason);
        Assert.Empty(f.Seerr.Posts);
        Assert.Equal(0, f.Seerr.UserLookups); // no Seerr traffic when nothing is to be done

        var owner = await f.Service.RunAsync(f.Owner.Id, f.Played(played), CancellationToken.None);
        Assert.Equal(new[] { "movie|101" }, owner.Requested);
        Assert.Equal("1", Assert.Single(f.Seerr.Posts).User);
    }

    [Fact]
    public async Task AcrossListsOwnListsComeFirstAndEachTitleIsRequestedOnce()
    {
        using var f = new Fixture(count: 2);
        var played = f.H.Host.AddItem();
        foreach (var id in new[] { 101, 102, 103 })
        {
            f.Seerr.Movies[id] = FakeSeerr.MovieJson(id, Past);
        }

        var viewersOwn = f.H.Host.AddPlaylist(f.Viewer);
        f.Fill(viewersOwn, played, Movie(102, Past), Movie(101, Past));
        f.Playlist(played, Movie(101, Past), Movie(103, Past)); // saved later (more recent) but not the viewer's

        var run = await f.Service.RunAsync(f.Viewer.Id, f.Played(played), CancellationToken.None);

        Assert.Equal(viewersOwn.Info.Id.ToString("N"), run.Lists[0]);
        Assert.Equal(new[] { "movie|102", "movie|101" }, run.Requested);

        // With room for more, the other list contributes only what is new.
        using var g = new Fixture(count: 5);
        var item = g.H.Host.AddItem();
        foreach (var id in new[] { 101, 102, 103 })
        {
            g.Seerr.Movies[id] = FakeSeerr.MovieJson(id, Past);
        }

        g.Fill(g.H.Host.AddPlaylist(g.Viewer), item, Movie(102, Past), Movie(101, Past));
        g.Playlist(item, Movie(101, Past), Movie(103, Past));
        var all = await g.Service.RunAsync(g.Viewer.Id, g.Played(item), CancellationToken.None);
        Assert.Equal(new[] { "movie|102", "movie|101", "movie|103" }, all.Requested);
        Assert.Equal(3, g.Seerr.Posts.Count);
    }

    [Fact]
    public async Task ACollectionRequestsWhatFollowsTheEpisodesSeriesByDate()
    {
        using var f = new Fixture(count: 1);
        var cars = f.H.Host.AddItem();
        var series = f.H.Host.AddItem(BaseItemKind.Series);
        var episode = f.H.Host.AddItem(BaseItemKind.Episode);
        f.Library.Dates[cars] = new DateTime(2006, 6, 9);
        f.Library.Dates[series] = new DateTime(2022, 9, 8);
        f.Seerr.Movies[101] = FakeSeerr.MovieJson(101, "2013-08-09");
        f.Seerr.Movies[102] = FakeSeerr.MovieJson(102, "2024-01-01");
        var collection = f.H.Host.AddCollection("Cars Collection");
        f.Fill(collection, series, cars, Movie(101, "2013-08-09"), Movie(102, "2024-01-01"));

        // Episode of the series → anchored at the series (2022) → next is 102 (2024), not 101 (2013).
        var run = await f.Service.RunAsync(f.Viewer.Id, f.Played(episode, BaseItemKind.Episode, series: series), CancellationToken.None);
        Assert.Equal(new[] { "movie|102" }, run.Requested);

        // The movie itself (2006) → next by date is 101.
        var movieRun = await f.Service.RunAsync(f.Owner.Id, f.Played(cars), CancellationToken.None);
        Assert.Equal(new[] { "movie|101" }, movieRun.Requested);
    }

    [Fact]
    public async Task ACollectionAnchorsAtThePlayedEpisodeBeforeItsSeries()
    {
        // Review F13: the collection holds both the series (2012) and the played episode (2014). The episode itself is
        // the anchor, so the 2013 movie (before the episode) is not "next"; the 2015 one is.
        using var f = new Fixture(count: 1);
        var series = f.H.Host.AddItem(BaseItemKind.Series);
        var episode = f.H.Host.AddItem(BaseItemKind.Episode);
        var season = Guid.NewGuid(); // not in the collection
        f.Library.Dates[series] = new DateTime(2012, 10, 10);
        f.Library.Dates[episode] = new DateTime(2014, 12, 3);
        f.Seerr.Movies[101] = FakeSeerr.MovieJson(101, "2013-06-01");
        f.Seerr.Movies[102] = FakeSeerr.MovieJson(102, "2015-01-01");
        var collection = f.H.Host.AddCollection("DC");
        f.Fill(collection, series, episode, Movie(101, "2013-06-01"), Movie(102, "2015-01-01"));

        var run = await f.Service.RunAsync(f.Viewer.Id, f.Played(episode, BaseItemKind.Episode, series: series, season: season), CancellationToken.None);

        Assert.Equal(new[] { "movie|102" }, run.Requested);
    }

    [Fact]
    public async Task OnlyFiftyEntriesAfterTheItemAreScanned()
    {
        using var f = new Fixture(count: 1);
        var played = f.H.Host.AddItem();
        var entries = new List<object> { played };
        for (var i = 0; i < 50; i++)
        {
            entries.Add(Custom("Custom " + i));
        }

        entries.Add(Movie(101, Past));
        f.Seerr.Movies[101] = FakeSeerr.MovieJson(101, Past);
        f.Playlist(entries.ToArray());

        var run = await f.Service.RunAsync(f.Viewer.Id, f.Played(played), CancellationToken.None);
        Assert.Empty(run.Requested);
        Assert.Equal(50, run.Skipped.Count);
    }

    [Fact]
    public async Task TheTriggerFiresOncePerSessionAndItemAtTheThreshold()
    {
        using var f = new Fixture(count: 5, minutes: 5);
        var played = f.H.Host.AddItem();
        f.Seerr.Movies[101] = FakeSeerr.MovieJson(101, Past);
        f.Playlist(played, Movie(101, Past));
        var item = f.Played(played);
        var minute = TimeSpan.FromMinutes(1).Ticks;

        Assert.Null(f.Service.OnPlayback(PlaybackPhase.Start, f.Viewer.Id, "s1", item, 0));
        Assert.Null(f.Service.OnPlayback(PlaybackPhase.Progress, f.Viewer.Id, "s1", item, 4 * minute));
        var run = f.Service.OnPlayback(PlaybackPhase.Progress, f.Viewer.Id, "s1", item, 5 * minute);
        Assert.NotNull(run);
        Assert.Equal(new[] { "movie|101" }, (await run!).Requested);
        Assert.Null(f.Service.OnPlayback(PlaybackPhase.Progress, f.Viewer.Id, "s1", item, 6 * minute));
        Assert.Null(f.Service.OnPlayback(PlaybackPhase.Stop, f.Viewer.Id, "s1", item, 7 * minute));

        // Another session triggers again, but the per-user dedupe keeps Seerr from seeing a second POST.
        var other = f.Service.OnPlayback(PlaybackPhase.Stop, f.Viewer.Id, "s2", item, 9 * minute);
        Assert.NotNull(other);
        Assert.Empty((await other!).Requested);
        Assert.Single(f.Seerr.Posts);
    }

    [Fact]
    public async Task AnOngoingPlaybackNeverTriggersTwiceEvenAfterTheTriggerTtl()
    {
        // Review F14: every event of a triggered session + item renews it, so a playback that goes on (or sits
        // paused) past the 6 h TTL doesn't fire again and request the NEXT N titles; only 6 h without any event do.
        var clock = new Clock();
        using var f = new Fixture(count: 1, minutes: 5, time: clock);
        var played = f.H.Host.AddItem();
        f.Seerr.Movies[101] = FakeSeerr.MovieJson(101, Past);
        f.Seerr.Movies[102] = FakeSeerr.MovieJson(102, Past);
        f.Playlist(played, Movie(101, Past), Movie(102, Past));
        var item = f.Played(played);
        var minute = TimeSpan.FromMinutes(1).Ticks;

        var run = f.Service.OnPlayback(PlaybackPhase.Progress, f.Viewer.Id, "s1", item, 5 * minute);
        Assert.Equal(new[] { "movie|101" }, (await run!).Requested);

        clock.Now += TimeSpan.FromHours(5);
        Assert.Null(f.Service.OnPlayback(PlaybackPhase.Progress, f.Viewer.Id, "s1", item, 6 * minute));
        clock.Now += TimeSpan.FromHours(2); // 7 h after the trigger, 2 h after the last event
        Assert.Null(f.Service.OnPlayback(PlaybackPhase.Stop, f.Viewer.Id, "s1", item, 7 * minute));
        Assert.Single(f.Seerr.Posts);

        // 6 h without any event of that session + item: a new viewing triggers again.
        clock.Now += ListPlaceholderAutoRequestService.TriggerTtl;
        Assert.NotNull(f.Service.OnPlayback(PlaybackPhase.Progress, f.Viewer.Id, "s1", item, 5 * minute));
    }

    [Fact]
    public async Task EventsBelowTheThresholdKeepATriggeredPlaybackTriggered()
    {
        // Review R2: a seek back below the threshold followed by a 7 h pause (progress reports every 10 s, all below the
        // threshold) must not let the mark expire, or passing the threshold again starts a second run.
        var clock = new Clock();
        using var f = new Fixture(count: 1, minutes: 5, time: clock);
        var played = f.H.Host.AddItem();
        f.Seerr.Movies[101] = FakeSeerr.MovieJson(101, Past);
        f.Seerr.Movies[102] = FakeSeerr.MovieJson(102, Past);
        f.Playlist(played, Movie(101, Past), Movie(102, Past));
        var item = f.Played(played);
        var minute = TimeSpan.FromMinutes(1).Ticks;

        var run = f.Service.OnPlayback(PlaybackPhase.Progress, f.Viewer.Id, "s1", item, 5 * minute);
        Assert.Equal(new[] { "movie|101" }, (await run!).Requested);

        for (var hour = 1; hour <= 7; hour++)
        {
            clock.Now += TimeSpan.FromHours(1);
            Assert.Null(f.Service.OnPlayback(PlaybackPhase.Progress, f.Viewer.Id, "s1", item, 2 * minute));
        }

        Assert.Null(f.Service.OnPlayback(PlaybackPhase.Progress, f.Viewer.Id, "s1", item, 6 * minute));
        Assert.Single(f.Seerr.Posts);

        // Events below the threshold never create a mark of their own.
        Assert.Null(f.Service.OnPlayback(PlaybackPhase.Progress, f.Viewer.Id, "s2", item, 1 * minute));
        Assert.NotNull(f.Service.OnPlayback(PlaybackPhase.Progress, f.Viewer.Id, "s2", item, 5 * minute));
    }

    [Fact]
    public async Task ZeroMinutesTriggersOnPlaybackStart()
    {
        using var f = new Fixture(count: 1, minutes: 0);
        var played = f.H.Host.AddItem();
        f.Seerr.Movies[101] = FakeSeerr.MovieJson(101, Past);
        f.Playlist(played, Movie(101, Past));

        var run = f.Service.OnPlayback(PlaybackPhase.Start, f.Viewer.Id, "s1", f.Played(played), 0);
        Assert.NotNull(run);
        Assert.Equal(new[] { "movie|101" }, (await run!).Requested);
        Assert.Null(f.Service.OnPlayback(PlaybackPhase.Progress, f.Viewer.Id, "s1", f.Played(played), 10));
    }

    [Theory]
    [InlineData(false, true, true)]
    [InlineData(true, false, true)]
    [InlineData(true, true, false)]
    public async Task WhenAnySwitchIsOffPlaybackDoesNothing(bool master, bool autoRequest, bool seerr)
    {
        using var f = new Fixture(count: 1, minutes: 0);
        var played = f.H.Host.AddItem();
        f.Seerr.Movies[101] = FakeSeerr.MovieJson(101, Past);
        f.Playlist(played, Movie(101, Past));
        var config = f.H.Plugin.Plugin.Configuration;
        config.ListPlaceholdersEnabled = master;
        config.ListPlaceholdersAutoRequestEnabled = autoRequest;
        config.JellyseerrEnabled = seerr;

        Assert.Null(f.Service.OnPlayback(PlaybackPhase.Start, f.Viewer.Id, "s1", f.Played(played), 0));
        Assert.Equal("disabled", (await f.Service.RunAsync(f.Viewer.Id, f.Played(played), CancellationToken.None)).StoppedReason);
        Assert.Equal(0, f.H.Transport.Calls);

        // Turned on later: the next event works without a restart.
        config.ListPlaceholdersEnabled = config.ListPlaceholdersAutoRequestEnabled = config.JellyseerrEnabled = true;
        var run = f.Service.OnPlayback(PlaybackPhase.Start, f.Viewer.Id, "s1", f.Played(played), 0);
        Assert.Equal(new[] { "movie|101" }, (await run!).Requested);
    }

    [Fact]
    public async Task UnreachableSeerrStopsTheRunWithoutPosting()
    {
        using var f = new Fixture(count: 1);
        var played = f.H.Host.AddItem();
        f.Playlist(played, Movie(101, Past));
        f.Seerr.Users[f.Viewer.Id] = (2, 32);
        var lookups = 0;
        f.H.Reply = request =>
        {
            if (request.RequestUri!.AbsolutePath == "/api/v1/user")
            {
                lookups++;
                return f.Seerr.Handle(request);
            }

            throw new HttpRequestException("connection refused");
        };

        var run = await f.Service.RunAsync(f.Viewer.Id, f.Played(played), CancellationToken.None);
        Assert.Equal("seerr unreachable", run.StoppedReason);
        Assert.Equal(1, lookups);
        Assert.Empty(f.Seerr.Posts);
    }

    [Fact]
    public async Task TheGatewayFailsOverOnlyWhenAUrlGivesNoUsableAnswer()
    {
        using var h = new ListPlaceholdersHarness(seerr: true);
        h.Plugin.Plugin.Configuration.JellyseerrUrls = "http://down.test\nhttp://up.test";
        var calls = new List<string>();
        h.Reply = request =>
        {
            calls.Add(request.Method + " " + request.RequestUri!.Host + request.RequestUri.AbsolutePath);
            if (request.RequestUri.Host == "down.test")
            {
                throw new HttpRequestException(HttpRequestError.ConnectionError, "refused");
            }

            return request.Method == HttpMethod.Post
                ? IntegrationTransport.Response("{\"message\":\"Request for this media already exists.\"}", 409)
                : IntegrationTransport.Response("{\"results\":[{\"id\":7,\"permissions\":32,\"jellyfinUserId\":\"" + Guid.Empty.ToString("N") + "\"}]}");
        };
        var gateway = new SeerrRequestGateway(h.Transport, h.Plugin.Core.Logger);

        var account = await gateway.ResolveAccountAsync(Guid.Empty, CancellationToken.None);
        Assert.Equal(new SeerrAccount(SeerrAccountState.Linked, 7, Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr.JellyseerrPermission.REQUEST), account with { Config = null });
        Assert.NotNull(account.Config);
        await gateway.ResolveAccountAsync(Guid.Empty, CancellationToken.None); // cached

        var post = await gateway.PostRequestAsync(7, "{}", CancellationToken.None);
        Assert.True(post.Reached);
        Assert.Equal(409, post.StatusCode);
        // The POST goes to the URL that answered last first (a hanging URL would otherwise block every POST, which
        // can't fail over after a timeout).
        Assert.Equal(
            new[] { "GET down.test/api/v1/user", "GET up.test/api/v1/user", "POST up.test/api/v1/request" },
            calls);

        // A definite 4xx from the first URL is final (no second POST to another URL).
        h.Plugin.Plugin.Configuration.JellyseerrUrls = "http://up.test\nhttp://other.test";
        calls.Clear();
        await gateway.PostRequestAsync(7, "{}", CancellationToken.None);
        Assert.Equal(new[] { "POST up.test/api/v1/request" }, calls);
    }

    [Fact]
    public async Task PlaybackEventsReachTheServiceThroughTheConsumers()
    {
        using var f = new Fixture(count: 1, minutes: 5);
        var played = f.H.Host.AddItem();
        f.Seerr.Movies[101] = FakeSeerr.MovieJson(101, Past);
        f.Playlist(played, Movie(101, Past));
        var movie = new Movie { Id = played, Name = "Played movie" };
        SessionInfo Session() => new(Mock.Of<ISessionManager>(), NullLogger.Instance) { Id = "session-1", UserId = f.Viewer.Id };

        await new ListPlaceholderPlaybackStartConsumer(f.Service).OnEvent(new PlaybackStartEventArgs { Item = movie, Session = Session(), PlaybackPositionTicks = 0 });
        await new ListPlaceholderPlaybackProgressConsumer(f.Service).OnEvent(new PlaybackProgressEventArgs { Item = movie, Session = Session(), PlaybackPositionTicks = TimeSpan.FromMinutes(2).Ticks });
        await Task.Delay(100);
        Assert.Empty(f.Seerr.Posts);

        await new ListPlaceholderPlaybackStopConsumer(f.Service).OnEvent(new PlaybackStopEventArgs { Item = movie, Session = Session(), PlaybackPositionTicks = TimeSpan.FromMinutes(30).Ticks });
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (f.Seerr.Posts.Count == 0 && DateTime.UtcNow < deadline)
        {
            await Task.Delay(20);
        }

        Assert.Equal("movie|101", Assert.Single(f.PostKeys()).Key);
    }

    [Fact]
    public async Task APostMovesToTheNextUrlOnlyWhenItProvablyNeverLeft()
    {
        using var h = new ListPlaceholdersHarness(seerr: true);
        h.Plugin.Plugin.Configuration.JellyseerrUrls = "http://first.test\nhttp://second.test";
        var calls = new List<string>();
        Exception firstFails = new HttpRequestException(HttpRequestError.ConnectionError, "connection refused");
        h.Reply = request =>
        {
            calls.Add(request.Method + " " + request.RequestUri!.Host);
            return request.RequestUri.Host == "first.test"
                ? throw firstFails
                : IntegrationTransport.Response("{\"id\":1}", 201);
        };

        // Connection refused / DNS / TLS setup: nothing was sent, so the next URL gets it.
        var post = await new SeerrRequestGateway(h.Transport, h.Plugin.Core.Logger).PostRequestAsync(7, "{}", CancellationToken.None);
        Assert.True(post.Ok);
        Assert.Equal(new[] { "POST first.test", "POST second.test" }, calls);

        // Timed out, or the connection died mid-request: Seerr may have it, so it is never sent again elsewhere.
        foreach (var failure in new Exception[] { new TaskCanceledException("timed out"), new HttpRequestException(HttpRequestError.ResponseEnded, "dropped") })
        {
            calls.Clear();
            firstFails = failure;
            var result = await new SeerrRequestGateway(h.Transport, h.Plugin.Core.Logger).PostRequestAsync(7, "{}", CancellationToken.None);
            Assert.False(result.Reached);
            Assert.True(result.MaybeSent);
            Assert.Equal(new[] { "POST first.test" }, calls);
        }

        // GETs are idempotent: they still move on after a timeout.
        calls.Clear();
        var get = await new SeerrRequestGateway(h.Transport, h.Plugin.Core.Logger).GetAsync("/api/v1/movie/1", CancellationToken.None);
        Assert.True(get.Ok);
        Assert.Equal(new[] { "GET first.test", "GET second.test" }, calls);
    }

    [Fact]
    public async Task APostWithoutAnAnswerStopsTheRunAndIsNotSentAgain()
    {
        using var f = new Fixture(count: 3);
        var played = f.H.Host.AddItem();
        f.Seerr.Movies[101] = FakeSeerr.MovieJson(101, Past);
        f.Seerr.Movies[102] = FakeSeerr.MovieJson(102, Past);
        f.Playlist(played, Movie(101, Past), Movie(102, Past));
        var posts = 0;
        f.H.Reply = request =>
        {
            if (request.Method == HttpMethod.Post)
            {
                posts++;
                throw new TaskCanceledException("timed out");
            }

            return f.Seerr.Handle(request);
        };

        var run = await f.Service.RunAsync(f.Viewer.Id, f.Played(played), CancellationToken.None);
        Assert.Equal("seerr no answer", run.StoppedReason);
        Assert.Empty(run.Requested);
        Assert.Equal(1, posts);

        // Seerr still shows nothing for 101 (e.g. not saved yet), but this user's reservation holds: 101 is not
        // POSTed again; the run moves on to 102.
        f.H.Reply = f.Seerr.Handle;
        var again = await f.Service.RunAsync(f.Viewer.Id, f.Played(played), CancellationToken.None);
        Assert.Equal(new[] { "movie|102" }, again.Requested);
        Assert.Equal(new[] { "movie|102" }, f.PostKeys().Select(p => p.Key));
    }

    [Fact]
    public async Task OverlappingRunsOfDifferentUsersPostATitleOnce()
    {
        using var f = new Fixture(count: 1);
        var played = f.H.Host.AddItem();
        f.Seerr.Movies[101] = FakeSeerr.MovieJson(101, Past);
        f.Playlist(played, Movie(101, Past));
        using var posting = new ManualResetEventSlim();
        using var otherChecked = new ManualResetEventSlim();
        f.Seerr.PostStatus = _ =>
        {
            posting.Set();
            // Seerr hasn't saved this request yet. Without a per-title lock the other user's run reads the details
            // now, still sees "not requested" and POSTs too.
            otherChecked.Wait(TimeSpan.FromMilliseconds(500));
            f.Seerr.Movies[101] = FakeSeerr.MovieJson(101, Past, status: 2);
            return 201;
        };
        f.H.Reply = request =>
        {
            if (posting.IsSet && request.Method == HttpMethod.Get && request.RequestUri!.AbsolutePath == "/api/v1/movie/101")
            {
                otherChecked.Set();
            }

            return f.Seerr.Handle(request);
        };

        var first = Task.Run(() => f.Service.RunAsync(f.Viewer.Id, f.Played(played), CancellationToken.None));
        Assert.True(posting.Wait(TimeSpan.FromSeconds(10)));
        var second = await f.Service.RunAsync(f.Owner.Id, f.Played(played), CancellationToken.None);

        Assert.Equal(new[] { "movie|101" }, (await first).Requested);
        Assert.Empty(second.Requested);
        Assert.Contains(second.Skipped, s => s.Reason.StartsWith("Seerr status 2", StringComparison.Ordinal));
        Assert.Equal("2", Assert.Single(f.Seerr.Posts).User);
    }

    [Fact]
    public async Task TheTitleLockSerialisesOneTitleOnly()
    {
        var key = SeerrRequestLocks.TitleKey("movie", " 4242 ");
        Assert.Equal(SeerrRequestLocks.TitleKey("movie", 4242), key);
        var held = await SeerrRequestLocks.AcquireAsync(key, CancellationToken.None);
        var waiting = SeerrRequestLocks.AcquireAsync(key, CancellationToken.None);
        await Task.Delay(50);
        Assert.False(waiting.IsCompleted);

        // Another title (or the same id as another media type) is not blocked.
        using (await SeerrRequestLocks.AcquireAsync(SeerrRequestLocks.TitleKey("tv", 4242), CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(5)))
        {
        }

        // A cancelled waiter leaves cleanly; the queue keeps working.
        using var cancel = new CancellationTokenSource();
        var cancelled = SeerrRequestLocks.AcquireAsync(key, cancel.Token);
        cancel.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => cancelled);

        held.Dispose();
        held.Dispose(); // idempotent
        using (await waiting.WaitAsync(TimeSpan.FromSeconds(5)))
        {
        }

        using (await SeerrRequestLocks.AcquireAsync(key, CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(5)))
        {
        }
    }

    [Fact]
    public async Task AnAdminsPlaybackNeverRequestsFromAnotherUsersPrivatePlaylist()
    {
        using var f = new Fixture(count: 3);
        var admin = f.H.NewUser("admin", admin: true);
        f.Seerr.Users[admin.Id] = (9, 2); // Seerr ADMIN: would be auto-approved
        var played = f.H.Host.AddItem();
        f.Seerr.Movies[101] = FakeSeerr.MovieJson(101, Past);
        f.Seerr.Movies[102] = FakeSeerr.MovieJson(102, Past);
        f.Fill(f.H.Host.AddPlaylist(f.Viewer, openAccess: false), played, Movie(101, Past));

        // JE lets admins open and edit any playlist, but requests in the admin's name follow Jellyfin's own rule.
        var run = await f.Service.RunAsync(admin.Id, f.Played(played), CancellationToken.None);
        Assert.Equal("no lists", run.StoppedReason);
        Assert.Empty(f.Seerr.Posts);

        // Shared with the admin (Jellyfin's rule: share), it counts, after the admin's natively editable lists.
        var shared = f.H.Host.AddPlaylist(f.Viewer, openAccess: false, new ListShare(admin.Id, false));
        f.Fill(shared, played, Movie(102, Past));
        var sharedRun = await f.Service.RunAsync(admin.Id, f.Played(played), CancellationToken.None);
        Assert.Equal(new[] { shared.Info.Id.ToString("N") }, sharedRun.Lists);
        Assert.Equal(new[] { "movie|102" }, sharedRun.Requested);
        Assert.Equal("9", Assert.Single(f.Seerr.Posts).User);
    }

    [Fact]
    public async Task AnUnreleasedPlaceholderDoesntBlockAReleasedOneForTheSameSeason()
    {
        using var f = new Fixture(count: 1);
        var played = f.H.Host.AddItem();
        f.Seerr.Tv[201] = FakeSeerr.TvJson(201, Past, "{\"seasonNumber\":1,\"airDate\":\"2001-01-01\"},{\"seasonNumber\":2,\"airDate\":\"2002-01-01\"}");
        f.Seerr.Seasons[(201, 2)] = "{\"seasonNumber\":2,\"episodes\":[{\"episodeNumber\":9,\"airDate\":\"" + Future + "\"}]}";
        var episodes = Tv("episodes", 201, season: 2, episodes: "{\"s\":2,\"e\":9,\"airDate\":\"" + Future + "\"},{\"s\":2,\"e\":10,\"airDate\":\"" + Future + "\"}");
        var season = Tv("season", 201, season: 2, releaseDate: Past);
        f.Playlist(played, episodes, season);

        var run = await f.Service.RunAsync(f.Viewer.Id, f.Played(played), CancellationToken.None);

        // S2E9-E10 haven't aired, but season 2 itself has (C4): the season placeholder requests it.
        Assert.Contains(run.Skipped, s => s.PlaceholderId == episodes.Id && s.Reason.StartsWith("not released", StringComparison.Ordinal));
        Assert.Equal(new[] { "tv|201|2" }, run.Requested);
        Assert.Single(f.Seerr.Posts);
    }

    [Fact]
    public async Task PlaceholdersARestrictedUserCantSeeTakeNoWindowSlot()
    {
        using var f = new Fixture(count: 1);
        var kid = f.H.NewUser("kid", maxRating: 10);
        f.Seerr.Users[kid.Id] = (3, 32);
        var played = f.H.Host.AddItem();
        var entries = new List<object> { played };
        for (var i = 0; i < 60; i++)
        {
            f.Seerr.Movies[500 + i] = FakeSeerr.MovieJson(500 + i, Past, certification: "R");
            entries.Add(Movie(500 + i, Past));
        }

        f.Seerr.Movies[101] = FakeSeerr.MovieJson(101, Past, certification: "G");
        entries.Add(Movie(101, Past));
        f.Playlist(entries.ToArray());

        // In the kid's view of the playlist the G title directly follows the played item (A2 projection).
        var run = await f.Service.RunAsync(kid.Id, f.Played(played), CancellationToken.None);
        Assert.Equal(new[] { "movie|101" }, run.Requested);
        Assert.Empty(run.Skipped);
        Assert.Equal("3", Assert.Single(f.Seerr.Posts).User);

        // An unrestricted user's window is unchanged: 50 entries, the 61st isn't reached.
        var adult = await f.Service.RunAsync(f.Viewer.Id, f.Played(played), CancellationToken.None);
        Assert.Equal(new[] { "movie|500" }, adult.Requested);
    }

    [Fact]
    public void PlayedItemsCarryTheirSeriesAndSeason()
    {
        Guid series = Guid.NewGuid(), season = Guid.NewGuid();
        var episode = PlayedItem.From(new Episode { Id = Guid.NewGuid(), SeriesId = series, SeasonId = season });
        Assert.Equal(BaseItemKind.Episode, episode.Kind);
        Assert.Equal(series, episode.SeriesId);
        Assert.Equal(season, episode.SeasonId);

        var seasonItem = PlayedItem.From(new Season { Id = season, SeriesId = series });
        Assert.Equal(series, seasonItem.SeriesId);
        Assert.Null(seasonItem.SeasonId);

        var movie = PlayedItem.From(new Movie { Id = Guid.NewGuid() });
        Assert.Null(movie.SeriesId);
    }
}
