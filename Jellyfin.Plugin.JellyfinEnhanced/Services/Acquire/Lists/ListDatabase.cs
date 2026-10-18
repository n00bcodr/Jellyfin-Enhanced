using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Microsoft.Data.Sqlite;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>A durable list operation (one client confirmation of an add, apply, edit, reorder, swap-in switch or list creation).</summary>
    /// <param name="Id">Operation id.</param>
    /// <param name="UserId">The person.</param>
    /// <param name="Scope">The list id, or <c>create-playlist</c> / <c>create-collection</c>.</param>
    /// <param name="ClientId">The caller's request id.</param>
    /// <param name="Kind">add, apply, patch, delete, order, swap_in or create.</param>
    /// <param name="Fingerprint">What was asked for (server digest of the normalized request).</param>
    /// <param name="State">open, completed, failed, or deleted (a create whose list was removed; terminal until expiry).</param>
    /// <param name="Status">HTTP status of the finished operation.</param>
    /// <param name="ListId">Create: the list it made (a retry goes to that list).</param>
    /// <param name="Result">Bounded result identity (ids added/skipped; never a projected view).</param>
    /// <param name="CreatedAt">When the operation was first recorded (before anything it does), or null when not read.</param>
    public sealed record ListOperation(string Id, Guid UserId, string Scope, string ClientId, string Kind, string Fingerprint, string State, int? Status, string? ListId, string? Result, DateTimeOffset? CreatedAt = null);

    /// <summary>The answer of <see cref="ListOperations.Begin"/>.</summary>
    /// <param name="Operation">The operation (new, or the earlier one for the same request id).</param>
    /// <param name="Replayed">The same request again.</param>
    /// <param name="Conflict">The same request id with a different request (refused).</param>
    public sealed record ListOperationStart(ListOperation? Operation, bool Replayed, bool Conflict);

    /// <summary>One person's request made from a list entry.</summary>
    /// <param name="ListId">List.</param>
    /// <param name="PlaceholderId">Entry.</param>
    /// <param name="UserId">The person who asked.</param>
    /// <param name="WantId">The request (ledger want id).</param>
    /// <param name="OperationId">The confirmation it was part of.</param>
    /// <param name="TitleKey">Canonical title key.</param>
    /// <param name="Scope">Requested scope (canonical input JSON).</param>
    /// <param name="Edition">standard or 4k.</param>
    public sealed record ListLink(string ListId, string PlaceholderId, Guid UserId, string WantId, string? OperationId, string TitleKey, string Scope, string Edition);

    /// <summary>A verified swap-in event (the items are in the list): what notifications consume.</summary>
    /// <param name="Id">Row id.</param>
    /// <param name="ListId">List.</param>
    /// <param name="PlaceholderId">Entry.</param>
    /// <param name="Kind">The entry's kind.</param>
    /// <param name="TitleKey">Title key, when known.</param>
    /// <param name="Edition">Edition.</param>
    /// <param name="ItemIds">Real item ids ("N") verified in the list.</param>
    /// <param name="Complete">The entry is complete (retired).</param>
    /// <param name="CreatedAt">When.</param>
    public sealed record ListSwapEvent(long Id, string ListId, string PlaceholderId, string Kind, string? TitleKey, string? Edition, IReadOnlyList<string> ItemIds, bool Complete, DateTimeOffset CreatedAt);

    /// <summary>
    /// Durable list operations in acquire.db (schema 5). A client request id is one operation per person and scope: the
    /// same id with the same request is answered from the operation (a retry, also after a restart), never applied twice;
    /// with a different request it is refused. A replay re-projects the list for the caller now; it never returns a
    /// stored view. Kept 30 days.
    /// </summary>
    public sealed class ListOperations
    {
        /// <summary>How long finished operations are kept for replays.</summary>
        public static readonly TimeSpan Retention = TimeSpan.FromDays(30);

        private readonly AcquireDatabase _db;

        /// <summary>Creates the store (DI).</summary>
        /// <param name="db">acquire.db.</param>
        public ListOperations(AcquireDatabase db) { _db = db; }

        /// <summary>Whether operations can be recorded (the database is available).</summary>
        public bool Available => _db.Available;

        /// <summary>Records an operation, or finds the earlier one for the same person, scope and request id.</summary>
        /// <param name="user">The person.</param>
        /// <param name="scope">List id or create scope.</param>
        /// <param name="clientId">Request id.</param>
        /// <param name="kind">Kind.</param>
        /// <param name="fingerprint">Request digest.</param>
        /// <param name="now">Now.</param>
        /// <returns>The start.</returns>
        public ListOperationStart Begin(Guid user, string scope, string clientId, string kind, string fingerprint, DateTimeOffset now)
        {
            return _db.Write((c, t) =>
            {
                var existing = Read(c, t, "user_id=$u AND scope=$s AND client_id=$c", ("$u", RequestLedger.Id(user)), ("$s", scope), ("$c", clientId));
                if (existing != null)
                {
                    return existing.Fingerprint == fingerprint ? new ListOperationStart(existing, true, false) : new ListOperationStart(null, false, true);
                }

                var id = RequestLedger.NewId();
                RequestLedger.Exec(c, t, "INSERT INTO list_operations(id,user_id,scope,client_id,kind,fingerprint,state,created_at,updated_at) VALUES($id,$u,$s,$c,$k,$f,'open',$at,$at)",
                    ("$id", id), ("$u", RequestLedger.Id(user)), ("$s", scope), ("$c", clientId), ("$k", kind), ("$f", fingerprint), ("$at", RequestLedger.Ms(now)));
                return new ListOperationStart(new ListOperation(id, user, scope, clientId, kind, fingerprint, "open", null, null, null, now), false, false);
            });
        }

        /// <summary>Records the list a create operation made (before anything else is applied to it).</summary>
        /// <param name="id">Operation.</param>
        /// <param name="listId">The new list ("N").</param>
        /// <param name="now">Now.</param>
        public void SetList(string id, string listId, DateTimeOffset now)
            => _db.Write((c, t) => RequestLedger.Exec(c, t, "UPDATE list_operations SET list_id=$l,updated_at=$at WHERE id=$id AND state<>'deleted'", ("$l", listId), ("$at", RequestLedger.Ms(now)), ("$id", id)));

        /// <summary>
        /// Records the list a create operation made, atomically: only when the operation has no list yet (or this one) and
        /// no other operation recorded this list. False when it can't be claimed.
        /// </summary>
        /// <param name="id">Operation.</param>
        /// <param name="listId">The list ("N").</param>
        /// <param name="now">Now.</param>
        /// <returns>Whether the operation now records this list.</returns>
        public bool ClaimList(string id, string listId, DateTimeOffset now)
            => _db.Write((c, t) => RequestLedger.Exec(c, t,
                "UPDATE list_operations SET list_id=$l,updated_at=$at WHERE id=$id AND state<>'deleted' AND (list_id IS NULL OR list_id=$l) AND NOT EXISTS (SELECT 1 FROM list_operations o WHERE o.list_id=$l AND o.id<>$id)",
                ("$l", listId), ("$at", RequestLedger.Ms(now)), ("$id", id)) == 1);

        /// <summary>Whether any operation recorded this list as the one it created.</summary>
        /// <param name="listId">List ("N").</param>
        /// <returns>True when one did.</returns>
        public bool Claimed(string listId)
            => _db.Available && _db.Read(c =>
            {
                using var cmd = RequestLedger.Cmd(c, null, "SELECT 1 FROM list_operations WHERE list_id=$l LIMIT 1", ("$l", listId));
                return cmd.ExecuteScalar() != null;
            });

        /// <summary>Finishes an operation with its status and result identity.</summary>
        /// <param name="id">Operation.</param>
        /// <param name="completed">True: completed (replayed from now on); false: failed (a retry runs it again).</param>
        /// <param name="status">HTTP status.</param>
        /// <param name="result">Bounded result JSON, or null.</param>
        /// <param name="now">Now.</param>
        public void Finish(string id, bool completed, int status, string? result, DateTimeOffset now)
            => _db.Write((c, t) => RequestLedger.Exec(c, t, "UPDATE list_operations SET state=$s,status=$st,result=$r,updated_at=$at WHERE id=$id AND state<>'deleted'",
                ("$s", completed ? "completed" : "failed"), ("$st", status), ("$r", result), ("$at", RequestLedger.Ms(now)), ("$id", id)));

        /// <summary>Removes expired/non-create operations and marks removed creates deleted for the retry retention period.</summary>
        /// <param name="now">Now.</param>
        /// <param name="removedLists">List ids whose non-create operations go regardless of age.</param>
        /// <returns>Rows removed.</returns>
        public int Purge(DateTimeOffset now, IReadOnlyCollection<string>? removedLists = null)
        {
            if (!_db.Available) return 0;
            return _db.Write((c, t) =>
            {
                var removed = RequestLedger.Exec(c, t, "DELETE FROM list_operations WHERE updated_at < $cut AND state <> 'open'", ("$cut", RequestLedger.Ms(now - Retention)));
                removed += RequestLedger.Exec(c, t, "DELETE FROM list_operations WHERE updated_at < $cut", ("$cut", RequestLedger.Ms(now - Retention - Retention)));
                foreach (var list in removedLists ?? Array.Empty<string>())
                {
                    // Jellyfin may re-use a deleted folder's item id. Keep a durable tombstone, not just its id: a late
                    // completion and a scan that re-adds the folder must never revive this create. Repeated cleanup does
                    // not extend retention; deleted rows expire like other finished operations, after 30 days.
                    RequestLedger.Exec(c, t, "UPDATE list_operations SET state='deleted',status=404,result=NULL,updated_at=$at WHERE kind='create' AND list_id=$l AND state<>'deleted'",
                        ("$at", RequestLedger.Ms(now)), ("$l", list));
                    removed += RequestLedger.Exec(c, t, "DELETE FROM list_operations WHERE kind<>'create' AND (scope=$l OR list_id=$l)", ("$l", list));
                }

                return removed;
            });
        }

        /// <summary>Removes a person's operations (the user was deleted).</summary>
        /// <param name="user">The person.</param>
        public void PurgeUser(Guid user)
        {
            if (_db.Available) _db.Write((c, t) => RequestLedger.Exec(c, t, "DELETE FROM list_operations WHERE user_id=$u", ("$u", RequestLedger.Id(user))));
        }

        private static ListOperation? Read(SqliteConnection c, SqliteTransaction? t, string where, params (string, object?)[] args)
        {
            using var cmd = RequestLedger.Cmd(c, t, "SELECT id,user_id,scope,client_id,kind,fingerprint,state,status,list_id,result,created_at FROM list_operations WHERE " + where + " LIMIT 1", args);
            using var r = cmd.ExecuteReader();
            return r.Read()
                ? new ListOperation(r.GetString(0), Guid.Parse(r.GetString(1)), r.GetString(2), r.GetString(3), r.GetString(4), r.GetString(5), r.GetString(6),
                    r.IsDBNull(7) ? null : r.GetInt32(7), r.IsDBNull(8) ? null : r.GetString(8), r.IsDBNull(9) ? null : r.GetString(9),
                    DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(10)))
                : null;
        }
    }

    /// <summary>
    /// Which person's request each list entry asked for (acquire.db schema 5): server-written when a list ask is accepted,
    /// restored together with the requests. Several people can ask for one entry; each keeps their own link. Internal:
    /// never sent to a browser. Removing an entry or a list removes its links, not the requests.
    /// </summary>
    public sealed class ListLinks
    {
        private readonly AcquireDatabase _db;

        /// <summary>Creates the store (DI).</summary>
        /// <param name="db">acquire.db.</param>
        public ListLinks(AcquireDatabase db) { _db = db; }

        /// <summary>Records a link (idempotent).</summary>
        /// <param name="link">Link.</param>
        /// <param name="now">Now.</param>
        public void Add(ListLink link, DateTimeOffset now)
        {
            if (!_db.Available) return;
            _db.Write((c, t) => RequestLedger.Exec(c, t,
                "INSERT OR IGNORE INTO list_links(list_id,placeholder_id,user_id,want_id,operation_id,title_key,scope,edition,created_at) VALUES($l,$p,$u,$w,$o,$k,$s,$e,$at)",
                ("$l", link.ListId), ("$p", link.PlaceholderId), ("$u", RequestLedger.Id(link.UserId)), ("$w", link.WantId), ("$o", link.OperationId),
                ("$k", link.TitleKey), ("$s", link.Scope), ("$e", link.Edition), ("$at", RequestLedger.Ms(now))));
        }

        /// <summary>The links of one list.</summary>
        /// <param name="listId">List.</param>
        /// <returns>Links.</returns>
        public IReadOnlyList<ListLink> ForList(string listId)
            => !_db.Available ? Array.Empty<ListLink>() : _db.Read(c => ReadMany(c, "list_id=$l", ("$l", listId)));

        /// <summary>The links that point at a request.</summary>
        /// <param name="wantId">Want id.</param>
        /// <returns>Links.</returns>
        public IReadOnlyList<ListLink> ForWant(string wantId)
            => !_db.Available ? Array.Empty<ListLink>() : _db.Read(c => ReadMany(c, "want_id=$w", ("$w", wantId)));

        /// <summary>Removes the links of entries that are gone (or of a whole list when <paramref name="keep"/> is null).</summary>
        /// <param name="listId">List.</param>
        /// <param name="keep">Entry ids still in the list, or null to remove every link of the list.</param>
        /// <returns>Rows removed.</returns>
        public int Prune(string listId, IReadOnlySet<string>? keep)
        {
            if (!_db.Available) return 0;
            if (keep == null) return _db.Write((c, t) => RequestLedger.Exec(c, t, "DELETE FROM list_links WHERE list_id=$l", ("$l", listId)));
            var gone = ForList(listId).Where(l => !keep.Contains(l.PlaceholderId)).Select(l => l.PlaceholderId).Distinct().ToList();
            if (gone.Count == 0) return 0;
            return _db.Write((c, t) => gone.Sum(p => RequestLedger.Exec(c, t, "DELETE FROM list_links WHERE list_id=$l AND placeholder_id=$p", ("$l", listId), ("$p", p))));
        }

        /// <summary>Removes links whose request no longer exists (a restore of an older database, a purge).</summary>
        /// <returns>Rows removed.</returns>
        public int PruneOrphans()
            => !_db.Available ? 0 : _db.Write((c, t) => RequestLedger.Exec(c, t, "DELETE FROM list_links WHERE want_id NOT IN (SELECT id FROM wants)"));

        /// <summary>Removes a person's links (the user was deleted).</summary>
        /// <param name="user">The person.</param>
        public void PurgeUser(Guid user)
        {
            if (_db.Available) _db.Write((c, t) => RequestLedger.Exec(c, t, "DELETE FROM list_links WHERE user_id=$u", ("$u", RequestLedger.Id(user))));
        }

        private static List<ListLink> ReadMany(SqliteConnection c, string where, params (string, object?)[] args)
        {
            using var cmd = RequestLedger.Cmd(c, null, "SELECT list_id,placeholder_id,user_id,want_id,operation_id,title_key,scope,edition FROM list_links WHERE " + where + " ORDER BY created_at", args);
            using var r = cmd.ExecuteReader();
            var links = new List<ListLink>();
            while (r.Read())
            {
                links.Add(new ListLink(r.GetString(0), r.GetString(1), Guid.Parse(r.GetString(2)), r.GetString(3), r.IsDBNull(4) ? null : r.GetString(4), r.GetString(5), r.GetString(6), r.GetString(7)));
            }

            return links;
        }
    }

    /// <summary>
    /// Verified swap-in events (acquire.db schema 5): recorded only after Jellyfin's membership was read back, once per
    /// list, entry and set of items (a recovery or a second pass never records it twice). Notifications read and mark
    /// them; the list feature itself never sends anything.
    /// </summary>
    public sealed class ListEventStore
    {
        private const int MaxPending = 5000;
        private readonly AcquireDatabase _db;

        /// <summary>Creates the store (DI).</summary>
        /// <param name="db">acquire.db.</param>
        public ListEventStore(AcquireDatabase db) { _db = db; }

        /// <summary>Raised after an event was recorded (on the writer's thread: handlers only queue work).</summary>
        public event Action<ListSwapEvent>? Recorded;

        /// <summary>Records an event; false when it was already recorded or can't be.</summary>
        /// <param name="listId">List.</param>
        /// <param name="placeholderId">Entry.</param>
        /// <param name="kind">Entry kind.</param>
        /// <param name="titleKey">Title key.</param>
        /// <param name="edition">Edition.</param>
        /// <param name="itemIds">Verified items.</param>
        /// <param name="complete">The entry is complete.</param>
        /// <param name="now">Now.</param>
        /// <returns>Whether a new event was recorded.</returns>
        public bool Record(string listId, string placeholderId, string kind, string? titleKey, string? edition, IReadOnlyCollection<string> itemIds, bool complete, DateTimeOffset now)
        {
            if (!_db.Available || itemIds.Count == 0) return false;
            var items = itemIds.OrderBy(i => i, StringComparer.Ordinal).ToList();
            var key = listId + "|" + placeholderId + "|" + string.Join(",", items) + (complete ? "|complete" : string.Empty);
            var json = JsonSerializer.Serialize(items);
            long id;
            try
            {
                id = _db.Write((c, t) =>
                {
                    long pending;
                    using (var count = RequestLedger.Cmd(c, t, "SELECT COUNT(*) FROM list_events WHERE delivered_at IS NULL"))
                    {
                        pending = Convert.ToInt64(count.ExecuteScalar(), CultureInfo.InvariantCulture);
                    }

                    if (pending >= MaxPending)
                    {
                        RequestLedger.Exec(c, t, "DELETE FROM list_events WHERE id IN (SELECT id FROM list_events WHERE delivered_at IS NULL ORDER BY id LIMIT 500)");
                    }

                    if (RequestLedger.Exec(c, t, "INSERT OR IGNORE INTO list_events(event_key,list_id,placeholder_id,kind,title_key,edition,item_ids,complete,created_at) VALUES($k,$l,$p,$kind,$tk,$e,$i,$c,$at)",
                        ("$k", key), ("$l", listId), ("$p", placeholderId), ("$kind", kind), ("$tk", titleKey), ("$e", edition), ("$i", json), ("$c", complete ? 1 : 0), ("$at", RequestLedger.Ms(now))) == 0)
                    {
                        return 0L;
                    }

                    using var last = RequestLedger.Cmd(c, t, "SELECT last_insert_rowid()");
                    return Convert.ToInt64(last.ExecuteScalar(), CultureInfo.InvariantCulture);
                });
            }
            catch (SqliteException)
            {
                return false;
            }

            if (id == 0) return false;
            try
            {
                Recorded?.Invoke(new ListSwapEvent(id, listId, placeholderId, kind, titleKey, edition, items, complete, now));
            }
            catch (Exception)
            {
                // listeners only queue work; a failing one must not undo the recorded event
            }

            return true;
        }

        /// <summary>Events not delivered yet, oldest first.</summary>
        /// <param name="max">At most this many.</param>
        /// <returns>Events.</returns>
        public IReadOnlyList<ListSwapEvent> Pending(int max = 200)
        {
            if (!_db.Available) return Array.Empty<ListSwapEvent>();
            return _db.Read(c =>
            {
                using var cmd = RequestLedger.Cmd(c, null, "SELECT id,list_id,placeholder_id,kind,title_key,edition,item_ids,complete,created_at FROM list_events WHERE delivered_at IS NULL ORDER BY id LIMIT $n", ("$n", Math.Clamp(max, 1, 1000)));
                using var r = cmd.ExecuteReader();
                var events = new List<ListSwapEvent>();
                while (r.Read())
                {
                    events.Add(new ListSwapEvent(r.GetInt64(0), r.GetString(1), r.GetString(2), r.GetString(3), r.IsDBNull(4) ? null : r.GetString(4), r.IsDBNull(5) ? null : r.GetString(5),
                        JsonSerializer.Deserialize<List<string>>(r.GetString(6)) ?? new List<string>(), r.GetInt32(7) == 1, DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(8))));
                }

                return (IReadOnlyList<ListSwapEvent>)events;
            });
        }

        /// <summary>Marks an event delivered (or deliberately not delivered).</summary>
        /// <param name="id">Event id.</param>
        /// <param name="now">Now.</param>
        /// <returns>Whether it was pending.</returns>
        public bool MarkDelivered(long id, DateTimeOffset now)
            => _db.Available && _db.Write((c, t) => RequestLedger.Exec(c, t, "UPDATE list_events SET delivered_at=$at WHERE id=$id AND delivered_at IS NULL", ("$at", RequestLedger.Ms(now)), ("$id", id)) == 1);

        /// <summary>Removes delivered events older than 30 days and every event of removed lists.</summary>
        /// <param name="now">Now.</param>
        /// <param name="removedLists">Removed list ids.</param>
        /// <returns>Rows removed.</returns>
        public int Purge(DateTimeOffset now, IReadOnlyCollection<string>? removedLists = null)
        {
            if (!_db.Available) return 0;
            return _db.Write((c, t) =>
            {
                var removed = RequestLedger.Exec(c, t, "DELETE FROM list_events WHERE delivered_at IS NOT NULL AND delivered_at < $cut", ("$cut", RequestLedger.Ms(now - TimeSpan.FromDays(30))));
                foreach (var list in removedLists ?? Array.Empty<string>())
                {
                    removed += RequestLedger.Exec(c, t, "DELETE FROM list_events WHERE list_id=$l", ("$l", list));
                }

                return removed;
            });
        }
    }
}
