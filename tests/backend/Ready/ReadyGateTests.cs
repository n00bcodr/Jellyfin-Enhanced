using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Playlists;
using Moq;

namespace JE.Tests;

/// <summary>
/// 4f review round 1: what is checked right before each Jellyfin change of a Ready playlist. Creation recovery takes only
/// JE's own interrupted create (the id recorded before it, created then, empty, the person's, private), never a playlist
/// the person made under the marker's name; the playlist is read as Jellyfin stored it (a native share materializes and
/// saves another instance) and the cached instance is healed before a membership write; Remove leaves a shared or public
/// playlist alone; the switch, the opt-in and the person are read again right before the change; and a successful read
/// between two missing ones resets the deletion count.
/// </summary>
public class ReadyGateTests
{
    private static readonly TitleKey Sintel = TitleKey.Parse("movie:tmdb:45745")!;
    private static readonly TitleKey Tears = TitleKey.Parse("movie:tmdb:133701")!;
    private static readonly DateTime Arrived = ReadyWorld.Since.AddDays(2);

    private static async Task<(ReadyWorld W, StatusViewer Emma, FakeReadyPlaylistHost.Native Playlist, Guid Version)> Ready()
    {
        var w = new ReadyWorld();
        var emma = w.User();
        var (_, versions) = w.Movie(Sintel, Arrived);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        Assert.Equal("updated", await w.Service.ReconcileAsync(emma.UserId));
        var playlist = Assert.Single(w.Host.Playlists.Values);
        return (w, emma, playlist, versions[0]);
    }

    // ------------------------------------------------------------------ security-1: creation recovery

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task APlaylistThePersonMadeUnderTheMarkersNameAfterACrashIsNeverAdopted(bool withEntries)
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        w.Movie(Sintel, Arrived);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        // JE stops right after Jellyfin made the playlist, before it recorded the id.
        w.Host.FailAfter = "create";
        Assert.Equal("native_error", await w.Service.ReconcileAsync(emma.UserId));
        var made = Assert.Single(w.Host.Playlists.Values);

        // The person deletes the half-made playlist and, later, makes one of their own with the same (visible) name. Jellyfin
        // derives a new playlist's id from its folder, so theirs even gets the same id.
        w.Host.Playlists.Remove(made.Id);
        w.Now = w.Now.AddMinutes(10);
        var theirs = withEntries ? Guid.NewGuid() : Guid.Empty;
        var own = withEntries ? w.Host.AddOwn(emma.UserId, made.Name, theirs) : w.Host.AddOwn(emma.UserId, made.Name);
        Assert.Equal(made.Id, own.Id);

        w.Reopen();
        await w.Service.ReconcileAsync(emma.UserId);
        Assert.Equal(made.Name, own.Name);
        Assert.Equal(withEntries ? new[] { theirs } : Array.Empty<Guid>(), own.Entries);
        Assert.NotEqual(own.Id, w.Store.Binding(ReadyWorld.Server, emma.UserId)!.PlaylistId);
        Assert.True(w.Host.Playlists.ContainsKey(own.Id));
    }

    [Fact]
    public async Task JesOwnInterruptedCreateIsStillRecoveredAfterALateRestart()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var (_, versions) = w.Movie(Sintel, Arrived);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        // JE stops after Jellyfin made the playlist and JE wrote its nonce into it, before the binding was recorded.
        w.Host.FailAfter = "stamp";
        Assert.Equal("native_error", await w.Service.ReconcileAsync(emma.UserId));
        var made = Assert.Single(w.Host.Playlists.Values);

        // Jellyfin is back an hour later: the playlist JE made then is still recognised and finished.
        w.Now = w.Now.AddHours(1);
        w.Reopen();
        Assert.Equal("updated", await w.Service.ReconcileAsync(emma.UserId));
        Assert.Equal(1, w.Host.Creates);
        Assert.Equal(made.Id, w.Store.Binding(ReadyWorld.Server, emma.UserId)!.PlaylistId);
        Assert.Equal(ReadyPlaylistService.PlaylistName, made.Name);
        Assert.Equal(new[] { versions[0] }, made.Entries);
    }

    // ------------------------------------------------------------------ security-2: durable reads and heal-then-write

    private static (JellyfinReadyPlaylistHost Host, Playlist Cached, Playlist Stored, Mock<IPlaylistManager> Playlists) ProductionHost(Guid id, Guid owner)
    {
        const string Folder = "/config/data/playlists/Ready to watch (0123456789abcdef0123456789abcdef)";
        var cached = new Playlist { Id = id, Name = ReadyPlaylistService.PlaylistName, OwnerUserId = owner, Path = Folder, Shares = Array.Empty<PlaylistUserPermissions>() };
        var stored = new Playlist { Id = id, Name = ReadyPlaylistService.PlaylistName, OwnerUserId = owner, Path = Folder, Shares = Array.Empty<PlaylistUserPermissions>() };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById(id)).Returns(cached);
        library.Setup(l => l.RetrieveItem(id)).Returns(stored);
        var playlists = new Mock<IPlaylistManager>();
        // Jellyfin's membership update ends by saving the whole cached instance (its shares and name included).
        playlists.Setup(p => p.UpdatePlaylist(It.Is<PlaylistUpdateRequest>(r => r.Ids != null))).Callback(() =>
        {
            stored.Shares = cached.Shares.ToArray();
            stored.OpenAccess = cached.OpenAccess;
            stored.Name = cached.Name;
        }).Returns(Task.CompletedTask);
        return (new JellyfinReadyPlaylistHost(library.Object, playlists.Object, Mock.Of<MediaBrowser.Model.IO.IFileSystem>()), cached, stored, playlists);
    }

    [Fact]
    public void TheProductionHostReadsTheSharesJellyfinStoredNotItsCachedInstance()
    {
        var id = Guid.NewGuid();
        var owner = Guid.NewGuid();
        var (host, cached, stored, _) = ProductionHost(id, owner);
        // The person shares it natively: Jellyfin materializes another instance and saves it; the cached one stays as it was.
        stored.Shares = new[] { new PlaylistUserPermissions(Guid.NewGuid(), false) };
        stored.OpenAccess = true;
        var info = host.Get(id)!;
        Assert.Equal(1, info.ShareCount);
        Assert.True(info.OpenAccess);
        Assert.False(info.PrivateTo(owner));
        Assert.Empty(cached.Shares); // reading doesn't change the cached instance
    }

    [Fact]
    public async Task AMembershipWriteKeepsWhatThePersonChangedNatively()
    {
        var id = Guid.NewGuid();
        var owner = Guid.NewGuid();
        var (host, _, stored, _) = ProductionHost(id, owner);
        // A native rename (and a share landing as the write starts) are in Jellyfin's database, not in the cached instance.
        stored.Name = "Emma's picks";
        stored.Shares = new[] { new PlaylistUserPermissions(Guid.NewGuid(), true) };
        // Even a write the gate lets through (a share landing right after its check) saves the stored metadata back.
        Assert.Null(await host.SetAsync(id, new[] { Guid.NewGuid() }, owner, _ => null));
        Assert.Equal("Emma's picks", stored.Name);
        Assert.Single(stored.Shares);
    }

    [Fact]
    public async Task TheGateSeesTheStoredShareAndJellyfinIsNeverCalled()
    {
        var id = Guid.NewGuid();
        var owner = Guid.NewGuid();
        var (host, _, stored, playlists) = ProductionHost(id, owner);
        stored.Shares = new[] { new PlaylistUserPermissions(Guid.NewGuid(), false) };
        Assert.Equal("shared", await host.SetAsync(id, new[] { Guid.NewGuid() }, owner, s => s!.PrivateTo(owner) ? null : "shared"));
        Assert.Equal("shared", await host.RenameAsync(id, owner, "x", s => s!.PrivateTo(owner) ? null : "shared"));
        Assert.Equal("shared", await host.DeleteAsync(id, s => s!.PrivateTo(owner) ? null : "shared"));
        playlists.Verify(p => p.UpdatePlaylist(It.IsAny<PlaylistUpdateRequest>()), Times.Never);
        Assert.Single(stored.Shares);
    }

    // ------------------------------------------------------------------ security-3: Remove on a shared or public playlist

    [Theory]
    [InlineData("shared")]
    [InlineData("public")]
    public async Task RemoveLeavesASharedOrPublicManagedPlaylistAlone(string change)
    {
        var (w, emma, playlist, version) = await Ready();
        using (w)
        {
            if (change == "shared") playlist.Shares = 1;
            else playlist.Public = true;
            Assert.Equal("kept", await w.Service.RemoveAsync(emma.UserId));
            Assert.True(w.Host.Playlists.ContainsKey(playlist.Id));
            Assert.Equal(new[] { version }, playlist.Entries);
            Assert.DoesNotContain(w.Host.Gates, g => g.Call == "delete" && g.Refused == null);
            // JE no longer manages it: no more writes, and turning Ready on again makes a new private one.
            var binding = w.Store.Binding(ReadyWorld.Server, emma.UserId)!;
            Assert.Null(binding.PlaylistId);
            Assert.False(binding.OptedIn);
            await w.Service.SetPlaylistAsync(emma.UserId, true);
            await w.Service.ReconcileAsync(emma.UserId);
            Assert.Equal(2, w.Host.Creates);
            Assert.Equal(new[] { version }, playlist.Entries);
        }
    }

    [Fact]
    public async Task RemoveRefusesAPlaylistSharedWhileItWaitsForItsTurn()
    {
        var (w, emma, playlist, version) = await Ready();
        using (w)
        {
            // Shared right before Jellyfin is asked to delete it (after Remove read the binding).
            w.Host.During = call =>
            {
                if (call == "delete") playlist.Shares = 1;
            };
            Assert.NotEqual("removed", await w.Service.RemoveAsync(emma.UserId));
            Assert.True(w.Host.Playlists.ContainsKey(playlist.Id));
            Assert.Equal(new[] { version }, playlist.Entries);
        }
    }

    // ------------------------------------------------------------------ security-6: the switch, the opt-in and the person right before the change

    [Theory]
    [InlineData("privacy", "switch")]
    [InlineData("privacy", "opt_out")]
    [InlineData("privacy", "user_gone")]
    [InlineData("selection", "switch")]
    [InlineData("selection", "opt_out")]
    [InlineData("selection", "user_gone")]
    public async Task AChangeAfterThePassStartedStopsTheMembershipWrite(string during, string change)
    {
        var (w, emma, playlist, version) = await Ready();
        using (w)
        {
            w.Movie(Tears, Arrived.AddDays(1));
            w.Interests.Add(emma.UserId, "w:2", ReadyInterestKind.Request, Tears);
            var done = false;
            void Change()
            {
                if (done) return;
                done = true;
                switch (change)
                {
                    case "switch": w.Config.ArrPhase4ReadyPlaylistEnabled = false; break;
                    case "opt_out": w.Store.OptOut(ReadyWorld.Server, emma.UserId, w.Now); break;
                    default: w.View.Users.Remove(emma.UserId); break;
                }
            }

            if (during == "privacy") w.Privacy.OnLoad = _ => Change();
            else w.Library.OnCheck = (_, _) => Change();
            var sets = w.Host.Gates.Count(g => g.Call == "set" && g.Refused == null);
            Assert.NotEqual("updated", await w.Service.ReconcileAsync(emma.UserId));
            Assert.Equal(sets, w.Host.Gates.Count(g => g.Call == "set" && g.Refused == null));
            Assert.Equal(new[] { version }, playlist.Entries);
        }
    }

    [Theory]
    [InlineData("switch")]
    [InlineData("opt_out")]
    [InlineData("user_gone")]
    public async Task AChangeWhileTheNewPlaylistIsBeingMadeStopsTheCreate(string change)
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        w.Movie(Sintel, Arrived);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        w.Host.During = call =>
        {
            if (call != "create") return;
            switch (change)
            {
                case "switch": w.Config.ArrPhase4ReadyPlaylistEnabled = false; break;
                case "opt_out": w.Store.OptOut(ReadyWorld.Server, emma.UserId, w.Now); break;
                default: w.View.Users.Remove(emma.UserId); break;
            }
        };
        await w.Service.ReconcileAsync(emma.UserId);
        Assert.Empty(w.Host.Playlists);
    }

    // ------------------------------------------------------------------ behaviour-1: only consecutive missing reads count

    [Fact]
    public async Task ASuccessfulReadBetweenTwoMissingOnesResetsTheDeletionCount()
    {
        var (w, emma, playlist, version) = await Ready();
        using (w)
        {
            // Missing once (a transient read), then readable and unchanged.
            w.Host.Playlists.Remove(playlist.Id);
            Assert.Equal("missing", await w.Service.ReconcileAsync(emma.UserId));
            w.Host.Playlists[playlist.Id] = playlist;
            w.Now = w.Now.AddSeconds(30);
            Assert.Equal("unchanged", await w.Service.ReconcileAsync(emma.UserId));
            var binding = w.Store.Binding(ReadyWorld.Server, emma.UserId)!;
            Assert.Equal(0, binding.MissingCount);
            Assert.Null(binding.MissingSince);

            // One more isolated miss a while later is the first of a new count, not a deletion.
            w.Host.Playlists.Remove(playlist.Id);
            w.Now = w.Now.AddMinutes(5);
            Assert.Equal("missing", await w.Service.ReconcileAsync(emma.UserId));
            Assert.Equal(ReadyState.Active, w.Store.Binding(ReadyWorld.Server, emma.UserId)!.State);
            Assert.True(w.Store.Binding(ReadyWorld.Server, emma.UserId)!.OptedIn);

            // Two consecutive misses a minute apart still are.
            w.Now = w.Now.AddMinutes(2);
            Assert.Equal("deleted", await w.Service.ReconcileAsync(emma.UserId));
            _ = version;
        }
    }

    [Fact]
    public async Task ASuccessfulReadThatChangesThePlaylistResetsTheDeletionCountToo()
    {
        var (w, emma, playlist, _) = await Ready();
        using (w)
        {
            w.Host.Playlists.Remove(playlist.Id);
            Assert.Equal("missing", await w.Service.ReconcileAsync(emma.UserId));
            w.Host.Playlists[playlist.Id] = playlist;
            w.Movie(Tears, Arrived.AddDays(1));
            w.Interests.Add(emma.UserId, "w:2", ReadyInterestKind.Request, Tears);
            w.Now = w.Now.AddSeconds(30);
            Assert.Equal("updated", await w.Service.ReconcileAsync(emma.UserId));
            w.Host.Playlists.Remove(playlist.Id);
            w.Now = w.Now.AddMinutes(5);
            Assert.Equal("missing", await w.Service.ReconcileAsync(emma.UserId));
        }
    }
}
