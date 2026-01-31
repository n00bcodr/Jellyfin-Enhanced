
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Model.Arr {
    public class ArrItem
    {
        /// <summary>
        /// Your system ID (from Radarr/Sonarr)
        /// </summary>
        [JsonPropertyName("id")]
        public string? Id { get; set; } = string.Empty;

        /// <summary>
        /// Source system (radarr/sonarr)
        /// </summary>
        [JsonPropertyName("source")]
        public string Source { get; set; } = string.Empty;

        /// <summary>
        /// Movie or Series
        /// </summary>
        [JsonPropertyName("type")]
        public string Type { get; set; } = string.Empty;

        /// <summary>
        /// Title of the item
        /// </summary>
        [JsonPropertyName("title")]
        public string Title { get; set; } = string.Empty;

        /// <summary>
        /// Subtitle, e.g., season/episode or year
        /// </summary>
        [JsonPropertyName("subtitle")]
        public string? Subtitle { get; set; }

        /// <summary>
        /// Release date in UTC
        /// </summary>
        [JsonPropertyName("releaseDate")]
        public string? ReleaseDate { get; set; }

        /// <summary>
        /// Release type (DigitalRelease, PhysicalRelease, Episode, etc.)
        /// </summary>
        [JsonPropertyName("releaseType")]
        public string ReleaseType { get; set; } = string.Empty;

        /// <summary>
        /// Has file locally
        /// </summary>
        [JsonPropertyName("hasFile")]
        public bool HasFile { get; set; }

        /// <summary>
        /// Is monitored in source system
        /// </summary>
        [JsonPropertyName("monitored")]
        public bool Monitored { get; set; }

        /// <summary>
        /// Optional poster URL
        /// </summary>
        [JsonPropertyName("posterUrl")]
        public string? PosterUrl { get; set; }

        /// <summary>
        /// Optional backdrop/fanart URL
        /// </summary>
        [JsonPropertyName("backdropUrl")]
        public string? BackdropUrl { get; set; }

        /// <summary>
        /// IMDb ID
        /// </summary>
        [JsonPropertyName("imdbId")]
        public string? ImdbId { get; set; }

        /// <summary>
        /// Jellyfin ItemId after mapping
        /// </summary>
        [JsonPropertyName("itemId")]
        public Guid? ItemId { get; set; }

        /// <summary>
        /// Optional series or movie overview
        /// </summary>
        [JsonPropertyName("overview")]
        public string? Overview { get; set; }

        /// <summary>
        /// TVDb ID
        /// </summary>
        [JsonPropertyName("tvdbId")]
        public int? TvdbId { get; set; }

        /// <summary>
        /// Season Number
        /// </summary>
        [JsonPropertyName("seasonNumber")]
        public int? SeasonNumber { get; set; }

        /// <summary>
        /// Episode Number
        /// </summary>
        [JsonPropertyName("episodeNumber")]
        public int? EpisodeNumber { get; set; }

        /// <summary>
        /// Episode TVDb ID
        /// </summary>
        [JsonPropertyName("episodeTvdbId")]
        public int? EpisodeTvdbId { get; set; }

        /// <summary>
        /// Episode ImDb ID
        /// </summary>
        [JsonPropertyName("episodeImdbId")]
        public string? EpisodeImdbId { get; set; }

        /// <summary>
        /// Episode Title
        /// </summary>
        [JsonPropertyName("episodeTitle")]
        public string? EpisodeTitle { get; set; }

        /// <summary>
        /// Series ID
        /// </summary>
        [JsonPropertyName("seriesId")]
        public int? SeriesId { get; set; }

        /// <summary>
        /// TMDb ID
        /// </summary>
        [JsonPropertyName("tmdbId")]
        public int? TmdbId { get; set; }
    }
}
