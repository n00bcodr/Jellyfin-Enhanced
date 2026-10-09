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
        var arguments = constructor.GetParameters().Select(p => p.ParameterType == typeof(Jellyfin.Plugin.JellyfinEnhanced.Logger) ? (object)fixture.Logger : services.FirstOrDefault(p.ParameterType.IsInstanceOfType)).ToArray();
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
            Assert.Equal("application/javascript", result.ContentType);
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
            (controller.GetConfigPageStylesheet(), "text/css"),
            (controller.GetScript("component-scripts.json"), "application/json"),
            (controller.GetMainScript(), "application/javascript") })
        {
            var file = Assert.IsType<FileStreamResult>(result);
            using var reader = new StreamReader(file.FileStream);
            Assert.Equal(mime, file.ContentType);
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
}
