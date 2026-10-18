/** Shared page, modal and card hosts. Observers reconcile owned controls once per DOM batch. */
(function (JE) {
    'use strict';
    const A = JE.titleActions;
    const cards = new WeakMap();
    const rows = new Map();
    const hosts = new Map();
    let started = false;
    let queued = false;
    let observer;
    let frame;
    let disposed = false;
    let touch = null;
    let consumed = null;
    let receiving = null;
    const CARD = '.card[data-id], .jellyseerr-card, .je-discover-card, [data-je-hide-title]';
    const rowSelector = '.mainDetailButtons, .detailButtons';

    /** Existing administrator switches own the corresponding action surfaces; all-off is inert. */
    function enabled() {
        return JE.pluginConfig?.NativeAbsentDetails?.Enabled === true || JE.pluginConfig?.NativeAbsentDetailsEnabled === true || JE.pluginConfig?.ArrRequestsJeMode === true;
    }

    /** Reads explicit metadata carried by every supported card family; never looks up individual cards. */
    function cardContext(card) {
        if (!card || card.classList.contains('jellyseerr-card-in-library')) return null;
        const id = card.dataset.id;
        const parts = id && JE.titleDetails?.parse?.(id);
        if (parts) return A.context({ itemId: id, name: card.querySelector('.cardText, .cardText-first')?.textContent || '' });
        if (id && !parts) return null; // Real library cards retain native behaviour.
        const key = card.dataset.jeHideTitle || card.dataset.key;
        if (key) { const c = A.fromKey(key); if (c) return A.context({ ...c.data, name: card.dataset.jeHideName || card.querySelector('.je-discover-name bdi')?.textContent || '' }); }
        const meta = card.matches('[data-tmdb-id]') ? card : card.querySelector('[data-tmdb-id][data-media-type]');
        return meta ? A.context({ mediaType: meta.dataset.mediaType, tmdbId: meta.dataset.tmdbId, name: meta.title || meta.textContent }) : null;
    }

    /** Builds a visible keyboard/touch button. */
    function button(id, label, glyph) {
        const node = document.createElement('button'); node.type = 'button'; node.dataset.action = id;
        node.setAttribute('aria-label', label); node.title = label; node.append(A.icon(glyph)); return node;
    }

    /** Opens a current card's capability menu and rejects recycled nodes or outgoing sessions. */
    async function openCard(card, opener) {
        const c = cardContext(card); if (!c || !enabled()) return;
        const action = JE.createSessionAction();
        const route = location.href;
        try {
            if (!await A.admit(c, action)) return;
            const entries = await A.entries(c, { action, surface: 'recommendations' });
            if (action.current() && location.href === route && card.isConnected && cardContext(card)?.key === c.key) A.show(c, entries, opener || card.querySelector('.je-card-more'));
        } catch (_) { if (action.current()) JE.toast?.(JE.t('title_actions_failed')); }
    }

    /** Reconciles a retained/recycled card without retaining detached nodes. */
    function mountCard(card) {
        const c = enabled() && cardContext(card);
        const prior = cards.get(card);
        if (!c) { card.classList.remove('je-actions-card'); card.querySelectorAll('.je-card-more').forEach(n => n.remove()); cards.delete(card); return; }
        if (prior?.key === c.key && prior.button.isConnected && prior.button.parentNode === card) return;
        card.querySelectorAll('.je-card-more').forEach(n => n.remove());
        A.styles(); card.classList.add('je-actions-card');
        const node = button('more', JE.t('title_actions_more'), 'more_horiz'); node.className = 'je-card-more'; node.dataset.jeActionKey = c.key;
        node.onclick = e => { e.preventDefault(); e.stopPropagation(); openCard(card, node); };
        card.append(node); cards.set(card, { key: c.key, button: node });
    }

    /** The source row's current controls, without copies of our proxies. */
    function originals(row) {
        return [...row.querySelectorAll('button, a.detailButton')].filter(n => !n.closest('.je-actions-row') && !n.classList.contains('je-actions-wide-more') &&
            !n.classList.contains('hide') && !n.hidden && n.getAttribute('aria-hidden') !== 'true' && n.style.display !== 'none');
    }

    /** Known native/JE controls retain their exact original handler; only real items get native file actions. */
    function classify(node, c) {
        if (node.dataset.jeActionKind) return ['request', 'open'].includes(node.dataset.jeActionKind) ? 'primary' : node.dataset.jeActionKind;
        const match = selector => node.matches(selector);
        if (c?.absent && match('.btnPlay, .btnResume, [data-action="play"], .btnDownload, .btnDelete, .btnMediaInfo')) return null;
        if (match('.btnPlay, .btnResume, [data-action="play"], .je-native-absent-open, .je-ask-mount-request, .jellyseerr-request-button, .je-native-absent-legacy-request')) return 'primary';
        if (match('.btnUserRating, .btnFavorite')) return c?.absent ? null : 'favorite';
        if (match('.je-notify-follow')) return 'follow';
        if (match('.je-manage-open, .je-arr-modal-manage')) return 'manage';
        if (match('.jellyseerr-report-issue-icon, .jellyseerr-report-unavailable-icon')) return 'report';
        if (match('.je-detail-hide-btn, .je-hide-btn')) return 'hide';
        if (match('.je-spoiler-pending-detail, .je-spoiler-pending-btn, .je-spoiler-blur-btn')) return 'guard';
        if (match('.btnPlayTrailer, .btnTrailer')) return 'trailer';
        if (match('.btnPlayed, .btnPlayedIndicator, .btnPlaystate')) return c?.absent ? null : 'played';
        if (match('.btnMoreCommands, .btnMore')) return c?.absent ? null : 'native-more';
        return c?.absent ? null : 'native-' + (node.className || 'other').replace(/\s/g, '-');
    }

    /** Projects row source controls into the same groups as card/provider capabilities. */
    function nativeEntries(state) {
        return originals(state.row).map(source => {
            const id = classify(source, state.c); if (!id || ['primary', 'favorite', 'follow'].includes(id)) return null;
            return { id, source, disabled: source.disabled, reason: source.dataset.jeActionReason, group: ['trailer', 'played'].includes(id) ? 'watch' : ['guard', 'hide'].includes(id) ? 'view' : ['report', 'manage'].includes(id) ? 'requests' : 'other',
                label: ['guard', 'follow', 'manage', 'native-more'].includes(id) ? JE.t({ guard: 'title_actions_guard', follow: 'title_actions_follow', manage: 'title_actions_manage', 'native-more': 'title_actions_native_more' }[id]) : source.getAttribute('aria-label') || source.title || source.textContent.trim() || JE.t('title_actions_native_more'),
                fixedLabel: ['guard', 'follow', 'manage', 'native-more', 'report'].includes(id), state: id === 'manage' ? JE.t('title_actions_admin') : undefined,
                icon: { trailer: 'movie', played: 'done', guard: 'blur_on', hide: 'visibility', report: 'warning', manage: 'tune', 'native-more': 'more_vert' }[id] || source.querySelector('.material-icons')?.textContent || 'more_horiz' };
        }).filter(Boolean);
    }

    /** A retained row can act only for its current host identity and opening session. */
    function rowCurrent(state) {
        if (disposed || !state.action.current() || !state.root.isConnected || state.root._isClosing || state.root.classList.contains('hide')) return false;
        if (state.root.matches('.je-more-info-modal')) return String(state.root.dataset.tmdbId) === String(state.c?.tmdbId);
        const expected = state.c?.data?.itemId || state.c?.data?.Id;
        const shown = new URLSearchParams(location.hash.split('?')[1] || '').get('id');
        return !expected || !shown || String(expected).replace(/-/g, '') === String(shown).replace(/-/g, '');
    }

    /** Opens the same sheet for native library and provider pages, merging by action identity. */
    async function openRow(state, opener) {
        if (!rowCurrent(state)) return;
        const action = JE.createSessionAction();
        try {
            if (state.root.matches('.je-more-info-modal')) {
                try { await JE.internals?.moreInfoModal?.reconcilePaused?.(state.row); } catch (_) { /* the request sheet rechecks on submission */ }
                if (!action.current() || !rowCurrent(state)) return;
            }
            if (state.c) {
                let admitted = false;
                try { admitted = await A.admit(state.c, action); } catch (_) { /* native controls still work */ }
                if (state.c.absent && !admitted) return;
            }
            const adapted = state.c ? await A.entries(state.c, { action, root: state.root, surface: 'details' }) : [];
            if (!action.current() || !rowCurrent(state) || rows.get(state.row) !== state || !state.row.isConnected) return;
            const entries = nativeEntries(state);
            const present = new Set(entries.map(e => e.id));
            for (const entry of adapted) if (!present.has(entry.id)) { present.add(entry.id); entries.push(entry); }
            const title = state.c?.name || state.root.querySelector('.nameContainer .itemName:not(.originalTitle)')?.textContent || '';
            A.show({ ...state.c, name: title }, entries, opener);
        } catch (_) { if (action.current()) JE.toast?.(JE.t('title_actions_failed')); }
    }

    /** Reads a control's label without treating icon-font ligatures as spoken text. */
    function controlLabel(source) {
        if (source.getAttribute('aria-label') || source.title) return source.getAttribute('aria-label') || source.title;
        const text = node => node.nodeType === 3 ? node.textContent : node.nodeType === 1 && !node.matches('.material-icons, .je-msym-rounded, .je-msym-outlined, svg, [aria-hidden="true"]')
            ? [...node.childNodes].map(text).join('') : '';
        return [...source.childNodes].map(text).join('').trim();
    }

    /** Updates compact proxies only when their source state actually changes (observer-safe). */
    function syncProxy(proxy, source) {
        const label = controlLabel(source);
        if (proxy.title !== label) { proxy.title = label; proxy.setAttribute('aria-label', label); }
        proxy.disabled = source.disabled || source.getAttribute('aria-disabled') === 'true';
        const originalIcon = source.querySelector('.detailButton-icon');
        const proxyIcon = proxy.querySelector('.material-icons');
        if (originalIcon && proxyIcon) {
            const signature = originalIcon.className + '|' + originalIcon.textContent;
            if (proxyIcon.dataset.jeNativeIcon !== signature) { proxyIcon.className = originalIcon.className; proxyIcon.textContent = originalIcon.textContent; proxyIcon.dataset.jeNativeIcon = signature; }
        }
        const pressed = source.getAttribute('aria-pressed');
        if (pressed != null && proxy.getAttribute('aria-pressed') !== pressed) proxy.setAttribute('aria-pressed', pressed);
        const count = source.querySelector('.jellyseerr-issue-count-badge');
        const value = parseInt(count?.textContent || '0', 10);
        let badge = proxy.querySelector('.je-actions-badge');
        if (value > 0) { if (!badge) { badge = document.createElement('span'); badge.className = 'je-actions-badge'; proxy.append(badge); } if (badge.textContent !== count.textContent) badge.textContent = count.textContent; }
        else badge?.remove();
    }

    /** Reconciles a row. Native controls stay connected for their owners, hidden only in compact layout. */
    function paintRow(state) {
        const row = state.row;
        if (!row.isConnected) { rows.delete(row); return; }
        if (state.more) {
            row.querySelectorAll('.je-actions-wide-more').forEach(n => { if (n !== state.more) n.remove(); });
            if (state.more.parentElement !== row) row.append(state.more);
        }
        let sources = originals(row);
        // Native owners arriving late supersede our adapted fallback, without duplicate actions.
        const nativeKinds = new Set(sources.filter(n => !n.dataset.jeActionKind).map(n => classify(n, state.c)));
        for (const node of sources) if (node.dataset.jeActionKind && nativeKinds.has(classify(node, state.c))) node.remove();
        sources = originals(row);
        for (const node of sources.filter(n => n.dataset.jeActionKind === 'follow')) {
            const following = JE.arrNotify?.isFollowing?.(state.c?.key) === true;
            if (node.getAttribute('aria-pressed') !== String(following)) node.setAttribute('aria-pressed', String(following));
        }
        const visible = sources.filter(n => classify(n, state.c));
        // The row's own width changes when compact. Measure its parent's unadapted content box only
        // when the layout size changes, so our own classes cannot become another breakpoint input.
        const parent = state.rowHome?.parent || row.parentElement;
        const size = window.innerWidth + '|' + (parent?.getBoundingClientRect().width || row.getBoundingClientRect().width || 0);
        if (state.layoutSize !== size) {
            state.layoutSize = size;
            const wasCompact = row.classList.contains('je-actions-compact');
            const wasRibbon = parent?.classList.contains('je-actions-ribbon');
            const wasPhone = state.root.classList.contains('je-actions-phone-page');
            if (wasCompact) row.classList.remove('je-actions-compact');
            if (wasRibbon) parent.classList.remove('je-actions-ribbon');
            if (wasPhone) state.root.classList.remove('je-actions-phone-page');
            const style = parent && getComputedStyle(parent);
            const width = parent?.getBoundingClientRect().width || row.getBoundingClientRect().width || window.innerWidth - 32;
            state.available = width - (parseFloat(style?.paddingLeft) || 0) - (parseFloat(style?.paddingRight) || 0);
            state.widths = new WeakMap();
            for (const node of sources) state.widths.set(node, Math.max(48, node.getBoundingClientRect().width || 52));
            if (wasCompact) row.classList.add('je-actions-compact');
            if (wasRibbon) parent.classList.add('je-actions-ribbon');
            if (wasPhone) state.root.classList.add('je-actions-phone-page');
        }
        for (const node of sources) if (!state.widths.has(node)) state.widths.set(node, Math.max(48, node.getBoundingClientRect().width || 52));
        const needed = visible.reduce((sum, n) => sum + state.widths.get(n) + 10, 52) +
            [...state.externalSources].filter(n => !sources.some(proxy => proxy.jeActionOwner === n))
                .reduce((sum, n) => sum + Math.max(48, n.getBoundingClientRect().width || 52) + 10, 0);
        const compact = needed > Math.min(state.available, Math.max(0, window.innerWidth - 32));
        row.classList.toggle('je-actions-compact', compact);
        state.externalSources.forEach(node => node.classList.toggle('je-actions-external-original', compact));
        if (state.rowHome) {
            const header = state.rowHome.parent.parentElement;
            const phone = compact && window.innerWidth <= 600;
            header.classList.toggle('je-actions-modal-header', phone);
            const destination = phone ? header : state.rowHome.parent;
            if (row.parentElement !== destination) {
                const focus = row.contains(document.activeElement) ? document.activeElement : null;
                const next = !phone && state.rowHome.next?.parentElement === destination ? state.rowHome.next : null;
                destination.insertBefore(row, next);
                focus?.focus();
            }
        }
        if (row.parentElement?.matches('.detailRibbon')) {
            const phone = compact && window.innerWidth <= 600;
            row.parentElement.classList.toggle('je-actions-ribbon', phone);
            state.root.classList.toggle('je-actions-phone-page', phone);
        }
        sources.forEach(n => { if (!n.classList.contains('je-actions-original')) n.classList.add('je-actions-original'); });
        let compactRow = row.querySelector(':scope > .je-actions-row');
        if (!compact) { compactRow?.remove(); return; }
        if (!compactRow) { compactRow = document.createElement('div'); compactRow.className = 'je-actions-row'; row.append(compactRow); }
        const primary = visible.find(n => classify(n, state.c) === 'primary');
        const favorite = visible.find(n => classify(n, state.c) === (state.c?.absent ? 'follow' : 'favorite'));
        const report = visible.find(n => classify(n, state.c) === 'report' && !n.disabled && n.getAttribute('aria-disabled') !== 'true');
        const primaryIcon = primary?.dataset.jeActionKind === 'open' || primary?.matches('.je-native-absent-open') ? 'open_in_new' : state.c?.absent ? 'add' : 'play_arrow';
        const selected = [['primary', primary, primaryIcon], [state.c?.absent ? 'follow' : 'favorite', favorite, state.c?.absent ? 'notifications_none' : 'favorite_border'], ['report', report, 'warning']];
        for (const [id, source, glyph] of selected) {
            let proxy = compactRow.querySelector('[data-action="' + id + '"]');
            if (!source) { proxy?.remove(); continue; }
            if (!proxy || proxy.jeActionSource !== source) {
                proxy?.remove(); proxy = button(id, source.title || '', glyph); proxy.className = 'je-actions-' + id; proxy.jeActionSource = source;
                const action = state.action;
                proxy.onclick = e => { e.preventDefault(); e.stopPropagation(); if (rowCurrent(state) && state.row.isConnected && state.row.contains(source) && !source.disabled && source.getAttribute('aria-disabled') !== 'true') source.click(); };
                if (id === 'primary') { const label = document.createElement('span'); label.className = 'je-actions-primary-label'; proxy.append(label); }
                compactRow.append(proxy);
            }
            syncProxy(proxy, source);
            if (id === 'primary') {
                const label = proxy.querySelector('.je-actions-primary-label'); const text = controlLabel(source);
                if (label.textContent !== text) label.textContent = text;
            }
        }
        let more = compactRow.querySelector('.je-actions-more');
        if (!more) { more = button('more', JE.t('title_actions_more'), 'more_horiz'); more.className = 'je-actions-more'; more.onclick = () => openRow(state, more); compactRow.append(more); }
        // Insert only misplaced controls: moving an already focused node makes browsers drop focus.
        const desired = ['primary', state.c?.absent ? 'follow' : 'favorite', 'report', 'more']
            .map(id => compactRow.querySelector('[data-action="' + id + '"]')).filter(Boolean);
        desired.forEach((node, index) => { if (compactRow.children[index] !== node) compactRow.insertBefore(node, compactRow.children[index] || null); });

    }

    /** Mounts one session/identity-owned row; copied DOM is reconstructed with live listeners. */
    function mountRow(row, root, c) {
        if (!enabled()) return;
        hosts.set(root, { c, action: JE.createSessionAction() });
        let state = rows.get(row);
        if (state && state.c?.key === c?.key && state.action.current()) { paintRow(state); return; }
        if (state) disposeRow(state);
        row.querySelectorAll('.je-actions-row, .je-actions-wide-more').forEach(n => n.remove());
        A.styles(); state = { row, root, c, action: JE.createSessionAction(), widths: new WeakMap(), externalSources: new Set() }; rows.set(row, state);
        if (root.matches('.je-more-info-modal') && row.parentElement?.matches('.header-info') && row.parentElement.parentElement?.matches('.header-section'))
            state.rowHome = { parent: row.parentElement, next: row.nextSibling };
        const more = button('more', JE.t('title_actions_more'), 'more_horiz'); more.className = 'button-flat detailButton emby-button je-actions-wide-more';
        more.onclick = () => openRow(state, more); state.more = more; row.append(more);
        paintRow(state);
        if (c) {
            const action = state.action;
            (async () => {
                let admitted = false; try { admitted = await A.admit(c, action); } catch (_) { /* native source controls remain available */ }
                if (c.absent && !admitted) return [];
                return A.entries(c, { action, root, surface: 'details' });
            })().then(entries => {
                if (!action.current() || rows.get(row) !== state || !row.isConnected) return;
                for (const entry of entries) {
                    if (entry.source && !row.contains(entry.source) && ['guard', 'hide', 'follow', 'manage'].includes(entry.id)) {
                        state.externalSources.add(entry.source);
                        if (entry.id !== 'follow') continue;
                    }
                    if (!['request', 'open', 'follow', 'report', 'guard', 'hide'].includes(entry.id)) continue;
                    const kind = ['request', 'open'].includes(entry.id) ? 'primary' : entry.id;
                    if (originals(row).some(n => classify(n, c) === kind)) continue;
                    const node = entry.control || button(entry.id, entry.label, entry.icon);
                    if (entry.source) node.jeActionOwner = entry.source;
                    node.dataset.jeActionKind = entry.id;
                    node.classList.add('button-flat', 'detailButton', 'emby-button', 'je-actions-adapted');
                    if (!entry.control) {
                        node.disabled = entry.disabled === true; node.title = entry.reason || entry.label;
                        if (entry.reason) node.dataset.jeActionReason = entry.reason;
                        node.onclick = () => rowCurrent(state) && A.invoke(c, entry, node, action).catch(() => { if (action.current()) JE.toast?.(JE.t('title_actions_failed')); });
                    }
                    row.append(node);
                    if (entry.id === 'report' && entry.control) JE.jellyseerrIssueReporter?.applyIssueIndicator?.(node, c.tmdbId, c.type);
                }
                paintRow(state);
            }).catch(() => {});
        }
    }

    /** Removes only this row's owned UI and restores original controls. */
    function disposeRow(state) {
        state.row.classList.remove('je-actions-compact');
        state.row.parentElement?.classList.remove('je-actions-ribbon');
        state.root.classList.remove('je-actions-phone-page');
        state.externalSources.forEach(node => node.classList.remove('je-actions-external-original'));
        if (state.rowHome) {
            const { parent, next } = state.rowHome;
            parent.parentElement?.classList.remove('je-actions-modal-header');
            if (state.row.parentElement !== parent) parent.insertBefore(state.row, next?.parentNode === parent ? next : null);
        }
        state.row.querySelectorAll('.je-actions-original').forEach(n => n.classList.remove('je-actions-original'));
        state.row.querySelectorAll('.je-actions-row, .je-actions-wide-more').forEach(n => n.remove()); rows.delete(state.row);
    }

    /** Bounded DOM reconciliation, triggered by host navigation and external mutations. */
    function scan() {
        queued = false;
        if (disposed) return;
        if (!enabled()) { rows.forEach(disposeRow); document.querySelectorAll('.je-card-more').forEach(n => n.remove()); document.querySelectorAll('.je-actions-card').forEach(n => n.classList.remove('je-actions-card')); return; }
        document.querySelectorAll(CARD).forEach(mountCard);
        for (const [root, host] of hosts) {
            if (!rowCurrent({ ...host, root })) { hosts.delete(root); continue; }
            const row = root.matches(rowSelector) ? root : root.querySelector(rowSelector + ', [data-mount="je-actions"]');
            if (row) mountRow(row, root, host.c);
        }
        const native = JE.internals?.nativeDetails?.current?.();
        if (native?.page) { const row = native.page.querySelector(rowSelector); if (row) mountRow(row, native.page, A.context({ ...native.item, itemId: native.id })); }
        rows.forEach(state => {
            if (!rowCurrent(state) || !state.row.isConnected) { disposeRow(state); return; }
            if (state.root.matches('.je-more-info-modal')) JE.internals?.moreInfoModal?.reconcilePaused?.(state.row)?.catch(() => {});
            paintRow(state);
        });
    }

    /** Coalesces unrelated changes; mutations inside our own controls never queue another pass. */
    function schedule(records) {
        if (records && !records.some(r => !r.target.closest?.('.je-actions-row, .je-actions-backdrop, .je-card-more') &&
            (r.type !== 'childList' || r.target.closest?.('.je-actions-original') || [...r.addedNodes, ...r.removedNodes].some(n => n.nodeType === 1 && !n.matches?.('.je-actions-row, .je-actions-wide-more, .je-card-more'))))) return;
        if (queued || disposed) return; queued = true; frame = requestAnimationFrame(scan);
    }

    /** Stops a long press when scrolling, releasing or cancelling the pointer. */
    function cancelTouch() { if (touch) clearTimeout(touch.timer); touch = null; }

    /** Starts host hooks after the bundle has initialized its existing feature owners. */
    function initialize() {
        if (started) return; started = true;
        observer = new MutationObserver(schedule); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-id', 'data-tmdb-id', 'data-media-type', 'data-je-hide-title', 'disabled', 'aria-pressed', 'aria-label', 'title', 'class'] });
        document.addEventListener('contextmenu', e => {
            const card = e.target.closest?.(CARD); if (!enabled() || !cardContext(card)) return;
            e.preventDefault(); e.stopImmediatePropagation(); cancelTouch(); openCard(card);
        }, true);
        document.addEventListener('pointerdown', e => {
            if (e.pointerType === 'mouse' || !enabled()) return;
            const card = e.target.closest?.(CARD); if (!cardContext(card) || (e.target.closest('button') && !e.target.closest('.je-discover-poster-box'))) return;
            cancelTouch(); touch = { x: e.clientX, y: e.clientY, timer: setTimeout(() => { consumed = card; cancelTouch(); openCard(card); }, 550) };
        }, true);
        document.addEventListener('pointermove', e => { if (touch && Math.hypot(e.clientX - touch.x, e.clientY - touch.y) > 10) cancelTouch(); }, true);
        ['pointerup', 'pointercancel', 'scroll'].forEach(name => document.addEventListener(name, cancelTouch, true));
        document.addEventListener('click', e => {
            if (consumed && consumed.contains(e.target)) { e.preventDefault(); e.stopImmediatePropagation(); consumed = null; return; }
            consumed = null;
            const nativeMenu = e.target.closest?.('[data-action="menu"], .btnCardMenu, .cardMenuButton');
            const card = nativeMenu?.closest(CARD);
            if (enabled() && cardContext(card)) { e.preventDefault(); e.stopImmediatePropagation(); openCard(card, card.querySelector('.je-card-more')); }
        }, true);
        document.addEventListener('keydown', e => {
            const card = e.target.closest?.(CARD);
            if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && enabled() && cardContext(card)) { e.preventDefault(); e.stopImmediatePropagation(); openCard(card); }
        }, true);
        document.addEventListener('jellyseerr-more-info-opened', e => {
            if (!enabled()) return; const { modal, data, mediaType, scope } = e.detail || {}; if (!modal) return;
            const row = modal.querySelector('[data-mount="je-actions"], .jellyseerr-more-info-actions, .jellyseerr-modal-actions, .jellyseerr-action-buttons') || modal.querySelector('.jellyseerr-request-button')?.parentElement;
            if (row) mountRow(row, modal, A.context({ ...data, mediaType, season: scope?.season, episode: scope?.episode }));
        });
        JE.core?.navigation?.onViewPage?.(async (_view, element) => {
            A.close();
            schedule();
            if (!enabled()) return;
            const id = new URLSearchParams(location.hash.split('?')[1] || '').get('id');
            const page = element || document.querySelector('#itemDetailPage:not(.hide), .itemDetailPage:not(.hide)');
            if (!id || !page || JE.titleDetails?.parse?.(id)) return;
            const action = JE.createSessionAction();
            try {
                let item = await JE.helpers?.getItemCached?.(id, { userId: ApiClient.getCurrentUserId() });
                if (!action.current()) return;
                if (item && ['Season', 'Episode'].includes(item.Type) && item.SeriesId) {
                    const series = await JE.helpers?.getItemCached?.(item.SeriesId, { userId: ApiClient.getCurrentUserId() });
                    if (!action.current()) return;
                    item = { ...item, mediaType: 'tv', tmdbId: series?.ProviderIds?.Tmdb, season: item.Type === 'Season' ? item.IndexNumber : item.ParentIndexNumber, episode: item.Type === 'Episode' ? item.IndexNumber : undefined };
                }
                if (!action.current() || !page.isConnected || new URLSearchParams(location.hash.split('?')[1] || '').get('id') !== id) return;
                const row = page.querySelector(rowSelector); if (row) mountRow(row, page, A.context({ ...item, absent: false }));
            } catch (_) { /* native row remains usable */ }
        }, { immediate: true });
        document.addEventListener('je:user-data-loaded', () => schedule());
        window.addEventListener('popstate', () => A.close());
        window.addEventListener('resize', () => schedule());
        window.addEventListener('hashchange', () => { A.close(); schedule(); sharedLink(); });
        JE.session?.onUserChange?.('title-actions', () => { A.close(false); rows.forEach(disposeRow); hosts.clear(); cancelTouch(); receiving = null; schedule(); sharedLink(); });
        JE.arrNotify?.onChange?.(what => { if (what === 'follows') schedule(); });
        scan(); sharedLink();
    }

    /** Handles authenticated share navigation once per URL/session; no sender data is restored. */
    async function sharedLink() {
        const key = new URLSearchParams(location.hash.split('?')[1] || '').get('jeTitle');
        if (!key || !ApiClient.getCurrentUserId() || receiving === key) return;
        receiving = key;
        if (!await A.receive(key)) JE.toast?.(JE.t('title_actions_unavailable'));
    }
    /** Releases the global observer and queued paint when the owning document is disposed. */
    function dispose() {
        disposed = true; observer?.disconnect(); cancelAnimationFrame(frame); queued = false;
        cancelTouch(); A.close(false); rows.forEach(disposeRow); hosts.clear();
    }
    Object.assign(A, { enabled, scan, mountRow, cardContext, initialize, dispose });
    JE.initializeTitleActions = initialize;
})(window.JellyfinEnhanced);
