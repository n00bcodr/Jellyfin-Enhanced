using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

public class ApiAssetTests
{
    internal static JellyfinEnhancedController Controller(CoreFixture fixture, params object[] services)
    {
        // Asset actions use only the logger and HTTP context; unrelated host services are deliberately absent.
        var constructor = typeof(JellyfinEnhancedController).GetConstructors().Single();
        var arguments = constructor.GetParameters().Select(p => p.ParameterType == typeof(Jellyfin.Plugin.JellyfinEnhanced.Services.SpoilerSeerrRedactor) && !services.OfType<Jellyfin.Plugin.JellyfinEnhanced.Services.SpoilerSeerrRedactor>().Any()
            // Inert until a test turns Spoiler Guard on, and then it supplies its own.
            ? new Jellyfin.Plugin.JellyfinEnhanced.Services.SpoilerSeerrRedactor(null!, null!, null!, null!, null!)
            : p.ParameterType == typeof(Jellyfin.Plugin.JellyfinEnhanced.Logger) ? (object)fixture.Logger : services.FirstOrDefault(p.ParameterType.IsInstanceOfType)).ToArray();
        var controller = (JellyfinEnhancedController)constructor.Invoke(arguments);
        controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() };
        return controller;
    }

    [Fact]
    public async Task EveryManifestModuleIsEmbeddedAndServedWithJavascriptMime()
    {
        using var fixture = new CoreFixture();
        var controller = Controller(fixture);
        var paths = ClientScriptBundle.GetComponentScripts();
        Assert.NotEmpty(paths);
        Assert.Equal(paths.Count, paths.Distinct().Count());
        foreach (var path in paths)
        {
            var result = Assert.IsType<FileStreamResult>(controller.GetScript(path));
            using var reader = new StreamReader(result.FileStream);
            Assert.Equal("application/javascript; charset=utf-8", result.ContentType);
            Assert.False(string.IsNullOrWhiteSpace(await reader.ReadToEndAsync()), path);
        }
        Assert.Equal("public, max-age=31536000, immutable", controller.Response.Headers.CacheControl);
    }

    [Theory]
    [InlineData("not-a-component.js")]
    [InlineData("../../Configuration/configPage.html")]
    [InlineData("/etc/passwd")]
    [InlineData("locales/not-a-locale.json")]
    public void MissingAndTraversalResourceRequestsReturnNotFound(string path)
    {
        using var fixture = new CoreFixture();
        Assert.IsType<NotFoundResult>(Controller(fixture).GetScript(path));
    }

    [Fact]
    public async Task StylesManifestAndBootstrapHaveCorrectTypesAndNonemptyBodies()
    {
        using var fixture = new CoreFixture();
        var controller = Controller(fixture);
        foreach (var (result, mime) in new[] {
            (controller.GetAdminStylesheet(), "text/css"),
            (controller.GetScript("component-scripts.json"), "application/json"),
            (controller.GetMainScript(), "application/javascript") })
        {
            if (result is ContentResult content)
            {
                Assert.Equal(mime, content.ContentType);
                Assert.NotEmpty(content.Content ?? string.Empty);
                continue;
            }
            var file = Assert.IsType<FileStreamResult>(result);
            using var reader = new StreamReader(file.FileStream);
            Assert.Equal(mime + "; charset=utf-8", file.ContentType);
            Assert.NotEmpty(await reader.ReadToEndAsync());
        }
    }

    [Theory]
    [InlineData("de-DE", "de")]
    [InlineData("fr-CA", "fr")]
    [InlineData("it-IT", "it")]
    public async Task RegionalLocaleFallsBackToEmbeddedBaseLanguage(string regional, string language)
    {
        using var fixture = new CoreFixture();
        var controller = Controller(fixture);
        var regionalFile = Assert.IsType<FileStreamResult>(controller.GetLocale(regional));
        var baseFile = Assert.IsType<FileStreamResult>(controller.GetLocale(language));
        using var regionalReader = new StreamReader(regionalFile.FileStream);
        using var baseReader = new StreamReader(baseFile.FileStream);
        Assert.Equal("application/json", regionalFile.ContentType);
        Assert.Equal(await baseReader.ReadToEndAsync(), await regionalReader.ReadToEndAsync());
        Assert.IsType<NotFoundResult>(controller.GetLocale("zz-ZZ"));
    }

    [Theory]
    [InlineData("materialsymbolsrounded-subset.woff2")]
    [InlineData("materialsymbolsoutlined-subset.woff2")]
    [InlineData("materialsymbolsrounded.woff2")]
    [InlineData("materialsymbolsoutlined.woff2")]
    public async Task BundledFontsAreValidWoff2AndCacheable(string name)
    {
        using var fixture = new CoreFixture();
        var controller = Controller(fixture);
        var file = Assert.IsType<FileStreamResult>(controller.GetBundledFont(name));
        using var stream = file.FileStream;
        var signature = new byte[4];
        await stream.ReadExactlyAsync(signature);
        Assert.Equal("wOF2", Encoding.ASCII.GetString(signature));
        Assert.Equal("font/woff2", file.ContentType);
        Assert.Equal("public, max-age=31536000, immutable", controller.Response.Headers.CacheControl);
        Assert.IsType<NotFoundResult>(controller.GetBundledFont("private-font.woff2"));
    }

    [Fact]
    public void BundleSourceMapPointsAtExactOriginalModuleLinesInManifestOrder()
    {
        using var fixture = new CoreFixture();
        var bundle = ClientScriptBundle.GetBundle("regression-version", true, fixture.Logger);
        var script = Encoding.UTF8.GetString(bundle.Script);
        var lines = script.Split('\n');
        using var map = JsonDocument.Parse(bundle.SourceMap);
        var sections = map.RootElement.GetProperty("sections").EnumerateArray().ToArray();
        var paths = ClientScriptBundle.GetComponentScripts();
        Assert.Equal(3, map.RootElement.GetProperty("version").GetInt32());
        Assert.Equal(paths.Count, sections.Length);
        Assert.Contains($"window.__JE_BUNDLE_TOTAL = {paths.Count};", script);
        Assert.EndsWith("//# sourceMappingURL=bundle.js.map?v=regression-version\n", script);
        for (var i = 0; i < paths.Count; i++)
        {
            var section = sections[i];
            var sourceMap = section.GetProperty("map");
            Assert.Equal($"js/{paths[i]}?v=regression-version", sourceMap.GetProperty("sources")[0].GetString());
            var line = section.GetProperty("offset").GetProperty("line").GetInt32();
            using var original = typeof(JellyfinEnhancedController).Assembly.GetManifestResourceStream("Jellyfin.Plugin.JellyfinEnhanced.js." + paths[i].Replace('/', '.'))!;
            using var reader = new StreamReader(original);
            var source = reader.ReadToEnd();
            Assert.Equal(source, string.Join('\n', lines.Skip(line)).Substring(0, source.Length));
            var lineCount = source.Count(c => c == '\n') + (source.EndsWith('\n') ? 0 : 1);
            Assert.Equal(lineCount, sourceMap.GetProperty("mappings").GetString()!.Split(';').Length);
        }
        var cached = ClientScriptBundle.GetBundle("regression-version", false, fixture.Logger);
        Assert.Same(bundle.Script, cached.Script);
        var rebuilt = ClientScriptBundle.GetBundle("regression-version", true, fixture.Logger);
        Assert.NotSame(cached.Script, rebuilt.Script);
        Assert.Equal(bundle.Script, rebuilt.Script);
        var changed = ClientScriptBundle.GetBundle("next-version", false, fixture.Logger);
        Assert.Contains("v=next-version", Encoding.UTF8.GetString(changed.SourceMap));
    }

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
        for (var i = 0; i < paths.Length; i++)
        {
            var sourceMap = sections[i].GetProperty("map");
            Assert.Equal($"js/{paths[i]}?v=regression-version", sourceMap.GetProperty("sources")[0].GetString());
            var line = sections[i].GetProperty("offset").GetProperty("line").GetInt32();
            using var original = typeof(JellyfinEnhancedController).Assembly.GetManifestResourceStream("Jellyfin.Plugin.JellyfinEnhanced.js." + paths[i].Replace('/', '.'))!;
            using var reader = new StreamReader(original);
            var source = reader.ReadToEnd();
            Assert.Equal(source, string.Join('\n', lines.Skip(line)).Substring(0, source.Length));
        }

        // The same combination is served from the cache; a single group reuses the built piece.
        var cached = ClientScriptBundle.GetGroupBundle("regression-version", ids, false, fixture.Logger);
        Assert.Same(cached.Script, ClientScriptBundle.GetGroupBundle("regression-version", ids, false, fixture.Logger).Script);
        var alone = Encoding.UTF8.GetString(ClientScriptBundle.GetGroupBundle("regression-version", new[] { wanted[1].Id }, false, fixture.Logger).Script);
        Assert.DoesNotContain($"[\"{wanted[0].Id}\"]", alone);
        Assert.Contains($"[\"{wanted[1].Id}\"]", alone);
        var changed = ClientScriptBundle.GetGroupBundle("next-version", ids, false, fixture.Logger);
        Assert.Contains("v=next-version", Encoding.UTF8.GetString(changed.SourceMap));
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
    }

    [Fact]
    public void AdminSchemaScriptAndStylesheetAreServedAsOneConcatenatedFileEach()
    {
        using var fixture = new CoreFixture();
        var controller = Controller(fixture);

        var script = Assert.IsType<ContentResult>(controller.GetAdminScript());
        Assert.Equal("application/javascript", script.ContentType);
        // Engine first, then every embedded Configuration/admin/*.js section file.
        Assert.Contains("window.JEAdmin", script.Content);
        Assert.Contains("JEAdmin.define(", script.Content);
        Assert.Contains("JEAdmin.setPerUser(", script.Content);
        Assert.True(script.Content.IndexOf("window.JEAdmin = {", StringComparison.Ordinal) < script.Content.IndexOf("JEAdmin.setPerUser(", StringComparison.Ordinal));

        var styles = Assert.IsType<ContentResult>(controller.GetAdminStylesheet());
        Assert.Equal("text/css", styles.ContentType);
        Assert.Contains(".jea-section", styles.Content);
        Assert.Equal("public, max-age=31536000, immutable", controller.Response.Headers.CacheControl);
    }
}
