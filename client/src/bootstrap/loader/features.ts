import type { JsonRecord, LoaderNamespace } from '../../host/bootstrap-pages-host';
import { isRecord } from './keys';

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

type Condition = (config: JsonRecord, settings: JsonRecord) => unknown;

/**
 * Stage 6, as data: [group, initializer, condition]. `group` is the component group whose modules
 * define the initializer (an id that is not in js/component-groups.json means "core"), `initializer`
 * its path on JE, and `condition(config, settings)` (JE.pluginConfig and JE.currentSettings) whether
 * to call it (omitted: always). The order is the order the calls have always run in: at boot every
 * entry of a loaded group runs in this order; a group loaded later runs its own entries, in this
 * order, right after its modules.
 */
export const FEATURE_INITIALIZERS: ReadonlyArray<readonly [group: string, path: string, condition?: Condition]> = [
    ['dashboard', 'initializePluginRevisions'],
    ['core', 'initializeEnhancedScript'],
    ['elsewhere', 'initializeElsewhereScript', c => c.ElsewhereEnabled],
    ['seerr', 'initializeJellyseerrScript', c => c.JellyseerrEnabled && c.JellyseerrShowSearchResults !== false],
    ['seerr', 'jellyseerrIssueReporter.initialize', c => c.JellyseerrEnabled && c.JellyseerrShowReportButton],
    ['player', 'initializePauseScreen'],
    ['bookmarks', 'initializeBookmarks'],
    ['tags', 'initializeQualityTags', (_c, s) => s.qualityTagsEnabled],
    ['tags', 'initializeGenreTags', (_c, s) => s.genreTagsEnabled],
    ['tags', 'initializeRatingTags', (_c, s) => s.ratingTagsEnabled],
    ['tags', 'initializeAgeRatingTags', (_c, s) => s.ageRatingTagsEnabled],
    ['tags', 'initializeStatusTags', (_c, s) => s.statusTagsEnabled],
    ['tags', 'initializeAwardsTags', (c, s) => s.awardsTagsEnabled && c.AwardsTagsEnabled !== false],
    ['tags', 'initializeCustomTags', (_c, s) => s.customTagsEnabled],
    ['tags', 'initializeTagStyles', c => c.TagStyleWebActive],
    ['tags', 'initializeUserReviewTags', (c, s) => c.ShowUserReviews && c.ShowUserRatingOnPosters && s.ratingTagsEnabled],
    ['arr-links', 'initializeArrLinksScript', c => c.ArrLinksEnabled],
    ['arr-tag-links', 'initializeArrTagLinksScript', c => c.ArrTagsShowAsLinks],
    ['seerr', 'initializeSeerrDetailLinkScript', c => c.JellyseerrEnabled && c.JellyseerrShowDetailPageLink],
    ['letterboxd', 'initializeLetterboxdLinksScript', c => c.LetterboxdEnabled],
    ['reviews', 'initializeReviewsScript', c => c.ShowReviews || c.ShowUserReviews || c.ShowAnilistReviews],
    ['awards', 'initializeAwardsScript', c => c.ShowAwards],
    ['content-warnings', 'initializeDoesTheDogDieScript', c => c.DoesTheDogDieEnabled],
    ['mdblist', 'initializeMdblistRatingsScript', c => c.MdblistRatingsEnabled && c.MdblistRatingsShowOnItemDetails],
    ['tags', 'initializeLanguageTags', (_c, s) => s.languageTagsEnabled],
    ['tags', 'initializeLogoTags', (_c, s) => s.logoTagsEnabled],
    ['tag-people', 'initializePeopleTags', (_c, s) => s.peopleTagsEnabled],
    // The unified tag pipeline initializes after all tag renderers have registered.
    ['tags', 'tagPipeline.initialize'],
    ['player', 'initializeOsdRating'],
    ['player-badge', 'initializePlaybackRatingBadge', c => c.ShowPlaybackRatingBadge],
    // Disabled server-wide, JE.hiddenContent stays undefined, safely disabling all downstream consumers.
    ['hidden-content', 'initializeHiddenContent', c => c.HiddenContentEnabled],
    // Spoiler Guard loads its per-user enabled-series list once at startup.
    ['spoiler-guard', 'spoilerBlur.init', c => c.SpoilerBlurEnabled],
    ['core', 'initializeColoredRatings', c => c.ColoredRatingsEnabled],
    ['theme-selector', 'initializeThemeSelector', c => c.ThemeSelectorEnabled],
    ['dashboard', 'initializeActivityIcons', c => c.ColoredActivityIconsEnabled],
    ['dashboard', 'initializePluginIcons', c => c.PluginIconsEnabled],
    ['active-streams', 'activeStreams.initialize', c => c.ActiveStreamsEnabled],
    ['requests-page', 'initializeDownloadsPage', c => c.DownloadsPageEnabled],
    ['calendar-page', 'initializeCalendarPage', c => c.CalendarPageEnabled],
    ['hidden-content-page', 'initializeHiddenContentPage', c => c.HiddenContentEnabled],
    // Seerr search used to make this check as it started, on every page: it caches the user's Seerr
    // status for the session and shows the one-time "not linked / unreachable" notice. Search now loads
    // on its own pages, so the check is made here, at the same moment as before.
    ['seerr-api', 'jellyseerrAPI.checkUserStatus', c => c.JellyseerrEnabled && c.JellyseerrShowSearchResults !== false]
];

/** A function a lazy export's stand-in replaces until its group has loaded (group-triggers.ts). */
export const lazyGroupOf = (value: unknown): string | undefined =>
    typeof value === 'function' && 'jeLazyGroup' in value && typeof value.jeLazyGroup === 'string' ? value.jeLazyGroup : undefined;

/** Read a dotted path on JE ("jellyseerrIssueReporter.initialize"): the value and the object it sits on. */
export function readExport(JE: object, path: string): { owner: unknown; value: unknown } {
    const parts = path.split('.');
    const name = parts.pop() ?? '';
    let owner: unknown = JE;
    for (const part of parts) owner = isRecord(owner) || typeof owner === 'function' ? Reflect.get(owner, part) : undefined;
    return { owner, value: isRecord(owner) || typeof owner === 'function' ? Reflect.get(owner, name) : undefined };
}

/**
 * Whether any stage-6 initializer of a group would run with the current config and settings. A group
 * whose features all start through stage 6 has nothing to do while this is false, so it is not loaded.
 */
export function groupHasEnabledFeature(JE: LoaderNamespace, id: string): boolean {
    const config = JE.pluginConfig || {};
    const settings = JE.currentSettings || {};
    return FEATURE_INITIALIZERS.some(([group, , condition]) => group === id && (!condition || !!condition(config, settings)));
}

/**
 * Stage 6 for the given groups, whose modules have just run: their initializers in FEATURE_INITIALIZERS
 * order, each under its condition (read from live state) and only when its module defined it. `known`
 * says whether an id is a group of this page load; an initializer of any other group belongs to "core".
 */
export function initializeGroupFeatures(JE: LoaderNamespace, ids: readonly string[], known: (id: string) => boolean): void {
    const config = JE.pluginConfig || {};
    const settings = JE.currentSettings || {};
    for (const [group, path, condition] of FEATURE_INITIALIZERS) {
        if (!ids.includes(known(group) ? group : 'core')) continue;
        if (condition && !condition(config, settings)) continue;
        const { owner, value } = readExport(JE, path);
        if (typeof value === 'function' && !lazyGroupOf(value)) Reflect.apply(value, owner, []);
    }
}
