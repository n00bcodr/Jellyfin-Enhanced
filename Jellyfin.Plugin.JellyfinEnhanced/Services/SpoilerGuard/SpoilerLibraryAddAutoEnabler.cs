using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Extensions;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    // "Auto-enable on library add": when a new Series or Movie lands in the
    // library — from a scan, a Seerr download, a manual copy, anything — add
    // it to the Spoiler Guard list of every user who can see its library, so
    // protection is in place BEFORE anyone presses play (the gap the
    // first-play and Seerr-request modes leave, see #801). Gated by the admin
    // toggle SpoilerAutoEnableOnLibraryAdd, the master SpoilerBlurEnabled
    // switch, and the shared SpoilerAutoEnableFilter scope (content type +
    // library allow-list).
    //
    // Load discipline: a full scan of a new library raises thousands of
    // ItemAdded events in a burst, on the scanner's thread. The handler
    // therefore does nothing but cheap type/config checks and an enqueue;
    // all library reads and file writes happen in a batched flush that runs
    // FlushSettleDelayMs after the first event of a burst (the timer is NOT
    // reset per event, so a long scan flushes every settle period instead of
    // hoarding until it ends). Each flush does exactly ONE read-modify-write
    // of spoilerblur.json per user, however many titles arrived — never one
    // write per item.
    //
    // Only ItemAdded is hooked (not ItemUpdated): a title is armed exactly
    // once, when it is new, so a user who later switches Spoiler Guard off
    // for it is never re-armed by a metadata refresh. There is no per-user
    // opt-out beyond that — like the first-play mode, this applies to every
    // (non-disabled) user on the instance.
    //
    // Library access is checked via the user's policy (EnableAllFolders or
    // the EnabledFolders allow-list) rather than a per-(user, item)
    // GetItemById visibility probe: that keeps a 5k-item scan at N + U
    // in-memory checks instead of N × U database reads. Parental-rating or
    // tag blocks are not consulted; such an entry is harmless (the images
    // are never served to that user anyway) and can be removed from the
    // Spoiler Guard management list like any other.
    public sealed class SpoilerLibraryAddAutoEnabler : IHostedService, IDisposable
    {
        // How long after the FIRST queued event a flush runs. Long enough for
        // the burst of a season import to coalesce and for Jellyfin's metadata
        // refresh to give the item its real name; short enough that a title
        // is armed well before anyone browses to it.
        private const int FlushSettleDelayMs = 10_000;

        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly UserConfigurationManager _configManager;
        private readonly Logger _logger;

        private readonly ConcurrentQueue<QueuedAdd> _queue = new();
        private readonly Timer _flushTimer;
        private readonly object _flushLock = new();
        private int _flushScheduled; // 0 = idle, 1 = timer armed
        private volatile bool _stopped;

        private readonly record struct QueuedAdd(Guid Id, bool IsSeries);

        private sealed class Candidate
        {
            public string IdN = string.Empty;
            public string Name = string.Empty;
            public bool IsSeries;
            public List<Guid> LibraryIds = new();
        }

        public SpoilerLibraryAddAutoEnabler(
            ILibraryManager libraryManager,
            IUserManager userManager,
            UserConfigurationManager configManager,
            Logger logger)
        {
            _libraryManager = libraryManager;
            _userManager = userManager;
            _configManager = configManager;
            _logger = logger;
            _flushTimer = new Timer(OnFlushTimer, null, Timeout.Infinite, Timeout.Infinite);
        }

        public Task StartAsync(CancellationToken cancellationToken)
        {
            // Always subscribe; the handler re-checks config per event so an
            // admin toggling the mode on doesn't need a restart.
            _libraryManager.ItemAdded += OnItemAdded;
            return Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken cancellationToken)
        {
            _stopped = true;
            _libraryManager.ItemAdded -= OnItemAdded;
            // Cancel the pending timer and drain whatever is queued right
            // now: ItemAdded never re-fires for these items, so anything
            // still in the queue at shutdown would otherwise be lost for
            // good. Hosted services stop before the library/user managers
            // are disposed, so the flush can still read the library here.
            _flushTimer.Change(Timeout.Infinite, Timeout.Infinite);
            RunFlush();
            return Task.CompletedTask;
        }

        public void Dispose()
        {
            _flushTimer.Dispose();
        }

        // Runs synchronously on the scanner thread for every item a scan
        // creates — must stay allocation- and I/O-free on the common path.
        private void OnItemAdded(object? sender, ItemChangeEventArgs e)
        {
            try
            {
                var cfg = JellyfinEnhanced.Instance?.Configuration;
                if (cfg?.SpoilerBlurEnabled != true) return;
                if (cfg.SpoilerAutoEnableOnLibraryAdd != true) return;

                var item = e?.Item;
                if (item is not Series && item is not Movie) return;
                var isSeries = item is Series;
                if (!SpoilerAutoEnableFilter.AllowsType(cfg, isSeries)) return;
                if (_stopped) return;

                _queue.Enqueue(new QueuedAdd(item.Id, isSeries));
                if (Interlocked.CompareExchange(ref _flushScheduled, 1, 0) == 0)
                {
                    _flushTimer.Change(FlushSettleDelayMs, Timeout.Infinite);
                }
            }
            catch (ObjectDisposedException)
            {
                // A handler already in flight when the service was disposed
                // (StopAsync unsubscribes, but can't cancel running calls).
            }
            catch (Exception ex)
            {
                _logger.Warning($"SpoilerAutoEnableOnLibraryAdd: handler failed before queueing: {ex.Message}");
            }
        }

        private void OnFlushTimer(object? state)
        {
            // Clear the armed flag BEFORE draining so an event that arrives
            // mid-flush re-arms the timer instead of being stranded in the
            // queue until the next unrelated add.
            Interlocked.Exchange(ref _flushScheduled, 0);
            if (_stopped) return; // StopAsync drained the queue itself
            RunFlush();
        }

        // Serialises flushes: a timer callback that fires while a previous
        // flush (or the StopAsync drain) is still running waits for it and
        // then finds only what arrived since, so nothing is written twice.
        private void RunFlush()
        {
            lock (_flushLock)
            {
                try
                {
                    Flush();
                }
                catch (Exception ex)
                {
                    _logger.Warning($"SpoilerAutoEnableOnLibraryAdd: flush failed: {ex.Message}");
                }
            }
        }

        private void Flush()
        {
            var seen = new HashSet<Guid>();
            var batch = new List<QueuedAdd>();
            while (_queue.TryDequeue(out var queued))
            {
                if (seen.Add(queued.Id)) batch.Add(queued);
            }
            if (batch.Count == 0) return;

            // Re-check config at flush time: the admin may have switched the
            // mode off during the settle window, in which case the queued
            // adds are simply dropped.
            var cfg = JellyfinEnhanced.Instance?.Configuration;
            if (cfg?.SpoilerBlurEnabled != true || cfg.SpoilerAutoEnableOnLibraryAdd != true) return;

            var allowedLibraries = SpoilerAutoEnableFilter.GetAllowedLibraryIds(cfg);

            var users = new List<Jellyfin.Database.Implementations.Entities.User>();
            var anyRestrictedUser = false;
            foreach (var user in _userManager.GetAllUsers())
            {
                if (user.HasPermission(PermissionKind.IsDisabled)) continue;
                if (!user.HasPermission(PermissionKind.EnableAllFolders)) anyRestrictedUser = true;
                users.Add(user);
            }
            if (users.Count == 0) return;

            // Library resolution walks the item's parent chain, so only pay
            // for it when something actually needs the answer.
            var needLibraryIds = allowedLibraries != null || anyRestrictedUser;

            var candidates = new List<Candidate>(batch.Count);
            foreach (var queued in batch)
            {
                var item = _libraryManager.GetItemById(queued.Id);
                // Gone again (scan reverted, item merged) or not what we
                // queued — skip rather than arm a dangling id.
                if (item is not Series && item is not Movie) continue;
                var isSeries = item is Series;
                if (!SpoilerAutoEnableFilter.AllowsType(cfg, isSeries)) continue;

                var libraryIds = needLibraryIds
                    ? SpoilerAutoEnableFilter.GetLibraryIds(_libraryManager, item)
                    : new List<Guid>();
                if (!SpoilerAutoEnableFilter.AllowsLibrary(allowedLibraries, libraryIds)) continue;

                candidates.Add(new Candidate
                {
                    IdN = item.Id.ToString("N"),
                    Name = item.Name ?? string.Empty,
                    IsSeries = isSeries,
                    LibraryIds = libraryIds,
                });
            }
            if (candidates.Count == 0) return;

            var fileName = SpoilerBlurImageFilter.SpoilerBlurFileName;
            var now = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture);
            var usersWritten = 0;

            foreach (var user in users)
            {
                var allFolders = user.HasPermission(PermissionKind.EnableAllFolders);
                HashSet<Guid>? enabledFolders = null;
                if (!allFolders)
                {
                    enabledFolders = new HashSet<Guid>(user.GetPreferenceValues<Guid>(PreferenceKind.EnabledFolders));
                }

                var visible = new List<Candidate>(candidates.Count);
                foreach (var c in candidates)
                {
                    if (allFolders || SpoilerAutoEnableFilter.AllowsLibrary(enabledFolders, c.LibraryIds))
                    {
                        visible.Add(c);
                    }
                }
                if (visible.Count == 0) continue;

                var userKey = user.Id.ToString("N");
                int addedSeries = 0, addedMovies = 0;
                try
                {
                    // ONE locked read-modify-write per user for the whole
                    // batch. Existing entries are left alone (never clobber
                    // an EnabledAt, never re-add something the user removed
                    // in the settle window).
                    _configManager.RmwUserConfiguration<UserSpoilerBlur>(userKey, fileName, state =>
                    {
                        if (state == null) return 0;
                        foreach (var c in visible)
                        {
                            if (c.IsSeries)
                            {
                                if (state.Series.ContainsKey(c.IdN)) continue;
                                state.Series[c.IdN] = new SpoilerBlurSeriesEntry
                                {
                                    SeriesId = c.IdN,
                                    SeriesName = c.Name,
                                    EnabledAt = now,
                                };
                                addedSeries++;
                            }
                            else
                            {
                                if (state.Movies.ContainsKey(c.IdN)) continue;
                                state.Movies[c.IdN] = new SpoilerBlurMovieEntry
                                {
                                    MovieId = c.IdN,
                                    MovieName = c.Name,
                                    EnabledAt = now,
                                };
                                addedMovies++;
                            }
                        }
                        return addedSeries + addedMovies;
                    });
                }
                catch (InvalidDataException ex)
                {
                    _logger.Warning($"SpoilerAutoEnableOnLibraryAdd: skipping user {userKey} due to corrupt spoilerblur.json: {ex.Message}");
                    continue;
                }
                catch (Exception ex)
                {
                    _logger.Warning($"SpoilerAutoEnableOnLibraryAdd: write for user {userKey} failed: {ex.Message}");
                    continue;
                }

                if (addedSeries + addedMovies > 0)
                {
                    usersWritten++;
                    _logger.Info($"SpoilerAutoEnableOnLibraryAdd: enabled Spoiler Guard for {addedSeries} new series and {addedMovies} new movie(s) for user {userKey} in one write (batch of {batch.Count} library add(s))");
                }
            }

            if (usersWritten == 0)
            {
                _logger.Info($"SpoilerAutoEnableOnLibraryAdd: batch of {batch.Count} library add(s) needed no writes ({candidates.Count} in scope, all already armed or not visible)");
            }
        }
    }
}
