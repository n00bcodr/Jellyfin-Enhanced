import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repositoryRoot } from './discovery.mjs';
import { provideFeatureContext } from './harness.mjs';

export const pageNames = ['ActivityPage', 'BookmarksPage', 'CalendarPage', 'CatchUpPage', 'DownloadsPage', 'HiddenContentPage', 'RecommendationsPage'];
const pluginRoot = resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced');
export const emittedPage = name => readFileSync(resolve(pluginRoot, 'PluginPages', `${name}.html`), 'utf8');
export const pageRoute = name => `#/userpluginsettings.html?pageUrl=/JellyfinEnhanced/${name}`;
export const tick = () => new Promise(done => setTimeout(done, 0));

/**
 * Plugin Pages' userpluginsettings.html inserts createContextualFragment(html). Browsers
 * run scripts from such a fragment on insertion; jsdom marks them as already started, so
 * they are recreated to get the same insertion-time execution, with currentScript set.
 * tests/browser/plugin-pages-rewrite.spec.cjs covers the unmodified path in Chromium.
 */
function appendPluginPage(document, container, html) {
    const fragment = document.createRange().createContextualFragment(html);
    for (const script of fragment.querySelectorAll('script')) {
        const live = document.createElement('script');
        live.textContent = script.textContent;
        script.replaceWith(live);
    }
    container.append(fragment);
}

/**
 * A browser realm with jellyfin-web's view slots and the actual Plugin Pages insertion
 * path, so page scripts run as a real host runs them. Timers are a manual clock, and
 * window/document listeners are counted so leaks are observable.
 */
export function createPluginHost(t, { JE, client, seedDom = '', globals = {} } = {}) {
    const logs = [], errors = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('log', (...args) => logs.push(args.join(' ')));
    virtualConsole.on('error', (...args) => errors.push(args.map(String).join(' ')));
    virtualConsole.on('jsdomError', error => errors.push(String(error.stack ?? error)));
    const dom = new JSDOM(`<!doctype html><html><head></head><body><div class="mainAnimatedPages">${seedDom}</div></body></html>`, {
        url: 'http://jellyfin.test/web/#/home.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole
    });
    const { window } = dom;
    const { document } = window;
    t.after(() => window.close());

    const timers = new Map();
    let nextTimer = 1, now = 0;
    window.setInterval = (callback, delay) => { timers.set(nextTimer, { callback, delay, due: now + delay, repeat: true }); return nextTimer++; };
    window.setTimeout = (callback, delay = 0) => { timers.set(nextTimer, { callback, delay, due: now + delay, repeat: false }); return nextTimer++; };
    window.clearInterval = window.clearTimeout = id => { timers.delete(id); };
    const advance = ms => {
        const end = now + ms;
        for (;;) {
            const next = [...timers.entries()].filter(([, timer]) => timer.due <= end).sort(([, a], [, b]) => a.due - b.due)[0];
            if (!next) break;
            const [id, timer] = next;
            now = timer.due;
            if (timer.repeat) timer.due += timer.delay; else timers.delete(id);
            timer.callback();
        }
        now = end;
    };

    const listeners = [];
    for (const [label, target] of [['window', window], ['document', document]]) {
        const add = target.addEventListener.bind(target), remove = target.removeEventListener.bind(target);
        target.addEventListener = (type, listener, options) => {
            const capture = typeof options === 'object' ? !!options?.capture : !!options;
            const entry = { label, type, listener, capture };
            if (!listeners.some(item => item.label === label && item.type === type && item.listener === listener && item.capture === capture)) {
                listeners.push(entry);
                options?.signal?.addEventListener('abort', () => { const index = listeners.indexOf(entry); if (index >= 0) listeners.splice(index, 1); });
            }
            add(type, listener, options);
        };
        target.removeEventListener = (type, listener, options) => {
            const capture = typeof options === 'object' ? !!options?.capture : !!options;
            const index = listeners.findIndex(item => item.label === label && item.type === type && item.listener === listener && item.capture === capture);
            if (index >= 0) listeners.splice(index, 1);
            remove(type, listener, options);
        };
    }

    let userId = 'user-a';
    const api = { getCurrentUserId: () => userId, getUrl: path => `http://jellyfin.test${path}`, accessToken: () => `token-${userId}`, serverId: () => 'server-a', ...client };
    window.ApiClient = api;
    window.JellyfinEnhanced = JE;
    window.structuredClone = structuredClone;
    Object.assign(window, globals);

    const slots = document.querySelector('.mainAnimatedPages');
    let currentView = null;
    const hideView = view => {
        view.dispatchEvent(new window.CustomEvent('viewbeforehide', { bubbles: true }));
        view.dispatchEvent(new window.CustomEvent('viewhide', { bubbles: true }));
        view.classList.add('hide');
    };
    const showView = view => {
        view.classList.remove('hide');
        view.dispatchEvent(new window.CustomEvent('viewshow', { bubbles: true, detail: { isRestored: true } }));
    };
    return {
        window, document, api, logs, errors, advance, timers, listeners,
        get currentView() { return currentView; },
        setUser(next) { userId = next; },
        pending: () => timers.size,
        counted: type => listeners.filter(item => item.type === type).length,
        async navigate(hash) { window.location.hash = hash; advance(0); await tick(); },
        /** A fresh view, as the router creates it; `first` puts it ahead of older cached views. */
        async open(name, { html = emittedPage(name), first = false } = {}) {
            if (currentView) hideView(currentView);
            await this.navigate(pageRoute(name));
            const view = document.createElement('div');
            view.id = 'userPluginPreferencesPage';
            view.setAttribute('data-role', 'page');
            view.className = 'page libraryPage userPreferencesPage noSecondaryNavPage mainAnimatedPage';
            view.innerHTML = '<div class="userPluginSettingsContainer padded-left padded-right padded-bottom-page"></div>';
            if (first) slots.prepend(view); else slots.append(view);
            currentView = view;
            appendPluginPage(document, view.querySelector('.userPluginSettingsContainer'), html);
            return view;
        },
        /** Back navigation: the cached view returns and its script does not run again. */
        async restore(name, view) {
            if (currentView && currentView !== view) hideView(currentView);
            await this.navigate(pageRoute(name));
            currentView = view;
            showView(view);
        },
        /** Leave for a native route. */
        async leave(hash = '#/home.html') {
            if (currentView) hideView(currentView);
            currentView = null;
            await this.navigate(hash);
        },
        destroy(view) {
            view.dispatchEvent(new window.CustomEvent('viewdestroy'));
            view.remove();
        },
        changeUser(next) {
            userId = next;
            document.dispatchEvent(new window.CustomEvent('je:user-changed', { detail: { userId: next, epoch: 2 } }));
        },
        userDataLoaded() { document.dispatchEvent(new window.CustomEvent('je:user-data-loaded', { detail: { userId, epoch: 2 } })); },
        /** Load a real emitted production module into this realm. */
        load(path) {
            const source = readFileSync(resolve(pluginRoot, 'js', path), 'utf8');
            // core/ui-kit.js publishes it in production (canopy K1), and the shared modules' providers publish those
            // (canopy K1b); these tests load feature modules on their own.
            provideFeatureContext(window, source, path);
            window.eval(`[function () {\n${source}\n}][0]();`);
        }
    };
}
