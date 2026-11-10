/** Admin-only Sonarr/Radarr/Bazarr links (with library status) on item details. */
import { api, bridge, hasApi } from './host';
import type { ArrLinksBridge, ObserverHandleLike } from './host';
import { hashItemId, lookupDetailsItem, visibleDetailPage } from './page';
import { externalLink } from './links';
import {
    decodeInstanceErrors, decodeRadarrMatches, decodeSonarrMatches, enabledInstances, externalTmdbIds, mappedUrl,
    parseUrlMappings, radarrDropdownItems, singleRadarrLink, singleSonarrLink, sonarrDropdownItems
} from './arr-domain';
import type { ArrInstance, ArrStatus, DropdownItem, InstanceError, RadarrMatch, SonarrMatch } from './arr-domain';

const JE = bridge<ArrLinksBridge>('Arr links');
const logPrefix = '🪼 Jellyfin Enhanced: Arr Links:';
const serverAddress = () => (hasApi() && typeof api().serverAddress === 'function' ? api().serverAddress?.() ?? window.location.origin : window.location.origin);

JE.initializeArrLinksScript = async function initializeArrLinksScript() {
    if (!JE.pluginConfig.ArrLinksEnabled) {
        console.log(`${logPrefix} Integration disabled in plugin settings.`);
        return;
    }
    // The identity epoch this initialization belongs to: after a user switch
    // its asynchronous work must stop.
    const initEpoch = JE.session ? JE.session.getEpoch() : 0;
    const initIsCurrent = () => !JE.session || JE.session.isCurrent(initEpoch);

    // The shared admin check (helpers), the same source every admin-gated module reads.
    const isAdmin = JE.helpers.isAdmin();
    console.log(`${logPrefix} Admin status: ${isAdmin}`);
    if (!isAdmin) {
        console.log(`${logPrefix} User is not an administrator. Links will not be shown.`);
        return;
    }
    console.log(`${logPrefix} Initializing...`);

    // Surface stored-config corruption to the admin on first init.
    if (JE.pluginConfig.SonarrInstancesCorrupt && typeof JE.toast === 'function') {
        JE.toast('⚠ Sonarr instance configuration is corrupt. Open the Jellyfin Enhanced config page to reset it.');
        console.error(`${logPrefix} SonarrInstances stored JSON is corrupt.`);
    }
    if (JE.pluginConfig.RadarrInstancesCorrupt && typeof JE.toast === 'function') {
        JE.toast('⚠ Radarr instance configuration is corrupt. Open the Jellyfin Enhanced config page to reset it.');
        console.error(`${logPrefix} RadarrInstances stored JSON is corrupt.`);
    }

    let isAddingLinks = false; // Lock to prevent concurrent runs
    let debounceTimer: number | null = null;
    let observer: ObserverHandleLike | null | undefined = null;
    // Sonarr titleSlugs + Radarr matches by id, per initialization (an
    // account switch re-initializes; config changes need a reload).
    const sonarrCache = new Map<string, SonarrMatch[]>();
    const radarrCache = new Map<string, RadarrMatch[]>();

    try {
        const SONARR_ICON_URL = JE.cdn.selfhst('svg/sonarr.svg');
        const RADARR_ICON_URL = JE.cdn.selfhst('svg/radarr-light-hybrid-light.svg');
        const BAZARR_ICON_URL = JE.cdn.selfhst('svg/bazarr.svg');
        const address = serverAddress();
        const config = JE.pluginConfig;
        // Multi-instance support, dropping disabled entries; falls back to the
        // legacy single fields below.
        const sonarrInstances: ArrInstance[] = enabledInstances(config.SonarrInstances, 'Sonarr', address);
        const radarrInstances: ArrInstance[] = enabledInstances(config.RadarrInstances, 'Radarr', address);
        if (sonarrInstances.length === 0 && config.SonarrUrl) {
            const legacyUrl = mappedUrl(parseUrlMappings(config.SonarrUrlMappings || ''), config.SonarrUrl, address);
            if (legacyUrl) sonarrInstances.push({ name: 'Sonarr', url: legacyUrl });
        }
        if (radarrInstances.length === 0 && config.RadarrUrl) {
            const legacyUrl = mappedUrl(parseUrlMappings(config.RadarrUrlMappings || ''), config.RadarrUrl, address);
            if (legacyUrl) radarrInstances.push({ name: 'Radarr', url: legacyUrl });
        }
        const bazarrUrl = mappedUrl(parseUrlMappings(config.BazarrUrlMappings || ''), config.BazarrUrl, address);

        const styleId = 'arr-links-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = ARR_LINKS_CSS;
            document.head.appendChild(style);
        }

        // One toast per failure kind per session, and per distinct instance error.
        const toastedGlobalFailure = { sonarr: false, radarr: false };
        const toastedInstanceErrors = new Set<string>();
        // JE.toast renders HTML: admin-set names and upstream reasons are escaped.
        const esc = (value: unknown) => {
            const shared = JE.helpers.escHtml;
            if (shared) return shared(value);
            return String(value == null ? '' : value)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        };
        function surfaceInstanceErrors(kind: 'Sonarr' | 'Radarr', errors: InstanceError[] | undefined): void {
            if (!errors || errors.length === 0) {
                // Everything that was failing has recovered: the same error may toast again.
                for (const key of [...toastedInstanceErrors]) if (key.startsWith(kind + '|')) toastedInstanceErrors.delete(key);
                return;
            }
            const seenThisTick = new Set<string>();
            for (const err of errors) {
                const key = `${kind}|${err.instanceName}|${err.reason}`;
                seenThisTick.add(key);
                if (toastedInstanceErrors.has(key)) continue;
                toastedInstanceErrors.add(key);
                if (typeof JE.toast === 'function') {
                    JE.toast('⚠ ' + esc(kind) + ' instance "' + esc(err.instanceName || 'unknown') + '" failed: ' + esc(err.reason));
                }
                console.warn(`${logPrefix} ${kind} instance "${err.instanceName}" error: ${err.reason}`);
            }
            // Self-heal: drop entries for errors that did not reappear.
            for (const key of [...toastedInstanceErrors]) if (key.startsWith(kind + '|') && !seenThisTick.has(key)) toastedInstanceErrors.delete(key);
        }
        function surfaceGlobalFailure(kind: 'Sonarr' | 'Radarr', detail: unknown): void {
            const flag = kind === 'Sonarr' ? 'sonarr' : 'radarr';
            if (toastedGlobalFailure[flag]) return;
            toastedGlobalFailure[flag] = true;
            if (typeof JE.toast === 'function') JE.toast('⚠ ' + esc(kind) + ' lookup failed; links unavailable. See console for details.');
            console.warn(`${logPrefix} ${kind} lookup backend failed:`, detail);
        }

        /**
         * Sonarr URL slugs across all configured instances. On a backend
         * failure: no links and a toast, never guessed per-instance slugs.
         */
        async function getSonarrSlugs(tvdbId: string): Promise<SonarrMatch[]> {
            if (!tvdbId) return [];
            const cached = sonarrCache.get(tvdbId);
            if (cached) return cached;
            try {
                const data = await JE.core.api.plugin(`/arr/series-slugs?tvdbId=${encodeURIComponent(tvdbId)}`);
                // A cleared transient failure may toast again later.
                toastedGlobalFailure.sonarr = false;
                surfaceInstanceErrors('Sonarr', decodeInstanceErrors(data));
                const results = decodeSonarrMatches(data, serverAddress());
                sonarrCache.set(tvdbId, results);
                return results;
            } catch (e) {
                surfaceGlobalFailure('Sonarr', e);
                return [];
            }
        }
        /** Radarr instances holding the movie; on failure no links and a toast. */
        async function getRadarrInstances(tmdbId: string): Promise<RadarrMatch[]> {
            if (!tmdbId) return [];
            const cached = radarrCache.get(tmdbId);
            if (cached) return cached;
            try {
                const data = await JE.core.api.plugin(`/arr/movie-instances?tmdbId=${encodeURIComponent(tmdbId)}`);
                toastedGlobalFailure.radarr = false;
                surfaceInstanceErrors('Radarr', decodeInstanceErrors(data));
                const results = decodeRadarrMatches(data, serverAddress());
                radarrCache.set(tmdbId, results);
                return results;
            } catch (e) {
                surfaceGlobalFailure('Radarr', e);
                return [];
            }
        }

        const ICON_URLS: Readonly<Record<string, string>> = {
            'arr-link-sonarr': SONARR_ICON_URL,
            'arr-link-radarr': RADARR_ICON_URL,
            'arr-link-bazarr': BAZARR_ICON_URL,
        };
        const asText = () => !!JE.pluginConfig.ShowArrLinksAsText;
        function iconImage(iconClass: string, alt: string): HTMLImageElement | null {
            const iconUrl = Object.prototype.hasOwnProperty.call(ICON_URLS, iconClass) ? ICON_URLS[iconClass] : undefined;
            if (!iconUrl) return null;
            const img = document.createElement('img');
            img.src = iconUrl;
            img.alt = alt;
            img.className = 'arr-link-img';
            const iconSize = JE.helpers.getExternalLinkIconSize();
            img.style.width = `${iconSize}px`;
            img.style.height = `${iconSize}px`;
            return img;
        }
        function createLinkButton(label: string, url: string, iconClass: string, status: ArrStatus | null = null, badge = '', tooltip = ''): HTMLAnchorElement {
            const statusClass = status ? ` arr-link--${status}` : '';
            const button = externalLink(JE.helpers, url, { title: tooltip || label, className: `button-link emby-button arr-link${statusClass}` });
            if (asText()) {
                button.textContent = label;
                // Badge in text mode so status is visible without hovering
                if (badge) {
                    const badgeEl = document.createElement('span');
                    badgeEl.className = `arr-badge arr-badge--${status || 'missing'}`;
                    badgeEl.textContent = badge;
                    button.appendChild(badgeEl);
                }
            } else {
                // <img> sits inline exactly like Jellyfin's own external link icons
                const img = iconImage(iconClass, label);
                if (img) button.appendChild(img);
            }
            return button;
        }
        function createDropdown(label: string, iconClass: string, items: DropdownItem[]): HTMLSpanElement {
            const wrapper = document.createElement('span');
            wrapper.className = 'arr-dropdown';
            // Theme-aware colours, captured when the menu is created
            const themeVars = JE.themer?.getThemeVariables?.() || {};
            wrapper.style.setProperty('--arr-menu-bg', themeVars.secondaryBg || 'rgba(20,20,28,0.98)');
            wrapper.style.setProperty('--arr-menu-text', themeVars.textColor || '#fff');
            wrapper.style.setProperty('--arr-menu-border', 'rgba(255,255,255,0.2)');
            wrapper.style.setProperty('--arr-menu-hover', 'rgba(255,255,255,0.1)');
            wrapper.style.setProperty('--arr-menu-muted', 'rgba(255,255,255,0.55)');

            const toggle = document.createElement('a');
            toggle.setAttribute('is', 'emby-linkbutton');
            toggle.className = 'button-link emby-button arr-link';
            toggle.href = '#';
            toggle.title = `${label} (${items.length} instances)`;
            if (asText()) {
                toggle.textContent = label;
            } else {
                const img = iconImage(iconClass, label);
                if (img) toggle.appendChild(img);
            }
            const arrow = document.createElement('span');
            arrow.textContent = '▾';
            arrow.style.cssText = 'font-size:0.8em; opacity:0.8; margin-left:2px; line-height:1; vertical-align:middle; color: white;';
            toggle.appendChild(arrow);
            toggle.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                document.querySelectorAll('.arr-dropdown.open').forEach(dropdown => { if (dropdown !== wrapper) dropdown.classList.remove('open'); });
                wrapper.classList.toggle('open');
            });

            const menu = document.createElement('div');
            menu.className = 'arr-dropdown-menu';
            for (const item of items) {
                const link = externalLink(JE.helpers, item.url, { title: item.tip || item.name, className: 'arr-dropdown-item' });
                const dot = document.createElement('span');
                dot.className = `arr-dropdown-dot arr-dropdown-dot--${item.status || 'missing'}`;
                link.appendChild(dot);
                const nameSpan = document.createElement('span');
                nameSpan.className = 'arr-dropdown-item-name';
                nameSpan.textContent = item.name;
                link.appendChild(nameSpan);
                if (item.badge) {
                    const badgeSpan = document.createElement('span');
                    badgeSpan.className = `arr-badge arr-badge--${item.status || 'missing'}`;
                    badgeSpan.textContent = item.badge;
                    link.appendChild(badgeSpan);
                }
                if (item.size) {
                    const sizeSpan = document.createElement('span');
                    sizeSpan.className = 'arr-dropdown-item-stats';
                    sizeSpan.textContent = item.size;
                    link.appendChild(sizeSpan);
                }
                menu.appendChild(link);
            }
            wrapper.append(toggle, menu);
            return wrapper;
        }

        async function addArrLinks(): Promise<void> {
            if (isAddingLinks) return;
            const visiblePage = visibleDetailPage();
            if (!visiblePage) return;
            const anchorElement = visiblePage.querySelector('.itemExternalLinks');

            // Clean up stale links from non-visible pages to prevent conflicts
            document.querySelectorAll('#itemDetailPage.hide .arr-link').forEach(staleLink => {
                if (staleLink.previousSibling?.nodeType === Node.TEXT_NODE) staleLink.previousSibling.remove();
                staleLink.remove();
            });
            if (!anchorElement || anchorElement.querySelector('.arr-link')) return;

            // The awaited lookups can span seconds; append only while the anchor
            // is still on the visible page, the route names the same item and
            // the admin session that started this is still the signed-in one.
            const hashAtStart = window.location.hash;
            const isStillValidTarget = () => document.contains(anchorElement)
                && !anchorElement.closest('#itemDetailPage.hide')
                && window.location.hash === hashAtStart
                && initIsCurrent();
            const separator = () => anchorElement.appendChild(document.createTextNode(asText() ? ', ' : ' '));

            isAddingLinks = true;
            try {
                const itemId = hashItemId();
                if (!itemId) return;
                const item = await lookupDetailsItem(JE.helpers, itemId, false);
                if (!isStillValidTarget()) return;
                // Only movies and TV shows
                if (item?.Type !== 'Movie' && item?.Type !== 'Series') return;
                const ids = externalTmdbIds([...visiblePage.querySelectorAll<HTMLAnchorElement>('.itemExternalLinks a, .externalIdLinks a')].map(link => link.href));
                // Only with a TMDB link on the page
                if (!ids.hasTmdbLink) return;
                // One instance collapses to a plain link (status opt-in);
                // dropdowns always show status, distinguishing instances.
                const showStatusOnSingle = JE.pluginConfig.ArrLinksShowStatusSingle === true;

                if (item.Type === 'Series' && item.Name && sonarrInstances.length > 0) {
                    const slugMatches = await getSonarrSlugs(item.ProviderIds.Tvdb || '');
                    if (!isStillValidTarget()) return;
                    const valid = slugMatches.filter((match): match is SonarrMatch & { instanceUrl: string } => !!match.instanceUrl);
                    const [single] = valid;
                    if (valid.length === 1 && single) {
                        const link = singleSonarrLink(single, showStatusOnSingle);
                        separator();
                        anchorElement.appendChild(createLinkButton('Sonarr', link.url, 'arr-link-sonarr', link.status, link.badge, link.tip));
                    } else if (valid.length > 1) {
                        separator();
                        anchorElement.appendChild(createDropdown('Sonarr', 'arr-link-sonarr', sonarrDropdownItems(valid)));
                    }
                }

                const tmdbId = ids.tmdb;
                if (item.Type === 'Movie' && tmdbId && radarrInstances.length > 0) {
                    const matches = await getRadarrInstances(tmdbId);
                    if (!isStillValidTarget()) return;
                    const valid = matches.filter((match): match is RadarrMatch & { url: string } => !!match.url);
                    const [single] = valid;
                    if (valid.length === 1 && single) {
                        const link = singleRadarrLink(single, tmdbId, showStatusOnSingle);
                        separator();
                        anchorElement.appendChild(createLinkButton('Radarr', link.url, 'arr-link-radarr', link.status, link.badge, link.tip));
                    } else if (valid.length > 1) {
                        separator();
                        anchorElement.appendChild(createDropdown('Radarr', 'arr-link-radarr', radarrDropdownItems(valid, tmdbId)));
                    }
                }

                if (bazarrUrl && (item.Type === 'Series' || item.Type === 'Movie')) {
                    separator();
                    anchorElement.appendChild(createLinkButton('Bazarr', `${bazarrUrl}/${item.Type === 'Series' ? 'series' : 'movies'}/`, 'arr-link-bazarr'));
                }
            } finally {
                isAddingLinks = false;
            }
        }

        // One delegated listener closes all dropdowns on an outside click;
        // guarded so a re-initialization does not stack duplicates.
        if (!JE._arrDropdownCloserInstalled) {
            JE._arrDropdownCloserInstalled = true;
            document.addEventListener('click', event => {
                const target = event.target;
                if (!(target instanceof Element) || !target.closest('.arr-dropdown')) {
                    document.querySelectorAll('.arr-dropdown.open').forEach(dropdown => dropdown.classList.remove('open'));
                }
            });
        }

        // A stale invocation must never register the shared 'arr-links'
        // observer: it would take the current user's subscription down with it.
        if (!initIsCurrent()) return;
        // After a user switch the observer retires itself instead of injecting
        // admin-only links (with stale cached data) for the next user.
        observer = JE.helpers.createObserver('arr-links', () => {
            if (JE.session && !JE.session.isCurrent(initEpoch)) {
                if (observer) {
                    observer.disconnect();
                    console.log(`${logPrefix} Observer disconnected — user changed`);
                }
                return;
            }
            if (!JE.pluginConfig.ArrLinksEnabled) {
                if (observer) {
                    observer.disconnect();
                    console.log(`${logPrefix} Observer disconnected — feature disabled`);
                }
                return;
            }
            // Debounce rapid DOM changes
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => { void addArrLinks(); }, 100);
        }, document.body, { childList: true, subtree: true }) || null;
        JE._arrLinksObserver = observer;
        console.log(`${logPrefix} Initialized successfully`);
    } catch (err) {
        console.error(`${logPrefix} Failed to initialize`, err);
    }
};

// Re-run the whole initialization for the incoming user after a switch (the
// admin gate, observer and caches live in the init closure). Runs off
// je:user-data-loaded so the admin check reads the new user's settings.
document.addEventListener('je:user-data-loaded', () => {
    if (!JE.pluginConfig.ArrLinksEnabled) return;
    try { JE._arrLinksObserver?.disconnect(); } catch { /* already gone */ }
    void JE.initializeArrLinksScript?.();
});

const ARR_LINKS_CSS = `
                    /* Status colors on the link button border */
                    .arr-link--complete { border-left: 3px solid #52b54b !important; }
                    .arr-link--partial  { border-left: 3px solid #e5a00d !important; }
                    .arr-link--missing  { border-left: 3px solid #666 !important; opacity: 0.7; }

                    /* Icon image inside the button */
                    .arr-link-img {
                        width: 25px;
                        height: 25px;
                        display: block;
                        object-fit: contain;
                    }

                    /* Status badge (text-mode only) */
                    .arr-badge {
                        font-size: 0.75em;
                        padding: 1px 5px;
                        border-radius: 3px;
                        margin-left: 6px;
                        vertical-align: middle;
                        font-weight: 600;
                    }
                    .arr-badge--complete { background: rgba(82,181,75,0.2); color: #52b54b; }
                    .arr-badge--partial  { background: rgba(229,160,13,0.2); color: #e5a00d; }
                    .arr-badge--missing  { background: rgba(102,102,102,0.2); color: #999; }

                    /* Dropdown wrapper — sits inline with sibling link buttons */
                    .arr-dropdown {
                        position: relative;
                        display: inline-block;
                    }

                    /* Dropdown menu — colours injected as CSS vars at render time */
                    .arr-dropdown-menu {
                        display: none;
                        position: absolute;
                        top: calc(100% + 6px);
                        left: 0;
                        z-index: 9999;
                        min-width: 240px;
                        background: var(--arr-menu-bg, rgba(20,20,28,0.98));
                        color: var(--arr-menu-text, #fff);
                        border: 1px solid var(--arr-menu-border, rgba(255,255,255,0.2));
                        border-radius: 8px;
                        box-shadow: 0 12px 32px rgba(0,0,0,0.6);
                        padding: 4px 0;
                        backdrop-filter: blur(12px);
                        -webkit-backdrop-filter: blur(12px);
                    }
                    .arr-dropdown.open .arr-dropdown-menu { display: block; }

                    .arr-dropdown-item {
                        display: flex;
                        align-items: center;
                        gap: 10px;
                        padding: 9px 14px;
                        color: var(--arr-menu-text, #fff);
                        text-decoration: none;
                        font-size: 0.9em;
                        white-space: nowrap;
                        transition: background 0.12s;
                    }
                    .arr-dropdown-item:hover {
                        background: var(--arr-menu-hover, rgba(255,255,255,0.1));
                        color: var(--arr-menu-text, #fff);
                    }
                    .arr-dropdown-item-name { flex: 1; font-weight: 500; }
                    .arr-dropdown-item-stats {
                        color: var(--arr-menu-muted, rgba(255,255,255,0.55));
                        font-size: 0.85em;
                    }
                    .arr-dropdown-dot {
                        width: 8px;
                        height: 8px;
                        border-radius: 50%;
                        flex-shrink: 0;
                    }
                    .arr-dropdown-dot--complete { background: #52b54b; }
                    .arr-dropdown-dot--partial  { background: #e5a00d; }
                    .arr-dropdown-dot--missing  { background: #888; }

                    /* Progress bar */
                    .arr-progress {
                        display: block;
                        height: 2px;
                        margin-top: 2px;
                        border-radius: 1px;
                        background: rgba(255,255,255,0.1);
                        overflow: hidden;
                    }
                    .arr-progress-fill { height: 100%; border-radius: 1px; transition: width 0.3s; }
                    .arr-progress-fill--complete { background: #52b54b; }
                    .arr-progress-fill--partial  { background: #e5a00d; }
                    .arr-progress-fill--missing  { background: #666; }
                `;
