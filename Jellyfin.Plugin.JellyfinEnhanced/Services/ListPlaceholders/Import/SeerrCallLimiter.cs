using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Import
{
    /// <summary>
    /// The one global gate for Seerr calls made by list imports and linked-list syncs (design §7, E4): at most
    /// <see cref="MaxConcurrent"/> calls in flight and call starts spaced <see cref="Spacing"/> apart (≈10/s), shared by
    /// every user. Waiting calls are admitted round-robin per owner (user or sync job), and interactive callers always
    /// go before background ones (the scheduled sync), so one big import can't starve another user and a sync never
    /// slows an import down.
    /// </summary>
    public sealed class SeerrCallLimiter
    {
        /// <summary>Default concurrency (research: 4, hard max 6).</summary>
        public const int DefaultMaxConcurrent = 4;

        /// <summary>Default start spacing (≈10 calls/s).</summary>
        public static readonly TimeSpan DefaultSpacing = TimeSpan.FromMilliseconds(100);

        private const int HistorySize = 2048;

        private readonly object _lock = new();
        private readonly TimeProvider _time;
        private readonly Queues _interactive = new();
        private readonly Queues _background = new();
        private readonly long[] _history = new long[HistorySize];
        private int _historyNext;
        private int _running;
        private long _nextStartTicks;
        private long _total;
        private int _peak;

        /// <summary>Creates the production limiter (4 concurrent, 100 ms spacing).</summary>
        public SeerrCallLimiter()
            : this(DefaultMaxConcurrent, DefaultSpacing, TimeProvider.System)
        {
        }

        /// <summary>Creates a limiter (tests use other limits).</summary>
        /// <param name="maxConcurrent">Concurrent calls.</param>
        /// <param name="spacing">Minimum spacing between call starts.</param>
        /// <param name="time">Clock.</param>
        public SeerrCallLimiter(int maxConcurrent, TimeSpan spacing, TimeProvider time)
        {
            MaxConcurrent = Math.Max(1, maxConcurrent);
            Spacing = spacing < TimeSpan.Zero ? TimeSpan.Zero : spacing;
            _time = time;
        }

        /// <summary>Concurrency limit.</summary>
        public int MaxConcurrent { get; }

        /// <summary>Minimum spacing between call starts.</summary>
        public TimeSpan Spacing { get; }

        /// <summary>
        /// Waits for a slot. Dispose the lease when the call finished. Cancelling while queued removes the waiter;
        /// cancelling during the spacing delay gives the slot back.
        /// </summary>
        /// <param name="owner">Fairness key (user id or job id).</param>
        /// <param name="background">Background work (scheduled sync) yields to interactive callers.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The lease.</returns>
        public async Task<IDisposable> AcquireAsync(string owner, bool background, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var waiter = new Waiter(owner ?? string.Empty);
            lock (_lock)
            {
                (background ? _background : _interactive).Enqueue(waiter);
                DispatchLocked();
            }

            TimeSpan delay;
            using (cancellationToken.Register(() => Cancel(waiter)))
            {
                delay = await waiter.Granted.Task.ConfigureAwait(false);
            }

            var lease = new Lease(this);
            if (delay > TimeSpan.Zero)
            {
                try
                {
                    await Task.Delay(delay, _time, cancellationToken).ConfigureAwait(false);
                }
                catch
                {
                    lease.Dispose();
                    throw;
                }
            }

            return lease;
        }

        /// <summary>Counters for logs and tests.</summary>
        /// <returns>Total calls admitted, peak concurrency and the most calls started within any one second of the recent history.</returns>
        public (long Total, int PeakConcurrent, int MaxPerSecond) Stats()
        {
            lock (_lock)
            {
                var count = (int)Math.Min(_total, HistorySize);
                var starts = new List<long>(count);
                for (var i = 0; i < count; i++)
                {
                    starts.Add(_history[(_historyNext - 1 - i + HistorySize) % HistorySize]);
                }

                starts.Sort();
                var max = 0;
                var window = TimeSpan.FromSeconds(1).Ticks;
                for (int lo = 0, hi = 0; hi < starts.Count; hi++)
                {
                    while (starts[hi] - starts[lo] >= window)
                    {
                        lo++;
                    }

                    max = Math.Max(max, hi - lo + 1);
                }

                return (_total, _peak, max);
            }
        }

        private void Cancel(Waiter waiter)
        {
            lock (_lock)
            {
                if (waiter.Granted.Task.IsCompleted)
                {
                    return;
                }

                // Dequeue skips completed (cancelled) waiters lazily.
                waiter.Granted.TrySetCanceled();
            }
        }

        private void Release()
        {
            lock (_lock)
            {
                _running--;
                DispatchLocked();
            }
        }

        private void DispatchLocked()
        {
            while (_running < MaxConcurrent)
            {
                var next = _interactive.Dequeue() ?? _background.Dequeue();
                if (next == null)
                {
                    return;
                }

                _running++;
                _peak = Math.Max(_peak, _running);
                var now = _time.GetUtcNow().UtcTicks;
                var start = Math.Max(now, _nextStartTicks);
                _nextStartTicks = start + Spacing.Ticks;
                _history[_historyNext] = start;
                _historyNext = (_historyNext + 1) % HistorySize;
                _total++;
                next.Granted.TrySetResult(TimeSpan.FromTicks(start - now));
            }
        }

        private sealed class Waiter(string owner)
        {
            public string Owner { get; } = owner;

            public TaskCompletionSource<TimeSpan> Granted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        // Per-owner FIFO queues served round-robin.
        private sealed class Queues
        {
            private readonly Dictionary<string, Queue<Waiter>> _byOwner = new(StringComparer.Ordinal);
            private readonly LinkedList<string> _rotation = new();

            public void Enqueue(Waiter waiter)
            {
                if (!_byOwner.TryGetValue(waiter.Owner, out var queue))
                {
                    _byOwner[waiter.Owner] = queue = new Queue<Waiter>();
                    _rotation.AddLast(waiter.Owner);
                }

                queue.Enqueue(waiter);
            }

            public Waiter? Dequeue()
            {
                while (_rotation.First != null)
                {
                    var owner = _rotation.First.Value;
                    _rotation.RemoveFirst();
                    var queue = _byOwner[owner];
                    Waiter? found = null;
                    while (queue.Count > 0 && found == null)
                    {
                        var candidate = queue.Dequeue();
                        if (!candidate.Granted.Task.IsCompleted)
                        {
                            found = candidate;
                        }
                    }

                    if (queue.Count > 0)
                    {
                        _rotation.AddLast(owner);
                    }
                    else
                    {
                        _byOwner.Remove(owner);
                    }

                    if (found != null)
                    {
                        return found;
                    }
                }

                return null;
            }
        }

        private sealed class Lease(SeerrCallLimiter owner) : IDisposable
        {
            private SeerrCallLimiter? _owner = owner;

            public void Dispose() => Interlocked.Exchange(ref _owner, null)?.Release();
        }
    }
}
