import type { SeerrCoreHost } from '../../host-core';
import type { SeerrUiFacade } from '../contract';
import { isRecord, isString } from '../decode';
import { analyzeSeasonStatuses } from '../display';
import type { SeerrMediaItem } from '../types';
import { LOG_UI, firstInstall, groupInternals } from '../runtime';
import { ICONS } from './icon-markup';

const PRIMARY_CARD_TYPES = ['movie', 'series'];
const isTmdbId = (value: string): boolean => /^\d+$/.test(value);

/** Search-page result rendering: the Seerr section, the header icon and in-place result updates. */
export function installResults(host: SeerrCoreHost): void {
    const { JE, document, window } = host;
    if (!firstInstall(JE, 'ui-results')) return;
    const ui: Partial<SeerrUiFacade> = JE.jellyseerrUI ||= {};
    const internals = groupInternals(JE);
    const state = internals.state;
    const icons = () => internals.icons ?? ICONS;
    // Only one reposition watcher may be live; a newer render cancels the previous one.
    let pendingRepositionObserver: MutationObserver | null = null;
    let pendingRepositionTimeout: number | null = null;

    /**
     * Shows a request made elsewhere (a modal, More Info) on this page's matching
     * request buttons: every button for that TMDB id and media type (a movie and
     * a show can share an id), and their cards' badges.
     */
    function markCardRequested(tmdbId: string, mediaType: string, is4k = false): void {
        if (!isTmdbId(tmdbId)) return;
        const type = mediaType.toLowerCase();
        const requestedLabel = JE.t('jellyseerr_btn_requested') || 'Requested';
        const buttons = [...document.querySelectorAll<HTMLButtonElement>(`.jellyseerr-request-button[data-tmdb-id="${tmdbId}"]`)]
            .filter(button => !button.dataset.mediaType || button.dataset.mediaType.toLowerCase() === type);
        for (const button of buttons) {
            if (is4k) {
                const arrow = button.parentElement?.querySelector<HTMLButtonElement>('.jellyseerr-split-arrow');
                if (arrow) {
                    arrow.classList.add('jellyseerr-4k-pending');
                    arrow.disabled = true;
                }
                // The main button and status badge describe the regular copy.
                continue;
            }
            button.innerHTML = `${icons().requested}<span>${requestedLabel}</span>`;
            button.classList.remove('jellyseerr-button-request');
            button.classList.add('jellyseerr-button-pending');
            button.disabled = true;
            const badge = button.closest('.jellyseerr-card')?.querySelector<HTMLElement>('.jellyseerr-status-badge');
            if (badge) {
                badge.innerHTML = icons().requested;
                badge.className = 'jellyseerr-status-badge status-requested';
                badge.style.display = 'flex';
            }
        }
    }
    document.addEventListener('jellyseerr-media-requested', event => {
        const detail: unknown = event instanceof CustomEvent ? event.detail : null;
        if (!isRecord(detail)) return;
        const tmdbId = detail.tmdbId;
        const mediaType = detail.mediaType;
        if ((!isString(tmdbId) && typeof tmdbId !== 'number') || !tmdbId || !isString(mediaType) || !mediaType) return;
        markCardRequested(String(tmdbId), mediaType, detail.is4k === true);
    });

    // The icon's handlers read the latest state, so a later status (a new user) is honoured.
    let iconState: { active: boolean; userFound: boolean; onToggle: (() => void) | null } = { active: false, userFound: false, onToggle: null };
    function updateJellyseerrIcon(isJellyseerrActive: boolean, jellyseerrUserFound: boolean, isJellyseerrOnlyMode: boolean, onToggleFilter: (() => void) | null): void {
        iconState = { active: isJellyseerrActive, userFound: jellyseerrUserFound, onToggle: onToggleFilter };
        const anchor = document.querySelector('.searchFields .inputContainer') || document.querySelector('#searchPage .searchFields') || document.querySelector('#searchPage');
        if (!anchor) return;
        let icon = document.getElementById('jellyseerr-search-icon');
        if (!(icon instanceof HTMLImageElement)) {
            const img = document.createElement('img');
            img.id = 'jellyseerr-search-icon';
            img.className = 'jellyseerr-icon';
            img.src = JE.cdn?.selfhst?.('svg/seerr.svg') ?? '';
            img.alt = 'Seerr';
            let tapCount = 0;
            let tapTimer: number | null = null;
            const toggle = (): (() => void) | null => iconState.active && iconState.userFound ? iconState.onToggle : null;
            const handleIconInteraction = () => {
                if (!toggle()) return;
                tapCount++;
                if (tapCount === 1) {
                    tapTimer = window.setTimeout(() => { tapCount = 0; }, 300);
                } else if (tapCount === 2) {
                    if (tapTimer !== null) window.clearTimeout(tapTimer);
                    tapCount = 0;
                    toggle()?.();
                }
            };
            img.addEventListener('click', handleIconInteraction);
            // A tap, not any touchend: a scroll starting on the icon is not a double-tap.
            JE.core?.ui?.addTouchTapListener?.(img, event => { event.preventDefault(); handleIconInteraction(); });
            img.setAttribute('tabindex', '0');
            img.addEventListener('keydown', event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                toggle()?.();
            });
            anchor.appendChild(img);
            icon = img;
        }
        icon.classList.remove('is-active', 'is-disabled', 'is-no-user', 'is-filter-active');
        if (isJellyseerrActive && jellyseerrUserFound) {
            icon.title = JE.t(isJellyseerrOnlyMode ? 'jellyseerr_icon_active_filter_tooltip' : 'jellyseerr_icon_active_tooltip');
            icon.classList.add('is-active');
            if (isJellyseerrOnlyMode) icon.classList.add('is-filter-active');
        } else if (isJellyseerrActive && !jellyseerrUserFound) {
            icon.title = JE.t('jellyseerr_icon_no_user_tooltip');
            icon.classList.add('is-no-user');
        } else {
            icon.title = JE.t('jellyseerr_icon_disabled_tooltip');
            icon.classList.add('is-disabled');
        }
    }

    /** Removes the plugin's nodes from the search page and restores a native message it hid. */
    function clearInjectedSearchResults(): void {
        document.querySelectorAll('.jellyseerr-section, .jellyseerr-no-results-message').forEach(el => el.remove());
        ui.releasePosters?.();
        document.querySelectorAll('.jellyseerr-native-message-hidden').forEach(el => el.classList.remove('jellyseerr-native-message-hidden'));
    }

    function createJellyseerrSection(results: SeerrMediaItem[], isJellyseerrOnlyMode: boolean, isJellyseerrActive: boolean, jellyseerrUserFound: boolean): HTMLElement {
        const section = document.createElement('div');
        section.className = 'verticalSection emby-scroller-container jellyseerr-section';
        section.setAttribute('data-jellyseerr-section', 'true');
        const title = document.createElement('h2');
        title.className = 'sectionTitle sectionTitle-cards focuscontainer-x padded-left padded-right';
        title.textContent = isJellyseerrOnlyMode ? JE.t('jellyseerr_results_title') : JE.t('jellyseerr_discover_title');
        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'jellyseerr-refresh-btn';
        Object.assign(refreshBtn.style, {
            marginLeft: '0.5em', verticalAlign: 'middle', background: 'none', border: 'none', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0'
        });
        const icon = document.createElement('span');
        icon.className = 'material-icons jellyseerr-refresh-icon';
        icon.textContent = 'refresh';
        icon.style.transition = 'transform 0.5s cubic-bezier(.4,2,.6,1)';
        refreshBtn.appendChild(icon);
        refreshBtn.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            icon.style.transform = 'rotate(360deg)';
            window.setTimeout(() => { icon.style.transform = ''; }, 500);
            document.dispatchEvent(new CustomEvent('jellyseerr-manual-refresh'));
        });
        title.appendChild(refreshBtn);
        if (!document.getElementById('jellyseerr-refresh-style')) {
            const style = document.createElement('style');
            style.id = 'jellyseerr-refresh-style';
            style.textContent = `
            .jellyseerr-refresh-btn:focus { outline: none; }
            .jellyseerr-refresh-icon { color: #fff; filter: opacity(0.6); }
            .jellyseerr-refresh-btn:hover .jellyseerr-refresh-icon { color: #fff; filter: opacity(0.9); }
        `;
            document.head.appendChild(style);
        }
        section.appendChild(title);
        const scroller = document.createElement('div');
        scroller.setAttribute('is', 'emby-scroller');
        scroller.className = 'padded-top-focusscale padded-bottom-focusscale emby-scroller';
        scroller.dataset.horizontal = 'true';
        scroller.dataset.centerfocus = 'card';
        const items = document.createElement('div');
        items.setAttribute('is', 'emby-itemscontainer');
        items.className = 'focuscontainer-x itemsContainer scrollSlider';
        if (document.querySelector('.alphaPicker-tv') !== null) items.classList.add('itemsContainer-tv', 'animatedScrollX');
        for (const item of results) {
            const card = internals.createJellyseerrCard?.(item, isJellyseerrActive, jellyseerrUserFound);
            if (card) items.appendChild(card);
        }
        scroller.appendChild(items);
        section.appendChild(scroller);
        return section;
    }

    /** Renders the Seerr section after the last Movies/Shows section (or the no-results message). */
    function renderJellyseerrResults(results: SeerrMediaItem[], query: string, isJellyseerrOnlyMode: boolean, isJellyseerrActive: boolean, jellyseerrUserFound: boolean): void {
        console.log(`${LOG_UI} Rendering results for query: "${query}"`);
        const found = document.querySelector('#searchPage');
        if (!found) {
            console.warn(`${LOG_UI} #searchPage not found. Cannot render results.`);
            return;
        }
        const searchPage: Element = found;
        pendingRepositionObserver?.disconnect();
        pendingRepositionObserver = null;
        if (pendingRepositionTimeout !== null) window.clearTimeout(pendingRepositionTimeout);
        pendingRepositionTimeout = null;
        searchPage.querySelectorAll('.jellyseerr-section').forEach(section => section.remove());
        const sectionToInject = createJellyseerrSection(results, isJellyseerrOnlyMode, isJellyseerrActive, jellyseerrUserFound);

        // Primary sections are identified by their cards' data-type, not the (localized) title.
        const cardType = (el: Element | null): string | undefined => {
            const typed = el?.querySelector('[data-type]');
            return typed instanceof HTMLElement ? typed.dataset.type?.toLowerCase() : undefined;
        };
        const findLastPrimarySection = (): Element | null => {
            const sections = [...searchPage.querySelectorAll('.verticalSection:not(.jellyseerr-section)')];
            for (let i = sections.length - 1; i >= 0; i--) {
                const type = cardType(sections[i] ?? null);
                if (type && PRIMARY_CARD_TYPES.includes(type)) return sections[i] ?? null;
            }
            return null;
        };
        const isPrimarySection = (el: Element | null): boolean => {
            if (!el || !el.classList.contains('verticalSection')) return false;
            const type = cardType(el);
            return !!type && PRIMARY_CARD_TYPES.includes(type);
        };
        // Other search scripts keep a permanent .noItemsMessage and hide it while there are results.
        const isNoResultsMessageShown = (el: HTMLElement): boolean => {
            if (el.style.display === 'none') return false;
            if (el.classList.contains('jellyseerr-native-message-hidden') || el.classList.contains('section-hidden')) return true;
            return getComputedStyle(el).display !== 'none';
        };
        function positionSection(): boolean {
            const noResultsMessage = [...searchPage.querySelectorAll<HTMLElement>('.noItemsMessage:not(.jellyseerr-no-results-message)')].find(isNoResultsMessageShown);
            if (noResultsMessage) {
                // React owns that node (and reuses it): never touch its children, hide it and add our own.
                noResultsMessage.classList.add('jellyseerr-native-message-hidden');
                let message = searchPage.querySelector('.jellyseerr-no-results-message');
                if (!message) {
                    message = document.createElement('div');
                    message.className = 'noItemsMessage centerMessage jellyseerr-no-results-message';
                }
                // Write only on change: the reposition observer watches this subtree.
                const desiredText = JE.t('jellyseerr_no_results_jellyfin', { query });
                if (message.textContent !== desiredText) message.textContent = desiredText;
                if (message.previousElementSibling !== noResultsMessage) noResultsMessage.parentElement?.insertBefore(message, noResultsMessage.nextSibling);
                if (sectionToInject.previousElementSibling !== message) message.parentElement?.insertBefore(sectionToInject, message.nextSibling);
                return true;
            }
            searchPage.querySelectorAll('.jellyseerr-no-results-message').forEach(el => el.remove());
            searchPage.querySelectorAll('.jellyseerr-native-message-hidden').forEach(el => el.classList.remove('jellyseerr-native-message-hidden'));
            const lastPrimary = findLastPrimarySection();
            if (lastPrimary) {
                if (!isPrimarySection(sectionToInject.previousElementSibling)) lastPrimary.after(sectionToInject);
                return true;
            }
            const resultsContainer = searchPage.querySelector('.searchResults, [class*="searchResults"], .padded-top.padded-bottom-page');
            if (resultsContainer) {
                if (sectionToInject.parentElement !== resultsContainer || resultsContainer.lastElementChild !== sectionToInject) resultsContainer.appendChild(sectionToInject);
            } else if (searchPage.lastElementChild !== sectionToInject) {
                searchPage.appendChild(sectionToInject);
            }
            return false;
        }
        positionSection();
        const observer = new MutationObserver(records => {
            if (!sectionToInject.isConnected) { observer.disconnect(); return; }
            // Cards added inside the section change nothing about where it sits.
            if (records.every(record => sectionToInject.contains(record.target))) return;
            positionSection();
        });
        observer.observe(searchPage, { childList: true, subtree: true });
        pendingRepositionObserver = observer;
        pendingRepositionTimeout = window.setTimeout(() => observer.disconnect(), 5000);
    }

    /** Re-renders the buttons in `container` whose result changed (same id and media type). */
    function updateJellyseerrResults(newResults: readonly SeerrMediaItem[], isJellyseerrActive: boolean, jellyseerrUserFound: boolean, container: ParentNode = document): void {
        const buttons = container.querySelectorAll<HTMLButtonElement>('.jellyseerr-request-button[data-tmdb-id]');
        for (const button of buttons) {
            const tmdbId = button.dataset.tmdbId;
            const mediaType = button.dataset.mediaType;
            const newItem = newResults.find(item => String(item.id) === tmdbId && item.mediaType === mediaType);
            if (!newItem || !tmdbId) continue;
            const oldJson = button.dataset.searchResultItem;
            if (!oldJson) continue;
            let oldMediaInfo: unknown;
            try {
                const old: unknown = JSON.parse(oldJson);
                oldMediaInfo = isRecord(old) ? old.mediaInfo : undefined;
            } catch {
                continue;
            }
            if (JSON.stringify(oldMediaInfo) === JSON.stringify(newItem.mediaInfo)) continue;
            console.log(`${LOG_UI} Status change detected for TMDB ID ${tmdbId}. Updating button.`);
            internals.configureRequestButton?.(button, newItem, isJellyseerrActive, jellyseerrUserFound);
            const popover = state.jellyseerrHoverPopover;
            if (popover?.classList.contains('show') && popover.dataset.tmdbId === tmdbId) {
                console.log(`${LOG_UI} Active popover found for TMDB ID ${tmdbId}. Refreshing content.`);
                const content = internals.fillHoverPopover?.(newItem);
                if (content) internals.positionHoverPopover?.(content, parseFloat(popover.dataset.clientX || ''), parseFloat(popover.dataset.clientY || ''));
                else ui.hideHoverPopover?.();
            }
        }
    }

    ui.updateJellyseerrIcon = updateJellyseerrIcon;
    ui.clearInjectedSearchResults = clearInjectedSearchResults;
    ui.renderJellyseerrResults = renderJellyseerrResults;
    ui.updateJellyseerrResults = updateJellyseerrResults;
    internals.markCardRequested = markCardRequested;
    internals.analyzeSeasonStatuses = seasons => analyzeSeasonStatuses(seasons, JE.t);
    internals.createJellyseerrSection = createJellyseerrSection;
}
