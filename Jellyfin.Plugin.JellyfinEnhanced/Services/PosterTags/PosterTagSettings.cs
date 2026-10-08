using System;
using System.Collections.Generic;
using System.Globalization;
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
    /// The effective poster tag settings of one user: every value the five card tag groups read,
    /// resolved exactly as the web resolves them.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The web's view of a user's settings is <c>GET user-settings/{id}/settings.json</c>: the file
    /// deserialized into <see cref="UserSettings"/> (Newtonsoft, case-insensitive keys, JSON nulls
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
        public const string ResolverVersion = "3";

        private static readonly JsonSerializerSettings LenientRead = new() { NullValueHandling = NullValueHandling.Ignore };

        private PosterTagSettings()
        {
        }

        /// <summary>Master switch and the user's preference: <c>NativePosterTagsEnabled &amp;&amp; useNativePosterTags != false</c>.</summary>
        public bool NativeEnabled { get; private init; }

        /// <summary>The user's effective <c>useNativePosterTags</c> (on unless the user switched it off).</summary>
        public bool UseNativePosterTags { get; private init; }

        /// <summary>True when at least one of the five card tag groups is on.</summary>
        public bool AnyGroupEnabled => QualityTagsEnabled || GenreTagsEnabled || LanguageTagsEnabled || RatingTagsEnabled || AgeRatingTagsEnabled;

        /// <summary>
        /// Stable lowercase hex hash (16 characters) over every rendering-relevant effective value,
        /// including admin-only keys and <see cref="ResolverVersion"/>. Values of disabled groups are
        /// left out so changing them does not invalidate cached posters.
        /// </summary>
        public string Digest { get; private init; } = string.Empty;

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

        /// <summary>Quality position string as the web resolves it (user, else admin, else "top-left").</summary>
        public string QualityTagsPosition { get; private init; } = "top-left";

        /// <summary>Genre position string (default "top-right").</summary>
        public string GenreTagsPosition { get; private init; } = "top-right";

        /// <summary>Language position string (default "bottom-left").</summary>
        public string LanguageTagsPosition { get; private init; } = "bottom-left";

        /// <summary>Rating position string, also used by the user-review chip (default "bottom-right").</summary>
        public string RatingTagsPosition { get; private init; } = "bottom-right";

        /// <summary>Age rating position string (default "bottom-right").</summary>
        public string AgeRatingTagsPosition { get; private init; } = "bottom-right";

        /// <summary>Effective <c>showResolutionTag</c>.</summary>
        public bool ShowResolutionTag { get; private init; } = true;

        /// <summary>Effective <c>showSourceTag</c>.</summary>
        public bool ShowSourceTag { get; private init; } = true;

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

        /// <summary>Admin <c>LanguageTagsPriority</c> as the web's lowercase term list.</summary>
        public IReadOnlyList<string> LanguagePriorityTerms { get; private init; } = Array.Empty<string>();

        /// <summary>Admin <c>LanguageTagsPriorityStrict</c>.</summary>
        public bool LanguagePriorityStrict { get; private init; }

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
            (QualityTagsEnabled && IsTopRight(QualityTagsPosition))
            || (GenreTagsEnabled && IsTopRight(GenreTagsPosition))
            || (RatingTagsEnabled && IsTopRight(RatingTagsPosition))
            || (AgeRatingTagsEnabled && IsTopRight(AgeRatingTagsPosition))
            || (LanguageTagsEnabled && IsTopRight(LanguageTagsPosition));

        /// <summary>Whether the user-review chip can appear: reviews, posters chip and rating tags all on.</summary>
        public bool UserReviewChipEnabled => ShowUserReviews && ShowUserRatingOnPosters && RatingTagsEnabled;

        /// <summary>
        /// Builds the effective settings from the text of the user's settings.json, read exactly as
        /// the server reads it for the web (<c>UserConfigurationManager.GetUserConfiguration&lt;UserSettings&gt;</c>:
        /// Newtonsoft with its lenient syntax, case-insensitive keys, last duplicate key wins, JSON
        /// nulls skipped; empty, whitespace-only, <c>null</c>, non-object or unparseable content gives
        /// the <see cref="UserSettings"/> defaults). Prefer this over <see cref="Create"/>, which can
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
        /// unreadable (the web then sees the <see cref="UserSettings"/> defaults). camelCase and
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
            UserSettings? parsed = null;
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

        /// <summary>UserConfigurationManager.GetUserConfiguration&lt;UserSettings&gt; for an existing file's text.</summary>
        private static UserSettings ReadAsServer(string json)
        {
            if (string.IsNullOrWhiteSpace(json)) return new UserSettings();
            try
            {
                return JsonConvert.DeserializeObject<UserSettings>(json, LenientRead) ?? new UserSettings();
            }
            catch (Exception)
            {
                // The server returns the defaults on any read error.
                return new UserSettings();
            }
        }

        /// <summary>
        /// Builds the effective settings from the user's settings as the server reads them
        /// (<c>UserConfigurationManager.GetUserConfiguration&lt;UserSettings&gt;</c>).
        /// </summary>
        /// <param name="userSettings">The user's settings, or null when the user has no settings.json yet.</param>
        /// <param name="config">The plugin configuration.</param>
        /// <param name="jellyfinAudioLanguagePreference">The user's Jellyfin audio language preference.</param>
        /// <returns>The effective settings.</returns>
        public static PosterTagSettings FromUserSettings(UserSettings? userSettings, PluginConfiguration config, string? jellyfinAudioLanguagePreference = null)
        {
            ArgumentNullException.ThrowIfNull(config);
            var user = userSettings ?? DefaultsAsWritten(config);

            var preferredChoice = user.QualityTagsPreferredAudioLanguage ?? string.Empty;
            var (preferred, usesJellyfin) = ResolvePreferredAudioLanguage(preferredChoice, config, jellyfinAudioLanguagePreference);
            var useNative = user.UseNativePosterTags != false;

            var settings = new PosterTagSettings
            {
                UseNativePosterTags = useNative,
                NativeEnabled = config.NativePosterTagsEnabled && useNative,
                QualityTagsEnabled = user.QualityTagsEnabled,
                GenreTagsEnabled = user.GenreTagsEnabled,
                LanguageTagsEnabled = user.LanguageTagsEnabled,
                RatingTagsEnabled = user.RatingTagsEnabled,
                AgeRatingTagsEnabled = user.AgeRatingTagsEnabled,
                QualityTagsPosition = Position(user.QualityTagsPosition, config.QualityTagsPosition, "top-left"),
                GenreTagsPosition = Position(user.GenreTagsPosition, config.GenreTagsPosition, "top-right"),
                LanguageTagsPosition = Position(user.LanguageTagsPosition, config.LanguageTagsPosition, "bottom-left"),
                RatingTagsPosition = Position(user.RatingTagsPosition, config.RatingTagsPosition, "bottom-right"),
                AgeRatingTagsPosition = Position(user.AgeRatingTagsPosition, config.AgeRatingTagsPosition, "bottom-right"),
                ShowResolutionTag = user.ShowResolutionTag,
                ShowSourceTag = user.ShowSourceTag,
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
                PreferredAudioLanguage = preferred,
                UsesJellyfinAudioPreference = usesJellyfin,
                RatingTagsOnMovies = user.RatingTagsOnMovies,
                RatingTagsOnSeries = user.RatingTagsOnSeries,
                RatingTagsOnSeasons = user.RatingTagsOnSeasons,
                RatingTagsOnEpisodes = user.RatingTagsOnEpisodes,
                RatingTagsOnContinueWatching = user.RatingTagsOnContinueWatching,
                RatingTagsOnNextUp = user.RatingTagsOnNextUp,
                LanguagePriorityTerms = LanguageFlagRules.ParsePriorityTerms(config.LanguageTagsPriority),
                LanguagePriorityStrict = config.LanguageTagsPriorityStrict,
                ShowUserReviews = config.ShowUserReviews,
                ShowUserRatingOnPosters = config.ShowUserRatingOnPosters,
                ShowUserRatingDash = config.ShowUserRatingDash,
            };

            return settings with { Digest = settings.ComputeDigest() };
        }

        /// <summary>The corner a position string selects (the web only tests for "top" and "left").</summary>
        /// <param name="position">A position string such as "top-right".</param>
        /// <returns>The corner.</returns>
        public static PosterTagCorner CornerOf(string position)
        {
            var isTop = position.Contains("top", StringComparison.Ordinal);
            var isLeft = position.Contains("left", StringComparison.Ordinal);
            return isTop
                ? (isLeft ? PosterTagCorner.TopLeft : PosterTagCorner.TopRight)
                : (isLeft ? PosterTagCorner.BottomLeft : PosterTagCorner.BottomRight);
        }

        /// <summary>The effective position string of a group.</summary>
        /// <param name="group">The tag group.</param>
        /// <returns>The position string.</returns>
        public string PositionOf(PosterTagGroup group) => group switch
        {
            PosterTagGroup.Quality => QualityTagsPosition,
            PosterTagGroup.Genre => GenreTagsPosition,
            PosterTagGroup.Rating => RatingTagsPosition,
            PosterTagGroup.AgeRating => AgeRatingTagsPosition,
            _ => LanguageTagsPosition,
        };

        /// <summary>Whether a quality category (model key) is shown.</summary>
        internal bool IsQualityCategoryShown(string category) => category switch
        {
            QualityTagRules.Resolution => ShowResolutionTag,
            QualityTagRules.Source => ShowSourceTag,
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
        private static UserSettings DefaultsAsWritten(PluginConfiguration config)
        {
            var defaults = new UserSettings
            {
                UseNativePosterTags = null,
                QualityTagsEnabled = config.QualityTagsEnabled,
                ShowResolutionTag = config.ShowResolutionTag,
                ShowSourceTag = config.ShowSourceTag,
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
                PeopleTagsEnabled = config.PeopleTagsEnabled,
                QualityTagsPosition = config.QualityTagsPosition,
                GenreTagsPosition = config.GenreTagsPosition,
                LanguageTagsPosition = config.LanguageTagsPosition,
                RatingTagsPosition = config.RatingTagsPosition,
                RatingTagsOnMovies = config.RatingTagsOnMovies,
                RatingTagsOnSeries = config.RatingTagsOnSeries,
                RatingTagsOnSeasons = config.RatingTagsOnSeasons,
                RatingTagsOnEpisodes = config.RatingTagsOnEpisodes,
                RatingTagsOnContinueWatching = config.RatingTagsOnContinueWatching,
                RatingTagsOnNextUp = config.RatingTagsOnNextUp,
                AgeRatingTagsPosition = config.AgeRatingTagsPosition,
            };

            // SaveUserConfiguration writes nulls; GetUserConfiguration skips them on the way back,
            // so a null admin string comes back as the UserSettings initializer value.
            return JsonConvert.DeserializeObject<UserSettings>(JToken.FromObject(defaults).ToString(Formatting.None), LenientRead) ?? defaults;
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
            };

            if (QualityTagsEnabled)
            {
                values["quality.position"] = QualityTagsPosition;
                values["quality.show.resolution"] = Bool(ShowResolutionTag);
                values["quality.show.source"] = Bool(ShowSourceTag);
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
                values["quality.audioLanguage"] = PreferredAudioLanguage ?? string.Empty;
                values["quality.registeredLate"] = Bool(UsesJellyfinAudioPreference);
            }

            if (GenreTagsEnabled)
            {
                values["genre.position"] = GenreTagsPosition;
            }

            if (LanguageTagsEnabled)
            {
                values["language.position"] = LanguageTagsPosition;
                values["language.priority"] = string.Join(",", LanguagePriorityTerms);
                values["language.priorityStrict"] = Bool(LanguagePriorityStrict);
            }

            if (RatingTagsEnabled)
            {
                values["rating.position"] = RatingTagsPosition;
                values["rating.onMovies"] = Bool(RatingTagsOnMovies);
                values["rating.onSeries"] = Bool(RatingTagsOnSeries);
                values["rating.onSeasons"] = Bool(RatingTagsOnSeasons);
                values["rating.onEpisodes"] = Bool(RatingTagsOnEpisodes);
                values["rating.userReviewChip"] = Bool(UserReviewChipEnabled);
                values["rating.userReviewDash"] = Bool(UserReviewChipEnabled && ShowUserRatingDash);
            }

            if (AgeRatingTagsEnabled)
            {
                values["ageRating.position"] = AgeRatingTagsPosition;
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
