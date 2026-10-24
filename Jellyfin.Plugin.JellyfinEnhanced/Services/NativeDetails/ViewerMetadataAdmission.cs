using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails
{
    /// <summary>
    /// Sole task factory for viewer-driven JE metadata, including evidence read before a native page.
    /// Eight outstanding reads per viewer, 48 server-wide (eight running, 40 queued). Cached answers
    /// and joins are free. Admission, coalescing and task creation are atomic; cancellation only ends
    /// a wait, never the admitted read or its place. The shared answer contains no access decision.
    /// </summary>
    public sealed class ViewerMetadataAdmission
    {
        private static readonly AsyncLocal<ViewerReadScope?> Viewer = new();

        /// <summary>Preserves viewer identity and admission refusal across a response's parallel evidence reads.</summary>
        internal static ViewerReadScope ForViewer(Guid viewer)
        {
            var scope = new ViewerReadScope(viewer, Viewer.Value);
            Viewer.Value = scope;
            return scope;
        }

        internal static Guid? EffectiveViewer => Viewer.Value?.UserId;

        internal sealed class ViewerReadScope(Guid userId, ViewerReadScope? previous) : IDisposable
        {
            private int _refused;
            internal Guid UserId { get; } = userId;
            internal bool Refused => Volatile.Read(ref _refused) != 0;
            internal void Refuse() => Interlocked.Exchange(ref _refused, 1);
            public void Dispose() => Viewer.Value = previous;
        }

        private readonly object _lock = new();
        private readonly Dictionary<string, Task> _tasks = new(StringComparer.Ordinal);
        private readonly FeedScheduler _scheduler = new(8, 40, 8);

        /// <summary>Outstanding tasks in a source namespace (tests).</summary>
        internal int Count(string prefix = "")
        {
            lock (_lock) return _tasks.Keys.Count(k => k.StartsWith(prefix, StringComparison.Ordinal));
        }

        internal Task<T> Read<T>(string path, Guid viewer, Func<(bool Hit, T Value)> cached,
            Func<Task<T>> fetch, T busy, CancellationToken ct, ViewerBudget? budget = null)
        {
            Task<T> shared;
            TaskCompletionSource<T>? owner = null;
            lock (_lock)
            {
                var hit = cached();
                if (hit.Hit) return Task.FromResult(hit.Value);
                if (_tasks.TryGetValue(path, out var running)) return ((Task<T>)running).WaitAsync(ct);
                if (viewer == Guid.Empty || !_scheduler.TryAdmit(viewer))
                {
                    Viewer.Value?.Refuse();
                    return Task.FromResult(busy);
                }
                if (budget != null && !budget.Take(viewer))
                {
                    _scheduler.Leave(viewer, false);
                    Viewer.Value?.Refuse();
                    return Task.FromResult(busy);
                }

                // No task for distinct metadata exists before both limits admit it.
                owner = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
                shared = owner.Task;
                _tasks.Add(path, shared);
                MetadataTaskProbe.Emit(new(viewer, path, "created", owner));
            }

            _ = Run(path, viewer, fetch, owner);
            return shared.WaitAsync(ct);
        }

        private async Task Run<T>(string path, Guid viewer, Func<Task<T>> fetch, TaskCompletionSource<T> owner)
        {
            var ran = false;
            T result = default!;
            Exception? failure = null;
            try
            {
                await _scheduler.TurnAsync(viewer).ConfigureAwait(false);
                ran = true;
                using var scope = MetadataTaskProbe.Own(new(viewer, path, "external", owner));
                using var admission = new MetadataAdmission("viewer:" + viewer.ToString("N"));
                try { result = await fetch().ConfigureAwait(false); }
                finally { await admission.DrainAsync().ConfigureAwait(false); }
            }
            catch (Exception ex) { failure = ex; }
            finally
            {
                lock (_lock)
                {
                    _tasks.Remove(path);
                    MetadataTaskProbe.Emit(new(viewer, path, "completed", owner));
                    _scheduler.Leave(viewer, ran);
                }
            }

            if (failure != null)
            {
                owner.TrySetException(failure);
                _ = owner.Task.Exception; // all waiters may have cancelled
            }
            else owner.TrySetResult(result);
        }
    }

    // Ownership flows to nested raw metadata reads. The optional observer is test-only and scoped
    // to asynchronous test execution. External factories report actual creation independently of
    // admission, including raw-cache tasks that have not reached an HTTP send. No production observer.
    internal readonly record struct MetadataTaskEvent(Guid? Viewer, string Path, string Kind, object? Owner);

    internal static class MetadataTaskProbe
    {
        private static readonly AsyncLocal<Action<MetadataTaskEvent>?> Observer = new();
        private static readonly AsyncLocal<MetadataTaskEvent?> Owner = new();

        internal static IDisposable Observe(Action<MetadataTaskEvent> observer)
        {
            var previous = Observer.Value;
            Observer.Value = observer;
            return new Scope(() => Observer.Value = previous);
        }

        internal static IDisposable Own(MetadataTaskEvent owner)
        {
            var previous = Owner.Value;
            Owner.Value = owner;
            return new Scope(() => Owner.Value = previous);
        }

        internal static bool HasOwner => Owner.Value.HasValue;

        internal static void External(string path)
            => Emit(Owner.Value is { } owner ? owner with { Path = path } : new(null, path, "external", null));

        internal static void Emit(MetadataTaskEvent value) => Observer.Value?.Invoke(value);

        private sealed class Scope(Action restore) : IDisposable
        {
            public void Dispose() => restore();
        }
    }
}
