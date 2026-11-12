using Microsoft.AspNetCore.Mvc;
using System.Text.Json;
using System.Collections.Concurrent;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Auth;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Text;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Seerr
{
    public partial class JeSeerrController
    {
        [HttpGet("jellyseerr/tv/{tmdbId}")]
        [Authorize]
        public Task<IActionResult> GetTvShow(int tmdbId)
        {
            return ProxyJellyseerrRequest($"/api/v1/tv/{tmdbId}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/tv/{tmdbId}/season/{seasonNumber}")]
        [Authorize]
        public Task<IActionResult> GetTvSeason(int tmdbId, int seasonNumber)
        {
            return ProxyJellyseerrRequest($"/api/v1/tv/{tmdbId}/season/{seasonNumber}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/movie/{tmdbId}")]
        [Authorize]
        public Task<IActionResult> GetMovie(int tmdbId)
        {
            return ProxyJellyseerrRequest($"/api/v1/movie/{tmdbId}", HttpMethod.Get);
        }

        /// <summary>
        /// Batched collection lookup for the Seerr search row: the collection each
        /// movie of one rendered batch of results belongs to, in one request
        /// instead of a proxied Seerr movie detail per movie plus a TMDB movie
        /// detail for each one Seerr names no collection for. Same sources, order
        /// and gating as those per-movie calls: the caller's Seerr movie detail
        /// through ProxyJellyseerrRequest (its response cache, Seerr user and
        /// permission checks, parental gate) first; TMDB's movie detail through
        /// TmdbResponseCache, with the passthrough's parental gate, only when
        /// Seerr's detail has no collection and a TMDB key is configured.
        /// ids: comma-separated TMDB movie ids (distinct, max 100).
        /// Response: { "results": { "603": { id, name, posterPath, backdropPath } | null } }
        /// where null means no collection; an id whose lookup failed or was
        /// refused to this caller is left out, so the client asks again later.
        /// </summary>
        [HttpGet("jellyseerr/movie-collections")]
        [Authorize]
        public async Task<IActionResult> GetMovieCollectionsBatch([FromQuery] string? ids)
        {
            // Per-user body (Seerr user, parental gating): never kept by the browser.
            Response.Headers["Cache-Control"] = "no-store";

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.JellyseerrEnabled || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                return StatusCode(503, "Seerr integration is not configured or enabled.");
            }

            if (!Features.Seerr.Services.MovieCollectionsBatch.TryParseIds(ids, out var requested, out var idsError))
            {
                return BadRequest(idsError);
            }

            var callerId = UserHelper.GetCurrentUserId(User)?.ToString();
            if (string.IsNullOrEmpty(callerId))
            {
                return Forbid();
            }

            var results = new ConcurrentDictionary<int, Features.Seerr.Services.MovieCollectionsBatch.Collection?>();

            // Resolve the caller's Seerr user once, so the per-movie proxy calls
            // below read it from the cache instead of all looking it up cold at
            // the same time. Without one (unlinked, blocked, Seerr unreachable)
            // every per-movie call fails, so every id stays unknown.
            if (await _seerrUserLookup.GetJellyseerrUser(callerId) == null)
            {
                return Content(Features.Seerr.Services.MovieCollectionsBatch.Serialize(requested, results), "application/json");
            }

            var tmdbKey = config.TMDB_API_KEY;
            // The client's TmdbEnabled flag (GetPublicConfig) gated the TMDB fallback.
            var tmdbEnabled = !string.IsNullOrWhiteSpace(tmdbKey);
            var aborted = HttpContext.RequestAborted;
            // As many Seerr detail calls at once as the client used to make; a cold
            // detail makes Seerr call TMDB, which answers bursts with 5xx.
            using var slots = new SemaphoreSlim(4);
            var failures = 0;
            string? lastError = null;

            async Task LoadAsync(int tmdbId)
            {
                await slots.WaitAsync(aborted).ConfigureAwait(false);
                try
                {
                    // Anything but a readable 200 (refused by the parental gate or
                    // Seerr permissions, upstream failure, cancelled) leaves the id
                    // unknown, as the failed call left it for the client.
                    var seerr = await ProxyJellyseerrRequest($"/api/v1/movie/{tmdbId}", HttpMethod.Get).ConfigureAwait(false);
                    if (seerr is not ContentResult { StatusCode: null or 200, Content: { } json }
                        || !Features.Seerr.Services.MovieCollectionsBatch.TryReadSeerrCollection(json, out var collection))
                    {
                        return;
                    }

                    if (collection != null || !tmdbEnabled)
                    {
                        results[tmdbId] = collection;
                        return;
                    }

                    // The passthrough's gate for "movie/{id}" (TmdbAccess.GateTitle).
                    if (await _parentalFilter.IsBlockedAsync("movie", tmdbId, callerId, aborted).ConfigureAwait(false))
                    {
                        return;
                    }

                    // Same cache entry (path, empty query, bundle) as the
                    // passthrough's GET tmdb/movie/{id}.
                    var response = await _tmdbResponseCache.GetAsync($"movie/{tmdbId}", string.Empty, tmdbKey, aborted, bundle: true).ConfigureAwait(false);
                    if (response.IsSuccess && Features.Seerr.Services.MovieCollectionsBatch.TryReadTmdbCollection(response.Content, out var tmdbCollection))
                    {
                        results[tmdbId] = tmdbCollection;
                    }
                }
                catch (OperationCanceledException) when (aborted.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or IOException or InvalidOperationException)
                {
                    // TMDB failures as GetWatchProvidersBatch sees them; logged once
                    // per batch below. Seerr failures are logged by the proxy.
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

            if (aborted.IsCancellationRequested)
            {
                return StatusCode(499); // the proxy calls answered 499 instead of throwing
            }

            if (failures > 0)
            {
                _logger.Warning($"Movie collections batch: {failures} of {requested.Count} TMDB lookups failed ({lastError}).");
            }

            return Content(Features.Seerr.Services.MovieCollectionsBatch.Serialize(requested, results), "application/json");
        }

        [HttpGet("jellyseerr/movie/{tmdbId}/similar")]
        [Authorize]
        public Task<IActionResult> GetSimilarMovies(int tmdbId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest($"/api/v1/movie/{tmdbId}/similar?page={page}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/movie/{tmdbId}/recommendations")]
        [Authorize]
        public Task<IActionResult> GetRecommendedMovies(int tmdbId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest($"/api/v1/movie/{tmdbId}/recommendations?page={page}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/movie/{tmdbId}/ratingscombined")]
        [Authorize]
        public Task<IActionResult> GetMovieRatingsCombined(int tmdbId)
        {
            return ProxyJellyseerrRequest($"/api/v1/movie/{tmdbId}/ratingscombined", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/tv/{tmdbId}/similar")]
        [Authorize]
        public Task<IActionResult> GetSimilarTvShows(int tmdbId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest($"/api/v1/tv/{tmdbId}/similar?page={page}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/tv/{tmdbId}/recommendations")]
        [Authorize]
        public Task<IActionResult> GetRecommendedTvShows(int tmdbId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest($"/api/v1/tv/{tmdbId}/recommendations?page={page}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/tv/{tmdbId}/ratings")]
        [Authorize]
        public Task<IActionResult> GetTvRatingsCombined(int tmdbId)
        {
            return ProxyJellyseerrRequest($"/api/v1/tv/{tmdbId}/ratings", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/tv/network/{networkId}")]
        [Authorize]
        public Task<IActionResult> DiscoverTvByNetwork(int networkId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/tv?page={page}&network={networkId}"), HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/movies/studio/{studioId}")]
        [Authorize]
        public Task<IActionResult> DiscoverMoviesByStudio(int studioId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/movies?page={page}&studio={studioId}"), HttpMethod.Get);
        }

        /// <summary>
        /// Series produced by a TMDB company (studio) — the TV half of a
        /// studio feed. Seerr's /discover/tv filters by network only, so this
        /// asks TMDB's discover/tv?with_companies directly (through the shared
        /// TMDB response cache) and answers in Seerr's discover shape; see
        /// TmdbCompanyTvDiscover for what the rows carry. Same per-user
        /// parental gate as the Seerr-proxied discover feeds.
        /// </summary>
        [HttpGet("jellyseerr/discover/tv/studio/{studioId}")]
        [Authorize]
        public async Task<IActionResult> DiscoverTvByStudio(int studioId, [FromQuery] int page = 1, [FromQuery] string? sortBy = null)
        {
            // Per-user body (library ids, parental filtering): never kept by the browser.
            Response.Headers["Cache-Control"] = "no-store";

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.JellyseerrEnabled)
            {
                return StatusCode(503, "Seerr integration is not configured or enabled.");
            }
            if (string.IsNullOrEmpty(config.TMDB_API_KEY))
            {
                return StatusCode(503, "TMDB API key is not configured.");
            }
            if (studioId <= 0 || page < 1 || page > 500)
            {
                return BadRequest(new { error = true, code = "invalid_parameters", message = "studioId must be positive and page between 1 and 500." });
            }

            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null)
            {
                return Forbid();
            }

            var query = $"?with_companies={studioId}&page={page}";
            if (Features.Seerr.Services.TmdbCompanyTvDiscover.IsValidSort(sortBy))
            {
                query += $"&sort_by={sortBy}";
            }
            // The filters the Seerr-fed feeds take, under TMDB's names.
            query += Features.Seerr.Services.DiscoverFilters.ToTmdbTvQuery(ReadQueryValue);

            try
            {
                var response = await _tmdbResponseCache.GetAsync("discover/tv", query, config.TMDB_API_KEY, HttpContext.RequestAborted);
                if (!response.IsSuccess)
                {
                    _logger.Warning($"TMDB discover/tv for company {studioId} (page {page}) returned {response.StatusCode}.");
                    return StatusCode(502, new { error = true, code = "tmdb_error", message = "TMDB did not answer the series-by-studio lookup." });
                }

                // One indexed provider-id lookup per row, scoped to what this user
                // may see, so in-library series link into Jellyfin and honour the
                // exclude-library-items setting like the Seerr-fed cards do. Those
                // rows (usually few) take Seerr's own mediaInfo, the same detail
                // call the More Info modal makes, so a partly available series
                // keeps "Request missing" instead of reading as fully available.
                var jUser = _userManager.GetUserById(userId.Value);
                var mediaInfo = new Dictionary<int, string>();
                if (jUser != null)
                {
                    var inLibrary = new List<(int TmdbId, Guid ItemId)>();
                    foreach (var tmdbId in Features.Seerr.Services.TmdbCompanyTvDiscover.ReadRowIds(response.Content))
                    {
                        var item = _libraryItemLookup.FindLibraryItemByTmdb(jUser, "tv", tmdbId.ToString(System.Globalization.CultureInfo.InvariantCulture));
                        if (item != null) inLibrary.Add((tmdbId, item.Id));
                    }
                    var seerrInfo = await Task.WhenAll(inLibrary.Select(row => GetSeerrTvMediaInfoAsync(row.TmdbId)));
                    for (var i = 0; i < inLibrary.Count; i++)
                    {
                        mediaInfo[inLibrary[i].TmdbId] = seerrInfo[i] ?? Features.Seerr.Services.TmdbCompanyTvDiscover.LibraryMediaInfo(inLibrary[i].ItemId);
                    }
                }
                var body = Features.Seerr.Services.TmdbCompanyTvDiscover.ToSeerrShape(response.Content, mediaInfo);

                return await ApplyParentalFilterAsync(body, $"/api/v1/discover/tv?studio={studioId}&page={page}", userId.Value.ToString());
            }
            catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested)
            {
                return StatusCode(499);
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to fetch series for company {studioId} from TMDB. Error: {ex.Message}");
                return StatusCode(502, new { error = true, code = "tmdb_error", message = "Failed to connect to TMDB." });
            }
        }

        /// <summary>
        /// Seerr's mediaInfo for a series, read through the caller's proxied
        /// /api/v1/tv/{id} (same response cache and parental gate as the More
        /// Info modal). Null when Seerr has no record of it or does not answer.
        /// </summary>
        private async Task<string?> GetSeerrTvMediaInfoAsync(int tmdbId)
        {
            var result = await ProxyJellyseerrRequest($"/api/v1/tv/{tmdbId}", HttpMethod.Get);
            return result is ContentResult { StatusCode: null or 200, Content: { } json }
                ? Features.Seerr.Services.TmdbCompanyTvDiscover.ExtractMediaInfo(json)
                : null;
        }

        [HttpGet("jellyseerr/discover/trending")]
        [Authorize]
        public Task<IActionResult> DiscoverTrending([FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/trending?page={page}"), HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/movies")]
        [Authorize]
        public Task<IActionResult> DiscoverMovies([FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/movies?page={page}"), HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/tv")]
        [Authorize]
        public Task<IActionResult> DiscoverTv([FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/tv?page={page}"), HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/movies/upcoming")]
        [Authorize]
        public Task<IActionResult> DiscoverUpcomingMovies([FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/movies/upcoming?page={page}"), HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/tv/upcoming")]
        [Authorize]
        public Task<IActionResult> DiscoverUpcomingTv([FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/tv/upcoming?page={page}"), HttpMethod.Get);
        }

        /// <summary>
        /// The item, when the caller may see it (library access and parental rules, as Jellyfin's own
        /// item routes apply them); null otherwise, so a hidden item reads as a missing one.
        /// Administrators get any item, as before.
        /// </summary>
        private BaseItem? GetItemForCaller(Guid id)
        {
            if (IsAdminUser()) return _libraryManager.GetItemById(id);
            var userId = UserHelper.GetCurrentUserId(User);
            var user = userId.HasValue ? _userManager.GetUserById(userId.Value) : null;
            return user == null ? null : _libraryManager.GetItemById<BaseItem>(id, user);
        }

        [HttpGet("studio/{studioId}")]
        [Authorize]
        public IActionResult GetStudioInfo(Guid studioId)
        {
            try
            {
                var studio = GetItemForCaller(studioId);
                if (studio == null)
                {
                    return NotFound(new { message = "Studio not found" });
                }

                // Get TMDB ID from provider IDs if available
                string? tmdbId = null;
                if (studio.ProviderIds != null && studio.ProviderIds.TryGetValue("Tmdb", out var id))
                {
                    tmdbId = id;
                }

                return Ok(new
                {
                    id = studio.Id,
                    name = studio.Name,
                    tmdbId = tmdbId,
                    type = studio.GetType().Name
                });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to get studio info for {studioId}: {ex.Message}");
                return StatusCode(500, new { message = "Failed to get studio info" });
            }
        }

        [HttpGet("boxset/{boxsetId}")]
        [Authorize]
        public IActionResult GetBoxSetInfo(Guid boxsetId)
        {
            try
            {
                var boxset = GetItemForCaller(boxsetId);
                if (boxset == null || boxset.GetType().Name != "BoxSet")
                {
                    return NotFound(new { message = "BoxSet not found" });
                }

                // Get TMDB collection ID from provider IDs
                string? tmdbId = null;
                if (boxset.ProviderIds != null && boxset.ProviderIds.TryGetValue("Tmdb", out var id))
                {
                    tmdbId = id;
                }

                return Ok(new
                {
                    id = boxset.Id,
                    name = boxset.Name,
                    tmdbId = tmdbId,
                    type = boxset.GetType().Name
                });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to get boxset info for {boxsetId}: {ex.Message}");
                return StatusCode(500, new { message = "Failed to get boxset info" });
            }
        }

        [HttpGet("person/{personId}")]
        [Authorize]
        public async Task<IActionResult> GetPersonInfo(Guid personId, [FromQuery] Guid? itemId = null)
        {
            try
            {
                // Only an item the caller may see (a hidden item reads as a missing one); administrators as before.
                var person = GetItemForCaller(personId);
                if (person == null)
                {
                    return NotFound(new { message = "Person not found" });
                }

                var itemPremiereDate = ResolveVisibleItemPremiereDate(itemId);
                return Ok(await BuildPersonInfoAsync(person, itemPremiereDate, HttpContext.RequestAborted));
            }
            catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested)
            {
                return StatusCode(499); // browser went away
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to get person info for {personId}: {ex.Message}");
                return StatusCode(500, new { message = "Failed to get person info" });
            }
        }

        private const int MaxPeopleInfoBatchSize = 100;
        // Per request; TmdbResponseCache caps the upstream calls in flight
        // across all requests (and multiplexes them over one HTTP/2
        // connection), so a cast row resolves in about one TMDB round trip.
        private const int PeopleInfoTmdbConcurrency = 16;
        // One slow TMDB lookup must not hold a whole cast batch (or a single
        // person request) hostage: past this, fall back to Jellyfin-only data.
        private static readonly TimeSpan PersonTmdbTimeout = TimeSpan.FromSeconds(6);

        /// <summary>
        /// Batch form of <see cref="GetPersonInfo"/> for the People Tags cast
        /// row: one request for every cast card instead of one per actor.
        /// <c>ids</c> is a comma-separated list of person GUIDs (N or D format,
        /// malformed entries ignored, duplicates collapsed, at most
        /// <see cref="MaxPeopleInfoBatchSize"/> distinct ids). Returns
        /// <c>{ people: { "&lt;personId N&gt;": { ...same shape as person/{id}... } } }</c>;
        /// ids that are not Person entities are omitted.
        /// </summary>
        [HttpGet("people/info")]
        [Authorize]
        public async Task<IActionResult> GetPeopleInfo([FromQuery] string? ids, [FromQuery] Guid? itemId = null)
        {
            var personIds = new HashSet<Guid>();
            var parsedIds = (ids ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(raw => Guid.TryParse(raw, out var parsed) ? parsed : Guid.Empty)
                .Where(parsed => parsed != Guid.Empty);
            foreach (var parsed in parsedIds)
            {
                personIds.Add(parsed);
                if (personIds.Count > MaxPeopleInfoBatchSize)
                {
                    return BadRequest(new { message = $"At most {MaxPeopleInfoBatchSize} person ids per request." });
                }
            }

            if (personIds.Count == 0)
            {
                return BadRequest(new { message = "No valid person ids supplied." });
            }

            var ct = HttpContext.RequestAborted;
            try
            {
                var people = _libraryManager.GetItemList(new InternalItemsQuery
                {
                    ItemIds = personIds.ToArray(),
                    IncludeItemTypes = new[] { BaseItemKind.Person }
                })
                    .OfType<MediaBrowser.Controller.Entities.Person>()
                    .GroupBy(p => p.Id)
                    .Select(g => g.First())
                    .ToList();

                // Resolved once for the whole batch rather than per person.
                var itemPremiereDate = ResolveVisibleItemPremiereDate(itemId);

                using var tmdbGate = new SemaphoreSlim(PeopleInfoTmdbConcurrency);
                var tasks = people.Select(async person =>
                {
                    await tmdbGate.WaitAsync(ct).ConfigureAwait(false);
                    try
                    {
                        return (Key: person.Id.ToString("N"), Info: await BuildPersonInfoAsync(person, itemPremiereDate, ct).ConfigureAwait(false));
                    }
                    finally
                    {
                        tmdbGate.Release();
                    }
                }).ToList();

                var results = await Task.WhenAll(tasks).ConfigureAwait(false);
                ct.ThrowIfCancellationRequested();

                var map = new Dictionary<string, object>(results.Length, StringComparer.OrdinalIgnoreCase);
                foreach (var (key, info) in results)
                {
                    map[key] = info;
                }

                return Ok(new { people = map });
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return StatusCode(499); // browser went away (navigated off / superseded)
            }
            catch (Exception ex) when (ex is InvalidOperationException or IOException or System.Data.Common.DbException)
            {
                // What the library/database layer throws.
                _logger.Error($"Failed to get batch person info ({personIds.Count} ids): {ex.Message}");
                return StatusCode(500, new { message = "Failed to get person info" });
            }
        }

        /// <summary>
        /// PremiereDate of the item used for "age at release", honoured only
        /// when that item is visible to the calling user (library access and
        /// parental rules); otherwise null so no age-at-release is derived.
        /// </summary>
        private DateTime? ResolveVisibleItemPremiereDate(Guid? itemId)
        {
            if (!itemId.HasValue || itemId.Value == Guid.Empty)
            {
                return null;
            }

            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId.Value == Guid.Empty)
            {
                return null;
            }

            try
            {
                var user = _userManager.GetUserById(userId.Value);
                if (user == null)
                {
                    return null;
                }

                // The user overload returns null when the item is not visible
                // to this user.
                var item = _libraryManager.GetItemById<BaseItem>(itemId.Value, user);
                return item?.PremiereDate;
            }
            catch (Exception ex) when (ex is InvalidOperationException or IOException or System.Data.Common.DbException)
            {
                // What the library/database layer throws.
                _logger.Warning($"Could not resolve item {itemId.Value} for person ages: {ex.GetType().Name}: {ex.Message}");
                return null;
            }
        }

        /// <summary>
        /// Shared response object for person/{id} and people/info. The shape
        /// is part of the client contract (peopletags.js, person-discovery.js).
        /// </summary>
        private async Task<object> BuildPersonInfoAsync(BaseItem person, DateTime? itemPremiereDate, CancellationToken cancellationToken)
        {
            // Get TMDB ID from provider IDs if available
            string? tmdbId = null;
            if (person.ProviderIds != null && person.ProviderIds.TryGetValue("Tmdb", out var id))
            {
                tmdbId = id;
            }

            // Get person-specific data
            // Note: PremiereDate on Person items stores birth date, EndDate stores death date
            var birthDate = person.PremiereDate;
            var endDate = person.EndDate;
            var birthPlace = person.ProductionLocations?.FirstOrDefault() ?? null;

            // Try to enrich with TMDB data if available
            if (!string.IsNullOrEmpty(tmdbId) && int.TryParse(tmdbId, out var tmdbPersonId))
            {
                using var tmdbTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                tmdbTimeout.CancelAfter(PersonTmdbTimeout);
                try
                {
                    // _logger.Info($"Fetching TMDB data for person {person.Id} (TMDB ID: {tmdbPersonId})");
                    var tmdbPersonData = await GetTmdbPersonData(tmdbPersonId, tmdbTimeout.Token).ConfigureAwait(false);
                    if (tmdbPersonData != null)
                    {
                        // _logger.Info($"TMDB data received: BirthPlace={tmdbPersonData.BirthPlace}, BirthDate={tmdbPersonData.BirthDate}, DeathDate={tmdbPersonData.DeathDate}");

                        // Use TMDB death date if Jellyfin doesn't have it
                        if (!endDate.HasValue && tmdbPersonData.DeathDate.HasValue)
                        {
                            endDate = tmdbPersonData.DeathDate;
                        }

                        // Use TMDB birth date if Jellyfin doesn't have it
                        if (!birthDate.HasValue && tmdbPersonData.BirthDate.HasValue)
                        {
                            birthDate = tmdbPersonData.BirthDate;
                        }

                        // Always prefer TMDB birthplace
                        if (!string.IsNullOrEmpty(tmdbPersonData.BirthPlace))
                        {
                            birthPlace = tmdbPersonData.BirthPlace;
                            // _logger.Debug($"Using TMDB birthplace: {birthPlace}");
                        }
                    }
                    else
                    {
                        _logger.Warning($"No TMDB data returned for person {person.Id} (TMDB ID: {tmdbPersonId})");
                    }
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested && tmdbTimeout.IsCancellationRequested)
                {
                    _logger.Warning($"TMDB lookup for person {person.Id} (TMDB ID: {tmdbPersonId}) exceeded {PersonTmdbTimeout.TotalSeconds:0}s; using Jellyfin data only");
                }
                catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
                {
                    _logger.Warning($"Failed to enrich person {person.Id} with TMDB data: {ex.Message}");
                    // Continue with Jellyfin data only
                }
            }
            else
            {
                // _logger.Debug($"No TMDB ID available for person {person.Id}");
            }

            int? currentAge = null;
            int? ageAtItemRelease = null;
            int? ageAtDeath = null;
            bool isDeceased = endDate.HasValue && endDate.Value < DateTime.Now;

            // Calculate current age or age at death
            if (birthDate.HasValue)
            {
                if (isDeceased)
                {
                    // If deceased, calculate age at death
                    ageAtDeath = CalculateAge(birthDate.Value, endDate!.Value); // isDeceased implies a death date
                }
                else
                {
                    // If alive, calculate current age
                    currentAge = CalculateAge(birthDate.Value, DateTime.Now);
                }

                // Calculate age at item release if a visible item was provided
                if (itemPremiereDate.HasValue)
                {
                    ageAtItemRelease = CalculateAge(birthDate.Value, itemPremiereDate.Value);
                }
            }

            return new
            {
                id = person.Id,
                name = person.Name,
                tmdbId = tmdbId,
                type = person.GetType().Name,
                birthDate = birthDate?.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture),
                deathDate = endDate?.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture),
                birthPlace = birthPlace,
                isDeceased = isDeceased,
                currentAge = currentAge,
                ageAtDeath = ageAtDeath,
                ageAtItemRelease = ageAtItemRelease
            };
        }

        private async Task<TmdbPersonData?> GetTmdbPersonData(int tmdbPersonId, CancellationToken cancellationToken = default)
        {
            try
            {
                // Get TMDB API key from configuration
                var config = JellyfinEnhanced.Instance?.Configuration;
                if (config == null || string.IsNullOrEmpty(config.TMDB_API_KEY))
                {
                    _logger.Warning("TMDB API key not configured in plugin settings");
                    return null;
                }

                // _logger.Debug($"Fetching TMDB person data from: https://api.themoviedb.org/3/person/{tmdbPersonId}");
                var response = await _tmdbResponseCache.GetAsync($"person/{tmdbPersonId}", string.Empty, config.TMDB_API_KEY, cancellationToken);

                if (!response.IsSuccess)
                {
                    _logger.Warning($"TMDB API request failed with status {(System.Net.HttpStatusCode)response.StatusCode}");
                    return null;
                }

                var content = response.Content;
                var jsonElement = JsonSerializer.Deserialize<JsonElement>(content);

                DateTime? birthDate = null;
                DateTime? deathDate = null;
                string? birthPlace = null;

                // Parse birth date
                if (jsonElement.TryGetProperty("birthday", out var birthdayProp) &&
                    birthdayProp.ValueKind != JsonValueKind.Null &&
                    IsoDates.TryParseIso(birthdayProp.GetString()) is DateTime birth)
                {
                    birthDate = birth;
                }

                // Parse death date
                if (jsonElement.TryGetProperty("deathday", out var deathdayProp) &&
                    deathdayProp.ValueKind != JsonValueKind.Null &&
                    deathdayProp.GetString() is string deathStr &&
                    IsoDates.TryParseIso(deathStr) is DateTime death)
                {
                    deathDate = death;
                }

                // Parse birth place
                if (jsonElement.TryGetProperty("place_of_birth", out var placeProp) &&
                    placeProp.ValueKind != JsonValueKind.Null)
                {
                    birthPlace = placeProp.GetString();
                    if (!string.IsNullOrEmpty(birthPlace))
                    {
                        // _logger.Debug($"Parsed place_of_birth: {birthPlace}");
                    }
                }

                return new TmdbPersonData
                {
                    BirthDate = birthDate,
                    DeathDate = deathDate,
                    BirthPlace = birthPlace
                };
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                // Browser went away; the shared TMDB call still finishes and is cached.
                throw;
            }
            catch (Exception ex)
            {
                _logger.Warning($"Failed to get TMDB person data for ID {tmdbPersonId}: {ex.Message}");
                return null;
            }
        }

        private int CalculateAge(DateTime birthDate, DateTime referenceDate)
        {
            int age = referenceDate.Year - birthDate.Year;
            if (referenceDate < birthDate.AddYears(age))
            {
                age--;
            }
            return Math.Max(0, age);
        }

        [HttpGet("genre/{genreId}")]
        [Authorize]
        public IActionResult GetGenreInfo(Guid genreId)
        {
            try
            {
                var genre = GetItemForCaller(genreId);
                if (genre == null)
                {
                    return NotFound(new { message = "Genre not found" });
                }

                return Ok(new
                {
                    id = genre.Id,
                    name = genre.Name,
                    type = genre.GetType().Name
                });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to get genre info for {genreId}: {ex.Message}");
                return StatusCode(500, new { message = "Failed to get genre info" });
            }
        }

        [HttpGet("jellyseerr/person/{personId}")]
        [Authorize]
        public Task<IActionResult> GetJellyseerrPerson(int personId)
        {
            // TMDB person id 0 / negative produces a noisy 500 from
            // Seerr. Cheap to reject up-front so admins don't see "code=UpstreamError"
            // for what is really an invalid input.
            if (personId <= 0)
            {
                return Task.FromResult<IActionResult>(BadRequest(new
                {
                    error = true,
                    code = "invalid_person_id",
                    message = "TMDB person id must be positive."
                }));
            }
            return ProxyJellyseerrRequest($"/api/v1/person/{personId}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/person/{personId}/combined_credits")]
        [Authorize]
        public Task<IActionResult> GetJellyseerrPersonCredits(int personId)
        {
            if (personId <= 0)
            {
                return Task.FromResult<IActionResult>(BadRequest(new
                {
                    error = true,
                    code = "invalid_person_id",
                    message = "TMDB person id must be positive."
                }));
            }
            return ProxyJellyseerrRequest($"/api/v1/person/{personId}/combined_credits", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/tv/genre/{genreId}")]
        [Authorize]
        public Task<IActionResult> DiscoverTvByGenre(int genreId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/tv?page={page}&genre={genreId}"), HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/movies/genre/{genreId}")]
        [Authorize]
        public Task<IActionResult> DiscoverMoviesByGenre(int genreId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/movies?page={page}&genre={genreId}"), HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/tv/keyword/{keywordId}")]
        [Authorize]
        public Task<IActionResult> DiscoverTvByKeyword(int keywordId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/tv?page={page}&keywords={keywordId}"), HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/movies/keyword/{keywordId}")]
        [Authorize]
        public Task<IActionResult> DiscoverMoviesByKeyword(int keywordId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/movies?page={page}&keywords={keywordId}"), HttpMethod.Get);
        }

        [HttpGet("tmdb/search/person")]
        [Authorize]
        public Task<IActionResult> SearchTmdbPerson([FromQuery] string query)
        {
            if (string.IsNullOrWhiteSpace(query))
            {
                return Task.FromResult<IActionResult>(BadRequest(new { message = "Query cannot be empty" }));
            }
            return ProxyJellyseerrRequest($"/api/v1/search?query={Uri.EscapeDataString(query)}&page=1", HttpMethod.Get);
        }

        [HttpGet("tmdb/search/keyword")]
        [Authorize]
        public Task<IActionResult> SearchTmdbKeyword([FromQuery] string query)
        {
            if (string.IsNullOrWhiteSpace(query))
            {
                return Task.FromResult<IActionResult>(BadRequest(new { message = "Query cannot be empty" }));
            }
            return ProxyJellyseerrRequest($"/api/v1/search/keyword?query={Uri.EscapeDataString(query)}", HttpMethod.Get);
        }

        [HttpGet("tmdb/genres/movie")]
        [Authorize]
        public Task<IActionResult> GetTmdbMovieGenres()
        {
            return ProxyJellyseerrRequest("/api/v1/genres/movie", HttpMethod.Get);
        }

        [HttpGet("tmdb/genres/tv")]
        [Authorize]
        public Task<IActionResult> GetTmdbTvGenres()
        {
            return ProxyJellyseerrRequest("/api/v1/genres/tv", HttpMethod.Get);
        }

        // The lists the discovery filters offer, from Seerr (which reads them from
        // TMDB). None of them carries a title.
        /// <summary>The languages the discovery filters offer (Seerr's <c>/api/v1/languages</c>).</summary>
        [HttpGet("jellyseerr/filters/languages")]
        [Authorize]
        public Task<IActionResult> GetSeerrFilterLanguages()
        {
            return ProxyJellyseerrRequest("/api/v1/languages", HttpMethod.Get);
        }

        /// <summary>The content ratings for movies or series (<paramref name="mediaType"/> is <c>movie</c> or <c>tv</c>).</summary>
        [HttpGet("jellyseerr/filters/certifications/{mediaType}")]
        [Authorize]
        public Task<IActionResult> GetSeerrFilterCertifications(string mediaType)
        {
            if (mediaType != "movie" && mediaType != "tv")
            {
                return Task.FromResult<IActionResult>(BadRequest(new { error = true, code = "invalid_media_type", message = "mediaType must be movie or tv." }));
            }
            return ProxyJellyseerrRequest($"/api/v1/certifications/{mediaType}", HttpMethod.Get);
        }

        /// <summary>
        /// The streaming services for movies or series in a region: <paramref name="watchRegion"/>,
        /// or the admin's DEFAULT_REGION when none is sent.
        /// </summary>
        [HttpGet("jellyseerr/filters/watchproviders/{mediaType}")]
        [Authorize]
        public Task<IActionResult> GetSeerrFilterWatchProviders(string mediaType, [FromQuery] string? watchRegion = null)
        {
            if (mediaType != "movie" && mediaType != "tv")
            {
                return Task.FromResult<IActionResult>(BadRequest(new { error = true, code = "invalid_media_type", message = "mediaType must be movie or tv." }));
            }
            var region = string.IsNullOrEmpty(watchRegion)
                ? Shared.Tmdb.WatchProvidersBatch.DefaultRegion(JellyfinEnhanced.Instance?.Configuration?.DEFAULT_REGION)
                : watchRegion;
            if (!Shared.Tmdb.WatchProvidersBatch.IsValidRegion(region))
            {
                return Task.FromResult<IActionResult>(BadRequest(new { error = true, code = "invalid_region", message = "watchRegion must be a two-letter region code." }));
            }
            return ProxyJellyseerrRequest($"/api/v1/watchproviders/{(mediaType == "movie" ? "movies" : "tv")}?watchRegion={region}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/genreslider/movie")]
        [Authorize]
        public Task<IActionResult> GetMovieGenreSlider()
        {
            return ProxyJellyseerrRequest("/api/v1/discover/genreslider/movie", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/genreslider/tv")]
        [Authorize]
        public Task<IActionResult> GetTvGenreSlider()
        {
            return ProxyJellyseerrRequest("/api/v1/discover/genreslider/tv", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/overrideRule")]
        [Authorize]
        public Task<IActionResult> GetOverrideRules()
        {
            return ProxyJellyseerrRequest("/api/v1/overrideRule", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/collection/{collectionId}")]
        [Authorize]
        public Task<IActionResult> GetCollection(int collectionId)
        {
            return ProxyJellyseerrRequest($"/api/v1/collection/{collectionId}", HttpMethod.Get);
        }
    }
}
