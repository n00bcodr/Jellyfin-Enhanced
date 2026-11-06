using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Globalization;
using Moq;
using Xunit;

namespace JellyfinEnhanced.Tests;

/// <summary>
/// Paged full loads (GET tag-cache?limit=&amp;after=) read one shared, ordinally sorted key index per key set instead
/// of scanning and sorting the remaining library for every page: built once while no key is added or removed,
/// again after one is, never for a value replaced under an existing key.
/// </summary>
[Collection("Plugin singleton")]
public class PrivacyCachePagingTests
{
    [Fact]
    public void A_full_load_pages_every_visible_key_once_in_order_from_one_index()
    {
        using var f = new JE.Tests.ApiPluginFixture(); f.Plugin.Configuration.TagCacheServerMode = true;
        var ids = Enumerable.Range(0, 10_000).Select(_ => Guid.NewGuid()).ToArray();
        var library = new Mock<ILibraryManager>(); library.Setup(x => x.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns(ids);
        Seed(f, ids.ToDictionary(id => id.ToString("N"), _ => Entry(100)));
        using var cache = Create(f, library); cache.LoadFromDisk();
        var viewer = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var before = cache.SortedKeyBuilds;

        var (seen, pages, revisions) = LoadAll(cache, viewer, 2000);

        Assert.Equal(ids.Select(id => id.ToString("N")).OrderBy(k => k, StringComparer.Ordinal), seen);
        Assert.Equal(5, pages);
        Assert.Equal(1, cache.SortedKeyBuilds - before);
        // The same access revision as a whole-cache read, on every page.
        cache.GetCacheForUser(viewer, out _, out _, out var whole);
        Assert.All(revisions, r => Assert.Equal(whole, r));
        // Another load and VisibleKeys reuse the index.
        LoadAll(cache, viewer, 3000);
        Assert.Equal(seen, cache.VisibleKeys(viewer, cache.Version));
        Assert.Equal(1, cache.SortedKeyBuilds - before);
    }

    [Fact]
    public void A_restricted_user_pages_only_visible_keys_and_no_cursor_names_a_hidden_one()
    {
        using var f = new JE.Tests.ApiPluginFixture(); f.Plugin.Configuration.TagCacheServerMode = true;
        var ids = Enumerable.Range(0, 3000).Select(_ => Guid.NewGuid()).ToArray();
        var visible = ids.Where((_, i) => i % 3 == 0).ToArray();
        var library = new Mock<ILibraryManager>(); library.Setup(x => x.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns(visible);
        Seed(f, ids.ToDictionary(id => id.ToString("N"), _ => Entry(100)));
        using var cache = Create(f, library); cache.LoadFromDisk();
        var viewer = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var hidden = ids.Except(visible).Select(id => id.ToString("N")).ToHashSet();

        var (seen, _, revisions) = LoadAll(cache, viewer, 250, cursor => Assert.DoesNotContain(cursor, hidden));

        Assert.Equal(visible.Select(id => id.ToString("N")).OrderBy(k => k, StringComparer.Ordinal), seen);
        cache.GetCacheForUser(viewer, out _, out _, out var whole);
        Assert.NotEqual("all", whole);
        Assert.All(revisions, r => Assert.Equal(whole, r));
        // A cursor past the last visible key ends the load: no entries, no cursor.
        Assert.Empty(cache.GetCachePageForUser(viewer, seen[^1], 250, out _, out _, out _, out var end));
        Assert.Null(end);
    }

    [Fact]
    public void The_index_is_read_again_only_when_a_key_is_added_or_removed()
    {
        using var f = new JE.Tests.ApiPluginFixture(); f.Plugin.Configuration.TagCacheServerMode = true;
        var ids = Enumerable.Range(0, 500).Select(_ => Guid.NewGuid()).ToList();
        // The item added later is visible from the start (access sets are cached for a minute).
        var added = Guid.NewGuid();
        var library = new Mock<ILibraryManager>(); library.Setup(x => x.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns(ids.Append(added).ToArray());
        Seed(f, ids.ToDictionary(id => id.ToString("N"), _ => Entry(100)));
        using var cache = Create(f, library); cache.LoadFromDisk();
        var viewer = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        LoadAll(cache, viewer, 100);
        var builds = cache.SortedKeyBuilds;

        // A value replaced under an existing key keeps the index.
        cache.PutEntry(ids[7], Entry(300));
        LoadAll(cache, viewer, 100);
        Assert.Equal(builds, cache.SortedKeyBuilds);

        // A new key: read once more, and the next load carries it.
        cache.PutEntry(added, Entry(400));
        var (afterAdd, _, _) = LoadAll(cache, viewer, 100);
        Assert.Contains(added.ToString("N"), afterAdd);
        Assert.Equal(builds + 1, cache.SortedKeyBuilds);
        LoadAll(cache, viewer, 100);
        Assert.Equal(builds + 1, cache.SortedKeyBuilds);

        // A removal: read once more, and the key is gone.
        Assert.True(cache.RemoveEntry(ids[3]));
        var (afterRemove, _, _) = LoadAll(cache, viewer, 100);
        Assert.DoesNotContain(ids[3].ToString("N"), afterRemove);
        Assert.Equal(builds + 2, cache.SortedKeyBuilds);
    }

    /// <summary>Page through a whole load as the browser does (tag-pipeline.js downloadFullCache); returns the keys, the page count and each page's access revision.</summary>
    private static (List<string> Keys, int Pages, List<string> Revisions) LoadAll(TagCacheService cache, User user, int limit, Action<string>? onCursor = null)
    {
        var keys = new List<string>(); var revisions = new List<string>(); string? after = null; var pages = 0;
        do
        {
            var page = cache.GetCachePageForUser(user, after, limit, out _, out _, out var revision, out var next);
            pages++;
            Assert.True(page.Count <= limit);
            keys.AddRange(page.Keys.OrderBy(k => k, StringComparer.Ordinal));
            revisions.Add(revision);
            if (next != null) { onCursor?.Invoke(next); Assert.Equal(page.Keys.Max(StringComparer.Ordinal), next); }
            after = next;
        }
        while (after != null && pages < 10_000);
        Assert.Equal(keys.Distinct().Count(), keys.Count);
        return (keys, pages, revisions);
    }

    private static TagCacheService Create(JE.Tests.ApiPluginFixture f, Mock<ILibraryManager> library) => new(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new Jellyfin.Plugin.JellyfinEnhanced.Helpers.MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
    private static TagCacheEntry Entry(long updated) => new() { Type = "Movie", Genres = ["Drama"], LastUpdated = updated };
    private static void Seed(JE.Tests.ApiPluginFixture f, Dictionary<string, TagCacheEntry> items)
    {
        Directory.CreateDirectory(f.Core.ConfigRoot);
        File.WriteAllText(Path.Combine(f.Core.ConfigRoot, "tag-cache.json"), JsonSerializer.Serialize(new { SchemaVersion = TagCacheService.CurrentCacheSchemaVersion, Version = 7, LastModified = 200, LastReconciledUtcTicks = new DateTime(2026, 1, 1).Ticks, Items = items }));
    }
}
