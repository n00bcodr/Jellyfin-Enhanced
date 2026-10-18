using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Microsoft.Data.Sqlite;

namespace JE.Tests;

// acquire.db schema 5 (4c1): durable list operations, list request links, verified swap-in events, and the migration
// steps 4 (reserved, empty) and 5 (list tables, guarded with IF NOT EXISTS).
public class ListsDatabaseTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 1, 12, 0, 0, TimeSpan.Zero);
    private static readonly string[] ListTables = { "list_events", "list_links", "list_operations" };

    private sealed class Db : IDisposable
    {
        public CoreFixture Core { get; } = new();
        public AcquireDatabase Database { get; }

        public Db()
        {
            Database = new AcquireDatabase(Path.Combine(Core.Root, "acquire.db"));
            Assert.True(Database.Available, Database.UnavailableReason);
        }

        public void Dispose()
        {
            Database.Dispose();
            Core.Dispose();
        }
    }

    private static long Count(AcquireDatabase db, string sql) => db.Read(c =>
    {
        using var cmd = RequestLedger.Cmd(c, null, sql);
        return Convert.ToInt64(cmd.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture);
    });

    private static List<string> Tables(string path)
    {
        using var c = new SqliteConnection("Data Source=" + path + ";Pooling=False");
        c.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'list_%' ORDER BY name";
        using var r = cmd.ExecuteReader();
        var names = new List<string>();
        while (r.Read())
        {
            names.Add(r.GetString(0));
        }

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

    // ── migrations ────────────────────────────────────────────────────

    [Fact]
    public void AFreshDatabaseReachesSchemaFiveWithTheListTablesAndStepFourIsEmpty()
    {
        using var db = new Db();
        Assert.Equal(5, AcquireDatabase.Migrations.Count);
        Assert.Equal(5, db.Database.Version);
        Assert.True(string.IsNullOrWhiteSpace(AcquireDatabase.Migrations[3]));
        Assert.Contains("list_operations", AcquireDatabase.Migrations[4], StringComparison.Ordinal);
        Assert.Equal(ListTables, Tables(db.Database.FilePath));
    }

    [Fact]
    public void ASchemaThreeDatabaseMigratesToFiveWithACopyAndTheListTables()
    {
        using var core = new CoreFixture();
        var path = Path.Combine(core.Root, "old.db");
        Exec(path, AcquireDatabase.Migrations[0] + "\n" + AcquireDatabase.Migrations[1] + "\n" + AcquireDatabase.Migrations[2] + "\nPRAGMA user_version=3;");
        Assert.Empty(Tables(path));

        using (var db = new AcquireDatabase(path))
        {
            Assert.True(db.Available, db.UnavailableReason);
            Assert.Equal(5, db.Version);
            // The new tables work after the upgrade.
            var start = new ListOperations(db).Begin(Guid.NewGuid(), "0123456789abcdef0123456789abcdef", "c1", "add", "f", T0);
            Assert.NotNull(start.Operation);
        }

        Assert.Equal(ListTables, Tables(path));
        Assert.Single(Directory.GetFiles(core.Root, "old.db.pre-v3.*"));
        // Reopening is a no-op.
        using var again = new AcquireDatabase(path);
        Assert.Equal(5, again.Version);
        Assert.Single(Directory.GetFiles(core.Root, "old.db.pre-v3.*"));
    }

    [Fact]
    public void StepFiveIsGuardedSoAListTableAnotherStepAlreadyMadeDoesNotBreakIt()
    {
        // A database at schema 4 where another phase-4 step had already created one of the list tables (with its rows).
        using var core = new CoreFixture();
        var path = Path.Combine(core.Root, "four.db");
        Exec(path, AcquireDatabase.Migrations[0] + "\n" + AcquireDatabase.Migrations[1] + "\n" + AcquireDatabase.Migrations[2] + "\n" + AcquireDatabase.Migrations[4]
            + "\nINSERT INTO list_links(list_id,placeholder_id,user_id,want_id,operation_id,title_key,scope,edition,created_at) VALUES('l','p','0123456789abcdef0123456789abcdef','w',NULL,'movie:tmdb:1','{}','standard',1);"
            + "\nDROP TABLE list_events; DROP TABLE list_operations; PRAGMA user_version=4;");

        using var db = new AcquireDatabase(path);
        Assert.True(db.Available, db.UnavailableReason);
        Assert.Equal(5, db.Version);
        Assert.Equal(ListTables, Tables(path));
        Assert.Single(new ListLinks(db).ForList("l"));
    }

    // ── ListOperations ────────────────────────────────────────────────

    [Fact]
    public void AnOperationIsBegunOnceReplayedWithTheSameRequestAndRefusedWithAnother()
    {
        using var db = new Db();
        var ops = new ListOperations(db.Database);
        var user = Guid.NewGuid();
        const string list = "0123456789abcdef0123456789abcdef";

        var first = ops.Begin(user, list, "client-1", "add", "fp-a", T0);
        Assert.NotNull(first.Operation);
        Assert.False(first.Replayed);
        Assert.False(first.Conflict);
        Assert.Equal("open", first.Operation!.State);
        Assert.Equal((user, list, "client-1", "add", "fp-a"), (first.Operation.UserId, first.Operation.Scope, first.Operation.ClientId, first.Operation.Kind, first.Operation.Fingerprint));

        var replay = ops.Begin(user, list, "client-1", "add", "fp-a", T0.AddMinutes(1));
        Assert.True(replay.Replayed);
        Assert.False(replay.Conflict);
        Assert.Equal(first.Operation.Id, replay.Operation!.Id);

        var conflict = ops.Begin(user, list, "client-1", "add", "fp-b", T0.AddMinutes(1));
        Assert.Null(conflict.Operation);
        Assert.True(conflict.Conflict);
        Assert.False(conflict.Replayed);

        // The same request id is another operation for another person or another list.
        var otherUser = ops.Begin(Guid.NewGuid(), list, "client-1", "add", "fp-b", T0);
        var otherList = ops.Begin(user, "fedcba9876543210fedcba9876543210", "client-1", "add", "fp-b", T0);
        Assert.False(otherUser.Replayed || otherUser.Conflict || otherList.Replayed || otherList.Conflict);
        Assert.Equal(3, new[] { first.Operation.Id, otherUser.Operation!.Id, otherList.Operation!.Id }.Distinct().Count());
        Assert.Equal(3, Count(db.Database, "SELECT COUNT(*) FROM list_operations"));
    }

    [Fact]
    public void AFailedOperationIsReplayedAsFailedSoTheRetryRunsItAgainAndACompletedOneKeepsItsResult()
    {
        using var db = new Db();
        var ops = new ListOperations(db.Database);
        var user = Guid.NewGuid();
        const string list = "0123456789abcdef0123456789abcdef";

        var failed = ops.Begin(user, list, "c-fail", "apply", "f", T0).Operation!;
        ops.Finish(failed.Id, completed: false, 503, null, T0);
        var retry = ops.Begin(user, list, "c-fail", "apply", "f", T0.AddSeconds(5));
        Assert.True(retry.Replayed);
        Assert.Equal(("failed", 503), (retry.Operation!.State, retry.Operation.Status));

        var done = ops.Begin(user, "create-playlist", "c-done", "create", "f", T0).Operation!;
        ops.SetList(done.Id, list, T0);
        ops.Finish(done.Id, completed: true, 200, "{\"added\":[\"x\"]}", T0);
        var replayed = ops.Begin(user, "create-playlist", "c-done", "create", "f", T0.AddSeconds(5)).Operation!;
        Assert.Equal(("completed", 200, list, "{\"added\":[\"x\"]}"), (replayed.State, replayed.Status, replayed.ListId, replayed.Result));
    }

    [Fact]
    public void PurgeDropsExpiredAndRemovedListOperationsButKeepsCreateIdentity()
    {
        using var db = new Db();
        var ops = new ListOperations(db.Database);
        var user = Guid.NewGuid();
        const string kept = "0123456789abcdef0123456789abcdef";
        const string removed = "fedcba9876543210fedcba9876543210";

        var oldFinished = ops.Begin(user, kept, "old-finished", "add", "f", T0).Operation!;
        ops.Finish(oldFinished.Id, true, 200, null, T0);
        ops.Begin(user, kept, "old-open", "add", "f", T0);
        var recent = ops.Begin(user, kept, "recent", "add", "f", T0.AddDays(40)).Operation!;
        ops.Finish(recent.Id, true, 200, null, T0.AddDays(40));
        var ofRemoved = ops.Begin(user, removed, "of-removed", "add", "f", T0.AddDays(35)).Operation!;
        var created = ops.Begin(user, "create-playlist", "created", "create", "f", T0.AddDays(35)).Operation!;
        ops.SetList(created.Id, removed, T0.AddDays(35));

        // Day 35: the finished one is past 30 days; the open one stays until 60.
        Assert.Equal(1, ops.Purge(T0.AddDays(35)));
        Assert.False(ops.Begin(user, kept, "old-finished", "add", "f", T0.AddDays(35)).Replayed);
        Assert.True(ops.Begin(user, kept, "old-open", "add", "f", T0.AddDays(35)).Replayed);

        // A removed list: ordinary list operations go, but a create must keep answering for the list it originally made.
        Assert.Equal(1, ops.Purge(T0.AddDays(36), new[] { removed }));
        Assert.False(ops.Begin(user, removed, "of-removed", "add", "f", T0.AddDays(36)).Replayed);
        Assert.True(ops.Begin(user, "create-playlist", "created", "create", "f", T0.AddDays(36)).Replayed);

        // Day 61: the open one from day 0 goes too; the recent one stays.
        Assert.True(ops.Purge(T0.AddDays(61)) >= 1);
        Assert.False(ops.Begin(user, kept, "old-open", "add", "f", T0.AddDays(61)).Replayed);
        Assert.True(ops.Begin(user, kept, "recent", "add", "f", T0.AddDays(61)).Replayed);
        Assert.Equal(recent.Id, ops.Begin(user, kept, "recent", "add", "f", T0.AddDays(61)).Operation!.Id);
    }

    [Fact]
    public void PurgeUserRemovesOnlyThatPersonsOperationsAndLinks()
    {
        using var db = new Db();
        var ops = new ListOperations(db.Database);
        var links = new ListLinks(db.Database);
        var gone = Guid.NewGuid();
        var stays = Guid.NewGuid();
        const string list = "0123456789abcdef0123456789abcdef";
        ops.Begin(gone, list, "c", "add", "f", T0);
        ops.Begin(stays, list, "c", "add", "f", T0);
        links.Add(new ListLink(list, "p1", gone, "w1", null, "movie:tmdb:1", "{}", "standard"), T0);
        links.Add(new ListLink(list, "p1", stays, "w2", null, "movie:tmdb:1", "{}", "standard"), T0);

        ops.PurgeUser(gone);
        links.PurgeUser(gone);

        Assert.False(ops.Begin(gone, list, "c", "add", "f", T0).Replayed);
        Assert.True(ops.Begin(stays, list, "c", "add", "f", T0).Replayed);
        Assert.Equal(new[] { stays }, links.ForList(list).Select(l => l.UserId));
    }

    // ── ListLinks ─────────────────────────────────────────────────────

    [Fact]
    public void LinksAreIdempotentPerPersonAndPruneKeepsOnlyEntriesStillInTheList()
    {
        using var db = new Db();
        var links = new ListLinks(db.Database);
        const string list = "0123456789abcdef0123456789abcdef";
        const string other = "fedcba9876543210fedcba9876543210";
        var a = Guid.NewGuid();
        var b = Guid.NewGuid();
        links.Add(new ListLink(list, "p1", a, "w1", "op1", "movie:tmdb:1", "{}", "standard"), T0);
        links.Add(new ListLink(list, "p1", a, "w1", "op1", "movie:tmdb:1", "{}", "standard"), T0.AddSeconds(1)); // same link again
        links.Add(new ListLink(list, "p1", b, "w1", "op2", "movie:tmdb:1", "{}", "standard"), T0.AddSeconds(2)); // another person, same request
        links.Add(new ListLink(list, "p2", a, "w2", "op1", "tv:tvdb:5", "{}", "4k"), T0.AddSeconds(3));
        links.Add(new ListLink(other, "p9", a, "w9", null, "movie:tmdb:9", "{}", "standard"), T0.AddSeconds(4));

        var all = links.ForList(list);
        Assert.Equal(3, all.Count);
        Assert.Equal(new[] { a, b }, links.ForWant("w1").Select(l => l.UserId));
        Assert.Equal(("tv:tvdb:5", "4k", "op1"), (all[2].TitleKey, all[2].Edition, all[2].OperationId));

        // p1 is gone from the list: its links go, p2's stay; another list is untouched.
        Assert.Equal(2, links.Prune(list, new HashSet<string> { "p2" }));
        Assert.Equal(new[] { "p2" }, links.ForList(list).Select(l => l.PlaceholderId));
        Assert.Equal(0, links.Prune(list, new HashSet<string> { "p2" }));

        // The whole list.
        Assert.Equal(1, links.Prune(list, null));
        Assert.Empty(links.ForList(list));
        Assert.Single(links.ForList(other));
    }

    // ── ListEventStore ────────────────────────────────────────────────

    [Fact]
    public void AnEventIsRecordedOncePerListEntryAndItemsAndACompletionIsItsOwnEvent()
    {
        using var db = new Db();
        var events = new ListEventStore(db.Database);
        var raised = new List<ListSwapEvent>();
        events.Recorded += raised.Add;
        const string list = "0123456789abcdef0123456789abcdef";

        Assert.True(events.Record(list, "p1", "season", "tv:tvdb:5", "standard", new[] { "b", "a" }, false, T0));
        Assert.False(events.Record(list, "p1", "season", "tv:tvdb:5", "standard", new[] { "a", "b" }, false, T0.AddMinutes(1))); // same items, any order
        Assert.True(events.Record(list, "p1", "season", "tv:tvdb:5", "standard", new[] { "a", "b" }, true, T0.AddMinutes(2)));  // the completion
        Assert.False(events.Record(list, "p1", "season", "tv:tvdb:5", "standard", new[] { "a", "b" }, true, T0.AddMinutes(3)));
        Assert.True(events.Record(list, "p1", "season", "tv:tvdb:5", "standard", new[] { "c" }, false, T0.AddMinutes(4)));
        Assert.True(events.Record(list, "p2", "movie", "movie:tmdb:1", "standard", new[] { "a" }, true, T0.AddMinutes(5)));
        Assert.False(events.Record(list, "p3", "movie", null, null, Array.Empty<string>(), true, T0)); // nothing verified

        Assert.Equal(4, raised.Count);
        var pending = events.Pending();
        Assert.Equal(4, pending.Count);
        Assert.Equal(new[] { "a", "b" }, pending[0].ItemIds);
        Assert.Equal((false, true), (pending[0].Complete, pending[1].Complete));
        Assert.Equal(("p2", "movie", "movie:tmdb:1", "standard"), (pending[3].PlaceholderId, pending[3].Kind, pending[3].TitleKey, pending[3].Edition));
        Assert.Equal(T0, pending[0].CreatedAt);
        Assert.Equal(pending.Select(e => e.Id), raised.Select(e => e.Id));
    }

    [Fact]
    public void DeliveredEventsLeavePendingAndArePurgedAfterThirtyDaysAndARemovedListLosesAllItsEvents()
    {
        using var db = new Db();
        var events = new ListEventStore(db.Database);
        const string list = "0123456789abcdef0123456789abcdef";
        const string removed = "fedcba9876543210fedcba9876543210";
        events.Record(list, "p1", "movie", "movie:tmdb:1", "standard", new[] { "a" }, true, T0);
        events.Record(list, "p2", "movie", "movie:tmdb:2", "standard", new[] { "b" }, true, T0);
        events.Record(removed, "p3", "movie", "movie:tmdb:3", "standard", new[] { "c" }, true, T0);
        var first = events.Pending()[0];

        Assert.True(events.MarkDelivered(first.Id, T0));
        Assert.False(events.MarkDelivered(first.Id, T0)); // already delivered
        Assert.Equal(new[] { "p2", "p3" }, events.Pending().Select(e => e.PlaceholderId));
        Assert.Single(events.Pending(1));

        Assert.Equal(0, events.Purge(T0.AddDays(29)));
        Assert.Equal(1, events.Purge(T0.AddDays(31)));
        Assert.Equal(2, Count(db.Database, "SELECT COUNT(*) FROM list_events"));
        // Delivered and gone: the same event can be recorded again only because its row was purged.
        Assert.True(events.Record(list, "p1", "movie", "movie:tmdb:1", "standard", new[] { "a" }, true, T0.AddDays(31)));

        Assert.Equal(1, events.Purge(T0.AddDays(31), new[] { removed }));
        Assert.DoesNotContain(events.Pending(), e => e.ListId == removed);
        Assert.Equal(2, events.Pending().Count);
    }
}
