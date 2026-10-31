using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags
{
    /// <summary>
    /// The effective poster tag settings of one user: every value the card tag groups read,
    /// resolved exactly as the web resolves them.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The web's view of a user's settings is <c>GET user-settings/{id}/settings.json</c>: the file
    /// deserialized into <see cref="JellyfinEnhancedUserSettings"/> (Newtonsoft, case-insensitive keys, JSON nulls
    /// ignored, any error yields defaults) and serialized back, so every non-nullable property is
    /// always present (C# initializer value when the file lacks it). A missing file is first written
    /// from the plugin defaults. <c>JE.loadSettings</c> then takes the user value when it is not
    /// null, else the plugin value of the same (PascalCase) key or its alias, else the hard-coded JS
    /// default. In practice only the nullable <c>*TagOrder</c> keys ever fall through to the plugin
    /// defaults; a null <c>UseNativePosterTags</c> falls through to the hard-coded default (on).
    /// </para>
    /// <para>
    /// Instances are immutable and safe to share across threads. The settings provider is expected
    /// to cache one per user and rebuild it when the user's settings.json or the plugin
    /// configuration changes.
    /// </para>
    /// </remarks>
    public sealed record PosterTagSettings
    {
        /// <summary>
        /// Version of the resolution rules, part of <see cref="Digest"/>. Bump it when a change to
        /// the resolver changes the tags produced for the same settings and data.
        /// </summary>
        public const string ResolverVersion = "8";

        private static readonly JsonSerializerSettings LenientRead = new() { NullValueHandling = NullValueHandling.Ignore };

        private PosterTagSettings()
        {
        }

        /// <summary>Master switch and the user's preference: <c>NativePosterTagsEnabled &amp;&amp; useNativePosterTags != false</c>.</summary>
        public bool NativeEnabled { get; private init; }

        /// <summary>The user's effective <c>useNativePosterTags</c> (on unless the user switched it off).</summary>
        public bool UseNativePosterTags { get; private init; }

        /// <summary>True when at least one of the card tag groups is on and not set to "off" in the active native layout.</summary>
        public bool AnyGroupEnabled => Shows(PosterTagGroup.Quality) || Shows(PosterTagGroup.Genre) || Shows(PosterTagGroup.Language)
            || Shows(PosterTagGroup.Rating) || Shows(PosterTagGroup.AgeRating) || Shows(PosterTagGroup.Awards)
            || Shows(PosterTagGroup.Status) || Shows(PosterTagGroup.Logos) || Shows(PosterTagGroup.Custom);

        private string _digest = string.Empty;

        /// <summary>
        /// Lowercase hex hash (16 characters) over every rendering-relevant effective value,
        /// including admin-only keys and <see cref="ResolverVersion"/>. Values of disabled groups are
        /// left out so changing them does not invalidate cached posters.
        /// </summary>
        public string Digest => DigestAt(DateTimeOffset.UtcNow);

        /// <summary>Status changes with time: retire URLs every five minutes, including cache-off tokens.</summary>
        public string DigestAt(DateTimeOffset now) => !Shows(PosterTagGroup.Status) ? _digest
            : Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(_digest + "|status:" + (now.ToUnixTimeSeconds() / 300).ToString(CultureInfo.InvariantCulture))))[..16];

        /// <summary>Static-friendly active layout; Caption, Summary and Minimal retain the Corners profile.</summary>
        public bool Bands { get; private init; }
        public bool CompactBands { get; private init; }
        public bool StatusTagsEnabled { get; private init; }
        public string StatusTagsPosition { get; private init; } = "top-right";
        public bool StatusJustAdded { get; private init; }
        public bool StatusNewRelease { get; private init; }
        public bool StatusTrending { get; private init; }
        public bool StatusSchedule { get; private init; }
        public bool StatusMilestones { get; private init; }
        public bool StatusSeriesStatus { get; private init; }
        /// <summary>Leaving soon family: the user's switch, while a Leaving soon source is set.</summary>
        public bool StatusLeaving { get; private init; }
        public int StatusJustAddedDays { get; private init; }
        public int StatusNewReleaseDays { get; private init; }
        public bool StatusRemoteEnabled { get; private init; }
        public CultureInfo StatusCulture { get; private init; } = CultureInfo.GetCultureInfo("en");
        public TimeZoneInfo StatusTimeZone { get; private init; } = TimeZoneInfo.Local;

        /// <summary>Effective size for native poster chips (legacy users keep default).</summary>
        public string TagScale { get; private init; } = "default";

        /// <summary>Effective spacing for native poster chips (legacy users keep default).</summary>
        public string TagGap { get; private init; } = "default";

        /// <summary>
        /// The corners layout's edge spacing ("default", "tight" or "flush"): the user's own, else the administrator's;
        /// always "default" for a document saved before layouts, like the web (core/tag-layout.js normalizeSettings).
        /// </summary>
        public string EdgeSpacing { get; private init; } = "default";

        /// <summary>The inset (CSS px) <see cref="EdgeSpacing"/> puts between chips and the card edges.</summary>
        public float EdgeInset => TagLayoutRules.EdgeInset(EdgeSpacing);

        /// <summary>The Tag Styles for native posters, with the user's own preset when allowed (empty unless the target includes native clients).</summary>
        public TagStyleSet Styles { get; private init; } = TagStyleSet.Empty;

        /// <summary>Effective <c>qualityTagsEnabled</c>.</summary>
        public bool QualityTagsEnabled { get; private init; }

        /// <summary>Effective <c>genreTagsEnabled</c>.</summary>
        public bool GenreTagsEnabled { get; private init; }

        /// <summary>Effective <c>languageTagsEnabled</c>.</summary>
        public bool LanguageTagsEnabled { get; private init; }

        /// <summary>Effective <c>ratingTagsEnabled</c> (also gates the user-review chip).</summary>
        public bool RatingTagsEnabled { get; private init; }

        /// <summary>Effective <c>ageRatingTagsEnabled</c>.</summary>
        public bool AgeRatingTagsEnabled { get; private init; }
        public bool AwardsTagsEnabled { get; private init; }
        public string AwardsTagsPosition { get; private init; } = "top-left";
        public int AwardsCap { get; private init; } = 2;
        public bool AwardsImdb { get; private init; }
        public bool AwardsCertifiedFresh { get; private init; }
        public bool AwardsOscar { get; private init; }
        public bool AwardsEmmy { get; private init; }
        public bool AwardsLetterboxd { get; private init; }

        /// <summary>Effective <c>logoTagsEnabled</c>.</summary>
        public bool LogoTagsEnabled { get; private init; }

        /// <summary>Effective <c>customTagsEnabled</c>.</summary>
        public bool CustomTagsEnabled { get; private init; }

        /// <summary>The administrator's Custom tag rules (labels and icons by rule id).</summary>
        public CustomTagMatcher CustomTagRules { get; private init; } = new(null);

        /// <summary>
        /// Groups the user set to "off" in the active native profile (Bands or Corners).
        /// </summary>
        public IReadOnlySet<PosterTagGroup> OffGroups { get; private init; } = new HashSet<PosterTagGroup>();

        /// <summary>
        /// The user's group priority order (stacking order within a shared corner), or null for the
        /// web's arrival order. Only an explicit order counts (the user's, else the administrator's
        /// default) in a document saved with the layout settings; a document from before layouts
        /// keeps arrival order, as on the web.
        /// </summary>
        public IReadOnlyList<PosterTagGroup>? GroupOrder { get; private init; }

        /// <summary>Most quality chips shown (0 = unlimited).</summary>
        public int QualityCap { get; private init; }

        /// <summary>Most genre chips shown (0 = unlimited; default 3).</summary>
        public int GenreCap { get; private init; } = 3;

        /// <summary>Most language flags shown (0 = unlimited; default 3).</summary>
        public int LanguageCap { get; private init; } = 3;

        // Language display settings are separate from layout settings for stacked branches.
        /// <summary>Include audio track languages.</summary>
        public bool LanguageShowAudio { get; private init; } = true;
        /// <summary>Include subtitle track languages, with a CC marker.</summary>
        public bool LanguageShowSubtitles { get; private init; }
        /// <summary>Flags or uppercase ISO codes.</summary>
        public string LanguageStyle { get; private init; } = "flags";
        /// <summary>Off, badge only, or badge with audio chips.</summary>
        public string LanguageCountBadge { get; private init; } = "off";

        /// <summary>Most rating chips shown, user-review chip included (0 = unlimited).</summary>
        public int RatingCap { get; private init; }

        /// <summary>Most age rating chips shown (0 = unlimited; there is only ever one).</summary>
        public int AgeRatingCap { get; private init; } = 1;

        /// <summary>Most logos shown (0 = every logo the entry carries).</summary>
        public int LogoCap { get; private init; }
        /// <summary>Most Custom chips shown (0 = unlimited; default 3).</summary>
        public int CustomCap { get; private init; } = 3;

        /// <summary>
        /// Quality position string as the web resolves it: the user's corners profile slot when it
        /// names a corner, else the position setting (user, else admin, else "top-left").
        /// </summary>
        public string QualityTagsPosition { get; private init; } = "top-left";

        /// <summary>Genre position string (default "top-right").</summary>
        public string GenreTagsPosition { get; private init; } = "top-right";

        /// <summary>Language position string (default "bottom-left").</summary>
        public string LanguageTagsPosition { get; private init; } = "bottom-left";

        /// <summary>Rating position string, also used by the user-review chip (default "bottom-right").</summary>
        public string RatingTagsPosition { get; private init; } = "bottom-right";

        /// <summary>Age rating position string (default "bottom-right").</summary>
        public string AgeRatingTagsPosition { get; private init; } = "bottom-right";

        /// <summary>Logos position string (default "bottom-left").</summary>
        public string LogoTagsPosition { get; private init; } = "bottom-left";
        /// <summary>Custom tags position string (default "top-left").</summary>
        public string CustomTagsPosition { get; private init; } = "top-left";

        /// <summary>Effective <c>showResolutionTag</c>.</summary>
        public bool ShowResolutionTag { get; private init; } = true;

        /// <summary>Effective <c>showSourceTag</c>.</summary>
        public bool ShowSourceTag { get; private init; } = true;

        // Source and edition effective settings.
        /// <summary>Whether edition chips are shown.</summary>
        public bool ShowEditionTag { get; private init; } = true;
        /// <summary>Stack order of edition chips.</summary>
        public int EditionTagOrder { get; private init; } = 7;
        /// <summary>Whether CAM, TS, TC and SCR sources are eligible.</summary>
        public bool ShowLowQualitySourceTag { get; private init; }


        /// <summary>Effective <c>showDynamicRangeTag</c>.</summary>
        public bool ShowDynamicRangeTag { get; private init; } = true;

        /// <summary>Effective <c>showSpecialFormatTag</c>.</summary>
        public bool ShowSpecialFormatTag { get; private init; } = true;

        /// <summary>Effective <c>showVideoCodecTag</c>.</summary>
        public bool ShowVideoCodecTag { get; private init; } = true;

        /// <summary>Effective <c>showAudioInfoTag</c>.</summary>
        public bool ShowAudioInfoTag { get; private init; } = true;

        /// <summary>Effective <c>resolutionTagOrder</c> (stack position, lower first).</summary>
        public int ResolutionTagOrder { get; private init; } = 1;

        /// <summary>Effective <c>sourceTagOrder</c>.</summary>
        public int SourceTagOrder { get; private init; } = 2;

        /// <summary>Effective <c>dynamicRangeTagOrder</c>.</summary>
        public int DynamicRangeTagOrder { get; private init; } = 3;

        /// <summary>Effective <c>specialFormatTagOrder</c>.</summary>
        public int SpecialFormatTagOrder { get; private init; } = 4;

        /// <summary>Effective <c>videoCodecTagOrder</c>.</summary>
        public int VideoCodecTagOrder { get; private init; } = 5;

        /// <summary>Effective <c>audioInfoTagOrder</c>.</summary>
        public int AudioInfoTagOrder { get; private init; } = 6;

        /// <summary>The user's own <c>qualityTagsPreferredAudioLanguage</c> choice ("" server default, "auto", "none", or a code).</summary>
        public string QualityTagsPreferredAudioLanguage { get; private init; } = string.Empty;

        /// <summary>Effective series/season quality aggregation policy.</summary>
        public string SeriesQualityAggregation { get; private init; } = "representative";

        /// <summary>
        /// The language whose audio tracks decide the sound tag, or null for "best track overall":
        /// the user's choice ("auto" = their Jellyfin audio language, "none" = no preference), else the
        /// user's Jellyfin audio language when the admin enabled <c>QualityTagsAudioLanguageFromUser</c>,
        /// else the admin's fixed language.
        /// </summary>
        public string? PreferredAudioLanguage { get; private init; }

        /// <summary>
        /// True when the effective preference follows the Jellyfin audio language. The web then
        /// registers quality tags only after fetching that preference, so they come after the other
        /// groups in paint/stack order.
        /// </summary>
        public bool UsesJellyfinAudioPreference { get; private init; }

        /// <summary>Effective <c>ratingTagsOnMovies</c>.</summary>
        public bool RatingTagsOnMovies { get; private init; } = true;

        /// <summary>Effective <c>ratingTagsOnSeries</c>.</summary>
        public bool RatingTagsOnSeries { get; private init; } = true;

        /// <summary>Effective <c>ratingTagsOnSeasons</c>.</summary>
        public bool RatingTagsOnSeasons { get; private init; } = true;

        /// <summary>Effective <c>ratingTagsOnEpisodes</c>.</summary>
        public bool RatingTagsOnEpisodes { get; private init; } = true;

        /// <summary>Effective <c>ratingTagsOnContinueWatching</c>. Not applied: an image request does not know the home row.</summary>
        public bool RatingTagsOnContinueWatching { get; private init; } = true;

        /// <summary>Effective <c>ratingTagsOnNextUp</c>. Not applied: an image request does not know the home row.</summary>
        public bool RatingTagsOnNextUp { get; private init; } = true;

        /// <summary>Effective <c>ratingTagsShowCommunity</c>: the community (star) score chip.</summary>
        public bool RatingTagsShowCommunity { get; private init; } = true;

        /// <summary>Effective <c>ratingTagsShowCritic</c>: the critic (tomato) score chip.</summary>
        public bool RatingTagsShowCritic { get; private init; } = true;

        // Multi-source rating preferences participate in signed image digests.
        public string[]? RatingTagsSources { get; private init; }
        public double RatingTagsMinScore { get; private init; }
        public bool RatingTagsColorByScore { get; private init; }
        public bool RatingTagsCompact { get; private init; }


        /// <summary>Effective personal ISO priorities, or the administrator's legacy terms.</summary>
        public IReadOnlyList<string> LanguagePriorityTerms { get; private init; } = Array.Empty<string>();

        /// <summary>Whether language terms are personal ISO codes using canonical matching.</summary>
        public bool LanguagePriorityIsPersonal { get; private init; }

        /// <summary>Personal strict override, otherwise the administrator's current policy.</summary>
        public bool LanguagePriorityStrict { get; private init; }

        /// <summary>Admin <c>LanguageTagsMergeRegions</c>.</summary>
        public bool LanguageMergeRegions { get; private init; }

        /// <summary>Admin <c>ShowUserReviews</c>.</summary>
        public bool ShowUserReviews { get; private init; }

        /// <summary>Admin <c>ShowUserRatingOnPosters</c>.</summary>
        public bool ShowUserRatingOnPosters { get; private init; }

        /// <summary>Admin <c>ShowUserRatingDash</c>: show a dash when an item has no user reviews.</summary>
        public bool ShowUserRatingDash { get; private init; } = true;

        /// <summary>
        /// True when an enabled group sits exactly at "top-right", the only position the web pushes
        /// down below a played / unplayed-count indicator. Without one the top-right offset never
        /// changes the drawing, so callers can leave it out of cache keys.
        /// </summary>
        public bool HasTopRightGroup =>
            (Bands && Enum.GetValues<PosterTagGroup>().Any(g => Shows(g) && PositionOf(g) == "top-left"))
            || (Shows(PosterTagGroup.Quality) && IsTopRight(QualityTagsPosition))
            || (Shows(PosterTagGroup.Genre) && IsTopRight(GenreTagsPosition))
            || (Shows(PosterTagGroup.Rating) && IsTopRight(RatingTagsPosition))
            || (Shows(PosterTagGroup.AgeRating) && IsTopRight(AgeRatingTagsPosition))
            || (Shows(PosterTagGroup.Language) && IsTopRight(LanguageTagsPosition))
            || (Shows(PosterTagGroup.Awards) && IsTopRight(AwardsTagsPosition))
            || (Shows(PosterTagGroup.Status) && (Bands || IsTopRight(StatusTagsPosition)))
            || (Shows(PosterTagGroup.Logos) && IsTopRight(LogoTagsPosition))
            || (Shows(PosterTagGroup.Custom) && IsTopRight(CustomTagsPosition));


        /// <summary>Whether the user-review chip can appear: reviews, posters chip and a shown rating group.</summary>
        public bool UserReviewChipEnabled => ShowUserReviews && ShowUserRatingOnPosters && Shows(PosterTagGroup.Rating);

        /// <summary>
        /// Builds the effective settings from the text of the user's settings.json, read exactly as
        /// the server reads it for the web (<c>UserConfigurationManager.GetUserConfiguration&lt;JellyfinEnhancedUserSettings&gt;</c>:
        /// Newtonsoft with its lenient syntax, case-insensitive keys, last duplicate key wins, JSON
        /// nulls skipped; empty, whitespace-only, <c>null</c>, non-object or unparseable content gives
        /// the <see cref="JellyfinEnhancedUserSettings"/> defaults). Prefer this over <see cref="Create"/>, which can
        /// only see what a stricter JSON parser accepted.
        /// </summary>
        /// <param name="settingsJson">
        /// The file's contents, or null when the user has no settings.json yet (the web would first
        /// write one from the plugin defaults). Pass <see cref="string.Empty"/> for a file that
        /// exists but cannot be read.
        /// </param>
        /// <param name="config">The plugin configuration.</param>
        /// <param name="jellyfinAudioLanguagePreference">
        /// The user's Jellyfin <c>Configuration.AudioLanguagePreference</c>; only consulted when the
        /// effective quality audio preference follows it.
        /// </param>
        /// <returns>The effective settings.</returns>
        public static PosterTagSettings FromSettingsJson(string? settingsJson, PluginConfiguration config, string? jellyfinAudioLanguagePreference = null)
        {
            if (settingsJson is null) return FromUserSettings(null, config, jellyfinAudioLanguagePreference);
            return FromUserSettings(ReadAsServer(settingsJson), config, jellyfinAudioLanguagePreference);
        }

        /// <summary>
        /// Builds the effective settings from the parsed contents of the user's settings.json.
        /// </summary>
        /// <param name="userSettings">
        /// The parsed settings.json, or null when the user has no file yet (the web would first write
        /// one from the plugin defaults). Pass an empty object for a file that exists but is empty or
        /// unreadable (the web then sees the <see cref="JellyfinEnhancedUserSettings"/> defaults). camelCase and
        /// PascalCase keys and JSON nulls are handled as the server reads them.
        /// </param>
        /// <param name="config">The plugin configuration.</param>
        /// <param name="jellyfinAudioLanguagePreference">
        /// The user's Jellyfin <c>Configuration.AudioLanguagePreference</c>; only consulted when the
        /// effective quality audio preference follows it.
        /// </param>
        /// <returns>The effective settings.</returns>
        public static PosterTagSettings Create(JsonObject? userSettings, PluginConfiguration config, string? jellyfinAudioLanguagePreference = null)
        {
            JellyfinEnhancedUserSettings? parsed = null;
            if (userSettings is not null)
            {
                string json;
                try
                {
                    json = userSettings.ToJsonString();
                }
                catch (Exception)
                {
                    json = string.Empty;
                }

                parsed = ReadAsServer(json);
            }

            return FromUserSettings(parsed, config, jellyfinAudioLanguagePreference);
        }

        /// <summary>UserConfigurationManager.GetUserConfiguration&lt;JellyfinEnhancedUserSettings&gt; for an existing file's text.</summary>
        private static JellyfinEnhancedUserSettings ReadAsServer(string json)
        {
            if (string.IsNullOrWhiteSpace(json)) return new JellyfinEnhancedUserSettings();
            try
            {
                return JsonConvert.DeserializeObject<JellyfinEnhancedUserSettings>(json, LenientRead) ?? new JellyfinEnhancedUserSettings();
            }
            catch (Exception)
            {
                // The server returns the defaults on any read error.
                return new JellyfinEnhancedUserSettings();
            }
        }

        /// <summary>
        /// Builds the effective settings from the user's settings as the server reads them
        /// (<c>UserConfigurationManager.GetUserConfiguration&lt;JellyfinEnhancedUserSettings&gt;</c>).
        /// </summary>
        /// <param name="userSettings">The user's settings, or null when the user has no settings.json yet.</param>
        /// <param name="config">The plugin configuration.</param>
        /// <param name="jellyfinAudioLanguagePreference">The user's Jellyfin audio language preference.</param>
        /// <returns>The effective settings.</returns>
        public static PosterTagSettings FromUserSettings(JellyfinEnhancedUserSettings? userSettings, PluginConfiguration config, string? jellyfinAudioLanguagePreference = null)
        {
            ArgumentNullException.ThrowIfNull(config);
            var user = userSettings ?? DefaultsAsWritten(config);

            var preferredChoice = user.QualityTagsPreferredAudioLanguage ?? string.Empty;
            var (preferred, usesJellyfin) = ResolvePreferredAudioLanguage(preferredChoice, config, jellyfinAudioLanguagePreference);
            var useNative = user.UseNativePosterTags != false;
            var layout = ResolveLayout(user, config);

            var settings = new PosterTagSettings
            {
                UseNativePosterTags = useNative,
                Bands = layout.Bands,
                CompactBands = layout.Bands && user.TagLabelDensity == "compact",
                StatusTagsEnabled = user.StatusTagsEnabled,
                StatusTagsPosition = layout.Corners.GetValueOrDefault(PosterTagGroup.Status) ?? Position(user.StatusTagsPosition, config.StatusTagsPosition, "top-right"),
                StatusJustAdded = user.StatusTagsJustAdded,
                StatusNewRelease = user.StatusTagsNewRelease,
                StatusTrending = user.StatusTagsTrending && config.StatusTagsEnabled && config.StatusTagsTrending && !string.IsNullOrWhiteSpace(config.TMDB_API_KEY),
                StatusSchedule = user.StatusTagsSchedule,
                StatusMilestones = user.StatusTagsMilestones,
                StatusSeriesStatus = user.StatusTagsSeriesStatus,
                StatusLeaving = user.StatusTagsLeaving && LeavingSoonService.Configured(config),
                StatusJustAddedDays = Math.Clamp(config.StatusTagsJustAddedDays, StatusRules.Thresholds.MinWindowDays, StatusRules.Thresholds.MaxWindowDays),
                StatusNewReleaseDays = Math.Clamp(config.StatusTagsNewReleaseDays, StatusRules.Thresholds.MinWindowDays, StatusRules.Thresholds.MaxWindowDays),
                StatusRemoteEnabled = config.StatusTagsEnabled && !string.IsNullOrWhiteSpace(config.TMDB_API_KEY),
                StatusCulture = StatusRules.Culture(user.NativePosterDateLocale ?? Position(user.DisplayLanguage, config.DefaultLanguage, "en")),
                StatusTimeZone = StatusRules.TimeZone(user.NativePosterTimeZone),
                NativeEnabled = config.NativePosterTagsEnabled && useNative,
                QualityTagsEnabled = user.QualityTagsEnabled,
                GenreTagsEnabled = user.GenreTagsEnabled,
                LanguageTagsEnabled = user.LanguageTagsEnabled,
                RatingTagsEnabled = user.RatingTagsEnabled,
                AgeRatingTagsEnabled = user.AgeRatingTagsEnabled,
                AwardsTagsEnabled = user.AwardsTagsEnabled && config.AwardsTagsEnabled,
                AwardsTagsPosition = layout.Corners.GetValueOrDefault(PosterTagGroup.Awards) ?? Position(user.AwardsTagsPosition, config.AwardsTagsPosition, "top-left"),
                AwardsCap = layout.Cap("awards"),
                AwardsImdb = config.AwardsTagsImdb,
                AwardsCertifiedFresh = config.AwardsTagsCertifiedFresh,
                AwardsOscar = config.AwardsTagsOscar,
                AwardsEmmy = config.AwardsTagsEmmy,
                AwardsLetterboxd = config.AwardsTagsLetterboxd,
                LogoTagsEnabled = user.LogoTagsEnabled,
                CustomTagsEnabled = user.CustomTagsEnabled,
                CustomTagRules = CustomTagMatcher.For(config),
                QualityTagsPosition = layout.Corners.GetValueOrDefault(PosterTagGroup.Quality) ?? Position(user.QualityTagsPosition, config.QualityTagsPosition, "top-left"),
                GenreTagsPosition = layout.Corners.GetValueOrDefault(PosterTagGroup.Genre) ?? Position(user.GenreTagsPosition, config.GenreTagsPosition, "top-right"),
                LanguageTagsPosition = layout.Corners.GetValueOrDefault(PosterTagGroup.Language) ?? Position(user.LanguageTagsPosition, config.LanguageTagsPosition, "bottom-left"),
                RatingTagsPosition = layout.Corners.GetValueOrDefault(PosterTagGroup.Rating) ?? Position(user.RatingTagsPosition, config.RatingTagsPosition, "bottom-right"),
                AgeRatingTagsPosition = layout.Corners.GetValueOrDefault(PosterTagGroup.AgeRating) ?? Position(user.AgeRatingTagsPosition, config.AgeRatingTagsPosition, "bottom-right"),
                TagScale = user.TagLayoutSettingsVersion < 1 ? "default" : TagLayoutRules.NormalizeScale(user.TagScale ?? config.TagScale),
                TagGap = user.TagLayoutSettingsVersion < 1 ? "default" : TagLayoutRules.NormalizeGap(user.TagGap ?? config.TagGap),
                LogoTagsPosition = layout.Corners.GetValueOrDefault(PosterTagGroup.Logos) ?? Position(user.LogoTagsPosition, config.LogoTagsPosition, "bottom-left"),
                CustomTagsPosition = layout.Corners.GetValueOrDefault(PosterTagGroup.Custom) ?? Position(user.CustomTagsPosition, config.CustomTagsPosition, "top-left"),
                OffGroups = layout.Off,
                GroupOrder = layout.Order,
                QualityCap = layout.Cap("quality"),
                GenreCap = layout.Cap("genre"),
                LanguageCap = layout.Cap("language"),
                LanguageShowAudio = user.LanguageTagsShowAudio,
                LanguageShowSubtitles = user.LanguageTagsShowSubtitles,
                LanguageStyle = LanguageTagDisplay.NormalizeStyle(user.LanguageTagsStyle),
                LanguageCountBadge = LanguageTagDisplay.NormalizeCountBadge(user.LanguageTagsCountBadge),
                RatingCap = layout.Cap("rating"),
                AgeRatingCap = layout.Cap("ageRating"),
                LogoCap = layout.Cap("logos"),
                CustomCap = layout.Cap("custom"),
                ShowResolutionTag = user.ShowResolutionTag,
                ShowSourceTag = user.ShowSourceTag,
                ShowEditionTag = user.ShowEditionTag ?? config.ShowEditionTag,
                EditionTagOrder = user.EditionTagOrder ?? config.EditionTagOrder,
                ShowLowQualitySourceTag = user.ShowLowQualitySourceTag ?? config.ShowLowQualitySourceTag,
                ShowDynamicRangeTag = user.ShowDynamicRangeTag,
                ShowSpecialFormatTag = user.ShowSpecialFormatTag,
                ShowVideoCodecTag = user.ShowVideoCodecTag,
                ShowAudioInfoTag = user.ShowAudioInfoTag,
                ResolutionTagOrder = user.ResolutionTagOrder ?? config.ResolutionTagOrder,
                SourceTagOrder = user.SourceTagOrder ?? config.SourceTagOrder,
                DynamicRangeTagOrder = user.DynamicRangeTagOrder ?? config.DynamicRangeTagOrder,
                SpecialFormatTagOrder = user.SpecialFormatTagOrder ?? config.SpecialFormatTagOrder,
                VideoCodecTagOrder = user.VideoCodecTagOrder ?? config.VideoCodecTagOrder,
                AudioInfoTagOrder = user.AudioInfoTagOrder ?? config.AudioInfoTagOrder,
                QualityTagsPreferredAudioLanguage = preferredChoice,
                SeriesQualityAggregation = Services.SeriesQualityAggregation.Normalize(user.SeriesQualityAggregation ?? config.SeriesQualityAggregation),
                PreferredAudioLanguage = preferred,
                UsesJellyfinAudioPreference = usesJellyfin,
                RatingTagsOnMovies = user.RatingTagsOnMovies,
                RatingTagsOnSeries = user.RatingTagsOnSeries,
                RatingTagsOnSeasons = user.RatingTagsOnSeasons,
                RatingTagsOnEpisodes = user.RatingTagsOnEpisodes,
                RatingTagsOnContinueWatching = user.RatingTagsOnContinueWatching,
                RatingTagsOnNextUp = user.RatingTagsOnNextUp,
                RatingTagsShowCommunity = user.RatingTagsShowCommunity,
                RatingTagsShowCritic = user.RatingTagsShowCritic,
                RatingTagsSources = RatingSourceSettings.NormalizeSources(user.RatingTagsSources),
                RatingTagsMinScore = RatingSourceSettings.NormalizeMinimum(user.RatingTagsMinScore),
                RatingTagsColorByScore = user.RatingTagsColorByScore,
                RatingTagsCompact = user.TagLabelDensity == "compact",
                LanguagePriorityTerms = LanguageTagPriority.TryNormalize(user.LanguageTagsPriority, out var personalPriority) && personalPriority is not null
                    ? personalPriority : LanguageFlagRules.ParsePriorityTerms(config.LanguageTagsPriority),
                LanguagePriorityIsPersonal = personalPriority is not null,
                LanguagePriorityStrict = user.LanguageTagsPriorityStrict ?? config.LanguageTagsPriorityStrict,
                LanguageMergeRegions = config.LanguageTagsMergeRegions,
                ShowUserReviews = config.ShowUserReviews,
                ShowUserRatingOnPosters = config.ShowUserRatingOnPosters,
                ShowUserRatingDash = config.ShowUserRatingDash,
                EdgeSpacing = user.TagLayoutSettingsVersion < 1
                    ? "default"
                    : TagLayoutRules.NormalizeEdgeSpacing(user.TagEdgeSpacing) ?? TagLayoutRules.NormalizeEdgeSpacing(config.TagEdgeSpacing) ?? "default",
                Styles = config.TagStylesEnabled && config.TagStyleTarget is "native" or "both"
                    ? TagStyleSet.Parse(config.TagStyleOverrides, config.TagStylePreset).ForUser(user.TagStylePreset, config.TagStylesAllowUserPreset)
                    : TagStyleSet.Empty,
            };

            return settings with { _digest = settings.ComputeDigest() };
        }

        /// <summary>The corner a position string selects (the web only tests for "top" and "left").</summary>
        /// <param name="position">A position string such as "top-right".</param>
        /// <returns>The corner.</returns>
        public static PosterTagCorner CornerOf(string position)
        {
            switch (position)
            {
                case "top-center": return PosterTagCorner.TopCenter;
                case "bottom-center": return PosterTagCorner.BottomCenter;
                case "center-left": return PosterTagCorner.CenterLeft;
                case "center-right": return PosterTagCorner.CenterRight;
                case "center": return PosterTagCorner.Center;
            }
            var isTop = position.Contains("top", StringComparison.Ordinal);
            var isLeft = position.Contains("left", StringComparison.Ordinal);
            return isTop
                ? (isLeft ? PosterTagCorner.TopLeft : PosterTagCorner.TopRight)
                : (isLeft ? PosterTagCorner.BottomLeft : PosterTagCorner.BottomRight);
        }

        /// <summary>Whether a group is drawn: switched on and not set to "off" in the active native layout.</summary>
        /// <param name="group">The tag group.</param>
        /// <returns>True when the group is drawn.</returns>
        public bool Shows(PosterTagGroup group) => !OffGroups.Contains(group) && group switch
        {
            PosterTagGroup.Quality => QualityTagsEnabled,
            PosterTagGroup.Genre => GenreTagsEnabled,
            PosterTagGroup.Rating => RatingTagsEnabled,
            PosterTagGroup.AgeRating => AgeRatingTagsEnabled,
            PosterTagGroup.Awards => AwardsTagsEnabled,
            PosterTagGroup.Status => StatusTagsEnabled,
            PosterTagGroup.Logos => LogoTagsEnabled,
            PosterTagGroup.Custom => CustomTagsEnabled,
            _ => LanguageTagsEnabled,
        };

        /// <summary>The most chips a group shows (0 = unlimited).</summary>
        /// <param name="group">The tag group.</param>
        /// <returns>The cap.</returns>
        public int CapOf(PosterTagGroup group) => group switch
        {
            PosterTagGroup.Quality => QualityCap,
            PosterTagGroup.Genre => GenreCap,
            PosterTagGroup.Rating => RatingCap,
            PosterTagGroup.AgeRating => AgeRatingCap,
            PosterTagGroup.Awards => AwardsCap,
            PosterTagGroup.Status => 1,
            PosterTagGroup.Logos => LogoCap,
            PosterTagGroup.Custom => CustomCap,
            _ => LanguageCap,
        };

        /// <summary>The effective position string of a group.</summary>
        /// <param name="group">The tag group.</param>
        /// <returns>The position string.</returns>
        public string PositionOf(PosterTagGroup group) => group switch
        {
            PosterTagGroup.Quality => QualityTagsPosition,
            PosterTagGroup.Genre => GenreTagsPosition,
            PosterTagGroup.Rating => RatingTagsPosition,
            PosterTagGroup.AgeRating => AgeRatingTagsPosition,
            PosterTagGroup.Awards => AwardsTagsPosition,
            PosterTagGroup.Status => StatusTagsPosition,
            PosterTagGroup.Logos => LogoTagsPosition,
            PosterTagGroup.Custom => CustomTagsPosition,
            _ => LanguageTagsPosition,
        };

        /// <summary>Whether a quality category (model key) is shown.</summary>
        internal bool IsQualityCategoryShown(string category) => category switch
        {
            QualityTagRules.Resolution => ShowResolutionTag,
            QualityTagRules.Source => ShowSourceTag,
            QualityTagRules.Edition => ShowEditionTag,
            QualityTagRules.DynamicRange => ShowDynamicRangeTag,
            QualityTagRules.SpecialFormat => ShowSpecialFormatTag,
            QualityTagRules.VideoCodec => ShowVideoCodecTag,
            QualityTagRules.AudioInfo => ShowAudioInfoTag,
            _ => true,
        };

        /// <summary>The stack order of a quality category (model key).</summary>
        internal int QualityCategoryOrder(string category) => category switch
        {
            QualityTagRules.Resolution => ResolutionTagOrder,
            QualityTagRules.Source => SourceTagOrder,
            QualityTagRules.Edition => EditionTagOrder,
            QualityTagRules.DynamicRange => DynamicRangeTagOrder,
            QualityTagRules.SpecialFormat => SpecialFormatTagOrder,
            QualityTagRules.VideoCodec => VideoCodecTagOrder,
            _ => AudioInfoTagOrder,
        };

        /// <summary>
        /// qualitytags.js resolvePreferredAudioLanguage / usesJellyfinAudioPreference.
        /// </summary>
        private static (string? Preferred, bool UsesJellyfin) ResolvePreferredAudioLanguage(string choiceRaw, PluginConfiguration config, string? jellyfinPreferenceRaw)
        {
            var choice = JsText.Trim(choiceRaw);
            var lowered = JsText.ToLower(choice);
            var jellyfinPreference = jellyfinPreferenceRaw is null ? null : JsText.Trim(jellyfinPreferenceRaw);
            if (string.IsNullOrEmpty(jellyfinPreference)) jellyfinPreference = null;

            if (lowered == "none") return (null, false);
            if (lowered == "auto") return (jellyfinPreference, true);
            if (choice.Length > 0) return (choice, false);

            var fromUser = config.QualityTagsAudioLanguageFromUser;
            if (fromUser && jellyfinPreference is not null) return (jellyfinPreference, true);
            var fixedLanguage = JsText.Trim(config.QualityTagsPreferredAudioLanguage ?? string.Empty);
            return (fixedLanguage.Length > 0 ? fixedLanguage : null, fromUser);
        }

        /// <summary>The layout group id (TagLayoutRules) of a native group.</summary>
        private static string LayoutGroupId(PosterTagGroup group) => group switch
        {
            PosterTagGroup.Quality => "quality",
            PosterTagGroup.Genre => "genre",
            PosterTagGroup.Rating => "rating",
            PosterTagGroup.AgeRating => "ageRating",
            PosterTagGroup.Awards => "awards",
            PosterTagGroup.Status => "status",
            PosterTagGroup.Logos => "logos",
            PosterTagGroup.Custom => "custom",
            _ => "language",
        };

        /// <summary>
        /// core/tag-layout.js normalizeSettings, reduced to static native layouts: Bands uses its active
        /// profile and density; title/hover layouts use the user's own full-label Corners
        /// profile (a corner slot overrides the position setting, "off" hides the group; the
        /// administrator's corners profile never applies, the position settings stand for it), the
        /// user's own priority order and the caps. Without an own order the groups keep arrival order
        /// (the administrator's order reaches users only by being copied in: new-user seeding, "apply
        /// defaults to all users", Reset), so a document promoted from before layouts never picks it
        /// up. A document from before layouts (version 0) keeps arrival order and the built-in caps.
        /// </summary>
        private static NativeLayout ResolveLayout(JellyfinEnhancedUserSettings user, PluginConfiguration config)
        {
            var legacy = user.TagLayoutSettingsVersion < 1;
            var bands = !legacy && TagLayoutRules.NormalizeLayout(user.TagLayout) == "bands";
            var corners = new Dictionary<PosterTagGroup, string>();
            var off = new HashSet<PosterTagGroup>();
            var profile = TagLayoutRules.NormalizeProfile(bands ? "bands" : "corners", bands ? user.TagLayouts?.Bands : user.TagLayouts?.Corners);
            var adminProfile = bands ? TagLayoutRules.NormalizeProfile("bands", config.TagLayouts?.Bands) : null;
            foreach (var group in Enum.GetValues<PosterTagGroup>())
            {
                var slot = profile?.Groups.Find(g => g.Group == LayoutGroupId(group))?.Slot;
                if (bands)
                {
                    slot ??= adminProfile?.Groups.Find(g => g.Group == LayoutGroupId(group))?.Slot
                        ?? (group is PosterTagGroup.Status or PosterTagGroup.AgeRating or PosterTagGroup.Logos ? "top" : group == PosterTagGroup.Genre ? "off" : "bottom");
                    if (slot != "off") corners[group] = slot == "top" ? "top-left" : "bottom-left";
                }
                if (slot == "off") off.Add(group);
                else if (slot is not null && CornerSlotPositions.TryGetValue(slot, out var position)) corners[group] = position;
            }

            List<PosterTagGroup>? order = null;
            var explicitOrder = legacy ? null : TagLayoutRules.NormalizeOrder(user.TagGroupOrder) ?? (bands ? TagLayoutRules.DefaultGroupOrder.ToList() : null);
            if (explicitOrder is not null)
            {
                // Complete the order as the web does (missing groups follow in the default order),
                // then keep the native groups.
                var complete = explicitOrder.Concat(TagLayoutRules.DefaultGroupOrder.Where(g => !explicitOrder.Contains(g, StringComparer.Ordinal)));
                order = complete
                    .Select(id => Enum.GetValues<PosterTagGroup>().Cast<PosterTagGroup?>().FirstOrDefault(g => LayoutGroupId(g!.Value) == id))
                    .Where(g => g.HasValue)
                    .Select(g => g!.Value)
                    .ToList();
            }

            var userCaps = legacy ? null : TagLayoutRules.NormalizeCaps(user.TagGroupCaps);
            var adminCaps = legacy ? null : TagLayoutRules.NormalizeCaps(config.TagGroupCaps);
            return new NativeLayout(corners, off, order, userCaps, adminCaps, bands);
        }

        /// <summary>The position strings the corners layout's slots stand for (core/tag-layout.js SLOT_TO_POSITION).</summary>
        internal static readonly IReadOnlyDictionary<string, string> CornerSlotPositions = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["tl"] = "top-left",
            ["tr"] = "top-right",
            ["bl"] = "bottom-left",
            ["br"] = "bottom-right",
            ["tc"] = "top-center",
            ["bc"] = "bottom-center",
            ["ml"] = "center-left",
            ["mr"] = "center-right",
            ["c"] = "center",
        };

        /// <summary>The native-relevant part of a user's layout settings.</summary>
        private sealed record NativeLayout(
            IReadOnlyDictionary<PosterTagGroup, string> Corners,
            IReadOnlySet<PosterTagGroup> Off,
            IReadOnlyList<PosterTagGroup>? Order,
            TagGroupCaps? UserCaps,
            TagGroupCaps? AdminCaps,
            bool Bands)
        {
            /// <summary>A group's cap: user, else administrator, else the built-in limit.</summary>
            public int Cap(string group) => Pick(UserCaps, group) ?? Pick(AdminCaps, group) ?? group switch
            {
                "genre" => 3,
                "language" => 3,
                "awards" => 2,
                "ageRating" or "status" => 1,
                "custom" => 3,
                _ => 0,
            };

            private static int? Pick(TagGroupCaps? caps, string group) => group switch
            {
                "quality" => caps?.Quality,
                "genre" => caps?.Genre,
                "language" => caps?.Language,
                "rating" => caps?.Rating,
                "awards" => caps?.Awards,
                "status" => caps?.Status,
                "logos" => caps?.Logos,
                "custom" => caps?.Custom,
                _ => caps?.AgeRating,
            };
        }

        private static bool IsTopRight(string position) => string.Equals(position, "top-right", StringComparison.Ordinal);

        /// <summary>resolvePosition: user value, else admin value, else the hard-coded default (empty strings fall through).</summary>
        private static string Position(string? user, string? admin, string fallback)
        {
            if (!string.IsNullOrEmpty(user)) return user;
            if (!string.IsNullOrEmpty(admin)) return admin;
            return fallback;
        }

        /// <summary>
        /// What the web sees for a user without settings.json: the controller writes the plugin
        /// defaults (only the keys it copies) and reads the file back (JSON nulls ignored).
        /// </summary>
        private static JellyfinEnhancedUserSettings DefaultsAsWritten(PluginConfiguration config)
        {
            var defaults = new JellyfinEnhancedUserSettings
            {
                UseNativePosterTags = null,
                QualityTagsEnabled = config.QualityTagsEnabled,
                ShowResolutionTag = config.ShowResolutionTag,
                ShowSourceTag = config.ShowSourceTag,
                ShowEditionTag = config.ShowEditionTag,
                EditionTagOrder = config.EditionTagOrder,
                ShowLowQualitySourceTag = config.ShowLowQualitySourceTag,
                ShowDynamicRangeTag = config.ShowDynamicRangeTag,
                ShowSpecialFormatTag = config.ShowSpecialFormatTag,
                ShowVideoCodecTag = config.ShowVideoCodecTag,
                ShowAudioInfoTag = config.ShowAudioInfoTag,
                ResolutionTagOrder = config.ResolutionTagOrder,
                SourceTagOrder = config.SourceTagOrder,
                DynamicRangeTagOrder = config.DynamicRangeTagOrder,
                SpecialFormatTagOrder = config.SpecialFormatTagOrder,
                VideoCodecTagOrder = config.VideoCodecTagOrder,
                AudioInfoTagOrder = config.AudioInfoTagOrder,
                GenreTagsEnabled = config.GenreTagsEnabled,
                LanguageTagsEnabled = config.LanguageTagsEnabled,
                RatingTagsEnabled = config.RatingTagsEnabled,
                AgeRatingTagsEnabled = config.AgeRatingTagsEnabled,
                AwardsTagsEnabled = config.AwardsTagsEnabled,
                AwardsTagsPosition = config.AwardsTagsPosition,
                PeopleTagsEnabled = config.PeopleTagsEnabled,
                StatusTagsEnabled = config.StatusTagsEnabled,
                StatusTagsPosition = config.StatusTagsPosition,
                StatusTagsJustAdded = config.StatusTagsJustAdded,
                StatusTagsNewRelease = config.StatusTagsNewRelease,
                StatusTagsTrending = config.StatusTagsTrending,
                StatusTagsSchedule = config.StatusTagsSchedule,
                StatusTagsMilestones = config.StatusTagsMilestones,
                StatusTagsSeriesStatus = config.StatusTagsSeriesStatus,
                StatusTagsLeaving = config.StatusTagsLeaving,
                StatusTagsDirectPlay = config.StatusTagsDirectPlay,
                DisplayLanguage = config.DefaultLanguage,
                QualityTagsPosition = config.QualityTagsPosition,
                SeriesQualityAggregation = config.SeriesQualityAggregation,
                GenreTagsPosition = config.GenreTagsPosition,
                LanguageTagsPosition = config.LanguageTagsPosition,
                RatingTagsPosition = config.RatingTagsPosition,
                RatingTagsOnMovies = config.RatingTagsOnMovies,
                RatingTagsOnSeries = config.RatingTagsOnSeries,
                RatingTagsOnSeasons = config.RatingTagsOnSeasons,
                RatingTagsOnEpisodes = config.RatingTagsOnEpisodes,
                RatingTagsOnContinueWatching = config.RatingTagsOnContinueWatching,
                RatingTagsOnNextUp = config.RatingTagsOnNextUp,
                RatingTagsShowCommunity = config.RatingTagsShowCommunity,
                RatingTagsShowCritic = config.RatingTagsShowCritic,
                RatingTagsSources = RatingSourceSettings.Defaults(config).ToArray(),
                RatingTagsMinScore = RatingSourceSettings.NormalizeMinimum(config.RatingTagsMinScore),
                RatingTagsColorByScore = config.RatingTagsColorByScore,
                AgeRatingTagsPosition = config.AgeRatingTagsPosition,
                LogoTagsEnabled = config.LogoTagsEnabled,
                LogoTagsPosition = config.LogoTagsPosition,
                CustomTagsEnabled = config.CustomTagsEnabled,
                CustomTagsPosition = config.CustomTagsPosition,
            };
            TagLayoutRules.ApplyDefaults(defaults, config);
            LanguageTagDisplay.ApplyDefaults(defaults, config);

            // SaveUserConfiguration writes nulls; GetUserConfiguration skips them on the way back,
            // so a null admin string comes back as the JellyfinEnhancedUserSettings initializer value.
            return JsonConvert.DeserializeObject<JellyfinEnhancedUserSettings>(JToken.FromObject(defaults).ToString(Formatting.None), LenientRead) ?? defaults;
        }

        private string ComputeDigest()
        {
            var values = new SortedDictionary<string, string>(StringComparer.Ordinal)
            {
                ["resolver.version"] = ResolverVersion,
                ["quality.enabled"] = Bool(QualityTagsEnabled),
                ["genre.enabled"] = Bool(GenreTagsEnabled),
                ["language.enabled"] = Bool(LanguageTagsEnabled),
                ["rating.enabled"] = Bool(RatingTagsEnabled),
                ["ageRating.enabled"] = Bool(AgeRatingTagsEnabled),
                ["status.enabled"] = Bool(StatusTagsEnabled),
                ["layout.bands"] = Bool(Bands),
                ["layout.compactBands"] = Bool(CompactBands),
                ["order"] = GroupOrder is null ? string.Empty : string.Join(",", GroupOrder.Where(g => (g != PosterTagGroup.Logos && g != PosterTagGroup.Custom) || Shows(g))),
            };

            if (AnyGroupEnabled)
            {
                values["tag.scale"] = TagScale;
                values["tag.gap"] = TagGap;
            }

            // A group set to "off" draws nothing, so (like a disabled group) its other values stay out.
            foreach (var group in OffGroups)
            {
                values[LayoutGroupId(group) + ".off"] = "1";
            }

            if (Shows(PosterTagGroup.Quality))
            {
                values["quality.position"] = QualityTagsPosition;
                values["quality.cap"] = Int(QualityCap);
                values["quality.show.resolution"] = Bool(ShowResolutionTag);
                values["quality.show.source"] = Bool(ShowSourceTag);
                values["quality.show.edition"] = Bool(ShowEditionTag);
                values["quality.order.edition"] = Int(EditionTagOrder);
                values["quality.show.lowQualitySource"] = Bool(ShowLowQualitySourceTag);
                values["quality.show.dynamicRange"] = Bool(ShowDynamicRangeTag);
                values["quality.show.specialFormat"] = Bool(ShowSpecialFormatTag);
                values["quality.show.videoCodec"] = Bool(ShowVideoCodecTag);
                values["quality.show.audioInfo"] = Bool(ShowAudioInfoTag);
                values["quality.order.resolution"] = Int(ResolutionTagOrder);
                values["quality.order.source"] = Int(SourceTagOrder);
                values["quality.order.dynamicRange"] = Int(DynamicRangeTagOrder);
                values["quality.order.specialFormat"] = Int(SpecialFormatTagOrder);
                values["quality.order.videoCodec"] = Int(VideoCodecTagOrder);
                values["quality.order.audioInfo"] = Int(AudioInfoTagOrder);
                values["quality.seriesAggregation"] = SeriesQualityAggregation;
                values["quality.audioLanguage"] = PreferredAudioLanguage ?? string.Empty;
                values["quality.registeredLate"] = Bool(UsesJellyfinAudioPreference);
            }

            if (Shows(PosterTagGroup.Genre))
            {
                values["genre.position"] = GenreTagsPosition;
                values["genre.cap"] = Int(GenreCap);
            }

            if (Shows(PosterTagGroup.Language))
            {
                values["language.position"] = LanguageTagsPosition;
                values["language.cap"] = Int(LanguageCap);
                values["language.audio"] = Bool(LanguageShowAudio);
                values["language.subtitles"] = Bool(LanguageShowSubtitles);
                values["language.style"] = LanguageStyle;
                values["language.countBadge"] = LanguageCountBadge;
                values["language.priority"] = string.Join(",", LanguagePriorityTerms);
                values["language.priorityStrict"] = Bool(LanguagePriorityStrict);
                // Canonical personal matching differs from the legacy server term matcher.
                // Omit the marker for inherited settings so their existing variant URLs stay stable.
                if (LanguagePriorityIsPersonal) values["language.personalPriority"] = "1";
                values["language.mergeRegions"] = Bool(LanguageMergeRegions);
            }

            if (Shows(PosterTagGroup.Rating))
            {
                values["rating.position"] = RatingTagsPosition;
                values["rating.cap"] = Int(RatingCap);
                values["rating.showCommunity"] = Bool(RatingTagsShowCommunity);
                values["rating.showCritic"] = Bool(RatingTagsShowCritic);
                values["rating.sources"] = RatingTagsSources == null ? "legacy" : string.Join(",", RatingTagsSources);
                values["rating.minimum"] = RatingTagsMinScore.ToString(CultureInfo.InvariantCulture);
                values["rating.color"] = Bool(RatingTagsColorByScore);
                values["rating.compact"] = Bool(RatingTagsCompact && RatingTagsSources?.Any(id => id is not ("community" or "critic")) == true);
                values["rating.onMovies"] = Bool(RatingTagsOnMovies);
                values["rating.onSeries"] = Bool(RatingTagsOnSeries);
                values["rating.onSeasons"] = Bool(RatingTagsOnSeasons);
                values["rating.onEpisodes"] = Bool(RatingTagsOnEpisodes);
                values["rating.userReviewChip"] = Bool(UserReviewChipEnabled);
                values["rating.userReviewDash"] = Bool(UserReviewChipEnabled && ShowUserRatingDash);
            }

            if (Shows(PosterTagGroup.AgeRating))
            {
                values["ageRating.position"] = AgeRatingTagsPosition;
                values["ageRating.cap"] = Int(AgeRatingCap);
            }

            if (Shows(PosterTagGroup.Awards))
            {
                values["awards.enabled"] = "1";
                values["awards.position"] = AwardsTagsPosition;
                values["awards.cap"] = Int(AwardsCap);
                values["awards.includes"] = $"{AwardsImdb},{AwardsCertifiedFresh},{AwardsOscar},{AwardsEmmy},{AwardsLetterboxd}";
            }
            if (Shows(PosterTagGroup.Status))
            {
                values["status.position"] = StatusTagsPosition;
                values["status.added"] = Bool(StatusJustAdded);
                values["status.new"] = Bool(StatusNewRelease);
                values["status.trending"] = Bool(StatusTrending);
                values["status.schedule"] = Bool(StatusSchedule);
                values["status.milestones"] = Bool(StatusMilestones);
                values["status.seriesStatus"] = Bool(StatusSeriesStatus);
                values["status.addedDays"] = Int(StatusJustAddedDays);
                values["status.newDays"] = Int(StatusNewReleaseDays);
                values["status.remote"] = Bool(StatusRemoteEnabled);
                // Only when on, so every existing variant keeps its token.
                if (StatusLeaving) values["status.leaving"] = Bool(StatusLeaving);
                values["status.locale"] = StatusCulture.Name;
                values["status.timeZone"] = StatusTimeZone.Id;
            }
            if (Shows(PosterTagGroup.Logos))
            {
                values["logos.enabled"] = "1";
                values["logos.position"] = LogoTagsPosition;
                values["logos.cap"] = Int(LogoCap);
            }
            if (Shows(PosterTagGroup.Custom))
            {
                values["custom.enabled"] = "1";
                values["custom.position"] = CustomTagsPosition;
                values["custom.cap"] = Int(CustomCap);
                values["custom.rules"] = string.Join("\n", CustomTagRules.Rules.Select((r, i) => CustomTagRules.Ids[i] + "=" + r.Label + "|" + r.Icon));
            }

            if (!Styles.IsEmpty)
            {
                values["style.overrides"] = Styles.Hash;
            }

            // Left out at the default, so every digest from before edge spacing stays the same.
            if (EdgeSpacing != "default")
            {
                values["layout.edge"] = EdgeSpacing;
            }

            var canonical = new StringBuilder(512);
            foreach (var (key, value) in values)
            {
                // Length-prefixed so no value can be confused with a separator.
                canonical.Append(key).Append('=').Append(value.Length.ToString(CultureInfo.InvariantCulture)).Append(':').Append(value).Append('\n');
            }

            Span<byte> hash = stackalloc byte[32];
            SHA256.HashData(Encoding.UTF8.GetBytes(canonical.ToString()), hash);
            return Convert.ToHexStringLower(hash[..8]);
        }

        private static string Bool(bool value) => value ? "1" : "0";

        private static string Int(int value) => value.ToString(CultureInfo.InvariantCulture);
    }
}
