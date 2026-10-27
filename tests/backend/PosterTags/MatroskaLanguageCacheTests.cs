using System.Text;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using Moq;

namespace JE.Tests;

/// <summary>
/// Issue #983: Matroska track languages (PR #790's BCP-47 reader) are read once
/// per file and then served from MatroskaLanguageCache until the file's size or
/// modification time changes, instead of reopening every file on every rebuild,
/// reconcile and tag-data request.
/// </summary>
[Collection("Plugin singleton")]
public class MatroskaLanguageCacheTests
{
    /// <summary>Minimal EBML writer: just enough Matroska for the reader's header walk.</summary>
    private static class Ebml
    {
        private static byte[] Id(ulong id)
        {
            var bytes = new List<byte>();
            for (var v = id; v != 0; v >>= 8) bytes.Insert(0, (byte)v);
            return [.. bytes];
        }

        // 8-byte size vint (0x01 marker + 7 bytes) keeps the builder simple.
        private static byte[] Size(long size)
        {
            var bytes = new byte[8];
            bytes[0] = 0x01;
            for (var i = 7; i >= 1; i--, size >>= 8) bytes[i] = (byte)size;
            return bytes;
        }

        public static byte[] Element(ulong id, byte[] data) => [.. Id(id), .. Size(data.Length), .. data];
        public static byte[] UInt(ulong id, long value)
        {
            var bytes = new byte[8];
            System.Buffers.Binary.BinaryPrimitives.WriteInt64BigEndian(bytes, value);
            return Element(id, bytes);
        }
        public static byte[] Master(ulong id, params byte[][] children) => Element(id, [.. children.SelectMany(c => c)]);
        public static byte[] Text(ulong id, string value) => Element(id, Encoding.UTF8.GetBytes(value));

        public static byte[] Track(byte type, string? language = null, string? bcp47 = null)
        {
            var children = new List<byte[]> { Element(0x83, [type]) };
            if (language != null) children.Add(Text(0x22B59C, language));
            if (bcp47 != null) children.Add(Text(0x22B59D, bcp47));
            return Master(0xAE, [.. children]);
        }

        public static byte[] File(params byte[][] tracks) =>
        [
            .. Master(0x1A45DFA3, Text(0x4282, "matroska")),
            .. Master(0x18538067, Master(0x1654AE6B, tracks)),
        ];

        /// <summary>A file whose Segment holds exactly these top-level children, in order.</summary>
        public static byte[] Segment(params byte[][] children) =>
        [
            .. Master(0x1A45DFA3, Text(0x4282, "matroska")),
            .. Master(0x18538067, children),
        ];

        /// <summary>SeekHead with one entry; the position is fixed-width, so the length does not depend on it.</summary>
        public static byte[] SeekHead(ulong targetId, long position) =>
            Master(0x114D9B74, Master(0x4DBB, Element(0x53AB, Id(targetId)), UInt(0x53AC, position)));

        public static byte[] Cluster() => Master(0x1F43B675, Element(0xE7, [0]), Element(0xA3, new byte[64]));

        public static byte[] Tracks(params byte[][] tracks) => Master(0x1654AE6B, tracks);

        /// <summary>Video, then audio "por"/pt-BR, then audio "eng".</summary>
        public static byte[] PortugueseAndEnglish() => File(PortugueseAndEnglishTracks());

        public static byte[][] PortugueseAndEnglishTracks() => [Track(1, "und"), Track(2, "por", "pt-BR"), Track(2, "eng")];

        /// <summary>
        /// The layout mkvpropedit leaves when a language edit no longer fits:
        /// SeekHead, then a Cluster, then Tracks at the end, found only through
        /// the SeekHead.
        /// </summary>
        public static byte[] TracksAfterCluster(Func<long, long>? tracksPosition = null)
        {
            var cluster = Cluster();
            var seekHeadLength = SeekHead(0x1654AE6B, 0).Length;
            var position = seekHeadLength + cluster.Length;
            return Segment(SeekHead(0x1654AE6B, tracksPosition?.Invoke(position) ?? position), cluster, Tracks(PortugueseAndEnglishTracks()));
        }
    }

    private static string WriteMkv(CoreFixture f, string name, byte[] bytes)
    {
        var path = Path.Combine(f.Root, name);
        File.WriteAllBytes(path, bytes);
        return path;
    }

    /// <summary>Same length, same mtime, contents that no longer parse: only a re-read would notice.</summary>
    private static void CorruptInPlace(string path)
    {
        var modified = File.GetLastWriteTimeUtc(path);
        var length = new FileInfo(path).Length;
        File.WriteAllBytes(path, Enumerable.Repeat((byte)0xFF, (int)length).ToArray());
        File.SetLastWriteTimeUtc(path, modified);
    }

    private static MediaSourceInfo Source(string? path, params MediaStream[] streams) => new() { Path = path, MediaStreams = [.. streams] };

    private static MediaStream Audio(string language, bool external = false) => new() { Type = MediaStreamType.Audio, Language = language, IsExternal = external };

    private static MediaStream Video() => new() { Type = MediaStreamType.Video, Height = 1080 };

    [Fact]
    public void ReaderPrefersBcp47AndKeepsTrackPositions()
    {
        using var f = new CoreFixture();
        var path = WriteMkv(f, "a.mkv", Ebml.File(Ebml.Track(1), Ebml.Track(2, "por", "pt-BR"), Ebml.Track(2, "eng"), Ebml.Track(2, "und")));

        Assert.True(MatroskaLanguageReader.TryReadAudioLanguages(path, out var languages));
        Assert.Equal(new string?[] { "pt-BR", "eng", null }, languages);
    }

    [Fact]
    public void ReaderRejectsNonMatroskaContent()
    {
        using var f = new CoreFixture();
        var path = WriteMkv(f, "garbage.mkv", Enumerable.Repeat((byte)0xFF, 64).ToArray());
        var text = WriteMkv(f, "text.mkv", Encoding.UTF8.GetBytes("not a matroska file at all"));

        Assert.False(MatroskaLanguageReader.TryReadAudioLanguages(path, out var languages));
        Assert.Empty(languages);
        Assert.False(MatroskaLanguageReader.TryReadAudioLanguages(text, out _));
    }

    [Fact]
    public void ResolverAlignsFileLanguagesOntoEmbeddedAudio()
    {
        using var f = new CoreFixture();
        using var cache = new MatroskaLanguageCache(f.Paths.Object, f.Logger);
        var path = WriteMkv(f, "a.mkv", Ebml.PortugueseAndEnglish());

        var resolved = MediaStreamLanguageResolver.Resolve(Source(path, Video(), Audio("por"), Audio("eng")), null, cache);
        Assert.Equal(new string?[] { null, "pt-BR", "eng" }, resolved.Select(r => r.Language));

        // One embedded audio stream against the file's two: Jellyfin's values stay.
        var mismatched = MediaStreamLanguageResolver.Resolve(Source(path, Video(), Audio("por")), null, cache);
        Assert.Equal(new string?[] { null, "por" }, mismatched.Select(r => r.Language));

        // Fallback path is used when the source has none.
        var viaItemPath = MediaStreamLanguageResolver.Resolve(Source(null, Audio("por"), Audio("eng")), path, cache);
        Assert.Equal(new string?[] { "pt-BR", "eng" }, viaItemPath.Select(r => r.Language));
        Assert.Equal(1, cache.Reads);
    }

    [Fact]
    public void ResolverDoesNotTouchTheFileWithoutEmbeddedAudio()
    {
        using var f = new CoreFixture();
        using var cache = new MatroskaLanguageCache(f.Paths.Object, f.Logger);
        var path = WriteMkv(f, "a.mkv", Ebml.PortugueseAndEnglish());

        var resolved = MediaStreamLanguageResolver.Resolve(Source(path, Video(), Audio("por", external: true)), null, cache);

        Assert.Equal(new string?[] { null, "por" }, resolved.Select(r => r.Language));
        Assert.Equal(0, cache.Reads);
        Assert.Equal(0, cache.Hits);
    }

    [Fact]
    public void UnchangedFileIsServedFromTheCacheAndAChangedOneIsReadAgain()
    {
        using var f = new CoreFixture();
        using var cache = new MatroskaLanguageCache(f.Paths.Object, f.Logger);
        var path = WriteMkv(f, "a.mkv", Ebml.PortugueseAndEnglish());

        Assert.True(cache.TryGetAudioLanguages(path, out var first));
        Assert.True(cache.TryGetAudioLanguages(path, out var second));
        Assert.Equal(new string?[] { "pt-BR", "eng" }, first);
        Assert.Equal(first, second);
        Assert.Equal((1L, 1L), (cache.Reads, cache.Hits));

        // Same size and mtime: still the cached answer, so the file was not reopened.
        CorruptInPlace(path);
        Assert.True(cache.TryGetAudioLanguages(path, out var afterCorrupt));
        Assert.Equal(new string?[] { "pt-BR", "eng" }, afterCorrupt);
        Assert.Equal(1, cache.Reads);

        // A new mtime is a changed file: read again, and the unparseable result
        // is remembered too rather than reopened next time.
        File.SetLastWriteTimeUtc(path, File.GetLastWriteTimeUtc(path).AddMinutes(1));
        Assert.False(cache.TryGetAudioLanguages(path, out var changed));
        Assert.Empty(changed);
        Assert.Equal(2, cache.Reads);
        Assert.False(cache.TryGetAudioLanguages(path, out _));
        Assert.Equal((2L, 3L), (cache.Reads, cache.Hits));
    }

    [Fact]
    public void UnsupportedAndMissingPathsAreNotStored()
    {
        using var f = new CoreFixture();
        var mp4 = WriteMkv(f, "a.mp4", Ebml.PortugueseAndEnglish());
        var missing = Path.Combine(f.Root, "later.mkv");
        using (var cache = new MatroskaLanguageCache(f.Paths.Object, f.Logger))
        {
            Assert.False(cache.TryGetAudioLanguages(mp4, out _));
            Assert.False(cache.TryGetAudioLanguages(null, out _));
            Assert.False(cache.TryGetAudioLanguages(missing, out _));
            Assert.Equal((0L, 0L), (cache.Reads, cache.Hits));

            // The missing file appears later and is read then.
            File.WriteAllBytes(missing, Ebml.PortugueseAndEnglish());
            Assert.True(cache.TryGetAudioLanguages(missing, out var appeared));
            Assert.Equal(new string?[] { "pt-BR", "eng" }, appeared);
        }

        var saved = File.ReadAllText(Path.Combine(f.ConfigRoot, "matroska-languages.json"));
        Assert.DoesNotContain("a.mp4", saved);
        Assert.Contains("later.mkv", saved);
    }

    [Fact]
    public void CachedLanguagesSurviveARestart()
    {
        using var f = new CoreFixture();
        var path = WriteMkv(f, "a.mkv", Ebml.PortugueseAndEnglish());
        using (var cache = new MatroskaLanguageCache(f.Paths.Object, f.Logger))
        {
            Assert.True(cache.TryGetAudioLanguages(path, out _));
        }

        CorruptInPlace(path);
        using var restarted = new MatroskaLanguageCache(f.Paths.Object, f.Logger);
        Assert.True(restarted.TryGetAudioLanguages(path, out var languages));
        Assert.Equal(new string?[] { "pt-BR", "eng" }, languages);
        Assert.Equal((0L, 1L), (restarted.Reads, restarted.Hits));
    }

    [Theory]
    [InlineData("{ not json")]
    [InlineData("{\"SchemaVersion\":99,\"Files\":{}}")]
    public void UnreadableCacheFileStartsEmpty(string contents)
    {
        using var f = new CoreFixture();
        Directory.CreateDirectory(f.ConfigRoot);
        File.WriteAllText(Path.Combine(f.ConfigRoot, "matroska-languages.json"), contents);
        var path = WriteMkv(f, "a.mkv", Ebml.PortugueseAndEnglish());

        using var cache = new MatroskaLanguageCache(f.Paths.Object, f.Logger);
        Assert.True(cache.TryGetAudioLanguages(path, out var languages));
        Assert.Equal(new string?[] { "pt-BR", "eng" }, languages);
        Assert.Equal(1, cache.Reads);
    }

    [Fact]
    public void SweepKeepsUnvisitedFilesThatStillExist()
    {
        using var f = new CoreFixture();
        using var cache = new MatroskaLanguageCache(f.Paths.Object, f.Logger);
        var excluded = WriteMkv(f, "excluded-library.mkv", Ebml.PortugueseAndEnglish());
        var deleted = WriteMkv(f, "deleted.mkv", Ebml.PortugueseAndEnglish());
        Assert.True(cache.TryGetAudioLanguages(excluded, out _));
        Assert.True(cache.TryGetAudioLanguages(deleted, out _));

        // Neither is looked up during the sweep (an excluded library, say).
        cache.BeginSweep();
        File.Delete(deleted);
        cache.EndSweep();

        // The surviving file is still answered without a read even though its
        // contents changed in place; the deleted one reappearing is read again.
        CorruptInPlace(excluded);
        Assert.True(cache.TryGetAudioLanguages(excluded, out var kept));
        Assert.Equal(new string?[] { "pt-BR", "eng" }, kept);
        Assert.Equal(2, cache.Reads);
        File.WriteAllBytes(deleted, Ebml.PortugueseAndEnglish());
        Assert.True(cache.TryGetAudioLanguages(deleted, out _));
        Assert.Equal(3, cache.Reads);
    }

    [Fact]
    public void SizeChangeWithTheSameModificationTimeIsReadAgain()
    {
        using var f = new CoreFixture();
        using var cache = new MatroskaLanguageCache(f.Paths.Object, f.Logger);
        var path = WriteMkv(f, "a.mkv", Ebml.PortugueseAndEnglish());
        Assert.True(cache.TryGetAudioLanguages(path, out _));

        var modified = File.GetLastWriteTimeUtc(path);
        File.WriteAllBytes(path, Ebml.File(Ebml.Track(2, "jpn")));
        File.SetLastWriteTimeUtc(path, modified);

        Assert.True(cache.TryGetAudioLanguages(path, out var languages));
        Assert.Equal(new string?[] { "jpn" }, languages);
        Assert.Equal(2, cache.Reads);
    }

    [Fact]
    public async Task ConcurrentMissesOnOneFileReadItOnce()
    {
        using var f = new CoreFixture();
        using var cache = new MatroskaLanguageCache(f.Paths.Object, f.Logger);
        var path = WriteMkv(f, "a.mkv", Ebml.PortugueseAndEnglish());
        const int callers = 8;
        using var start = new Barrier(callers);

        var results = await Task.WhenAll(Enumerable.Range(0, callers)
            .Select(_ => Task.Factory.StartNew(() =>
            {
                start.SignalAndWait();
                var parsed = cache.TryGetAudioLanguages(path, out var languages);
                return (parsed, languages);
            }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default)));

        Assert.Equal(1, cache.Reads);
        Assert.Equal(callers - 1, cache.Hits);
        Assert.All(results, r =>
        {
            Assert.True(r.parsed);
            Assert.Equal(new string?[] { "pt-BR", "eng" }, r.languages);
        });
    }

    [Fact]
    public void FailedSaveIsRetriedWithoutAnotherChange()
    {
        using var f = new CoreFixture();
        var json = Path.Combine(f.ConfigRoot, "matroska-languages.json");

        // The config directory's path is taken by a file, so it cannot be
        // created (the fixture's UserConfigurationManager makes it up front).
        if (Directory.Exists(f.ConfigRoot)) Directory.Delete(f.ConfigRoot, true);
        Directory.CreateDirectory(Path.GetDirectoryName(f.ConfigRoot)!);
        File.WriteAllText(f.ConfigRoot, "blocker");
        var path = WriteMkv(f, "a.mkv", Ebml.PortugueseAndEnglish());
        var delay = TimeSpan.FromMilliseconds(100);
        using var cache = new MatroskaLanguageCache(f.Paths.Object, f.Logger, delay, TimeSpan.FromSeconds(1));

        Assert.True(cache.TryGetAudioLanguages(path, out _));
        Assert.True(SpinWait.SpinUntil(() => LogContains(f, "Failed to save matroska-languages.json"), TimeSpan.FromSeconds(10)));
        Assert.False(File.Exists(json));

        // Only the retry can write it now: the cache is not changed again.
        File.Delete(f.ConfigRoot);
        Assert.True(SpinWait.SpinUntil(() => File.Exists(json), TimeSpan.FromSeconds(10)));
        Assert.Contains("a.mkv", File.ReadAllText(json));
        Assert.Equal(1, cache.Reads);
    }

    private static bool LogContains(CoreFixture f, string text)
    {
        try
        {
            return Directory.EnumerateFiles(f.Root, "JellyfinEnhanced_*.log").Any(log => File.ReadAllText(log).Contains(text));
        }
        catch (IOException)
        {
            return false;
        }
    }

    [Fact]
    public void ReaderFollowsTheSeekHeadToTracksAfterTheFirstCluster()
    {
        using var f = new CoreFixture();
        var path = WriteMkv(f, "relocated.mkv", Ebml.TracksAfterCluster());

        Assert.True(MatroskaLanguageReader.TryReadAudioLanguages(path, out var languages));
        Assert.Equal(new string?[] { "pt-BR", "eng" }, languages);

        // Through the cache the positive result is stored and served from then on.
        using var cache = new MatroskaLanguageCache(f.Paths.Object, f.Logger);
        Assert.True(cache.TryGetAudioLanguages(path, out var cached));
        Assert.True(cache.TryGetAudioLanguages(path, out var again));
        Assert.Equal(new string?[] { "pt-BR", "eng" }, cached);
        Assert.Equal(cached, again);
        Assert.Equal((1L, 1L), (cache.Reads, cache.Hits));
    }

    [Fact]
    public void ReaderRejectsASeekHeadTracksPositionThatIsNotTracks()
    {
        using var f = new CoreFixture();

        // Pointing at the Cluster (right after the SeekHead) and past the end of the file.
        var atCluster = WriteMkv(f, "at-cluster.mkv", Ebml.TracksAfterCluster(_ => Ebml.SeekHead(0x1654AE6B, 0).Length));
        var pastEnd = WriteMkv(f, "past-end.mkv", Ebml.TracksAfterCluster(_ => 1_000_000));
        var overflow = WriteMkv(f, "overflow.mkv", Ebml.TracksAfterCluster(_ => long.MaxValue));
        var beyondLong = WriteMkv(f, "beyond-long.mkv", Ebml.TracksAfterCluster(_ => -1)); // 0xFFFF_FFFF_FFFF_FFFF unsigned

        Assert.False(MatroskaLanguageReader.TryReadAudioLanguages(atCluster, out _));
        Assert.False(MatroskaLanguageReader.TryReadAudioLanguages(pastEnd, out _));
        Assert.False(MatroskaLanguageReader.TryReadAudioLanguages(overflow, out _));
        Assert.False(MatroskaLanguageReader.TryReadAudioLanguages(beyondLong, out _));
    }

    [Fact]
    public void ReaderStillStopsAtTheFirstClusterWithoutASeekHead()
    {
        using var f = new CoreFixture();
        var path = WriteMkv(f, "no-seekhead.mkv", Ebml.Segment(Ebml.Cluster(), Ebml.Tracks(Ebml.PortugueseAndEnglishTracks())));

        Assert.False(MatroskaLanguageReader.TryReadAudioLanguages(path, out _));
    }

    [Fact]
    public void UnparseableSeekHeadDoesNotFailAnOtherwiseReadableFile()
    {
        using var f = new CoreFixture();
        var garbageSeekHead = Ebml.Element(0x114D9B74, Enumerable.Repeat((byte)0xFF, 16).ToArray());
        var path = WriteMkv(f, "bad-seekhead.mkv", Ebml.Segment(garbageSeekHead, Ebml.Tracks(Ebml.PortugueseAndEnglishTracks())));

        Assert.True(MatroskaLanguageReader.TryReadAudioLanguages(path, out var languages));
        Assert.Equal(new string?[] { "pt-BR", "eng" }, languages);
    }

    private sealed class Episode : MediaBrowser.Controller.Entities.TV.Episode
    {
        public List<MediaSourceInfo> Sources { get; init; } = [];
        public override List<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution) => Sources;
    }

    private static Episode MkvEpisode(string path) => new()
    {
        Id = Guid.NewGuid(), Name = "Episode", IndexNumber = 1, ParentIndexNumber = 1, Path = path, Genres = ["Drama"],
        Sources = [Source(path, Video(), Audio("por"), Audio("eng"))]
    };

    [Fact]
    public void TagCacheReadsEachFileOnceAcrossBuilds()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        var episode = MkvEpisode(WriteMkv(f.Core, "episode.mkv", Ebml.PortugueseAndEnglish()));
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
            q.IncludeItemTypes?.Contains(episode.GetBaseItemKind()) == true ? [episode.Id] : []);
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
            q.ItemIds?.Contains(episode.Id) == true ? [episode] : []);
        using var languageCache = new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger);
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, languageCache);

        var onDemand = cache.BuildEntryOnDemand(episode);
        var again = cache.BuildEntryOnDemand(episode);
        Assert.Equal(["pt-br", "eng"], onDemand!.AudioLanguages!);
        Assert.Equal(onDemand.AudioLanguages, again!.AudioLanguages);
        Assert.Contains(onDemand.StreamData!.Streams!, s => s.Language == "pt-BR");
        Assert.Equal(1, languageCache.Reads);

        // Two full builds (each a sweep) still read the file only once in total,
        // and the visited file survives the sweeps.
        cache.BuildFullCache(null, CancellationToken.None);
        cache.BuildFullCache(null, CancellationToken.None);
        Assert.True(cache.TryGetEntry(episode.Id, out var built));
        Assert.Equal(["pt-br", "eng"], built.AudioLanguages!);
        Assert.Equal(1, languageCache.Reads);
    }
}
