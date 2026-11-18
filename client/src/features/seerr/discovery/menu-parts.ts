// Parts of the menus (menu.ts) that stand apart from their keys and their scrolling: a row in Jellyfin's own item
// markup, how much room a grouped menu wants, a group's value said whole or short, and the foot's band that says
// nothing matches what is set, with Undo.
import type { MenuChoice, MenuRow } from './types';

/** What a TV remote's Back sends, by key name or by code (Tizen 10009, webOS 461). */
export const isBackKey = (event: KeyboardEvent): boolean =>
    event.key === 'Escape' || event.key === 'BrowserBack' || event.key === 'GoBack' || event.keyCode === 10009 || event.keyCode === 461;

/** Jellyfin's icon in a menu row's icon slot (`hidden`: kept in place but not shown). */
function icon(name: string, hidden = false): HTMLElement {
    const span = document.createElement('span');
    span.className = `actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons ${name}`;
    span.setAttribute('aria-hidden', 'true');
    if (hidden) span.style.visibility = 'hidden';
    return span;
}

/** A row in Jellyfin's own item markup: the icon slot, then the words. */
export function menuRow(name: string, iconName: string, iconHidden: boolean): MenuRow {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'listItem listItem-button actionSheetMenuItem emby-button';
    const body = document.createElement('div');
    body.className = 'listItemBody actionsheetListItemBody';
    const text = document.createElement('div');
    text.className = 'listItemBodyText actionSheetItemText';
    text.textContent = name;
    body.appendChild(text);
    // The tick is Jellyfin's icon in the item's own icon slot, kept in place (hidden) on the others.
    // (The small menu shows it at the row's end, where Jellyfin's sort menu marks the order in use.)
    item.append(icon(iconName, iconHidden), body);
    return { item, text, body };
}

/** One choice's row, ticked when it is the one in use. */
export function choiceRow(choice: MenuChoice, groupId?: string): HTMLButtonElement {
    const { item } = menuRow(choice.name, 'check', !choice.selected);
    item.dataset.id = choice.id;
    if (groupId !== undefined) item.dataset.group = groupId;
    item.setAttribute('role', groupId === undefined ? 'menuitemradio' : 'radio');
    item.setAttribute('aria-checked', String(choice.selected));
    return item;
}

/** How much room a menu of groups wants under its anchor before any group is open (px), for the caller to make that room first. */
export function groupedMenuRoom(groupCount: number): number {
    const row = window.matchMedia?.('(max-width: 600px)').matches ? 48 : 36;
    return Math.min((groupCount + 1) * row + 24 + 110, Math.round(window.innerHeight * 0.72));
}

/**
 * A group's value, whole where it fits on its row, else its short form ("Any of 2"), the whole then its title. (Measured
 * once the menu is on the page: the caller fits the values again when the menu's width changes.)
 */
export function showValue(el: HTMLElement, words: string, short?: string): void {
    el.textContent = words;
    el.dataset.whole = words;
    el.dataset.short = short ?? '';
    el.title = '';
    if (short && short !== words && el.isConnected && el.scrollWidth > el.clientWidth + 1) {
        // (Short to the eye, "Any of 2"; whole to a screen reader, "Netflix or Disney Plus", and on hover.)
        const seen = document.createElement('span');
        seen.setAttribute('aria-hidden', 'true');
        seen.textContent = short;
        const whole = document.createElement('span');
        whole.className = 'jellyseerr-menu-whole';
        whole.textContent = words;
        el.replaceChildren(seen, whole);
        el.title = words;
    }
}

export interface OutcomeOptions {
    /** The band in the menu's foot. */
    readonly band: HTMLElement;
    /** The menu's anchor: the page's own "nothing matches" is looked for in its section, else its page. */
    readonly anchor: HTMLElement;
    readonly noneLabel: string;
    readonly undoLabel?: string | (() => string) | undefined;
    readonly onUndo?: (() => boolean) | undefined;
    readonly canUndo?: (() => boolean) | undefined;
    /** Whether the menu has closed. */
    closed(): boolean;
    /** Every group's row and body again, from what is set now. */
    renew(): void;
    /** Puts the keys where they go when the band's button goes: the open group's row, else the first row. */
    focusHome(): void;
    /** Places the menu again (the foot changed its height). */
    placed(): void;
}

/**
 * The page's own "nothing matches" (a section's, the Recommendations page's), said in the menu's foot while it is there:
 * where the menu covers the list, a phone or a TV, a change that empties it is seen at once. With Undo for a change made
 * here (a page opened with filters that leave nothing has none to undo). Returns what stops watching the page.
 */
export function watchOutcome(options: OutcomeOptions): () => void {
    const { band, anchor, noneLabel, undoLabel, onUndo, canUndo } = options;
    const scope = anchor.closest('.jellyseerr-discovery-section') ?? anchor.closest('.page') ?? document.body;
    /** Shows or hides the band as the page says nothing matches or not. */
    const sayOutcome = (): void => {
        if (options.closed()) return;
        const none = Array.from(scope.querySelectorAll('.jellyseerr-filters-none, .je-reco-filters-none')).some(note => !note.closest('.hide, [hidden]'));
        const undoable = none && !!(undoLabel && onUndo) && (canUndo?.() ?? true);
        const undoWords = undoable ? (typeof undoLabel === 'function' ? undoLabel() : undoLabel) ?? '' : '';
        if (band.hidden === !none && (band.dataset.undo ?? '') === undoWords) return;
        band.dataset.undo = undoWords;
        const keyed = band.contains(document.activeElement);
        band.toggleAttribute('data-undoable', undoable);
        band.hidden = !none;
        band.replaceChildren();
        if (none) {
            const words = document.createElement('span');
            words.textContent = noneLabel;
            band.appendChild(words);
            // (The way back from a change that left nothing, short of clearing every filter.)
            if (undoable && onUndo) {
                const undo = document.createElement('button');
                undo.type = 'button';
                undo.className = 'jellyseerr-menu-outcome-undo';
                undo.textContent = undoWords;
                undo.addEventListener('click', () => {
                    const wasKeyed = document.activeElement === undo;
                    if (!onUndo()) return;
                    options.renew();
                    // (The keys go to the open group's row, else the first row: the button is going.)
                    if (wasKeyed) options.focusHome();
                });
                band.append(' ', undo);
                // (The band made again with the keys on its Undo, after another change: they stay on Undo.)
                if (keyed) undo.focus({ preventScroll: true });
            }
        } else if (keyed) options.focusHome();
        options.placed();
    };
    let frame = 0;
    sayOutcome();
    if (typeof MutationObserver !== 'function') return () => cancelAnimationFrame(frame);
    const watcher = new MutationObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(sayOutcome); });
    watcher.observe(scope, { childList: true, subtree: true });
    return () => { watcher.disconnect(); cancelAnimationFrame(frame); };
}
