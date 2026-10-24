using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends
{
    /// <summary>The shared provider boundary. Feature permissions remain the caller's responsibility.</summary>
    public interface IEffectiveRequestsBackend
    {
        EffectiveBackendSnapshot Current { get; }
        EffectiveBackendSnapshot Evaluate(PluginConfiguration? config);
        BackendDecision CheckSeerr(SeerrUse use, long? expectedEpoch = null);
        BackendDecision CheckDirectRequest(long? expectedEpoch = null);
        void DemandSeerr(SeerrUse use, long? expectedEpoch = null);
    }

    /// <summary>
    /// Reads live configuration on every check. Version zero adds no restrictions to legacy operations.
    /// A future central adoption writer can fence, cancel and drain HTTP admissions with TransitionAsync,
    /// then commit its atomic configuration update; it must not hold ConfigurationLock while draining.
    /// </summary>
    public sealed class EffectiveRequestsBackend : IEffectiveRequestsBackend
    {
        /// <summary>Compatibility helpers and DI share one owner, rather than separate static predicates.</summary>
        public static EffectiveRequestsBackend Shared { get; } = new(() => JellyfinEnhanced.Instance?.Configuration);
        private ILogger<EffectiveRequestsBackend>? _logger;
        private readonly Dictionary<string, DateTime> _denials = new(StringComparer.Ordinal);
        /// <summary>Attaches host logging to the shared compatibility boundary.</summary>
        public EffectiveRequestsBackend WithLogger(ILogger<EffectiveRequestsBackend> logger) { _logger = logger; return this; }
        private readonly Func<PluginConfiguration?> _config;
        private readonly object _gate = new();
        private readonly SemaphoreSlim _transitions = new(1, 1);
        private readonly HashSet<Admission> _active = new();
        private bool _fenced;
        private string? _signature;
        private long _epoch;
        private TaskCompletionSource? _drained;

        /// <summary>Creates an owner over a live configuration source (also used by tests).</summary>
        public EffectiveRequestsBackend(Func<PluginConfiguration?> config) { _config = config; Facts = new(this); }
        internal SeerrFacts.Access Facts { get; }
        // Only synchronous cache read/invalidation blocks use this; no awaited work holds the gate.
        internal FactLock LockFacts()
        {
            Monitor.Enter(_gate);
            return new FactLock(_gate);
        }
        internal sealed class FactLock(object gate) : IDisposable
        {
            public void Dispose() => Monitor.Exit(gate);
        }


        /// <summary>The pure evaluator, usable by compatibility entry points without DI or I/O.</summary>
        public static EffectiveBackendSnapshot EvaluateConfiguration(PluginConfiguration? config)
        {
            var mode = config?.ArrRequestBackend switch { "je" => RequestsBackendMode.Je, "seerr" => RequestsBackendMode.Seerr, "status_only" => RequestsBackendMode.StatusOnly, _ => RequestsBackendMode.Unavailable };
            var version = config?.ArrBackendIsolationVersion ?? 0;
            var supported = version is 0 or 1;
            var enabled = supported && config is { ArrIntegrationEnabled: true, ArrPhase1Enabled: true, ArrPhase3Enabled: true } && mode is RequestsBackendMode.Je or RequestsBackendMode.Seerr;
            return new(mode, version, version == 1, 0,
                version == 0 || (version == 1 && mode == RequestsBackendMode.Seerr),
                supported && mode == RequestsBackendMode.Je && enabled, enabled,
                version == 1 && mode == RequestsBackendMode.Je ? "tmdb" : version == 0 || (version == 1 && mode == RequestsBackendMode.Seerr) ? "seerr" : "unavailable");
        }
        /// <summary>Compatibility callers use the same pure boundary evaluator.</summary>
        public static bool AllowsSeerr(PluginConfiguration? config) => EvaluateConfiguration(config).AllowSeerrTransport;
        /// <summary>Whether JE is the isolated read authority regardless of rollout switches.</summary>
        public static bool IsStrictJe(PluginConfiguration? config) => EvaluateConfiguration(config).StrictJe;
        /// <inheritdoc />
        public EffectiveBackendSnapshot Evaluate(PluginConfiguration? config) => EvaluateConfiguration(config);
        /// <inheritdoc />
        public EffectiveBackendSnapshot Current { get { lock (_gate) return Read(); } }
        private EffectiveBackendSnapshot Read()
        {
            var config = _config();
            var snapshot = Evaluate(config);
            var signature = $"{snapshot.Backend}|{snapshot.IsolationVersion}|{snapshot.RequestsEnabled}|{config?.JellyseerrEnabled}|{config?.JellyseerrUrls}|{config?.JellyseerrApiKey}";
            if (_signature != signature) { _signature = signature; _epoch++; }
            return snapshot with { Epoch = _epoch };
        }
        /// <inheritdoc />
        public BackendDecision CheckSeerr(SeerrUse use, long? expectedEpoch = null)
        {
            lock (_gate)
            {
                var s = Read();
                // An unadopted installation has legacy admission semantics even across saves.
                // Once adopted, the captured epoch is a mandatory publication/send precondition.
                var current = s.IsolationVersion == 0 || expectedEpoch == null || expectedEpoch == s.Epoch;
                return new(!_fenced && s.AllowSeerrTransport && current,
                    _fenced || !current ? "configuration_changed" : s.AllowSeerrTransport ? null : "backend_disabled", s.Epoch);
            }
        }
        /// <inheritdoc />
        public BackendDecision CheckDirectRequest(long? expectedEpoch = null)
        {
            lock (_gate)
            {
                var s = Read();
                return new(!_fenced && s.AllowDirectRequests && (expectedEpoch == null || expectedEpoch == s.Epoch),
                    _fenced || (expectedEpoch != null && expectedEpoch != s.Epoch) ? "configuration_changed" : s.AllowDirectRequests ? null : "backend_disabled", s.Epoch);
            }
        }
        /// <inheritdoc />
        public void DemandSeerr(SeerrUse use, long? expectedEpoch = null) => DemandSeerr(use, expectedEpoch, "provider");
        /// <summary>Logs early refusals without connection or person data; repeated operations are bounded.</summary>
        public void DemandSeerr(SeerrUse use, long? expectedEpoch, string producer)
        {
            var decision = CheckSeerr(use, expectedEpoch);
            if (!decision.Allowed) LogDenial(use, producer, decision.Reason!);
            decision.Demand();
            Facts.Include(decision.Epoch);
        }
        private void LogDenial(SeerrUse use, string producer, string reason)
        {
            lock (_gate)
            {
                var state = Read();
                var name = producer.Length <= 80 && System.Linq.Enumerable.All(producer, c => char.IsLetterOrDigit(c) || c == '_') ? producer : "provider";
                var key = $"{use}|{name}|{state.Backend}|{state.IsolationVersion}|{reason}";
                var now = DateTime.UtcNow;
                if (_denials.TryGetValue(key, out var at) && now - at < TimeSpan.FromMinutes(1)) return;
                if (_denials.Count >= 256) _denials.Clear();
                _denials[key] = now;
                _logger?.LogInformation("[RequestsBackend] Seerr denied: operation={Operation} producer={Producer} backend={Backend} version={Version} reason={Reason}", use, name, state.Backend, state.IsolationVersion, reason);
            }
        }
        /// <summary>Admits one Seerr send, held until its response is available or it fails.</summary>
        public Admission AdmitSeerr(SeerrUse use, CancellationToken ct, long? expectedEpoch = null)
        {
            lock (_gate)
            {
                var decision = CheckSeerr(use, expectedEpoch);
                if (!decision.Allowed) LogDenial(use, "admission", decision.Reason!);
                decision.Demand();
                var admission = new Admission(this, decision.Epoch, ct);
                _active.Add(admission);
                return admission;
            }
        }
        /// <summary>Commits a returned provider result only while its captured backend still owns publication.</summary>
        internal bool TryPublishSeerr(long epoch, Action effect)
        {
            CancellationToken operationToken = default;
            try
            {
                using var operation = AdmitSeerr(SeerrUse.RequestRead, CancellationToken.None, epoch);
                operationToken = operation.Token;
                Facts.Include(epoch);
                operation.Publish(effect);
                return true;
            }
            catch (BackendDisabledException) { return false; }
            catch (OperationCanceledException) when (operationToken.IsCancellationRequested) { return false; }
        }
        /// <summary>The single fence for cached facts, local effects and returned provider results.</summary>
        internal T PublishSeerr<T>(long epoch, Func<T> result) => Facts.Publish(epoch, result);

        internal T CommitEffective<T>(long epoch, Func<T> result)
        {
            lock (_gate)
            {
                if (_fenced || Read().Epoch != epoch) throw new BackendDisabledException("configuration_changed");
                var value = result();
                if (_fenced || Read().Epoch != epoch) throw new BackendDisabledException("configuration_changed");
                return value;
            }
        }

        internal T CommitSeerr<T>(long epoch, Func<T> result)
        {
            lock (_gate)
            {
                CheckSeerr(SeerrUse.RequestRead, epoch).Demand();
                var value = result();
                CheckSeerr(SeerrUse.RequestRead, epoch).Demand();
                return value;
            }
        }
        /// <summary>Publishes synchronous cached facts, or their inactive shape, at the same fence.</summary>
        internal T ReadSeerrCached<T>(Func<T> read, T inactive) => Facts.Cached(read, inactive);
        /// <summary>Reads through the same accessor that owns cache and composed-result publication.</summary>
        internal Task<T> ReadSeerrAsync<T>(SeerrUse use, Func<long, Task<T>> work) => Facts.ReadAsync(use, work);
        /// <summary>Keeps provider parsing and its returned facts in the admitted epoch, beyond HTTP buffering.</summary>
        internal Task<T> RunSeerrAsync<T>(SeerrUse use, CancellationToken ct, Func<CancellationToken, Task<T>> work)
            => Facts.RunAsync(use, ct, work);
        /// <summary>
        /// Fences admissions, cancels and drains old sends, then calls the central writer's atomic commit.
        /// Cancellation/failure keeps the prior configuration and releases the fence. No global config lock is held here.
        /// </summary>
        public async Task TransitionAsync(Action commit, CancellationToken ct)
        {
            await _transitions.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                Admission[] active;
                Task drain;
                lock (_gate)
                {
                    _fenced = true;
                    active = new Admission[_active.Count]; _active.CopyTo(active);
                    drain = active.Length == 0 ? Task.CompletedTask : (_drained = new(TaskCreationOptions.RunContinuationsAsynchronously)).Task;
                }
                foreach (var a in active) a.Cancel();
                await drain.WaitAsync(ct).ConfigureAwait(false);
                ct.ThrowIfCancellationRequested();
                // The atomic configuration writer may wait for a lifecycle/configuration lock. Keep admissions
                // fenced, but never hold the backend monitor while calling that writer (or while draining).
                commit();
                lock (_gate) { _signature = null; Read(); }
            }
            finally { lock (_gate) { _fenced = false; _drained = null; } _transitions.Release(); }
        }
        /// <summary>A cancellable admission to one backend epoch.</summary>
        public sealed class Admission : IDisposable
        {
            private readonly EffectiveRequestsBackend _owner;
            private readonly CancellationTokenSource _cancel;
            private bool _disposed;
            internal Admission(EffectiveRequestsBackend owner, long epoch, CancellationToken ct) { _owner = owner; Epoch = epoch; _cancel = CancellationTokenSource.CreateLinkedTokenSource(ct); }
            public long Epoch { get; }
            public CancellationToken Token => _cancel.Token;
            internal void Cancel() { try { _cancel.Cancel(); } catch (ObjectDisposedException) { /* A completed send has already drained. */ } }
            /// <summary>Rejects a response from work interrupted by adoption or an uncoordinated config change.</summary>
            public void DemandCurrent()
            {
                Token.ThrowIfCancellationRequested();
                _owner.PublishSeerr(Epoch, () => true);
            }
            /// <summary>Serializes a local effect with transition commit and checks its captured epoch.</summary>
            public void Publish(Action effect)
            {
                Publish(() => { effect(); return true; });
            }
            /// <summary>Returns a provider result at the same fence used by all local effects.</summary>
            public T Publish<T>(Func<T> result)
            {
                Token.ThrowIfCancellationRequested();
                // This admission already retains the operation through its caller's effects. Never execute a
                // database/file/lifecycle wait under the backend monitor: transition cancels/drains outside it.
                _owner.PublishSeerr(Epoch, () => true);
                return result();
            }
            public void Dispose()
            {
                lock (_owner._gate)
                {
                    if (_disposed) return;
                    _disposed = true; _owner._active.Remove(this); _cancel.Dispose();
                    if (_owner._active.Count == 0) _owner._drained?.TrySetResult();
                }
            }
        }
    }
}
