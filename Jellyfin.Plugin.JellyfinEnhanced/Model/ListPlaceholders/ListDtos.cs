using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders
{
    // Wire contracts of /JellyfinEnhanced/acquire/lists (Requests & downloads, phase 4: lists). Jellyfin's MVC JSON
    // options keep C# names (PascalCase), so every member carries an explicit camelCase [JsonPropertyName]. Every
    // response is built for one caller (Family / Manager / Admin): no arr instance, path, profile or other person's name.

    /// <summary>A list as one caller may see it (GET /{listId} and every mutation response).</summary>
    public sealed class ListViewDto
    {
        /// <summary>The list id ("N").</summary>
        [JsonPropertyName("listId")] public string ListId { get; set; } = string.Empty;

        /// <summary>"playlist" or "collection".</summary>
        [JsonPropertyName("listKind")] public string ListKind { get; set; } = ListKinds.Playlist;

        /// <summary>Document revision; send it back on PUT /order, PATCH and DELETE.</summary>
        [JsonPropertyName("rev")] public int Rev { get; set; }

        /// <summary>Whether the caller may edit placeholders (JE rules: owner / CanEdit share / admin; collections: admin or collection manager).</summary>
        [JsonPropertyName("canEdit")] public bool CanEdit { get; set; }

        /// <summary>Whether the caller can edit the list in Jellyfin itself (owner or CanEdit share; collections: same as canEdit).</summary>
        [JsonPropertyName("nativeCanEdit")] public bool NativeCanEdit { get; set; }

        /// <summary>
        /// What the caller may do with the list, decided on the server from the admin switches, the caller's rights and
        /// preferences: <c>edit</c>, <c>reorder</c>, <c>request</c>, <c>requestAll</c>, <c>swapIn</c> (may turn automatic
        /// swap-in on or off). Clients show only these.
        /// </summary>
        [JsonPropertyName("actions")] public List<string> Actions { get; set; } = new();

        /// <summary>Whether request status is shown on the placeholders (admin switch and the caller's preference).</summary>
        [JsonPropertyName("statusShown")] public bool StatusShown { get; set; }

        /// <summary>Whether automatic swap-in is on for this list (who turned it on is not shown).</summary>
        [JsonPropertyName("swapIn")] public bool SwapIn { get; set; }

        /// <summary>True while the list waits for reconciliation (after a restore or an import); nothing new is inserted meanwhile.</summary>
        [JsonPropertyName("reconciling")] public bool Reconciling { get; set; }

        /// <summary>Owner/admin placement receipts, filtered to their visible landed entries; no actor or source identity.</summary>
        [JsonPropertyName("placements")] public List<PlacementStatusDto> Placements { get; set; } = new();

        /// <summary>The placeholders the caller may see.</summary>
        [JsonPropertyName("placeholders")] public List<PlaceholderDto> Placeholders { get; set; } = new();

        /// <summary>Playlists: the caller's projection of the canonical order (tokens). Null for collections.</summary>
        [JsonPropertyName("order")] public List<string>? Order { get; set; }

        /// <summary>Linked source summary (never internal sync state); null when none.</summary>
        [JsonPropertyName("source")] public ListSourceDto? Source { get; set; }
    }

    /// <summary>A pending or abandoned placement visible to a list's current owner or a human administrator.</summary>
    public sealed class PlacementStatusDto
    {
        /// <summary>pending or abandoned.</summary>
        [JsonPropertyName("state")] public string State { get; set; } = string.Empty;
        /// <summary>actor_revoked, actor_deleted, actor_disabled or placement_retry_limit; null while pending.</summary>
        [JsonPropertyName("reason")] public string? Reason { get; set; }
        /// <summary>Recovery attempts started.</summary>
        [JsonPropertyName("attempts")] public int Attempts { get; set; }
        /// <summary>When abandoned, if applicable (UTC ISO-8601).</summary>
        [JsonPropertyName("at")] public string? At { get; set; }
        /// <summary>Visible landed real-entry tokens only.</summary>
        [JsonPropertyName("tokens")] public List<string> Tokens { get; set; } = new();
    }

    /// <summary>A placeholder as returned to clients.</summary>
    public sealed class PlaceholderDto
    {
        /// <summary>Placeholder id.</summary>
        [JsonPropertyName("id")] public string Id { get; set; } = string.Empty;
        /// <summary>Order token (<c>p:&lt;id&gt;</c>).</summary>
        [JsonPropertyName("token")] public string Token { get; set; } = string.Empty;
        /// <summary>Kind.</summary>
        [JsonPropertyName("kind")] public string Kind { get; set; } = string.Empty;
        /// <summary>"movie" or "tv".</summary>
        [JsonPropertyName("mediaType")] public string MediaType { get; set; } = string.Empty;
        /// <summary>TMDB id.</summary>
        [JsonPropertyName("tmdbId")] public int? TmdbId { get; set; }
        /// <summary>TVDB id.</summary>
        [JsonPropertyName("tvdbId")] public int? TvdbId { get; set; }
        /// <summary>IMDb id.</summary>
        [JsonPropertyName("imdbId")] public string? ImdbId { get; set; }
        /// <summary>Title.</summary>
        [JsonPropertyName("title")] public string Title { get; set; } = string.Empty;
        /// <summary>Year.</summary>
        [JsonPropertyName("year")] public int? Year { get; set; }
        /// <summary>Release date (yyyy-MM-dd) or null (TBA).</summary>
        [JsonPropertyName("releaseDate")] public string? ReleaseDate { get; set; }
        /// <summary>True when the release date is today or earlier (UTC).</summary>
        [JsonPropertyName("released")] public bool Released { get; set; }
        /// <summary>TMDB poster path.</summary>
        [JsonPropertyName("posterPath")] public string? PosterPath { get; set; }
        /// <summary>Overview.</summary>
        [JsonPropertyName("overview")] public string? Overview { get; set; }
        /// <summary>Season number.</summary>
        [JsonPropertyName("seasonNumber")] public int? SeasonNumber { get; set; }
        /// <summary>Listed episodes.</summary>
        [JsonPropertyName("episodes")] public List<PlaceholderEpisode> Episodes { get; set; } = new();
        /// <summary>Season/series fill target.</summary>
        [JsonPropertyName("episodeTotal")] public int? EpisodeTotal { get; set; }
        /// <summary>How many episodes of the scope are in the list (only those the caller can access are counted).</summary>
        [JsonPropertyName("filledCount")] public int FilledCount { get; set; }
        /// <summary>Note.</summary>
        [JsonPropertyName("note")] public string? Note { get; set; }
        /// <summary>Whether the caller added this placeholder.</summary>
        [JsonPropertyName("addedByMe")] public bool AddedByMe { get; set; }
        /// <summary>When it was added.</summary>
        [JsonPropertyName("addedAt")] public string AddedAt { get; set; } = string.Empty;
        /// <summary>The title key requests and status use (<c>movie:tmdb:603</c>, <c>tv:tvdb:81189</c>); null for custom entries.</summary>
        [JsonPropertyName("titleKey")] public string? TitleKey { get; set; }
        /// <summary><c>standard</c> or <c>4k</c>.</summary>
        [JsonPropertyName("edition")] public string Edition { get; set; } = "standard";
        /// <summary>
        /// The caller's request status of the title (the shared Requests &amp; downloads status for this viewer: stage,
        /// reason, journey, dates, actions), only while <see cref="ListViewDto.StatusShown"/>; null when not shown or unknown.
        /// List completion (<see cref="FilledCount"/>, <see cref="ExpectedCount"/>) is separate from it.
        /// </summary>
        [JsonPropertyName("status")] public JsonElement? Status { get; set; }
        /// <summary>What the caller may do with this entry: <c>request</c>, <c>remove</c>, <c>note</c>, <c>link</c> (custom entries).</summary>
        [JsonPropertyName("actions")] public List<string> Actions { get; set; } = new();
        /// <summary>
        /// Episode-filling kinds: how many episodes the placeholder stands for — the listed episodes (episodes kind) or
        /// the expected set from the title's metadata (season/series; includes an announced next episode); 0 = not known yet.
        /// </summary>
        [JsonPropertyName("expectedCount")] public int ExpectedCount { get; set; }
        /// <summary>How many of those have aired (air date today or earlier, UTC): the "m" of "n of m aired".</summary>
        [JsonPropertyName("airedCount")] public int AiredCount { get; set; }
        /// <summary>TV: whether the show is still in production (null = unknown). A season/series placeholder stays until finished.</summary>
        [JsonPropertyName("inProduction")] public bool? InProduction { get; set; }
        /// <summary>A library item that matched this placeholder and is being added right now ("Available — adding…"); only when the caller can access it.</summary>
        [JsonPropertyName("inLibraryItemId")] public string? InLibraryItemId { get; set; }
    }

    /// <summary>Client-visible summary of a linked source.</summary>
    public sealed class ListSourceDto
    {
        /// <summary>Source kind.</summary>
        [JsonPropertyName("kind")] public string Kind { get; set; } = string.Empty;
        /// <summary>URL.</summary>
        [JsonPropertyName("url")] public string Url { get; set; } = string.Empty;
        /// <summary>Title.</summary>
        [JsonPropertyName("title")] public string? Title { get; set; }
        /// <summary>Sync on/off.</summary>
        [JsonPropertyName("syncEnabled")] public bool SyncEnabled { get; set; }
        /// <summary>Remove dropped entries.</summary>
        [JsonPropertyName("removeDropped")] public bool RemoveDropped { get; set; }
        /// <summary>Last sync time.</summary>
        [JsonPropertyName("lastSyncAt")] public string? LastSyncAt { get; set; }
        /// <summary>Last sync result.</summary>
        [JsonPropertyName("lastSyncResult")] public string? LastSyncResult { get; set; }
        /// <summary>Why the link is paused.</summary>
        [JsonPropertyName("pausedReason")] public string? PausedReason { get; set; }
        /// <summary>Structured last sync outcome (localise from this; lastSyncResult is the English fallback).</summary>
        [JsonPropertyName("lastSync")] public SourceSyncSummary? LastSync { get; set; }
        /// <summary>Machine code of the pause.</summary>
        [JsonPropertyName("pausedCode")] public string? PausedCode { get; set; }
        /// <summary>True when the caller doesn't see every entry of the list: the sync counts and the English summary are left out (A2).</summary>
        [JsonPropertyName("countsHidden")] public bool? CountsHidden { get; set; }
    }

    /// <summary>A placeholder to create (client input; validated server-side).</summary>
    public sealed class NewPlaceholderDto
    {
        /// <summary>Kind.</summary>
        [JsonPropertyName("kind")] public string? Kind { get; set; }
        /// <summary>"movie" or "tv".</summary>
        [JsonPropertyName("mediaType")] public string? MediaType { get; set; }
        /// <summary>TMDB id.</summary>
        [JsonPropertyName("tmdbId")] public int? TmdbId { get; set; }
        /// <summary>TVDB id.</summary>
        [JsonPropertyName("tvdbId")] public int? TvdbId { get; set; }
        /// <summary>IMDb id.</summary>
        [JsonPropertyName("imdbId")] public string? ImdbId { get; set; }
        /// <summary>Title.</summary>
        [JsonPropertyName("title")] public string? Title { get; set; }
        /// <summary>Year.</summary>
        [JsonPropertyName("year")] public int? Year { get; set; }
        /// <summary>Release date yyyy-MM-dd.</summary>
        [JsonPropertyName("releaseDate")] public string? ReleaseDate { get; set; }
        /// <summary>TMDB poster path.</summary>
        [JsonPropertyName("posterPath")] public string? PosterPath { get; set; }
        /// <summary>Overview.</summary>
        [JsonPropertyName("overview")] public string? Overview { get; set; }
        /// <summary>Season number.</summary>
        [JsonPropertyName("seasonNumber")] public int? SeasonNumber { get; set; }
        /// <summary>Episodes (episodes kind).</summary>
        [JsonPropertyName("episodes")] public List<PlaceholderEpisode>? Episodes { get; set; }
        /// <summary>Season/series aired episode count.</summary>
        [JsonPropertyName("episodeTotal")] public int? EpisodeTotal { get; set; }
        /// <summary>Note.</summary>
        [JsonPropertyName("note")] public string? Note { get; set; }
        /// <summary><c>standard</c> (default) or <c>4k</c>.</summary>
        [JsonPropertyName("edition")] public string? Edition { get; set; }
    }

    /// <summary>Where new entries go in a playlist: after a token, at the start, or (both unset) at the end.</summary>
    public sealed class PositionDto
    {
        /// <summary>Insert after this token of the caller's projection.</summary>
        [JsonPropertyName("afterToken")] public string? AfterToken { get; set; }
        /// <summary>Insert at the very start.</summary>
        [JsonPropertyName("atStart")] public bool AtStart { get; set; }
    }

    /// <summary>Body of POST /{listId}/items.</summary>
    public sealed class AddItemsRequest
    {
        /// <summary>Client request id for idempotent retries.</summary>
        [JsonPropertyName("requestId")] public string? RequestId { get; set; }
        /// <summary>Optional expected revision (409 when stale).</summary>
        [JsonPropertyName("rev")] public int? Rev { get; set; }
        /// <summary>Placeholders to add, in order.</summary>
        [JsonPropertyName("placeholders")] public List<NewPlaceholderDto>? Placeholders { get; set; }
        /// <summary>Playlist position.</summary>
        [JsonPropertyName("position")] public PositionDto? Position { get; set; }
    }

    /// <summary>One entry of an ordered apply: a real library item or a placeholder.</summary>
    public sealed class ApplyEntryDto
    {
        /// <summary>"item" or "placeholder".</summary>
        [JsonPropertyName("type")] public string? Type { get; set; }
        /// <summary>The library item id (type item).</summary>
        [JsonPropertyName("itemId")] public string? ItemId { get; set; }
        /// <summary>The placeholder (type placeholder).</summary>
        [JsonPropertyName("placeholder")] public NewPlaceholderDto? Placeholder { get; set; }
    }

    /// <summary>Body of POST /{listId}/apply.</summary>
    public sealed class ApplyRequest
    {
        /// <summary>Client request id.</summary>
        [JsonPropertyName("requestId")] public string? RequestId { get; set; }
        /// <summary>Optional expected revision.</summary>
        [JsonPropertyName("rev")] public int? Rev { get; set; }
        /// <summary>Ordered entries.</summary>
        [JsonPropertyName("entries")] public List<ApplyEntryDto>? Entries { get; set; }
        /// <summary>Playlist position.</summary>
        [JsonPropertyName("position")] public PositionDto? Position { get; set; }
    }

    /// <summary>Body of POST /playlists and POST /collections.</summary>
    public sealed class CreateListRequest
    {
        /// <summary>Client request id.</summary>
        [JsonPropertyName("requestId")] public string? RequestId { get; set; }
        /// <summary>Name of the new list.</summary>
        [JsonPropertyName("name")] public string? Name { get; set; }
        /// <summary>Playlists: make it visible to every user (Jellyfin "public").</summary>
        [JsonPropertyName("isPublic")] public bool IsPublic { get; set; }
        /// <summary>Optional initial entries, applied in order.</summary>
        [JsonPropertyName("entries")] public List<ApplyEntryDto>? Entries { get; set; }
    }

    /// <summary>Link a custom placeholder to a TMDB title.</summary>
    public sealed class PatchPlaceholderRequest
    {
        /// <summary>Client request id.</summary>
        [JsonPropertyName("requestId")] public string? RequestId { get; set; }
        /// <summary>Required expected revision.</summary>
        [JsonPropertyName("rev")] public int? Rev { get; set; }
        /// <summary>New note (empty string clears; null leaves it unchanged).</summary>
        [JsonPropertyName("note")] public string? Note { get; set; }
        /// <summary>Custom entries only: the title to link to (becomes movie/series/season/episodes).</summary>
        [JsonPropertyName("link")] public NewPlaceholderDto? Link { get; set; }
    }

    /// <summary>Body of PUT /{listId}/order.</summary>
    public sealed class OrderRequest
    {
        /// <summary>Client request id.</summary>
        [JsonPropertyName("requestId")] public string? RequestId { get; set; }
        /// <summary>Required expected revision.</summary>
        [JsonPropertyName("rev")] public int? Rev { get; set; }
        /// <summary>The caller's full projected token order after the drag.</summary>
        [JsonPropertyName("order")] public List<string>? Order { get; set; }
        /// <summary>The single real token that moved (the server performs the Jellyfin move), if any.</summary>
        [JsonPropertyName("moved")] public string? Moved { get; set; }
    }

    /// <summary>Why an entry of an add/apply was not applied.</summary>
    public sealed class SkippedEntryDto
    {
        /// <summary>Index of the entry in the request.</summary>
        [JsonPropertyName("index")] public int Index { get; set; }
        /// <summary>Machine reason: duplicate, alreadyInList, notVisible, blocked, unsupportedType, invalid, notFound.</summary>
        [JsonPropertyName("reason")] public string Reason { get; set; } = string.Empty;
        /// <summary>Duplicates: the index of the earlier entry of the same request it repeats (null: it was already in the list).</summary>
        [JsonPropertyName("sameAs")] public int? SameAs { get; set; }
    }

    /// <summary>Result of POST /{listId}/items and POST /{listId}/apply.</summary>
    public sealed class ApplyResultDto
    {
        /// <summary>Ids of the placeholders that were created, in order.</summary>
        [JsonPropertyName("added")] public List<string> Added { get; set; } = new();
        /// <summary>Library item ids that were added as real entries, in order.</summary>
        [JsonPropertyName("addedAsItems")] public List<string> AddedAsItems { get; set; } = new();
        /// <summary>Entries that were skipped and why.</summary>
        [JsonPropertyName("skipped")] public List<SkippedEntryDto> Skipped { get; set; } = new();
        /// <summary>The fresh view.</summary>
        [JsonPropertyName("view")] public ListViewDto? View { get; set; }
    }

    /// <summary>Result of POST /playlists and POST /collections.</summary>
    public sealed class CreateListResultDto
    {
        /// <summary>New list id ("N").</summary>
        [JsonPropertyName("listId")] public string ListId { get; set; } = string.Empty;
        /// <summary>"playlist" or "collection".</summary>
        [JsonPropertyName("listKind")] public string ListKind { get; set; } = string.Empty;
        /// <summary>Name.</summary>
        [JsonPropertyName("name")] public string Name { get; set; } = string.Empty;
        /// <summary>What the initial entries did.</summary>
        [JsonPropertyName("result")] public ApplyResultDto Result { get; set; } = new();
    }

    /// <summary>A list the caller can add to (GET /editable-lists).</summary>
    public sealed class EditableListDto
    {
        /// <summary>List id ("N").</summary>
        [JsonPropertyName("id")] public string Id { get; set; } = string.Empty;
        /// <summary>Name.</summary>
        [JsonPropertyName("name")] public string Name { get; set; } = string.Empty;
        /// <summary>Playlists: whether the caller owns it.</summary>
        [JsonPropertyName("isOwn")] public bool IsOwn { get; set; }
        /// <summary>Playlists: whether the caller can edit it in Jellyfin (owner / CanEdit share).</summary>
        [JsonPropertyName("nativeCanEdit")] public bool NativeCanEdit { get; set; }
        /// <summary>Playlists listed only because the caller is an admin: the owner's name.</summary>
        [JsonPropertyName("ownerName")] public string? OwnerName { get; set; }
    }

    /// <summary>Response of GET /editable-lists.</summary>
    public sealed class EditableListsDto
    {
        /// <summary>Playlists the caller can edit (admins also see other users' playlists, flagged by isOwn/nativeCanEdit).</summary>
        [JsonPropertyName("playlists")] public List<EditableListDto> Playlists { get; set; } = new();
        /// <summary>Collections (only for admins and collection managers).</summary>
        [JsonPropertyName("collections")] public List<EditableListDto> Collections { get; set; } = new();
        /// <summary>Whether the caller may create/edit collections.</summary>
        [JsonPropertyName("canManageCollections")] public bool CanManageCollections { get; set; }
    }

    /// <summary>Error body (409 conflicts carry the fresh view).</summary>
    public sealed class ListErrorDto
    {
        /// <summary>Always true.</summary>
        [JsonPropertyName("error")] public bool Error { get; set; } = true;
        /// <summary>Machine code.</summary>
        [JsonPropertyName("code")] public string Code { get; set; } = string.Empty;
        /// <summary>Human message.</summary>
        [JsonPropertyName("message")] public string Message { get; set; } = string.Empty;
        /// <summary>Fresh view for conflicts.</summary>
        [JsonPropertyName("view")] public ListViewDto? View { get; set; }
        /// <summary>POST /playlists and /collections: the list that WAS created when its initial entries failed (reload or retry against it).</summary>
        [JsonPropertyName("listId")] public string? ListId { get; set; }
        /// <summary>Kind of <see cref="ListId"/>.</summary>
        [JsonPropertyName("listKind")] public string? ListKind { get; set; }
    }

    /// <summary>Body of PUT /{listId}/swap-in: turn automatic swap-in on or off for the list.</summary>
    public sealed class SwapInRequest
    {
        /// <summary>Client request id.</summary>
        [JsonPropertyName("requestId")] public string? RequestId { get; set; }
        /// <summary>Required expected revision.</summary>
        [JsonPropertyName("rev")] public int? Rev { get; set; }
        /// <summary>On or off.</summary>
        [JsonPropertyName("enabled")] public bool Enabled { get; set; }
    }

    /// <summary>Body of POST /{listId}/requests/preview: what asking for these entries would do (nothing is written).</summary>
    public sealed class ListRequestPreviewRequest
    {
        /// <summary>The entries to look at (placeholder ids); null or empty with <see cref="All"/> = every requestable entry.</summary>
        [JsonPropertyName("placeholderIds")] public List<string>? PlaceholderIds { get; set; }
        /// <summary>Request all missing: every entry the caller can see that can be asked for.</summary>
        [JsonPropertyName("all")] public bool All { get; set; }
    }

    /// <summary>Body of POST /{listId}/requests: ask for at most 20 entries, one confirmation.</summary>
    public sealed class ListRequestSubmitRequest
    {
        /// <summary>The caller's confirmation id: one per press; a retry with the same id is the same confirmation.</summary>
        [JsonPropertyName("clientId")] public string? ClientId { get; set; }
        /// <summary>The entries to ask for (placeholder ids), at most 20, in order.</summary>
        [JsonPropertyName("placeholderIds")] public List<string>? PlaceholderIds { get; set; }
    }

    /// <summary>One entry of a request preview.</summary>
    public sealed class ListRequestPreviewItemDto
    {
        /// <summary>Placeholder id.</summary>
        [JsonPropertyName("placeholderId")] public string PlaceholderId { get; set; } = string.Empty;
        /// <summary>Entry title.</summary>
        [JsonPropertyName("title")] public string Title { get; set; } = string.Empty;
        /// <summary>
        /// What would happen: <c>request</c> (a new request), <c>follow</c> (someone already asked: the caller would follow),
        /// <c>approval</c> (it would wait for an OK), <c>already</c> (the caller already asked), or <c>skip</c> (it can't be
        /// asked for here; see <see cref="Reason"/>).
        /// </summary>
        [JsonPropertyName("outcome")] public string Outcome { get; set; } = "skip";
        /// <summary>Stable reason code (request reasons, or list reasons such as <c>custom</c>, <c>not_released</c>, <c>in_library</c>).</summary>
        [JsonPropertyName("reason")] public string? Reason { get; set; }
        /// <summary>Requests it would use from the caller's allowance.</summary>
        [JsonPropertyName("cost")] public int Cost { get; set; }
    }

    /// <summary>A request preview.</summary>
    public sealed class ListRequestPreviewDto
    {
        /// <summary>Entries, in list order.</summary>
        [JsonPropertyName("items")] public List<ListRequestPreviewItemDto> Items { get; set; } = new();
        /// <summary>Entries that would be asked for (new, follow or approval).</summary>
        [JsonPropertyName("askable")] public int Askable { get; set; }
        /// <summary>Requests from the caller's allowance they would use in total.</summary>
        [JsonPropertyName("cost")] public int Cost { get; set; }
        /// <summary>Most entries one confirmation may ask for (20); the client confirms larger lists in batches.</summary>
        [JsonPropertyName("maxBatch")] public int MaxBatch { get; set; }
    }

    /// <summary>One entry's outcome of a request confirmation.</summary>
    public sealed class ListRequestResultDto
    {
        /// <summary>Placeholder id.</summary>
        [JsonPropertyName("placeholderId")] public string PlaceholderId { get; set; } = string.Empty;
        /// <summary>The shared request outcome (accepted / denied / split …, reason, certainty, safe message, request id).</summary>
        [JsonPropertyName("result")] public object? Result { get; set; }
    }

    /// <summary>The answer to a request confirmation: per-entry outcomes in order.</summary>
    public sealed class ListRequestSubmitDto
    {
        /// <summary>The confirmation (operation) id.</summary>
        [JsonPropertyName("operationId")] public string OperationId { get; set; } = string.Empty;
        /// <summary>True when this was the same confirmation again (a retry): the same requests, nothing asked twice.</summary>
        [JsonPropertyName("replayed")] public bool Replayed { get; set; }
        /// <summary>Per-entry outcomes, in the order sent.</summary>
        [JsonPropertyName("results")] public List<ListRequestResultDto> Results { get; set; } = new();
        /// <summary>The list as the caller sees it now.</summary>
        [JsonPropertyName("view")] public ListViewDto? View { get; set; }
    }
}
