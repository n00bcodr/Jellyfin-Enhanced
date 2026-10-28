#if JF12
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Moq;
using Xunit;

namespace JE.Tests;

/// <summary>
/// Where the names on an absent title's page lead is answered once and kept while nothing it depends on changes, past
/// the old 30 seconds: any library item change (any kind), the library topology, the viewer's policy revision and the
/// library revision each answer it again at once, positive or negative; a change during a read never leaves its answer
/// behind; the stores are bounded and a fallback lifetime bounds what none of those sees.
/// </summary>
public class NativeDetailsLinksRevisionTests
{
    private const string Server = "0123456789abcdef0123456789abcdef";

    private sealed class Rig : IDisposable
    {
        private int _queries;

        public Mock<ILibraryManager> Library { get; } = new();
        public long Revision { get; set; } = 1;
        public DateTime Now { get; set; } = new(2026, 10, 28, 12, 0, 0, DateTimeKind.Utc);
        public NativeDetailsLinks Links { get; }
        public User Viewer { get; } = new("viewer", "default", "default") { Id = Guid.NewGuid() };
        public Guid Genre { get; } = Guid.NewGuid();
        public Guid Studio { get; } = Guid.NewGuid();
        public HashSet<string> Finds { get; } = new(StringComparer.Ordinal) { "genre", "studio", "tag" };
        public List<InternalItemsQuery> Queries { get; } = new();
        public Action? DuringQuery { get; set; }
        public string[] Locations { get; set; } = { "/movies" };
        public bool Enabled { get; set; } = true;

        public int Count => Volatile.Read(ref _queries);

        public Rig()
        {
            Library.Setup(l => l.GetGenreId("Science Fiction")).Returns(Genre);
            Library.Setup(l => l.GetStudioId("Legendary Pictures")).Returns(Studio);
            Library.Setup(l => l.GetItemById(Genre)).Returns(new Genre { Id = Genre, Name = "Science Fiction" });
            Library.Setup(l => l.GetItemById(Studio)).Returns(new Studio { Id = Studio, Name = "Legendary Pictures" });
            Library.Setup(l => l.GetVirtualFolders()).Returns(() => new List<VirtualFolderInfo>
            {
                new() { ItemId = "movies", Name = "Movies", Locations = Locations, LibraryOptions = new MediaBrowser.Model.Configuration.LibraryOptions { Enabled = Enabled } },
            });
            Library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
            {
                Interlocked.Increment(ref _queries);
                lock (Queries) Queries.Add(q);
                DuringQuery?.Invoke();
                var kind = q.GenreIds?.Any() == true ? "genre" : q.StudioIds?.Any() == true ? "studio" : "tag";
                return Finds.Contains(kind) ? new List<Guid> { Guid.NewGuid() } : new List<Guid>();
            });
            Links = new NativeDetailsLinks(Library.Object, null, () => Revision) { Clock = () => Now };
        }

        public ITitleLinks For(string revision = "r1", LinkDiscovery? discovery = null, User? viewer = null)
            => Links.For(viewer ?? Viewer, revision, Server, discovery ?? LinkDiscovery.None);

        public bool SciFi(string revision = "r1", User? viewer = null) => For(revision, viewer: viewer).Genre("Science Fiction", 878) == Genre;

        public void Raise(string change, BaseItem item)
        {
            var args = new ItemChangeEventArgs { Item = item };
            if (change == "added") Library.Raise(l => l.ItemAdded += null, Library.Object, args);
            else if (change == "updated") Library.Raise(l => l.ItemUpdated += null, Library.Object, args);
            else Library.Raise(l => l.ItemRemoved += null, Library.Object, args);
        }

        public void Dispose() => Links.Dispose();
    }

    [Fact]
    public void AnAnswerOutlivesThirtySecondsWhileNothingItDependsOnChanges()
    {
        using var rig = new Rig();
        Assert.True(rig.SciFi());
        rig.Now += TimeSpan.FromSeconds(31);
        Assert.True(rig.SciFi());
        rig.Now += TimeSpan.FromMinutes(4);
        Assert.True(rig.SciFi());
        Assert.Equal(1, rig.Count);
        // The fallback lifetime: what no revision sees (a write straight into the database) is read again after it.
        rig.Finds.Remove("genre");
        rig.Now += TimeSpan.FromMinutes(1);
        Assert.False(rig.SciFi());
        Assert.Equal(2, rig.Count);
    }

    public static IEnumerable<object[]> Changes()
    {
        foreach (var change in new[] { "added", "updated", "removed" })
        foreach (var kind in new[] { "movie", "series", "genre", "studio", "person", "folder" }) yield return new object[] { change, kind };
    }

    [Theory]
    [MemberData(nameof(Changes))]
    public void AnyLibraryItemChangeAnswersAgainAtOncePositiveOrNegative(string change, string kind)
    {
        using var rig = new Rig();
        BaseItem item = kind switch
        {
            "movie" => new Movie { Id = Guid.NewGuid() },
            "series" => new MediaBrowser.Controller.Entities.TV.Series { Id = Guid.NewGuid() },
            "genre" => new Genre { Id = Guid.NewGuid() },
            "studio" => new Studio { Id = Guid.NewGuid() },
            "person" => new Person { Id = Guid.NewGuid() },
            _ => new Folder { Id = Guid.NewGuid() },
        };
        Assert.True(rig.SciFi());
        rig.Now += TimeSpan.FromSeconds(40);
        // The last matching title went away (or out of the viewer's reach): positive to negative without waiting.
        rig.Finds.Remove("genre");
        rig.Raise(change, item);
        Assert.False(rig.SciFi());
        Assert.False(rig.SciFi());
        Assert.Equal(2, rig.Count);
        // And back: negative to positive.
        rig.Finds.Add("genre");
        rig.Raise(change, item);
        Assert.True(rig.SciFi());
        Assert.Equal(3, rig.Count);
    }

    [Fact]
    public void TheLibraryRevisionAndTopologyAnswerAgain()
    {
        using var rig = new Rig();
        Assert.True(rig.SciFi());
        rig.Finds.Remove("genre");
        rig.Revision++;
        Assert.False(rig.SciFi());
        rig.Finds.Add("genre");
        // A location removed (no item event on either host when its cleanup is cancelled).
        rig.Locations = Array.Empty<string>();
        Assert.True(rig.SciFi());
        rig.Finds.Remove("genre");
        // A library disabled.
        rig.Enabled = false;
        Assert.False(rig.SciFi());
        Assert.Equal(4, rig.Count);
        // The topology can't be read: never a kept answer.
        // The topology can't be read: no library link is vouched for (and nothing is asked or kept).
        rig.Finds.Add("genre");
        rig.Library.Setup(l => l.GetVirtualFolders()).Throws(new InvalidOperationException("db"));
        Assert.False(rig.SciFi());
        Assert.False(rig.SciFi());
        Assert.Equal(4, rig.Count);
    }

    [Fact]
    public void TheViewersAuthorityIsPartOfTheKeyAndNoViewerSharesAnother()
    {
        using var rig = new Rig();
        Assert.True(rig.SciFi("r1"));
        // The viewer's policy revision moved (any access-deciding change, as their request read them): read again.
        rig.Finds.Remove("genre");
        Assert.False(rig.SciFi("r2"));
        Assert.Equal(2, rig.Count);
        // Another viewer, even with the same revision text, is never answered from the first viewer's answer.
        var other = new User("other", "default", "default") { Id = Guid.NewGuid() };
        rig.Finds.Add("genre");
        Assert.True(rig.SciFi("r2", other));
        Assert.Equal(3, rig.Count);
        Assert.False(rig.SciFi("r2"));
        Assert.Equal(3, rig.Count);
        // Each query is the viewer's own.
        Assert.Equal(new[] { rig.Viewer.Id, rig.Viewer.Id, other.Id }, rig.Queries.Select(q => q.User!.Id));
    }

    [Theory]
    [InlineData("added")]
    [InlineData("updated")]
    [InlineData("removed")]
    public void AChangeDuringAReadNeverLeavesItsAnswerBehind(string change)
    {
        using var rig = new Rig();
        var once = 0;
        // The read sees the old library; the change lands while it runs: it is read again before anything is published.
        rig.DuringQuery = () => { if (Interlocked.Exchange(ref once, 1) == 0) rig.Raise(change, new Movie { Id = Guid.NewGuid() }); };
        Assert.True(rig.SciFi());
        Assert.Equal(2, rig.Count);
        // The settled read is the one kept.
        Assert.True(rig.SciFi());
        Assert.Equal(2, rig.Count);
        // A library that keeps changing under every read: the answer is withheld (no library link), never published.
        rig.DuringQuery = () => rig.Raise(change, new Movie { Id = Guid.NewGuid() });
        rig.Revision++;
        Assert.False(rig.SciFi());
        Assert.Equal(5, rig.Count);
    }

    [Fact]
    public void ExistenceIsTheViewersOwnIdQueryAndReadsNoItem()
    {
        using var rig = new Rig();
        rig.Finds.Remove("tag");
        var links = rig.For();
        Assert.Equal(rig.Genre, links.Genre("Science Fiction", 878));
        Assert.Equal(rig.Studio, links.Studio("Legendary Pictures", 923, network: false));
        Assert.False(links.Tag("sandworm"));
        Assert.Equal(3, rig.Queries.Count);
        Assert.All(rig.Queries, q =>
        {
            Assert.Same(rig.Viewer, q.User);
            Assert.True(q.Recursive);
            Assert.Equal(1, q.Limit);
            Assert.Equal(new[] { BaseItemKind.Movie, BaseItemKind.Series }, q.IncludeItemTypes);
        });
        Assert.Equal(new[] { rig.Genre }, rig.Queries[0].GenreIds);
        Assert.Equal(new[] { rig.Studio }, rig.Queries[1].StudioIds);
        Assert.Equal(new[] { "sandworm" }, rig.Queries[2].Tags);
        rig.Library.Verify(l => l.GetItemList(It.IsAny<InternalItemsQuery>()), Times.Never);
        // With tag discovery, a tag leads to its row whatever the viewer finds (no query).
        Assert.True(rig.For(discovery: new LinkDiscovery(false, false, true)).Tag("sandworm"));
        Assert.Equal(3, rig.Count);
    }

    [Fact]
    public void APersonsLibraryPageFollowsTheirRecordAndTheViewer()
    {
        using var rig = new Rig();
        var person = new Person { Id = Guid.NewGuid(), Name = "Timothée Chalamet" };
        person.SetProviderId(MetadataProvider.Tmdb, "1190668");
        var open = true;
        rig.Library.Setup(l => l.GetPerson("Timothée Chalamet")).Returns(() => person);
        rig.Library.Setup(l => l.GetItemById<BaseItem>(person.Id, rig.Viewer)).Returns(() => open ? person : null!);
        Assert.Equal(person.Id, rig.For().Person("Timothée Chalamet", 1190668)?.Id);
        rig.Now += TimeSpan.FromMinutes(2);
        open = false;
        Assert.Equal(person.Id, rig.For().Person("Timothée Chalamet", 1190668)?.Id);
        // The viewer can no longer open them: answered again at their next revision, without waiting.
        Assert.Null(rig.For("r2").Person("Timothée Chalamet", 1190668));
        // Their record changed (another TMDB person now): their own page, at once.
        open = true;
        person.SetProviderId(MetadataProvider.Tmdb, "1");
        rig.Raise("updated", person);
        Assert.Null(rig.For().Person("Timothée Chalamet", 1190668));
        rig.Library.Verify(l => l.GetPerson("Timothée Chalamet"), Times.Exactly(2));
    }

    [Fact]
    public void AChangeDuringTheReadWithholdsTheOldPositiveAnswer()
    {
        // Review WPR-3: the last visible title is removed while the read runs; the read's old ids must not be published.
        using var rig = new Rig();
        var once = 0;
        rig.Library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
        {
            var wasVisible = rig.Finds.Contains("genre");
            if (Interlocked.Exchange(ref once, 1) == 0)
            {
                rig.Finds.Remove("genre");
                rig.Raise("removed", new Movie { Id = Guid.NewGuid() });
            }

            return wasVisible ? new List<Guid> { Guid.NewGuid() } : new List<Guid>();
        });
        Assert.False(rig.SciFi());
    }

    [Fact]
    public void ALocationRemovedDuringTheReadWithholdsItsAnswer()
    {
        using var rig = new Rig();
        var once = 0;
        var reads = 0;
        rig.Library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
        {
            reads++;
            var wasVisible = rig.Finds.Contains("genre");
            if (Interlocked.Exchange(ref once, 1) == 0)
            {
                // The library's only location is removed while the read runs: no item event on either host.
                rig.Locations = Array.Empty<string>();
                rig.Finds.Remove("genre");
            }

            return wasVisible ? new List<Guid> { Guid.NewGuid() } : new List<Guid>();
        });
        // The topology read after the query tells: read again, under the new topology.
        Assert.False(rig.SciFi());
        Assert.Equal(2, reads);
    }

    [Fact]
    public void AGenreLosingLibraryAccessChangesTheAuthorityKey()
    {
        using var rig = new Rig();
        rig.Viewer.SetPermission(PermissionKind.EnableAllFolders, true);
        string Authority(User u) => Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserAuthority.Fingerprint(u);
        rig.Library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
            q.User!.HasPermission(PermissionKind.EnableAllFolders) ? new List<Guid> { Guid.NewGuid() } : new List<Guid>());
        Assert.True(rig.SciFi(Authority(rig.Viewer)));
        var next = new User("viewer", "default", "default") { Id = rig.Viewer.Id };
        next.SetPermission(PermissionKind.EnableAllFolders, false);
        Assert.False(rig.SciFi(Authority(next), next));
    }

    [Fact]
    public void ATitleMovedOutOfAndBackIntoReachAnswersAgain()
    {
        using var rig = new Rig();
        Assert.True(rig.SciFi());
        var movie = new Movie { Id = Guid.NewGuid(), Path = "/hidden/movie.mkv" };
        rig.Finds.Remove("genre");
        rig.Raise("updated", movie);
        Assert.False(rig.SciFi());
        movie.Path = "/movies/movie.mkv";
        rig.Finds.Add("genre");
        rig.Raise("updated", movie);
        Assert.True(rig.SciFi());
        Assert.Equal(3, rig.Count);
    }

    [Fact]
    public void ARenamedStudioReplacesTheNameAnswerAtOnce()
    {
        using var rig = new Rig();
        Assert.Equal(rig.Studio, rig.For().Studio("Legendary Pictures", 923, false));
        var renamed = new Studio { Id = rig.Studio, Name = "Renamed" };
        rig.Library.Setup(l => l.GetStudioId("Legendary Pictures")).Returns(Guid.NewGuid());
        rig.Library.Setup(l => l.GetItemById(rig.Studio)).Returns(renamed);
        rig.Raise("updated", renamed);
        Assert.Null(rig.For().Studio("Legendary Pictures", 923, false));
    }

    [Fact]
    public void APersonImageChangeReplacesTheImageTag()
    {
        using var rig = new Rig();
        var person = new Person { Id = Guid.NewGuid(), Name = "Actor" };
        person.SetProviderId(MetadataProvider.Tmdb, "123");
        person.ImageInfos = new[] { new ItemImageInfo { Type = ImageType.Primary, Path = "/actor.jpg" } };
        var tag = "before";
        var images = new Mock<MediaBrowser.Controller.Drawing.IImageProcessor>();
        images.Setup(i => i.GetImageCacheTag(person, It.IsAny<ItemImageInfo>())).Returns(() => tag);
        rig.Library.Setup(l => l.GetPerson("Actor")).Returns(person);
        rig.Library.Setup(l => l.GetItemById<BaseItem>(person.Id, rig.Viewer)).Returns(person);
        using var links = new NativeDetailsLinks(rig.Library.Object, images.Object, () => rig.Revision);
        Assert.Equal("before", links.For(rig.Viewer, "r", Server, LinkDiscovery.None).Person("Actor", 123)?.ImageTag);
        tag = "after";
        rig.Raise("updated", person);
        Assert.Equal("after", links.For(rig.Viewer, "r", Server, LinkDiscovery.None).Person("Actor", 123)?.ImageTag);
    }

    [Fact]
    public void WithoutALibraryRevisionNothingIsKept()
    {
        var library = new Mock<ILibraryManager>();
        var genre = Guid.NewGuid();
        library.Setup(l => l.GetGenreId("Science Fiction")).Returns(genre);
        library.Setup(l => l.GetItemById(genre)).Returns(new Genre { Id = genre });
        library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns(new List<Guid> { Guid.NewGuid() });
        using var links = new NativeDetailsLinks(library.Object);
        var viewer = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        links.For(viewer, "r", Server, LinkDiscovery.None).Genre("Science Fiction", 878);
        links.For(viewer, "r", Server, LinkDiscovery.None).Genre("Science Fiction", 878);
        library.Verify(l => l.GetItemIds(It.IsAny<InternalItemsQuery>()), Times.Exactly(2));
    }

    [Fact]
    public void TheViewerStoreIsBounded()
    {
        using var rig = new Rig();
        for (var i = 0; i < 4100; i++) rig.For().Tag("tag-" + i);
        Assert.InRange(rig.Links.VisibleCount, 1, 4000);
    }

    [Fact]
    public void ItStopsFollowingTheLibraryWhenDisposed()
    {
        var rig = new Rig();
        rig.Dispose();
        rig.Library.VerifyRemove(l => l.ItemAdded -= It.IsAny<EventHandler<ItemChangeEventArgs>>(), Times.Once);
        rig.Library.VerifyRemove(l => l.ItemUpdated -= It.IsAny<EventHandler<ItemChangeEventArgs>>(), Times.Once);
        rig.Library.VerifyRemove(l => l.ItemRemoved -= It.IsAny<EventHandler<ItemChangeEventArgs>>(), Times.Once);
    }
}
#endif
