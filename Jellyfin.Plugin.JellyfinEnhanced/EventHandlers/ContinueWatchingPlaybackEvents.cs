using System;
using System.Collections.Generic;
using System.IO;
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
                var item = eventArgs?.Item;
                var session = eventArgs?.Session;
                if (item == null || session == null) return Task.CompletedTask;

                var userId = session.UserId;
                if (userId == Guid.Empty) return Task.CompletedTask;

                var itemIdStr = item.Id.ToString();
                var seriesIdStr = item is Episode ep && ep.SeriesId != Guid.Empty
                    ? ep.SeriesId.ToString()
                    : null;

                var dropped = MutateUnderLock(userId, hidden =>
                {
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

                if (dropped > 0)
                {
                    _logger.Info($"CW: dropped {dropped} hidden-content entr{(dropped == 1 ? "y" : "ies")} for user {userId} on resume of item {item.Id}");
                }
            }
            catch (Exception ex)
            {
                // Event consumers must not throw — Jellyfin would treat
                // it as a plugin fault.
                _logger.Warning($"CW: playback-start consumer failed: {ex.Message}");
            }

            return Task.CompletedTask;
        }

        /// <summary>Lock + strict-read + <paramref name="mutate"/> + save if mutator returned > 0.</summary>
        private int MutateUnderLock(Guid userId, Func<UserHiddenContent, int> mutate)
        {
            var userIdN = userId.ToString("N");
            lock (_configManager.GetUserFileLock(userIdN, "hidden-content.json"))
            {
                UserHiddenContent hidden;
                try
                {
                    hidden = _configManager.GetUserConfigurationStrict<UserHiddenContent>(
                        userIdN, "hidden-content.json");
                }
                catch (InvalidDataException ex)
                {
                    _logger.Warning($"CW: skipping playback-consumer mutation for user {userId} due to corrupt hidden-content.json: {ex.Message}");
                    return 0;
                }

                if (hidden?.Items == null || hidden.Items.Count == 0) return 0;

                var changed = mutate(hidden);
                if (changed > 0)
                {
                    _configManager.SaveUserConfiguration(userIdN, "hidden-content.json", hidden);
                }
                return changed;
            }
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
            try
            {
                var id = e?.Item?.Id ?? Guid.Empty;
                if (id == Guid.Empty) return;
                var idStr = id.ToString();

                foreach (var user in _userManager.Users)
                {
                    PruneOrphan(user.Id, idStr);
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"CW: orphan-prune failed for removed item: {ex.Message}");
            }
        }

        /// <summary>Removes any HC entries for <paramref name="userId"/> whose ItemId matches <paramref name="targetId"/>.</summary>
        private void PruneOrphan(Guid userId, string targetId)
        {
            try
            {
                var userIdN = userId.ToString("N");
                lock (_configManager.GetUserFileLock(userIdN, "hidden-content.json"))
                {
                    UserHiddenContent hidden;
                    try
                    {
                        hidden = _configManager.GetUserConfigurationStrict<UserHiddenContent>(
                            userIdN, "hidden-content.json");
                    }
                    catch (InvalidDataException ex)
                    {
                        _logger.Warning($"CW: skipping orphan-prune for user {userId} due to corrupt hidden-content.json: {ex.Message}");
                        return;
                    }

                    if (hidden?.Items == null || hidden.Items.Count == 0) return;

                    var keysToDrop = new List<string>();
                    foreach (var kvp in hidden.Items)
                    {
                        var entry = kvp.Value;
                        if (entry == null) continue;
                        if (CwEventHelpers.IdMatches(entry.ItemId, targetId)) keysToDrop.Add(kvp.Key);
                    }

                    if (keysToDrop.Count == 0) return;
                    foreach (var k in keysToDrop) hidden.Items.Remove(k);
                    _configManager.SaveUserConfiguration(userIdN, "hidden-content.json", hidden);
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"CW: orphan-prune failed for user {userId}: {ex.Message}");
            }
        }
    }
}
