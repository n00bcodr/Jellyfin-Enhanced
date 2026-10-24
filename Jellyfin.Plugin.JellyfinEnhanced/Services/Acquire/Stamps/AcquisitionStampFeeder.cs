using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps
{
    /// <summary>
    /// Writes the stamp facts from confirmed library and acquisition facts (phase 4e), only while acquisition badges are
    /// on. Never calls an arr or Seerr: it reads Jellyfin, the request ledger, Seerr's requests and follows as the server
    /// already holds them, and the arrs' history snapshots in memory.
    /// <list type="bullet">
    /// <item><description><b>New for you</b>: a movie or episode Jellyfin added is judged about a minute later (its media
    /// info is usually read by then, so the 4K edition is known) and again by a catch-up of everything added within the New
    /// lifetime (at start, when badges are switched on, every ten minutes). A person gets the fact when their own
    /// request or follow came before the arrival, covers the part and edition, the item is that part's first arrival
    /// (no earlier copy now, none recorded before) and they can open it. Each source is judged once, and only once
    /// Jellyfin has read its dimensions: until then it is neither edition. Each round retries an unread source for ten
    /// minutes; after that ItemUpdated (the probe) and the catch-up look again. ItemUpdated also queues newly added
    /// versions.</description></item>
    /// <item><description><b>Upgraded</b>: an arr import whose old file the arr deleted for "Upgrade", recorded once
    /// Jellyfin has an item at the imported path. A webhook or a replayed event only makes the history fresher; it can't
    /// create a fact.</description></item>
    /// <item><description>A removed movie or episode records its arrival, so a renamed replacement (a new item id) is
    /// never mistaken for a first arrival.</description></item>
    /// </list>
    /// </summary>
    public sealed class AcquisitionStampFeeder : IHostedService, IDisposable
    {
        private static readonly TimeSpan Settle = TimeSpan.FromSeconds(60);
        private static readonly TimeSpan ProbeWait = TimeSpan.FromMinutes(10);
        private static readonly TimeSpan CatchUpEvery = TimeSpan.FromMinutes(10);
        private static readonly TimeSpan PurgeEvery = TimeSpan.FromHours(6);
        private static readonly TimeSpan Tick = TimeSpan.FromSeconds(15);
        private static readonly TimeSpan UpgradeLookWindow = TimeSpan.FromDays(1);

        private readonly IStampLibrary _library;
        private readonly IStampInterests _interests;
        private readonly IStampUpgrades _upgrades;
        private readonly AcquisitionStampStore _store;
        private readonly AcquisitionStampResolver _resolver;
        private readonly Logger? _logger;
        private readonly Func<PluginConfiguration?> _config;
        private readonly Func<DateTimeOffset> _now;
        private ConcurrentDictionary<Guid, DateTime> _pending = new();
        private ConcurrentDictionary<Guid, (StampItem Item, long Generation)> _removed = new();
        private HashSet<string> _upgradesDone = new(StringComparer.Ordinal);
        private readonly object _upgradesGate = new();
        private readonly SemaphoreSlim _round = new(1, 1);
        private CancellationTokenSource? _loop;
        private Task? _loopTask;
        private bool _wasOn;
        private DateTime _nextCatchUp;
        private DateTime _nextPurge;
        private long _generation = -1;

        /// <summary>Creates the feeder (DI).</summary>
        /// <param name="library">Library facts.</param>
        /// <param name="interests">Interests.</param>
        /// <param name="upgrades">Upgrade imports.</param>
        /// <param name="store">Stamp store.</param>
        /// <param name="resolver">Resolver (its 4K index is rebuilt here).</param>
        /// <param name="logger">JE logger.</param>
        public AcquisitionStampFeeder(IStampLibrary library, IStampInterests interests, IStampUpgrades upgrades, AcquisitionStampStore store, AcquisitionStampResolver resolver, Logger logger)
            : this(library, interests, upgrades, store, resolver, logger, () => JellyfinEnhanced.Instance?.Configuration, () => DateTimeOffset.UtcNow)
        {
        }

        /// <summary>Creates the feeder with a configuration source and a clock (tests).</summary>
        internal AcquisitionStampFeeder(IStampLibrary library, IStampInterests interests, IStampUpgrades upgrades, AcquisitionStampStore store, AcquisitionStampResolver resolver, Logger? logger, Func<PluginConfiguration?> config, Func<DateTimeOffset> now)
        {
            _library = library;
            _interests = interests;
            _upgrades = upgrades;
            _store = store;
            _resolver = resolver;
            _logger = logger;
            _config = config;
            _now = now;
            _library.Added += OnAdded;
            _library.Updated += OnAdded;
            _library.Removed += OnRemoved;
        }

        private bool On => AcquisitionStampFlags.Badges(_config()) && _store.Available;

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            _loop = new CancellationTokenSource();
            var token = _loop.Token;
            _loopTask = Task.Run(() => LoopAsync(token), CancellationToken.None);
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public async Task StopAsync(CancellationToken cancellationToken)
        {
            try
            {
                _loop?.Cancel();
            }
            catch (ObjectDisposedException)
            {
            }

            if (_loopTask is not { } task) return;
            try
            {
                await task.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
        }

        /// <inheritdoc />
        public void Dispose()
        {
            _library.Added -= OnAdded;
            _library.Updated -= OnAdded;
            _library.Removed -= OnRemoved;
            var loop = Interlocked.Exchange(ref _loop, null);
            if (loop == null) return;
            try
            {
                loop.Cancel();
            }
            catch (ObjectDisposedException)
            {
            }

            loop.Dispose();
        }

        /// <summary>
        /// One round: due arrivals, upgrade imports, the 4K index, the catch-up and housekeeping (tests call it directly).
        /// </summary>
        /// <param name="cancellationToken">Stops between items.</param>
        /// <returns>A task.</returns>
        internal Task TickAsync(CancellationToken cancellationToken)
            => SeerrFacts.BackgroundAsync(token => TickAsyncFactsCore(token), cancellationToken);

        private async Task TickAsyncFactsCore(CancellationToken cancellationToken)
        {
            using var __factsOperation0 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            await _round.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                if (!On)
                {
                    _wasOn = false;
                    _pendingFacts.Clear();
                    // A removal already delegated by the live tracker still invalidates ordinary status when badges turn off.
                    using var removals = _store.BatchNotifications();
                    foreach (var (id, removed) in _removedFacts.ToArray())
                    {
                        if (_removedFacts.TryRemove(id, out _)) _store.RemoveItem(removed.Item, removed.Generation);
                    }
                    removals.Complete();
                    return;
                }

                using var notifications = _store.BatchNotifications();
                var now = _now().UtcDateTime;
                if (_generation != _store.Generation)
                {
                    _generation = _store.Generation;
                    lock (_upgradesGate) _upgradesDoneFacts.Clear();
                    _nextCatchUp = now;
                }
                if (!_wasOn)
                {
                    // Start, or the switch was turned on: everything that arrived within the lifetime gets its look.
                    var generation = _store.Generation;
                    var baseline = _library.AddedSince(DateTime.MinValue);
                    _store.ObserveSources(baseline, arrived: null, generation: generation);
                    _wasOn = true;
                    _nextCatchUp = now;
                    _resolver.RefreshFourK(force: true);
                }

                foreach (var (id, removed) in _removedFacts.ToArray())
                {
                    if (!_removedFacts.TryRemove(id, out _)) continue;
                    _store.RemoveItem(removed.Item, generation: removed.Generation);
                }
                Upgrades(now);
                foreach (var (id, queued) in _pendingFacts.ToArray())
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (now - queued < Settle) continue;
                    // The wait only stops retrying an unread source every round; it never decides its edition.
                    if (Judge(id, now) != Outcome.Later || now - queued > ProbeWait) _pendingFacts.TryRemove(id, out _);
                }

                if (now >= _nextCatchUp)
                {
                    _nextCatchUp = now + CatchUpEvery;
                    var newFor = AcquisitionStampFlags.NewLifetime(_config());
                    var upgradedFor = AcquisitionStampFlags.UpgradedLifetime(_config());
                    var cutoff = now - (newFor > upgradedFor ? newFor : upgradedFor);
                    var candidates = _library.AddedSince(cutoff).Select(item => item.Id)
                        .Concat(_store.RecentSourceItems(cutoff)).Distinct();
                    foreach (var id in candidates)
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        if (_pendingFacts.ContainsKey(id) || _library.Item(id) is not { } item
                            || item.SourceItems().All(source => _store.Seen(id, source.SourceId))) continue;
                        if (Judge(id, now) == Outcome.Later) _pendingFacts.TryAdd(id, now);
                    }
                }

                // Judging can discover late media info. Publish index and fact changes together, after both settle.
                _resolver.RefreshFourK();
                _store.Publish(_resolver.TakeFourKChanges());
                _store.InvalidateExpired(now, AcquisitionStampFlags.NewLifetime(_config()), AcquisitionStampFlags.UpgradedLifetime(_config()));
                if (now >= _nextPurge)
                {
                    _nextPurge = now + PurgeEvery;
                    var removed = _store.Purge();
                    if (removed > 0) _logger?.Info($"Acquisition badges: housekeeping removed {removed} old rows.");
                }
                notifications.Complete();
            }
            finally
            {
                _round.Release();
            }
        }

        /// <summary>What judging an arrival did.</summary>
        internal enum Outcome
        {
            /// <summary>Judged (with or without facts).</summary>
            Done,

            /// <summary>Not judged yet (media info not read): look again later.</summary>
            Later,

            /// <summary>Nothing to judge (gone, virtual, not a movie or episode).</summary>
            Skipped,

            /// <summary>
            /// A source still has unknown dimensions after the probe wait: not judged (never as standard); the probe's
            /// ItemUpdated or the catch-up looks again, not every round.
            /// </summary>
            Unprobed,
        }

        /// <summary>Judges one arrival (tests call it directly).</summary>
        /// <param name="itemId">Movie or episode.</param>
        /// <param name="now">Now (UTC).</param>
        /// <returns>The outcome.</returns>
        internal Outcome Judge(Guid itemId, DateTime now)
            => SeerrFacts.Process(() => JudgeFactsCore(itemId, now));

        private Outcome JudgeFactsCore(Guid itemId, DateTime now)
        {
            var generation = _store.Generation;
            if (_library.Item(itemId) is not { IsVideo: true, Virtual: false } item || item.Keys.Count == 0) return Outcome.Skipped;
            bool later = false, unprobed = false;
            foreach (var source in item.SourceItems().Select(Arrival).OrderBy(s => s.DateCreated))
            {
                if (source.SourceId != null && _store.Seen(itemId, source.SourceId)) continue;
                // Unknown source arrival is not evidence of a new import. A later update can supply it.
                if (source.DateCreated == DateTime.MinValue) continue;
                // Jellyfin announces a file before it reads it: with unknown dimensions the edition is unknown, never
                // standard (a first 4K file would become an upgrade of a standard copy that never existed). However long
                // the probe takes, the source waits unjudged and unseen.
                if (!source.EditionKnown)
                {
                    if (now - source.DateCreated < ProbeWait) later = true;
                    else unprobed = true;
                    continue;
                }

                JudgeSource(source, item, now, generation);
            }

            return later || generation != _store.Generation ? Outcome.Later : unprobed ? Outcome.Unprobed : Outcome.Done;
        }

        private void JudgeSource(StampItem item, StampItem owner, DateTime now, long generation)
        {
            if (item.FourK) _resolver.NoteFourKCopy();
            var parts = AcquisitionStampStore.PartKeys(item);
            var recorded = _store.EditionArrival(parts);
            var recordedAny = _store.FirstContentArrival(parts);
            DateTime? earlierAny = recordedAny < item.DateCreated ? recordedAny : null;
            DateTime? earlierSame = recorded < item.DateCreated ? recorded : null;
            // Alternate sources of this item and separate accessible copies use the same first-arrival rule.
            var copies = owner.SourceItems().Where(s => s.SourceId != item.SourceId)
                .Concat(_library.OtherCopies(owner).SelectMany(c => c.SourceItems())).Select(Arrival);
            foreach (var copy in copies)
            {
                if (copy.Virtual || copy.DateCreated == DateTime.MinValue || copy.DateCreated >= item.DateCreated) continue;
                earlierAny = Min(earlierAny, copy.DateCreated);
            }

            _store.NoteArrival(parts, item.DateCreated, item.Id, generation: generation);
            // D44: the first 4K version alongside existing HD is a household upgrade, even without a deletion.
            if (item.FourK && earlierAny != null && earlierSame == null)
                _store.AddUpgraded(item, item.DateCreated, "source:" + (item.SourceId ?? item.Id.ToString("N")), generation: generation);
            var upgraded = _store.FactsFor(item.Id).Any(f => f.Kind == AcquisitionStampKinds.Upgraded && f.ItemId == item.Id);
            var newFor = AcquisitionStampFlags.NewLifetime(_config());
            if (!upgraded && now - item.DateCreated < newFor)
            {
                foreach (var interest in _interests.For(item.Keys).GroupBy(i => i.UserId))
                {
                    var match = interest.FirstOrDefault(i => Gives(i, item, earlierAny));
                    if (match == null || !_library.CanOpen(match.UserId, item.Id)) continue;
                    _store.AddNew(match.UserId, item, item.DateCreated, match.Source, generation: generation);
                }
            }

            _store.MarkSeen(item.Id, item.SourceId, generation: generation);
        }

        private StampItem Arrival(StampItem item) => item.SourceId is { } source && _store.SourceArrival(source) is DateTime at
            ? item with { DateCreated = at } : item;

        // An interest gives "New for you" for this arrival: made before it, covering its part and edition, and nothing of
        // that content, in any edition, arrived earlier.
        private static bool Gives(StampInterest interest, StampItem item, DateTime? earlier)
            => ContentArrivalHistory.InterestPrecedes(interest.Since, item.DateCreated)
                && (!interest.FourKOnly || item.FourK)
                && interest.Covers(item.Season, item.Episode, item.EpisodeEnd)
                && earlier == null;

        private static IEnumerable<string> AllEditions(IEnumerable<string> parts)
        {
            foreach (var part in parts)
            {
                var cut = part.LastIndexOf('|');
                if (cut < 0) continue;
                yield return part[..cut] + "|std";
                yield return part[..cut] + "|4k";
            }
        }

        private static DateTime? Min(DateTime? a, DateTime b) => a is DateTime x && x <= b ? x : b;

        private void Upgrades(DateTime now)
        {
            using var __factsOperation1 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            var generation = _store.Generation;
            var window = Math.Min(AcquisitionStampFlags.UpgradedLifetime(_config()).TotalDays, AcquisitionStampFlags.MaxDays);
            foreach (var import in _upgrades.Since(now - TimeSpan.FromDays(window)))
            {
                lock (_upgradesGate)
                {
                    if (_upgradesDoneFacts.Contains(import.Source)) continue;
                }

                // Jellyfin doesn't have the new file yet: looked at again next round, for a day.
                if (_library.ItemAtPath(import.Path) is not Guid id || _library.Item(id) is not { IsVideo: true } item)
                {
                    if (now - import.At > UpgradeLookWindow) Done(import.Source);
                    continue;
                }

                if (item.FourK) _resolver.NoteFourKCopy();
                if (_store.AddUpgraded(item, import.At, import.Source, generation: generation))
                {
                    _logger?.Info($"Acquisition badges: {item.Kind} {item.Id:N} was upgraded ({import.Source}).");
                }

                if (generation == _store.Generation) Done(import.Source);
            }
        }

        private void Done(string source)
        {
            using var __factsOperation2 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            lock (_upgradesGate)
            {
                if (_upgradesDoneFacts.Count > 20000) _upgradesDoneFacts.Clear();
                _upgradesDoneFacts.Add(source);
            }
        }

        private async Task LoopAsync(CancellationToken token)
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    await TickAsync(token).ConfigureAwait(false);
                    await Task.Delay(Tick, token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception ex)
                {
                    _logger?.Warning($"Acquisition badges: round failed ({ex.GetType().Name}: {ex.Message}).");
                    try
                    {
                        await Task.Delay(Tick, token).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException)
                    {
                        return;
                    }
                }
            }
        }

        private void OnAdded(StampItem item)
        {
            using var __factsOperation3 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            if (!item.IsVideo || item.Virtual || !On) return;
            var generation = _store.Generation;
            var now = _now().UtcDateTime;
            _store.ObserveSources(new[] { item }, arrived: now, generation: generation);
            _pendingFacts.TryAdd(item.Id, now);
        }

        private void OnRemoved(StampItem item)
        {
            using var __factsOperation4 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            if (!item.IsVideo || item.Virtual || !On) return;
            try
            {
                var generation = _store.Generation;
                foreach (var source in item.SourceItems().Select(Arrival).Where(s => s.DateCreated != DateTime.MinValue))
                {
                    // A file removed before Jellyfin read it: its content arrived, but no edition did.
                    if (source.EditionKnown) _store.NoteArrival(AcquisitionStampStore.PartKeys(source), source.DateCreated, item.Id, generation: generation);
                    else _store.NoteContentArrival(source, source.DateCreated, generation: generation);
                }
                _pendingFacts.TryRemove(item.Id, out _);
                _removedFacts[item.Id] = (item, generation);
            }
            catch (Exception ex)
            {
                _logger?.Debug($"Acquisition badges: could not note a removed item ({ex.Message}).");
            }
        }
        private readonly global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State<ConcurrentDictionary<Guid, DateTime>> _pendingFactsOwner = new();
        private ConcurrentDictionary<Guid, DateTime> _pendingFacts { get => _pendingFactsOwner.Read(ref _pending, () => new()); set => _pendingFactsOwner.Store(ref _pending, value); }
        private readonly global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State<ConcurrentDictionary<Guid, (StampItem Item, long Generation)>> _removedFactsOwner = new();
        private ConcurrentDictionary<Guid, (StampItem Item, long Generation)> _removedFacts { get => _removedFactsOwner.Read(ref _removed, () => new()); set => _removedFactsOwner.Store(ref _removed, value); }
        private readonly global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State<HashSet<string>> _upgradesDoneFactsOwner = new();
        private HashSet<string> _upgradesDoneFacts { get => _upgradesDoneFactsOwner.Read(ref _upgradesDone, () => new(StringComparer.Ordinal)); set => _upgradesDoneFactsOwner.Store(ref _upgradesDone, value); }
    }
}
