using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Moq;

namespace JE.Tests;

/// <summary>
/// Jellyfin's library under the production <see cref="ArrJellyfinView"/>, read live from a <see cref="FakeJellyfinView"/>'s
/// copies: one movie or series item per copy, carrying the provider id of every key it is listed under, and item queries
/// that honour the item type, "any of these provider ids", <c>StartIndex</c> and <c>Limit</c>, as Jellyfin's repository does.
/// So a lookup's own bounds (a page size, a cap) apply exactly as on a real server.
/// </summary>
internal static class FakeJellyfinLibrary
{
    /// <summary>The production view over the fake's copies; <paramref name="fail"/> true makes every item query throw.</summary>
    public static ArrJellyfinView Over(FakeJellyfinView view, Func<bool>? fail = null)
    {
        var library = new Mock<ILibraryManager>();
        // One current library holding every copy (the production lookup counts only items under a current library location).
        var root = new Folder { Id = Guid.NewGuid(), Path = "/" };
        List<BaseItem> Query(InternalItemsQuery q)
        {
            if (fail?.Invoke() == true) throw new InvalidOperationException("library query failed");
            var items = new Dictionary<Guid, BaseItem>();
            foreach (var (raw, list) in view.CopiesByKey)
            {
                if (TitleKey.Parse(raw) is not { } key) continue;
                foreach (var (copy, _) in list)
                {
                    if (!items.TryGetValue(copy.ItemId, out var item))
                        items[copy.ItemId] = item = key.IsMovie ? new Movie { Id = copy.ItemId, Path = copy.Path ?? "/copies/" + copy.ItemId.ToString("N") } : new Series { Id = copy.ItemId, Path = copy.Path ?? "/copies/" + copy.ItemId.ToString("N") };
                    item.ProviderIds[TitleAliases.ProviderName(key)] = key.Id;
                }
            }
            var kinds = q.IncludeItemTypes ?? Array.Empty<BaseItemKind>();
            var wanted = q.HasAnyProviderId ?? new Dictionary<string, string>();
            IEnumerable<BaseItem> hits = items.Values
                .Where(i => kinds.Length == 0 || kinds.Contains(i is Movie ? BaseItemKind.Movie : BaseItemKind.Series))
                .Where(i => wanted.Count == 0 || wanted.Any(w => i.ProviderIds.TryGetValue(w.Key, out var v) && v == w.Value))
                .OrderBy(i => i.Id.ToString("N"), StringComparer.Ordinal)
                .Skip(q.StartIndex ?? 0);
            if (q.Limit is int limit) hits = hits.Take(limit);
            return hits.ToList();
        }

        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => Query(q));
        library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => Query(q).Select(i => i.Id).ToList());
        library.Setup(l => l.GetCollectionFolders(It.IsAny<BaseItem>())).Returns(new List<Folder> { root });
        library.Setup(l => l.GetVirtualFolders()).Returns(() => new List<MediaBrowser.Model.Entities.VirtualFolderInfo> { new() { ItemId = root.Id.ToString("N"), Locations = new[] { "/" } } });
        return new ArrJellyfinView(library.Object, Mock.Of<IUserManager>());
    }
}
