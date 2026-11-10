import type { LoaderNamespace } from '../../host/bootstrap-pages-host';

const reinitialize = (hook: (() => void) | undefined, enabled: unknown, run: () => void): void => {
    if (enabled && typeof hook === 'function') run();
};

/**
 * Per-user tag toggles can differ between users, and the boot-time conditional
 * initialization only ran for the first user. These initializers are idempotent, so
 * re-run whichever the incoming user has enabled; renderers whose toggle is now off
 * stop via their isEnabled gate and the pipeline invalidation removes stale overlays.
 */
export function reinitializeUserTags(JE: LoaderNamespace): void {
    const settings = JE.currentSettings;
    reinitialize(JE.initializeQualityTags, settings?.qualityTagsEnabled, () => JE.initializeQualityTags?.());
    reinitialize(JE.initializeGenreTags, settings?.genreTagsEnabled, () => JE.initializeGenreTags?.());
    reinitialize(JE.initializeRatingTags, settings?.ratingTagsEnabled, () => JE.initializeRatingTags?.());
    reinitialize(JE.initializeAgeRatingTags, settings?.ageRatingTagsEnabled, () => JE.initializeAgeRatingTags?.());
    reinitialize(JE.initializeStatusTags, settings?.statusTagsEnabled, () => JE.initializeStatusTags?.());
    reinitialize(JE.initializeAwardsTags, settings?.awardsTagsEnabled && JE.pluginConfig?.AwardsTagsEnabled !== false, () => JE.initializeAwardsTags?.());
    reinitialize(JE.initializeCustomTags, settings?.customTagsEnabled, () => JE.initializeCustomTags?.());
    reinitialize(JE.initializeLanguageTags, settings?.languageTagsEnabled, () => JE.initializeLanguageTags?.());
    reinitialize(JE.initializeLogoTags, settings?.logoTagsEnabled, () => JE.initializeLogoTags?.());
}

/** Stage 6. Conditions read live state; the order is the module dependency order. */
export function initializeFeatures(JE: LoaderNamespace): void {
    const config = () => JE.pluginConfig;
    const settings = () => JE.currentSettings;
    if (typeof JE.initializePluginRevisions === 'function') JE.initializePluginRevisions();
    if (typeof JE.initializeEnhancedScript === 'function') JE.initializeEnhancedScript();
    if (typeof JE.initializeElsewhereScript === 'function' && config().ElsewhereEnabled) JE.initializeElsewhereScript();
    if (typeof JE.initializeJellyseerrScript === 'function' && config().JellyseerrEnabled && config().JellyseerrShowSearchResults !== false) JE.initializeJellyseerrScript();
    if (typeof JE.jellyseerrIssueReporter?.initialize === 'function' && config().JellyseerrEnabled && config().JellyseerrShowReportButton) JE.jellyseerrIssueReporter.initialize();
    if (typeof JE.initializePauseScreen === 'function') JE.initializePauseScreen();
    if (typeof JE.initializeBookmarks === 'function') JE.initializeBookmarks();
    if (typeof JE.initializeQualityTags === 'function' && settings()?.qualityTagsEnabled) JE.initializeQualityTags();
    if (typeof JE.initializeGenreTags === 'function' && settings()?.genreTagsEnabled) JE.initializeGenreTags();
    if (typeof JE.initializeRatingTags === 'function' && settings()?.ratingTagsEnabled) JE.initializeRatingTags();
    if (typeof JE.initializeAgeRatingTags === 'function' && settings()?.ageRatingTagsEnabled) JE.initializeAgeRatingTags();
    if (typeof JE.initializeStatusTags === 'function' && settings()?.statusTagsEnabled) JE.initializeStatusTags();
    if (typeof JE.initializeAwardsTags === 'function' && settings()?.awardsTagsEnabled && config().AwardsTagsEnabled !== false) JE.initializeAwardsTags();
    if (typeof JE.initializeCustomTags === 'function' && settings()?.customTagsEnabled) JE.initializeCustomTags();
    if (typeof JE.initializeTagStyles === 'function' && config().TagStyleWebActive) JE.initializeTagStyles();
    if (typeof JE.initializeUserReviewTags === 'function' && config().ShowUserReviews && config().ShowUserRatingOnPosters && settings()?.ratingTagsEnabled) JE.initializeUserReviewTags();
    if (typeof JE.initializeArrLinksScript === 'function' && config().ArrLinksEnabled) JE.initializeArrLinksScript();
    if (typeof JE.initializeArrTagLinksScript === 'function' && config().ArrTagsShowAsLinks) JE.initializeArrTagLinksScript();
    if (typeof JE.initializeSeerrDetailLinkScript === 'function' && config().JellyseerrEnabled && config().JellyseerrShowDetailPageLink) JE.initializeSeerrDetailLinkScript();
    if (typeof JE.initializeLetterboxdLinksScript === 'function' && config().LetterboxdEnabled) JE.initializeLetterboxdLinksScript();
    if (typeof JE.initializeReviewsScript === 'function' && (config().ShowReviews || config().ShowUserReviews || config().ShowAnilistReviews)) JE.initializeReviewsScript();
    if (typeof JE.initializeAwardsScript === 'function' && config().ShowAwards) JE.initializeAwardsScript();
    if (typeof JE.initializeDoesTheDogDieScript === 'function' && config().DoesTheDogDieEnabled) JE.initializeDoesTheDogDieScript();
    if (typeof JE.initializeMdblistRatingsScript === 'function' && config().MdblistRatingsEnabled && config().MdblistRatingsShowOnItemDetails) JE.initializeMdblistRatingsScript();
    if (typeof JE.initializeLanguageTags === 'function' && settings()?.languageTagsEnabled) JE.initializeLanguageTags();
    if (typeof JE.initializeLogoTags === 'function' && settings()?.logoTagsEnabled) JE.initializeLogoTags();
    if (typeof JE.initializePeopleTags === 'function' && settings()?.peopleTagsEnabled) JE.initializePeopleTags();
    // The unified tag pipeline initializes after all tag renderers have registered.
    if (typeof JE.tagPipeline?.initialize === 'function') JE.tagPipeline.initialize();
    if (typeof JE.initializeOsdRating === 'function') JE.initializeOsdRating();
    if (typeof JE.initializePlaybackRatingBadge === 'function' && config().ShowPlaybackRatingBadge) JE.initializePlaybackRatingBadge();
    // Disabled server-wide, JE.hiddenContent stays undefined, safely disabling all downstream consumers.
    if (typeof JE.initializeHiddenContent === 'function' && config().HiddenContentEnabled) JE.initializeHiddenContent();
    // Spoiler Guard loads its per-user enabled-series list once at startup.
    if (config().SpoilerBlurEnabled && typeof JE.spoilerBlur?.init === 'function') JE.spoilerBlur.init();
    if (config().ColoredRatingsEnabled && typeof JE.initializeColoredRatings === 'function') JE.initializeColoredRatings();
    if (config().ThemeSelectorEnabled && typeof JE.initializeThemeSelector === 'function') JE.initializeThemeSelector();
    if (config().ColoredActivityIconsEnabled && typeof JE.initializeActivityIcons === 'function') JE.initializeActivityIcons();
    if (config().PluginIconsEnabled && typeof JE.initializePluginIcons === 'function') JE.initializePluginIcons();
    if (config().ActiveStreamsEnabled && typeof JE.activeStreams?.initialize === 'function') JE.activeStreams.initialize();
    if (config().DownloadsPageEnabled && typeof JE.initializeDownloadsPage === 'function') JE.initializeDownloadsPage();
    if (config().CalendarPageEnabled && typeof JE.initializeCalendarPage === 'function') JE.initializeCalendarPage();
    if (config().HiddenContentEnabled && typeof JE.initializeHiddenContentPage === 'function') JE.initializeHiddenContentPage();
}
