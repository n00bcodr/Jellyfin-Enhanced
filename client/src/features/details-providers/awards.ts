/** Awards banner (Wikidata via the plugin) on item details pages. */
import { bridge, currentUserId } from './host';
import type { AwardsBridge } from './host';
import { detailPageHook, detailsLease, hashItemId, lookupDetailsItem, removeFirst } from './page';
import { pathSegment } from './links';
import { awardBodyIcon, isUnconfirmed, normalizeAwardsData, resolveProviderTarget, sortAwards, sparklesSvg } from './provider-domain';
import type { AwardsData } from './provider-domain';

const JE = bridge<AwardsBridge>('Awards');

JE.initializeAwardsScript = function initializeAwardsScript() {
    if (!JE.pluginConfig?.ShowAwards) {
        console.log('🪼 Jellyfin Enhanced: Awards feature disabled.');
        return;
    }
    const logPrefix = '🪼 Jellyfin Enhanced: Awards:';
    const escapeHtml = (value: string) => (typeof JE.escapeHtml === 'function' ? JE.escapeHtml(value) : String(value));

    function injectCss(): void {
        const styleId = 'je-awards-styles';
        if (document.getElementById(styleId)) return;
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = AWARDS_CSS;
        document.head.appendChild(style);
    }
    function removeAwardsSection(page: ParentNode | null): void {
        try {
            removeFirst(page, '.je-awards-section');
        } catch (e) {
            console.warn(`${logPrefix} removeAwardsSection failed:`, e);
        }
    }

    /**
     * A title's awards, from the core response cache (30 minutes, dropped on a
     * user switch) except a failure placeholder (Confirmed: false), which the
     * server retries soon. null on failure: the banner is decoration.
     */
    async function fetchAwards(tmdbId: string, apiMediaType: string): Promise<AwardsData | null> {
        try {
            const cacheKey = `awards:/${apiMediaType}/${tmdbId}`;
            const data = await JE.core.api.plugin(`/awards/${apiMediaType}/${pathSegment(tmdbId)}`, { cacheKey });
            if (isUnconfirmed(data)) JE.core.api.manager.clearCacheMatching(cacheKey);
            return normalizeAwardsData(data);
        } catch (e) {
            console.warn(`${logPrefix} Failed to fetch awards.`, e);
            return null;
        }
    }

    function buildAwardsList(awardsData: AwardsData): HTMLDivElement {
        const list = document.createElement('div');
        list.className = 'je-awards-list';
        for (const award of sortAwards(awardsData.awards)) {
            const row = document.createElement('div');
            row.className = 'je-awards-row';
            const won = award.result === 'Won';
            const badgeClass = won ? 'je-awards-badge-won' : 'je-awards-badge-nominated';
            const badgeText = won ? JE.t('awards_won') : JE.t('awards_nominated');
            // Title rows list recipients; person rows list the work(s) instead.
            let detail = '';
            if (award.recipients.length) {
                detail = `<div class="je-awards-recipients">${escapeHtml(award.recipients.join(', '))}</div>`;
            } else if (award.works.length) {
                detail = `<div class="je-awards-recipients">${escapeHtml(JE.t('awards_for_work', { work: award.works.join(', ') }))}</div>`;
            }
            const bodyIcon = awardBodyIcon(award.name);
            row.innerHTML = `
                    <div class="je-awards-row-main">
                        <span class="je-awards-badge ${badgeClass}">${escapeHtml(badgeText)}</span>
                        <div>
                            <div class="je-awards-row-name">${escapeHtml(award.name)}</div>
                            ${detail}
                        </div>
                    </div>
                    <div class="je-awards-row-side">
                        ${award.year ? `<span class="je-awards-row-year">${escapeHtml(String(award.year))}</span>` : ''}
                    </div>
                `;
            if (bodyIcon) {
                // A not-yet-cached icon removes itself rather than showing a
                // broken image; it self-heals once the server has cached it.
                const icon = document.createElement('img');
                icon.className = `je-awards-body-icon${bodyIcon.invert ? ' je-awards-body-icon-invert' : ''}`;
                icon.src = JE.cdn.url('award-logos', bodyIcon.file);
                icon.alt = '';
                icon.loading = 'lazy';
                icon.onerror = () => icon.remove();
                row.querySelector('.je-awards-row-side')?.prepend(icon);
            }
            list.appendChild(row);
        }
        return list;
    }

    // A native <details>/<summary> section matching the reviews section.
    function buildAwardsSection(awardsData: AwardsData): HTMLDetailsElement {
        const section = document.createElement('details');
        section.className = 'detailSection je-awards-section';
        const parts: string[] = [];
        if (awardsData.wins > 0) parts.push(JE.t('awards_wins_count', { count: awardsData.wins }));
        if (awardsData.nominations > 0) parts.push(JE.t('awards_nominations_count', { count: awardsData.nominations }));
        const summary = document.createElement('summary');
        summary.className = 'je-awards-summary';
        summary.innerHTML = `
                <div class="je-awards-sparkles" aria-hidden="true">${sparklesSvg()}</div>
                <div class="je-awards-label">
                    <span class="je-msym-rounded je-awards-star" aria-hidden="true">auto_awesome</span>
                    <span class="je-awards-wordmark">${escapeHtml(JE.t('awards_label'))}</span>
                </div>
                <div class="je-awards-divider"></div>
                <div class="je-awards-stats">${parts.map(escapeHtml).join(' &nbsp;|&nbsp; ')}</div>
                <i class="material-icons expand-icon" aria-hidden="true">expand_more</i>
            `;
        section.appendChild(summary);
        section.appendChild(buildAwardsList(awardsData));
        return section;
    }

    function insertBanner(contextPage: Element, awardsData: AwardsData | null): void {
        removeAwardsSection(contextPage);
        if (!awardsData || !awardsData.found || (awardsData.wins === 0 && awardsData.nominations === 0)) return;
        const banner = buildAwardsSection(awardsData);
        // Directly below Reviews, else the anchors reviews use; both insert after
        // a shared anchor, which self-orders whichever renders first.
        // #similarCollapsible ("More Like This") is the last-resort landmark,
        // present in both item-details templates; inserted before it.
        const afterAnchor = contextPage.querySelector('.tmdb-reviews-section')
            || contextPage.querySelector('.streaming-lookup-container')
            || contextPage.querySelector('.itemExternalLinks')
            || contextPage.querySelector('.tagline');
        if (afterAnchor?.parentNode) {
            afterAnchor.parentNode.insertBefore(banner, afterAnchor.nextSibling);
            return;
        }
        const beforeAnchor = contextPage.querySelector('#similarCollapsible');
        if (beforeAnchor?.parentNode) {
            beforeAnchor.parentNode.insertBefore(banner, beforeAnchor);
            return;
        }
        console.error(`${logPrefix} Could not find a suitable anchor to insert the awards banner. contextPage:`, contextPage);
    }

    async function processPage(visiblePage: Element): Promise<void> {
        if (!JE.pluginConfig?.ShowAwards) {
            removeAwardsSection(visiblePage);
            return;
        }
        try {
            const itemId = hashItemId();
            const userId = currentUserId();
            if (!itemId || !userId) return;
            // Results apply only to the page and session they were fetched for.
            const lease = detailsLease(JE.session, itemId, visiblePage);
            const item = await lookupDetailsItem(JE.helpers, itemId, true, userId);
            // Person: the TMDB person id (person mode, a different id space).
            const { target } = await resolveProviderTarget(item, true, seriesId => lookupDetailsItem(JE.helpers, seriesId, true, userId));
            // A superseded visit stops before any provider request.
            if (!lease.current()) return;
            if (!target) {
                if (lease.current()) removeAwardsSection(visiblePage);
                return;
            }
            const awardsData = await fetchAwards(target.tmdbId, target.mediaType);
            if (lease.current()) insertBanner(visiblePage, awardsData);
        } catch (error) {
            console.error(`${logPrefix} Error processing page:`, error);
        }
    }

    injectCss();
    const unregister = JE.helpers.onViewPage(
        detailPageHook(() => !!JE.pluginConfig?.ShowAwards, () => unregister?.(), page => { void processPage(page); }, true),
        { pages: null, fetchItem: false, immediate: true });
};

const AWARDS_CSS = `
                .je-awards-label .je-msym-rounded {
                    font-family: 'JE Material Symbols Rounded';
                    font-weight: normal;
                    font-style: normal;
                    line-height: 1;
                    letter-spacing: normal;
                    text-transform: none;
                    display: inline-block;
                    white-space: nowrap;
                    word-wrap: normal;
                    direction: ltr;
                    -webkit-font-feature-settings: 'liga';
                    font-feature-settings: 'liga';
                }
                .je-awards-section {
                    /* Some themes (e.g. ElegantFin) style .detailSection as a
                       grid, which blows this <details> out to a huge width —
                       force flex like reviews.js's .tmdb-reviews-section. */
                    display: flex !important;
                    flex-direction: column;
                    width: 100%;
                    min-width: 0;
                    row-gap: 0px !important;
                    position: relative;
                    overflow: hidden;
                    margin: 1em 0;
                    border-radius: 10px;
                    color: #fff;
                    background: linear-gradient(115deg, #0d2b3a 0%, #113a4d 45%, #0f4a63 100%);
                    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08);
                }
                .je-awards-summary {
                    position: relative;
                    display: flex;
                    align-items: center;
                    gap: 14px;
                    padding: 14px 20px;
                    cursor: pointer;
                    list-style: none;
                }
                .je-awards-summary::-webkit-details-marker {
                    display: none;
                }
                .je-awards-summary .je-awards-sparkles {
                    position: absolute;
                    inset: 0;
                    pointer-events: none;
                    opacity: 0.55;
                }
                .je-awards-summary .je-awards-sparkles svg {
                    position: absolute;
                    fill: #fff;
                }
                @media (max-width: 480px) {
                    .je-awards-summary .je-awards-sparkles .je-spark-wide {
                        display: none;
                    }
                }
                .je-awards-label {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    z-index: 1;
                    white-space: nowrap;
                    line-height: 1;
                }
                .je-awards-label .je-awards-star {
                    font-size: 20px;
                    color: #ffd76b;
                }
                .je-awards-wordmark {
                    font-family: Georgia, 'Times New Roman', serif;
                    letter-spacing: 0.12em;
                    font-size: 18px;
                    font-weight: 600;
                    text-transform: uppercase;
                    line-height: 1;
                }
                .je-awards-divider {
                    z-index: 1;
                    width: 1px;
                    align-self: stretch;
                    background: rgba(255,255,255,0.25);
                }
                .je-awards-stats {
                    z-index: 1;
                    font-size: 13px;
                    font-weight: 500;
                    color: rgba(255,255,255,0.92);
                    white-space: nowrap;
                    line-height: 1;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .je-awards-summary .expand-icon {
                    z-index: 1;
                    margin-left: auto;
                    opacity: 0.75;
                    transition: transform 0.2s ease-in-out;
                }
                .je-awards-section[open] .je-awards-summary .expand-icon {
                    transform: rotate(180deg);
                }

                .je-awards-list {
                    padding: 4px 12px 14px;
                }
                .je-awards-row {
                    display: flex;
                    align-items: flex-start;
                    justify-content: space-between;
                    gap: 12px;
                    padding: 10px 8px;
                    border-top: 1px solid rgba(255,255,255,0.08);
                }
                .je-awards-row-main {
                    display: flex;
                    align-items: flex-start;
                    gap: 10px;
                    min-width: 0;
                }
                .je-awards-row-side {
                    flex: none;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }
                .je-awards-body-icon {
                    flex: none;
                    width: 25px;
                    height: 25px;
                    object-fit: contain;
                }
                .je-awards-body-icon-invert {
                    /* Flat black silhouette on transparent, e.g. Saturn Award —
                       force white so it reads against the dark banner instead
                       of nearly disappearing. */
                    filter: brightness(0) invert(1);
                }
                .je-awards-badge {
                    flex: none;
                    margin-top: 1px;
                    padding: 2px 8px;
                    border-radius: 20px;
                    font-size: 11px;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.03em;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    min-width: 88px;
                    text-align: center;
                }
                @media (max-width: 480px) {
                    .je-awards-badge {
                        min-width: 58px;
                        padding: 2px 6px;
                        font-size: 9px;
                    }
                }
                .je-awards-badge-won {
                    background: rgba(255,215,107,0.18);
                    color: #ffd76b;
                }
                .je-awards-badge-nominated {
                    background: rgba(255,255,255,0.1);
                    color: rgba(255,255,255,0.75);
                }
                .je-awards-row-name {
                    font-size: 13.5px;
                    font-weight: 500;
                    line-height: 1.35;
                    color: #fff;
                }
                .je-awards-recipients {
                    margin-top: 2px;
                    font-size: 12px;
                    color: rgba(255,255,255,0.6);
                    line-height: 1.35;
                }
                .je-awards-row-year {
                    flex: none;
                    font-size: 12px;
                    color: rgba(255,255,255,0.5);
                }
            `;
