/**
 * @file Requests & downloads, phase 1: the administrator's Manage drawer (Overview only). Opens from
 * the "Manage" button on details pages, the Seerr more-info modal and the Requests page. Shows where
 * the title has got to (the admin status with every copy's reason and fix), Search now and Open in
 * Sonarr/Radarr per instance, the versions across instances, a timeline per instance and Seerr's
 * requests. Reads GET /JellyfinEnhanced/arr/admin/manage; Search now posts to
 * /arr/admin/manage/search (audited on the server). Follows the change feed while open. A drawer on
 * the right on desktop, a bottom sheet on phones, a full panel on TV. Exposes JE.arrManage.
 */
(function (JE) {
    'use strict';

    const RELOAD_DELAY_MS = 300;
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

    let current = null; // { target, root, opener, unsubscribe, reloadTimer, generation, data, result, searching }
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
        current = { target, overlay, root, opener, unsubscribe: null, reloadTimer: null, generation: mine, data: null, result: null, searching: {} };
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
        const focusable = [...current.root.querySelectorAll('button, a[href], [tabindex="0"]')].filter(n => !n.disabled);
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
        if (!current || refocusing || current.overlay.contains(e.target)) return;
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
            state.data = data;
            renderShell(state.root, data);
            follow(state, data, since);
        } catch (err) {
            if (current !== state) return;
            console.warn(`${logPrefix} could not load (${err?.status || err?.message || err})`);
            if (!state.data) renderShell(state.root, null, true);
        }
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
        document.removeEventListener('focusin', keepFocus, true);
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
        // The last Search now outcome survives the re-render the search itself triggers (feed change).
        const result = el('div', `je-manage-result${current?.result?.failed ? ' je-manage-result-failed' : ''}`, current?.result?.message || '');
        result.setAttribute('aria-live', 'polite');
        card.appendChild(result);
        return card;
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
                if (href) row.appendChild(linkButton(href, tr('arr_manage_add_in', { instance: instance.name }), `add-${instance.id}`));
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
        const itemId = status.itemId;
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
            open({ itemId });
        });
        host.appendChild(button);
    }

    JE.session?.onUserChange?.('arr-manage', close);
    document.addEventListener('viewshow', () => close());

    JE.internals = JE.internals || {};
    JE.internals.arrManage = Object.assign(JE.internals.arrManage || {}, { attachDetails, mappedUrl, arrLink });
    JE.arrManage = Object.freeze({ open, close, isOpen: () => current !== null });
})(window.JellyfinEnhanced);
