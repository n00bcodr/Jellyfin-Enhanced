using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders
{
    /// <summary>Which playback event a trigger decision is made for.</summary>
    public enum PlaybackPhase
    {
        /// <summary>Playback started (position = the start/resume position).</summary>
        Start,

        /// <summary>A periodic progress report.</summary>
        Progress,

        /// <summary>Playback stopped (position = where it stopped).</summary>
        Stop,
    }

    /// <summary>A real entry of a collection with the date it sorts by (design §3: merged "list order").</summary>
    /// <param name="ItemId">Library item id.</param>
    /// <param name="PremiereDate">Premiere date (null sorts last).</param>
    public readonly record struct DatedEntry(Guid ItemId, DateTime? PremiereDate);

    /// <summary>
    /// The pure rules of list placeholder auto-requests (design §11, D3, G1–G3): when playback triggers, which
    /// placeholders come next in a list, which season a TV placeholder requests, which Seerr status means "already
    /// handled", and the exact request body. "Released" is <see cref="PlaceholderRules.IsReleased"/> on the stored
    /// release date (C4, kept current by the metadata service), the same flag the list view shows. Kept free of I/O so
    /// every decision is unit-tested.
    /// </summary>
    public static class ListPlaceholderAutoRequestRules
    {
        /// <summary>How many list entries after the played item are scanned for eligible placeholders (G2).</summary>
        public const int ScanWindow = 50;

        /// <summary>Largest configurable number of placeholders requested per playback.</summary>
        public const int MaxCount = 10;

        /// <summary>Largest configurable minutes-watched trigger.</summary>
        public const int MaxMinutes = 600;

        /// <summary>A placeholder handled for a user is not looked at again for that user within this window.</summary>
        public static readonly TimeSpan UserDedupeWindow = TimeSpan.FromHours(6);

        /// <summary>The configured count, clamped to 1..<see cref="MaxCount"/>.</summary>
        /// <param name="value">Configured value.</param>
        /// <returns>Effective count.</returns>
        public static int ClampCount(int value) => Math.Clamp(value, 1, MaxCount);

        /// <summary>The configured minutes, clamped to 0..<see cref="MaxMinutes"/>.</summary>
        /// <param name="value">Configured value.</param>
        /// <returns>Effective minutes.</returns>
        public static int ClampMinutes(int value) => Math.Clamp(value, 0, MaxMinutes);

        /// <summary>
        /// Whether a playback event reaches the trigger. Minutes 0 = "on playback start": the start event (or, if JE
        /// missed it, the first later event of the session) triggers. Otherwise the playback position must be at least
        /// the configured minutes — reported by a progress event, a stop past that point, or a start that resumes
        /// beyond it. Positions are playback positions, like the sibling auto-request triggers.
        /// </summary>
        /// <param name="phase">Event kind.</param>
        /// <param name="positionTicks">Playback position.</param>
        /// <param name="minutes">Configured minutes (clamped by the caller).</param>
        /// <returns>Whether to trigger.</returns>
        public static bool ShouldTrigger(PlaybackPhase phase, long? positionTicks, int minutes)
        {
            if (minutes <= 0)
            {
                return true;
            }

            return positionTicks is long ticks && ticks >= TimeSpan.FromMinutes(minutes).Ticks;
        }

        /// <summary>
        /// Placeholder ids after the played item in a playlist, in the user's projection of the canonical order
        /// (A1/A2): real entries the user can't see and placeholders hidden from them (parental filter) don't count.
        /// Anchor = the item's FIRST occurrence. At most <paramref name="window"/> entries (real or placeholder) after
        /// it are scanned. Null when the item is not in the (projected) playlist.
        /// </summary>
        /// <param name="canonical">Canonical playlist order (real + placeholder tokens).</param>
        /// <param name="itemId">The played item.</param>
        /// <param name="realVisible">Whether the user can see a real token's item.</param>
        /// <param name="window">Entries to scan.</param>
        /// <param name="placeholderVisible">Whether the user can see a placeholder (null = all).</param>
        /// <returns>Placeholder ids in list order, or null.</returns>
        public static List<string>? PlaylistWindow(IReadOnlyList<string> canonical, Guid itemId, Func<Guid, bool> realVisible, int window = ScanWindow, Func<string, bool>? placeholderVisible = null)
        {
            var anchor = ListPlaceholderOrder.RealToken(itemId, 0);
            var found = false;
            var scanned = 0;
            var result = new List<string>();
            foreach (var token in canonical)
            {
                if (ListPlaceholderOrder.TryParseReal(token, out var id, out _))
                {
                    if (!found)
                    {
                        found = string.Equals(token, anchor, StringComparison.Ordinal);
                        continue;
                    }

                    if (!realVisible(id))
                    {
                        continue;
                    }
                }
                else if (!found)
                {
                    continue;
                }
                else if (ListPlaceholderOrder.PlaceholderIdOf(token) is string placeholderId)
                {
                    if (placeholderVisible != null && !placeholderVisible(placeholderId))
                    {
                        continue;
                    }

                    result.Add(placeholderId);
                }

                if (++scanned >= window)
                {
                    break;
                }
            }

            return found ? result : null;
        }

        /// <summary>
        /// Placeholder ids after the played item in a collection's merged list order (design §3): real children by
        /// premiere date (unknown last, then their collection order) merged with the placeholders in display order
        /// (release date, TBA last, then title); on equal dates real entries come first. The anchor is the most specific
        /// of <paramref name="anchorIds"/> that is a real entry (the item itself, else its season, else its series), at
        /// its first position in list order. Null when no anchor is in the collection. Placeholders hidden from the user
        /// take no window slot.
        /// </summary>
        /// <param name="real">Real children in collection order, with dates (only those the user can see).</param>
        /// <param name="placeholders">The collection's placeholders.</param>
        /// <param name="anchorIds">Ids that count as "the played item", most specific first (item, season, series).</param>
        /// <param name="window">Entries to scan.</param>
        /// <param name="placeholderVisible">Whether the user can see a placeholder (null = all).</param>
        /// <returns>Placeholder ids in list order, or null.</returns>
        public static List<string>? CollectionWindow(IReadOnlyList<DatedEntry> real, IReadOnlyList<Placeholder> placeholders, IReadOnlyList<Guid> anchorIds, int window = ScanWindow, Func<string, bool>? placeholderVisible = null)
        {
            var realSorted = real
                .Select((entry, index) => (entry, index))
                .OrderBy(x => x.entry.PremiereDate.HasValue ? 0 : 1)
                .ThenBy(x => x.entry.PremiereDate ?? DateTime.MaxValue)
                .ThenBy(x => x.index)
                .Select(x => x.entry)
                .ToList();
            var placeholderSorted = ListPlaceholderOrder.SortForCollection(placeholders);

            // Merge: compare dates (unknown = +infinity); ties go to the real entry.
            var merged = new List<(Guid? ItemId, string? PlaceholderId)>(realSorted.Count + placeholderSorted.Count);
            int r = 0, p = 0;
            while (r < realSorted.Count || p < placeholderSorted.Count)
            {
                var takeReal = p >= placeholderSorted.Count
                    || (r < realSorted.Count && SortDate(realSorted[r].PremiereDate) <= SortDate(PlaceholderDate(placeholderSorted[p])));
                merged.Add(takeReal ? (realSorted[r++].ItemId, null) : (null, placeholderSorted[p++].Id));
            }

            var start = -1;
            foreach (var anchor in anchorIds)
            {
                start = merged.FindIndex(m => m.ItemId == anchor);
                if (start >= 0)
                {
                    break;
                }
            }

            if (start < 0)
            {
                return null;
            }

            return merged
                .Skip(start + 1)
                .Where(m => m.PlaceholderId == null || placeholderVisible == null || placeholderVisible(m.PlaceholderId))
                .Take(window)
                .Where(m => m.PlaceholderId != null)
                .Select(m => m.PlaceholderId!)
                .ToList();

            static DateTime SortDate(DateTime? date) => date?.Date ?? DateTime.MaxValue;

            // The same date the collection display sorts placeholders by (stored release date; TBA = unknown).
            static DateTime? PlaceholderDate(Placeholder placeholder) =>
                placeholder.ReleaseDate != null && PlaceholderRules.TryParseDate(placeholder.ReleaseDate, out var date) ? date : null;
        }

        /// <summary>
        /// The season a TV placeholder requests (null for movies):
        /// <list type="bullet">
        /// <item>season → that season (also when it is partly filled: the rest of it is what's missing);</item>
        /// <item>episodes → the season its episodes are in (C2: one season per placeholder);</item>
        /// <item>series → season 1, however much of the show is in the list (later seasons are Auto Season Requests'
        /// job, G3); when the show has no season 1, the lowest regular season the stored expected set lists, else the
        /// lowest one <paramref name="tvDetails"/> lists.</item>
        /// </list>
        /// </summary>
        /// <param name="placeholder">Placeholder.</param>
        /// <param name="tvDetails">Seerr <c>/api/v1/tv/{id}</c> details (series kind only; optional).</param>
        /// <returns>Season number or null.</returns>
        public static int? RequestSeason(Placeholder placeholder, JsonElement? tvDetails = null)
        {
            switch (placeholder.Kind)
            {
                case PlaceholderKinds.Season:
                    return placeholder.SeasonNumber;
                case PlaceholderKinds.Episodes:
                    return placeholder.SeasonNumber ?? placeholder.Episodes.FirstOrDefault()?.S;
                case PlaceholderKinds.Series:
                    return SeriesRequestSeason(placeholder, tvDetails);
                default:
                    return null;
            }
        }

        /// <summary>
        /// Whether <see cref="RequestSeason"/> can only pick the season once Seerr's TV details are known: a series whose
        /// expected set is still empty (metadata pending or failed), so whether it has a season 1 is unknown. Without the
        /// details the season (1) is only provisional.
        /// </summary>
        /// <param name="placeholder">Placeholder.</param>
        /// <returns>Whether the season depends on the Seerr details.</returns>
        public static bool SeasonDependsOnSeerrDetails(Placeholder placeholder) =>
            placeholder.Kind == PlaceholderKinds.Series && !placeholder.Expected.Any(e => e.S >= 1);

        /// <summary>The request identity <c>movie|tmdbId</c> or <c>tv|tmdbId|season</c> (cross-list and per-user dedupe, G2).</summary>
        /// <param name="mediaType">"movie" or "tv".</param>
        /// <param name="tmdbId">TMDB id.</param>
        /// <param name="season">Requested season (tv).</param>
        /// <returns>The key.</returns>
        public static string RequestKey(string mediaType, int tmdbId, int? season) =>
            mediaType == "tv"
                ? string.Create(CultureInfo.InvariantCulture, $"tv|{tmdbId}|{season ?? 1}")
                : string.Create(CultureInfo.InvariantCulture, $"movie|{tmdbId}");

        /// <summary>
        /// The Seerr <c>POST /api/v1/request</c> body: movie → <c>{mediaType,mediaId,is4k:false}</c>; tv →
        /// <c>{mediaType,mediaId,seasons:[n],is4k:false}</c>. <c>is4k</c> is always explicit: without it Seerr skips its
        /// duplicate-request check. No advanced fields: Seerr applies the user's defaults and override rules.
        /// </summary>
        /// <param name="mediaType">"movie" or "tv".</param>
        /// <param name="tmdbId">TMDB id.</param>
        /// <param name="season">Season (tv).</param>
        /// <returns>JSON body.</returns>
        public static string BuildRequestBody(string mediaType, int tmdbId, int? season)
        {
            if (mediaType == "tv")
            {
                return JsonSerializer.Serialize(new Dictionary<string, object>
                {
                    ["mediaType"] = "tv",
                    ["mediaId"] = tmdbId,
                    ["seasons"] = new[] { season ?? 1 },
                    ["is4k"] = false,
                });
            }

            return JsonSerializer.Serialize(new Dictionary<string, object>
            {
                ["mediaType"] = "movie",
                ["mediaId"] = tmdbId,
                ["is4k"] = false,
            });
        }

        /// <summary>Whether the Seerr user may request this media type (Seerr's own rule: ADMIN, REQUEST, or REQUEST_MOVIE/REQUEST_TV).</summary>
        /// <param name="permissions">Seerr permissions.</param>
        /// <param name="mediaType">"movie" or "tv".</param>
        /// <returns>Whether a non-4K request is allowed.</returns>
        public static bool CanRequest(JellyseerrPermission permissions, string mediaType) =>
            JellyseerrPermissionHelper.HasAnyPermission(
                permissions,
                JellyseerrPermission.ADMIN | JellyseerrPermission.REQUEST | (mediaType == "tv" ? JellyseerrPermission.REQUEST_TV : JellyseerrPermission.REQUEST_MOVIE));

        /// <summary>
        /// The Seerr media status of what a placeholder would request, read from fresh Seerr details (D3): 1 unknown,
        /// 2 pending, 3 processing, 4 partially available, 5 available, 6 blocklisted, 7 deleted. Movies: the media
        /// status, or 2/3 for an active non-4K request. TV: season level — the season's availability row when it says
        /// something (not 1/7), else 2/3 when an active non-4K request covers the season; 6 when the show is
        /// blocklisted; 5 when the show is available and Seerr has no season rows.
        /// </summary>
        /// <param name="details">Seerr movie/tv details.</param>
        /// <param name="mediaType">"movie" or "tv".</param>
        /// <param name="season">Requested season (tv).</param>
        /// <returns>The status.</returns>
        public static int SeerrStatus(JsonElement details, string mediaType, int? season)
        {
            if (details.ValueKind != JsonValueKind.Object
                || !details.TryGetProperty("mediaInfo", out var media) || media.ValueKind != JsonValueKind.Object)
            {
                return 1;
            }

            var mediaStatus = ReadInt(media, "status") ?? 1;
            if (mediaType != "tv")
            {
                if (mediaStatus is >= 2 and <= 6)
                {
                    return mediaStatus;
                }

                return ActiveRequestStatus(media, null) ?? mediaStatus;
            }

            if (mediaStatus == 6)
            {
                return 6;
            }

            int? seasonStatus = null;
            var hasSeasonRows = false;
            if (media.TryGetProperty("seasons", out var seasons) && seasons.ValueKind == JsonValueKind.Array)
            {
                foreach (var row in seasons.EnumerateArray())
                {
                    hasSeasonRows = true;
                    if (ReadInt(row, "seasonNumber") == season)
                    {
                        seasonStatus = ReadInt(row, "status");
                    }
                }
            }

            if (seasonStatus is int value && value != 1 && value != 7)
            {
                return value;
            }

            if (ActiveRequestStatus(media, season) is int requested)
            {
                return requested;
            }

            if (!hasSeasonRows && mediaStatus == 5)
            {
                return 5;
            }

            return seasonStatus ?? 1;
        }

        /// <summary>Statuses that mean "already requested, processing, available or blocklisted" — never requested again (D3).</summary>
        /// <param name="status">Seerr media status.</param>
        /// <returns>Whether to skip.</returns>
        public static bool IsHandledStatus(int status) => status is >= 2 and <= 6;

        // 2 (pending) / 3 (processing) for an active (pending/approved) non-4K request, for tv only one covering the season.
        private static int? ActiveRequestStatus(JsonElement media, int? season)
        {
            if (!media.TryGetProperty("requests", out var requests) || requests.ValueKind != JsonValueKind.Array)
            {
                return null;
            }

            int? best = null;
            foreach (var request in requests.EnumerateArray())
            {
                if (request.ValueKind != JsonValueKind.Object
                    || (request.TryGetProperty("is4k", out var is4k) && is4k.ValueKind == JsonValueKind.True))
                {
                    continue;
                }

                var status = ReadInt(request, "status");
                if (status is not (1 or 2))
                {
                    continue; // declined, failed or completed: not an active request
                }

                if (season.HasValue)
                {
                    if (!request.TryGetProperty("seasons", out var requestSeasons) || requestSeasons.ValueKind != JsonValueKind.Array
                        || !requestSeasons.EnumerateArray().Any(s => ReadInt(s, "seasonNumber") == season.Value))
                    {
                        continue;
                    }
                }

                var mapped = status == 1 ? 2 : 3;
                best = best is int current ? Math.Max(current, mapped) : mapped;
            }

            return best;
        }

        private static int? SeriesRequestSeason(Placeholder placeholder, JsonElement? tvDetails)
        {
            var expected = placeholder.Expected.Where(e => e.S >= 1).Select(e => e.S).Distinct().ToList();
            var known = expected.Count > 0 ? expected : SeerrSeasonNumbers(tvDetails);
            return known.Count > 0 && !known.Contains(1) ? known.Min() : 1;
        }

        // Seerr TV details: the regular season numbers (≥ 1) it lists.
        private static List<int> SeerrSeasonNumbers(JsonElement? tvDetails)
        {
            var result = new List<int>();
            if (tvDetails is JsonElement details && details.ValueKind == JsonValueKind.Object
                && details.TryGetProperty("seasons", out var seasons) && seasons.ValueKind == JsonValueKind.Array)
            {
                foreach (var row in seasons.EnumerateArray())
                {
                    if (ReadInt(row, "seasonNumber") is int number && number > 0)
                    {
                        result.Add(number);
                    }
                }
            }

            return result;
        }

        private static int? ReadInt(JsonElement element, string property) =>
            element.ValueKind == JsonValueKind.Object && element.TryGetProperty(property, out var value)
                && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number)
                ? number
                : null;
    }
}
