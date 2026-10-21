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

        /// <summary>
        /// The complete identity of the request (D53, edition rounds 21-22: a retry key replays only the identical request): a
        /// season page's press fingerprint, or the caller's own description of what it asked (route, operation, instance,
        /// target, options). Every action is kept under the user and the idempotency key alone, whatever it runs and where;
        /// the same key with another identity is refused (<see cref="ArrActionOutcome.Conflict"/>), never answered with the
        /// first outcome and never run again. Without one, the action, instance and target stand for it.
        /// </summary>
        public string? Fingerprint { get; init; }

        /// <summary>
        /// The connection a destructive action's confirmation must have been issued for (an opaque tag of the connection the
        /// action was checked on): a token confirmed on another connection is refused. Null: the target alone.
        /// </summary>
        public string? Binding { get; init; }
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

        /// <summary>True when the idempotency key was already used for another press (nothing ran; see <see cref="ArrActionRequest.Fingerprint"/>).</summary>
        public bool Conflict { get; init; }
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
        private readonly ConcurrentDictionary<string, (Task<ArrActionOutcome> Task, DateTimeOffset At, string Fingerprint)> _recent = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, (Task<object?> Task, string Identity)> _flights = new(StringComparer.Ordinal);

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

        /// <summary>
        /// Whether the person's key is held by a recorded request (an ask or an add; D53, edition round 22: one key namespace per
        /// person): such a key is a conflict here, never another action.
        /// </summary>
        internal Func<Guid, string, bool>? KeyTakenElsewhere { get; set; }

        /// <summary>Whether an action holds the person's key (running, or remembered within the idempotency window).</summary>
        internal bool Holds(Guid userId, string idempotencyKey)
        {
            var key = PressKey(userId, idempotencyKey);
            return _flights.ContainsKey(key) || (_recent.TryGetValue(key, out var entry) && _now() - entry.At <= IdempotencyWindow);
        }

        /// <summary>The audit log the runner writes (refusals before the runner are written there too).</summary>
        public ArrAuditLog Audit => _audit;

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

            // One namespace: the person and their key (D53, edition round 22). What the request is (its identity) is compared,
            // never used to pick another slot: another action, route, instance or a request without its press under a used
            // key is a conflict.
            var key = PressKey(request.UserId, request.IdempotencyKey);
            var identity = IdentityOf(request);
            if (KeyTakenElsewhere?.Invoke(request.UserId, request.IdempotencyKey) == true) return Conflicting(request);
            var created = new TaskCompletionSource<ArrActionOutcome>(TaskCreationOptions.RunContinuationsAsynchronously);
            var entry = _recent.GetOrAdd(key, _ => (created.Task, now, identity));
            if (!ReferenceEquals(entry.Task, created.Task))
            {
                if (!string.Equals(entry.Fingerprint, identity, StringComparison.Ordinal)) return Conflicting(request);
                return Replay(await entry.Task.WaitAsync(cancellationToken).ConfigureAwait(false));
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

        /// <summary>
        /// The identity of an action that carries none of its own: its action, instance and target (callers that check
        /// changing state first use <see cref="Identity"/> for the same text).
        /// </summary>
        private static string IdentityOf(ArrActionRequest request)
            => request.Fingerprint ?? Identity(request.Action, request.InstanceId, request.Target);

        /// <summary>The identity of an action by its name, instance and what it acts on (plus any options that change it).</summary>
        public static string Identity(string action, string instanceId, string target, params string?[] options)
            => string.Join("\n", new[] { "action", action, instanceId.ToLowerInvariant(), target }.Concat(options.Select(o => o ?? "-")));

        /// <summary>
        /// One owner for a person's key at a time (D53, edition round 22: single-flight before anything is claimed): the first
        /// caller runs <paramref name="owner"/>; an identical request (<paramref name="identity"/>) arriving meanwhile claims
        /// nothing of its own and gets the owner's result, and another request under the key is <paramref name="conflict"/>.
        /// When the owner's caller goes away before it finished (cancelled), a waiting identical request becomes the owner.
        /// </summary>
        internal async Task<T> SingleFlightAsync<T>(Guid userId, string idempotencyKey, string identity, Func<CancellationToken, Task<T>> owner, Func<T> conflict, CancellationToken cancellationToken)
        {
            var key = PressKey(userId, idempotencyKey);
            if (KeyTakenElsewhere?.Invoke(userId, idempotencyKey) == true) return conflict();
            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var mine = new TaskCompletionSource<object?>(TaskCreationOptions.RunContinuationsAsynchronously);
                var entry = _flights.GetOrAdd(key, (mine.Task, identity));
                if (!ReferenceEquals(entry.Task, mine.Task))
                {
                    if (!string.Equals(entry.Identity, identity, StringComparison.Ordinal)) return conflict();
                    try
                    {
                        return (T)(await entry.Task.WaitAsync(cancellationToken).ConfigureAwait(false))!;
                    }
                    catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                    {
                        // The owner's caller went away before its action ran: this identical request takes it over.
                        continue;
                    }
                }
                try
                {
                    var result = await owner(cancellationToken).ConfigureAwait(false);
                    mine.SetResult(result);
                    return result;
                }
                catch (OperationCanceledException)
                {
                    mine.TrySetCanceled();
                    throw;
                }
                catch (Exception ex)
                {
                    mine.TrySetException(ex);
                    throw;
                }
                finally
                {
                    _flights.TryRemove(new KeyValuePair<string, (Task<object?>, string)>(key, entry));
                }
            }
        }

        /// <summary>
        /// A press under its idempotency key (see <see cref="ArrActionRequest.Fingerprint"/>): the outcome of the same press
        /// earlier (or still running) within the window, as a replay; <see cref="ArrActionOutcome.Conflict"/> when the key was
        /// used for another press; null when the key wasn't used. Callers ask this before anything is checked again.
        /// </summary>
        /// <param name="userId">The user.</param>
        /// <param name="idempotencyKey">The click's idempotency key.</param>
        /// <param name="fingerprint">The press's fingerprint as its request describes it.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The replayed outcome, a conflict, or null.</returns>
        public async Task<ArrActionOutcome?> ReplayPressAsync(Guid userId, string idempotencyKey, string fingerprint, CancellationToken cancellationToken = default)
        {
            if (!_recent.TryGetValue(PressKey(userId, idempotencyKey), out var entry) || _now() - entry.At > IdempotencyWindow) return null;
            if (!string.Equals(entry.Fingerprint, fingerprint, StringComparison.Ordinal)) return new ArrActionOutcome { Status = ArrActionStatus.Rejected, Message = "This retry names another press.", Conflict = true };
            return Replay(await entry.Task.WaitAsync(cancellationToken).ConfigureAwait(false));
        }

        /// <summary>What a destructive action's confirmation is bound to: its target, on the connection it was checked on.</summary>
        public static string ConfirmationTarget(string target, string? binding) => binding == null ? target : target + "@" + binding;

        private static string PressKey(Guid userId, string idempotencyKey)
            => string.Join("\n", userId.ToString("N"), "press", string.Empty, idempotencyKey);

        // A key used for another press: refused (audited), never remembered, nothing runs.
        private ArrActionOutcome Conflicting(ArrActionRequest request)
        {
            var refused = Finish(request, Guid.NewGuid().ToString("N"), ArrActionStatus.Rejected, "This retry names another press.", null, null, 0, "idempotency_conflict");
            return new ArrActionOutcome { Status = refused.Status, Message = refused.Message, AuditId = refused.AuditId, Audited = refused.Audited, Conflict = true };
        }

        private static ArrActionOutcome Replay(ArrActionOutcome previous) => new()
        {
            Status = previous.Status,
            Message = previous.Message,
            Error = previous.Error,
            ReadBack = previous.ReadBack,
            AuditId = previous.AuditId,
            Audited = previous.Audited,
            Replayed = true,
        };

        private async Task<ArrActionOutcome> RunOnceAsync(ArrActionRequest request)
        {
            var auditId = Guid.NewGuid().ToString("N");
            if (request.Tier == ArrActionTier.Destructive
                && !_tokens.TryConsume(request.ConfirmationToken, request.UserId, request.Action, request.InstanceId, ConfirmationTarget(request.Target, request.Binding), out var reason))
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
