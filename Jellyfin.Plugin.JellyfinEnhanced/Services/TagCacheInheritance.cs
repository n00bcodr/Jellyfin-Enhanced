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
    /// Facts a season or episode takes from its series (scores, age rating; a season's genres). The full build and
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
                || !string.Equals(before.OfficialRating, after.OfficialRating, StringComparison.Ordinal)
                || !(before.Genres ?? Array.Empty<string>()).SequenceEqual(after.Genres ?? Array.Empty<string>(), StringComparer.Ordinal);

        /// <summary>
        /// Reapply <see cref="InheritFromSeries"/> to every cached season and episode of a series, from their own
        /// metadata (read in pages, never their streams). Rebuild lock held, inside an in-place write scope;
        /// the caller advances the version when this returns true.
        /// </summary>
        /// <param name="series">The series, with its new metadata.</param>
        /// <param name="previousGenres">The series' genres before the edit: a season showing exactly those, with none of its own, took them.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        private bool PatchInheritedFacts(BaseItem series, string[]? previousGenres, CancellationToken cancellationToken)
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
                    // A season without genres of its own (or a first episode's) shows its series' genres, including
                    // the first time the series gets any (it showed the series' empty list until then).
                    if (item.GetBaseItemKind() == BaseItemKind.Season && (item.Genres == null || item.Genres.Length == 0) && item.CommunityRating == null
                        && (entry.Genres ?? Array.Empty<string>()).SequenceEqual(previousGenres ?? Array.Empty<string>(), StringComparer.Ordinal))
                        updated.Genres = series.Genres;
                    if (updated.CommunityRating == entry.CommunityRating && updated.CriticRating == entry.CriticRating
                        && string.Equals(updated.OfficialRating, entry.OfficialRating, StringComparison.Ordinal)
                        && (updated.Genres ?? Array.Empty<string>()).SequenceEqual(entry.Genres ?? Array.Empty<string>(), StringComparer.Ordinal)) continue;
                    updated.LastUpdated = NextStamp();
                    RaiseMaxLastUpdated(updated.LastUpdated);
                    StoreEntry(key, updated);
                    changed = true;
                }
            }

            return changed;
        }
    }
}
