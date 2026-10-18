using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Moq;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

// The shared-service adapter's pin contract must survive a host returning expanded presentation-group results.
public class ListsEditionAvailabilityTests
{
    [Fact]
    public void APinnedSeriesDoesNotBorrowItsGroupedSiblingsSource()
    {
        var viewer = FakeListHost.MakeUser("viewer");
        var hd = Guid.NewGuid();
        var uhd = Guid.NewGuid();
        var episode = Guid.NewGuid();
        var host = new Mock<IListHost>();
        host.Setup(h => h.FindSeries(800, null, null, viewer)).Returns(new[] { hd, uhd });
        host.Setup(h => h.CanAccessItem(It.IsAny<Guid>(), viewer)).Returns(true);
        host.Setup(h => h.GetEpisodes(It.IsAny<Guid>(), null, viewer))
            .Returns(new[] { new LibraryEpisode(episode, uhd, 1, 1, null) });
        host.Setup(h => h.GetMediaSources(episode))
            .Returns(new[] { new ListMediaSource(episode, episode.ToString("N"), 3840, 2160, true) });
        var editions = new ListEditionAvailability(host.Object);
        var scope = Ph("{\"kind\":\"series\",\"tmdbId\":800,\"title\":\"Show\",\"edition\":\"4k\"}");

        Assert.Empty(editions.Resolve(scope, new[] { viewer }, pinnedItemId: hd).Sources);
        Assert.Equal(episode, Assert.Single(editions.Resolve(scope, new[] { viewer }, pinnedItemId: uhd).Sources).ItemId);
        Assert.Contains(editions.Resolve(scope, new[] { viewer }).Sources, source => source.ItemId == episode);
    }
}
