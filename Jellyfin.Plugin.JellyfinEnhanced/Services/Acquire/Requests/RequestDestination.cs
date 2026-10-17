using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>
    /// Where a request goes, and the one rule for when one request may stand for another (phase 4b). Every ledger and
    /// charges path where a request covers, dedups, suppresses, merges with, follows or represents another one goes
    /// through it, and so does every approval that re-confirms or edits one.
    /// <para>A destination has two parts:</para>
    /// <list type="bullet">
    /// <item>The target: the backend, the arr instance and its connection, or the Seerr source (<c>RequestLedger.TargetKey</c>).
    /// Its place is the same without the connection generation (a new arr key is the same arr).</item>
    /// <item>For a request with administrator Seerr options: Seerr's server, quality profile, root folder (the same path)
    /// and the options stamp the choice was made against.</item>
    /// </list>
    /// <para>Which parts must match where:</para>
    /// <list type="bullet">
    /// <item>Standing for another request (<see cref="Serves(MutationInput, MutationInput)"/>): the same target, title and
    /// edition; a chosen arr instance only with that instance or none; and when the wanted request has Seerr options, the
    /// same server, profile, root folder and stamp. A request without options goes wherever Seerr picks, so any request
    /// at the target serves it, while it never serves a choice.</item>
    /// <item>A stamp-only difference never serves (Q-4BFIX2-1), but it is the one change an approval may re-confirm
    /// (<see cref="Approval"/>).</item>
    /// <item>Work already sent never moves to another place, and never to other options or a scope that drops it.</item>
    /// </list>
    /// </summary>
    internal static class RequestDestination
    {
        /// <summary>What an approval changes about a request's input.</summary>
        internal enum Change
        {
            /// <summary>Nothing.</summary>
            None,
            /// <summary>Only the Seerr options stamp (the same server, profile and root folder chosen again).</summary>
            StampOnly,
            /// <summary>Anything else: scope, edition, routing.</summary>
            Other,
        }

        /// <summary>The same target: backend, instance, connection and Seerr source.</summary>
        /// <param name="a">A target key.</param>
        /// <param name="b">Another target key.</param>
        internal static bool SameTarget(string? a, string? b) => string.Equals(a, b, StringComparison.Ordinal);

        /// <summary>
        /// A target key without its connection generation: the backend, the instance and the Seerr source (a Seerr target
        /// has no generation, so its place is its target).
        /// </summary>
        /// <param name="target">A target key.</param>
        internal static string Place(string target)
        {
            try
            {
                var parts = JsonSerializer.Deserialize<string?[]>(target);
                if (parts is { Length: 4 }) return JsonSerializer.Serialize(new[] { parts[0], parts[1], parts[3] });
            }
            catch (JsonException)
            {
                // Not a target key: compared as it is.
            }
            return target;
        }

        /// <summary>
        /// Where a request actually goes, as a policy sees it (who may see it there): its own input, an arr folder or a
        /// Seerr choice included, at the arr instance its target names (Jellyfin Enhanced handling; Seerr picks its own).
        /// </summary>
        /// <param name="input">The request's input.</param>
        /// <param name="target">Its target key.</param>
        internal static MutationInput Of(MutationInput input, string target)
        {
            if (input.InstanceId != null) return input;
            try
            {
                var parts = JsonSerializer.Deserialize<string?[]>(target);
                if (parts is { Length: 4 } && parts[0] == "je" && !string.IsNullOrEmpty(parts[1])) return input with { InstanceId = parts[1] };
            }
            catch (JsonException)
            {
                // Not a target key (an unresolved one): the input as it is.
            }
            return input;
        }

        /// <summary>The same place (<see cref="Place"/>): another connection of the same arr instance or Seerr counts.</summary>
        /// <param name="a">A target key.</param>
        /// <param name="b">Another target key.</param>
        internal static bool SamePlace(string a, string b) => string.Equals(Place(a), Place(b), StringComparison.Ordinal);

        /// <summary>
        /// Both inputs carry the same administrator Seerr options: server, quality profile, root folder (the same path) and
        /// the options stamp (the server's facts and where Seerr reaches it).
        /// </summary>
        /// <param name="a">An input.</param>
        /// <param name="b">Another input.</param>
        internal static bool SameOptions(MutationInput a, MutationInput b)
            => a.SeerrServerId == b.SeerrServerId && a.SeerrProfileId == b.SeerrProfileId && a.SeerrRootFolder != null && b.SeerrRootFolder != null
               && BridgePaths.SamePath(a.SeerrRootFolder, b.SeerrRootFolder) && string.Equals(a.SeerrOptions, b.SeerrOptions, StringComparison.OrdinalIgnoreCase);

        /// <summary>
        /// Seerr's own record of a request (its server, profile and root folder; Seerr keeps no stamp) is where
        /// <paramref name="input"/>'s options chose.
        /// </summary>
        /// <param name="input">The input with Seerr options.</param>
        /// <param name="server">Seerr's server id on the record.</param>
        /// <param name="profile">Seerr's profile id on the record.</param>
        /// <param name="root">Seerr's root folder on the record.</param>
        internal static bool SeerrHas(MutationInput input, int? server, int? profile, string? root)
            => server == input.SeerrServerId && profile == input.SeerrProfileId && root != null && input.SeerrRootFolder != null && BridgePaths.SamePath(root, input.SeerrRootFolder);

        /// <summary>
        /// The same title (Q-4BFIX3-2): the same key. Every key the ledger stores is its title's canonical key and every key
        /// that comes in is resolved through the ledger's aliases first (<c>RequestLedger.Canonical</c>), so one title asked
        /// for by any of its ids has one key here. Every "same title" comparison of the ledger and the charges goes through it.
        /// </summary>
        /// <param name="a">An input.</param>
        /// <param name="b">Another input.</param>
        internal static bool SameTitle(MutationInput a, MutationInput b) => string.Equals(a.Key, b.Key, StringComparison.Ordinal);

        /// <summary>The same title in the same edition (standard or 4K): the edition is part of identity.</summary>
        /// <param name="a">An input.</param>
        /// <param name="b">Another input.</param>
        internal static bool SameEdition(MutationInput a, MutationInput b) => SameTitle(a, b) && string.Equals(a.Variant, b.Variant, StringComparison.Ordinal);

        /// <summary>What groups requests by title and edition (the key and the edition).</summary>
        /// <param name="input">An input.</param>
        internal static (string Key, string Variant) Edition(MutationInput input) => (input.Key, input.Variant);

        /// <summary>
        /// True when <paramref name="other"/> may stand for <paramref name="wanted"/> at the same target: the same title and
        /// edition, a compatible arr instance, and (when <paramref name="wanted"/> has Seerr options) the same options.
        /// Whether its scope covers the wanted scope is <see cref="MutationInput.Extra"/>'s question, over the inputs this lets through.
        /// </summary>
        /// <param name="wanted">The request that would be stood for.</param>
        /// <param name="other">The request that would stand for it.</param>
        internal static bool Serves(MutationInput wanted, MutationInput other)
            => SameEdition(other, wanted)
               && (wanted.InstanceId == null || other.InstanceId == null || other.InstanceId == wanted.InstanceId)
               && (!wanted.HasSeerrOptions || SameOptions(wanted, other));

        /// <summary><see cref="Serves(MutationInput, MutationInput)"/> with each request's target.</summary>
        /// <param name="wanted">The request that would be stood for.</param>
        /// <param name="wantedTarget">Its target.</param>
        /// <param name="other">The request that would stand for it.</param>
        /// <param name="otherTarget">Its target.</param>
        internal static bool Serves(MutationInput wanted, string wantedTarget, MutationInput other, string otherTarget)
            => SameTarget(wantedTarget, otherTarget) && Serves(wanted, other);

        /// <summary>Any routing choice differs between the two inputs (arr instance, profile, folder, or Seerr options).</summary>
        /// <param name="input">The new input.</param>
        /// <param name="original">The original input.</param>
        internal static bool RoutingChanged(MutationInput input, MutationInput original)
            => input.InstanceId != original.InstanceId || input.ProfileId != original.ProfileId || input.RootFolder != original.RootFolder ||
               input.SeerrServerId != original.SeerrServerId || input.SeerrProfileId != original.SeerrProfileId ||
               input.SeerrRootFolder != original.SeerrRootFolder || input.SeerrOptions != original.SeerrOptions;

        /// <summary>What <paramref name="approved"/> changes about <paramref name="original"/>.</summary>
        /// <param name="approved">The input approved.</param>
        /// <param name="original">The request's input.</param>
        internal static Change Compare(MutationInput approved, MutationInput original)
        {
            if (approved.Fingerprint == original.Fingerprint) return Change.None;
            return original.HasSeerrOptions && approved.HasSeerrOptions && (approved with { SeerrOptions = original.SeerrOptions }).Fingerprint == original.Fingerprint
                ? Change.StampOnly
                : Change.Other;
        }

        /// <summary>What the re-confirmation rule says about an approval: a refusal, or whether it re-confirms.</summary>
        /// <param name="Refusal">Null, <c>request_in_flight</c> or <c>request_changed</c>.</param>
        /// <param name="Reconfirms">The approval re-confirms the request with a fresh stamp (its jobs take the new stamp).</param>
        internal readonly record struct Verdict(string? Refusal, bool Reconfirms);

        /// <summary>
        /// The one re-confirmation rule for an approval of a request (explicit or an approver's matching ask):
        /// <list type="number">
        /// <item>It re-confirms only when the only change is a fresh options stamp for the same Seerr server, profile and
        /// root folder, and the request's own target (its Seerr source) is unchanged. Re-confirmed work keeps everything
        /// else, including a written part's uncertainty.</item>
        /// <item>A part that was written but isn't confirmed (held, certainty unknown) resumes only through an explicit
        /// approval, on its own target, unchanged or re-confirmed, and always through a fresh read first
        /// (<c>request_in_flight</c> otherwise).</item>
        /// <item>Work already sent never moves (<c>request_changed</c>), whatever else the approval is: not to another
        /// place (another Seerr or arr instance, an approval as it is included), and for an edit that isn't a
        /// re-confirmation, not to another target, other options, or a scope that leaves it out.</item>
        /// </list>
        /// </summary>
        /// <param name="original">The request's input.</param>
        /// <param name="originalTarget">The request's target.</param>
        /// <param name="approved">The input approved (the original when nothing was edited).</param>
        /// <param name="approvedTarget">The target the approval sends it to now.</param>
        /// <param name="edited">The approval carries edits.</param>
        /// <param name="jobs">The request's jobs.</param>
        /// <param name="resumeHeld">An explicit approval, which may resume a written part.</param>
        internal static Verdict Approval(MutationInput original, string originalTarget, MutationInput approved, string approvedTarget, bool edited, IEnumerable<RequestJob> jobs, bool resumeHeld)
        {
            var change = edited ? Compare(approved, original) : Change.None;
            var ownTarget = SameTarget(originalTarget, approvedTarget);
            var reconfirms = change == Change.StampOnly && ownTarget;
            var edit = change != Change.None && !reconfirms;
            var all = jobs.ToList();
            var held = all.Where(j => j.State == "parked" && j.Uncertain).ToList();
            if (held.Count > 0 && (!resumeHeld || !ownTarget || edit || held.Any(j => !SameTarget(RequestLedger.TargetKey(j.Authorization), approvedTarget))))
                return new("request_in_flight", false);
            foreach (var sent in all.Where(j => j.State == "succeeded"))
            {
                var sentTarget = RequestLedger.TargetKey(sent.Authorization);
                if (!SamePlace(sentTarget, approvedTarget)) return new("request_changed", false);
                if (edit && (!SameTarget(sentTarget, approvedTarget) || RoutingChanged(approved, original) || sent.Input.Extra(new[] { approved }) != null))
                    return new("request_changed", false);
            }
            return new(null, reconfirms);
        }
    }
}
