/**
 * @file Playback speed and aspect ratio through jellyfin-web's player settings menu, for players without a
 * `<video>` (mpv in Jellyfin Desktop).
 *
 * Speed and aspect ratio belong to the player. With a `<video>` JE sets them on the element; without one the
 * only way in is the OSD's settings menu: Playback Speed and Aspect Ratio open a second sheet listing the
 * options, the current one marked by a visible check icon, and choosing one calls the playback manager when
 * that sheet closes. The sheets are kept invisible, as for Playback Info, and presses are handled one after
 * another so each reads the result of the last.
 */
import { playerUnsupportedText, type PlayerContext } from './context';
import type { TrackMenu } from './native-track-menu';

interface MenuOption { id: string; name: string; selected: boolean }
type MenuId = 'playbackrate' | 'aspectratio';
/** The option chosen, null when none was (or the sheet was not the one asked for), false when the menu or the item is not there. */
type MenuResult = { id: string; name: string } | null | false;

const SETTINGS_BUTTON = '#videoOsdPage:not(.hide) .btnVideoOsdSettings';
const SETTINGS_MENU_ITEMS = ['stats', 'aspectratio', 'playbackrate', 'quality', 'repeatmode', 'suboffset']
    .map(id => `button[data-id="${id}"]`).join(', ');
/** How long the sheets stay invisible after a choice (their exit animation). */
const HIDDEN_DIALOGS_MS = 400;

/**
 * Whether a sheet is the settings submenu asked for: its checked option is the current value the settings
 * menu showed beside the item (jellyfin-web renders both from the same name), and speeds are numbers
 * including 1. Track and repeat menus fail one or the other.
 * @param current The value shown beside the settings item ('' if none).
 */
function isSettingsSubmenu(menuId: MenuId, options: readonly MenuOption[], current: string): boolean {
    if (options.length < 2) return false;
    if (!current || !options.some(option => option.selected && option.name === current)) return false;
    if (menuId === 'playbackrate') {
        return options.every(option => /^\d+(\.\d+)?$/.test(option.id || '')) && options.some(option => Number(option.id) === 1);
    }
    return menuId === 'aspectratio';
}

/** Waits until a dialog container has left the page (its sheet's choice is applied on close). */
async function waitUntilRemoved(container: Element, timeoutMs: number): Promise<void> {
    const t0 = Date.now();
    while (container.isConnected && Date.now() - t0 < timeoutMs) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}

/**
 * @param menu The native sheet helpers (native-track-menu.ts).
 * @param noteRate Told the speed JE chose, for the OSD seek history (osd-seek-history.ts).
 */
export function createOsdSettingsMenu(context: PlayerContext, menu: Pick<TrackMenu, 'openOsdMenu' | 'activate' | 'closeActionSheet'>, noteRate: (rate: number) => void) {
    const { JE, lifetime } = context;
    let queue: Promise<unknown> = Promise.resolve();

    /** Whether the player page is showing (true when JE.isVideoPage is not available). */
    const isOnVideoPage = (): boolean => typeof JE.isVideoPage !== 'function' || JE.isVideoPage();

    /** One settings-menu choice (see chooseInSettingsMenu). */
    async function runSettingsMenu(menuId: MenuId, pick: (options: MenuOption[]) => MenuOption | null | undefined): Promise<MenuResult> {
        if (!isOnVideoPage()) return false;
        const lease = lifetime.lease();
        /** The player page was left, or the account changed, while a sheet was awaited: nothing more is done or said. */
        const gone = (): boolean => !isOnVideoPage() || !lease.current();
        const style = document.createElement('style');
        style.textContent = '.dialogContainer, .dialogBackdrop, .actionSheet { opacity:0 !important; transition:none !important; }';
        document.head.appendChild(style);
        try {
            const main = await menu.openOsdMenu(SETTINGS_BUTTON, '');
            if (!main) return false;
            // Another sheet opened at the same moment (a track menu) is left alone.
            if (!main.querySelector(SETTINGS_MENU_ITEMS)) return null;
            const item = main.querySelector<HTMLElement>(`button[data-id="${menuId}"]`);
            if (!item || gone()) {
                menu.closeActionSheet(main);
                return gone() ? null : false;
            }
            // The settings menu shows the current value beside the item; the submenu checks that same option.
            const current = (item.querySelector('.actionSheetItemAsideText')?.textContent || '').trim();
            const before = new Set<Element>(document.querySelectorAll('.dialogContainer'));
            menu.activate(item);
            // The submenu has no title (track menus do).
            const sub = await JE.core.dom.waitForElement('.dialogContainer', {
                timeout: 3000,
                quiet: true,
                signal: lease.signal,
                predicate: el => !before.has(el) && !!el.querySelector('.actionSheetContent')
                    && !Array.from(el.querySelectorAll('.actionSheetTitle')).some(title => (title.textContent || '').trim()),
            });
            if (!sub) return gone() ? null : false;
            if (gone()) {
                menu.closeActionSheet(sub);
                return null;
            }
            const rows = Array.from(sub.querySelectorAll<HTMLElement>('button[data-id]')).map(btn => ({
                btn,
                id: btn.getAttribute('data-id') || '',
                name: ((btn.querySelector('.actionSheetItemText') || btn).textContent || '').trim(),
                // Every row has a check icon; only the current option's is visible.
                selected: Array.from(btn.querySelectorAll<HTMLElement>('.check')).some(icon => icon.style.visibility !== 'hidden'),
            }));
            const options = rows.map(({ id, name, selected }) => ({ id, name, selected }));
            if (!isSettingsSubmenu(menuId, options, current)) return null; // not the list asked for: leave it alone
            const choice = pick(options);
            const row = choice && rows.find(option => option.id === choice.id);
            if (!row) {
                menu.closeActionSheet(sub);
                return null;
            }
            menu.activate(row.btn);
            await waitUntilRemoved(sub, 1500);
            return { id: row.id, name: row.name };
        } finally {
            // A plain timer, not a lifetime one: a navigation must never leave every dialog invisible.
            window.setTimeout(() => style.remove(), HIDDEN_DIALOGS_MS);
        }
    }

    /**
     * Chooses an option in one of jellyfin-web's player settings submenus without showing the sheets.
     * @param menuId The settings item.
     * @param pick Chooses among the submenu's options.
     */
    function chooseInSettingsMenu(menuId: MenuId, pick: (options: MenuOption[]) => MenuOption | null | undefined): Promise<MenuResult> {
        const run = queue.then(() => runSettingsMenu(menuId, pick));
        queue = run.catch(() => undefined);
        return run;
    }

    /** Steps the playback speed through jellyfin-web's own list. */
    function stepPlaybackRate(direction: 'increase' | 'decrease' | 'reset'): void {
        chooseInSettingsMenu('playbackrate', options => {
            const normal = options.find(option => Number(option.id) === 1) || null;
            const current = options.findIndex(option => option.selected);
            if (direction === 'reset' || current === -1) return normal;
            const next = direction === 'increase' ? Math.min(current + 1, options.length - 1) : Math.max(current - 1, 0);
            return options[next];
        }).then(result => {
            if (!isOnVideoPage() || result === null) return;
            if (result === false) {
                JE.toast(playerUnsupportedText(context));
                return;
            }
            const speed = Number(result.id);
            noteRate(speed);
            JE.toast(speed === 1 ? JE.t('toast_speed_normal') : JE.t('toast_speed', { speed }));
        }).catch(err => {
            console.warn('🪼 Jellyfin Enhanced: playback speed through the settings menu failed', err);
        });
    }

    /** Moves to the next aspect ratio in jellyfin-web's own list. */
    function cycleAspect(): void {
        chooseInSettingsMenu('aspectratio', options => {
            const current = options.findIndex(option => option.selected);
            return options[(current + 1) % options.length];
        }).then(result => {
            if (!isOnVideoPage() || result === null) return;
            if (result === false) {
                JE.toast(playerUnsupportedText(context));
                return;
            }
            // The option's name is jellyfin-web's text, and a toast renders markup.
            JE.toast(JE.t('toast_aspect_ratio', { ratio: JE.escapeHtml(result.name) }));
        }).catch(err => {
            console.warn('🪼 Jellyfin Enhanced: aspect ratio through the settings menu failed', err);
        });
    }

    lifetime.onReset(() => { queue = Promise.resolve(); });
    return { stepPlaybackRate, cycleAspect };
}
export type OsdSettingsMenu = ReturnType<typeof createOsdSettingsMenu>;
