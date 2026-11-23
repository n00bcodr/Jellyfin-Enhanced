using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>One Reclaimerr deletion request, as the Leaving soon page lists it.</summary>
    /// <remarks>The JSON names are pinned (Jellyfin's serializer would capitalize them) because the page reads these.</remarks>
    public sealed record ReclaimerrRequestRow(
        [property: JsonPropertyName("id")] int Id,
        [property: JsonPropertyName("title")] string Title,
        [property: JsonPropertyName("year")] int? Year,
        [property: JsonPropertyName("mediaType")] string MediaType,
        [property: JsonPropertyName("requestedBy")] string? RequestedBy,
        [property: JsonPropertyName("reason")] string? Reason,
        [property: JsonPropertyName("status")] string Status,
        [property: JsonPropertyName("createdAt")] string? CreatedAt,
        [property: JsonPropertyName("reviewedBy")] string? ReviewedBy,
        [property: JsonPropertyName("mediaId")] int MediaId = 0,
        [property: JsonPropertyName("posterPath")] string? PosterPath = null,
        [property: JsonPropertyName("scope")] string Scope = "movie",
        [property: JsonPropertyName("seasonNumber")] int? SeasonNumber = null,
        [property: JsonPropertyName("episodeNumber")] int? EpisodeNumber = null,
        [property: JsonPropertyName("versionResolution")] string? VersionResolution = null,
        [property: JsonPropertyName("versionSize")] long? VersionSize = null,
        [property: JsonPropertyName("adminNotes")] string? AdminNotes = null,
        [property: JsonPropertyName("executionError")] string? ExecutionError = null,
        [property: JsonPropertyName("deferred")] bool Deferred = false,
        [property: JsonPropertyName("scheduledAt")] string? ScheduledAt = null,
        [property: JsonPropertyName("scheduleState")] string? ScheduleState = null,
        [property: JsonIgnore] IReadOnlyList<Guid>? ItemIds = null,
        [property: JsonIgnore] IReadOnlyList<Guid>? RequesterIds = null);

    /// <summary>
    /// The Reclaimerr counterpart of <see cref="MaintainerrActions"/>, same answers for the item menu, all through Reclaimerr's
    /// token API (<see cref="ReclaimerrApi"/>):
    /// <list type="bullet">
    /// <item>Keep and postpone act on the item's cleanup candidate (<c>protect</c>, <c>postpone</c>, <c>reset-timer</c>), or
    /// cancel or reschedule its scheduled deletion (a manual one, or an approved request's).</item>
    /// <item>Mark for removal (administrators) schedules a manual deletion, <see cref="MarkDays"/> days ahead by default.</item>
    /// <item>Deletion requests are read, approved and denied with the token. Filing one (Request removal, anyone signed in) is
    /// the one thing the token cannot do for someone else, so it is sent as the user's own linked Reclaimerr account.</item>
    /// </list>
    /// People and titles are matched by id, never by name: a Reclaimerr account by the Jellyfin user id it is linked to, a
    /// title by the Jellyfin item ids Reclaimerr lists for it. A scheduled deletion is listed by its negated id where a
    /// candidate's id is positive, so one number says which kind governs an item. Every action ends with a forced Leaving soon refresh.
    /// </summary>
    public sealed class ReclaimerrActions
    {
        /// <summary>Days ahead a marked title is scheduled for deletion.</summary>
        public const int MarkDays = 30;
        public const int MaxPostponeDays = 3650;

        /// <summary>Most pages of a request list read (all of them, in practice).</summary>
        private const int AllPages = 50;

        private readonly IHttpClientFactory _http;
        private readonly LeavingSoonService _leaving;
        private readonly TagCacheService _cache;
        private readonly Logger _logger;
        private readonly object _sync = new();

        internal TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(30);
        internal Func<DateTimeOffset> Now { get; set; } = () => DateTimeOffset.UtcNow;

        public ReclaimerrActions(IHttpClientFactory http, LeavingSoonService leaving, TagCacheService cache, Logger logger)
        {
            _http = http;
            _leaving = leaving;
            _cache = cache;
            _logger = logger;
        }

        /// <summary>Whether the Reclaimerr actions are on: the switch, Reclaimerr chosen with its address and token.</summary>
        public static bool Enabled(PluginConfiguration? config)
            => config != null && config.LeavingSoonMaintainerrActions && LeavingSoonService.UsesReclaimerr(config) && LeavingSoonService.ApiConfigured(config);

        /// <summary>Whether signed-in users who are not administrators can request removals (as themselves, through the trusted-proxy sign-in).</summary>
        public static bool RequestsEnabled(PluginConfiguration? config)
            => Enabled(config) && ReclaimerrApi.RequestsAsUser(config);

        /// <summary>Reclaimerr's media type for an item, or null for a kind the actions do not handle.</summary>
        public static string? MediaType(BaseItem item) => item switch { Movie => "movie", Series => "series", _ => null };

        /// <summary>The item's state from the last read (cache-only).</summary>
        public MaintainerrItemState State(BaseItem item, PluginConfiguration config)
        {
            var fact = _leaving.Get(item.Id, config);
            var owner = _leaving.CollectionOf(item.Id, config);
            return new MaintainerrItemState
            {
                ItemId = item.Id.ToString("N"),
                Marked = fact != null && fact.Collections == null,
                CollectionId = owner,
                CollectionName = owner is { } id ? (id > 0 ? "Reclaimerr candidate" : "Reclaimerr scheduled deletion") : null,
                DeleteAt = fact?.DeleteAt,
                Supported = MediaType(item) != null,
            };
        }

        /// <summary>The exact day an action asked for, checked: in the future and within <see cref="MaxPostponeDays"/> days.</summary>
        private DateTimeOffset CheckedDate(DateTimeOffset at)
        {
            var now = Now();
            if (at <= now) throw new MaintainerrActions.ActionException("Pick a date in the future.");
            if (at > now.AddDays(MaxPostponeDays)) throw new MaintainerrActions.ActionException($"Pick a date within {MaxPostponeDays} days.");
            return at;
        }

        /// <summary>
        /// Schedule a manual deletion of the whole title on <paramref name="at"/> (administrators), or <see cref="MarkDays"/> days
        /// ahead when no date is given. A movie kept in several versions is scheduled by the version picked only.
        /// </summary>
        public async Task<MaintainerrItemState> MarkAsync(BaseItem item, PluginConfiguration config, DateTimeOffset? at, string? mediaSourceId, string? actingUser, CancellationToken token, Guid? actingUserId = null)
        {
            var type = MediaType(item) ?? throw new MaintainerrActions.ActionException("Only movies and series can be marked.");
            if (_leaving.CollectionOf(item.Id, config) != null) throw new MaintainerrActions.ActionException("This item is already marked for removal.");
            var (mediaId, media) = await ResolveMediaAsync(item, type, config, token).ConfigureAwait(false);
            var when = at is { } exact ? CheckedDate(exact) : Now().AddDays(MarkDays);
            // A movie kept in several versions (1080p and 4K): schedule only the file this item or the picked version is,
            // so the movie and its other copies stay. A single-version movie is scheduled whole (the Radarr entry goes too).
            var versionId = type == "movie" ? VersionId(item, mediaSourceId, media) : null;
            using (await ActingTokenAsync(config, actingUserId, HttpMethod.Post, "/api/v1/scheduled-deletions", new { media_type = type, media_id = mediaId, movie_version_id = versionId, scheduled_at = Iso(when) }, token).ConfigureAwait(false)) { }
            _logger.Info($"[Reclaimerr] {actingUser ?? "An administrator"} scheduled '{item.Name}'{(versionId != null ? " (one version)" : string.Empty)} for deletion on {when:yyyy-MM-dd}.");
            return await AfterAsync(item, config, token).ConfigureAwait(false);
        }

        /// <summary>Keep the item: protect its candidate, or cancel its scheduled deletion.</summary>
        public async Task<MaintainerrItemState> UnmarkAsync(BaseItem item, PluginConfiguration config, string? actingUser, CancellationToken token, Guid? actingUserId = null)
        {
            if (MediaType(item) == null) throw new MaintainerrActions.ActionException("Only movies and series can be kept.");
            var owner = await OwnerAsync(item, config, token).ConfigureAwait(false);
            var path = owner > 0 ? $"/api/v1/candidates/{owner}/protect" : $"/api/v1/scheduled-deletions/{-owner}/cancel";
            using (await ActingTokenAsync(config, actingUserId, HttpMethod.Post, path, owner > 0 ? new { reason = "Kept from Jellyfin" } : new { }, token).ConfigureAwait(false)) { }
            _logger.Info($"[Reclaimerr] {actingUser ?? "An administrator"} kept '{item.Name}'.");
            return await AfterAsync(item, config, token).ConfigureAwait(false);
        }

        /// <summary>
        /// Move the removal to the exact day <paramref name="until"/>, or later by <paramref name="days"/> (1 to 3650),
        /// or restart a candidate's timer when neither is given.
        /// </summary>
        public async Task<MaintainerrItemState> PostponeAsync(BaseItem item, int? days, DateTimeOffset? until, PluginConfiguration config, string? actingUser, CancellationToken token, Guid? actingUserId = null)
        {
            if (MediaType(item) == null) throw new MaintainerrActions.ActionException("Only movies and series can be postponed.");
            if (days is { } d && (d < 1 || d > MaxPostponeDays)) throw new MaintainerrActions.ActionException($"Days must be between 1 and {MaxPostponeDays}.");
            var owner = await OwnerAsync(item, config, token).ConfigureAwait(false);
            var fact = _leaving.Get(item.Id, config);
            var exact = until is { } u ? CheckedDate(u) : (DateTimeOffset?)null;
            var current = fact?.DeleteAt is { } cur ? DateTimeOffset.FromUnixTimeMilliseconds(cur) : (DateTimeOffset?)null;
            if (owner > 0)
            {
                // Reclaimerr only lets a candidate's deadline move later; a scheduled deletion can move either way.
                if (exact is { } early && current is { } c0 && early <= c0) throw new MaintainerrActions.ActionException("Reclaimerr only moves a cleanup candidate to a later day than its current deadline.");
                var (path, body) = exact is { } day ? ($"/api/v1/candidates/{owner}/postpone", (object)new { until = Iso(day), reason = "Postponed from Jellyfin" })
                    : days is { } n ? ($"/api/v1/candidates/{owner}/postpone", new { until = Iso((current ?? Now()).AddDays(n)), reason = "Postponed from Jellyfin" })
                    : ($"/api/v1/candidates/{owner}/reset-timer", new { reason = "Reset from Jellyfin" });
                using (await TokenAsync(config, HttpMethod.Post, path, body, token).ConfigureAwait(false)) { }
            }
            else
            {
                var to = exact ?? (days is { } n ? (current ?? Now()).AddDays(n) : Now().AddDays(MarkDays));
                using (await ActingTokenAsync(config, actingUserId, HttpMethod.Post, $"/api/v1/scheduled-deletions/{-owner}/reschedule", new { scheduled_at = Iso(to) }, token).ConfigureAwait(false)) { }
            }

            _logger.Info(exact is { } e ? $"[Reclaimerr] Postponed '{item.Name}' to {e:yyyy-MM-dd}." : days is { } p ? $"[Reclaimerr] Postponed '{item.Name}' by {p} days." : $"[Reclaimerr] Reset the removal timer of '{item.Name}'.");
            return await AfterAsync(item, config, token).ConfigureAwait(false);
        }

        /// <summary>
        /// File a Reclaimerr deletion request for an administrator to approve, as the Reclaimerr account linked to the Jellyfin user
        /// <paramref name="userId"/> (Reclaimerr's token API cannot file one for someone else). Answers <c>mine</c> or <c>other</c>
        /// instead when a request for the title is already waiting.
        /// </summary>
        public async Task<(MaintainerrItemState State, string? Existing)> RequestRemovalAsync(BaseItem item, Guid userId, string userName, string? reason, PluginConfiguration config, CancellationToken token)
        {
            var type = MediaType(item) ?? throw new MaintainerrActions.ActionException("Only movies and series can be requested for removal.");
            if (!RequestsEnabled(config)) throw new MaintainerrActions.ActionException("Removal requests are off.");
            if (_leaving.CollectionOf(item.Id, config) != null) throw new MaintainerrActions.ActionException("This item is already marked for removal.");
            var (mediaId, _) = await ResolveMediaAsync(item, type, config, token).ConfigureAwait(false);
            var who = await ReclaimerrUserAsync(config, userId, token).ConfigureAwait(false)
                ?? throw new MaintainerrActions.ActionException("Your Jellyfin account has no Reclaimerr account yet. Ask an administrator to import Jellyfin users into Reclaimerr.");
            // Already asked for (by this user or another) and still waiting: say so instead of failing on a duplicate.
            var waiting = await PendingRequestAsync(mediaId, type, userId, config, token).ConfigureAwait(false);
            if (waiting != null) return (State(item, config), waiting);
            var text = string.IsNullOrWhiteSpace(reason) ? null : reason.Trim();
            try
            {
                using (await ReclaimerrApi.SendAsUserAsync(_http, config, who, HttpMethod.Post, "/api/delete-requests", new { media_type = type, media_id = mediaId, reason = text == null || text.Length <= 500 ? text : text[..500] }, Timeout, token).ConfigureAwait(false)) { }
            }
            catch (MaintainerrHttp.MaintainerrException e) when (e.Status == 401 && RefusedForAccountOnly(e.Reason))
            {
                // Reclaimerr trusted this server and turned down the account: the sign-in's setup is not what is wrong.
                throw new MaintainerrActions.ActionException($"Reclaimerr does not accept the Reclaimerr account {who} linked to you ({e.Reason}). Ask an administrator to check that account in Reclaimerr.");
            }
            catch (MaintainerrHttp.MaintainerrException e) when (e.Status == 401)
            {
                throw new MaintainerrActions.ActionException($"Reclaimerr did not let this server sign in as {who} ({Said(e.Reason)}). An administrator can run the User audit in the plugin's Reclaimerr card to look into it: usually Reclaimerr's trusted-proxy sign-in (FORWARD_AUTH_ENABLED) is off, or this server's address is not in FORWARD_AUTH_TRUSTED_PROXIES.");
            }
            catch (MaintainerrHttp.MaintainerrException e) when (e.Status == 403)
            {
                throw new MaintainerrActions.ActionException($"The Reclaimerr account {who} may not request removals (it needs the Request permission).");
            }
            catch
            {
                // Refused for another reason (already requested, a failure, no answer): Reclaimerr may have changed, so read the lists
                // again. A refused sign-in or permission (above) changed nothing, so it keeps them: repeated clicks must not empty them.
                ForgetLists();
                throw;
            }

            ForgetLists();
            _logger.Info($"[Reclaimerr] {userName} ({who}) requested the removal of '{item.Name}'.");
            return (State(item, config), null);
        }

        /// <summary>
        /// "mine" when this user already has a pending deletion request for the whole title, "other" when someone else does,
        /// null when none (a request for one season, episode or version is another target), or when it could not be read or
        /// timed out: the request is then tried and Reclaimerr's own answer is shown.
        /// </summary>
        private async Task<string?> PendingRequestAsync(int mediaId, string type, Guid userId, PluginConfiguration config, CancellationToken token)
        {
            try
            {
                string? found = null;
                foreach (var r in Parse(await ListAllAsync(config, "/api/v1/delete-requests?status=pending", token).ConfigureAwait(false), null))
                {
                    if (r.MediaId != mediaId || r.MediaType != type || r.Status != "pending" || r.Scope is not ("movie" or "series")) continue;
                    if (r.RequesterIds?.Contains(userId) == true) return "mine";
                    found = "other";
                }

                return found;
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !token.IsCancellationRequested)
            {
                _logger.Warning($"[Reclaimerr] Could not read the pending requests ({MaintainerrHttp.Describe(ex)}).");
                return null;
            }
        }

        /// <summary>
        /// Reclaimerr's id of the movie file this action is about, or null for the whole movie. The copy is the one picked on the item
        /// page (else this item's own) and must be one Reclaimerr holds: its media source id, or, when Reclaimerr's versions come from
        /// another main media server, its file path. The whole movie is scheduled only when both sides hold exactly one copy. Anything
        /// else throws, because sending no version would schedule every copy and another version would delete the wrong one (a 4K
        /// copy Reclaimerr has not synced must not take its 1080p with it).
        /// </summary>
        private static int? VersionId(BaseItem item, string? mediaSourceId, JsonElement movie)
        {
            if (!movie.TryGetProperty("versions", out var versions) || versions.ValueKind != JsonValueKind.Array) throw Unsure();
            var held = versions.EnumerateArray().Where(v => v.ValueKind == JsonValueKind.Object && v.TryGetProperty("id", out var i) && i.TryGetInt32(out _)).ToList();
            var source = MaintainerrActions.FindVersion(item, mediaSourceId);
            var picked = string.IsNullOrWhiteSpace(mediaSourceId) ? null : mediaSourceId;
            var wanted = source?.Id ?? picked ?? item.Id.ToString("N");
            var path = source?.Path ?? (picked == null ? item.Path : null);
            int? match = null;
            if (Guid.TryParse(wanted, out var id) && id != Guid.Empty)
            {
                foreach (var v in held)
                {
                    if (v.TryGetProperty("service_media_id", out var sm) && sm.ValueKind == JsonValueKind.String && Guid.TryParse(sm.GetString(), out var smId) && smId == id) { match = v.GetProperty("id").GetInt32(); break; }
                }
            }

            if (match == null && !string.IsNullOrWhiteSpace(path))
            {
                var byPath = held.Where(v => v.TryGetProperty("path", out var p) && p.ValueKind == JsonValueKind.String && string.Equals(p.GetString(), path, StringComparison.OrdinalIgnoreCase)).ToList();
                if (byPath.Count == 1) match = byPath[0].GetProperty("id").GetInt32();
            }

            var copies = JellyfinCopies(item);
            if (match is { } found) return held.Count == 1 && copies == 1 ? null : found;
            // One copy here and one in Reclaimerr (its ids from another server): the same file, so the whole movie.
            if (held.Count == 1 && copies == 1) return null;
            throw Unsure();
        }

        /// <summary>
        /// How many copies Jellyfin holds of a movie, or null when it cannot tell (a hidden alternate): its media sources (what Reclaimerr
        /// syncs versions from, and what Jellyfin itself counts on both targets), or the alternate versions stored on the item, whichever
        /// is more. More is the safe side: it only ever demands a matching copy where a lower count would schedule the whole movie.
        /// </summary>
        private static int? JellyfinCopies(BaseItem item)
        {
            if (item is not MediaBrowser.Controller.Entities.Video video || !string.IsNullOrEmpty(video.PrimaryVersionId?.ToString())) return null;
            var stored = 1 + (video.LinkedAlternateVersions?.Length ?? 0) + (video.LocalAlternateVersions?.Length ?? 0);
            int sources;
            try { sources = video.GetMediaSources(false).Count; }
            catch { sources = 0; }
            return Math.Max(stored, sources);
        }

        private static MaintainerrActions.ActionException Unsure() => new("Could not tell which version of this movie Reclaimerr holds, so nothing was scheduled. Try again, or schedule it in Reclaimerr.");

        /// <summary>
        /// Deletion requests: every pending one plus the approved ones whose deletion failed or is held back (administrators), or the
        /// caller's own of any state (<paramref name="mine"/>, the requests whose requester is linked to <paramref name="userId"/>).
        /// Null rows, with the reason (Reclaimerr's own, such as a scope the token lacks), when they could not be read. The approved ones
        /// are extra: when only they fail, the pending ones still come back.
        /// </summary>
        public async Task<(IReadOnlyList<ReclaimerrRequestRow>? Rows, string? Error)> RequestsAsync(PluginConfiguration config, Guid userId, bool mine, CancellationToken token)
        {
            List<ReclaimerrRequestRow> all;
            try
            {
                if (mine)
                {
                    if (userId == Guid.Empty) return (Array.Empty<ReclaimerrRequestRow>(), null);
                    return (Parse(await ListAllAsync(config, "/api/v1/delete-requests", token).ConfigureAwait(false), r => r.RequesterIds?.Contains(userId) == true), null);
                }

                all = Parse(await ListAllAsync(config, "/api/v1/delete-requests?status=pending", token).ConfigureAwait(false), null);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                var reason = MaintainerrHttp.Describe(ex);
                _logger.Warning($"[Reclaimerr] Could not read the deletion requests ({reason}).");
                return (null, reason);
            }

            try
            {
                // Approved requests whose deletion failed or is held back by playback would otherwise vanish from the page: keep them in view.
                all.AddRange(Parse(await ListAllAsync(config, "/api/v1/delete-requests?status=approved", token).ConfigureAwait(false),
                    r => !string.IsNullOrEmpty(r.ExecutionError) || r.Deferred || r.ScheduleState is "failed" or "blocked"));
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !token.IsCancellationRequested)
            {
                _logger.Warning($"[Reclaimerr] Could not read the approved deletion requests ({MaintainerrHttp.Describe(ex)}); showing the waiting ones.");
            }

            return (all, null);
        }

        private readonly Dictionary<string, (DateTimeOffset At, List<JsonElement> Items)> _lists = new(StringComparer.Ordinal);
        private long _listsGeneration;
        private static readonly TimeSpan ListTtl = TimeSpan.FromSeconds(30);

        /// <summary>
        /// Every entry of a request list, saying in the log when there were more than <see cref="AllPages"/> pages. Kept for 30 seconds and
        /// shared by every caller, so users reloading the Leaving soon page do not each read Reclaimerr's whole list; anything the plugin
        /// changes in Reclaimerr forgets it (<see cref="ForgetLists"/>). A failed read is not kept, and neither is one that started before
        /// such a change finished (it could hold the request just reviewed or miss the one just filed).
        /// </summary>
        private async Task<List<JsonElement>> ListAllAsync(PluginConfiguration config, string path, CancellationToken token)
        {
            var key = ReclaimerrApi.BaseUrl(config) + "\n" + path;
            long generation;
            lock (_lists)
            {
                if (_lists.TryGetValue(key, out var kept) && Now() - kept.At < ListTtl) return kept.Items;
                generation = _listsGeneration;
            }

            var (items, complete) = await ReclaimerrApi.ListPagesAsync(_http, config, path, AllPages, Timeout, null, token).ConfigureAwait(false);
            if (!complete) _logger.Warning($"[Reclaimerr] More than {AllPages * ReclaimerrApi.PageSize} deletion requests; only the newest are shown.");
            lock (_lists)
            {
                if (_listsGeneration == generation) _lists[key] = (Now(), items);
            }

            return items;
        }

        /// <summary>Forget the kept request lists (a request was filed, reviewed or rescheduled from here, or tried and refused).</summary>
        private void ForgetLists()
        {
            lock (_lists)
            {
                _lists.Clear();
                _listsGeneration++;
            }
        }

        /// <summary>Reclaimerr's deletion requests (<c>DeleteRequestResponse</c>) as rows, those <paramref name="keep"/> accepts.</summary>
        internal static List<ReclaimerrRequestRow> Parse(IEnumerable<JsonElement> list, Func<ReclaimerrRequestRow, bool>? keep)
        {
            var rows = new List<ReclaimerrRequestRow>();
            static string? Str(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            static int? Num(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) ? n : null;
            static IReadOnlyList<Guid> Ids(JsonElement e, string name, string idName) => e.TryGetProperty(name, out var v) ? ReclaimerrApi.JellyfinIds(v, idName) : Array.Empty<Guid>();
            foreach (var r in list)
            {
                if (r.ValueKind != JsonValueKind.Object || Num(r, "id") is not { } n) continue;
                long? size = r.TryGetProperty("version_size", out var vs) && vs.ValueKind == JsonValueKind.Number && vs.TryGetInt64(out var vsz) ? vsz : null;
                var deferred = r.TryGetProperty("playback_deferral", out var pd) && pd.ValueKind == JsonValueKind.Object;
                var row = new ReclaimerrRequestRow(n, Str(r, "media_title") ?? "?", Num(r, "media_year"), Str(r, "media_type") ?? "movie", Str(r, "requested_by_username"), Str(r, "reason"), Str(r, "status") ?? "pending", Str(r, "created_at"), Str(r, "reviewed_by_username") ?? Str(r, "reviewed_by_api_token_name"),
                    Num(r, "media_id") ?? 0, Str(r, "poster_url"),
                    Str(r, "target_scope") ?? (Str(r, "media_type") == "series" ? "series" : "movie"), Num(r, "season_number"), Num(r, "episode_number"), Str(r, "version_resolution"), size,
                    Str(r, "admin_notes"), Str(r, "execution_error"), deferred && string.IsNullOrEmpty(Str(r, "executed_at")), Str(r, "scheduled_at"), Str(r, "schedule_state"),
                    Ids(r, "media_server_items", "source_item_id"), Ids(r, "requested_by_media_identities", "source_user_id"));
                if (keep == null || keep(row)) rows.Add(row);
            }

            return rows;
        }

        /// <summary>When an approved request is deleted: with Reclaimerr's own grace period (its setting; none by default), right away, or on a day.</summary>
        public enum ApprovalTiming { GracePeriod, Now, OnDate }

        /// <summary>
        /// The grace period (days) Reclaimerr applies to an approval that names no day (its Settings, General: Approved Deletion
        /// Requests; 0 when none), read now (never kept: it may change, or the address may). Null when it cannot be read.
        /// </summary>
        public async Task<int?> GracePeriodDaysAsync(PluginConfiguration config, CancellationToken token)
        {
            try
            {
                using var doc = await TokenAsync(config, HttpMethod.Get, "/api/v1/delete-requests/approval-options", null, token).ConfigureAwait(false);
                return doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("delete_request_grace_period_days", out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) && n >= 0 ? n : null;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.Warning($"[Reclaimerr] Could not read the deletion request grace period ({MaintainerrHttp.Describe(ex)}).");
                return null;
            }
        }

        /// <summary>
        /// Approve or deny a pending deletion request. Reclaimerr records the token as the reviewer, so the administrator who clicked is
        /// named in the note. Approving follows <paramref name="timing"/>: <see cref="ApprovalTiming.GracePeriod"/> (Reclaimerr's delay,
        /// none by default, so the same as now), <see cref="ApprovalTiming.Now"/>, or <see cref="ApprovalTiming.OnDate"/> on <paramref name="at"/>.
        /// With <paramref name="shownGraceDays"/> (what the administrator was told the grace period is), the grace period is read again first and
        /// nothing is approved when it differs or cannot be read: a period that became 0 would delete at once instead of on the day shown.
        /// </summary>
        public async Task ReviewRequestAsync(int requestId, bool approve, string? note, string? actingUser, PluginConfiguration config, CancellationToken token, ApprovalTiming timing = ApprovalTiming.GracePeriod, DateTimeOffset? at = null, int? shownGraceDays = null, Guid? actingUserId = null)
        {
            if (requestId <= 0) throw new MaintainerrActions.ActionException("Unknown request.");
            if (approve && timing == ApprovalTiming.GracePeriod && shownGraceDays is { } shown)
            {
                var now = await GracePeriodDaysAsync(config, token).ConfigureAwait(false);
                if (now == null) throw new MaintainerrActions.ActionException("Could not check Reclaimerr's grace period, so nothing was approved. Try again.");
                if (now != shown) throw new MaintainerrActions.ActionException($"Reclaimerr's grace period is now {now} day(s), not {shown}, so nothing was approved. Look again before approving.");
            }
            var text = string.IsNullOrWhiteSpace(note) ? null : note.Trim();
            if (!string.IsNullOrWhiteSpace(actingUser))
            {
                var by = $"{(approve ? "Approved" : "Denied")} by {actingUser.Trim()} in Jellyfin";
                text = text == null ? by : $"{text} ({by})";
            }

            // Omitting scheduled_at means the grace period; null means now; a day schedules it.
            string? when = approve && timing == ApprovalTiming.OnDate ? Iso(CheckedDate(at ?? throw new MaintainerrActions.ActionException("Pick the day to delete it."))) : null;
            object body = !approve || timing == ApprovalTiming.GracePeriod ? new { admin_notes = text } : new { admin_notes = text, scheduled_at = when };
            try
            {
                using (await ActingTokenAsync(config, actingUserId, HttpMethod.Post, $"/api/v1/delete-requests/{requestId}/{(approve ? "approve" : "deny")}", body, token).ConfigureAwait(false)) { }
            }
            finally
            {
                // Refused too (say, already reviewed in Reclaimerr): the kept list is what showed the card, so read it again.
                ForgetLists();
            }
            _logger.Info($"[Reclaimerr] {actingUser ?? "An administrator"} {(approve ? "approved" : "denied")} deletion request {requestId}{(approve && timing == ApprovalTiming.OnDate ? $" for {at:yyyy-MM-dd}" : string.Empty)}.");
            // An approval on a day (or after a grace period) puts the title on the Leaving soon list and its tags: read that now, like Mark, Keep and Postpone do.
            if (approve) await RefreshAfterAsync(config, token).ConfigureAwait(false);
        }

        /// <summary>Permissions an administrator may hand to the accounts imported for Jellyfin users (never <c>manage_users</c>).</summary>
        public static readonly string[] GrantablePermissions = { "request", "auto_approve", "manage_requests", "manage_protection", "manage_reclaim" };
        /// <summary>Reclaimerr pages an account can be given.</summary>
        public static readonly string[] GrantablePages = { "dashboard", "movies", "series", "requests", "protected", "candidates", "duplicates", "calendar", "storage", "history", "settings" };

        /// <summary>
        /// Result of <see cref="ImportUsersAsync"/>, by Jellyfin user name: the accounts created, the users already linked, the ones whose
        /// match to an existing Reclaimerr account needs an administrator in Reclaimerr, and the ones that could not be imported (with why).
        /// </summary>
        public sealed record ImportResult(List<string> Created, int AlreadyLinked, List<string> NeedsReview, List<string> Skipped);

        /// <summary>
        /// Import this server's users into Reclaimerr (its <c>/api/v1/users/import-from-media-server</c>): every Jellyfin user without a
        /// Reclaimerr account gets one (User role, the permissions and pages given), linked to them, so their requests carry their own
        /// name. The Reclaimerr media server that is this Jellyfin is the one whose users are this server's users. Users Reclaimerr
        /// would match to an existing account are left for an administrator to confirm in Reclaimerr: linking a person to someone
        /// else's account by a shared name is not something to guess.
        /// </summary>
        public async Task<ImportResult> ImportUsersAsync(PluginConfiguration config, IReadOnlyDictionary<Guid, string> jellyfinUsers, IEnumerable<string> permissions, IEnumerable<string> pages, CancellationToken token)
        {
            var perms = permissions.Where(p => GrantablePermissions.Contains(p)).Distinct().ToList();
            var allowed = pages.Where(p => GrantablePages.Contains(p)).Distinct().ToList();
            if (allowed.Count == 0) throw new MaintainerrActions.ActionException("Pick at least one page.");

            // The Jellyfin servers Reclaimerr knows; the one that is this server is the one listing this server's user ids.
            // The preview is asked with the access the new accounts get: Reclaimerr's revisions cover it, so the import matches it.
            object Access(int server) => new { service_config_id = server, role = "user", permissions = perms, use_default_page_access = false, allowed_pages = allowed };
            var servers = new List<int>();
            using (var doc = await TokenAsync(config, HttpMethod.Get, "/api/v1/users/import-from-media-server/providers", null, token).ConfigureAwait(false))
            {
                if (doc.RootElement.ValueKind == JsonValueKind.Array)
                {
                    foreach (var p in doc.RootElement.EnumerateArray())
                    {
                        if (p.ValueKind == JsonValueKind.Object && p.TryGetProperty("service_type", out var t) && t.ValueKind == JsonValueKind.String && string.Equals(t.GetString(), "jellyfin", StringComparison.OrdinalIgnoreCase)
                            && p.TryGetProperty("service_config_id", out var id) && id.TryGetInt32(out var n)) servers.Add(n);
                    }
                }
            }

            (int Server, List<JsonElement> Rows)? best = null;
            var bestOverlap = 0;
            var failed = new List<string>();
            foreach (var server in servers)
            {
                // Another Jellyfin server Reclaimerr knows may be down: that only matters when this one is not found.
                try
                {
                    using var preview = await TokenAsync(config, HttpMethod.Post, "/api/v1/users/import-from-media-server?preview=true", Access(server), token).ConfigureAwait(false);
                    var rows = ImportRows(preview.RootElement);
                    var overlap = rows.Count(r => RowUser(r) is { } u && jellyfinUsers.ContainsKey(u));
                    if (overlap > bestOverlap) (best, bestOverlap) = ((server, rows), overlap);
                }
                catch (Exception ex) when (ex is not OperationCanceledException || !token.IsCancellationRequested)
                {
                    failed.Add(MaintainerrHttp.Describe(ex));
                }
            }

            if (best is not { } chosen)
            {
                throw new MaintainerrActions.ActionException(failed.Count == 0
                    ? "Reclaimerr has no Jellyfin server with this server's users. Add this server in Reclaimerr (Settings, Media servers) first."
                    : $"Reclaimerr could not list the users of {failed.Count} of its Jellyfin servers ({string.Join("; ", failed.Distinct())}), and none it could list is this one.");
            }

            var linked = await ReadIdentitiesAsync(config, includeInactive: true, token).ConfigureAwait(false);
            var result = new ImportResult(new(), 0, new(), new());
            var alreadyLinked = 0;
            var selection = new List<string>();
            var revisions = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var row in chosen.Rows)
            {
                if (RowUser(row) is not { } user || !jellyfinUsers.TryGetValue(user, out var name)) continue;
                if (linked.ContainsKey(user)) { alreadyLinked++; continue; }
                var status = row.TryGetProperty("status", out var s) && s.ValueKind == JsonValueKind.String ? s.GetString() : null;
                var message = row.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String ? m.GetString() : null;
                switch (status)
                {
                    case "ready_to_create":
                        var id = row.GetProperty("source_user_id").GetString()!;
                        selection.Add(id);
                        if (row.TryGetProperty("revision", out var rev) && rev.ValueKind == JsonValueKind.String && rev.GetString() is { Length: > 0 } revision) revisions[id] = revision;
                        break;
                    case "ready_to_link" or "needs_review":
                        result.NeedsReview.Add(name);
                        break;
                    default:
                        result.Skipped.Add(string.IsNullOrWhiteSpace(message) ? name : $"{name}: {message}");
                        break;
                }
            }

            if (selection.Count > 0)
            {
                var body = new { service_config_id = chosen.Server, source_user_ids = selection, role = "user", permissions = perms, use_default_page_access = false, allowed_pages = allowed, expected_revisions = revisions };
                // The same access as the preview: Reclaimerr refuses (409) when anything its revisions cover changed since.
                using var done = await TokenAsync(config, HttpMethod.Post, "/api/v1/users/import-from-media-server?preview=false", body, token).ConfigureAwait(false);
                foreach (var row in ImportRows(done.RootElement))
                {
                    if (RowUser(row) is not { } user || !jellyfinUsers.TryGetValue(user, out var name) || !selection.Contains(row.GetProperty("source_user_id").GetString()!)) continue;
                    var status = row.TryGetProperty("status", out var s) && s.ValueKind == JsonValueKind.String ? s.GetString() : null;
                    var message = row.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String ? m.GetString() : null;
                    if (status == "created") result.Created.Add(name);
                    else result.Skipped.Add(string.IsNullOrWhiteSpace(message) ? name : $"{name}: {message}");
                }
            }

            _logger.Info($"[Reclaimerr] Imported {result.Created.Count} Jellyfin user(s) into Reclaimerr ({alreadyLinked} already linked, {result.NeedsReview.Count} to review in Reclaimerr, {result.Skipped.Count} not imported).");
            return result with { AlreadyLinked = alreadyLinked };
        }

        private static List<JsonElement> ImportRows(JsonElement root)
            => root.ValueKind == JsonValueKind.Object && root.TryGetProperty("rows", out var rows) && rows.ValueKind == JsonValueKind.Array
                ? rows.EnumerateArray().Where(r => r.ValueKind == JsonValueKind.Object).Select(r => r.Clone()).ToList()
                : new List<JsonElement>();

        private static Guid? RowUser(JsonElement row)
            => row.TryGetProperty("source_user_id", out var id) && id.ValueKind == JsonValueKind.String && Guid.TryParse(id.GetString(), out var g) && g != Guid.Empty ? g : null;

        /// <summary>
        /// The username of the active Reclaimerr account linked to the Jellyfin user <paramref name="userId"/> (Reclaimerr links one when the
        /// person is imported, or signs in to Reclaimerr with their Jellyfin login), or null when none is. Read now with the token, never
        /// kept: the name is about to be sent as a sign-in, so an unlinked account, a disabled one or another Reclaimerr's must not be used.
        /// </summary>
        internal async Task<string?> ReclaimerrUserAsync(PluginConfiguration config, Guid userId, CancellationToken token)
            => userId == Guid.Empty ? null : (await ReadIdentitiesAsync(config, includeInactive: false, token).ConfigureAwait(false)).TryGetValue(userId, out var name) ? name : null;

        /// <summary>
        /// Jellyfin user id to the username of the Reclaimerr account linked to it (<c>/api/v1/users</c>, its <c>media_identities</c>), active
        /// accounts only unless <paramref name="includeInactive"/>. A Jellyfin id linked to two accounts (the same server added twice) is left out.
        /// </summary>
        private async Task<Dictionary<Guid, string>> ReadIdentitiesAsync(PluginConfiguration config, bool includeInactive, CancellationToken token)
        {
            var map = new Dictionary<Guid, string>();
            foreach (var (id, accounts) in await ReadAccountsAsync(config, token).ConfigureAwait(false))
            {
                var usable = accounts.Where(a => includeInactive || a.Active).Select(a => a.Username).Distinct(StringComparer.Ordinal).ToList();
                if (usable.Count == 1) map[id] = usable[0];
            }

            return map;
        }

        /// <summary>
        /// The token scopes the integration uses: each with its read scope (a manage scope grants it; null when there is none), what
        /// goes without either, and what goes with the read scope alone.
        /// </summary>
        internal static readonly (string Scope, string? Read, string Without, string ReadOnly)[] RequiredScopes =
        {
            ("candidates:manage", "candidates:read", "Leaving soon cannot read Reclaimerr, and Keep and Postpone cannot act on cleanup candidates", "Keep and Postpone cannot act on cleanup candidates"),
            ("scheduled_deletions:manage", "scheduled_deletions:read", "Mark for removal, and Keep and Postpone on a scheduled deletion, are refused", "Mark for removal, and Keep and Postpone on a scheduled deletion, are refused"),
            ("delete_requests:manage", "delete_requests:read", "removal requests cannot be listed, approved or denied", "removal requests cannot be approved or denied"),
            ("media:read", null, "Mark for removal and Request removal cannot find the title", string.Empty),
            ("users:manage", "users:read", "Request removal, Import Jellyfin users and this audit cannot read Reclaimerr's accounts", "Import Jellyfin users is refused"),
        };

        /// <summary>
        /// One Jellyfin user in the audit: the Reclaimerr account linked to them (null when none), what stops them, and whether everything
        /// that applies to them was checked (false when the sign-in check was cut short for everyone; see the setup issues).
        /// </summary>
        public sealed record AuditUser(
            [property: JsonPropertyName("jellyfinUsername")] string JellyfinUsername,
            [property: JsonPropertyName("jellyfinUserId")] string JellyfinUserId,
            [property: JsonPropertyName("admin")] bool Admin,
            [property: JsonPropertyName("linked")] bool Linked,
            [property: JsonPropertyName("reclaimerrUsername")] string? ReclaimerrUsername,
            [property: JsonPropertyName("issues")] List<string> Issues,
            [property: JsonPropertyName("checked")] bool Checked = true);

        /// <summary>The audit: the version Reclaimerr reports, problems with the setup as a whole (token scopes, the trusted-proxy sign-in), and each user.</summary>
        public sealed record AuditResult(
            [property: JsonPropertyName("version")] string? Version,
            [property: JsonPropertyName("requestsEnabled")] bool RequestsEnabled,
            [property: JsonPropertyName("issues")] List<string> Issues,
            [property: JsonPropertyName("users")] List<AuditUser> Users);

        /// <summary>
        /// Check every Jellyfin user against Reclaimerr, read-only: whether a Reclaimerr account is linked to them (and only one, and active),
        /// and, with removal requests on, whether Reclaimerr's trusted-proxy sign-in accepts that account (<c>GET /api/account/me</c> as them,
        /// which writes nothing) and whether it may request. Administrators mark instead of requesting, so nothing about them is an issue. Also
        /// reports the token scopes the integration uses that the token lacks. A refusal that does not say whether it is about the
        /// account or about this server is settled by asking the server once (<see cref="SignInTrustedAsync"/>): when Reclaimerr
        /// refuses this server whoever is named (the feature off, another header, this server not trusted), that is a setup issue said
        /// once, naming no user, and the remaining users are not tried; otherwise the refusal is that user's issue and the rest are
        /// still checked. An answer that is not the account asked for is never read as that account's permissions.
        /// </summary>
        public async Task<AuditResult> AuditUsersAsync(PluginConfiguration config, IReadOnlyList<(Guid Id, string Name, bool Admin)> jellyfinUsers, CancellationToken token)
        {
            var requests = RequestsEnabled(config);
            var result = new AuditResult(null, requests, new List<string>(), new List<AuditUser>());
            // Request removal lives in the item menu, so it is off while the item-menu actions are, whatever its own switch says.
            if (!requests && config.ReclaimerrUserRequests && !Enabled(config))
            {
                result.Issues.Add("Let users request removals is on, but Mark, keep and postpone from the item menu is off, and Request removal is in that menu: turn it on (Leaving soon card).");
            }

            // The scopes the token has (GET /api/v1 lists them); a manage scope grants its read scope.
            using (var discovery = await TokenAsync(config, HttpMethod.Get, "/api/v1", null, token).ConfigureAwait(false))
            {
                var granted = new HashSet<string>(StringComparer.Ordinal);
                if (discovery.RootElement.ValueKind == JsonValueKind.Object && discovery.RootElement.TryGetProperty("granted_scopes", out var scopes) && scopes.ValueKind == JsonValueKind.Array)
                {
                    foreach (var scope in scopes.EnumerateArray())
                    {
                        if (scope.ValueKind == JsonValueKind.String && scope.GetString() is { } name) granted.Add(name);
                    }
                }

                foreach (var (scope, read, without, readOnly) in RequiredScopes)
                {
                    if (granted.Contains(scope)) continue;
                    result.Issues.Add($"The API token lacks {scope}: {(read != null && granted.Contains(read) ? readOnly : without)}.");
                }
            }

            result = result with { Version = ReclaimerrApi.ReportedVersion(config) };
            Dictionary<Guid, List<(string Username, bool Active)>> accounts;
            try
            {
                accounts = await ReadAccountsAsync(config, token).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                result.Issues.Add($"Reclaimerr's users could not be read ({MaintainerrHttp.Describe(ex)}), so no user was checked.");
                return result;
            }

            string? silent = null;
            // Whether Reclaimerr takes this server's trusted-proxy sign-in at all: null until an answer shows it. True once it signs an
            // account in or turns one down by name (it does either only after trusting this server). False once an account was refused
            // without saying why and asking about the server itself (once per audit) did not show it is trusted: the check stops there.
            // What the setup issue then says is kept: the reasons given for refusing the account and the name asked about the server
            // with, whether both were Reclaimerr's plain "Not authenticated" (only then is it known to be Reclaimerr refusing every
            // name), and why asking about the server failed, when it did.
            bool? trusted = null;
            string? refusedReason = null;
            string? serverReason = null;
            var refusedPlainly = false;
            string? askingFailed = null;
            var askingUnanswered = false;
            foreach (var (id, name, admin) in jellyfinUsers.OrderBy(u => u.Name, StringComparer.OrdinalIgnoreCase))
            {
                var issues = new List<string>();
                // The same rule as filing a request: exactly one active linked account.
                var mine = accounts.TryGetValue(id, out var found) ? found : new List<(string Username, bool Active)>();
                var linked = mine.Select(a => a.Username).Distinct(StringComparer.Ordinal).ToList();
                var active = mine.Where(a => a.Active).Select(a => a.Username).Distinct(StringComparer.Ordinal).ToList();
                string? account = active.Count == 1 ? active[0] : linked.Count == 1 ? linked[0] : null;
                var done = true;
                if (admin)
                {
                    // Administrators mark, keep and approve with the token: their link is shown, never an issue.
                }
                else if (linked.Count == 0)
                {
                    issues.Add("No Reclaimerr account is linked to this user: run Import Jellyfin users, or have them sign in to Reclaimerr with Jellyfin once.");
                }
                else if (active.Count > 1)
                {
                    issues.Add($"Linked to several active Reclaimerr accounts ({string.Join(", ", active)}): requests are refused until only one is linked.");
                }
                else if (active.Count == 0)
                {
                    issues.Add($"The linked Reclaimerr account {string.Join(", ", linked)} is disabled.");
                }
                else if (requests && (trusted == false || silent != null))
                {
                    done = false;
                }
                else if (requests)
                {
                    // A refusal that does not say whether it is about this account or about this server (Reclaimerr's reason, or none).
                    var unclear = false;
                    string? unclearReason = null;
                    try
                    {
                        using var me = await ReclaimerrApi.SendAsUserAsync(_http, config, account!, HttpMethod.Get, "/api/account/me", null, Timeout, token).ConfigureAwait(false);
                        var root = me.RootElement;
                        var signedIn = root.ValueKind == JsonValueKind.Object && root.TryGetProperty("username", out var u) && u.ValueKind == JsonValueKind.String ? u.GetString() : null;
                        if (string.IsNullOrWhiteSpace(signedIn))
                        {
                            // An empty answer, or something else's: unknown, which is not the same as lacking the permission.
                            issues.Add($"Could not check the Reclaimerr account {account} (Reclaimerr's answer was not an account).");
                        }
                        else if (!string.Equals(signedIn, account, StringComparison.Ordinal))
                        {
                            // Reclaimerr trims the name it is sent, so a stored name with stray spaces can resolve to another account.
                            trusted = true;
                            issues.Add($"Reclaimerr signed in as {signedIn} instead of the linked account {account}: a request of theirs that Reclaimerr accepts would be filed as {signedIn}.");
                        }
                        else
                        {
                            trusted = true;
                            var role = root.TryGetProperty("role", out var r) && r.ValueKind == JsonValueKind.String ? r.GetString() : null;
                            var listed = root.TryGetProperty("permissions", out var p) && p.ValueKind == JsonValueKind.Array;
                            var canRequest = role == "admin" || (listed && p.EnumerateArray().Any(x => x.ValueKind == JsonValueKind.String && x.GetString() == "request"));
                            // An answer without the permission list says nothing about the permission: unknown, not "lacks it".
                            if (!canRequest) issues.Add(listed ? $"The Reclaimerr account {account} lacks the Request permission, so Request removal is refused." : $"Could not check the Reclaimerr account {account} (Reclaimerr's answer did not list its permissions).");
                        }
                    }
                    catch (MaintainerrHttp.MaintainerrException e) when (e.Status == 401 && RefusedForAccountOnly(e.Reason))
                    {
                        // Reclaimerr trusted this server and turned down the name: only this user is stopped, so the others are still checked.
                        trusted = true;
                        issues.Add($"Reclaimerr's trusted-proxy sign-in refused the account {account} ({e.Reason}), so Request removal is refused for them.");
                    }
                    catch (MaintainerrHttp.MaintainerrException e) when (e.Status == 401)
                    {
                        unclear = true;
                        unclearReason = e.Reason;
                    }
                    catch (OperationCanceledException) when (!token.IsCancellationRequested)
                    {
                        // Reclaimerr stopped answering: waiting out the timeout for every other user would hold the page for minutes.
                        silent = account;
                        done = false;
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        issues.Add($"Could not check the Reclaimerr account {account} ({MaintainerrHttp.Describe(ex)}).");
                    }

                    if (unclear && trusted == null)
                    {
                        // Ask about the server itself, once per audit: what one account was answered cannot tell the two apart.
                        try
                        {
                            var (taken, said) = await SignInTrustedAsync(config, token).ConfigureAwait(false);
                            trusted = taken;
                            serverReason = said;
                            refusedPlainly = !taken && string.Equals(said, PlainRefusal, StringComparison.Ordinal) && string.Equals(unclearReason, PlainRefusal, StringComparison.Ordinal);
                        }
                        catch (OperationCanceledException) when (!token.IsCancellationRequested)
                        {
                            // Reclaimerr answered the account and then went quiet on the question about the server: the check stops, and
                            // what is said is that, not that the account got no answer.
                            silent = account;
                            askingUnanswered = true;
                            refusedReason = unclearReason;
                            done = false;
                        }
                        catch (Exception ex) when (ex is not OperationCanceledException)
                        {
                            // The question failed, so nothing shows the server is trusted: the check stops here, as it did before there
                            // was a question to ask, and the setup issue says what was and was not found out.
                            trusted = false;
                            askingFailed = MaintainerrHttp.Describe(ex);
                        }
                    }

                    if (unclear && trusted == true)
                    {
                        // Reclaimerr took this server's sign-in in this audit, so the refusal is about this account (with its
                        // FORWARD_AUTH_ALLOW_LOCAL_FALLBACK on, a name it does not know gets its plain "Not authenticated"). Said as
                        // the two things that were seen: what Reclaimerr does a moment later is not known.
                        issues.Add($"Reclaimerr showed in this audit that it takes this server's sign-in, but it refused the account {account} ({Said(unclearReason)}), so Request removal is refused for them.");
                    }
                    else if (unclear && trusted == false)
                    {
                        // Not shown to be about this account: said once under Setup, and nobody else is tried.
                        refusedReason = unclearReason;
                        done = false;
                    }
                }

                result.Users.Add(new AuditUser(name, id.ToString("N"), admin, linked.Count > 0, account, issues, done));
            }

            if (silent != null)
            {
                result.Issues.Insert(0, askingUnanswered
                    ? $"Reclaimerr refused the trusted-proxy sign-in for an account ({Said(refusedReason)}) and then did not answer when asked whether it takes this server's sign-in at all, so no user's Request permission was checked. Run the audit again."
                    : $"Reclaimerr did not answer when checking {silent}, so the remaining users' sign-in and permissions were not checked. Run the audit again.");
            }

            if (trusted == false)
            {
                result.Issues.Insert(0, SignInRefused(refusedReason, serverReason, refusedPlainly, askingFailed, config.ReclaimerrUserHeader.Trim()));
            }

            return result;
        }

        /// <summary>Reclaimerr's reasons for a <c>401</c> that turns down the one account named, after it has trusted this server.</summary>
        private static readonly string[] AccountOnlyRefusals = { "Trusted proxy user is not configured", "Trusted proxy supplied an invalid username" };

        /// <summary>
        /// Whether a <c>401</c> from Reclaimerr's trusted-proxy sign-in turned down the one account named, not this server. Reclaimerr
        /// gives these reasons only after it has accepted the address and read the header; with the feature off, another header or an
        /// untrusted address it answers "Not authenticated" whoever is named. Any other reason, or none, counts as refusing the server.
        /// </summary>
        /// <param name="reason">Reclaimerr's own reason for the refusal (its <c>detail</c>), or null when it gave none.</param>
        /// <returns>True when only the named account was refused.</returns>
        internal static bool RefusedForAccountOnly(string? reason)
            => reason != null && Array.IndexOf(AccountOnlyRefusals, reason) >= 0;

        /// <summary>
        /// A name no Reclaimerr account can have (it is longer than Reclaimerr's 32 characters), sent to ask about this server
        /// instead of about an account. It says what it is, for anyone who meets it in a log.
        /// </summary>
        internal const string NoAccountName = "jellyfin-enhanced-sign-in-check-not-an-account";

        /// <summary>Reclaimerr's answer to a request it does not sign in at all: the sign-in is off, the header is not there, or the address is not trusted.</summary>
        private const string PlainRefusal = "Not authenticated";

        /// <summary>
        /// Whether Reclaimerr takes this server's trusted-proxy sign-in at all, asked with <see cref="NoAccountName"/>
        /// (<c>GET /api/account/me</c>, which writes nothing). Reclaimerr turns that name down as a name ("Trusted proxy supplied an
        /// invalid username") only after it has trusted the address and read the header, whichever accounts exist and whatever its
        /// local fallback is set to; any other <c>401</c> is given to every name alike, so this server is being refused.
        /// </summary>
        /// <param name="config">The configuration (address and user header).</param>
        /// <param name="token">The caller's cancellation.</param>
        /// <returns>Whether Reclaimerr trusts this server's sign-in (false: it refuses it whoever is named), and the reason it gave, or null.</returns>
        /// <exception cref="OperationCanceledException">Reclaimerr did not answer in time.</exception>
        /// <exception cref="MaintainerrHttp.MaintainerrException">Reclaimerr answered with another failure status: nothing is known.</exception>
        /// <exception cref="FormatException">Something signed the name in: that is not Reclaimerr's sign-in answering.</exception>
        private async Task<(bool Trusted, string? Reason)> SignInTrustedAsync(PluginConfiguration config, CancellationToken token)
        {
            try
            {
                using (await ReclaimerrApi.SendAsUserAsync(_http, config, NoAccountName, HttpMethod.Get, "/api/account/me", null, Timeout, token).ConfigureAwait(false)) { }
            }
            catch (MaintainerrHttp.MaintainerrException e) when (e.Status == 401)
            {
                return (RefusedForAccountOnly(e.Reason), e.Reason);
            }

            throw new FormatException("A name that is no account was signed in.");
        }

        /// <summary>A refusal as the audit quotes it: the status, with Reclaimerr's own reason when it gave one.</summary>
        /// <param name="reason">Reclaimerr's own reason for the refusal, or null when it gave none.</param>
        /// <returns>"HTTP 401", or "HTTP 401: " and the reason.</returns>
        private static string Said(string? reason) => string.IsNullOrWhiteSpace(reason) ? "HTTP 401" : $"HTTP 401: {reason}";

        /// <summary>
        /// The setup issue for an account's refusal that asking about the server (<see cref="SignInTrustedAsync"/>) did not show to be
        /// about the account. It names no user and says what was seen. When the account and <see cref="NoAccountName"/> both got
        /// Reclaimerr's plain "Not authenticated", that is how Reclaimerr answers every name while it does not take this server's
        /// sign-in: the issue says so, what to set, and what its log line about an untrusted address tells (the line's absence proves
        /// nothing: a proxy may drop the header, or the log may not show warnings). With another reason, none, or a question that
        /// failed (something in between may be answering, or hiding Reclaimerr's answer), it says what to check and no more.
        /// </summary>
        /// <param name="reason">The reason given for refusing the account, or null when none was.</param>
        /// <param name="serverReason">The reason given for refusing the name no account can have, or null when none was.</param>
        /// <param name="plainly">Whether the account and the name no account can have both got Reclaimerr's plain "Not authenticated".</param>
        /// <param name="askingFailed">Why asking about the server failed, or null when it was answered.</param>
        /// <param name="header">The user header the plugin sends.</param>
        /// <returns>The issue text for the audit's setup list.</returns>
        private static string SignInRefused(string? reason, string? serverReason, bool plainly, string? askingFailed, string header)
        {
            if (plainly)
            {
                return $"Reclaimerr answered an account and a name no account can have the same way ({Said(reason)}). It does that for every name while its trusted-proxy sign-in is off, reads another header or does not trust this server's address, "
                    + "so no user's Request permission was checked and Request removal fails for everyone, whatever their account. "
                    + $"On Reclaimerr, set FORWARD_AUTH_ENABLED=true, FORWARD_AUTH_USER_HEADER={header} (the User header here) and FORWARD_AUTH_TRUSTED_PROXIES to the address this server's requests arrive from, then restart it. "
                    + "If its log has \"authentication header from untrusted peer\", the address after it is the one to trust; if not, check that the sign-in is on, the header name, and that nothing in between drops the header.";
            }

            // Each answer is quoted as it came: together only when they were the same.
            var seen = askingFailed != null
                ? $"The trusted-proxy sign-in was refused for an account ({Said(reason)}), and asking Reclaimerr whether it takes this server's sign-in at all failed ({askingFailed})"
                : string.Equals(reason, serverReason, StringComparison.Ordinal)
                    ? $"The trusted-proxy sign-in was refused for an account and for a name no account can have alike ({Said(reason)})"
                    : $"The trusted-proxy sign-in was refused for an account ({Said(reason)}) and for a name no account can have ({Said(serverReason)})";
            // A question that failed may work the next time: say so before what to look at.
            return seen + ", so no user's Request permission was checked. "
                + (askingFailed != null ? "Run the audit again; if that keeps failing, check " : "Check ")
                + $"FORWARD_AUTH_ENABLED, FORWARD_AUTH_USER_HEADER (the User header here is {header}) and FORWARD_AUTH_TRUSTED_PROXIES on Reclaimerr, its log, and that anything between this server and Reclaimerr passes the header and Reclaimerr's answers through.";
        }

        /// <summary>Jellyfin user id to every Reclaimerr account linked to it (username, active), from <c>/api/v1/users</c>.</summary>
        private async Task<Dictionary<Guid, List<(string Username, bool Active)>>> ReadAccountsAsync(PluginConfiguration config, CancellationToken token)
        {
            const int limit = 1000;
            var map = new Dictionary<Guid, List<(string, bool)>>();
            for (var offset = 0; offset < 20 * limit; offset += limit)
            {
                using var doc = await TokenAsync(config, HttpMethod.Get, $"/api/v1/users?limit={limit}&offset={offset.ToString(CultureInfo.InvariantCulture)}", null, token).ConfigureAwait(false);
                if (doc.RootElement.ValueKind != JsonValueKind.Array) throw new FormatException("Not a Reclaimerr user list.");
                foreach (var u in doc.RootElement.EnumerateArray())
                {
                    if (u.ValueKind != JsonValueKind.Object || !u.TryGetProperty("username", out var name) || name.ValueKind != JsonValueKind.String || name.GetString() is not { Length: > 0 } username) continue;
                    var active = u.TryGetProperty("is_active", out var a) && a.ValueKind == JsonValueKind.True;
                    if (!u.TryGetProperty("media_identities", out var identities)) continue;
                    foreach (var id in ReclaimerrApi.JellyfinIds(identities, "source_user_id"))
                    {
                        if (!map.TryGetValue(id, out var list)) map[id] = list = new List<(string, bool)>();
                        list.Add((username, active));
                    }
                }

                if (doc.RootElement.GetArrayLength() < limit) break;
            }

            return map;
        }

        private static string Iso(DateTimeOffset at) => at.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);

        /// <summary>The id governing the item (positive: candidate, negative: scheduled deletion); a fresh read when the last one lacks it.</summary>
        private async Task<int> OwnerAsync(BaseItem item, PluginConfiguration config, CancellationToken token)
        {
            var known = _leaving.CollectionOf(item.Id, config);
            if (known == null)
            {
                await _leaving.RefreshAsync(config, force: true, token).ConfigureAwait(false);
                known = _leaving.CollectionOf(item.Id, config);
            }

            return known ?? throw new MaintainerrActions.ActionException("This item is not marked for removal.");
        }

        /// <summary>
        /// Reclaimerr's own id for the title (with its answer, for a movie's versions), by its TMDB id. When several of Reclaimerr's titles
        /// share that id, the movie holding this item (by media server id) is the one; with none of them provably this item, it refuses.
        /// </summary>
        private async Task<(int Id, JsonElement Media)> ResolveMediaAsync(BaseItem item, string type, PluginConfiguration config, CancellationToken token)
        {
            var tmdb = item.GetProviderId(MetadataProvider.Tmdb);
            if (string.IsNullOrWhiteSpace(tmdb)) throw new MaintainerrActions.ActionException("This item has no TMDB id, so Reclaimerr cannot match it.");
            using var doc = await TokenAsync(config, HttpMethod.Get, $"/api/v1/{(type == "movie" ? "movies" : "series")}?tmdb_id={Uri.EscapeDataString(tmdb)}&per_page=5", null, token).ConfigureAwait(false);
            var found = new List<(int, JsonElement)>();
            if (doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array)
            {
                foreach (var m in items.EnumerateArray())
                {
                    if (m.ValueKind != JsonValueKind.Object || !m.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.Number || !id.TryGetInt32(out var n)) continue;
                    found.Add((n, m.Clone()));
                    if (m.TryGetProperty("versions", out var versions) && versions.ValueKind == JsonValueKind.Array
                        && versions.EnumerateArray().Any(v => v.ValueKind == JsonValueKind.Object && v.TryGetProperty("service_item_id", out var si) && si.ValueKind == JsonValueKind.String && Guid.TryParse(si.GetString(), out var g) && g == item.Id)) return (n, m.Clone());
                }
            }

            return found.Count switch
            {
                0 => throw new MaintainerrActions.ActionException("Reclaimerr does not have this title (run its Sync Media first)."),
                1 => found[0],
                _ => throw new MaintainerrActions.ActionException("Reclaimerr has more than one title with this TMDB id and none is provably this one, so nothing was sent. Act on it in Reclaimerr."),
            };
        }

        private Task<JsonDocument> TokenAsync(PluginConfiguration config, HttpMethod method, string path, object? body, CancellationToken token)
            => ReclaimerrApi.TokenAsync(_http, config, method, path, body, Timeout, null, token);

        /// <summary>
        /// A token call that also names the acting Jellyfin user to Reclaimerr (the user header, same as a user's own request), so its
        /// history credits them instead of the token. Only with "Let users request removals" on; a user with no active linked
        /// Reclaimerr account, or a lookup that fails, sends no header and the call stays the token's.
        /// </summary>
        private async Task<JsonDocument> ActingTokenAsync(PluginConfiguration config, Guid? actingUserId, HttpMethod method, string path, object? body, CancellationToken token)
        {
            string? who = null;
            if (actingUserId is { } id && RequestsEnabled(config))
            {
                try { who = await ReclaimerrUserAsync(config, id, token).ConfigureAwait(false); }
                catch (Exception ex) when (ex is not OperationCanceledException || !token.IsCancellationRequested) { _logger.Warning($"[Reclaimerr] Could not look up the acting user ({MaintainerrHttp.Describe(ex)}); sending the call as the token."); }
            }

            return await ReclaimerrApi.TokenAsync(_http, config, method, path, body, Timeout, null, token, who).ConfigureAwait(false);
        }

        private async Task<MaintainerrItemState> AfterAsync(BaseItem item, PluginConfiguration config, CancellationToken token)
        {
            await RefreshAfterAsync(config, token).ConfigureAwait(false);
            return State(item, config);
        }

        /// <summary>The Leaving soon facts are read again now (the answer needs them); stamping the tag cache happens in the background.</summary>
        private async Task RefreshAfterAsync(PluginConfiguration config, CancellationToken token)
        {
            ForgetLists();
            try { await _leaving.RefreshAsync(config, force: true, token).ConfigureAwait(false); }
            catch (Exception ex) when (ex is not OperationCanceledException) { _logger.Warning($"[Reclaimerr] The refresh after an action failed: {ex.Message}"); }
            _cache.QueueLeavingPublish();
        }
    }
}
