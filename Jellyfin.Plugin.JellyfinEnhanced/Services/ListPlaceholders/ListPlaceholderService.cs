using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders
{
    /// <summary>One validated entry of an ordered apply: a real library item or a new placeholder.</summary>
    /// <param name="Index">Index of the entry in the request (for skip reports).</param>
    /// <param name="ItemId">Library item (real entry), or null.</param>
    /// <param name="Placeholder">New placeholder, or null.</param>
    public sealed record ApplyEntry(int Index, Guid? ItemId, Placeholder? Placeholder);

    /// <summary>An HTTP-agnostic result of a list operation.</summary>
    public sealed class ListOutcome
    {
        /// <summary>HTTP status code.</summary>
        public int StatusCode { get; init; } = 200;

        /// <summary>Response object (serialised by MVC).</summary>
        public object? Value { get; init; }

        /// <summary>A replayed response body (already JSON).</summary>
        public string? RawJson { get; init; }

        /// <summary>Success with a body.</summary>
        /// <param name="value">Body.</param>
        /// <returns>Outcome.</returns>
        public static ListOutcome Ok(object value) => new() { StatusCode = 200, Value = value };

        /// <summary>An error with a code and message.</summary>
        /// <param name="status">HTTP status.</param>
        /// <param name="code">Machine code.</param>
        /// <param name="message">Human message.</param>
        /// <param name="view">Fresh view (409 conflicts).</param>
        /// <returns>Outcome.</returns>
        public static ListOutcome Error(int status, string code, string message, ListViewDto? view = null) =>
            new() { StatusCode = status, Value = new ListErrorDto { Code = code, Message = message, View = view } };
    }

    /// <summary>
    /// Which placeholders one caller may see in one response: everything (unrestricted callers) or only an allowlist of
    /// ids that passed the caller's parental filter. Anything not on the allowlist is hidden (fail closed).
    /// </summary>
    internal sealed class PlaceholderVisibility
    {
        private readonly HashSet<string>? _allowed;

        private PlaceholderVisibility(HashSet<string>? allowed) => _allowed = allowed;

        /// <summary>Every placeholder is visible.</summary>
        /// <returns>The visibility.</returns>
        public static PlaceholderVisibility Unrestricted() => new(null);

        /// <summary>Only these ids are visible.</summary>
        /// <param name="ids">Checked, visible ids.</param>
        /// <returns>The visibility.</returns>
        public static PlaceholderVisibility Allowlist(IEnumerable<string> ids) => new(new HashSet<string>(ids, StringComparer.Ordinal));

        /// <summary>Whether a placeholder id is visible.</summary>
        /// <param name="placeholderId">Placeholder id.</param>
        /// <returns>Whether it is visible.</returns>
        public bool IsVisible(string placeholderId) => _allowed == null || _allowed.Contains(placeholderId);

        /// <summary>Adds an id that was checked for this caller (e.g. one it just added).</summary>
        /// <param name="placeholderId">Placeholder id.</param>
        public void Allow(string placeholderId) => _allowed?.Add(placeholderId);
    }

    /// <summary>
    /// The list placeholder operations behind <c>/JellyfinEnhanced/list-placeholders</c>: views (canonical order,
    /// per-caller projection, Seerr status), adds and ordered applies (real items inserted at the right spot in both
    /// Jellyfin coordinate systems), placeholder edits, drag reorders (incl. the server-side Jellyfin move) and list
    /// creation. Callers authorise first (<see cref="ListAccessService"/>); every mutation runs under the store's
    /// per-list lock, checks <c>rev</c> where required and is idempotent per client <c>requestId</c>.
    /// </summary>
    public sealed class ListPlaceholderService
    {
        /// <summary>How long a list view waits for a cold Seerr status index before answering without it.</summary>
        public static readonly TimeSpan SeerrColdWait = TimeSpan.FromMilliseconds(1500);

        // Same shape as MVC's output (Jellyfin omits nulls) so a replay is indistinguishable from the original.
        private static readonly JsonSerializerOptions ReplayJson = new() { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull };

        private readonly ListPlaceholderStore _store;
        private readonly ListAccessService _access;
        private readonly IListPlaceholderHost _host;
        private readonly SeerrMediaIndex _seerrIndex;
        private readonly IUserManager _userManager;
        private readonly Logger _logger;
        private readonly ConcurrentDictionary<Guid, SemaphoreSlim> _createLocks = new();

        /// <summary>Creates the service.</summary>
        /// <param name="store">Placeholder store.</param>
        /// <param name="access">Access service.</param>
        /// <param name="host">Jellyfin seam.</param>
        /// <param name="seerrIndex">Seerr status index.</param>
        /// <param name="userManager">User manager.</param>
        /// <param name="logger">JE logger.</param>
        public ListPlaceholderService(
            ListPlaceholderStore store,
            ListAccessService access,
            IListPlaceholderHost host,
            SeerrMediaIndex seerrIndex,
            IUserManager userManager,
            Logger logger)
        {
            _store = store;
            _access = access;
            _host = host;
            _seerrIndex = seerrIndex;
            _userManager = userManager;
            _logger = logger;
        }

        // ── Views ────────────────────────────────────────────────────────────

        /// <summary>
        /// The caller's view of a list. Reconciles the canonical order with Jellyfin's current entries and persists it
        /// when it changed (A1: always the canonical order, never a projection).
        /// </summary>
        /// <param name="access">Authorised access (CanView).</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The view.</returns>
        public async Task<ListViewDto> GetViewAsync(ListAccess access, CancellationToken cancellationToken)
        {
            var doc = _store.Load(access.ListIdN);
            List<string>? canonical = null;
            if (access.List.Kind == ListKinds.Playlist)
            {
                canonical = Canonical(access, doc);
                if (doc != null && doc.Items.Count > 0 && !canonical.SequenceEqual(doc.Order, StringComparer.Ordinal))
                {
                    using (await _store.LockAsync(access.ListIdN, cancellationToken).ConfigureAwait(false))
                    {
                        var fresh = _store.LoadForUpdate(access.ListIdN, access.List.Kind);
                        canonical = Canonical(access, fresh);
                        if (!canonical.SequenceEqual(fresh.Order, StringComparer.Ordinal))
                        {
                            fresh.Order = canonical;
                            doc = _store.Save(fresh);
                        }
                        else
                        {
                            doc = _store.Load(access.ListIdN);
                        }
                    }
                }
            }

            var items = doc?.Items ?? new List<Placeholder>();
            var visibility = await VisibilityAsync(doc, access.User, cancellationToken).ConfigureAwait(false);
            if (SeerrEnabled() && items.Any(HasTmdb))
            {
                var refresh = _seerrIndex.EnsureFreshAsync();
                // Cold start only: after a failed rebuild (Seerr down) views don't wait for the retries.
                if (!_seerrIndex.IsReady && !_seerrIndex.LastRebuildFailed)
                {
                    await Task.WhenAny(refresh, Task.Delay(SeerrColdWait, cancellationToken)).ConfigureAwait(false);
                }
            }

            return BuildView(access, doc, canonical, visibility);
        }

        // ── Adds / ordered apply ─────────────────────────────────────────────

        /// <summary>
        /// POST /{listId}/items: adds placeholders; a movie that is already in the library (accessible to the caller
        /// and, for playlists, the owner) is inserted as the REAL item at the requested position instead.
        /// </summary>
        /// <param name="access">Authorised access (CanEdit).</param>
        /// <param name="placeholders">Validated placeholders, in order.</param>
        /// <param name="position">Playlist position.</param>
        /// <param name="expectedRev">Optional expected revision.</param>
        /// <param name="requestId">Client request id.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The outcome (<see cref="ApplyResultDto"/>).</returns>
        public Task<ListOutcome> AddPlaceholdersAsync(ListAccess access, IReadOnlyList<Placeholder> placeholders, PositionDto? position, int? expectedRev, string? requestId, CancellationToken cancellationToken)
        {
            var mustSee = new List<User> { access.User };
            if (access.List.Kind == ListKinds.Playlist && access.Owner != null && access.Owner.Id != access.User.Id)
            {
                mustSee.Add(access.Owner);
            }

            var entries = new List<ApplyEntry>(placeholders.Count);
            for (var i = 0; i < placeholders.Count; i++)
            {
                var placeholder = placeholders[i];
                Guid? inLibrary = null;
                if (placeholder.Kind == PlaceholderKinds.Movie && placeholder.TmdbId is > 0
                    && (access.List.Kind == ListKinds.Collection || access.Owner != null))
                {
                    try
                    {
                        inLibrary = _host.FindMovieByTmdb(placeholder.TmdbId.Value, mustSee);
                    }
                    catch (Exception ex)
                    {
                        _logger.Warning($"[ListPlaceholders] Library lookup for TMDB {placeholder.TmdbId} failed: {ex.Message}");
                    }
                }

                entries.Add(inLibrary.HasValue ? new ApplyEntry(i, inLibrary, null) : new ApplyEntry(i, null, placeholder));
            }

            return ApplyAsync(access, entries, position, expectedRev, requestId, cancellationToken);
        }

        /// <summary>
        /// POST /{listId}/apply: applies ordered entries. Every real item is re-validated (exists, allowed type,
        /// accessible to the caller and, for playlists, the owner); TMDB placeholders must pass the caller's parental
        /// filter. Real items go into Jellyfin at the requested spot (jf12 raw position; jf10 append + move), their
        /// tokens are inserted and renumbered in the same locked write.
        /// </summary>
        /// <param name="access">Authorised access (CanEdit).</param>
        /// <param name="entries">Entries in order.</param>
        /// <param name="position">Playlist position.</param>
        /// <param name="expectedRev">Optional expected revision.</param>
        /// <param name="requestId">Client request id.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The outcome (<see cref="ApplyResultDto"/>).</returns>
        public async Task<ListOutcome> ApplyAsync(ListAccess access, IReadOnlyList<ApplyEntry> entries, PositionDto? position, int? expectedRev, string? requestId, CancellationToken cancellationToken)
        {
            var skipped = new List<SkippedEntryDto>();
            var accepted = await PrevalidateAsync(access, entries, skipped, cancellationToken).ConfigureAwait(false);
            var visibility = await VisibilityAsync(_store.Load(access.ListIdN), access.User, cancellationToken).ConfigureAwait(false);

            return await RunLockedAsync(access.ListIdN, access.ListIdN, requestId, access.UserIdN, cancellationToken, () =>
                ApplyLockedAsync(access, accepted, skipped, position, expectedRev, visibility)).ConfigureAwait(false);
        }

        private async Task<List<ApplyEntry>> PrevalidateAsync(ListAccess access, IReadOnlyList<ApplyEntry> entries, List<SkippedEntryDto> skipped, CancellationToken cancellationToken)
        {
            // C5: TMDB placeholders must pass the caller's parental filter (checked concurrently, failing closed; a
            // no-op without lookups for unrestricted callers). New custom entries are the caller's own, so they pass.
            var blocked = await _access.GetHiddenPlaceholderIdsAsync(
                entries.Where(e => e.Placeholder != null).Select(e => e.Placeholder!).ToList(),
                access.User,
                cancellationToken).ConfigureAwait(false);

            var accepted = new List<ApplyEntry>(entries.Count);
            var isPlaylist = access.List.Kind == ListKinds.Playlist;
            foreach (var entry in entries)
            {
                if (entry.ItemId.HasValue)
                {
                    var item = _host.GetItem(entry.ItemId.Value);
                    if (item == null)
                    {
                        skipped.Add(Skip(entry, "notFound"));
                    }
                    else if (!IsAllowedKind(item.Kind, isPlaylist))
                    {
                        skipped.Add(Skip(entry, "unsupportedType"));
                    }
                    else if (!_host.CanAccessItem(item.Id, access.User)
                        || (isPlaylist && (access.Owner == null || !_host.CanAccessItem(item.Id, access.Owner))))
                    {
                        // C5: never insert something the caller (or, for playlists, the owner) can't see.
                        skipped.Add(Skip(entry, "notVisible"));
                    }
                    else
                    {
                        accepted.Add(entry with { ItemId = item.Id });
                    }
                }
                else if (entry.Placeholder != null)
                {
                    if (blocked.Contains(entry.Placeholder.Id))
                    {
                        skipped.Add(Skip(entry, "blocked"));
                    }
                    else
                    {
                        accepted.Add(entry);
                    }
                }
                else
                {
                    skipped.Add(Skip(entry, "invalid"));
                }
            }

            return accepted;
        }

        private async Task<ListOutcome> ApplyLockedAsync(
            ListAccess access,
            List<ApplyEntry> accepted,
            List<SkippedEntryDto> skipped,
            PositionDto? position,
            int? expectedRev,
            PlaceholderVisibility visibility)
        {
            var doc = _store.LoadForUpdate(access.ListIdN, access.List.Kind);
            if (expectedRev.HasValue && expectedRev.Value != doc.Rev)
            {
                return Conflict(access, "rev_conflict", "The list changed; reload it.", visibility);
            }

            var isPlaylist = access.List.Kind == ListKinds.Playlist;
            var raw = _host.GetRawEntries(access.List.Id);
            var present = new HashSet<Guid>(raw.Where(r => r.Resolved && r.ItemId.HasValue).Select(r => r.ItemId!.Value));
            var order = isPlaylist ? Canonical(access, doc, raw) : new List<string>();
            var originalOrder = doc.Order.ToList();

            var cursor = order.Count;
            if (isPlaylist && position != null)
            {
                if (position.AtStart)
                {
                    cursor = 0;
                }
                else if (position.AfterToken != null)
                {
                    var index = order.IndexOf(position.AfterToken);
                    if (index < 0 || !IsVisibleToken(position.AfterToken, access.User, visibility, new Dictionary<Guid, bool>()))
                    {
                        return Conflict(access, "stale_anchor", "The position no longer exists; reload the list.", visibility, order, doc);
                    }

                    cursor = index + 1;
                }
            }

            var result = new ApplyResultDto { Skipped = skipped };
            var keys = new HashSet<string>(doc.Items.Select(PlaceholderRules.IdentityKey), StringComparer.Ordinal);
            var room = ListPlaceholderStore.MaxPlaceholders - doc.Items.Count;
            // Everything of one apply lands at the cursor, so the new real items form ONE contiguous run in Jellyfin's
            // raw order (placeholders take no raw slot): one Jellyfin insert covers them all.
            var run = new List<NewEntry>();
            var collectionItems = new List<Guid>();
            var changed = false;

            try
            {
                foreach (var entry in accepted.OrderBy(e => e.Index))
                {
                    if (entry.ItemId.HasValue)
                    {
                        if (!present.Add(entry.ItemId.Value))
                        {
                            skipped.Add(Skip(entry, "alreadyInList"));
                            continue;
                        }

                        if (isPlaylist)
                        {
                            run.Add(new NewEntry(entry.ItemId.Value, null));
                        }
                        else
                        {
                            collectionItems.Add(entry.ItemId.Value);
                        }

                        result.AddedAsItems.Add(entry.ItemId.Value.ToString("N", CultureInfo.InvariantCulture));
                        continue;
                    }

                    var placeholder = entry.Placeholder!;
                    if (!keys.Add(PlaceholderRules.IdentityKey(placeholder)))
                    {
                        skipped.Add(Skip(entry, "duplicate"));
                        continue;
                    }

                    if (room <= 0)
                    {
                        skipped.Add(Skip(entry, "listFull"));
                        continue;
                    }

                    room--;
                    doc.Items.Add(placeholder);
                    visibility.Allow(placeholder.Id); // passed the caller's own filter in PrevalidateAsync
                    result.Added.Add(placeholder.Id);
                    changed = true;
                    run.Add(new NewEntry(null, ListPlaceholderOrder.PlaceholderToken(placeholder.Id)));
                }

                if (isPlaylist && run.Count > 0)
                {
                    var anchor = ListPlaceholderOrder.RealAnchorBefore(order, cursor);
                    var (desired, inserted) = ListPlaceholderOrder.InsertEntries(order, cursor, run);
                    order = desired; // what a failure below is reconciled from
                    if (inserted.Count > 0)
                    {
                        order = await PlaceRealItemsAsync(access, run.Where(e => e.ItemId.HasValue).Select(e => e.ItemId!.Value).ToList(), anchor, desired, inserted).ConfigureAwait(false);
                    }
                }

                if (collectionItems.Count > 0)
                {
                    await _host.AddToCollectionAsync(access.List.Id, collectionItems.Distinct().ToList()).ConfigureAwait(false);
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"[ListPlaceholders] Updating list {access.ListIdN} in Jellyfin failed: {ex.Message}");
                if (isPlaylist)
                {
                    order = Canonical(access, new ListDoc { Order = order, Items = doc.Items });
                }

                var saved = SaveIfChanged(doc, isPlaylist ? order : null, originalOrder, changed);
                return ListOutcome.Error(500, "list_update_failed", "Jellyfin could not update the list.", BuildView(access, saved, isPlaylist ? order : null, visibility));
            }

            if (result.AddedAsItems.Count > 0)
            {
                // Jellyfin can silently drop an item (e.g. it doesn't support playlists): report only what landed.
                var landed = new HashSet<string>(
                    _host.GetRawEntries(access.List.Id).Where(r => r.Resolved && r.ItemId.HasValue).Select(r => r.ItemId!.Value.ToString("N", CultureInfo.InvariantCulture)),
                    StringComparer.Ordinal);
                foreach (var entry in accepted.Where(e => e.ItemId.HasValue && !landed.Contains(e.ItemId.Value.ToString("N", CultureInfo.InvariantCulture))))
                {
                    if (result.AddedAsItems.Remove(entry.ItemId!.Value.ToString("N", CultureInfo.InvariantCulture)))
                    {
                        skipped.Add(Skip(entry, "rejected"));
                    }
                }
            }

            var final = SaveIfChanged(doc, isPlaylist ? order : null, originalOrder, changed);
            result.Skipped = skipped.OrderBy(s => s.Index).ToList();
            result.View = BuildView(access, final, isPlaylist ? order : null, visibility);
            return ListOutcome.Ok(result);
        }

        // Puts a contiguous run of new real items into Jellyfin right after `anchor`, in the coordinate system the
        // Jellyfin version needs (jf12: one positional insert at the raw index; jf10: append, then move each into place
        // by the owner's visible-row index), then verifies Jellyfin's actual order (A5): one misplaced item is fixed with
        // a single move, anything else falls back to Jellyfin's order with placeholders reconciled to their anchors.
        private async Task<List<string>> PlaceRealItemsAsync(ListAccess access, IReadOnlyList<Guid> items, string? anchor, List<string> desired, IReadOnlyList<string> inserted)
        {
            var listId = access.List.Id;
            var owner = access.Owner!;
            var ownerVisible = new Dictionary<Guid, bool>();
            bool VisibleToOwner(string token) => EntryVisible(token, owner, ownerVisible);

            if (_host.SupportsPositionalInsert)
            {
                var position = ListPlaceholderOrder.RawInsertPosition(_host.GetRawEntries(listId), anchor);
                await _host.AddToPlaylistAsync(listId, items, position, owner.Id).ConfigureAwait(false);
            }
            else
            {
                await _host.AddToPlaylistAsync(listId, items, null, owner.Id).ConfigureAwait(false);
                var current = ListPlaceholderOrder.BuildRealTokens(_host.GetRawEntries(listId));
                var previous = anchor;
                foreach (var token in inserted)
                {
                    if (!current.Contains(token))
                    {
                        continue; // Jellyfin dropped it; the verification below settles the order
                    }

                    var target = current.Where(t => t != token).ToList();
                    target.Insert(previous == null ? 0 : target.IndexOf(previous) + 1, token);
                    var newIndex = ListPlaceholderOrder.VisibleMoveIndex(target, token, VisibleToOwner);
                    if (newIndex != ListPlaceholderOrder.VisibleMoveIndex(current, token, VisibleToOwner))
                    {
                        ListPlaceholderOrder.TryParseReal(token, out var itemId, out _);
                        await _host.MoveInPlaylistAsync(listId, itemId, newIndex, owner.Id).ConfigureAwait(false);
                        current = ListPlaceholderOrder.BuildRealTokens(_host.GetRawEntries(listId));
                    }

                    previous = token;
                }
            }

            var actual = ListPlaceholderOrder.BuildRealTokens(_host.GetRawEntries(listId));
            var desiredReal = desired.Where(ListPlaceholderOrder.IsReal).ToList();
            if (!actual.SequenceEqual(desiredReal, StringComparer.Ordinal) && items.Count == 1 && actual.Contains(inserted[0]))
            {
                var newIndex = ListPlaceholderOrder.VisibleMoveIndex(desiredReal, inserted[0], VisibleToOwner);
                await _host.MoveInPlaylistAsync(listId, items[0], newIndex, owner.Id).ConfigureAwait(false);
                actual = ListPlaceholderOrder.BuildRealTokens(_host.GetRawEntries(listId));
            }

            if (actual.SequenceEqual(desiredReal, StringComparer.Ordinal))
            {
                return desired;
            }

            _logger.Warning($"[ListPlaceholders] Jellyfin placed new entries of list {access.ListIdN} differently than requested; keeping Jellyfin's order.");
            return ListPlaceholderOrder.Reconcile(desired, actual, desired.Select(ListPlaceholderOrder.PlaceholderIdOf).OfType<string>().ToList());
        }

        // ── Placeholder edits ────────────────────────────────────────────────

        /// <summary>PATCH /{listId}/items/{phId}: note, and linking a custom entry to a TMDB title.</summary>
        /// <param name="access">Authorised access (CanEdit).</param>
        /// <param name="placeholderId">Placeholder id.</param>
        /// <param name="rev">Expected revision.</param>
        /// <param name="note">New note (null = unchanged, "" = clear).</param>
        /// <param name="link">Normalised title data to link to (custom entries only).</param>
        /// <param name="requestId">Client request id.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The outcome (<see cref="ListViewDto"/>).</returns>
        public async Task<ListOutcome> PatchAsync(ListAccess access, string placeholderId, int rev, string? note, Placeholder? link, string? requestId, CancellationToken cancellationToken)
        {
            if (link != null && HasTmdb(link) && await _access.IsTitleBlockedAsync(link.MediaType, link.TmdbId!.Value, access.User, cancellationToken).ConfigureAwait(false))
            {
                return ListOutcome.Error(403, "parental_block", "This title isn't available for your account.");
            }

            var visibility = await VisibilityAsync(_store.Load(access.ListIdN), access.User, cancellationToken).ConfigureAwait(false);
            return await RunLockedAsync(access.ListIdN, access.ListIdN, requestId, access.UserIdN, cancellationToken, () =>
            {
                var doc = _store.LoadForUpdate(access.ListIdN, access.List.Kind);
                if (doc.Rev != rev)
                {
                    return Task.FromResult(Conflict(access, "rev_conflict", "The list changed; reload it.", visibility));
                }

                var placeholder = doc.Items.FirstOrDefault(p => p.Id == placeholderId);
                if (placeholder == null || !visibility.IsVisible(placeholderId))
                {
                    return Task.FromResult(ListOutcome.Error(404, "not_found", "Placeholder not found."));
                }

                if (link != null)
                {
                    if (placeholder.Kind != PlaceholderKinds.Custom)
                    {
                        return Task.FromResult(ListOutcome.Error(400, "not_custom", "Only custom entries can be linked to a title."));
                    }

                    var key = PlaceholderRules.IdentityKey(link);
                    if (doc.Items.Any(p => p.Id != placeholderId && PlaceholderRules.IdentityKey(p) == key))
                    {
                        return Task.FromResult(Conflict(access, "duplicate", "This title is already in the list.", visibility));
                    }

                    placeholder.Kind = link.Kind;
                    placeholder.MediaType = link.MediaType;
                    placeholder.TmdbId = link.TmdbId;
                    placeholder.TvdbId = link.TvdbId;
                    placeholder.ImdbId = link.ImdbId;
                    placeholder.Title = link.Title;
                    placeholder.Year = link.Year;
                    placeholder.ReleaseDate = link.ReleaseDate;
                    placeholder.PosterPath = link.PosterPath;
                    placeholder.Overview = link.Overview ?? placeholder.Overview;
                    placeholder.SeasonNumber = link.SeasonNumber;
                    placeholder.Episodes = link.Episodes;
                    placeholder.EpisodeTotal = link.EpisodeTotal;
                    placeholder.Expected = new List<PlaceholderEpisode>();
                    placeholder.Filled = new List<FilledEpisode>();
                    placeholder.InProduction = null;
                    if (link.Note != null && note == null)
                    {
                        placeholder.Note = link.Note;
                    }
                }

                if (note != null)
                {
                    placeholder.Note = note.Length == 0 ? null : note;
                }

                var canonical = access.List.Kind == ListKinds.Playlist ? Canonical(access, doc) : null;
                if (canonical != null)
                {
                    doc.Order = canonical;
                }

                var saved = _store.Save(doc);
                return Task.FromResult(ListOutcome.Ok(BuildView(access, saved, canonical, visibility)));
            }).ConfigureAwait(false);
        }

        /// <summary>DELETE /{listId}/items/{phId}.</summary>
        /// <param name="access">Authorised access (CanEdit).</param>
        /// <param name="placeholderId">Placeholder id.</param>
        /// <param name="rev">Expected revision.</param>
        /// <param name="requestId">Client request id.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The outcome (<see cref="ListViewDto"/>).</returns>
        public async Task<ListOutcome> DeleteAsync(ListAccess access, string placeholderId, int rev, string? requestId, CancellationToken cancellationToken)
        {
            var visibility = await VisibilityAsync(_store.Load(access.ListIdN), access.User, cancellationToken).ConfigureAwait(false);
            return await RunLockedAsync(access.ListIdN, access.ListIdN, requestId, access.UserIdN, cancellationToken, () =>
            {
                var doc = _store.LoadForUpdate(access.ListIdN, access.List.Kind);
                if (doc.Rev != rev)
                {
                    return Task.FromResult(Conflict(access, "rev_conflict", "The list changed; reload it.", visibility));
                }

                var placeholder = doc.Items.FirstOrDefault(p => p.Id == placeholderId);
                if (placeholder == null || !visibility.IsVisible(placeholderId))
                {
                    return Task.FromResult(ListOutcome.Error(404, "not_found", "Placeholder not found."));
                }

                doc.Items.Remove(placeholder);
                if (doc.Source != null && placeholder.SourceKey != null && doc.Source.Owned.Remove(placeholder.SourceKey))
                {
                    // F2: an editor removed a sync-added entry; sync must not add it again.
                    doc.Source.UserRemovedKeys[placeholder.SourceKey] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
                }

                List<string>? canonical = null;
                if (access.List.Kind == ListKinds.Playlist)
                {
                    canonical = Canonical(access, doc);
                    doc.Order = canonical;
                }

                var saved = _store.Save(doc);
                return Task.FromResult(ListOutcome.Ok(BuildView(access, saved, canonical, visibility)));
            }).ConfigureAwait(false);
        }

        // ── Reorder ──────────────────────────────────────────────────────────

        /// <summary>
        /// PUT /{listId}/order (A3/A4): the caller's projected order after a drag. Placeholder moves are spliced into
        /// the canonical order; a moved real row is moved in Jellyfin by the server (as the caller when they can edit
        /// natively, else as the owner) using the visible-row coordinates of that user, then verified.
        /// </summary>
        /// <param name="access">Authorised access (CanEdit, playlist).</param>
        /// <param name="rev">Expected revision.</param>
        /// <param name="requested">Requested projection.</param>
        /// <param name="moved">The moved real token, if any.</param>
        /// <param name="requestId">Client request id.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The outcome (<see cref="ListViewDto"/>, or 409 with the fresh view).</returns>
        public async Task<ListOutcome> ReorderAsync(ListAccess access, int rev, IReadOnlyList<string> requested, string? moved, string? requestId, CancellationToken cancellationToken)
        {
            var visibility = await VisibilityAsync(_store.Load(access.ListIdN), access.User, cancellationToken).ConfigureAwait(false);

            return await RunLockedAsync(access.ListIdN, access.ListIdN, requestId, access.UserIdN, cancellationToken, async () =>
            {
                var doc = _store.LoadForUpdate(access.ListIdN, access.List.Kind);
                if (doc.Rev != rev)
                {
                    return Conflict(access, "rev_conflict", "The list changed; reload it.", visibility);
                }

                var callerVisible = new Dictionary<Guid, bool>();
                bool VisibleToCaller(string token) => IsVisibleToken(token, access.User, visibility, callerVisible);

                var canonical = Canonical(access, doc);
                var projection = ListPlaceholderOrder.Project(canonical, VisibleToCaller);
                var merge = ListPlaceholderOrder.MergeProjection(canonical, projection, requested, moved);
                if (!merge.Ok)
                {
                    var message = merge.Error == "duplicate_copy"
                        ? "Only the first copy of an item that is in the playlist more than once can be moved."
                        : "The list changed; reload it.";
                    return Conflict(access, merge.Error!, message, visibility, canonical, doc);
                }

                var final = merge.Desired.ToList();
                var success = true;
                if (merge.RealMoved)
                {
                    var mover = access.Permissions.NativeCanEdit ? access.User : access.Owner;
                    if (mover == null)
                    {
                        return Conflict(access, "owner_missing", "The playlist owner no longer exists.", visibility, canonical, doc);
                    }

                    var moverVisible = new Dictionary<Guid, bool>();
                    var desiredReal = merge.Desired.Where(ListPlaceholderOrder.IsReal).ToList();
                    ListPlaceholderOrder.TryParseReal(moved, out var itemId, out _);
                    var newIndex = ListPlaceholderOrder.VisibleMoveIndex(desiredReal, moved!, t => EntryVisible(t, mover, moverVisible));
                    try
                    {
                        await _host.MoveInPlaylistAsync(access.List.Id, itemId, newIndex, mover.Id).ConfigureAwait(false);
                    }
                    catch (Exception ex)
                    {
                        _logger.Error($"[ListPlaceholders] Moving an entry of list {access.ListIdN} failed: {ex.Message}");
                        return Conflict(access, "move_failed", "Jellyfin could not move the entry.", visibility, Canonical(access, doc), doc);
                    }

                    var actual = ListPlaceholderOrder.BuildRealTokens(_host.GetRawEntries(access.List.Id));
                    var relabelled = ListPlaceholderOrder.Relabel(merge.Desired);
                    final = ListPlaceholderOrder.Reconcile(relabelled, actual, doc.Items.Select(p => p.Id).ToList());
                    success = ListPlaceholderOrder.Project(final, VisibleToCaller)
                        .SequenceEqual(ListPlaceholderOrder.Project(relabelled, VisibleToCaller), StringComparer.Ordinal);
                }

                ListDoc? saved = _store.Load(access.ListIdN);
                if ((saved != null || doc.Items.Count > 0) && !final.SequenceEqual(doc.Order, StringComparer.Ordinal))
                {
                    doc.Order = final;
                    saved = _store.Save(doc);
                }

                var view = BuildView(access, saved, final, visibility);
                return success
                    ? ListOutcome.Ok(view)
                    : ListOutcome.Error(409, "move_mismatch", "Jellyfin placed the entry differently; the list was refreshed.", view);
            }).ConfigureAwait(false);
        }

        // ── Pickers and creation ─────────────────────────────────────────────

        /// <summary>
        /// GET /editable-lists: playlists the caller can edit (like jellyfin-web's add-to-playlist picker: visible +
        /// owner or CanEdit share; admins also every other playlist, flagged) and, for admins/collection managers,
        /// the collections they can see.
        /// </summary>
        /// <param name="user">Caller.</param>
        /// <returns>The lists.</returns>
        public EditableListsDto GetEditableLists(User user)
        {
            var result = new EditableListsDto { CanManageCollections = ListAccessService.CanManageCollections(user) };
            foreach (var list in _host.GetAllPlaylists())
            {
                var access = _access.Evaluate(list, user);
                if (!access.Permissions.CanEdit)
                {
                    continue;
                }

                result.Playlists.Add(new EditableListDto
                {
                    Id = access.ListIdN,
                    Name = list.Name,
                    IsOwn = list.OwnerId == user.Id,
                    NativeCanEdit = access.Permissions.NativeCanEdit,
                    OwnerName = access.Permissions.NativeCanEdit ? null : _userManager.GetUserById(list.OwnerId)?.Username,
                });
            }

            if (result.CanManageCollections)
            {
                foreach (var list in _host.GetVisibleCollections(user))
                {
                    result.Collections.Add(new EditableListDto
                    {
                        Id = list.Id.ToString("N", CultureInfo.InvariantCulture),
                        Name = list.Name,
                        NativeCanEdit = true,
                    });
                }
            }

            result.Playlists = result.Playlists.OrderBy(p => p.IsOwn ? 0 : 1).ThenBy(p => p.Name, StringComparer.CurrentCultureIgnoreCase).ToList();
            result.Collections = result.Collections.OrderBy(c => c.Name, StringComparer.CurrentCultureIgnoreCase).ToList();
            return result;
        }

        /// <summary>POST /playlists and POST /collections: creates a list owned by/visible to the caller, then applies entries.</summary>
        /// <param name="user">Caller (already authorised for collections).</param>
        /// <param name="kind">List kind.</param>
        /// <param name="name">Validated name.</param>
        /// <param name="isPublic">Playlists: open access.</param>
        /// <param name="entries">Validated entries.</param>
        /// <param name="requestId">Client request id.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The outcome (<see cref="CreateListResultDto"/>).</returns>
        public async Task<ListOutcome> CreateListAsync(User user, string kind, string name, bool isPublic, IReadOnlyList<ApplyEntry> entries, string? requestId, CancellationToken cancellationToken)
        {
            var userIdN = user.Id.ToString("N", CultureInfo.InvariantCulture);
            var scope = "create-" + kind;
            var gate = _createLocks.GetOrAdd(user.Id, _ => new SemaphoreSlim(1, 1));
            await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                if (requestId != null && _store.TryGetReplay(scope, requestId, userIdN, out var replay))
                {
                    return new ListOutcome { StatusCode = replay.StatusCode, RawJson = replay.Body };
                }

                // B10: a retry after a failed or aborted apply goes to the list the first attempt created.
                var createdScope = scope + "-created";
                ListInfo? list = null;
                if (requestId != null && _store.TryGetReplay(createdScope, requestId, userIdN, out var created)
                    && Guid.TryParseExact(created.Body, "N", out var createdId))
                {
                    list = _host.GetList(createdId);
                    if (list != null && (list.Kind != kind || (kind == ListKinds.Playlist && list.OwnerId != user.Id)))
                    {
                        list = null;
                    }
                }

                Guid id;
                if (list != null)
                {
                    id = list.Id;
                }
                else
                {
                    id = kind == ListKinds.Playlist
                        ? await _host.CreatePlaylistAsync(name, user.Id, isPublic).ConfigureAwait(false)
                        : await _host.CreateCollectionAsync(name).ConfigureAwait(false);
                    _logger.Info($"[ListPlaceholders] {user.Username} created {kind} \"{name}\" ({id:N}).");
                    if (requestId != null)
                    {
                        _store.RememberReplay(createdScope, requestId, userIdN, 201, id.ToString("N", CultureInfo.InvariantCulture));
                    }

                    list = _host.GetList(id) ?? new ListInfo(id, kind, name, kind == ListKinds.Playlist ? user.Id : Guid.Empty, isPublic, Array.Empty<ListShare>());
                }

                var access = _access.Evaluate(list, user);
                if (kind == ListKinds.Playlist && !access.Permissions.CanEdit)
                {
                    // A brand-new playlist is owned by the caller; trust that over a not-yet-visible entity.
                    access = new ListAccess { List = list, User = user, IsAdmin = access.IsAdmin, Owner = user, Permissions = new ListPermissions(true, true, true) };
                }

                var listIdN = id.ToString("N", CultureInfo.InvariantCulture);
                var applied = await ApplyAsync(access, entries, null, null, null, cancellationToken).ConfigureAwait(false);
                if (applied.StatusCode >= 300 || applied.Value is not ApplyResultDto result)
                {
                    // The list exists but its entries didn't (all) apply: report the failure with the list to reload,
                    // and keep no replay, so a retry with the same requestId re-applies to this same list.
                    var error = applied.Value as ListErrorDto ?? new ListErrorDto { Code = "list_update_failed", Message = "Jellyfin could not update the list." };
                    error.ListId = listIdN;
                    error.ListKind = kind;
                    return new ListOutcome { StatusCode = applied.StatusCode >= 300 ? applied.StatusCode : 500, Value = error };
                }

                var body = new CreateListResultDto
                {
                    ListId = listIdN,
                    ListKind = kind,
                    Name = list.Name,
                    Result = result,
                };
                var outcome = ListOutcome.Ok(body);
                if (requestId != null)
                {
                    _store.RememberReplay(scope, requestId, userIdN, 200, JsonSerializer.Serialize(body, ReplayJson));
                }

                return outcome;
            }
            finally
            {
                gate.Release();
            }
        }

        // ── Helpers ──────────────────────────────────────────────────────────

        /// <summary>The canonical order of a playlist document against Jellyfin's current entries.</summary>
        /// <param name="access">List access.</param>
        /// <param name="doc">Document (or null).</param>
        /// <param name="raw">Raw entries (read when null).</param>
        /// <returns>Canonical order.</returns>
        private List<string> Canonical(ListAccess access, ListDoc? doc, IReadOnlyList<RawEntry>? raw = null)
        {
            var real = ListPlaceholderOrder.BuildRealTokens(raw ?? _host.GetRawEntries(access.List.Id));
            return ListPlaceholderOrder.Reconcile(
                doc?.Order ?? new List<string>(),
                real,
                (doc?.Items ?? new List<Placeholder>()).Select(p => p.Id).ToList());
        }

        private ListViewDto BuildView(ListAccess access, ListDoc? doc, IReadOnlyList<string>? canonical, PlaceholderVisibility visibility)
        {
            var seerrEnabled = SeerrEnabled();
            var items = (doc?.Items ?? new List<Placeholder>()).Where(p => visibility.IsVisible(p.Id)).ToList();
            var view = new ListViewDto
            {
                ListId = access.ListIdN,
                ListKind = access.List.Kind,
                Rev = doc?.Rev ?? 0,
                CanEdit = access.Permissions.CanEdit,
                NativeCanEdit = access.Permissions.NativeCanEdit,
                SeerrEnabled = seerrEnabled,
                SeerrStatusReady = !seerrEnabled || !items.Any(HasTmdb) || _seerrIndex.IsReady,
                Source = doc?.Source == null ? null : new ListSourceDto
                {
                    Kind = doc.Source.Kind,
                    Url = doc.Source.Url,
                    Title = doc.Source.Title,
                    SyncEnabled = doc.Source.SyncEnabled,
                    RemoveDropped = doc.Source.RemoveDropped,
                    LastSyncAt = doc.Source.LastSyncAt,
                    LastSyncResult = doc.Source.LastSyncResult,
                    PausedReason = doc.Source.PausedReason,
                },
            };

            var today = DateTime.UtcNow;
            var byId = items.ToDictionary(p => p.Id, StringComparer.Ordinal);
            IEnumerable<Placeholder> ordered;
            if (access.List.Kind == ListKinds.Playlist && canonical != null)
            {
                var callerVisible = new Dictionary<Guid, bool>();
                view.Order = ListPlaceholderOrder.Project(canonical, t => IsVisibleToken(t, access.User, visibility, callerVisible));
                ordered = view.Order.Select(ListPlaceholderOrder.PlaceholderIdOf).OfType<string>().Where(byId.ContainsKey).Select(id => byId[id]);
            }
            else
            {
                ordered = ListPlaceholderOrder.SortForCollection(items);
            }

            foreach (var placeholder in ordered)
            {
                int? status = null;
                if (seerrEnabled && HasTmdb(placeholder))
                {
                    var season = placeholder.Kind is PlaceholderKinds.Season or PlaceholderKinds.Episodes ? placeholder.SeasonNumber : null;
                    status = _seerrIndex.Lookup(placeholder.MediaType, placeholder.TmdbId!.Value).StatusFor(season);
                }

                view.Placeholders.Add(new PlaceholderDto
                {
                    Id = placeholder.Id,
                    Token = ListPlaceholderOrder.PlaceholderToken(placeholder.Id),
                    Kind = placeholder.Kind,
                    MediaType = placeholder.MediaType,
                    TmdbId = placeholder.TmdbId,
                    TvdbId = placeholder.TvdbId,
                    ImdbId = placeholder.ImdbId,
                    Title = placeholder.Title,
                    Year = placeholder.Year,
                    ReleaseDate = placeholder.ReleaseDate,
                    Released = PlaceholderRules.IsReleased(placeholder, today),
                    PosterPath = placeholder.PosterPath,
                    Overview = placeholder.Overview,
                    SeasonNumber = placeholder.SeasonNumber,
                    Episodes = placeholder.Episodes,
                    EpisodeTotal = placeholder.EpisodeTotal,
                    FilledCount = placeholder.Filled.Count,
                    Note = placeholder.Note,
                    AddedByMe = string.Equals(placeholder.AddedBy, access.UserIdN, StringComparison.Ordinal),
                    AddedAt = placeholder.AddedAt,
                    Status = status,
                });
            }

            return view;
        }

        private ListOutcome Conflict(ListAccess access, string code, string message, PlaceholderVisibility visibility, IReadOnlyList<string>? canonical = null, ListDoc? doc = null)
        {
            var current = _store.Load(access.ListIdN);
            if (access.List.Kind == ListKinds.Playlist && (canonical == null || doc == null || current?.Rev != doc.Rev))
            {
                canonical = Canonical(access, current);
            }

            return ListOutcome.Error(409, code, message, BuildView(access, current, canonical, visibility));
        }

        private ListDoc? SaveIfChanged(ListDoc doc, List<string>? order, List<string> originalOrder, bool placeholdersChanged)
        {
            var orderChanged = order != null && !order.SequenceEqual(originalOrder, StringComparer.Ordinal);
            if (order != null)
            {
                doc.Order = order;
            }

            var exists = _store.Load(doc.ListId) != null;
            if (placeholdersChanged || (orderChanged && (exists || doc.Items.Count > 0)))
            {
                return _store.Save(doc);
            }

            return _store.Load(doc.ListId);
        }

        private async Task<ListOutcome> RunLockedAsync(string listIdN, string scope, string? requestId, string userIdN, CancellationToken cancellationToken, Func<Task<ListOutcome>> body)
        {
            using (await _store.LockAsync(listIdN, cancellationToken).ConfigureAwait(false))
            {
                if (requestId != null && _store.TryGetReplay(scope, requestId, userIdN, out var replay))
                {
                    return new ListOutcome { StatusCode = replay.StatusCode, RawJson = replay.Body };
                }

                var outcome = await body().ConfigureAwait(false);
                if (requestId != null && outcome.StatusCode < 300 && outcome.Value != null)
                {
                    _store.RememberReplay(scope, requestId, userIdN, outcome.StatusCode, JsonSerializer.Serialize(outcome.Value, outcome.Value.GetType(), ReplayJson));
                }

                return outcome;
            }
        }

        private bool IsVisibleToken(string token, User user, PlaceholderVisibility visibility, Dictionary<Guid, bool> memo)
        {
            var placeholderId = ListPlaceholderOrder.PlaceholderIdOf(token);
            return placeholderId != null ? visibility.IsVisible(placeholderId) : EntryVisible(token, user, memo);
        }

        // A2/C5: which placeholders the caller may see. Unrestricted callers see everything. Restricted callers get an
        // ALLOWLIST of the ids that were checked against their parental filter: a placeholder that another editor adds
        // after this check (between the snapshot and the list lock) is hidden until the caller's next view (fail closed).
        private async Task<PlaceholderVisibility> VisibilityAsync(ListDoc? doc, User user, CancellationToken cancellationToken)
        {
            if (!_access.IsRestricted(user))
            {
                return PlaceholderVisibility.Unrestricted();
            }

            var items = doc?.Items ?? new List<Placeholder>();
            var hidden = await _access.GetHiddenPlaceholderIdsAsync(items, user, cancellationToken).ConfigureAwait(false);
            return PlaceholderVisibility.Allowlist(items.Select(p => p.Id).Where(id => !hidden.Contains(id)));
        }

        private bool EntryVisible(string token, User user, Dictionary<Guid, bool> memo)
        {
            if (!ListPlaceholderOrder.TryParseReal(token, out var itemId, out _))
            {
                return false;
            }

            if (!memo.TryGetValue(itemId, out var visible))
            {
                try
                {
                    visible = _host.IsEntryVisible(itemId, user);
                }
                catch (Exception ex)
                {
                    _logger.Debug($"[ListPlaceholders] Visibility check failed for {itemId:N}: {ex.Message}");
                    visible = false;
                }

                memo[itemId] = visible;
            }

            return visible;
        }

        private static bool IsAllowedKind(BaseItemKind kind, bool playlist) => playlist
            ? kind is BaseItemKind.Movie or BaseItemKind.Episode or BaseItemKind.Video or BaseItemKind.MusicVideo
            : kind is BaseItemKind.Movie or BaseItemKind.Series or BaseItemKind.Season or BaseItemKind.Episode or BaseItemKind.Video or BaseItemKind.MusicVideo;

        private static bool HasTmdb(Placeholder placeholder) => placeholder.Kind != PlaceholderKinds.Custom && placeholder.TmdbId is > 0;

        private static bool SeerrEnabled() => JellyfinEnhanced.Instance?.Configuration?.JellyseerrEnabled == true;

        private static SkippedEntryDto Skip(ApplyEntry entry, string reason) => new() { Index = entry.Index, Reason = reason };
    }
}
