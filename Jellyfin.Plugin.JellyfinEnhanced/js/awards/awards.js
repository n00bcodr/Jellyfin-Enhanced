// /js/elsewhere/awards.js
(function (JE) {
    'use strict';

    JE.initializeAwardsScript = function () {
        if (!JE.pluginConfig?.ShowAwards) {
            console.log('🪼 Jellyfin Enhanced: Awards feature disabled.');
            return;
        }

        const logPrefix = '🪼 Jellyfin Enhanced: Awards:';
        const escapeHtml = (typeof JE.escapeHtml === 'function') ? JE.escapeHtml : (v) => String(v);

        function injectCss() {
            const styleId = 'je-awards-styles';
            if (document.getElementById(styleId)) return;

            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .je-awards-section {
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
                }
                .je-awards-label .je-awards-star {
                    font-size: 20px;
                    color: #ffd76b;
                }
                .je-awards-wordmark {
                    font-family: Georgia, 'Times New Roman', serif;
                    letter-spacing: 0.12em;
                    font-size: 16px;
                    font-weight: 600;
                    text-transform: uppercase;
                }
                .je-awards-divider {
                    z-index: 1;
                    width: 1px;
                    align-self: stretch;
                    background: rgba(255,255,255,0.25);
                }
                .je-awards-stats {
                    z-index: 1;
                    font-size: 14px;
                    font-weight: 500;
                    color: rgba(255,255,255,0.92);
                    white-space: nowrap;
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
            document.head.appendChild(style);
        }

        function sparklesSvg() {
            // Decorative four-point stars, echoing TMDB's own awards-banner art
            // without depending on an external asset. Two sets, since one x%
            // range can't be both "rich" and "collision-safe" at every width:
            //   - safe: kept clear of the expand-icon's zone (rightmost ~30%),
            //     shown at every width.
            //   - wide: reaches further right/is more prominent — fine with the
            //     room a desktop banner has, but collides with the expand-icon
            //     on a narrow card, so it's CSS-hidden there (.je-spark-wide,
            //     see the max-width:480px rule above).
            const star = (x, y, size, opacity, extraClass) =>
                `<svg class="${extraClass || ''}" viewBox="0 0 24 24" width="${size}" height="${size}" style="left:${x}%; top:${y}%; opacity:${opacity};">
                    <path d="M12 0 L14 10 L24 12 L14 14 L12 24 L10 14 L0 12 L10 10 Z"/>
                </svg>`;
            const safe = star(38, 18, 8, 0.4) + star(50, 68, 12, 0.3) + star(28, 65, 7, 0.35);
            const wide = star(70, 20, 10, 0.5, 'je-spark-wide') + star(80, 60, 16, 0.35, 'je-spark-wide') + star(90, 25, 22, 0.9, 'je-spark-wide');
            return safe + wide;
        }

        function removeAwardsSection(page) {
            try {
                const root = page || document.querySelector('#itemDetailPage:not(.hide)') || document;
                const sec = root.querySelector('.je-awards-section');
                if (sec && sec.parentNode) sec.parentNode.removeChild(sec);
            } catch (e) {
                console.warn(`${logPrefix} removeAwardsSection failed:`, e);
            }
        }

        // The controller returns the raw C# AwardsCacheEntry, which serializes
        // as PascalCase (Found/Wins/Nominations/Awards[].Name etc.) — JE.toCamelCase
        // doesn't recurse into array elements, so it can't fix the nested Awards[]
        // objects; normalize explicitly here instead, once, at the fetch boundary.
        function normalizeAwardsData(data) {
            if (!data) return null;
            return {
                found: !!data.Found,
                wins: data.Wins || 0,
                nominations: data.Nominations || 0,
                awards: (data.Awards || []).map(a => ({
                    name: a.Name,
                    result: a.Result,
                    year: a.Year,
                    recipients: a.Recipients || [],
                    works: a.Works || []
                }))
            };
        }

        async function fetchAwards(tmdbId, apiMediaType) {
            try {
                const data = await JE.core.api.plugin(`/awards/${apiMediaType}/${tmdbId}`);
                return normalizeAwardsData(data);
            } catch (e) {
                // Feature disabled server-side (503), bad id, WDQS having a bad
                // moment, whatever — an awards banner is decoration, not core
                // functionality, so a failure here should never be visible to
                // the user beyond a quiet console warning.
                console.warn(`${logPrefix} Failed to fetch awards.`, e);
                return null;
            }
        }

        // Award-body icon lookup. Wikidata's category names are consistently
        // prefixed with the awarding body ("Academy Award for...", "Golden
        // Globe Award for...") so the body is inferable from the name alone —
        // no extra data needed. Only bodies with an individually
        // license-verified free logo are listed here (see CdnAssetService.cs
        // "award-logos" source for exactly which file + license each maps to);
        // everything else falls back to the generic star icon in the summary
        // bar rather than guessing at unverified imagery. Checked in order, so
        // more specific prefixes (BAFTA before a hypothetical bare "Award")
        // can be added above broader ones if that's ever needed.
        //
        // Third element (invert): true for icons that are a single flat black
        // shape with a transparent background (e.g. the Saturn Award
        // silhouette) — those need to be forced white to read against the dark
        // banner. Most of the others are already gold/multi-tone and render
        // fine as-is now that icons show in their real color.
        const AWARD_BODY_ICONS = [
            ['Academy Award', 'oscar'],
            ['Golden Globe Award', 'golden-globe'],
            ['BAFTA Award', 'bafta'],
            ['Primetime Emmy Award', 'emmy'],
            ['Daytime Emmy Award', 'emmy'],
            ['Screen Actors Guild Award', 'sag'],
            ['Critics\' Choice', 'critics-choice'],
            ['National Board of Review', 'national-board-of-review'],
            ['Saturn Award', 'saturn', true],
            ['Kids\' Choice Award', 'kids-choice'],
            ['Toronto Film Critics Association Award', 'toronto-critics', true],
            ['Palme d\'Or', 'cannes'],
            ['Cannes Film Festival Award', 'cannes'],
        ];

        function awardBodyIcon(awardName) {
            const match = AWARD_BODY_ICONS.find(([prefix]) => awardName.startsWith(prefix));
            if (!match) return null;
            return { url: JE.cdn.url('award-logos', match[1]), invert: !!match[2] };
        }

        // Wins first (the headline result), newest year first; the server sorts
        // by year then alphabetically by result ("Nominated" < "Won"), which
        // reads badly (every nomination listed before every win in the same
        // year) — sorted here instead of server-side so it applies to entries
        // already sitting in the disk cache too, not just freshly-fetched ones
        // (a "found" cache entry never expires/re-fetches on its own).
        function sortAwards(awards) {
            return [...awards].sort((a, b) => {
                const yearDiff = (b.year || 0) - (a.year || 0);
                if (yearDiff !== 0) return yearDiff;
                const aWon = a.result === 'Won' ? 0 : 1;
                const bWon = b.result === 'Won' ? 0 : 1;
                return aWon - bWon;
            });
        }

        function buildAwardsList(awardsData) {
            const list = document.createElement('div');
            list.className = 'je-awards-list';
            sortAwards(awardsData.awards).forEach(award => {
                const row = document.createElement('div');
                row.className = 'je-awards-row';

                const won = award.result === 'Won';
                const badgeClass = won ? 'je-awards-badge-won' : 'je-awards-badge-nominated';
                const badgeText = won ? JE.t('awards_won') : JE.t('awards_nominated');
                // Title-mode rows list recipients; person-mode rows list which
                // work(s) the award was for instead (never both — see AwardEntry).
                let detail = '';
                if (award.recipients && award.recipients.length) {
                    detail = `<div class="je-awards-recipients">${escapeHtml(award.recipients.join(', '))}</div>`;
                } else if (award.works && award.works.length) {
                    detail = `<div class="je-awards-recipients">${escapeHtml(JE.t('awards_for_work', { work: award.works.join(', ') }))}</div>`;
                }
                const bodyIcon = awardBodyIcon(award.name);
                // onerror removes the element itself rather than leaving a broken-image
                // glyph — a not-yet-cached icon (e.g. a fresh install's first startup,
                // before Wikimedia's rate limit on a burst of requests has cleared) should
                // read as "no icon for this row" like any unmapped award body, not as a
                // visible defect. Self-heals on its own on a later page view once the
                // icon is cached; no user action needed either way.
                const icon = bodyIcon
                    ? `<img class="je-awards-body-icon${bodyIcon.invert ? ' je-awards-body-icon-invert' : ''}" src="${bodyIcon.url}" alt="" loading="lazy" onerror="this.remove()">`
                    : '';

                row.innerHTML = `
                    <div class="je-awards-row-main">
                        <span class="je-awards-badge ${badgeClass}">${escapeHtml(badgeText)}</span>
                        <div>
                            <div class="je-awards-row-name">${escapeHtml(award.name)}</div>
                            ${detail}
                        </div>
                    </div>
                    <div class="je-awards-row-side">
                        ${icon}
                        ${award.year ? `<span class="je-awards-row-year">${escapeHtml(String(award.year))}</span>` : ''}
                    </div>
                `;
                list.appendChild(row);
            });
            return list;
        }

        // A native <details>/<summary> section, matching reviews.js's own
        // .tmdb-reviews-section: clicking the summary bar expands/collapses the
        // full award list inline (no overlay), same convention as the rest of
        // the item-details page.
        function buildAwardsSection(awardsData) {
            const section = document.createElement('details');
            section.className = 'detailSection je-awards-section';

            const parts = [];
            if (awardsData.wins > 0) parts.push(JE.t('awards_wins_count', { count: awardsData.wins }));
            if (awardsData.nominations > 0) parts.push(JE.t('awards_nominations_count', { count: awardsData.nominations }));

            const summary = document.createElement('summary');
            summary.className = 'je-awards-summary';
            summary.innerHTML = `
                <div class="je-awards-sparkles" aria-hidden="true">${sparklesSvg()}</div>
                <div class="je-awards-label">
                    <span class="material-symbols-rounded je-awards-star" aria-hidden="true">auto_awesome</span>
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

        function insertBanner(contextPage, awardsData) {
            removeAwardsSection(contextPage);

            if (!awardsData || !awardsData.found || (awardsData.wins === 0 && awardsData.nominations === 0)) {
                return;
            }

            const banner = buildAwardsSection(awardsData);

            // Prefer going directly below the TMDB Reviews section (the whole
            // point of this placement); fall back to the same anchor chain
            // reviews.js uses so the banner still appears when Reviews is
            // disabled. Both features insert via insertBefore(el, anchor.nextSibling)
            // against a shared anchor, which self-orders correctly regardless
            // of which one renders first — see awards.js history/PR notes.
            // #similarCollapsible ("More Like This") is a last-resort fallback:
            // per the jellyfin-12-compat skill it's confirmed present in both the
            // legacy and current item-details templates, unlike the other anchors
            // which are plugin-injected (.tmdb-reviews-section,
            // .streaming-lookup-container) or start out DOM-hidden until Jellyfin's
            // own JS populates them (.itemExternalLinks, .tagline) — inserted
            // BEFORE it, not after, since it's a landmark near the bottom of the
            // page rather than something content should follow directly.
            const afterAnchor =
                contextPage.querySelector('.tmdb-reviews-section') ||
                contextPage.querySelector('.streaming-lookup-container') ||
                contextPage.querySelector('.itemExternalLinks') ||
                contextPage.querySelector('.tagline');

            if (afterAnchor && afterAnchor.parentNode) {
                afterAnchor.parentNode.insertBefore(banner, afterAnchor.nextSibling);
                return;
            }

            const beforeAnchor = contextPage.querySelector('#similarCollapsible');
            if (beforeAnchor && beforeAnchor.parentNode) {
                beforeAnchor.parentNode.insertBefore(banner, beforeAnchor);
                return;
            }

            console.error(`${logPrefix} Could not find a suitable anchor to insert the awards banner. contextPage:`, contextPage);
        }

        async function processPage(visiblePage) {
            if (!JE?.pluginConfig?.ShowAwards) {
                removeAwardsSection(visiblePage);
                return;
            }

            try {
                const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
                const userId = ApiClient.getCurrentUserId();
                if (!itemId || !userId) return;

                const item = JE.helpers?.getItemCached
                    ? await JE.helpers.getItemCached(itemId, { userId })
                    : await ApiClient.getItem(userId, itemId);
                const mediaType = item?.Type;

                let tmdbId = null;
                let apiMediaType;

                if (mediaType === 'Movie') {
                    tmdbId = item?.ProviderIds?.Tmdb;
                    apiMediaType = 'movie';
                } else if (mediaType === 'Person') {
                    // item.ProviderIds.Tmdb on a Person item is the TMDB PERSON
                    // id (a different id space than movie/tv ids) — the whole
                    // point of person mode is showing this person's own career
                    // award history, not any single title's.
                    tmdbId = item?.ProviderIds?.Tmdb;
                    apiMediaType = 'person';
                } else if (mediaType === 'Series' || mediaType === 'Season' || mediaType === 'Episode') {
                    // Awards (Emmys etc.) are recorded against the series as a whole,
                    // not per season/episode, so Season/Episode pages resolve to and
                    // show the parent series' award history — same TMDB id resolution
                    // reviews.js uses for Season/Episode.
                    tmdbId = item?.ProviderIds?.Tmdb || item?.SeriesProviderIds?.Tmdb;
                    if (!tmdbId && item?.SeriesId) {
                        try {
                            const series = await ApiClient.getItem(userId, item.SeriesId);
                            tmdbId = series?.ProviderIds?.Tmdb;
                        } catch (_) { /* fall through to the not-found path below */ }
                    }
                    apiMediaType = 'tv';
                } else {
                    removeAwardsSection(visiblePage);
                    return;
                }

                if (!tmdbId) {
                    removeAwardsSection(visiblePage);
                    return;
                }

                const awardsData = await fetchAwards(String(tmdbId), apiMediaType);
                insertBanner(visiblePage, awardsData);
            } catch (error) {
                console.error(`${logPrefix} Error processing page:`, error);
            }
        }

        injectCss();

        const unregister = JE.helpers.onViewPage(async (view, element, hash, itemPromise) => {
            if (!JE?.pluginConfig?.ShowAwards) {
                unregister();
                return;
            }

            const currentHash = window.location.hash;
            const hasItemId = currentHash.includes('id=') || (hash && hash.includes('id='));
            const isItemDetailElement = element && (
                element.id === 'itemDetailPage' ||
                element.classList?.contains('itemDetailPage')
            );

            if (!hasItemId && !isItemDetailElement) {
                return;
            }

            await new Promise(resolve => setTimeout(resolve, 150));

            const visiblePage = document.querySelector('#itemDetailPage:not(.hide)');
            if (visiblePage) {
                processPage(visiblePage);
            } else {
                // Page container exists but is still marked .hide (e.g. the SPA
                // transition hadn't finished applying the class at 150ms), or
                // #itemDetailPage doesn't exist under the current layout at all.
                // One retry after a longer wait catches the former.
                setTimeout(() => {
                    const retryPage = document.querySelector('#itemDetailPage:not(.hide)');
                    if (retryPage) processPage(retryPage);
                }, 500);
            }
        }, {
            pages: null,
            fetchItem: false,
            immediate: true
        });
    };
})(window.JellyfinEnhanced);
