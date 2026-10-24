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
        /// <summary>
        /// The most episodes one Search of a series or season searches (one EpisodeSearch command): the first ones nobody
        /// searched in this "still looking" period, so the next press searches the next ones.
        /// </summary>
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
        /// monitored, aired episodes that are missing for a long while (not here yet, and not hidden from the viewer) and
        /// that nobody searched in this "still looking" period, the first <see cref="MaxEpisodes"/> of them in episode
        /// order, in one EpisodeSearch, when requests already sent every one of them (a longer series gets its next ones
        /// on the next press). Not this route's to do (outcome <c>skipped</c>, 200,
        /// nothing searched; the caller asks instead): <c>not_requested</c> (nothing was sent for it yet)
        /// and <c>not_searchable</c> (not missing for long enough, or nothing to search). Refusals:
        /// <c>invalid_input</c> (400), the request policy's own (not visible, no requests, <c>low_disk</c> when the
        /// drive of the title's own folder is below the low-disk threshold: the download couldn't be imported, ...),
        /// <c>searched_recently</c> (429: every part in scope was searched in this period) and <c>search_failed</c> (502).
        /// </summary>
        /// <param name="viewer">The caller (a person).</param>
        /// <param name="key">Title key in scope.</param>
        /// <param name="idempotencyKey">One per press.</param>
        /// <param name="ct">Cancellation.</param>
        /// <param name="expect">
        /// From a season page: what the control was drawn to do (D53, edition round 19: the server decides every press). It
        /// is worked out again after the arr reads, right before the search command; a difference searches nothing (409
        /// <c>press_changed</c>) and leaves its parts free. A season key's search is limited to the episodes it names.
        /// </param>
        /// <returns>The outcome, and whether the search grabbed a copy (null: not known).</returns>
        /// <param name="pages">Synthetic absent pages (a press from one is checked as that page).</param>
        public async Task<(RequestOutcome Outcome, bool? Found)> SearchAsync(StatusViewer viewer, string? key, string? idempotencyKey, CancellationToken ct, PressIntent? expect = null, IAbsentTitlePages? pages = null)
        {
            if (TitleKey.Parse(key) is not { } scope || (!scope.IsMovie && (scope.Season is < 0 || scope.Episode is < 1 || (scope.Episode != null && scope.Season == null))))
                return (RequestOutcome.Refused("invalid_input", 400), null);
            if (string.IsNullOrWhiteSpace(idempotencyKey) || idempotencyKey.Length > 64)
                return (RequestOutcome.Refused("invalid_input", 400), null);
            // The request's whole identity (D53, edition round 22): a season page's press by its fingerprint, else this route and
            // its key. It is the person's key, shared with every other route (no namespace of the household's own), and it has
            // one owner at a time from here on: an identical request meanwhile claims nothing and gets the owner's answer.
            string identity;
            string? fingerprint = null;
            if (expect != null)
            {
                fingerprint = PressChecks.RequestFingerprint(expect, PressChecks.Household, scope, null);
                if (fingerprint == null) return (RequestOutcome.Refused(PressChecks.Changed, 409, "conflict") with { Message = PressChecks.Message(PressChecks.Changed) }, null);
                identity = PressChecks.IncomingIdentity(PressChecks.Household, scope, expect);
            }
            else identity = PressChecks.IncomingIdentity(PressChecks.Household, scope, null);
            return await _manage.Runner.SingleFlightAsync(viewer.UserId, idempotencyKey, identity,
                token => SearchOwnedAsync(viewer, scope, idempotencyKey, identity, fingerprint, token, expect, pages),
                () => (RequestOutcome.Refused(PressChecks.Conflict, 409, "conflict") with { Message = PressChecks.Message(PressChecks.Conflict) }, (bool?)null), ct).ConfigureAwait(false);
        }

        // The owner of the person's key (see SearchAsync): replay, checks, candidates, claims and the one command.
        private async Task<(RequestOutcome Outcome, bool? Found)> SearchOwnedAsync(StatusViewer viewer, TitleKey scope, string idempotencyKey, string identity, string? fingerprint, CancellationToken ct, PressIntent? expect, IAbsentTitlePages? pages)
        {
            var many = !scope.IsMovie && scope.Episode == null;
            var hours = Math.Clamp(_requests.Policy.Configuration.ArrStatusLookingHours, 1, 720);
            var now = _now();
            // Search slots are kept under the title's canonical key, whichever id the page used.
            var title = _requests.CanonicalTitle(scope.Title);
            MutationInput? Input(ArrStatusService.SearchableEpisodes? part) => _requests.NormalizeInput(scope.IsMovie
                ? new MutationInput { Key = scope.Title.ToString() }
                : new MutationInput
                {
                    Key = scope.Title.ToString(), Scope = "episodes",
                    Episodes = part != null ? part.Episodes.Select(e => new RequestEpisode(e.Season, e.Episode)).ToArray()
                        : new[] { new RequestEpisode(scope.Season ?? 1, scope.Episode ?? 1) },
                });
            // The policy's facts for the title are prepared first (they await): the candidates are worked out after them, for the
            // viewer as they are then (D53, edition round 19: a household Search never reuses candidates chosen before an await).
            var probe = Input(null);
            if (probe == null) return (RequestOutcome.Refused("invalid_input", 400), null);

            // A retry of the identical request whose search already ran (its answer was lost) gets that outcome before anything is
            // checked again or claimed (round 20: replay before revalidation; the route's own checks were made); the same key used
            // for anything else is refused (D53, edition rounds 21-22).
            if (await _manage.ReplayPressAsync(viewer.UserId, idempotencyKey, identity, ct).ConfigureAwait(false) is { } replayed)
            {
                if (replayed.Conflict) return (RequestOutcome.Refused(PressChecks.Conflict, 409, "conflict") with { Message = PressChecks.Message(PressChecks.Conflict) }, null);
                if (replayed.Status is ArrActionStatus.Succeeded or ArrActionStatus.Unknown)
                    return (new RequestOutcome { Reason = "searched", HttpStatus = 200, Certainty = replayed.Status, Message = replayed.Status == ArrActionStatus.Unknown ? "The search may have run. Check it before trying again." : "Searched for it." }, null);
                return (RequestOutcome.Refused("search_failed", 502, "unavailable") with { Message = "Couldn't search right now. Try again later." }, null);
            }
            await _requests.Policy.PrepareAsync(viewer.UserId, probe, ct).ConfigureAwait(false);
            // A season page's press that no longer matches is refused before anything else (nothing claimed, nothing asked for
            // instead); it is worked out again right before the command too.
            if (expect != null && (await _manage.Status.PressAsync(viewer, expect, PressChecks.Household, null, scope, ct, pages, resolve: false).ConfigureAwait(false)).Refusal is { } early)
                return (RequestOutcome.Refused(early, 409, "conflict") with { Message = PressChecks.Message(early) }, null);
            // A series or season: exactly its episodes missing for a long while, per standard copy, the first ones nobody
            // searched in this period (a peek: the claims below still decide), so a long series doesn't get the same
            // first MaxEpisodes searched on every press while the rest never are. A season page's press: only the ones it names.
            var named = expect != null && many ? PressChecks.Numbers(scope, expect).ToHashSet() : null;
            var candidates = many
                ? await _manage.Status.SearchableEpisodesAsync(viewer, scope, MaxEpisodes, (s, e) => Searched(title.WithEpisode(s, e).ToString(), now, hours), ct).ConfigureAwait(false)
                : null;
            if (candidates != null && named != null)
            {
                candidates = candidates.Select(c => c with { Episodes = c.Episodes.Where(e => e.Season == scope.Season && named.Contains(e.Episode)).ToList() })
                    .Where(c => c.Episodes.Count > 0).ToList();
            }
            if (candidates is { Count: 0 })
                return (Skipped("not_searchable", "Still looking for it; nothing to search for yet."), null);
            var part = candidates?[0];
            var input = Input(part);
            if (input == null) return (RequestOutcome.Refused("invalid_input", 400), null);
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

            // One search per part (the movie, or each episode, under the title's canonical key whichever id the page
            // used) per "still looking" period, for the whole household, two presses at once included: a series or
            // season searches only its episodes nobody searched in that period, and is refused when that leaves none.
            var parts = part != null
                ? part.Episodes.Select(e => (Slot: title.WithEpisode(e.Season, e.Episode).ToString(), Id: (int?)e.Id, Episode: (int?)e.Episode)).ToList()
                : new List<(string Slot, int? Id, int? Episode)> { ((scope.IsMovie ? title : title.WithEpisode(scope.Season!.Value, scope.Episode!.Value)).ToString(), null, scope.Episode) };
            // Slots of searches older than any looking period are spent: drop them so the map stays small.
            if (_last.Count > MaxSlots)
            {
                foreach (var old in _last.Where(x => now - x.Value >= TimeSpan.FromHours(720))) _last.TryRemove(old);
            }
            var claimed = parts.Where(p => Claim(p.Slot, now, hours)).ToList();
            if (claimed.Count == 0)
                return (RequestOutcome.Refused("searched_recently", 429, "blocked") with { Message = "Searched for it a little while ago. We'll keep looking." }, null);

            // A search that didn't run leaves its parts free for the next press: one that failed or was refused, and one
            // whose caller went away before the arr's search started (the reads before it follow the caller; once
            // started, the search runs to the end on its own).
            void Release()
            {
                _requests.Ledger.Database.RetryOwners.ReleaseSearch(claimed.Select(p => p.Slot));
                foreach (var p in claimed) _last.TryRemove(new KeyValuePair<string, DateTimeOffset>(p.Slot, now));
            }
            // Right before the command (after the arr reads): the season page's press worked out again (without one, the viewer
            // the candidates were chosen for must still be the viewer as Jellyfin has them now), and a sent request still covers
            // what is searched (D53, edition round 19: re-derived at the transport boundary, nothing reused across an await).
            MutationInput searched = input;
            Func<CancellationToken, Task<string?>> recheck = _ =>
            {
                var refusal = _requests.View.Viewer(viewer.UserId) is { } still && still.IsAdmin == viewer.IsAdmin && still.PolicyRevision == viewer.PolicyRevision ? null : PressChecks.Changed;
                return Task.FromResult(refusal ?? (_requests.Ledger.SentCovers(searched, _requests.Policy.Evaluate(viewer.UserId, searched)) ? null : PressChecks.Changed));
            };
            // A season page's press (D53, edition round 21): the check returns the command, which searches exactly the episodes
            // claimed here, by the Sonarr ids of the episode list read at the check, on the copy's own Sonarr; nothing chosen
            // above (the candidates' ids) is sent.
            var subset = claimed.Select(p => p.Episode).OfType<int>().ToArray();
            Func<CancellationToken, Task<PressProof>> check = async token =>
            {
                var proof = await _manage.Status.PressAsync(viewer, expect!, PressChecks.Household, null, scope, token, pages, subset, instanceId).ConfigureAwait(false);
                return proof.Refusal != null || _requests.Ledger.SentCovers(searched, _requests.Policy.Evaluate(viewer.UserId, searched)) ? proof : PressProof.Changed;
            };
            ManageSearchResult result;
            try
            {
                result = expect != null
                    ? await _manage.SearchCommandAsync(viewer, null, instanceId, scope, idempotencyKey, fingerprint!, check, ct, owned: true, incomingIdentity: identity).ConfigureAwait(false)
                    : part != null
                    ? await _manage.SearchEpisodesPressAsync(viewer, null, instanceId, scope, claimed.Select(p => p.Id!.Value).ToArray(), idempotencyKey, recheck, ct, owned: true, identity: identity).ConfigureAwait(false)
                    : await _manage.SearchPressAsync(viewer, null, instanceId, scope, null, idempotencyKey, recheck, ct, owned: true, identity: identity).ConfigureAwait(false);
            }
            catch
            {
                Release();
                throw;
            }
            if (result.Outcome.Status is ArrActionStatus.Succeeded or ArrActionStatus.Unknown)
                return (new RequestOutcome { Reason = "searched", HttpStatus = 200, Certainty = result.Outcome.Status, Message = result.Outcome.Status == ArrActionStatus.Unknown ? "The search may have run. Check it before trying again." : result.Found == true ? "Found a copy. It's downloading." : "Searched for it." }, result.Found);
            Release();
            // A press refusal: nothing was searched and its parts are free again; the page redraws and says so.
            if (result.Refusal is { } pressRefusal)
                return (RequestOutcome.Refused(pressRefusal, 409, "conflict") with { Message = PressChecks.Message(pressRefusal) }, null);
            return (RequestOutcome.Refused("search_failed", 502, "unavailable") with { Message = "Couldn't search right now. Try again later." }, null);
        }

        /// <summary>Whether a part was searched within this "still looking" period (a peek; <see cref="Claim"/> decides).</summary>
        private bool Searched(string slot, DateTimeOffset now, int hours)
            => _requests.Ledger.Database.RetryOwners.SearchClaimed(slot, now, hours);

        /// <summary>Takes a part's search slot for this "still looking" period; false when it was searched within it.</summary>
        private bool Claim(string slot, DateTimeOffset now, int hours)
        {
            if (!_requests.Ledger.Database.RetryOwners.ClaimSearch(slot, now, hours)) return false;
            _last[slot] = now; // bounded diagnostics only; the database owns authorisation and release.
            return true;
        }

        private static RequestOutcome Skipped(string reason, string message)
            => new() { Outcome = "skipped", Reason = reason, Certainty = ArrActionStatus.Rejected, Message = message, HttpStatus = 200 };
    }
}
