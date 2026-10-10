using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Import
{
    /// <summary>
    /// Turns a resolved candidate into the placeholder body POST /apply expects (the import review UI builds the same
    /// shape on the client; the linked-list sync uses this). releaseDate per kind follows C4: movie = release date,
    /// series = first air date, season = the season's air date, episodes = the first listed episode's air date
    /// (fallback: the season's).
    /// </summary>
    public static class ImportPlaceholders
    {
        /// <summary>Builds the placeholder for a candidate at the granularity the entry asked for.</summary>
        /// <param name="candidate">Chosen candidate.</param>
        /// <param name="kind">movie | series | season | episodes (null = from the candidate's media type).</param>
        /// <param name="season">Season (season/episodes).</param>
        /// <param name="episodes">Episode numbers (episodes).</param>
        /// <param name="note">Note.</param>
        /// <returns>The placeholder body, or null when the kind doesn't fit the candidate (a movie can't be a season).</returns>
        public static NewPlaceholderDto? FromCandidate(ImportCandidateDto candidate, string? kind, int? season, IReadOnlyList<int>? episodes, string? note)
        {
            kind ??= candidate.MediaType == "movie" ? PlaceholderKinds.Movie : PlaceholderKinds.Series;
            if ((candidate.MediaType == "movie") != (kind == PlaceholderKinds.Movie))
            {
                return null;
            }

            var dto = new NewPlaceholderDto
            {
                Kind = kind,
                MediaType = candidate.MediaType,
                TmdbId = candidate.TmdbId,
                TvdbId = candidate.MediaType == "tv" ? candidate.TvdbId : null,
                ImdbId = candidate.ImdbId,
                Title = candidate.Title,
                Year = candidate.Year,
                ReleaseDate = candidate.ReleaseDate,
                PosterPath = candidate.PosterPath,
                Overview = candidate.Overview,
                Note = note,
            };

            switch (kind)
            {
                case PlaceholderKinds.Series:
                    dto.EpisodeTotal = candidate.EpisodeTotal;
                    break;
                case PlaceholderKinds.Season:
                    if (!season.HasValue)
                    {
                        return null;
                    }

                    dto.SeasonNumber = season;
                    dto.ReleaseDate = candidate.Season?.AirDate;
                    dto.EpisodeTotal = candidate.Season?.EpisodeCount;
                    break;
                case PlaceholderKinds.Episodes:
                    if (!season.HasValue || episodes == null || episodes.Count == 0)
                    {
                        return null;
                    }

                    var info = (candidate.Episodes ?? new List<ImportEpisodeInfoDto>()).GroupBy(e => e.E).ToDictionary(g => g.Key, g => g.First());
                    dto.SeasonNumber = season;
                    dto.Episodes = episodes.Distinct().OrderBy(e => e).Select(e => new PlaceholderEpisode
                    {
                        S = season.Value,
                        E = e,
                        Title = info.TryGetValue(e, out var episode) ? episode.Title : null,
                        AirDate = info.TryGetValue(e, out var dated) ? dated.AirDate : null,
                    }).ToList();
                    dto.ReleaseDate = dto.Episodes[0].AirDate ?? candidate.Season?.AirDate;
                    break;
            }

            return dto;
        }
    }
}
