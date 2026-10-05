using System.Text;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Plugin = Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ApiMiddlewareTests
{
    private static async Task<DefaultHttpContext> Invoke(Microsoft.AspNetCore.Hosting.IStartupFilter filter, string path, string method, RequestDelegate downstream)
    {
        using var services = new ServiceCollection().AddLogging().BuildServiceProvider();
        var app = new ApplicationBuilder(services);
        filter.Configure(a => a.Run(downstream))(app);
        var context = new DefaultHttpContext();
        context.Request.Path = path;
        context.Request.Method = method;
        context.Response.Body = new MemoryStream();
        context.Request.Headers.AcceptEncoding = "gzip";
        context.Request.Headers.Range = "bytes=0-10";
        context.Request.Headers.IfRange = "old";
        await app.Build()(context);
        return context;
    }
    private static string Body(HttpContext context) => Encoding.UTF8.GetString(((MemoryStream)context.Response.Body).ToArray());

    [Theory]
    [InlineData("/web")][InlineData("/web/")][InlineData("/web/index.html")]
    [InlineData("/jellyfin/web")][InlineData("/jellyfin/web/")][InlineData("/jellyfin/web/index.html")]
    public async Task InjectsIntoAllShellPathsIncludingBaseUrlAndInvalidatesOriginalValidators(string path)
    {
        using var f = new ApiPluginFixture();
        var context = await Invoke(new ScriptInjectionStartupFilter(f.Core.Logger), path, "GET", async c =>
        {
            Assert.Equal(0, c.Request.Headers.AcceptEncoding.Count);
            Assert.Equal(0, c.Request.Headers.Range.Count);
            Assert.Equal(0, c.Request.Headers.IfRange.Count);
            c.Response.ContentType = "text/html";
            c.Response.Headers.ETag = "original";
            c.Response.Headers.LastModified = "old";
            c.Response.Headers.AcceptRanges = "bytes";
            await c.Response.WriteAsync("<html><body>日本語</body></html>");
        });
        Assert.Contains(f.Plugin.BuildScriptTag(), Body(context));
        Assert.Equal(0, context.Response.Headers.ETag.Count);
        Assert.Equal(0, context.Response.Headers.LastModified.Count);
        Assert.Equal(0, context.Response.Headers.AcceptRanges.Count);
        Assert.Equal(Encoding.UTF8.GetByteCount(Body(context)), context.Response.ContentLength);
    }

    [Theory]
    [InlineData("/web/index.html", "HEAD", 200, "text/html", false)]
    [InlineData("/web/not-index.html", "GET", 200, "text/html", false)]
    [InlineData("/web/index.html", "GET", 304, "text/html", false)]
    [InlineData("/web/index.html", "GET", 200, "application/json", false)]
    [InlineData("/web/index.html", "GET", 200, "text/html", true)]
    public async Task NonShellNonGetNonHtmlAndDisabledResponsesPassThrough(string path, string method, int status, string mime, bool disabled)
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.DisableScriptInjectionMiddleware = disabled;
        const string original = "<body>Original</body>";
        var context = await Invoke(new ScriptInjectionStartupFilter(f.Core.Logger), path, method, async c =>
        {
            c.Response.StatusCode = status;
            c.Response.ContentType = mime;
            c.Response.Headers.ETag = "original";
            await c.Response.WriteAsync(original);
        });
        Assert.Equal(original, Body(context));
        Assert.Equal("original", context.Response.Headers.ETag);
    }

    [Theory]
    [InlineData("<body><script src='../JellyfinEnhanced/script?v=old'></script></body>")]
    [InlineData("<html>No body closing tag</html>")]
    public async Task ExistingInjectionAndMissingBodyDoNotAddAnotherTag(string original)
    {
        using var f = new ApiPluginFixture();
        var context = await Invoke(new ScriptInjectionStartupFilter(f.Core.Logger), "/web/", "GET", async c =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.WriteAsync(original);
        });
        Assert.Equal(original, Body(context));
    }

    [Fact]
    public async Task DownstreamFailureRestoresOriginalStreamWithoutFlushingPartialBody()
    {
        using var f = new ApiPluginFixture();
        using var services = new ServiceCollection().BuildServiceProvider();
        var app = new ApplicationBuilder(services);
        new ScriptInjectionStartupFilter(f.Core.Logger).Configure(a => a.Run(async c => { await c.Response.WriteAsync("partial"); throw new InvalidOperationException("downstream"); }))(app);
        var context = new DefaultHttpContext();
        context.Request.Path = "/web/";
        context.Request.Method = "GET";
        using var original = new MemoryStream();
        context.Response.Body = original;
        await Assert.ThrowsAsync<InvalidOperationException>(() => app.Build()(context));
        Assert.Same(original, context.Response.Body);
        Assert.Equal(0, original.Length);
    }

    [Theory]
    [InlineData("/web/icon-transparent.abc.png", "icon-transparent.png")]
    [InlineData("/base/web/banner-light.a1.png", "banner-light.png")]
    [InlineData("/web/banner-dark.deadbeef.png", "banner-dark.png")]
    [InlineData("/web/favicon.abc.ico", "favicon.ico")]
    [InlineData("/web/touchicon.abcdef.png", "apple-touch-icon.png")]
    [InlineData("/web/favicons/touchicon144.png", "apple-touch-icon.png")]
    public async Task BrandingServesFixedUploadNamesWithHeadAndConditionalGet(string path, string filename)
    {
        using var f = new ApiPluginFixture();
        Directory.CreateDirectory(Plugin.BrandingDirectory);
        var bytes = new byte[] { 1, 2, 3, 4 };
        File.WriteAllBytes(Path.Combine(Plugin.BrandingDirectory, filename), bytes);
        var filter = new BrandingAssetStartupFilter(f.Core.Logger);
        RequestDelegate fail = _ => throw new Exception("Branding unexpectedly fell through");
        var get = await Invoke(filter, path, "GET", fail);
        Assert.Equal(bytes, ((MemoryStream)get.Response.Body).ToArray());
        Assert.Equal("no-cache", get.Response.Headers.CacheControl);
        Assert.NotEmpty(get.Response.Headers.ETag.ToString());
        var head = await Invoke(filter, path, "HEAD", fail);
        Assert.Equal(4, head.Response.ContentLength);
        Assert.Empty(Body(head));
        Assert.Equal(get.Response.Headers.ETag, head.Response.Headers.ETag);
        using var services = new ServiceCollection().BuildServiceProvider();
        var app = new ApplicationBuilder(services);
        filter.Configure(a => a.Run(fail))(app);
        var conditional = new DefaultHttpContext();
        conditional.Request.Path = path;
        conditional.Request.Method = "GET";
        conditional.Request.Headers.IfNoneMatch = "\"other\", W/" + get.Response.Headers.ETag;
        conditional.Response.Body = new MemoryStream();
        await app.Build()(conditional);
        Assert.Equal(304, conditional.Response.StatusCode);
        Assert.Empty(Body(conditional));
    }

    [Theory]
    [InlineData("/web/icon-transparent.abc.png", "POST", false, true)]
    [InlineData("/web/icon-transparent.abc.png", "GET", true, true)]
    [InlineData("/web/icon-transparent.abc.png", "GET", false, false)]
    [InlineData("/other/icon-transparent.abc.png", "GET", false, true)]
    [InlineData("/web/unrelated.png", "GET", false, true)]
    public async Task BrandingPassesThroughNonAssetsDisabledMissingAndUnsupportedMethods(string path, string method, bool disabled, bool upload)
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.DisableBrandingMiddleware = disabled;
        Directory.CreateDirectory(Plugin.BrandingDirectory);
        if (upload) File.WriteAllText(Path.Combine(Plugin.BrandingDirectory, "icon-transparent.png"), "custom");
        var context = await Invoke(new BrandingAssetStartupFilter(f.Core.Logger), path, method, c => c.Response.WriteAsync("stock"));
        Assert.Equal("stock", Body(context));
    }
}
