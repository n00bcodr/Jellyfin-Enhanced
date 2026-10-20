using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Playlists;
using Moq;

namespace JE.Tests;

/// <summary>
/// 4f round 7, rule 1 (no write before proof), through the production playlist host over mocked Jellyfin managers: nothing,
/// the heal included, is written to a playlist object (cached or stored) until that object has proven in the same step that
/// it is JE's own (owner, nonce, exact creation second, folder, read from the object itself). A refusal leaves a foreign
/// object exactly as it was, its cached instance included. The interleavings: a playlist put in JE's place between the
/// stored read and the cache lookup, a native save between the heal and the second read, and the create's own allocation.
/// </summary>
public class ReadyWriteProofTests
{
    private const string Marker = "m4rker";
    private const string Nonce = "n0nce";
    private const string Folder = "/config/data/playlists/Ready to watch (" + Marker + ")";
    private static readonly Guid Owner = Guid.NewGuid();
    private static readonly Guid Id = Guid.NewGuid();
    private static readonly DateTime Made = new(2026, 10, 19, 0, 48, 41, DateTimeKind.Utc);
    private static readonly long MadeMs = new DateTimeOffset(Made).ToUnixTimeMilliseconds();

    // JE's playlist as stored: JE's nonce, the create's second, the marker folder, private.
    private static Playlist Jes(string name = "Ready to watch", DateTime? created = null)
        => new() { Id = Id, OwnerUserId = Owner, Path = Folder, Name = name, DateCreated = created ?? Made, ExternalId = JellyfinReadyPlaylistHost.NoncePrefix + Nonce, Shares = Array.Empty<PlaylistUserPermissions>() };

    // The person's own playlist under the same folder (so the same id), made in another second, carrying no nonce, with
    // metadata of their own.
    private static Playlist Theirs(DateTime? created = null, Guid? owner = null)
        => new()
        {
            Id = Id, OwnerUserId = owner ?? Owner, Path = Folder, Name = "Ready to watch", DateCreated = created ?? Made.AddSeconds(1), Overview = "mine",
            Tags = new[] { "mine" }, Genres = new[] { "Kids" }, ForcedSortName = "aaa", ProviderIds = new Dictionary<string, string> { ["Custom"] = "1" },
            Shares = Array.Empty<PlaylistUserPermissions>(),
        };

    private static Playlist Copy(Playlist p)
        => new()
        {
            Id = p.Id, OwnerUserId = p.OwnerUserId, Path = p.Path, Name = p.Name, DateCreated = p.DateCreated, ExternalId = p.ExternalId, Overview = p.Overview,
            Tags = p.Tags?.ToArray() ?? Array.Empty<string>(), Genres = p.Genres?.ToArray() ?? Array.Empty<string>(), ForcedSortName = p.ForcedSortName,
            ProviderIds = new Dictionary<string, string>(p.ProviderIds ?? new Dictionary<string, string>()), Shares = p.Shares?.ToArray() ?? Array.Empty<PlaylistUserPermissions>(),
            OpenAccess = p.OpenAccess,
        };

    // Every field the heal could write, and identity: equal before and after means the object was left exactly as it was.
    private static string Fields(Playlist p)
        => string.Join("|", p.Id, p.OwnerUserId, p.Path, p.Name, p.DateCreated.Ticks, p.ExternalId, p.Overview, string.Join(",", p.Tags ?? Array.Empty<string>()),
            string.Join(",", p.Genres ?? Array.Empty<string>()), p.ForcedSortName, string.Join(",", (p.ProviderIds ?? new Dictionary<string, string>()).Select(kv => kv.Key + "=" + kv.Value)),
            p.Shares?.Count() ?? -1, p.OpenAccess, p.OfficialRating, p.IsLocked, p.Tagline, p.ProductionYear);

    // The service's gate for a bound playlist: marker, JE's nonce and the exact creation second, owner, privacy.
    private static ReadyGate Gate() => stored => stored == null ? "missing"
        : !stored.HasMarker(Marker) || !stored.Carries(Nonce, MadeMs) ? "identity"
        : stored.OwnerId != Owner ? "owner_changed" : stored.OpenAccess ? "public" : stored.ShareCount > 0 ? "shared" : null;

    private sealed class Jellyfin
    {
        public Mock<ILibraryManager> Library { get; } = new();
        public Mock<IPlaylistManager> Playlists { get; } = new();
        public JellyfinReadyPlaylistHost Host { get; }

        /// <summary>The playlist Jellyfin's repository returns on each read (the stored row), by read number (1-based).</summary>
        public Func<int, Playlist?> Stored { get; set; } = _ => null;

        /// <summary>Jellyfin's cached instance.</summary>
        public Playlist? Cached { get; set; }

        public int Reads { get; private set; }

        public Jellyfin()
        {
            Library.Setup(l => l.RetrieveItem(Id)).Returns(() => Stored(++Reads));
            Library.Setup(l => l.GetItemById(Id)).Returns(() => Cached!);
            Playlists.Setup(p => p.UpdatePlaylist(It.IsAny<PlaylistUpdateRequest>())).Returns(Task.CompletedTask);
            Host = new JellyfinReadyPlaylistHost(Library.Object, Playlists.Object, Mock.Of<MediaBrowser.Model.IO.IFileSystem>());
        }

        public Task<string?> Run(string op) => op switch
        {
            "set" => Host.SetAsync(Id, new[] { Guid.NewGuid() }, Owner, Gate()),
            "rename" => Host.RenameAsync(Id, Owner, "Ready to watch", Gate()),
            _ => Host.DeleteAsync(Id, Gate()),
        };

        public void NothingWritten()
        {
            Playlists.Verify(p => p.UpdatePlaylist(It.IsAny<PlaylistUpdateRequest>()), Times.Never());
            Library.Verify(l => l.DeleteItem(It.IsAny<BaseItem>(), It.IsAny<DeleteOptions>(), It.IsAny<bool>()), Times.Never());
        }
    }

    [Theory]
    [InlineData("set")]
    [InlineData("rename")]
    [InlineData("delete")]
    public async Task APlaylistPutInPlaceBetweenTheStoredReadAndTheCacheIsRefusedAndLeftExactlyAsItWas(string op)
    {
        // 4f-r6-security-1: JE read its own stored playlist; before the cache lookup the person deleted it and made their own
        // under the same folder (the same id). A native save of whatever is cached then persists it before JE's second read.
        var jf = new Jellyfin();
        var theirs = Theirs();
        var before = Fields(theirs);
        jf.Cached = theirs;
        jf.Stored = read => read == 1 ? Jes() : Copy(theirs);
        Assert.Equal("identity", await jf.Run(op));
        jf.NothingWritten();
        // Not healed: no nonce, no creation time, none of JE's metadata in the person's object.
        Assert.Equal(before, Fields(theirs));
        Assert.Null(theirs.ExternalId);
    }

    [Theory]
    [InlineData("set")]
    [InlineData("rename")]
    [InlineData("delete")]
    public async Task ACachedReplacementMadeInTheSameSecondIsRefusedToo(string op)
    {
        // The same creation second: the cached object's own nonce (none) is what proves it isn't JE's.
        var jf = new Jellyfin();
        var theirs = Theirs(Made.AddMilliseconds(400));
        var before = Fields(theirs);
        jf.Cached = theirs;
        jf.Stored = read => read == 1 ? Jes() : Copy(theirs);
        Assert.Equal("identity", await jf.Run(op));
        jf.NothingWritten();
        Assert.Equal(before, Fields(theirs));
    }

    [Theory]
    [InlineData("set")]
    [InlineData("delete")]
    public async Task ACachedInstanceNamingAnotherOwnerIsNeverHealedOrWritten(string op)
    {
        var jf = new Jellyfin();
        var cached = Jes();
        cached.OwnerUserId = Guid.NewGuid();
        var before = Fields(cached);
        jf.Cached = cached;
        jf.Stored = _ => Jes();
        Assert.Equal("owner_changed", await jf.Run(op));
        jf.NothingWritten();
        Assert.Equal(before, Fields(cached));
    }

    [Theory]
    [InlineData("set")]
    [InlineData("rename")]
    [InlineData("delete")]
    public async Task ANativeSaveOfAReplacementBetweenTheHealAndTheSecondReadWritesNothingAndLeavesItAlone(string op)
    {
        // JE's own cached instance is proven, then healed; before the second read the person's replacement is stored.
        var jf = new Jellyfin();
        jf.Cached = Jes();
        var theirs = Theirs();
        var before = Fields(theirs);
        jf.Stored = read => read == 1 ? Jes("Watch later") : theirs;
        Assert.Equal("identity", await jf.Run(op));
        jf.NothingWritten();
        Assert.Equal(before, Fields(theirs));
    }

    [Theory]
    [InlineData("set")]
    [InlineData("delete")]
    public async Task ANativeRenameBetweenTheHealAndTheSecondReadWritesNothing(string op)
    {
        var jf = new Jellyfin();
        jf.Cached = Jes();
        jf.Stored = read => read == 1 ? Jes() : Jes("Kids' picks");
        Assert.Equal("changed", await jf.Run(op));
        jf.NothingWritten();
    }

    [Theory]
    [InlineData("set")]
    [InlineData("rename")]
    [InlineData("delete")]
    public async Task JesOwnProvenPlaylistIsHealedFromWhatIsStoredAndWritten(string op)
    {
        // Control: the cached instance carries JE's nonce and second (with the fraction the create gave it); the person
        // renamed it natively (stored only). The heal copies the person's name, never identity; then the write goes ahead.
        var jf = new Jellyfin();
        var cached = Jes(created: Made.AddMilliseconds(346));
        jf.Cached = cached;
        jf.Stored = _ => Jes("Watch later");
        Assert.Null(await jf.Run(op));
        if (op == "delete") jf.Library.Verify(l => l.DeleteItem(cached, It.IsAny<DeleteOptions>(), true), Times.Once());
        else jf.Playlists.Verify(p => p.UpdatePlaylist(It.Is<PlaylistUpdateRequest>(r => r.Id == Id && r.UserId == Owner)), Times.Once());
        Assert.Equal("Watch later", cached.Name);
        Assert.Equal(Made.AddMilliseconds(346), cached.DateCreated);
        Assert.Equal(JellyfinReadyPlaylistHost.NoncePrefix + Nonce, cached.ExternalId);
    }

    // ------------------------------------------------------------------ the create's own allocation

    private static (JellyfinReadyPlaylistHost Host, Mock<ILibraryManager> Library, Mock<IPlaylistManager> Playlists) Creating(Guid expected)
    {
        var library = new Mock<ILibraryManager>();
        var playlists = new Mock<IPlaylistManager>();
        var files = new Mock<MediaBrowser.Model.IO.IFileSystem>();
        files.Setup(f => f.GetValidFilename(It.IsAny<string>())).Returns<string>(name => name);
        playlists.Setup(p => p.GetPlaylistsFolder()).Returns(new Folder { Path = "/config/data/playlists" });
        library.Setup(l => l.GetNewItemId(Folder, typeof(Playlist))).Returns(expected);
        return (new JellyfinReadyPlaylistHost(library.Object, playlists.Object, files.Object), library, playlists);
    }

    private static Playlist Allocated(Guid id) => new() { Id = id, Name = "Ready to watch (" + Marker + ")", OwnerUserId = Owner, DateCreated = Made, Path = Folder };

    [Fact]
    public async Task TheNonceGoesOnlyIntoThePlaylistWithTheIdTheCreatesFolderGives()
    {
        // A playlist of the owner under the create's name, but not with the id the create's folder gives, is added on JE's
        // call path first (another create running inside the same call): never written; the create is ambiguous.
        var expected = Guid.NewGuid();
        var (host, library, playlists) = Creating(expected);
        var other = Allocated(Guid.NewGuid());
        var own = Allocated(expected);
        playlists.Setup(p => p.CreatePlaylist(It.IsAny<PlaylistCreationRequest>())).Returns<PlaylistCreationRequest>(_ =>
        {
            library.Raise(l => l.ItemAdded += null, null, new ItemChangeEventArgs { Item = other });
            library.Raise(l => l.ItemAdded += null, null, new ItemChangeEventArgs { Item = own });
            return Task.FromResult(new PlaylistCreationResult(expected.ToString("N")));
        });
        var (made, refused) = await host.CreateAsync(Owner, "Ready to watch (" + Marker + ")", Nonce, _ => null);
        Assert.Null(made);
        Assert.Equal("provenance", refused);
        Assert.Null(other.ExternalId);
        Assert.Null(own.ExternalId);
    }

    [Fact]
    public async Task OnlyAnObjectWithTheExpectedIdCarriesTheNonce()
    {
        // The only candidate has another id than the create's folder gives: never written, nothing is JE's.
        var expected = Guid.NewGuid();
        var (host, library, playlists) = Creating(expected);
        var other = Allocated(Guid.NewGuid());
        playlists.Setup(p => p.CreatePlaylist(It.IsAny<PlaylistCreationRequest>())).Returns<PlaylistCreationRequest>(_ =>
        {
            library.Raise(l => l.ItemAdded += null, null, new ItemChangeEventArgs { Item = other });
            return Task.FromResult(new PlaylistCreationResult(other.Id.ToString("N")));
        });
        var (made, refused) = await host.CreateAsync(Owner, "Ready to watch (" + Marker + ")", Nonce, _ => null);
        Assert.Null(made);
        Assert.Equal("provenance", refused);
        Assert.Null(other.ExternalId);
    }

    [Fact]
    public async Task TheCreatesOwnAllocationRaisedTwiceIsStillOneCandidate()
    {
        var expected = Guid.NewGuid();
        var (host, library, playlists) = Creating(expected);
        var own = Allocated(expected);
        playlists.Setup(p => p.CreatePlaylist(It.IsAny<PlaylistCreationRequest>())).Returns<PlaylistCreationRequest>(_ =>
        {
            library.Raise(l => l.ItemAdded += null, null, new ItemChangeEventArgs { Item = own });
            library.Raise(l => l.ItemAdded += null, null, new ItemChangeEventArgs { Item = own });
            return Task.FromResult(new PlaylistCreationResult(expected.ToString("N")));
        });
        var (made, refused) = await host.CreateAsync(Owner, "Ready to watch (" + Marker + ")", Nonce, _ => null);
        Assert.Null(refused);
        Assert.Equal(new ReadyCreated(expected, new DateTimeOffset(Made).ToUnixTimeSeconds()), made);
        Assert.Equal(JellyfinReadyPlaylistHost.NoncePrefix + Nonce, own.ExternalId);
    }
}
