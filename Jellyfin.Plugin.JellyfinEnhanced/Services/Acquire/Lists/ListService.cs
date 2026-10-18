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
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
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

    /// <summary>A client request id and the server's digest of what that request asked for (durable idempotency).</summary>
    /// <param name="RequestId">The client's request id.</param>
    /// <param name="Fingerprint">Digest of the normalized request.</param>
    public sealed record ListRequestKey(string RequestId, string Fingerprint);

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
        private readonly string _stamp;

        private PlaceholderVisibility(Dictionary<string, string>? allowed, string stamp)
        {
            _allowed = allowed;
            _stamp = stamp;
        }

        /// <summary>Every placeholder is visible.</summary>
        /// <param name="stamp">The limits it was decided with (<see cref="ListAccessService.ParentalStamp"/>).</param>
        /// <returns>The visibility.</returns>
        public static PlaceholderVisibility Unrestricted(string stamp = "-") => new(null, stamp);

        /// <summary>Only these placeholders, as they were when checked, are visible.</summary>
        /// <param name="placeholders">Checked, visible placeholders.</param>
        /// <param name="stamp">The limits they were checked with.</param>
        /// <returns>The visibility.</returns>
        public static PlaceholderVisibility Allowlist(IEnumerable<Placeholder> placeholders, string stamp)
        {
            var allowed = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var placeholder in placeholders)
            {
                allowed[placeholder.Id] = CheckedKey(placeholder);
            }

            return new(allowed, stamp);
        }

        /// <summary>Whether this visibility was checked with these limits (else it must be checked again).</summary>
        /// <param name="stamp">The current limits.</param>
        /// <returns>Whether they are the same.</returns>
        public bool Matches(string stamp) => string.Equals(_stamp, stamp, StringComparison.Ordinal);

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
    /// The list operations behind <c>/JellyfinEnhanced/acquire/lists</c>: views (canonical order, per-caller projection,
    /// the caller's request status from the shared status service), adds and ordered applies (real items inserted at the
    /// right spot in both Jellyfin coordinate systems), entry edits, drag reorders (incl. the server-side Jellyfin move),
    /// the swap-in switch and list creation. Callers authorise first (<see cref="ListAccessService"/>), and the list access
    /// gate (<see cref="ListGate"/>) decides again right before every Jellyfin write and every answer; every mutation runs
    /// under the store's per-list lock, checks <c>rev</c> where required and is idempotent per client request id through
    /// durable operations (<see cref="ListOperations"/>): a retry is answered from the operation and the list projected for
    /// the caller now, never from a stored view.
    /// </summary>
    public sealed class ListService
    {
        private static readonly JsonSerializerOptions ResultJson = new() { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull };

        private readonly ListStore _store;
        private readonly ListAccessService _access;
        private readonly ListGate _gate;
        private readonly IListHost _host;
        private readonly ListOperations? _operations;
        private readonly IListStatusSource? _status;
        private readonly IListPreferences? _preferences;
        private readonly Func<Guid, RequestCapabilities?>? _capabilities;
        private readonly IUserManager _userManager;
        private readonly Logger _logger;
        private readonly ListResolver _resolver;
        private readonly IListMetadataSource? _metadata;
        private readonly ListSwapService? _swap;
        private readonly ConcurrentDictionary<Guid, SemaphoreSlim> _createLocks = new();
        // One collection create per destination at a time, across people (keyed by the full path, without case).
        private readonly ConcurrentDictionary<string, SemaphoreSlim> _destinationLocks = new(StringComparer.OrdinalIgnoreCase);
        // Lists JE created whose chosen name isn't known to be saved: a rename failed, maybe after Jellyfin had changed its
        // cached item, which then shows the name. A retry renames them again until a save succeeds.
        private readonly ConcurrentDictionary<Guid, byte> _unsavedNames = new();

        /// <summary>Creates the service.</summary>
        /// <param name="store">Placeholder store.</param>
        /// <param name="access">Access service.</param>
        /// <param name="host">Jellyfin seam.</param>
        /// <param name="userManager">User manager.</param>
        /// <param name="logger">JE logger.</param>
        /// <param name="resolver">Granularity resolver (defaults to one over <paramref name="host"/>).</param>
        /// <param name="metadata">Seerr metadata (null: placeholders keep the client's metadata).</param>
        /// <param name="swap">Swap-in service (null: no background passes, no swap on link).</param>
        /// <param name="operations">Durable operations (null: retries aren't recognised).</param>
        /// <param name="status">The shared request status for list views (null: none).</param>
        /// <param name="preferences">Per-person list preferences (null: everyone follows the administrator).</param>
        /// <param name="capabilities">The caller's request capabilities (null: no request actions).</param>
        public ListService(
            ListStore store,
            ListAccessService access,
            IListHost host,
            IUserManager userManager,
            Logger logger,
            ListResolver? resolver = null,
            IListMetadataSource? metadata = null,
            ListSwapService? swap = null,
            ListOperations? operations = null,
            IListStatusSource? status = null,
            IListPreferences? preferences = null,
            Func<Guid, RequestCapabilities?>? capabilities = null)
        {
            _store = store;
            _access = access;
            _gate = access.Gate;
            _host = host;
            _userManager = userManager;
            _logger = logger;
            _resolver = resolver ?? new ListResolver(host, logger);
            _metadata = metadata;
            _swap = swap;
            _operations = operations;
            _status = status;
            _preferences = preferences;
            _capabilities = capabilities;
        }

        /// <summary>Clock (tests move it).</summary>
        internal Func<DateTimeOffset> Now { get; set; } = () => DateTimeOffset.UtcNow;

        private static PluginConfiguration? Config => JellyfinEnhanced.Instance?.Configuration;

        private bool MetadataAvailable => _metadata?.Available == true;

        private bool PostersAvailable => _metadata?.PostersAvailable == true;

        // ── Views ────────────────────────────────────────────────────────────

        /// <summary>
        /// The caller's view of a list as they may see it when it is answered (the GET route, a confirmation's answer, a
        /// replayed create): their access is read again first, the canonical order reconciled with Jellyfin's current
        /// entries (and persisted when it changed: A1, always the canonical order, never a projection), the statuses read
        /// (which can take a while with a slow Sonarr/Radarr), and the view built by the gate with their access and limits
        /// as they are then. The statuses are composed for the caller's policy (an administrator's carry more), so they go
        /// into the view only when the caller's policy is still the one they were read under; else they are read again,
        /// and left out when it keeps changing. Null when they can no longer see the list.
        /// </summary>
        /// <param name="access">The access checked earlier (CanView).</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The view, or null.</returns>
        public async Task<ListViewDto?> ViewAsync(ListAccess access, CancellationToken cancellationToken)
        {
            if (_gate.Current(access) is not { } current)
            {
                return null;
            }

            var (doc, canonical) = await ListContinuation.Await(() => ReconciledAsync(current, cancellationToken)).ConfigureAwait(false);
            var items = doc?.Items ?? new List<Placeholder>();
            if (items.Count > 0)
            {
                // Catches arrivals whose library events were missed (debounced per list, runs in the background).
                _swap?.RequestViewPass(current.ListIdN);
            }

            for (var attempt = 0; ; attempt++)
            {
                var visibility = await ListContinuation.Await(() => _gate.VisibilityAsync(items, current.User, cancellationToken)).ConfigureAwait(false);
                var policy = _gate.Policy(current.User);
                var statuses = await ListContinuation.Await(() => StatusesAsync(current, items.Where(visibility.IsVisible).ToList(), cancellationToken)).ConfigureAwait(false);
                var stale = false;
                var view = await ListContinuation.Await(() => _gate.ProjectAsync(current, items, visibility, grant => BuildView(grant, doc, canonical, Fresh(grant, policy, statuses, ref stale)), cancellationToken)).ConfigureAwait(false);
                if (view == null || !stale || attempt >= 2)
                {
                    return view;
                }

                // The caller's policy changed while the statuses were read: read them again as they are now.
                current = _gate.Current(current) ?? current;
            }
        }

        // Statuses read under the caller's policy revision, kept only while it is still theirs (else none, and the caller
        // reads them again).
        private static IReadOnlyDictionary<string, JsonElement>? Fresh(ListGrant grant, string policy, IReadOnlyDictionary<string, JsonElement>? statuses, ref bool stale)
        {
            if (string.Equals(grant.Policy, policy, StringComparison.Ordinal))
            {
                return statuses;
            }

            stale = true;
            return null;
        }

        // A playlist's document with its order reconciled to Jellyfin's current entries, saved when that changed (the
        // list's own bookkeeping, not a change of the caller's); collections: the document as it is.
        private async Task<(ListDoc? Doc, List<string>? Canonical)> ReconciledAsync(ListAccess access, CancellationToken cancellationToken)
        {
            var doc = _store.Load(access.ListIdN);
            if (access.List.Kind != ListKinds.Playlist)
            {
                return (doc, null);
            }

            var canonical = Canonical(access, doc);
            if (doc == null || doc.Items.Count == 0 || canonical.SequenceEqual(doc.Order, StringComparer.Ordinal))
            {
                return (doc, canonical);
            }

            using (await ListContinuation.Await(() => _store.LockAsync(access.ListIdN, cancellationToken)).ConfigureAwait(false))
            {
                return Reconciled(access);
            }
        }

        // Under the list lock: the document reconciled to Jellyfin's entries, saved when its order changed.
        private (ListDoc? Doc, List<string> Canonical) Reconciled(ListAccess access)
        {
            var fresh = _store.LoadForUpdate(access.ListIdN, access.List.Kind);
            var canonical = Canonical(access, fresh);
            if (!canonical.SequenceEqual(fresh.Order, StringComparer.Ordinal))
            {
                fresh.Order = canonical;
                return (_store.Save(fresh), canonical);
            }

            return (_store.Load(access.ListIdN), canonical);
        }

        // The caller's shared request status per title key, when the admin switch and the caller's preference show it.
        private async Task<IReadOnlyDictionary<string, JsonElement>?> StatusesAsync(ListAccess access, IReadOnlyList<Placeholder> visible, CancellationToken cancellationToken)
        {
            if (_status == null || !StatusShown(access.User.Id))
            {
                return null;
            }

            var keyed = visible.Where(p => ListRules.TitleKeyOf(p) != null).ToList();
            if (keyed.Count == 0)
            {
                return null;
            }

            try
            {
                // Standard movies and series: the title's status.
                var keys = keyed.Where(p => StatusPartOf(p) == null && p.Kind is not (PlaceholderKinds.Season or PlaceholderKinds.Episodes))
                    .Select(ListRules.TitleKeyOf).OfType<TitleKey>().Distinct().ToList();
                var statuses = new Dictionary<string, JsonElement>(
                    keys.Count == 0 ? new Dictionary<string, JsonElement>() : await ListContinuation.Await(() => _status.StatusesAsync(access.User.Id, keys, cancellationToken)).ConfigureAwait(false),
                    StringComparer.Ordinal);
                // Standard seasons: the season's status (a series card reads Ready once any season is in).
                // With the episodes each entry knows of its season (its expected episode list), so a season no Sonarr
                // holds reads out once one aired.
                var today = Now().UtcDateTime;
                var seasons = keyed
                    .Where(p => StatusPartOf(p) == null && p.Kind is PlaceholderKinds.Season or PlaceholderKinds.Episodes && p.SeasonNumber is int && p.TmdbId is > 0)
                    .GroupBy(p => (Key: ListRules.TitleKeyOf(p)!, TmdbId: p.TmdbId!.Value, Season: p.SeasonNumber!.Value))
                    .Select(g => new ListStatusSeason(
                        g.Key.Key,
                        g.Key.TmdbId,
                        g.Key.Season,
                        g.SelectMany(p => p.Expected).Where(e => e != null && e.S == g.Key.Season)
                            .Select(e => (e.E, e.AirDate != null && ListRules.TryParseDate(e.AirDate, out var aired) ? aired : (DateTime?)null))
                            .ToList(),
                        g.Any(p => ListRules.IsReleased(p, today))))
                    .ToList();
                if (seasons.Count > 0)
                {
                    foreach (var pair in await ListContinuation.Await(() => _status.SeasonStatusesAsync(access.User.Id, seasons, cancellationToken)).ConfigureAwait(false))
                    {
                        statuses[pair.Key] = pair.Value;
                    }
                }

                // Episodes entries and 4K entries: their own scope's status, keyed apart from the season's and the standard one.
                var parts = keyed.Select(StatusPartOf).OfType<ListStatusPart>().DistinctBy(p => p.Id).ToList();
                if (parts.Count > 0)
                {
                    foreach (var pair in await ListContinuation.Await(() => _status.PartStatusesAsync(access.User.Id, parts, cancellationToken)).ConfigureAwait(false))
                    {
                        statuses[pair.Key] = pair.Value;
                    }
                }

                return statuses;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.Debug($"[Lists] Request status for list {access.ListIdN} failed: {ex.Message}");
                return null;
            }
        }

        private bool StatusShown(Guid user) => ListFlags.Display(ListFlags.Status(Config), _preferences?.For(user).Status);

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
        /// <param name="request">Client request id and request digest (null: not idempotent).</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <param name="recheckAccess">Kept for callers; the gate always reads the caller's rights again (see <see cref="ApplyAsync"/>).</param>
        /// <returns>The outcome (<see cref="ApplyResultDto"/>).</returns>
        public Task<ListOutcome> AddPlaceholdersAsync(ListAccess access, IReadOnlyList<Placeholder> placeholders, PositionDto? position, int? expectedRev, ListRequestKey? request, CancellationToken cancellationToken, bool recheckAccess = false)
        {
            // ApplyAsync resolves every placeholder against the library (C1): what is there goes in as real items.
            var entries = placeholders.Select((placeholder, i) => new ApplyEntry(i, null, placeholder)).ToList();
            return ApplyAsync(access, entries, position, expectedRev, request, cancellationToken, recheckAccess: recheckAccess, kind: "add");
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
        /// <param name="request">Client request id and request digest (null: not idempotent).</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <param name="hooks">Optional precondition / same-write follow-up (linked-source provenance and sync).</param>
        /// <param name="recheckAccess">
        /// Kept for callers (the HTTP route set it): the gate now always reads the caller's rights again under the list
        /// lock, before every Jellyfin write and before the answer (404 when the list can no longer be viewed, 403 when it
        /// can no longer be edited), whatever ran first (validation, library expansion, a source fetch).
        /// </param>
        /// <returns>The outcome (<see cref="ApplyResultDto"/>).</returns>
        public async Task<ListOutcome> ApplyAsync(ListAccess access, IReadOnlyList<ApplyEntry> entries, PositionDto? position, int? expectedRev, ListRequestKey? request, CancellationToken cancellationToken, ApplyHooks? hooks = null, bool recheckAccess = false, string kind = "apply")
        {
            var skipped = new List<SkippedEntryDto>();
            var accepted = await ListContinuation.Await(() => PrevalidateAsync(access, entries, skipped, cancellationToken)).ConfigureAwait(false);
            accepted = await ListContinuation.Await(() => ExpandAsync(access, accepted, cancellationToken)).ConfigureAwait(false);
            await ListContinuation.Await(() => UseServerPostersAsync(accepted.Where(e => e.Placeholder != null).Select(e => e.Placeholder!).ToList(), cancellationToken)).ConfigureAwait(false);

            var outcome = await ListContinuation.Await(() => RunLockedAsync(access, kind, request, cancellationToken, async () =>
            {
                // Everything above ran before the lock and can take seconds. The person's limits are checked again for what
                // this write adds and what the list holds (awaited lookups), then the gate decides with their rights as
                // they are right after those lookups: which items they and the owner can still open, and what is written.
                var checkedNow = await ListContinuation.Await(() => CheckedAsync(access, accepted.Where(e => e.ItemId == null && e.Placeholder != null).Select(e => e.Placeholder!).ToList(), _store.Load(access.ListIdN), cancellationToken)).ConfigureAwait(false);
                if (checkedNow.Denied != null)
                {
                    return checkedNow.Denied;
                }

                access = checkedNow.Access!;
                var still = Revalidate(access, accepted, skipped, checkedNow.Blocked);
                return await ListContinuation.Await(() => ApplyLockedAsync(access, still, skipped, position, expectedRev, checkedNow.Visibility!, hooks, cancellationToken)).ConfigureAwait(false);
            })).ConfigureAwait(false);
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
            var fresh = await ListContinuation.Await(() => ReadCompletionMetadataAsync(
                accepted.Where((e, i) => e.Placeholder is { Kind: PlaceholderKinds.Season or PlaceholderKinds.Series } && resolutions[i].Episodes.Count > 0)
                    .Select(e => e.Placeholder!)
                    .ToList(),
                today,
                cancellationToken)).ConfigureAwait(false);

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

                if (placeholder.Kind == PlaceholderKinds.Movie || (!isPlaylist && placeholder.Kind == PlaceholderKinds.Series && resolution.Items.All(i => i.Kind == BaseItemKind.Series)))
                {
                    result.Add(resolution.Found ? entry with { ItemId = resolution.Items[0].ItemId, Placeholder = null } : entry);
                    continue;
                }

                // Collections count a season as filled only once its Season item goes in.
                var filledBy = isPlaylist || resolution.Found ? resolution.Episodes : Array.Empty<ResolvedItem>();
                foreach (var episode in filledBy)
                {
                    placeholder.Filled.AddRange(episode.Coords.Select(c => new FilledEpisode
                    {
                        ItemId = episode.ItemId.ToString("N", CultureInfo.InvariantCulture),
                        S = c.S,
                        E = c.E,
                        Via = !isPlaylist && placeholder.Kind == PlaceholderKinds.Season
                            ? resolution.Items.FirstOrDefault(item => item.Kind == BaseItemKind.Season && item.Coords.Contains(c))?.ItemId.ToString("N", CultureInfo.InvariantCulture)
                            : null,
                    }));
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
            if (_metadata == null || placeholders.Count == 0 || !MetadataAvailable)
            {
                return fresh;
            }

            using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            budget.CancelAfter(ListSwapService.InteractiveMetadataBudget);
            await ListContinuation.Await(() => Task.WhenAll(placeholders.Select(async placeholder =>
            {
                try
                {
                    var metadata = await ListContinuation.Await(() => _metadata.FetchAsync(placeholder, ListSwapService.CompletionMetadataMaxAge, today, budget.Token)).ConfigureAwait(false);
                    if (metadata != null)
                    {
                        ListMetadataService.Apply(placeholder, metadata);
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
            }))).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            return fresh;
        }

        // A TMDB placeholder shows the poster Seerr has for that title, never one the client sent: an editor could pair an
        // allowed title with a blocked title's poster, which restricted viewers would then see on the row and in the list's
        // collage. Read within a short budget; a poster not read in time is left empty (fail closed) and the background
        // metadata pass fills it in. Without Seerr but with a TMDB key the parental filter still rates titles (from TMDB),
        // so the poster is read from TMDB the same way (the background passes then fill missing ones from TMDB). With
        // neither, nothing can check it: the client's is kept but marked unverified (PosterUnverified), so viewers with
        // parental controls never get it, even once a provider is configured and the filter can rate (and so allow) the
        // title; the first metadata pass that can read the title's own poster replaces it.
        private async Task UseServerPostersAsync(IReadOnlyList<Placeholder> placeholders, CancellationToken cancellationToken)
        {
            var titles = placeholders.Where(HasTmdb).ToList();
            var seerr = MetadataAvailable;
            if (titles.Count == 0)
            {
                return;
            }

            if (!seerr && !PostersAvailable)
            {
                titles.ForEach(placeholder => placeholder.PosterUnverified = placeholder.PosterPath != null ? true : null);
                return;
            }

            titles.ForEach(placeholder => placeholder.PosterUnverified = null);
            if (_metadata == null)
            {
                titles.ForEach(placeholder => placeholder.PosterPath = null);
                return;
            }

            using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            budget.CancelAfter(ListSwapService.InteractiveMetadataBudget);
            var today = DateTime.UtcNow;
            await ListContinuation.Await(() => Task.WhenAll(titles.Select(async placeholder =>
            {
                string? poster = null;
                try
                {
                    poster = seerr
                        ? (await ListContinuation.Await(() => _metadata.FetchAsync(placeholder, ListMetadataService.CacheTtl, today, budget.Token)).ConfigureAwait(false))?.PosterPath
                        : await ListContinuation.Await(() => _metadata.FetchTmdbPosterAsync(placeholder, budget.Token)).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    // over budget: no poster for now
                }

                placeholder.PosterPath = poster;
            }))).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
        }

        private async Task<List<ApplyEntry>> PrevalidateAsync(ListAccess access, IReadOnlyList<ApplyEntry> entries, List<SkippedEntryDto> skipped, CancellationToken cancellationToken)
        {
            // C5: TMDB placeholders must pass the caller's parental filter (checked concurrently, failing closed; a
            // no-op without lookups for unrestricted callers). New custom entries are the caller's own, so they pass.
            var blocked = await ListContinuation.Await(() => _access.GetHiddenPlaceholderIdsAsync(
                entries.Where(e => e.Placeholder != null).Select(e => e.Placeholder!).ToList(),
                access.User,
                cancellationToken)).ConfigureAwait(false);

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

        // Under the list lock, right after the gate: the accepted entries (real items, and placeholders the library expanded
        // into real items) checked again against the caller and owner of this write. An item either of them can no longer
        // open is skipped as notVisible (an expanded one then never lands, so its placeholder keeps that episode unfilled);
        // a placeholder the caller's parental limit now hides (or can't verify) is skipped as blocked.
        private List<ApplyEntry> Revalidate(ListAccess access, List<ApplyEntry> accepted, List<SkippedEntryDto> skipped, IReadOnlySet<string> blocked)
        {
            var isPlaylist = access.List.Kind == ListKinds.Playlist;
            var result = new List<ApplyEntry>(accepted.Count);
            foreach (var entry in accepted)
            {
                if (entry.ItemId is Guid itemId)
                {
                    if (!_host.CanAccessItem(itemId, access.User) || (isPlaylist && (access.Owner == null || !_host.CanAccessItem(itemId, access.Owner))))
                    {
                        if (!skipped.Any(s => s.Index == entry.Index && s.Reason == "notVisible"))
                        {
                            skipped.Add(Skip(entry, "notVisible"));
                        }

                        continue;
                    }
                }
                else if (entry.Placeholder != null && blocked.Contains(entry.Placeholder.Id))
                {
                    skipped.Add(Skip(entry, "blocked"));
                    continue;
                }

                result.Add(entry);
            }

            return result;
        }

        /// <summary>
        /// The awaited part of a person's write, done before the gate decides: the parental filter on the placeholders the
        /// write adds and on what the list holds, for the person as they are now. Then the gate (<see cref="ListGate.Edit"/>)
        /// with no await after it: when the person's limits changed during the lookups, they are looked up again.
        /// </summary>
        private async Task<CheckedWrite> CheckedAsync(ListAccess access, IReadOnlyList<Placeholder> adding, ListDoc? doc, CancellationToken cancellationToken)
        {
            var items = doc?.Items ?? new List<Placeholder>();
            for (var attempt = 0; attempt < 3; attempt++)
            {
                var (denied, current) = _gate.Edit(access);
                if (denied != null)
                {
                    return new CheckedWrite(denied, null, null, new HashSet<string>());
                }

                var stamp = _access.ParentalStamp(current!.User);
                var blocked = await ListContinuation.Await(() => _access.GetHiddenPlaceholderIdsAsync(adding, current.User, cancellationToken)).ConfigureAwait(false);
                var visibility = await ListContinuation.Await(() => _gate.VisibilityAsync(items, current.User, cancellationToken)).ConfigureAwait(false);
                (denied, current) = _gate.Edit(access);
                if (denied != null)
                {
                    return new CheckedWrite(denied, null, null, new HashSet<string>());
                }

                if (visibility.Matches(_access.ParentalStamp(current!.User)) && string.Equals(stamp, _access.ParentalStamp(current.User), StringComparison.Ordinal))
                {
                    return new CheckedWrite(null, current, visibility, blocked);
                }
            }

            // The limits kept changing while they were checked: nothing is written (fail closed).
            return new CheckedWrite(ListOutcome.Error(409, "access_changed", "Who can see the list or its items changed; reload it."), null, null, new HashSet<string>());
        }

        // A person's write after its awaited checks: the refusal, or their current access, what they see and what is blocked.
        private sealed record CheckedWrite(ListOutcome? Denied, ListAccess? Access, PlaceholderVisibility? Visibility, IReadOnlySet<string> Blocked);

        private async Task<ListOutcome> ApplyLockedAsync(
            ListAccess access,
            List<ApplyEntry> accepted,
            List<SkippedEntryDto> skipped,
            PositionDto? position,
            int? expectedRev,
            PlaceholderVisibility visibility,
            ApplyHooks? hooks,
            CancellationToken cancellationToken)
        {
            var doc = _store.LoadForUpdate(access.ListIdN, access.List.Kind);
            if (expectedRev.HasValue && expectedRev.Value != doc.Rev)
            {
                return await ListContinuation.Await(() => ConflictAsync(access, "rev_conflict", "The list changed; reload it.", visibility, cancellationToken)).ConfigureAwait(false);
            }

            if (hooks?.Precondition?.Invoke(doc) is { } preconditionFailure)
            {
                return await ListContinuation.Await(() => ConflictAsync(access, preconditionFailure, "The list's linked source changed; try again.", visibility, cancellationToken)).ConfigureAwait(false);
            }

            // Leftover swap intents (a swap-in interrupted after Jellyfin added the item) are settled first, in this write:
            // what JE added then belongs to its placeholder (and its source keys) before anything here, such as a sync
            // working out what left the source, can drop that placeholder (F9). Settling moves nothing new without consent.
            var settled = false;
            if (doc.Intents.Count > 0 && _swap != null)
            {
                var recovered = await ListContinuation.Await(() => _swap.SwapLockedAsync(access.List, access.Owner, doc, Array.Empty<string>(), null, null, MetadataMode.None, CancellationToken.None)).ConfigureAwait(false);
                doc = recovered.Doc;
                settled = recovered.Dirty;
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
                        return await ListContinuation.Await(() => ConflictAsync(access, "stale_anchor", "The position no longer exists; reload the list.", visibility, cancellationToken)).ConfigureAwait(false);
                    }

                    cursor = index + 1;
                }
            }

            var result = new ApplyResultDto { Skipped = skipped };
            var keys = new HashSet<string>(doc.Items.Select(ListRules.IdentityKey), StringComparer.Ordinal);
            var room = ListStore.MaxPlaceholders - doc.Items.Count;
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
                var key = ListRules.IdentityKey(group);
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
            var regrouped = false;
            var standaloneItems = new List<Guid>(); // new real entries of their own (not a TV scope's present episodes)

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
                            if (entry.ExpandedFrom == null)
                            {
                                standaloneItems.Add(entry.ItemId.Value);
                            }
                        }
                        else
                        {
                            collectionItems.Add(entry.ItemId.Value);
                        }

                        result.AddedAsItems.Add(entry.ItemId.Value.ToString("N", CultureInfo.InvariantCulture));
                        continue;
                    }

                    var placeholder = entry.Placeholder!;
                    if (duplicateGroups.TryGetValue(placeholder, out var duplicateOf) || !keys.Add(ListRules.IdentityKey(placeholder)))
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
                    visibility.Allow(placeholder); // passed the caller's own filter in PrevalidateAsync and under the lock
                    result.Added.Add(placeholder.Id);
                    changed = true;
                    run.Add(new NewEntry(null, ListOrder.PlaceholderToken(placeholder.Id)));
                    runIndexes.Add(entry.Index);
                }

                if (isPlaylist && run.Count > 0)
                {
                    regrouped = hooks?.Regroup?.Invoke(doc, order, runIndexes.Distinct().ToList()) == true;
                    var anchors = hooks?.Place?.Invoke(doc, order);
                    // One segment per run of consecutive entries with the same spot; inserted from the last spot to the
                    // first so earlier positions (and the tokens of earlier anchors) don't move.
                    foreach (var (at, _, segment) in Segments(order, cursor, run, runIndexes, anchors).OrderByDescending(s => s.At).ThenByDescending(s => s.Order))
                    {
                        var anchor = ListOrder.RealAnchorBefore(order, at);
                        var (desired, inserted) = ListOrder.InsertEntries(order, at, segment);
                        order = desired; // what a failure below is reconciled from
                        if (inserted.Count > 0)
                        {
                            order = await ListContinuation.Await(() => PlaceRealItemsAsync(access, segment.Where(e => e.ItemId.HasValue).Select(e => e.ItemId!.Value).ToList(), anchor, desired, inserted)).ConfigureAwait(false);
                        }
                    }
                }

                if (collectionItems.Count > 0)
                {
                    var items = collectionItems.Distinct().ToList();
                    await ListContinuation.Await(() => _host.AddToCollectionAsync(_gate.Write(access, ListWriteKind.CollectionAdd, items), items)).ConfigureAwait(false);
                }
            }
            catch (Exception ex)
            {
                if (ex is ListAccessLostException lost)
                {
                    _logger.Info($"[Lists] Stopped updating list {access.ListIdN}: {lost.Message}");
                }
                else
                {
                    _logger.Error($"[Lists] Updating list {access.ListIdN} in Jellyfin failed: {ex.Message}");
                }

                var landedNow = PruneUnlandedFills(access, accepted);
                var noneLanded = !run.Any(e => e.ItemId.HasValue && landedNow.Contains(e.ItemId.Value.ToString("N", CultureInfo.InvariantCulture)));
                // The person's rights now decide whether the placeholders this attempt added are kept.
                var (denied, current) = _gate.Edit(access);
                var droppedNow = new List<Placeholder>();
                if (denied != null || (isPlaylist && hooks?.Place == null && standaloneItems.Count > 0 && noneLanded))
                {
                    // None of the new real items reached Jellyfin (one insert, so all or nothing): keep none of the
                    // placeholders this attempt added either. Saved alone, a retry (same request) would skip them as
                    // duplicates and put the real entries after them, scrambling the order; now it applies the whole run
                    // in order at its position. A run whose only real items are a TV scope's present episodes keeps its
                    // placeholders: swap-in inserts those episodes next to their placeholder later. (The sync places by
                    // source neighbours on every run: unchanged.) Nor are any kept once the person can't change the list.
                    droppedNow = DropAdded(doc, order, result);
                }

                changed = DropLandedCompleteScopes(doc, accepted, result, order);
                if (isPlaylist)
                {
                    order = Canonical(access, new ListDoc { Order = order, Items = doc.Items });
                }

                if (denied == null && hooks?.AfterFailedApply != null && RecordPartialApply(access, hooks.AfterFailedApply, doc, result, skipped, accepted))
                {
                    changed = true;
                }

                var saved = SaveIfChanged(doc, isPlaylist ? order : null, originalOrder, changed || settled || regrouped);
                if (denied != null)
                {
                    // The person lost the list during Jellyfin's writes: what Jellyfin already took is the write's result
                    // (answered without the list); with nothing taken, the refusal.
                    result.AddedAsItems.RemoveAll(id => !landedNow.Contains(id));
                    if (result.AddedAsItems.Count == 0)
                    {
                        return denied;
                    }

                    skipped.AddRange(droppedNow.Select(p => new SkippedEntryDto { Index = accepted.First(e => ReferenceEquals(e.Placeholder, p)).Index, Reason = "accessLost" }));
                    result.Skipped = skipped.OrderBy(x => x.Index).ToList();
                    return ListOutcome.Ok(result);
                }

                var failure = ex is ListAccessLostException { Outcome: { } refused } ? (ListErrorDto)refused.Value! : new ListErrorDto { Code = "list_update_failed", Message = "Jellyfin could not update the list." };
                failure.View = await ListContinuation.Await(() => _gate.ProjectAsync(current!, saved?.Items ?? new List<Placeholder>(), visibility, grant => BuildView(grant, saved, isPlaylist ? order : null), cancellationToken)).ConfigureAwait(false);
                return new ListOutcome { StatusCode = ex is ListAccessLostException { Outcome: { } status } ? status.StatusCode : 500, Value = failure };
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
                    hookChanged = await ListContinuation.Await(() => hooks.AfterApplyAsync(doc, result, accepted)).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    // Jellyfin was already updated: save what landed (and its provenance) before giving up, else the next
                    // apply finds those entries again as hand-added ones.
                    _logger.Warning($"[Lists] Finishing the update of list {access.ListIdN} failed: {ex.Message}");
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
                        if (_gate.Edit(access).Denied != null)
                        {
                            DropAdded(doc, order, result);
                        }

                        SaveIfChanged(doc, isPlaylist ? order : null, originalOrder, true);
                    }
                    catch (Exception saveEx)
                    {
                        _logger.Error($"[Lists] Saving list {access.ListIdN} after a failed update failed: {saveEx.Message}");
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

            // Jellyfin's writes are done (and awaited): the person's rights and limits as they are now decide what of the
            // write's own additions is kept. What landed in Jellyfin is recorded either way.
            var added = result.Added.Select(id => doc.Items.FirstOrDefault(p => p.Id == id)).OfType<Placeholder>().ToList();
            var after = await ListContinuation.Await(() => CheckedAsync(access, added, doc, cancellationToken)).ConfigureAwait(false);
            if (after.Denied != null)
            {
                // The person lost the list (or their limits kept changing): their placeholders aren't added, what Jellyfin
                // took is recorded, and the answer carries the write's results without the list.
                var dropped = DropAdded(doc, order, result);
                result.Skipped.AddRange(dropped.Select(p => new SkippedEntryDto { Index = accepted.First(e => ReferenceEquals(e.Placeholder, p)).Index, Reason = "accessLost" }));
                result.Skipped = result.Skipped.OrderBy(x => x.Index).ToList();
                SaveIfChanged(doc, isPlaylist ? order : null, originalOrder, changed || settled || regrouped || dropped.Count > 0);
                return ListOutcome.Ok(result);
            }

            access = after.Access!;
            foreach (var blocked in added.Where(p => after.Blocked.Contains(p.Id)))
            {
                // A limit added while Jellyfin was updated hides this new placeholder from its author: not added (fail closed).
                doc.Items.Remove(blocked);
                order.Remove(ListOrder.PlaceholderToken(blocked.Id));
                result.Added.Remove(blocked.Id);
                result.Skipped.Add(new SkippedEntryDto { Index = accepted.First(e => ReferenceEquals(e.Placeholder, blocked)).Index, Reason = "blocked" });
                changed = true;
            }

            result.Skipped = result.Skipped.OrderBy(x => x.Index).ToList();
            var final = SaveIfChanged(doc, isPlaylist ? order : null, originalOrder, changed || settled || regrouped);
            result.View = await ListContinuation.Await(() => _gate.ProjectAsync(access, final?.Items ?? new List<Placeholder>(), after.Visibility, grant => BuildView(grant, final, isPlaylist ? order : null), cancellationToken)).ConfigureAwait(false);
            return ListOutcome.Ok(result);
        }

        // Takes the placeholders an attempt added out of the document and its order again (not kept); returns them.
        private static List<Placeholder> DropAdded(ListDoc doc, List<string> order, ApplyResultDto result)
        {
            var dropped = new List<Placeholder>();
            foreach (var id in result.Added)
            {
                dropped.AddRange(doc.Items.Where(p => p.Id == id));
                doc.Items.RemoveAll(p => p.Id == id);
                order.Remove(ListOrder.PlaceholderToken(id));
            }

            result.Added.Clear();
            return dropped;
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
                    order.Remove(ListOrder.PlaceholderToken(placeholder.Id));
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

        // Puts a contiguous run of new real items into Jellyfin right after `anchor` (see ListPlaylistPlacement); the gate
        // allows the insert and every move that places it, each right before it, as the playlist's current owner.
        private Task<List<string>> PlaceRealItemsAsync(ListAccess access, IReadOnlyList<Guid> items, string? anchor, List<string> desired, IReadOnlyList<string> inserted) =>
            ListPlaylistPlacement.PlaceAsync(_host, _logger, access.List.Id, access.ListIdN, access.Owner!, items, anchor, desired, inserted, (kind, written) => _gate.Write(access, kind, written));

        // ── Placeholder edits ────────────────────────────────────────────────

        /// <summary>
        /// PATCH /{listId}/items/{phId}: note, and linking a custom entry to a TMDB title. The caller's rights are
        /// resolved again under the list lock (the parental check, poster and Seerr reads before it can take seconds) and
        /// the write, including a swap-in as the playlist owner, uses them.
        /// </summary>
        /// <param name="access">Authorised access (CanEdit).</param>
        /// <param name="placeholderId">Placeholder id.</param>
        /// <param name="rev">Expected revision.</param>
        /// <param name="note">New note (null = unchanged, "" = clear).</param>
        /// <param name="link">Normalised title data to link to (custom entries only).</param>
        /// <param name="request">Client request id and request digest (null: not idempotent).</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The outcome (<see cref="ListViewDto"/>).</returns>
        public async Task<ListOutcome> PatchAsync(ListAccess access, string placeholderId, int rev, string? note, Placeholder? link, ListRequestKey? request, CancellationToken cancellationToken)
        {
            if (link != null && HasTmdb(link) && await ListContinuation.Await(() => _access.IsTitleBlockedAsync(link.MediaType, link.TmdbId!.Value, access.User, cancellationToken)).ConfigureAwait(false))
            {
                return ListOutcome.Error(403, "parental_block", "This title isn't available for your account.");
            }

            if (link != null)
            {
                await ListContinuation.Await(() => UseServerPostersAsync(new[] { link }, cancellationToken)).ConfigureAwait(false);
            }

            // A linked title gets its Seerr metadata now (release date, ids, expected episodes) so it can be swapped in
            // right away when it is already in the library.
            var linkFresh = link != null && HasTmdb(link)
                && (await ListContinuation.Await(() => ReadCompletionMetadataAsync(new[] { link }, DateTime.UtcNow, cancellationToken)).ConfigureAwait(false)).Count > 0;
            // The parental lookups run before the lock (they can take seconds); under it they are read again from the
            // warmed cache with the person as they are then.
            await ListContinuation.Await(() => _gate.VisibilityAsync(_store.Load(access.ListIdN)?.Items ?? new List<Placeholder>(), access.User, cancellationToken)).ConfigureAwait(false);
            var outcome = await ListContinuation.Await(() => RunLockedAsync(access, "patch", request, cancellationToken, async () =>
            {
                // The awaited checks first (what the caller sees of the list; the linked title against their limits), then
                // the gate, with no await before the change it allows.
                var doc = _store.LoadForUpdate(access.ListIdN, access.List.Kind);
                var checkedNow = await ListContinuation.Await(() => CheckedAsync(access, link != null && HasTmdb(link) ? new[] { link } : Array.Empty<Placeholder>(), doc, cancellationToken)).ConfigureAwait(false);
                if (checkedNow.Denied != null)
                {
                    return checkedNow.Denied;
                }

                access = checkedNow.Access!;
                var visibility = checkedNow.Visibility!;
                if (link != null && checkedNow.Blocked.Contains(link.Id))
                {
                    return ListOutcome.Error(403, "parental_block", "This title isn't available for your account.");
                }

                if (doc.Rev != rev)
                {
                    return await ListContinuation.Await(() => ConflictAsync(access, "rev_conflict", "The list changed; reload it.", visibility, cancellationToken)).ConfigureAwait(false);
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

                    var key = ListRules.IdentityKey(link);
                    if (doc.Items.Any(p => p.Id != placeholderId && ListRules.IdentityKey(p) == key))
                    {
                        return await ListContinuation.Await(() => ConflictAsync(access, "duplicate", "This title is already in the list.", visibility, cancellationToken)).ConfigureAwait(false);
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
                    placeholder.PosterUnverified = link.PosterUnverified;
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

                var swappedIn = false;
                if (link != null && _swap != null)
                {
                    // Whatever of the linked scope is already in the library goes in at the entry's spot now (C1). This
                    // is the swap-in of §9, so it runs as the playlist owner (collections: unscoped) on the list's consent,
                    // exactly like the background pass queued below would a moment later, and only while the caller can
                    // still edit the list (the gate checks both before every insert). The caller's own library access is
                    // not what decides (C5's caller checks cover items the client sends, not swap-in).
                    var fresh = linkFresh ? new HashSet<string>(StringComparer.Ordinal) { placeholderId } : null;
                    var swapped = await ListContinuation.Await(() => _swap.SwapLockedAsync(access.List, access.Owner, doc, new[] { placeholderId }, null, fresh, linkFresh ? MetadataMode.Completion : MetadataMode.None, cancellationToken, onBehalfOf: access)).ConfigureAwait(false);
                    doc = swapped.Doc;
                    swappedIn = swapped.Result.Inserted > 0;
                }

                // The swap-in waited for Jellyfin: the person's rights are read again before the change is saved. What
                // Jellyfin took is recorded either way (the swap saved it); the link and note are not, without the right.
                var (denied, current) = _gate.Edit(access);
                if (denied != null)
                {
                    if (swappedIn)
                    {
                        _store.Save(doc);
                    }

                    return denied;
                }

                access = current!;
                var canonical = access.List.Kind == ListKinds.Playlist ? Canonical(access, doc) : null;
                if (canonical != null)
                {
                    doc.Order = canonical;
                }

                var saved = _store.Save(doc);
                return await ListContinuation.Await(() => ViewOutcomeAsync(access, saved, canonical, visibility, cancellationToken)).ConfigureAwait(false);
            })).ConfigureAwait(false);
            if (link != null && outcome.StatusCode < 300)
            {
                _swap?.QueuePass(access.ListIdN, new[] { placeholderId }, MetadataMode.New);
            }

            return outcome;
        }

        /// <summary>DELETE /{listId}/items/{phId}. The caller's rights are resolved again under the list lock.</summary>
        /// <param name="access">Authorised access (CanEdit).</param>
        /// <param name="placeholderId">Placeholder id.</param>
        /// <param name="rev">Expected revision.</param>
        /// <param name="request">Client request id and request digest (null: not idempotent).</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The outcome (<see cref="ListViewDto"/>).</returns>
        public async Task<ListOutcome> DeleteAsync(ListAccess access, string placeholderId, int rev, ListRequestKey? request, CancellationToken cancellationToken)
        {
            // The parental lookups run before the lock (they can take seconds); under it they are read again from the
            // warmed cache with the person as they are then.
            await ListContinuation.Await(() => _gate.VisibilityAsync(_store.Load(access.ListIdN)?.Items ?? new List<Placeholder>(), access.User, cancellationToken)).ConfigureAwait(false);
            return await ListContinuation.Await(() => RunLockedAsync(access, "delete", request, cancellationToken, async () =>
            {
                // The awaited parental lookups first, then the gate (the lookups and the lock wait can take seconds; the
                // share may be gone), with no await before the change it allows.
                var doc = _store.LoadForUpdate(access.ListIdN, access.List.Kind);
                var checkedNow = await ListContinuation.Await(() => CheckedAsync(access, Array.Empty<Placeholder>(), doc, cancellationToken)).ConfigureAwait(false);
                if (checkedNow.Denied != null)
                {
                    return checkedNow.Denied;
                }

                access = checkedNow.Access!;
                var visibility = checkedNow.Visibility!;
                if (doc.Rev != rev)
                {
                    return await ListContinuation.Await(() => ConflictAsync(access, "rev_conflict", "The list changed; reload it.", visibility, cancellationToken)).ConfigureAwait(false);
                }

                var placeholder = doc.Items.FirstOrDefault(p => p.Id == placeholderId);
                if (placeholder == null || !visibility.IsVisible(placeholder))
                {
                    return ListOutcome.Error(404, "not_found", "Placeholder not found.");
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
                return await ListContinuation.Await(() => ViewOutcomeAsync(access, saved, canonical, visibility, cancellationToken)).ConfigureAwait(false);
            })).ConfigureAwait(false);
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
        /// <param name="request">Client request id and request digest (null: not idempotent).</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The outcome (<see cref="ListViewDto"/>, or 409 with the fresh view).</returns>
        public async Task<ListOutcome> ReorderAsync(ListAccess access, int rev, IReadOnlyList<string> requested, string? moved, ListRequestKey? request, CancellationToken cancellationToken)
        {
            // The parental lookups run before the lock (they can take seconds); under it they are read again from the
            // warmed cache with the person as they are then.
            await ListContinuation.Await(() => _gate.VisibilityAsync(_store.Load(access.ListIdN)?.Items ?? new List<Placeholder>(), access.User, cancellationToken)).ConfigureAwait(false);
            return await ListContinuation.Await(() => RunLockedAsync(access, "order", request, cancellationToken, async () =>
            {
                // The awaited parental lookups first, then the gate: a real row is moved as the owner when the caller can't
                // edit natively, so a caller whose share was removed must not reach that move.
                var doc = _store.LoadForUpdate(access.ListIdN, access.List.Kind);
                var checkedNow = await ListContinuation.Await(() => CheckedAsync(access, Array.Empty<Placeholder>(), doc, cancellationToken)).ConfigureAwait(false);
                if (checkedNow.Denied != null)
                {
                    return checkedNow.Denied;
                }

                access = checkedNow.Access!;
                var visibility = checkedNow.Visibility!;
                if (doc.Rev != rev)
                {
                    return await ListContinuation.Await(() => ConflictAsync(access, "rev_conflict", "The list changed; reload it.", visibility, cancellationToken)).ConfigureAwait(false);
                }

                var callerVisible = new Dictionary<Guid, bool>();
                var placeholderVisible = visibility.For(doc.Items);
                bool VisibleToCaller(string token) => IsVisibleToken(token, access.User, placeholderVisible, callerVisible);

                var canonical = Canonical(access, doc);
                var projection = ListOrder.Project(canonical, VisibleToCaller);
                var merge = ListOrder.MergeProjection(canonical, projection, requested, moved);
                if (!merge.Ok)
                {
                    var message = merge.Error == "duplicate_copy"
                        ? "Only the first copy of an item that is in the playlist more than once can be moved."
                        : "The list changed; reload it.";
                    return await ListContinuation.Await(() => ConflictAsync(access, merge.Error!, message, visibility, cancellationToken)).ConfigureAwait(false);
                }

                var final = merge.Desired.ToList();
                var success = true;
                var movedNow = false;
                if (merge.RealMoved)
                {
                    var mover = access.Permissions.NativeCanEdit ? access.User : access.Owner;
                    if (mover == null)
                    {
                        return await ListContinuation.Await(() => ConflictAsync(access, "owner_missing", "The playlist owner no longer exists.", visibility, cancellationToken)).ConfigureAwait(false);
                    }

                    var moverVisible = new Dictionary<Guid, bool>();
                    var desiredReal = merge.Desired.Where(ListOrder.IsReal).ToList();
                    ListOrder.TryParseReal(moved, out var itemId, out _);
                    // A5/F2: the move(s) that give the full desired order, hidden rows included; none → change nothing.
                    var moves = ListOrder.FindMoves(
                        _host.GetRawEntries(access.List.Id),
                        itemId,
                        desiredReal,
                        id => EntryVisible(ListOrder.RealToken(id, 0), mover, moverVisible));
                    if (moves == null)
                    {
                        return await ListContinuation.Await(() => ConflictAsync(access, "move_unsupported", "Jellyfin can't move the entry there without also moving entries that are hidden or missing.", visibility, cancellationToken)).ConfigureAwait(false);
                    }

                    try
                    {
                        foreach (var newIndex in moves)
                        {
                            // The gate before every move: the person may still edit and the row is one they and the mover see.
                            await ListContinuation.Await(() => _host.MoveInPlaylistAsync(_gate.Write(access, ListWriteKind.Move, new[] { itemId }), itemId, newIndex)).ConfigureAwait(false);
                            movedNow = true;
                        }
                    }
                    catch (ListAccessLostException lost)
                    {
                        _logger.Info($"[Lists] Stopped moving an entry of list {access.ListIdN}: {lost.Message}");
                        if (!movedNow)
                        {
                            return lost.Outcome!;
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger.Error($"[Lists] Moving an entry of list {access.ListIdN} failed: {ex.Message}");
                        return await ListContinuation.Await(() => ConflictAsync(access, "move_failed", "Jellyfin could not move the entry.", visibility, cancellationToken)).ConfigureAwait(false);
                    }

                    var actual = ListOrder.BuildRealTokens(_host.GetRawEntries(access.List.Id));
                    var relabelled = ListOrder.Relabel(merge.Desired);
                    final = ListOrder.Reconcile(relabelled, actual, doc.Items.Select(p => p.Id).ToList());
                    // Every real row, including rows hidden from the caller, must be where the desired order puts it.
                    success = actual.SequenceEqual(relabelled.Where(ListOrder.IsReal), StringComparer.Ordinal);
                }

                // Jellyfin's moves were awaited: the person's rights are read again before the order is saved. What Jellyfin
                // did is recorded either way (a reorder without the right then keeps Jellyfin's order, nothing of the caller's).
                var (denied, current) = _gate.Edit(access);
                if (denied != null)
                {
                    if (movedNow)
                    {
                        doc.Order = Canonical(access, doc);
                        _store.Save(doc);
                    }

                    return denied;
                }

                access = current!;
                ListDoc? saved = _store.Load(access.ListIdN);
                if ((saved != null || doc.Items.Count > 0) && !final.SequenceEqual(doc.Order, StringComparer.Ordinal))
                {
                    doc.Order = final;
                    saved = _store.Save(doc);
                }

                var view = await ListContinuation.Await(() => _gate.ProjectAsync(access, saved?.Items ?? new List<Placeholder>(), visibility, grant => BuildView(grant, saved, final), cancellationToken)).ConfigureAwait(false);
                if (view == null)
                {
                    return ListOutcome.Error(404, "not_found", "List not found.");
                }

                return success
                    ? ListOutcome.Ok(view)
                    : ListOutcome.Error(409, "move_mismatch", "Jellyfin placed the entry differently; the list was refreshed.", view);
            })).ConfigureAwait(false);
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
            foreach (var list in InJellyfinOrder(_host.GetAllPlaylists()))
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
                    OwnerName = access.Permissions.NativeCanEdit ? null : access.Owner?.Username,
                });
            }

            if (result.CanManageCollections)
            {
                foreach (var list in InJellyfinOrder(_host.GetVisibleCollections(user)))
                {
                    result.Collections.Add(new EditableListDto
                    {
                        Id = list.Id.ToString("N", CultureInfo.InvariantCulture),
                        Name = list.Name,
                        NativeCanEdit = true,
                    });
                }
            }

            // Own playlists first; OrderBy is stable, so each group keeps Jellyfin's order.
            result.Playlists = result.Playlists.OrderBy(p => p.IsOwn ? 0 : 1).ToList();
            return result;
        }

        /// <summary>
        /// Lists in the order Jellyfin's library views show them: by sort name (its forced sort name, or the name with
        /// leading articles like "The" removed), then by name. Jellyfin sorts in SQLite with no collation (BINARY), so
        /// both keys compare ordinally and case-sensitively: "_x" and "[x]" come before letters, "Zorro" before "apple",
        /// and an empty sort name first. Only an unknown (null) sort name falls back to the lower-cased name.
        /// </summary>
        /// <param name="lists">Lists.</param>
        /// <returns>The lists, sorted.</returns>
        private static IEnumerable<ListInfo> InJellyfinOrder(IEnumerable<ListInfo> lists) =>
            lists.OrderBy(l => l.SortName ?? l.Name.ToLowerInvariant(), StringComparer.Ordinal)
                .ThenBy(l => l.Name, StringComparer.Ordinal);

        /// <summary>
        /// POST /playlists and POST /collections: creates a list owned by/visible to the caller, then applies entries.
        /// <list type="bullet">
        /// <item>The create runs under a name carrying its operation's marker (<see cref="CreateName"/>), so Jellyfin keeps the
        /// marker in the list's own folder (and a collection's provider id) from the create write on, and gives the list a
        /// folder no other list has: a collection create never lands on (and replaces) another collection. The list then
        /// gets its chosen name (<see cref="IListHost.FinishCreateAsync"/>); a retry after a crash in between finishes it.
        /// A list never carries a share for nobody (Jellyfin would hand a deleted owner's playlist to it).</item>
        /// <item>A retry continues with exactly the list carrying its marker; a list of the same name, anyone's, is never
        /// taken for it.</item>
        /// <item>Collections: one create of a destination at a time, whoever asks (Jellyfin keeps one folder per name):
        /// the name check (by the full destination in Jellyfin's collections folder), the create, its record and its name
        /// happen together. A name a collection already has there is refused (409 name_taken); so is a list another
        /// operation already recorded (409 create_uncertain), before any entry is applied.</item>
        /// </list>
        /// </summary>
        /// <param name="user">Caller (already authorised for collections).</param>
        /// <param name="kind">List kind.</param>
        /// <param name="name">Validated name.</param>
        /// <param name="isPublic">Playlists: open access.</param>
        /// <param name="entries">Validated entries.</param>
        /// <param name="request">Client request id and request digest (null: not idempotent).</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <param name="hooks">Optional same-write follow-up of the initial apply (linked-source provenance).</param>
        /// <returns>The outcome (<see cref="CreateListResultDto"/>).</returns>
        public async Task<ListOutcome> CreateListAsync(User user, string kind, string name, bool isPublic, IReadOnlyList<ApplyEntry> entries, ListRequestKey? request, CancellationToken cancellationToken, Func<ListAccess, ApplyHooks?>? hooks = null)
        {
            // One continuation for the whole create, recovery and retry included: after every await, and before every
            // write and the answer, its operation and the person's access are read again (CreateState.Refusal).
            var state = new CreateState(this, user.Id, kind);
            using var continuation = new ListContinuation(_store, state.Refusal);
            IDisposable? turn = null;
            try
            {
                ListOutcome outcome;
                try
                {
                    continuation.Check();
                    if (request != null && _operations?.Available == true)
                    {
                        // Recorded before the person's turn is waited for, so deletion can already stop this create.
                        state.Began(ListContinuation.Write(() => _operations.Begin(user.Id, "create-" + kind, request.RequestId, "create", request.Fingerprint, Now())));
                    }

                    turn = await ListContinuation.AwaitLock(_createLocks.GetOrAdd(user.Id, _ => new SemaphoreSlim(1, 1)), cancellationToken).ConfigureAwait(false);
                    outcome = state.Start?.Conflict == true
                        ? IdempotencyConflict()
                        : await ListContinuation.Await(() => ContinueCreateAsync(state, user, kind, name, isPublic, entries, cancellationToken, hooks)).ConfigureAwait(false);
                }
                catch (ListAccessLostException lost) when (lost.Outcome != null)
                {
                    // The gate refused the create or its name (the person was disabled or lost collection management meanwhile).
                    outcome = lost.Outcome;
                }

                return state.Project(continuation, outcome);
            }
            finally
            {
                turn?.Dispose();
            }
        }

        /// <summary>
        /// What a create knows about its operation and list, read again by every check of its continuation, and the one
        /// place its answer is made (<see cref="Project"/>).
        /// </summary>
        private sealed class CreateState
        {
            private readonly ListService _service;
            private readonly Guid _user;
            private readonly string _kind;

            internal CreateState(ListService service, Guid user, string kind)
            {
                _service = service;
                _user = user;
                _kind = kind;
            }

            /// <summary>Gets the durable operation's start (null: not idempotent).</summary>
            internal ListOperationStart? Start { get; private set; }

            /// <summary>Gets the durable operation as last read.</summary>
            internal ListOperation? Operation { get; private set; }

            /// <summary>Gets the marker the create's list carries (the operation's, or one of its own).</summary>
            internal Guid Marker { get; private set; } = Guid.NewGuid();

            /// <summary>Gets or sets the list the create made or continues with.</summary>
            internal Guid? ListId { get; set; }

            /// <summary>Gets or sets a value indicating whether a list with the marker may exist without its id known here.</summary>
            internal bool Creating { get; set; }

            internal void Began(ListOperationStart start)
            {
                Start = start;
                Operation = start.Operation;
                if (Operation != null)
                {
                    Marker = CreateMarker(Operation.Id);
                    Creating = start.Replayed;
                }
            }

            /// <summary>
            /// The check of every step: the person may still create this kind; the operation is still there and not deleted
            /// (by its list id or its marker); the list, once known, is one they can see and edit (a playlist: still theirs).
            /// Runs under the lifecycle lock.
            /// </summary>
            /// <returns>The refusal, or null.</returns>
            internal ListOutcome? Refusal()
            {
                var person = _service._gate.Person(_user, _kind);
                if (person == null)
                {
                    return _service._gate.CreateRefusal(_user);
                }

                var operations = _service._operations;
                if (Operation != null)
                {
                    Operation = operations!.Find(Operation.Id);
                    if (Operation == null || Operation.State == "deleted")
                    {
                        return ListContinuation.NotFound();
                    }

                    if (Guid.TryParseExact(Operation.ListId, "N", out var recorded))
                    {
                        ListId = recorded;
                    }
                }

                if (operations?.Available == true && operations.MarkerDeleted(Marker))
                {
                    return ListContinuation.NotFound();
                }

                if (ListId == null && Creating)
                {
                    // Jellyfin made the list but its id isn't recorded yet: the marker finds it (anyone's: the owner is checked below).
                    ListId = _service._host.FindCreated(_kind, Marker, Guid.Empty)?.Id;
                }

                if (ListId is not Guid id)
                {
                    return null;
                }

                var access = _service._access.Resolve(id, person);
                return access is not { Permissions.CanView: true, Permissions.CanEdit: true } || access.List.Kind != _kind
                    || (_kind == ListKinds.Playlist && access.List.OwnerId != _user)
                    ? ListContinuation.NotFound()
                    : null;
            }

            /// <summary>
            /// The one answer of a create (success, error, replay or recovery), made synchronously under the lifecycle lock
            /// after one more check: the operation is finished and the list identified only while the operation and the
            /// person's current access allow it. Otherwise the identity-free refusal, the same as if they never had it.
            /// </summary>
            /// <param name="continuation">The create's continuation.</param>
            /// <param name="outcome">What the create came to.</param>
            /// <returns>The answer.</returns>
            internal ListOutcome Project(ListContinuation continuation, ListOutcome outcome)
            {
                lock (ListContinuation.Lifecycle)
                {
                    try
                    {
                        continuation.Check();
                    }
                    catch (ListAccessLostException lost)
                    {
                        return lost.Outcome ?? ListContinuation.NotFound();
                    }

                    var list = ListId is Guid id ? _service._host.GetList(id) : null;
                    var result = outcome.StatusCode < 300 && list != null ? outcome.Value as ApplyResultDto : null;
                    if (outcome.StatusCode < 300 && result == null)
                    {
                        return ListContinuation.NotFound();
                    }

                    var storedName = result != null ? _service._host.GetStoredName(list!.Id) : null;
                    if (result != null && storedName == null)
                    {
                        return ListContinuation.NotFound();
                    }

                    if (Operation is { State: "open" or "failed" } && Start?.Conflict != true)
                    {
                        // A failed create stays retryable: a retry with the same request id continues with the same list.
                        _service._operations!.Finish(Operation.Id, result != null, result != null ? 200 : outcome.StatusCode, result != null ? ResultIdentity(result) : null, _service.Now());
                    }

                    if (result != null)
                    {
                        return ListOutcome.Ok(new CreateListResultDto { ListId = list!.Id.ToString("N", CultureInfo.InvariantCulture), ListKind = list.Kind, Name = storedName!, Result = result });
                    }

                    if (outcome.Value is ListErrorDto error)
                    {
                        // The list to reload, except with an access-denied 404 (even if access came back since).
                        var identified = outcome.StatusCode != 404 && list != null;
                        error.ListId = identified ? list!.Id.ToString("N", CultureInfo.InvariantCulture) : null;
                        error.ListKind = identified ? list!.Kind : null;
                    }

                    return outcome;
                }
            }
        }

        // The create itself, inside its continuation: it answers what happened (the list's identity is added only by
        // CreateState.Project) and records nothing final itself.
        private async Task<ListOutcome> ContinueCreateAsync(CreateState state, User user, string kind, string name, bool isPublic, IReadOnlyList<ApplyEntry> entries, CancellationToken cancellationToken, Func<ListAccess, ApplyHooks?>? hooks)
        {
            // Held only once its wait succeeded: a create cancelled (or failing) while it waits releases nothing it never had.
            IDisposable? destinationTurn = null;
            try
            {
                string? destination = null;
                if (kind == ListKinds.Collection)
                {
                    if (_gate.Person(user.Id, kind) == null)
                    {
                        return _gate.CreateRefusal(user.Id);
                    }

                    destination = await ListContinuation.Await(() => _host.CollectionDestinationAsync(name)).ConfigureAwait(false);
                    if (destination == null)
                    {
                        return ListOutcome.Error(500, "list_update_failed", "Jellyfin could not create the collection.");
                    }

                    destinationTurn = await ListContinuation.AwaitLock(_destinationLocks.GetOrAdd(destination, _ => new SemaphoreSlim(1, 1)), cancellationToken).ConfigureAwait(false);
                }

                // A create can wait for an earlier one: the person is read again now (not disabled; collections need
                // collection management).
                var fresh = _gate.Person(user.Id, kind);
                if (fresh == null)
                {
                    return _gate.CreateRefusal(user.Id);
                }

                user = fresh;
                ListInfo? list = null;
                // As read by the last check (after the turns were waited for), not as begun.
                var operation = state.Operation;
                if (operation?.ListId != null && Guid.TryParseExact(operation.ListId, "N", out var createdId))
                {
                    // A retry goes to the list the first attempt created (B10), and a completed one is answered from it.
                    list = _host.GetList(createdId);
                    if (list != null && (list.Kind != kind || (kind == ListKinds.Playlist && list.OwnerId != user.Id)))
                    {
                        list = null;
                    }

                    if (list == null)
                    {
                        // The list this operation made is gone or isn't the person's any more: nothing is made in its
                        // place (the operation can't record another list).
                        return ListContinuation.NotFound();
                    }

                    if (operation.State == "completed")
                    {
                        return await ListContinuation.Await(() => ReplayCreatedAsync(user, list, operation, cancellationToken)).ConfigureAwait(false);
                    }
                }
                else if (operation != null && state.Start!.Replayed)
                {
                    // The first attempt may have died after Jellyfin created the list but before it was recorded. Only
                    // the list carrying this operation's marker is its own; without it nothing was made (a namesake,
                    // anyone's, is never taken for it). A deleted one was tombstoned by its marker: the checks stop it.
                    var made = _host.FindCreated(kind, state.Marker, user.Id);
                    if (made != null)
                    {
                        if (!_operations!.ClaimList(operation.Id, made.Id.ToString("N", CultureInfo.InvariantCulture), Now()))
                        {
                            return ListOutcome.Error(409, "create_uncertain", "An earlier attempt may already have created this list. Check your lists, or create it again as a new request.");
                        }

                        _logger.Info($"[Lists] Continuing with {kind} \"{name}\" ({made.Id:N}), created by an earlier attempt that wasn't recorded.");
                        state.ListId = made.Id;
                        list = made;
                    }
                }

                var markedName = CreateName(name, state.Marker);
                Guid id;
                if (list != null)
                {
                    id = list.Id;
                }
                else
                {
                    if (destination != null && _host.CollectionNameTaken(destination))
                    {
                        // A collection already has the name: Jellyfin would keep both under one name in its folder.
                        return ListOutcome.Error(409, "name_taken", "A collection with this name already exists. Choose another name.");
                    }

                    // Under the name carrying the marker: a folder no other list has, so nothing is replaced, and the marker
                    // is Jellyfin's own record of which operation made the list (the checks find it by the marker until
                    // its id is recorded).
                    state.Creating = true;
                    id = kind == ListKinds.Playlist
                        ? await ListContinuation.Await(() => _host.CreatePlaylistAsync(_gate.CreateWrite(user, kind), markedName, isPublic)).ConfigureAwait(false)
                        : await ListContinuation.Await(() => _host.CreateCollectionAsync(_gate.CreateWrite(user, kind), markedName, state.Marker)).ConfigureAwait(false);
                    state.ListId = id;
                    _logger.Info($"[Lists] {user.Username} created {kind} \"{name}\" ({id:N}).");
                    if (operation != null && !_operations!.ClaimList(operation.Id, id.ToString("N", CultureInfo.InvariantCulture), Now()))
                    {
                        // Another operation recorded this list first: it isn't this create's to fill.
                        _logger.Warning($"[Lists] The {kind} {id:N} just created is recorded by another operation; nothing is applied to it.");
                        return ListOutcome.Error(409, "create_uncertain", "An earlier attempt may already have created this list. Check your lists, or create it again as a new request.");
                    }

                    list = _host.GetList(id) ?? new ListInfo(id, kind, markedName, kind == ListKinds.Playlist ? user.Id : Guid.Empty, isPublic, Array.Empty<ListShare>());
                }

                state.ListId = id;
                var storedName = _host.GetStoredName(id);
                if (storedName == null)
                {
                    return ListContinuation.NotFound();
                }

                if (string.Equals(storedName, markedName, StringComparison.Ordinal)
                    || (_unsavedNames.ContainsKey(id) && string.Equals(storedName, name, StringComparison.Ordinal)))
                {
                    // The list still carries the name with its marker (just created, or a retry after a crash right after
                    // the create), or its rename wasn't saved: it gets its chosen name. The name counts once Jellyfin saved
                    // it, not when its cached item shows it. Every create, retry and marker recovery reads the repository
                    // here: failure handling leaves the shared cache alone, and native renames need not refresh that cache.
                    _unsavedNames[id] = 0;
                    await ListContinuation.Await(() => _host.FinishCreateAsync(_gate.FinishWrite(list, user), name)).ConfigureAwait(false);
                    _unsavedNames.TryRemove(id, out _);
                    list = _host.GetList(id) ?? list;
                }
                else
                {
                    // Renamed meanwhile (by the person, in Jellyfin): their name stands.
                    _unsavedNames.TryRemove(id, out _);
                }

                // Named: the next create of this destination may check it.
                ReleaseDestination(ref destinationTurn);

                // A recovered list (or one Jellyfin changed meanwhile) still needs the person's current right to edit it.
                var access = _access.Evaluate(list, user);
                if (!access.Permissions.CanEdit)
                {
                    return ListContinuation.NotFound();
                }

                var applied = await ListContinuation.Await(() => ApplyAsync(access, entries, null, null, null, cancellationToken, hooks?.Invoke(access))).ConfigureAwait(false);
                if (applied.StatusCode >= 300 || applied.Value is not ApplyResultDto result)
                {
                    // The list exists but its entries didn't (all) apply: the failure, with the list to reload (added by the
                    // projection); the operation stays retryable, so a retry re-applies to this same list.
                    return new ListOutcome
                    {
                        StatusCode = applied.StatusCode >= 300 ? applied.StatusCode : 500,
                        Value = applied.Value as ListErrorDto ?? new ListErrorDto { Code = "list_update_failed", Message = "Jellyfin could not update the list." },
                    };
                }

                return ListOutcome.Ok(result);
            }
            finally
            {
                ReleaseDestination(ref destinationTurn);
            }
        }

        /// <summary>Releases a destination lock the create holds, once (it no longer holds it, even when the release throws).</summary>
        /// <param name="held">The lock held, or null; null afterwards.</param>
        private static void ReleaseDestination(ref IDisposable? held)
        {
            var release = held;
            held = null;
            release?.Dispose();
        }

        /// <summary>
        /// The marker a create operation leaves in Jellyfin with the list it makes: derived from the operation id (which
        /// never leaves the server), so it names that operation and no person has it.
        /// </summary>
        /// <param name="operationId">The create operation.</param>
        /// <returns>The marker.</returns>
        internal static Guid CreateMarker(string operationId) =>
            new(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes("je-list-create|" + operationId)).AsSpan(0, 16));

        /// <summary>
        /// The name a create runs under: the chosen name with the marker, so Jellyfin makes the list's folder from it (a
        /// folder no other list has, which keeps the marker) before the list gets its chosen name.
        /// </summary>
        /// <param name="name">The chosen name.</param>
        /// <param name="marker">The create operation's marker.</param>
        /// <returns>The name to create under.</returns>
        internal static string CreateName(string name, Guid marker) => name + " (" + marker.ToString("N", CultureInfo.InvariantCulture) + ")";

        /// <summary>
        /// PUT /{listId}/swap-in: turns automatic swap-in on for the list (recording the caller as the person who agreed;
        /// it then also needs their own swap-in preference) or off. Needs edit rights (rechecked under the lock).
        /// </summary>
        /// <param name="access">Authorised access (CanEdit).</param>
        /// <param name="rev">Expected revision.</param>
        /// <param name="enabled">On or off.</param>
        /// <param name="request">Client request id and request digest.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The outcome (<see cref="ListViewDto"/>).</returns>
        public async Task<ListOutcome> SetSwapInAsync(ListAccess access, int rev, bool enabled, ListRequestKey? request, CancellationToken cancellationToken)
        {
            // The parental lookups run before the lock (they can take seconds); under it they are read again from the
            // warmed cache with the person as they are then.
            await ListContinuation.Await(() => _gate.VisibilityAsync(_store.Load(access.ListIdN)?.Items ?? new List<Placeholder>(), access.User, cancellationToken)).ConfigureAwait(false);
            var outcome = await ListContinuation.Await(() => RunLockedAsync(access, "swap_in", request, cancellationToken, async () =>
            {
                // The awaited parental lookups first, then the gate, with no await before the change it allows.
                var doc = _store.LoadForUpdate(access.ListIdN, access.List.Kind);
                var checkedNow = await ListContinuation.Await(() => CheckedAsync(access, Array.Empty<Placeholder>(), doc, cancellationToken)).ConfigureAwait(false);
                if (checkedNow.Denied != null)
                {
                    return checkedNow.Denied;
                }

                access = checkedNow.Access!;
                var visibility = checkedNow.Visibility!;
                if (doc.Rev != rev)
                {
                    return await ListContinuation.Await(() => ConflictAsync(access, "rev_conflict", "The list changed; reload it.", visibility, cancellationToken)).ConfigureAwait(false);
                }

                doc.SwapIn = enabled
                    ? new ListConsent { ByUserId = access.UserIdN, At = Now().UtcDateTime.ToString("o", CultureInfo.InvariantCulture) }
                    : null;
                List<string>? canonical = null;
                if (access.List.Kind == ListKinds.Playlist)
                {
                    canonical = Canonical(access, doc);
                    doc.Order = canonical;
                }

                var saved = _store.Save(doc);
                return await ListContinuation.Await(() => ViewOutcomeAsync(access, saved, canonical, visibility, cancellationToken)).ConfigureAwait(false);
            })).ConfigureAwait(false);
            if (enabled && outcome.StatusCode < 300)
            {
                _swap?.QueuePass(access.ListIdN, null, MetadataMode.None);
            }

            return outcome;
        }

        // A completed create answered again: the same list and result identity, the list projected for the caller now
        // (through the gate: nothing when they can no longer see it).
        private async Task<ListOutcome> ReplayCreatedAsync(User user, ListInfo list, ListOperation operation, CancellationToken cancellationToken)
        {
            var view = await ListContinuation.Await(() => ViewAsync(_access.Evaluate(list, user), cancellationToken)).ConfigureAwait(false);
            if (view == null)
            {
                return ListOutcome.Error(404, "not_found", "List not found.");
            }

            var result = ReadResult(operation.Result);
            result.View = view;
            return ListOutcome.Ok(result);
        }

        // ── Helpers ──────────────────────────────────────────────────────────

        /// <summary>The canonical order of a playlist document against Jellyfin's current entries.</summary>
        /// <param name="access">List access.</param>
        /// <param name="doc">Document (or null).</param>
        /// <param name="raw">Raw entries (read when null).</param>
        /// <returns>Canonical order.</returns>
        private List<string> Canonical(ListAccess access, ListDoc? doc, IReadOnlyList<RawEntry>? raw = null)
        {
            var real = ListOrder.BuildRealTokens(raw ?? _host.GetRawEntries(access.List.Id));
            return ListOrder.Reconcile(
                doc?.Order ?? new List<string>(),
                real,
                (doc?.Items ?? new List<Placeholder>()).Select(p => p.Id).ToList());
        }

        // The only place a list view is made: from a grant the gate made right before (inside ListGate.ProjectAsync), so
        // the rights, limits and item access it shows are the caller's as they are when it is answered.
        private ListViewDto BuildView(ListGrant grant, ListDoc? doc, IReadOnlyList<string>? canonical, IReadOnlyDictionary<string, JsonElement>? statuses = null)
        {
            var access = grant.Access;
            var visibility = grant.Visibility;
            var config = Config;
            var items = (doc?.Items ?? new List<Placeholder>()).Where(visibility.IsVisible).ToList();
            var edit = access.Permissions.CanEdit && ListFlags.Authoring(config);
            var capabilities = _capabilities?.Invoke(access.User.Id);
            var request = ListFlags.Requests(config) && capabilities?.CanRequest == true;
            var view = new ListViewDto
            {
                ListId = access.ListIdN,
                ListKind = access.List.Kind,
                Rev = doc?.Rev ?? 0,
                CanEdit = access.Permissions.CanEdit,
                NativeCanEdit = access.Permissions.NativeCanEdit,
                StatusShown = statuses != null || (_status != null && StatusShown(access.User.Id)),
                SwapIn = doc?.SwapIn != null,
                Reconciling = doc?.Reconcile != null,
            };
            if (edit)
            {
                view.Actions.Add("edit");
                if (access.List.Kind == ListKinds.Playlist)
                {
                    view.Actions.Add("reorder");
                }
            }

            if (request)
            {
                view.Actions.Add("request");
                if (ListFlags.RequestAll(config))
                {
                    view.Actions.Add("requestAll");
                }
            }

            if (access.Permissions.CanEdit && ListFlags.SwapIn(config))
            {
                view.Actions.Add("swapIn");
            }

            var today = DateTime.UtcNow;
            var restricted = _access.IsRestricted(access.User);
            var callerVisible = new Dictionary<Guid, bool>(); // rows (playlists) / access (collections), per item
            var byId = items.ToDictionary(p => p.Id, StringComparer.Ordinal);
            IEnumerable<Placeholder> ordered;
            if (access.List.Kind == ListKinds.Playlist && canonical != null)
            {
                var placeholderVisible = visibility.For(items);
                view.Order = ListOrder.Project(canonical, t => IsVisibleToken(t, access.User, placeholderVisible, callerVisible));
                ordered = view.Order.Select(ListOrder.PlaceholderIdOf).OfType<string>().Where(byId.ContainsKey).Select(id => byId[id]);
            }
            else
            {
                ordered = ListOrder.SortForCollection(items);
            }

            foreach (var placeholder in ordered)
            {
                var key = ListRules.TitleKeyOf(placeholder);
                var dto = new PlaceholderDto
                {
                    Id = placeholder.Id,
                    Token = ListOrder.PlaceholderToken(placeholder.Id),
                    Kind = placeholder.Kind,
                    MediaType = placeholder.MediaType,
                    TmdbId = placeholder.TmdbId,
                    TvdbId = placeholder.TvdbId,
                    ImdbId = placeholder.ImdbId,
                    Title = placeholder.Title,
                    Year = placeholder.Year,
                    ReleaseDate = placeholder.ReleaseDate,
                    Released = ListRules.IsReleased(placeholder, today),
                    // A poster nothing could check is never shown to a viewer with parental controls.
                    PosterPath = placeholder.PosterUnverified == true && restricted ? null : placeholder.PosterPath,
                    Overview = placeholder.Overview,
                    SeasonNumber = placeholder.SeasonNumber,
                    Episodes = placeholder.Episodes,
                    EpisodeTotal = placeholder.EpisodeTotal,
                    FilledCount = VisibleFilledCount(access, placeholder, callerVisible),
                    Note = placeholder.Note,
                    AddedByMe = string.Equals(placeholder.AddedBy, access.UserIdN, StringComparison.Ordinal),
                    AddedAt = placeholder.AddedAt,
                    TitleKey = key?.ToString(),
                    Edition = ListRules.EditionOf(placeholder),
                    Status = StatusFor(placeholder, key, statuses),
                    ExpectedCount = PlaceholderProgress.ExpectedCount(placeholder),
                    AiredCount = PlaceholderProgress.AiredCount(placeholder, today),
                    InProduction = placeholder.InProduction,
                    InLibraryItemId = PendingMatchFor(access, placeholder.Id),
                };
                if (request && key != null && Requestable(placeholder, capabilities))
                {
                    dto.Actions.Add("request");
                }

                if (edit)
                {
                    dto.Actions.Add("remove");
                    dto.Actions.Add("note");
                    if (placeholder.Kind == PlaceholderKinds.Custom)
                    {
                        dto.Actions.Add("link");
                    }
                }

                view.Placeholders.Add(dto);
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
                _logger.Debug($"[Lists] Access check of list {access.ListIdN} failed: {ex.Message}");
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
                        _logger.Debug($"[Lists] Access check failed for {itemId:N}: {ex.Message}");
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
                _logger.Debug($"[Lists] Access check failed for {itemId:N}: {ex.Message}");
                return null;
            }
        }

        // A 409 with the list as the caller may see it now (its stored state); 404 when they can no longer see it.
        private async Task<ListOutcome> ConflictAsync(ListAccess access, string code, string message, PlaceholderVisibility visibility, CancellationToken cancellationToken)
        {
            var current = _store.Load(access.ListIdN);
            var canonical = access.List.Kind == ListKinds.Playlist ? Canonical(access, current) : null;
            var view = await ListContinuation.Await(() => _gate.ProjectAsync(access, current?.Items ?? new List<Placeholder>(), visibility, grant => BuildView(grant, current, canonical), cancellationToken)).ConfigureAwait(false);
            return view == null ? ListOutcome.Error(404, "not_found", "List not found.") : ListOutcome.Error(409, code, message, view);
        }

        // A change's answer: the list as the caller may see it now; 404 when they can no longer see it (the change stands).
        private async Task<ListOutcome> ViewOutcomeAsync(ListAccess access, ListDoc? doc, IReadOnlyList<string>? canonical, PlaceholderVisibility visibility, CancellationToken cancellationToken)
        {
            var view = await ListContinuation.Await(() => _gate.ProjectAsync(access, doc?.Items ?? new List<Placeholder>(), visibility, grant => BuildView(grant, doc, canonical), cancellationToken)).ConfigureAwait(false);
            return view == null ? ListOutcome.Error(404, "not_found", "List not found.") : ListOutcome.Ok(view);
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
                _logger.Warning($"[Lists] Recording what a failed update of list {access.ListIdN} added failed: {ex.Message}");
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

        private async Task<ListOutcome> RunLockedAsync(ListAccess access, string kind, ListRequestKey? request, CancellationToken cancellationToken, Func<Task<ListOutcome>> body)
        {
            using (await ListContinuation.Await(() => _store.LockAsync(access.ListIdN, cancellationToken)).ConfigureAwait(false))
            {
                ListOperation? operation = null;
                if (request != null && _operations?.Available == true)
                {
                    var start = _operations.Begin(access.User.Id, access.ListIdN, request.RequestId, kind, request.Fingerprint, Now());
                    if (start.Conflict)
                    {
                        return IdempotencyConflict();
                    }

                    if (start.Replayed && start.Operation!.State == "completed")
                    {
                        return await ListContinuation.Await(() => ReplayAsync(access, start.Operation, cancellationToken)).ConfigureAwait(false);
                    }

                    operation = start.Operation;
                }

                // F5: the list may have been deleted (and its document removed) since access was checked; writing now
                // would recreate an orphan document.
                if (_host.GetList(Guid.ParseExact(access.ListIdN, "N")) == null)
                {
                    return ListOutcome.Error(404, "not_found", "List not found.");
                }

                var outcome = await ListContinuation.Await(() => body()).ConfigureAwait(false);
                if (operation != null)
                {
                    // A failed operation stays retryable (the same request id runs it again); a finished one is replayed.
                    _operations!.Finish(operation.Id, outcome.StatusCode < 300, outcome.StatusCode, outcome.Value is ApplyResultDto result ? ResultIdentity(result) : null, Now());
                }

                return outcome;
            }
        }

        // A completed operation answered again: its result identity, and the list as the caller may see it NOW through the
        // gate (a share removed since then hides it; nothing privileged is replayed from storage). The caller holds the lock.
        private async Task<ListOutcome> ReplayAsync(ListAccess access, ListOperation operation, CancellationToken cancellationToken)
        {
            if (_gate.Current(access) is not { } current)
            {
                return ListOutcome.Error(404, "not_found", "List not found.");
            }

            var doc = _store.Load(current.ListIdN);
            var canonical = current.List.Kind == ListKinds.Playlist ? Canonical(current, doc) : null;
            var view = await ListContinuation.Await(() => _gate.ProjectAsync(current, doc?.Items ?? new List<Placeholder>(), null, grant => BuildView(grant, doc, canonical), cancellationToken)).ConfigureAwait(false);
            if (view == null)
            {
                return ListOutcome.Error(404, "not_found", "List not found.");
            }

            if (operation.Kind is "apply" or "add")
            {
                var result = ReadResult(operation.Result);
                result.View = view;
                return new ListOutcome { StatusCode = operation.Status ?? 200, Value = result };
            }

            return new ListOutcome { StatusCode = operation.Status ?? 200, Value = view };
        }

        private static ListOutcome IdempotencyConflict() =>
            ListOutcome.Error(409, "idempotency_conflict", "This request id was already used for a different change.");

        // What an apply did (ids only, no view): stored with its operation for replays.
        private static string ResultIdentity(ApplyResultDto result) =>
            JsonSerializer.Serialize(new ApplyResultDto { Added = result.Added, AddedAsItems = result.AddedAsItems, Skipped = result.Skipped }, ResultJson);

        private static ApplyResultDto ReadResult(string? json)
        {
            if (string.IsNullOrEmpty(json))
            {
                return new ApplyResultDto();
            }

            try
            {
                return JsonSerializer.Deserialize<ApplyResultDto>(json, ResultJson) ?? new ApplyResultDto();
            }
            catch (JsonException)
            {
                return new ApplyResultDto();
            }
        }

        private bool IsVisibleToken(string token, User user, Func<string, bool> placeholderVisible, Dictionary<Guid, bool> memo)
        {
            var placeholderId = ListOrder.PlaceholderIdOf(token);
            return placeholderId != null ? placeholderVisible(placeholderId) : EntryVisible(token, user, memo);
        }

        private bool EntryVisible(string token, User user, Dictionary<Guid, bool> memo)
        {
            if (!ListOrder.TryParseReal(token, out var itemId, out _))
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
                    _logger.Debug($"[Lists] Visibility check failed for {itemId:N}: {ex.Message}");
                    visible = false;
                }

                memo[itemId] = visible;
            }

            return visible;
        }

        private static bool IsAllowedKind(BaseItemKind kind, bool playlist) => playlist
            ? kind is BaseItemKind.Movie or BaseItemKind.Episode or BaseItemKind.Video or BaseItemKind.MusicVideo
            : kind is BaseItemKind.Movie or BaseItemKind.Series or BaseItemKind.Season or BaseItemKind.Episode or BaseItemKind.Video or BaseItemKind.MusicVideo;

        // The entry's status: its season's for season and episodes entries (never the series card's), else the title's.
        private static JsonElement? StatusFor(Placeholder placeholder, TitleKey? key, IReadOnlyDictionary<string, JsonElement>? statuses)
        {
            if (key == null || statuses == null)
            {
                return null;
            }

            if (StatusPartOf(placeholder) is { } part)
            {
                return statuses.TryGetValue(part.Id, out var own) ? own : null;
            }

            if (placeholder.Kind is PlaceholderKinds.Season or PlaceholderKinds.Episodes)
            {
                return placeholder.SeasonNumber is int season && statuses.TryGetValue(ListStatusKeys.SeasonId(key, season), out var scoped) ? scoped : null;
            }

            return statuses.TryGetValue(key.ToString(), out var status) ? status : null;
        }

        // The scope of an entry whose status is its own rather than the title's or season's: an episodes entry (exactly
        // its episodes) and a 4K entry (its edition's).
        private static ListStatusPart? StatusPartOf(Placeholder placeholder)
        {
            if (ListRules.TitleKeyOf(placeholder) is not { } key)
            {
                return null;
            }

            var fourK = ListRules.EditionOf(placeholder) == ListRules.FourK;
            if (placeholder.Kind == PlaceholderKinds.Episodes && placeholder.Episodes.Count > 0)
            {
                return new ListStatusPart(key, null, fourK, placeholder.Episodes.Select(e => (e.S, e.E)).Distinct().ToList());
            }

            if (!fourK)
            {
                return null;
            }

            return placeholder.Kind is PlaceholderKinds.Season or PlaceholderKinds.Episodes
                ? placeholder.SeasonNumber is int season ? new ListStatusPart(key, season, true) : null
                : new ListStatusPart(key, null, true);
        }

        // Whether the caller's request capabilities allow asking for this kind of entry (the request policy decides the rest).
        private static bool Requestable(Placeholder placeholder, RequestCapabilities? capabilities) =>
            placeholder.Kind != PlaceholderKinds.Custom && capabilities != null
            && (placeholder.MediaType == "movie" ? capabilities.CanRequestMovies : capabilities.CanRequestSeries)
            && (ListRules.EditionOf(placeholder) != ListRules.FourK || (placeholder.MediaType == "movie" ? capabilities.Can4kMovies : capabilities.Can4kSeries));

        private static bool HasTmdb(Placeholder placeholder) => placeholder.Kind != PlaceholderKinds.Custom && placeholder.TmdbId is > 0;

        private static SkippedEntryDto Skip(ApplyEntry entry, string reason, int? sameAs = null) => new() { Index = entry.Index, Reason = reason, SameAs = sameAs };
    }
}
