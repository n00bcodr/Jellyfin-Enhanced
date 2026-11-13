using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Auth;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Http;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.HiddenContent;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Library;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Text;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.HiddenContent
{
    [Route("JellyfinEnhanced")]
    [ApiController]
    public class JeHiddenContentController : JeControllerBase
    {
        private readonly ILibraryManager _libraryManager;
        private readonly UserDisplayResolver _userDisplayResolver;
        private readonly HiddenContentDocumentService _hiddenContentDocumentService;

        public JeHiddenContentController(
            Logger logger,
            IUserManager userManager,
            ILibraryManager libraryManager,
            UserConfigurationManager userConfigurationManager)
            : base(userManager, logger, userConfigurationManager)
        {
            _libraryManager = libraryManager;
            _userDisplayResolver = new UserDisplayResolver(userManager);
            _hiddenContentDocumentService = new HiddenContentDocumentService(userConfigurationManager, logger, _userDisplayResolver);
        }

        [HttpGet("user-settings/{userId}/hidden-content.json")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        [Produces("application/json")]
        public IActionResult GetUserHiddenContent(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            try
            {
                return Ok(_hiddenContentDocumentService.LoadUserHiddenContentDocument(authorizedUserId));
            }
            catch (Exception)
            {
                // The strict read has logged why.
                return StatusCode(500, new { success = false, message = "Hidden content could not be read. Please retry." });
            }
        }

        [HttpPost("user-settings/{userId}/hidden-content.json")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult SaveUserHiddenContent(string userId, [FromBody] UserHiddenContent userConfiguration)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            if (userConfiguration == null)
            {
                return BadRequest(new { success = false, message = "Invalid hidden content payload." });
            }

            try
            {
                lock (_userConfigurationManager.GetUserFileLock(authorizedUserId, "hidden-content.json"))
                {
                    // Pre-write strict read so a corrupt existing file 503s + backs up instead of being overwritten.
                    try
                    {
                        _userConfigurationManager.GetUserConfigurationStrict<UserHiddenContent>(
                            authorizedUserId, "hidden-content.json");
                    }
                    catch (Exception strictEx) when (strictEx is InvalidDataException
                                                  || strictEx is Newtonsoft.Json.JsonException)
                    {
                        _logger.Warning($"hidden-content.json corrupt for {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)} (backed up): {strictEx.Message}");
                        return StatusCode(503, new { success = false, message = "Hidden-content store is corrupt; backed up. Please retry." });
                    }
                    catch (IOException ioEx)
                    {
                        _logger.Warning($"hidden-content.json temporarily unreadable for {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)}: {ioEx.Message}");
                        return StatusCode(500, new { success = false, message = "Hidden-content store is temporarily unavailable. Please retry." });
                    }

                    _userConfigurationManager.SaveUserConfiguration(authorizedUserId, "hidden-content.json", userConfiguration);
                }
                HiddenContentResponseFilter.InvalidateUser(authorizedUserId);
                _logger.Info($"Saved hidden content for {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)} to hidden-content.json");
                return Ok(new { success = true, file = "hidden-content.json" });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save hidden content for {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save hidden content." });
            }
        }

        // ─── Admin cross-user hidden-content visibility ───
        // Lets an admin see what other users have hidden, surfaced as a read-only user filter on
        // the Hidden Content page/tab. Both endpoints are admin-gated server-side via IsAdminUser()
        // and never mutate another user's data — the client `isAdmin` flag is a UX convenience only,
        // never the security boundary. See js/enhanced/hiddencontent/hidden-content-page-*.js for the consuming UI.

        /// <summary>
        /// Admin-only: lists users who have hidden at least one item, together with their
        /// hidden-item count, to populate the admin user-filter dropdown on the Hidden Content page.
        /// The calling admin is excluded because their own list is shown via the default view.
        /// </summary>
        /// <remarks>
        /// Cost: O(users-with-a-config-dir) — deserialises each such user's hidden-content.json to read
        /// its item count. The client caches the result, but it re-fetches after a cache invalidation.
        /// Fine for typical user counts; revisit (cache counts / pre-filter on file size) if it grows.
        /// </remarks>
        [HttpGet("admin/hidden-content-users")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetHiddenContentUsers()
        {
            if (!IsAdminUser())
                return Forbid();

            // Honour the admin config toggle: the whole cross-user feature can be disabled.
            if (JellyfinEnhanced.Instance?.Configuration?.HiddenContentAdmin != true)
                return Forbid();

            // The caller's own list is reachable through the default "My hidden content" option,
            // so omit them here to avoid a confusing duplicate entry.
            var currentUserIdN = UserHelper.GetCurrentUserId(User)?.ToString("N");

            // Enumerate only users that already have a config directory (GetAllUserIds), rather than
            // every Jellyfin user, so a pure read here never creates empty per-user folders as a side
            // effect. Anyone with hidden content necessarily already has a directory. This mirrors the
            // reset-all-users admin endpoint.
            var users = new List<(string UserId, string UserName, int Count)>();
            foreach (var userIdN in _userConfigurationManager.GetAllUserIds())
            {
                if (string.Equals(userIdN, currentUserIdN, StringComparison.OrdinalIgnoreCase))
                    continue;

                try
                {
                    // Skip stale directories left by deleted users — only surface current accounts.
                    if (!Guid.TryParseExact(userIdN, "N", out var userGuid))
                        continue;
                    var user = _userManager.GetUserById(userGuid);
                    if (user == null)
                        continue;

                    // GetUserConfiguration returns an empty default when the file is missing or
                    // unreadable, so a user who never hid anything simply reports a count of 0.
                    var cfg = _userConfigurationManager
                        .GetUserConfiguration<UserHiddenContent>(userIdN, "hidden-content.json");
                    var count = cfg?.Items?.Count ?? 0;
                    if (count == 0)
                        continue;

                    users.Add((userIdN, user.Username, count));
                }
                catch (Exception ex)
                {
                    // Per-user guard: one unreadable config must not break the whole list.
                    _logger.Warning($"Skipping user {_userDisplayResolver.ResolveUserDisplay(userIdN)} in hidden-content-users: {ex.Message}");
                }
            }

            var result = users
                .OrderBy(u => u.UserName, StringComparer.OrdinalIgnoreCase)
                .Select(u => new { userId = u.UserId, userName = u.UserName, count = u.Count })
                .ToList();

            return Ok(new { users = result });
        }

        /// <summary>
        /// Admin-only: returns a single user's hidden content (read-only) so an admin can review
        /// what that user has hidden. Validates the id format and never writes.
        /// </summary>
        [HttpGet("admin/hidden-content/{userId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetUserHiddenContentForAdmin(string userId)
        {
            if (!IsAdminUser())
                return Forbid();

            // Honour the admin config toggle.
            if (JellyfinEnhanced.Instance?.Configuration?.HiddenContentAdmin != true)
                return Forbid();

            // Match the AdminUpsertReview contract: expect a 32-char hex (N-format) id. This also
            // guards the filesystem path independently of GetUserConfigDir()'s canonicalization.
            if (string.IsNullOrWhiteSpace(userId) || !Guid.TryParseExact(userId, "N", out var userGuid) || userGuid == Guid.Empty)
                return BadRequest(new { success = false, message = "Invalid userId (expected 32-char hex)." });

            // Resolve the user before touching the config store: this returns a clean 404 for an
            // unknown id and avoids creating an empty per-user directory as a read side effect.
            var user = _userManager.GetUserById(userGuid);
            if (user == null)
                return NotFound(new { success = false, message = "User not found." });

            try
            {
                // Read-only: GetUserConfiguration yields an empty default for a missing/corrupt
                // file, so this never throws for a valid-but-empty user.
                var config = _userConfigurationManager
                    .GetUserConfiguration<UserHiddenContent>(userId, "hidden-content.json");

                return Ok(new { userId, userName = user.Username, hiddenContent = config });
            }
            catch (Exception ex)
            {
                _logger.Warning($"Admin hidden-content read failed for {_userDisplayResolver.ResolveUserDisplay(userId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to load hidden content." });
            }
        }

        /// <summary>
        /// Admin-only: unhides one or more items from another user's hidden content
        /// (admin editing). The body is a JSON array of item keys (keys of UserHiddenContent.Items).
        /// Read-modify-write under the per-user file lock so it can't clobber a concurrent change by
        /// the user themselves. Returns how many items were actually removed.
        /// </summary>
        [HttpPost("admin/hidden-content/{userId}/unhide")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult AdminUnhideForUser(string userId, [FromBody] List<string> keys)
        {
            if (!IsAdminUser())
                return Forbid();

            // Honour the admin config toggle: cross-user management can be disabled.
            if (JellyfinEnhanced.Instance?.Configuration?.HiddenContentAdmin != true)
                return Forbid();

            if (string.IsNullOrWhiteSpace(userId) || !Guid.TryParseExact(userId, "N", out var userGuid) || userGuid == Guid.Empty)
                return BadRequest(new { success = false, message = "Invalid userId (expected 32-char hex)." });

            var user = _userManager.GetUserById(userGuid);
            if (user == null)
                return NotFound(new { success = false, message = "User not found." });

            if (keys == null || keys.Count == 0)
                return BadRequest(new { success = false, message = "No item keys provided." });

            // Canonical N-format id for every store / log call, mirroring SaveUserHiddenContent.
            var userIdN = userGuid.ToString("N");

            try
            {
                var removed = 0;
                // RMW holds the per-user file lock, strict-reads (corruption → backup + throw), applies
                // the mutation, and persists only when it reports a change (returns > 0).
                _userConfigurationManager.RmwUserConfiguration<UserHiddenContent>(userIdN, "hidden-content.json", cfg =>
                {
                    var count = 0;
                    foreach (var key in keys)
                    {
                        // Keys are dictionary lookups (never used as filesystem paths); the length cap is
                        // light defence against pathological payloads.
                        if (!string.IsNullOrEmpty(key) && key.Length <= 256 && cfg.Items.Remove(key)) count++;
                    }
                    removed = count;
                    return count;
                });

                if (removed > 0)
                    HiddenContentResponseFilter.InvalidateUser(userIdN);
                _logger.Info($"Admin unhid {removed} item(s) for {_userDisplayResolver.ResolveUserDisplay(userIdN)}.");
                return Ok(new { success = true, removed });
            }
            catch (Exception ex) when (ex is InvalidDataException || ex is Newtonsoft.Json.JsonException)
            {
                _logger.Warning($"hidden-content.json corrupt for {_userDisplayResolver.ResolveUserDisplay(userIdN)} during admin unhide (backed up): {ex.Message}");
                return StatusCode(503, new { success = false, message = "Hidden-content store is corrupt; backed up. Please retry." });
            }
            catch (IOException ioEx)
            {
                _logger.Warning($"hidden-content.json temporarily unreadable for {_userDisplayResolver.ResolveUserDisplay(userIdN)}: {ioEx.Message}");
                return StatusCode(500, new { success = false, message = "Hidden-content store is temporarily unavailable. Please retry." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Admin unhide failed for {_userDisplayResolver.ResolveUserDisplay(userIdN)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to update hidden content." });
            }
        }

        /// <summary>
        /// Admin-only: hides one or more items on behalf of another user (admin adding).
        /// The body is a list of hidden-content items (the same shape the client stores). Each is keyed
        /// by its item id (or tmdb-{id}) and RMW-merged into the user's hidden-content.json without
        /// overwriting an item the user already hid. Returns how many were newly added.
        /// </summary>
        [HttpPost("admin/hidden-content/{userId}/hide")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult AdminHideForUser(string userId, [FromBody] List<HiddenContentItem> items)
        {
            if (!IsAdminUser())
                return Forbid();

            // Adding is a management operation: gated by the admin config toggle.
            if (JellyfinEnhanced.Instance?.Configuration?.HiddenContentAdmin != true)
                return Forbid();

            if (string.IsNullOrWhiteSpace(userId) || !Guid.TryParseExact(userId, "N", out var userGuid) || userGuid == Guid.Empty)
                return BadRequest(new { success = false, message = "Invalid userId (expected 32-char hex)." });

            var user = _userManager.GetUserById(userGuid);
            if (user == null)
                return NotFound(new { success = false, message = "User not found." });

            if (items == null || items.Count == 0)
                return BadRequest(new { success = false, message = "No items provided." });
            if (items.Count > 200)
                return BadRequest(new { success = false, message = "Too many items (max 200)." });

            var userIdN = userGuid.ToString("N");

            // Trim any admin-supplied string to a sane maximum before it is written to another user's store.
            static string Clamp(string? s, int max) =>
                string.IsNullOrEmpty(s) ? string.Empty : (s.Length <= max ? s : s.Substring(0, max));

            try
            {
                var added = 0;
                _userConfigurationManager.RmwUserConfiguration<UserHiddenContent>(userIdN, "hidden-content.json", cfg =>
                {
                    var count = 0;
                    foreach (var it in items)
                    {
                        if (it == null) continue;
                        // Mirror the client's key scheme: item id, else tmdb-{id}.
                        var key = !string.IsNullOrEmpty(it.ItemId)
                            ? it.ItemId
                            : (!string.IsNullOrEmpty(it.TmdbId) ? $"tmdb-{it.TmdbId}" : null);
                        if (string.IsNullOrEmpty(key) || key.Length > 256) continue;
                        if (cfg.Items.ContainsKey(key)) continue; // never clobber the user's own hide
                        // Cross-user write path: bound the admin-supplied free-text fields and constrain
                        // HideScope to the known set, so a compromised admin token can't persist multi-MB
                        // strings or an unrecognised scope into another user's store.
                        it.Name = Clamp(it.Name, 512);
                        it.SeriesName = Clamp(it.SeriesName, 512);
                        it.PosterPath = Clamp(it.PosterPath, 512);
                        it.SeriesId = Clamp(it.SeriesId, 128);
                        it.Type = Clamp(it.Type, 64);
                        it.TmdbId = Clamp(it.TmdbId, 32);
                        it.HiddenAt = string.IsNullOrEmpty(it.HiddenAt) ? DateTime.UtcNow.ToString("o") : Clamp(it.HiddenAt, 64);
                        it.HideScope = it.HideScope is "global" or "continuewatching" or "nextup" or "homesections" ? it.HideScope : "global";
                        cfg.Items[key] = it;
                        count++;
                    }
                    added = count;
                    return count;
                });

                if (added > 0)
                    HiddenContentResponseFilter.InvalidateUser(userIdN);
                _logger.Info($"Admin hid {added} item(s) for {_userDisplayResolver.ResolveUserDisplay(userIdN)}.");
                return Ok(new { success = true, added });
            }
            catch (Exception ex) when (ex is InvalidDataException || ex is Newtonsoft.Json.JsonException)
            {
                _logger.Warning($"hidden-content.json corrupt for {_userDisplayResolver.ResolveUserDisplay(userIdN)} during admin hide (backed up): {ex.Message}");
                return StatusCode(503, new { success = false, message = "Hidden-content store is corrupt; backed up. Please retry." });
            }
            catch (IOException ioEx)
            {
                _logger.Warning($"hidden-content.json temporarily unreadable for {_userDisplayResolver.ResolveUserDisplay(userIdN)}: {ioEx.Message}");
                return StatusCode(500, new { success = false, message = "Hidden-content store is temporarily unavailable. Please retry." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Admin hide failed for {_userDisplayResolver.ResolveUserDisplay(userIdN)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to update hidden content." });
            }
        }
        // ─── Remove from Continue Watching ─── HideScope=continuewatching in hidden-content.json; surfaced via HC's management page.

        // Picks the WIDER of two HC scopes; disjoint rank-2 scopes (continuewatching ⊕ nextup) compose to homesections.
        private static string? WiderScope(string? a, string? b)
        {
            if (string.IsNullOrEmpty(a)) return b;
            if (string.IsNullOrEmpty(b)) return a;
            var ra = ScopeRank(a);
            var rb = ScopeRank(b);
            if (ra == 2 && rb == 2 && !string.Equals(a, b, StringComparison.OrdinalIgnoreCase)) return "homesections";
            return ra >= rb ? a : b;
        }

        private static int ScopeRank(string scope)
        {
            if (string.Equals(scope, "global", StringComparison.OrdinalIgnoreCase)) return 4;
            if (string.Equals(scope, "homesections", StringComparison.OrdinalIgnoreCase)) return 3;
            if (string.Equals(scope, "nextup", StringComparison.OrdinalIgnoreCase)
                || string.Equals(scope, "continuewatching", StringComparison.OrdinalIgnoreCase)) return 2;
            return 1; // unknown / future
        }

        private static string? EarliestHiddenAt(string? a, string? b)
        {
            DateTime? da = IsoDates.TryParseIso(a);
            DateTime? db = IsoDates.TryParseIso(b);
            if (da == null) return b ?? a;
            if (db == null) return a;
            return da <= db ? a : b;
        }

        // Widens an existing HC scope to also cover a new targetScope (continuewatching|nextup)
        // hide without ever narrowing the user's earlier intent. Mirrors the client-side
        // mergeCwScope in js/enhanced/hiddencontent/hidden-content-data.js: global/homesections stay; same scope stays; the
        // other home surface (or any unknown value) composes up to homesections.
        private static string MergeHomeScope(string existing, string targetScope)
        {
            if (string.IsNullOrEmpty(existing)) return targetScope;
            if (string.Equals(existing, "global", StringComparison.OrdinalIgnoreCase)) return "global";
            if (string.Equals(existing, "homesections", StringComparison.OrdinalIgnoreCase)) return "homesections";
            if (string.Equals(existing, targetScope, StringComparison.OrdinalIgnoreCase)) return targetScope;
            return "homesections";
        }

        [HttpPost("continue-watching/hide/{itemId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult HideFromContinueWatching(string itemId) => HideFromHomeSurface(itemId, "continuewatching");

        [HttpPost("next-up/hide/{itemId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult HideFromNextUp(string itemId) => HideFromHomeSurface(itemId, "nextup");

        // Shared implementation for "Remove from Continue Watching" / "Remove from Next Up".
        // Records a scoped HC entry (HideScope=continuewatching|nextup) under a server-side
        // read-modify-write so a concurrent hide can't clobber it. An existing entry's scope
        // is widened — never narrowed — via MergeHomeScope (e.g. continuewatching ⊕ nextup → homesections).
        private IActionResult HideFromHomeSurface(string itemId, string targetScope)
        {
            var userId = UserHelper.GetCurrentUserId(User) ?? Guid.Empty;
            if (userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(itemId, out var itemGuid) && !Guid.TryParseExact(itemId, "N", out itemGuid))
            {
                return BadRequest(new { success = false, message = "Invalid itemId." });
            }

            var user = _userManager.GetUserById(userId);
            if (user == null) return Forbid();

            var jfItem = _libraryManager.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(itemGuid, user);
            if (jfItem == null)
            {
                return NotFound(new { success = false, message = "Item not found or not accessible." });
            }

            string? seriesId = null;
            string? seriesName = null;
            int? seasonNumber = null;
            int? episodeNumber = null;
            string typeName = jfItem.GetType().Name;

            if (jfItem is MediaBrowser.Controller.Entities.TV.Episode ep)
            {
                seriesId = ep.SeriesId == Guid.Empty ? null : ep.SeriesId.ToString();
                seriesName = ep.SeriesName;
                seasonNumber = ep.ParentIndexNumber;
                episodeNumber = ep.IndexNumber;
            }

            var entry = new HiddenContentItem
            {
                ItemId = itemGuid.ToString(),
                Name = jfItem.Name ?? string.Empty,
                Type = typeName,
                TmdbId = string.Empty,
                HiddenAt = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
                PosterPath = string.Empty,
                SeriesId = seriesId ?? string.Empty,
                SeriesName = seriesName ?? string.Empty,
                SeasonNumber = seasonNumber,
                EpisodeNumber = episodeNumber,
                HideScope = targetScope
            };

            var key = entry.ItemId;
            var authorizedUserId = userId.ToString("N");

            try
            {
                var keyN = itemGuid.ToString("N");
                // Seed Settings from admin defaults if this RMW creates the file (Remove-from-CW before any HC UI was opened).
                var preExistedHc = _userConfigurationManager.UserConfigurationExists(authorizedUserId, "hidden-content.json");
                var hcDefaults = JellyfinEnhanced.Instance?.Configuration;

                _userConfigurationManager.RmwUserConfiguration<UserHiddenContent>(
                    authorizedUserId, "hidden-content.json", h =>
                    {
                        if (!preExistedHc && hcDefaults != null && h.Items.Count == 0)
                        {
                            h.Settings = HiddenContentDefaults.BuildHcDefaultSettings(hcDefaults);
                            // The user just performed a hide via the Remove feature, so filtering
                            // must be active for it to take effect — even if the admin's HC default
                            // is disabled. (Existing files keep whatever the user chose.)
                            h.Settings.Enabled = true;
                        }

                        // Merge with existing entries (under either hyphenated or N-format key) — pick the wider scope.
                        h.Items.TryGetValue(key, out var hyphenEntry);
                        h.Items.TryGetValue(keyN, out var nEntry);

                        var existingScope = WiderScope(
                            hyphenEntry?.HideScope,
                            nEntry?.HideScope);

                        if (!string.IsNullOrEmpty(existingScope))
                        {
                            entry.HideScope = MergeHomeScope(existingScope, targetScope);
                        }

                        // Preserve the earliest HiddenAt across both entries so re-affirming doesn't reset history.
                        var existingHiddenAt = EarliestHiddenAt(
                            hyphenEntry?.HiddenAt,
                            nEntry?.HiddenAt);
                        if (!string.IsNullOrEmpty(existingHiddenAt))
                        {
                            entry.HiddenAt = existingHiddenAt;
                        }

                        h.Items.Remove(keyN);
                        h.Items[key] = entry;
                        return 1;
                    });
                HiddenContentResponseFilter.InvalidateUser(authorizedUserId);
                return Ok(new { success = true, key, entry });
            }
            catch (Exception ex) when (ex is InvalidDataException || ex is Newtonsoft.Json.JsonException)
            {
                return StatusCode(503, new { success = false, message = "Hidden-content store is corrupt; backed up. Please retry." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to add {targetScope} hide for user {userId}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to hide item." });
            }
        }

        [HttpDelete("continue-watching/hide/{itemId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult UnhideFromContinueWatching(string itemId) => UnhideFromHomeSurface(itemId, "continuewatching");

        [HttpDelete("next-up/hide/{itemId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult UnhideFromNextUp(string itemId) => UnhideFromHomeSurface(itemId, "nextup");

        // Drops the scoped HC entry for {itemId} whose HideScope exactly matches targetScope
        // (mirror of the scoped POST). Wider composite scopes (e.g. homesections) are left
        // intact — narrowing them is handled by the Hidden Content management page.
        private IActionResult UnhideFromHomeSurface(string itemId, string targetScope)
        {
            var userId = UserHelper.GetCurrentUserId(User) ?? Guid.Empty;
            if (userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(itemId, out var itemGuid) && !Guid.TryParseExact(itemId, "N", out itemGuid))
            {
                return BadRequest(new { success = false, message = "Invalid itemId." });
            }

            var authorizedUserId = userId.ToString("N");
            var canonical = itemGuid.ToString();
            var canonicalN = itemGuid.ToString("N");

            try
            {
                var dropped = _userConfigurationManager.RmwUserConfiguration<UserHiddenContent>(
                    authorizedUserId, "hidden-content.json", h =>
                {
                    if (h?.Items == null || h.Items.Count == 0) return 0;
                    var dropKeys = new List<string>();
                    foreach (var kvp in h.Items)
                    {
                        var entry = kvp.Value;
                        if (entry == null) continue;
                        if (!string.Equals(entry.HideScope, targetScope, StringComparison.OrdinalIgnoreCase))
                            continue;
                        var entryId = entry.ItemId ?? string.Empty;
                        if (string.Equals(entryId, canonical, StringComparison.OrdinalIgnoreCase)
                            || string.Equals(entryId, canonicalN, StringComparison.OrdinalIgnoreCase))
                        {
                            dropKeys.Add(kvp.Key);
                        }
                    }
                    foreach (var k in dropKeys) h.Items.Remove(k);
                    return dropKeys.Count;
                });

                if (dropped == 0) return NotFound(new { success = false, message = "No matching hidden-content entry." });
                HiddenContentResponseFilter.InvalidateUser(authorizedUserId);
                return Ok(new { success = true });
            }
            catch (Exception ex) when (ex is InvalidDataException || ex is Newtonsoft.Json.JsonException)
            {
                return StatusCode(503, new { success = false, message = "Hidden-content store is corrupt; backed up. Please retry." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to remove {targetScope} hide for user {userId}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to unhide." });
            }
        }
    }
}
