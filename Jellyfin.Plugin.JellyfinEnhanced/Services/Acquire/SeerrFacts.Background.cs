using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    public sealed partial class SeerrFacts
    {
        internal static T Process<T>(Func<T> work)
        {
            using var publication = new Publication(retain: true);
            var value = work();
            publication.Token.ThrowIfCancellationRequested();
            return publication.Publish(() => value);
        }
        /// <summary>Retains admission only if background processing actually consumes Seerr facts.</summary>
        internal static async Task<T> BackgroundAsync<T>(Func<CancellationToken, Task<T>> work, CancellationToken ct)
        {
            using var publication = new Publication(retain: true, ct);
            var value = await work(publication.Token).ConfigureAwait(false);
            publication.Token.ThrowIfCancellationRequested();
            return publication.Publish(() => value);
        }
        internal static async Task BackgroundAsync(Func<CancellationToken, Task> work, CancellationToken ct)
        {
            await BackgroundAsync(async token => { await work(token).ConfigureAwait(false); return true; }, ct).ConfigureAwait(false);
        }
        private sealed class Background(CancellationToken ct) : IDisposable
        {
            private readonly CancellationTokenSource _cancel = CancellationTokenSource.CreateLinkedTokenSource(ct);
            private readonly object _lock = new();
            private readonly Dictionary<EffectiveRequestsBackend, (EffectiveRequestsBackend.Admission Admission, CancellationTokenRegistration Cancel)> _leases = new();
            private bool _disposed;
            internal CancellationToken Token => _cancel.Token;
            internal void Include(EffectiveRequestsBackend owner, long epoch)
            {
                lock (_lock) if (_disposed || _leases.ContainsKey(owner)) return;
                // Never hold the bookkeeping lock while entering the backend/transition gate.
                var lease = owner.AdmitSeerr(SeerrUse.RequestRead, Token, epoch);
                var cancel = lease.Token.Register(() => { try { _cancel.Cancel(); } catch (ObjectDisposedException) { } });
                var keep = false;
                lock (_lock)
                {
                    if (!_disposed && !_leases.ContainsKey(owner)) { _leases.Add(owner, (lease, cancel)); keep = true; }
                }
                if (!keep) { cancel.Dispose(); lease.Dispose(); }
            }
            public void Dispose()
            {
                (EffectiveRequestsBackend.Admission Admission, CancellationTokenRegistration Cancel)[] leases;
                lock (_lock) { _disposed = true; leases = _leases.Values.ToArray(); _leases.Clear(); }
                foreach (var lease in leases) { lease.Cancel.Dispose(); lease.Admission.Dispose(); }
                _cancel.Dispose();
            }
        }
    }
}
