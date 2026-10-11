using System;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr
{
    /// <summary>
    /// One snapshot of one instance: the last good value, the last error, single-flight refreshes,
    /// failure backoff, "last read" (interest) and a debounced refresh request. Thread-safe.
    /// Refreshes always run detached from the caller's async flow, so a user request that starts
    /// or waits for one never has the arr calls attributed to it (see <see cref="ArrCallCounter"/>).
    /// </summary>
    /// <typeparam name="T">Snapshot type.</typeparam>
    internal sealed class ArrSnapshotSlot<T> : IArrSnapshotSlot
        where T : class
    {
        private static readonly TimeSpan MaxBackoff = TimeSpan.FromMinutes(5);
        private static readonly TimeSpan FirstBackoff = TimeSpan.FromSeconds(15);

        private readonly object _lock = new();
        private readonly Func<T?, CancellationToken, Task<ArrResult<T>>> _loader;
        private T? _value;
        private DateTimeOffset _loadedAt;
        private ArrError? _error;
        private DateTimeOffset _errorAt;
        private int _failures;
        private DateTimeOffset _lastRead = DateTimeOffset.MinValue;
        private DateTimeOffset? _requestedFor;
        private Task? _inflight;
        private long _refreshes;
        private long _failedRefreshes;

        public ArrSnapshotSlot(ArrSnapshotKind kind, Func<T?, CancellationToken, Task<ArrResult<T>>> loader)
        {
            Kind = kind;
            _loader = loader;
        }

        /// <summary>Raised after every refresh (on the refresh's thread) with the value when it succeeded.</summary>
        public event Action<ArrSnapshotSlot<T>, T?>? Refreshed;

        /// <summary>
        /// Raised when reads start failing (with the error) and when they work again (null), not on
        /// every failed attempt, so the log gets one line per outage.
        /// </summary>
        public event Action<ArrSnapshotKind, ArrError?>? HealthChanged;

        public ArrSnapshotKind Kind { get; }

        /// <summary>Last good value, when it was read, and the error of the latest attempt if that failed afterwards.</summary>
        public (T? Value, DateTimeOffset LoadedAt, ArrError? Error) Peek()
        {
            lock (_lock)
            {
                var error = _error != null && (_value == null || _errorAt >= _loadedAt) ? _error : null;
                return (_value, _loadedAt, error);
            }
        }

        public bool HasValue
        {
            get { lock (_lock) return _value != null; }
        }

        public DateTimeOffset LoadedAt
        {
            get { lock (_lock) return _loadedAt; }
        }

        public DateTimeOffset LastRead
        {
            get { lock (_lock) return _lastRead; }
        }

        public Task? Inflight
        {
            get { lock (_lock) return _inflight; }
        }

        /// <summary>Marks the snapshot as read now (keeps the reconciler refreshing it).</summary>
        public void Touch(DateTimeOffset now)
        {
            lock (_lock)
            {
                if (now > _lastRead) _lastRead = now;
            }
        }

        /// <summary>Puts a value in place without a refresh (warm start from the cache file).</summary>
        public void Seed(T value, DateTimeOffset loadedAt)
        {
            lock (_lock)
            {
                if (_value != null) return;
                _value = value;
                _loadedAt = loadedAt;
            }
        }

        /// <summary>True while the last attempts failed and the backoff since the last one has not passed.</summary>
        public bool InBackoff(DateTimeOffset now)
        {
            lock (_lock)
            {
                if (_failures == 0) return false;
                var wait = TimeSpan.FromTicks(Math.Min(MaxBackoff.Ticks, FirstBackoff.Ticks * (1L << Math.Min(_failures - 1, 10))));
                return now - _errorAt < wait;
            }
        }

        /// <summary>Asks for a refresh at <paramref name="at"/> unless one is already asked for earlier (debounce).</summary>
        public void Request(DateTimeOffset at)
        {
            lock (_lock)
            {
                if (_requestedFor == null || at < _requestedFor) _requestedFor = at;
            }
        }

        /// <summary>True when a debounced refresh request is due.</summary>
        public bool RequestDue(DateTimeOffset now)
        {
            lock (_lock) return _requestedFor is { } at && now >= at;
        }

        /// <summary>
        /// Starts a refresh unless one is running (single flight) and returns it. The refresh runs on
        /// the thread pool outside the caller's execution context, with <paramref name="background"/>
        /// as its call counter, and stops when <paramref name="shutdown"/> fires.
        /// </summary>
        public Task StartRefresh(ArrCallCounter background, Func<DateTimeOffset> now, CancellationToken shutdown)
        {
            lock (_lock)
            {
                if (_inflight != null) return _inflight;
                _requestedFor = null;
                Task<Task> outer;
                using (ExecutionContext.SuppressFlow())
                {
                    outer = new Task<Task>(() => RunAsync(background, now, shutdown));
                }
                var inner = outer.Unwrap();
                _inflight = inner;
                outer.Start(TaskScheduler.Default);
                return inner;
            }
        }

        private async Task RunAsync(ArrCallCounter background, Func<DateTimeOffset> now, CancellationToken shutdown)
        {
            ArrCallCounter.Current.Value = background;
            T? previous;
            lock (_lock) previous = _value;
            var started = now();
            ArrResult<T> result;
            try
            {
                result = await _loader(previous, shutdown).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (shutdown.IsCancellationRequested)
            {
                result = ArrResult<T>.Failure(ArrErrorKind.Internal, "Jellyfin is shutting down.");
            }
            catch (Exception ex)
            {
                result = ArrResult<T>.Failure(ArrErrorKind.Internal, "Reading the instance failed: " + ex.Message);
            }

            bool startedFailing, recovered;
            lock (_lock)
            {
                _refreshes++;
                startedFailing = !result.Ok && _failures == 0;
                recovered = result.Ok && _failures > 0;
                if (result.Ok)
                {
                    _value = result.Value;
                    _loadedAt = started;
                    _error = null;
                    _failures = 0;
                }
                else
                {
                    _error = result.Error;
                    _errorAt = now();
                    _failures++;
                    _failedRefreshes++;
                }
                _inflight = null;
            }

            try
            {
                Refreshed?.Invoke(this, result.Ok ? result.Value : null);
                if (startedFailing || recovered) HealthChanged?.Invoke(Kind, result.Error);
            }
            catch (Exception)
            {
                // Observers (the warm-start cache writer, the log) must never fail a refresh.
            }
        }

        public ArrSlotReport Report(DateTimeOffset now, int? count)
        {
            lock (_lock)
            {
                var error = _error != null && (_value == null || _errorAt >= _loadedAt) ? _error : null;
                return new ArrSlotReport
                {
                    Kind = Kind,
                    Loaded = _value != null,
                    LoadedAt = _value != null ? _loadedAt : null,
                    AgeSeconds = _value != null ? (long)(now - _loadedAt).TotalSeconds : null,
                    LastReadSecondsAgo = _lastRead == DateTimeOffset.MinValue ? null : (long)(now - _lastRead).TotalSeconds,
                    Refreshing = _inflight != null,
                    Records = count,
                    Refreshes = _refreshes,
                    FailedRefreshes = _failedRefreshes,
                    LastError = error == null ? null : new ArrSlotError { Kind = error.Kind, Message = error.Message, At = _errorAt },
                };
            }
        }
    }

    /// <summary>Non-generic view of a slot for the reconciler and diagnostics.</summary>
    internal interface IArrSnapshotSlot
    {
        ArrSnapshotKind Kind { get; }

        bool HasValue { get; }

        DateTimeOffset LoadedAt { get; }

        DateTimeOffset LastRead { get; }

        Task? Inflight { get; }

        bool InBackoff(DateTimeOffset now);

        bool RequestDue(DateTimeOffset now);

        void Request(DateTimeOffset at);

        Task StartRefresh(ArrCallCounter background, Func<DateTimeOffset> now, CancellationToken shutdown);
    }

    /// <summary>Diagnostics for one snapshot (admin only).</summary>
    public sealed class ArrSlotReport
    {
        /// <summary>Which snapshot.</summary>
        public ArrSnapshotKind Kind { get; init; }

        /// <summary>A value is in memory.</summary>
        public bool Loaded { get; init; }

        /// <summary>When it was read from the arr.</summary>
        public DateTimeOffset? LoadedAt { get; init; }

        /// <summary>Its age.</summary>
        public long? AgeSeconds { get; init; }

        /// <summary>Seconds since a page last read it.</summary>
        public long? LastReadSecondsAgo { get; init; }

        /// <summary>A refresh is running.</summary>
        public bool Refreshing { get; init; }

        /// <summary>Rows/titles held.</summary>
        public int? Records { get; init; }

        /// <summary>Refreshes since start.</summary>
        public long Refreshes { get; init; }

        /// <summary>Failed refreshes since start.</summary>
        public long FailedRefreshes { get; init; }

        /// <summary>The latest refresh's error when it failed.</summary>
        public ArrSlotError? LastError { get; init; }
    }

    /// <summary>A refresh error (admin only).</summary>
    public sealed class ArrSlotError
    {
        /// <summary>Category.</summary>
        public ArrErrorKind Kind { get; init; }

        /// <summary>Message.</summary>
        public string Message { get; init; } = string.Empty;

        /// <summary>When.</summary>
        public DateTimeOffset At { get; init; }
    }
}
