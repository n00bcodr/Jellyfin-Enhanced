using Microsoft.AspNetCore.Mvc;
using System.Text.Json;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Auth;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Http;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Library;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags
{
    /// <summary>
    /// Media Tags routes (restructure S2.11, moved verbatim from JellyfinEnhancedController). The admin routes are in
    /// <c>JeMediaTagsController.Admin.cs</c>; <see cref="PreviewBody"/> serves both parts.
    /// </summary>
    [Route("JellyfinEnhanced")]
    [ApiController]
    public partial class JeMediaTagsController : JeControllerBase
    {
        private readonly IUserDataManager _userDataManager;
        private readonly ILibraryManager _libraryManager;
        private readonly TagCacheService _tagCacheService;
        private readonly Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard.SpoilerUserResolver _spoilerResolver;
        private readonly Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard.SpoilerTagDataStripper _spoilerTagDataStripper;
        private readonly MatroskaLanguageCache _matroskaLanguageCache;
        private readonly UserDisplayResolver _userDisplayResolver;

        public JeMediaTagsController(
            Logger logger,
            IUserManager userManager,
            IUserDataManager userDataManager,
            ILibraryManager libraryManager,
            UserConfigurationManager userConfigurationManager,
            TagCacheService tagCacheService,
            Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard.SpoilerUserResolver spoilerResolver,
            Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard.SpoilerTagDataStripper spoilerTagDataStripper,
            MatroskaLanguageCache matroskaLanguageCache)
            : base(userManager, logger, userConfigurationManager)
        {
            _userDataManager = userDataManager;
            _libraryManager = libraryManager;
            _tagCacheService = tagCacheService;
            _spoilerResolver = spoilerResolver;
            _spoilerTagDataStripper = spoilerTagDataStripper;
            _matroskaLanguageCache = matroskaLanguageCache;
            _userDisplayResolver = new UserDisplayResolver(userManager);
        }

        /// <summary>
        /// Effective Tag Styles for the Jellyfin Web overlays (empty unless the target includes web). <paramref name="preset"/>
        /// is the caller's own preset, honoured only while the admin lets users pick one.
        /// </summary>
        /// <param name="preset">The user's preset id, or null for the admin's.</param>
        /// <returns>The web model of <see cref="TagStyleSet.ToWebModel"/>.</returns>
        [HttpGet("tag-styles")]
        [Authorize]
        public ActionResult GetTagStyles([FromQuery] string? preset = null)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null) return StatusCode(503);
            var set = config.TagStylesEnabled && config.TagStyleTarget is "web" or "both"
                ? TagStyleSet.Parse(config.TagStyleOverrides, config.TagStylePreset).ForUser(preset, config.TagStylesAllowUserPreset)
                : TagStyleSet.Empty;
            return new JsonResult(set.ToWebModel());
        }

        /// <summary>
        /// Trending ranks for the Status Tags poster badges:
        /// <c>{ source: "tmdb-day" | "seerr-week" | null, movies: { "&lt;tmdbId&gt;": rank }, series: { ... } }</c>.
        /// Any signed-in user: the list is public TMDB data shared server-wide (see
        /// <see cref="Services.StatusTagsTrendingService"/>), and the client only uses
        /// it to decorate items the user can already see. Empty while the admin has
        /// Status Tags or their trending badge switched off.
        /// </summary>
        [HttpGet("status-tags/trending")]
        [Authorize]
        [Produces("application/json")]
        public async Task<IActionResult> GetStatusTagsTrending([FromServices] Services.StatusTagsTrendingService trendingService)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            var snapshot = Services.StatusTagsTrendingService.Empty;
            if (config != null && config.StatusTagsEnabled && config.StatusTagsTrending)
            {
                try
                {
                    snapshot = await trendingService.GetAsync(config, HttpContext.RequestAborted).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested)
                {
                    return StatusCode(499); // browser went away
                }
            }

            Response.Headers["Cache-Control"] = "private, max-age=300";
            return Ok(new { source = snapshot.Source, movies = snapshot.Movies, series = snapshot.Series });
        }

        /// <summary>
        /// TMDB schedule facts for the Status Tags series badges, for up to
        /// <see cref="Services.StatusTagsSeriesService.MaxIds"/> Series item ids
        /// (comma-separated): <c>{ "&lt;itemId&gt;": { status, lastAired: { date,
        /// season, episode, type }, nextAired: { date, season, episode } } }</c>.
        /// Ids are resolved through the caller, so a series they cannot see (or
        /// one without a TMDB id) is simply left out, as are series TMDB has no
        /// answer for. Empty while the admin has Status Tags off or no TMDB key
        /// is set. The client asks only for series cards on screen (and the
        /// series of season/episode cards).
        /// </summary>
        [HttpGet("status-tags/series")]
        [Authorize]
        [Produces("application/json")]
        public async Task<IActionResult> GetStatusTagsSeries([FromQuery] string? ids, [FromServices] Services.StatusTagsSeriesService seriesService)
        {
            var requested = (ids ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (requested.Length == 0)
            {
                return BadRequest(new { error = "ids required" });
            }

            if (requested.Length > Services.StatusTagsSeriesService.MaxIds)
            {
                return BadRequest(new { error = $"Maximum {Services.StatusTagsSeriesService.MaxIds} ids per request" });
            }

            var callerId = UserHelper.GetCurrentUserId(User);
            var user = callerId is { } id && id != Guid.Empty ? _userManager.GetUserById(id) : null;
            if (user == null)
            {
                return Forbid();
            }

            var config = JellyfinEnhanced.Instance?.Configuration;
            var payload = new Dictionary<string, object>(StringComparer.Ordinal);
            var retry = false;
            if (config != null && config.StatusTagsEnabled && !string.IsNullOrWhiteSpace(config.TMDB_API_KEY))
            {
                var tmdbIds = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (var raw in requested)
                {
                    if (!Guid.TryParse(raw, out var itemId) || itemId == Guid.Empty)
                    {
                        continue;
                    }

                    // Through the user: library access, parental rating and blocked tags apply.
                    if (_libraryManager.GetItemById<BaseItem>(itemId, user) is MediaBrowser.Controller.Entities.TV.Series series
                        && series.ProviderIds?.TryGetValue("Tmdb", out var tmdbId) == true
                        && long.TryParse(tmdbId, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var tmdbNumber)
                        && tmdbNumber > 0)
                    {
                        tmdbIds[itemId.ToString("N")] = tmdbNumber.ToString(System.Globalization.CultureInfo.InvariantCulture);
                    }
                }

                try
                {
                    var schedules = await seriesService.GetAsync(config.TMDB_API_KEY, tmdbIds, HttpContext.RequestAborted).ConfigureAwait(false);
                    foreach (var (key, schedule) in schedules)
                    {
                        if (schedule.Retry)
                        {
                            retry = true;
                            payload[key] = new { retry = true };
                            continue;
                        }
                        payload[key] = new
                        {
                            status = schedule.Status,
                            lastRegularAired = schedule.LastRegularAired == null ? null : new { date = schedule.LastRegularAired.Date, season = schedule.LastRegularAired.Season, episode = schedule.LastRegularAired.Episode, type = schedule.LastRegularAired.Type },
                            lastAired = schedule.LastAired == null ? null : new { date = schedule.LastAired.Date, season = schedule.LastAired.Season, episode = schedule.LastAired.Episode, type = schedule.LastAired.Type },
                            nextAired = schedule.NextAired == null ? null : new { date = schedule.NextAired.Date, season = schedule.NextAired.Season, episode = schedule.NextAired.Episode },
                            seasonEpisodes = schedule.SeasonEpisodes,
                        };
                    }
                }
                catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested)
                {
                    return StatusCode(499); // browser went away
                }
            }

            Response.Headers["Cache-Control"] = retry ? "private, no-store" : "private, max-age=600";
            return Ok(payload);
        }

        /// <summary>
        /// Returns the audio-language tag names (base and regional) for the given stream language codes.
        /// </summary>
        [HttpGet("audio-language-tags")]
        [Authorize]
        public ActionResult GetAudioLanguageTags([FromQuery] string codes)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.AudioLanguageTagSyncEnabled)
            {
                return Ok(new Dictionary<string, object>());
            }

            var prefix = string.IsNullOrWhiteSpace(config.AudioLanguageTagPrefix)
                ? "JE Language: "
                : config.AudioLanguageTagPrefix;
            var localization = Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions
                .GetRequiredService<MediaBrowser.Model.Globalization.ILocalizationManager>(HttpContext.RequestServices);

            var result = new Dictionary<string, object>();
            foreach (var code in (codes ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Take(50))
            {
                if (code.Length > 16 || result.ContainsKey(code)) continue;
                var (baseName, variantName) = AudioLanguageTagHelper.GetTagNames(code, localization);
                result[code] = new
                {
                    baseTag = prefix + baseName,
                    variantTag = variantName == null ? null : prefix + variantName
                };
            }

            return Ok(result);
        }

        /// <summary>
        /// A TMDB provider, network or company logo for the Logos tag group,
        /// from the server's disk cache (fetched from TMDB's image server once).
        /// <paramref name="size"/> is w45 or w92; <paramref name="file"/> a logo
        /// file name the server has seen in a provider or details lookup, so this
        /// is not an open TMDB image proxy and the browser never contacts TMDB.
        /// Anonymous like the CDN assets: &lt;img&gt; cannot carry a Jellyfin token,
        /// and these are public logos. 404 when not allowed or unavailable.
        /// </summary>
        [HttpGet("logo/{size}/{file}")]
        public async Task<IActionResult> GetLogoImage(string size, string file, [FromServices] Services.TagLogoService logos, CancellationToken cancellationToken)
        {
            if (!logos.IsAllowed(size, file)) return NotFound();
            var image = await logos.GetImageAsync(size, file, cancellationToken).ConfigureAwait(false);
            if (image == null) return NotFound();
            Response.Headers["Cache-Control"] = "public, max-age=604800";
            Response.Headers["ETag"] = image.ETag;
            Response.Headers["X-Content-Type-Options"] = "nosniff";
            if (Jellyfin.Plugin.JellyfinEnhanced.Shared.Tmdb.TmdbResponseCache.IfNoneMatchMatches(Request.Headers["If-None-Match"], image.ETag))
            {
                return StatusCode(StatusCodes.Status304NotModified);
            }

            return File(image.Bytes, image.ContentType);
        }

        /// <summary>
        /// The user's Media Tags settings as a portable document (<see cref="MediaTagsPortable.ExportUser"/>):
        /// <c>{"v":1,"kind":"je-media-tags-user","settings":{…}}</c>, the fields of <see cref="MediaTagsPortable.UserFields"/>.
        /// </summary>
        /// <param name="userId">The user (the caller, or any user for an administrator).</param>
        /// <returns>The document.</returns>
        [HttpGet("user-settings/{userId}/media-tags/export")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        [Produces("application/json")]
        public IActionResult ExportUserMediaTags(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null) return authorizationResult;
            var settings = _userConfigurationManager.GetUserConfiguration<JellyfinEnhancedUserSettings>(authorizedUserId, "settings.json");
            return Ok(MediaTagsPortable.ExportUser(settings));
        }

        /// <summary>
        /// What importing a Media Tags document (a user export or a preset) would change, checked field by field with
        /// the settings save path's validators (<see cref="MediaTagsPortable.PreviewUser"/>). Nothing is saved: the
        /// client applies the changed fields through <c>POST user-settings/{userId}/settings.json</c>.
        /// </summary>
        /// <param name="userId">The user.</param>
        /// <param name="document">The document.</param>
        /// <returns>200 <c>{kind, v, name, description, imported, changes, skipped}</c>; 400 <c>{error}</c> for a document refused as a whole.</returns>
        [HttpPost("user-settings/{userId}/media-tags/preview")]
        [Authorize]
        [RequestSizeLimit(MediaTagsPortable.MaxDocumentBytes)]
        [Produces("application/json")]
        public IActionResult PreviewUserMediaTags(string userId, [FromBody] JsonElement document)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null) return authorizationResult;
            var current = _userConfigurationManager.GetUserConfiguration<JellyfinEnhancedUserSettings>(authorizedUserId, "settings.json");
            var preview = MediaTagsPortable.PreviewUser(document, current);
            return preview.Error != null ? BadRequest(new { error = preview.Error }) : Ok(PreviewBody(preview));
        }

        /// <summary>
        /// The presets a user can apply: the built-in ones, those the administrator offers and the user's own
        /// (<see cref="MediaTagsPortable.UserPresetsFile"/>, at most <see cref="MediaTagsPortable.MaxUserPresets"/>).
        /// </summary>
        /// <param name="userId">The user.</param>
        /// <returns><c>{max, builtIn, offered, mine}</c>, each a list of preset documents.</returns>
        [HttpGet("user-settings/{userId}/media-tags/presets")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        [Produces("application/json")]
        public IActionResult GetMediaTagsPresets(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null) return authorizationResult;
            var store = _userConfigurationManager.GetUserConfiguration<MediaTagsPortable.UserPresetStore>(authorizedUserId, MediaTagsPortable.UserPresetsFile);
            return Ok(new
            {
                max = MediaTagsPortable.MaxUserPresets,
                builtIn = MediaTagsPortable.BuiltInPresets,
                offered = MediaTagsPortable.OfferedPresets(JellyfinEnhanced.Instance?.Configuration ?? new PluginConfiguration()),
                mine = (store.Presets ?? new List<MediaTagsPortable.StoredPreset>()).Select(MediaTagsPortable.ToDocument),
            });
        }

        /// <summary>
        /// Saves a preset to the user's own list: a preset document, or a user export with a <c>name</c>. Unknown and
        /// invalid settings are dropped and reported; the preset gets a new id.
        /// </summary>
        /// <param name="userId">The user.</param>
        /// <param name="document">The preset.</param>
        /// <returns>200 <c>{preset, skipped}</c>; 400 <c>{error}</c> (a document error, <c>name</c>, <c>description</c>, <c>empty</c>, or <c>full</c> with <c>max</c>).</returns>
        [HttpPost("user-settings/{userId}/media-tags/presets")]
        [Authorize]
        [RequestSizeLimit(MediaTagsPortable.MaxDocumentBytes)]
        [Produces("application/json")]
        public IActionResult SaveMediaTagsPreset(string userId, [FromBody] JsonElement document)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null) return authorizationResult;
            if (!MediaTagsPortable.TryReadPreset(document, null, out var preset, out var skipped, out var error))
            {
                return BadRequest(new { error });
            }

            var stored = new MediaTagsPortable.StoredPreset
            {
                Id = Guid.NewGuid().ToString("N")[..12],
                Name = (string?)preset["name"] ?? string.Empty,
                Description = (string?)preset["description"] ?? string.Empty,
                Settings = preset["settings"]!.ToJsonString(),
            };
            var full = false;
            try
            {
                _userConfigurationManager.RmwUserConfiguration<MediaTagsPortable.UserPresetStore>(authorizedUserId, MediaTagsPortable.UserPresetsFile, store =>
                {
                    store.Presets ??= new List<MediaTagsPortable.StoredPreset>();
                    if (store.Presets.Count >= MediaTagsPortable.MaxUserPresets)
                    {
                        full = true;
                        return 0;
                    }

                    store.Presets.Add(stored);
                    return 1;
                });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save a Media Tags preset for {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { error = "save" });
            }

            if (full) return BadRequest(new { error = "full", max = MediaTagsPortable.MaxUserPresets });
            return Ok(new { preset = MediaTagsPortable.ToDocument(stored), skipped = SkipBody(skipped) });
        }

        /// <summary>Deletes one of the user's own presets.</summary>
        /// <param name="userId">The user.</param>
        /// <param name="presetId">The preset's id.</param>
        /// <returns>200, or 404 when the user has no such preset.</returns>
        [HttpDelete("user-settings/{userId}/media-tags/presets/{presetId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult DeleteMediaTagsPreset(string userId, string presetId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null) return authorizationResult;
            int removed;
            try
            {
                removed = _userConfigurationManager.RmwUserConfiguration<MediaTagsPortable.UserPresetStore>(authorizedUserId, MediaTagsPortable.UserPresetsFile, store =>
                    store.Presets?.RemoveAll(p => string.Equals(p.Id, presetId, StringComparison.Ordinal)) ?? 0);
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to delete a Media Tags preset for {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { error = "save" });
            }

            return removed > 0 ? Ok(new { success = true }) : NotFound(new { error = "missing" });
        }

        /// <summary>An import preview as the endpoints answer it.</summary>
        private static object PreviewBody(MediaTagsPortable.Preview preview) => new
        {
            kind = preview.Kind,
            v = preview.V,
            name = preview.Name,
            description = preview.Description,
            imported = preview.Imported,
            changes = preview.Changes.Select(c => new { field = c.Field, from = c.From, to = c.To }),
            skipped = SkipBody(preview.Skipped),
        };

        /// <summary>Skipped fields as the endpoints answer them.</summary>
        private static object SkipBody(IEnumerable<MediaTagsPortable.Skip> skipped)
            => skipped.Select(s => new { field = s.Field, reason = s.Reason, detail = s.Detail }).ToList();

        /// <summary>
        /// Admin-only support/testing view of Native Poster Tags: the tags <paramref name="userId"/> (default: the
        /// caller) would get on an item's poster in a native client, drawn with that user's settings and Spoiler
        /// Guard–stripped tag data. The artwork underneath is the unblurred original: Spoiler Guard's image
        /// blur / stock-card substitution is NOT applied here (native clients of a guarded item get it), which
        /// the X-JE-Poster-Tags-Artwork: original header states. Renders even when the user or the master switch
        /// has the feature off; the X-JE-Poster-Tags-* headers report that state. Never cached.
        /// </summary>
        /// <param name="itemId">Item whose Primary image to draw on.</param>
        /// <param name="userId">User whose settings, library access and Spoiler Guard state apply.</param>
        /// <param name="width">Maximum image width in pixels (default 360, 32–2048).</param>
        /// <param name="height">Optional maximum image height in pixels (32–2048).</param>
        /// <param name="topRightOffset">Force the played/unplayed indicator offset; default as native clients get it (played, or unplayed items left).</param>
        [HttpGet("native-poster-tags/preview/{itemId}")]
        [Authorize]
        public async Task<IActionResult> PreviewNativePosterTags(
            Guid itemId,
            [FromQuery] Guid? userId,
            [FromQuery] int? width,
            [FromQuery] int? height,
            [FromQuery] bool? topRightOffset,
            [FromServices] PosterTags.PosterTagComposer composer,
            [FromServices] PosterTags.PosterTagSettingsProvider posterTagSettings,
            [FromServices] MediaBrowser.Controller.Drawing.IImageProcessor imageProcessor)
        {
            if (!IsAdminUser()) return Forbid();

            var targetUserId = userId is { } requested && requested != Guid.Empty
                ? requested
                : UserHelper.GetCurrentUserId(User) ?? Guid.Empty;
            var user = targetUserId == Guid.Empty ? null : _userManager.GetUserById(targetUserId);
            if (user == null) return NotFound(new { message = "User not found." });

            // The target user's library access and parental rating apply.
            var item = _libraryManager.GetItemById<BaseItem>(itemId, user);
            if (item == null) return NotFound(new { message = "Item not found or not visible to this user." });
            if (!Services.TagCacheService.TaggableTypes.Contains(item.GetBaseItemKind()))
                return BadRequest(new { message = "Native poster tags only apply to movies, series, seasons, episodes, collections and videos." });

            var imageInfo = item.GetImageInfo(ImageType.Primary, 0);
            if (imageInfo == null) return NotFound(new { message = "Item has no Primary image." });
            if (!imageInfo.IsLocalFile) return BadRequest(new { message = "Item's Primary image is not stored locally yet." });

            try
            {
                var (path, _, _) = await imageProcessor.ProcessImage(new MediaBrowser.Controller.Drawing.ImageProcessingOptions
                {
                    Item = item,
                    ItemId = item.Id,
                    Image = imageInfo,
                    ImageIndex = 0,
                    MaxWidth = Math.Clamp(width ?? 360, 32, 2048),
                    MaxHeight = height.HasValue ? Math.Clamp(height.Value, 32, 2048) : null,
                    Quality = 90,
                    SupportedOutputFormats = new[] { MediaBrowser.Model.Drawing.ImageFormat.Jpg },
                }).ConfigureAwait(false);

                // The item's own look (a lock, a server-wide item look, a matching rule), as native clients get it.
                var previewSeriesId = item switch
                {
                    MediaBrowser.Controller.Entities.TV.Episode episode => episode.SeriesId,
                    MediaBrowser.Controller.Entities.TV.Season season => season.SeriesId,
                    _ => Guid.Empty,
                };
                var previewSeriesIdN = previewSeriesId == Guid.Empty ? null : previewSeriesId.ToString("N");
                Shared.MediaTags.PosterTags.PosterTagLookFacts? LookFacts() => _tagCacheService.TryGetEntry(item.Id, out var lookEntry)
                    ? Shared.MediaTags.PosterTags.PosterTagLookFacts.FromEntry(lookEntry)
                    : Shared.MediaTags.PosterTags.PosterTagLookFacts.FromItem(_libraryManager, item);
                var userPosterSettings = posterTagSettings.Get(user.Id);
                var settings = userPosterSettings.ForItem(item.Id, previewSeriesIdN, LookFacts);
                var lookSource = userPosterSettings.ResolveLook(item.Id.ToString("N"), previewSeriesIdN, LookFacts).Source;
                // Same rule the stamper applies to the card's own indicator
                // (NativePosterTagStamper.StampItem): played check or unplayed count.
                var offset = topRightOffset ?? (_userDataManager.GetUserDataDto(item, user) is { } userData
                    && (userData.Played || userData.UnplayedItemCount > 0));
                var original = await System.IO.File.ReadAllBytesAsync(path, HttpContext.RequestAborted).ConfigureAwait(false);
                var result = await composer.ComposeAsync(
                    HttpContext,
                    item,
                    user,
                    settings,
                    offset,
                    new PosterTags.PosterTagBaseImage("image/jpeg", "preview", () => Task.FromResult(original)),
                    90,
                    useCache: false,
                    HttpContext.RequestAborted).ConfigureAwait(false);

                Response.Headers["Cache-Control"] = "no-store";
                Response.Headers["X-JE-Poster-Tags-Status"] = result.Status.ToString().ToLowerInvariant();
                Response.Headers["X-JE-Poster-Tags-Artwork"] = "original";
                Response.Headers["X-JE-Poster-Tags-Master-Enabled"] = (JellyfinEnhanced.Instance?.Configuration?.NativePosterTagsEnabled == true) ? "true" : "false";
                Response.Headers["X-JE-Poster-Tags-User-Enabled"] = settings.NativeEnabled ? "true" : "false";
                Response.Headers["X-JE-Poster-Tags-Any-Group"] = settings.AnyGroupEnabled ? "true" : "false";
                Response.Headers["X-JE-Poster-Tags-Settings-Digest"] = settings.Digest;
                Response.Headers["X-JE-Poster-Tags-Look"] = lookSource;
                Response.Headers["X-JE-Poster-Tags-Spoiler-Stripped"] = result.SpoilerStripped ? "true" : "false";
                return File(result.Bytes ?? original, "image/jpeg");
            }
            catch (Exception ex) when (!HttpContext.RequestAborted.IsCancellationRequested)
            {
                _logger.Warning($"Native poster tags preview failed for {itemId}: {ex.Message}");
                return StatusCode(500, new { message = "Preview failed: " + ex.Message });
            }
        }
    }
}
