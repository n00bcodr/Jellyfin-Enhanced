using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Collages;
using R = Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Collages.ListCollageRefusal;

namespace JE.Tests;

// Who may turn a list's collage on or off, when a stored consent still counts, the display switches, and the list
// facts a collage needs (placeholder-only, complete, same list incarnation, no image of its own). Every input is an
// explicit fact; the rules read no storage and authorise nothing on their own.
public class ListsCollageConsentRulesTests
{
    private static readonly Guid Owner = Guid.Parse("00000000-0000-0000-0000-0000000000a1");
    private static readonly Guid Editor = Guid.Parse("00000000-0000-0000-0000-0000000000b2");
    private static readonly Guid Admin = Guid.Parse("00000000-0000-0000-0000-0000000000c3");
    private static readonly Guid Manager = Guid.Parse("00000000-0000-0000-0000-0000000000d4");
    private static readonly Guid ListId = Guid.Parse("11111111-2222-3333-4444-555555555555");
    private static readonly ListCollageIncarnation Inc = new("inc-1");

    // ---- flags and display ------------------------------------------------------------------------------------------

    [Fact]
    public void TheAdminSwitchNeedsTheListParentChainOnlyNotSeerrImportRequestsDetailsTagsOrStamps()
    {
        var config = Parents();
        Assert.True(ListCollageConsentRules.AdminEffective(config, collageAdmin: true));
        Assert.False(ListCollageConsentRules.AdminEffective(config, collageAdmin: false));
        Assert.False(ListCollageConsentRules.AdminEffective(null, collageAdmin: true));

        // Unrelated features off: still on.
        var cosmetic = Parents();
        cosmetic.JellyseerrEnabled = false;
        cosmetic.ArrPhase4ListRequestsEnabled = false;
        cosmetic.ArrPhase4ListRequestAllEnabled = false;
        cosmetic.ArrPhase4ListAuthoringEnabled = false;
        cosmetic.ArrPhase4ListSwapInEnabled = false;
        cosmetic.NativeAbsentDetailsEnabled = false;
        cosmetic.NativePosterTagsEnabled = false;
        cosmetic.ArrPhase4NativeStampsEnabled = false;
        Assert.True(ListCollageConsentRules.AdminEffective(cosmetic, collageAdmin: true));
        cosmetic.JellyseerrEnabled = true;
        cosmetic.NativeAbsentDetailsEnabled = true;
        cosmetic.NativePosterTagsEnabled = true;
        Assert.True(ListCollageConsentRules.AdminEffective(cosmetic, collageAdmin: true));

        // Each parent off: off.
        foreach (var off in new Action<PluginConfiguration>[]
                 {
                     c => c.ArrIntegrationEnabled = false,
                     c => c.ArrPhase1Enabled = false,
                     c => c.ArrPhase3Enabled = false,
                     c => c.ArrPhase4Enabled = false,
                     c => c.ArrPhase4ListPlaceholdersEnabled = false,
                 })
        {
            var parent = Parents();
            off(parent);
            Assert.False(ListCollageConsentRules.AdminEffective(parent, collageAdmin: true));
        }
    }

    [Theory]
    // admin effective, personal collage, personal list placeholders -> this viewer may be shown a collage
    [InlineData(true, null, null, true)]
    [InlineData(true, true, null, true)]
    [InlineData(true, false, null, false)]
    [InlineData(true, null, false, false)]
    [InlineData(true, true, false, false)]
    [InlineData(true, null, true, true)]
    [InlineData(false, null, null, false)]
    [InlineData(false, true, true, false)] // a personal "on" can't turn on a switch the admin left off
    public void ThePersonalDisplayChoiceFollowsTheAdminAndOnlyTurnsThingsOff(bool admin, bool? collage, bool? placeholders, bool expected)
    {
        Assert.Equal(expected, ListCollageConsentRules.Display(new ListCollageFlagFacts(admin, collage, placeholders)));
    }

    // ---- consent changes --------------------------------------------------------------------------------------------

    [Fact]
    public void OnlyThePlaylistOwnerMayTurnItsCollageOn()
    {
        var playlist = Playlist();
        Assert.Equal(ListCollageConsentChange.Allowed, ListCollageConsentRules.MayChange(Person(Owner), playlist, turnOn: true, ListCollageRestoreState.Clear));
        Assert.Equal(ListCollageConsentChange.NotAuthorized, ListCollageConsentRules.MayChange(Person(Editor, editShare: true), playlist, turnOn: true, ListCollageRestoreState.Clear));
        Assert.Equal(ListCollageConsentChange.AdminMayOnlyTurnOff, ListCollageConsentRules.MayChange(Person(Admin, admin: true, manager: true), playlist, turnOn: true, ListCollageRestoreState.Clear));

        // Turning it off: the owner, or an admin for safety; a share editor still can't.
        Assert.Equal(ListCollageConsentChange.Allowed, ListCollageConsentRules.MayChange(Person(Owner), playlist, turnOn: false, ListCollageRestoreState.Clear));
        Assert.Equal(ListCollageConsentChange.Allowed, ListCollageConsentRules.MayChange(Person(Admin, admin: true), playlist, turnOn: false, ListCollageRestoreState.Clear));
        Assert.Equal(ListCollageConsentChange.NotAuthorized, ListCollageConsentRules.MayChange(Person(Editor, editShare: true), playlist, turnOn: false, ListCollageRestoreState.Clear));
    }

    [Fact]
    public void ACurrentCollectionManagerMayTurnACollectionsCollageOnAndBecomesItsNamedPrincipal()
    {
        var collection = Collection();
        Assert.Equal(ListCollageConsentChange.Allowed, ListCollageConsentRules.MayChange(Person(Manager, manager: true), collection, turnOn: true, ListCollageRestoreState.Clear));
        Assert.Equal(ListCollageConsentChange.Allowed, ListCollageConsentRules.MayChange(Person(Admin, admin: true, manager: true), collection, turnOn: true, ListCollageRestoreState.Clear));
        Assert.Equal(ListCollageConsentChange.NotAuthorized, ListCollageConsentRules.MayChange(Person(Editor), collection, turnOn: true, ListCollageRestoreState.Clear));
        Assert.Equal(ListCollageConsentChange.Allowed, ListCollageConsentRules.MayChange(Person(Manager, manager: true), collection, turnOn: false, ListCollageRestoreState.Clear));
        Assert.Equal(ListCollageConsentChange.NotAuthorized, ListCollageConsentRules.MayChange(Person(Editor), collection, turnOn: false, ListCollageRestoreState.Clear));
    }

    [Fact]
    public void AnUnknownDisabledOrRestoringActorCannotTurnItOn()
    {
        var playlist = Playlist();
        Assert.Equal(ListCollageConsentChange.ActorUnknown, ListCollageConsentRules.MayChange(null, playlist, turnOn: true, ListCollageRestoreState.Clear));
        Assert.Equal(ListCollageConsentChange.ActorUnknown, ListCollageConsentRules.MayChange(Person(Guid.Empty), playlist, turnOn: true, ListCollageRestoreState.Clear));
        Assert.Equal(ListCollageConsentChange.ActorUnknown, ListCollageConsentRules.MayChange(Person(Owner) with { Exists = false }, playlist, turnOn: true, ListCollageRestoreState.Clear));
        Assert.Equal(ListCollageConsentChange.ActorUnknown, ListCollageConsentRules.MayChange(Person(Owner) with { Disabled = true }, playlist, turnOn: true, ListCollageRestoreState.Clear));
        Assert.Equal(ListCollageConsentChange.RestorePending, ListCollageConsentRules.MayChange(Person(Owner), playlist, turnOn: true, ListCollageRestoreState.Quarantined));
        Assert.Equal(ListCollageConsentChange.RestorePending, ListCollageConsentRules.MayChange(Person(Owner), playlist, turnOn: true, ListCollageRestoreState.Unknown));

        // A fresh consent after a finished restore is fine; turning off is always reachable, restore or not.
        Assert.Equal(ListCollageConsentChange.Allowed, ListCollageConsentRules.MayChange(Person(Owner), playlist, turnOn: true, ListCollageRestoreState.RestoredSinceConsent));
        Assert.Equal(ListCollageConsentChange.Allowed, ListCollageConsentRules.MayChange(Person(Owner), playlist, turnOn: false, ListCollageRestoreState.Quarantined));
        Assert.Equal(ListCollageConsentChange.Allowed, ListCollageConsentRules.MayChange(Person(Admin, admin: true), playlist, turnOn: false, ListCollageRestoreState.Unknown));

        // Not a list JE handles.
        Assert.Equal(ListCollageConsentChange.UnsupportedList, ListCollageConsentRules.MayChange(Person(Owner), Playlist() with { ListKind = "folder" }, turnOn: true, ListCollageRestoreState.Clear));
        Assert.Equal(ListCollageConsentChange.UnsupportedList, ListCollageConsentRules.MayChange(Person(Owner), Playlist() with { PlaylistOwner = null }, turnOn: true, ListCollageRestoreState.Clear));
    }

    // ---- stored consent ---------------------------------------------------------------------------------------------

    [Fact]
    public void ANullMissingOrImportedConsentIsOff()
    {
        var playlist = Playlist();
        Assert.Equal(ListCollageConsentState.Off, ListCollageConsentRules.Evaluate(null, Person(Owner), playlist, ListCollageRestoreState.Clear));
        Assert.Equal(ListCollageConsentState.Off, ListCollageConsentRules.Evaluate(new ListConsent(), Person(Owner), playlist, ListCollageRestoreState.Clear));
        Assert.Equal(ListCollageConsentState.Off, ListCollageConsentRules.Evaluate(new ListConsent { ByUserId = Owner.ToString("N") }, Person(Owner), playlist, ListCollageRestoreState.Clear));
        Assert.Equal(ListCollageConsentState.Off, ListCollageConsentRules.Evaluate(new ListConsent { ByUserId = "not-a-user", At = "2026-10-20T00:00:00Z" }, Person(Owner), playlist, ListCollageRestoreState.Clear));
        Assert.Equal(ListCollageConsentState.Off, ListCollageConsentRules.Evaluate(new ListConsent { ByUserId = Owner.ToString("N"), At = "yesterday" }, Person(Owner), playlist, ListCollageRestoreState.Clear));
        Assert.Equal(ListCollageConsentState.Usable, ListCollageConsentRules.Evaluate(ConsentBy(Owner), Person(Owner), playlist, ListCollageRestoreState.Clear));
    }

    [Fact]
    public void AConsentStopsCountingWhenItsPrincipalChangesIsDisabledOrDeletedOrTheServerWasRestored()
    {
        var playlist = Playlist();
        var consent = ConsentBy(Owner);
        Assert.Equal(ListCollageConsentState.PrincipalUnknown, ListCollageConsentRules.Evaluate(consent, null, playlist, ListCollageRestoreState.Clear));
        Assert.Equal(ListCollageConsentState.PrincipalUnknown, ListCollageConsentRules.Evaluate(consent, Person(Owner) with { Exists = false }, playlist, ListCollageRestoreState.Clear));
        Assert.Equal(ListCollageConsentState.PrincipalUnknown, ListCollageConsentRules.Evaluate(consent, Person(Editor), playlist, ListCollageRestoreState.Clear)); // facts of someone else
        Assert.Equal(ListCollageConsentState.PrincipalDisabled, ListCollageConsentRules.Evaluate(consent, Person(Owner) with { Disabled = true }, playlist, ListCollageRestoreState.Clear));
        Assert.Equal(ListCollageConsentState.PrincipalLostAuthority, ListCollageConsentRules.Evaluate(consent, Person(Owner), playlist with { PlaylistOwner = Editor }, ListCollageRestoreState.Clear));
        foreach (var restore in new[] { ListCollageRestoreState.RestoredSinceConsent, ListCollageRestoreState.Quarantined, ListCollageRestoreState.Unknown })
        {
            Assert.Equal(ListCollageConsentState.Restored, ListCollageConsentRules.Evaluate(consent, Person(Owner), playlist, restore));
        }

        // A collection's named manager loses it with the collection-management permission; an admin's consent on a
        // playlist they don't own never counts (they could only have turned it off).
        var collection = Collection();
        Assert.Equal(ListCollageConsentState.Usable, ListCollageConsentRules.Evaluate(ConsentBy(Manager), Person(Manager, manager: true), collection, ListCollageRestoreState.Clear));
        Assert.Equal(ListCollageConsentState.PrincipalLostAuthority, ListCollageConsentRules.Evaluate(ConsentBy(Manager), Person(Manager), collection, ListCollageRestoreState.Clear));
        Assert.Equal(ListCollageConsentState.PrincipalLostAuthority, ListCollageConsentRules.Evaluate(ConsentBy(Admin), Person(Admin, admin: true, manager: true), playlist, ListCollageRestoreState.Clear));
    }

    // ---- facts → proposed render intent -------------------------------------------------------------------------------

    [Fact]
    public void APlaceholderOnlyCompleteUnchangedListWithAUsableConsentGetsARenderIntent()
    {
        var proposal = Propose();
        Assert.Equal(R.None, proposal.Refusal);
        var intent = Assert.IsType<ListCollageRenderIntent>(proposal.Intent);
        Assert.Equal((ListId, ListCollageShape.Square, Owner, "rev-1", Inc), (intent.ListId, intent.Shape, intent.Viewer, intent.PolicyRevision, intent.Incarnation));
        Assert.Equal(new[] { "/a.jpg", "/b.jpg" }, intent.Candidates.Select(c => c.PosterPath));
        Assert.Equal(Selection().SafeSetDigest, intent.SafeSetDigest);

        var collection = Propose(list: Collection(), consent: ListCollageConsentState.Usable);
        Assert.Equal(ListCollageShape.Poster, collection.Intent!.Shape);

        // An intent proposes; it carries no way to publish, cache or save anything.
        Assert.All(typeof(ListCollageRenderIntent).GetMethods(), m => Assert.DoesNotMatch("(?i)publish|commit|save|write|serve|grant|mint", m.Name));
        Assert.All(typeof(ListCollageRenderIntent).GetProperties(), p => Assert.False(typeof(Delegate).IsAssignableFrom(p.PropertyType)));
    }

    [Fact]
    public void SwitchesDisplayAndConsentEachRefuseOnTheirOwn()
    {
        Assert.Equal(R.FlagsOff, Propose(flags: new ListCollageFlagFacts(false, true, true)).Refusal);
        Assert.Equal(R.DisplayOff, Propose(flags: new ListCollageFlagFacts(true, false, null)).Refusal);
        Assert.Equal(R.DisplayOff, Propose(flags: new ListCollageFlagFacts(true, true, false)).Refusal);

        // A viewer who wants collages can't create the owner's consent.
        Assert.Equal(R.ConsentOff, Propose(flags: new ListCollageFlagFacts(true, true, true), consent: ListCollageConsentState.Off).Refusal);
        foreach (var unusable in new[] { ListCollageConsentState.PrincipalUnknown, ListCollageConsentState.PrincipalDisabled, ListCollageConsentState.PrincipalLostAuthority, ListCollageConsentState.Restored })
        {
            Assert.Equal(R.ConsentUnusable, Propose(consent: unusable).Refusal);
        }

        Assert.All(new[] { R.FlagsOff, R.DisplayOff, R.ConsentOff, R.ConsentUnusable }, _ => Assert.Null(Propose(consent: ListCollageConsentState.Off).Intent));
    }

    [Fact]
    public void MembershipMustBeFoundCompleteAndPlaceholderOnly()
    {
        Assert.Equal(R.ListMissing, Propose(membership: Members() with { State = ListCollageFactState.Missing }).Refusal);
        Assert.Equal(R.ListUnsupported, Propose(membership: Members() with { State = ListCollageFactState.Unsupported }).Refusal);
        Assert.Equal(R.MembershipIncomplete, Propose(membership: Members() with { State = ListCollageFactState.Incomplete }).Refusal);

        // An unresolved link can't be proven not to be a real item.
        Assert.Equal(R.MembershipIncomplete, Propose(membership: Members() with { LinkedUnresolved = 1 }).Refusal);

        // The first raw real member ends it, whether or not this viewer can see it; a collection's physical children and
        // linked children both count.
        Assert.Equal(R.HasRealMember, Propose(membership: Members() with { LinkedResolved = 1 }).Refusal);
        Assert.Equal(R.HasRealMember, Propose(list: Collection(), membership: Members() with { PhysicalChildren = 1 }).Refusal);
        Assert.Equal(R.HasRealMember, Propose(list: Collection(), membership: Members() with { LinkedResolved = 1 }).Refusal);

        // Removing the last real member makes it eligible again (with the consent still valid).
        Assert.Equal(R.None, Propose(membership: Members() with { PhysicalChildren = 0, LinkedResolved = 0 }).Refusal);

        // Negative counts are not facts.
        Assert.Equal(R.MembershipIncomplete, Propose(membership: Members() with { PhysicalChildren = -1 }).Refusal);
    }

    [Fact]
    public void ARecreatedOrUnprovenListIncarnationRefuses()
    {
        Assert.Equal(R.IncarnationUnknown, Propose(list: Playlist() with { Incarnation = null }).Refusal);
        Assert.Equal(R.IncarnationUnknown, Propose(list: Playlist() with { DocIncarnation = null }).Refusal);
        Assert.Equal(R.IncarnationUnknown, Propose(membership: Members() with { Incarnation = null }).Refusal);
        Assert.Equal(R.IncarnationUnknown, Propose(list: Playlist() with { Incarnation = new ListCollageIncarnation(" ") }).Refusal);

        // Same id, deleted and made again: the document and its consent belong to the old list.
        Assert.Equal(R.IncarnationChanged, Propose(list: Playlist() with { Incarnation = new ListCollageIncarnation("inc-2") }).Refusal);
        Assert.Equal(R.IncarnationChanged, Propose(membership: Members() with { Incarnation = new ListCollageIncarnation("inc-2") }).Refusal);
    }

    [Fact]
    public void AListsOwnImageAlwaysWinsAndAnUnknownImageStateRefuses()
    {
        Assert.Equal(R.NativePrimaryPresent, Propose(native: ListCollageNativePrimary.Present).Refusal);
        Assert.Equal(R.NativePrimaryUnknown, Propose(native: ListCollageNativePrimary.Unknown).Refusal);
    }

    [Fact]
    public void TheViewersSelectionDecidesTheLastStep()
    {
        Assert.Equal(R.ViewerUnknown, Propose(selection: Selection() with { Status = ListCollageSelectionStatus.ViewerUnknown, Candidates = Array.Empty<ListCollageSelectedPoster>() }).Refusal);
        Assert.Equal(R.NoSafePosters, Propose(selection: Selection() with { Status = ListCollageSelectionStatus.Empty, Candidates = Array.Empty<ListCollageSelectedPoster>() }).Refusal);
        Assert.Equal(R.ListUnsupported, Propose(selection: Selection() with { Status = ListCollageSelectionStatus.Unsupported }).Refusal);

        // A selection made for another list shape or empty-but-"selected" is not accepted.
        Assert.Equal(R.NoSafePosters, Propose(selection: Selection() with { Candidates = Array.Empty<ListCollageSelectedPoster>() }).Refusal);
    }

    // ---- fixtures ---------------------------------------------------------------------------------------------------

    private static PluginConfiguration Parents() => new()
    {
        ArrIntegrationEnabled = true,
        ArrPhase1Enabled = true,
        ArrPhase3Enabled = true,
        ArrPhase4Enabled = true,
        ArrPhase4ListPlaceholdersEnabled = true,
    };

    private static ListCollageActor Person(Guid id, bool admin = false, bool manager = false, bool editShare = false) =>
        new(id, Exists: true, Disabled: false, IsAdministrator: admin, CanManageCollections: manager || admin, HasEditShare: editShare);

    private static ListCollageListFacts Playlist() => new(ListId, ListKinds.Playlist, Owner, Inc, Inc);

    private static ListCollageListFacts Collection() => new(ListId, ListKinds.Collection, null, Inc, Inc);

    private static ListConsent ConsentBy(Guid user) => new() { ByUserId = user.ToString("N"), At = "2026-10-20T01:02:03Z" };

    private static ListCollageMembershipFacts Members() => new(ListCollageFactState.Found, 0, 0, 0, Inc);

    private static ListCollageSelection Selection() => new(
        ListCollageSelectionStatus.Selected,
        new[] { new ListCollageSelectedPoster("a", "/a.jpg"), new ListCollageSelectedPoster("b", "/b.jpg") },
        2,
        false,
        Owner,
        "rev-1",
        new string('a', 64));

    private static ListCollageProposal Propose(
        ListCollageFlagFacts? flags = null,
        ListCollageConsentState consent = ListCollageConsentState.Usable,
        ListCollageListFacts? list = null,
        ListCollageMembershipFacts? membership = null,
        ListCollageNativePrimary native = ListCollageNativePrimary.None,
        ListCollageSelection? selection = null) =>
        ListCollageConsentRules.Propose(
            flags ?? new ListCollageFlagFacts(true, null, null),
            consent,
            list ?? Playlist(),
            membership ?? Members(),
            native,
            selection ?? Selection());
}
