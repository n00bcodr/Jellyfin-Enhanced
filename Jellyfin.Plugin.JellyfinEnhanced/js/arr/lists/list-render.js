/**
 * @file Requests & downloads, phase 4c3a: drawing list entries that aren't in the library (playlist rows, collection
 * cards), their styles and the Spoiler Guard policy applied before anything is painted.
 *
 * Rows deliberately carry no `.listItem`, `data-id`, `data-action` or `.itemAction`, so jellyfin-web's play-from-here,
 * play-all, multi-select, context menus and its drag indices never see them; they can't be played. Every string from
 * the server (titles, notes, episode titles) is set as text, never as markup. Request status is the shared one
 * (JE.arrStatus pills and wording); list completion (filled/expected/aired) is said separately from it, and a status
 * the server didn't send is unknown, never Ready.
 *
 * Spoiler Guard: nothing is painted before the person's Spoiler Guard state is known (JE.spoilerBlur.whenLoaded): each
 * page's ticket carries its policy, and the paint gate (list-paint.js) paints only with a resolved one.
 * An entry is guarded when Spoiler Guard is on and the person guards its title (a pending guard from Seerr, or the
 * library copy's series/movie, mapped by TMDB id), the collection page it is on, or when the state couldn't be read
 * (fails closed). A guarded entry shows no episode titles and no note (the list editor's free text may give the story
 * away) in its text, tooltips or labels, and, while Spoiler Guard hides air dates (the admin's "premiere date" strip
 * and the person's own "hide air dates", as on the server), no air date either: no "Coming <date>", and no year for a
 * season or episode. Overviews are never drawn on list pages.
 *
 * A library match (inLibraryItemId) reads "Available, adding it…" only while swap-in is on and running for the list;
 * otherwise (an imported list, swap-in off, the list reconciling) it reads "In your library", with nothing promised.
 *
 * The page header (jellyfin-web's played button): Jellyfin calls a list played when it has no unplayed real item, so a
 * list of entries only reads as watched. While a page draws entries, {@link headerMark} keeps that button from looking
 * played (the colour, and its tooltip says how many titles aren't in the library). Played state is never changed.
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.arrListPages = JE.internals.arrListPages || {};

    const STYLE_ID = 'je-arr-list-pages-styles';
    const POSTER_RE = /^\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/;
    const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
    const ID_RE = /^[0-9a-f]{32}$/;
    /** Stages a Request button is offered for (nothing asked, nothing on its way); unknown (no status) too. */
    const REQUESTABLE_STAGES = new Set(['notHere', 'none']);

    const CSS = `
.je-list-row { display: flex; align-items: center; gap: 0.25em; padding: 0.25em 0.25em 0.25em 0.5em; position: relative; content-visibility: auto; contain-intrinsic-block-size: auto 5.75em; }
.je-list-handle-space { visibility: hidden; }
/* TV: jellyfin-web's D-pad goes to the nearest focusable to the right, and a full-width real row below counts at no
   distance; Request sits right after the entry, so Right reaches it first (then the status pill). */
.layout-tv .je-list-row .je-list-side .je-list-request { order: -1; }
.layout-tv .je-list-row .je-list-side { margin-left: 0.25em; }
.je-list-row-main { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 0.75em; padding: 0.25em 0; margin: 0; background: transparent; border: 0; color: inherit; font: inherit; text-align: start; }
button.je-list-row-main { cursor: pointer; }
.je-list-row-main:focus-visible, .layout-tv .je-list-row-main:focus { outline: 2px solid var(--jf-palette-primary-main, #00a4dc); outline-offset: -2px; border-radius: 0.3em; }
.layout-tv .je-list-row-main:focus { background-color: var(--jf-palette-action-focus, rgba(128, 128, 128, 0.3)); }
.je-list-thumb { width: 3.4em; height: 5.1em; flex-shrink: 0; border-radius: 0.2em; overflow: hidden; background: rgba(128, 128, 128, 0.18); display: flex; align-items: center; justify-content: center; }
.je-list-thumb img { width: 100%; height: 100%; object-fit: cover; opacity: 0.7; filter: grayscale(0.35); }
.je-list-thumb .material-icons { opacity: 0.6; }
.je-list-body { min-width: 0; display: flex; flex-direction: column; gap: 0.1em; }
.je-list-body > span { display: block; overflow: hidden; text-overflow: ellipsis; }
.je-list-title { opacity: 0.9; white-space: nowrap; }
.je-list-sub { white-space: normal; }
.je-list-note { font-style: italic; white-space: normal; display: -webkit-box !important; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
.je-list-status-line { display: none !important; }
.je-list-absent { display: inline-flex; align-items: center; gap: 0.25em; opacity: 0.8; }
.je-list-absent .material-icons { font-size: 1.05em; }
.je-list-side { display: flex; align-items: center; gap: 0.5em; flex-shrink: 0; margin: 0 0.5em; }
.je-list-side .je-arr-status { margin: 0; max-width: 18em; }
.je-list-side .je-arr-admin, .je-list-card .je-arr-admin { display: none; }
.je-list-request { display: inline-flex; align-items: center; justify-content: center; gap: 0.3em; min-height: 2.4em; padding: 0.4em 0.9em; border: 0; border-radius: 999px; background: var(--jf-palette-primary-main, #00a4dc); color: #fff; font: inherit; font-size: 0.9em; font-weight: 600; cursor: pointer; white-space: nowrap; }
.je-list-request:disabled { opacity: 0.6; cursor: default; }
.je-list-request:focus-visible, .layout-tv .je-list-request:focus { outline: 3px solid #fff; outline-offset: 2px; }
.je-list-request .material-icons { font-size: 1.2em; }
.je-list-adding { color: #52b54b; font-weight: 600; text-decoration: none; display: inline-flex; align-items: center; gap: 0.25em; }
.je-list-in-library { color: inherit; opacity: 0.85; text-decoration: none; display: inline-flex; align-items: center; gap: 0.25em; }
.je-list-adding .material-icons, .je-list-in-library .material-icons { font-size: 1.15em; }
/* A list whose real items are all played while entries are still missing: Jellyfin's header doesn't read as played. */
.je-list-incomplete-page .btnPlaystate .playstatebutton-icon-played { color: inherit !important; }
.je-list-section { margin-top: 1em; }
.je-list-section .sectionTitle { display: flex; align-items: baseline; gap: 0.5em; }
.je-list-section-count { font-size: 0.7em; opacity: 0.7; font-weight: normal; }
.je-list-card { container-type: inline-size; }
.je-list-card-box { display: flex; flex-direction: column; align-items: stretch; gap: 0.3em; }
.je-list-card-main { position: relative; display: flex; align-items: center; justify-content: center; width: 100%; padding: 0; margin: 0; border: 0; background: rgba(128, 128, 128, 0.18); border-radius: 0.3em; overflow: hidden; aspect-ratio: 2 / 3; color: inherit; font: inherit; }
.je-list-card-main > .material-icons { font-size: 3em; opacity: 0.5; }
button.je-list-card-main { cursor: pointer; }
.je-list-card-main img { width: 100%; height: 100%; object-fit: cover; opacity: 0.7; filter: grayscale(0.35); display: block; }
.je-list-card-main:focus-visible, .layout-tv .je-list-card-main:focus { outline: 3px solid var(--jf-palette-primary-main, #00a4dc); outline-offset: 2px; }
.je-list-chip { position: absolute; left: 0.4em; max-width: calc(100% - 0.8em); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0.15em 0.55em; border-radius: 999px; background: rgba(0, 0, 0, 0.72); color: #fff; font-size: 0.75em; font-weight: 600; }
.je-list-chip-kind { top: 0.4em; }
.je-list-chip-fill { bottom: 0.4em; }
.je-list-card-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.je-list-card-sub { white-space: normal; }
.je-list-card .je-arr-status { margin: 0; display: flex; justify-content: center; }
.je-list-card .je-arr-pill { font-size: 0.75em; max-width: 100%; }
.je-list-card .je-list-request { align-self: center; font-size: 0.8em; }
.card.je-list-incomplete .cardIndicators .playedIndicator { display: none !important; }
.je-list-grid-indicator { display: inline-flex !important; align-items: center; gap: 0.15em; width: auto !important; min-width: 1.6em; padding: 0 0.45em; border-radius: 999px !important; background: #e5a00d !important; color: #111 !important; font-weight: 700; }
.je-list-grid-indicator .material-icons { font-size: 1.1em; }
@container (max-width: 8.5em) {
  .je-list-card .je-list-status { display: none; }
  .je-list-card .je-list-status-line { display: block !important; }
  .je-list-card .je-list-request > span:not(.material-icons) { display: none; }
}
@media all and (max-width: 50em) {
  .je-list-side .je-list-status { display: none; }
  .je-list-row .je-list-status-line { display: block !important; }
  .je-list-request > span:not(.material-icons) { display: none; }
  .je-list-request { padding: 0.4em; min-width: 44px; min-height: 44px; }
  .je-list-side { margin: 0 0.25em; gap: 0.35em; }
}
@media all and (max-width: 40em) {
  .je-list-thumb { width: 2.8em; height: 4.2em; }
}
`;

    /** Injects the styles once (never while the pages are off). */
    function ensureStyles() {
        JE.internals?.arrStatusStyles?.ensure?.();
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    /**
     * Translates with {name} parameters (the shared status helper when present).
     * @param {string} key en.json key.
     * @param {Object} [params] Parameters.
     * @returns {string} Text.
     */
    function tr(key, params) {
        if (JE.arrStatus?.tr) return JE.arrStatus.tr(key, params);
        const out = typeof JE.t === 'function' ? JE.t(key, params) : key;
        return typeof out === 'string' ? out : key;
    }

    /**
     * A count-dependent translation: en.json keeps "singular|plural" in one string (JE's pattern); a count of 1 picks
     * the first form, any other count the last.
     * @param {string} key en.json key.
     * @param {Object} params Parameters.
     * @param {string} [countKey] The parameter that decides the form.
     * @returns {string} Text.
     */
    function tn(key, params, countKey = 'count') {
        const forms = tr(key, params).split('|');
        return (Number(params?.[countKey]) === 1 ? forms[0] : forms[forms.length - 1]).trim();
    }

    /**
     * A 32-hex id ("N" form) or null.
     * @param {*} id Id in N or D form.
     * @returns {string|null} Id.
     */
    function normalizeId(id) {
        const value = String(id || '').replace(/-/g, '').toLowerCase();
        return ID_RE.test(value) ? value : null;
    }

    /**
     * Creates an element with a class and optional text (text only, never markup).
     * @param {string} tag Tag.
     * @param {string} [cls] Class names.
     * @param {string} [text] Text.
     * @returns {HTMLElement} Element.
     */
    function el(tag, cls, text) {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    /**
     * A Material icon span (decorative).
     * @param {string} name Icon name.
     * @returns {HTMLElement} Span.
     */
    function icon(name) {
        const node = el('span', 'material-icons', name);
        node.setAttribute('aria-hidden', 'true');
        return node;
    }

    /**
     * A TMDB poster URL for a plain TMDB path, or null.
     * @param {*} path Poster path.
     * @param {string} size TMDB size.
     * @returns {string|null} URL.
     */
    function posterUrl(path, size) {
        return typeof path === 'string' && POSTER_RE.test(path) ? `https://image.tmdb.org/t/p/${size}${path}` : null;
    }

    /**
     * A yyyy-MM-dd date in the page's language ("23 Oct 2026").
     * @param {string} iso Date.
     * @returns {string} Text.
     */
    function formatDate(iso) {
        const m = DATE_RE.exec(iso || '');
        if (!m) return '';
        const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
        try {
            return date.toLocaleDateString(document.documentElement.getAttribute('lang') || undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
        } catch {
            return iso;
        }
    }

    /**
     * A non-negative whole count (0 for anything else).
     * @param {*} value Value.
     * @returns {number} Count.
     */
    function count(value) {
        const n = Number(value);
        return Number.isInteger(n) && n > 0 ? n : 0;
    }

    /**
     * Two-digit number.
     * @param {number} n Number.
     * @returns {string} Text.
     */
    function pad2(n) {
        return String(n).padStart(2, '0');
    }

    /**
     * The scope of an episodes entry: S01E08, S01E08–E10, S01E08, E10 or "S01 · 5 episodes".
     * @param {Object} ph Entry.
     * @returns {string} Label.
     */
    function episodeLabel(ph) {
        const season = Number(ph.seasonNumber) || 0;
        const numbers = (ph.episodes || []).map(e => Number(e?.e)).filter(Number.isFinite).sort((a, b) => a - b);
        if (!numbers.length) return `S${pad2(season)}`;
        if (numbers.length === 1) return `S${pad2(season)}E${pad2(numbers[0])}`;
        if (numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1)) return `S${pad2(season)}E${pad2(numbers[0])}–E${pad2(numbers[numbers.length - 1])}`;
        if (numbers.length <= 3) return `S${pad2(season)}` + numbers.map((n, i) => (i ? ', ' : '') + 'E' + pad2(n)).join('');
        return `S${pad2(season)} · ${tn('arr_lists_episodes', { count: numbers.length })}`;
    }

    /**
     * What an entry stands for: Movie, Series, Season 1, Specials, S01E08, Custom entry.
     * @param {Object} ph Entry.
     * @returns {string} Label.
     */
    function kindLabel(ph) {
        switch (ph.kind) {
            case 'movie': return tr('arr_lists_kind_movie');
            case 'series': return tr('arr_lists_kind_series');
            case 'season': return Number(ph.seasonNumber) === 0 ? tr('arr_lists_kind_specials') : tr('arr_lists_kind_season', { number: ph.seasonNumber });
            case 'episodes': return episodeLabel(ph);
            default: return tr('arr_lists_kind_custom');
        }
    }

    /**
     * Whether Spoiler Guard keeps an entry's air date from the person (guarded entry, air dates hidden).
     * @param {Object} ph Entry.
     * @param {Object} [ctx] Context (guarded, from {@link spoilerPolicy}).
     * @returns {boolean} Hidden.
     */
    function airDateHidden(ph, ctx) {
        return ctx?.guarded?.(ph) === true && ctx.guarded.airDates === true;
    }

    /**
     * Release text: the year once out, "Coming <date>" before, "Date to be announced" without one (a season or
     * episodes entry without its own date is TBA: the year it carries is the show's). With its air date guarded: a
     * released movie or show keeps its year, nothing else is said.
     * @param {Object} ph Entry.
     * @param {Object} [ctx] Context (guarded).
     * @returns {string} Text, or empty for custom entries without a date.
     */
    function dateLabel(ph, ctx) {
        const m = DATE_RE.exec(ph.releaseDate || '');
        if (airDateHidden(ph, ctx)) {
            if (ph.kind === 'season' || ph.kind === 'episodes' || !ph.released) return '';
            return m ? m[1] : ph.year ? String(ph.year) : '';
        }
        if (m) return ph.released ? m[1] : tr('arr_lists_coming', { date: formatDate(ph.releaseDate) });
        if (ph.year && ph.kind !== 'season' && ph.kind !== 'episodes') return String(ph.year);
        return ph.kind === 'custom' ? '' : tr('arr_lists_tba');
    }

    /**
     * List completion of a TV entry (separate from where its request stands): "3 of 8 aired in the list · 2 to come",
     * "2 of 5 episodes", "3 in the list". Movies and custom entries have none.
     * @param {Object} ph Entry (filledCount, expectedCount, airedCount, episodeTotal).
     * @returns {string[]} Parts.
     */
    function fillParts(ph) {
        const filled = count(ph.filledCount);
        const expected = count(ph.expectedCount);
        if (ph.kind === 'season' || ph.kind === 'series') {
            if (expected > 0) {
                const aired = Math.min(count(ph.airedCount), expected);
                const parts = [];
                // None of it in the list yet: how many episodes it has (aired), not "0 of N".
                if (filled === 0) {
                    if (aired > 0) parts.push(tn('arr_lists_episodes', { count: aired }));
                } else if (aired > 0) parts.push(tr('arr_lists_fill_aired', { filled, aired }));
                else parts.push(tr('arr_lists_fill_in_list', { count: filled }));
                if (expected > aired) parts.push(tr('arr_lists_fill_upcoming', { count: expected - aired }));
                return parts;
            }
            const total = count(ph.episodeTotal);
            if (filled > 0) return [total > 0 ? tn('arr_lists_fill_of', { filled, total }, 'total') : tr('arr_lists_fill_in_list', { count: filled })];
            return total > 0 ? [tn('arr_lists_episodes', { count: total })] : [];
        }
        if (ph.kind === 'episodes' && filled > 0) {
            return [expected > 0 ? tn('arr_lists_fill_of', { filled, total: expected }, 'total') : tr('arr_lists_fill_in_list', { count: filled })];
        }
        return [];
    }

    /**
     * The library item that matched an entry, only when the server named one (and the person may open it).
     * @param {Object} ph Entry.
     * @returns {string|null} Item id.
     */
    function libraryItemId(ph) {
        return ph?.inLibraryItemId ? normalizeId(ph.inLibraryItemId) : null;
    }

    /**
     * Whether the matched item is being added to the list now: swap-in on and running (not while reconciling).
     * @param {Object} ph Entry.
     * @param {Object} ctx Context (swapActive).
     * @returns {boolean} Adding.
     */
    function addingNow(ph, ctx) {
        return !!libraryItemId(ph) && ctx?.swapActive === true;
    }

    /**
     * The shared request status of an entry when the view shows statuses, else null (unknown: never Ready).
     * @param {Object} ph Entry.
     * @param {Object} ctx Context (statusShown).
     * @returns {Object|null} Status.
     */
    function statusOf(ph, ctx) {
        if (!ctx?.statusShown) return null;
        const status = ph?.status;
        return status && typeof status === 'object' && typeof status.stage === 'string' ? status : null;
    }

    /**
     * Whether this person may press Request on the entry now: the server offers it (ph.actions), the title isn't
     * asked for or on its way (by the shared status; unknown counts as askable, the server decides), it isn't being
     * swapped in, and the shared status doesn't say Missing (D25: that is Search, not a new request).
     * @param {Object} ph Entry.
     * @param {Object} ctx Context.
     * @returns {boolean} Offered.
     */
    function canRequest(ph, ctx) {
        if (!ctx?.requests || !Array.isArray(ph?.actions) || !ph.actions.includes('request') || libraryItemId(ph)) return false;
        const status = statusOf(ph, ctx);
        if (!status) return true;
        if (JE.arrStatus?.searchable?.(status)) return false;
        return REQUESTABLE_STAGES.has(status.stage) && status.attention !== true;
    }

    /**
     * The secondary line of an entry: kind, the single episode's title (unless guarded), completion, release text, and
     * "Not in your library" unless its status says it is ready.
     * @param {Object} ph Entry.
     * @param {Object} ctx Context (guarded, statusShown).
     * @returns {string} Text.
     */
    function subtitle(ph, ctx) {
        const parts = [kindLabel(ph)];
        const guarded = ctx?.guarded?.(ph) === true;
        if (!guarded && ph.kind === 'episodes' && (ph.episodes || []).length === 1 && typeof ph.episodes[0]?.title === 'string' && ph.episodes[0].title) {
            parts.push(ph.episodes[0].title);
        }
        parts.push(...fillParts(ph));
        parts.push(dateLabel(ph, ctx));
        return parts.filter(Boolean).join(' · ');
    }

    /**
     * The status block of an entry: its library match ("Available, adding it…" while a swap-in runs, else "In your
     * library"), else the shared pill (icon, family words, journey), else nothing (not shown, or unknown).
     * @param {Object} ph Entry.
     * @param {Object} ctx Context.
     * @returns {HTMLElement|null} Block.
     */
    function statusBlock(ph, ctx) {
        const match = libraryItemId(ph);
        if (match) {
            const adding = addingNow(ph, ctx);
            const link = el('a', adding ? 'je-list-adding' : 'je-list-in-library');
            link.href = `#/details?id=${match}`;
            link.appendChild(icon(adding ? 'library_add_check' : 'video_library'));
            link.appendChild(el('span', null, tr(adding ? 'arr_lists_adding' : 'arr_lists_in_library')));
            return link;
        }
        const status = statusOf(ph, ctx);
        if (!status || typeof JE.arrStatus?.buildPill !== 'function') return null;
        try {
            const block = JE.arrStatus.buildPill(status, ctx.statusContext || {});
            block.classList.add('je-list-status');
            // Where the words are hidden for room (phones, narrow cards) the pill still says them.
            const pill = block.querySelector('.je-arr-pill');
            const words = pill?.querySelector('.je-arr-pill-text')?.textContent || '';
            if (pill && words) {
                pill.title = words;
                if (!pill.hasAttribute('aria-label')) pill.setAttribute('aria-label', words);
            }
            // TV: the journey pill (a button) is reachable with the D-pad like the rest of the row.
            if (ctx.tv && pill?.tagName === 'BUTTON') pill.classList.add('focusable');
            return block;
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: Lists: status pill failed', err);
            return null;
        }
    }

    /**
     * The status in words, for narrow screens where the pill would be an icon only (null: no status shown).
     * @param {Object} ph Entry.
     * @param {Object} ctx Context.
     * @param {string} cls Class names.
     * @returns {HTMLElement|null} Line.
     */
    function statusLine(ph, ctx, cls) {
        const status = statusOf(ph, ctx);
        if (!status || libraryItemId(ph) || typeof JE.arrStatus?.familyText !== 'function') return null;
        const line = el('span', cls, JE.arrStatus.familyText(status, ctx.statusContext || {}));
        // The pill (beside it, with the same words as its label) is what assistive tech reads.
        line.setAttribute('aria-hidden', 'true');
        return line;
    }

    /**
     * The Request button of an entry, or null when it isn't offered.
     * @param {Object} ph Entry.
     * @param {Object} ctx Context.
     * @returns {HTMLButtonElement|null} Button.
     */
    function requestButton(ph, ctx) {
        if (!canRequest(ph, ctx)) return null;
        const button = /** @type {HTMLButtonElement} */ (el('button', 'je-list-request'));
        button.type = 'button';
        button.dataset.jeListRequest = ph.id;
        const label = tr('arr_lists_request_title', { title: ph.title || '' });
        button.setAttribute('aria-label', label);
        button.title = label;
        button.appendChild(icon('add'));
        button.appendChild(el('span', null, tr('arr_lists_request')));
        return button;
    }

    /**
     * The poster of an entry (TMDB) or a neutral icon.
     * @param {Object} ph Entry.
     * @param {string} size TMDB size.
     * @param {Object} [ctx] Context (its ticket paints the icon of a poster that can't load).
     * @returns {HTMLElement} Image or icon.
     */
    function poster(ph, size, ctx) {
        const url = posterUrl(ph.posterPath, size);
        if (!url) return icon(ph.kind === 'custom' ? 'notes' : ph.mediaType === 'tv' ? 'tv' : 'movie');
        const img = /** @type {HTMLImageElement} */ (el('img'));
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        // A poster that can't load (offline, blocked) gives way to the neutral icon, never a broken image.
        img.addEventListener('error', () => lp.gate.paint(ctx?.ticket, () => img.replaceWith(icon(ph.mediaType === 'tv' ? 'tv' : 'movie')), 'poster'), { once: true });
        img.src = url;
        return img;
    }

    /**
     * The note line of an entry: the editor's text, or a line saying Spoiler Guard hides it.
     * @param {Object} ph Entry.
     * @param {Object} ctx Context.
     * @param {string} cls Class names.
     * @returns {HTMLElement|null} Line.
     */
    function noteLine(ph, ctx, cls) {
        if (typeof ph.note !== 'string' || !ph.note.trim()) return null;
        if (ctx?.guarded?.(ph) === true) return el('span', cls, tr('arr_lists_note_hidden'));
        const line = el('span', cls, ph.note);
        // Long notes are cut to a few lines; the whole note stays in the tooltip.
        line.title = ph.note;
        return line;
    }

    /**
     * Whether the entry opens a title page (it names a title; custom entries don't).
     * @param {Object} ph Entry.
     * @returns {boolean} Opens.
     */
    function opensTitle(ph) {
        return ph.kind !== 'custom' && typeof ph.titleKey === 'string' && ph.titleKey.length > 0;
    }

    /**
     * One playlist row. No `.listItem`, `data-id`, `data-action`, `.itemAction` or drag handle: Jellyfin's playing,
     * selecting, menus and drag never pick it up.
     * @param {Object} ph Entry.
     * @param {Object} ctx Context (tv, statusShown, statusContext, requests, guarded).
     * @returns {HTMLElement} Row.
     */
    function row(ph, ctx) {
        const node = el('div', `je-list-row${ctx.tv ? ' je-list-row-tv' : ' listItem-border'}`);
        node.dataset.jeListId = ph.id;
        node.dataset.jeListToken = `p:${ph.id}`;
        node.dataset.jeListKind = ph.kind;
        if (ctx.handleSpace && !ctx.tv) {
            const space = el('span', 'listItemIcon listItemIcon-transparent material-icons je-list-handle-space', 'drag_handle');
            space.setAttribute('aria-hidden', 'true');
            node.appendChild(space);
        }
        const main = el(opensTitle(ph) ? 'button' : 'div', 'je-list-row-main');
        if (main.tagName === 'BUTTON') {
            /** @type {HTMLButtonElement} */ (main).type = 'button';
            if (ctx.tv) main.classList.add('focusable');
        }
        const thumb = el('span', 'je-list-thumb');
        thumb.appendChild(poster(ph, 'w92', ctx));
        main.appendChild(thumb);
        const body = el('span', 'listItemBody je-list-body');
        const title = el('span', 'listItemBodyText je-list-title');
        title.appendChild(el('bdi', null, ph.title || ''));
        body.appendChild(title);
        const sub = subtitle(ph, ctx);
        body.appendChild(el('span', 'secondary listItemBodyText je-list-sub', sub));
        const status = statusOf(ph, ctx);
        // "Not in your library" when nothing else says where it stands (no status shown, or none known).
        const absent = status || libraryItemId(ph) ? null : el('span', 'secondary listItemBodyText je-list-absent');
        if (absent) {
            absent.appendChild(icon('cloud_off'));
            absent.appendChild(el('span', null, tr('arr_lists_not_in_library')));
            body.appendChild(absent);
        }
        const words = statusLine(ph, ctx, 'secondary listItemBodyText je-list-status-line');
        if (words) body.appendChild(words);
        const note = noteLine(ph, ctx, 'secondary listItemBodyText je-list-note');
        if (note) body.appendChild(note);
        main.appendChild(body);
        main.setAttribute('aria-label', [ph.title || '', sub, absent ? tr('arr_lists_not_in_library') : ''].filter(Boolean).join(', '));
        node.appendChild(main);
        const side = el('span', 'je-list-side');
        const block = statusBlock(ph, ctx);
        if (block) side.appendChild(block);
        const request = requestButton(ph, ctx);
        if (request) {
            if (ctx.tv) request.classList.add('focusable');
            side.appendChild(request);
        }
        node.appendChild(side);
        return node;
    }

    /**
     * One collection card (poster, kind and completion chips, title, release text, status and Request).
     * @param {Object} ph Entry.
     * @param {Object} ctx Context.
     * @returns {HTMLElement} Card.
     */
    function card(ph, ctx) {
        // Jellyfin's own card classes (portraitCard in a vertical-wrap container): the same size as the collection's
        // real cards at every width. No data-id / itemAction: Jellyfin's card actions, menus and selection skip it.
        const node = el('div', 'card portraitCard je-list-card');
        node.dataset.jeListId = ph.id;
        node.dataset.jeListKind = ph.kind;
        const box = el('div', 'cardBox cardBox-bottompadded je-list-card-box');
        node.appendChild(box);
        const main = el(opensTitle(ph) ? 'button' : 'div', 'je-list-card-main');
        if (main.tagName === 'BUTTON') {
            /** @type {HTMLButtonElement} */ (main).type = 'button';
            if (ctx.tv) main.classList.add('focusable');
        }
        main.appendChild(poster(ph, 'w185', ctx));
        if (ph.kind === 'season' || ph.kind === 'episodes' || ph.kind === 'custom') main.appendChild(el('span', 'je-list-chip je-list-chip-kind', kindLabel(ph)));
        const fill = fillParts(ph).join(' · ');
        if (fill) main.appendChild(el('span', 'je-list-chip je-list-chip-fill', fill));
        const sub = [dateLabel(ph, ctx), statusOf(ph, ctx) || libraryItemId(ph) ? '' : tr('arr_lists_not_in_library')].filter(Boolean).join(' · ');
        main.setAttribute('aria-label', [ph.title || '', kindLabel(ph), fill, sub].filter(Boolean).join(', '));
        box.appendChild(main);
        const title = el('div', 'cardText cardTextCentered cardText-first je-list-card-title');
        title.appendChild(el('bdi', null, ph.title || ''));
        box.appendChild(title);
        box.appendChild(el('div', 'cardText cardTextCentered cardText-secondary je-list-card-sub', sub));
        const words = statusLine(ph, ctx, 'cardText cardTextCentered cardText-secondary je-list-card-sub je-list-status-line');
        if (words) box.appendChild(words);
        const note = noteLine(ph, ctx, 'cardText cardTextCentered cardText-secondary je-list-card-sub je-list-note');
        if (note) box.appendChild(note);
        const block = statusBlock(ph, ctx);
        if (block) box.appendChild(block);
        const request = requestButton(ph, ctx);
        if (request) {
            if (ctx.tv) request.classList.add('focusable');
            box.appendChild(request);
        }
        return node;
    }

    /**
     * What a row or card shows, for re-drawing only those that changed.
     * @param {Object} ph Entry.
     * @param {Object} ctx Context.
     * @returns {string} Signature.
     */
    function signature(ph, ctx) {
        let status = '';
        try {
            status = JSON.stringify(statusOf(ph, ctx));
        } catch {
            status = '?';
        }
        return [ph.title, ph.note, ph.posterPath, ph.releaseDate, ph.released, ph.filledCount, ph.expectedCount, ph.airedCount,
            ph.inLibraryItemId, (ph.actions || []).join(','), (ph.episodes || []).map(e => `${e?.e}:${e?.title || ''}`).join(','),
            status, ctx?.guarded?.(ph) ? 'g' : '', airDateHidden(ph, ctx) ? 'd' : '', ctx?.swapActive ? 's' : '', ctx?.requests ? 'r' : '',
            ctx?.tv ? 't' : '', ctx?.handleSpace ? 'h' : ''].join('|');
    }

    // ------------------------------------------------------------------ Spoiler Guard

    /** @type {{epoch: number, ids: string, tmdb: Set<string>|null, promise: Promise<Set<string>|null>|null}} */
    let guardMap = { epoch: -1, ids: '', tmdb: null, promise: null };

    /**
     * The current session epoch.
     * @returns {number} Epoch.
     */
    function epoch() {
        return JE.session?.getEpoch ? JE.session.getEpoch() : 0;
    }

    /**
     * The TMDB keys ("tv:1234", "movie:55") of the library series and movies the person guards with Spoiler Guard,
     * read once per set of guarded titles (one Jellyfin call); null when it can't be read.
     * @returns {Promise<Set<string>|null>} Keys.
     */
    async function guardedTmdb() {
        const sg = JE.spoilerBlur;
        const ids = typeof sg?.guardedIds === 'function' ? sg.guardedIds() : null;
        if (!ids) return null;
        const all = [...(ids.series || []), ...(ids.movies || [])].map(normalizeId).filter(Boolean).sort();
        if (!all.length) return new Set();
        const key = all.join(',');
        const now = epoch();
        if (guardMap.epoch === now && guardMap.ids === key && (guardMap.tmdb || guardMap.promise)) return guardMap.tmdb || guardMap.promise;
        const promise = (async () => {
            try {
                const out = new Set();
                for (let i = 0; i < all.length; i += 100) {
                    const result = await ApiClient.getItems(ApiClient.getCurrentUserId(), { Ids: all.slice(i, i + 100).join(','), Fields: 'ProviderIds', EnableImages: false, EnableUserData: false });
                    for (const item of result?.Items || []) {
                        const tmdb = item?.ProviderIds?.Tmdb || item?.ProviderIds?.tmdb;
                        if (!tmdb) continue;
                        out.add(`${item.Type === 'Movie' ? 'movie' : 'tv'}:${tmdb}`);
                    }
                }
                return out;
            } catch (err) {
                console.warn('🪼 Jellyfin Enhanced: Lists: Spoiler Guard titles could not be read; guarding every entry', err);
                return null;
            }
        })();
        guardMap = { epoch: now, ids: key, tmdb: null, promise };
        const tmdb = await promise;
        if (guardMap.promise === promise) guardMap = { epoch: now, ids: key, tmdb, promise: null };
        return tmdb;
    }

    /**
     * A resolved guard test with whether it hides air dates (the paint gate's).
     * @param {function(Object): boolean} test guarded(entry).
     * @param {boolean} airDates Guarded entries lose their air dates.
     * @returns {function(Object): boolean & {airDates: boolean, resolved: boolean}} Policy.
     */
    function policy(test, airDates) {
        return lp.gate.policy(test, airDates);
    }

    /**
     * The policy when it is known without waiting: Spoiler Guard off (nothing guarded). Else null (load it).
     * @returns {(function(Object): boolean & {airDates: boolean, resolved: boolean})|null} Policy.
     */
    function knownPolicy() {
        return JE.pluginConfig?.SpoilerBlurEnabled !== true || !JE.spoilerBlur ? policy(() => false, false) : null;
    }

    /**
     * Reads the Spoiler Guard state needed to draw a list (before anything is painted) and returns the guard test.
     * With Spoiler Guard off nothing is guarded; when its state or the guarded titles can't be read, everything is
     * (air dates too). Air dates of guarded entries are hidden as the server strips them: the admin's premiere-date
     * strip on and the person's "hide air dates" not turned off.
     * @param {{listKind: string, listId: string}} list The list.
     * @returns {Promise<function(Object): boolean & {airDates: boolean, resolved: boolean}>} guarded(entry), with .airDates.
     */
    async function spoilerPolicy(list) {
        const known = knownPolicy();
        if (known) return known;
        const sg = JE.spoilerBlur;
        try {
            await sg.whenLoaded?.();
        } catch {
            return policy(() => true, true);
        }
        if (sg.isLoadOk?.() !== true) return policy(() => true, true);
        let prefs = null;
        try {
            prefs = sg.getUserPrefs?.() || null;
        } catch {
            prefs = null;
        }
        const airDates = JE.pluginConfig?.SpoilerStripPremiereDate !== false && prefs?.HideAirDate !== false;
        if (list.listKind === 'collection' && sg.isCollectionEnabledFor?.(list.listId) === true) return policy(() => true, airDates);
        const tmdb = await guardedTmdb();
        return policy((ph) => {
            if (!ph || ph.kind === 'custom' || !ph.tmdbId) return tmdb === null;
            const media = ph.mediaType === 'movie' ? 'movie' : 'tv';
            if (sg.isTmdbEnabled?.(media, ph.tmdbId) === true) return true;
            return tmdb === null || tmdb.has(`${media}:${ph.tmdbId}`);
        }, tmdb === null ? true : airDates);
    }

    // ------------------------------------------------------------------ the page header

    const HEADER_CLASS = 'je-list-incomplete-page';

    /**
     * Keeps jellyfin-web's played button of a list page from reading as played while the page draws entries (its own
     * state, click and UserData are left alone): the page gets a class (the icon loses the played colour) and a played
     * button's tooltip says how many titles aren't in the library. Follows jellyfin-web setting its state again.
     * Jellyfin's own title is kept from before JE's first label, through count changes, and put back on clear.
     * Writes go through the page's ticket (set) or the gate's erase (clear).
     * @param {HTMLElement} page Details page.
     * @param {function(): Object} ticketOf The controller's current ticket.
     * @returns {{set: function(number): void, clear: function(): void}} Handle.
     */
    function headerMark(page, ticketOf) {
        let label = '';
        let observer = null;
        /** @param {HTMLElement} button Jellyfin's played button. */
        const relabel = (button) => {
            if (!label || !button.classList.contains('playstatebutton-played')) return;
            if (button.title === label) return;
            // A title JE set (another count) is not Jellyfin's: the one saved before stays.
            if (!button.__jeListLabel || button.title !== button.__jeListLabel) button.__jeListTitle = button.title;
            button.__jeListLabel = label;
            button.title = label;
        };
        const buttons = () => Array.from(page.querySelectorAll('.btnPlaystate'));
        const clear = () => {
            observer?.disconnect();
            observer = null;
            label = '';
            lp.gate.erase(() => {
                page.classList.remove(HEADER_CLASS);
                for (const button of buttons()) {
                    if (button.__jeListLabel && button.title === button.__jeListLabel) button.title = button.__jeListTitle || '';
                    delete button.__jeListTitle;
                    delete button.__jeListLabel;
                }
            });
        };
        const set = (missing) => {
            if (!(missing > 0)) {
                if (label || page.classList.contains(HEADER_CLASS)) clear();
                return;
            }
            lp.gate.paint(ticketOf(), () => {
                ensureStyles();
                label = tn('arr_lists_header_incomplete', { count: missing });
                page.classList.add(HEADER_CLASS);
                const list = buttons();
                list.forEach(relabel);
                if (!observer && list.length && typeof MutationObserver !== 'undefined') {
                    // Jellyfin setting its state again: relabelled through the gate (a page not current is left alone).
                    observer = new MutationObserver((records) => {
                        lp.gate.paint(ticketOf(), () => {
                            for (const record of records) relabel(/** @type {HTMLElement} */ (record.target));
                        }, 'header-follow');
                    });
                    for (const button of list) observer.observe(button, { attributes: true, attributeFilter: ['class', 'title'] });
                }
            }, 'header');
        };
        return { set, clear };
    }

    JE.session?.onUserChange?.('arr-list-render', () => {
        guardMap = { epoch: -1, ids: '', tmdb: null, promise: null };
    });

    lp.render = {
        ensureStyles, tr, tn, normalizeId, el, icon, posterUrl, formatDate, episodeLabel, kindLabel, dateLabel, fillParts,
        libraryItemId, addingNow, airDateHidden, statusOf, canRequest, subtitle, statusBlock, statusLine, requestButton, row,
        card, signature, opensTitle, spoilerPolicy, knownPolicy, guardedTmdb, headerMark, STYLE_ID
    };
})(window.JellyfinEnhanced);
