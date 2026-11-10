using System;
using System.Collections.Generic;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Seerr.Services
{
    public enum WatchlistRemovalSource
    {
        Off,
        Jellyfin,
        Seerr,
        Both
    }

    /// <summary>
    /// The decision logic of the watchlist removal sync, free of any I/O so it can be tested.
    ///
    /// The idea: remember which items were on BOTH watchlists after the last pass. An item
    /// from that list that is now missing from one side was removed there on purpose (or
    /// watched, which drops it from the Jellyfin watchlist). An item that was only ever on
    /// one side is a pending addition and is never treated as a removal.
    /// </summary>
    public static class WatchlistSyncPlanner
    {
        public static string Key(string mediaType, int tmdbId) => $"{mediaType}:{tmdbId}";

        public static WatchlistRemovalSource ParseMode(string? value)
        {
            if (string.IsNullOrWhiteSpace(value)) return WatchlistRemovalSource.Jellyfin;
            return value.Trim().ToLowerInvariant() switch
            {
                "jellyfin" => WatchlistRemovalSource.Jellyfin,
                "seerr" => WatchlistRemovalSource.Seerr,
                "both" => WatchlistRemovalSource.Both,
                _ => WatchlistRemovalSource.Off
            };
        }

        public static bool HonoursJellyfinRemovals(WatchlistRemovalSource mode)
            => mode == WatchlistRemovalSource.Jellyfin || mode == WatchlistRemovalSource.Both;

        public static bool HonoursSeerrRemovals(WatchlistRemovalSource mode)
            => mode == WatchlistRemovalSource.Seerr || mode == WatchlistRemovalSource.Both;

        /// <summary>
        /// The removal sync only has something to do when a watchlist feature is in use
        /// together with a removal source, so installs that never touched watchlists are
        /// left alone.
        /// </summary>
        public static bool IsActive(PluginConfiguration? config)
            => config != null
               && config.JellyseerrEnabled
               && ParseMode(config.WatchlistRemovalSync) != WatchlistRemovalSource.Off
               && (config.SyncJellyfinWatchlistToSeerr || config.SyncJellyseerrWatchlist || config.AddRequestedMediaToWatchlist);

        public sealed record Plan(
            HashSet<string> RemoveFromSeerr,
            HashSet<string> RemoveFromJellyfin,
            HashSet<string> NextSynced);

        /// <param name="previous">Items that were on both lists after the last pass.</param>
        /// <param name="jellyfin">Items currently on the user's Jellyfin watchlist.</param>
        /// <param name="seerr">Items currently on the user's Seerr watchlist.</param>
        /// <param name="inLibrary">Items that still exist in the Jellyfin library. An item that
        /// vanished from the library is not a watchlist removal, so it is left alone.</param>
        public static Plan Compute(
            IReadOnlyCollection<string> previous,
            IReadOnlySet<string> jellyfin,
            IReadOnlySet<string> seerr,
            IReadOnlySet<string> inLibrary,
            WatchlistRemovalSource mode)
        {
            var removeFromSeerr = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var removeFromJellyfin = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var next = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var previousSet = new HashSet<string>(previous, StringComparer.OrdinalIgnoreCase);

            if (mode != WatchlistRemovalSource.Off)
            {
                foreach (var key in previousSet)
                {
                    var onJellyfin = jellyfin.Contains(key);
                    var onSeerr = seerr.Contains(key);

                    if (onJellyfin && onSeerr)
                    {
                        next.Add(key);
                    }
                    else if (!onJellyfin && onSeerr)
                    {
                        // Gone from Jellyfin. Only a removal if the item is still in the library.
                        if (inLibrary.Contains(key) && HonoursJellyfinRemovals(mode)) removeFromSeerr.Add(key);
                        else next.Add(key);
                    }
                    else if (onJellyfin && !onSeerr)
                    {
                        if (HonoursSeerrRemovals(mode)) removeFromJellyfin.Add(key);
                        else next.Add(key);
                    }
                    // On neither list: removed everywhere, forget it.
                }

                // Anything now on both lists is in sync, whether it was added to both by hand,
                // by a sync task or by a request.
                foreach (var key in jellyfin)
                {
                    if (seerr.Contains(key)) next.Add(key);
                }
            }

            return new Plan(removeFromSeerr, removeFromJellyfin, next);
        }
    }
}
