import type { ChromeSession, Unsubscribe, BodyMutationCallback } from './host';

/** Jellyfish colour variants served by the plugin CDN route (jellyfish/colors/<file>). */
export const THEMES: Readonly<Record<string, string>> = Object.freeze({
    'Default': '',
    'Aurora': 'aurora.css',
    'Banana': 'banana.css',
    'Coal': 'coal.css',
    'Coral': 'coral.css',
    'Forest': 'forest.css',
    'Grass': 'grass.css',
    'Jellyblue': 'jellyblue.css',
    'Jellyflix': 'jellyflix.css',
    'Jellypurple': 'jellypurple.css',
    'Lavender': 'lavender.css',
    'Liquid Glass': 'liquidglass.css',
    'Midnight': 'midnight.css',
    'Mint': 'mint.css',
    'Ocean': 'ocean.css',
    'Peach': 'peach.css',
    'Watermelon': 'watermelon.css'
});

export interface ThemeSelectorBridge {
    cdn: { url(source: string, path: string): string };
    helpers?: { onBodyMutation?(id: string, callback: BodyMutationCallback): Unsubscribe };
    session?: ChromeSession;
    initializeThemeSelector?: () => void;
}
export interface ThemeClient { getCurrentUserId?(): unknown }
interface DashboardHost extends Window {
    Dashboard?: { alert?(message: string): unknown };
    require?: (modules: string[], callback: (toast: (message: string) => void) => void) => void;
}

const LOG = '🪼 Jellyfin Enhanced: Jellyfish Theme Selector:';
const CSS_STYLE_ID = 'jellyfin-theme-selector-css';
const SELECTOR_ID = 'jellyfin-theme-selector';
const INIT_DELAY = 250;
const NOTIFICATION_DELAY = 1000;
const DEBOUNCE_DELAY = 100;
const TRANSITION_DURATION = 300;
const APPLIED_KEY = 'jellyfin-theme-applied';

/** The @import Jellyfin's per-user customCss setting holds for a theme file; empty for Default. */
export function themeImport(baseUrl: string, filename: string): string {
    return filename ? `@import url("${baseUrl}${filename}");` : '';
}
/** The theme whose import equals the stored customCss, else Default (custom CSS is left untouched). */
export function themeNameFor(baseUrl: string, stored: string): string {
    for (const [name, filename] of Object.entries(THEMES)) {
        if (themeImport(baseUrl, filename) === stored) return name;
    }
    return 'Default';
}
export function utcDay(date: Date): string {
    return date.toISOString().split('T')[0] ?? '';
}

export function createThemeSelector(JE: ThemeSelectorBridge, readClient: () => ThemeClient | undefined) {
    // Trailing slash preserved so `${base}${filename}` stays a CDN path.
    const baseUrl = JE.cdn.url('jellyfish', 'colors/');
    let observer: Unsubscribe | null = null;
    let debounceTimer: number | undefined;
    let sessionHooked = false;

    // Jellyfin's own userSettings key format: `${userId}-${key}` in localStorage.
    const storageKey = (userId: string, key: string): string => `${userId}-${key}`;
    function read(userId: string, key: string, fallback: string | null = null): string | null {
        try {
            const value = localStorage.getItem(storageKey(userId, key));
            return value === null ? fallback : value;
        } catch (error) {
            console.error('🪼 Jellyfin Enhanced: Theme selector storage read error', error);
            return fallback;
        }
    }
    function write(userId: string, key: string, value: string): boolean {
        try { localStorage.setItem(storageKey(userId, key), value); return true; }
        catch (error) { console.error('🪼 Jellyfin Enhanced: Theme selector storage write error', error); return false; }
    }
    function remove(userId: string, key: string): boolean {
        try { localStorage.removeItem(storageKey(userId, key)); return true; }
        catch (error) { console.error(`${LOG} localStorage remove error:`, error); return false; }
    }
    const isRandomEnabled = (userId: string): boolean => read(userId, 'randomThemeEnabled') === 'true';

    function currentUserId(): string | null {
        try {
            const userId = readClient()?.getCurrentUserId?.();
            if (typeof userId === 'string' && userId.trim() !== '') return userId;
        } catch (error) {
            console.error(`${LOG} Error extracting user ID:`, error);
        }
        console.error(`${LOG} Could not extract user ID`);
        return null;
    }
    /** Non-logging probe: whether the account that built a control is still the signed-in one. */
    function stillSignedIn(userId: string): boolean {
        try { return readClient()?.getCurrentUserId?.() === userId; } catch { return false; }
    }

    function setTheme(userId: string, filename: string, name = 'Default'): void {
        const value = themeImport(baseUrl, filename);
        if (value) {
            write(userId, 'customCss', value);
            console.log(`${LOG} Theme set to: ${name}`);
        } else {
            remove(userId, 'customCss');
            console.log(`${LOG} Theme cleared (default)`);
        }
    }

    function notify(message: string): void {
        const host: DashboardHost = window;
        try {
            if (host.Dashboard?.alert) host.Dashboard.alert(message);
            else if (host.require) host.require(['toast'], toast => toast(message));
            else console.log(`${LOG} Notification: ${message}`);
        } catch (error) {
            console.error(`${LOG} Failed to show notification:`, error);
        }
    }
    function checkPostRefreshNotification(): void {
        try {
            const pending = sessionStorage.getItem(APPLIED_KEY);
            if (pending) {
                sessionStorage.removeItem(APPLIED_KEY);
                setTimeout(() => notify(`Theme applied: ${pending}`), NOTIFICATION_DELAY);
            }
        } catch (error) {
            console.error(`${LOG} Session storage error:`, error);
        }
    }
    function rememberApplied(label: string, context: string): void {
        try { sessionStorage.setItem(APPLIED_KEY, label); }
        catch (error) { console.error(`${LOG} ${context}`, error); }
    }

    function applyRandomThemeIfNeeded(): void {
        const userId = currentUserId();
        if (!userId || !isRandomEnabled(userId)) return;
        const today = utcDay(new Date());
        if (today === read(userId, 'lastRandomThemeDate')) {
            console.log(`${LOG} Random theme already applied for today.`);
            return;
        }
        console.log(`${LOG} New day detected! Applying a random theme.`);
        const names = Object.keys(THEMES).filter(name => name !== 'Default');
        const name = names[Math.floor(Math.random() * names.length)] ?? 'Default';
        setTheme(userId, THEMES[name] ?? '', name);
        write(userId, 'lastRandomThemeDate', today);
        rememberApplied(`Random Daily (${name})`, 'Could not set session storage:');
        window.location.reload();
    }

    function injectCustomCss(): void {
        if (document.getElementById(CSS_STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = CSS_STYLE_ID;
        style.textContent = `
            #theme-selector-body {
                display: flex !important;
                align-items: center;
                justify-content: flex-start;
                flex-direction: row;
                flex-wrap: wrap;
                gap: 1em;
                padding: .4em .75em;
            }
            #theme-selector-select {
                max-width: 200px !important;
                min-width: 150px !important;
                transition: opacity ${TRANSITION_DURATION}ms ease;
            }
            #theme-selector-select:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            #random-theme-button {
                padding: 0.5em 0.5em !important;
                height: auto !important;
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 0.3em;
                background-color: transparent;
                border-radius: 10px;
                transition: background-color 0.3s ease, opacity ${TRANSITION_DURATION}ms ease;
            }
            #random-theme-button:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            #random-theme-button.active {
                background-color: #4CAF50;
                color: white;
            }
            .theme-applying {
                opacity: 0;
                transition: opacity ${TRANSITION_DURATION}ms ease;
            }
            .theme-applied {
                opacity: 1;
                transition: opacity ${TRANSITION_DURATION}ms ease;
            }
        `;
        document.head.appendChild(style);
        console.log(`${LOG} Custom CSS injected`);
    }

    function icon(name: string, className = 'material-icons'): HTMLSpanElement {
        const element = document.createElement('span');
        element.className = className;
        element.textContent = name;
        element.setAttribute('aria-hidden', 'true');
        return element;
    }

    /**
     * A control built for one account must never write that account's settings
     * after another account signed in on the same page (CHR-THEME-1). Replace it.
     */
    function guardOwner(userId: string, container: Element): boolean {
        if (stillSignedIn(userId)) return true;
        console.warn(`${LOG} Signed-in user changed; discarding the previous user's selector.`);
        container.remove();
        scheduleCheck();
        return false;
    }

    function createSelect(userId: string, container: Element): HTMLSelectElement {
        const select = document.createElement('select');
        select.setAttribute('is', 'emby-select');
        select.className = 'emby-select-withcolor emby-select';
        select.id = 'theme-selector-select';
        select.setAttribute('aria-label', 'Select theme');
        select.removeAttribute('label');
        const selected = themeNameFor(baseUrl, read(userId, 'customCss', '') ?? '');
        for (const name of Object.keys(THEMES)) {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            if (name === selected) option.selected = true;
            select.appendChild(option);
        }
        select.addEventListener('change', event => {
            event.preventDefault();
            event.stopPropagation();
            if (!guardOwner(userId, container)) return;
            const name = select.value;
            const filename = THEMES[name];
            if (filename === undefined) return;
            select.disabled = true;
            const random = document.getElementById('random-theme-button');
            if (random instanceof HTMLButtonElement) random.disabled = true;
            document.body.classList.add('theme-applying');
            setTheme(userId, filename, name);
            rememberApplied(name, 'Session storage error:');
            setTimeout(() => {
                console.log(`${LOG} Reloading to apply theme: ${name}`);
                window.location.reload();
            }, TRANSITION_DURATION);
        });
        return select;
    }

    function createRandomButton(userId: string, container: Element): HTMLButtonElement {
        const button = document.createElement('button');
        button.setAttribute('is', 'emby-button');
        button.className = 'emby-button';
        button.id = 'random-theme-button';
        button.setAttribute('aria-label', 'Toggle random daily theme');
        button.setAttribute('title', 'Random daily theme');
        const text = document.createElement('span');
        text.style.fontSize = '0.85em';
        const update = (): void => {
            const enabled = isRandomEnabled(userId);
            button.classList.toggle('active', enabled);
            text.textContent = enabled ? 'Daily' : '';
            button.setAttribute('aria-pressed', enabled.toString());
        };
        button.appendChild(icon('shuffle'));
        button.appendChild(text);
        update();
        button.addEventListener('click', () => {
            if (!guardOwner(userId, container)) return;
            const next = !isRandomEnabled(userId);
            write(userId, 'randomThemeEnabled', String(next));
            notify(`Random daily theme turned ${next ? 'ON' : 'OFF'}.`);
            console.log(`${LOG} Random daily theme set to: ${next}`);
            update();
            if (next) applyRandomThemeIfNeeded();
        });
        return button;
    }

    function buildSelector(userId: string): HTMLElement {
        const container = document.createElement('div');
        container.className = 'theme-selector-container listItem-border';
        container.id = SELECTOR_ID;
        container.dataset.jeThemeUser = userId;
        const item = document.createElement('div');
        item.className = 'listItem';
        item.id = 'theme-selector-item';
        const palette = icon('palette', 'material-icons listItemIcon listItemIcon-transparent');
        palette.id = 'theme-selector-icon';
        const body = document.createElement('div');
        body.className = 'listItemBody';
        body.id = 'theme-selector-body';
        const label = document.createElement('div');
        label.className = 'listItemBodyText';
        label.id = 'theme-selector-label';
        label.textContent = 'Theme';
        body.appendChild(label);
        body.appendChild(createRandomButton(userId, container));
        body.appendChild(createSelect(userId, container));
        item.appendChild(palette);
        item.appendChild(body);
        container.appendChild(item);
        return container;
    }

    function injectThemeSelector(): boolean {
        try {
            const target = document.querySelector('.verticalSection .headerUsername');
            const section = target?.closest('.verticalSection');
            if (!section) return false;
            const userId = currentUserId();
            if (!userId) return false;
            console.log(`${LOG} Creating theme selector element...`);
            section.appendChild(buildSelector(userId));
            console.log(`${LOG} Successfully injected!`);
            return true;
        } catch (error) {
            console.error(`${LOG} Injection error:`, error);
            return false;
        }
    }

    const isOnPreferencesPage = (): boolean => !!(document.querySelector('.headerUsername') && document.querySelector('.lnkUserProfile'));

    function check(): void {
        const existing = document.getElementById(SELECTOR_ID);
        // A retained preferences view can outlive a sign-in change; never offer it to the next account.
        if (existing && existing instanceof HTMLElement && existing.dataset.jeThemeUser && !stillSignedIn(existing.dataset.jeThemeUser)) existing.remove();
        if (isOnPreferencesPage() && !document.getElementById(SELECTOR_ID)) {
            console.log(`${LOG} Preferences page detected and selector is missing. Injecting...`);
            injectThemeSelector();
        }
    }
    function scheduleCheck(): void {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(check, DEBOUNCE_DELAY);
    }

    function initialize(): void {
        const client = readClient();
        if (!client || typeof client.getCurrentUserId !== 'function') {
            console.log(`${LOG} Waiting for ApiClient...`);
            setTimeout(initialize, INIT_DELAY);
            return;
        }
        console.log(`${LOG} ApiClient is available. Starting persistent element monitoring.`);
        applyRandomThemeIfNeeded();
        injectCustomCss();
        checkPostRefreshNotification();
        if (observer) { observer.unsubscribe(); observer = null; }
        if (JE.helpers?.onBodyMutation) {
            observer = JE.helpers.onBodyMutation('theme-selector', scheduleCheck);
        } else {
            const native = new MutationObserver(scheduleCheck);
            native.observe(document.body, { childList: true, subtree: true });
            observer = { unsubscribe: () => native.disconnect() };
        }
        if (!sessionHooked && JE.session) {
            sessionHooked = true;
            JE.session.onUserChange('theme-selector', () => {
                document.getElementById(SELECTOR_ID)?.remove();
                scheduleCheck();
            });
        }
    }

    return { initialize };
}
