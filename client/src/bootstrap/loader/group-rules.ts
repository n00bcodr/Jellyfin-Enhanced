import type { JsonRecord, LoaderNamespace } from '../../host/bootstrap-pages-host';
import { groupHasEnabledFeature } from './features';

// When each component group is needed (js/component-groups.json says what is in it). "core" is always
// needed; a group in the file without a rule here loads at boot.

/** The route the address shows, as the rules read it. */
export interface Route {
    /** The router path in lower case without a leading slash or ".html": "home", "details", "video", "dashboard/activity". */
    path: string;
    /** What follows the path. */
    query: string;
}

export function currentRoute(): Route {
    const hash = String(window.location.hash || '').replace(/^#!?\/?/, '');
    const at = hash.search(/[?#]/);
    const path = (at < 0 ? hash : hash.slice(0, at)).toLowerCase().replace(/\.html$/, '').replace(/\/+$/, '');
    return { path, query: at < 0 ? '' : hash.slice(at + 1) };
}

/** decodeURIComponent that returns its input when it is not valid. */
function safeDecode(text: string): string {
    try { return decodeURIComponent(text); } catch { return text; }
}

/**
 * JE's own pages. Each can be delivered as a tab on Home (JE's own tab, or one the Custom Tabs plugin
 * provides), by the Plugin Pages plugin, or, for the pages with `routes`, standalone behind a sidebar
 * link at its own address. `tab` is the Home tab JE registers for the page ([id, title key, fallback
 * title, icon]: exactly what the page's own custom-tab module registers), `marker` the class of the
 * placeholder a tab holds for it, `pluginPage` the page's Plugin Pages address (lower case). The order is
 * the order the tabs are registered in, which is the order they appear in: the order the pages' own
 * modules register them in the single bundle.
 */
export interface FeaturePage {
    group: string; flag: string; delivery: string;
    tab: readonly [id: string, titleKey: string | null, fallbackTitle: string | undefined, icon: string];
    marker: string; routes?: readonly string[]; pluginPage: string;
}
export const FEATURE_PAGES: readonly FeaturePage[] = [
    { group: 'hidden-content-page', flag: 'HiddenContentEnabled', delivery: 'HiddenContent', tab: ['hidden-content', 'hidden_content_manage_title', 'Hidden Content', 'remove_red_eye'], marker: 'jellyfinenhanced hidden-content', routes: ['hidden-content'], pluginPage: 'hiddencontentpage' },
    { group: 'catchup', flag: 'CatchUpEnabled', delivery: 'CatchUp', tab: ['catchup', 'catchup_title', 'Catch Up', 'style'], marker: 'jellyfinenhanced catchup', pluginPage: 'catchuppage' },
    { group: 'recommendations', flag: 'RecommendationsPageEnabled', delivery: 'Recommendations', tab: ['recommendations', 'recommendations_title', undefined, 'auto_awesome'], marker: 'jellyfinenhanced recommendations', routes: ['recommendations'], pluginPage: 'recommendationspage' },
    { group: 'requests-page', flag: 'DownloadsPageEnabled', delivery: 'Downloads', tab: ['requests', 'requests_requests', 'Requests', 'download'], marker: 'jellyfinenhanced requests', routes: ['downloads'], pluginPage: 'downloadspage' },
    { group: 'calendar-page', flag: 'CalendarPageEnabled', delivery: 'Calendar', tab: ['calendar', 'calendar_title', 'Calendar', 'calendar_month'], marker: 'jellyfinenhanced calendar', routes: ['calendar'], pluginPage: 'calendarpage' },
    { group: 'activity-page', flag: 'ActivityFeedEnabled', delivery: 'ActivityFeed', tab: ['activity', 'activity_title', 'Activity', 'history'], marker: 'jellyfinenhanced activity', pluginPage: 'activitypage' },
    // The Leaving Soon page ships in the item menu's output in this tree (js/tags/tag-item-menu.js), which is in the
    // tags group: upstream's leavingsoon-page group has no module here.
    { group: 'tags', flag: 'LeavingSoonPageEnabled', delivery: 'LeavingSoonPage', tab: ['leavingsoon', 'leavingsoon_title', 'Leaving Soon', 'auto_delete'], marker: 'jellyfinenhanced leavingsoon', pluginPage: 'leavingsoonpage' },
    // Last: the Bookmarks library registers its tab from a timer once its data is ready, after the others.
    { group: 'bookmarks-library', flag: 'BookmarksEnabled', delivery: 'Bookmarks', tab: ['bookmarks', null, 'Bookmarks', 'location_on'], marker: 'sections bookmarks', routes: ['bookmarks'], pluginPage: 'bookmarkspage' }
];
export const markerSelector = (page: FeaturePage): string => `.${page.marker.split(' ').join('.')}`;

/** A rule: see {@link createGroupRules}. */
export interface GroupRule {
    /** Asked at boot, after every navigation, when a tab or video appears and after a user switch. The group loads the first time it answers true, and then stays loaded. */
    needed?: (route: Route) => boolean;
    /** Groups to load along with it that it is not "after" in js/component-groups.json, because the need depends on the config or the group works without them. */
    with?: () => string[];
    /** JE functions (dotted paths) that load the group when called before it is loaded, then make the call. */
    exports?: readonly string[];
}

/** The nine poster tag types: any of them on means cards carry JE tags. */
const POSTER_TAG_SETTINGS = ['qualityTagsEnabled', 'genreTagsEnabled', 'ratingTagsEnabled', 'ageRatingTagsEnabled', 'statusTagsEnabled',
    'awardsTagsEnabled', 'customTagsEnabled', 'languageTagsEnabled', 'logoTagsEnabled'] as const;

const isHomeRoute = (route: Route): boolean => route.path === '' || route.path === 'home';
const isDetailsRoute = (route: Route): boolean => route.path === 'details';
const isVideoRoute = (route: Route): boolean => route.path === 'video';
const isDashboardRoute = (route: Route): boolean => /^(dashboard|configurationpage|settings)(\/|$)/.test(route.path);
/** Whether the address is the plugin's own admin configuration page (or its old Media Tags address). */
const isOwnConfigPage = (route: Route): boolean => route.path === 'configurationpage' && /jellyfin[\s+_.-]*enhanced/i.test(safeDecode(route.query));
const isSeerrRoute = (route: Route): boolean => isDetailsRoute(route) || route.path === 'list' || route.path === 'search';

export type GroupRules = ReturnType<typeof createGroupRules>;

/** The rules, over the live namespace. `known(id)`: whether a group exists in this page load. */
export function createGroupRules(JE: LoaderNamespace) {
    const config = (): JsonRecord => JE.pluginConfig || {};
    // Set once a <video> starts loading or playing anywhere (group-triggers.ts): playback can begin
    // before the address changes to the video page.
    let videoSeen = false;

    /**
     * A personal boolean setting as JE.loadSettings resolves it: the user's saved value, else the
     * administrator's default, else off. The rules use it for the first plan, which runs before
     * enhanced/config.js (which owns JE.loadSettings) has been loaded; once JE.currentSettings exists it
     * is read instead, and the plan is made again.
     */
    function userSetting(key: string): boolean {
        const current = JE.currentSettings;
        if (current && Object.prototype.hasOwnProperty.call(current, key)) return current[key] === true;
        const saved = JE.userConfig?.settings ? JE.userConfig.settings[key] : undefined;
        if (typeof saved === 'boolean') return saved;
        const settings = config();
        const fallback = settings[key] !== null && settings[key] !== undefined ? settings[key] : settings[key.charAt(0).toUpperCase() + key.slice(1)];
        return fallback === true;
    }
    const posterTagsOn = (): boolean => POSTER_TAG_SETTINGS.some(userSetting);
    const playerWanted = (route: Route): boolean => videoSeen || isVideoRoute(route);
    /** Whether a page is delivered as a Home tab (JE's own or the Custom Tabs plugin's). */
    const isTabbedPage = (page: FeaturePage): boolean => !!(config()[`${page.delivery}UseNativeTab`] || config()[`${page.delivery}UseCustomTabs`]);

    /**
     * Whether one of JE's pages has to be loaded now: it is enabled and either it is delivered standalone
     * (its own start-up adds the sidebar link and takes over its address, so it loads at boot as it always
     * has), or the address is the page's own, or its Plugin Pages address, or names its Home tab, or the
     * tab holding its placeholder is the active one.
     */
    function pageNeeded(page: FeaturePage, route: Route): boolean {
        if (!config()[page.flag]) return false;
        if (page.routes && !isTabbedPage(page)) return true;
        if (page.routes?.includes(route.path)) return true;
        if (route.path.startsWith('userpluginsettings')) {
            // Plugin Pages shows the page at an address that carries its URL (/JellyfinEnhanced/calendarPage).
            // An address that names none of JE's pages is one this code does not know how to read: load them all.
            const address = safeDecode(route.query).toLowerCase();
            return address.includes('jellyfinenhanced/') ? address.includes(`jellyfinenhanced/${page.pluginPage}`) : true;
        }
        if (isHomeRoute(route)) {
            const query = safeDecode(route.query);
            if (new RegExp(`(^|[?&#])jeTab=${page.tab[0]}(&|#|$)`).test(query)) return true;
            // A Recommendations category opens over Home whichever tab is shown.
            if (page.group === 'recommendations' && /(^|[?&#])jeCategory=/.test(query)) return true;
        }
        const isActive = JE.helpers?.isActiveTabContainer;
        return typeof isActive === 'function'
            && Array.from(document.querySelectorAll(markerSelector(page))).some(element => isActive(element));
    }
    const pageRule = (group: string) => (route: Route): boolean => FEATURE_PAGES.some(page => page.group === group && pageNeeded(page, route));
    /** A group all of whose features start through stage 6, on details pages only. */
    const onDetails = (group: string) => (route: Route): boolean => isDetailsRoute(route) && groupHasEnabledFeature(JE, group);
    const removalOffered = (): boolean => config().MaintainerrActionsAvailable === true || config().RemovalRequestsAvailable === true;

    const FEATURE_GROUPS: Readonly<Record<string, GroupRule>> = {
        // Poster tags are on every card surface, so they load at boot, but only when the user has a tag type
        // on. The settings panel is "after" every tag group, so switching a type on there finds its code
        // loaded. This tree's js/tags/tag-item-menu.js (in this group) also carries upstream's removal-menu
        // module (Maintainerr / removal-request rows, whose item-menu hook has to see the first menu that opens,
        // so with removal rows it loads at boot) and its leavingsoon-page modules (the Leaving Soon page and
        // tab): the group loads wherever upstream loads any of the three.
        'tags': { needed: route => posterTagsOn() || removalOffered() || pageRule('tags')(route) },
        'tag-direct-play': { needed: () => posterTagsOn() && userSetting('statusTagsEnabled') && userSetting('statusTagsDirectPlay') },
        'tag-poster-colours': { needed: () => posterTagsOn() && !!config().TagStyleWebActive },
        // Asked for by tags/statustags.js when the first status tag is drawn (JE.loader.ensure), never at boot.
        'tag-status-backdrop': { needed: () => false },
        'tag-people': { needed: route => isDetailsRoute(route) && userSetting('peopleTagsEnabled') },
        // Both act before content paints, so they are never deferred.
        'spoiler-guard': { needed: () => !!config().SpoilerBlurEnabled },
        'hidden-content': { needed: () => !!config().HiddenContentEnabled },
        'details': { needed: isDetailsRoute },
        'player': {
            needed: playerWanted,
            // The player shortcuts (enhanced/events.js): one pressed while the group is still arriving is
            // carried out when it has.
            exports: ['cycleAspect', 'togglePlaybackInfo', 'cycleSubtitleTrack', 'cycleAudioTrack', 'resetPlaybackSpeed', 'adjustPlaybackSpeed',
                'skipIntroOutro', 'frameStep', 'adjustSubtitleOffset', 'jumpToLastPosition', 'jumpToPercentage', 'toggleSubtitleSync']
        },
        // Listens for the first "playing" event, which can come before the video page.
        'player-badge': { needed: () => !!config().ShowPlaybackRatingBadge },
        'bookmarks': { needed: route => !!config().BookmarksEnabled && playerWanted(route) },
        'bookmarks-library': { needed: pageRule('bookmarks-library') },
        'hidden-content-page': { needed: pageRule('hidden-content-page') },
        'catchup': { needed: pageRule('catchup') },
        'settings': {
            // The admin page's Media Tags tab draws with the panel's preview and editors.
            needed: isOwnConfigPage,
            // The panel's "Manage hidden content" asks the page, synchronously, whether it can show itself.
            with: () => (config().HiddenContentEnabled ? ['hidden-content-page'] : []),
            exports: ['showEnhancedPanel']
        },
        'elsewhere': { needed: onDetails('elsewhere') },
        'reviews': { needed: onDetails('reviews') },
        'awards': { needed: onDetails('awards') },
        'mdblist': { needed: onDetails('mdblist') },
        'content-warnings': { needed: onDetails('content-warnings') },
        'letterboxd': { needed: onDetails('letterboxd') },
        'arr-tag-links': { needed: onDetails('arr-tag-links') },
        // Administrators only (its start-up checks), and it reports a broken Sonarr/Radarr setup as it
        // starts, so it keeps starting at boot.
        'arr-links': { needed: () => !!config().ArrLinksEnabled && userSetting('isAdmin') },
        'seerr-api': { needed: () => !!config().JellyseerrEnabled },
        'seerr': {
            needed: route => !!config().JellyseerrEnabled && isSeerrRoute(route),
            // Opened from outside its own pages: Home Screen Sections' discover cards and Hidden Content
            // lists (More Info), the Requests page (issues).
            exports: ['jellyseerrMoreInfo.open', 'jellyseerrIssueReporter.showReportModal']
        },
        'recommendations': { needed: pageRule('recommendations') },
        'requests-page': { needed: pageRule('requests-page') },
        'calendar-page': { needed: pageRule('calendar-page') },
        'activity-page': { needed: pageRule('activity-page') },
        // No flag: plugin revision lists always start, and the configuration page's "Test custom links"
        // uses the plugin-icons module either way.
        'dashboard': { needed: isDashboardRoute },
        'theme-selector': { needed: () => !!config().ThemeSelectorEnabled },
        'active-streams': { needed: () => !!config().ActiveStreamsEnabled }
    };

    return {
        FEATURE_GROUPS, isTabbedPage,
        /** The groups a group's rule asks to load along with it. */
        companions(id: string): string[] {
            try {
                return FEATURE_GROUPS[id]?.with?.() ?? [];
            } catch {
                return [];
            }
        },
        /** Which of the given groups (in order) the current page, config and user need right now. */
        needed(order: readonly string[]): string[] {
            const route = currentRoute();
            return order.filter(id => {
                if (id === 'core') return true;
                const rule = FEATURE_GROUPS[id];
                if (!rule) return true;
                try {
                    return !!rule.needed?.(route);
                } catch (error) {
                    console.error(`🪼 Jellyfin Enhanced: Could not decide whether component group '${id}' is needed; loading it.`, error);
                    return true;
                }
            });
        },
        /** A <video> has started loading or playing. */
        sawVideo(): void { videoSeen = true; }
    };
}
