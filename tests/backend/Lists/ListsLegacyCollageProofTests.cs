using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Entities;
using Moq;

namespace JE.Tests;

// What may let a legacy collage (or a library tile built from one) be served: only content proves an image isn't the
// collage, only a listing proves a marker isn't there, a hash is exactly 64 lowercase hex characters, nothing JE judged
// once is trusted after the file may have changed, and a library tile built while a list was a collage stays withheld
// until the host has regenerated it, across a restart too.
public class ListsLegacyCollageProofTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "je-legacy-proof-" + Guid.NewGuid().ToString("N"));
    private readonly string _plugin;
    private readonly IReadOnlyList<string> _dirs;
    private readonly Dictionary<Guid, BaseItem> _items = new();
    private readonly Mock<ILibraryManager> _library = new();

    public ListsLegacyCollageProofTests()
    {
        _plugin = Path.Combine(_root, "configurations", "Jellyfin.Plugin.JellyfinEnhanced");
        _dirs = LegacyCollageWithhold.MarkerDirectories(_plugin);
        foreach (var dir in _dirs) Directory.CreateDirectory(dir);
        _library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => _items.GetValueOrDefault(id));
    }

    public void Dispose()
    {
        foreach (var path in Directory.EnumerateFileSystemEntries(_root, "*", SearchOption.AllDirectories).Prepend(_root)) Chmod(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        Directory.Delete(_root, recursive: true);
    }

    private static bool Root => Environment.UserName == "root"; // root reads anything; a permission can't be taken away

    private static void Chmod(string path, UnixFileMode mode)
    {
        if (OperatingSystem.IsWindows()) return;
        try { File.SetUnixFileMode(path, mode); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private LegacyCollageWithhold New() => new(_dirs, _library.Object);

    private static string Sha(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    // Same length for every seed: a replaced image can have the collage's size.
    private static byte[] Bytes(int seed)
    {
        var bytes = new byte[512];
        new Random(seed).NextBytes(bytes);
        return bytes;
    }

    private static readonly DateTime Old = new(2025, 6, 1, 0, 0, 0, DateTimeKind.Utc);

    private T Item<T>(T item, byte[]? image, ImageType type = ImageType.Primary, DateTime? written = null) where T : BaseItem
    {
        item.Id = Guid.NewGuid();
        item.Name = "item";
        if (image != null)
        {
            var path = Path.Combine(_root, "metadata", item.Id.ToString("N"), type.ToString().ToLowerInvariant() + ".jpg");
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllBytes(path, image);
            File.SetLastWriteTimeUtc(path, written ?? Old);
            item.ImageInfos = new[] { new ItemImageInfo { Path = path, Type = type, DateModified = File.GetLastWriteTimeUtc(path) } };
        }

        _items[item.Id] = item;
        return item;
    }

    // The host writes a new image file (an owner's upload, or a regenerated tile).
    private static void Replace(BaseItem item, byte[] bytes, DateTime written)
    {
        var image = item.ImageInfos[0];
        File.WriteAllBytes(image.Path, bytes);
        File.SetLastWriteTimeUtc(image.Path, written);
        image.DateModified = written;
    }

    private static string Marker(BaseItem list, string sha = "", string? pending = null) => JsonSerializer.Serialize(new Dictionary<string, object?>
    {
        ["listId"] = list.Id.ToString("N"),
        ["imagePath"] = "/config/metadata/x/folder.jpg",
        ["sha256"] = sha,
        ["posterKeys"] = new[] { "/a.jpg" },
        ["failedKeys"] = Array.Empty<string>(),
        ["setAt"] = "2025-06-01T00:00:00Z",
        ["pendingSha256"] = pending,
        ["pendingPosterKeys"] = pending == null ? null : new[] { "/a.jpg" },
    });

    private string MarkerPath(int dir, BaseItem list) => Path.Combine(_dirs[dir], list.Id.ToString("N") + ".json");

    private void Write(int dir, BaseItem list, string json) => File.WriteAllText(MarkerPath(dir, list), json);

    private CollectionFolder Tile(CollectionType type, int seed, DateTime? written = null) => Item(new CollectionFolder { CollectionType = type }, Bytes(seed), written: written ?? Old);

    // ── exact parsing (COLLAGE-R1-5) ─────────────────────────────────────

    [Theory]
    [InlineData("sha256", "\n")]
    [InlineData("pendingSha256", "\n")]
    [InlineData("sha256", "\r\n")]
    [InlineData("sha256", " ")]
    [InlineData("pendingSha256", "\u0000")]
    public void AHashWithAnythingAfterItsSixtyFourHexCharactersIsMalformedAndTheListIsWithheld(string field, string suffix)
    {
        var list = Item(new Playlist(), Bytes(1));
        var other = Sha(Bytes(2));
        var fields = new Dictionary<string, object?> { ["listId"] = list.Id.ToString("N"), ["sha256"] = Sha(Bytes(3)), ["pendingSha256"] = null };
        fields[field] = other + suffix;
        var json = JsonSerializer.Serialize(fields);
        Assert.Null(LegacyCollageWithhold.ReadHashes(Encoding.UTF8.GetBytes(json), list.Id.ToString("N")));

        // A malformed hash is no proof that the current image is something else: withheld, not served as "set later".
        Write(0, list, json);
        Assert.Equal(LegacyCollageVerdict.Unreadable, New().Classify(list));
        Assert.True(New().Withholds(list, ImageType.Primary));
    }

    [Fact]
    public void AFileNamedAfterAListIdWithSomethingAfterItIsNoMarkerAndBreaksNothing()
    {
        var list = Item(new Playlist(), Bytes(4));
        File.WriteAllText(Path.Combine(_dirs[0], list.Id.ToString("N") + "\n.json"), Marker(list, Sha(Bytes(4))));
        File.WriteAllText(Path.Combine(_dirs[1], list.Id.ToString("N").ToUpperInvariant() + ".json"), Marker(list, Sha(Bytes(4))));
        var withhold = New();
        Assert.True(withhold.NoMarkers());
        Assert.Equal(LegacyCollageVerdict.NoEvidence, withhold.Classify(list));
        Assert.False(withhold.WithholdsList(list.Id));
    }

    // ── absence is positive (COLLAGE-R1-4) ───────────────────────────────

    [Fact]
    public void AMarkerUnderAFolderThatCantBeEnteredIsNotAbsentAndEveryListIsWithheld()
    {
        if (Root) return;
        var legacy = Item(new Playlist(), Bytes(5));
        Write(0, legacy, Marker(legacy, Sha(Bytes(5))));
        var plain = Item(new BoxSet(), Bytes(6));
        var lists = Path.GetDirectoryName(_dirs[0])!;
        // The marker folder's parent can be listed but not entered: the marker folder can't even be looked at.
        Chmod(lists, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        try
        {
            var withhold = New();
            Assert.False(withhold.NoMarkers());
            Assert.Equal(LegacyCollageVerdict.Unreadable, withhold.Classify(legacy));
            Assert.Equal(LegacyCollageVerdict.Unreadable, withhold.Classify(plain));
            Assert.True(withhold.WithholdsList(legacy.Id));
        }
        finally
        {
            Chmod(lists, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        Assert.Equal(LegacyCollageVerdict.Collage, New().Classify(legacy));
        Assert.Equal(LegacyCollageVerdict.NoEvidence, New().Classify(plain));
    }

    [Fact]
    public void APluginFolderThatCantBeReadProvesNothing()
    {
        if (Root) return;
        foreach (var dir in _dirs) Directory.Delete(Path.GetDirectoryName(dir)!, recursive: true);
        var plain = Item(new Playlist(), Bytes(7));
        // Both marker folders and their parents are gone, and the plugin folder lists without them: absent.
        Assert.True(New().NoMarkers());
        Assert.Equal(LegacyCollageVerdict.NoEvidence, New().Classify(plain));

        Chmod(_plugin, UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        try
        {
            Assert.False(New().NoMarkers());
            Assert.Equal(LegacyCollageVerdict.Unreadable, New().Classify(plain));
        }
        finally
        {
            Chmod(_plugin, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
    }

    [Fact]
    public void AMarkerFolderThatIsNotAFolderIsNotAbsence()
    {
        Directory.Delete(_dirs[1]);
        File.WriteAllText(_dirs[1], "not a folder");
        var plain = Item(new Playlist(), Bytes(8));
        Assert.False(New().NoMarkers());
        Assert.Equal(LegacyCollageVerdict.Unreadable, New().Classify(plain));
    }

    [Fact]
    public void AMarkerEntryThatIsNotAFileIsNotAbsence()
    {
        var list = Item(new Playlist(), Bytes(9));
        Directory.CreateDirectory(MarkerPath(1, list));
        Assert.False(New().NoMarkers());
        Assert.Equal(LegacyCollageVerdict.Unreadable, New().Classify(list));
        Assert.True(New().Withholds(list, ImageType.Primary));
    }

    // ── verdicts keyed by content (COLLAGE-R1-3) ────────────────────────

    [Fact]
    public void AnImageServedAsSetLaterIsWithheldOnceTheCollageComesBackWithTheSameSizeAndTime()
    {
        var list = Item(new Playlist(), Bytes(10));
        Write(0, list, Marker(list, Sha(Bytes(11))));
        var withhold = New();
        Assert.Equal(LegacyCollageVerdict.Superseded, withhold.Classify(list));
        Assert.False(withhold.Withholds(list, ImageType.Primary));

        // A restore (cp -p, rsync -t) puts the collage back: same size, same modification time.
        var path = list.ImageInfos[0].Path;
        var written = File.GetLastWriteTimeUtc(path);
        File.WriteAllBytes(path, Bytes(11));
        File.SetLastWriteTimeUtc(path, written);
        Assert.Equal(LegacyCollageVerdict.Collage, withhold.Classify(list));
        Assert.True(withhold.Withholds(list, ImageType.Primary));
        Assert.True(withhold.WithholdsList(list.Id));
        Assert.True(withhold.AnyWithheld(BaseItemKind.Playlist));
    }

    [Fact]
    public void AnImageThatCouldntBeReadForAMomentIsJudgedAgainOnceItCanBe()
    {
        if (Root) return;
        var list = Item(new Playlist(), Bytes(12));
        Write(0, list, Marker(list, Sha(Bytes(13))));
        var withhold = New();
        var path = list.ImageInfos[0].Path;
        Chmod(path, UnixFileMode.None);
        try
        {
            Assert.Equal(LegacyCollageVerdict.Unreadable, withhold.Classify(list));
            Assert.True(withhold.Withholds(list, ImageType.Primary));
        }
        finally
        {
            Chmod(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }

        // Same size, same time, now readable: the owner's image, served.
        Assert.Equal(LegacyCollageVerdict.Superseded, withhold.Classify(list));
        Assert.False(withhold.Withholds(list, ImageType.Primary));
    }

    [Fact]
    public void AMarkerThatCouldntBeReadForAMomentIsJudgedAgainOnceItCanBe()
    {
        if (Root) return;
        var list = Item(new Playlist(), Bytes(14));
        Write(1, list, Marker(list, Sha(Bytes(15))));
        var withhold = New();
        Chmod(MarkerPath(1, list), UnixFileMode.None);
        try
        {
            Assert.Equal(LegacyCollageVerdict.Unreadable, withhold.Classify(list));
        }
        finally
        {
            Chmod(MarkerPath(1, list), UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }

        Assert.Equal(LegacyCollageVerdict.Superseded, withhold.Classify(list));
    }

    // ── contamination is sticky (COLLAGE-R1-1) ───────────────────────────

    [Fact]
    public void ATileBuiltWhileAListWasACollageStaysWithheldAfterTheLastCollageIsReplacedUntilTheHostRegeneratesIt()
    {
        var list = Item(new Playlist(), Bytes(20));
        Write(0, list, Marker(list, Sha(Bytes(20))));
        var tile = Tile(CollectionType.playlists, 21);
        var withhold = New();
        Assert.True(withhold.Withholds(tile, ImageType.Primary));

        // The owner sets an image on the last collage list: the list is served, the tile still holds the collage's pixels.
        Replace(list, Bytes(22), DateTime.UtcNow);
        Assert.Equal(LegacyCollageVerdict.Superseded, withhold.Classify(list));
        Assert.False(withhold.AnyWithheld(BaseItemKind.Playlist));
        Assert.True(withhold.Withholds(tile, ImageType.Primary));

        // The host regenerates the tile from the lists as they are now.
        Replace(tile, Bytes(23), DateTime.UtcNow.AddMinutes(10));
        Assert.False(withhold.Withholds(tile, ImageType.Primary));
    }

    [Fact]
    public void ATileBuiltWhileAListWasACollageStaysWithheldAfterARestart()
    {
        var list = Item(new BoxSet(), Bytes(24));
        Write(1, list, Marker(list, pending: Sha(Bytes(24))));
        var tile = Tile(CollectionType.boxsets, 25);
        Assert.True(New().Withholds(tile, ImageType.Primary));
        Replace(list, Bytes(26), DateTime.UtcNow);

        var restarted = New();
        Assert.Equal(LegacyCollageVerdict.Superseded, restarted.Classify(list));
        Assert.True(restarted.Withholds(tile, ImageType.Primary));
        Assert.True(New().Withholds(tile, ImageType.Primary));

        Replace(tile, Bytes(27), DateTime.UtcNow.AddMinutes(10));
        Assert.False(New().Withholds(tile, ImageType.Primary));
    }

    [Fact]
    public void ATileOlderThanJesFirstLookAtAListThatOnceHadACollageIsWithheldUntilRegenerated()
    {
        // The owner replaced the collage before this version ever looked: when that happened is unknown.
        var list = Item(new Playlist(), Bytes(28));
        Write(0, list, Marker(list, Sha(Bytes(29))));
        var tile = Tile(CollectionType.playlists, 30);
        var view = Item(new UserView { ViewType = CollectionType.playlists }, Bytes(31), ImageType.Thumb);
        var collections = Tile(CollectionType.boxsets, 32);
        var movies = Tile(CollectionType.movies, 33);
        var withhold = New();
        Assert.False(withhold.AnyWithheld(BaseItemKind.Playlist));
        Assert.True(withhold.Withholds(tile, ImageType.Primary));
        Assert.True(withhold.Withholds(view, ImageType.Thumb));
        // No collection ever had a marker, and other libraries aren't composed from lists.
        Assert.False(withhold.Withholds(collections, ImageType.Primary));
        Assert.False(withhold.Withholds(movies, ImageType.Primary));

        Replace(tile, Bytes(34), DateTime.UtcNow.AddMinutes(10));
        Replace(view, Bytes(35), DateTime.UtcNow.AddMinutes(10));
        Assert.False(withhold.Withholds(tile, ImageType.Primary));
        Assert.False(withhold.Withholds(view, ImageType.Thumb));
    }

    [Fact]
    public void ACopyOfATileSeenWhileAListWasACollageIsWithheldWhateverItsTime()
    {
        var list = Item(new Playlist(), Bytes(36));
        Write(0, list, Marker(list, Sha(Bytes(36))));
        var tile = Tile(CollectionType.playlists, 37);
        Assert.True(New().Withholds(tile, ImageType.Primary));
        Replace(list, Bytes(38), DateTime.UtcNow);
        Replace(tile, Bytes(39), DateTime.UtcNow.AddMinutes(10));
        Assert.False(New().Withholds(tile, ImageType.Primary));

        // Someone copies the old tile back (cp without -p): a new time, the collage's pixels.
        Replace(tile, Bytes(37), DateTime.UtcNow.AddMinutes(20));
        Assert.True(New().Withholds(tile, ImageType.Primary));
    }

    [Fact]
    public void TilesAreUntouchedWhereNoListEverHadAMarker()
    {
        var plain = Item(new Playlist(), Bytes(40));
        var tile = Tile(CollectionType.playlists, 41);
        var withhold = New();
        Assert.True(withhold.NoMarkers());
        Assert.False(withhold.Withholds(tile, ImageType.Primary));
        Assert.False(withhold.Withholds(plain, ImageType.Primary));
    }
}
