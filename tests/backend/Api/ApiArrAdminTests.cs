using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Secrets;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

/// <summary>
/// Instance registry v2 and the admin diagnostics routes: admin-only, behind the master switch,
/// no credential in any response, masked keys only usable against their own server.
/// </summary>
[Collection("Plugin singleton")]
public class ApiArrAdminTests
{
    private const string RadarrKey = "RADARR-KEY-0123456789abcdef0123";
    private const string Radarr4kKey = "RADARR4K-KEY-0123456789abcdef01";
    private const string SonarrKey = "SONARR-KEY-0123456789abcdef0123";

    private sealed class Rig : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public List<string> Calls { get; } = new();
        public IntegrationTransport Transport { get; }
        public ArrClientFactory Factory { get; }
        public ArrAdminController Controller { get; }
        public string RadarrId { get; }
        public string Radarr4kId { get; }
        public string SonarrId { get; }
        public Rig()
        {
            var config = Plugin.Plugin.Configuration;
            config.ArrIntegrationEnabled = true;
            config.RadarrInstances = JsonSerializer.Serialize(new object[]
            {
                new { Name = "Movies", Url = "http://radarr.lan:7878", ApiKey = RadarrKey },
                new { Name = "Movies 4K", Url = "http://radarr4k.lan:7878", ApiKey = Radarr4kKey, Role = "4k", IsDefault = true },
                new { Name = "Old", Url = "http://old.lan:7878", ApiKey = RadarrKey, Role = "4k", Retired = true },
            });
            config.SonarrInstances = JsonSerializer.Serialize(new[] { new { Name = "TV", Url = "http://sonarr.lan:8989", ApiKey = SonarrKey } });
            SecretsMigration.MigrateStored(config, Plugin.Plugin.Secrets);
            var registry = new ArrInstanceRegistry();
            RadarrId = registry.All().Single(c => c.Name == "Movies").Id;
            Radarr4kId = registry.All().Single(c => c.Name == "Movies 4K").Id;
            SonarrId = registry.All().Single(c => c.Kind == ArrKind.Sonarr).Id;
            Transport = new IntegrationTransport((request, _) =>
            {
                lock (Calls) Calls.Add(request.RequestUri!.Host + request.RequestUri.AbsolutePath + " key=" + request.Headers.GetValues("X-Api-Key").Single());
                var app = request.RequestUri!.Host.StartsWith("sonarr") ? "Sonarr" : "Radarr";
                if (request.RequestUri.AbsolutePath.EndsWith("/health"))
                    return Task.FromResult(IntegrationTransport.Response("""[{"source":"IndexerRssCheck","type":"warning","message":"No indexers available with RSS sync enabled","wikiUrl":"https://wiki"}]"""));
                return Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new { appName = app, instanceName = app, version = app == "Sonarr" ? "4.0.20.3014" : "6.0.4.10291" })));
            });
            Factory = new ArrClientFactory(Transport, registry);
            Controller = new ArrAdminController(Factory, new ArrAuditLog(Path.Combine(Plugin.Core.Root, ArrAuditLog.FileName), 1024 * 1024, 2), Mock.Of<IUserManager>(), Plugin.Core.Logger)
            {
                ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
            };
            SetUser(admin: true);
        }
        public void SetUser(bool admin) => Controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([
            new Claim("Jellyfin-UserId", Guid.NewGuid().ToString()), new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test"));
        public void Dispose() { Transport.Dispose(); Plugin.Dispose(); }
    }

    private static string Json(IActionResult result) => JsonSerializer.Serialize(Assert.IsType<OkObjectResult>(result).Value);

    [Fact]
    public void TheRegistryIsTypedAndRoutesWithoutCrossRoleFallback()
    {
        using var rig = new Rig();
        var registry = rig.Factory.Registry;
        Assert.Equal(4, registry.All().Count);
        Assert.Equal(rig.RadarrId, registry.DefaultFor(ArrKind.Radarr, ArrInstanceRole.Standard)!.Id);
        Assert.Equal(rig.Radarr4kId, registry.DefaultFor(ArrKind.Radarr, "4K")!.Id);
        Assert.Equal(rig.SonarrId, registry.DefaultFor(ArrKind.Sonarr, ArrInstanceRole.Anime)!.Id);   // no anime instance: standard
        Assert.Null(registry.DefaultFor(ArrKind.Sonarr, ArrInstanceRole.FourK));                     // never the standard one
        Assert.Equal(2, registry.Usable(ArrKind.Radarr).Count);                                       // the retired one is out
        Assert.Same(registry.All(), registry.All());                                                  // parsed once per config change

        // Disabling the 4K instance leaves 4K with nothing rather than falling back to standard.
        var rows = ArrRegistryMigration.Parse(rig.Plugin.Plugin.Configuration.RadarrInstances)!;
        rows.Single(r => r.Id == rig.Radarr4kId).Enabled = false;
        rig.Plugin.Plugin.Configuration.RadarrInstances = ArrRegistryMigration.Serialize(rows);
        Assert.Null(registry.DefaultFor(ArrKind.Radarr, ArrInstanceRole.FourK));
    }

    [Fact]
    public void NormalisationKeepsOneDefaultPerRoleAndCleansLists()
    {
        var rows = ArrRegistryMigration.Normalize(
        [
            new ArrInstance { Url = " http://a/ ", Role = "4K", IsDefault = true, LinkedLibraryIds = ["ABC", "abc", " "], PathMappings = [new() { ArrPath = "/m", JellyfinPath = "/media/m" }, new() { ArrPath = "", JellyfinPath = "/x" }] },
            new ArrInstance { Url = "http://b", Role = "4k", IsDefault = true },
            new ArrInstance { Url = "", Name = "dropped" },
            new ArrInstance { Url = "http://c", Role = "weird", Retired = true, IsDefault = true, LiveUpdates = "sometimes", Webhook = "yes" },
        ], null, "Radarr");
        Assert.Equal(3, rows.Count);
        Assert.Equal(["4k", "4k", "standard"], rows.Select(r => r.Role));
        Assert.Equal([true, false, false], rows.Select(r => r.IsDefault));
        Assert.Equal(["abc"], rows[0].LinkedLibraryIds);
        Assert.Single(rows[0].PathMappings);
        Assert.Equal("Radarr", rows[1].Name);
        Assert.Equal(("auto", "off"), (rows[2].LiveUpdates, rows[2].Webhook));
        Assert.Equal(3, rows.Select(r => r.Id).Distinct().Count());
    }

    [Fact]
    public void InstancesListCarriesNoCredential()
    {
        using var rig = new Rig();
        var json = Json(rig.Controller.GetInstances());
        Assert.DoesNotContain("KEY-0123456789", json);
        Assert.DoesNotContain(SecretValue.MaskPrefix, json);
        using var doc = JsonDocument.Parse(json);
        var first = doc.RootElement.GetProperty("instances")[0];
        Assert.True(first.GetProperty("key").GetProperty("set").GetBoolean());
        Assert.Equal("ends " + SonarrKey[^4..], first.GetProperty("key").GetProperty("hint").GetString());
        Assert.Equal(rig.Radarr4kId, doc.RootElement.GetProperty("defaults").GetProperty("radarr4k").GetString());
    }

    [Fact]
    public async Task RoutesAreAdminOnlyAndBehindTheMasterSwitch()
    {
        using var rig = new Rig();
        rig.SetUser(admin: false);
        Assert.IsType<ForbidResult>(rig.Controller.GetInstances());
        Assert.IsType<ForbidResult>(await rig.Controller.TestInstance(rig.RadarrId, default));
        Assert.IsType<ForbidResult>(await rig.Controller.TestValues(new ArrTestRequest { Kind = "radarr", Url = "http://radarr.lan:7878", ApiKey = "x" }, default));
        Assert.IsType<ForbidResult>(rig.Controller.GetAudit());
        Assert.IsType<ForbidResult>(rig.Controller.RollbackSecrets(new SecretsRollbackRequest { Confirm = ArrAdminController.RollbackConfirmation }));
        rig.SetUser(admin: true);
        rig.Plugin.Plugin.Configuration.ArrIntegrationEnabled = false;
        Assert.IsType<NotFoundObjectResult>(rig.Controller.GetInstances());
        Assert.IsType<NotFoundObjectResult>(await rig.Controller.TestInstance(rig.RadarrId, default));
        Assert.Empty(rig.Calls);
    }

    [Fact]
    public async Task TestingASavedInstanceUsesItsStoredKeyAndReportsVersionAndHealth()
    {
        using var rig = new Rig();
        var json = Json(await rig.Controller.TestInstance(rig.Radarr4kId, default));
        Assert.Equal(["radarr4k.lan/api/v3/system/status key=" + Radarr4kKey, "radarr4k.lan/api/v3/health key=" + Radarr4kKey], rig.Calls);
        Assert.DoesNotContain(Radarr4kKey, json);
        using var doc = JsonDocument.Parse(json);
        Assert.True(doc.RootElement.GetProperty("ok").GetBoolean());
        Assert.Equal("6.0.4.10291", doc.RootElement.GetProperty("version").GetString());
        Assert.True(doc.RootElement.GetProperty("features").GetProperty("strictTagLabels").GetBoolean());
        Assert.Equal("warning", doc.RootElement.GetProperty("health")[0].GetProperty("type").GetString());
        Assert.IsType<NotFoundObjectResult>(await rig.Controller.TestInstance(Guid.NewGuid().ToString(), default));
    }

    [Fact]
    public async Task AMaskedKeyIsOnlyTestedAgainstItsOwnServer()
    {
        using var rig = new Rig();
        var mask = SecretValue.Mask(RadarrKey);
        var elsewhere = await rig.Controller.TestValues(new ArrTestRequest { Url = "http://attacker.example:7878", ApiKey = mask, InstanceId = rig.RadarrId }, default);
        Assert.Contains("key_not_for_this_url", JsonSerializer.Serialize(Assert.IsType<BadRequestObjectResult>(elsewhere).Value));
        var blank = await rig.Controller.TestValues(new ArrTestRequest { Url = "http://attacker.example:7878", ApiKey = "", InstanceId = rig.RadarrId }, default);
        Assert.IsType<BadRequestObjectResult>(blank);
        Assert.Empty(rig.Calls);

        Json(await rig.Controller.TestValues(new ArrTestRequest { Url = "http://radarr.lan:7878/", ApiKey = mask, InstanceId = rig.RadarrId }, default));
        Assert.Contains("radarr.lan/api/v3/system/status key=" + RadarrKey, rig.Calls);
        rig.Calls.Clear();
        // A typed key may be tested anywhere allowed: it came from the admin, not from storage.
        Json(await rig.Controller.TestValues(new ArrTestRequest { Kind = "sonarr", Url = "http://sonarr.lan:8989", ApiKey = "typed-key" }, default));
        Assert.Contains("sonarr.lan/api/v3/system/status key=typed-key", rig.Calls);
        Assert.IsType<BadRequestObjectResult>(await rig.Controller.TestValues(new ArrTestRequest { Kind = "radarr", Url = "http://169.254.169.254", ApiKey = "k" }, default));
        Assert.IsType<BadRequestObjectResult>(await rig.Controller.TestValues(new ArrTestRequest { Kind = "lidarr", Url = "http://x", ApiKey = "k" }, default));
    }

    [Fact]
    public async Task TheLegacyValidateRouteChecksTheAppAndResolvesMasksForTheSavedUrlOnly()
    {
        using var rig = new Rig();
        var users = Mock.Of<IUserManager>();
        var controller = ApiAssetTests.Controller(rig.Plugin.Core, rig.Transport, users, rig.Factory);
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.Role, "Administrator")], "test"));
        var mask = SecretValue.Mask(SonarrKey);

        // A Sonarr slot pointed at a Radarr: used to pass on any 200.
        var wrong = await controller.ValidateSonarr("http://radarr.lan:7878", "typed", null);
        Assert.Equal(502, Assert.IsType<ObjectResult>(wrong).StatusCode);
        Assert.Contains("WrongApp", JsonSerializer.Serialize(((ObjectResult)wrong).Value));

        var moved = await controller.ValidateSonarr("http://elsewhere.lan:8989", mask, rig.SonarrId);
        Assert.Contains("KeyNotForThisUrl", JsonSerializer.Serialize(Assert.IsType<BadRequestObjectResult>(moved).Value));

        var saved = await controller.ValidateSonarr("http://sonarr.lan:8989", mask, rig.SonarrId);
        Assert.IsType<OkObjectResult>(saved);
        Assert.Contains("sonarr.lan/api/v3/system/status key=" + SonarrKey, rig.Calls);

        // What the config page's Test button sends (a header can't carry the bullet mask).
        rig.Calls.Clear();
        Assert.IsType<OkObjectResult>(await controller.ValidateSonarr("http://sonarr.lan:8989", SecretValue.SavedToken, rig.SonarrId));
        Assert.Contains("sonarr.lan/api/v3/system/status key=" + SonarrKey, rig.Calls);
        var movedWire = await controller.ValidateSonarr("http://elsewhere.lan:8989", SecretValue.SavedToken, rig.SonarrId);
        Assert.Contains("KeyNotForThisUrl", JsonSerializer.Serialize(Assert.IsType<BadRequestObjectResult>(movedWire).Value));
    }

    [Fact]
    public void RollbackNeedsTheConfirmationPhraseAndRestoresPlainValues()
    {
        using var rig = new Rig();
        Assert.IsType<BadRequestObjectResult>(rig.Controller.RollbackSecrets(new SecretsRollbackRequest { Confirm = "yes" }));
        var json = Json(rig.Controller.RollbackSecrets(new SecretsRollbackRequest { Confirm = ArrAdminController.RollbackConfirmation }));
        Assert.Contains("\"restored\":4", json);
        Assert.Contains(RadarrKey, rig.Plugin.Plugin.Configuration.RadarrInstances);
        Assert.Equal(SonarrKey, rig.Plugin.Plugin.Configuration.SonarrApiKey);
        // Starting this version again moves them straight back out.
        SecretsMigration.MigrateStored(rig.Plugin.Plugin.Configuration, rig.Plugin.Plugin.Secrets);
        Assert.DoesNotContain(RadarrKey, rig.Plugin.Plugin.Configuration.RadarrInstances);
        Assert.Equal(RadarrKey, rig.Plugin.Plugin.Configuration.GetRadarrInstances()[0].ApiKey);
    }
}
