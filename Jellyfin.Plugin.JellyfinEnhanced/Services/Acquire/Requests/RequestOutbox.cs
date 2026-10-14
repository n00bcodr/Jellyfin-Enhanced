using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>Uncached backend identity/capability facts. Missing facts never grant a permission.</summary>
    public sealed record RequestBackendBinding(string? Source = null, int? UserId = null, long Permissions = 0,
        bool FourKEnabled = false, bool Can4k = false, bool CanManage = false, QuotaProjection? Quota = null, int QuotaWindowDays = 7, bool CanRequest = false);
    /// <summary>Transport outcome with explicit retry and read-back certainty.</summary>
    public sealed record RequestBackendResult(RequestOutcome Outcome, bool Confirmed = false, bool Retryable = false, bool Parked = false, bool VerifiedNotSent = false)
    {
        /// <summary>A refusal at the final send; the job is parked for human review.</summary>
        public static RequestBackendResult Hold(string reason) => new(reason == "quota_exceeded" ? RequestOutcome.Refused(reason, 429, "quota_exceeded") : RequestOutcome.Refused(reason, 409), Parked: true, VerifiedNotSent: true);
        /// <summary>An uncertain send; the reservation remains until a scoped fresh read resolves it.</summary>
        public static RequestBackendResult Uncertain(string id) => new(new RequestOutcome { Outcome = "maybe_sent", Reason = "maybe_sent", Certainty = ArrActionStatus.Unknown, HttpStatus = 202, RequestId = id, Message = "Asked! We'll confirm shortly." });
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
        /// <summary>Fresh scoped read using the original connection identity; never sends a write.</summary>
        Task<RequestBackendResult> ReadBackAsync(RequestJob job, CancellationToken ct);
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
            => Task.FromResult(finalGuard() is { } refusal ? RequestBackendResult.Hold(refusal) :
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
        private readonly RequestLedger _ledger;
        private readonly IRequestPolicy _policy;
        private readonly IRequestBackend _backend;
        private readonly RequestTitleLocks _locks;
        private readonly ArrChangeFeed _feed;
        private readonly ArrAuditLog _audit;
        private readonly Func<DateTimeOffset> _now;
        /// <summary>Creates the worker.</summary>
        public RequestOutbox(RequestLedger ledger, IRequestPolicy policy, IRequestBackend backend, RequestTitleLocks locks, ArrChangeFeed feed, ArrAuditLog audit)
            : this(ledger, policy, backend, locks, feed, audit, () => DateTimeOffset.UtcNow) { }
        internal RequestOutbox(RequestLedger ledger, IRequestPolicy policy, IRequestBackend backend, RequestTitleLocks locks, ArrChangeFeed feed, ArrAuditLog audit, Func<DateTimeOffset> now)
        { _ledger = ledger; _policy = policy; _backend = backend; _locks = locks; _feed = feed; _audit = audit; _now = now; }
        /// <summary>Processes due work once; tests and diagnostics may drive this without a timer.</summary>
        public async Task TickAsync(CancellationToken ct)
        {
            if (!_ledger.Database.Available) return;
            foreach (var job in _ledger.Due(_now()))
            {
                ct.ThrowIfCancellationRequested();
                using var titleLock = await _locks.TakeAsync(job.Input, ct).ConfigureAwait(false);
                var generation = _ledger.Database.Generation;
                if (!_ledger.Claim(job, generation, _now())) continue;
                RequestBackendResult result;
                var transportStarted = false;
                try
                {
                    if (job.State != "maybe_sent")
                    {
                        await _policy.PrepareAsync(job.Authorization.Requester, job.Input, ct).ConfigureAwait(false);
                        if (job.Authorization.Approver is Guid actor) await _policy.PrepareAsync(actor, job.Input, ct).ConfigureAwait(false);
                    }
                    string? Guard()
                    {
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
                        if (requester.ConnectionGeneration != job.Authorization.ConnectionGeneration || requester.InstanceId != job.Authorization.InstanceId) return "instance_changed";
                        if (requester.SeerrSource != job.Authorization.SeerrSource || requester.SeerrUser != job.Authorization.SeerrUser) return "identity_changed";
                        if (_ledger.ExceedsGbCapAtSend(requester, _now())) return "quota_exceeded";
                        if (RequestPolicy.Check(requester, approver, job.Input, approver != null) != null || _ledger.NeedsApprovalAtSend(job, requester, _policy, _now())) return "authorization_changed";
                        if (job.Authorization.Edited && approver?.Role != "Admin" && (job.Input.ProfileId != null || job.Input.RootFolder != null || job.Input.InstanceId != null)) return "authorization_changed";
                        if (requester.Backend == "seerr" && requester.BackendQuota?.Available != true && job.State != "maybe_sent") return "backend_unavailable";
                        if (requester.Backend == "seerr" && (requester.SeerrUser == null || requester.SeerrSource == null)) return "backend_unavailable";
                        // A changed revision is evaluated above; it is not itself a refusal.
                        return null;
                    }
                    // Read-back is a read of the original target, even if authority or configuration changed.
                    if (job.State == "maybe_sent")
                    {
                        result = await _backend.ReadBackAsync(job, ct).ConfigureAwait(false);
                        if (!result.Confirmed && !result.VerifiedNotSent) result = RequestBackendResult.Uncertain(job.WantId);
                        else if (result.VerifiedNotSent && !result.Confirmed)
                            result = result with { Retryable = true, Parked = false };
                    }
                    else if (Guard() is { } refusal) result = refusal == "backend_unavailable"
                        ? new RequestBackendResult(RequestOutcome.Refused(refusal, 503, "unavailable"), Retryable: true, VerifiedNotSent: true)
                        : RequestBackendResult.Hold(refusal);
                    else
                    {
                        transportStarted = true;
                        result = await _backend.SendAsync(job, Guard, ct).ConfigureAwait(false);
                        if (!result.Confirmed && result.Outcome.Certainty is ArrActionStatus.Succeeded or ArrActionStatus.Unknown)
                        {
                            result = await _backend.ReadBackAsync(job, ct).ConfigureAwait(false);
                            if (!result.Confirmed && !result.VerifiedNotSent) result = RequestBackendResult.Uncertain(job.WantId);
                        }
                    }
                }
                catch (Exception)
                {
                    result = transportStarted || job.State == "maybe_sent" ? RequestBackendResult.Uncertain(job.WantId) :
                        new RequestBackendResult(RequestOutcome.Refused("backend_unavailable", 503, "unavailable"), Retryable: true, VerifiedNotSent: true);
                }
                if (job.State == "maybe_sent" && !result.Confirmed && !result.VerifiedNotSent)
                    result = result with { Outcome = RequestBackendResult.Uncertain(job.WantId).Outcome with { Reason = result.Outcome.Reason }, Retryable = false };
                var completed = _ledger.Complete(job, generation, result, _now());
                if (completed) _feed.Bump(new[] { job.Input.Key, ArrTitleKey.UserRequests(job.Authorization.Requester), ArrTitleKey.RequestsState });
                if (!completed && !transportStarted && job.State != "maybe_sent") continue;
                _audit.Append(new ArrAuditEntry { Id = job.Id, Time = _now(), UserId = _ledger.AuditActor(job.Authorization.Approver ?? job.Authorization.Requester), Action = "request.dispatch", Tier = 2,
                    InstanceId = job.Authorization.InstanceId, Target = job.Input.Key, Outcome = result.Outcome.Certainty.ToString().ToLowerInvariant(), Error = result.Outcome.Reason, Message = result.Outcome.Message });
            }
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
                    await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
                catch (Exception) { await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken).ConfigureAwait(false); }
            }
        }
    }
}
