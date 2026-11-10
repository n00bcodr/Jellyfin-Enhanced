using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services
{
    /// <summary>
    /// The Status Tags schedule and milestone facts of one Series or Season,
    /// gathered from its non-virtual episodes in one pass: the newest aired
    /// episode and its numbers, the newest season's (or this season's) first
    /// air date, and, for a Season, when its episodes were added. Fed by the
    /// tag cache's container walk (every episode, filtered per user later
    /// through <see cref="TagCacheEntry.StatusEpisodeIds"/>) and by the
    /// /tag-data fallback (only the episodes the user can see), so both paths
    /// apply the same rules.
    /// </summary>
    public sealed class StatusTagsEpisodeFacts
    {
        private readonly bool _isSeason;
        private readonly int? _containerSeason;

        private DateTime? _latestAired;
        private Guid _latestAiredId;
        private int? _latestSeason;
        private int? _latestEpisode;

        // First air date per season (Series) or of the season (Season).
        private readonly Dictionary<int, (DateTime Aired, Guid Id)> _seasonFirstAired = new();

        private DateTime? _firstAdded;
        private DateTime? _lastAdded;
        private int _count;
        private int? _newestSeason;
        private bool _missingAdded;
        private readonly SortedSet<string> _allIds = new(StringComparer.Ordinal);
        private readonly Dictionary<int, int> _lastEpisodeBySeason = new();
        private readonly DateTime _now;
        private DateTime? _nextPremiere;

        // Season only: the episode numbers of the season itself the library covers, and whether they were read at all.
        private readonly HashSet<int> _covered = new();
        private bool _coverageUnknown;

        /// <summary>
        /// How far ahead of UTC the earliest time zone is (UTC+14). A premiere dated up to this far in the
        /// future is already today somewhere, so its season premiere is recorded and each viewer's local day
        /// decides (StatusRules.AiredWithin); latest-aired facts still wait for the UTC instant.
        /// </summary>
        internal static readonly TimeSpan EarliestDayLead = TimeSpan.FromHours(14);

        /// <param name="isSeason">Whether the container is a Season (else a Series).</param>
        /// <param name="containerSeason">The Season's own number, used when an episode has none.</param>
        public StatusTagsEpisodeFacts(bool isSeason, int? containerSeason, DateTime? now = null)
        {
            _now = now ?? DateTime.UtcNow;
            _isSeason = isSeason;
            _containerSeason = isSeason ? containerSeason : null;
        }

        /// <summary>
        /// Add one non-virtual episode of the container. Specials (season 0)
        /// only count towards the aired facts of a Specials season, so a special
        /// never makes a series look like it has a new season or episode.
        /// </summary>
        public void Note(Guid id, DateTime dateCreated, DateTime? premiereDate, int? seasonNumber, int? episodeNumber, int? episodeEnd = null)
        {
            _count++;
            _allIds.Add(id.ToString("N"));
            if (dateCreated == default) _missingAdded = true;
            if (dateCreated != default)
            {
                if (_firstAdded == null || dateCreated < _firstAdded)
                {
                    _firstAdded = dateCreated;
                }

                if (_lastAdded == null || dateCreated > _lastAdded)
                {
                    _lastAdded = dateCreated;
                }
            }

            var season = seasonNumber ?? _containerSeason;
            if (season is > 0) _newestSeason = Math.Max(_newestSeason ?? 0, season.Value);
            // A multi-episode file (IndexNumberEnd) covers its whole range, and its last episode is the one it ends
            // on (a combined E9–E10 file holds the finale E10); a range over 50 is not believed.
            var first = episodeNumber;
            if (first is > 0 && episodeEnd is { } rangeEnd && rangeEnd > first && rangeEnd - first <= 50) episodeNumber = rangeEnd;
            if (_isSeason && season == _containerSeason && first is > 0)
            {
                for (var number = first.Value; number <= episodeNumber!.Value; number++) _covered.Add(number);
            }
            if (season is { } numberedSeason && episodeNumber is { } numberedEpisode)
            {
                _lastEpisodeBySeason[numberedSeason] = Math.Max(_lastEpisodeBySeason.GetValueOrDefault(numberedSeason), numberedEpisode);
            }
            if (premiereDate is not { } aired || aired == default) return;
            if (!_isSeason && (season == null || season <= 0)) return;
            if (aired > _now)
            {
                // Refresh when the premiere's day first begins somewhere, then again at the instant itself.
                var early = aired - EarliestDayLead;
                var boundary = early > _now ? early : aired;
                if (_nextPremiere == null || boundary < _nextPremiere) _nextPremiere = boundary;
                if (aired <= _now + EarliestDayLead) NoteSeasonFirst(season, first, aired, id);
                return;
            }

            if (_latestAired == null
                || aired > _latestAired
                || (aired == _latestAired && Compare(season, episodeNumber, _latestSeason, _latestEpisode) > 0))
            {
                _latestAired = aired;
                _latestAiredId = id;
                _latestSeason = season;
                _latestEpisode = episodeNumber;
            }

            NoteSeasonFirst(season, first, aired, id);
        }

        private void NoteSeasonFirst(int? season, int? episodeNumber, DateTime aired, Guid id)
        {
            if (episodeNumber == 1 && season is { } s && (!_seasonFirstAired.TryGetValue(s, out var first) || aired < first.Aired))
            {
                _seasonFirstAired[s] = (aired, id);
            }
        }

        private static int Compare(int? seasonA, int? episodeA, int? seasonB, int? episodeB)
        {
            var bySeason = (seasonA ?? -1).CompareTo(seasonB ?? -1);
            return bySeason != 0 ? bySeason : (episodeA ?? -1).CompareTo(episodeB ?? -1);
        }

        /// <summary>
        /// Replace the added span with one measured without noting every episode
        /// (<see cref="StatusTagsEpisodeLookup"/>): the episode count, the oldest
        /// added date (unset when an episode has none) and the newest set one.
        /// </summary>
        internal void UseAddedSpan(int count, DateTime? oldest, DateTime? newest)
        {
            _count = count;
            _coverageUnknown = true;
            _missingAdded = oldest == default(DateTime);
            _firstAdded = oldest is { } o && o != default ? o : null;
            _lastAdded = newest;
        }

        /// <summary>Next instant the facts change (Unix ms), for time-driven refresh: a premiere's day starting somewhere, or its UTC instant.</summary>
        public long? NextPremiere => TagCacheService.ToUnixMilliseconds(_nextPremiere);

        /// <summary>Newest air date (Unix ms), or null.</summary>
        public long? LatestAired => TagCacheService.ToUnixMilliseconds(_latestAired);

        /// <summary>The newest aired episode's numbers, when it has both.</summary>
        public TagEpisodeIndex? LatestIndex =>
            _latestAired != null && _latestSeason is { } s && _latestEpisode is { } e ? new TagEpisodeIndex { Season = s, Episode = e, IsLast = _lastEpisodeBySeason.GetValueOrDefault(s) == e } : null;

        /// <summary>
        /// Series: the highest season with an aired episode and its first air date.
        /// Season: its own number and first air date.
        /// </summary>
        public TagSeasonPremiere? SeasonPremiere
        {
            get
            {
                if (_seasonFirstAired.Count == 0) return null;
                var season = _isSeason && _containerSeason is { } own && _seasonFirstAired.ContainsKey(own)
                    ? own
                    : _newestSeason ?? _seasonFirstAired.Keys.Max();
                if (!_seasonFirstAired.ContainsKey(season)) return null;
                var aired = TagCacheService.ToUnixMilliseconds(_seasonFirstAired[season].Aired);
                return aired is { } ms ? new TagSeasonPremiere { Season = season, Aired = ms } : null;
            }
        }

        /// <summary>Season only: first/newest added date and episode count, or null.</summary>
        public TagAddedSpan? AddedSpan =>
            _isSeason && !_missingAdded && TagCacheService.ToUnixMilliseconds(_firstAdded) is { } first && TagCacheService.ToUnixMilliseconds(_lastAdded) is { } last
                ? new TagAddedSpan { First = first, Last = last, Count = _count, CoveredThrough = _coverageUnknown ? null : CoveredThrough() }
                : null;

        private int CoveredThrough()
        {
            var through = 0;
            while (_covered.Contains(through + 1)) through++;
            return through;
        }

        /// <summary>
        /// The episodes the facts came from (N format, sorted, distinct), for the
        /// per-user filter; null when there are no facts.
        /// </summary>
        public string[]? SourceIds
        {
            get
            {
                var ids = new SortedSet<string>(StringComparer.Ordinal);
                if (_latestAired != null) ids.Add(_latestAiredId.ToString("N"));
                if (SeasonPremiere is { } premiere) ids.Add(_seasonFirstAired[premiere.Season].Id.ToString("N"));
                // Every episode contributes to the count, even one in the middle.
                ids.UnionWith(_allIds);

                return ids.Count > 0 ? ids.ToArray() : null;
            }
        }

        /// <summary>Write the facts into a Series/Season entry (null fields clear).</summary>
        public void ApplyTo(TagCacheEntry entry)
        {
            entry.NextEpisodePremiere = NextPremiere;
            entry.LatestEpisodeAired = LatestAired;
            entry.LatestEpisodeIndex = LatestIndex;
            entry.SeasonPremiere = SeasonPremiere;
            entry.SeasonAddedSpan = AddedSpan;
            entry.StatusEpisodeIds = SourceIds;
        }
    }
}
