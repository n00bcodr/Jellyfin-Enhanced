using System;
using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders
{
    /// <summary>The kinds of Jellyfin list a placeholder document can belong to.</summary>
    public static class ListKinds
    {
        /// <summary>A Jellyfin playlist (ordered, owner + shares).</summary>
        public const string Playlist = "playlist";

        /// <summary>A Jellyfin collection (BoxSet; unordered for placeholders).</summary>
        public const string Collection = "collection";
    }

    /// <summary>The granularity of a placeholder.</summary>
    public static class PlaceholderKinds
    {
        /// <summary>A whole movie.</summary>
        public const string Movie = "movie";

        /// <summary>A whole TV series.</summary>
        public const string Series = "series";

        /// <summary>One season of a TV series.</summary>
        public const string Season = "season";

        /// <summary>Specific episodes of ONE season of a TV series.</summary>
        public const string Episodes = "episodes";

        /// <summary>A free-text entry with no TMDB match (can be linked to a title later).</summary>
        public const string Custom = "custom";

        /// <summary>True when <paramref name="kind"/> is one of the known kinds.</summary>
        /// <param name="kind">The kind to test.</param>
        /// <returns>Whether the kind is known.</returns>
        public static bool IsKnown(string? kind) =>
            kind is Movie or Series or Season or Episodes or Custom;
    }

    /// <summary>
    /// The persisted placeholder document of ONE Jellyfin list (playlist or collection), stored as
    /// <c>lists/&lt;listIdN&gt;.json</c> in Jellyfin Enhanced's data folder. Mutated only under the store's per-list
    /// lock; every persisted change bumps <see cref="Rev"/>. Internal: never sent to a browser as is.
    /// </summary>
    public sealed class ListDoc
    {
        /// <summary>The current document schema (Requests &amp; downloads lists). Schema 1 is closed PR #936's experimental format, read only by <c>ExperimentalListImporter</c>.</summary>
        public const int CurrentSchema = 2;

        /// <summary>
        /// Document schema version (2; schema-1 documents are imported, never read as lists). No default: a stored document
        /// without the field reads as 0 and is refused; the store writes <see cref="CurrentSchema"/> on every save.
        /// </summary>
        [JsonPropertyName("schema")]
        public int Schema { get; set; }

        /// <summary>The Jellyfin list id ("N" format, lowercase).</summary>
        [JsonPropertyName("listId")]
        public string ListId { get; set; } = string.Empty;

        /// <summary><see cref="ListKinds.Playlist"/> or <see cref="ListKinds.Collection"/>.</summary>
        [JsonPropertyName("listKind")]
        public string ListKind { get; set; } = ListKinds.Playlist;

        /// <summary>Monotonic revision, bumped on every persisted change (optimistic concurrency for clients).</summary>
        [JsonPropertyName("rev")]
        public int Rev { get; set; }

        /// <summary>
        /// Playlists only: the canonical, user-independent order of real entries (<c>e:&lt;itemIdN&gt;:&lt;k&gt;</c>)
        /// and placeholders (<c>p:&lt;phId&gt;</c>). Empty for collections.
        /// </summary>
        [JsonPropertyName("order")]
        public List<string> Order { get; set; } = new();

        /// <summary>The placeholders of this list.</summary>
        [JsonPropertyName("items")]
        public List<Placeholder> Items { get; set; } = new();

        /// <summary>Optional linked external list (linked-list sync; see the import/source track).</summary>
        [JsonPropertyName("source")]
        public ListSource? Source { get; set; }

        /// <summary>Pending membership placements (persisted before Jellyfin is mutated, cleared after placement settles).</summary>
        [JsonPropertyName("intents")]
        public List<SwapIntent> Intents { get; set; } = new();

        /// <summary>Last 32 abandoned placements, retaining the original plan/actor and landed membership provenance.</summary>
        [JsonPropertyName("abandonedPlacements")]
        public List<SwapIntent> AbandonedPlacements { get; set; } = new();

        /// <summary>When the document was last written (UTC ISO-8601).</summary>
        [JsonPropertyName("updatedAt")]
        public string? UpdatedAt { get; set; }

        /// <summary>
        /// Automatic swap-in consent for this list (D29): who turned it on (an editor whose own swap-in preference must
        /// still be on, and who must still be able to edit the list, when a swap runs). Null = off (the default, also for
        /// imported lists).
        /// </summary>
        [JsonPropertyName("swapIn")]
        public ListConsent? SwapIn { get; set; }

        /// <summary>
        /// Set while the list waits for reconciliation after a restore or an import: pending swap intents are resolved
        /// against Jellyfin's real membership before anything new is inserted. Cleared by the next reconciliation.
        /// </summary>
        [JsonPropertyName("reconcile")]
        public string? Reconcile { get; set; }

        /// <summary>Where the document came from when it was imported (D33 compatibility importer), else null.</summary>
        [JsonPropertyName("importedFrom")]
        public ListImportProvenance? ImportedFrom { get; set; }
    }

    /// <summary>A recorded per-list consent: who gave it and when (rechecked at use).</summary>
    public sealed class ListConsent
    {
        /// <summary>The user ("N") who turned it on.</summary>
        [JsonPropertyName("byUserId")]
        public string ByUserId { get; set; } = string.Empty;

        /// <summary>When (UTC ISO-8601).</summary>
        [JsonPropertyName("at")]
        public string At { get; set; } = string.Empty;
    }

    /// <summary>What a D33 import read: the schema-1 document's revision and digest, and when.</summary>
    public sealed class ListImportProvenance
    {
        /// <summary>The schema the source document had (1).</summary>
        [JsonPropertyName("schema")]
        public int Schema { get; set; }

        /// <summary>The source document's revision.</summary>
        [JsonPropertyName("rev")]
        public int Rev { get; set; }

        /// <summary>SHA-256 of the source document's bytes (hex).</summary>
        [JsonPropertyName("sha256")]
        public string Sha256 { get; set; } = string.Empty;

        /// <summary>When it was imported (UTC ISO-8601).</summary>
        [JsonPropertyName("at")]
        public string At { get; set; } = string.Empty;
    }

    /// <summary>A title that is not (yet) in the library, shown in a list.</summary>
    public sealed class Placeholder
    {
        /// <summary>Placeholder id ("N" format guid).</summary>
        [JsonPropertyName("id")]
        public string Id { get; set; } = string.Empty;

        /// <summary>One of <see cref="PlaceholderKinds"/>.</summary>
        [JsonPropertyName("kind")]
        public string Kind { get; set; } = PlaceholderKinds.Movie;

        /// <summary>"movie" or "tv".</summary>
        [JsonPropertyName("mediaType")]
        public string MediaType { get; set; } = "movie";

        /// <summary>TMDB id (null for custom entries).</summary>
        [JsonPropertyName("tmdbId")]
        public int? TmdbId { get; set; }

        /// <summary>TVDB id (TV only, optional).</summary>
        [JsonPropertyName("tvdbId")]
        public int? TvdbId { get; set; }

        /// <summary>IMDb id (<c>tt\d+</c>, optional).</summary>
        [JsonPropertyName("imdbId")]
        public string? ImdbId { get; set; }

        /// <summary>Display title (1..200 chars).</summary>
        [JsonPropertyName("title")]
        public string Title { get; set; } = string.Empty;

        /// <summary>Release / first-air year.</summary>
        [JsonPropertyName("year")]
        public int? Year { get; set; }

        /// <summary>Release date (yyyy-MM-dd) per kind; null = TBA.</summary>
        [JsonPropertyName("releaseDate")]
        public string? ReleaseDate { get; set; }

        /// <summary>TMDB poster path (e.g. "/abc.jpg").</summary>
        [JsonPropertyName("posterPath")]
        public string? PosterPath { get; set; }

        /// <summary>
        /// True when a TMDB placeholder's <see cref="PosterPath"/> is the one a client sent and no poster source could check
        /// it (neither Seerr nor a TMDB key was configured): viewers with parental controls never get it, and the next
        /// metadata pass that can read the title's own poster replaces it. Null once the poster came from the server.
        /// </summary>
        [JsonPropertyName("posterUnverified")]
        public bool? PosterUnverified { get; set; }

        /// <summary>Short overview (≤ 1000 chars).</summary>
        [JsonPropertyName("overview")]
        public string? Overview { get; set; }

        /// <summary>Season number (season and episodes kinds).</summary>
        [JsonPropertyName("seasonNumber")]
        public int? SeasonNumber { get; set; }

        /// <summary>Episodes kind: the listed episodes, all of season <see cref="SeasonNumber"/> (single-season invariant).</summary>
        [JsonPropertyName("episodes")]
        public List<PlaceholderEpisode> Episodes { get; set; } = new();

        /// <summary>Season/series: TMDB aired episode count (fill progress target).</summary>
        [JsonPropertyName("episodeTotal")]
        public int? EpisodeTotal { get; set; }

        /// <summary>Season/series: the expected episode set (maintained by later phases).</summary>
        [JsonPropertyName("expected")]
        public List<PlaceholderEpisode> Expected { get; set; } = new();

        /// <summary>A partial/contradictory refresh withdrew completion authority; retained expectations are display facts only.</summary>
        [JsonPropertyName("expectedUncertain")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
        public bool ExpectedUncertain { get; set; }

        /// <summary>Positive reconciliation authority; absence, including every legacy document, means Unknown.</summary>
        [JsonPropertyName("completionAuthority")]
        public CompletionAuthority? CompletionAuthority { get; set; }

        /// <summary>Why the latest reconciliation could not grant authority; retained facts are display only.</summary>
        [JsonPropertyName("completionReason")]
        public string? CompletionReason { get; set; }

        /// <summary>Season/series: whether the season/show is still in production (maintained by later phases).</summary>
        [JsonPropertyName("inProduction")]
        public bool? InProduction { get; set; }

        /// <summary>Episodes that were already swapped in as real items.</summary>
        [JsonPropertyName("filled")]
        public List<FilledEpisode> Filled { get; set; } = new();

        /// <summary>Free-text note (≤ 300 chars).</summary>
        [JsonPropertyName("note")]
        public string? Note { get; set; }

        /// <summary>Jellyfin user id ("N") of the user who added it.</summary>
        [JsonPropertyName("addedBy")]
        public string AddedBy { get; set; } = string.Empty;

        /// <summary>When it was added (UTC ISO-8601).</summary>
        [JsonPropertyName("addedAt")]
        public string AddedAt { get; set; } = string.Empty;

        /// <summary>Sync provenance key (<c>type|tmdbId|season|episode</c>) when a linked source added it.</summary>
        [JsonPropertyName("sourceKey")]
        public string? SourceKey { get; set; }

        /// <summary>
        /// The edition this entry stands for: <c>standard</c> (default; also every imported #936 entry) or <c>4k</c>.
        /// Part of the entry's identity and of what a request from the list asks for; swap-in only takes a copy in that
        /// edition.
        /// </summary>
        [JsonPropertyName("edition")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? Edition { get; set; }
    }

    /// <summary>One episode coordinate (listed, or expected) of a TV placeholder.</summary>
    public sealed class PlaceholderEpisode
    {
        /// <summary>Season number.</summary>
        [JsonPropertyName("s")]
        public int S { get; set; }

        /// <summary>Episode number.</summary>
        [JsonPropertyName("e")]
        public int E { get; set; }

        /// <summary>Optional episode title.</summary>
        [JsonPropertyName("title")]
        public string? Title { get; set; }

        /// <summary>Optional air date (yyyy-MM-dd).</summary>
        [JsonPropertyName("airDate")]
        public string? AirDate { get; set; }
    }

    /// <summary>An episode of a TV placeholder that already arrived and was inserted as a real item.</summary>
    public sealed class FilledEpisode
    {
        /// <summary>The Jellyfin episode item id ("N").</summary>
        [JsonPropertyName("itemId")]
        public string ItemId { get; set; } = string.Empty;

        /// <summary>Season number.</summary>
        [JsonPropertyName("s")]
        public int S { get; set; }

        /// <summary>Episode number.</summary>
        [JsonPropertyName("e")]
        public int E { get; set; }

        /// <summary>
        /// Collection seasons: the Season item ("N") the episode is in the collection through (null for playlists and
        /// fills recorded before it was kept). A replaced episode whose new Season item differs is an arrival for it.
        /// </summary>
        [JsonPropertyName("via")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? Via { get; set; }
    }

    /// <summary>
    /// A linked external list (MDBList / TMDB / Trakt / IMDb / Chronolists) that is re-fetched by the linked-list sync.
    /// List core keeps it in the document (ownership, tombstones, snapshots, generation) and transfers ownership on
    /// swap-in; fetching and syncing it belong to the import/source track.
    /// </summary>
    public sealed class ListSource
    {
        /// <summary>Source kind: "mdblist" | "tmdb" | "trakt" | "imdb".</summary>
        [JsonPropertyName("kind")]
        public string Kind { get; set; } = string.Empty;

        /// <summary>The provider actually used to fetch (never switched silently).</summary>
        [JsonPropertyName("provider")]
        public string? Provider { get; set; }

        /// <summary>The list URL the user linked.</summary>
        [JsonPropertyName("url")]
        public string Url { get; set; } = string.Empty;

        /// <summary>Display title of the source list.</summary>
        [JsonPropertyName("title")]
        public string? Title { get; set; }

        /// <summary>Whether the scheduled sync adds new entries.</summary>
        [JsonPropertyName("syncEnabled")]
        public bool SyncEnabled { get; set; }

        /// <summary>Whether sync removes entries it added that left the source.</summary>
        [JsonPropertyName("removeDropped")]
        public bool RemoveDropped { get; set; }

        /// <summary>User ("N") who linked the source; sync acts with their rights.</summary>
        [JsonPropertyName("linkedByUserId")]
        public string? LinkedByUserId { get; set; }

        /// <summary>Bumped on every link/unlink so a running sync can detect a stale link.</summary>
        [JsonPropertyName("generation")]
        public int Generation { get; set; }

        /// <summary>Last sync time (UTC ISO-8601).</summary>
        [JsonPropertyName("lastSyncAt")]
        public string? LastSyncAt { get; set; }

        /// <summary>Short human-readable result of the last sync.</summary>
        [JsonPropertyName("lastSyncResult")]
        public string? LastSyncResult { get; set; }

        /// <summary>Why the link is paused (null = active).</summary>
        [JsonPropertyName("pausedReason")]
        public string? PausedReason { get; set; }

        /// <summary>Source keys of the last complete, successfully applied fetch.</summary>
        [JsonPropertyName("lastSnapshotKeys")]
        public List<string> LastSnapshotKeys { get; set; } = new();

        /// <summary>Entries the sync itself added, by source key.</summary>
        [JsonPropertyName("owned")]
        public Dictionary<string, SourceOwnership> Owned { get; set; } = new(StringComparer.Ordinal);

        /// <summary>Source keys an editor removed after sync added them (never re-added), with removal time.</summary>
        [JsonPropertyName("userRemovedKeys")]
        public Dictionary<string, string> UserRemovedKeys { get; set; } = new(StringComparer.Ordinal);

        /// <summary>Structured outcome of the last sync/import, for localised display (<see cref="LastSyncResult"/> is the English fallback).</summary>
        [JsonPropertyName("lastSync")]
        public SourceSyncSummary? LastSync { get; set; }

        /// <summary>Machine code of <see cref="PausedReason"/>: linker_missing | linker_cannot_edit | linker_cannot_see | url_unsupported.</summary>
        [JsonPropertyName("pausedCode")]
        public string? PausedCode { get; set; }
    }

    /// <summary>Structured outcome of a linked list's last sync or import (no user names, no English).</summary>
    public sealed class SourceSyncSummary
    {
        /// <summary>ok | imported | failed | paused.</summary>
        [JsonPropertyName("state")]
        public string State { get; set; } = "ok";

        /// <summary>Failure/pause code (fetch error codes such as not_found or rate_limited, seerr_unavailable, apply_failed, or a pause code).</summary>
        [JsonPropertyName("code")]
        public string? Code { get; set; }

        /// <summary>Entries added.</summary>
        [JsonPropertyName("added")]
        public int Added { get; set; }

        /// <summary>Entries removed because they left the source.</summary>
        [JsonPropertyName("removed")]
        public int Removed { get; set; }

        /// <summary>Entries that left the source but were kept.</summary>
        [JsonPropertyName("kept")]
        public int Kept { get; set; }

        /// <summary>Source entries not found (no usable id, or no confident match).</summary>
        [JsonPropertyName("unresolved")]
        public int Unresolved { get; set; }

        /// <summary>Duplicate source entries ignored.</summary>
        [JsonPropertyName("duplicates")]
        public int Duplicates { get; set; }

        /// <summary>The list reached its placeholder cap.</summary>
        [JsonPropertyName("listFull")]
        public bool ListFull { get; set; }

        /// <summary>The source has more entries than are synced.</summary>
        [JsonPropertyName("truncated")]
        public bool Truncated { get; set; }

        /// <summary>The source answered only partly (nothing was removed).</summary>
        [JsonPropertyName("partial")]
        public bool Partial { get; set; }
    }

    /// <summary>What a sync-added source key currently owns in the list.</summary>
    public sealed class SourceOwnership
    {
        /// <summary>The placeholder the sync added, if still a placeholder.</summary>
        [JsonPropertyName("phId")]
        public string? PhId { get; set; }

        /// <summary>Real item ids ("N") the sync added (or that swapped in for its placeholder).</summary>
        [JsonPropertyName("itemIds")]
        public List<string> ItemIds { get; set; } = new();
    }

    /// <summary>
    /// A swap-in that is about to mutate Jellyfin (A6). Persisted first so a crash between the Jellyfin
    /// mutation and the placeholder retirement can be completed or rolled back on the next pass (playlist inserts and
    /// collection adds).
    /// </summary>
    public sealed class SwapIntent
    {
        /// <summary>The placeholder being swapped in (empty for a deliberate apply).</summary>
        [JsonPropertyName("phId")]
        public string PhId { get; set; } = string.Empty;

        /// <summary>The actor of an interrupted deliberate apply ("N"); null for a consented placeholder swap.</summary>
        [JsonPropertyName("byUserId")]
        public string? ByUserId { get; set; }

        /// <summary>The real item ids ("N") being inserted.</summary>
        [JsonPropertyName("itemIds")]
        public List<string> ItemIds { get; set; } = new();

        /// <summary>
        /// Planned coordinates of exact Episode items, verified by the resolver before the insert. These are not fills:
        /// recovery credits only items whose occurrence count increased. Older intents fall back to native item facts.
        /// </summary>
        [JsonPropertyName("episodes")]
        public List<FilledEpisode> Episodes { get; set; } = new();

        /// <summary>The real token the items go after (null = list start).</summary>
        [JsonPropertyName("anchor")]
        public string? Anchor { get; set; }

        /// <summary>
        /// Playlists: the index in the document's order the items go to (null in older documents; recovery then puts
        /// them right after <see cref="Anchor"/>).
        /// </summary>
        [JsonPropertyName("index")]
        public int? Index { get; set; }

        /// <summary>Occurrence count per item id before the mutation (to tell done from not-done).</summary>
        [JsonPropertyName("occurrenceCountsBefore")]
        public Dictionary<string, int> OccurrenceCountsBefore { get; set; } = new(StringComparer.Ordinal);

        /// <summary>
        /// The order JE knows its acknowledged native write produced, verified against storage and updated together
        /// with StoredSaveStamp by the shared save observer. Recovery compares surviving tokens for later reorders.
        /// Null when proof is missing or unknown; a misplaced entry then cannot safely be moved.
        /// </summary>
        [JsonPropertyName("nativeOrder")]
        public List<string>? NativeOrder { get; set; }

        /// <summary>
        /// The list's durable DateLastSaved immediately after JE's last native write for this placement. Only the
        /// unchanged repository stamp permits a recovery move; null (old or interrupted observation) fails closed.
        /// </summary>
        [JsonPropertyName("storedSaveStamp")]
        public DateTime? StoredSaveStamp { get; set; }

        /// <summary>A person's later JE reorder supersedes this plan, including a reorder back to the same native order.</summary>
        [JsonPropertyName("supersededByReorder")]
        public bool SupersededByReorder { get; set; }

        /// <summary>Recovery attempts started (persisted before awaiting a move; at most three).</summary>
        [JsonPropertyName("attempts")]
        public int Attempts { get; set; }

        /// <summary>Why placement was abandoned; null while pending.</summary>
        [JsonPropertyName("abandonedReason")]
        public string? AbandonedReason { get; set; }

        /// <summary>When placement was abandoned (UTC ISO-8601).</summary>
        [JsonPropertyName("abandonedAt")]
        public string? AbandonedAt { get; set; }

        /// <summary>When the intent was recorded (UTC ISO-8601).</summary>
        [JsonPropertyName("createdAt")]
        public string CreatedAt { get; set; } = string.Empty;
    }
}
