using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders
{
    // Wire contracts of the list import review (paste / file / URL) under /JellyfinEnhanced/acquire/lists/import. Every
    // route is a preview: nothing here changes a list. Jellyfin's MVC JSON options keep C# names, so every member carries
    // an explicit camelCase [JsonPropertyName].

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
    /// A parsed import entry (the client's paste parser or a URL source). The resolver re-validates every field; only the
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
        /// <summary>Note carried to the entry (URL sources: the list's own note).</summary>
        [JsonPropertyName("note")] public string? Note { get; set; }
        /// <summary>URL sources: the provenance key (<c>type|id|season|episode</c>).</summary>
        [JsonPropertyName("sourceKey")] public string? SourceKey { get; set; }
        /// <summary>
        /// Grouped sources (a run of episodes as one entry): every source key the entry stands for, in order (the first
        /// is <see cref="SourceKey"/>). Send them back with the apply entry.
        /// </summary>
        [JsonPropertyName("sourceKeys")][JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public List<string>? SourceKeys { get; set; }
        /// <summary>
        /// Sources with exact ids and full metadata (Chronolists): the resolution, prepared by the server without any title
        /// lookup. Use it as this entry's resolve result (its <c>index</c> is the entry's position); its <c>match</c> is the
        /// only candidate and is not repeated in <c>candidates</c>.
        /// </summary>
        [JsonPropertyName("prepared")][JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public ResolvedEntryDto? Prepared { get; set; }
    }

    /// <summary>Body of POST acquire/lists/import/resolve.</summary>
    public sealed class ResolveRequest
    {
        /// <summary>At most 25 entries (send chunks one after another).</summary>
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
        /// <summary>Episode title (left out for a series the caller guards with Spoiler Guard).</summary>
        [JsonPropertyName("title")] public string? Title { get; set; }
        /// <summary>Air date (yyyy-MM-dd).</summary>
        [JsonPropertyName("airDate")] public string? AirDate { get; set; }
    }

    /// <summary>A library match of a candidate (accessible to the caller and, for a playlist, its owner).</summary>
    public sealed class ImportLibraryDto
    {
        /// <summary>Movie / Series / Season item id ("N"); for episodes the first episode.</summary>
        [JsonPropertyName("itemId")] public string ItemId { get; set; } = string.Empty;
        /// <summary>movie | series | season | episodes.</summary>
        [JsonPropertyName("kind")] public string Kind { get; set; } = string.Empty;
        /// <summary>Episode item ids in episode order (series / season / episodes scopes).</summary>
        [JsonPropertyName("episodeItemIds")] public List<string>? EpisodeItemIds { get; set; }
        /// <summary>Whether everything the scope names is present (false = partly owned: the rest stays a placeholder).</summary>
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
        /// <summary>Short overview (left out for a title the caller guards with Spoiler Guard).</summary>
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
        /// <summary>The library already has it (only copies the caller, and a playlist's owner, can open).</summary>
        [JsonPropertyName("inLibrary")] public ImportLibraryDto? InLibrary { get; set; }
        /// <summary>The caller hid this title with Hidden Content: never pre-selected (the caller's own rule, nobody else's).</summary>
        [JsonPropertyName("hidden")][JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public bool? Hidden { get; set; }
        /// <summary>The caller guards this title with Spoiler Guard: its overview and episode titles are left out.</summary>
        [JsonPropertyName("spoilerGuarded")][JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public bool? SpoilerGuarded { get; set; }

        /// <summary>The library scope the candidate stands for (season and episodes of a TV scope), for the caller's physical-title projection; never sent.</summary>
        [JsonIgnore] internal (int? Season, IReadOnlyList<int>? Episodes) Scope { get; set; }

        /// <summary>
        /// Internal (never sent): the candidate's completed identity (review round 3, D53 rule 2), built once before any
        /// consumer runs: the physical-title check, "in library", Spoiler Guard and the placeholder take it, and
        /// <see cref="TvdbId"/> / <see cref="ImdbId"/> are its ids, so the review and the placeholder agree.
        /// </summary>
        [JsonIgnore] internal Services.Acquire.Lists.Import.CompletedIdentity? Identity { get; set; }
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
        /// <summary>
        /// Why the entry needs review (tba, alternatives, noYear, yearOff, otherYear, tie, closeMatch, lowScore, noMatch,
        /// notFound, seasonMissing, episodeMissing, episodeByTitle, episodeIdUnsupported, typeMismatch, openEnded,
        /// openEndedTruncated, unreleased, hidden, invalid).
        /// </summary>
        [JsonPropertyName("reasons")] public List<string> Reasons { get; set; } = new();
        /// <summary>Entry with alternatives.</summary>
        [JsonPropertyName("alternatives")] public bool Alternatives { get; set; }
    }

    /// <summary>Response of POST acquire/lists/import/resolve.</summary>
    public sealed class ResolveResponse
    {
        /// <summary>One result per request entry, in order.</summary>
        [JsonPropertyName("results")] public List<ResolvedEntryDto> Results { get; set; } = new();
        /// <summary>False when some entries are transient (deadline or upstream trouble): resubmit just those.</summary>
        [JsonPropertyName("complete")] public bool Complete { get; set; } = true;
        /// <summary>Upstream title lookups this request made (cache hits excluded).</summary>
        [JsonPropertyName("upstreamCalls")] public int UpstreamCalls { get; set; }
        /// <summary>Where titles were looked up: <c>tmdb</c> (Jellyfin Enhanced's TMDB key) or <c>seerr</c>.</summary>
        [JsonPropertyName("metadataProvider")] public string MetadataProvider { get; set; } = string.Empty;
    }

    /// <summary>Body of POST acquire/lists/import/source.</summary>
    public sealed class SourceFetchRequest
    {
        /// <summary>The list URL (MDBList, TMDB, Trakt, IMDb, Chronolists; Letterboxd answers with guidance).</summary>
        [JsonPropertyName("url")] public string? Url { get; set; }
        /// <summary>Optional target list: prepared entries' "in library" then also requires visibility to the playlist's owner.</summary>
        [JsonPropertyName("listId")] public string? ListId { get; set; }
        /// <summary>
        /// Administrators only, deliberately: read an MDBList list through the MDBList API with Jellyfin Enhanced's key
        /// (private lists; counts against the shared quota). Never a fallback of the public read.
        /// </summary>
        [JsonPropertyName("useMdblistApi")] public bool UseMdblistApi { get; set; }
    }

    /// <summary>What a fetched snapshot is good for (4c2b refuses to apply anything but a complete one as a replacement).</summary>
    public sealed class SourceSnapshotDto
    {
        /// <summary>complete | partial | truncated (never removes entries or replaces the last complete snapshot).</summary>
        [JsonPropertyName("state")] public string State { get; set; } = "complete";
        /// <summary>A digest of the snapshot's ordered keys (changes whenever the list's membership or order changes).</summary>
        [JsonPropertyName("digest")] public string Digest { get; set; } = string.Empty;
    }

    /// <summary>Response of POST acquire/lists/import/source.</summary>
    public sealed class SourceFetchResponse
    {
        /// <summary>mdblist | tmdb | trakt | imdb | chronolists.</summary>
        [JsonPropertyName("kind")] public string Kind { get; set; } = string.Empty;
        /// <summary>
        /// The upstream actually used (mdblist, mdblist-api, tmdb, seerr, trakt, imdb, chronolists): a linked list keeps
        /// this one and never switches silently.
        /// </summary>
        [JsonPropertyName("provider")] public string Provider { get; set; } = string.Empty;
        /// <summary>Canonical URL of the list (store this when linking).</summary>
        [JsonPropertyName("url")] public string Url { get; set; } = string.Empty;
        /// <summary>List title, when the source has one.</summary>
        [JsonPropertyName("title")] public string? Title { get; set; }
        /// <summary>True for unofficial access paths (IMDb): may break without notice.</summary>
        [JsonPropertyName("unofficial")] public bool Unofficial { get; set; }
        /// <summary>
        /// A notice the review must show: <c>imdb_unofficial</c> (IMDb's unofficial API), <c>seerr_fallback</c> (a TMDB chart
        /// read through Seerr because JE has no TMDB key), <c>mdblist_api</c> (read with the server's MDBList key).
        /// </summary>
        [JsonPropertyName("notice")][JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Notice { get; set; }
        /// <summary>Entries in list order, with ids (feed the ones without <c>prepared</c> to resolve).</summary>
        [JsonPropertyName("entries")] public List<ImportEntryDto> Entries { get; set; } = new();
        /// <summary>How many entries the source has (when known; 0 when <see cref="CountsHidden"/>).</summary>
        [JsonPropertyName("total")] public int Total { get; set; }
        /// <summary>The source has more than the entry cap.</summary>
        [JsonPropertyName("truncated")] public bool Truncated { get; set; }
        /// <summary>Entries without a usable id (0 when <see cref="CountsHidden"/>).</summary>
        [JsonPropertyName("dropped")] public int Dropped { get; set; }
        /// <summary>
        /// The source answered only partly (entries it couldn't read, or upstream errors next to data): the review should
        /// say the list may be incomplete. Omitted when false.
        /// </summary>
        [JsonPropertyName("partial")][JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] public bool Partial { get; set; }
        /// <summary>
        /// Entries are grouped runs (Chronolists: consecutive episodes of one season → one entry), each carrying
        /// <see cref="ImportEntryDto.SourceKeys"/> and a <see cref="ImportEntryDto.Prepared"/> resolution.
        /// </summary>
        [JsonPropertyName("grouped")] public bool Grouped { get; set; }
        /// <summary>Grouped sources: every source key of the entries shown, in order (send as <c>source.snapshotKeys</c>).</summary>
        [JsonPropertyName("snapshotKeys")][JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public List<string>? SnapshotKeys { get; set; }
        /// <summary>What the snapshot is good for (state, digest); left out when <see cref="CountsHidden"/>.</summary>
        [JsonPropertyName("snapshot")][JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public SourceSnapshotDto? Snapshot { get; set; }
        /// <summary>
        /// True when the caller's parental controls left entries out: totals, dropped counts and the snapshot digest are
        /// withheld so nothing tells how many (A2).
        /// </summary>
        [JsonPropertyName("countsHidden")][JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public bool? CountsHidden { get; set; }
    }

    /// <summary>Response of GET acquire/lists/import/providers: which list sources work on this server (no secrets).</summary>
    public sealed class SourceProvidersDto
    {
        /// <summary>Importing (paste, file, URL review) is on.</summary>
        [JsonPropertyName("import")] public bool Import { get; set; }
        /// <summary>From URL is on (each provider below still has its own switch).</summary>
        [JsonPropertyName("sources")] public bool Sources { get; set; }
        /// <summary>MDBList public lists (keyless).</summary>
        [JsonPropertyName("mdblist")] public bool Mdblist { get; set; }
        /// <summary>MDBList's API for administrators (switch on and an MDBList key saved); false for everyone else.</summary>
        [JsonPropertyName("mdblistApi")] public bool MdblistApi { get; set; }
        /// <summary>TMDB user lists and charts (TMDB key needed).</summary>
        [JsonPropertyName("tmdbLists")] public bool TmdbLists { get; set; }
        /// <summary>TMDB collections / trending / upcoming (TMDB key, or Seerr as a labelled fallback).</summary>
        [JsonPropertyName("tmdbCharts")] public bool TmdbCharts { get; set; }
        /// <summary>Trakt (switch on and a Trakt client id saved).</summary>
        [JsonPropertyName("trakt")] public bool Trakt { get; set; }
        /// <summary>IMDb (the administrator's opt-in to an unofficial source).</summary>
        [JsonPropertyName("imdb")] public bool Imdb { get; set; }
        /// <summary>chronolists.com chronological watch orders (no key).</summary>
        [JsonPropertyName("chronolists")] public bool Chronolists { get; set; }
        /// <summary>Title lookups for pasted lines work: <c>tmdb</c>, <c>seerr</c> or empty (none).</summary>
        [JsonPropertyName("metadataProvider")] public string MetadataProvider { get; set; } = string.Empty;
        /// <summary>Entry cap per fetch.</summary>
        [JsonPropertyName("maxItems")] public int MaxItems { get; set; }
        /// <summary>Entries per resolve call.</summary>
        [JsonPropertyName("resolveChunk")] public int ResolveChunk { get; set; }
    }
}
