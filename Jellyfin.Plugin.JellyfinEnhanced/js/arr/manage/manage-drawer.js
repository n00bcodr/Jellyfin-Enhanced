/**
 * @file Requests & downloads, phase 1: the administrator's Manage drawer (Overview only). Opens from
 * the "Manage" button on details pages, the Seerr more-info modal and the Requests page. Shows where
 * the title has got to (the admin status with every copy's reason and fix), Search now and Open in
 * Sonarr/Radarr per instance, the versions across instances, a timeline per instance and Seerr's
 * requests. Reads GET /JellyfinEnhanced/arr/admin/manage; Search now posts to
 * /arr/admin/manage/search (audited on the server). With phase 2 the title's downloads get their
 * non-destructive queue actions (Retry import, Search again, Remove… keeping the data) through
 * POST /arr/admin/queue/action, with the hub's consequences dialog for Remove. With phase 3 and Jellyfin Enhanced handling
 * requests, "Add to {instance}" opens a sheet (GET /arr/admin/manage/add-options: the instance's quality profiles, root
 * folders and the title's seasons) and adds through the request outbox (POST /arr/admin/manage/add), the arr link kept as a
 * fallback. Follows the change feed while open. A drawer on the right on desktop, a bottom sheet on phones, a full panel on
 * TV. Exposes JE.arrManage.
 */
(function (JE) {
    'use strict';

    const RELOAD_DELAY_MS = 300;
    const ADD_POLL_MS = 1500;
    const ADD_POLL_TRIES = 20;
    const logPrefix = '🪼 Jellyfin Enhanced: Manage:';
    const EVENT_LABELS = {
        added: 'arr_manage_event_added',
        grabbed: 'arr_manage_event_grabbed',
        downloadFolderImported: 'arr_manage_event_imported',
        episodeFileImported: 'arr_manage_event_imported',
        movieFileImported: 'arr_manage_event_imported',
        downloadFailed: 'arr_manage_event_failed',
        movieFileDeleted: 'arr_manage_event_deleted',
        episodeFileDeleted: 'arr_manage_event_deleted',
        movieFileRenamed: 'arr_manage_event_renamed',
        episodeFileRenamed: 'arr_manage_event_renamed',
        downloadIgnored: 'arr_manage_event_ignored'
    };
    const EVENT_ICONS = {
        added: 'add_circle_outline',
        grabbed: 'download',
        downloadFolderImported: 'move_to_inbox',
        episodeFileImported: 'move_to_inbox',
        movieFileImported: 'move_to_inbox',
        downloadFailed: 'error_outline',
        movieFileDeleted: 'delete_outline',
        episodeFileDeleted: 'delete_outline',
        audit: 'history',
        inJellyfin: 'video_library'
    };

    let current = null; // { target, root, opener, unsubscribe, reloadTimer, generation, data, result, searching, queueBusy }
    let generation = 0;
    let refocusing = false;

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
     * Creates an element.
     * @param {string} tag Tag.
     * @param {string} [cls] Classes.
     * @param {string} [text] Text.
     * @returns {HTMLElement} Element.
     */
    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    /**
     * True when the server has the drawer on (admins get the data; the server refuses everyone else).
     * @returns {boolean} Enabled.
     */
    function enabled() {
        return JE.pluginConfig?.ArrManageDrawerEnabled === true && JE.arrStatus?.enabled?.() === true;
    }

    /**
     * An instance's address as this browser should open it: the instance URL, or its URL mapping for
     * the address Jellyfin is being used at (same rule as the arr links).
     * @param {string} url Instance URL.
     * @param {string} mappings "jellyfin_url|arr_url" per line.
     * @returns {string|null} Base URL (http/https only).
     */
    function mappedUrl(url, mappings) {
        let base = url;
        const server = (typeof ApiClient !== 'undefined' && ApiClient.serverAddress ? ApiClient.serverAddress() : window.location.origin) || '';
        const here = server.replace(/\/+$/, '').toLowerCase();
        for (const line of String(mappings || '').split('\n')) {
            const parts = line.split('|').map(p => p.trim());
            if (parts.length === 2 && parts[0] && parts[1] && parts[0].replace(/\/+$/, '').toLowerCase() === here) {
                base = parts[1];
                break;
            }
        }
        if (typeof base !== 'string' || !/^https?:\/\//i.test(base)) return null;
        return base.replace(/\/+$/, '');
    }

    /**
     * The page of the title in an instance (or its add page when the title isn't there).
     * @param {Object} instance Instance from the overview.
     * @param {Object} data Overview.
     * @returns {string|null} URL.
     */
    function arrLink(instance, data) {
        const base = mappedUrl(instance.url, instance.urlMappings);
        if (!base) return null;
        const movie = data.kind === 'movie';
        if (instance.inArr) {
            if (movie && data.tmdbId) return `${base}/movie/${encodeURIComponent(data.tmdbId)}`;
            if (!movie && instance.titleSlug) return `${base}/series/${encodeURIComponent(instance.titleSlug)}`;
            return base;
        }
        const term = movie ? (data.tmdbId ? `tmdb:${data.tmdbId}` : data.title) : (data.tvdbId ? `tvdb:${data.tvdbId}` : data.title);
        return term ? `${base}/add/new?term=${encodeURIComponent(term)}` : base;
    }

    /**
     * "S02E05" / "Season 2" scope text.
     * @param {Object} data Overview.
     * @returns {string} Text ('' for a whole title).
     */
    function scopeText(data) {
        const pad = (n) => String(n).padStart(2, '0');
        if (data.season != null && data.episode != null) return `S${pad(data.season)}E${pad(data.episode)}`;
        if (data.season != null) return tr('arr_hub_season', { list: data.season });
        return '';
    }

    /**
     * Bytes as GB/MB.
     * @param {number} bytes Size.
     * @returns {string} Text.
     */
    function size(bytes) {
        if (!(bytes > 0)) return '';
        const gb = bytes / 1073741824;
        return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1048576))} MB`;
    }

    /**
     * A date with its time ("Tue 21:04" / "14 Nov 21:04").
     * @param {string} iso ISO date.
     * @returns {string} Text.
     */
    function when(iso) {
        const d = new Date(iso);
        if (!iso || isNaN(d.getTime())) return '';
        return `${JE.arrStatus.formatDate(iso)} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
    }

    /**
     * Opens the drawer for a Jellyfin item or a title key.
     * @param {{itemId?: string, key?: string}} target What to manage.
     * @returns {Promise<void>}
     */
    async function open(target) {
        if (!enabled() || !target || (!target.itemId && !target.key)) return;
        close();
        const opener = document.activeElement;
        const mine = ++generation;
        const overlay = el('div', 'je-manage-overlay');
        const root = el('aside', 'je-manage');
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-label', tr('arr_manage_button'));
        root.tabIndex = -1;
        overlay.appendChild(root);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        root.addEventListener('keydown', onKey);
        document.body.appendChild(overlay);
        document.addEventListener('focusin', keepFocus, true);
        current = { target, overlay, root, opener, unsubscribe: null, reloadTimer: null, generation: mine, data: null, result: null, searching: {}, queueBusy: {}, adding: {}, okAt: 0, refreshFailed: false, retryTimer: null, retryDelay: 0 };
        JE.internals.arrManage.injectStyles?.();
        renderShell(root, null);
        root.focus();
        await load(mine);
    }

    /**
     * Esc closes; Tab stays inside the drawer (from the drawer itself, or anything that isn't one of
     * its controls, Tab goes to the first control and Shift+Tab to the last).
     * @param {KeyboardEvent} e Event.
     * @returns {void}
     */
    function onKey(e) {
        if (e.key === 'Escape') {
            e.stopPropagation();
            close();
            return;
        }
        if (e.key !== 'Tab' || !current) return;
        const focusable = [...current.root.querySelectorAll('button, a[href], select, input, [tabindex="0"]')].filter(n => !n.disabled);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (!focusable.includes(active)) {
            e.preventDefault();
            (e.shiftKey ? last : first).focus();
        } else if (e.shiftKey && active === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
        }
    }

    /**
     * The drawer is modal: focus that lands outside it while it is open (a control removed by a
     * re-render, a click on the page behind on TV) comes back to the drawer, so Esc/Back and Tab
     * keep working.
     * @param {FocusEvent} e Event.
     * @returns {void}
     */
    function keepFocus(e) {
        // The hub's dialogs (Remove…) open above the drawer and keep focus themselves.
        if (!current || refocusing || current.overlay.contains(e.target) || e.target?.closest?.('.je-ops-dialog-overlay')) return;
        refocusing = true;
        try {
            current.root.focus();
        } finally {
            refocusing = false;
        }
    }

    /**
     * Reads the overview and renders it; then follows the title on the change feed.
     * @param {number} mine Open generation.
     * @returns {Promise<void>}
     */
    async function load(mine) {
        const state = current;
        if (!state || state.generation !== mine) return;
        const q = state.target.itemId ? `itemId=${encodeURIComponent(state.target.itemId)}` : `key=${encodeURIComponent(state.target.key)}`;
        try {
            const since = JE.arrStatus?.feedPosition ? await JE.arrStatus.feedPosition() : null;
            const data = await JE.core.api.plugin(`/arr/admin/manage?${q}`, { skipRetry: true });
            if (current !== state || state.generation !== mine) return;
            if (!data || typeof data !== 'object') throw new Error('empty answer');
            state.data = data;
            state.okAt = Date.now();
            state.refreshFailed = false;
            stopRetry(state);
            renderShell(state.root, data);
            follow(state, data, since);
        } catch (err) {
            if (current !== state || state.generation !== mine) return;
            console.warn(`${logPrefix} could not load (${err?.status || err?.message || err})`);
            if (!state.data) {
                renderShell(state.root, null, true);
                return;
            }
            // A re-read failed: the drawer keeps what it shows, says so, and tries again on its own
            // (the feed change that asked for it has been used up).
            state.refreshFailed = true;
            renderShell(state.root, state.data);
            if (!state.retryTimer) {
                state.retryDelay = JE.arrStatus.retryDelay(state.retryDelay);
                state.retryTimer = setTimeout(() => {
                    state.retryTimer = null;
                    if (current === state) load(state.generation);
                }, state.retryDelay);
            }
        }
    }

    /**
     * Stops trying a failed re-read again (a read worked, or the drawer closed).
     * @param {Object} state Drawer state.
     * @returns {void}
     */
    function stopRetry(state) {
        if (state.retryTimer) clearTimeout(state.retryTimer);
        state.retryTimer = null;
        state.retryDelay = 0;
    }

    /**
     * Follows the title (and the key the feed announces it under) while the drawer is open.
     * @param {Object} state Drawer state.
     * @param {Object} data Overview.
     * @param {{epoch: string, cursor: number}|null} since Feed position from before the read.
     * @returns {void}
     */
    function follow(state, data, since) {
        if (state.unsubscribe) state.unsubscribe();
        state.unsubscribe = null;
        const keys = [data.key, data.status?.key, data.status?.liveKey].filter(Boolean);
        if (!keys.length || !JE.arrStatus?.subscribe) return;
        state.unsubscribe = JE.arrStatus.subscribe(keys, () => {
            if (state.reloadTimer || current !== state) return;
            state.reloadTimer = setTimeout(() => {
                state.reloadTimer = null;
                if (current === state) load(state.generation);
            }, RELOAD_DELAY_MS);
        }, { since: since ?? null });
    }

    /**
     * Closes the drawer.
     * @returns {void}
     */
    function close() {
        if (!current) return;
        const state = current;
        current = null;
        generation++;
        if (state.unsubscribe) state.unsubscribe();
        if (state.reloadTimer) clearTimeout(state.reloadTimer);
        stopRetry(state);
        document.removeEventListener('focusin', keepFocus, true);
        // The Remove dialog it opened (in the hub's dialog layer) goes with it.
        JE.internals.arrHub?.admin?.closeDialog?.('drawer');
        state.overlay.remove();
        if (state.opener && typeof state.opener.focus === 'function' && document.contains(state.opener)) state.opener.focus();
    }

    /**
     * Renders the drawer (loading, error or the overview).
     * @param {HTMLElement} root Drawer.
     * @param {Object|null} data Overview.
     * @param {boolean} [failed] The read failed.
     * @returns {void}
     */
    function renderShell(root, data, failed) {
        const hadFocus = !!document.activeElement && root.contains(document.activeElement);
        const focused = hadFocus ? document.activeElement.dataset?.jeFocus : null;
        root.textContent = '';
        const head = el('div', 'je-manage-head');
        const titleText = data ? [data.title || data.key, scopeText(data)].filter(Boolean).join(' · ') : '';
        head.appendChild(el('h2', 'je-manage-title', data ? tr('arr_manage_title', { title: titleText }) : tr('arr_manage_button')));
        const closeBtn = el('button', 'je-manage-close');
        closeBtn.type = 'button';
        closeBtn.dataset.jeFocus = 'close';
        closeBtn.setAttribute('aria-label', tr('arr_manage_close'));
        closeBtn.appendChild(JE.arrStatus.icon('close'));
        closeBtn.addEventListener('click', close);
        head.appendChild(closeBtn);
        root.appendChild(head);
        if (!data) {
            root.appendChild(el('div', 'je-manage-empty', tr(failed ? 'arr_manage_error' : 'arr_manage_loading')));
            if (hadFocus && !root.contains(document.activeElement)) root.focus();
            return;
        }
        const chips = el('div', 'je-manage-chips');
        for (const instance of data.instances || []) {
            if (!instance.inArr) continue;
            const chip = el('span', `je-manage-chip${instance.live ? ' je-manage-live' : ''}`);
            chip.appendChild(el('span', 'je-manage-chip-kind', instance.kind === 'Sonarr' ? 'S' : 'R'));
            chip.appendChild(document.createTextNode(instance.name));
            chip.appendChild(el('span', 'je-manage-chip-state', instance.live ? tr('arr_manage_live') : tr('arr_manage_not_live')));
            chips.appendChild(chip);
        }
        if (chips.childNodes.length) root.appendChild(chips);
        if (current?.refreshFailed && current.data === data) {
            const state = current;
            root.appendChild(JE.arrStatus.staleNote(state.okAt, () => { stopRetry(state); load(state.generation); }, 'je-manage-stale'));
        }
        const tabs = el('div', 'je-manage-tabs');
        tabs.setAttribute('role', 'tablist');
        const tab = el('span', 'je-manage-tab', tr('arr_manage_overview'));
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', 'true');
        tabs.appendChild(tab);
        root.appendChild(tabs);

        root.appendChild(explainCard(data));
        root.appendChild(versions(data));
        for (const instance of (data.instances || []).filter(i => i.inArr)) root.appendChild(timeline(instance, data));
        if ((data.requests || []).length) root.appendChild(requests(data));
        // Focus stays where it was (the same control after the re-render), else on the drawer.
        if (hadFocus && !root.contains(document.activeElement)) {
            const again = focused ? [...root.querySelectorAll('[data-je-focus]')].find(n => n.dataset.jeFocus === focused) : null;
            (again || root).focus();
        }
    }

    /**
     * The explanation card: the admin status (every copy's reason, the arr's words and the fix),
     * then Search now / Open in per instance holding the title.
     * @param {Object} data Overview.
     * @returns {HTMLElement} Card.
     */
    function explainCard(data) {
        const card = el('section', `je-manage-card${data.status?.attention ? ' je-manage-attention' : ''}`);
        card.appendChild(el('h3', 'je-manage-section-title', tr('arr_manage_explain')));
        if (data.status) {
            const ctx = { contact: '', lookingHours: 24 };
            const block = JE.arrStatus.buildPill(data.status, ctx);
            const pill = block.matches?.('button') ? block : block.querySelector?.('button');
            if (pill) pill.dataset.jeFocus = 'pill';
            card.appendChild(block);
        }
        const buttons = el('div', 'je-manage-actions');
        const holders = (data.instances || []).filter(i => i.inArr);
        for (const instance of holders) {
            const search = el('button', 'je-manage-btn je-manage-btn-primary');
            search.type = 'button';
            search.dataset.jeFocus = `search-${instance.id}`;
            // A Search now of ours still running on this instance: shown on every re-render (the
            // search itself changes the title), and not clickable (aria-disabled keeps the focus).
            const ours = !!current?.searching?.[instance.id];
            if (ours) search.setAttribute('aria-disabled', 'true');
            const busy = ours || instance.searching;
            search.appendChild(JE.arrStatus.icon(busy ? 'hourglass_top' : 'search'));
            search.appendChild(document.createTextNode(busy
                ? tr('arr_manage_searching')
                : holders.length > 1 ? `${tr('arr_manage_search_now')} · ${instance.name}` : tr('arr_manage_search_now')));
            search.addEventListener('click', () => searchNow(instance, data));
            buttons.appendChild(search);
            const href = arrLink(instance, data);
            if (href) buttons.appendChild(linkButton(href, tr('arr_manage_open_in', { instance: instance.name }), `open-${instance.id}`));
        }
        if (buttons.childNodes.length) card.appendChild(buttons);
        for (const instance of holders) {
            for (const download of instance.downloads || []) {
                const row = downloadRow(instance, download, data);
                if (row) card.appendChild(row);
            }
            // Only the first downloads are listed: say how many more there are (the Activity tab has them all).
            const moreDownloads = (instance.downloadsTotal || 0) - (instance.downloads || []).length;
            if (moreDownloads > 0) card.appendChild(el('div', 'je-manage-more', tr('arr_manage_and_more', { n: moreDownloads })));
        }
        // The last Search now outcome survives the re-render the search itself triggers (feed change).
        const result = el('div', `je-manage-result${current?.result?.failed ? ' je-manage-result-failed' : ''}`, current?.result?.message || '');
        result.setAttribute('aria-live', 'polite');
        card.appendChild(result);
        return card;
    }

    /**
     * One download of the title (phase 2) with its non-destructive queue actions: Retry import,
     * Search again and Remove… (keeping the data; the hub's consequences dialog with blocklist and
     * search-again choices and the season-pack warning). Removing the data stays in the hub.
     * @param {Object} instance Instance.
     * @param {Object} download Download (queue group).
     * @param {Object} data Overview.
     * @returns {HTMLElement|null} Row (null when it offers nothing).
     */
    function downloadRow(instance, download, data) {
        const actions = (download.actions || []).filter(a => a === 'retry_import' || a === 'search' || a === 'remove');
        if (!actions.length) return null;
        const row = el('div', `je-manage-download${download.problem ? ' je-manage-attention-text' : ''}`);
        const pct = typeof download.percent === 'number' ? `${download.percent}%` : '';
        const what = [download.scope, [download.state || download.status, pct].filter(Boolean).join(' '), download.client].filter(Boolean).join(' · ');
        row.appendChild(el('div', 'je-manage-event-label', `${tr('arr_manage_downloads')} · ${instance.name}${what ? ` · ${what}` : ''}`));
        if (download.release) row.appendChild(el('div', 'je-manage-path', download.release));
        for (const message of (download.messages || []).slice(0, 2)) row.appendChild(el('div', 'je-manage-event-detail', message));
        const buttons = el('div', 'je-manage-actions');
        // Keyed by instance and download id: two instances can report the same download id.
        const key = `${instance.id}|${download.downloadId}`;
        const busy = !!current?.queueBusy?.[key];
        const add = (action, label) => {
            const b = el('button', 'je-manage-btn', label);
            b.type = 'button';
            b.dataset.jeFocus = `dl-${action}-${key}`;
            if (busy) b.setAttribute('aria-disabled', 'true');
            b.addEventListener('click', () => queueAction(instance, download, action, b, data));
            buttons.appendChild(b);
        };
        if (actions.includes('retry_import')) add('retry_import', tr('arr_ops_fix_retry_import'));
        if (actions.includes('search')) add('search', tr('arr_ops_action_search'));
        if (actions.includes('remove') && JE.internals.arrHub?.admin?.removeDialog) add('remove', tr('arr_ops_action_remove'));
        row.appendChild(buttons);
        return row;
    }

    /**
     * Runs a queue action from the drawer (Remove asks first, in the hub's dialog). One at a time
     * per download; the outcome shows under the explanation; the feed brings the change.
     * @param {Object} instance Instance.
     * @param {Object} download Download.
     * @param {string} action retry_import, search or remove.
     * @param {HTMLElement} opener The button clicked.
     * @param {Object} data Overview.
     * @returns {void}
     */
    function queueAction(instance, download, action, opener, data) {
        const state = current;
        const key = `${instance.id}|${download.downloadId}`;
        if (!state || state.queueBusy[key]) return;
        const send = async (body) => {
            if (current !== state || state.queueBusy[key]) return;
            state.queueBusy[key] = true;
            renderShell(state.root, state.data || data);
            const idempotencyKey = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            let message;
            let failed = false;
            try {
                const outcome = await JE.core.api.plugin('/arr/admin/queue/action', { method: 'POST', body: { ...body, idempotencyKey }, skipRetry: true });
                failed = outcome?.status === 'Failed' || outcome?.status === 'Rejected';
                message = failed ? tr('arr_ops_action_failed', { message: outcome?.message || '' }) : [outcome?.message, outcome?.readBack].filter(Boolean).join(' ');
            } catch (err) {
                failed = true;
                message = tr('arr_ops_action_failed', { message: err?.message || String(err) });
            }
            delete state.queueBusy[key];
            if (current !== state) return;
            state.result = { message: message || '', failed };
            renderShell(state.root, state.data || data);
            setTimeout(() => { if (current === state) load(state.generation); }, 1500);
        };
        if (action !== 'remove') {
            send({ instanceId: instance.id, downloadId: download.downloadId, action });
            return;
        }
        const target = { instanceId: instance.id, downloadId: download.downloadId, title: [download.title, download.scope].filter(Boolean).join(' '), scope: download.scope, episodes: download.episodes || 0, instance: instance.name };
        JE.internals.arrHub.admin.removeDialog(target, key, opener, !!download.problem, send);
    }

    /**
     * The movie or series key without a season or episode part (what an instance adds).
     * @param {string} key Title key.
     * @returns {string} Title key.
     */
    function titleKey(key) {
        return String(key || '').split(':').slice(0, 3).join(':');
    }

    /**
     * A fresh idempotency key for one add sheet (a repeated tap is the same add).
     * @returns {string} Key.
     */
    function sheetKey() {
        return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    /**
     * Opens the "Add to {instance}" sheet and reads the instance's choices (profiles, folders, seasons).
     * @param {Object} instance Instance from the overview.
     * @param {Object} data Overview.
     * @returns {Promise<void>}
     */
    async function openAdd(instance, data) {
        const state = current;
        if (!state || state.adding[instance.id]) return;
        const sheet = { phase: 'loading', key: sheetKey(), options: null, profileId: '', rootFolder: '', seasons: [], message: '', failed: false };
        state.adding[instance.id] = sheet;
        renderShell(state.root, state.data || data);
        focusOn(`add-cancel-${instance.id}`);
        try {
            const options = await JE.core.api.plugin(`/arr/admin/manage/add-options?instanceId=${encodeURIComponent(instance.id)}&key=${encodeURIComponent(titleKey(data.key))}`, { skipRetry: true });
            if (current !== state || state.adding[instance.id] !== sheet) return;
            sheet.options = options || {};
            if (!options?.direct) {
                sheet.phase = 'unavailable';
                sheet.message = options?.message || '';
            } else {
                // Only the instance's saved defaults are preselected; nothing is guessed.
                const defaults = options.defaults || {};
                sheet.profileId = (options.profiles || []).some(p => p.id === defaults.qualityProfileId) ? String(defaults.qualityProfileId) : '';
                sheet.rootFolder = (options.rootFolders || []).some(f => f.path === defaults.rootFolderPath) ? defaults.rootFolderPath : '';
                sheet.seasons = (options.title?.seasons || []).filter(x => x.seasonNumber > 0).map(x => x.seasonNumber);
                sheet.phase = 'form';
            }
        } catch (err) {
            if (current !== state || state.adding[instance.id] !== sheet) return;
            sheet.phase = 'unavailable';
            sheet.message = tr('arr_manage_add_failed', { message: err?.responseJSON?.message || err?.message || String(err) });
        }
        renderShell(state.root, state.data || data);
        focusOn(sheet.phase === 'form' ? `add-profile-${instance.id}` : `add-cancel-${instance.id}`);
    }

    /**
     * Moves focus to a drawer control by its focus id (after a re-render).
     * @param {string} id Focus id.
     * @returns {void}
     */
    function focusOn(id) {
        const target = current ? [...current.root.querySelectorAll('[data-je-focus]')].find(n => n.dataset.jeFocus === id) : null;
        target?.focus?.();
    }

    /**
     * The add sheet for one instance: loading, why a direct add isn't offered (with the arr link), the
     * choices, sending, and the outcome.
     * @param {Object} instance Instance.
     * @param {Object} data Overview.
     * @returns {HTMLElement} Sheet.
     */
    function addSheet(instance, data) {
        const sheet = current.adding[instance.id];
        const box = el('div', 'je-manage-add');
        box.setAttribute('role', 'group');
        const heading = el('h4', 'je-manage-add-title', tr('arr_manage_add_heading', { instance: instance.name }));
        heading.id = `je-manage-add-h-${instance.id}`;
        box.setAttribute('aria-labelledby', heading.id);
        box.appendChild(heading);
        const href = arrLink(instance, data);
        const actions = el('div', 'je-manage-actions');
        const closeSheet = (label) => {
            const b = el('button', 'je-manage-btn', label);
            b.type = 'button';
            b.dataset.jeFocus = `add-cancel-${instance.id}`;
            b.addEventListener('click', () => {
                if (!current || sheet.phase === 'sending') return;
                delete current.adding[instance.id];
                renderShell(current.root, current.data || data);
                focusOn(`add-${instance.id}`);
            });
            return b;
        };
        if (sheet.phase === 'loading') {
            box.appendChild(el('div', 'je-manage-add-note', tr('arr_manage_add_loading', { instance: instance.name })));
            actions.appendChild(closeSheet(tr('arr_manage_add_cancel')));
        } else if (sheet.phase === 'unavailable') {
            box.appendChild(el('div', 'je-manage-add-note je-manage-add-warn', sheet.message || tr('arr_manage_add_unavailable', { instance: instance.name })));
            actions.appendChild(closeSheet(tr('arr_manage_add_cancel')));
            if (href) actions.appendChild(linkButton(href, tr('arr_manage_add_in', { instance: instance.name }), `add-sheetlink-${instance.id}`));
        } else if (sheet.phase === 'done') {
            const done = el('div', `je-manage-add-message${sheet.failed ? ' je-manage-add-failed' : ''}`, sheet.message);
            done.setAttribute('role', 'status');
            box.appendChild(done);
            actions.appendChild(closeSheet(tr('arr_manage_add_close')));
            if (sheet.failed && href) actions.appendChild(linkButton(href, tr('arr_manage_add_in', { instance: instance.name }), `add-sheetlink-${instance.id}`));
        } else {
            const options = sheet.options || {};
            const sending = sheet.phase === 'sending';
            if (!options.defaultsValid && options.defaultsMessage) {
                box.appendChild(el('div', 'je-manage-add-note je-manage-add-warn', tr('arr_manage_add_defaults_invalid', { message: options.defaultsMessage })));
            }
            box.appendChild(addSelect(instance, 'profile', tr('arr_manage_add_profile'), sheet.profileId,
                (options.profiles || []).map(p => ({ value: String(p.id), label: p.name })), v => { sheet.profileId = v; }, sending));
            box.appendChild(addSelect(instance, 'folder', tr('arr_manage_add_folder'), sheet.rootFolder,
                (options.rootFolders || []).map(f => ({
                    value: f.path,
                    label: f.freeSpace > 0 ? tr('arr_manage_add_folder_free', { path: f.path, free: size(f.freeSpace) }) : f.path,
                    disabled: f.accessible === false
                })), v => { sheet.rootFolder = v; }, sending));
            const seasons = options.title?.seasons;
            if (Array.isArray(seasons) && seasons.length) {
                const set = el('fieldset', 'je-manage-add-seasons');
                set.appendChild(el('legend', '', tr('arr_manage_add_seasons')));
                for (const season of seasons) {
                    const label = el('label', 'je-manage-add-season');
                    const box2 = document.createElement('input');
                    box2.type = 'checkbox';
                    box2.dataset.jeFocus = `add-season-${instance.id}-${season.seasonNumber}`;
                    box2.checked = sheet.seasons.includes(season.seasonNumber);
                    box2.disabled = sending;
                    box2.addEventListener('change', () => {
                        sheet.seasons = box2.checked
                            ? [...new Set([...sheet.seasons, season.seasonNumber])].sort((a, b) => a - b)
                            : sheet.seasons.filter(n => n !== season.seasonNumber);
                    });
                    label.appendChild(box2);
                    label.appendChild(document.createTextNode(season.seasonNumber === 0 ? tr('arr_manage_add_specials') : tr('arr_manage_add_season', { n: season.seasonNumber })));
                    set.appendChild(label);
                }
                box.appendChild(set);
            }
            const message = el('div', `je-manage-add-message${sheet.failed ? ' je-manage-add-failed' : ''}`, sheet.message || '');
            message.setAttribute('aria-live', 'polite');
            box.appendChild(message);
            const submit = el('button', 'je-manage-btn je-manage-btn-primary');
            submit.type = 'button';
            submit.dataset.jeFocus = `add-submit-${instance.id}`;
            if (sending) submit.setAttribute('aria-disabled', 'true');
            submit.appendChild(JE.arrStatus.icon(sending ? 'hourglass_top' : 'add_circle_outline'));
            submit.appendChild(document.createTextNode(sending ? tr('arr_manage_add_sending', { instance: instance.name }) : tr('arr_manage_add_submit')));
            submit.addEventListener('click', () => submitAdd(instance, data));
            actions.appendChild(submit);
            if (!sending) actions.appendChild(closeSheet(tr('arr_manage_add_cancel')));
            if (href) actions.appendChild(linkButton(href, tr('arr_manage_add_in', { instance: instance.name }), `add-sheetlink-${instance.id}`));
        }
        box.appendChild(actions);
        return box;
    }

    /**
     * One labelled select of the add sheet (with an empty "Choose…" entry when nothing is chosen).
     * @param {Object} instance Instance.
     * @param {string} name Field name (focus id part).
     * @param {string} label Label.
     * @param {string} value Chosen value.
     * @param {Array<{value: string, label: string, disabled?: boolean}>} choices Choices.
     * @param {function(string): void} onChange Stores the choice.
     * @param {boolean} disabled While sending.
     * @returns {HTMLElement} Field.
     */
    function addSelect(instance, name, label, value, choices, onChange, disabled) {
        const field = el('label', 'je-manage-add-field');
        field.appendChild(el('span', '', label));
        const select = document.createElement('select');
        select.dataset.jeFocus = `add-${name}-${instance.id}`;
        select.disabled = disabled;
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = tr('arr_manage_add_choose');
        select.appendChild(empty);
        for (const choice of choices) {
            const option = document.createElement('option');
            option.value = choice.value;
            option.textContent = choice.label;
            option.disabled = !!choice.disabled;
            select.appendChild(option);
        }
        select.value = value || '';
        select.addEventListener('change', () => onChange(select.value));
        field.appendChild(select);
        return field;
    }

    /**
     * Sends the add (one idempotency key per sheet), then follows the request until the instance
     * confirms it, it's held for a reason, or the wait ends.
     * @param {Object} instance Instance.
     * @param {Object} data Overview.
     * @returns {Promise<void>}
     */
    async function submitAdd(instance, data) {
        const state = current;
        const sheet = state?.adding?.[instance.id];
        if (!sheet || sheet.phase !== 'form') return;
        const series = data.kind !== 'movie';
        if (!sheet.profileId || !sheet.rootFolder || (series && !sheet.seasons.length)) {
            sheet.failed = true;
            sheet.message = tr(series && !sheet.seasons.length ? 'arr_manage_add_pick_season' : 'arr_manage_add_pick');
            renderShell(state.root, state.data || data);
            focusOn(`add-submit-${instance.id}`);
            return;
        }
        sheet.phase = 'sending';
        sheet.failed = false;
        sheet.message = tr('arr_manage_add_sending', { instance: instance.name });
        renderShell(state.root, state.data || data);
        focusOn(`add-submit-${instance.id}`);
        let outcome;
        try {
            outcome = await JE.core.api.plugin('/arr/admin/manage/add', {
                method: 'POST',
                body: {
                    instanceId: instance.id,
                    key: titleKey(data.key),
                    profileId: Number(sheet.profileId),
                    rootFolder: sheet.rootFolder,
                    seasons: series ? sheet.seasons : undefined,
                    idempotencyKey: sheet.key
                },
                skipRetry: true
            });
        } catch (err) {
            if (current !== state || state.adding[instance.id] !== sheet) return;
            sheet.phase = 'form';
            sheet.failed = true;
            sheet.message = tr('arr_manage_add_failed', { message: addReason(err?.responseJSON?.reason, err?.responseJSON?.message || err?.message, instance) });
            renderShell(state.root, state.data || data);
            focusOn(`add-submit-${instance.id}`);
            return;
        }
        if (current !== state || state.adding[instance.id] !== sheet) return;
        await followAdd(state, sheet, instance, data, outcome?.requestId);
    }

    /**
     * Polls the administrator's own requests for the add until it settles (sent: done; held or
     * refused: why), at most ADD_POLL_TRIES times; then re-reads the drawer.
     * @param {Object} state Drawer state.
     * @param {Object} sheet Sheet state.
     * @param {Object} instance Instance.
     * @param {Object} data Overview.
     * @param {string|undefined} requestId The request recorded for the add.
     * @returns {Promise<void>}
     */
    async function followAdd(state, sheet, instance, data, requestId) {
        let settled = null;
        for (let i = 0; requestId && i < ADD_POLL_TRIES && !settled; i++) {
            await new Promise(r => setTimeout(r, i === 0 ? 300 : ADD_POLL_MS));
            if (current !== state || state.adding[instance.id] !== sheet) return;
            try {
                const mine = await JE.core.api.plugin('/acquire/requests?view=mine', { skipRetry: true });
                const item = (mine?.items || []).find(x => x.id === requestId);
                const job = (item?.jobs || []).slice(-1)[0];
                if (!item) continue;
                if (['sent', 'stale', 'fulfilled'].includes(item.status)) settled = { failed: false, message: tr('arr_manage_add_done', { instance: instance.name }) };
                else if (item.status === 'pending' || job?.state === 'failed' || job?.state === 'parked') settled = { failed: true, message: tr('arr_manage_add_failed', { message: addReason(job?.reason || item.reason, '', instance) }) };
                else if (['cancelled', 'declined'].includes(item.status)) settled = { failed: true, message: tr('arr_manage_add_failed', { message: addReason(item.reason, '', instance) }) };
                else if (job?.state === 'retry') sheet.message = tr('arr_manage_add_retrying', { instance: instance.name });
                if (!settled) renderShell(state.root, state.data || data);
            } catch (err) {
                // The next poll tries again; the outcome is also on the Requests page.
            }
        }
        if (current !== state || state.adding[instance.id] !== sheet) return;
        sheet.phase = 'done';
        sheet.failed = settled?.failed === true;
        sheet.message = settled?.message || tr('arr_manage_add_waiting', { instance: instance.name });
        renderShell(state.root, state.data || data);
        focusOn(`add-cancel-${instance.id}`);
        load(state.generation);
    }

    /**
     * Administrator wording for why an add didn't go through.
     * @param {string|undefined} reason Reason code.
     * @param {string|undefined} fallback Server message.
     * @param {Object} instance Instance.
     * @returns {string} Text.
     */
    function addReason(reason, fallback, instance) {
        const known = ['invalid_defaults', 'defaults_unverified', 'backend_unavailable', 'instance_changed', 'not_aired', 'title_not_found', 'service_down', 'instance_rejected', 'requests_4k_required', 'direct_add_unavailable', 'maybe_sent'];
        if (reason && known.includes(reason)) return tr(`arr_manage_add_reason_${reason}`, { instance: instance.name });
        return fallback || reason || '';
    }

    /**
     * An external link styled as a button (opens in a new tab).
     * @param {string} href URL.
     * @param {string} label Text.
     * @param {string} focusId Focus restore id.
     * @returns {HTMLElement} Link.
     */
    function linkButton(href, label, focusId) {
        const a = el('a', 'je-manage-btn');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.dataset.jeFocus = focusId;
        a.appendChild(JE.arrStatus.icon('open_in_new'));
        a.appendChild(document.createTextNode(label));
        return a;
    }

    /**
     * Versions across instances: each instance of the title's kind, with this title's state there.
     * @param {Object} data Overview.
     * @returns {HTMLElement} Section.
     */
    function versions(data) {
        const section = el('section', 'je-manage-section');
        section.appendChild(el('h3', 'je-manage-section-title', tr('arr_manage_versions')));
        const variants = data.status?.admin?.variants || [];
        for (const instance of data.instances || []) {
            const row = el('div', 'je-manage-version');
            const name = el('div', 'je-manage-version-name', instance.name);
            if (instance.role && instance.role !== 'standard') name.appendChild(el('span', 'je-manage-role', instance.role.toUpperCase()));
            row.appendChild(name);
            if (!instance.readable) {
                row.appendChild(el('div', 'je-manage-version-state', tr('arr_manage_unreadable', { instance: instance.name })));
            } else if (!instance.inArr) {
                row.appendChild(el('div', 'je-manage-version-state', tr('arr_manage_not_in', { instance: instance.name })));
                const href = arrLink(instance, data);
                if (data.addDirect && !current?.adding?.[instance.id]) {
                    // Phase 3: a direct add through the request outbox, the arr's own add page kept as a fallback.
                    const actions = el('div', 'je-manage-actions');
                    const add = el('button', 'je-manage-btn je-manage-btn-primary');
                    add.type = 'button';
                    add.dataset.jeFocus = `add-${instance.id}`;
                    add.appendChild(JE.arrStatus.icon('add_circle_outline'));
                    add.appendChild(document.createTextNode(tr('arr_manage_add_to', { instance: instance.name })));
                    add.addEventListener('click', () => openAdd(instance, data));
                    actions.appendChild(add);
                    if (href) actions.appendChild(linkButton(href, tr('arr_manage_add_in', { instance: instance.name }), `addlink-${instance.id}`));
                    row.appendChild(actions);
                } else if (!data.addDirect && href) {
                    row.appendChild(linkButton(href, tr('arr_manage_add_in', { instance: instance.name }), `add-${instance.id}`));
                }
            } else {
                const variant = variants.find(v => v.instanceId === instance.id && !v.scope);
                if (variant) row.appendChild(el('div', `je-manage-version-state${variant.attention ? ' je-manage-attention-text' : ''}`, JE.arrStatus.adminReasonText({ ...variant, library: variant.library || instance.library })));
                const facts = [];
                facts.push(instance.monitored ? tr('arr_manage_monitored') : tr('arr_manage_unmonitored'));
                if (instance.qualityProfile) facts.push(tr('arr_manage_profile', { name: instance.qualityProfile }));
                if (instance.minimumAvailability) facts.push(tr('arr_manage_min_availability', { value: instance.minimumAvailability }));
                if (instance.sizeOnDisk > 0) facts.push(tr('arr_manage_size', { size: size(instance.sizeOnDisk) }));
                if (instance.lastSearch) facts.push(tr('arr_manage_last_search', { date: JE.arrStatus.formatDate(instance.lastSearch) }));
                const library = instance.library || variant?.library;
                facts.push(library ? tr('arr_manage_in_jellyfin', { library }) : tr('arr_manage_not_in_jellyfin'));
                row.appendChild(el('div', 'je-manage-version-facts', facts.join(' · ')));
                if (instance.path) row.appendChild(el('div', 'je-manage-path', instance.path));
            }
            // The add sheet stays (with its outcome) after the title reaches the instance.
            if (current?.adding?.[instance.id]) row.appendChild(addSheet(instance, data));
            section.appendChild(row);
        }
        return section;
    }

    /**
     * One instance's timeline: added, history events, Jellyfin Enhanced actions, then what is in the
     * queue now and the Jellyfin copy.
     * @param {Object} instance Instance.
     * @param {Object} data Overview.
     * @returns {HTMLElement} Section.
     */
    function timeline(instance, data) {
        const section = el('section', 'je-manage-section');
        section.appendChild(el('h3', 'je-manage-section-title', tr('arr_manage_timeline', { instance: instance.name })));
        const list = el('ol', 'je-manage-timeline');
        const pad = (n) => String(n).padStart(2, '0');
        for (const event of instance.timeline || []) {
            const li = el('li', `je-manage-event je-manage-event-${event.event}`);
            li.appendChild(JE.arrStatus.icon(EVENT_ICONS[event.event] || 'circle', 'je-manage-event-icon'));
            const body = el('div', 'je-manage-event-body');
            let label = event.event === 'audit' ? tr('arr_manage_event_audit', { text: event.text || '' }) : (EVENT_LABELS[event.event] ? tr(EVENT_LABELS[event.event]) : event.event);
            if (event.season != null && event.episode != null && data.episode == null) label += ` · S${pad(event.season)}E${pad(event.episode)}`;
            body.appendChild(el('span', 'je-manage-event-label', label));
            if (event.at) body.appendChild(el('span', 'je-manage-event-time', when(event.at)));
            if (event.message) body.appendChild(el('span', 'je-manage-event-detail', event.message));
            li.appendChild(body);
            list.appendChild(li);
        }
        // The queue shown is older than its freshness target, or can't be read and too old to say
        // anything about now (then the server gives no rows or downloads): say when it was read.
        if (instance.queueAsOf) {
            const li = el('li', `je-manage-event je-manage-event-queue-asof${instance.queueExpired ? ' je-manage-event-warn' : ''}`);
            li.setAttribute('role', 'status');
            li.appendChild(JE.arrStatus.icon(instance.queueExpired ? 'cloud_off' : 'schedule', 'je-manage-event-icon'));
            const body = el('div', 'je-manage-event-body');
            body.appendChild(el('span', 'je-manage-event-label', tr(instance.queueExpired ? 'arr_ops_queue_expired' : 'arr_ops_as_of', { time: when(instance.queueAsOf) })));
            li.appendChild(body);
            list.appendChild(li);
        }
        for (const row of instance.queue || []) {
            const li = el('li', `je-manage-event je-manage-event-queue${row.health && row.health !== 'ok' ? ' je-manage-event-warn' : ''}`);
            li.appendChild(JE.arrStatus.icon('downloading', 'je-manage-event-icon'));
            const body = el('div', 'je-manage-event-body');
            const parts = [];
            if (row.season != null && row.episode != null) parts.push(`S${pad(row.season)}E${pad(row.episode)}`);
            parts.push(typeof row.percent === 'number' ? `${row.state || ''} ${row.percent}%`.trim() : (row.state || ''));
            if (row.client) parts.push(row.client);
            if (row.quality) parts.push(row.quality);
            body.appendChild(el('span', 'je-manage-event-label', parts.filter(Boolean).join(' · ')));
            if (row.release) body.appendChild(el('span', 'je-manage-path', row.release));
            for (const message of row.messages || []) body.appendChild(el('span', 'je-manage-event-detail', message));
            li.appendChild(body);
            list.appendChild(li);
        }
        const moreRows = (instance.queueTotal || 0) - (instance.queue || []).length;
        if (moreRows > 0) list.appendChild(el('li', 'je-manage-event je-manage-more', tr('arr_manage_and_more', { n: moreRows })));
        if (instance.itemId) {
            const li = el('li', 'je-manage-event je-manage-event-inJellyfin');
            li.appendChild(JE.arrStatus.icon(EVENT_ICONS.inJellyfin, 'je-manage-event-icon'));
            const body = el('div', 'je-manage-event-body');
            body.appendChild(el('span', 'je-manage-event-label', tr('arr_manage_event_in_jellyfin', { library: instance.library || '' })));
            if (instance.inJellyfinAt) body.appendChild(el('span', 'je-manage-event-time', when(instance.inJellyfinAt)));
            li.appendChild(body);
            list.appendChild(li);
        }
        if (!list.childNodes.length) section.appendChild(el('div', 'je-manage-empty', tr('arr_manage_no_timeline')));
        else section.appendChild(list);
        return section;
    }

    /**
     * Seerr's requests for the title (who asked, when, state).
     * @param {Object} data Overview.
     * @returns {HTMLElement} Section.
     */
    function requests(data) {
        const section = el('section', 'je-manage-section');
        section.appendChild(el('h3', 'je-manage-section-title', tr('arr_manage_requests')));
        for (const request of data.requests) {
            const status = tr(`arr_manage_request_${request.status}`);
            let text = tr('arr_manage_request_line', { who: request.by || tr('arr_manage_request_someone'), date: request.at ? JE.arrStatus.formatDate(request.at) : '', status });
            if (request.is4k) text += ` · ${tr('arr_hub_4k')}`;
            const seasons = JE.internals.arrHub?.seasonsText ? JE.internals.arrHub.seasonsText(request.seasons) : '';
            if (seasons) text += ` · ${seasons}`;
            section.appendChild(el('div', 'je-manage-request', text));
        }
        return section;
    }

    /**
     * Search now on one instance (one idempotency key per click; the server audits it). One at a
     * time per instance while the drawer is open: the drawer's state says it is running, so a
     * re-render (the search changes the title) keeps the button busy.
     * @param {Object} instance Instance.
     * @param {Object} data Overview.
     * @returns {Promise<void>}
     */
    async function searchNow(instance, data) {
        const state = current;
        if (!state || state.searching[instance.id]) return;
        state.searching[instance.id] = true;
        renderShell(state.root, state.data || data);
        const idempotencyKey = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        let message;
        let failed = false;
        try {
            const outcome = await JE.core.api.plugin('/arr/admin/manage/search', {
                method: 'POST',
                body: { instanceId: instance.id, key: data.key, idempotencyKey },
                skipRetry: true
            });
            failed = outcome?.status === 'Failed' || outcome?.status === 'Rejected';
            message = [outcome?.message, outcome?.readBack].filter(Boolean).join(' ');
            if (failed) message = tr('arr_manage_search_failed', { message: outcome?.message || '' });
        } catch (err) {
            failed = true;
            message = tr('arr_manage_search_failed', { message: err?.message || String(err) });
        }
        delete state.searching[instance.id];
        if (current !== state) return;
        state.result = { message: message || '', failed };
        renderShell(state.root, state.data || data);
        // What changed comes through the change feed; read once more in any case.
        setTimeout(() => { if (current === state) load(state.generation); }, 1500);
    }

    /**
     * Adds (or refreshes) the Manage button on a details page for an administrator's status
     * (only admins get the status' admin block).
     * @param {HTMLElement} page Details page.
     * @param {Object|null} status Item status (null: remove the button).
     * @returns {void}
     */
    function attachDetails(page, status) {
        const existing = page?.querySelector?.('.je-manage-open');
        if (!enabled() || !status || !status.admin || !page) {
            existing?.remove();
            return;
        }
        // The page of a title that isn't in the library (native details): its page id is no item, so
        // the drawer opens by the title's key.
        const pageId = (() => {
            try { return new URLSearchParams((window.location.hash || '').split('?')[1] || '').get('id'); } catch { return null; }
        })();
        const absent = !!JE.titleDetails?.isSynthetic?.(pageId);
        const key = absent ? String(status.key || '').replace(/:s\d+(:e\d+)?$/, '') : '';
        const itemId = absent ? (key ? `key:${key}` : '') : status.itemId;
        if (!itemId) {
            existing?.remove();
            return;
        }
        const host = page.querySelector('.mainDetailButtons') || page.querySelector('.detailButtons');
        if (!host) return;
        if (existing && existing.dataset.itemId === itemId && host.contains(existing)) return;
        existing?.remove();
        const button = el('button', 'button-flat btnManage detailButton emby-button je-manage-open');
        button.type = 'button';
        button.dataset.itemId = itemId;
        button.title = tr('arr_manage_button');
        button.setAttribute('aria-label', tr('arr_manage_button'));
        const content = el('div', 'detailButton-content');
        content.appendChild(JE.arrStatus.icon('tune', 'detailButton-icon'));
        button.appendChild(content);
        button.addEventListener('click', (e) => {
            e.preventDefault();
            open(absent ? { key } : { itemId });
        });
        host.appendChild(button);
    }

    JE.session?.onUserChange?.('arr-manage', close);
    document.addEventListener('viewshow', () => close());

    JE.internals = JE.internals || {};
    JE.internals.arrManage = Object.assign(JE.internals.arrManage || {}, { attachDetails, mappedUrl, arrLink });
    JE.arrManage = Object.freeze({ open, close, isOpen: () => current !== null });
})(window.JellyfinEnhanced);
