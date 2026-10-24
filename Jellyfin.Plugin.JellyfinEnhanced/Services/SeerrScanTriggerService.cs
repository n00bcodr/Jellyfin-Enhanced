using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    // Debounced bridge from Jellyfin's library ItemAdded event to Seerr's
    // /api/v1/settings/jobs/jellyfin-recently-added-scan/run endpoint, so admins can
    // disable Seerr's 5-minute cron and have the scan run only when Jellyfin actually
    // ingests new content.
    //
    // Scan nudges have one owner per (Seerr, job): every nudge for the same Seerr and job joins
    // one pending batch, which fires `debounce` seconds after its last change but never later than
    // min(4 x debounce, 1 hour) after its first, so a steady trickle of additions can't postpone the
    // scan forever. Before /run the owner reads Seerr's job list: /run would abort a scan that is
    // already running, so a running job gets one coalesced follow-up instead. Each batch goes to the
    // first configured address that answers (they are the same Seerr). In Jellyfin Enhanced request
    // mode (phase 3), a title JE added to Radarr/Sonarr also nudges Seerr's Radarr/Sonarr scan, so
    // Seerr's status stays right for anyone still browsing it.
    public class SeerrScanTriggerService : IDisposable
    {
        public const string ScanJobId = "jellyfin-recently-added-scan";
        public const string RadarrScanJobId = "radarr-scan";
        public const string SonarrScanJobId = "sonarr-scan";
        private const int MinDebounceSeconds = 5;
        private const int MaxDebounceSeconds = 3600;

        private readonly ILibraryManager _libraryManager;
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Logger _logger;
        private readonly RequestOutboxEvents? _outboxEvents;
        private readonly Func<DateTimeOffset> _now;
        private readonly Func<PluginConfiguration?> _config;

        private readonly object _stateLock = new();
        private readonly Dictionary<(string Source, string Job), Owner> _owners = new();
        private bool _subscribed;
        private bool _disposed;
        // The last address list and its fingerprint (library scans nudge once per added item); one reference, swapped whole.
        private sealed record SourceCache(string? Urls, string Source);
        private volatile SourceCache? _source;

        // One pending batch of nudges for one Seerr and job.
        private sealed class Owner
        {
            public Owner(string job) { Job = job; }
            public string Job { get; }
            public Timer? Timer { get; set; }
            public DateTimeOffset FirstPendingAt { get; set; }
            public int Pending { get; set; }
            public bool Dispatching { get; set; }
            public bool FollowUp { get; set; }
            public Task? Last { get; set; }
        }

        public SeerrScanTriggerService(
            ILibraryManager libraryManager,
            IHttpClientFactory httpClientFactory,
            Logger logger,
            RequestOutboxEvents? outboxEvents = null)
            : this(libraryManager, httpClientFactory, logger, outboxEvents, () => DateTimeOffset.UtcNow, () => JellyfinEnhanced.Instance?.Configuration)
        {
        }

        internal SeerrScanTriggerService(ILibraryManager libraryManager, IHttpClientFactory httpClientFactory, Logger logger, RequestOutboxEvents? outboxEvents,
            Func<DateTimeOffset> now, Func<PluginConfiguration?> config)
        {
            _libraryManager = libraryManager;
            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _outboxEvents = outboxEvents;
            _now = now;
            _config = config;
        }

        public void Initialize()
        {
            // Always subscribe; the per-event handler re-checks config at fire time so
            // an admin toggling the feature on doesn't require a Jellyfin restart.
            // Mirrors the WatchlistMonitor pattern.
            lock (_stateLock)
            {
                if (_subscribed) return;
                _libraryManager.ItemAdded += OnItemAdded;
                if (_outboxEvents != null) _outboxEvents.Confirmed += OnRequestConfirmed;
                _subscribed = true;
            }
            _logger.Info("[SeerrScan] Subscribed to library ItemAdded events");
        }

        private void OnItemAdded(object? sender, ItemChangeEventArgs e)
        {
            // Fires synchronously on Jellyfin's library-scan thread — only cheap config/kind
            // checks then a counter bump + timer change here; the Seerr calls run off the timer thread.
            try
            {
                if (_config() is not PluginConfiguration config) return;
                if (!config.TriggerSeerrScanOnItemAdded) return;
                if (!EffectiveRequestsBackend.AllowsSeerr(config) || !config.JellyseerrEnabled) return;

                // Seerr's recently-added scan only inspects movies and series (and crawls
                // their seasons/episodes itself). Filtering on the parent kinds avoids
                // triggering on metadata noise (BoxSet, Folder, Audio, Photo, etc).
                var kind = e.Item?.GetBaseItemKind();
                if (kind != BaseItemKind.Movie
                    && kind != BaseItemKind.Series
                    && kind != BaseItemKind.Season
                    && kind != BaseItemKind.Episode)
                {
                    return;
                }

                Nudge(ScanJobId);
            }
            catch (Exception ex)
            {
                _logger.Warning($"[SeerrScan] OnItemAdded handler threw: {ex.Message}");
            }
        }

        // JE mode: a title Jellyfin Enhanced added to Radarr/Sonarr nudges Seerr's matching arr scan.
        private void OnRequestConfirmed(RequestJob job)
        {
            var config = _config();
            if (!EffectiveRequestsBackend.AllowsSeerr(config) || config is not { TriggerSeerrScanOnItemAdded: true, JellyseerrEnabled: true } || !SharedRequestFacts.LedgerAuthority(config)) return;
            if (job.Authorization.Backend != "je" || TitleKey.Parse(job.Input.Key) is not { } key) return;
            Nudge(key.IsMovie ? RadarrScanJobId : SonarrScanJobId);
        }

        // The owner key of the configured Seerr: its address set (a key rotation is the same Seerr).
        private string SourceOf(PluginConfiguration config)
        {
            var cached = _source;
            if (cached != null && cached.Urls == config.JellyseerrUrls) return cached.Source;
            var source = SeerrFacts.AddressFingerprint(config);
            _source = new SourceCache(config.JellyseerrUrls, source);
            return source;
        }

        /// <summary>
        /// Adds one change to the (Seerr, job) owner's pending batch and (re)arms its timer: debounce
        /// seconds after this change, capped at min(4 x debounce, 1 hour) after the batch's first change.
        /// Constant time; safe on event threads.
        /// </summary>
        public void Nudge(string jobId, int count = 1)
        {
            var config = _config();
            if (!EffectiveRequestsBackend.AllowsSeerr(config) || config == null || !config.JellyseerrEnabled) return;
            var source = SourceOf(config);
            var debounce = TimeSpan.FromSeconds(ClampDebounceSeconds(config.SeerrScanDebounceSeconds));
            lock (_stateLock)
            {
                if (_disposed) return;
                if (!_owners.TryGetValue((source, jobId), out var owner))
                {
                    owner = new Owner(jobId);
                    owner.Timer = new Timer(_ => OnOwnerDue(owner, source), null, Timeout.Infinite, Timeout.Infinite);
                    _owners[(source, jobId)] = owner;
                }
                var now = _now();
                if (owner.Pending == 0) owner.FirstPendingAt = now;
                owner.Pending += Math.Max(1, count);
                if (owner.Dispatching) { owner.FollowUp = true; return; }
                Arm(owner, debounce, now);
            }
        }

        // Due at the debounce after now, but no later than the cap after the batch's first change.
        private static void Arm(Owner owner, TimeSpan debounce, DateTimeOffset now)
        {
            var cap = TimeSpan.FromSeconds(Math.Min(4 * debounce.TotalSeconds, MaxDebounceSeconds));
            var due = owner.FirstPendingAt + cap < now + debounce ? owner.FirstPendingAt + cap : now + debounce;
            var wait = due - now;
            owner.Timer?.Change(wait < TimeSpan.Zero ? TimeSpan.Zero : wait, Timeout.InfiniteTimeSpan);
        }

        /// <summary>When the (Seerr, job) owner's batch is due, as an offset from now; null when nothing is pending (tests).</summary>
        internal TimeSpan? DueIn(string jobId)
        {
            var config = _config();
            if (config == null) return null;
            lock (_stateLock)
            {
                if (!_owners.TryGetValue((SourceOf(config), jobId), out var owner) || owner.Pending == 0) return null;
                var debounce = TimeSpan.FromSeconds(ClampDebounceSeconds(config.SeerrScanDebounceSeconds));
                var cap = TimeSpan.FromSeconds(Math.Min(4 * debounce.TotalSeconds, MaxDebounceSeconds));
                var now = _now();
                return owner.FirstPendingAt + cap - now;
            }
        }

        /// <summary>Fires an owner's batch now (tests stand in for the timer); returns the dispatch task.</summary>
        internal Task FireAsync(string jobId)
        {
            var config = _config();
            if (config == null) return Task.CompletedTask;
            var source = SourceOf(config);
            Owner? owner;
            lock (_stateLock) _owners.TryGetValue((source, jobId), out owner);
            if (owner == null) return Task.CompletedTask;
            OnOwnerDue(owner, source);
            lock (_stateLock) return owner.Last ?? Task.CompletedTask;
        }

        private void OnOwnerDue(Owner owner, string source)
        {
            int batch;
            lock (_stateLock)
            {
                if (_disposed || owner.Pending == 0) return;
                if (owner.Dispatching) { owner.FollowUp = true; return; }
                batch = owner.Pending;
                owner.Pending = 0;
                owner.Dispatching = true;
            }
            // Started outside the lock; the timer thread doesn't wait for the HTTP calls.
            var dispatch = DispatchOwnerAsync(owner, source, batch);
            lock (_stateLock) owner.Last = dispatch;
        }

        // The automatic scan trigger is on (live configuration).
        private bool On() => EffectiveRequestsBackend.AllowsSeerr(_config()) && _config() is { TriggerSeerrScanOnItemAdded: true, JellyseerrEnabled: true };

        private Task DispatchOwnerAsync(Owner owner, string source, int batch)
            => Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.BackgroundAsync(token => DispatchOwnerAsyncFactsCore(owner, source, batch), CancellationToken.None);

        private async Task DispatchOwnerAsyncFactsCore(Owner owner, string source, int batch)
        {
            var requeue = false;
            try
            {
                if (_config() is not PluginConfiguration config || SourceOf(config) != source) return;
                // The switch was checked when the changes arrived, up to an hour ago: read it again here and right
                // before each run; turned off since, the batch is dropped.
                if (!On()) return;
                if (!EffectiveRequestsBackend.AllowsSeerr(config))
                {
                    _logger.Info("[RequestsBackend] Seerr scan denied: backend_disabled");
                    return;
                }
                var apiKey = config.GetJellyseerrApiKey();
                var urls = ParseUrls(config.JellyseerrUrls);
                if (urls.Count == 0 || string.IsNullOrEmpty(apiKey))
                {
                    _logger.Warning("[SeerrScan] Cannot dispatch: Seerr URL(s) or API key not configured");
                    return;
                }
                foreach (var url in urls)
                {
                    // Unknown (the job list couldn't be read) posts as before; only a known running scan waits.
                    var running = await IsRunningAsync(url, apiKey, owner.Job).ConfigureAwait(false);
                    if (running == true)
                    {
                        // /run would abort the scan in progress: one coalesced follow-up instead.
                        _logger.Info($"[SeerrScan] Seerr's {owner.Job} is already running; one follow-up after it ({batch} change(s) pending) — {url}");
                        requeue = true;
                        return;
                    }
                    if (!On()) return;
                    var result = await PostScanTrigger(url, apiKey, owner.Job).ConfigureAwait(false);
                    if (result.Success)
                    {
                        _logger.Info($"[SeerrScan] Triggered Seerr {owner.Job} after {batch} change(s) — {url}");
                        return;
                    }
                    _logger.Warning($"[SeerrScan] Trigger failed for {url}: HTTP {result.StatusCode} — {result.Body}");
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"[SeerrScan] Dispatch threw: {ex.Message}");
            }
            finally
            {
                lock (_stateLock)
                {
                    owner.Dispatching = false;
                    if (!_disposed && _config() is PluginConfiguration config)
                    {
                        var debounce = TimeSpan.FromSeconds(ClampDebounceSeconds(config.SeerrScanDebounceSeconds));
                        var now = _now();
                        if (requeue)
                        {
                            if (owner.Pending == 0) owner.FirstPendingAt = now;
                            owner.Pending += batch;
                            owner.FollowUp = false;
                            owner.Timer?.Change(debounce, Timeout.InfiniteTimeSpan);
                        }
                        else if (owner.FollowUp || owner.Pending > 0)
                        {
                            owner.FollowUp = false;
                            Arm(owner, debounce, now);
                        }
                    }
                }
            }
        }

        // True/false from Seerr's job list; null when this address can't be read. A job list without the
        // job (or an older Seerr without the flag) counts as not running, as before.
        private Task<bool?> IsRunningAsync(string url, string apiKey, string jobId)
            => EffectiveRequestsBackend.AllowsSeerr(JellyfinEnhanced.Instance?.Configuration)
                ? Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.RunSeerrAsync(SeerrUse.Metadata, CancellationToken.None, _ => IsRunningAsyncCore(url, apiKey, jobId))
                : IsRunningAsyncCore(url, apiKey, jobId);

        private async Task<bool?> IsRunningAsyncCore(string url, string apiKey, string jobId)
        {
            var endpoint = $"{url.TrimEnd('/')}/api/v1/settings/jobs";
            try
            {
                var http = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
                http.Timeout = TimeSpan.FromSeconds(15);
                using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(HttpMethod.Get, endpoint, apiKey);
                using var response = await http.SendAsync(request).ConfigureAwait(false);
                var (json, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, endpoint).ConfigureAwait(false);
                if (error != null || json == null) return null;
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.ValueKind != JsonValueKind.Array) return false;
                return doc.RootElement.EnumerateArray().Any(j => j.TryGetProperty("id", out var id) && id.GetString() == jobId &&
                    j.TryGetProperty("running", out var running) && running.ValueKind == JsonValueKind.True);
            }
            catch (Exception)
            {
                return null;
            }
        }

        // Public so the admin "Trigger scan now" button (controller endpoint) can
        // bypass the debounce and force a scan immediately.
        public Task<IReadOnlyList<DispatchResult>> TriggerNowAsync()
        {
            return DispatchAsync(0);
        }

        private Task<IReadOnlyList<DispatchResult>> DispatchAsync(int batchSize)
            => Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.BackgroundAsync(token => DispatchAsyncFactsCore(batchSize), CancellationToken.None);

        private async Task<IReadOnlyList<DispatchResult>> DispatchAsyncFactsCore(int batchSize)
        {
            var results = new List<DispatchResult>();
            try
            {
                if (_config() is not PluginConfiguration config)
                {
                    _logger.Warning("[SeerrScan] Cannot dispatch: plugin configuration is null");
                    return results;
                }

                if (!EffectiveRequestsBackend.AllowsSeerr(config))
                {
                    _logger.Info("[RequestsBackend] Seerr scan denied: backend_disabled");
                    return results;
                }
                var apiKey = config.GetJellyseerrApiKey();
                var urls = ParseUrls(config.JellyseerrUrls);
                if (urls.Count == 0 || string.IsNullOrEmpty(apiKey))
                {
                    _logger.Warning("[SeerrScan] Cannot dispatch: Seerr URL(s) or API key not configured");
                    return results;
                }

                foreach (var url in urls)
                {
                    var result = await PostScanTrigger(url, apiKey, ScanJobId).ConfigureAwait(false);
                    results.Add(result);
                    if (result.Success)
                    {
                        if (batchSize > 0)
                            _logger.Info($"[SeerrScan] Triggered Seerr recently-added scan after {batchSize} library item(s) — {url}");
                        else
                            _logger.Info($"[SeerrScan] Triggered Seerr recently-added scan (manual) — {url}");
                    }
                    else
                    {
                        _logger.Warning($"[SeerrScan] Trigger failed for {url}: HTTP {result.StatusCode} — {result.Body}");
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"[SeerrScan] Dispatch threw: {ex.Message}");
            }
            return results;
        }

        private Task<DispatchResult> PostScanTrigger(string url, string apiKey, string jobId)
            => EffectiveRequestsBackend.AllowsSeerr(JellyfinEnhanced.Instance?.Configuration)
                ? Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.RunSeerrAsync(SeerrUse.Metadata, CancellationToken.None, _ => PostScanTriggerCore(url, apiKey, jobId))
                : PostScanTriggerCore(url, apiKey, jobId);

        private async Task<DispatchResult> PostScanTriggerCore(string url, string apiKey, string jobId)
        {
            // previously reported `Success = response.IsSuccessStatusCode`,
            // which is true for a 200 + Cloudflare HTML challenge body — the
            // background trigger logged "scan dispatched" when the request was
            // actually intercepted by a reverse-proxy auth challenge. Use the
            // helper so HTML responses are classified as failures.
            var endpoint = $"{url.TrimEnd('/')}/api/v1/settings/jobs/{jobId}/run";
            try
            {
                var http = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
                http.Timeout = TimeSpan.FromSeconds(15);
                using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                    HttpMethod.Post, endpoint, apiKey, bodyJson: "{}");

                using var response = await http.SendAsync(request).ConfigureAwait(false);
                var (json, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, endpoint).ConfigureAwait(false);
                return new DispatchResult
                {
                    Url = url,
                    Success = error == null,
                    StatusCode = error?.HttpStatus ?? (int)response.StatusCode,
                    Body = Truncate(error?.Message ?? (json ?? string.Empty), 256)
                };
            }
            catch (Exception ex)
            {
                return new DispatchResult
                {
                    Url = url,
                    Success = false,
                    StatusCode = 0,
                    Body = ex.Message
                };
            }
        }

        private static List<string> ParseUrls(string? raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return new List<string>();
            return raw
                .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(u => u.Trim())
                .Where(u => !string.IsNullOrEmpty(u))
                .ToList();
        }

        private static int ClampDebounceSeconds(int requested)
        {
            if (requested < MinDebounceSeconds) return MinDebounceSeconds;
            if (requested > MaxDebounceSeconds) return MaxDebounceSeconds;
            return requested;
        }

        private static string Truncate(string s, int max)
        {
            if (string.IsNullOrEmpty(s)) return string.Empty;
            return s.Length <= max ? s : s.Substring(0, max) + "…";
        }

        public void Dispose()
        {
            lock (_stateLock)
            {
                if (_disposed) return;
                _disposed = true;
                if (_subscribed)
                {
                    _libraryManager.ItemAdded -= OnItemAdded;
                    if (_outboxEvents != null) _outboxEvents.Confirmed -= OnRequestConfirmed;
                    _subscribed = false;
                }
                foreach (var owner in _owners.Values) owner.Timer?.Dispose();
                _owners.Clear();
            }
            GC.SuppressFinalize(this);
        }

        public class DispatchResult
        {
            public string Url { get; set; } = string.Empty;
            public bool Success { get; set; }
            public int StatusCode { get; set; }
            public string Body { get; set; } = string.Empty;
        }
    }
}
