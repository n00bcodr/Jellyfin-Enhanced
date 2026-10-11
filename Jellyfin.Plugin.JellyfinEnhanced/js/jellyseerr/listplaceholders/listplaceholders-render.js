// /js/jellyseerr/listplaceholders/listplaceholders-render.js
// Markup for placeholders: playlist rows (inline between Jellyfin's own rows) and
// collection cards (JE's Seerr card with a kind overlay; custom entries get a simple
// card of their own). Every user- or TMDB-supplied string is escaped here.
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.listPlaceholders = JE.internals.listPlaceholders || {};

    const POSTER_RE = /^\/[A-Za-z0-9_-]+\.(jpg|png)$/;
    const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

    /**
     * Escapes text for HTML (JE.escapeHtml with a local fallback).
     * @param {*} value
     * @returns {string}
     */
    function esc(value) {
        if (typeof JE.escapeHtml === 'function') return JE.escapeHtml(value);
        return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    /**
     * Whether a poster path is a plain TMDB path (same rule as the server).
     * @param {*} path
     * @returns {boolean}
     */
    function isSafePoster(path) {
        return typeof path === 'string' && POSTER_RE.test(path);
    }

    /**
     * TMDB poster URL for a placeholder, or JE's "poster not found" image.
     * @param {string|null|undefined} path - TMDB poster path.
     * @param {string} [size='w92'] - TMDB size (w92, w185, …).
     * @returns {string}
     */
    function posterUrl(path, size = 'w92') {
        if (isSafePoster(path)) return `https://image.tmdb.org/t/p/${size}${path}`;
        return JE.cdn?.url ? JE.cdn.url('ibb', 'fdbkXQdP/jellyseerr-poster-not-found.png') : '';
    }

    /**
     * Formats a yyyy-MM-dd date for display ("Oct 23, 2026" / "23 Oct 2026" by locale).
     * @param {string} iso
     * @returns {string}
     */
    function formatDate(iso) {
        const m = DATE_RE.exec(iso || '');
        if (!m) return '';
        const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
        try {
            const locale = document.documentElement.getAttribute('lang') || undefined;
            return date.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
        } catch (_) {
            return iso;
        }
    }

    /**
     * Two-digit episode/season number.
     * @param {number} n
     * @returns {string}
     */
    function pad2(n) {
        return String(n).padStart(2, '0');
    }

    /**
     * Compact label for an episodes placeholder: S01E08, S01E08–E10, S01E08, E10 or "S01 · 5 episodes".
     * @param {Object} ph - Placeholder.
     * @returns {string}
     */
    function episodeLabel(ph) {
        const season = Number(ph.seasonNumber) || 0;
        const numbers = (ph.episodes || []).map(e => Number(e.e)).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
        if (numbers.length === 0) return `S${pad2(season)}`;
        if (numbers.length === 1) return `S${pad2(season)}E${pad2(numbers[0])}`;
        const contiguous = numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1);
        if (contiguous) return `S${pad2(season)}E${pad2(numbers[0])}–E${pad2(numbers[numbers.length - 1])}`;
        if (numbers.length <= 3) return `S${pad2(season)}` + numbers.map((n, i) => (i === 0 ? '' : ', ') + 'E' + pad2(n)).join('');
        return `S${pad2(season)} · ${lp.tn('listPlaceholders_episode_count', { count: numbers.length })}`;
    }

    /**
     * What a placeholder stands for: Movie, Series, Season 1, S01E08, Custom entry.
     * @param {Object} ph
     * @returns {string}
     */
    function kindLabel(ph) {
        switch (ph.kind) {
            case 'movie': return JE.t('listPlaceholders_kind_movie');
            case 'series': return JE.t('listPlaceholders_kind_series');
            case 'season': return Number(ph.seasonNumber) === 0
                ? JE.t('jellyseerr_season_specials')
                : JE.t('jellyseerr_season_name', { number: ph.seasonNumber });
            case 'episodes': return episodeLabel(ph);
            default: return JE.t('listPlaceholders_kind_custom');
        }
    }

    /**
     * Release text: the year once released, "Coming <date>" before, "TBA" without a date. A season or episodes
     * placeholder without a date is TBA: its year is the show's, not the season's.
     * @param {Object} ph
     * @returns {string}
     */
    function dateLabel(ph) {
        const m = DATE_RE.exec(ph.releaseDate || '');
        if (m) {
            if (ph.released) return m[1];
            return JE.t('listPlaceholders_coming', { date: formatDate(ph.releaseDate) });
        }
        if (ph.year && ph.kind !== 'season' && ph.kind !== 'episodes') return String(ph.year);
        return JE.t('listPlaceholders_tba');
    }

    /**
     * A non-negative integer count from a view field (0 for anything else).
     * @param {*} value
     * @returns {number}
     */
    function count(value) {
        const n = Number(value);
        return Number.isInteger(n) && n > 0 ? n : 0;
    }

    /**
     * Fill progress of a TV placeholder (C3): season/series "3 of 8 aired · 2 upcoming" once the
     * server knows the expected episodes (before that "3 of 10 episodes" / "10 episodes" from the
     * episode count given at creation, or "3 in list"); episodes "2 of 5 episodes" once some are
     * in the list. Movies and custom entries have none.
     * @param {Object} ph - PlaceholderDto (filledCount, expectedCount, airedCount, episodeTotal).
     * @returns {string[]} Zero, one or two label parts.
     */
    function progressParts(ph) {
        const filled = count(ph.filledCount);
        const expected = count(ph.expectedCount);
        if (ph.kind === 'season' || ph.kind === 'series') {
            if (expected > 0) {
                const aired = Math.min(count(ph.airedCount), expected);
                const parts = [];
                if (aired > 0) parts.push(JE.t('listPlaceholders_progress_aired', { filled, aired }));
                else if (filled > 0) parts.push(JE.t('listPlaceholders_progress_in_list', { count: filled }));
                if (expected > aired) parts.push(JE.t('listPlaceholders_progress_upcoming', { count: expected - aired }));
                return parts;
            }
            // Expected set not known yet: the episode count given at creation, if any.
            const total = count(ph.episodeTotal);
            if (filled > 0) {
                return [total > 0
                    ? lp.tn('listPlaceholders_episodes_of', { filled, total }, 'total')
                    : JE.t('listPlaceholders_progress_in_list', { count: filled })];
            }
            return total > 0 ? [lp.tn('listPlaceholders_episode_count', { count: total })] : [];
        }
        if (ph.kind === 'episodes' && filled > 0) {
            return [expected > 0
                ? lp.tn('listPlaceholders_episodes_of', { filled, total: expected }, 'total')
                : JE.t('listPlaceholders_progress_in_list', { count: filled })];
        }
        return [];
    }

    /**
     * Whether a TV placeholder already has some of its episodes in the list (the library has part of it).
     * @param {Object} ph
     * @returns {boolean}
     */
    function isPartlyFilled(ph) {
        return (ph.kind === 'series' || ph.kind === 'season' || ph.kind === 'episodes') && count(ph.filledCount) > 0;
    }

    /**
     * The secondary line of a row: kind, episode title / fill progress, release text.
     * @param {Object} ph
     * @returns {string[]}
     */
    function subtitleParts(ph) {
        const parts = [kindLabel(ph)];
        if (ph.kind === 'episodes' && (ph.episodes || []).length === 1 && ph.episodes[0].title) {
            parts.push(ph.episodes[0].title);
        }
        parts.push(...progressParts(ph));
        parts.push(dateLabel(ph));
        return parts.filter(Boolean);
    }

    /**
     * The library item a placeholder is being swapped for right now (GET reports it while the
     * swap runs, or until a failed swap is retried), as a 32-hex id.
     * @param {Object} ph
     * @returns {string|null}
     */
    function addingItemId(ph) {
        return ph && ph.inLibraryItemId ? lp.normalizeId(ph.inLibraryItemId) : null;
    }

    /**
     * The "Available — adding…" badge, linking to the library item.
     * @param {string} itemId - 32-hex item id.
     * @returns {string}
     */
    function addingHtml(itemId) {
        const label = JE.t('listPlaceholders_available_adding');
        return `<a class="je-lp-badge je-lp-adding status-available" href="#/details?id=${esc(itemId)}" title="${esc(label)}">`
            + '<span class="material-icons" aria-hidden="true">library_add_check</span>'
            + `<span class="je-lp-badge-text">${esc(label)}</span></a>`;
    }

    /**
     * Seerr state of a placeholder for display: badge, whether it can be requested, loading.
     * @param {Object} ph
     * @param {{seerrEnabled?: boolean, statusReady?: boolean}} ctx
     * @returns {{show: boolean, loading?: boolean, requestable?: boolean, badge?: ({icon: string, cssClass: string, label: string}|null)}}
     */
    function statusInfo(ph, ctx) {
        if (!ctx?.seerrEnabled || ph.kind === 'custom' || !ph.tmdbId || !JE.seerrStatus) return { show: false };
        const seerr = JE.seerrStatus;
        let status = ph.status;
        if (seerr.isRequestable(status) && lp.requests?.isRequested?.(ph)) status = seerr.MEDIA.PROCESSING;
        if (status === null || status === undefined) {
            return { show: true, loading: !ctx.statusReady, requestable: true, badge: null };
        }
        // Part of a show is in this library: Seerr's "Available" (it may watch another server) would contradict the
        // row, so the badge shows the progress instead.
        const partly = isPartlyFilled(ph) && status === seerr.MEDIA.AVAILABLE;
        const display = seerr.resolveDisplayStatus(partly ? seerr.MEDIA.PARTIALLY_AVAILABLE : status, false);
        const config = seerr.getBadgeConfig(display);
        const label = partly ? (progressParts(ph)[0] || JE.t('listPlaceholders_partly_in_library_short')) : JE.t(seerr.getChipConfig(display)?.labelKey);
        const badge = config ? { icon: config.icon, cssClass: config.cssClass, label } : null;
        return { show: true, loading: false, requestable: seerr.isRequestable(status), badge };
    }

    /**
     * Badge + request button markup of a row (re-rendered in place when statuses change).
     * @param {Object} ph
     * @param {Object} ctx - Row context (seerrEnabled, statusReady, user: {active, userFound}).
     * @returns {string}
     */
    function statusHtml(ph, ctx) {
        // Already in the library and being added to the list: nothing to request (any Seerr state).
        const adding = addingItemId(ph);
        if (adding) return addingHtml(adding);
        const info = statusInfo(ph, ctx);
        if (!info.show) return '';
        let html = '';
        if (info.badge) {
            html += `<span class="je-lp-badge ${esc(info.badge.cssClass)}" title="${esc(info.badge.label)}">${info.badge.icon}<span class="je-lp-badge-text">${esc(info.badge.label)}</span></span>`;
        } else if (info.loading) {
            html += `<span class="je-lp-badge je-lp-badge-loading" aria-label="${esc(JE.t('listPlaceholders_status_loading'))}"><span class="je-lp-spinner"></span></span>`;
        }
        if (info.requestable) {
            const user = ctx.user;
            if (user && !user.active) {
                html += `<button type="button" class="je-lp-request" disabled>${esc(JE.t('jellyseerr_btn_offline'))}</button>`;
            } else if (user && !user.userFound) {
                html += `<button type="button" class="je-lp-request" disabled>${esc(JE.t('jellyseerr_btn_user_not_found'))}</button>`;
            } else if (user) {
                html += `<button type="button" class="je-lp-request"><span class="material-icons" aria-hidden="true">add_circle_outline</span><span>${esc(JE.t('jellyseerr_btn_request'))}</span></button>`;
            }
        }
        return html;
    }

    /**
     * The secondary line of a playlist row as text (subtitle parts + "Not in library", or "Partly in library" once
     * some of a show's episodes are in the list).
     * @param {Object} ph
     * @returns {string}
     */
    function rowSubtitle(ph) {
        const state = isPartlyFilled(ph) ? 'listPlaceholders_partly_in_library_short' : 'listPlaceholders_not_in_library_short';
        return subtitleParts(ph).concat(JE.t(state)).join(' · ');
    }

    /**
     * Markup of one playlist row. Rows deliberately avoid `.listItem`, `data-id` and
     * `.itemAction` so jellyfin-web's play-from-here indexing, context menus,
     * multi-select and Move indices never see them.
     * @param {Object} ph - Placeholder.
     * @param {{draggable?: boolean, canEdit?: boolean, tv?: boolean, seerrEnabled?: boolean, statusReady?: boolean, user?: Object}} ctx
     * @returns {string}
     */
    function rowHtml(ph, ctx) {
        const isCustom = ph.kind === 'custom';
        const sub = rowSubtitle(ph);
        const handle = ctx.draggable && !ctx.tv
            ? '<span class="listViewDragHandle material-icons listItemIcon listItemIcon-transparent drag_handle je-lp-drag" aria-hidden="true"></span>'
            : '';
        const menu = ctx.canEdit
            ? `<button type="button" class="je-lp-menu-btn" title="${esc(JE.t('listPlaceholders_menu'))}" aria-label="${esc(JE.t('listPlaceholders_menu'))}"><span class="material-icons" aria-hidden="true">more_vert</span></button>`
            : '';
        const note = ph.note ? `<span class="secondary listItemBodyText je-lp-note">${esc(ph.note)}</span>` : '';
        const attrs = [
            `data-je-lp-id="${esc(ph.id)}"`,
            `data-je-lp-kind="${esc(ph.kind)}"`,
            `data-je-lp-media="${esc(ph.mediaType)}"`,
            ph.tmdbId ? `data-je-lp-tmdb="${esc(ph.tmdbId)}"` : '',
            ph.seasonNumber !== null && ph.seasonNumber !== undefined ? `data-je-lp-season="${esc(ph.seasonNumber)}"` : ''
        ].filter(Boolean).join(' ');
        // TV layout rows have no divider (jellyfin-web renders them as focus-scaled buttons).
        return `<div class="je-lp-row${ctx.tv ? ' je-lp-row-tv' : ' listItem-border'}${isCustom ? ' je-lp-row-custom' : ''}" ${attrs}>`
            + handle
            + `<button type="button" class="je-lp-row-main${ctx.tv ? ' focusable' : ''}">`
            + `<span class="je-lp-thumb"><img loading="lazy" decoding="async" alt="" src="${esc(posterUrl(ph.posterPath, 'w92'))}"></span>`
            + '<span class="listItemBody je-lp-body">'
            + `<span class="listItemBodyText je-lp-title"><bdi>${esc(ph.title)}</bdi></span>`
            + `<span class="secondary listItemBodyText je-lp-sub">${esc(sub)}</span>`
            + note
            + '</span></button>'
            + `<span class="je-lp-status">${statusHtml(ph, ctx)}</span>`
            + menu
            + '</div>';
    }

    /**
     * Builds row elements for many placeholders with one parse.
     * @param {Array<Object>} placeholders
     * @param {Object} ctx - See rowHtml.
     * @returns {Map<string, HTMLElement>} placeholder id -> row element.
     */
    function buildRows(placeholders, ctx) {
        const template = document.createElement('template');
        template.innerHTML = placeholders.map(ph => rowHtml(ph, ctx)).join('');
        const rows = new Map();
        for (const el of Array.from(template.content.children)) rows.set(el.getAttribute('data-je-lp-id'), el);
        return rows;
    }

    /**
     * Synthetic Seerr item for createJellyseerrCard (B7: TMDB id coerced, mediaType whitelisted, flagged __jeLp).
     * @param {Object} ph
     * @returns {Object|null} null for custom entries or invalid ids.
     */
    function toSeerrItem(ph) {
        if (!ph || ph.kind === 'custom') return null;
        const id = Number(ph.tmdbId);
        const mediaType = ph.mediaType === 'tv' ? 'tv' : ph.mediaType === 'movie' ? 'movie' : null;
        if (!Number.isInteger(id) || id <= 0 || !mediaType) return null;
        let status = ph.status;
        if (JE.seerrStatus?.isRequestable(status) && lp.requests?.isRequested?.(ph)) status = JE.seerrStatus.MEDIA.PROCESSING;
        // Part of the show is in this library: never "Available" next to the progress chip.
        if (JE.seerrStatus && status === JE.seerrStatus.MEDIA.AVAILABLE && isPartlyFilled(ph)) status = JE.seerrStatus.MEDIA.PARTIALLY_AVAILABLE;
        let mediaInfo = status === null || status === undefined ? null : { status, status4k: 1 };
        const adding = addingItemId(ph);
        if (adding && JE.seerrStatus) {
            // Being swapped in: the card reads as available and its title links to the library item.
            mediaInfo = { status: JE.seerrStatus.MEDIA.AVAILABLE, status4k: 1, jellyfinMediaId: adding };
        }
        const item = {
            id,
            mediaType,
            title: ph.title,
            name: ph.title,
            posterPath: isSafePoster(ph.posterPath) ? ph.posterPath : null,
            overview: ph.overview || '',
            mediaInfo,
            __jeLp: true,
            __jeLpId: ph.id
        };
        if (DATE_RE.test(ph.releaseDate || '')) {
            if (mediaType === 'movie') item.releaseDate = ph.releaseDate;
            else item.firstAirDate = ph.releaseDate;
        }
        return item;
    }

    /**
     * The "…" button of a card (editors).
     * @returns {HTMLButtonElement}
     */
    function cardMenuButton() {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'je-lp-menu-btn je-lp-card-menu';
        button.title = JE.t('listPlaceholders_menu');
        button.setAttribute('aria-label', JE.t('listPlaceholders_menu'));
        button.innerHTML = '<span class="material-icons" aria-hidden="true">more_vert</span>';
        return button;
    }

    /**
     * Season/episodes cards: JE's Seerr card applies whole-show TV rules to the synthetic item (a requested
     * show keeps an enabled "Request"/"Pending" button), so a season that is already requested or available
     * gets the same disabled button as its playlist row (statusInfo) instead.
     * @param {HTMLElement} card
     * @param {Object} item - The card's synthetic Seerr item (status as shown).
     * @param {Object} ph
     */
    function lockSeasonRequestButton(card, item, ph) {
        const seerr = JE.seerrStatus;
        const status = item.mediaInfo?.status;
        if ((ph.kind !== 'season' && ph.kind !== 'episodes') || !seerr || seerr.isRequestable(status)) return;
        const button = card.querySelector('.jellyseerr-request-button');
        if (!button || button.disabled) return;
        const config = seerr.getButtonConfig(seerr.resolveDisplayStatus(status, false));
        const icon = JE.internals?.jellyseerrUi?.icons?.[config.iconKey] || '';
        button.disabled = true;
        button.innerHTML = `${icon}<span>${esc(JE.t(config.labelKey))}</span>`;
        button.classList.remove('jellyseerr-button-request', 'jellyseerr-button-pending', 'jellyseerr-button-partially-available');
        button.classList.add(config.cssClass);
    }

    /**
     * Collection card: JE's Seerr card (same look, hover overview, request button) plus a
     * kind/date chip, or a simple card for custom entries.
     * @param {Object} ph
     * @param {{canEdit?: boolean, seerrEnabled?: boolean, user?: Object, onRequest4k?: function(Object): void}} ctx -
     *   onRequest4k(ph) handles the card's "Request in 4K" (its popup lives outside the card).
     * @returns {HTMLElement}
     */
    function buildCard(ph, ctx) {
        const item = ctx.seerrEnabled && JE.jellyseerrUI?.createJellyseerrCard ? toSeerrItem(ph) : null;
        let card;
        if (item) {
            if (typeof ctx.onRequest4k === 'function') item.onRequest4k = () => ctx.onRequest4k(ph);
            card = JE.jellyseerrUI.createJellyseerrCard(item, !!ctx.user?.active, !!ctx.user?.userFound);
            lockSeasonRequestButton(card, item, ph);
            card.querySelector('.jellyseerr-rating')?.remove();
            const year = card.querySelector('.jellyseerr-meta bdi');
            if (year) year.textContent = dateLabel(ph);
        } else {
            card = document.createElement('div');
            card.className = 'card overflowPortraitCard card-withuserdata je-lp-card-custom';
            card.innerHTML = '<div class="cardBox cardBox-bottompadded">'
                + '<div class="cardScalable"><div class="cardPadder cardPadder-overflowPortrait"></div>'
                + `<div class="cardImageContainer coveredImage cardContent je-lp-card-image" style="background-image:url('${esc(posterUrl(ph.posterPath, 'w185'))}')"></div></div>`
                + `<div class="cardText cardTextCentered cardText-first"><bdi>${esc(ph.title)}</bdi></div>`
                + `<div class="cardText cardTextCentered cardText-secondary jellyseerr-meta je-lp-meta"><bdi>${esc(dateLabel(ph))}</bdi></div>`
                + '</div>';
        }
        // Same size as Jellyfin's own collection cards above the section.
        card.classList.remove('overflowPortraitCard');
        card.classList.add('portraitCard', 'je-lp-card');
        card.setAttribute('data-je-lp-id', ph.id);
        if (ph.tmdbId) card.setAttribute('data-je-lp-tmdb', String(ph.tmdbId));
        card.setAttribute('data-je-lp-media', ph.mediaType);
        if (ph.seasonNumber !== null && ph.seasonNumber !== undefined) card.setAttribute('data-je-lp-season', String(ph.seasonNumber));
        const chipText = (ph.kind === 'season' || ph.kind === 'episodes' || ph.kind === 'custom') ? kindLabel(ph) : '';
        const image = card.querySelector('.cardImageContainer');
        if (chipText && image) {
            const chip = document.createElement('div');
            chip.className = 'je-lp-kind-chip';
            chip.textContent = chipText;
            image.appendChild(chip);
        }
        // Bottom chip: "Available — adding…" while the swap runs, else the fill progress.
        const adding = addingItemId(ph);
        const progressText = adding ? JE.t('listPlaceholders_available_adding') : progressParts(ph).join(' · ');
        if (progressText && image) {
            const chip = document.createElement('div');
            chip.className = 'je-lp-progress-chip' + (adding ? ' je-lp-adding' : '');
            chip.textContent = progressText;
            chip.title = progressText;
            image.appendChild(chip);
        }
        if (ph.note) card.querySelector('.cardBox')?.setAttribute('title', ph.note);
        if (ctx.canEdit) {
            const meta = card.querySelector('.jellyseerr-meta');
            if (meta) meta.appendChild(cardMenuButton());
        }
        return card;
    }

    lp.render = {
        esc,
        isSafePoster,
        posterUrl,
        formatDate,
        episodeLabel,
        kindLabel,
        dateLabel,
        progressParts,
        isPartlyFilled,
        subtitleParts,
        rowSubtitle,
        addingItemId,
        statusInfo,
        statusHtml,
        rowHtml,
        buildRows,
        toSeerrItem,
        buildCard
    };

})(window.JellyfinEnhanced);
