using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class PrivacyDddSpoilerTests
{
    private sealed class Rig : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public TestCallers Callers { get; } = new();
        public Guid Viewer { get; } = Guid.NewGuid();
        public Mock<IItemRepository> Repository { get; } = new();
        public Mock<ILibraryManager> Library { get; } = new();
        private readonly DoesTheDogDieService service;
        public UserSpoilerBlur State { get; } = new();
        public Rig()
        {
            Callers.Register(Viewer, false);
            Plugin.Plugin.Configuration.DoesTheDogDieEnabled = true;
            Plugin.Plugin.Configuration.DoesTheDogDieApiKey = "test-only-key";
            Plugin.Plugin.Configuration.SpoilerBlurEnabled = true;
            Directory.CreateDirectory(Plugin.Core.ConfigRoot);
            File.WriteAllText(Path.Combine(Plugin.Core.ConfigRoot, "ddd-cache.json"), JsonSerializer.Serialize(new DddCacheDiskFormat {
                SchemaVersion = 1, Items = new() { ["movie-123"] = Entry(), ["tv-123"] = Entry() }
            }));
            service = new DoesTheDogDieService(Mock.Of<IHttpClientFactory>(), Plugin.Core.Paths.Object, Plugin.Core.Logger);
            Repository.Setup(r => r.GetItemIdsList(It.IsAny<InternalItemsQuery>())).Returns(Array.Empty<Guid>());
        }
        private static DddCacheEntry Entry() => new() { Found = true, Confirmed = true, ItemId = 12, Name = "Title", FetchedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), Topics = [new() { Id = 1, Name = "A major character dies", Yes = 9, No = 1 }] };
        public void Save() => Plugin.Core.Manager.SaveUserConfiguration(Viewer.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName, State);
        public async Task<(JsonElement Body, JellyfinEnhancedController Controller)> Read(string type = "movie", bool reveal = false, string? revision = null, Guid? viewer = null)
        {
            var resolver = new SpoilerUserResolver(Plugin.Core.Manager, Library.Object, Plugin.Core.Logger, null!);
            var controller = ApiAssetTests.Controller(Plugin.Core, service, Plugin.Core.Manager, Repository.Object, Library.Object, resolver, Callers.Users.Object);
            controller.HttpContext.User = TestCallers.Principal(viewer ?? Viewer, false);
            // Reflection keeps this tests-first probe executable on the pre-fix signature too.
            var method = typeof(JellyfinEnhancedController).GetMethod(nameof(controller.GetDoesTheDogDie))!;
            var args = method.GetParameters().Select(p => p.Name switch { "mediaType" => (object)type, "tmdbId" => "123", "cancellationToken" => CancellationToken.None, "reveal" => reveal, "policyRevision" => revision, _ => p.DefaultValue }).ToArray();
            var result = await (Task<IActionResult>)method.Invoke(controller, args)!;
            return (JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(result).Value), controller);
        }
        public void Dispose() { service.Dispose(); Plugin.Dispose(); }
    }

    [Theory]
    [InlineData("movie", false)] [InlineData("movie", true)]
    [InlineData("tv", false)] [InlineData("tv", true)]
    public async Task GuardedAbsentAndLibraryTitlesReturnNoTopicsUntilThisViewerExplicitlyReveals(string type, bool library)
    {
        using var rig = new Rig();
        if (library)
        {
            var id = Guid.NewGuid();
            BaseItem item = type == "movie" ? new Movie { Id = id } : new Series { Id = id };
            rig.Library.Setup(l => l.GetItemById(id)).Returns(item);
            rig.Repository.Setup(r => r.GetItemIdsList(It.Is<InternalItemsQuery>(q => q.HasAnyProviderId!["Tmdb"] == "123" && q.IncludeItemTypes!.Contains(type == "movie" ? BaseItemKind.Movie : BaseItemKind.Series)))).Returns(new[] { id });
            if (type == "movie") rig.State.Movies[id.ToString("N")] = new(); else rig.State.Series[id.ToString("N")] = new();
        }
        else rig.State.PendingTmdb[$"{type}:123"] = new();
        rig.Save();
        var hidden = await rig.Read(type);
        Assert.DoesNotContain("A major character dies", hidden.Body.GetRawText());
        Assert.True(hidden.Body.GetProperty("Guarded").GetBoolean());
        var revision = hidden.Body.GetProperty("PolicyRevision").GetString();
        var shown = await rig.Read(type, true, revision);
        Assert.Contains("A major character dies", shown.Body.GetRawText());
        var another = Guid.NewGuid(); rig.Callers.Register(another, false);
        rig.Plugin.Core.Manager.SaveUserConfiguration(another.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName, rig.State);
        var other = await rig.Read(type, true, revision, another);
        Assert.DoesNotContain("A major character dies", other.Body.GetRawText());
        Assert.Equal("private, no-store", shown.Controller.Response.Headers.CacheControl);
    }

    [Fact]
    public async Task WarmRawCacheCannotBypassAProtectionChangeAndOldRevealsAreInvalidated()
    {
        using var rig = new Rig(); rig.Save();
        var plain = await rig.Read(); Assert.Contains("A major character dies", plain.Body.GetRawText());
        rig.State.PendingTmdb["movie:123"] = new(); rig.Save();
        var hidden = await rig.Read(); Assert.DoesNotContain("A major character dies", hidden.Body.GetRawText());
        var revision = hidden.Body.GetProperty("PolicyRevision").GetString();
        Assert.Contains("A major character dies", (await rig.Read(reveal: true, revision: revision)).Body.GetRawText());
        rig.State.PendingTmdb["movie:456"] = new(); rig.Save();
        var changed = await rig.Read(reveal: true, revision: revision);
        Assert.DoesNotContain("A major character dies", changed.Body.GetRawText());
        Assert.NotEqual(revision, changed.Body.GetProperty("PolicyRevision").GetString());
        rig.Plugin.Plugin.Configuration.SpoilerBlurEnabled = false;
        Assert.Contains("A major character dies", (await rig.Read()).Body.GetRawText());
    }

    [Fact]
    public async Task AViewerWhoNeverSavedSpoilerSettingsSeesWarningsButCorruptSettingsStayClosed()
    {
        using var rig = new Rig();
        // No spoilerblur.json yet: nothing is guarded for this viewer.
        var fresh = await rig.Read();
        Assert.False(fresh.Body.GetProperty("Guarded").GetBoolean());
        Assert.Contains("A major character dies", fresh.Body.GetRawText());

        // The request that finds the file unreadable fails closed, also as a reveal. The read quarantines the file,
        // so later requests see default settings, like every other Spoiler Guard surface after a reset.
        rig.State.PendingTmdb["movie:123"] = new(); rig.Save();
        var file = Directory.GetFiles(rig.Plugin.Core.ConfigRoot, SpoilerBlurImageFilter.SpoilerBlurFileName, SearchOption.AllDirectories)
            .Single(p => p.Contains(rig.Viewer.ToString("N"), StringComparison.OrdinalIgnoreCase));
        var guarded = await rig.Read();
        var revision = guarded.Body.GetProperty("PolicyRevision").GetString();
        File.WriteAllText(file, "{ not json");
        var corrupt = await rig.Read(reveal: true, revision: revision);
        Assert.True(corrupt.Body.GetProperty("Guarded").GetBoolean());
        Assert.DoesNotContain("A major character dies", corrupt.Body.GetRawText());
        Assert.False(File.Exists(file), "the unreadable file was quarantined");
        Assert.Contains("A major character dies", (await rig.Read()).Body.GetRawText());
    }

    [Fact]
    public async Task SpoilerSettingsThatCantBeInspectedAreNotTreatedAsMissing()
    {
        if (OperatingSystem.IsWindows()) return;
        using var rig = new Rig();
        rig.State.PendingTmdb["movie:123"] = new(); rig.Save();
        var file = Directory.GetFiles(rig.Plugin.Core.ConfigRoot, SpoilerBlurImageFilter.SpoilerBlurFileName, SearchOption.AllDirectories)
            .Single(p => p.Contains(rig.Viewer.ToString("N"), StringComparison.OrdinalIgnoreCase));
        var folder = Path.GetDirectoryName(file)!;
        var mode = File.GetUnixFileMode(folder);
        File.SetUnixFileMode(folder, UnixFileMode.UserRead | UnixFileMode.UserWrite); // no search permission
        try
        {
            try { File.ReadAllText(file); return; } catch (UnauthorizedAccessException) { } // root ignores the mode
            var blocked = await rig.Read();
            Assert.True(blocked.Body.GetProperty("Guarded").GetBoolean());
            Assert.DoesNotContain("A major character dies", blocked.Body.GetRawText());
        }
        finally { File.SetUnixFileMode(folder, mode); }
    }
}
