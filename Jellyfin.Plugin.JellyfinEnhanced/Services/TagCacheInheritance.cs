using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using MediaBrowser.Controller.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Facts a season or episode takes from its series (scores, age rating). The full build and
    /// on-demand entries apply them through <see cref="InheritFromSeries"/>; a series-only edit
    /// reapplies them to the cached children (<see cref="PatchInheritedFacts"/>), so a corrected
    /// series score or rating never stays on its seasons and episodes until a full rebuild.
    /// </summary>
    public partial class TagCacheService
    {
        /// <summary>
        /// Fill a season's or episode's inherited facts from its series: both scores only when the child has
        /// no score of its own (none, or 0; ratingtags.js does the same), and the age rating when it has none.
        /// </summary>
        internal static void InheritFromSeries(TagCacheEntry entry, BaseItemKind kind, BaseItem? series)
        {
            if (series == null || kind is not (BaseItemKind.Season or BaseItemKind.Episode)) return;
            if (entry.CommunityRating is null or 0 && entry.CriticRating is null or 0)
            {
                entry.CommunityRating = series.CommunityRating;
                entry.CriticRating = series.CriticRating;
            }

            if (entry.OfficialRating == null && !string.IsNullOrWhiteSpace(series.OfficialRating))
            {
                entry.OfficialRating = series.OfficialRating;
            }
        }

        /// <summary>Whether a rebuilt series entry changed a fact its seasons and episodes inherit.</summary>
        private static bool InheritedFactsChanged(TagCacheEntry? before, TagCacheEntry after)
            => before == null || before.CommunityRating != after.CommunityRating || before.CriticRating != after.CriticRating
                || !string.Equals(before.OfficialRating, after.OfficialRating, StringComparison.Ordinal);

        /// <summary>
        /// Reapply <see cref="InheritFromSeries"/> to every cached season and episode of a series, from their own
        /// metadata (read in pages, never their streams). Rebuild lock held, inside an in-place write scope;
        /// the caller advances the version when this returns true.
        /// </summary>
        private bool PatchInheritedFacts(BaseItem series, CancellationToken cancellationToken)
        {
            var seriesKey = series.Id.ToString("N");
            var ids = new List<Guid>();
            foreach (var (key, entry) in _cache)
            {
                if (entry.SeriesId == seriesKey && entry.Type is "Season" or "Episode" && Guid.TryParse(key, out var id)) ids.Add(id);
            }

            var changed = false;
            foreach (var page in HydrateInPages(ids, cancellationToken))
            {
                if (ShouldAbortCacheWork) break;
                foreach (var item in page)
                {
                    var key = item.Id.ToString("N");
                    if (!_cache.TryGetValue(key, out var entry)) continue;
                    var updated = entry.Clone();
                    updated.CommunityRating = item.CommunityRating;
                    updated.CriticRating = item.CriticRating;
                    updated.OfficialRating = string.IsNullOrWhiteSpace(item.OfficialRating) ? null : item.OfficialRating;
                    InheritFromSeries(updated, item.GetBaseItemKind(), series);
                    if (updated.CommunityRating == entry.CommunityRating && updated.CriticRating == entry.CriticRating
                        && string.Equals(updated.OfficialRating, entry.OfficialRating, StringComparison.Ordinal)) continue;
                    updated.LastUpdated = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    RaiseMaxLastUpdated(updated.LastUpdated);
                    StoreEntry(key, updated);
                    changed = true;
                }
            }

            return changed;
        }
    }
}
