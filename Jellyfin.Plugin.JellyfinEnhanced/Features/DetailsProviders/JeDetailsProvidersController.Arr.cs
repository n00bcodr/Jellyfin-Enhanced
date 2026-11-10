using System.Collections.Concurrent;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Arr;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders
{
    public partial class JeDetailsProvidersController
    {
        [HttpGet("arr/identify-url")]
        [Authorize]
        public async Task<IActionResult> IdentifyUrl([FromQuery] string url)
        {
            if (!IsAdminUser())
                return Forbid();

            if (string.IsNullOrWhiteSpace(url))
                return BadRequest(new { reachable = false, service = "unknown" });

            if (!ArrUrlGuard.IsAllowedUrl(url, _logger))
                return BadRequest(new { reachable = false, service = "unknown" });

            var http = Shared.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            http.Timeout = TimeSpan.FromSeconds(5);
            var cleanUrl = url.TrimEnd('/');

            // Try Sonarr/Radarr (/api/v3/system/status)
            try
            {
                using var resp = await http.GetAsync($"{cleanUrl}/api/v3/system/status");
                if (resp.IsSuccessStatusCode)
                {
                    var ct = resp.Content.Headers.ContentType?.MediaType ?? "";
                    if (ct.Contains("json"))
                    {
                        var json = await resp.Content.ReadAsStringAsync();
                        if (json.Contains("appName", StringComparison.Ordinal))
                        {
                            if (json.Contains("Sonarr", StringComparison.OrdinalIgnoreCase))
                                return Ok(new { reachable = true, service = "Sonarr" });
                            if (json.Contains("Radarr", StringComparison.OrdinalIgnoreCase))
                                return Ok(new { reachable = true, service = "Radarr" });
                        }
                    }
                }
                else if (resp.StatusCode == System.Net.HttpStatusCode.Unauthorized ||
                         resp.StatusCode == System.Net.HttpStatusCode.Forbidden)
                {
                    var contentType = resp.Content.Headers.ContentType?.MediaType ?? "";
                    if (contentType.Contains("json"))
                        return Ok(new { reachable = true, service = "arr" });
                }
            }
            catch (HttpRequestException) { /* continue to next service probe */ }
            catch (TaskCanceledException) { /* continue to next service probe */ }

            // Try Jellyfin (/System/Info/Public — public endpoint, returns JSON)
            try
            {
                using var resp = await http.GetAsync($"{cleanUrl}/System/Info/Public");
                if (resp.IsSuccessStatusCode)
                {
                    var ct = resp.Content.Headers.ContentType?.MediaType ?? "";
                    if (ct.Contains("json"))
                    {
                        var body = await resp.Content.ReadAsStringAsync();
                        if (body.Contains("ServerName", StringComparison.OrdinalIgnoreCase))
                            return Ok(new { reachable = true, service = "Jellyfin" });
                    }
                }
            }
            catch (HttpRequestException) { /* continue to next service probe */ }
            catch (TaskCanceledException) { /* continue to next service probe */ }

            // Try Jellyseerr (/api/v1/status — returns JSON)
            try
            {
                using var resp = await http.GetAsync($"{cleanUrl}/api/v1/status");
                if (resp.IsSuccessStatusCode)
                {
                    var ct = resp.Content.Headers.ContentType?.MediaType ?? "";
                    if (ct.Contains("json"))
                        return Ok(new { reachable = true, service = "Seerr" });
                }
            }
            catch (HttpRequestException) { /* continue to next service probe */ }
            catch (TaskCanceledException) { /* continue to next service probe */ }

            // Try generic reachability — also check HTML title for service name
            try
            {
                using var resp = await http.GetAsync(cleanUrl, HttpCompletionOption.ResponseHeadersRead);
                if (resp.IsSuccessStatusCode)
                {
                    // Only read first 64KB — title tag is near the top of the HTML
                    var buffer = new byte[65536];
                    using var stream = await resp.Content.ReadAsStreamAsync();
                    var bytesRead = await stream.ReadAsync(buffer, 0, buffer.Length);
                    var body = System.Text.Encoding.UTF8.GetString(buffer, 0, bytesRead);
                    // Check <title> tag for known service names (SPA root pages)
                    var titleMatch = System.Text.RegularExpressions.Regex.Match(
                        body, @"<title[^>]*>([^<]*)</title>", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                    if (titleMatch.Success)
                    {
                        var title = titleMatch.Groups[1].Value;
                        if (title.Contains("Sonarr", StringComparison.OrdinalIgnoreCase))
                            return Ok(new { reachable = true, service = "Sonarr" });
                        if (title.Contains("Radarr", StringComparison.OrdinalIgnoreCase))
                            return Ok(new { reachable = true, service = "Radarr" });
                        if (title.Contains("Bazarr", StringComparison.OrdinalIgnoreCase))
                            return Ok(new { reachable = true, service = "Bazarr" });
                        if (title.Contains("Jellyseerr", StringComparison.OrdinalIgnoreCase)
                            || title.Contains("Overseerr", StringComparison.OrdinalIgnoreCase))
                            return Ok(new { reachable = true, service = "Seerr" });
                        if (title.Contains("Jellyfin", StringComparison.OrdinalIgnoreCase))
                            return Ok(new { reachable = true, service = "Jellyfin" });
                    }
                }
                return Ok(new { reachable = true, service = "unknown" });
            }
            catch (HttpRequestException)
            {
                return Ok(new { reachable = false, service = "unknown" });
            }
            catch (TaskCanceledException)
            {
                return Ok(new { reachable = false, service = "unknown" });
            }
        }

        [HttpGet("arr/series-slug")]
        [Authorize]
        public async Task<IActionResult> GetSeriesSlug([FromQuery] int tvdbId)
        {
            if (!IsAdminUser())
                return Forbid();

            if (tvdbId <= 0)
                return BadRequest(new { error = "tvdbId must be a positive integer" });

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
                return StatusCode(500, new { error = "Plugin configuration not available" });

            _arrInstanceClient.WarnIfArrInstancesCorrupt(config);
            var instances = config.GetEnabledSonarrInstances();
            if (instances.Count == 0)
            {
                if (config.IsSonarrInstancesCorrupt())
                    return StatusCode(500, new { error = "Sonarr instance configuration is corrupt — see server logs" });
                return NotFound(new { error = "Sonarr is not configured" });
            }

            var outcome = await _arrInstanceClient.FetchSeriesInfoFromInstance(instances[0], tvdbId, HttpContext.RequestAborted);
            if (outcome.Error != null)
                return StatusCode(502, new { error = $"Sonarr fetch failed: {outcome.Error}" });
            if (outcome.Match == null)
                return NotFound(new { error = "Series not found in Sonarr" });

            // Legacy endpoint: extract titleSlug from the enriched response. Preserve the historical
            // contract — return 404 rather than 200+null if the upstream response lacks titleSlug.
            var titleSlug = (string?)((dynamic)outcome.Match).titleSlug;
            if (string.IsNullOrEmpty(titleSlug))
                return NotFound(new { error = "Series not found in Sonarr" });
            return Ok(new { titleSlug });
        }

        [HttpGet("arr/series-slugs")]
        [Authorize]
        public async Task<IActionResult> GetSeriesSlugs([FromQuery] int tvdbId)
        {
            if (!IsAdminUser())
                return Forbid();

            if (tvdbId <= 0)
                return BadRequest(new { error = "tvdbId must be a positive integer" });

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
                return StatusCode(500, new { error = "Plugin configuration not available" });

            _arrInstanceClient.WarnIfArrInstancesCorrupt(config);
            var instances = config.GetEnabledSonarrInstances();
            if (instances.Count == 0)
                return Ok(BuildNoArrInstancesResult("Sonarr", config.IsSonarrInstancesCorrupt(), config.GetSonarrInstances().Count > 0));

            var ct = HttpContext.RequestAborted;
            var outcomes = await Task.WhenAll(instances.Select(i => _arrInstanceClient.FetchSeriesInfoFromInstance(i, tvdbId, ct)));
            return Ok(BuildArrLookupResult(instances, outcomes));
        }

        /// <summary>
        /// Response for <c>arr/series-slugs</c> / <c>arr/movie-instances</c> (and each entry of
        /// <c>arr/links</c>) when no instance of that kind is enabled. Distinguishes "config corrupt"
        /// and "admin disabled everything" from "never configured" so the frontend can toast the
        /// right message instead of silently showing no links.
        /// </summary>
        private static object BuildNoArrInstancesResult(string serviceName, bool corrupt, bool anyConfigured)
        {
            var errList = new List<object>();
            if (corrupt)
                errList.Add(new { instanceName = serviceName, reason = "config corrupt — see server logs" });
            else if (anyConfigured)
                errList.Add(new { instanceName = serviceName, reason = $"all {serviceName} instances are disabled" });
            return new { matches = Array.Empty<object>(), errors = errList };
        }

        /// <summary>
        /// Folds per-instance lookup outcomes (same order as <paramref name="instances"/>) into
        /// the <c>{ matches, errors }</c> shape shared by the single and batch arr link endpoints.
        /// </summary>
        private static object BuildArrLookupResult(IReadOnlyList<ArrInstance> instances, IReadOnlyList<ArrFetchOutcome> outcomes)
        {
            var matches = new List<object>();
            var errors = new List<object>();
            for (int i = 0; i < outcomes.Count; i++)
            {
                if (outcomes[i].Match != null) matches.Add(outcomes[i].Match!);
                if (outcomes[i].Error != null)
                    errors.Add(new { instanceName = instances[i].Name, reason = outcomes[i].Error });
            }

            return new { matches, errors };
        }

        // Batch arr link lookup limits. The Requests page shows 20 cards, so 100 leaves room for
        // other callers while bounding the upstream fan-out of a single request.
        private const int ArrLinksBatchMaxIds = 100;

        // Upstream calls in flight per Radarr/Sonarr instance, shared by every concurrent
        // arr/links request (the page sends a small visible-cards batch next to the rest).
        // 8 matches what the old per-card path reached: up to 8 browser requests through
        // JE's request pool, each querying every instance once. Lower values make a slow
        // instance (e.g. a 4K Radarr at ~1 s per lookup) take several rounds per page.
        private const int ArrLinksPerInstanceConcurrency = 8;

        // One gate per instance URL, process-wide, so parallel batches (two tabs, visible +
        // rest chunks) cannot multiply the load on an instance. Entries are tiny and keyed by
        // configured URLs, so the map stays as small as the instance list.
        private static readonly ConcurrentDictionary<string, SemaphoreSlim> _arrLinksInstanceGates =
            new(StringComparer.OrdinalIgnoreCase);

        /// <summary>
        /// Batch form of <c>arr/movie-instances</c> + <c>arr/series-slugs</c> for pages that
        /// show many items at once (the Requests page). Radarr/Sonarr v3 only filter
        /// <c>/movie</c> and <c>/series</c> by a single tmdbId/tvdbId (the unfiltered lists are
        /// whole-library dumps), so this still makes one upstream call per id and instance, but
        /// with bounded per-instance concurrency and a handful of browser requests per page.
        /// Each value is exactly what the matching single endpoint returns for that id.
        /// </summary>
        /// <param name="tmdbIds">Comma-separated positive TMDB movie ids (Radarr).</param>
        /// <param name="tvdbIds">Comma-separated positive TVDB series ids (Sonarr).</param>
        [HttpGet("arr/links")]
        [Authorize]
        public async Task<IActionResult> GetArrLinks([FromQuery] string? tmdbIds, [FromQuery] string? tvdbIds)
        {
            if (!IsAdminUser())
                return Forbid();

            var movieIds = ParsePositiveIdList(tmdbIds);
            var seriesIds = ParsePositiveIdList(tvdbIds);
            if (movieIds.Count + seriesIds.Count == 0)
                return BadRequest(new { error = "tmdbIds or tvdbIds must contain at least one positive integer" });
            if (movieIds.Count + seriesIds.Count > ArrLinksBatchMaxIds)
                return BadRequest(new { error = $"At most {ArrLinksBatchMaxIds} ids per request" });

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
                return StatusCode(500, new { error = "Plugin configuration not available" });

            _arrInstanceClient.WarnIfArrInstancesCorrupt(config);
            var ct = HttpContext.RequestAborted;

            var moviesTask = LookupArrLinksBatchAsync(
                movieIds,
                movieIds.Count > 0 ? config.GetEnabledRadarrInstances() : new List<ArrInstance>(),
                () => BuildNoArrInstancesResult("Radarr", config.IsRadarrInstancesCorrupt(), config.GetRadarrInstances().Count > 0),
                _arrInstanceClient.FetchMovieInfoFromInstance,
                ct);
            var seriesTask = LookupArrLinksBatchAsync(
                seriesIds,
                seriesIds.Count > 0 ? config.GetEnabledSonarrInstances() : new List<ArrInstance>(),
                () => BuildNoArrInstancesResult("Sonarr", config.IsSonarrInstancesCorrupt(), config.GetSonarrInstances().Count > 0),
                _arrInstanceClient.FetchSeriesInfoFromInstance,
                ct);
            try
            {
                await Task.WhenAll(moviesTask, seriesTask).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested)
            {
                // Browser went away (navigated off, aborted a superseded lookup) -
                // expected under normal use, not a failure worth logging.
                return StatusCode(499);
            }

            return Ok(new { movies = await moviesTask.ConfigureAwait(false), series = await seriesTask.ConfigureAwait(false) });
        }

        /// <summary>
        /// Parses a comma-separated id list: positive ints only, malformed entries ignored,
        /// duplicates removed (first-seen order kept).
        /// </summary>
        private static List<int> ParsePositiveIdList(string? raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return new List<int>();
            var seen = new HashSet<int>();
            return raw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(part => int.TryParse(part, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var id) ? id : 0)
                .Where(id => id > 0 && seen.Add(id))
                .ToList();
        }

        /// <summary>
        /// Looks every id up on every instance with at most
        /// <see cref="ArrLinksPerInstanceConcurrency"/> calls in flight per instance (across all
        /// batch requests), and returns id → <c>{ matches, errors }</c>. Once an instance times
        /// out, fails at the network level or rejects the API key, its remaining lookups in this
        /// batch report the same error instead of waiting out the timeout once per id. Per-id
        /// HTTP errors (e.g. a 500 for one movie) are not generalised. FetchAndMapAsync makes a
        /// single attempt (no retry/backoff), so a failing instance costs one call per id.
        /// </summary>
        private static async Task<Dictionary<string, object>> LookupArrLinksBatchAsync(
            IReadOnlyList<int> ids,
            IReadOnlyList<ArrInstance> instances,
            Func<object> noInstancesResult,
            Func<ArrInstance, int, CancellationToken, Task<ArrFetchOutcome>> fetch,
            CancellationToken ct)
        {
            var result = new Dictionary<string, object>(ids.Count);
            if (ids.Count == 0) return result;

            if (instances.Count == 0)
            {
                var empty = noInstancesResult();
                foreach (var id in ids)
                    result[id.ToString(System.Globalization.CultureInfo.InvariantCulture)] = empty;
                return result;
            }

            var gates = instances
                .Select(i => _arrLinksInstanceGates.GetOrAdd(i.Url.Trim().TrimEnd('/'), _ => new SemaphoreSlim(ArrLinksPerInstanceConcurrency)))
                .ToArray();
            // Per-instance sticky failure (null = healthy); written by whichever lookup hits it first.
            var failed = new string?[instances.Count];

            async Task<ArrFetchOutcome> LookupOne(int instanceIndex, int id)
            {
                var gate = gates[instanceIndex];
                await gate.WaitAsync(ct).ConfigureAwait(false);
                try
                {
                    var sticky = Volatile.Read(ref failed[instanceIndex]);
                    if (sticky != null)
                        return new ArrFetchOutcome { Error = sticky };

                    var outcome = await fetch(instances[instanceIndex], id, ct).ConfigureAwait(false);
                    if (outcome.Error != null && IsInstanceWideArrError(outcome.Error))
                        Volatile.Write(ref failed[instanceIndex], outcome.Error);
                    return outcome;
                }
                finally
                {
                    gate.Release();
                }
            }

            var perId = ids
                .Select(id => Task.WhenAll(Enumerable.Range(0, instances.Count).Select(i => LookupOne(i, id))))
                .ToArray();
            var outcomes = await Task.WhenAll(perId).ConfigureAwait(false);

            for (int n = 0; n < ids.Count; n++)
                result[ids[n].ToString(System.Globalization.CultureInfo.InvariantCulture)] = BuildArrLookupResult(instances, outcomes[n]);
            return result;
        }

        // Errors from FetchAndMapAsync that describe the instance rather than the id looked up.
        private static bool IsInstanceWideArrError(string error)
            => error == "timeout"
                || error == "network error"
                || error == "URL rejected by SSRF guard"
                || error.StartsWith("authentication failed", StringComparison.Ordinal);

        [HttpGet("arr/movie-instances")]
        [Authorize]
        public async Task<IActionResult> GetMovieInstances([FromQuery] int tmdbId)
        {
            if (!IsAdminUser())
                return Forbid();

            if (tmdbId <= 0)
                return BadRequest(new { error = "tmdbId must be a positive integer" });

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
                return StatusCode(500, new { error = "Plugin configuration not available" });

            _arrInstanceClient.WarnIfArrInstancesCorrupt(config);
            var instances = config.GetEnabledRadarrInstances();
            if (instances.Count == 0)
                return Ok(BuildNoArrInstancesResult("Radarr", config.IsRadarrInstancesCorrupt(), config.GetRadarrInstances().Count > 0));

            var ct = HttpContext.RequestAborted;
            var outcomes = await Task.WhenAll(instances.Select(i => _arrInstanceClient.FetchMovieInfoFromInstance(i, tmdbId, ct)));
            return Ok(BuildArrLookupResult(instances, outcomes));
        }
    }
}
