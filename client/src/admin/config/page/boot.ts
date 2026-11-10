import { engine, hostDashboard, apiClient, startup } from '../../../host/admin-config-host';
import type { AdminEngine } from '../engine/api';
import { MountLifecycle } from '../engine/lifecycle';
import { startPage } from './page';

const PLUGIN_ID = 'f69e946a-4b3c-4e9a-8f0a-8d7c1b2c4d9b';

function start(admin: AdminEngine, page: HTMLElement, replayShow: boolean): void {
    const lifecycle = new MountLifecycle();
    admin.mount(document, { lifecycle });
    const form = document.querySelector('#JellyfinEnhancedForm');
    if (!(form instanceof HTMLFormElement)) throw new Error('The Jellyfin Enhanced settings form is missing');
    // jellyfin-web fires this when it drops a view from its cache.
    page.addEventListener('viewdestroy', () => lifecycle.dispose(), { once: true, signal: lifecycle.signal });
    startPage({
        pluginId: PLUGIN_ID,
        ApiClient: apiClient(),
        Dashboard: admin.dashboardShim(hostDashboard()),
        JEAdmin: admin,
        page,
        form,
        lifecycle,
    });
    if (replayShow) page.dispatchEvent(new Event('pageshow'));
}

/** Say in the page that the settings could not load, with Retry. */
function showLoadFailure(page: HTMLElement, content: HTMLElement | null, error: unknown): void {
    console.error('🪼 Jellyfin Enhanced: the settings page could not load', error);
    const old = page.querySelector('.je-admin-load-error');
    if (old) old.remove();
    if (content) content.style.visibility = '';
    page.removeAttribute('aria-busy');
    const banner = document.createElement('div');
    banner.className = 'je-note-banner je-admin-load-error';
    banner.setAttribute('role', 'alert');
    const text = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = 'The Jellyfin Enhanced settings could not load.';
    const hint = document.createElement('span');
    hint.textContent = ' Saved settings are not affected. Retry, and if this stays, check that the plugin is active and see the browser console.';
    const actions = document.createElement('div');
    actions.style.marginTop = '8px';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'jea-btn';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => {
        banner.remove();
        waitForEngine(page, startup()?.retry());
    }, { once: true });
    actions.appendChild(retry);
    text.append(title, hint, actions);
    banner.appendChild(text);
    (page.querySelector('.content-primary') ?? page).prepend(banner);
}

function waitForEngine(page: HTMLElement, loading: Promise<AdminEngine> | undefined): void {
    const content = page.querySelector<HTMLElement>('[data-role="content"]');
    page.setAttribute('aria-busy', 'true');
    // Nothing is drawn yet: the sections, sidebar and controls arrive with the engine.
    if (content) content.style.visibility = 'hidden';
    const pending = loading ?? Promise.reject(new Error('the page startup script did not run'));
    pending.then(admin => {
        // The view may have been dropped during the wait.
        if (!page.isConnected) return;
        page.removeAttribute('aria-busy');
        if (content) content.style.visibility = '';
        start(admin, page, startup()?.pageShown === true);
    }).catch(error => showLoadFailure(page, content, error));
}

/** The page's main script: start now when the engine is there, otherwise as soon as it arrives. */
export function bootPage(): void {
    const page = document.querySelector('#JellyfinEnhancedPage');
    if (!(page instanceof HTMLElement)) return;
    const running = engine();
    if (running && Object.keys(running.sections).length > 0) start(running, page, startup()?.pageShown === true);
    else waitForEngine(page, startup()?.engine);
}
