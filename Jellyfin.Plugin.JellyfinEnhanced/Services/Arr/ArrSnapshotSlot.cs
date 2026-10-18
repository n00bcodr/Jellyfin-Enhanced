using System;
using System.Collections.Generic;
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
        private readonly Func<Task, bool>? _trackBackground;
        private readonly Func<T, bool>? _incomplete;
        private readonly TimeSpan _keepHeldFor;
        private T? _value;
        private DateTimeOffset _loadedAt;
        private DateTimeOffset _keptAt = DateTimeOffset.MinValue;
        private ArrError? _error;
        private DateTimeOffset _errorAt;
        private int _failures;
        private DateTimeOffset _lastRead = DateTimeOffset.MinValue;
        private DateTimeOffset _lastBackgroundRead = DateTimeOffset.MinValue;
        private DateTimeOffset? _requestedFor;
        private Task? _inflight;
        private bool _retired;
        private DateTimeOffset? _inflightStartedAt;
        private long _refreshes;
        private long _failedRefreshes;
        private List<Func<T, T?>>? _patchesDuringRefresh;

        /// <summary>A snapshot with optional completeness policy and background-task ownership.</summary>
        /// <param name="kind">Snapshot kind.</param>
        /// <param name="loader">Reads the snapshot (gets the value held, if any).</param>
        /// <param name="incomplete">
        /// Optional: tells a read that the arr answered but that may be missing rows (see
        /// <paramref name="keepHeldFor"/>).
        /// </param>
        /// <param name="keepHeldFor">
        /// How old a complete value may be and still be kept over an incomplete read: such a refresh
        /// then keeps the value held (with its own age), counts as no failure (no backoff, no
        /// error) and raises no change. An older value, or an incomplete one, is replaced by it.
        /// </param>
        /// <param name="trackBackground">Registers the full refresh before scheduling, or refuses it during shutdown.</param>
        public ArrSnapshotSlot(ArrSnapshotKind kind, Func<T?, CancellationToken, Task<ArrResult<T>>> loader, Func<T, bool>? incomplete = null, TimeSpan keepHeldFor = default, Func<Task, bool>? trackBackground = null)
        {
            Kind = kind;
            _loader = loader;
            _incomplete = incomplete;
            _keepHeldFor = keepHeldFor;
            _trackBackground = trackBackground;
        }

        /// <summary>
        /// Raised after every refresh (on the refresh's thread) with the value when it succeeded and
        /// was published; null when it failed or was kept (see <see cref="Kept"/>).
        /// </summary>
        public event Action<ArrSnapshotSlot<T>, T?>? Refreshed;

        /// <summary>
        /// Raised after a successful refresh or a patch, with the value before and after (the value
        /// before is null on the first load). Raised outside the slot's lock, on the refresh's thread.
        /// </summary>
        public event Action<T?, T>? Replaced;

        /// <summary>
        /// Called inside the slot's lock whenever a new value is put in place (a refresh or a patch),
        /// with the value before and after, so publications are seen strictly in order. Keep it short;
        /// it must never call back into the slot. Failures are ignored.
        /// </summary>
        public Action<T?, T>? Publishing { get; set; }

        /// <summary>
        /// Raised when reads start failing (with the error) and when they work again (null), not on
        /// every failed attempt, so the log gets one line per outage.
        /// </summary>
        public event Action<ArrSnapshotKind, ArrError?>? HealthChanged;

        /// <summary>
        /// Raised with a read the arr answered that was not published: an incomplete read kept
        /// behind a recent complete value. Its rows are real even though nobody is shown them.
        /// Runs under the publication lock; handlers must be quick and must not start reads.
        /// </summary>
        public event Action<T>? Kept;

        public ArrSnapshotKind Kind { get; }

        /// <summary>
        /// The last good value as published (one reference, read without the lock: a refresh replaces it whole). What the
        /// automatic-write check's decision reads.
        /// </summary>
        public T? Current => Volatile.Read(ref _value);

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

        /// <summary>
        /// When the instance was last read successfully: <see cref="LoadedAt"/>, or later when an
        /// incomplete read was answered and the held value kept (its age stays <see cref="LoadedAt"/>).
        /// Refreshes are paced from this, so a kept value isn't read again at once.
        /// </summary>
        public DateTimeOffset CheckedAt
        {
            get { lock (_lock) return _keptAt > _loadedAt ? _keptAt : _loadedAt; }
        }

        public DateTimeOffset LastRead
        {
            get { lock (_lock) return _lastRead; }
        }

        /// <summary>
        /// The latest read of any kind: a page's (<see cref="Touch"/>) or a background reader's
        /// (<see cref="TouchBackground"/>). Keeps the reconciler refreshing the snapshot.
        /// </summary>
        public DateTimeOffset LastInterest
        {
            get { lock (_lock) return _lastRead > _lastBackgroundRead ? _lastRead : _lastBackgroundRead; }
        }

        public Task? Inflight
        {
            get { lock (_lock) return _inflight; }
        }

        /// <summary>True once the slot was dropped (<see cref="TryRetire"/>): it never loads again.</summary>
        public bool Retired
        {
            get { lock (_lock) return _retired; }
        }

        /// <summary>
        /// Retires the slot unless a refresh is running, in one step: a slot is either loading (and
        /// kept) or retired (and never starts a load), so whoever still holds it can't start an
        /// unowned load after it was dropped.
        /// </summary>
        public bool TryRetire()
        {
            lock (_lock)
            {
                if (_inflight != null) return false;
                _retired = true;
                return true;
            }
        }

        /// <summary>Marks the snapshot as read now (keeps the reconciler refreshing it).</summary>
        public void Touch(DateTimeOffset now)
        {
            lock (_lock)
            {
                if (now > _lastRead) _lastRead = now;
            }
        }

        /// <summary>
        /// Marks the snapshot as read now by a background reader (the administrators' alert check):
        /// the reconciler keeps refreshing it at its idle pace, but it doesn't count as a page
        /// watching it (<see cref="LastRead"/> is left alone).
        /// </summary>
        public void TouchBackground(DateTimeOffset now)
        {
            lock (_lock)
            {
                if (now > _lastBackgroundRead) _lastBackgroundRead = now;
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
        /// Changes the value in place (a live event carried the new data), keeping its age. The patch
        /// returns the new value, or null for "no change". A patch made while a refresh is running is
        /// applied again to that refresh's result, so the older read can't undo it, unless the patch
        /// comes from a read that started (<paramref name="readStartedAt"/>) before that refresh did:
        /// then the refresh is the newer read and its result stands. Returns the value before and
        /// after, or null when nothing changed (or nothing is loaded yet).
        /// </summary>
        public (T Before, T After)? Patch(Func<T, T?> patch, DateTimeOffset? readStartedAt = null)
        {
            T before, after;
            lock (_lock)
            {
                if (_value == null) return null;
                var next = patch(_value);
                if (next == null || ReferenceEquals(next, _value)) return null;
                before = _value;
                after = next;
                _value = next;
                Publish(before, after);
                // A refresh that hasn't started reading yet (no start time) reads after this read.
                var newerThanRefresh = readStartedAt is not { } read || (_inflightStartedAt is { } refresh && refresh <= read);
                if (_inflight != null && newerThanRefresh) (_patchesDuringRefresh ??= new List<Func<T, T?>>()).Add(patch);
            }
            return (before, after);
        }

        /// <summary>
        /// Starts a refresh unless one is running (single flight) and returns it. The refresh runs on
        /// the thread pool outside the caller's execution context, with <paramref name="background"/>
        /// as its call counter, and stops when <paramref name="shutdown"/> fires. A retired slot
        /// starts nothing.
        /// </summary>
        public Task StartRefresh(ArrCallCounter background, Func<DateTimeOffset> now, CancellationToken shutdown)
        {
            lock (_lock)
            {
                if (_inflight != null) return _inflight;
                if (_retired || shutdown.IsCancellationRequested) return Task.CompletedTask;
                _requestedFor = null;
                _inflightStartedAt = null;
                Task<Task> outer;
                using (ExecutionContext.SuppressFlow())
                {
                    outer = new Task<Task>(() => RunAsync(background, now, shutdown));
                }
                var inner = outer.Unwrap();
                // Register before scheduling: shutdown either owns this entire refresh (including
                // observers) or refuses it. Even slots from replaced states remain owned.
                if (_trackBackground?.Invoke(inner) == false) return Task.CompletedTask;
                _inflight = inner;
                outer.Start(TaskScheduler.Default);
                return inner;
            }
        }

        private async Task RunAsync(ArrCallCounter background, Func<DateTimeOffset> now, CancellationToken shutdown)
        {
            ArrCallCounter.Current.Value = background;
            T? previous;
            DateTimeOffset started;
            lock (_lock)
            {
                previous = _value;
                started = now();
                _inflightStartedAt = started;
            }
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
            T? before = null;
            T? after = null;
            lock (_lock)
            {
                _refreshes++;
                startedFailing = !result.Ok && _failures == 0;
                recovered = result.Ok && _failures > 0;
                var patches = _patchesDuringRefresh;
                _patchesDuringRefresh = null;
                if (result.Ok && KeepHeld(result.Value!, started))
                {
                    // The arr answered, so this is no failure; the held value (with live patches
                    // already applied to it) stays, with its own age.
                    _keptAt = started;
                    // Like Publishing, this bookkeeping must precede the next read.
                    Notify(() => Kept?.Invoke(result.Value!));
                    _error = null;
                    _failures = 0;
                }
                else if (result.Ok)
                {
                    var value = result.Value!;
                    // Live patches that arrived while this read ran are newer than (or equal to) it.
                    foreach (var patch in patches ?? new List<Func<T, T?>>())
                    {
                        try
                        {
                            value = patch(value) ?? value;
                        }
                        catch (Exception)
                        {
                            // A patch that no longer applies is dropped; the read is the truth.
                        }
                    }
                    before = _value;
                    after = value;
                    _value = value;
                    Publish(before, after);
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
                _inflightStartedAt = null;
            }

            // Observers (the warm-start cache writer, the log, the change feed) must never fail a
            // refresh, nor stop each other.
            Notify(() => Refreshed?.Invoke(this, result.Ok ? after : null));
            if (after != null) Notify(() => Replaced?.Invoke(before, after));
            if (startedFailing || recovered) Notify(() => HealthChanged?.Invoke(Kind, result.Error));
        }

        // Under the slot's lock.
        private void Publish(T? before, T after)
        {
            try
            {
                Publishing?.Invoke(before, after);
            }
            catch (Exception)
            {
                // An observer never fails a publication.
            }
        }

        // Under the lock: an incomplete read doesn't replace a complete value that is recent enough.
        private bool KeepHeld(T read, DateTimeOffset started)
            => _incomplete != null && _value != null && _incomplete(read) && !_incomplete(_value) && started - _loadedAt <= _keepHeldFor;

        private static void Notify(Action raise)
        {
            try
            {
                raise();
            }
            catch (Exception)
            {
                // see above
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

        DateTimeOffset CheckedAt { get; }

        DateTimeOffset LastRead { get; }

        DateTimeOffset LastInterest { get; }

        Task? Inflight { get; }

        bool Retired { get; }

        bool InBackoff(DateTimeOffset now);

        void Touch(DateTimeOffset now);

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
