import type { PageModules } from './modules';
import { asAnchor, asHtml, closestTo } from './dom';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type LinksDeps = Pick<PageModules, 'context' | 'mediaTagsTab' | 'tabs'>;

export function createLinks(m: LinksDeps) {
    const { lifecycle, page } = m.context;

            /**
             * Open what a link to this page asks for, in place: `jeSection=media-tags` (with `tab`/`group`, one of the
             * Media Tags tab's own tabs), `jeSection=<id>` (a setting card), the old Media Tags page's `tab`/`group`,
             * or `tab=<tab>` alone (one of this page's tabs).
             * @param {URLSearchParams} params
             * @param {boolean} [focus]
             * @returns {boolean} Whether the link asked for something here.
             */
            function jeOpenLinkTarget(params: URLSearchParams, focus?: boolean) : boolean {
                var name = params.get('name');
                if (name === 'JellyfinEnhancedMediaTags') { m.mediaTagsTab.jeOpenMediaTags(params.get('tab'), params.get('group'), focus); return true; }
                var id = params.get('jeSection');
                if (id === m.mediaTagsTab.JE_MT_TAB) { m.mediaTagsTab.jeOpenMediaTags(params.get('tab'), params.get('group'), focus); return true; }
                const mediaTagsSection = id && Object.prototype.hasOwnProperty.call(JE_MEDIA_TAGS_SECTIONS, id) ? JE_MEDIA_TAGS_SECTIONS[id] : undefined;
                if (mediaTagsSection) {
                    m.mediaTagsTab.jeOpenMediaTags(mediaTagsSection[0], mediaTagsSection[1], focus);
                    return true;
                }
                if (id && JE_SECTION_LINKS.includes(id)) {
                    var target = asHtml(page.querySelector('#' + id));
                    var holder = target && target.closest('.jellyfin-tab-content');
                    if (holder) m.tabs.jeJumpToTab(holder.id, '#' + id);
                    return true;
                }
                var tabId = id ? null : params.get('tab');
                var tabBtn = tabId ? Array.from(page.querySelectorAll<HTMLElement>('.jellyfin-tab-button')).find(function (b) { return b.dataset.tab === tabId; }) : null;
                if (tabBtn) { tabBtn.click(); return true; }
                return false;
            }

            // Map legacy tab IDs (pre-redesign) to the closest new tab, so users with
            // a saved sessionStorage value from the old layout don't land on a missing tab.
            const LEGACY_TAB_MAP: Readonly<Record<string, string>> = {
                'enhanced': 'display',
                'jellyseerr': 'seerr',
                'arr-links': 'arr'
            };

            // Deep links (#/configurationpage?name=…&jeSection=<id>; jeSection=media-tags&tab=…&group=… for the Media
            // Tags tab; &tab=<tab> alone for any tab): open the tab that holds the section and scroll to it. Only these jeSection ids are accepted. The Media Tags ids older
            // links (settings panel, bookmarks) used open the matching section of the Media Tags tab. Each address is
            // followed once: showing the page again keeps the tab the administrator moved to since.
            const JE_SECTION_LINKS = ['mdblistRatingsEnabled', 'TMDB_API_KEY'];

            const JE_MEDIA_TAGS_SECTIONS: Readonly<Record<string, readonly [string, string?]>> = { tagLayoutAdminDetails: ['layout'], tagScale: ['layout'], tagGap: ['layout'], tagEdgeSpacing: ['layout'], awardsTagsAdminDetails: ['groups', 'awards'], logoTagsAdminDetails: ['groups', 'logos'], customTagsAdminDetails: ['groups', 'custom'], statusTagsAdminDetails: ['badges'], tagStylesEnabled: ['colours'], tagCacheServerMode: ['server'], nativePosterTagsEnabled: ['server'] };

            let _jeOpenedAddress: string | null = null;

            function jeOpenRequestedSection() : void {
                let params;
                try { params = new URLSearchParams(window.location.hash.split('?')[1] || ''); } catch (e) { return; }
                if (window.location.hash === _jeOpenedAddress) {
                    // The same address shown again: the Media Tags tab, if it is the one open, reloads its settings.
                    if (page && page.classList.contains('je-mt-active')) m.mediaTagsTab.jeMountMediaTags();
                    return;
                }
                _jeOpenedAddress = window.location.hash;
                jeOpenLinkTarget(params, false);
            }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {
            // Links to this page itself (the Display card, the Media Tags tab's own links, What's New, the Enhanced panel's
            // pointers to the Media Tags tab) open in place: navigating would rebuild the whole page (leaving an older view
            // behind) and drop unsaved changes on its other tabs. Only while this view is the one shown.
            document.addEventListener('click', function (e) {
                if (!page || !page.isConnected || page.classList.contains('hide')) return;
                var inPage = closestTo(e, '[data-role="page"]');
                if (inPage && inPage !== page) return;
                if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                var a = asAnchor(closestTo(e, 'a[href*="configurationpage?"]'));
                if (!a || a.target === '_blank') return;
                var href = a.getAttribute('href') || '';
                var params;
                try { params = new URLSearchParams(href.slice(href.indexOf('?') + 1)); } catch (err) { return; }
                var name = params.get('name');
                if (name !== 'Jellyfin Enhanced' && name !== 'JellyfinEnhancedMediaTags') return;
                e.preventDefault();
                if (!jeOpenLinkTarget(params, true)) m.mediaTagsTab.jeOpenMediaTags(null, null, true);
            }, { signal: lifecycle.signal });

            // Restore tab from sessionStorage on page load
            try {
                let savedTab = sessionStorage.getItem('jellyfinEnhancedActiveTab');
                const replacement = savedTab ? LEGACY_TAB_MAP[savedTab] : undefined;
                if (replacement) {
                    savedTab = replacement;
                    sessionStorage.setItem('jellyfinEnhancedActiveTab', replacement);
                }
                if (savedTab && asHtml(document.getElementById(savedTab))) {
                    m.tabs.activateTab(savedTab);
                } else if (savedTab) {
                    // Saved tab doesn't match any current tab and isn't a legacy key —
                    // probably a tab that was later renamed or a stray value. Clear it
                    // so the user stops silently getting ignored on every page load.
                    console.info('[JE] discarding unknown saved tab: ' + savedTab);
                    sessionStorage.removeItem('jellyfinEnhancedActiveTab');
                }
            } catch (e) {
                // sessionStorage unavailable (private mode / quota / security) — skip restore.
            }

            jeOpenRequestedSection();

            page.addEventListener('pageshow', jeOpenRequestedSection);
    }

    return {
        wire,
        LEGACY_TAB_MAP,
    };
}
