using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>
    /// Validation, normalisation and identity of list entries (placeholders): kinds, ids, dates, season/episode scope,
    /// edition, text limits and the canonical request input a list ask uses. Custom and future/TBA entries are valid
    /// list entries; being in a list never makes a title requestable on its own.
    /// </summary>
    public static class ListRules
    {
        /// <summary>Maximum title length.</summary>
        public const int MaxTitle = 200;

        /// <summary>Maximum overview length (longer overviews are cut).</summary>
        public const int MaxOverview = 1000;

        /// <summary>Maximum note length.</summary>
        public const int MaxNote = 300;

        /// <summary>Maximum listed episodes of one episodes placeholder.</summary>
        public const int MaxEpisodes = 100;

        /// <summary>The standard edition (stored as no value).</summary>
        public const string Standard = "standard";

        /// <summary>The 4K edition.</summary>
        public const string FourK = "4k";

        private static readonly Regex ImdbRegex = new(@"^tt[0-9]{5,10}\z", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex PosterRegex = new(@"^/[A-Za-z0-9_-]+\.(jpg|png)\z", RegexOptions.Compiled | RegexOptions.CultureInvariant);

        /// <summary>
        /// Validates client input and builds a placeholder. Returns false with a short reason on invalid input.
        /// </summary>
        /// <param name="dto">Client input.</param>
        /// <param name="addedByN">Calling user ("N").</param>
        /// <param name="nowUtc">Current time.</param>
        /// <param name="placeholder">The new placeholder (fresh id).</param>
        /// <param name="error">Why the input was rejected.</param>
        /// <returns>Whether the input is valid.</returns>
        public static bool TryCreate(NewPlaceholderDto? dto, string addedByN, DateTime nowUtc, out Placeholder placeholder, out string error)
        {
            placeholder = null!;
            if (!TryNormalize(dto, allowCustom: true, out var normalized, out error))
            {
                return false;
            }

            normalized.Id = Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture);
            normalized.AddedBy = addedByN;
            normalized.AddedAt = nowUtc.ToString("o", CultureInfo.InvariantCulture);
            placeholder = normalized;
            return true;
        }

        /// <summary>Validates and normalises title data (kind, ids, dates, season/episodes) without id/provenance.</summary>
        /// <param name="dto">Client input.</param>
        /// <param name="allowCustom">Whether kind "custom" is acceptable (not when linking).</param>
        /// <param name="placeholder">Normalised data.</param>
        /// <param name="error">Why the input was rejected.</param>
        /// <returns>Whether the input is valid.</returns>
        public static bool TryNormalize(NewPlaceholderDto? dto, bool allowCustom, out Placeholder placeholder, out string error)
        {
            placeholder = null!;
            error = string.Empty;
            if (dto == null)
            {
                error = "placeholder is required";
                return false;
            }

            var kind = dto.Kind?.Trim().ToLowerInvariant();
            if (!PlaceholderKinds.IsKnown(kind) || (!allowCustom && kind == PlaceholderKinds.Custom))
            {
                error = "unknown kind";
                return false;
            }

            var mediaType = dto.MediaType?.Trim().ToLowerInvariant();
            switch (kind)
            {
                case PlaceholderKinds.Movie:
                    if (mediaType != null && mediaType != "movie")
                    {
                        error = "a movie placeholder has mediaType movie";
                        return false;
                    }

                    mediaType = "movie";
                    break;
                case PlaceholderKinds.Custom:
                    mediaType ??= "movie";
                    if (mediaType is not ("movie" or "tv"))
                    {
                        error = "mediaType must be movie or tv";
                        return false;
                    }

                    break;
                default:
                    if (mediaType != null && mediaType != "tv")
                    {
                        error = "series, season and episodes placeholders have mediaType tv";
                        return false;
                    }

                    mediaType = "tv";
                    break;
            }

            if (kind == PlaceholderKinds.Custom)
            {
                if (dto.TmdbId.HasValue)
                {
                    error = "custom entries have no tmdbId";
                    return false;
                }
            }
            else if (dto.TmdbId is not > 0)
            {
                error = "tmdbId is required";
                return false;
            }

            if (dto.TvdbId.HasValue && (dto.TvdbId <= 0 || mediaType != "tv"))
            {
                error = "invalid tvdbId";
                return false;
            }

            var imdb = string.IsNullOrWhiteSpace(dto.ImdbId) ? null : dto.ImdbId.Trim();
            if (imdb != null && !ImdbRegex.IsMatch(imdb))
            {
                error = "invalid imdbId";
                return false;
            }

            var title = CleanText(dto.Title);
            if (title.Length == 0 || title.Length > MaxTitle)
            {
                error = "title must be 1-200 characters";
                return false;
            }

            if (dto.Year.HasValue && (dto.Year < 1870 || dto.Year > 2100))
            {
                error = "invalid year";
                return false;
            }

            var releaseDate = string.IsNullOrWhiteSpace(dto.ReleaseDate) ? null : dto.ReleaseDate.Trim();
            if (releaseDate != null && !TryParseDate(releaseDate, out _))
            {
                error = "releaseDate must be yyyy-MM-dd";
                return false;
            }

            var poster = string.IsNullOrWhiteSpace(dto.PosterPath) ? null : dto.PosterPath.Trim();
            if (poster != null && !PosterRegex.IsMatch(poster))
            {
                error = "invalid posterPath";
                return false;
            }

            var overview = CleanText(dto.Overview);
            if (overview.Length > MaxOverview)
            {
                overview = overview[..MaxOverview];
            }

            var note = CleanText(dto.Note);
            if (note.Length > MaxNote)
            {
                error = "note must be at most 300 characters";
                return false;
            }

            var seasonKind = kind is PlaceholderKinds.Season or PlaceholderKinds.Episodes;
            if (seasonKind)
            {
                if (dto.SeasonNumber is not (>= 0 and <= 200))
                {
                    error = "seasonNumber 0-200 is required";
                    return false;
                }
            }
            else if (dto.SeasonNumber.HasValue)
            {
                error = "seasonNumber only applies to season and episodes placeholders";
                return false;
            }

            var episodes = new List<PlaceholderEpisode>();
            if (kind == PlaceholderKinds.Episodes)
            {
                if (dto.Episodes == null || dto.Episodes.Count == 0)
                {
                    error = "episodes are required";
                    return false;
                }

                // Checked before the loop: the input itself is bounded, not just the de-duplicated result.
                if (dto.Episodes.Count > MaxEpisodes)
                {
                    error = "at most 100 episodes per placeholder";
                    return false;
                }

                var seen = new HashSet<int>();
                foreach (var episode in dto.Episodes)
                {
                    if (episode == null || episode.S != dto.SeasonNumber)
                    {
                        // C2: one placeholder never spans seasons; clients split cross-season selections.
                        error = "all episodes must belong to seasonNumber";
                        return false;
                    }

                    if (episode.E < 0 || episode.E > 9999)
                    {
                        error = "invalid episode number";
                        return false;
                    }

                    var airDate = string.IsNullOrWhiteSpace(episode.AirDate) ? null : episode.AirDate.Trim();
                    if (airDate != null && !TryParseDate(airDate, out _))
                    {
                        error = "episode airDate must be yyyy-MM-dd";
                        return false;
                    }

                    if (!seen.Add(episode.E))
                    {
                        continue;
                    }

                    var episodeTitle = CleanText(episode.Title);

                    episodes.Add(new PlaceholderEpisode
                    {
                        S = episode.S,
                        E = episode.E,
                        Title = episodeTitle.Length == 0 ? null : episodeTitle.Length > MaxTitle ? episodeTitle[..MaxTitle] : episodeTitle,
                        AirDate = airDate,
                    });
                }

                episodes.Sort((a, b) => a.E.CompareTo(b.E));
            }
            else if (dto.Episodes is { Count: > 0 })
            {
                error = "episodes only apply to episodes placeholders";
                return false;
            }

            int? episodeTotal = null;
            if (dto.EpisodeTotal.HasValue && kind is PlaceholderKinds.Season or PlaceholderKinds.Series)
            {
                if (dto.EpisodeTotal < 0 || dto.EpisodeTotal > 10000)
                {
                    error = "invalid episodeTotal";
                    return false;
                }

                episodeTotal = dto.EpisodeTotal;
            }

            var edition = string.IsNullOrWhiteSpace(dto.Edition) ? Standard : dto.Edition.Trim().ToLowerInvariant();
            if (edition is not (Standard or FourK) || (kind == PlaceholderKinds.Custom && edition != Standard))
            {
                error = "edition must be standard or 4k (custom entries: standard)";
                return false;
            }

            placeholder = new Placeholder
            {
                Kind = kind!,
                Edition = edition == Standard ? null : edition,
                MediaType = mediaType,
                TmdbId = kind == PlaceholderKinds.Custom ? null : dto.TmdbId,
                TvdbId = dto.TvdbId,
                ImdbId = imdb,
                Title = title,
                Year = dto.Year,
                ReleaseDate = releaseDate,
                PosterPath = poster,
                Overview = overview.Length == 0 ? null : overview,
                SeasonNumber = seasonKind ? dto.SeasonNumber : null,
                Episodes = episodes,
                EpisodeTotal = episodeTotal,
                Note = note.Length == 0 ? null : note,
            };
            return true;
        }

        /// <summary>
        /// The dedupe identity of a placeholder: <c>kind|mediaType|tmdbId|season|episodes</c>, or
        /// <c>custom|mediaType|normalized title|year</c> for custom entries.
        /// </summary>
        /// <param name="placeholder">Placeholder.</param>
        /// <returns>Identity key.</returns>
        public static string IdentityKey(Placeholder placeholder)
        {
            if (placeholder.Kind == PlaceholderKinds.Custom)
            {
                return string.Join('|', "custom", placeholder.MediaType, NormalizeTitle(placeholder.Title), placeholder.Year?.ToString(CultureInfo.InvariantCulture) ?? string.Empty);
            }

            var episodes = string.Join(',', placeholder.Episodes.Select(e => e.E).OrderBy(e => e).Select(e => e.ToString(CultureInfo.InvariantCulture)));
            var key = string.Join(
                '|',
                placeholder.Kind,
                placeholder.MediaType,
                placeholder.TmdbId?.ToString(CultureInfo.InvariantCulture) ?? string.Empty,
                placeholder.SeasonNumber?.ToString(CultureInfo.InvariantCulture) ?? string.Empty,
                episodes);
            // Standard keeps the schema-1 identity, so imported entries match their own duplicates.
            return EditionOf(placeholder) == FourK ? key + "|4k" : key;
        }

        /// <summary>The entry's edition: <see cref="Standard"/> or <see cref="FourK"/>.</summary>
        /// <param name="placeholder">Entry.</param>
        /// <returns>The edition.</returns>
        public static string EditionOf(Placeholder placeholder) => placeholder.Edition == FourK ? FourK : Standard;

        /// <summary>
        /// The title key requests and status use for an entry: a movie by TMDB id (else IMDb); a show by TVDB id, else
        /// TMDB, else IMDb (the way the request ledger keys shows). Null for custom entries and entries without an id.
        /// </summary>
        /// <param name="placeholder">Entry.</param>
        /// <returns>The key or null.</returns>
        public static TitleKey? TitleKeyOf(Placeholder placeholder)
        {
            if (placeholder.Kind == PlaceholderKinds.Custom)
            {
                return null;
            }

            var tmdb = placeholder.TmdbId is > 0 ? placeholder.TmdbId.Value.ToString(CultureInfo.InvariantCulture) : null;
            return placeholder.MediaType == "movie"
                ? TitleKey.ForMovie(tmdb, placeholder.ImdbId)
                : TitleKey.ForSeries(placeholder.TvdbId is > 0 ? placeholder.TvdbId.Value.ToString(CultureInfo.InvariantCulture) : null, tmdb, placeholder.ImdbId);
        }

        /// <summary>
        /// The request a list ask makes for an entry, in its exact scope and edition: a movie; a season; the listed
        /// episodes of one season (exact: in Seerr households the Seerr backend rounds them to their season); a whole
        /// series as its regular seasons (<paramref name="seriesSeasons"/>, from the entry's metadata). Null when the
        /// entry can't be asked for as such (custom, no id, a series whose seasons aren't known yet).
        /// </summary>
        /// <param name="placeholder">Entry.</param>
        /// <param name="seriesSeasons">A whole series: its regular season numbers (null: from the entry's expected episodes).</param>
        /// <returns>The input or null.</returns>
        public static MutationInput? RequestInput(Placeholder placeholder, IReadOnlyCollection<int>? seriesSeasons = null)
        {
            var key = TitleKeyOf(placeholder);
            if (key == null)
            {
                return null;
            }

            var variant = EditionOf(placeholder);
            MutationInput input;
            switch (placeholder.Kind)
            {
                case PlaceholderKinds.Movie:
                    input = new MutationInput { Key = key.ToString(), Scope = "movie", Variant = variant };
                    break;
                case PlaceholderKinds.Season when placeholder.SeasonNumber is int season:
                    input = new MutationInput { Key = key.ToString(), Scope = "seasons", Variant = variant, Seasons = new[] { season } };
                    break;
                case PlaceholderKinds.Episodes when placeholder.SeasonNumber is int season && placeholder.Episodes.Count > 0:
                    input = new MutationInput
                    {
                        Key = key.ToString(),
                        Scope = "episodes",
                        Variant = variant,
                        Episodes = placeholder.Episodes.Where(e => e.E >= 1).Select(e => new RequestEpisode(season, e.E)).ToArray(),
                    };
                    break;
                case PlaceholderKinds.Series:
                    if (seriesSeasons == null && !PlaceholderProgress.HasCompleteExpected(placeholder)) return null;
                    var seasons = (seriesSeasons ?? placeholder.Expected.Select(e => e.S).ToList()).Where(s => s >= 1).Distinct().OrderBy(s => s).ToArray();
                    if (seasons.Length == 0)
                    {
                        return null;
                    }

                    input = new MutationInput { Key = key.ToString(), Scope = "seasons", Variant = variant, Seasons = seasons };
                    break;
                default:
                    return null;
            }

            return input.Normalize();
        }

        /// <summary>True when <paramref name="posterPath"/> is a TMDB poster path JE accepts (e.g. <c>/abc.jpg</c>).</summary>
        /// <param name="posterPath">Candidate path.</param>
        /// <returns>Whether it is valid.</returns>
        public static bool IsValidPosterPath(string? posterPath) => posterPath != null && PosterRegex.IsMatch(posterPath);

        /// <summary>True when the placeholder's release date is today or earlier (UTC). TBA = not released.</summary>
        /// <param name="placeholder">Placeholder.</param>
        /// <param name="todayUtc">Today (UTC).</param>
        /// <returns>Whether it is released.</returns>
        public static bool IsReleased(Placeholder placeholder, DateTime todayUtc) =>
            placeholder.ReleaseDate != null && TryParseDate(placeholder.ReleaseDate, out var date) && date.Date <= todayUtc.Date;

        /// <summary>Parses an exact yyyy-MM-dd date.</summary>
        /// <param name="value">Text.</param>
        /// <param name="date">Parsed date.</param>
        /// <returns>Whether it parsed.</returns>
        public static bool TryParseDate(string value, out DateTime date) =>
            DateTime.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out date);

        /// <summary>Lowercase, punctuation-free, single-spaced title for comparisons.</summary>
        /// <param name="title">Title.</param>
        /// <returns>Normalised title.</returns>
        public static string NormalizeTitle(string? title)
        {
            var builder = new StringBuilder();
            var lastSpace = true;
            foreach (var c in (title ?? string.Empty).Normalize(NormalizationForm.FormKD))
            {
                if (char.IsLetterOrDigit(c))
                {
                    builder.Append(char.ToLowerInvariant(c));
                    lastSpace = false;
                }
                else if (char.IsWhiteSpace(c) || char.IsPunctuation(c) || char.IsSymbol(c))
                {
                    if (!lastSpace)
                    {
                        builder.Append(' ');
                        lastSpace = true;
                    }
                }
            }

            return builder.ToString().Trim();
        }

        /// <summary>Trims and strips control/format characters from user text.</summary>
        /// <param name="value">Text.</param>
        /// <returns>Clean text ("" for null).</returns>
        public static string CleanText(string? value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return string.Empty;
            }

            var builder = new StringBuilder(value.Length);
            foreach (var c in value)
            {
                var category = char.GetUnicodeCategory(c);
                if (c == '\n' || c == '\t')
                {
                    builder.Append(' ');
                }
                else if (category is not (UnicodeCategory.Control or UnicodeCategory.Format))
                {
                    builder.Append(c);
                }
            }

            return builder.ToString().Trim();
        }
    }
}
