// The DOM of a discovery section, built from Jellyfin's own page parts so it reads as part of the
// page it joins: the page's own wrapped grid, in the page's own column.
//
// Where a discovery section joins the page it is on (attachJoin).
//   - The header is held at the top of the screen by its controls' row, just under Jellyfin's bar
//     (wherever that bar is at the moment), with the section's title in that row.
//   - When the section starts below the first screen, one line near the top of the page says it
//     exists and goes to it.
//   - On a list page (studio, genre, tag) Jellyfin's A-Z rail belongs to the library's list, so it
//     leaves while it would run beside the section. (The library's closing "1-1 of 1" line going on
//     a one-page list is the stylesheet's alone.)
// Everything is undone when the section leaves the page.
//
// Published as JE.discoverySection { buildSection, placeSection, attachJoin, buildPlaceholderCards,
// clearPlaceholders, PLACEHOLDER_CARDS, buildMessageRow, buildRetrySection }.
import type { SeerrDiscoveryHost } from '../host-discovery';
import type { DiscoverySectionFacade, MessageRowOptions, SectionPage } from './types';

/** How many cards hold a section's place while its first page loads (about a row and a half on a desktop). */
export const PLACEHOLDER_CARDS = 10;
const RAIL_FLAG = 'data-jellyseerr-rail';
const STUCK_FLAG = 'data-stuck';
const TYPE_WORD_OFF = 'data-type-word-off';
/** Room kept above the controls' row while the header is held (more on a TV, whose screen edge is not safe), and above the section's rule after going to it (px). */
const ROW_AIR = 5;
const ROW_AIR_TV = 22;
const LANDING_AIR = 12;

/** Builds a section around its header: Jellyfin's vertical section with a wrapped grid. */
function buildSection({ key, page, header }: { readonly key: string; readonly page: SectionPage; readonly header: HTMLElement }): HTMLElement {
    const section = document.createElement('div');
    section.className = `verticalSection jellyseerr-${key}-discovery-section jellyseerr-discovery-section`;
    if (page === 'detail') section.classList.add('detailVerticalSection');
    section.setAttribute(`data-jellyseerr-${key}-discovery`, 'true');
    section.appendChild(header);
    const itemsContainer = document.createElement('div');
    itemsContainer.setAttribute('is', 'emby-itemscontainer');
    itemsContainer.className = 'itemsContainer vertical-wrap';
    section.appendChild(itemsContainer);
    return section;
}

/**
 * Cards that hold the grid's place while the first page loads: Jellyfin's own card box with its
 * placeholder surface and two empty text lines. Not focusable, not announced.
 */
function buildPlaceholderCards(count: number, cardClass: string): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const shape = cardClass === 'portraitCard' ? 'portrait' : 'overflowPortrait';
    for (let index = 0; index < count; index++) {
        const card = document.createElement('div');
        card.className = `card ${cardClass} jellyseerr-card-placeholder`;
        card.setAttribute('aria-hidden', 'true');
        card.innerHTML = `<div class="cardBox cardBox-bottompadded"><div class="cardScalable"><div class="cardPadder cardPadder-${shape}"></div></div>`
            + '<div class="cardText cardTextCentered cardText-first">&nbsp;</div><div class="cardText cardTextCentered cardText-secondary">&nbsp;</div></div>';
        fragment.appendChild(card);
    }
    return fragment;
}

/** Takes the held places out once the cards are in. */
function clearPlaceholders(container: ParentNode): void {
    container.querySelectorAll('.jellyseerr-card-placeholder').forEach(card => card.remove());
}

/**
 * A line in place of cards: what happened, and a Jellyfin button for what to do about it.
 * Used when Seerr did not answer; an empty answer never reaches here (the section is not shown).
 */
function buildMessageRow({ message, actionLabel, onAction }: MessageRowOptions): HTMLElement {
    const row = document.createElement('div');
    row.className = 'jellyseerr-section-message';
    row.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.textContent = message;
    row.appendChild(text);
    if (actionLabel && onAction) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'raised emby-button jellyseerr-section-message-action';
        button.textContent = actionLabel;
        button.addEventListener('click', onAction);
        row.appendChild(button);
    }
    return row;
}

/** A section that only says a lookup failed, with the button to repeat it (no heading: the title is not known). */
function buildRetrySection(key: string, message: string, actionLabel: string, onAction: () => void): HTMLElement {
    const section = document.createElement('div');
    section.className = `verticalSection jellyseerr-${key}-discovery-section jellyseerr-discovery-section je-retry-row`;
    section.appendChild(buildMessageRow({ message, actionLabel, onAction }));
    return section;
}

/** Where Jellyfin's own bar ends on screen: 0 when it is not showing (the TV layout hides it once the page scrolls). */
function barBottom(): number {
    for (const selector of ['.skinHeader', '.MuiAppBar-root']) {
        const bar = document.querySelector(selector);
        const box = bar?.getBoundingClientRect();
        if (bar && box && box.height > 0 && getComputedStyle(bar).visibility !== 'hidden') return Math.max(0, Math.round(box.bottom));
    }
    return 0;
}

/** How wide a line of text is when laid out in the row's held-title type (the page's own fonts and scripts, not an estimate). */
function heldWidth(text: string, row: HTMLElement): number {
    const probe = document.createElement('span');
    probe.className = 'jellyseerr-discovery-probe';
    probe.textContent = text;
    row.appendChild(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width;
}

/** The line that goes to the section: one phrase, what pressing it does and then what the titles there are. */
function buildJump(header: HTMLElement): HTMLButtonElement {
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'jellyseerr-join-jump';
    jump.hidden = true;
    // The action with its name stays whole while it fits, and the punctuation after it stays with
    // it: a wrap falls after the comma, never inside the name or before the comma.
    const lead = document.createElement('span');
    lead.className = 'jellyseerr-join-jump-lead';
    const go = document.createElement('span');
    go.className = 'jellyseerr-join-jump-go';
    go.textContent = header.getAttribute('data-jump-label') || header.querySelector('.sectionTitle')?.textContent || '';
    lead.appendChild(go);
    jump.appendChild(lead);
    const note = header.getAttribute('data-jump-note') ?? '';
    const mark = /^[\s]*[,;:.،؛、，]+/.exec(note)?.[0] ?? '';
    if (mark) lead.append(mark.trim());
    if (note.length > mark.length) jump.append(note.slice(mark.length));
    return jump;
}

export function createDiscoverySection(JE: SeerrDiscoveryHost): DiscoverySectionFacade {
    const joins = new Map<HTMLElement, () => void>();

    /**
     * Where a section goes. On a detail page (a person, a collection) it joins the page's own lists in
     * the primary column. On a list page it goes inside the list's own wrapper, so it shares the list's
     * gutters and the room kept for the alphabet picker.
     */
    function placeSection(anchor: HTMLElement, section: HTMLElement, page: SectionPage): boolean {
        if (page === 'detail') {
            const view = anchor.closest<HTMLElement>('.itemDetailPage') ?? anchor;
            (view.querySelector<HTMLElement>('.detailPagePrimaryContent .detailSection') ?? anchor).appendChild(section);
            attachJoin(section, false);
            return true;
        }
        // A list inside a section of its own gets the discovery section after it, not inside it.
        const own = anchor.closest('.verticalSection');
        const wrapper = own ? own.parentElement : anchor.parentElement;
        if (!wrapper) return false;
        wrapper.appendChild(section);
        attachJoin(section, true);
        return true;
    }

    /** Starts the join for a section just placed on its page. A second call for the same section replaces the first. */
    function attachJoin(section: HTMLElement, onListPage: boolean): void {
        joins.get(section)?.();
        for (const [other, stopOther] of joins) if (!other.isConnected) stopOther();
        const parent = section.parentElement;
        const header = section.querySelector<HTMLElement>('.jellyseerr-discovery-header');
        if (!parent || !header) return;
        const page = onListPage ? parent.closest('.page, .libraryPage') : null;
        const meta = header.querySelector<HTMLElement>('.jellyseerr-discovery-meta');
        const bar = header.querySelector<HTMLElement>('.jellyseerr-discovery-bar');
        const heading = header.querySelector<HTMLElement>('.sectionTitle');
        const phone = window.matchMedia?.('(max-width: 34em)');
        const tv = document.documentElement.classList.contains('layout-tv');
        // What is beside the section on its page: the library's own lists and Jellyfin's toolbar.
        const siblings = Array.from(parent.children).filter(child => child !== section);

        // The line: under Jellyfin's toolbar and on its axis on a list page; on a detail page (a person,
        // a collection), just before the page's first own list, on its heading's edge (not among the
        // facts above the lists, where it would read as one of them).
        const jump = buildJump(header);
        const toolbar = siblings.find(child => child.classList.contains('itemsViewSettingsContainer'));
        if (toolbar) toolbar.after(jump);
        else if (onListPage) parent.insertBefore(jump, siblings.find(child => child.classList.contains('itemsContainer')) ?? section);
        else {
            // (A detail page with no list of its own above the section has nothing to go past: no line.)
            const firstList = siblings.find(child => !child.classList.contains('hide') && child.querySelector('.itemsContainer'));
            jump.classList.add('jellyseerr-join-jump-start');
            if (firstList) parent.insertBefore(jump, firstList);
        }
        // Already drawn when the section arrives: the line then arrives late, and eases in instead of dropping the page at once.
        let late = onListPage ? siblings.some(child => child.classList.contains('itemsContainer') && child.childElementCount > 0) : true;
        jump.addEventListener('click', () => {
            const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
            // Focus lands on the section too. A remote needs a control to move on from; a keyboard
            // or a screen reader starts at the heading, which shows no ring (it is not a control).
            // In the TV layout the first card takes it, as when Jellyfin opens a list: its own focus scrolling
            // then centres that card, which brings the section's rule and title into the upper part of the screen.
            const card = tv ? section.querySelector('.itemsContainer > .card:not(.jellyseerr-card-placeholder)') : null;
            const control = tv ? card?.querySelector<HTMLElement>('.cardContent, a, button, [tabindex]') ?? header.querySelector<HTMLElement>('button') : null;
            if (!control && heading) {
                heading.setAttribute('tabindex', '-1');
                heading.addEventListener('blur', () => heading.removeAttribute('tabindex'), { once: true });
            }
            (control ?? heading)?.focus({ preventScroll: true });
            if (tv) return;
            // Then the section's rule comes to the top, with a little air so it does not lie against Jellyfin's bar.
            window.scrollTo({ top: section.getBoundingClientRect().top + window.scrollY - barBottom() - LANDING_AIR, behavior: calm ? 'auto' : 'smooth' });
        });

        // Held, the row shows the section's title, as on every page. Where the row has no room for the
        // whole of it, it shows the name the title is about ("Mathieu Auvray" for "More with Mathieu
        // Auvray"): the name is what tells the list apart, and it is never swapped for other words.
        const title = heading?.textContent ?? '';
        const fallback = heading?.querySelector('.jellyseerr-discovery-name')?.textContent ?? '';
        let fitted = '';
        /** Fits the held row's title to the room it has. */
        const fitTitle = (): void => {
            if (!meta || !fallback || !title) return;
            // (Looked up each time: on a list page the filter, and its row's title, arrive after the first cards.)
            const heldTitle = header.querySelector<HTMLElement>('.jellyseerr-filter-held-title');
            const inFilterRow = !!heldTitle && !!phone?.matches;
            // On a phone the Filters button may name the type beside its icon ("Movies"). The title's own
            // words come first, and the name is never cut: the whole title with the type's word, the whole
            // title without it (the button keeps its accent and dot), the name with the word, the name without it.
            const typeWord = inFilterRow ? header.querySelector('.jellyseerr-filters-type')?.textContent ?? '' : '';
            const roomNow = (): number => inFilterRow && heldTitle ? heldTitle.clientWidth
                : meta.clientWidth - (bar ? bar.offsetWidth + (parseFloat(getComputedStyle(meta).columnGap) || 0) : 0);
            const key = `${inFilterRow}|${meta.clientWidth}|${typeWord}|${inFilterRow ? 0 : Math.round(roomNow())}`;
            if (key === fitted) return;
            header.removeAttribute(TYPE_WORD_OFF);
            const wanted = heldWidth(title, meta);
            let room = roomNow();
            if (room <= 0) return;
            fitted = key;
            let words = title;
            if (wanted > room && typeWord) {
                header.setAttribute(TYPE_WORD_OFF, '');
                room = roomNow();
                if (wanted > room) {
                    // (Not the whole title either way: the name, with the word where both fit.)
                    header.removeAttribute(TYPE_WORD_OFF);
                    words = fallback;
                    if (heldWidth(fallback, meta) > roomNow()) header.setAttribute(TYPE_WORD_OFF, '');
                }
            } else if (wanted > room) words = fallback;
            if (inFilterRow && heldTitle) heldTitle.textContent = words;
            else meta.setAttribute('data-title', words);
        };

        // The cards' rows stop short of the column (a little on a list page, a lot on a detail page):
        // the header's rule and controls end where the last column's poster does. The title keeps the
        // column's width, so a long name is not pushed onto a second line by empty room.
        // Measured from one card that is showing and the room the grid has, never from how many cards
        // there are: a filter hides cards, and a short row of two must not shorten the header to two.
        const grid = section.querySelector<HTMLElement>('.itemsContainer');
        const rtl = !!grid && getComputedStyle(section).direction === 'rtl';
        let trimmed = 0;
        /** Ends the header's rule and controls where the first row of cards ends. */
        const trim = (): void => {
            if (!grid) return;
            const shown = Array.from(grid.children).find(card => card.classList.contains('card') && card.getClientRects().length > 0);
            // No card showing (still loading, or a filter that leaves none): what was measured stands.
            if (!shown) return;
            const card = shown.getBoundingClientRect();
            const room = grid.getBoundingClientRect();
            if (card.width < 1 || room.width < card.width) return;
            const poster = (shown.querySelector('.cardBox') ?? shown).getBoundingClientRect();
            const box = header.getBoundingClientRect();
            // Whole columns that fit the grid, counted from its starting edge; then where the last one's poster ends.
            const columns = Math.max(1, Math.floor((room.width + 1) / card.width));
            const short = rtl
                ? (room.right - columns * card.width + (poster.left - card.left)) - box.left
                : box.right - (room.left + columns * card.width - (card.right - poster.right));
            // Never more than a card's width: the header cannot end short of a full row.
            const next = Math.min(Math.max(0, Math.round(short)), Math.round(card.width));
            if (next === trimmed) return;
            trimmed = next;
            if (next) header.style.setProperty('--jellyseerr-trim', `${next}px`);
            else header.style.removeProperty('--jellyseerr-trim');
        };

        let under = -1;
        let fittedTo = 0;
        let tucked = 0;
        let frame = 0;
        /** Measures the page and sets what the join shows, once per frame at most. */
        const update = (): void => {
            frame = 0;
            if (!section.isConnected) return;
            // Jellyfin's bar is not always where it was when the section was placed (a TV hides it on scroll).
            const barEnd = barBottom();
            if (barEnd !== under) {
                under = barEnd;
                section.style.setProperty('--jellyseerr-sticky-top', `${barEnd}px`);
            }
            trim();
            // (On a person's page the cards' lines of parts and jobs are fitted to the cards: again when the cards' width changes.)
            const wide = grid?.clientWidth ?? 0;
            if (wide !== fittedTo) { fittedTo = wide; JE.discoveryRoles?.fitRoleLines?.(section); }
            const top = section.getBoundingClientRect().top;
            // The header is held once its controls' row reaches the top: what is above that row (the rule
            // and the title) scrolls on under Jellyfin's bar, so nothing jumps when it is held.
            // (On a phone with a filter that row is the filter and sort's, under the line of words.)
            const row = bar && phone?.matches && header.hasAttribute('data-has-filter') ? bar : meta;
            const tuck = row ? Math.max(0, row.offsetTop - (tv ? ROW_AIR_TV : ROW_AIR)) : 0;
            if (tuck !== tucked) {
                tucked = tuck;
                if (tuck > 0) header.style.setProperty('--jellyseerr-header-tuck', `${tuck}px`);
                else header.style.removeProperty('--jellyseerr-header-tuck');
            }
            // Held: the header is no longer where the section starts. Its row then shows the title.
            const stuck = header.getBoundingClientRect().top - top > 1;
            // (Held first, then fitted: what the held row holds, a type's word beside the Filters icon, is laid out only once it is held.)
            header.toggleAttribute(STUCK_FLAG, stuck);
            if (stuck) fitTitle();
            // The rail is fixed to the screen: it is beside the section once the section's top is above the rail's end.
            const rail = page?.querySelector('.alphaPicker-fixed');
            if (rail && top < rail.getBoundingClientRect().bottom) section.setAttribute(RAIL_FLAG, 'away');
            else section.removeAttribute(RAIL_FLAG);
            // Long: at the top of the page the section starts below the screen. On a detail page the line
            // is further down, at the page's lists, and long means the section starts more than a screen
            // below it. Measured without the line's own height, so showing it cannot change the answer.
            if (!jump.isConnected) return;
            const start = top + window.scrollY - (jump.hidden ? 0 : jump.offsetHeight);
            const place = jump.hidden ? jump.nextElementSibling : jump;
            const lead = onListPage || !place ? 0 : place.getBoundingClientRect().top + window.scrollY;
            const long = start - lead > window.innerHeight;
            if (jump.hidden === long) {
                jump.classList.toggle('jellyseerr-join-jump-late', long && late);
                jump.hidden = !long;
            }
            late = false;
        };
        const schedule = (): void => { frame ||= requestAnimationFrame(update); };
        document.addEventListener('scroll', schedule, { passive: true, capture: true });
        window.addEventListener('resize', schedule);
        let sizes: ResizeObserver | null = null;
        let watcher: MutationObserver | null = null;
        /** Undoes the join: nothing of it stays behind. */
        const stop = (): void => {
            joins.delete(section);
            cancelAnimationFrame(frame);
            document.removeEventListener('scroll', schedule, true);
            window.removeEventListener('resize', schedule);
            sizes?.disconnect();
            watcher?.disconnect();
            jump.remove();
            section.removeAttribute(RAIL_FLAG);
            header.removeAttribute(STUCK_FLAG);
            header.removeAttribute(TYPE_WORD_OFF);
            header.style.removeProperty('--jellyseerr-header-tuck');
            header.style.removeProperty('--jellyseerr-trim');
        };
        // What is beside the section fills in after the section may already be placed. Measured at once
        // (after layout, before paint), so the line that goes to the section is drawn in the same frame
        // as the list and does not push it down a frame later. (Not the wrapper: showing the line resizes it.)
        if (typeof ResizeObserver === 'function') {
            sizes = new ResizeObserver(() => { cancelAnimationFrame(frame); update(); });
            for (const sibling of siblings) sizes.observe(sibling);
            sizes.observe(header);
            // (The controls taking more or less of the row, a type named beside the Filters icon, changes the room a held title has.)
            if (bar) sizes.observe(bar);
            if (grid) sizes.observe(grid);
        }
        // The section removed (a new route, an empty answer): nothing of the join stays behind.
        if (typeof MutationObserver === 'function') {
            watcher = new MutationObserver(() => { if (section.parentElement !== parent) stop(); });
            watcher.observe(parent, { childList: true });
        }
        joins.set(section, stop);
        schedule();
    }

    return {
        buildSection, placeSection, attachJoin, PLACEHOLDER_CARDS, buildPlaceholderCards, clearPlaceholders,
        buildMessageRow, buildRetrySection
    };
}
