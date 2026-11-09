using System.Reflection;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.IO;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace JE.Tests;

/// <summary>
/// A collection's language tags are the union of its linked members' (issue #1022):
/// when a member's file gains or loses an audio or subtitle track, or the member is
/// deleted, the collection's cache entry follows: through the incremental flush
/// (Jellyfin raises no event for the BoxSet itself), through the reconciliation for
/// a change made while nothing was listening, and once after loading a snapshot
/// written before collections followed their members.
/// </summary>
[Collection("Plugin singleton")]
public class TagCacheCollectionLanguagesTests
{
    // Jellyfin derives an item's kind from its class name, so the doubles keep it.
    private sealed class Movie : MediaBrowser.Controller.Entities.Movies.Movie
    {
        public List<MediaSourceInfo> Sources { get; set; } = [];
        public override List<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution) => Sources;
    }

    private sealed class Episode : MediaBrowser.Controller.Entities.TV.Episode
    {
        public List<MediaSourceInfo> Sources { get; set; } = [];
        public override List<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution) => Sources;
    }

    private static List<MediaSourceInfo> Tracks(params string[] audio) =>
        [new() { MediaStreams = [new() { Type = MediaStreamType.Video, Height = 1080 }, .. audio.Select(language => new MediaStream { Type = MediaStreamType.Audio, Language = language })] }];

    private sealed class Library
    {
        public readonly List<BaseItem> Items = new();
        public readonly Mock<ILibraryManager> Mock = new();
        /// <summary>When false, a reconciliation sees no item saved since its marker.</summary>
        public bool ReportSavedItems = true;

        public Library()
        {
            IEnumerable<BaseItem> Select(InternalItemsQuery q)
            {
                if (q.MinDateLastSaved != null && !ReportSavedItems) return Array.Empty<BaseItem>();
                IEnumerable<BaseItem> selected = Items;
                if (q.ItemIds?.Length > 0) selected = selected.Where(i => q.ItemIds.Contains(i.Id));
                else if (q.IncludeItemTypes?.Length > 0) selected = selected.Where(i => q.IncludeItemTypes.Contains(i.GetBaseItemKind()));
                if (q.ParentId != Guid.Empty) selected = selected.Where(i => i.ParentId == q.ParentId || (i is MediaBrowser.Controller.Entities.TV.Episode e && e.SeriesId == q.ParentId));
                return selected.Skip(q.StartIndex ?? 0).Take(q.Limit ?? int.MaxValue).ToArray();
            }

            Mock.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => Select(q).Select(i => i.Id).ToArray());
            Mock.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => Select(q).ToArray());
            Mock.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => Items.SingleOrDefault(i => i.Id == id));
            Mock.Setup(l => l.GetItemById<BaseItem>(It.IsAny<Guid>())).Returns((Guid id) => Items.SingleOrDefault(i => i.Id == id));
        }
    }

    private static void Flush(TagCacheService cache) =>
        typeof(TagCacheService).GetMethod("FlushPending", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(cache, null);

    /// <summary>Two flushes: the member's own change, then the collection it queued.</summary>
    private static void FlushTwice(TagCacheService cache)
    {
        Flush(cache);
        Flush(cache);
    }

    private static string[] Audio(TagCacheService cache, BaseItem item) =>
        cache.TryGetEntry(item.Id, out var entry) ? (entry.AudioLanguages ?? Array.Empty<string>()).Order(StringComparer.Ordinal).ToArray() : throw new InvalidOperationException("no entry for " + item.Name);

    private static long Stamp(TagCacheService cache, BaseItem item) =>
        cache.TryGetEntry(item.Id, out var entry) ? entry.LastUpdated : throw new InvalidOperationException("no entry for " + item.Name);

    /// <summary>Runs <paramref name="body"/> with a fresh cache over <paramref name="library"/>.</summary>
    private static void WithCache(Library library, Action<TagCacheService> body)
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        var previous = BaseItem.LibraryManager;
        var previousLogger = BaseItem.Logger;
        BaseItem.LibraryManager = library.Mock.Object;
        // Jellyfin logs a link it cannot resolve (a deleted member) through this.
        BaseItem.Logger = NullLogger<BaseItem>.Instance;
        try
        {
            using var cache = new TagCacheService(library.Mock.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
            cache.BuildFullCache(null, CancellationToken.None);
            body(cache);
        }
        finally
        {
            BaseItem.LibraryManager = previous;
            BaseItem.Logger = previousLogger;
        }
    }

    [Fact]
    public void AMemberLosingATrackUpdatesItsCollectionsOnly()
    {
        var library = new Library();
        var dubbed = new Movie { Id = Guid.NewGuid(), Name = "Dubbed", Sources = Tracks("eng", "fre") };
        var other = new Movie { Id = Guid.NewGuid(), Name = "Other", Sources = Tracks("jpn") };
        var box = new BoxSet { Id = Guid.NewGuid(), Name = "Box", LinkedChildren = [new LinkedChild { ItemId = dubbed.Id }, new LinkedChild { ItemId = other.Id }] };
        var unrelated = new BoxSet { Id = Guid.NewGuid(), Name = "Unrelated", LinkedChildren = [new LinkedChild { ItemId = other.Id }] };
        library.Items.AddRange(new BaseItem[] { dubbed, other, box, unrelated });

        WithCache(library, cache =>
        {
            Assert.Equal(new[] { "eng", "fre", "jpn" }, Audio(cache, box));
            var unrelatedStamp = Stamp(cache, unrelated);

            // The file is remuxed without its French track; Jellyfin reports the movie only.
            dubbed.Sources = Tracks("eng");
            cache.EnqueueUpdate(dubbed.Id);
            FlushTwice(cache);

            Assert.Equal(new[] { "eng" }, Audio(cache, dubbed));
            Assert.Equal(new[] { "eng", "jpn" }, Audio(cache, box));
            Assert.Equal(new[] { "jpn" }, Audio(cache, unrelated));
            Assert.Equal(unrelatedStamp, Stamp(cache, unrelated));

            // A track added back reaches the collection the same way.
            dubbed.Sources = Tracks("eng", "ger");
            cache.EnqueueUpdate(dubbed.Id);
            FlushTwice(cache);
            Assert.Equal(new[] { "eng", "ger", "jpn" }, Audio(cache, box));
        });
    }

    [Fact]
    public void AnEpisodeTrackChangeReachesACollectionOfItsSeries()
    {
        var library = new Library();
        var series = new Series { Id = Guid.NewGuid(), Name = "Show" };
        var season = new Season { Id = Guid.NewGuid(), Name = "Season 1", ParentId = series.Id, SeriesId = series.Id, IndexNumber = 1 };
        var episode = new Episode { Id = Guid.NewGuid(), Name = "Pilot", ParentId = season.Id, SeasonId = season.Id, SeriesId = series.Id, IndexNumber = 1, ParentIndexNumber = 1, Sources = Tracks("eng", "spa") };
        var box = new BoxSet { Id = Guid.NewGuid(), Name = "Box", LinkedChildren = [new LinkedChild { ItemId = series.Id }] };
        library.Items.AddRange(new BaseItem[] { series, season, episode, box });

        WithCache(library, cache =>
        {
            Assert.Equal(new[] { "eng", "spa" }, Audio(cache, box));

            // The monitor queues an episode with its season and series.
            episode.Sources = Tracks("eng");
            cache.EnqueueUpdate(episode.Id);
            cache.EnqueueUpdate(season.Id);
            cache.EnqueueUpdate(series.Id);
            FlushTwice(cache);

            Assert.Equal(new[] { "eng" }, Audio(cache, series));
            Assert.Equal(new[] { "eng" }, Audio(cache, box));
        });
    }

    [Fact]
    public void ADeletedMemberLeavesItsCollection()
    {
        var library = new Library();
        var gone = new Movie { Id = Guid.NewGuid(), Name = "Gone", Sources = Tracks("ita") };
        var kept = new Movie { Id = Guid.NewGuid(), Name = "Kept", Sources = Tracks("eng") };
        var box = new BoxSet { Id = Guid.NewGuid(), Name = "Box", LinkedChildren = [new LinkedChild { ItemId = gone.Id }, new LinkedChild { ItemId = kept.Id }] };
        library.Items.AddRange(new BaseItem[] { gone, kept, box });

        WithCache(library, cache =>
        {
            Assert.Equal(new[] { "eng", "ita" }, Audio(cache, box));

            // The collection still names the deleted id; Jellyfin reports only the removal.
            library.Items.Remove(gone);
            cache.EnqueueRemoval(gone.Id);
            FlushTwice(cache);

            Assert.False(cache.TryGetEntry(gone.Id, out _));
            Assert.Equal(new[] { "eng" }, Audio(cache, box));
        });
    }

    [Fact]
    public void ADeletedMemberWhoseLinkWasAlreadyClearedLeavesItsCollection()
    {
        var library = new Library();
        var gone = new Movie { Id = Guid.NewGuid(), Name = "Gone", Sources = Tracks("ita") };
        var kept = new Movie { Id = Guid.NewGuid(), Name = "Kept", Sources = Tracks("eng") };
        var box = new BoxSet { Id = Guid.NewGuid(), Name = "Box", LinkedChildren = [new LinkedChild { ItemId = gone.Id }, new LinkedChild { ItemId = kept.Id }] };
        library.Items.AddRange(new BaseItem[] { gone, kept, box });

        WithCache(library, cache =>
        {
            library.Items.Remove(gone);
            // Something resolved the collection's links first: Jellyfin cleared the dead one.
            Assert.Equal(new[] { kept.Id }, box.GetLinkedChildren().Select(child => child.Id));
            Assert.Equal(Guid.Empty, box.LinkedChildren[0].ItemId);

            cache.EnqueueRemoval(gone.Id);
            FlushTwice(cache);
            Assert.Equal(new[] { "eng" }, Audio(cache, box));
        });
    }

    [Fact]
    public void AChangeThatKeepsTheLanguagesQueuesNoCollection()
    {
        var library = new Library();
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Movie", Sources = Tracks("eng") };
        var box = new BoxSet { Id = Guid.NewGuid(), Name = "Box", LinkedChildren = [new LinkedChild { ItemId = movie.Id }] };
        library.Items.AddRange(new BaseItem[] { movie, box });

        WithCache(library, cache =>
        {
            var boxLookups = 0;
            library.Mock.Setup(l => l.GetItemById<BaseItem>(box.Id)).Returns(() => { boxLookups++; return box; });

            // A rating edit changes the movie's entry but not its languages: the
            // collection is neither checked nor rebuilt.
            movie.CommunityRating = 7.5f;
            cache.EnqueueUpdate(movie.Id);
            FlushTwice(cache);
            Assert.Equal(7.5f, cache.TryGetEntry(movie.Id, out var entry) ? entry.CommunityRating : null);
            Assert.Equal(0, boxLookups);

            // The same hook sees a language change reach the collection.
            movie.Sources = Tracks("eng", "kor");
            cache.EnqueueUpdate(movie.Id);
            FlushTwice(cache);
            Assert.True(boxLookups > 0);
            Assert.Equal(new[] { "eng", "kor" }, Audio(cache, box));
        });
    }

    [Fact]
    public void AMemberJellyfinDeletedAndUnlinkedLeavesItsCollection()
    {
        var library = new Library();
        var gone = new Movie { Id = Guid.NewGuid(), Name = "Gone", Sources = Tracks("ita") };
        var kept = new Movie { Id = Guid.NewGuid(), Name = "Kept", Sources = Tracks("eng") };
        var box = new BoxSet { Id = Guid.NewGuid(), Name = "Box", LinkedChildren = [new LinkedChild { ItemId = gone.Id }, new LinkedChild { ItemId = kept.Id }] };
        library.Items.AddRange(new BaseItem[] { gone, kept, box });

        WithCache(library, cache =>
        {
            // Jellyfin 12 deletes the item's link rows with it: the collection, reloaded,
            // no longer names the deleted member at all.
            library.Items.Remove(gone);
            box.LinkedChildren = [new LinkedChild { ItemId = kept.Id }];
            cache.EnqueueRemoval(gone.Id);
            FlushTwice(cache);
            Assert.Equal(new[] { "eng" }, Audio(cache, box));
        });
    }

    [Fact]
    public void AMemberInAnExcludedLibraryStillReachesItsCollection()
    {
        var library = new Library();
        var excludedLibrary = new Folder { Id = Guid.NewGuid(), Name = "Excluded" };
        var shown = new Movie { Id = Guid.NewGuid(), Name = "Shown", Sources = Tracks("eng") };
        var hidden = new Movie { Id = Guid.NewGuid(), Name = "Excluded member", Sources = Tracks("spa") };
        var box = new BoxSet { Id = Guid.NewGuid(), Name = "Box", LinkedChildren = [new LinkedChild { ItemId = shown.Id }, new LinkedChild { ItemId = hidden.Id }] };
        library.Items.AddRange(new BaseItem[] { shown, hidden, box });
        library.Mock.Setup(l => l.GetCollectionFolders(It.IsAny<BaseItem>())).Returns((BaseItem item) =>
            item.Id == hidden.Id ? new List<Folder> { excludedLibrary } : new List<Folder>());

        WithCache(library, cache =>
        {
            Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.Instance!.Configuration.TagCacheExcludeLibraries = true;
            Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.Instance.Configuration.TagCacheExcludedLibraryIds = excludedLibrary.Id.ToString();
            // The excluded member has no entry of its own.
            cache.EnqueueUpdate(hidden.Id);
            FlushTwice(cache);
            Assert.False(cache.TryGetEntry(hidden.Id, out _));
            Assert.Equal(new[] { "eng", "spa" }, Audio(cache, box));

            // Its collection still takes its languages, so a track change reaches it.
            hidden.Sources = Tracks("spa", "por");
            cache.EnqueueUpdate(hidden.Id);
            FlushTwice(cache);
            Assert.Equal(new[] { "eng", "por", "spa" }, Audio(cache, box));
        });
    }

    [Fact]
    public void AMemberLinkedByPathReachesItsCollection()
    {
        var library = new Library();
        const string path = "/movies/Pathed (2020)/Pathed (2020).mkv";
        var pathed = new Movie { Id = Guid.NewGuid(), Name = "Pathed", Path = path, Sources = Tracks("eng", "fre") };
        // Jellyfin 10.11 stores a manual collection link by path only.
        var box = new BoxSet { Id = Guid.NewGuid(), Name = "Box", LinkedChildren = [new LinkedChild { Path = path }] };
        library.Items.AddRange(new BaseItem[] { pathed, box });
        library.Mock.Setup(l => l.FindByPath(path, It.IsAny<bool?>())).Returns(pathed);
        var previousFileSystem = BaseItem.FileSystem;
        var fileSystem = new Mock<IFileSystem>();
        fileSystem.Setup(f => f.MakeAbsolutePath(It.IsAny<string>(), It.IsAny<string>())).Returns((string _, string file) => file);
        BaseItem.FileSystem = fileSystem.Object;
        try
        {
            WithCache(library, cache =>
            {
                Assert.Equal(new[] { "eng", "fre" }, Audio(cache, box));
                pathed.Sources = Tracks("eng");
                cache.EnqueueUpdate(pathed.Id);
                FlushTwice(cache);
                Assert.Equal(new[] { "eng" }, Audio(cache, box));
            });
        }
        finally
        {
            BaseItem.FileSystem = previousFileSystem;
        }
    }

    [Fact]
    public void AReconciliationCatchesAMemberChangedWhileNothingListened()
    {
        var library = new Library();
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Movie", Sources = Tracks("eng", "fre") };
        var box = new BoxSet { Id = Guid.NewGuid(), Name = "Box", LinkedChildren = [new LinkedChild { ItemId = movie.Id }] };
        library.Items.AddRange(new BaseItem[] { movie, box });

        WithCache(library, cache =>
        {
            // Jellyfin re-probed and saved the movie while no event reached the cache.
            movie.Sources = Tracks("eng");
            cache.ReconcileCache(null, CancellationToken.None);
            Assert.Equal(new[] { "eng" }, Audio(cache, movie));
            Flush(cache);
            Assert.Equal(new[] { "eng" }, Audio(cache, box));
        });
    }

    [Fact]
    public void AnUnchangedCollectionRebuiltAfterLoadingAnOldSnapshotStillSavesItsMembers()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        var library = new Library();
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Movie", Sources = Tracks("eng") };
        var box = new BoxSet { Id = Guid.NewGuid(), Name = "Box", LinkedChildren = [new LinkedChild { ItemId = movie.Id }] };
        library.Items.AddRange(new BaseItem[] { movie, box });
        var previous = BaseItem.LibraryManager;
        var previousLogger = BaseItem.Logger;
        BaseItem.LibraryManager = library.Mock.Object;
        BaseItem.Logger = NullLogger<BaseItem>.Instance;
        try
        {
            TagCacheService Create() => new(library.Mock.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
            string file;
            using (var before = Create())
            {
                before.BuildFullCache(null, CancellationToken.None);
                before.SaveToDisk();
                file = (string)typeof(TagCacheService).GetProperty("CacheFilePath", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(before)!;
            }

            var json = JsonNode.Parse(File.ReadAllText(file))!.AsObject();
            Assert.True(json.Remove("CollectionMembers"));
            File.WriteAllText(file, json.ToJsonString());

            using var cache = Create();
            cache.LoadFromDisk();
            var dirty = typeof(TagCacheService).GetField("_dirty", BindingFlags.Instance | BindingFlags.NonPublic)!;
            Assert.False((bool)dirty.GetValue(cache)!);
            Flush(cache);
            Assert.Equal(new[] { "eng" }, Audio(cache, box));
            Assert.True((bool)dirty.GetValue(cache)!, "the member index is saved although no entry changed");
        }
        finally
        {
            BaseItem.LibraryManager = previous;
            BaseItem.Logger = previousLogger;
        }
    }

    [Fact]
    public void ASnapshotFromBeforeCollectionsFollowedTheirMembersRebuildsThemOnLoad()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        var library = new Library();
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Movie", Sources = Tracks("eng", "fre") };
        var box = new BoxSet { Id = Guid.NewGuid(), Name = "Box", LinkedChildren = [new LinkedChild { ItemId = movie.Id }] };
        library.Items.AddRange(new BaseItem[] { movie, box });
        var previous = BaseItem.LibraryManager;
        var previousLogger = BaseItem.Logger;
        BaseItem.LibraryManager = library.Mock.Object;
        BaseItem.Logger = NullLogger<BaseItem>.Instance;
        try
        {
            TagCacheService Create() => new(library.Mock.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
            string file;
            using (var before = Create())
            {
                before.BuildFullCache(null, CancellationToken.None);
                before.SaveToDisk();
                file = (string)typeof(TagCacheService).GetProperty("CacheFilePath", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(before)!;
            }

            // A snapshot an earlier version wrote: no member index. Meanwhile the movie
            // lost its French track and its own entry followed, but the collection did not.
            var json = JsonNode.Parse(File.ReadAllText(file))!.AsObject();
            Assert.True(json.Remove("CollectionMembers"));
            var movieKey = movie.Id.ToString("N");
            json["Items"]![movieKey]!["AudioLanguages"] = new JsonArray("eng");
            File.WriteAllText(file, json.ToJsonString());
            movie.Sources = Tracks("eng");

            using var cache = Create();
            cache.LoadFromDisk();
            Assert.Equal(new[] { "eng", "fre" }, Audio(cache, box));
            Flush(cache);
            Assert.Equal(new[] { "eng" }, Audio(cache, box));

            // The next snapshot carries the index, so a restart does not rebuild them again.
            cache.SaveToDisk();
            var saved = JsonNode.Parse(File.ReadAllText(file))!.AsObject();
            Assert.Equal(movieKey, saved["CollectionMembers"]![box.Id.ToString("N")]![0]!.GetValue<string>());
        }
        finally
        {
            BaseItem.LibraryManager = previous;
            BaseItem.Logger = previousLogger;
        }
    }
}
