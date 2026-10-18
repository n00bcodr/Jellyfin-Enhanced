using System.Globalization;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using Moq;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

// Swap-in (§9, A5–A8): library arrivals go into playlists/collections at the placeholder's spot. Every list here has
// automatic swap-in turned on by its editor (D29; see ListsConsentTests for lists without it).
[Collection("Plugin singleton")]
public class ListsSwapTests
{
    private static readonly CancellationToken None = CancellationToken.None;
    private const string Past = "2020-01-01";
    private const string Future = "2099-01-01";

    private static Placeholder Season(int tmdb, int season) =>
        Ph($"{{\"kind\":\"season\",\"tmdbId\":{tmdb},\"seasonNumber\":{season},\"title\":\"Show S{season}\"}}");

    private static Placeholder SeriesPh(int tmdb) => Ph($"{{\"kind\":\"series\",\"tmdbId\":{tmdb},\"title\":\"Show\"}}");

    private static Placeholder EpisodesOf(int tmdb, int season, params int[] episodes) =>
        Ph($"{{\"kind\":\"episodes\",\"tmdbId\":{tmdb},\"seasonNumber\":{season},\"title\":\"Show\",\"episodes\":[{string.Join(',', episodes.Select(e => $"{{\"s\":{season},\"e\":{e}}}"))}]}}");

    private static string TvJson(int tmdb, bool ended, string? nextAir = null, int nextEpisode = 3, int s1Count = 3) =>
        $"{{\"id\":{tmdb},\"name\":\"Show\",\"firstAirDate\":\"{Past}\",\"status\":\"{(ended ? "Ended" : "Returning Series")}\",\"inProduction\":{(ended ? "false" : "true")}," +
        $"\"externalIds\":{{\"imdbId\":\"tt1234567\",\"tvdbId\":{tmdb + 1000}}},\"posterPath\":\"/show.jpg\"," +
        $"\"lastEpisodeToAir\":{{\"seasonNumber\":1,\"episodeNumber\":2,\"airDate\":\"{Past}\"}}," +
        (nextAir == null ? "\"nextEpisodeToAir\":null," : $"\"nextEpisodeToAir\":{{\"seasonNumber\":1,\"episodeNumber\":{nextEpisode},\"airDate\":\"{nextAir}\"}},") +
        $"\"seasons\":[{{\"seasonNumber\":0,\"episodeCount\":1,\"airDate\":\"{Past}\"}},{{\"seasonNumber\":1,\"episodeCount\":{s1Count},\"airDate\":\"{Past}\"}}]}}";

    private static string SeasonJson(int season, params string?[] airDates) =>
        $"{{\"seasonNumber\":{season},\"airDate\":\"{Past}\",\"posterPath\":\"/s{season}.jpg\",\"episodes\":[" +
        string.Join(',', airDates.Select((d, i) => $"{{\"episodeNumber\":{i + 1},\"seasonNumber\":{season},\"name\":\"Episode {i + 1}\",\"airDate\":{(d == null ? "null" : "\"" + d + "\"")}}}")) + "]}";

    // Adds the entries and (D29) turns automatic swap-in on for the list as the caller, so the swap passes below may insert.
    // A list without a document after the add (everything landed) stays without one.
    private static async Task<ApplyResultDto> Add(ListsHarness h, ListAccess access, PositionDto? position, params Placeholder[] placeholders)
    {
        var result = Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, placeholders, position, null, null, None));
        if (h.Store.Load(access.ListIdN) != null)
        {
            await h.Consent(access);
        }

        return result;
    }

    private static Placeholder Stored(ListsHarness h, ListAccess access, string id) =>
        h.Store.Load(access.ListIdN)!.Items.Single(p => p.Id == id);

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AnArrivingMovieTakesThePlaceholdersSpotInBothCoordinateSystems(bool positional)
    {
        using var h = new ListsHarness();
        h.Host.SupportsPositionalInsert = positional;
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var b = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner);
        // A dangling link before B: jf12 raw positions count it.
        playlist.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(Guid.NewGuid(), false), new RawEntry(b, true) });
        var access = h.AccessFor(playlist, owner);
        var movie = Movie(49521);
        var other = Movie(1);
        await Add(h, access, new PositionDto { AfterToken = E(a) }, movie, other);
        var rev = h.Store.Load(access.ListIdN)!.Rev;

        var arrived = h.Host.AddItem(tmdb: 49521);
        h.Swap.NotifyItemChanged(arrived);
        h.Host.Calls.Clear();
        await h.Swap.DrainAsync(None);

        Assert.Equal(new[] { a, arrived, b }, h.Host.Resolved(playlist.Info.Id));
        var doc = h.Store.Load(access.ListIdN)!;
        Assert.Equal(new[] { E(a), E(arrived), P(other.Id), E(b) }, doc.Order);
        Assert.DoesNotContain(doc.Items, p => p.Id == movie.Id);
        Assert.Empty(doc.Intents);
        Assert.True(doc.Rev > rev);
        Assert.Equal(
            positional ? new[] { $"add:{FakeListHost.Short(arrived)}@1" } : new[] { $"add:{FakeListHost.Short(arrived)}@end", $"move:{FakeListHost.Short(arrived)}->1" },
            h.Host.Calls);
        Assert.Null(h.Swap.GetPendingMatch(access.ListIdN, movie.Id));

        // Idempotent: the next pass changes nothing.
        h.Host.Calls.Clear();
        var again = await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        Assert.Equal(default, again);
        Assert.Empty(h.Host.Calls);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AMovieAlreadyInThePlaylistSatisfiesThePlaceholderWithoutASecondCopy(bool positional)
    {
        using var h = new ListsHarness();
        h.Host.SupportsPositionalInsert = positional;
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.Add(new RawEntry(a, true));
        var access = h.AccessFor(playlist, owner);
        var movie = Movie(10);
        await Add(h, access, null, movie);

        var arrived = h.Host.AddItem(tmdb: 10);
        playlist.Raw.Insert(0, new RawEntry(arrived, true)); // the owner added it by hand meanwhile
        h.Host.Calls.Clear();
        var result = await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);

        Assert.Equal(new SwapPassResult(0, 1), result);
        Assert.Empty(h.Host.Calls);
        Assert.Equal(new[] { arrived, a }, h.Host.Resolved(playlist.Info.Id));
        Assert.Empty(h.Store.Load(access.ListIdN)!.Items);
    }

    [Theory]
    [InlineData(false, false, false)]
    [InlineData(true, false, false)]
    [InlineData(false, false, true)]
    [InlineData(true, false, true)]
    [InlineData(false, true, true)]
    [InlineData(true, true, true)]
    [InlineData(false, true, false)]
    [InlineData(true, true, false)]
    public async Task AnEquivalentMovieAlreadyInTheListIsPresenceWithoutOwnership(bool collection, bool fourK, bool presentFourK)
    {
        using var h = new ListsHarness(seerr: false);
        var owner = h.NewUser("owner", admin: true);
        var list = collection ? h.Host.AddCollection() : h.Host.AddPlaylist(owner);
        var access = h.AccessFor(list, owner);
        var entry = fourK ? Ph("{\"kind\":\"movie\",\"tmdbId\":782,\"title\":\"Movie\",\"edition\":\"4k\"}") : Movie(782);
        await Add(h, access, null, entry);
        var selected = h.Host.AddMovieCopy(782, fourK);
        var present = h.Host.AddMovieCopy(782, presentFourK);
        list.Raw.Add(new RawEntry(present, true));
        h.Host.Calls.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        var expected = fourK && !presentFourK ? new[] { selected, present } : new[] { present };
        Assert.Equal(expected.Order(), h.Host.Resolved(list.Info.Id).Order());
        if (!fourK || presentFourK)
        {
            Assert.Empty(h.Host.Calls);
            Assert.Empty(h.Store.Load(access.ListIdN)!.Items);
            Assert.Empty(h.Store.Load(access.ListIdN)!.Intents);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task EquivalentEpisodesAlreadyInTheListFillWithoutASecondCopy(bool collection)
    {
        using var h = new ListsHarness(seerr: false);
        var owner = h.NewUser("owner", admin: true);
        var list = collection ? h.Host.AddCollection() : h.Host.AddPlaylist(owner);
        var access = h.AccessFor(list, owner);
        var entry = EpisodesOf(783, 1, 1);
        await Add(h, access, null, entry);
        var first = h.Host.AddSeries(tmdb: 783);
        h.Host.AddEpisode(first, 1, 1);
        var sibling = h.Host.AddSeries(tmdb: 783);
        var present = h.Host.AddEpisode(sibling, 1, 1);
        list.Raw.Add(new RawEntry(present, true));
        h.Host.Calls.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        Assert.Equal(new[] { present }, h.Host.Resolved(list.Info.Id));
        Assert.Empty(h.Host.Calls);
        Assert.Empty(h.Store.Load(access.ListIdN)!.Items);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task EquivalentEpisodesWithinOneSeriesPreferTheExistingSecondCopy(bool collection)
    {
        using var h = new ListsHarness(seerr: false);
        var owner = h.NewUser("owner", admin: true);
        var list = collection ? h.Host.AddCollection() : h.Host.AddPlaylist(owner);
        var access = h.AccessFor(list, owner);
        await Add(h, access, null, EpisodesOf(785, 1, 1));
        var series = h.Host.AddSeries(tmdb: 785);
        h.Host.AddEpisode(series, 1, 1);
        var present = h.Host.AddEpisode(series, 1, 1);
        list.Raw.Add(new RawEntry(present, true));
        h.Host.Calls.Clear();

        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);

        Assert.Equal(new[] { present }, h.Host.Resolved(list.Info.Id));
        Assert.Empty(h.Host.Calls);
        Assert.Empty(h.Store.Load(access.ListIdN)!.Items);
        Assert.Empty(h.Store.Load(access.ListIdN)!.Intents);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AnEquivalentCollectionSeasonOrSeriesAlreadyPresentIsNotAddedAgain(bool wholeSeries)
    {
        using var h = new ListsHarness(seerr: false);
        var owner = h.NewUser("owner", admin: true);
        var list = h.Host.AddCollection();
        var access = h.AccessFor(list, owner);
        var entry = wholeSeries ? SeriesPh(784) : Season(784, 1);
        await Add(h, access, null, entry);
        var first = h.Host.AddSeries(tmdb: 784);
        h.Host.AddEpisode(first, 1, 1);

        var sibling = h.Host.AddSeries(tmdb: 784);
        h.Host.AddEpisode(sibling, 1, 1);
        var season = h.Host.Seasons[(sibling, 1)].Id;
        var present = wholeSeries ? sibling : season;
        list.Raw.Add(new RawEntry(present, true));
        h.Host.Calls.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        Assert.Equal(new[] { present }, h.Host.Resolved(list.Info.Id));
        Assert.Empty(h.Host.Calls);
    }

    [Fact]
    public async Task NothingIsSwappedInThatTheOwnerCantSeeAndAMissingListIsTerminal()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        var movie = Movie(20);
        await Add(h, access, null, movie);
        var arrived = h.Host.AddItem(tmdb: 20);
        h.Host.Hide(arrived, owner);

        Assert.Equal(default, await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None));
        Assert.Empty(h.Host.Resolved(playlist.Info.Id));
        Assert.Single(h.Store.Load(access.ListIdN)!.Items);

        h.Host.Lists.Remove(playlist.Info.Id);
        h.Swap.QueuePass(access.ListIdN, null, MetadataMode.None);
        await h.Swap.DrainAsync(None); // no throw, nothing retried
        Assert.Equal(default, await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None));
    }

    [Fact]
    public async Task ASeasonFillsEpisodeByEpisodeInOrderAndStaysUntilTheAiringSeasonIsComplete()
    {
        using var h = new ListsHarness(seerr: true);
        var owner = h.NewUser("owner");
        var x = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.Add(new RawEntry(x, true));
        var access = h.AccessFor(playlist, owner);
        h.TvDetails[110492] = TvJson(110492, ended: false, nextAir: Future);
        h.SeasonDetails[(110492, 1)] = SeasonJson(1, Past, Past, Future);
        var season = Season(110492, 1);
        await Add(h, access, new PositionDto { AtStart = true }, season);
        await h.Swap.DrainAsync(None); // background metadata pass for the new placeholder

        var stored = Stored(h, access, season.Id);
        Assert.Equal(3, stored.Expected.Count);
        Assert.True(stored.InProduction);
        Assert.Equal(111492, stored.TvdbId); // learned from Seerr: TVDB-only libraries match too
        Assert.Equal("/s1.jpg", stored.PosterPath);

        var series = h.Host.AddSeries(tmdb: 110492);
        var e2 = h.Host.AddEpisode(series, 1, 2);
        h.Swap.NotifyItemChanged(e2);
        await h.Swap.DrainAsync(None);
        Assert.Equal(new[] { e2, x }, h.Host.Resolved(playlist.Info.Id));
        Assert.Equal(new[] { E(e2), P(season.Id), E(x) }, h.Store.Load(access.ListIdN)!.Order);

        var e1 = h.Host.AddEpisode(series, 1, 1);
        h.Swap.NotifyItemChanged(e1);
        await h.Swap.DrainAsync(None);
        Assert.Equal(new[] { e1, e2, x }, h.Host.Resolved(playlist.Info.Id));
        var view = await h.Service.GetViewAsync(access, None);
        var dto = view.Placeholders.Single();
        Assert.Equal((2, 3, 2), (dto.FilledCount, dto.ExpectedCount, dto.AiredCount));
        Assert.True(dto.InProduction);
        Assert.Equal(new[] { E(e1), E(e2), P(season.Id), E(x) }, view.Order);

        // The last episode airs and arrives: complete on fresh metadata, the placeholder goes.
        h.TvDetails[110492] = TvJson(110492, ended: false);
        h.SeasonDetails[(110492, 1)] = SeasonJson(1, Past, Past, Past);
        var e3 = h.Host.AddEpisode(series, 1, 3);
        h.Swap.NotifyItemChanged(e3);
        await h.Swap.DrainAsync(None);
        Assert.Single(h.Store.Load(access.ListIdN)!.Items); // cached data still says E03 hasn't aired
        await h.Swap.DrainAsync(None); // the forced metadata refresh that arrival queued
        Assert.Equal(new[] { e1, e2, e3, x }, h.Host.Resolved(playlist.Info.Id));
        Assert.Empty(h.Store.Load(access.ListIdN)!.Items);
    }

    [Fact]
    public async Task EpisodesMatchThroughTheSeriesIdsNeverTheEpisodesOwnTmdbIdAndMultiEpisodeFilesFillBoth()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        var flash = EpisodesOf(60735, 1, 8, 9);
        flash.TvdbId = 279121;
        var decoy = SeriesPh(4242);
        await Add(h, access, null, flash, decoy);

        // The library show only has its TVDB id; the episode file carries an episode-level TMDB id equal to the decoy's.
        var series = h.Host.AddSeries(tvdb: 279121);
        var both = h.Host.AddEpisode(series, 1, 8, episodeEnd: 9, ownTmdb: 4242);
        h.Swap.NotifyItemChanged(both);
        await h.Swap.DrainAsync(None);

        Assert.Equal(new[] { both }, h.Host.Resolved(playlist.Info.Id));
        var doc = h.Store.Load(access.ListIdN)!;
        Assert.DoesNotContain(doc.Items, p => p.Id == flash.Id); // both listed episodes are in: retired
        Assert.Contains(doc.Items, p => p.Id == decoy.Id);
        Assert.Equal(new[] { E(both), P(decoy.Id) }, doc.Order);
    }

    [Fact]
    public async Task AnInterruptedSwapIsCompletedOrRolledBackFromItsIntent()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.Add(new RawEntry(a, true));
        var access = h.AccessFor(playlist, owner);
        var done = Movie(30);
        var notDone = Movie(31);
        await Add(h, access, null, done, notDone);
        var landed = h.Host.AddItem(tmdb: 30);
        var pending = h.Host.AddItem(tmdb: 31);

        // A crash after Jellyfin inserted `landed` (intent persisted, placeholder not retired), and one before
        // Jellyfin inserted `pending`.
        using (await h.Store.LockAsync(access.ListIdN))
        {
            var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
            doc.Intents.Add(new SwapIntent { PhId = done.Id, ItemIds = { landed.ToString("N") }, Anchor = E(a), OccurrenceCountsBefore = { [landed.ToString("N")] = 0 }, CreatedAt = "x1" });
            doc.Intents.Add(new SwapIntent { PhId = notDone.Id, ItemIds = { pending.ToString("N") }, Anchor = E(a), OccurrenceCountsBefore = { [pending.ToString("N")] = 0 }, CreatedAt = "x2" });
            h.Store.Save(doc);
        }

        playlist.Raw.Add(new RawEntry(landed, true));
        h.Host.Calls.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None); // intents only

        var after = h.Store.Load(access.ListIdN)!;
        Assert.Empty(after.Intents);
        Assert.DoesNotContain(after.Items, p => p.Id == done.Id); // completed: no second insert
        Assert.Contains(after.Items, p => p.Id == notDone.Id);    // rolled back: retried by the next pass
        Assert.Empty(h.Host.Calls);

        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        Assert.Equal(new[] { a, landed, pending }, h.Host.Resolved(playlist.Info.Id)); // the list order [a, done, notDone]
        Assert.Empty(h.Store.Load(access.ListIdN)!.Items);
    }

    [Fact]
    public async Task AJellyfinFailureKeepsThePlaceholderAndTheMatchAndAThrowAfterTheWriteStillCounts()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        var movie = Movie(40);
        await Add(h, access, null, movie);
        var arrived = h.Host.AddItem(tmdb: 40);

        h.Host.FailAdds = new InvalidOperationException("db locked");
        h.Swap.NotifyItemChanged(arrived);
        await h.Swap.DrainAsync(None);
        var doc = h.Store.Load(access.ListIdN)!;
        Assert.Single(doc.Items);
        Assert.Empty(doc.Intents);
        Assert.Equal(arrived, h.Swap.GetPendingMatch(access.ListIdN, movie.Id));
        var view = await h.Service.GetViewAsync(access, None);
        Assert.Equal(arrived.ToString("N"), view.Placeholders.Single().InLibraryItemId); // "Available — adding…"
        var stranger = h.NewUser("stranger", admin: true);
        h.Host.Hide(arrived, stranger);
        Assert.Null((await h.Service.GetViewAsync(h.AccessFor(playlist, stranger), None)).Placeholders.Single().InLibraryItemId);

        // Jellyfin wrote the entry and then threw: the occurrence count shows it landed.
        h.Host.FailAfterMutating = true;
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        Assert.Equal(new[] { arrived }, h.Host.Resolved(playlist.Info.Id));
        Assert.Empty(h.Store.Load(access.ListIdN)!.Items);
        Assert.Null(h.Swap.GetPendingMatch(access.ListIdN, movie.Id));
    }

    [Fact]
    public async Task APassThatCannotSwapTheMatchYetKeepsItAsBeingAddedUntilItIsSwappedOrTheGraceEnds()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var editor = h.NewUser("editor", admin: true);
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        var season = Season(53, 1);
        await Add(h, access, null, season);
        await h.Swap.DrainAsync(None);
        var now = DateTime.UtcNow;
        h.Swap.UtcNow = () => now;

        // The event matches E01, but the pass can't swap it in yet (the owner can't see it: e.g. a scan still writing
        // it). Before, that "nothing to do" pass ended the "Available — adding…" state at once.
        var series = h.Host.AddSeries(tmdb: 53);
        var e1 = h.Host.AddEpisode(series, 1, 1);
        h.Host.Hide(e1, owner);
        h.Swap.NotifyItemChanged(e1);
        await h.Swap.DrainAsync(None);
        Assert.Empty(h.Host.Resolved(playlist.Info.Id));
        Assert.Equal(e1, h.Swap.GetPendingMatch(access.ListIdN, season.Id));
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None); // e.g. the pass a list view queues
        Assert.Equal(e1, h.Swap.GetPendingMatch(access.ListIdN, season.Id));
        Assert.Equal(e1.ToString("N"), (await h.Service.GetViewAsync(h.AccessFor(playlist, editor), None)).Placeholders.Single().InLibraryItemId);

        // Resolvable now: the next pass swaps it in and the state ends.
        h.Host.HiddenFrom[owner.Id].Remove(e1);
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        Assert.Equal(new[] { e1 }, h.Host.Resolved(playlist.Info.Id));
        Assert.Null(h.Swap.GetPendingMatch(access.ListIdN, season.Id));
        Assert.Equal(1, (await h.Service.GetViewAsync(access, None)).Placeholders.Single().FilledCount);

        // A later update of the episode that is already in (metadata refresh) is not "being added".
        h.Swap.NotifyItemChanged(e1);
        await h.Swap.DrainAsync(None);
        Assert.Null(h.Swap.GetPendingMatch(access.ListIdN, season.Id));

        // A match that never becomes resolvable stops showing as being added after the grace period.
        var e2 = h.Host.AddEpisode(series, 1, 2);
        h.Host.Hide(e2, owner);
        h.Swap.NotifyItemChanged(e2);
        await h.Swap.DrainAsync(None);
        Assert.Equal(e2, h.Swap.GetPendingMatch(access.ListIdN, season.Id));
        now += ListSwapService.PendingMatchGrace + TimeSpan.FromSeconds(1);
        Assert.Null(h.Swap.GetPendingMatch(access.ListIdN, season.Id));
        Assert.Null((await h.Service.GetViewAsync(h.AccessFor(playlist, editor), None)).Placeholders.Single().InLibraryItemId);
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        h.Swap.UtcNow = () => now - TimeSpan.FromMinutes(10); // even with the clock back, the expired match is gone
        Assert.Null(h.Swap.GetPendingMatch(access.ListIdN, season.Id));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task UpdatesOfItemsAlreadyInTheListNeverShowAsBeingAdded(bool collection)
    {
        // A filled episode (playlist) or the Season item already in the collection gets a metadata refresh: it matches
        // its placeholder again, but it is no arrival, so it must not show "Available — adding…" (not even during the
        // settle delay). An arriving movie in the same burst is the control that the events were mapped.
        using var h = new ListsHarness();
        var owner = h.NewUser("owner", admin: true);
        var list = collection ? h.Host.AddCollection() : h.Host.AddPlaylist(owner);
        var access = h.AccessFor(list, owner);
        var season = Season(54, 1);
        var movie = Movie(55);
        await Add(h, access, null, season, movie);
        await h.Swap.DrainAsync(None);
        var series = h.Host.AddSeries(tmdb: 54);
        var e1 = h.Host.AddEpisode(series, 1, 1);
        h.Swap.NotifyItemChanged(e1);
        await h.Swap.DrainAsync(None);
        var seasonItem = h.Host.Seasons[(series, 1)].Id;
        Assert.Contains(collection ? seasonItem : e1, h.Host.Resolved(list.Info.Id));
        Assert.Null(h.Swap.GetPendingMatch(access.ListIdN, season.Id));

        h.Swap.SettleDelay = TimeSpan.FromSeconds(5);
        h.Swap.Start();
        try
        {
            var arrived = h.Host.AddItem(tmdb: 55);
            h.Swap.NotifyItemChanged(collection ? seasonItem : e1);
            h.Swap.NotifyItemChanged(arrived);
            for (var i = 0; i < 200 && h.Swap.GetPendingMatch(access.ListIdN, movie.Id) == null; i++)
            {
                await Task.Delay(10);
            }

            await Task.Delay(100);
            Assert.Equal(arrived, h.Swap.GetPendingMatch(access.ListIdN, movie.Id));
            Assert.Null(h.Swap.GetPendingMatch(access.ListIdN, season.Id));
            Assert.Null((await h.Service.GetViewAsync(access, None)).Placeholders.Single(p => p.Id == season.Id).InLibraryItemId);
        }
        finally
        {
            await h.Swap.StopAsync(None);
        }
    }

    [Fact]
    public async Task CollectionsGetTheMovieSeriesSeasonAndEpisodeItemsAndKeepSeasonsUntilComplete()
    {
        using var h = new ListsHarness();
        var admin = h.NewUser("admin", admin: true);
        var collection = h.Host.AddCollection();
        var access = h.AccessFor(collection, admin);
        var movie = Movie(50);
        var show = SeriesPh(51);
        var season = Season(52, 1);
        var episodes = EpisodesOf(53, 2, 1, 2);
        await Add(h, access, null, movie, show, season, episodes);
        // The season is known to be airing with two expected episodes (Seerr metadata).
        using (await h.Store.LockAsync(access.ListIdN))
        {
            var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Collection);
            var stored = doc.Items.Single(p => p.Id == season.Id);
            stored.InProduction = false;
            stored.Expected = new() { new PlaceholderEpisode { S = 1, E = 1, AirDate = Past }, new PlaceholderEpisode { S = 1, E = 2, AirDate = Past } };
            h.Store.Save(doc);
        }

        var movieItem = h.Host.AddItem(tmdb: 50);
        var seriesItem = h.Host.AddSeries(tmdb: 51);
        var seasonShow = h.Host.AddSeries(tmdb: 52);
        var s1e1 = h.Host.AddEpisode(seasonShow, 1, 1);
        var epShow = h.Host.AddSeries(tmdb: 53);
        var s2e1 = h.Host.AddEpisode(epShow, 2, 1);
        foreach (var id in new[] { movieItem, seriesItem, s1e1, s2e1 })
        {
            h.Swap.NotifyItemChanged(id);
        }

        await h.Swap.DrainAsync(None);
        var seasonItem = h.Host.Seasons[(seasonShow, 1)].Id;
        Assert.Equal(new[] { movieItem, seriesItem, seasonItem, s2e1 }.OrderBy(g => g), h.Host.Resolved(collection.Info.Id).OrderBy(g => g));
        var doc1 = h.Store.Load(access.ListIdN)!;
        Assert.Equal(new[] { season.Id, episodes.Id }.OrderBy(i => i), doc1.Items.Select(p => p.Id).OrderBy(i => i));
        Assert.Single(doc1.Items.Single(p => p.Id == season.Id).Filled);

        var s1e2 = h.Host.AddEpisode(seasonShow, 1, 2);
        var s2e2 = h.Host.AddEpisode(epShow, 2, 2);
        h.Host.Calls.Clear();
        h.Swap.NotifyItemChanged(s1e2);
        h.Swap.NotifyItemChanged(s2e2);
        await h.Swap.DrainAsync(None);
        Assert.Empty(h.Store.Load(access.ListIdN)!.Items);
        Assert.Equal(new[] { $"collection:{FakeListHost.Short(s2e2)}" }, h.Host.Calls); // the Season item isn't added twice
    }

    [Fact]
    public async Task AddingAPartlyPresentSeasonInsertsTheEpisodesAndKeepsAFilledPlaceholder()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.Add(new RawEntry(a, true));
        var access = h.AccessFor(playlist, owner);
        var series = h.Host.AddSeries(tmdb: 60);
        var e2 = h.Host.AddEpisode(series, 1, 2);
        var e1 = h.Host.AddEpisode(series, 1, 1);
        playlist.Raw.Add(new RawEntry(e2, true)); // already in the list: counts as filled, no second copy

        var season = Season(60, 1);
        var result = await Add(h, access, new PositionDto { AtStart = true }, season);

        Assert.Equal(new[] { e1.ToString("N") }, result.AddedAsItems);
        Assert.Equal(new[] { season.Id }, result.Added);
        Assert.Empty(result.Skipped);
        Assert.Equal(new[] { e1, a, e2 }, h.Host.Resolved(playlist.Info.Id));
        Assert.Equal(new[] { E(e1), P(season.Id), E(a), E(e2) }, result.View!.Order);
        Assert.Equal(new[] { (1, 1), (1, 2) }, Stored(h, access, season.Id).Filled.Select(f => (f.S, f.E)).OrderBy(c => c));

        // Adding the same scope again: a duplicate, and its episodes don't go in a second time.
        var again = await Add(h, access, null, Season(60, 1));
        Assert.Equal("duplicate", Assert.Single(again.Skipped).Reason);
        Assert.Empty(again.AddedAsItems);
    }

    [Fact]
    public async Task APlaceholderForMissingEarlyEpisodesGoesBeforeTheEpisodesTheLibraryHas()
    {
        // The DC guide's "My Adventures with Superman": S1E8+ in the library, S1E1–E7 missing. A watch order must start
        // with the missing episodes (the placeholder), not with episode 8.
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var x = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.Add(new RawEntry(x, true));
        var access = h.AccessFor(playlist, owner);
        var series = h.Host.AddSeries(tmdb: 80);
        var s1e8 = h.Host.AddEpisode(series, 1, 8);
        var s1e9 = h.Host.AddEpisode(series, 1, 9);
        var s2e1 = h.Host.AddEpisode(series, 2, 1);

        var show = SeriesPh(80);
        show.EpisodeTotal = 20;
        var season = Season(80, 1);
        season.EpisodeTotal = 10;
        var gap = Season(80, 2);
        gap.EpisodeTotal = 3; // S2E1 present, E2–E3 missing: after E1
        var listed = EpisodesOf(80, 1, 9, 10); // E9 present, E10 missing: after E9
        var result = await Add(h, access, null, show);

        Assert.Equal(new[] { E(x), P(show.Id), E(s1e8), E(s1e9), E(s2e1) }, result.View!.Order);

        foreach (var (ph, expected) in new (Placeholder, string[])[]
        {
            (season, new[] { P(season.Id), E(s1e8), E(s1e9) }),
            (gap, new[] { E(s2e1), P(gap.Id) }),
            (listed, new[] { E(s1e9), P(listed.Id) }),
        })
        {
            var list = h.Host.AddPlaylist(owner);
            var listAccess = h.AccessFor(list, owner);
            var added = await Add(h, listAccess, null, ph);
            Assert.Equal(expected, added.View!.Order);
        }
    }

    [Fact]
    public void TheFirstMissingEpisodeComesFromTheListedOrExpectedEpisodesElseFromGapsBelowTheFilledOnes()
    {
        var series = SeriesPh(1);
        series.Expected = new[] { (1, 1), (1, 2), (2, 1) }.Select(c => new PlaceholderEpisode { S = c.Item1, E = c.Item2 }).ToList();
        series.Filled = new[] { (1, 1), (2, 1) }.Select(c => new FilledEpisode { ItemId = "x", S = c.Item1, E = c.Item2 }).ToList();
        Assert.Equal(new EpisodeCoord(1, 2), PlaceholderProgress.FirstMissing(series));

        // No expected set yet: a season starts at episode 1, a series at season 1.
        var noExpected = SeriesPh(2);
        noExpected.Filled = new[] { (2, 3) }.Select(c => new FilledEpisode { ItemId = "x", S = c.Item1, E = c.Item2 }).ToList();
        Assert.Equal(new EpisodeCoord(1, 1), PlaceholderProgress.FirstMissing(noExpected));
        var season = Season(3, 4);
        season.Filled = new[] { (4, 1), (4, 2) }.Select(c => new FilledEpisode { ItemId = "x", S = c.Item1, E = c.Item2 }).ToList();
        Assert.Null(PlaceholderProgress.FirstMissing(season)); // nothing missing before or between: the rest comes after
        season.EpisodeTotal = 5;
        Assert.Equal(new EpisodeCoord(4, 3), PlaceholderProgress.FirstMissing(season));
        Assert.Null(PlaceholderProgress.FirstMissing(Movie(4)));
    }

    [Fact]
    public async Task AddingACompleteEndedSeasonAddsOnlyTheRealEpisodesAndACollectionGetsTheSeasonItem()
    {
        using var h = new ListsHarness(seerr: true);
        var owner = h.NewUser("owner", admin: true);
        h.TvDetails[70] = TvJson(70, ended: true, s1Count: 2);
        h.SeasonDetails[(70, 1)] = SeasonJson(1, Past, Past);
        var series = h.Host.AddSeries(tmdb: 70);
        var e1 = h.Host.AddEpisode(series, 1, 1);
        var e2 = h.Host.AddEpisode(series, 1, 2);

        var playlist = h.Host.AddPlaylist(owner);
        var playlistResult = await Add(h, h.AccessFor(playlist, owner), null, Season(70, 1));
        Assert.Empty(playlistResult.Added);
        Assert.Equal(new[] { e1, e2 }, h.Host.Resolved(playlist.Info.Id));

        var collection = h.Host.AddCollection();
        var collectionResult = await Add(h, h.AccessFor(collection, owner), null, Season(70, 1));
        Assert.Empty(collectionResult.Added);
        Assert.Equal(new[] { h.Host.Seasons[(series, 1)].Id }, h.Host.Resolved(collection.Info.Id));
    }

    [Fact]
    public async Task LinkingACustomEntryToATitleInTheLibrarySwapsItInAtTheEntrysSpot()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var b = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true) });
        var access = h.AccessFor(playlist, owner);
        var custom = Ph("{\"kind\":\"custom\",\"title\":\"Clayface\"}", owner.Id.ToString("N"));
        var added = await Add(h, access, new PositionDto { AfterToken = E(a) }, custom);
        var clayface = h.Host.AddItem(tmdb: 1239193);

        ListRules.TryNormalize(new NewPlaceholderDto { Kind = "movie", TmdbId = 1239193, Title = "Clayface" }, false, out var link, out _);
        Assert.NotNull(added.View);
        var view = Ok<ListViewDto>(await h.Service.PatchAsync(access, custom.Id, h.Store.Load(access.ListIdN)!.Rev, null, link, null, None)); // rev after the consent save

        Assert.Empty(view.Placeholders);
        Assert.Equal(new[] { a, clayface, b }, h.Host.Resolved(playlist.Info.Id));
        Assert.Equal(new[] { E(a), E(clayface), E(b) }, view.Order);
    }

    [Fact]
    public async Task ANativePlaylistEditReReconcilesTheOrderAndTheFeatureSwitchStopsEverything()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var b = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true) });
        var access = h.AccessFor(playlist, owner);
        var movie = Movie(80);
        await Add(h, access, new PositionDto { AfterToken = E(a) }, movie);

        playlist.Raw.RemoveAt(0); // removed in Jellyfin's own UI: the placeholder re-anchors to the start
        h.Swap.NotifyItemChanged(playlist.Info.Id);
        await h.Swap.DrainAsync(None);
        Assert.Equal(new[] { P(movie.Id), E(b) }, h.Store.Load(access.ListIdN)!.Order);

        h.Plugin.Plugin.Configuration.ArrPhase4ListPlaceholdersEnabled = false;
        var arrived = h.Host.AddItem(tmdb: 80);
        h.Swap.NotifyItemChanged(arrived);
        h.Swap.QueuePass(access.ListIdN, null, MetadataMode.None);
        await h.Swap.DrainAsync(None);
        Assert.Equal(new[] { b }, h.Host.Resolved(playlist.Info.Id));
        Assert.Equal(default, await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None));
    }

    [Fact]
    public void SwapProvenanceOnlyTracksPlaceholdersTheSyncOwns()
    {
        var placeholder = Movie(1);
        placeholder.SourceKey = "movie|1||";
        var doc = new ListDoc { Source = new ListSource(), Items = { placeholder } };
        doc.Source.Owned[placeholder.SourceKey] = new SourceOwnership { PhId = placeholder.Id };
        var aa = Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture);
        var bb = Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture);

        Assert.True(ListSourceOwnership.OnSwapped(doc, placeholder, new[] { aa }));
        Assert.False(ListSourceOwnership.OnSwapped(doc, placeholder, new[] { aa }));
        Assert.Equal(placeholder.Id, doc.Source.Owned[placeholder.SourceKey].PhId);
        doc.Items.Remove(placeholder); // retired: the swap service calls the hook after removing it
        Assert.True(ListSourceOwnership.OnSwapped(doc, placeholder, new[] { bb }));
        Assert.Equal(new[] { aa, bb }, doc.Source.Owned[placeholder.SourceKey].ItemIds);
        Assert.Null(doc.Source.Owned[placeholder.SourceKey].PhId);

        var userAdded = Movie(2);
        Assert.False(ListSourceOwnership.OnSwapped(doc, userAdded, new[] { bb }));
        Assert.False(ListSourceOwnership.OnSwapped(new ListDoc(), placeholder, new[] { bb }));
    }

    [Fact]
    public void RemovingASyncOwnedEntryTombstonesItsKeyAndNothingElse()
    {
        var source = new ListSource();
        source.Owned["movie|1||"] = new SourceOwnership { PhId = "a" };
        var now = new DateTime(2026, 10, 10, 12, 0, 0, DateTimeKind.Utc);
        Assert.True(ListSourceOwnership.OnUserRemoved(source, "movie|1||", now));
        Assert.Empty(source.Owned);
        Assert.Equal(now, DateTime.Parse(source.UserRemovedKeys["movie|1||"], CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal));
        Assert.False(ListSourceOwnership.OnUserRemoved(source, "movie|2||", now)); // not sync-owned: no tombstone
        Assert.Single(source.UserRemovedKeys);
    }

    [Fact]
    public async Task ASyncOwnedPlaceholderRecordsWhatItTurnedIntoInTheSameWrite()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        var movie = Movie(90);
        await Add(h, access, null, movie);
        using (await h.Store.LockAsync(access.ListIdN))
        {
            var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
            doc.Items.Single().SourceKey = "movie|90||";
            doc.Source = new ListSource { Kind = "tmdb", Url = "https://www.themoviedb.org/list/1" };
            doc.Source.Owned["movie|90||"] = new SourceOwnership { PhId = movie.Id };
            h.Store.Save(doc);
        }

        var arrived = h.Host.AddItem(tmdb: 90);
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        var owned = h.Store.Load(access.ListIdN)!.Source!.Owned["movie|90||"];
        Assert.Null(owned.PhId);
        Assert.Equal(new[] { arrived.ToString("N") }, owned.ItemIds);
    }

    [Fact]
    public async Task ListViewsTriggerADebouncedBackgroundPass()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        var movie = Movie(91);
        await Add(h, access, null, movie);
        await h.Swap.DrainAsync(None);
        var arrived = h.Host.AddItem(tmdb: 91); // its library event was missed

        await h.Service.GetViewAsync(access, None);
        await h.Swap.DrainAsync(None);
        Assert.Equal(new[] { arrived }, h.Host.Resolved(playlist.Info.Id));

        // A second view within the interval doesn't queue another pass.
        var second = h.Host.AddPlaylist(owner);
        var secondAccess = h.AccessFor(second, owner);
        await Add(h, secondAccess, null, Movie(92));
        await h.Swap.DrainAsync(None);
        h.Swap.RequestViewPass(secondAccess.ListIdN);
        await h.Swap.DrainAsync(None);
        h.Host.AddItem(tmdb: 92);
        h.Swap.RequestViewPass(secondAccess.ListIdN);
        await h.Swap.DrainAsync(None);
        Assert.Empty(h.Host.Resolved(second.Info.Id));
        h.Swap.UtcNow = () => DateTime.UtcNow + ListSwapService.ViewPassInterval;
        h.Swap.RequestViewPass(secondAccess.ListIdN);
        await h.Swap.DrainAsync(None);
        Assert.Single(h.Host.Resolved(second.Info.Id));
    }

    [Fact]
    public async Task TheMonitorFeedsLibraryEventsToTheWorkerWhichSwapsAfterTheSettleDelay()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        await Add(h, access, null, Movie(95));
        var library = new Mock<ILibraryManager>();
        using var monitor = new ListSwapMonitor(library.Object, h.Swap, h.Plugin.Core.Logger);
        await monitor.StartAsync(None);
        try
        {
            var arrived = h.Host.AddItem(tmdb: 95);
            library.Raise(l => l.ItemAdded += null, library.Object, new ItemChangeEventArgs { Item = new MusicAlbum { Id = Guid.NewGuid() } });
            library.Raise(l => l.ItemUpdated += null, library.Object, new ItemChangeEventArgs { Item = new Movie { Id = arrived } });
            for (var i = 0; i < 100 && h.Host.Resolved(playlist.Info.Id).Count == 0; i++)
            {
                await Task.Delay(50);
            }

            Assert.Equal(new[] { arrived }, h.Host.Resolved(playlist.Info.Id));
        }
        finally
        {
            await monitor.StopAsync(None);
        }

        // Stopped: events are no longer subscribed.
        await Add(h, access, null, Movie(96));
        var later = h.Host.AddItem(tmdb: 96);
        library.Raise(l => l.ItemAdded += null, library.Object, new ItemChangeEventArgs { Item = new Movie { Id = later } });
        await Task.Delay(100);
        Assert.Single(h.Host.Resolved(playlist.Info.Id));
    }

    [Fact]
    public async Task TheHostedServicesSurviveBeingDisposedTwice()
    {
        // The lifecycle is registered as a singleton AND a hosted service, so the container disposes it twice.
        using var h = new ListsHarness();
        var library = new Mock<ILibraryManager>();
        var lifecycle = new ListLifecycle(library.Object, h.Store, h.Host, h.Plugin.Core.Logger);
        await lifecycle.StartAsync(None);
        await lifecycle.StopAsync(None);
        lifecycle.Dispose();
        lifecycle.Dispose();

        var monitor = new ListSwapMonitor(library.Object, h.Swap, h.Plugin.Core.Logger);
        await monitor.StartAsync(None);
        monitor.Dispose();
        monitor.Dispose();
        await monitor.StopAsync(None);
        h.Swap.Dispose();
        h.Swap.Dispose();
        h.Swap.NotifyItemChanged(Guid.NewGuid()); // after disposal: ignored, no throw
    }

    [Fact]
    public async Task AnArrivalShowsAsAvailableDuringTheSettleDelayBeforeItIsSwappedIn()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        var movie = Movie(97);
        await Add(h, access, null, movie);
        await h.Swap.DrainAsync(None);
        h.Swap.SettleDelay = TimeSpan.FromSeconds(1);
        h.Swap.Start();
        try
        {
            var arrived = h.Host.AddItem(tmdb: 97);
            h.Swap.NotifyItemChanged(arrived);
            Guid? pending = null;
            for (var i = 0; i < 100 && pending == null; i++)
            {
                pending = h.Swap.GetPendingMatch(access.ListIdN, movie.Id);
                await Task.Delay(10);
            }

            Assert.Equal(arrived, pending);
            var view = await h.Service.GetViewAsync(access, None);
            Assert.Equal(arrived.ToString("N"), view.Placeholders.Single().InLibraryItemId);
            for (var i = 0; i < 100 && h.Host.Resolved(playlist.Info.Id).Count == 0; i++)
            {
                await Task.Delay(50);
            }

            Assert.Equal(new[] { arrived }, h.Host.Resolved(playlist.Info.Id));
            Assert.Null(h.Swap.GetPendingMatch(access.ListIdN, movie.Id));
        }
        finally
        {
            await h.Swap.StopAsync(None);
        }
    }

    [Fact]
    public async Task ACollectionGetsAPartlyPresentSeasonsItemAndAFailedInsertLeavesNothingMarkedFilled()
    {
        using var h = new ListsHarness();
        var admin = h.NewUser("admin", admin: true);
        var series = h.Host.AddSeries(tmdb: 98);
        var e1 = h.Host.AddEpisode(series, 1, 1);
        var collection = h.Host.AddCollection();
        var season = Season(98, 1);
        var result = await Add(h, h.AccessFor(collection, admin), null, season);
        var seasonItem = h.Host.Seasons[(series, 1)].Id;
        Assert.Equal(new[] { seasonItem.ToString("N") }, result.AddedAsItems);
        Assert.Equal(new[] { season.Id }, result.Added);
        var stored = Stored(h, h.AccessFor(collection, admin), season.Id);
        Assert.Equal(new[] { (e1.ToString("N"), 1, 1) }, stored.Filled.Select(f => (f.ItemId, f.S, f.E)));

        // Jellyfin throws while inserting the present episodes: the placeholder is kept, but nothing counts as filled.
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        h.Host.FailAdds = new InvalidOperationException("boom");
        var failed = await h.Service.AddPlaceholdersAsync(access, new[] { Season(98, 1) }, null, null, null, None);
        Assert.Equal(500, failed.StatusCode);
        await h.Consent(access);
        var kept = h.Store.Load(access.ListIdN)!.Items.Single();
        Assert.Empty(kept.Filled);
        Assert.Empty(h.Host.Resolved(playlist.Info.Id));

        // The next pass inserts it once Jellyfin works again.
        h.Host.FailAdds = null;
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        Assert.Equal(new[] { e1 }, h.Host.Resolved(playlist.Info.Id));
        Assert.Single(h.Store.Load(access.ListIdN)!.Items.Single().Filled);
    }

    [Fact]
    public async Task ASeasonReadFailureDuringACompletionCheckNeverRetiresAnAiringSeason()
    {
        using var h = new ListsHarness(seerr: true);
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        h.TvDetails[120] = TvJson(120, ended: false, nextAir: Future, s1Count: 3);
        h.SeasonDetails[(120, 1)] = SeasonJson(1, Past, Past, Future);
        var season = Season(120, 1);
        await Add(h, access, null, season);
        await h.Swap.DrainAsync(None);
        var series = h.Host.AddSeries(tmdb: 120);
        foreach (var e in new[] { 1, 2 })
        {
            h.Swap.NotifyItemChanged(h.Host.AddEpisode(series, 1, e));
        }

        await h.Swap.DrainAsync(None);
        Assert.Equal(2, Stored(h, access, season.Id).Filled.Count);

        // E03 airs today and arrives; the show details say so, but the season details fail (Seerr relays a TMDB 429
        // as 500). Before, the expected set shrank to [E03] and the "fresh" data retired the season.
        var today = DateTime.UtcNow.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        h.TvDetails[120] = TvJson(120, ended: false, nextAir: today, s1Count: 4);
        h.SeasonDetails.Remove((120, 1));
        h.Swap.NotifyItemChanged(h.Host.AddEpisode(series, 1, 3));
        await h.Swap.DrainAsync(None);
        await h.Swap.DrainAsync(None); // the forced refresh the unexpected fill queued
        Assert.Contains(h.SeerrCalls, c => c == "/api/v1/tv/120/season/1");

        var stored = Stored(h, access, season.Id);
        Assert.Equal(new[] { 1, 2, 3 }, stored.Expected.Select(e => e.E));
        Assert.Equal(3, stored.Filled.Count);
        Assert.Equal(3, h.Host.Resolved(playlist.Info.Id).Count);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ANativeEditLandingRightAfterTheInsertNeverMovesTheNewItemAwayFromItsAnchor(bool positional)
    {
        using var h = new ListsHarness();
        h.Host.SupportsPositionalInsert = positional;
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var b = h.Host.AddItem();
        var x = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true) });
        var access = h.AccessFor(playlist, owner);
        var movie = Movie(134);
        await Add(h, access, new PositionDto { AfterToken = E(a) }, movie);

        // The user adds X at the start in jellyfin-web between JE's insert and its re-read.
        h.Host.AfterAdd = id => playlist.Raw.Insert(0, new RawEntry(x, true));
        var arrived = h.Host.AddItem(tmdb: 134);
        h.Swap.NotifyItemChanged(arrived);
        h.Host.Calls.Clear();
        await h.Swap.DrainAsync(None);

        Assert.Equal(new[] { x, a, arrived, b }, h.Host.Resolved(playlist.Info.Id));
        Assert.Equal(new[] { E(x), E(a), E(arrived), E(b) }, h.Store.Load(access.ListIdN)!.Order);
        Assert.DoesNotContain(h.Host.Calls, c => c.StartsWith($"move:{FakeListHost.Short(arrived)}->", StringComparison.Ordinal) && !c.EndsWith("->2", StringComparison.Ordinal));

        // Jellyfin also put the item at the end: the repair move targets the anchor's place in the CURRENT rows.
        var movie2 = Movie(135);
        await Add(h, access, new PositionDto { AfterToken = E(a) }, movie2);
        var y = h.Host.AddItem();
        h.Host.AfterAdd = id =>
        {
            playlist.Raw.Insert(0, new RawEntry(y, true));
            var landed = playlist.Raw.FindIndex(r => r.ItemId == h.Host.MoviesByTmdb[135]);
            var entry = playlist.Raw[landed];
            playlist.Raw.RemoveAt(landed);
            playlist.Raw.Add(entry);
        };
        var arrived2 = h.Host.AddItem(tmdb: 135);
        h.Swap.NotifyItemChanged(arrived2);
        await h.Swap.DrainAsync(None);
        Assert.Equal(new[] { y, x, a, arrived2, arrived, b }, h.Host.Resolved(playlist.Info.Id));
        h.Host.AfterAdd = null;
    }

    [Fact]
    public async Task AnEndedShowWhoseSeasonReadFailsNeverRetiresASeasonOnItsStaleExpectedSet()
    {
        using var h = new ListsHarness(seerr: true);
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        // E01–E03 aired, E04–E08 still "TBA" on TMDB.
        h.TvDetails[121] = TvJson(121, ended: false, s1Count: 8);
        h.SeasonDetails[(121, 1)] = SeasonJson(1, Past, Past, Past, null, null, null, null, null);
        var season = Season(121, 1);
        await Add(h, access, null, season);
        await h.Swap.DrainAsync(None);
        var series = h.Host.AddSeries(tmdb: 121);
        foreach (var e in new[] { 1, 2, 3 })
        {
            h.Swap.NotifyItemChanged(h.Host.AddEpisode(series, 1, e));
        }

        await h.Swap.DrainAsync(None);
        Assert.Equal(3, Stored(h, access, season.Id).Filled.Count);
        Assert.True(Stored(h, access, season.Id).InProduction);

        // The finale airs and TMDB marks the show Ended, but the season read fails (TMDB 429 relayed as 500).
        h.TvDetails[121] = TvJson(121, ended: true, s1Count: 8);
        h.SeasonDetails.Remove((121, 1));
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.Force | MetadataMode.Maintenance, None);
        await h.Swap.DrainAsync(None);
        Assert.Contains(h.SeerrCalls, c => c == "/api/v1/tv/121/season/1");

        var stored = Stored(h, access, season.Id); // still there, still waiting for E04–E08
        Assert.True(stored.InProduction);
        Assert.Equal(8, stored.Expected.Count);
        Assert.Equal(3, stored.Filled.Count);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AFilledEpisodeReplacedInTheLibraryIsSwappedInAgainButAHandRemovalIsRespected(bool collection)
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner", admin: true);
        var list = collection ? h.Host.AddCollection() : h.Host.AddPlaylist(owner);
        var access = h.AccessFor(list, owner);
        var season = Season(130, 1);
        await Add(h, access, null, season);
        var series = h.Host.AddSeries(tmdb: 130);
        var old = h.Host.AddEpisode(series, 1, 1);
        var e2 = h.Host.AddEpisode(series, 1, 2);
        h.Swap.NotifyItemChanged(old);
        h.Swap.NotifyItemChanged(e2);
        await h.Swap.DrainAsync(None);
        Assert.Equal(new[] { old.ToString("N"), e2.ToString("N") }, Stored(h, access, season.Id).Filled.Select(f => f.ItemId));

        // Sonarr upgrades E01 under a new file name: Jellyfin creates a new item and removes the old one (its link
        // dangles). The user also removed E02 from the list by hand.
        h.Host.Items.Remove(old);
        h.Host.Episodes.RemoveAll(e => e.Id == old);
        var replaced = list.Raw.FindIndex(r => r.ItemId == old);
        if (replaced >= 0)
        {
            list.Raw[replaced] = new RawEntry(old, false);
        }

        // (In a collection E02 is there through the Season item, which the user removed instead.)
        var seasonItem = h.Host.Seasons[(series, 1)].Id;
        list.Raw.RemoveAll(r => r.ItemId == (collection ? seasonItem : e2));
        var upgrade = h.Host.AddEpisode(series, 1, 1);
        h.Swap.NotifyItemChanged(upgrade);
        h.Swap.NotifyItemChanged(seasonItem); // the scan updates the Season item too
        h.Host.Calls.Clear();
        await h.Swap.DrainAsync(None);

        Assert.Equal(new[] { upgrade.ToString("N"), e2.ToString("N") }, Stored(h, access, season.Id).Filled.Select(f => f.ItemId));
        Assert.Null(h.Swap.GetPendingMatch(access.ListIdN, season.Id));
        if (collection)
        {
            // The removed Season item isn't put back: the upgrade is no arrival for it.
            Assert.Empty(h.Host.Resolved(list.Info.Id));
            Assert.Empty(h.Host.Calls);
            Assert.Equal(default, await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None));
            Assert.Empty(h.Host.Calls);

            // A new episode is an arrival: the Season item goes in again with it.
            var e3 = h.Host.AddEpisode(series, 1, 3);
            h.Swap.NotifyItemChanged(e3);
            await h.Swap.DrainAsync(None);
            Assert.Equal(new[] { seasonItem }, h.Host.Resolved(list.Info.Id));
            Assert.Equal(3, Stored(h, access, season.Id).Filled.Count);
        }
        else
        {
            Assert.Equal(new[] { upgrade }, h.Host.Resolved(list.Info.Id)); // E02 isn't put back
        }
    }

    [Fact]
    public async Task AnEpisodeRemovedFromACollectionByHandIsNotPutBack()
    {
        using var h = new ListsHarness();
        var admin = h.NewUser("admin", admin: true);
        var collection = h.Host.AddCollection();
        var access = h.AccessFor(collection, admin);
        var episodes = EpisodesOf(131, 1, 1, 2, 3);
        await Add(h, access, null, episodes);
        var series = h.Host.AddSeries(tmdb: 131);
        var e1 = h.Host.AddEpisode(series, 1, 1);
        var e2 = h.Host.AddEpisode(series, 1, 2);
        h.Swap.NotifyItemChanged(e1);
        h.Swap.NotifyItemChanged(e2);
        await h.Swap.DrainAsync(None);
        Assert.Equal(new[] { e1, e2 }, h.Host.Resolved(collection.Info.Id));

        collection.Raw.RemoveAll(r => r.ItemId == e1);
        var e3 = h.Host.AddEpisode(series, 1, 3);
        h.Swap.NotifyItemChanged(e3);
        h.Swap.NotifyItemChanged(e1); // a metadata refresh of the removed one
        h.Host.Calls.Clear();
        await h.Swap.DrainAsync(None);

        Assert.Equal(new[] { $"collection:{FakeListHost.Short(e3)}" }, h.Host.Calls);
        Assert.Equal(new[] { e2, e3 }, h.Host.Resolved(collection.Info.Id));
        Assert.Empty(h.Store.Load(access.ListIdN)!.Items); // every listed episode is filled: retired
    }

    [Fact]
    public async Task ACollectionSeasonSpreadOverTwoCopiesOfTheShowCountsEachEpisodeThroughItsOwnSeasonItem()
    {
        using var h = new ListsHarness();
        var admin = h.NewUser("admin", admin: true);
        var collection = h.Host.AddCollection();
        var access = h.AccessFor(collection, admin);
        var season = Season(132, 1);
        await Add(h, access, null, season);

        // A 4K library has only E01, the HD library E01–E03 (Jellyfin 12 keeps them as separate series/seasons).
        var uhd = h.Host.AddSeries(tmdb: 132);
        var uhdE1 = h.Host.AddEpisode(uhd, 1, 1);
        var hd = h.Host.AddSeries(tmdb: 132);
        var hdEpisodes = new[] { 1, 2, 3 }.Select(e => h.Host.AddEpisode(hd, 1, e)).ToList();
        h.Swap.NotifyItemChanged(uhdE1);
        foreach (var id in hdEpisodes)
        {
            h.Swap.NotifyItemChanged(id);
        }

        await h.Swap.DrainAsync(None);
        // The copy holding the most goes in alone, and the episodes count through it.
        Assert.Equal(new[] { h.Host.Seasons[(hd, 1)].Id }, h.Host.Resolved(collection.Info.Id));
        Assert.Equal(hdEpisodes.Select(id => id.ToString("N")), Stored(h, access, season.Id).Filled.Select(f => f.ItemId));

        // E04 exists only in the 4K copy: its Season item goes in for it.
        var uhdE4 = h.Host.AddEpisode(uhd, 1, 4);
        h.Swap.NotifyItemChanged(uhdE4);
        await h.Swap.DrainAsync(None);
        Assert.Equal(new[] { h.Host.Seasons[(hd, 1)].Id, h.Host.Seasons[(uhd, 1)].Id }, h.Host.Resolved(collection.Info.Id));
        Assert.Equal(
            hdEpisodes.Select(id => id.ToString("N")).Append(uhdE4.ToString("N")),
            Stored(h, access, season.Id).Filled.Select(f => f.ItemId));
    }

    [Fact]
    public async Task AddingACollectionSeasonSpreadOverTwoCopiesMarksOnlyWhatTheLandedSeasonItemsHold()
    {
        using var h = new ListsHarness();
        var admin = h.NewUser("admin", admin: true);
        var uhd = h.Host.AddSeries(tmdb: 133);
        var uhdE1 = h.Host.AddEpisode(uhd, 1, 1);
        var hd = h.Host.AddSeries(tmdb: 133);
        var hdE2 = h.Host.AddEpisode(hd, 1, 2);
        var hdE3 = h.Host.AddEpisode(hd, 1, 3);
        var collection = h.Host.AddCollection();
        var access = h.AccessFor(collection, admin);

        var uhdSeason = h.Host.Seasons[(uhd, 1)].Id;
        var hdSeason = h.Host.Seasons[(hd, 1)].Id;

        // Jellyfin doesn't take the 4K Season item (e.g. it went away between resolution and insert).
        h.Host.CollectionDrops.Add(uhdSeason);
        await Add(h, access, null, Season(133, 1));
        Assert.Equal(new[] { hdSeason }, h.Host.Resolved(collection.Info.Id));
        var stored = h.Store.Load(access.ListIdN)!.Items.Single();
        Assert.Equal(new[] { (hdE2.ToString("N"), 2), (hdE3.ToString("N"), 3) }, stored.Filled.Select(f => (f.ItemId, f.E)));

        // Once Jellyfin takes it, a pass adds it and E01 counts.
        h.Host.CollectionDrops.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        Assert.Equal(new[] { hdSeason, uhdSeason }, h.Host.Resolved(collection.Info.Id));
        Assert.Equal(new[] { uhdE1.ToString("N"), hdE2.ToString("N"), hdE3.ToString("N") }, Stored(h, access, stored.Id).Filled.Select(f => f.ItemId));
    }

    [Fact]
    public async Task ACompleteScopeWhoseEpisodesJellyfinRejectsKeepsItsPlaceholder()
    {
        using var h = new ListsHarness(seerr: true);
        var owner = h.NewUser("owner");
        h.TvDetails[140] = TvJson(140, ended: true, s1Count: 2);
        h.SeasonDetails[(140, 1)] = SeasonJson(1, Past, Past);
        var series = h.Host.AddSeries(tmdb: 140);
        var e1 = h.Host.AddEpisode(series, 1, 1);
        var e2 = h.Host.AddEpisode(series, 1, 2);
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);

        // The owner's parental policy changes between resolution and the locked insert: Jellyfin drops E01.
        h.Host.BeforeAdd = (_, _, _) =>
        {
            h.Host.Hide(e1, owner);
            return Task.CompletedTask;
        };
        var season = Season(140, 1);
        var result = await Add(h, access, null, season);
        Assert.Equal(new[] { e2 }, h.Host.Resolved(playlist.Info.Id));
        Assert.Equal(new[] { e2.ToString("N") }, result.AddedAsItems);
        Assert.Equal(new[] { season.Id }, result.Added); // still tracked: swap-in adds E01 once the owner may see it
        Assert.Empty(result.Skipped);
        Assert.Equal(new[] { (1, 2) }, Stored(h, access, season.Id).Filled.Select(f => (f.S, f.E)));

        // Jellyfin throws: the scope stays tracked too.
        h.Host.BeforeAdd = null;
        h.Host.HiddenFrom.Clear();
        var second = h.Host.AddPlaylist(owner);
        var secondAccess = h.AccessFor(second, owner);
        h.Host.FailAdds = new InvalidOperationException("database is locked");
        var failed = await h.Service.AddPlaceholdersAsync(secondAccess, new[] { Season(140, 1) }, null, null, null, None);
        Assert.Equal(500, failed.StatusCode);
        Assert.Empty(h.Store.Load(secondAccess.ListIdN)!.Items.Single().Filled);

        // When everything lands, the placeholder doesn't stay.
        h.Host.FailAdds = null;
        var third = h.Host.AddPlaylist(owner);
        var thirdResult = await Add(h, h.AccessFor(third, owner), null, Season(140, 1));
        Assert.Empty(thirdResult.Added);
        Assert.Null(h.Store.Load(h.AccessFor(third, owner).ListIdN));
    }

    [Fact]
    public async Task AnOwnerlessPlaylistNeverShowsAMatchAsBeingAdded()
    {
        using var h = new ListsHarness();
        var admin = h.NewUser("admin", admin: true);
        var deleted = FakeListHost.MakeUser("deleted"); // not known to the user manager any more
        var playlist = h.Host.AddPlaylist(deleted, openAccess: true);
        var access = h.AccessFor(playlist, admin);
        Assert.True(access.Permissions.CanEdit);
        var movie = Movie(150);
        await Add(h, access, null, movie);

        var arrived = h.Host.AddItem(tmdb: 150);
        h.Swap.NotifyItemChanged(arrived);
        await h.Swap.DrainAsync(None);
        Assert.Null(h.Swap.GetPendingMatch(access.ListIdN, movie.Id));
        Assert.Null((await h.Service.GetViewAsync(access, None)).Placeholders.Single().InLibraryItemId);
        Assert.Empty(h.Host.Resolved(playlist.Info.Id));
    }

    [Fact]
    public async Task FilledCountsOnlyEpisodesTheCallerCanAccess()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var viewer = h.NewUser("viewer");
        var playlist = h.Host.AddPlaylist(owner, openAccess: true);
        var access = h.AccessFor(playlist, owner);
        var season = Season(160, 1);
        await Add(h, access, null, season);
        var series = h.Host.AddSeries(tmdb: 160);
        var episodes = new[] { 1, 2, 3 }.Select(e => h.Host.AddEpisode(series, 1, e)).ToList();
        foreach (var episode in episodes)
        {
            h.Host.Hide(episode, viewer); // a library the viewer can't access
            h.Swap.NotifyItemChanged(episode);
        }

        await h.Swap.DrainAsync(None);
        Assert.Equal(3, (await h.Service.GetViewAsync(access, None)).Placeholders.Single().FilledCount);
        var viewerView = await h.Service.GetViewAsync(h.AccessFor(playlist, viewer), None);
        Assert.Equal(new[] { P(season.Id) }, viewerView.Order);
        Assert.Equal(0, viewerView.Placeholders.Single().FilledCount);

        // Collections: the episodes behind a season's progress count only when the caller can access them.
        var admin = h.NewUser("admin", admin: true);
        var collection = h.Host.AddCollection();
        var collectionSeason = Season(160, 1);
        await Add(h, h.AccessFor(collection, admin), null, collectionSeason);
        Assert.Equal(3, (await h.Service.GetViewAsync(h.AccessFor(collection, admin), None)).Placeholders.Single().FilledCount);
        var viewerCollection = await h.Service.GetViewAsync(h.AccessFor(collection, viewer), None);
        Assert.Equal(0, viewerCollection.Placeholders.Single().FilledCount);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AnEntryAlreadyInTheListSatisfiesASyncOwnedPlaceholderWithoutBecomingSyncOwned(bool collection)
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner", admin: true);
        var list = collection ? h.Host.AddCollection() : h.Host.AddPlaylist(owner);
        var access = h.AccessFor(list, owner);
        var movie = Movie(170);
        var season = Season(171, 1);
        await Add(h, access, null, movie, season);
        using (await h.Store.LockAsync(access.ListIdN))
        {
            var doc = h.Store.LoadForUpdate(access.ListIdN, list.Info.Kind);
            doc.Source = new ListSource { Kind = "tmdb", Url = "https://www.themoviedb.org/list/1" };
            foreach (var (placeholder, key) in new[] { (movie, "movie|170||"), (season, "tv|171|1|") })
            {
                doc.Items.Single(p => p.Id == placeholder.Id).SourceKey = key;
                doc.Source.Owned[key] = new SourceOwnership { PhId = placeholder.Id };
            }

            h.Store.Save(doc);
        }

        // The user added both by hand meanwhile.
        var arrived = h.Host.AddItem(tmdb: 170);
        var series = h.Host.AddSeries(tmdb: 171);
        var e1 = h.Host.AddEpisode(series, 1, 1);
        list.Raw.Add(new RawEntry(arrived, true));
        list.Raw.Add(new RawEntry(collection ? h.Host.Seasons[(series, 1)].Id : e1, true));
        h.Host.Calls.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);

        Assert.Empty(h.Host.Calls);
        var after = h.Store.Load(access.ListIdN)!;
        Assert.DoesNotContain(after.Items, p => p.Id == movie.Id);
        Assert.Null(after.Source!.Owned["movie|170||"].PhId);
        Assert.Empty(after.Source.Owned["movie|170||"].ItemIds); // presence, not ownership: removeDropped must not touch it
        Assert.Single(after.Items.Single(p => p.Id == season.Id).Filled);
        Assert.Empty(after.Source.Owned["tv|171|1|"].ItemIds);

        // What swap-in itself adds is owned.
        var e2 = h.Host.AddEpisode(series, 1, 2);
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        var owned = h.Store.Load(access.ListIdN)!.Source!.Owned["tv|171|1|"].ItemIds;
        Assert.Equal(collection ? Array.Empty<string>() : new[] { e2.ToString("N") }, owned); // a collection's Season item was already there
    }

    [Fact]
    public async Task AMovieKnownOnlyByItsImdbIdIsMatchedFromItsLibraryEvent()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        var movie = Movie(180);
        movie.ImdbId = "tt0111161";
        await Add(h, access, null, movie);

        var arrived = h.Host.AddMovie(imdb: "tt0111161"); // the library has no TMDB id for it
        h.Swap.NotifyItemChanged(arrived);
        await h.Swap.DrainAsync(None);

        Assert.Equal(new[] { arrived }, h.Host.Resolved(playlist.Info.Id));
        Assert.Empty(h.Store.Load(access.ListIdN)!.Items);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ASwapAfterARowTheOwnerCantSeeUsesTheOwnersCoordinates(bool positional)
    {
        using var h = new ListsHarness();
        h.Host.SupportsPositionalInsert = positional;
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var hidden = h.Host.AddItem();
        var b = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(hidden, true), new RawEntry(b, true) });
        var access = h.AccessFor(playlist, owner);
        var movie = Movie(190);
        await Add(h, access, new PositionDto { AfterToken = E(hidden) }, movie);
        h.Host.Hide(hidden, owner); // e.g. a parental rating the owner's policy now blocks

        var arrived = h.Host.AddItem(tmdb: 190);
        h.Host.Calls.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);

        var m = FakeListHost.Short(arrived);
        // jf12: a raw position, which counts the hidden row. jf10: Move counts only rows the owner sees and no single
        // index lands after the hidden row, so it goes there in two moves (via the top). Both: exactly at the spot.
        Assert.Equal(positional ? new[] { $"add:{m}@2" } : new[] { $"add:{m}@end", $"move:{m}->0", $"move:{m}->2" }, h.Host.Calls);
        Assert.Equal(new[] { a, hidden, arrived, b }, h.Host.Resolved(playlist.Info.Id));

        var doc = h.Store.Load(access.ListIdN)!;
        Assert.Empty(doc.Items);
        Assert.Equal(h.Host.Resolved(playlist.Info.Id).Select(id => E(id)), doc.Order);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ASwapNextToADuplicatedItemAnchorsOnTheRightOccurrence(bool positional)
    {
        using var h = new ListsHarness();
        h.Host.SupportsPositionalInsert = positional;
        var owner = h.NewUser("owner");
        var a = h.Host.AddItem();
        var b = h.Host.AddItem();
        var c = h.Host.AddItem();
        var playlist = h.Host.AddPlaylist(owner);
        playlist.Raw.AddRange(new[] { new RawEntry(a, true), new RawEntry(b, true), new RawEntry(a, true), new RawEntry(c, true) });
        var access = h.AccessFor(playlist, owner);
        var movie = Movie(200);
        await Add(h, access, new PositionDto { AfterToken = E(a, 1) }, movie);
        Assert.Equal(new[] { E(a), E(b), E(a, 1), P(movie.Id), E(c) }, h.Store.Load(access.ListIdN)!.Order);

        var arrived = h.Host.AddItem(tmdb: 200);
        h.Host.Calls.Clear();
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);

        var m = FakeListHost.Short(arrived);
        // jf10's Move finds the prior row by item id, so no single move lands after the SECOND copy; two moves do.
        Assert.Equal(
            positional ? new[] { $"add:{m}@3" } : new[] { $"add:{m}@end", $"move:{m}->0", $"move:{m}->3" },
            h.Host.Calls);
        Assert.Equal(new[] { a, b, a, arrived, c }, h.Host.Resolved(playlist.Info.Id));
        Assert.Equal(new[] { E(a), E(b), E(a, 1), E(arrived), E(c) }, h.Store.Load(access.ListIdN)!.Order);
    }
}
