/**
 * @file Requests & downloads, phase 1: the Requests page at #/requests (sidebar link "Requests").
 * Tabs: My requests, Coming soon, Ready (everyone: their own requests only) and, for administrators,
 * Downloads and Calendar (the existing pages rendered inside the tab; their own pages stay where they
 * were). With phase 2 administrators also get Overview, Activity, System and Audit (admin-tabs.js;
 * Downloads then folds into Activity). The page reads GET /JellyfinEnhanced/acquire/hub once per visit and follows the change feed
 * (the titles it shows plus the user's own request-list key) to re-read in place; it never polls on
 * its own (the admin tabs follow the administrators' feed key, with a slow fallback poll of their
 * own). Exposes JE.arrHub { show, hide, refresh } and JE.initializeArrHub.
 * Phase 3 tabs (Approvals, Household, Discover) plug in through H.extraTabs ({id, label, visible(data) →
 * true | false | 'pending', count(), render(panel), leave(), after?: 'own'}); H.mineLedger.merge(view) adds the
 * request ledger's own requests to My requests; H.starters run once when the page starts.
 */
(function (JE) {
    'use strict';

    const H = (JE.internals = JE.internals || {}).arrHub = JE.internals.arrHub || {};
    const ROUTE = '#/requests';
    const PAGE_ID = 'je-requests-hub-page';
    const OWN_TABS = ['mine', 'soon', 'ready'];
    const RELOAD_DELAY_MS = 300;
    const logPrefix = '🪼 Jellyfin Enhanced: Requests:';

    const state = {
        started: false,
        visible: false,
        previousPage: null,
        data: null,
        error: false,
        loading: null,
        tab: 'mine',
        unsubscribe: null,
        reloadTimer: null,
        embedded: null,
        generation: 0,
        okAt: 0,
        refreshFailed: false,
        retryTimer: null,
        retryDelay: 0,
        hiddenListener: false
    };

    /**
     * Translates through the shared status helper.
     * @param {string} key en.json key.
     * @param {Object} [params] Parameters.
     * @returns {string} Text.
     */
    function tr(key, params) {
        return JE.arrStatus ? JE.arrStatus.tr(key, params) : key;
    }

    /**
     * True when the server has the Requests page on.
     * @returns {boolean} Enabled.
     */
    function enabled() {
        return JE.pluginConfig?.ArrRequestsHubEnabled === true && JE.arrStatus?.enabled?.() === true;
    }

    /**
     * True when the URL is the Requests page (#/requests, optionally with ?tab=).
     * @param {string} [hash] Hash to test (default: the current one).
     * @returns {boolean} Matches.
     */
    function isRoute(hash) {
        const h = hash ?? window.location.hash ?? '';
        return h === ROUTE || h.startsWith(ROUTE + '?');
    }

    /**
     * The tab named in the URL (?tab=), if any.
     * @returns {string|null} Tab id.
     */
    function tabFromHash() {
        const h = window.location.hash || '';
        const q = h.indexOf('?');
        if (q < 0) return null;
        try {
            return new URLSearchParams(h.slice(q + 1)).get('tab');
        } catch {
            return null;
        }
    }

    /**
     * The page container (created once), Jellyfin page classes for header/back integration.
     * @returns {HTMLElement} Page.
     */
    function pageContainer() {
        let page = document.getElementById(PAGE_ID);
        if (page) return page;
        page = document.createElement('div');
        page.id = PAGE_ID;
        page.className = 'page type-interior mainAnimatedPage hide';
        page.setAttribute('data-title', tr('arr_hub_title'));
        page.setAttribute('data-backbutton', 'true');
        page.setAttribute('data-url', ROUTE);
        page.setAttribute('data-type', 'custom');
        const content = document.createElement('div');
        content.setAttribute('data-role', 'content');
        const root = document.createElement('div');
        root.className = 'content-primary je-hub';
        content.appendChild(root);
        page.appendChild(content);
        (document.querySelector('.mainAnimatedPages') || document.body).appendChild(page);
        return page;
    }

    /**
     * The tabs this user has: their own three, plus Downloads/Calendar for administrators (only
     * when the server sent the admin block and those pages are on).
     * @returns {string[]} Tab ids.
     */
    function tabs() {
        // Phase-3 tabs go after My requests (Approvals, Household), or after the own tabs with after: 'own' (Discover).
        const extra = extraTabs().filter(t => extraVisible(t) === true);
        const list = [OWN_TABS[0], ...extra.filter(t => t.after !== 'own').map(t => t.id), ...OWN_TABS.slice(1), ...extra.filter(t => t.after === 'own').map(t => t.id)];
        const admin = H.admin?.tabs ? H.admin.tabs(state.data) : [];
        list.push(...admin);
        // With phase 2 the Activity tab holds the queue and history: the Downloads page folds into it.
        if (!admin.length && state.data?.admin?.downloads && JE.downloadsPage?.renderForCustomTab) list.push('downloads');
        if (state.data?.admin?.calendar && JE.calendarPage?.renderForCustomTab) list.push('calendar');
        return list;
    }

    /**
     * The phase-3 tabs registered on H.extraTabs.
     * @returns {Object[]} Tab descriptors.
     */
    function extraTabs() {
        return Array.isArray(H.extraTabs) ? H.extraTabs : [];
    }

    /**
     * Whether a phase-3 tab is offered: true, false, or 'pending' while its module is still
     * finding out (the tab named in the URL then waits instead of falling back to My requests).
     * @param {Object} tab Tab descriptor.
     * @returns {boolean|string} Visibility.
     */
    function extraVisible(tab) {
        try {
            return tab.visible(state.data);
        } catch (err) {
            console.warn(`${logPrefix} could not check the ${tab.id} tab`, err);
            return false;
        }
    }

    /**
     * The phase-3 tab descriptor with this id, if any.
     * @param {string} id Tab id.
     * @returns {Object|null} Tab descriptor.
     */
    function extraTab(id) {
        return extraTabs().find(t => t.id === id) || null;
    }

    /**
     * Tells the phase-3 tabs other than the shown one (or all) that they are not shown.
     * @param {Object|null} shown The shown tab descriptor.
     * @returns {void}
     */
    function leaveExtras(shown) {
        for (const tab of extraTabs()) {
            if (tab !== shown) tab.leave?.();
        }
    }

    /**
     * True for the administrator's phase-2 tabs (Overview, Activity, System, Audit).
     * @param {string} tab Tab id.
     * @returns {boolean} Admin tab.
     */
    function isAdminTab(tab) {
        return Array.isArray(H.admin?.TABS) && H.admin.TABS.includes(tab);
    }

    /**
     * Shows the page (navigation to #/requests).
     * @returns {void}
     */
    function show() {
        if (!enabled()) return;
        const page = pageContainer();
        if (!isRoute()) history.pushState({ page: 'requests' }, tr('arr_hub_title'), ROUTE);
        const wanted = tabFromHash();
        if (wanted) state.tab = wanted;
        if (!state.visible) {
            state.visible = true;
            const active = document.querySelector(`.mainAnimatedPage:not(.hide):not(#${PAGE_ID})`);
            if (active) {
                state.previousPage = active;
                active.classList.add('hide');
                active.dispatchEvent(new CustomEvent('viewhide', { bubbles: true, detail: { type: 'interior' } }));
            }
            page.classList.remove('hide');
            page.dispatchEvent(new CustomEvent('viewshow', { bubbles: true, detail: { type: 'custom', isRestored: false, options: {} } }));
            claimChrome();
            render();
            load();
        } else {
            render();
        }
    }

    /**
     * Jellyfin's own router has no #/requests and renders its "Page not found" page for it when the
     * URL is set directly (deep link, typed address): hidden while this page is shown (body class),
     * and the header title / document title say "Requests" once the router has finished.
     * @returns {void}
     */
    function claimChrome() {
        document.body.classList.add('je-hub-active');
        const title = tr('arr_hub_title');
        for (const delay of [0, 300, 1200]) {
            setTimeout(() => {
                if (!state.visible || !isRoute()) return;
                document.title = title;
                const header = document.querySelector('.skinHeader .pageTitle');
                if (header) header.textContent = title;
            }, delay);
        }
    }

    /**
     * Hides the page (navigation elsewhere) and stops following the feed.
     * @returns {void}
     */
    function hide() {
        if (!state.visible) return;
        state.visible = false;
        state.generation++;
        stopRetry();
        state.refreshFailed = false;
        document.body.classList.remove('je-hub-active');
        leaveEmbedded();
        H.admin?.leave?.();
        leaveExtras(null);
        follow(null);
        const page = document.getElementById(PAGE_ID);
        if (page) {
            page.classList.add('hide');
            page.dispatchEvent(new CustomEvent('viewhide', { bubbles: true, detail: { type: 'custom' } }));
        }
        if (state.previousPage && !document.querySelector(`.mainAnimatedPage:not(.hide):not(#${PAGE_ID})`)) {
            state.previousPage.classList.remove('hide');
            state.previousPage.dispatchEvent(new CustomEvent('viewshow', { bubbles: true, detail: { type: 'interior', isRestored: true } }));
        }
        state.previousPage = null;
    }

    /**
     * Reads the hub (one request per visit, again on a change from the feed). A read already
     * running is shared only within the same visit and user: one started before the page was left
     * (or the user changed) is ignored when it answers, so a new visit starts its own.
     * @returns {Promise<void>}
     */
    async function load() {
        if (state.loading && state.loading.generation === state.generation) return state.loading.promise;
        const generation = state.generation;
        // The session that asked owns the answer and any retry of it.
        const action = JE.createSessionAction?.() || null;
        const owned = () => generation === state.generation && state.visible && (!action || action.current());
        const run = { generation, promise: null };
        state.loading = run;
        run.promise = (async () => {
            try {
                const since = JE.arrStatus?.feedPosition ? await JE.arrStatus.feedPosition() : null;
                const data = await JE.core.api.plugin('/acquire/hub', { skipRetry: true });
                if (!owned()) return;
                if (!data || typeof data !== 'object') throw new Error('empty answer');
                state.data = data;
                state.error = false;
                state.refreshFailed = false;
                state.okAt = Date.now();
                stopRetry();
                render();
                follow(state.data, since);
            } catch (err) {
                if (!owned()) return;
                console.warn(`${logPrefix} could not load the Requests page (${err?.status || err?.message || err})`);
                if (state.data) {
                    // A re-read failed: what is on screen stays, with a note saying so (the change
                    // that asked for it has been used up, so it is tried again on our own).
                    state.refreshFailed = true;
                    scheduleRetry(generation, action);
                } else {
                    state.error = true;
                }
                render();
            } finally {
                if (state.loading === run) state.loading = null;
            }
        })();
        return run.promise;
    }

    /**
     * Tries a failed re-read again while the page is shown: after 5 s, then twice as long each
     * time, at most a minute apart. Stops when the page is left or the user changes.
     * @param {number} generation The visit the failure belongs to.
     * @param {{current: () => boolean}|null} [action] The session the failed read belongs to (a switch stops it).
     * @returns {void}
     */
    function scheduleRetry(generation, action) {
        if (state.retryTimer) return;
        state.retryDelay = JE.arrStatus.retryDelay(state.retryDelay);
        state.retryTimer = setTimeout(() => {
            state.retryTimer = null;
            if (generation === state.generation && state.visible && (!action || action.current())) load();
        }, state.retryDelay);
    }

    /**
     * Stops trying again (a read worked, or the page was left).
     * @returns {void}
     */
    function stopRetry() {
        if (state.retryTimer) clearTimeout(state.retryTimer);
        state.retryTimer = null;
        state.retryDelay = 0;
    }

    /**
     * The note shown while a re-read has failed and the page shows what it had (with Retry).
     * @returns {HTMLElement} Note.
     */
    function buildRefreshNote() {
        return JE.arrStatus.staleNote(state.okAt, () => { stopRetry(); load(); }, 'je-hub-note je-hub-note-warn je-hub-refresh-failed');
    }

    /**
     * The hub's lists as this user sees them: without what they hid with Hidden Content (when it
     * filters requests; globally hidden items only, matched by Jellyfin item id, or by TMDB id within
     * the same kind), and without a release day that has already passed where they are. Rendering
     * and the tab counts both use it. Hidden Content filters what the hub shows, nothing else.
     * @param {Object} data Hub response.
     * @returns {Object} The response with filtered mine, soon and ready.
     */
    function visibleData(data) {
        if (!data) return data;
        const hidden = hiddenSets();
        const shown = (e) => {
            if (!hidden) return true;
            if (e.itemId && hidden.ids.has(normalizeId(e.itemId))) return false;
            const tmdb = e.tmdbId ? String(e.tmdbId) : '';
            return !(tmdb && (e.kind === 'tv' ? hidden.shows : hidden.movies).has(tmdb));
        };
        return {
            ...data,
            mine: (data.mine || []).filter(shown),
            soon: (data.soon || []).filter(e => shown(e) && !(e.nextDay && JE.arrStatus?.dayPassed?.(e.nextDay))),
            ready: (data.ready || []).filter(shown)
        };
    }

    /**
     * A Jellyfin id without dashes, lower case.
     * @param {string} id Id.
     * @returns {string} Normalised id.
     */
    function normalizeId(id) {
        return String(id).replace(/-/g, '').toLowerCase();
    }

    /**
     * What this user hid everywhere (Hidden Content), when it filters requests: item ids, and TMDB
     * ids of hidden movies and of hidden series. Null when nothing is filtered.
     * @returns {{ids: Set<string>, movies: Set<string>, shows: Set<string>}|null} Sets.
     */
    function hiddenSets() {
        const hc = JE.hiddenContent;
        if (!hc || typeof hc.getSettings !== 'function' || typeof hc.getAllHiddenItems !== 'function') return null;
        const settings = hc.getSettings() || {};
        if (!settings.enabled || !settings.filterRequests) return null;
        const sets = { ids: new Set(), movies: new Set(), shows: new Set() };
        for (const item of hc.getAllHiddenItems() || []) {
            if ((item.hideScope || 'global') !== 'global') continue;
            if (item.itemId) sets.ids.add(normalizeId(item.itemId));
            if (!item.tmdbId) continue;
            if (item.type === 'Movie') sets.movies.add(String(item.tmdbId));
            else if (item.type === 'Series') sets.shows.add(String(item.tmdbId));
        }
        return sets.ids.size || sets.movies.size || sets.shows.size ? sets : null;
    }

    /**
     * Follows the change feed for what the page shows: every title key (and the key the feed
     * announces it under), the user's own request-list key and the shared request-list state key.
     * A change re-reads the page.
     * @param {Object|null} data Hub response (null: stop following).
     * @param {{epoch: string, cursor: number}|null} [since] Feed position from before the read.
     * @returns {void}
     */
    function follow(data, since) {
        if (state.unsubscribe) {
            state.unsubscribe();
            state.unsubscribe = null;
        }
        if (!data || !JE.arrStatus?.subscribe) return;
        const keys = new Set();
        for (const list of [data.mine, data.soon, data.ready]) {
            for (const entry of list || []) {
                if (entry.key) keys.add(entry.key);
                if (entry.liveKey) keys.add(entry.liveKey);
            }
        }
        const userId = typeof ApiClient !== 'undefined' && typeof ApiClient.getCurrentUserId === 'function' ? ApiClient.getCurrentUserId() : null;
        if (userId) keys.add('req:u:' + String(userId).replace(/-/g, '').toLowerCase());
        // Seerr's list as a whole: first read, failure and recovery (the loading / out-of-date notes).
        keys.add('req:state');
        state.unsubscribe = JE.arrStatus.subscribe([...keys], () => reloadSoon(), { since: since ?? null });
    }

    /**
     * Re-reads the page shortly (changes in a burst make one read).
     * @returns {void}
     */
    function reloadSoon() {
        if (state.reloadTimer) return;
        state.reloadTimer = setTimeout(() => {
            state.reloadTimer = null;
            if (state.visible) load();
        }, RELOAD_DELAY_MS);
    }

    /**
     * Leaves an embedded admin tab: stops the Downloads page's polling and removes its container
     * (so its own page never renders into the hub again).
     * @returns {void}
     */
    function leaveEmbedded() {
        if (!state.embedded) return;
        if (state.embedded.tab === 'downloads' && JE.downloadsPage) {
            if (JE.downloadsPage._state) JE.downloadsPage._state._customTabMode = false;
            JE.downloadsPage.stopPolling?.();
        }
        state.embedded.node.remove();
        state.embedded = null;
    }

    /**
     * Switches tab (the URL keeps it, without a new history entry).
     * @param {string} tab Tab id.
     * @returns {void}
     */
    function selectTab(tab) {
        state.tab = tab;
        const url = tab === 'mine' ? ROUTE : `${ROUTE}?tab=${encodeURIComponent(tab)}`;
        if (window.location.hash !== url) history.replaceState(history.state, '', url);
        render();
    }

    /**
     * The focus id (data-je-focus) of the page control that has focus, if focus is on the page.
     * @param {HTMLElement} root Page root.
     * @returns {string|null} Focus id.
     */
    function focusedId(root) {
        const active = document.activeElement;
        if (!active || !root.contains(active)) return null;
        return active.closest('[data-je-focus]')?.dataset.jeFocus || '';
    }

    /**
     * Gives focus back after a re-render to the same control (tab, row, Play, Manage), or to the
     * selected tab when that control is gone; only when focus was on the page and was lost.
     * @param {HTMLElement} root Page root.
     * @param {string|null} id Focus id from before the re-render.
     * @returns {void}
     */
    function restoreFocus(root, id) {
        if (id === null || root.contains(document.activeElement)) return;
        const target = [...root.querySelectorAll('[data-je-focus]')].find(node => node.dataset.jeFocus === id)
            || root.querySelector('.je-hub-tab[aria-selected="true"]');
        target?.focus({ preventScroll: true });
    }

    /**
     * Renders the page from the current state, keeping keyboard / D-pad focus where it was.
     * @returns {void}
     */
    function render() {
        const page = document.getElementById(PAGE_ID);
        const root = page?.querySelector('.je-hub');
        if (!root) return;
        const focus = focusedId(root);
        renderPage(root);
        restoreFocus(root, focus);
    }

    /**
     * Rebuilds the page root from the current state.
     * @param {HTMLElement} root Page root.
     * @returns {void}
     */
    function renderPage(root) {
        H.injectStyles?.();
        const available = tabs();
        // A tab named in the URL that isn't known yet (admin tabs before the first answer, phase-3
        // tabs while their module finds out) waits for it.
        const pending = extraTab(state.tab) && extraVisible(extraTab(state.tab)) === 'pending';
        if (!available.includes(state.tab) && state.data && !pending) state.tab = 'mine';
        // An embedded admin tab keeps its own DOM while it stays selected.
        if (state.embedded && state.embedded.tab === state.tab && root.contains(state.embedded.node)) {
            renderTabs(root, available);
            return;
        }
        leaveEmbedded();
        root.textContent = '';
        const title = document.createElement('h1');
        title.className = 'je-hub-title';
        title.appendChild(JE.arrStatus.icon('inbox'));
        title.appendChild(document.createTextNode(tr('arr_hub_title')));
        root.appendChild(title);
        const strip = document.createElement('div');
        strip.className = 'je-hub-tabs';
        strip.setAttribute('role', 'tablist');
        root.appendChild(strip);
        renderTabs(root, available);
        const panel = document.createElement('div');
        panel.className = 'je-hub-panel';
        panel.setAttribute('role', 'tabpanel');
        root.appendChild(panel);

        const extra = extraTab(state.tab);
        if (extra && available.includes(state.tab)) {
            H.admin?.leave?.();
            leaveExtras(extra);
            extra.render(panel);
            return;
        }
        leaveExtras(null);
        if (isAdminTab(state.tab) && available.includes(state.tab)) {
            H.admin.render(panel, state.tab);
            return;
        }
        H.admin?.leave?.();
        if ((state.tab === 'downloads' || state.tab === 'calendar') && available.includes(state.tab)) {
            const node = document.createElement('div');
            node.className = 'je-hub-tabpanel-embed';
            panel.appendChild(node);
            state.embedded = { tab: state.tab, node };
            try {
                if (state.tab === 'downloads') JE.downloadsPage.renderForCustomTab(node);
                else JE.calendarPage.renderForCustomTab(node);
            } catch (err) {
                console.warn(`${logPrefix} could not show the ${state.tab} tab`, err);
            }
            return;
        }
        if (!state.data || !available.includes(state.tab)) {
            const box = document.createElement('div');
            box.className = 'je-hub-empty';
            box.textContent = tr(state.error ? 'arr_hub_error' : 'arr_hub_loading');
            if (state.error) {
                const retry = document.createElement('button');
                retry.type = 'button';
                retry.className = 'je-hub-btn';
                retry.textContent = tr('arr_hub_retry');
                retry.style.marginLeft = '1em';
                retry.addEventListener('click', () => { state.error = false; render(); load(); });
                box.appendChild(retry);
            }
            panel.appendChild(box);
            return;
        }
        if (state.refreshFailed) panel.appendChild(buildRefreshNote());
        const view = visibleData(state.data);
        const notes = H.buildNotes(view);
        if (notes) panel.appendChild(notes);
        const actions = { open: openEntry, play: playEntry, manage: manageEntry };
        if (state.tab === 'soon') H.renderSoon(panel, view, actions);
        else if (state.tab === 'ready') H.renderReady(panel, view, actions);
        else H.renderMine(panel, mineView(view), actions);
    }

    /**
     * My requests with the request ledger's own requests added (phase 3), when that module is there.
     * @param {Object} view Visible hub data.
     * @returns {Object} The view to render.
     */
    function mineView(view) {
        if (!view || typeof H.mineLedger?.merge !== 'function') return view;
        try {
            return H.mineLedger.merge(view);
        } catch (err) {
            console.warn(`${logPrefix} could not add the request ledger to My requests`, err);
            return view;
        }
    }

    /**
     * Fills the tab strip.
     * @param {HTMLElement} root Page root.
     * @param {string[]} available Tab ids.
     * @returns {void}
     */
    function renderTabs(root, available) {
        const strip = root.querySelector('.je-hub-tabs');
        if (!strip) return;
        strip.textContent = '';
        const view = visibleData(state.data);
        const counts = {
            mine: (mineView(view)?.mine || []).filter(e => e.group !== 'declined' && e.group !== 'removed').length,
            soon: (view?.soon || []).length,
            ready: (view?.ready || []).length,
            overview: (H.admin?.state?.data?.overview?.needsAttention || []).length
        };
        for (const id of available) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'je-hub-tab';
            button.dataset.tab = id;
            button.dataset.jeFocus = `tab:${id}`;
            button.setAttribute('role', 'tab');
            button.setAttribute('aria-selected', String(id === state.tab));
            const extra = extraTab(id);
            button.textContent = extra ? tr(extra.label) : tr(`arr_hub_tab_${id}`);
            const n = extra ? extra.count?.() : counts[id];
            if (n) {
                const count = document.createElement('span');
                count.className = 'je-hub-tab-count';
                count.textContent = String(n);
                button.appendChild(count);
            }
            button.addEventListener('click', () => selectTab(id));
            strip.appendChild(button);
        }
    }

    /**
     * Opens a request: its Jellyfin page when the viewer can open one, else the title's native
     * details page (when offered) or Seerr's more-info modal.
     * @param {Object} entry Hub entry.
     * @returns {void}
     */
    function openEntry(entry) {
        if (entry.itemId) {
            showItem(entry.itemId);
            return;
        }
        const mediaType = entry.kind === 'tv' ? 'tv' : 'movie';
        if (JE.titleDetails?.show) {
            if (entry.tmdbId) JE.titleDetails.show(entry.tmdbId, mediaType);
            else if (entry.key) JE.titleDetails.openKey(entry.key, { mediaType });
            return;
        }
        if (entry.tmdbId && JE.jellyseerrMoreInfo?.open) JE.jellyseerrMoreInfo.open(entry.tmdbId, mediaType);
    }

    /**
     * Plays (opens) the Jellyfin item of a ready request.
     * @param {Object} entry Hub entry.
     * @returns {void}
     */
    function playEntry(entry) {
        if (entry.itemId) showItem(entry.itemId);
    }

    /**
     * Opens the Manage drawer for a request (administrators).
     * @param {Object} entry Hub entry.
     * @returns {void}
     */
    function manageEntry(entry) {
        JE.arrManage?.open(entry.itemId ? { itemId: entry.itemId } : { key: entry.key });
    }

    /**
     * Navigates to a Jellyfin item's details page.
     * @param {string} itemId Item id.
     * @returns {void}
     */
    function showItem(itemId) {
        if (window.Emby?.Page?.showItem) window.Emby.Page.showItem(itemId);
        else window.location.hash = `#/details?id=${encodeURIComponent(itemId)}`;
    }

    /**
     * Adds the "Requests" link to JE's sidebar section (once; again when the sidebar is rebuilt).
     * @returns {void}
     */
    function injectNavigation() {
        if (document.querySelector('.je-nav-requests-hub-item')) return;
        const section = document.querySelector('.jellyfinEnhancedSection');
        if (!section) return;
        const link = document.createElement('a');
        link.setAttribute('is', 'emby-linkbutton');
        link.className = 'navMenuOption lnkMediaFolder emby-button je-nav-requests-hub-item';
        link.href = ROUTE;
        const iconSpan = document.createElement('span');
        iconSpan.className = 'navMenuOptionIcon material-icons';
        iconSpan.textContent = 'inbox';
        const text = document.createElement('span');
        text.className = 'sectionName navMenuOptionText';
        text.textContent = tr('arr_hub_title');
        link.appendChild(iconSpan);
        link.appendChild(text);
        link.addEventListener('click', (e) => {
            e.preventDefault();
            show();
        });
        section.appendChild(link);
    }

    /**
     * Shows or hides the page for the current URL.
     * @returns {void}
     */
    function handleNavigation() {
        if (isRoute()) show();
        else if (state.visible) hide();
    }

    /**
     * Claims #/requests before Jellyfin's router (which has no such page).
     * @param {HashChangeEvent|PopStateEvent} e Event.
     * @returns {void}
     */
    function intercept(e) {
        const hash = e?.newURL ? new URL(e.newURL).hash : window.location.hash;
        if (!isRoute(hash)) return;
        e.stopImmediatePropagation?.();
        e.preventDefault?.();
        show();
    }

    /**
     * Starts the Requests page (behind its flag).
     * @returns {void}
     */
    function initialize() {
        if (state.started || !enabled()) return;
        state.started = true;
        H.injectStyles?.();
        injectNavigation();
        JE.helpers?.onSidebarRebuilt?.('requests-hub', '.je-nav-requests-hub-item', injectNavigation);
        window.addEventListener('hashchange', intercept, true);
        window.addEventListener('popstate', intercept, true);
        const lifecycle = JE.core?.lifecycle?.register('arr-hub');
        const off = JE.core?.navigation?.onNavigate?.(handleNavigation);
        if (lifecycle && off) lifecycle.track(off);
        document.addEventListener('viewshow', (e) => {
            if (state.visible && e.target && e.target.id !== PAGE_ID && !isRoute()) hide();
        });
        // Hiding or unhiding something (here or on another page) shows at once.
        window.addEventListener('je-hidden-content-changed', () => {
            if (state.visible && state.data) render();
        });
        for (const start of Array.isArray(H.starters) ? H.starters : []) {
            try {
                start();
            } catch (err) {
                console.warn(`${logPrefix} could not start a Requests page extension`, err);
            }
        }
        handleNavigation();
    }

    JE.session?.onUserChange?.('arr-hub', () => {
        state.data = null;
        state.error = false;
        state.refreshFailed = false;
        state.okAt = 0;
        stopRetry();
        state.generation++;
        follow(null);
        if (state.visible) {
            render();
            load();
        }
    });

    /**
     * Redraws just the tab strip (an admin tab's answer changed the Overview count), keeping focus
     * on the same tab when it was there.
     * @returns {void}
     */
    function refreshTabs() {
        const root = document.getElementById(PAGE_ID)?.querySelector('.je-hub');
        if (!root || !state.visible) return;
        const strip = root.querySelector('.je-hub-tabs');
        const focus = strip && strip.contains(document.activeElement) ? focusedId(root) : null;
        renderTabs(root, tabs());
        if (focus) restoreFocus(root, focus);
    }

    H.state = state;
    H.load = load;
    H.render = render;
    H.visibleData = visibleData;
    H.renderTabs = refreshTabs;
    H.selectTab = selectTab;
    JE.arrHub = Object.freeze({ show, hide, refresh: load, isRoute });
    JE.initializeArrHub = initialize;
})(window.JellyfinEnhanced);
