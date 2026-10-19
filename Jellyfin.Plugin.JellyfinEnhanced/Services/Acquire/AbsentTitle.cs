using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>One season of a title that isn't in the library, from public metadata.</summary>
    /// <param name="Season">Season number.</param>
    /// <param name="Episodes">Episodes the season has.</param>
    /// <param name="Aired">Episodes of it that have aired.</param>
    /// <param name="AirDate">First air date, when known.</param>
    /// <param name="PageId">The season's page id (a synthetic id; never a library item).</param>
    public readonly record struct AbsentSeason(int Season, int Episodes, int Aired, DateTime? AirDate, Guid PageId);

    /// <summary>One episode of a title that isn't in the library, from public metadata.</summary>
    /// <param name="Season">Season number.</param>
    /// <param name="Episode">Episode number.</param>
    /// <param name="AirDate">Air date, when known.</param>
    /// <param name="PageId">The episode's page id (a synthetic id; never a library item).</param>
    public readonly record struct AbsentEpisode(int Season, int Episode, DateTime? AirDate, Guid PageId);

    /// <summary>
    /// Spoiler Guard on an absent title for the viewer: what its episode rows leave out (their stills
    /// always). Never a reason to show more than without it.
    /// </summary>
    /// <param name="Title">Episode titles.</param>
    /// <param name="Overview">Episode overviews.</param>
    /// <param name="AirDate">Air dates.</param>
    public readonly record struct AbsentRowSpoilers(bool Title, bool Overview, bool AirDate);

    /// <summary>
    /// A details page of a title, season or episode that isn't in the library (the native details
    /// facade, Jellyfin 12 web). It names the title by provider key and carries the public season and
    /// episode facts its status needs; its ids are page ids, never evidence that a copy exists.
    /// </summary>
    public sealed class AbsentTitle
    {
        /// <summary>The page id the status is asked for.</summary>
        public Guid PageId { get; init; }

        /// <summary>movie, series, season or episode.</summary>
        public string Kind { get; init; } = "movie";

        /// <summary>The movie or series key (TVDB for a series when known, else TMDB).</summary>
        public TitleKey Title { get; init; } = null!;

        /// <summary>The series' page id (season and episode pages).</summary>
        public Guid? SeriesPageId { get; init; }

        /// <summary>TMDB id of the movie or series.</summary>
        public int TmdbId { get; init; }

        /// <summary>Season number (season and episode pages).</summary>
        public int? Season { get; init; }

        /// <summary>Episode number (episode pages).</summary>
        public int? Episode { get; init; }

        /// <summary>The series' seasons (series pages).</summary>
        public IReadOnlyList<AbsentSeason> Seasons { get; init; } = Array.Empty<AbsentSeason>();

        /// <summary>The season's episodes (season pages).</summary>
        public IReadOnlyList<AbsentEpisode> Episodes { get; init; } = Array.Empty<AbsentEpisode>();

        /// <summary>The page lists the season's episodes as rows (the viewer shows missing episodes).</summary>
        public bool Rows { get; init; }

        /// <summary>
        /// Episode numbers of the season the library has but hides from the viewer: never shown as an
        /// absent row (they are not in <see cref="Episodes"/> either).
        /// </summary>
        public IReadOnlyCollection<int> HiddenEpisodes { get; init; } = Array.Empty<int>();

        /// <summary>
        /// Season numbers the library has but hides from the viewer as a whole: never listed, counted
        /// or followed on the page (they are not in <see cref="Seasons"/> either).
        /// </summary>
        public IReadOnlyCollection<int> HiddenSeasons { get; init; } = Array.Empty<int>();

        /// <summary>
        /// Series pages: the episodes (season, number) the library has but hides from the viewer inside
        /// seasons they can see. Their arr states never reach the series' seasons or counts.
        /// </summary>
        public IReadOnlyCollection<(int Season, int Episode)> HiddenSeriesEpisodes { get; init; } = Array.Empty<(int Season, int Episode)>();

        /// <summary>The viewer guards the title with Spoiler Guard: what the season's rows leave out (null: nothing).</summary>
        public AbsentRowSpoilers? Spoilers { get; init; }

        /// <summary>The key of the page's own scope (series key with its season/episode).</summary>
        public TitleKey ScopeKey => Kind switch
        {
            "season" when Season is int s => Title.WithSeason(s),
            "episode" when Season is int s && Episode is int e => Title.WithEpisode(s, e),
            _ => Title,
        };

        /// <summary>What the status depends on besides the arr facts (part of the body cache key).</summary>
        public string Signature
            => string.Join(
                "|",
                PageId.ToString("N", CultureInfo.InvariantCulture),
                Title.ToString(),
                Rows ? "rows" : "banner",
                string.Join(',', Seasons.Select(s => $"{s.Season}:{s.Episodes}:{s.Aired}")),
                string.Join(',', Episodes.Select(e => $"{e.Season}:{e.Episode}:{e.AirDate?.ToString("yyyyMMdd", CultureInfo.InvariantCulture)}")),
                string.Join(',', HiddenEpisodes.OrderBy(n => n)),
                string.Join(',', HiddenSeasons.OrderBy(n => n)),
                string.Join(',', HiddenSeriesEpisodes.OrderBy(p => p.Season).ThenBy(p => p.Episode).Select(p => $"{p.Season}:{p.Episode}")),
                Spoilers?.ToString() ?? "-");
    }

    /// <summary>The outcome of looking an id up as an absent-title page.</summary>
    public enum AbsentLookup
    {
        /// <summary>Not a synthetic id of this server: an ordinary item id.</summary>
        NotAbsent,

        /// <summary>A synthetic id the viewer may not open (or that names nothing): answered like an unseen item.</summary>
        Refused,

        /// <summary>A synthetic id whose metadata can't be read right now.</summary>
        Unavailable,

        /// <summary>A page the viewer may open.</summary>
        Found,
    }

    /// <summary>An absent-title lookup: the outcome and, when found, the page.</summary>
    /// <param name="Outcome">Outcome.</param>
    /// <param name="Title">The page (found only).</param>
    public readonly record struct AbsentPageResult(AbsentLookup Outcome, AbsentTitle? Title)
    {
        /// <summary>Not a synthetic id.</summary>
        public static AbsentPageResult NotAbsent => new(AbsentLookup.NotAbsent, null);

        /// <summary>Refused (or unknown).</summary>
        public static AbsentPageResult Refused => new(AbsentLookup.Refused, null);

        /// <summary>Metadata unavailable.</summary>
        public static AbsentPageResult Unavailable => new(AbsentLookup.Unavailable, null);
    }

    /// <summary>
    /// Resolves synthetic page ids of titles that aren't in the library (registered by the Jellyfin 12
    /// build only; a 10.11 build has none, and every id is then an ordinary item id). The same
    /// viewer rules as the native details page apply: a page the viewer may not open is refused.
    /// </summary>
    public interface IAbsentTitlePages
    {
        /// <summary>The page an id names for a viewer.</summary>
        /// <param name="viewerId">The effective viewer.</param>
        /// <param name="id">Item id from a route.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>The lookup.</returns>
        Task<AbsentPageResult> ResolveAsync(Guid viewerId, Guid id, CancellationToken ct);
    }
}
