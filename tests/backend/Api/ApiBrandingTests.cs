using System.Reflection;
using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Authorization;
using Moq;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Primitives;
using Plugin = Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ApiBrandingTests
{
    private static readonly byte[] Png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=");
    private static JellyfinEnhancedController Controller(ApiPluginFixture f, bool admin = true)
    {
        var c = ApiAssetTests.Controller(f.Core);
        c.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test"));
        return c;
    }
    private static void Form(JellyfinEnhancedController c, string? name, string mime = "image/png", long? length = null, bool withFile = true, byte[]? bytes = null)
    {
        var files = new FormFileCollection();
        var body = bytes ?? Png;
        if (withFile) files.Add(new FormFile(new MemoryStream(body), 0, length ?? body.Length, "file", "client-name.png") { Headers = new HeaderDictionary(), ContentType = mime });
        c.Request.Form = new FormCollection(name == null ? new() : new Dictionary<string, StringValues> { ["fileName"] = name }, files);
    }

    [Theory]
    [InlineData("icon-transparent.png")]
    [InlineData("ICON-TRANSPARENT.PNG")]
    [InlineData("../icon-transparent.png")]
    public async Task UploadReadStatusAndDeleteUseCanonicalFixedSlot(string requestedName)
    {
        using var f = new ApiPluginFixture();
        var c = Controller(f);
        Form(c, requestedName);
        Assert.IsType<OkObjectResult>(await c.UploadBrandingImage());
        var canonicalPath = Path.Combine(Plugin.BrandingDirectory, "icon-transparent.png");
        Assert.True(File.Exists(canonicalPath), "Accepted filename must address the same fixed slot used by middleware and status.");
        Assert.Equal(Png, File.ReadAllBytes(canonicalPath));
        var status = Assert.IsType<Dictionary<string, bool>>(Assert.IsType<OkObjectResult>(c.GetBrandingStatus()).Value);
        Assert.True(status["icon-transparent.png"]);
        Assert.Equal(6, status.Count);
        var image = Assert.IsType<PhysicalFileResult>(c.GetBrandingImage(requestedName));
        Assert.Equal(canonicalPath, image.FileName);
        Assert.Equal("image/png", image.ContentType);
        Assert.IsType<OkObjectResult>(c.DeleteBrandingImage());
        Assert.False(File.Exists(canonicalPath));
        Assert.IsType<NotFoundObjectResult>(c.DeleteBrandingImage());
        Assert.IsType<NotFoundResult>(c.GetBrandingImage(requestedName));
    }

    [Fact]
    public void ElsewhereIconRouteNeedsNoLoginBecauseImgTagsSendNoAuthHeader()
    {
        var method = typeof(JellyfinEnhancedController).GetMethod(nameof(JellyfinEnhancedController.GetElsewhereBrandingIcon))!;
        Assert.NotNull(method.GetCustomAttribute<AllowAnonymousAttribute>());
        Assert.Null(method.GetCustomAttribute<AuthorizeAttribute>());
    }

    [Fact]
    public async Task PublicConfigIconVersionTracksUploadReuploadAndDelete()
    {
        using var f = new ApiPluginFixture();
        var c = ApiAssetTests.Controller(f.Core, f.Core.Manager,
            new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), f.Core.Paths.Object, f.Core.Logger));
        c.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.Role, "Administrator")], "test"));
        string Version() => JsonSerializer.SerializeToElement(Assert.IsType<JsonResult>(c.GetPublicConfig()).Value)
            .GetProperty("ElsewhereCustomBrandingIconVersion").GetString()!;

        Assert.Equal(string.Empty, Version());
        Form(c, "elsewhere-icon.png");
        Assert.IsType<OkObjectResult>(await c.UploadBrandingImage());
        var first = Version();
        Assert.NotEqual(string.Empty, first);
        File.SetLastWriteTimeUtc(Path.Combine(Plugin.BrandingDirectory, "elsewhere-icon.png"), DateTime.UtcNow.AddMinutes(-5));
        Form(c, "elsewhere-icon.png");
        Assert.IsType<OkObjectResult>(await c.UploadBrandingImage());
        Assert.NotEqual(first, Version());
        Form(c, "elsewhere-icon.png", withFile: false);
        Assert.IsType<OkObjectResult>(c.DeleteBrandingImage());
        Assert.Equal(string.Empty, Version());
    }

    [Fact]
    public void ElsewhereIconIsAbsentUntilUploaded()
    {
        using var f = new ApiPluginFixture();
        var c = Controller(f, false);
        Assert.IsType<NotFoundResult>(c.GetElsewhereBrandingIcon());
    }

    [Fact]
    public async Task ElsewhereIconPngIsServedPubliclyAsPng()
    {
        using var f = new ApiPluginFixture();
        var c = Controller(f);
        Form(c, "elsewhere-icon.png");
        Assert.IsType<OkObjectResult>(await c.UploadBrandingImage());
        var icon = Assert.IsType<PhysicalFileResult>(Controller(f, false).GetElsewhereBrandingIcon());
        Assert.Equal(Path.Combine(Plugin.BrandingDirectory, "elsewhere-icon.png"), icon.FileName);
        Assert.Equal("image/png", icon.ContentType);
        Assert.True(Assert.IsType<Dictionary<string, bool>>(Assert.IsType<OkObjectResult>(c.GetBrandingStatus()).Value)["elsewhere-icon.png"]);
    }

    [Fact]
    public async Task ElsewhereIconSvgIsServedAsSvgInASandbox()
    {
        using var f = new ApiPluginFixture();
        var c = Controller(f);
        // A prolog and comment longer than 512 bytes before the <svg> element.
        var svg = System.Text.Encoding.UTF8.GetBytes("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!--" + new string('x', 1500) + "-->\n"
            + "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"10\"/><script>alert(1)</script></svg>");
        Form(c, "elsewhere-icon.png", "image/svg+xml", bytes: svg);
        Assert.IsType<OkObjectResult>(await c.UploadBrandingImage());
        var viewer = Controller(f, false);
        var icon = Assert.IsType<PhysicalFileResult>(viewer.GetElsewhereBrandingIcon());
        Assert.Equal("image/svg+xml", icon.ContentType);
        Assert.Contains("sandbox", viewer.Response.Headers["Content-Security-Policy"].ToString());
        Assert.Contains("default-src 'none'", viewer.Response.Headers["Content-Security-Policy"].ToString());
        Assert.Equal("nosniff", viewer.Response.Headers["X-Content-Type-Options"].ToString());
        // The admin preview gets the real type too, not the slot name's.
        Assert.Equal("image/svg+xml", Assert.IsType<PhysicalFileResult>(c.GetBrandingImage("elsewhere-icon.png")).ContentType);
    }

    [Theory]
    [InlineData("image/png", "not an image at all")]
    [InlineData("image/png", "")]
    [InlineData("image/svg+xml", "PAD")] // <svg> beyond the 64 KB sniff window
    public async Task ElsewhereIconRejectsContentThatWouldNotBeServedAsAnImage(string mime, string kind)
    {
        using var f = new ApiPluginFixture();
        var c = Controller(f);
        var body = kind == "PAD"
            ? System.Text.Encoding.UTF8.GetBytes("<?xml version=\"1.0\"?><!--" + new string('x', 70 * 1024) + "--><svg xmlns=\"http://www.w3.org/2000/svg\"/>")
            : System.Text.Encoding.UTF8.GetBytes(kind);
        Form(c, "elsewhere-icon.png", mime, bytes: body);
        Assert.IsType<BadRequestObjectResult>(await c.UploadBrandingImage());
        Assert.False(File.Exists(Path.Combine(Plugin.BrandingDirectory, "elsewhere-icon.png")));
    }

    [Theory]
    [InlineData("image/x-icon")]
    [InlineData("image/bmp")]
    [InlineData("image/tiff")]
    public async Task ElsewhereIconRejectsTypesBrowsersMayNotShow(string mime)
    {
        using var f = new ApiPluginFixture();
        var c = Controller(f);
        Form(c, "elsewhere-icon.png", mime);
        Assert.IsType<BadRequestObjectResult>(await c.UploadBrandingImage());
        Assert.False(File.Exists(Path.Combine(Plugin.BrandingDirectory, "elsewhere-icon.png")));
    }

    [Fact]
    public async Task NonAdminCannotUploadOrDeleteEvenBeforeReadingForm()
    {
        using var f = new ApiPluginFixture();
        var c = Controller(f, false);
        Assert.IsType<ForbidResult>(await c.UploadBrandingImage());
        Assert.IsType<ForbidResult>(c.DeleteBrandingImage());
        Assert.False(Directory.Exists(Plugin.BrandingDirectory));
    }

    [Theory]
    [InlineData(null, "image/png", 1, true)]
    [InlineData("", "image/png", 1, true)]
    [InlineData("unknown.png", "image/png", 1, true)]
    [InlineData("../../private.xml", "image/png", 1, true)]
    [InlineData("icon-transparent.png", "text/html", 1, true)]
    [InlineData("icon-transparent.png", "application/octet-stream", 1, true)]
    [InlineData("icon-transparent.png", "image/png", 10485761, true)]
    [InlineData("icon-transparent.png", "image/png", 1, false)]
    public async Task InvalidUploadsReturn400WithoutChangingExistingAsset(string? name, string mime, long length, bool withFile)
    {
        using var f = new ApiPluginFixture();
        var c = Controller(f);
        Directory.CreateDirectory(Plugin.BrandingDirectory);
        var path = Path.Combine(Plugin.BrandingDirectory, "icon-transparent.png");
        File.WriteAllBytes(path, Png);
        Form(c, name, mime, length, withFile);
        Assert.IsType<BadRequestObjectResult>(await c.UploadBrandingImage());
        Assert.Equal(Png, File.ReadAllBytes(path));
        Assert.Single(Directory.GetFiles(Plugin.BrandingDirectory));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("unknown.png")]
    [InlineData("../../private.xml")]
    public void InvalidReadAndDeleteNamesReturn400(string? name)
    {
        using var f = new ApiPluginFixture();
        var c = Controller(f);
        Form(c, name, withFile: false);
        Assert.IsType<BadRequestObjectResult>(c.GetBrandingImage(name));
        Assert.IsType<BadRequestObjectResult>(c.DeleteBrandingImage());
    }
}
