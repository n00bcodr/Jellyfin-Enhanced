using System;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>Server request orchestration; all mutation policy checks are repeated inside ledger transactions.</summary>
    public sealed class RequestService
    {
        private readonly RequestLedger _ledger;
        private readonly IRequestPolicy _policy;
        private readonly ArrChangeFeed _feed;
        private readonly TitleAliases? _aliases;
        private readonly Func<DateTimeOffset> _now;
        private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };
        /// <summary>Creates request orchestration.</summary>
        public RequestService(RequestLedger ledger, IRequestPolicy policy, IArrJellyfinView view, ArrChangeFeed feed, TitleAliases aliases)
            : this(ledger, policy, view, feed, () => DateTimeOffset.UtcNow, aliases) { }
        /// <summary>Creates request orchestration that wakes the outbox when work is queued (DI).</summary>
        public RequestService(RequestLedger ledger, IRequestPolicy policy, IArrJellyfinView view, ArrChangeFeed feed, TitleAliases aliases, RequestOutboxSignal signal)
            : this(ledger, policy, view, feed, () => DateTimeOffset.UtcNow, aliases) { Signal = signal; }
        /// <summary>Wakes the outbox when an outcome queues work (absent in tests that drive the outbox themselves).</summary>
        internal RequestOutboxSignal? Signal { get; set; }
        internal RequestService(RequestLedger ledger, IRequestPolicy policy, IArrJellyfinView view, ArrChangeFeed feed, Func<DateTimeOffset> now, TitleAliases? aliases = null)
        { _ledger = ledger; _policy = policy; View = view; _feed = feed; _now = now; _aliases = aliases; }
        /// <summary>Human caller resolver.</summary>
        public IArrJellyfinView View { get; }
        /// <summary>Shared ledger.</summary>
        public RequestLedger Ledger => _ledger;
        /// <summary>Current policy.</summary>
        public IRequestPolicy Policy => _policy;
        /// <summary>Effective phase switch.</summary>
        public bool Enabled => _policy.Configuration is { ArrIntegrationEnabled: true, ArrPhase1Enabled: true, ArrPhase3Enabled: true };
        /// <summary>Identity facts used for list/quota capability checks.</summary>
        public RequestPolicyFacts Identity(Guid user, bool movie = true) => _policy.Evaluate(user, movie ? new MutationInput { Key = "movie:tmdb:1" } : new MutationInput { Key = "tv:tvdb:1", Scope = "seasons", Seasons = new[] { 1 } });
        private MutationInput? Normalize(MutationInput? input)
        {
            var normalized = input?.Normalize();
            if (normalized == null) return null;
            return normalized with { Key = _aliases?.Canonical(TitleKey.Parse(normalized.Key)!).ToString() ?? normalized.Key };
        }
        /// <summary>An input as the ledger keys it (normalized, the title under its canonical key); null when invalid.</summary>
        internal MutationInput? NormalizeInput(MutationInput? input) => Normalize(input);
        /// <summary>Creates one durable request after bounded prerequisite preparation.</summary>
        /// <param name="user">The requester.</param>
        /// <param name="body">Client id and input.</param>
        /// <param name="ct">Cancellation.</param>
        /// <param name="origin">Automation origin; null for a person's own ask.</param>
        public async Task<RequestOutcome> CreateAsync(Guid user, CreateRequest? body, CancellationToken ct, RequestOrigin? origin = null)
        {
            var input = Normalize(body?.Input);
            if (body == null || input == null) return RequestOutcome.Refused("invalid_input", 400);
            if (!Enabled) return RequestOutcome.Refused("feature_disabled");
            if (!_ledger.Database.Available) return RequestOutcome.Refused("database_unavailable", 503, "unavailable");
            if (!_policy.IsAdmin(user) && RequestLedger.HasRouting(input)) return RequestOutcome.Refused("admin_required");
            await _policy.PrepareAsync(user, input, ct).ConfigureAwait(false);
            if (_policy.Evaluate(user, input).CanCreate)
            {
                foreach (var pending in _ledger.ForTitle(input.Key).Where(w => w.Status == "pending" && w.Input.Variant == input.Variant))
                    await _policy.PrepareAsync(pending.UserId, pending.Input, ct).ConfigureAwait(false);
            }
            var outcome = _ledger.Create(user, body with { Input = input }, _policy, _now(), origin);
            if (outcome.RequestId != null) _feed.Bump(new[] { input.Key, ArrTitleKey.UserRequests(user), ArrTitleKey.RequestsState });
            if (outcome.Reason == "queued_outage") Signal?.Pulse();
            return outcome;
        }
        /// <summary>Approves with fresh requester and approver prerequisites.</summary>
        public async Task<RequestOutcome> ApproveAsync(string id, Guid actor, ApproveRequest? body, CancellationToken ct)
        {
            if (!_ledger.Database.Available) return RequestOutcome.Refused("database_unavailable", 503, "unavailable");
            var want = _ledger.Find(id);
            if (want == null) return RequestOutcome.Refused("not_found", 404);
            var input = body?.Input == null ? want.Input : Normalize(body.Input);
            if (input == null) return RequestOutcome.Refused("invalid_input", 400);
            if (!_policy.IsAdmin(actor) && RequestLedger.RoutingChanged(input, want.Input)) return RequestOutcome.Refused("admin_required");
            await _policy.PrepareAsync(want.UserId, input, ct).ConfigureAwait(false);
            await _policy.PrepareAsync(actor, input, ct).ConfigureAwait(false);
            foreach (var pending in _ledger.ForTitle(input.Key).Where(w => w.Status == "pending" && w.Id != id && w.Input.Variant == input.Variant))
            {
                await _policy.PrepareAsync(pending.UserId, pending.Input, ct).ConfigureAwait(false);
                await _policy.PrepareAsync(actor, pending.Input, ct).ConfigureAwait(false);
            }
            var outcome = _ledger.Approve(id, actor, body?.Input == null ? null : input, _policy, _now());
            if (outcome.RequestId != null) _feed.Bump(new[] { input.Key, ArrTitleKey.UserRequests(want.UserId), ArrTitleKey.RequestsState });
            if (outcome.Reason == "queued_outage") Signal?.Pulse();
            return outcome;
        }
        /// <summary>Cancel or decline after policy recheck.</summary>
        public RequestOutcome Close(string id, Guid actor, string? reason)
        {
            if (!_ledger.Database.Available) return RequestOutcome.Refused("database_unavailable", 503, "unavailable");
            var outcome = _ledger.Close(id, actor, reason, _policy, _now());
            if (outcome.RequestId != null && _ledger.Find(id) is { } want) _feed.Bump(new[] { want.Input.Key, ArrTitleKey.UserRequests(want.UserId), ArrTitleKey.RequestsState });
            return outcome;
        }
        /// <summary>Declines after refreshing backend identity and management permissions.</summary>
        public async Task<RequestOutcome> DeclineAsync(string id, Guid actor, string reason, CancellationToken ct)
        {
            if (!_ledger.Database.Available) return RequestOutcome.Refused("database_unavailable", 503, "unavailable");
            var want = _ledger.Find(id);
            if (want == null) return RequestOutcome.Refused("not_found", 404);
            await _policy.PrepareAsync(actor, want.Input, ct).ConfigureAwait(false);
            return Close(id, actor, reason);
        }
        /// <summary>Projects a list per user, role and current policy revision; never shares a caller's body.</summary>
        public StatusBody List(Guid user, bool pending)
        {
            var viewer = Identity(user);
            var items = _ledger.List(user, pending).Where(w => _policy.Evaluate(user, w.Input).Visible).Select(w => new
            {
                id = w.Id, key = w.Input.Key, scope = w.Input.Scope, variant = w.Input.Variant, seasons = w.Input.Seasons, episodes = w.Input.Episodes,
                status = w.Status, reason = w.Reason, cost = w.Cost, createdAt = w.CreatedAt,
                canApprove = viewer.CanApprove && _policy.Evaluate(user, w.Input).CanApprove && (w.Input.Variant != "4k" || _policy.Evaluate(user, w.Input).Can4k),
                requesterId = viewer.Role is "Manager" or "Admin" ? (Guid?)w.UserId : null,
                declineReason = w.Status == "declined" ? DeclineReason(w.Id) : null,
                jobs = viewer.Role == "Admin" ? _ledger.ForWant(w.Id).Select(j => new { j.Id, j.State, j.Attempts, j.Reason }).ToArray() : null,
            }).ToArray();
            var bytes = JsonSerializer.SerializeToUtf8Bytes(new { outcome = "accepted", reason = pending ? "pending" : "mine", certainty = "Succeeded", message = "Requests", items }, Json);
            var stamp = user.ToString("N") + "|" + viewer.Role + "|" + viewer.Revision + "|" + pending + "|";
            var hash = SHA256.HashData(Encoding.UTF8.GetBytes(stamp).Concat(bytes).ToArray());
            return new StatusBody(bytes, "\"" + Convert.ToHexString(hash) + "\"");
        }
        private string? DeclineReason(string wantId) => _ledger.Database.Read(c =>
        {
            using var command = RequestLedger.Cmd(c, null, "SELECT reason FROM approvals WHERE want_id=$id AND action='declined' ORDER BY created_at DESC LIMIT 1", ("$id", wantId));
            return command.ExecuteScalar() as string;
        });
        /// <summary>The caller's own request capabilities (no I/O; identity was prepared by the caller).</summary>
        public RequestCapabilities Me(Guid user)
        {
            var config = _policy.Configuration;
            var movie = Identity(user, true);
            var movie4k = _policy.Evaluate(user, new MutationInput { Key = "movie:tmdb:1", Variant = "4k" });
            var series4k = _policy.Evaluate(user, new MutationInput { Key = "tv:tvdb:1", Scope = "seasons", Seasons = new[] { 1 }, Variant = "4k" });
            var backend = config.ArrRequestBackend is "je" or "seerr" ? config.ArrRequestBackend : "status_only";
            return new RequestCapabilities
            {
                Role = movie.Role.ToLowerInvariant(),
                CanRequest = movie.CanCreate && movie.Role != "Watcher" && backend != "status_only",
                CanApprove = movie.CanApprove,
                AsksFirst = movie.Role == "Kid" || (movie.Role == "Member" && backend == "je" && config.ArrRequestPreset == "approve_everything"),
                Can4kMovies = movie4k.Can4k,
                Can4kSeries = series4k.Can4k,
                Backend = backend,
                Contact = (config.ArrHouseholdContactName ?? string.Empty).Trim(),
            };
        }
        /// <summary>
        /// Current rolling quota status; for series also the single episodes charged in the window
        /// (what the next episode ask costs depends on them).
        /// </summary>
        public QuotaProjection Quota(Guid user, bool movie = true)
        {
            var facts = Identity(user, movie);
            var now = _now();
            var quota = _ledger.Quota(facts, now);
            return movie || !_ledger.Database.Available ? quota : quota with { Episodes = _ledger.EpisodesCharged(user, facts.WindowDays, now) };
        }
    }
}
