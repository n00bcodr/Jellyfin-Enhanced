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
        /// <summary>
        /// Owns downstream effects, including waits for a writer and the feed after its commit. Only an actual
        /// fact read acquires admission; an empty scope leaves local/arr work independent. Dispose before adoption.
        /// </summary>
        internal static Publication BeginEffect(CancellationToken ct = default) => new(retain: true, ct);

        internal static T Process<T>(Func<T> work)
        {
            using var publication = BeginEffect();
            var value = work();
            publication.Token.ThrowIfCancellationRequested();
            return publication.Publish(() => value);
        }
        /// <summary>Retains admission only if background processing actually consumes Seerr facts.</summary>
        internal static async Task<T> BackgroundAsync<T>(Func<CancellationToken, Task<T>> work, CancellationToken ct)
        {
            using var publication = BeginEffect(ct);
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
            private (EffectiveRequestsBackend.Admission Admission, CancellationTokenRegistration Cancel)? _factsLease;
            private bool _disposed;
            internal void IncludeFacts(long generation)
            {
                lock (_lock) if (_disposed || _factsLease != null || _leases.ContainsKey(EffectiveRequestsBackend.Shared)) return;
                var lease = EffectiveRequestsBackend.Shared.AdmitFacts(generation, Token);
                var cancel = lease.Token.Register(() => { try { _cancel.Cancel(); } catch (ObjectDisposedException) { } });
                var keep = false;
                lock (_lock)
                {
                    if (!_disposed && _factsLease == null) { _factsLease = (lease, cancel); Volatile.Write(ref _factsAdmitted, 1); Volatile.Write(ref _admitted, 1); keep = true; }
                }
                if (!keep) { cancel.Dispose(); lease.Dispose(); }
            }
            private int _admitted;
            private int _factsAdmitted;
            private int _legacyAdmitted;
            internal bool HasLegacyAdmission => Volatile.Read(ref _legacyAdmitted) != 0;
            internal bool HasFactsAdmission => Volatile.Read(ref _factsAdmitted) != 0;
            internal bool HasAdmission => Volatile.Read(ref _admitted) != 0;
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
                    if (!_disposed && !_leases.ContainsKey(owner)) { _leases.Add(owner, (lease, cancel)); if (ReferenceEquals(owner, EffectiveRequestsBackend.Shared)) { Volatile.Write(ref _factsAdmitted, 1); if (lease.Legacy) Volatile.Write(ref _legacyAdmitted, 1); } Volatile.Write(ref _admitted, 1); keep = true; }
                }
                if (!keep) { cancel.Dispose(); lease.Dispose(); }
            }
            public void Dispose()
            {
                (EffectiveRequestsBackend.Admission Admission, CancellationTokenRegistration Cancel)[] leases;
                lock (_lock) { _disposed = true; Volatile.Write(ref _admitted, 0); Volatile.Write(ref _factsAdmitted, 0); Volatile.Write(ref _legacyAdmitted, 0); leases = _leases.Values.Concat(_factsLease is { } facts ? new[] { facts } : Array.Empty<(EffectiveRequestsBackend.Admission Admission, CancellationTokenRegistration Cancel)>()).ToArray(); _factsLease = null; _leases.Clear(); }
                foreach (var lease in leases) { lease.Cancel.Dispose(); lease.Admission.Dispose(); }
                _cancel.Dispose();
            }
        }
    }
}
