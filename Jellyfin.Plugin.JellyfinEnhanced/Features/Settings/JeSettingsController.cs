using System.Reflection;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Http;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.HiddenContent;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Library;
using Jellyfin.Plugin.JellyfinEnhanced.Transport;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PublicApi;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Settings
{
    [Route("JellyfinEnhanced")]
    [ApiController]
    public class JeSettingsController : JeControllerBase
    {
        private readonly UserDisplayResolver _userDisplayResolver;

        public JeSettingsController(
            Logger logger,
            IUserManager userManager,
            UserConfigurationManager userConfigurationManager)
            : base(userManager, logger, userConfigurationManager)
        {
            _userDisplayResolver = new UserDisplayResolver(userManager);
        }

        [HttpGet("user-settings/{userId}/settings.json")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        public IActionResult GetUserSettingsSettings(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            return Ok(LoadUserSettingsDocument(authorizedUserId));
        }

        /// <summary>
        /// Loads (seeding defaults on first access) the user's settings.json document
        /// with the caller's IsAdmin flag applied. Shared by the settings.json
        /// endpoint and /bootstrap so both return exactly the same shape.
        /// </summary>
        private object LoadUserSettingsDocument(string authorizedUserId)
        {
            return LoadRevisionedSettings(authorizedUserId).Settings;
        }

        [HttpGet("user-settings/{userId}/settings-document")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        public IActionResult GetRevisionedSettings(string userId)
        {
            var denied = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (denied != null) return denied;
            try { return TransportJson.Create(LoadRevisionedSettings(authorizedUserId)); }
            catch (Exception ex) when (ex is System.IO.IOException || ex is System.IO.InvalidDataException || ex is Newtonsoft.Json.JsonException || ex is System.Text.Json.JsonException)
            { return StatusCode(500, new { message = "Settings could not be read. The stored document has been preserved." }); }
        }

        [HttpPost("user-settings/{userId}/settings-document")]
        [Authorize]
        public IActionResult SaveRevisionedSettings(string userId, [FromBody] RevisionedSettingsRequest request)
        {
            var denied = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (denied != null) return denied;
            if (request == null || string.IsNullOrEmpty(request.Revision) || request.Settings == null)
                return BadRequest(new { message = "Settings and their loaded revision are required." });
            if (!MediaTagsPortable.TryNormalizeUser(request.Settings, out var invalid))
                return BadRequest(new { message = invalid });
            try
            {
                var service = new Shared.Settings.SettingsDocumentService(_userConfigurationManager);
                if (!service.TrySave(authorizedUserId, request, IsAdminUser(), out var result))
                    return Conflict(new { message = "Settings changed in another tab or on the server. Reload before saving again." });
                MediaTagsApi.TagCache.OnLogoSettingsChanged();
                MediaTagsApi.TagCache.OnRatingSourceSettingsChanged();
                return TransportJson.Create(new SettingsSaveReceipt { Revision = result!.Revision });
            }
            catch (Exception ex) when (ex is System.IO.IOException || ex is System.IO.InvalidDataException || ex is Newtonsoft.Json.JsonException || ex is System.Text.Json.JsonException)
            { return StatusCode(500, new { message = "Settings could not be saved. The stored document has been preserved." }); }
        }

        [HttpGet("user-settings/{userId}/shortcuts.json")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        public IActionResult GetUserSettingsShortcuts(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            // The client saves the whole list: an unreadable one is reported, never answered as empty. A read error
            // leaves the file as it is; content that does not parse is moved aside, so the next read gets the defaults.
            try
            {
                return Ok(_userConfigurationManager.GetUserConfigurationStrict<UserShortcuts>(authorizedUserId, "shortcuts.json"));
            }
            catch (Exception)
            {
                // The strict read has logged why.
                return StatusCode(500, new { success = false, message = "Shortcuts could not be read. Please retry." });
            }
        }

        [HttpPost("user-settings/{userId}/settings.json")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult SaveUserSettingsSettings(string userId, [FromBody] JellyfinEnhancedUserSettings userConfiguration)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            if (userConfiguration == null)
            {
                return BadRequest(new { success = false, message = "Missing settings document." });
            }

            // The same normalisation a settings import is checked with (MediaTagsPortable.PreviewUser).
            if (!MediaTagsPortable.TryNormalizeUser(userConfiguration, out var invalid))
            {
                return BadRequest(new { success = false, message = invalid });
            }

            try
            {
                // Diff against the existing config so the log shows what actually changed
                // (GetUserConfiguration returns a default document when none is stored, never null).
                var existing = _userConfigurationManager.GetUserConfiguration<JellyfinEnhancedUserSettings>(authorizedUserId, "settings.json");
                var changes = new System.Collections.Generic.List<string>();
                var isIdentical = false;
                {
                    var existingJson = System.Text.Json.JsonSerializer.Serialize(existing);
                    var newJson      = System.Text.Json.JsonSerializer.Serialize(userConfiguration);
                    isIdentical = existingJson == newJson;
                    if (!isIdentical)
                    {
                        var existingDoc = System.Text.Json.JsonDocument.Parse(existingJson).RootElement;
                        var newDoc      = System.Text.Json.JsonDocument.Parse(newJson).RootElement;
                        foreach (var prop in newDoc.EnumerateObject())
                        {
                            if (!existingDoc.TryGetProperty(prop.Name, out var oldVal) ||
                                oldVal.ToString() != prop.Value.ToString())
                            {
                                changes.Add($"{prop.Name}: {(existingDoc.TryGetProperty(prop.Name, out var ov) ? ov.ToString() : "—")} → {prop.Value}");
                            }
                        }
                    }
                }

                if (!isIdentical)
                {
                    _userConfigurationManager.SaveUserConfiguration(authorizedUserId, "settings.json", userConfiguration);
                    // Turning the Logos group on (or the last user off) changes whether cache entries carry logos.
                    if (existing.LogoTagsEnabled != userConfiguration.LogoTagsEnabled)
                        MediaTagsApi.TagCache.OnLogoSettingsChanged();
                    // The first user naming an MDBList source starts enrichment at once (and the last stops it).
                    if (existing.RatingTagsEnabled != userConfiguration.RatingTagsEnabled
                        || !(existing.RatingTagsSources ?? Array.Empty<string>()).SequenceEqual(userConfiguration.RatingTagsSources ?? Array.Empty<string>()))
                        MediaTagsApi.TagCache.OnRatingSourceSettingsChanged();

                    if (changes.Count > 0)
                        _logger.Info($"Saved user settings for {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)}: {string.Join(", ", changes)}");
                }

                return Ok(new { success = true, file = "settings.json" });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save user settings for user {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save user settings." });
            }
        }

        [HttpPost("user-settings/{userId}/shortcuts.json")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult SaveUserSettingsShortcuts(string userId, [FromBody] UserShortcuts userConfiguration)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            try
            {
                _userConfigurationManager.SaveUserConfiguration(authorizedUserId, "shortcuts.json", userConfiguration);
                _logger.Info($"Saved user shortcuts for {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)} to shortcuts.json");
                return Ok(new { success = true, file = "shortcuts.json" });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save user shortcuts for {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save user shortcuts." });
            }
        }

        [HttpPost("reset-all-users-settings")]
        [Authorize]
        public IActionResult ResetAllUsersSettings()
        {
            if (!IsAdminUser())
            {
                return Forbid();
            }

            var defaultConfig = JellyfinEnhanced.Instance?.Configuration;

            if (defaultConfig == null)
            {
                return StatusCode(500, new { success = false, message = "Default plugin configuration not found." });
            }

            var defaultUserSettings = new JellyfinEnhancedUserSettings
            {
                AutoPauseEnabled = defaultConfig.AutoPauseEnabled,
                AutoResumeEnabled = defaultConfig.AutoResumeEnabled,
                AutoPipEnabled = defaultConfig.AutoPipEnabled,
                LongPress2xEnabled = defaultConfig.LongPress2xEnabled,
                PauseScreenEnabled = defaultConfig.PauseScreenEnabled,
                PauseScreenDelaySeconds = defaultConfig.PauseScreenDelaySeconds,
                AutoSkipIntro = defaultConfig.AutoSkipIntro,
                AutoSkipOutro = defaultConfig.AutoSkipOutro,
                DisableCustomSubtitleStyles = defaultConfig.DisableCustomSubtitleStyles,
                SelectedStylePresetIndex = defaultConfig.DefaultSubtitleStyle,
                SelectedFontSizePresetIndex = defaultConfig.DefaultSubtitleSize,
                SelectedFontFamilyPresetIndex = defaultConfig.DefaultSubtitleFont,
                SelectedTextEffectPresetIndex = defaultConfig.DefaultSubtitleTextEffect,
                RandomButtonEnabled = defaultConfig.RandomButtonEnabled,
                RandomUnwatchedOnly = defaultConfig.RandomUnwatchedOnly,
                RandomIncludeMovies = defaultConfig.RandomIncludeMovies,
                RandomIncludeShows = defaultConfig.RandomIncludeShows,
                RandomScopeCurrentContainer = defaultConfig.RandomScopeCurrentContainer,
                ShowWatchProgress = defaultConfig.ShowWatchProgress,
                ShowFileSizes = defaultConfig.ShowFileSizes,
                ShowAudioLanguages = defaultConfig.ShowAudioLanguages,
                UseNativePosterTags = null, // Back to not chosen: on while the administrator allows native poster tags.
                QualityTagsEnabled = defaultConfig.QualityTagsEnabled,
                ShowResolutionTag = defaultConfig.ShowResolutionTag,
                ShowSourceTag = defaultConfig.ShowSourceTag,
                // Source and edition defaults.
                ShowEditionTag = defaultConfig.ShowEditionTag,
                ShowRuntimeTag = defaultConfig.ShowRuntimeTag,
                ShowVersionsTag = defaultConfig.ShowVersionsTag,
                ShowAspectRatioTag = defaultConfig.ShowAspectRatioTag,
                ShowFrameRateTag = defaultConfig.ShowFrameRateTag,
                EditionTagOrder = defaultConfig.EditionTagOrder,
                RuntimeTagOrder = defaultConfig.RuntimeTagOrder,
                VersionsTagOrder = defaultConfig.VersionsTagOrder,
                AspectRatioTagOrder = defaultConfig.AspectRatioTagOrder,
                FrameRateTagOrder = defaultConfig.FrameRateTagOrder,
                ShowLowQualitySourceTag = defaultConfig.ShowLowQualitySourceTag,
                ShowDynamicRangeTag = defaultConfig.ShowDynamicRangeTag,
                ShowSpecialFormatTag = defaultConfig.ShowSpecialFormatTag,
                ShowVideoCodecTag = defaultConfig.ShowVideoCodecTag,
                ShowAudioInfoTag = defaultConfig.ShowAudioInfoTag,
                ResolutionTagOrder = defaultConfig.ResolutionTagOrder,
                SourceTagOrder = defaultConfig.SourceTagOrder,
                DynamicRangeTagOrder = defaultConfig.DynamicRangeTagOrder,
                SpecialFormatTagOrder = defaultConfig.SpecialFormatTagOrder,
                VideoCodecTagOrder = defaultConfig.VideoCodecTagOrder,
                AudioInfoTagOrder = defaultConfig.AudioInfoTagOrder,
                GenreTagsEnabled = defaultConfig.GenreTagsEnabled,
                LanguageTagsEnabled = defaultConfig.LanguageTagsEnabled,
                RatingTagsEnabled = defaultConfig.RatingTagsEnabled,
                AgeRatingTagsEnabled = defaultConfig.AgeRatingTagsEnabled,
                LogoTagsEnabled = defaultConfig.LogoTagsEnabled,
                StatusTagsEnabled = defaultConfig.StatusTagsEnabled,
                        AwardsTagsEnabled = defaultConfig.AwardsTagsEnabled,
                        AwardsTagsPosition = defaultConfig.AwardsTagsPosition,
                CustomTagsEnabled = defaultConfig.CustomTagsEnabled,
                PeopleTagsEnabled = defaultConfig.PeopleTagsEnabled,
                TagsHideOnHover = defaultConfig.TagsHideOnHover,
                QualityTagsPosition = defaultConfig.QualityTagsPosition,
                // Series/season quality aggregation default.
                SeriesQualityAggregation = Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.SeriesQualityAggregation.Normalize(defaultConfig.SeriesQualityAggregation),
                QualityHideSdr = defaultConfig.QualityHideSdr,
                QualityMinimumResolution = QualityDisplayRules.Minimum(defaultConfig.QualityMinimumResolution),
                QualityHdrDisplayMode = QualityDisplayRules.Mode(defaultConfig.QualityHdrDisplayMode),
                QualityVideoCodecDisplayMode = QualityDisplayRules.Mode(defaultConfig.QualityVideoCodecDisplayMode),
                QualityAudioDisplayMode = QualityDisplayRules.Mode(defaultConfig.QualityAudioDisplayMode),
                GenreTagsPosition = defaultConfig.GenreTagsPosition,
                LanguageTagsPosition = defaultConfig.LanguageTagsPosition,
                RatingTagsPosition = defaultConfig.RatingTagsPosition,
                RatingTagsOnMovies = true, // follows the administrator (TagLayoutRules.RatingScope)
                RatingTagsOnSeries = true, // follows the administrator (TagLayoutRules.RatingScope)
                RatingTagsOnSeasons = true, // follows the administrator (TagLayoutRules.RatingScope)
                RatingTagsOnEpisodes = true, // follows the administrator (TagLayoutRules.RatingScope)
                RatingTagsOnContinueWatching = true, // follows the administrator (TagLayoutRules.RatingScope)
                RatingTagsOnNextUp = true, // follows the administrator (TagLayoutRules.RatingScope)
                RatingTagsShowCommunity = defaultConfig.RatingTagsShowCommunity,
                RatingTagsShowCritic = defaultConfig.RatingTagsShowCritic,
                // Multi-source rating defaults (copy the ordered array).
                RatingTagsSources = RatingSourceSettings.Defaults(defaultConfig).ToArray(),
                RatingTagsMinScore = RatingSourceSettings.NormalizeMinimum(defaultConfig.RatingTagsMinScore),
                RatingTagsColorByScore = defaultConfig.RatingTagsColorByScore,
                AgeRatingTagsPosition = defaultConfig.AgeRatingTagsPosition,
                LogoTagsPosition = defaultConfig.LogoTagsPosition,
                StatusTagsPosition = defaultConfig.StatusTagsPosition,
                CustomTagsPosition = defaultConfig.CustomTagsPosition,
                StatusTagsJustAdded = defaultConfig.StatusTagsJustAdded,
                StatusTagsNewRelease = defaultConfig.StatusTagsNewRelease,
                StatusTagsTrending = defaultConfig.StatusTagsTrending,
                // Tag Styles preset: null follows the admin's preset.
                TagStylePreset = null,
                StatusTagsSchedule = defaultConfig.StatusTagsSchedule,
                StatusTagsMilestones = defaultConfig.StatusTagsMilestones,
                StatusTagsSeriesStatus = defaultConfig.StatusTagsSeriesStatus,
                StatusTagsScenes = defaultConfig.StatusTagsScenes,
                StatusTagsLeaving = defaultConfig.StatusTagsLeaving,
                StatusTagsDirectPlay = defaultConfig.StatusTagsDirectPlay,
                ShowRatingInPlayer = defaultConfig.ShowRatingInPlayer,
                RemoveContinueWatchingEnabled = defaultConfig.RemoveContinueWatchingEnabled,
                ReviewsExpandedByDefault = defaultConfig.ReviewsExpandedByDefault,
                DisplayLanguage = defaultConfig.DefaultLanguage,
                CalendarDisplayMode = "list",
                CalendarDefaultViewMode = "agenda",
                LastOpenedTab = "shortcuts"
            };
            TagLayoutRules.ApplyDefaults(defaultUserSettings, defaultConfig);
            TagLookValidation.ApplyDefaults(defaultUserSettings, defaultConfig);
            LanguageTagDisplay.ApplyDefaults(defaultUserSettings, defaultConfig);
            TagShapeRules.ApplyDefaults(defaultUserSettings, defaultConfig);

            var userCount = 0;
            var skippedSettings = new System.Collections.Generic.List<string>();
            var skippedHc = new System.Collections.Generic.List<string>();
            // Get all user IDs from the UserConfigurationManager's known users
            var userIds = _userConfigurationManager.GetAllUserIds();
            foreach (var userId in userIds)
            {
                try
                {
                    _userConfigurationManager.SaveUserConfiguration(userId, "settings.json", defaultUserSettings);
                    userCount++;
                }
                catch (Exception ex)
                {
                    _logger.Warning($"Skipping settings.json reset for {_userDisplayResolver.ResolveUserDisplay(userId)}: {ex.Message}");
                    skippedSettings.Add(userId);
                }

                // Push HC Settings only — user's Items dict is data, not a default. Per-user errors are skipped, not fatal.
                try
                {
                    _userConfigurationManager.RmwUserConfiguration<UserHiddenContent>(
                        userId, "hidden-content.json", hc =>
                        {
                            hc.Settings = HiddenContentDefaults.BuildHcDefaultSettings(defaultConfig);
                            return 1;
                        });
                    HiddenContentResponseFilter.InvalidateUser(userId);
                }
                catch (Exception ex) when (ex is InvalidDataException
                                        || ex is Newtonsoft.Json.JsonException
                                        || ex is IOException
                                        || ex is UnauthorizedAccessException)
                {
                    _logger.Warning($"Skipping HC settings reset for {_userDisplayResolver.ResolveUserDisplay(userId)}: {ex.Message}");
                    skippedHc.Add(userId);
                }

                // Spoiler Guard: reset only the settings-like override Prefs to
                // "inherit admin policy". The Series/Movies/Collections/PendingTmdb lists
                // are user DATA (like HC Items) and are deliberately preserved. Only touch
                // existing files — creating spoilerblur.json here would seed empty state everywhere.
                try
                {
                    if (_userConfigurationManager.UserConfigurationExists(
                            userId, Jellyfin.Plugin.JellyfinEnhanced.Features.SpoilerGuard.Services.SpoilerBlurImageFilter.SpoilerBlurFileName))
                    {
                        _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                            userId, Jellyfin.Plugin.JellyfinEnhanced.Features.SpoilerGuard.Services.SpoilerBlurImageFilter.SpoilerBlurFileName, sb =>
                            {
                                sb.Prefs = new SpoilerBlurUserPrefs();
                                return 1;
                            });
                    }
                }
                catch (Exception ex) when (ex is InvalidDataException
                                        || ex is Newtonsoft.Json.JsonException
                                        || ex is IOException
                                        || ex is UnauthorizedAccessException)
                {
                    _logger.Warning($"Skipping Spoiler Guard prefs reset for {_userDisplayResolver.ResolveUserDisplay(userId)}: {ex.Message}");
                }
            }

            // Every user took the admin's Logos switch and rating sources: re-check who shows them.
            MediaTagsApi.TagCache.OnLogoSettingsChanged();
            MediaTagsApi.TagCache.OnRatingSourceSettingsChanged();
            _logger.Info($"Reset settings for {userCount}/{userIds.Count()} users to plugin defaults. Skipped settings: {skippedSettings.Count}, skipped HC: {skippedHc.Count}.");
            return Ok(new
            {
                success = true,
                userCount,
                totalUsers = userIds.Count(),
                skippedSettingsUserIds = skippedSettings,
                skippedHcUserIds = skippedHc,
            });
        }

        /// <summary>Body of <see cref="ApplyUserSettings"/>: plugin configuration property names to push to every user.</summary>
        public class ApplyUserSettingsRequest
        {
            public List<string> Properties { get; set; } = new();
        }

        // Plugin setting name -> the differently named property on the user's settings, where the two are not identical.
        private static readonly Dictionary<string, string> UserSettingAliases = new(StringComparer.Ordinal)
        {
            ["DefaultSubtitleStyle"] = "SelectedStylePresetIndex",
            ["DefaultSubtitleSize"] = "SelectedFontSizePresetIndex",
            ["DefaultSubtitleFont"] = "SelectedFontFamilyPresetIndex",
            ["DefaultSubtitleTextEffect"] = "SelectedTextEffectPresetIndex",
            ["DefaultLanguage"] = "DisplayLanguage",
        };

        /// <summary>
        /// Copies only the named plugin settings into each user's existing personal settings, leaving every other personal
        /// preference alone (unlike reset-all-users-settings, which replaces the whole file). Users with no saved settings are
        /// skipped: they already follow the plugin defaults. Names that have no per-user counterpart, and Media Tags settings
        /// (<see cref="MediaTagsPageFields"/>, applied from the Media Tags tab), are returned as unsupported.
        /// </summary>
        [HttpPost("apply-user-settings")]
        [Authorize]
        public IActionResult ApplyUserSettings([FromBody] ApplyUserSettingsRequest request)
        {
            if (!IsAdminUser())
            {
                return Forbid();
            }

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
            {
                return StatusCode(500, new { success = false, message = "Plugin configuration not found." });
            }

            var requested = (request?.Properties ?? new List<string>()).Where(p => !string.IsNullOrWhiteSpace(p)).Distinct(StringComparer.Ordinal).ToList();
            if (requested.Count == 0)
            {
                return BadRequest(new { success = false, message = "No settings given." });
            }

            const string hcPrefix = "HiddenContentDefault";
            var cfgProps = typeof(PluginConfiguration).GetProperties().ToDictionary(p => p.Name, StringComparer.Ordinal);
            var userProps = typeof(JellyfinEnhancedUserSettings).GetProperties().Where(p => p.CanWrite).ToDictionary(p => p.Name, StringComparer.Ordinal);
            var hcProps = typeof(HiddenContentSettings).GetProperties().Where(p => p.CanWrite).ToDictionary(p => p.Name, StringComparer.Ordinal);

            static bool SameType(PropertyInfo a, PropertyInfo b) =>
                (Nullable.GetUnderlyingType(a.PropertyType) ?? a.PropertyType) == (Nullable.GetUnderlyingType(b.PropertyType) ?? b.PropertyType);

            var settingsMap = new List<(PropertyInfo From, PropertyInfo To)>();
            var hcMap = new List<(PropertyInfo From, PropertyInfo To)>();
            var unsupported = new List<string>();
            foreach (var name in requested)
            {
                // Media Tags settings are owned by the Media Tags tab, which applies them to users through
                // reset-all-users-settings (normalized there); this page never sends them, so refuse them here too.
                if (!cfgProps.TryGetValue(name, out var from) || MediaTagsPageFields.Allowed.Contains(name))
                {
                    unsupported.Add(name);
                    continue;
                }

                if (name.StartsWith(hcPrefix, StringComparison.Ordinal) && hcProps.TryGetValue(name.Substring(hcPrefix.Length), out var hcTo) && SameType(from, hcTo))
                {
                    hcMap.Add((from, hcTo));
                    continue;
                }

                var userName = UserSettingAliases.TryGetValue(name, out var alias) ? alias : name;
                if (userProps.TryGetValue(userName, out var to) && SameType(from, to))
                {
                    settingsMap.Add((from, to));
                }
                else
                {
                    unsupported.Add(name);
                }
            }

            var updated = 0;
            var skipped = new List<string>();
            foreach (var userId in _userConfigurationManager.GetAllUserIds())
            {
                try
                {
                    var touched = false;
                    if (settingsMap.Count > 0 && _userConfigurationManager.UserConfigurationExists(userId, "settings.json"))
                    {
                        _userConfigurationManager.RmwUserConfiguration<JellyfinEnhancedUserSettings>(userId, "settings.json", s =>
                        {
                            foreach (var (from, to) in settingsMap)
                            {
                                to.SetValue(s, from.GetValue(config));
                            }

                            return 1;
                        });
                        touched = true;
                    }

                    if (hcMap.Count > 0 && _userConfigurationManager.UserConfigurationExists(userId, "hidden-content.json"))
                    {
                        _userConfigurationManager.RmwUserConfiguration<UserHiddenContent>(userId, "hidden-content.json", hc =>
                        {
                            hc.Settings ??= new HiddenContentSettings();
                            foreach (var (from, to) in hcMap)
                            {
                                to.SetValue(hc.Settings, from.GetValue(config));
                            }

                            return 1;
                        });
                        HiddenContentResponseFilter.InvalidateUser(userId);
                        touched = true;
                    }

                    if (touched)
                    {
                        updated++;
                    }
                }
                catch (Exception ex) when (ex is InvalidDataException
                                        || ex is Newtonsoft.Json.JsonException
                                        || ex is IOException
                                        || ex is UnauthorizedAccessException)
                {
                    _logger.Warning($"Skipping selected settings apply for {_userDisplayResolver.ResolveUserDisplay(userId)}: {ex.Message}");
                    skipped.Add(userId);
                }
            }

            _logger.Info($"Applied {settingsMap.Count + hcMap.Count} setting(s) to {updated} user(s). Unsupported: {unsupported.Count}, skipped users: {skipped.Count}");
            return Ok(new
            {
                success = true,
                userCount = updated,
                applied = settingsMap.Count + hcMap.Count,
                unsupported,
                skippedUserIds = skipped,
            });
        }
    }
}
