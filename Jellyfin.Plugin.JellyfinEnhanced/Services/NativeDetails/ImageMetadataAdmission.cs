#if JF12
using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails
{
    // Public image bytes only. This owner never authorizes delivery: the image facade must still
    // validate the signed viewer grant and current privacy policy before and after this read.
    // Separate from metadata: 8 outstanding per viewer, 16 running + 32 queued server-wide.
    internal sealed class ImageMetadataAdmission
    {
        private readonly object _lock = new();
        private readonly Dictionary<string, Task<(byte[] Bytes, string ContentType)?>> _tasks = new(StringComparer.Ordinal);
        private readonly Dictionary<Guid, int> _viewers = new();
        private readonly SemaphoreSlim _running = new(16, 16);
        internal TimeSpan QueueWait { get; set; } = TimeSpan.FromSeconds(2);
        internal int Count { get { lock (_lock) return _tasks.Count; } }

        internal Task<(byte[] Bytes, string ContentType)?> Read(string path, Guid viewer,
            Func<(byte[] Bytes, string ContentType)?> cached,
            Func<Task<(byte[] Bytes, string ContentType)?>> fetch, CancellationToken ct)
        {
            TaskCompletionSource<(byte[] Bytes, string ContentType)?> owner;
            lock (_lock)
            {
                if (cached() is { } hit) return Task.FromResult<(byte[] Bytes, string ContentType)?>(hit);
                if (_tasks.TryGetValue(path, out var shared)) return shared.WaitAsync(ct);
                if (viewer == Guid.Empty || _tasks.Count >= 48 || _viewers.GetValueOrDefault(viewer) >= 8)
                    return Task.FromResult<(byte[] Bytes, string ContentType)?>(null);
                // Admission precedes both task retention and upstream creation. Joins/cache hits are free.
                _viewers[viewer] = _viewers.GetValueOrDefault(viewer) + 1;
                owner = new(TaskCreationOptions.RunContinuationsAsynchronously);
                _tasks.Add(path, owner.Task);
            }
            _ = RunAsync(path, viewer, fetch, owner);
            return owner.Task.WaitAsync(ct);
        }

        private async Task RunAsync(string path, Guid viewer, Func<Task<(byte[] Bytes, string ContentType)?>> fetch,
            TaskCompletionSource<(byte[] Bytes, string ContentType)?> owner)
        {
            var entered = false;
            (byte[] Bytes, string ContentType)? result = null;
            try
            {
                // Expiry uses the existing optional image refusal/placeholder contract. A cancelled
                // caller cannot detach shared work or relinquish its outstanding place early.
                entered = await _running.WaitAsync(QueueWait).ConfigureAwait(false);
                if (entered)
                {
                    using var admission = new MetadataAdmission("image:" + viewer.ToString("N"), images: true);
                    try { result = await fetch().ConfigureAwait(false); }
                    finally { await admission.DrainAsync().ConfigureAwait(false); }
                }
            }
            catch (Exception) { /* Optional artwork: no provider detail escapes as a refusal body. */ }
            finally
            {
                lock (_lock)
                {
                    _tasks.Remove(path);
                    if (--_viewers[viewer] == 0) _viewers.Remove(viewer);
                    if (entered) _running.Release();
                }
                owner.TrySetResult(result);
            }
        }
    }
}
#endif
