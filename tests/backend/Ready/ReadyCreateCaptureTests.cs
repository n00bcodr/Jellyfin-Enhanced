using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Playlists;
using Moq;

namespace JE.Tests;

/// <summary>
/// 4f round 6: the production playlist host takes JE's ownership evidence from inside Jellyfin's create (the playlist object
/// the create allocated, raised synchronously through <see cref="ILibraryManager.ItemAdded"/> on JE's own call path before the
/// create's refresh: probed live on 12.2 and 10.11.11), and refuses when it can't; a withheld inbox row is an allowlisted
/// generic shape; an OK that fell back to waiting says so.
/// </summary>
public class ReadyCreateCaptureTests
{
    private static readonly Guid Owner = Guid.NewGuid();
    private const string Name = "Ready to watch (m4rker)";
    private static readonly DateTime Made = new(2026, 10, 19, 0, 48, 41, 346, DateTimeKind.Utc);

    private static Playlist Allocated(Guid id, Guid? owner = null, string name = Name)
        => new() { Id = id, Name = name, OwnerUserId = owner ?? Owner, DateCreated = Made, Path = "/config/data/playlists/" + name };

    // The host over Jellyfin's managers; its create's folder gives the playlist <paramref name="expected"/> (as Jellyfin derives it).
    private static (JellyfinReadyPlaylistHost Host, Mock<ILibraryManager> Library, Mock<IPlaylistManager> Playlists) Host(Guid? expected = null)
    {
        var library = new Mock<ILibraryManager>();
        var playlists = new Mock<IPlaylistManager>();
        var files = new Mock<MediaBrowser.Model.IO.IFileSystem>();
        files.Setup(f => f.GetValidFilename(It.IsAny<string>())).Returns<string>(name => name);
        playlists.Setup(p => p.GetPlaylistsFolder()).Returns(new Folder { Path = "/config/data/playlists" });
        if (expected is Guid id) library.Setup(l => l.GetNewItemId("/config/data/playlists/" + Name, typeof(Playlist))).Returns(id);
        return (new JellyfinReadyPlaylistHost(library.Object, playlists.Object, files.Object), library, playlists);
    }

    private static void Raise(Mock<ILibraryManager> library, BaseItem item)
        => library.Raise(l => l.ItemAdded += null, null, new ItemChangeEventArgs { Item = item });

    [Fact]
    public async Task TheCreatesOwnPlaylistCarriesJesNonceAndItsSecondFromTheCreateItself()
    {
        var id = Guid.NewGuid();
        var (host, library, playlists) = Host(id);
        var playlist = Allocated(id);
        PlaylistCreationRequest? asked = null;
        playlists.Setup(p => p.CreatePlaylist(It.IsAny<PlaylistCreationRequest>())).Returns<PlaylistCreationRequest>(request =>
        {
            asked = request;
            // As Jellyfin: Folder.AddChild raises ItemAdded synchronously, then the refresh is awaited (not yet done).
            Raise(library, playlist);
            return Task.FromResult(new PlaylistCreationResult(id.ToString("N")));
        });
        var (made, refused) = await host.CreateAsync(Owner, Name, "n0nce", _ => null);
        Assert.Null(refused);
        Assert.Equal(new ReadyCreated(id, new DateTimeOffset(Made).ToUnixTimeSeconds()), made);
        Assert.Equal(JellyfinReadyPlaylistHost.NoncePrefix + "n0nce", playlist.ExternalId);
        Assert.Equal(MediaType.Video, asked!.MediaType);
        Assert.False(asked.Public);
        Assert.Empty(asked.Users);
    }

    [Theory]
    [InlineData("none")]          // no event on JE's call path
    [InlineData("other-owner")]   // another person's playlist added meanwhile
    [InlineData("other-name")]
    [InlineData("two")]           // two candidates: ambiguous
    [InlineData("other-id")]      // the create reports another id than the object it added
    [InlineData("later")]         // raised only after the create returned its task (not the create's own synchronous add)
    public async Task WithoutExactlyTheCreatesOwnPlaylistNothingIsJes(string how)
    {
        var id = Guid.NewGuid();
        var (host, library, playlists) = Host(id);
        var playlist = Allocated(how == "other-owner" ? id : id, how == "other-owner" ? Guid.NewGuid() : null, how == "other-name" ? "Ready to watch" : Name);
        var later = new TaskCompletionSource<PlaylistCreationResult>();
        playlists.Setup(p => p.CreatePlaylist(It.IsAny<PlaylistCreationRequest>())).Returns<PlaylistCreationRequest>(_ =>
        {
            switch (how)
            {
                case "none":
                case "later":
                    break;
                case "two":
                    Raise(library, playlist);
                    Raise(library, Allocated(Guid.NewGuid()));
                    break;
                default:
                    Raise(library, playlist);
                    break;
            }

            if (how == "later") return later.Task;
            return Task.FromResult(new PlaylistCreationResult((how == "other-id" ? Guid.NewGuid() : id).ToString("N")));
        });
        var creating = host.CreateAsync(Owner, Name, "n0nce", _ => null);
        if (how == "later")
        {
            Raise(library, playlist);
            later.SetResult(new PlaylistCreationResult(id.ToString("N")));
        }

        var (made, refused) = await creating;
        Assert.Null(made);
        Assert.Equal("provenance", refused);
        if (how is "none" or "later" or "other-owner" or "other-name") Assert.Null(playlist.ExternalId);
    }

    [Fact]
    public async Task APlaylistAddedOutsideJesCreateIsNeverTouched()
    {
        // Another request's create (the person's own, on its own call path) raises ItemAdded with no create of JE's there.
        var (host, library, _) = Host();
        var theirs = Allocated(Guid.NewGuid());
        Raise(library, theirs);
        Assert.Null(theirs.ExternalId);
        await Task.Run(() => Raise(library, theirs));
        Assert.Null(theirs.ExternalId);
        host.Dispose();
    }

    [Fact]
    public async Task ARefusedGateNeverCallsJellyfin()
    {
        var (host, _, playlists) = Host();
        Assert.Equal((null, "off"), await host.CreateAsync(Owner, Name, "n0nce", _ => "off"));
        playlists.Verify(p => p.CreatePlaylist(It.IsAny<PlaylistCreationRequest>()), Times.Never());
    }

    [Fact]
    public void AWithheldRowKeepsOnlyTheAllowlistedGenericShape()
    {
        var full = new Dictionary<string, string>
        {
            ["title"] = "Dune: Part Two", ["year"] = "2024", ["poster"] = "/p.jpg", ["image"] = "x", ["reason"] = "Dune is too violent",
            ["contact"] = "Dad", ["scope"] = "S1", ["seasons"] = "1, 2", ["season"] = "1", ["episode"] = "4", ["user"] = "Emma",
            ["mode"] = "single", ["requested"] = "1", ["variant"] = "4k", ["shared"] = "1", ["count"] = "3",
        };
        Assert.Equal(new Dictionary<string, string> { ["variant"] = "4k", ["shared"] = "1" }, NotifyController.Withheld(NotifyKind.Declined, full));
        Assert.Equal(new Dictionary<string, string> { ["variant"] = "4k", ["shared"] = "1", ["count"] = "3" }, NotifyController.Withheld(NotifyKind.Episodes, full));
        // Only the fixed forms: anything else in those keys is dropped too.
        Assert.Empty(NotifyController.Withheld(NotifyKind.Episodes, new Dictionary<string, string> { ["variant"] = "Dune", ["shared"] = "yes", ["count"] = "Dune" }));
    }

    [Theory]
    [InlineData(null, null, "removed")]
    [InlineData("pending", "no_instance", "waiting again since it was OK'd: it couldn't be sent to Sonarr or Radarr (no_instance)")]
    [InlineData("pending", null, "waiting again")]
    [InlineData("declined", null, "declined since")]
    [InlineData("cancelled", null, "cancelled since")]
    public void AnOkThatIsNoLongerOneSaysWhatItIsNow(string? status, string? reason, string says)
        => Assert.Contains(says, NotifyDispatcher.NoLongerOkd(status, reason), StringComparison.Ordinal);
}
