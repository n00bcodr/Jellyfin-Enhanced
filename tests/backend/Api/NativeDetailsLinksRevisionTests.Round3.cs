// Review round 3 (WPR2-2, WPR2-3 and the passing round-2 guards): reviewer probes ported.
#if JF12
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Moq;

namespace JE.Tests;

public partial class NativeDetailsLinksRevisionTests
{
    [Fact]
    public void TwoCrossingChangesNeedAThirdSettledRead()
    {
        using var rig = new Rig();
        var reads = 0;
        rig.Library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns(() => {
            reads++;
            if (reads <= 2) rig.Raise("updated", new Movie { Id = Guid.NewGuid() });
            return reads <= 2 ? new List<Guid> { Guid.NewGuid() } : new List<Guid>();
        });
        Assert.Null(rig.For().Genre("Science Fiction", 878));
        Assert.Equal(3, reads);
        Assert.Null(rig.For().Genre("Science Fiction", 878));
        Assert.Equal(3, reads);
    }

    [Fact]
    public void ChurnUsesDiscoveryOrOmitsTheLinkThenRecovers()
    {
        using var rig = new Rig();
        rig.DuringQuery = () => rig.Raise("updated", new Movie { Id = Guid.NewGuid() });
        Assert.Null(rig.For().Genre("Science Fiction", 878));
        Assert.Equal(3, rig.Count);
        var discovery = rig.For(discovery: new LinkDiscovery(true, true, true));
        Assert.Equal(SyntheticId.Genre(878).ToGuid(Server), discovery.Genre("Science Fiction", 878));
        Assert.Equal(SyntheticId.Studio(923).ToGuid(Server), discovery.Studio("Legendary Pictures", 923, false));
        Assert.True(discovery.Tag("sandworm"));
        Assert.Equal(9, rig.Count);
        rig.DuringQuery = null;
        Assert.True(rig.SciFi());
        Assert.Equal(10, rig.Count);
    }

    [Fact]
    public void AChangeInsideTheFinalTopologyReadDoesNotPublishOldIds()
    {
        using var rig = new Rig();
        var topologyReads = 0;
        rig.Library.Setup(l => l.GetVirtualFolders()).Returns(() => {
            if (++topologyReads == 2)
            {
                // A second library read is part of validation. A change lands during it, after Marks() was compared.
                rig.Finds.Remove("genre");
                rig.Raise("removed", new Movie { Id = Guid.NewGuid() });
            }
            return new List<VirtualFolderInfo> { new() { ItemId = "movies", Locations = rig.Locations } };
        });
        var crossing = rig.SciFi();
        Assert.False(rig.SciFi());
        Assert.False(crossing);
    }

    [Fact]
    public void ASecondNameOnTheSamePageChecksTheLiveTopologyOnACacheHit()
    {
        using var rig = new Rig();
        Assert.True(rig.SciFi());
        Assert.Equal(rig.Studio, rig.For().Studio("Legendary Pictures", 923, false));
        var page = rig.For();
        Assert.Equal(rig.Genre, page.Genre("Science Fiction", 878));
        rig.Locations = Array.Empty<string>();
        rig.Finds.Clear();
        // No item event is emitted for a library-location edit. This is the same projection, next name.
        var stale = page.Studio("Legendary Pictures", 923, false);
        Assert.Null(rig.For().Studio("Legendary Pictures", 923, false));
        Assert.Null(stale);
    }
}
#endif
