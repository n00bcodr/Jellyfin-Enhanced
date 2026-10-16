using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>
    /// Search for people who may ask but don't manage the arrs: runs the arr's own search again for a
    /// movie, one episode, or the episodes of a series or season that requests already sent (by the
    /// caller or anyone in the household) and that have been missing for a long while since (monitored,
    /// out, nothing grabbed for longer than the "still looking" hours). Nothing new is asked for, so it
    /// charges nothing and needs no OK; anything else is asked for through the request API as before.
    /// One search per title part per "still looking" period for the whole household; the arr call is
    /// audited under the caller.
    /// </summary>
    public sealed class RequestSearchService
    {
        /// <summary>The most episodes one Search of a series or season searches (one EpisodeSearch command).</summary>
        internal const int MaxEpisodes = 50;

        /// <summary>Above this many remembered searches, spent ones (older than the longest looking period) are dropped.</summary>
        private const int MaxSlots = 4096;

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
        /// Searches again for <paramref name="key"/> (a movie key, or a series key: alone, with a season, or with a
        /// season and an episode) as <paramref name="viewer"/>. A series or season searches its standard copy's
        /// monitored, aired episodes that are missing for a long while (not here yet, and not hidden from the viewer), at most
        /// <see cref="MaxEpisodes"/>, in one EpisodeSearch, when requests already sent every one of them; of those, only
        /// the ones nobody searched in this "still looking" period. Not this route's to do (outcome <c>skipped</c>, 200,
        /// nothing searched; the caller asks instead): <c>not_requested</c> (nothing was sent for it yet)
        /// and <c>not_searchable</c> (not missing for long enough, or nothing to search). Refusals:
        /// <c>invalid_input</c> (400), the request policy's own (not visible, no requests, <c>low_disk</c> when the
        /// drive of the title's own folder is below the low-disk threshold: the download couldn't be imported, ...),
        /// <c>searched_recently</c> (429) and <c>search_failed</c> (502).
        /// </summary>
        /// <param name="viewer">The caller (a person).</param>
        /// <param name="key">Title key in scope.</param>
        /// <param name="idempotencyKey">One per press.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>The outcome, and whether the search grabbed a copy (null: not known).</returns>
        public async Task<(RequestOutcome Outcome, bool? Found)> SearchAsync(StatusViewer viewer, string? key, string? idempotencyKey, CancellationToken ct)
        {
            if (TitleKey.Parse(key) is not { } scope || (!scope.IsMovie && (scope.Season is < 0 || scope.Episode is < 1 || (scope.Episode != null && scope.Season == null))))
                return (RequestOutcome.Refused("invalid_input", 400), null);
            if (string.IsNullOrWhiteSpace(idempotencyKey) || idempotencyKey.Length > 64)
                return (RequestOutcome.Refused("invalid_input", 400), null);
            var many = !scope.IsMovie && scope.Episode == null;
            // A series or season: exactly its episodes missing for a long while, per standard copy.
            var candidates = many ? await _manage.Status.SearchableEpisodesAsync(viewer, scope, MaxEpisodes, ct).ConfigureAwait(false) : null;
            if (candidates is { Count: 0 })
                return (Skipped("not_searchable", "Still looking for it; nothing to search for yet."), null);
            MutationInput? Input(ArrStatusService.SearchableEpisodes? part) => _requests.NormalizeInput(scope.IsMovie
                ? new MutationInput { Key = scope.Title.ToString() }
                : new MutationInput
                {
                    Key = scope.Title.ToString(), Scope = "episodes",
                    Episodes = part != null ? part.Episodes.Select(e => new RequestEpisode(e.Season, e.Episode)).ToArray() : new[] { new RequestEpisode(scope.Season!.Value, scope.Episode!.Value) },
                });
            var part = candidates?[0];
            var input = Input(part);
            if (input == null) return (RequestOutcome.Refused("invalid_input", 400), null);
            await _requests.Policy.PrepareAsync(viewer.UserId, input, ct).ConfigureAwait(false);
            var facts = _requests.Policy.Evaluate(viewer.UserId, input);
            var target = facts.Backend == "je" ? facts.InstanceId : null;
            if (candidates != null && !string.IsNullOrEmpty(target) && part!.InstanceId != target)
            {
                // Only the standard copy on the request target (JE mode: the instance the sent request went to).
                part = candidates.FirstOrDefault(x => x.InstanceId == target);
                if (part == null) return (Skipped("not_searchable", "Still looking for it; nothing to search for yet."), null);
                input = Input(part)!;
                facts = _requests.Policy.Evaluate(viewer.UserId, input);
            }
            if (RequestPolicy.Check(facts, null, input, false) is { } refusal)
                return (RequestOutcome.Refused(refusal, RequestPolicy.RefusalStatus(refusal), refusal is "not_visible_to_user" or "low_disk" ? "blocked" : "denied"), null);
            // Not this route's to do (nothing searched, not an error): the caller asks for it instead.
            if (!_requests.Ledger.SentCovers(input, facts))
                return (Skipped("not_requested", "Nothing was asked for here yet."), null);
            // Only the standard copy on the request target (JE mode: the instance the sent request went to).
            var (instanceId, sent) = part != null
                ? (part.InstanceId, part.Sent)
                : await _manage.Status.SearchableInstanceAsync(viewer, scope, target, ct).ConfigureAwait(false);
            // Seerr accepts a request that still waits for an OK there: until Seerr OKs it, nothing went out, so
            // the caller asks (and waits) instead of searching around the approval.
            if (facts.Backend == "seerr" && !sent)
                return (Skipped("not_requested", "Nothing was asked for here yet."), null);
            if (instanceId == null)
                return (Skipped("not_searchable", "Still looking for it; nothing to search for yet."), null);

            var hours = Math.Clamp(_requests.Policy.Configuration.ArrStatusLookingHours, 1, 720);
            var now = _now();
            // One search per part (the movie, or each episode, under the title's canonical key whichever id the page
            // used) per "still looking" period, for the whole household, two presses at once included: a series or
            // season searches only its episodes nobody searched in that period, and is refused when that leaves none.
            var title = TitleKey.Parse(input.Key)!;
            var parts = part != null
                ? part.Episodes.Select(e => (Slot: title.WithEpisode(e.Season, e.Episode).ToString(), Id: (int?)e.Id)).ToList()
                : new List<(string Slot, int? Id)> { ((scope.IsMovie ? title : title.WithEpisode(scope.Season!.Value, scope.Episode!.Value)).ToString(), null) };
            // Slots of searches older than any looking period are spent: drop them so the map stays small.
            if (_last.Count > MaxSlots)
            {
                foreach (var old in _last.Where(x => now - x.Value >= TimeSpan.FromHours(720))) _last.TryRemove(old);
            }
            var claimed = parts.Where(p => Claim(p.Slot, now, hours)).ToList();
            if (claimed.Count == 0)
                return (RequestOutcome.Refused("searched_recently", 429, "blocked") with { Message = "Searched for it a little while ago. We'll keep looking." }, null);

            var result = part != null
                ? await _manage.SearchEpisodesCheckedAsync(viewer, null, instanceId, scope, claimed.Select(p => p.Id!.Value).ToArray(), "family-" + idempotencyKey, ct).ConfigureAwait(false)
                : await _manage.SearchCheckedAsync(viewer, null, instanceId, scope, "family-" + idempotencyKey, ct).ConfigureAwait(false);
            if (result.Outcome.Status is ArrActionStatus.Succeeded or ArrActionStatus.Unknown)
                return (new RequestOutcome { Reason = "searched", HttpStatus = 200, Message = result.Found == true ? "Found a copy. It's downloading." : "Searched for it." }, result.Found);
            foreach (var p in claimed) _last.TryRemove(new KeyValuePair<string, DateTimeOffset>(p.Slot, now));
            return (RequestOutcome.Refused("search_failed", 502, "unavailable") with { Message = "Couldn't search right now. Try again later." }, null);
        }

        /// <summary>Takes a part's search slot for this "still looking" period; false when it was searched within it.</summary>
        private bool Claim(string slot, DateTimeOffset now, int hours)
        {
            while (true)
            {
                if (_last.TryGetValue(slot, out var at))
                {
                    if (now - at < TimeSpan.FromHours(hours)) return false;
                    if (_last.TryUpdate(slot, now, at)) return true;
                }
                else if (_last.TryAdd(slot, now))
                {
                    return true;
                }
            }
        }

        private static RequestOutcome Skipped(string reason, string message)
            => new() { Outcome = "skipped", Reason = reason, Certainty = ArrActionStatus.Rejected, Message = message, HttpStatus = 200 };
    }
}
