using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps
{
    /// <summary>
    /// Decides the one acquisition stamp a viewer sees on an item's poster, from the stamp store's facts, the viewer's
    /// own watch state and the library's 4K copies. Pure in-memory work: no network, no database read once the store's
    /// index is loaded, so it can run while a metadata response is stamped (token mint) and while an image is validated.
    /// <list type="bullet">
    /// <item><description><b>Upgraded</b>: a confirmed replacement of this movie/episode (or of an episode in this
    /// season/series) the viewer can open, within the Upgraded lifetime, not played by them since it was upgraded.</description></item>
    /// <item><description><b>New for you</b>: the viewer's own first arrival, within the New lifetime, that they can open
    /// and haven't played (no played mark, no playback since it arrived).</description></item>
    /// <item><description><b>4K</b>: the viewer can open a 4K copy of this movie or series, or of this season or episode
    /// (<see cref="AcquisitionCopyPolicy"/>).</description></item>
    /// </list>
    /// Priority Upgraded &gt; New for you &gt; 4K. Expired facts resolve to <see cref="AcquisitionStamp.None"/> at the moment
    /// they're asked about: nothing has to tick for a stamp to end.
    /// </summary>
    public sealed class AcquisitionStampResolver : IDisposable
    {
        private const int MaxMemo = 20000;
        private static readonly TimeSpan AccessTtl = TimeSpan.FromSeconds(30);
        private static readonly TimeSpan FourKRebuildEvery = TimeSpan.FromMinutes(30);

        private readonly IStampLibrary _library;
        private readonly AcquisitionStampStore _store;
        private readonly Func<PluginConfiguration?> _config;
        private readonly Func<DateTimeOffset> _now;
        private readonly Logger? _logger;
        private readonly ConcurrentDictionary<(Guid User, Guid Item), (bool Open, DateTime At)> _access = new();
        private readonly object _fourKGate = new();
        private volatile FourKIndex? _fourK;
        private readonly HashSet<string> _fourKChanges = new(StringComparer.Ordinal);
        private DateTime _fourKBuiltAt;
        private volatile bool _fourKDirty;
        private long _warnedAt;

        /// <summary>Creates the resolver (DI).</summary>
        /// <param name="library">Library facts.</param>
        /// <param name="store">Stamp facts.</param>
        /// <param name="logger">JE logger.</param>
        public AcquisitionStampResolver(IStampLibrary library, AcquisitionStampStore store, Logger logger)
            : this(library, store, () => JellyfinEnhanced.Instance?.Configuration, () => DateTimeOffset.UtcNow, logger)
        {
        }

        /// <summary>Creates the resolver with a configuration source and a clock (tests).</summary>
        /// <param name="library">Library facts.</param>
        /// <param name="store">Stamp facts.</param>
        /// <param name="config">Configuration source.</param>
        /// <param name="now">Clock.</param>
        /// <param name="logger">JE logger.</param>
        internal AcquisitionStampResolver(IStampLibrary library, AcquisitionStampStore store, Func<PluginConfiguration?> config, Func<DateTimeOffset> now, Logger? logger = null)
        {
            _library = library;
            _store = store;
            _config = config;
            _now = now;
            _logger = logger;
            _library.Added += OnChanged;
            _library.Updated += OnChanged;
            _library.Removed += OnChanged;
        }

        /// <summary>The 4K copies, by title key, by "key|season" and by "key|season|episode".</summary>
        private sealed class FourKIndex
        {
            public Dictionary<string, List<Guid>> ByKey { get; } = new(StringComparer.Ordinal);

            public void Add(string key, Guid id)
            {
                if (!ByKey.TryGetValue(key, out var list)) ByKey[key] = list = new List<Guid>();
                if (!list.Contains(id)) list.Add(id);
            }
        }

        /// <summary>The stamp <paramref name="userId"/> sees on <paramref name="itemId"/>'s poster now.</summary>
        /// <param name="itemId">A movie, series, season or episode (the poster's image owner).</param>
        /// <param name="userId">The viewer.</param>
        /// <returns>The stamp (None when acquisition badges are off).</returns>
        public AcquisitionStamp Resolve(Guid itemId, Guid userId) => Resolve(itemId, userId, _now().UtcDateTime);

        /// <summary>The stamp <paramref name="userId"/> sees on <paramref name="itemId"/>'s poster at <paramref name="now"/>.</summary>
        /// <param name="itemId">A movie, series, season or episode.</param>
        /// <param name="userId">The viewer.</param>
        /// <param name="now">The time to judge expiry at (UTC).</param>
        /// <returns>The stamp.</returns>
        public AcquisitionStamp Resolve(Guid itemId, Guid userId, DateTime now)
        {
            var config = _config();
            if (!AcquisitionStampFlags.Badges(config) || itemId == Guid.Empty || userId == Guid.Empty) return AcquisitionStamp.None;
            try
            {
                var best = AcquisitionStamp.None;
                var facts = _store.FactsFor(itemId);
                if (facts.Count > 0)
                {
                    var newFor = AcquisitionStampFlags.NewLifetime(config);
                    var upgradedFor = AcquisitionStampFlags.UpgradedLifetime(config);
                    foreach (var fact in facts)
                    {
                        if (fact.Kind == AcquisitionStampKinds.Upgraded)
                        {
                            if (now >= fact.At + upgradedFor || now < fact.At - TimeSpan.FromDays(1)) continue;
                            if (!CanOpen(userId, fact.ItemId)) continue;
                            if (PlayedSince(userId, fact.ItemId, fact.At, playedMarkCounts: false)) continue;
                            return AcquisitionStamp.Upgraded;
                        }

                        if (best == AcquisitionStamp.NewForYou || fact.Kind != AcquisitionStampKinds.New || fact.UserId != userId) continue;
                        if (now >= fact.At + newFor || now < fact.At - TimeSpan.FromDays(1)) continue;
                        if (!CanOpen(userId, fact.ItemId)) continue;
                        if (PlayedSince(userId, fact.ItemId, fact.At, playedMarkCounts: true)) continue;
                        best = AcquisitionStamp.NewForYou;
                    }
                }

                if (best != AcquisitionStamp.None) return best;
                return HasOpenFourKCopy(itemId, userId) ? AcquisitionStamp.FourK : AcquisitionStamp.None;
            }
            catch (Exception ex)
            {
                // Never break a metadata response or an image over a stamp: no stamp.
                var nowTicks = DateTime.UtcNow.Ticks;
                var last = Interlocked.Read(ref _warnedAt);
                if (nowTicks - last > TimeSpan.TicksPerHour && Interlocked.CompareExchange(ref _warnedAt, nowTicks, last) == last)
                {
                    _logger?.Warning($"Acquisition badges: could not decide a stamp ({ex.GetType().Name}: {ex.Message}); showing none.");
                }

                return AcquisitionStamp.None;
            }
        }

        /// <summary>Drops cached access answers and the 4K index (tests, and after big library changes).</summary>
        public void Invalidate()
        {
            _access.Clear();
            RefreshFourK(force: true);
        }

        /// <inheritdoc />
        public void Dispose()
        {
            _library.Added -= OnChanged;
            _library.Updated -= OnChanged;
            _library.Removed -= OnChanged;
        }

        private bool CanOpen(Guid user, Guid item)
        {
            var now = DateTime.UtcNow;
            if (_access.TryGetValue((user, item), out var hit) && now - hit.At < AccessTtl) return hit.Open;
            var open = _library.CanOpen(user, item);
            if (_access.Count >= MaxMemo) _access.Clear();
            _access[(user, item)] = (open, now);
            return open;
        }

        // New: a played mark or any playback since it arrived ends it. Upgraded: only playback after the upgrade (a played
        // mark carried over from the old file doesn't).
        private bool PlayedSince(Guid user, Guid item, DateTime at, bool playedMarkCounts)
        {
            if (_library.UserData(user, item) is not { } data) return false;
            if (playedMarkCounts && data.Played) return true;
            return data.LastPlayed is DateTime last && last >= at;
        }

        private bool HasOpenFourKCopy(Guid itemId, Guid userId)
        {
            var index = FourK();
            if (index.ByKey.Count == 0) return false;
            if (_library.Item(itemId) is not { } item) return false;
            foreach (var key in IndexKeys(item))
            {
                if (!index.ByKey.TryGetValue(key, out var copies)) continue;
                foreach (var copy in copies)
                {
                    if (CanOpen(userId, copy)) return true;
                }
            }

            return false;
        }

        // The keys a card looks a 4K copy up by (the same shape the index is built with).
        private static IEnumerable<string> IndexKeys(StampItem item)
        {
            foreach (var key in item.Keys)
            {
                var k = key.Title.ToString();
                switch (item.Kind)
                {
                    case "movie":
                    case "series":
                        yield return k;
                        break;
                    case "season" when item.Season is int s:
                        yield return k + "|" + s.ToString(CultureInfo.InvariantCulture);
                        break;
                    case "episode" when item.Season is int s && item.Episode is int e:
                        var last = item.EpisodeEnd is int end && end >= e ? end : e;
                        for (var n = e; n <= last && n < e + 50; n++)
                        {
                            yield return k + "|" + s.ToString(CultureInfo.InvariantCulture) + "|" + n.ToString(CultureInfo.InvariantCulture);
                        }

                        break;
                }
            }
        }

        // The current index; built here only the first time (before the background loop ran). Library changes only mark
        // it dirty: RefreshFourK (the feeder's loop) rebuilds it, never a metadata response or an image request.
        private FourKIndex FourK()
        {
            var index = _fourK;
            if (index != null) return index;
            lock (_fourKGate)
            {
                return _fourK ??= Build();
            }
        }

        /// <summary>
        /// Rebuilds the 4K copy index when the library changed since it was built, or it is older than half an hour
        /// (background work; the index read while stamping is never rebuilt there).
        /// </summary>
        /// <param name="force">Rebuild whatever its state.</param>
        public void RefreshFourK(bool force = false)
        {
            if (!force && _fourK != null && !_fourKDirty && DateTime.UtcNow - _fourKBuiltAt < FourKRebuildEvery) return;
            lock (_fourKGate)
            {
                _fourKDirty = false;
                var previous = _fourK;
                FourKIndex next;
                try
                {
                    next = Build();
                }
                catch
                {
                    _fourKDirty = true; // retain the retry when the library read failed
                    throw;
                }
                _fourK = next;
                if (previous != null)
                {
                    foreach (var key in previous.ByKey.Keys.Concat(next.ByKey.Keys).Distinct(StringComparer.Ordinal))
                    {
                        previous.ByKey.TryGetValue(key, out var before);
                        next.ByKey.TryGetValue(key, out var after);
                        if (before != null && after != null && before.Count == after.Count && before.ToHashSet().SetEquals(after)) continue;
                        _fourKChanges.Add(key.Split('|')[0]);
                    }
                }
            }
        }

        /// <summary>Consumes the affected title keys after the feeder has refreshed the index.</summary>
        internal IReadOnlyList<string> TakeFourKChanges()
        {
            lock (_fourKGate)
            {
                var changes = _fourKChanges.ToArray();
                _fourKChanges.Clear();
                return changes;
            }
        }

        private FourKIndex Build()
        {
            var index = new FourKIndex();
            foreach (var video in _library.FourKVideos()) AddToIndex(index, video);
            _fourKBuiltAt = DateTime.UtcNow;
            return index;
        }

        private static void AddToIndex(FourKIndex index, StampItem video)
        {
            if (!video.FourK || video.Virtual) return;
            foreach (var key in video.Keys)
            {
                var k = key.Title.ToString();
                index.Add(k, video.Id);
                if (video.Kind != "episode" || video.Season is not int s) continue;
                index.Add(k + "|" + s.ToString(CultureInfo.InvariantCulture), video.Id);
                if (video.Episode is not int e) continue;
                var last = video.EpisodeEnd is int end && end >= e ? end : e;
                for (var n = e; n <= last && n < e + 50; n++)
                {
                    index.Add(k + "|" + s.ToString(CultureInfo.InvariantCulture) + "|" + n.ToString(CultureInfo.InvariantCulture), video.Id);
                }
            }
        }

        /// <summary>
        /// A 4K copy was seen (the feeder judges arrivals after Jellyfin read their media info, which a library event may
        /// precede): the background loop rebuilds the 4K index.
        /// </summary>
        public void NoteFourKCopy() => _fourKDirty = true;

        // A change can make a copy 4K (its media info arrived) or remove one: the background loop rebuilds the 4K index.
        // Access answers simply expire (30 s).
        private void OnChanged(StampItem item)
        {
            if (item.IsVideo) _fourKDirty = true;
        }
    }
}
