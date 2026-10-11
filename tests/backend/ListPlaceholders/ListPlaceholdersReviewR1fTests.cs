using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using SkiaSharp;
using static JE.Tests.ListPlaceholdersHarness;

namespace JE.Tests;

// Review round 1 (track f): the collage of a list restricted viewers can see only draws the posters the server has for
// each title, JE's own collage stays JE's after a write that failed once the file was saved, StopAsync waits for the
// evaluations in flight, and a poster of any shape never makes the renderer allocate more than the canvas.
public partial class ListPlaceholdersCollageTests
{
    [Fact]
    public async Task ARestrictedViewersCollageDrawsTheServersPosterOfEachTitleNotTheStoredOne()
    {
        using var f = new Fixture();
        f.H.MovieCertifications[1000] = "G";
        f.H.MovieCertifications[1001] = "R";
        f.H.MovieCertifications[1002] = "G";
        f.Seed(f.Playlist, "/p0.jpg", "/p1.jpg", "/p2.jpg");

        // An editor paired the G title with the R title's poster; the server has no poster for the other G title.
        var doc = f.Store.LoadForUpdate(Fixture.Id(f.Playlist), ListKinds.Playlist);
        doc.Items[0].PosterPath = "/p1.jpg";
        f.Store.Save(doc);
        f.ServerPosters.Remove(1002);
        f.Kid();

        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));
        Assert.Equal(new[] { "/p0.jpg" }, f.Service.Markers.Load(Fixture.Id(f.Playlist))!.PosterKeys);
        Assert.DoesNotContain("/t/p/w342/p1.jpg", f.PosterRequests);
        Assert.DoesNotContain("/t/p/w342/p2.jpg", f.PosterRequests);
    }

    [Fact]
    public async Task AFirstCollageWhoseItemUpdateFailsAfterTheFileWasSavedIsStillJes()
    {
        using var f = new Fixture();
        f.Seed(f.Playlist, "/p0.jpg");
        f.Images.ExceptionAfterWrite = new IOException("database is locked");
        Assert.Equal(CollageDecision.None, await f.Evaluate(f.Playlist));
        Assert.True(f.Images.Images.ContainsKey(f.Playlist.Info.Id)); // the file is saved

        // A real item arrives: JE takes its collage back (it is not someone's image).
        f.Playlist.Raw.Add(new RawEntry(f.Host.AddItem(), true));
        Assert.Equal(CollageDecision.Remove, await f.Evaluate(f.Playlist));
        Assert.False(f.Images.Images.ContainsKey(f.Playlist.Info.Id));
        Assert.Null(f.Service.Markers.Load(Fixture.Id(f.Playlist)));
    }

    [Fact]
    public async Task ARebuiltCollageWhoseItemUpdateFailsAfterTheFileWasSavedIsStillJes()
    {
        using var f = new Fixture();
        var id = Fixture.Id(f.Playlist);
        f.Seed(f.Playlist, "/p0.jpg");
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));

        f.Seed(f.Playlist, "/p1.jpg");
        f.Images.ExceptionAfterWrite = new OperationCanceledException("stopping");
        Assert.Equal(CollageDecision.None, await f.Evaluate(f.Playlist));

        // The new file is recognised as JE's (not forgotten as someone else's), and isn't written again.
        var writes = f.Images.Calls.Count(c => c.StartsWith("set:", StringComparison.Ordinal));
        Assert.Equal(CollageDecision.None, await f.Evaluate(f.Playlist));
        var marker = f.Service.Markers.Load(id)!;
        Assert.Equal(new[] { "/p0.jpg", "/p1.jpg" }, marker.PosterKeys);
        Assert.Null(marker.PendingSha256);
        Assert.Equal(f.Images.Images[f.Playlist.Info.Id].Path, marker.ImagePath);
        Assert.Equal(writes, f.Images.Calls.Count(c => c.StartsWith("set:", StringComparison.Ordinal)));
    }

    [Fact]
    public async Task AWriteTheImageHostRefusedLeavesNoPendingRecord()
    {
        using var f = new Fixture();
        var id = Fixture.Id(f.Playlist);
        f.Seed(f.Playlist, "/p0.jpg");
        f.Images.BeforeWrite = list => { f.Images.SetUserImage(list); f.Images.BeforeWrite = null; };
        Assert.Equal(CollageDecision.None, await f.Evaluate(f.Playlist));
        Assert.False(f.Service.Markers.Exists(id));

        // With a collage of JE's in place, a refused rebuild keeps the record of that collage as it was.
        f.Images.Images.Remove(f.Playlist.Info.Id);
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));
        var before = f.Service.Markers.Load(id)!;
        f.Seed(f.Playlist, "/p1.jpg");
        f.Images.WriteException = new IOException("disk full"); // the write fails before saving anything
        Assert.Equal(CollageDecision.None, await f.Evaluate(f.Playlist));
        var after = f.Service.Markers.Load(id)!;
        Assert.Equal((before.ImagePath, before.Sha256), (after.ImagePath, after.Sha256));
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist)); // still JE's: rebuilt with both posters
        Assert.Equal(new[] { "/p0.jpg", "/p1.jpg" }, f.Service.Markers.Load(id)!.PosterKeys);
    }

    [Fact]
    public async Task StopWaitsForTheEvaluationsInFlight()
    {
        using var f = new Fixture();
        f.Seed(f.Playlist, "/p0.jpg");
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));
        f.Playlist.Raw.Add(new RawEntry(f.Host.AddItem(), true));

        var deleting = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Images.BeforeDelete = async () =>
        {
            deleting.TrySetResult();
            await release.Task;
        };
        await f.Service.StartAsync(CancellationToken.None);
        f.Service.Notify(Fixture.Id(f.Playlist));
        await deleting.Task.WaitAsync(TimeSpan.FromSeconds(10));

        var stop = f.Service.StopAsync(CancellationToken.None);
        await Task.Delay(200);
        Assert.False(stop.IsCompleted, "StopAsync returned while an evaluation was still removing the collage");

        release.SetResult();
        await stop.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Contains("refresh:" + Fixture.Id(f.Playlist), f.Images.Calls); // the evaluation finished before Stop returned
    }

    [Fact]
    public async Task StopGivesUpWaitingWhenTheHostsStopTokenFires()
    {
        using var f = new Fixture();
        f.Seed(f.Playlist, "/p0.jpg");
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));
        f.Playlist.Raw.Add(new RawEntry(f.Host.AddItem(), true));
        var deleting = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Images.BeforeDelete = async () =>
        {
            deleting.TrySetResult();
            await release.Task;
        };
        await f.Service.StartAsync(CancellationToken.None);
        f.Service.Notify(Fixture.Id(f.Playlist));
        await deleting.Task.WaitAsync(TimeSpan.FromSeconds(10));

        using var shutdown = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));
        await f.Service.StopAsync(shutdown.Token).WaitAsync(TimeSpan.FromSeconds(10));
        release.SetResult();
        await f.Service.WhenIdleAsync(TimeSpan.FromSeconds(10)); // nothing runs on past the test
    }

    [Fact]
    public void APosterOfAnExtremeShapeIsRefusedAndOthersAreCroppedWithoutAScaledCopy()
    {
        // 342x1 would have been scaled up to 205200x600 (about 490 MB) to cover a 400x600 cell.
        Assert.False(ListPlaceholderCollageRenderer.CanDecode(Poster(Colors[0], 342, 1)));
        Assert.False(ListPlaceholderCollageRenderer.CanDecode(Poster(Colors[0], 1, 342)));
        Assert.Null(ListPlaceholderCollageRenderer.Render(new[] { Poster(Colors[0], 342, 1) }, false));
        Assert.True(ListPlaceholderCollageRenderer.CanDecode(Poster(Colors[0], 400, 100)));

        // A wide poster (left half red, right half blue) in a tall cell: the centred crop shows the seam in the middle.
        using var wide = new SKBitmap(300, 100);
        using (var canvas = new SKCanvas(wide))
        {
            canvas.Clear(Colors[0]);
            using var paint = new SKPaint { Color = Colors[2] };
            canvas.DrawRect(new SKRect(150, 0, 300, 100), paint);
        }

        using var wideImage = SKImage.FromBitmap(wide);
        using var encoded = wideImage.Encode(SKEncodedImageFormat.Png, 100);
        var jpeg = ListPlaceholderCollageRenderer.Render(new[] { encoded.ToArray(), Poster(Colors[1]) }, true)!;
        using var collage = SKBitmap.Decode(jpeg);
        Assert.Equal((600, 600), (collage.Width, collage.Height));
        AssertColor(Colors[0], collage.GetPixel(100, 300)); // left cell, left of the seam
        AssertColor(Colors[2], collage.GetPixel(200, 300)); // left cell, right of the seam
        AssertColor(Colors[0], collage.GetPixel(110, 10));
        AssertColor(Colors[2], collage.GetPixel(190, 590));
        AssertColor(Colors[1], collage.GetPixel(450, 300)); // right cell: the second poster
    }
}

// Review round 1 (track f): a TMDB placeholder's poster is the one Seerr has for that title, never one a client sent.
[Collection("Plugin singleton")]
public class ListPlaceholdersPosterTrustTests
{
    private static readonly CancellationToken None = CancellationToken.None;

    [Fact]
    public async Task AddedAndLinkedTitlesGetTheServersPosterNotTheClients()
    {
        using var h = new ListPlaceholdersHarness(seerr: true);
        h.MovieDetails[10] = "{\"id\":10,\"posterPath\":\"/real10.jpg\"}"; // nothing else, so the background pass saves nothing
        h.MovieDetails[12] = "{\"id\":12,\"releaseDate\":\"2012-07-16\",\"posterPath\":\"/real12.jpg\"}";
        var editor = h.NewUser("editor");
        var playlist = h.Host.AddPlaylist(editor);
        var access = h.AccessFor(playlist, editor);
        Assert.False(access.IsAdmin);

        var known = Ph("{\"kind\":\"movie\",\"tmdbId\":10,\"title\":\"Movie 10\",\"posterPath\":\"/blocked.jpg\"}", access.UserIdN);
        var unknown = Ph("{\"kind\":\"movie\",\"tmdbId\":11,\"title\":\"Movie 11\",\"posterPath\":\"/blocked.jpg\"}", access.UserIdN);
        var custom = Ph("{\"kind\":\"custom\",\"title\":\"Fan edit\",\"posterPath\":\"/mine.jpg\"}", access.UserIdN);
        var added = Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { known, unknown, custom }, null, null, null, None));
        var rows = added.View!.Placeholders.ToDictionary(p => p.Id);
        Assert.Equal("/real10.jpg", rows[known.Id].PosterPath);
        Assert.Null(rows[unknown.Id].PosterPath); // nothing to check it against: no poster (fail closed)
        Assert.Equal("/mine.jpg", rows[custom.Id].PosterPath); // a custom entry is the adder's own (never shown to restricted viewers)

        var link = Ph("{\"kind\":\"movie\",\"tmdbId\":12,\"title\":\"Movie 12\",\"posterPath\":\"/blocked.jpg\"}");
        var linked = Ok<ListViewDto>(await h.Service.PatchAsync(access, custom.Id, added.View.Rev, null, link, null, None));
        Assert.Equal("/real12.jpg", linked.Placeholders.Single(p => p.Id == custom.Id).PosterPath);
        var stored = h.Store.Load(access.ListIdN)!.Items.ToDictionary(p => p.Id);
        Assert.Equal("/real12.jpg", stored[custom.Id].PosterPath);
        Assert.NotEqual("/blocked.jpg", stored[known.Id].PosterPath);
        Assert.NotEqual("/blocked.jpg", stored[unknown.Id].PosterPath);
    }

    [Fact]
    public async Task WithoutSeerrTheClientsPosterIsKept()
    {
        using var h = new ListPlaceholdersHarness();
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        var movie = Ph("{\"kind\":\"movie\",\"tmdbId\":10,\"title\":\"Movie 10\",\"posterPath\":\"/mine.jpg\"}", access.UserIdN);
        var added = Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { movie }, null, null, null, None));
        Assert.Equal("/mine.jpg", Assert.Single(added.View!.Placeholders).PosterPath);
    }

    [Fact]
    public void SeerrsPosterReplacesAStoredOneAndAFullReadWithoutAPosterClearsIt()
    {
        var movie = Ph("{\"kind\":\"movie\",\"tmdbId\":10,\"title\":\"Movie 10\",\"posterPath\":\"/blocked.jpg\"}");
        var today = new DateTime(2026, 10, 11, 0, 0, 0, DateTimeKind.Utc);
        Assert.True(ListPlaceholderMetadataService.Apply(movie, new PlaceholderMetadata { FetchedAtUtc = today, PosterPath = "/real.jpg" }));
        Assert.Equal("/real.jpg", movie.PosterPath);
        Assert.True(ListPlaceholderMetadataService.Apply(movie, new PlaceholderMetadata { FetchedAtUtc = today }));
        Assert.Null(movie.PosterPath);

        // A partial read (the season's details failed) only fills a missing poster.
        var season = Ph("{\"kind\":\"season\",\"tmdbId\":20,\"seasonNumber\":1,\"title\":\"Show\",\"posterPath\":\"/s1.jpg\"}");
        ListPlaceholderMetadataService.Apply(season, new PlaceholderMetadata { FetchedAtUtc = today, PosterPath = "/show.jpg", Partial = true });
        Assert.Equal("/s1.jpg", season.PosterPath);
    }
}
