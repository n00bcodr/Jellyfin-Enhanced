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
        return `S${pad2(season)} · ${JE.t('listPlaceholders_episode_count', { count: numbers.length })}`;
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
     * Release text: the year once released, "Coming <date>" before, "TBA" without a date.
     * @param {Object} ph
     * @returns {string}
     */
    function dateLabel(ph) {
        const m = DATE_RE.exec(ph.releaseDate || '');
        if (m) {
            if (ph.released) return m[1];
            return JE.t('listPlaceholders_coming', { date: formatDate(ph.releaseDate) });
        }
        if (ph.year) return String(ph.year);
        return JE.t('listPlaceholders_tba');
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
        if ((ph.kind === 'season' || ph.kind === 'series') && ph.episodeTotal > 0) {
            parts.push(ph.filledCount > 0
                ? JE.t('listPlaceholders_episodes_of', { filled: ph.filledCount, total: ph.episodeTotal })
                : JE.t('listPlaceholders_episode_count', { count: ph.episodeTotal }));
        }
        parts.push(dateLabel(ph));
        return parts.filter(Boolean);
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
        const display = seerr.resolveDisplayStatus(status, false);
        const config = seerr.getBadgeConfig(display);
        const badge = config ? { icon: config.icon, cssClass: config.cssClass, label: JE.t(seerr.getChipConfig(display).labelKey) } : null;
        return { show: true, loading: false, requestable: seerr.isRequestable(status), badge };
    }

    /**
     * Badge + request button markup of a row (re-rendered in place when statuses change).
     * @param {Object} ph
     * @param {Object} ctx - Row context (seerrEnabled, statusReady, user: {active, userFound}).
     * @returns {string}
     */
    function statusHtml(ph, ctx) {
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
     * Markup of one playlist row. Rows deliberately avoid `.listItem`, `data-id` and
     * `.itemAction` so jellyfin-web's play-from-here indexing, context menus,
     * multi-select and Move indices never see them.
     * @param {Object} ph - Placeholder.
     * @param {{draggable?: boolean, canEdit?: boolean, tv?: boolean, seerrEnabled?: boolean, statusReady?: boolean, user?: Object}} ctx
     * @returns {string}
     */
    function rowHtml(ph, ctx) {
        const isCustom = ph.kind === 'custom';
        const sub = subtitleParts(ph).concat(JE.t('listPlaceholders_not_in_library_short')).join(' · ');
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
        const item = {
            id,
            mediaType,
            title: ph.title,
            name: ph.title,
            posterPath: isSafePoster(ph.posterPath) ? ph.posterPath : null,
            overview: ph.overview || '',
            mediaInfo: status === null || status === undefined ? null : { status, status4k: 1 },
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
     * Collection card: JE's Seerr card (same look, hover overview, request button) plus a
     * kind/date chip, or a simple card for custom entries.
     * @param {Object} ph
     * @param {{canEdit?: boolean, seerrEnabled?: boolean, user?: Object}} ctx
     * @returns {HTMLElement}
     */
    function buildCard(ph, ctx) {
        const item = ctx.seerrEnabled && JE.jellyseerrUI?.createJellyseerrCard ? toSeerrItem(ph) : null;
        let card;
        if (item) {
            card = JE.jellyseerrUI.createJellyseerrCard(item, !!ctx.user?.active, !!ctx.user?.userFound);
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
        subtitleParts,
        statusInfo,
        statusHtml,
        rowHtml,
        buildRows,
        toSeerrItem,
        buildCard
    };

})(window.JellyfinEnhanced);
