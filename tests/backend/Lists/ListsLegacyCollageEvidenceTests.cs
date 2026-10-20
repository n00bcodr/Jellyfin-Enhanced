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

// The evidence side of withholding closed PR #936's list collages: what proves a list's current Primary is the collage
// (content against the hashes a marker for that list recorded), that anything JE can't read or understand counts as
// the collage, that an image set later and lists without a marker are untouched, that a replaced image or marker is
// judged again, and that nothing is ever written.
public class ListsLegacyCollageEvidenceTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "je-legacy-evidence-" + Guid.NewGuid().ToString("N"));
    private readonly string _copied;
    private readonly string _original;
    private readonly Dictionary<Guid, BaseItem> _items = new();
    private readonly LegacyCollageWithhold _withhold;

    public ListsLegacyCollageEvidenceTests()
    {
        var plugin = Path.Combine(_root, "configurations", "Jellyfin.Plugin.JellyfinEnhanced");
        var dirs = LegacyCollageWithhold.MarkerDirectories(plugin);
        _copied = dirs[0];
        _original = dirs[1];
        Assert.Equal(Path.Combine(plugin, "lists", "legacy-collages"), _copied);
        Assert.Equal(Path.Combine(plugin, "list-placeholders", "collages"), _original);
        Directory.CreateDirectory(_copied);
        Directory.CreateDirectory(_original);
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => _items.GetValueOrDefault(id));
        _withhold = new LegacyCollageWithhold(dirs, library.Object);
    }

    public void Dispose()
    {
        foreach (var dir in Directory.EnumerateDirectories(_root, "*", SearchOption.AllDirectories)) TryChmod(dir, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        Directory.Delete(_root, recursive: true);
    }

    private static void TryChmod(string path, UnixFileMode mode)
    {
        if (OperatingSystem.IsWindows()) return;
        try { File.SetUnixFileMode(path, mode); } catch (IOException) { }
    }

    private static string Sha(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static byte[] Bytes(int seed)
    {
        var bytes = new byte[512];
        new Random(seed).NextBytes(bytes);
        return bytes;
    }

    private T List<T>(T item, byte[]? image) where T : BaseItem
    {
        item.Id = Guid.NewGuid();
        item.Name = "list";
        if (image != null)
        {
            var path = Path.Combine(_root, "metadata", item.Id.ToString("N"), "folder.jpg");
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllBytes(path, image);
            item.ImageInfos = new[] { new ItemImageInfo { Path = path, Type = ImageType.Primary, DateModified = File.GetLastWriteTimeUtc(path) } };
        }

        _items[item.Id] = item;
        return item;
    }

    private static string Marker(BaseItem list, string sha = "", string? pending = null) => JsonSerializer.Serialize(new Dictionary<string, object?>
    {
        ["listId"] = list.Id.ToString("N"),
        ["imagePath"] = sha.Length == 0 ? string.Empty : list.ImageInfos.FirstOrDefault()?.Path ?? "/x",
        ["sha256"] = sha,
        ["posterKeys"] = new[] { "/a.jpg" },
        ["failedKeys"] = Array.Empty<string>(),
        ["setAt"] = "2025-06-01T00:00:00Z",
        ["pendingSha256"] = pending,
        ["pendingPosterKeys"] = pending == null ? null : new[] { "/a.jpg" },
    });

    private void Write(string dir, BaseItem list, string json) => File.WriteAllText(Path.Combine(dir, list.Id.ToString("N") + ".json"), json);

    // Every file but JE's own record of library tiles built from a collage (its only write).
    private Dictionary<string, (string, DateTime)> Snapshot() => Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories)
        .Where(f => Path.GetFileName(f) != LegacyCollageWithhold.TileStateFileName)
        .ToDictionary(f => f, f => (Sha(File.ReadAllBytes(f)), File.GetLastWriteTimeUtc(f)));

    // ── marker reading ─────────────────────────────────────────────

    [Fact]
    public void AMarkerGivesTheSavedAndThePendingHashOfItsOwnListOnly()
    {
        var id = Guid.NewGuid().ToString("N");
        var a = new string('a', 64);
        var b = new string('b', 64);
        string M(string body) => "{\"listId\":\"" + id + "\"" + body + "}";
        Assert.Equal(new[] { a }, LegacyCollageWithhold.ReadHashes(Encoding.UTF8.GetBytes(M(",\"sha256\":\"" + a + "\",\"pendingSha256\":null")), id));
        Assert.Equal(new[] { b }, LegacyCollageWithhold.ReadHashes(Encoding.UTF8.GetBytes(M(",\"sha256\":\"\",\"pendingSha256\":\"" + b + "\"")), id));
        Assert.Equal(new[] { a, b }, LegacyCollageWithhold.ReadHashes(Encoding.UTF8.GetBytes(M(",\"sha256\":\"" + a + "\",\"pendingSha256\":\"" + b + "\",\"extra\":[1,{}]")), id));
        Assert.Null(LegacyCollageWithhold.ReadHashes(Encoding.UTF8.GetBytes(M(",\"sha256\":\"" + a + "\"")), Guid.NewGuid().ToString("N")));
    }

    [Theory]
    [InlineData("")]
    [InlineData("[]")]
    [InlineData("\"x\"")]
    [InlineData("{}")]
    [InlineData("{\"listId\":\"@ID\"}")]
    [InlineData("{\"listId\":\"@ID\",\"sha256\":\"\",\"pendingSha256\":null}")]
    [InlineData("{\"sha256\":\"@A\"}")]
    [InlineData("{\"listId\":7,\"sha256\":\"@A\"}")]
    [InlineData("{\"listId\":\"@ID\",\"sha256\":7}")]
    [InlineData("{\"listId\":\"@ID\",\"sha256\":\"@A\",\"sha256\":\"@A\"}")]
    [InlineData("{\"listId\":\"@ID\",\"listId\":\"@ID\",\"sha256\":\"@A\"}")]
    [InlineData("{\"listId\":\"@ID\",\"sha256\":\"ABCDEF\"}")]
    [InlineData("{\"listId\":\"@ID\",\"sha256\":\"@UPPER\"}")]
    [InlineData("{\"listId\":\"@ID\",\"sha256\":\"@A\",\"pendingSha256\":\"zz\"}")]
    [InlineData("{\"listId\":\"@ID\",\"sha256\":\"@A\"} trailing")]
    [InlineData("{\"listId\":\"@ID\",\"sha256\":\"@A\",}")]
    [InlineData("{/*c*/\"listId\":\"@ID\",\"sha256\":\"@A\"}")]
    [InlineData("{\"listId\":\"@ID\",\"sha256\":\"@A\",\"x\":[[[[[1]]]]]}")]
    // Unpaired escaped surrogates in a value, a property name and an array element (they make the reader throw
    // InvalidOperationException, not JsonException).
    [InlineData("{\"listId\":\"\\uD800\",\"sha256\":\"@A\"}")]
    [InlineData("{\"listId\":\"@ID\",\"\\uDC00\":1,\"sha256\":\"@A\"}")]
    [InlineData("{\"listId\":\"@ID\",\"sha256\":\"@A\\uD800\"}")]
    [InlineData("{\"listId\":\"@ID\",\"pendingSha256\":\"\\uDBFF\\u0041\"}")]
    public void AnythingThatIsNotAMarkerOfThisListWithAHashIsNoEvidenceAndNeverThrows(string template)
    {
        var id = Guid.NewGuid().ToString("N");
        var json = template.Replace("@ID", id).Replace("@UPPER", new string('A', 64)).Replace("@A", new string('a', 64));
        Assert.Null(LegacyCollageWithhold.ReadHashes(Encoding.UTF8.GetBytes(json), id));
    }

    [Fact]
    public void InvalidUtf8IsNoEvidence()
    {
        var id = Guid.NewGuid().ToString("N");
        var bytes = Encoding.UTF8.GetBytes("{\"listId\":\"" + id + "\",\"sha256\":\"" + new string('a', 64) + "\",\"n\":\"\"}").ToList();
        bytes.Insert(bytes.Count - 3, 0xC3);
        Assert.Null(LegacyCollageWithhold.ReadHashes(bytes.ToArray(), id));
    }

    // ── verdicts ───────────────────────────────────────────────────

    [Fact]
    public void TheRecordedCollageIsWithheldWhetherSavedPendingCopiedOrOnlyInTheExperimentalFolder()
    {
        var saved = List(new Playlist(), Bytes(1));
        Write(_copied, saved, Marker(saved, Sha(Bytes(1))));
        var pending = List(new BoxSet(), Bytes(2));
        Write(_original, pending, Marker(pending, pending: Sha(Bytes(2))));
        var both = List(new Playlist(), Bytes(3));
        Write(_copied, both, Marker(both, Sha(Bytes(30))));
        Write(_original, both, Marker(both, Sha(Bytes(3))));

        foreach (var list in new BaseItem[] { saved, pending, both })
        {
            Assert.Equal(LegacyCollageVerdict.Collage, _withhold.Classify(list));
            Assert.True(_withhold.Withholds(list, ImageType.Primary));
            Assert.True(_withhold.WithholdsList(list.Id));
            Assert.False(_withhold.Withholds(list, ImageType.Backdrop));
            Assert.False(_withhold.Withholds(list, ImageType.Thumb));
        }

        Assert.True(_withhold.AnyWithheld(BaseItemKind.Playlist));
        Assert.True(_withhold.AnyWithheld(BaseItemKind.BoxSet));
    }

    [Fact]
    public void AnImageSetLaterIsServedAndIsJudgedAgainWhenTheFileChanges()
    {
        var list = List(new Playlist(), Bytes(4));
        Write(_copied, list, Marker(list, Sha(Bytes(40))));
        Assert.Equal(LegacyCollageVerdict.Superseded, _withhold.Classify(list));
        Assert.False(_withhold.Withholds(list, ImageType.Primary));
        Assert.False(_withhold.AnyWithheld(BaseItemKind.Playlist));

        // The collage comes back (a restore, say): the cached verdict follows the file.
        var path = list.ImageInfos[0].Path;
        File.WriteAllBytes(path, Bytes(40));
        File.SetLastWriteTimeUtc(path, DateTime.UtcNow.AddMinutes(1));
        Assert.Equal(LegacyCollageVerdict.Collage, _withhold.Classify(list));
        Assert.True(_withhold.AnyWithheld(BaseItemKind.Playlist));

        // And a marker that changes is read again too.
        Write(_copied, list, Marker(list, Sha(Bytes(41))));
        File.SetLastWriteTimeUtc(Path.Combine(_copied, list.Id.ToString("N") + ".json"), DateTime.UtcNow.AddMinutes(2));
        Assert.Equal(LegacyCollageVerdict.Superseded, _withhold.Classify(list));
    }

    [Fact]
    public void ListsWithoutAMarkerOtherItemsAndListsWithoutAnImageAreUntouched()
    {
        var plain = List(new Playlist(), Bytes(5));
        Assert.Equal(LegacyCollageVerdict.NoEvidence, _withhold.Classify(plain));
        var movie = List(new MediaBrowser.Controller.Entities.Movies.Movie(), Bytes(6));
        Write(_copied, movie, Marker(movie, Sha(Bytes(6))));
        Assert.Equal(LegacyCollageVerdict.NoEvidence, _withhold.Classify(movie));
        Assert.False(_withhold.Withholds(movie, ImageType.Primary));
        var bare = List(new Playlist(), null);
        Write(_copied, bare, Marker(bare, Sha(Bytes(7))));
        Assert.Equal(LegacyCollageVerdict.NoImage, _withhold.Classify(bare));
        Assert.False(_withhold.AnyWithheld(BaseItemKind.Playlist));
        Assert.False(_withhold.WithholdsList(Guid.NewGuid()));
    }

    [Fact]
    public void WhatJeCantReadOrUnderstandCountsAsTheCollage()
    {
        var corrupt = List(new Playlist(), Bytes(8));
        Write(_copied, corrupt, "{ not json");
        var huge = List(new Playlist(), Bytes(9));
        Write(_copied, huge, Marker(huge, Sha(Bytes(9))).Replace("\"setAt\"", "\"pad\":\"" + new string('x', (int)LegacyCollageWithhold.MaxMarkerBytes) + "\",\"setAt\"", StringComparison.Ordinal));
        var wrongList = List(new BoxSet(), Bytes(10));
        Write(_copied, wrongList, Marker(corrupt, Sha(Bytes(10))));
        var missingImage = List(new Playlist(), Bytes(11));
        Write(_copied, missingImage, Marker(missingImage, Sha(Bytes(99))));
        File.Delete(missingImage.ImageInfos[0].Path);
        var remote = List(new Playlist(), null);
        remote.ImageInfos = new[] { new ItemImageInfo { Path = "https://example.invalid/p.jpg", Type = ImageType.Primary } };
        Write(_copied, remote, Marker(remote, Sha(Bytes(12))));
        // One good marker does not outvote an unreadable one.
        var mixed = List(new Playlist(), Bytes(13));
        Write(_copied, mixed, Marker(mixed, Sha(Bytes(130))));
        Write(_original, mixed, "[]");

        foreach (var list in new BaseItem[] { corrupt, huge, wrongList, missingImage, remote, mixed })
        {
            Assert.Equal(LegacyCollageVerdict.Unreadable, _withhold.Classify(list));
            Assert.True(_withhold.Withholds(list, ImageType.Primary));
        }
    }

    [Fact]
    public void AMarkerFolderThatCantBeListedWithholdsEveryListImageAndEveryLibraryTile()
    {
        if (Environment.UserName == "root") return; // root reads anything; the permission can't be taken away
        var plain = List(new Playlist(), Bytes(14));
        var set = List(new BoxSet(), Bytes(15));
        var folder = List(new CollectionFolder { CollectionType = CollectionType.movies }, Bytes(16));
        TryChmod(_copied, UnixFileMode.None);
        try
        {
            Assert.False(_withhold.NoMarkers());
            Assert.Equal(LegacyCollageVerdict.Unreadable, _withhold.Classify(plain));
            Assert.Equal(LegacyCollageVerdict.Unreadable, _withhold.Classify(set));
            Assert.True(_withhold.AnyWithheld(BaseItemKind.Playlist));
            Assert.False(_withhold.Withholds(folder, ImageType.Primary));
        }
        finally
        {
            TryChmod(_copied, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        Assert.True(_withhold.NoMarkers());
        Assert.Equal(LegacyCollageVerdict.NoEvidence, _withhold.Classify(plain));
    }

    [Fact]
    public void LibraryTilesOfTheWithheldKindAreWithheldAndNoOtherFolderIs()
    {
        var playlists = List(new CollectionFolder { CollectionType = CollectionType.playlists }, Bytes(17));
        var collections = List(new CollectionFolder { CollectionType = CollectionType.boxsets }, Bytes(18));
        var view = List(new UserView { ViewType = CollectionType.playlists }, Bytes(19));
        var movies = List(new CollectionFolder { CollectionType = CollectionType.movies }, Bytes(20));
        Assert.True(_withhold.NoMarkers());
        Assert.False(_withhold.Withholds(playlists, ImageType.Primary));

        var list = List(new Playlist(), Bytes(21));
        Write(_copied, list, Marker(list, Sha(Bytes(21))));
        Assert.False(_withhold.NoMarkers());
        Assert.True(_withhold.Withholds(playlists, ImageType.Primary));
        Assert.True(_withhold.Withholds(playlists, ImageType.Thumb));
        Assert.True(_withhold.Withholds(view, ImageType.Primary));
        Assert.False(_withhold.Withholds(playlists, ImageType.Backdrop));
        Assert.False(_withhold.Withholds(collections, ImageType.Primary));
        Assert.False(_withhold.Withholds(movies, ImageType.Primary));
        Assert.Equal(BaseItemKind.Playlist, LegacyCollageWithhold.HolderKind(CollectionType.playlists));
        Assert.Equal(BaseItemKind.BoxSet, LegacyCollageWithhold.HolderKind(CollectionType.boxsets));
        Assert.Null(LegacyCollageWithhold.HolderKind(CollectionType.movies));
        Assert.Null(LegacyCollageWithhold.HolderKind(null));
    }

    [Fact]
    public void JudgingNeverWritesDeletesOrTouchesAFile()
    {
        var a = List(new Playlist(), Bytes(22));
        Write(_copied, a, Marker(a, Sha(Bytes(22))));
        var b = List(new BoxSet(), Bytes(23));
        Write(_original, b, "{ bad");
        var c = List(new Playlist(), Bytes(24));
        Write(_copied, c, Marker(c, Sha(Bytes(240))));
        var before = Snapshot();
        for (var i = 0; i < 3; i++)
        {
            foreach (var item in new BaseItem[] { a, b, c }) _withhold.Classify(item);
            _withhold.AnyWithheld(BaseItemKind.Playlist);
            _withhold.AnyWithheld(BaseItemKind.BoxSet);
        }

        Assert.Equal(before, Snapshot());
        // The record sits next to the importer's marker copies, outside both marker folders.
        Assert.True(File.Exists(Path.Combine(Path.GetDirectoryName(_copied)!, LegacyCollageWithhold.TileStateFileName)));
    }
}
