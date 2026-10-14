using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Threading;
using MediaBrowser.Common.Configuration;
using Microsoft.Data.Sqlite;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>
    /// The SQLite database of "Requests &amp; downloads" (<c>acquire.db</c> in Jellyfin Enhanced's data
    /// folder): follows, notifications and their delivery state now; the request ledger later. It
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
        private readonly SemaphoreSlim _writer = new(1, 1);
        private readonly ReaderWriterLockSlim _swap = new(LockRecursionPolicy.SupportsRecursion);
        private long _generation;
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
        };

        /// <summary>The database for a Jellyfin installation (DI).</summary>
        public AcquireDatabase(IApplicationPaths paths, Logger logger)
            : this(Path.Combine(paths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced", FileName), logger)
        {
            lock (SharedLock) _shared = this;
        }

        /// <summary>A database at an explicit path (tests).</summary>
        internal AcquireDatabase(string path, Logger? logger = null)
        {
            _path = path;
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
        public long Generation => Interlocked.Read(ref _generation);

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
        {
            ThrowIfUnavailable();
            _writer.Wait();
            try
            {
                _swap.EnterReadLock();
                try
                {
                    if (generation.HasValue && generation.Value != Generation) return (false, otherwise);
                    using var connection = Open();
                    using var transaction = connection.BeginTransaction(deferred: false);
                    var result = write(connection, transaction);
                    transaction.Commit();
                    return (true, result);
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
                            using var live = Open();
                            source.BackupDatabase(live);
                        }
                        Interlocked.Increment(ref _generation);
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
                if (version < Migrations.Count && existed && version > 0)
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
                _version = UserVersion(connection);
            }
            TrySetOwnerOnly(_path);
        }

        // A copy of the database as it was before a migration (acquire.db.pre-v<N>), the newest three kept.
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
