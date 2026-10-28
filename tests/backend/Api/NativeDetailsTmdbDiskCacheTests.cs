using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache;

namespace JE.Tests;

/// <summary>Absent titles' native details after a restart: TMDB metadata from the server-side cache, mapped afresh.</summary>
[Collection("Plugin singleton")]
public sealed class NativeDetailsTmdbDiskCacheTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "je-native-disk-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, true);
    }

    private ServerBlobCache Disk() => new(() => new ServerCacheSettings(true, string.Empty, 0, 0), new ServerCacheLocation(_root, Array.Empty<string>()), null)
    { SweepDebounce = TimeSpan.Zero };

    private int Files() => Directory.Exists(_root) ? Directory.EnumerateFiles(_root, "*.blob", SearchOption.AllDirectories).Count() : 0;

    private const string Series = """{"id":777,"name":"Unlinked","seasons":[{"season_number":1,"episode_count":2}],"external_ids":{"tvdb_id":null,"imdb_id":null}}""";

    [Fact]
    public async Task ARestartedServerMapsTheSavedSeriesWithNoRequestNoAdmissionPlaceAndTodaysAliases()
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.TMDB_API_KEY = "test-tmdb";
        var hang = new TaskCompletionSource();
        var hanging = false;
        using var net = new IntegrationTransport(async (request, ct) =>
        {
            if (hanging) await hang.Task.WaitAsync(ct);
            return IntegrationTransport.Response(Series);
        });
        var viewer = Guid.NewGuid();
        using (var before = new TmdbResponseCache(net, TimeProvider.System, null, Disk()))
        {
            var first = new TmdbNativeDetailsSource(before, null, plugin.Core.Logger, () => "test-tmdb", () => DateTime.UtcNow);
            Assert.NotNull((await first.SeriesAsync(777, viewer, CancellationToken.None)).Data);
            // The native read and the generic base title it seeds.
            await IntegrationTmdbDiskCacheTests.Until(() => Files() == 2);
        }

        Assert.Equal(1, net.Calls);
        // After the restart the arr libraries know the series by a TVDB id: it is applied at use, not frozen on disk.
        IReadOnlyList<TitleKey> Aliases(TitleKey key) => key.ToString() == "tv:tmdb:777" ? new[] { TitleKey.Parse("tv:tvdb:4242")! } : Array.Empty<TitleKey>();
        var admission = new ViewerMetadataAdmission();
        using var after = new TmdbResponseCache(net, TimeProvider.System, admission, Disk());
        var source = new TmdbNativeDetailsSource(after, Aliases, plugin.Core.Logger, () => "test-tmdb", () => DateTime.UtcNow, admission);
        // The viewer's eight places are all held by reads TMDB doesn't answer.
        hanging = true;
        var held = Enumerable.Range(1, 8).Select(i => source.PersonAsync(i, viewer, CancellationToken.None)).ToArray();
        await IntegrationTmdbDiskCacheTests.Until(() => admission.Count() == 8);
        var series = (await source.SeriesAsync(777, viewer, CancellationToken.None)).Data!.Value;
        Assert.Equal(4242, series.GetProperty("externalIds").GetProperty("tvdbId").GetInt32());
        Assert.Equal(1, after.DiskHits);
        Assert.Equal(9, net.Calls); // the first read and the eight held ones; none for the saved series
        hang.SetResult();
        await Task.WhenAll(held);
    }
}
