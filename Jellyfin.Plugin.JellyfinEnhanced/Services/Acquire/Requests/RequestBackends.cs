using System;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>
    /// The request backend the outbox and policy use: Jellyfin Enhanced's own Sonarr/Radarr executor
    /// (<see cref="DirectArrBackend"/>) in "Jellyfin Enhanced" mode, Seerr (<see cref="SeerrBackend"/>)
    /// in Seerr mode. Preparation and identity follow the configured mode; a job is always sent and read
    /// back by the backend it was authorised for, so a mode switch never sends old work elsewhere.
    /// </summary>
    public sealed class RequestBackendRouter : IRequestBackend
    {
        private readonly DirectArrBackend _direct;
        private readonly SeerrBackend _seerr;
        private readonly Func<PluginConfiguration?> _config;

        /// <summary>Creates the router (DI).</summary>
        public RequestBackendRouter(DirectArrBackend direct, SeerrBackend seerr)
            : this(direct, seerr, () => JellyfinEnhanced.Instance?.Configuration)
        {
        }

        /// <summary>Creates the router over an explicit configuration (tests).</summary>
        internal RequestBackendRouter(DirectArrBackend direct, SeerrBackend seerr, Func<PluginConfiguration?> config)
        {
            _direct = direct;
            _seerr = seerr;
            _config = config;
        }

        private IRequestBackend? Current => _config()?.ArrRequestBackend switch { "je" => _direct, "seerr" => _seerr, _ => null };

        private IRequestBackend? For(RequestJob job) => job.Authorization.Backend switch { "je" => _direct, "seerr" => _seerr, _ => null };

        /// <inheritdoc />
        public Task PrepareAsync(Guid user, MutationInput input, CancellationToken ct) => Current?.PrepareAsync(user, input, ct) ?? Task.CompletedTask;

        /// <inheritdoc />
        public RequestBackendBinding Binding(Guid user, MutationInput input) => Current?.Binding(user, input) ?? new RequestBackendBinding();

        /// <inheritdoc />
        public Task<RequestBackendResult> SendAsync(RequestJob job, Func<string?> finalGuard, CancellationToken ct)
            => For(job)?.SendAsync(job, finalGuard, ct) ?? Task.FromResult(RequestBackendResult.Hold("configuration_changed"));

        /// <inheritdoc />
        public Task<RequestBackendResult> ReadBackAsync(RequestJob job, CancellationToken ct)
            => For(job)?.ReadBackAsync(job, ct) ?? Task.FromResult(BackendResults.Maybe(job.WantId, "The backend this request was sent to is no longer known.", "configuration_changed"));

        /// <inheritdoc />
        public bool? FourKServer(bool movie) => Current?.FourKServer(movie);
    }

    /// <summary>
    /// Wakes the outbox early when new work is queued, so a request is sent within moments instead of
    /// at the next five-second pass. Missing a pulse is harmless: the pass still runs on its timer.
    /// </summary>
    public sealed class RequestOutboxSignal
    {
        private readonly SemaphoreSlim _pulse = new(0, 1);

        /// <summary>Asks the outbox to run its next pass now.</summary>
        public void Pulse()
        {
            try
            {
                _pulse.Release();
            }
            catch (SemaphoreFullException)
            {
                // A pass is already pending.
            }
        }

        /// <summary>Waits for a pulse or the timeout, whichever comes first.</summary>
        public Task WaitAsync(TimeSpan timeout, CancellationToken ct) => _pulse.WaitAsync(timeout, ct);
    }

    /// <summary>The backend results the executors share (household-safe reasons, administrator messages).</summary>
    internal static class BackendResults
    {
        /// <summary>Done and confirmed by a fresh read of the exact result.</summary>
        public static RequestBackendResult Done(string wantId, string outcome, string reason, string message, int status = 200)
            => new(new RequestOutcome { Outcome = outcome, Reason = reason, Certainty = ArrActionStatus.Succeeded, HttpStatus = status, RequestId = wantId, Message = message }, Confirmed: true);

        /// <summary>Nothing was sent; try again later (the service is down or busy).</summary>
        public static RequestBackendResult Retry(string reason, string message)
            => new(RequestOutcome.Refused(reason, 503, "unavailable") with { Message = message }, Retryable: true, VerifiedNotSent: true);

        /// <summary>Nothing was sent; it can't be done yet (a season the arr doesn't list): checked again after <paramref name="after"/>.</summary>
        public static RequestBackendResult Later(string reason, string message, TimeSpan after)
            => Retry(reason, message) with { Outcome = RequestOutcome.Refused(reason, 409) with { Message = message }, RetryAfter = after };

        /// <summary>Nothing was sent; a person has to look at it (parked).</summary>
        public static RequestBackendResult Hold(string reason, string message)
        {
            var hold = RequestBackendResult.Hold(reason);
            return hold with { Outcome = hold.Outcome with { Message = message } };
        }

        /// <summary>The service answered and refused; nothing was written and resending won't help.</summary>
        public static RequestBackendResult Failed(string reason, string message)
            => new(RequestOutcome.Refused(reason, 409, "blocked") with { Certainty = ArrActionStatus.Failed, Message = message }, VerifiedNotSent: true);

        /// <summary>The write may have happened; a fresh read settles it before anything is sent again.</summary>
        public static RequestBackendResult Maybe(string wantId, string message, string reason = "maybe_sent")
        {
            var maybe = RequestBackendResult.Uncertain(wantId);
            return maybe with { Outcome = maybe.Outcome with { Reason = reason, Message = message } };
        }

        /// <summary>A read-back proved nothing of the request is there: sending again is safe.</summary>
        public static RequestBackendResult NotThere(string message)
            => new(RequestOutcome.Refused("not_sent", 503, "unavailable") with { Message = message }, Retryable: true, VerifiedNotSent: true);

        /// <summary>
        /// Part of the request is upstream (or may be) and the rest, or its search, still has to happen: the next
        /// attempt sends again (every step reads before it writes); meanwhile it can't be cancelled or refunded.
        /// </summary>
        public static RequestBackendResult Resume(string wantId, string message)
        {
            var resume = RequestBackendResult.Resume(wantId);
            return resume with { Outcome = resume.Outcome with { Message = message } };
        }

        /// <summary>
        /// The guard refused after part of the change was written: held for a person like any refusal, but the
        /// certainty stays unknown because the written part stays upstream (no cancel or refund as if unsent).
        /// </summary>
        public static RequestBackendResult HoldAfterWrite(string wantId, string reason, string message)
            => Maybe(wantId, message, reason) with { Parked = true };
    }
}
