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
    /// <param name="ExpandedFrom">
    /// For real items the granularity resolver expanded a TV placeholder into (C1): that placeholder. Such items are
    /// silently skipped when already in the list (they still count as filled) or when the placeholder is a duplicate.
    /// </param>
    /// <param name="CompleteIfLanded">
    /// For a placeholder whose scope the library already holds completely (C1): it is still written with its expanded
    /// items, and dropped again in the same write once all of them really are in the list. If Jellyfin rejected or
    /// failed some, it stays and tracks them (swap-in adds them later).
    /// </param>
    /// <param name="Covers">For an expanded collection Season item: the episode coordinates credited to it (C1).</param>
    public sealed record ApplyEntry(int Index, Guid? ItemId, Placeholder? Placeholder, Placeholder? ExpandedFrom = null, bool CompleteIfLanded = false, IReadOnlyList<EpisodeCoord>? Covers = null);

    /// <summary>An HTTP-agnostic result of a list operation.</summary>
    public sealed class ListOutcome
    {
        /// <summary>HTTP status code.</summary>
        public int StatusCode { get; init; } = 200;

        /// <summary>Response object (serialised by MVC).</summary>
        public object? Value { get; init; }

        /// <summary>A replayed response body (already JSON).</summary>
        public string? RawJson { get; init; }

        /// <summary>Seconds for a Retry-After header (rate limits, pending parental checks).</summary>
        public int? RetryAfterSeconds { get; init; }

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
    /// placeholders that passed the caller's parental filter. The allowlist is bound to what was checked (the inputs of
    /// the filter: title or custom author), not just the id, so an entry that changed since the check (e.g. a custom
    /// entry linked to a title by another editor) is hidden like anything not on the list (fail closed).
    /// </summary>
    internal sealed class PlaceholderVisibility
    {
        private readonly Dictionary<string, string>? _allowed;

        private PlaceholderVisibility(Dictionary<string, string>? allowed) => _allowed = allowed;

        /// <summary>Every placeholder is visible.</summary>
        /// <returns>The visibility.</returns>
        public static PlaceholderVisibility Unrestricted() => new(null);

        /// <summary>Only these placeholders, as they were when checked, are visible.</summary>
        /// <param name="placeholders">Checked, visible placeholders.</param>
        /// <returns>The visibility.</returns>
        public static PlaceholderVisibility Allowlist(IEnumerable<Placeholder> placeholders)
        {
            var allowed = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var placeholder in placeholders)
            {
                allowed[placeholder.Id] = CheckedKey(placeholder);
            }

            return new(allowed);
        }

        /// <summary>Whether a placeholder (in its current state) is visible.</summary>
        /// <param name="placeholder">Placeholder.</param>
        /// <returns>Whether it is visible.</returns>
        public bool IsVisible(Placeholder placeholder) =>
            _allowed == null || (_allowed.TryGetValue(placeholder.Id, out var key) && key == CheckedKey(placeholder));

        /// <summary>A lookup of placeholder-id visibility against the placeholders of one document.</summary>
        /// <param name="items">The document's placeholders.</param>
        /// <returns>Whether the placeholder with an id is in <paramref name="items"/> and visible.</returns>
        public Func<string, bool> For(IEnumerable<Placeholder> items)
        {
            if (_allowed == null)
            {
                return _ => true;
            }

            var byId = new Dictionary<string, Placeholder>(StringComparer.Ordinal);
            foreach (var item in items)
            {
                byId[item.Id] = item;
            }

            return id => byId.TryGetValue(id, out var placeholder) && IsVisible(placeholder);
        }

        /// <summary>Adds a placeholder that was checked for this caller (e.g. one it just added or linked).</summary>
        /// <param name="placeholder">Placeholder in its checked state.</param>
        public void Allow(Placeholder placeholder)
        {
            if (_allowed != null)
            {
                _allowed[placeholder.Id] = CheckedKey(placeholder);
            }
        }

        // What ListAccessService.GetHiddenPlaceholderIdsAsync decides on: the TMDB title, or (custom/unverifiable
        // entries) who added it.
        private static string CheckedKey(Placeholder placeholder) =>
            placeholder.Kind == PlaceholderKinds.Custom || placeholder.TmdbId is not > 0
                ? "c|" + placeholder.AddedBy
                : "t|" + placeholder.MediaType + "|" + placeholder.TmdbId!.Value.ToString(CultureInfo.InvariantCulture);
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
        private readonly ListPlaceholderResolver _resolver;
        private readonly ListPlaceholderMetadataService? _metadata;
        private readonly ListPlaceholderSwapService? _swap;
        private readonly ConcurrentDictionary<Guid, SemaphoreSlim> _createLocks = new();

        /// <summary>Creates the service.</summary>
        /// <param name="store">Placeholder store.</param>
        /// <param name="access">Access service.</param>
        /// <param name="host">Jellyfin seam.</param>
        /// <param name="seerrIndex">Seerr status index.</param>
        /// <param name="userManager">User manager.</param>
        /// <param name="logger">JE logger.</param>
        /// <param name="resolver">Granularity resolver (defaults to one over <paramref name="host"/>).</param>
        /// <param name="metadata">Seerr metadata (null: placeholders keep the client's metadata).</param>
        /// <param name="swap">Swap-in service (null: no background passes, no swap on link).</param>
        public ListPlaceholderService(
            ListPlaceholderStore store,
            ListAccessService access,
            IListPlaceholderHost host,
            SeerrMediaIndex seerrIndex,
            IUserManager userManager,
            Logger logger,
            ListPlaceholderResolver? resolver = null,
            ListPlaceholderMetadataService? metadata = null,
            ListPlaceholderSwapService? swap = null)
        {
            _store = store;
            _access = access;
            _host = host;
            _seerrIndex = seerrIndex;
            _userManager = userManager;
            _logger = logger;
            _resolver = resolver ?? new ListPlaceholderResolver(host, logger);
            _metadata = metadata;
            _swap = swap;
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
            if (items.Count > 0)
            {
                // Catches arrivals whose library events were missed (debounced per list, runs in the background).
                _swap?.RequestViewPass(access.ListIdN);
            }

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
        /// POST /{listId}/items: adds placeholders; whatever of a placeholder's scope is already in the library
        /// (accessible to the caller and, for playlists, the owner) is inserted as REAL items at the requested position
        /// instead (C1): a movie replaces its placeholder, present episodes of a season/series/episodes scope go in before a
        /// placeholder that keeps the rest (with <c>filled</c> pre-populated), or replace it once the scope is complete.
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
            // ApplyAsync resolves every placeholder against the library (C1): what is there goes in as real items.
            var entries = placeholders.Select((placeholder, i) => new ApplyEntry(i, null, placeholder)).ToList();
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
        /// <param name="hooks">Optional precondition / same-write follow-up (linked-source provenance and sync).</param>
        /// <returns>The outcome (<see cref="ApplyResultDto"/>).</returns>
        public async Task<ListOutcome> ApplyAsync(ListAccess access, IReadOnlyList<ApplyEntry> entries, PositionDto? position, int? expectedRev, string? requestId, CancellationToken cancellationToken, ApplyHooks? hooks = null)
        {
            var skipped = new List<SkippedEntryDto>();
            var accepted = await PrevalidateAsync(access, entries, skipped, cancellationToken).ConfigureAwait(false);
            accepted = await ExpandAsync(access, accepted, cancellationToken).ConfigureAwait(false);
            await UseServerPostersAsync(accepted.Where(e => e.Placeholder != null).Select(e => e.Placeholder!).ToList(), cancellationToken).ConfigureAwait(false);
            var visibility = await VisibilityAsync(_store.Load(access.ListIdN), access.User, cancellationToken).ConfigureAwait(false);

            var outcome = await RunLockedAsync(access.ListIdN, access.ListIdN, requestId, access.UserIdN, cancellationToken, () =>
                ApplyLockedAsync(access, accepted, skipped, position, expectedRev, visibility, hooks)).ConfigureAwait(false);
            if (outcome.Value is ApplyResultDto { Added.Count: > 0 } applied)
            {
                // Seerr metadata (dates, ids, expected episodes) for the new placeholders, then a swap check, in the background.
                _swap?.QueuePass(access.ListIdN, applied.Added, MetadataMode.New);
            }

            return outcome;
        }

        // C1: resolves every TMDB placeholder against the library as the caller (and, for playlists, the owner). A movie
        // (or, in a collection, a series) that is there becomes a real entry; a TV scope with present episodes becomes those
        // real items (playlists: the episodes in order; collections: the Season / Episode items) followed by the placeholder
        // with `filled` pre-populated, which is dropped when the scope is already complete (season/series: on Seerr metadata
        // read now, within a short budget).
        private async Task<List<ApplyEntry>> ExpandAsync(ListAccess access, List<ApplyEntry> accepted, CancellationToken cancellationToken)
        {
            var isPlaylist = access.List.Kind == ListKinds.Playlist;
            if ((isPlaylist && access.Owner == null) || !accepted.Any(e => e.Placeholder != null && HasTmdb(e.Placeholder)))
            {
                return accepted;
            }

            var users = new List<User> { access.User };
            if (isPlaylist && access.Owner!.Id != access.User.Id)
            {
                users.Add(access.Owner);
            }

            // One memo for the whole apply: an imported watch order has hundreds of entries of a few shows.
            var memo = new ResolveMemo();
            var resolutions = accepted
                .Select(e => e.Placeholder != null && HasTmdb(e.Placeholder) ? _resolver.Resolve(e.Placeholder, access.List.Kind, users, memo) : ScopeResolution.None)
                .ToList();
            var today = DateTime.UtcNow;
            var fresh = await ReadCompletionMetadataAsync(
                accepted.Where((e, i) => e.Placeholder is { Kind: PlaceholderKinds.Season or PlaceholderKinds.Series } && resolutions[i].Episodes.Count > 0)
                    .Select(e => e.Placeholder!)
                    .ToList(),
                today,
                cancellationToken).ConfigureAwait(false);

            var result = new List<ApplyEntry>(accepted.Count);
            for (var i = 0; i < accepted.Count; i++)
            {
                var entry = accepted[i];
                var resolution = resolutions[i];
                var placeholder = entry.Placeholder;
                if (placeholder == null || (!resolution.Found && resolution.Episodes.Count == 0))
                {
                    result.Add(entry);
                    continue;
                }

                if (placeholder.Kind == PlaceholderKinds.Movie || (!isPlaylist && placeholder.Kind == PlaceholderKinds.Series))
                {
                    result.Add(resolution.Found ? entry with { ItemId = resolution.Items[0].ItemId, Placeholder = null } : entry);
                    continue;
                }

                // Collections count a season as filled only once its Season item goes in.
                var filledBy = isPlaylist || resolution.Found ? resolution.Episodes : Array.Empty<ResolvedItem>();
                foreach (var episode in filledBy)
                {
                    placeholder.Filled.AddRange(episode.Coords.Select(c => new FilledEpisode { ItemId = episode.ItemId.ToString("N", CultureInfo.InvariantCulture), S = c.S, E = c.E }));
                }

                var complete = PlaceholderProgress.IsComplete(placeholder, today)
                    && (placeholder.Kind == PlaceholderKinds.Episodes || placeholder.InProduction == false || fresh.Contains(placeholder.Id));

                // Playlists: the placeholder goes where its first missing episode belongs in episode order, so a watch
                // order that starts with episodes the library lacks starts with the placeholder (S1E1–E7 missing, S1E8+
                // present: placeholder first). Nothing missing before or between them: after the present ones.
                var firstMissing = isPlaylist && !complete ? PlaceholderProgress.FirstMissing(placeholder) : null;
                var placed = false;
                foreach (var item in resolution.Items)
                {
                    if (!placed && firstMissing is EpisodeCoord missing && item.Coords.Count > 0 && item.Coords.Min().CompareTo(missing) > 0)
                    {
                        result.Add(entry);
                        placed = true;
                    }

                    result.Add(new ApplyEntry(entry.Index, item.ItemId, null, placeholder, Covers: item.Coords));
                }

                if (!placed)
                {
                    result.Add(complete ? entry with { CompleteIfLanded = true } : entry);
                }
            }

            return result;
        }

        // Season/series completion needs current Seerr metadata (expected episodes, production state): read it for these
        // placeholders within a short budget and merge it in. Returns the ids that got fresh metadata.
        private async Task<HashSet<string>> ReadCompletionMetadataAsync(IReadOnlyList<Placeholder> placeholders, DateTime today, CancellationToken cancellationToken)
        {
            var fresh = new HashSet<string>(StringComparer.Ordinal);
            if (_metadata == null || placeholders.Count == 0 || !ListPlaceholderMetadataService.IsAvailable)
            {
                return fresh;
            }

            using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            budget.CancelAfter(ListPlaceholderSwapService.InteractiveMetadataBudget);
            await Task.WhenAll(placeholders.Select(async placeholder =>
            {
                try
                {
                    var metadata = await _metadata.FetchAsync(placeholder, ListPlaceholderSwapService.CompletionMetadataMaxAge, today, budget.Token).ConfigureAwait(false);
                    if (metadata != null)
                    {
                        ListPlaceholderMetadataService.Apply(placeholder, metadata);
                        if (!metadata.Partial)
                        {
                            lock (fresh)
                            {
                                fresh.Add(placeholder.Id);
                            }
                        }
                    }
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    // over budget: the placeholder is kept; the background pass completes it later
                }
            })).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            return fresh;
        }

        // A TMDB placeholder shows the poster Seerr has for that title, never one the client sent: an editor could pair an
        // allowed title with a blocked title's poster, which restricted viewers would then see on the row and in the list's
        // collage. Read within a short budget; a poster not read in time is left empty (fail closed) and the background
        // metadata pass fills it in. Without Seerr but with a TMDB key the parental filter still rates titles (from TMDB),
        // so the poster is read from TMDB the same way (no background pass then: one not read in time stays empty). With
        // neither, nothing can check it and the client's stays: the filter can't rate those titles either, so restricted
        // viewers never see them.
        private async Task UseServerPostersAsync(IReadOnlyList<Placeholder> placeholders, CancellationToken cancellationToken)
        {
            var titles = placeholders.Where(HasTmdb).ToList();
            var seerr = ListPlaceholderMetadataService.IsAvailable;
            if (titles.Count == 0 || (!seerr && !ListPlaceholderMetadataService.TmdbAvailable))
            {
                return;
            }

            if (_metadata == null)
            {
                titles.ForEach(placeholder => placeholder.PosterPath = null);
                return;
            }

            using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            budget.CancelAfter(ListPlaceholderSwapService.InteractiveMetadataBudget);
            var today = DateTime.UtcNow;
            await Task.WhenAll(titles.Select(async placeholder =>
            {
                string? poster = null;
                try
                {
                    poster = seerr
                        ? (await _metadata.FetchAsync(placeholder, ListPlaceholderMetadataService.CacheTtl, today, budget.Token).ConfigureAwait(false))?.PosterPath
                        : await _metadata.FetchTmdbPosterAsync(placeholder, budget.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    // over budget: no poster for now
                }

                placeholder.PosterPath = poster;
            })).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
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
            PlaceholderVisibility visibility,
            ApplyHooks? hooks = null)
        {
            var doc = _store.LoadForUpdate(access.ListIdN, access.List.Kind);
            if (expectedRev.HasValue && expectedRev.Value != doc.Rev)
            {
                return Conflict(access, "rev_conflict", "The list changed; reload it.", visibility);
            }

            if (hooks?.Precondition?.Invoke(doc) is { } preconditionFailure)
            {
                return Conflict(access, preconditionFailure, "The list's linked source changed; try again.", visibility);
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
                    if (index < 0 || !IsVisibleToken(position.AfterToken, access.User, visibility.For(doc.Items), new Dictionary<Guid, bool>()))
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
            // raw order (placeholders take no raw slot): one Jellyfin insert covers them all. With a Place hook (the
            // linked-list sync) the run is split into one segment per spot, each its own insert.
            var run = new List<NewEntry>();
            var runIndexes = new List<int>(); // entry index of each run element (per-entry placement)
            var collectionItems = new List<Guid>();
            var changed = false;
            var excluded = hooks?.Exclude?.Invoke(doc);

            // Expanded TV scopes (C1): a placeholder that is a duplicate takes its expanded items with it, and expanded
            // items already in the list are skipped quietly (they count as filled). An entry that ends up doing nothing
            // at all is reported once with the reason it was skipped for.
            // A duplicate of an earlier entry of this request names that entry (sameAs), so the caller can say which.
            var orderedEntries = accepted.OrderBy(e => e.Index).ToList();
            var duplicateGroups = new Dictionary<Placeholder, int?>(ReferenceEqualityComparer.Instance);
            var seenGroups = new HashSet<Placeholder>(ReferenceEqualityComparer.Instance);
            var firstWithKey = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var entry in orderedEntries.Where(e => (e.ExpandedFrom ?? e.Placeholder) != null))
            {
                var group = (entry.ExpandedFrom ?? entry.Placeholder)!;
                var key = PlaceholderRules.IdentityKey(group);
                if (!seenGroups.Add(group))
                {
                    continue;
                }

                if (keys.Contains(key))
                {
                    duplicateGroups[group] = null;
                }
                else if (firstWithKey.TryGetValue(key, out var first))
                {
                    duplicateGroups[group] = first;
                }
                else
                {
                    firstWithKey[key] = entry.Index;
                }
            }

            var quietSkips = new Dictionary<int, (string Reason, int? SameAs)>();
            var firstWithItem = new Dictionary<Guid, int>();

            try
            {
                foreach (var entry in orderedEntries)
                {
                    if (excluded?.Contains(entry.Index) == true)
                    {
                        // A C1-expanded entry has several applied parts with one request index: reported once.
                        if (!skipped.Any(x => x.Index == entry.Index))
                        {
                            skipped.Add(Skip(entry, "duplicate"));
                        }

                        continue;
                    }

                    if (entry.ItemId.HasValue)
                    {
                        if (entry.ExpandedFrom != null && duplicateGroups.TryGetValue(entry.ExpandedFrom, out var groupSameAs))
                        {
                            quietSkips.TryAdd(entry.Index, ("duplicate", groupSameAs));
                            continue;
                        }

                        if (!present.Add(entry.ItemId.Value))
                        {
                            int? sameAs = firstWithItem.TryGetValue(entry.ItemId.Value, out var firstItem) && firstItem != entry.Index ? firstItem : null;
                            if (entry.ExpandedFrom != null)
                            {
                                quietSkips.TryAdd(entry.Index, ("alreadyInList", sameAs));
                            }
                            else
                            {
                                skipped.Add(Skip(entry, "alreadyInList", sameAs));
                            }

                            continue;
                        }

                        firstWithItem.TryAdd(entry.ItemId.Value, entry.Index);

                        if (isPlaylist)
                        {
                            run.Add(new NewEntry(entry.ItemId.Value, null));
                            runIndexes.Add(entry.Index);
                        }
                        else
                        {
                            collectionItems.Add(entry.ItemId.Value);
                        }

                        result.AddedAsItems.Add(entry.ItemId.Value.ToString("N", CultureInfo.InvariantCulture));
                        continue;
                    }

                    var placeholder = entry.Placeholder!;
                    if (duplicateGroups.TryGetValue(placeholder, out var duplicateOf) || !keys.Add(PlaceholderRules.IdentityKey(placeholder)))
                    {
                        skipped.Add(Skip(entry, "duplicate", duplicateOf));
                        continue;
                    }

                    if (room <= 0)
                    {
                        if (!entry.CompleteIfLanded)
                        {
                            skipped.Add(Skip(entry, "listFull"));
                        }

                        continue;
                    }

                    room--;
                    doc.Items.Add(placeholder);
                    visibility.Allow(placeholder); // passed the caller's own filter in PrevalidateAsync
                    result.Added.Add(placeholder.Id);
                    changed = true;
                    run.Add(new NewEntry(null, ListPlaceholderOrder.PlaceholderToken(placeholder.Id)));
                    runIndexes.Add(entry.Index);
                }

                if (isPlaylist && run.Count > 0)
                {
                    var anchors = hooks?.Place?.Invoke(doc, order);
                    // One segment per run of consecutive entries with the same spot; inserted from the last spot to the
                    // first so earlier positions (and the tokens of earlier anchors) don't move.
                    foreach (var (at, _, segment) in Segments(order, cursor, run, runIndexes, anchors).OrderByDescending(s => s.At).ThenByDescending(s => s.Order))
                    {
                        var anchor = ListPlaceholderOrder.RealAnchorBefore(order, at);
                        var (desired, inserted) = ListPlaceholderOrder.InsertEntries(order, at, segment);
                        order = desired; // what a failure below is reconciled from
                        if (inserted.Count > 0)
                        {
                            order = await PlaceRealItemsAsync(access, segment.Where(e => e.ItemId.HasValue).Select(e => e.ItemId!.Value).ToList(), anchor, desired, inserted).ConfigureAwait(false);
                        }
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
                PruneUnlandedFills(access, accepted);
                changed = DropLandedCompleteScopes(doc, accepted, result, order);
                if (isPlaylist)
                {
                    order = Canonical(access, new ListDoc { Order = order, Items = doc.Items });
                }

                if (hooks?.AfterFailedApply != null && RecordPartialApply(access, hooks.AfterFailedApply, doc, result, skipped, accepted))
                {
                    changed = true;
                }

                var saved = SaveIfChanged(doc, isPlaylist ? order : null, originalOrder, changed);
                return ListOutcome.Error(500, "list_update_failed", "Jellyfin could not update the list.", BuildView(access, saved, isPlaylist ? order : null, visibility));
            }

            if (result.AddedAsItems.Count > 0)
            {
                // Jellyfin can silently drop an item (e.g. it doesn't support playlists): report only what landed.
                var landed = PruneUnlandedFills(access, accepted);
                foreach (var entry in accepted.Where(e => e.ItemId.HasValue && !landed.Contains(e.ItemId.Value.ToString("N", CultureInfo.InvariantCulture))))
                {
                    // An expanded item that didn't land is tracked by its placeholder (swap-in retries it); without one in
                    // the list (a duplicate or full list) it is reported like any other rejected item.
                    var tracked = entry.ExpandedFrom != null && doc.Items.Any(p => ReferenceEquals(p, entry.ExpandedFrom));
                    if (result.AddedAsItems.Remove(entry.ItemId!.Value.ToString("N", CultureInfo.InvariantCulture)) && !tracked
                        && !skipped.Any(x => x.Index == entry.Index && x.Reason == "rejected"))
                    {
                        skipped.Add(Skip(entry, "rejected"));
                    }
                }
            }

            changed = DropLandedCompleteScopes(doc, accepted, result, order);

            // An entry that did nothing visible (all its expanded items already there, or a duplicate scope) is reported once.
            var addedIds = new HashSet<string>(result.Added, StringComparer.Ordinal);
            var addedItems = new HashSet<string>(result.AddedAsItems, StringComparer.Ordinal);
            foreach (var (index, (reason, sameAs)) in quietSkips)
            {
                var acted = accepted.Any(e => e.Index == index
                    && ((e.Placeholder != null && addedIds.Contains(e.Placeholder.Id))
                        || (e.ItemId.HasValue && addedItems.Contains(e.ItemId.Value.ToString("N", CultureInfo.InvariantCulture)))));
                if (!acted && !skipped.Any(x => x.Index == index))
                {
                    skipped.Add(new SkippedEntryDto { Index = index, Reason = reason, SameAs = sameAs });
                }
            }

            result.Skipped = skipped.OrderBy(s => s.Index).ToList();
            if (hooks?.AfterApplyAsync != null)
            {
                if (isPlaylist)
                {
                    doc.Order = order; // the hook places placeholders it adds (a split season) in the current order
                }

                bool hookChanged;
                try
                {
                    hookChanged = await hooks.AfterApplyAsync(doc, result, accepted).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    // Jellyfin was already updated: save what landed (and its provenance) before giving up, else the next
                    // apply finds those entries again as hand-added ones.
                    _logger.Warning($"[ListPlaceholders] Finishing the update of list {access.ListIdN} failed: {ex.Message}");
                    if (hooks.AfterFailedApply != null)
                    {
                        result.Added.RemoveAll(id => !doc.Items.Any(p => p.Id == id));
                        RecordPartialApply(access, hooks.AfterFailedApply, doc, result, skipped, accepted);
                    }

                    if (isPlaylist)
                    {
                        order = Canonical(access, new ListDoc { Order = doc.Order, Items = doc.Items });
                    }

                    try
                    {
                        SaveIfChanged(doc, isPlaylist ? order : null, originalOrder, true);
                    }
                    catch (Exception saveEx)
                    {
                        _logger.Error($"[ListPlaceholders] Saving list {access.ListIdN} after a failed update failed: {saveEx.Message}");
                    }

                    throw;
                }

                if (hookChanged)
                {
                    // Same locked write: provenance and sync removals; re-read Jellyfin if real entries were removed.
                    changed = true;
                    if (isPlaylist)
                    {
                        order = Canonical(access, new ListDoc { Order = doc.Order, Items = doc.Items });
                    }
                }
            }

            var final = SaveIfChanged(doc, isPlaylist ? order : null, originalOrder, changed);
            result.View = BuildView(access, final, isPlaylist ? order : null, visibility);
            return ListOutcome.Ok(result);
        }

        // Splits the new entries of one apply into contiguous segments by where they go: without per-entry anchors the
        // whole run goes to `cursor`; with them, each entry goes after/before its anchor token (missing or absent anchor →
        // `cursor`). Returns (insert index in `order`, source-order rank, entries).
        private static List<(int At, int Order, List<NewEntry> Entries)> Segments(IReadOnlyList<string> order, int cursor, List<NewEntry> run, List<int> runIndexes, IReadOnlyDictionary<int, EntryAnchor>? anchors)
        {
            if (anchors == null || anchors.Count == 0)
            {
                return new List<(int, int, List<NewEntry>)> { (cursor, 0, run) };
            }

            var positions = new Dictionary<string, int>(StringComparer.Ordinal);
            for (var i = 0; i < order.Count; i++)
            {
                positions.TryAdd(order[i], i);
            }

            int Spot(EntryAnchor? anchor) =>
                anchor?.AfterToken != null && positions.TryGetValue(anchor.AfterToken, out var after) ? after + 1
                : anchor?.BeforeToken != null && positions.TryGetValue(anchor.BeforeToken, out var before) ? before
                : cursor;

            var segments = new List<(int At, int Order, List<NewEntry> Entries)>();
            for (var i = 0; i < run.Count; i++)
            {
                var at = Spot(anchors.GetValueOrDefault(runIndexes[i]));
                if (segments.Count > 0 && segments[^1].At == at)
                {
                    segments[^1].Entries.Add(run[i]);
                }
                else
                {
                    segments.Add((at, segments.Count, new List<NewEntry> { run[i] }));
                }
            }

            return segments;
        }

        // C1: a placeholder whose scope was already complete in the library goes once every expanded item really is in
        // the list (its pruned `filled` still completes it). One whose items Jellyfin rejected or failed stays and tracks
        // them. Returns whether a placeholder is still added (the document must be written).
        private static bool DropLandedCompleteScopes(ListDoc doc, IReadOnlyList<ApplyEntry> accepted, ApplyResultDto result, List<string> order)
        {
            var today = DateTime.UtcNow;
            foreach (var placeholder in accepted.Where(e => e.CompleteIfLanded && e.Placeholder != null).Select(e => e.Placeholder!))
            {
                if (result.Added.Contains(placeholder.Id) && PlaceholderProgress.IsComplete(placeholder, today))
                {
                    doc.Items.Remove(placeholder);
                    result.Added.Remove(placeholder.Id);
                    order.Remove(ListPlaceholderOrder.PlaceholderToken(placeholder.Id));
                }
            }

            return result.Added.Count > 0;
        }

        // A placeholder's pre-populated `filled` may only name episodes that really are in the list now (a collection
        // season: once its Season item is): drops the others (Jellyfin rejected them, or the insert failed) so swap-in
        // adds them later. Returns the ids now in the list.
        private HashSet<string> PruneUnlandedFills(ListAccess access, IReadOnlyList<ApplyEntry> accepted)
        {
            var landed = new HashSet<string>(
                _host.GetRawEntries(access.List.Id).Where(r => r.Resolved && r.ItemId.HasValue).Select(r => r.ItemId!.Value.ToString("N", CultureInfo.InvariantCulture)),
                StringComparer.Ordinal);
            foreach (var group in accepted.Select(e => e.ExpandedFrom).OfType<Placeholder>().Distinct())
            {
                if (access.List.Kind == ListKinds.Collection && group.Kind == PlaceholderKinds.Season)
                {
                    // Each episode counts through the Season item of its show copy: only the landed ones' coordinates stay.
                    var landedCoords = accepted
                        .Where(e => ReferenceEquals(e.ExpandedFrom, group) && e.ItemId.HasValue
                            && landed.Contains(e.ItemId.Value.ToString("N", CultureInfo.InvariantCulture)))
                        .SelectMany(e => e.Covers ?? Array.Empty<EpisodeCoord>())
                        .ToHashSet();
                    group.Filled.RemoveAll(f => !landedCoords.Contains(new EpisodeCoord(f.S, f.E)));
                }
                else
                {
                    group.Filled.RemoveAll(f => !landed.Contains(f.ItemId));
                }
            }

            return landed;
        }

        // Puts a contiguous run of new real items into Jellyfin right after `anchor` (see ListPlaylistPlacement).
        private Task<List<string>> PlaceRealItemsAsync(ListAccess access, IReadOnlyList<Guid> items, string? anchor, List<string> desired, IReadOnlyList<string> inserted) =>
            ListPlaylistPlacement.PlaceAsync(_host, _logger, access.List.Id, access.ListIdN, access.Owner!, items, anchor, desired, inserted);

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

            if (link != null)
            {
                await UseServerPostersAsync(new[] { link }, cancellationToken).ConfigureAwait(false);
            }

            // A linked title gets its Seerr metadata now (release date, ids, expected episodes) so it can be swapped in
            // right away when it is already in the library.
            var linkFresh = link != null && HasTmdb(link)
                && (await ReadCompletionMetadataAsync(new[] { link }, DateTime.UtcNow, cancellationToken).ConfigureAwait(false)).Count > 0;
            var visibility = await VisibilityAsync(_store.Load(access.ListIdN), access.User, cancellationToken).ConfigureAwait(false);
            var outcome = await RunLockedAsync(access.ListIdN, access.ListIdN, requestId, access.UserIdN, cancellationToken, async () =>
            {
                var doc = _store.LoadForUpdate(access.ListIdN, access.List.Kind);
                if (doc.Rev != rev)
                {
                    return Conflict(access, "rev_conflict", "The list changed; reload it.", visibility);
                }

                var placeholder = doc.Items.FirstOrDefault(p => p.Id == placeholderId);
                if (placeholder == null || !visibility.IsVisible(placeholder))
                {
                    return ListOutcome.Error(404, "not_found", "Placeholder not found.");
                }

                if (link != null)
                {
                    if (placeholder.Kind != PlaceholderKinds.Custom)
                    {
                        return ListOutcome.Error(400, "not_custom", "Only custom entries can be linked to a title.");
                    }

                    var key = PlaceholderRules.IdentityKey(link);
                    if (doc.Items.Any(p => p.Id != placeholderId && PlaceholderRules.IdentityKey(p) == key))
                    {
                        return Conflict(access, "duplicate", "This title is already in the list.", visibility);
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
                    placeholder.Expected = link.Expected;
                    placeholder.Filled = new List<FilledEpisode>();
                    placeholder.InProduction = link.InProduction;
                    if (link.Note != null && note == null)
                    {
                        placeholder.Note = link.Note;
                    }

                    visibility.Allow(placeholder); // the linked title passed the caller's filter above
                }

                if (note != null)
                {
                    placeholder.Note = note.Length == 0 ? null : note;
                }

                if (link != null && _swap != null)
                {
                    // Whatever of the linked scope is already in the library goes in at the entry's spot now (C1). This
                    // is the swap-in of §9, so it runs as the playlist owner (collections: unscoped), exactly like the
                    // background pass queued below would a moment later; the caller's own library access is not what
                    // decides (C5's caller checks cover items the client sends, not swap-in).
                    var fresh = linkFresh ? new HashSet<string>(StringComparer.Ordinal) { placeholderId } : null;
                    var swapped = await _swap.SwapLockedAsync(access.List, access.Owner, doc, new[] { placeholderId }, null, fresh, linkFresh ? MetadataMode.Completion : MetadataMode.None, cancellationToken).ConfigureAwait(false);
                    doc = swapped.Doc;
                }

                var canonical = access.List.Kind == ListKinds.Playlist ? Canonical(access, doc) : null;
                if (canonical != null)
                {
                    doc.Order = canonical;
                }

                var saved = _store.Save(doc);
                return ListOutcome.Ok(BuildView(access, saved, canonical, visibility));
            }).ConfigureAwait(false);
            if (link != null && outcome.StatusCode < 300)
            {
                _swap?.QueuePass(access.ListIdN, new[] { placeholderId }, MetadataMode.New);
            }

            return outcome;
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
                if (placeholder == null || !visibility.IsVisible(placeholder))
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
        /// natively, else as the owner) with the index (or two) that replays to the full desired order (refused with 409
        /// <c>move_unsupported</c> when none does), then verified.
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
                var placeholderVisible = visibility.For(doc.Items);
                bool VisibleToCaller(string token) => IsVisibleToken(token, access.User, placeholderVisible, callerVisible);

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
                    // A5/F2: the move(s) that give the full desired order, hidden rows included; none → change nothing.
                    var moves = ListPlaceholderOrder.FindMoves(
                        _host.GetRawEntries(access.List.Id),
                        itemId,
                        desiredReal,
                        id => EntryVisible(ListPlaceholderOrder.RealToken(id, 0), mover, moverVisible));
                    if (moves == null)
                    {
                        return Conflict(access, "move_unsupported", "Jellyfin can't move the entry there without also moving entries that are hidden or missing.", visibility, canonical, doc);
                    }

                    try
                    {
                        foreach (var newIndex in moves)
                        {
                            await _host.MoveInPlaylistAsync(access.List.Id, itemId, newIndex, mover.Id).ConfigureAwait(false);
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger.Error($"[ListPlaceholders] Moving an entry of list {access.ListIdN} failed: {ex.Message}");
                        return Conflict(access, "move_failed", "Jellyfin could not move the entry.", visibility, Canonical(access, doc), doc);
                    }

                    var actual = ListPlaceholderOrder.BuildRealTokens(_host.GetRawEntries(access.List.Id));
                    var relabelled = ListPlaceholderOrder.Relabel(merge.Desired);
                    final = ListPlaceholderOrder.Reconcile(relabelled, actual, doc.Items.Select(p => p.Id).ToList());
                    // Every real row, including rows hidden from the caller, must be where the desired order puts it.
                    success = actual.SequenceEqual(relabelled.Where(ListPlaceholderOrder.IsReal), StringComparer.Ordinal);
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
        /// <param name="hooks">Optional same-write follow-up of the initial apply (linked-source provenance).</param>
        /// <returns>The outcome (<see cref="CreateListResultDto"/>).</returns>
        public async Task<ListOutcome> CreateListAsync(User user, string kind, string name, bool isPublic, IReadOnlyList<ApplyEntry> entries, string? requestId, CancellationToken cancellationToken, Func<ListAccess, ApplyHooks?>? hooks = null)
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
                var applied = await ApplyAsync(access, entries, null, null, null, cancellationToken, hooks?.Invoke(access)).ConfigureAwait(false);
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
            var items = (doc?.Items ?? new List<Placeholder>()).Where(visibility.IsVisible).ToList();
            var view = new ListViewDto
            {
                ListId = access.ListIdN,
                ListKind = access.List.Kind,
                Rev = doc?.Rev ?? 0,
                CanEdit = access.Permissions.CanEdit,
                NativeCanEdit = access.Permissions.NativeCanEdit,
                SeerrEnabled = seerrEnabled,
                SeerrStatusReady = !seerrEnabled || !items.Any(HasTmdb) || _seerrIndex.IsReady,
            };

            var today = DateTime.UtcNow;
            var callerVisible = new Dictionary<Guid, bool>(); // rows (playlists) / access (collections), per item
            var byId = items.ToDictionary(p => p.Id, StringComparer.Ordinal);
            IEnumerable<Placeholder> ordered;
            if (access.List.Kind == ListKinds.Playlist && canonical != null)
            {
                var placeholderVisible = visibility.For(items);
                view.Order = ListPlaceholderOrder.Project(canonical, t => IsVisibleToken(t, access.User, placeholderVisible, callerVisible));
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
                    FilledCount = VisibleFilledCount(access, placeholder, callerVisible),
                    Note = placeholder.Note,
                    AddedByMe = string.Equals(placeholder.AddedBy, access.UserIdN, StringComparison.Ordinal),
                    AddedAt = placeholder.AddedAt,
                    Status = status,
                    ExpectedCount = PlaceholderProgress.ExpectedCount(placeholder),
                    AiredCount = PlaceholderProgress.AiredCount(placeholder, today),
                    InProduction = placeholder.InProduction,
                    InLibraryItemId = PendingMatchFor(access, placeholder.Id),
                });
            }

            if (doc?.Source != null)
            {
                view.Source = SourceView(doc.Source, SeesWholeList(access, doc, items.Count, canonical, view.Order));
            }

            return view;
        }

        // A2: a linked source's sync counts (added/removed/kept/not found) and its English summary describe the whole
        // list, so they are shown only to callers who see every entry; others get the state, codes and timestamps.
        private static ListSourceDto SourceView(ListSource source, bool fullDetail)
        {
            var last = source.LastSync;
            var countFree = last?.State is "failed" or "paused" && last.Code != "apply_failed";
            return new ListSourceDto
            {
                Kind = source.Kind,
                Url = source.Url,
                Title = source.Title,
                SyncEnabled = source.SyncEnabled,
                RemoveDropped = source.RemoveDropped,
                LastSyncAt = source.LastSyncAt,
                LastSyncResult = fullDetail || countFree ? source.LastSyncResult : null,
                PausedReason = source.PausedReason,
                LastSync = fullDetail || last == null ? last : new SourceSyncSummary { State = last.State, Code = last.Code, Truncated = last.Truncated, Partial = last.Partial },
                PausedCode = source.PausedCode,
                CountsHidden = fullDetail ? null : true,
            };
        }

        // Whether the caller sees every entry of the list: no placeholder hidden by the parental filter and, in a
        // playlist, every row of the canonical order (in a collection, every item).
        private bool SeesWholeList(ListAccess access, ListDoc doc, int visiblePlaceholders, IReadOnlyList<string>? canonical, IReadOnlyList<string>? projected)
        {
            if (visiblePlaceholders != doc.Items.Count)
            {
                return false;
            }

            if (access.List.Kind == ListKinds.Playlist && canonical != null && projected != null)
            {
                return projected.Count == canonical.Count;
            }

            try
            {
                return _host.GetRawEntries(access.List.Id)
                    .Where(r => r.Resolved && r.ItemId.HasValue)
                    .All(r => access.List.Kind == ListKinds.Playlist ? _host.IsEntryVisible(r.ItemId!.Value, access.User) : _host.CanAccessItem(r.ItemId!.Value, access.User));
            }
            catch (Exception ex)
            {
                _logger.Debug($"[ListPlaceholders] Access check of list {access.ListIdN} failed: {ex.Message}");
                return false;
            }
        }

        // A2: filled episodes were inserted with the OWNER's rights, so only those the caller may see count: in a
        // playlist the episodes whose rows the caller sees (the same rule as the projected order, i.e. Jellyfin's own
        // playlist rows), in a collection the episodes the caller can access. The count never reveals hidden items.
        private int VisibleFilledCount(ListAccess access, Placeholder placeholder, Dictionary<Guid, bool> memo)
        {
            var count = 0;
            foreach (var filled in placeholder.Filled)
            {
                if (!Guid.TryParseExact(filled.ItemId, "N", out var itemId))
                {
                    continue;
                }

                if (!memo.TryGetValue(itemId, out var accessible))
                {
                    try
                    {
                        accessible = access.List.Kind == ListKinds.Playlist
                            ? _host.IsEntryVisible(itemId, access.User)
                            : _host.CanAccessItem(itemId, access.User);
                    }
                    catch (Exception ex)
                    {
                        _logger.Debug($"[ListPlaceholders] Access check failed for {itemId:N}: {ex.Message}");
                        accessible = false;
                    }

                    memo[itemId] = accessible;
                }

                if (accessible)
                {
                    count++;
                }
            }

            return count;
        }

        // The library item a pending swap-in matched, only when the caller can access it.
        private string? PendingMatchFor(ListAccess access, string placeholderId)
        {
            var itemId = _swap?.GetPendingMatch(access.ListIdN, placeholderId);
            try
            {
                return itemId.HasValue && _host.CanAccessItem(itemId.Value, access.User) ? itemId.Value.ToString("N", CultureInfo.InvariantCulture) : null;
            }
            catch (Exception ex)
            {
                _logger.Debug($"[ListPlaceholders] Access check failed for {itemId:N}: {ex.Message}");
                return null;
            }
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

        // A failed apply still saves the placeholders it added (and Jellyfin may have added some real items): narrow the
        // result to what is in the list now and let the hook record its provenance in the same write. Nothing landed →
        // nothing to record. Never throws: the caller is already reporting the original failure.
        private bool RecordPartialApply(ListAccess access, Func<ListDoc, ApplyResultDto, IReadOnlyList<ApplyEntry>, bool> hook, ListDoc doc, ApplyResultDto result, List<SkippedEntryDto> skipped, IReadOnlyList<ApplyEntry> applied)
        {
            try
            {
                if (result.AddedAsItems.Count > 0)
                {
                    var landed = new HashSet<string>(
                        _host.GetRawEntries(access.List.Id).Where(r => r.Resolved && r.ItemId.HasValue).Select(r => r.ItemId!.Value.ToString("N", CultureInfo.InvariantCulture)),
                        StringComparer.Ordinal);
                    result.AddedAsItems.RemoveAll(id => !landed.Contains(id));
                }

                if (result.Added.Count == 0 && result.AddedAsItems.Count == 0)
                {
                    return false;
                }

                result.Skipped = skipped.OrderBy(s => s.Index).ToList();
                return hook(doc, result, applied);
            }
            catch (Exception ex)
            {
                _logger.Warning($"[ListPlaceholders] Recording what a failed update of list {access.ListIdN} added failed: {ex.Message}");
                return false;
            }
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

                // F5: the list may have been deleted (and its document removed) since access was checked; writing now
                // would recreate an orphan document.
                if (_host.GetList(Guid.ParseExact(listIdN, "N")) == null)
                {
                    return ListOutcome.Error(404, "not_found", "List not found.");
                }

                var outcome = await body().ConfigureAwait(false);
                if (requestId != null && outcome.StatusCode < 300 && outcome.Value != null)
                {
                    _store.RememberReplay(scope, requestId, userIdN, outcome.StatusCode, JsonSerializer.Serialize(outcome.Value, outcome.Value.GetType(), ReplayJson));
                }

                return outcome;
            }
        }

        private bool IsVisibleToken(string token, User user, Func<string, bool> placeholderVisible, Dictionary<Guid, bool> memo)
        {
            var placeholderId = ListPlaceholderOrder.PlaceholderIdOf(token);
            return placeholderId != null ? placeholderVisible(placeholderId) : EntryVisible(token, user, memo);
        }

        // A2/C5: which placeholders the caller may see. Unrestricted callers see everything. Restricted callers get an
        // ALLOWLIST of the placeholders that were checked against their parental filter, bound to the checked title or
        // author: a placeholder that another editor adds or relinks after this check (between the snapshot and the list
        // lock) is hidden until the caller's next view (fail closed).
        private async Task<PlaceholderVisibility> VisibilityAsync(ListDoc? doc, User user, CancellationToken cancellationToken)
        {
            if (!_access.IsRestricted(user))
            {
                return PlaceholderVisibility.Unrestricted();
            }

            var items = doc?.Items ?? new List<Placeholder>();
            var hidden = await _access.GetHiddenPlaceholderIdsAsync(items, user, cancellationToken).ConfigureAwait(false);
            return PlaceholderVisibility.Allowlist(items.Where(p => !hidden.Contains(p.Id)));
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

        private static SkippedEntryDto Skip(ApplyEntry entry, string reason, int? sameAs = null) => new() { Index = entry.Index, Reason = reason, SameAs = sameAs };
    }
}
