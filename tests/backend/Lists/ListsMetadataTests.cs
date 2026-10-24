using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using MediaBrowser.Controller.Library;
using Moq;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

// Placeholder metadata from Seerr (C3/C4; ListMetadataService still reads Seerr, so its transport tests apply as they
// were) and the maintenance task (lists switch, then the list maintenance switch).
[Collection("Plugin singleton")]
public class ListsMetadataTests
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
        "{\"episodeNumber\":1,\"seasonNumber\":2,\"showId\":110492,\"airDate\":\"2025-08-21\",\"name\":\"Ep 1\"}]}";

    [Fact]
    public void TvMetadataGivesReleaseDatesExpectedEpisodesAndProductionStatePerKind()
    {
        var season = Ph("{\"kind\":\"season\",\"tmdbId\":110492,\"seasonNumber\":2,\"title\":\"Peacemaker S2\"}");
        var meta = ListMetadataService.FromTv(season, Json(Peacemaker), Json(Season2), Today, Today);
        Assert.Equal("2025-08-21", meta.ReleaseDate);
        Assert.True(meta.InProduction);
        Assert.Equal(391153, meta.TvdbId);
        Assert.Equal("tt13146488", meta.ImdbId);
        Assert.Equal("/s2.jpg", meta.PosterPath);
        // Three episodes are advertised, but only E01 and the next E02 are known: completeness stays unknown.
        Assert.True(meta.Partial);
        Assert.Null(meta.Expected);
        Assert.Null(meta.EpisodeTotal);
        // The announced next episode can close the set when it coherently accounts for every advertised coordinate.
        var coherentShow = Json(Peacemaker.Replace("\"seasonNumber\":2,\"episodeCount\":3", "\"seasonNumber\":2,\"episodeCount\":2", StringComparison.Ordinal));
        var coherent = ListMetadataService.FromTv(season, coherentShow, Json(Season2), Today, Today);
        Assert.False(coherent.Partial);
        Assert.Equal(new[] { (2, 1, "2025-08-21"), (2, 2, "2026-10-23") }, coherent.Expected!.Select(e => (e.S, e.E, e.AirDate!)));
        Assert.Equal(1, coherent.EpisodeTotal);

        var series = Ph("{\"kind\":\"series\",\"tmdbId\":110492,\"title\":\"Peacemaker\"}");
        var whole = ListMetadataService.FromTv(series, Json(Peacemaker), null, Today, Today);
        Assert.Equal("2022-01-13", whole.ReleaseDate);
        // The aggregate has unknown later chronology and an unannounced count-zero season: no positive authority.
        Assert.True(whole.Partial);
        Assert.Null(whole.Expected);
        Assert.Null(whole.EpisodeTotal);

        var episodes = Ph("{\"kind\":\"episodes\",\"tmdbId\":110492,\"seasonNumber\":2,\"title\":\"Peacemaker\",\"episodes\":[{\"s\":2,\"e\":1}]}");
        var listed = ListMetadataService.FromTv(episodes, Json(Peacemaker), Json(Season2), Today, Today);
        Assert.Equal("2025-08-21", listed.ReleaseDate);
        Assert.True(ListMetadataService.Apply(episodes, listed));
        Assert.Equal(("Ep 1", "2025-08-21"), (episodes.Episodes[0].Title, episodes.Episodes[0].AirDate));
        Assert.Empty(episodes.Expected); // only season/series keep an expected set

        var ended = Json(Peacemaker.Replace("\"Returning Series\"", "\"Ended\""));
        Assert.False(ListMetadataService.FromTv(season, ended, Json(Season2), Today, Today).InProduction);
    }

    [Fact]
    public void ApplyMergesAuthoritativeFieldsAndOnlyFillsMissingDisplayFields()
    {
        var movie = Ph("{\"kind\":\"movie\",\"tmdbId\":1239193,\"title\":\"Clayface\",\"posterPath\":\"/mine.jpg\"}");
        var meta = ListMetadataService.FromMovie(
            Json("{\"id\":1239193,\"title\":\"Other title\",\"releaseDate\":\"2026-10-23\",\"posterPath\":\"/theirs.jpg\",\"overview\":\"Mud.\",\"externalIds\":{\"imdbId\":\"tt31227572\"}}"),
            Today);
        Assert.True(ListMetadataService.Apply(movie, meta));
        // The poster is Seerr's for that title, not the client's (review r1 F36).
        Assert.Equal(("Clayface", "2026-10-23", 2026, "/theirs.jpg", "Mud.", "tt31227572"), (movie.Title, movie.ReleaseDate, movie.Year!.Value, movie.PosterPath!, movie.Overview!, movie.ImdbId!));
        Assert.False(ListMetadataService.Apply(movie, meta)); // nothing new

        // TBA in Seerr ("" in a whole answer) wins over a stale client date.
        var tba = ListMetadataService.FromMovie(Json("{\"id\":1239193,\"releaseDate\":\"\",\"posterPath\":null,\"imdbId\":null,\"externalIds\":{\"imdbId\":null}}"), Today);
        Assert.True(ListMetadataService.Apply(movie, tba));
        Assert.Null(movie.ReleaseDate);
        Assert.Equal("tt31227572", movie.ImdbId);
        Assert.Null(tba.PosterPath);

        // Junk values are no values and (review round 8) make the answer partial: nothing it can't vouch for is cleared.
        movie.ReleaseDate = "2026-10-23";
        movie.PosterPath = "/theirs.jpg";
        var junk = ListMetadataService.FromMovie(Json("{\"id\":1239193,\"releaseDate\":\"soon\",\"posterPath\":\"../x.svg\",\"imdbId\":\"tt31227572\",\"externalIds\":{\"imdbId\":\"tt31227572\"}}"), Today);
        Assert.True(junk.Partial);
        Assert.Null(junk.ReleaseDate);
        Assert.Null(junk.PosterPath);
        Assert.False(ListMetadataService.Apply(movie, junk));
        Assert.Equal(("2026-10-23", "/theirs.jpg"), (movie.ReleaseDate, movie.PosterPath));
    }

    [Fact]
    public async Task FetchingIsCachedPerSeerrAndUnknownTitlesAreRememberedBriefly()
    {
        using var h = new ListsHarness(seerr: true);
        h.MovieDetails[10] = "{\"id\":10,\"releaseDate\":\"2010-07-16\",\"posterPath\":null,\"imdbId\":null}"; // a whole answer (round 7: only those are kept)
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
        var meta = ListMetadataService.FromTv(season, Json(Peacemaker), null, Today, Today);
        Assert.True(meta.Partial);
        Assert.Null(meta.Expected);
        Assert.Null(meta.EpisodeTotal);
        Assert.Equal("2025-08-21", meta.ReleaseDate); // from the show's season list
        ListMetadataService.Apply(season, meta);
        Assert.Equal(new[] { 1, 2, 3 }, season.Expected.Select(e => e.E));
        Assert.Equal(1, season.EpisodeTotal);
        Assert.Equal("2025-08-21", season.ReleaseDate);

        // An unknown season (not in the show's list) keeps its stored date too.
        var unknown = Ph("{\"kind\":\"season\",\"tmdbId\":110492,\"seasonNumber\":7,\"title\":\"Peacemaker S7\",\"releaseDate\":\"2028-01-01\"}");
        var none = ListMetadataService.FromTv(unknown, Json(Peacemaker), null, Today, Today);
        Assert.True(none.Partial);
        ListMetadataService.Apply(unknown, none);
        Assert.Equal("2028-01-01", unknown.ReleaseDate);
        Assert.Empty(unknown.Expected);

        // A successful season read is still incomplete when it omits an advertised episode.
        Assert.True(ListMetadataService.FromTv(season, Json(Peacemaker), Json(Season2), Today, Today).Partial);

        // Partial data never says "no longer in production" (the stale expected set could then complete the season);
        // "still in production" is taken.
        var ended = ListMetadataService.FromTv(season, Json(Peacemaker.Replace("\"Returning Series\"", "\"Ended\"", StringComparison.Ordinal)), null, Today, Today);
        Assert.True(ended.Partial);
        Assert.False(ended.InProduction);
        season.InProduction = true;
        ListMetadataService.Apply(season, ended);
        Assert.True(season.InProduction);
        season.InProduction = null;
        ListMetadataService.Apply(season, meta);
        Assert.True(season.InProduction);
    }

    [Fact]
    public void ListedEpisodeAirDatesFollowTmdbWhenItMovesOrUndatesThem()
    {
        var episodes = Ph("{\"kind\":\"episodes\",\"tmdbId\":110492,\"seasonNumber\":2,\"title\":\"Peacemaker\",\"episodes\":[{\"s\":2,\"e\":1,\"airDate\":\"2025-08-01\",\"title\":\"Mine\"},{\"s\":2,\"e\":2,\"airDate\":\"2026-10-10\"}]}");
        var season = "{\"seasonNumber\":2,\"airDate\":\"2025-08-21\",\"posterPath\":null,\"episodes\":[" +
            "{\"episodeNumber\":1,\"seasonNumber\":2,\"showId\":110492,\"airDate\":\"2025-08-21\",\"name\":\"Ep 1\"}," +
            "{\"episodeNumber\":2,\"seasonNumber\":2,\"showId\":110492,\"airDate\":null,\"name\":\"Ep 2\"}]}";
        var meta = ListMetadataService.FromTv(episodes, Json(Peacemaker), Json(season), Today, Today);
        Assert.True(ListMetadataService.Apply(episodes, meta));
        Assert.Equal(("Mine", "2025-08-21"), (episodes.Episodes[0].Title, episodes.Episodes[0].AirDate)); // moved: corrected; title kept
        Assert.Null(episodes.Episodes[1].AirDate); // TBA again: no longer counts as aired
        Assert.Equal(1, PlaceholderProgress.AiredCount(episodes, Today));

        // A failed season read changes nothing.
        var partial = ListMetadataService.FromTv(episodes, Json(Peacemaker), null, Today, Today);
        ListMetadataService.Apply(episodes, partial); // the new uncertainty reason may change; retained display facts do not
        Assert.Equal("2025-08-21", episodes.Episodes[0].AirDate);
        Assert.Null(episodes.Episodes[1].AirDate);
        Assert.False(PlaceholderProgress.IsComplete(episodes, Today));
    }

    [Fact]
    public async Task AFetchEveryCallerGaveUpOnIsCancelledAndADeadSeerrFailsFastAfterwards()
    {
        using var h = new ListsHarness(seerr: true);
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
        h.MovieDetails[1] = "{\"id\":1,\"releaseDate\":\"2001-01-01\",\"posterPath\":null,\"imdbId\":null}";
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
        using var h = new ListsHarness(seerr: true);
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        var tba = Movie(77);
        h.MovieDetails[77] = "{\"id\":77,\"releaseDate\":\"2027-05-01\"}"; // before the add: it reads the poster from Seerr
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { tba, Movie(78) }, null, null, null, CancellationToken.None));
        await h.Consent(access); // D29: the maintenance pass only swaps into lists whose editor turned swap-in on
        var orphan = Guid.NewGuid().ToString("N");
        var orphanDoc = h.Store.LoadForUpdate(orphan, ListKinds.Playlist);
        orphanDoc.Items.Add(Movie(79));
        h.Store.Save(orphanDoc);
        var arrived = h.Host.AddItem(tmdb: 78);

        var lifecycle = new ListLifecycle(new Mock<ILibraryManager>().Object, h.Store, h.Host, h.Plugin.Core.Logger);
        var task = new ListMaintenanceTask(h.Swap, lifecycle, h.Plugin.Core.Logger) { OrphanConfirmDelay = TimeSpan.Zero };
        Assert.Equal("JellyfinEnhancedListMaintenance", task.Key);
        Assert.Contains(task.GetDefaultTriggers(), t => t.Type == MediaBrowser.Model.Tasks.TaskTriggerInfoType.DailyTrigger);

        h.Plugin.Plugin.Configuration.ArrPhase4ListPlaceholdersEnabled = false;
        h.Plugin.Plugin.Configuration.ArrPhase4ListMaintenanceEnabled = true;
        var before = h.SeerrCalls.Count;
        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);
        Assert.Equal(before, h.SeerrCalls.Count);
        Assert.NotNull(h.Store.Load(orphan));
        Assert.Empty(h.Host.Resolved(playlist.Info.Id));

        // Lists on, list maintenance off: deleted lists are cleaned up, nothing is refreshed or swapped in.
        h.Plugin.Plugin.Configuration.ArrPhase4ListPlaceholdersEnabled = true;
        h.Plugin.Plugin.Configuration.ArrPhase4ListMaintenanceEnabled = false;
        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);
        Assert.Null(h.Store.Load(orphan));
        Assert.Equal(before, h.SeerrCalls.Count);
        Assert.Empty(h.Host.Resolved(playlist.Info.Id));

        h.Plugin.Plugin.Configuration.ArrPhase4ListMaintenanceEnabled = true;
        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);
        Assert.Null(h.Store.Load(orphan));
        Assert.Equal(new[] { arrived }, h.Host.Resolved(playlist.Info.Id));
        Assert.Equal("2027-05-01", h.Store.Load(access.ListIdN)!.Items.Single().ReleaseDate);
        lifecycle.Dispose();
    }
}
