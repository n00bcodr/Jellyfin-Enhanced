using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>
    /// Keeps every title the ledger holds under one identity (phase 4b, Q-4BFIX3-2): what the arr libraries and Seerr's
    /// requests say about a title's ids (<see cref="TitleAliases"/>, memory only) is handed to the ledger
    /// (<see cref="RequestLedger.Unify"/>), which remembers the aliases and moves and merges what was held apart. Asks and
    /// approvals learn their own title first (<see cref="Learn"/>); this pass covers what is already stored, soon after
    /// start, after an arr library read changes, and every few minutes. Nothing is sent or deleted.
    /// </summary>
    public sealed class RequestTitleIdentity : IHostedService, IDisposable
    {
        /// <summary>How long after start the first pass runs (the arr libraries are read by then).</summary>
        internal static readonly TimeSpan FirstPassAfter = TimeSpan.FromSeconds(45);

        /// <summary>The longest wait between passes.</summary>
        internal static readonly TimeSpan PassEvery = TimeSpan.FromMinutes(10);

        private readonly RequestLedger _ledger;
        private readonly IRequestPolicy _policy;
        private readonly TitleAliases _aliases;
        private readonly ArrChangeFeed? _feed;
        private readonly ArrStateStore? _store;
        private readonly Logger? _logger;
        private readonly Func<DateTimeOffset> _now;
        private readonly SemaphoreSlim _soon = new(0, 1);
        private CancellationTokenSource? _loop;
        private Task? _loopTask;

        /// <summary>Creates the pass (DI).</summary>
        public RequestTitleIdentity(RequestLedger ledger, IRequestPolicy policy, TitleAliases aliases, ArrChangeFeed feed, ArrStateStore store, Logger logger)
            : this(ledger, policy, aliases, feed, logger, () => DateTimeOffset.UtcNow, store)
        {
        }

        /// <summary>Creates the pass with an explicit clock (tests).</summary>
        internal RequestTitleIdentity(RequestLedger ledger, IRequestPolicy policy, TitleAliases aliases, ArrChangeFeed? feed, Logger? logger, Func<DateTimeOffset> now, ArrStateStore? store = null)
        {
            _ledger = ledger;
            _policy = policy;
            _aliases = aliases;
            _feed = feed;
            _logger = logger;
            _now = now;
            _store = store;
        }

        private bool Enabled => _policy.Configuration is { ArrIntegrationEnabled: true, ArrPhase1Enabled: true, ArrPhase3Enabled: true } && _ledger.Database.Available;

        /// <summary>The keys one title is known by now: its own and every alias the arr libraries and Seerr's requests give.</summary>
        /// <param name="aliases">The alias resolver.</param>
        /// <param name="key">A title key.</param>
        internal static IReadOnlyList<string> Keys(TitleAliases aliases, TitleKey key)
            => aliases.Of(key.Title).Prepend(key.Title).Select(k => k.ToString()).Distinct(StringComparer.Ordinal).ToList();

        /// <summary>
        /// Hands one title's ids to the ledger, which then holds it under one key (null: nothing changed). Lists showing the
        /// title, and the people whose requests moved, are told. Never fails the caller: a title not learned now is learned
        /// by the next pass.
        /// </summary>
        /// <param name="ledger">The ledger.</param>
        /// <param name="policy">Current policy.</param>
        /// <param name="aliases">The alias resolver (null: nothing to learn).</param>
        /// <param name="feed">The change feed, if any.</param>
        /// <param name="key">A title key (any of its ids).</param>
        /// <param name="now">Now.</param>
        /// <param name="logger">Where a failure is noted, if anywhere.</param>
        internal static TitleMerge? Learn(RequestLedger ledger, IRequestPolicy policy, TitleAliases? aliases, ArrChangeFeed? feed, string key, DateTimeOffset now, Logger? logger = null)
        {
            if (aliases == null || TitleKey.Parse(key) is not { } parsed || !ledger.Database.Available) return null;
            try
            {
                var keys = Keys(aliases, parsed);
                if (keys.Count < 2 || ledger.Unify(keys, policy, now) is not { } merge) return null;
                feed?.Bump(merge.Keys.Concat(merge.People.Select(ArrTitleKey.UserRequests)).Append(ArrTitleKey.RequestsState).ToArray());
                return merge;
            }
            catch (Exception ex) when (ex is Microsoft.Data.Sqlite.SqliteException or InvalidOperationException or TimeoutException)
            {
                logger?.Warning($"Requests: could not record that {key} has other ids ({ex.GetType().Name}); the next pass tries again.");
                return null;
            }
        }

        /// <summary>One pass over every title the ledger holds; returns how many were merged or moved.</summary>
        internal int Reconcile()
        {
            if (!Enabled) return 0;
            var changed = 0;
            foreach (var key in _ledger.TitleKeys())
            {
                if (Learn(_ledger, _policy, _aliases, _feed, key, _now(), _logger) is not { } merge) continue;
                changed++;
                // Only a title whose requests moved is worth a line (most passes only remember an alias).
                if (merge.People.Count > 0) _logger?.Info($"Requests: {string.Join(", ", merge.Keys.Skip(1))} are {merge.Canonical} too; its requests are held as one title ({merge.Acquisitions} merged, {merge.Followers} now follow another request of it).");
            }
            return changed;
        }

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            if (_store != null) _store.SnapshotChanged += OnSnapshotChanged;
            _loop = new CancellationTokenSource();
            var token = _loop.Token;
            _loopTask = Task.Run(() => LoopAsync(token), CancellationToken.None);
            return Task.CompletedTask;
        }

        // An arr library read changed what is known about titles' ids: a pass soon (one is pending at most).
        private void OnSnapshotChanged(ArrSnapshotChange change)
        {
            if (change.Kind != ArrSnapshotKind.Library) return;
            try
            {
                _soon.Release();
            }
            catch (SemaphoreFullException)
            {
                // A pass is already pending.
            }
        }

        private async Task LoopAsync(CancellationToken ct)
        {
            var wait = FirstPassAfter;
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    await Task.Delay(wait, ct).ConfigureAwait(false);
                    Reconcile();
                    wait = TimeSpan.FromSeconds(30);
                    await _soon.WaitAsync(PassEvery, ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception ex)
                {
                    _logger?.Warning($"Requests: holding titles under one identity failed ({ex.GetType().Name}).");
                    wait = PassEvery;
                }
            }
        }

        /// <inheritdoc />
        public async Task StopAsync(CancellationToken cancellationToken)
        {
            if (_store != null) _store.SnapshotChanged -= OnSnapshotChanged;
            var loop = Interlocked.Exchange(ref _loop, null);
            if (loop == null) return;
            await loop.CancelAsync().ConfigureAwait(false);
            try
            {
                if (_loopTask != null) await _loopTask.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Stopping.
            }
            finally
            {
                loop.Dispose();
            }
        }

        /// <inheritdoc />
        public void Dispose()
        {
            _loop?.Dispose();
            _soon.Dispose();
        }
    }
}
