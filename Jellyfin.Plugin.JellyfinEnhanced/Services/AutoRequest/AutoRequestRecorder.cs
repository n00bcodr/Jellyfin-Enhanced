using System;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.AutoRequest
{
    /// <summary>
    /// Where the existing auto-request recipes (next season, next movie in a collection) record what they
    /// decided once "Ask for it" (phase 3) is on: a want in the request ledger, under the same policy, quota
    /// and approval rules as a person's own ask, instead of a direct Seerr request. A Member's automatic ask
    /// waits for an OK in JE mode (nobody self-approves by watching), Kids always wait, Managers and Admins
    /// go straight through. Every outcome is written to the automation log. With phase 3 off it is unused.
    /// </summary>
    public sealed class AutoRequestRecorder
    {
        private readonly RequestService _requests;
        private readonly IArrJellyfinView _view;
        private readonly TitleAliases? _aliases;
        private readonly Func<DateTimeOffset> _now;

        /// <summary>Creates the recorder (DI).</summary>
        public AutoRequestRecorder(RequestService requests, IArrJellyfinView view, TitleAliases aliases)
            : this(requests, view, aliases, () => DateTimeOffset.UtcNow)
        {
        }

        internal AutoRequestRecorder(RequestService requests, IArrJellyfinView view, TitleAliases? aliases, Func<DateTimeOffset> now)
        {
            _requests = requests;
            _view = view;
            _aliases = aliases;
            _now = now;
        }

        /// <summary>True when the recipes record into the ledger: the integration, phase 1 and phase 3 are on.</summary>
        public static bool Active(PluginConfiguration? config) => config is { ArrIntegrationEnabled: true, ArrPhase1Enabled: true, ArrPhase3Enabled: true };

        /// <summary>
        /// Records a want for a person. A refusal by policy (Watcher, quota, parental, a declined ask) is a
        /// definitive no-op; storage being unavailable is a failure that is retried.
        /// </summary>
        /// <param name="recipe">auto_movie or auto_season.</param>
        /// <param name="user">The person the recipe acts for.</param>
        /// <param name="input">The scope to ask for.</param>
        /// <param name="ct">Cancellation.</param>
        public async Task<AutoRequestOutcome> RecordAsync(string recipe, Guid user, MutationInput input, CancellationToken ct)
        {
            var key = input.Key;
            if (_requests.Policy.Configuration.ArrRequestBackend == "status_only") return AutoRequestOutcome.Noop("requests_off", key);
            if (!_requests.Ledger.Database.Available) return AutoRequestOutcome.Failed("database_unavailable", key);
            // The same recipe asking for the same scope again replays its first ask instead of adding another.
            var client = "auto:" + recipe + ":" + key + ":" + input.Scope + ":" + string.Join(",", input.Seasons.Select(s => s.ToString(CultureInfo.InvariantCulture))) + ":" + input.Variant;
            if (client.Length > 128) client = "auto:" + recipe + ":" + input.Fingerprint[..40];
            var outcome = await _requests.CreateAsync(user, new CreateRequest(client, input), ct, RequestOrigin.Automation(recipe)).ConfigureAwait(false);
            if (outcome.HttpStatus < 300)
            {
                return outcome.Reason is "cancelled" or "declined"
                    ? AutoRequestOutcome.Noop("previously_" + outcome.Reason, key)
                    : AutoRequestOutcome.Recorded(outcome.Reason, key, outcome.RequestId);
            }
            return outcome.HttpStatus == 503 ? AutoRequestOutcome.Failed(outcome.Reason, key) : AutoRequestOutcome.Noop(outcome.Reason, key);
        }

        /// <summary>Writes one outcome to the automation log (phase 3 only; never throws).</summary>
        /// <param name="recipe">The recipe.</param>
        /// <param name="user">The person.</param>
        /// <param name="outcome">The outcome.</param>
        public void Log(string recipe, Guid? user, AutoRequestOutcome outcome)
        {
            try
            {
                if (!Active(_requests.Policy.Configuration)) return;
                _requests.Ledger.LogAutomation(recipe, user, outcome.TitleKey, outcome.Code, outcome.Reason, outcome.WantId, _now());
            }
            catch (Exception)
            {
                // The log is diagnostics; a full disk must not stop the recipe worker.
            }
        }

        /// <summary>
        /// The one availability predicate for the recipes (D53, edition round 19 part B): a recipe's ask is a standard request,
        /// so a copy counts only when it plays the standard edition for the person (a stub, a missing item, a copy they can't
        /// open, or with "Standard requests need a non-4K copy" a 4K-only file, does not).
        /// </summary>
        private EditionAvailability Editions => new(_view, () => _requests?.Policy?.Configuration, (k, v) => _view.Copies(k, v, _aliases?.Of(k)).Display);

        /// <summary>
        /// True when the person can already play a copy of the title in Jellyfin (one the lookup saw, finished or not);
        /// null when the copy lookup reached its scan bound without seeing one (not known: the recipe asks nothing now and
        /// decides on its next run).
        /// </summary>
        /// <param name="key">The title.</param>
        /// <param name="user">The person.</param>
        public bool? InLibrary(TitleKey key, Guid user)
        {
            if (_view.Viewer(user) is not { } viewer) return false;
            var copies = _view.Copies(key, viewer, _aliases?.Of(key));
            var editions = Editions;
            if (editions.Movie(viewer, copies.Seen, Edition.Standard, readDimensions: editions.NeedsDimensions(Edition.Standard)).Count > 0) return true;
            return copies.IsComplete ? false : null;
        }

        /// <summary>
        /// How many distinct episodes of one season the person can play (standard edition) across their copies of a series:
        /// grouped versions of an episode once, a multi-episode file every episode it covers; null when the copy lookup
        /// reached its scan bound (as for <see cref="InLibrary"/>).
        /// </summary>
        /// <param name="series">The series.</param>
        /// <param name="season">The season.</param>
        /// <param name="user">The person.</param>
        public int? EpisodesInLibrary(TitleKey series, int season, Guid user)
            => Season(series, season, user) is { } held ? (int)Math.Min(int.MaxValue, held.CountInSeason(season)) : null;

        /// <summary>
        /// True when the person can play (standard edition) every episode 1..<paramref name="count"/> of one season (merged
        /// intervals, never a count compared with a count); false when one is missing; null when the copy lookup reached its
        /// scan bound.
        /// </summary>
        /// <param name="series">The series.</param>
        /// <param name="season">The season.</param>
        /// <param name="count">How many episodes the season has.</param>
        /// <param name="user">The person.</param>
        public bool? SeasonInLibrary(TitleKey series, int season, int count, Guid user)
            => Season(series, season, user) is { } held ? count > 0 && held.Covers(season, 1, count) : null;

        /// <summary>The standard-edition episodes of one season across the person's copies (null: the lookup didn't finish).</summary>
        private EpisodeEditions? Season(TitleKey series, int season, Guid user)
        {
            if (_view.Viewer(user) is not { } viewer) return new EpisodeEditions(Array.Empty<EditionHit>());
            // A copy the lookup didn't reach may hold more of the season: no answer until one finishes.
            var lookup = _view.Copies(series, viewer, _aliases?.Of(series));
            if (!lookup.IsComplete) return null;
            var editions = Editions;
            return editions.Episodes(viewer, lookup.Seen, Edition.Standard, season, readDimensions: editions.NeedsDimensions(Edition.Standard));
        }
    }
}
