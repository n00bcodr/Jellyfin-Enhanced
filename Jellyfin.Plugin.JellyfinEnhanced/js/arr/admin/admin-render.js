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
    // Fixes that act on a page, not on one row: rows that offer only these can share one row.
    const PAGE_FIXES = new Set(['open_seerr', 'open_system']);
    // Rows alike enough to share one: from this many on.
    const GROUP_MIN = 3;
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
        'webhook.manual-setup-shown': 'arr_ops_audit_webhook_manual',
        'request.dispatch': 'arr_ops_audit_request_dispatch',
        'request.choice.claim': 'arr_ops_audit_choice_claim',
        'request.choice.claim.identity_merge': 'arr_ops_audit_choice_merge',
        'request.choice.claim.identity_split_fence': 'arr_ops_audit_choice_split_fence',
        'request.choice.claim.migration': 'arr_ops_audit_choice_migration',
        'request.choice.override': 'arr_ops_audit_choice_override',
        'request.choice.override.identity_split': 'arr_ops_audit_choice_override_split',
        denied: 'arr_ops_audit_denied'
    };
    // An audited outcome in plain words (the stored value stays in the row's details).
    const OUTCOME_KEYS = {
        succeeded: 'arr_ops_audit_outcome_succeeded',
        failed: 'arr_ops_audit_outcome_failed',
        unknown: 'arr_ops_audit_outcome_unknown',
        rejected: 'arr_ops_audit_outcome_rejected',
        denied: 'arr_ops_audit_outcome_rejected'
    };
    // The arr's queue states and statuses in the words Overview's Needs attention uses for the same download
    // (its arr_ops_code_* labels), with the rest named plainly; the arr's own spelling stays in the diagnostics.
    const QUEUE_STATE_KEYS = {
        importBlocked: 'arr_ops_code_import_blocked',
        importPending: 'arr_ops_code_import_waiting',
        importFailed: 'arr_ops_state_import_failed',
        importing: 'arr_ops_state_importing',
        imported: 'arr_ops_state_imported',
        failed: 'arr_ops_code_download_failed',
        failedPending: 'arr_ops_code_download_failed',
        downloading: 'arr_ops_state_downloading'
    };
    const QUEUE_STATUS_KEYS = {
        downloadClientUnavailable: 'arr_ops_code_client_unavailable',
        failed: 'arr_ops_code_download_failed',
        warning: 'arr_ops_code_download_warning',
        paused: 'arr_ops_state_paused',
        queued: 'arr_ops_state_queued',
        delay: 'arr_ops_state_delay',
        completed: 'arr_ops_state_completed',
        downloading: 'arr_ops_state_downloading'
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
        if (card.queueAttention) line.appendChild(el('span', 'je-ops-warn', tr(card.queueAttention === 1 ? 'arr_ops_queue_attention_one' : 'arr_ops_queue_attention', { n: card.queueAttention })));
        // The queue shown is older than it should be (the latest read failed or is under way).
        if (card.queueAsOf) line.appendChild(el('span', card.queueExpired ? 'je-ops-bad' : 'je-ops-warn', tr(card.queueExpired ? 'arr_ops_queue_expired' : 'arr_ops_as_of', { time: when(card.queueAsOf) })));
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
        const subject = [item.title ? item.title + (item.year && item.code !== 'low_disk' ? ` (${item.year})` : '') : '', item.scope || '', item.params?.variant === '4k' ? tr('arr_ops_tag_4k') : ''].filter(Boolean).join(' ');
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
     * The key rows share a collapsed row by: the same reason, instance, severity and fixes, and
     * (for not in Jellyfin) the same cause, (for OK'd in Seerr) the same copy and, for 4K, kind. Null when the row
     * offers a fix of its own (a button that acts on that row) or stands for a disk, not a title:
     * such rows always stay on their own.
     * @param {Object} item Row.
     * @returns {string|null} Key.
     */
    function attentionGroupKey(item) {
        const fixes = item.fixes || [];
        if (!fixes.length || !fixes.every(f => PAGE_FIXES.has(f)) || item.code === 'low_disk') return null;
        return [
            item.code, item.instanceId || '', item.severity || '', fixes.join(','),
            item.code === 'not_in_jellyfin' ? item.message || '' : '',
            // A 4K copy is worded per kind ("no 4K Sonarr" / "no 4K Radarr"); the standard wording is shared.
            item.code === 'approved_not_in_arr' && item.params?.variant === '4k' ? `4k:${String(item.key || '').split(':')[0]}` : ''
        ].join('|');
    }

    /**
     * Needs attention rows in order, with rows that share a key (GROUP_MIN or more) folded into
     * one entry at the place of the first.
     * @param {Object[]} items Rows.
     * @returns {Array<{item: Object}|{key: string, items: Object[]}>} Entries.
     */
    function groupAttention(items) {
        const byKey = new Map();
        for (const item of items) {
            const key = attentionGroupKey(item);
            if (key === null) continue;
            if (!byKey.has(key)) byKey.set(key, []);
            byKey.get(key).push(item);
        }
        const entries = [];
        const placed = new Set();
        for (const item of items) {
            const key = attentionGroupKey(item);
            const members = key === null ? null : byKey.get(key);
            if (!members || members.length < GROUP_MIN) {
                entries.push({ item });
            } else if (!placed.has(key)) {
                placed.add(key);
                entries.push({ key, items: members });
            }
        }
        return entries;
    }

    /**
     * What every row of a collapsed group shares beyond its reason, worded for many titles: why
     * Jellyfin doesn't list them (not in Jellyfin), or which app lacks them (OK'd in Seerr, 4K or
     * not). Empty for reasons whose heading says it all.
     * @param {Object} item The group's first row (the group key fixes these properties).
     * @returns {string} Text.
     */
    function groupReason(item) {
        if (item.code === 'not_in_jellyfin') {
            const cause = ['not_scanned', 'not_visible', 'outside_library'].includes(item.message) ? item.message : 'not_scanned';
            return tr(`arr_ops_group_missing_${cause}`);
        }
        if (item.code === 'approved_not_in_arr') {
            if (item.params?.variant !== '4k') return tr('arr_ops_group_approved');
            return tr(String(item.key || '').startsWith('tv:') ? 'arr_ops_group_approved_4k_series' : 'arr_ops_group_approved_4k');
        }
        return '';
    }

    /**
     * A title as a group lists it: "Inception (2010) S01".
     * @param {Object} item Row.
     * @returns {string} Text.
     */
    function memberName(item) {
        return [item.title ? item.title + (item.year ? ` (${item.year})` : '') : '', item.scope || ''].filter(Boolean).join(' ');
    }

    /**
     * One collapsed row for rows that share a reason and a page-level fix: the reason, how many,
     * the first few titles, the shared fix, and a toggle that lists every row.
     * @param {string} key Group key.
     * @param {Object[]} members Rows.
     * @param {Object} ctx Callbacks and helpers.
     * @returns {HTMLElement} Row.
     */
    function attentionGroup(key, members, ctx) {
        const first = members[0];
        const expanded = !!ctx.expanded?.has(key);
        const row = el('div', 'je-ops-item je-ops-group');
        row.dataset.attention = first.code;
        row.dataset.group = key;
        const ic = el('span', `je-ops-icon ${first.severity === 'error' ? 'je-ops-bad' : 'je-ops-warn'}`);
        ic.appendChild(icon(CODE_ICONS[first.code] || 'report'));
        row.appendChild(ic);
        const body = el('div', 'je-ops-item-body');
        const name = first.code === 'not_in_jellyfin'
            ? tr('arr_ops_code_not_in_jellyfin', { instance: first.instance || '' })
            : tr(`arr_ops_code_${first.code}`);
        body.appendChild(el('div', 'je-ops-item-title', [name, tr('arr_ops_group_count', { n: members.length }), first.code !== 'not_in_jellyfin' ? first.instance : ''].filter(Boolean).join(' · ')));
        // The property the rows were grouped by, so two groups of one reason read differently.
        const reason = groupReason(first);
        if (reason) body.appendChild(el('div', 'je-ops-item-sub je-ops-group-reason', reason));
        const names = members.map(memberName).filter(Boolean);
        if (names.length) {
            const shown = names.slice(0, 3).join(', ');
            body.appendChild(el('div', 'je-ops-item-sub', names.length > 3 ? tr('arr_ops_group_titles', { titles: shown, n: names.length - 3 }) : shown));
        }
        const listId = `je-ops-group-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
        const toggle = el('button', 'je-ops-link', tr(expanded ? 'arr_ops_group_hide' : 'arr_ops_group_show', { n: members.length }));
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.setAttribute('aria-controls', listId);
        toggle.dataset.jeFocus = `group:${key}`;
        toggle.addEventListener('click', () => ctx.toggleGroup?.(key));
        body.appendChild(toggle);
        if (expanded) {
            const list = el('ul', 'je-ops-group-list');
            list.id = listId;
            for (const item of members) {
                const li = el('li', 'je-ops-group-member');
                li.appendChild(el('div', 'je-ops-item-title', memberName(item) || itemTitle(item)));
                const sub = itemSub(item);
                if (sub) li.appendChild(el('div', 'je-ops-item-sub', sub));
                list.appendChild(li);
            }
            body.appendChild(list);
        }
        row.appendChild(body);
        const fixes = el('div', 'je-ops-fixes');
        // The fixes act on a page, so one set serves every member.
        const shared = { ...first, id: `group:${key}` };
        (first.fixes || []).forEach((fix, i) => {
            const node = fixButton(fix, shared, ctx, i === 0);
            if (node) fixes.appendChild(node);
        });
        if (fixes.childNodes.length) row.appendChild(fixes);
        return row;
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
        for (const entry of groupAttention(items)) {
            if (entry.key) {
                ctx.noteGroup?.(entry.key, entry.items.map(m => m.id));
                box.appendChild(attentionGroup(entry.key, entry.items, ctx));
                continue;
            }
            const item = entry.item;
            const row = el('div', 'je-ops-item');
            row.dataset.attention = item.code;
            const ic = el('span', `je-ops-icon ${item.severity === 'error' ? 'je-ops-bad' : 'je-ops-warn'}`);
            ic.appendChild(icon(CODE_ICONS[item.code] || 'report'));
            row.appendChild(ic);
            const body = el('div', 'je-ops-item-body');
            body.appendChild(el('div', 'je-ops-item-title', itemTitle(item)));
            const sub = itemSub(item);
            if (sub) body.appendChild(el('div', 'je-ops-item-sub', sub));
            // Remove & search again keeps the download's data: deleting it too is offered (with the
            // same blocklist / search choices) where the download allows it.
            if ((item.fixes || []).includes('remove_search') && ctx.canDeleteData?.(item) !== false) {
                const more = el('button', 'je-ops-link', tr('arr_ops_keeps_partial'));
                more.type = 'button';
                more.dataset.jeFocus = `delete:${item.id}`;
                more.addEventListener('click', (e) => ctx.act('remove_with_data', item, more, JE.ownerOf(e)));
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
        b.addEventListener('click', (e) => ctx.act(fix, item, b, JE.ownerOf(e)));
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
        // Phase 4: the Automation card (admin-automation.js), only when there is something to show.
        const automation = A.automationCard?.();
        if (automation) main.appendChild(automation);
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
        const parts = [queueStateLabel(g)];
        if (typeof g.percent === 'number') parts.push(`${g.percent}%`);
        if (g.size) parts.push(size(g.size));
        if (g.eta && g.state === 'downloading') parts.push(tr('arr_ops_eta', { time: when(g.eta) }));
        return parts.filter(Boolean).join(' · ');
    }

    /**
     * A download's state in plain words, as Overview names it: its Needs attention reason when it has one,
     * else the arr's pipeline state, else the client's status (the arr's spelling when neither is known).
     * @param {Object} g Queue group.
     * @returns {string} Text.
     */
    function queueStateLabel(g) {
        if (g.problem && g.problem !== 'not_in_jellyfin' && /^[a-z_]+$/.test(g.problem)) return tr(`arr_ops_code_${g.problem}`);
        const key = QUEUE_STATE_KEYS[g.state] || QUEUE_STATUS_KEYS[g.status];
        return key ? tr(key) : String(g.state || g.status || '');
    }

    // Technical details blocks the administrator opened, by key: a tab redrawn by the change feed keeps them open.
    const openDiagnostics = new Set();

    /**
     * A collapsed "Technical details" block of name/value lines (the identifiers the arr and JE use).
     * @param {Array<[string, *]>} facts Label key and value pairs; empty values are left out.
     * @param {string} cls Class of the block.
     * @param {string} key Stable key of the block (its row), so it stays open across redraws.
     * @returns {HTMLElement|null} Block, or null when nothing is known.
     */
    function diagnostics(facts, cls, key) {
        const shown = facts.filter(([, value]) => value != null && value !== '');
        if (!shown.length) return null;
        const box = el('details', `je-ops-diag ${cls}`);
        box.open = openDiagnostics.has(key);
        box.addEventListener('toggle', () => { if (box.open) openDiagnostics.add(key); else openDiagnostics.delete(key); });
        box.appendChild(el('summary', '', tr('arr_ops_diag_title')));
        const list = el('dl');
        for (const [label, value] of shown) {
            list.appendChild(el('dt', '', label.startsWith('arr_') ? tr(label) : label));
            list.appendChild(el('dd', 'je-ops-path', String(value)));
        }
        box.appendChild(list);
        return box;
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
        for (const card of (data.instances || []).filter(c => c.queueAsOf)) {
            queue.appendChild(el('div', `je-ops-item-sub ${card.queueExpired ? 'je-ops-bad' : 'je-ops-warn'}`,
                `${card.name} · ${tr(card.queueExpired ? 'arr_ops_queue_expired' : 'arr_ops_as_of', { time: when(card.queueAsOf) })}`));
        }
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
            const diag = diagnostics([['arr_ops_diag_state', g.state], ['arr_ops_diag_status', g.status], ['arr_ops_diag_health', g.health],
                ['arr_ops_diag_reason', g.problem], ['arr_ops_diag_download_id', g.downloadId]], 'je-ops-queue-diag', `dl:${dk}`);
            if (diag) body.appendChild(diag);
            if (ctx.results[dk]) body.appendChild(el('div', `je-ops-item-sub${ctx.results[dk].failed ? ' je-ops-bad' : ' je-ops-ok'}`, ctx.results[dk].message));
            const actions = el('div', 'je-ops-dl-actions');
            const busy = ctx.busy.has(dk);
            const add = (action, label, name, cls) => {
                if (!(g.actions || []).includes(action)) return;
                const b = button(label, name, cls, `dl:${dk}:${action}`);
                if (busy) b.setAttribute('aria-disabled', 'true');
                b.addEventListener('click', (e) => ctx.queue(action, g, b, JE.ownerOf(e)));
                actions.appendChild(b);
            };
            add('remove', tr('arr_ops_action_remove'), 'remove_circle_outline');
            add('search', tr('arr_ops_action_search'), 'search');
            add('retry_import', tr('arr_ops_fix_retry_import'), 'replay');
            // No row-level "delete data" button: deleting the download's data is offered inside the
            // Remove dialog (when the download allows it), with that dialog's blocklist choices.
            const open = linkButton(ctx.arrUrl(g.instanceId, '/activity/queue'), tr('arr_ops_fix_open_in_arr', { instance: g.instance }), `dl:${dk}:open`);
            if (open) actions.appendChild(open);
            body.appendChild(actions);
            row.appendChild(body);
            queue.appendChild(row);
        }
        panel.appendChild(queue);

        panel.appendChild(historySection(data, ctx));
    }

    /**
     * The Activity tab's history: the search tools (words, event kind, instance), what the search
     * covers per instance, the rows of the page answered and the pager. An answer for another
     * search than the one asked (it is on its way) is shown dimmed under "Searching…"; a failed read
     * of the search asked for shows an error with Try again. An answer without a search block (an
     * older server) is drawn as the newest events, without the tools.
     * @param {Object} data Activity.
     * @param {Object} ctx Callbacks and helpers (ctx.history: the search of admin-tabs.js).
     * @returns {HTMLElement} Section.
     */
    function historySection(data, ctx) {
        const section = el('section', 'je-ops-box je-ops-section je-history');
        section.appendChild(el('h2', 'je-ops-box-title', tr('arr_ops_history_title')));
        const rows = data.history || [];
        const hp = data.historyPage;
        const search = ctx.history;
        if (!hp || !search) {
            // The newest 100 events of every instance together (the arrs' own history holds more).
            if (rows.length) section.appendChild(el('div', 'je-ops-item-sub', tr('arr_ops_history_newest', { n: rows.length })));
            if (!rows.length) section.appendChild(el('div', 'je-ops-empty', tr('arr_ops_history_empty')));
            else section.appendChild(historyTable(rows));
            return section;
        }

        const asked = search.asked;
        section.appendChild(historyTools(data, search));
        const answers = search.answers(hp);
        const filtered = !!(asked.q || asked.event || asked.instance);
        if (!answers && search.failed()) {
            const box = el('div', 'je-ops-empty je-history-error');
            box.setAttribute('role', 'alert');
            box.appendChild(el('span', 'je-ops-bad', tr('arr_history_error')));
            const actions = el('div', 'je-ops-dl-actions');
            const retry = button(tr('arr_hub_retry'), 'refresh', '', 'history:retry');
            retry.addEventListener('click', () => search.retry());
            actions.appendChild(retry);
            if (filtered) actions.appendChild(clearButton(search));
            box.appendChild(actions);
            section.appendChild(box);
            return section;
        }

        const status = el('div', 'je-ops-item-sub je-history-status');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        status.textContent = answers ? tr(hp.total === 1 ? 'arr_history_results_one' : 'arr_history_results', { n: count(hp.total) }) : tr('arr_history_searching');
        section.appendChild(status);
        for (const line of coverageLines(hp)) section.appendChild(el('div', 'je-ops-item-sub je-history-coverage', line));

        const body = el('div', `je-history-body${answers ? '' : ' je-history-pending'}`);
        if (!answers) body.setAttribute('aria-busy', 'true');
        if (!rows.length) {
            const empty = el('div', 'je-ops-empty');
            empty.appendChild(el('div', '', tr(filtered ? 'arr_history_no_match' : 'arr_ops_history_empty')));
            if (filtered) {
                const actions = el('div', 'je-ops-dl-actions');
                actions.appendChild(clearButton(search));
                empty.appendChild(actions);
            }
            body.appendChild(empty);
        } else {
            body.appendChild(historyTable(rows));
        }
        section.appendChild(body);
        if ((hp.pages || 1) > 1) section.appendChild(pager(hp, search));
        return section;
    }

    /**
     * The search box and the event / instance chips.
     * @param {Object} data Activity (its instances name the instance chips).
     * @param {Object} search ctx.history.
     * @returns {HTMLElement} Tools.
     */
    function historyTools(data, search) {
        const asked = search.asked;
        const tools = el('div', 'je-history-tools');
        tools.setAttribute('role', 'search');
        const box = el('label', 'je-history-search');
        box.appendChild(icon('search'));
        box.appendChild(search.input());
        tools.appendChild(box);
        const kinds = [['', 'arr_history_event_all'], ['grabbed', 'arr_history_event_grabbed'], ['imported', 'arr_history_event_imported'], ['failed', 'arr_history_event_failed'],
            ['deleted', 'arr_history_event_deleted'], ['renamed', 'arr_history_event_renamed'], ['ignored', 'arr_history_event_ignored']];
        tools.appendChild(chips(tr('arr_history_event_label'), kinds.map(([value, key]) => ({ value, label: tr(key) })), asked.event, 'event', value => search.set({ event: value, page: 1 })));
        const instances = (data.instances || []).filter(i => i && i.id);
        if (instances.length > 1 || asked.instance) {
            const options = [{ value: '', label: tr('arr_history_instance_all') }, ...instances.map(i => ({ value: i.id, label: i.name || i.id }))];
            tools.appendChild(chips(tr('arr_history_instance_label'), options, asked.instance, 'instance', value => search.set({ instance: value, page: 1 })));
        }
        return tools;
    }

    /**
     * A row of toggle chips (one pressed).
     * @param {string} label Group name.
     * @param {Array<{value: string, label: string}>} options Chips.
     * @param {string} selected The value pressed.
     * @param {string} name Focus id prefix.
     * @param {function(string): void} pick Called with the chip's value.
     * @returns {HTMLElement} Group.
     */
    function chips(label, options, selected, name, pick) {
        const group = el('div', 'je-history-chips');
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', label);
        group.appendChild(el('span', 'je-history-chips-label', label));
        for (const option of options) {
            const chip = el('button', 'je-history-chip', option.label);
            chip.type = 'button';
            chip.dataset.jeFocus = `history:${name}:${option.value}`;
            chip.dataset.value = option.value;
            const on = option.value === selected;
            chip.setAttribute('aria-pressed', on ? 'true' : 'false');
            if (on) chip.prepend(icon('check'));
            chip.addEventListener('click', () => { if (option.value !== selected) pick(option.value); });
            group.appendChild(chip);
        }
        return group;
    }

    /**
     * "Clear filters".
     * @param {Object} search ctx.history.
     * @returns {HTMLButtonElement} Button.
     */
    function clearButton(search) {
        const b = button(tr('arr_history_clear'), 'clear', '', 'history:clear');
        b.addEventListener('click', () => search.clear());
        return b;
    }

    /**
     * Previous / Next and "Page 2 of 7". At the first or last page the button stays focusable
     * (aria-disabled) so D-pad focus isn't lost.
     * @param {Object} hp The answer's historyPage.
     * @param {Object} search ctx.history.
     * @returns {HTMLElement} Pager.
     */
    function pager(hp, search) {
        const nav = el('nav', 'je-history-pager');
        nav.setAttribute('aria-label', tr('arr_history_pager'));
        const page = hp.page || 1;
        const pages = hp.pages || 1;
        const prev = button(tr('arr_history_prev'), 'chevron_left', '', 'history:prev');
        const next = button(tr('arr_history_next'), 'chevron_right', '', 'history:next');
        if (page <= 1) prev.setAttribute('aria-disabled', 'true');
        if (page >= pages) next.setAttribute('aria-disabled', 'true');
        prev.addEventListener('click', () => { if (page > 1) search.set({ page: page - 1 }); });
        next.addEventListener('click', () => { if (page < pages) search.set({ page: page + 1 }); });
        nav.appendChild(prev);
        nav.appendChild(el('span', 'je-history-page', tr('arr_history_page', { page: count(page), pages: count(pages) })));
        nav.appendChild(next);
        return nav;
    }

    /**
     * "Radarr: the newest 2,000 of 5,312 events, since 3 Oct" — one line per instance searched.
     * @param {Object} hp The answer's historyPage.
     * @returns {string[]} Lines.
     */
    function coverageLines(hp) {
        return (hp.coverage || []).map(c => {
            const instance = c.instance || c.instanceId || '';
            if (c.unread) return tr('arr_history_coverage_unread', { instance });
            if (!c.held) return tr('arr_history_coverage_empty', { instance });
            if (c.complete) return tr('arr_history_coverage_all', { instance, n: count(c.held) });
            const date = c.since ? JE.arrStatus.formatDate(c.since) : '';
            if (typeof c.total === 'number') return tr('arr_history_coverage', { instance, n: count(c.held), total: count(c.total), date });
            return tr('arr_history_coverage_held', { instance, n: count(c.held), date });
        });
    }

    /**
     * A count as this browser writes numbers ("5,312").
     * @param {number} n Count.
     * @returns {string} Text.
     */
    function count(n) {
        return typeof n === 'number' && isFinite(n) ? n.toLocaleString() : String(n ?? '');
    }

    /**
     * The history rows: when, event, title (with the release and the arr's message under it),
     * instance, quality.
     * @param {Object[]} rows History rows.
     * @returns {HTMLTableElement} Table.
     */
    function historyTable(rows) {
        const table = el('table', 'je-ops-table');
        const head = el('thead');
        const hr = el('tr');
        for (const key of ['arr_ops_col_when', 'arr_ops_col_event', 'arr_ops_col_title', 'arr_ops_col_instance', 'arr_ops_col_quality']) hr.appendChild(el('th', '', tr(key)));
        head.appendChild(hr);
        table.appendChild(head);
        const tbody = el('tbody');
        const pad = n => String(n).padStart(2, '0');
        for (const h of rows) {
            const tr2 = el('tr');
            const scope = h.season != null && h.episode != null ? ` S${pad(h.season)}E${pad(h.episode)}` : '';
            tr2.appendChild(el('td', '', when(h.date)));
            tr2.appendChild(el('td', '', EVENT_KEYS[h.event] ? tr(EVENT_KEYS[h.event]) : h.event));
            const title = el('td', 'je-ops-wrap');
            title.appendChild(document.createTextNode((h.title || '') + scope));
            if (h.release) title.appendChild(el('div', 'je-ops-item-sub je-ops-path', h.release));
            if (h.message) title.appendChild(el('div', 'je-ops-msg', h.message));
            tr2.appendChild(title);
            tr2.appendChild(el('td', '', h.instance));
            tr2.appendChild(el('td', '', h.quality || ''));
            tbody.appendChild(tr2);
        }
        table.appendChild(tbody);
        return table;
    }

    /**
     * A small table. Words in cells are kept whole (short columns such as a type or a check name
     * never break mid-word); only the columns in <code>wrap</code> (paths, messages) may break
     * anywhere so a long path can't widen the table.
     * @param {string[]} headings en.json keys of the column headings.
     * @param {Array<Array<string|Node>>} rows Cells.
     * @param {number[]} [wrap] Indexes of the columns that may break anywhere.
     * @param {boolean} [labelled] Name each cell's column on phone cards (where the header row is hidden).
     * @returns {HTMLTableElement} Table.
     */
    function table(headings, rows, wrap, labelled) {
        const t = el('table', labelled ? 'je-ops-table je-ops-table-labelled' : 'je-ops-table');
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
                // Phone cards hide the header row: each cell names its column (admin-styles.js).
                if (labelled) td.dataset.label = tr(headings[i]);
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
     * A path doctor root's problem cell: what is wrong with the folder, and whether users who
     * aren't administrators lose its upcoming titles on the Calendar (no library can be told).
     * @param {{problem?: string, hiddenFromMembers?: boolean}} r The root.
     * @returns {string}
     */
    function rootProblem(r) {
        const parts = [];
        if (r.problem) parts.push(tr(`arr_ops_doctor_root_${r.problem}`));
        if (r.hiddenFromMembers) parts.push(tr('arr_ops_doctor_root_hidden'));
        return parts.length ? parts.join(' · ') : tr('arr_ops_doctor_fine');
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

        // Jellyfin Enhanced handles requests: its own readiness instead of Seerr's.
        if (data.requestsBackend?.mode === 'je') panel.appendChild(renderRequestsBackend(data.requestsBackend));
        const seerrShown = seerrDescribed(data);
        if (seerrShown) panel.appendChild(renderSeerr(data));
        panel.appendChild(renderBridge(data.bridge || {}, data.settings || {}, ctx, seerrShown));
    }

    /**
     * True when the System tab describes Seerr: it holds Seerr's requests, Seerr is in use, or Seerr is the selected
     * request handling (its absence matters then). A Jellyfin Enhanced or status-only server with Seerr off shows none
     * of Seerr's warnings or thresholds.
     * @param {Object} data System.
     * @returns {boolean} Whether Seerr is described.
     */
    function seerrDescribed(data) {
        const backend = data.requestsBackend;
        return !!data.seerr || !backend || backend.mode === 'seerr' || backend.seerrInUse === true;
    }

    /**
     * The System tab's Seerr box: its request list, or that Seerr isn't set up.
     * @param {Object} data System.
     * @returns {HTMLElement} Section.
     */
    function renderSeerr(data) {
        const seerr = el('section', 'je-ops-box je-ops-section');
        seerr.appendChild(el('h2', 'je-ops-box-title', tr('arr_ops_seerr_title')));
        if (!data.seerr) seerr.appendChild(el('div', 'je-ops-empty', tr('arr_hub_not_configured_admin')));
        else {
            seerr.appendChild(el('div', 'je-ops-line', tr(data.seerrRequests === 1 ? 'arr_ops_seerr_line_one' : 'arr_ops_seerr_line', { n: data.seerrRequests || 0, last: data.seerr.lastReadAt ? when(data.seerr.lastReadAt) : '—' })));
            if (data.seerr.lastError) seerr.appendChild(el('div', 'je-ops-msg', tr('arr_hub_admin_seerr_error', { error: data.seerr.lastError })));
            // More requests than are read: the newest are read, older ones keep what was last known.
            if (data.seerr.truncated) seerr.appendChild(el('div', 'je-ops-item-sub', tr('arr_ops_seerr_truncated', { total: data.seerr.reportedTotal || 0, n: data.seerr.readLimit || 0 })));
            // The latest full read changed under the pages and wasn't used (not yet an error); shown
            // whether or not the last complete read was truncated.
            if (data.seerr.incompleteReason && !data.seerr.lastError) seerr.appendChild(el('div', 'je-ops-item-sub', tr('arr_ops_seerr_incomplete', { reason: data.seerr.incompleteReason })));
        }
        return seerr;
    }

    /**
     * The System tab's request-handling box when Jellyfin Enhanced handles requests: whether requests can be made, where
     * they go and whether titles that aren't in the library can be looked up (TMDB). No Seerr wording.
     * @param {Object} backend The system's requestsBackend ({mode, requestsOn, seerrInUse, tmdbKey, instances}).
     * @returns {HTMLElement} Section.
     */
    function renderRequestsBackend(backend) {
        const box = el('section', 'je-ops-box je-ops-section je-ops-requests-backend');
        box.appendChild(el('h2', 'je-ops-box-title', tr('arr_ops_backend_title')));
        box.appendChild(el('div', 'je-ops-line', tr('arr_ops_backend_je')));
        box.appendChild(el('div', backend.requestsOn ? 'je-ops-ok' : 'je-ops-warn', tr(backend.requestsOn ? 'arr_ops_backend_requests_on' : 'arr_ops_backend_requests_off')));
        const n = backend.instances || 0;
        box.appendChild(el('div', n ? 'je-ops-ok' : 'je-ops-warn', n ? tr(n === 1 ? 'arr_ops_backend_instances_one' : 'arr_ops_backend_instances', { n }) : tr('arr_ops_backend_instances_none')));
        box.appendChild(el('div', backend.tmdbKey ? 'je-ops-ok' : 'je-ops-warn', tr(backend.tmdbKey ? 'arr_ops_backend_tmdb_on' : 'arr_ops_backend_tmdb_off')));
        return box;
    }

    /**
     * The Jellyfin bridge section (System tab).
     * @param {Object} bridge Bridge state.
     * @param {Object} settings Thresholds.
     * @param {Object} ctx Callbacks and helpers.
     * @param {boolean} [seerrShown=true] False leaves Seerr's threshold out (Seerr isn't in use).
     * @returns {HTMLElement} Section.
     */
    function renderBridge(bridge, settings, ctx, seerrShown = true) {
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
            missing.appendChild(el('div', 'je-ops-item-sub', tr(total === 1 ? 'arr_ops_missing_titles_one' : 'arr_ops_missing_titles', { n: total })));
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
                    d.roots.map(r => [r.arrPath, r.jellyfinPath + (r.mapped ? '' : ` (${tr('arr_ops_doctor_same_path')})`), r.library || '—', rootProblem(r)]), [0, 1]));
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
        if (settings.libraryPendingMinutes) box.appendChild(el('div', 'je-ops-item-sub', tr(seerrShown ? 'arr_ops_settings_line' : 'arr_ops_settings_line_no_seerr', { pending: settings.libraryPendingMinutes, disk: settings.lowDiskPercent, grace: settings.seerrHandoffGraceMinutes })));
        return box;
    }

    /**
     * Audit tab: one row per audited action, in plain words. Who and Title name people, titles and
     * instances through the server's display names (names: users, titles, instances), with an honest
     * fallback for an account or title nobody can name any more; the stored facts (action id, target,
     * ids, revisions, profiles, folders, the original message) stay one tap away under Technical details.
     * @param {HTMLElement} panel Target.
     * @param {Object} data Audit ({entries, names}).
     * @returns {void}
     */
    function renderAudit(panel, data) {
        const box = el('section', 'je-ops-box je-ops-section');
        box.appendChild(el('h2', 'je-ops-box-title', tr('arr_ops_audit_title')));
        const entries = data.entries || [];
        const names = data.names || {};
        if (!entries.length) {
            box.appendChild(el('div', 'je-ops-empty', tr('arr_ops_audit_empty')));
        } else {
            box.appendChild(table(['arr_ops_col_when', 'arr_ops_col_who', 'arr_ops_col_action', 'arr_ops_col_title', 'arr_ops_col_result'],
                entries.map(e => [when(e.time), auditActor(e, names), actionLabel(e.action), auditSubject(e, names), auditResult(e)]), [3, 4], true));
        }
        panel.appendChild(box);
    }

    /**
     * Who acted: the name stored with the row, else the account's Jellyfin name, else what is known.
     * @param {Object} e Audit entry.
     * @param {Object} names Display names from the server.
     * @returns {string} Text.
     */
    function auditActor(e, names) {
        if (e.userName) return e.userName;
        const id = String(e.userId || '');
        if (id === 'system') return tr('arr_ops_audit_actor_system');
        const name = names.users?.[id];
        if (name) return name;
        return tr(/^[0-9a-f]{32}$/i.test(id) ? 'arr_ops_audit_actor_removed' : 'arr_ops_audit_actor_unknown');
    }

    /**
     * The title key an audit row acts on, as the server keys its title names: a search's details.key,
     * a "key:" target, else the target itself.
     * @param {Object} e Audit entry.
     * @returns {string} Key ('' when none).
     */
    function auditTitleKey(e) {
        const target = String(e.target || '');
        return e.details?.key || (target.startsWith('key:') ? target.slice(4) : target);
    }

    /**
     * The Title cell: the title's name (and year) and the instance, else the account a user-settings
     * change was for, else the stored target as it is.
     * @param {Object} e Audit entry.
     * @param {Object} names Display names from the server.
     * @returns {string} Text.
     */
    function auditSubject(e, names) {
        const instance = names.instances?.[e.instanceId] || e.details?.instance || e.details?.instanceName || '';
        let subject = e.details?.title || '';
        if (!subject) {
            const known = names.titles?.[auditTitleKey(e)];
            if (known?.title) subject = known.title + (known.year ? ` (${known.year})` : '');
        }
        if (!subject && String(e.action || '').startsWith('users.')) {
            subject = tr('arr_ops_audit_settings_of', { user: names.users?.[e.target] || tr('arr_ops_audit_actor_removed') });
        }
        if (!subject) subject = e.details?.key || e.target || '';
        return [subject, instance].filter(Boolean).join(' · ');
    }

    /**
     * Reads the "Name: value; …" facts of a choice row's stored message.
     * @param {string} message Message.
     * @returns {Object<string, string>} Facts by name.
     */
    function messageFacts(message) {
        const facts = {};
        for (const part of String(message || '').replace(/\.$/, '').split('; ')) {
            const at = part.indexOf(': ');
            if (at > 0) facts[part.slice(0, at)] = part.slice(at + 2);
        }
        return facts;
    }

    /**
     * The Result cell: the outcome in plain words and a short summary, then the stored facts under
     * Technical details.
     * @param {Object} e Audit entry.
     * @returns {HTMLElement} Cell content.
     */
    function auditResult(e) {
        const result = el('span');
        const cls = e.outcome === 'succeeded' ? 'je-ops-ok' : e.outcome === 'failed' ? 'je-ops-bad' : 'je-ops-warn';
        result.appendChild(el('span', cls, OUTCOME_KEYS[e.outcome] ? tr(OUTCOME_KEYS[e.outcome]) : String(e.outcome || '')));
        const action = String(e.action || '');
        let summary;
        if (action.startsWith('request.choice.')) {
            const f = messageFacts(e.message);
            summary = tr('arr_ops_audit_choice_summary', { revision: f.Revision || '?', profile: f.Profile || '?', root: f.Root || '?' });
        } else if (action === 'request.dispatch') {
            // The send's own words; the instance, profile and folder it used are under Technical details.
            const text = String(e.message || '');
            const at = text.indexOf(' Instance: ');
            summary = at > 0 ? text.slice(0, at) : text;
        } else {
            summary = [e.readBack, e.message].filter(Boolean).join(' · ');
        }
        if (summary) result.appendChild(document.createTextNode(` · ${summary}`));
        const facts = [['arr_ops_diag_action', action], ['arr_ops_diag_outcome', e.outcome], ['arr_ops_diag_target', e.target],
            ['arr_ops_diag_user', e.userId], ['arr_ops_diag_instance', e.instanceId], ['arr_ops_diag_error', e.error],
            ['arr_ops_diag_message', e.message], ['arr_ops_diag_read_back', e.readBack], ['arr_ops_diag_duration', e.durationMs ? `${e.durationMs} ms` : '']];
        for (const [name, value] of Object.entries(e.details || {})) facts.push([name, value]);
        const diag = diagnostics(facts, 'je-ops-audit-diag', `audit:${e.id}`);
        if (diag) result.appendChild(diag);
        return result;
    }

    /**
     * A readable name for an audited action.
     * @param {string} action Action id ("queue.remove").
     * @returns {string} Text.
     */
    function actionLabel(action) {
        const key = ACTION_KEYS[action];
        if (key) return tr(key);
        if (String(action || '').startsWith('users.')) return tr('arr_ops_audit_user_settings');
        return String(action || '');
    }

    A.renderOverview = renderOverview;
    A.renderActivity = renderActivity;
    A.renderSystem = renderSystem;
    A.renderAudit = renderAudit;
    A.itemTitle = itemTitle;
    A.size = size;
    A.downloadKey = downloadKey;
    A.when = when;
})(window.JellyfinEnhanced);
