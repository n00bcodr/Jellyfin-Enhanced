using System;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>
    /// Orders observation through commit, including interest lifecycle and standalone evidence writers.
    /// Entry points always acquire, including forked tasks. Private evaluator cores share the acquired scope;
    /// the database transaction remains short and synchronous.
    /// </summary>
    internal sealed class EvidenceOrder
    {
        private sealed class Scope { internal bool Active = true; internal long Generation; }
        private readonly Func<long> _generation;
        internal EvidenceOrder(Func<long> generation) { _generation = generation; }
        internal long? Generation => _scope.Value?.Active == true ? _scope.Value.Generation : null;
        private readonly SemaphoreSlim _gate = new(1, 1);
        private readonly AsyncLocal<Scope?> _scope = new();

        internal T Run<T>(Func<T> work)
        {
            _gate.Wait();
            var scope = new Scope { Generation = _generation() };
            _scope.Value = scope;
            try { return work(); }
            finally { scope.Active = false; _scope.Value = null; _gate.Release(); }
        }

        internal void Run(Action work) => Run(() => { work(); return true; });

        internal async Task<T> RunAsync<T>(Func<Task<T>> work, CancellationToken ct)
        {
            await _gate.WaitAsync(ct).ConfigureAwait(false);
            var scope = new Scope { Generation = _generation() };
            _scope.Value = scope;
            try { return await work().ConfigureAwait(false); }
            finally { scope.Active = false; _scope.Value = null; _gate.Release(); }
        }

        internal Task RunAsync(Func<Task> work, CancellationToken ct)
            => RunAsync(async () => { await work().ConfigureAwait(false); return true; }, ct);
    }
}
