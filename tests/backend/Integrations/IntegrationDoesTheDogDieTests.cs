using Jellyfin.Plugin.JellyfinEnhanced.Services;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class IntegrationDoesTheDogDieTests
{
    [Fact]
    public async Task ACancelledLookupIsNotCachedForTheNextViewer()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.DoesTheDogDieApiKey = "key";
        using var viewer = new CancellationTokenSource();
        using var transport = new IntegrationTransport(async (_, ct) =>
        {
            // The first viewer leaves mid-lookup.
            if (!viewer.IsCancellationRequested)
            {
                viewer.Cancel();
                await Task.Delay(Timeout.Infinite, ct);
            }
            return IntegrationTransport.Response("[]");
        });
        using var service = new DoesTheDogDieService(transport, f.Core.Paths.Object, f.Core.Logger);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => service.GetWarningsAsync("movie", "1", viewer.Token));

        Assert.True((await service.GetWarningsAsync("movie", "1", default)).Confirmed);
        Assert.Equal(2, transport.Calls);
    }
}
