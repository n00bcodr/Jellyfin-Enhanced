using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Moq;
using User = Jellyfin.Database.Implementations.Entities.User;

namespace JE.Tests;

/// <summary>
/// The absent-title page's library lookup completes only on established exhaustion: a copy found past a row limit or
/// by an alias query past a query cap is still a copy, and the viewer's openable copy is never hidden.
/// </summary>
[Collection("Plugin singleton")]
public class NativeDetailsCopiesTests
{
    private static readonly User Viewer = new("viewer", "default", "default") { Id = Guid.NewGuid() };

    /// <summary>A library that honours the query's row limit; <paramref name="match"/> decides which copies a query finds.</summary>
    private static Mock<ILibraryManager> Library(IReadOnlyList<BaseItem> copies, Func<InternalItemsQuery, BaseItem, bool> match, ISet<Guid> openable, List<InternalItemsQuery>? queries = null)
    {
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
        {
            queries?.Add(q);
            var found = copies.Where(c => match(q, c));
            return (q.Limit is int limit ? found.Take(limit) : found).ToList();
        });
        library.Setup(l => l.GetItemById<BaseItem>(It.IsAny<Guid>(), It.IsAny<User>()))
            .Returns((Guid id, User _) => openable.Contains(id) ? copies.First(c => c.Id == id) : null!);
        return library;
    }

    [Fact]
    public void ATwentyFirstCopyTheViewerCanOpenIsFoundAndNotHidden()
    {
        var copies = Enumerable.Range(0, 21).Select(_ => (BaseItem)new MediaBrowser.Controller.Entities.Movies.Movie { Id = Guid.NewGuid() }).ToList();
        var openable = new HashSet<Guid> { copies[20].Id };
        var library = Library(copies, (_, _) => true, openable);
        var title = new NativeDetailsLibrary(library.Object).ReadCopies(Viewer, "r", movie: true, tmdb: 603);
        Assert.Equal(21, title.Copies.Count);
        Assert.Equal(new[] { copies[20].Id }, title.Shown);
        Assert.False(title.Hidden, "the viewer can open the 21st copy, so the title is not hidden from them");
    }

    [Fact]
    public async Task ACopyOnlyAFifthAliasQueryFindsIsACopy()
    {
        using var arr = new FakeArr();
        // Five Radarr instances hold the same IMDb id under five TMDB ids: movie:tmdb:603 has 604..607 and the IMDb id as aliases.
        var hosts = Enumerable.Range(0, 5).Select(i => arr.Add($"radarr{i}.lan", "Radarr")).ToArray();
        arr.Configure(Enumerable.Range(0, 5).Select(i => ($"Radarr{i}Z", ArrKind.Radarr, $"http://radarr{i}.lan:7878", $"RADARR{i}-KEY-0123456789")).ToArray());
        var config = arr.Plugin.Plugin.Configuration;
        config.ArrIntegrationEnabled = true; config.ArrPhase1Enabled = true;
        for (var i = 0; i < 5; i++)
        {
            var row = FakeArr.Movie(1, 603 + i, "Alias " + i);
            row["imdbId"] = "tt7770777";
            hosts[i].Movies.Add(row);
        }
        var store = arr.Store();
        for (var i = 0; i < 5; i++) Assert.NotNull((await store.GetLibraryAsync(arr.Instance($"Radarr{i}Z"), default)).Value);
        var aliases = new TitleAliases(store, null);
        var key = TitleKey.Parse("movie:tmdb:603")!;
        Assert.Equal(5, aliases.Of(key).Count);

        // The id the shared builder places in its fifth query, where a four-query cap stops.
        var ids = new[] { key.Title }.Concat(aliases.Of(key)).Select(k => (Provider: TitleAliases.ProviderName(k), k.Id)).Distinct().ToList();
        var fifth = ids.Where(i => i.Provider == "Tmdb").Skip(4).Single();
        var copy = new MediaBrowser.Controller.Entities.Movies.Movie { Id = Guid.NewGuid() };
        var queries = new List<InternalItemsQuery>();
        var library = Library(new[] { (BaseItem)copy }, (q, _) => q.HasAnyProviderId?.TryGetValue(fifth.Provider, out var v) == true && v == fifth.Id,
            new HashSet<Guid> { copy.Id }, queries);
        var title = new NativeDetailsLibrary(library.Object, aliases).ReadCopies(Viewer, "r", movie: true, tmdb: 603);
        Assert.Equal(new[] { copy.Id }, title.Copies);
        Assert.Equal(new[] { copy.Id }, title.Shown);
        // Every query was read to its end: none carries a row limit, and every alias was asked for.
        Assert.All(queries, q => Assert.Null(q.Limit));
        Assert.All(ids, id => Assert.Contains(queries, q => q.HasAnyProviderId?.TryGetValue(id.Provider, out var v) == true && v == id.Id));
        Assert.All(queries, q => Assert.Equal(new[] { BaseItemKind.Movie }, q.IncludeItemTypes));
    }
}
