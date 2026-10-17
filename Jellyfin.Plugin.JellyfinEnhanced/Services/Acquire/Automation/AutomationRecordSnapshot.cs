using System;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation
{
    /// <summary>
    /// Every live setting a recorded automatic intent depends on, captured when a recipe decides what to record. The
    /// recorder takes it again right before the ledger write and before a Shadow decision is saved, and compares the two
    /// as a whole: any difference (whatever changed during the awaited preparation reads) starts the ask over under the
    /// current rules, so nothing is ever recorded under settings that no longer apply. Record equality compares every
    /// field; a new setting the recorder decides on belongs here.
    /// </summary>
    /// <param name="SwitchedOn">An old recipe's own switch (Auto Movie / Auto Season Request); true for the others.</param>
    /// <param name="Engine">The automation engine is in effect.</param>
    /// <param name="Mode">The recipe's stored mode (null without the engine).</param>
    /// <param name="Effective">What the recipe does now (null: the existing behaviour applies).</param>
    /// <param name="Why">Why it doesn't act as stored (shadow_override, recipe_off, requests_off, ...).</param>
    /// <param name="ShadowOverride">The rollout Shadow override.</param>
    /// <param name="KilledAll">The global kill switch.</param>
    /// <param name="KilledRecipe">The recipe's kill switch.</param>
    /// <param name="KilledTarget">The kill switch of the target the request would go to.</param>
    /// <param name="Consented">The person's consent to the recipe.</param>
    /// <param name="Free">Automatic requests are free (they cost nobody's allowance).</param>
    /// <param name="Eligibility">Why the person may have automatic requests go ahead without an OK (admin, trusted, grant), or null.</param>
    /// <param name="Backend">Who handles requests (je, seerr, status_only).</param>
    /// <param name="Target">The instance the request would go to, or <c>seerr</c>.</param>
    public sealed record AutomationRecordSnapshot(
        bool SwitchedOn, bool Engine, AutomationMode? Mode, AutomationMode? Effective, string? Why, bool ShadowOverride,
        bool KilledAll, bool KilledRecipe, bool KilledTarget, bool Consented, bool Free, string? Eligibility, string Backend, string? Target)
    {
        /// <summary>The snapshot for a recipe's ask for a person, read now (memory only, no await).</summary>
        /// <param name="config">The live configuration.</param>
        /// <param name="recipe">The recipe.</param>
        /// <param name="user">The person.</param>
        /// <param name="input">The scope.</param>
        /// <param name="policy">Request policy (role, target).</param>
        /// <param name="consents">Per-person consents.</param>
        /// <param name="eligibility">Eligibility (null: none known).</param>
        public static AutomationRecordSnapshot Take(PluginConfiguration config, string recipe, Guid user, MutationInput input, IRequestPolicy policy, IAutomationConsents? consents, AutomationEligibility? eligibility)
        {
            var control = AutomationFlags.Control(config, recipe);
            var backend = config.ArrRequestBackend ?? string.Empty;
            var target = backend == "seerr" ? AutomationFlags.SeerrTarget : TitleKey.Parse(input.Key) == null ? null : policy.JeTarget(user, input).InstanceId;
            var eligible = control.Engine && eligibility != null ? eligibility.Why(user, policy.Evaluate(user, input).Role) : null;
            return new(AutomationRecipes.SwitchedOn(config, recipe), control.Engine, control.Stored, control.Effective, control.Reason, AutomationFlags.ShadowOverride(config),
                AutomationFlags.KilledAll(config), AutomationModes.Killed(config, recipe), AutomationFlags.KilledTarget(config, target),
                AutomationConsent.Allows(consents, user, recipe), config.ArrAutomationFree, eligible, backend, target);
        }
    }
}
