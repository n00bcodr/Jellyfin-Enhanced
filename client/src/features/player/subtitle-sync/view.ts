/**
 * @file Subtitle sync: the dialog's markup and what it shows (the sync point, the offset, the hint, the
 * lines and the search). Every value is written through textContent.
 */
import { filterLines, formatTime, lineIndexAt, roundOffset, searchKey, type SubtitleLine } from './lines';
import type { LookupState } from './track';
import { syncSupport, type Renderer, type SubtitleWatch } from './watch';

export const OVERLAY_ID = 'je-subtitle-sync';

/** One open dialog. */
export interface DialogState extends LookupState {
    src: string;
    /** The watch's generation when the dialog opened. */
    generationAtOpen: number;
    returnFocus: Element | null;
    overlay: HTMLElement;
    lines: SubtitleLine[] | null;
    rows: Map<number, HTMLElement>;
    searchTimer: number | undefined;
    /** Whether the hint currently says choosing a line syncs it. */
    supportShown: boolean;
    /** What drew the subtitles when the lines were checked. */
    renderer: Renderer | null;
    /** Whether the lines were looked up again after the surface changed during a load. */
    relooked?: boolean;
}
export type Translate = (key: string, fallback: string, params?: Record<string, string | number>) => string;

const OVERLAY_MARKUP = `
            <div class="je-subsync-dialog" role="dialog" aria-modal="true" aria-labelledby="je-subsync-title">
                <div class="je-subsync-head">
                    <div class="je-subsync-titles">
                        <h2 class="je-subsync-title" id="je-subsync-title"></h2>
                        <div class="je-subsync-track"></div>
                    </div>
                    <button type="button" class="je-subsync-icon-btn je-subsync-close"><span class="material-icons close" aria-hidden="true"></span></button>
                </div>
                <div class="je-subsync-meta">
                    <span class="je-subsync-anchor"></span>
                    <span class="je-subsync-offset"></span>
                    <button type="button" class="je-subsync-reset" hidden></button>
                </div>
                <div class="je-subsync-search"><input type="search" class="je-subsync-input" autocomplete="off" spellcheck="false" enterkeyhint="search"></div>
                <div class="je-subsync-hint"></div>
                <div class="je-subsync-status" role="status" aria-live="polite"></div>
                <ul class="je-subsync-list"></ul>
                <div class="je-subsync-foot" aria-live="polite"></div>
            </div>`;

/** The dialog's own elements; the markup above always has them. */
export function part(state: { overlay: HTMLElement }, selector: string): HTMLElement {
    const el = state.overlay.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`Subtitle sync dialog lost ${selector}`);
    return el;
}
export const searchInput = (state: { overlay: HTMLElement }): HTMLInputElement | null => state.overlay.querySelector<HTMLInputElement>('.je-subsync-input');

export function createView(watch: SubtitleWatch, tr: Translate) {
    /** Formats an offset the way jellyfin-web's sync control shows it, with a sign: "+1.5 s". */
    function formatOffset(seconds: number): string {
        const v = roundOffset(seconds);
        return tr('subtitle_sync_seconds', '{value} s', { value: (v > 0 ? '+' : '') + v.toFixed(1) });
    }

    /** Builds the dialog's static markup. Every value is set through textContent afterwards. */
    function buildOverlay(): HTMLElement {
        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.setAttribute('data-je-own-keys', '');
        overlay.innerHTML = OVERLAY_MARKUP;
        part({ overlay }, '.je-subsync-title').textContent = tr('subtitle_sync_title', 'Sync subtitles');
        const close = part({ overlay }, '.je-subsync-close');
        close.title = tr('subtitle_sync_close', 'Close');
        close.setAttribute('aria-label', close.title);
        const input = searchInput({ overlay });
        if (input) {
            input.placeholder = tr('subtitle_sync_placeholder', 'Search the subtitles');
            input.setAttribute('aria-label', input.placeholder);
        }
        part({ overlay }, '.je-subsync-reset').textContent = tr('subtitle_sync_reset', 'Reset offset');
        return overlay;
    }

    /** Shows a message above the list; `action` adds a button after it. */
    function setStatus(state: DialogState, text: string, kind?: 'info' | 'error', action?: { label: string; run: () => void }): void {
        const box = part(state, '.je-subsync-status');
        box.replaceChildren();
        box.dataset.kind = kind || 'info';
        if (!text) return;
        box.append(document.createTextNode(text));
        if (action) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'je-subsync-reset';
            btn.textContent = action.label;
            btn.addEventListener('click', action.run);
            box.append(btn);
        }
    }

    /**
     * Refreshes the sync point, offset, hint and each line's time from the player's current offset
     * (jellyfin-web owns it; it is read again on every refresh).
     */
    function refreshMeta(state: DialogState): void {
        const offset = watch.effectiveOffset(state.video, state.lines);
        const o = offset === null ? 0 : offset;
        part(state, '.je-subsync-anchor').textContent = tr('subtitle_sync_sync_point', 'Heard at {time}', { time: formatTime(state.anchor) });
        const support = syncSupport(state.video);
        // Only with a track listed that the offset moves: without one the slider may still hold an earlier
        // track's value, and burned-in subtitles don't move with it.
        const showOffset = offset !== null && !!(state.lines && state.lines.length) && support.ok;
        part(state, '.je-subsync-offset').textContent = showOffset ? tr('subtitle_sync_offset', 'Offset {offset}', { offset: formatOffset(o) }) : '';
        part(state, '.je-subsync-meta .je-subsync-reset').hidden = !showOffset || roundOffset(o) === 0;
        state.supportShown = support.ok;
        const hint = part(state, '.je-subsync-hint');
        if (!state.lines || !state.lines.length) {
            hint.textContent = '';
        } else if (support.ok) {
            hint.textContent = tr('subtitle_sync_hint', 'Choose the line you just heard to sync the subtitles to it. The arrow button jumps to a line.');
        } else if (support.reason === 'burned') {
            hint.textContent = tr('subtitle_sync_hint_burned', 'These subtitles are part of the video picture, so they can\'t be shifted. Choosing a line jumps to it.');
        } else {
            hint.textContent = tr('subtitle_sync_hint_unavailable', 'This player can\'t shift subtitles. Choosing a line jumps to it.');
        }
        if (state.lines) {
            const currentIndex = lineIndexAt(state.lines, state.anchor, o);
            for (const [index, row] of state.rows) {
                const time = row.querySelector('.je-subsync-time');
                if (time) time.textContent = formatTime((state.lines[index]?.start ?? 0) - o);
                row.classList.toggle('is-current', index === currentIndex);
            }
        }
    }

    /**
     * Hides the rows the search does not match and updates the count; with an empty search it scrolls to
     * the line showing at the sync point.
     */
    function applyFilter(state: DialogState): void {
        if (!state.lines) return;
        const query = searchInput(state)?.value ?? '';
        const matches = filterLines(state.lines, query);
        const shown = new Set(matches.map(line => line.index));
        for (const [index, row] of state.rows) row.hidden = !shown.has(index);
        const list = part(state, '.je-subsync-list');
        let empty = list.querySelector('.je-subsync-empty');
        if (!matches.length && state.lines.length) {
            if (!empty) {
                empty = document.createElement('li');
                empty.className = 'je-subsync-empty';
                list.append(empty);
            }
            empty.textContent = tr('subtitle_sync_no_match', 'No lines match your search.');
        } else if (empty) {
            empty.remove();
        }
        part(state, '.je-subsync-foot').textContent = tr('subtitle_sync_count', '{shown} of {total} lines', { shown: matches.length, total: state.lines.length });
        if (!searchKey(query)) {
            list.querySelector('.je-subsync-row.is-current')?.scrollIntoView({ block: 'center' });
        } else {
            list.scrollTop = 0;
        }
    }

    /** Renders every line once; searching only hides rows. */
    function renderLines(state: DialogState): void {
        const fragment = document.createDocumentFragment();
        state.rows = new Map();
        const jumpLabel = tr('subtitle_sync_jump', 'Go to this line');
        for (const line of state.lines || []) {
            const row = document.createElement('li');
            row.className = 'je-subsync-row';
            row.dataset.index = String(line.index);
            const main = document.createElement('button');
            main.type = 'button';
            main.className = 'je-subsync-line';
            const time = document.createElement('span');
            time.className = 'je-subsync-time';
            const text = document.createElement('span');
            text.className = 'je-subsync-text';
            text.textContent = line.text;
            main.append(time, text);
            const jump = document.createElement('button');
            jump.type = 'button';
            jump.className = 'je-subsync-icon-btn je-subsync-jump';
            jump.title = jumpLabel;
            jump.setAttribute('aria-label', jumpLabel);
            jump.innerHTML = '<span class="material-icons redo" aria-hidden="true"></span>';
            row.append(main, jump);
            fragment.append(row);
            state.rows.set(line.index, row);
        }
        part(state, '.je-subsync-list').replaceChildren(fragment);
        refreshMeta(state);
        applyFilter(state);
    }

    /**
     * Moves focus between the visible lines (and from the search box into the list).
     * @returns Whether focus moved.
     */
    function moveFocus(state: DialogState, from: Element, step: 1 | -1): boolean {
        const buttons = Array.from(state.overlay.querySelectorAll<HTMLElement>('.je-subsync-row:not([hidden]) .je-subsync-line'));
        if (!buttons.length) return false;
        const input = searchInput(state);
        if (from === input) {
            if (step < 0) return false;
            // Into the list at the highlighted line when it is shown, else at the first match.
            const first = state.overlay.querySelector<HTMLElement>('.je-subsync-row.is-current:not([hidden]) .je-subsync-line') || buttons[0];
            first?.focus();
            first?.scrollIntoView({ block: 'nearest' });
            return true;
        }
        const own = from.closest('.je-subsync-row')?.querySelector<HTMLElement>('.je-subsync-line');
        const at = own ? buttons.indexOf(own) : -1;
        if (at === -1) return false;
        const next = at + step;
        if (next < 0) {
            input?.focus();
            return true;
        }
        const target = buttons[next];
        if (!target) return false;
        target.focus();
        target.scrollIntoView({ block: 'nearest' });
        return true;
    }

    return { formatOffset, buildOverlay, setStatus, refreshMeta, applyFilter, renderLines, moveFocus };
}
export type SyncView = ReturnType<typeof createView>;
