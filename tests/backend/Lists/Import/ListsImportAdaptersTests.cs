using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources;

namespace JE.Tests;

// The production adapters behind the import seams: the library lookup (movie / series / season / episodes scopes) and the
// review's placeholder bodies. (#936's real-entry remover is the sync's, track 4c2b; its Seerr account check that gated
// /resolve is replaced: JE imports need no linked Seerr account, ListsImportControllerTests.)
[Collection("Plugin singleton")]
public class ListsImportAdaptersTests
{
    [Fact]
    public void AMatchTMDBHasNoDateForKeepsTheLinesYear()
    {
        // "Batman: Knightfall Part 3: KnightsEnd (2027)" accepted while TMDB's entry has no date yet.
        var undated = new ImportCandidateDto { MediaType = "movie", TmdbId = 1389764, Title = "Batman: Knightfall Part 3: KnightsEnd" };
        var dated = new ImportCandidateDto { MediaType = "movie", TmdbId = 1, Title = "Dated", Year = 2020, ReleaseDate = "2020-05-01" };

        Assert.Equal(2027, ImportPlaceholders.FromCandidate(undated, null, null, null, null, lineYear: 2027)!.Year);
        Assert.Null(ImportPlaceholders.FromCandidate(undated, null, null, null, null)!.Year);
        Assert.Equal(2020, ImportPlaceholders.FromCandidate(dated, null, null, null, null, lineYear: 2027)!.Year); // TMDB's date wins
    }

    [Fact]
    public void TheLibraryLookupUsesTheGranularityResolverForEveryScopeVisibleToEveryUser()
    {
        using var plugin = new ApiPluginFixture();
        var host = new FakeListHost();
        var caller = FakeListHost.MakeUser("caller");
        var owner = FakeListHost.MakeUser("owner");
        var lookup = new ResolverListLibraryLookup(new ListResolver(host, plugin.Core.Logger), host);
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
}
