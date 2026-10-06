using Jellyfin.Plugin.JellyfinEnhanced.Services;

namespace JE.Tests;

public class ApiCdnRefreshTests
{
    private sealed class Reports : IProgress<double>
    {
        public List<double> Values { get; } = new();
        public void Report(double value) => Values.Add(value);
    }

    [Fact]
    public async Task FullKnownAssetRefreshContinuesAfterHttpTimeoutAndReportsCompletion()
    {
        using var f = new CoreFixture();
        var calls = 0;
        using var transport = new IntegrationTransport((request, _) =>
        {
            var index = calls++;
            if (index == 0) throw new TaskCanceledException("simulated HttpClient timeout; caller remains active");
            var path = CdnAssetService.KnownAssets[index].Path;
            var mime = Path.GetExtension(path).ToLowerInvariant() switch {
                ".svg" => "image/svg+xml", ".css" => "text/css", ".ico" => "image/x-icon",
                ".jpg" or ".jpeg" => "image/jpeg", ".txt" => "text/plain", _ => "image/png"
            };
            return Task.FromResult(IntegrationTransport.Response("synthetic-asset", type: mime));
        });
        // The real 2 s pause between award logos is production pacing, not behavior under test.
        var service = new CdnAssetService(f.Logger, transport, f.Paths.Object) { BurstSensitiveDelay = TimeSpan.Zero };
        var progress = new Reports();
        await service.RefreshKnownAsync(progress, CancellationToken.None);
        Assert.Equal(CdnAssetService.KnownAssets.Count, calls);
        Assert.Equal(calls, progress.Values.Count);
        Assert.Equal(100, progress.Values[^1]);
        Assert.True(progress.Values.SequenceEqual(progress.Values.Order()));
        Assert.Equal(calls - 1, Directory.GetFiles(f.Root, "*.bin", SearchOption.AllDirectories).Length);
        Assert.Empty(Directory.GetFiles(f.Root, "*.tmp", SearchOption.AllDirectories));
        // At least the next asset is durably cached; a timeout must not abort the sweep.
        var afterFailure = CdnAssetService.KnownAssets[1];
        var asset = await service.GetAsync(afterFailure.Source, afterFailure.Path, false, CancellationToken.None);
        Assert.NotNull(asset);
        Assert.Equal("synthetic-asset", System.Text.Encoding.UTF8.GetString(asset.Content));
        Assert.Equal(calls, transport.Calls);
    }

    [Fact]
    public async Task RefreshPropagatesCallerCancellationWithoutReportingSuccess()
    {
        using var f = new CoreFixture();
        using var caller = new CancellationTokenSource();
        using var transport = new IntegrationTransport((_, _) =>
        {
            caller.Cancel();
            throw new OperationCanceledException(caller.Token);
        });
        var progress = new Reports();
        var service = new CdnAssetService(f.Logger, transport, f.Paths.Object);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => service.RefreshKnownAsync(progress, caller.Token));
        Assert.Equal(1, transport.Calls);
        Assert.Empty(progress.Values);
    }

    [Fact]
    public async Task TimeoutOnForcedRefreshServesPreviouslyPersistedAsset()
    {
        using var f = new CoreFixture();
        var path = "svg/regression-" + Guid.NewGuid().ToString("N") + ".svg";
        var timeout = false;
        using var transport = new IntegrationTransport((_, _) => timeout
            ? throw new TaskCanceledException("simulated upstream timeout")
            : Task.FromResult(IntegrationTransport.Response("<svg/>", type: "image/svg+xml")));
        var service = new CdnAssetService(f.Logger, transport, f.Paths.Object);
        var initial = await service.GetAsync("selfhst", path, false, CancellationToken.None);
        Assert.NotNull(initial);
        timeout = true;
        var reopened = new CdnAssetService(f.Logger, transport, f.Paths.Object);
        var stale = await reopened.GetAsync("selfhst", path, forceRefresh: true, CancellationToken.None);
        Assert.NotNull(stale);
        Assert.Equal(initial.Content, stale.Content);
        Assert.Equal(initial.ETag, stale.ETag);
        Assert.Equal(2, transport.Calls);
    }
}
