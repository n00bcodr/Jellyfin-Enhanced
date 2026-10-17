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
    /// info is read by then, so the 4K edition is known) and again by a catch-up of everything added within the New
    /// lifetime (at start, when badges are switched on, every ten minutes). A person gets the fact when their own
    /// request or follow came before the arrival, covers the part and edition, the item is that part's first arrival
    /// (no earlier copy now, none recorded before) and they can open it. Each item is judged once.</description></item>
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
        private static readonly TimeSpan Slack = TimeSpan.FromMinutes(1);
        private static readonly TimeSpan UpgradeLookWindow = TimeSpan.FromDays(1);

        private readonly IStampLibrary _library;
        private readonly IStampInterests _interests;
        private readonly IStampUpgrades _upgrades;
        private readonly AcquisitionStampStore _store;
        private readonly AcquisitionStampResolver _resolver;
        private readonly Logger? _logger;
        private readonly Func<PluginConfiguration?> _config;
        private readonly Func<DateTimeOffset> _now;
        private readonly ConcurrentDictionary<Guid, DateTime> _pending = new();
        private readonly HashSet<string> _upgradesDone = new(StringComparer.Ordinal);
        private readonly object _upgradesGate = new();
        private readonly SemaphoreSlim _round = new(1, 1);
        private CancellationTokenSource? _loop;
        private Task? _loopTask;
        private bool _wasOn;
        private DateTime _nextCatchUp;
        private DateTime _nextPurge;

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
        internal async Task TickAsync(CancellationToken cancellationToken)
        {
            await _round.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                if (!On)
                {
                    _wasOn = false;
                    _pending.Clear();
                    return;
                }

                var now = _now().UtcDateTime;
                if (!_wasOn)
                {
                    // Start, or the switch was turned on: everything that arrived within the lifetime gets its look.
                    _wasOn = true;
                    _nextCatchUp = now;
                    _resolver.RefreshFourK(force: true);
                }

                _resolver.RefreshFourK();
                Upgrades(now);
                foreach (var (id, queued) in _pending.ToArray())
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (now - queued < Settle) continue;
                    if (Judge(id, now) != Outcome.Later || now - queued > ProbeWait) _pending.TryRemove(id, out _);
                }

                if (now >= _nextCatchUp)
                {
                    _nextCatchUp = now + CatchUpEvery;
                    var newFor = AcquisitionStampFlags.NewLifetime(_config());
                    foreach (var item in _library.AddedSince(now - newFor))
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        if (_pending.ContainsKey(item.Id) || _store.Seen(item.Id)) continue;
                        if (Judge(item.Id, now) == Outcome.Later) _pending.TryAdd(item.Id, now);
                    }
                }

                if (now >= _nextPurge)
                {
                    _nextPurge = now + PurgeEvery;
                    var removed = _store.Purge();
                    if (removed > 0) _logger?.Info($"Acquisition badges: housekeeping removed {removed} old rows.");
                }
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
        }

        /// <summary>Judges one arrival (tests call it directly).</summary>
        /// <param name="itemId">Movie or episode.</param>
        /// <param name="now">Now (UTC).</param>
        /// <returns>The outcome.</returns>
        internal Outcome Judge(Guid itemId, DateTime now)
        {
            if (_library.Item(itemId) is not { IsVideo: true, Virtual: false } item || item.Keys.Count == 0) return Outcome.Skipped;
            // The edition is decided by the video size, which Jellyfin reads after it added the item.
            if (item.Width == 0 && item.Height == 0 && now - item.DateCreated < ProbeWait) return Outcome.Later;

            // A library event can come before Jellyfin read the video's size: the 4K index learns of this copy now.
            if (item.FourK) _resolver.NoteFourKCopy();
            var parts = AcquisitionStampStore.PartKeys(item);
            var recorded = _store.FirstArrival(parts.Where(p => p.EndsWith("|" + Edition(item), StringComparison.Ordinal)));
            var recordedAny = _store.FirstArrival(AllEditions(parts));
            DateTime? earlierAny = recordedAny < item.DateCreated - Slack ? recordedAny : null;
            DateTime? earlierSame = recorded < item.DateCreated - Slack ? recorded : null;
            foreach (var copy in _library.OtherCopies(item))
            {
                if (copy.Virtual || copy.DateCreated >= item.DateCreated - Slack) continue;
                earlierAny = Min(earlierAny, copy.DateCreated);
                if (copy.FourK == item.FourK) earlierSame = Min(earlierSame, copy.DateCreated);
            }

            _store.NoteArrival(parts, item.DateCreated, item.Id);
            var upgraded = _store.FactsFor(item.Id).Any(f => f.Kind == AcquisitionStampKinds.Upgraded && f.ItemId == item.Id);
            var newFor = AcquisitionStampFlags.NewLifetime(_config());
            if (!upgraded && now - item.DateCreated < newFor)
            {
                foreach (var interest in _interests.For(item.Keys).GroupBy(i => i.UserId))
                {
                    var match = interest.FirstOrDefault(i => Gives(i, item, i.FourKOnly ? earlierSame : earlierAny));
                    if (match == null || !_library.CanOpen(match.UserId, item.Id)) continue;
                    _store.AddNew(match.UserId, item, item.DateCreated, match.Source);
                }
            }

            _store.MarkSeen(item.Id);
            return Outcome.Done;
        }

        // An interest gives "New for you" for this arrival: made before it, covering its part and edition, and nothing of
        // that edition (any edition for a standard interest) arrived earlier.
        private static bool Gives(StampInterest interest, StampItem item, DateTime? earlier)
            => interest.Since < item.DateCreated
                && (!interest.FourKOnly || item.FourK)
                && interest.Covers(item.Season, item.Episode, item.EpisodeEnd)
                && earlier == null;

        private static string Edition(StampItem item) => item.FourK ? "4k" : "std";

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
            var window = Math.Min(AcquisitionStampFlags.UpgradedLifetime(_config()).TotalDays, AcquisitionStampFlags.MaxDays);
            foreach (var import in _upgrades.Since(now - TimeSpan.FromDays(window)))
            {
                lock (_upgradesGate)
                {
                    if (_upgradesDone.Contains(import.Source)) continue;
                }

                // Jellyfin doesn't have the new file yet: looked at again next round, for a day.
                if (_library.ItemAtPath(import.Path) is not Guid id || _library.Item(id) is not { IsVideo: true } item)
                {
                    if (now - import.At > UpgradeLookWindow) Done(import.Source);
                    continue;
                }

                if (item.FourK) _resolver.NoteFourKCopy();
                if (_store.AddUpgraded(item, import.At, import.Source))
                {
                    _logger?.Info($"Acquisition badges: {item.Kind} {item.Id:N} was upgraded ({import.Source}).");
                }

                Done(import.Source);
            }
        }

        private void Done(string source)
        {
            lock (_upgradesGate)
            {
                if (_upgradesDone.Count > 20000) _upgradesDone.Clear();
                _upgradesDone.Add(source);
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
            if (!item.IsVideo || item.Virtual || !On) return;
            _pending.TryAdd(item.Id, _now().UtcDateTime);
        }

        private void OnRemoved(StampItem item)
        {
            if (!item.IsVideo || item.Virtual || !On) return;
            try
            {
                _store.NoteArrival(AcquisitionStampStore.PartKeys(item), item.DateCreated, item.Id);
            }
            catch (Exception ex)
            {
                _logger?.Debug($"Acquisition badges: could not note a removed item ({ex.Message}).");
            }
        }
    }
}
