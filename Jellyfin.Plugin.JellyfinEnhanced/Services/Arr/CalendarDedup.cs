using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr
{
    /// <summary>
    /// Merges calendar events several Sonarr/Radarr/Shoko instances report for the same release into one
    /// (the calendar route's de-duplication). Tie-break: an event the caller may see wins over one they
    /// may not, then one with the file. The winner lists the other instances it was merged with
    /// ("also in"), but only instances whose event the caller may see: a merged event the caller
    /// can't open never puts that instance's name on a row they can see.
    /// </summary>
    public static class CalendarDedup
    {
        /// <summary>
        /// A release date as a UTC calendar day: Sonarr/Radarr versions differ in precision and air date
        /// fallbacks, so the raw string would fail to match.
        /// </summary>
        public static string NormalizeDate(string? raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return string.Empty;
            if (DateTimeOffset.TryParse(raw, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var dto))
            {
                return dto.UtcDateTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            }
            // Fallback: strip everything after the first 10 chars when it already looks like an ISO date prefix.
            return raw.Length >= 10 ? raw.Substring(0, 10) : raw;
        }

        /// <summary>The de-duplication key of an event: source, title id, episode or release type, and day.</summary>
        public static string Key(ArrItem evt)
        {
            var day = NormalizeDate(evt.ReleaseDate);
            if (evt.Source == nameof(ArrType.Sonarr))
            {
                var seriesKey = evt.TvdbId?.ToString(CultureInfo.InvariantCulture) ?? $"title:{evt.Title}";
                return $"sonarr|{seriesKey}|S{evt.SeasonNumber}E{evt.EpisodeNumber}|{day}";
            }
            if (evt.Source == nameof(ArrType.Shoko))
            {
                // Never cross-matched against sonarr|/radarr| keys.
                return $"shoko|{evt.ShokoSeriesId}|{evt.ShokoEpisodeId}|{day}";
            }
            var movieKey = evt.TmdbId?.ToString(CultureInfo.InvariantCulture) ?? $"title:{evt.Title}";
            return $"radarr|{movieKey}|{evt.ReleaseType}|{day}";
        }

        /// <summary>Merges duplicate events, in order of first appearance.</summary>
        /// <param name="events">Events from every instance.</param>
        /// <param name="isAccessible">Whether the caller may see an event (always true for administrators or with the filter off).</param>
        public static List<ArrItem> Deduplicate(IEnumerable<ArrItem> events, Func<ArrItem, bool> isAccessible)
        {
            var deduped = new Dictionary<string, ArrItem>();
            var order = new List<string>();
            foreach (var evt in events)
            {
                var dedupeKey = Key(evt);
                if (!deduped.TryGetValue(dedupeKey, out var existing))
                {
                    deduped[dedupeKey] = evt;
                    order.Add(dedupeKey);
                    continue;
                }

                var existingAccess = isAccessible(existing);
                var newAccess = isAccessible(evt);
                ArrItem winner, loser;
                if (newAccess && !existingAccess)
                {
                    winner = evt; loser = existing;
                }
                else if (newAccess == existingAccess && !existing.HasFile && evt.HasFile)
                {
                    winner = evt; loser = existing;
                }
                else
                {
                    winner = existing; loser = evt;
                }

                if (!ReferenceEquals(winner, existing))
                {
                    deduped[dedupeKey] = winner;
                }

                // Only an event the caller may see adds its instance (and those it absorbed) to "also in".
                if (!isAccessible(loser)) continue;

                // Merge loser's instance name into winner's AlsoInInstances (dedup & skip self).
                if (!string.IsNullOrEmpty(loser.InstanceName)
                    && !string.Equals(loser.InstanceName, winner.InstanceName, StringComparison.Ordinal))
                {
                    winner.AlsoInInstances ??= new List<string>();
                    if (!winner.AlsoInInstances.Contains(loser.InstanceName))
                        winner.AlsoInInstances.Add(loser.InstanceName);
                }
                // Preserve loser's own AlsoInInstances entries too.
                if (loser.AlsoInInstances != null)
                {
                    winner.AlsoInInstances ??= new List<string>();
                    foreach (var name in loser.AlsoInInstances)
                    {
                        if (!string.Equals(name, winner.InstanceName, StringComparison.Ordinal)
                            && !winner.AlsoInInstances.Contains(name))
                            winner.AlsoInInstances.Add(name);
                    }
                }
            }
            return order.Select(k => deduped[k]).ToList();
        }
    }
}
