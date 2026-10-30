using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Globalization;
using System.IO;
using System.Threading;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using MediaBrowser.Common.Configuration;
using Microsoft.Data.Sqlite;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>
    /// The SQLite database of "Requests &amp; downloads" (<c>acquire.db</c> in Jellyfin Enhanced's data
    /// folder): follows, notifications, request intent, quota reservations and the outgoing ledger. It
    /// uses the host's own <c>Microsoft.Data.Sqlite</c> (both Jellyfin 10.11 and 12 ship it).
    /// <list type="bullet">
    /// <item><description>WAL, <c>synchronous=FULL</c>, foreign keys on, a busy timeout as a backstop.</description></item>
    /// <item><description>One writer at a time inside the process (a gate around short
    /// <c>BEGIN IMMEDIATE</c> transactions); readers don't block each other or the writer.</description></item>
    /// <item><description>A restore (<see cref="ReplaceWith"/>) waits for every read and write in
    /// flight, holds new ones back while it copies the backup in through SQLite's online backup, and
    /// moves <see cref="Generation"/> on, so work that started before it (a delivery being sent) can
    /// tell its row ids belong to the old database.</description></item>
    /// <item><description>Versioned migrations (<c>PRAGMA user_version</c>), each in its own
    /// transaction, with a copy of the database taken before any migration of an existing one. Later
    /// phases append migrations to <see cref="Migrations"/>; existing ones are never edited.</description></item>
    /// <item><description>A start-up probe: if SQLite can't be loaded or the file can't be opened, the
    /// database reports itself unavailable (<see cref="UnavailableReason"/>) and the features that
    /// need it stay off instead of failing on every request.</description></item>
    /// </list>
    /// </summary>
    public sealed class AcquireDatabase : IDisposable
    {
        /// <summary>The database file name inside the data folder.</summary>
        public const string FileName = "acquire.db";

        private static readonly object SharedLock = new();
        private static AcquireDatabase? _shared;

        private readonly string _path;
        private readonly string _connectionString;
        private sealed class FileGate
        {
            internal readonly SemaphoreSlim Writer = new(1, 1);
            internal readonly ReaderWriterLockSlim Swap = new(LockRecursionPolicy.SupportsRecursion);
            internal long Generation;
            internal EvidenceOrder Ordering { get; }
            internal FileGate() { Ordering = new EvidenceOrder(() => Interlocked.Read(ref Generation)); }
        }
        private static readonly ConcurrentDictionary<string, FileGate> FileGates = new(StringComparer.Ordinal);
        private readonly FileGate _fileGate;
        private readonly SemaphoreSlim _writer;
        private readonly ReaderWriterLockSlim _swap;
        internal EvidenceOrder EvidenceOrder => _fileGate.Ordering;
        private RetryOwners? _retryOwners;
        internal RetryOwners RetryOwners => _retryOwners ??= new RetryOwners(this);
        internal long ArrivalRevision;
        private readonly Logger? _logger;
        private readonly object _initLock = new();
        private bool _initialized;
        private string? _unavailable;
        private int _version;

        /// <summary>
        /// The schema, oldest first: index i holds the step from version i to i + 1. Append only.
        /// </summary>
        internal static readonly IReadOnlyList<string> Migrations = new[]
        {
            // 1: notifications (phase 2a): follows, per-user preferences and watch state, the inbox,
            // per-channel deliveries, episode batches, idempotency marks and small key/value state.
            @"
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE follows (
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    muted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, key));
CREATE INDEX follows_key ON follows (key);
CREATE TABLE notify_prefs (user_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE watch (
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    scope TEXT NOT NULL,
    stage TEXT,
    known TEXT,
    baseline_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, key, scope));
CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    event_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    title_key TEXT,
    item_id TEXT,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER,
    UNIQUE (user_id, event_key));
CREATE INDEX notifications_user ON notifications (user_id, id);
CREATE TABLE deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL,
    last_error TEXT,
    sent_at INTEGER,
    UNIQUE (notification_id, channel));
CREATE INDEX deliveries_due ON deliveries (status, next_at);
CREATE TABLE batches (
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    episodes TEXT NOT NULL,
    first_at INTEGER NOT NULL,
    due_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, key));
CREATE TABLE marks (
    user_id TEXT NOT NULL,
    mark TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (user_id, mark));
CREATE TABLE seerr_seen (
    request_id INTEGER PRIMARY KEY,
    status INTEGER NOT NULL,
    user_id TEXT,
    seen_at INTEGER NOT NULL);
CREATE TABLE email_codes (
    user_id TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    sent_at INTEGER NOT NULL,
    sent_today INTEGER NOT NULL DEFAULT 1,
    day TEXT NOT NULL);
",
            // 2: user intent, shared acquisitions, immutable outbox and quota accounting.
            @"
CREATE TABLE acquisitions (
    id TEXT PRIMARY KEY, title_key TEXT NOT NULL, variant TEXT NOT NULL,
    state TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX acquisitions_active ON acquisitions(title_key,variant) WHERE state='active';
CREATE TABLE wants (
    id TEXT PRIMARY KEY, acquisition_id TEXT NOT NULL REFERENCES acquisitions(id),
    user_id TEXT NOT NULL, client_request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    title_key TEXT NOT NULL, variant TEXT NOT NULL, mutation_input TEXT NOT NULL, owned_input TEXT,
    status TEXT NOT NULL, reason TEXT NOT NULL, cost INTEGER NOT NULL,
    target_key TEXT NOT NULL DEFAULT '', parental_signature TEXT NOT NULL, is_follower INTEGER NOT NULL DEFAULT 0, origin_kind TEXT NOT NULL DEFAULT 'interactive',
    origin_source_id TEXT, origin_request_id TEXT, import_batch_id TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(user_id,client_request_id), UNIQUE(origin_source_id,origin_request_id));
CREATE TABLE request_inputs (
    user_id TEXT NOT NULL, client_request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    want_id TEXT NOT NULL REFERENCES wants(id) ON DELETE CASCADE,
    PRIMARY KEY(user_id,client_request_id));
CREATE INDEX wants_user ON wants(user_id,status);
CREATE INDEX wants_title ON wants(title_key,variant,status);
CREATE TABLE reservations (
    id TEXT PRIMARY KEY, want_id TEXT NOT NULL REFERENCES wants(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL, cost INTEGER NOT NULL, estimated_gb REAL NOT NULL,
    state TEXT NOT NULL, charged_at INTEGER NOT NULL, scope TEXT NOT NULL,
    episode_count INTEGER NOT NULL DEFAULT 0,
    job_id TEXT,
    UNIQUE(want_id,scope));
CREATE INDEX reservations_user ON reservations(user_id,state,charged_at);
CREATE TABLE approvals (
    id TEXT PRIMARY KEY, want_id TEXT NOT NULL REFERENCES wants(id) ON DELETE CASCADE,
    actor_id TEXT, action TEXT NOT NULL, reason TEXT, edits TEXT,
    instance_id TEXT NOT NULL, connection_generation TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE jobs (
    id TEXT PRIMARY KEY, want_id TEXT NOT NULL REFERENCES wants(id) ON DELETE CASCADE,
    action TEXT NOT NULL, instance_id TEXT NOT NULL, connection_generation TEXT NOT NULL,
    mutation_input TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
    authorization_context TEXT NOT NULL, state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL,
    reason TEXT NOT NULL, outcome TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX jobs_due ON jobs(state,next_attempt);
CREATE TABLE request_audit (
    id TEXT PRIMARY KEY, want_id TEXT REFERENCES wants(id) ON DELETE SET NULL,
    job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL, actor_id TEXT,
    action TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE request_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title_key TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE request_notices (
    id TEXT PRIMARY KEY, want_id TEXT NOT NULL REFERENCES wants(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE request_deleted_users (user_hash TEXT PRIMARY KEY);
" + Phase3dTables + @"
",
            // 3: phase 4 foundation. Request origins and their server-built provenance; durable batch/confirmation
            // operations; automation budgets (durable admission), decisions (Shadow and every other mode), recorded
            // eligibility grants and per-target circuit breakers.
            @"
ALTER TABLE wants ADD COLUMN origin_detail TEXT;
ALTER TABLE wants ADD COLUMN operation_id TEXT;
CREATE INDEX wants_operation ON wants(operation_id);
CREATE TABLE request_operations (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, client_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, subject TEXT, size INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(user_id,kind,client_id));
CREATE TABLE automation_budget (
    id TEXT PRIMARY KEY, category TEXT NOT NULL, scope TEXT NOT NULL, unique_key TEXT NOT NULL,
    job_id TEXT, recipe TEXT, state TEXT NOT NULL, outcome TEXT,
    reserved_at INTEGER NOT NULL, settled_at INTEGER,
    UNIQUE(category,scope,unique_key));
CREATE INDEX automation_budget_window ON automation_budget(category,scope,reserved_at);
CREATE INDEX automation_budget_job ON automation_budget(job_id);
CREATE TABLE automation_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, decision_key TEXT NOT NULL UNIQUE, recipe TEXT NOT NULL,
    user_id TEXT, title_key TEXT, mode TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT NOT NULL,
    backend TEXT, detail TEXT, repeats INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX automation_decisions_at ON automation_decisions(updated_at);
CREATE INDEX automation_decisions_user ON automation_decisions(user_id);
CREATE TABLE automation_grants (
    user_id TEXT PRIMARY KEY, source TEXT NOT NULL, detail TEXT, granted_at INTEGER NOT NULL);
CREATE TABLE automation_breakers (
    target TEXT PRIMARY KEY, failures INTEGER NOT NULL, opened_until INTEGER, last_reason TEXT, updated_at INTEGER NOT NULL);
",
            // 4: phase 4b household rules and group quotas. The household-rule verdict a want was created with (its
            // rationale, shown to the requester and approvers), and the group pool each reservation is bound to.
            @"
ALTER TABLE wants ADD COLUMN rule_detail TEXT;
ALTER TABLE reservations ADD COLUMN pool_id TEXT;
CREATE INDEX reservations_pool ON reservations(pool_id,state,charged_at);
",
            // 5: phase 4 lists (4c1). Durable list operations (a retried add, apply, edit, reorder or list creation is
            // answered from its operation, never applied twice, across restarts); which person's request a list entry
            // asked for (list links, restored together with the requests they point at); verified swap-in events for
            // notifications. Every statement is guarded so the step doesn't depend on another phase-4 step.
            @"
CREATE TABLE IF NOT EXISTS list_operations (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, scope TEXT NOT NULL, client_id TEXT NOT NULL,
    kind TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL,
    status INTEGER, list_id TEXT, result TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(user_id,scope,client_id));
CREATE INDEX IF NOT EXISTS list_operations_at ON list_operations(updated_at);
CREATE TABLE IF NOT EXISTS list_links (
    list_id TEXT NOT NULL, placeholder_id TEXT NOT NULL, user_id TEXT NOT NULL, want_id TEXT NOT NULL,
    operation_id TEXT, title_key TEXT NOT NULL, scope TEXT NOT NULL, edition TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (list_id,placeholder_id,user_id,want_id));
CREATE INDEX IF NOT EXISTS list_links_want ON list_links(want_id);
CREATE INDEX IF NOT EXISTS list_links_user ON list_links(user_id);
CREATE TABLE IF NOT EXISTS list_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE, list_id TEXT NOT NULL, placeholder_id TEXT NOT NULL,
    kind TEXT NOT NULL, title_key TEXT, edition TEXT, item_ids TEXT NOT NULL, coords TEXT, complete INTEGER NOT NULL,
    created_at INTEGER NOT NULL, delivered_at INTEGER);
CREATE INDEX IF NOT EXISTS list_events_pending ON list_events(delivered_at);
",
            // 6: phase 4 home rows (4d). When each piece of content (a movie edition, an episode) first arrived in
            // Jellyfin, so "Just arrived for you" leaves out upgrades: a replacement file keeps the first date.
            // Guarded so the step doesn't depend on another phase-4 step.
            @"
CREATE TABLE IF NOT EXISTS home_arrivals (
    content TEXT PRIMARY KEY, first_at INTEGER NOT NULL);

",
            // 7: phase 4e acquisition badges. A person's own first arrivals ("new") and confirmed replacements ("upgraded",
            // user_id '' = everyone who can open the item), per movie or episode; which arrivals were judged; the first
            // arrival of each movie edition and episode number (so a renamed upgrade isn't a first arrival). Expiry and
            // "watched" are decided at read time. Every statement is guarded so the step doesn't depend on another
            // phase-4 step.
            @"
CREATE TABLE IF NOT EXISTS acquisition_stamps (
    item_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, title_key TEXT, series_id TEXT, season_id TEXT,
    at INTEGER NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (item_id,user_id,kind));
CREATE INDEX IF NOT EXISTS acquisition_stamps_at ON acquisition_stamps(at);
CREATE INDEX IF NOT EXISTS acquisition_stamps_user ON acquisition_stamps(user_id);
CREATE TABLE IF NOT EXISTS acquisition_seen (item_id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS acquisition_arrivals (part_key TEXT PRIMARY KEY, first_at INTEGER NOT NULL, item_id TEXT NOT NULL);
",
            // 8: phase 4f, the private Ready playlist (D47): consent and binding per server and owner, entries per interest,
            // native-message attempts. The same constant is ensured at every start (Ready.ReadyTables.Ensure), so a database
            // that reached 8 without these tables gets them; guarded, so the step doesn't depend on another phase-4 step.
            Ready.ReadyTables.Sql,
        };

        // Schema 4 extension (phase 4b, review round 4): the order charges were made in. Each reservation gets the next
        // sequence when it becomes charged, so two charges in the same millisecond keep their order; existing charges are
        // numbered by when they were charged, then by when they were written.
        internal const string SchemaFourChargeOrder = @"
ALTER TABLE reservations ADD COLUMN charge_seq INTEGER;
UPDATE reservations SET charge_seq=(SELECT n FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY charged_at, rowid) AS n FROM reservations WHERE state='charged') o WHERE o.id=reservations.id) WHERE state='charged';
CREATE INDEX reservations_order ON reservations(charge_seq);
";

        // Schema 4 extension (phase 4b, Q-4BFIX3-2): one title identity across its ids. Each alias the ledger has learned for a
        // title (a TMDB or IMDb id of a series held under its TVDB id, an IMDb id of a movie held under its TMDB id) maps to
        // the key the title's requests are held under.
        internal const string SchemaFourTitleAliases = @"
CREATE TABLE title_aliases (alias TEXT PRIMARY KEY, canonical TEXT NOT NULL, learned_at INTEGER NOT NULL);
CREATE INDEX title_aliases_canonical ON title_aliases(canonical);
";

        // Schema-4 extension (phase 4b, review round 5, 4b-B13): a merged title whose requests couldn't all be settled when it
        // was merged (one was being sent, or its send is unconfirmed) is noted here and finished once that work settles.
        internal const string SchemaFourTitleReconcile = @"
CREATE TABLE title_reconcile (acquisition_id TEXT PRIMARY KEY, noted_at INTEGER NOT NULL);
";

        // The edition's durable public retry namespace: children and outbox jobs stay linked to their request receipt. A
        // database that had request ids before takes each over as a completed legacy owner (ambiguous when one id named
        // two different requests). Guarded and idempotent: ensured at start-up (see Initialize), never a numbered step.
        internal const string RetryTables = @"
CREATE TABLE IF NOT EXISTS retry_owners (
    user_id TEXT NOT NULL, retry_key TEXT NOT NULL, revision TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL, identity TEXT NOT NULL, state TEXT NOT NULL,
    command TEXT, binding TEXT, action_receipt TEXT, result TEXT, result_type TEXT,
    deadline INTEGER, parent_revision TEXT REFERENCES retry_owners(revision) ON DELETE CASCADE, created_at INTEGER NOT NULL,
    PRIMARY KEY(user_id,retry_key));
INSERT OR IGNORE INTO retry_owners(user_id,retry_key,revision,kind,identity,state,created_at)
SELECT user_id,trim(client_request_id),lower(hex(randomblob(16))),'legacy_request',
       CASE WHEN COUNT(DISTINCT fingerprint)=1 THEN MIN(fingerprint) ELSE 'ambiguous_legacy_identity' END,'completed',0
FROM request_inputs GROUP BY user_id,trim(client_request_id);
CREATE TABLE IF NOT EXISTS retry_wants (
    owner_revision TEXT NOT NULL REFERENCES retry_owners(revision) ON DELETE CASCADE,
    want_id TEXT NOT NULL REFERENCES wants(id) ON DELETE CASCADE,
    PRIMARY KEY(owner_revision,want_id));
INSERT OR IGNORE INTO retry_wants SELECT o.revision,i.want_id FROM retry_owners o JOIN request_inputs i
ON o.user_id=i.user_id AND o.retry_key=trim(i.client_request_id);
CREATE TABLE IF NOT EXISTS request_search_slots (
    slot TEXT PRIMARY KEY, owner_revision TEXT REFERENCES retry_owners(revision) ON DELETE SET NULL,
    claimed_at INTEGER NOT NULL);
";

        // Seerr import batches (authority transfer, rollback by batch) and the automation outcome log.
        // Part of the unreleased schema 2; an existing schema-2 database gets them idempotently at start-up.
        private const string Phase3dTables = @"
CREATE TABLE IF NOT EXISTS import_batches (
    id TEXT PRIMARY KEY, origin_kind TEXT NOT NULL, origin_source_id TEXT NOT NULL, digest TEXT NOT NULL,
    actor_id TEXT, previous_backend TEXT NOT NULL, imported INTEGER NOT NULL, skipped TEXT NOT NULL,
    state TEXT NOT NULL, created_at INTEGER NOT NULL, rollback_until INTEGER NOT NULL,
    rolled_back_at INTEGER, removed INTEGER NOT NULL DEFAULT 0, kept INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS wants_import_batch ON wants(import_batch_id);
CREATE TABLE IF NOT EXISTS automation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, recipe TEXT NOT NULL, user_id TEXT, title_key TEXT,
    outcome TEXT NOT NULL, reason TEXT NOT NULL, want_id TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS automation_log_at ON automation_log(created_at);
CREATE INDEX IF NOT EXISTS automation_log_user ON automation_log(user_id);
";

        /// <summary>The database for a Jellyfin installation (DI).</summary>
        public AcquireDatabase(IApplicationPaths paths, Logger logger)
            : this(Path.Combine(paths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced", FileName), logger)
        {
            lock (SharedLock) _shared = this;
        }

        /// <summary>A database at an explicit path (tests).</summary>
        internal AcquireDatabase(string path, Logger? logger = null)
        {
            _path = Path.GetFullPath(path);
            _fileGate = FileGates.GetOrAdd(_path, _ => new FileGate());
            _writer = _fileGate.Writer;
            _swap = _fileGate.Swap;
            _logger = logger;
            _connectionString = new SqliteConnectionStringBuilder
            {
                DataSource = path,
                Mode = SqliteOpenMode.ReadWriteCreate,
                Cache = SqliteCacheMode.Private,
                Pooling = true,
                DefaultTimeout = 30,
            }.ToString();
        }

        /// <summary>
        /// The installation's database (null before it is created, or in tests): JE's backup reads a
        /// consistent copy through it and a restore replaces the file through it.
        /// </summary>
        public static AcquireDatabase? Shared
        {
            get { lock (SharedLock) return _shared; }
        }

        /// <summary>The database file.</summary>
        public string FilePath => _path;

        /// <summary>True when the database opened and is at the current schema.</summary>
        public bool Available
        {
            get
            {
                EnsureInitialized();
                return _unavailable == null;
            }
        }

        /// <summary>Why the database is unavailable (administrator wording), or null.</summary>
        public string? UnavailableReason
        {
            get
            {
                EnsureInitialized();
                return _unavailable;
            }
        }

        /// <summary>The schema version in use (0 when unavailable).</summary>
        public int Version
        {
            get
            {
                EnsureInitialized();
                return _version;
            }
        }

        /// <summary>
        /// Moves on each time the database is replaced by a restore: row ids read under one
        /// generation mean nothing under the next.
        /// </summary>
        public long Generation => Interlocked.Read(ref _fileGate.Generation);

        /// <summary>
        /// The version of what the automatic-write check reads from this database: budget admissions and their settling
        /// (<c>automation_budget</c>), breakers (<c>automation_breakers</c>) and eligibility grants
        /// (<c>automation_grants</c>). Every write of those tables is made through <see cref="WriteAutomation{T}"/> (a source
        /// scan checks it), and a restore replaces them inside it too: the version is odd before the change commits and
        /// even after. The check samples it before it gathers those facts and again when it decides.
        /// </summary>
        public FactVersion Automation { get; } = new();

        /// <summary>Tests: runs on the writer's thread as a write has committed (other readers see it), before it returns.</summary>
        internal Action? Committed { get; set; }

        /// <summary>Runs a read (any number at once). Throws <see cref="InvalidOperationException"/> when unavailable.</summary>
        public T Read<T>(Func<SqliteConnection, T> read)
        {
            ThrowIfUnavailable();
            _swap.EnterReadLock();
            try
            {
                using var connection = Open();
                return read(connection);
            }
            finally
            {
                _swap.ExitReadLock();
            }
        }

        /// <summary>
        /// Runs a write in one transaction (one writer at a time). The work must be short; it commits
        /// when it returns and rolls back when it throws.
        /// </summary>
        public T Write<T>(Func<SqliteConnection, SqliteTransaction, T> write)
            => WriteIf(null, write, default!).Result;

        /// <summary>
        /// Runs a write like <see cref="Write{T}"/>, but only while the database is still at
        /// <paramref name="generation"/> (null: any). Returns false (and <paramref name="otherwise"/>)
        /// when a restore replaced it since.
        /// </summary>
        public (bool Done, T Result) WriteIf<T>(long? generation, Func<SqliteConnection, SqliteTransaction, T> write, T otherwise)
            => WriteCore(generation, write, otherwise, null);

        /// <summary>
        /// Runs a write like <see cref="Write{T}"/> that changes what the automatic-write check reads (budget admissions,
        /// breakers, grants): inside <see cref="Automation"/>'s bracket, from the moment this write is the writer until it
        /// has committed or failed. The only way to write those tables.
        /// </summary>
        public T WriteAutomation<T>(Func<SqliteConnection, SqliteTransaction, T> write)
            => WriteCore(null, write, default!, Automation).Result;

        private (bool Done, T Result) WriteCore<T>(long? generation, Func<SqliteConnection, SqliteTransaction, T> write, T otherwise, FactVersion? version)
        {
            using var effect = SeerrFacts.BeginEffect();
            ThrowIfUnavailable();
            _writer.Wait();
            try
            {
                _swap.EnterReadLock();
                try
                {
                    if (generation.HasValue && generation.Value != Generation) return (false, otherwise);
                    return version == null ? Commit(write) : version.Mutate(() => Commit(write));
                }
                finally
                {
                    _swap.ExitReadLock();
                }
            }
            finally
            {
                _writer.Release();
            }
        }

        private (bool Done, T Result) Commit<T>(Func<SqliteConnection, SqliteTransaction, T> write)
        {
            using var connection = Open();
            using var transaction = connection.BeginTransaction(deferred: false);
            var result = write(connection, transaction);
            transaction.Commit();
            Committed?.Invoke();
            return (true, result);
        }

        /// <summary>A consistent copy of the database (SQLite's online backup), for JE's backup zip; null when there is none.</summary>
        public byte[]? Snapshot()
        {
            if (!Available || !File.Exists(_path)) return null;
            var temp = _path + ".tmp." + Guid.NewGuid().ToString("N");
            _swap.EnterReadLock();
            try
            {
                using (var source = Open())
                using (var target = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = temp, Pooling = false }.ToString()))
                {
                    target.Open();
                    source.BackupDatabase(target);
                }
                return File.ReadAllBytes(temp);
            }
            finally
            {
                _swap.ExitReadLock();
                TryDelete(temp);
            }
        }

        /// <summary>
        /// Replaces the database's contents with <paramref name="bytes"/> (a JE restore). Waits for the
        /// writer and for every read and write in flight and holds new ones back; copies the backup in
        /// with SQLite's online backup (the live file is never deleted or renamed under an open
        /// connection, and its WAL stays consistent); moves <see cref="Generation"/> on; then opens it
        /// again (migrating it if it is older). Throws when <paramref name="bytes"/> isn't a database.
        /// </summary>
        public void ReplaceWith(byte[] bytes)
        {
            ArgumentNullException.ThrowIfNull(bytes);
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            var temp = _path + ".restore." + Guid.NewGuid().ToString("N");
            try
            {
                File.WriteAllBytes(temp, bytes);
                _writer.Wait();
                try
                {
                    _swap.EnterWriteLock();
                    try
                    {
                        using (var source = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = temp, Mode = SqliteOpenMode.ReadWrite, Pooling = false }.ToString()))
                        {
                            source.Open();
                            // A file that isn't a database fails here, before the live one is touched.
                            UserVersion(source);
                            // Phase 4f (D47): the copy carries a fresh restore stamp, so the start-up ensure applies the
                            // Ready restore policy even if the server stops before the restore's listeners run.
                            StampRestore(source);
                            using var live = Open();
                            // Every automation table is replaced: inside its version's bracket, like any other write of them.
                            Automation.Mutate(() =>
                            {
                                source.BackupDatabase(live);
                                Interlocked.Increment(ref _fileGate.Generation);
                            });
                        }
                        lock (_initLock)
                        {
                            _initialized = false;
                            _unavailable = null;
                            _version = 0;
                        }
                    }
                    finally
                    {
                        _swap.ExitWriteLock();
                    }
                }
                finally
                {
                    _writer.Release();
                }
            }
            finally
            {
                TryDelete(temp);
                TryDelete(temp + "-wal");
                TryDelete(temp + "-shm");
            }
            EnsureInitialized();
        }

        /// <summary>True for the database file or its SQLite side files (JE's backup reads the database through <see cref="Snapshot"/> and leaves the side files out).</summary>
        public static bool IsDatabaseFile(string relativePath)
            => relativePath.Equals(FileName, StringComparison.OrdinalIgnoreCase)
               || relativePath.StartsWith(FileName + "-", StringComparison.OrdinalIgnoreCase)
               || relativePath.StartsWith(FileName + ".pre-v", StringComparison.OrdinalIgnoreCase);

        /// <inheritdoc />
        public void Dispose()
        {
            lock (SharedLock)
            {
                if (ReferenceEquals(_shared, this)) _shared = null;
            }
            try
            {
                SqliteConnection.ClearPool(new SqliteConnection(_connectionString));
            }
            catch (Exception)
            {
                // SQLite never loaded: nothing pooled.
            }
        }

        private void ThrowIfUnavailable()
        {
            EnsureInitialized();
            if (_unavailable != null) throw new InvalidOperationException(_unavailable);
        }

        private SqliteConnection Open()
        {
            var connection = new SqliteConnection(_connectionString);
            connection.Open();
            connection.CreateFunction<string, bool>("je_alias_current", Helpers.UserCacheRegistry.ReadPersistedOrigin);
            using var pragmas = connection.CreateCommand();
            pragmas.CommandText = "PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=30000;";
            pragmas.ExecuteNonQuery();
            return connection;
        }

        private void EnsureInitialized()
        {
            if (Volatile.Read(ref _initialized)) return;
            lock (_initLock)
            {
                if (_initialized) return;
                try
                {
                    Initialize();
                }
                catch (Exception ex) when (ex is FileNotFoundException or FileLoadException or DllNotFoundException or TypeInitializationException or TypeLoadException or BadImageFormatException)
                {
                    _unavailable = "SQLite could not be loaded on this server (" + ex.GetType().Name + "), so follows and notifications are off.";
                    _logger?.Error("Requests & downloads: " + _unavailable + " " + ex.Message);
                }
                catch (Exception ex) when (ex is SqliteException or IOException or UnauthorizedAccessException or InvalidOperationException)
                {
                    _unavailable = "The Requests & downloads database (" + FileName + ") could not be opened: " + ex.Message;
                    _logger?.Error("Requests & downloads: " + _unavailable);
                }
                _initialized = true;
            }
        }

        private void Initialize()
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            var existed = File.Exists(_path) && new FileInfo(_path).Length > 0;
            using (var connection = Open())
            {
                using (var wal = connection.CreateCommand())
                {
                    wal.CommandText = "PRAGMA journal_mode=WAL;";
                    wal.ExecuteScalar();
                }
                var version = UserVersion(connection);
                if (version > Migrations.Count)
                {
                    _unavailable = $"The Requests & downloads database is from a newer Jellyfin Enhanced (schema {version}, this version knows {Migrations.Count}). It was left untouched; update the plugin, or restore an older backup.";
                    _logger?.Error("Requests & downloads: " + _unavailable);
                    return;
                }
                // Decide from the ORIGINAL schema and rows, before even an empty-table or bookkeeping repair. A later
                // repair must never copy the result of an earlier one. Empty additive ensures still need no copy.
                if (existed && version > 0 && (version < Migrations.Count || NeedsRepairBackup(connection, version)))
                {
                    BackupBeforeMigration(connection, version);
                }
                for (var v = version; v < Migrations.Count; v++)
                {
                    using var transaction = connection.BeginTransaction(deferred: false);
                    using (var step = connection.CreateCommand())
                    {
                        step.Transaction = transaction;
                        step.CommandText = Migrations[v] + $"\nPRAGMA user_version={v + 1};";
                        step.ExecuteNonQuery();
                    }
                    transaction.Commit();
                    _logger?.Info($"Requests & downloads: database migrated to schema {v + 1}.");
                }
                // Earlier phase-3a installations already have schema 2. Extend that migration idempotently.
                using (var columns = connection.CreateCommand())
                {
                    columns.CommandText = "SELECT COUNT(*) FROM pragma_table_info('reservations') WHERE name='episode_count'";
                    if (Convert.ToInt32(columns.ExecuteScalar(), CultureInfo.InvariantCulture) == 0)
                    {
                        using var transaction = connection.BeginTransaction(deferred: false);
                        using var extend = connection.CreateCommand();
                        extend.Transaction = transaction;
                        extend.CommandText = @"ALTER TABLE reservations ADD COLUMN episode_count INTEGER NOT NULL DEFAULT 0;
UPDATE reservations SET episode_count=COALESCE((SELECT CASE WHEN json_extract(owned_input,'$.Scope')='episodes' THEN json_array_length(owned_input,'$.Episodes') ELSE 0 END FROM wants WHERE id=reservations.want_id),0) WHERE scope='initial';";
                        extend.ExecuteNonQuery();
                        transaction.Commit();
                    }
                }
                using (var columns = connection.CreateCommand())
                {
                    columns.CommandText = "SELECT COUNT(*) FROM pragma_table_info('wants') WHERE name='target_key'";
                    var addTarget = Convert.ToInt32(columns.ExecuteScalar(), CultureInfo.InvariantCulture) == 0;
                    columns.CommandText = "SELECT COUNT(*) FROM pragma_table_info('reservations') WHERE name='job_id'";
                    var addJob = Convert.ToInt32(columns.ExecuteScalar(), CultureInfo.InvariantCulture) == 0;
                    columns.CommandText = "SELECT COUNT(*) FROM meta WHERE key='request_target_repair_v3'";
                    var repair = Convert.ToInt32(columns.ExecuteScalar(), CultureInfo.InvariantCulture) == 0;
                    if (addTarget || addJob || repair)
                    {
                        using var transaction = connection.BeginTransaction(deferred: false);
                        using var extend = connection.CreateCommand();
                        extend.Transaction = transaction;
                        if (addTarget || addJob)
                        {
                            extend.CommandText = (addTarget ? "ALTER TABLE wants ADD COLUMN target_key TEXT NOT NULL DEFAULT '';" : "") +
                                (addJob ? "ALTER TABLE reservations ADD COLUMN job_id TEXT;" : "");
                            extend.ExecuteNonQuery();
                        }
                        Requests.RequestLedger.ExtendSchemaTwo(connection, transaction, addTarget || repair, addJob, onlyEmptyTargets: !addTarget);
                        extend.CommandText = "INSERT OR REPLACE INTO meta(key,value) VALUES('request_target_repair_v3','1')";
                        extend.ExecuteNonQuery();
                        transaction.Commit();
                    }
                }
                using (var tables = connection.CreateCommand())
                {
                    tables.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('import_batches','automation_log')";
                    if (UserVersion(connection) >= 2 && Convert.ToInt32(tables.ExecuteScalar(), CultureInfo.InvariantCulture) < 2)
                    {
                        // Additive only (new empty tables), so no pre-migration copy is needed.
                        using var transaction = connection.BeginTransaction(deferred: false);
                        using var extend = connection.CreateCommand();
                        extend.Transaction = transaction;
                        extend.CommandText = Phase3dTables;
                        extend.ExecuteNonQuery();
                        transaction.Commit();
                    }
                }
                // Schema 4 (phase 4b) is extended while unreleased: a database that ran an earlier schema-4 build (and a fresh
                // one, right after the step) gets the extension once, in one transaction, copied first when it holds rows.
                using (var columns = connection.CreateCommand())
                {
                    columns.CommandText = "SELECT COUNT(*) FROM pragma_table_info('reservations') WHERE name='charge_seq'";
                    if (UserVersion(connection) >= 4 && Convert.ToInt32(columns.ExecuteScalar(), CultureInfo.InvariantCulture) == 0)
                    {
                        using var transaction = connection.BeginTransaction(deferred: false);
                        using var extend = connection.CreateCommand();
                        extend.Transaction = transaction;
                        extend.CommandText = SchemaFourChargeOrder;
                        extend.ExecuteNonQuery();
                        transaction.Commit();
                    }
                }
                using (var tables = connection.CreateCommand())
                {
                    tables.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='title_aliases'";
                    if (UserVersion(connection) >= 4 && Convert.ToInt32(tables.ExecuteScalar(), CultureInfo.InvariantCulture) == 0)
                    {
                        // Additive only (a new empty table), so no pre-migration copy is needed.
                        using var transaction = connection.BeginTransaction(deferred: false);
                        using var extend = connection.CreateCommand();
                        extend.Transaction = transaction;
                        extend.CommandText = SchemaFourTitleAliases;
                        extend.ExecuteNonQuery();
                        transaction.Commit();
                    }
                }
                // Additive extension of unreleased schema 4. Keep every physical alias; the read view withholds
                // incidental Seerr associations whose input generation is no longer authoritative.
                using (var tables = connection.CreateCommand())
                {
                    tables.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='title_alias_origins'";
                    if (UserVersion(connection) >= 4 && Convert.ToInt32(tables.ExecuteScalar(), CultureInfo.InvariantCulture) == 0)
                    {
                        using var transaction = connection.BeginTransaction(deferred: false);
                        using var extend = connection.CreateCommand();
                        extend.Transaction = transaction;
                        extend.CommandText = "CREATE TABLE title_alias_origins(alias TEXT PRIMARY KEY NOT NULL,facts_generation TEXT NOT NULL);" +
                            "INSERT INTO title_alias_origins SELECT a.alias,$origin FROM title_aliases a WHERE NOT EXISTS(SELECT 1 FROM wants WHERE title_key IN(a.alias,a.canonical)) AND NOT EXISTS(SELECT 1 FROM acquisitions WHERE title_key IN(a.alias,a.canonical));" +
                            "CREATE VIEW active_title_aliases AS SELECT a.* FROM title_aliases a LEFT JOIN title_alias_origins o ON o.alias=a.alias WHERE o.alias IS NULL OR je_alias_current(o.facts_generation);";
                        var legacy = Backends.EffectiveRequestsBackend.Shared.Current.IsolationVersion == 0;
                        extend.Parameters.AddWithValue("$origin", legacy ? Helpers.UserCacheRegistry.PersistentGeneration : "legacy-unproven");
                        extend.ExecuteNonQuery();
                        transaction.Commit();
                    }
                }
                using (var tables = connection.CreateCommand())
                {
                    tables.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='title_reconcile'";
                    if (UserVersion(connection) >= 4 && Convert.ToInt32(tables.ExecuteScalar(), CultureInfo.InvariantCulture) == 0)
                    {
                        // Additive only (a new empty table), so no pre-migration copy is needed.
                        using var transaction = connection.BeginTransaction(deferred: false);
                        using var extend = connection.CreateCommand();
                        extend.Transaction = transaction;
                        extend.CommandText = SchemaFourTitleReconcile;
                        extend.ExecuteNonQuery();
                        transaction.Commit();
                    }
                }
                // The edition's durable retry namespace (retry owners, the wants they took, the Search slots). The edition track
                // numbered it schema 3 on its own base; joined, the numbered steps stay 1-8 byte for byte (D71: the next one is
                // AA's 9), so it is ensured here at every start, like the other repairs: a fresh database gets the empty tables
                // right after its steps; an upgraded one takes its legacy request ids over once (in one transaction, the
                // original copied first when there are any).
                using (var tables = connection.CreateCommand())
                {
                    tables.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('retry_owners','retry_wants','request_search_slots')";
                    if (UserVersion(connection) >= 2 && Convert.ToInt32(tables.ExecuteScalar(), CultureInfo.InvariantCulture) < 3)
                    {
                        using var transaction = connection.BeginTransaction(deferred: false);
                        using var extend = connection.CreateCommand();
                        extend.Transaction = transaction;
                        extend.CommandText = RetryTables;
                        extend.ExecuteNonQuery();
                        transaction.Commit();
                    }
                }
                // Repair installations whose reserved step 6 was empty (including schema 7).
                // The newer-version rejection above always runs before this additive repair.
                if (UserVersion(connection) >= 6) ContentArrivalHistory.Ensure(connection);
                // Phase 4f (D47): the Ready tables and the restore policy, on every supported start and after every restore.
                if (UserVersion(connection) >= 8) Ready.ReadyTables.Ensure(connection);
                // The add-settings registry's migration of held jobs: its preimage is the one original copy taken above
                // (NeedsRepairBackup classifies it from the original rows), never a copy of an earlier repair's result.
                Requests.TitleChoiceRegistry.Ensure(connection);
                // F83: the id matches of TMDB-numbered episode requests (additive; no schema step of its own).
                Requests.RequestLedger.EnsureEpisodeIdentities(connection);
                _version = UserVersion(connection);
            }
            TrySetOwnerOnly(_path);
        }

        // A copy of the database as it was before a migration (acquire.db.pre-v<N>), the newest three kept.
        // Every repair that needs a preimage is classified here, using only reads of the original database. The single
        // backup call above precedes every numbered step and additive ensure, including ones that need no backup alone.
        private static bool NeedsRepairBackup(SqliteConnection connection, int version)
        {
            long Count(string sql)
            {
                using var query = connection.CreateCommand();
                query.CommandText = sql;
                return Convert.ToInt64(query.ExecuteScalar(), CultureInfo.InvariantCulture);
            }
            if (version < 2) return false;
            if (Count("SELECT COUNT(*) FROM pragma_table_info('reservations') WHERE name='episode_count'") == 0
                || Count("SELECT COUNT(*) FROM pragma_table_info('wants') WHERE name='target_key'") == 0
                || Count("SELECT COUNT(*) FROM pragma_table_info('reservations') WHERE name='job_id'") == 0) return true;
            if (Count("SELECT COUNT(*) FROM meta WHERE key='request_target_repair_v3'") == 0
                && Count("SELECT COUNT(*) FROM wants WHERE target_key='' AND status IN ('pending','queued','sent','stale')") > 0) return true;
            if (version >= 4 && Count("SELECT COUNT(*) FROM pragma_table_info('reservations') WHERE name='charge_seq'") == 0
                && Count("SELECT COUNT(*) FROM reservations") > 0) return true;
            if (Count("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('retry_owners','retry_wants','request_search_slots')") < 3
                && Count("SELECT COUNT(*) FROM request_inputs") > 0) return true;
            // Held jobs whose add settings move into the one durable per-title registry (Manage Add): rows are rewritten.
            return Requests.TitleChoiceRegistry.NeedsMigration(connection);
        }

        private void BackupBeforeMigration(SqliteConnection connection, int version)
        {
            var copy = _path + ".pre-v" + version.ToString(CultureInfo.InvariantCulture) + "." + DateTime.UtcNow.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture);
            using (var target = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = copy, Pooling = false }.ToString()))
            {
                target.Open();
                connection.BackupDatabase(target);
            }
            TrySetOwnerOnly(copy);
            var folder = Path.GetDirectoryName(_path)!;
            var old = Directory.EnumerateFiles(folder, Path.GetFileName(_path) + ".pre-v*")
                .OrderByDescending(f => f, StringComparer.Ordinal)
                .Skip(3)
                .ToList();
            foreach (var stale in old) TryDelete(stale);
        }

        // A restored copy's stamp (its meta table exists from schema 1 on; an emptier file is left as it is).
        private static void StampRestore(SqliteConnection source)
        {
            using var command = source.CreateCommand();
            command.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='meta'";
            if (Convert.ToInt32(command.ExecuteScalar(), CultureInfo.InvariantCulture) == 0) return;
            command.CommandText = "INSERT INTO meta(key,value) VALUES($k,$v) ON CONFLICT(key) DO UPDATE SET value=excluded.value";
            command.Parameters.AddWithValue("$k", Ready.ReadyTables.RestoredKey);
            command.Parameters.AddWithValue("$v", Guid.NewGuid().ToString("N"));
            command.ExecuteNonQuery();
        }

        private static int UserVersion(SqliteConnection connection)
        {
            using var command = connection.CreateCommand();
            command.CommandText = "PRAGMA user_version;";
            return Convert.ToInt32(command.ExecuteScalar(), CultureInfo.InvariantCulture);
        }

        private static void TrySetOwnerOnly(string path)
        {
            if (OperatingSystem.IsWindows() || !File.Exists(path)) return;
            try
            {
                File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            }
            catch (Exception)
            {
                // Best effort (a filesystem without permissions).
            }
        }

        private static void TryDelete(string path)
        {
            try
            {
                if (File.Exists(path)) File.Delete(path);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }
}
