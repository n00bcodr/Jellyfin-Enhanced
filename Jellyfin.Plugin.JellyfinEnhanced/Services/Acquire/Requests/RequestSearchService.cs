using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>
    /// Search for people who may ask but don't manage the arrs: runs the arr's own search again for a
    /// movie or one episode that requests already sent (by the caller or anyone in the household) and
    /// that has been missing for a long while since (monitored, out, nothing grabbed for longer than the
    /// "still looking" hours). Nothing new is asked for, so it charges nothing and needs no OK; anything
    /// else is asked for through the request API as before. One search per title part per "still
    /// looking" period for the whole household; the arr call is audited under the caller.
    /// </summary>
    public sealed class RequestSearchService
    {
        private readonly RequestService _requests;
        private readonly ArrManageService _manage;
        private readonly Func<DateTimeOffset> _now;
        private readonly ConcurrentDictionary<string, DateTimeOffset> _last = new(StringComparer.Ordinal);

        /// <summary>Creates the service.</summary>
        /// <param name="requests">Request service (policy, ledger).</param>
        /// <param name="manage">The audited arr search (and the status service).</param>
        public RequestSearchService(RequestService requests, ArrManageService manage)
            : this(requests, manage, () => DateTimeOffset.UtcNow) { }

        internal RequestSearchService(RequestService requests, ArrManageService manage, Func<DateTimeOffset> now)
        { _requests = requests; _manage = manage; _now = now; }

        /// <summary>
        /// Searches again for <paramref name="key"/> (a movie key, or a series key with a season and
        /// an episode) as <paramref name="viewer"/>. Not this route's to do (outcome <c>skipped</c>, 200,
        /// nothing searched; the caller asks instead): <c>not_requested</c> (nothing was sent for it yet)
        /// and <c>not_searchable</c> (not missing for long enough, or nothing to search). Refusals:
        /// <c>invalid_input</c> (400), the request policy's own (not visible, no requests, ...),
        /// <c>searched_recently</c> (429) and <c>search_failed</c> (502).
        /// </summary>
        /// <param name="viewer">The caller (a person).</param>
        /// <param name="key">Title key in scope.</param>
        /// <param name="idempotencyKey">One per press.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>The outcome, and whether the search grabbed a copy (null: not known).</returns>
        public async Task<(RequestOutcome Outcome, bool? Found)> SearchAsync(StatusViewer viewer, string? key, string? idempotencyKey, CancellationToken ct)
        {
            if (TitleKey.Parse(key) is not { } scope || (!scope.IsMovie && (scope.Season is not int season || scope.Episode is not int episode || season < 0 || episode < 1)))
                return (RequestOutcome.Refused("invalid_input", 400), null);
            if (string.IsNullOrWhiteSpace(idempotencyKey) || idempotencyKey.Length > 64)
                return (RequestOutcome.Refused("invalid_input", 400), null);
            var input = _requests.NormalizeInput(scope.IsMovie
                ? new MutationInput { Key = scope.Title.ToString() }
                : new MutationInput { Key = scope.Title.ToString(), Scope = "episodes", Episodes = new[] { new RequestEpisode(scope.Season!.Value, scope.Episode!.Value) } });
            if (input == null) return (RequestOutcome.Refused("invalid_input", 400), null);
            await _requests.Policy.PrepareAsync(viewer.UserId, input, ct).ConfigureAwait(false);
            var facts = _requests.Policy.Evaluate(viewer.UserId, input);
            if (RequestPolicy.Check(facts, null, input, false) is { } refusal)
                return (RequestOutcome.Refused(refusal, RequestPolicy.RefusalStatus(refusal), refusal is "not_visible_to_user" ? "blocked" : "denied"), null);
            // Not this route's to do (nothing searched, not an error): the caller asks for it instead.
            if (!_requests.Ledger.SentCovers(input, facts))
                return (Skipped("not_requested", "Nothing was asked for here yet."), null);
            var instanceId = await _manage.Status.SearchableInstanceAsync(viewer, scope, ct).ConfigureAwait(false);
            if (instanceId == null)
                return (Skipped("not_searchable", "Still looking for it; nothing to search for yet."), null);

            var hours = Math.Clamp(_requests.Policy.Configuration.ArrStatusLookingHours, 1, 720);
            var now = _now();
            var slot = scope.ToString();
            // One search per part per "still looking" period, for the whole household (two presses at once included).
            while (true)
            {
                if (_last.TryGetValue(slot, out var at))
                {
                    if (now - at < TimeSpan.FromHours(hours))
                        return (RequestOutcome.Refused("searched_recently", 429, "blocked") with { Message = "Searched for it a little while ago. We'll keep looking." }, null);
                    if (_last.TryUpdate(slot, now, at)) break;
                }
                else if (_last.TryAdd(slot, now))
                {
                    break;
                }
            }

            var result = await _manage.SearchCheckedAsync(viewer, null, instanceId, scope, "family-" + idempotencyKey, ct).ConfigureAwait(false);
            if (result.Outcome.Status is ArrActionStatus.Succeeded or ArrActionStatus.Unknown)
                return (new RequestOutcome { Reason = "searched", HttpStatus = 200, Message = result.Found == true ? "Found a copy. It's downloading." : "Searched for it." }, result.Found);
            _last.TryRemove(new KeyValuePair<string, DateTimeOffset>(slot, now));
            return (RequestOutcome.Refused("search_failed", 502, "unavailable") with { Message = "Couldn't search right now. Try again later." }, null);
        }

        private static RequestOutcome Skipped(string reason, string message)
            => new() { Outcome = "skipped", Reason = reason, Certainty = ArrActionStatus.Rejected, Message = message, HttpStatus = 200 };
    }
}
