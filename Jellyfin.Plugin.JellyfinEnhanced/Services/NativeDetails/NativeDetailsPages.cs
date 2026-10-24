#if JF12
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails
{
    /// <summary>
    /// Turns a synthetic page id into the absent-title page the Requests &amp; downloads routes work
    /// with (status, season rows): the title's provider key (TVDB for a series when Seerr names one)
    /// and its public season and episode facts, under the native details page's own viewer rules.
    /// </summary>
    public sealed class NativeDetailsPages : IAbsentTitlePages
    {
        private readonly IUserManager _users;
        private readonly IServerApplicationHost _host;
        private readonly INativeDetailsSource _source;
        private readonly NativeDetailsPolicy _policy;
        private readonly SpoilerUserResolver? _spoilerUsers;
        private readonly Func<DateTime> _now;

        /// <summary>Creates the resolver.</summary>
        public NativeDetailsPages(IUserManager users, IServerApplicationHost host, INativeDetailsSource source, NativeDetailsPolicy policy, SpoilerUserResolver? spoilerUsers = null)
            : this(users, host, source, policy, () => DateTime.UtcNow, spoilerUsers)
        {
        }

        /// <summary>Creates the resolver with a clock (tests).</summary>
        internal NativeDetailsPages(IUserManager users, IServerApplicationHost host, INativeDetailsSource source, NativeDetailsPolicy policy, Func<DateTime> now, SpoilerUserResolver? spoilerUsers = null)
        {
            _users = users;
            _host = host;
            _source = source;
            _policy = policy;
            _now = now;
            _spoilerUsers = spoilerUsers;
        }

        /// <inheritdoc />
        public async Task<AbsentPageResult> ResolveAsync(Guid viewerId, Guid id, CancellationToken ct)
        {
            var serverId = _host.SystemId;
            if (!SyntheticId.TryParse(id, serverId, out var page)) return AbsentPageResult.NotAbsent;
            if (page.Kind == SyntheticKind.Person) return AbsentPageResult.Refused;
            var viewer = _users.GetUserById(viewerId);
            if (viewer == null) return AbsentPageResult.Refused;
            switch (await _policy.SeeAsync(viewer, page, ct).ConfigureAwait(false))
            {
                case NativeDetailsPolicy.Access.Refused:
                    return AbsentPageResult.Refused;
                case NativeDetailsPolicy.Access.Unknown:
                    return AbsentPageResult.Unavailable;
            }

            if (page.IsMovie)
            {
                var movie = await _source.MovieAsync(page.TmdbId, viewerId, ct).ConfigureAwait(false);
                if (movie.Data == null) return movie.NotFound ? AbsentPageResult.Refused : AbsentPageResult.Unavailable;
                return Found(new AbsentTitle
                {
                    PageId = id,
                    Kind = "movie",
                    Title = TitleKey.Parse("movie:tmdb:" + page.TmdbId.ToString(CultureInfo.InvariantCulture))!,
                    TmdbId = page.TmdbId,
                });
            }

            var answer = await _source.SeriesAsync(page.TmdbId, viewerId, ct).ConfigureAwait(false);
            if (answer.Data is not { } series) return answer.NotFound ? AbsentPageResult.Refused : AbsentPageResult.Unavailable;
            var key = SeriesKey(series, page.TmdbId);
            var seriesPage = page.SeriesId.ToGuid(serverId);
            // Seasons and episodes the library has but hides from this viewer are left out (no status, row or ask);
            // a series page also names those of every season, so a Sonarr's states of them never reach its status.
            var physical = page.Kind == SyntheticKind.Series ? _policy.Physical(viewer, false, page.TmdbId, null, everySeason: true) : _policy.Physical(viewer, page);
            if (physical.Hides(page)) return AbsentPageResult.Refused;
            var seasons = SeasonsOf(series, page.TmdbId, serverId, _now()).Where(s => !physical.HiddenSeasons.Contains(s.Season)).ToList();
            var hiddenSeasons = physical.HiddenSeasons.OrderBy(n => n).ToArray();
            switch (page.Kind)
            {
                case SyntheticKind.Series:
                    return Found(new AbsentTitle
                    {
                        PageId = id, Kind = "series", Title = key, TmdbId = page.TmdbId, Seasons = seasons, HiddenSeasons = hiddenSeasons,
                        HiddenSeriesEpisodes = physical.HiddenSeriesEpisodes.OrderBy(p => p.Season).ThenBy(p => p.Episode).ToArray(),
                    });
                case SyntheticKind.Season:
                case SyntheticKind.Episode:
                    if (!seasons.Any(s => s.Season == page.Season)) return AbsentPageResult.Refused;
                    var season = await _source.SeasonAsync(page.TmdbId, page.Season, viewerId, ct).ConfigureAwait(false);
                    if (season.Data is not { } data) return season.NotFound ? AbsentPageResult.Refused : AbsentPageResult.Unavailable;
                    var episodes = EpisodesOf(data, page.TmdbId, page.Season, serverId).Where(e => !physical.HiddenEpisodes.Contains(e.Episode)).ToList();
                    if (page.Kind == SyntheticKind.Episode && !episodes.Any(e => e.Episode == page.Episode)) return AbsentPageResult.Refused;
                    return Found(new AbsentTitle
                    {
                        PageId = id,
                        Kind = page.Kind == SyntheticKind.Season ? "season" : "episode",
                        Title = key,
                        TmdbId = page.TmdbId,
                        Season = page.Season,
                        Episode = page.Kind == SyntheticKind.Episode ? page.Episode : null,
                        SeriesPageId = seriesPage,
                        Episodes = episodes,
                        HiddenEpisodes = physical.HiddenEpisodes.OrderBy(n => n).ToArray(),
                        HiddenSeasons = hiddenSeasons,
                        Spoilers = RowSpoilers(viewer, page),
                        // The facade lists a season's episodes as rows exactly when the viewer shows missing episodes.
                        Rows = viewer.DisplayMissingEpisodes,
                    });
                default:
                    return AbsentPageResult.Refused;
            }
        }

        /// <summary>What Spoiler Guard leaves out of the season's rows for this viewer, or null when they don't guard the title.</summary>
        private AbsentRowSpoilers? RowSpoilers(Jellyfin.Database.Implementations.Entities.User viewer, SyntheticId page)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || NativeDetailsSpoilers.Guarded(_spoilerUsers, _policy, null, viewer, page) is not { } state) return null;
            var (title, overview, airDate) = SpoilerFieldStripFilter.AbsentRowStrip(state, config);
            return new AbsentRowSpoilers(title, overview, airDate);
        }

        /// <summary>The series key: TVDB when Seerr names it (the key Sonarr and the change feed use), else TMDB.</summary>
        /// <param name="series">Seerr's series details.</param>
        /// <param name="tmdb">TMDB id.</param>
        /// <returns>Key.</returns>
        internal static TitleKey SeriesKey(JsonElement series, int tmdb)
        {
            var tvdb = NativeDetailsDtos.Int(NativeDetailsDtos.Obj(series, "externalIds"), "tvdbId");
            return TitleKey.Parse(tvdb is int t && t > 0
                ? "tv:tvdb:" + t.ToString(CultureInfo.InvariantCulture)
                : "tv:tmdb:" + tmdb.ToString(CultureInfo.InvariantCulture))!;
        }

        /// <summary>
        /// The series' seasons with how many of their episodes have aired: every episode of a season
        /// before the last aired one's, that one's up to its episode, none after (or, without that
        /// fact, every episode of a season that has started).
        /// </summary>
        internal static IReadOnlyList<AbsentSeason> SeasonsOf(JsonElement series, int tmdb, string serverId, DateTime now)
        {
            var last = NativeDetailsDtos.Obj(series, "lastEpisodeToAir");
            var lastSeason = NativeDetailsDtos.Int(last, "seasonNumber");
            var lastEpisode = NativeDetailsDtos.Int(last, "episodeNumber");
            var list = new List<AbsentSeason>();
            foreach (var s in NativeDetailsDtos.Seasons(series))
            {
                var number = NativeDetailsDtos.Int(s, "seasonNumber") ?? 0;
                var count = Math.Max(0, NativeDetailsDtos.Int(s, "episodeCount") ?? 0);
                var air = Date(NativeDetailsDtos.Str(s, "airDate"));
                int aired;
                if (lastSeason is int ls && lastEpisode is int le && number > 0)
                {
                    aired = number < ls ? count : number == ls ? Math.Min(count, le) : 0;
                }
                else
                {
                    aired = air is DateTime d && d <= now ? count : 0;
                }

                list.Add(new AbsentSeason(number, count, aired, air, SyntheticId.SeasonOf(tmdb, number).ToGuid(serverId)));
            }

            return list;
        }

        /// <summary>A season's episodes with their air dates and page ids.</summary>
        internal static IReadOnlyList<AbsentEpisode> EpisodesOf(JsonElement season, int tmdb, int number, string serverId)
            => NativeDetailsDtos.Episodes(season)
                .Select(e => (Number: NativeDetailsDtos.Int(e, "episodeNumber") ?? 0, Air: Date(NativeDetailsDtos.Str(e, "airDate"))))
                .Where(e => e.Number > 0)
                .Select(e => new AbsentEpisode(number, e.Number, e.Air, SyntheticId.EpisodeOf(tmdb, number, e.Number).ToGuid(serverId)))
                .ToList();

        private static DateTime? Date(string? text)
            => DateTime.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var d) ? d : null;

        private static AbsentPageResult Found(AbsentTitle title) => new(AbsentLookup.Found, title);
    }
}
#endif
