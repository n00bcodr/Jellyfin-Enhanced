using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

// Review round 3 (4c1):
// - behaviour-1 / security-1: two creators of one collection name at once, a JE one or someone in Jellyfin itself. A
//   create never replaces another collection, and every create that answers 200 has its own list with its own entries.
// - behaviour-2: a list JE creates never carries a share for an id no person has, so deleting its owner can never hand
//   it to one.
// - security-2: an answer's statuses are composed under the viewer's policy as it is when the answer is built.
// - security-3: a disabled caller, or a disabled owner a playlist write would run as, is refused.
[Collection("Plugin singleton")]
public class ListsGateRound3Tests
{
    private static readonly CancellationToken None = CancellationToken.None;

    // Another collection manager starts the same name while the first create waits inside Jellyfin's create.
    [Fact]
    public async Task TwoPeopleCreatingTheSameCollectionAtOnceNeverReplaceEachOthersList()
    {
        using var h = new ListsHarness();
        var first = h.NewUser("first", collections: true);
        var second = h.NewUser("second", collections: true);
        var x = h.Host.AddItem();
        var y = h.Host.AddItem();
        Task<ListOutcome>? rival = null;
        var started = false;
        h.Host.OnAwait = where =>
        {
            if (where == "create:before" && !started)
            {
                started = true;
                rival = h.Service.CreateListAsync(second, ListKinds.Collection, "Heist", false, new[] { new ApplyEntry(0, y, null) }, K("second-1"), None);
            }
        };

        var mine = await h.Service.CreateListAsync(first, ListKinds.Collection, "Heist", false, new[] { new ApplyEntry(0, x, null) }, K("first-1"), None);
        var theirs = await rival!;

        var made = new List<Guid>();
        foreach (var (outcome, item) in new[] { (mine, x), (theirs, y) })
        {
            if (outcome.StatusCode == 200)
            {
                var id = Guid.Parse(Assert.IsType<CreateListResultDto>(outcome.Value).ListId);
                Assert.True(h.Host.Lists.ContainsKey(id), "a 200 create's list is gone");
                Assert.Contains(item, h.Host.Resolved(id));
                made.Add(id);
            }
            else
            {
                Error(outcome, 409, "name_taken");
            }
        }

        Assert.NotEmpty(made);
        Assert.Equal(made.Count, made.Distinct().Count());
    }

    // Someone makes a collection of the same name in Jellyfin itself (hidden from the creator) while JE's create waits
    // inside Jellyfin's: it keeps exactly its own members.
    [Fact]
    public async Task ACollectionMadeByHandDuringAPendingCreateIsNeverReplaced()
    {
        using var h = new ListsHarness();
        var manager = h.NewUser("manager", collections: true);
        var x = h.Host.AddItem();
        var hidden = h.Host.AddItem();
        h.Host.Hide(hidden, manager);
        Guid? handMade = null;
        h.Host.OnAwait = where =>
        {
            if (where == "create:before" && handMade == null)
            {
                handMade = h.Host.CreateHandMadeCollectionAsync("Heist").GetAwaiter().GetResult();
                h.Host.Lists[handMade.Value].Raw.Add(new RawEntry(hidden, true));
                h.Host.ListHiddenFrom[manager.Id] = new HashSet<Guid> { handMade.Value };
            }
        };

        var created = await h.Service.CreateListAsync(manager, ListKinds.Collection, "Heist", false, new[] { new ApplyEntry(0, x, null) }, K("create-1"), None);

        Assert.True(h.Host.Lists.TryGetValue(handMade!.Value, out var theirs), "the hand-made collection is gone");
        Assert.Equal(new[] { hidden }, h.Host.Resolved(handMade.Value));
        Assert.Equal("Heist", theirs!.Info.Name);
        if (created.StatusCode == 200)
        {
            var id = Guid.Parse(Assert.IsType<CreateListResultDto>(created.Value).ListId);
            Assert.NotEqual(handMade.Value, id);
            Assert.Equal(new[] { x }, h.Host.Resolved(id));
        }
        else
        {
            Error(created, 409, "name_taken");
        }
    }

    // The creator's own playlist, left by an attempt that died right after Jellyfin made it: deleting the creator (Jellyfin
    // hands each playlist to its first share) never makes an id no person has its owner.
    [Fact]
    public async Task DeletingTheOwnerAfterACreateDiedNeverHandsThePlaylistToAMarker()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        h.Host.AfterCreate = _ => throw new IOException("the server stopped");
        await Assert.ThrowsAsync<IOException>(() => h.Service.CreateListAsync(owner, ListKinds.Playlist, "Mine", false, new[] { new ApplyEntry(0, h.Host.AddItem(), null) }, K("create-1"), None));
        h.Host.AfterCreate = null;
        var made = Assert.Single(h.Host.Lists.Values).Info.Id;
        Assert.All(h.Host.GetList(made)!.Shares, s => Assert.NotNull(h.Users.Object.GetUserById(s.UserId)));

        h.Users.Setup(u => u.GetUserById(owner.Id)).Returns((Jellyfin.Database.Implementations.Entities.User?)null);
        h.Host.RemoveUser(owner.Id);

        if (h.Host.GetList(made) is { } after)
        {
            Assert.NotNull(h.Users.Object.GetUserById(after.OwnerId));
        }
    }

    // Every playlist a create leaves behind holds only real people's shares, whether the create finished or not.
    [Fact]
    public async Task ACreatedPlaylistNeverCarriesAShareForNobody()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        Ok<CreateListResultDto>(await h.Service.CreateListAsync(owner, ListKinds.Playlist, "Mine", false, new[] { new ApplyEntry(0, h.Host.AddItem(), null) }, K("create-1"), None));
        var created = Assert.Single(h.Host.Lists.Values).Info;

        Assert.Empty(created.Shares);
        Assert.Equal("Mine", created.Name);
        Assert.Equal(owner.Id, created.OwnerId);
    }

    // The create runs under the name carrying its marker (Jellyfin makes the list's folder from it), then the list gets
    // its chosen name. That second write failing leaves the operation retryable, and the retry finishes it: never a share
    // for nobody, never a second list.
    [Theory]
    [InlineData(ListKinds.Playlist)]
    [InlineData(ListKinds.Collection)]
    public async Task AFailedFinishIsRetriedUntilTheListHasItsName(string kind)
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner", collections: true);
        var item = h.Host.AddItem();
        var entries = new[] { new ApplyEntry(0, item, null) };
        h.Host.FailFinishes = 1;

        await Assert.ThrowsAsync<IOException>(() => h.Service.CreateListAsync(owner, kind, "Watch next", false, entries, K("create-1"), None));
        var made = Assert.Single(h.Host.Lists.Values);
        Assert.NotEqual("Watch next", made.Info.Name);
        Assert.Contains(h.Host.Calls, c => c.StartsWith("create-" + kind + ":Watch next (", StringComparison.Ordinal));

        var retry = Ok<CreateListResultDto>(await h.Service.CreateListAsync(owner, kind, "Watch next", false, entries, K("create-1"), None));

        Assert.Equal(made.Info.Id.ToString("N"), retry.ListId);
        Assert.Equal("Watch next", retry.Name);
        Assert.Equal("Watch next", h.Host.GetList(made.Info.Id)!.Name);
        Assert.Empty(h.Host.GetList(made.Info.Id)!.Shares);
        Assert.Equal(new[] { item }, h.Host.Resolved(made.Info.Id));
        Assert.Single(h.Host.Lists);
    }

    // A person who lost collection management (or was disabled) between the create and its name gets nothing filled.
    [Fact]
    public async Task APersonWhoLostTheRightBeforeTheNameIsRefusedAndNothingIsApplied()
    {
        using var h = new ListsHarness();
        var manager = h.NewUser("manager", collections: true);
        var item = h.Host.AddItem();
        h.Host.OnAwait = where =>
        {
            if (where == "create:after")
            {
                manager.SetPermission(PermissionKind.EnableCollectionManagement, false);
            }
        };

        Error(await h.Service.CreateListAsync(manager, ListKinds.Collection, "Heist", false, new[] { new ApplyEntry(0, item, null) }, K("create-1"), None), 403, "forbidden");

        Assert.All(h.Host.Lists.Values, l => Assert.Empty(l.Raw));
        Assert.DoesNotContain(h.Host.Calls, c => c.StartsWith("finish", StringComparison.Ordinal));
    }

    // Two collection names that differ only in case go to one destination: one create at a time, the second refused.
    [Fact]
    public async Task TwoCollectionNamesDifferingOnlyInCaseShareOneDestination()
    {
        using var h = new ListsHarness();
        var first = h.NewUser("first", collections: true);
        var second = h.NewUser("second", collections: true);
        Task<ListOutcome>? rival = null;
        var started = false;
        h.Host.OnAwait = where =>
        {
            if (where == "create:before" && !started)
            {
                started = true;
                rival = h.Service.CreateListAsync(second, ListKinds.Collection, "HEIST", false, Array.Empty<ApplyEntry>(), K("second-1"), None);
            }
        };

        Ok<CreateListResultDto>(await h.Service.CreateListAsync(first, ListKinds.Collection, "Heist", false, Array.Empty<ApplyEntry>(), K("first-1"), None));

        Error(await rival!, 409, "name_taken");
        Assert.Single(h.Host.Lists);
    }

    // An unrelated "[boxset]" folder of the same name in some library doesn't take the name.
    [Fact]
    public async Task AnUnrelatedBoxsetFolderOfTheSameNameDoesNotTakeTheName()
    {
        using var h = new ListsHarness();
        var manager = h.NewUser("manager", collections: true);
        var other = await h.Host.CreateHandMadeCollectionAsync("Heist", "/media/other-library");

        var created = Ok<CreateListResultDto>(await h.Service.CreateListAsync(manager, ListKinds.Collection, "Heist", false, Array.Empty<ApplyEntry>(), K("create-1"), None));

        Assert.NotEqual(other.ToString("N"), created.ListId);
        Assert.Equal("Heist", created.Name);
    }

    // An administrator demoted while the statuses load: the view carries no status composed under the admin role.
    [Fact]
    public async Task AnAdministratorDemotedWhileTheStatusesLoadGetsNoAdministratorStatus()
    {
        using var h = new ListsHarness(status: true);
        h.Plugin.Plugin.Configuration.ArrPhase4ListStatusEnabled = true;
        var admin = h.NewUser("admin", admin: true);
        var list = h.Host.AddPlaylist(admin);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(h.AccessFor(list, admin), new[] { Movie(930, "2020-01-01") }, null, null, null, None));
        h.Status.ByKey["movie:tmdb:930"] = "{\"stage\":\"asked\"}";
        h.Status.Compose = (user, _, json) => h.Users.Object.GetUserById(user)!.HasPermission(PermissionKind.IsAdministrator)
            ? "{\"stage\":\"asked\",\"instanceId\":\"radarr-1\",\"path\":\"/movies/Heist\"}"
            : json;
        var demoted = false;
        h.Status.During = () =>
        {
            if (!demoted)
            {
                demoted = true;
                admin.SetPermission(PermissionKind.IsAdministrator, false);
            }
        };

        var view = await h.Service.ViewAsync(h.AccessFor(list, admin), None);

        Assert.NotNull(view);
        Assert.True(demoted);
        var status = Assert.Single(view!.Placeholders).Status;
        Assert.True(status == null || !status.Value.TryGetProperty("instanceId", out _), "a status composed for an administrator: " + status);
    }

    // The editor is disabled while JE checks the entries against their limits (a Seerr read): nothing is written.
    [Fact]
    public async Task ACallerDisabledDuringAnApplyIsRefusedBeforeJellyfinsWrite()
    {
        using var h = new ListsHarness(seerr: true);
        h.MovieCertifications[913] = "G";
        var owner = h.NewUser("owner");
        var editor = h.NewUser("editor", maxRating: 17);
        var list = h.Host.AddPlaylist(owner, false, new ListShare(editor.Id, true));
        var item = h.Host.AddItem();
        var reply = h.Reply;
        h.ReplyAsync = (request, _) =>
        {
            editor.SetPermission(PermissionKind.IsDisabled, true);
            return Task.FromResult(reply(request));
        };
        h.Host.Calls.Clear();

        var outcome = await h.Service.ApplyAsync(h.AccessFor(list, editor), new[] { new ApplyEntry(0, item, null), new ApplyEntry(1, null, Movie(913, "2020-01-01")) }, null, null, K("apply-1"), None);

        Assert.True(outcome.StatusCode >= 400, "answered " + outcome.StatusCode);
        Assert.DoesNotContain(h.Host.Calls, c => c.StartsWith("add:", StringComparison.Ordinal));
        Assert.True(editor.HasPermission(PermissionKind.IsDisabled));
    }

    // A person's insert runs as the playlist's owner: a disabled owner is never used for it.
    [Fact]
    public async Task APlaylistWriteNeverRunsAsADisabledOwner()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var editor = h.NewUser("editor");
        var list = h.Host.AddPlaylist(owner, false, new ListShare(editor.Id, true));
        owner.SetPermission(PermissionKind.IsDisabled, true);
        h.Host.Calls.Clear();

        var outcome = await h.Service.ApplyAsync(h.AccessFor(list, editor), new[] { new ApplyEntry(0, h.Host.AddItem(), null) }, null, null, K("apply-1"), None);

        Error(outcome, 409, "owner_missing");
        Assert.DoesNotContain(h.Host.Calls, c => c.StartsWith("add:", StringComparison.Ordinal));
    }

    // A disabled person creates nothing.
    [Theory]
    [InlineData(ListKinds.Playlist)]
    [InlineData(ListKinds.Collection)]
    public async Task ADisabledPersonCreatesNoList(string kind)
    {
        using var h = new ListsHarness();
        var person = h.NewUser("person", collections: true);
        person.SetPermission(PermissionKind.IsDisabled, true);

        Error(await h.Service.CreateListAsync(person, kind, "Mine", false, Array.Empty<ApplyEntry>(), K("create-1"), None), 403, "user_required");

        Assert.Empty(h.Host.Lists);
    }

    // A disabled viewer gets no view.
    [Fact]
    public async Task ADisabledViewerGetsNoView()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var list = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(list, owner);
        owner.SetPermission(PermissionKind.IsDisabled, true);

        Assert.Null(await h.Service.ViewAsync(access, None));
    }
}
