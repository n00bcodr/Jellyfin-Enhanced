using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;

namespace JE.Tests;

// Who may view and edit a list (design §4) and the parental filter for placeholders.
[Collection("Plugin singleton")]
public class ListsAccessTests
{
    private const string P = ListKinds.Playlist;
    private const string C = ListKinds.Collection;

    // kind, admin, collectionManager, owner, share, shareCanEdit, openAccess, entityVisible => view, edit, native
    [Theory]
    [InlineData(P, false, false, true, false, false, false, true, true, true, true)]     // owner
    [InlineData(P, false, false, false, true, true, false, true, true, true, true)]     // CanEdit share
    [InlineData(P, false, false, false, true, false, false, true, true, false, false)]  // view-only share
    [InlineData(P, false, false, false, false, false, true, true, true, false, false)]  // OpenAccess viewer
    [InlineData(P, false, false, false, false, false, false, true, false, false, false)] // private, not shared
    [InlineData(P, false, false, false, false, false, true, false, false, false, false)] // public but entity hidden (12.2 parental child check)
    [InlineData(P, false, false, true, false, false, false, false, false, false, false)] // owner whose list Jellyfin hides
    [InlineData(P, true, false, false, false, false, false, false, true, true, false)]   // admin on someone else's private playlist
    [InlineData(P, false, true, false, false, false, true, true, true, false, false)]    // collection manager has no playlist rights
    [InlineData(C, false, false, false, false, false, false, true, true, false, false)]  // collection viewer
    [InlineData(C, false, true, false, false, false, false, true, true, true, true)]     // collection manager
    [InlineData(C, true, false, false, false, false, false, true, true, true, true)]     // admin
    [InlineData(C, true, true, false, false, false, false, false, false, false, false)]  // collection not visible
    public void PermissionMatrix(string kind, bool admin, bool manager, bool owner, bool share, bool shareCanEdit, bool open, bool visible, bool view, bool edit, bool native)
    {
        var permissions = ListAccessRules.Evaluate(new ListAccessFacts(kind, admin, manager, owner, share, shareCanEdit, open, visible));
        Assert.Equal(new ListPermissions(view, edit, native), permissions);
    }

    [Fact]
    public void EvaluateReadsOwnershipSharesAndPermissionsFromJellyfin()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var editor = h.NewUser("editor");
        var viewer = h.NewUser("viewer");
        var stranger = h.NewUser("stranger");
        var admin = h.NewUser("admin", admin: true);
        var playlist = h.Host.AddPlaylist(owner, false, new ListShare(editor.Id, true), new ListShare(viewer.Id, false));

        var ownerAccess = h.AccessFor(playlist, owner);
        Assert.Equal(new ListPermissions(true, true, true), ownerAccess.Permissions);
        Assert.Same(owner, ownerAccess.Owner);
        Assert.Equal(new ListPermissions(true, true, true), h.AccessFor(playlist, editor).Permissions);
        Assert.Equal(new ListPermissions(true, false, false), h.AccessFor(playlist, viewer).Permissions);
        Assert.Equal(new ListPermissions(false, false, false), h.AccessFor(playlist, stranger).Permissions);
        var adminAccess = h.AccessFor(playlist, admin);
        Assert.Equal(new ListPermissions(true, true, false), adminAccess.Permissions);
        Assert.Same(owner, adminAccess.Owner);
        Assert.True(adminAccess.IsAdmin);

        h.Host.ListHiddenFrom[editor.Id] = new HashSet<Guid> { playlist.Info.Id };
        Assert.Equal(new ListPermissions(false, false, false), h.AccessFor(playlist, editor).Permissions);

        Assert.Null(h.Access.Resolve(Guid.NewGuid(), owner));
        Assert.Equal(playlist.Info.Id, h.Access.Resolve(playlist.Info.Id, owner)!.List.Id);
    }

    [Fact]
    public async Task UnrestrictedUsersCostNoParentalLookups()
    {
        using var h = new ListsHarness(seerr: true);
        var user = h.NewUser("user");
        var items = new[] { ListsHarness.Movie(1), ListsHarness.Ph("{\"kind\":\"custom\",\"title\":\"x\"}") };
        Assert.Empty(await h.Access.GetHiddenPlaceholderIdsAsync(items, user, CancellationToken.None));
        Assert.False(h.Access.IsRestricted(user));
        Assert.Empty(h.SeerrCalls);
    }

    [Fact]
    public async Task RestrictedUsersFailClosedOnUnverifiableTitles()
    {
        using var h = new ListsHarness(seerr: true);
        h.MovieCertifications[1] = "G";
        h.MovieCertifications[2] = "R";
        var kid = h.NewUser("kid", maxRating: 10);
        var kidId = kid.Id.ToString("N");
        var allowed = ListsHarness.Movie(1);
        var blocked = ListsHarness.Movie(2);
        var unknown = ListsHarness.Movie(3); // Seerr answers 404: can't be verified
        var othersCustom = ListsHarness.Ph("{\"kind\":\"custom\",\"title\":\"x\"}");
        var ownCustom = ListsHarness.Ph("{\"kind\":\"custom\",\"title\":\"y\"}", kidId);

        var hidden = await h.Access.GetHiddenPlaceholderIdsAsync(new[] { allowed, blocked, unknown, othersCustom, ownCustom }, kid, CancellationToken.None);

        Assert.True(h.Access.IsRestricted(kid));
        Assert.Equal(new[] { blocked.Id, unknown.Id, othersCustom.Id }.OrderBy(x => x), hidden.OrderBy(x => x));
        Assert.True(await h.Access.IsTitleBlockedAsync("movie", 2, kid, CancellationToken.None));
        Assert.False(await h.Access.IsTitleBlockedAsync("movie", 1, kid, CancellationToken.None));
    }

    [Fact]
    public async Task ManyTitlesOfOneListAreCheckedWithOneReadOfThePerson()
    {
        // Jellyfin 12 reads users from its database on every GetUserById. The list gate hands the parental checks the
        // person it just read; the checks must not read them again per title (4,247 entries for a Kid took over 10 s).
        using var h = new ListsHarness(seerr: true);
        for (var i = 1; i <= 40; i++)
        {
            h.MovieCertifications[i] = i % 2 == 0 ? "G" : "R";
        }

        var kid = h.NewUser("kid", maxRating: 10);
        var entries = Enumerable.Range(1, 40).Select(i => ListsHarness.Movie(i)).ToList();
        h.Users.Invocations.Clear();

        var hidden = await h.Access.GetHiddenPlaceholderIdsAsync(entries, kid, CancellationToken.None);
        var stamp = h.Access.ParentalStamp(kid);

        Assert.Equal(20, hidden.Count);
        Assert.NotEqual("-", stamp);
        Assert.True(h.Access.IsRestricted(kid));
        var reads = h.Users.Invocations.Count(i => i.Method.Name == nameof(MediaBrowser.Controller.Library.IUserManager.GetUserById));
        Assert.True(reads == 0, $"the person was read {reads} times for 40 titles");
    }

    [Fact]
    public async Task CheckTitleTellsAllowedBlockedAndUnknownApart()
    {
        // The arr branch's SeerrParentalFilter seam (TryGetRestrictedPolicy, MaySeeAbsentAsync, MaySeeAbsent) behind
        // ListAccessService.CheckTitleAsync: a verified rating the limits refuse is a decision (false); a title that
        // couldn't be verified is unknown (null: hidden now, a later check may show it).
        using var h = new ListsHarness(seerr: true);
        h.MovieCertifications[1] = "G";
        h.MovieCertifications[2] = "R";
        var kid = h.NewUser("kid", maxRating: 10);
        var adult = h.NewUser("adult");
        var kidId = kid.Id.ToString("N");

        Assert.True(await h.Access.CheckTitleAsync("movie", 1, kidId, CancellationToken.None));
        Assert.False(await h.Access.CheckTitleAsync("movie", 2, kidId, CancellationToken.None));
        Assert.Null(await h.Access.CheckTitleAsync("movie", 3, kidId, CancellationToken.None)); // Seerr 404

        var before = h.SeerrCalls.Count;
        Assert.True(await h.Access.CheckTitleAsync("movie", 3, adult.Id.ToString("N"), CancellationToken.None));
        Assert.Equal(before, h.SeerrCalls.Count); // unrestricted: no lookup
    }
}
