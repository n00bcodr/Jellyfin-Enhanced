// A menu in the form Jellyfin's own menus have in the layout in use.
// On a TV that is Jellyfin's action sheet: its markup and class names, so Jellyfin's stylesheet and
// the active theme draw it, with its title row, in the middle of the screen over the dimmed page.
// Everywhere else it is the small menu of Jellyfin's library pages (the one under their Sort
// button): no title, the page not dimmed; the section's stylesheet draws that form over the same
// markup, from the theme's own values.
// (The web client's own menu code is inside its bundle and cannot be called from a plugin.)
//
// Two kinds. A list of choices: one is picked and the menu closes (the sort). Groups: each group is
// a row that says what is set in it and opens to its body (as the filter menu of a Jellyfin library
// page opens its sections). A group's body is a list of choices, or the caller's own (fields to
// type a range in, a list to tick, a search). What is set takes effect at once and the menu stays,
// so several groups can be set, until it is closed (the filters). Such a menu holds fields, so to
// a screen reader it is a dialog of buttons that open, not a menu of items.
//
// Published as JE.discoveryMenu { openMenu, menuRow, groupedMenuRoom }.
import type { SeerrDiscoveryHost } from '../host-discovery';
import { choiceRow, groupedMenuRoom, isBackKey, menuRow, showValue, watchOutcome } from './menu-parts';
import type { DiscoveryMenuFacade, MenuChoice, MenuGroup, MenuOptions, MenuRow } from './types';

/** The least height under its anchor a grouped menu is hung there with, where there is more room above (px). */
const GROUPED_MIN_ROOM = 260;
const EDGE = 8;
/**
 * Where rows go on beyond what is in sight, the cut falls inside a row, through its name, on every layout
 * and ground: a list cut between two rows looks finished, and a shadow or a fade alone does not show on
 * every theme. Below, the scroll's room is made a little less for it (never more); above, the rows' place
 * is moved a little. Not at a list's end: its last row is never spent on the sign, and with less than a
 * row left below nothing is cut.
 */
const CUT_AT = 0.6;

export function createDiscoveryMenu(JE: SeerrDiscoveryHost): DiscoveryMenuFacade {
    let closeOpen: (() => void) | null = null;
    let bodies = 0;

    /** Opens the menu under its anchor; returns the function that closes it. One menu is open at a time. */
    function openMenu({ anchor, title, choices = [], groups, clearLabel, doneLabel, noneLabel, undoLabel, onUndo, canUndo, onPick, onClear, onClose }: MenuOptions): () => void {
        closeOpen?.();
        const tv = document.documentElement.classList.contains('layout-tv');
        // (A touch screen's sheet: its height is kept as its foot changes; see cutInARow.)
        const coarse = !!window.matchMedia?.('(pointer: coarse)').matches;
        const backdrop = document.createElement('div');
        backdrop.className = 'dialogBackdrop dialogBackdropOpened jellyseerr-menu-backdrop';
        const container = document.createElement('div');
        container.className = 'dialogContainer';
        const sheet = document.createElement('div');
        sheet.className = 'focuscontainer dialog actionsheet-not-fullscreen actionSheet centeredDialog opened jellyseerr-sort-menu';
        sheet.setAttribute('role', groups ? 'dialog' : 'menu');
        sheet.setAttribute('aria-label', title);
        const content = document.createElement('div');
        content.className = 'actionSheetContent';
        let outcome: HTMLElement | null = null;
        let stopOutcome: (() => void) | null = null;
        // A TV's action sheet has Jellyfin's title row; the small menu has none (its name is its label).
        if (tv) {
            const heading = document.createElement('h1');
            heading.className = 'actionSheetTitle';
            heading.textContent = title;
            content.appendChild(heading);
        }
        // (Measured again only when the menu's width changed: placing it follows the page's scrolling.)
        let fittedWidth = -1;
        /** Every group's value again, at the menu's size now. */
        const fitValues = (): void => {
            const width = sheet.offsetWidth;
            if (width === fittedWidth) return;
            fittedWidth = width;
            for (const el of content.querySelectorAll<HTMLElement>('.jellyseerr-menu-group-value')) {
                showValue(el, el.dataset.whole ?? el.textContent ?? '', el.dataset.short || undefined);
            }
        };
        // The one part of the menu that scrolls: its title (a TV) and its foot ("Clear filters") stay.
        const scroller = document.createElement('div');
        scroller.className = 'actionSheetScroller scrollY';
        for (const choice of choices) scroller.appendChild(choiceRow(choice));
        content.appendChild(scroller);
        let clear: HTMLButtonElement | null = null;
        if (groups) {
            sheet.classList.add('jellyseerr-menu-grouped');
            for (const group of groups) {
                // The group's row: its name, what is set in it, and a chevron; it opens to the group's body.
                const { item, body } = menuRow(group.name, 'expand_more', false);
                item.classList.add('jellyseerr-menu-group');
                item.dataset.toggle = group.id;
                item.setAttribute('aria-expanded', 'false');
                const value = document.createElement('div');
                value.className = 'jellyseerr-menu-group-value';
                // (What is set keeps its own direction: "1995 to 2005" in a page read from the right.)
                value.dir = 'auto';
                const first = group.choices?.[0];
                const current = group.choices?.find(choice => choice.selected) ?? first;
                // Said as filtering only when it is: the first choice of a group is "any".
                const set = group.choices ? !!current && current !== first : group.set === true;
                showValue(value, group.choices ? current?.name ?? '' : (set ? group.value : group.any) ?? '', set ? group.short : undefined);
                item.toggleAttribute('data-set', set);
                body.appendChild(value);
                const list = document.createElement('div');
                list.className = 'jellyseerr-menu-choices';
                list.id = `jellyseerr-menu-body-${++bodies}`;
                list.setAttribute('role', group.choices ? 'radiogroup' : 'group');
                list.setAttribute('aria-label', group.name);
                list.hidden = true;
                item.setAttribute('aria-controls', list.id);
                for (const choice of group.choices ?? []) list.appendChild(choiceRow(choice, group.id));
                // (Each group's row and body in a box of its own: the row held at the top while its group is open leaves
                // with the group as it scrolls away, not over the groups after it.)
                const box = document.createElement('div');
                box.className = 'jellyseerr-menu-groupbox';
                box.dataset.group = group.id;
                box.append(item, list);
                scroller.appendChild(box);
            }
            if (clearLabel && onClear) {
                // Over the foot, what the page says when nothing matches what is set (shown while it does).
                if (noneLabel) {
                    outcome = document.createElement('div');
                    outcome.className = 'jellyseerr-menu-note jellyseerr-menu-outcome';
                    outcome.setAttribute('role', 'status');
                    outcome.hidden = true;
                }
                const foot = document.createElement('div');
                foot.className = 'jellyseerr-menu-foot';
                if (outcome) foot.appendChild(outcome);
                clear = menuRow(clearLabel, 'check', true).item;
                clear.classList.add('jellyseerr-menu-clear');
                clear.dataset.clear = '';
                foot.appendChild(clear);
                if (doneLabel) {
                    // Where the menu stands over the list's own loading circle (a phone, a TV, a narrow window), a change that
                    // takes long shows here that it is still being fetched. (Nothing waits for it: what is set has taken effect.)
                    const circle = JE.discoveryBusy?.circle?.('jellyseerr-menu-busy');
                    if (circle) foot.appendChild(circle);
                    const done = menuRow(doneLabel, 'check', true).item;
                    done.classList.add('jellyseerr-menu-done');
                    done.dataset.done = '';
                    foot.appendChild(done);
                }
                content.appendChild(foot);
            }
        }
        sheet.appendChild(content);
        container.appendChild(sheet);

        // What the keys move through: the rows and fields showing (a closed group's are not; nor is "clear" with nothing to
        // clear), and a list's all / any choice, by the one in use (left and right move between the two). (The choice is
        // one stop: the half with the keys on it, else the one in use; on a TV left and right only move, and OK takes one.
        // A saved filter's delete is beside its row, not a stop on the way down: the key towards the line's end reaches it.
        // Tab still goes through each, `beside`.)
        const items = (beside = false): HTMLElement[] => Array.from(content.querySelectorAll<HTMLElement>('.actionSheetMenuItem, .jellyseerr-menu-input, '
            + '.jellyseerr-menu-match-btn, .jellyseerr-menu-profile-delete, .jellyseerr-menu-profile-save, .jellyseerr-menu-profile-undo, .jellyseerr-menu-outcome-undo'))
            .filter(item => !item.classList.contains('jellyseerr-menu-match-btn') || (item.parentElement?.contains(document.activeElement)
                ? item === document.activeElement : item.getAttribute('aria-checked') === 'true'))
            .filter(item => beside || !item.classList.contains('jellyseerr-menu-profile-delete') || item === document.activeElement)
            .filter(item => !item.closest('[hidden]') && !item.hidden && item.getAttribute('aria-disabled') !== 'true'
                && !(item instanceof HTMLButtonElement && item.disabled && !item.classList.contains('actionSheetMenuItem'))
                && !(item.dataset.done !== undefined && getComputedStyle(item).display === 'none'));
        const heads = (): HTMLElement[] => Array.from(scroller.querySelectorAll<HTMLElement>('.jellyseerr-menu-group'));
        const headOf = (groupId: string): HTMLElement | undefined => heads().find(item => item.dataset.toggle === groupId);
        /** "Clear filters" is at full strength only while there is something to clear. */
        const weighClear = (): void => {
            const idle = !scroller.querySelector('.jellyseerr-menu-group[data-set]');
            if (idle) clear?.setAttribute('aria-disabled', 'true'); else clear?.removeAttribute('aria-disabled');
        };
        weighClear();
        /** Builds a group's own body the first time it opens. */
        const built = new WeakSet<HTMLElement>();
        /** Every group's row and body again, from what is set now (after an Undo): an open body is built anew at once. */
        const renew = (): void => {
            for (const group of groups ?? []) {
                if (typeof group.describe !== 'function') continue;
                const { value, set, short } = group.describe();
                const head = headOf(group.id);
                const words = head?.querySelector<HTMLElement>('.jellyseerr-menu-group-value');
                if (words) showValue(words, set ? value : group.any ?? '', set ? short : undefined);
                head?.toggleAttribute('data-set', set);
                const body = head?.nextElementSibling;
                if (!(body instanceof HTMLElement) || !built.has(body)) continue;
                body.replaceChildren();
                built.delete(body);
                if (head?.getAttribute('aria-expanded') === 'true') buildBody(group, body);
            }
            weighClear();
            place(true);
        };
        const buildBody = (group: MenuGroup, list: HTMLElement): void => {
            if (!group.build || built.has(list)) return;
            built.add(list);
            group.build(list, {
                say(value, set, short) {
                    const head = headOf(group.id);
                    const words = head?.querySelector<HTMLElement>('.jellyseerr-menu-group-value');
                    // (Not set, a group says its value where it gives one, "1 saved", else what it says for nothing set.)
                    if (words) showValue(words, set ? value : (value || group.any) ?? '', set ? short : undefined);
                    head?.toggleAttribute('data-set', set);
                    weighClear();
                },
                // (What a body does to its own size, a search narrowing a list, never makes the menu shorter: what is under the pointer stays there.)
                placed: () => { place(true); const head = headOf(group.id); if (head?.getAttribute('aria-expanded') === 'true') reveal(head); },
                // (A choice that is done with the menu, such as a saved profile applied.)
                close: () => close(),
                // (Another group's value changed by this one, a genre ticked here leaving its Without list: its row says it,
                // and its body is built anew when next opened.)
                other(groupId, value, set, short) {
                    const head = headOf(groupId);
                    const words = head?.querySelector<HTMLElement>('.jellyseerr-menu-group-value');
                    const otherGroup = groups?.find(entry => entry.id === groupId);
                    if (words) showValue(words, set ? value : (value || otherGroup?.any) ?? '', set ? short : undefined);
                    head?.toggleAttribute('data-set', set);
                    const body = head?.nextElementSibling;
                    if (body instanceof HTMLElement && built.has(body) && head?.getAttribute('aria-expanded') !== 'true') { body.replaceChildren(); built.delete(body); }
                    weighClear();
                }
            });
        };
        /** Opens one group (the others close), or closes it. */
        const toggle = (item: HTMLElement, opening: boolean): void => {
            for (const head of heads()) {
                const open = head === item && opening;
                head.setAttribute('aria-expanded', String(open));
                if (!open) head.removeAttribute('data-over');
                const body = head.nextElementSibling;
                if (!(body instanceof HTMLElement)) continue;
                body.hidden = !open;
                head.parentElement?.toggleAttribute('data-open', open);
                // (A list's search field is held just under this row: the row's height, as laid out.)
                if (open) body.style.setProperty('--jellyseerr-menu-head', `${head.offsetHeight}px`);
                const group = open ? groups?.find(entry => entry.id === head.dataset.toggle) : undefined;
                if (group) buildBody(group, body);
            }
        };
        /** The group just opened is brought into the menu's sight: its row at the top where its body does not fit under it. */
        const reveal = (head: HTMLElement): void => {
            const body = head.nextElementSibling;
            if (!(body instanceof HTMLElement)) return;
            // (Measured at the height the list has once cut, which is less than the menu's room.)
            cutInARow();
            const view = scroller.getBoundingClientRect();
            const top = head.getBoundingClientRect().top - view.top;
            const over = body.getBoundingClientRect().bottom - view.bottom;
            if (over > 0) scroller.scrollTop += Math.min(top, over);
            cutInARow();
            edges();
        };
        let closed = false;
        let pointerAt: number | null = null;
        // Whether the list was last moved by the keys (a remote), and the wait for it to come to rest.
        let keyed = false;
        // Whether the list was last moved by a finger, a mouse or a wheel (left where it was put), not by focus.
        let pointered = false;
        let keyWay = 0;
        let settling = 0;
        let following = 0;
        /** Closes the menu and gives the keys back to its anchor. */
        function close(): void {
            if (closed) return;
            closed = true;
            closeOpen = null;
            document.removeEventListener('keydown', onKey, true);
            document.removeEventListener('scroll', follow, true);
            cancelAnimationFrame(following);
            window.clearTimeout(settling);
            for (const type of ['popstate', 'hashchange']) window.removeEventListener(type, close);
            window.removeEventListener('resize', resized);
            stopOutcome?.();
            backdrop.remove();
            container.remove();
            onClose?.();
            if (anchor.isConnected) anchor.focus();
        }
        /**
         * Puts the keys on a row or a field. What is held in sight over the list (an open group's row, its search field and
         * all / any choice) takes them where it stands: the browser would otherwise scroll the list back to where it stands
         * among the rows.
         */
        function focusInPlace(target: HTMLElement | undefined): void {
            target?.focus({ preventScroll: heldInSight(target) });
        }
        /** Whether a row or field is one held in sight over the list (an open group's row, its search field and all / any choice), and in sight now. */
        function heldInSight(target: Element | null): boolean {
            if (!(target instanceof HTMLElement) || !scroller.contains(target)) return false;
            const held = !!target.closest('.jellyseerr-menu-searchbar') || (target.classList.contains('jellyseerr-menu-group') && target.getAttribute('aria-expanded') === 'true');
            if (!held) return false;
            const view = scroller.getBoundingClientRect();
            const box = target.getBoundingClientRect();
            return box.top >= view.top - 1 && box.bottom <= view.bottom + 1;
        }
        // On a TV Jellyfin scrolls every element that takes focus into place a moment later (a focus listener of its own on
        // the window, then a timer), by where it stands among the rows: what is held over the list would have the list
        // scrolled back to its start. While the keys are on what is held in sight, the list takes no scroll to a place (a
        // row's focus is still Jellyfin's to bring into sight; the menu itself scrolls by scrollTop and scrollBy).
        if (tv && typeof scroller.scrollTo === 'function') {
            const scrollTo = scroller.scrollTo.bind(scroller);
            Object.defineProperty(scroller, 'scrollTo', {
                configurable: true, writable: true,
                value: (first?: ScrollToOptions | number, y?: number): void => {
                    if (heldInSight(document.activeElement)) return;
                    if (typeof first === 'number') scrollTo(first, y ?? 0); else scrollTo(first);
                }
            });
        }
        /** The keys (and a remote's) while the menu is open. */
        function onKey(event: KeyboardEvent): void {
            const list = items(event.key === 'Tab');
            const focused = document.activeElement;
            const index = focused instanceof HTMLElement ? list.indexOf(focused) : -1;
            const move = (to: number): void => {
                event.preventDefault(); event.stopPropagation();
                keyed = true;
                keyWay = to >= index ? 1 : -1;
                focusInPlace(list[(to + list.length) % list.length]);
                cutAgain();
            };
            // In a field, Home and End are the field's own.
            if (focused instanceof HTMLInputElement && (event.key === 'Home' || event.key === 'End')) return;
            const active = focused instanceof HTMLElement ? focused : null;
            const body = active?.closest('.jellyseerr-menu-choices');
            const previous = body?.previousElementSibling;
            const head = previous instanceof HTMLElement ? previous
                : active?.classList.contains('jellyseerr-menu-group') && active.getAttribute('aria-expanded') === 'true' ? active : null;
            // Towards the start of the line, out of a group's body: back on the group's own row (a long list need not be walked to leave it).
            // (In a field the key is the caret's until the caret is at the field's start.)
            const out = getComputedStyle(sheet).direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
            // (On a list's all / any choice, left and right are the choice's own while there is a half that way; past its
            // first half, left is the way out to the group's row as everywhere in a group.)
            if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && active?.classList.contains('jellyseerr-menu-match-btn')) {
                const forward = (event.key === 'ArrowRight') !== (getComputedStyle(sheet).direction === 'rtl');
                if (forward ? active.nextElementSibling : active.previousElementSibling) return;
            }
            // A saved filter's row and its delete: the key towards the line's end goes to the delete, back from it to the row.
            const towardsEnd = out === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft';
            const pair = active?.closest('.jellyseerr-menu-profile-row');
            const beside = event.key === towardsEnd && active?.classList.contains('jellyseerr-menu-profile') ? pair?.querySelector('.jellyseerr-menu-profile-delete')
                : event.key === out && active?.classList.contains('jellyseerr-menu-profile-delete') ? pair?.querySelector('.jellyseerr-menu-profile') : null;
            if (beside instanceof HTMLElement) {
                event.preventDefault(); event.stopPropagation(); keyed = true; beside.focus();
                return;
            }
            if (event.key === out && body && head && !(active instanceof HTMLInputElement && (active.selectionStart ?? 0) > 0)) {
                event.preventDefault(); event.stopPropagation(); keyed = true; keyWay = -1; focusInPlace(head); cutAgain();
                return;
            }
            // Escape, or a remote's Back: the menu closes and the key goes no further, so the page stays.
            // On a TV, with a group open, Back first closes that group (the remote's way out of a long list).
            if (isBackKey(event)) {
                event.preventDefault(); event.stopImmediatePropagation();
                if (tv && head) { toggle(head, false); place(); head.focus(); } else close();
            }
            else if (event.key === 'ArrowDown') move(index + 1);
            else if (event.key === 'ArrowUp') move(index < 0 ? list.length - 1 : index - 1);
            else if (event.key === 'Home') move(0);
            else if (event.key === 'End') move(list.length - 1);
            else if (event.key === 'Tab') move(index + (event.shiftKey ? -1 : 1));
        }
        /** Marks one choice of a group as the one in use, on its rows and on the group's own row. */
        const mark = (groupId: string, id: string): void => {
            const rows = Array.from(scroller.querySelectorAll<HTMLElement>('.actionSheetMenuItem[data-group]')).filter(item => item.dataset.group === groupId);
            for (const item of rows) {
                const chosen = item.dataset.id === id;
                item.setAttribute('aria-checked', String(chosen));
                const tick = item.querySelector<HTMLElement>('.actionsheetMenuItemIcon');
                if (tick) tick.style.visibility = chosen ? '' : 'hidden';
            }
            const head = headOf(groupId);
            const chosen = rows.find(item => item.dataset.id === id);
            const value = head?.querySelector<HTMLElement>('.jellyseerr-menu-group-value');
            if (value) showValue(value, chosen?.querySelector('.actionSheetItemText')?.textContent ?? '');
            head?.toggleAttribute('data-set', !!chosen && chosen !== rows[0]);
            weighClear();
        };
        content.addEventListener('click', event => {
            const item = event.target instanceof Element ? event.target.closest<HTMLElement>('.actionSheetMenuItem') : null;
            if (!item) return;
            if (item.dataset.toggle !== undefined) {
                // One group open at a time; a closed group's row is where it was, so the menu may take its own height again.
                const opening = item.getAttribute('aria-expanded') !== 'true';
                toggle(item, opening);
                place();
                if (opening) reveal(item);
                return;
            }
            if (item.dataset.done !== undefined) { close(); return; }
            if (item.dataset.clear !== undefined) {
                if (item.getAttribute('aria-disabled') === 'true') return;
                onClear?.();
                // Every group is back on nothing set; a body of the caller's own is built anew when next opened.
                for (const group of groups ?? []) {
                    if (group.choices) { mark(group.id, group.choices[0]?.id ?? ''); continue; }
                    const head = headOf(group.id);
                    const list = head?.nextElementSibling;
                    const words = head?.querySelector<HTMLElement>('.jellyseerr-menu-group-value');
                    if (words) showValue(words, group.any ?? '');
                    head?.removeAttribute('data-set');
                    head?.setAttribute('aria-expanded', 'false');
                    if (list instanceof HTMLElement) { list.hidden = true; list.replaceChildren(); built.delete(list); }
                }
                weighClear();
                // (Nothing is left to clear: the keys go on from the first group.)
                place(true);
                heads()[0]?.focus();
                return;
            }
            const id = item.dataset.id;
            if (id === undefined) return;
            const groupId = item.dataset.group;
            if (groupId === undefined) {
                close();
                onPick(id);
                return;
            }
            if (item.getAttribute('aria-checked') === 'true') return;
            mark(groupId, id);
            onPick(id, groupId);
        });
        /** The depth under what is held over which rows fade into it: the stylesheet's `--jellyseerr-held-fade` (in em). */
        const heldFade = (): number => Math.ceil((parseFloat(getComputedStyle(scroller).fontSize) || 16)
            * (parseFloat(getComputedStyle(scroller).getPropertyValue?.('--jellyseerr-held-fade') ?? '') || 0));
        // The open group's row (and a list's search field under it) is held at the top of the scroll: once
        // rows pass under it, it has a lower edge.
        scroller.addEventListener('scroll', () => {
            for (const head of heads()) {
                const body = head.nextElementSibling;
                // (Only while it is held: leaving with its group it is a row like any other, its edge gone with it.)
                const held = Math.abs(head.getBoundingClientRect().top - scroller.getBoundingClientRect().top) < 2;
                const over = head.getAttribute('aria-expanded') === 'true' && body instanceof HTMLElement && held
                    && body.getBoundingClientRect().top < head.getBoundingClientRect().bottom - 1;
                head.toggleAttribute('data-over', over);
                if (!(body instanceof HTMLElement)) continue;
                // A list's own rule is no row: gone under what is held, it would lie as a second line in the clear end of the
                // fade there. It is out of sight from the moment it is under the fade. A heading goes under the fade as rows do,
                // except on a TV, whose whole-row view can leave its words resting in the fade: there it goes once its words do.
                const strip = over ? (body.querySelector('.jellyseerr-menu-searchbar') ?? head).getBoundingClientRect().bottom : -Infinity;
                // (With a few pixels to spare: where it comes to rest must not turn on half a pixel.)
                const end = strip + heldFade() + 4;
                for (const part of body.querySelectorAll<HTMLElement>(tv ? '.jellyseerr-menu-list-rule, .jellyseerr-menu-label' : '.jellyseerr-menu-list-rule')) {
                    const box = part.getBoundingClientRect();
                    const words = part.classList.contains('jellyseerr-menu-label') ? box.top + (parseFloat(getComputedStyle(part).paddingTop) || 0) : box.top;
                    part.style.visibility = words <= end ? 'hidden' : '';
                }
            }
        }, { passive: true });
        const shownRows = (): Array<{ row: HTMLElement; box: DOMRect }> => Array.from(scroller.querySelectorAll<HTMLElement>('.actionSheetMenuItem'))
            .filter(row => !row.closest('[hidden]') && !row.hidden)
            .map(row => ({ row, box: row.getBoundingClientRect() })).filter(entry => entry.box.height > 0);
        const below = (): number => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        /** What the open group's body holds that is not a row (a field, a button, a note), as laid out. */
        const unrowed = (): DOMRect[] => {
            const body = heads().find(head => head.getAttribute('aria-expanded') === 'true')?.nextElementSibling;
            if (!(body instanceof HTMLElement)) return [];
            return Array.from(body.querySelectorAll('input, button:not(.actionSheetMenuItem), .jellyseerr-menu-note, .jellyseerr-menu-match'))
                .filter(el => !el.closest('[hidden]') && !el.closest('.actionSheetMenuItem'))
                .map(el => el.getBoundingClientRect()).filter(box => box.height > 0);
        };
        /** The first line box of a row's name, where the browser can measure one. */
        const firstLine = (name: Element | null): DOMRect | undefined => {
            if (!name || typeof document.createRange !== 'function') return undefined;
            const range = document.createRange();
            range.selectNodeContents(name);
            return Array.from(range.getClientRects?.() ?? []).find(rect => rect.height > 0);
        };
        /** Where a row is cut at the top: through the first line of its name, a little above its middle (what is hidden above runs down to there). */
        const topCutOf = ({ row, box }: { row: HTMLElement; box: DOMRect }): number => {
            const line = firstLine(row.querySelector('.actionSheetItemText'));
            return line ? line.top + line.height * (1 - CUT_AT) : box.top + box.height * (1 - CUT_AT);
        };
        /** Where a row is cut: through the last line of its name (a long name has two), a little under that line's middle. */
        const cutOf = ({ row, box }: { row: HTMLElement; box: DOMRect }): number => {
            const name = row.querySelector('.actionSheetItemText');
            let line: DOMRect | undefined;
            if (name && typeof document.createRange === 'function') {
                const range = document.createRange();
                range.selectNodeContents(name);
                line = Array.from(range.getClientRects?.() ?? []).pop();
            }
            // (A one-line row is cut where its own height puts it, a little under its name's middle; a longer name's last line moves the cut down to itself.)
            return Math.max(line && line.height > 0 ? line.top + line.height * CUT_AT : 0, box.top + box.height * CUT_AT);
        };
        /** Cuts the list inside a row at its edges, and keeps what the browser brings into sight clear of what is held. */
        const cutInARow = (): void => {
            scroller.style.maxHeight = '';
            // What the browser keeps clear when the keys bring a row into sight (the stylesheet's scroll padding): below, the
            // depth of a cut row, so the row the keys are on is never the one cut and the next one shows as far as its cut;
            // above, what is held there (the open group's row and its search field), so that row is not brought under them.
            const sample = shownRows()[0];
            const open = heads().find(head => head.getAttribute('aria-expanded') === 'true');
            const bar = open?.nextElementSibling?.querySelector<HTMLElement>('.jellyseerr-menu-searchbar');
            if (sample) scroller.style.setProperty('--jellyseerr-cut', `${Math.round(cutOf(sample) - sample.box.top)}px`);
            // (With the depth under it over which rows fade into it.)
            scroller.style.setProperty('--jellyseerr-held', `${open ? open.offsetHeight + (bar?.offsetHeight ?? 0) + heldFade() : 0}px`);
            // The foot's loading circle keeps clear of the "Clear filters" words, however long they are in a language.
            const footRow = clear?.parentElement;
            const words = clear?.querySelector('.actionSheetItemText');
            if (footRow && words && typeof document.createRange === 'function') {
                const range = document.createRange();
                range.selectNodeContents(words);
                const said = range.getBoundingClientRect?.();
                const room = footRow.getBoundingClientRect();
                const rtl = getComputedStyle(footRow).direction === 'rtl';
                if (said && said.width > 0) footRow.style.setProperty('--jellyseerr-clear-end', `${Math.ceil(rtl ? room.right - said.left : said.right - room.left)}px`);
            }
            // Above: the row at the edge shows the lower part of its name (unless an open group's row is held there: that row is the edge).
            const top = scroller.getBoundingClientRect().top;
            if (scroller.scrollTop > 2 && below() > 2 && !(open && Math.abs(open.getBoundingClientRect().top - top) < 2)) {
                const entries = shownRows();
                const overEntry = entries.filter(entry => entry.box.top < top - 1).pop();
                // (Hidden: the row's upper part, down to a little above the middle of its name: by the name, so the edge never
                // falls in a row's padding, two rules with nothing between.)
                const up = overEntry ? Math.round((top - overEntry.box.top) - (topCutOf(overEntry) - overEntry.box.top)) : 0;
                // (Not by moving the rows down, if that puts the foot of an open group that fits in sight out of it again: the
                // next row is cut instead, the rows moving up.)
                const body = open?.nextElementSibling;
                const bottom = scroller.getBoundingClientRect().bottom;
                const fits = body instanceof HTMLElement && !!open && body.getBoundingClientRect().bottom - open.getBoundingClientRect().top <= bottom - top;
                const nextEntry = entries.find(entry => entry.box.top >= top - 1);
                if (up > 0 && fits && nextEntry && body instanceof HTMLElement && body.getBoundingClientRect().bottom + up > bottom + 1) {
                    scroller.scrollTop += Math.round(topCutOf(nextEntry) - top);
                } else if (overEntry) scroller.scrollTop -= up;
            }
            const view = scroller.getBoundingClientRect();
            const rows = shownRows().filter(entry => entry.box.top > view.top + 1);
            const next = rows.find(entry => entry.box.bottom > view.bottom - 1);
            const last = rows.filter(entry => entry.box.bottom <= view.bottom - 1).pop();
            if (next && below() > 1 && below() < next.box.height && open) {
                // (Less than a row left under an open group at the list's end: the rest is brought up, so the list ends on its
                // last row rather than on blank over it, where the group's row stays in sight.)
                const rest = below();
                if (open.getBoundingClientRect().top - rest >= view.top - 1) scroller.scrollTop += rest;
                return;
            }
            if (!next || below() < next.box.height) return;
            // On a TV, under an open group held at the top: the list's view is what is held, a whole number of rows, and the
            // cut's depth. Each cut at the foot (made by moving the rows, above) then leaves the top on a row's edge, under
            // the held strip's rule, and no crumb of a row lies there. (A row of another height in sight puts it off by that much.)
            const own = open ? shownRows().filter(entry => open.nextElementSibling?.contains(entry.row)) : [];
            const [upper, lower] = own.slice(-2);
            // (Only where the open group's own rows run on past the view, evenly: a row of another height, a line between
            // rows, or a body that ends in sight would put the cut on a row's edge, and the list would look complete. The
            // general cut, through a name, is taken then.)
            const inView = own.filter(entry => entry.box.bottom > view.top && entry.box.top < view.bottom);
            const steps = inView.slice(1).map((entry, index) => entry.box.top - (inView[index]?.box.top ?? entry.box.top));
            const firstStep = steps[0] ?? 0;
            const firstHeight = inView[0]?.box.height ?? 0;
            const even = steps.length > 0 && steps.every(step => Math.abs(step - firstStep) <= 1) && inView.every(entry => Math.abs(entry.box.height - firstHeight) <= 1);
            const runsOn = (open?.nextElementSibling?.getBoundingClientRect().bottom ?? 0) > view.bottom + 1;
            if (tv && open && upper && lower && even && runsOn && open.getBoundingClientRect().top - view.top < 2) {
                const pitch = lower.box.top - upper.box.top;
                const depth = cutOf(lower) - lower.box.top;
                const heldDeep = open.offsetHeight + (bar?.offsetHeight ?? 0);
                const whole = pitch > 0 ? Math.floor((view.height - heldDeep - depth) / pitch) : 0;
                if (whole >= 1) { scroller.style.maxHeight = `${Math.round(heldDeep + whole * pitch + depth)}px`; return; }
            }
            const cut = view.bottom >= cutOf(next) ? cutOf(next) : last ? cutOf(last) : 0;
            // (Never over what the open group has under its rows that is not a row, such as Keywords' all / any choice and
            // search field under the keywords chosen, or a range's fields: the cut would hide them.)
            if (cut < view.bottom - 1 && unrowed().some(box => box.bottom > cut + 1 && box.top < view.bottom)) {
                // (Then, where the next row's name can be brought up to the edge without moving the open group's row out of
                // sight, the rows move: the list ends through a name, not on blank.)
                const by = Math.round(cutOf(next) - view.bottom);
                const headTop = open?.getBoundingClientRect().top ?? view.top;
                if (by > 0 && by < next.box.height && headTop - by >= view.top - 1 && below() >= by) scroller.scrollTop += by;
                return;
            }
            // On a touch sheet the sheet keeps its height (its foot growing, a line said there, would otherwise take a whole
            // row off it): the rows move to the cut instead, where they have room to, and the open group's row stays in sight.
            if (coarse && !tv && Math.abs(cut - view.bottom) > 1) {
                const down = view.bottom >= cutOf(next) ? Math.round(view.bottom - cutOf(next)) : 0;
                const up = down === 0 ? Math.round(cutOf(next) - view.bottom) : 0;
                const headTop = open?.getBoundingClientRect().top ?? view.top;
                // (Kept only where the top then still falls through a name or a row's edge, not in a row's padding with its name
                // gone above: else the list is cut at the foot as elsewhere.)
                const topTrue = (): boolean => {
                    const edge = scroller.getBoundingClientRect().top;
                    return !shownRows().some(entry => entry.box.top < edge - 1 && entry.box.bottom > edge + 1 && topCutOf(entry) < edge - 1
                        && (entry.row.querySelector('.actionSheetItemText')?.getBoundingClientRect().bottom ?? entry.box.bottom) <= edge + 1);
                };
                const was = scroller.scrollTop;
                if (down > 0 && scroller.scrollTop >= down) scroller.scrollTop -= down;
                else if (up > 0 && up < next.box.height && below() >= up && headTop - up >= view.top - 1) scroller.scrollTop += up;
                if (scroller.scrollTop !== was) {
                    if (topTrue()) return;
                    scroller.scrollTop = was;
                }
            }
            if (cut > view.top + 40 && Math.abs(cut - view.bottom) > 1) scroller.style.maxHeight = `${Math.round(cut - view.top)}px`;
        };
        /**
         * After the keys moved the list (the row they went to was brought into sight), the cut is made
         * again where the list came to rest: by moving the rows, by less than a row, not the menu's
         * height (a TV's sheet stands in the middle of the screen and would jump). Only where the row
         * the keys are on stays in sight.
         */
        const cutAgain = (): void => {
            const active = document.activeElement;
            if (!(active instanceof HTMLElement) || !scroller.contains(active)) return;
            const view = scroller.getBoundingClientRect();
            const rows = shownRows().filter(entry => entry.box.top > view.top + 1);
            const at = rows.findIndex(entry => entry.box.bottom > view.bottom - 1);
            const next = rows[at];
            if (!next || below() < next.box.height) { edges(); return; }
            const on = active.getBoundingClientRect();
            const before = at > 0 ? rows[at - 1] : undefined;
            const moves = [cutOf(next) - view.bottom, ...(before ? [cutOf(before) - view.bottom] : [])]
                .sort((a, b) => Math.abs(a) - Math.abs(b));
            // The cut is made already: nothing moves. (A whole row's move the key's way would undo it, and walk the list on from there.)
            if (Math.abs(moves[0] ?? 0) <= 1) { edges(); return; }
            // The key's own way where it can be (after Down the list does not step back up), the smaller move otherwise.
            // (Only a move the list has room for: at its start it cannot go up, at its end not down.)
            const room = (by: number): boolean => by < 0 ? scroller.scrollTop >= -by - 1 : below() >= by - 1;
            const can = moves.filter(by => room(by) && on.top - by >= view.top - 1 && on.bottom - by <= view.bottom + 1);
            const move = can.find(by => Math.sign(by) === keyWay) ?? can[0];
            // (On a TV Jellyfin's own focus scrolling glides: so does this, unless the viewer asked for less motion.)
            const glide = tv && typeof scroller.scrollBy === 'function' && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
            if (move !== undefined && Math.abs(move) > 1) {
                if (glide) scroller.scrollBy({ top: Math.round(move), behavior: 'smooth' });
                else scroller.scrollTop += Math.round(move);
            }
            edges();
        };
        /** Marks whether rows go on below and above what is in sight. */
        const edges = (): void => {
            // (More below only where a row or a field is, not a row's own padding.)
            const bottom = scroller.getBoundingClientRect().bottom;
            const rowsShown = Array.from(scroller.querySelectorAll<HTMLElement>('.actionSheetMenuItem'))
                .filter(row => !row.closest('[hidden]') && row.getBoundingClientRect().height > 0);
            const lastRow = rowsShown[rowsShown.length - 1];
            const hidden = (lastRow?.getBoundingClientRect().bottom ?? 0) > bottom + 4 || unrowed().some(box => box.bottom > bottom + 4);
            content.toggleAttribute('data-more', scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 2 && hidden);
            // (Above too, unless an open group's row is held there: that row is the edge.)
            const held = heads().find(head => head.getAttribute('aria-expanded') === 'true');
            const top = scroller.getBoundingClientRect().top;
            const heldAtTop = !!held && Math.abs(held.getBoundingClientRect().top - top) < 2;
            // (More above only where a row is hidden there, not a few pixels of the list's own padding: by its name, a row
            // whose name is whole in sight, only its padding gone, hides nothing. The line box runs above the letters:
            // hidden only where more than its top part is.)
            const firstRow = rowsShown[0];
            const line = firstLine(firstRow?.querySelector('.actionSheetItemText') ?? null);
            const nameTop = line ? line.top + line.height * 0.3 : firstRow?.getBoundingClientRect().top ?? top;
            const hiddenAbove = nameTop < top - 1;
            content.toggleAttribute('data-above', scroller.scrollTop > 2 && hiddenAbove && !heldAtTop);
            // (Rows above at all, a group's row held at the top or not: a TV's title has its rule then.)
            content.toggleAttribute('data-rows-above', scroller.scrollTop > 2 && hiddenAbove);
        };
        scroller.addEventListener('scroll', edges, { passive: true });
        backdrop.addEventListener('click', () => close());
        container.addEventListener('click', event => { if (event.target === container) close(); });

        document.body.append(backdrop, container);
        // A TV's sheet is drawn by Jellyfin's own rules: what stays over its scrolling rows takes the sheet's own ground,
        // and a group's fields and notes stand on the column its rows' words stand on.
        if (tv) {
            // (Jellyfin centres its sheet: one that grows as a group opens would move under the remote. It is held at the
            // top a full sheet has, and grows down from there.)
            const most = parseFloat(getComputedStyle(sheet).maxHeight);
            if (most > 0 && most < window.innerHeight) {
                container.style.alignItems = 'flex-start';
                sheet.style.marginTop = `${Math.round((window.innerHeight - most) / 2)}px`;
            }
            sheet.style.setProperty('--jellyseerr-menu-ground', getComputedStyle(sheet).backgroundColor);
        }
        // (The column the rows' words stand on, for what is not a row: a TV's fields and notes, by the words' box; the
        // foot's band, by the letters themselves.)
        const firstName = scroller.querySelector('.actionSheetItemText');
        const wordsBox = firstName?.getBoundingClientRect();
        const scrollerBox = scroller.getBoundingClientRect();
        const rtl = getComputedStyle(sheet).direction === 'rtl';
        if (wordsBox && scrollerBox.width > 0) {
            sheet.style.setProperty('--jellyseerr-menu-indent', `${Math.round(rtl ? scrollerBox.right - wordsBox.right : wordsBox.left - scrollerBox.left)}px`);
        }
        if (firstName && scrollerBox.width > 0 && typeof document.createRange === 'function') {
            const range = document.createRange();
            range.selectNodeContents(firstName);
            const letters = range.getBoundingClientRect?.();
            if (letters && letters.width > 0) {
                sheet.style.setProperty('--jellyseerr-menu-text', `${Math.round(rtl ? scrollerBox.right - letters.right : letters.left - scrollerBox.left)}px`);
            }
        }
        for (const group of groups ?? []) {
            const head = group.open ? headOf(group.id) : undefined;
            if (head) toggle(head, true);
        }
        /**
         * Whether the menu stands over any part of the list's own loading circle (in the middle of the section, half way
         * down the screen): then the menu's foot shows one and the list's is not drawn (the stylesheet), so a slow change
         * is never shown twice, nor not at all.
         */
        function overList(): void {
            const section = anchor.closest('.jellyseerr-discovery-section');
            const area = section?.getBoundingClientRect();
            const box = sheet.getBoundingClientRect();
            const x = area && area.width > 0 ? area.left + area.width / 2 : window.innerWidth / 2;
            const y = window.innerHeight / 2;
            // (The list's circle is 2.6em across, in the section's own size, its middle half way down the screen.)
            const half = 1.3 * (parseFloat(section ? getComputedStyle(section).fontSize : '') || 16);
            sheet.toggleAttribute('data-over-list', box.left < x + half && x - half < box.right && box.top < y + half && y - half < box.bottom);
        }
        /**
         * Places the menu under (or, short of room, over) its anchor, its end edge on the column's, kept inside
         * the screen (as Jellyfin places its own). A menu of groups grows as its groups open: it hangs from its
         * anchor, which it never covers, is as tall as the room under it at most, and scrolls within itself. (Only
         * where there is next to no room under the anchor and more above does it stand on the anchor instead.)
         * `keep` (a body changed its own size): where it hangs under its anchor it may get shorter, but not so short
         * that its foot comes up under the pointer or finger that was just on a row; where it stands above its
         * anchor it does not get shorter at all (its rows would move under the pointer).
         */
        function place(keep = false): void {
            fitValues();
            // On a TV Jellyfin's own rules place the sheet: in the middle of the screen, within its height.
            if (tv) { cutInARow(); edges(); overList(); return; }
            const was = sheet.getBoundingClientRect();
            const above = was.height > 0 && was.top < anchor.getBoundingClientRect().top;
            const foot = clear?.parentElement?.getBoundingClientRect().height ?? 0;
            const least = !keep ? 0 : above ? was.height : pointerAt === null ? 0 : Math.min(was.height, pointerAt - was.top + foot + 14);
            // (Measured at its own height, the rows have nothing to scroll and would start from the top again: their place is kept.)
            const scrolled = scroller.scrollTop;
            scroller.style.maxHeight = '';
            sheet.style.cssText = 'position: fixed; margin: 0; left: 0; top: 0;';
            const at = anchor.getBoundingClientRect();
            const size = sheet.getBoundingClientRect();
            const edge = at.right - (parseFloat(getComputedStyle(anchor).paddingRight) || 0);
            const left = Math.min(Math.max(EDGE, edge - size.width), Math.max(EDGE, window.innerWidth - size.width - EDGE));
            const under = at.bottom + 4;
            const roomUnder = window.innerHeight - under - EDGE;
            const roomAbove = at.top - 4 - EDGE;
            const wanted = Math.max(size.height, least);
            let top = under;
            let room = roomUnder;
            if (wanted > roomUnder && (groups ? roomUnder < Math.min(wanted, GROUPED_MIN_ROOM) && roomAbove > roomUnder : true)) {
                room = Math.max(roomAbove, 0);
                top = Math.max(EDGE, at.top - 4 - Math.min(wanted, room));
            }
            const height = least ? `min-height: ${Math.round(Math.min(least, room))}px;` : '';
            sheet.style.cssText = `position: fixed; margin: 0; box-sizing: border-box; left: ${Math.round(left)}px; top: ${Math.round(top)}px; max-height: ${Math.round(Math.max(room, 120))}px; ${height}`;
            scroller.scrollTop = scrolled;
            // What the keys are on stays in sight.
            const active = document.activeElement;
            if (active instanceof HTMLElement && scroller.contains(active)) {
                const view = scroller.getBoundingClientRect();
                const box = active.getBoundingClientRect();
                if (box.top < view.top || box.bottom > view.bottom) active.scrollIntoView?.({ block: 'nearest' });
            }
            cutInARow();
            edges();
            overList();
        }
        place();
        // The page's own "nothing matches" (a section's, the Recommendations page's), said in the foot while it is there.
        if (outcome && noneLabel) {
            stopOutcome = watchOutcome({
                band: outcome, anchor, noneLabel, undoLabel, onUndo, canUndo, renew,
                closed: () => closed,
                focusHome: () => focusInPlace(heads().find(head => head.getAttribute('aria-expanded') === 'true') ?? items()[0]),
                placed: () => place(true)
            });
        }
        // Where the pointer (or a finger) last was on the menu, down the screen; nowhere once it has left the menu.
        sheet.addEventListener('pointermove', event => { pointerAt = event.clientY; });
        sheet.addEventListener('pointerdown', event => { pointerAt = event.clientY; keyed = false; pointered = true; });
        sheet.addEventListener('wheel', () => { keyed = false; pointered = true; }, { passive: true });
        sheet.addEventListener('keydown', () => { pointered = false; }, true);
        // The keys' row is brought into sight by the browser, and on a TV by Jellyfin's own focus scrolling, over a
        // moment: the cut is made again once the list has come to rest. (A finger or a wheel leaves it where it was put;
        // a field or the choice focused by the menu itself moves it without a key.)
        scroller.addEventListener('scroll', () => {
            window.clearTimeout(settling);
            settling = window.setTimeout(() => { if (!closed && (keyed || !pointered)) cutAgain(); }, 140);
        }, { passive: true });
        sheet.addEventListener('pointerleave', event => { if (event.pointerType === 'mouse') pointerAt = null; });
        /** Keeps the menu with its anchor while the page scrolls under it (a list reloading, a wheel). */
        function follow(event: Event): void {
            if (event.target instanceof Node && sheet.contains(event.target)) return; // the menu's own list scrolling
            following ||= requestAnimationFrame(() => { following = 0; if (!closed) place(true); });
        }
        document.addEventListener('scroll', follow, { passive: true, capture: true });
        // A phone's address bar coming or going (a swipe), or its keyboard, changes only the window's height: the menu is
        // placed again. A change of width (the phone turned, a window resized) lays the page out anew: the menu closes.
        const openWidth = window.innerWidth;
        function resized(): void {
            if (window.innerWidth !== openWidth) { close(); return; }
            following ||= requestAnimationFrame(() => { following = 0; if (!closed) place(true); });
        }
        window.addEventListener('resize', resized);
        // Leaving the page by any other way takes the menu with it. (No history entry of its own: a
        // same-address history step is a navigation to the rest of the plugin.)
        for (const type of ['popstate', 'hashchange']) window.addEventListener(type, close);
        document.addEventListener('keydown', onKey, true);
        (items().find(item => item.getAttribute('aria-checked') === 'true') ?? items()[0])?.focus();
        closeOpen = close;
        return close;
    }

    return { openMenu, menuRow, groupedMenuRoom };
}
