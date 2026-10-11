using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders
{
    // Wire contracts of the import (paste / URL) and linked-source routes of /JellyfinEnhanced/list-placeholders.
    // Jellyfin's MVC JSON options keep C# names, so every member carries an explicit camelCase [JsonPropertyName].

    /// <summary>External ids of an import entry.</summary>
    public sealed class ImportIdsDto
    {
        /// <summary>TMDB id.</summary>
        [JsonPropertyName("tmdb")] public int? Tmdb { get; set; }
        /// <summary>"movie" or "tv" when the TMDB id's type is known (TMDB URLs, typed sources).</summary>
        [JsonPropertyName("tmdbType")] public string? TmdbType { get; set; }
        /// <summary>IMDb id (tt…).</summary>
        [JsonPropertyName("imdb")] public string? Imdb { get; set; }
        /// <summary>TVDB id.</summary>
        [JsonPropertyName("tvdb")] public int? Tvdb { get; set; }
    }

    /// <summary>One episode coordinate of an import entry.</summary>
    public sealed class ImportEpisodeDto
    {
        /// <summary>Season number.</summary>
        [JsonPropertyName("s")] public int S { get; set; }
        /// <summary>Episode number.</summary>
        [JsonPropertyName("e")] public int E { get; set; }
    }

    /// <summary>One alternative of an "A or B" entry.</summary>
    public sealed class ImportAlternativeDto
    {
        /// <summary>Title.</summary>
        [JsonPropertyName("title")] public string? Title { get; set; }
        /// <summary>Year.</summary>
        [JsonPropertyName("year")] public int? Year { get; set; }
        /// <summary>Type hint.</summary>
        [JsonPropertyName("typeHint")] public string? TypeHint { get; set; }
        /// <summary>Ids.</summary>
        [JsonPropertyName("ids")] public ImportIdsDto? Ids { get; set; }
        /// <summary>Season.</summary>
        [JsonPropertyName("season")] public int? Season { get; set; }
        /// <summary>This alternative's own listed episodes (one season): "Flash 1x08 or Arrow 3x09".</summary>
        [JsonPropertyName("episodes")] public List<ImportEpisodeDto>? Episodes { get; set; }
        /// <summary>This alternative's first episode starts a range to the end of its season.</summary>
        [JsonPropertyName("openEnded")] public bool? OpenEnded { get; set; }
    }

    /// <summary>
    /// A parsed import entry (client paste parser or a URL source). The resolver re-validates every field; only the
    /// listed ones are used.
    /// </summary>
    public sealed class ImportEntryDto
    {
        /// <summary>Client index, echoed back.</summary>
        [JsonPropertyName("index")] public int? Index { get; set; }
        /// <summary>Title (may be empty when ids are given).</summary>
        [JsonPropertyName("title")] public string? Title { get; set; }
        /// <summary>Year (release year; for season/episode lines the season's/episode's air year).</summary>
        [JsonPropertyName("year")] public int? Year { get; set; }
        /// <summary>"movie" or "tv".</summary>
        [JsonPropertyName("typeHint")] public string? TypeHint { get; set; }
        /// <summary>Season (season and episode lines).</summary>
        [JsonPropertyName("season")] public int? Season { get; set; }
        /// <summary>Listed episodes (one season).</summary>
        [JsonPropertyName("episodes")] public List<ImportEpisodeDto>? Episodes { get; set; }
        /// <summary>
        /// The first listed episode starts a range that runs to the end of its season (the first season of a
        /// cross-season range such as S1E5–S3E3): the resolver fills the rest from the season's episode list.
        /// </summary>
        [JsonPropertyName("openEnded")] public bool? OpenEnded { get; set; }
        /// <summary>An episode named by title only (resolved to its series; the episode is left to review).</summary>
        [JsonPropertyName("episodeTitle")] public string? EpisodeTitle { get; set; }
        /// <summary>External ids.</summary>
        [JsonPropertyName("ids")] public ImportIdsDto? Ids { get; set; }
        /// <summary>The IMDb id names an episode (IMDb CSV "TV Episode").</summary>
        [JsonPropertyName("imdbEpisode")] public bool? ImdbEpisode { get; set; }
        /// <summary>released | scheduled | tba.</summary>
        [JsonPropertyName("status")] public string? Status { get; set; }
        /// <summary>"A or B" alternatives (always reviewed).</summary>
        [JsonPropertyName("alternatives")] public List<ImportAlternativeDto>? Alternatives { get; set; }
        /// <summary>Note carried to the placeholder (URL sources: the list's own note).</summary>
        [JsonPropertyName("note")] public string? Note { get; set; }
        /// <summary>URL sources: the provenance key (<c>type|tmdbId|season|episode</c>).</summary>
        [JsonPropertyName("sourceKey")] public string? SourceKey { get; set; }
        /// <summary>
        /// Grouped sources (a run of episodes as one entry): every source key the entry stands for, in order (the first
        /// is <see cref="SourceKey"/>). Send them back with the apply entry.
        /// </summary>
        [JsonPropertyName("sourceKeys")][JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public List<string>? SourceKeys { get; set; }
        /// <summary>
        /// Sources with exact ids and full metadata (chronolists): the resolution, prepared by the server without any
        /// Seerr lookup. Use it as this entry's /resolve result (its <c>index</c> is the entry's position); its
        /// <c>match</c> is the only candidate and is not repeated in <c>candidates</c>.
        /// </summary>
        [JsonPropertyName("prepared")][JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public ResolvedEntryDto? Prepared { get; set; }
    }

    /// <summary>Body of POST /resolve.</summary>
    public sealed class ResolveRequest
    {
        /// <summary>At most 25 entries (send chunks sequentially).</summary>
        [JsonPropertyName("entries")] public List<ImportEntryDto>? Entries { get; set; }
        /// <summary>Optional target list: "in library" then also requires visibility to the playlist's owner.</summary>
        [JsonPropertyName("listId")] public string? ListId { get; set; }
    }

    /// <summary>Season facts of a TV candidate.</summary>
    public sealed class ImportSeasonDto
    {
        /// <summary>Season number.</summary>
        [JsonPropertyName("seasonNumber")] public int SeasonNumber { get; set; }
        /// <summary>TMDB episode count.</summary>
        [JsonPropertyName("episodeCount")] public int? EpisodeCount { get; set; }
        /// <summary>Season air date (yyyy-MM-dd) or null.</summary>
        [JsonPropertyName("airDate")] public string? AirDate { get; set; }
        /// <summary>Season name.</summary>
        [JsonPropertyName("name")] public string? Name { get; set; }
    }

    /// <summary>An episode of a TV candidate.</summary>
    public sealed class ImportEpisodeInfoDto
    {
        /// <summary>Season.</summary>
        [JsonPropertyName("s")] public int S { get; set; }
        /// <summary>Episode.</summary>
        [JsonPropertyName("e")] public int E { get; set; }
        /// <summary>Episode title.</summary>
        [JsonPropertyName("title")] public string? Title { get; set; }
        /// <summary>Air date (yyyy-MM-dd).</summary>
        [JsonPropertyName("airDate")] public string? AirDate { get; set; }
    }

    /// <summary>A library match of a candidate (visible to the caller and, for a playlist, its owner).</summary>
    public sealed class ImportLibraryDto
    {
        /// <summary>Movie / Series / Season item id ("N"); for episodes the first episode.</summary>
        [JsonPropertyName("itemId")] public string ItemId { get; set; } = string.Empty;
        /// <summary>movie | series | season | episodes.</summary>
        [JsonPropertyName("kind")] public string Kind { get; set; } = string.Empty;
        /// <summary>Episode item ids in episode order (series / season / episodes scopes).</summary>
        [JsonPropertyName("episodeItemIds")] public List<string>? EpisodeItemIds { get; set; }
        /// <summary>Whether everything the scope names is present.</summary>
        [JsonPropertyName("complete")] public bool Complete { get; set; }
    }

    /// <summary>A TMDB candidate for an import entry.</summary>
    public sealed class ImportCandidateDto
    {
        /// <summary>"movie" or "tv".</summary>
        [JsonPropertyName("mediaType")] public string MediaType { get; set; } = string.Empty;
        /// <summary>TMDB id.</summary>
        [JsonPropertyName("tmdbId")] public int TmdbId { get; set; }
        /// <summary>Title.</summary>
        [JsonPropertyName("title")] public string Title { get; set; } = string.Empty;
        /// <summary>Release / first-air year.</summary>
        [JsonPropertyName("year")] public int? Year { get; set; }
        /// <summary>Release / first-air date (yyyy-MM-dd).</summary>
        [JsonPropertyName("releaseDate")] public string? ReleaseDate { get; set; }
        /// <summary>TMDB poster path.</summary>
        [JsonPropertyName("posterPath")] public string? PosterPath { get; set; }
        /// <summary>Short overview.</summary>
        [JsonPropertyName("overview")] public string? Overview { get; set; }
        /// <summary>Match score (see the resolver for the scale).</summary>
        [JsonPropertyName("score")] public double Score { get; set; }
        /// <summary>TVDB id (TV, when known).</summary>
        [JsonPropertyName("tvdbId")] public int? TvdbId { get; set; }
        /// <summary>IMDb id (when known).</summary>
        [JsonPropertyName("imdbId")] public string? ImdbId { get; set; }
        /// <summary>Which alternative of an "A or B" entry this candidate answers.</summary>
        [JsonPropertyName("alternative")] public int? Alternative { get; set; }
        /// <summary>Season facts (season/episode entries).</summary>
        [JsonPropertyName("season")] public ImportSeasonDto? Season { get; set; }
        /// <summary>Listed episodes with titles/air dates (episode entries).</summary>
        [JsonPropertyName("episodes")] public List<ImportEpisodeInfoDto>? Episodes { get; set; }
        /// <summary>Season/series: aired episode count (fill target).</summary>
        [JsonPropertyName("episodeTotal")] public int? EpisodeTotal { get; set; }
        /// <summary>The library already has it.</summary>
        [JsonPropertyName("inLibrary")] public ImportLibraryDto? InLibrary { get; set; }
    }

    /// <summary>The resolution of one entry.</summary>
    public sealed class ResolvedEntryDto
    {
        /// <summary>Index of the entry in the request (or the client's index when it sent one).</summary>
        [JsonPropertyName("index")] public int Index { get; set; }
        /// <summary>ok | transient (resubmit later) | invalid.</summary>
        [JsonPropertyName("state")] public string State { get; set; } = "ok";
        /// <summary>high | medium | low | none.</summary>
        [JsonPropertyName("confidence")] public string Confidence { get; set; } = "none";
        /// <summary>movie | series | season | episodes (granularity the entry asks for).</summary>
        [JsonPropertyName("kind")] public string? Kind { get; set; }
        /// <summary>The best candidate.</summary>
        [JsonPropertyName("match")] public ImportCandidateDto? Match { get; set; }
        /// <summary>Up to 5 candidates, best first (alternatives entries: the best of each alternative).</summary>
        [JsonPropertyName("candidates")] public List<ImportCandidateDto> Candidates { get; set; } = new();
        /// <summary>Why the entry needs review (tba, alternatives, noYear, tie, lowScore, noMatch, seasonMissing, episodeMissing, episodeByTitle, episodeIdUnsupported, typeMismatch, invalid).</summary>
        [JsonPropertyName("reasons")] public List<string> Reasons { get; set; } = new();
        /// <summary>Entry with alternatives.</summary>
        [JsonPropertyName("alternatives")] public bool Alternatives { get; set; }
    }

    /// <summary>Response of POST /resolve.</summary>
    public sealed class ResolveResponse
    {
        /// <summary>One result per request entry, in order.</summary>
        [JsonPropertyName("results")] public List<ResolvedEntryDto> Results { get; set; } = new();
        /// <summary>False when some entries are transient (deadline or Seerr trouble): resubmit just those.</summary>
        [JsonPropertyName("complete")] public bool Complete { get; set; } = true;
        /// <summary>Seerr calls this request made (cache hits excluded).</summary>
        [JsonPropertyName("seerrCalls")] public int SeerrCalls { get; set; }
    }

    /// <summary>Body of POST /source/fetch.</summary>
    public sealed class SourceFetchRequest
    {
        /// <summary>The list URL (MDBList, TMDB, Trakt, IMDb, chronolists; Letterboxd answers with guidance).</summary>
        [JsonPropertyName("url")] public string? Url { get; set; }
        /// <summary>Optional target list: prepared entries' "in library" then also requires visibility to the playlist's owner.</summary>
        [JsonPropertyName("listId")] public string? ListId { get; set; }
    }

    /// <summary>Response of POST /source/fetch.</summary>
    public sealed class SourceFetchResponse
    {
        /// <summary>mdblist | tmdb | trakt | imdb.</summary>
        [JsonPropertyName("kind")] public string Kind { get; set; } = string.Empty;
        /// <summary>The upstream actually used (e.g. tmdb or seerr for TMDB charts).</summary>
        [JsonPropertyName("provider")] public string Provider { get; set; } = string.Empty;
        /// <summary>Canonical URL of the list (store this when linking).</summary>
        [JsonPropertyName("url")] public string Url { get; set; } = string.Empty;
        /// <summary>List title, when the source has one.</summary>
        [JsonPropertyName("title")] public string? Title { get; set; }
        /// <summary>True for unofficial access paths (IMDb): may break without notice.</summary>
        [JsonPropertyName("unofficial")] public bool Unofficial { get; set; }
        /// <summary>Entries in list order, with ids (feed them to /resolve).</summary>
        [JsonPropertyName("entries")] public List<ImportEntryDto> Entries { get; set; } = new();
        /// <summary>How many entries the source has (when known).</summary>
        [JsonPropertyName("total")] public int Total { get; set; }
        /// <summary>The source has more than the 1000-entry cap.</summary>
        [JsonPropertyName("truncated")] public bool Truncated { get; set; }
        /// <summary>Entries hidden by the caller's parental controls are dropped; this counts other dropped entries (no usable id).</summary>
        [JsonPropertyName("dropped")] public int Dropped { get; set; }
        /// <summary>
        /// The source answered only partly (entries it couldn't read, counted in <see cref="Dropped"/>, or upstream
        /// errors next to data): the review should say the list may be incomplete. Omitted when false.
        /// </summary>
        [JsonPropertyName("partial")][JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] public bool Partial { get; set; }
        /// <summary>
        /// Entries are grouped runs (chronolists: consecutive episodes of one season → one entry), each carrying
        /// <see cref="ImportEntryDto.SourceKeys"/> and a <see cref="ImportEntryDto.Prepared"/> resolution.
        /// </summary>
        [JsonPropertyName("grouped")] public bool Grouped { get; set; }
        /// <summary>Grouped sources: every source key of the fetched list, in order (send as <c>source.snapshotKeys</c>).</summary>
        [JsonPropertyName("snapshotKeys")][JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public List<string>? SnapshotKeys { get; set; }
    }

    /// <summary>A source to link while importing (POST /{listId}/apply, POST /playlists, POST /collections).</summary>
    public sealed class ImportSourceDto
    {
        /// <summary>The list URL the entries came from.</summary>
        [JsonPropertyName("url")] public string? Url { get; set; }
        /// <summary>Keep in sync (scheduled sync adds new entries).</summary>
        [JsonPropertyName("syncEnabled")] public bool SyncEnabled { get; set; }
        /// <summary>Remove entries that leave the list (only what the import/sync added).</summary>
        [JsonPropertyName("removeDropped")] public bool RemoveDropped { get; set; }
        /// <summary>Source keys of the complete fetched list (becomes the first snapshot).</summary>
        [JsonPropertyName("snapshotKeys")] public List<string>? SnapshotKeys { get; set; }
    }

    /// <summary>Body of PUT /{listId}/source.</summary>
    public sealed class LinkSourceRequest
    {
        /// <summary>Client request id.</summary>
        [JsonPropertyName("requestId")] public string? RequestId { get; set; }
        /// <summary>The list URL.</summary>
        [JsonPropertyName("url")] public string? Url { get; set; }
        /// <summary>Keep in sync.</summary>
        [JsonPropertyName("syncEnabled")] public bool SyncEnabled { get; set; } = true;
        /// <summary>Remove entries that leave the list.</summary>
        [JsonPropertyName("removeDropped")] public bool RemoveDropped { get; set; }
    }

    /// <summary>Result of POST /{listId}/source/sync.</summary>
    public sealed class SourceSyncResultDto
    {
        /// <summary>ok | failed | paused | running.</summary>
        [JsonPropertyName("state")] public string State { get; set; } = "ok";
        /// <summary>Failure/pause code (see <see cref="SourceSyncSummary.Code"/>).</summary>
        [JsonPropertyName("code")] public string? Code { get; set; }
        /// <summary>Entries added (placeholders + real items).</summary>
        [JsonPropertyName("added")] public int Added { get; set; }
        /// <summary>Entries removed because they left the source.</summary>
        [JsonPropertyName("removed")] public int Removed { get; set; }
        /// <summary>Entries that left the source but were kept (not added by sync, or duplicated).</summary>
        [JsonPropertyName("kept")] public int Kept { get; set; }
        /// <summary>Source entries that couldn't be resolved to a title.</summary>
        [JsonPropertyName("unresolved")] public int Unresolved { get; set; }
        /// <summary>The list reached the 2000-placeholder cap.</summary>
        [JsonPropertyName("listFull")] public bool ListFull { get; set; }
        /// <summary>Short human-readable summary (also stored as the source's lastSyncResult).</summary>
        [JsonPropertyName("message")] public string Message { get; set; } = string.Empty;
        /// <summary>The fresh view (when the caller can view the list).</summary>
        [JsonPropertyName("view")] public ListViewDto? View { get; set; }
        /// <summary>True when the caller doesn't see every entry of the list: the counts are zero and the message is generic (A2).</summary>
        [JsonPropertyName("countsHidden")] public bool? CountsHidden { get; set; }
    }

    /// <summary>Response of GET /source/providers: which URL sources work on this server (no secrets).</summary>
    public sealed class SourceProvidersDto
    {
        /// <summary>MDBList public lists (always); the API path when an MDBList key is configured.</summary>
        [JsonPropertyName("mdblist")] public bool Mdblist { get; set; } = true;
        /// <summary>TMDB user lists and exact charts (needs the TMDB API key).</summary>
        [JsonPropertyName("tmdbLists")] public bool TmdbLists { get; set; }
        /// <summary>TMDB collections / trending / upcoming (TMDB key or Seerr).</summary>
        [JsonPropertyName("tmdbCharts")] public bool TmdbCharts { get; set; }
        /// <summary>Trakt (needs a Trakt client id).</summary>
        [JsonPropertyName("trakt")] public bool Trakt { get; set; }
        /// <summary>IMDb (admin opt-in, unofficial).</summary>
        [JsonPropertyName("imdb")] public bool Imdb { get; set; }
        /// <summary>chronolists.com chronological watch orders (always; no key).</summary>
        [JsonPropertyName("chronolists")] public bool Chronolists { get; set; } = true;
        /// <summary>Scheduled sync of linked lists is on.</summary>
        [JsonPropertyName("syncEnabled")] public bool SyncEnabled { get; set; }
        /// <summary>Entry cap per fetch.</summary>
        [JsonPropertyName("maxItems")] public int MaxItems { get; set; }
    }
}
