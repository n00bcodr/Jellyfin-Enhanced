using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// The titles each user asked for in Seerr (TMDB id and media type), as the legacy Requests
    /// page's queue and history routes read them when the request read model isn't running. One read
    /// per user and Seerr address, shared by both routes. Answers are dropped when the Seerr
    /// settings are saved, and reads already running can't put their old answers back:
    /// <list type="bullet">
    /// <item><description>an answer younger than <see cref="Fresh"/> (about 30 seconds) is reused as it is;</description></item>
    /// <item><description>an older one, up to <see cref="MaxStale"/> (10 minutes), is served at once while
    /// a new read runs in the background, even when Seerr can't be read;</description></item>
    /// <item><description>with no answer at all, the read is waited on for at most the wait time (2 s); the
    /// caller then answers without it and the read keeps running for the next call;</description></item>
    /// <item><description>a read that failed is not tried again within <see cref="Fresh"/> (a slow or down
    /// Seerr costs one read per user per poll interval, not one per request).</description></item>
    /// </list>
    /// </summary>
    internal sealed class SeerrAskedProofCache
    {
        /// <summary>How long an answer is reused without a new read.</summary>
        public static readonly TimeSpan Fresh = TimeSpan.FromSeconds(30);

        /// <summary>How long an older answer is still served while a new read runs.</summary>
        public static readonly TimeSpan MaxStale = TimeSpan.FromMinutes(10);

        private const int MaxEntries = 2000;

        private readonly ConcurrentDictionary<string, Entry> _entries = new(StringComparer.Ordinal);
        private readonly Func<long> _now;
        private readonly TimeSpan _wait;
        private long _generation;

        /// <summary>Creates a cache with a clock (ticks) and a wait (tests); <see cref="Shared"/> is the server's, on the
        /// monotonic clock (<see cref="MonotonicClock"/>): a wall-clock step never lengthens or shortens an entry.</summary>
        internal SeerrAskedProofCache(Func<long>? now = null, TimeSpan? wait = null)
        {
            _now = now ?? MonotonicClock.Now;
            _wait = wait ?? TimeSpan.FromSeconds(2);
        }

        /// <summary>The cache the routes share.</summary>
        public static SeerrAskedProofCache Shared { get; } = new();

        /// <summary>Drops every answer and prevents reads already running from caching their results.</summary>
        internal void Clear()
        {
            Interlocked.Increment(ref _generation);
            _entries.Clear();
        }

        /// <summary>
        /// The user's asked-for titles under <paramref name="key"/> (user and Seerr address), read
        /// with <paramref name="read"/> when needed (null from it = the read failed). Null when there
        /// is no answer in time.
        /// </summary>
        public async Task<IReadOnlySet<(int TmdbId, string MediaType)>?> GetAsync(string key, Func<Task<IReadOnlySet<(int TmdbId, string MediaType)>?>> read)
        {
            if (_entries.Count > MaxEntries) _entries.Clear();
            var entry = _entries.GetOrAdd(key, _ => new Entry());
            Task<IReadOnlySet<(int TmdbId, string MediaType)>?>? pending;
            IReadOnlySet<(int TmdbId, string MediaType)>? stale;
            lock (entry)
            {
                var now = _now();
                if (entry.Value != null && now - entry.At < Fresh.Ticks) return entry.Value;
                stale = entry.Value != null && now - entry.At < MaxStale.Ticks ? entry.Value : null;
                if (entry.Inflight == null && !(entry.FailedAt is { } failed && now - failed < Fresh.Ticks))
                    entry.Inflight = Run(entry, read);
                pending = entry.Inflight;
            }
            if (stale != null || pending == null) return stale;
            try
            {
                return await pending.WaitAsync(_wait).ConfigureAwait(false);
            }
            catch (TimeoutException)
            {
                return null;
            }
        }

        private Task<IReadOnlySet<(int TmdbId, string MediaType)>?> Run(Entry entry, Func<Task<IReadOnlySet<(int TmdbId, string MediaType)>?>> read)
        {
            var generation = Interlocked.Read(ref _generation);
            // The answer lives from the start of its read (not from when Seerr's reply came in).
            var startedAt = _now();
            // Outlives the request that started it: no request state flows into it.
            using (ExecutionContext.SuppressFlow())
            {
                return Task.Run(async () =>
                {
                    IReadOnlySet<(int TmdbId, string MediaType)>? value = null;
                    try
                    {
                        value = await read().ConfigureAwait(false);
                    }
                    catch (Exception)
                    {
                        // A failed read: no answer this time.
                    }
                    lock (entry)
                    {
                        entry.Inflight = null;
                        if (generation != Interlocked.Read(ref _generation)) return null;
                        if (value != null)
                        {
                            entry.Value = value;
                            entry.At = startedAt;
                            entry.FailedAt = null;
                        }
                        else
                        {
                            entry.FailedAt = startedAt;
                        }
                    }
                    return value;
                });
            }
        }

        private sealed class Entry
        {
            public IReadOnlySet<(int TmdbId, string MediaType)>? Value { get; set; }

            public long At { get; set; }

            public long? FailedAt { get; set; }

            public Task<IReadOnlySet<(int TmdbId, string MediaType)>?>? Inflight { get; set; }
        }
    }
}
