using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>
    /// Uncached backend identity/capability facts. Missing facts never grant a permission. <c>SeerrWholeSeries</c>:
    /// Seerr's partial-request setting is off (or not a real on/off), so Seerr takes a request for the whole series only.
    /// <c>SeerrUnlinked</c>: Seerr answered and no Seerr account is linked to the person (not "Seerr didn't answer").
    /// <c>SeerrOptions</c> (an input carrying Seerr server/profile/root options, else null): <c>valid</c>,
    /// <c>seerr_options_invalid</c>, <c>seerr_options_changed</c> or <c>unknown</c> (Seerr's servers aren't known lately);
    /// <c>SeerrOptionsStamp</c> is the chosen server's current options stamp when known, so a change shows in the
    /// authorization stamp.
    /// </summary>
    public sealed record RequestBackendBinding(string? Source = null, int? UserId = null, long Permissions = 0,
        bool FourKEnabled = false, bool Can4k = false, bool CanManage = false, QuotaProjection? Quota = null, int QuotaWindowDays = 7, bool CanRequest = false,
        bool SeerrWholeSeries = false, bool SeerrUnlinked = false, string? SeerrOptions = null, string? SeerrOptionsStamp = null);
    /// <summary>Transport outcome with explicit retry and read-back certainty.</summary>
    /// <remarks><c>RetryAfter</c>: a retryable result's own wait before the next attempt (instead of the short backoff).</remarks>
    public sealed record RequestBackendResult(RequestOutcome Outcome, bool Confirmed = false, bool Retryable = false, bool Parked = false, bool VerifiedNotSent = false, TimeSpan? RetryAfter = null)
    {
        /// <summary>A refusal at the final send; the job is parked for human review.</summary>
        public static RequestBackendResult Hold(string reason) => new(reason == "quota_exceeded" ? RequestOutcome.Refused(reason, 429, "quota_exceeded") : RequestOutcome.Refused(reason, 409), Parked: true, VerifiedNotSent: true);
        /// <summary>An uncertain send; the reservation remains until a scoped fresh read resolves it.</summary>
        public static RequestBackendResult Uncertain(string id) => new(new RequestOutcome { Outcome = "maybe_sent", Reason = "maybe_sent", Certainty = ArrActionStatus.Unknown, HttpStatus = 202, RequestId = id, Message = "Asked! We'll confirm shortly." });
        /// <summary>
        /// Part of the change is (or may be) upstream and the rest can be completed safely: the certainty stays
        /// Unknown (no cancel or refund) and the next attempt sends again, reading before it writes.
        /// </summary>
        public static RequestBackendResult Resume(string id) => Uncertain(id) with { Retryable = true };
        /// <summary>True for a <see cref="Resume"/> result: uncertain, retried through a fresh send rather than read back.</summary>
        public bool Resumes => !Confirmed && !Parked && Retryable && Outcome.Certainty == ArrActionStatus.Unknown;
    }
    /// <summary>Request transport contract. Implementations run the guard after their own transport gate, immediately before I/O.</summary>
    public interface IRequestBackend
    {
        /// <summary>Loads fresh identity/settings prerequisites; must never send a write.</summary>
        Task PrepareAsync(Guid user, MutationInput input, CancellationToken ct);
        /// <summary>Prepared binding used by synchronous authorization; source changes invalidate it.</summary>
        RequestBackendBinding Binding(Guid user, MutationInput input);
        /// <summary>Dispatches canonical input. A guard refusal contacts no upstream service.</summary>
        Task<RequestBackendResult> SendAsync(RequestJob job, Func<string?> finalGuard, CancellationToken ct);
        /// <summary>
        /// Dispatches automatic work: like <see cref="SendAsync(RequestJob, Func{string?}, CancellationToken)"/>, and each
        /// add, search or POST is admitted by <paramref name="admission"/> right before it leaves (null: none needed).
        /// </summary>
        Task<RequestBackendResult> SendAsync(RequestJob job, Func<string?> finalGuard, ISendAdmission? admission, CancellationToken ct) => SendAsync(job, finalGuard, ct);
        /// <summary>Fresh scoped read using the original connection identity; never sends a write.</summary>
        Task<RequestBackendResult> ReadBackAsync(RequestJob job, CancellationToken ct);
        /// <summary>
        /// Whether the backend has a server for the 4K copy of a movie (or series) as last read: Seerr's 4K Radarr/Sonarr
        /// setting. Null when the backend doesn't say or it isn't known lately (nothing is concluded then).
        /// </summary>
        bool? FourKServer(bool movie) => null;
        /// <summary>Whether the specified Seerr source's chosen server's recently read connection matches this arr URL and key. Memory only; unknown is false.</summary>
        bool RepresentsSeerrServer(string? source, MutationInput input, string url, string apiKey) => false;
    }
    /// <summary>Safe production placeholder until request executors are installed. It performs no network I/O.</summary>
    public sealed class UnavailableRequestBackend : IRequestBackend
    {
        /// <inheritdoc />
        public Task PrepareAsync(Guid user, MutationInput input, CancellationToken ct) => Task.CompletedTask;
        /// <inheritdoc />
        public RequestBackendBinding Binding(Guid user, MutationInput input) => new();
        /// <inheritdoc />
        public Task<RequestBackendResult> SendAsync(RequestJob job, Func<string?> finalGuard, CancellationToken ct)
            => Task.FromResult(finalGuard() is { } refusal ? AutomationHolds.IsWait(refusal) ? BackendResults.Later(refusal, "Automatic requests are held.", AutomationHolds.WaitFor(refusal)) : RequestBackendResult.Hold(refusal) :
                new RequestBackendResult(RequestOutcome.Refused("backend_unavailable", 503, "unavailable"), Retryable: true, VerifiedNotSent: true));
        /// <inheritdoc />
        public Task<RequestBackendResult> ReadBackAsync(RequestJob job, CancellationToken ct) => Task.FromResult(RequestBackendResult.Uncertain(job.WantId));
    }
    /// <summary>Local title locks, excluding scope so overlapping seasons/episodes serialize together.</summary>
    public sealed class RequestTitleLocks
    {
        private readonly object _gate = new();
        private readonly Dictionary<string, Entry> _entries = new(StringComparer.Ordinal);
        private sealed class Entry { public readonly SemaphoreSlim Semaphore = new(1, 1); public int Users; }
        /// <summary>Takes a canonical title/edition lock. Dispose releases it and removes unused entries.</summary>
        public async Task<IDisposable> TakeAsync(MutationInput input, CancellationToken ct)
        {
            var key = input.Key + "|" + input.Variant;
            Entry entry;
            lock (_gate)
            {
                if (!_entries.TryGetValue(key, out entry!)) _entries[key] = entry = new();
                entry.Users++;
            }
            try { await entry.Semaphore.WaitAsync(ct).ConfigureAwait(false); }
            catch { Drop(key, entry, false); throw; }
            return new Lease(() => Drop(key, entry, true));
        }
        private void Drop(string key, Entry entry, bool release)
        {
            lock (_gate)
            {
                if (release) entry.Semaphore.Release();
                if (--entry.Users == 0) { _entries.Remove(key); entry.Semaphore.Dispose(); }
            }
        }
        private sealed class Lease(Action release) : IDisposable
        {
            private Action? _release = release;
            public void Dispose() => Interlocked.Exchange(ref _release, null)?.Invoke();
        }
    }
    /// <summary>Durable outbox executor. Startup recovery reads uncertain actions before any resend.</summary>
    public sealed class RequestOutbox : BackgroundService
    {
        /// <summary>
        /// How long a Seerr-mode request whose person has no Seerr account linked waits before it is checked again
        /// (sooner as soon as the link shows up: see <see cref="RequestLedger.WakeUnlinked"/>).
        /// </summary>
        internal static readonly TimeSpan UnlinkedRecheck = TimeSpan.FromHours(1);
        private readonly RequestLedger _ledger;
        private readonly IRequestPolicy _policy;
        private readonly IRequestBackend _backend;
        private readonly RequestTitleLocks _locks;
        private readonly ArrChangeFeed _feed;
        private readonly ArrAuditLog _audit;
        private readonly Func<DateTimeOffset> _now;
        private readonly RequestOutboxSignal _signal;
        private readonly RequestOutboxEvents? _events;
        private readonly SeerrRequestWriteFence? _seerrWrites;
        private readonly AutomationSendGuard? _automation;
        /// <summary>Creates the worker on its five-second timer only.</summary>
        public RequestOutbox(RequestLedger ledger, IRequestPolicy policy, IRequestBackend backend, RequestTitleLocks locks, ArrChangeFeed feed, ArrAuditLog audit)
            : this(ledger, policy, backend, locks, feed, audit, () => DateTimeOffset.UtcNow) { }
        /// <summary>
        /// Creates the worker (DI), woken early by <paramref name="signal"/> when work is queued; <paramref name="events"/>
        /// hears about confirmed jobs and <paramref name="seerrWrites"/> holds Seerr sends off while a move from Seerr runs.
        /// </summary>
        /// <remarks><paramref name="automation"/> holds and budgets automatic work (recipes, list sync) at send.</remarks>
        public RequestOutbox(RequestLedger ledger, IRequestPolicy policy, IRequestBackend backend, RequestTitleLocks locks, ArrChangeFeed feed, ArrAuditLog audit, RequestOutboxSignal signal, RequestOutboxEvents? events = null, SeerrRequestWriteFence? seerrWrites = null, AutomationSendGuard? automation = null)
            : this(ledger, policy, backend, locks, feed, audit, () => DateTimeOffset.UtcNow, events, seerrWrites, signal, automation) { }
        internal RequestOutbox(RequestLedger ledger, IRequestPolicy policy, IRequestBackend backend, RequestTitleLocks locks, ArrChangeFeed feed, ArrAuditLog audit, Func<DateTimeOffset> now, RequestOutboxEvents? events = null, SeerrRequestWriteFence? seerrWrites = null, RequestOutboxSignal? signal = null, AutomationSendGuard? automation = null)
        { _ledger = ledger; _policy = policy; _backend = backend; _locks = locks; _feed = feed; _audit = audit; _now = now; _events = events; _seerrWrites = seerrWrites; _signal = signal ?? new RequestOutboxSignal(); _automation = automation; }
        /// <summary>
        /// The send-time hold for a job's Seerr options from one person's current facts, or null: the switch is off, the
        /// Seerr account lacks the advanced-request permission, Seerr isn't known now (retried), or the options no longer
        /// fit Seerr's servers (<c>seerr_options_changed</c>, whether they changed or never fit).
        /// </summary>
        private static string? SeerrOptionsHold(RequestPolicyFacts facts) => facts.Refusal switch
        {
            "seerr_options_disabled" or "seerr_advanced_required" or "backend_unavailable" => facts.Refusal,
            "seerr_options_invalid" or "seerr_options_changed" => "seerr_options_changed",
            _ => null,
        };
        /// <summary>Processes due work once; tests and diagnostics may drive this without a timer.</summary>
        public async Task TickAsync(CancellationToken ct)
        {
            if (!_ledger.Database.Available) return;
            // Open 4K requests nothing can take now say so (and are released when a 4K target is back).
            foreach (var held in _ledger.HoldWithout4k(_policy.Has4kTarget, _now()))
                _feed.Bump(new[] { held.Input.Key, ArrTitleKey.UserRequests(held.UserId), ArrTitleKey.RequestsState });
            // Merges that met work in flight are finished once it settled (after a restart too).
            Settle();
            foreach (var job in _ledger.Due(_now()))
            {
                ct.ThrowIfCancellationRequested();
                // A Seerr send waits while a move from Seerr runs (it stays due); a read-back is only a read.
                using var seerrWrite = job.Authorization.Backend == "seerr" && job.State != "maybe_sent" ? _seerrWrites?.TryEnterWrite() : null;
                if (_seerrWrites != null && job.Authorization.Backend == "seerr" && job.State != "maybe_sent" && seerrWrite == null) continue;
                using var titleLock = await _locks.TakeAsync(job.Input, ct).ConfigureAwait(false);
                var generation = _ledger.Database.Generation;
                // The one send-time redundancy check: what went out for the title already is never sent again.
                var claim = _ledger.ClaimForDispatch(job, generation, _now());
                if (claim == RequestLedger.DispatchClaim.Served) _feed.Bump(new[] { job.Input.Key, ArrTitleKey.UserRequests(job.Authorization.Requester), ArrTitleKey.RequestsState });
                if (claim != RequestLedger.DispatchClaim.Claimed) continue;
                RequestBackendResult result;
                // The household-rule verdict the guard held the job with (phase 4b): kept as the request's rationale.
                HouseholdRuleVerdict? heldRules = null;
                var transportStarted = false;
                var settledByRead = false;
                // Automatic work (recipes, list sync) and work only phase 4 creates: the write gate before any transport
                // (and again immediately before every write, in Guard below). A read-back is never held.
                var want = _automation == null ? null : _ledger.Find(job.WantId);
                var hold = job.State == "maybe_sent" ? null : _automation?.Hold(job, want);
                var admission = job.State == "maybe_sent" ? null : _automation?.Admission(job, want);
                try
                {
                    var effective = EffectiveRequestsBackend.EvaluateConfiguration(_policy.Configuration);
                    if (job.Authorization.Backend == "seerr" && !effective.AllowSeerrTransport
                        || effective.IsolationVersion != 0 && job.Authorization.Backend == "je" && !effective.AllowDirectRequests)
                    {
                        result = job.State == "maybe_sent" || job.Uncertain
                            ? BackendResults.Maybe(job.WantId, "The original backend is disabled; delivery remains unconfirmed.", "backend_disabled")
                            : BackendResults.Hold("backend_disabled", "The request's original backend is disabled.");
                    }
                    else if (hold != null)
                    {
                        result = hold.Park ? BackendResults.Hold(hold.Reason, hold.Message) : BackendResults.Later(hold.Reason, hold.Message, hold.Wait);
                    }
                    else
                    {
                        if (job.State != "maybe_sent")
                        {
                            await _policy.PrepareAsync(job.Authorization.Requester, job.Input, ct).ConfigureAwait(false);
                            if (job.Authorization.Approver is Guid actor) await _policy.PrepareAsync(actor, job.Input, ct).ConfigureAwait(false);
                        }
                        string? Guard()
                        {
                            var liveBackend = EffectiveRequestsBackend.EvaluateConfiguration(_policy.Configuration);
                            if (job.Authorization.Backend == "seerr" && !liveBackend.AllowSeerrTransport
                                || liveBackend.IsolationVersion != 0 && job.Authorization.Backend == "je" && !liveBackend.AllowDirectRequests)
                                return "backend_disabled";
                            if (job.Input.Fingerprint != job.Fingerprint || job.Input.Scope != job.Authorization.Scope || job.Input.Variant != job.Authorization.Variant) return "idempotency_conflict";
                            if (_ledger.Database.Generation != generation) return "configuration_changed";
                            RequestPolicyFacts? requester = null;
                            RequestPolicyFacts? approver = null;
                            var stable = false;
                            for (var attempt = 0; attempt < 3; attempt++)
                            {
                                var requesterStamp = _policy.AuthorizationStamp(job.Authorization.Requester, job.Input);
                                var approverStamp = job.Authorization.Approver is Guid beforeActor ? _policy.AuthorizationStamp(beforeActor, job.Input) : null;
                                requester = _policy.Evaluate(job.Authorization.Requester, job.Input);
                                approver = job.Authorization.Approver is Guid approverId ? _policy.Evaluate(approverId, job.Input) : null;
                                stable = requesterStamp == _policy.AuthorizationStamp(job.Authorization.Requester, job.Input) &&
                                    approverStamp == (job.Authorization.Approver is Guid afterActor ? _policy.AuthorizationStamp(afterActor, job.Input) : null);
                                if (stable) break;
                            }
                            if (!stable || requester == null) return "authorization_changed";
                            if (requester.Refusal == "user_required" || approver?.Refusal == "user_required") return "identity_changed";
                            if (requester.Backend != job.Authorization.Backend || requester.Refusal == "feature_disabled") return "configuration_changed";
                            // Nothing can take the 4K copy now (no usable 4K instance, or no 4K server in Seerr): held for an administrator.
                            if (job.Input.Variant == "4k" && _policy.Has4kTarget(TitleKey.Parse(job.Input.Key)?.IsMovie != false) == false) return RequestLedger.No4k;
                            // Seerr picks its own server: a Seerr-mode job is bound to the Seerr identity below, not to an arr connection.
                            if (job.Authorization.Backend != "seerr" && (requester.ConnectionGeneration != job.Authorization.ConnectionGeneration || requester.InstanceId != job.Authorization.InstanceId)) return "instance_changed";
                            // An unknown current Seerr account (Seerr not answering) waits below; only a known different one is a change.
                            // A job approved while the person's Seerr account wasn't known is sent as the account Seerr links to them
                            // now, after every check here has been made again with that account's permissions.
                            if (requester.SeerrSource != job.Authorization.SeerrSource || (job.Authorization.SeerrUser != null && requester.SeerrUser != null && requester.SeerrUser != job.Authorization.SeerrUser)) return "identity_changed";
                            if (_ledger.ExceedsGbCapAtSend(requester, _now())) return "quota_exceeded";
                            // Seerr options: the switch, the Seerr permission of each person and the options themselves are checked
                            // again here (typed holds), and someone on the job must still be a Jellyfin administrator.
                            if (job.Input.HasSeerrOptions)
                            {
                                if ((SeerrOptionsHold(requester) ?? (approver == null ? null : SeerrOptionsHold(approver))) is { } seerrHold) return seerrHold;
                                if (requester.Role != "Admin" && approver?.Role != "Admin") return "admin_required";
                            }
                            if (RequestPolicy.Check(requester, approver, job.Input, approver != null) != null) return "authorization_changed";
                            // A Kid, the household's rules or a group pool (phase 4b), a Member's preset, quota or series threshold.
                            if (_ledger.ApprovalNeededAtSend(job, requester, _policy, _now()) is { } needed)
                            {
                                if (needed is RequestLedger.RuleReview or RequestLedger.HouseholdRule) heldRules = requester.Rules;
                                return needed;
                            }
                            if (job.Authorization.Edited && approver?.Role != "Admin" && RequestLedger.HasRouting(job.Input)) return "authorization_changed";
                            // Seerr answered that no Seerr account is linked to the person (not "Seerr didn't answer"): nothing can be
                            // sent as them, so the request is held with that reason and checked again now and then, not every pass.
                            if (requester.Backend == "seerr" && requester.SeerrUser == null && requester.SeerrUnlinked) return "seerr_user_unlinked";
                            if (requester.Backend == "seerr" && requester.BackendQuota?.Available != true && job.State != "maybe_sent") return "backend_unavailable";
                            if (requester.Backend == "seerr" && (requester.SeerrUser == null || requester.SeerrSource == null)) return "backend_unavailable";
                            // The write gate, read live right before this write: every automation gate (switches, engine change
                            // since this attempt chose its budget admission, kills, mode, consent, override, eligibility,
                            // breaker, disk). Each write's budget is admitted by the backend right after this.
                            if (_automation?.Hold(job, want, budgetedAtStart: admission != null) is { } late) return late.Reason;
                            // A changed revision is evaluated above; it is not itself a refusal.
                            return null;
                        }
                        // Read-back is a read of the original target, even if authority or configuration changed.
                        if (job.State == "maybe_sent")
                        {
                            result = await _backend.ReadBackAsync(job, ct).ConfigureAwait(false);
                            settledByRead = true;
                            // A hold after the write (Seerr has the request, not as chosen) stays held for a person.
                            if (!result.Confirmed && !result.VerifiedNotSent && !result.Resumes && !result.Parked && result.Outcome.Reason != "backend_disabled") result = RequestBackendResult.Uncertain(job.WantId);
                            else if (result.VerifiedNotSent && !result.Confirmed)
                                result = result with { Retryable = true, Parked = false };
                        }
                        else if (Guard() is { } refusal) result = refusal switch
                        {
                            "backend_unavailable" => new RequestBackendResult(RequestOutcome.Refused(refusal, 503, "unavailable"), Retryable: true, VerifiedNotSent: true),
                            "seerr_user_unlinked" => BackendResults.Later(refusal, "The person has no Seerr account linked; the request goes out once they have one.", UnlinkedRecheck),
                            _ when AutomationHolds.IsWait(refusal) => BackendResults.Later(refusal, "Automatic requests are held (" + refusal + ").", AutomationHolds.WaitFor(refusal)),
                            _ => RequestBackendResult.Hold(refusal),
                        };
                        else
                        {
                            transportStarted = true;
                            // The send's writes are this job's: automatic work is checked again inside the transport, at
                            // each write (D41); a person's own job enters as no automation, whatever the flow carried.
                            using (_automation == null ? null : AutomationTransportContext.Enter(_automation.Gate, AutomationWrite.ForJob(job, want, admission != null), admission))
                            {
                                result = await _backend.SendAsync(job, Guard, admission, ct).ConfigureAwait(false);
                            }
                            // A hold after a partial write and a resume are already settled by the backend: no read-back.
                            if (!result.Confirmed && !result.Parked && !result.Resumes && result.Outcome.Certainty is ArrActionStatus.Succeeded or ArrActionStatus.Unknown)
                            {
                                // As stored now: the send may have bound what it went out with (Seerr's account and seasons).
                                result = job.Authorization.Backend == "seerr" && !EffectiveRequestsBackend.AllowsSeerr(_policy.Configuration)
                                    ? BackendResults.Maybe(job.WantId, "The original backend is disabled; delivery remains unconfirmed.", "backend_disabled")
                                    : await _backend.ReadBackAsync(_ledger.Job(job.Id) ?? job, ct).ConfigureAwait(false);
                                settledByRead = true;
                                if (!result.Confirmed && !result.VerifiedNotSent && !result.Resumes && !result.Parked && result.Outcome.Reason != "backend_disabled") result = RequestBackendResult.Uncertain(job.WantId);
                            }
                        }
                    }
                }
                catch (Exception)
                {
                    result = transportStarted || job.State == "maybe_sent" ? RequestBackendResult.Uncertain(job.WantId) :
                        new RequestBackendResult(RequestOutcome.Refused("backend_unavailable", 503, "unavailable"), Retryable: true, VerifiedNotSent: true);
                }
                if (job.State == "maybe_sent" && !result.Confirmed && !result.VerifiedNotSent && !result.Resumes && !result.Parked)
                    result = result with { Outcome = RequestBackendResult.Uncertain(job.WantId).Outcome with { Reason = result.Outcome.Reason }, Retryable = false };
                // A job whose last outcome left upstream state unknown stays uncertain until a fresh read settles it: a
                // later attempt that is refused or fails before writing proves nothing about what the earlier one wrote.
                if (job.Uncertain && !settledByRead && !result.Confirmed && result.Outcome.Certainty != ArrActionStatus.Unknown)
                    result = result with { Outcome = result.Outcome with { Certainty = ArrActionStatus.Unknown }, VerifiedNotSent = false, Parked = result.Parked || !result.Retryable };
                var completed = _ledger.Complete(job, generation, result, _now());
                if (completed && heldRules != null && result.Outcome.Reason is RequestLedger.RuleReview or RequestLedger.HouseholdRule) _ledger.HeldByRules(job.WantId, heldRules);
                if (completed) _automation?.Observe(job, want, result, transportStarted, settledByRead);
                if (completed) _feed.Bump(new[] { job.Input.Key, ArrTitleKey.UserRequests(job.Authorization.Requester), ArrTitleKey.RequestsState });
                if (completed && result.Confirmed) _events?.RaiseConfirmed(job);
                if (completed) Settle();
                if (!completed && !transportStarted && job.State != "maybe_sent") continue;
                // The same wait again (still no Seerr account, a season still not listed): one audit row for it, not one per check.
                if (completed && RequestLedger.RepeatsWait(job, result)) continue;
                _audit.Append(new ArrAuditEntry { Id = job.Id, Time = _now(), UserId = _ledger.AuditActor(job.Authorization.Approver ?? job.Authorization.Requester), Action = "request.dispatch", Tier = 2,
                    InstanceId = job.Authorization.InstanceId, Target = job.Input.Key, Outcome = result.Outcome.Certainty.ToString().ToLowerInvariant(), Error = result.Outcome.Reason, Message = result.Outcome.Message });
            }
        }
        // Finishes noted merges whose work settled (RequestLedger.SettleMerges); lists showing them are told.
        private void Settle()
        {
            foreach (var merge in _ledger.SettleMerges(_policy, _now()))
                _feed.Bump(merge.Keys.Concat(merge.People.Select(ArrTitleKey.UserRequests)).Append(ArrTitleKey.RequestsState).ToArray());
        }
        /// <inheritdoc />
        protected override async Task ExecuteAsync(CancellationToken stoppingToken)
        {
            var recoveredGeneration = -1L;
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    var c = _policy.Configuration;
                    if (c.ArrIntegrationEnabled && c.ArrPhase1Enabled && c.ArrPhase3Enabled && _ledger.Database.Available)
                    {
                        if (recoveredGeneration != _ledger.Database.Generation)
                        {
                            _ledger.ImportAudit(_audit.ReadRecent(int.MaxValue));
                            _ledger.Recover(_now());
                            recoveredGeneration = _ledger.Database.Generation;
                        }
                        _ledger.Retain(_now(), c.ArrRequestStaleDays);
                        await TickAsync(stoppingToken).ConfigureAwait(false);
                    }
                    // Every five seconds, or at once when new work is queued.
                    await _signal.WaitAsync(TimeSpan.FromSeconds(5), stoppingToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
                catch (Exception) { await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken).ConfigureAwait(false); }
            }
        }
    }
}
