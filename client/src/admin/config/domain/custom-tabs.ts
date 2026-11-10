import { isObject, type AdminConfig, type JsonValue } from './config';

export interface CustomTab { Title: string; ContentHtml: string; [extra: string]: JsonValue | undefined }
export interface CustomTabsConfig { Tabs: CustomTab[]; [extra: string]: JsonValue | CustomTab[] | undefined }
export interface OwnedFlagUpdate { ownedKey: string; value: boolean }
export interface ManagedCustomTab { masterKey: string; parentKey: string; autoKey: string; ownedKey: string; title: string; html: string }

// Per managed Custom Tabs entry: which JE config flags drive it (parent + auto-create), what Title to write,
// and the exact ContentHtml snippet JE's matching front-end module looks for. ContentHtml strings are the
// source of truth for "this tab is ours": the sync identifies entries by exact-string match. Sync requires
// masterKey, parentKey and autoKey all true for the entry to exist: without masterKey, disabling the master
// feature would leave an orphan entry that opens to broken content.
export const CUSTOM_TAB_MANAGED_ENTRIES: readonly ManagedCustomTab[] = [
    { masterKey: 'BookmarksEnabled',      parentKey: 'BookmarksUseCustomTabs',     autoKey: 'BookmarksAutoCreateCustomTab',     ownedKey: 'BookmarksCustomTabJeOwned',     title: 'Bookmarks',      html: '<div class="sections bookmarks"></div>' },
    { masterKey: 'HiddenContentEnabled',  parentKey: 'HiddenContentUseCustomTabs', autoKey: 'HiddenContentAutoCreateCustomTab', ownedKey: 'HiddenContentCustomTabJeOwned', title: 'Hidden Content', html: '<div class="jellyfinenhanced hidden-content"></div>' },
    { masterKey: 'DownloadsPageEnabled',  parentKey: 'DownloadsUseCustomTabs',     autoKey: 'DownloadsAutoCreateCustomTab',     ownedKey: 'DownloadsCustomTabJeOwned',     title: 'Requests',       html: '<div class="jellyfinenhanced requests"></div>' },
    { masterKey: 'CalendarPageEnabled',   parentKey: 'CalendarUseCustomTabs',      autoKey: 'CalendarAutoCreateCustomTab',      ownedKey: 'CalendarCustomTabJeOwned',      title: 'Calendar',       html: '<div class="jellyfinenhanced calendar"></div>' },
    { masterKey: 'RecommendationsPageEnabled', parentKey: 'RecommendationsUseCustomTabs', autoKey: 'RecommendationsAutoCreateCustomTab', ownedKey: 'RecommendationsCustomTabJeOwned', title: 'Recommendations', html: '<div class="jellyfinenhanced recommendations"></div>' },
    { masterKey: 'ActivityFeedEnabled',   parentKey: 'ActivityFeedUseCustomTabs',   autoKey: 'ActivityFeedAutoCreateCustomTab',   ownedKey: 'ActivityFeedCustomTabJeOwned',  title: 'Activity',       html: '<div class="jellyfinenhanced activity"></div>' },
    { masterKey: 'CatchUpEnabled',      parentKey: 'CatchUpUseCustomTabs',        autoKey: 'CatchUpAutoCreateCustomTab',        ownedKey: 'CatchUpCustomTabJeOwned',       title: 'Catch Up',       html: '<div class="jellyfinenhanced catchup"></div>' }
];

/** Whether the Custom Tabs plugin's stored shape is the one this page knows how to write. */
export function isCustomTabsConfigShapeOk(cfg: unknown): cfg is CustomTabsConfig {
    if (!isObject(cfg)) {
        console.warn('[JE] Custom Tabs compat: config is not an object:', cfg);
        return false;
    }
    const tabs = cfg.Tabs;
    if (!Array.isArray(tabs)) {
        console.warn('[JE] Custom Tabs compat: cfg.Tabs is not an array. Keys present:', Object.keys(cfg));
        return false;
    }
    for (var i = 0; i < tabs.length; i++) {
        var t = tabs[i];
        if (!isObject(t)) {
            console.warn('[JE] Custom Tabs compat: tab[' + i + '] is not an object:', t);
            return false;
        }
        if (typeof t.Title !== 'string' || typeof t.ContentHtml !== 'string') {
            console.warn('[JE] Custom Tabs compat: tab[' + i + '] missing expected fields. Got keys:', Object.keys(t));
            return false;
        }
    }
    return true;
}

/** Whether a saved configuration asks for this entry to exist. */
function wantsEntry(entry: ManagedCustomTab, saved: AdminConfig): boolean {
    return saved[entry.autoKey] === true && saved[entry.parentKey] === true && saved[entry.masterKey] === true;
}

/** Whether any managed entry is wanted at all. */
export function anyCustomTabIntent(saved: AdminConfig): boolean {
    return CUSTOM_TAB_MANAGED_ENTRIES.some(entry => wantsEntry(entry, saved));
}

/**
 * Apply every managed entry to the tab list (in place) and say what to record.
 *  - wanted, no entry: add it, owned.
 *  - wanted, entry exists: leave it, keep the owned flag (an entry the administrator made stays theirs).
 *  - not wanted, entry exists and owned: remove it.
 *  - otherwise: leave the list alone, not owned.
 */
export function planCustomTabsSync(cfg: CustomTabsConfig, saved: AdminConfig): { changed: boolean; ownedUpdates: OwnedFlagUpdate[] } {
    let changed = false;
    const ownedUpdates: OwnedFlagUpdate[] = [];
    CUSTOM_TAB_MANAGED_ENTRIES.forEach(entry => {
        const shouldExist = wantsEntry(entry, saved);
        const isOwned = saved[entry.ownedKey] === true;
        const index = cfg.Tabs.findIndex(tab => tab.ContentHtml === entry.html);
        if (shouldExist && index === -1) {
            cfg.Tabs.push({ Title: entry.title, ContentHtml: entry.html });
            changed = true;
            ownedUpdates.push({ ownedKey: entry.ownedKey, value: true });
        } else if (shouldExist) {
            ownedUpdates.push({ ownedKey: entry.ownedKey, value: isOwned });
        } else if (index !== -1 && isOwned) {
            cfg.Tabs.splice(index, 1);
            changed = true;
            ownedUpdates.push({ ownedKey: entry.ownedKey, value: false });
        } else {
            ownedUpdates.push({ ownedKey: entry.ownedKey, value: false });
        }
    });
    return { changed, ownedUpdates };
}
