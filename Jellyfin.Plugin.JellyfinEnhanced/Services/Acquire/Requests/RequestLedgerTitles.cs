using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>What making a title one identity changed (see <see cref="RequestLedger.Unify"/>).</summary>
    /// <param name="Canonical">The key the title is held under now.</param>
    /// <param name="Keys">Every key of the title (its aliases and the canonical one).</param>
    /// <param name="People">Whose requests were moved (their lists change).</param>
    /// <param name="Acquisitions">Acquisitions merged into another.</param>
    /// <param name="Followers">Requests that now follow another request of the title (and got their charge back).</param>
    public sealed record TitleMerge(string Canonical, IReadOnlyList<string> Keys, IReadOnlyList<Guid> People, int Acquisitions, int Followers);

    /// <summary>
    /// One title identity across its ids (phase 4b, Q-4BFIX3-2). A title is known by several ids: a series by its TVDB,
    /// TMDB and IMDb ids, a movie by its TMDB and IMDb ids, and which ones are known changes (a series asked for before it
    /// reached Sonarr has only its TMDB id). The ledger holds every request for a title under ONE key, its canonical one
    /// (TVDB for a series, TMDB for a movie, when known; see <see cref="Rank"/>), and remembers every alias it has learned
    /// (<c>title_aliases</c>: alias → canonical), so:
    /// <list type="bullet">
    /// <item>every key that comes in (an ask, an edited approval, a lookup, an import) is resolved through the aliases first
    /// (<see cref="Canonical(SqliteConnection, SqliteTransaction?, string)"/>, and <see cref="TitleIs"/> in SQL), and every
    /// "same title" comparison goes through <see cref="RequestDestination.SameTitle"/>;</item>
    /// <item>when an alias is learned (<see cref="Unify"/>), every stored request, job and acquisition of the title is moved
    /// to the canonical key in one transaction, split acquisitions are merged, and a request another one of the title already
    /// covers follows it (what it would have done had the title been one from the start). Nothing is deleted, and nothing
    /// that went out is sent again.</item>
    /// </list>
    /// The edition stays part of identity: acquisitions are per title and edition.
    /// </summary>
    public sealed partial class RequestLedger
    {
        /// <summary>SQL: the canonical key of the key bound to <paramref name="parameter"/> (itself when it isn't a known alias).</summary>
        /// <param name="parameter">A SQL parameter name, e.g. <c>$key</c>.</param>
        internal static string CanonicalOf(string parameter) => "COALESCE((SELECT canonical FROM active_title_aliases WHERE alias=" + parameter + ")," + parameter + ")";

        /// <summary>SQL: a row's title is the one <c>$key</c> names, by any of its ids.</summary>
        internal static readonly string TitleIs = "title_key=" + CanonicalOf("$key");

        /// <summary>The key a title is held under in the ledger: the canonical key of <paramref name="key"/>'s title.</summary>
        /// <param name="c">The connection.</param>
        /// <param name="t">The transaction, if any.</param>
        /// <param name="key">A title key (any of its ids).</param>
        internal static string Canonical(SqliteConnection c, SqliteTransaction? t, string key)
            => TitleChoiceRegistry.IsIdentityFenced(c, t, key) ? key : Scalar(c, t, "SELECT canonical FROM active_title_aliases WHERE alias=$k", ("$k", key)) ?? key;

        // The input under its title's canonical key.
        private static MutationInput Canonical(SqliteConnection c, SqliteTransaction? t, MutationInput input)
        {
            var key = Canonical(c, t, input.Key);
            return key == input.Key ? input : input with { Key = key };
        }

        /// <summary>The key a title is held under in the ledger (any of its ids resolved).</summary>
        /// <param name="key">A title key.</param>
        public string CanonicalKey(string key) => !_db.Available ? key : _db.Read(c => Canonical(c, null, key));

        /// <summary>All durable provider identities for a title, including its canonical key (read only).</summary>
        public IReadOnlyList<TitleKey> AliasesFor(TitleKey key) => _db.Read(c =>
        {
            var canonical = Canonical(c, null, key.Title.ToString());
            var keys = new HashSet<string>(StringComparer.Ordinal) { canonical, key.Title.ToString() };
            using var cmd = Cmd(c, null, "SELECT alias FROM active_title_aliases WHERE canonical=$c", ("$c", canonical));
            using var reader = cmd.ExecuteReader();
            while (reader.Read()) keys.Add(reader.GetString(0));
            return (IReadOnlyList<TitleKey>)keys.Select(TitleKey.Parse).OfType<TitleKey>().Where(k => k.IsMovie == key.IsMovie).OrderBy(Rank).ToArray();
        });

        // An explicitly accepted local want/import makes currently proved aliases durable history. An old hidden
        // association is absent from the view and cannot be reactivated merely by asking under its old alias.
        private static void AcceptActiveAliases(SqliteConnection c, SqliteTransaction t, string key)
            => Exec(c, t, "DELETE FROM title_alias_origins WHERE alias IN(SELECT alias FROM active_title_aliases WHERE canonical=$k OR alias=$k)", ("$k", key));

        /// <summary>Every title key the ledger holds requests under (each once).</summary>
        public IReadOnlyList<string> TitleKeys() => !_db.Available ? Array.Empty<string>() : _db.Read(c =>
        {
            using var cmd = Cmd(c, null, "SELECT DISTINCT title_key FROM wants ORDER BY title_key");
            using var r = cmd.ExecuteReader();
            var keys = new List<string>();
            while (r.Read()) keys.Add(r.GetString(0));
            return (IReadOnlyList<string>)keys;
        });

        // The fingerprints an ask with this input may have been remembered by (its replay): under any id of its title.
        private static HashSet<string> Fingerprints(SqliteConnection c, SqliteTransaction? t, MutationInput input)
        {
            var canonical = Canonical(c, t, input.Key);
            var keys = new HashSet<string>(StringComparer.Ordinal) { input.Key, canonical };
            using (var cmd = Cmd(c, t, "SELECT alias FROM active_title_aliases WHERE canonical=$c", ("$c", canonical)))
            using (var r = cmd.ExecuteReader())
                while (r.Read()) keys.Add(r.GetString(0));
            return keys.Select(k => (input with { Key = k }).Fingerprint).ToHashSet(StringComparer.Ordinal);
        }

        /// <summary>
        /// Which of a title's ids it is held under: TVDB for a series, TMDB for a movie, then TMDB (series), then IMDb (lower
        /// is preferred; the same order <see cref="TitleAliases.Canonical"/> uses).
        /// </summary>
        /// <param name="key">A title key.</param>
        internal static int Rank(TitleKey key) => key.IsMovie
            ? key.Provider switch { "tmdb" => 0, "imdb" => 1, _ => 2 }
            : key.Provider switch { "tvdb" => 0, "tmdb" => 1, "imdb" => 2, _ => 3 };

        /// <summary>
        /// Learns that <paramref name="keys"/> are one title (from the arr libraries and Seerr's requests) and makes the ledger
        /// hold it under one key: the aliases are remembered; every request, job and acquisition stored under an alias moves to
        /// the canonical key; the title's acquisitions of each edition are merged; and in a merged acquisition a request
        /// another one already covers follows it, as it would have, with its charge given back and its unsent work cancelled
        /// (what went out stays; nothing is sent again). Idempotent: null (and nothing written) when it is all known already.
        /// Also null when the ids disagree (two different ids from one provider): two titles are never merged.
        /// </summary>
        /// <param name="keys">Keys known to name one title (any order, one kind).</param>
        /// <param name="policy">Current policy (a waiting request a merged one covers is released only when its asker may still ask).</param>
        /// <param name="now">Now.</param>
        public TitleMerge? Unify(IEnumerable<string> keys, IRequestPolicy policy, DateTimeOffset now)
            => Unify(keys, policy, now, SeerrFacts.HasSeerrDependency);

        // Only RequestTitleIdentity's arr-only resolver may supply independent proof inside an
        // enclosing Seerr effect. The final database publication still retains that effect's fence.
        internal TitleMerge? UnifyJeAliases(IEnumerable<string> keys, IRequestPolicy policy, DateTimeOffset now)
            => Unify(keys, policy, now, false);

        private TitleMerge? Unify(IEnumerable<string> keys, IRequestPolicy policy, DateTimeOffset now, bool seerrOrigin)
        {
            var factsOrigin = Helpers.UserCacheRegistry.PersistentOrigin(Helpers.UserCacheRegistry.Begin());
            var given = keys.Select(TitleKey.Parse).OfType<TitleKey>().Select(k => k.Title).DistinctBy(k => k.ToString()).ToList();
            if (given.Count < 2 || given.Any(k => k.IsMovie != given[0].IsMovie) || !_db.Available) return null;
            if (_db.Read(c => given.Any(k => TitleChoiceRegistry.IsIdentityFenced(c, null, k.ToString()))))
                return _db.Write<TitleMerge?>((c, t) => { TitleChoiceRegistry.FenceSplit(c, t, given); return null; });
            if (!_db.Read(c =>
            {
                var group = Group(c, null, given, seerrOrigin, out var identityConflict);
                return group == null ? identityConflict : Needed(c, null, group, given, seerrOrigin);
            })) return null;
            return _db.Write((c, t) =>
            {
                if (Group(c, t, given, seerrOrigin, out var identityConflict) is not { } group)
                {
                    // Refusing a lower-authority alias is not proof of a contradictory provider pair.
                    if (identityConflict) { TitleChoiceRegistry.FenceSplit(c, t, given); }
                    return null;
                }
                return Needed(c, t, group, given, seerrOrigin) ? UnifyCore(c, t, group, given, policy, now, seerrOrigin, factsOrigin) : null;
            });
        }

        // The title's keys: the ones given, what the ledger already maps them to, and the aliases it maps to those, with the
        // canonical one first. Null when two ids of one provider disagree.
        private static List<string>? Group(SqliteConnection c, SqliteTransaction? t, IReadOnlyList<TitleKey> given, bool seerrOrigin, out bool identityConflict)
        {
            identityConflict = false;
            var keys = new HashSet<string>(given.Select(k => k.ToString()), StringComparer.Ordinal);
            foreach (var canonical in keys.Select(k => Canonical(c, t, k)).ToList()) keys.Add(canonical);
            foreach (var canonical in keys.ToList())
            {
                using var cmd = Cmd(c, t, "SELECT alias FROM active_title_aliases WHERE canonical=$c", ("$c", canonical));
                using var r = cmd.ExecuteReader();
                while (r.Read()) keys.Add(r.GetString(0));
            }
            var parsed = keys.Select(TitleKey.Parse).OfType<TitleKey>().ToList();
            if (parsed.GroupBy(k => k.Provider).Any(g => g.Count() > 1)) { identityConflict = true; return null; }
            var ordered = parsed.OrderBy(Rank).Select(k => k.ToString()).ToList();
            if (seerrOrigin)
            {
                // An incidental join may add identities, but cannot replace a durable group's anchor.
                // Otherwise retiring the new anchor would also retire the old accepted association.
                var anchors = new HashSet<string>(StringComparer.Ordinal);
                foreach (var id in ordered)
                {
                    var durable = Scalar(c, t, "SELECT canonical FROM title_aliases a WHERE alias=$a AND NOT EXISTS(SELECT 1 FROM title_alias_origins o WHERE o.alias=a.alias)", ("$a", id));
                    if (durable != null) anchors.Add(durable);
                    if (IsRetainedIdentity(c, t, id)) anchors.Add(id);
                }
                // A low-authority hint cannot merge two independently retained identities.
                if (anchors.Count > 1) return null;
                if (anchors.SingleOrDefault() is { } anchor)
                {
                    ordered.Remove(anchor);
                    ordered.Insert(0, anchor);
                }
            }
            else
            {
                var proved = IndependentGroup(c, t, given);
                // Incidental members pulled in by Group do not become independent evidence.
                var anchor = ordered.First(proved.Contains);
                foreach (var alias in ordered)
                {
                    if (AssociationAuthority(c, t, alias) == AliasAuthority.Durable
                        && (!proved.Contains(alias) || !proved.Contains(Canonical(c, t, alias)))) return null;
                    if (!proved.Contains(alias) && IsRetainedIdentity(c, t, alias)) return null;
                }
                ordered.Remove(anchor);
                ordered.Insert(0, anchor);
            }
            return ordered;
        }

        // Exact stored identities establish authority, not title membership: resolving aliases here
        // would let the incidental association being judged manufacture its own durable anchor.
        private static bool IsRetainedIdentity(SqliteConnection c, SqliteTransaction? t, string id)
            => Scalar(c, t, "SELECT 1 WHERE EXISTS(SELECT 1 FROM wants WHERE title_key=$a) OR EXISTS(SELECT 1 FROM acquisitions WHERE title_key=$a)", ("$a", id)) != null;

        private static HashSet<string> IndependentGroup(SqliteConnection c, SqliteTransaction? t, IReadOnlyList<TitleKey> given)
        {
            var proved = given.Select(k => k.ToString()).ToHashSet(StringComparer.Ordinal);
            foreach (var id in proved.ToArray())
                if (AssociationAuthority(c, t, id) == AliasAuthority.Durable) proved.Add(Canonical(c, t, id));
            foreach (var id in proved.ToArray())
            {
                using var cmd = Cmd(c, t, "SELECT alias FROM title_aliases a WHERE canonical=$c AND NOT EXISTS(SELECT 1 FROM title_alias_origins o WHERE o.alias=a.alias)", ("$c", id));
                using var r = cmd.ExecuteReader();
                while (r.Read()) proved.Add(r.GetString(0));
            }
            return proved;
        }

        // Something to do: an alias not mapped to the canonical key yet, or a row still held under an alias.
        private static bool Needed(SqliteConnection c, SqliteTransaction? t, List<string> group, IReadOnlyList<TitleKey> given, bool seerrOrigin)
        {
            var aliases = group.Skip(1).ToList();
            if (!seerrOrigin)
            {
                var proved = IndependentGroup(c, t, given);
                if (aliases.Any(a => proved.Contains(a) && AssociationAuthority(c, t, a) == AliasAuthority.Incidental)) return true;
            }
            if (aliases.Any(a => Scalar(c, t, "SELECT canonical FROM active_title_aliases WHERE alias=$a", ("$a", a)) != group[0])) return true;
            if (Scalar(c, t, "SELECT alias FROM active_title_aliases WHERE alias=$c", ("$c", group[0])) != null) return true;
            return aliases.Any(a => Scalar(c, t, "SELECT 1 WHERE EXISTS(SELECT 1 FROM wants WHERE title_key=$a) OR EXISTS(SELECT 1 FROM acquisitions WHERE title_key=$a)", ("$a", a)) != null);
        }

        // The origin table is the persisted rank: absence on an EXISTING association is durable;
        // presence is incidental and carries the original facts generation. Absence of an association
        // is never evidence. All writers and acceptance/import promotion use this same ordering.
        private enum AliasAuthority { Unknown, Incidental, Durable }

        private static AliasAuthority AssociationAuthority(SqliteConnection c, SqliteTransaction? t, string alias)
            => Scalar(c, t, "SELECT alias FROM title_aliases WHERE alias=$a", ("$a", alias)) == null ? AliasAuthority.Unknown
                : Scalar(c, t, "SELECT alias FROM title_alias_origins WHERE alias=$a", ("$a", alias)) == null ? AliasAuthority.Durable : AliasAuthority.Incidental;

        private static TitleMerge UnifyCore(SqliteConnection c, SqliteTransaction t, List<string> group, IReadOnlyList<TitleKey> given, IRequestPolicy policy, DateTimeOffset now, bool seerrOrigin, string factsOrigin)
        {
            TitleChoiceRegistry.Reconcile(c, t, group);
            var canonical = group[0];
            var aliases = group.Skip(1).ToList();
            // The aliases, each mapped straight to the canonical key (an earlier canonical key included).
            // Capture authority BEFORE replacing rows. Missing origin on an existing association means
            // accepted/imported or independently learned JE proof; it outranks any incidental Seerr hint.
            var durable = aliases.Where(alias => AssociationAuthority(c, t, alias) == AliasAuthority.Durable).ToHashSet(StringComparer.Ordinal);
            var independent = seerrOrigin ? new HashSet<string>(StringComparer.Ordinal) : IndependentGroup(c, t, given);
            Exec(c, t, "DELETE FROM title_aliases WHERE alias=$c", ("$c", canonical));
            foreach (var alias in aliases)
                Exec(c, t, "INSERT INTO title_aliases(alias,canonical,learned_at) VALUES($a,$c,$at) ON CONFLICT(alias) DO UPDATE SET canonical=$c,learned_at=$at WHERE canonical<>$c", ("$a", alias), ("$c", canonical), ("$at", Ms(now)));
            Exec(c, t, "DELETE FROM title_alias_origins WHERE alias=$c", ("$c", canonical));
            foreach (var alias in aliases)
            {
                if (seerrOrigin && !durable.Contains(alias))
                    Exec(c, t, "INSERT INTO title_alias_origins(alias,facts_generation) VALUES($a,$g) ON CONFLICT(alias) DO UPDATE SET facts_generation=$g", ("$a", alias), ("$g", factsOrigin));
                else if (durable.Contains(alias) || independent.Contains(alias))
                    Exec(c, t, "DELETE FROM title_alias_origins WHERE alias=$a", ("$a", alias));
                else
                    Exec(c, t, "INSERT INTO title_alias_origins(alias,facts_generation) VALUES($a,$g) ON CONFLICT(alias) DO NOTHING", ("$a", alias), ("$g", factsOrigin));
            }
            var people = new HashSet<Guid>();
            var moved = new List<RequestWant>();
            foreach (var alias in aliases) moved.AddRange(Wants(c, t, "title_key=$a", ("$a", alias)));
            foreach (var want in moved)
            {
                people.Add(want.UserId);
                var input = want.Input with { Key = canonical };
                var owned = want.OwnedInput == null ? null : want.OwnedInput with { Key = canonical };
                Exec(c, t, "UPDATE wants SET title_key=$key,mutation_input=$input,owned_input=$owned,fingerprint=CASE WHEN fingerprint=$old THEN $f ELSE fingerprint END WHERE id=$id",
                    ("$key", canonical), ("$input", input.Canonical), ("$owned", owned?.Canonical), ("$old", want.Input.Fingerprint), ("$f", input.Fingerprint), ("$id", want.Id));
                // Its jobs: the same work under the title's key (a job's fingerprint stays its input's).
                var jobs = new List<(string Id, MutationInput Input, string Fingerprint)>();
                using (var cmd = Cmd(c, t, "SELECT id,mutation_input,fingerprint FROM jobs WHERE want_id=$w", ("$w", want.Id)))
                using (var r = cmd.ExecuteReader())
                    while (r.Read()) jobs.Add((r.GetString(0), JsonSerializer.Deserialize<MutationInput>(r.GetString(1))!, r.GetString(2)));
                foreach (var job in jobs)
                {
                    var rekeyed = job.Input with { Key = canonical };
                    Exec(c, t, "UPDATE jobs SET mutation_input=$input,fingerprint=$f WHERE id=$id",
                        ("$input", rekeyed.Canonical), ("$f", job.Fingerprint == job.Input.Fingerprint ? rekeyed.Fingerprint : job.Fingerprint), ("$id", job.Id));
                }
            }
            // The title's acquisitions, per edition: one survives (the canonical key's, else the oldest), the others' requests
            // move to it.
            var merged = new List<string>();
            var removed = 0;
            var acquisitions = new List<(string Id, string Key, string Variant, long At)>();
            foreach (var key in group)
            {
                using var cmd = Cmd(c, t, "SELECT id,title_key,variant,created_at FROM acquisitions WHERE title_key=$k", ("$k", key));
                using var r = cmd.ExecuteReader();
                while (r.Read()) acquisitions.Add((r.GetString(0), r.GetString(1), r.GetString(2), r.GetInt64(3)));
            }
            foreach (var edition in acquisitions.GroupBy(a => a.Variant))
            {
                var survivor = edition.OrderBy(a => a.Key == canonical ? 0 : 1).ThenBy(a => a.At).ThenBy(a => a.Id, StringComparer.Ordinal).First();
                foreach (var other in edition.Where(a => a.Id != survivor.Id))
                {
                    Exec(c, t, "UPDATE wants SET acquisition_id=$s WHERE acquisition_id=$o", ("$s", survivor.Id), ("$o", other.Id));
                    Exec(c, t, "DELETE FROM acquisitions WHERE id=$o", ("$o", other.Id));
                    removed++;
                }
                if (survivor.Key != canonical) Exec(c, t, "UPDATE acquisitions SET title_key=$c WHERE id=$s", ("$c", canonical), ("$s", survivor.Id));
                if (edition.Count() > 1) merged.Add(survivor.Id);
            }
            Exec(c, t, "UPDATE request_events SET title_key=$c WHERE title_key IN (SELECT alias FROM active_title_aliases WHERE canonical=$c)", ("$c", canonical));
            var followers = merged.Sum(acquisition => FollowWithin(c, t, acquisition, policy, now));
            Changed(c, t);
            Exec(c, t, "INSERT INTO request_events(title_key,created_at) VALUES($key,$at)", ("$key", canonical), ("$at", Ms(now)));
            return new TitleMerge(canonical, group, people.ToList(), removed, followers);
        }

        // A merged acquisition: each request another one of it already covers follows it, as it would have had the title been
        // one from the start. What went out stays its own (requests with sent work keep their place first, then by when they
        // were asked); a follower's unsent work is cancelled and its charge given back; one waiting for an OK that a queued
        // request covers is released like any. A request whose work is in flight (being sent, or unconfirmed) can't be
        // placed yet: the merge is noted (title_reconcile) and finished by SettleMerges once that work settles (review round
        // 5, 4b-B13). Returns how many now follow.
        private static int FollowWithin(SqliteConnection c, SqliteTransaction t, string acquisition, IRequestPolicy policy, DateTimeOffset now)
        {
            var wants = Wants(c, t, "acquisition_id=$a", ("$a", acquisition));
            bool Sent(RequestWant w) => Scalar(c, t, "SELECT id FROM jobs WHERE want_id=$w AND state='succeeded' LIMIT 1", ("$w", w.Id)) != null || LinkedScope(c, t, w) != null;
            var ordered = wants.OrderBy(w => Sent(w) ? 0 : 1).ThenBy(w => w.CreatedAt).ThenBy(w => w.Id, StringComparer.Ordinal).ToList();
            var earlier = new List<RequestWant>();
            var followers = 0;
            var unsettled = false;
            foreach (var want in ordered)
            {
                var uncertain = InFlight(c, t, want.Id);
                unsettled |= uncertain && !want.Follower && Active(want);
                if (want.Follower || !Active(want) || uncertain || earlier.Count == 0 || want.Input.Extra(Coverage(c, t, earlier, want.TargetKey, want.Status == "pending")) != null)
                {
                    earlier.Add(want);
                    continue;
                }
                // Its own unsent work is cancelled, every charge of it given back (it follows for free).
                Exec(c, t, "UPDATE reservations SET state='refunded' WHERE want_id=$w AND state IN ('charged','held')", ("$w", want.Id));
                Exec(c, t, "UPDATE jobs SET state='cancelled',reason='merged' WHERE want_id=$w AND " + Unsent, ("$w", want.Id));
                var (status, reason) = Sent(want) || want.Input.Extra(Confirmed(c, t, earlier, want.TargetKey)) == null ? ("sent", "looking")
                    : want.Input.Extra(Coverage(c, t, earlier, want.TargetKey)) == null ? ("queued", "queued_outage")
                    : ("pending", want.Status == "pending" ? want.Reason : "awaiting_approval");
                Exec(c, t, "UPDATE wants SET status=$s,reason=$r,is_follower=1,owned_input=NULL,cost=0,updated_at=$at WHERE id=$w", ("$s", status), ("$r", reason), ("$at", Ms(now)), ("$w", want.Id));
                Record(c, t, want.Id, null, null, "merged", "accepted", reason, want.Input.Key, now);
                earlier.Add(want with { Status = status, Reason = reason, Follower = true, OwnedInput = null, Cost = 0 });
                followers++;
            }
            var before = Wants(c, t, "acquisition_id=$a AND status='pending' AND is_follower=0", ("$a", acquisition)).Count;
            ReleasePendingFollowers(c, t, acquisition, null, policy, now, false);
            // Noted while work of a request of it is in flight and another request of it owns work too; else finished.
            if (unsettled && wants.Count(w => Active(w) && !w.Follower) > 1)
                Exec(c, t, "INSERT INTO title_reconcile(acquisition_id,noted_at) VALUES($a,$at) ON CONFLICT(acquisition_id) DO NOTHING", ("$a", acquisition), ("$at", Ms(now)));
            else
                Exec(c, t, "DELETE FROM title_reconcile WHERE acquisition_id=$a", ("$a", acquisition));
            return followers + before - Wants(c, t, "acquisition_id=$a AND status='pending' AND is_follower=0", ("$a", acquisition)).Count;
        }

        // A request has work that may have gone out and isn't settled: being sent, waiting for a read-back, or written with its
        // certainty unknown (held after the write included).
        private static bool InFlight(SqliteConnection c, SqliteTransaction? t, string wantId)
            => Scalar(c, t, "SELECT id FROM jobs WHERE want_id=$w AND (state IN ('sending','maybe_sent') OR (state NOT IN ('cancelled','succeeded') AND json_extract(outcome,'$.certainty')='Unknown')) LIMIT 1", ("$w", wantId)) != null;

        /// <summary>
        /// Finishes the merges that met work in flight (review round 5, 4b-B13): for each noted title whose requests' work has
        /// all settled now (confirmed, or proven unsent), who follows whom is worked out as the merge would have (a request
        /// another already covers follows it, its unsent work cancelled and its charge given back, once). A title whose work
        /// is still in flight stays noted. Persisted, so a restart in between loses nothing. Returns the requests' title keys
        /// and people whose lists changed (empty when nothing did).
        /// </summary>
        /// <param name="policy">Current policy.</param>
        /// <param name="now">Now.</param>
        public IReadOnlyList<TitleMerge> SettleMerges(IRequestPolicy policy, DateTimeOffset now)
        {
            if (!_db.Available || _db.Read(c => Scalar(c, null, "SELECT acquisition_id FROM title_reconcile LIMIT 1")) == null) return Array.Empty<TitleMerge>();
            return _db.Write((c, t) =>
            {
                var settled = new List<TitleMerge>();
                Exec(c, t, "DELETE FROM title_reconcile WHERE acquisition_id NOT IN (SELECT id FROM acquisitions)");
                var noted = new List<string>();
                using (var cmd = Cmd(c, t, "SELECT acquisition_id FROM title_reconcile ORDER BY noted_at,acquisition_id"))
                using (var r = cmd.ExecuteReader())
                    while (r.Read()) noted.Add(r.GetString(0));
                foreach (var acquisition in noted)
                {
                    var wants = Wants(c, t, "acquisition_id=$a", ("$a", acquisition));
                    if (wants.Any(w => InFlight(c, t, w.Id))) continue;
                    var followers = FollowWithin(c, t, acquisition, policy, now);
                    Exec(c, t, "DELETE FROM title_reconcile WHERE acquisition_id=$a", ("$a", acquisition));
                    if (followers == 0 || wants.Count == 0) continue;
                    var key = Scalar(c, t, "SELECT title_key FROM acquisitions WHERE id=$a", ("$a", acquisition)) ?? wants[0].Input.Key;
                    Changed(c, t);
                    settled.Add(new TitleMerge(key, new[] { key }, wants.Select(w => w.UserId).Distinct().ToList(), 0, followers));
                }
                return (IReadOnlyList<TitleMerge>)settled;
            });
        }
    }
}
