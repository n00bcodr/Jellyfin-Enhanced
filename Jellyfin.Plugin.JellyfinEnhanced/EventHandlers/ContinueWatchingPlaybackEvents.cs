using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinEnhanced.EventHandlers
{
    internal static class CwEventHelpers
    {
        public static bool IdMatches(string entryId, string targetId)
        {
            if (string.IsNullOrEmpty(entryId) || string.IsNullOrEmpty(targetId)) return false;
            if ((Guid.TryParse(entryId, out var a) || Guid.TryParseExact(entryId, "N", out a))
                && (Guid.TryParse(targetId, out var b) || Guid.TryParseExact(targetId, "N", out b)))
            {
                return a == b;
            }
            return string.Equals(entryId, targetId, StringComparison.OrdinalIgnoreCase);
        }
    }

    public sealed class ContinueWatchingPlaybackConsumer : IEventConsumer<PlaybackStartEventArgs>
    {
        private static readonly HashSet<string> AutoRemoveScopes =
            new(StringComparer.OrdinalIgnoreCase) { "continuewatching", "homesections" };

        private readonly UserConfigurationManager _configManager;
        private readonly Logger _logger;

        public ContinueWatchingPlaybackConsumer(UserConfigurationManager configManager, Logger logger)
        {
            _configManager = configManager;
            _logger = logger;
        }

        public Task OnEvent(PlaybackStartEventArgs eventArgs)
        {
            try
            {
                // Mirror the response filter's HC + RCW gate (HiddenContentResponseFilter.cs). When admin runs
                // RCW=on / HC=off, the filter still strips continuewatching-scope entries; without this branch
                // resume would never auto-clear those entries and the user would see them stay hidden forever.
                var cfg = JellyfinEnhanced.Instance?.Configuration;
                var hcEnabled = cfg?.HiddenContentEnabled == true;
                var rcwEnabled = cfg?.RemoveContinueWatchingEnabled == true;
                if (!hcEnabled && !rcwEnabled)
                {
                    return Task.CompletedTask;
                }

                var item = eventArgs?.Item;
                var session = eventArgs?.Session;
                if (item == null || session == null) return Task.CompletedTask;

                var userId = session.UserId;
                if (userId == Guid.Empty) return Task.CompletedTask;

                var itemIdStr = item.Id.ToString();
                var seriesIdStr = item is Episode ep && ep.SeriesId != Guid.Empty
                    ? ep.SeriesId.ToString()
                    : null;

                int changed;
                try
                {
                    changed = _configManager.RmwUserConfiguration<UserHiddenContent>(
                        userId.ToString("N"), "hidden-content.json", hidden =>
                    {
                        if (hidden?.Items == null || hidden.Items.Count == 0) return 0;
                        var keysToDrop = new List<string>();
                        var keysToDemote = new List<string>();
                        foreach (var kvp in hidden.Items)
                        {
                            var entry = kvp.Value;
                            if (entry == null) continue;
                            var scope = string.IsNullOrEmpty(entry.HideScope) ? "global" : entry.HideScope;
                            if (!AutoRemoveScopes.Contains(scope)) continue;
                            if (string.IsNullOrEmpty(entry.ItemId)) continue;

                            if (!(CwEventHelpers.IdMatches(entry.ItemId, itemIdStr)
                                || (seriesIdStr != null && CwEventHelpers.IdMatches(entry.ItemId, seriesIdStr))))
                            {
                                continue;
                            }

                            // Resume signals the CW filter is unwanted; demote homesections to nextup rather than drop.
                            if (string.Equals(scope, "homesections", StringComparison.OrdinalIgnoreCase))
                            {
                                keysToDemote.Add(kvp.Key);
                            }
                            else
                            {
                                keysToDrop.Add(kvp.Key);
                            }
                        }
                        foreach (var k in keysToDrop) hidden.Items.Remove(k);
                        foreach (var k in keysToDemote)
                        {
                            if (hidden.Items.TryGetValue(k, out var e) && e != null) e.HideScope = "nextup";
                        }
                        return keysToDrop.Count + keysToDemote.Count;
                    });
                }
                catch (InvalidDataException ex)
                {
                    _logger.Warning($"CW: skipping playback drop for user {userId} due to corrupt hidden-content.json: {ex.Message}");
                    return Task.CompletedTask;
                }

                if (changed > 0)
                {
                    _logger.Info($"CW: dropped/demoted {changed} hidden-content entr{(changed == 1 ? "y" : "ies")} for user {userId} on resume of item {item.Id}");
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"CW: playback-start consumer failed: {ex.Message}");
            }

            return Task.CompletedTask;
        }
    }

    public sealed class ContinueWatchingLibraryHook : IHostedService
    {
        private readonly ILibraryManager _libraryManager;
        private readonly UserConfigurationManager _configManager;
        private readonly IUserManager _userManager;
        private readonly Logger _logger;

        public ContinueWatchingLibraryHook(
            ILibraryManager libraryManager,
            UserConfigurationManager configManager,
            IUserManager userManager,
            Logger logger)
        {
            _libraryManager = libraryManager;
            _configManager = configManager;
            _userManager = userManager;
            _logger = logger;
        }

        public Task StartAsync(CancellationToken cancellationToken)
        {
            _libraryManager.ItemRemoved += OnItemRemoved;
            return Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken cancellationToken)
        {
            _libraryManager.ItemRemoved -= OnItemRemoved;
            return Task.CompletedTask;
        }

        private void OnItemRemoved(object? sender, ItemChangeEventArgs e)
        {
            try
            {
                var id = e?.Item?.Id ?? Guid.Empty;
                if (id == Guid.Empty) return;
                var idStr = id.ToString();

                // Snapshot users sync (EventArgs/userManager not safe past handler return); offload the per-user loop.
                var userIds = _userManager.Users.Select(u => u.Id).ToArray();

                _ = Task.Run(() =>
                {
                    try
                    {
                        foreach (var userId in userIds)
                        {
                            PruneOrphan(userId, idStr);
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger.Warning($"CW: orphan-prune background task failed: {ex.Message}");
                    }
                });
            }
            catch (Exception ex)
            {
                _logger.Warning($"CW: orphan-prune failed before scheduling: {ex.Message}");
            }
        }

        private void PruneOrphan(Guid userId, string targetId)
        {
            try
            {
                _configManager.RmwUserConfiguration<UserHiddenContent>(
                    userId.ToString("N"), "hidden-content.json", hidden =>
                {
                    if (hidden?.Items == null || hidden.Items.Count == 0) return 0;
                    var keysToDrop = new List<string>();
                    foreach (var kvp in hidden.Items)
                    {
                        var entry = kvp.Value;
                        if (entry == null) continue;
                        if (CwEventHelpers.IdMatches(entry.ItemId, targetId)) keysToDrop.Add(kvp.Key);
                    }
                    foreach (var k in keysToDrop) hidden.Items.Remove(k);
                    return keysToDrop.Count;
                });
            }
            catch (InvalidDataException ex)
            {
                _logger.Warning($"CW: skipping orphan-prune for user {userId} due to corrupt hidden-content.json: {ex.Message}");
            }
            catch (Exception ex)
            {
                _logger.Warning($"CW: orphan-prune failed for user {userId}: {ex.Message}");
            }
        }
    }
}
