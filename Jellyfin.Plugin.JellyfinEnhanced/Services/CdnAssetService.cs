using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Configuration;
using Newtonsoft.Json;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Local CDN subsystem. Every third-party static asset the client used to load
    /// directly from an external CDN (jsDelivr icons, Google Fonts, flag CDNs,
    /// the Jellyfish theme colour sheets, remote locale JSON, …) is instead served
    /// from the plugin's own <c>/JellyfinEnhanced/cdn/{source}/{path}</c> route,
    /// backed by this service.
    ///
    /// Design goals:
    ///   * Clients ONLY ever hit the local plugin route — never an external host.
    ///   * Assets are cached on disk (not in RAM) so poster-sized fleets never
    ///     bloat the server process, and cached copies survive CDN outages.
    ///   * A scheduled task (<see cref="ScheduledTasks.RefreshCdnAssetsTask"/>) warms
    ///     and refreshes the <see cref="KnownAssets"/> set every 24h so the
    ///     "mutable" assets (icons/fonts/theme sheets/etc.) stay current.
    ///   * Every fetch is locked to a fixed allow-list of upstream bases + a
    ///     per-source content-type whitelist, so the route can never be turned into
    ///     an open proxy / SSRF vector by a crafted request path.
    /// </summary>
    public class CdnAssetService
    {
        private readonly Logger _logger;
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly string _cacheDir;

        // How long a cached asset is considered fresh before a background/on-demand
        // request will try to refresh it. Mirrors the client-side 24h translation cache
        // and the scheduled-task cadence.
        private static readonly TimeSpan CacheTtl = TimeSpan.FromHours(24);

        // Hard cap on a single asset so a hostile/misbehaving CDN can't fill the disk.
        private const long MaxAssetBytes = 8 * 1024 * 1024; // 8 MB

        // Browser-like UA so CDNs behind bot protection (Cloudflare) return the real
        // asset instead of an HTML challenge page. Google Fonts also selects the woff2
        // variant based on the UA, so a modern UA guarantees we cache woff2.
        private const string UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

        // A request path may only contain these characters. No '..', no '@' (refs are
        // baked into the fixed base), no scheme, no CR/LF — see IsSafePath.
        private static readonly Regex SafePathRegex = new(@"^[A-Za-z0-9][A-Za-z0-9._/\-]*$", RegexOptions.Compiled);

        // Small in-memory hot layer: keeps the most-recently-served bytes so repeated
        // hits (icons on every card) don't re-read the disk. Bounded; not the source of
        // truth (the disk is).
        private static readonly ConcurrentDictionary<string, (CdnAsset Asset, DateTime CachedAt)> _hot = new();
        private const int HotCacheMax = 128;

        // Negative cache: keys that recently failed upstream (with no usable disk copy) are
        // remembered briefly so a flood of the same missing path can't re-hit upstream on
        // every request. This is the anonymous route's primary abuse guard together with
        // the outbound-fetch gate below.
        private static readonly ConcurrentDictionary<string, DateTime> _negativeCache = new();
        private static readonly TimeSpan NegativeCacheTtl = TimeSpan.FromMinutes(5);
        private const int NegativeCacheMax = 512;

        // Hard cap on concurrent OUTBOUND fetches across the whole plugin, so an
        // unauthenticated flood of distinct cache-miss paths can't exhaust the server's
        // sockets/connection pool — excess requests queue on this gate instead.
        private static readonly SemaphoreSlim _fetchGate = new(8, 8);

        // Total on-disk cache budget. Even though every source is a fixed allow-list, an
        // anonymous caller can still cause many distinct valid assets to be cached, so the
        // cache is swept back under budget (oldest-first eviction) to bound disk growth.
        private const long MaxCacheBytes = 512L * 1024 * 1024;   // 512 MB
        private const long SweepThresholdBytes = 64L * 1024 * 1024; // sweep after ~64 MB written
        private static long _bytesSinceSweep;
        private static long _tmpCounter;
        private static readonly object _sweepLock = new();

        public CdnAssetService(Logger logger, IHttpClientFactory httpClientFactory, IApplicationPaths applicationPaths)
        {
            _logger = logger;
            _httpClientFactory = httpClientFactory;
            _cacheDir = Path.Combine(applicationPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced", "cdn-cache");
        }

        /// <summary>An immutable cached asset ready to serve.</summary>
        public sealed record CdnAsset(byte[] Content, string ContentType, string ETag);

        /// <summary>
        /// Describes one allow-listed upstream source. <see cref="BaseUrl"/> is a fixed
        /// server-side constant; the client-supplied path is appended to it after strict
        /// validation, so a request can never reach a host outside this list.
        /// </summary>
        /// <param name="FixedPaths">
        /// When set, the source does NOT build its URL as base+path. Instead only these
        /// exact keys are valid and each maps to a complete upstream URL — used for
        /// sources whose real URL isn't a simple path append (e.g. the Google Fonts css2
        /// endpoint, which needs a `?family=…` query string).
        /// </param>
        private sealed record CdnSource(string BaseUrl, HashSet<string> AllowedTypes, bool RewriteCss = false, IReadOnlyDictionary<string, string>? FixedPaths = null);

        // ── Source registry (the ONLY hosts this service will ever fetch from) ──────
        private static readonly IReadOnlyDictionary<string, CdnSource> Sources = new Dictionary<string, CdnSource>(StringComparer.Ordinal)
        {
            // selfhst icon pack (Sonarr/Radarr/Bazarr/Seerr/Letterboxd/YouTube …)
            ["selfhst"] = new("https://cdn.jsdelivr.net/gh/selfhst/icons", Types("image/svg+xml", "image/png")),
            // Jellyfish theme: colour sheets + logos/favicon
            ["jellyfish"] = new("https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfish", Types("text/css", "image/png", "image/vnd.microsoft.icon", "image/x-icon")),
            // homarr-labs dashboard-icons (generic script/plugin icons)
            ["dashboard-icons"] = new("https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons", Types("image/svg+xml", "image/png")),
            // ZestyTheme logo fallback
            ["zesty"] = new("https://cdn.jsdelivr.net/gh/stpnwf/ZestyTheme@latest", Types("image/png", "image/jpeg")),
            // JellyPlugins jellyfin-helper favicon (pinned ref)
            ["jelly-helper"] = new("https://cdn.jsdelivr.net/gh/JellyPlugins/jellyfin-helper@2.0.0.2", Types("image/vnd.microsoft.icon", "image/x-icon", "image/png")),
            // Google Fonts — Material Symbols woff2 glyph files
            ["gfont"] = new("https://fonts.gstatic.com", Types("font/woff2", "font/woff", "font/ttf", "application/font-woff2")),
            // Google Fonts — the css2 stylesheet. The real URL needs a ?family=… query, so
            // it's mapped via FixedPaths. Its body is rewritten so the @font-face URLs point
            // back at the local "gfont" route instead of fonts.gstatic.com.
            ["gfontcss"] = new("https://fonts.googleapis.com", Types("text/css"), RewriteCss: true,
                FixedPaths: new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["material-symbols-outlined"] = "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@48,400,0,0"
                }),
            // flagcdn raster flags (people/country tags)
            ["flagcdn"] = new("https://flagcdn.com", Types("image/png")),
            // cdnjs flag-icons SVG flags (language tags)
            ["flag-icons"] = new("https://cdnjs.cloudflare.com/ajax/libs/flag-icons/7.2.1", Types("image/svg+xml")),
            // ibb "poster not found" fallback image. i.ibb.co hosts arbitrary user uploads,
            // so this is locked to the single known asset via FixedPaths — any other path is
            // rejected — to avoid an anonymous cache-fill proxy over an open host.
            ["ibb"] = new("https://i.ibb.co", Types("image/png", "image/jpeg"),
                FixedPaths: new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["fdbkXQdP/jellyseerr-poster-not-found.png"] = "https://i.ibb.co/fdbkXQdP/jellyseerr-poster-not-found.png"
                }),
            // Remote (newer-than-bundled) locale JSON from the upstream repo's main branch
            ["locales"] = new("https://raw.githubusercontent.com/n00bcodr/Jellyfin-Enhanced/main/Jellyfin.Plugin.JellyfinEnhanced/js/locales", Types("application/json", "text/plain")),
            // Documentation screenshots shown on the admin config page
            ["je-docs-img"] = new("https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Enhanced@main/docs/images", Types("image/png", "image/jpeg")),
            // The plugin's own bundled-on-CDN stylesheets (e.g. colored-ratings CSS)
            ["je-css"] = new("https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Enhanced@main/css", Types("text/css")),
            // Druidblack metadata-provider icon stylesheet (attribute-selector icons; no external url() assets)
            ["icon-metadata"] = new("https://cdn.jsdelivr.net/gh/Druidblack/jellyfin-icon-metadata", Types("text/css")),
            // Jellyfin-Elsewhere region/provider reference lists (fetched as text)
            ["elsewhere-res"] = new("https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Elsewhere/resources", Types("text/plain")),
        };

        private static HashSet<string> Types(params string[] t) => new(t, StringComparer.OrdinalIgnoreCase);

        /// <summary>
        /// The "mutable" static assets the scheduled task pre-fetches and refreshes
        /// every 24h so they are always warm and current in the disk cache.
        /// Per-country flags and per-language locales are intentionally NOT prefetched —
        /// they are effectively immutable per key and are cached lazily on first hit.
        /// </summary>
        public static readonly IReadOnlyList<(string Source, string Path)> KnownAssets = new List<(string, string)>
        {
            ("selfhst", "svg/sonarr.svg"),
            ("selfhst", "svg/radarr-light-hybrid-light.svg"),
            ("selfhst", "svg/bazarr.svg"),
            ("selfhst", "svg/seerr.svg"),
            ("selfhst", "svg/letterboxd.svg"),
            ("selfhst", "png/youtube.png"),
            ("jellyfish", "logos/favicon.ico"),
            ("jellyfish", "colors/aurora.css"),
            ("jellyfish", "colors/banana.css"),
            ("jellyfish", "colors/coal.css"),
            ("jellyfish", "colors/coral.css"),
            ("jellyfish", "colors/forest.css"),
            ("jellyfish", "colors/grass.css"),
            ("jellyfish", "colors/jellyblue.css"),
            ("jellyfish", "colors/jellyflix.css"),
            ("jellyfish", "colors/jellypurple.css"),
            ("jellyfish", "colors/lavender.css"),
            ("jellyfish", "colors/midnight.css"),
            ("jellyfish", "colors/mint.css"),
            ("jellyfish", "colors/ocean.css"),
            ("jellyfish", "colors/peach.css"),
            ("jellyfish", "colors/watermelon.css"),
            ("dashboard-icons", "svg/javascript.svg"),
            ("zesty", "images/logo/jellyfin-logo-light.png"),
            ("jelly-helper", "media/favicon.ico"),
            ("gfont", "s/materialsymbolsrounded/v258/syl0-zNym6YjUruM-QrEh7-nyTnjDwKNJ_190FjpZIvDmUSVOK7BDB_Qb9vUSzq3wzLK-P0J-V_Zs-QtQth3-jOcbTCVpeRL2w5rwZu2rIelXxc.woff2"),
            ("gfontcss", "material-symbols-outlined"),
            ("ibb", "fdbkXQdP/jellyseerr-poster-not-found.png"),
            ("je-css", "ratings.css"),
            ("icon-metadata", "public-icon.css"),
            ("elsewhere-res", "regions.txt"),
            ("elsewhere-res", "providers.txt"),
        };

        /// <summary>True when <paramref name="source"/> is a registered upstream.</summary>
        public bool IsValidSource(string source) => Sources.ContainsKey(source);

        /// <summary>
        /// Returns the cached asset for (source, path), fetching and caching it from the
        /// upstream CDN when it is missing or stale. Returns <c>null</c> when the source
        /// is unknown, the path is unsafe, or the asset can't be obtained from cache or
        /// upstream.
        /// </summary>
        public async Task<CdnAsset?> GetAsync(string source, string path, bool forceRefresh, CancellationToken cancellationToken)
        {
            if (!Sources.TryGetValue(source, out var src))
            {
                return null;
            }

            if (!IsSafePath(path))
            {
                _logger.Warning($"[CDN] Rejected unsafe asset path for source '{source}'.");
                return null;
            }

            var key = $"{source}/{path}";

            // Hot in-memory layer (skipped on a forced refresh so the task always re-downloads).
            // Honours the same TTL as the disk so a lazily-cached asset (flags/locales) is not
            // pinned stale in memory for the whole process lifetime.
            if (!forceRefresh && _hot.TryGetValue(key, out var hot)
                && DateTime.UtcNow - hot.CachedAt < CacheTtl)
            {
                return hot.Asset;
            }

            var (binPath, metaPath) = CachePaths(source, path);

            // Serve from disk when fresh.
            if (!forceRefresh && TryReadDisk(binPath, metaPath, out var cachedAsset, out var cachedAt)
                && DateTime.UtcNow - cachedAt < CacheTtl)
            {
                Promote(key, cachedAsset);
                return cachedAsset;
            }

            // A path that recently failed upstream with no usable cache is short-circuited so a
            // flood of the same missing key can't re-hit upstream. Checked AFTER the hot/disk
            // layers so a copy that appeared in the meantime always wins over a stale negative
            // entry. Skipped on forceRefresh so the scheduled task can always retry.
            if (!forceRefresh && _negativeCache.TryGetValue(key, out var failedAt)
                && DateTime.UtcNow - failedAt < NegativeCacheTtl)
            {
                return null;
            }

            // Fetch (and cache) from upstream, bounded by the outbound-fetch gate.
            CdnAsset? fetched;
            await _fetchGate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                fetched = await FetchAsync(src, source, path, cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                _fetchGate.Release();
            }

            if (fetched != null)
            {
                _negativeCache.TryRemove(key, out _); // a forced refresh may have revived a previously-missing key
                WriteDisk(binPath, metaPath, fetched);
                Promote(key, fetched);
                return fetched;
            }

            // Upstream failed — fall back to a stale-but-usable disk copy if we have one
            // (resilience against transient CDN outages).
            if (TryReadDisk(binPath, metaPath, out var staleAsset, out _))
            {
                _logger.Debug($"[CDN] Serving stale cached copy of '{key}' after upstream fetch failure.");
                Promote(key, staleAsset);
                return staleAsset;
            }

            // Nothing upstream and nothing on disk: remember the miss briefly so repeats are cheap.
            RecordNegative(key);
            return null;
        }

        /// <summary>Remember a failed key for a short TTL, with a crude size bound.</summary>
        private static void RecordNegative(string key)
        {
            if (_negativeCache.Count >= NegativeCacheMax)
            {
                _negativeCache.Clear();
            }

            _negativeCache[key] = DateTime.UtcNow;
        }

        /// <summary>
        /// Downloads a single asset from its fixed upstream base, validating the
        /// content-type against the source whitelist and enforcing the size cap.
        /// </summary>
        private async Task<CdnAsset?> FetchAsync(CdnSource src, string source, string path, CancellationToken cancellationToken)
        {
            try
            {
                // Sources with a fixed-path map resolve the whole URL from the key (their
                // real URL isn't a simple base+path append); all others append the path.
                string url;
                if (src.FixedPaths != null)
                {
                    if (!src.FixedPaths.TryGetValue(path, out var fixedUrl))
                    {
                        _logger.Warning($"[CDN] Unknown fixed-path key for source '{source}'.");
                        return null;
                    }

                    url = fixedUrl;
                }
                else
                {
                    url = $"{src.BaseUrl}/{path}";
                }

                var client = _httpClientFactory.CreateClient();
                client.Timeout = TimeSpan.FromSeconds(20);

                using var request = new HttpRequestMessage(HttpMethod.Get, url);
                request.Headers.UserAgent.ParseAdd(UserAgent);

                using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
                if (!response.IsSuccessStatusCode)
                {
                    _logger.Debug($"[CDN] Upstream returned {(int)response.StatusCode} for source '{source}'.");
                    return null;
                }

                var contentType = response.Content.Headers.ContentType?.MediaType ?? string.Empty;
                if (!src.AllowedTypes.Contains(contentType))
                {
                    _logger.Warning($"[CDN] Upstream content-type '{contentType}' not allowed for source '{source}'.");
                    return null;
                }

                // Enforce the size cap even when the server lies about / omits Content-Length.
                var declared = response.Content.Headers.ContentLength;
                if (declared.HasValue && declared.Value > MaxAssetBytes)
                {
                    _logger.Warning($"[CDN] Asset for source '{source}' exceeds size cap ({declared.Value} bytes).");
                    return null;
                }

                var bytes = await ReadCappedAsync(response, cancellationToken).ConfigureAwait(false);
                if (bytes == null)
                {
                    _logger.Warning($"[CDN] Asset for source '{source}' exceeded the size cap while streaming.");
                    return null;
                }

                // Rewrite Google Fonts CSS so the @font-face URLs it contains resolve to
                // the local "gfont" route (relative to this stylesheet's own URL) instead
                // of fonts.gstatic.com — otherwise the browser would still hit gstatic.
                if (src.RewriteCss)
                {
                    var css = Encoding.UTF8.GetString(bytes)
                        .Replace("https://fonts.gstatic.com/", "../gfont/", StringComparison.OrdinalIgnoreCase);
                    bytes = Encoding.UTF8.GetBytes(css);
                }

                var etag = $"\"{Convert.ToHexString(SHA256.HashData(bytes))}\"";
                return new CdnAsset(bytes, contentType, etag);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.Warning($"[CDN] Fetch failed for source '{source}': {ex.Message}");
                return null;
            }
        }

        /// <summary>Reads the response body, aborting if it grows past the size cap.</summary>
        private static async Task<byte[]?> ReadCappedAsync(HttpResponseMessage response, CancellationToken cancellationToken)
        {
            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            using var buffer = new MemoryStream();
            var chunk = new byte[81920];
            int read;
            while ((read = await stream.ReadAsync(chunk, cancellationToken).ConfigureAwait(false)) > 0)
            {
                if (buffer.Length + read > MaxAssetBytes)
                {
                    return null;
                }

                buffer.Write(chunk, 0, read);
            }

            return buffer.ToArray();
        }

        /// <summary>Forces a fresh download of every <see cref="KnownAssets"/> entry.</summary>
        public async Task RefreshKnownAsync(IProgress<double>? progress, CancellationToken cancellationToken)
        {
            EnsureCacheDir();
            var total = KnownAssets.Count;
            var done = 0;
            var ok = 0;

            foreach (var (source, path) in KnownAssets)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var asset = await GetAsync(source, path, forceRefresh: true, cancellationToken).ConfigureAwait(false);
                if (asset != null)
                {
                    ok++;
                }
                else
                {
                    _logger.Warning($"[CDN] Failed to refresh known asset '{source}/{path}'.");
                }

                done++;
                progress?.Report((double)done / total * 100);
            }

            _logger.Info($"[CDN] Refreshed {ok}/{total} known assets into the local cache.");
        }

        // ── Disk cache helpers ──────────────────────────────────────────────────────

        private (string BinPath, string MetaPath) CachePaths(string source, string path)
        {
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(path))).ToLowerInvariant();
            var dir = Path.Combine(_cacheDir, source);
            return (Path.Combine(dir, hash + ".bin"), Path.Combine(dir, hash + ".meta.json"));
        }

        private void EnsureCacheDir()
        {
            try
            {
                Directory.CreateDirectory(_cacheDir);
            }
            catch (Exception ex)
            {
                _logger.Warning($"[CDN] Could not create cache directory: {ex.Message}");
            }
        }

        private bool TryReadDisk(string binPath, string metaPath, out CdnAsset asset, out DateTime cachedAt)
        {
            asset = null!;
            cachedAt = DateTime.MinValue;
            try
            {
                if (!File.Exists(binPath) || !File.Exists(metaPath))
                {
                    return false;
                }

                var meta = JsonConvert.DeserializeObject<CacheMeta>(File.ReadAllText(metaPath));
                if (meta == null || string.IsNullOrEmpty(meta.ContentType) || string.IsNullOrEmpty(meta.ETag))
                {
                    return false;
                }

                var content = File.ReadAllBytes(binPath);
                asset = new CdnAsset(content, meta.ContentType, meta.ETag);
                cachedAt = DateTimeOffset.FromUnixTimeMilliseconds(meta.FetchedAt).UtcDateTime;
                return true;
            }
            catch (Exception ex)
            {
                _logger.Debug($"[CDN] Failed to read disk cache entry: {ex.Message}");
                return false;
            }
        }

        private void WriteDisk(string binPath, string metaPath, CdnAsset asset)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(binPath)!);
                var meta = JsonConvert.SerializeObject(new CacheMeta
                {
                    ContentType = asset.ContentType,
                    ETag = asset.ETag,
                    FetchedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                });

                // Write to temp files then atomically rename into place (rename is atomic on
                // the same filesystem), so a concurrent reader never sees a half-written or
                // truncated file. The bin is published before the meta, so the only possible
                // interleaving a reader can catch is new content paired with the old ETag,
                // which self-corrects on the next revalidation — never a corrupt body.
                var n = Interlocked.Increment(ref _tmpCounter);
                var binTmp = $"{binPath}.{n}.tmp";
                var metaTmp = $"{metaPath}.{n}.tmp";
                File.WriteAllBytes(binTmp, asset.Content);
                File.Move(binTmp, binPath, overwrite: true);
                File.WriteAllText(metaTmp, meta);
                File.Move(metaTmp, metaPath, overwrite: true);

                MaybeEnforceCacheBudget(asset.Content.Length);
            }
            catch (Exception ex)
            {
                _logger.Warning($"[CDN] Failed to write disk cache entry: {ex.Message}");
            }
        }

        /// <summary>
        /// After enough bytes have been written, sweep the cache back under
        /// <see cref="MaxCacheBytes"/> by evicting the oldest entries. Non-blocking: if a
        /// sweep is already running, this returns immediately.
        /// </summary>
        private void MaybeEnforceCacheBudget(long bytesWritten)
        {
            if (Interlocked.Add(ref _bytesSinceSweep, bytesWritten) < SweepThresholdBytes)
            {
                return;
            }

            Interlocked.Exchange(ref _bytesSinceSweep, 0);
            if (!Monitor.TryEnter(_sweepLock))
            {
                return; // a sweep is already in progress
            }

            try
            {
                EnforceCacheBudget();
            }
            catch (Exception ex)
            {
                _logger.Warning($"[CDN] Cache budget sweep failed: {ex.Message}");
            }
            finally
            {
                Monitor.Exit(_sweepLock);
            }
        }

        private void EnforceCacheBudget()
        {
            if (!Directory.Exists(_cacheDir))
            {
                return;
            }

            var bins = new DirectoryInfo(_cacheDir).GetFiles("*.bin", SearchOption.AllDirectories);
            long total = 0;
            foreach (var f in bins)
            {
                total += f.Length;
            }

            if (total <= MaxCacheBytes)
            {
                return;
            }

            // Evict oldest-written entries (bin + its sibling meta) until back under 80% of budget.
            var target = MaxCacheBytes * 8 / 10;
            var evicted = 0;
            foreach (var f in bins.OrderBy(f => f.LastWriteTimeUtc))
            {
                if (total <= target)
                {
                    break;
                }

                try
                {
                    total -= f.Length;
                    f.Delete();
                    // bin is "<hash>.bin"; its meta sibling is "<hash>.meta.json".
                    var meta = f.FullName[..^4] + ".meta.json";
                    if (File.Exists(meta))
                    {
                        File.Delete(meta);
                    }

                    evicted++;
                }
                catch { /* best effort; a file held open elsewhere is skipped */ }
            }

            _logger.Info($"[CDN] Cache over budget; evicted {evicted} oldest entries.");
        }

        private static void Promote(string key, CdnAsset asset)
        {
            // Naive bound: clear when full. Icons are few and hot, so churn is negligible.
            if (_hot.Count >= HotCacheMax)
            {
                _hot.Clear();
            }

            _hot[key] = (asset, DateTime.UtcNow);
        }

        /// <summary>
        /// Validates a client-supplied path: printable safe characters only, no traversal,
        /// no protocol-relative escape, no CR/LF. The base host is fixed per source, so a
        /// valid path can only ever address a different file on the same trusted CDN.
        /// </summary>
        private static bool IsSafePath(string path)
        {
            if (string.IsNullOrWhiteSpace(path) || path.Length > 512)
            {
                return false;
            }

            if (path.Contains("..", StringComparison.Ordinal)
                || path.Contains("//", StringComparison.Ordinal)
                || path.StartsWith('/'))
            {
                return false;
            }

            return SafePathRegex.IsMatch(path);
        }

        private sealed class CacheMeta
        {
            public string ContentType { get; set; } = string.Empty;
            public string ETag { get; set; } = string.Empty;
            public long FetchedAt { get; set; }
        }
    }
}
