using Microsoft.AspNetCore.Mvc;
using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders;
using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders.Services;

namespace JE.Tests.Features.DetailsProviders;

[Collection("Plugin singleton")]
public class ApiAwardsTests
{
    [Fact]
    public async Task AnOverlongTmdbIdIsRefusedWithoutALookup()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.ShowAwards = true;
        using var env = new IntegrationEnvironment();
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("{\"results\":{\"bindings\":[]}}")));
        using var awards = new WikidataAwardsService(transport, env.Paths.Object, env.Logger);
        var controller = (JeDetailsProvidersController)ApiAssetTests.Controller(typeof(JeDetailsProvidersController), f.Core, awards);

        Assert.IsType<BadRequestObjectResult>(await controller.GetAwards("movie", new string('7', 11), default));
        Assert.Equal(0, transport.Calls);
        Assert.IsType<OkObjectResult>(await controller.GetAwards("movie", "1234567890", default));
        Assert.Equal(1, transport.Calls);
    }
}
