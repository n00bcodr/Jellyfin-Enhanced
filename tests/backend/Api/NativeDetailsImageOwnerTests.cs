#if JF12
// The image metadata owner is part of the native-details pages, which the plugin compiles for Jellyfin 12 only (JF12).
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;

namespace JE.Tests;
public class NativeDetailsImageOwnerTests
{
    private static ArtworkRead Bytes(byte b = 1) => ArtworkRead.Of((new byte[] { b }, "image/jpeg"));

    [Fact]
    public async Task ImageOwnerAdmitsSixteenRunningAndThirtyTwoQueuedThenRefusesFortyNinth()
    {
        var owner = new ImageMetadataAdmission();
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var entered = 0;
        async Task<ArtworkRead> Fetch() { Interlocked.Increment(ref entered); await gate.Task; return Bytes(); }
        var viewers = Enumerable.Range(0, 7).Select(_ => Guid.NewGuid()).ToArray();
        var reads = Enumerable.Range(0, 48).Select(i => owner.Read("image:"+i, viewers[i/8], () => null, Fetch, default)).ToArray();
        try
        {
            Assert.Equal(48, owner.Count);
            Assert.Equal(16, entered);
            // The 49th is refused as the server's bound, typed and retryable, and never starts upstream work.
            var refused = await owner.Read("forty-ninth", viewers[6], () => null, Fetch, default);
            Assert.Equal(ArtworkOutcome.ServerBusy, refused.Outcome);
            Assert.True(refused.Retryable);
            Assert.Null(refused.Image);
            Assert.Equal(48, owner.Count);
            Assert.All(reads, r => Assert.False(r.IsCompleted));
        }
        finally { gate.TrySetResult(); await Task.WhenAll(reads).WaitAsync(TimeSpan.FromSeconds(5)); }
        Assert.Equal(48, entered);
        Assert.Equal(0, owner.Count);
        Assert.All(reads, r => Assert.Equal(ArtworkOutcome.Served, r.Result.Outcome));
    }

    [Fact]
    public async Task ImageOwnerAdmitsEightDistinctImagesPerViewerThenRefusesTheNinthTyped()
    {
        var owner = new ImageMetadataAdmission();
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var entered = 0;
        async Task<ArtworkRead> Fetch() { Interlocked.Increment(ref entered); await gate.Task; return Bytes(); }
        var viewer = Guid.NewGuid();
        var first = Enumerable.Range(0, 8).Select(i => owner.Read("still:" + i, viewer, () => null, Fetch, default)).ToArray();
        try
        {
            Assert.Equal(8, entered);
            var ninth = await owner.Read("still:8", viewer, () => null, Fetch, default);
            Assert.Equal(ArtworkOutcome.ViewerBusy, ninth.Outcome);
            Assert.True(ninth.Retryable);
            Assert.Equal(8, entered);
            Assert.Equal(8, owner.Count);
            // Another viewer still has their own places; a join of an outstanding image and a cache hit are free.
            var other = owner.Read("still:9", Guid.NewGuid(), () => null, Fetch, default);
            var join = owner.Read("still:0", viewer, () => null, Fetch, default);
            Assert.Equal(ArtworkOutcome.Served, (await owner.Read("cached", viewer, () => (new byte[] { 3 }, "image/jpeg"), Fetch, default)).Outcome);
            Assert.Equal(9, entered);
            gate.TrySetResult();
            Assert.Equal(ArtworkOutcome.Served, (await join.WaitAsync(TimeSpan.FromSeconds(5))).Outcome);
            await other.WaitAsync(TimeSpan.FromSeconds(5));
        }
        finally { gate.TrySetResult(); await Task.WhenAll(first).WaitAsync(TimeSpan.FromSeconds(5)); }
        // Released: the same ninth image is admitted now.
        Assert.Equal(ArtworkOutcome.Served, (await owner.Read("still:8", viewer, () => null, Fetch, default)).Outcome);
        Assert.Equal(0, owner.Count);
    }

    [Fact]
    public async Task ImageOwnerExpiresQueuedWorkWithoutSendingOrLeavingOrphans()
    {
        var owner = new ImageMetadataAdmission { QueueWait = TimeSpan.FromMilliseconds(75) };
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var entered = 0;
        async Task<ArtworkRead> Fetch() { Interlocked.Increment(ref entered); await gate.Task; return Bytes(); }
        var viewers = Enumerable.Range(0, 3).Select(_ => Guid.NewGuid()).ToArray();
        var held = Enumerable.Range(0, 16).Select(i => owner.Read("running:"+i, viewers[i/8], () => null, Fetch, default)).ToArray();
        try
        {
            var queued = owner.Read("expired", viewers[2], () => null, Fetch, default);
            var expired = await queued.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(ArtworkOutcome.QueueExpired, expired.Outcome);
            Assert.True(expired.Retryable);
            Assert.Null(expired.Image);
            Assert.Equal(16, owner.Count);
            Assert.Equal(16, entered);
        }
        finally { gate.TrySetResult(); await Task.WhenAll(held).WaitAsync(TimeSpan.FromSeconds(5)); }
        Assert.Equal(16, entered);
        Assert.Equal(0, owner.Count);
    }

    [Fact]
    public async Task ImageOwnerCacheAndJoinAreFreeAndCancellationRetainsOriginalOwnership()
    {
        var owner = new ImageMetadataAdmission();
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var viewer = Guid.NewGuid();
        var entered = 0;
        async Task<ArtworkRead> Fetch() { Interlocked.Increment(ref entered); await gate.Task; return Bytes(); }
        using var cancel = new CancellationTokenSource();
        var first = owner.Read("same", viewer, () => null, Fetch, cancel.Token);
        var join = owner.Read("same", Guid.NewGuid(), () => null, Fetch, default);
        cancel.Cancel();
        try
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => first);
            Assert.Equal(1, owner.Count);
            Assert.Equal(1, entered);
            var cached = await owner.Read("warm", viewer, () => (new byte[] { 2 }, "image/jpeg"), Fetch, default);
            Assert.Equal(2, cached.Image!.Value.Bytes[0]);
            Assert.Equal(1, entered);
        }
        finally { gate.TrySetResult(); }
        Assert.Equal(ArtworkOutcome.Served, (await join.WaitAsync(TimeSpan.FromSeconds(5))).Outcome);
        Assert.Equal(0, owner.Count);
    }

    [Fact]
    public async Task UpstreamOutcomesAreTypedAndAFailedFetchIsTemporary()
    {
        var owner = new ImageMetadataAdmission();
        var viewer = Guid.NewGuid();
        Assert.Equal(ArtworkOutcome.NotFound, (await owner.Read("missing", viewer, () => null, () => Task.FromResult(ArtworkRead.Not(ArtworkOutcome.NotFound)), default)).Outcome);
        Assert.False(ArtworkRead.Not(ArtworkOutcome.NotFound).Retryable);
        // A fetch that throws is no refusal of the image: temporary.
        var thrown = await owner.Read("throws", viewer, () => null, () => throw new InvalidOperationException("boom"), default);
        Assert.Equal(ArtworkOutcome.Unavailable, thrown.Outcome);
        Assert.True(thrown.Retryable);
        // No viewer: refused, never admitted.
        Assert.Equal(ArtworkOutcome.Refused, (await owner.Read("nobody", Guid.Empty, () => null, () => Task.FromResult(Bytes()), default)).Outcome);
        Assert.Equal(0, owner.Count);
    }
}
#endif
