using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Entities;
using Moq;

namespace JE.Tests;

// A library tile is released only when the host has composed that very content from sources proven clean, through the
// image processor the plugin's registration leaves the host: a composition that read a collage stays withheld however
// late it finishes, a tile's dates release nothing, and retrying a record JE can't open proves nothing new.
public class ListsLegacyCollageCompositionTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "je-legacy-compose-" + Guid.NewGuid().ToString("N"));
    private readonly string _plugins;
    private readonly string _temp;
    private readonly IReadOnlyList<string> _dirs;
    private readonly Dictionary<Guid, BaseItem> _items = new();
    private readonly Mock<ILibraryManager> _library = new();

    public ListsLegacyCollageCompositionTests()
    {
        _plugins = Path.Combine(_root, "plugins");
        _temp = Path.Combine(_root, "temp");
        _dirs = LegacyCollageComposing.MarkerDirectories(_plugins);
        foreach (var dir in _dirs) Directory.CreateDirectory(dir);
        Directory.CreateDirectory(_temp);
        _library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => _items.GetValueOrDefault(id));
        LegacyCollageComposing.Lists(_library, _items);
    }

    public void Dispose()
    {
        foreach (var path in Directory.EnumerateFileSystemEntries(_root, "*", SearchOption.AllDirectories).Prepend(_root))
            if (!OperatingSystem.IsWindows()) try { File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute); } catch (IOException) { }
        Directory.Delete(_root, recursive: true);
    }

    private string RecordPath => Path.Combine(Path.GetDirectoryName(_dirs[0])!, LegacyCollageWithhold.TileStateFileName);

    private static string Sha(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private T Item<T>(T item, string image, DateTime written, ImageType type = ImageType.Primary) where T : BaseItem
    {
        item.Id = Guid.NewGuid();
        item.Name = typeof(T).Name;
        var path = Path.Combine(_root, "metadata", item.Id.ToString("N"), type.ToString().ToLowerInvariant() + ".jpg");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, image);
        File.SetLastWriteTimeUtc(path, written);
        item.ImageInfos = new[] { new ItemImageInfo { Path = path, Type = type, DateModified = written } };
        _items[item.Id] = item;
        return item;
    }

    private static void Replace(BaseItem item, string image, DateTime written)
    {
        File.WriteAllText(item.ImageInfos[0].Path, image);
        File.SetLastWriteTimeUtc(item.ImageInfos[0].Path, written);
        item.ImageInfos[0].DateModified = written;
    }

    private void Marker(BaseItem list, string collage)
        => File.WriteAllText(Path.Combine(_dirs[0], list.Id.ToString("N") + ".json"), JsonSerializer.Serialize(new { listId = list.Id.ToString("N"), sha256 = Sha(Encoding.UTF8.GetBytes(collage)) }));

    // ── a composition that read a collage (COLLAGE-R3-3) ─────────────────

    [Fact]
    public void ARegenerationThatReadTheCollageIsWithheldHoweverLongAfterItFinishes()
    {
        var now = DateTime.UtcNow;
        var source = Item(new BoxSet(), "collage source", now.AddDays(-1));
        Marker(source, "collage source");
        var tile = Item(new CollectionFolder { CollectionType = CollectionType.boxsets }, "old tile", now.AddDays(-2));
        byte[]? read = null;
        // The host reads the collage, then the owner sets an image, and the composition is saved minutes later.
        var host = LegacyCollageComposing.Processor(options =>
        {
            read = File.ReadAllBytes(options.InputPaths[0]);
            Replace(source, "new owner image", now.AddMinutes(1));
        });
        var (processor, withhold, provider) = LegacyCollageComposing.Registered(_plugins, _temp, _library.Object, host.Object);
        using (provider)
        {
            Assert.True(withhold.Withholds(tile, ImageType.Primary));
            LegacyCollageComposing.Compose(processor, tile, ImageType.Primary, new[] { source }, now.AddMinutes(3), _temp);

            Assert.Equal("collage source", Encoding.UTF8.GetString(read!));
            Assert.Equal(LegacyCollageVerdict.Superseded, withhold.Classify(source));
            Assert.True(withhold.Withholds(tile, ImageType.Primary), "a tile composed from the collage was released");
        }

        // After a restart, and with the tile's dates moved again, it is still what it was composed from.
        File.SetLastWriteTimeUtc(tile.ImageInfos[0].Path, now.AddMinutes(30));
        tile.ImageInfos[0].DateModified = now.AddMinutes(30);
        var (_, restarted, again) = LegacyCollageComposing.Registered(_plugins, _temp, _library.Object, host.Object);
        using (again)
            Assert.True(restarted.Withholds(tile, ImageType.Primary));
    }

    [Fact]
    public void ATilesDatesReleaseNothingAndOnlyACompositionFromCleanSourcesDoes()
    {
        var now = DateTime.UtcNow;
        // The owner replaced the collage before JE ever looked: what the old tile holds is unknown.
        var list = Item(new Playlist(), "owner image", now.AddDays(-1));
        Marker(list, "the collage");
        var tile = Item(new CollectionFolder { CollectionType = CollectionType.playlists }, "old tile", now.AddDays(-1));
        var (processor, withhold, provider) = LegacyCollageComposing.Registered(_plugins, _temp, _library.Object, LegacyCollageComposing.Processor().Object);
        using (provider)
        {
            Assert.Equal(LegacyCollageVerdict.Superseded, withhold.Classify(list));
            Assert.True(withhold.Withholds(tile, ImageType.Primary));

            // The tile's file and the host's record of it say it is new: nothing says what it holds.
            Replace(tile, "rewritten tile", DateTime.UtcNow.AddMinutes(10));
            Assert.True(withhold.Withholds(tile, ImageType.Primary), "a tile was released by its dates");

            LegacyCollageComposing.Compose(processor, tile, ImageType.Primary, new[] { list }, DateTime.UtcNow.AddMinutes(11), _temp);
            Assert.False(withhold.Withholds(tile, ImageType.Primary));
        }
    }

    // ── a retry is not new evidence (COLLAGE-R3-5) ───────────────────────

    [Fact]
    public void RetryingARecordThatCantBeOpenedNeverHidesARegeneratedCleanTileAgain()
    {
        Directory.CreateDirectory(RecordPath); // there, but can't be opened as a file
        var now = DateTime.UtcNow;
        var plain = Item(new Playlist(), "a playlist's own image", now.AddDays(-1));
        var tile = Item(new CollectionFolder { CollectionType = CollectionType.playlists }, "old tile", now.AddDays(-1));
        var (processor, withhold, provider) = LegacyCollageComposing.Registered(_plugins, _temp, _library.Object, LegacyCollageComposing.Processor().Object);
        using (provider)
        {
            Assert.True(withhold.Withholds(tile, ImageType.Primary));
            LegacyCollageComposing.Compose(processor, tile, ImageType.Primary, new[] { plain }, DateTime.UtcNow.AddSeconds(61), _temp);
            var releasedBeforeRetry = !withhold.Withholds(tile, ImageType.Primary);
            Thread.Sleep(TimeSpan.FromSeconds(5.2)); // the record is read again every five seconds
            var releasedAfterRetry = !withhold.Withholds(tile, ImageType.Primary);
            Assert.True(releasedBeforeRetry, "the regenerated clean tile wasn't released");
            Assert.True(releasedAfterRetry, "retrying the same unopenable record hid the regenerated clean tile again");
        }

        Assert.True(Directory.Exists(RecordPath));
    }

    [Fact]
    public void ARecordThatCantBeOpenedGivesTheSameAnswerBeforeAndAfterItIsRetried()
    {
        if (OperatingSystem.IsWindows()) return;
        File.CreateSymbolicLink(RecordPath, Path.GetFileName(RecordPath)); // a link to itself: there, never opens
        var now = DateTime.UtcNow;
        var tile = Item(new CollectionFolder { CollectionType = CollectionType.playlists }, "clean tile", now.AddDays(-1));
        var (_, withhold, provider) = LegacyCollageComposing.Registered(_plugins, _temp, _library.Object, LegacyCollageComposing.Processor().Object);
        using (provider)
        {
            Assert.True(withhold.Withholds(tile, ImageType.Primary));
            // The tile is rewritten (not by a composition JE saw): its dates prove nothing, before or after a retry.
            Replace(tile, "rewritten tile", DateTime.UtcNow.AddSeconds(61));
            Assert.True(withhold.Withholds(tile, ImageType.Primary), "released before the retry");
            Thread.Sleep(TimeSpan.FromSeconds(5.2));
            Assert.True(withhold.Withholds(tile, ImageType.Primary), "released after the retry");
        }

        Assert.Equal(Path.GetFileName(RecordPath), File.ResolveLinkTarget(RecordPath, returnFinalTarget: false)?.Name);
    }
}
