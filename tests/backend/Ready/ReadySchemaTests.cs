using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready;
using Microsoft.Data.Sqlite;

namespace JE.Tests;

/// <summary>
/// acquire.db schema step 8 and the Ready ensure (D47): a fresh database, the 4e schema 7 with its empty step 6, a database
/// that reached 8 without the tables, a partial earlier ensure, two starts, a restore (the renewal policy, including a stop
/// before the restore's listeners run), repeated restores, an unknown newer schema, and a deleted person's rows.
/// </summary>
public class ReadySchemaTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 18, 9, 0, 0, TimeSpan.Zero);
    private const string Server = "server-a";

    private static List<string> Objects(string path)
    {
        using var c = new SqliteConnection("Data Source=" + path + ";Pooling=False");
        c.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT name FROM sqlite_master WHERE name LIKE 'ready_%' ORDER BY name";
        var list = new List<string>();
        using var r = cmd.ExecuteReader();
        while (r.Read()) list.Add(r.GetString(0));
        return list;
    }

    private static void Exec(string path, string sql)
    {
        using var c = new SqliteConnection("Data Source=" + path + ";Pooling=False");
        c.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    private static object? Scalar(string path, string sql)
    {
        using var c = new SqliteConnection("Data Source=" + path + ";Pooling=False");
        c.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        return cmd.ExecuteScalar();
    }

    private static readonly List<string> All = ReadyTables.Objects.OrderBy(n => n, StringComparer.Ordinal).ToList();

    [Fact]
    public void AFreshDatabaseIsAtStepEightWithTheReadyTables()
    {
        using var core = new CoreFixture();
        var path = Path.Combine(core.Root, "fresh.db");
        using (var db = new AcquireDatabase(path))
        {
            Assert.True(db.Available, db.UnavailableReason);
            Assert.Equal(8, AcquireDatabase.Migrations.Count);
            Assert.Equal(8, db.Version);
            Assert.Contains("ready_playlists", AcquireDatabase.Migrations[7], StringComparison.Ordinal);
            Assert.Equal(ReadyTables.Sql, AcquireDatabase.Migrations[7]);
        }

        Assert.Equal(All, Objects(path));
        Assert.Equal("1", Scalar(path, "SELECT value FROM meta WHERE key='ready_schema'"));
    }

    [Fact]
    public void ASchemaSevenDatabaseWithItsEmptyStepSixUpgradesToEight()
    {
        using var core = new CoreFixture();
        var path = Path.Combine(core.Root, "seven.db");
        Exec(path, string.Join("\n", AcquireDatabase.Migrations.Take(7)) + "\nPRAGMA user_version=7;");
        Assert.True(string.IsNullOrWhiteSpace(AcquireDatabase.Migrations[5]));
        Assert.Empty(Objects(path));
        using (var db = new AcquireDatabase(path))
        {
            Assert.True(db.Available, db.UnavailableReason);
            Assert.Equal(8, db.Version);
        }

        Assert.Equal(All, Objects(path));
        // The pre-migration copy was taken (an existing database is copied before any migration).
        Assert.NotEmpty(Directory.EnumerateFiles(core.Root, "seven.db.pre-v7.*"));
    }

    [Fact]
    public void ADatabaseThatReachedEightWithoutTheTablesGetsThemAtStartUp()
    {
        using var core = new CoreFixture();
        var path = Path.Combine(core.Root, "advanced.db");
        // Another track's build took step 8 without these tables (or a prototype left them out).
        Exec(path, string.Join("\n", AcquireDatabase.Migrations.Take(7)) + "\nPRAGMA user_version=8;");
        Assert.Empty(Objects(path));
        using (var db = new AcquireDatabase(path)) Assert.Equal(8, db.Version);
        Assert.Equal(All, Objects(path));
    }

    [Fact]
    public void APartialEarlierEnsureIsRepairedWithoutTouchingItsRows()
    {
        using var core = new CoreFixture();
        var path = Path.Combine(core.Root, "partial.db");
        Exec(path, string.Join("\n", AcquireDatabase.Migrations.Take(7)) + @"
CREATE TABLE ready_playlists (server_id TEXT NOT NULL, user_id TEXT NOT NULL, opted_in INTEGER NOT NULL DEFAULT 0, opt_in_epoch INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'off', playlist_id TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (server_id, user_id));
INSERT INTO ready_playlists(server_id,user_id,opted_in,opt_in_epoch,state,playlist_id,updated_at) VALUES('server-a','" + Guid.Empty.ToString("N") + @"',1,3,'active','" + Guid.NewGuid().ToString("N") + @"',5);
PRAGMA user_version=8;");
        using (var db = new AcquireDatabase(path))
        {
            Assert.Equal(8, db.Version);
            var binding = new ReadyPlaylistStore(db).Binding(Server, Guid.Empty);
            Assert.NotNull(binding);
            Assert.True(binding!.OptedIn);
            Assert.Equal(3, binding.Epoch);
            Assert.Equal(ReadyState.Active, binding.State);
            Assert.Null(binding.Marker);
        }

        Assert.Equal(All, Objects(path));
        Assert.Equal(1L, Scalar(path, "SELECT COUNT(*) FROM pragma_table_info('ready_playlists') WHERE name='create_marker'"));
    }

    [Fact]
    public void TwoStartsChangeNothingAndNeverSeedAnOptIn()
    {
        using var core = new CoreFixture();
        var path = Path.Combine(core.Root, "twice.db");
        var user = Guid.NewGuid();
        using (var db = new AcquireDatabase(path))
        {
            var store = new ReadyPlaylistStore(db);
            Assert.Null(store.Binding(Server, user));
            store.OptIn(Server, user, T0);
            store.OptOut(Server, user, T0.AddMinutes(1));
        }

        var before = Scalar(path, "SELECT revision||'|'||opted_in||'|'||opt_in_epoch||'|'||state||'|'||updated_at FROM ready_playlists");
        using (var db = new AcquireDatabase(path)) Assert.True(db.Available);
        using (var db = new AcquireDatabase(path)) Assert.True(db.Available);
        Assert.Equal(before, Scalar(path, "SELECT revision||'|'||opted_in||'|'||opt_in_epoch||'|'||state||'|'||updated_at FROM ready_playlists"));
        Assert.Equal(0L, Scalar(path, "SELECT COUNT(*) FROM ready_playlists WHERE opted_in=1"));
    }

    [Fact]
    public void AnUnknownNewerSchemaIsLeftUntouched()
    {
        using var core = new CoreFixture();
        var path = Path.Combine(core.Root, "newer.db");
        Exec(path, string.Join("\n", AcquireDatabase.Migrations) + "\nPRAGMA user_version=99;");
        Exec(path, "DROP TABLE ready_entries;");
        using (var db = new AcquireDatabase(path))
        {
            Assert.False(db.Available);
            Assert.Contains("newer", db.UnavailableReason, StringComparison.OrdinalIgnoreCase);
        }

        Assert.DoesNotContain("ready_entries", Objects(path));
        Assert.Equal(99L, Scalar(path, "PRAGMA user_version"));
    }

    /// <summary>A restored database: every opted-in person must turn Ready on again, and pending native messages die.</summary>
    [Fact]
    public void ARestoreRequiresEveryoneToTurnTheirReadyPlaylistOnAgain()
    {
        using var core = new CoreFixture();
        var path = Path.Combine(core.Root, "live.db");
        var (emma, sam, playlist) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        byte[] backup;
        long delivery;
        using (var db = new AcquireDatabase(path))
        {
            var store = new ReadyPlaylistStore(db);
            var binding = store.OptIn(Server, emma, T0);
            Assert.True(store.Bind(db.Generation, Server, emma, binding.Epoch, playlist, T0.ToUnixTimeMilliseconds(), T0));
            store.OptIn(Server, sam, T0);
            store.OptOut(Server, sam, T0);
            var notify = new NotifyStore(db);
            delivery = notify.Add(emma, "ready|x", NotifyKind.Ready, "movie:tmdb:1", null, new Dictionary<string, string>(), new[] { (NotifyChannel.DisplayMessage, T0), (NotifyChannel.Email, T0) }, T0)!.Value;
            backup = db.Snapshot()!;

            // Restored over the live database.
            db.ReplaceWith(backup);
            var after = store.Binding(Server, emma)!;
            Assert.False(after.OptedIn);
            Assert.Equal(ReadyState.Renew, after.State);
            Assert.Equal("restored", after.Reason);
            Assert.Equal(playlist, after.PlaylistId); // kept, to be checked in full on renewal (never adopted by name)
            Assert.Equal(ReadyState.Off, store.Binding(Server, sam)!.State);
            // The native message from the backup is never sent; e-mail stays pending.
            Assert.Equal("suppressed", Scalar(path, "SELECT status FROM deliveries WHERE channel='display'"));
            Assert.Equal("pending", Scalar(path, "SELECT status FROM deliveries WHERE channel='email'"));

            // Renewing makes it active again with a new epoch (the binding still has to be revalidated by the service).
            var renewed = store.OptIn(Server, emma, T0.AddHours(1));
            Assert.True(renewed.OptedIn);
            Assert.Equal(ReadyState.Active, renewed.State);
            Assert.True(renewed.Epoch > binding.Epoch);

            // A second restore of the same backup applies the policy again.
            db.ReplaceWith(backup);
            Assert.Equal(ReadyState.Renew, store.Binding(Server, emma)!.State);
        }

        // The next start doesn't apply it a third time (nothing new was restored).
        Exec(path, "UPDATE ready_playlists SET opted_in=1, state='active' WHERE user_id='" + emma.ToString("N") + "'");
        using (var db = new AcquireDatabase(path)) Assert.Equal(ReadyState.Active, new ReadyPlaylistStore(db).Binding(Server, emma)!.State);
        _ = delivery;
    }

    /// <summary>A stop between the restore's copy and its listeners: the stamp travels in the copy, so the next start applies the policy.</summary>
    [Fact]
    public void AStopBeforeTheRestoreListenersRunStillRequiresRenewal()
    {
        using var core = new CoreFixture();
        var path = Path.Combine(core.Root, "crash.db");
        var emma = Guid.NewGuid();
        using (var db = new AcquireDatabase(path))
        {
            new ReadyPlaylistStore(db).OptIn(Server, emma, T0);
        }

        // What ReplaceWith's copy leaves on disk: the backup with a fresh restore stamp (the process stops right after).
        Exec(path, "INSERT INTO meta(key,value) VALUES('restored_marker','" + Guid.NewGuid().ToString("N") + "') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
        using (var db = new AcquireDatabase(path))
        {
            var binding = new ReadyPlaylistStore(db).Binding(Server, emma)!;
            Assert.False(binding.OptedIn);
            Assert.Equal(ReadyState.Renew, binding.State);
        }
    }

    [Fact]
    public void ADeletedPersonsReadyRowsGoWithTheirOtherRows()
    {
        using var core = new CoreFixture();
        using var db = new AcquireDatabase(Path.Combine(core.Root, "purge.db"));
        var (emma, sam) = (Guid.NewGuid(), Guid.NewGuid());
        var store = new ReadyPlaylistStore(db);
        var notify = new NotifyStore(db);
        foreach (var user in new[] { emma, sam })
        {
            var b = store.OptIn(Server, user, T0);
            Assert.True(store.SaveEntries(db.Generation, Server, user, b.Epoch, new[] { new ReadyEntryRow("w:1", "m", "movie:tmdb:1", "standard", Guid.NewGuid(), null, Guid.NewGuid(), 1, 2, ReadyDisposition.Ready) }, Array.Empty<(string, string)>(), T0));
            var id = notify.Add(user, "ready|" + user, NotifyKind.Ready, null, null, new Dictionary<string, string>(), new[] { (NotifyChannel.DisplayMessage, T0) }, T0)!.Value;
            Assert.True(store.Claim(db.Generation, id, user, "abc", T0));
        }

        Assert.True(NotifyUserPurge.Purge(notify, emma, null) > 0);
        Assert.Null(store.Binding(Server, emma));
        Assert.Empty(store.Entries(Server, emma));
        Assert.Equal((0, 0, 0), store.Outcomes(emma, T0.AddDays(-1)));
        Assert.NotNull(store.Binding(Server, sam));
        Assert.Single(store.Entries(Server, sam));
        Assert.Equal((0, 0, 1), store.Outcomes(sam, T0.AddDays(-1)));

        // Retention: rows of a person Jellyfin no longer has go too.
        notify.Purge(T0, id => id != sam);
        Assert.Null(store.Binding(Server, sam));
    }

    [Fact]
    public void WritesFromBeforeARestoreOrAnOptOutAreDropped()
    {
        using var core = new CoreFixture();
        using var db = new AcquireDatabase(Path.Combine(core.Root, "guards.db"));
        var store = new ReadyPlaylistStore(db);
        var emma = Guid.NewGuid();
        var b = store.OptIn(Server, emma, T0);
        var generation = db.Generation;
        db.ReplaceWith(db.Snapshot()!);
        Assert.False(store.Bind(generation, Server, emma, b.Epoch, Guid.NewGuid(), T0.ToUnixTimeMilliseconds(), T0));
        var renewed = store.OptIn(Server, emma, T0);
        // A write for the old epoch loses to the renewal; one for the new epoch lands.
        Assert.False(store.Bind(db.Generation, Server, emma, b.Epoch, Guid.NewGuid(), T0.ToUnixTimeMilliseconds(), T0));
        Assert.True(store.Bind(db.Generation, Server, emma, renewed.Epoch, Guid.NewGuid(), T0.ToUnixTimeMilliseconds(), T0));
        store.OptOut(Server, emma, T0);
        Assert.False(store.SaveEntries(db.Generation, Server, emma, renewed.Epoch, new[] { new ReadyEntryRow("w:1", "m", "movie:tmdb:1", "standard", Guid.NewGuid(), null, Guid.NewGuid(), 1, 2, ReadyDisposition.Ready) }, Array.Empty<(string, string)>(), T0));
        Assert.Empty(store.Entries(Server, emma));
    }
}
