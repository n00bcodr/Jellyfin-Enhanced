using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.Arr
{
    /// <summary>
    /// Sonarr/Radarr instance calls shared by several features (restructure S2.0b, moved verbatim from
    /// JellyfinEnhancedController): the corrupt-config warning, the single-attempt fetch-and-map and the per-instance
    /// series/movie lookups.
    /// </summary>
    internal sealed class ArrInstanceClient
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Logger _logger;

        public ArrInstanceClient(IHttpClientFactory httpClientFactory, Logger logger)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
        }

        // Once-per-value dedup so corrupted instance config logs at Error on first hit and stops
        // spamming on subsequent reads. Keyed by the raw stored JSON so a corrupt→fix→corrupt
        // cycle gets a fresh log entry.
        private static readonly HashSet<string> _loggedCorruptArrConfig = new();
        private static readonly object _loggedCorruptArrConfigLock = new();

        public void WarnIfArrInstancesCorrupt(PluginConfiguration config)
        {
            if (config.IsSonarrInstancesCorrupt())
            {
                var key = "sonarr:" + (config.SonarrInstances ?? "");
                bool firstSeen;
                lock (_loggedCorruptArrConfigLock) firstSeen = _loggedCorruptArrConfig.Add(key);
                if (firstSeen)
                    _logger.Error("SonarrInstances config is corrupt JSON — instance list is effectively empty. "
                        + "Endpoints will return no Sonarr data until the admin opens the config page and resets it. "
                        + $"Raw value (first 200 chars): {(config.SonarrInstances ?? "").Substring(0, Math.Min(200, (config.SonarrInstances ?? "").Length))}");
            }
            if (config.IsRadarrInstancesCorrupt())
            {
                var key = "radarr:" + (config.RadarrInstances ?? "");
                bool firstSeen;
                lock (_loggedCorruptArrConfigLock) firstSeen = _loggedCorruptArrConfig.Add(key);
                if (firstSeen)
                    _logger.Error("RadarrInstances config is corrupt JSON — instance list is effectively empty. "
                        + "Endpoints will return no Radarr data until the admin opens the config page and resets it. "
                        + $"Raw value (first 200 chars): {(config.RadarrInstances ?? "").Substring(0, Math.Min(200, (config.RadarrInstances ?? "").Length))}");
            }
        }

        public async Task<(T Result, string? Error)> FetchAndMapAsync<T>(
            ArrInstance instance,
            string endpointPath,
            Func<dynamic?, T> mapper,
            T emptyResult,
            TimeSpan timeout,
            string contextLabel,
            CancellationToken ct,
            string authHeaderName = "X-Api-Key")
        {
            if (!await ArrUrlGuard.IsAllowedUrlAsync(instance.Url, _logger, ct).ConfigureAwait(false))
                return (emptyResult, "URL rejected by SSRF guard");

            try
            {
                var url = instance.Url.TrimEnd('/');
                // Arr (Sonarr/Radarr) instances are commonly fronted by reverse proxies that
                // 301/302 between http↔https or trailing-slash variants. Use the default
                // factory client so redirects are followed — the Seerr-specific named client
                // (SeerrHttpHelper.NamedClient, AllowAutoRedirect=false) is only appropriate
                // for Seerr where a 302 to a login URL is a security signal, not a normal
                // canonicalization.
                // DefaultRequestHeaders mutations remain thread-unsafe for pooled instances,
                // so the API key continues to be set per-request via HttpRequestMessage below.
                var client = _httpClientFactory.CreateClient();
                client.Timeout = timeout;

                var request = new HttpRequestMessage(HttpMethod.Get, $"{url}{endpointPath}");
                request.Headers.TryAddWithoutValidation(authHeaderName, instance.ApiKey);
                var response = await client.SendAsync(request, ct);

                if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized
                    || response.StatusCode == System.Net.HttpStatusCode.Forbidden)
                {
                    // Before the FetchAndMapAsync consolidation this path only surfaced via the
                    // response envelope, so a bad API key would leave no server-side trail. Log
                    // at Error to keep diagnosability on par with the exception branches below.
                    _logger.Error($"Authentication failed for {contextLabel} from {instance.Name}: HTTP {(int)response.StatusCode}");
                    return (emptyResult, $"authentication failed ({(int)response.StatusCode})");
                }

                if (!response.IsSuccessStatusCode)
                {
                    _logger.Error($"Upstream error fetching {contextLabel} from {instance.Name}: HTTP {(int)response.StatusCode}");
                    return (emptyResult, $"HTTP {(int)response.StatusCode}");
                }

                var json = await response.Content.ReadAsStringAsync(ct);
                var data = Newtonsoft.Json.JsonConvert.DeserializeObject<dynamic>(json);
                return (mapper(data), null);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (HttpRequestException ex)
            {
                _logger.Error($"Network error fetching {contextLabel} from {instance.Name}: {ex.Message}");
                return (emptyResult, "network error");
            }
            catch (TaskCanceledException ex)
            {
                _logger.Error($"Timeout fetching {contextLabel} from {instance.Name}: {ex.Message}");
                return (emptyResult, "timeout");
            }
            catch (Newtonsoft.Json.JsonException ex)
            {
                _logger.Error($"Invalid JSON from {contextLabel} {instance.Name}: {ex.Message}");
                return (emptyResult, "invalid response");
            }
            catch (Exception ex)
            {
                _logger.Error($"Unexpected error fetching {contextLabel} from {instance.Name}: {ex.Message}");
                return (emptyResult, "internal error");
            }
        }

        private static dynamic? SingleItemOrNull(dynamic? data)
        {
            if (data is Newtonsoft.Json.Linq.JArray arr)
                return arr.Count > 0 ? arr[0] : null;
            return data;
        }

        public async Task<ArrFetchOutcome> FetchSeriesInfoFromInstance(ArrInstance instance, int tvdbId, CancellationToken ct)
        {
            var (match, error) = await FetchAndMapAsync<object?>(
                instance,
                $"/api/v3/series?tvdbId={tvdbId}",
                data =>
                {
                    var item = SingleItemOrNull(data);
                    if (item == null) return null;
                    var titleSlug = (string?)item.titleSlug;
                    // Treat empty/missing titleSlug as "no match" rather than returning a record
                    // that would render a broken `/series/null` link on the frontend. The legacy
                    // single-instance endpoint already had this guard; preserve it here.
                    if (string.IsNullOrEmpty(titleSlug)) return null;
                    return new
                    {
                        instanceName = instance.Name,
                        instanceUrl = instance.Url,
                        titleSlug,
                        urlMappings = instance.UrlMappings,
                        episodeFileCount = (int?)item.statistics?.episodeFileCount ?? 0,
                        episodeCount = (int?)item.statistics?.episodeCount ?? 0,
                        percentOfEpisodes = (double?)item.statistics?.percentOfEpisodes ?? 0,
                        sizeOnDisk = (long?)item.statistics?.sizeOnDisk ?? 0,
                        rootFolderPath = GetRootFolderFromPath((string?)item.path)
                    };
                },
                emptyResult: null,
                timeout: TimeSpan.FromSeconds(10),
                contextLabel: $"Sonarr series (TVDB {tvdbId})",
                ct: ct).ConfigureAwait(false);
            return new ArrFetchOutcome { Match = match, Error = error };
        }

        public async Task<ArrFetchOutcome> FetchMovieInfoFromInstance(ArrInstance instance, int tmdbId, CancellationToken ct)
        {
            var (match, error) = await FetchAndMapAsync<object?>(
                instance,
                $"/api/v3/movie?tmdbId={tmdbId}",
                data =>
                {
                    var item = SingleItemOrNull(data);
                    if (item == null) return null;
                    return new
                    {
                        instanceName = instance.Name,
                        instanceUrl = instance.Url,
                        urlMappings = instance.UrlMappings,
                        hasFile = (bool?)item.hasFile ?? false,
                        sizeOnDisk = (long?)item.sizeOnDisk ?? 0,
                        rootFolderPath = GetRootFolderFromPath((string?)item.path)
                    };
                },
                emptyResult: null,
                timeout: TimeSpan.FromSeconds(10),
                contextLabel: $"Radarr movie (TMDB {tmdbId})",
                ct: ct).ConfigureAwait(false);
            return new ArrFetchOutcome { Match = match, Error = error };
        }

        public static string? GetRootFolderFromPath(string? path)
        {
            if (string.IsNullOrWhiteSpace(path))
                return null;

            var trimmed = path.TrimEnd('/');
            var lastSlash = trimmed.LastIndexOf('/');
            if (lastSlash <= 0)
                return trimmed;

            return trimmed.Substring(0, lastSlash);
        }
    }

    internal struct ArrFetchOutcome
    {
        public object? Match;
        public string? Error;
    }
}
