#if JF12
using System.Net;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache;

namespace JE.Tests;

/// <summary>Absent titles' TMDB artwork through the server-side cache: memory, then disk, then TMDB.</summary>
public sealed class NativeDetailsArtworkDiskCacheTests : IDisposable
{
    private static readonly byte[] Jpeg = { 0xff, 0xd8, 0xff, 0xe0, 1, 2, 3 };
    private readonly string _root = Path.Combine(Path.GetTempPath(), "je-artwork-disk-" + Guid.NewGuid().ToString("N"));
    private ServerCacheSettings _settings = new(true, string.Empty, 0, 0);

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, true);
    }

    private ServerBlobCache Disk() => new(() => _settings, new ServerCacheLocation(_root, Array.Empty<string>()), null) { SweepDebounce = TimeSpan.Zero };

    private static IntegrationTransport Tmdb(List<Uri> sent, Task? gate = null, string type = "image/jpeg") => new(async (request, _) =>
    {
        lock (sent) sent.Add(request.RequestUri!);
        if (gate != null) await gate;
        var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Jpeg) };
        response.Content.Headers.ContentType = new(type);
        return response;
    });

    [Fact]
    public async Task AfterARestartTheSameImageIsServedFromDiskWithNoTmdbRequestOrAdmissionPlace()
    {
        var sent = new List<Uri>();
        using (var network = Tmdb(sent))
        {
            var before = new NativeDetailsArtwork(network, null, null, Disk());
            var first = await before.FetchAsync("/poster.jpg", "w500", Guid.NewGuid(), CancellationToken.None);
            Assert.Equal(Jpeg, first!.Value.Bytes);
            Assert.Single(sent);
            Assert.Equal(0, before.DiskHits);
        }

        // A new process: a new service and store over the same folder. TMDB would hang if it were asked.
        var hang = new TaskCompletionSource();
        var afterSent = new List<Uri>();
        using var hanging = Tmdb(afterSent, hang.Task);
        var after = new NativeDetailsArtwork(hanging, null, null, Disk());
        var viewer = Guid.NewGuid();
        // Fill this viewer's every admission place with images TMDB never answers.
        var stuck = Enumerable.Range(0, 8).Select(i => after.FetchAsync("/stuck" + i + ".jpg", "w500", viewer, CancellationToken.None)).ToList();
        // Each first looks on disk (a shared, bounded read), then takes its admission place.
        for (var i = 0; i < 200 && after.InFlightCount < 8; i++) await Task.Delay(10);
        Assert.Equal(8, after.InFlightCount);
        for (var i = 0; i < 200 && afterSent.Count < 8; i++) await Task.Delay(10);
        // And their upstream budget.
        while (after.TakeUpstream(viewer)) { }

        Assert.True(await after.IsCachedAsync("/poster.jpg", "w500", CancellationToken.None));
        var again = await after.FetchAsync("/poster.jpg", "w500", viewer, CancellationToken.None);
        Assert.NotNull(again);
        Assert.Equal(Jpeg, again.Value.Bytes);
        Assert.Equal("image/jpeg", again.Value.ContentType);
        Assert.Equal(8, afterSent.Count); // only the stuck ones
        Assert.DoesNotContain(afterSent, u => u.AbsolutePath.Contains("poster"));
        Assert.Equal(8, after.InFlightCount);
        Assert.Equal(1, after.DiskHits);
        hang.SetResult();
        await Task.WhenAll(stuck);
    }

    [Fact]
    public async Task TwoViewersAskingForAnUncachedImageMakeOneTmdbRequestAndOneEntry()
    {
        var sent = new List<Uri>();
        var gate = new TaskCompletionSource();
        using var network = Tmdb(sent, gate.Task);
        var disk = Disk();
        var artwork = new NativeDetailsArtwork(network, null, null, disk);
        var a = artwork.FetchAsync("/backdrop.jpg", "w1280", Guid.NewGuid(), CancellationToken.None);
        var b = artwork.FetchAsync("/backdrop.jpg", "w1280", Guid.NewGuid(), CancellationToken.None);
        for (var i = 0; i < 100 && sent.Count == 0; i++) await Task.Delay(10);
        gate.SetResult();
        var results = await Task.WhenAll(a, b);
        Assert.All(results, r => Assert.Equal(Jpeg, r!.Value.Bytes));
        Assert.Single(sent);
        Assert.Equal(1, disk.Usage().Files);
    }

    [Fact]
    public async Task AnUnreadableEntryIsFetchedAgainAndReplaced()
    {
        var sent = new List<Uri>();
        using var network = Tmdb(sent);
        await new NativeDetailsArtwork(network, null, null, Disk()).FetchAsync("/a.jpg", "w342", Guid.NewGuid(), CancellationToken.None);
        var file = Directory.EnumerateFiles(_root, "*.blob", SearchOption.AllDirectories).Single();
        File.WriteAllBytes(file, new byte[] { 1, 2, 3 });

        var restarted = new NativeDetailsArtwork(network, null, null, Disk());
        var image = await restarted.FetchAsync("/a.jpg", "w342", Guid.NewGuid(), CancellationToken.None);
        Assert.Equal(Jpeg, image!.Value.Bytes);
        Assert.Equal(2, sent.Count);
        Assert.Equal(0, restarted.DiskHits);
        Assert.True(new FileInfo(file).Length > Jpeg.Length);
    }

    [Fact]
    public async Task AStoredTypeOtherThanAnImageIsNeverServed()
    {
        var disk = Disk();
        disk.Register(new ServerCacheNamespace(NativeDetailsArtwork.DiskNamespace));
        await disk.PutAsync(NativeDetailsArtwork.DiskNamespace, "w500/x.jpg", new byte[] { 60, 115 }, "text/html", CancellationToken.None);
        var sent = new List<Uri>();
        using var network = Tmdb(sent);
        var artwork = new NativeDetailsArtwork(network, null, null, disk);
        Assert.False(await artwork.IsCachedAsync("/x.jpg", "w500", CancellationToken.None));
        var image = await artwork.FetchAsync("/x.jpg", "w500", Guid.NewGuid(), CancellationToken.None);
        Assert.Equal("image/jpeg", image!.Value.ContentType);
        Assert.Single(sent);
    }

    [Fact]
    public async Task WithTheCacheOffNothingIsWrittenAndEveryProcessFetchesAgain()
    {
        _settings = _settings with { Enabled = false };
        var sent = new List<Uri>();
        using var network = Tmdb(sent);
        await new NativeDetailsArtwork(network, null, null, Disk()).FetchAsync("/a.jpg", "w500", Guid.NewGuid(), CancellationToken.None);
        await new NativeDetailsArtwork(network, null, null, Disk()).FetchAsync("/a.jpg", "w500", Guid.NewGuid(), CancellationToken.None);
        Assert.Equal(2, sent.Count);
        Assert.False(Directory.Exists(Path.Combine(_root, ServerBlobCache.DefaultFolderName)));
    }
}
#endif
