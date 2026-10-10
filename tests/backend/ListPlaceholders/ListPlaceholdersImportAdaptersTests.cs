using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Sources;
using MediaBrowser.Controller.Collections;
using MediaBrowser.Controller.Playlists;
using Moq;

namespace JE.Tests;

// The production adapters behind the import seams: the library lookup (movie / series / season / episodes scopes),
// the real-entry remover, and the Seerr account check that gates /resolve.
[Collection("Plugin singleton")]
public class ListPlaceholdersImportAdaptersTests
{
    [Fact]
    public void TheLibraryLookupUsesTheGranularityResolverForEveryScopeVisibleToEveryUser()
    {
        using var plugin = new ApiPluginFixture();
        var host = new FakeListHost();
        var caller = FakeListHost.MakeUser("caller");
        var owner = FakeListHost.MakeUser("owner");
        var lookup = new ResolverListLibraryLookup(new ListPlaceholderResolver(host, plugin.Core.Logger), host);
        var both = new[] { caller, owner };

        // Movies: TMDB first, then IMDb; every user must be able to access the item.
        var hiddenCopy = host.AddMovie(tmdb: 49521);
        var visibleCopy = host.AddMovie(imdb: "tt0770828");
        host.Hide(hiddenCopy, owner);
        Assert.Equal(visibleCopy, lookup.Find(new LibraryScope(PlaceholderKinds.Movie, 49521, null, "tt0770828", null, null), both, null)!.ItemId);
        Assert.Equal(hiddenCopy, lookup.Find(new LibraryScope(PlaceholderKinds.Movie, 49521, null, null, null, null), new[] { caller }, null)!.ItemId);
        Assert.Null(lookup.Find(new LibraryScope(PlaceholderKinds.Movie, 49521, null, null, null, null), both, null));
        Assert.Null(lookup.Find(new LibraryScope(PlaceholderKinds.Movie, 49521, null, null, null, null), Array.Empty<User>(), null));

        // TV: the SERIES by TVDB here; episodes in order, a multi-episode file covering each number, virtual items and
        // (for a whole series) specials left out.
        var series = host.AddSeries(tvdb: 391153);
        var e23 = host.AddEpisode(series, 1, 2, episodeEnd: 3);
        var e1 = host.AddEpisode(series, 1, 1);
        host.AddEpisode(series, 1, 4, isVirtual: true);
        var special = host.AddEpisode(series, 0, 1);
        var s1Item = host.Seasons[(series, 1)].Id;

        var whole = lookup.Find(new LibraryScope(PlaceholderKinds.Series, 110492, 391153, null, null, null), both, 3)!;
        Assert.Equal((series, true), (whole.ItemId, whole.Complete)); // 3 coordinates of 3
        Assert.Equal(new[] { e1, e23 }, whole.EpisodeIds);
        Assert.False(lookup.Find(new LibraryScope(PlaceholderKinds.Series, 110492, 391153, null, null, null), both, 8)!.Complete);
        Assert.False(lookup.Find(new LibraryScope(PlaceholderKinds.Series, 110492, 391153, null, null, null), both, null)!.Complete);

        var s1 = lookup.Find(new LibraryScope(PlaceholderKinds.Season, 110492, 391153, null, 1, null), both, 8)!;
        Assert.Equal((s1Item, false), (s1.ItemId, s1.Complete)); // "3 of 8"
        Assert.Equal(new[] { e1, e23 }, s1.EpisodeIds);
        Assert.Equal(new[] { special }, lookup.Find(new LibraryScope(PlaceholderKinds.Season, 110492, 391153, null, 0, null), both, 1)!.EpisodeIds);
        Assert.Null(lookup.Find(new LibraryScope(PlaceholderKinds.Season, 110492, 391153, null, 2, null), both, 8));

        var some = lookup.Find(new LibraryScope(PlaceholderKinds.Episodes, 110492, 391153, null, 1, new[] { 3, 1 }), both, null)!;
        Assert.Equal((e1, true), (some.ItemId, some.Complete)); // E3 is covered by the E2-3 file
        Assert.Equal(new[] { e1, e23 }, some.EpisodeIds);
        Assert.False(lookup.Find(new LibraryScope(PlaceholderKinds.Episodes, 110492, 391153, null, 1, new[] { 1, 4 }), both, null)!.Complete); // E4 is virtual
        Assert.Null(lookup.Find(new LibraryScope(PlaceholderKinds.Episodes, 110492, 391153, null, 1, new[] { 9 }), both, null));
        Assert.Null(lookup.Find(new LibraryScope(PlaceholderKinds.Episodes, 110492, 391153, null, null, new[] { 1 }), both, null));

        // An episode the owner can't access isn't offered for a playlist both of them have to see.
        host.Hide(e1, owner);
        Assert.Equal(new[] { e23 }, lookup.Find(new LibraryScope(PlaceholderKinds.Season, 110492, 391153, null, 1, null), both, 8)!.EpisodeIds);
        Assert.Equal(new[] { e1, e23 }, lookup.Find(new LibraryScope(PlaceholderKinds.Season, 110492, 391153, null, 1, null), new[] { caller }, 8)!.EpisodeIds);
        Assert.Null(lookup.Find(new LibraryScope(PlaceholderKinds.Series, 1, null, null, null, null), both, null));
    }

    [Fact]
    public async Task TheRemoverUsesThePlaylistEntryIdsAndTheCollectionApi()
    {
        var playlists = new Mock<IPlaylistManager>();
        var collections = new Mock<ICollectionManager>();
        var remover = new JellyfinListEntryRemover(playlists.Object, collections.Object);
        var item = Guid.NewGuid();
        var playlist = new ListInfo(Guid.NewGuid(), ListKinds.Playlist, "P", Guid.NewGuid(), false, Array.Empty<ListShare>());
        var collection = new ListInfo(Guid.NewGuid(), ListKinds.Collection, "C", Guid.Empty, false, Array.Empty<ListShare>());

        await remover.RemoveAsync(playlist, new[] { item });
        await remover.RemoveAsync(collection, new[] { item });
        await remover.RemoveAsync(collection, Array.Empty<Guid>());

        playlists.Verify(p => p.RemoveItemFromPlaylistAsync(playlist.Id.ToString("N"), It.Is<IEnumerable<string>>(ids => ids.SequenceEqual(new[] { item.ToString("N") }))), Times.Once);
        collections.Verify(c => c.RemoveFromCollectionAsync(collection.Id, It.Is<IEnumerable<Guid>>(ids => ids.SequenceEqual(new[] { item }))), Times.Once);
    }

    [Fact]
    public async Task TheSeerrAccountCheckAllowsAdminsAndLinkedUsersAndCachesAnswers()
    {
        using var plugin = new ApiPluginFixture();
        var config = plugin.Plugin.Configuration;
        var calls = new List<string>();
        var known = "c799f011678d4423bd7c07d24c672de8";
        var userRoute = true;
        using var transport = new IntegrationTransport((request, _) =>
        {
            calls.Add(request.RequestUri!.PathAndQuery);
            var path = request.RequestUri.AbsolutePath;
            if (path == "/api/v1/user/jellyfin/" + known && userRoute)
            {
                return Task.FromResult(IntegrationTransport.Response("{\"id\":2,\"jellyfinUserId\":\"" + known + "\"}"));
            }

            if (path == "/api/v1/user")
            {
                return Task.FromResult(IntegrationTransport.Response("{\"results\":[{\"id\":2,\"jellyfinUserId\":\"c799f011-678d-4423-bd7c-07d24c672de8\"}]}"));
            }

            return Task.FromResult(IntegrationTransport.Response("{\"message\":\"User not found.\"}", 404));
        });
        var link = new SeerrUserLink(transport, plugin.Core.Logger);
        var admin = FakeListHost.MakeUser("admin", admin: true);
        var linked = FakeListHost.MakeUser("linked");
        linked.Id = Guid.ParseExact(known, "N");
        var stranger = FakeListHost.MakeUser("stranger");

        Assert.True(await link.IsAllowedAsync(admin, CancellationToken.None)); // no Seerr needed for admins
        Assert.False(await link.IsAllowedAsync(linked, CancellationToken.None)); // Seerr not configured
        Assert.Empty(calls);

        config.JellyseerrUrls = "http://seerr.test";
        config.JellyseerrApiKey = "k";
        Assert.True(await link.IsAllowedAsync(linked, CancellationToken.None));
        Assert.True(await link.IsAllowedAsync(linked, CancellationToken.None)); // cached
        Assert.Single(calls);
        Assert.False(await link.IsAllowedAsync(stranger, CancellationToken.None)); // 404 + not in the user list
        Assert.Equal(3, calls.Count);

        // A Seerr without the by-Jellyfin-id route: the user list decides.
        userRoute = false;
        var other = new SeerrUserLink(transport, plugin.Core.Logger);
        Assert.True(await other.IsAllowedAsync(linked, CancellationToken.None));

        config.JellyseerrImportBlockedUsers = "c799f011-678d-4423-bd7c-07d24c672de8";
        Assert.False(await new SeerrUserLink(transport, plugin.Core.Logger).IsAllowedAsync(linked, CancellationToken.None));
    }
}
