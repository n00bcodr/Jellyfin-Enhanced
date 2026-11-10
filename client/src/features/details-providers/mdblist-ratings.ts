/**
 * MDBList ratings row (TMDB, Rotten Tomatoes, IMDb, Trakt, …) on item details,
 * from MdblistService's server cache: GET /JellyfinEnhanced/mdblist-ratings/{type}/{tmdbId}.
 * Display only; MdblistRatingsSyncTask fills Jellyfin's own rating fields.
 */
import { bridge, currentUserId } from './host';
import type { MdblistBridge } from './host';
import { detailPageHook, detailsLease, hashItemId, lookupDetailsItem, removeFirst } from './page';
import { externalLink, pathSegment } from './links';
import { RUNTIME_PATTERN, configuredSources, decodeMdblistEntry, isUnconfirmed, mdblistBadges, resolveProviderTarget } from './provider-domain';
import type { MdblistEntry } from './provider-domain';

const JE = bridge<MdblistBridge>('MDBList ratings');
const enabled = () => !!JE.pluginConfig?.MdblistRatingsEnabled && !!JE.pluginConfig.MdblistRatingsShowOnItemDetails;

JE.initializeMdblistRatingsScript = function initializeMdblistRatingsScript() {
    if (!enabled()) {
        console.log('🪼 Jellyfin Enhanced: MDBList Ratings feature disabled.');
        return;
    }
    const logPrefix = '🪼 Jellyfin Enhanced: MDBList Ratings:';
    const sectionClass = 'je-mdblist-ratings-section';
    const escapeHtml = (value: string) => (typeof JE.escapeHtml === 'function' ? JE.escapeHtml(value) : String(value));

    function injectCss(): void {
        const styleId = 'je-mdblist-ratings-styles';
        if (document.getElementById(styleId)) return;
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
                .${sectionClass} {
                    display: flex;
                    flex-wrap: wrap;
                    align-items: center;
                    gap: 5px;
                    margin: 1em 0;
                    font-size: 1.05em;
                }
                .${sectionClass} .je-mdblist-badge {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    text-decoration: none;
                    color: inherit;
                    font-size: inherit;
                }
                .${sectionClass} a.je-mdblist-badge {
                    cursor: pointer;
                }
                .${sectionClass} a.je-mdblist-badge:hover {
                    text-decoration: underline;
                }
                .${sectionClass} .je-mdblist-badge .je-mdblist-source {
                    opacity: 0.7;
                    font-size: 0.9em;
                }
                .${sectionClass} .je-mdblist-badge .je-mdblist-logo {
                    height: 22px;
                    width: auto;
                    object-fit: contain;
                }
            `;
        document.head.appendChild(style);
    }
    function removeSection(page: ParentNode | null): void {
        try {
            removeFirst(page, `.${sectionClass}`);
        } catch (e) {
            console.warn(`${logPrefix} removeSection failed:`, e);
        }
    }

    function buildSection(entry: MdblistEntry, mediaType: string, title: string | undefined): HTMLDivElement {
        const wrap = document.createElement('div');
        wrap.className = sectionClass;
        const badges = mdblistBadges(entry, mediaType, title, configuredSources(JE.pluginConfig?.MdblistRatingsSources),
            !!JE.pluginConfig?.MdblistRatingsShowPercentSymbol);
        for (const badge of badges) {
            const votesText = badge.votes ? ` (${JE.t('mdblist_ratings_votes', { count: badge.votes })})` : '';
            const badgeTitle = `${badge.label}: ${badge.score}${votesText}`;
            const iconHtml = badge.logo
                ? `<img class="je-mdblist-logo" src="${escapeHtml(JE.cdn.url('mdblist-logos', badge.logo))}" alt="${escapeHtml(badge.label)}" loading="lazy">`
                : `<span class="je-mdblist-source">${escapeHtml(badge.label)}</span>`;
            const badgeHtml = `${iconHtml}<span>${escapeHtml(badge.scoreText)}</span>`;
            // is="emby-linkbutton" (createExternalLink) opens externally in the
            // native app shell; resetStyle renders it as a flat badge.
            const element = badge.link
                ? externalLink(JE.helpers, badge.link, { className: 'je-mdblist-badge', title: badgeTitle, resetStyle: true, setup: anchor => { anchor.innerHTML = badgeHtml; } })
                : Object.assign(document.createElement('span'), { className: 'je-mdblist-badge', title: badgeTitle, innerHTML: badgeHtml });
            wrap.appendChild(element);
        }
        return wrap;
    }

    // The official-rating chip (e.g. "PG-13"), else a runtime-looking item
    // ("2h 15m") in the top metadata row (the element colored ratings target).
    function findInsertionTarget(contextPage: Element): Element | null {
        const official = contextPage.querySelector('div.mediaInfoItem.mediaInfoOfficialRating');
        if (official) return official;
        for (const element of contextPage.querySelectorAll('div.mediaInfoItem')) {
            if (RUNTIME_PATTERN.test((element.textContent ?? '').trim())) return element;
        }
        return null;
    }

    function insertSection(contextPage: Element, entry: MdblistEntry | null, mediaType: string, title: string | undefined): void {
        removeSection(contextPage);
        if (!entry) return;
        const section = buildSection(entry, mediaType, title);
        if (section.children.length === 0) return;
        const target = findInsertionTarget(contextPage);
        const scope = (target && (target.closest('.detailRibbon') || target.closest('.mainDetailButtons') || target.closest('.itemMiscInfo'))) || target?.parentNode;
        const extLinks = (scope && 'querySelector' in scope ? scope.querySelector('.itemExternalLinks') : null) || contextPage.querySelector('.itemExternalLinks');
        if (extLinks?.parentNode) {
            extLinks.insertAdjacentElement('beforebegin', section);
            return;
        }
        if (target?.parentNode) {
            target.insertAdjacentElement('afterend', section);
            return;
        }
        // Fallback anchors (same chain reviews/awards use), further down the page.
        const afterAnchor = contextPage.querySelector('.je-awards-section')
            || contextPage.querySelector('.tmdb-reviews-section')
            || contextPage.querySelector('.streaming-lookup-container')
            || contextPage.querySelector('.tagline');
        if (afterAnchor?.parentNode) {
            afterAnchor.parentNode.insertBefore(section, afterAnchor.nextSibling);
            return;
        }
        const beforeAnchor = contextPage.querySelector('#similarCollapsible');
        if (beforeAnchor?.parentNode) {
            beforeAnchor.parentNode.insertBefore(section, beforeAnchor);
            return;
        }
        console.warn(`${logPrefix} Could not find a suitable anchor to insert the ratings row.`);
    }

    /**
     * A title's ratings from the core response cache (30 minutes, dropped on a
     * user switch), except a failure placeholder (Confirmed: false).
     */
    async function fetchRatings(tmdbId: string, apiMediaType: string): Promise<MdblistEntry | null> {
        try {
            const cacheKey = `mdblist-ratings:/${apiMediaType}/${tmdbId}`;
            const data = await JE.core.api.plugin(`/mdblist-ratings/${apiMediaType}/${pathSegment(tmdbId)}`, { cacheKey });
            if (isUnconfirmed(data)) JE.core.api.manager.clearCacheMatching(cacheKey);
            return decodeMdblistEntry(data);
        } catch (e) {
            // A ratings row is decoration; never surface a fetch failure.
            console.warn(`${logPrefix} Failed to fetch ratings.`, e);
            return null;
        }
    }

    async function processPage(visiblePage: Element): Promise<void> {
        if (!enabled()) {
            removeSection(visiblePage);
            return;
        }
        try {
            const itemId = hashItemId();
            const userId = currentUserId();
            if (!itemId || !userId) return;
            const lease = detailsLease(JE.session, itemId, visiblePage);
            const item = await lookupDetailsItem(JE.helpers, itemId, true, userId);
            const { target } = await resolveProviderTarget(item, false, seriesId => lookupDetailsItem(JE.helpers, seriesId, true, userId));
            // A superseded visit stops before any provider request.
            if (!lease.current()) return;
            if (!target) {
                if (lease.current()) removeSection(visiblePage);
                return;
            }
            // The series' own title for link generation (e.g. Metacritic's slug).
            const type = item?.Type;
            const title = (type === 'Season' || type === 'Episode') ? (item?.SeriesName || item?.Name) : item?.Name;
            const entry = await fetchRatings(target.tmdbId, target.mediaType);
            if (lease.current()) insertSection(visiblePage, entry, target.mediaType, title);
        } catch (error) {
            console.error(`${logPrefix} Error processing page:`, error);
        }
    }

    injectCss();
    const unregister = JE.helpers.onViewPage(
        detailPageHook(enabled, () => unregister?.(), page => { void processPage(page); }, true),
        { pages: null, fetchItem: false, immediate: true });
};
