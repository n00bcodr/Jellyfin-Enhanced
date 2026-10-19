using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Home;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class HomeSourceArrivalTests
{
    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task HomeEventWorkerPreservesSourceObservationAndNewBadge(bool episode, bool fourK)
    {
        using var w = new StampWorld();
        var key = episode ? StampWorld.Show(78874) : StampWorld.Movie(603);
        var id = Guid.NewGuid();
        var created = DateTimeOffset.FromUnixTimeMilliseconds(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()).UtcDateTime.AddSeconds(-2);
        var observed = created.AddSeconds(2);
        var user = Guid.NewGuid();
        w.Interests.Add(key, StampWorld.Interest(user, created.AddDays(-1), fourKOnly: fourK, allSeasons: true));
        var source = new StampSource("first", "/first.mkv", fourK ? 3840 : 1920, fourK ? 2160 : 1080, created);
        var item = w.Library.Put(new StampItem { Id = id, Kind = episode ? "episode" : "movie", Keys = new[] { key },
            Season = episode ? 1 : null, Episode = episode ? 2 : null, DateCreated = created,
            Width = source.Width, Height = source.Height, Sources = new[] { source } });
        var library = new Mock<ILibraryManager>();
        BaseItem native;
        if (episode)
        {
            var series = new Series { Id = Guid.NewGuid() };
            series.SetProviderId(MetadataProvider.Tvdb, "78874");
            library.Setup(l => l.GetItemById(series.Id)).Returns(series);
            native = new Episode { SeriesId = series.Id, ParentIndexNumber = 1, IndexNumber = 2 };
        }
        else
        {
            native = new Movie();
            native.SetProviderId(MetadataProvider.Tmdb, "603");
        }
        native.Id = id;
        native.DateCreated = created;
        library.Setup(l => l.GetItemById(id)).Returns(native);
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new List<BaseItem>());
        w.Store.ObserveSources(new[] { item }, observed, w.Db.Generation);
        using var home = new HomeArrivals(w.Db, library.Object, null, () => true, w.Library);
        var previousLibrary = BaseItem.LibraryManager;
        BaseItem.LibraryManager = library.Object;
        await home.StartAsync(default);
        try
        {
            library.Raise(l => l.ItemAdded += null, library.Object, new ItemChangeEventArgs { Item = native });
            var deadline = DateTime.UtcNow.AddSeconds(5);
            while (home.FirstAt(episode ? key + ":s1:e2" : key.ToString()) == null && DateTime.UtcNow < deadline) await Task.Delay(10);
            Assert.Equal(observed, home.FirstAt(episode ? key + ":s1:e2" : key.ToString()));
            w.Feeder.Judge(id, observed.AddMinutes(2));
            Assert.Equal(AcquisitionStampKinds.New, Assert.Single(w.Store.FactsFor(id)).Kind);
            Assert.Equal(observed, w.Store.FirstContentArrival(AcquisitionStampStore.PartKeys(item)));
            // The opposite edition arrives later; its inherited item date cannot create another New.
            var later = observed.AddMinutes(3);
            var alternate = new StampSource("second", "/second.mkv", fourK ? 1920 : 3840, fourK ? 1080 : 2160, created);
            var updated = w.Library.Put(item with { Sources = new[] { source, alternate } });
            w.Store.ObserveSources(new[] { updated }, later, w.Db.Generation);
            library.Raise(l => l.ItemUpdated += null, library.Object, new ItemChangeEventArgs { Item = native });
            deadline = DateTime.UtcNow.AddSeconds(5);
            while (home.EditionAt(episode ? key + ":s1:e2" : key.ToString(), !fourK) == null && DateTime.UtcNow < deadline) await Task.Delay(10);
            Assert.Equal(later, home.EditionAt(episode ? key + ":s1:e2" : key.ToString(), !fourK));
            Assert.Equal(observed, home.FirstAt(episode ? key + ":s1:e2" : key.ToString()));
            w.Feeder.Judge(id, later.AddMinutes(2));
            Assert.Equal(fourK ? AcquisitionStampKinds.New : AcquisitionStampKinds.Upgraded, Assert.Single(w.Store.FactsFor(id)).Kind);
        }
        finally { await home.StopAsync(default); BaseItem.LibraryManager = previousLibrary; }
    }
}
