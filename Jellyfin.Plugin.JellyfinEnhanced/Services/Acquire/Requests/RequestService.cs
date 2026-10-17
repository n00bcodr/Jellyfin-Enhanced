using System;
using System.Collections.Generic;
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
        // The one canonicalisation point (RequestTitleIdentity.Entry): the title's other ids learned, then the key the
        // ledger holds it under, before anything is prepared or decided. learn: false for a read-only check.
        private MutationInput? Normalize(MutationInput? input, bool learn = true)
            => RequestTitleIdentity.Entry(_ledger, _policy, _aliases, _feed, input, _now(), learn && Enabled);
        /// <summary>An input as the ledger keys it (normalized, the title under the key the ledger holds it by); null when invalid.</summary>
        internal MutationInput? NormalizeInput(MutationInput? input) => Normalize(input);
        /// <summary>A title under the key the ledger holds it by (whichever id the caller used).</summary>
        internal TitleKey CanonicalTitle(TitleKey title) => RequestTitleIdentity.Held(_ledger, _aliases, title);
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
        /// <summary>
        /// What <see cref="CreateAsync"/> would do now, with nothing written (the no-write decision seam): the same
        /// normalization and bounded preparation reads, then <see cref="RequestLedger.Preview"/>. No change-feed bump and no
        /// outbox wake-up.
        /// </summary>
        /// <param name="user">The requester.</param>
        /// <param name="body">Client id and input.</param>
        /// <param name="ct">Cancellation.</param>
        /// <param name="origin">Where the ask would come from.</param>
        public async Task<RequestPreview> PreviewAsync(Guid user, CreateRequest? body, CancellationToken ct, RequestOrigin? origin = null)
        {
            var input = Normalize(body?.Input);
            if (body == null || input == null) return new RequestPreview(RequestOutcome.Refused("invalid_input", 400));
            if (!Enabled) return new RequestPreview(RequestOutcome.Refused("feature_disabled"));
            if (!_ledger.Database.Available) return new RequestPreview(RequestOutcome.Refused("database_unavailable", 503, "unavailable"));
            if (!_policy.IsAdmin(user) && RequestLedger.HasRouting(input)) return new RequestPreview(RequestOutcome.Refused("admin_required"));
            await _policy.PrepareAsync(user, input, ct).ConfigureAwait(false);
            return _ledger.Preview(user, body with { Input = input }, _policy, _now(), origin);
        }
        /// <summary>
        /// What a batch of asks made one after another would do now (phase 4b, "request all missing"), nothing written:
        /// normalization, the bounded preparation reads for each title, then <see cref="RequestLedger.PreviewBatch"/>.
        /// Null or invalid entries answer <c>invalid_input</c>. At most <see cref="RequestLedger.MaxBatch"/> asks.
        /// </summary>
        /// <param name="user">The requester.</param>
        /// <param name="bodies">The asks, in order.</param>
        /// <param name="ct">Cancellation.</param>
        /// <param name="origin">Where the asks would come from.</param>
        public async Task<IReadOnlyList<RequestPreview>> PreviewBatchAsync(Guid user, IReadOnlyList<CreateRequest?> bodies, CancellationToken ct, RequestOrigin? origin = null)
        {
            if (bodies.Count > RequestLedger.MaxBatch) return bodies.Select(_ => new RequestPreview(RequestOutcome.Refused("batch_too_large", 400))).ToArray();
            if (!Enabled) return bodies.Select(_ => new RequestPreview(RequestOutcome.Refused("feature_disabled"))).ToArray();
            if (!_ledger.Database.Available) return bodies.Select(_ => new RequestPreview(RequestOutcome.Refused("database_unavailable", 503, "unavailable"))).ToArray();
            var admin = _policy.IsAdmin(user);
            var normalized = new List<CreateRequest?>(bodies.Count);
            foreach (var body in bodies)
            {
                var input = Normalize(body?.Input);
                // Routing (instance, profile, folder) is an administrator's choice, as on a single ask.
                normalized.Add(body == null || input == null || (!admin && RequestLedger.HasRouting(input)) ? null : body with { Input = input });
            }
            foreach (var input in normalized.Where(b => b != null).Select(b => b!.Input).DistinctBy(i => i.Fingerprint))
                await _policy.PrepareAsync(user, input, ct).ConfigureAwait(false);
            var previews = _ledger.PreviewBatch(user, normalized, _policy, _now(), origin);
            // A routing choice by a non-administrator answers as a single ask would.
            return previews.Select((p, i) => normalized[i] == null && bodies[i] != null && Normalize(bodies[i]!.Input, learn: false) is { } routed && RequestLedger.HasRouting(routed)
                ? new RequestPreview(RequestOutcome.Refused("admin_required")) : p).ToArray();
        }
        /// <summary>
        /// The group pool the person's requests draw on now and its use (phase 4b; null without one): an aggregate, never
        /// whose requests they were.
        /// </summary>
        /// <param name="user">The person.</param>
        public (GroupPoolBinding Pool, QuotaProjection Use)? Pool(Guid user)
        {
            var facts = Identity(user);
            return facts.Pool is { } pool && _ledger.Database.Available ? (pool, _ledger.PoolQuota(pool, _now())) : null;
        }
        /// <summary>Approves with fresh requester and approver prerequisites.</summary>
        public async Task<RequestOutcome> ApproveAsync(string id, Guid actor, ApproveRequest? body, CancellationToken ct)
        {
            if (!_ledger.Database.Available) return RequestOutcome.Refused("database_unavailable", 503, "unavailable");
            if (_ledger.Find(id) is not { } stored) return RequestOutcome.Refused("not_found", 404);
            // The request's title is learned first (once a series reaches Sonarr its canonical key becomes its TVDB id, and the
            // request asked by its TMDB id moves with it), then read again as the ledger holds it now; an edit may name the title
            // by any of its ids and is resolved to that key too, before anything is prepared.
            RequestTitleIdentity.Learn(_ledger, _policy, _aliases, _feed, stored.Input.Key, _now());
            if (_ledger.Find(id) is not { } want) return RequestOutcome.Refused("not_found", 404);
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
        /// <summary>
        /// Projects a list per user, role and current policy revision; never shares a caller's body. The caller's own
        /// list (<paramref name="pending"/> false) has one row per title edition (<see cref="LedgerRequestFacts.PerTitle"/>),
        /// with the requests it stands for in <c>members</c>; the waiting list has one row per request.
        /// </summary>
        public StatusBody List(Guid user, bool pending)
        {
            var viewer = Identity(user);
            var visible = _ledger.List(user, pending).Where(w => _policy.Evaluate(user, w.Input).Visible);
            var rows = pending ? visible.Select(w => new TitleRequests(w, new[] { w })).ToList() : LedgerRequestFacts.PerTitle(visible);
            object[]? Jobs(RequestWant w) => viewer.Role == "Admin" ? _ledger.ForWant(w.Id).Select(j => (object)new { j.Id, j.State, j.Attempts, j.Reason }).ToArray() : null;
            var items = rows.Select(r =>
            {
                var w = r.Row;
                var facts = _policy.Evaluate(user, r.Members[0].Input);
                return new
                {
                    id = w.Id, key = w.Input.Key, scope = w.Input.Scope, variant = w.Input.Variant, seasons = w.Input.Seasons, episodes = w.Input.Episodes,
                    status = w.Status, reason = w.Reason, cost = r.Members.Sum(m => m.Cost), createdAt = w.CreatedAt,
                    canApprove = viewer.CanApprove && facts.CanApprove && (w.Input.Variant != "4k" || facts.Can4k),
                    requesterId = viewer.Role is "Manager" or "Admin" ? (Guid?)w.UserId : null,
                    declineReason = w.Status == "declined" ? DeclineReason(w.Id) : null,
                    jobs = Jobs(w),
                    members = pending ? null : r.Members.Select(m => new { id = m.Id, status = m.Status, reason = m.Reason, jobs = Jobs(m) }).ToArray(),
                };
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
        /// <summary>Reads the default instances' disk facts when none are in memory (for <see cref="Me"/>'s storage pauses).</summary>
        /// <param name="ct">Cancellation.</param>
        public Task PreparePausesAsync(CancellationToken ct)
            => Task.WhenAll(_policy.PrepareAddPauseAsync(true, ct), _policy.PrepareAddPauseAsync(false, ct));
        /// <summary>The caller's own request capabilities (no I/O; identity was prepared by the caller).</summary>
        public RequestCapabilities Me(Guid user)
        {
            var config = _policy.Configuration;
            var movie = Identity(user, true);
            var series = Identity(user, false);
            var movie4k = _policy.Evaluate(user, new MutationInput { Key = "movie:tmdb:1", Variant = "4k" });
            var series4k = _policy.Evaluate(user, new MutationInput { Key = "tv:tvdb:1", Scope = "seasons", Seasons = new[] { 1 }, Variant = "4k" });
            var backend = config.ArrRequestBackend is "je" or "seerr" ? config.ArrRequestBackend : "status_only";
            bool Can(RequestPolicyFacts facts) => facts.CanCreate && facts.Role != "Watcher" && backend != "status_only";
            return new RequestCapabilities
            {
                Role = movie.Role.ToLowerInvariant(),
                CanRequest = Can(movie) || Can(series),
                CanRequestMovies = Can(movie),
                CanRequestSeries = Can(series),
                CanApprove = movie.CanApprove,
                AsksFirst = movie.Role == "Kid" || (movie.Role == "Member" && backend == "je" && config.ArrRequestPreset == "approve_everything"),
                Can4kMovies = movie4k.Can4k,
                Can4kSeries = series4k.Can4k,
                Backend = backend,
                Contact = (config.ArrHouseholdContactName ?? string.Empty).Trim(),
                SeerrWholeSeries = backend == "seerr" && series.SeerrWholeSeries,
                PausedMovies = Can(movie) ? RequestBlock.Storage(_policy.AddPause(true), movie.Role == "Admin") : null,
                PausedSeries = Can(series) ? RequestBlock.Storage(_policy.AddPause(false), series.Role == "Admin") : null,
            };
        }
        /// <summary>
        /// Whether the caller may ask for one title now (the standard or 4K edition), and if not, why, for the controls
        /// that offer it (title page, request sheet). Movies are checked as a movie ask; series as an ask for the season
        /// in the key (else season 1). No I/O beyond reading the target instance's disk facts when none are in memory;
        /// null when the key isn't a title key.
        /// </summary>
        /// <param name="user">The caller.</param>
        /// <param name="key">Title key (movie, series, season or episode key).</param>
        /// <param name="variant">standard or 4k.</param>
        /// <param name="ct">Cancellation.</param>
        public async Task<RequestTitleCheck?> CheckAsync(Guid user, string? key, string? variant, CancellationToken ct)
        {
            var edition = variant == "4k" ? "4k" : "standard";
            if (TitleInput(key, edition) is not { } input) return null;
            await _policy.PrepareDiskAsync(input, ct).ConfigureAwait(false);
            var facts = _policy.Evaluate(user, input);
            var can = facts.Refusal == null && facts.CanCreate && facts.Role != "Watcher" && facts.Backend is "je" or "seerr" && (edition == "standard" || facts.Can4k);
            return new RequestTitleCheck { Key = input.Key, Variant = edition, CanRequest = can, Blocked = can ? null : RequestBlock.Of(facts) };
        }
        /// <summary>
        /// The ask a title check stands for: a movie as a movie ask, a series as an ask for the season in the key (else
        /// season 1); null when the key isn't a title key.
        /// </summary>
        private MutationInput? TitleInput(string? key, string edition)
        {
            if (TitleKey.Parse(key) is not { } parsed) return null;
            var season = Math.Max(parsed.Season ?? 1, 0);
            // Not a way into the ledger (nothing is asked for): the in-memory aliases are enough, and a list of titles reads no database.
            var input = (parsed.IsMovie
                ? new MutationInput { Key = parsed.Title.ToString(), Scope = "movie", Variant = edition }
                : new MutationInput { Key = parsed.Title.ToString(), Scope = "seasons", Seasons = new[] { season }, Variant = edition }).Normalize();
            return input == null ? null : input with { Key = (_aliases?.Canonical(TitleKey.Parse(input.Key)!) ?? TitleKey.Parse(input.Key)!).ToString() };
        }
        /// <summary>
        /// The titles of a list (Discover and search cards, a collection's missing movies) the caller can't ask for
        /// right now because the drive the download would land on is nearly full, keyed as given: for each title the
        /// same answer as <see cref="CheckAsync"/> for its standard edition (the title's own folder when the arr holds
        /// it, else the default root; instance, folder and sizes for administrators only). Only titles whose drive is
        /// low get the full per-person policy answer. With <paramref name="wait"/> the disk facts and the list of titles
        /// the arr holds are read first when they aren't in memory (bounded); without it the reads are only started (a
        /// title is then not marked until they are in; asking for it still answers <c>low_disk</c>).
        /// </summary>
        /// <param name="user">The caller.</param>
        /// <param name="keys">Title keys.</param>
        /// <param name="wait">Wait for facts not in memory yet.</param>
        /// <param name="ct">Cancellation.</param>
        public async Task<IReadOnlyDictionary<string, RequestBlock>> StoragePausesAsync(Guid user, IEnumerable<string> keys, bool wait, CancellationToken ct)
        {
            var paused = new Dictionary<string, RequestBlock>(StringComparer.Ordinal);
            var titles = keys.Distinct(StringComparer.Ordinal).Select(k => (Key: k, Input: TitleInput(k, "standard"))).Where(t => t.Input != null).ToList();
            // Every title of a kind goes to the same default instance: its facts are prepared once per kind.
            var firsts = titles.GroupBy(t => TitleKey.Parse(t.Input!.Key)!.IsMovie).Select(g => g.First().Input!).ToList();
            if (wait) await Task.WhenAll(firsts.Select(input => _policy.PrepareDiskAsync(input, ct))).ConfigureAwait(false);
            foreach (var (key, input) in titles)
            {
                // In memory only; a title whose drive has room needs no per-person answer.
                if (_policy.TitlePause(input!) == null) continue;
                if (RequestBlock.Of(_policy.Evaluate(user, input!)) is { Reason: "low_disk" } block) paused[key] = block;
            }
            // Not waiting: this answer stands on what was in memory; the reads run on (not tied to it) for the next one.
            if (!wait) foreach (var input in firsts) _ = _policy.PrepareDiskAsync(input, CancellationToken.None);
            return paused;
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
