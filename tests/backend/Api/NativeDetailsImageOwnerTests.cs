#if JF12
// The image metadata owner is part of the native-details pages, which the plugin compiles for Jellyfin 12 only (JF12).
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;

namespace JE.Tests;
public class NativeDetailsImageOwnerTests
{
    [Fact]
    public async Task ImageOwnerAdmitsSixteenRunningAndThirtyTwoQueuedThenRefusesFortyNinth()
    {
        var owner = new ImageMetadataAdmission();
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var entered = 0;
        async Task<(byte[] Bytes, string ContentType)?> Fetch() { Interlocked.Increment(ref entered); await gate.Task; return (new byte[] { 1 }, "image/jpeg"); }
        var viewers = Enumerable.Range(0, 7).Select(_ => Guid.NewGuid()).ToArray();
        var reads = Enumerable.Range(0, 48).Select(i => owner.Read("image:"+i, viewers[i/8], () => null, Fetch, default)).ToArray();
        try
        {
            Assert.Equal(48, owner.Count);
            Assert.Equal(16, entered);
            Assert.Null(await owner.Read("forty-ninth", viewers[6], () => null, Fetch, default));
            Assert.All(reads, r => Assert.False(r.IsCompleted));
        }
        finally { gate.TrySetResult(); await Task.WhenAll(reads).WaitAsync(TimeSpan.FromSeconds(5)); }
        Assert.Equal(48, entered);
        Assert.Equal(0, owner.Count);
        Assert.All(reads, r => Assert.NotNull(r.Result));
    }

    [Fact]
    public async Task ImageOwnerExpiresQueuedWorkWithoutSendingOrLeavingOrphans()
    {
        var owner = new ImageMetadataAdmission { QueueWait = TimeSpan.FromMilliseconds(75) };
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var entered = 0;
        async Task<(byte[] Bytes, string ContentType)?> Fetch() { Interlocked.Increment(ref entered); await gate.Task; return (new byte[] { 1 }, "image/jpeg"); }
        var viewers = Enumerable.Range(0, 3).Select(_ => Guid.NewGuid()).ToArray();
        var held = Enumerable.Range(0, 16).Select(i => owner.Read("running:"+i, viewers[i/8], () => null, Fetch, default)).ToArray();
        try
        {
            var queued = owner.Read("expired", viewers[2], () => null, Fetch, default);
            Assert.Null(await queued.WaitAsync(TimeSpan.FromSeconds(5)));
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
        async Task<(byte[] Bytes, string ContentType)?> Fetch() { Interlocked.Increment(ref entered); await gate.Task; return (new byte[] { 1 }, "image/jpeg"); }
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
            Assert.Equal(2, cached!.Value.Bytes[0]);
            Assert.Equal(1, entered);
        }
        finally { gate.TrySetResult(); await join.WaitAsync(TimeSpan.FromSeconds(5)); }
        Assert.Equal(0, owner.Count);
    }
}
#endif
