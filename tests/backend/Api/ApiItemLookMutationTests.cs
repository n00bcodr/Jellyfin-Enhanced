using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Security.Claims;
using System.Text.Encodings.Web;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Xunit.Abstractions;

namespace JE.Tests;

/// <summary>Real HTTP model binding and body limits at the supported item-look list boundary.</summary>
[Collection("Plugin singleton")]
public class ApiItemLookMutationTests(ITestOutputHelper output)
{
    private sealed class Activator(CoreFixture fixture) : IControllerActivator
    {
        public object Create(ControllerContext context)
        {
            var controller = ApiAssetTests.Controller(fixture);
            controller.ControllerContext = context;
            return controller;
        }
        public void Release(ControllerContext context, object controller) { }
    }

    private sealed class Authentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
        : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
    {
        protected override Task<AuthenticateResult> HandleAuthenticateAsync()
        {
            if (!Request.Headers.ContainsKey("X-Test-Admin")) return Task.FromResult(AuthenticateResult.NoResult());
            var principal = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.Role, "Administrator")], Scheme.Name));
            return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(principal, Scheme.Name)));
        }
    }

    private static TagLookItemOverride Largest(int index)
    {
        static List<TagLayoutGroupSlot> Slots() => TagLayoutRules.DefaultGroupOrder.Select(g => new TagLayoutGroupSlot { Group = g, Slot = "caption" }).ToList();
        static TagGroupCaps Caps() => new() { Quality = 10, Genre = 10, Language = 10, Rating = 10, AgeRating = 10, Status = 10, Awards = 10, Logos = 10, Custom = 10 };
        static TagShapeLook Shape() => new() { Layout = "caption", Density = "compact", TagScale = "largest", TagGap = "default", Slots = Slots(), Caps = Caps() };
        return new TagLookItemOverride
        {
            ItemId = index.ToString("x32"), Layout = "caption", Density = "compact", ColourPreset = new string('a', 64),
            Slots = Slots(), Caps = Caps(), TagScale = "largest", TagGap = "default", EdgeSpacing = "default", Scope = "item", LockedAt = long.MaxValue - index,
            Shapes = new() { Landscape = Shape(), List = Shape() },
        };
    }

    [Fact]
    public async Task FiveHundredLargestLooksCanBeEditedRemovedUndoneExportedAndImportedOverHttp()
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.TagLookItemOverrides = Enumerable.Range(1, 500).Select(Largest).ToList();
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseKestrel().UseUrls("http://127.0.0.1:0");
        builder.Services.AddAuthentication("test").AddScheme<AuthenticationSchemeOptions, Authentication>("test", _ => { });
        builder.Services.AddAuthorization();
        builder.Services.AddControllers().AddApplicationPart(typeof(JellyfinEnhancedController).Assembly);
        builder.Services.AddSingleton<IControllerActivator>(new Activator(fixture.Core));
        await using var app = builder.Build();
        app.UseAuthentication();
        app.UseAuthorization();
        app.MapControllers();
        await app.StartAsync();
        var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
        using var client = new HttpClient { BaseAddress = new Uri(address) };
        client.DefaultRequestHeaders.Add("X-Test-Admin", "1");
        async Task<JsonElement> Patch(object changes)
        {
            var json = JsonSerializer.Serialize(new { Changes = new { TagLookItemOverrides = changes } });
            output.WriteLine($"mutation bytes: {Encoding.UTF8.GetByteCount(json)}");
            using var response = await client.PostAsync("/JellyfinEnhanced/admin/configuration", new StringContent(json, Encoding.UTF8, "application/json"));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            return (await response.Content.ReadFromJsonAsync<JsonElement>()).Clone();
        }
        using var largestExport = await client.GetAsync("/JellyfinEnhanced/admin/media-tags/export");
        var largestDocument = await largestExport.Content.ReadAsStringAsync();
        var largestPatch = JsonSerializer.Serialize(new { Changes = new { TagLookItemOverrides = fixture.Plugin.Configuration.TagLookItemOverrides }, Expected = new { TagLookItemOverrides = fixture.Plugin.Configuration.TagLookItemOverrides } });
        output.WriteLine($"worst-case 500-look export bytes: {Encoding.UTF8.GetByteCount(largestDocument)}");
        output.WriteLine($"worst-case 500-look full patch bytes: {Encoding.UTF8.GetByteCount(largestPatch)}");
        var before = fixture.Plugin.Configuration.TagLookItemOverrides![0];
        var edit = Largest(1); edit.TagScale = "smaller";
        await Patch(new { Set = new[] { edit }, Remove = Array.Empty<string>(), Expected = new Dictionary<string, object?> { [before.ItemId] = before } });
        Assert.Equal(500, fixture.Plugin.Configuration.TagLookItemOverrides!.Count);
        Assert.Equal("smaller", fixture.Plugin.Configuration.TagLookItemOverrides!.Single(e => e.ItemId == edit.ItemId).TagScale);
        var saved = fixture.Plugin.Configuration.TagLookItemOverrides!.Single(e => e.ItemId == edit.ItemId);
        // An unrelated concurrent edit is kept; a conflicting target refuses the whole mutation.
        var other = fixture.Plugin.Configuration.TagLookItemOverrides![1]; other.TagGap = "roomy";
        using (var conflict = await client.PostAsync("/JellyfinEnhanced/admin/configuration", JsonContent.Create(new { Changes = new { TagLookItemOverrides = new { Set = new[] { edit }, Remove = new[] { other.ItemId }, Expected = new Dictionary<string, object?> { [edit.ItemId] = before, [other.ItemId] = null } } } }, options: new JsonSerializerOptions())))
            Assert.True(conflict.StatusCode == HttpStatusCode.Conflict, await conflict.Content.ReadAsStringAsync());
        await Patch(new { Set = Array.Empty<TagLookItemOverride>(), Remove = new[] { edit.ItemId }, Expected = new Dictionary<string, object?> { [edit.ItemId] = saved } });
        Assert.Equal(499, fixture.Plugin.Configuration.TagLookItemOverrides!.Count);
        Assert.Equal("roomy", fixture.Plugin.Configuration.TagLookItemOverrides!.Single(e => e.ItemId == other.ItemId).TagGap);
        await Patch(new { Set = new[] { saved }, Remove = Array.Empty<string>(), Expected = new Dictionary<string, object?> { [edit.ItemId] = null } });
        Assert.Equal(500, fixture.Plugin.Configuration.TagLookItemOverrides!.Count);
        using var export = await client.GetAsync("/JellyfinEnhanced/admin/media-tags/export");
        Assert.Equal(HttpStatusCode.OK, export.StatusCode);
        var document = await export.Content.ReadAsStringAsync();
        output.WriteLine($"500 largest looks export bytes: {Encoding.UTF8.GetByteCount(document)}");
        var original = JsonSerializer.Serialize(fixture.Plugin.Configuration.TagLookItemOverrides);
        var fullPatch = JsonSerializer.Serialize(new { Changes = new { TagLookItemOverrides = fixture.Plugin.Configuration.TagLookItemOverrides }, Expected = new { TagLookItemOverrides = fixture.Plugin.Configuration.TagLookItemOverrides } });
        output.WriteLine($"full list plus Expected bytes: {Encoding.UTF8.GetByteCount(fullPatch)}");
        Assert.True(Encoding.UTF8.GetByteCount(fullPatch) < PluginConfigurationPatch.MaxRequestBytes / 2, "at least 2x headroom for a largest-look replacement with Expected");
        // Import preview and the full-list replacement contract both traverse real HTTP body limits.
        fixture.Plugin.Configuration.TagLookItemOverrides = null;
        using var preview = await client.PostAsync("/JellyfinEnhanced/admin/media-tags/preview", new StringContent(document, Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.OK, preview.StatusCode);
        using var parsed = JsonDocument.Parse(await preview.Content.ReadAsStringAsync());
        var changes = parsed.RootElement.GetProperty("imported");
        using var import = await client.PostAsJsonAsync("/JellyfinEnhanced/admin/configuration", new { Changes = changes });
        Assert.Equal(HttpStatusCode.OK, import.StatusCode);
        Assert.Equal(original, JsonSerializer.Serialize(fixture.Plugin.Configuration.TagLookItemOverrides));
        // A two-list import replacement also fits, even when no values differ.
        using var replace = await client.PostAsync("/JellyfinEnhanced/admin/configuration", new StringContent(fullPatch, Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.OK, replace.StatusCode);
        await app.StopAsync();
    }
    [Theory]
    [InlineData("queued-add")]
    [InlineData("queued-edit")]
    [InlineData("queued-remove")]
    [InlineData("queued-undo")]
    [InlineData("immediate-undo")]
    [InlineData("immediate-undo-with-field")]
    [InlineData("already-absent")]
    [InlineData("import-replace")]
    public async Task ProductionPageSavesThroughRealHttpValidator(string scenario)
    {
        using var fixture = new ApiPluginFixture();
        var first = Largest(1); first.LockedAt = 1;
        fixture.Plugin.Configuration.TagLookItemOverrides = new() { first };
        if (scenario == "queued-edit") { var second = Largest(2); second.LockedAt = 2; fixture.Plugin.Configuration.TagLookItemOverrides.Add(second); }
        if (scenario == "import-replace") fixture.Plugin.Configuration.TagLookItemOverrides = Enumerable.Range(1, 500).Select(i => { var entry = Largest(i); entry.LockedAt = 1000 - i; return entry; }).ToList();
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseKestrel().UseUrls("http://127.0.0.1:0");
        builder.Services.AddAuthentication("test").AddScheme<AuthenticationSchemeOptions, Authentication>("test", _ => { });
        builder.Services.AddAuthorization();
        builder.Services.AddControllers().AddApplicationPart(typeof(JellyfinEnhancedController).Assembly);
        builder.Services.AddSingleton<IControllerActivator>(new Activator(fixture.Core));
        await using var app = builder.Build();
        app.UseAuthentication();
        app.UseAuthorization();
        app.MapControllers();
        app.MapGet("/test/configuration", () => Results.Json(fixture.Plugin.Configuration, Jellyfin.Extensions.Json.JsonDefaults.Options));
        await app.StartAsync();
        try
        {
            var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
            var root = new DirectoryInfo(AppContext.BaseDirectory);
            while (root != null && !File.Exists(Path.Combine(root.FullName, "tests/frontend/helpers/item-look-page-http.mjs"))) root = root.Parent;
            Assert.NotNull(root);
            var start = new System.Diagnostics.ProcessStartInfo("node") { WorkingDirectory = root.FullName, RedirectStandardOutput = true, RedirectStandardError = true };
            start.ArgumentList.Add("tests/frontend/helpers/item-look-page-http.mjs");
            start.ArgumentList.Add(address);
            start.ArgumentList.Add(scenario);
            using var process = System.Diagnostics.Process.Start(start)!;
            var stdout = process.StandardOutput.ReadToEndAsync();
            var stderr = process.StandardError.ReadToEndAsync();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(60));
            try { await process.WaitForExitAsync(timeout.Token); }
            catch (OperationCanceledException) { process.Kill(entireProcessTree: true); throw; }
            var log = await stdout + await stderr;
            output.WriteLine(log);
            Assert.True(process.ExitCode == 0, log);
        }
        finally { await app.StopAsync(); }
    }

    [Fact]
    public void ValidatedEmptyMutationIsANoWriteSuccessAndStillValidatesItsShape()
    {
        using var fixture = new ApiPluginFixture();
        var before = fixture.Plugin.Configuration;
        var empty = JsonSerializer.SerializeToElement(new { Set = Array.Empty<object>(), Remove = Array.Empty<string>(), Expected = new { } });
        var changes = new Dictionary<string, JsonElement> { ["TagLookItemOverrides"] = empty };
        var result = PluginConfigurationPatch.Apply(fixture.Plugin, changes, null, MediaTagsPageFields.Allowed);
        Assert.Null(result.Error);
        Assert.Empty(result.Conflicts);
        Assert.True(result.Values.ContainsKey("TagLookItemOverrides"));
        Assert.Same(before, fixture.Plugin.Configuration);
        changes["QualityTagsEnabled"] = JsonSerializer.SerializeToElement(!before.QualityTagsEnabled);
        result = PluginConfigurationPatch.Apply(fixture.Plugin, changes, null, MediaTagsPageFields.Allowed);
        Assert.Null(result.Error);
        Assert.Equal(!before.QualityTagsEnabled, fixture.Plugin.Configuration.QualityTagsEnabled);
        foreach (var invalid in new[] { "{}", "{\"Set\":[],\"Remove\":[],\"Expected\":{\"extra\":null}}", "{\"Set\":null,\"Remove\":[],\"Expected\":{}}" })
        {
            changes = new() { ["TagLookItemOverrides"] = JsonSerializer.Deserialize<JsonElement>(invalid) };
            Assert.NotNull(PluginConfigurationPatch.Apply(fixture.Plugin, changes, null, MediaTagsPageFields.Allowed).Error);
        }
    }

}
