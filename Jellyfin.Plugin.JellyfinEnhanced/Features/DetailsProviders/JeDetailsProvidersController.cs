using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Auth;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Http;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Library;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders
{
    /// <summary>
    /// Details-page providers: AniList and user reviews, translation, awards, MDBList ratings, Does The Dog Die,
    /// the elsewhere.json document, item stats and the *arr links (restructure S2.12, moved verbatim from
    /// JellyfinEnhancedController).
    /// </summary>
    [Route("JellyfinEnhanced")]
    [ApiController]
    public partial class JeDetailsProvidersController : JeControllerBase
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard.SpoilerSeerrRedactor _spoilerSeerrRedactor;
        private readonly IUserDataManager _userDataManager;
        private readonly ILibraryManager _libraryManager;
        private readonly WikidataAwardsService _wikidataAwardsService;
        private readonly AnilistReviewsService _anilistReviewsService;
        private readonly ReviewTranslationService _reviewTranslationService;
        private readonly MdblistService _mdblistService;
        private readonly DoesTheDogDieService _doesTheDogDieService;
        private readonly ItemStatsService _itemStats;
        private readonly UserDisplayResolver _userDisplayResolver;
        private readonly ArrInstanceClient _arrInstanceClient;
        private readonly LibraryItemLookup _libraryItemLookup;

        public JeDetailsProvidersController(
            IHttpClientFactory httpClientFactory,
            Logger logger,
            IUserManager userManager,
            IUserDataManager userDataManager,
            ILibraryManager libraryManager,
            UserConfigurationManager userConfigurationManager,
            WikidataAwardsService wikidataAwardsService,
            AnilistReviewsService anilistReviewsService,
            ReviewTranslationService reviewTranslationService,
            MdblistService mdblistService,
            DoesTheDogDieService doesTheDogDieService,
            Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard.SpoilerSeerrRedactor spoilerSeerrRedactor,
            ItemStatsService itemStats)
            : base(userManager, logger, userConfigurationManager)
        {
            _httpClientFactory = httpClientFactory;
            _userDataManager = userDataManager;
            _libraryManager = libraryManager;
            _wikidataAwardsService = wikidataAwardsService;
            _anilistReviewsService = anilistReviewsService;
            _reviewTranslationService = reviewTranslationService;
            _mdblistService = mdblistService;
            _doesTheDogDieService = doesTheDogDieService;
            _spoilerSeerrRedactor = spoilerSeerrRedactor;
            _itemStats = itemStats;
            _userDisplayResolver = new UserDisplayResolver(userManager);
            _arrInstanceClient = new ArrInstanceClient(httpClientFactory, logger);
            _libraryItemLookup = new LibraryItemLookup(libraryManager, logger);
        }

        /// <summary>
        /// Browser-cache policy for the awards and MDBList ratings responses: the
        /// same body for every user (no per-user gating beyond [Authorize]), backed
        /// by server caches that keep it for days, so a revisit or reload within
        /// half an hour reuses the browser's copy instead of asking again. Private
        /// and varied on the auth headers like the TMDB passthrough, so no shared
        /// cache keeps it and one account's copy is never reused by another.
        /// Set only for an answer the upstream actually gave (Confirmed): errors
        /// and failure placeholders, which the server retries within the hour,
        /// are never kept.
        /// </summary>
        private void SetExternalDataCacheHeaders()
        {
            Response.Headers["Cache-Control"] = "private, max-age=1800";
            Response.Headers["Vary"] = "Authorization, X-Emby-Token, X-Jellyfin-User-Id";
        }

        /// <summary>Top AniList reviews for an anime, by AniList id.</summary>
        [HttpGet("anilist/reviews")]
        [Authorize]
        public async Task<IActionResult> GetAnilistReviews([FromQuery] int anilistId, CancellationToken cancellationToken)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.ShowAnilistReviews)
            {
                return StatusCode(503, "AniList reviews are not enabled.");
            }

            if (anilistId <= 0)
            {
                return BadRequest("anilistId must be a positive integer.");
            }

            try
            {
                var result = await _anilistReviewsService.GetReviewsAsync(anilistId, cancellationToken).ConfigureAwait(false);
                SetExternalDataCacheHeaders();
                return Ok(result);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.Error($"Failed to fetch AniList reviews. Error: {ex.Message}");
                return StatusCode(502, "Failed to fetch AniList reviews.");
            }
        }

        /// <summary>Languages English reviews can be translated into on the configured LibreTranslate instance.</summary>
        [HttpGet("translate/languages")]
        [Authorize]
        public async Task<IActionResult> GetTranslationLanguages(CancellationToken cancellationToken)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.ReviewTranslationEnabled || string.IsNullOrWhiteSpace(config.ReviewTranslationUrl))
            {
                return StatusCode(503, "Review translation is not enabled.");
            }

            var baseUrl = config.ReviewTranslationUrl.Trim().TrimEnd('/');
            if (!await Jellyfin.Plugin.JellyfinEnhanced.Shared.Arr.ArrUrlGuard.IsAllowedUrlAsync(baseUrl, cancellationToken).ConfigureAwait(false))
            {
                return BadRequest("The translation URL is not allowed.");
            }

            try
            {
                return Ok(new { languages = await _reviewTranslationService.GetTargetLanguagesAsync(baseUrl, cancellationToken).ConfigureAwait(false) });
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.Error($"Failed to read translation languages. Error: {ex.Message}");
                return StatusCode(502, "Failed to reach the translation service.");
            }
        }

        /// <summary>Translates English review text into the target language, live.</summary>
        [HttpPost("translate")]
        [Authorize]
        public async Task<IActionResult> TranslateReview([FromBody] TranslateRequest request, CancellationToken cancellationToken)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.ReviewTranslationEnabled || string.IsNullOrWhiteSpace(config.ReviewTranslationUrl))
            {
                return StatusCode(503, "Review translation is not enabled.");
            }

            if (string.IsNullOrWhiteSpace(request?.Text) || request.Text.Length > Services.ReviewTranslationService.MaxTextLength)
            {
                return BadRequest($"text must be between 1 and {Services.ReviewTranslationService.MaxTextLength} characters.");
            }

            if (string.IsNullOrWhiteSpace(request.Target) || !System.Text.RegularExpressions.Regex.IsMatch(request.Target, "^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$"))
            {
                return BadRequest("target must be a language code.");
            }

            var baseUrl = config.ReviewTranslationUrl.Trim().TrimEnd('/');
            if (!await Jellyfin.Plugin.JellyfinEnhanced.Shared.Arr.ArrUrlGuard.IsAllowedUrlAsync(baseUrl, cancellationToken).ConfigureAwait(false))
            {
                return BadRequest("The translation URL is not allowed.");
            }

            try
            {
                var translated = await _reviewTranslationService.TranslateAsync(
                    baseUrl, config.ReviewTranslationApiKey ?? string.Empty, request.Text, request.Target, cancellationToken).ConfigureAwait(false);
                return Ok(new { text = translated });
            }
            catch (Services.TranslationLimitException ex)
            {
                // A rate limit is passed on as 429 (with the wait, when the service gave one) so the client
                // can say "try again later"; a refusal (403) stays a 502 with its own error code.
                var rateLimited = ex.StatusCode == System.Net.HttpStatusCode.TooManyRequests;
                int? retryAfterSeconds = ex.RetryAfter is { } wait ? (int)Math.Ceiling(wait.TotalSeconds) : null;
                if (rateLimited && retryAfterSeconds is { } seconds)
                {
                    Response.Headers["Retry-After"] = seconds.ToString(System.Globalization.CultureInfo.InvariantCulture);
                }

                _logger.Warning($"Translation service returned {(int)ex.StatusCode!} for a review. {ex.Message}");
                return StatusCode(rateLimited ? 429 : 502, new
                {
                    error = true,
                    code = rateLimited ? "translation_rate_limited" : "translation_refused",
                    message = ex.Message,
                    retryAfterSeconds = rateLimited ? retryAfterSeconds : null,
                });
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.Error($"Failed to translate a review. Error: {ex.Message}");
                return StatusCode(502, "Failed to translate the review.");
            }
        }

        public class TranslateRequest
        {
            public string? Text { get; set; }

            public string? Target { get; set; }
        }

        [HttpGet("awards/{mediaType}/{tmdbId}")]
        [Authorize]
        public async Task<IActionResult> GetAwards(string mediaType, string tmdbId, CancellationToken cancellationToken)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.ShowAwards)
            {
                return StatusCode(503, "Awards feature is not enabled.");
            }

            if (mediaType != "movie" && mediaType != "tv" && mediaType != "person")
            {
                return BadRequest("mediaType must be 'movie', 'tv', or 'person'.");
            }

            if (string.IsNullOrWhiteSpace(tmdbId) || !tmdbId.All(char.IsDigit))
            {
                return BadRequest("tmdbId must be a positive integer.");
            }

            try
            {
                var result = await _wikidataAwardsService.GetAwardsAsync(mediaType, tmdbId, cancellationToken).ConfigureAwait(false);
                if (result.Confirmed)
                {
                    SetExternalDataCacheHeaders();
                }
                return Ok(result);
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to fetch awards for {mediaType}:{tmdbId}. Error: {ex.Message}");
                return StatusCode(500, "Failed to fetch awards.");
            }
        }

        /// <summary>
        /// MDBList ratings (TMDB score, Rotten Tomatoes critic/audience, IMDb,
        /// Trakt, Metacritic, etc.) for a title, keyed by TMDB id. Backed by
        /// MdblistService's disk cache -- the admin's MDBList API key is used
        /// server-side only and never reaches the client.
        /// </summary>
        [HttpGet("mdblist-ratings/{mediaType}/{tmdbId}")]
        [Authorize]
        public async Task<IActionResult> GetMdblistRatings(string mediaType, string tmdbId, CancellationToken cancellationToken)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.MdblistRatingsEnabled)
            {
                return StatusCode(503, "MDBList ratings feature is not enabled.");
            }

            if (mediaType != "movie" && mediaType != "tv")
            {
                return BadRequest("mediaType must be 'movie' or 'tv'.");
            }

            if (string.IsNullOrWhiteSpace(tmdbId) || !tmdbId.All(char.IsDigit))
            {
                return BadRequest("tmdbId must be a positive integer.");
            }

            // Unconfirmed so neither the browser nor the client cache keeps this answer,
            // which only holds while the title is guarded.
            if (_spoilerSeerrRedactor.HidesRatings(mediaType, tmdbId, UserHelper.GetCurrentUserId(User)?.ToString(), HttpContext))
            {
                return Ok(new { Found = false, Confirmed = false });
            }

            try
            {
                var result = await _mdblistService.GetRatingsAsync(mediaType, tmdbId, cancellationToken).ConfigureAwait(false);
                if (result.Confirmed)
                {
                    SetExternalDataCacheHeaders();
                }
                return Ok(result);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return StatusCode(499); // browser went away; nothing was cached
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to fetch MDBList ratings for {mediaType}:{tmdbId}. Error: {ex.Message}");
                return StatusCode(500, "Failed to fetch MDBList ratings.");
            }
        }

        private bool DoesTheDogDieActive(out PluginConfiguration? config)
        {
            config = JellyfinEnhanced.Instance?.Configuration;
            return config != null && config.DoesTheDogDieEnabled && !string.IsNullOrWhiteSpace(config.DoesTheDogDieApiKey);
        }

        /// <summary>DoesTheDogDie content warnings for a title, by TMDB id.</summary>
        [HttpGet("ddd/{mediaType}/{tmdbId}")]
        [Authorize]
        public async Task<IActionResult> GetDoesTheDogDie(string mediaType, string tmdbId, CancellationToken cancellationToken)
        {
            if (!DoesTheDogDieActive(out _)) return StatusCode(503, "DoesTheDogDie is not enabled.");
            if (mediaType != "movie" && mediaType != "tv") return BadRequest("mediaType must be 'movie' or 'tv'.");
            if (string.IsNullOrWhiteSpace(tmdbId) || !tmdbId.All(char.IsDigit)) return BadRequest("tmdbId must be a positive integer.");

            try
            {
                var result = await _doesTheDogDieService.GetWarningsAsync(mediaType, tmdbId, cancellationToken).ConfigureAwait(false);
                if (result.Confirmed) SetExternalDataCacheHeaders();
                return Ok(result);
            }
            catch (OperationCanceledException)
            {
                return StatusCode(499);
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to fetch DoesTheDogDie data for {mediaType}:{tmdbId}. Error: {ex.Message}");
                return StatusCode(500, "Failed to fetch DoesTheDogDie data.");
            }
        }

        /// <summary>Monthly request budget for the config page's Service Status card. refresh=true spends one request to measure it.</summary>
        [HttpGet("ddd/usage")]
        [Authorize]
        public async Task<IActionResult> GetDoesTheDogDieUsage([FromQuery] bool refresh, CancellationToken cancellationToken)
        {
            if (!IsAdminUser()) return Forbid();
            if (string.IsNullOrWhiteSpace(JellyfinEnhanced.Instance?.Configuration?.DoesTheDogDieApiKey))
            {
                return StatusCode(503, "DoesTheDogDie API key is not configured.");
            }

            try
            {
                var usage = refresh
                    ? await _doesTheDogDieService.RefreshUsageAsync(cancellationToken).ConfigureAwait(false)
                    : _doesTheDogDieService.GetUsage();
                return Ok(usage);
            }
            catch (OperationCanceledException)
            {
                return StatusCode(499);
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to read DoesTheDogDie usage. Error: {ex.Message}");
                return StatusCode(502, "Could not reach DoesTheDogDie.");
            }
        }

        /// <summary>All DoesTheDogDie topics, for the trigger picker.</summary>
        [HttpGet("ddd/topics")]
        [Authorize]
        public async Task<IActionResult> GetDoesTheDogDieTopics(CancellationToken cancellationToken)
        {
            if (!DoesTheDogDieActive(out _)) return StatusCode(503, "DoesTheDogDie is not enabled.");

            try
            {
                var catalog = await _doesTheDogDieService.GetCatalogAsync(cancellationToken).ConfigureAwait(false);
                if (catalog == null) return StatusCode(502, "DoesTheDogDie topics are unavailable.");
                SetExternalDataCacheHeaders();
                return Ok(catalog);
            }
            catch (OperationCanceledException)
            {
                return StatusCode(499);
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to fetch DoesTheDogDie topics. Error: {ex.Message}");
                return StatusCode(500, "Failed to fetch DoesTheDogDie topics.");
            }
        }

        [HttpGet("user-settings/{userId}/ddd-triggers.json")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        public IActionResult GetUserSettingsDdd(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null) return authorizationResult;

            return Ok(_userConfigurationManager.GetUserConfiguration<DddSettings>(authorizedUserId, "ddd-triggers.json"));
        }

        [HttpPost("user-settings/{userId}/ddd-triggers.json")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult SaveUserSettingsDdd(string userId, [FromBody] DddSettings userConfiguration)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null) return authorizationResult;

            try
            {
                _userConfigurationManager.SaveUserConfiguration(authorizedUserId, "ddd-triggers.json", userConfiguration);
                return Ok(new { success = true, file = "ddd-triggers.json" });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save user DoesTheDogDie settings for {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save user DoesTheDogDie settings." });
            }
        }

        /// <summary>
        /// Live MDBList account/quota status (plan, daily limit, remaining
        /// requests, reset time) from MDBList's own GET /user endpoint, for
        /// the config page to display. Admin-only since it reveals account
        /// details -- same reasoning as ValidateTmdb. Always force-refreshes
        /// rather than serving the cached value, since querying /user doesn't
        /// itself count against the quota it's reporting on.
        /// </summary>
        /// <param name="apiKey">Optional: test an arbitrary (e.g. not-yet-saved)
        /// key instead of the saved config's, matching ValidateTmdb's pattern
        /// so the config page's "Check Status" button works before saving.</param>
        [HttpGet("mdblist-ratings/account-status")]
        [Authorize]
        public async Task<IActionResult> GetMdblistAccountStatus([FromQuery] string? apiKey, CancellationToken cancellationToken)
        {
            if (!IsAdminUser()) return Forbid();

            var effectiveKey = !string.IsNullOrWhiteSpace(apiKey)
                ? apiKey
                : JellyfinEnhanced.Instance?.Configuration?.MdblistApiKey;
            if (string.IsNullOrWhiteSpace(effectiveKey))
            {
                return StatusCode(503, "MDBList API key is not configured.");
            }

            var status = await _mdblistService.GetAccountStatusAsync(cancellationToken, forceRefresh: true, apiKeyOverride: apiKey).ConfigureAwait(false);
            if (status == null)
            {
                return StatusCode(502, "Could not reach MDBList to check account status (key may be invalid).");
            }
            return Ok(status);
        }

        [HttpGet("user-settings/{userId}/elsewhere.json")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        public IActionResult GetUserSettingsElsewhere(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            try
            {
                return Content(new Services.ElsewhereDocumentService(_userConfigurationManager).ReadJson(authorizedUserId), "application/json");
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to read user elsewhere settings for {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { message = "Elsewhere settings could not be read. The stored document has been preserved." });
            }
        }

        [HttpPost("user-settings/{userId}/elsewhere.json")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult SaveUserSettingsElsewhere(string userId, [FromBody] System.Text.Json.JsonElement userConfiguration)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            // Raw body: Jellyfin's converters would turn a number into a string for a typed model.
            if (!Services.ElsewhereDocumentService.TryParseUpdate(userConfiguration, out var update, out var invalid))
            {
                return BadRequest(new { success = false, message = invalid });
            }

            try
            {
                if (!new Services.ElsewhereDocumentService(_userConfigurationManager).TrySave(authorizedUserId, update))
                {
                    return Conflict(new { success = false, message = "Elsewhere settings are being changed by another request. Try again." });
                }

                _logger.Info($"Saved user elsewhere settings for {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)} to elsewhere.json");
                return Ok(new { success = true, file = "elsewhere.json" });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save user elsewhere settings for {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save user elsewhere settings." });
            }
        }

        /// <summary>
        /// Size and watch progress of an item and everything playable under it,
        /// in one response (see <see cref="Services.ItemStatsService"/>). The
        /// details page reads both chips from this; the two single-value
        /// routes below stay for older clients and other callers.
        /// </summary>
        [HttpGet("item-stats/{userId}/{itemId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetItemStatsByItemId(Guid userId, Guid itemId, [FromQuery] string? mediaSourceId = null)
        {
            var authorizationResult = AuthorizeUserAccess(userId, out var user);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            var item = _libraryManager.GetItemById<BaseItem>(itemId, user);
            if (item is null)
            {
                return NotFound();
            }

            var stats = _itemStats.Compute(user, item, mediaSourceId);
            return Ok(new { success = true, size = stats.Size, progress = stats.Progress, totalPlaybackTicks = stats.TotalPlaybackTicks, totalRuntimeTicks = stats.TotalRuntimeTicks });
        }

        [HttpGet("file-size/{userId}/{itemId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetFileSizeByItemId(Guid userId, Guid itemId, [FromQuery] string? mediaSourceId = null)
        {
            var authorizationResult = AuthorizeUserAccess(userId, out var user);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            var item = _libraryManager.GetItemById<BaseItem>(itemId, user);
            if (item is null)
            {
                return NotFound();
            }

            var stats = _itemStats.Compute(user, item, mediaSourceId);
            return Ok(new { success = true, size = stats.Size });
        }

        [HttpGet("watch-progress/{userId}/{itemId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetWatchProgressByItemId(Guid userId, Guid itemId)
        {
            var authorizationResult = AuthorizeUserAccess(userId, out var user);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            var item = _libraryManager.GetItemById<BaseItem>(itemId, user);
            if (item is null)
            {
                return NotFound();
            }

            var stats = _itemStats.Compute(user, item, null);
            return Ok(new { success = true, progress = stats.Progress, totalPlaybackTicks = stats.TotalPlaybackTicks, totalRuntimeTicks = stats.TotalRuntimeTicks });
        }
    }
}
