using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace JE.Tests;

/// <summary>
/// Phase 4e: what writes stamp facts. "New for you" for a person's own earlier interest in a title's first arrival
/// (judged once, after the media probe), "Upgraded" only for an arr import paired with a file the arr deleted for
/// "Upgrade" once Jellyfin has the file; nothing at all while acquisition badges are off.
/// </summary>
public class IntegrationAcquisitionStampFeederTests
{
    private static readonly DateTime T0 = StampWorld.T0;

    private static IReadOnlyList<StampFact> News(StampWorld w, StampItem item) => w.Store.FactsFor(item.Id).Where(f => f.Kind == AcquisitionStampKinds.New).ToList();

    // ── 11. judging an arrival ───────────────────────────────────────────

    [Fact]
    public void AnInterestMadeBeforeAFirstArrivalGivesThatPersonANewFactAndNobodyElse()
    {
        using var w = new StampWorld();
        var key = StampWorld.Movie(603);
        var movie = w.AddMovie(key, T0.AddHours(-1));
        var (early, late, locked, bystander) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        w.Interests.Add(key, StampWorld.Interest(early, T0.AddDays(-2), source: "seerr"));
        w.Interests.Add(key, StampWorld.Interest(late, T0.AddMinutes(-30)));     // asked after it arrived
        w.Interests.Add(key, StampWorld.Interest(locked, T0.AddDays(-2)));
        w.Library.Deny(locked, movie.Id);

        Assert.False(w.Store.Seen(movie.Id));
        Assert.Equal(AcquisitionStampFeeder.Outcome.Done, w.Feeder.Judge(movie.Id, T0));

        var fact = Assert.Single(News(w, movie));
        Assert.Equal((early, movie.DateCreated), (fact.UserId, fact.At));
        Assert.True(w.Store.Seen(movie.Id));
        Assert.Equal(AcquisitionStamp.NewForYou, w.Resolver.Resolve(movie.Id, early, T0));
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(movie.Id, bystander, T0));
    }

    [Fact]
    public void AFollowOfOneSeasonDoesNotCoverAnotherSeasonsEpisode()
    {
        using var w = new StampWorld();
        var key = StampWorld.Show(81189);
        var series = w.AddSeries(key);
        var s1e1 = w.AddEpisode(series, null, 1, 1, T0.AddHours(-1));
        var s2e1 = w.AddEpisode(series, null, 2, 1, T0.AddHours(-1));
        var s2e5 = w.AddEpisode(series, null, 2, 5, T0.AddHours(-1), end: 6);
        var (season2, single, all) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        w.Interests.Add(key, StampWorld.Interest(season2, T0.AddDays(-1), seasons: new[] { 2 }, source: "follow"));
        w.Interests.Add(key, StampWorld.Interest(single, T0.AddDays(-1), episodes: new[] { (2, 6) }));
        w.Interests.Add(key, StampWorld.Interest(all, T0.AddDays(-1), allSeasons: true, source: "follow"));

        foreach (var e in new[] { s1e1, s2e1, s2e5 }) w.Feeder.Judge(e.Id, T0);

        Assert.Equal(new[] { all }, News(w, s1e1).Select(f => f.UserId));
        Assert.Equal(new[] { season2, all }.OrderBy(x => x), News(w, s2e1).Select(f => f.UserId).OrderBy(x => x));
        Assert.Equal(new[] { season2, single, all }.OrderBy(x => x), News(w, s2e5).Select(f => f.UserId).OrderBy(x => x));   // E6 is inside the E5-E6 file
    }

    [Fact]
    public void AFourKOnlyInterestIgnoresAStandardCopyAndTakesTheFirstFourKOne()
    {
        using var w = new StampWorld();
        var key = StampWorld.Movie(603);
        var (uhdFan, anyFan) = (Guid.NewGuid(), Guid.NewGuid());
        w.Interests.Add(key, StampWorld.Interest(uhdFan, T0.AddDays(-5), fourKOnly: true));
        w.Interests.Add(key, StampWorld.Interest(anyFan, T0.AddDays(-5)));

        var standard = w.AddMovie(key, T0.AddHours(-3));
        w.Feeder.Judge(standard.Id, T0.AddHours(-2));
        Assert.Equal(new[] { anyFan }, News(w, standard).Select(f => f.UserId));

        var uhd = w.AddMovie(key, T0.AddHours(-1), fourK: true);
        w.Feeder.Judge(uhd.Id, T0);
        // The 4K fan's first 4K copy; the standard fan already had a copy (any edition counts for them).
        Assert.Equal(new[] { uhdFan }, News(w, uhd).Select(f => f.UserId));
    }

    [Fact]
    public void AStandardInterestGetsNothingWhenACopyOfAnyEditionArrivedEarlier()
    {
        using var w = new StampWorld();
        var user = Guid.NewGuid();
        // Control: no earlier copy, a New fact.
        var fresh = StampWorld.Movie(1);
        w.Interests.Add(fresh, StampWorld.Interest(user, T0.AddDays(-60)));
        var freshCopy = w.AddMovie(fresh, T0.AddHours(-1));
        w.Feeder.Judge(freshCopy.Id, T0);
        Assert.Single(News(w, freshCopy));

        // An older 4K copy still in the library (never judged): a later standard copy isn't a first arrival.
        var owned = StampWorld.Movie(2);
        w.Interests.Add(owned, StampWorld.Interest(user, T0.AddDays(-60)));
        w.AddMovie(owned, T0.AddDays(-30), fourK: true);
        var second = w.AddMovie(owned, T0.AddHours(-1));
        w.Feeder.Judge(second.Id, T0);
        Assert.Empty(News(w, second));

        // A copy removed before the new one arrived (an upgrade the arr renamed: a new item id) was recorded on removal.
        var renamed = StampWorld.Movie(3);
        w.Interests.Add(renamed, StampWorld.Interest(user, T0.AddDays(-60)));
        var old = w.AddMovie(renamed, T0.AddDays(-30));
        w.Library.RaiseRemoved(old);
        var replacement = w.AddMovie(renamed, T0.AddHours(-1));
        w.Feeder.Judge(replacement.Id, T0);
        Assert.Empty(News(w, replacement));
        Assert.True(w.Store.Seen(replacement.Id));
    }

    [Fact]
    public void AnUnprobedItemIsJudgedLaterOnceItsSizeIsKnown()
    {
        using var w = new StampWorld();
        var key = StampWorld.Movie(603);
        var user = Guid.NewGuid();
        w.Interests.Add(key, StampWorld.Interest(user, T0.AddDays(-1), fourKOnly: true));
        var unprobed = w.Library.Put(new StampItem { Id = Guid.NewGuid(), Kind = "movie", Keys = new[] { key }, DateCreated = T0.AddMinutes(-5) });

        Assert.Equal(AcquisitionStampFeeder.Outcome.Later, w.Feeder.Judge(unprobed.Id, T0));
        Assert.False(w.Store.Seen(unprobed.Id));
        Assert.Empty(w.Store.FactsFor(unprobed.Id));
        Assert.Null(w.Store.FirstArrival(AcquisitionStampStore.PartKeys(unprobed)));   // no edition recorded before it's known

        w.Library.Put(unprobed with { Width = 3840, Height = 2160 });
        Assert.Equal(AcquisitionStampFeeder.Outcome.Done, w.Feeder.Judge(unprobed.Id, T0.AddMinutes(1)));
        Assert.Single(News(w, unprobed));

        // Still unprobed after ten minutes: judged as it is (standard), so it doesn't wait forever.
        var stuck = w.Library.Put(new StampItem { Id = Guid.NewGuid(), Kind = "movie", Keys = new[] { StampWorld.Movie(7) }, DateCreated = T0.AddMinutes(-11) });
        Assert.Equal(AcquisitionStampFeeder.Outcome.Done, w.Feeder.Judge(stuck.Id, T0));
        Assert.Equal(AcquisitionStampFeeder.Outcome.Skipped, w.Feeder.Judge(Guid.NewGuid(), T0));
        var virtualEpisode = w.Library.Put(new StampItem { Id = Guid.NewGuid(), Kind = "episode", Keys = new[] { StampWorld.Show(1) }, Season = 1, Episode = 1, Virtual = true, DateCreated = T0 });
        Assert.Equal(AcquisitionStampFeeder.Outcome.Skipped, w.Feeder.Judge(virtualEpisode.Id, T0));
    }

    [Fact]
    public void NoNewForAnUpgradedItemAnItemOlderThanTheLifetimeOrOneThePersonCannotOpen()
    {
        using var w = new StampWorld();
        var user = Guid.NewGuid();
        StampItem Asked(int tmdb, DateTime created)
        {
            var key = StampWorld.Movie(tmdb);
            w.Interests.Add(key, StampWorld.Interest(user, T0.AddDays(-60)));
            return w.AddMovie(key, created);
        }

        var upgraded = Asked(1, T0.AddHours(-1));
        w.Store.AddUpgraded(upgraded, T0.AddMinutes(-30), "radarr:1");
        var old = Asked(2, T0.AddDays(-7));                  // exactly the New lifetime ago
        var hidden = Asked(3, T0.AddHours(-1));
        w.Library.Deny(user, hidden.Id);
        var control = Asked(4, T0.AddDays(-7).AddMinutes(1));

        foreach (var item in new[] { upgraded, old, hidden, control }) Assert.Equal(AcquisitionStampFeeder.Outcome.Done, w.Feeder.Judge(item.Id, T0));

        Assert.Empty(News(w, upgraded));
        Assert.Single(w.Store.FactsFor(upgraded.Id));      // the upgrade itself stays
        Assert.Empty(News(w, old));
        Assert.Empty(News(w, hidden));
        Assert.Single(News(w, control));
        Assert.All(new[] { upgraded, old, hidden, control }, i => Assert.True(w.Store.Seen(i.Id)));
    }

    // ── 12. the background round ─────────────────────────────────────────

    [Fact]
    public async Task WhileBadgesAreOffARoundDoesAndWritesNothingAndTurningThemOnCatchesUp()
    {
        using var w = new StampWorld();
        w.Config.ArrPhase4AcquisitionBadgesEnabled = false;
        var key = StampWorld.Movie(603);
        var user = Guid.NewGuid();
        w.Interests.Add(key, StampWorld.Interest(user, T0.AddDays(-1)));
        var movie = w.AddMovie(key, T0.AddHours(-1));
        w.Library.RaiseAdded(movie);
        var replaced = w.AddMovie(StampWorld.Movie(604), T0.AddDays(-90), path: "/movies/replaced.mkv");
        w.Upgrades.Imports.Add(new StampUpgradeImport("radarr:1", "/movies/replaced.mkv", T0.AddMinutes(-30)));
        var old = w.AddMovie(StampWorld.Movie(9), T0.AddDays(-3));
        w.Library.RaiseRemoved(old);

        await w.Feeder.TickAsync(CancellationToken.None);
        w.Now = T0.AddMinutes(20);
        await w.Feeder.TickAsync(CancellationToken.None);

        Assert.Equal(0, w.Upgrades.Calls);
        Assert.Equal(0, w.Library.FourKCalls);
        Assert.Equal((0L, 0L, 0L), (w.Rows("acquisition_stamps"), w.Rows("acquisition_seen"), w.Rows("acquisition_arrivals")));

        w.Config.ArrPhase4AcquisitionBadgesEnabled = true;
        await w.Feeder.TickAsync(CancellationToken.None);
        Assert.Single(News(w, movie));
        Assert.Equal(AcquisitionStampKinds.Upgraded, Assert.Single(w.Store.FactsFor(replaced.Id)).Kind);
    }

    [Fact]
    public async Task AnAddedItemIsJudgedOnlyAfterTheSettleAndAnUnprobedOneWhenItsProbed()
    {
        using var w = new StampWorld();
        await w.Feeder.TickAsync(CancellationToken.None);          // the start's catch-up (empty library)
        var key = StampWorld.Movie(603);
        var user = Guid.NewGuid();
        w.Interests.Add(key, StampWorld.Interest(user, T0.AddDays(-1)));
        var movie = new StampItem { Id = Guid.NewGuid(), Kind = "movie", Keys = new[] { key }, Width = 1920, Height = 1080, DateCreated = T0 };
        var unprobed = new StampItem { Id = Guid.NewGuid(), Kind = "movie", Keys = new[] { StampWorld.Movie(604) }, DateCreated = T0 };
        w.Interests.Add(StampWorld.Movie(604), StampWorld.Interest(user, T0.AddDays(-1)));
        w.Library.RaiseAdded(movie);
        w.Library.RaiseAdded(unprobed);

        w.Now = T0.AddSeconds(30);
        await w.Feeder.TickAsync(CancellationToken.None);
        w.Now = T0.AddSeconds(59);
        await w.Feeder.TickAsync(CancellationToken.None);
        Assert.False(w.Store.Seen(movie.Id));
        Assert.Empty(w.Store.FactsFor(movie.Id));

        w.Now = T0.AddSeconds(61);
        await w.Feeder.TickAsync(CancellationToken.None);
        Assert.Single(News(w, movie));
        Assert.False(w.Store.Seen(unprobed.Id));                  // waiting for its media info

        w.Library.Put(unprobed with { Width = 1920, Height = 800 });
        w.Now = T0.AddMinutes(2);
        await w.Feeder.TickAsync(CancellationToken.None);
        Assert.Single(News(w, w.Library.Items[unprobed.Id]));
    }

    [Fact]
    public async Task TheCatchUpJudgesUnseenRecentArrivalsOnly()
    {
        using var w = new StampWorld();
        var user = Guid.NewGuid();
        StampItem Asked(int tmdb, DateTime created)
        {
            var key = StampWorld.Movie(tmdb);
            w.Interests.Add(key, StampWorld.Interest(user, T0.AddDays(-60)));
            return w.AddMovie(key, created);
        }

        var recent = Asked(1, T0.AddHours(-2));
        var judged = Asked(2, T0.AddHours(-2));
        w.Store.MarkSeen(judged.Id);
        var tooOld = Asked(3, T0.AddDays(-8));

        await w.Feeder.TickAsync(CancellationToken.None);
        Assert.Single(News(w, recent));
        Assert.Empty(News(w, judged));
        Assert.False(w.Store.Seen(tooOld.Id));

        // The next catch-up is ten minutes later.
        var next = Asked(4, T0.AddHours(-1));
        w.Now = T0.AddMinutes(5);
        await w.Feeder.TickAsync(CancellationToken.None);
        Assert.Empty(News(w, next));
        w.Now = T0.AddMinutes(10);
        await w.Feeder.TickAsync(CancellationToken.None);
        Assert.Single(News(w, next));
    }

    [Fact]
    public async Task AnUpgradeImportIsRecordedOnceJellyfinHasTheFileAndOnlyOncePerImport()
    {
        using var w = new StampWorld();
        var viewer = Guid.NewGuid();
        w.Upgrades.Imports.Add(new StampUpgradeImport("radarr:1", "/movies/new.mkv", T0.AddHours(-1)));
        w.Upgrades.Imports.Add(new StampUpgradeImport("radarr:2", "/movies/late.mkv", T0.AddDays(-2)));
        await w.Feeder.TickAsync(CancellationToken.None);
        Assert.Equal(0, w.Rows("acquisition_stamps"));

        // Jellyfin picks the files up afterwards: the recent import is retried and recorded, the day-old one was dropped.
        var upgraded = w.AddMovie(StampWorld.Movie(1), T0.AddDays(-90), path: "/movies/new.mkv");
        var late = w.AddMovie(StampWorld.Movie(2), T0.AddDays(-90), path: "/movies/late.mkv");
        w.Now = T0.AddSeconds(15);
        await w.Feeder.TickAsync(CancellationToken.None);
        var fact = Assert.Single(w.Store.FactsFor(upgraded.Id));
        Assert.Equal((AcquisitionStampKinds.Upgraded, T0.AddHours(-1)), (fact.Kind, fact.At));
        Assert.Empty(w.Store.FactsFor(late.Id));
        Assert.Equal(AcquisitionStamp.Upgraded, w.Resolver.Resolve(upgraded.Id, viewer));

        // A replay of the same import (same source) is never written again, even pointing elsewhere.
        var elsewhere = w.AddMovie(StampWorld.Movie(3), T0.AddDays(-90), path: "/movies/elsewhere.mkv");
        w.Upgrades.Imports.Add(new StampUpgradeImport("radarr:1", "/movies/elsewhere.mkv", T0));
        w.Now = T0.AddSeconds(30);
        await w.Feeder.TickAsync(CancellationToken.None);
        Assert.Empty(w.Store.FactsFor(elsewhere.Id));
        Assert.Equal(1, w.Rows("acquisition_stamps"));
    }

    [Fact]
    public async Task AnImportAloneIsNoUpgradeUntilTheArrsHistoryShowsTheOldFileDeletedForUpgrade()
    {
        using var w = new StampWorld();
        var movie = w.AddMovie(StampWorld.Movie(1), T0.AddDays(-90), path: "/movies/m.mkv");
        // What a webhook (or a replayed one) makes fresher: the import is in the history.
        w.Upgrades.History.Add(new ArrHistoryEntry { Id = 10, EventType = "downloadFolderImported", MovieId = 7, ImportedPath = "/movies/m.mkv", Date = T0.AddMinutes(-5) });
        await w.Feeder.TickAsync(CancellationToken.None);
        Assert.Empty(w.Store.FactsFor(movie.Id));

        w.Upgrades.History.Add(new ArrHistoryEntry { Id = 11, EventType = "movieFileDeleted", MovieId = 7, Reason = "Upgrade", Date = T0.AddMinutes(-6) });
        w.Now = T0.AddSeconds(15);
        await w.Feeder.TickAsync(CancellationToken.None);
        Assert.Equal(AcquisitionStampKinds.Upgraded, Assert.Single(w.Store.FactsFor(movie.Id)).Kind);
    }

    [Fact]
    public void PairingTakesOnlyImportsWithAFileDeletedForUpgradeOfTheSameSubjectWithinTenMinutes()
    {
        ArrHistoryEntry Import(int id, int? movie = null, int? episode = null, double minutes = 0, string? path = "/x.mkv")
            => new() { Id = id, EventType = "downloadFolderImported", MovieId = movie, EpisodeId = episode, ImportedPath = path, Date = T0.AddMinutes(minutes) };
        ArrHistoryEntry Deleted(int id, string? reason, int? movie = null, int? episode = null, double minutes = 0)
            => new() { Id = id, EventType = movie != null ? "movieFileDeleted" : "episodeFileDeleted", MovieId = movie, EpisodeId = episode, Reason = reason, Date = T0.AddMinutes(minutes) };
        IEnumerable<int> Paired(params ArrHistoryEntry[] records) => ArrHistoryStampUpgrades.Pair(records, T0.AddHours(-1)).Select(r => r.Id);

        Assert.Equal(new[] { 1 }, Paired(Import(1, movie: 5), Deleted(2, "Upgrade", movie: 5, minutes: -1)));
        Assert.Equal(new[] { 1 }, Paired(Import(1, movie: 5), Deleted(2, "upgrade", movie: 5, minutes: 9)));        // any case, either side
        Assert.Equal(new[] { 1 }, Paired(Import(1, episode: 9), Deleted(2, "UPGRADE", episode: 9, minutes: 10)));
        Assert.Empty(Paired(Import(1, movie: 5)));                                                                 // a hint alone
        Assert.Empty(Paired(Import(1, movie: 5), Deleted(2, "Manual", movie: 5)));
        Assert.Empty(Paired(Import(1, movie: 5), Deleted(2, "MissingFromDisk", movie: 5)));
        Assert.Empty(Paired(Import(1, movie: 5), Deleted(2, null, movie: 5)));
        Assert.Empty(Paired(Import(1, movie: 5), Deleted(2, "Upgrade", movie: 6)));                                 // another movie
        Assert.Empty(Paired(Import(1, episode: 9), Deleted(2, "Upgrade", episode: 10)));                            // another episode
        Assert.Empty(Paired(Import(1, movie: 5), Deleted(2, "Upgrade", movie: 5, minutes: -11)));                   // too far apart
        Assert.Empty(Paired(Import(1, movie: 5, minutes: -61), Deleted(2, "Upgrade", movie: 5, minutes: -61)));     // before "since"
        Assert.Empty(Paired(Import(1, movie: 5, path: null), Deleted(2, "Upgrade", movie: 5)));                     // no imported path
        Assert.Empty(Paired(new ArrHistoryEntry { Id = 1, EventType = "grabbed", MovieId = 5, ImportedPath = "/x.mkv", Date = T0 }, Deleted(2, "Upgrade", movie: 5)));
        Assert.Equal(new[] { 1, 3 }, Paired(Import(1, movie: 5), Deleted(2, "Upgrade", movie: 5), Import(3, movie: 5, minutes: 2), Import(4, movie: 8)));
    }

    // ── 13. the history reason ───────────────────────────────────────────

    [Theory]
    [InlineData("reason", "Upgrade", "Upgrade")]
    [InlineData("Reason", "Manual", "Manual")]
    [InlineData("REASON", "upgrade", "upgrade")]
    [InlineData("message", "Upgrade", null)]
    public void TheHistoryReasonIsReadFromTheDataMapWhateverTheKeysCase(string key, string value, string? expected)
    {
        var record = new ArrWireHistoryRecord
        {
            Id = 1, EventType = "movieFileDeleted", MovieId = 5, Date = T0,
            Data = new Dictionary<string, JsonElement> { [key] = JsonSerializer.SerializeToElement(value) },
        };
        Assert.Equal(expected, ArrStateLoaders.ToHistoryEntry(record).Reason);
    }

    [Fact]
    public void AMissingOrNonTextReasonIsNullAndTheReasonIsNeverSerialized()
    {
        Assert.Null(ArrStateLoaders.ToHistoryEntry(new ArrWireHistoryRecord { Id = 1 }).Reason);
        Assert.Null(ArrStateLoaders.ToHistoryEntry(new ArrWireHistoryRecord { Id = 1, Data = new() { ["reason"] = JsonSerializer.SerializeToElement(3) } }).Reason);
        Assert.Null(ArrStateLoaders.ToHistoryEntry(new ArrWireHistoryRecord { Id = 1, Data = new() { ["reason"] = JsonSerializer.SerializeToElement("  ") } }).Reason);

        var entry = new ArrHistoryEntry { Id = 1, EventType = "movieFileDeleted", Reason = "UpgradeReasonMarker" };
        foreach (var options in new[] { new JsonSerializerOptions(), new JsonSerializerOptions(JsonSerializerDefaults.Web) })
        {
            var json = JsonSerializer.Serialize(entry, options);
            Assert.DoesNotContain("UpgradeReasonMarker", json, StringComparison.Ordinal);
            Assert.DoesNotContain("reason", json, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("movieFileDeleted", json, StringComparison.Ordinal);
        }
    }
}
