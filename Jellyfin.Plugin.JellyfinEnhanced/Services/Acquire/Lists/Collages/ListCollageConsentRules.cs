using System;
using System.Collections.Generic;
using System.Globalization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Collages
{
    /// <summary>The display switches for one viewer.</summary>
    /// <param name="AdminEffective">The admin collage switch with its whole parent chain (<see cref="ListCollageConsentRules.AdminEffective"/>).</param>
    /// <param name="PersonalCollage">The viewer's collage choice (null follows the admin).</param>
    /// <param name="PersonalListPlaceholders">The viewer's list-placeholders choice (null follows the admin).</param>
    public sealed record ListCollageFlagFacts(bool AdminEffective, bool? PersonalCollage, bool? PersonalListPlaceholders);

    /// <summary>A person, as the user manager currently has them.</summary>
    /// <param name="UserId">The user.</param>
    /// <param name="Exists">Whether the user exists.</param>
    /// <param name="Disabled">Whether the account is disabled.</param>
    /// <param name="IsAdministrator">Jellyfin administrator.</param>
    /// <param name="CanManageCollections">Administrator or the collection-management permission.</param>
    /// <param name="HasEditShare">Holds an edit share of the list (never collage authority).</param>
    public sealed record ListCollageActor(Guid UserId, bool Exists, bool Disabled, bool IsAdministrator, bool CanManageCollections, bool HasEditShare);

    /// <summary>A producer-proven native incarnation of a list (a list deleted and made again under the same id differs).</summary>
    /// <param name="Token">The incarnation token.</param>
    public sealed record ListCollageIncarnation(string Token);

    /// <summary>The list, as currently read.</summary>
    /// <param name="ListId">The list id.</param>
    /// <param name="ListKind">A <see cref="ListKinds"/> value.</param>
    /// <param name="PlaylistOwner">A playlist's current owner (collections have none).</param>
    /// <param name="Incarnation">The list's current native incarnation, or null when it can't be proven.</param>
    /// <param name="DocIncarnation">The incarnation JE's list document (and its consent) belongs to, or null when unproven.</param>
    public sealed record ListCollageListFacts(Guid ListId, string ListKind, Guid? PlaylistOwner, ListCollageIncarnation? Incarnation, ListCollageIncarnation? DocIncarnation);

    /// <summary>How the list's raw membership was read.</summary>
    public enum ListCollageFactState
    {
        /// <summary>Read completely.</summary>
        Found = 0,

        /// <summary>The list doesn't exist.</summary>
        Missing = 1,

        /// <summary>Not a playlist or collection.</summary>
        Unsupported = 2,

        /// <summary>Couldn't be read completely.</summary>
        Incomplete = 3,
    }

    /// <summary>
    /// The list's raw membership, as the list host read it for everyone (not as one viewer sees it): a collection's
    /// physical children and both kinds' resolved and unresolved linked children.
    /// </summary>
    /// <param name="State">How it was read.</param>
    /// <param name="PhysicalChildren">Real items stored in the list (collections).</param>
    /// <param name="LinkedResolved">Linked children that resolve to a real item.</param>
    /// <param name="LinkedUnresolved">Linked children that don't resolve (can't be proven not to be real).</param>
    /// <param name="Incarnation">The incarnation the membership was read from.</param>
    public sealed record ListCollageMembershipFacts(ListCollageFactState State, int PhysicalChildren, int LinkedResolved, int LinkedUnresolved, ListCollageIncarnation? Incarnation);

    /// <summary>Whether the list has an image of its own.</summary>
    public enum ListCollageNativePrimary
    {
        /// <summary>No primary image.</summary>
        None = 0,

        /// <summary>It has one (it always wins; legacy evidence decides whether it may be served).</summary>
        Present = 1,

        /// <summary>Couldn't be read.</summary>
        Unknown = 2,
    }

    /// <summary>Where the server is with a restore of JE's data, relative to a consent.</summary>
    public enum ListCollageRestoreState
    {
        /// <summary>No restore since the consent was given.</summary>
        Clear = 0,

        /// <summary>A restore finished after the consent was given (it no longer counts; a new one may be given).</summary>
        RestoredSinceConsent = 1,

        /// <summary>A restore is being applied.</summary>
        Quarantined = 2,

        /// <summary>Unknown.</summary>
        Unknown = 3,
    }

    /// <summary>The answer to a request to turn a list's collage consent on or off.</summary>
    public enum ListCollageConsentChange
    {
        /// <summary>Allowed.</summary>
        Allowed = 0,

        /// <summary>The actor isn't the playlist owner or a current collection manager.</summary>
        NotAuthorized = 1,

        /// <summary>An administrator acting on another person's playlist may only turn it off.</summary>
        AdminMayOnlyTurnOff = 2,

        /// <summary>The actor isn't a current, enabled person.</summary>
        ActorUnknown = 3,

        /// <summary>Not a playlist with an owner or a collection.</summary>
        UnsupportedList = 4,

        /// <summary>A restore is being applied or its state is unknown (turning on waits).</summary>
        RestorePending = 5,
    }

    /// <summary>Whether a stored consent counts now.</summary>
    public enum ListCollageConsentState
    {
        /// <summary>No consent (null, or a missing/imported field).</summary>
        Off = 0,

        /// <summary>The consent counts.</summary>
        Usable = 1,

        /// <summary>The person who gave it doesn't exist (or other facts were supplied).</summary>
        PrincipalUnknown = 2,

        /// <summary>Their account is disabled.</summary>
        PrincipalDisabled = 3,

        /// <summary>They no longer own the playlist or manage collections.</summary>
        PrincipalLostAuthority = 4,

        /// <summary>A restore happened since (or is happening).</summary>
        Restored = 5,
    }

    /// <summary>Why a viewer gets no collage (or <see cref="None"/>).</summary>
    public enum ListCollageRefusal
    {
        /// <summary>Not refused.</summary>
        None = 0,

        /// <summary>The admin switch or a parent is off.</summary>
        FlagsOff,

        /// <summary>The viewer turned collages or list placeholders off.</summary>
        DisplayOff,

        /// <summary>The list's collage consent is off.</summary>
        ConsentOff,

        /// <summary>The stored consent no longer counts.</summary>
        ConsentUnusable,

        /// <summary>The list doesn't exist.</summary>
        ListMissing,

        /// <summary>Not a playlist or collection.</summary>
        ListUnsupported,

        /// <summary>The membership couldn't be proven complete.</summary>
        MembershipIncomplete,

        /// <summary>The list has a real member.</summary>
        HasRealMember,

        /// <summary>The list's incarnation can't be proven.</summary>
        IncarnationUnknown,

        /// <summary>The list was made again under the same id (or the facts are from different incarnations).</summary>
        IncarnationChanged,

        /// <summary>The list has an image of its own.</summary>
        NativePrimaryPresent,

        /// <summary>Whether the list has an image of its own is unknown.</summary>
        NativePrimaryUnknown,

        /// <summary>The viewer isn't a known person with a readable policy.</summary>
        ViewerUnknown,

        /// <summary>No poster is safe for the viewer.</summary>
        NoSafePosters,
    }

    /// <summary>
    /// A proposed render for one viewer: what a delivery owner may render after it has re-read every fact itself. It is
    /// not permission to publish, cache or serve anything.
    /// </summary>
    /// <param name="ListId">The list.</param>
    /// <param name="Shape">Its shape.</param>
    /// <param name="Viewer">The viewer.</param>
    /// <param name="PolicyRevision">The viewer's policy revision.</param>
    /// <param name="Incarnation">The list incarnation the facts were read from.</param>
    /// <param name="Candidates">The viewer's allowed posters, in order.</param>
    /// <param name="SafeSetDigest">Their digest.</param>
    public sealed record ListCollageRenderIntent(
        Guid ListId,
        ListCollageShape Shape,
        Guid Viewer,
        string PolicyRevision,
        ListCollageIncarnation Incarnation,
        IReadOnlyList<ListCollageSelectedPoster> Candidates,
        string SafeSetDigest);

    /// <summary>A refusal, or a render intent.</summary>
    /// <param name="Refusal">Why not (or <see cref="ListCollageRefusal.None"/>).</param>
    /// <param name="Intent">The intent when not refused.</param>
    public sealed record ListCollageProposal(ListCollageRefusal Refusal, ListCollageRenderIntent? Intent);

    /// <summary>
    /// The rules of list collages over explicit facts (no storage, no authorisation service; the producers of those facts
    /// own their authority):
    /// <list type="bullet">
    /// <item>Display: the admin switch with the list parents (independent of Seerr, import, requests, native details,
    /// poster tags and stamps); a viewer's own choice (null follows the admin) and their list-placeholders choice can
    /// only turn it off.</item>
    /// <item>Consent: only the playlist's owner, or a current collection manager (who becomes the named principal),
    /// may turn it on; an administrator may turn anyone's off; an edit share never counts. A stored consent counts only
    /// while its principal exists, is enabled and still owns the playlist / manages collections, and no restore
    /// happened since.</item>
    /// <item>Facts: a complete raw membership with no real member (hidden or not; unresolved links count as unknown), the
    /// same proven list incarnation everywhere, and no image of the list's own.</item>
    /// </list>
    /// </summary>
    public static class ListCollageConsentRules
    {
        /// <summary>The admin collage switch in effect: the switch and every list parent.</summary>
        /// <param name="config">Configuration (null: off).</param>
        /// <param name="collageAdmin">The admin collage switch.</param>
        /// <returns>Whether collages are on.</returns>
        public static bool AdminEffective(PluginConfiguration? config, bool collageAdmin) => collageAdmin && ListFlags.Lists(config);

        /// <summary>Whether a viewer may be shown collages.</summary>
        /// <param name="flags">The switches.</param>
        /// <returns>Whether collages show for them.</returns>
        public static bool Display(ListCollageFlagFacts flags)
        {
            ArgumentNullException.ThrowIfNull(flags);
            return ListFlags.Display(flags.AdminEffective, flags.PersonalCollage) && flags.PersonalListPlaceholders != false;
        }

        /// <summary>Whether an actor may turn a list's collage consent on or off.</summary>
        /// <param name="actor">The actor's current facts (null: unknown).</param>
        /// <param name="list">The list.</param>
        /// <param name="turnOn">On (true) or off (false).</param>
        /// <param name="restore">The restore state.</param>
        /// <returns>The answer.</returns>
        public static ListCollageConsentChange MayChange(ListCollageActor? actor, ListCollageListFacts list, bool turnOn, ListCollageRestoreState restore)
        {
            ArgumentNullException.ThrowIfNull(list);
            if (actor == null || actor.UserId == Guid.Empty || !actor.Exists || actor.Disabled)
            {
                return ListCollageConsentChange.ActorUnknown;
            }

            var playlist = list.ListKind == ListKinds.Playlist;
            if ((!playlist && list.ListKind != ListKinds.Collection) || (playlist && (list.PlaylistOwner is not { } owner || owner == Guid.Empty)))
            {
                return ListCollageConsentChange.UnsupportedList;
            }

            var principal = playlist ? actor.UserId == list.PlaylistOwner : actor.CanManageCollections;
            if (!turnOn)
            {
                // Turning off stays reachable for the principal and for an administrator's safety stop, restore or not.
                return principal || actor.IsAdministrator ? ListCollageConsentChange.Allowed : ListCollageConsentChange.NotAuthorized;
            }

            if (!principal)
            {
                return actor.IsAdministrator ? ListCollageConsentChange.AdminMayOnlyTurnOff : ListCollageConsentChange.NotAuthorized;
            }

            return restore is ListCollageRestoreState.Clear or ListCollageRestoreState.RestoredSinceConsent
                ? ListCollageConsentChange.Allowed
                : ListCollageConsentChange.RestorePending;
        }

        /// <summary>Whether a stored consent counts now.</summary>
        /// <param name="consent">The stored consent (null: off).</param>
        /// <param name="principal">The current facts of the person it names (null: not found).</param>
        /// <param name="list">The list.</param>
        /// <param name="restore">The restore state.</param>
        /// <returns>The state.</returns>
        public static ListCollageConsentState Evaluate(ListConsent? consent, ListCollageActor? principal, ListCollageListFacts list, ListCollageRestoreState restore)
        {
            ArgumentNullException.ThrowIfNull(list);
            if (consent == null || !Guid.TryParseExact(consent.ByUserId, "N", out var by) || by == Guid.Empty
                || !DateTimeOffset.TryParse(consent.At, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out _))
            {
                return ListCollageConsentState.Off;
            }

            if (principal == null || principal.UserId != by || !principal.Exists)
            {
                return ListCollageConsentState.PrincipalUnknown;
            }

            if (principal.Disabled)
            {
                return ListCollageConsentState.PrincipalDisabled;
            }

            var authority = list.ListKind switch
            {
                ListKinds.Playlist => list.PlaylistOwner == by,
                ListKinds.Collection => principal.CanManageCollections,
                _ => false,
            };
            if (!authority)
            {
                return ListCollageConsentState.PrincipalLostAuthority;
            }

            return restore == ListCollageRestoreState.Clear ? ListCollageConsentState.Usable : ListCollageConsentState.Restored;
        }

        /// <summary>
        /// Proposes one viewer's render from the facts, or says why not. The delivery owner re-reads the facts after
        /// rendering and before answering; this proposal grants nothing.
        /// </summary>
        /// <param name="flags">The viewer's switches.</param>
        /// <param name="consent">The consent state (<see cref="Evaluate"/>).</param>
        /// <param name="list">The list.</param>
        /// <param name="membership">The raw membership.</param>
        /// <param name="native">Whether the list has an image of its own.</param>
        /// <param name="selection">The viewer's poster selection.</param>
        /// <returns>The proposal.</returns>
        public static ListCollageProposal Propose(
            ListCollageFlagFacts flags,
            ListCollageConsentState consent,
            ListCollageListFacts list,
            ListCollageMembershipFacts membership,
            ListCollageNativePrimary native,
            ListCollageSelection selection)
        {
            ArgumentNullException.ThrowIfNull(flags);
            ArgumentNullException.ThrowIfNull(list);
            ArgumentNullException.ThrowIfNull(membership);
            ArgumentNullException.ThrowIfNull(selection);

            var refusal = Refuse(flags, consent, list, membership, native, selection);
            if (refusal != ListCollageRefusal.None)
            {
                return new ListCollageProposal(refusal, null);
            }

            return new ListCollageProposal(
                ListCollageRefusal.None,
                new ListCollageRenderIntent(list.ListId, ListCollageRenderer.ShapeFor(list.ListKind)!.Value, selection.Viewer, selection.PolicyRevision, list.Incarnation!, selection.Candidates, selection.SafeSetDigest));
        }

        private static ListCollageRefusal Refuse(
            ListCollageFlagFacts flags,
            ListCollageConsentState consent,
            ListCollageListFacts list,
            ListCollageMembershipFacts membership,
            ListCollageNativePrimary native,
            ListCollageSelection selection)
        {
            if (!flags.AdminEffective)
            {
                return ListCollageRefusal.FlagsOff;
            }

            if (!Display(flags))
            {
                return ListCollageRefusal.DisplayOff;
            }

            switch (membership.State)
            {
                case ListCollageFactState.Found:
                    break;
                case ListCollageFactState.Missing:
                    return ListCollageRefusal.ListMissing;
                case ListCollageFactState.Unsupported:
                    return ListCollageRefusal.ListUnsupported;
                default:
                    return ListCollageRefusal.MembershipIncomplete;
            }

            if (ListCollageRenderer.ShapeFor(list.ListKind) == null || selection.Status == ListCollageSelectionStatus.Unsupported)
            {
                return ListCollageRefusal.ListUnsupported;
            }

            if (membership.PhysicalChildren < 0 || membership.LinkedResolved < 0 || membership.LinkedUnresolved < 0 || membership.LinkedUnresolved > 0)
            {
                return ListCollageRefusal.MembershipIncomplete;
            }

            if (membership.PhysicalChildren + membership.LinkedResolved > 0)
            {
                return ListCollageRefusal.HasRealMember;
            }

            if (!Proven(list.Incarnation) || !Proven(list.DocIncarnation) || !Proven(membership.Incarnation))
            {
                return ListCollageRefusal.IncarnationUnknown;
            }

            if (!string.Equals(list.Incarnation!.Token, list.DocIncarnation!.Token, StringComparison.Ordinal)
                || !string.Equals(list.Incarnation.Token, membership.Incarnation!.Token, StringComparison.Ordinal))
            {
                return ListCollageRefusal.IncarnationChanged;
            }

            switch (native)
            {
                case ListCollageNativePrimary.None:
                    break;
                case ListCollageNativePrimary.Present:
                    return ListCollageRefusal.NativePrimaryPresent;
                default:
                    return ListCollageRefusal.NativePrimaryUnknown;
            }

            switch (consent)
            {
                case ListCollageConsentState.Usable:
                    break;
                case ListCollageConsentState.Off:
                    return ListCollageRefusal.ConsentOff;
                default:
                    return ListCollageRefusal.ConsentUnusable;
            }

            if (selection.Status == ListCollageSelectionStatus.ViewerUnknown)
            {
                return ListCollageRefusal.ViewerUnknown;
            }

            return selection.Status == ListCollageSelectionStatus.Selected && selection.Candidates.Count > 0 && !string.IsNullOrEmpty(selection.SafeSetDigest)
                ? ListCollageRefusal.None
                : ListCollageRefusal.NoSafePosters;
        }

        private static bool Proven(ListCollageIncarnation? incarnation) => !string.IsNullOrWhiteSpace(incarnation?.Token);
    }
}
