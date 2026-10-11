using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders
{
    /// <summary>What one auto-request run did (for logs and tests).</summary>
    public sealed class AutoRequestRun
    {
        /// <summary>Request keys (<c>movie|id</c> / <c>tv|id|season</c>) Seerr accepted as new requests, in order.</summary>
        public List<string> Requested { get; } = new();

        /// <summary>Request keys Seerr reported as already requested (202 "No seasons available" or 409).</summary>
        public List<string> AlreadyRequested { get; } = new();

        /// <summary>Placeholders that were looked at and skipped, with the reason.</summary>
        public List<(string PlaceholderId, string Reason)> Skipped { get; } = new();

        /// <summary>Why the run stopped early (null when it ran to the end or hit the count).</summary>
        public string? StoppedReason { get; set; }

        /// <summary>Lists (ids "N") that contained the played item and were visible to the user, in request priority order.</summary>
        public List<string> Lists { get; } = new();
    }

    /// <summary>
    /// List placeholder auto-requests (design §11, D3, G1–G3). When a user plays an item that is in a playlist or
    /// collection with placeholders, the next placeholders after it in list order are requested in Seerr AS THAT USER
    /// (<c>X-Api-User</c>), so Seerr's permissions, quotas and approval rules apply:
    /// <list type="bullet">
    /// <item>Trigger: minutes = 0 → playback start, else once the playback position reaches the configured minutes;
    /// once per session + item (until <see cref="TriggerTtl"/> passes without an event for it). Settings are read per
    /// event (no restart needed).</item>
    /// <item>Lists: documents with placeholders whose entries contain the item (playlist: the entry; collection: the
    /// item, or its series/season for an episode) and that the user can view by JELLYFIN's rules (no JE admin
    /// override: an administrator's playback never requests from another user's private playlist). Public playlists of
    /// other users count, as the spec's "visible lists" (the requests are still the playing user's, under their Seerr
    /// rights). Owned, then natively editable lists first, then the most recently modified.</item>
    /// <item>Candidates: up to <see cref="ListPlaceholderAutoRequestRules.ScanWindow"/> entries after the item in the
    /// user's projection (A2: real rows the user can't see and placeholders their parental controls hide take no
    /// slot); eligible = TMDB title (not custom), released (when "only released": the stored per-kind release date,
    /// kept current by <see cref="ListPlaceholderMetadataService"/>; TBA = unreleased), not hidden by the
    /// user's parental controls (fail closed), the user is linked to Seerr, not blocklisted by JE and may request that
    /// media type. Ineligible ones are skipped, not counted.</item>
    /// <item>TV requests one season (<see cref="ListPlaceholderAutoRequestRules.RequestSeason"/>): a season placeholder its
    /// season, an episodes placeholder the season of its episodes, a series placeholder season 1 (or its lowest regular
    /// season when it has no season 1); Auto Season Requests, when on, continues later seasons.</item>
    /// <item>Dedupe by <c>mediaType|tmdbId|season</c> across lists (a key is only "used" once an outcome holds for the
    /// whole key; a placeholder skipped for its own release date or a transient Seerr failure doesn't block a later
    /// one with the same key), at most N requests per trigger, and per user for
    /// <see cref="ListPlaceholderAutoRequestRules.UserDedupeWindow"/>.</item>
    /// <item>Right before each POST the title's current Seerr status is read (season level for TV) and statuses 2–6
    /// are skipped (D3), under a process-wide per-title lock (<see cref="SeerrRequestLocks"/>) so overlapping runs of
    /// different users (and the sibling auto-request services) never POST the same title at once. 202 "No seasons
    /// available" and 409 count as already requested. Results go into the Seerr status index. A POST that may have
    /// reached Seerr without an answer (timeout) stops the run and keeps the per-user reservation.</item>
    /// </list>
    /// Independent of Auto Season/Movie Requests (they keep their own switches and triggers).
    /// </summary>
    public sealed class ListPlaceholderAutoRequestService : IDisposable
    {
        /// <summary>How long a session + item stays "triggered" after its last playback event.</summary>
        public static readonly TimeSpan TriggerTtl = TimeSpan.FromHours(6);

        private const int MaxConcurrentRuns = 2;
        private const int MaxDetailFailures = 3;
        private const int PruneEvery = 256;
        private const int MaxProjectionPasses = 8;

        private readonly ListPlaceholderStore _store;
        private readonly ListAccessService _access;
        private readonly IListPlaceholderHost _host;
        private readonly IAutoRequestLibrary _library;
        private readonly SeerrRequestGateway _seerr;
        private readonly SeerrMediaIndex _index;
        private readonly IUserManager _userManager;
        private readonly Logger _logger;
        private readonly TimeProvider _time;
        private readonly object _gate = new();
        private readonly Dictionary<string, DateTime> _triggered = new(StringComparer.Ordinal);
        private readonly Dictionary<string, DateTime> _handled = new(StringComparer.Ordinal);
        private readonly SemaphoreSlim _runs = new(MaxConcurrentRuns);
        private readonly CancellationTokenSource _shutdown = new();
        private int _marks;
        private volatile bool _disposed;

        /// <summary>Creates the service (singleton).</summary>
        /// <param name="store">Placeholder store.</param>
        /// <param name="access">List access rules.</param>
        /// <param name="host">Jellyfin list seam.</param>
        /// <param name="library">Library seam.</param>
        /// <param name="seerr">Seerr gateway.</param>
        /// <param name="index">Seerr status index.</param>
        /// <param name="userManager">User manager.</param>
        /// <param name="logger">JE logger.</param>
        public ListPlaceholderAutoRequestService(
            ListPlaceholderStore store,
            ListAccessService access,
            IListPlaceholderHost host,
            IAutoRequestLibrary library,
            SeerrRequestGateway seerr,
            SeerrMediaIndex index,
            IUserManager userManager,
            Logger logger)
            : this(store, access, host, library, seerr, index, userManager, logger, TimeProvider.System)
        {
        }

        internal ListPlaceholderAutoRequestService(
            ListPlaceholderStore store,
            ListAccessService access,
            IListPlaceholderHost host,
            IAutoRequestLibrary library,
            SeerrRequestGateway seerr,
            SeerrMediaIndex index,
            IUserManager userManager,
            Logger logger,
            TimeProvider time)
        {
            _time = time;
            _store = store;
            _access = access;
            _host = host;
            _library = library;
            _seerr = seerr;
            _index = index;
            _userManager = userManager;
            _logger = logger;
        }

        /// <summary>
        /// True when list auto-requests run: the list placeholder master switch, the auto-request switch and Seerr are
        /// all on. Read on every playback event.
        /// </summary>
        /// <returns>Whether enabled.</returns>
        public static bool IsEnabled()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            return config != null && config.ListPlaceholdersEnabled && config.ListPlaceholdersAutoRequestEnabled && SeerrRequestGateway.IsConfigured();
        }

        /// <summary>
        /// Handles one playback event: cheap checks inline, the actual work in the background (playback reporting is
        /// never delayed). Returns the background task when this event triggered a run, else null.
        /// </summary>
        /// <param name="phase">Event kind.</param>
        /// <param name="userId">The playing user (session user).</param>
        /// <param name="sessionKey">Session identity (session id, else device id).</param>
        /// <param name="item">The played item.</param>
        /// <param name="positionTicks">Playback position.</param>
        /// <returns>The run, or null.</returns>
        public Task<AutoRequestRun>? OnPlayback(PlaybackPhase phase, Guid userId, string? sessionKey, PlayedItem? item, long? positionTicks)
        {
            if (_disposed || item == null || userId == Guid.Empty || !IsEnabled())
            {
                return null;
            }

            var config = JellyfinEnhanced.Instance!.Configuration;
            var minutes = ListPlaceholderAutoRequestRules.ClampMinutes(config.ListPlaceholdersAutoRequestMinutes);
            if (!ListPlaceholderAutoRequestRules.ShouldTrigger(phase, positionTicks, minutes))
            {
                return null;
            }

            var key = string.Join('|', N(userId), string.IsNullOrEmpty(sessionKey) ? "-" : sessionKey, N(item.Id));
            if (!TryMark(_triggered, key, TriggerTtl, slide: true))
            {
                return null;
            }

            _logger.Debug($"[ListPlaceholders] Auto-request trigger: {phase} of '{item.Name}' ({N(item.Id)}) by user {N(userId)} at {FormatPosition(positionTicks)} (threshold {minutes} min)");
            var token = _shutdown.Token;
            return Task.Run(() => RunGuardedAsync(userId, item, token), CancellationToken.None);
        }

        /// <summary>
        /// Finds the lists containing the played item and requests their next eligible placeholders as the user.
        /// </summary>
        /// <param name="userId">The playing user.</param>
        /// <param name="item">The played item.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>What was done.</returns>
        public async Task<AutoRequestRun> RunAsync(Guid userId, PlayedItem item, CancellationToken cancellationToken)
        {
            var run = new AutoRequestRun();
            var config = JellyfinEnhanced.Instance?.Configuration;
            var user = _userManager.GetUserById(userId);
            if (config == null || user == null || !IsEnabled())
            {
                run.StoppedReason = "disabled";
                return run;
            }

            var lists = await FindListsAsync(user, item, cancellationToken).ConfigureAwait(false);
            run.Lists.AddRange(lists.Select(l => l.Access.ListIdN));
            if (lists.Count == 0)
            {
                _logger.Debug($"[ListPlaceholders] Auto-request: '{item.Name}' is in no visible list with placeholders after it");
                run.StoppedReason = "no lists";
                return run;
            }

            var account = await _seerr.ResolveAccountAsync(userId, cancellationToken).ConfigureAwait(false);
            if (account.State != SeerrAccountState.Linked)
            {
                _logger.Debug($"[ListPlaceholders] Auto-request skipped for {user.Username}: Seerr account {account.State}");
                run.StoppedReason = "account " + account.State.ToString().ToLowerInvariant();
                return run;
            }

            var count = ListPlaceholderAutoRequestRules.ClampCount(config.ListPlaceholdersAutoRequestCount);
            var onlyReleased = config.ListPlaceholdersAutoRequestOnlyReleased;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var detailFailures = 0;
            foreach (var list in lists)
            {
                foreach (var placeholder in list.Candidates)
                {
                    if (run.Requested.Count >= count || run.StoppedReason != null)
                    {
                        return run;
                    }

                    var verdict = await ConsiderAsync(placeholder, list, user, account, onlyReleased, seen, run, cancellationToken).ConfigureAwait(false);
                    if (verdict == Verdict.DetailsFailed && ++detailFailures >= MaxDetailFailures)
                    {
                        run.StoppedReason = "seerr details failing";
                    }
                    else if (verdict != Verdict.DetailsFailed)
                    {
                        detailFailures = 0;
                    }
                }
            }

            return run;
        }

        /// <inheritdoc />
        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            _shutdown.Cancel();
            _shutdown.Dispose();
            _runs.Dispose();
        }

        // ── Candidate lists ─────────────────────────────────────────────────

        private async Task<List<CandidateList>> FindListsAsync(User user, PlayedItem item, CancellationToken cancellationToken)
        {
            // Most specific first: a collection anchors at the item itself, else its season, else its series.
            var anchors = new List<Guid> { item.Id };
            if (item.SeasonId is Guid season)
            {
                anchors.Add(season);
            }

            if (item.SeriesId is Guid series)
            {
                anchors.Add(series);
            }

            var visible = new Dictionary<Guid, bool>();
            bool Visible(Guid id)
            {
                if (!visible.TryGetValue(id, out var value))
                {
                    try
                    {
                        value = _host.IsEntryVisible(id, user);
                    }
                    catch (Exception ex)
                    {
                        _logger.Debug($"[ListPlaceholders] Visibility check failed for {N(id)}: {ex.Message}");
                        value = false;
                    }

                    visible[id] = value;
                }

                return value;
            }

            var result = new List<CandidateList>();
            foreach (var listIdN in _store.EnumerateListIds())
            {
                try
                {
                    var doc = _store.Load(listIdN);
                    if (doc == null || !doc.Items.Any(IsRequestable) || !Guid.TryParseExact(listIdN, "N", out var listId))
                    {
                        continue;
                    }

                    var info = _host.GetList(listId);
                    if (info == null)
                    {
                        continue;
                    }

                    var raw = _host.GetRawEntries(listId);
                    var resolved = raw.Where(r => r.Resolved && r.ItemId.HasValue).Select(r => r.ItemId!.Value).ToList();
                    var isPlaylist = info.Kind == ListKinds.Playlist;
                    if (isPlaylist ? !resolved.Contains(item.Id) : !resolved.Any(anchors.Contains))
                    {
                        continue;
                    }

                    // Jellyfin's own visibility, not JE's admin override: requests are made in the playing user's name.
                    var access = _access.EvaluateNative(info, user);
                    if (!access.Permissions.CanView)
                    {
                        continue;
                    }

                    Func<Func<string, bool>, List<string>?> window;
                    if (isPlaylist)
                    {
                        var canonical = ListPlaceholderOrder.Reconcile(
                            doc.Order,
                            ListPlaceholderOrder.BuildRealTokens(raw),
                            doc.Items.Select(p => p.Id).ToList());
                        window = shown => ListPlaceholderAutoRequestRules.PlaylistWindow(canonical, item.Id, Visible, placeholderVisible: shown);
                    }
                    else
                    {
                        var real = resolved.Distinct().Where(Visible).Select(id => new DatedEntry(id, _library.GetPremiereDate(id))).ToList();
                        window = shown => ListPlaceholderAutoRequestRules.CollectionWindow(real, doc.Items, anchors, placeholderVisible: shown);
                    }

                    var ids = await ProjectedWindowAsync(window, doc.Items, user, cancellationToken).ConfigureAwait(false);

                    if (ids == null || ids.Count == 0)
                    {
                        continue;
                    }

                    var byId = doc.Items.ToDictionary(p => p.Id, StringComparer.Ordinal);
                    var tier = isPlaylist && info.OwnerId == user.Id ? 0 : access.Permissions.CanEdit ? 1 : 2; // native edit rights
                    result.Add(new CandidateList(access, info.Name, tier, doc.UpdatedAt ?? string.Empty, ids.Where(byId.ContainsKey).Select(id => byId[id]).ToList()));
                }
                catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
                {
                    // One unreadable list never stops the others.
                    _logger.Debug($"[ListPlaceholders] Auto-request skipped list {listIdN}: {ex.Message}");
                }
            }

            return result
                .OrderBy(l => l.Tier)
                .ThenByDescending(l => l.UpdatedAt, StringComparer.Ordinal)
                .ThenBy(l => l.Access.ListIdN, StringComparer.Ordinal)
                .ToList();
        }

        // The window in the user's projection (A2): placeholders the user's parental controls hide take no window slot.
        // Unrestricted users: no lookups. Restricted users: only the placeholders that land in the window are checked
        // (cached by the parental filter); hidden ones are dropped and the window recomputed until it holds no
        // unchecked placeholder (bounded; anything left unchecked is still checked, fail closed, when considered).
        private async Task<List<string>?> ProjectedWindowAsync(
            Func<Func<string, bool>, List<string>?> window,
            IReadOnlyList<Placeholder> placeholders,
            User user,
            CancellationToken cancellationToken)
        {
            if (!_access.IsRestricted(user))
            {
                return window(_ => true);
            }

            var byId = placeholders.ToDictionary(p => p.Id, StringComparer.Ordinal);
            var hidden = new HashSet<string>(StringComparer.Ordinal);
            var checkedIds = new HashSet<string>(StringComparer.Ordinal);
            for (var pass = 0; ; pass++)
            {
                var ids = window(id => !hidden.Contains(id));
                if (ids == null)
                {
                    return null;
                }

                var pending = ids.Where(id => !checkedIds.Contains(id) && byId.ContainsKey(id)).Select(id => byId[id]).ToList();
                if (pending.Count == 0 || pass >= MaxProjectionPasses)
                {
                    return ids;
                }

                checkedIds.UnionWith(pending.Select(p => p.Id));
                hidden.UnionWith(await _access.GetHiddenPlaceholderIdsAsync(pending, user, cancellationToken).ConfigureAwait(false));
            }
        }

        // ── One placeholder ─────────────────────────────────────────────────

        private async Task<Verdict> ConsiderAsync(
            Placeholder placeholder,
            CandidateList list,
            User user,
            SeerrAccount account,
            bool onlyReleased,
            HashSet<string> seen,
            AutoRequestRun run,
            CancellationToken cancellationToken)
        {
            if (!IsRequestable(placeholder))
            {
                return Skip(run, placeholder, "custom entry (no TMDB title)");
            }

            var tmdbId = placeholder.TmdbId!.Value;
            var mediaType = placeholder.MediaType;
            var today = DateTime.UtcNow;
            var season = ListPlaceholderAutoRequestRules.RequestSeason(placeholder);
            if (mediaType == "tv" && season == null)
            {
                return Skip(run, placeholder, "no season to request");
            }

            var key = ListPlaceholderAutoRequestRules.RequestKey(mediaType, tmdbId, season);

            // A series whose expected set isn't known yet only gets its real season from the Seerr details below, so
            // the season-level dedupe (`seen`, the user's 6 h window) waits for that; until then the key is provisional.
            var provisional = ListPlaceholderAutoRequestRules.SeasonDependsOnSeerrDetails(placeholder);

            // A key goes into `seen` only once an outcome holds for every placeholder with that key (permission,
            // parental, user dedupe, Seerr status, POST). "Not released" and Seerr details failures depend on the
            // placeholder or are transient, so a later placeholder with the same key still gets its turn.
            if (!provisional && seen.Contains(key))
            {
                return Skip(run, placeholder, "same title/season as an earlier candidate");
            }

            // C4: the stored release date per kind, kept current by the metadata service (after adds and by the
            // maintenance task) — the same "released" the list view shows. Unreleased titles cost no Seerr call.
            if (onlyReleased && !PlaceholderRules.IsReleased(placeholder, today))
            {
                return Skip(run, placeholder, placeholder.ReleaseDate == null ? "not released (TBA)" : $"not released ({placeholder.ReleaseDate})");
            }

            if (!ListPlaceholderAutoRequestRules.CanRequest(account.Permissions, mediaType))
            {
                seen.Add(key); // title-level: holds for every season of it
                return Skip(run, placeholder, $"no Seerr permission to request {(mediaType == "tv" ? "series" : "movies")}");
            }

            if (!provisional && IsHandledForUser(user, key))
            {
                seen.Add(key);
                return Skip(run, placeholder, "already handled for this user in the last 6 h");
            }

            bool blocked;
            try
            {
                blocked = await _access.IsTitleBlockedAsync(mediaType, tmdbId, user, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                blocked = true; // fail closed
            }

            if (blocked)
            {
                seen.Add(key); // title-level: holds for every season of it
                return Skip(run, placeholder, "hidden by parental controls");
            }

            // Held from the status re-check (D3) to the POST's answer: another run (another user, or a sibling
            // auto-request service) for the same title waits, then sees this request in its own re-check.
            using var titleLock = await SeerrRequestLocks.AcquireAsync(SeerrRequestLocks.TitleKey(mediaType, tmdbId), cancellationToken).ConfigureAwait(false);
            var details = await _seerr.GetAsync(DetailsPath(mediaType, tmdbId), cancellationToken).ConfigureAwait(false);
            if (!details.Reached)
            {
                run.StoppedReason = "seerr unreachable";
                _logger.Debug($"[ListPlaceholders] Auto-request stopped: Seerr unreachable while checking '{placeholder.Title}'");
                return Verdict.Stopped;
            }

            if (!details.Ok)
            {
                Skip(run, placeholder, $"Seerr details failed (HTTP {details.StatusCode})");
                return Verdict.DetailsFailed;
            }

            JsonDocument document;
            try
            {
                document = JsonDocument.Parse(details.Body!);
            }
            catch (JsonException)
            {
                Skip(run, placeholder, "Seerr details unreadable");
                return Verdict.DetailsFailed;
            }

            using var parsed = document;
            var root = document.RootElement;
            RecordIndex(root);

            if (provisional)
            {
                // Seerr's season list fills what the stored metadata doesn't know yet (whether there is a season 1).
                // The dedupe skipped above runs on the real season.
                season = ListPlaceholderAutoRequestRules.RequestSeason(placeholder, root);
                key = ListPlaceholderAutoRequestRules.RequestKey(mediaType, tmdbId, season);
                if (seen.Contains(key))
                {
                    return Skip(run, placeholder, "same title/season as an earlier candidate");
                }

                if (IsHandledForUser(user, key))
                {
                    seen.Add(key);
                    return Skip(run, placeholder, "already handled for this user in the last 6 h");
                }
            }

            seen.Add(key); // every outcome from here on holds for the whole key

            var status = ListPlaceholderAutoRequestRules.SeerrStatus(root, mediaType, season);
            if (ListPlaceholderAutoRequestRules.IsHandledStatus(status))
            {
                MarkHandled(user, key);
                return Skip(run, placeholder, $"Seerr status {status} (already requested or available)");
            }

            if (!TryReserve(user, key))
            {
                return Skip(run, placeholder, "being requested by another playback");
            }

            var label = Describe(placeholder, mediaType, tmdbId, season);
            var body = ListPlaceholderAutoRequestRules.BuildRequestBody(mediaType, tmdbId, season);
            var post = await _seerr.PostRequestAsync(account.SeerrUserId, body, cancellationToken).ConfigureAwait(false);
            if (post.Ok && post.StatusCode == 202)
            {
                run.AlreadyRequested.Add(key);
                _logger.Info($"[ListPlaceholders] Auto-request: {label} for {user.Username} was already requested (Seerr: no seasons available to request)");
                return Verdict.Done;
            }

            if (post.Ok)
            {
                run.Requested.Add(key);
                _index.RecordRequestResponse(post.Body);
                _logger.Info($"[ListPlaceholders] Auto-requested {label} for {user.Username} (Seerr user {account.SeerrUserId}) from list '{list.Name}'");
                return Verdict.Done;
            }

            if (post.StatusCode == 409)
            {
                run.AlreadyRequested.Add(key);
                _logger.Info($"[ListPlaceholders] Auto-request: {label} for {user.Username} was already requested (Seerr 409)");
                return Verdict.Done;
            }

            if (post.MaybeSent)
            {
                // Timed out or lost mid-request: Seerr may have created it. Keep the reservation so this user doesn't
                // POST it again within the dedupe window; later runs of other users re-check its status (D3) first.
                run.StoppedReason = "seerr no answer";
                _logger.Warning($"[ListPlaceholders] Auto-request of {label} for {user.Username}: no answer from Seerr (it may have been created); not retried for {ListPlaceholderAutoRequestRules.UserDedupeWindow.TotalHours:0} h");
                return Verdict.Stopped;
            }

            Release(user, key);
            if (!post.Reached)
            {
                run.StoppedReason = "seerr unreachable";
                _logger.Warning($"[ListPlaceholders] Auto-request of {label} for {user.Username} failed: Seerr unreachable");
            }
            else if (post.StatusCode == 403)
            {
                run.StoppedReason = "seerr refused";
                _logger.Info($"[ListPlaceholders] Auto-request of {label} for {user.Username} refused by Seerr (403: permission, quota or blocklisted title)");
            }
            else
            {
                run.StoppedReason = "seerr error " + post.StatusCode.ToString(CultureInfo.InvariantCulture);
                _logger.Warning($"[ListPlaceholders] Auto-request of {label} for {user.Username} failed: Seerr returned {post.StatusCode}");
            }

            return Verdict.Stopped;
        }

        // The details' mediaInfo is a Seerr media row: keep the shared status index fresh with it.
        private void RecordIndex(JsonElement details)
        {
            if (details.ValueKind == JsonValueKind.Object
                && details.TryGetProperty("mediaInfo", out var media)
                && SeerrMediaIndex.TryParseRow(media, out var mediaType, out var tmdbId, out var entry))
            {
                _index.Record(mediaType, tmdbId, entry);
            }
        }

        // ── Bookkeeping ─────────────────────────────────────────────────────

        private async Task<AutoRequestRun> RunGuardedAsync(Guid userId, PlayedItem item, CancellationToken cancellationToken)
        {
            try
            {
                await _runs.WaitAsync(cancellationToken).ConfigureAwait(false);
                try
                {
                    var run = await RunAsync(userId, item, cancellationToken).ConfigureAwait(false);
                    _logger.Debug($"[ListPlaceholders] Auto-request run for '{item.Name}': lists={run.Lists.Count} requested=[{string.Join(", ", run.Requested)}] already=[{string.Join(", ", run.AlreadyRequested)}] skipped={run.Skipped.Count}{(run.StoppedReason == null ? string.Empty : " stopped=" + run.StoppedReason)}");
                    return run;
                }
                finally
                {
                    _runs.Release();
                }
            }
            catch (OperationCanceledException)
            {
                return new AutoRequestRun { StoppedReason = "cancelled" };
            }
            catch (ObjectDisposedException)
            {
                return new AutoRequestRun { StoppedReason = "cancelled" };
            }
            catch (Exception ex)
            {
                _logger.Error($"[ListPlaceholders] Auto-request for '{item.Name}' failed: {ex.Message}");
                return new AutoRequestRun { StoppedReason = "error" };
            }
        }

        private Verdict Skip(AutoRequestRun run, Placeholder placeholder, string reason)
        {
            run.Skipped.Add((placeholder.Id, reason));
            _logger.Debug($"[ListPlaceholders] Auto-request skips '{placeholder.Title}' ({placeholder.Kind}): {reason}");
            return Verdict.Skipped;
        }

        private bool IsHandledForUser(User user, string key)
        {
            lock (_gate)
            {
                return _handled.TryGetValue(UserKey(user, key), out var at) && UtcNow - at < ListPlaceholderAutoRequestRules.UserDedupeWindow;
            }
        }

        private void MarkHandled(User user, string key)
        {
            lock (_gate)
            {
                _handled[UserKey(user, key)] = UtcNow;
            }
        }

        private bool TryReserve(User user, string key) => TryMark(_handled, UserKey(user, key), ListPlaceholderAutoRequestRules.UserDedupeWindow);

        private void Release(User user, string key)
        {
            lock (_gate)
            {
                _handled.Remove(UserKey(user, key));
            }
        }

        // Atomic "first within ttl" marker shared by the trigger and the per-user request dedupe; prunes expired entries.
        // slide: a repeat within ttl renews the mark (the trigger: "within ttl" of the LAST event, so an ongoing playback
        // never triggers twice); otherwise ttl runs from the first mark (the request dedupe).
        private bool TryMark(Dictionary<string, DateTime> map, string key, TimeSpan ttl, bool slide = false)
        {
            var now = UtcNow;
            lock (_gate)
            {
                if (map.TryGetValue(key, out var at) && now - at < ttl)
                {
                    if (slide)
                    {
                        map[key] = now;
                    }

                    return false;
                }

                map[key] = now;
                if (++_marks % PruneEvery == 0)
                {
                    Prune(_triggered, TriggerTtl, now);
                    Prune(_handled, ListPlaceholderAutoRequestRules.UserDedupeWindow, now);
                }

                return true;
            }
        }

        private static void Prune(Dictionary<string, DateTime> map, TimeSpan ttl, DateTime now)
        {
            foreach (var stale in map.Where(pair => now - pair.Value >= ttl).Select(pair => pair.Key).ToList())
            {
                map.Remove(stale);
            }
        }

        private DateTime UtcNow => _time.GetUtcNow().UtcDateTime;

        private static bool IsRequestable(Placeholder placeholder) => placeholder.Kind != PlaceholderKinds.Custom && placeholder.TmdbId is > 0;

        private static string DetailsPath(string mediaType, int tmdbId) =>
            string.Create(CultureInfo.InvariantCulture, $"/api/v1/{(mediaType == "tv" ? "tv" : "movie")}/{tmdbId}");

        private static string Describe(Placeholder placeholder, string mediaType, int tmdbId, int? season) =>
            mediaType == "tv"
                ? string.Create(CultureInfo.InvariantCulture, $"'{placeholder.Title}' season {season} (tv {tmdbId})")
                : string.Create(CultureInfo.InvariantCulture, $"'{placeholder.Title}' (movie {tmdbId})");

        private static string UserKey(User user, string key) => N(user.Id) + "|" + key;

        private static string N(Guid id) => id.ToString("N", CultureInfo.InvariantCulture);

        private static string FormatPosition(long? ticks) =>
            ticks is long value ? TimeSpan.FromTicks(value).ToString(@"h\:mm\:ss", CultureInfo.InvariantCulture) : "unknown position";

        private enum Verdict
        {
            Skipped,
            DetailsFailed,
            Done,
            Stopped,
        }

        private sealed record CandidateList(ListAccess Access, string Name, int Tier, string UpdatedAt, List<Placeholder> Candidates);
    }
}
