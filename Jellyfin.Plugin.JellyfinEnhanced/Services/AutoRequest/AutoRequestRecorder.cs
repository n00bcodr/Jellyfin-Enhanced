using System;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.AutoRequest
{
    /// <summary>
    /// Where the existing auto-request recipes (next season, next movie in a collection) record what they
    /// decided once "Ask for it" (phase 3) is on: a want in the request ledger, under the same policy, quota
    /// and approval rules as a person's own ask, instead of a direct Seerr request. A Member's automatic ask
    /// waits for an OK in JE mode (nobody self-approves by watching), Kids always wait, Managers and Admins
    /// go straight through. Every outcome is written to the automation log. With phase 3 off it is unused.
    /// <para>
    /// With the phase-4 automation engine on, the recipe's mode decides: Off does nothing, Shadow records what it would
    /// have done (the no-write decision seam) and nothing else, Ask always creates a pending approval, Auto asks under
    /// the usual rules, and only an eligible person's (administrators, Trusted, recorded grants) go ahead without an OK.
    /// Kill switches stop new requests; a person who opted out of the recipe is skipped. The rollout Shadow override
    /// turns every mode into Shadow, with or without the engine.
    /// </para>
    /// </summary>
    public sealed class AutoRequestRecorder
    {
        private readonly RequestService _requests;
        private readonly IArrJellyfinView _view;
        private readonly TitleAliases? _aliases;
        private readonly Func<DateTimeOffset> _now;
        private readonly AutomationDecider? _decider;
        private readonly AutomationStore? _store;
        private readonly IAutomationConsents? _consents;

        /// <summary>Creates the recorder (DI).</summary>
        public AutoRequestRecorder(RequestService requests, IArrJellyfinView view, TitleAliases aliases, AutomationDecider decider, AutomationStore store, IAutomationConsents consents)
            : this(requests, view, aliases, () => DateTimeOffset.UtcNow, decider, store, consents)
        {
        }

        internal AutoRequestRecorder(RequestService requests, IArrJellyfinView view, TitleAliases? aliases, Func<DateTimeOffset> now,
            AutomationDecider? decider = null, AutomationStore? store = null, IAutomationConsents? consents = null)
        {
            _requests = requests;
            _view = view;
            _aliases = aliases;
            _now = now;
            _decider = decider;
            _store = store;
            _consents = consents;
        }

        /// <summary>True when the recipes record into the ledger: the integration, phase 1 and phase 3 are on.</summary>
        public static bool Active(PluginConfiguration? config) => config is { ArrIntegrationEnabled: true, ArrPhase1Enabled: true, ArrPhase3Enabled: true };

        /// <summary>The id an automatic ask of a recipe uses: the same recipe asking for the same scope again replays its first ask.</summary>
        /// <param name="recipe">The recipe.</param>
        /// <param name="input">The scope.</param>
        internal static string ClientId(string recipe, MutationInput input)
        {
            var client = "auto:" + recipe + ":" + input.Key + ":" + input.Scope + ":" + string.Join(",", input.Seasons.Select(s => s.ToString(CultureInfo.InvariantCulture))) + ":" + input.Variant;
            return client.Length > 128 ? "auto:" + recipe + ":" + input.Fingerprint[..40] : client;
        }

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
            // The mode, kills and consent are read first and the request service's preparation reads come after. A change
            // in between is read again right before the ledger write, and the ask starts over under the current rules
            // instead of being recorded under the old ones. A switch flipped back and forth leaves it to the next trigger.
            for (var attempt = 0; attempt < 3; attempt++)
            {
                if (await RecordOnceAsync(recipe, user, input, ct).ConfigureAwait(false) is { } outcome) return outcome;
            }
            return AutoRequestOutcome.Failed(AutomationHolds.EngineChanged, input.Key);
        }

        // One attempt; null when the rules changed before the ledger write.
        private async Task<AutoRequestOutcome?> RecordOnceAsync(string recipe, Guid user, MutationInput input, CancellationToken ct)
        {
            var key = input.Key;
            var config = _requests.Policy.Configuration;
            if (config.ArrRequestBackend == "status_only") return AutoRequestOutcome.Noop("requests_off", key);
            if (!_requests.Ledger.Database.Available) return AutoRequestOutcome.Failed("database_unavailable", key);
            var client = ClientId(recipe, input);
            var control = AutomationFlags.Control(config, recipe);
            var consented = AutomationConsent.Allows(_consents, user, recipe);
            string? Changed() => AutomationFlags.Control(_requests.Policy.Configuration, recipe) != control || AutomationConsent.Allows(_consents, user, recipe) != consented
                ? AutomationHolds.EngineChanged : null;
            if (control.Legacy || _decider == null || _store == null)
            {
                // The same recipe asking for the same scope again replays its first ask instead of adding another.
                var legacy = await _requests.CreateAsync(user, new CreateRequest(client, input), ct, RequestOrigin.Automation(recipe), Changed).ConfigureAwait(false);
                return Restart(legacy) ? null : Outcome(legacy, key);
            }

            var origin = RequestOrigin.Automation(recipe) with { Provenance = new RequestProvenance(Recipe: recipe, TriggerIdentity: client) };
            var decisionKey = recipe + "|" + user.ToString("N") + "|" + client;
            var backend = config.ArrRequestBackend;
            var mode = control.Stored ?? AutomationMode.Shadow;
            if (control.Effective == AutomationMode.Off)
            {
                if (control.Reason == AutomationHolds.Killed) _store.Record(new AutomationDecision(decisionKey, recipe, user, key, mode, "killed", AutomationHolds.Killed, backend), _now());
                return AutoRequestOutcome.Noop(control.Reason ?? "recipe_off", key);
            }

            if (!consented)
            {
                _store.Record(new AutomationDecision(decisionKey, recipe, user, key, control.Effective!.Value, "opted_out", "user_opted_out", backend), _now());
                return AutoRequestOutcome.Noop("user_opted_out", key);
            }

            if (control.Effective == AutomationMode.Shadow)
            {
                // Decide and record only: no want, approval, reservation, job or upstream call.
                var decision = await _decider.DecideAsync(decisionKey, recipe, user, client, input, origin, AutomationMode.Shadow, ct).ConfigureAwait(false);
                if (control.Reason == AutomationHolds.ShadowOverride) decision = decision with { Detail = (decision.Detail ?? new AutomationDecisionDetail()) with { ShadowOverride = true } };
                _store.Record(decision, _now());
                return decision.Outcome == "deferred" ? AutoRequestOutcome.Failed(decision.Reason, key) : AutoRequestOutcome.Noop("shadow_" + decision.Outcome, key);
            }

            var (asked, approval) = _decider.OriginFor(origin, control.Effective!.Value, user, input);
            var outcome = await _requests.CreateAsync(user, new CreateRequest(client, input), ct, asked, Changed).ConfigureAwait(false);
            if (Restart(outcome)) return null;
            var result = Outcome(outcome, key);
            var status = outcome.RequestId == null ? null : _requests.Ledger.Find(outcome.RequestId)?.Status;
            var label = result.Kind switch
            {
                AutoRequestOutcomeKind.WantRecorded => status == "pending" ? "asked" : "recorded",
                AutoRequestOutcomeKind.PreparationFailed => "deferred",
                _ when outcome.Reason == AutomationHolds.Killed => "killed",
                _ => outcome.HttpStatus < 300 ? "already_recorded" : "blocked",
            };
            _store.Record(new AutomationDecision(decisionKey, recipe, user, key, control.Effective.Value, label, outcome.Reason, backend,
                new AutomationDecisionDetail { Status = status, Approval = status == "pending" ? approval ?? outcome.Reason : null, Scope = input.Scope, Variant = input.Variant, Seasons = input.Seasons.Length == 0 ? null : input.Seasons }), _now());
            return result;
        }

        // The create stopped because the rules changed during its preparation reads (nothing recorded).
        private static bool Restart(RequestOutcome outcome) => outcome.RequestId == null && outcome.Reason == AutomationHolds.EngineChanged;

        private static AutoRequestOutcome Outcome(RequestOutcome outcome, string key)
        {
            if (outcome.HttpStatus < 300)
            {
                return outcome.Reason is "cancelled" or "declined"
                    ? AutoRequestOutcome.Noop("previously_" + outcome.Reason, key)
                    : AutoRequestOutcome.Recorded(outcome.Reason, key, outcome.RequestId);
            }
            return outcome.HttpStatus == 503 ? AutoRequestOutcome.Failed(outcome.Reason, key) : AutoRequestOutcome.Noop(outcome.Reason, key);
        }

        /// <summary>
        /// The rollout Shadow override on the existing recipes' direct Seerr path (phase 3 off): what the recipe would have
        /// asked Seerr for is recorded as a Shadow decision (when the database is available) and nothing is sent. True when
        /// the override is on: the caller then stops.
        /// </summary>
        /// <param name="recipe">The recipe.</param>
        /// <param name="user">The person.</param>
        /// <param name="titleKey">The title it would have asked for, when known.</param>
        /// <param name="season">The season (next-season keeper).</param>
        public bool ShadowOverride(string recipe, Guid user, string? titleKey, int? season = null)
        {
            if (!AutomationFlags.ShadowOverride(_requests.Policy.Configuration)) return false;
            _store?.Record(new AutomationDecision(recipe + "|" + user.ToString("N") + "|seerr:" + titleKey + ":" + season?.ToString(CultureInfo.InvariantCulture), recipe, user, titleKey,
                AutomationMode.Shadow, "would_request", AutomationHolds.ShadowOverride, "seerr_direct",
                new AutomationDecisionDetail { WouldSend = true, ShadowOverride = true, Seasons = season.HasValue ? new[] { season.Value } : null }), _now());
            return true;
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

        /// <summary>True when the person can already open a copy of the title in Jellyfin.</summary>
        /// <param name="key">The title.</param>
        /// <param name="user">The person.</param>
        public bool InLibrary(TitleKey key, Guid user)
            => _view.Viewer(user) is { } viewer && _view.Copies(key, viewer, _aliases?.Of(key)).Any(c => c.Visible);

        /// <summary>The most episodes of one season any of the person's copies of a series holds (files only).</summary>
        /// <param name="series">The series.</param>
        /// <param name="season">The season.</param>
        /// <param name="user">The person.</param>
        public int EpisodesInLibrary(TitleKey series, int season, Guid user)
        {
            if (_view.Viewer(user) is not { } viewer) return 0;
            var copies = _view.Copies(series, viewer, _aliases?.Of(series)).Where(c => c.Visible).ToList();
            return copies.Count == 0 ? 0 : copies.Max(c => _view.Episodes(c.ItemId, season, viewer, false).Count);
        }
    }
}
