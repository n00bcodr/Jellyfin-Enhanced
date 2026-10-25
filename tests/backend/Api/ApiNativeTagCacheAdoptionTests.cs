using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Globalization;
using Moq;
namespace JE.Tests;
[Collection("Plugin singleton")]
public class ApiNativeTagCacheAdoptionTests
{
    [Theory]
    [InlineData("transition")][InlineData("patch")]
    public async Task NativeOnlyTagSnapshotSurvivesBackendAdoption(string writer)
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.ArrRequestBackend = "je";
        f.Plugin.Configuration.ArrBackendIsolationVersion = 0;
        f.Plugin.Configuration.TagCacheServerMode = true;
        var user = new User("test", "default", "default") { Id = Guid.NewGuid() };
        var item = Guid.NewGuid();
        var library = new Mock<ILibraryManager>();
        library.Setup(x => x.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns(new[] { item });
        Directory.CreateDirectory(f.Core.ConfigRoot);
        File.WriteAllText(Path.Combine(f.Core.ConfigRoot,"tag-cache.json"),JsonSerializer.Serialize(new
        {
            SchemaVersion = 8, Version = 7, LastModified = 200, LastReconciledUtcTicks = new DateTime(2026,1,1).Ticks,
            Items = new Dictionary<string,TagCacheEntry> { [item.ToString("N")] = new() { Type="Movie",Genres=["Native-only Drama"],LastUpdated=200 } }
        }));
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger);
        cache.LoadFromDisk();
        Assert.True(cache.TryGetEntry(item,out _));
        Assert.Single(cache.GetCacheForUser(user,out _,out _));
        if (writer == "transition") await EffectiveRequestsBackend.Shared.TransitionAsync(() => f.Plugin.Configuration.ArrBackendIsolationVersion = 1,default);
        else f.Plugin.PatchConfiguration(new Jellyfin.Plugin.JellyfinEnhanced.Configuration.ConfigurationPatch { Set = new() { ["ArrBackendIsolationVersion"] = JsonSerializer.SerializeToElement(1) } });
        var after = cache.GetCacheForUser(user,out _,out _);
        Assert.Single(after);
        Assert.True(cache.TryGetEntry(item,out _));
    }
    [Theory]
    [InlineData("transition")][InlineData("patch")]
    public async Task SerializedAndRawNativeReadersAgreeAfterBackendAdoption(string writer)
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.ArrRequestBackend = "je";
        f.Plugin.Configuration.ArrBackendIsolationVersion = 0;
        f.Plugin.Configuration.TagCacheServerMode = true;
        var user = new User("test", "default", "default") { Id = Guid.NewGuid() };
        var item = Guid.NewGuid();
        var library = new Mock<ILibraryManager>();
        library.Setup(x => x.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns(new[] { item });
        Directory.CreateDirectory(f.Core.ConfigRoot);
        File.WriteAllText(Path.Combine(f.Core.ConfigRoot,"tag-cache.json"),JsonSerializer.Serialize(new
        {
            SchemaVersion = 8, Version = 7, LastModified = 200, LastReconciledUtcTicks = new DateTime(2026,1,1).Ticks,
            Items = new Dictionary<string,TagCacheEntry> { [item.ToString("N")] = new() { Type="Movie",Genres=["Native-only Drama"],LastUpdated=200 } }
        }));
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger);
        cache.LoadFromDisk();
        Assert.True(cache.TryGetEntry(item,out _));
        var before = cache.GetShareableCacheForUser(user, out _, out _, out _, out var shareKey);
        Assert.Single(before); Assert.NotNull(shareKey);
        cache.StoreSerializedItems(shareKey!, JsonSerializer.SerializeToUtf8Bytes(before), before.Count);
        if (writer == "transition") await EffectiveRequestsBackend.Shared.TransitionAsync(() => f.Plugin.Configuration.ArrBackendIsolationVersion = 1,default);
        else f.Plugin.PatchConfiguration(new Jellyfin.Plugin.JellyfinEnhanced.Configuration.ConfigurationPatch { Set = new() { ["ArrBackendIsolationVersion"] = JsonSerializer.SerializeToElement(1) } });
        var hit = cache.TryGetSerializedItems(user, out _, out _, out _, out _, out var count, out _);
        Assert.True(hit);
        var raw = cache.GetCacheForUser(user,out _,out _);
        Assert.Equal(raw.Count, count);
    }
}
