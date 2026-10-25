using System;
using System.Threading;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    internal static partial class UserCacheRegistry
    {
        private static readonly AsyncLocal<Operation?> Operations = new();
        internal static Operation BeginOperation() => new();
        internal static bool OperationTainted => Operations.Value?.Tainted == true;
        internal static void MarkTainted() => Operations.Value?.MarkTainted();
        internal interface IState { void MarkTainted(long generation); }
        internal sealed class Operation : IDisposable
        {
            private readonly Operation? _parent = Operations.Value;
            private readonly HashSet<IState> _touched = new();
            private readonly SeerrFacts.Publication _publication;
            internal bool Tainted { get; private set; }
            internal long Generation { get; }
            internal void Touch(IState state)
            {
                lock (_touched) _touched.Add(state);
                if (Tainted) state.MarkTainted(Generation);
                _parent?.Touch(state);
            }
            internal void MarkTainted()
            {
                IState[] touched;
                lock (_touched) { if (Tainted) return; Tainted = true; touched = _touched.ToArray(); }
                foreach (var state in touched) state.MarkTainted(Generation);
                _parent?.MarkTainted();
            }
            internal Operation() { Generation = _parent?.Generation ?? SeerrFacts.OperationGeneration ?? SampleGeneration(); Operations.Value = this; _publication = SeerrFacts.BeginPublication(); }
            public void Dispose()
            {
                _publication.Dispose();
                if (Operations.Value == this) Operations.Value = _parent;
            }
        }
        /// <summary>
        /// A whole-cache envelope for retained dictionaries/snapshots. New-generation readers get a new empty store;
        /// old operations can neither look up nor refill that store, even if their first store follows a later await.
        /// The original field remains the physical current store for diagnostics and disposal.
        /// </summary>
        internal sealed class State<T>(bool prepared = false) : IState
        {
            private readonly object _gate = new();
            private Ticket _ticket = Begin();
            private bool _tainted;
            void IState.MarkTainted(long generation)
            {
                lock (_gate)
                {
                    if (_ticket.Generation != generation) return;
                    if (!_tainted && TaintMode) Interlocked.Increment(ref TaintedStateCaptures);
                    _tainted = true;
                }
            }
            internal T Read(ref T storage, Func<T> empty)
            {
                var origin = Operations.Value?.Generation ?? SeerrFacts.OperationGeneration ?? SampleGeneration();
                T value;
                bool tainted;
                lock (_gate)
                {
                    if (origin != FactsGeneration || EffectiveRequestsBackend.Shared.FactsFenced && !SeerrFacts.RetainsFacts)
                    {
                        // A miss never hands an old operation the new store (nor lets it stamp late work as new).
                        if (_ticket.Generation != FactsGeneration) storage = prepared ? default! : empty();
                        if (prepared) throw new BackendDisabledException("configuration_changed");
                        return empty();
                    }
                    if (!Current(_ticket))
                    {
                        storage = prepared ? default! : empty();
                        if (prepared) throw new BackendDisabledException("configuration_changed");
                        _ticket = new(origin); _tainted = false;
                    }
                    value = storage;
                    tainted = _tainted;
                }
                try { Use(new(origin), tainted); }
                catch (BackendDisabledException) when (!prepared) { return empty(); }
                Operations.Value?.Touch(this);
                if (tainted) SeerrFacts.MarkCachedTaint();
                return value;
            }
            internal void Store(ref T storage, T value)
            {
                var ticket = Begin();
                var entry = UserCacheRegistry.Store(ticket, SeerrFacts.Remember(value));
                lock (_gate)
                {
                    if (!Current(entry.Ticket)) return;
                    storage = value;
                    _ticket = ticket;
                    _tainted = entry.Tainted;
                }
            }
        }
    }
}
