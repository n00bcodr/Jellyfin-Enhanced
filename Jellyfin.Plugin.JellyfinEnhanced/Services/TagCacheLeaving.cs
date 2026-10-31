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
    /// <remarks>
    /// Per user: a fact that only the administrator's leaving collections produced is served
    /// to a user who can access one of those collections (<see cref="LeavingSoonService.Visible"/>,
    /// applied by the tag cache projection, /tag-data and native posters), like collection-matched
    /// custom badges; the leaving collections a user cannot access are part of their
    /// accessRevision (<see cref="LeavingAccessSuffix"/>). Maintainerr's facts have no
    /// collection provenance and are served to anyone who can see the item.
    /// </remarks>
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

        /// <summary>An item's Leaving soon facts as <paramref name="user"/> may see them (the /tag-data projection).</summary>
        public TagLeaving? GetLeavingForUser(BaseItem item, JUser user)
        {
            var leaving = GetLeaving(item);
            return leaving?.Collections == null ? leaving : LeavingSoonService.Visible(leaving, ResolveUserAccess(user).Ids);
        }

        /// <summary>A cache entry as one user may see its Leaving facts (a clone when they change; the shared entry is untouched).</summary>
        public TagCacheEntry FilterLeavingForUser(TagCacheEntry entry, JUser user)
            => entry.Leaving?.Collections == null ? entry : WithVisibleLeaving(entry, ResolveUserAccess(user).Ids);

        private static TagCacheEntry WithVisibleLeaving(TagCacheEntry entry, HashSet<string> access)
        {
            if (entry.Leaving?.Collections == null) return entry;
            var filtered = entry.Clone();
            filtered.Leaving = LeavingSoonService.Visible(entry.Leaving, access);
            return filtered;
        }

        /// <summary>
        /// The part of a user's accessRevision that covers collection-made Leaving facts: a digest
        /// of the leaving collections the user cannot access ("" when none), so a stored copy is
        /// replaced when a collection's access changes even if no cache entry did.
        /// </summary>
        private string LeavingAccessSuffix(HashSet<string> access)
        {
            if (_leavingSoonService == null) return string.Empty;
            ulong sum = 0;
            var count = 0;
            foreach (var id in _leavingSoonService.NamedCollectionIds(JellyfinEnhanced.Instance?.Configuration))
            {
                if (access.Contains(id)) continue;
                sum = unchecked(sum + StableKeyHash(id));
                count++;
            }

            return count == 0 ? string.Empty : ";l" + count.ToString(System.Globalization.CultureInfo.InvariantCulture) + ":" + sum.ToString("x16", System.Globalization.CultureInfo.InvariantCulture);
        }

        /// <summary>
        /// The scheduled refresh (when due) or a forced one; a changed answer is published to the
        /// cache, and so is one an earlier run saved but did not publish (cancelled while waiting
        /// for the cache, or the server stopped), even when this run asks nothing.
        /// </summary>
        public async Task RefreshLeavingAsync(bool force, CancellationToken token)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (_leavingSoonService == null || config == null) return;
            if (!await _leavingSoonService.RefreshAsync(config, force, token).ConfigureAwait(false) && !_leavingSoonService.PublishPending) return;
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
            long revision = 0;
            var items = _leavingSoonService?.Items(config, out revision) ?? new Dictionary<string, TagLeaving>();
            TagLeaving? Of(string? key) => key != null && items.TryGetValue(key, out var leaving) ? leaving : null;
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

            _leavingSoonService?.MarkPublished(revision);
        }
    }
}
