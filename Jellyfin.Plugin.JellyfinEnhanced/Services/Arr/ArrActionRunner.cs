using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr
{
    /// <summary>How much an action can hurt.</summary>
    public enum ArrActionTier
    {
        /// <summary>Reads or nudges (search now, refresh). No confirmation.</summary>
        Safe = 1,
        /// <summary>Changes state that can be changed back (monitor, add, queue remove without data).</summary>
        Change = 2,
        /// <summary>Deletes data (files, or downloads together with their client data). Needs a confirmation token.</summary>
        Destructive = 3,
    }

    /// <summary>How an action ended.</summary>
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public enum ArrActionStatus
    {
        /// <summary>The arr accepted it and the read-back saw the effect (or there was nothing to read back).</summary>
        Succeeded,
        /// <summary>The arr refused it or could not be reached; nothing changed.</summary>
        Failed,
        /// <summary>It may or may not have happened (timeout after sending, or the read-back can't see it): check the arr.</summary>
        Unknown,
        /// <summary>JE refused it before calling the arr (missing/invalid confirmation).</summary>
        Rejected,
    }

    /// <summary>What a read-back found.</summary>
    public sealed class ArrReadBack
    {
        /// <summary>True: the effect is visible. False: it is not (yet). Null: could not check.</summary>
        public bool? Confirmed { get; init; }

        /// <summary>Plain summary, e.g. "queue row gone", "0 reports downloaded".</summary>
        public string Summary { get; init; } = string.Empty;
    }

    /// <summary>One direct arr write to run.</summary>
    public sealed class ArrActionRequest
    {
        /// <summary>Action name, e.g. "movie.search".</summary>
        public required string Action { get; init; }

        /// <summary>Target instance id.</summary>
        public required string InstanceId { get; init; }

        /// <summary>What is acted on, e.g. "movie:123" (also bound into confirmation tokens).</summary>
        public required string Target { get; init; }

        /// <summary>The Jellyfin user asking (already authorised by the caller).</summary>
        public required Guid UserId { get; init; }

        /// <summary>Their display name, for the audit line.</summary>
        public string? UserName { get; init; }

        /// <summary>
        /// One key per click: a repeated request with the same key (double tap, retry after a
        /// dropped response) gets the first outcome instead of running again.
        /// </summary>
        public required string IdempotencyKey { get; init; }

        /// <summary>Tier; <see cref="ArrActionTier.Destructive"/> needs <see cref="ConfirmationToken"/>.</summary>
        public ArrActionTier Tier { get; init; } = ArrActionTier.Change;

        /// <summary>Token from <see cref="ArrConfirmationTokens.Issue"/> (Tier 3 only).</summary>
        public string? ConfirmationToken { get; init; }

        /// <summary>The write. Returns null on success or the arr error.</summary>
        public required Func<CancellationToken, Task<ArrError?>> Execute { get; init; }

        /// <summary>Optional read-back after the write (also used to resolve a "maybe sent" timeout).</summary>
        public Func<CancellationToken, Task<ArrReadBack>>? ReadBack { get; init; }

        /// <summary>Extra non-secret context for the audit line.</summary>
        public IReadOnlyDictionary<string, string>? Details { get; init; }

        /// <summary>Budget for the write and the read-back together (default 60 s).</summary>
        public TimeSpan? Timeout { get; init; }
    }

    /// <summary>The result shown to the admin.</summary>
    public sealed class ArrActionOutcome
    {
        /// <summary>Final status.</summary>
        public ArrActionStatus Status { get; init; }

        /// <summary>Plain message for the admin.</summary>
        public string Message { get; init; } = string.Empty;

        /// <summary>The arr error, if any.</summary>
        public ArrError? Error { get; init; }

        /// <summary>The read-back, if one ran.</summary>
        public ArrReadBack? ReadBack { get; init; }

        /// <summary>The audit entry id ("" when the audit line could not be written).</summary>
        public string AuditId { get; init; } = string.Empty;

        /// <summary>False when the outcome could not be written to the audit log (see the server log).</summary>
        public bool Audited { get; init; } = true;

        /// <summary>True when this is the stored outcome of an earlier request with the same idempotency key.</summary>
        public bool Replayed { get; init; }
    }

    /// <summary>
    /// The Phase 1–2 path for arr writes: direct and synchronous, one idempotency key per click,
    /// a read-back after the call, an append-only audit line for every outcome (including refusals),
    /// and confirmation tokens for destructive actions. Nothing is retried, before or after a
    /// restart: a write whose fate is unclear is reported as <see cref="ArrActionStatus.Unknown"/>.
    /// Callers must authorise the user (admin / capability) before calling.
    /// </summary>
    public sealed class ArrActionRunner
    {
        private static readonly TimeSpan IdempotencyWindow = TimeSpan.FromMinutes(10);
        private static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(60);
        private readonly ArrAuditLog _audit;
        private readonly ArrConfirmationTokens _tokens;
        private readonly Func<DateTimeOffset> _now;
        private readonly ConcurrentDictionary<string, (Task<ArrActionOutcome> Task, DateTimeOffset At)> _recent = new(StringComparer.Ordinal);

        /// <summary>Creates the runner.</summary>
        public ArrActionRunner(ArrAuditLog audit, ArrConfirmationTokens tokens)
            : this(audit, tokens, null)
        {
        }

        /// <summary>Creates the runner with a clock (tests).</summary>
        internal ArrActionRunner(ArrAuditLog audit, ArrConfirmationTokens tokens, Func<DateTimeOffset>? now)
        {
            _audit = audit;
            _tokens = tokens;
            _now = now ?? (() => DateTimeOffset.UtcNow);
        }

        /// <summary>The token issuer used for <see cref="ArrActionTier.Destructive"/> actions.</summary>
        public ArrConfirmationTokens Tokens => _tokens;

        /// <summary>
        /// Runs the action once per idempotency key. Caller cancellation only stops waiting before
        /// the write starts; once started, the write and its read-back run to their own budget so an
        /// abandoned browser request can't leave a half-known state unaudited.
        /// </summary>
        public async Task<ArrActionOutcome> RunAsync(ArrActionRequest request, CancellationToken cancellationToken = default)
        {
            ArgumentNullException.ThrowIfNull(request);
            cancellationToken.ThrowIfCancellationRequested();
            var now = _now();
            foreach (var stale in _recent.Where(r => now - r.Value.At > IdempotencyWindow).Select(r => r.Key).ToList())
            {
                _recent.TryRemove(stale, out _);
            }

            var key = string.Join("\n", request.UserId.ToString("N"), request.Action, request.InstanceId.ToLowerInvariant(), request.IdempotencyKey);
            var created = new TaskCompletionSource<ArrActionOutcome>(TaskCreationOptions.RunContinuationsAsynchronously);
            var entry = _recent.GetOrAdd(key, _ => (created.Task, now));
            if (!ReferenceEquals(entry.Task, created.Task))
            {
                var previous = await entry.Task.WaitAsync(cancellationToken).ConfigureAwait(false);
                return new ArrActionOutcome
                {
                    Status = previous.Status,
                    Message = previous.Message,
                    Error = previous.Error,
                    ReadBack = previous.ReadBack,
                    AuditId = previous.AuditId,
                    Audited = previous.Audited,
                    Replayed = true,
                };
            }

            ArrActionOutcome outcome;
            try
            {
                outcome = await RunOnceAsync(request).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                outcome = Finish(request, Guid.NewGuid().ToString("N"), ArrActionStatus.Failed, "Jellyfin Enhanced hit an error running this action.", new ArrError(ArrErrorKind.Internal, ex.GetType().Name), null, 0);
            }
            created.SetResult(outcome);

            // A refusal (missing/expired confirmation) must not block the same click from being
            // confirmed and retried, so it is not remembered.
            if (outcome.Status == ArrActionStatus.Rejected) _recent.TryRemove(key, out _);
            return outcome;
        }

        private async Task<ArrActionOutcome> RunOnceAsync(ArrActionRequest request)
        {
            var auditId = Guid.NewGuid().ToString("N");
            if (request.Tier == ArrActionTier.Destructive
                && !_tokens.TryConsume(request.ConfirmationToken, request.UserId, request.Action, request.InstanceId, request.Target, out var reason))
            {
                return Finish(request, auditId, ArrActionStatus.Rejected, "This action deletes data and needs a fresh confirmation.", null, null, 0, reason);
            }

            // The "started" line comes first, so a crash or restart mid-action still leaves a trace
            // (shown as unknown). Data is never deleted without it.
            if (!_audit.Append(Entry(request, auditId, ArrAuditLog.StartedOutcome, null, null, null, 0)) && request.Tier == ArrActionTier.Destructive)
            {
                return Finish(request, auditId, ArrActionStatus.Rejected, "The audit log can't be written, so this action was not run. Check the server log.", null, null, 0, "audit_unavailable");
            }

            using var budget = new CancellationTokenSource(request.Timeout ?? DefaultTimeout);
            var watch = Stopwatch.StartNew();
            ArrError? error;
            try
            {
                error = await request.Execute(budget.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                error = new ArrError(ArrErrorKind.Timeout, "The action ran out of time.");
            }
            catch (Exception ex)
            {
                // A JE bug mid-write: whether the arr changed anything is unknown.
                return Finish(request, auditId, ArrActionStatus.Unknown, "Jellyfin Enhanced hit an error during this action. Check the instance before trying again.",
                    new ArrError(ArrErrorKind.Internal, ex.GetType().Name), null, watch.ElapsedMilliseconds);
            }

            if (error != null && !error.MaybeSent)
            {
                return Finish(request, auditId, ArrActionStatus.Failed, error.Message, error, null, watch.ElapsedMilliseconds);
            }

            ArrReadBack? readBack = null;
            if (request.ReadBack != null)
            {
                try
                {
                    readBack = await request.ReadBack(budget.Token).ConfigureAwait(false);
                }
                catch (Exception)
                {
                    // A failed check never turns a write into a failure; it just stays unverified.
                    readBack = new ArrReadBack { Confirmed = null, Summary = "Could not check the result." };
                }
            }

            if (error is { Accepted: false })
            {
                // Maybe sent: only a positive read-back turns it into a success.
                return readBack?.Confirmed == true
                    ? Finish(request, auditId, ArrActionStatus.Succeeded, "Done (confirmed after a slow answer).", null, readBack, watch.ElapsedMilliseconds)
                    : Finish(request, auditId, ArrActionStatus.Unknown, "Unknown: the instance did not answer in time. Check it before trying again.", error, readBack, watch.ElapsedMilliseconds);
            }

            // Accepted (error == null, or a success status whose reply JE couldn't use: the change
            // happened either way, so it is never reported as failed).
            if (readBack?.Confirmed == false)
            {
                return Finish(request, auditId, ArrActionStatus.Unknown, "The instance accepted it, but the change is not visible yet. Check it before trying again.", error, readBack, watch.ElapsedMilliseconds);
            }
            return Finish(request, auditId, ArrActionStatus.Succeeded, error == null ? "Done." : "Done (the instance accepted it; its reply could not be read).", error, readBack, watch.ElapsedMilliseconds);
        }

        private ArrActionOutcome Finish(ArrActionRequest request, string auditId, ArrActionStatus status, string message, ArrError? error, ArrReadBack? readBack, long durationMs, string? refusal = null)
        {
            var audited = _audit.Append(Entry(request, auditId, status.ToString().ToLowerInvariant(), error, readBack, refusal, durationMs));
            return new ArrActionOutcome { Status = status, Message = message, Error = error, ReadBack = readBack, AuditId = audited ? auditId : string.Empty, Audited = audited };
        }

        private ArrAuditEntry Entry(ArrActionRequest request, string auditId, string outcome, ArrError? error, ArrReadBack? readBack, string? refusal, long durationMs) => new()
        {
            Id = auditId,
            Time = _now(),
            UserId = request.UserId.ToString("N"),
            UserName = request.UserName,
            Action = request.Action,
            Tier = (int)request.Tier,
            InstanceId = request.InstanceId,
            Target = request.Target,
            Outcome = outcome,
            ReadBack = readBack?.Summary,
            Error = refusal ?? error?.Kind.ToString(),
            Message = error?.Message,
            DurationMs = durationMs,
            Details = request.Details,
        };
    }
}
