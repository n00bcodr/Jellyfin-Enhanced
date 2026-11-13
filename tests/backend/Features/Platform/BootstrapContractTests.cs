using System.Reflection;
using Jellyfin.Data;
using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Bookmarks;
using Jellyfin.Plugin.JellyfinEnhanced.Transport;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Moq;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Admin.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Settings;
using Jellyfin.Plugin.JellyfinEnhanced.Features.SpoilerGuard.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Features.SpoilerGuard;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Maintenance;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Platform;

namespace JE.Tests.Features.Platform;

[Collection("Plugin singleton")]
public class BootstrapContractTests
{
    private static JePlatformController Controller(ApiPluginFixture fixture, Guid user, bool admin, bool documents = true, params object[] services)
    {
        var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), fixture.Core.Paths.Object, fixture.Core.Logger);
        var controller = ApiAssetTests.Controller(fixture.Core, new object[] { maintenance, documents ? fixture.Core.Manager : new object() }.Concat(services).ToArray());
        controller.HttpContext.User = global::JE.Tests.Features.SpoilerGuard.PrivacyPolicyTests.Principal(user, admin);
        return controller;
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task TypedBootstrapPreservesProjectionDocumentsAndTokenScope(bool admin)
    {
        using var fixture = new ApiPluginFixture();
        var user = Guid.NewGuid();
        var other = Guid.NewGuid();
        fixture.Plugin.Configuration.SonarrUrl = "http://private.invalid";
        fixture.Plugin.Configuration.SonarrApiKey = "never-export-this-key";
        fixture.Core.Manager.SaveUserConfiguration(user.ToString("N"), "bookmark.json", new UserBookmark { Bookmarks = new() { ["mine"] = new BookmarkItem { Name = "My bookmark" } } });
        fixture.Core.Manager.SaveUserConfiguration(other.ToString("N"), "bookmark.json", new UserBookmark { Bookmarks = new() { ["other"] = new BookmarkItem { Name = "Other user" } } });
        var controller = Controller(fixture, user, admin);
        controller.Request.QueryString = new Microsoft.AspNetCore.Http.QueryString("?userId=" + other.ToString("N"));
        var body = Assert.IsType<BootstrapResponse>(Assert.IsType<JsonResult>(controller.GetBootstrap()).Value);
        Assert.Equal(user.ToString("N"), body.UserId);
        Assert.Equal(admin, body.UserSettings.Settings!.IsAdmin);
        Assert.Equal(admin, body.PrivateConfig != null);
        var bookmarks = (JeBookmarksController)ApiAssetTests.Controller(typeof(JeBookmarksController), fixture.Core, fixture.Core.Manager);
        bookmarks.HttpContext.User = controller.HttpContext.User;
        var bookmarkRead = Assert.IsType<BookmarkDocumentResponse>(Assert.IsType<JsonResult>(bookmarks.GetBookmarkDocument(user.ToString("N"))).Value);
        Assert.Equal(bookmarkRead.Revision, body.UserSettings.BookmarkSnapshot!.Revision);
        Assert.Equal(bookmarkRead.Document, body.UserSettings.BookmarkSnapshot.Document);
        Assert.Contains("mine", body.UserSettings.BookmarkSnapshot!.Document);
        Assert.DoesNotContain("other", body.UserSettings.BookmarkSnapshot!.Document);
        Assert.True(JsonNode.DeepEquals(JsonSerializer.SerializeToNode(body.PublicConfig), JsonSerializer.SerializeToNode(Assert.IsType<JsonResult>(controller.GetPublicConfig()).Value)));
        if (admin)
            Assert.True(JsonNode.DeepEquals(JsonSerializer.SerializeToNode(body.PrivateConfig), JsonSerializer.SerializeToNode(Assert.IsType<JsonResult>(controller.GetPrivateConfig()).Value)));
        var json = JsonSerializer.Serialize(body);
        await ValidateClientWire(body, admin);
        Assert.DoesNotContain("never-export-this-key", json);
        Assert.Equal(admin, json.Contains("private.invalid", StringComparison.Ordinal));
        Assert.True(JsonNode.DeepEquals(JsonSerializer.SerializeToNode(body.UserSettings.Settings), JsonSerializer.SerializeToNode(Assert.IsType<OkObjectResult>(ApiAssetTests.Sibling<JeSettingsController>(controller, fixture.Core, fixture.Core.Manager).GetUserSettingsSettings(user.ToString("N"))).Value)));
    }

    [Fact]
    public async Task FailedDocumentsRemainExplicitNullAndDoNotFailTheBootstrap()
    {
        using var fixture = new ApiPluginFixture();
        var controller = Controller(fixture, Guid.NewGuid(), false, documents: false);
        var body = Assert.IsType<BootstrapResponse>(Assert.IsType<JsonResult>(controller.GetBootstrap()).Value);
        var documents = JsonSerializer.SerializeToElement(body.UserSettings);
        Assert.Equal(6, documents.EnumerateObject().Count());
        Assert.All(documents.EnumerateObject(), property => Assert.Equal(JsonValueKind.Null, property.Value.ValueKind));
        Assert.Null(body.PrivateConfig);
        await ValidateClientWire(body, false);
    }

    // Both are saved whole, so an empty stand-in for a stored file that cannot be read becomes the
    // next save. The bootstrap and the fallback endpoints report content that does not parse as failed,
    // and set it aside once, as a save does, so the next read starts from the defaults instead of
    // failing on every page load. The bytes are kept beside the file.
    [Fact]
    public void UnreadableHiddenListAndShortcutsAreReportedAsFailedNotEmpty()
    {
        using var fixture = new ApiPluginFixture();
        var user = Guid.NewGuid();
        var directory = Path.Combine(fixture.Core.ConfigRoot, user.ToString("N"));
        Directory.CreateDirectory(directory);
        const string Stored = "{\"Items\":{\"kept\":";
        var files = new[] { "hidden-content.json", "shortcuts.json" };
        void Store() { foreach (var file in files) File.WriteAllText(Path.Combine(directory, file), Stored); }
        void AssertSetAside(int times)
        {
            foreach (var file in files)
            {
                Assert.False(File.Exists(Path.Combine(directory, file)));
                var copies = Directory.GetFiles(directory, file + ".corrupt-*");
                Assert.Equal(times, copies.Length);
                Assert.All(copies, copy => Assert.Equal(Stored, File.ReadAllText(copy)));
            }
        }
        Store();
        var controller = Controller(fixture, user, false);

        var body = Assert.IsType<BootstrapResponse>(Assert.IsType<JsonResult>(controller.GetBootstrap()).Value);
        Assert.Null(body.UserSettings.HiddenContent);
        Assert.Null(body.UserSettings.Shortcuts);
        AssertSetAside(1);

        Store();
        var hidden = ApiAssetTests.Sibling<Jellyfin.Plugin.JellyfinEnhanced.Features.HiddenContent.JeHiddenContentController>(controller, fixture.Core, fixture.Core.Manager, Mock.Of<IUserManager>());
        Assert.Equal(500, Assert.IsAssignableFrom<ObjectResult>(hidden.GetUserHiddenContent(user.ToString("N"))).StatusCode);
        var settings = ApiAssetTests.Sibling<JeSettingsController>(controller, fixture.Core, fixture.Core.Manager);
        Assert.Equal(500, Assert.IsAssignableFrom<ObjectResult>(settings.GetUserSettingsShortcuts(user.ToString("N"))).StatusCode);
        AssertSetAside(2);

        Assert.IsType<OkObjectResult>(hidden.GetUserHiddenContent(user.ToString("N")));
        Assert.IsType<OkObjectResult>(settings.GetUserSettingsShortcuts(user.ToString("N")));
    }

    // This verifies the generated browser boundary against actual server serialization,
    // not a separately maintained mock of the DTO shape. Node is also required by the build gate.
    private static async Task ValidateClientWire(BootstrapResponse body, bool admin, JsonSerializerOptions? options = null)
    {
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root != null && !File.Exists(Path.Combine(root.FullName, "client/entries/contracts.json"))) root = root.Parent;
        Assert.NotNull(root);
        var start = new System.Diagnostics.ProcessStartInfo("node")
        {
            WorkingDirectory = root.FullName,
            RedirectStandardInput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        start.ArgumentList.Add("tests/frontend/contracts/check-wire.mjs");
        start.ArgumentList.Add(body.UserId);
        start.ArgumentList.Add(admin ? "true" : "false");
        using var process = System.Diagnostics.Process.Start(start)!;
        var error = process.StandardError.ReadToEndAsync();
        await process.StandardInput.WriteAsync(JsonSerializer.Serialize(body, options));
        process.StandardInput.Close();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        await process.WaitForExitAsync(timeout.Token);
        Assert.True(process.ExitCode == 0, await error);
    }

    [Fact]
    public async Task BootstrapContractSurvivesJellyfinSerializationOptions()
    {
        using var fixture = new ApiPluginFixture();
        var controller = Controller(fixture, Guid.NewGuid(), false);
        var result = Assert.IsType<JsonResult>(controller.GetBootstrap());
        var body = Assert.IsType<BootstrapResponse>(result.Value);
        var serializer = Assert.IsType<JsonSerializerOptions>(result.SerializerSettings);
        Assert.Equal(System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull, Jellyfin.Extensions.Json.JsonDefaults.Options.DefaultIgnoreCondition);
        Assert.Equal(System.Text.Json.Serialization.JsonIgnoreCondition.Never, serializer.DefaultIgnoreCondition);
        Assert.True(serializer.IsReadOnly);
        await ValidateClientWire(body, false, serializer);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("legacy")]
    [InlineData("full")]
    public async Task SpoilerStateWireAcceptsEmptyLegacyAndPopulatedDocuments(string document)
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.SpoilerBlurEnabled = true;
        var user = Guid.NewGuid();
        var seriesId = new string('a', 32);
        var state = new UserSpoilerBlur
        {
            Series = new() { [seriesId] = new() { SeriesId = seriesId, SeriesName = "Series" } },
            Movies = new() { [new string('b', 32)] = new() { MovieName = "Movie" } },
            Collections = new() { [new string('c', 32)] = new() { CollectionName = "Collection" } },
            PendingTmdb = new() { ["movie:42"] = new() { MediaType = "movie", TmdbId = "42" } },
            Prefs = new() { HideRatings = false, HideCast = true, SkipDisableConfirm = true }
        };
        if (document == "legacy")
            fixture.Core.Manager.SaveUserConfiguration(user.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName, new { state.Series });
        else if (document == "full")
            fixture.Core.Manager.SaveUserConfiguration(user.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName, state);
        // A viewer with no library, rating or tag limits: every entry is sent.
        var viewer = new Jellyfin.Database.Implementations.Entities.User("viewer", "default", "default") { Id = user };
        viewer.SetPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.EnableAllFolders, true);
        var users = new Mock<IUserManager>(); users.Setup(x => x.GetUserById(user)).Returns(viewer);
        var controller = Controller(fixture, user, false, true, users.Object, Mock.Of<ILibraryManager>());
        var endpoint = Assert.IsType<OkObjectResult>(ApiAssetTests.SiblingOf<JeSpoilerGuardController>(controller).GetSpoilerBlurSeries());
        var bootstrap = Assert.IsType<JsonResult>(controller.GetBootstrap());
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root != null && !File.Exists(Path.Combine(root.FullName, "client/entries/contracts.json"))) root = root.Parent;
        Assert.NotNull(root);
        foreach (var fromBootstrap in new[] { false, true })
        {
            var start = new System.Diagnostics.ProcessStartInfo("node")
            {
                WorkingDirectory = root.FullName,
                RedirectStandardInput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            };
            start.ArgumentList.Add("tests/frontend/contracts/check-spoiler-wire.mjs");
            start.ArgumentList.Add(fromBootstrap ? "bootstrap" : "endpoint");
            using var process = System.Diagnostics.Process.Start(start)!;
            var error = process.StandardError.ReadToEndAsync();
            var options = fromBootstrap ? Assert.IsType<JsonSerializerOptions>(bootstrap.SerializerSettings) : Jellyfin.Extensions.Json.JsonDefaults.Options;
            await process.StandardInput.WriteAsync(JsonSerializer.Serialize(fromBootstrap ? bootstrap.Value : endpoint.Value, options));
            process.StandardInput.Close();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            await process.WaitForExitAsync(timeout.Token);
            Assert.True(process.ExitCode == 0, await error);
        }
    }

    [Fact]
    public void BootstrapRequiresTokenIdentityAndHasNoStoreAuthorizationMetadata()
    {
        using var fixture = new ApiPluginFixture();
        var controller = Controller(fixture, Guid.NewGuid(), false);
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity());
        Assert.IsType<ForbidResult>(controller.GetBootstrap());
        var method = typeof(JePlatformController).GetMethod(nameof(JePlatformController.GetBootstrap))!;
        Assert.NotNull(method.GetCustomAttribute<AuthorizeAttribute>());
        var cache = method.GetCustomAttribute<ResponseCacheAttribute>()!;
        Assert.True(cache.NoStore);
        Assert.Equal(ResponseCacheLocation.None, cache.Location);
    }
}
