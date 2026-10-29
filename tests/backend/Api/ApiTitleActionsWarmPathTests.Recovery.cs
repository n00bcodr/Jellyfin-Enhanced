// Temporary policy uncertainty stays temporary (absent-child recovery): request visibility that can't be settled now is
// Unknown (a retryable 503 on a native page), never allowed, and never the 404 of a title the viewer may not see.
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using Moq;

namespace JE.Tests;

public partial class ApiTitleActionsWarmPathTests
{
    /// <summary>A native policy over a stub arr view whose copy lookup and person reads the test drives.</summary>
    private static NativeDetailsPolicy PolicyOver(Rig rig, Mock<IArrJellyfinView> view)
    {
        var roots = new FakeLibraryAccess();
        var requests = new RequestPolicy(view.Object, rig.Store, new ArrInstanceLibraries(rig.Store, roots), new TitleAliases(rig.Store, null), rig.Gate, rig.Arr.Factory, new UnavailableRequestBackend());
        return new NativeDetailsPolicy(rig.Gate, Mock.Of<INativeDetailsSource>(), roots, requests);
    }

    private static Mock<IArrJellyfinView> ViewOf(Func<User> live, Func<CopyLookup> copies)
    {
        var view = new Mock<IArrJellyfinView>();
        view.SetupGet(v => v.Revision).Returns(1);
        view.Setup(v => v.Viewer(It.IsAny<Guid>())).Returns(() => ArrJellyfinView.ViewerOf(live()));
        view.Setup(v => v.ViewerAsRead(It.IsAny<User>())).Returns((User u) => ArrJellyfinView.ViewerOf(u));
        view.Setup(v => v.Copies(It.IsAny<TitleKey>(), It.IsAny<StatusViewer>(), It.IsAny<IReadOnlyCollection<TitleKey>>())).Returns(copies);
        return view;
    }

    [Fact]
    public async Task AuthorizationThatKeepsChangingIsUnknownUntilItSettlesThenTheNextAskIsAllowed()
    {
        using var rig = new Rig();
        rig.Viewer.SetPermission(PermissionKind.IsAdministrator, true);
        User live = rig.Viewer;
        rig.Lookup = id => id == live.Id ? live : null;
        var churn = true;
        var evaluations = 0;
        // Every copy scan lands a new read of the person (a policy revision that never repeats) while churn lasts: each of
        // the evaluation's own three stabilization reads and each of the page's three confirmations sees a moved stamp.
        var view = ViewOf(() => live, () =>
        {
            evaluations++;
            if (churn)
            {
                var next = Rig.Person(rig.Viewer.Id);
                next.SetPermission(PermissionKind.IsAdministrator, true);
                next.SetPreference(PreferenceKind.BlockedMediaFolders, new[] { Guid.NewGuid() });
                live = next;
            }

            return CopyLookup.Absent;
        });
        var policy = PolicyOver(rig, view);
        Assert.Equal(NativeDetailsPolicy.Access.Unknown, await policy.SeeDetailsAsync(rig.Viewer, Title, CancellationToken.None));
        Assert.Equal(NativeDetailsPolicy.Access.Unknown, await policy.SeeAsync(rig.Viewer, Title, CancellationToken.None));
        // Bounded: three confirmations of three stabilization reads at most, never a loop against the moving revision.
        Assert.InRange(evaluations, 2, 2 * 3 * 3);
        // The artwork path (no held read) says the same.
        Assert.Equal(NativeDetailsPolicy.Access.Unknown, await policy.ListAbsentAccessAsync(live, Title, CancellationToken.None));
        // Lists never show a title they couldn't settle.
        Assert.False(policy.MayListAbsent(rig.Viewer, Title));
        // The changes stop: the next ask is allowed.
        churn = false;
        Assert.Equal(NativeDetailsPolicy.Access.Allowed, await policy.SeeAsync(live, Title, CancellationToken.None));
    }

    [Fact]
    public async Task ACopyLookupThatProvedNothingIsUnknownWhileASeenHiddenCopyIsRefused()
    {
        using var rig = new Rig();
        rig.Viewer.SetPermission(PermissionKind.IsAdministrator, true);
        var lookup = CopyLookup.Incomplete(Array.Empty<JfCopy>());
        var view = ViewOf(() => rig.Viewer, () => lookup);
        var policy = PolicyOver(rig, view);
        // Neither a copy nor the title's absence is proven: temporary.
        Assert.Equal(NativeDetailsPolicy.Access.Unknown, await policy.SeeAsync(rig.Viewer, Title, CancellationToken.None));
        Assert.Equal(NativeDetailsPolicy.Access.Unknown, await policy.ListAbsentAccessAsync(rig.Viewer, Title, CancellationToken.None));
        Assert.False(policy.MayListAbsent(rig.Viewer, Title));
        // A copy the scan did see that the viewer can't open hides the title: refused, finished scan or not.
        lookup = CopyLookup.Incomplete(new[] { new JfCopy { ItemId = Guid.NewGuid(), Visible = false } });
        Assert.Equal(NativeDetailsPolicy.Access.Refused, await policy.SeeAsync(rig.Viewer, Title, CancellationToken.None));
        lookup = CopyLookup.Complete(new[] { new JfCopy { ItemId = Guid.NewGuid(), Visible = false } });
        Assert.Equal(NativeDetailsPolicy.Access.Refused, await policy.SeeAsync(rig.Viewer, Title, CancellationToken.None));
        // Proven absent: allowed.
        lookup = CopyLookup.Absent;
        Assert.Equal(NativeDetailsPolicy.Access.Allowed, await policy.SeeAsync(rig.Viewer, Title, CancellationToken.None));
    }

    [Fact]
    public async Task ARequestVisibilityReadThatFailsIsUnknownNotRefused()
    {
        using var rig = new Rig();
        rig.Viewer.SetPermission(PermissionKind.IsAdministrator, true);
        var fail = true;
        var view = ViewOf(() => rig.Viewer, () => fail ? throw new InvalidOperationException("database is locked") : CopyLookup.Absent);
        var policy = PolicyOver(rig, view);
        Assert.Equal(NativeDetailsPolicy.Access.Unknown, await policy.SeeAsync(rig.Viewer, Title, CancellationToken.None));
        fail = false;
        Assert.Equal(NativeDetailsPolicy.Access.Allowed, await policy.SeeAsync(rig.Viewer, Title, CancellationToken.None));
    }

    [Fact]
    public async Task ARealHiddenCopyStaysRefusedThroughTheProductionView()
    {
        using var rig = new Rig();
        await rig.Settle();
        rig.AddCopy(closed: true);
        Assert.Equal(NativeDetailsPolicy.Access.Refused, await rig.Policy.SeeAsync(rig.Viewer, Title, CancellationToken.None));
        Assert.Equal(NativeDetailsPolicy.Access.Refused, await rig.Policy.ListAbsentAccessAsync(rig.Viewer, Title, CancellationToken.None));
    }
}
