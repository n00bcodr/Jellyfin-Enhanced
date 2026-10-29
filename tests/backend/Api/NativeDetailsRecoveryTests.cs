#if JF12
// Partial of ApiNativeDetailsTests (its rig and the native-details pages are Jellyfin 12 only). Temporary failures of an
// absent title's artwork and season/episode lists are answered as temporary (503/429 + Retry-After), never as the
// permanent-looking 404 or the completed empty list a page has no way to recover from; true refusals stay 404.
using System.Net;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;
public partial class ApiNativeDetailsTests
{
    private static Dictionary<string, object?> ImageArgs(Guid owner, string tag) => new() { ["itemId"] = owner, ["imageType"] = ImageType.Primary, ["tag"] = tag, ["maxWidth"] = 300 };

    [Fact]
    public async Task ImageAdmissionPressureIsRetryableAndTheSameGrantLoadsOnceReleased()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        var page = SyntheticId.Movie(693134);
        var owner = Id(page);
        string Grant(int i) => rig.Artwork.Mint(owner, ImageType.Primary, 0, "/pressure" + i + ".jpg", viewer.Id, rig.Policy.Revision(viewer))!;
        rig.ImageGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var held = Enumerable.Range(0, 8).Select(i => Call(rig, "Image", "GetItemImage", null, ImageArgs(owner, Grant(i)))).ToArray();
        try
        {
            Assert.Equal(8, rig.Artwork.InFlightCount);
            var ninth = await Call(rig, "Image", "GetItemImage", null, ImageArgs(owner, Grant(8)));
            Assert.Equal(503, Status(ninth.Result));
            Assert.Equal("2", ninth.Http.Response.Headers["Retry-After"].ToString());
            Assert.Equal("viewer-busy", ninth.Http.Response.Headers["X-JE-Art"].ToString());
            Assert.Equal("private, no-store", ninth.Http.Response.Headers.CacheControl.ToString());
            // Refused work never reached TMDB: only the eight admitted reads did.
            Assert.Equal(8, rig.Hosts.Count);
        }
        finally { rig.ImageGate.TrySetResult(); await Task.WhenAll(held).WaitAsync(TimeSpan.FromSeconds(10)); }
        Assert.All(held, r => Assert.Equal(200, Status(r.Result.Result)));
        // Released: the very same grant loads.
        Assert.IsType<FileContentResult>((await Call(rig, "Image", "GetItemImage", null, ImageArgs(owner, Grant(8)))).Result);
        Assert.True(rig.Artwork.Outcomes[ArtworkOutcome.ViewerBusy] >= 1);
        Assert.Equal(9, rig.Artwork.Outcomes[ArtworkOutcome.Served]);
    }

    [Fact]
    public async Task AnUpstreamOutageIsRetryableAndAFileTmdbDoesNotHaveIsNot()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        var owner = Id(SyntheticId.Movie(693134));
        var status = HttpStatusCode.InternalServerError;
        rig.ImageAnswer = _ => status == HttpStatusCode.OK ? null : new HttpResponseMessage(status);
        var tag = rig.Artwork.Mint(owner, ImageType.Primary, 0, "/outage.jpg", viewer.Id, rig.Policy.Revision(viewer))!;
        var down = await Call(rig, "Image", "GetItemImage", null, ImageArgs(owner, tag));
        Assert.Equal(503, Status(down.Result));
        Assert.Equal("upstream-unavailable", down.Http.Response.Headers["X-JE-Art"].ToString());
        Assert.Equal("2", down.Http.Response.Headers["Retry-After"].ToString());
        // TMDB back: the same grant loads.
        status = HttpStatusCode.OK;
        Assert.IsType<FileContentResult>((await Call(rig, "Image", "GetItemImage", null, ImageArgs(owner, tag))).Result);
        // A file TMDB doesn't have is final: 404 with no reason to ask again.
        status = HttpStatusCode.NotFound;
        var missingTag = rig.Artwork.Mint(owner, ImageType.Primary, 0, "/missing.jpg", viewer.Id, rig.Policy.Revision(viewer))!;
        var missing = await Call(rig, "Image", "GetItemImage", null, ImageArgs(owner, missingTag));
        Assert.Equal(404, Status(missing.Result));
        Assert.False(missing.Http.Response.Headers.ContainsKey("X-JE-Art"));
        Assert.False(missing.Http.Response.Headers.ContainsKey("Retry-After"));
        Assert.Equal("private, no-store", missing.Http.Response.Headers.CacheControl.ToString());
        Assert.Equal(1, rig.Artwork.Outcomes[ArtworkOutcome.NotFound]);
        Assert.Equal(1, rig.Artwork.Outcomes[ArtworkOutcome.Unavailable]);
    }

    [Fact]
    public async Task InvalidRevokedAndDeniedGrantsStay404AndCachedBytesStillNeedTheCurrentPolicy()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        var movie = Id(SyntheticId.Movie(693134));
        var tag = Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", Me(viewer), new() { ["itemId"] = movie })).Result).ImageTags[ImageType.Primary];
        // Served once: the bytes are cached now.
        Assert.IsType<FileContentResult>((await Call(rig, "Image", "GetItemImage", null, ImageArgs(movie, tag))).Result);
        var tampered = tag[..^1] + (tag[^1] == '0' ? '1' : '0');
        var invalid = await Call(rig, "Image", "GetItemImage", null, ImageArgs(movie, tampered));
        Assert.Equal(404, Status(invalid.Result));
        Assert.False(invalid.Http.Response.Headers.ContainsKey("X-JE-Art"));
        // A title the viewer's parental limit refuses (a grant minted under the current revision): 404, no reason.
        var restricted = rig.Person();
        restricted.MaxParentalRatingScore = 10;
        var denied = rig.Artwork.Mint(movie, ImageType.Primary, 0, "/poster.jpg", restricted.Id, rig.Policy.Revision(restricted))!;
        var refusal = await Call(rig, "Image", "GetItemImage", null, ImageArgs(movie, denied));
        Assert.Equal(404, Status(refusal.Result));
        Assert.False(refusal.Http.Response.Headers.ContainsKey("X-JE-Art"));
        Assert.False(refusal.Http.Response.Headers.ContainsKey("Retry-After"));
        // Signed out (the grant's revision moved): the cached bytes are not served; the answer says the grant is stale.
        rig.Policy.Revoke(viewer.Id);
        var revoked = await Call(rig, "Image", "GetItemImage", null, ImageArgs(movie, tag));
        Assert.Equal(404, Status(revoked.Result));
        Assert.Equal("stale-grant", revoked.Http.Response.Headers["X-JE-Art"].ToString());
        Assert.Equal(1, rig.Artwork.Outcomes[ArtworkOutcome.StaleGrant]);
        Assert.True(rig.Artwork.Outcomes[ArtworkOutcome.Refused] >= 2);
        // The page's current answer mints the current grant, which loads.
        var fresh = Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", Me(viewer), new() { ["itemId"] = movie })).Result).ImageTags[ImageType.Primary];
        Assert.NotEqual(tag, fresh);
        Assert.IsType<FileContentResult>((await Call(rig, "Image", "GetItemImage", null, ImageArgs(movie, fresh))).Result);
    }

    [Fact]
    public async Task AStaleGrantOfATitleNowDeniedIsAPlain404WithNoRepairHint()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        var movie = Id(SyntheticId.Movie(693134));
        var tag = Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", Me(viewer), new() { ["itemId"] = movie })).Result).ImageTags[ImageType.Primary];
        Assert.IsType<FileContentResult>((await Call(rig, "Image", "GetItemImage", null, ImageArgs(movie, tag))).Result);
        // A parental limit the title (PG-13) is above: the grant's revision moved AND the title is now denied.
        viewer.MaxParentalRatingScore = 10;
        var denied = await Call(rig, "Image", "GetItemImage", null, ImageArgs(movie, tag));
        Assert.Equal(404, Status(denied.Result));
        Assert.False(denied.Http.Response.Headers.ContainsKey("X-JE-Art"), "no hint that the old URL's viewer could still see it");
        Assert.False(denied.Http.Response.Headers.ContainsKey("Retry-After"));
        Assert.Equal(0, rig.Artwork.Outcomes[ArtworkOutcome.StaleGrant]);
        // Allowed again (the revision still differs from the grant's): now the hint is given.
        viewer.MaxParentalRatingScore = null;
        rig.Policy.Revoke(viewer.Id);
        Assert.Equal("stale-grant", (await Call(rig, "Image", "GetItemImage", null, ImageArgs(movie, tag))).Http.Response.Headers["X-JE-Art"].ToString());
    }

    [Fact]
    public async Task ATransientSeasonFailureIsRetryableAndTheNextReadHasEveryEpisode()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        viewer.DisplayMissingEpisodes = true;
        var me = Me(viewer);
        var args = new Dictionary<string, object?> { ["seriesId"] = Id(SyntheticId.Series(83867)), ["seasonId"] = Id(SyntheticId.SeasonOf(83867, 1)) };
        rig.Source.SeasonsDown = true;
        var down = await Call(rig, "TvShows", "GetEpisodes", me, new(args));
        Assert.Equal(503, Status(down.Result));
        Assert.Equal("2", down.Http.Response.Headers["Retry-After"].ToString());
        Assert.Equal("private, no-store", down.Http.Response.Headers.CacheControl.ToString());
        rig.Source.SeasonsDown = false;
        var items = Value<QueryResult<BaseItemDto>>((await Call(rig, "TvShows", "GetEpisodes", me, new(args))).Result).Items;
        Assert.Equal(3, items.Count);
        var first = items[0];
        Assert.Equal("Kassa", first.Name);
        Assert.Equal("Cassian looks for his sister.", first.Overview);
        Assert.Equal(TimeSpan.FromMinutes(40).Ticks, first.RunTimeTicks);
        Assert.StartsWith(NativeDetailsArtwork.Prefix, first.ImageTags[ImageType.Primary]);
        // A season the source has no data of is a verified empty list; a viewer who hides missing episodes gets none.
        Assert.Empty(Value<QueryResult<BaseItemDto>>((await Call(rig, "TvShows", "GetEpisodes", me, new() { ["seriesId"] = Id(SyntheticId.Series(83867)), ["seasonId"] = Id(SyntheticId.SeasonOf(83867, 2)) })).Result).Items);
        viewer.DisplayMissingEpisodes = false;
        Assert.Empty(Value<QueryResult<BaseItemDto>>((await Call(rig, "TvShows", "GetEpisodes", me, new(args))).Result).Items);
    }

    [Fact]
    public async Task ALibraryThatCannotBeReadIsRetryableNotAHiddenTitle()
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        viewer.DisplayMissingEpisodes = true;
        var me = Me(viewer);
        var series = Id(SyntheticId.Series(83867));
        var season = Id(SyntheticId.SeasonOf(83867, 1));
        rig.Library.Setup(l => l.GetItemList(It.IsAny<MediaBrowser.Controller.Entities.InternalItemsQuery>())).Throws(new InvalidOperationException("database is locked"));
        foreach (var (controller, action, args) in new[]
        {
            ("UserLibrary", "GetItem", new Dictionary<string, object?> { ["itemId"] = season }),
            ("TvShows", "GetSeasons", new Dictionary<string, object?> { ["seriesId"] = series }),
            ("TvShows", "GetEpisodes", new Dictionary<string, object?> { ["seriesId"] = series, ["seasonId"] = season }),
        })
        {
            var run = await Call(rig, controller, action, me, args);
            Assert.Equal(503, Status(run.Result));
            Assert.Equal("2", run.Http.Response.Headers["Retry-After"].ToString());
        }

        Assert.True(rig.Policy.Physical(viewer, SyntheticId.SeasonOf(83867, 1)).Hides(SyntheticId.SeasonOf(83867, 1)), "still fails closed for every other reader");
        // The library readable again: the page and its lists answer.
        rig.Library.Setup(l => l.GetItemList(It.IsAny<MediaBrowser.Controller.Entities.InternalItemsQuery>())).Returns(new List<MediaBrowser.Controller.Entities.BaseItem>());
        Assert.Equal(200, Status((await Call(rig, "UserLibrary", "GetItem", me, new() { ["itemId"] = season })).Result));
        Assert.Equal(3, Value<QueryResult<BaseItemDto>>((await Call(rig, "TvShows", "GetEpisodes", me, new() { ["seriesId"] = series, ["seasonId"] = season })).Result).Items.Count);
    }
}
#endif
