using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using R7 = JE.Tests.ListsSourceReviewR7FixTests;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ListsMetadataAdmissionJoinTests
{
    [Fact]
    public async Task BackgroundTmdbMetadataRetainsFourPlacesAndFreeCachedOrJoinedReads()
    {
        using var plugin = new ApiPluginFixture();
        ImportTestFlags.AllOn(plugin.Plugin.Configuration);
        plugin.Plugin.Configuration.ArrRequestBackend = "je";
        plugin.Plugin.Configuration.TMDB_API_KEY = "list-metadata-test";
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var fourth = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var active = 0;
        var entered = 0;
        var peaks = new ConcurrentQueue<int>();
        const int warmId = 777000;
        using var net = new IntegrationTransport(async (request, ct) =>
        {
            Assert.Equal("api.themoviedb.org", request.RequestUri!.Host);
            var id = int.Parse(request.RequestUri.AbsolutePath.Split('/').Last());
            if (id != warmId)
            {
                peaks.Enqueue(Interlocked.Increment(ref active));
                if (Interlocked.Increment(ref entered) == 4) fourth.TrySetResult();
                try { await release.Task.WaitAsync(ct); }
                finally { Interlocked.Decrement(ref active); }
            }
            var body = JsonNode.Parse(R7.Snake(R7.MetaMovieBody))!.AsObject();
            body["id"] = id;
            return IntegrationTransport.Response(body.ToJsonString());
        });
        using var cache = new TmdbResponseCache(net, TimeProvider.System);
        var source = new TmdbListMetadataSource(cache, plugin.Core.Logger);
        Placeholder Movie(int id) => new() { Kind = PlaceholderKinds.Movie, MediaType = "movie", TmdbId = id };
        Task<Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.PlaceholderMetadata?> Read(int id, CancellationToken ct = default)
            => source.FetchAsync(Movie(id), TimeSpan.FromHours(12), new DateTime(2025, 9, 1), ct);
        var warm = Assert.IsType<Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.PlaceholderMetadata>(await Read(warmId));
        var reads = Enumerable.Range(warmId + 1, 12).Select(id => Read(id)).ToArray();
        try
        {
            await fourth.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(4, Volatile.Read(ref entered));
            Assert.All(reads, read => Assert.False(read.IsCompleted));
            var hit = Assert.IsType<Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.PlaceholderMetadata>(
                await Read(warmId).WaitAsync(TimeSpan.FromSeconds(1)));
            Assert.Equal(warm.FetchedAtUtc, hit.FetchedAtUtc);
            using var stop = new CancellationTokenSource();
            var join = Read(warmId + 1, stop.Token);
            stop.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => join);
            Assert.Equal(4, Volatile.Read(ref entered));
            Assert.All(reads, read => Assert.False(read.IsCompleted));
        }
        finally
        {
            release.TrySetResult();
            await Task.WhenAll(reads).WaitAsync(TimeSpan.FromSeconds(10));
        }
        Assert.All(reads, read => Assert.NotNull(read.Result));
        Assert.Equal(12, entered);
        Assert.Equal(4, peaks.Max());
    }
}
