using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using static Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify.NotifyValues;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify
{
    /// <summary>
    /// Reads and writes the notification tables of <see cref="AcquireDatabase"/>: follows, per-user
    /// preferences, watch state (what each user was last told about a title), the inbox with its
    /// per-channel deliveries (created in the same transaction), episode batches, idempotency marks
    /// and Seerr's last-seen request states. Every method is one short statement or transaction;
    /// <see cref="InTransaction{T}"/> runs several changes as one (an event's "handled" marks and its
    /// notification commit together, or not at all).
    /// </summary>
    public sealed class NotifyStore
    {
        /// <summary>Most follows one user may hold.</summary>
        public const int MaxFollowsPerUser = 300;

        private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

        // Users deleted lately (their stored id) and until when (Environment.TickCount64): work already
        // composed for one of them before the deletion (a round that checked them just before) must
        // not bring their rows back, so every write removes theirs again in the same transaction.
        private static readonly long DeletedForMs = (long)TimeSpan.FromMinutes(10).TotalMilliseconds;

        private readonly AcquireDatabase _db;
        private readonly ConcurrentDictionary<string, long> _deleted = new(StringComparer.Ordinal);

        /// <summary>The store over the installation's database (DI).</summary>
        public NotifyStore(AcquireDatabase db)
        {
            _db = db;
        }

        // Every write of this store: the work, then (in the same transaction) the rows of users deleted lately.
        private T Write<T>(Func<SqliteConnection, SqliteTransaction, T> write) => _db.Write((c, t) =>
        {
            var result = write(c, t);
            RemoveDeleted(c, t);
            return result;
        });

        private (bool Done, T Result) WriteIf<T>(long? generation, Func<SqliteConnection, SqliteTransaction, T> write, T otherwise) => _db.WriteIf(generation, (c, t) =>
        {
            var result = write(c, t);
            RemoveDeleted(c, t);
            return result;
        }, otherwise);

        private int RemoveDeleted(SqliteConnection c, SqliteTransaction t)
        {
            if (_deleted.IsEmpty) return 0;
            var now = Environment.TickCount64;
            var removed = 0;
            foreach (var (user, until) in _deleted)
            {
                if (now > until)
                {
                    _deleted.TryRemove(user, out _);
                    continue;
                }
                foreach (var table in UserTables) removed += Exec(c, t, $"DELETE FROM {table} WHERE user_id=$u", ("$u", user));
            }
            return removed;
        }

        /// <summary>The database.</summary>
        public AcquireDatabase Database => _db;

        /// <summary>True when the database can be used.</summary>
        public bool Available => _db.Available;

        /// <summary>
        /// The database's generation (moves on with a restore): read it before reading rows whose
        /// follow-up write must not land in a restored database (the <c>InTransaction</c> overload with a generation).
        /// </summary>
        public long Generation => _db.Generation;

        // ------------------------------------------------------------------ meta

        /// <summary>A stored value, or null.</summary>
        public string? Meta(string key) => _db.Read(c => Scalar(c, "SELECT value FROM meta WHERE key=$k", ("$k", key)) as string);

        /// <summary>Stores (or with null removes) a value.</summary>
        public void SetMeta(string key, string? value) => Write((c, t) =>
        {
            if (value == null) return Exec(c, t, "DELETE FROM meta WHERE key=$k", ("$k", key));
            return Exec(c, t, "INSERT INTO meta(key,value) VALUES($k,$v) ON CONFLICT(key) DO UPDATE SET value=excluded.value", ("$k", key), ("$v", value));
        });

        // ------------------------------------------------------------------ preferences

        /// <summary>A user's preferences (defaults when none are stored).</summary>
        public NotifyPrefs Prefs(Guid userId)
        {
            var json = _db.Read(c => Scalar(c, "SELECT json FROM notify_prefs WHERE user_id=$u", ("$u", Id(userId))) as string);
            PrefsRead?.Invoke(userId);
            return Parse(json);
        }

        /// <summary>Tests: runs right after a user's preferences were read (another writer's change lands in between).</summary>
        internal Action<Guid>? PrefsRead { get; set; }

        /// <summary>Every user who stored preferences.</summary>
        public IReadOnlyDictionary<Guid, NotifyPrefs> AllPrefs() => _db.Read(c =>
        {
            var result = new Dictionary<Guid, NotifyPrefs>();
            using var cmd = Command(c, null, "SELECT user_id, json FROM notify_prefs");
            using var r = cmd.ExecuteReader();
            while (r.Read())
            {
                if (Guid.TryParse(r.GetString(0), out var id)) result[id] = Parse(r.GetString(1));
            }
            return result;
        });

        /// <summary>
        /// Stores a user's whole preferences document (tests and seeding only). Production code never calls it: a document
        /// read earlier would undo a change made in between (a revoked consent, a confirmed address). Every production writer
        /// uses <see cref="UpdatePrefs"/> or <see cref="TryUpdatePrefs"/> (a source walk checks it).
        /// </summary>
        internal void SavePrefs(Guid userId, NotifyPrefs prefs, DateTimeOffset now) => Write((c, t) => Exec(
            c, t,
            "INSERT INTO notify_prefs(user_id,json,updated_at) VALUES($u,$j,$n) ON CONFLICT(user_id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at",
            ("$u", Id(userId)), ("$j", JsonSerializer.Serialize(prefs, Json)), ("$n", Ms(now))));

        /// <summary>
        /// Changes a user's preferences in one transaction (read, change, write): a change made at the same time by another
        /// writer (the person in another tab, an administrator, a phase-4f consent) is never lost. Returns the stored result.
        /// </summary>
        public NotifyPrefs UpdatePrefs(Guid userId, Action<NotifyPrefs> change, DateTimeOffset now)
            => TryUpdatePrefs(userId, p =>
            {
                change(p);
                return null;
            }, now).Prefs;

        /// <summary>
        /// Like <see cref="UpdatePrefs"/>, with the change's own checks made on the settings as they are inside the
        /// transaction: <paramref name="change"/> returns null to store its change, or an error code to store nothing.
        /// Returns the settings stored (or unchanged) and the error.
        /// </summary>
        public (NotifyPrefs Prefs, string? Error) TryUpdatePrefs(Guid userId, Func<NotifyPrefs, string?> change, DateTimeOffset now) => Write((c, t) =>
        {
            var prefs = Parse(Scalar(c, "SELECT json FROM notify_prefs WHERE user_id=$u", ("$u", Id(userId)), t) as string);
            if (change(prefs) is { } error) return (Parse(Scalar(c, "SELECT json FROM notify_prefs WHERE user_id=$u", ("$u", Id(userId)), t) as string), error);
            Exec(c, t, "INSERT INTO notify_prefs(user_id,json,updated_at) VALUES($u,$j,$n) ON CONFLICT(user_id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at",
                ("$u", Id(userId)), ("$j", JsonSerializer.Serialize(prefs, Json)), ("$n", Ms(now)));
            return (prefs, (string?)null);
        });

        private static NotifyPrefs Parse(string? json)
        {
            if (string.IsNullOrEmpty(json)) return new NotifyPrefs();
            try
            {
                return JsonSerializer.Deserialize<NotifyPrefs>(json, Json) ?? new NotifyPrefs();
            }
            catch (JsonException)
            {
                return new NotifyPrefs();
            }
        }

        // ------------------------------------------------------------------ follows

        /// <summary>A user's follows (and mutes), newest first.</summary>
        public IReadOnlyList<FollowRow> Follows(Guid userId) => _db.Read(c => ReadFollows(c, "SELECT user_id,key,kind,muted,created_at FROM follows WHERE user_id=$u ORDER BY created_at DESC", ("$u", Id(userId))));

        /// <summary>Every follow (and mute) of the given title keys.</summary>
        public IReadOnlyList<FollowRow> FollowsOf(IEnumerable<string> keys)
        {
            var list = keys.Distinct(StringComparer.Ordinal).ToList();
            if (list.Count == 0) return Array.Empty<FollowRow>();
            return _db.Read(c =>
            {
                var result = new List<FollowRow>();
                foreach (var chunk in list.Chunk(200))
                {
                    var names = chunk.Select((_, i) => "$k" + i.ToString(CultureInfo.InvariantCulture)).ToArray();
                    result.AddRange(ReadFollows(c, $"SELECT user_id,key,kind,muted,created_at FROM follows WHERE key IN ({string.Join(",", names)})", chunk.Select((k, i) => (names[i], (object?)k)).ToArray()));
                }
                return result;
            });
        }

        /// <summary>Every follow (and mute) of the given movie/series keys and of their seasons.</summary>
        public IReadOnlyList<FollowRow> FollowsOfTitles(IEnumerable<string> titleKeys)
        {
            var list = titleKeys.Distinct(StringComparer.Ordinal).ToList();
            if (list.Count == 0) return Array.Empty<FollowRow>();
            return _db.Read(c =>
            {
                var result = new List<FollowRow>();
                foreach (var key in list)
                {
                    // The key itself, or "<key>:s…" (its seasons): a range on the primary key's order.
                    result.AddRange(ReadFollows(c, "SELECT user_id,key,kind,muted,created_at FROM follows WHERE key=$k OR (key >= $lo AND key < $hi)", ("$k", key), ("$lo", key + ":s"), ("$hi", key + ":t")));
                }
                return result;
            });
        }

        /// <summary>Every follow and mute (the interest index; bounded by users × <see cref="MaxFollowsPerUser"/>).</summary>
        public IReadOnlyList<FollowRow> AllFollows() => _db.Read(c => ReadFollows(c, "SELECT user_id,key,kind,muted,created_at FROM follows"));

        /// <summary>
        /// Follows (<paramref name="muted"/> false) or mutes a title, or with <paramref name="remove"/>
        /// forgets the row. False when the user already has <see cref="MaxFollowsPerUser"/> rows.
        /// </summary>
        public bool SetFollow(Guid userId, string key, string kind, bool muted, bool remove, DateTimeOffset now) => Write((c, t) =>
        {
            if (remove)
            {
                Exec(c, t, "DELETE FROM follows WHERE user_id=$u AND key=$k", ("$u", Id(userId)), ("$k", key));
                return true;
            }
            var exists = Scalar(c, "SELECT 1 FROM follows WHERE user_id=$u AND key=$k", ("$u", Id(userId)), ("$k", key), t) != null;
            if (!exists && Convert.ToInt64(Scalar(c, "SELECT COUNT(*) FROM follows WHERE user_id=$u", ("$u", Id(userId)), t), CultureInfo.InvariantCulture) >= MaxFollowsPerUser) return false;
            Exec(c, t, "INSERT INTO follows(user_id,key,kind,muted,created_at) VALUES($u,$k,$kind,$m,$n) ON CONFLICT(user_id,key) DO UPDATE SET kind=excluded.kind, muted=excluded.muted",
                ("$u", Id(userId)), ("$k", key), ("$kind", kind), ("$m", muted ? 1 : 0), ("$n", Ms(now)));
            return true;
        });

        private static List<FollowRow> ReadFollows(SqliteConnection c, string sql, params (string, object?)[] args)
        {
            var result = new List<FollowRow>();
            using var cmd = Command(c, null, sql, args);
            using var r = cmd.ExecuteReader();
            while (r.Read())
            {
                if (!Guid.TryParse(r.GetString(0), out var user)) continue;
                result.Add(new FollowRow(user, r.GetString(1), r.GetString(2), r.GetInt64(3) != 0, At(r.GetInt64(4))));
            }
            return result;
        }

        // ------------------------------------------------------------------ watch state

        /// <summary>What a user was last known to have of a title (null when never looked at).</summary>
        public (string? Stage, string? Known, DateTimeOffset Baseline)? Watch(Guid userId, string key, string scope) => _db.Read(c =>
        {
            using var cmd = Command(c, null, "SELECT stage, known, baseline_at FROM watch WHERE user_id=$u AND key=$k AND scope=$s", ("$u", Id(userId)), ("$k", key), ("$s", scope));
            using var r = cmd.ExecuteReader();
            if (!r.Read()) return ((string?, string?, DateTimeOffset)?)null;
            return (r.IsDBNull(0) ? null : r.GetString(0), r.IsDBNull(1) ? null : r.GetString(1), At(r.GetInt64(2)));
        });

        /// <summary>Records what a user has of a title now.</summary>
        public void SetWatch(Guid userId, string key, string scope, string? stage, string? known, DateTimeOffset now) => InTransaction(tx => tx.SetWatch(userId, key, scope, stage, known, now));

        /// <summary>Forgets what a user was known to have of a title (every scope): the next interest starts afresh.</summary>
        public void DeleteWatch(Guid userId, string key) => Write((c, t) => Exec(c, t, "DELETE FROM watch WHERE user_id=$u AND key=$k", ("$u", Id(userId)), ("$k", key)));

        // ------------------------------------------------------------------ marks (idempotency)

        /// <summary>Records a mark once; false when the user already had it.</summary>
        public bool TryMark(Guid userId, string mark, DateTimeOffset now) => InTransaction(tx => tx.TryMark(userId, mark, now));

        /// <summary>
        /// Claims a rate-limited slot: records the mark at <paramref name="now"/> when the user has
        /// none or it is at least <paramref name="every"/> old, in one statement (two requests at once
        /// can't both get it). False when the slot is taken.
        /// </summary>
        public bool ClaimMark(Guid userId, string mark, DateTimeOffset now, TimeSpan every) => InTransaction(tx => tx.ClaimMark(userId, mark, now, every));

        /// <summary>When the mark was recorded, or null.</summary>
        public DateTimeOffset? MarkAt(Guid userId, string mark)
        {
            var v = _db.Read(c => Scalar(c, "SELECT at FROM marks WHERE user_id=$u AND mark=$m", ("$u", Id(userId)), ("$m", mark)));
            return v == null ? null : At(Convert.ToInt64(v, CultureInfo.InvariantCulture));
        }

        /// <summary>Records (or moves) a mark to now.</summary>
        public void SetMark(Guid userId, string mark, DateTimeOffset now) => Write((c, t) => Exec(
            c, t, "INSERT INTO marks(user_id,mark,at) VALUES($u,$m,$n) ON CONFLICT(user_id,mark) DO UPDATE SET at=excluded.at", ("$u", Id(userId)), ("$m", mark), ("$n", Ms(now))));

        // ------------------------------------------------------------------ inbox + deliveries

        /// <summary>
        /// Adds a notification and its deliveries in one transaction. Null when the user already has
        /// one for <paramref name="eventKey"/> (idempotent per user and event).
        /// </summary>
        public long? Add(Guid userId, string eventKey, string kind, string? titleKey, string? itemId, IReadOnlyDictionary<string, string> payload, IReadOnlyList<(string Channel, DateTimeOffset At)> deliveries, DateTimeOffset now)
            => InTransaction(tx => tx.Add(userId, eventKey, kind, titleKey, itemId, payload, deliveries, now));

        /// <summary>
        /// Runs <paramref name="work"/> in one write transaction: everything it changes commits
        /// together, or nothing does when it throws.
        /// </summary>
        public T InTransaction<T>(Func<NotifyTransaction, T> work) => Write((c, t) => work(new NotifyTransaction(c, t)));

        /// <summary>Runs <paramref name="work"/> in one write transaction.</summary>
        public void InTransaction(Action<NotifyTransaction> work) => Write((c, t) =>
        {
            work(new NotifyTransaction(c, t));
            return 0;
        });

        /// <summary>
        /// Runs <paramref name="work"/> in one write transaction, but only while the database is still
        /// at <paramref name="generation"/> (null: any): work composed from rows read before a restore
        /// is dropped (Done false, <paramref name="otherwise"/>) instead of landing in the restored data.
        /// </summary>
        public (bool Done, T Result) InTransaction<T>(long? generation, Func<NotifyTransaction, T> work, T otherwise)
            => WriteIf(generation, (c, t) => work(new NotifyTransaction(c, t)), otherwise);

        // The kinds only administrators receive, as a SQL list.
        private static readonly string AdminKinds = string.Join(",", NotifyKind.AdminKinds.Select(k => "'" + k + "'"));

        /// <summary>
        /// A user's inbox, newest first (<paramref name="beforeId"/> pages back); without
        /// <paramref name="adminKinds"/>, administrators' kinds are left out (a user who is no longer one).
        /// </summary>
        public IReadOnlyList<(long Id, string Kind, string? Key, string? ItemId, string Payload, DateTimeOffset At, bool Read, string EventKey)> Inbox(Guid userId, long? beforeId, int limit, bool adminKinds = true)
            => InboxRows(userId, beforeId, limit, adminKinds).Select(r => (r.Id, r.Kind, r.Key, r.ItemId, r.Payload, r.At, r.Read, r.EventKey ?? string.Empty)).ToList();

        /// <summary><see cref="Inbox"/> with each notification's event key (what an outcome alert's policy input is read back from).</summary>
        public IReadOnlyList<(long Id, string Kind, string? Key, string? ItemId, string Payload, DateTimeOffset At, bool Read, string? EventKey)> InboxRows(Guid userId, long? beforeId, int limit, bool adminKinds = true) => _db.Read(c =>
        {
            var result = new List<(long, string, string?, string?, string, DateTimeOffset, bool, string?)>();
            using var cmd = Command(c, null, "SELECT id,kind,title_key,item_id,payload,created_at,read_at,event_key FROM notifications WHERE user_id=$u AND id<$b" + (adminKinds ? string.Empty : " AND kind NOT IN (" + AdminKinds + ")") + " ORDER BY id DESC LIMIT $l",
                ("$u", Id(userId)), ("$b", beforeId ?? long.MaxValue), ("$l", limit));
            using var r = cmd.ExecuteReader();
            while (r.Read())
            {
                result.Add((r.GetInt64(0), r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2), r.IsDBNull(3) ? null : r.GetString(3), r.GetString(4), At(r.GetInt64(5)), !r.IsDBNull(6), r.IsDBNull(7) ? null : r.GetString(7)));
            }
            return (IReadOnlyList<(long, string, string?, string?, string, DateTimeOffset, bool, string?)>)result;
        });

        /// <summary>Unread notifications of a user (administrators' kinds only with <paramref name="adminKinds"/>).</summary>
        public int Unread(Guid userId, bool adminKinds = true) => Convert.ToInt32(_db.Read(c => Scalar(c, "SELECT COUNT(*) FROM notifications WHERE user_id=$u AND read_at IS NULL" + (adminKinds ? string.Empty : " AND kind NOT IN (" + AdminKinds + ")"), ("$u", Id(userId)))), CultureInfo.InvariantCulture);

        /// <summary>Marks some (or all) of a user's notifications read; returns how many changed.</summary>
        public int MarkRead(Guid userId, IReadOnlyCollection<long>? ids, DateTimeOffset now) => Write((c, t) =>
        {
            if (ids == null) return Exec(c, t, "UPDATE notifications SET read_at=$n WHERE user_id=$u AND read_at IS NULL", ("$u", Id(userId)), ("$n", Ms(now)));
            var changed = 0;
            foreach (var id in ids.Distinct().Take(500))
            {
                changed += Exec(c, t, "UPDATE notifications SET read_at=$n WHERE user_id=$u AND id=$id AND read_at IS NULL", ("$u", Id(userId)), ("$n", Ms(now)), ("$id", id));
            }
            return changed;
        });

        /// <summary>Deliveries due now, oldest first.</summary>
        internal IReadOnlyList<DueDelivery> Due(DateTimeOffset now, int limit) => _db.Read(c =>
        {
            var generation = _db.Generation;
            var result = new List<DueDelivery>();
            using var cmd = Command(c, null, @"SELECT d.id, d.notification_id, n.user_id, d.channel, d.attempts, n.kind, n.title_key, n.item_id, n.payload, n.created_at, n.event_key
FROM deliveries d JOIN notifications n ON n.id = d.notification_id
WHERE d.status='pending' AND d.next_at <= $n ORDER BY d.next_at LIMIT $l", ("$n", Ms(now)), ("$l", limit));
            using var r = cmd.ExecuteReader();
            while (r.Read())
            {
                if (!Guid.TryParse(r.GetString(2), out var user)) continue;
                result.Add(new DueDelivery(r.GetInt64(0), r.GetInt64(1), user, r.GetString(3), r.GetInt32(4), r.GetString(5), r.IsDBNull(6) ? null : r.GetString(6), r.IsDBNull(7) ? null : r.GetString(7), r.GetString(8), At(r.GetInt64(9)), generation, r.IsDBNull(10) ? null : r.GetString(10)));
            }
            return (IReadOnlyList<DueDelivery>)result;
        });

        /// <summary>
        /// Outcome alerts waiting for evidence that is due for another try now (4f round 6), fairly: each person's earliest
        /// first, then each person's next, and so on (round-robin by person, then by due time), at most <paramref name="limit"/>.
        /// One person's many waits never hold another person's back.
        /// </summary>
        internal IReadOnlyList<AlertWait> DueAlertWaits(DateTimeOffset now, int limit) => _db.Read(c =>
        {
            var list = new List<AlertWait>();
            using var cmd = Command(c, null, @"SELECT source, source_id, user_id, kind, title_key, event_key, payload, request_id, original_at, next_at, tries FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY next_at, source, source_id) AS turn FROM alert_waits WHERE next_at <= $n)
ORDER BY turn, next_at, source, source_id LIMIT $l", ("$n", Ms(now)), ("$l", limit));
            using var r = cmd.ExecuteReader();
            while (r.Read())
            {
                if (!Guid.TryParse(r.GetString(2), out var user)) continue;
                list.Add(new AlertWait(r.GetString(0), r.GetString(1), user, r.GetString(3), r.GetString(4), r.GetString(5), r.GetString(6),
                    r.IsDBNull(7) ? null : r.GetString(7), At(r.GetInt64(8)), At(r.GetInt64(9)), r.GetInt32(10)));
            }
            return (IReadOnlyList<AlertWait>)list;
        });

        /// <summary>The next try of a waiting outcome alert (not after a restore).</summary>
        internal bool RetryAlertWait(AlertWait wait, DateTimeOffset at, long generation) => WriteIf(generation, (c, t) => Exec(c, t,
            "UPDATE alert_waits SET next_at=$a, tries=tries+1 WHERE source=$s AND source_id=$i", ("$a", Ms(at)), ("$s", wait.Source), ("$i", wait.SourceId)) == 1, false).Result;

        /// <summary>A waiting outcome alert is never told (too old, moved on, hidden): forgotten (not after a restore).</summary>
        internal bool DropAlertWait(AlertWait wait, long generation) => WriteIf(generation, (c, t) => Exec(c, t,
            "DELETE FROM alert_waits WHERE source=$s AND source_id=$i", ("$s", wait.Source), ("$i", wait.SourceId)) == 1, false).Result;

        /// <summary>When the next pending delivery is due, or null.</summary>
        public DateTimeOffset? NextDue()
        {
            var v = _db.Read(c => Scalar(c, "SELECT MIN(next_at) FROM deliveries WHERE status='pending'"));
            return v is null or DBNull ? null : At(Convert.ToInt64(v, CultureInfo.InvariantCulture));
        }

        /// <summary>
        /// Records a delivery outcome: sent, retry at <paramref name="retryAt"/>, or failed for good
        /// (both null). With <paramref name="generation"/>, nothing changes (false) when a restore
        /// replaced the database since the delivery was read: its id is another row now.
        /// </summary>
        public bool Finish(long deliveryId, bool sent, string? error, DateTimeOffset? retryAt, DateTimeOffset now, long? generation = null) => WriteIf(generation, (c, t) => Exec(
            c, t,
            "UPDATE deliveries SET status=$s, attempts=attempts+1, last_error=$e, next_at=COALESCE($r,next_at), sent_at=$sent WHERE id=$id",
            ("$s", sent ? "sent" : retryAt.HasValue ? "pending" : "failed"),
            ("$e", sent ? null : Trim(error, 300)),
            ("$r", retryAt.HasValue ? Ms(retryAt.Value) : null),
            ("$sent", sent ? Ms(now) : null),
            ("$id", deliveryId)), 0).Done;

        /// <summary>
        /// Ends a delivery without sending it because its recipient may no longer get it (the user is
        /// gone or disabled, no longer an administrator, switched admin alerts off, or can no longer
        /// open the title): final, never retried and not counted as a failure. Not after a restore,
        /// like <see cref="Finish"/>.
        /// </summary>
        public bool Suppress(long deliveryId, string reason, long? generation = null) => WriteIf(generation, (c, t) => Exec(
            c, t, "UPDATE deliveries SET status='suppressed', last_error=$e WHERE id=$id AND status='pending'", ("$e", Trim(reason, 300)), ("$id", deliveryId)), 0).Done;

        /// <summary>Moves a pending delivery to another time (quiet hours) without counting an attempt (not after a restore, like <see cref="Finish"/>).</summary>
        public bool Postpone(long deliveryId, DateTimeOffset at, long? generation = null) => WriteIf(generation, (c, t) => Exec(c, t, "UPDATE deliveries SET next_at=$a WHERE id=$id AND status='pending'", ("$a", Ms(at)), ("$id", deliveryId)), 0).Done;

        /// <summary>Delivery counts for administrators: pending, sent and failed in the last day, and the latest problems.</summary>
        public (int Pending, int Sent24h, int Failed24h, IReadOnlyList<(Guid User, string Channel, string Kind, int Attempts, string? Error, bool Final, DateTimeOffset At)> Problems) DeliveryStats(DateTimeOffset now) => _db.Read(c =>
        {
            var since = Ms(now.AddDays(-1));
            var pending = Convert.ToInt32(Scalar(c, "SELECT COUNT(*) FROM deliveries WHERE status='pending'"), CultureInfo.InvariantCulture);
            var sent = Convert.ToInt32(Scalar(c, "SELECT COUNT(*) FROM deliveries WHERE status='sent' AND sent_at >= $s", ("$s", since)), CultureInfo.InvariantCulture);
            var failed = Convert.ToInt32(Scalar(c, "SELECT COUNT(*) FROM deliveries d JOIN notifications n ON n.id=d.notification_id WHERE d.status='failed' AND n.created_at >= $s", ("$s", since)), CultureInfo.InvariantCulture);
            var problems = new List<(Guid, string, string, int, string?, bool, DateTimeOffset)>();
            using var cmd = Command(c, null, @"SELECT n.user_id, d.channel, n.kind, d.attempts, d.last_error, d.status, n.created_at FROM deliveries d JOIN notifications n ON n.id=d.notification_id
WHERE d.last_error IS NOT NULL AND d.status NOT IN ('sent','suppressed') ORDER BY d.id DESC LIMIT 20");
            using var r = cmd.ExecuteReader();
            while (r.Read())
            {
                if (!Guid.TryParse(r.GetString(0), out var user)) continue;
                problems.Add((user, r.GetString(1), r.GetString(2), r.GetInt32(3), r.IsDBNull(4) ? null : r.GetString(4), r.GetString(5) == "failed", At(r.GetInt64(6))));
            }
            return (pending, sent, failed, (IReadOnlyList<(Guid, string, string, int, string?, bool, DateTimeOffset)>)problems);
        });

        // ------------------------------------------------------------------ batches

        /// <summary>A user's open episode batch for a series, or null.</summary>
        public (string Episodes, DateTimeOffset FirstAt, DateTimeOffset DueAt)? Batch(Guid userId, string key) => _db.Read(c =>
        {
            using var cmd = Command(c, null, "SELECT episodes, first_at, due_at FROM batches WHERE user_id=$u AND key=$k", ("$u", Id(userId)), ("$k", key));
            using var r = cmd.ExecuteReader();
            if (!r.Read()) return ((string, DateTimeOffset, DateTimeOffset)?)null;
            return (r.GetString(0), At(r.GetInt64(1)), At(r.GetInt64(2)));
        });

        /// <summary>Stores a batch.</summary>
        public void SetBatch(Guid userId, string key, string episodes, DateTimeOffset firstAt, DateTimeOffset dueAt) => InTransaction(tx => tx.SetBatch(userId, key, episodes, firstAt, dueAt));

        /// <summary>Batches whose window has closed, each with its start as read with it.</summary>
        public IReadOnlyList<(Guid User, string Key, string Episodes, DateTimeOffset FirstAt)> DueBatches(DateTimeOffset now) => _db.Read(c =>
        {
            var result = new List<(Guid, string, string, DateTimeOffset)>();
            using var cmd = Command(c, null, "SELECT user_id, key, episodes, first_at FROM batches WHERE due_at <= $n", ("$n", Ms(now)));
            using var r = cmd.ExecuteReader();
            while (r.Read())
            {
                if (Guid.TryParse(r.GetString(0), out var user)) result.Add((user, r.GetString(1), r.GetString(2), At(r.GetInt64(3))));
            }
            return (IReadOnlyList<(Guid, string, string, DateTimeOffset)>)result;
        });

        /// <summary>Forgets a batch.</summary>
        public void DeleteBatch(Guid userId, string key) => InTransaction(tx => tx.DeleteBatch(userId, key));

        // ------------------------------------------------------------------ Seerr requests seen

        /// <summary>The last state seen of every Seerr request.</summary>
        public IReadOnlyDictionary<int, int> SeerrSeen() => _db.Read(c =>
        {
            var result = new Dictionary<int, int>();
            using var cmd = Command(c, null, "SELECT request_id, status FROM seerr_seen");
            using var r = cmd.ExecuteReader();
            while (r.Read()) result[r.GetInt32(0)] = r.GetInt32(1);
            return (IReadOnlyDictionary<int, int>)result;
        });

        /// <summary>
        /// Records states seen (nobody's user id: it isn't needed to compare states) and forgets
        /// requests that are gone. With <paramref name="floor"/> (Seerr holds more than is read and
        /// nothing below it is held any more), what was seen of the requests below it is forgotten
        /// too, since they can't be compared again while that lasts, and the floor is noted
        /// (<see cref="SeerrForgottenBelowKey"/>): one of them seen again later is old, not new.
        /// </summary>
        public void SetSeerrSeen(IReadOnlyCollection<(int Id, int Status)> seen, IReadOnlyCollection<int> gone, DateTimeOffset now, int? floor = null) => Write((c, t) =>
        {
            foreach (var (id, status) in seen)
            {
                Exec(c, t, "INSERT INTO seerr_seen(request_id,status,user_id,seen_at) VALUES($i,$s,NULL,$n) ON CONFLICT(request_id) DO UPDATE SET status=excluded.status, user_id=NULL",
                    ("$i", id), ("$s", status), ("$n", Ms(now)));
            }
            foreach (var id in gone) Exec(c, t, "DELETE FROM seerr_seen WHERE request_id=$i", ("$i", id));
            if (floor is int f)
            {
                Exec(c, t, "DELETE FROM seerr_seen WHERE request_id < $f", ("$f", f));
                var tx = new NotifyTransaction(c, t);
                var before = int.TryParse(tx.Meta(SeerrForgottenBelowKey), NumberStyles.None, CultureInfo.InvariantCulture, out var b) ? b : 0;
                if (f > before) tx.SetMeta(SeerrForgottenBelowKey, f.ToString(CultureInfo.InvariantCulture));
            }
            return 0;
        });

        /// <summary>The meta key holding the identity of the Seerr the seen states belong to.</summary>
        internal const string SeerrSourceKey = "seerr_source";

        /// <summary>
        /// The meta key holding the highest request id below which what was seen was forgotten (they
        /// fell below the requests read): a request below it that isn't known is old, never news.
        /// </summary>
        internal const string SeerrForgottenBelowKey = "seerr_forgotten_below";

        /// <summary>
        /// Starts the Seerr bookkeeping afresh in one transaction: forgets every state seen, records
        /// <paramref name="seen"/> (what is there now, announced to nobody), moves the baseline (only
        /// requests made after it count as new) to <paramref name="now"/> and notes the Seerr
        /// (<paramref name="source"/>) they belong to. Used at the first look and when Seerr was
        /// replaced by another server, whose request ids mean other requests.
        /// </summary>
        public void ResetSeerrSeen(IReadOnlyCollection<(int Id, int Status)> seen, DateTimeOffset now, string source) => Write((c, t) =>
        {
            Exec(c, t, "DELETE FROM seerr_seen");
            foreach (var (id, status) in seen)
            {
                Exec(c, t, "INSERT OR REPLACE INTO seerr_seen(request_id,status,user_id,seen_at) VALUES($i,$s,NULL,$n)",
                    ("$i", id), ("$s", status), ("$n", Ms(now)));
            }
            var tx = new NotifyTransaction(c, t);
            tx.SetMeta("seerr_baseline", now.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture));
            tx.SetMeta(SeerrSourceKey, source);
            tx.SetMeta(SeerrForgottenBelowKey, null);
            return 0;
        });

        // ------------------------------------------------------------------ e-mail verification codes

        /// <summary>A pending e-mail check of a user.</summary>
        public (string Address, string CodeHash, DateTimeOffset Expires, int Attempts, DateTimeOffset SentAt, int SentToday, string Day)? EmailCode(Guid userId) => _db.Read(c =>
        {
            using var cmd = Command(c, null, "SELECT address, code_hash, expires_at, attempts, sent_at, sent_today, day FROM email_codes WHERE user_id=$u", ("$u", Id(userId)));
            using var r = cmd.ExecuteReader();
            if (!r.Read()) return ((string, string, DateTimeOffset, int, DateTimeOffset, int, string)?)null;
            return (r.GetString(0), r.GetString(1), At(r.GetInt64(2)), r.GetInt32(3), At(r.GetInt64(4)), r.GetInt32(5), r.GetString(6));
        });

        /// <summary>Stores a new code for a user.</summary>
        public void SetEmailCode(Guid userId, string address, string codeHash, DateTimeOffset expires, DateTimeOffset now, int sentToday, string day) => Write((c, t) => Exec(
            c, t,
            "INSERT INTO email_codes(user_id,address,code_hash,expires_at,attempts,sent_at,sent_today,day) VALUES($u,$a,$h,$x,0,$n,$st,$d) ON CONFLICT(user_id) DO UPDATE SET address=excluded.address, code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0, sent_at=excluded.sent_at, sent_today=excluded.sent_today, day=excluded.day",
            ("$u", Id(userId)), ("$a", address), ("$h", codeHash), ("$x", Ms(expires)), ("$n", Ms(now)), ("$st", sentToday), ("$d", day)));

        /// <summary>
        /// Reserves one code e-mail for a user and stores the new code, in one transaction (requests
        /// at once can't get around the limits): "too_soon" within <paramref name="resendAfter"/> of
        /// the last one, "too_many_today" after <paramref name="perDay"/> today (UTC day), else "ok".
        /// </summary>
        public (string Outcome, TimeSpan RetryAfter) ReserveEmailCode(Guid userId, string address, string codeHash, DateTimeOffset expires, DateTimeOffset now, TimeSpan resendAfter, int perDay) => InTransaction(tx =>
        {
            var day = now.UtcDateTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            using (var cmd = Command(tx.Connection, tx.Transaction, "SELECT sent_at, sent_today, day FROM email_codes WHERE user_id=$u", ("$u", Id(userId))))
            using (var r = cmd.ExecuteReader())
            {
                var sentToday = 0;
                if (r.Read())
                {
                    var sentAt = At(r.GetInt64(0));
                    if (now - sentAt < resendAfter) return ("too_soon", resendAfter - (now - sentAt));
                    sentToday = r.GetString(2) == day ? r.GetInt32(1) : 0;
                }
                if (sentToday >= perDay) return ("too_many_today", TimeSpan.Zero);
                r.Close();
                Exec(
                    tx.Connection, tx.Transaction,
                    "INSERT INTO email_codes(user_id,address,code_hash,expires_at,attempts,sent_at,sent_today,day) VALUES($u,$a,$h,$x,0,$n,$st,$d) ON CONFLICT(user_id) DO UPDATE SET address=excluded.address, code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0, sent_at=excluded.sent_at, sent_today=excluded.sent_today, day=excluded.day",
                    ("$u", Id(userId)), ("$a", address), ("$h", codeHash), ("$x", Ms(expires)), ("$n", Ms(now)), ("$st", sentToday + 1), ("$d", day));
                return ("ok", TimeSpan.Zero);
            }
        });

        /// <summary>
        /// Takes one try at a user's pending code, in one transaction: counts the attempt and returns
        /// the address and code hash to compare with ("ok"), or "no_pending_code" (none, used or
        /// expired) / "too_many_attempts" (<paramref name="maxAttempts"/> used) without one.
        /// </summary>
        public (string Outcome, string? Address, string? CodeHash) TryEmailCode(Guid userId, DateTimeOffset now, int maxAttempts) => InTransaction(tx =>
        {
            string address, hash;
            using (var cmd = Command(tx.Connection, tx.Transaction, "SELECT address, code_hash, expires_at, attempts FROM email_codes WHERE user_id=$u", ("$u", Id(userId))))
            using (var r = cmd.ExecuteReader())
            {
                if (!r.Read() || string.IsNullOrEmpty(r.GetString(1)) || At(r.GetInt64(2)) < now) return ("no_pending_code", (string?)null, (string?)null);
                if (r.GetInt32(3) >= maxAttempts) return ("too_many_attempts", null, null);
                address = r.GetString(0);
                hash = r.GetString(1);
            }
            Exec(tx.Connection, tx.Transaction, "UPDATE email_codes SET attempts=attempts+1 WHERE user_id=$u", ("$u", Id(userId)));
            return ("ok", address, hash);
        });

        /// <summary>Ends a user's pending check (the code is used up): keeps the daily send count.</summary>
        public void ClearEmailCode(Guid userId) => Write((c, t) => Exec(c, t, "UPDATE email_codes SET code_hash='', expires_at=0 WHERE user_id=$u", ("$u", Id(userId))));

        // ------------------------------------------------------------------ housekeeping

        /// <summary>
        /// Retention: notifications older than 90 days (their deliveries with them), marks older
        /// than 400 days, and everything of users that no longer exist.
        /// </summary>
        public int Purge(DateTimeOffset now, Func<Guid, bool> userExists) => Write((c, t) =>
        {
            var removed = Exec(c, t, "DELETE FROM notifications WHERE created_at < $c", ("$c", Ms(now.AddDays(-90))));
            removed += Exec(c, t, "DELETE FROM marks WHERE at < $c", ("$c", Ms(now.AddDays(-400))));
            // User ids earlier versions noted on the Seerr requests seen (never read, no longer written).
            Exec(c, t, "UPDATE seerr_seen SET user_id=NULL WHERE user_id IS NOT NULL");
            var users = new HashSet<string>(StringComparer.Ordinal);
            foreach (var table in UserTables)
            {
                using var cmd = Command(c, t, $"SELECT DISTINCT user_id FROM {table}");
                using var r = cmd.ExecuteReader();
                while (r.Read()) users.Add(r.GetString(0));
            }
            foreach (var user in users)
            {
                if (Guid.TryParse(user, out var id) && userExists(id)) continue;
                foreach (var table in UserTables)
                {
                    removed += Exec(c, t, $"DELETE FROM {table} WHERE user_id=$u", ("$u", user));
                }
            }
            return removed;
        });

        /// <summary>
        /// Removes everything kept for one user (follows, settings, watch states, inbox and its
        /// deliveries, batches, marks, e-mail checks, their id on Seerr requests seen): a Jellyfin user
        /// was deleted. Returns the rows removed.
        /// For a while after, any write (a notification round that checked the user just before the
        /// deletion) removes what it wrote for them in the same transaction.
        /// </summary>
        public int PurgeUser(Guid userId)
        {
            NoteDeleted(userId);
            var id = Id(userId);
            // Their automation eligibility grant goes with them (RequestLedger.PurgeUser): inside the automation version's bracket.
            var purged = _db.WriteAutomation((c, t) =>
            {
                var removed = 0;
                foreach (var table in UserTables)
                {
                    removed += Exec(c, t, $"DELETE FROM {table} WHERE user_id=$u", ("$u", id));
                }
                // Their id on the Seerr requests seen (written by earlier versions, never read; no
                // longer written): the states stay, they tell what's new.
                return removed + Exec(c, t, "UPDATE seerr_seen SET user_id=NULL WHERE user_id=$u", ("$u", id)) + Requests.RequestLedger.PurgeUser(c, t, userId);
            });
            return purged;
        }

        /// <summary>
        /// Notes that a Jellyfin user was deleted, without touching the database: for a while, every
        /// write removes what it wrote for them in the same transaction (a write already on its way
        /// that creates the database must not keep their rows).
        /// </summary>
        public void NoteDeleted(Guid userId) => _deleted[Id(userId)] = Environment.TickCount64 + DeletedForMs;

        // Phase 4f: the Ready playlist's bindings, entries and native-message attempts are a person's rows too (schema 8 and its
        // start-up ensure always create them).
        private static readonly string[] UserTables = { "follows", "notify_prefs", "watch", "notifications", "batches", "marks", "email_codes", "ready_playlists", "ready_entries", "ready_message_attempts", "alert_waits" };

        // ------------------------------------------------------------------ SQL helpers

        private static string? Trim(string? text, int max) => text == null ? null : text.Length <= max ? text : text[..max];

        internal static SqliteCommand Command(SqliteConnection c, SqliteTransaction? t, string sql, params (string Name, object? Value)[] args)
        {
            var cmd = c.CreateCommand();
            cmd.CommandText = sql;
            cmd.Transaction = t;
            foreach (var (name, value) in args) cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
            return cmd;
        }

        internal static int Exec(SqliteConnection c, SqliteTransaction t, string sql, params (string Name, object? Value)[] args)
        {
            using var cmd = Command(c, t, sql, args);
            return cmd.ExecuteNonQuery();
        }

        private static object? Scalar(SqliteConnection c, string sql, params (string Name, object? Value)[] args) => Scalar(c, sql, args, null);

        private static object? Scalar(SqliteConnection c, string sql, (string Name, object? Value) a, SqliteTransaction? t) => Scalar(c, sql, new[] { a }, t);

        private static object? Scalar(SqliteConnection c, string sql, (string Name, object? Value) a, (string Name, object? Value) b, SqliteTransaction? t) => Scalar(c, sql, new[] { a, b }, t);

        private static object? Scalar(SqliteConnection c, string sql, SqliteTransaction? t) => Scalar(c, sql, Array.Empty<(string, object?)>(), t);

        internal static object? Scalar(SqliteConnection c, string sql, (string Name, object? Value)[] args, SqliteTransaction? t)
        {
            using var cmd = Command(c, t, sql, args);
            var v = cmd.ExecuteScalar();
            return v is DBNull ? null : v;
        }
    }

    /// <summary>
    /// The notification tables inside one write transaction (<see cref="NotifyStore.InTransaction{T}"/>):
    /// the marks, watch state, batches and notifications an event touches commit together.
    /// </summary>
    public sealed class NotifyTransaction
    {
        internal NotifyTransaction(SqliteConnection connection, SqliteTransaction transaction)
        {
            Connection = connection;
            Transaction = transaction;
        }

        internal SqliteConnection Connection { get; }

        internal SqliteTransaction Transaction { get; }

        /// <summary>Records a mark once; false when the user already had it.</summary>
        public bool TryMark(Guid userId, string mark, DateTimeOffset now)
            => NotifyStore.Exec(Connection, Transaction, "INSERT OR IGNORE INTO marks(user_id,mark,at) VALUES($u,$m,$n)", ("$u", Id(userId)), ("$m", mark), ("$n", Ms(now))) > 0;

        /// <summary>
        /// Records a mark the first time (true) or moves an existing one to <paramref name="now"/>
        /// (false): a mark kept fresh this way outlives the marks' retention while it is in use.
        /// </summary>
        public bool KeepMark(Guid userId, string mark, DateTimeOffset now)
        {
            if (TryMark(userId, mark, now)) return true;
            NotifyStore.Exec(Connection, Transaction, "UPDATE marks SET at=$n WHERE user_id=$u AND mark=$m", ("$u", Id(userId)), ("$m", mark), ("$n", Ms(now)));
            return false;
        }

        /// <summary>Records the mark at <paramref name="now"/> unless the user has one younger than <paramref name="every"/>; false then.</summary>
        public bool ClaimMark(Guid userId, string mark, DateTimeOffset now, TimeSpan every)
            => NotifyStore.Exec(
                Connection, Transaction,
                "INSERT INTO marks(user_id,mark,at) VALUES($u,$m,$n) ON CONFLICT(user_id,mark) DO UPDATE SET at=excluded.at WHERE marks.at <= $cut",
                ("$u", Id(userId)), ("$m", mark), ("$n", Ms(now)), ("$cut", Ms(now - every))) > 0;

        /// <summary>Records what a user has of a title now.</summary>
        public void SetWatch(Guid userId, string key, string scope, string? stage, string? known, DateTimeOffset now) => NotifyStore.Exec(
            Connection, Transaction,
            "INSERT INTO watch(user_id,key,scope,stage,known,baseline_at,updated_at) VALUES($u,$k,$s,$st,$kn,$n,$n) ON CONFLICT(user_id,key,scope) DO UPDATE SET stage=excluded.stage, known=excluded.known, updated_at=excluded.updated_at",
            ("$u", Id(userId)), ("$k", key), ("$s", scope), ("$st", stage), ("$kn", known), ("$n", Ms(now)));

        /// <summary>A user's open episode batch for a series, or null.</summary>
        public (string Episodes, DateTimeOffset FirstAt, DateTimeOffset DueAt)? Batch(Guid userId, string key)
        {
            using var cmd = NotifyStore.Command(Connection, Transaction, "SELECT episodes, first_at, due_at FROM batches WHERE user_id=$u AND key=$k", ("$u", Id(userId)), ("$k", key));
            using var r = cmd.ExecuteReader();
            if (!r.Read()) return null;
            return (r.GetString(0), At(r.GetInt64(1)), At(r.GetInt64(2)));
        }

        /// <summary>A user's open episode batches: their keys and what they hold.</summary>
        public IReadOnlyList<(string Key, string Episodes)> Batches(Guid userId)
        {
            var result = new List<(string, string)>();
            using var cmd = NotifyStore.Command(Connection, Transaction, "SELECT key, episodes FROM batches WHERE user_id=$u ORDER BY first_at, key", ("$u", Id(userId)));
            using var r = cmd.ExecuteReader();
            while (r.Read()) result.Add((r.GetString(0), r.GetString(1)));
            return result;
        }

        /// <summary>Stores a batch and its window.</summary>
        public void SetBatch(Guid userId, string key, string episodes, DateTimeOffset firstAt, DateTimeOffset dueAt) => NotifyStore.Exec(
            Connection, Transaction,
            "INSERT INTO batches(user_id,key,episodes,first_at,due_at) VALUES($u,$k,$e,$f,$d) ON CONFLICT(user_id,key) DO UPDATE SET episodes=excluded.episodes, first_at=excluded.first_at, due_at=excluded.due_at",
            ("$u", Id(userId)), ("$k", key), ("$e", episodes), ("$f", Ms(firstAt)), ("$d", Ms(dueAt)));

        /// <summary>Forgets a batch.</summary>
        public void DeleteBatch(Guid userId, string key)
            => NotifyStore.Exec(Connection, Transaction, "DELETE FROM batches WHERE user_id=$u AND key=$k", ("$u", Id(userId)), ("$k", key));

        /// <summary>
        /// Forgets a batch only while it still holds exactly <paramref name="episodes"/> (the version
        /// that was read); false when episodes were merged into it since.
        /// </summary>
        public bool DeleteBatchIf(Guid userId, string key, string episodes)
            => NotifyStore.Exec(Connection, Transaction, "DELETE FROM batches WHERE user_id=$u AND key=$k AND episodes=$e", ("$u", Id(userId)), ("$k", key), ("$e", episodes)) > 0;

        /// <summary>A stored value, or null.</summary>
        public string? Meta(string key) => NotifyStore.Scalar(Connection, "SELECT value FROM meta WHERE key=$k", new (string, object?)[] { ("$k", key) }, Transaction) as string;

        /// <summary>Stores (or with null removes) a value.</summary>
        public void SetMeta(string key, string? value)
        {
            if (value == null) NotifyStore.Exec(Connection, Transaction, "DELETE FROM meta WHERE key=$k", ("$k", key));
            else NotifyStore.Exec(Connection, Transaction, "INSERT INTO meta(key,value) VALUES($k,$v) ON CONFLICT(key) DO UPDATE SET value=excluded.value", ("$k", key), ("$v", value));
        }

        /// <summary>
        /// Forgets what a user was told about a title so a new interest in it starts afresh: the watch
        /// state under each of <paramref name="titleKeys"/> (every scope), their Ready and episode
        /// marks, the Ready marks of the Jellyfin items <paramref name="itemIds"/> and of the items
        /// the movie watch state recorded it ready as, and the episode marks of those series items and
        /// of the series items the title's episodes were told under.
        /// </summary>
        public void ForgetTitle(Guid userId, IEnumerable<string> titleKeys, IEnumerable<Guid> itemIds)
        {
            var user = Id(userId);
            var keys = titleKeys.Distinct(StringComparer.Ordinal).ToList();
            var items = new HashSet<Guid>(itemIds);
            foreach (var key in keys)
            {
                using var cmd = NotifyStore.Command(Connection, Transaction, "SELECT known FROM watch WHERE user_id=$u AND key=$k AND scope IN ('m','m4k') AND known IS NOT NULL", ("$u", user), ("$k", key));
                using var r = cmd.ExecuteReader();
                while (r.Read())
                {
                    foreach (var part in r.GetString(0).Split(',', StringSplitOptions.RemoveEmptyEntries))
                    {
                        if (Guid.TryParse(part, out var id)) items.Add(id);
                    }
                }
            }
            foreach (var key in keys)
            {
                var prefix = EpisodeSeriesMark(key, null);
                using var cmd = NotifyStore.Command(Connection, Transaction, "SELECT mark FROM marks WHERE user_id=$u AND substr(mark,1,length($p))=$p", ("$u", user), ("$p", prefix));
                using var r = cmd.ExecuteReader();
                while (r.Read())
                {
                    if (Guid.TryParse(r.GetString(0).AsSpan(prefix.Length), out var id)) items.Add(id);
                }
            }
            foreach (var key in keys)
            {
                NotifyStore.Exec(Connection, Transaction, "DELETE FROM marks WHERE user_id=$u AND substr(mark,1,length($p))=$p", ("$u", user), ("$p", EpisodeSeriesMark(key, null)));
                NotifyStore.Exec(Connection, Transaction, "DELETE FROM watch WHERE user_id=$u AND key=$k", ("$u", user), ("$k", key));
                foreach (var prefix in new[] { "ready|" + key + "|", "ep|" + key + ":", "ep4k|" + key + ":" })
                {
                    NotifyStore.Exec(Connection, Transaction, "DELETE FROM marks WHERE user_id=$u AND substr(mark,1,length($p))=$p", ("$u", user), ("$p", prefix));
                }
            }
            foreach (var item in items)
            {
                NotifyStore.Exec(Connection, Transaction, "DELETE FROM marks WHERE user_id=$u AND substr(mark,1,length($p))=$p", ("$u", user), ("$p", "ready-item|" + item.ToString("N", CultureInfo.InvariantCulture) + "|"));
                foreach (var four in new[] { false, true })
                {
                    NotifyStore.Exec(Connection, Transaction, "DELETE FROM marks WHERE user_id=$u AND substr(mark,1,length($p))=$p", ("$u", user), ("$p", EpisodeItemMark(item, four, null)));
                }
            }
        }

        /// <summary>
        /// The mark of one episode told under a Jellyfin series item, whichever id the series was
        /// followed or asked for by (with a null number: the prefix of every episode of that item).
        /// </summary>
        public static string EpisodeItemMark(Guid seriesItem, bool fourK, (int Season, int Episode)? number)
            => (fourK ? "ep4k-item|" : "ep-item|") + seriesItem.ToString("N", CultureInfo.InvariantCulture) + ":"
               + (number is { } n ? "s" + n.Season.ToString(CultureInfo.InvariantCulture) + ":e" + n.Episode.ToString(CultureInfo.InvariantCulture) : string.Empty);

        /// <summary>
        /// The mark noting that a title's episodes were told under a Jellyfin series item (so forgetting
        /// the title also forgets them when the item is gone); with a null item, the prefix.
        /// </summary>
        public static string EpisodeSeriesMark(string titleKey, Guid? seriesItem)
            => "ep-series|" + titleKey + "|" + (seriesItem?.ToString("N", CultureInfo.InvariantCulture) ?? string.Empty);

        /// <summary>
        /// Takes a request ledger notice (phase 3) in this transaction: true when it was still there (it is gone
        /// after the commit), so the notification it becomes and its removal commit together.
        /// </summary>
        public bool TakeRequestNotice(string id)
            => NotifyStore.Exec(Connection, Transaction, "DELETE FROM request_notices WHERE id=$id", ("$id", id)) == 1;

        /// <summary>
        /// Puts an outcome alert in the wait queue in this transaction (its producer's own record, a ledger notice or a Seerr
        /// change, is taken in the same one): one row per source and id, the first one kept with its original time.
        /// </summary>
        public bool AddAlertWait(AlertWait wait)
            => NotifyStore.Exec(Connection, Transaction, @"INSERT OR IGNORE INTO alert_waits(source,source_id,user_id,kind,title_key,event_key,payload,request_id,original_at,next_at,tries)
VALUES($s,$i,$u,$k,$t,$e,$p,$r,$o,$n,$tr)", ("$s", wait.Source), ("$i", wait.SourceId), ("$u", Id(wait.User)), ("$k", wait.Kind), ("$t", wait.TitleKey), ("$e", wait.EventKey),
                ("$p", wait.Payload), ("$r", wait.RequestId), ("$o", Ms(wait.OriginalAt)), ("$n", Ms(wait.NextAt)), ("$tr", wait.Tries)) >= 0;

        /// <summary>Takes a waiting outcome alert in this transaction (the notification it becomes commits with its removal).</summary>
        public bool TakeAlertWait(string source, string sourceId)
            => NotifyStore.Exec(Connection, Transaction, "DELETE FROM alert_waits WHERE source=$s AND source_id=$i", ("$s", source), ("$i", sourceId)) == 1;

        /// <summary>Adds a notification and its deliveries; null when the user already has one for <paramref name="eventKey"/>.</summary>
        public long? Add(Guid userId, string eventKey, string kind, string? titleKey, string? itemId, IReadOnlyDictionary<string, string> payload, IReadOnlyList<(string Channel, DateTimeOffset At)> deliveries, DateTimeOffset now)
        {
            var inserted = NotifyStore.Exec(Connection, Transaction, "INSERT OR IGNORE INTO notifications(user_id,event_key,kind,title_key,item_id,payload,created_at) VALUES($u,$e,$k,$tk,$i,$p,$n)",
                ("$u", Id(userId)), ("$e", eventKey), ("$k", kind), ("$tk", titleKey), ("$i", itemId), ("$p", JsonSerializer.Serialize(payload)), ("$n", Ms(now)));
            if (inserted == 0) return null;
            var id = Convert.ToInt64(NotifyStore.Scalar(Connection, "SELECT last_insert_rowid()", Array.Empty<(string, object?)>(), Transaction), CultureInfo.InvariantCulture);
            foreach (var (channel, at) in deliveries)
            {
                NotifyStore.Exec(Connection, Transaction, "INSERT OR IGNORE INTO deliveries(notification_id,channel,status,attempts,next_at) VALUES($id,$ch,'pending',0,$at)", ("$id", id), ("$ch", channel), ("$at", Ms(at)));
            }
            return id;
        }
    }
}