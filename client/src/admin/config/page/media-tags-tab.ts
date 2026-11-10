import { assetVersion, clientOrigin, mediaTagsSurface } from '../../../host/admin-config-host';
import type { PageModules } from './modules';
import { isAbortError } from '../domain/http';
import { createWriteScope, type WriteScope } from '../domain/write-scope';
import { asAnchor, asHtml, eventDetail, needHtml } from './dom';
import type { MediaTagsTabContext } from './types';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type MediaTagsTabDeps = Pick<PageModules, 'context' | 'displayCards'>;

export function createMediaTagsTab(m: MediaTagsTabDeps) {
    const { ApiClient, lifecycle, page } = m.context;

            // === Media Tags tab (#media-tags) ===
            // js/enhanced/admintags/ draws it the first time it opens (JE.adminTags.mountTab) and saves each change
            // itself, one field at a time. It sits after the form: this page's Save, unsaved-changes badge and search
            // never read its controls, and the page's own whole-configuration writes run inside JE.adminTags.holdSaves
            // (jeHoldMediaTags) so they never put an older Media Tags value back.
            // Declared with var: activateTab may run before this block (no temporal dead zone).
            var JE_MT_TAB = 'media-tags';

            /** The tab's sections (JE.adminTags.TABS): id and its name. */
            var JE_MT_SECTIONS: ReadonlyArray<readonly [string, string]> = [
                ['overview', 'Overview'], ['layout', 'Layout defaults'],
                ['groups', 'Groups'], ['rules', 'Rules'], ['colours', 'Colours'],
                ['badges', 'Status badges'], ['server', 'Server']
            ];

            var _jeMtLoaded: Promise<unknown> | null = null;

            var _jeMtMounting: Promise<MediaTagsTabContext | null> | null = null;

            /** @returns {boolean} Whether the JE client bundle the tab runs on (JE.t, the layout controller, the hub's preview) is loaded. */
            function jeMediaTagsReady() : boolean {
                var je = mediaTagsSurface();
                return !!(je && typeof je.t === 'function' && je.core && je.core.tagLayout && je.mediaTagsSettingsUi && je.mediaTagsSettingsUi.registry);
            }

            /**
             * Load what the tab needs, once: wait for the JE client bundle (up to 10 s), then the tab's stylesheet
             * and admin-tags.js (which loads its section modules).
             * @returns {Promise<void>}
             */
            function jeLoadMediaTags() : Promise<unknown> {
                if (_jeMtLoaded) return _jeMtLoaded;
                const version = assetVersion();
            var query = version ? { v: version } : undefined;
                var started = Date.now();
                _jeMtLoaded = new Promise<void>(function (resolve, reject) {
                    (function wait() {
                        if (jeMediaTagsReady()) return resolve();
                        if (Date.now() - started > 10000) return reject(new Error('the Jellyfin Enhanced client has not loaded'));
                        setTimeout(wait, 150);
                    })();
                }).then(function () {
                    var styled = document.getElementById('jeTagAdminCss') ? Promise.resolve() : new Promise<void>(function (resolve) {
                    const css = document.createElement('link');
                        css.id = 'jeTagAdminCss';
                        css.rel = 'stylesheet';
                        css.href = ApiClient.getUrl('/JellyfinEnhanced/js/enhanced/admintags/admin-tags.css', query);
                        // A stylesheet that fails (or never reports) still lets the tab draw (unstyled beats empty).
                        css.onload = css.onerror = function () { resolve(); };
                        setTimeout(resolve, 3000);
                        document.head.appendChild(css);
                    });
                    var je = mediaTagsSurface();
                    var scripted = je && je.adminTags && je.adminTags.mountTab ? Promise.resolve() : new Promise<void>(function (resolve, reject) {
                        var sc = document.createElement('script');
                        sc.src = ApiClient.getUrl('/JellyfinEnhanced/js/enhanced/admintags/admin-tags.js', query);
                        sc.onload = function () { resolve(); };
                        sc.onerror = function () { reject(new Error('could not load admin-tags.js')); };
                        document.head.appendChild(sc);
                    });
                    return Promise.all([styled, scripted]);
                });
                // Tried again the next time the tab opens.
                _jeMtLoaded.catch(function () { _jeMtLoaded = null; });
                return _jeMtLoaded;
            }

            function jeMtEsc(text: string) : string {
                return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            }

            /** The tab could not be drawn: say so in it, with Retry. */
            function jeMediaTagsUnavailable() : void {
                var root = page && asHtml(page.querySelector('#' + JE_MT_TAB + ' > .je-tag-admin'));
                if (!root) return;
                root.innerHTML = '<div class="je-ta-wait" role="alert">'
                    + jeMtEsc('Jellyfin Enhanced has not finished loading in this browser, so the Media Tags settings cannot be shown. '
                    + 'Retry, and if this stays, check that the plugin is active and see the browser console.')
                    + ' <button type="button" class="jea-btn" data-je-mt-retry>' + jeMtEsc('Retry') + '</button></div>';
                needHtml(root.querySelector('[data-je-mt-retry]')).addEventListener('click', function () { jeMountMediaTags(); }, { once: true });
            }

            /**
             * Draw the tab (first time) or reload its settings (again). Calls made while one runs share it.
             * @returns {Promise<Object|null>} The tab's context (JE.adminTags), or null when it could not be drawn.
             */
            function jeMountMediaTags() : Promise<MediaTagsTabContext | null> {
                if (_jeMtMounting) return _jeMtMounting;
                var tab = page && asHtml(page.querySelector('#' + JE_MT_TAB));
                if (!tab) return Promise.resolve(null);
            const tabElement = tab;
                var wait = asHtml(tab.querySelector('.je-tag-admin > .je-ta-wait:not([role=alert])'));
                if (wait) wait.textContent = wait.textContent;
                _jeMtMounting = jeLoadMediaTags().then(function () {
                    const mountTab = mediaTagsSurface()?.adminTags?.mountTab;
                if (!mountTab) throw new Error('the Media Tags tab did not load');
                return mountTab(tabElement, assetVersion() || '');
                }).catch(function (err) {
                    console.error('🪼 Jellyfin Enhanced: the Media Tags tab failed to load', err);
                    jeMediaTagsUnavailable();
                    return null;
                }).then(function (ctx) {
                    _jeMtMounting = null;
                    return ctx;
                });
                return _jeMtMounting;
            }

            /**
             * Open the Media Tags tab, optionally at one of its sections and a group (or anchor) there.
             * @param {?string} [section] - One of JE_MT_SECTIONS.
             * @param {?string} [group]
             * @param {boolean} [focus] - Move keyboard focus to the section (a link the administrator followed).
             * @returns {Promise<Object|null>}
             */
            function jeOpenMediaTags(section?: string | null, group?: string | null, focus?: boolean) : Promise<MediaTagsTabContext | null> {
                var btn = page && asHtml(page.querySelector('.jellyfin-tab-button[data-tab="' + JE_MT_TAB + '"]'));
                // A click, as jeJumpToTab does: the tab, its saved choice, the sidebar label and the phone menu follow.
                if (btn && !btn.classList.contains('active')) btn.click();
                return jeMountMediaTags().then(function (ctx) {
                    var known = JE_MT_SECTIONS.some(function (x) { return x[0] === section; });
                    if (ctx && known && section) ctx.openTab(section, { group: group || null, focus: !!focus });
                    return ctx;
                });
            }

            /**
             * Run one of this page's whole-configuration writes (Save, Apply to all users, the cache quick action)
             * so a Media Tags field saved meanwhile is not put back: JE.adminTags.holdSaves when the tab was opened.
             * @param {function(): Promise<*>} fn
             * @returns {Promise<*>}
             */
            function jeHoldMediaTags<T>(fn: (scope: WriteScope) => Promise<T>): Promise<T> {
                // Read now, not when the queue reaches it: queued work keeps the account that asked for it.
                const origin = clientOrigin();
                const run = (held?: WriteScope): Promise<T> => {
                    const scope = createWriteScope(origin, clientOrigin, held);
                    return fn(scope).finally(() => scope.finish());
                };
                var mt = mediaTagsSurface()?.adminTags;
                return mt && mt.holdSaves ? mt.holdSaves(run) : run();
            }

            /** A scope for work outside the save queue, such as what follows a finished save. */
            function jeWriteOrigin(): WriteScope {
                return createWriteScope(clientOrigin(), clientOrigin);
            }

            /**
             * A whole-configuration write started from a control. Work that stopped because the account changed
             * (AbortError) ends here without a word: whoever is signed in now did not ask for it.
             * @param {function(WriteScope): Promise<*>} fn
             * @returns {Promise<void>}
             */
            function jeRunHeldWrite(fn: (scope: WriteScope) => Promise<unknown>): Promise<void> {
                return jeHoldMediaTags(fn).then(() => undefined, (err: unknown) => {
                    if (!isAbortError(err)) throw err;
                });
            }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {
            // Sidebar: the tab's sections under its entry (as every other tab lists its cards); the one shown is marked.
            (function jeBuildMediaTagsTree() {
                var btn = page && asHtml(page.querySelector('.jea-nav .jellyfin-tab-button[data-tab="' + JE_MT_TAB + '"]'));
                if (!btn || (btn.nextElementSibling && btn.nextElementSibling.classList.contains('jea-nav-tree'))) return;
                var tree = document.createElement('div');
                tree.className = 'jea-nav-tree';
                tree.setAttribute('data-je-mt-tree', '');
                JE_MT_SECTIONS.forEach(function (sec) {
                    var a = document.createElement('a');
                    a.className = 'jea-nav-leaf';
                    a.href = '#/configurationpage?name=Jellyfin%20Enhanced&jeSection=' + JE_MT_TAB + '&tab=' + sec[0];
                    a.dataset.jeMtSection = sec[0];
                    a.textContent = sec[1];
                    tree.appendChild(a);
                });
                btn.after(tree);
                document.addEventListener('je-media-tags-section', function (e) {
                    var id = eventDetail(e).section;
                    tree.querySelectorAll<HTMLElement>('.jea-nav-leaf').forEach(function (a) {
                        var on = a.dataset.jeMtSection === id;
                        a.classList.toggle('on', on);
                        if (on) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
                    });
                }, { signal: lifecycle.signal });
            })();

            // A Media Tags change that is not saved (refused, failed, changed by another administrator) marks the tab's
            // sidebar entry, so it is seen from any tab. A save updates the Display card's summary.
            document.addEventListener('je-media-tags-store', function (e) {
                var d = eventDetail(e);
                var btn = page && asHtml(page.querySelector('.jellyfin-tab-button[data-tab="' + JE_MT_TAB + '"]'));
                if (btn) {
                    var bad = d.state === 'error' || d.state === 'conflict';
                    if (bad) btn.setAttribute('data-je-mt-state', String(d.state)); else btn.removeAttribute('data-je-mt-state');
                    var note = asHtml(btn.querySelector('.je-mt-state-text'));
                    if (bad && !note) {
                        note = document.createElement('span');
                        note.className = 'je-mt-state-text je-sr-only';
                        needHtml(btn.querySelector('h3')).appendChild(note);
                    }
                    if (note) note.textContent = bad ? (d.state === 'conflict' ? ' (changed by someone else, not saved)' : ' (not saved)') : '';
                }
                if (d.type === 'saved' && d.values && m.displayCards._jeMediaTagsConfig) m.displayCards.renderMediaTagsCard(Object.assign({}, m.displayCards._jeMediaTagsConfig, d.values));
            }, { signal: lifecycle.signal });
    }

    return {
        wire,
        JE_MT_TAB,
        jeHoldMediaTags,
        jeRunHeldWrite,
        jeWriteOrigin,
        jeMountMediaTags,
        jeOpenMediaTags,
    };
}
