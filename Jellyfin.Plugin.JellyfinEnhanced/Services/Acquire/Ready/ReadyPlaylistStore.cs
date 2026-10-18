using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready
{
    /// <summary>
    /// The Ready playlist's durable state in <c>acquire.db</c>: each person's consent, epoch and playlist binding per server,
    /// the membership journal, the entries per interest and the native-message attempts. Every write is one short
    /// transaction; a write made from rows read earlier is generation-checked (a restore in between drops it) and
    /// epoch-checked (an opt-out or renewal in between wins). Nothing here calls Jellyfin.
    /// </summary>
    public sealed class ReadyPlaylistStore
    {
        private static readonly JsonSerializerOptions Json = new();

        private readonly AcquireDatabase _db;

        /// <summary>The store over the installation's database (DI).</summary>
        public ReadyPlaylistStore(AcquireDatabase db)
        {
            _db = db;
        }

        /// <summary>The database.</summary>
        public AcquireDatabase Database => _db;

        /// <summary>True when the database can be used.</summary>
        public bool Available => _db.Available;

        /// <summary>The database's generation (a restore moves it on).</summary>
        public long Generation => _db.Generation;

        // ------------------------------------------------------------------ bindings

        /// <summary>A person's binding on this server, or null when they never opted in.</summary>
        public ReadyBinding? Binding(string server, Guid user) => _db.Read(c =>
        {
            using var cmd = Command(c, null, Select + " WHERE server_id=$s AND user_id=$u", ("$s", server), ("$u", Id(user)));
            using var r = cmd.ExecuteReader();
            return r.Read() ? Row(r) : null;
        });

        /// <summary>Every binding on this server that is opted in (the sweep's work).</summary>
        public IReadOnlyList<ReadyBinding> OptedIn(string server) => _db.Read(c =>
        {
            var list = new List<ReadyBinding>();
            using var cmd = Command(c, null, Select + " WHERE server_id=$s AND opted_in=1 ORDER BY user_id", ("$s", server));
            using var r = cmd.ExecuteReader();
            while (r.Read()) list.Add(Row(r));
            return (IReadOnlyList<ReadyBinding>)list;
        });

        /// <summary>The binding that manages <paramref name="playlistId"/> on this server, or null.</summary>
        public ReadyBinding? ByPlaylist(string server, Guid playlistId) => _db.Read(c =>
        {
            using var cmd = Command(c, null, Select + " WHERE server_id=$s AND playlist_id=$p", ("$s", server), ("$p", Id(playlistId)));
            using var r = cmd.ExecuteReader();
            return r.Read() ? Row(r) : null;
        });

        /// <summary>
        /// The person turns the playlist on (or on again): a new epoch. After a deletion or removal the old binding is
        /// dropped (a new playlist is made); after a restore or a privacy change it is kept, to be checked in full before
        /// any change. Returns the binding.
        /// </summary>
        public ReadyBinding OptIn(string server, Guid user, DateTimeOffset now) => _db.Write((c, t) =>
        {
            Exec(c, t, @"INSERT INTO ready_playlists(server_id,user_id,opted_in,opt_in_epoch,state,revision,updated_at) VALUES($s,$u,1,1,'active',1,$n)
ON CONFLICT(server_id,user_id) DO UPDATE SET opted_in=1, opt_in_epoch=opt_in_epoch+1, revision=revision+1, updated_at=$n, pending_op=NULL,
  missing_since=NULL, missing_count=0, reason=NULL,
  playlist_id=CASE WHEN state IN ('deleted','removed') THEN NULL ELSE playlist_id END,
  create_marker=CASE WHEN state IN ('deleted','removed') THEN NULL ELSE create_marker END,
  confirmed=CASE WHEN state IN ('deleted','removed') THEN NULL ELSE confirmed END,
  state='active'", ("$s", server), ("$u", Id(user)), ("$n", Ms(now)));
            return Read(c, t, server, user)!;
        });

        /// <summary>The person turns the playlist off: no more changes; the playlist itself is kept as it is.</summary>
        public ReadyBinding? OptOut(string server, Guid user, DateTimeOffset now) => _db.Write((c, t) =>
        {
            Exec(c, t, "UPDATE ready_playlists SET opted_in=0, pending_op=NULL, revision=revision+1, updated_at=$n, state=CASE WHEN state IN ('active','privacy') THEN 'off' ELSE state END WHERE server_id=$s AND user_id=$u",
                ("$s", server), ("$u", Id(user)), ("$n", Ms(now)));
            return Read(c, t, server, user);
        });

        /// <summary>Records a create marker before the playlist is made (the create's journal). False when the epoch moved on or a restore happened.</summary>
        public bool BeginCreate(long generation, string server, Guid user, long epoch, string marker, DateTimeOffset now)
            => Update(generation, server, user, epoch, "create_marker=$m", now, ("$m", marker));

        /// <summary>Binds the playlist made (or found by its marker). False when the epoch moved on or a restore happened.</summary>
        public bool Bind(long generation, string server, Guid user, long epoch, Guid playlistId, DateTimeOffset now)
            => Update(generation, server, user, epoch, "playlist_id=$p, missing_since=NULL, missing_count=0", now, ("$p", Id(playlistId)));

        /// <summary>Records the membership change about to be made (desired ids in order).</summary>
        public bool BeginChange(long generation, string server, Guid user, long epoch, IReadOnlyList<Guid> desired, DateTimeOffset now)
            => Update(generation, server, user, epoch, "pending_op=$o", now,
                ("$o", JsonSerializer.Serialize(new PendingOperation(Guid.NewGuid().ToString("N"), epoch, desired.Select(Id).ToArray(), Ms(now)), Json)));

        /// <summary>Records the membership read back after the change and ends it.</summary>
        public bool Confirm(long generation, string server, Guid user, long epoch, IReadOnlyList<Guid> observed, DateTimeOffset now)
            => Update(generation, server, user, epoch, "pending_op=NULL, confirmed=$c, confirmed_at=$n, missing_since=NULL, missing_count=0", now,
                ("$c", JsonSerializer.Serialize(observed.Select(Id).ToArray(), Json)));

        /// <summary>A read found the playlist missing (not yet confirmed deleted). Returns the binding afterwards.</summary>
        public ReadyBinding? NoteMissing(long generation, string server, Guid user, long epoch, DateTimeOffset now)
        {
            Update(generation, server, user, epoch, "missing_since=COALESCE(missing_since,$n), missing_count=missing_count+1", now);
            return Binding(server, user);
        }

        /// <summary>
        /// Moves the binding to <paramref name="state"/> for this epoch (deleted, removed, privacy, active); deleted and
        /// removed drop the playlist id and the person's opt-in (a renewed opt-in makes a new playlist).
        /// </summary>
        public bool SetState(long generation, string server, Guid user, long epoch, string state, string? reason, DateTimeOffset now)
        {
            var tombstone = state is ReadyState.Deleted or ReadyState.Removed;
            return Update(generation, server, user, epoch,
                "state=$st, reason=$r, pending_op=NULL, missing_since=NULL, missing_count=0" + (tombstone ? ", opted_in=0, playlist_id=NULL, confirmed=NULL" : string.Empty),
                now, ("$st", state), ("$r", reason));
        }

        /// <summary>
        /// The person removed the managed playlist from their settings (opted in or not): a tombstone for the binding that
        /// still names <paramref name="playlistId"/>. Returns false when the binding changed since it was read.
        /// </summary>
        public bool Removed(long generation, string server, Guid user, long revision, DateTimeOffset now)
            => _db.WriteIf(generation, (c, t) => Exec(c, t, "UPDATE ready_playlists SET state='removed', reason='removed', opted_in=0, playlist_id=NULL, confirmed=NULL, pending_op=NULL, missing_since=NULL, missing_count=0, revision=revision+1, updated_at=$n WHERE server_id=$s AND user_id=$u AND revision=$r",
                ("$s", server), ("$u", Id(user)), ("$r", revision), ("$n", Ms(now))), 0).Result == 1;

        // One guarded update: only while the database is still at the generation the rows were read under, and the binding is
        // still at this epoch and opted in (a removal sets state only while still opted in, too).
        private bool Update(long generation, string server, Guid user, long epoch, string set, DateTimeOffset now, params (string Name, object? Value)[] args)
        {
            var all = new List<(string, object?)> { ("$s", server), ("$u", Id(user)), ("$e", epoch), ("$n", Ms(now)) };
            all.AddRange(args);
            return _db.WriteIf(generation, (c, t) => Exec(c, t, "UPDATE ready_playlists SET " + set + ", revision=revision+1, updated_at=$n WHERE server_id=$s AND user_id=$u AND opt_in_epoch=$e AND opted_in=1", all.ToArray()), 0).Result == 1;
        }

        // ------------------------------------------------------------------ entries

        /// <summary>A person's entries on this server.</summary>
        public IReadOnlyList<ReadyEntryRow> Entries(string server, Guid user) => _db.Read(c =>
        {
            var list = new List<ReadyEntryRow>();
            using var cmd = Command(c, null, "SELECT interest,part,title_key,edition,logical_id,series_id,playable_id,ready_at,expires_at,disposition FROM ready_entries WHERE server_id=$s AND user_id=$u",
                ("$s", server), ("$u", Id(user)));
            using var r = cmd.ExecuteReader();
            while (r.Read())
            {
                list.Add(new ReadyEntryRow(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3), Guid.Parse(r.GetString(4)),
                    r.IsDBNull(5) ? null : Guid.Parse(r.GetString(5)), r.IsDBNull(6) ? null : Guid.Parse(r.GetString(6)), r.GetInt64(7), r.GetInt64(8), r.GetString(9)));
            }

            return (IReadOnlyList<ReadyEntryRow>)list;
        });

        /// <summary>
        /// Saves a reconciliation's entries: <paramref name="upsert"/> written (an existing row keeps its first ready time),
        /// <paramref name="remove"/> (interest, part) deleted. Only while the binding is still opted in at this epoch, so a
        /// deleted person or an opt-out in between leaves nothing behind.
        /// </summary>
        public bool SaveEntries(long generation, string server, Guid user, long epoch, IReadOnlyList<ReadyEntryRow> upsert, IReadOnlyList<(string Interest, string Part)> remove, DateTimeOffset now)
            => _db.WriteIf(generation, (c, t) =>
            {
                var alive = Scalar(c, t, "SELECT COUNT(*) FROM ready_playlists WHERE server_id=$s AND user_id=$u AND opt_in_epoch=$e AND opted_in=1", ("$s", server), ("$u", Id(user)), ("$e", epoch));
                if (Convert.ToInt32(alive, CultureInfo.InvariantCulture) == 0) return false;
                foreach (var e in upsert)
                {
                    Exec(c, t, @"INSERT INTO ready_entries(server_id,user_id,interest,part,title_key,edition,logical_id,series_id,playable_id,ready_at,expires_at,disposition,updated_at)
VALUES($s,$u,$i,$p,$k,$ed,$l,$sr,$pl,$ra,$ex,$d,$n)
ON CONFLICT(server_id,user_id,interest,part) DO UPDATE SET logical_id=excluded.logical_id, series_id=excluded.series_id, playable_id=excluded.playable_id,
  disposition=CASE WHEN ready_entries.disposition IN ('watched','expired') THEN ready_entries.disposition ELSE excluded.disposition END, updated_at=excluded.updated_at",
                        ("$s", server), ("$u", Id(user)), ("$i", e.Interest), ("$p", e.Part), ("$k", e.TitleKey), ("$ed", e.Edition), ("$l", Id(e.LogicalItemId)),
                        ("$sr", e.SeriesId is Guid sid ? Id(sid) : null), ("$pl", e.PlayableItemId is Guid pid ? Id(pid) : null), ("$ra", e.ReadyAt), ("$ex", e.ExpiresAt),
                        ("$d", e.Disposition), ("$n", Ms(now)));
                }

                foreach (var (interest, part) in remove)
                {
                    Exec(c, t, "DELETE FROM ready_entries WHERE server_id=$s AND user_id=$u AND interest=$i AND part=$p", ("$s", server), ("$u", Id(user)), ("$i", interest), ("$p", part));
                }

                return true;
            }, false).Result;

        /// <summary>Forgets a person's entries on this server (a renewed opt-in after a deletion starts afresh).</summary>
        public void ClearEntries(string server, Guid user) => _db.Write((c, t) => Exec(c, t, "DELETE FROM ready_entries WHERE server_id=$s AND user_id=$u", ("$s", server), ("$u", Id(user))));

        // ------------------------------------------------------------------ native message attempts

        /// <summary>The attempt recorded for a delivery (its state), or null when none was.</summary>
        public string? AttemptState(long deliveryId) => _db.Read(c => Scalar(c, null, "SELECT state FROM ready_message_attempts WHERE delivery_id=$d", ("$d", deliveryId)) as string);

        /// <summary>
        /// Claims a delivery before its message is sent (one claim per delivery: false when one exists or a restore
        /// happened). A claim with no outcome after a restart is never sent again.
        /// </summary>
        public bool Claim(long generation, long deliveryId, Guid user, string? session, DateTimeOffset now)
            => _db.WriteIf(generation, (c, t) => Exec(c, t, "INSERT OR IGNORE INTO ready_message_attempts(delivery_id,user_id,session,state,attempted_at) SELECT $d,$u,$se,'claimed',$n WHERE EXISTS (SELECT 1 FROM deliveries WHERE id=$d AND status='pending')",
                ("$d", deliveryId), ("$u", Id(user)), ("$se", session), ("$n", Ms(now))) == 1, false).Result;

        /// <summary>Records what happened to a claimed attempt: <c>accepted</c> (Jellyfin took the command), <c>unknown</c> or <c>suppressed</c>.</summary>
        public bool Settle(long generation, long deliveryId, string state, string? outcome, DateTimeOffset now)
            => _db.WriteIf(generation, (c, t) => Exec(c, t, "UPDATE ready_message_attempts SET state=$st, outcome=$o, accepted_at=CASE WHEN $st='accepted' THEN $n ELSE accepted_at END WHERE delivery_id=$d",
                ("$d", deliveryId), ("$st", state), ("$o", outcome == null ? null : outcome.Length <= 200 ? outcome : outcome[..200]), ("$n", Ms(now))) == 1, false).Result;

        /// <summary>How a person's native messages went since <paramref name="since"/>: accepted, suppressed and unknown (shown never: no client confirms it).</summary>
        public (int Accepted, int Suppressed, int Unknown) Outcomes(Guid user, DateTimeOffset since) => _db.Read(c =>
        {
            int accepted = 0, unknown = 0;
            using (var cmd = Command(c, null, "SELECT state,COUNT(*) FROM ready_message_attempts WHERE user_id=$u AND attempted_at>=$a GROUP BY state", ("$u", Id(user)), ("$a", Ms(since))))
            using (var r = cmd.ExecuteReader())
            {
                while (r.Read())
                {
                    if (r.GetString(0) == "accepted") accepted += r.GetInt32(1);
                    else if (r.GetString(0) is "unknown" or "claimed") unknown += r.GetInt32(1);
                }
            }

            var suppressed = Convert.ToInt32(Scalar(c, null, @"SELECT COUNT(*) FROM deliveries d JOIN notifications n ON n.id=d.notification_id
WHERE n.user_id=$u AND d.channel=$ch AND d.status='suppressed' AND n.created_at>=$a", ("$u", Id(user)), ("$ch", Notify.NotifyChannel.DisplayMessage), ("$a", Ms(since))), CultureInfo.InvariantCulture);
            return (accepted, suppressed, unknown);
        });

        // ------------------------------------------------------------------ helpers

        private const string Select = "SELECT server_id,user_id,opted_in,opt_in_epoch,state,playlist_id,create_marker,pending_op,confirmed,confirmed_at,missing_since,missing_count,reason,revision FROM ready_playlists";

        private static ReadyBinding? Read(SqliteConnection c, SqliteTransaction t, string server, Guid user)
        {
            using var cmd = Command(c, t, Select + " WHERE server_id=$s AND user_id=$u", ("$s", server), ("$u", Id(user)));
            using var r = cmd.ExecuteReader();
            return r.Read() ? Row(r) : null;
        }

        private static ReadyBinding Row(SqliteDataReader r) => new()
        {
            ServerId = r.GetString(0),
            UserId = Guid.Parse(r.GetString(1)),
            OptedIn = r.GetInt64(2) == 1,
            Epoch = r.GetInt64(3),
            State = r.GetString(4),
            PlaylistId = r.IsDBNull(5) ? null : Guid.Parse(r.GetString(5)),
            Marker = r.IsDBNull(6) ? null : r.GetString(6),
            PendingOperation = r.IsDBNull(7) ? null : r.GetString(7),
            Confirmed = r.IsDBNull(8) ? Array.Empty<Guid>() : Ids(r.GetString(8)),
            ConfirmedAt = r.IsDBNull(9) ? null : r.GetInt64(9),
            MissingSince = r.IsDBNull(10) ? null : r.GetInt64(10),
            MissingCount = r.GetInt32(11),
            Reason = r.IsDBNull(12) ? null : r.GetString(12),
            Revision = r.GetInt64(13),
        };

        private static IReadOnlyList<Guid> Ids(string json)
        {
            try
            {
                return (JsonSerializer.Deserialize<string[]>(json, Json) ?? Array.Empty<string>()).Select(s => Guid.TryParse(s, out var g) ? g : Guid.Empty).Where(g => g != Guid.Empty).ToList();
            }
            catch (JsonException)
            {
                return Array.Empty<Guid>();
            }
        }

        /// <summary>The pending desired membership of a journal entry (ids in order), or empty.</summary>
        internal static IReadOnlyList<Guid> PendingDesired(string? json)
        {
            if (string.IsNullOrEmpty(json)) return Array.Empty<Guid>();
            try
            {
                return (JsonSerializer.Deserialize<PendingOperation>(json, Json)?.Desired ?? Array.Empty<string>()).Select(s => Guid.TryParse(s, out var g) ? g : Guid.Empty).Where(g => g != Guid.Empty).ToList();
            }
            catch (JsonException)
            {
                return Array.Empty<Guid>();
            }
        }

        private sealed record PendingOperation(string Id, long Epoch, string[] Desired, long At);

        internal static string Id(Guid id) => id.ToString("N", CultureInfo.InvariantCulture);

        internal static long Ms(DateTimeOffset at) => at.ToUnixTimeMilliseconds();

        private static SqliteCommand Command(SqliteConnection c, SqliteTransaction? t, string sql, params (string Name, object? Value)[] args)
        {
            var cmd = c.CreateCommand();
            cmd.CommandText = sql;
            cmd.Transaction = t;
            foreach (var (name, value) in args) cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
            return cmd;
        }

        private static int Exec(SqliteConnection c, SqliteTransaction t, string sql, params (string Name, object? Value)[] args)
        {
            using var cmd = Command(c, t, sql, args);
            return cmd.ExecuteNonQuery();
        }

        private static object? Scalar(SqliteConnection c, SqliteTransaction? t, string sql, params (string Name, object? Value)[] args)
        {
            using var cmd = Command(c, t, sql, args);
            return cmd.ExecuteScalar();
        }
    }
}
