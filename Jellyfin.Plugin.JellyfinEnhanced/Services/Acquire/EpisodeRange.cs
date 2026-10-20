using System;
using System.Collections.Generic;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>
    /// The full inclusive range of a Jellyfin multi-episode file. A missing or reversed end means
    /// one episode. Privacy checks must never drop the tail of a combined file.
    /// </summary>
    internal readonly record struct EpisodeRange(int First, int? End)
    {
        /// <summary>
        /// Maximum synthetic rows per file when no episode list supplies the numbers. This only
        /// bounds discovery/output; visibility and matching always use full-range membership.
        /// </summary>
        public const int MaxSyntheticEpisodes = 256;

        /// <summary>The last covered number, with an invalid end reduced to the first.</summary>
        public int Last => End is int last && last >= First ? last : First;

        /// <summary>Whether the file covers this episode, without expanding its range.</summary>
        public bool Contains(int number) => number >= First && number <= Last;

        /// <summary>At most the requested number of rows, without overflowing at int.MaxValue.</summary>
        public IEnumerable<int> Numbers(int limit)
        {
            var last = Math.Min((long)Last, (long)First + Math.Max(0, limit) - 1);
            for (long number = First; number <= last; number++) yield return (int)number;
        }
    }

    /// <summary>
    /// Episode coverage stored as disjoint intervals per season. Membership, subtraction and
    /// counts depend on the number of files, never on a Jellyfin-supplied range's length.
    /// </summary>
    internal sealed class EpisodeCoverage
    {
        private readonly Dictionary<int, List<EpisodeRange>> _seasons = new();

        /// <summary>Combines file ranges, optionally subtracting all ranges visible to the viewer.</summary>
        public EpisodeCoverage(IEnumerable<JfEpisode> episodes, IEnumerable<JfEpisode>? shown = null)
        {
            var visible = (shown ?? Array.Empty<JfEpisode>()).GroupBy(e => e.Season)
                .ToDictionary(g => g.Key, g => Union(g.Select(e => new EpisodeRange(e.Episode, e.EpisodeEnd))));
            foreach (var group in episodes.GroupBy(e => e.Season))
            {
                var ranges = Union(group.Select(e => new EpisodeRange(e.Episode, e.EpisodeEnd)));
                if (visible.TryGetValue(group.Key, out var cuts))
                {
                    var remaining = new List<EpisodeRange>();
                    foreach (var range in ranges)
                    {
                        long first = range.First;
                        foreach (var cut in cuts)
                        {
                            if (cut.Last < first) continue;
                            if (cut.First > range.Last) break;
                            if (cut.First > first) remaining.Add(new EpisodeRange((int)first, cut.First - 1));
                            first = Math.Max(first, (long)cut.Last + 1);
                            if (first > range.Last) break;
                        }
                        if (first <= range.Last) remaining.Add(new EpisodeRange((int)first, range.Last));
                    }
                    ranges = remaining;
                }
                _seasons[group.Key] = ranges;
            }
        }

        /// <summary>Whether any retained range covers the episode.</summary>
        public bool Contains((int Season, int Episode) number)
            => _seasons.TryGetValue(number.Season, out var ranges) && ranges.Any(r => r.Contains(number.Episode));

        /// <summary>Exact count for a season, using a wider integer for pathological metadata.</summary>
        public long CountInSeason(int season)
            => _seasons.TryGetValue(season, out var ranges) ? ranges.Sum(r => (long)r.Last - r.First + 1) : 0;

        /// <summary>Total coverage, without enumerating numbers.</summary>
        public long Count => _seasons.Keys.Sum(CountInSeason);

        /// <summary>The retained ranges as numbers-only episodes (one per range), to combine coverages.</summary>
        public IEnumerable<JfEpisode> Ranges()
            => _seasons.SelectMany(s => s.Value.Select(r => new JfEpisode { Season = s.Key, Episode = r.First, EpisodeEnd = r.Last }));

        private static List<EpisodeRange> Union(IEnumerable<EpisodeRange> source)
        {
            var result = new List<EpisodeRange>();
            foreach (var range in source.OrderBy(r => r.First))
            {
                if (result.Count == 0 || (long)range.First > (long)result[^1].Last + 1) result.Add(range);
                else result[^1] = new EpisodeRange(result[^1].First, Math.Max(result[^1].Last, range.Last));
            }
            return result;
        }
    }
}
