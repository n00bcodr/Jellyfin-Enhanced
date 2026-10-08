using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Library;
using Moq;

namespace JE.Tests;

public class IntegrationLifecycleTests
{
    [Fact]
    public void RepeatedScanBridgeInitializationAndDisposalDoNotDuplicateSubscriptions()
    {
        using var env = new IntegrationEnvironment();
        using var transport = new IntegrationTransport((_, _) => throw new InvalidOperationException("No outbound calls expected"));
        var library = new Mock<ILibraryManager>();
        var service = new SeerrScanTriggerService(library.Object, transport, env.Logger);
        service.Initialize();
        service.Initialize();
        service.Dispose();
        service.Dispose();
        library.VerifyAdd(l => l.ItemAdded += It.IsAny<EventHandler<ItemChangeEventArgs>>(), Times.Once);
        library.VerifyRemove(l => l.ItemAdded -= It.IsAny<EventHandler<ItemChangeEventArgs>>(), Times.Once);
        Assert.Equal(0, transport.Calls);
    }
}
