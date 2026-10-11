using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live
{
    /// <summary>
    /// The change feed browsers long-poll: every time the snapshots (or Jellyfin's library) show
    /// that something about a title changed, its key gets a new revision here. A revision is the
    /// feed cursor at that moment, so revisions only ever grow.
    /// <list type="bullet">
    /// <item><description>A bounded ring of recent changes (<see cref="Capacity"/> entries, at most
    /// <see cref="Retention"/> old). A cursor older than the ring gets <c>reset</c>: the client
    /// re-reads everything it shows.</description></item>
    /// <item><description>An <see cref="Epoch"/> per process start: cursors from before a restart
    /// are reset too.</description></item>
    /// <item><description>Waiters are woken on every change; each one filters for itself.</description></item>
    /// </list>
    /// Thread-safe. Carries title keys and instance ids only (no titles, paths or URLs).
    /// </summary>
    public sealed class ArrChangeFeed
    {
        /// <summary>Changes kept.</summary>
        public const int Capacity = 8192;

        /// <summary>Most keys returned in one read; a longer list is a reset.</summary>
        public const int MaxKeysPerRead = 500;

        /// <summary>How long a change stays readable.</summary>
        public static readonly TimeSpan Retention = TimeSpan.FromHours(48);

        private const int MaxRevisions = 100_000;

        private readonly object _lock = new();
        private readonly Func<DateTimeOffset> _now;
        private readonly Entry[] _ring = new Entry[Capacity];
        private readonly Dictionary<string, long> _revisions = new(StringComparer.Ordinal);
        private int _count;
        private int _next;
        private long _cursor;
        private long _totalBumps;
        private long _trimmedUpTo;
        private long _resetFloor;
        private TaskCompletionSource _signal = NewSignal();

        /// <summary>Creates the feed.</summary>
        public ArrChangeFeed()
            : this(null)
        {
        }

        /// <summary>Creates the feed with a clock (tests).</summary>
        internal ArrChangeFeed(Func<DateTimeOffset>? now)
        {
            _now = now ?? (() => DateTimeOffset.UtcNow);
            Epoch = Convert.ToHexString(RandomNumberGenerator.GetBytes(6)).ToLowerInvariant();
        }

        /// <summary>Changes on every process start; a client holding another epoch starts over.</summary>
        public string Epoch { get; }

        /// <summary>The newest cursor (0 before the first change).</summary>
        public long Cursor
        {
            get { lock (_lock) return _cursor; }
        }

        /// <summary>Keys bumped since start (diagnostics).</summary>
        public long TotalBumps
        {
            get { lock (_lock) return _totalBumps; }
        }

        /// <summary>
        /// The revision of a key (0 when it never changed since start). It never goes back: a key
        /// whose revision was dropped to bound memory reads as the newest dropped revision, so a
        /// cache keyed by revisions never sees an older value again.
        /// </summary>
        public long Revision(string key)
        {
            lock (_lock) return _revisions.TryGetValue(key, out var rev) ? rev : _trimmedUpTo;
        }

        /// <summary>
        /// Records a change of each key (duplicates in one call count once) and wakes the waiters.
        /// <paramref name="instanceId"/> names the arr instance whose snapshot showed it (null for
        /// Jellyfin library changes). Returns the number of keys recorded.
        /// </summary>
        public int Bump(IEnumerable<string> keys, string? instanceId = null)
        {
            ArgumentNullException.ThrowIfNull(keys);
            TaskCompletionSource signal;
            var added = 0;
            lock (_lock)
            {
                var now = _now();
                foreach (var key in keys.Distinct(StringComparer.Ordinal))
                {
                    if (!ArrTitleKey.IsValid(key)) continue;
                    _cursor++;
                    _ring[_next] = new Entry(_cursor, key, instanceId, now);
                    _next = (_next + 1) % Capacity;
                    if (_count < Capacity) _count++;
                    _revisions[key] = _cursor;
                    added++;
                }
                if (added == 0) return 0;
                _totalBumps += added;
                if (_revisions.Count > MaxRevisions) TrimRevisions();
                signal = _signal;
                _signal = NewSignal();
            }
            signal.TrySetResult();
            return added;
        }

        /// <summary>
        /// Tells every client to re-read everything it shows (their next read is a reset): for a
        /// change too wide to list key by key, such as the first load of an instance's library,
        /// which may have been served as "loading" a moment before. Wakes the waiters.
        /// </summary>
        public void ResetAll()
        {
            TaskCompletionSource signal;
            lock (_lock)
            {
                _cursor++;
                // A keyless entry keeps one ring entry per cursor; reads skip it.
                _ring[_next] = new Entry(_cursor, string.Empty, null, _now());
                _next = (_next + 1) % Capacity;
                if (_count < Capacity) _count++;
                _resetFloor = _cursor;
                signal = _signal;
                _signal = NewSignal();
            }
            signal.TrySetResult();
        }

        /// <summary>
        /// The changes after <paramref name="after"/> (newest per key, oldest first), or a reset when
        /// the cursor is from another epoch, ahead of the feed, older than what the ring holds, or
        /// from before a <see cref="ResetAll"/>. Each change lists every instance that contributed
        /// to it (<see cref="ArrFeedChange.Sources"/>).
        /// </summary>
        public ArrFeedRead Read(string? epoch, long after)
        {
            lock (_lock)
            {
                var now = _now();
                if (!string.Equals(epoch, Epoch, StringComparison.Ordinal) || after < 0 || after > _cursor)
                    return new ArrFeedRead(_cursor, Array.Empty<ArrFeedChange>(), Reset: true);
                if (after == _cursor) return new ArrFeedRead(_cursor, Array.Empty<ArrFeedChange>(), Reset: false);

                var oldest = OldestLocked(now);
                // Entries (oldest+1 .. cursor) are all held: anything at or before "oldest" is gone.
                if (after < oldest || after < _resetFloor) return new ArrFeedRead(_cursor, Array.Empty<ArrFeedChange>(), Reset: true);

                var count = (int)(_cursor - after);
                var changes = new List<ArrFeedChange>(Math.Min(count, 64));
                var seen = new Dictionary<string, int>(StringComparer.Ordinal);
                var sources = new List<List<string?>>(Math.Min(count, 64));
                for (var i = count; i >= 1; i--)
                {
                    var e = _ring[Index(_cursor - i + 1)];
                    if (e.Key.Length == 0) continue;
                    if (seen.TryGetValue(e.Key, out var at))
                    {
                        changes[at] = changes[at] with { Cursor = e.Cursor, InstanceId = e.InstanceId ?? changes[at].InstanceId };
                        if (!sources[at].Contains(e.InstanceId, StringComparer.OrdinalIgnoreCase)) sources[at].Add(e.InstanceId);
                        continue;
                    }
                    seen[e.Key] = changes.Count;
                    changes.Add(new ArrFeedChange(e.Key, e.Cursor, e.InstanceId));
                    sources.Add(new List<string?> { e.InstanceId });
                }
                for (var i = 0; i < changes.Count; i++)
                {
                    changes[i] = changes[i] with { Sources = sources[i] };
                }
                return new ArrFeedRead(_cursor, changes, Reset: false);
            }
        }

        /// <summary>
        /// Completes when a change after <paramref name="after"/> exists or <paramref name="timeout"/>
        /// passes (whichever is first). Never throws on timeout; throws on cancellation.
        /// </summary>
        public async Task WaitAsync(long after, TimeSpan timeout, CancellationToken cancellationToken)
        {
            Task signal;
            lock (_lock)
            {
                if (_cursor != after) return;
                signal = _signal.Task;
            }
            if (timeout <= TimeSpan.Zero) return;
            try
            {
                await signal.WaitAsync(timeout, cancellationToken).ConfigureAwait(false);
            }
            catch (TimeoutException)
            {
                // nothing new
            }
        }

        // The cursor just before the oldest change still held (and not expired).
        private long OldestLocked(DateTimeOffset now)
        {
            var first = _cursor - _count + 1;
            var cutoff = now - Retention;
            while (first <= _cursor && _ring[Index(first)].At < cutoff) first++;
            return first - 1;
        }

        private int Index(long cursor) => (int)((cursor - 1) % Capacity);

        // Keeps the newest revisions when the map grows past its bound (a very large library churning).
        private void TrimRevisions()
        {
            var ordered = _revisions.OrderByDescending(r => r.Value).ToList();
            var keep = ordered.Take(MaxRevisions / 2).ToList();
            if (ordered.Count > keep.Count) _trimmedUpTo = Math.Max(_trimmedUpTo, ordered[keep.Count].Value);
            _revisions.Clear();
            foreach (var (k, v) in keep) _revisions[k] = v;
        }

        private static TaskCompletionSource NewSignal() => new(TaskCreationOptions.RunContinuationsAsynchronously);

        private readonly record struct Entry(long Cursor, string Key, string? InstanceId, DateTimeOffset At);
    }

    /// <summary>One changed key in a feed read.</summary>
    /// <param name="Key">Title key.</param>
    /// <param name="Cursor">Its newest revision.</param>
    /// <param name="InstanceId">The newest instance whose data showed the change (null: Jellyfin's library).</param>
    /// <param name="Sources">Every source of the key's changes in the read (instance ids; null for
    /// Jellyfin's library). Null means <paramref name="InstanceId"/> alone.</param>
    public sealed record ArrFeedChange(string Key, long Cursor, string? InstanceId, IReadOnlyList<string?>? Sources = null)
    {
        /// <summary>The sources to check (<see cref="Sources"/>, or <see cref="InstanceId"/> alone).</summary>
        public IReadOnlyList<string?> AllSources => Sources is { Count: > 0 } s ? s : new[] { InstanceId };
    }

    /// <summary>The result of a feed read.</summary>
    /// <param name="Cursor">The newest cursor; the client sends it back next time.</param>
    /// <param name="Changes">Changed keys, oldest first.</param>
    /// <param name="Reset">True: the client's cursor can't be served; it must re-read everything it shows.</param>
    public sealed record ArrFeedRead(long Cursor, IReadOnlyList<ArrFeedChange> Changes, bool Reset);

    /// <summary>
    /// Bounds the long-polls held open: a few per user (one per open tab, give or take) and a
    /// server-wide total, so a misbehaving client or a crowd of tabs can't tie up the server.
    /// </summary>
    public sealed class ArrFeedLimits
    {
        /// <summary>Long-polls one user may hold at once.</summary>
        public const int PerUser = 4;

        /// <summary>Long-polls the server holds at once.</summary>
        public const int Total = 200;

        private readonly object _lock = new();
        private readonly Dictionary<Guid, int> _perUser = new();
        private int _total;

        /// <summary>Long-polls held right now.</summary>
        public int Waiting
        {
            get { lock (_lock) return _total; }
        }

        /// <summary>Takes a slot for the user; false when the user or the server is at the limit.</summary>
        public bool TryEnter(Guid userId)
        {
            lock (_lock)
            {
                _perUser.TryGetValue(userId, out var mine);
                if (mine >= PerUser || _total >= Total) return false;
                _perUser[userId] = mine + 1;
                _total++;
                return true;
            }
        }

        /// <summary>Gives a slot back.</summary>
        public void Exit(Guid userId)
        {
            lock (_lock)
            {
                if (!_perUser.TryGetValue(userId, out var mine)) return;
                if (mine <= 1) _perUser.Remove(userId);
                else _perUser[userId] = mine - 1;
                _total = Math.Max(0, _total - 1);
            }
        }
    }
}
