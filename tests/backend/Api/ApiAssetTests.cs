using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Platform.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Platform;

namespace JE.Tests;

public class ApiAssetTests
{
    internal static JePlatformController Controller(CoreFixture fixture, params object[] services)
        => (JePlatformController)Controller(typeof(JePlatformController), fixture, services);

    // Any plugin controller type: each constructor parameter is filled from `services` (first instance of a matching
    // type), the fixture logger, or an inert SpoilerSeerrRedactor; anything else is null.
    internal static ControllerBase Controller(Type controllerType, CoreFixture fixture, params object[] services)
    {
        // Asset actions use only the logger and HTTP context; unrelated host services are deliberately absent.
        var constructor = controllerType.GetConstructors().Single();
        var arguments = constructor.GetParameters().Select(p => p.ParameterType == typeof(Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard.SpoilerSeerrRedactor) && !services.OfType<Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard.SpoilerSeerrRedactor>().Any()
            // Inert until a test turns Spoiler Guard on, and then it supplies its own.
            ? new Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard.SpoilerSeerrRedactor(null!, null!, null!, null!, null!)
            : p.ParameterType == typeof(Jellyfin.Plugin.JellyfinEnhanced.Logger) ? (object)fixture.Logger : services.FirstOrDefault(p.ParameterType.IsInstanceOfType)).ToArray();
        var controller = (ControllerBase)constructor.Invoke(arguments);
        controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() };
        Built.AddOrUpdate(controller, Tuple.Create(fixture, services));
        return controller;
    }

    // The fixture and services each controller above was built from, so SiblingOf can build a feature controller from
    // the same inputs (restructure S2.15: the main controller no longer holds the feature services as fields).
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<ControllerBase, Tuple<CoreFixture, object[]>> Built = new();

    // A feature controller sharing `controller`'s ControllerContext (its HTTP context and signed-in user), for a test
    // that drives actions a restructure step moved off `controller` alongside actions that stayed on it.
    internal static T Sibling<T>(ControllerBase controller, CoreFixture fixture, params object[] services) where T : ControllerBase
    {
        var sibling = (T)Controller(typeof(T), fixture, services);
        sibling.ControllerContext = controller.ControllerContext;
        return sibling;
    }

    // A feature controller built from the constructor arguments `controller` holds (its injected fields, base class
    // included) and sharing its ControllerContext, so it sees the same services and signed-in user. For tests whose
    // fixture exposes only the main controller (restructure S2.11). Call it per action: a later SignIn replaces the
    // main controller's context. A controller built by Controller(...) is rebuilt from its recorded fixture and services.
    internal static T SiblingOf<T>(ControllerBase controller) where T : ControllerBase
    {
        // Built by Controller(...): the same fixture and services give every constructor parameter the instance the
        // controller's own constructor received (each feature controller's parameter types were all parameters of the
        // old main controller's constructor), without depending on which fields the controller keeps.
        if (Built.TryGetValue(controller, out var built)) return Sibling<T>(controller, built.Item1, built.Item2);
        var values = new List<object>();
        for (var type = controller.GetType(); type != null && type != typeof(ControllerBase); type = type.BaseType)
            values.AddRange(type.GetFields(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.DeclaredOnly)
                .Select(f => f.GetValue(controller)).OfType<object>());
        var constructor = typeof(T).GetConstructors().Single();
        var sibling = (T)constructor.Invoke(constructor.GetParameters().Select(p => values.FirstOrDefault(p.ParameterType.IsInstanceOfType)).ToArray());
        sibling.ControllerContext = controller.ControllerContext;
        return sibling;
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
    public void BundleSourceMapPreservesTypedMappingsAndLegacyModuleLinesInManifestOrder()
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
        var typedSections = 0;
        for (var i = 0; i < paths.Count; i++)
        {
            var section = sections[i];
            var sourceMap = section.GetProperty("map");
            var line = section.GetProperty("offset").GetProperty("line").GetInt32();
            // canopy K1: the bundle serves each module's minified twin (min/js/<path>) when there is one.
            var assembly = typeof(Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced).Assembly;
            var resource = paths[i].Replace('/', '.');
            var prefix = assembly.GetManifestResourceInfo("Jellyfin.Plugin.JellyfinEnhanced.min.js." + resource) != null
                ? "Jellyfin.Plugin.JellyfinEnhanced.min.js." : "Jellyfin.Plugin.JellyfinEnhanced.js.";
            using var original = assembly.GetManifestResourceStream(prefix + resource)!;
            using var reader = new StreamReader(original);
            var source = reader.ReadToEnd();
            Assert.Equal(source, string.Join('\n', lines.Skip(line)).Substring(0, source.Length));
            using var embeddedMap = assembly.GetManifestResourceStream(prefix + resource + ".map");
            if (embeddedMap != null)
            {
                typedSections++;
                using var typedMap = JsonDocument.Parse(embeddedMap);
                foreach (var property in new[] { "mappings", "names" })
                    Assert.True(JsonElement.DeepEquals(typedMap.RootElement.GetProperty(property), sourceMap.GetProperty(property)), $"Embedded source-map {property} changed.");
                // A twin map has no sourcesContent; the bundle copies each source's text from the readable map.
                using var readableMap = JsonDocument.Parse(assembly.GetManifestResourceStream("Jellyfin.Plugin.JellyfinEnhanced.js." + resource + ".map")!);
                var readableSources = readableMap.RootElement.GetProperty("sources").EnumerateArray().Select(e => e.GetString()).ToList();
                var typedSources = typedMap.RootElement.GetProperty("sources").EnumerateArray().Select(e => e.GetString()).ToArray();
                var contents = sourceMap.GetProperty("sourcesContent").EnumerateArray().ToArray();
                Assert.Equal(typedSources.Length, contents.Length);
                for (var j = 0; j < typedSources.Length; j++)
                    Assert.True(JsonElement.DeepEquals(readableMap.RootElement.GetProperty("sourcesContent")[readableSources.IndexOf(typedSources[j])], contents[j]), $"{paths[i]}: sourcesContent of {typedSources[j]} changed.");
                var originalSources = typedMap.RootElement.GetProperty("sources").EnumerateArray().ToArray();
                var mappedSources = sourceMap.GetProperty("sources").EnumerateArray().ToArray();
                Assert.Equal(originalSources.Length, mappedSources.Length);
                for (var j = 0; j < mappedSources.Length; j++)
                {
                    // canopy K1b: or a module the build generated for a shared module (scripts/client/shared-modules.mjs);
                    // its text is in sourcesContent, copied from the readable map above.
                    Assert.Matches("^client/(src|generated-shared)/", mappedSources[j].GetString());
                    Assert.EndsWith(mappedSources[j].GetString()!, originalSources[j].GetString());
                }
            }
            else
            {
                Assert.Equal($"js/{paths[i]}?v=regression-version", sourceMap.GetProperty("sources")[0].GetString());
                var lineCount = source.Count(c => c == '\n') + (source.EndsWith('\n') ? 0 : 1);
                Assert.Equal(lineCount, sourceMap.GetProperty("mappings").GetString()!.Split(';').Length);
            }
        }
        Assert.True(typedSections >= 3, "The production bundle must include the typed core runtime maps.");
        var cached = ClientScriptBundle.GetBundle("regression-version", false, fixture.Logger);
        Assert.Same(bundle.Script, cached.Script);
        var rebuilt = ClientScriptBundle.GetBundle("regression-version", true, fixture.Logger);
        Assert.NotSame(cached.Script, rebuilt.Script);
        Assert.Equal(bundle.Script, rebuilt.Script);
        // A new cache key builds a new bundle that links its map under that key. (Every manifest module now ships a
        // typed map, so the key no longer appears in the map itself; only a legacy section's sources carry it.)
        var changed = ClientScriptBundle.GetBundle("next-version", false, fixture.Logger);
        Assert.NotSame(rebuilt.Script, changed.Script);
        Assert.NotSame(rebuilt.SourceMap, changed.SourceMap);
        Assert.EndsWith("//# sourceMappingURL=bundle.js.map?v=next-version\n", Encoding.UTF8.GetString(changed.Script));
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
        var engineAt = script.Content.IndexOf("window.JEAdmin = ", StringComparison.Ordinal);
        Assert.True(engineAt >= 0 && engineAt < script.Content.IndexOf("JEAdmin.setPerUser(", StringComparison.Ordinal));

        var styles = Assert.IsType<ContentResult>(controller.GetAdminStylesheet());
        Assert.Equal("text/css", styles.ContentType);
        Assert.Contains(".jea-section", styles.Content);
        Assert.Equal("public, max-age=31536000, immutable", controller.Response.Headers.CacheControl);
    }
}
