using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Drawing;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace JE.Tests;

/// <summary>An image processor registered by its type, as the host registers its own: composes from the bytes it reads.</summary>
public sealed class LegacyHostImageProcessor : IImageProcessor, IDisposable
{
    public static int Disposed;

    public IReadOnlyCollection<string> SupportedInputFormats => new[] { "jpg" };

    public bool SupportsImageCollageCreation => true;

    public ImageDimensions GetImageDimensions(string path) => new(1, 2);

    public ImageDimensions GetImageDimensions(BaseItem item, ItemImageInfo info) => new(3, 4);

    public string GetImageBlurHash(string path) => "blur";

    public string GetImageBlurHash(string path, ImageDimensions imageDimensions) => "blur";

    public string? GetImageCacheTag(string baseItemPath, DateTime imageDateModified) => "path-tag";

    public string? GetImageCacheTag(BaseItemDto item, ChapterInfo image) => null;

    public string GetImageCacheTag(BaseItem item, ItemImageInfo image) => "host-tag:" + image.Path;

    public string GetImageCacheTag(BaseItemDto item, ItemImageInfo image) => "dto-tag";

    public string? GetImageCacheTag(BaseItem item, ChapterInfo chapter) => null;

    public string? GetImageCacheTag(User user) => null;

    public Task<(string Path, string? MimeType, DateTime DateModified)> ProcessImage(ImageProcessingOptions options) => throw new InvalidOperationException("the host's own failure");

    public IReadOnlyCollection<ImageFormat> GetSupportedImageOutputFormats() => new[] { ImageFormat.Png };

    public void CreateImageCollage(ImageCollageOptions options, string? libraryName)
        => File.WriteAllBytes(options.OutputPath, LegacyCollageComposing.Composed(options.InputPaths.Select(File.ReadAllBytes)));

    public void Dispose() => Interlocked.Increment(ref Disposed);
}

// What JE learns from the host's compositions: the host reads the copies JE judged, a source read where it is counts only
// when it is proven unchanged, compositions of anything but list images (or while nothing is withheld) are the host's
// alone, and the record keeps the strongest evidence for each content, makes room only with what can't release a tile,
// and gets every complete composition back from a damaged copy.
public class ListsLegacyCollageSourcesTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "je-legacy-sources-" + Guid.NewGuid().ToString("N"));
    private readonly string _plugins;
    private readonly string _temp;
    private readonly IReadOnlyList<string> _dirs;
    private readonly Dictionary<Guid, BaseItem> _items = new();
    private readonly Mock<ILibraryManager> _library = new();

    public ListsLegacyCollageSourcesTests()
    {
        _plugins = Path.Combine(_root, "plugins");
        _temp = Path.Combine(_root, "temp");
        _dirs = LegacyCollageComposing.MarkerDirectories(_plugins);
        foreach (var dir in _dirs) Directory.CreateDirectory(dir);
        Directory.CreateDirectory(_temp);
        _library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => _items.GetValueOrDefault(id));
        LegacyCollageComposing.Lists(_library, _items);
    }

    public void Dispose() => Directory.Delete(_root, recursive: true);

    private string RecordPath => Path.Combine(Path.GetDirectoryName(_dirs[0])!, LegacyCollageWithhold.TileStateFileName);

    private static string Sha(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static string Sha(string text) => Sha(Encoding.UTF8.GetBytes(text));

    private T Item<T>(T item, string image) where T : BaseItem
    {
        item.Id = Guid.NewGuid();
        item.Name = typeof(T).Name;
        var path = Path.Combine(_root, "metadata", item.Id.ToString("N"), "primary.jpg");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, image);
        item.ImageInfos = new[] { new ItemImageInfo { Path = path, Type = ImageType.Primary, DateModified = File.GetLastWriteTimeUtc(path) } };
        _items[item.Id] = item;
        return item;
    }

    private void Marker(BaseItem list, string collage)
        => File.WriteAllText(Path.Combine(_dirs[0], list.Id.ToString("N") + ".json"), JsonSerializer.Serialize(new { listId = list.Id.ToString("N"), sha256 = Sha(collage) }));

    private LegacyCollageWithhold New() => new(_dirs, _library.Object);

    private IImageProcessor Wrapped(LegacyCollageWithhold withhold, Mock<IImageProcessor> host) => LegacyCollageCompositions.Wrap(host.Object, () => withhold, () => _temp);

    private string TileSha(BaseItem tile) => Sha(File.ReadAllBytes(tile.ImageInfos[0].Path));

    // ── the host's processor, wrapped ────────────────────────────────────

    [Theory]
    [InlineData("instance")]
    [InlineData("type")]
    [InlineData("factory")]
    public void TheHostsImageProcessorIsWrappedHoweverItWasRegisteredAndStillTheHostsToDispose(string how)
    {
        var services = new ServiceCollection();
        var paths = new Mock<IApplicationPaths>();
        paths.SetupGet(p => p.PluginsPath).Returns(_plugins);
        paths.SetupGet(p => p.TempDirectory).Returns(_temp);
        paths.SetupGet(p => p.LogDirectoryPath).Returns(_temp);
        services.AddSingleton(paths.Object);
        services.AddSingleton(_library.Object);
        services.AddSingleton(new Logger(paths.Object, NullLoggerFactory.Instance));
        _ = how switch
        {
            "instance" => services.AddSingleton<IImageProcessor>(new LegacyHostImageProcessor()),
            "type" => services.AddSingleton<IImageProcessor, LegacyHostImageProcessor>(),
            _ => services.AddSingleton<IImageProcessor>(_ => new LegacyHostImageProcessor()),
        };
        LegacyCollageWithholdFilter.Register(services);
        var disposed = LegacyHostImageProcessor.Disposed;
        var item = Item(new Playlist(), "image");
        using (var provider = services.BuildServiceProvider())
        {
            var processor = provider.GetRequiredService<IImageProcessor>();
            Assert.IsAssignableFrom<LegacyCollageCompositions>(processor);
            Assert.Equal("host-tag:" + item.ImageInfos[0].Path, processor.GetImageCacheTag(item, item.ImageInfos[0]));
            Assert.Equal(new ImageDimensions(3, 4), processor.GetImageDimensions(item, item.ImageInfos[0]));
            Assert.True(processor.SupportsImageCollageCreation);
            // A failure of the host's processor reaches its caller as the host threw it.
            Assert.Equal("the host's own failure", Assert.Throws<InvalidOperationException>(() => processor.ProcessImage(new ImageProcessingOptions()).GetAwaiter().GetResult()).Message);
        }

        if (how != "instance") Assert.True(LegacyHostImageProcessor.Disposed > disposed, "the host's processor wasn't disposed by its container");
        Assert.False(LegacyCollageCompositions.Decorate(new ServiceCollection()));
    }

    // ── what the host reads ──────────────────────────────────────────────

    [Fact]
    public void TheHostReadsTheCopiesJeJudgedWhateverHappensToTheFilesMeanwhile()
    {
        var list = Item(new Playlist(), "owner image");
        Marker(list, "old collage");
        var tile = Item(new CollectionFolder { CollectionType = CollectionType.playlists }, "old tile");
        var withhold = New();
        var given = new List<string>();
        // While the host composes, the list's file is put back to the collage (and would be read as such).
        var host = LegacyCollageComposing.Processor(options =>
        {
            given.AddRange(options.InputPaths);
            File.WriteAllText(list.ImageInfos[0].Path, "old collage");
        });
        LegacyCollageComposing.Compose(Wrapped(withhold, host), tile, ImageType.Primary, new[] { list }, DateTime.UtcNow, _temp);

        var copy = Assert.Single(given);
        Assert.NotEqual(list.ImageInfos[0].Path, copy);
        Assert.StartsWith(Path.Combine(_temp, "jellyfin-enhanced-collage-sources"), copy, StringComparison.Ordinal);
        Assert.False(File.Exists(copy));
        Assert.Equal(LegacyCollageComposing.Composed(new[] { Encoding.UTF8.GetBytes("owner image") }), File.ReadAllBytes(tile.ImageInfos[0].Path));
        Assert.Equal(LegacyCollageSource.Clean, withhold.Tiles.CompositionOf(TileSha(tile)));
        // The list itself is its collage now (every playlist tile waits while it is); once the owner's image is back, the
        // tile composed from it is served.
        Assert.True(withhold.Withholds(tile, ImageType.Primary));
        File.WriteAllText(list.ImageInfos[0].Path, "owner image");
        Assert.False(withhold.Withholds(tile, ImageType.Primary));
    }

    [Fact]
    public void ASourceReadWhereItIsCountsOnlyWhenItIsTheSameAfterTheHostReadIt()
    {
        var lists = Enumerable.Range(0, LegacyCollageCompositions.CopiedSources + 1).Select(i => Item(new Playlist(), "playlist " + i)).ToList();
        Marker(lists[0], "a collage nobody has");
        var tile = Item(new CollectionFolder { CollectionType = CollectionType.playlists }, "old tile");
        var withhold = New();
        var copied = 0;
        var host = LegacyCollageComposing.Processor(options =>
        {
            copied = options.InputPaths.Count(p => p.StartsWith(_temp, StringComparison.Ordinal));
            // The last source (read where it is) changes while the host composes.
            File.WriteAllText(lists[^1].ImageInfos[0].Path, "changed underneath");
        });
        LegacyCollageComposing.Compose(Wrapped(withhold, host), tile, ImageType.Primary, lists, DateTime.UtcNow, _temp);
        Assert.Equal(LegacyCollageCompositions.CopiedSources, copied);
        Assert.Equal(LegacyCollageSource.Unresolved, withhold.Tiles.CompositionOf(TileSha(tile)));
        Assert.True(withhold.Withholds(tile, ImageType.Primary));

        // The same sources, none changing: clean.
        LegacyCollageComposing.Compose(Wrapped(withhold, LegacyCollageComposing.Processor()), tile, ImageType.Primary, lists, DateTime.UtcNow, _temp);
        Assert.Equal(LegacyCollageSource.Clean, withhold.Tiles.CompositionOf(TileSha(tile)));
        Assert.False(withhold.Withholds(tile, ImageType.Primary));
    }

    [Fact]
    public void ACompositionOfAnythingButListImagesIsTheHostsAlone()
    {
        var list = Item(new Playlist(), "the collage");
        Marker(list, "the collage");
        var movies = Enumerable.Range(0, 3).Select(i => Item(new MediaBrowser.Controller.Entities.Movies.Movie(), "poster " + i)).ToList();
        var genre = Item(new Genre(), "old genre image");
        var withhold = New();
        var given = new List<string>();
        LegacyCollageComposing.Compose(Wrapped(withhold, LegacyCollageComposing.Processor(o => given.AddRange(o.InputPaths))), genre, ImageType.Primary, movies, DateTime.UtcNow, _temp);
        Assert.Equal(movies.Select(m => m.ImageInfos[0].Path), given);
        Assert.Null(withhold.Tiles.CompositionOf(TileSha(genre)));
    }

    [Fact]
    public void WhileThereIsNothingToWithholdTheHostComposesFromItsOwnFilesAndNothingIsRecorded()
    {
        var list = Item(new Playlist(), "a playlist");
        var tile = Item(new CollectionFolder { CollectionType = CollectionType.playlists }, "old tile");
        var withhold = New();
        var given = new List<string>();
        LegacyCollageComposing.Compose(Wrapped(withhold, LegacyCollageComposing.Processor(o => given.AddRange(o.InputPaths))), tile, ImageType.Primary, new[] { list }, DateTime.UtcNow, _temp);
        Assert.Equal(list.ImageInfos[0].Path, Assert.Single(given));
        Assert.False(File.Exists(RecordPath));
        Assert.False(withhold.Withholds(tile, ImageType.Primary));
    }

    [Fact]
    public void AListWhoseMarkerCantBeReadLeavesWhatItWasComposedIntoUnresolved()
    {
        var list = Item(new Playlist(), "owner image");
        File.WriteAllText(Path.Combine(_dirs[0], list.Id.ToString("N") + ".json"), "{ not a marker");
        var other = Item(new Playlist(), "another playlist");
        var tile = Item(new CollectionFolder { CollectionType = CollectionType.playlists }, "old tile");
        var withhold = New();
        LegacyCollageComposing.Compose(Wrapped(withhold, LegacyCollageComposing.Processor()), tile, ImageType.Primary, new[] { other, list }, DateTime.UtcNow, _temp);
        var unresolved = TileSha(tile);
        Assert.Equal(LegacyCollageSource.Unresolved, withhold.Tiles.CompositionOf(unresolved));
        Assert.True(withhold.Withholds(tile, ImageType.Primary));

        // The marker can be read again (it names another image): the same sources, the same bytes, proven clean now.
        Marker(list, "an older collage");
        LegacyCollageComposing.Compose(Wrapped(withhold, LegacyCollageComposing.Processor()), tile, ImageType.Primary, new[] { other, list }, DateTime.UtcNow, _temp);
        Assert.Equal(unresolved, TileSha(tile));
        Assert.Equal(LegacyCollageSource.Clean, withhold.Tiles.CompositionOf(unresolved));
        Assert.False(withhold.Withholds(tile, ImageType.Primary));
    }

    // ── the record of compositions ───────────────────────────────────────

    [Fact]
    public void TheStrongestEvidenceForTheSameContentWins()
    {
        var tiles = New().Tiles;
        var x = Sha("x");
        Assert.Equal(LegacyCollageSource.Unresolved, tiles.Composed(x, new[] { ((string?)null, LegacyCollageSource.Unresolved) }));
        Assert.Equal(LegacyCollageSource.Clean, tiles.Composed(x, new[] { ((string?)Sha("a"), LegacyCollageSource.Clean) }));
        Assert.Equal(LegacyCollageSource.Clean, tiles.Composed(x, new[] { ((string?)null, LegacyCollageSource.Unresolved) }));
        Assert.Equal(LegacyCollageSource.Contaminated, tiles.Composed(x, new[] { ((string?)Sha("b"), LegacyCollageSource.Contaminated) }));
        Assert.Equal(LegacyCollageSource.Contaminated, tiles.Composed(x, new[] { ((string?)Sha("a"), LegacyCollageSource.Clean) }));
        Assert.True(tiles.Contaminated(x));
        Assert.Equal(LegacyCollageSource.Contaminated, New().Tiles.CompositionOf(x));
    }

    [Fact]
    public void OnlyCompositionsThatCanReleaseNothingMakeRoomAndContaminationIsNeverDropped()
    {
        var tiles = New().Tiles;
        var contaminated = Sha("contaminated");
        tiles.Composed(contaminated, new[] { ((string?)Sha("collage"), LegacyCollageSource.Contaminated) });
        var clean = Enumerable.Range(0, LegacyCollageTiles.MaxCompositions).Select(i => Sha("clean " + i)).ToList();
        foreach (var sha in clean) tiles.Composed(sha, new[] { ((string?)Sha("source"), LegacyCollageSource.Clean) });
        // The oldest clean composition made room; the contaminated one, older still, didn't.
        Assert.Equal(LegacyCollageSource.Contaminated, tiles.CompositionOf(contaminated));
        Assert.Null(tiles.CompositionOf(clean[0]));
        Assert.Equal(LegacyCollageSource.Clean, tiles.CompositionOf(clean[^1]));
        Assert.False(tiles.Saturated);

        // Full of contamination: nothing is dropped, every tile is withheld from then on.
        foreach (var i in Enumerable.Range(0, LegacyCollageTiles.MaxCompositions)) tiles.Composed(Sha("more " + i), new[] { ((string?)Sha("collage"), LegacyCollageSource.Contaminated) });
        Assert.True(tiles.Saturated);
        Assert.Equal(LegacyCollageSource.Contaminated, tiles.CompositionOf(contaminated));
        var reread = LegacyCollageTiles.Parse(File.ReadAllBytes(RecordPath))!;
        Assert.True(reread.Saturated);
        Assert.Equal(LegacyCollageTiles.MaxCompositions, reread.Compositions.Count);
    }

    [Fact]
    public void ACompositionOfManySourcesKeepsTheirVerdictAndTheFirstOnesIdentities()
    {
        var tiles = New().Tiles;
        var sources = Enumerable.Range(0, LegacyCollageTiles.MaxInputs + 6).Select(i => ((string?)Sha("s" + i), i == LegacyCollageTiles.MaxInputs + 3 ? LegacyCollageSource.Unresolved : LegacyCollageSource.Clean)).ToList();
        Assert.Equal(LegacyCollageSource.Unresolved, tiles.Composed(Sha("many"), sources));
        var composition = LegacyCollageTiles.Parse(File.ReadAllBytes(RecordPath))!.Compositions[Sha("many")];
        Assert.Equal(LegacyCollageSource.Unresolved, composition.Verdict);
        Assert.Equal(LegacyCollageTiles.MaxInputs, composition.Inputs.Count);
        Assert.Equal(6, composition.Omitted);
        Assert.Equal(sources.Take(LegacyCollageTiles.MaxInputs), composition.Inputs);
    }

    [Fact]
    public void EveryCompleteCompositionIsRecoveredWhereverItStandsInADamagedRecord()
    {
        var tiles = New().Tiles;
        var shas = new[] { Sha("first"), Sha("second"), Sha("third") };
        foreach (var sha in shas) tiles.Composed(sha, new[] { ((string?)Sha("source of " + sha), LegacyCollageSource.Clean) });
        tiles.Record(Sha("suspect"));
        var text = File.ReadAllText(RecordPath);
        // Damage inside the second composition (its source's verdict), and before everything.
        var second = text.IndexOf("\"" + shas[1] + "\"", StringComparison.Ordinal);
        var verdict = text.IndexOf("\"clean\"", text.IndexOf("inputs", second, StringComparison.Ordinal), StringComparison.Ordinal);
        File.WriteAllText(RecordPath, "\u0001" + text[..verdict] + "\"cle" + text[(verdict + 6)..]);

        var restarted = New();
        Assert.Equal(LegacyCollageSource.Clean, restarted.Tiles.CompositionOf(shas[0]));
        Assert.Null(restarted.Tiles.CompositionOf(shas[1]));
        Assert.Equal(LegacyCollageSource.Clean, restarted.Tiles.CompositionOf(shas[2]));
        Assert.True(restarted.Tiles.Contaminated(Sha("suspect")));
        // History is unknown for both kinds after damage.
        Assert.True(restarted.Tiles.HasHistoryFor(BaseItemKind.Playlist));
        Assert.True(restarted.Tiles.HasHistoryFor(BaseItemKind.BoxSet));
    }

    [Fact]
    public void WhatJeSawWhileTheRecordCouldntBeOpenedIsWrittenIntoItOnceItCanBe()
    {
        Directory.CreateDirectory(RecordPath); // there, but can't be opened as a file
        var tiles = New().Tiles;
        var clean = Sha("composed while blind");
        tiles.Composed(clean, new[] { ((string?)Sha("source"), LegacyCollageSource.Clean) });
        Assert.True(Directory.Exists(RecordPath));

        // The record can be opened again (an admin fixed it): on the next read JE writes what it saw into it.
        Directory.Delete(RecordPath);
        File.WriteAllText(RecordPath, "{\"version\":3,\"history\":[\"Playlist\"],\"tiles\":[],\"compositions\":{},\"saturated\":false}");
        Thread.Sleep(TimeSpan.FromSeconds(5.2));
        Assert.Equal(LegacyCollageSource.Clean, tiles.CompositionOf(clean));
        var written = LegacyCollageTiles.Parse(File.ReadAllBytes(RecordPath))!;
        Assert.Equal(LegacyCollageSource.Clean, written.Compositions[clean].Verdict);
        Assert.Contains("Playlist", written.History);
        // A restart reads it back.
        Assert.Equal(LegacyCollageSource.Clean, New().Tiles.CompositionOf(clean));
    }

    // ── character sets ───────────────────────────────────────────────────

    [Theory]
    [InlineData(null, true, null)]
    [InlineData("application/json", true, null)]
    [InlineData("application/json; charset=utf-8", true, null)]
    [InlineData("application/json; charset=\"UTF-8\"", true, null)]
    [InlineData("text/plain; charset=us-ascii", true, null)]
    [InlineData("application/json; charset=utf-16", true, 1200)]
    [InlineData("application/json; charset=utf-16BE", true, 1201)]
    [InlineData("application/json; charset=utf-32", true, 12000)]
    [InlineData("text/plain; charset=iso-8859-1", true, 28591)]
    [InlineData("application/json; charset=x-no-such-set", false, null)]
    public void AnAnswerIsReadInTheCharacterSetItSaysItIsIn(string? contentType, bool readable, int? codePage)
    {
        Assert.Equal(readable, LegacyCollageBody.CharsetOf(contentType, out var encoding));
        Assert.Equal(codePage, encoding?.CodePage);
    }
}
