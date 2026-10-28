using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>What a migration would do with the requests Seerr holds.</summary>
    /// <param name="Items">Requests that become JE wants.</param>
    /// <param name="Skipped">Requests left out, by reason.</param>
    public sealed record SeerrMigrationPlan(IReadOnlyList<ImportCandidate> Items, IReadOnlyDictionary<string, int> Skipped)
    {
        /// <summary>Pending requests to import (they wait for a JE OK).</summary>
        public int Pending => Items.Count(i => i.Pending);
        /// <summary>Processing requests to import (linked to the title, no new write).</summary>
        public int Processing => Items.Count(i => !i.Pending);
    }

    /// <summary>Admin-facing migration answer: counts and codes only, never addresses, keys or titles.</summary>
    public sealed record SeerrMigrationReply
    {
        // Only the service's completed durable command can issue this acknowledgement. It is never
        // deserialized or exposed as a reusable provider fact; previews/refusals retain the read fence.
        [JsonIgnore] internal bool CommittedHistory { get; init; }

        /// <summary>accepted, or a refusal outcome.</summary>
        [JsonPropertyName("outcome")] public string Outcome { get; init; } = "accepted";
        /// <summary>Stable reason code.</summary>
        [JsonPropertyName("reason")] public string Reason { get; init; } = "preview";
        /// <summary>Plain admin wording.</summary>
        [JsonPropertyName("message")] public string Message { get; init; } = string.Empty;
        /// <summary>HTTP status of the answer.</summary>
        [JsonIgnore] public int HttpStatus { get; init; } = 200;
        /// <summary>The request handling in use now.</summary>
        [JsonPropertyName("backend")] public string Backend { get; init; } = "seerr";
        /// <summary>Every Seerr request was read.</summary>
        [JsonPropertyName("complete")] public bool Complete { get; init; }
        /// <summary>Why the read was incomplete.</summary>
        [JsonPropertyName("incompleteReason")] public string? IncompleteReason { get; init; }
        /// <summary>Seerr's request total.</summary>
        [JsonPropertyName("total")] public int Total { get; init; }
        /// <summary>The digest the commit must match.</summary>
        [JsonPropertyName("digest")] public string? Digest { get; init; }
        /// <summary>Pending requests that would wait for a JE OK.</summary>
        [JsonPropertyName("pending")] public int Pending { get; init; }
        /// <summary>Processing requests that would be linked.</summary>
        [JsonPropertyName("processing")] public int Processing { get; init; }
        /// <summary>Pending requests from people whose household role (Watcher) can't ask in JE: they need a role before an approval.</summary>
        [JsonPropertyName("pendingWithoutRole")] public int PendingWithoutRole { get; init; }
        /// <summary>Requests left out, by reason.</summary>
        [JsonPropertyName("skipped")] public IReadOnlyDictionary<string, int> Skipped { get; init; } = new Dictionary<string, int>();
        /// <summary>Whether people can still ask in Seerr: disabled, enabled or unknown.</summary>
        [JsonPropertyName("seerrRequesting")] public string SeerrRequesting { get; init; } = "unknown";
        /// <summary>Non-admin Seerr users who can still ask.</summary>
        [JsonPropertyName("requestingUsers")] public int RequestingUsers { get; init; }
        /// <summary>Seerr administrators (they can always ask in Seerr).</summary>
        [JsonPropertyName("seerrAdmins")] public int SeerrAdmins { get; init; }
        /// <summary>New Seerr users would be allowed to ask.</summary>
        [JsonPropertyName("defaultAllowsRequests")] public bool DefaultAllowsRequests { get; init; }
        /// <summary>The batch created by a commit.</summary>
        [JsonPropertyName("batchId")] public string? BatchId { get; init; }
        /// <summary>Wants created by a commit.</summary>
        [JsonPropertyName("imported")] public int Imported { get; init; }
        /// <summary>Wants removed by a rollback.</summary>
        [JsonPropertyName("removed")] public int Removed { get; init; }
        /// <summary>Wants a rollback kept because they were changed in JE after the import.</summary>
        [JsonPropertyName("kept")] public int Kept { get; init; }
        /// <summary>The newest batches.</summary>
        [JsonPropertyName("batches")] public IReadOnlyList<object>? Batches { get; init; }

        /// <summary>A refusal with a status and plain wording.</summary>
        public static SeerrMigrationReply Refused(string reason, int status, string message, string backend = "seerr")
            => new() { Outcome = status == 503 ? "unavailable" : "denied", Reason = reason, HttpStatus = status, Message = message, Backend = backend };
    }

    /// <summary>
    /// The Seerr to JE authority transfer: a dry run first, then an import that is complete or nothing and
    /// refuses when Seerr changed since the dry run, when the read was incomplete, or while people can still
    /// ask in Seerr. Imported pending requests wait in JE's Approvals; processing ones link to their title with
    /// no new write. The request handling then switches to Jellyfin Enhanced. A batch can be rolled back for
    /// 14 days, newest first; wants changed in JE since the import are kept. While a move runs, JE's own Seerr
    /// request writes are held off (<see cref="SeerrRequestWriteFence"/>).
    /// </summary>
    public sealed class SeerrMigration
    {
        /// <summary>How long a batch can be rolled back.</summary>
        public static readonly TimeSpan RollbackWindow = TimeSpan.FromDays(14);

        /// <summary>How long a move waits for JE's Seerr request writes already in flight to finish.</summary>
        internal static readonly TimeSpan DrainWait = TimeSpan.FromSeconds(30);

        private readonly SeerrFacts _reader;
        private readonly RequestLedger _ledger;
        private readonly IRequestPolicy _policy;
        private readonly IArrJellyfinView _view;
        private readonly TitleAliases? _aliases;
        private readonly ArrChangeFeed _feed;
        private readonly Func<PluginConfiguration> _config;
        private readonly Action _save;
        private readonly Func<DateTimeOffset> _now;
        private readonly SeerrRequestWriteFence _fence;
        private readonly SemaphoreSlim _gate = new(1, 1);

        /// <summary>Creates the migration service (DI).</summary>
        public SeerrMigration(SeerrFacts reader, RequestLedger ledger, IRequestPolicy policy, IArrJellyfinView view, TitleAliases aliases, ArrChangeFeed feed, SeerrRequestWriteFence fence)
            : this(reader, ledger, policy, view, aliases, feed, () => JellyfinEnhanced.Instance?.Configuration ?? new PluginConfiguration(),
                () => JellyfinEnhanced.Instance?.SaveConfiguration(), () => DateTimeOffset.UtcNow, fence)
        {
        }

        /// <param name="config">Reads the live configuration (a config-page save replaces the object).</param>
        internal SeerrMigration(SeerrFacts reader, RequestLedger ledger, IRequestPolicy policy, IArrJellyfinView view, TitleAliases? aliases, ArrChangeFeed feed,
            Func<PluginConfiguration> config, Action save, Func<DateTimeOffset> now, SeerrRequestWriteFence? fence = null)
        {
            _reader = reader; _ledger = ledger; _policy = policy; _view = view; _aliases = aliases; _feed = feed; _config = config; _save = save; _now = now;
            _fence = fence ?? new SeerrRequestWriteFence();
        }

        /// <summary>Test hook: runs between the import and the switch (a crash there leaves the batch, not the switch).</summary>
        internal Action? BeforeSwitch { get; set; }

        /// <summary>
        /// Sets request handling on the live configuration and saves it, under the lock the configuration
        /// swap of a config-page save takes, so neither can overwrite the other; the saved value is read back.
        /// False (with the value put back) when it couldn't be saved, and (with nothing changed) when
        /// <paramref name="addresses"/> is given and the live Seerr address set no longer matches it.
        /// </summary>
        private bool Switch(string backend, string? addresses = null)
        {
            var switched = false;
            // Commit/rollback are backend writers too. The import's own retained effect is released
            // before this call; drain all other old work before taking the configuration lock.
            Backends.EffectiveRequestsBackend.Shared.TransitionAsync(() => EvidenceRevision.Advance(() =>
            {
                lock (JellyfinEnhanced.AnalyticsCredentialLock)
                {
                    var live = _config();
                    if (addresses != null && SeerrFacts.AddressFingerprint(live) != addresses) return;
                    // A move (the handover that carries the Seerr address set its requests were read from) hands over only
                    // while Seerr is still on, decided under the same lock as the write.
                    if (addresses != null && !Backends.EffectiveRequestsBackend.SeerrUsable(live)) return;
                    var before = live.ArrRequestBackend;
                    if (before == backend) { switched = true; return; }
                    live.ArrRequestBackend = backend;
                    try
                    {
                        _save();
                    }
                    catch (Exception)
                    {
                        live.ArrRequestBackend = before;
                        return;
                    }
                    switched = _config().ArrRequestBackend == backend;
                }
            }), CancellationToken.None, () =>
            {
                lock (JellyfinEnhanced.AnalyticsCredentialLock)
                {
                    var live = _config();
                    return live.ArrRequestBackend != backend
                        && (addresses == null || SeerrFacts.AddressFingerprint(live) == addresses);
                }
            }).GetAwaiter().GetResult();
            return switched;
        }

        private static string Handling(string backend) => backend switch
        {
            "je" => "request handling stays Jellyfin Enhanced",
            "status_only" => "request handling is back to Status only",
            _ => "request handling is back to Seerr",
        };

        private static bool PhaseOn(PluginConfiguration c) => c.ArrIntegrationEnabled && c.ArrPhase1Enabled && c.ArrPhase3Enabled;

        private SeerrMigrationReply? Gate(PluginConfiguration config)
        {
            if (!PhaseOn(config)) return SeerrMigrationReply.Refused("feature_disabled", 403, "Turn on \"Ask for it\" (phase 3) and save first.", config.ArrRequestBackend);
            if (config.ArrRequestBackend is not ("seerr" or "je")) return SeerrMigrationReply.Refused("backend_status_only", 409, "Request handling is \"Status only\"; choose Seerr first.", config.ArrRequestBackend);
            // Seerr off (switched off, not set up, or excluded by backend isolation): nothing is read from it or moved. The
            // gate runs before the read and again before anything is written, so turning Seerr off mid-move stops it too.
            if (!Backends.EffectiveRequestsBackend.SeerrUsable(config)) return SeerrMigrationReply.Refused("seerr_off", 409, "Seerr is off; turn it on (Seerr tab) to move its requests.", config.ArrRequestBackend);
            if (!_ledger.Database.Available) return SeerrMigrationReply.Refused("database_unavailable", 503, "The Requests & downloads database is unavailable.", config.ArrRequestBackend);
            return null;
        }

        /// <summary>
        /// Classifies Seerr's requests: pending (and failed, which never reached Sonarr/Radarr) wait for a JE OK,
        /// approved ones still in progress are linked; declined, completed and available ones, unmapped people,
        /// unreadable rows and requests already imported from this source are left out.
        /// </summary>
        /// <param name="read">A complete read.</param>
        /// <param name="userExists">Whether a Jellyfin user exists and may sign in.</param>
        /// <param name="canonical">Canonical title key (TMDB/TVDB aliases); identity when unknown.</param>
        /// <param name="alreadyImported">Request ids already imported from this source.</param>
        public static SeerrMigrationPlan Plan(SeerrMigrationRead read, Func<Guid, bool> userExists, Func<TitleKey, TitleKey> canonical, IReadOnlySet<int> alreadyImported)
        {
            var items = new List<ImportCandidate>();
            var skipped = new Dictionary<string, int>(StringComparer.Ordinal);
            void Skip(string reason) => skipped[reason] = skipped.GetValueOrDefault(reason) + 1;
            foreach (var _ in read.Unreadable) Skip("unreadable");
            foreach (var row in read.Rows)
            {
                if (alreadyImported.Contains(row.Id)) { Skip("already_imported"); continue; }
                switch (row.Status)
                {
                    case SeerrRequestStatus.Declined: Skip("declined"); continue;
                    case SeerrRequestStatus.Completed: Skip("completed"); continue;
                    case SeerrRequestStatus.Approved when row.MediaStatus == 5: Skip("available"); continue;
                    case SeerrRequestStatus.Pending or SeerrRequestStatus.Approved or SeerrRequestStatus.Failed: break;
                    default: Skip("unreadable"); continue;
                }
                if (row.RequestedBy is not Guid user || !userExists(user)) { Skip("unmapped_user"); continue; }
                var key = row.IsMovie ? TitleKey.ForMovie(row.TmdbId?.ToString(System.Globalization.CultureInfo.InvariantCulture), row.ImdbId)
                    : TitleKey.ForSeries(row.TvdbId?.ToString(System.Globalization.CultureInfo.InvariantCulture), row.TmdbId?.ToString(System.Globalization.CultureInfo.InvariantCulture), row.ImdbId);
                if (key == null || (!row.IsMovie && row.Seasons.Count == 0)) { Skip("unreadable"); continue; }
                var input = new MutationInput
                {
                    Key = canonical(key).ToString(), Scope = row.IsMovie ? "movie" : "seasons", Variant = row.Is4k ? "4k" : "standard",
                    Seasons = row.IsMovie ? Array.Empty<int>() : row.Seasons.ToArray(),
                }.Normalize();
                if (input == null) { Skip("unreadable"); continue; }
                var asked = row.CreatedAt is DateTime created ? new DateTimeOffset(DateTime.SpecifyKind(created, DateTimeKind.Utc)) : DateTimeOffset.MinValue;
                items.Add(new ImportCandidate(user, row.Id, input, row.Status != SeerrRequestStatus.Approved, asked));
            }
            return new SeerrMigrationPlan(items, skipped);
        }

        private SeerrMigrationPlan PlanFor(SeerrMigrationRead read)
            => Plan(read, user => _view.Viewer(user) != null, key => RequestTitleIdentity.Held(_ledger, _aliases, key), _ledger.ImportedRequestIds(_ledger.FindOriginSource(read.AddressFingerprint)));

        private static SeerrMigrationReply Describe(SeerrMigrationRead read, SeerrMigrationPlan? plan, string backend, string reason, string message) => new()
        {
            Reason = reason, Message = message, Backend = backend, Complete = read.Complete, IncompleteReason = read.IncompleteReason, Total = read.Total,
            Digest = read.Complete ? read.Digest : null, Pending = plan?.Pending ?? 0, Processing = plan?.Processing ?? 0,
            Skipped = plan?.Skipped ?? new Dictionary<string, int>(), SeerrRequesting = read.Requesting.State, RequestingUsers = read.Requesting.RequestingUsers,
            SeerrAdmins = read.Requesting.Admins, DefaultAllowsRequests = read.Requesting.DefaultAllowsRequests,
        };

        /// <summary>The dry run: reads Seerr completely and says what a commit would do. Writes nothing.</summary>
        public async Task<SeerrMigrationReply> PreviewAsync(CancellationToken ct)
        {
            var config = _config();
            if (Gate(config) is { } refused) return refused;
            if (!await _gate.WaitAsync(0, ct).ConfigureAwait(false)) return SeerrMigrationReply.Refused("migration_busy", 409, "A move is already running.", config.ArrRequestBackend);
            try
            {
                var read = await _reader.ReadAsync(config, ct).ConfigureAwait(false);
                if (!read.Complete) return Describe(read, null, config.ArrRequestBackend, "seerr_read_incomplete", "Seerr's request list could not be read completely; nothing can be moved yet.");
                var plan = PlanFor(read);
                // Watchers can't ask in JE, so their moved asks couldn't be approved until they get a role.
                var withoutRole = plan.Items.Where(i => i.Pending).Count(i => _policy.Evaluate(i.UserId, i.Input).Role == "Watcher");
                return Describe(read, plan, config.ArrRequestBackend, "preview", "Nothing has changed yet.") with { PendingWithoutRole = withoutRole };
            }
            finally
            {
                _gate.Release();
            }
        }

        /// <summary>
        /// Imports and switches. Refuses when the fresh read is incomplete, when its digest differs from the dry
        /// run's, while people can still ask in Seerr, or (when Seerr's settings can't be read) without the
        /// administrator's confirmation that requesting is off in Seerr. Re-running it is safe: requests already
        /// imported from the same Seerr are skipped.
        /// </summary>
        /// <param name="actor">The administrator.</param>
        /// <param name="digest">The dry run's digest.</param>
        /// <param name="confirmRequestsDisabled">The administrator confirms requesting is off in Seerr (needed only when it can't be checked).</param>
        /// <param name="ct">Cancellation.</param>
        public async Task<SeerrMigrationReply> CommitAsync(Guid actor, string? digest, bool confirmRequestsDisabled, CancellationToken ct)
        {
            var config = _config();
            if (Gate(config) is { } refused) return refused;
            if (string.IsNullOrWhiteSpace(digest) || digest.Length > 128) return SeerrMigrationReply.Refused("invalid_input", 400, "Run the check first.", config.ArrRequestBackend);
            if (!await _gate.WaitAsync(0, ct).ConfigureAwait(false)) return SeerrMigrationReply.Refused("migration_busy", 409, "A move is already running.", config.ArrRequestBackend);
            try
            {
                // JE's own Seerr request writes wait until the move is done (the ones in flight finish first).
                using var move = await _fence.BeginMoveAsync(DrainWait, ct).ConfigureAwait(false);
                if (move == null) return SeerrMigrationReply.Refused("seerr_writes_in_flight", 409, "Requests are being sent to Seerr right now; try again in a moment.", config.ArrRequestBackend);
                using var effect = SeerrFacts.BeginEffect(ct);
                var read = await _reader.ReadAsync(config, ct).ConfigureAwait(false);
                if (!read.Complete) return Describe(read, null, config.ArrRequestBackend, "seerr_read_incomplete", "Seerr's request list could not be read completely; nothing was moved.") with { Outcome = "unavailable", HttpStatus = 409 };
                if (!string.Equals(read.Digest, digest, StringComparison.Ordinal))
                    return Describe(read, PlanFor(read), config.ArrRequestBackend, "seerr_changed", "Seerr's requests changed since the check; check again.") with { Outcome = "denied", HttpStatus = 409 };
                if (read.Requesting.State == "enabled")
                    return Describe(read, PlanFor(read), config.ArrRequestBackend, "seerr_requests_enabled", "People can still ask in Seerr. Remove the request permissions in Seerr first.") with { Outcome = "denied", HttpStatus = 409 };
                if (read.Requesting.State != "disabled" && !confirmRequestsDisabled)
                    return Describe(read, PlanFor(read), config.ArrRequestBackend, "seerr_requests_unknown", "Seerr's permissions could not be checked. Confirm that requesting is off in Seerr.") with { Outcome = "denied", HttpStatus = 409 };
                var sourceId = _ledger.OriginSource(read.AddressFingerprint);
                var plan = Plan(read, user => _view.Viewer(user) != null, key => RequestTitleIdentity.Held(_ledger, _aliases, key), _ledger.ImportedRequestIds(sourceId));
                var targets = new Dictionary<(bool, string), string>();
                string Target(MutationInput input)
                {
                    var movie = TitleKey.Parse(input.Key)!.IsMovie;
                    if (!targets.TryGetValue((movie, input.Variant), out var target))
                    {
                        // The instance a JE-mode request of this kind and edition goes to (independent of the person).
                        var probe = movie ? new MutationInput { Key = "movie:tmdb:1", Variant = input.Variant } : new MutationInput { Key = "tv:tvdb:1", Scope = "seasons", Seasons = new[] { 1 }, Variant = input.Variant };
                        // Asked of the JE target itself: while Seerr still handles requests the person's facts carry no instance.
                        var (instanceId, generation) = _policy.JeTarget(actor, probe);
                        targets[(movie, input.Variant)] = target = RequestLedger.TargetKey(new RequestAuthorization(actor, null, "request", probe.Scope, probe.Variant, "je", instanceId, generation, string.Empty));
                    }
                    return target;
                }
                var now = _now();
                string previous;
                ImportResult result;
                // The last capability check and the first durable write hold the lock every configuration write takes
                // (a config-page save, a PATCH, the switch below): a save that turns Seerr off lands either before the
                // check (refused, nothing written) or after the import (the switch then refuses and undoes it).
                lock (JellyfinEnhanced.AnalyticsCredentialLock)
                {
                    // The live configuration (a config-page save during the read replaced the object read above).
                    var live = _config();
                    if (Gate(live) is { } changed) return changed;
                    // The requests just read belong to the Seerr address they were read from; a save that pointed JE
                    // at another Seerr meanwhile would hand authority over without that Seerr's requests.
                    if (SeerrFacts.AddressFingerprint(live) != read.AddressFingerprint) return AddressChanged(live.ArrRequestBackend);
                    // A move while JE already handles requests (a second pass) records "je": rolling it back
                    // removes its wants and leaves request handling as it is.
                    previous = live.ArrRequestBackend;
                    // Each title's other ids first (Seerr's requests carry them), so an import meets the title's requests in JE
                    // whichever id either was asked by (one identity: RequestTitleIdentity).
                    foreach (var key in plan.Items.Select(i => i.Input.Key).Distinct(StringComparer.Ordinal)) RequestTitleIdentity.Learn(_ledger, _policy, _aliases, _feed, key, now);
                    result = _ledger.ImportSeerr(sourceId, read.Digest, plan.Items, plan.Skipped, actor, previous, Target, now, RollbackWindow);
                }
                // Imported history is durable now. Release our fact admission before our own adoption drains.
                effect.Dispose();
                var switched = false;
                try
                {
                    BeforeSwitch?.Invoke();
                    switched = Switch("je", read.AddressFingerprint);
                }
                catch (Exception)
                {
                    switched = false;
                }
                if (!switched)
                {
                    // The switch failed (or Seerr was turned off meanwhile): undo this batch so Seerr stays the authority
                    // with nothing half moved.
                    if (result.BatchId != null) _ledger.RollbackImport(result.BatchId, now);
                    if (!Backends.EffectiveRequestsBackend.SeerrUsable(_config())) return SeerrMigrationReply.Refused("seerr_off", 409, "Seerr was turned off during the move; nothing was moved.", _config().ArrRequestBackend);
                    if (SeerrFacts.AddressFingerprint(_config()) != read.AddressFingerprint) return AddressChanged(_config().ArrRequestBackend);
                    return SeerrMigrationReply.Refused("switch_failed", 503, "Request handling could not be switched; nothing was moved.", _config().ArrRequestBackend);
                }
                Announce(result.BatchId);
                return Describe(read, plan, "je", "migrated", result.Imported == 0 ? "Nothing new to move; request handling is Jellyfin Enhanced."
                    : previous == "je" ? "Requests moved; request handling stays Jellyfin Enhanced." : "Requests moved; request handling is now Jellyfin Enhanced.")
                    with { BatchId = result.BatchId, Imported = result.Imported, Skipped = result.Skipped, CommittedHistory = true };
            }
            finally
            {
                _gate.Release();
            }
        }

        private static SeerrMigrationReply AddressChanged(string backend)
            => SeerrMigrationReply.Refused("seerr_changed", 409, "The Seerr address changed during the move; nothing was moved. Check again.", backend);

        private static SeerrMigrationReply? RollbackRefused(string? reason, string backend) => reason switch
        {
            null => null,
            "not_found" => SeerrMigrationReply.Refused("not_found", 404, "Unknown batch.", backend),
            "rollback_expired" => SeerrMigrationReply.Refused(reason, 409, "The 14-day rollback window has passed.", backend),
            "newer_batch" => SeerrMigrationReply.Refused(reason, 409, "A later move is still in place; roll that one back first.", backend),
            _ => SeerrMigrationReply.Refused(reason, 409, "This batch was already rolled back.", backend),
        };

        /// <summary>
        /// Rolls a batch back (within 14 days, newest first) and returns request handling to what it was
        /// before that move. Request handling is switched and saved first: when that fails nothing changes,
        /// and once it is saved the batch stays in place until its wants are removed, so a retry (or one after
        /// a crash) finishes the rollback.
        /// </summary>
        /// <param name="batchId">The batch.</param>
        public SeerrMigrationReply Rollback(string? batchId)
        {
            var config = _config();
            if (!_ledger.Database.Available) return SeerrMigrationReply.Refused("database_unavailable", 503, "The Requests & downloads database is unavailable.", config.ArrRequestBackend);
            if (string.IsNullOrEmpty(batchId) || !Guid.TryParseExact(batchId, "N", out _)) return SeerrMigrationReply.Refused("invalid_id", 400, "Unknown batch.", config.ArrRequestBackend);
            if (!_gate.Wait(0)) return SeerrMigrationReply.Refused("migration_busy", 409, "A move is already running.", config.ArrRequestBackend);
            try
            {
                var now = _now();
                var check = _ledger.CheckRollback(batchId, now);
                if (RollbackRefused(check.Reason, _config().ArrRequestBackend) is { } refused) return refused;
                var users = _ledger.ImportUsers(batchId);
                var target = _config().ArrRequestBackend == "je" && check.PreviousBackend is "seerr" or "status_only" ? check.PreviousBackend : null;
                if (target != null && !Switch(target))
                    return SeerrMigrationReply.Refused("switch_failed", 503, "Request handling could not be switched back; nothing was rolled back.", _config().ArrRequestBackend);
                ImportRollback result;
                try
                {
                    result = _ledger.RollbackImport(batchId, now);
                }
                catch (Exception)
                {
                    return SeerrMigrationReply.Refused("rollback_failed", 503, target == null
                        ? "The moved requests could not be removed; nothing was rolled back. Try again."
                        : "Request handling is switched back, but the moved requests could not be removed yet; roll back again.", _config().ArrRequestBackend);
                }
                if (RollbackRefused(result.Reason, _config().ArrRequestBackend) is { } late) return late;
                _feed.Bump(users.Select(ArrTitleKey.UserRequests).Append(ArrTitleKey.RequestsState).ToArray());
                var backend = _config().ArrRequestBackend;
                return new SeerrMigrationReply
                {
                    Reason = "rolled_back", Backend = backend, Removed = result.Removed, Kept = result.Kept, CommittedHistory = true,
                    Message = (result.Kept == 0 ? "Moved requests removed; " : "Moved requests removed, except those changed in Jellyfin Enhanced since; ") + Handling(backend) + ".",
                };
            }
            finally
            {
                _gate.Release();
            }
        }

        /// <summary>The current request handling and the newest batches with their rollback deadline.</summary>
        public SeerrMigrationReply Status()
        {
            var config = _config();
            var now = _now();
            var newest = _ledger.ImportBatches(5);
            // Newest first: a batch can be rolled back only while no later move is still in place.
            var batches = newest.Select((b, i) => (object)new
            {
                id = b.Id, createdAt = b.CreatedAt, imported = b.Imported, state = b.State, rollbackUntil = b.RollbackUntil,
                canRollBack = b.State == "committed" && now <= b.RollbackUntil && !newest.Take(i).Any(n => n.State == "committed"),
                // The request handling a rollback returns to (je: a later move made while JE already handled requests).
                returnsTo = b.PreviousBackend,
                rolledBackAt = b.RolledBackAt, removed = b.Removed, kept = b.Kept,
            }).ToList();
            return new SeerrMigrationReply { Reason = "status", Backend = config.ArrRequestBackend, Batches = batches, Message = PhaseOn(config) ? string.Empty : "Ask for it (phase 3) is off." };
        }

        private void Announce(string? batchId)
        {
            if (batchId == null) { _feed.Bump(new[] { ArrTitleKey.RequestsState }); return; }
            var keys = _ledger.ImportUsers(batchId).Select(ArrTitleKey.UserRequests).Append(ArrTitleKey.RequestsState).ToList();
            if (keys.Count > ArrChangeFeed.MaxKeysPerRead) _feed.ResetAll();
            else _feed.Bump(keys);
        }
    }
}
