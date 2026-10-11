using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Sources;
using static JE.Tests.ListPlaceholdersHarness;

namespace JE.Tests;

// Review round 4: server-side fixes (swap completion, TMDB posters, collection recovery, provenance scopes).
[Collection("Plugin singleton")]
public class ListPlaceholdersReviewR4Tests
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

    private static Placeholder? Stored(ListPlaceholdersHarness h, ListAccess access, string id) =>
        h.Store.Load(access.ListIdN)!.Items.SingleOrDefault(p => p.Id == id);

    // R4-3: a season that looks complete only on cached metadata the library already contradicts (an episode that the
    // expected set doesn't know arrived) is not retired: the Force read runs first and finds the new episodes.
    [Fact]
    public async Task ASeasonCompleteOnlyOnMetadataTheLibraryContradictsIsForcedNotRetired()
    {
        using var h = new ListPlaceholdersHarness(seerr: true);
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        h.TvDetails[150] = TvJson(150, ended: false, s1Count: 2);
        h.SeasonDetails[(150, 1)] = SeasonJson(1, Past, Past);
        var season = Ph("{\"kind\":\"season\",\"tmdbId\":150,\"seasonNumber\":1,\"title\":\"Show S1\"}");
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { season }, null, null, null, None));
        await h.Swap.DrainAsync(None);
        var series = h.Host.AddSeries(tmdb: 150);
        h.Swap.NotifyItemChanged(h.Host.AddEpisode(series, 1, 1));
        await h.Swap.DrainAsync(None);
        Assert.Equal((1, 2), (Stored(h, access, season.Id)!.Filled.Count, Stored(h, access, season.Id)!.Expected.Count));

        // TMDB adds E03 (aired) and E04 (announced); the cached season read still lists E01–E02.
        h.TvDetails[150] = TvJson(150, ended: false, nextAir: Future, nextEpisode: 4, s1Count: 4);
        h.SeasonDetails[(150, 1)] = SeasonJson(1, Past, Past, Past, Future);
        h.Swap.NotifyItemChanged(h.Host.AddEpisode(series, 1, 2));
        h.Swap.NotifyItemChanged(h.Host.AddEpisode(series, 1, 3));
        for (var i = 0; i < 3; i++)
        {
            await h.Swap.DrainAsync(None); // the arrival's pass, then the passes it queues
        }

        var stored = Stored(h, access, season.Id);
        Assert.NotNull(stored);
        Assert.Equal(4, stored!.Expected.Count);
        Assert.Equal(3, stored.Filled.Count);

        var e4 = h.Host.AddEpisode(series, 1, 4);
        h.Swap.NotifyItemChanged(e4);
        await h.Swap.DrainAsync(None);
        Assert.Contains(playlist.Raw, r => r.ItemId == e4);
    }

    // R4-4: an unverified client poster is cleared once TMDB reads the title and says it has no poster (a failed
    // lookup still changes nothing).
    [Fact]
    public async Task ATmdbAnswerWithoutAPosterClearsAnUnverifiedClientPoster()
    {
        using var h = new ListPlaceholdersHarness();
        var editor = h.NewUser("editor");
        var playlist = h.Host.AddPlaylist(editor);
        var access = h.AccessFor(playlist, editor);
        var answered = Ph("{\"kind\":\"movie\",\"tmdbId\":10,\"title\":\"Movie 10\",\"releaseDate\":\"2001-01-01\",\"posterPath\":\"/wrong.jpg\"}", access.UserIdN);
        var failing = Ph("{\"kind\":\"movie\",\"tmdbId\":11,\"title\":\"Movie 11\",\"releaseDate\":\"2001-01-01\",\"posterPath\":\"/other.jpg\"}", access.UserIdN);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { answered, failing }, null, null, null, None));
        Assert.True(Stored(h, access, answered.Id)!.PosterUnverified);

        h.Plugin.Plugin.Configuration.TMDB_API_KEY = "tmdb-key";
        h.Tmdb["/3/movie/10"] = "{\"id\":10,\"poster_path\":null}"; // /3/movie/11 is not served (404)
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.Maintenance, None);

        var cleared = Stored(h, access, answered.Id)!;
        Assert.Equal(((string?)null, (bool?)null), (cleared.PosterPath, cleared.PosterUnverified));
        Assert.Equal("2001-01-01", cleared.ReleaseDate);
        var kept = Stored(h, access, failing.Id)!;
        Assert.Equal(("/other.jpg", (bool?)true), (kept.PosterPath, kept.PosterUnverified));
    }

    // R4-5: a crash right after Jellyfin took JE's add of movie copy M1 to a collection; before the recovery pass a
    // second copy M2 of the same title is scanned and the resolver now lists it first. Recovery retires the placeholder
    // with M1 (what landed) sync-owned and never adds M2 as a second copy.
    [Fact]
    public async Task ARecoveredCollectionMovieSwapNeverAddsASecondCopy()
    {
        using var h = new ListPlaceholdersHarness();
        var admin = h.NewUser("admin", admin: true);
        var collection = h.Host.AddCollection();
        var access = h.AccessFor(collection, admin);
        var movie = Ph("{\"kind\":\"movie\",\"tmdbId\":300,\"title\":\"Movie 300\"}");
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { movie }, null, null, null, None));
        using (await h.Store.LockAsync(access.ListIdN))
        {
            var linked = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Collection);
            linked.Source = new ListSource { Url = "https://mdblist.com/lists/me/x" };
            ListSourceProvenance.RecordAdded(linked.Source, "movie|300||", movie.Id, null);
            h.Store.Save(linked);
        }

        var m1 = h.Host.AddItem(tmdb: 300);
        ListDoc? crashDoc = null;
        List<RawEntry>? crashRaw = null;
        h.Host.AfterCollectionAdd = _ =>
        {
            crashDoc ??= h.Store.LoadForUpdate(access.ListIdN, ListKinds.Collection);
            crashRaw ??= collection.Raw.ToList();
        };
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        h.Host.AfterCollectionAdd = null;
        Assert.Single(crashDoc!.Intents);

        collection.Raw.Clear();
        collection.Raw.AddRange(crashRaw!);
        using (await h.Store.LockAsync(access.ListIdN))
        {
            h.Store.Save(crashDoc);
        }

        var m2 = h.Host.AddItem(tmdb: 300); // now the resolver's first match
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);

        Assert.Contains(collection.Raw, r => r.ItemId == m1);
        Assert.DoesNotContain(collection.Raw, r => r.ItemId == m2);
        var after = h.Store.Load(access.ListIdN)!;
        Assert.Empty(after.Items);
        Assert.Empty(after.Intents);
        Assert.Equal(new[] { m1.ToString("N") }, after.Source!.Owned["movie|300||"].ItemIds);
    }

    // R4-8: a season key that shares a series placeholder takes only its own season's fills; the series key takes all.
    // So when the source drops the show but keeps season 1, season 2's items go with the series key.
    [Fact]
    public void ASeasonKeySharingASeriesPlaceholderOwnsOnlyItsSeasonsFills()
    {
        var series = Ph("{\"kind\":\"series\",\"tmdbId\":123,\"title\":\"Show\"}");
        var doc = new ListDoc { Items = new List<Placeholder> { series }, Source = new ListSource { RemoveDropped = true } };
        ListSourceProvenance.RecordAdded(doc.Source, "tv|123||", series.Id, null);
        ListSourceProvenance.AttachCovered(doc.Source, "tv|123|1|", series);
        ListSourceProvenance.RecordAdded(doc.Source, "tv|123|2|5", series.Id, null);
        var s1 = Guid.NewGuid().ToString("N");
        var s2 = Guid.NewGuid().ToString("N");
        var s2e5 = Guid.NewGuid().ToString("N");
        series.Filled.Add(new FilledEpisode { ItemId = s1, S = 1, E = 1 });
        series.Filled.Add(new FilledEpisode { ItemId = s2, S = 2, E = 1 });
        series.Filled.Add(new FilledEpisode { ItemId = s2e5, S = 2, E = 5 });
        Assert.True(ListSourceProvenance.OnSwapped(doc, series, new[] { s1, s2, s2e5 }));

        Assert.Equal(new[] { s1, s2, s2e5 }, doc.Source.Owned["tv|123||"].ItemIds);
        Assert.Equal(new[] { s1 }, doc.Source.Owned["tv|123|1|"].ItemIds);
        Assert.Equal(new[] { s2e5 }, doc.Source.Owned["tv|123|2|5"].ItemIds);

        doc.Source.LastSnapshotKeys = doc.Source.Owned.Keys.ToList();
        var plan = ListSourceProvenance.PlanDrops(doc, new[] { "tv|123|1|" }, new Dictionary<string, int> { [s1] = 1, [s2] = 1, [s2e5] = 1 });
        Assert.Contains(Guid.ParseExact(s2, "N"), plan.ItemIds);
        Assert.DoesNotContain(Guid.ParseExact(s1, "N"), plan.ItemIds);
    }
}
