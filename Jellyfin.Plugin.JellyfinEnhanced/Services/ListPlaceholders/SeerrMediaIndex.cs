using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders
{
    /// <summary>
    /// One shared, user-independent index of Seerr's media table (<c>GET /api/v1/media</c>), so a list page with
    /// hundreds of placeholders gets every status badge from memory instead of one Seerr call per card (design §6, D1–D2).
    /// <list type="bullet">
    /// <item>Full rebuilds page through <c>/api/v1/media</c> in Seerr's default order into a NEW dictionary that is
    /// swapped in atomically once every page was read; the previous snapshot keeps serving until then.</item>
    /// <item>Lookups are tri-state: indexed, confirmed absent (only with a complete snapshot) or unknown.</item>
    /// <item>Lazy and single-flight: nothing runs until a list with placeholders is viewed; a full rebuild happens at
    /// most every <see cref="FullRebuildInterval"/> on demand, an advisory refresh of recently modified rows at most
    /// every <see cref="AdvisoryInterval"/>.</item>
    /// <item>Season request state: Seerr keeps a TV request's seasons on the REQUEST (SeasonRequest rows), not on the
    /// media row's seasons (those are availability rows only scanners create). So rebuilds also page the active
    /// (pending/approved) TV requests, advisory refreshes the recently modified ones, and season statuses fall back to
    /// them (pending → 2, approved → 3) wherever no availability status exists.</item>
    /// <item>Requests JE itself makes write their result through <see cref="RecordRequestResponse"/>.</item>
    /// <item>A failed rebuild backs off (<see cref="FailureBackoff"/>, doubling up to 10 minutes) instead of being
    /// retried by every list view during a Seerr outage.</item>
    /// <item>Bounded: at most <see cref="MaxEntries"/> rows; a larger Seerr leaves the snapshot incomplete (unknown, never
    /// a false "absent").</item>
    /// </list>
    /// </summary>
    public sealed class SeerrMediaIndex
    {
        /// <summary>Age after which a lookup triggers a full rebuild.</summary>
        public static readonly TimeSpan FullRebuildInterval = TimeSpan.FromMinutes(20);

        /// <summary>Minimum spacing of advisory (recently modified) refreshes.</summary>
        public static readonly TimeSpan AdvisoryInterval = TimeSpan.FromSeconds(60);

        /// <summary>Per-request timeout towards Seerr.</summary>
        public static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(15);

        /// <summary>Row cap of one snapshot.</summary>
        public const int MaxEntries = 200_000;

        /// <summary>Rows per full-rebuild page (kept well below the 8 MiB response cap).</summary>
        public const int PageSize = 500;

        /// <summary>First wait after a failed rebuild before the next one is started on demand.</summary>
        public static readonly TimeSpan FailureBackoff = TimeSpan.FromSeconds(60);

        /// <summary>Rows per request-listing page (request rows carry users and seasons, so smaller pages).</summary>
        public const int RequestPageSize = 100;

        private const int RequestMaxPages = 50;
        private static readonly TimeSpan MaxFailureBackoff = TimeSpan.FromMinutes(10);
        private const int AdvisoryPageSize = 100;
        private const int AdvisoryMaxPages = 5;
        private static readonly TimeSpan AdvisoryOverlap = TimeSpan.FromMinutes(2);

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Logger _logger;
        private readonly object _gate = new();
        private readonly ConcurrentDictionary<string, OverlayEntry> _overlay = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, RequestOverlayEntry> _requestOverlay = new(StringComparer.Ordinal);

        private volatile Snapshot? _snapshot;
        private Task? _rebuild;
        private Task? _advisory;
        private DateTime _lastAdvisoryUtc = DateTime.MinValue;
        private int _failures;
        private DateTime _retryAfterUtc = DateTime.MinValue;
        private string? _failedFingerprint;

        /// <summary>Creates the index (singleton).</summary>
        /// <param name="httpClientFactory">HTTP client factory.</param>
        /// <param name="logger">JE logger.</param>
        public SeerrMediaIndex(IHttpClientFactory httpClientFactory, Logger logger)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
        }

        /// <summary>Tri-state lookup result kind.</summary>
        public enum LookupState
        {
            /// <summary>No complete snapshot yet (or Seerr off): nothing can be said.</summary>
            Unknown,

            /// <summary>A complete snapshot has no row: never requested (status 1).</summary>
            Absent,

            /// <summary>Seerr has a media row.</summary>
            Indexed,
        }

        /// <summary>Status of one season.</summary>
        /// <param name="Status">Seerr media status.</param>
        /// <param name="Status4k">4K status.</param>
        public readonly record struct SeasonStatus(int Status, int Status4k);

        /// <summary>A Seerr media row (only the fields JE needs).</summary>
        /// <param name="Status">Media status (1 unknown, 2 pending, 3 processing, 4 partially available, 5 available, 6 blocklisted, 7 deleted).</param>
        /// <param name="Status4k">4K status.</param>
        /// <param name="Seasons">Season statuses (TV).</param>
        /// <param name="UpdatedAtUtc">Seerr's updatedAt.</param>
        public sealed record MediaStatusEntry(int Status, int Status4k, IReadOnlyDictionary<int, SeasonStatus> Seasons, DateTime? UpdatedAtUtc);

        /// <summary>The outcome of <see cref="Lookup"/>.</summary>
        /// <param name="State">Lookup state.</param>
        /// <param name="Entry">The row when indexed.</param>
        public readonly record struct LookupResult(LookupState State, MediaStatusEntry? Entry)
        {
            /// <summary>
            /// The status to show for a placeholder: season kinds use their season's status (absent season = 1),
            /// everything else the media status; null while unknown.
            /// </summary>
            /// <param name="seasonNumber">Season number for season/episodes placeholders, else null.</param>
            /// <returns>Status or null.</returns>
            public int? StatusFor(int? seasonNumber)
            {
                return State switch
                {
                    LookupState.Absent => 1,
                    LookupState.Indexed when seasonNumber.HasValue => Entry!.Seasons.TryGetValue(seasonNumber.Value, out var season) ? season.Status : 1,
                    LookupState.Indexed => Entry!.Status,
                    _ => null,
                };
            }
        }

        /// <summary>True when a complete snapshot for the current Seerr configuration exists.</summary>
        public bool IsReady
        {
            get
            {
                var snapshot = _snapshot;
                return snapshot != null && snapshot.Complete && snapshot.Fingerprint == Fingerprint();
            }
        }

        /// <summary>
        /// True when the last full rebuild for the current Seerr configuration failed: views then answer at once
        /// (<c>seerrStatusReady:false</c>) instead of waiting for retries during an outage.
        /// </summary>
        public bool LastRebuildFailed
        {
            get
            {
                lock (_gate)
                {
                    return _failures > 0 && _failedFingerprint == Fingerprint();
                }
            }
        }

        /// <summary>When the current snapshot was built (UTC), if any.</summary>
        public DateTime? BuiltAtUtc => _snapshot?.BuiltAtUtc;

        /// <summary>Number of rows in the current snapshot.</summary>
        public int Count => _snapshot?.Map.Count ?? 0;

        /// <summary>Looks a title up.</summary>
        /// <param name="mediaType">"movie" or "tv".</param>
        /// <param name="tmdbId">TMDB id.</param>
        /// <returns>The tri-state result.</returns>
        public LookupResult Lookup(string mediaType, int tmdbId)
        {
            var key = Key(mediaType, tmdbId);
            var snapshot = _snapshot;
            var fingerprint = Fingerprint();
            if (snapshot != null && snapshot.Fingerprint != fingerprint)
            {
                snapshot = null;
            }

            LookupResult result;
            if (_overlay.TryGetValue(key, out var overlay) && overlay.Fingerprint == fingerprint
                && (snapshot == null || overlay.WrittenAtUtc >= snapshot.StartedAtUtc))
            {
                result = new LookupResult(LookupState.Indexed, overlay.Entry);
            }
            else if (snapshot == null)
            {
                return new LookupResult(LookupState.Unknown, null);
            }
            else if (snapshot.Map.TryGetValue(key, out var entry))
            {
                result = new LookupResult(LookupState.Indexed, entry);
            }
            else
            {
                result = new LookupResult(snapshot.Complete ? LookupState.Absent : LookupState.Unknown, null);
            }

            var requested = RequestedSeasons(key, snapshot, fingerprint);
            if (requested == null || requested.Count == 0 || result.State == LookupState.Unknown)
            {
                return result;
            }

            var media = result.Entry ?? new MediaStatusEntry(1, 1, new Dictionary<int, SeasonStatus>(), null);
            return new LookupResult(LookupState.Indexed, media with { Seasons = MergeRequested(media.Seasons, requested) });
        }

        /// <summary>
        /// Makes sure the index is (being) refreshed: starts a full rebuild when there is no snapshot for the current
        /// configuration or it is older than <see cref="FullRebuildInterval"/>, else an advisory refresh at most every
        /// <see cref="AdvisoryInterval"/>. Single-flight. The returned task completes when a running full rebuild ends
        /// (callers wait on it with their own short deadline).
        /// </summary>
        /// <returns>The running rebuild, or a completed task.</returns>
        public Task EnsureFreshAsync()
        {
            if (!TryGetSeerrConfig(out _, out _))
            {
                return Task.CompletedTask;
            }

            lock (_gate)
            {
                var snapshot = _snapshot;
                var now = DateTime.UtcNow;
                var stale = snapshot == null
                    || snapshot.Fingerprint != Fingerprint()
                    || now - snapshot.BuiltAtUtc >= FullRebuildInterval;
                if (stale)
                {
                    if (_rebuild == null || _rebuild.IsCompleted)
                    {
                        if (now < _retryAfterUtc && _failedFingerprint == Fingerprint())
                        {
                            return Task.CompletedTask; // backing off after a failed rebuild: answer without waiting
                        }

                        _rebuild = Task.Run(RebuildAsync);
                    }

                    return _rebuild;
                }

                if (now - _lastAdvisoryUtc >= AdvisoryInterval && (_advisory == null || _advisory.IsCompleted)
                    && (_rebuild == null || _rebuild.IsCompleted))
                {
                    _lastAdvisoryUtc = now;
                    _advisory = Task.Run(AdvisoryRefreshAsync);
                }

                return _rebuild ?? Task.CompletedTask;
            }
        }

        /// <summary>Starts (or joins) a full rebuild regardless of the snapshot's age.</summary>
        /// <returns>The running rebuild.</returns>
        internal Task ForceRebuildAsync()
        {
            lock (_gate)
            {
                if (_rebuild == null || _rebuild.IsCompleted)
                {
                    _rebuild = Task.Run(RebuildAsync);
                }

                return _rebuild;
            }
        }

        /// <summary>Writes a status JE learned itself (e.g. from its own request) into the index.</summary>
        /// <param name="mediaType">"movie" or "tv".</param>
        /// <param name="tmdbId">TMDB id.</param>
        /// <param name="entry">The row.</param>
        public void Record(string mediaType, int tmdbId, MediaStatusEntry entry)
        {
            if (tmdbId <= 0 || (mediaType != "movie" && mediaType != "tv"))
            {
                return;
            }

            if (_overlay.Count >= MaxEntries)
            {
                _overlay.Clear(); // pathological; the next rebuild covers everything again
            }

            _overlay[Key(mediaType, tmdbId)] = new OverlayEntry(entry, DateTime.UtcNow, Fingerprint());
        }

        /// <summary>
        /// Records the <c>media</c> object of a Seerr <c>POST /api/v1/request</c> response (best effort, ignores
        /// anything it doesn't understand).
        /// </summary>
        /// <param name="requestResponseJson">Response body.</param>
        public void RecordRequestResponse(string? requestResponseJson)
        {
            if (string.IsNullOrEmpty(requestResponseJson))
            {
                return;
            }

            try
            {
                using var document = JsonDocument.Parse(requestResponseJson);
                if (document.RootElement.ValueKind == JsonValueKind.Object
                    && document.RootElement.TryGetProperty("media", out var media)
                    && TryParseRow(media, out var mediaType, out var tmdbId, out var entry))
                {
                    Record(mediaType, tmdbId, entry);
                }

                // A TV request's seasons are on the request itself (media.seasons is empty until a scan).
                if (TryParseRequest(document.RootElement, out var key, out var seasons))
                {
                    RecordRequestedSeasons(key, seasons, DateTime.UtcNow);
                }
            }
            catch (JsonException)
            {
                // not a request body we understand; nothing to record
            }
        }

        /// <summary>Forgets everything (e.g. after a Seerr configuration change).</summary>
        public void Invalidate()
        {
            lock (_gate)
            {
                _snapshot = null;
                _overlay.Clear();
                _requestOverlay.Clear();
                _lastAdvisoryUtc = DateTime.MinValue;
                _failures = 0;
                _retryAfterUtc = DateTime.MinValue;
                _failedFingerprint = null;
            }
        }

        /// <summary>Parses one <c>/api/v1/media</c> row.</summary>
        /// <param name="row">JSON row.</param>
        /// <param name="mediaType">"movie" or "tv".</param>
        /// <param name="tmdbId">TMDB id.</param>
        /// <param name="entry">Parsed entry.</param>
        /// <returns>Whether the row was usable.</returns>
        internal static bool TryParseRow(JsonElement row, out string mediaType, out int tmdbId, out MediaStatusEntry entry)
        {
            mediaType = string.Empty;
            tmdbId = 0;
            entry = null!;
            if (row.ValueKind != JsonValueKind.Object
                || !row.TryGetProperty("mediaType", out var typeElement) || typeElement.ValueKind != JsonValueKind.String
                || !row.TryGetProperty("tmdbId", out var idElement) || idElement.ValueKind != JsonValueKind.Number
                || !idElement.TryGetInt32(out tmdbId) || tmdbId <= 0)
            {
                return false;
            }

            mediaType = typeElement.GetString() ?? string.Empty;
            if (mediaType != "movie" && mediaType != "tv")
            {
                return false;
            }

            var seasons = new Dictionary<int, SeasonStatus>();
            if (row.TryGetProperty("seasons", out var seasonsElement) && seasonsElement.ValueKind == JsonValueKind.Array)
            {
                foreach (var season in seasonsElement.EnumerateArray())
                {
                    if (season.ValueKind == JsonValueKind.Object
                        && season.TryGetProperty("seasonNumber", out var n) && n.ValueKind == JsonValueKind.Number && n.TryGetInt32(out var number))
                    {
                        seasons[number] = new SeasonStatus(ReadInt(season, "status", 1), ReadInt(season, "status4k", 1));
                    }
                }
            }

            DateTime? updatedAt = null;
            if (row.TryGetProperty("updatedAt", out var updated) && updated.ValueKind == JsonValueKind.String
                && DateTime.TryParse(updated.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var parsed))
            {
                updatedAt = parsed;
            }

            entry = new MediaStatusEntry(ReadInt(row, "status", 1), ReadInt(row, "status4k", 1), seasons, updatedAt);
            return true;
        }

        /// <summary>
        /// Parses one Seerr TV request (<c>POST /api/v1/request</c> response or a <c>/api/v1/request</c> row) into its
        /// per-season request state: an active (pending/approved) request maps to media status 2/3 on the resolution it
        /// was made for (<c>is4k</c>); an inactive one (declined/failed/completed) to 1 = "no active request".
        /// Fields of the other resolution stay 0 (no information).
        /// </summary>
        /// <param name="request">JSON request.</param>
        /// <param name="key">Index key of the title.</param>
        /// <param name="seasons">Season → request state.</param>
        /// <returns>Whether it was a usable TV request.</returns>
        internal static bool TryParseRequest(JsonElement request, out string key, out Dictionary<int, SeasonStatus> seasons)
        {
            key = string.Empty;
            seasons = new Dictionary<int, SeasonStatus>();
            if (request.ValueKind != JsonValueKind.Object
                || !request.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String || type.GetString() != "tv"
                || !request.TryGetProperty("media", out var media) || media.ValueKind != JsonValueKind.Object
                || !media.TryGetProperty("tmdbId", out var idElement) || idElement.ValueKind != JsonValueKind.Number
                || !idElement.TryGetInt32(out var tmdbId) || tmdbId <= 0
                || !request.TryGetProperty("seasons", out var seasonsElement) || seasonsElement.ValueKind != JsonValueKind.Array)
            {
                return false;
            }

            var is4k = request.TryGetProperty("is4k", out var is4kElement) && is4kElement.ValueKind == JsonValueKind.True;
            var requestStatus = ReadInt(request, "status", 0);
            var requestActive = requestStatus is RequestPending or RequestApproved;
            foreach (var season in seasonsElement.EnumerateArray())
            {
                if (season.ValueKind != JsonValueKind.Object
                    || !season.TryGetProperty("seasonNumber", out var n) || n.ValueKind != JsonValueKind.Number || !n.TryGetInt32(out var number))
                {
                    continue;
                }

                var seasonStatus = ReadInt(season, "status", requestStatus);
                var status = !requestActive ? 1 : seasonStatus switch
                {
                    RequestPending => 2,
                    RequestApproved => 3,
                    _ => 1,
                };
                seasons[number] = is4k ? new SeasonStatus(0, status) : new SeasonStatus(status, 0);
            }

            key = Key("tv", tmdbId);
            return true;
        }

        // Seerr MediaRequestStatus values.
        private const int RequestPending = 1;
        private const int RequestApproved = 2;

        // Later information wins per field; 0 means "no information" and keeps the earlier value.
        private static void Combine(Dictionary<int, SeasonStatus> target, IReadOnlyDictionary<int, SeasonStatus> newer)
        {
            foreach (var pair in newer)
            {
                target.TryGetValue(pair.Key, out var current);
                target[pair.Key] = new SeasonStatus(
                    pair.Value.Status != 0 ? pair.Value.Status : current.Status,
                    pair.Value.Status4k != 0 ? pair.Value.Status4k : current.Status4k);
            }
        }

        // Availability rows win when they say something (anything but unknown/deleted); otherwise an active request.
        private static IReadOnlyDictionary<int, SeasonStatus> MergeRequested(IReadOnlyDictionary<int, SeasonStatus> available, IReadOnlyDictionary<int, SeasonStatus> requested)
        {
            static int Pick(int? availability, int request) =>
                availability is int value && value != 1 && value != 7 ? value : request > 1 ? request : availability ?? 1;

            var merged = new Dictionary<int, SeasonStatus>(available);
            foreach (var pair in requested)
            {
                SeasonStatus? row = available.TryGetValue(pair.Key, out var existing) ? existing : null;
                merged[pair.Key] = new SeasonStatus(Pick(row?.Status, pair.Value.Status), Pick(row?.Status4k, pair.Value.Status4k));
            }

            return merged;
        }

        private IReadOnlyDictionary<int, SeasonStatus>? RequestedSeasons(string key, Snapshot? snapshot, string fingerprint)
        {
            if (_requestOverlay.TryGetValue(key, out var overlay) && overlay.Fingerprint == fingerprint
                && (snapshot == null || overlay.WrittenAtUtc >= snapshot.StartedAtUtc))
            {
                return overlay.Seasons;
            }

            return snapshot != null && snapshot.Requests.TryGetValue(key, out var seasons) ? seasons : null;
        }

        private void RecordRequestedSeasons(string key, IReadOnlyDictionary<int, SeasonStatus> seasons, DateTime writtenAtUtc)
        {
            var fingerprint = Fingerprint();
            lock (_gate)
            {
                var snapshot = _snapshot;
                if (snapshot != null && snapshot.Fingerprint != fingerprint)
                {
                    snapshot = null;
                }

                var merged = new Dictionary<int, SeasonStatus>();
                var current = RequestedSeasons(key, snapshot, fingerprint);
                if (current != null)
                {
                    Combine(merged, current);
                }

                Combine(merged, seasons);
                if (_requestOverlay.Count >= MaxEntries)
                {
                    _requestOverlay.Clear();
                }

                _requestOverlay[key] = new RequestOverlayEntry(merged, writtenAtUtc, fingerprint);
            }
        }

        private static int ReadInt(JsonElement element, string name, int fallback) =>
            element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var result) ? result : fallback;

        private static string Key(string mediaType, int tmdbId) => mediaType + "|" + tmdbId.ToString(CultureInfo.InvariantCulture);

        private static bool TryGetSeerrConfig(out string[] urls, out string apiKey)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            urls = Array.Empty<string>();
            apiKey = string.Empty;
            if (config == null || !config.JellyseerrEnabled || string.IsNullOrWhiteSpace(config.JellyseerrUrls) || string.IsNullOrWhiteSpace(config.JellyseerrApiKey))
            {
                return false;
            }

            urls = config.JellyseerrUrls
                .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(u => u.Trim().TrimEnd('/'))
                .Where(u => u.Length > 0)
                .ToArray();
            apiKey = config.JellyseerrApiKey;
            return urls.Length > 0;
        }

        // Identifies the Seerr instance a snapshot belongs to (URL list + key hash), so a config change never serves
        // another server's statuses.
        private static string Fingerprint()
        {
            if (!TryGetSeerrConfig(out var urls, out var apiKey))
            {
                return string.Empty;
            }

            var joined = string.Join('\n', urls);
            var cached = _fingerprintCache;
            if (cached != null && cached.Urls == joined && cached.ApiKey == apiKey)
            {
                return cached.Value;
            }

            var hash = SHA256.HashData(Encoding.UTF8.GetBytes(apiKey));
            var value = joined + "|" + Convert.ToHexString(hash, 0, 8);
            _fingerprintCache = new FingerprintCache(joined, apiKey, value);
            return value;
        }

        private sealed record FingerprintCache(string Urls, string ApiKey, string Value);

        private static volatile FingerprintCache? _fingerprintCache;

        private async Task RebuildAsync()
        {
            if (!TryGetSeerrConfig(out var urls, out var apiKey))
            {
                return;
            }

            var fingerprint = Fingerprint();
            var started = DateTime.UtcNow;
            foreach (var baseUrl in urls)
            {
                try
                {
                    var map = new Dictionary<string, MediaStatusEntry>(StringComparer.Ordinal);
                    var complete = false;
                    for (var skip = 0; ; skip += PageSize)
                    {
                        var rows = await FetchPageAsync(baseUrl, apiKey, $"/api/v1/media?take={PageSize}&skip={skip}").ConfigureAwait(false);
                        if (rows == null)
                        {
                            throw new HttpRequestException("Seerr media page could not be read.");
                        }

                        foreach (var row in rows.Rows)
                        {
                            map[Key(row.MediaType, row.TmdbId)] = row.Entry;
                        }

                        if (rows.RawCount < PageSize)
                        {
                            complete = true;
                            break;
                        }

                        if (map.Count >= MaxEntries)
                        {
                            _logger.Warning($"[ListPlaceholders] Seerr has more than {MaxEntries} media rows; status badges beyond that stay unknown.");
                            break;
                        }
                    }

                    var requests = await FetchActiveRequestsAsync(baseUrl, apiKey).ConfigureAwait(false);
                    var snapshot = new Snapshot(map, requests, complete, started, DateTime.UtcNow, fingerprint);
                    lock (_gate)
                    {
                        _snapshot = snapshot;
                        _failures = 0;
                        _retryAfterUtc = DateTime.MinValue;
                        _failedFingerprint = null;
                        foreach (var pair in _overlay)
                        {
                            if (pair.Value.WrittenAtUtc < started)
                            {
                                _overlay.TryRemove(pair.Key, out _);
                            }
                        }

                        foreach (var pair in _requestOverlay)
                        {
                            if (pair.Value.WrittenAtUtc < started)
                            {
                                _requestOverlay.TryRemove(pair.Key, out _);
                            }
                        }
                    }

                    _logger.Debug($"[ListPlaceholders] Seerr media index rebuilt: {map.Count} rows in {(DateTime.UtcNow - started).TotalMilliseconds:F0} ms.");
                    return;
                }
                catch (Exception ex)
                {
                    _logger.Warning($"[ListPlaceholders] Seerr media index rebuild failed for one Seerr URL: {ex.Message}");
                }
            }

            TimeSpan backoff;
            lock (_gate)
            {
                _failures++;
                backoff = TimeSpan.FromTicks(Math.Min(MaxFailureBackoff.Ticks, FailureBackoff.Ticks << Math.Min(_failures - 1, 10)));
                _retryAfterUtc = DateTime.UtcNow + backoff;
                _failedFingerprint = fingerprint;
            }

            _logger.Warning($"[ListPlaceholders] Seerr media index unavailable; status badges stay unknown and the next attempt is in {backoff.TotalSeconds:F0} s.");
        }

        // The seasons of every active (pending + approved) TV request. Best effort: a failure leaves season request
        // state empty (season badges then show availability only) rather than failing the whole snapshot.
        private async Task<Dictionary<string, Dictionary<int, SeasonStatus>>> FetchActiveRequestsAsync(string baseUrl, string apiKey)
        {
            var result = new Dictionary<string, Dictionary<int, SeasonStatus>>(StringComparer.Ordinal);
            try
            {
                foreach (var filter in new[] { "pending", "approved" })
                {
                    for (var page = 0; page < RequestMaxPages; page++)
                    {
                        var rows = await FetchRequestPageAsync(baseUrl, apiKey, $"/api/v1/request?take={RequestPageSize}&skip={page * RequestPageSize}&filter={filter}&mediaType=tv").ConfigureAwait(false)
                            ?? throw new HttpRequestException("Seerr request page could not be read.");
                        foreach (var row in rows.Rows)
                        {
                            if (!result.TryGetValue(row.Key, out var seasons))
                            {
                                seasons = new Dictionary<int, SeasonStatus>();
                                result[row.Key] = seasons;
                            }

                            Combine(seasons, row.Seasons);
                        }

                        if (rows.RawCount < RequestPageSize)
                        {
                            break;
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"[ListPlaceholders] Reading Seerr's TV requests failed; season request badges stay unknown until the next rebuild: {ex.Message}");
                result.Clear();
            }

            return result;
        }

        private async Task AdvisoryRefreshAsync()
        {
            var snapshot = _snapshot;
            if (snapshot == null || !TryGetSeerrConfig(out var urls, out var apiKey))
            {
                return;
            }

            var fingerprint = Fingerprint();
            var watermark = snapshot.StartedAtUtc - AdvisoryOverlap;
            try
            {
                for (var page = 0; page < AdvisoryMaxPages; page++)
                {
                    var rows = await FetchPageAsync(urls[0], apiKey, $"/api/v1/media?take={AdvisoryPageSize}&skip={page * AdvisoryPageSize}&sort=modified").ConfigureAwait(false);
                    if (rows == null)
                    {
                        return;
                    }

                    var reachedWatermark = false;
                    foreach (var row in rows.Rows)
                    {
                        if (row.Entry.UpdatedAtUtc.HasValue && row.Entry.UpdatedAtUtc.Value < watermark)
                        {
                            reachedWatermark = true;
                            break;
                        }

                        _overlay[Key(row.MediaType, row.TmdbId)] = new OverlayEntry(row.Entry, DateTime.UtcNow, fingerprint);
                    }

                    if (reachedWatermark || rows.RawCount < AdvisoryPageSize)
                    {
                        break;
                    }
                }

                // Recently modified TV requests (any status, newest first): new, approved, declined or completed seasons.
                var recent = new List<RequestRow>();
                for (var page = 0; page < AdvisoryMaxPages; page++)
                {
                    var rows = await FetchRequestPageAsync(urls[0], apiKey, $"/api/v1/request?take={AdvisoryPageSize}&skip={page * AdvisoryPageSize}&sort=modified&mediaType=tv").ConfigureAwait(false);
                    if (rows == null)
                    {
                        break;
                    }

                    var reachedWatermark = false;
                    foreach (var row in rows.Rows)
                    {
                        if (row.UpdatedAtUtc.HasValue && row.UpdatedAtUtc.Value < watermark)
                        {
                            reachedWatermark = true;
                            break;
                        }

                        recent.Add(row);
                    }

                    if (reachedWatermark || rows.RawCount < AdvisoryPageSize)
                    {
                        break;
                    }
                }

                // Oldest first, so the newest request for a season wins.
                var now = DateTime.UtcNow;
                for (var i = recent.Count - 1; i >= 0; i--)
                {
                    if (Fingerprint() == fingerprint)
                    {
                        RecordRequestedSeasons(recent[i].Key, recent[i].Seasons, now);
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.Debug($"[ListPlaceholders] Seerr advisory refresh failed: {ex.Message}");
            }
        }

        private async Task<RequestPage?> FetchRequestPageAsync(string baseUrl, string apiKey, string apiPath)
        {
            using var cts = new CancellationTokenSource(RequestTimeout);
            var url = baseUrl + apiPath;
            var client = SeerrHttpHelper.CreateClient(_httpClientFactory);
            using var request = SeerrHttpHelper.BuildRequest(HttpMethod.Get, url, apiKey);
            using var response = await client.SendAsync(request, cts.Token).ConfigureAwait(false);
            var (json, error) = await SeerrHttpHelper.ReadResponseAsync(response, url, cts.Token).ConfigureAwait(false);
            if (error != null || json == null)
            {
                _logger.Debug($"[ListPlaceholders] Seerr request page failed: {error?.Code}");
                return null;
            }

            using var document = JsonDocument.Parse(json);
            if (document.RootElement.ValueKind != JsonValueKind.Object
                || !document.RootElement.TryGetProperty("results", out var results)
                || results.ValueKind != JsonValueKind.Array)
            {
                return null;
            }

            var rows = new List<RequestRow>(results.GetArrayLength());
            foreach (var row in results.EnumerateArray())
            {
                if (TryParseRequest(row, out var key, out var seasons))
                {
                    DateTime? updatedAt = null;
                    if (row.TryGetProperty("updatedAt", out var updated) && updated.ValueKind == JsonValueKind.String
                        && DateTime.TryParse(updated.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var parsed))
                    {
                        updatedAt = parsed;
                    }

                    rows.Add(new RequestRow(key, seasons, updatedAt));
                }
            }

            return new RequestPage(results.GetArrayLength(), rows);
        }

        private async Task<Page?> FetchPageAsync(string baseUrl, string apiKey, string apiPath)
        {
            using var cts = new CancellationTokenSource(RequestTimeout);
            var url = baseUrl + apiPath;
            var client = SeerrHttpHelper.CreateClient(_httpClientFactory);
            using var request = SeerrHttpHelper.BuildRequest(HttpMethod.Get, url, apiKey);
            using var response = await client.SendAsync(request, cts.Token).ConfigureAwait(false);
            var (json, error) = await SeerrHttpHelper.ReadResponseAsync(response, url, cts.Token).ConfigureAwait(false);
            if (error != null || json == null)
            {
                _logger.Debug($"[ListPlaceholders] Seerr media page failed: {error?.Code}");
                return null;
            }

            using var document = JsonDocument.Parse(json);
            if (document.RootElement.ValueKind != JsonValueKind.Object
                || !document.RootElement.TryGetProperty("results", out var results)
                || results.ValueKind != JsonValueKind.Array)
            {
                return null;
            }

            var rows = new List<Row>(results.GetArrayLength());
            foreach (var row in results.EnumerateArray())
            {
                if (TryParseRow(row, out var mediaType, out var tmdbId, out var entry))
                {
                    rows.Add(new Row(mediaType, tmdbId, entry));
                }
            }

            // RawCount (not rows.Count) decides "last page": an unparseable row must not end paging early.
            return new Page(results.GetArrayLength(), rows);
        }

        private sealed record Row(string MediaType, int TmdbId, MediaStatusEntry Entry);

        private sealed record Page(int RawCount, List<Row> Rows);

        private sealed record RequestRow(string Key, Dictionary<int, SeasonStatus> Seasons, DateTime? UpdatedAtUtc);

        private sealed record RequestPage(int RawCount, List<RequestRow> Rows);

        private sealed record Snapshot(Dictionary<string, MediaStatusEntry> Map, Dictionary<string, Dictionary<int, SeasonStatus>> Requests, bool Complete, DateTime StartedAtUtc, DateTime BuiltAtUtc, string Fingerprint);

        private sealed record OverlayEntry(MediaStatusEntry Entry, DateTime WrittenAtUtc, string Fingerprint);

        private sealed record RequestOverlayEntry(Dictionary<int, SeasonStatus> Seasons, DateTime WrittenAtUtc, string Fingerprint);
    }
}
