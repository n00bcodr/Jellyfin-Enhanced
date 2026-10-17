using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using Moq;

namespace JE.Tests;

/// <summary>
/// Phase 4e: the Jellyfin adapter of the stamp code. The 4K copies are read with two size queries that ask Jellyfin for
/// provider ids (Jellyfin 12 loads them only when asked; without them a 4K movie has no title key and never gets the
/// 4K stamp), and a Jellyfin movie becomes a stamp item with its title keys.
/// </summary>
public class IntegrationAcquisitionStampLibraryTests
{
    private static Movie UhdMovie(int width = 3840, int height = 2160)
    {
        var movie = new Movie { Id = Guid.NewGuid(), Name = "The Matrix", Width = width, Height = height, DateCreated = new DateTime(2026, 9, 1, 0, 0, 0, DateTimeKind.Utc), Path = "/movies/matrix-2160p.mkv" };
        movie.SetProviderId(MetadataProvider.Tmdb, "603");
        movie.SetProviderId(MetadataProvider.Imdb, "tt0133093");
        return movie;
    }

    [Fact]
    public void TheFourKQueriesAskForProviderIdsAndAFourKMovieKeepsItsTitleKeys()
    {
        var uhd = UhdMovie();
        var queries = new List<InternalItemsQuery>();
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
        {
            queries.Add(q);
            return new BaseItem[] { uhd }.ToList();
        });
        using var adapter = new JellyfinStampLibrary(library.Object, Mock.Of<IUserDataManager>(), new PosterTagUserCache(Mock.Of<IUserManager>()));

        var found = adapter.FourKVideos();

        Assert.Equal(2, queries.Count);
        Assert.Equal(3200, queries[0].MinWidth);
        Assert.Null(queries[0].MinHeight);
        Assert.Null(queries[1].MinWidth);
        Assert.Equal(2000, queries[1].MinHeight);
        Assert.All(queries, q =>
        {
            Assert.Equal(new[] { BaseItemKind.Movie, BaseItemKind.Episode }.OrderBy(k => k), q.IncludeItemTypes.OrderBy(k => k));
            Assert.False(q.IsVirtualItem ?? true);
            Assert.True(q.Recursive);
            Assert.NotNull(q.DtoOptions);
            Assert.Contains(ItemFields.ProviderIds, q.DtoOptions.Fields);
        });

        var item = Assert.Single(found);                        // the same movie from both queries, once
        Assert.Equal((uhd.Id, "movie", true), (item.Id, item.Kind, item.FourK));
        Assert.Equal(new[] { "movie:imdb:tt0133093", "movie:tmdb:603" }, item.Keys.Select(k => k.ToString()).OrderBy(k => k, StringComparer.Ordinal));
    }

    [Fact]
    public void AMovieBecomesAStampItemWithItsKeysSizeAndPath()
    {
        var uhd = UhdMovie();
        var item = JellyfinStampLibrary.From(uhd)!;
        Assert.Equal(new[] { "movie:imdb:tt0133093", "movie:tmdb:603" }, item.Keys.Select(k => k.ToString()).OrderBy(k => k, StringComparer.Ordinal));
        Assert.Equal((3840, 2160, true, "/movies/matrix-2160p.mkv", false), (item.Width, item.Height, item.FourK, item.Path, item.Virtual));
        Assert.Equal(DateTimeKind.Utc, item.DateCreated.Kind);
        Assert.Equal(uhd.DateCreated, item.DateCreated);

        // Without its provider ids (what Jellyfin 12 hands back when they weren't asked for) a movie has no key at all:
        // why the 4K queries must ask for them.
        var bare = new Movie { Id = Guid.NewGuid(), Width = 3840, Height = 2160 };
        Assert.Empty(JellyfinStampLibrary.From(bare)!.Keys);
        Assert.Null(JellyfinStampLibrary.From(null));
        Assert.Null(JellyfinStampLibrary.From(new Folder { Id = Guid.NewGuid() }));
    }

    [Fact]
    public void AFourKMovieFromTheAdapterGivesItsOtherCopiesTheFourKStamp()
    {
        // End to end over the resolver: the standard copy's card shows 4K because the 4K movie carries the same key.
        using var w = new StampWorld();
        var uhd = JellyfinStampLibrary.From(UhdMovie())!;
        var standard = w.AddMovie(StampWorld.Movie(603), StampWorld.T0.AddDays(-30));
        w.Library.Put(uhd);
        Assert.Equal(AcquisitionStamp.FourK, w.Resolver.Resolve(standard.Id, Guid.NewGuid(), StampWorld.T0));
        w.Library.Put(uhd with { Keys = JellyfinStampLibrary.From(new Movie { Id = uhd.Id, Width = 3840, Height = 2160 })!.Keys });
        w.Resolver.Invalidate();
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(standard.Id, Guid.NewGuid(), StampWorld.T0));
    }
}
