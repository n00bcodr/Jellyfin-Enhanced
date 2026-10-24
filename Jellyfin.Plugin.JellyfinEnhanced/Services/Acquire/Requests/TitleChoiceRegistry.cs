using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Microsoft.Data.Sqlite;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    // Only this file constructs or changes owned choices. Inputs and authorization fields elsewhere
    // are request/display snapshots; a job's independent id/revision reference is its dispatch fence.
    internal sealed record TitleChoiceRecord(string Id, string Title, string Destination, Guid Owner, long Revision,
        int? ProfileId, string? RootFolder, int[] Tags, string? SeriesType, string? MinimumAvailability, bool Conflicted = false, bool Owned = true)
    {
        internal RequestChoice Wire => new(Owner, Revision, ProfileId, RootFolder);
    }

    internal enum TitleChoiceResult { Accepted, Conflict, StaleVersion }
    internal sealed record TitleChoiceDecision(TitleChoiceResult Result, TitleChoiceRecord? Current)
    {
        internal bool Accepted => Result == TitleChoiceResult.Accepted;
    }

    /// <summary>Durable title-wide add choices, independent of job authorization and scope.</summary>
    public sealed class TitleChoiceRegistry
    {
        private readonly AcquireDatabase _db;
        /// <summary>Uses the same transaction and restore boundary as the request ledger.</summary>
        public TitleChoiceRegistry(AcquireDatabase database) { _db = database; }

        /// <summary>The current choice for a job's title/destination, including alias conflicts.</summary>
        public RequestChoice? Current(RequestJob job) => _db.Read(c => Current(c, null, job.Input, job.Authorization)?.Wire);

        internal static bool HasChoice(MutationInput input) => input.ProfileId != null || input.RootFolder != null;
        internal static bool Differs(TitleChoiceRecord current, MutationInput proposed)
            => RequestDestination.ArrChoicesDiffer(current.ProfileId, current.RootFolder, proposed);
        internal static bool Conflicts(TitleChoiceRecord current, MutationInput proposed)
            => current.Conflicted || current.Owned && RequestDestination.ArrChoicesConflict(current.ProfileId, current.RootFolder, proposed);
        private static string Destination(MutationInput input, RequestAuthorization auth)
            => auth.InstanceId.ToLowerInvariant();

        internal static TitleChoiceRecord? Current(SqliteConnection c, SqliteTransaction? t, MutationInput input, RequestAuthorization auth)
        {
            using var cmd = RequestLedger.Cmd(c, t, "SELECT value FROM title_choices WHERE title=" + RequestLedger.CanonicalOf("$title") + " AND destination=$d",
                ("$title", input.Key), ("$d", Destination(input, auth)));
            return cmd.ExecuteScalar() is string json ? JsonSerializer.Deserialize<TitleChoiceRecord>(json) : null;
        }
        private static TitleChoiceRecord? ById(SqliteConnection c, SqliteTransaction? t, string? id)
        {
            using var cmd = RequestLedger.Cmd(c, t, "SELECT value FROM title_choices WHERE id=$id", ("$id", id));
            return cmd.ExecuteScalar() is string json ? JsonSerializer.Deserialize<TitleChoiceRecord>(json) : null;
        }
        private static TitleChoiceRecord Save(SqliteConnection c, SqliteTransaction t, TitleChoiceRecord record)
        {
            RequestLedger.Exec(c, t, "INSERT INTO title_choices(id,title,destination,value) VALUES($id,$title,$d,$v) ON CONFLICT(id) DO UPDATE SET title=$title,value=$v",
                ("$id", record.Id), ("$title", record.Title), ("$d", record.Destination), ("$v", JsonSerializer.Serialize(record)));
            return record;
        }
        // Claim never replaces a conflicting owned value. Identical choices retain owner and revision.
        internal static TitleChoiceDecision Claim(SqliteConnection c, SqliteTransaction t, MutationInput input, RequestAuthorization auth, Guid actor, ArrInstanceDefaults? defaults = null)
        {
            var current = Current(c, t, input, auth);
            var supplied = HasChoice(input);
            input = input with { ProfileId = input.ProfileId ?? current?.ProfileId ?? defaults?.QualityProfileId,
                RootFolder = input.RootFolder ?? current?.RootFolder ?? defaults?.RootFolderPath };
            if (current != null && Conflicts(current, input)) return new(TitleChoiceResult.Conflict, current);
            if (current != null && !Differs(current, input) && (current.Owned || !supplied)) return new(TitleChoiceResult.Accepted, current);
            var title = RequestLedger.Canonical(c, t, input.Key);
            return new(TitleChoiceResult.Accepted, Save(c, t, current == null
                ? new(RequestLedger.NewId(), title, Destination(input, auth), actor, 1, input.ProfileId ?? defaults?.QualityProfileId, input.RootFolder ?? defaults?.RootFolderPath,
                    defaults?.Tags.Distinct().OrderBy(x => x).ToArray() ?? Array.Empty<int>(), defaults?.SeriesType ?? "standard", defaults?.MinimumAvailability ?? "released", Owned: supplied)
                : current with { Owner = actor, Revision = current.Revision + 1, ProfileId = input.ProfileId ?? current.ProfileId, RootFolder = input.RootFolder ?? current.RootFolder, Owned = supplied || current.Owned }));
        }
        // A stale revision is a conflict even if the chosen values happen to match again (ABA).
        internal static TitleChoiceDecision Override(SqliteConnection c, SqliteTransaction t, MutationInput input, RequestAuthorization auth, long expectedRevision, Guid actor)
        {
            var current = Current(c, t, input, auth);
            if (current == null || current.Revision != expectedRevision) return new(TitleChoiceResult.StaleVersion, current);
            if (!current.Conflicted && !Differs(current, input)) return new(TitleChoiceResult.Accepted, current);
            return new(TitleChoiceResult.Accepted, Save(c, t, current with { Owner = actor, Revision = current.Revision + 1, ProfileId = input.ProfileId ?? current.ProfileId,
                RootFolder = input.RootFolder ?? current.RootFolder, Conflicted = false, Owned = true }));
        }
        internal static (MutationInput Input, RequestAuthorization Authorization, string? Id, long Revision) Bind(SqliteConnection c, SqliteTransaction t, MutationInput input, RequestAuthorization auth, ArrInstanceDefaults? defaults = null)
        {
            if (auth.Backend != "je") return (input, auth, null, 0);
            var decision = Claim(c, t, input, auth, auth.Approver ?? auth.Requester, defaults);
            if (!decision.Accepted) throw new InvalidOperationException("A conflicting title choice must be acknowledged before creating a job.");
            var record = decision.Current!;
            return (Apply(input, record), Snapshot(auth, record), record.Id, record.Revision);
        }
        internal static void Link(SqliteConnection c, SqliteTransaction t, string job, string? id, long revision)
            => RequestLedger.Exec(c, t, "UPDATE jobs SET title_choice_id=$choice,title_choice_revision=$v WHERE id=$id", ("$choice", id), ("$v", revision), ("$id", job));
        private static MutationInput Apply(MutationInput input, TitleChoiceRecord record)
            => input with { ProfileId = record.ProfileId, RootFolder = record.RootFolder };
        private static RequestAuthorization Snapshot(RequestAuthorization auth, TitleChoiceRecord record)
            => auth with { ChoiceOwner = record.Owner, ChoiceVersion = record.Revision };
        internal static RequestJob Display(SqliteConnection c, SqliteTransaction? t, RequestJob job)
        {
            // Older schema extensions read jobs before the registry migration runs.
            using (var exists = RequestLedger.Cmd(c, t, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='title_choices'"))
                if (Convert.ToInt32(exists.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture) == 0) return job;
            using (var cmd = RequestLedger.Cmd(c, t, "SELECT title_choice_id,title_choice_revision FROM jobs WHERE id=$id", ("$id", job.Id)))
            using (var r = cmd.ExecuteReader())
                if (r.Read()) job = job with { TitleChoiceId = r.IsDBNull(0) ? null : r.GetString(0), TitleChoiceRevision = r.GetInt64(1) };
            var record = ById(c, t, job.TitleChoiceId);
            return record == null || record.Revision != job.TitleChoiceRevision || record.Conflicted ? job
                : job with { Authorization = Snapshot(job.Authorization, record), TitleChoiceSettings = Defaults(c, t, job) };
        }
        internal static string? Check(SqliteConnection c, SqliteTransaction? t, RequestJob job)
        {
            if (job.Authorization.Backend != "je") return null;
            var current = Current(c, t, job.Input, job.Authorization);
            if (current == null || current.Conflicted || current.Id != job.TitleChoiceId || current.Revision != job.TitleChoiceRevision) return "choice_conflict";
            // A cache edited outside this owner cannot become a dispatch instruction.
            var settings = job.TitleChoiceSettings;
            return !RequestDestination.SameArrChoices(job.Input, current.ProfileId, current.RootFolder) || settings == null ||
                !settings.Tags.SequenceEqual(current.Tags) || settings.SeriesType != current.SeriesType || settings.MinimumAvailability != current.MinimumAvailability
                ? "choice_conflict" : null;
        }
        /// <summary>Checks the live record/revision before each dispatch write.</summary>
        public string? Check(RequestJob job) => _db.Read(c => Check(c, null, job));

        internal static ArrInstanceDefaults Settings(PluginConfiguration? config, string instance)
        {
            var row = config?.GetSonarrInstances().Concat(config.GetRadarrInstances()).FirstOrDefault(i => RequestDestination.SameInstance(i.Id, instance));
            var saved = row?.Defaults;
            return new ArrInstanceDefaults
            {
                QualityProfileId = saved?.QualityProfileId, RootFolderPath = saved?.RootFolderPath,
                Tags = saved?.Tags.Distinct().OrderBy(x => x).ToList() ?? new List<int>(),
                SeriesType = ArrAddRules.SeriesTypes.FirstOrDefault(x => string.Equals(x, saved?.SeriesType, StringComparison.OrdinalIgnoreCase)) ?? (row?.Role == ArrInstanceRole.Anime ? "anime" : "standard"),
                MinimumAvailability = ArrAddRules.Availability.FirstOrDefault(x => string.Equals(x, saved?.MinimumAvailability, StringComparison.OrdinalIgnoreCase)) ?? "released",
            };
        }
        internal static ArrInstanceDefaults? Defaults(SqliteConnection c, SqliteTransaction? t, RequestJob job)
        {
            var record = ById(c, t, job.TitleChoiceId);
            return record == null ? null : new ArrInstanceDefaults { Tags = record.Tags.ToList(), SeriesType = record.SeriesType, MinimumAvailability = record.MinimumAvailability };
        }
        /// <summary>The title-wide tag/type settings frozen when the choice was claimed.</summary>
        public ArrInstanceDefaults? Defaults(RequestJob job) => _db.Read(c => Defaults(c, null, job));

        // Identity learning is not a choice override. Collapse references but invalidate every old revision
        // when independently owned values differ. Even choosing the apparent winner requires confirmation.
        internal static void Reconcile(SqliteConnection c, SqliteTransaction t, IReadOnlyList<string> aliases)
        {
            var all = new List<TitleChoiceRecord>();
            using (var cmd = RequestLedger.Cmd(c, t, "SELECT value FROM title_choices"))
            using (var r = cmd.ExecuteReader())
                while (r.Read()) { var record = JsonSerializer.Deserialize<TitleChoiceRecord>(r.GetString(0))!; if (aliases.Contains(record.Title)) all.Add(record); }
            foreach (var group in all.GroupBy(x => x.Destination))
            {
                var records = group.OrderByDescending(x => x.Owned).ThenBy(x => x.Title == aliases[0] ? 0 : 1).ThenBy(x => x.Id, StringComparer.Ordinal).ToArray();
                var survivor = records[0];
                var different = records.Any(x => !SameValues(x, survivor) || x.Conflicted);
                var revision = records.Max(x => x.Revision) + (different ? 1 : 0);
                foreach (var other in records.Skip(1))
                {
                    RequestLedger.Exec(c, t, "UPDATE jobs SET title_choice_id=$to WHERE title_choice_id=$from", ("$to", survivor.Id), ("$from", other.Id));
                    RequestLedger.Exec(c, t, "DELETE FROM title_choices WHERE id=$id", ("$id", other.Id));
                }
                Save(c, t, survivor with { Title = aliases[0], Revision = revision, Conflicted = different });
                if (!different)
                    RequestLedger.Exec(c, t, "UPDATE jobs SET title_choice_revision=$v WHERE title_choice_id=$id", ("$v", revision), ("$id", survivor.Id));
            }
        }
        private static bool SameValues(TitleChoiceRecord a, TitleChoiceRecord b)
            => a.ProfileId == b.ProfileId && a.RootFolder == b.RootFolder && a.Tags.SequenceEqual(b.Tags) && a.SeriesType == b.SeriesType && a.MinimumAvailability == b.MinimumAvailability;

        // Cancellation does not release ownership: retain the revision tombstone to prevent stale-sheet ABA.
        // The record intentionally outlives retained job history, including held work and account deletion.
        internal static bool NeedsMigration(SqliteConnection c)
        {
            using var exists = RequestLedger.Cmd(c, null, "SELECT COUNT(*) FROM sqlite_master WHERE name='title_choices'");
            if (Convert.ToInt32(exists.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture) == 0)
            {
                using var jobs = RequestLedger.Cmd(c, null, "SELECT COUNT(*) FROM jobs");
                return Convert.ToInt32(jobs.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture) > 0;
            }
            return false;
        }
        internal static void Ensure(SqliteConnection c)
        {
            using var t = c.BeginTransaction(deferred: false);
            RequestLedger.Exec(c, t, "CREATE TABLE IF NOT EXISTS title_choices(id TEXT PRIMARY KEY,title TEXT NOT NULL,destination TEXT NOT NULL,value TEXT NOT NULL,UNIQUE(title,destination))");
            using (var columns = RequestLedger.Cmd(c, t, "SELECT COUNT(*) FROM pragma_table_info('jobs') WHERE name='title_choice_id'"))
                if (Convert.ToInt32(columns.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture) == 0)
                {
                    RequestLedger.Exec(c, t, "ALTER TABLE jobs ADD COLUMN title_choice_id TEXT");
                    RequestLedger.Exec(c, t, "ALTER TABLE jobs ADD COLUMN title_choice_revision INTEGER NOT NULL DEFAULT 0");
                }
            var legacy = new List<(string Id, MutationInput Input, RequestAuthorization Auth, string State, bool Uncertain)>();
            using (var cmd = RequestLedger.Cmd(c, t, "SELECT id,mutation_input,authorization_context,state,COALESCE(json_extract(outcome,'$.certainty')='Unknown',0) FROM jobs WHERE title_choice_id IS NULL AND json_extract(authorization_context,'$.Backend')='je'"))
            using (var r = cmd.ExecuteReader())
                while (r.Read()) legacy.Add((r.GetString(0), JsonSerializer.Deserialize<MutationInput>(r.GetString(1))!, JsonSerializer.Deserialize<RequestAuthorization>(r.GetString(2))!, r.GetString(3), r.GetBoolean(4)));
            foreach (var group in legacy.GroupBy(j => (Title: RequestLedger.Canonical(c, t, j.Input.Key), Destination: Destination(j.Input, j.Auth))))
            {
                var winner = group.OrderBy(j => j.State == "succeeded" ? 0 : j.State is "queued" or "retry" && !j.Uncertain ? 1 : j.State == "cancelled" ? 3 : 2)
                    .ThenByDescending(j => HasChoice(j.Input)).ThenByDescending(j => Math.Max(1, j.Auth.ChoiceVersion)).ThenBy(j => j.State == "cancelled").ThenBy(j => j.Id, StringComparer.Ordinal).First();
                var config = JellyfinEnhanced.Instance?.Configuration;
                var defaults = Settings(config, winner.Auth.InstanceId);
                var maximum = group.Max(j => Math.Max(1, j.Auth.ChoiceVersion));
                var conflictingFence = group.Where(j => Math.Max(1, j.Auth.ChoiceVersion) == maximum).Any(j =>
                    HasChoice(j.Input) && !RequestDestination.SameArrChoices(j.Input, winner.Input.ProfileId, winner.Input.RootFolder));
                var revision = maximum + (conflictingFence ? 1 : 0);
                var record = Current(c, t, winner.Input, winner.Auth) ?? Save(c, t, new(RequestLedger.NewId(), group.Key.Title, group.Key.Destination,
                    winner.Auth.ChoiceOwner ?? winner.Auth.Approver ?? winner.Auth.Requester, revision, winner.Input.ProfileId ?? defaults?.QualityProfileId, winner.Input.RootFolder ?? defaults?.RootFolderPath,
                    defaults?.Tags.Distinct().OrderBy(x => x).ToArray() ?? Array.Empty<int>(), defaults?.SeriesType, defaults?.MinimumAvailability, Owned: HasChoice(winner.Input)));
                foreach (var job in group)
                {
                    if (HasChoice(job.Input) && !RequestDestination.SameArrChoices(job.Input, record.ProfileId, record.RootFolder))
                        RequestLedger.Exec(c, t, "INSERT INTO request_audit(id,want_id,job_id,actor_id,action,outcome,reason,created_at) SELECT $id,want_id,id,NULL,'choice_migration','accepted','discarded_legacy_choice',$at FROM jobs WHERE id=$j",
                            ("$id", RequestLedger.NewId()), ("$at", RequestLedger.Ms(DateTimeOffset.UtcNow)), ("$j", job.Id));
                    var immutable = job.State is "cancelled" or "succeeded" or "sending" or "maybe_sent" || job.Uncertain;
                    var input = immutable ? job.Input : Apply(job.Input, record);
                    var admitted = job.State != "cancelled" && RequestDestination.SameArrChoices(input, record.ProfileId, record.RootFolder);
                    RequestLedger.Exec(c, t, "UPDATE jobs SET title_choice_id=$choice,title_choice_revision=$v,mutation_input=$input,fingerprint=$f WHERE id=$id",
                        ("$choice", record.Id), ("$v", admitted ? record.Revision : 0), ("$input", input.Canonical), ("$f", input.Fingerprint), ("$id", job.Id));
                }
            }
            t.Commit();
        }
    }
}
