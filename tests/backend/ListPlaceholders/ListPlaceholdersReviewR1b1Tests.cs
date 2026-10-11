using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using static JE.Tests.ListPlaceholdersHarness;

namespace JE.Tests;

// Review round 1 (b1): production state, the series aired watermark and the episodes release date (C3/C4).
[Collection("Plugin singleton")]
public class ListPlaceholdersReviewR1b1Tests
{
    private static readonly CancellationToken None = CancellationToken.None;
    private static readonly DateTime Today = new(2026, 10, 10, 0, 0, 0, DateTimeKind.Utc);
    private const string Past = "2020-01-01";
    private const string Future = "2099-01-01";

    private static JsonElement Json(string json) => JsonDocument.Parse(json).RootElement.Clone();

    private static string Episode(int s, int e, string? airDate) =>
        $"{{\"seasonNumber\":{s},\"episodeNumber\":{e},\"airDate\":{(airDate == null ? "null" : "\"" + airDate + "\"")}}}";

    // A show with S0 (specials), S1 and S2 of two episodes each, plus an optional undated S3.
    private static string Show(int tmdb, string status, bool inProduction, string? last, string? next, bool announcedS3 = false) =>
        $"{{\"id\":{tmdb},\"name\":\"Show\",\"firstAirDate\":\"{Past}\",\"status\":\"{status}\",\"inProduction\":{(inProduction ? "true" : "false")}," +
        $"\"lastEpisodeToAir\":{last ?? "null"},\"nextEpisodeToAir\":{next ?? "null"}," +
        $"\"seasons\":[{{\"seasonNumber\":0,\"episodeCount\":4,\"airDate\":\"{Past}\"}},{{\"seasonNumber\":1,\"episodeCount\":2,\"airDate\":\"{Past}\"}}," +
        $"{{\"seasonNumber\":2,\"episodeCount\":2,\"airDate\":\"2021-01-01\"}}" +
        (announcedS3 ? ",{\"seasonNumber\":3,\"episodeCount\":2,\"airDate\":null}" : string.Empty) + "]}";

    private static void Fill(Placeholder placeholder, params (int S, int E)[] coords) =>
        placeholder.Filled.AddRange(coords.Select(c => new FilledEpisode { ItemId = Guid.NewGuid().ToString("N"), S = c.S, E = c.E }));

    // ── F6: only a terminal status means "finished" ──────────────────────

    [Fact]
    public void AReturningSeriesThatTmdbFlagsAsNotInProductionIsNotFinished()
    {
        // TMDB often has inProduction:false between seasons of a renewed show: S2 is announced, not aired.
        var tv = Json(Show(900, "Returning Series", inProduction: false, last: Episode(1, 2, Past), next: Episode(2, 1, Future)));
        var series = Ph("{\"kind\":\"series\",\"tmdbId\":900,\"title\":\"Show\"}");
        var meta = ListPlaceholderMetadataService.FromTv(series, tv, null, Today, Today);
        Assert.True(meta.InProduction);
        ListPlaceholderMetadataService.Apply(series, meta);
        Fill(series, (1, 1), (1, 2));
        Assert.False(PlaceholderProgress.IsComplete(series, Today)); // S2 still has to swap in

        // A season still airing (a dated future episode) isn't finished either.
        var season = Ph("{\"kind\":\"season\",\"tmdbId\":900,\"seasonNumber\":2,\"title\":\"Show S2\"}");
        var details = Json("{\"seasonNumber\":2,\"airDate\":\"2021-01-01\",\"episodes\":[" + Episode(2, 1, Past) + "," + Episode(2, 2, Future) + "]}");
        var airing = Json(Show(900, "Returning Series", inProduction: false, last: Episode(2, 1, Past), next: Episode(2, 2, Future)));
        ListPlaceholderMetadataService.Apply(season, ListPlaceholderMetadataService.FromTv(season, airing, details, Today, Today));
        Assert.True(season.InProduction);
        Fill(season, (2, 1));
        Assert.False(PlaceholderProgress.IsComplete(season, Today));

        // Without a status, TMDB's flag alone doesn't make it finished; Ended/Canceled do, whatever the flag says.
        Assert.True(ListPlaceholderMetadataService.FromTv(series, Json("{\"id\":900,\"inProduction\":false,\"seasons\":[]}"), null, Today, Today).InProduction);
        Assert.False(ListPlaceholderMetadataService.FromTv(series, Json(Show(900, "Ended", inProduction: true, Episode(2, 2, Past), null)), null, Today, Today).InProduction);
        Assert.False(ListPlaceholderMetadataService.FromTv(series, Json(Show(900, "Canceled", inProduction: false, Episode(2, 2, Past), null)), null, Today, Today).InProduction);
        Assert.Null(ListPlaceholderMetadataService.FromTv(series, Json("{\"id\":900,\"seasons\":[]}"), null, Today, Today).InProduction);
    }

    [Fact]
    public async Task ARenewedShowsSeriesPlaceholderStaysInAPlaylistAfterItsAiredEpisodesArrive()
    {
        using var h = new ListPlaceholdersHarness(seerr: true);
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        h.TvDetails[901] = Show(901, "Returning Series", inProduction: false, last: Episode(2, 2, Past), next: null, announcedS3: true);
        var series = Ph("{\"kind\":\"series\",\"tmdbId\":901,\"title\":\"Show\"}");
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { series }, null, null, null, None));
        await h.Swap.DrainAsync(None);

        var show = h.Host.AddSeries(tmdb: 901);
        foreach (var (s, e) in new[] { (1, 1), (1, 2), (2, 1), (2, 2) })
        {
            h.Swap.NotifyItemChanged(h.Host.AddEpisode(show, s, e));
        }

        await h.Swap.DrainAsync(None);
        var stored = h.Store.Load(access.ListIdN)!.Items.Single(p => p.Id == series.Id);
        Assert.Equal(4, stored.Filled.Count);
        Assert.True(stored.InProduction); // S3 is announced: the placeholder waits for it
    }

    [Fact]
    public async Task AStoredEndedStateIsConfirmedByFreshMetadataBeforeASeasonOrSeriesIsRetired()
    {
        using var h = new ListPlaceholdersHarness(seerr: true);
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        h.TvDetails[902] = Show(902, "Returning Series", inProduction: true, last: Episode(1, 2, Past), next: Episode(2, 1, Future));
        var series = Ph("{\"kind\":\"series\",\"tmdbId\":902,\"title\":\"Show\"}");
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { series }, null, null, null, None));
        await h.Swap.DrainAsync(None);
        var show = h.Host.AddSeries(tmdb: 902);
        h.Swap.NotifyItemChanged(h.Host.AddEpisode(show, 1, 1));
        h.Swap.NotifyItemChanged(h.Host.AddEpisode(show, 1, 2));
        await h.Swap.DrainAsync(None);
        Assert.Equal(2, h.Store.Load(access.ListIdN)!.Items.Single(p => p.Id == series.Id).Filled.Count);

        // The stored state says "no longer in production" (an older reading, or a show TMDB has revived since): a pass
        // without metadata must not retire on it while Seerr can be asked.
        using (await h.Store.LockAsync(access.ListIdN))
        {
            var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
            doc.Items.Single(p => p.Id == series.Id).InProduction = false;
            h.Store.Save(doc);
        }

        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        await h.Swap.DrainAsync(None);
        var stored = h.Store.Load(access.ListIdN)!.Items.Single(p => p.Id == series.Id);
        Assert.True(stored.InProduction); // the follow-up re-read Seerr: S2 is still to come
        Assert.Equal(2, stored.Filled.Count);
    }

    // ── F7: specials never move the aired watermark of the regular seasons ──

    [Fact]
    public void AnEndedShowWhoseLastAiredEpisodeIsASpecialCompletesOnceEveryRegularEpisodeIsIn()
    {
        var tv = Json(Show(903, "Ended", inProduction: false, last: Episode(0, 4, "2022-12-25"), next: null));
        var series = Ph("{\"kind\":\"series\",\"tmdbId\":903,\"title\":\"Show\"}");
        var meta = ListPlaceholderMetadataService.FromTv(series, tv, null, Today, Today);
        Assert.Equal(new[] { (1, 1), (1, 2), (2, 1), (2, 2) }, meta.Expected!.Select(e => (e.S, e.E)));
        Assert.All(meta.Expected!, e => Assert.True(PlaceholderProgress.IsAired(e, Today)));
        Assert.Equal(4, meta.EpisodeTotal);

        ListPlaceholderMetadataService.Apply(series, meta);
        Fill(series, (1, 1), (1, 2), (2, 1));
        Assert.False(PlaceholderProgress.IsComplete(series, Today));
        Fill(series, (2, 2));
        Assert.False(PlaceholderProgress.HasUnexpectedFills(series, Today)); // no forced Seerr reads
        Assert.True(PlaceholderProgress.IsComplete(series, Today));
    }

    [Fact]
    public void AnAiringShowWhoseLastAiredEpisodeIsASpecialCountsTheRegularEpisodesThatAired()
    {
        var series = Ph("{\"kind\":\"series\",\"tmdbId\":904,\"title\":\"Show\"}");

        // A holiday special aired; the next regular episode is S2E2.
        var tv = Json(Show(904, "Returning Series", inProduction: true, last: Episode(0, 4, "2022-12-25"), next: Episode(2, 2, Future)));
        var meta = ListPlaceholderMetadataService.FromTv(series, tv, null, Today, Today);
        Assert.Equal(
            new[] { (1, 1, true), (1, 2, true), (2, 1, true), (2, 2, false) },
            meta.Expected!.Select(e => (e.S, e.E, PlaceholderProgress.IsAired(e, Today))));
        Assert.Equal(Future, meta.Expected![3].AirDate);
        Assert.Equal(3, meta.EpisodeTotal);

        // Between seasons (S3 announced without dates): the seasons that have started have aired, S3 hasn't.
        var between = Json(Show(904, "Returning Series", inProduction: true, last: Episode(0, 4, "2022-12-25"), next: null, announcedS3: true));
        var later = ListPlaceholderMetadataService.FromTv(series, between, null, Today, Today);
        Assert.Equal(
            new[] { (1, 1, true), (1, 2, true), (2, 1, true), (2, 2, true), (3, 1, false), (3, 2, false) },
            later.Expected!.Select(e => (e.S, e.E, PlaceholderProgress.IsAired(e, Today))));

        // A special announced as the next episode doesn't count as a regular one either.
        var nextSpecial = Json(Show(904, "Returning Series", inProduction: true, last: Episode(1, 2, Past), next: Episode(0, 5, Future)));
        Assert.Equal(
            new[] { (1, 1, true), (1, 2, true), (2, 1, false), (2, 2, false) },
            ListPlaceholderMetadataService.FromTv(series, nextSpecial, null, Today, Today).Expected!.Select(e => (e.S, e.E, PlaceholderProgress.IsAired(e, Today))));
    }

    // ── F12: the episodes release date follows the fresh season read ───

    [Fact]
    public void AnEpisodesReleaseDateFollowsTheSeasonReadWhenTmdbUndatesTheFirstEpisode()
    {
        var tv = Json(Show(905, "Returning Series", inProduction: true, last: Episode(1, 1, Past), next: null));
        var episodes = Ph("{\"kind\":\"episodes\",\"tmdbId\":905,\"seasonNumber\":2,\"title\":\"Show\",\"releaseDate\":\"2025-08-01\",\"episodes\":[{\"s\":2,\"e\":1,\"airDate\":\"2025-08-01\"},{\"s\":2,\"e\":2}]}");

        // TMDB took E01's date away: the release date is no longer that stale date but the season premiere (C4).
        var undated = Json("{\"seasonNumber\":2,\"airDate\":\"2021-01-01\",\"episodes\":[" + Episode(2, 1, null) + "," + Episode(2, 2, null) + "]}");
        var meta = ListPlaceholderMetadataService.FromTv(episodes, tv, undated, Today, Today);
        Assert.Equal("2021-01-01", meta.ReleaseDate);
        ListPlaceholderMetadataService.Apply(episodes, meta);
        Assert.Null(episodes.Episodes[0].AirDate);
        Assert.Equal("2021-01-01", episodes.ReleaseDate);

        // A season read that doesn't list E01 keeps its stored date (Apply keeps it too); a failed read does as well.
        episodes.Episodes[0].AirDate = "2025-08-01";
        var without = Json("{\"seasonNumber\":2,\"airDate\":\"2021-01-01\",\"episodes\":[" + Episode(2, 2, null) + "]}");
        Assert.Equal("2025-08-01", ListPlaceholderMetadataService.FromTv(episodes, tv, without, Today, Today).ReleaseDate);
        Assert.Equal("2025-08-01", ListPlaceholderMetadataService.FromTv(episodes, tv, null, Today, Today).ReleaseDate);
    }
}
