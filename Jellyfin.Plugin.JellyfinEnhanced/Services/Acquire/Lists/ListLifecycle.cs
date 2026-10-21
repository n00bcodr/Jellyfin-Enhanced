using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>
    /// List lifecycle (A8): deleting a playlist/collection in Jellyfin deletes its placeholder document, and a
    /// startup + daily sweep removes documents whose list no longer exists. A list must be missing on two checks a
    /// minute apart before its document is removed, so a transient lookup failure never destroys user data.
    /// Always active (cheap; does nothing when no documents exist), independent of the feature switch.
    /// </summary>
    public sealed class ListLifecycle : IHostedService, IDisposable
    {
        /// <summary>Delay before the first sweep after startup.</summary>
        public static readonly TimeSpan StartupDelay = TimeSpan.FromMinutes(2);

        /// <summary>Spacing of later sweeps.</summary>
        public static readonly TimeSpan SweepInterval = TimeSpan.FromHours(24);

        /// <summary>How long a missing list must stay missing before its document is removed.</summary>
        public static readonly TimeSpan ConfirmDelay = TimeSpan.FromMinutes(1);

        private readonly ILibraryManager _libraryManager;
        private readonly ListStore _store;
        private readonly IListHost _host;
        private readonly Logger _logger;
        private readonly ListLinks? _links;
        private readonly ListOperations? _operations;
        private readonly ListEventStore? _events;
        private readonly ListSwapService? _swap;
        private CancellationTokenSource? _stopping;
        private Task? _sweeper;

        /// <summary>Creates the service.</summary>
        /// <param name="libraryManager">Library manager (ItemRemoved).</param>
        /// <param name="store">Placeholder store.</param>
        /// <param name="host">Jellyfin seam.</param>
        /// <param name="logger">JE logger.</param>
        /// <param name="links">List request links (removed with their list).</param>
        /// <param name="operations">Durable list operations (creates retain their identity after list deletion).</param>
        /// <param name="events">Swap-in events (removed with their list).</param>
        /// <param name="swap">Swap service (reconciliation after a restore).</param>
        public ListLifecycle(ILibraryManager libraryManager, ListStore store, IListHost host, Logger logger, ListLinks? links = null, ListOperations? operations = null, ListEventStore? events = null, ListSwapService? swap = null)
        {
            _libraryManager = libraryManager;
            _store = store;
            _host = host;
            _logger = logger;
            _links = links;
            _operations = operations;
            _events = events;
            _swap = swap;
        }

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            _libraryManager.ItemRemoved += OnItemRemoved;
            Backup.JeBackupService.DataRestored += OnRestored;
            _stopping = new CancellationTokenSource();
            var token = _stopping.Token;
            _sweeper = Task.Run(() => SweepLoopAsync(token), CancellationToken.None);
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public async Task StopAsync(CancellationToken cancellationToken)
        {
            _libraryManager.ItemRemoved -= OnItemRemoved;
            Backup.JeBackupService.DataRestored -= OnRestored;
            _stopping?.Cancel();
            if (_sweeper != null)
            {
                try
                {
                    await _sweeper.WaitAsync(cancellationToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    // shutting down
                }
            }
        }

        /// <inheritdoc />
        public void Dispose()
        {
            // Idempotent: the service is both a singleton (maintenance task) and a hosted service, so the container
            // may dispose it more than once.
            _libraryManager.ItemRemoved -= OnItemRemoved;
            Backup.JeBackupService.DataRestored -= OnRestored;
            var stopping = Interlocked.Exchange(ref _stopping, null);
            stopping?.Cancel();
            stopping?.Dispose();
        }

        /// <summary>Deletes the document of a removed list (off the scan thread).</summary>
        /// <param name="listId">The removed item's id.</param>
        /// <param name="marker">The removed item's create marker, when it had one.</param>
        /// <returns>True when a document was deleted.</returns>
        internal async Task<bool> DeleteForRemovedListAsync(Guid listId, Guid? marker = null)
        {
            // A deletion is never part of a create or swap that happened to see it.
            using var independent = ListContinuation.Detach();
            var listIdN = listId.ToString("N", CultureInfo.InvariantCulture);
            MarkRemoved(listIdN, marker);
            using (await _store.LockAsync(listIdN).ConfigureAwait(false))
            {
                var deleted = _store.Delete(listIdN);
                if (deleted)
                {
                    _logger.Info($"[Lists] List {listIdN} was deleted; removed its entries.");
                }

                ForgetListRows(listIdN);
                return deleted;
            }
        }

        /// <summary>
        /// Removes documents whose list no longer exists, and imported collage markers left behind by such a list (from
        /// before markers went with their list's document): candidates are re-checked after <paramref name="confirmDelay"/>.
        /// </summary>
        /// <param name="confirmDelay">Delay between the two checks.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>Number of removed documents.</returns>
        internal async Task<int> CollectOrphansAsync(TimeSpan confirmDelay, CancellationToken cancellationToken)
        {
            var candidates = _store.EnumerateListIds().Concat(_store.EnumerateCollageMarkerIds()).Distinct(StringComparer.Ordinal).Where(IsMissing).ToList();
            if (candidates.Count == 0)
            {
                return 0;
            }

            await Task.Delay(confirmDelay, cancellationToken).ConfigureAwait(false);
            var removed = 0;
            var markersBefore = _store.EnumerateCollageMarkerIds().Count;
            foreach (var listIdN in candidates.Where(IsMissing))
            {
                using (await _store.LockAsync(listIdN, cancellationToken).ConfigureAwait(false))
                {
                    if (IsMissing(listIdN) && _store.Delete(listIdN))
                    {
                        MarkRemoved(listIdN, null);
                        removed++;
                        ForgetListRows(listIdN);
                    }
                }
            }

            if (removed > 0)
            {
                _logger.Info($"[Lists] Removed placeholders of {removed} deleted list(s).");
            }

            var markers = markersBefore - _store.EnumerateCollageMarkerIds().Count;
            if (markers > 0)
            {
                _logger.Info($"[Lists] Removed {markers} imported collage marker(s) of deleted lists.");
            }

            return removed;
        }

        /// <summary>
        /// After a restore: every list document is read from disk again and marked for reconciliation (pending swap intents
        /// are settled against Jellyfin's real membership before anything new is inserted), and request links whose
        /// request no longer exists are dropped. Nothing is inserted or requested by the restore itself.
        /// </summary>
        /// <returns>Lists marked.</returns>
        internal async Task<int> ReconcileAfterRestoreAsync()
        {
            using var independent = ListContinuation.Detach();
            _store.InvalidateAll();
            var marked = 0;
            foreach (var listIdN in _store.EnumerateListIds())
            {
                try
                {
                    using (await _store.LockAsync(listIdN).ConfigureAwait(false))
                    {
                        var current = _store.Load(listIdN);
                        if (current == null || current.Reconcile != null)
                        {
                            continue;
                        }

                        var doc = ListStore.Clone(current);
                        doc.Reconcile = "restore";
                        _store.Save(doc);
                        marked++;
                    }
                }
                catch (Exception ex) when (ex is System.IO.InvalidDataException or System.IO.IOException or UnauthorizedAccessException)
                {
                    _logger.Warning($"[Lists] List {listIdN} could not be marked for reconciliation after a restore: {ex.Message}");
                }
            }

            try
            {
                var dropped = _links?.PruneOrphans() ?? 0;
                if (dropped > 0)
                {
                    _logger.Info($"[Lists] Restore: dropped {dropped} list request link(s) whose request is gone.");
                }
            }
            catch (Exception ex)
            {
                _logger.Debug($"[Lists] Pruning list request links after a restore failed: {ex.Message}");
            }

            _swap?.QueueAll(MetadataMode.None);
            _logger.Info($"[Lists] Restore: {marked} list(s) wait for reconciliation.");
            return marked;
        }

        private void OnRestored()
        {
            _ = Task.Run(async () =>
            {
                try
                {
                    await ReconcileAfterRestoreAsync().ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    _logger.Warning($"[Lists] Reconciliation after a restore failed: {ex.Message}");
                }
            });
        }

        // A deletion is marked at once, before the list's document lock is waited for (a create may hold it while Jellyfin
        // works): under the lifecycle lock, so no create or swap continuation writes or answers for the list after it.
        private void MarkRemoved(string listIdN, Guid? marker)
        {
            lock (ListContinuation.Lifecycle)
            {
                _store.Removed(listIdN);
                _operations?.DeleteCreate(listIdN, marker, DateTimeOffset.UtcNow);
            }
        }

        // Database rows of a removed list: its request links (the requests stay), operations and pending events.
        private void ForgetListRows(string listIdN)
        {
            try
            {
                _links?.Prune(listIdN, null);
                _operations?.Purge(DateTimeOffset.UtcNow, new[] { listIdN });
                _events?.Purge(DateTimeOffset.UtcNow, new[] { listIdN });
            }
            catch (Exception ex)
            {
                _logger.Debug($"[Lists] Removing the rows of deleted list {listIdN} failed: {ex.Message}");
            }
        }

        private bool IsMissing(string listIdN)
        {
            try
            {
                return _host.GetList(Guid.ParseExact(listIdN, "N")) == null;
            }
            catch (Exception ex)
            {
                _logger.Debug($"[Lists] List lookup failed during cleanup: {ex.Message}");
                return false; // unknown is not missing
            }
        }

        private void OnItemRemoved(object? sender, ItemChangeEventArgs e)
        {
            // Fires on the library thread: capture the id and leave.
            if (e?.Item is not (Playlist or BoxSet))
            {
                return;
            }

            using var independent = ListContinuation.Detach();
            var id = e.Item.Id;
            // The removed item still carries its create marker (folder name or provider id), also when no operation
            // recorded its id: marked before Jellyfin can re-add a folder under the same id.
            var marker = JellyfinListHost.CreateMarkerOf(e.Item);
            try
            {
                MarkRemoved(id.ToString("N", CultureInfo.InvariantCulture), marker);
            }
            catch (Exception ex)
            {
                _logger.Warning($"[Lists] Marking a deleted list failed (its cleanup tries again): {ex.Message}");
            }

            _ = Task.Run(async () =>
            {
                try
                {
                    await DeleteForRemovedListAsync(id, marker).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    _logger.Warning($"[Lists] Cleanup after list deletion failed: {ex.Message}");
                }
            });
        }

        private async Task SweepLoopAsync(CancellationToken cancellationToken)
        {
            try
            {
                await Task.Delay(StartupDelay, cancellationToken).ConfigureAwait(false);
                while (!cancellationToken.IsCancellationRequested)
                {
                    try
                    {
                        await CollectOrphansAsync(ConfirmDelay, cancellationToken).ConfigureAwait(false);
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        _logger.Warning($"[Lists] Orphan sweep failed: {ex.Message}");
                    }

                    await Task.Delay(SweepInterval, cancellationToken).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException)
            {
                // stopping
            }
        }
    }

    /// <summary>
    /// Removes what lists keep about a deleted Jellyfin user (their request links and list operations). Their requests,
    /// the lists they own (Jellyfin's own business) and entries they added stay; a swap-in they agreed to stops, because
    /// the consent check needs the person to exist.
    /// </summary>
    public sealed class ListUserPurge : MediaBrowser.Controller.Events.IEventConsumer<Jellyfin.Data.Events.Users.UserDeletedEventArgs>
    {
        private readonly ListLinks _links;
        private readonly ListOperations _operations;
        private readonly Logger _logger;

        /// <summary>Creates the consumer (DI).</summary>
        /// <param name="links">Links.</param>
        /// <param name="operations">Operations.</param>
        /// <param name="logger">JE logger.</param>
        public ListUserPurge(ListLinks links, ListOperations operations, Logger logger)
        {
            _links = links;
            _operations = operations;
            _logger = logger;
        }

        /// <inheritdoc />
        public Task OnEvent(Jellyfin.Data.Events.Users.UserDeletedEventArgs eventArgs)
        {
            if (eventArgs?.Argument is { } user && user.Id != Guid.Empty)
            {
                try
                {
                    _links.PurgeUser(user.Id);
                    _operations.PurgeUser(user.Id);
                }
                catch (Exception ex)
                {
                    _logger.Debug($"[Lists] Removing a deleted user's list rows failed: {ex.Message}");
                }
            }

            return Task.CompletedTask;
        }
    }
}
