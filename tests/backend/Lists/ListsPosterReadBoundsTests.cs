using System.Collections;
using System.Reflection;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;

namespace JE.Tests;

/// <summary>Shared list poster reads are bounded: a fixed table of reads and of waiters per read; past them a caller reads on its own.</summary>
[Collection("Plugin singleton")]
public sealed class ListsPosterReadBoundsTests
{
    private static IDictionary Flights(ListMetadataService service)
        => (IDictionary)typeof(ListMetadataService).GetField("_posterReads", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(service)!;

    private static Placeholder Movie(int id) => new() { Id = "p" + id, Kind = PlaceholderKinds.Movie, MediaType = "movie", TmdbId = id, Title = "Movie" };

    private static IntegrationTransport Held(Task release) => new(async (request, ct) =>
    {
        await release.WaitAsync(ct);
        var id = int.Parse(request.RequestUri!.AbsolutePath.Split('/').Last());
        return IntegrationTransport.Response(JsonSerializer.Serialize(new { id, poster_path = "/a.jpg" }));
    });

    [Fact]
    public async Task DistinctMissesPastTheTableReadOnTheirOwnAndAllAreAnswered()
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.TMDB_API_KEY = "key";
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var net = Held(release.Task);
        var service = new ListMetadataService(net, plugin.Core.Logger);
        var count = ListMetadataService.MaxSharedPosterReads + 40;
        var reads = Enumerable.Range(1, count).Select(id => service.ReadTmdbPosterAsync(Movie(id), default)).ToArray();
        Assert.Equal(ListMetadataService.MaxSharedPosterReads, Flights(service).Count);
        Assert.Equal(4, net.Calls); // still the four poster places
        release.SetResult();
        var answers = await Task.WhenAll(reads).WaitAsync(TimeSpan.FromSeconds(60));
        Assert.All(answers, answer => Assert.Equal(("/a.jpg", true), answer));
        Assert.Equal(count, net.Calls);
        Assert.Empty(Flights(service));
    }

    [Fact]
    public async Task CallersPastAReadsWaiterBoundReadOnTheirOwn()
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.TMDB_API_KEY = "key";
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var net = Held(release.Task);
        var service = new ListMetadataService(net, plugin.Core.Logger);
        var extra = 3;
        var reads = Enumerable.Range(0, ListMetadataService.MaxPosterReadWaiters + extra).Select(_ => service.ReadTmdbPosterAsync(Movie(603), default)).ToArray();
        Assert.Single(Flights(service));
        release.SetResult();
        var answers = await Task.WhenAll(reads).WaitAsync(TimeSpan.FromSeconds(30));
        Assert.All(answers, answer => Assert.Equal(("/a.jpg", true), answer));
        Assert.Equal(1 + extra, net.Calls);
        Assert.Empty(Flights(service));
    }

    [Fact]
    public async Task AQueuedSharedReadEveryCallerLeftIsCancelledAndNeverSends()
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.TMDB_API_KEY = "key";
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var net = Held(release.Task);
        var service = new ListMetadataService(net, plugin.Core.Logger);
        // Four reads take the four poster places; a fifth, queued behind them, is left by its only caller.
        var holders = Enumerable.Range(1, 4).Select(id => service.ReadTmdbPosterAsync(Movie(id), default)).ToArray();
        using var cts = new CancellationTokenSource();
        var queued = service.ReadTmdbPosterAsync(Movie(5), cts.Token);
        Assert.Equal(5, Flights(service).Count);
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => queued);
        Assert.Equal(4, Flights(service).Count);
        release.SetResult();
        await Task.WhenAll(holders).WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Equal(4, net.Calls);
        Assert.Empty(Flights(service));
    }
}
