using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;

namespace JE.Tests;

/// <summary>
/// The host's item cache is read directly where the host keeps it as Jellyfin's library manager does (a private
/// <c>_cache</c> whose <c>TryGet</c> answers by id without loading anything); any other host is asked by id.
/// </summary>
public class PrivacyItemMemoryTests
{
    private sealed class Cache
    {
        public Dictionary<Guid, BaseItem> Held { get; } = new();

        public bool TryGet(Guid key, out BaseItem value) => Held.TryGetValue(key, out value!);
    }

    private sealed class Host
    {
#pragma warning disable IDE0044, CS0414 // The shape the reader looks for.
        private readonly Cache _cache;
#pragma warning restore IDE0044, CS0414
        public Host(Cache cache) => _cache = cache;
    }

    [Fact]
    public void TheLibraryManagersCacheIsReadByIdWithoutALookup()
    {
        var cache = new Cache();
        var item = new Movie { Id = Guid.NewGuid() };
        cache.Held[item.Id] = item;
        var peek = PrivacyItemMemory.Find(new Host(cache));
        Assert.NotNull(peek);
        Assert.True(peek!(item.Id, out var found));
        Assert.Same(item, found);
        Assert.False(peek(Guid.NewGuid(), out _));
        Assert.Null(PrivacyItemMemory.Find(new object()));
    }
}
