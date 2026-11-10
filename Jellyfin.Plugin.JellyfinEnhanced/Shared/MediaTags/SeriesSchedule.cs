using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags
{
    /// <summary>
    /// A series' TMDB schedule: <see cref="Status"/> as TMDB names it ("Returning
    /// Series", "Ended", "Canceled", "In Production", "Planned", "Pilot"), its
    /// newest aired episode and its next scheduled one, and how many episodes TMDB lists per regular season.
    /// </summary>
    public sealed record SeriesSchedule(string? Status, SeriesEpisodeRef? LastAired, SeriesEpisodeRef? NextAired, bool Retry = false, SeriesEpisodeRef? LastRegularAired = null,
        IReadOnlyDictionary<int, int>? SeasonEpisodes = null);

    /// <summary>
    /// One TMDB episode reference: air date as TMDB's calendar date
    /// (yyyy-MM-dd), numbers, and (last aired only) TMDB's <c>episode_type</c>
    /// ("standard", "finale", "mid_season"; null when TMDB has none).
    /// </summary>
    public sealed record SeriesEpisodeRef(string Date, int? Season, int? Episode, string? Type);
}
