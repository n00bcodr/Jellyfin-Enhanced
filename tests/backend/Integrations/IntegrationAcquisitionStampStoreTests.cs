using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps;
using Microsoft.Data.Sqlite;

namespace JE.Tests;

/// <summary>
/// Phase 4e: the durable stamp facts (acquire.db step 7) on a real database file: idempotent "new" facts, upgrades that
/// replace them, season/series aggregation, judged arrivals, first arrivals, purges, an unusable database and a restore.
/// </summary>
public class IntegrationAcquisitionStampStoreTests
{
    private static readonly DateTime T0 = StampWorld.T0;
    private static readonly string[] StampTables = { "acquisition_arrivals", "acquisition_seen", "acquisition_stamps" };

    private static List<string> Tables(string path)
    {
        using var c = new SqliteConnection("Data Source=" + path + ";Pooling=False");
        c.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('acquisition_stamps','acquisition_seen','acquisition_arrivals') ORDER BY name";
        using var r = cmd.ExecuteReader();
        var names = new List<string>();
        while (r.Read()) names.Add(r.GetString(0));
        return names;
    }

    private static void Exec(string path, string sql)
    {
        using var c = new SqliteConnection("Data Source=" + path + ";Pooling=False");
        c.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    // ── 7. store ─────────────────────────────────────────────────────────

    [Fact]
    public void ANewFactIsKeptOncePerItemAndPerson()
    {
        using var w = new StampWorld();
        var movie = w.AddMovie(StampWorld.Movie(603), T0);
        var (a, b) = (Guid.NewGuid(), Guid.NewGuid());

        Assert.True(w.Store.AddNew(a, movie, T0, "request"));
        Assert.False(w.Store.AddNew(a, movie, T0.AddHours(1), "follow"));   // same item and person: kept once, first time wins
        Assert.True(w.Store.AddNew(b, movie, T0.AddHours(2), "seerr"));

        var facts = w.Store.FactsFor(movie.Id);
        Assert.Equal(2, facts.Count);
        Assert.Equal(T0, Assert.Single(facts, f => f.UserId == a).At);
        Assert.All(facts, f => Assert.Equal(AcquisitionStampKinds.New, f.Kind));
        Assert.Equal(2, w.Rows("acquisition_stamps"));
    }

    [Fact]
    public void AnUpgradeRemovesTheItemsNewFactsAndOnlyALaterUpgradeMovesItsTime()
    {
        using var w = new StampWorld();
        var movie = w.AddMovie(StampWorld.Movie(603), T0);
        var other = w.AddMovie(StampWorld.Movie(604), T0);
        var user = Guid.NewGuid();
        w.Store.AddNew(user, movie, T0, "request");
        w.Store.AddNew(user, other, T0, "request");

        Assert.True(w.Store.AddUpgraded(movie, T0.AddDays(1), "radarr:1"));
        var fact = Assert.Single(w.Store.FactsFor(movie.Id));
        Assert.Equal((AcquisitionStampKinds.Upgraded, Guid.Empty, T0.AddDays(1)), (fact.Kind, fact.UserId, fact.At));
        Assert.Single(w.Store.FactsFor(other.Id), f => f.Kind == AcquisitionStampKinds.New);   // another item's New stays

        Assert.True(w.Store.AddUpgraded(movie, T0.AddDays(2), "radarr:2"));                    // later: moves
        Assert.Equal(T0.AddDays(2), Assert.Single(w.Store.FactsFor(movie.Id)).At);
        Assert.False(w.Store.AddUpgraded(movie, T0.AddDays(1).AddHours(5), "radarr:3"));      // earlier: doesn't
        Assert.Equal(T0.AddDays(2), Assert.Single(w.Store.FactsFor(movie.Id)).At);
    }

    [Fact]
    public void SeasonAndSeriesIdsAggregateTheirEpisodesFacts()
    {
        using var w = new StampWorld();
        var series = w.AddSeries(StampWorld.Show(81189));
        var s1 = w.AddSeason(series, 1);
        var s2 = w.AddSeason(series, 2);
        var e1 = w.AddEpisode(series, s1, 1, 1, T0);
        var e2 = w.AddEpisode(series, s2, 2, 1, T0);
        var user = Guid.NewGuid();
        w.Store.AddNew(user, e1, T0, "follow");
        w.Store.AddUpgraded(e2, T0, "sonarr:1");

        Assert.Equal(new[] { e1.Id }, w.Store.FactsFor(s1.Id).Select(f => f.ItemId));
        Assert.Equal(new[] { e2.Id }, w.Store.FactsFor(s2.Id).Select(f => f.ItemId));
        Assert.Equal(new[] { e1.Id, e2.Id }.OrderBy(x => x), w.Store.FactsFor(series.Id).Select(f => f.ItemId).OrderBy(x => x));
        Assert.Equal(series.Id, w.Store.FactsFor(e1.Id).Single().SeriesId);
        Assert.Empty(w.Store.FactsFor(Guid.NewGuid()));
    }

    [Fact]
    public void SeenAndFirstArrivalsAreRememberedAndTheEarliestArrivalWins()
    {
        using var w = new StampWorld();
        var item = Guid.NewGuid();
        Assert.False(w.Store.Seen(item));
        w.Store.MarkSeen(item);
        w.Store.MarkSeen(item);
        Assert.True(w.Store.Seen(item));
        Assert.False(w.Store.Seen(Guid.NewGuid()));

        Assert.Null(w.Store.FirstArrival(new[] { "m|movie:tmdb:603|std" }));
        Assert.Null(w.Store.FirstArrival(Array.Empty<string>()));
        w.Store.NoteArrival(new[] { "m|movie:tmdb:603|std" }, T0, item);
        w.Store.NoteArrival(new[] { "m|movie:tmdb:603|std" }, T0.AddDays(1), Guid.NewGuid());   // later: ignored
        Assert.Equal(T0, w.Store.FirstArrival(new[] { "m|movie:tmdb:603|std" }));
        w.Store.NoteArrival(new[] { "m|movie:tmdb:603|std" }, T0.AddDays(-1), Guid.NewGuid());  // earlier: kept
        Assert.Equal(T0.AddDays(-1), w.Store.FirstArrival(new[] { "m|movie:tmdb:603|std" }));
        w.Store.NoteArrival(new[] { "m|movie:tmdb:603|4k" }, T0.AddDays(-3), item);
        Assert.Equal(T0.AddDays(-3), w.Store.FirstArrival(new[] { "m|movie:tmdb:603|std", "m|movie:tmdb:603|4k" }));   // earliest of the parts
        Assert.Equal(T0.AddDays(-3), w.Store.FirstArrival(new[] { "m|movie:tmdb:603|std", "m|movie:tmdb:999|std" }));
    }

    [Fact]
    public void PartKeysNameEachMovieEditionAndEachEpisodeNumber()
    {
        var imdb = TitleKey.ForMovie(null, "tt0133093")!;
        var movie = new StampItem { Id = Guid.NewGuid(), Kind = "movie", Keys = new[] { StampWorld.Movie(603), imdb }, Width = 1920, Height = 1080 };
        Assert.Equal(new[] { "m|movie:tmdb:603|std", "m|movie:imdb:tt0133093|std" }, AcquisitionStampStore.PartKeys(movie));
        Assert.Equal(new[] { "m|movie:tmdb:603|4k", "m|movie:imdb:tt0133093|4k" }, AcquisitionStampStore.PartKeys(movie with { Width = 3840, Height = 1600 }));
        Assert.Equal(new[] { "m|movie:tmdb:603|4k", "m|movie:imdb:tt0133093|4k" }, AcquisitionStampStore.PartKeys(movie with { Width = 2880, Height = 2160 }));

        var episode = new StampItem { Id = Guid.NewGuid(), Kind = "episode", Keys = new[] { StampWorld.Show(81189) }, Season = 2, Episode = 3, Width = 1280, Height = 720 };
        Assert.Equal(new[] { "e|tv:tvdb:81189|s2e3|std" }, AcquisitionStampStore.PartKeys(episode));
        Assert.Equal(new[] { "e|tv:tvdb:81189|s2e3|std", "e|tv:tvdb:81189|s2e4|std", "e|tv:tvdb:81189|s2e5|std" }, AcquisitionStampStore.PartKeys(episode with { EpisodeEnd = 5 }));
        Assert.Equal(new[] { "e|tv:tvdb:81189|s2e3|std" }, AcquisitionStampStore.PartKeys(episode with { EpisodeEnd = 1 }));   // a bad range: just its own number
        Assert.Empty(AcquisitionStampStore.PartKeys(episode with { Episode = null }));
    }

    [Fact]
    public void PurgeUserRemovesOnlyThatPersonsRows()
    {
        using var w = new StampWorld();
        var movie = w.AddMovie(StampWorld.Movie(603), T0);
        var (gone, stays) = (Guid.NewGuid(), Guid.NewGuid());
        w.Store.AddNew(gone, movie, T0, "request");
        w.Store.AddNew(stays, movie, T0, "request");
        var upgraded = w.AddMovie(StampWorld.Movie(604), T0);
        w.Store.AddUpgraded(upgraded, T0, "radarr:1");

        w.Store.PurgeUser(gone);
        Assert.Equal(new[] { stays }, w.Store.FactsFor(movie.Id).Select(f => f.UserId));
        Assert.Single(w.Store.FactsFor(upgraded.Id));
        w.Store.PurgeUser(Guid.Empty);                      // never the household's upgrades
        Assert.Single(w.Store.FactsFor(upgraded.Id));
    }

    [Fact]
    public void PurgeDropsRowsOlderThanThirtyDays()
    {
        using var w = new StampWorld();
        var old = w.AddMovie(StampWorld.Movie(1), T0);
        var recent = w.AddMovie(StampWorld.Movie(2), T0);
        var user = Guid.NewGuid();
        w.Store.AddNew(user, old, T0.AddDays(-31), "request");
        w.Store.AddNew(user, recent, T0.AddDays(-29), "request");
        w.Store.NoteArrival(new[] { "old" }, T0.AddDays(-31), old.Id);
        w.Store.NoteArrival(new[] { "recent" }, T0.AddDays(-29), recent.Id);
        w.Now = T0.AddDays(-31);
        w.Store.MarkSeen(old.Id);
        w.Now = T0;
        w.Store.MarkSeen(recent.Id);

        Assert.Equal(2, w.Store.Purge());
        Assert.Empty(w.Store.FactsFor(old.Id));
        Assert.Single(w.Store.FactsFor(recent.Id));
        Assert.False(w.Store.Seen(old.Id));
        Assert.True(w.Store.Seen(recent.Id));
        Assert.Equal(T0.AddDays(-31), w.Store.FirstArrival(new[] { "old" }));
        Assert.NotNull(w.Store.FirstArrival(new[] { "recent" }));
        Assert.Equal(0, w.Store.Purge());
    }

    [Fact]
    public void AnUnusableDatabaseGivesNoFactsAndRefusesWritesWithoutThrowing()
    {
        using var core = new CoreFixture();
        var path = Path.Combine(core.Root, "acquire.db");
        File.WriteAllBytes(path, System.Text.Encoding.UTF8.GetBytes("this is not a database, just some garbage bytes that are long enough to look like a header......"));
        using var db = new AcquireDatabase(path);
        Assert.False(db.Available);
        var store = new AcquisitionStampStore(db, () => new DateTimeOffset(T0));
        var item = new StampItem { Id = Guid.NewGuid(), Kind = "movie", Keys = new[] { StampWorld.Movie(603) } };

        Assert.False(store.Available);
        Assert.Empty(store.FactsFor(item.Id));
        Assert.False(store.Any);
        Assert.False(store.AddNew(Guid.NewGuid(), item, T0, "request"));
        Assert.False(store.AddUpgraded(item, T0, "radarr:1"));
        Assert.False(store.Seen(item.Id));
        store.MarkSeen(item.Id);
        store.NoteArrival(new[] { "p" }, T0, item.Id);
        Assert.Null(store.FirstArrival(new[] { "p" }));
        store.PurgeUser(Guid.NewGuid());
        Assert.Equal(0, store.Purge());

        // The resolver over it shows nothing either.
        var library = new FakeStampLibrary();
        library.Put(item);
        using var resolver = new AcquisitionStampResolver(library, store, () => StampWorld.On(), () => new DateTimeOffset(T0));
        Assert.Equal(AcquisitionStamp.None, resolver.Resolve(item.Id, Guid.NewGuid()));
    }

    [Fact]
    public void ARestoreReloadsTheFactsFromTheRestoredDatabase()
    {
        using var w = new StampWorld();
        var kept = w.AddMovie(StampWorld.Movie(1), T0);
        var later = w.AddMovie(StampWorld.Movie(2), T0);
        var user = Guid.NewGuid();
        w.Store.AddNew(user, kept, T0, "request");
        var snapshot = w.Db.Snapshot()!;
        w.Store.AddNew(user, later, T0, "request");
        w.Store.AddUpgraded(kept, T0.AddHours(1), "radarr:1");
        Assert.Equal(AcquisitionStampKinds.Upgraded, Assert.Single(w.Store.FactsFor(kept.Id)).Kind);
        Assert.Single(w.Store.FactsFor(later.Id));
        var revision = w.Store.Revision;
        var generation = w.Db.Generation;

        w.Db.ReplaceWith(snapshot);

        Assert.NotEqual(generation, w.Db.Generation);
        Assert.Equal(AcquisitionStampKinds.New, Assert.Single(w.Store.FactsFor(kept.Id)).Kind);   // the index was rebuilt, not served stale
        Assert.Empty(w.Store.FactsFor(later.Id));
        Assert.NotEqual(revision, w.Store.Revision);
    }

    // ── 8. schema ────────────────────────────────────────────────────────

    [Fact]
    public void AFreshDatabaseIsAtSchemaSevenWithHomeAndAcquisitionTables()
    {
        using var w = new StampWorld();
        // Step 7 is this track's; later steps (8: the Ready playlist, D47) may follow it.
        Assert.True(AcquireDatabase.Migrations.Count >= 7);
        Assert.Equal(AcquireDatabase.Migrations.Count, w.Db.Version);
        Assert.Contains("home_arrivals", AcquireDatabase.Migrations[5]);
        Assert.Contains("acquisition_stamps", AcquireDatabase.Migrations[6], StringComparison.Ordinal);
        Assert.Equal(StampTables, Tables(w.Db.FilePath));
    }

    [Fact]
    public void ASchemaFiveDatabaseUpgradesToSevenWithTheAcquisitionTables()
    {
        using var core = new CoreFixture();
        var path = Path.Combine(core.Root, "five.db");
        Exec(path, string.Join("\n", AcquireDatabase.Migrations.Take(5)) + "\nPRAGMA user_version=5;");
        Assert.Empty(Tables(path));

        using (var w = new StampWorld(path))
        {
            Assert.True(w.Db.Available, w.Db.UnavailableReason);
            Assert.Equal(AcquireDatabase.Migrations.Count, w.Db.Version);
            var movie = w.AddMovie(StampWorld.Movie(603), T0);
            Assert.True(w.Store.AddNew(Guid.NewGuid(), movie, T0, "request"));   // the new tables work after the upgrade
            Assert.Single(w.Store.FactsFor(movie.Id));
        }

        // (StampWorld disposed its own core; the path lives under this one.)
        Assert.Equal(StampTables, Tables(path));
        using var again = new AcquireDatabase(path);
        Assert.Equal(AcquireDatabase.Migrations.Count, again.Version);
    }

    // ── 17. user deleted ─────────────────────────────────────────────────

    [Fact]
    public async Task DeletingAPersonRemovesTheirNewFactsButNeverTheHouseholdsUpgrades()
    {
        using var w = new StampWorld();
        var movie = w.AddMovie(StampWorld.Movie(603), T0);
        var upgraded = w.AddMovie(StampWorld.Movie(604), T0);
        var (gone, stays) = (Guid.NewGuid(), Guid.NewGuid());
        w.Store.AddNew(gone, movie, T0, "request");
        w.Store.AddNew(stays, movie, T0, "request");
        w.Store.AddNew(gone, upgraded, T0, "request");
        w.Store.AddUpgraded(upgraded, T0.AddHours(1), "radarr:1");

        var purge = new AcquisitionStampUserPurge(w.Store, w.Core.Logger);
        await purge.OnEvent(new Jellyfin.Data.Events.Users.UserDeletedEventArgs(new User("gone", "default", "default") { Id = gone }));

        Assert.Equal(new[] { stays }, w.Store.FactsFor(movie.Id).Select(f => f.UserId));
        var household = Assert.Single(w.Store.FactsFor(upgraded.Id));
        Assert.Equal((AcquisitionStampKinds.Upgraded, Guid.Empty), (household.Kind, household.UserId));
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(movie.Id, gone));
        Assert.Equal(AcquisitionStamp.NewForYou, w.Resolver.Resolve(movie.Id, stays));
    }
}
