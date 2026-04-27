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
    /// <summary>Internal helpers shared by the Continue Watching event consumers.</summary>
    internal static class CwEventHelpers
    {
        /// <summary>Compares two id strings, treating hyphenated and N-format GUIDs as equivalent.</summary>
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

    /// <summary>Drops <c>continuewatching</c>/<c>homesections</c> HC entries on resume; global hides are left alone.</summary>
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

        /// <inheritdoc />
        public Task OnEvent(PlaybackStartEventArgs eventArgs)
        {
            try
            {
                // Admin master switch: when HC is disabled plugin-wide, leave entries
                // alone — auto-dropping them now would cause non-revertible state when
                // admin re-enables HC (the user never asked to unhide).
                if (JellyfinEnhanced.Instance?.Configuration?.HiddenContentEnabled != true)
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

                int dropped;
                try
                {
                    dropped = _configManager.RmwUserConfiguration<UserHiddenContent>(
                        userId.ToString("N"), "hidden-content.json", hidden =>
                    {
                        if (hidden?.Items == null || hidden.Items.Count == 0) return 0;
                        var keysToDrop = new List<string>();
                        foreach (var kvp in hidden.Items)
                        {
                            var entry = kvp.Value;
                            if (entry == null) continue;
                            var scope = string.IsNullOrEmpty(entry.HideScope) ? "global" : entry.HideScope;
                            if (!AutoRemoveScopes.Contains(scope)) continue;
                            if (string.IsNullOrEmpty(entry.ItemId)) continue;

                            if (CwEventHelpers.IdMatches(entry.ItemId, itemIdStr)
                                || (seriesIdStr != null && CwEventHelpers.IdMatches(entry.ItemId, seriesIdStr)))
                            {
                                keysToDrop.Add(kvp.Key);
                            }
                        }
                        foreach (var k in keysToDrop) hidden.Items.Remove(k);
                        return keysToDrop.Count;
                    });
                }
                catch (InvalidDataException ex)
                {
                    _logger.Warning($"CW: skipping playback drop for user {userId} due to corrupt hidden-content.json: {ex.Message}");
                    return Task.CompletedTask;
                }

                if (dropped > 0)
                {
                    _logger.Info($"CW: dropped {dropped} hidden-content entr{(dropped == 1 ? "y" : "ies")} for user {userId} on resume of item {item.Id}");
                }
            }
            catch (Exception ex)
            {
                // Event consumers must not throw — Jellyfin treats it as a plugin fault.
                _logger.Warning($"CW: playback-start consumer failed: {ex.Message}");
            }

            return Task.CompletedTask;
        }
    }

    /// <summary>Subscribes to <see cref="ILibraryManager.ItemRemoved"/> and prunes orphan HC entries.</summary>
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

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            _libraryManager.ItemRemoved += OnItemRemoved;
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public Task StopAsync(CancellationToken cancellationToken)
        {
            _libraryManager.ItemRemoved -= OnItemRemoved;
            return Task.CompletedTask;
        }

        private void OnItemRemoved(object? sender, ItemChangeEventArgs e)
        {
            // Capture the id synchronously (the EventArgs object isn't safe to
            // dereference once the event handler returns) but offload the
            // per-user loop so a bulk library cleanup doesn't serialize sync
            // I/O on the event-publisher thread.
            var id = e?.Item?.Id ?? Guid.Empty;
            if (id == Guid.Empty) return;
            var idStr = id.ToString();
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
                    _logger.Warning($"CW: orphan-prune failed for removed item: {ex.Message}");
                }
            });
        }

        /// <summary>Removes any HC entries for <paramref name="userId"/> whose ItemId matches <paramref name="targetId"/>.</summary>
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
