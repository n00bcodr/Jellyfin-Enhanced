using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

// Review round 5: server-side fixes (stale metadata from a concurrent pass, intent recovery before a sync, collection
// season items replaced in the library, TMDB season posters).
[Collection("Plugin singleton")]
public class ListsReviewR5Tests
{
    private static readonly CancellationToken None = CancellationToken.None;
    private const string Past = "2020-01-01";
    private const string Future = "2099-01-01";

    private static string TvJson(int tmdb, bool ended, string? nextAir = null, int nextEpisode = 3, int s1Count = 3) =>
        $"{{\"id\":{tmdb},\"name\":\"Show\",\"firstAirDate\":\"{Past}\",\"status\":\"{(ended ? "Ended" : "Returning Series")}\",\"inProduction\":{(ended ? "false" : "true")}," +
        $"\"externalIds\":{{\"imdbId\":\"tt1234567\",\"tvdbId\":{tmdb + 1000}}},\"posterPath\":\"/show.jpg\"," +
        $"\"lastEpisodeToAir\":{{\"seasonNumber\":1,\"episodeNumber\":2,\"airDate\":\"{Past}\"}}," +
        (nextAir == null ? "\"nextEpisodeToAir\":null," : $"\"nextEpisodeToAir\":{{\"seasonNumber\":1,\"episodeNumber\":{nextEpisode},\"airDate\":\"{nextAir}\"}},") +
        $"\"seasons\":[{{\"seasonNumber\":0,\"episodeCount\":1,\"airDate\":\"{Past}\"}},{{\"seasonNumber\":1,\"episodeCount\":{s1Count},\"airDate\":\"{Past}\"}}]}}";

    private static string SeasonJson(int season, params string?[] airDates) =>
        $"{{\"seasonNumber\":{season},\"airDate\":\"{Past}\",\"posterPath\":\"/s{season}.jpg\",\"episodes\":[" +
        string.Join(',', airDates.Select((d, i) => $"{{\"episodeNumber\":{i + 1},\"seasonNumber\":{season},\"name\":\"Episode {i + 1}\",\"airDate\":{(d == null ? "null" : "\"" + d + "\"")}}}")) + "]}";

    private static Placeholder? Stored(ListsHarness h, string listIdN, string id) =>
        h.Store.Load(listIdN)!.Items.SingleOrDefault(p => p.Id == id);

    // R5-3: a pass that read its metadata (from the cache) before a concurrent Force pass replaced it must not write that
    // older read back over the newer one, nor count it as fresh enough to retire the season.
    [Fact]
    public async Task AnOlderMetadataReadNeverOverwritesWhatAConcurrentForcePassApplied()
    {
        using var h = new ListsHarness(seerr: true);
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        h.TvDetails[150] = TvJson(150, ended: false, s1Count: 2);
        h.SeasonDetails[(150, 1)] = SeasonJson(1, Past, Past);
        var season = Ph("{\"kind\":\"season\",\"tmdbId\":150,\"seasonNumber\":1,\"title\":\"Show S1\"}");
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { season }, null, null, null, None));
        await h.Consent(access); // D29: this list's editor turned automatic swap-in on
        await h.Swap.DrainAsync(None);
        var series = h.Host.AddSeries(tmdb: 150);
        h.Swap.NotifyItemChanged(h.Host.AddEpisode(series, 1, 1));
        await h.Swap.DrainAsync(None);

        // The stale read (X): E01-E02 only, fetched before TMDB added E03/E04.
        var stale = new PlaceholderMetadata
        {
            FetchedAtUtc = DateTime.UtcNow.AddMinutes(-10),
            Expected = new List<PlaceholderEpisode> { new() { S = 1, E = 1, AirDate = Past }, new() { S = 1, E = 2, AirDate = Past } },
            EpisodeTotal = 2,
            InProduction = true,
        };

        // TMDB adds E03 (aired) and E04 (announced); the arrival forces a fresh read (Y), which keeps the season.
        h.TvDetails[150] = TvJson(150, ended: false, nextAir: Future, nextEpisode: 4, s1Count: 4);
        h.SeasonDetails[(150, 1)] = SeasonJson(1, Past, Past, Past, Future);
        h.Swap.NotifyItemChanged(h.Host.AddEpisode(series, 1, 2));
        h.Swap.NotifyItemChanged(h.Host.AddEpisode(series, 1, 3));
        for (var i = 0; i < 3; i++)
        {
            await h.Swap.DrainAsync(None);
        }

        Assert.Equal((4, 3), (Stored(h, access.ListIdN, season.Id)!.Expected.Count, Stored(h, access.ListIdN, season.Id)!.Filled.Count));

        // The maintenance pass that read X before the Force pass took the lock applies it now.
        var doc = h.Store.LoadForUpdate(access.ListIdN, playlist.Info.Kind);
        var outcome = await h.Swap.SwapLockedAsync(playlist.Info, owner, doc, null, new Dictionary<string, PlaceholderMetadata> { [season.Id] = stale }, null, MetadataMode.Maintenance, None);
        if (outcome.Dirty)
        {
            h.Store.Save(outcome.Doc);
        }

        var stored = Stored(h, access.ListIdN, season.Id);
        Assert.NotNull(stored);
        Assert.Equal(4, stored!.Expected.Count);
        Assert.Equal(0, outcome.Result.Retired);
    }

    // R5-5: a collection season whose Season item Jellyfin replaced (the season folder was renamed, so the Season and
    // Episode items all got new ids) puts the new Season item in; the replaced fills are credited through it.
    [Fact]
    public async Task ACollectionSeasonWhoseSeasonItemWasReplacedPutsTheNewSeasonItemIn()
    {
        using var h = new ListsHarness();
        var admin = h.NewUser("admin", admin: true);
        var collection = h.Host.AddCollection();
        var access = h.AccessFor(collection, admin);
        var season = Ph("{\"kind\":\"season\",\"tmdbId\":160,\"seasonNumber\":1,\"title\":\"Show S1\"}");
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { season }, null, null, null, None));
        await h.Consent(access); // D29: this list's editor turned automatic swap-in on
        var series = h.Host.AddSeries(tmdb: 160);
        var old = Enumerable.Range(1, 3).Select(e => h.Host.AddEpisode(series, 1, e)).ToList();
        old.ForEach(h.Swap.NotifyItemChanged);
        await h.Swap.DrainAsync(None);
        var oldSeason = h.Host.Seasons[(series, 1)].Id;
        Assert.Equal(new[] { oldSeason }, h.Host.Resolved(collection.Info.Id));
        Assert.All(Stored(h, access.ListIdN, season.Id)!.Filled, f => Assert.Equal(oldSeason.ToString("N"), f.Via));

        // "Season 1" -> "Season 01": Jellyfin deletes the old Season and Episode items (and, on 12, their links) and
        // creates new ones.
        foreach (var id in old.Append(oldSeason))
        {
            h.Host.Items.Remove(id);
        }

        h.Host.Episodes.RemoveAll(e => old.Contains(e.Id));
        h.Host.Seasons.Remove((series, 1));
        collection.Raw.RemoveAll(r => r.ItemId == oldSeason);
        var renamed = Enumerable.Range(1, 3).Select(e => h.Host.AddEpisode(series, 1, e)).ToList();
        var newSeason = h.Host.Seasons[(series, 1)].Id;
        renamed.ForEach(h.Swap.NotifyItemChanged);
        h.Swap.NotifyItemChanged(newSeason);
        await h.Swap.DrainAsync(None);

        Assert.Equal(new[] { newSeason }, h.Host.Resolved(collection.Info.Id));
        var stored = Stored(h, access.ListIdN, season.Id)!;
        Assert.Equal(renamed.Select(id => id.ToString("N")), stored.Filled.Select(f => f.ItemId));
        Assert.All(stored.Filled, f => Assert.Equal(newSeason.ToString("N"), f.Via));
    }

    // R5-9: a season poster read from TMDB falls back to the show's only when TMDB answered for the season (no poster,
    // or no such season). A season read that failed for a while (5xx, 429, timeout) is a failed lookup: the client's
    // unverified poster stays, and the collage keeps retrying.
    [Fact]
    public async Task ASeasonPosterReadThatFailsIsNotAnsweredWithTheShowsPoster()
    {
        using var h = new ListsHarness();
        h.Plugin.Plugin.Configuration.TMDB_API_KEY = "tmdb-key";
        h.Tmdb["/3/tv/170"] = "{\"id\":170,\"poster_path\":\"/show.jpg\"}";
        h.Tmdb["/3/tv/171"] = "{\"id\":171,\"poster_path\":null}";
        h.Tmdb["/3/tv/170/season/1"] = "{\"season_number\":1,\"poster_path\":null}";
        var reply = h.Reply;
        h.Reply = request => request.RequestUri!.AbsolutePath.EndsWith("/season/2", StringComparison.Ordinal)
            ? IntegrationTransport.Response("{\"status_code\":25}", 429)
            : reply(request);
        Placeholder Season(int tmdb, int number) =>
            Ph($"{{\"kind\":\"season\",\"tmdbId\":{tmdb},\"seasonNumber\":{number},\"title\":\"Show S{number}\",\"posterPath\":\"/client.jpg\"}}");

        Assert.Equal(((string?)"/show.jpg", true), await h.Metadata.ReadTmdbPosterAsync(Season(170, 1), None)); // answered, no poster
        Assert.Equal(((string?)"/show.jpg", true), await h.Metadata.ReadTmdbPosterAsync(Season(170, 3), None)); // 404: no such season
        Assert.Equal(((string?)null, false), await h.Metadata.ReadTmdbPosterAsync(Season(170, 2), None));       // rate limited
        Assert.Equal(((string?)null, false), await h.Metadata.ReadTmdbPosterAsync(Season(171, 2), None));

        // The swap's maintenance pass leaves the client's unverified poster alone while the season read fails.
        h.Plugin.Plugin.Configuration.TMDB_API_KEY = string.Empty;
        var editor = h.NewUser("editor");
        var playlist = h.Host.AddPlaylist(editor);
        var access = h.AccessFor(playlist, editor);
        var season = Season(170, 2);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { season }, null, null, null, None));
        Assert.True(Stored(h, access.ListIdN, season.Id)!.PosterUnverified);
        h.Plugin.Plugin.Configuration.TMDB_API_KEY = "tmdb-key";
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.Maintenance, None);
        var kept = Stored(h, access.ListIdN, season.Id)!;
        Assert.Equal(("/client.jpg", (bool?)true), (kept.PosterPath, kept.PosterUnverified));
    }
}
