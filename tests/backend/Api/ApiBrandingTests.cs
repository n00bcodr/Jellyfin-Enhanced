using System.Security.Claims;
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
    private static void Form(JellyfinEnhancedController c, string? name, string mime = "image/png", long? length = null, bool withFile = true)
    {
        var files = new FormFileCollection();
        if (withFile) files.Add(new FormFile(new MemoryStream(Png), 0, length ?? Png.Length, "file", "client-name.png") { Headers = new HeaderDictionary(), ContentType = mime });
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
        Assert.Equal(5, status.Count);
        var image = Assert.IsType<PhysicalFileResult>(c.GetBrandingImage(requestedName));
        Assert.Equal(canonicalPath, image.FileName);
        Assert.Equal("image/png", image.ContentType);
        Assert.IsType<OkObjectResult>(c.DeleteBrandingImage());
        Assert.False(File.Exists(canonicalPath));
        Assert.IsType<NotFoundObjectResult>(c.DeleteBrandingImage());
        Assert.IsType<NotFoundResult>(c.GetBrandingImage(requestedName));
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
