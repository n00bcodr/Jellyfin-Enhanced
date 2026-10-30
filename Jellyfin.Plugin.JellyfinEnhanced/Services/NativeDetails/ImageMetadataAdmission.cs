#if JF12
using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails
{
    /// <summary>How one read of an absent title's image ended (<see cref="NativeDetailsArtwork.ReadAsync"/>, the image facade).</summary>
    public enum ArtworkOutcome
    {
        /// <summary>The bytes were had (cache, a shared read or a fetch).</summary>
        Served,

        /// <summary>Admission: the viewer already has eight distinct images outstanding. Temporary.</summary>
        ViewerBusy,

        /// <summary>Admission: 48 image operations are outstanding server-wide. Temporary.</summary>
        ServerBusy,

        /// <summary>Admission: the read waited its whole queue time for one of the 16 running places. Temporary.</summary>
        QueueExpired,

        /// <summary>TMDB answered that the file doesn't exist, or answered something that is no image (or too large). Permanent.</summary>
        NotFound,

        /// <summary>TMDB couldn't be read now (an error status, a timeout, a dropped connection). Temporary.</summary>
        Unavailable,

        /// <summary>The facade: the grant's policy revision is no longer the viewer's (a policy or session change).</summary>
        StaleGrant,

        /// <summary>The facade: the grant, the viewer or the page refuses the image (hidden, denied, invalid). Permanent.</summary>
        Refused,

        /// <summary>The facade: the viewer's or the page's access can't be settled now (evidence, a changing person or library). Temporary.</summary>
        PolicyUnknown,

        /// <summary>The facade: the viewer's upstream image budget is used up for now. Temporary.</summary>
        Budget,
    }

    /// <summary>An image read's outcome and, when <see cref="ArtworkOutcome.Served"/>, its bytes.</summary>
    /// <param name="Outcome">The outcome.</param>
    /// <param name="Image">The bytes and content type (served only).</param>
    public readonly record struct ArtworkRead(ArtworkOutcome Outcome, (byte[] Bytes, string ContentType)? Image)
    {
        /// <summary>The bytes were had.</summary>
        /// <param name="image">Bytes and content type.</param>
        /// <returns>The read.</returns>
        public static ArtworkRead Of((byte[] Bytes, string ContentType) image) => new(ArtworkOutcome.Served, image);

        /// <summary>No bytes, for <paramref name="outcome"/>.</summary>
        /// <param name="outcome">Why.</param>
        /// <returns>The read.</returns>
        public static ArtworkRead Not(ArtworkOutcome outcome) => new(outcome, null);

        /// <summary>
        /// True when asking again shortly may serve it (admission pressure, an upstream outage): answered 503 with
        /// Retry-After, never as the permanent-looking 404 of a missing or refused image.
        /// </summary>
        public bool Retryable => Outcome is ArtworkOutcome.ViewerBusy or ArtworkOutcome.ServerBusy or ArtworkOutcome.QueueExpired or ArtworkOutcome.Unavailable
            or ArtworkOutcome.PolicyUnknown or ArtworkOutcome.Budget;
    }

    // Public image bytes only. This owner never authorizes delivery: the image facade must still
    // validate the signed viewer grant and current privacy policy before and after this read.
    // Separate from metadata: 8 outstanding per viewer, 16 running + 32 queued server-wide.
    internal sealed class ImageMetadataAdmission
    {
        private readonly object _lock = new();
        private readonly Dictionary<string, Task<ArtworkRead>> _tasks = new(StringComparer.Ordinal);
        private readonly Dictionary<Guid, int> _viewers = new();
        private readonly SemaphoreSlim _running = new(16, 16);
        internal TimeSpan QueueWait { get; set; } = TimeSpan.FromSeconds(2);
        internal int Count { get { lock (_lock) return _tasks.Count; } }

        internal Task<ArtworkRead> Read(string path, Guid viewer,
            Func<(byte[] Bytes, string ContentType)?> cached,
            Func<Task<ArtworkRead>> fetch, CancellationToken ct)
        {
            TaskCompletionSource<ArtworkRead> owner;
            lock (_lock)
            {
                if (cached() is { } hit) return Task.FromResult(ArtworkRead.Of(hit));
                if (_tasks.TryGetValue(path, out var shared)) return shared.WaitAsync(ct);
                // A refusal is typed (the facade answers it as retryable) and never starts or retains work.
                if (viewer == Guid.Empty) return Task.FromResult(ArtworkRead.Not(ArtworkOutcome.Refused));
                if (_viewers.GetValueOrDefault(viewer) >= 8) return Task.FromResult(ArtworkRead.Not(ArtworkOutcome.ViewerBusy));
                if (_tasks.Count >= 48) return Task.FromResult(ArtworkRead.Not(ArtworkOutcome.ServerBusy));
                // Admission precedes both task retention and upstream creation. Joins/cache hits are free.
                _viewers[viewer] = _viewers.GetValueOrDefault(viewer) + 1;
                owner = new(TaskCreationOptions.RunContinuationsAsynchronously);
                _tasks.Add(path, owner.Task);
            }
            _ = RunAsync(path, viewer, fetch, owner);
            return owner.Task.WaitAsync(ct);
        }

        private async Task RunAsync(string path, Guid viewer, Func<Task<ArtworkRead>> fetch,
            TaskCompletionSource<ArtworkRead> owner)
        {
            var entered = false;
            var result = ArtworkRead.Not(ArtworkOutcome.Unavailable);
            try
            {
                // A cancelled caller cannot detach shared work or relinquish its outstanding place early.
                using (StageTimings.Time(Stage.ImageAdmit)) entered = await _running.WaitAsync(QueueWait).ConfigureAwait(false);
                if (entered)
                {
                    using var admission = new MetadataAdmission("image:" + viewer.ToString("N"), images: true);
                    try { result = await fetch().ConfigureAwait(false); }
                    finally { await admission.DrainAsync().ConfigureAwait(false); }
                }
                else
                {
                    result = ArtworkRead.Not(ArtworkOutcome.QueueExpired);
                }
            }
            catch (Exception) { /* Optional artwork: no provider detail escapes; an unexpected failure is temporary. */ }
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
