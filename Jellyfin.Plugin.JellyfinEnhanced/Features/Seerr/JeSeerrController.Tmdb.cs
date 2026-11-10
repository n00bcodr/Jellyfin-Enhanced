using Microsoft.AspNetCore.Mvc;
using System.Collections.Concurrent;
using Jellyfin.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Auth;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Seerr
{
    public partial class JeSeerrController
    {
        [HttpGet("tmdb/{**apiPath}")]
        [Authorize]
        public async Task<IActionResult> ProxyTmdbRequest(string apiPath)
        {
            // Parental ratings (#581): for a restricted user the raw TMDB passthrough
            // is limited to title-free lookups; single-title lookups are gated on
            // that title and anything else (search, discover, trending, lists) is
            // refused, because it would return titles unfiltered.
            // Nothing but a successful upstream response may be kept by the browser,
            // and even that is revalidated (so re-gated) on every use.
            Response.Headers["Cache-Control"] = "no-store";

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || string.IsNullOrEmpty(config.TMDB_API_KEY))
            {
                return StatusCode(503, "TMDB API key is not configured.");
            }

            var tmdbCallerId = UserHelper.GetCurrentUserId(User)?.ToString();
            var queryString = HttpContext.Request.QueryString;
            if (_parentalFilter.TryGetRestrictedPolicy(tmdbCallerId, out _))
            {
                // Kestrel decodes %3F in the path, so a query (even a double-encoded
                // append_to_response) can arrive inside apiPath. Restricted users get
                // plain path characters only.
                if (apiPath.IndexOfAny(new[] { '?', '%', '&', '#', ';', '=', '\\' }) >= 0)
                {
                    return ParentalBlockedResult();
                }

                // The route captures only the path; the query matters too. Work on the
                // DECODED keys so percent-encoding (append%5Fto%5Fresponse) can't slip
                // a title list past the classifier, and forward only a small set of
                // harmless parameters, rebuilt from the decoded values.
                var allowedKeys = new[] { "language", "page", "region", "include_adult", "query" };
                var decodedQuery = string.Join("&", HttpContext.Request.Query
                    .Where(kv => allowedKeys.Contains(kv.Key, StringComparer.OrdinalIgnoreCase))
                    .Select(kv => $"{Uri.EscapeDataString(kv.Key)}={Uri.EscapeDataString(kv.Value.ToString())}"));
                if (HttpContext.Request.Query.Keys.Any(k => !allowedKeys.Contains(k, StringComparer.OrdinalIgnoreCase)))
                {
                    return ParentalBlockedResult();
                }
                switch (Shared.Parental.SeerrParentalFilter.ClassifyTmdbPassthrough(apiPath + (decodedQuery.Length > 0 ? "?" + decodedQuery : string.Empty), out var gatedType, out var gatedId))
                {
                    case Shared.Parental.SeerrParentalFilter.TmdbAccess.Deny:
                        return ParentalBlockedResult();
                    case Shared.Parental.SeerrParentalFilter.TmdbAccess.GateTitle:
                        if (await _parentalFilter.IsBlockedAsync(gatedType, gatedId, tmdbCallerId))
                        {
                            return ParentalBlockedResult();
                        }
                        break;
                }
                queryString = decodedQuery.Length > 0 ? new QueryString("?" + decodedQuery) : QueryString.Empty;
            }

            try
            {
                // Gating above has already run for this caller; the server cache is
                // keyed on what goes upstream (see TmdbResponseCache for why that
                // is account-safe).
                // bundle: a cold title lookup (or one of its release dates /
                // watch providers / reviews) fetches the whole set in one
                // TMDB call, which the details page's sibling requests join.
                var response = await _tmdbResponseCache.GetAsync(apiPath, queryString.ToString(), config.TMDB_API_KEY, HttpContext.RequestAborted, bundle: true);

                if (response.IsSuccess)
                {
                    // Before the 304 below: the ETag describes the unredacted body, so a
                    // browser's copy from before the title was guarded must not be reused.
                    if (_spoilerSeerrRedactor.TryRedactTmdb(response.Content, apiPath, tmdbCallerId, HttpContext, out var redactedBody))
                    {
                        Response.Headers["Cache-Control"] = "no-store";
                        return Content(redactedBody, "application/json");
                    }

                    // Browser cache: private + no-cache, so every reuse comes back
                    // here (parental gating above runs again) and costs only a 304
                    // when the body is unchanged. Varied on the auth headers so a
                    // shared browser profile never hands one account's response
                    // (restricted users get different results) to another.
                    Response.Headers["Cache-Control"] = "private, no-cache";
                    Response.Headers["Vary"] = "Authorization, X-Emby-Token, X-Jellyfin-User-Id";
                    Response.Headers["ETag"] = response.ETag;
                    if (Shared.Tmdb.TmdbResponseCache.IfNoneMatchMatches(Request.Headers["If-None-Match"], response.ETag))
                    {
                        return StatusCode(StatusCodes.Status304NotModified);
                    }
                    return Content(response.Content, "application/json");
                }

                return StatusCode(response.StatusCode, response.Content);
            }
            catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested)
            {
                // Browser went away (navigated off, aborted a superseded fetch) -
                // expected under normal use, not a failure worth logging.
                return StatusCode(499);
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to proxy TMDB request for '{apiPath}{queryString}'. Error: {ex}");
                return StatusCode(500, "Failed to connect to TMDB.");
            }
        }

        /// <summary>
        /// Batched watch providers for Seerr cards: one request per screenful of
        /// cards instead of one TMDB passthrough call per card, returning only the
        /// region's flat-rate providers (what a card renders) rather than every
        /// region's full list.
        /// items: comma-separated "movie:{id}" / "tv:{id}" (distinct, max 100).
        /// region: two-letter code; defaults to the admin DEFAULT_REGION.
        /// Response: { "region": "US", "results": { "movie:603": [ { provider_id,
        /// provider_name, logo_path } ] | null } } where null means unavailable
        /// (upstream error, or refused to this caller by parental gating).
        /// </summary>
        [HttpGet("watch-providers")]
        [Authorize]
        public async Task<IActionResult> GetWatchProvidersBatch([FromQuery] string? items, [FromQuery] string? region)
        {
            Response.Headers["Cache-Control"] = "no-store";

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || string.IsNullOrEmpty(config.TMDB_API_KEY))
            {
                return StatusCode(503, "TMDB API key is not configured.");
            }

            if (!Shared.Tmdb.WatchProvidersBatch.TryParseItems(items, out var requested, out var itemsError))
            {
                return BadRequest(itemsError);
            }

            var regionCode = string.IsNullOrEmpty(region) ? Shared.Tmdb.WatchProvidersBatch.DefaultRegion(config.DEFAULT_REGION) : region;
            if (!Shared.Tmdb.WatchProvidersBatch.IsValidRegion(regionCode))
            {
                return BadRequest("Invalid region.");
            }

            var apiKey = config.TMDB_API_KEY;
            var callerId = UserHelper.GetCurrentUserId(User)?.ToString();
            var restricted = _parentalFilter.TryGetRestrictedPolicy(callerId, out _);
            var aborted = HttpContext.RequestAborted;
            var results = new ConcurrentDictionary<string, List<Shared.Tmdb.WatchProvidersBatch.Provider>?>(StringComparer.Ordinal);
            using var slots = new SemaphoreSlim(6);
            var failures = 0;
            string? lastError = null;

            async Task LoadAsync(Shared.Tmdb.WatchProvidersBatch.Item item)
            {
                await slots.WaitAsync(aborted).ConfigureAwait(false);
                try
                {
                    // The same per-caller parental gating the passthrough applies to
                    // {type}/{id}/watch/providers; anything refused stays null.
                    if (restricted)
                    {
                        switch (Shared.Parental.SeerrParentalFilter.ClassifyTmdbPassthrough(item.ApiPath, out var gatedType, out var gatedId))
                        {
                            case Shared.Parental.SeerrParentalFilter.TmdbAccess.Deny:
                                return;
                            case Shared.Parental.SeerrParentalFilter.TmdbAccess.GateTitle:
                                if (await _parentalFilter.IsBlockedAsync(gatedType, gatedId, callerId, aborted).ConfigureAwait(false))
                                {
                                    return;
                                }
                                break;
                        }
                    }

                    var response = await _tmdbResponseCache.GetAsync(item.ApiPath, string.Empty, apiKey, aborted).ConfigureAwait(false);
                    if (response.IsSuccess)
                    {
                        results[item.Key] = Shared.Tmdb.WatchProvidersBatch.ExtractFlatrate(response.Content, regionCode);
                    }
                }
                catch (OperationCanceledException) when (aborted.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or IOException or InvalidOperationException)
                {
                    // What TmdbResponseCache surfaces from HttpClient: connection
                    // failures and the body cap, the upstream timeout, a broken
                    // stream, an unusable response. One title failing upstream
                    // leaves just that entry null; logged once per batch below so
                    // an outage doesn't log 100 lines.
                    Interlocked.Increment(ref failures);
                    lastError = ex.Message;
                }
                finally
                {
                    slots.Release();
                }
            }

            try
            {
                await Task.WhenAll(requested.Select(LoadAsync)).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (aborted.IsCancellationRequested)
            {
                return StatusCode(499);
            }

            if (failures > 0)
            {
                _logger.Warning($"Watch providers batch: {failures} of {requested.Count} lookups failed ({lastError}).");
            }

            var body = Shared.Tmdb.WatchProvidersBatch.Serialize(regionCode, requested, results);
            var etag = Shared.Tmdb.TmdbResponseCache.ComputeETag(body);
            // Same browser-cache policy as the passthrough: every reuse revalidates
            // here (so gating runs again) and costs a 304 when nothing changed.
            Response.Headers["Cache-Control"] = "private, no-cache";
            Response.Headers["Vary"] = "Authorization, X-Emby-Token, X-Jellyfin-User-Id";
            Response.Headers["ETag"] = etag;
            if (Shared.Tmdb.TmdbResponseCache.IfNoneMatchMatches(Request.Headers["If-None-Match"], etag))
            {
                return StatusCode(StatusCodes.Status304NotModified);
            }
            return Content(body, "application/json");
        }
    }
    public class TmdbPersonData
    {
        public DateTime? BirthDate { get; set; }
        public DateTime? DeathDate { get; set; }
        public string? BirthPlace { get; set; }
    }
}
