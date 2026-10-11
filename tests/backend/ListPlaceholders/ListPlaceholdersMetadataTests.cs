using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using MediaBrowser.Controller.Library;
using Moq;
using static JE.Tests.ListPlaceholdersHarness;

namespace JE.Tests;

// Placeholder metadata from Seerr (C3/C4) and the maintenance task.
[Collection("Plugin singleton")]
public class ListPlaceholdersMetadataTests
{
    private static readonly DateTime Today = new(2026, 10, 10, 0, 0, 0, DateTimeKind.Utc);

    private static JsonElement Json(string json) => JsonDocument.Parse(json).RootElement.Clone();

    private const string Peacemaker =
        "{\"id\":110492,\"firstAirDate\":\"2022-01-13\",\"status\":\"Returning Series\",\"inProduction\":true,\"posterPath\":\"/show.jpg\",\"overview\":\"Peace.\"," +
        "\"externalIds\":{\"imdbId\":\"tt13146488\",\"tvdbId\":391153}," +
        "\"lastEpisodeToAir\":{\"seasonNumber\":2,\"episodeNumber\":1,\"airDate\":\"2025-08-21\"}," +
        "\"nextEpisodeToAir\":{\"seasonNumber\":2,\"episodeNumber\":2,\"airDate\":\"2026-10-23\"}," +
        "\"seasons\":[{\"seasonNumber\":0,\"episodeCount\":3,\"airDate\":\"2022-11-21\"},{\"seasonNumber\":1,\"episodeCount\":2,\"airDate\":\"2022-01-13\"}," +
        "{\"seasonNumber\":2,\"episodeCount\":3,\"airDate\":\"2025-08-21\"},{\"seasonNumber\":3,\"episodeCount\":0,\"airDate\":null}]}";

    private const string Season2 =
        "{\"seasonNumber\":2,\"airDate\":\"2025-08-21\",\"posterPath\":\"/s2.jpg\",\"episodes\":[" +
        "{\"episodeNumber\":1,\"seasonNumber\":2,\"airDate\":\"2025-08-21\",\"name\":\"Ep 1\"}]}";

    [Fact]
    public void TvMetadataGivesReleaseDatesExpectedEpisodesAndProductionStatePerKind()
    {
        var season = Ph("{\"kind\":\"season\",\"tmdbId\":110492,\"seasonNumber\":2,\"title\":\"Peacemaker S2\"}");
        var meta = ListPlaceholderMetadataService.FromTv(season, Json(Peacemaker), Json(Season2), Today, Today);
        Assert.Equal("2025-08-21", meta.ReleaseDate);
        Assert.True(meta.InProduction);
        Assert.Equal(391153, meta.TvdbId);
        Assert.Equal("tt13146488", meta.ImdbId);
        Assert.Equal("/s2.jpg", meta.PosterPath);
        // The season lists only E01 so far; the announced next episode is expected too (airing season).
        Assert.Equal(new[] { (2, 1, "2025-08-21"), (2, 2, "2026-10-23") }, meta.Expected!.Select(e => (e.S, e.E, e.AirDate!)));
        Assert.Equal(1, meta.EpisodeTotal);

        var series = Ph("{\"kind\":\"series\",\"tmdbId\":110492,\"title\":\"Peacemaker\"}");
        var whole = ListPlaceholderMetadataService.FromTv(series, Json(Peacemaker), null, Today, Today);
        Assert.Equal("2022-01-13", whole.ReleaseDate);
        // Seasons ≥ 1 from the episode counts; aired up to the last aired episode, then the dated next one, then unknown.
        Assert.Equal(
            new[] { (1, 1, true), (1, 2, true), (2, 1, true), (2, 2, false), (2, 3, false) },
            whole.Expected!.Select(e => (e.S, e.E, PlaceholderProgress.IsAired(e, Today))));
        Assert.Equal("2026-10-23", whole.Expected![3].AirDate);
        Assert.Equal(3, whole.EpisodeTotal);

        var episodes = Ph("{\"kind\":\"episodes\",\"tmdbId\":110492,\"seasonNumber\":2,\"title\":\"Peacemaker\",\"episodes\":[{\"s\":2,\"e\":1}]}");
        var listed = ListPlaceholderMetadataService.FromTv(episodes, Json(Peacemaker), Json(Season2), Today, Today);
        Assert.Equal("2025-08-21", listed.ReleaseDate);
        Assert.True(ListPlaceholderMetadataService.Apply(episodes, listed));
        Assert.Equal(("Ep 1", "2025-08-21"), (episodes.Episodes[0].Title, episodes.Episodes[0].AirDate));
        Assert.Empty(episodes.Expected); // only season/series keep an expected set

        var ended = Json(Peacemaker.Replace("\"Returning Series\"", "\"Ended\""));
        Assert.False(ListPlaceholderMetadataService.FromTv(season, ended, Json(Season2), Today, Today).InProduction);
    }

    [Fact]
    public void ApplyMergesAuthoritativeFieldsAndOnlyFillsMissingDisplayFields()
    {
        var movie = Ph("{\"kind\":\"movie\",\"tmdbId\":1239193,\"title\":\"Clayface\",\"posterPath\":\"/mine.jpg\"}");
        var meta = ListPlaceholderMetadataService.FromMovie(
            Json("{\"id\":1239193,\"title\":\"Other title\",\"releaseDate\":\"2026-10-23\",\"posterPath\":\"/theirs.jpg\",\"overview\":\"Mud.\",\"externalIds\":{\"imdbId\":\"tt31227572\"}}"),
            Today);
        Assert.True(ListPlaceholderMetadataService.Apply(movie, meta));
        // The poster is Seerr's for that title, not the client's (review r1 F36).
        Assert.Equal(("Clayface", "2026-10-23", 2026, "/theirs.jpg", "Mud.", "tt31227572"), (movie.Title, movie.ReleaseDate, movie.Year!.Value, movie.PosterPath!, movie.Overview!, movie.ImdbId!));
        Assert.False(ListPlaceholderMetadataService.Apply(movie, meta)); // nothing new

        // TBA in Seerr wins over a stale client date; junk values are dropped.
        var tba = ListPlaceholderMetadataService.FromMovie(Json("{\"releaseDate\":\"\",\"posterPath\":\"../x.svg\",\"imdbId\":\"nope\"}"), Today);
        Assert.True(ListPlaceholderMetadataService.Apply(movie, tba));
        Assert.Null(movie.ReleaseDate);
        Assert.Equal("tt31227572", movie.ImdbId);
        Assert.Null(tba.PosterPath);
    }

    [Fact]
    public async Task FetchingIsCachedPerSeerrAndUnknownTitlesAreRememberedBriefly()
    {
        using var h = new ListPlaceholdersHarness(seerr: true);
        h.MovieDetails[10] = "{\"id\":10,\"releaseDate\":\"2010-07-16\"}";
        var movie = Movie(10);
        Assert.Equal("2010-07-16", (await h.Metadata.FetchAsync(movie, TimeSpan.FromHours(1), Today, CancellationToken.None))!.ReleaseDate);
        await h.Metadata.FetchAsync(movie, TimeSpan.FromHours(1), Today, CancellationToken.None);
        Assert.Single(h.SeerrCalls, c => c.StartsWith("/api/v1/movie/10", StringComparison.Ordinal));
        await h.Metadata.FetchAsync(movie, TimeSpan.Zero, Today, CancellationToken.None);
        Assert.Equal(2, h.SeerrCalls.Count(c => c.StartsWith("/api/v1/movie/10", StringComparison.Ordinal)));

        var unknown = Ph("{\"kind\":\"season\",\"tmdbId\":424242,\"seasonNumber\":1,\"title\":\"Nope\"}");
        Assert.Null(await h.Metadata.FetchAsync(unknown, TimeSpan.Zero, Today, CancellationToken.None));
        Assert.Null(await h.Metadata.FetchAsync(unknown, TimeSpan.Zero, Today, CancellationToken.None));
        Assert.Single(h.SeerrCalls, c => c.StartsWith("/api/v1/tv/424242", StringComparison.Ordinal));

        h.Plugin.Plugin.Configuration.JellyseerrEnabled = false;
        Assert.Null(await h.Metadata.FetchAsync(Movie(11), TimeSpan.Zero, Today, CancellationToken.None));
        Assert.DoesNotContain(h.SeerrCalls, c => c.Contains("/movie/11", StringComparison.Ordinal));
    }

    [Fact]
    public void AFailedSeasonReadKeepsTheStoredExpectedEpisodesAndIsMarkedPartial()
    {
        var season = Ph("{\"kind\":\"season\",\"tmdbId\":110492,\"seasonNumber\":2,\"title\":\"Peacemaker S2\"}");
        season.Expected = new() { new PlaceholderEpisode { S = 2, E = 1, AirDate = "2025-08-21" }, new PlaceholderEpisode { S = 2, E = 2, AirDate = "2026-10-23" }, new PlaceholderEpisode { S = 2, E = 3 } };
        season.EpisodeTotal = 1;
        season.ReleaseDate = "2025-08-21";

        // /tv/{id} answered, /tv/{id}/season/2 didn't: the show's next episode alone must not become the expected set.
        var meta = ListPlaceholderMetadataService.FromTv(season, Json(Peacemaker), null, Today, Today);
        Assert.True(meta.Partial);
        Assert.Null(meta.Expected);
        Assert.Null(meta.EpisodeTotal);
        Assert.Equal("2025-08-21", meta.ReleaseDate); // from the show's season list
        ListPlaceholderMetadataService.Apply(season, meta);
        Assert.Equal(new[] { 1, 2, 3 }, season.Expected.Select(e => e.E));
        Assert.Equal(1, season.EpisodeTotal);
        Assert.Equal("2025-08-21", season.ReleaseDate);

        // An unknown season (not in the show's list) keeps its stored date too.
        var unknown = Ph("{\"kind\":\"season\",\"tmdbId\":110492,\"seasonNumber\":7,\"title\":\"Peacemaker S7\",\"releaseDate\":\"2028-01-01\"}");
        var none = ListPlaceholderMetadataService.FromTv(unknown, Json(Peacemaker), null, Today, Today);
        Assert.True(none.Partial);
        ListPlaceholderMetadataService.Apply(unknown, none);
        Assert.Equal("2028-01-01", unknown.ReleaseDate);
        Assert.Empty(unknown.Expected);

        // With the season details, the data is complete.
        Assert.False(ListPlaceholderMetadataService.FromTv(season, Json(Peacemaker), Json(Season2), Today, Today).Partial);

        // Partial data never says "no longer in production" (the stale expected set could then complete the season);
        // "still in production" is taken.
        var ended = ListPlaceholderMetadataService.FromTv(season, Json(Peacemaker.Replace("\"Returning Series\"", "\"Ended\"", StringComparison.Ordinal)), null, Today, Today);
        Assert.True(ended.Partial);
        Assert.False(ended.InProduction);
        season.InProduction = true;
        ListPlaceholderMetadataService.Apply(season, ended);
        Assert.True(season.InProduction);
        season.InProduction = null;
        ListPlaceholderMetadataService.Apply(season, meta);
        Assert.True(season.InProduction);
    }

    [Fact]
    public void ListedEpisodeAirDatesFollowTmdbWhenItMovesOrUndatesThem()
    {
        var episodes = Ph("{\"kind\":\"episodes\",\"tmdbId\":110492,\"seasonNumber\":2,\"title\":\"Peacemaker\",\"episodes\":[{\"s\":2,\"e\":1,\"airDate\":\"2025-08-01\",\"title\":\"Mine\"},{\"s\":2,\"e\":2,\"airDate\":\"2026-10-10\"}]}");
        var season = "{\"seasonNumber\":2,\"airDate\":\"2025-08-21\",\"episodes\":[" +
            "{\"episodeNumber\":1,\"seasonNumber\":2,\"airDate\":\"2025-08-21\",\"name\":\"Ep 1\"}," +
            "{\"episodeNumber\":2,\"seasonNumber\":2,\"airDate\":null,\"name\":\"Ep 2\"}]}";
        var meta = ListPlaceholderMetadataService.FromTv(episodes, Json(Peacemaker), Json(season), Today, Today);
        Assert.True(ListPlaceholderMetadataService.Apply(episodes, meta));
        Assert.Equal(("Mine", "2025-08-21"), (episodes.Episodes[0].Title, episodes.Episodes[0].AirDate)); // moved: corrected; title kept
        Assert.Null(episodes.Episodes[1].AirDate); // TBA again: no longer counts as aired
        Assert.Equal(1, PlaceholderProgress.AiredCount(episodes, Today));

        // A failed season read changes nothing.
        var partial = ListPlaceholderMetadataService.FromTv(episodes, Json(Peacemaker), null, Today, Today);
        Assert.False(ListPlaceholderMetadataService.Apply(episodes, partial));
    }

    [Fact]
    public async Task AFetchEveryCallerGaveUpOnIsCancelledAndADeadSeerrFailsFastAfterwards()
    {
        using var h = new ListPlaceholdersHarness(seerr: true);
        var hanging = 0;
        h.ReplyAsync = async (_, ct) =>
        {
            Interlocked.Increment(ref hanging);
            try
            {
                await Task.Delay(Timeout.Infinite, ct);
                return IntegrationTransport.Response();
            }
            finally
            {
                Interlocked.Decrement(ref hanging);
            }
        };

        // A maintenance-sized burst against a Seerr that accepts connections but never answers, then cancelled.
        using var cts = new CancellationTokenSource();
        var reads = Enumerable.Range(1, 12).Select(i => h.Metadata.FetchAsync(Movie(i), TimeSpan.FromHours(1), Today, cts.Token)).ToList();
        for (var i = 0; i < 200 && Volatile.Read(ref hanging) < 4; i++)
        {
            await Task.Delay(10);
        }

        Assert.Equal(4, Volatile.Read(ref hanging)); // the global limit
        cts.Cancel();
        foreach (var read in reads)
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => read);
        }

        // Nobody waits for them any more: the hung requests are cancelled and the queued ones never start.
        for (var i = 0; i < 200 && Volatile.Read(ref hanging) > 0; i++)
        {
            await Task.Delay(10);
        }

        Assert.Equal(0, Volatile.Read(ref hanging));

        // A later read isn't stuck behind the abandoned burst.
        h.ReplyAsync = null;
        h.MovieDetails[1] = "{\"id\":1,\"releaseDate\":\"2001-01-01\"}";
        var fresh = await h.Metadata.FetchAsync(Movie(1), TimeSpan.FromHours(1), Today, CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("2001-01-01", fresh!.ReleaseDate);

        // A Seerr that times out pauses reads briefly instead of costing the full timeout per path.
        h.Metadata.Timeout = TimeSpan.FromMilliseconds(100);
        h.ReplyAsync = async (_, ct) =>
        {
            await Task.Delay(Timeout.Infinite, ct);
            return IntegrationTransport.Response();
        };
        Assert.Null(await h.Metadata.FetchAsync(Movie(30), TimeSpan.FromHours(1), Today, CancellationToken.None));
        var calls = h.SeerrCalls.Count;
        Assert.Null(await h.Metadata.FetchAsync(Movie(31), TimeSpan.FromHours(1), Today, CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(1)));
        Assert.Equal(calls, h.SeerrCalls.Count);
        Assert.Equal("2001-01-01", (await h.Metadata.FetchAsync(Movie(1), TimeSpan.FromHours(1), Today, CancellationToken.None))!.ReleaseDate); // the cache still answers
    }

    [Fact]
    public async Task MaintenanceIsANoOpWhileDisabledAndOtherwiseCleansUpRefreshesAndSwaps()
    {
        using var h = new ListPlaceholdersHarness(seerr: true);
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        var tba = Movie(77);
        h.MovieDetails[77] = "{\"id\":77,\"releaseDate\":\"2027-05-01\"}"; // before the add: it reads the poster from Seerr
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { tba, Movie(78) }, null, null, null, CancellationToken.None));
        var orphan = Guid.NewGuid().ToString("N");
        var orphanDoc = h.Store.LoadForUpdate(orphan, ListKinds.Playlist);
        orphanDoc.Items.Add(Movie(79));
        h.Store.Save(orphanDoc);
        var arrived = h.Host.AddItem(tmdb: 78);

        var lifecycle = new ListPlaceholderLifecycle(new Mock<ILibraryManager>().Object, h.Store, h.Host, h.Plugin.Core.Logger);
        var task = new ListPlaceholdersMaintenanceTask(h.Swap, lifecycle, h.Plugin.Core.Logger) { OrphanConfirmDelay = TimeSpan.Zero };
        Assert.Equal("JellyfinEnhancedListPlaceholdersMaintenance", task.Key);
        Assert.Contains(task.GetDefaultTriggers(), t => t.Type == MediaBrowser.Model.Tasks.TaskTriggerInfoType.DailyTrigger);

        h.Plugin.Plugin.Configuration.ListPlaceholdersEnabled = false;
        var before = h.SeerrCalls.Count;
        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);
        Assert.Equal(before, h.SeerrCalls.Count);
        Assert.NotNull(h.Store.Load(orphan));
        Assert.Empty(h.Host.Resolved(playlist.Info.Id));

        h.Plugin.Plugin.Configuration.ListPlaceholdersEnabled = true;
        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);
        Assert.Null(h.Store.Load(orphan));
        Assert.Equal(new[] { arrived }, h.Host.Resolved(playlist.Info.Id));
        Assert.Equal("2027-05-01", h.Store.Load(access.ListIdN)!.Items.Single().ReleaseDate);
        lifecycle.Dispose();
    }
}
