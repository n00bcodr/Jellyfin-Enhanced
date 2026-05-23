using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Extensions;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Hosting;
using Newtonsoft.Json;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    // Promotes pending Spoiler Guard entries (UserSpoilerBlur.PendingTmdb) into
    // real Series/Movies entries when matching library items land via Seerr or
    // any other source. Hooks ILibraryManager.ItemAdded. We snapshot the user
    // list synchronously inside the handler (UserManager / EventArgs aren't
    // safe to capture across awaits) and offload the per-user RMW loop to a
    // background Task so we don't block the Jellyfin scanner thread.
    //
    // Per-user library access is checked via GetItemById(id, user) — a user
    // who can't see the new item won't get the Spoiler Guard entry promoted
    // for them, which would otherwise be a UX bug (entry shows up in their
    // management UI for a title they can't access).
    //
    // ActivePendingKeys is a process-wide HashSet of "tv:{tmdb}" /
    // "movie:{tmdb}" keys that any user is known to have pending. Populated
    // on StartAsync via a one-time scan of per-user spoilerblur.json files,
    // and kept in sync by the controller endpoints + this promoter as items
    // get added/removed. Acts as a fast-path gate in OnItemAdded so a full
    // library scan with no pending users at all skips the user-fan-out
    // entirely (was 250k file reads per scan on a 5k-item / 50-user setup).
    public sealed class SpoilerSeerrPendingPromoter : IHostedService
    {
        private static readonly ConcurrentDictionary<string, byte> _activePendingKeys
            = new(StringComparer.OrdinalIgnoreCase);

        // Exposed so the controller's POST/DELETE endpoints can keep the gate
        // accurate without coupling to the hosted-service instance.
        public static void RegisterPending(string pendingKey)
        {
            if (string.IsNullOrEmpty(pendingKey)) return;
            _activePendingKeys.TryAdd(pendingKey, 0);
        }

        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly UserConfigurationManager _configManager;
        private readonly IApplicationPaths _appPaths;
        private readonly Logger _logger;

        public SpoilerSeerrPendingPromoter(
            ILibraryManager libraryManager,
            IUserManager userManager,
            UserConfigurationManager configManager,
            IApplicationPaths appPaths,
            Logger logger)
        {
            _libraryManager = libraryManager;
            _userManager = userManager;
            _configManager = configManager;
            _appPaths = appPaths;
            _logger = logger;
        }

        public Task StartAsync(CancellationToken cancellationToken)
        {
            // Repopulate the in-memory gate from disk so a restart doesn't
            // silently break promotion for users with already-pending entries.
            try
            {
                ScanExistingPendingKeys();
            }
            catch (Exception ex)
            {
                _logger.Warning($"SpoilerSeerrPromoter: startup scan failed (gate may miss already-pending entries until next write): {ex.Message}");
            }
            _libraryManager.ItemAdded += OnItemAdded;
            // ItemAdded fires before Jellyfin's TMDB provider has fetched
            // metadata — ProviderIds.Tmdb is typically empty at that moment.
            // ItemUpdated fires after metadata refresh, at which point
            // ProviderIds.Tmdb is populated, so we re-run the same logic.
            // OnItemChange is idempotent (gate + ContainsKey checks) so the
            // double-fire on items that arrive with metadata already in
            // place is harmless.
            _libraryManager.ItemUpdated += OnItemAdded;
            return Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken cancellationToken)
        {
            _libraryManager.ItemAdded -= OnItemAdded;
            _libraryManager.ItemUpdated -= OnItemAdded;
            return Task.CompletedTask;
        }

        // One-shot read of every user's spoilerblur.json at startup; extracts
        // PendingTmdb keys into _activePendingKeys. Best-effort — corrupt or
        // missing files are skipped (lenient read on purpose: gate is a
        // performance optimization, not a correctness invariant).
        private void ScanExistingPendingKeys()
        {
            var baseDir = Path.Combine(
                _appPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced");
            if (!Directory.Exists(baseDir)) return;

            int users = 0, keys = 0;
            foreach (var userDir in Directory.EnumerateDirectories(baseDir))
            {
                var path = Path.Combine(userDir, SpoilerBlurImageFilter.SpoilerBlurFileName);
                if (!File.Exists(path)) continue;
                users++;
                try
                {
                    var json = File.ReadAllText(path);
                    if (string.IsNullOrWhiteSpace(json)) continue;
                    var state = JsonConvert.DeserializeObject<UserSpoilerBlur>(json);
                    if (state?.PendingTmdb == null) continue;
                    foreach (var key in state.PendingTmdb.Keys)
                    {
                        if (string.IsNullOrEmpty(key)) continue;
                        if (_activePendingKeys.TryAdd(key, 0)) keys++;
                    }
                }
                catch (Exception ex)
                {
                    _logger.Warning($"SpoilerSeerrPromoter: skipping unreadable {path}: {ex.GetType().Name}");
                }
            }
            if (keys > 0)
            {
                _logger.Info($"SpoilerSeerrPromoter: gate primed with {keys} pending key(s) across {users} user file(s)");
            }
        }

        private void OnItemAdded(object? sender, ItemChangeEventArgs e)
        {
            try
            {
                var cfg = JellyfinEnhanced.Instance?.Configuration;
                if (cfg?.SpoilerBlurEnabled != true) return;

                var item = e?.Item;
                if (item is not Series && item is not Movie) return;

                if (item.ProviderIds == null
                    || !item.ProviderIds.TryGetValue("Tmdb", out var tmdbId)
                    || string.IsNullOrEmpty(tmdbId))
                {
                    return;
                }
                var mediaType = item is Series ? "tv" : "movie";
                var pendingKey = $"{mediaType}:{tmdbId}";

                // Fast-path gate: if NO user has registered this pending key,
                // skip the user-fan-out entirely. Saves 250k file reads on a
                // full library scan when nobody has anything pending.
                if (!_activePendingKeys.ContainsKey(pendingKey)) return;

                var userIds = _userManager.GetAllUsers().Select(u => u.Id).ToArray();
                var itemId = item.Id;
                var itemName = item.Name ?? string.Empty;
                var isSeries = item is Series;

                _ = Task.Run(() =>
                {
                    foreach (var userId in userIds)
                    {
                        try
                        {
                            PromoteForUser(userId, itemId, pendingKey, itemName, isSeries);
                        }
                        catch (Exception ex)
                        {
                            _logger.Warning($"SpoilerSeerrPromoter: per-user promotion failed for user {userId} on {pendingKey}: {ex.Message}");
                        }
                    }
                });
            }
            catch (Exception ex)
            {
                _logger.Warning($"SpoilerSeerrPromoter: handler failed before scheduling: {ex.Message}");
            }
        }

        private void PromoteForUser(Guid userId, Guid itemId, string pendingKey, string itemName, bool isSeries)
        {
            var jUser = _userManager.GetUserById(userId);
            if (jUser == null) return;

            // Library-access gate: if the user can't see the item (filtered
            // by library access), don't promote — they'd never see a card
            // for it but would see a stranded entry in management UI.
            BaseItem? visibleItem;
            try
            {
                visibleItem = _libraryManager.GetItemById<BaseItem>(itemId, jUser);
            }
            catch (Exception ex)
            {
                _logger.Warning($"SpoilerSeerrPromoter: GetItemById({itemId},{userId}) threw {ex.GetType().Name}: {ex.Message}");
                return;
            }
            if (visibleItem == null) return;

            var userKey = userId.ToString("N");
            var fileName = SpoilerBlurImageFilter.SpoilerBlurFileName;
            var itemKey = itemId.ToString("N");

            try
            {
                _configManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, fileName, state =>
                    {
                        if (!state.PendingTmdb.Remove(pendingKey)) return 0;
                        if (isSeries)
                        {
                            if (state.Series.ContainsKey(itemKey)) return 1;
                            state.Series[itemKey] = new SpoilerBlurSeriesEntry
                            {
                                SeriesId = itemKey,
                                SeriesName = itemName,
                                EnabledAt = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
                            };
                        }
                        else
                        {
                            if (state.Movies.ContainsKey(itemKey)) return 1;
                            state.Movies[itemKey] = new SpoilerBlurMovieEntry
                            {
                                MovieId = itemKey,
                                MovieName = itemName,
                                EnabledAt = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
                            };
                        }
                        return 1;
                    });
                _logger.Info($"SpoilerSeerrPromoter: promoted {pendingKey} -> {(isSeries ? "series" : "movie")} {itemKey} for user {userId}");
            }
            catch (InvalidDataException ex)
            {
                _logger.Warning($"SpoilerSeerrPromoter: skipping {userId}/{pendingKey} due to corrupt spoilerblur.json: {ex.Message}");
            }
        }
    }
}
