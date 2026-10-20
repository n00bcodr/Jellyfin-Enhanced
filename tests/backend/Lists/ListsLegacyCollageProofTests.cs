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

    // ── evidence never forgets, never trusts partial state (COLLAGE-R2-2, -3) ──

    private string StatePath => Path.Combine(Path.GetDirectoryName(_dirs[0])!, LegacyCollageWithhold.TileStateFileName);

    private readonly List<string> _warnings = new();

    private LegacyCollageWithhold Warned() => new(_dirs, _library.Object, () => DateTime.UtcNow, _warnings.Add);

    [Fact]
    public void ProofOfContaminationIsNeverDroppedHoweverManyTilesWereSeen()
    {
        var list = Item(new Playlist(), Bytes(50));
        Write(0, list, Marker(list, Sha(Bytes(50))));
        var tile = Tile(CollectionType.playlists, 51);
        var first = File.ReadAllBytes(tile.ImageInfos[0].Path);
        var withhold = New();
        Assert.True(withhold.Withholds(tile, ImageType.Primary));
        // The host composes the tile again and again while the list is its collage: every content is seen.
        for (var i = 0; i < 600; i++)
        {
            Replace(tile, Bytes(10_000 + i), Old.AddMinutes(i));
            Assert.True(withhold.Withholds(tile, ImageType.Primary));
        }

        // The owner sets an image; the host regenerates the tile from the lists as they are now.
        Replace(list, Bytes(52), DateTime.UtcNow);
        Replace(tile, Bytes(53), DateTime.UtcNow.AddMinutes(10));
        Assert.False(New().Withholds(tile, ImageType.Primary));
        // The first tile built from the collage is put back with a new time: still known.
        Replace(tile, first, DateTime.UtcNow.AddMinutes(20));
        Assert.True(New().Withholds(tile, ImageType.Primary));
    }

    [Fact]
    public void AtCapacityNothingProvenIsDroppedAndEveryTileIsWithheldFromThenOn()
    {
        var known = Enumerable.Range(0, LegacyCollageTiles.MaxTileHashes).Select(i => Sha(BitConverter.GetBytes(i))).ToList();
        var full = new LegacyCollageTiles.State();
        full.Kinds["Playlist"] = new LegacyCollageTiles.KindRecord(false, Old);
        foreach (var sha in known) full.Tiles.Add(sha);
        Directory.CreateDirectory(Path.GetDirectoryName(StatePath)!);
        File.WriteAllBytes(StatePath, LegacyCollageTiles.Serialize(full));

        var list = Item(new Playlist(), Bytes(60));
        Write(0, list, Marker(list, Sha(Bytes(60))));
        var tile = Tile(CollectionType.playlists, 61);
        var collections = Tile(CollectionType.boxsets, 62);
        var withhold = Warned();
        Assert.False(withhold.Withholds(collections, ImageType.Primary));
        Assert.True(withhold.Withholds(tile, ImageType.Primary));
        Assert.Contains(_warnings, w => w.Contains("withheld from now on", StringComparison.Ordinal));

        // Past capacity: no list is a collage any more and both tiles are regenerated, yet every tile stays withheld,
        // and every proof the record held is still in it.
        Replace(list, Bytes(63), DateTime.UtcNow);
        Replace(tile, Bytes(64), DateTime.UtcNow.AddMinutes(10));
        Replace(collections, Bytes(65), DateTime.UtcNow.AddMinutes(10));
        var restarted = New();
        Assert.True(restarted.Withholds(tile, ImageType.Primary));
        Assert.True(restarted.Withholds(collections, ImageType.Primary));
        var record = LegacyCollageTiles.Parse(File.ReadAllBytes(StatePath))!;
        Assert.True(record.Saturated);
        Assert.True(known.All(record.Tiles.Contains));
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"version\":1}")]
    [InlineData("{\"version\":2,\"kinds\":{},\"lists\":{},\"tiles\":[]}")]
    [InlineData("{\"version\":2,\"kinds\":{},\"lists\":{},\"tiles\":[],\"saturated\":false,\"more\":1}")]
    [InlineData("{\"version\":2,\"version\":2,\"kinds\":{},\"lists\":{},\"tiles\":[],\"saturated\":false}")]
    [InlineData("{\"version\":2,\"kinds\":{\"Playlist\":{\"dirty\":false}},\"lists\":{},\"tiles\":[],\"saturated\":false}")]
    [InlineData("{\"version\":2,\"kinds\":{\"Playlist\":{\"dirty\":false,\"cleanFrom\":null}},\"lists\":{},\"tiles\":[],\"saturated\":false}")]
    [InlineData("{\"version\":2,\"kinds\":{\"Movie\":{\"dirty\":true,\"cleanFrom\":null}},\"lists\":{},\"tiles\":[],\"saturated\":false}")]
    [InlineData("{\"version\":2,\"kinds\":{},\"lists\":{\"Playlist|nope\":\"x\"},\"tiles\":[],\"saturated\":false}")]
    [InlineData("{\"version\":2,\"kinds\":{},\"lists\":{},\"tiles\":[\"abc\"],\"saturated\":false}")]
    [InlineData("{\"version\":2,\"kinds\":{},\"lists\":{},\"tiles\":null,\"saturated\":false}")]
    [InlineData("{\"version\":3,\"kinds\":{},\"lists\":{},\"tiles\":[],\"saturated\":false}")]
    [InlineData("[]")]
    [InlineData("null")]
    public void ARecordWithAnythingMissingExtraOrMalformedIsUnknownHistory(string record)
    {
        // No list has a marker any more; the tiles are old.
        var playlists = Tile(CollectionType.playlists, 70);
        var collections = Tile(CollectionType.boxsets, 71);
        Directory.CreateDirectory(Path.GetDirectoryName(StatePath)!);
        File.WriteAllText(StatePath, record);
        var withhold = New();
        Assert.False(withhold.Begin().Idle);
        Assert.True(withhold.Withholds(playlists, ImageType.Primary));
        Assert.True(withhold.Withholds(collections, ImageType.Primary));

        // Unknown history is temporary: the host regenerating a tile releases it.
        Replace(playlists, Bytes(70), DateTime.UtcNow.AddMinutes(10));
        Assert.False(withhold.Withholds(playlists, ImageType.Primary));
    }

    [Fact]
    public void AStrictlyValidRecordIsTrusted()
    {
        var playlists = Tile(CollectionType.playlists, 72);
        Directory.CreateDirectory(Path.GetDirectoryName(StatePath)!);
        File.WriteAllText(StatePath, "{\"version\":2,\"kinds\":{},\"lists\":{},\"tiles\":[],\"saturated\":false}");
        Assert.False(New().Withholds(playlists, ImageType.Primary));
    }

    [Fact]
    public void AProofARecordStillHoldsIsKeptWhenTheRestOfItIsntUnderstood()
    {
        var playlists = Tile(CollectionType.playlists, 73);
        Directory.CreateDirectory(Path.GetDirectoryName(StatePath)!);
        File.WriteAllText(StatePath, "{\"tiles\":[\"" + Sha(Bytes(73)) + "\"]}");
        // Regenerated long after, with those bytes: they were proven to hold a collage.
        Replace(playlists, Bytes(73), DateTime.UtcNow.AddMinutes(10));
        Assert.True(New().Withholds(playlists, ImageType.Primary));
    }

    [Fact]
    public void ARecordThatExistsButCantBeOpenedIsNeverOverwritten()
    {
        if (Root || OperatingSystem.IsWindows()) return;
        var list = Item(new Playlist(), Bytes(80));
        Write(0, list, Marker(list, Sha(Bytes(80))));
        var tile = Tile(CollectionType.playlists, 81);
        Assert.True(New().Withholds(tile, ImageType.Primary));
        var saved = File.ReadAllBytes(StatePath);

        File.SetUnixFileMode(StatePath, UnixFileMode.None);
        try
        {
            // Meanwhile the owner sets an image (a change JE records), and JE looks at the tile again.
            Replace(list, Bytes(82), DateTime.UtcNow);
            var blind = Warned();
            Assert.True(blind.Withholds(tile, ImageType.Primary));
            Assert.Contains(_warnings, w => w.Contains("couldn't be opened", StringComparison.Ordinal));
        }
        finally
        {
            File.SetUnixFileMode(StatePath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }

        Assert.Equal(saved, File.ReadAllBytes(StatePath));
        // The proof it holds still counts: the collage-built tile put back after a regeneration is withheld.
        Replace(tile, Bytes(83), DateTime.UtcNow.AddMinutes(10));
        Assert.False(New().Withholds(tile, ImageType.Primary));
        Replace(tile, Bytes(81), DateTime.UtcNow.AddMinutes(20));
        Assert.True(New().Withholds(tile, ImageType.Primary));
    }

    // ── unknown is not contaminated (COLLAGE-R2-5) ───────────────────────

    [Fact]
    public void UnknownHistoryReleasesTheTileOnceTheHostRegeneratesItEvenWithTheSameBytes()
    {
        // The owner replaced the collage before JE ever looked: when, is unknown.
        var list = Item(new Playlist(), Bytes(90));
        Write(0, list, Marker(list, Sha(Bytes(91))));
        var tile = Tile(CollectionType.playlists, 92);
        Assert.True(New().Withholds(tile, ImageType.Primary));
        Assert.True(New().Withholds(tile, ImageType.Primary));

        // The host composes the tile again from the same list images: identical bytes, written now.
        Replace(tile, Bytes(92), DateTime.UtcNow.AddMinutes(10));
        Assert.False(New().Withholds(tile, ImageType.Primary));
    }

    [Fact]
    public void AListThatCouldntBeReadProvesNothingAboutTheTilesSeenMeanwhile()
    {
        var list = Item(new Playlist(), Bytes(93));
        Write(0, list, "{ not a marker");
        var tile = Tile(CollectionType.playlists, 94);
        var withhold = New();
        Assert.Equal(LegacyCollageVerdict.Unreadable, withhold.Classify(list));
        Assert.True(withhold.Withholds(tile, ImageType.Primary));

        // The marker turns out to name another image (the owner's is served), and the host regenerates the tile from
        // the same images: the old bytes, written after.
        Write(0, list, Marker(list, Sha(Bytes(95))));
        Assert.Equal(LegacyCollageVerdict.Superseded, withhold.Classify(list));
        Replace(tile, Bytes(94), DateTime.UtcNow.AddMinutes(10));
        Assert.False(withhold.Withholds(tile, ImageType.Primary));
    }

    [Fact]
    public void ATileWrittenBeforeTheCollageWasThereIsNotProvenToHoldIt()
    {
        // The collage became the list's image after the host last wrote the tile (seconds after are enough).
        var list = Item(new Playlist(), Bytes(110), written: Old.AddSeconds(10));
        Write(0, list, Marker(list, Sha(Bytes(110))));
        var tile = Tile(CollectionType.playlists, 111);
        Assert.True(New().Withholds(tile, ImageType.Primary));

        // The owner sets an image; the host composes the tile again from the same images as before: the old bytes.
        Replace(list, Bytes(112), DateTime.UtcNow);
        Replace(tile, Bytes(111), DateTime.UtcNow.AddMinutes(10));
        Assert.False(New().Withholds(tile, ImageType.Primary));
    }

    [Fact]
    public void AFileTimeTheHostDidntRecordProvesNoRegeneration()
    {
        var list = Item(new Playlist(), Bytes(96));
        Write(0, list, Marker(list, Sha(Bytes(97))));
        var tile = Tile(CollectionType.playlists, 98);
        Assert.True(New().Withholds(tile, ImageType.Primary));

        // Someone touches the file: new time, but the host's own record of the image is the old one.
        File.SetLastWriteTimeUtc(tile.ImageInfos[0].Path, DateTime.UtcNow.AddMinutes(10));
        Assert.True(New().Withholds(tile, ImageType.Primary));

        // The host saves the tile (its record of the image moves too).
        tile.ImageInfos[0].DateModified = DateTime.UtcNow.AddMinutes(10);
        Assert.False(New().Withholds(tile, ImageType.Primary));
    }
}
