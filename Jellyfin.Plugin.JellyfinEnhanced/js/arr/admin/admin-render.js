/**
 * @file Requests & downloads, phase 2: renders the administrator's tabs of the Requests page from the
 * server's answers: Overview (instance cards, Needs attention with inline fixes, next 24 hours, two
 * weeks of grabs and imports), Activity (downloads with their actions, recent history), System
 * (health, disks, tasks, versions, live connection and webhook, Seerr, the Jellyfin bridge and the
 * path doctor) and Audit. Pure DOM builders: every value goes in through textContent; links are
 * built only from http(s) addresses. Actions are callbacks from admin-tabs.js.
 */
(function (JE) {
    'use strict';

    const A = ((JE.internals = JE.internals || {}).arrHub = JE.internals.arrHub || {}).admin = JE.internals.arrHub.admin || {};

    const CODE_ICONS = {
        import_blocked: 'block',
        import_waiting: 'hourglass_bottom',
        download_failed: 'error_outline',
        download_warning: 'hourglass_empty',
        download_stalled: 'hourglass_disabled',
        client_unavailable: 'cloud_off',
        low_disk: 'storage',
        root_missing: 'folder_off',
        health: 'health_and_safety',
        instance_down: 'cloud_off',
        live_down: 'sync_problem',
        webhook_silent: 'notifications_off',
        not_in_jellyfin: 'sync',
        approved_not_in_arr: 'help_outline'
    };
    const FIX_ICONS = {
        open_in_arr: 'open_in_new',
        search_now: 'search',
        remove_search: 'restart_alt',
        retry_import: 'replay',
        scan_now: 'refresh',
        open_system: 'dns',
        open_seerr: 'open_in_new'
    };
    const ACTION_KEYS = {
        'movie.search': 'arr_ops_audit_search',
        'series.search': 'arr_ops_audit_search',
        'season.search': 'arr_ops_audit_search',
        'episode.search': 'arr_ops_audit_search',
        'queue.remove': 'arr_ops_audit_queue_remove',
        'queue.remove_with_data': 'arr_ops_audit_queue_remove_with_data',
        'queue.retry_import': 'arr_ops_audit_queue_retry_import',
        'queue.search': 'arr_ops_audit_queue_search',
        'jellyfin.scan': 'arr_ops_audit_scan',
        'webhook.provision': 'arr_ops_audit_webhook_provision',
        'webhook.remove': 'arr_ops_audit_webhook_remove',
        'webhook.manual-setup-shown': 'arr_ops_audit_webhook_manual'
    };
    const EVENT_KEYS = {
        grabbed: 'arr_manage_event_grabbed',
        downloadFolderImported: 'arr_manage_event_imported',
        episodeFileImported: 'arr_manage_event_imported',
        movieFileImported: 'arr_manage_event_imported',
        seriesFolderImported: 'arr_manage_event_imported',
        movieFolderImported: 'arr_manage_event_imported',
        downloadFailed: 'arr_manage_event_failed',
        movieFileDeleted: 'arr_manage_event_deleted',
        episodeFileDeleted: 'arr_manage_event_deleted',
        movieFileRenamed: 'arr_manage_event_renamed',
        episodeFileRenamed: 'arr_manage_event_renamed',
        downloadIgnored: 'arr_manage_event_ignored'
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
     * A material icon.
     * @param {string} name Icon name.
     * @returns {HTMLElement} Icon.
     */
    function icon(name) {
        return JE.arrStatus.icon(name);
    }

    /**
     * The key of one download for busy state, results and focus: its instance and its download id
     * (two instances sharing a download client can report the same id).
     * @param {{instanceId?: string, downloadId?: string}} d Download.
     * @returns {string} Key.
     */
    function downloadKey(d) {
        return `${d?.instanceId || ''}|${d?.downloadId || ''}`;
    }

    /**
     * Bytes as "412 GB" / "800 MB".
     * @param {number} bytes Bytes.
     * @returns {string} Text ('' when unknown).
     */
    function size(bytes) {
        if (typeof bytes !== 'number' || !(bytes >= 0)) return '';
        if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
        if (bytes >= 1e9) return `${Math.round(bytes / 1e9)} GB`;
        return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
    }

    /**
     * Date and time ("Tue 14:05").
     * @param {string} iso ISO date.
     * @returns {string} Text.
     */
    function when(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        return `${JE.arrStatus.formatDate(iso)} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }

    /**
     * A button with an icon.
     * @param {string} label Text.
     * @param {string} [iconName] Icon.
     * @param {string} [cls] Extra classes.
     * @param {string} [focusId] data-je-focus id (focus survives re-renders).
     * @returns {HTMLButtonElement} Button.
     */
    function button(label, iconName, cls, focusId) {
        const b = el('button', `je-ops-btn${cls ? ' ' + cls : ''}`);
        b.type = 'button';
        if (iconName) b.appendChild(icon(iconName));
        b.appendChild(document.createTextNode(label));
        if (focusId) b.dataset.jeFocus = focusId;
        return b;
    }

    /**
     * A link button to an http(s) address (opens a new tab), or null.
     * @param {string|null} href Address.
     * @param {string} label Text.
     * @param {string} [focusId] data-je-focus id.
     * @returns {HTMLAnchorElement|null} Link.
     */
    function linkButton(href, label, focusId) {
        if (!href || !/^https?:\/\//i.test(href)) return null;
        const a = el('a', 'je-ops-btn');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.appendChild(icon('open_in_new'));
        a.appendChild(document.createTextNode(label));
        if (focusId) a.dataset.jeFocus = focusId;
        return a;
    }

    /**
     * The live state chip of an instance card.
     * @param {Object} card Instance card.
     * @returns {HTMLElement} Chip.
     */
    function liveChip(card) {
        const state = card.live?.connection?.state;
        let cls = 'je-ops-muted';
        let key = 'arr_ops_live_off';
        let name = 'radio_button_unchecked';
        if (card.error) { cls = 'je-ops-bad'; key = 'arr_ops_live_down'; name = 'cloud_off'; }
        else if (state === 'Connected') { cls = 'je-ops-ok'; key = 'arr_ops_live_on'; name = 'circle'; }
        else if (card.live?.expected && (state === 'Connecting' || state === 'Waiting')) { cls = 'je-ops-warn'; key = 'arr_ops_live_reconnecting'; name = 'sync'; }
        else if (!card.live?.expected) { key = 'arr_ops_live_polling'; }
        const chip = el('span', `je-ops-state ${cls}`);
        chip.appendChild(icon(name));
        chip.appendChild(document.createTextNode(tr(key)));
        return chip;
    }

    /**
     * Disk bars of an instance.
     * @param {Object[]} disks Disks.
     * @returns {HTMLElement} Box.
     */
    function diskBars(disks) {
        const box = el('div');
        for (const d of disks || []) {
            const row = el('div', 'je-ops-disk');
            const label = el('div', 'je-ops-disk-label');
            const name = el('span');
            if (d.low || !d.accessible) name.appendChild(icon('warning'));
            name.appendChild(document.createTextNode(d.path));
            label.appendChild(name);
            label.appendChild(el('span', d.low ? 'je-ops-warn' : '', !d.accessible ? tr('arr_ops_disk_unreachable')
                : typeof d.usedPercent === 'number' ? `${d.usedPercent}%` : size(d.free)));
            row.appendChild(label);
            if (typeof d.usedPercent === 'number') {
                const bar = el('div', 'je-ops-bar');
                bar.setAttribute('role', 'meter');
                bar.setAttribute('aria-valuemin', '0');
                bar.setAttribute('aria-valuemax', '100');
                bar.setAttribute('aria-valuenow', String(d.usedPercent));
                bar.setAttribute('aria-label', tr('arr_ops_disk_used', { path: d.path, pct: d.usedPercent }));
                const fill = el('div', `je-ops-bar-fill${d.low ? ' je-ops-bar-low' : ''}`);
                fill.style.width = `${Math.max(0, Math.min(100, d.usedPercent))}%`;
                bar.appendChild(fill);
                row.appendChild(bar);
            }
            box.appendChild(row);
        }
        return box;
    }

    /**
     * One instance card (Overview).
     * @param {Object} card Card.
     * @returns {HTMLElement} Card.
     */
    function instanceCard(card) {
        const box = el('div', 'je-ops-card');
        box.dataset.instanceId = card.id;
        const head = el('div', 'je-ops-card-head');
        head.appendChild(el('span', 'je-ops-kind', (card.kind || '?').charAt(0)));
        head.appendChild(el('span', 'je-ops-name', card.name));
        head.appendChild(liveChip(card));
        box.appendChild(head);
        const line = el('div', 'je-ops-line');
        line.appendChild(el('span', '', tr('arr_ops_in_queue', { n: card.queue || 0 })));
        if (card.queueAttention) line.appendChild(el('span', 'je-ops-warn', tr('arr_ops_queue_attention', { n: card.queueAttention })));
        if (card.error) line.appendChild(el('span', 'je-ops-bad', card.error));
        else line.appendChild(el('span', card.health === 'ok' ? 'je-ops-ok' : card.health === 'error' ? 'je-ops-bad' : 'je-ops-warn',
            card.health === 'ok' ? tr('arr_ops_health_ok') : tr('arr_ops_health_issues', { n: card.healthIssues })));
        if (card.live?.webhook) {
            line.appendChild(el('span', card.live.webhookSilent ? 'je-ops-warn' : 'je-ops-ok', card.live.webhookSilent
                ? tr('arr_ops_webhook_silent_short')
                : card.live.webhookLastEventAt ? tr('arr_ops_webhook_last', { age: JE.arrStatus.ageText(card.live.webhookLastEventAt) }) : tr('arr_ops_webhook_set')));
        }
        box.appendChild(line);
        box.appendChild(diskBars(card.disks));
        return box;
    }

    /**
     * The title line of a Needs attention row: "Import blocked · Firefly S01E04 · Sonarr".
     * @param {Object} item Row.
     * @returns {string} Text.
     */
    function itemTitle(item) {
        const name = item.code === 'not_in_jellyfin'
            ? tr('arr_ops_code_not_in_jellyfin', { instance: item.instance || '' })
            : tr(`arr_ops_code_${item.code}`);
        const subject = [item.title ? item.title + (item.year && item.code !== 'low_disk' ? ` (${item.year})` : '') : '', item.scope || ''].filter(Boolean).join(' ');
        const parts = [name];
        if (item.code === 'low_disk' && item.params?.used) parts.push(`${item.title} ${item.params.used}%`);
        else if (subject && item.code !== 'instance_down' && item.code !== 'live_down' && item.code !== 'webhook_silent') parts.push(subject);
        if (item.instance && item.code !== 'not_in_jellyfin') parts.push(item.instance);
        return parts.join(' · ');
    }

    /**
     * The second line of a Needs attention row: the app's own words and how long.
     * @param {Object} item Row.
     * @returns {string} Text.
     */
    function itemSub(item) {
        const age = item.since ? JE.arrStatus.ageText(item.since) : '';
        switch (item.code) {
            case 'low_disk':
                return tr('arr_ops_low_disk_sub', { free: size(Number(item.params?.free)) });
            case 'not_in_jellyfin':
                return [tr(`arr_ops_missing_${item.message || 'not_scanned'}`, { path: item.detail || '', library: item.params?.library || '' }), age && tr('arr_ops_ago', { age })].filter(Boolean).join(' · ');
            case 'approved_not_in_arr':
                return [tr(item.params?.variant !== '4k' ? 'arr_admin_approved_not_in_arr' : String(item.key || '').startsWith('tv:') ? 'arr_admin_approved_not_in_4k_series' : 'arr_admin_approved_not_in_4k', { age }), item.message ? tr('arr_ops_asked_by', { name: item.message }) : ''].filter(Boolean).join(' · ');
            case 'live_down':
                return [tr('arr_ops_live_down_sub', { age }), item.message || ''].filter(Boolean).join(' · ');
            case 'webhook_silent':
                return tr('arr_ops_webhook_silent_sub', { instance: item.instance || '' });
            case 'download_stalled':
                return [tr('arr_ops_stalled_sub', { pct: item.params?.pct ?? '?' }), age && tr('arr_ops_for', { age })].filter(Boolean).join(' · ');
            default:
                return [item.message || '', item.detail || '', age && tr('arr_ops_for', { age })].filter(Boolean).join(' · ');
        }
    }

    /**
     * Needs attention (Overview).
     * @param {Object[]} items Rows.
     * @param {Object} ctx Callbacks and helpers.
     * @returns {HTMLElement} Box.
     */
    function needsAttention(items, ctx) {
        const box = el('section', 'je-ops-box je-ops-attention');
        const title = el('h2', 'je-ops-box-title', tr('arr_ops_needs_attention'));
        if (items.length) title.appendChild(el('span', 'je-ops-count', String(items.length)));
        box.appendChild(title);
        if (!items.length) {
            box.appendChild(el('div', 'je-ops-empty', tr('arr_ops_all_clear')));
            return box;
        }
        for (const item of items) {
            const row = el('div', 'je-ops-item');
            row.dataset.attention = item.code;
            const ic = el('span', `je-ops-icon ${item.severity === 'error' ? 'je-ops-bad' : 'je-ops-warn'}`);
            ic.appendChild(icon(CODE_ICONS[item.code] || 'report'));
            row.appendChild(ic);
            const body = el('div', 'je-ops-item-body');
            body.appendChild(el('div', 'je-ops-item-title', itemTitle(item)));
            const sub = itemSub(item);
            if (sub) body.appendChild(el('div', 'je-ops-item-sub', sub));
            if ((item.fixes || []).includes('remove_search')) {
                const more = el('button', 'je-ops-link', tr('arr_ops_keeps_partial'));
                more.type = 'button';
                more.dataset.jeFocus = `delete:${item.id}`;
                more.addEventListener('click', () => ctx.act('remove_with_data', item, more));
                body.appendChild(more);
            }
            if (ctx.results[item.id]) body.appendChild(el('div', `je-ops-item-sub${ctx.results[item.id].failed ? ' je-ops-bad' : ' je-ops-ok'}`, ctx.results[item.id].message));
            row.appendChild(body);
            const fixes = el('div', 'je-ops-fixes');
            (item.fixes || []).forEach((fix, i) => {
                const node = fixButton(fix, item, ctx, i === 0);
                if (node) fixes.appendChild(node);
            });
            if (fixes.childNodes.length) row.appendChild(fixes);
            box.appendChild(row);
        }
        return box;
    }

    /**
     * One fix button of a Needs attention row (or null when it can't be offered here).
     * @param {string} fix Fix id.
     * @param {Object} item Row.
     * @param {Object} ctx Callbacks and helpers.
     * @param {boolean} primary The row's main fix.
     * @returns {HTMLElement|null} Button or link.
     */
    function fixButton(fix, item, ctx, primary) {
        const focusId = `fix:${item.id}:${fix}`;
        if (fix === 'open_in_arr') return linkButton(ctx.arrUrl(item.instanceId, item.arrLink), tr('arr_ops_fix_open_in_arr', { instance: item.instance || '' }), focusId);
        if (fix === 'open_seerr') {
            const href = ctx.seerrUrl();
            const link = linkButton(href, tr('arr_ops_fix_open_seerr'), focusId);
            return link || el('span', 'je-ops-item-sub', tr('arr_fix_check_seerr'));
        }
        const b = button(tr(`arr_ops_fix_${fix}`), FIX_ICONS[fix], primary ? 'je-ops-btn-primary' : '', focusId);
        if (ctx.busy.has(item.id)) {
            b.setAttribute('aria-disabled', 'true');
        }
        if (ctx.busy.has(item.id) && primary) {
            b.textContent = '';
            b.appendChild(icon('hourglass_empty'));
            b.appendChild(document.createTextNode(tr('arr_ops_working')));
        }
        b.addEventListener('click', () => ctx.act(fix, item, b));
        return b;
    }

    /**
     * A sparkline of grabs and imports per day (inline SVG; the numbers are also in the label).
     * @param {Object[]} days Days.
     * @returns {HTMLElement} Box.
     */
    function sparkline(days) {
        const box = el('section', 'je-ops-box je-ops-spark');
        const grabs = days.reduce((s, d) => s + d.grabs, 0);
        const imports = days.reduce((s, d) => s + d.imports, 0);
        const head = el('div');
        head.appendChild(el('div', 'je-ops-box-title', tr('arr_ops_days', { grabs, imports })));
        const legend = el('div', 'je-ops-legend');
        legend.appendChild(el('span', 'je-ops-grabs', tr('arr_ops_grabs')));
        legend.appendChild(el('span', 'je-ops-imports', tr('arr_ops_imports')));
        head.appendChild(legend);
        box.appendChild(head);
        const W = 300;
        const Hh = 60;
        const max = Math.max(1, ...days.map(d => Math.max(d.grabs, d.imports)));
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
        svg.setAttribute('width', String(W));
        svg.setAttribute('height', String(Hh));
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', tr('arr_ops_days', { grabs, imports }));
        for (const [field, color] of [['grabs', '#64b5f6'], ['imports', '#f06292']]) {
            const line = document.createElementNS(NS, 'polyline');
            const step = days.length > 1 ? W / (days.length - 1) : W;
            line.setAttribute('points', days.map((d, i) => `${(i * step).toFixed(1)},${(Hh - 4 - (d[field] / max) * (Hh - 8)).toFixed(1)}`).join(' '));
            line.setAttribute('fill', 'none');
            line.setAttribute('stroke', color);
            line.setAttribute('stroke-width', '2');
            svg.appendChild(line);
        }
        box.appendChild(svg);
        return box;
    }

    /**
     * Overview tab.
     * @param {HTMLElement} panel Target.
     * @param {Object} data Overview.
     * @param {Object} ctx Callbacks and helpers.
     * @returns {void}
     */
    function renderOverview(panel, data, ctx) {
        const grid = el('div', 'je-ops-grid');
        const main = el('div', 'je-ops-main');
        const cards = el('div', 'je-ops-cards');
        for (const card of data.instances || []) cards.appendChild(instanceCard(card));
        if (!(data.instances || []).length) cards.appendChild(el('div', 'je-ops-empty', tr('arr_ops_no_instances')));
        main.appendChild(cards);
        main.appendChild(needsAttention(data.needsAttention || [], ctx));
        if ((data.days || []).length) main.appendChild(sparkline(data.days));
        grid.appendChild(main);

        const side = el('aside', 'je-ops-side');
        const next = el('section', 'je-ops-box');
        next.appendChild(el('h2', 'je-ops-box-title', tr('arr_ops_next_24h')));
        if (!(data.next24h || []).length) next.appendChild(el('div', 'je-ops-empty', tr('arr_ops_next_none')));
        for (const u of data.next24h || []) {
            const row = el('div', 'je-ops-upcoming');
            const pad = n => String(n).padStart(2, '0');
            const scope = u.season != null && u.episode != null ? ` S${pad(u.season)}E${pad(u.episode)}` : '';
            row.appendChild(el('div', 'je-ops-item-title', u.title + scope));
            row.appendChild(el('div', 'je-ops-item-sub', [when(u.at), u.instance, u.monitored ? tr('arr_ops_monitored') : tr('arr_ops_unmonitored')].filter(Boolean).join(' · ')));
            next.appendChild(row);
        }
        const counts = el('div');
        for (const [key, value] of [['arr_ops_downloading', data.downloading], ['arr_ops_waiting_ok', data.waitingForOk]]) {
            const kv = el('div', 'je-ops-kv');
            kv.appendChild(el('span', '', tr(key)));
            kv.appendChild(el('strong', '', String(value || 0)));
            counts.appendChild(kv);
        }
        next.appendChild(counts);
        side.appendChild(next);
        grid.appendChild(side);
        panel.appendChild(grid);
    }

    /**
     * The words for a download's state (the arr's own terms; admins only).
     * @param {Object} g Download.
     * @returns {string} Text.
     */
    function downloadState(g) {
        const parts = [g.state || g.status || ''];
        if (typeof g.percent === 'number') parts.push(`${g.percent}%`);
        if (g.size) parts.push(size(g.size));
        if (g.eta && g.state === 'downloading') parts.push(tr('arr_ops_eta', { time: when(g.eta) }));
        return parts.filter(Boolean).join(' · ');
    }

    /**
     * Activity tab: downloads with actions, then recent history.
     * @param {HTMLElement} panel Target.
     * @param {Object} data Activity.
     * @param {Object} ctx Callbacks and helpers.
     * @returns {void}
     */
    function renderActivity(panel, data, ctx) {
        const queue = el('section', 'je-ops-box je-ops-section');
        queue.appendChild(el('h2', 'je-ops-box-title', tr('arr_ops_queue_title', { n: (data.queue || []).length })));
        if (data.truncated) queue.appendChild(el('div', 'je-ops-item-sub je-ops-warn', tr('arr_ops_queue_truncated')));
        if (!(data.queue || []).length) queue.appendChild(el('div', 'je-ops-empty', tr('arr_ops_queue_empty')));
        for (const g of data.queue || []) {
            // A download is its instance's: two instances may report the same download id (one client).
            const dk = A.downloadKey(g);
            const row = el('div', 'je-ops-dl');
            row.dataset.downloadId = g.downloadId;
            const ic = el('span', `je-ops-icon ${g.problem ? 'je-ops-warn' : ''}`);
            ic.appendChild(icon(g.problem ? (CODE_ICONS[g.problem] || 'report') : 'download'));
            row.appendChild(ic);
            const body = el('div', 'je-ops-dl-body');
            body.appendChild(el('div', 'je-ops-item-title', [g.title + (g.year ? ` (${g.year})` : ''), g.scope, g.instance].filter(Boolean).join(' · ')));
            body.appendChild(el('div', 'je-ops-item-sub', [downloadState(g), g.client, g.quality].filter(Boolean).join(' · ')));
            if (typeof g.percent === 'number') {
                const bar = el('div', 'je-ops-bar');
                bar.setAttribute('role', 'progressbar');
                bar.setAttribute('aria-valuemin', '0');
                bar.setAttribute('aria-valuemax', '100');
                bar.setAttribute('aria-valuenow', String(g.percent));
                const fill = el('div', 'je-ops-bar-fill');
                fill.style.width = `${g.percent}%`;
                bar.appendChild(fill);
                body.appendChild(bar);
            }
            if (g.release) body.appendChild(el('div', 'je-ops-item-sub je-ops-path', g.release));
            for (const m of g.messages || []) body.appendChild(el('div', 'je-ops-msg', m));
            if (ctx.results[dk]) body.appendChild(el('div', `je-ops-item-sub${ctx.results[dk].failed ? ' je-ops-bad' : ' je-ops-ok'}`, ctx.results[dk].message));
            const actions = el('div', 'je-ops-dl-actions');
            const busy = ctx.busy.has(dk);
            const add = (action, label, name, cls) => {
                if (!(g.actions || []).includes(action)) return;
                const b = button(label, name, cls, `dl:${dk}:${action}`);
                if (busy) b.setAttribute('aria-disabled', 'true');
                b.addEventListener('click', () => ctx.queue(action, g, b));
                actions.appendChild(b);
            };
            add('remove', tr('arr_ops_action_remove'), 'remove_circle_outline');
            add('search', tr('arr_ops_action_search'), 'search');
            add('retry_import', tr('arr_ops_fix_retry_import'), 'replay');
            add('remove_with_data', tr('arr_ops_action_remove_with_data'), 'delete_forever', 'je-ops-btn-danger');
            const open = linkButton(ctx.arrUrl(g.instanceId, '/activity/queue'), tr('arr_ops_fix_open_in_arr', { instance: g.instance }), `dl:${dk}:open`);
            if (open) actions.appendChild(open);
            body.appendChild(actions);
            row.appendChild(body);
            queue.appendChild(row);
        }
        panel.appendChild(queue);

        const history = el('section', 'je-ops-box je-ops-section');
        history.appendChild(el('h2', 'je-ops-box-title', tr('arr_ops_history_title')));
        if (!(data.history || []).length) history.appendChild(el('div', 'je-ops-empty', tr('arr_ops_history_empty')));
        else {
            const table = el('table', 'je-ops-table');
            const head = el('thead');
            const hr = el('tr');
            for (const key of ['arr_ops_col_when', 'arr_ops_col_event', 'arr_ops_col_title', 'arr_ops_col_instance', 'arr_ops_col_quality']) hr.appendChild(el('th', '', tr(key)));
            head.appendChild(hr);
            table.appendChild(head);
            const tbody = el('tbody');
            for (const h of data.history) {
                const tr2 = el('tr');
                const pad = n => String(n).padStart(2, '0');
                const scope = h.season != null && h.episode != null ? ` S${pad(h.season)}E${pad(h.episode)}` : '';
                tr2.appendChild(el('td', '', when(h.date)));
                tr2.appendChild(el('td', '', EVENT_KEYS[h.event] ? tr(EVENT_KEYS[h.event]) : h.event));
                tr2.appendChild(el('td', '', (h.title || '') + scope));
                tr2.appendChild(el('td', '', h.instance));
                tr2.appendChild(el('td', '', h.quality || ''));
                tbody.appendChild(tr2);
            }
            table.appendChild(tbody);
            history.appendChild(table);
        }
        panel.appendChild(history);
    }

    /**
     * A small table. Words in cells are kept whole (short columns such as a type or a check name
     * never break mid-word); only the columns in <code>wrap</code> (paths, messages) may break
     * anywhere so a long path can't widen the table.
     * @param {string[]} headings en.json keys of the column headings.
     * @param {Array<Array<string|Node>>} rows Cells.
     * @param {number[]} [wrap] Indexes of the columns that may break anywhere.
     * @returns {HTMLTableElement} Table.
     */
    function table(headings, rows, wrap) {
        const t = el('table', 'je-ops-table');
        const head = el('thead');
        const hr = el('tr');
        headings.forEach((key, i) => hr.appendChild(el('th', wrap?.includes(i) ? 'je-ops-wrap' : '', tr(key))));
        head.appendChild(hr);
        t.appendChild(head);
        const body = el('tbody');
        for (const cells of rows) {
            const r = el('tr');
            for (const [i, c] of cells.entries()) {
                const td = el('td', wrap?.includes(i) ? 'je-ops-wrap' : '');
                if (c instanceof Node) td.appendChild(c);
                else td.textContent = c == null ? '' : String(c);
                r.appendChild(td);
            }
            body.appendChild(r);
        }
        t.appendChild(body);
        return t;
    }

    /**
     * System tab: per instance, then Seerr, then the Jellyfin bridge and path doctor.
     * @param {HTMLElement} panel Target.
     * @param {Object} data System.
     * @param {Object} ctx Callbacks and helpers.
     * @returns {void}
     */
    function renderSystem(panel, data, ctx) {
        for (const inst of data.instances || []) {
            const card = inst.card;
            const box = el('section', 'je-ops-box je-ops-section');
            box.dataset.instanceId = card.id;
            const head = el('div', 'je-ops-card-head');
            head.appendChild(el('span', 'je-ops-kind', (card.kind || '?').charAt(0)));
            head.appendChild(el('span', 'je-ops-name', `${card.name} · ${[inst.appName || card.kind, card.version].filter(Boolean).join(' ')}`));
            head.appendChild(liveChip(card));
            const open = linkButton(ctx.arrUrl(card.id, '/system/status'), tr('arr_ops_fix_open_in_arr', { instance: card.name }), `sys:${card.id}:open`);
            if (open) head.appendChild(open);
            box.appendChild(head);
            if (card.error) box.appendChild(el('div', 'je-ops-msg', card.error));
            const live = card.live || {};
            const conn = live.connection || {};
            const lines = el('div', 'je-ops-line');
            lines.appendChild(el('span', '', tr('arr_ops_live_line', {
                state: tr(conn.state === 'Connected' ? 'arr_ops_live_on' : live.expected ? 'arr_ops_live_reconnecting' : 'arr_ops_live_off'),
                since: conn.since ? when(conn.since) : '—'
            })));
            if (conn.lastError) lines.appendChild(el('span', 'je-ops-warn', conn.lastError));
            lines.appendChild(el('span', live.webhookSilent ? 'je-ops-warn' : '', live.webhook
                ? tr('arr_ops_webhook_line', { accepted: live.webhookAccepted || 0, refused: live.webhookRefused || 0, last: live.webhookLastEventAt ? when(live.webhookLastEventAt) : '—' })
                : tr('arr_ops_webhook_none')));
            box.appendChild(lines);

            const health = el('div', 'je-ops-section');
            health.appendChild(el('h3', '', tr('arr_ops_health_title')));
            if (!(inst.health || []).length) health.appendChild(el('div', 'je-ops-ok', tr('arr_ops_health_ok')));
            else health.appendChild(table(['arr_ops_col_type', 'arr_ops_col_source', 'arr_ops_col_message'], inst.health.map(h => [h.type, h.source, h.message]), [2]));
            box.appendChild(health);

            const disks = el('div', 'je-ops-section');
            disks.appendChild(el('h3', '', tr('arr_ops_disks_title')));
            disks.appendChild(diskBars(card.disks));
            box.appendChild(disks);

            if ((inst.tasks || []).length) {
                const tasks = el('div', 'je-ops-section');
                tasks.appendChild(el('h3', '', tr('arr_ops_tasks_title')));
                tasks.appendChild(table(['arr_ops_col_task', 'arr_ops_col_interval', 'arr_ops_col_last', 'arr_ops_col_next'],
                    inst.tasks.map(t => [t.name, t.interval ? tr('arr_duration_minutes', { n: t.interval }) : '—', when(t.lastExecution), when(t.nextExecution)])));
                box.appendChild(tasks);
            }
            panel.appendChild(box);
        }

        const seerr = el('section', 'je-ops-box je-ops-section');
        seerr.appendChild(el('h2', 'je-ops-box-title', tr('arr_ops_seerr_title')));
        if (!data.seerr) seerr.appendChild(el('div', 'je-ops-empty', tr('arr_hub_not_configured_admin')));
        else {
            seerr.appendChild(el('div', 'je-ops-line', tr('arr_ops_seerr_line', { n: data.seerrRequests || 0, last: data.seerr.lastReadAt ? when(data.seerr.lastReadAt) : '—' })));
            if (data.seerr.lastError) seerr.appendChild(el('div', 'je-ops-msg', tr('arr_hub_admin_seerr_error', { error: data.seerr.lastError })));
        }
        panel.appendChild(seerr);
        panel.appendChild(renderBridge(data.bridge || {}, data.settings || {}, ctx));
    }

    /**
     * The Jellyfin bridge section (System tab).
     * @param {Object} bridge Bridge state.
     * @param {Object} settings Thresholds.
     * @param {Object} ctx Callbacks and helpers.
     * @returns {HTMLElement} Section.
     */
    function renderBridge(bridge, settings, ctx) {
        const box = el('section', 'je-ops-box je-ops-section je-ops-bridge');
        box.appendChild(el('h2', 'je-ops-box-title', tr('arr_ops_bridge_title')));
        box.appendChild(el('div', 'je-ops-line', bridge.targetedRefresh
            ? tr('arr_ops_bridge_on', { n: bridge.refreshes || 0, found: bridge.found || 0 })
            : tr('arr_ops_bridge_off')));

        const missing = el('div', 'je-ops-section');
        missing.appendChild(el('h3', '', tr('arr_ops_missing_title')));
        const list = bridge.notInJellyfin || [];
        if (!list.length) missing.appendChild(el('div', 'je-ops-ok', tr('arr_ops_missing_none')));
        for (const m of list) {
            const row = el('div', 'je-ops-item');
            const body = el('div', 'je-ops-item-body');
            const pad = n => String(n).padStart(2, '0');
            const scope = m.season != null && m.episode != null ? ` S${pad(m.season)}E${pad(m.episode)}` : '';
            body.appendChild(el('div', 'je-ops-item-title', `${m.title || ''}${scope} · ${m.instance}`));
            body.appendChild(el('div', 'je-ops-item-sub', [tr(`arr_ops_missing_${m.problem}`, { path: m.jellyfinPath, library: m.library || '' }), tr('arr_ops_ago', { age: JE.arrStatus.ageText(m.importedAt) })].join(' · ')));
            const id = `bridge:${m.instanceId}:${m.arrPath}`;
            if (ctx.results[id]) body.appendChild(el('div', `je-ops-item-sub${ctx.results[id].failed ? ' je-ops-bad' : ' je-ops-ok'}`, ctx.results[id].message));
            row.appendChild(body);
            if (m.problem === 'not_scanned') {
                const b = button(tr('arr_ops_fix_scan_now'), 'refresh', '', `scan:${id}`);
                if (ctx.busy.has(id)) b.setAttribute('aria-disabled', 'true');
                b.addEventListener('click', () => ctx.scan({ id, instanceId: m.instanceId, arrPath: m.arrPath }, b));
                row.appendChild(b);
            }
            missing.appendChild(row);
        }
        const titles = bridge.missingTitles || {};
        const total = Object.values(titles.counts || {}).reduce((s, n) => s + n, 0);
        if (total) {
            missing.appendChild(el('div', 'je-ops-item-sub', tr('arr_ops_missing_titles', { n: total })));
            missing.appendChild(table(['arr_ops_col_title', 'arr_ops_col_instance', 'arr_ops_col_problem'],
                (titles.titles || []).map(t => [t.title + (t.year ? ` (${t.year})` : ''), t.instance, tr(`arr_ops_missing_${t.problem}`, { path: t.jellyfinPath || t.arrPath || '', library: '' })]), [2]));
        }
        box.appendChild(missing);

        const doctor = el('div', 'je-ops-section');
        doctor.appendChild(el('h3', '', tr('arr_ops_doctor_title')));
        for (const d of bridge.pathDoctor || []) {
            const part = el('div', 'je-ops-section');
            part.dataset.instanceId = d.instanceId;
            part.appendChild(el('div', `je-ops-item-title ${d.verdict === 'ok' ? 'je-ops-ok' : d.verdict === 'problem' ? 'je-ops-warn' : 'je-ops-muted'}`,
                `${d.instance} · ${tr(`arr_ops_doctor_${d.verdict}`)}`));
            if ((d.roots || []).length) {
                part.appendChild(table(['arr_ops_col_arr_path', 'arr_ops_col_jellyfin_path', 'arr_ops_col_library', 'arr_ops_col_problem'],
                    d.roots.map(r => [r.arrPath, r.jellyfinPath + (r.mapped ? '' : ` (${tr('arr_ops_doctor_same_path')})`), r.library || '—', r.problem ? tr(`arr_ops_doctor_root_${r.problem}`) : tr('arr_ops_doctor_fine')]), [0, 1]));
            }
            if (!(d.mappings || []).length) part.appendChild(el('div', 'je-ops-item-sub', tr('arr_ops_doctor_no_mappings')));
            for (const s of d.samples || []) {
                if (s.match) continue;
                part.appendChild(el('div', 'je-ops-msg', tr('arr_ops_doctor_sample', { title: s.title, expected: s.expected, actual: s.actual })));
            }
            if (d.suggestion) {
                part.appendChild(el('div', 'je-ops-item-sub', tr('arr_ops_doctor_suggestion', { arr: d.suggestion.arrPath, jellyfin: d.suggestion.jellyfinPath })));
            }
            doctor.appendChild(part);
        }
        box.appendChild(doctor);

        if ((bridge.recent || []).length) {
            const recent = el('div', 'je-ops-section');
            recent.appendChild(el('h3', '', tr('arr_ops_bridge_recent')));
            recent.appendChild(table(['arr_ops_col_when', 'arr_ops_col_path', 'arr_ops_col_folder', 'arr_ops_col_result'],
                bridge.recent.slice(0, 15).map(r => [when(r.at), r.jellyfinPath, r.folder || '—',
                    `${tr(`arr_ops_refresh_${r.outcome}`)}${r.found ? ' ✓' : ''}${r.ms ? ` · ${r.ms} ms` : ''}${r.error ? ` · ${r.error}` : ''}`]), [1, 2, 3]));
            box.appendChild(recent);
        }
        if (settings.libraryPendingMinutes) box.appendChild(el('div', 'je-ops-item-sub', tr('arr_ops_settings_line', { pending: settings.libraryPendingMinutes, disk: settings.lowDiskPercent, grace: settings.seerrHandoffGraceMinutes })));
        return box;
    }

    /**
     * Audit tab.
     * @param {HTMLElement} panel Target.
     * @param {Object} data Audit ({entries}).
     * @returns {void}
     */
    function renderAudit(panel, data) {
        const box = el('section', 'je-ops-box je-ops-section');
        box.appendChild(el('h2', 'je-ops-box-title', tr('arr_ops_audit_title')));
        const entries = data.entries || [];
        if (!entries.length) {
            box.appendChild(el('div', 'je-ops-empty', tr('arr_ops_audit_empty')));
        } else {
            box.appendChild(table(['arr_ops_col_when', 'arr_ops_col_who', 'arr_ops_col_action', 'arr_ops_col_title', 'arr_ops_col_result'],
                entries.map(e => {
                    const outcome = el('span', e.outcome === 'succeeded' ? 'je-ops-ok' : e.outcome === 'failed' ? 'je-ops-bad' : 'je-ops-warn', e.outcome);
                    const result = el('span');
                    result.appendChild(outcome);
                    const more = [e.readBack, e.message].filter(Boolean).join(' · ');
                    if (more) result.appendChild(document.createTextNode(` · ${more}`));
                    return [when(e.time), e.userName || '—', actionLabel(e.action), [e.details?.title || e.details?.key || e.target, e.details?.instance].filter(Boolean).join(' · '), result];
                }), [3, 4]));
        }
        panel.appendChild(box);
    }

    /**
     * A readable name for an audited action.
     * @param {string} action Action id ("queue.remove").
     * @returns {string} Text.
     */
    function actionLabel(action) {
        const key = ACTION_KEYS[action];
        return key ? tr(key) : String(action || '');
    }

    A.renderOverview = renderOverview;
    A.renderActivity = renderActivity;
    A.renderSystem = renderSystem;
    A.renderAudit = renderAudit;
    A.itemTitle = itemTitle;
    A.size = size;
    A.downloadKey = downloadKey;
})(window.JellyfinEnhanced);
