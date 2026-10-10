using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders
{
    // Wire contracts of the admin-only /JellyfinEnhanced/list-placeholders/arr routes ("Add to Radarr/Sonarr").
    // Jellyfin's MVC JSON options keep C# names, so every member carries an explicit camelCase [JsonPropertyName].

    /// <summary>GET /arr/options: the pickers of the add dialog, per enabled instance.</summary>
    public sealed class ArrOptionsDto
    {
        /// <summary>Enabled Radarr instances (empty when none, or when only TV was asked for).</summary>
        [JsonPropertyName("radarr")] public List<ArrInstanceOptionsDto> Radarr { get; set; } = new();

        /// <summary>Enabled Sonarr instances (empty when none, or when only movies were asked for).</summary>
        [JsonPropertyName("sonarr")] public List<ArrInstanceOptionsDto> Sonarr { get; set; } = new();

        /// <summary>Radarr "minimum availability" choices JE offers.</summary>
        [JsonPropertyName("minimumAvailability")] public List<string> MinimumAvailability { get; set; } = new();

        /// <summary>Sonarr series types.</summary>
        [JsonPropertyName("seriesTypes")] public List<string> SeriesTypes { get; set; } = new();
    }

    /// <summary>One instance's quality profiles and root folders (or why they couldn't be read).</summary>
    public sealed class ArrInstanceOptionsDto
    {
        /// <summary>Position in the enabled-instance list of that service (send it back as <c>instance</c>).</summary>
        [JsonPropertyName("id")] public int Id { get; set; }

        /// <summary>Instance display name.</summary>
        [JsonPropertyName("name")] public string Name { get; set; } = string.Empty;

        /// <summary>
        /// Stable identity of the instance (hash of its URL): names can repeat (a blank name shows as "Radarr"/"Sonarr")
        /// and ids are positions. Clients key remembered choices by it and may send it back as <c>instanceKey</c>.
        /// </summary>
        [JsonPropertyName("key")] public string Key { get; set; } = string.Empty;

        /// <summary>Quality profiles.</summary>
        [JsonPropertyName("qualityProfiles")] public List<ArrQualityProfileDto> QualityProfiles { get; set; } = new();

        /// <summary>Root folders.</summary>
        [JsonPropertyName("rootFolders")] public List<ArrRootFolderDto> RootFolders { get; set; } = new();

        /// <summary>Error code when the instance couldn't be read (profiles/folders are then empty).</summary>
        [JsonPropertyName("error")] public string? Error { get; set; }

        /// <summary>Human message for <see cref="Error"/>.</summary>
        [JsonPropertyName("message")] public string? Message { get; set; }
    }

    /// <summary>A quality profile.</summary>
    public sealed class ArrQualityProfileDto
    {
        /// <summary>Profile id.</summary>
        [JsonPropertyName("id")] public int Id { get; set; }

        /// <summary>Profile name.</summary>
        [JsonPropertyName("name")] public string Name { get; set; } = string.Empty;
    }

    /// <summary>A root folder.</summary>
    public sealed class ArrRootFolderDto
    {
        /// <summary>Path as the arr sees it.</summary>
        [JsonPropertyName("path")] public string Path { get; set; } = string.Empty;

        /// <summary>Free space in bytes, when reported.</summary>
        [JsonPropertyName("freeSpace")] public long? FreeSpace { get; set; }

        /// <summary>Whether the arr can reach the folder.</summary>
        [JsonPropertyName("accessible")] public bool Accessible { get; set; } = true;
    }

    /// <summary>Instance identity plus what the browser needs to link to it (same fields the arr-links routes return).</summary>
    public sealed class ArrInstanceRefDto
    {
        /// <summary>"radarr" or "sonarr".</summary>
        [JsonPropertyName("service")] public string Service { get; set; } = string.Empty;

        /// <summary>Position in the enabled-instance list.</summary>
        [JsonPropertyName("id")] public int Id { get; set; }

        /// <summary>Display name.</summary>
        [JsonPropertyName("name")] public string Name { get; set; } = string.Empty;

        /// <summary>Configured base URL (mapped in the browser with <see cref="UrlMappings"/>).</summary>
        [JsonPropertyName("instanceUrl")] public string InstanceUrl { get; set; } = string.Empty;

        /// <summary>Per-instance "jellyfin_url|arr_url" lines.</summary>
        [JsonPropertyName("urlMappings")] public string UrlMappings { get; set; } = string.Empty;
    }

    /// <summary>GET /arr/lookup result.</summary>
    public sealed class ArrLookupResultDto
    {
        /// <summary>The instance that answered.</summary>
        [JsonPropertyName("instance")] public ArrInstanceRefDto Instance { get; set; } = new();

        /// <summary>Candidates (at most 20), in the arr's order.</summary>
        [JsonPropertyName("results")] public List<ArrCandidateDto> Results { get; set; } = new();
    }

    /// <summary>A lookup hit in the placeholder candidate shape (plus arr state).</summary>
    public sealed class ArrCandidateDto
    {
        /// <summary>"movie" or "tv".</summary>
        [JsonPropertyName("mediaType")] public string MediaType { get; set; } = string.Empty;

        /// <summary>TMDB id (null when the arr doesn't know it; such hits can't become TMDB placeholders).</summary>
        [JsonPropertyName("tmdbId")] public int? TmdbId { get; set; }

        /// <summary>TVDB id (Sonarr).</summary>
        [JsonPropertyName("tvdbId")] public int? TvdbId { get; set; }

        /// <summary>IMDb id.</summary>
        [JsonPropertyName("imdbId")] public string? ImdbId { get; set; }

        /// <summary>Title.</summary>
        [JsonPropertyName("title")] public string Title { get; set; } = string.Empty;

        /// <summary>Year.</summary>
        [JsonPropertyName("year")] public int? Year { get; set; }

        /// <summary>Release / first-air date (yyyy-MM-dd).</summary>
        [JsonPropertyName("releaseDate")] public string? ReleaseDate { get; set; }

        /// <summary>TMDB poster path when the poster is a TMDB image (placeholder-compatible).</summary>
        [JsonPropertyName("posterPath")] public string? PosterPath { get; set; }

        /// <summary>Remote poster URL for display (http/https only).</summary>
        [JsonPropertyName("posterUrl")] public string? PosterUrl { get; set; }

        /// <summary>Overview (cut to 1000 characters).</summary>
        [JsonPropertyName("overview")] public string? Overview { get; set; }

        /// <summary>Whether the title is already in this instance.</summary>
        [JsonPropertyName("inArr")] public bool InArr { get; set; }

        /// <summary>The arr's id when <see cref="InArr"/>.</summary>
        [JsonPropertyName("arrId")] public int? ArrId { get; set; }

        /// <summary>Whether it is monitored (only meaningful when <see cref="InArr"/>).</summary>
        [JsonPropertyName("monitored")] public bool? Monitored { get; set; }

        /// <summary>Arr status text (released, announced, continuing, ended, upcoming…).</summary>
        [JsonPropertyName("status")] public string? Status { get; set; }

        /// <summary>Sonarr title slug (series page link).</summary>
        [JsonPropertyName("titleSlug")] public string? TitleSlug { get; set; }

        /// <summary>Sonarr's suggested series type.</summary>
        [JsonPropertyName("seriesType")] public string? SeriesType { get; set; }

        /// <summary>Sonarr seasons (monitored flags are the series' when <see cref="InArr"/>).</summary>
        [JsonPropertyName("seasons")] public List<ArrSeasonDto>? Seasons { get; set; }
    }

    /// <summary>A Sonarr season flag.</summary>
    public sealed class ArrSeasonDto
    {
        /// <summary>Season number (0 = specials).</summary>
        [JsonPropertyName("seasonNumber")] public int SeasonNumber { get; set; }

        /// <summary>Monitored flag.</summary>
        [JsonPropertyName("monitored")] public bool Monitored { get; set; }
    }

    /// <summary>Body of POST /arr/add.</summary>
    public sealed class ArrAddRequest
    {
        /// <summary>Client request id; a retry with the same id replays the first result for 10 minutes.</summary>
        [JsonPropertyName("requestId")] public string? RequestId { get; set; }

        /// <summary>"movie" (Radarr) or "tv" (Sonarr).</summary>
        [JsonPropertyName("mediaType")] public string? MediaType { get; set; }

        /// <summary>Instance id from GET /arr/options.</summary>
        [JsonPropertyName("instance")] public int? Instance { get; set; }

        /// <summary>Optional instance name from GET /arr/options; a mismatch (config changed meanwhile) is refused.</summary>
        [JsonPropertyName("instanceName")] public string? InstanceName { get; set; }

        /// <summary>Optional instance key from GET /arr/options; a mismatch (config changed meanwhile) is refused.</summary>
        [JsonPropertyName("instanceKey")] public string? InstanceKey { get; set; }

        /// <summary>TMDB id.</summary>
        [JsonPropertyName("tmdbId")] public int? TmdbId { get; set; }

        /// <summary>TVDB id (Sonarr; preferred over TMDB when present).</summary>
        [JsonPropertyName("tvdbId")] public int? TvdbId { get; set; }

        /// <summary>IMDb id (fallback lookup key).</summary>
        [JsonPropertyName("imdbId")] public string? ImdbId { get; set; }

        /// <summary>"movie", "series", "season" or "episodes".</summary>
        [JsonPropertyName("scope")] public string? Scope { get; set; }

        /// <summary>Season for the season/episodes scopes.</summary>
        [JsonPropertyName("seasonNumber")] public int? SeasonNumber { get; set; }

        /// <summary>Episodes for the episodes scope (all in <see cref="SeasonNumber"/>).</summary>
        [JsonPropertyName("episodes")] public List<PlaceholderEpisode>? Episodes { get; set; }

        /// <summary>Quality profile id.</summary>
        [JsonPropertyName("qualityProfileId")] public int? QualityProfileId { get; set; }

        /// <summary>Root folder path (one of the instance's root folders).</summary>
        [JsonPropertyName("rootFolderPath")] public string? RootFolderPath { get; set; }

        /// <summary>Start a search once added/monitored.</summary>
        [JsonPropertyName("search")] public bool Search { get; set; }

        /// <summary>Radarr minimum availability (announced, inCinemas, released; default released).</summary>
        [JsonPropertyName("minimumAvailability")] public string? MinimumAvailability { get; set; }

        /// <summary>Sonarr series type (standard, daily, anime); default: Sonarr's suggestion.</summary>
        [JsonPropertyName("seriesType")] public string? SeriesType { get; set; }
    }

    /// <summary>POST /arr/add result.</summary>
    public sealed class ArrAddResultDto
    {
        /// <summary>"added", "monitoring_added", "already_monitored" or "already_exists".</summary>
        [JsonPropertyName("result")] public string Result { get; set; } = string.Empty;

        /// <summary>The instance.</summary>
        [JsonPropertyName("instance")] public ArrInstanceRefDto Instance { get; set; } = new();

        /// <summary>Title as the arr knows it.</summary>
        [JsonPropertyName("title")] public string Title { get; set; } = string.Empty;

        /// <summary>The arr's movie/series id, when known.</summary>
        [JsonPropertyName("arrId")] public int? ArrId { get; set; }

        /// <summary>Path of the title's page in the arr UI (append to the mapped instance URL).</summary>
        [JsonPropertyName("arrPath")] public string? ArrPath { get; set; }

        /// <summary>Whether a search was started.</summary>
        [JsonPropertyName("searched")] public bool Searched { get; set; }

        /// <summary>Whether the title is monitored afterwards (already_exists: its current state).</summary>
        [JsonPropertyName("monitored")] public bool? Monitored { get; set; }

        /// <summary>Episodes scope: how many episodes became monitored.</summary>
        [JsonPropertyName("monitoredEpisodes")] public int? MonitoredEpisodes { get; set; }

        /// <summary>Episodes scope: requested episodes the arr doesn't have (yet).</summary>
        [JsonPropertyName("missingEpisodes")] public List<PlaceholderEpisode>? MissingEpisodes { get; set; }
    }
}
