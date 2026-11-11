using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders;
using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders.Services;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests.Features.DetailsProviders;

/// <summary>
/// mdblist-ratings/{type}/{id} serves every signed-in user's item-details page, but a title not cached yet costs
/// the administrator's MDBList quota. Cached answers stay free; each account gets a bounded share of the lookups
/// that spend quota, so one account cannot use up the day's quota for everyone.
/// </summary>
[Collection("Plugin singleton")]
public class MdblistLookupBudgetTests
{
    private sealed class Lab : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public List<string> Lookups { get; } = new();
        private readonly IntegrationTransport transport;
        private readonly MdblistService service;
        private readonly JeDetailsProvidersController controller;

        public Lab()
        {
            Plugin.Plugin.Configuration.MdblistRatingsEnabled = true;
            Plugin.Plugin.Configuration.MdblistApiKey = "admin-key";
            transport = new IntegrationTransport((request, _) =>
            {
                var path = request.RequestUri!.AbsolutePath;
                if (path == "/user") return Task.FromResult(IntegrationTransport.Response("{\"rate_limit\":100000,\"rate_limit_remaining\":99000}"));
                lock (Lookups) Lookups.Add(path);
                return Task.FromResult(IntegrationTransport.Response("{\"ratings\":[{\"source\":\"imdb\",\"value\":7.1,\"score\":71}]}"));
            });
            service = new MdblistService(transport, Plugin.Core.Paths.Object, Plugin.Core.Logger);
            controller = (JeDetailsProvidersController)ApiAssetTests.Controller(typeof(JeDetailsProvidersController), Plugin.Core, transport, service);
        }

        public async Task<JsonElement> Ask(Guid user, int tmdbId)
        {
            controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([
                new Claim("Jellyfin-UserId", user.ToString()), new Claim(ClaimTypes.Role, "User")], "test"));
            var ok = Assert.IsType<OkObjectResult>(await controller.GetMdblistRatings("movie", tmdbId.ToString(), default));
            return JsonSerializer.Deserialize<JsonElement>(JsonSerializer.Serialize(ok.Value));
        }

        public void Dispose() { service.Dispose(); transport.Dispose(); Plugin.Dispose(); }
    }

    [Fact]
    public async Task OneAccountSpendsOnlyItsShareOfTheQuotaAndCachedAnswersStayFree()
    {
        using var lab = new Lab();
        var script = Guid.NewGuid();
        var viewer = Guid.NewGuid();

        for (var id = 1; id <= MdblistService.UserLookupsPerWindow; id++)
            Assert.True((await lab.Ask(script, id)).GetProperty("Found").GetBoolean());
        Assert.Equal(MdblistService.UserLookupsPerWindow, lab.Lookups.Count);

        // Past its share the account's next new title costs nothing and reads as "not known yet".
        var refused = await lab.Ask(script, 100_001);
        Assert.False(refused.GetProperty("Found").GetBoolean());
        Assert.False(refused.GetProperty("Confirmed").GetBoolean());
        Assert.Equal(MdblistService.UserLookupsPerWindow, lab.Lookups.Count);

        // Titles already looked up are still answered from the cache, for it and for everyone else.
        Assert.True((await lab.Ask(script, 7)).GetProperty("Found").GetBoolean());
        Assert.True((await lab.Ask(viewer, 7)).GetProperty("Found").GetBoolean());
        Assert.Equal(MdblistService.UserLookupsPerWindow, lab.Lookups.Count);

        // Another account viewing a details page still gets its ratings looked up.
        Assert.True((await lab.Ask(viewer, 100_002)).GetProperty("Found").GetBoolean());
        Assert.Equal(MdblistService.UserLookupsPerWindow + 1, lab.Lookups.Count);
    }
}
