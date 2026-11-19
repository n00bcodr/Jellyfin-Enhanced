using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
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
        [property: System.Text.Json.Serialization.JsonPropertyName("id")] int Id,
        [property: System.Text.Json.Serialization.JsonPropertyName("title")] string Title,
        [property: System.Text.Json.Serialization.JsonPropertyName("year")] int? Year,
        [property: System.Text.Json.Serialization.JsonPropertyName("mediaType")] string MediaType,
        [property: System.Text.Json.Serialization.JsonPropertyName("requestedBy")] string? RequestedBy,
        [property: System.Text.Json.Serialization.JsonPropertyName("reason")] string? Reason,
        [property: System.Text.Json.Serialization.JsonPropertyName("status")] string Status,
        [property: System.Text.Json.Serialization.JsonPropertyName("createdAt")] string? CreatedAt,
        [property: System.Text.Json.Serialization.JsonPropertyName("reviewedBy")] string? ReviewedBy,
        [property: System.Text.Json.Serialization.JsonPropertyName("mediaId")] int MediaId = 0,
        [property: System.Text.Json.Serialization.JsonPropertyName("posterPath")] string? PosterPath = null,
        [property: System.Text.Json.Serialization.JsonPropertyName("scope")] string Scope = "movie",
        [property: System.Text.Json.Serialization.JsonPropertyName("seasonNumber")] int? SeasonNumber = null,
        [property: System.Text.Json.Serialization.JsonPropertyName("episodeNumber")] int? EpisodeNumber = null,
        [property: System.Text.Json.Serialization.JsonPropertyName("versionResolution")] string? VersionResolution = null,
        [property: System.Text.Json.Serialization.JsonPropertyName("versionSize")] long? VersionSize = null,
        [property: System.Text.Json.Serialization.JsonPropertyName("adminNotes")] string? AdminNotes = null,
        [property: System.Text.Json.Serialization.JsonPropertyName("executionError")] string? ExecutionError = null,
        [property: System.Text.Json.Serialization.JsonPropertyName("deferred")] bool Deferred = false,
        [property: System.Text.Json.Serialization.JsonPropertyName("scheduledAt")] string? ScheduledAt = null,
        [property: System.Text.Json.Serialization.JsonPropertyName("scheduleState")] string? ScheduleState = null);

    /// <summary>
    /// The Reclaimerr counterpart of <see cref="MaintainerrActions"/>, same answers for the item menu:
    /// <list type="bullet">
    /// <item>Keep and postpone use the token API on the item's cleanup candidate (<c>protect</c>, <c>postpone</c>,
    /// <c>reset-timer</c>), or reschedule/cancel the item's scheduled manual deletion.</item>
    /// <item>Mark for removal (administrators) schedules a manual deletion <see cref="MarkDays"/> days ahead, and
    /// Request removal (anyone signed in) files a Reclaimerr deletion request for an administrator to approve.
    /// Both need the service account, because Reclaimerr's token API has no such calls.</item>
    /// </list>
    /// A scheduled manual deletion is listed by its negated id where a candidate's id is positive, so one number
    /// says which kind governs an item. Every action ends with a forced Leaving soon refresh.
    /// </summary>
    public sealed class ReclaimerrActions
    {
        /// <summary>Days ahead a marked title is scheduled for deletion.</summary>
        public const int MarkDays = 30;
        public const int MaxPostponeDays = 3650;

        private readonly IHttpClientFactory _http;
        private readonly LeavingSoonService _leaving;
        private readonly TagCacheService _cache;
        private readonly Logger _logger;

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

        /// <summary>Whether signed-in users who are not administrators can request removals.</summary>
        public static bool RequestsEnabled(PluginConfiguration? config)
            => Enabled(config) && ReclaimerrSession.HasAccount(config);

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
        /// Schedule a manual deletion of the whole title on <paramref name="at"/> (administrators), or
        /// <see cref="MarkDays"/> days ahead when no date is given.
        /// </summary>
        public async Task<MaintainerrItemState> MarkAsync(BaseItem item, PluginConfiguration config, DateTimeOffset? at, string? mediaSourceId, string? actingUser, CancellationToken token)
        {
            var type = MediaType(item) ?? throw new MaintainerrActions.ActionException("Only movies and series can be marked.");
            if (_leaving.CollectionOf(item.Id, config) != null) throw new MaintainerrActions.ActionException("This item is already marked for removal.");
            var mediaId = await ResolveMediaAsync(item, type, config, token).ConfigureAwait(false);
            var when = at is { } exact ? CheckedDate(exact) : Now().AddDays(MarkDays);
            // A movie kept in several versions (1080p and 4K): schedule only the file this item or the picked version is,
            // so the movie and its other copies stay. A single-version movie is scheduled whole (the Radarr entry goes too).
            var versionId = type == "movie" ? await VersionIdAsync(item, mediaSourceId, config, actingUser, token).ConfigureAwait(false) : null;
            await SessionAsync(config, HttpMethod.Post, "/api/media/schedule-deletion", new { media_type = type, media_id = mediaId, movie_version_id = versionId, scheduled_at = Iso(when) }, actingUser, token, adminAction: true).ConfigureAwait(false);
            _logger.Info($"[Reclaimerr] Scheduled '{item.Name}'{(versionId != null ? " (one version)" : string.Empty)} for deletion on {when:yyyy-MM-dd}.");
            return await AfterAsync(item, config, token).ConfigureAwait(false);
        }

        /// <summary>Keep the item: protect its candidate, or cancel its scheduled deletion.</summary>
        public async Task<MaintainerrItemState> UnmarkAsync(BaseItem item, PluginConfiguration config, string? actingUser, CancellationToken token)
        {
            if (MediaType(item) == null) throw new MaintainerrActions.ActionException("Only movies and series can be kept.");
            var owner = await OwnerAsync(item, config, token).ConfigureAwait(false);
            if (owner > 0) await TokenAsync(config, HttpMethod.Post, $"/api/v1/candidates/{owner}/protect", new { reason = "Kept from Jellyfin" }, token).ConfigureAwait(false);
            else await SessionAsync(config, HttpMethod.Post, $"/api/media/scheduled-deletions/{-owner}/cancel", new { }, actingUser, token, adminAction: true).ConfigureAwait(false);
            _logger.Info($"[Reclaimerr] Kept '{item.Name}'.");
            return await AfterAsync(item, config, token).ConfigureAwait(false);
        }

        /// <summary>
        /// Move the removal to the exact day <paramref name="until"/>, or later by <paramref name="days"/> (1 to 3650),
        /// or restart a candidate's timer when neither is given.
        /// </summary>
        public async Task<MaintainerrItemState> PostponeAsync(BaseItem item, int? days, DateTimeOffset? until, PluginConfiguration config, string? actingUser, CancellationToken token)
        {
            if (MediaType(item) == null) throw new MaintainerrActions.ActionException("Only movies and series can be postponed.");
            if (days is { } d && (d < 1 || d > MaxPostponeDays)) throw new MaintainerrActions.ActionException($"Days must be between 1 and {MaxPostponeDays}.");
            var owner = await OwnerAsync(item, config, token).ConfigureAwait(false);
            var fact = _leaving.Get(item.Id, config);
            var exact = until is { } u ? CheckedDate(u) : (DateTimeOffset?)null;
            if (owner > 0)
            {
                // Reclaimerr only lets a candidate's deadline move later; a scheduled deletion can move either way.
                var current = fact?.DeleteAt is { } cur ? DateTimeOffset.FromUnixTimeMilliseconds(cur) : (DateTimeOffset?)null;
                if (exact is { } early && current is { } c0 && early <= c0) throw new MaintainerrActions.ActionException("Reclaimerr only moves a cleanup candidate to a later day than its current deadline.");
                if (exact is { } day) await TokenAsync(config, HttpMethod.Post, $"/api/v1/candidates/{owner}/postpone", new { until = Iso(day), reason = "Postponed from Jellyfin" }, token).ConfigureAwait(false);
                else if (days is { } n) await TokenAsync(config, HttpMethod.Post, $"/api/v1/candidates/{owner}/postpone", new { until = Iso((fact?.DeleteAt is { } at ? DateTimeOffset.FromUnixTimeMilliseconds(at) : Now()).AddDays(n)), reason = "Postponed from Jellyfin" }, token).ConfigureAwait(false);
                else await TokenAsync(config, HttpMethod.Post, $"/api/v1/candidates/{owner}/reset-timer", new { reason = "Reset from Jellyfin" }, token).ConfigureAwait(false);
            }
            else
            {
                var from = fact?.DeleteAt is { } at ? DateTimeOffset.FromUnixTimeMilliseconds(at) : Now();
                var to = exact ?? (days is { } n ? from.AddDays(n) : Now().AddDays(MarkDays));
                await SessionAsync(config, HttpMethod.Post, $"/api/media/scheduled-deletions/{-owner}/reschedule", new { scheduled_at = Iso(to) }, actingUser, token, adminAction: true).ConfigureAwait(false);
            }

            _logger.Info(exact is { } e ? $"[Reclaimerr] Postponed '{item.Name}' to {e:yyyy-MM-dd}." : days is { } p ? $"[Reclaimerr] Postponed '{item.Name}' by {p} days." : $"[Reclaimerr] Reset the removal timer of '{item.Name}'.");
            return await AfterAsync(item, config, token).ConfigureAwait(false);
        }

        /// <summary>File a Reclaimerr deletion request for an administrator to approve; the reason names the Jellyfin user.</summary>
        public async Task<(MaintainerrItemState State, string? Existing)> RequestRemovalAsync(BaseItem item, string requester, string? reason, PluginConfiguration config, CancellationToken token)
        {
            var type = MediaType(item) ?? throw new MaintainerrActions.ActionException("Only movies and series can be requested for removal.");
            if (!RequestsEnabled(config)) throw new MaintainerrActions.ActionException("Removal requests are not set up (Reclaimerr needs a service account).");
            if (_leaving.CollectionOf(item.Id, config) != null) throw new MaintainerrActions.ActionException("This item is already marked for removal.");
            var mediaId = await ResolveMediaAsync(item, type, config, token).ConfigureAwait(false);
            // Already asked for (by this user or another) and still waiting: say so instead of failing on a duplicate.
            var waiting = await PendingRequestAsync(mediaId, type, requester, config, token).ConfigureAwait(false);
            if (waiting != null) return (State(item, config), waiting);
            var text = $"Requested by {requester} from Jellyfin" + (string.IsNullOrWhiteSpace(reason) ? string.Empty : ": " + reason.Trim());
            var asUser = await SessionAsync(config, HttpMethod.Post, "/api/delete-requests", new { media_type = type, media_id = mediaId, reason = text.Length <= 500 ? text : text[..500] }, requester, token).ConfigureAwait(false);
            _logger.Info($"[Reclaimerr] {requester} requested the removal of '{item.Name}'{(asUser ? string.Empty : " (filed by the service account)")}.");
            return (State(item, config), null);
        }

        /// <summary>
        /// "mine" when this user already has a pending deletion request for the title, "other" when someone else does,
        /// null when none (or it could not be read: the request is then tried and Reclaimerr's own answer is shown).
        /// </summary>
        private async Task<string?> PendingRequestAsync(int mediaId, string type, string requester, PluginConfiguration config, CancellationToken token)
        {
            try
            {
                using var doc = await SessionJsonAsync(config, HttpMethod.Get, "/api/delete-requests?status_filter=pending", requester, token).ConfigureAwait(false);
                var list = doc.RootElement;
                if (list.ValueKind == JsonValueKind.Object && list.TryGetProperty("items", out var inner)) list = inner;
                if (list.ValueKind != JsonValueKind.Array) return null;
                string? found = null;
                var asName = await ResolveUserAsync(config, requester, token).ConfigureAwait(false);
                foreach (var r in list.EnumerateArray())
                {
                    if (r.ValueKind != JsonValueKind.Object) continue;
                    if (!r.TryGetProperty("media_id", out var m) || m.ValueKind != JsonValueKind.Number || m.GetInt32() != mediaId) continue;
                    if (!r.TryGetProperty("media_type", out var t) || t.ValueKind != JsonValueKind.String || t.GetString() != type) continue;
                    if (r.TryGetProperty("status", out var st) && st.ValueKind == JsonValueKind.String && st.GetString() != "pending") continue;
                    var reason = r.TryGetProperty("reason", out var rs) && rs.ValueKind == JsonValueKind.String ? rs.GetString() : null;
                    var by = r.TryGetProperty("requested_by_username", out var u) && u.ValueKind == JsonValueKind.String ? u.GetString() : null;
                    if ((asName != null && string.Equals(by, asName, StringComparison.OrdinalIgnoreCase))
                        || (reason != null && reason.StartsWith($"Requested by {requester} from Jellyfin", StringComparison.Ordinal))) return "mine";
                    found = "other";
                }

                return found;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.Warning($"[Reclaimerr] Could not read the pending requests ({MaintainerrHttp.Describe(ex)}).");
                return null;
            }
        }

        /// <summary>
        /// Reclaimerr's id of the movie file this action is about, or null for the whole movie. Null only when Reclaimerr
        /// confirms it holds fewer than two versions; in every other case (movie not found, lookup failed, no version matches)
        /// it throws, because sending no version would schedule every copy. Matched by <c>service_media_id</c> (Jellyfin's
        /// media source id), then by file path; the movie is found by TMDB id, then by name.
        /// </summary>
        private async Task<int?> VersionIdAsync(BaseItem item, string? mediaSourceId, PluginConfiguration config, string? actingUser, CancellationToken token)
        {
            var source = MaintainerrActions.FindVersion(item, mediaSourceId);
            var path = source?.Path ?? item.Path;
            var tmdb = item.GetProviderId(MetadataProvider.Tmdb);
            var ids = new[] { source?.Id, mediaSourceId, item.Id.ToString("N"), item.Id.ToString("D") }
                .Where(i => !string.IsNullOrWhiteSpace(i)).Select(i => i!.Replace("-", string.Empty)).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var unsure = new MaintainerrActions.ActionException("Could not tell which version of this movie Reclaimerr holds, so nothing was scheduled. Try again, or schedule it in Reclaimerr.");
            if (string.IsNullOrWhiteSpace(tmdb)) throw unsure;
            try
            {
                // Reclaimerr's movie list has no TMDB filter, only a title search: try the title, then the original title, and match the TMDB id on each result.
                foreach (var query in new[] { item.Name, item.OriginalTitle }.Where(n => !string.IsNullOrWhiteSpace(n)).Distinct(StringComparer.OrdinalIgnoreCase).Select(n => "search=" + Uri.EscapeDataString(n!)))
                {
                    using var doc = await SessionJsonAsync(config, HttpMethod.Get, "/api/media/movies?per_page=50&" + query, actingUser, token).ConfigureAwait(false);
                    if (doc.RootElement.ValueKind != JsonValueKind.Object || !doc.RootElement.TryGetProperty("items", out var movies) || movies.ValueKind != JsonValueKind.Array) continue;
                    foreach (var m in movies.EnumerateArray())
                    {
                        if (m.ValueKind != JsonValueKind.Object || !m.TryGetProperty("tmdb_id", out var t) || t.ValueKind != JsonValueKind.Number || t.GetInt64().ToString(CultureInfo.InvariantCulture) != tmdb) continue;
                        if (!m.TryGetProperty("versions", out var versions) || versions.ValueKind != JsonValueKind.Array) throw unsure;
                        if (versions.GetArrayLength() < 2) return null;
                        int? byPath = null;
                        foreach (var v in versions.EnumerateArray())
                        {
                            if (!v.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.Number || !id.TryGetInt32(out var n)) continue;
                            if (v.TryGetProperty("service_media_id", out var sm) && sm.ValueKind == JsonValueKind.String && sm.GetString() is { Length: > 0 } smId && ids.Contains(smId.Replace("-", string.Empty))) return n;
                            if (!string.IsNullOrWhiteSpace(path) && v.TryGetProperty("path", out var p) && p.ValueKind == JsonValueKind.String && string.Equals(p.GetString(), path, StringComparison.OrdinalIgnoreCase)) byPath ??= n;
                        }

                        return byPath ?? throw unsure;
                    }
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException and not MaintainerrActions.ActionException)
            {
                _logger.Warning($"[Reclaimerr] Could not read the movie's versions ({MaintainerrHttp.Describe(ex)}).");
            }

            throw unsure;
        }

        private readonly Dictionary<int, (DateTimeOffset At, long? Size)> _versionSizes = new();
        private static readonly TimeSpan VersionSizeTtl = TimeSpan.FromMinutes(30);

        /// <summary>
        /// The size of the one movie file that is leaving (<paramref name="owner"/>: a candidate's id, or a scheduled deletion's id negated),
        /// which only Reclaimerr knows: a scheduled deletion carries its own estimate, and a candidate names its version, whose size the
        /// service account reads from the movie's versions. Null when it cannot be told. Kept for 30 minutes (the page asks every refresh).
        /// </summary>
        public async Task<long?> VersionSizeAsync(BaseItem item, int owner, PluginConfiguration config, CancellationToken token)
        {
            if (owner == 0 || !ReclaimerrSession.HasAccount(config)) return null;
            lock (_versionSizes)
            {
                if (_versionSizes.TryGetValue(owner, out var hit) && Now() - hit.At < VersionSizeTtl) return hit.Size;
            }

            long? size = null;
            try
            {
                if (owner < 0)
                {
                    using var doc = await ReclaimerrSession.SendAsync(_http, config, HttpMethod.Get, "/api/media/scheduled-deletions", null, Timeout, null, token).ConfigureAwait(false);
                    if (doc.RootElement.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var sd in doc.RootElement.EnumerateArray())
                        {
                            if (sd.ValueKind != JsonValueKind.Object || !sd.TryGetProperty("id", out var id) || !id.TryGetInt32(out var n) || n != -owner) continue;
                            if (sd.TryGetProperty("target", out var target) && target.ValueKind == JsonValueKind.Object && target.TryGetProperty("estimated_space_bytes", out var bytes) && bytes.ValueKind == JsonValueKind.Number && bytes.TryGetInt64(out var b) && b > 0) size = b;
                            break;
                        }
                    }
                }
                else
                {
                    using var cand = await TokenAsync(config, HttpMethod.Get, $"/api/v1/candidates/{owner}", null, token).ConfigureAwait(false);
                    var tmdb = item.GetProviderId(MetadataProvider.Tmdb);
                    if (cand.RootElement.ValueKind == JsonValueKind.Object && cand.RootElement.TryGetProperty("movie_version_id", out var vid) && vid.ValueKind == JsonValueKind.Number && vid.TryGetInt32(out var versionId) && !string.IsNullOrWhiteSpace(tmdb))
                    {
                        // The movie list has no TMDB filter, only a title search: try the title, then the original title, and match the TMDB id.
                        foreach (var query in new[] { item.Name, item.OriginalTitle }.Where(x => !string.IsNullOrWhiteSpace(x)).Distinct(StringComparer.OrdinalIgnoreCase).Select(x => "search=" + Uri.EscapeDataString(x!)))
                        {
                            using var doc = await SessionJsonAsync(config, HttpMethod.Get, "/api/media/movies?per_page=50&" + query, null, token).ConfigureAwait(false);
                            if (doc.RootElement.ValueKind != JsonValueKind.Object || !doc.RootElement.TryGetProperty("items", out var movies) || movies.ValueKind != JsonValueKind.Array) continue;
                            foreach (var m in movies.EnumerateArray())
                            {
                                if (m.ValueKind != JsonValueKind.Object || !m.TryGetProperty("tmdb_id", out var t) || t.ValueKind != JsonValueKind.Number || t.GetInt64().ToString(CultureInfo.InvariantCulture) != tmdb) continue;
                                if (!m.TryGetProperty("versions", out var versions) || versions.ValueKind != JsonValueKind.Array) continue;
                                foreach (var v in versions.EnumerateArray())
                                {
                                    if (v.TryGetProperty("id", out var vi) && vi.TryGetInt32(out var viId) && viId == versionId && v.TryGetProperty("size", out var sz) && sz.ValueKind == JsonValueKind.Number && sz.TryGetInt64(out var bytes) && bytes > 0) { size = bytes; break; }
                                }

                                if (size != null) break;
                            }

                            if (size != null) break;
                        }
                    }
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.Warning($"[Reclaimerr] Could not read the size of the version leaving ({MaintainerrHttp.Describe(ex)}).");
                return null;
            }

            lock (_versionSizes) _versionSizes[owner] = (Now(), size);
            return size;
        }

        /// <summary>A read that needs a login: the service account when there is one (it sees every user's rows), else the Jellyfin user.</summary>
        private async Task<JsonDocument> SessionJsonAsync(PluginConfiguration config, HttpMethod method, string path, string? actingUser, CancellationToken token)
            => ReclaimerrSession.HasAccount(config) || !ReclaimerrSession.ActsAsUser(config) || string.IsNullOrWhiteSpace(actingUser)
                ? await ReclaimerrSession.SendAsync(_http, config, method, path, null, Timeout, null, token).ConfigureAwait(false)
                : await ReclaimerrSession.SendAsUserAsync(_http, config, (await ResolveUserAsync(config, actingUser!, token).ConfigureAwait(false))!, method, path, null, Timeout, null, token).ConfigureAwait(false);

        /// <summary>
        /// Deletion requests: every pending one (administrators; read by the service account, else as the administrator) or the
        /// caller's own (<paramref name="mine"/>, read as the user, so it needs acting as the user). Empty when it cannot be read.
        /// </summary>
        public async Task<IReadOnlyList<ReclaimerrRequestRow>> RequestsAsync(PluginConfiguration config, string? actingUser, bool mine, CancellationToken token)
        {
            var rows = new List<ReclaimerrRequestRow>();
            try
            {
                JsonDocument doc;
                if (mine)
                {
                    if (string.IsNullOrWhiteSpace(actingUser)) return rows;
                    var own = ReclaimerrSession.ActsAsUser(config) ? await ResolveUserAsync(config, actingUser!, token).ConfigureAwait(false) : null;
                    var seen = new HashSet<int>();
                    if (own != null)
                    {
                        // Their own list; it can be refused (no Requests page access), which must not hide the rest.
                        try
                        {
                            doc = await ReclaimerrSession.SendAsUserAsync(_http, config, own, HttpMethod.Get, "/api/delete-requests/my", null, Timeout, null, token).ConfigureAwait(false);
                            foreach (var r in Parse(doc, null)) if (seen.Add(r.Id)) rows.Add(r);
                        }
                        catch (Exception ex) when (ex is not OperationCanceledException)
                        {
                            _logger.Warning($"[Reclaimerr] Could not read {actingUser}'s own deletion requests ({MaintainerrHttp.Describe(ex)}); grant that Reclaimerr account the Requests page.");
                        }
                    }

                    if (ReclaimerrSession.HasAccount(config))
                    {
                        // Filed through the service account: they belong to it, so pick this user's out by the text the request carries.
                        var prefix = $"Requested by {actingUser!.Trim()} from Jellyfin";
                        doc = await ReclaimerrSession.SendAsync(_http, config, HttpMethod.Get, "/api/delete-requests", null, Timeout, null, token).ConfigureAwait(false);
                        // Only rows the service account itself filed: the text alone could be typed into a request by anyone in Reclaimerr.
                        var service = config.ReclaimerrUsername.Trim();
                        foreach (var r in Parse(doc, r => string.Equals(r.RequestedBy, service, StringComparison.OrdinalIgnoreCase) && r.Reason != null && r.Reason.StartsWith(prefix, StringComparison.Ordinal))) if (seen.Add(r.Id)) rows.Add(r);
                    }

                    return rows;
                }
                else doc = await SessionJsonAsync(config, HttpMethod.Get, "/api/delete-requests?status_filter=pending", actingUser, token).ConfigureAwait(false);
                var all = Parse(doc, null);
                // Approved requests whose deletion failed or is held back by playback would otherwise vanish from the page: keep them in view.
                try
                {
                    doc = await SessionJsonAsync(config, HttpMethod.Get, "/api/delete-requests?status_filter=approved", actingUser, token).ConfigureAwait(false);
                    all.AddRange(Parse(doc, r => !string.IsNullOrEmpty(r.ExecutionError) || r.Deferred || r.ScheduleState is "failed" or "blocked"));
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.Warning($"[Reclaimerr] Could not read the approved deletion requests ({MaintainerrHttp.Describe(ex)}).");
                }

                return all;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.Warning($"[Reclaimerr] Could not read the deletion requests ({MaintainerrHttp.Describe(ex)}).");
            }

            return rows;
        }

        internal static List<ReclaimerrRequestRow> Parse(JsonDocument doc, Func<ReclaimerrRequestRow, bool>? keep)
        {
            var rows = new List<ReclaimerrRequestRow>();
            using (doc)
            {
                var list = doc.RootElement;
                if (list.ValueKind == JsonValueKind.Object && list.TryGetProperty("items", out var inner)) list = inner;
                if (list.ValueKind != JsonValueKind.Array) return rows;
                string? Str(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
                int? Num(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) ? n : null;
                foreach (var r in list.EnumerateArray())
                {
                    if (r.ValueKind != JsonValueKind.Object || Num(r, "id") is not { } n) continue;
                    long? size = r.TryGetProperty("version_size", out var vs) && vs.ValueKind == JsonValueKind.Number && vs.TryGetInt64(out var vsz) ? vsz : null;
                    var deferred = r.TryGetProperty("playback_deferral", out var pd) && pd.ValueKind == JsonValueKind.Object;
                    var row = new ReclaimerrRequestRow(n, Str(r, "media_title") ?? "?", Num(r, "media_year"), Str(r, "media_type") ?? "movie", Str(r, "requested_by_username"), Str(r, "reason"), Str(r, "status") ?? "pending", Str(r, "created_at"), Str(r, "reviewed_by_username"),
                        Num(r, "media_id") ?? 0, Str(r, "poster_url"),
                        Str(r, "target_scope") ?? (Str(r, "media_type") == "series" ? "series" : "movie"), Num(r, "season_number"), Num(r, "episode_number"), Str(r, "version_resolution"), size,
                        Str(r, "admin_notes"), Str(r, "execution_error"), deferred && string.IsNullOrEmpty(Str(r, "executed_at")), Str(r, "scheduled_at"), Str(r, "schedule_state"));
                    if (keep == null || keep(row)) rows.Add(row);
                }
            }

            return rows;
        }

        /// <summary>When an approved request is deleted: with Reclaimerr's own grace period (its setting; none by default), right away, or on a day.</summary>
        public enum ApprovalTiming { GracePeriod, Now, OnDate }

        private (DateTimeOffset At, bool Supported)? _scheduling;
        private static readonly TimeSpan SchedulingTtl = TimeSpan.FromMinutes(10);

        /// <summary>
        /// Whether this Reclaimerr can schedule an approved deletion request (an approve call that takes <c>scheduled_at</c>). An older one
        /// ignores the field and would delete at once whatever day was picked, so this is asked first: Reclaimerr's public
        /// <c>/openapi.json</c> names the approve body (<c>ApproveDeleteRequest</c>) only when it can. Kept for ten minutes; false when it cannot be read.
        /// </summary>
        public async Task<bool> SchedulingSupportedAsync(PluginConfiguration config, CancellationToken token)
        {
            if (!Enabled(config)) return false;
            lock (_versionSizes)
            {
                if (_scheduling is { } known && Now() - known.At < SchedulingTtl) return known.Supported;
            }

            var supported = false;
            try
            {
                using var doc = await TokenAsync(config, HttpMethod.Get, "/openapi.json", null, token).ConfigureAwait(false);
                supported = doc.RootElement.ValueKind == JsonValueKind.Object
                    && doc.RootElement.TryGetProperty("components", out var components) && components.ValueKind == JsonValueKind.Object
                    && components.TryGetProperty("schemas", out var schemas) && schemas.ValueKind == JsonValueKind.Object
                    && schemas.TryGetProperty("ApproveDeleteRequest", out _);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.Warning($"[Reclaimerr] Could not tell whether Reclaimerr can schedule approved requests ({MaintainerrHttp.Describe(ex)}).");
                return false;
            }

            lock (_versionSizes) _scheduling = (Now(), supported);
            return supported;
        }

        private (DateTimeOffset At, int? Days)? _grace;

        /// <summary>
        /// The grace period (days) Reclaimerr applies to an approval that names no day (Settings, General: Approved Deletion Requests; 0 when
        /// none). Read with the service account and kept for a minute; null when it cannot be read.
        /// </summary>
        public async Task<int?> GracePeriodDaysAsync(PluginConfiguration config, CancellationToken token)
        {
            lock (_versionSizes)
            {
                if (_grace is { } known && Now() - known.At < TimeSpan.FromMinutes(1)) return known.Days;
            }

            int? days = null;
            try
            {
                using var doc = await SessionJsonAsync(config, HttpMethod.Get, "/api/settings/general", null, token).ConfigureAwait(false);
                if (doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("delete_request_grace_period_days", out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) && n >= 0) days = n;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.Warning($"[Reclaimerr] Could not read the deletion request grace period ({MaintainerrHttp.Describe(ex)}).");
                return null;
            }

            lock (_versionSizes) _grace = (Now(), days);
            return days;
        }

        /// <summary>
        /// Approve or deny a pending deletion request as the administrator who clicked (the service account is the fallback). Approving
        /// deletes at once unless <paramref name="timing"/> says otherwise: <see cref="ApprovalTiming.OnDate"/> on <paramref name="at"/>, or
        /// <see cref="ApprovalTiming.GracePeriod"/> after the delay set in Reclaimerr (none by default, so the same as now). A day is refused
        /// when this Reclaimerr cannot schedule (it would delete at once instead).
        /// </summary>
        public async Task ReviewRequestAsync(int requestId, bool approve, string? note, string? actingUser, PluginConfiguration config, CancellationToken token, ApprovalTiming timing = ApprovalTiming.GracePeriod, DateTimeOffset? at = null)
        {
            if (requestId <= 0) throw new MaintainerrActions.ActionException("Unknown request.");
            var text = string.IsNullOrWhiteSpace(note) ? null : note.Trim();
            // Reclaimerr records the service account as the reviewer when the administrator cannot act as themself (no mapping or link,
            // or the trusted-proxy sign-in is off): name them in the note so the review is not anonymous.
            var actsAsSelf = ReclaimerrSession.ActsAsUser(config) && !string.IsNullOrWhiteSpace(actingUser) && await ResolveUserAsync(config, actingUser!, token).ConfigureAwait(false) != null;
            if (!actsAsSelf && !string.IsNullOrWhiteSpace(actingUser))
            {
                var by = $"{(approve ? "Approved" : "Denied")} by {actingUser.Trim()} in Jellyfin";
                text = text == null ? by : $"{text} ({by})";
            }

            object body = new { admin_notes = text };
            if (approve && timing != ApprovalTiming.GracePeriod)
            {
                if (!await SchedulingSupportedAsync(config, token).ConfigureAwait(false))
                    throw new MaintainerrActions.ActionException("This Reclaimerr cannot schedule an approval yet (update it), so nothing was approved.");
                // Omitting scheduled_at means the grace period; null means now; a day schedules it.
                body = timing == ApprovalTiming.Now
                    ? new { admin_notes = text, scheduled_at = (string?)null }
                    : new { admin_notes = text, scheduled_at = Iso(CheckedDate(at ?? throw new MaintainerrActions.ActionException("Pick the day to delete it."))) };
            }

            await SessionAsync(config, HttpMethod.Post, $"/api/delete-requests/{requestId}/{(approve ? "approve" : "deny")}", body, actingUser, token, adminAction: true).ConfigureAwait(false);
            _logger.Info($"[Reclaimerr] {actingUser ?? "an administrator"} {(approve ? "approved" : "denied")} deletion request {requestId}{(approve && timing == ApprovalTiming.OnDate ? $" for {at:yyyy-MM-dd}" : string.Empty)}.");
            // An approval on a day (or after a grace period) puts the title on the Leaving soon list and its tags: read that now, like Mark, Keep and Postpone do.
            if (approve) await RefreshAfterAsync(config, token).ConfigureAwait(false);
        }

        /// <summary>Permissions an administrator may hand to the accounts created for Jellyfin users (never <c>manage_users</c>).</summary>
        public static readonly string[] GrantablePermissions = { "request", "auto_approve", "manage_requests", "manage_protection", "manage_reclaim" };
        /// <summary>Reclaimerr pages an account can be given.</summary>
        public static readonly string[] GrantablePages = { "dashboard", "movies", "series", "requests", "protected", "candidates", "duplicates", "calendar", "storage", "history", "settings" };

        /// <summary>Result of <see cref="CreateAccountsAsync"/>: the new <c>Jellyfin name, Reclaimerr name</c> pairs, how many already had an account, and the ones that could not be created.</summary>
        public sealed record AccountsResult(List<(string Jellyfin, string Reclaimerr)> Created, int Existing, List<string> Skipped);

        /// <summary>
        /// Create a Reclaimerr account (User role, no password to sign in with: they come in through the trusted-proxy sign-in) for
        /// every Jellyfin user that has none, with the permissions and pages given. A user who is mapped, linked or already has an
        /// account of the same name is left as it is. Reclaimerr's rules: 5 to 32 letters, digits, <c>_</c> or <c>-</c>; other
        /// characters become <c>_</c>, and a name that is still too short or long is reported, not created.
        /// </summary>
        public async Task<AccountsResult> CreateAccountsAsync(PluginConfiguration config, IEnumerable<string> jellyfinNames, IEnumerable<string> permissions, IEnumerable<string> pages, CancellationToken token)
        {
            if (!ReclaimerrSession.HasAccount(config)) throw new MaintainerrActions.ActionException("Create the service account first.");
            var perms = permissions.Where(p => GrantablePermissions.Contains(p)).Distinct().ToList();
            var allowed = pages.Where(p => GrantablePages.Contains(p)).Distinct().ToList();
            if (allowed.Count == 0) throw new MaintainerrActions.ActionException("Pick at least one page.");

            var taken = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            using (var users = await ReclaimerrSession.SendAsync(_http, config, HttpMethod.Get, "/api/account/users", null, Timeout, null, token).ConfigureAwait(false))
            {
                var list = users.RootElement;
                if (list.ValueKind == JsonValueKind.Object && list.TryGetProperty("items", out var inner)) list = inner;
                if (list.ValueKind == JsonValueKind.Array)
                    foreach (var u in list.EnumerateArray())
                        if (u.ValueKind == JsonValueKind.Object && u.TryGetProperty("username", out var n) && n.ValueKind == JsonValueKind.String && n.GetString() is { Length: > 0 } s) taken.Add(s);
            }

            var linked = await ReadIdentitiesAsync(config, token).ConfigureAwait(false);
            var result = new AccountsResult(new(), 0, new());
            var existing = 0;
            foreach (var jf in jellyfinNames.Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim()).Distinct(StringComparer.OrdinalIgnoreCase))
            {
                if (ReclaimerrSession.MappedUser(config, jf) != null || linked.ContainsKey(jf.ToLowerInvariant()) || taken.Contains(jf)) { existing++; continue; }
                var name = System.Text.RegularExpressions.Regex.Replace(jf, "[^a-zA-Z0-9_-]", "_");
                if (name.Length < 5) name += "_user"; // Reclaimerr's own Jellyfin sign-ins get the same suffix
                if (name.Length > 32) { result.Skipped.Add($"{jf}: Reclaimerr allows at most 32 characters"); continue; }
                if (taken.Contains(name)) { result.Skipped.Add($"{jf}: an account named {name} already exists (map it by hand)"); continue; }
                var password = Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(24)).Replace('+', '-').Replace('/', '_');
                var body = new { username = name, password, display_name = jf.Length is >= 3 and <= 32 ? jf : null, role = "user", permissions = perms, allowed_pages = allowed, use_default_page_access = false, require_password_change = false };
                try
                {
                    using (await ReclaimerrSession.SendAsync(_http, config, HttpMethod.Post, "/api/account/users", JsonSerializer.Serialize(body), Timeout, null, token).ConfigureAwait(false)) { }
                    taken.Add(name);
                    result.Created.Add((jf, name));
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    result.Skipped.Add($"{jf}: {MaintainerrHttp.Describe(ex)}");
                }
            }

            _logger.Info($"[Reclaimerr] Created {result.Created.Count} account(s) for Jellyfin users ({existing} already had one, {result.Skipped.Count} skipped).");
            return result with { Existing = existing };
        }

        private readonly Dictionary<(string Type, int Id), string?> _tmdbOfMedia = new();

        /// <summary>The TMDB id of a Reclaimerr movie or series (token API, kept), or null when it cannot be read.</summary>
        public async Task<string?> TmdbIdAsync(PluginConfiguration config, string mediaType, int mediaId, CancellationToken token)
        {
            if (mediaId <= 0) return null;
            var key = (mediaType == "movie" ? "movie" : "series", mediaId);
            lock (_tmdbOfMedia) { if (_tmdbOfMedia.TryGetValue(key, out var known)) return known; }
            string? tmdb = null;
            try
            {
                using var doc = await TokenAsync(config, HttpMethod.Get, $"/api/v1/{(key.Item1 == "movie" ? "movies" : "series")}/{mediaId}", null, token).ConfigureAwait(false);
                if (doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("tmdb_id", out var t) && t.ValueKind == JsonValueKind.Number) tmdb = t.GetInt64().ToString(CultureInfo.InvariantCulture);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.Warning($"[Reclaimerr] Could not read the TMDB id of {key.Item1} {mediaId} ({MaintainerrHttp.Describe(ex)}).");
                return null;
            }

            lock (_tmdbOfMedia) _tmdbOfMedia[key] = tmdb;
            return tmdb;
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

        /// <summary>Reclaimerr's own id for the title, by its TMDB id.</summary>
        private async Task<int> ResolveMediaAsync(BaseItem item, string type, PluginConfiguration config, CancellationToken token)
        {
            var tmdb = item.GetProviderId(MetadataProvider.Tmdb);
            if (string.IsNullOrWhiteSpace(tmdb)) throw new MaintainerrActions.ActionException("This item has no TMDB id, so Reclaimerr cannot match it.");
            using var doc = await TokenAsync(config, HttpMethod.Get, $"/api/v1/{(type == "movie" ? "movies" : "series")}?tmdb_id={Uri.EscapeDataString(tmdb)}&per_page=5", null, token).ConfigureAwait(false);
            if (doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array)
            {
                foreach (var m in items.EnumerateArray())
                {
                    if (m.ValueKind == JsonValueKind.Object && m.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.Number && id.TryGetInt32(out var n)) return n;
                }
            }

            throw new MaintainerrActions.ActionException("Reclaimerr does not have this title (run its Sync Media first).");
        }

        private Task<JsonDocument> TokenAsync(PluginConfiguration config, HttpMethod method, string path, object? body, CancellationToken token)
            => MaintainerrHttp.SendAsync(_http, config, method, config.ReclaimerrUrl.Trim().TrimEnd('/') + path, body == null ? null : JsonSerializer.Serialize(body), Timeout, null, token);

        /// <summary>
        /// A write to Reclaimerr that needs a login: as the Jellyfin user <paramref name="actingUser"/> (mapped to their
        /// Reclaimerr username) through Reclaimerr's trusted-proxy sign-in when that is on, so the request carries their own
        /// name; otherwise, or when Reclaimerr does not accept that user (401: the feature is off, this address is not
        /// trusted, no such user), as the service account. Answers whether the user themself acted.
        /// </summary>
        private (DateTimeOffset At, Dictionary<string, string> ByJellyfinName)? _identities;
        private static readonly TimeSpan IdentityTtl = TimeSpan.FromMinutes(5);

        /// <summary>
        /// The Reclaimerr username to act as for a Jellyfin user: the configured mapping, else the Reclaimerr account linked to
        /// that Jellyfin user (a person who signed in to Reclaimerr with their Jellyfin login gets an account of its own, for
        /// example <c>sam_user</c>, and Reclaimerr records the link, so nothing has to be created or mapped by hand), else the
        /// same name. The links are read with the service account and kept for five minutes (read again when a user is missing).
        /// </summary>
        internal async Task<string?> ResolveUserAsync(PluginConfiguration config, string jellyfinName, CancellationToken token)
        {
            if (ReclaimerrSession.MappedUser(config, jellyfinName) is { } mapped) return mapped;
            if (ReclaimerrSession.HasAccount(config))
            {
                var key = jellyfinName.Trim().ToLowerInvariant();
                var cached = _identities;
                if (cached is { } c && DateTimeOffset.UtcNow - c.At < IdentityTtl && c.ByJellyfinName.TryGetValue(key, out var hit)) return hit;
                // Missing or stale: read the links again, but not more than once a minute for names that have none.
                if (cached is not { } known || DateTimeOffset.UtcNow - known.At > TimeSpan.FromMinutes(1))
                {
                    try { _identities = (DateTimeOffset.UtcNow, await ReadIdentitiesAsync(config, token).ConfigureAwait(false)); }
                    catch (Exception ex) when (ex is not OperationCanceledException) { _logger.Warning($"[Reclaimerr] Could not read the linked Jellyfin users ({MaintainerrHttp.Describe(ex)})."); }
                    if (_identities is { } fresh && fresh.ByJellyfinName.TryGetValue(key, out var found)) return found;
                }
            }

            // With a service account, a user without a mapping or link is not guessed by name (that could be an unrelated
            // Reclaimerr account); null means "use the service account". Without one, the same name is the only option.
            return ReclaimerrSession.HasAccount(config) ? null : jellyfinName;
        }

        /// <summary>
        /// The Jellyfin name of a Reclaimerr account (the other way round from <see cref="ResolveUserAsync"/>): the configured mapping, else
        /// the Jellyfin login Reclaimerr linked that account to (it knows a person who signed in with Jellyfin as, say, <c>ATM_user</c>). Null when neither says.
        /// </summary>
        public async Task<string?> JellyfinNameOfAsync(PluginConfiguration config, string reclaimerrUser, CancellationToken token)
        {
            if (string.IsNullOrWhiteSpace(reclaimerrUser)) return null;
            if (ReclaimerrSession.MappedJellyfinUser(config, reclaimerrUser) is { } mapped) return mapped;
            if (!ReclaimerrSession.HasAccount(config)) return null;
            var cached = _identities;
            if (cached is not { } c || DateTimeOffset.UtcNow - c.At > IdentityTtl)
            {
                try { _identities = (DateTimeOffset.UtcNow, await ReadIdentitiesAsync(config, token).ConfigureAwait(false)); }
                catch (Exception ex) when (ex is not OperationCanceledException) { _logger.Warning($"[Reclaimerr] Could not read the linked Jellyfin users ({MaintainerrHttp.Describe(ex)})."); }
            }

            if (_identities is { } fresh)
            {
                foreach (var pair in fresh.ByJellyfinName)
                    if (string.Equals(pair.Value, reclaimerrUser, StringComparison.OrdinalIgnoreCase)) return pair.Key;
            }

            return null;
        }

        /// <summary>Jellyfin username (lower case) to the Reclaimerr username its linked account has.</summary>
        private async Task<Dictionary<string, string>> ReadIdentitiesAsync(PluginConfiguration config, CancellationToken token)
        {
            var names = new Dictionary<int, string>();
            using (var users = await ReclaimerrSession.SendAsync(_http, config, HttpMethod.Get, "/api/account/users", null, Timeout, null, token).ConfigureAwait(false))
            {
                var list = users.RootElement;
                if (list.ValueKind == JsonValueKind.Object && list.TryGetProperty("items", out var inner)) list = inner;
                if (list.ValueKind == JsonValueKind.Array)
                {
                    foreach (var u in list.EnumerateArray())
                    {
                        if (u.ValueKind == JsonValueKind.Object && u.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.Number && id.TryGetInt32(out var n)
                            && u.TryGetProperty("username", out var name) && name.ValueKind == JsonValueKind.String && name.GetString() is { Length: > 0 } text) names[n] = text;
                    }
                }
            }

            var map = new Dictionary<string, string>(StringComparer.Ordinal);
            var clashes = new HashSet<string>(StringComparer.Ordinal);
            using var doc = await ReclaimerrSession.SendAsync(_http, config, HttpMethod.Get, "/api/account/users/media-identities", null, Timeout, null, token).ConfigureAwait(false);
            var identities = doc.RootElement;
            if (identities.ValueKind == JsonValueKind.Object && identities.TryGetProperty("items", out var items)) identities = items;
            if (identities.ValueKind != JsonValueKind.Array) return map;
            foreach (var i in identities.EnumerateArray())
            {
                if (i.ValueKind != JsonValueKind.Object) continue;
                if (i.TryGetProperty("source_service", out var svc) && svc.ValueKind == JsonValueKind.String && !string.Equals(svc.GetString(), "jellyfin", StringComparison.OrdinalIgnoreCase)) continue;
                if (!i.TryGetProperty("username", out var un) || un.ValueKind != JsonValueKind.String || un.GetString() is not { Length: > 0 } jf) continue;
                if (!i.TryGetProperty("user_id", out var uid) || uid.ValueKind != JsonValueKind.Number || !uid.TryGetInt32(out var linked) || !names.TryGetValue(linked, out var reclaimerrName)) continue;
                // The same Jellyfin name linked to different Reclaimerr users (two media servers): ambiguous, so nobody is guessed.
                var key = jf.Trim().ToLowerInvariant();
                if (map.TryGetValue(key, out var previous) && previous != reclaimerrName) clashes.Add(key);
                map[key] = reclaimerrName;
            }

            foreach (var key in clashes) map.Remove(key);

            return map;
        }

        private async Task<bool> SessionAsync(PluginConfiguration config, HttpMethod method, string path, object body, string? actingUser, CancellationToken token, bool adminAction = false)
        {
            var json = JsonSerializer.Serialize(body);
            if (ReclaimerrSession.ActsAsUser(config) && !string.IsNullOrWhiteSpace(actingUser))
            {
                var who = await ResolveUserAsync(config, actingUser!, token).ConfigureAwait(false);
                if (who != null)
                try
                {
                    using var _ = await ReclaimerrSession.SendAsUserAsync(_http, config, who, method, path, json, Timeout, null, token).ConfigureAwait(false);
                    return true;
                }
                catch (MaintainerrHttp.MaintainerrException e) when ((e.Status == 401 || (adminAction && e.Status == 403)) && ReclaimerrSession.HasAccount(config))
                {
                    _logger.Info($"[Reclaimerr] Reclaimerr did not accept '{who}' (no such user, or its trusted-proxy sign-in is off); using the service account.");
                }
                catch (MaintainerrHttp.MaintainerrException e) when (e.Status == 401)
                {
                    throw new MaintainerrActions.ActionException($"Reclaimerr has no user '{who}' (or its trusted-proxy sign-in is off). Add that user in Reclaimerr, map it in the Reclaimerr card, or set a service account.");
                }
            }

            if (!ReclaimerrSession.HasAccount(config)) throw new MaintainerrActions.ActionException("This needs a Reclaimerr service account (username and password in the Reclaimerr card).");
            using var __ = await ReclaimerrSession.SendAsync(_http, config, method, path, json, Timeout, null, token).ConfigureAwait(false);
            return false;
        }

        private async Task<MaintainerrItemState> AfterAsync(BaseItem item, PluginConfiguration config, CancellationToken token)
        {
            await RefreshAfterAsync(config, token).ConfigureAwait(false);
            return State(item, config);
        }

        /// <summary>The Leaving soon facts are read again now (the answer needs them); stamping the tag cache happens in the background.</summary>
        private async Task RefreshAfterAsync(PluginConfiguration config, CancellationToken token)
        {
            try { await _leaving.RefreshAsync(config, force: true, token).ConfigureAwait(false); }
            catch (Exception ex) when (ex is not OperationCanceledException) { _logger.Warning($"[Reclaimerr] The refresh after an action failed: {ex.Message}"); }
            _cache.QueueLeavingPublish();
        }
    }
}
