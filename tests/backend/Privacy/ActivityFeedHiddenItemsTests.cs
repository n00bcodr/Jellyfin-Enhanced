using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using Moq;

namespace JE.Tests;

/// <summary>
/// Activity Feed entries stored against items a plain user query never returns (#1013):
/// alternate versions on Jellyfin 12, and favorited people, genres, studios and artists.
/// </summary>
public class ActivityFeedHiddenItemsTests
{
    private static readonly BaseItemKind[] ByNameKinds =
        [BaseItemKind.Person, BaseItemKind.Genre, BaseItemKind.MusicGenre, BaseItemKind.MusicArtist, BaseItemKind.Studio];

    /// <summary>
    /// The library side of the feed. On Jellyfin 12 it follows 12.4's own query code
    /// (LibraryManager.AddUserToQuery; BaseItemRepository's ApplyTopParentFiltering,
    /// ApplyItemByNameAccessFiltering, ApplyAlternateVersionFiltering and TranslateQuery's
    /// owned-item filter):
    /// - ConfigureUserAccess scopes a query only while its ItemIds is empty. An unscoped query
    ///   returns nothing here (the real one returns every item; the feed must scope either way).
    /// - IncludeItemTypes filters by type. A by-name kind it names skips the library check by
    ///   type (even a music artist that is a folder in a library), and for a user with content
    ///   restrictions needs an item behind its name the user can reach.
    /// - Any other item needs its library among the viewer's and must pass parental rules.
    /// - A version whose primary is in the same library, or an owned item that is not an extra,
    ///   comes back only with IncludeOwnedItems.
    /// - Like Jellyfin, a user query that may return videos keeps one id per presentation key
    ///   unless GroupByPresentationUniqueKey is off: every version shares its primary's key, and
    ///   the primary (else the smallest id) stands for the group. Grouping runs last.
    /// On 10.11 the feed asks once for every item the viewer can reach (a recursive user query).
    /// </summary>
    private sealed class FakeLibrary
    {
        private readonly Dictionary<Guid, (BaseItem Item, Guid? Library)> _items = new();
#if JF12
        private readonly Dictionary<InternalItemsQuery, User> _scoped = new(ReferenceEqualityComparer.Instance);
#endif

        public Mock<ILibraryManager> Manager { get; } = new();
        public Dictionary<Guid, HashSet<Guid>> ViewerLibraries { get; } = new();
        public HashSet<Guid> ParentalBlocked { get; } = new();
        public HashSet<Guid> ReachableByName { get; } = new();
        public List<InternalItemsQuery> Queries { get; } = new();
        public List<Guid> Lookups { get; } = new();

        public FakeLibrary()
        {
#if JF12
            Manager.Setup(x => x.ConfigureUserAccess(It.IsAny<InternalItemsQuery>(), It.IsAny<User>()))
                .Callback<InternalItemsQuery, User>((query, user) => { if (query.ItemIds.Length == 0) _scoped[query] = user; });
#endif
            Manager.Setup(x => x.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns<InternalItemsQuery>(query =>
            {
                Queries.Add(query);
                return Evaluate(query);
            });
            Manager.Setup(x => x.GetItemById(It.IsAny<Guid>())).Returns<Guid>(id =>
            {
                Lookups.Add(id);
                return _items.TryGetValue(id, out var entry) ? entry.Item : null;
            });
        }

        public T Add<T>(T item, Guid? library) where T : BaseItem
        {
            _items[item.Id] = (item, library);
            return item;
        }

        private List<Guid> Evaluate(InternalItemsQuery query)
        {
#if JF12
            if (!_scoped.TryGetValue(query, out var user)) return [];
            var ids = query.ItemIds;
#else
            // 10.11: the one recursive user query, never narrowed to ids.
            var user = query.User;
            if (user == null || query.ItemIds.Length > 0) return [];
            var ids = _items.Keys.ToArray();
#endif
            var libraries = ViewerLibraries.GetValueOrDefault(user.Id) ?? [];
            var result = new List<Guid>();
            foreach (var id in ids)
            {
                if (!_items.TryGetValue(id, out var entry)) continue;
                var kind = entry.Item.GetBaseItemKind();
                if (query.IncludeItemTypes.Length > 0 && !query.IncludeItemTypes.Contains(kind)) continue;
                if (ByNameKinds.Contains(kind) && query.IncludeItemTypes.Contains(kind))
                {
#if JF12
                    // Jellyfin reads the flag InternalItemsQuery(user) copies from the user.
                    if (query.UserHasContentRestrictions && !ReachableByName.Contains(id)) continue;
#endif
                }
                else if (entry.Library is not { } library || !libraries.Contains(library)) continue;
                if (ParentalBlocked.Contains(id)) continue;
#if JF12
                if (!query.IncludeOwnedItems && entry.Item is Video video
                    && ((video.PrimaryVersionId is { } primary && _items.TryGetValue(primary, out var owner) && owner.Library == entry.Library)
                        || (video.OwnerId != Guid.Empty && video.ExtraType == null)))
                    continue;
#endif
                result.Add(id);
            }
            var videoKinds = new[] { BaseItemKind.Episode, BaseItemKind.Video, BaseItemKind.Movie, BaseItemKind.MusicVideo, BaseItemKind.Series, BaseItemKind.Season };
            if (!query.GroupByPresentationUniqueKey
                || (query.IncludeItemTypes.Length > 0 && !query.IncludeItemTypes.Any(videoKinds.Contains)))
                return result;
            return result
                .GroupBy(PresentationKey)
                .Select(group => group.Where(id => PrimaryOf(_items[id].Item) == null).Order().FirstOrDefault(group.Order().First()))
                .ToList();
        }

        private Guid PresentationKey(Guid id) => PrimaryOf(_items[id].Item) ?? id;

        private static Guid? PrimaryOf(BaseItem item)
        {
#if JF12
            return item is Video { PrimaryVersionId: { } primary } ? primary : null;
#else
            return item is Video video && Guid.TryParse(video.PrimaryVersionId, out var primary) ? primary : null;
#endif
        }
    }

    private static User Viewer(bool allLibraries = true)
    {
        var user = new User("viewer-" + Guid.NewGuid().ToString("N")[..6], "default", "default") { Id = Guid.NewGuid() };
        user.SetPermission(PermissionKind.EnableAllFolders, allLibraries);
        return user;
    }

    private static ActivityEntry Entry(User author, Guid item, string type, string at, bool completed = false, double progress = 0) => new()
    {
        UserId = author.Id.ToString("N"), ItemId = item.ToString("N"), ActivityType = type, OccurredAt = at,
        Completed = completed, Progress = progress
    };

    private static ActivityFeedBuilder Builder(FakeLibrary library, CoreFixture env, IItemRepository? repository = null, params User[] authors)
    {
        var users = new Mock<IUserManager>();
        foreach (var author in authors) users.Setup(x => x.GetUserById(author.Id)).Returns(author);
        return new ActivityFeedBuilder(library.Manager.Object, users.Object, repository ?? Mock.Of<IItemRepository>(), env.Logger);
    }

    private static string? CardId(ActivityFeedItem row) => row.Item.GetType().GetProperty("Id")?.GetValue(row.Item) as string;

    private static (string Type, string User, string? Card) Shape(ActivityFeedItem row) => (row.ActivityType, row.UserId, CardId(row));

#if JF12
    [Fact]
    public void PlaysAndFavoritesOfAVersionShowAsItsTitleForEveryoneWhoCanReachIt()
    {
        using var env = new CoreFixture();
        var library = new FakeLibrary();
        var media = Guid.NewGuid();
        var primary = library.Add(new Movie { Id = Guid.NewGuid(), Name = "Resident Evil" }, media);
        var linked = library.Add(new Movie { Id = Guid.NewGuid(), Name = "Resident Evil", PrimaryVersionId = primary.Id }, media);
        var local = library.Add(new Movie { Id = Guid.NewGuid(), Name = "Resident Evil", PrimaryVersionId = primary.Id, OwnerId = primary.Id }, media);
        var series = library.Add(new Series { Id = Guid.NewGuid(), Name = "Slow Horses" }, media);
        var episode = library.Add(new Episode { Id = Guid.NewGuid(), Name = "Daddy Issues", SeriesId = series.Id, SeriesName = "Slow Horses" }, media);
        var episodeVersion = library.Add(new Episode { Id = Guid.NewGuid(), Name = "Daddy Issues", SeriesId = series.Id, SeriesName = "Slow Horses", PrimaryVersionId = episode.Id }, media);
        var gio = Viewer(); var gloria = Viewer(); var admin = Viewer();
        foreach (var user in new[] { gio, gloria, admin }) library.ViewerLibraries[user.Id] = [media];
        var entries = new[]
        {
            Entry(gio, linked.Id, "Watched", "2026-11-04T00:27:16Z", completed: true, progress: 1),
            Entry(gloria, local.Id, "Favorited", "2026-11-02T21:06:50Z"),
            Entry(gloria, episodeVersion.Id, "Watched", "2026-11-01T14:49:56Z", progress: 0.4),
        };
        var expected = new[]
        {
            ("Watched", gio.Id.ToString("N"), (string?)primary.Id.ToString("N")),
            ("Favorited", gloria.Id.ToString("N"), (string?)primary.Id.ToString("N")),
            ("Watched", gloria.Id.ToString("N"), (string?)episode.Id.ToString("N")),
        };

        // The author, another user and an administrator all see the title, not nothing.
        foreach (var (viewer, isAdmin) in new[] { (gio, false), (gloria, false), (admin, true) })
        {
            var rows = Builder(library, env, null, gio, gloria).Build(entries, [], viewer, isAdmin, new PluginConfiguration(), 10);
            Assert.Equal(expected, rows.Select(Shape));
        }
        // What was played or favorited stays the stored identity.
        Assert.Equal(linked.Id.ToString("N"), entries[0].ItemId);
    }

    [Fact]
    public void VersionsStayHiddenFromViewersWhoCannotReachTheVersionOrItsTitle()
    {
        using var env = new CoreFixture();
        var library = new FakeLibrary();
        var movies = Guid.NewGuid(); var kids = Guid.NewGuid();
        var primary = library.Add(new Movie { Id = Guid.NewGuid(), Name = "Primary" }, movies);
        var version = library.Add(new Movie { Id = Guid.NewGuid(), Name = "Primary", PrimaryVersionId = primary.Id }, movies);
        var author = Viewer();
        var entries = new[] { Entry(author, version.Id, "Watched", "2026-11-04T00:00:00Z", progress: 0.5) };

        // No access to the library the version is in.
        var outsider = Viewer(allLibraries: false);
        library.ViewerLibraries[outsider.Id] = [kids];
        Assert.Empty(Builder(library, env, null, author).Build(entries, [], outsider, false, new PluginConfiguration(), 10));
        Assert.DoesNotContain(version.Id, library.Lookups);

        // Parental rules block the version itself.
        var viewer = Viewer();
        library.ViewerLibraries[viewer.Id] = [movies];
        library.ParentalBlocked.Add(version.Id);
        Assert.Empty(Builder(library, env, null, author).Build(entries, [], viewer, false, new PluginConfiguration(), 10));
        Assert.DoesNotContain(version.Id, library.Lookups);

        // Parental rules block the title the card would show.
        library.ParentalBlocked.Clear();
        library.ParentalBlocked.Add(primary.Id);
        Assert.Empty(Builder(library, env, null, author).Build(entries, [], viewer, false, new PluginConfiguration(), 10));
        Assert.DoesNotContain(primary.Id, library.Lookups);

        // On 12.2+ a version whose primary is in another library is not hidden, so it keeps
        // the old path: shown as itself to a viewer of its own library, never as the other
        // title. (12.0 hides it too; there the version and owner checks above decide.)
        library.ParentalBlocked.Clear();
        var crossPrimary = library.Add(new Movie { Id = Guid.NewGuid(), Name = "Other library" }, kids);
        var crossVersion = library.Add(new Movie { Id = Guid.NewGuid(), Name = "Other library", PrimaryVersionId = crossPrimary.Id }, movies);
        var crossRows = Builder(library, env, null, author).Build(
            [Entry(author, crossVersion.Id, "Watched", "2026-11-05T00:00:00Z", progress: 0.5)], [], viewer, false, new PluginConfiguration(), 10);
        Assert.Equal(crossVersion.Id.ToString("N"), CardId(Assert.Single(crossRows)));
    }

    [Fact]
    public void FavoritedPeopleGenresStudiosAndArtistsFollowJellyfinsByNameRule()
    {
        using var env = new CoreFixture();
        var library = new FakeLibrary();
        var movies = Guid.NewGuid();
        var byName = new BaseItem[]
        {
            library.Add(new Person { Id = Guid.NewGuid(), Name = "A. C. Green" }, null),
            library.Add(new Genre { Id = Guid.NewGuid(), Name = "Action" }, null),
            library.Add(new Studio { Id = Guid.NewGuid(), Name = "2.0 Entertainment" }, null),
            library.Add(new MusicArtist { Id = Guid.NewGuid(), Name = "Artist" }, null),
            library.Add(new MusicGenre { Id = Guid.NewGuid(), Name = "Jazz" }, null),
        };
        var author = Viewer();
        var entries = byName.Select((item, i) => Entry(author, item.Id, "Favorited", $"2026-11-0{i + 1}T00:00:00Z")).ToArray();
        var newestFirst = byName.AsEnumerable().Reverse().Select(item => (string?)item.Id.ToString("N")).ToArray();

        // A viewer without content restrictions reaches every by-name item, as /Persons does.
        var viewer = Viewer();
        library.ViewerLibraries[viewer.Id] = [movies];
        var rows = Builder(library, env, null, author).Build(entries, [], viewer, false, new PluginConfiguration(), 10);
        Assert.Equal(newestFirst, rows.Select(CardId));
        Assert.All(rows, row => Assert.Equal("Favorited", row.ActivityType));

        // A restricted viewer only reaches the ones credited on something they can reach.
        var restricted = Viewer(allLibraries: false);
        library.ViewerLibraries[restricted.Id] = [movies];
        library.ReachableByName.Add(byName[0].Id);
        var restrictedRows = Builder(library, env, null, author).Build(entries, [], restricted, false, new PluginConfiguration(), 10);
        Assert.Equal(byName[0].Id.ToString("N"), CardId(Assert.Single(restrictedRows)));

        // The by-name rule is for favorites only: a Watched entry naming a person is not a play.
        var bogus = Builder(library, env, null, author).Build(
            [Entry(author, byName[0].Id, "Watched", "2026-11-09T00:00:00Z", progress: 0.5)], [], viewer, false, new PluginConfiguration(), 10);
        Assert.Empty(bogus);
    }

    [Fact]
    public void AMusicArtistFolderKeepsItsLibraryRuleEvenWhenItsNameIsReachable()
    {
        using var env = new CoreFixture();
        var library = new FakeLibrary();
        var musicA = Guid.NewGuid(); var musicB = Guid.NewGuid();
        // An artist folder inside music library A (ParentId set), favorited by its author.
        var folderArtist = library.Add(new MusicArtist { Id = Guid.NewGuid(), Name = "X", ParentId = musicA }, musicA);
        var author = Viewer();
        var entries = new[] { Entry(author, folderArtist.Id, "Favorited", "2026-11-02T00:00:00Z") };

        // Only library B, where a track credits artist X: Jellyfin's by-name exemption would
        // admit the folder by its type and name, but it belongs to library A.
        var outsider = Viewer(allLibraries: false);
        library.ViewerLibraries[outsider.Id] = [musicB];
        library.ReachableByName.Add(folderArtist.Id);
        Assert.Empty(Builder(library, env, null, author).Build(entries, [], outsider, false, new PluginConfiguration(), 10));

        // A viewer of library A gets it through the ordinary library rule.
        var insider = Viewer(allLibraries: false);
        library.ViewerLibraries[insider.Id] = [musicA];
        var rows = Builder(library, env, null, author).Build(entries, [], insider, false, new PluginConfiguration(), 10);
        Assert.Equal(folderArtist.Id.ToString("N"), CardId(Assert.Single(rows)));
    }

    [Fact]
    public void VersionsOfOneTitleMakeOneRowPerPersonWithTheNewestTimeAndHighestProgress()
    {
        using var env = new CoreFixture();
        var library = new FakeLibrary();
        var movies = Guid.NewGuid();
        var primary = library.Add(new Movie { Id = Guid.NewGuid(), Name = "Big Buck Bunny" }, movies);
        var hd = library.Add(new Movie { Id = Guid.NewGuid(), Name = "Big Buck Bunny", PrimaryVersionId = primary.Id }, movies);
        var uhd = library.Add(new Movie { Id = Guid.NewGuid(), Name = "Big Buck Bunny", PrimaryVersionId = primary.Id, OwnerId = primary.Id }, movies);
        var gio = Viewer(); var gloria = Viewer();
        library.ViewerLibraries[gio.Id] = [movies];
        var entries = new[]
        {
            Entry(gio, primary.Id, "Watched", "2026-11-01T00:00:00Z", completed: true, progress: 1),
            Entry(gio, hd.Id, "Watched", "2026-11-03T00:00:00Z", progress: 0.2),
            Entry(gio, uhd.Id, "Favorited", "2026-11-02T00:00:00Z"),
            Entry(gio, hd.Id, "Favorited", "2026-10-30T00:00:00Z"),
            Entry(gloria, uhd.Id, "Watched", "2026-11-02T12:00:00Z", progress: 0.6),
        };
        var rows = Builder(library, env, null, gio, gloria).Build(entries, [], gio, false, new PluginConfiguration(), 10);
        Assert.Equal(new[] { "Watched", "Watched", "Favorited" }, rows.Select(r => r.ActivityType));
        Assert.All(rows, row => Assert.Equal(primary.Id.ToString("N"), CardId(row)));
        var newest = rows[0];
        Assert.Equal(gio.Id.ToString("N"), newest.UserId);
        // Like a rewatch of one item: the newest time, the highest progress, any completion.
        Assert.True(newest.Completed); Assert.Equal(1, newest.Progress);
        Assert.False(rows[1].Completed); Assert.Equal(0.6, rows[1].Progress);
        Assert.Equal(DateTimeOffset.Parse("2026-11-03T00:00:00Z").ToUnixTimeMilliseconds(), newest.Timestamp);
        Assert.Equal(gloria.Id.ToString("N"), rows[1].UserId);
        Assert.Equal(DateTimeOffset.Parse("2026-11-02T00:00:00Z").ToUnixTimeMilliseconds(), rows[2].Timestamp);

        // The limit cuts the merged list: a shorter feed shows the same first row.
        var first = Assert.Single(Builder(library, env, null, gio, gloria).Build(entries, [], gio, false, new PluginConfiguration(), 1));
        Assert.Equal((newest.ActivityType, newest.UserId, newest.Completed, newest.Progress, newest.Timestamp),
            (first.ActivityType, first.UserId, first.Completed, first.Progress, first.Timestamp));
    }

    [Fact]
    public void OrdinaryEntriesKeepOneQueryAndReviewsOfOneSeriesKeepTheirRows()
    {
        using var env = new CoreFixture();
        var library = new FakeLibrary();
        var shows = Guid.NewGuid();
        var series = library.Add(new Series { Id = Guid.NewGuid(), Name = "Slow Horses" }, shows);
        var episode = library.Add(new Episode { Id = Guid.NewGuid(), Name = "Circle of Life", SeriesId = series.Id, SeriesName = "Slow Horses" }, shows);
        var viewer = Viewer();
        library.ViewerLibraries[viewer.Id] = [shows];
        var repository = new Mock<IItemRepository>();
        repository.Setup(x => x.GetItemIdsList(It.IsAny<InternalItemsQuery>())).Returns(new List<Guid> { series.Id });
        var reviews = new[]
        {
            new UserReview { UserId = viewer.Id.ToString("N"), TmdbId = "95480:s1", CreatedAt = "2026-11-03T00:00:00Z", Rating = 4, Content = "Season one" },
            new UserReview { UserId = viewer.Id.ToString("N"), TmdbId = "95480:s2", CreatedAt = "2026-11-02T00:00:00Z", Rating = 5, Content = "Season two" },
        };
        var rows = Builder(library, env, repository.Object, viewer).Build(
            [Entry(viewer, episode.Id, "Watched", "2026-11-04T00:00:00Z", completed: true, progress: 1),
             Entry(viewer, series.Id, "Favorited", "2026-11-01T00:00:00Z")], reviews, viewer, false, new PluginConfiguration(), 10);

        Assert.Equal(new[] { "Watched", "Reviewed", "Reviewed", "Favorited" }, rows.Select(r => r.ActivityType));
        Assert.Equal(new[] { "Season one", "Season two" }, rows.Where(r => r.ActivityType == "Reviewed").Select(r => r.Content));
        // Nothing was denied, so the page needed exactly the one access query it always made.
        Assert.Single(library.Queries);
    }

    [Fact]
    public void RemovedItemsStayOutWithoutBeingLookedUp()
    {
        using var env = new CoreFixture();
        var library = new FakeLibrary();
        var viewer = Viewer();
        library.ViewerLibraries[viewer.Id] = [Guid.NewGuid()];
        var gone = Guid.NewGuid();
        var rows = Builder(library, env, null, viewer).Build(
            [Entry(viewer, gone, "Watched", "2026-11-04T00:00:00Z", completed: true, progress: 1),
             Entry(viewer, gone, "Favorited", "2026-11-03T00:00:00Z")], [], viewer, false, new PluginConfiguration(), 10);
        Assert.Empty(rows);
        Assert.Empty(library.Lookups);
    }
#else
    [Fact]
    public void OnJellyfin1011TheFeedKeepsItsOneLibraryQueryAndByNameFavoritesStayHidden()
    {
        using var env = new CoreFixture();
        var library = new FakeLibrary();
        var movies = Guid.NewGuid();
        var movie = library.Add(new Movie { Id = Guid.NewGuid(), Name = "Tears of Steel" }, movies);
        var person = library.Add(new Person { Id = Guid.NewGuid(), Name = "A. C. Green" }, null);
        var viewer = Viewer();
        library.ViewerLibraries[viewer.Id] = [movies];
        var rows = Builder(library, env, null, viewer).Build(
            [Entry(viewer, movie.Id, "Watched", "2026-11-04T00:00:00Z", progress: 0.5),
             Entry(viewer, person.Id, "Favorited", "2026-11-03T00:00:00Z")], [], viewer, false, new PluginConfiguration(), 10);
        // 10.11 has no ConfigureUserAccess, so its by-name rule can't be applied: unchanged.
        Assert.Equal(movie.Id.ToString("N"), CardId(Assert.Single(rows)));
        Assert.Single(library.Queries);
    }
#endif
}
