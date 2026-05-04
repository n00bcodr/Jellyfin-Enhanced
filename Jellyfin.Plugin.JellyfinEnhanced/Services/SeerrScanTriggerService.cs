using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    // Debounced bridge from Jellyfin's library ItemAdded event to Seerr's
    // /api/v1/settings/jobs/jellyfin-recently-added-scan/run endpoint, so admins can
    // disable Seerr's 5-minute cron and have the scan run only when Jellyfin actually
    // ingests new content.
    public class SeerrScanTriggerService : IDisposable
    {
        private const string ScanJobId = "jellyfin-recently-added-scan";
        private const int MinDebounceSeconds = 5;
        private const int MaxDebounceSeconds = 3600;

        private readonly ILibraryManager _libraryManager;
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Logger _logger;

        private readonly object _stateLock = new();
        private readonly Timer _debounceTimer;
        private int _pendingCount;
        private bool _subscribed;
        private bool _disposed;

        public SeerrScanTriggerService(
            ILibraryManager libraryManager,
            IHttpClientFactory httpClientFactory,
            Logger logger)
        {
            _libraryManager = libraryManager;
            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _debounceTimer = new Timer(OnDebounceElapsed, null, Timeout.Infinite, Timeout.Infinite);
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
                _subscribed = true;
            }
            _logger.Info("[SeerrScan] Subscribed to library ItemAdded events");
        }

        private void OnItemAdded(object? sender, ItemChangeEventArgs e)
        {
            try
            {
                if (JellyfinEnhanced.Instance?.Configuration is not PluginConfiguration config) return;
                if (!config.TriggerSeerrScanOnItemAdded) return;
                if (!config.JellyseerrEnabled) return;

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

                var debounce = ClampDebounceSeconds(config.SeerrScanDebounceSeconds);
                lock (_stateLock)
                {
                    if (_disposed) return;
                    _pendingCount++;
                    // Reset the timer on every event — the actual POST runs `debounce`
                    // seconds after the LAST event in the burst.
                    _debounceTimer.Change(TimeSpan.FromSeconds(debounce), Timeout.InfiniteTimeSpan);
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"[SeerrScan] OnItemAdded handler threw: {ex.Message}");
            }
        }

        private void OnDebounceElapsed(object? state)
        {
            int batchSize;
            lock (_stateLock)
            {
                if (_disposed) return;
                batchSize = Interlocked.Exchange(ref _pendingCount, 0);
            }
            if (batchSize <= 0) return;

            // Fire-and-forget; the timer thread should not block on HTTP.
            _ = DispatchAsync(batchSize);
        }

        // Public so the admin "Trigger scan now" button (controller endpoint) can
        // bypass the debounce and force a scan immediately.
        public Task<IReadOnlyList<DispatchResult>> TriggerNowAsync()
        {
            return DispatchAsync(0);
        }

        private async Task<IReadOnlyList<DispatchResult>> DispatchAsync(int batchSize)
        {
            var results = new List<DispatchResult>();
            try
            {
                if (JellyfinEnhanced.Instance?.Configuration is not PluginConfiguration config)
                {
                    _logger.Warning("[SeerrScan] Cannot dispatch: plugin configuration is null");
                    return results;
                }

                var apiKey = config.JellyseerrApiKey;
                var urls = ParseUrls(config.JellyseerrUrls);
                if (urls.Count == 0 || string.IsNullOrEmpty(apiKey))
                {
                    _logger.Warning("[SeerrScan] Cannot dispatch: Seerr URL(s) or API key not configured");
                    return results;
                }

                foreach (var url in urls)
                {
                    var result = await PostScanTrigger(url, apiKey).ConfigureAwait(false);
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

        private async Task<DispatchResult> PostScanTrigger(string url, string apiKey)
        {
            var endpoint = $"{url.TrimEnd('/')}/api/v1/settings/jobs/{ScanJobId}/run";
            try
            {
                var http = _httpClientFactory.CreateClient();
                http.Timeout = TimeSpan.FromSeconds(15);
                using var request = new HttpRequestMessage(HttpMethod.Post, endpoint)
                {
                    Content = new StringContent("{}", Encoding.UTF8, "application/json")
                };
                request.Headers.Add("X-Api-Key", apiKey);

                using var response = await http.SendAsync(request).ConfigureAwait(false);
                var body = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                return new DispatchResult
                {
                    Url = url,
                    Success = response.IsSuccessStatusCode,
                    StatusCode = (int)response.StatusCode,
                    Body = Truncate(body, 256)
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
                    _subscribed = false;
                }
                _debounceTimer.Dispose();
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
