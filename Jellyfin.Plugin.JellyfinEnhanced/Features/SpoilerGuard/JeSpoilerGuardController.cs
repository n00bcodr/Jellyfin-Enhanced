using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Auth;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Http;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Library;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.SpoilerGuard
{
    [Route("JellyfinEnhanced")]
    [ApiController]
    public class JeSpoilerGuardController : JeControllerBase
    {
        private readonly ILibraryManager _libraryManager;
        private readonly SpoilerUserResolver _spoilerResolver;
        private readonly Services.SpoilerExistingTitlesApplier _spoilerExistingApplier;
        private readonly MediaBrowser.Model.Tasks.ITaskManager _taskManager;
        private readonly UserDisplayResolver _userDisplayResolver;
        private readonly LibraryItemLookup _libraryItemLookup;
        private readonly SpoilerPendingService _spoilerPendingService;

        public JeSpoilerGuardController(
            Logger logger,
            IUserManager userManager,
            ILibraryManager libraryManager,
            UserConfigurationManager userConfigurationManager,
            SpoilerUserResolver spoilerResolver,
            Services.SpoilerExistingTitlesApplier spoilerExistingApplier,
            MediaBrowser.Model.Tasks.ITaskManager taskManager)
            : base(userManager, logger, userConfigurationManager)
        {
            _libraryManager = libraryManager;
            _spoilerResolver = spoilerResolver;
            _spoilerExistingApplier = spoilerExistingApplier;
            _taskManager = taskManager;
            _userDisplayResolver = new UserDisplayResolver(userManager);
            _libraryItemLookup = new LibraryItemLookup(libraryManager, logger);
            _spoilerPendingService = new SpoilerPendingService(userConfigurationManager, logger, _userDisplayResolver, _libraryItemLookup);
        }

        // Self-or-admin accessor pair for spoilerblur.json, mirroring the other
        // per-user files — otherwise it would be the only per-user JE file an
        // administrator cannot inspect or repair remotely.
        [HttpGet("user-settings/{userId}/spoilerblur.json")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        [Produces("application/json")]
        public IActionResult GetUserSpoilerBlur(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            // Lenient read on purpose: this is an inspection surface, so a corrupt
            // file should still return the (empty) default rather than 503 — the
            // user-facing spoiler-blur endpoints already handle strict reads,
            // backups and corruption reporting.
            var state = _userConfigurationManager.GetUserConfiguration<UserSpoilerBlur>(
                authorizedUserId, Services.SpoilerBlurImageFilter.SpoilerBlurFileName);
            // Never name a title the file's owner may not see, as GET spoiler-blur/series does not.
            return Ok(SpoilerTitleVisibility.WithoutHiddenTitles(_libraryManager, () => _userManager.GetUserById(Guid.ParseExact(authorizedUserId, "N")), state));
        }

        // Hard cap per spoiler-list dict on the raw full-state save endpoint:
        // the image/field-strip filters iterate this file every request
        // (IsMovieInSpoilerScope does a library lookup per Collections key), so
        // an unbounded payload amplifies into millions of GetItemById calls per
        // library view. Mirrors the pending path's MaxPendingTmdbPerUser cap
        // this endpoint would otherwise bypass.
        private const int MaxSpoilerEntriesPerDict = 1000;

        [HttpPost("user-settings/{userId}/spoilerblur.json")]
        [Authorize]
        [Produces("application/json")]
        [Consumes("application/json")]
        // Cap the body: 4×1000 entries is a few hundred KB even with long names.
        // 2 MB leaves headroom while removing Kestrel's ~28 MB default as a DoS lever.
        [RequestSizeLimit(2 * 1024 * 1024)]
        public IActionResult SaveUserSpoilerBlur(string userId, [FromBody] UserSpoilerBlur userConfiguration)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            if (userConfiguration == null)
            {
                return BadRequest(new { success = false, message = "Invalid Spoiler Guard payload." });
            }

            // Reject oversized payloads rather than silently truncating — dropping
            // entries would confuse a legitimate large list, and over-cap is buggy or hostile.
            if (userConfiguration.Series.Count > MaxSpoilerEntriesPerDict
                || userConfiguration.Movies.Count > MaxSpoilerEntriesPerDict
                || userConfiguration.Collections.Count > MaxSpoilerEntriesPerDict
                || userConfiguration.PendingTmdb.Count > MaxSpoilerEntriesPerDict)
            {
                _logger.Warning($"Rejecting oversized Spoiler Guard payload for {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)} (series={userConfiguration.Series.Count}, movies={userConfiguration.Movies.Count}, collections={userConfiguration.Collections.Count}, pending={userConfiguration.PendingTmdb.Count}; cap {MaxSpoilerEntriesPerDict}).");
                return StatusCode(413, new { success = false, message = $"Spoiler Guard list exceeds the maximum of {MaxSpoilerEntriesPerDict} entries per category." });
            }

            var fileName = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;
            // Snapshot pre-write pending keys to diff the promoter gate after save:
            // this endpoint is a pending writer too and must keep the gate in sync.
            HashSet<string> priorPending;
            try
            {
                var prior = _userConfigurationManager.GetUserConfiguration<UserSpoilerBlur>(authorizedUserId, fileName);
                priorPending = new HashSet<string>(prior.PendingTmdb.Keys, StringComparer.OrdinalIgnoreCase);
            }
            catch
            {
                priorPending = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            }

            try
            {
                lock (_userConfigurationManager.GetUserFileLock(authorizedUserId, fileName))
                {
                    // Pre-write strict read so a corrupt existing file 503s + backs up
                    // instead of being silently overwritten (same as hidden-content).
                    try
                    {
                        _userConfigurationManager.GetUserConfigurationStrict<UserSpoilerBlur>(
                            authorizedUserId, fileName);
                    }
                    catch (Exception strictEx) when (strictEx is InvalidDataException
                                                  || strictEx is Newtonsoft.Json.JsonException)
                    {
                        _logger.Warning($"{fileName} corrupt for {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)} (backed up): {strictEx.Message}");
                        return StatusCode(503, new { success = false, message = "Spoiler Guard store is corrupt; backed up. Please retry." });
                    }
                    catch (IOException ioEx)
                    {
                        _logger.Warning($"{fileName} temporarily unreadable for {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)}: {ioEx.Message}");
                        return StatusCode(500, new { success = false, message = "Spoiler Guard store is temporarily unavailable. Please retry." });
                    }

                    _userConfigurationManager.SaveUserConfiguration(authorizedUserId, fileName, userConfiguration);
                }

                // Reconcile the promoter's fast-path gate with the new PendingTmdb
                // set: register keys the payload added, unregister keys it removed.
                // Registration is idempotent, so re-registering survivors is harmless.
                if (Guid.TryParseExact(authorizedUserId, "N", out var gateUserId))
                {
                    foreach (var key in userConfiguration.PendingTmdb.Keys)
                    {
                        Shared.SpoilerGuard.SpoilerSeerrPendingPromoter.RegisterPending(key, gateUserId);
                    }
                    foreach (var stale in priorPending)
                    {
                        if (!userConfiguration.PendingTmdb.ContainsKey(stale))
                        {
                            Shared.SpoilerGuard.SpoilerSeerrPendingPromoter.UnregisterPending(stale, gateUserId);
                        }
                    }
                }

                _logger.Info($"Saved Spoiler Guard state for {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)} to {fileName}");
                return Ok(new { success = true, file = fileName });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save Spoiler Guard state for {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save Spoiler Guard state." });
            }
        }

        // ─── Spoiler Guard ─── Per-user list of series IDs the user has opted
        // into Spoiler Guard for. The image filter (Services/SpoilerBlurImageFilter.cs)
        // reads spoilerblur.json on every image request and blurs every UNWATCHED
        // episode of any series in that list. Watched episodes pass through unblurred.

        // Returns a snapshot of any spoilerblur.json corruption events
        // that have been logged this process-lifetime. Diagnostic endpoint:
        // there is no UI consumer yet — it exists so an admin (or a user,
        // for their own events) can check whether Spoiler Guard preferences
        // were reset after a corrupt-file backup, without shell access.
        // Per-user — each user only sees their OWN corruption events.
        // Admins see all users (so they can advise affected users).
        [HttpGet("spoiler-blur/health")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetSpoilerBlurHealth()
        {
            // Role-first admin check so Administrator API keys (role claim,
            // no user id) work — same pattern as IsAdminUser() everywhere else.
            var isAdmin = IsAdminUser();
            var userId = UserHelper.GetCurrentUserId(User);
            if (!isAdmin && (userId == null || userId == Guid.Empty)) return Forbid();
            var userKey = userId.HasValue && userId.Value != Guid.Empty
                ? userId.Value.ToString("N")
                : null; // admin API key: no user identity, sees all events

            var log = Shared.SpoilerGuard.SpoilerUserResolver.GetCorruptionLog();
            var events = new List<object>();
            foreach (var kvp in log)
            {
                if (!isAdmin && kvp.Key != userKey) continue; // non-admin: only own
                events.Add(new
                {
                    userId = kvp.Key,
                    userDisplay = kvp.Value.UserDisplay,
                    at = kvp.Value.At.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
                    reason = kvp.Value.Reason,
                });
            }
            return Ok(new
            {
                healthy = events.Count == 0,
                corruptionEvents = events,
            });
        }

        // Admin acks any corruption event (clears the banner); users ack their own.
        [HttpDelete("spoiler-blur/health/{targetUserId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult AckSpoilerBlurCorruption(string targetUserId)
        {
            // Role-first admin check: Administrator API keys can ack any user's
            // events; non-admins need a user identity and ack only their own.
            var isAdmin = IsAdminUser();
            var userId = UserHelper.GetCurrentUserId(User);
            if (!isAdmin && (userId == null || userId == Guid.Empty)) return Forbid();
            var userKey = userId.HasValue && userId.Value != Guid.Empty
                ? userId.Value.ToString("N")
                : null;

            if (!Guid.TryParse(targetUserId, out var tGuid)
                && !Guid.TryParseExact(targetUserId, "N", out tGuid))
            {
                return BadRequest(new { success = false, message = "Invalid userId." });
            }
            var tKey = tGuid.ToString("N");
            if (!isAdmin && tKey != userKey) return Forbid();
            Shared.SpoilerGuard.SpoilerUserResolver.ClearCorruption(tKey);
            return Ok(new { success = true });
        }

        // ─── Spoiler Guard: apply auto-enable scope to existing titles ───
        // Admin-only. Library-add auto-enable never re-arms on rescans (so a
        // user's opt-out sticks); these routes back the config page's explicit
        // "Apply to existing titles now" action instead. Preview is a dry run
        // with the SAVED scope; start hands the options to the scheduled task
        // (so progress/cancel also show in Dashboard > Scheduled Tasks).

        private MediaBrowser.Model.Tasks.IScheduledTaskWorker? GetSpoilerApplyExistingWorker()
        {
            return _taskManager.ScheduledTasks.FirstOrDefault(w => w.ScheduledTask is ScheduledTasks.SpoilerApplyExistingTitlesTask);
        }

        [HttpGet("spoiler-blur/apply-existing/preview")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult PreviewSpoilerApplyExisting([FromQuery] bool skipStarted = false)
        {
            if (!IsAdminUser()) return Forbid();
            if (JellyfinEnhanced.Instance?.Configuration?.SpoilerBlurEnabled != true)
            {
                return Conflict(new { success = false, message = "Spoiler Guard is disabled." });
            }
            var worker = GetSpoilerApplyExistingWorker();
            if (worker != null && worker.State != MediaBrowser.Model.Tasks.TaskState.Idle)
            {
                return Conflict(new { success = false, message = "A run is already in progress." });
            }
            try
            {
                var summary = _spoilerExistingApplier.Preview(new Services.SpoilerExistingTitlesApplier.Options { SkipStarted = skipStarted }, HttpContext.RequestAborted);
                if (summary.Error != null) return StatusCode(500, new { success = false, message = summary.Error });
                return Ok(summary);
            }
            catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested)
            {
                return StatusCode(499); // browser went away
            }
        }

        [HttpPost("spoiler-blur/apply-existing")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult StartSpoilerApplyExisting([FromQuery] bool skipStarted = false)
        {
            if (!IsAdminUser()) return Forbid();
            if (JellyfinEnhanced.Instance?.Configuration?.SpoilerBlurEnabled != true)
            {
                return Conflict(new { success = false, message = "Spoiler Guard is disabled." });
            }
            var worker = GetSpoilerApplyExistingWorker();
            if (worker == null) return StatusCode(503, new { success = false, message = "The scheduled task is not registered." });
            if (worker.State != MediaBrowser.Model.Tasks.TaskState.Idle)
            {
                return Conflict(new { success = false, message = "A run is already in progress." });
            }
            var completedRuns = _spoilerExistingApplier.CompletedRuns;
            var options = new Services.SpoilerExistingTitlesApplier.Options { SkipStarted = skipStarted };
            _spoilerExistingApplier.SetPendingOptions(options);
            // If a dashboard start wins the race between the state check and
            // here, the worker rejects this start inside its own Task: drop
            // these options then so a later dashboard run keeps the defaults
            // (they also expire after a minute as a backstop).
            var start = _taskManager.Execute(worker, new MediaBrowser.Model.Tasks.TaskOptions());
            start.ContinueWith(
                _ => _spoilerExistingApplier.ClearPendingOptions(options),
                CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted,
                TaskScheduler.Default);
            _logger.Info($"SpoilerApplyExisting: run started from the config page by {_userDisplayResolver.ResolveUserDisplay(UserHelper.GetCurrentUserId(User)?.ToString("N") ?? string.Empty)} (skip started: {skipStarted})");
            return Accepted(new { success = true, taskId = worker.Id, completedRuns });
        }

        [HttpGet("spoiler-blur/apply-existing/status")]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetSpoilerApplyExistingStatus()
        {
            if (!IsAdminUser()) return Forbid();
            var worker = GetSpoilerApplyExistingWorker();
            return Ok(new
            {
                taskId = worker?.Id,
                state = worker?.State.ToString() ?? "Unavailable",
                progress = worker?.CurrentProgress,
                completedRuns = _spoilerExistingApplier.CompletedRuns,
                lastRun = _spoilerExistingApplier.LastRun,
            });
        }

        /// <summary>
        /// Whether the caller's Spoiler Guard covers a movie, directly or through a
        /// collection. Client state lists collection ids, not the movies inside them.
        /// </summary>
        /// <param name="movieId">The movie's Jellyfin id.</param>
        /// <returns><c>{inScope}</c>, for the caller's own state only.</returns>
        [HttpGet("spoiler-blur/movies/{movieId}/in-scope")]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetSpoilerMovieScope(string movieId)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();
            if (!Guid.TryParse(movieId, out var id) || id == Guid.Empty)
            {
                return BadRequest(new { success = false, message = "Invalid movie id." });
            }

            var state = _spoilerResolver.LoadUserState(HttpContext, userId.Value);
            if (!_spoilerResolver.TryGetMovieScope(state, id, out var inScope))
            {
                // Unknown isn't "out of scope": the client keeps its protection on a failure.
                return StatusCode(503, new { success = false, message = "Could not resolve Spoiler Guard scope." });
            }

            return Ok(new { inScope });
        }

        [HttpGet("spoiler-blur/series")]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetSpoilerBlurSeries()
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();
            var userKey = userId.Value.ToString("N");
            var fileName = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;

            // Distinguish "file missing" (empty + 200, normal first-time state)
            // from "corrupt/unreadable" (503 + backup-made hint). A lenient read
            // silently returns empty on parse error — the user would think their
            // spoiler list was wiped.
            if (!_userConfigurationManager.UserConfigurationExists(userKey, fileName))
            {
                return Ok(new UserSpoilerBlur());
            }
            try
            {
                var state = _userConfigurationManager.GetUserConfigurationStrict<UserSpoilerBlur>(
                    userKey, fileName);
                return Ok(SpoilerTitleVisibility.WithoutHiddenTitles(_libraryManager, () => _userManager.GetUserById(userId.Value), state));
            }
            catch (InvalidDataException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {_userDisplayResolver.ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Shared.SpoilerGuard.SpoilerUserResolver.RecordCorruption(userKey, _userDisplayResolver.ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Newtonsoft.Json.JsonException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {_userDisplayResolver.ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Shared.SpoilerGuard.SpoilerUserResolver.RecordCorruption(userKey, _userDisplayResolver.ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
        }

        // Per-user override toggles for the admin's strip categories. Nullable
        // bools where null means "inherit admin policy"; SkipDisableConfirm is a
        // permanent flag replacing the per-session "Don't ask for 15 minutes" snooze.
        [HttpGet("spoiler-blur/user-prefs")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetSpoilerBlurUserPrefs()
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();
            var userKey = userId.Value.ToString("N");
            var fileName = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;

            if (!_userConfigurationManager.UserConfigurationExists(userKey, fileName))
            {
                return Ok(new SpoilerBlurUserPrefs());
            }
            try
            {
                var state = _userConfigurationManager.GetUserConfigurationStrict<UserSpoilerBlur>(
                    userKey, fileName);
                return Ok(state.Prefs ?? new SpoilerBlurUserPrefs());
            }
            catch (InvalidDataException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {_userDisplayResolver.ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Shared.SpoilerGuard.SpoilerUserResolver.RecordCorruption(userKey, _userDisplayResolver.ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Newtonsoft.Json.JsonException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {_userDisplayResolver.ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Shared.SpoilerGuard.SpoilerUserResolver.RecordCorruption(userKey, _userDisplayResolver.ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
        }

        [HttpPost("spoiler-blur/user-prefs")]
        [Authorize]
        [Produces("application/json")]
        [Consumes("application/json")]
        [RequestSizeLimit(8 * 1024)]
        public IActionResult SetSpoilerBlurUserPrefs([FromBody] SpoilerBlurUserPrefs? body)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();
            if (body == null) return BadRequest(new { success = false, message = "Missing body." });

            var fileName = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;
            var userKey = userId.Value.ToString("N");

            try
            {
                _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, fileName, state =>
                {
                    state.Prefs = new SpoilerBlurUserPrefs
                    {
                        HideSeriesDescriptions = body.HideSeriesDescriptions,
                        HideEpisodeDescriptions = body.HideEpisodeDescriptions,
                        HideTags = body.HideTags,
                        HideChapterNames = body.HideChapterNames,
                        HideTaglines = body.HideTaglines,
                        HideRatings = body.HideRatings,
                        HideAirDate = body.HideAirDate,
                        ReplaceEpisodeTitles = body.ReplaceEpisodeTitles,
                        HideCast = body.HideCast,
                        HideReviews = body.HideReviews,
                        HideTrickplay = body.HideTrickplay,
                        UseAdvancedCategories = body.UseAdvancedCategories,
                        SkipDisableConfirm = body.SkipDisableConfirm,
                    };
                    return 1;
                });
                return Ok(new { success = true, prefs = body });
            }
            catch (InvalidDataException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {_userDisplayResolver.ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Shared.SpoilerGuard.SpoilerUserResolver.RecordCorruption(userKey, _userDisplayResolver.ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Newtonsoft.Json.JsonException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {_userDisplayResolver.ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Shared.SpoilerGuard.SpoilerUserResolver.RecordCorruption(userKey, _userDisplayResolver.ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save Spoiler Guard user prefs for {_userDisplayResolver.ResolveUserDisplay(userKey)}: {ex.GetType().Name}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save user prefs." });
            }
        }

        [HttpPost("spoiler-blur/series/{seriesId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult EnableSpoilerBlurForSeries(string seriesId)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(seriesId, out var seriesGuid)
                && !Guid.TryParseExact(seriesId, "N", out seriesGuid))
            {
                return BadRequest(new { success = false, message = "Invalid seriesId." });
            }

            // Confirm the item exists and is a series the user can access.
            // GetItemById returns null when filtered out by library access — 404
            // so we don't leak existence. Also treat any lookup throw as 404:
            // arbitrary GUIDs hitting a partially-stored row make Jellyfin's
            // deserializer throw ("Cannot deserialize unknown type").
            var jUser = _userManager.GetUserById(userId.Value);
            if (jUser == null) return Forbid();
            MediaBrowser.Controller.Entities.BaseItem? item = null;
            try
            {
                item = _libraryManager.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(seriesGuid, jUser);
            }
            catch (Exception ex)
            {
                _logger.Warning($"GetItemById<BaseItem> threw for {seriesGuid}: {ex.GetType().Name}: {ex.Message}");
            }
            if (item is not MediaBrowser.Controller.Entities.TV.Series series)
            {
                return NotFound(new { success = false, message = "Series not found or not accessible." });
            }

            var key = seriesGuid.ToString("N");
            var fileName = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;
            var userKey = userId.Value.ToString("N");

            try
            {
                // RmwUserConfiguration reads strict: it refuses corrupt JSON (backs up
                // to *.corrupt-<ts>) instead of returning empty + clobbering other opt-ins.
                _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, fileName, state =>
                {
                    // Preserve original EnabledAt on re-toggle; refresh SeriesName
                    // opportunistically (covers renames). Return 0 (no-write) when
                    // truly unchanged so we don't burn a disk write on each re-toggle.
                    if (state.Series.TryGetValue(key, out var existing))
                    {
                        var newName = series.Name ?? existing.SeriesName;
                        if (string.Equals(existing.SeriesName, newName, StringComparison.Ordinal))
                        {
                            return 0;
                        }
                        existing.SeriesName = newName;
                        return 1;
                    }
                    state.Series[key] = new SpoilerBlurSeriesEntry
                    {
                        SeriesId = key,
                        SeriesName = series.Name ?? string.Empty,
                        EnabledAt = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
                    };
                    return 1;
                });
                _logger.Info($"Spoiler Guard enabled for series '{series.Name}' ({key}) by {_userDisplayResolver.ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, seriesId = key, name = series.Name });
            }
            catch (InvalidDataException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {_userDisplayResolver.ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Shared.SpoilerGuard.SpoilerUserResolver.RecordCorruption(userKey, _userDisplayResolver.ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Newtonsoft.Json.JsonException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {_userDisplayResolver.ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Shared.SpoilerGuard.SpoilerUserResolver.RecordCorruption(userKey, _userDisplayResolver.ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to enable spoiler blur for series {key}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler blur state." });
            }
        }

        [HttpDelete("spoiler-blur/series/{seriesId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult DisableSpoilerBlurForSeries(string seriesId)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(seriesId, out var seriesGuid)
                && !Guid.TryParseExact(seriesId, "N", out seriesGuid))
            {
                return BadRequest(new { success = false, message = "Invalid seriesId." });
            }

            var key = seriesGuid.ToString("N");
            var fileName = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;
            var userKey = userId.Value.ToString("N");

            try
            {
                bool removed = false;
                _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, fileName, state =>
                {
                    removed = state.Series.Remove(key);
                    return removed ? 1 : 0;
                });
                if (!removed)
                {
                    // Log so a client/server desync (two tabs, stale cache) is
                    // observable instead of silently returning success.
                    _logger.Info($"Spoiler Guard disable was a no-op for series {key} by {_userDisplayResolver.ResolveUserDisplay(userKey)} — series was not in the user's spoiler-blur list.");
                    return Ok(new { success = true, seriesId = key, removed = false });
                }
                _logger.Info($"Spoiler Guard disabled for series {key} by {_userDisplayResolver.ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, seriesId = key, removed = true });
            }
            catch (InvalidDataException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {_userDisplayResolver.ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Shared.SpoilerGuard.SpoilerUserResolver.RecordCorruption(userKey, _userDisplayResolver.ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Newtonsoft.Json.JsonException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {_userDisplayResolver.ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Shared.SpoilerGuard.SpoilerUserResolver.RecordCorruption(userKey, _userDisplayResolver.ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to disable spoiler blur for series {key}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler blur state." });
            }
        }

        public class SpoilerBlurMovieRequest
        {
            public string? MovieName { get; set; }
        }

        // Per-movie Spoiler Guard opt-in — stored in the same spoilerblur.json
        // (UserSpoilerBlur.Movies dict). Blurs the movie's poster/backdrop and
        // field-strips its metadata until the user marks it Played.
        [HttpPost("spoiler-blur/movies/{movieId}")]
        [Authorize]
        [RequestSizeLimit(8 * 1024)]
        [Produces("application/json")]
        public IActionResult EnableSpoilerBlurForMovie(string movieId, [FromBody] SpoilerBlurMovieRequest? body = null)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(movieId, out var movieGuid)
                && !Guid.TryParseExact(movieId, "N", out movieGuid))
            {
                return BadRequest(new { success = false, message = "Invalid movieId." });
            }

            // Same protection as the Series endpoint: bogus GUID can throw
            // InvalidOperationException from Jellyfin's deserializer.
            var jUser = _userManager.GetUserById(userId.Value);
            if (jUser == null) return Forbid();
            MediaBrowser.Controller.Entities.BaseItem? item = null;
            try
            {
                item = _libraryManager.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(movieGuid, jUser);
            }
            catch (Exception ex)
            {
                _logger.Warning($"GetItemById<BaseItem> threw for {movieGuid}: {ex.GetType().Name}: {ex.Message}");
            }
            if (item is not MediaBrowser.Controller.Entities.Movies.Movie movie)
            {
                return NotFound(new { success = false, message = "Movie not found or not accessible." });
            }

            var key = movieGuid.ToString("N");
            var fileName = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;
            var userKey = userId.Value.ToString("N");

            // Sanitize provided MovieName: strip HTML tags + angle brackets, cap
            // length. Do NOT strip apostrophes/quotes/backticks — titles legitimately
            // contain them (e.g. "Don't Look Up") and stripping mangles the display
            // value. Consumers render via textContent, so the <>/HTML strip is enough
            // defense-in-depth at the storage layer.
            string movieNameSanitized = (movie.Name ?? string.Empty);
            if (body?.MovieName is string clientName && !string.IsNullOrEmpty(clientName))
            {
                var cleaned = System.Text.RegularExpressions.Regex.Replace(clientName, "<[^>]+>", string.Empty);
                cleaned = cleaned.Replace("<", string.Empty).Replace(">", string.Empty);
                if (cleaned.Length > 200) cleaned = cleaned.Substring(0, 200);
                if (!string.IsNullOrWhiteSpace(cleaned)) movieNameSanitized = cleaned;
            }

            try
            {
                _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, fileName, state =>
                {
                    if (state.Movies.TryGetValue(key, out var existing))
                    {
                        if (string.Equals(existing.MovieName, movieNameSanitized, StringComparison.Ordinal))
                        {
                            return 0;
                        }
                        existing.MovieName = movieNameSanitized;
                        return 1;
                    }
                    state.Movies[key] = new SpoilerBlurMovieEntry
                    {
                        MovieId = key,
                        MovieName = movieNameSanitized,
                        EnabledAt = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
                    };
                    return 1;
                });
                _logger.Info($"Spoiler Guard enabled for movie '{movie.Name}' ({key}) by {_userDisplayResolver.ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, movieId = key, name = movie.Name });
            }
            catch (InvalidDataException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {_userDisplayResolver.ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Shared.SpoilerGuard.SpoilerUserResolver.RecordCorruption(userKey, _userDisplayResolver.ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Newtonsoft.Json.JsonException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {_userDisplayResolver.ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Shared.SpoilerGuard.SpoilerUserResolver.RecordCorruption(userKey, _userDisplayResolver.ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to enable spoiler blur for movie {key}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler blur state." });
            }
        }

        [HttpDelete("spoiler-blur/movies/{movieId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult DisableSpoilerBlurForMovie(string movieId)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(movieId, out var movieGuid)
                && !Guid.TryParseExact(movieId, "N", out movieGuid))
            {
                return BadRequest(new { success = false, message = "Invalid movieId." });
            }

            var key = movieGuid.ToString("N");
            var fileName = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;
            var userKey = userId.Value.ToString("N");

            try
            {
                bool removed = false;
                _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, fileName, state =>
                {
                    removed = state.Movies.Remove(key);
                    return removed ? 1 : 0;
                });
                if (!removed)
                {
                    _logger.Info($"Spoiler Guard disable was a no-op for movie {key} by {_userDisplayResolver.ResolveUserDisplay(userKey)} — movie was not in the user's spoiler-blur list.");
                    return Ok(new { success = true, movieId = key, removed = false });
                }
                _logger.Info($"Spoiler Guard disabled for movie {key} by {_userDisplayResolver.ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, movieId = key, removed = true });
            }
            catch (InvalidDataException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {_userDisplayResolver.ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Shared.SpoilerGuard.SpoilerUserResolver.RecordCorruption(userKey, _userDisplayResolver.ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Newtonsoft.Json.JsonException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {_userDisplayResolver.ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Shared.SpoilerGuard.SpoilerUserResolver.RecordCorruption(userKey, _userDisplayResolver.ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to disable spoiler blur for movie {key}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler blur state." });
            }
        }

        public class SpoilerBlurCollectionRequest
        {
            public string? CollectionName { get; set; }
        }

        // Per-collection Spoiler Guard opt-in. A collection (BoxSet) is a SHORTCUT:
        // toggling here protects every movie inside (each until watched), while the
        // collection's OWN art/DTO pass through clear — it's the entry point clicked.
        [HttpPost("spoiler-blur/collections/{collectionId}")]
        [Authorize]
        [RequestSizeLimit(8 * 1024)]
        [Produces("application/json")]
        public IActionResult EnableSpoilerBlurForCollection(string collectionId, [FromBody] SpoilerBlurCollectionRequest? body = null)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(collectionId, out var collGuid)
                && !Guid.TryParseExact(collectionId, "N", out collGuid))
            {
                return BadRequest(new { success = false, message = "Invalid collectionId." });
            }

            var jUser = _userManager.GetUserById(userId.Value);
            if (jUser == null) return Forbid();
            MediaBrowser.Controller.Entities.BaseItem? item = null;
            try
            {
                item = _libraryManager.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(collGuid, jUser);
            }
            catch (Exception ex)
            {
                _logger.Warning($"GetItemById<BaseItem> threw for {collGuid}: {ex.GetType().Name}: {ex.Message}");
            }
            if (item is not MediaBrowser.Controller.Entities.Movies.BoxSet boxSet)
            {
                return NotFound(new { success = false, message = "Collection not found or not accessible." });
            }

            var key = collGuid.ToString("N");
            var fileName = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;
            var userKey = userId.Value.ToString("N");

            string collNameSanitized = (boxSet.Name ?? string.Empty);
            if (body?.CollectionName is string clientName && !string.IsNullOrEmpty(clientName))
            {
                var cleaned = System.Text.RegularExpressions.Regex.Replace(clientName, "<[^>]+>", string.Empty);
                cleaned = cleaned.Replace("<", string.Empty).Replace(">", string.Empty);
                if (cleaned.Length > 200) cleaned = cleaned.Substring(0, 200);
                if (!string.IsNullOrWhiteSpace(cleaned)) collNameSanitized = cleaned;
            }

            try
            {
                _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, fileName, state =>
                {
                    if (state.Collections.TryGetValue(key, out var existing))
                    {
                        if (string.Equals(existing.CollectionName, collNameSanitized, StringComparison.Ordinal))
                        {
                            return 0;
                        }
                        existing.CollectionName = collNameSanitized;
                        return 1;
                    }
                    state.Collections[key] = new SpoilerBlurCollectionEntry
                    {
                        CollectionId = key,
                        CollectionName = collNameSanitized,
                        EnabledAt = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
                    };
                    return 1;
                });
                _logger.Info($"Spoiler Guard enabled for collection '{boxSet.Name}' ({key}) by {_userDisplayResolver.ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, collectionId = key, name = boxSet.Name });
            }
            catch (InvalidDataException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {_userDisplayResolver.ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Shared.SpoilerGuard.SpoilerUserResolver.RecordCorruption(userKey, _userDisplayResolver.ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Newtonsoft.Json.JsonException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {_userDisplayResolver.ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Shared.SpoilerGuard.SpoilerUserResolver.RecordCorruption(userKey, _userDisplayResolver.ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to enable spoiler blur for collection {key}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler blur state." });
            }
        }

        [HttpDelete("spoiler-blur/collections/{collectionId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult DisableSpoilerBlurForCollection(string collectionId)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(collectionId, out var collGuid)
                && !Guid.TryParseExact(collectionId, "N", out collGuid))
            {
                return BadRequest(new { success = false, message = "Invalid collectionId." });
            }

            var key = collGuid.ToString("N");
            var fileName = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;
            var userKey = userId.Value.ToString("N");

            try
            {
                bool removed = false;
                _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, fileName, state =>
                {
                    removed = state.Collections.Remove(key);
                    return removed ? 1 : 0;
                });
                if (!removed)
                {
                    _logger.Info($"Spoiler Guard disable was a no-op for collection {key} by {_userDisplayResolver.ResolveUserDisplay(userKey)} — collection was not in the user's spoiler-blur list.");
                    return Ok(new { success = true, collectionId = key, removed = false });
                }
                _logger.Info($"Spoiler Guard disabled for collection {key} by {_userDisplayResolver.ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, collectionId = key, removed = true });
            }
            catch (InvalidDataException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {_userDisplayResolver.ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Shared.SpoilerGuard.SpoilerUserResolver.RecordCorruption(userKey, _userDisplayResolver.ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Newtonsoft.Json.JsonException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {_userDisplayResolver.ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Shared.SpoilerGuard.SpoilerUserResolver.RecordCorruption(userKey, _userDisplayResolver.ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to disable spoiler blur for collection {key}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler blur state." });
            }
        }

        // ─── Pre-acquisition pending Spoiler Guard (Seerr / not-yet-downloaded) ───
        // Registers Spoiler Guard intent for a TMDB id that may not yet be in the
        // library. Two sources: (a) the Seerr modal's manual "Enable spoiler" button
        // (allowed whenever SpoilerBlurEnabled, even when the Request button is
        // disabled), (b) auto on Seerr request (SpoilerAutoEnableOnSeerrRequest).
        // If the id resolves to an accessible library item we promote straight into
        // Series/Movies; otherwise we record into PendingTmdb and
        // SpoilerSeerrPendingPromoter promotes it on ItemAdded.
        [HttpPost("spoiler-blur/pending/{mediaType}/{tmdbId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult EnableSpoilerBlurPending(string mediaType, string tmdbId, [FromQuery] string? displayName = null)
        {
            var cfg = JellyfinEnhanced.Instance?.Configuration;
            if (cfg?.SpoilerBlurEnabled != true)
            {
                return StatusCode(503, new { success = false, message = "Spoiler Guard is disabled by the administrator." });
            }

            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            var normalizedType = (mediaType ?? string.Empty).ToLowerInvariant();
            if (normalizedType != "tv" && normalizedType != "movie")
            {
                return BadRequest(new { success = false, message = "mediaType must be 'tv' or 'movie'." });
            }
            // TMDB ids are positive integers; reject anything else so we don't
            // store junk keys that the promoter would never match.
            if (string.IsNullOrWhiteSpace(tmdbId)
                || !int.TryParse(tmdbId, System.Globalization.NumberStyles.Integer,
                                 System.Globalization.CultureInfo.InvariantCulture, out var tmdbInt)
                || tmdbInt <= 0)
            {
                return BadRequest(new { success = false, message = "Invalid tmdbId." });
            }
            var canonicalTmdb = tmdbInt.ToString(System.Globalization.CultureInfo.InvariantCulture);

            // Library lookup: if the TMDB id already resolves to a Series /
            // Movie the user can access, promote straight into the real
            // Series / Movies dict and skip pending. This handles the
            // "already in library" case (Seerr returns "already available"
            // or the user opens the modal for an existing title) cleanly.
            var jUser = _userManager.GetUserById(userId.Value);
            if (jUser == null) return Forbid();

            try
            {
                var summary = _spoilerPendingService.AddSpoilerBlurPendingInternal(userId.Value, jUser, normalizedType, canonicalTmdb, displayName);
                if (summary.Promoted == "cap-exceeded")
                {
                    return StatusCode(429, new
                    {
                        success = false,
                        code = "pending_cap_exceeded",
                        message = $"You already have the maximum of {SpoilerPendingService.MaxPendingTmdbPerUser} pending spoiler-blur entries. Remove some via the management UI before adding more."
                    });
                }
                return Ok(new { success = true, promoted = summary.Promoted, jellyfinId = summary.JellyfinId, name = summary.Name });
            }
            catch (InvalidDataException strictEx)
            {
                var ukey = userId.Value.ToString("N");
                _logger.Warning($"spoilerblur.json corrupt for {_userDisplayResolver.ResolveUserDisplay(ukey)} (backed up): {strictEx.Message}");
                Shared.SpoilerGuard.SpoilerUserResolver.RecordCorruption(ukey, _userDisplayResolver.ResolveUserDisplay(ukey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Newtonsoft.Json.JsonException strictEx)
            {
                var ukey = userId.Value.ToString("N");
                _logger.Warning($"spoilerblur.json corrupt for {_userDisplayResolver.ResolveUserDisplay(ukey)} (backed up): {strictEx.Message}");
                Shared.SpoilerGuard.SpoilerUserResolver.RecordCorruption(ukey, _userDisplayResolver.ResolveUserDisplay(ukey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to record spoiler-blur pending {normalizedType}:{canonicalTmdb}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler-blur pending state." });
            }
        }

        [HttpDelete("spoiler-blur/pending/{mediaType}/{tmdbId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult DisableSpoilerBlurPending(string mediaType, string tmdbId)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            var normalizedType = (mediaType ?? string.Empty).ToLowerInvariant();
            if (normalizedType != "tv" && normalizedType != "movie")
            {
                return BadRequest(new { success = false, message = "mediaType must be 'tv' or 'movie'." });
            }
            if (string.IsNullOrWhiteSpace(tmdbId)
                || !int.TryParse(tmdbId, System.Globalization.NumberStyles.Integer,
                                 System.Globalization.CultureInfo.InvariantCulture, out var tmdbInt)
                || tmdbInt <= 0)
            {
                return BadRequest(new { success = false, message = "Invalid tmdbId." });
            }
            var canonicalTmdb = tmdbInt.ToString(System.Globalization.CultureInfo.InvariantCulture);
            var pendingKey = $"{normalizedType}:{canonicalTmdb}";
            var userKey = userId.Value.ToString("N");
            var fileName = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;

            // Mirror the POST abstraction: the modal's "Disable spoiler" click needn't
            // know whether the entry is pending or in Series/Movies. Resolve TMDB ->
            // Jellyfin id and remove from whichever side holds it. Pre-compute the id
            // outside the RMW so we don't capture mutated locals into the lambda.
            var jUser = _userManager.GetUserById(userId.Value);
            try
            {
                var existingItem = jUser != null
                    ? _libraryItemLookup.FindLibraryItemByTmdb(jUser, normalizedType, canonicalTmdb)
                    : null;
                var seriesKeyToRemove = (existingItem as MediaBrowser.Controller.Entities.TV.Series)?.Id.ToString("N");
                var movieKeyToRemove = (existingItem as MediaBrowser.Controller.Entities.Movies.Movie)?.Id.ToString("N");
                var resultBox = new[] { (Removed: false, From: "none", JellyfinId: (string?)null) };
                _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, fileName, state =>
                    {
                        bool pendingRemoved = state.PendingTmdb.Remove(pendingKey);
                        bool seriesRemoved = seriesKeyToRemove != null && state.Series.Remove(seriesKeyToRemove);
                        bool movieRemoved = movieKeyToRemove != null && state.Movies.Remove(movieKeyToRemove);
                        if (seriesRemoved) resultBox[0] = (true, "series", seriesKeyToRemove);
                        else if (movieRemoved) resultBox[0] = (true, "movie", movieKeyToRemove);
                        else if (pendingRemoved) resultBox[0] = (true, "pending", null);
                        return resultBox[0].Removed ? 1 : 0;
                    });
                // Either way the key is no longer pending for this user — keep the
                // promoter's gate consistent so it stops sweeping this user.
                Shared.SpoilerGuard.SpoilerSeerrPendingPromoter.UnregisterPending(pendingKey, userId.Value);
                var (removedAnything, removedFrom, removedJellyfinId) = resultBox[0];
                if (!removedAnything)
                {
                    return Ok(new { success = true, removed = false, removedFrom = "none" });
                }
                _logger.Info($"Spoiler Guard pending DELETE removed {pendingKey} ({removedFrom}) for {_userDisplayResolver.ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, removed = true, removedFrom, jellyfinId = removedJellyfinId });
            }
            catch (InvalidDataException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {_userDisplayResolver.ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Shared.SpoilerGuard.SpoilerUserResolver.RecordCorruption(userKey, _userDisplayResolver.ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Newtonsoft.Json.JsonException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {_userDisplayResolver.ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Shared.SpoilerGuard.SpoilerUserResolver.RecordCorruption(userKey, _userDisplayResolver.ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to remove spoiler-blur pending {pendingKey}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler-blur pending state." });
            }
        }
    }
}
