using System.Reflection;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution;
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

    /// <summary>
    /// "Just Added" on a collection reads its newest member's added date, never the collection's own:
    /// Jellyfin creates automatic TMDB collections again on a library scan, which resets that date.
    /// </summary>
    [Fact]
    public void ACollectionIsJustAddedByItsNewestMemberNotItsOwnDate()
    {
        var now = new DateTime(2026, 10, 30, 12, 0, 0, DateTimeKind.Utc);
        var library = new Library();
        var old = new Movie { Id = Guid.NewGuid(), Name = "Old", DateCreated = now.AddYears(-3), Sources = Tracks("eng") };
        var older = new Movie { Id = Guid.NewGuid(), Name = "Older", DateCreated = now.AddYears(-5), Sources = Tracks("eng") };
        // Recreated by last night's scan: its own date is new, its members are not.
        var box = new BoxSet { Id = Guid.NewGuid(), Name = "Box", DateCreated = now.AddHours(-6), LinkedChildren = [new LinkedChild { ItemId = old.Id }, new LinkedChild { ItemId = older.Id }] };
        var empty = new BoxSet { Id = Guid.NewGuid(), Name = "Empty", DateCreated = now.AddHours(-6) };
        library.Items.AddRange(new BaseItem[] { old, older, box, empty });
        var settings = PosterTagSettings.FromUserSettings(new Jellyfin.Plugin.JellyfinEnhanced.Configuration.JellyfinEnhancedUserSettings { StatusTagsEnabled = true },
            new Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration { StatusTagsEnabled = true });
        var context = new PosterStatusContext(new DateTimeOffset(now));
        string? Badge(TagCacheService cache, BaseItem item) => cache.TryGetEntry(item.Id, out var entry) ? StatusRules.Resolve(entry, settings, context)?.Key : throw new InvalidOperationException("no entry");

        WithCache(library, cache =>
        {
            Assert.True(cache.TryGetEntry(box.Id, out var built));
            Assert.Equal(TagCacheService.ToUnixMilliseconds(old.DateCreated), built.LatestEpisodeAdded);
            Assert.Equal(old.Id.ToString("N"), built.LatestEpisodeId);
            Assert.Null(Badge(cache, box));
            Assert.True(cache.TryGetEntry(empty.Id, out var noMembers));
            Assert.Null(noMembers.LatestEpisodeAdded);
            Assert.Null(noMembers.LatestEpisodeId);
            Assert.Null(Badge(cache, empty));

            // A film arrives and joins the collection: Jellyfin reports the movie and the collection.
            var arrival = new Movie { Id = Guid.NewGuid(), Name = "Arrival", DateCreated = now.AddDays(-1), Sources = Tracks("eng") };
            library.Items.Add(arrival);
            box.LinkedChildren = [.. box.LinkedChildren, new LinkedChild { ItemId = arrival.Id }];
            // Cache off, or before the first build: a native poster's on-demand entry already reads the new member.
            Assert.Equal(TagCacheService.ToUnixMilliseconds(arrival.DateCreated), cache.BuildEntryOnDemand(box)!.LatestEpisodeAdded);
            // The collection first, before its member has an entry of its own.
            cache.EnqueueUpdate(box.Id);
            Flush(cache);
            cache.EnqueueUpdate(arrival.Id);
            FlushTwice(cache);
            Assert.True(cache.TryGetEntry(box.Id, out var joined));
            Assert.Equal(TagCacheService.ToUnixMilliseconds(arrival.DateCreated), joined.LatestEpisodeAdded);
            Assert.Equal(arrival.Id.ToString("N"), joined.LatestEpisodeId);
            Assert.Equal("just_added", Badge(cache, box));

            // Its Date Added is edited back two years; Jellyfin reports the movie only.
            arrival.DateCreated = now.AddYears(-2);
            cache.EnqueueUpdate(arrival.Id);
            FlushTwice(cache);
            Assert.True(cache.TryGetEntry(box.Id, out var edited));
            Assert.Equal(TagCacheService.ToUnixMilliseconds(arrival.DateCreated), edited.LatestEpisodeAdded);
            Assert.Null(Badge(cache, box));
            arrival.DateCreated = now.AddDays(-1);
            cache.EnqueueUpdate(arrival.Id);
            FlushTwice(cache);
            Assert.Equal("just_added", Badge(cache, box));

            // Deleted again: the collection goes back to its older members.
            library.Items.Remove(arrival);
            cache.EnqueueRemoval(arrival.Id);
            FlushTwice(cache);
            Assert.True(cache.TryGetEntry(box.Id, out var left));
            Assert.Equal(old.Id.ToString("N"), left.LatestEpisodeId);
            Assert.Null(Badge(cache, box));
        });
    }

    /// <summary>A collection of home videos or episodes (not only movies and series) is still badged by a member added recently.</summary>
    [Fact]
    public void ACollectionOfOtherTaggedKindsIsJustAddedByItsNewestMember()
    {
        var now = new DateTime(2026, 10, 30, 12, 0, 0, DateTimeKind.Utc);
        var library = new Library();
        var clip = new Video { Id = Guid.NewGuid(), Name = "Clip", DateCreated = now.AddDays(-1) };
        var oldClip = new Video { Id = Guid.NewGuid(), Name = "Old clip", DateCreated = now.AddYears(-2) };
        // Not a kind the cache holds: its date never counts (no user's access set could vouch for it).
        var album = new MediaBrowser.Controller.Entities.Audio.MusicAlbum { Id = Guid.NewGuid(), Name = "Album", DateCreated = now.AddHours(-1) };
        var box = new BoxSet { Id = Guid.NewGuid(), Name = "Clips", DateCreated = now.AddYears(-1), LinkedChildren = [new LinkedChild { ItemId = clip.Id }, new LinkedChild { ItemId = oldClip.Id }, new LinkedChild { ItemId = album.Id }] };
        library.Items.AddRange(new BaseItem[] { clip, oldClip, album, box });

        WithCache(library, cache =>
        {
            Assert.True(cache.TryGetEntry(box.Id, out var built));
            Assert.Equal(TagCacheService.ToUnixMilliseconds(clip.DateCreated), built.LatestEpisodeAdded);
            Assert.Equal(clip.Id.ToString("N"), built.LatestEpisodeId);
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

    /// <summary>A collection of an included movie and one in an excluded library, the latter without an entry.</summary>
    private static (Library Library, Movie Shown, Movie Hidden, BoxSet Box, Folder Excluded) WithExcludedMember()
    {
        var library = new Library();
        var excluded = new Folder { Id = Guid.NewGuid(), Name = "Excluded" };
        var shown = new Movie { Id = Guid.NewGuid(), Name = "Shown", Sources = Tracks("eng") };
        var hidden = new Movie { Id = Guid.NewGuid(), Name = "Excluded member", Sources = Tracks("spa") };
        var box = new BoxSet { Id = Guid.NewGuid(), Name = "Box", LinkedChildren = [new LinkedChild { ItemId = shown.Id }, new LinkedChild { ItemId = hidden.Id }] };
        library.Items.AddRange(new BaseItem[] { shown, hidden, box });
        library.Mock.Setup(l => l.GetCollectionFolders(It.IsAny<BaseItem>())).Returns((BaseItem item) =>
            item.Id == hidden.Id ? new List<Folder> { excluded } : new List<Folder>());
        // The reconciliation reads only the libraries left after the exclusion.
        library.Mock.Setup(l => l.GetVirtualFolders()).Returns(new List<VirtualFolderInfo>
        {
            new() { ItemId = excluded.Id.ToString("N"), Name = "Excluded" },
            new() { ItemId = Guid.NewGuid().ToString("N"), Name = "Movies" },
        });
        return (library, shown, hidden, box, excluded);
    }

    /// <summary>Excludes <paramref name="excluded"/> and drops the entry its member had from the full build.</summary>
    private static void Exclude(TagCacheService cache, Folder excluded, BaseItem member)
    {
        Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.Instance!.Configuration.TagCacheExcludeLibraries = true;
        Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.Instance.Configuration.TagCacheExcludedLibraryIds = excluded.Id.ToString();
        cache.EnqueueUpdate(member.Id);
        FlushTwice(cache);
        Assert.False(cache.TryGetEntry(member.Id, out _));
    }

    [Fact]
    public void ADeletedMemberInAnExcludedLibraryLeavesItsCollection()
    {
        var (library, _, hidden, box, excluded) = WithExcludedMember();
        WithCache(library, cache =>
        {
            Exclude(cache, excluded, hidden);
            Assert.Equal(new[] { "eng", "spa" }, Audio(cache, box));

            // Deleted and unlinked by Jellyfin 12; the member never had an entry to remove.
            library.Items.Remove(hidden);
            box.LinkedChildren = [box.LinkedChildren[0]];
            cache.EnqueueRemoval(hidden.Id);
            FlushTwice(cache);
            Assert.Equal(new[] { "eng" }, Audio(cache, box));
        });
    }

    [Fact]
    public void AReconciliationCatchesAnExcludedMemberChangedWhileNothingListened()
    {
        var (library, _, hidden, box, excluded) = WithExcludedMember();
        WithCache(library, cache =>
        {
            Exclude(cache, excluded, hidden);
            // The reconciliation only reads items of included libraries, and nothing was saved.
            hidden.Sources = Tracks("spa", "por");
            library.ReportSavedItems = false;
            cache.ReconcileCache(null, CancellationToken.None);
            Flush(cache);
            Assert.Equal(new[] { "eng", "por", "spa" }, Audio(cache, box));
        });
    }

    [Fact]
    public void AnExcludedMemberResavedWithTheSameLanguagesQueuesNoCollection()
    {
        var (library, _, hidden, box, excluded) = WithExcludedMember();
        WithCache(library, cache =>
        {
            Exclude(cache, excluded, hidden);
            var boxLookups = 0;
            library.Mock.Setup(l => l.GetItemById<BaseItem>(box.Id)).Returns(() => { boxLookups++; return box; });

            // A library scan or chapter task re-saves the item without changing its tracks.
            hidden.CommunityRating = 6f;
            cache.EnqueueUpdate(hidden.Id);
            FlushTwice(cache);
            Assert.Equal(0, boxLookups);

            hidden.Sources = Tracks("spa", "jpn");
            cache.EnqueueUpdate(hidden.Id);
            FlushTwice(cache);
            Assert.True(boxLookups > 0);
            Assert.Equal(new[] { "eng", "jpn", "spa" }, Audio(cache, box));
        });
    }

    [Fact]
    public void AMemberChangedJustBeforeShutdownReachesItsCollectionAfterRestart()
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
            using (var before = Create())
            {
                before.BuildFullCache(null, CancellationToken.None);
                // The change is still queued when the server stops: shutdown applies the
                // movie but leaves its collection to the next start.
                movie.Sources = Tracks("eng");
                before.EnqueueUpdate(movie.Id);
            }

            using var cache = Create();
            cache.LoadFromDisk();
            Assert.Equal(new[] { "eng" }, Audio(cache, movie));
            Assert.Equal(new[] { "eng", "fre" }, Audio(cache, box));
            Flush(cache);
            Assert.Equal(new[] { "eng" }, Audio(cache, box));
        }
        finally
        {
            BaseItem.LibraryManager = previous;
            BaseItem.Logger = previousLogger;
        }
    }

    /// <summary>The excluded-member fixture with a second collection sharing that member.</summary>
    private static (Library Library, Movie Hidden, BoxSet Box, BoxSet Other, Folder Excluded) WithSharedExcludedMember()
    {
        var (library, _, hidden, box, excluded) = WithExcludedMember();
        var otherMovie = new Movie { Id = Guid.NewGuid(), Name = "Other", Sources = Tracks("jpn") };
        var other = new BoxSet { Id = Guid.NewGuid(), Name = "Box 2", LinkedChildren = [new LinkedChild { ItemId = otherMovie.Id }, new LinkedChild { ItemId = hidden.Id }] };
        library.Items.AddRange(new BaseItem[] { otherMovie, other });
        return (library, hidden, box, other, excluded);
    }

    [Fact]
    public void AnExcludedMemberSharedByTwoCollectionsReachesBothWhenOneRebuildsFirst()
    {
        var (library, hidden, box, other, excluded) = WithSharedExcludedMember();
        WithCache(library, cache =>
        {
            Exclude(cache, excluded, hidden);
            Assert.Equal(new[] { "eng", "spa" }, Audio(cache, box));
            Assert.Equal(new[] { "jpn", "spa" }, Audio(cache, other));

            // The member's file changes, and one of its collections is rebuilt (renamed,
            // edited, another member changed) before the member's own event is applied.
            hidden.Sources = Tracks("por");
            cache.EnqueueUpdate(box.Id);
            Flush(cache);
            Assert.Equal(new[] { "eng", "por" }, Audio(cache, box));
            cache.EnqueueUpdate(hidden.Id);
            FlushTwice(cache);
            Assert.Equal(new[] { "jpn", "por" }, Audio(cache, other));
        });
    }

    [Fact]
    public void AnExcludedMemberSharedByTwoCollectionsReachesBothInOneBatch()
    {
        // The batch order follows a hash, so repeat with fresh ids.
        for (var attempt = 0; attempt < 16; attempt++)
        {
            var (library, hidden, box, other, excluded) = WithSharedExcludedMember();
            WithCache(library, cache =>
            {
                Exclude(cache, excluded, hidden);
                hidden.Sources = Tracks("por");
                cache.EnqueueUpdate(box.Id);
                cache.EnqueueUpdate(hidden.Id);
                FlushTwice(cache);
                Assert.Equal(new[] { "jpn", "por" }, Audio(cache, other));
            });
        }
    }

    [Fact]
    public void ANativePosterBuildOfACollectionLeavesItsMemberRecordAlone()
    {
        var (library, _, hidden, box, excluded) = WithExcludedMember();
        WithCache(library, cache =>
        {
            Exclude(cache, excluded, hidden);
            // The excluded member's file changes; a native poster of its collection is
            // drawn (an on-demand build) before the member's own event is applied.
            hidden.Sources = Tracks("por");
            Assert.Equal(new[] { "eng", "por" }, cache.BuildEntryOnDemand(box)!.AudioLanguages!.Order(StringComparer.Ordinal).ToArray());
            Assert.Equal(new[] { "eng", "spa" }, Audio(cache, box));
            cache.EnqueueUpdate(hidden.Id);
            FlushTwice(cache);
            Assert.Equal(new[] { "eng", "por" }, Audio(cache, box));
        });
    }

    [Fact]
    public void AManualRebuildForgetsACollectionDeletedMeanwhile()
    {
        var library = new Library();
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Movie", Sources = Tracks("eng") };
        var box = new BoxSet { Id = Guid.NewGuid(), Name = "Box", LinkedChildren = [new LinkedChild { ItemId = movie.Id }] };
        library.Items.AddRange(new BaseItem[] { movie, box });
        WithCache(library, cache =>
        {
            var index = (System.Collections.IDictionary)typeof(TagCacheService).GetField("_collectionMembers", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(cache)!;
            Assert.True(index.Contains(box.Id.ToString("N")));
            // Deleted while nothing listened; an admin rebuilds before any sweep.
            library.Items.Remove(box);
            cache.BuildFullCache(null, CancellationToken.None);
            Assert.False(index.Contains(box.Id.ToString("N")));
        });
    }

    [Fact]
    public void AManualRebuildReadsTheSeriesItBuilds()
    {
        var library = new Library();
        var series = new Series { Id = Guid.NewGuid(), Name = "Show" };
        var season = new Season { Id = Guid.NewGuid(), Name = "Season 1", ParentId = series.Id, SeriesId = series.Id, IndexNumber = 1 };
        var episode = new Episode { Id = Guid.NewGuid(), Name = "Pilot", ParentId = season.Id, SeasonId = season.Id, SeriesId = series.Id, IndexNumber = 1, ParentIndexNumber = 1, Sources = Tracks("eng", "spa") };
        var box = new BoxSet { Id = Guid.NewGuid(), Name = "Box", LinkedChildren = [new LinkedChild { ItemId = series.Id }] };
        library.Items.AddRange(new BaseItem[] { series, season, episode, box });
        WithCache(library, cache =>
        {
            // The episode changed and no event arrived; an admin rebuilds the cache.
            episode.Sources = Tracks("eng");
            cache.BuildFullCache(null, CancellationToken.None);
            Assert.Equal(new[] { "eng" }, Audio(cache, box));
        });
    }

    [Fact]
    public void TurningTheCacheOffKeepsAQueuedCollectionRebuild()
    {
        var library = new Library();
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Movie", Sources = Tracks("eng", "fre") };
        var box = new BoxSet { Id = Guid.NewGuid(), Name = "Box", LinkedChildren = [new LinkedChild { ItemId = movie.Id }] };
        library.Items.AddRange(new BaseItem[] { movie, box });
        WithCache(library, cache =>
        {
            // The movie's change is applied and its collection queued, then the cache is
            // turned off before the next flush and on again later.
            movie.Sources = Tracks("eng");
            cache.EnqueueUpdate(movie.Id);
            Flush(cache);
            Assert.Equal(new[] { "eng", "fre" }, Audio(cache, box));
            var config = Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.Instance!.Configuration;
            config.TagCacheServerMode = false;
            cache.OnServerModeDisabled();
            config.TagCacheServerMode = true;
            library.ReportSavedItems = false;
            cache.OnServerModeEnabled();
            Flush(cache);
            Assert.Equal(new[] { "eng" }, Audio(cache, box));
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
    public void ACollectionDeletedDuringTheUpgradeRepairDoesNotHoldBackTheIndex()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        var library = new Library();
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Movie", Sources = Tracks("eng") };
        var kept = new BoxSet { Id = Guid.NewGuid(), Name = "Kept", LinkedChildren = [new LinkedChild { ItemId = movie.Id }] };
        var gone = new BoxSet { Id = Guid.NewGuid(), Name = "Gone", LinkedChildren = [new LinkedChild { ItemId = movie.Id }] };
        library.Items.AddRange(new BaseItem[] { movie, kept, gone });
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
            // One collection is deleted, and an admin rebuilds before the one-time repair runs.
            library.Items.Remove(gone);
            cache.BuildFullCache(null, CancellationToken.None);
            cache.RemoveEntry(gone.Id);
            FlushTwice(cache);
            cache.SaveToDisk();
            var saved = JsonNode.Parse(File.ReadAllText(file))!.AsObject();
            Assert.True(saved.ContainsKey("CollectionMembers"));
            Assert.NotNull(saved["CollectionMembers"]![kept.Id.ToString("N")]);
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
            // Saved before the repair ran (a crash now must not skip it): still no index.
            cache.SaveToDisk();
            Assert.False(JsonNode.Parse(File.ReadAllText(file))!.AsObject().ContainsKey("CollectionMembers"));
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
