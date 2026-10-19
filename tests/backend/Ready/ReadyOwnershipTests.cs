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
/// 4f review round 3 (security-1, security-2). Ownership of a Ready playlist is proved only by evidence from JE's own
/// create: the playlist Jellyfin reports for the create call, read back right after it (its creation time), is the only one
/// the nonce is ever written into; a playlist the person put in its place (same id, as Jellyfin derives ids from the folder
/// name) is abandoned, never stamped, written or deleted. Every write and delete runs the full mutation gate (owner, privacy,
/// shares, nonce, creation time) again on the latest stored copy, after the heal, right before Jellyfin is called.
/// </summary>
public class ReadyOwnershipTests
{
    private static readonly TitleKey Sintel = TitleKey.Parse("movie:tmdb:45745")!;
    private static readonly DateTime Arrived = ReadyWorld.Since.AddDays(2);

    // ------------------------------------------------------------------ security-1: the create's own playlist only

    [Theory]
    [InlineData(20, true)]
    [InlineData(20, false)]
    [InlineData(3, true)]
    public async Task APlaylistPutInPlaceOfJesFreshOneBeforeJeReadsItIsNeverAdopted(int secondsLater, bool withEntries)
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var (_, versions) = w.Movie(Sintel, Arrived);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        // Between Jellyfin's create returning and JE's first read, the person deletes it and makes their own under the same
        // (marker) name: Jellyfin gives it the same id.
        FakeReadyPlaylistHost.Native? own = null;
        var theirs = Guid.NewGuid();
        w.Host.During = call =>
        {
            if (call != "created" || own != null) return;
            var made = Assert.Single(w.Host.Playlists.Values);
            w.Host.Playlists.Remove(made.Id);
            w.Now = w.Now.AddSeconds(secondsLater);
            own = withEntries ? w.Host.AddOwn(emma.UserId, made.Name, theirs) : w.Host.AddOwn(emma.UserId, made.Name);
            Assert.Equal(made.Id, own.Id);
        };
        Assert.Equal("lost", await w.Service.ReconcileAsync(emma.UserId));
        w.Host.During = null;
        Assert.NotNull(own);
        // Never stamped, bound, renamed, written or deleted.
        Assert.Null(own!.Nonce);
        Assert.DoesNotContain(w.Host.Gates, g => g.Call == "stamp" && g.Refused == null);
        Assert.Null(w.Store.Binding(ReadyWorld.Server, emma.UserId)!.PlaylistId);
        Assert.False(w.Service.Status(emma.UserId).CanRemove);
        Assert.Equal("nothing", await w.Service.RemoveAsync(emma.UserId));

        // Lost: nothing more until the person turns it on again; then a fresh playlist of JE's under a new marker; theirs stays
        // as it is.
        w.Now = w.Now.AddMinutes(5);
        Assert.Equal("not_active", await w.Service.ReconcileAsync(emma.UserId));
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        Assert.Equal("updated", await w.Service.ReconcileAsync(emma.UserId));
        var fresh = w.Store.Binding(ReadyWorld.Server, emma.UserId)!.PlaylistId!.Value;
        Assert.NotEqual(own.Id, fresh);
        Assert.Equal(new[] { versions[0] }, w.Host.Playlists[fresh].Entries);
        Assert.True(w.Host.Playlists.ContainsKey(own.Id));
        Assert.Null(own.Nonce);
        Assert.Equal(withEntries ? new[] { theirs } : Array.Empty<Guid>(), own.Entries);
        Assert.NotEqual(ReadyPlaylistService.PlaylistName, own.Name);
        Assert.DoesNotContain(w.Host.Sets, s => s.Playlist == own.Id);
        Assert.Equal("removed", await w.Service.RemoveAsync(emma.UserId));
        Assert.True(w.Host.Playlists.ContainsKey(own.Id));
    }

    [Fact]
    public async Task JesOwnFreshPlaylistIsStampedAndBoundAsBefore()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var (_, versions) = w.Movie(Sintel, Arrived);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        Assert.Equal("updated", await w.Service.ReconcileAsync(emma.UserId));
        var made = Assert.Single(w.Host.Playlists.Values);
        Assert.NotNull(made.Nonce);
        Assert.Equal(made.Id, w.Store.Binding(ReadyWorld.Server, emma.UserId)!.PlaylistId);
        Assert.Equal(ReadyPlaylistService.PlaylistName, made.Name);
        Assert.Equal(new[] { versions[0] }, made.Entries);
        Assert.Equal(1, w.Host.Creates);
    }

    // ------------------------------------------------------------------ security-2: the full gate on the latest stored copy

    private const string Folder = "/config/data/playlists/Ready to watch (0123456789abcdef0123456789abcdef)";

    private static Playlist Make(Guid id, Guid owner, DateTime created, bool openAccess = false, int shares = 0, string name = ReadyPlaylistService.PlaylistName)
        => new()
        {
            Id = id,
            Name = name,
            OwnerUserId = owner,
            Path = Folder,
            OpenAccess = openAccess,
            Shares = Enumerable.Range(0, shares).Select(_ => new PlaylistUserPermissions(Guid.NewGuid(), false)).ToArray(),
            DateCreated = created,
            ExternalId = JellyfinReadyPlaylistHost.NoncePrefix + "n0nce",
        };

    // The service's gate in its privacy part: the person's own, private, shared with nobody.
    private static ReadyGate PrivateTo(Guid owner) => stored => stored == null ? "missing" : stored.OwnerId != owner ? "owner_changed" : stored.OpenAccess ? "public" : stored.ShareCount > 0 ? "shared" : null;

    [Theory]
    [InlineData("shared", "set")]
    [InlineData("shared", "delete")]
    [InlineData("shared", "rename")]
    [InlineData("public", "set")]
    [InlineData("public", "delete")]
    [InlineData("renamed", "set")]
    public async Task APrivacyOrNameChangeBetweenTheGateAndTheHealedSaveStopsTheWrite(string change, string call)
    {
        var id = Guid.NewGuid();
        var owner = Guid.NewGuid();
        var created = new DateTime(2026, 10, 18, 9, 0, 0, DateTimeKind.Utc);
        var library = new Mock<ILibraryManager>();
        // The first stored read passes the gate; the person shares, publishes or renames it before the second read.
        var after = change switch
        {
            "shared" => Make(id, owner, created, shares: 1),
            "public" => Make(id, owner, created, openAccess: true),
            _ => Make(id, owner, created, name: "Emma's picks"),
        };
        library.SetupSequence(l => l.RetrieveItem(id)).Returns(Make(id, owner, created)).Returns(after).Returns(after);
        library.Setup(l => l.GetItemById(id)).Returns(Make(id, owner, created));
        var playlists = new Mock<IPlaylistManager>();
        var host = new JellyfinReadyPlaylistHost(library.Object, playlists.Object, Mock.Of<MediaBrowser.Model.IO.IFileSystem>());
        var gate = PrivateTo(owner);
        var refused = call switch
        {
            "set" => await host.SetAsync(id, new[] { Guid.NewGuid() }, owner, gate),
            "rename" => await host.RenameAsync(id, owner, "x", gate),
            _ => await host.DeleteAsync(id, gate),
        };
        Assert.Equal(change == "renamed" ? "changed" : change, refused);
        playlists.Verify(p => p.UpdatePlaylist(It.IsAny<PlaylistUpdateRequest>()), Times.Never);
        library.Verify(l => l.DeleteItem(It.IsAny<BaseItem>(), It.IsAny<DeleteOptions>(), It.IsAny<bool>()), Times.Never);
    }

    [Fact]
    public async Task WithNothingChangedBetweenTheReadsTheWriteGoesAhead()
    {
        var id = Guid.NewGuid();
        var owner = Guid.NewGuid();
        var created = new DateTime(2026, 10, 18, 9, 0, 0, DateTimeKind.Utc);
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.RetrieveItem(id)).Returns(() => Make(id, owner, created));
        library.Setup(l => l.GetItemById(id)).Returns(Make(id, owner, created));
        var playlists = new Mock<IPlaylistManager>();
        var host = new JellyfinReadyPlaylistHost(library.Object, playlists.Object, Mock.Of<MediaBrowser.Model.IO.IFileSystem>());
        Assert.Null(await host.SetAsync(id, new[] { Guid.NewGuid() }, owner, PrivateTo(owner)));
        playlists.Verify(p => p.UpdatePlaylist(It.IsAny<PlaylistUpdateRequest>()), Times.Once);
        Assert.Null(await host.DeleteAsync(id, PrivateTo(owner)));
        library.Verify(l => l.DeleteItem(It.IsAny<BaseItem>(), It.IsAny<DeleteOptions>(), true), Times.Once);
    }
}
