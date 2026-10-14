using System;
using System.Collections.Generic;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.AutoRequest
{
    /// <summary>
    /// Single-flight gate for playback triggers, replacing the old "checked in the last hour" set: a key
    /// is quiet while its work runs and, after a definitive outcome (a request recorded, or definitively
    /// nothing to do), for the cooldown. A failed lookup only backs off briefly (doubling up to a cap), so a
    /// TMDB or Seerr outage doesn't hide a trigger for an hour. Bounded: the least recently used idle keys
    /// are dropped beyond the capacity. Thread-safe; every call is constant time except an occasional
    /// eviction pass, which runs on the worker, never on the event thread.
    /// </summary>
    public sealed class PlaybackTriggerGate
    {
        private sealed class Entry
        {
            public bool InFlight;
            public DateTimeOffset Until;
            public int Failures;
            public long Used;
        }

        private readonly object _lock = new();
        private readonly Dictionary<string, Entry> _entries = new(StringComparer.Ordinal);
        private readonly TimeSpan _cooldown;
        private readonly TimeSpan _backoff;
        private readonly TimeSpan _maxBackoff;
        private readonly int _capacity;
        private readonly Func<DateTimeOffset> _now;
        private long _clock;

        /// <summary>Creates a gate.</summary>
        /// <param name="cooldown">Quiet time after a definitive outcome.</param>
        /// <param name="backoff">First quiet time after a failed lookup (doubles per failure).</param>
        /// <param name="maxBackoff">Longest quiet time after failures.</param>
        /// <param name="capacity">Most keys remembered.</param>
        /// <param name="now">Clock.</param>
        public PlaybackTriggerGate(TimeSpan cooldown, TimeSpan backoff, TimeSpan maxBackoff, int capacity, Func<DateTimeOffset> now)
        {
            _cooldown = cooldown;
            _backoff = backoff;
            _maxBackoff = maxBackoff;
            _capacity = Math.Max(1, capacity);
            _now = now;
        }

        /// <summary>The production gate: an hour after a definitive outcome (as before), two minutes (doubling to 30) after a failure, 4,096 keys.</summary>
        public static PlaybackTriggerGate Default() => new(TimeSpan.FromHours(1), TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(30), 4096, () => DateTimeOffset.UtcNow);

        /// <summary>Keys remembered (tests).</summary>
        public int Count
        {
            get { lock (_lock) return _entries.Count; }
        }

        /// <summary>True while the key's work runs or its quiet time lasts (a cheap check for event handlers).</summary>
        public bool IsQuiet(string key)
        {
            lock (_lock)
            {
                return _entries.TryGetValue(key, out var entry) && (entry.InFlight || entry.Until > _now());
            }
        }

        /// <summary>Starts work for a key; false when it is already running or quiet.</summary>
        public bool TryBegin(string key)
        {
            lock (_lock)
            {
                if (_entries.TryGetValue(key, out var entry))
                {
                    if (entry.InFlight || entry.Until > _now()) return false;
                }
                else
                {
                    entry = new Entry();
                    _entries[key] = entry;
                }
                entry.InFlight = true;
                entry.Used = ++_clock;
                if (_entries.Count > _capacity) Evict();
                return true;
            }
        }

        /// <summary>Ends a key's work: definitive outcomes start the cooldown, failures a short backoff, a cancel forgets the key.</summary>
        public void Complete(string key, AutoRequestOutcome outcome)
        {
            lock (_lock)
            {
                if (!_entries.TryGetValue(key, out var entry)) return;
                entry.InFlight = false;
                entry.Used = ++_clock;
                if (outcome.Definitive)
                {
                    entry.Failures = 0;
                    entry.Until = _now() + _cooldown;
                }
                else if (outcome.Kind == AutoRequestOutcomeKind.PreparationFailed)
                {
                    entry.Failures = Math.Min(entry.Failures + 1, 16);
                    var wait = TimeSpan.FromTicks(Math.Min(_maxBackoff.Ticks, _backoff.Ticks * (1L << Math.Min(entry.Failures - 1, 10))));
                    entry.Until = _now() + wait;
                }
                else
                {
                    _entries.Remove(key);
                }
            }
        }

        // Drops the least recently used idle keys (an eighth of the capacity at a time, so a full gate
        // doesn't scan on every new key). Keys with work in flight are never dropped.
        private void Evict()
        {
            var excess = _entries.Count - _capacity + Math.Max(1, _capacity / 8);
            foreach (var key in _entries.Where(e => !e.Value.InFlight).OrderBy(e => e.Value.Used).Take(excess).Select(e => e.Key).ToList())
                _entries.Remove(key);
        }
    }
}
