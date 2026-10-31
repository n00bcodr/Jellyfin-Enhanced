using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>Leaving soon projection shared by cache builds, /tag-data and native data reads.</summary>
    public partial class TagCacheService
    {
        private readonly LeavingSoonService? _leavingSoonService;

        /// <summary>An item's Leaving soon facts with its Season's and Series' (cache-only).</summary>
        public TagLeaving? GetLeaving(BaseItem item)
        {
            if (_leavingSoonService == null) return null;
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (!LeavingSoonService.Configured(config)) return null;
            return item switch
            {
                Episode e => _leavingSoonService.Resolve(e.Id, e.SeasonId == Guid.Empty ? null : e.SeasonId, e.SeriesId == Guid.Empty ? null : e.SeriesId, config),
                Season s => _leavingSoonService.Resolve(s.Id, null, s.SeriesId == Guid.Empty ? null : s.SeriesId, config),
                _ => _leavingSoonService.Get(item.Id, config),
            };
        }

        /// <summary>The scheduled refresh (when due) or a forced one; a changed answer is published to the cache.</summary>
        public async Task RefreshLeavingAsync(bool force, CancellationToken token)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (_leavingSoonService == null || config == null) return;
            if (!await _leavingSoonService.RefreshAsync(config, force, token).ConfigureAwait(false)) return;
            await _rebuildLock.WaitAsync(token).ConfigureAwait(false);
            try { PublishLeaving(); }
            finally { _rebuildLock.Release(); }
        }

        /// <summary>After a configuration save that changed the source: refresh in the background.</summary>
        internal void QueueLeavingRefresh()
        {
            _ = Task.Run(async () =>
            {
                try { await RefreshLeavingAsync(force: true, CancellationToken.None).ConfigureAwait(false); }
                catch (Exception ex) { _logger.Warning($"[LeavingSoon] Refresh after a configuration change failed: {ex.Message}"); }
            });
        }

        /// <summary>
        /// Stamp every cache entry with its current facts (rebuild lock held), without library
        /// reads: an Episode finds its Season through the cached Season entries (series id and
        /// season number).
        /// </summary>
        private void PublishLeaving()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            var items = _leavingSoonService?.Items(config) ?? new Dictionary<string, long?>();
            TagLeaving? Of(string? key) => key != null && items.TryGetValue(key, out var at) ? new TagLeaving { DeleteAt = at } : null;
            var seasons = new Dictionary<(string, int), string>();
            foreach (var pair in _cache)
            {
                if (pair.Value.Type == "Season" && pair.Value.SeriesId != null && pair.Value.SeasonNumber is { } number) seasons.TryAdd((pair.Value.SeriesId, number), pair.Key);
            }

            using var writes = BeginInPlaceWrites();
            var changed = false;
            foreach (var pair in _cache)
            {
                var entry = pair.Value;
                var leaving = Of(pair.Key);
                if (entry.Type is "Season" or "Episode")
                {
                    if (entry.Type == "Episode" && entry.SeriesId != null && (entry.EpisodeIndex?.Season ?? entry.SeasonNumber) is { } season
                        && seasons.TryGetValue((entry.SeriesId, season), out var seasonKey)) leaving = LeavingSoonService.Earliest(leaving, Of(seasonKey));
                    leaving = LeavingSoonService.Earliest(leaving, Of(entry.SeriesId));
                }

                if (leaving == entry.Leaving) continue;
                var copy = entry.Clone();
                copy.Leaving = leaving;
                copy.LastUpdated = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                RaiseMaxLastUpdated(copy.LastUpdated);
                StoreEntry(pair.Key, copy);
                changed = true;
            }

            if (changed)
            {
                Interlocked.Increment(ref _version);
                Interlocked.Exchange(ref _lastModified, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                ScheduleDebouncedSave();
            }
        }
    }
}
