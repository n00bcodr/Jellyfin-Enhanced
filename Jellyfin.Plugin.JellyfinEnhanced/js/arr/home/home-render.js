/**
 * @file Requests & downloads, phase 4d: drawing the home rows from a GET /JellyfinEnhanced/acquire/home
 * answer. Rows are jellyfin-web's own section structure (verticalSection, sectionTitleContainer,
 * emby-scroller, itemsContainer) with portrait cards that look like its own (card overflowPortraitCard)
 * but carry no data-id/data-type, so the poster-badge scanner and other card features leave them
 * alone. Each card is one focusable button (Enter opens it; D-pad and Tab move along the row).
 * Also the words of a card (one-word state, "S3E6 · Tomorrow", "New"), the poster overlays (shared
 * with the Home Screen Sections decoration) and the administrators' ops strip.
 * Exposes pieces on JE.internals.arrHome; registers nothing on its own.
 */
(function (JE) {
    'use strict';

    const R = (JE.internals = JE.internals || {}).arrHome = JE.internals.arrHome || {};

    /** The rows in display order: answer field, title key, Requests page link. */
    const ROWS = [
        { id: 'requests', title: 'home_row_requests', href: '#/requests' },
        { id: 'soon', title: 'home_row_soon', href: '#/requests?tab=soon' },
        { id: 'arrived', title: 'home_row_arrived', href: '#/requests?tab=ready' }
    ];
    const OVERVIEW_HREF = '#/requests?tab=overview';
    const ID_RE = /^[0-9a-f]{32}$/i;
    const POSTER_RE = /^\/[A-Za-z0-9_.-]+$/;

    /**
     * Translates with {name} parameters (through the shared status helper when it is there).
     * @param {string} key en.json key.
     * @param {Object<string, string|number>} [params] Parameters.
     * @returns {string} Text.
     */
    function tr(key, params) {
        if (JE.arrStatus?.tr) return JE.arrStatus.tr(key, params);
        const out = typeof JE.t === 'function' ? JE.t(key, params) : key;
        const text = typeof out === 'string' ? out : key;
        return params ? Object.entries(params).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text) : text;
    }

    /**
     * Creates an element.
     * @param {string} tag Tag.
     * @param {string} [cls] Classes.
     * @param {string} [text] Text (through textContent).
     * @returns {HTMLElement} Element.
     */
    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    /**
     * A material icon hidden from assistive technology (the words carry the meaning).
     * @param {string} name Icon name.
     * @param {string} [cls] Extra class.
     * @returns {HTMLElement} Icon.
     */
    function icon(name, cls) {
        const span = el('span', `material-icons${cls ? ' ' + cls : ''}`, name);
        span.setAttribute('aria-hidden', 'true');
        return span;
    }

    /**
     * A Jellyfin id without dashes, lower case ('' when it isn't one).
     * @param {*} id Id.
     * @returns {string} Normalised id.
     */
    function normalizeId(id) {
        const value = typeof id === 'string' ? id.replace(/-/g, '').toLowerCase() : '';
        return ID_RE.test(value) ? value : '';
    }

    /**
     * Parses a card's date: the calendar day ("yyyy-MM-dd", read in the viewer's time zone) when there
     * is one, else the instant.
     * @param {{day?: string, date?: string}} card Card.
     * @returns {Date|null} Date.
     */
    function cardDate(card) {
        const raw = card?.day || card?.date;
        if (!raw) return null;
        if (JE.arrStatus?.parseDate) return JE.arrStatus.parseDate(raw);
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw));
        const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(raw);
        return isNaN(d.getTime()) ? null : d;
    }

    /**
     * Whole days from the viewer's today to a date (0 today, 1 tomorrow, -1 yesterday).
     * @param {Date} d Date.
     * @param {Date} [now] Now.
     * @returns {number} Days.
     */
    function daysFromToday(d, now) {
        const today = now || new Date();
        const start = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
        return Math.round((start(d) - start(today)) / 86400000);
    }

    /**
     * A short date as the pills say it: "Today", "Tomorrow", "Fri 16" within the week, else "Nov 14"
     * (with the year when it isn't this year).
     * @param {Date|null} d Date.
     * @returns {string} Text ('' without a date).
     */
    function shortDate(d) {
        if (!d) return '';
        const now = new Date();
        const days = daysFromToday(d, now);
        if (days === 0) return tr('home_date_today');
        if (days === 1) return tr('home_date_tomorrow');
        if (days === -1) return tr('home_date_yesterday');
        if (days > 1 && days < 7) {
            return tr('home_date_weekday', { weekday: d.toLocaleDateString(undefined, { weekday: 'short' }), day: d.getDate() });
        }
        const sameYear = d.getFullYear() === now.getFullYear();
        return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
    }

    /**
     * "S3E6" for a card that names an episode ('' otherwise).
     * @param {{season?: number, episode?: number}} card Card.
     * @returns {string} Code.
     */
    function episodeCode(card) {
        return Number.isInteger(card?.season) && Number.isInteger(card?.episode) ? tr('home_episode_code', { season: card.season, episode: card.episode }) : '';
    }

    /**
     * The date a title waits for, from its status ("not out yet" reasons carry it) or the card.
     * @param {Object} card Card.
     * @returns {Date|null} Date.
     */
    function waitingDate(card) {
        const fromStatus = card?.status?.reason?.params?.date;
        if (fromStatus) {
            const d = JE.arrStatus?.parseDate ? JE.arrStatus.parseDate(fromStatus) : new Date(fromStatus);
            if (d && !isNaN(d.getTime())) return d;
        }
        return cardDate(card);
    }

    /**
     * The one-word state of a request ("Downloading", "Needs OK", "Airs Fri", "Nov 14"); '' without a status.
     * @param {Object} card Card.
     * @returns {string} Text.
     */
    function stateWord(card) {
        const status = card?.status;
        if (!status) return '';
        const code = status.reason?.code;
        if (status.attention) return tr('home_state_delayed');
        switch (status.stage) {
            case 'asked': return status.reason?.params?.held ? tr('home_state_stuck') : tr('home_state_needs_ok');
            case 'approved': return tr('home_state_approved');
            case 'notOut': {
                const date = shortDate(waitingDate(card));
                if (!date) return tr('home_state_not_out');
                return card.kind === 'tv' ? tr('home_state_airs', { date }) : date;
            }
            case 'looking': return tr('home_state_looking');
            case 'downloading': return code === 'queued' || code === 'delay_held' ? tr('home_state_queued') : tr('home_state_downloading');
            case 'almostReady': return tr('home_state_almost');
            case 'ready': return tr('home_state_ready');
            case 'notHere': return tr('home_state_not_here');
            default: return '';
        }
    }

    /**
     * The card's second line for its row: the state (Your requests), "S3E6 · Tomorrow" (Coming soon) or
     * "S9E5 · Episode title" / the year (Just arrived).
     * @param {string} row Row id.
     * @param {Object} card Card.
     * @returns {string} Text.
     */
    function lineText(row, card) {
        if (row === 'requests') return stateWord(card);
        if (row === 'soon') {
            const date = shortDate(cardDate(card) || waitingDate(card));
            return [episodeCode(card), date].filter(Boolean).join(' · ');
        }
        const code = episodeCode(card);
        if (code) return [code, typeof card.episodeTitle === 'string' ? card.episodeTitle.trim() : ''].filter(Boolean).join(' · ');
        return card?.year ? String(card.year) : '';
    }

    /**
     * A pill on the poster.
     * @param {string} cls Extra class.
     * @param {string} text Words.
     * @param {string} [iconName] Icon.
     * @returns {HTMLElement} Pill.
     */
    function pill(cls, text, iconName) {
        const p = el('span', `je-home-pill ${cls}`);
        if (iconName) p.appendChild(icon(iconName));
        p.appendChild(el('span', 'je-home-pill-text', text));
        return p;
    }

    /**
     * The poster overlay for a card in a row: the download ring / attention / almost-ready badge or a
     * date pill (Your requests), a date pill (Coming soon), "New" (Just arrived). Null when there is
     * nothing to show.
     * @param {string} row Row id.
     * @param {Object} card Card.
     * @param {string} [corner] Poster corner (default top-right; see freeCorner).
     * @returns {HTMLElement|null} Overlay.
     */
    function overlay(row, card, corner) {
        const box = el('div', ['je-home-overlay', ...(corner || 'top-right').split(' ').map(c => `je-home-overlay-${c}`)].join(' '));
        if (row === 'requests') {
            const badge = card?.status && JE.arrStatus?.buildBadge ? JE.arrStatus.buildBadge(card.status) : null;
            if (badge) {
                box.appendChild(badge);
            } else if (card?.status?.stage === 'notOut') {
                const date = shortDate(waitingDate(card));
                if (date) box.appendChild(pill('je-home-pill-date', date, 'event'));
            }
        } else if (row === 'soon') {
            const date = shortDate(cardDate(card) || waitingDate(card));
            if (date) box.appendChild(pill('je-home-pill-date', date));
        } else if (row === 'arrived') {
            box.appendChild(pill('je-home-pill-new', tr('home_new')));
        }
        return box.childNodes.length ? box : null;
    }

    /** JE poster tags and their default corners (tag-pipeline's own defaults). */
    const TAG_CORNERS = [['quality', 'top-left'], ['genre', 'top-right'], ['language', 'bottom-left'], ['rating', 'bottom-right'], ['ageRating', 'bottom-right']];

    /**
     * The poster corner for the overlay on a card that also carries JE's poster tags (Home Screen Sections'
     * cards): top-right as in JE's own rows when no enabled tag sits there, else the first corner none uses,
     * else bottom-left raised above whatever sits there. Read like the tag pipeline reads them.
     * @returns {string} Corner ("top-right", "bottom-left raised", ...).
     */
    function freeCorner() {
        const used = new Set();
        for (const [name, fallback] of TAG_CORNERS) {
            if (!JE.currentSettings?.[`${name}TagsEnabled`]) continue;
            const plugin = `${name.charAt(0).toUpperCase()}${name.slice(1)}TagsPosition`;
            used.add(JE.currentSettings?.[`${name}TagsPosition`] || JE.pluginConfig?.[plugin] || fallback);
        }
        return ['top-right', 'top-left', 'bottom-left', 'bottom-right'].find(c => !used.has(c)) || 'bottom-left raised';
    }

    /**
     * The poster URL of a card: the person's own Jellyfin item, else the TMDB poster, else null.
     * @param {{itemId?: string, poster?: string}} card Card.
     * @returns {string|null} URL.
     */
    function posterUrl(card) {
        // An arrived episode opens the episode, but its Jellyfin image is a (spoiler) still: the series poster
        // instead (posterItemId when the server names it, else TMDB's).
        const episode = card?.kind === 'tv' && Number.isInteger(card?.episode);
        const tmdb = typeof card?.poster === 'string' && POSTER_RE.test(card.poster) ? `https://image.tmdb.org/t/p/w300${card.poster}` : null;
        const id = normalizeId(card?.posterItemId) || (episode && tmdb ? '' : normalizeId(card?.itemId));
        if (id && typeof ApiClient !== 'undefined' && typeof ApiClient.getImageUrl === 'function') {
            return ApiClient.getImageUrl(id, { type: 'Primary', maxHeight: 400, quality: 90 });
        }
        return tmdb;
    }

    /**
     * Opens a card: its Jellyfin page when the person can open one, else the title's native details
     * page (when offered) or Seerr's more-info modal (as the Requests page does).
     * @param {Object} card Card.
     * @returns {void}
     */
    function openCard(card) {
        const id = normalizeId(card?.itemId);
        if (id) {
            if (window.Emby?.Page?.showItem) window.Emby.Page.showItem(id);
            else window.location.hash = `#/details?id=${encodeURIComponent(id)}`;
            return;
        }
        const mediaType = card?.kind === 'tv' ? 'tv' : 'movie';
        if (JE.titleDetails?.show) {
            if (card?.tmdbId) JE.titleDetails.show(card.tmdbId, mediaType);
            else if (card?.key) JE.titleDetails.openKey(card.key, { mediaType });
            return;
        }
        if (card?.tmdbId && JE.jellyseerrMoreInfo?.open) JE.jellyseerrMoreInfo.open(card.tmdbId, mediaType, undefined, JE.NATIVE);
    }

    /**
     * Goes to a Requests page address (the page itself when it runs, else the plain link).
     * @param {string} href Address.
     * @returns {void}
     */
    function goRequests(href) {
        if (JE.arrHub?.show) {
            history.pushState({ page: 'requests' }, '', href);
            JE.arrHub.show();
        } else {
            window.location.hash = href;
        }
    }

    /**
     * True when the Requests page is on (its rows can link there).
     * @returns {boolean} On.
     */
    function hubOn() {
        return JE.pluginConfig?.ArrRequestsHubEnabled === true && !!JE.arrHub?.show;
    }

    /**
     * One card: a focusable button with the poster, the overlay, the title and one more line.
     * @param {string} row Row id.
     * @param {Object} card Card from the answer.
     * @returns {HTMLButtonElement} Card.
     */
    function buildCard(row, card) {
        const title = typeof card?.title === 'string' && card.title.trim() ? card.title.trim() : tr('home_untitled');
        const line = lineText(row, card);
        const node = /** @type {HTMLButtonElement} */ (el('button', 'card overflowPortraitCard card-hoverable je-home-card'));
        node.type = 'button';
        node.dataset.jeFocus = `${row}:${card?.key || title}`;
        node.dataset.jeHomeKey = card?.key || '';
        node.setAttribute('aria-label', line ? `${title}, ${line}` : title);
        const box = el('div', 'cardBox cardBox-bottompadded');
        const scalable = el('div', 'cardScalable');
        scalable.appendChild(el('div', 'cardPadder cardPadder-overflowPortrait'));
        // An <img>, not a background image: JE's poster tags and other card features key off Jellyfin image
        // URLs in background images, and these cards carry only their own overlay (as in the mock).
        const url = posterUrl(card);
        const poster = el('div', `je-home-poster${url ? '' : ' je-home-poster-empty'}`);
        if (url) {
            const img = /** @type {HTMLImageElement} */ (el('img', 'je-home-poster-img'));
            img.alt = '';
            img.loading = 'lazy';
            img.decoding = 'async';
            img.src = url;
            img.addEventListener('error', () => {
                img.remove();
                poster.classList.add('je-home-poster-empty');
                poster.appendChild(icon(card?.kind === 'tv' ? 'tv' : 'movie'));
            }, { once: true });
            poster.appendChild(img);
        } else {
            poster.appendChild(icon(card?.kind === 'tv' ? 'tv' : 'movie'));
        }
        scalable.appendChild(poster);
        const over = overlay(row, card);
        if (over) scalable.appendChild(over);
        box.appendChild(scalable);
        const first = el('div', 'cardText cardTextCentered cardText-first');
        first.appendChild(el('bdi', '', title));
        box.appendChild(first);
        const second = el('div', 'cardText cardTextCentered cardText-secondary');
        second.appendChild(el('bdi', '', line || '\u00a0'));
        box.appendChild(second);
        node.appendChild(box);
        node.addEventListener('click', () => openCard(card));
        return node;
    }

    /**
     * Scroll arrows for mouse users (hover-capable devices only; touch, keyboard and D-pad scroll natively).
     * @param {HTMLElement} section Row.
     * @param {HTMLElement} scroller Scroller.
     * @returns {void}
     */
    function scrollArrows(section, scroller) {
        const make = (dir) => {
            const b = /** @type {HTMLButtonElement} */ (el('button', `je-home-scroll-btn je-home-${dir}`));
            b.type = 'button';
            b.tabIndex = -1;
            b.setAttribute('aria-hidden', 'true');
            b.appendChild(icon(`chevron_${dir}`));
            b.addEventListener('click', () => scroller.scrollBy({ left: (dir === 'left' ? -1 : 1) * scroller.clientWidth * 0.8, behavior: 'smooth' }));
            section.appendChild(b);
            return b;
        };
        const left = make('left');
        const right = make('right');
        const update = () => {
            const rtl = getComputedStyle(scroller).direction === 'rtl';
            const pos = Math.abs(scroller.scrollLeft);
            const more = pos < scroller.scrollWidth - scroller.clientWidth - 4;
            left.classList.toggle('je-home-show', rtl ? more : pos > 4);
            right.classList.toggle('je-home-show', rtl ? pos > 4 : more);
            const image = scroller.querySelector('.cardScalable');
            if (image) left.style.top = right.style.top = `${Math.round(scroller.offsetTop + image.offsetTop + image.offsetHeight / 2 - 22)}px`;
        };
        scroller.addEventListener('scroll', update, { passive: true });
        section.addEventListener('mouseenter', update);
    }

    /**
     * One row: jellyfin-web's section structure with a title (a link to the Requests page when it is on)
     * and a horizontal scroller of cards.
     * @param {{id: string, title: string, href: string}} spec Row.
     * @param {Object[]} cards Cards.
     * @returns {HTMLElement} Row.
     */
    function buildRow(spec, cards) {
        const section = el('div', `verticalSection emby-scroller-container je-home-row je-home-row-${spec.id}`);
        section.dataset.jeHomeRow = spec.id;
        const head = el('div', 'sectionTitleContainer sectionTitleContainer-cards padded-left');
        const heading = el('h2', 'sectionTitle sectionTitle-cards', tr(spec.title));
        if (hubOn()) {
            const link = /** @type {HTMLAnchorElement} */ (el('a', 'button-flat button-flat-mini sectionTitleTextButton emby-button je-home-title-link'));
            link.href = spec.href;
            link.dataset.jeFocus = `title:${spec.id}`;
            link.appendChild(heading);
            link.appendChild(icon('chevron_right'));
            link.addEventListener('click', (e) => {
                e.preventDefault();
                goRequests(spec.href);
            });
            head.appendChild(link);
        } else {
            head.appendChild(heading);
        }
        section.appendChild(head);
        const scroller = el('div', 'padded-top-focusscale padded-bottom-focusscale emby-scroller je-home-scroller');
        scroller.dataset.horizontal = 'true';
        scroller.dataset.centerfocus = 'card';
        const items = el('div', 'itemsContainer scrollSlider focuscontainer-x je-home-items');
        for (const card of cards) items.appendChild(buildCard(spec.id, card));
        scroller.appendChild(items);
        section.appendChild(scroller);
        scrollArrows(section, scroller);
        return section;
    }

    /**
     * The administrators' ops strip: "↓ 6 downloading · ⚠ 1 import blocked · ▣ /movies4k 94%", a link to
     * the Requests page's Overview; null when there is nothing that needs doing.
     * @param {Object|null} ops GET /arr/admin/home/ops answer.
     * @returns {HTMLElement|null} Strip.
     */
    function buildOps(ops) {
        if (!ops || ops.actionable !== true) return null;
        const parts = [];
        const n = v => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
        if (n(ops.downloading)) parts.push(['download', tr('home_ops_downloading', { count: n(ops.downloading) })]);
        if (n(ops.importBlocked)) parts.push(['warning', tr('home_ops_import_blocked', { count: n(ops.importBlocked) })]);
        if (n(ops.attention)) parts.push(['report', n(ops.attention) === 1 ? tr('home_ops_attention_one') : tr('home_ops_attention', { count: n(ops.attention) })]);
        for (const disk of Array.isArray(ops.disks) ? ops.disks.slice(0, 3) : []) {
            if (typeof disk?.name !== 'string' || !Number.isFinite(disk.usedPercent)) continue;
            parts.push(['storage', tr('home_ops_disk', { name: disk.name, pct: Math.round(disk.usedPercent) })]);
        }
        if (!parts.length) return null;
        const strip = el('div', 'je-home-ops');
        const link = /** @type {HTMLAnchorElement} */ (el('a', 'je-home-ops-link'));
        link.href = OVERVIEW_HREF;
        link.dataset.jeFocus = 'ops';
        link.setAttribute('aria-label', `${tr('home_ops_label')}: ${parts.map(p => p[1]).join(', ')}`);
        parts.forEach(([iconName, text], i) => {
            if (i) link.appendChild(el('span', 'je-home-ops-sep', '·'));
            const part = el('span', 'je-home-ops-part');
            part.appendChild(icon(iconName));
            part.appendChild(el('span', '', text));
            link.appendChild(part);
        });
        link.addEventListener('click', (e) => {
            e.preventDefault();
            goRequests(OVERVIEW_HREF);
        });
        strip.appendChild(link);
        return strip;
    }

    /**
     * Fills the rows' container: the ops strip, then each row that is on and has cards.
     * @param {HTMLElement} wrap Container.
     * @param {Object} data Answer (rows already filtered for what the person hid).
     * @param {Object|null} ops Ops answer.
     * @param {{rows?: boolean}} [options] rows false: the ops strip only (Home Screen Sections draws the rows).
     * @returns {number} Rows drawn.
     */
    function fill(wrap, data, ops, options) {
        wrap.textContent = '';
        const strip = buildOps(ops);
        if (strip) wrap.appendChild(strip);
        let drawn = 0;
        if (options?.rows === false) return drawn;
        for (const spec of ROWS) {
            const cards = data?.[spec.id];
            if (!Array.isArray(cards) || !cards.length) continue;
            wrap.appendChild(buildRow(spec, cards));
            drawn++;
        }
        return drawn;
    }

    Object.assign(R, {
        ROWS, tr, el, icon, normalizeId, freeCorner, cardDate, shortDate, episodeCode, stateWord, lineText, overlay,
        posterUrl, openCard, buildCard, buildRow, buildOps, fill
    });
})(window.JellyfinEnhanced);
