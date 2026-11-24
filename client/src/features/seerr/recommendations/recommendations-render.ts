// /js/jellyseerr/recommendations/recommendations-render.js
// Recommendations Page: media rows, studio/network/genre tile rows and the content renderer shared
// by the standalone page, Plugin Pages and the custom/native tabs.
import { bindToSession, filterOf, translate, type SeerrDiscoveryHost } from '../host-discovery';
import { isAbortError } from '../discovery/domain';
import type { FeedKind, GenreSliderEntry, ProfilesHost, SeerrResult } from '../discovery/types';
import { FILTER_MODULE, LOG_PREFIX, PAGE_ID, part, recommendationsHost } from './stage';
import type { CatalogEntry, RecommendationsStage, RenderOwner, RowResult } from './types';
import { createCustomElement } from '../../shared/dom';

// Tile colour by genre name, shared across movie/TV since names overlap.
const GENRE_COLORS: ReadonlyMap<string, string> = new Map([
    ['Action', '#b91c1ccc'], ['Action & Adventure', '#b91c1ccc'], ['Adventure', '#7c3aedcc'], ['Animation', '#0891b2cc'],
    ['Comedy', '#d97706cc'], ['Crime', '#1d4ed8cc'], ['Documentary', '#059669cc'], ['Drama', '#db2777cc'],
    ['Family', '#65a30dcc'], ['Fantasy', '#9333eacc'], ['History', '#78716ccc'], ['Horror', '#27272acc'],
    ['Kids', '#f59e0bcc'], ['Music', '#e11d48cc'], ['Mystery', '#4c1d95cc'], ['News', '#334155cc'],
    ['Reality', '#c026d3cc'], ['Romance', '#ec4899cc'], ['Sci-Fi & Fantasy', '#2563ebcc'], ['Science Fiction', '#2563ebcc'],
    ['Soap', '#db2777cc'], ['Talk', '#0d9488cc'], ['Thriller', '#7f1d1dcc'], ['TV Movie', '#6b7280cc'],
    ['War', '#57534ecc'], ['War & Politics', '#57534ecc'], ['Western', '#b45309cc']
]);
const GENRE_COLOR_FALLBACK = '#4338ca';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: Element): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    parent?.appendChild(node);
    return node;
}

/**
 * Keeps a position:sticky bar flush under Jellyfin's header. The header's height differs per layout
 * and theme, so it is measured and re-read on scroll/resize. Also sets --je-bleed-l/-r (the parent's
 * side padding, for a full-width backdrop) and toggles .je-stuck while pinned. Stops itself once the
 * bar leaves the document.
 */
function trackStickyBar(JE: SeerrDiscoveryHost, bar: HTMLElement): () => void {
    let observedHeader: Element | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let frame = 0;
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    function stop(): void {
        document.removeEventListener('scroll', schedule, { capture: true });
        window.removeEventListener('resize', schedule);
        resizeObserver?.disconnect();
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
    }
    function measure(): void {
        frame = 0;
        if (!bar.isConnected || !bar.parentElement) { stop(); return; }
        const header = JE.helpers?.getHeaderElement?.() ?? null;
        if (header !== observedHeader && typeof ResizeObserver !== 'undefined') {
            resizeObserver?.disconnect();
            observedHeader = header;
            if (header) {
                resizeObserver = new ResizeObserver(schedule);
                resizeObserver.observe(header);
            }
        }
        const headerBottom = JE.helpers?.getHeaderBottom?.() ?? 0;
        bar.style.setProperty('--je-sticky-top', headerBottom ? `${headerBottom}px` : '');
        const padding = getComputedStyle(bar.parentElement);
        bar.style.setProperty('--je-bleed-l', padding.paddingLeft);
        bar.style.setProperty('--je-bleed-r', padding.paddingRight);
        const stickyTop = parseFloat(getComputedStyle(bar).top) || 0;
        bar.classList.toggle('je-stuck', bar.getBoundingClientRect().top <= stickyTop + 1);
    }
    // Capture: the scrolling element differs between Jellyfin layouts.
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    measure();
    return stop;
}

/**
 * Hover scroll arrows and edge fades for a horizontal row. Purely a mouse convenience: the row stays
 * natively scrollable (keyboard, touch, trackpad), so the buttons are hidden from AT and Tab.
 */
function enableRowScroll(section: HTMLElement, scroller: HTMLElement, owner?: RenderOwner): void {
    const makeButton = (direction: 'left' | 'right') => {
        const button = element('button', `je-scroll-btn ${direction}`, section);
        button.type = 'button';
        button.tabIndex = -1;
        button.setAttribute('aria-hidden', 'true');
        const icon = element('span', 'je-msym-rounded', button);
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = `chevron_${direction}`;
        button.addEventListener('click', () => {
            scroller.scrollBy({ left: (direction === 'left' ? -1 : 1) * scroller.clientWidth * 0.8, behavior: 'smooth' });
        });
        return button;
    };
    const left = makeButton('left');
    const right = makeButton('right');
    const update = () => {
        const canLeft = scroller.scrollLeft > 4;
        const canRight = scroller.scrollLeft < scroller.scrollWidth - scroller.clientWidth - 4;
        scroller.classList.toggle('je-fade-l', canLeft);
        scroller.classList.toggle('je-fade-r', canRight);
        left.classList.toggle('show', canLeft);
        right.classList.toggle('show', canRight);
        // Centre the arrows on the card images rather than the whole row.
        const items = scroller.firstElementChild;
        const image = scroller.querySelector('.cardScalable');
        if (items instanceof HTMLElement && image instanceof HTMLElement) {
            const middle = scroller.offsetTop + items.offsetTop + image.offsetTop + image.offsetHeight / 2;
            left.style.top = right.style.top = `${Math.round(middle - 22)}px`;
        }
    };
    scroller.addEventListener('scroll', update, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
        // Cards arrive after the row is built, so watch the content size too.
        const observer = new ResizeObserver(update);
        observer.observe(scroller);
        if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
        owner?.disposers.push(() => observer.disconnect());
    }
    const frame = requestAnimationFrame(update);
    owner?.disposers.push(() => cancelAnimationFrame(frame));
}
interface RowShell { section: HTMLElement; scroller: HTMLElement; items: HTMLElement; finish(owner?: RenderOwner): HTMLElement }
/** The horizontal row layout of the Seerr search-results row, with its scroller still to fill. */
function createRowShell(): RowShell {
    const section = element('div', 'verticalSection emby-scroller-container je-recommendations-section');
    const scroller = createCustomElement('div', 'emby-scroller');
    scroller.className = 'padded-top-focusscale padded-bottom-focusscale emby-scroller';
    scroller.dataset.horizontal = 'true';
    scroller.dataset.centerfocus = 'card';
    const items = createCustomElement('div', 'emby-itemscontainer');
    items.className = 'focuscontainer-x itemsContainer scrollSlider je-pad-left je-pad-right';
    scroller.appendChild(items);
    return {
        section, scroller, items,
        finish(owner) {
            section.appendChild(scroller);
            enableRowScroll(section, scroller, owner);
            return section;
        }
    };
}
/**
 * Keeps a mouse drag of a tile row from opening the tile under the cursor on release: a click is dropped once
 * the pointer has moved more than 8px since the press, even if it came back. Keyboard and touch are untouched.
 */
function preventTileDragClicks(scroller: HTMLElement): void {
    let press: { id: number; x: number; y: number } | null = null;
    let dragged = false;
    const moved = (event: MouseEvent, from: { x: number; y: number }) => Math.hypot(event.clientX - from.x, event.clientY - from.y) > 8;
    scroller.addEventListener('pointerdown', event => {
        press = event.pointerType === 'mouse' && event.button === 0 ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
        dragged = false;
    }, true);
    scroller.addEventListener('pointermove', event => {
        if (press && event.pointerId === press.id && moved(event, press)) dragged = true;
    }, true);
    scroller.addEventListener('pointercancel', () => { press = null; }, true);
    scroller.addEventListener('click', event => {
        // detail is 0 for a keyboard activation.
        const suppress = event.detail > 0 && press !== null && (dragged || moved(event, press));
        press = null;
        if (!suppress) return;
        event.preventDefault();
        // Capture runs before the tile's own category handler.
        event.stopImmediatePropagation();
    }, true);
}
function plainHeading(section: HTMLElement, title: string): void {
    const heading = element('h2', 'sectionTitle sectionTitle-cards focuscontainer-x je-pad-left je-pad-right', section);
    heading.textContent = title;
}
/** A tile's card markup. The overlay is disabled so Jellyfin's click delegation leaves it alone. */
function createTile(items: HTMLElement, imageClass: string): HTMLElement {
    const tile = element('div', 'card overflowBackdropCard card-hoverable card-withuserdata je-recommendations-tile', items);
    const box = element('div', 'cardBox cardBox-bottompadded', tile);
    const scalable = element('div', 'cardScalable', box);
    element('div', 'cardPadder cardPadder-overflowBackdrop', scalable);
    const image = element('div', `cardImageContainer cardContent ${imageClass}`, scalable);
    image.style.cursor = 'pointer';
    element('div', 'cardOverlayContainer', scalable).style.pointerEvents = 'none';
    return image;
}

function createRows(JE: SeerrDiscoveryHost, P: RecommendationsStage) {
    const showCategory = (categoryKey: string) => {
        part(P, 'showCategoryPage')(categoryKey).catch(error => console.error(`${LOG_PREFIX} Failed to open category`, error));
    };

    function createMediaRow(title: string, results: SeerrResult[], viewAllKey?: string, owner?: RenderOwner): HTMLElement {
        const shell = createRowShell();
        if (viewAllKey) {
            // href is intentionally "#", not a real path: emby-linkbutton navigates on its href
            // regardless of preventDefault, and a real path 404s against jellyfin-web's router.
            const link = createCustomElement('a', 'emby-linkbutton');
            link.className = 'more button-flat button-flat-mini sectionTitleTextButton emby-button je-pad-left je-pad-right';
            shell.section.appendChild(link);
            link.href = '#';
            element('h2', 'sectionTitle sectionTitle-cards', link).textContent = title;
            const chevron = element('span', 'material-icons chevron_right', link);
            chevron.setAttribute('aria-hidden', 'true');
            link.addEventListener('click', event => {
                event.preventDefault();
                showCategory(viewAllKey);
            });
        } else {
            plainHeading(shell.section, title);
        }
        shell.items.appendChild(filterOf(JE).createCardsFragment(results, { cardClass: 'overflowPortraitCard' }));
        return shell.finish(owner);
    }
    /** Studio/network tiles: the entry's TMDB logo, or a plain text tile if the image fails. */
    function createTileRow(title: string, items: readonly CatalogEntry[], kind: 'studio' | 'network', owner?: RenderOwner): HTMLElement {
        const shell = createRowShell();
        preventTileDragClicks(shell.scroller);
        plainHeading(shell.section, title);
        for (const item of items) {
            const image = createTile(shell.items, 'je-tile-image');
            image.style.backgroundColor = '#fff';
            image.addEventListener('click', () => showCategory(`${kind}-${item.id}`));
            const fallback = element('span', 'je-tile-fallback-text', image);
            fallback.textContent = item.name;
            if (item.logo) {
                const logo = element('img', 'je-tile-logo');
                logo.src = `https://image.tmdb.org/t/p/w300${item.logo}`;
                logo.alt = item.name;
                logo.loading = 'lazy';
                logo.style.cssText = 'width: auto; height: auto; max-width: 90%; max-height: 90%; object-fit: contain;';
                logo.onerror = () => { image.replaceChildren(fallback); };
                image.replaceChildren(logo);
            }
        }
        return shell.finish(owner);
    }
    /** Genre tiles: a colour-tinted backdrop with the name overlaid, no backdrop repeated in the row. */
    function createGenreTileRow(title: string, genres: readonly GenreSliderEntry[], mediaType: FeedKind, owner?: RenderOwner): HTMLElement {
        const shell = createRowShell();
        preventTileDragClicks(shell.scroller);
        plainHeading(shell.section, title);
        const usedBackdrops = new Set<string>();
        for (const genre of genres) {
            const backdrop = genre.backdrops.find(path => !usedBackdrops.has(path)) ?? genre.backdrops[0];
            if (backdrop) usedBackdrops.add(backdrop);
            const image = createTile(shell.items, 'je-genre-tile-image');
            image.style.backgroundColor = GENRE_COLORS.get(genre.name) ?? GENRE_COLOR_FALLBACK;
            image.addEventListener('click', () => showCategory(`genre-${mediaType}-${genre.id}`));
            if (backdrop) {
                const img = element('img', 'je-genre-tile-backdrop', image);
                img.src = `https://image.tmdb.org/t/p/w500${backdrop}`;
                img.alt = '';
                img.loading = 'lazy';
                img.onerror = () => img.remove();
            }
            element('span', 'je-genre-tile-title', image).textContent = genre.name;
        }
        return shell.finish(owner);
    }
    return { createMediaRow, createTileRow, createGenreTileRow };
}

(function () {
    'use strict';
    const { JE, P } = recommendationsHost();
    const rows = createRows(JE, P);
    const text = (key: string) => translate(JE, key);
    const trackBar = (bar: HTMLElement) => trackStickyBar(JE, bar);

    /** Ends the container's previous render and any render whose container has gone. */
    function beginRender(container: HTMLElement): RenderOwner {
        const state = part(P, 'state');
        part(P, 'disposeRender')(container);
        part(P, 'sweepRenders')();
        const controller = new AbortController();
        bindToSession(JE, controller);
        const owner: RenderOwner = { container, controller, disposers: [] };
        state.renders.set(container, owner);
        if (container.closest(`#${PAGE_ID}`)) {
            state.currentAbortController?.abort();
            state.currentAbortController = controller;
        }
        return owner;
    }
    /** The page's title bar: its heading, and at its end the page's filters (see toolbarControls). */
    function appendHeading(owner: RenderOwner): { bar: HTMLElement; tools: HTMLElement } {
        const bar = element('div', 'je-recommendations-title je-reco-header je-pad-left je-pad-right', owner.container);
        const heading = element('h1', 'je-reco-heading', bar);
        const logo = element('img', 'je-reco-logo', heading);
        logo.alt = '';
        logo.src = JE.cdn?.selfhst('svg/seerr.svg') ?? '';
        element('span', '', heading).textContent = text('recommendations_title');
        const tools = element('div', 'je-reco-tools', bar);
        owner.disposers.push(trackBar(bar));
        return { bar, tools };
    }
    function appendRetry(owner: RenderOwner, box: HTMLElement): void {
        const row = element('div', 'je-retry-row je-pad-left je-pad-right', box);
        const button = element('button', 'raised emby-button', row);
        button.type = 'button';
        button.textContent = '⟳ Tap to retry';
        button.addEventListener('click', () => { void renderInto(owner.container); }, { once: true, signal: owner.controller.signal });
    }
    function appendEmpty(owner: RenderOwner, box: HTMLElement, rowResults: readonly RowResult[]): void {
        const empty = element('div', 'je-recommendations-empty je-pad-left je-pad-right', box);
        empty.textContent = text('recommendations_empty');
        // A failed load is not an empty catalogue, and this container won't be rendered again by itself.
        if (rowResults.some(entry => entry.failed)) appendRetry(owner, box);
    }
    /** Says that the filters leave the page nothing, with the way back to everything (`onClear`). */
    function appendNothingMatches(box: HTMLElement, onClear: () => void): void {
        const note = JE.discoverySection?.buildMessageRow?.({
            message: text('discovery_filters_none'), actionLabel: text('discovery_filters_clear'), onAction: onClear
        });
        if (!note) return;
        note.classList.add('je-recommendations-empty', 'je-reco-filters-none', 'je-pad-left', 'je-pad-right');
        box.appendChild(note);
    }
    /** The rows of the kinds All | Movies | Series shows, then the genre, studio and network tiles of those kinds. */
    function appendRows(owner: RenderOwner, box: HTMLElement, rowResults: readonly RowResult[]): void {
        const shows = (kind: FeedKind) => part(P, 'shownForType')(kind, filterOf(JE).getFilterMode(FILTER_MODULE));
        for (const { row, results } of rowResults) {
            if (results.length > 0) box.appendChild(rows.createMediaRow(text(row.titleKey), results, row.key, owner));
        }
        const movieGenres = part(P, 'MOVIE_GENRES');
        const tvGenres = part(P, 'TV_GENRES');
        if (movieGenres.length && shows('movie')) box.appendChild(rows.createGenreTileRow(text('recommendations_movie_genres'), movieGenres, 'movie', owner));
        if (tvGenres.length && shows('tv')) box.appendChild(rows.createGenreTileRow(text('recommendations_tv_genres'), tvGenres, 'tv', owner));
        if (shows('movie')) box.appendChild(rows.createTileRow(text('recommendations_studios'), part(P, 'STUDIOS'), 'studio', owner));
        if (shows('tv')) box.appendChild(rows.createTileRow(text('recommendations_networks'), part(P, 'NETWORKS'), 'network', owner));
    }
    /**
     * Fills the rows box under the page's filters: the rows of the kinds All | Movies | Series shows, each asked with the
     * filters, then the tiles of those kinds. `signal` ends with the next fill and with the page's render; `onClear`:
     * Clear filters, from the note when they leave nothing.
     */
    async function fillRows(owner: RenderOwner, box: HTMLElement, signal: AbortSignal, onClear: () => void, wasConnected: boolean): Promise<void> {
        const state = part(P, 'state');
        const { container } = owner;
        const superseded = () => signal.aborted || state.renders.get(container) !== owner;
        JE.jellyseerrUI?.releasePosters?.(box);
        box.replaceChildren();
        const shows = (kind: FeedKind) => part(P, 'shownForType')(kind, filterOf(JE).getFilterMode(FILTER_MODULE));
        const loading = JE.core?.ui?.createSkeletonRows([
            ...part(P, 'ROWS').filter(row => part(P, 'shownForType')(row.kind, filterOf(JE).getFilterMode(FILTER_MODULE))).map(row => text(row.titleKey)),
            ...(shows('movie') ? [text('recommendations_movie_genres')] : []), ...(shows('tv') ? [text('recommendations_tv_genres')] : []),
            ...(shows('movie') ? [text('recommendations_studios')] : []), ...(shows('tv') ? [text('recommendations_networks')] : [])
        ]);
        if (loading) {
            loading.className = 'je-pad-left je-pad-right';
            loading.setAttribute('aria-label', text('recommendations_loading'));
            box.appendChild(loading);
        }
        let rowResults: RowResult[] = [];
        let movieGenres: GenreSliderEntry[] = [];
        let tvGenres: GenreSliderEntry[] = [];
        try {
            [rowResults, movieGenres, tvGenres] = await Promise.all([
                part(P, 'fetchAllRows')(signal), part(P, 'fetchGenreSlider')('movie'), part(P, 'fetchGenreSlider')('tv')
            ]);
        } catch (error) {
            if (isAbortError(error)) return;
            console.error(`${LOG_PREFIX} Failed to load rows`, error);
        }
        if (superseded()) return;
        if (wasConnected && !container.isConnected) { part(P, 'disposeRender')(container); return; }
        P.MOVIE_GENRES = movieGenres;
        P.TV_GENRES = tvGenres;
        loading?.remove();
        if (rowResults.some(entry => entry.results.length > 0)) appendRows(owner, box, rowResults);
        // (Filters that leave nothing are said so, with the way back; a row that failed is not "nothing", it has its retry.)
        else if (part(P, 'isNarrowed')() && !rowResults.some(entry => entry.failed)) appendNothingMatches(box, onClear);
        else appendEmpty(owner, box, rowResults);
    }
    /** The page's filters at the end of its title bar: All | Movies | Series, then the Filters button with its menu. */
    function toolbarControls(bar: HTMLElement, place: () => HTMLElement | null, onChange: () => void, profiles?: ProfilesHost): HTMLElement[] {
        const facade = filterOf(JE);
        const type = facade.createFilterControl(FILTER_MODULE, () => onChange());
        const button = facade.createFiltersButton(bar, FILTER_MODULE, 'feed', onChange, { place, ...(profiles ? { profiles } : {}) });
        return button ? [type, button] : [type];
    }
    // Per rendered page: redraws its filters and, when they changed since its rows were filled, fills them again (the
    // filters are the category pages' too, which can change them).
    const syncs = new Map<HTMLElement, () => void>();
    /** After the filters changed elsewhere (a category page): every page shows them, with rows to match. */
    function syncFilters(): void {
        for (const [container, sync] of [...syncs]) {
            if (container.isConnected) sync(); else syncs.delete(container);
        }
    }
    /**
     * Renders the title bar with the page's filters, then the rows, in a box of their own that fills again whenever the
     * filters change. Each container owns its render, so one host can't end another's.
     */
    async function renderInto(container: HTMLElement): Promise<void> {
        const owner = beginRender(container);
        const { signal } = owner.controller;
        const wasConnected = container.isConnected;

        // Cards leaving the document must be unobserved first (lazy posters).
        JE.jellyseerrUI?.releasePosters?.(container);
        container.replaceChildren();
        // Where the address holds the filters (Home's tab, the page of its own), a link, a reload or Back opens the page
        // with what it says.
        const address = JE.discoveryAddress;
        if (part(P, 'addressHoldsFilters')()) address?.adopt(FILTER_MODULE, null, { withSort: false });
        const { bar, tools } = appendHeading(owner);
        const rowsBox = element('div', 'je-reco-rows', container);
        let filled = '';
        let rowsController: AbortController | null = null;
        const fill = (): Promise<void> => {
            filled = part(P, 'filterSignature')();
            rowsController?.abort();
            const controller = rowsController = new AbortController();
            signal.addEventListener('abort', () => controller.abort(), { once: true, signal: controller.signal });
            return fillRows(owner, rowsBox, controller.signal, clear, wasConnected);
        };
        const refill = () => { fill().catch(error => console.error(`${LOG_PREFIX} Failed to filter`, error)); };
        // The saved filters: what is set now (no order on this page), and a profile's applied as the address would be.
        const profiles: ProfilesHost | undefined = address ? {
            read: () => address.filterPairs(address.current(FILTER_MODULE, null), false).join('&'),
            apply(filters) {
                const wanted = address.filtersOf(filters, 'feed');
                filterOf(JE).setFilterMode(FILTER_MODULE, wanted.mode);
                filterOf(JE).setFilters(FILTER_MODULE, wanted.selection);
                paintTools();
                changed();
            }
        } : undefined;
        function paintTools(): void { tools.replaceChildren(...toolbarControls(bar, () => container, changed, profiles)); }
        // A change made here: the address says it first (a reload or a link shows the same), then the rows follow.
        function changed(): void {
            if (part(P, 'addressHoldsFilters')()) address?.write(FILTER_MODULE, null, false);
            refill();
        }
        // Clear filters, from the note that they leave nothing: the controls are drawn again with them.
        function clear(): void {
            const keyed = rowsBox.contains(document.activeElement);
            part(P, 'clearFilters')();
            paintTools();
            changed();
            // (The note goes with the rows: the keys go to the Filters button, which the bar keeps.)
            if (keyed) tools.querySelector<HTMLElement>('.jellyseerr-filters-btn')?.focus({ preventScroll: true });
        }
        syncs.set(container, () => {
            paintTools();
            if (part(P, 'filterSignature')() !== filled) refill();
        });
        owner.disposers.push(() => { syncs.delete(container); rowsController?.abort(); });
        paintTools();
        await fill();
    }
    P.trackStickyBar = trackBar;
    P.createMediaRow = rows.createMediaRow;
    P.createTileRow = rows.createTileRow;
    P.createGenreTileRow = rows.createGenreTileRow;
    P.renderInto = renderInto;
    P.syncFilters = syncFilters;
    P.renderForCustomTab = element => {
        if (!element) return;
        renderInto(element).catch(error => console.error(`${LOG_PREFIX} Failed to render`, error));
    };
})();
