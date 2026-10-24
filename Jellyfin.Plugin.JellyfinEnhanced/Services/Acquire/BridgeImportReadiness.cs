using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>Where one import's metadata has got to (<see cref="BridgeImportReadiness"/>).</summary>
    public static class ImportReadinessState
    {
        /// <summary>The imported file is still changing or Jellyfin hasn't listed it yet.</summary>
        public const string Indexing = "indexing";

        /// <summary>Jellyfin lists it; its title, overview, artwork or media info are still being read.</summary>
        public const string Hydrating = "hydrating";

        /// <summary>Ready: the metadata was read back and is complete.</summary>
        public const string Ready = "ready";

        /// <summary>Ready with something still missing (a provider found no artwork, or the wait ran out): see the reason.</summary>
        public const string ReadyMetadataPending = "ready_metadata_pending";
    }

    /// <summary>One import the readiness gate follows, for the System tab and the logs.</summary>
    public sealed class ImportReadinessEntry
    {
        /// <summary>The imported file as Jellyfin sees it.</summary>
        public string Path { get; init; } = string.Empty;

        /// <summary>The import it came from (instance and arr history record), so a newer import of the same path is told apart.</summary>
        public string Generation { get; init; } = string.Empty;

        /// <summary>The title key of the import (movie, or the episode's key), when known.</summary>
        public string? Key { get; init; }

        /// <summary>When the gate started following it (UTC).</summary>
        public DateTimeOffset Began { get; init; }

        /// <summary>One of <see cref="ImportReadinessState"/>.</summary>
        public string State { get; init; } = ImportReadinessState.Indexing;

        /// <summary>The Jellyfin item(s) the file became (the episode or movie, and a new series), once known.</summary>
        public IReadOnlyList<Guid> ItemIds { get; init; } = Array.Empty<Guid>();

        /// <summary>When it was published Ready (UTC), or null.</summary>
        public DateTimeOffset? ReadyAt { get; init; }

        /// <summary>What was still missing when it was published anyway, or why it waited (no secrets, no paths).</summary>
        public string? Reason { get; init; }
    }

    /// <summary>A just-imported item was published Ready (its metadata read back, or the bounded wait ended).</summary>
    /// <param name="Key">The import's title key, when known.</param>
    /// <param name="ItemIds">The Jellyfin items it became.</param>
    /// <param name="Verified">True when its metadata was read back complete; false when published with something missing.</param>
    /// <param name="Reason">What was missing (null when verified).</param>
    public sealed record ImportReadyRelease(string? Key, IReadOnlyList<Guid> ItemIds, bool Verified, string? Reason);

    /// <summary>
    /// The one "is a just-imported copy Ready yet" gate (Requests &amp; downloads, bridge). Jellyfin lists an imported
    /// file within a second, long before its title, overview, artwork and media info are read; and a first read that found
    /// nothing can leave the item with its raw folder name for good (a later default scan skips it). The Jellyfin bridge
    /// registers every import here before it asks Jellyfin to refresh anything, so the item Jellyfin is about to add is
    /// "awaiting metadata" from its first moment; it attaches the item ids once Jellyfin has them, has the item's metadata
    /// read (and repaired) and publishes it Ready exactly once after reading it back, or after a bounded wait with a
    /// visible reason. Status, notifications, request fulfilment, the Ready playlist and list swap-in all read
    /// <see cref="Pending"/> through the Jellyfin view (<see cref="JfItemRef.AwaitingMetadata"/>,
    /// <see cref="EditionAvailability.Plays(JfItemRef)"/>) and the list adapter, and wake on <see cref="Released"/>.
    /// Entries are bounded in number and in time: one never released (the bridge stopped mid-way) stops gating after
    /// <see cref="MaxHold"/>, so nothing waits forever.
    /// </summary>
    public sealed class BridgeImportReadiness
    {
        private const int MaxEntries = 500;
        private const int MaxDone = 50;
        private readonly object _lock = new();
        private readonly Func<DateTimeOffset> _now;
        private readonly ArrChangeFeed? _feed;
        private readonly Dictionary<string, Entry> _byPath = new(StringComparer.Ordinal);
        private readonly Dictionary<Guid, Entry> _byItem = new();
        private readonly LinkedList<ImportReadinessEntry> _done = new();
        private long _revision;

        /// <summary>The gate (DI).</summary>
        public BridgeImportReadiness(ArrChangeFeed feed)
            : this(feed, null)
        {
        }

        /// <summary>The gate with an explicit clock (tests; the feed may be absent).</summary>
        internal BridgeImportReadiness(ArrChangeFeed? feed, Func<DateTimeOffset>? now)
        {
            _feed = feed;
            _now = now ?? (() => DateTimeOffset.UtcNow);
        }

        /// <summary>How long an entry gates at most, whatever happens to its follow-up (window plus margin; the bridge sets it).</summary>
        public TimeSpan MaxHold { get; set; } = TimeSpan.FromMinutes(15);

        /// <summary>Changes whenever an import starts or stops gating (cached compositions read it through the Jellyfin view's revision).</summary>
        public long Revision => System.Threading.Interlocked.Read(ref _revision);

        /// <summary>Raised (after the change) whenever an import starts or stops gating. Handlers must be quick.</summary>
        public event Action? Changed;

        /// <summary>Raised once per import when it is published Ready. Handlers must be quick and never throw back.</summary>
        public event Action<ImportReadyRelease>? Released;

        /// <summary>
        /// True while the item (by id, or by its file path before the bridge knows its id) is a just-imported copy
        /// whose metadata isn't confirmed yet: nothing may call it Ready. False for every other item.
        /// </summary>
        public bool Pending(Guid itemId, string? path)
        {
            lock (_lock)
            {
                if (_byPath.Count == 0) return false;
                var now = _now();
                if (!itemId.Equals(Guid.Empty) && _byItem.TryGetValue(itemId, out var byItem) && Holds(byItem, now)) return true;
                return !string.IsNullOrEmpty(path) && _byPath.TryGetValue(BridgePaths.Norm(path), out var byPath) && Holds(byPath, now);
            }
        }

        /// <summary>True when this exact import (path and generation) is still being followed (the bridge's own jobs stop when it isn't).</summary>
        public bool Following(string path, string generation)
        {
            lock (_lock) return _byPath.TryGetValue(BridgePaths.Norm(path), out var e) && e.Generation == generation;
        }

        /// <summary>
        /// Starts gating an import of <paramref name="path"/>: before Jellyfin is asked to refresh anything, so the item it
        /// adds is awaiting metadata from its first moment. A newer import of the same path replaces the older one (whose
        /// follow-up can then no longer publish it).
        /// </summary>
        public void Begin(string path, string generation, string? key)
        {
            var p = BridgePaths.Norm(path);
            lock (_lock)
            {
                if (_byPath.TryGetValue(p, out var old))
                {
                    if (old.Generation == generation) return;
                    Forget(old);
                }
                if (_byPath.Count >= MaxEntries) Prune();
                if (_byPath.Count >= MaxEntries) return;
                _byPath[p] = new Entry(p, generation, key, _now());
            }
            Bump();
        }

        /// <summary>The Jellyfin items the import became (its movie or episode, a new series), so the gate holds them by id too.</summary>
        public void Attach(string path, string generation, params Guid[] itemIds)
        {
            var changed = false;
            lock (_lock)
            {
                if (!_byPath.TryGetValue(BridgePaths.Norm(path), out var e) || e.Generation != generation) return;
                foreach (var id in itemIds)
                {
                    if (id.Equals(Guid.Empty) || e.Items.Contains(id)) continue;
                    // An item another import still holds stays that one's (the newer import's own entry attaches its own file).
                    if (_byItem.TryGetValue(id, out var other) && !ReferenceEquals(other, e) && Holds(other, _now())) continue;
                    e.Items.Add(id);
                    _byItem[id] = e;
                    changed = true;
                }
                if (e.State == ImportReadinessState.Indexing && e.Items.Count > 0) e.State = ImportReadinessState.Hydrating;
            }
            if (changed) Bump();
        }

        /// <summary>Notes why an import still waits (shown in the System tab), without changing whether it gates.</summary>
        public void Note(string path, string generation, string reason)
        {
            lock (_lock)
            {
                if (_byPath.TryGetValue(BridgePaths.Norm(path), out var e) && e.Generation == generation) e.Reason = reason;
            }
        }

        /// <summary>
        /// Publishes the import Ready: verified (<paramref name="missing"/> null), or with what is still missing. Only the
        /// import that is still the path's current one is published, once; returns false otherwise.
        /// </summary>
        public bool Release(string path, string generation, string? missing)
        {
            ImportReadyRelease release;
            lock (_lock)
            {
                if (!_byPath.TryGetValue(BridgePaths.Norm(path), out var e) || e.Generation != generation) return false;
                Forget(e);
                var verified = missing == null;
                var done = Snapshot(e, verified ? ImportReadinessState.Ready : ImportReadinessState.ReadyMetadataPending, _now(), missing);
                _done.AddFirst(done);
                while (_done.Count > MaxDone) _done.RemoveLast();
                release = new ImportReadyRelease(e.Key, e.Items.ToList(), verified, missing);
            }
            Bump();
            if (release.Key != null)
            {
                try
                {
                    _feed?.Bump(new[] { release.Key });
                }
                catch (Exception)
                {
                    // The change feed is a wake-up; a page reload or the next sweep still sees it.
                }
            }
            var handlers = Released;
            if (handlers != null)
            {
                foreach (Action<ImportReadyRelease> handler in handlers.GetInvocationList())
                {
                    try
                    {
                        handler(release);
                    }
                    catch (Exception)
                    {
                        // One listener never keeps the others from waking.
                    }
                }
            }
            return true;
        }

        /// <summary>Stops gating an import without publishing it (its file never reached Jellyfin; nothing to call Ready).</summary>
        public void Drop(string path, string generation)
        {
            lock (_lock)
            {
                if (!_byPath.TryGetValue(BridgePaths.Norm(path), out var e) || e.Generation != generation) return;
                Forget(e);
            }
            Bump();
        }

        /// <summary>The imports being followed and the latest ones published, newest first (System tab, tests).</summary>
        public IReadOnlyList<ImportReadinessEntry> Entries()
        {
            lock (_lock)
            {
                var now = _now();
                return _byPath.Values.OrderByDescending(e => e.Began).Select(e => Snapshot(e, e.State, null, e.Reason ?? (Holds(e, now) ? null : "expired"))).Concat(_done).ToList();
            }
        }

        private bool Holds(Entry e, DateTimeOffset now) => now - e.Began < MaxHold;

        private static ImportReadinessEntry Snapshot(Entry e, string state, DateTimeOffset? readyAt, string? reason)
            => new() { Path = e.Path, Generation = e.Generation, Key = e.Key, Began = e.Began, State = state, ItemIds = e.Items.ToList(), ReadyAt = readyAt, Reason = reason };

        // Under the lock.
        private void Forget(Entry e)
        {
            _byPath.Remove(e.Path);
            foreach (var id in e.Items)
            {
                if (_byItem.TryGetValue(id, out var held) && ReferenceEquals(held, e)) _byItem.Remove(id);
            }
        }

        // Under the lock: entries past their hold go first.
        private void Prune()
        {
            var now = _now();
            foreach (var e in _byPath.Values.Where(e => !Holds(e, now)).ToList()) Forget(e);
        }

        private void Bump()
        {
            System.Threading.Interlocked.Increment(ref _revision);
            try
            {
                Changed?.Invoke();
            }
            catch (Exception)
            {
                // A listener's failure never stops the gate.
            }
        }

        private sealed class Entry
        {
            public Entry(string path, string generation, string? key, DateTimeOffset began)
            {
                Path = path;
                Generation = generation;
                Key = key;
                Began = began;
            }

            public string Path { get; }

            public string Generation { get; }

            public string? Key { get; }

            public DateTimeOffset Began { get; }

            public List<Guid> Items { get; } = new();

            public string State { get; set; } = ImportReadinessState.Indexing;

            public string? Reason { get; set; }
        }
    }
}
