using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Platform;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Platform.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Assets;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Maintenance;
using Jellyfin.Plugin.JellyfinEnhanced.Transport;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

// Upstream abcaa16d: component groups (js/component-groups.json), the g parameter of bundle.js and bundle.js.map, and
// the bootstrap's group list. Upstream's ApiAssetTests and ApiBundleGroupTests cases, on this tree's served bundle
// (minified twins, parenthesized module functions, embedded TypeScript maps).
[Collection("Plugin singleton")]
public class ApiBundleGroupTests
{
    [Fact]
    public void ComponentGroupsPartitionTheManifestAndKeepItsOrder()
    {
        var manifest = ClientScriptBundle.GetComponentScripts();
        var groups = ClientScriptBundle.GetComponentGroups();
        Assert.Equal(ClientScriptBundle.CoreGroupId, groups[0].Id);
        Assert.NotEmpty(groups[0].Scripts);
        Assert.Equal(groups.Count, groups.Select(g => g.Id).Distinct().Count());
        // Every manifest module is in exactly one group.
        Assert.Equal(manifest.OrderBy(p => p, StringComparer.Ordinal), groups.SelectMany(g => g.Scripts).OrderBy(p => p, StringComparer.Ordinal));
        var position = manifest.Select((path, index) => (path, index)).ToDictionary(x => x.path, x => x.index);
        var earlier = new HashSet<string>();
        foreach (var group in groups)
        {
            // Inside a group, modules run in manifest order; "after" names earlier groups only.
            Assert.Equal(group.Scripts.OrderBy(p => position[p]), group.Scripts);
            Assert.All(group.After, id => Assert.Contains(id, earlier));
            earlier.Add(group.Id);
        }
    }

    [Theory]
    [InlineData("""{"groups":[{"id":"a","modules":["x.js"]},{"id":"a","modules":["y.js"]}]}""")] // repeated id
    [InlineData("""{"groups":[{"id":"core","modules":["x.js"]}]}""")] // the implicit group cannot be listed
    [InlineData("""{"groups":[{"id":"Bad Id","modules":["x.js"]}]}""")]
    [InlineData("""{"groups":[{"id":"a","modules":["missing.js"]}]}""")] // not in the manifest
    [InlineData("""{"groups":[{"id":"a","modules":["x.js"]},{"id":"b","modules":["x.js"]}]}""")] // in two groups
    [InlineData("""{"groups":[{"id":"a","after":["b"],"modules":["x.js"]},{"id":"b","modules":["y.js"]}]}""")] // after a later group
    [InlineData("""{"groups":[{"id":"a","after":["a"],"modules":["x.js"]}]}""")]
    [InlineData("""{"groups":[{"id":"a","modules":[]}]}""")]
    [InlineData("""{"groups":[{"id":"a"}]}""")]
    [InlineData("""{"groups":{}}""")]
    [InlineData("""[]""")]
    public void InvalidComponentGroupFilesAreRejected(string json)
    {
        using var document = JsonDocument.Parse(json);
        Assert.Throws<InvalidOperationException>(() => ClientScriptBundle.ResolveGroups(new[] { "x.js", "y.js", "z.js" }, document.RootElement));
    }

    [Fact]
    public void ComponentGroupsResolveInManifestOrderWithTheRestInCore()
    {
        using var document = JsonDocument.Parse("""{"groups":[{"id":"late","modules":["z.js","x.js"]},{"id":"more","after":["late","core"],"modules":["w.js"]}]}""");
        var groups = ClientScriptBundle.ResolveGroups(new[] { "w.js", "x.js", "y.js", "z.js" }, document.RootElement);
        Assert.Equal(new[] { "core", "late", "more" }, groups.Select(g => g.Id));
        Assert.Equal(new[] { "y.js" }, groups[0].Scripts);
        Assert.Equal(new[] { "x.js", "z.js" }, groups[1].Scripts);
        Assert.Equal(new[] { "late" }, groups[2].After);
    }

    [Fact]
    public void GroupBundleRequestsAcceptOnlyKnownDistinctGroupsAndServeThemInFileOrder()
    {
        var ids = ClientScriptBundle.GetComponentGroups().Select(g => g.Id).ToArray();
        Assert.True(ids.Length > 1, "js/component-groups.json defines no groups");
        Assert.Equal(new[] { "core" }, ClientScriptBundle.ParseGroupRequest("core"));
        Assert.Equal(new[] { "core", ids[1] }, ClientScriptBundle.ParseGroupRequest($"{ids[1]},core"));
        Assert.Equal(ids, ClientScriptBundle.ParseGroupRequest(string.Join(',', ids.Reverse())));
        foreach (var bad in new string?[] { null, "", ",", "core,", "core,core", "nope", "core,nope", "CORE", " core", "core;x", "../core", string.Join(',', Enumerable.Repeat("core", ClientScriptBundle.MaxGroupsPerRequest + 1)) })
        {
            Assert.Null(ClientScriptBundle.ParseGroupRequest(bad));
        }
    }

    [Fact]
    public void GroupBundleDefinesEachGroupAndItsSourceMapPointsAtExactModuleLines()
    {
        using var fixture = new CoreFixture();
        var groups = ClientScriptBundle.GetComponentGroups();
        var wanted = new[] { groups[0], groups[^1] };
        var ids = ClientScriptBundle.ParseGroupRequest($"{wanted[1].Id},{wanted[0].Id}")!;
        var bundle = ClientScriptBundle.GetGroupBundle("regression-version", ids, true, fixture.Logger);
        var script = Encoding.UTF8.GetString(bundle.Script);
        var lines = script.Split('\n');
        var combination = string.Join(',', wanted.Select(g => g.Id));
        Assert.EndsWith($"//# sourceMappingURL=bundle.js.map?g={combination}&v=regression-version\n", script);
        // One statement per group, in file order, each announcing how many modules it holds.
        var first = script.IndexOf($"(window.__JE_BUNDLES = window.__JE_BUNDLES || {{}})[\"{wanted[0].Id}\"] = {{ total: {wanted[0].Scripts.Count}, modules: [", StringComparison.Ordinal);
        var second = script.IndexOf($"(window.__JE_BUNDLES = window.__JE_BUNDLES || {{}})[\"{wanted[1].Id}\"] = {{ total: {wanted[1].Scripts.Count}, modules: [", StringComparison.Ordinal);
        Assert.True(first > 0 && second > first);
        Assert.DoesNotContain("__JE_BUNDLE_MODULES", script);

        using var map = JsonDocument.Parse(bundle.SourceMap);
        var sections = map.RootElement.GetProperty("sections").EnumerateArray().ToArray();
        var paths = wanted.SelectMany(g => g.Scripts).ToArray();
        Assert.Equal(paths.Length, sections.Length);
        var assembly = typeof(Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced).Assembly;
        for (var i = 0; i < paths.Length; i++)
        {
            var line = sections[i].GetProperty("offset").GetProperty("line").GetInt32();
            // As the whole bundle: each module's minified twin (min/js/<path>) when there is one, with its own map.
            var resource = paths[i].Replace('/', '.');
            var prefix = PackedResources.Exists(assembly, "Jellyfin.Plugin.JellyfinEnhanced.min.js." + resource)
                ? "Jellyfin.Plugin.JellyfinEnhanced.min.js." : "Jellyfin.Plugin.JellyfinEnhanced.js.";
            using var original = PackedResources.Open(assembly, prefix + resource)!;
            using var reader = new StreamReader(original);
            var source = reader.ReadToEnd();
            Assert.Equal("(function () {", lines[line - 1]);
            Assert.Equal(source, string.Join('\n', lines.Skip(line)).Substring(0, source.Length));
            using var embeddedMap = PackedResources.Open(assembly, prefix + resource + ".map");
            if (embeddedMap == null)
            {
                Assert.Equal($"js/{paths[i]}?v=regression-version", sections[i].GetProperty("map").GetProperty("sources")[0].GetString());
            }
            else
            {
                using var typedMap = JsonDocument.Parse(embeddedMap);
                Assert.True(JsonElement.DeepEquals(typedMap.RootElement.GetProperty("mappings"), sections[i].GetProperty("map").GetProperty("mappings")), $"{paths[i]}: mappings changed.");
            }
        }

        // The same combination is served from the cache; a single group reuses the built piece.
        var cached = ClientScriptBundle.GetGroupBundle("regression-version", ids, false, fixture.Logger);
        Assert.Same(cached.Script, ClientScriptBundle.GetGroupBundle("regression-version", ids, false, fixture.Logger).Script);
        var alone = Encoding.UTF8.GetString(ClientScriptBundle.GetGroupBundle("regression-version", new[] { wanted[1].Id }, false, fixture.Logger).Script);
        Assert.DoesNotContain($"[\"{wanted[0].Id}\"]", alone);
        Assert.Contains($"[\"{wanted[1].Id}\"]", alone);
        // Another cache key builds again. (Every module here has a typed map, so the key shows in the script's trailer,
        // not in a line-identity section of the map as upstream's legacy modules have.)
        var changed = ClientScriptBundle.GetGroupBundle("next-version", ids, false, fixture.Logger);
        Assert.EndsWith($"//# sourceMappingURL=bundle.js.map?g={combination}&v=next-version\n", Encoding.UTF8.GetString(changed.Script));
        Assert.NotSame(cached.Script, changed.Script);
    }

    [Fact]
    public void EveryGroupTogetherHoldsExactlyTheWholeBundlesModules()
    {
        using var fixture = new CoreFixture();
        var ids = ClientScriptBundle.GetComponentGroups().Select(g => g.Id).ToArray();
        var grouped = Encoding.UTF8.GetString(ClientScriptBundle.GetGroupBundle("regression-version", ids, true, fixture.Logger).Script);
        var whole = Encoding.UTF8.GetString(ClientScriptBundle.GetBundle("regression-version", true, fixture.Logger).Script);
        static string[] Markers(string script) => script.Split('\n').Where(line => line.StartsWith("/* ---- js/", StringComparison.Ordinal)).OrderBy(line => line, StringComparer.Ordinal).ToArray();
        Assert.Equal(Markers(whole), Markers(grouped));
        Assert.Equal(ClientScriptBundle.GetComponentScripts().Count, Markers(grouped).Length);
        // Every module function is parenthesized, as in the whole bundle.
        var lines = grouped.Split('\n');
        Assert.Equal(Markers(grouped).Length, lines.Count(line => line == "(function () {"));
    }

    [Fact]
    public void BundleRouteServesGroupsAndRejectsUnknownOnes()
    {
        using var fixture = new ApiPluginFixture();
        var controller = ApiAssetTests.Controller(fixture.Core);
        var script = Assert.IsType<FileContentResult>(controller.GetScriptBundle("core"));
        Assert.Equal("application/javascript", script.ContentType);
        Assert.Contains("window.__JE_BUNDLES", Encoding.UTF8.GetString(script.FileContents));
        Assert.Equal("public, max-age=31536000, immutable", controller.Response.Headers.CacheControl);
        Assert.Equal("application/json", Assert.IsType<FileContentResult>(controller.GetScriptBundleMap("core")).ContentType);
        Assert.IsType<NotFoundResult>(controller.GetScriptBundle("not-a-group"));
        Assert.IsType<NotFoundResult>(controller.GetScriptBundle("core,core"));
        Assert.IsType<NotFoundResult>(controller.GetScriptBundleMap(""));
        // Without the parameter the route still serves the whole manifest in the single-array format.
        Assert.Contains("window.__JE_BUNDLE_MODULES", Encoding.UTF8.GetString(Assert.IsType<FileContentResult>(controller.GetScriptBundle()).FileContents));
    }

    [Fact]
    public void BootstrapCarriesTheGroupsFileAsWritten()
    {
        using var fixture = new ApiPluginFixture();
        var user = Guid.NewGuid();
        var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<MediaBrowser.Controller.Session.ISessionManager>(), fixture.Core.Paths.Object, fixture.Core.Logger);
        var controller = ApiAssetTests.Controller(fixture.Core, maintenance, fixture.Core.Manager, Mock.Of<ILibraryManager>());
        controller.ControllerContext.HttpContext.User = global::JE.Tests.Features.SpoilerGuard.PrivacyPolicyTests.Principal(user, false);
        var result = Assert.IsType<JsonResult>(controller.GetBootstrap());
        var body = JsonDocument.Parse(JsonSerializer.Serialize(Assert.IsType<BootstrapResponse>(result.Value), (JsonSerializerOptions)result.SerializerSettings!)).RootElement;
        var listed = body.GetProperty("ComponentGroups").EnumerateArray().ToArray();
        var resolved = ClientScriptBundle.GetComponentGroups();
        // "core" is implicit: the payload lists every other group, in order, with its own modules.
        Assert.Equal(resolved.Skip(1).Select(g => g.Id), listed.Select(g => g.GetProperty("id").GetString()));
        for (var i = 0; i < listed.Length; i++)
        {
            Assert.Equal(resolved[i + 1].Scripts.OrderBy(p => p, StringComparer.Ordinal),
                listed[i].GetProperty("modules").EnumerateArray().Select(m => m.GetString()!).OrderBy(p => p, StringComparer.Ordinal));
            // "after" as the file writes it, and absent where the file has none.
            Assert.Equal(resolved[i + 1].After, listed[i].TryGetProperty("after", out var after) ? after.EnumerateArray().Select(a => a.GetString()!).ToArray() : Array.Empty<string>());
        }
        Assert.Equal(ClientScriptBundle.GetComponentScripts(), body.GetProperty("ComponentScripts").EnumerateArray().Select(s => s.GetString()!));
    }
}
