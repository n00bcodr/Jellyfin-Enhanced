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
        /// True when the person can already open a copy of the title in Jellyfin (one the lookup saw, finished or not);
        /// null when the copy lookup reached its scan bound without seeing one (not known: the recipe asks nothing now and
        /// decides on its next run).
        /// </summary>
        /// <param name="key">The title.</param>
        /// <param name="user">The person.</param>
        public bool? InLibrary(TitleKey key, Guid user)
        {
            if (_view.Viewer(user) is not { } viewer) return false;
            var copies = _view.Copies(key, viewer, _aliases?.Of(key));
            return copies.SeenOpenable != null ? true : copies.IsComplete ? false : null;
        }

        /// <summary>
        /// The most episodes of one season any of the person's copies of a series holds (files only); null when the copy
        /// lookup reached its scan bound (as for <see cref="InLibrary"/>).
        /// </summary>
        /// <param name="series">The series.</param>
        /// <param name="season">The season.</param>
        /// <param name="user">The person.</param>
        public int? EpisodesInLibrary(TitleKey series, int season, Guid user)
        {
            if (_view.Viewer(user) is not { } viewer) return 0;
            // A copy the lookup didn't reach may hold more of the season: no answer until one finishes.
            var lookup = _view.Copies(series, viewer, _aliases?.Of(series));
            if (!lookup.IsComplete) return null;
            var copies = lookup.Seen.Where(c => c.Visible).ToList();
            return copies.Count == 0 ? 0 : copies.Max(c => _view.Episodes(c.ItemId, season, viewer, false).Count);
        }
    }
}
