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

// JE's record of library tiles is evidence: from a damaged copy every complete proof it still holds is recovered, a tile
// it proves contaminated stays withheld whatever its dates say after a restart, and a record that holds many marked lists
// of both kinds reads back as JE wrote it.
public class ListsLegacyCollageRecordRecoveryTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "je-legacy-record-" + Guid.NewGuid().ToString("N"));
    private readonly IReadOnlyList<string> _dirs;
    private readonly Dictionary<Guid, BaseItem> _items = new();
    private readonly Mock<ILibraryManager> _library = new();
    private readonly List<string> _warnings = new();
    private DateTime _now = new(2026, 10, 21, 1, 0, 0, DateTimeKind.Utc);

    public ListsLegacyCollageRecordRecoveryTests()
    {
        _dirs = LegacyCollageWithhold.MarkerDirectories(Path.Combine(_root, "configurations", "Jellyfin.Plugin.JellyfinEnhanced"));
        foreach (var dir in _dirs) Directory.CreateDirectory(dir);
        _library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => _items.GetValueOrDefault(id));
    }

    public void Dispose() => Directory.Delete(_root, recursive: true);

    private LegacyCollageWithhold New() => new(_dirs, _library.Object, () => _now, _warnings.Add);

    private string RecordPath => Path.Combine(Path.GetDirectoryName(_dirs[0])!, LegacyCollageWithhold.TileStateFileName);

    private static string Sha(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private T Item<T>(T item, string? image, DateTime written) where T : BaseItem
    {
        item.Id = Guid.NewGuid();
        item.Name = "item";
        if (image != null)
        {
            var path = Path.Combine(_root, "metadata", item.Id.ToString("N") + ".jpg");
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, image);
            File.SetLastWriteTimeUtc(path, written);
            item.ImageInfos = new[] { new ItemImageInfo { Type = ImageType.Primary, Path = path, DateModified = written } };
        }

        _items[item.Id] = item;
        return item;
    }

    private void Marker(BaseItem list, string collage)
        => File.WriteAllText(Path.Combine(_dirs[0], list.Id.ToString("N") + ".json"), JsonSerializer.Serialize(new { listId = list.Id.ToString("N"), sha256 = Sha(Encoding.UTF8.GetBytes(collage)) }));

    // A playlist that is its collage, and library tiles the host wrote while it was: proven contaminated, and recorded.
    private (Playlist List, CollectionFolder[] Tiles, string[] Shas) Contaminated(int tiles)
    {
        var list = Item(new Playlist(), "legacy image", _now.AddDays(-1));
        Marker(list, "legacy image");
        var made = Enumerable.Range(0, tiles).Select(i => Item(new CollectionFolder { CollectionType = CollectionType.playlists }, "tile built from the collage " + i, _now)).ToArray();
        var withhold = New();
        foreach (var tile in made) Assert.True(withhold.Withholds(tile, ImageType.Primary));
        var shas = made.Select(t => Sha(File.ReadAllBytes(t.ImageInfos[0].Path))).ToArray();
        Assert.All(shas, sha => Assert.True(withhold.Tiles.Contaminated(sha)));
        return (list, made, shas);
    }

    // ── a damaged record (COLLAGE-R3-2) ──────────────────────────────────

    [Fact]
    public void ARecordCutShortByItsLastByteKeepsItsProofAndTheTilesDatesReleaseNothingAfterARestart()
    {
        var (list, tiles, shas) = Contaminated(1);
        // The owner sets an image: the list is served; the tile still holds the collage's pixels.
        File.WriteAllText(list.ImageInfos[0].Path, "new owner poster");
        list.ImageInfos[0].DateModified = _now;
        Assert.True(New().Withholds(tiles[0], ImageType.Primary));

        var good = File.ReadAllBytes(RecordPath);
        File.WriteAllBytes(RecordPath, good[..^1]);
        var restarted = New();
        Assert.True(restarted.Withholds(tiles[0], ImageType.Primary));
        Assert.True(restarted.Tiles.Contaminated(shas[0]), "the proof the damaged record still holds was dropped");

        // A metadata refresh moves the tile's dates; the collage's pixels are still in it.
        _now = _now.AddMinutes(3);
        File.SetLastWriteTimeUtc(tiles[0].ImageInfos[0].Path, _now);
        tiles[0].ImageInfos[0].DateModified = _now;
        Assert.True(restarted.Withholds(tiles[0], ImageType.Primary), "the proven tile was released by its dates");
        Assert.True(New().Withholds(tiles[0], ImageType.Primary));
    }

    public static IEnumerable<object[]> Damage() => new[]
    {
        new object[] { "as written" },
        new object[] { "last byte cut" },
        new object[] { "cut after the third proof" },
        new object[] { "no version" },
        new object[] { "a byte flipped before the proofs" },
    };

    [Theory]
    [MemberData(nameof(Damage))]
    public void EveryCompleteProofADamagedRecordStillHoldsIsKept(string damage)
    {
        var (_, tiles, shas) = Contaminated(5);
        var good = File.ReadAllBytes(RecordPath);
        var text = Encoding.UTF8.GetString(good);
        var third = text.IndexOf(shas.OrderBy(s => s, StringComparer.Ordinal).ElementAt(2), StringComparison.Ordinal) + 65;
        var bytes = damage switch
        {
            "last byte cut" => good[..^1],
            "cut after the third proof" => good[..third],
            "no version" => Encoding.UTF8.GetBytes(System.Text.RegularExpressions.Regex.Replace(text, "\"version\":\\d+,", string.Empty)),
            "a byte flipped before the proofs" => Encoding.UTF8.GetBytes(text.Insert(1, "\u0001")),
            _ => good,
        };
        File.WriteAllBytes(RecordPath, bytes);
        var restarted = New();
        var expected = damage == "cut after the third proof" ? shas.OrderBy(s => s, StringComparer.Ordinal).Take(3) : shas;
        foreach (var sha in expected)
        {
            Assert.True(restarted.Tiles.Contaminated(sha), damage + ": a complete proof was dropped");
        }

        Assert.All(tiles, tile => Assert.True(restarted.Withholds(tile, ImageType.Primary)));
    }

    // ── many marked lists of both kinds (capacity) ───────────────────────

    [Fact]
    public void ARecordWithManyMarkedListsOfBothKindsReadsBackAsItWasWritten()
    {
        foreach (var i in Enumerable.Range(0, 2050))
        {
            Marker(Item(new Playlist(), null, _now), "playlist collage " + i);
            Marker(Item(new BoxSet(), null, _now), "collection collage " + i);
        }

        var withhold = New();
        Assert.False(withhold.AnyWithheld(BaseItemKind.Playlist));
        Assert.False(withhold.AnyWithheld(BaseItemKind.BoxSet));
        Assert.True(File.Exists(RecordPath));
        Assert.DoesNotContain(_warnings, w => w.Contains("couldn't be read", StringComparison.Ordinal) || w.Contains("withheld from now on", StringComparison.Ordinal));

        var restarted = New();
        Assert.False(restarted.AnyWithheld(BaseItemKind.Playlist));
        Assert.True(restarted.Tiles.HasHistory);
        Assert.DoesNotContain(_warnings, w => w.Contains("couldn't be read", StringComparison.Ordinal));
    }
}
