#if JF12
// Partial of ApiNativeDetailsTests (its rig and the native-details pages are Jellyfin 12 only). Temporary failures of an
// absent title's artwork and season/episode lists are answered as temporary (503/429 + Retry-After), never as the
// permanent-looking 404 or the completed empty list a page has no way to recover from; true refusals stay 404.
using System.Net;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
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

    /// <summary>A rig in JE mode whose title (rated G in the US) the viewer's limit allows until the region moves to AU.</summary>
    private static async Task<(Rig Rig, User Viewer, Guid Movie, string Tag)> WithheldRig()
    {
        var rig = new Rig();
        rig.Plugin.Plugin.Configuration.ArrRequestBackend = "je";
        rig.Plugin.Plugin.Configuration.TMDB_API_KEY = "test-tmdb";
        rig.R4JeTransport = true;
        var viewer = rig.Person();
        viewer.MaxParentalRatingScore = 10;
        var movie = Id(SyntheticId.Movie(693134));
        var dto = Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", Me(viewer), new() { ["itemId"] = movie })).Result);
        rig.R4IncludePublicationFilter = true;
        return (rig, viewer, movie, dto.ImageTags[ImageType.Primary]);
    }

    /// <summary>
    /// The response as it leaves: the result's status (and the response's own, when the guard set it), every header and
    /// the body's length.
    /// </summary>
    private static (int Status, string Headers, long Body) Leaves(Run run)
    {
        var status = Status(run.Result);
        Assert.True(run.Http.Response.StatusCode is 200 || run.Http.Response.StatusCode == status, "the response's own status is the result's");
        var headers = string.Join("\n", run.Http.Response.Headers.OrderBy(h => h.Key, StringComparer.OrdinalIgnoreCase).Select(h => h.Key.ToLowerInvariant() + ": " + h.Value));
        var body = run.Result switch { FileContentResult f => f.FileContents.Length, ObjectResult o when o.Value != null => -1, _ => 0 };
        return (status, headers, body);
    }

    /// <summary>
    /// A confirmed denial of the rig's title, moving the parental evidence: TMDB now rates it PG-13 in the US (above the
    /// viewer's limit of 10) and its metadata credential rotates (the evidence revision moves).
    /// </summary>
    private static void DenyByEvidence(Rig rig)
    {
        rig.R4JeTransport = false;
        rig.Rating = "PG-13";
        EvidenceRevision.Advance(() => rig.Plugin.Plugin.Configuration.TMDB_API_KEY = "rotated-credential-" + Guid.NewGuid().ToString("N"));
    }

    [Fact]
    public async Task ArtworkWithheldAtTheFinalPrivacyGateIsExactlyTheMissingImage404()
    {
        // D121 ACR-1: an image refused for now (TMDB 503: a reason header) whose title becomes denied before the answer
        // leaves is withheld as the plain 404 of a missing image: same status, same headers, no body, no reason or hint.
        var (rig, viewer, movie, tag) = await WithheldRig();
        using var owner = rig;
        rig.ImageAnswer = req => new HttpResponseMessage(req.RequestUri!.AbsolutePath.Contains("missing", StringComparison.Ordinal) ? HttpStatusCode.NotFound : HttpStatusCode.ServiceUnavailable);
        var missingTag = rig.Artwork.Mint(movie, ImageType.Primary, 0, "/missing.jpg", viewer.Id, rig.Policy.Revision(viewer))!;
        var missing = Leaves(await Call(rig, "Image", "GetItemImage", null, ImageArgs(movie, missingTag)));
        Assert.Equal(404, missing.Status);
        rig.ImageStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);
        rig.ImageGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var pending = Call(rig, "Image", "GetItemImage", null, ImageArgs(movie, tag));
        await rig.ImageStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        DenyByEvidence(rig);
        rig.ImageGate.SetResult();
        var withheld = await pending.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(NativeDetailsPolicy.Access.Refused, await rig.Policy.ListAbsentAccessAsync(viewer, SyntheticId.Movie(693134), CancellationToken.None));
        Assert.Equal(missing, Leaves(withheld));
        Assert.DoesNotContain("x-je-art", missing.Headers, StringComparison.Ordinal);
        Assert.DoesNotContain("retry-after", missing.Headers, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AStaleGrantHintNeverSurvivesTheFinalDenial()
    {
        // D121 ACR-1: a stale grant whose title becomes denied during its last checks: the hint never leaves; the answer is
        // header-for-header the missing image's 404.
        var (rig, viewer, movie, tag) = await WithheldRig();
        using var owner = rig;
        rig.ImageAnswer = _ => new HttpResponseMessage(HttpStatusCode.NotFound);
        var missingTag = rig.Artwork.Mint(movie, ImageType.Primary, 0, "/missing.jpg", viewer.Id, rig.Policy.Revision(viewer))!;
        var missing = Leaves(await Call(rig, "Image", "GetItemImage", null, ImageArgs(movie, missingTag)));
        rig.Policy.Revoke(viewer.Id);
        var once = 0;
        rig.Library.Setup(l => l.GetItemList(It.IsAny<MediaBrowser.Controller.Entities.InternalItemsQuery>())).Returns(() =>
        {
            if (Interlocked.Exchange(ref once, 1) == 0) DenyByEvidence(rig);
            return new List<MediaBrowser.Controller.Entities.BaseItem>();
        });
        var denied = await Call(rig, "Image", "GetItemImage", null, ImageArgs(movie, tag));
        Assert.Equal(NativeDetailsPolicy.Access.Refused, await rig.Policy.ListAbsentAccessAsync(viewer, SyntheticId.Movie(693134), CancellationToken.None));
        Assert.Equal(missing, Leaves(denied));
    }

    [Fact]
    public async Task AnAllowedImageWhoseEvidenceMovesDuringATemporaryFailureStaysRetryable()
    {
        // D110 ACR-R2-1 (the round-2 review's counterexample): recovery is already active (the host's load got 503); while
        // its re-ask meets another temporary upstream failure, the parental evidence moves (a metadata credential rotates)
        // but the viewer, the title and the grant all still allow the image. The privacy decision is made first: not a
        // denial, so the answer stays the retryable 503 + Retry-After with the generic reason any busy answer has; never
        // the terminal plain 404, and nothing that tells this title's uncertainty from any other.
        var (rig, viewer, movie, tag) = await WithheldRig();
        using var owner = rig;
        var originalRevision = rig.Policy.Revision(viewer);
        rig.ImageAnswer = _ => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
        Assert.Equal(503, Status((await Call(rig, "Image", "GetItemImage", null, ImageArgs(movie, tag))).Result));
        rig.ImageStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);
        rig.ImageGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var reask = Call(rig, "Image", "GetItemImage", null, ImageArgs(movie, tag));
        await rig.ImageStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        EvidenceRevision.Advance(() => rig.Plugin.Plugin.Configuration.TMDB_API_KEY = "rotated-credential");
        rig.ImageGate.SetResult();
        var moved = await reask.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(await rig.Policy.MayListAbsentAsync(viewer, SyntheticId.Movie(693134), CancellationToken.None), "still allowed");
        Assert.Equal(originalRevision, rig.Policy.Revision(viewer));
        Assert.Equal(503, Status(moved.Result));
        Assert.Equal("2", moved.Http.Response.Headers["Retry-After"].ToString());
        Assert.Equal("server-busy", moved.Http.Response.Headers["X-JE-Art"].ToString());
        Assert.Equal("private, no-store", moved.Http.Response.Headers.CacheControl.ToString());
        // Upstream recovers: the very same grant serves.
        rig.ImageAnswer = _ => null;
        Assert.IsType<FileContentResult>((await Call(rig, "Image", "GetItemImage", null, ImageArgs(movie, tag))).Result);
    }

    [Fact]
    public async Task EvidenceThatCanNoLongerBeSettledDuringATemporaryFailureStaysRetryableAndGeneric()
    {
        // D110 ACR-R2-1: the evidence moves to a region where the title has no rating (AU: the viewer's parental decision
        // can't be settled now: Unknown, not a denial). The answer stays the retryable 503 with the generic reason.
        var (rig, viewer, movie, tag) = await WithheldRig();
        using var owner = rig;
        rig.ImageAnswer = _ => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
        rig.ImageStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);
        rig.ImageGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var pending = Call(rig, "Image", "GetItemImage", null, ImageArgs(movie, tag));
        await rig.ImageStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        rig.R4Country("AU");
        rig.ImageGate.SetResult();
        var moved = await pending.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(NativeDetailsPolicy.Access.Unknown, await rig.Policy.ListAbsentAccessAsync(viewer, SyntheticId.Movie(693134), CancellationToken.None));
        Assert.Equal(503, Status(moved.Result));
        Assert.Equal("2", moved.Http.Response.Headers["Retry-After"].ToString());
        Assert.Equal("server-busy", moved.Http.Response.Headers["X-JE-Art"].ToString());
    }

    [Fact]
    public async Task ACastPhotoNewlyDeniedBySpoilerGuardDuringTheRecheckIsThePlain404()
    {
        // D121a ACR-R3-1 (round-3 review probe): a cast photo's re-ask meets a temporary upstream failure; meanwhile the
        // viewer guards the movie with Spoiler Guard (hide all cast) and the parental evidence moves. The recheck reads
        // Spoiler Guard afresh, not the request's earlier snapshot: a confirmed refusal, so the answer is header-for-header
        // the plain 404 a fresh request with the same grant gets, never the retryable 503.
        var (rig, viewer, movie, _) = await WithheldRig();
        using var owner = rig;
        rig.Plugin.Plugin.Configuration.SpoilerBlurEnabled = true;
        rig.Plugin.Plugin.Configuration.SpoilerStripCast = true;
        rig.Plugin.Plugin.Configuration.SpoilerStripCastMode = "All";
        rig.R4IncludePublicationFilter = false;
        var dto = Value<BaseItemDto>((await Call(rig, "UserLibrary", "GetItem", Me(viewer), new() { ["itemId"] = movie })).Result);
        rig.R4IncludePublicationFilter = true;
        var cast = dto.People.Single(p => p.Name == "Javier Bardem");
        var tag = cast.PrimaryImageTag!;
        rig.ImageAnswer = _ => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
        rig.ImageStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);
        rig.ImageGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var pending = Call(rig, "Image", "GetItemImage", null, ImageArgs(cast.Id, tag));
        await rig.ImageStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        rig.Plugin.Core.Manager.SaveUserConfiguration(viewer.Id.ToString("N"), "spoilerblur.json",
            new Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserSpoilerBlur { PendingTmdb = new() { ["movie:693134"] = new() } });
        EvidenceRevision.Advance(() => rig.Plugin.Plugin.Configuration.TMDB_API_KEY = "rotated-credential-r3");
        rig.ImageGate.SetResult();
        var moved = await pending.WaitAsync(TimeSpan.FromSeconds(5));
        var fresh = await Call(rig, "Image", "GetItemImage", null, ImageArgs(cast.Id, tag));
        // The title itself is still allowed: the refusal is Spoiler Guard's (cast hidden), read as it is now.
        Assert.Equal(NativeDetailsPolicy.Access.Allowed, await rig.Policy.ListAbsentAccessAsync(viewer, SyntheticId.Movie(693134), CancellationToken.None));
        var now = new SpoilerPresentation(rig.Plugin.Core.Manager, rig.Library.Object, rig.Callers.Users.Object, Mock.Of<MediaBrowser.Controller.Library.IUserDataManager>()).Load(viewer.Id);
        Assert.True(now.Flags(HiddenContentPolicy.TitleIdentity("movie", "693134")!)["cast"]!.GetValue<bool>());
        Assert.Equal(404, Status(fresh.Result));
        Assert.False(fresh.Http.Response.Headers.ContainsKey("X-JE-Art"));
        Assert.Equal(Leaves(fresh), Leaves(moved));
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
