using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>
    /// A note for a requester that their request changed (a row of <c>request_notices</c>), with what telling them
    /// needs. Notices are written in the same transaction as the change; the notification service turns the ones a
    /// person hears about (an OK, a no) into notifications and removes every notice it has handled.
    /// </summary>
    /// <param name="Id">Notice id.</param>
    /// <param name="Want">The request as it is now (its owner is who hears about it).</param>
    /// <param name="Kind">What happened: the ledger's audit action (approve, merged, declined, fulfilled, create, ...).</param>
    /// <param name="At">When it happened.</param>
    /// <param name="DeclineReason">For a decline: the reason given (plain text), when one was.</param>
    /// <param name="Approver">For an OK: who gave it, when known.</param>
    public sealed record RequestNotice(string Id, RequestWant Want, string Kind, DateTimeOffset At, string? DeclineReason, Guid? Approver);

    /// <summary>
    /// Arrivals and requester notices: requests whose part is now in Jellyfin are marked fulfilled (so they read
    /// "Ready" and never turn stale), and the notices the ledger writes are read for delivery.
    /// </summary>
    public sealed partial class RequestLedger
    {
        /// <summary>
        /// Open requests that may have arrived: sent or stale ones (they went out), and ones still waiting for an OK
        /// (what they ask for may arrive another way). "Keep getting new episodes" requests never end and aren't
        /// listed. Oldest change first (then by id), at most <paramref name="limit"/>, after <paramref name="after"/>
        /// in that order when given (paging through all of them).
        /// </summary>
        /// <param name="limit">Most rows.</param>
        /// <param name="titleKey">Only this title, or every title.</param>
        /// <param name="after">The last request of the previous page, or null to start from the first.</param>
        public IReadOnlyList<RequestWant> Unfulfilled(int limit, string? titleKey = null, RequestWant? after = null) => !_db.Available ? Array.Empty<RequestWant>() : _db.Read(c =>
            (IReadOnlyList<RequestWant>)Wants(c, null, "id IN (SELECT id FROM wants WHERE status IN ('pending','sent','stale') AND json_extract(mutation_input,'$.Scope')<>'future' AND ($key IS NULL OR title_key=$key) AND ($after IS NULL OR updated_at>$at OR (updated_at=$at AND id>$after)) ORDER BY updated_at,id LIMIT $n)",
                ("$key", titleKey), ("$n", Math.Clamp(limit, 1, 10000)), ("$after", after?.Id), ("$at", after == null ? 0L : Ms(after.UpdatedAt)))
                // Wants() orders by created_at; callers want the least recently changed first.
                .OrderBy(w => w.UpdatedAt).ThenBy(w => w.Id, StringComparer.Ordinal).ToList());

        /// <summary>
        /// Marks a request whose part is in Jellyfin as fulfilled ("Ready"): a sent or stale one, or one still waiting
        /// for an OK that has nothing written upstream (it arrived another way: its held allowance is given back and
        /// its unsent jobs are cancelled). Anything else (queued, in flight, closed, "keep getting new episodes",
        /// which never ends) is left alone. The change is audited and noticed like any other; true when it changed.
        /// </summary>
        /// <param name="wantId">The request.</param>
        /// <param name="now">When.</param>
        /// <param name="seen">The request as it was when its part was found in Jellyfin: when it changed since (an OK
        /// with edits rewrote what it asks for, another status), nothing is done and the next look judges it again.</param>
        public bool Fulfil(string wantId, DateTimeOffset now, RequestWant? seen = null) => _db.Available && _db.Write((c, t) =>
        {
            var want = Wants(c, t, "id=$id", ("$id", wantId)).SingleOrDefault();
            if (want == null || want.Input.Scope == "future") return false;
            if (seen != null && (want.UpdatedAt != seen.UpdatedAt || want.Status != seen.Status || want.Input.Canonical != seen.Input.Canonical)) return false;
            if (want.Status == "pending")
            {
                // Something may already be written upstream (or Seerr was already processing it): not this path.
                if (LinkedScope(c, t, want) != null || Scalar(c, t, "SELECT id FROM jobs WHERE want_id=$id AND (state IN ('sending','maybe_sent','succeeded') OR json_extract(outcome,'$.certainty') IN ('Unknown','Succeeded')) LIMIT 1", ("$id", wantId)) != null)
                    return false;
                foreach (var job in Jobs(c, t, "want_id=$id AND state IN ('queued','retry','parked') AND " + KnownUnsent, ("$id", wantId)))
                    Supersede(c, t, job.Id, "fulfilled");
                Exec(c, t, "UPDATE reservations SET state='refunded' WHERE want_id=$id AND state='held'", ("$id", wantId));
            }
            else if (want.Status is not ("sent" or "stale"))
            {
                return false;
            }
            Exec(c, t, "UPDATE wants SET status='fulfilled',reason='ready',updated_at=$at WHERE id=$id", ("$at", Ms(now)), ("$id", wantId));
            Record(c, t, wantId, null, null, "fulfilled", "accepted", "ready", want.Input.Key, now);
            return true;
        });

        /// <summary>
        /// The titles anyone has a request for that is not cancelled or declined (fulfilled ones included, so the
        /// arrival is still told after the request was marked fulfilled): the notification service's interest.
        /// </summary>
        public IReadOnlyList<string> RequestedTitles() => !_db.Available ? Array.Empty<string>() : _db.Read(c =>
        {
            var list = new List<string>();
            using var cmd = Cmd(c, null, "SELECT DISTINCT title_key FROM wants WHERE status IN ('pending','queued','sent','stale','fulfilled')");
            using var r = cmd.ExecuteReader();
            while (r.Read()) list.Add(r.GetString(0));
            return (IReadOnlyList<string>)list;
        });

        /// <summary>Most change-log entries one <see cref="ChangedTitles"/> read takes (tests set it lower).</summary>
        internal int ChangedPage { get; set; } = 2000;

        /// <summary>
        /// The titles whose requests changed after <paramref name="after"/> (the ledger's change log, kept 48 hours),
        /// and the position read up to: the newest one, or the last entry taken when there were more than one read
        /// takes (the next read goes on from there). A position past the log's end (it was trimmed or replaced) reads
        /// from its start.
        /// </summary>
        /// <param name="after">Last position read, or null to only learn the newest position.</param>
        public (long Cursor, IReadOnlyList<string> Titles) ChangedTitles(long? after) => !_db.Available ? (after ?? 0, Array.Empty<string>()) : _db.Read(c =>
        {
            var newest = long.Parse(Scalar(c, null, "SELECT COALESCE(MAX(id),0) FROM request_events")!, CultureInfo.InvariantCulture);
            if (after == null) return (newest, (IReadOnlyList<string>)Array.Empty<string>());
            var from = after.Value > newest ? 0 : after.Value;
            var page = Math.Max(1, ChangedPage);
            var titles = new List<string>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var last = from;
            var read = 0;
            using var cmd = Cmd(c, null, "SELECT id,title_key FROM request_events WHERE id>$after AND id<=$newest ORDER BY id LIMIT $n", ("$after", from), ("$newest", newest), ("$n", page));
            using var r = cmd.ExecuteReader();
            while (r.Read())
            {
                read++;
                last = r.GetInt64(0);
                if (seen.Add(r.GetString(1))) titles.Add(r.GetString(1));
            }
            return (read < page ? newest : last, (IReadOnlyList<string>)titles);
        });

        /// <summary>
        /// Requester notices waiting to be handled, oldest first, with the request as it is now. Notices of requests
        /// that are gone were removed with them.
        /// </summary>
        /// <param name="limit">Most notices.</param>
        public IReadOnlyList<RequestNotice> Notices(int limit) => !_db.Available ? Array.Empty<RequestNotice>() : _db.Read(c =>
        {
            var rows = new List<(string Id, string Want, string Kind, long At)>();
            using (var cmd = Cmd(c, null, "SELECT id,want_id,kind,created_at FROM request_notices ORDER BY created_at,rowid LIMIT $n", ("$n", Math.Clamp(limit, 1, 1000))))
            using (var r = cmd.ExecuteReader())
            {
                while (r.Read()) rows.Add((r.GetString(0), r.GetString(1), r.GetString(2), r.GetInt64(3)));
            }
            var list = new List<RequestNotice>();
            foreach (var row in rows)
            {
                if (Wants(c, null, "id=$id", ("$id", row.Want)).SingleOrDefault() is not { } want) continue;
                var reason = row.Kind == "declined"
                    ? Scalar(c, null, "SELECT reason FROM approvals WHERE want_id=$w AND action='declined' ORDER BY created_at DESC,rowid DESC LIMIT 1", ("$w", row.Want))
                    : null;
                var approver = row.Kind == "approve"
                    ? Scalar(c, null, "SELECT actor_id FROM approvals WHERE want_id=$w AND action='approve' ORDER BY created_at DESC,rowid DESC LIMIT 1", ("$w", row.Want))
                    : null;
                list.Add(new RequestNotice(row.Id, want, row.Kind, DateTimeOffset.FromUnixTimeMilliseconds(row.At), reason, Guid.TryParse(approver, out var a) ? a : null));
            }
            return (IReadOnlyList<RequestNotice>)list;
        });
    }
}
