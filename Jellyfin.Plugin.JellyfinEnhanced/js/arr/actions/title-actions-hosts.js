/** Shared page, modal and card hosts. Observers reconcile owned controls once per DOM batch. */
(function (JE) {
    'use strict';
    const A = JE.titleActions;
    let cards = new WeakMap();
    // The cards drawn so far (D46S2-R13-1): released at the reconciliation that no longer finds them.
    let drawn = new Set();
    // The lifetime every card mount of the current pass shares (D46S2-R13-1): minted at most once per pass, and only when
    // the one before it has ended (another route, session or document; the action bar going off); released once no card
    // holds it. A card's own mount is a plain record of the card, never a registry entry of its own.
    let shared = null;
    // The cards of a long grid are reconciled a slice per frame (D46S2-R13-1), so no pass holds the main thread for long.
    const CARD_SLICE = 200;
    let cardPass = null;
    let cardFrame = 0;
    // Every identity source read by cardContext, including the real Discover renderer's title identity.
    // The observer and child-node checks share this list so they cannot omit a supported producer.
    const IDENTITY = ['data-id', 'data-tmdb-id', 'data-media-type', 'data-je-hide-title', 'data-key'];
    const identityNodes = IDENTITY.map(name => `[${name}]`).join(', ');
    const rows = new Map();
    const hosts = new Map();
    const homes = new WeakMap();
    let started = false;
    let queued = false;
    let observer;
    let frame;
    let disposed = false;
    let active = false;
    let touch = null;
    let consumed = null;
    let receiving = null;
    // Hosts shown when the document left (pagehide, freeze), reconciled fresh when it comes back.
    let parked = null;
    // Every node this adapter created. Anything else carrying our classes is a host copy (no handler).
    const ours = new WeakSet();
    const CARD = '.card[data-id], .jellyseerr-card, .je-discover-card, [data-je-hide-title]';
    const rowSelector = '.mainDetailButtons, .detailButtons';
    const WATCH = ['replay', 'shuffle', 'instant-mix', 'trailer', 'played'];
    // The More sheet opens for the newest opening only (D46S2-R6): a row or card whose reads answer after a later
    // press never replaces the sheet that press opened.
    const sheetOpening = JE.latestIntent();

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
        // The title link names the card: the overview's Request button comes first in a Seerr card and its tooltip can read "View on Seerr".
        const link = card.querySelector('a[data-tmdb-id][data-media-type]');
        return meta ? A.context({ mediaType: meta.dataset.mediaType, tmdbId: meta.dataset.tmdbId, name: (link?.querySelector('bdi') || link)?.textContent.trim() || '' }) : null;
    }

    /** Builds a visible keyboard/touch button. */
    function button(id, label, glyph) {
        const node = document.createElement('button'); node.type = 'button'; node.dataset.action = id;
        node.setAttribute('aria-label', label); node.title = label; node.append(A.icon(glyph)); ours.add(node);
        // Drawn for this session, route and document (D46S2-R11-1).
        JE.mountControl?.(node);
        return node;
    }

    /** True when the layout is jellyfin-web's desktop one (phones use layout-mobile, TVs layout-tv). */
    const desktopLayout = () => document.documentElement.classList.contains('layout-desktop');

    /**
     * Opens a current card's capability menu; recycled nodes, other routes and outgoing sessions are stale.
     * The card's mount is the one it has now: recycled for another title (even back to this one) is another.
     */
    async function openCard(card, opener, expected = null) {
        settleMutations();
        const c = cardContext(card); if (!c || !enabled()) return;
        // A delayed opening (a long press, D46S2-R13-2) acts only for the incarnation it was made on: never a newer one.
        if (!expected) mountCard(card);
        const mounted = cards.get(card);
        if (!mounted || mounted.key !== c.key || (expected && mounted !== expected)) return;
        // The card's incarnation, captured once (D46S2-R14-3): the same immutable handle through admission, the entry
        // reads and the sheet's publication; a removal or recycle meanwhile (even back to this title) ended it for good.
        const mount = mounted.mount;
        if (!mount.current()) return;
        // The OPENING (D46S2-R12-8): an offer of the card's stable mount, finished on every terminal path — rejected,
        // failed, superseded by a newer opening, or the sheet it showed closing. What the viewer submits from the sheet
        // belongs to the card's mount, not to this opening (it outlives the sheet).
        const owner = A.generation(() => mount.current());
        const newest = sheetOpening(owner);
        const live = () => { settleMutations(); return owner.current(); };
        let shown = false;
        try {
            if (!await A.admit(c, owner) || !live()) return;
            const entries = await A.entries(c, { action: owner, surface: 'recommendations' });
            if (live() && newest()) shown = A.show(c, entries, opener || card.querySelector('.je-card-more'), owner, { mount, onClose: () => A.finish(owner) });
        } catch (_) { if (owner.current()) JE.toast?.(JE.t('title_actions_failed')); }
        finally { if (!shown) A.finish(owner); }
    }

    /** Reconciles a retained/recycled card without retaining detached nodes. */
    function mountCard(card, pass = null) {
        const c = enabled() && cardContext(card);
        const prior = cards.get(card);
        if (!c) { removeCard(card); return; }
        const life = () => pass ? (pass.life || (pass.life = cardLife())) : cardLife();
        if (prior?.key === c.key && prior.button.parentNode === card) {
            card.querySelectorAll(':scope > .je-card-more').forEach(n => { if (n !== prior.button) n.remove(); });
            const now = life();
            if (prior.life === now && !prior.mount.ended()) return;
            // A card the host keeps and shows again (another route, then back; or put back after a removal): a NEW
            // incarnation (D46S2-R14-3). The old record and its mount stay ended; nothing captured from them revives.
            prior.mount.end();
            const record = { key: c.key, button: prior.button, mount: null, life: null };
            record.mount = cardMount(card, record, now);
            cards.set(card, record); drawn.add(card);
            return;
        }
        card.querySelectorAll('.je-card-more').forEach(n => n.remove());
        A.styles(); card.classList.add('je-actions-card');
        const node = button('more', JE.t('title_actions_more'), 'more_horiz'); node.className = 'je-card-more'; node.dataset.jeActionKey = c.key;
        // Only a press someone made opens it (D46S2-R11-1: a script's click names no owner).
        node.onclick = e => { e.preventDefault(); e.stopPropagation(); if (JE.ownerOf(e)) openCard(card, node); };
        // The card's stable MOUNT (D46S2-R12-8): one per drawn card (this title, this card, still shown); a recycled
        // card gets another. Its openings and the operations submitted from them are its children.
        const record = { key: c.key, button: node, mount: null, life: null };
        record.mount = cardMount(card, record, life());
        card.append(node); cards.set(card, record); drawn.add(card);
    }

    /**
     * The stable mount of a drawn card (its record, this title, still shown, within the pass's shared lifetime: this
     * route, session and document). Ended is forever. A plain record: it holds no registry entry (D46S2-R13-1).
     */
    function cardMount(card, record, life) {
        record.life = life;
        let ended = false;
        return {
            current() {
                if (!ended && !(life.current() && card.isConnected && cards.get(card) === record && cardContext(card)?.key === record.key)) ended = true;
                return !ended;
            },
            /** Seen ended (no check now). */
            ended: () => ended,
            /** Ends it for good (the card was removed, recycled or re-titled: noteMutations). */
            end() { ended = true; },
        };
    }

    /** The shared card lifetime: the current one, else a new one (minted at most once per pass, see cardPass). */
    function cardLife() {
        if (!shared || !shared.current()) { A.finish(shared); shared = A.generation(() => !disposed && enabled()); }
        return shared;
    }

    /**
     * Reconciles the document's cards (D46S2-R13-1): each found card in order, a slice per frame for a long grid. Once
     * the last slice is done, every card drawn before and no longer in the document as a card (removed, or no longer
     * one) is released at once, as is the shared lifetime when no card holds it.
     */
    function reconcileCards() {
        cancelAnimationFrame(cardFrame);
        cardPass = { list: document.querySelectorAll(CARD), index: 0, life: null };
        cardSlice();
    }
    function cardSlice() {
        const pass = cardPass;
        if (!pass || disposed) return;
        for (const end = Math.min(pass.list.length, pass.index + CARD_SLICE); pass.index < end; pass.index++) {
            const card = pass.list[pass.index];
            if (!card.isConnected) continue;
            mountCard(card, pass);
        }
        if (pass.index < pass.list.length) { cardFrame = requestAnimationFrame(cardSlice); return; }
        cardPass = null;
        let released = false;
        for (const card of [...drawn]) {
            if (card.isConnected && card.matches(CARD)) continue;
            removeCard(card); released = true;
        }
        releaseShared();
        // A mount that went (a card removed or recycled) ended its operations: their UI closes now.
        if (released) JE.endScopes?.();
    }

    /** Removes a card's adapter button; the card's own nodes stay as they are. */
    function removeCard(card) {
        card.classList.remove('je-actions-card'); card.querySelectorAll('.je-card-more').forEach(n => n.remove()); cards.delete(card); drawn.delete(card);
    }

    /** Releases the shared card lifetime once no card holds it. */
    function releaseShared() {
        if (drawn.size || !shared) return;
        A.finish(shared); shared = null;
    }

    /** Removes every card adapter button, to be rebuilt by the next scan for the current identity. */
    function removeCards() {
        cards = new WeakMap(); drawn = new Set(); cardPass = null; cancelAnimationFrame(cardFrame); releaseShared();
        if (!document) return; // the owning document has already gone
        document.querySelectorAll('.je-card-more').forEach(n => n.remove());
        document.querySelectorAll('.je-actions-card').forEach(n => n.classList.remove('je-actions-card'));
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
        if (c?.absent && match('.btnPlay, .btnResume, .btnReplay, .btnShuffle, .btnInstantMix, [data-action="play"], [data-action="resume"], .btnDownload, .btnDelete, .btnMediaInfo')) return null;
        // Every distinct playback action keeps a place: with progress, Jellyfin shows Resume (.btnPlay)
        // and Play from beginning (.btnReplay, data-action="play") side by side.
        if (match('.btnReplay')) return 'replay';
        if (match('.btnShuffle')) return 'shuffle';
        if (match('.btnInstantMix')) return 'instant-mix';
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
            return { id, source, disabled: source.disabled, reason: source.dataset.jeActionReason, group: WATCH.includes(id) ? 'watch' : ['guard', 'hide'].includes(id) ? 'view' : ['report', 'manage'].includes(id) ? 'requests' : 'other',
                label: ['guard', 'follow', 'manage', 'native-more', 'replay'].includes(id) ? JE.t({ guard: 'title_actions_guard', follow: 'title_actions_follow', manage: 'title_actions_manage', 'native-more': 'title_actions_native_more', replay: 'title_actions_replay' }[id]) : source.getAttribute('aria-label') || source.title || source.textContent.trim() || JE.t('title_actions_native_more'),
                fixedLabel: ['guard', 'follow', 'manage', 'native-more', 'report', 'replay'].includes(id), state: id === 'manage' ? JE.t('title_actions_admin') : undefined,
                icon: { replay: 'replay', shuffle: 'shuffle', 'instant-mix': 'explore', trailer: 'movie', played: 'done', guard: 'blur_on', hide: 'visibility', report: 'warning', manage: 'tune', 'native-more': 'more_vert' }[id] || source.querySelector('.material-icons')?.textContent || 'more_horiz' };
        }).filter(Boolean);
    }

    /** The host still shows the identity a row was mounted for. */
    function hostShows(root, c) {
        if (!root.isConnected || root._isClosing || root.classList.contains('hide')) return false;
        if (root.matches('.je-more-info-modal')) return String(root.dataset.tmdbId) === String(c?.tmdbId);
        const expected = c?.data?.itemId || c?.data?.Id;
        const shown = new URLSearchParams(location.hash.split('?')[1] || '').get('id');
        return !expected || !shown || String(expected).replace(/-/g, '') === String(shown).replace(/-/g, '');
    }

    /** A row, its adapter nodes and every continuation act only while its generation is current. */
    function rowCurrent(state) {
        return state.action.current();
    }

    /** Opens the same sheet for native library and provider pages, merging by action identity. */
    async function openRow(state, opener) {
        const action = state.action;
        if (!action.current()) return;
        const newest = sheetOpening(action);
        try {
            if (state.root.matches('.je-more-info-modal')) {
                try { await JE.internals?.moreInfoModal?.reconcilePaused?.(state.row); } catch (_) { /* the request sheet rechecks on submission */ }
                if (!action.current()) return;
            }
            if (state.c) {
                let admitted = false;
                // A cancelled admission ends the opening; any other failure leaves the native controls.
                try { admitted = await A.admit(state.c, action); } catch (error) { if (A.cancelled(error)) return; }
                if (!action.current() || (state.c.absent && !admitted)) return;
            }
            const adapted = state.c ? await A.entries(state.c, { action, root: state.root, surface: 'details' }) : [];
            if (!action.current()) return;
            const entries = nativeEntries(state);
            const present = new Set(entries.map(e => e.id));
            for (const entry of adapted) if (!present.has(entry.id)) { present.add(entry.id); entries.push(entry); }
            const title = state.c?.name || state.root.querySelector('.nameContainer .itemName:not(.originalTitle)')?.textContent || '';
            if (newest()) A.show({ ...state.c, name: title }, entries, opener, action);
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

    /**
     * The adapted Request follows the newest status of the title on every pass (D46S2-R7-5): in the row while the title
     * can be asked for and no native request control is there, out of it while it is asked for, on its way or here.
     */
    function reconcileRequest(state) {
        const request = state.request;
        if (!request) return;
        const want = request.askable && !originals(state.row).some(n => !n.dataset.jeActionKind && classify(n, state.c) === 'primary');
        if (want && request.node.parentElement !== state.row) { state.row.append(request.node); state.owned.add(request.node); }
        else if (!want && request.node.parentElement) { request.node.remove(); state.owned.delete(request.node); }
    }

    /** Reconciles a row. Native controls stay connected for their owners, hidden only in compact layout. */
    function paintRow(state) {
        const row = state.row;
        if (!row.isConnected) { rows.delete(row); return; }
        reconcileRequest(state);
        // Reconciled from state, not from what the host left (D46S2 audit S5): a host copy of an adapter node (no listener,
        // no owner) gives way, and every adapted control the row's capabilities hold is put back after any redraw (a
        // window that redraws its row after a request drops them without leaving copies).
        row.querySelectorAll('.je-actions-adapted').forEach(n => { if (!state.owned.has(n)) n.remove(); });
        state.owned.forEach(n => { if (!row.contains(n)) row.append(n); });
        if (state.more) {
            row.querySelectorAll('.je-actions-wide-more').forEach(n => { if (n !== state.more) n.remove(); });
            if (state.more.parentElement !== row) row.append(state.more);
        }
        let sources = originals(row);
        // Native owners arriving late supersede our adapted fallback, without duplicate actions.
        const nativeKinds = new Set(sources.filter(n => !n.dataset.jeActionKind).map(n => classify(n, state.c)));
        for (const node of sources) if (node.dataset.jeActionKind && nativeKinds.has(classify(node, state.c))) { node.remove(); state.owned.delete(node); }
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
            if (wasCompact) row.classList.remove('je-actions-compact');
            if (wasRibbon) parent.classList.remove('je-actions-ribbon');
            const style = parent && getComputedStyle(parent);
            const width = parent?.getBoundingClientRect().width || row.getBoundingClientRect().width || window.innerWidth - 32;
            state.available = width - (parseFloat(style?.paddingLeft) || 0) - (parseFloat(style?.paddingRight) || 0);
            state.widths = new WeakMap();
            for (const node of sources) state.widths.set(node, Math.max(48, node.getBoundingClientRect().width || 52));
            if (wasCompact) row.classList.add('je-actions-compact');
            if (wasRibbon) parent.classList.add('je-actions-ribbon');
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
        // Phones (layout-mobile) already give the native row its own line under an untouched header.
        // Only desktop at a narrow width, natively broken (the buttons sit beside a zero-width title),
        // stacks its ribbon so the row gets that line too.
        if (row.parentElement?.matches('.detailRibbon'))
            row.parentElement.classList.toggle('je-actions-ribbon', compact && window.innerWidth <= 600 && desktopLayout());
        sources.forEach(n => { if (!n.classList.contains('je-actions-original')) n.classList.add('je-actions-original'); });
        // Native Guard, Hide and Report controls in this row confirm before writing: a direct press is an
        // operation of the row while it is current (our own adapted controls are bound when created).
        sources.forEach(n => { if (!n.dataset.jeActionKind && ['guard', 'hide', 'report'].includes(classify(n, state.c))) A.bindPress(n, state.action, { native: true }); });
        // The compact row, its proxies and More are tracked by identity: a host copy is replaced.
        const owned = state.compact || (state.compact = { row: null, more: null, proxies: new Map() });
        row.querySelectorAll(':scope > .je-actions-row').forEach(n => { if (n !== owned.row) n.remove(); });
        if (!compact) { owned.row?.remove(); return; }
        if (!owned.row) { owned.row = document.createElement('div'); owned.row.className = 'je-actions-row'; ours.add(owned.row); }
        const compactRow = owned.row;
        if (compactRow.parentElement !== row) row.append(compactRow);
        const primary = visible.find(n => classify(n, state.c) === 'primary') || visible.find(n => classify(n, state.c) === 'replay');
        const favorite = visible.find(n => classify(n, state.c) === (state.c?.absent ? 'follow' : 'favorite'));
        const report = visible.find(n => classify(n, state.c) === 'report' && !n.disabled && n.getAttribute('aria-disabled') !== 'true');
        const primaryIcon = primary?.dataset.jeActionKind === 'open' || primary?.matches('.je-native-absent-open') ? 'open_in_new' : state.c?.absent ? 'add' : 'play_arrow';
        const selected = [['primary', primary, primaryIcon], [state.c?.absent ? 'follow' : 'favorite', favorite, state.c?.absent ? 'notifications_none' : 'favorite_border'], ['report', report, 'warning']];
        for (const [id, , ] of [...owned.proxies]) if (!selected.some(([want, source]) => want === id && source)) { owned.proxies.get(id).remove(); owned.proxies.delete(id); }
        for (const [id, source, glyph] of selected) {
            if (!source) continue;
            let proxy = owned.proxies.get(id);
            if (!proxy || proxy.jeActionSource !== source) {
                proxy?.remove(); proxy = button(id, source.title || '', glyph); proxy.className = 'je-actions-' + id; proxy.jeActionSource = source;
                // A press is an operation on this row's mount; owners that confirm first carry it.
                proxy.onclick = e => {
                    e.preventDefault(); e.stopPropagation();
                    if (JE.ownerOf(e) && rowCurrent(state) && state.row.contains(source) && !source.disabled && source.getAttribute('aria-disabled') !== 'true')
                        A.dispatch(source, A.generation(() => rowCurrent(state)));
                };
                if (id === 'primary') { const label = document.createElement('span'); label.className = 'je-actions-primary-label'; proxy.append(label); }
                owned.proxies.set(id, proxy);
            }
            syncProxy(proxy, source);
            if (id === 'primary') {
                const label = proxy.querySelector('.je-actions-primary-label'); const text = controlLabel(source);
                if (label.textContent !== text) label.textContent = text;
            }
        }
        if (!owned.more) { owned.more = button('more', JE.t('title_actions_more'), 'more_horiz'); owned.more.className = 'je-actions-more'; owned.more.onclick = e => { if (JE.ownerOf(e)) openRow(state, owned.more); }; }
        // Insert only misplaced controls: moving an already focused node makes browsers drop focus.
        const desired = ['primary', state.c?.absent ? 'follow' : 'favorite', 'report'].map(id => owned.proxies.get(id)).filter(Boolean).concat(owned.more);
        [...compactRow.children].forEach(n => { if (!desired.includes(n)) n.remove(); });
        desired.forEach((node, index) => { if (compactRow.children[index] !== node) compactRow.insertBefore(node, compactRow.children[index] || null); });
        fitLabel(state, compactRow, owned.proxies.get('primary')?.querySelector('.je-actions-primary-label'));
    }

    /**
     * Keeps the primary label whole (Rule 2b): Report moves to More first (it is always there too),
     * then the label wraps onto two lines. Measured only when its inputs change, so it can't oscillate.
     */
    function fitLabel(state, compactRow, label) {
        const levels = ['je-actions-fit-1', 'je-actions-fit-2'];
        // The row's own width (fit classes never change it) covers layout changes the window size misses.
        const key = [state.layoutSize, compactRow.clientWidth, label?.textContent, [...compactRow.children].map(n => n.dataset.action).join()].join('|');
        if (state.fitKey === key) return;
        compactRow.classList.remove(...levels);
        // Not rendered yet (hidden page): measure at the next pass.
        if (!label || !label.clientWidth) { state.fitKey = null; return; }
        state.fitKey = key;
        for (const level of levels) { if (label.scrollWidth <= label.clientWidth) break; compactRow.classList.add(level); }
    }

    /**
     * Mounts one row generation (session, this mount, route). Adapter nodes from an earlier mount or
     * copied by the host (a cloned row) carry no listener or owner, so they are removed and rebuilt.
     */
    function mountRow(row, root, c) {
        if (!enabled() || disposed) return;
        // An unchanged row (the same title, its generation current) is decided before anything is minted (D46S2-R11-13):
        // a reconciliation pass that changes nothing mints nothing.
        const host = hosts.get(root);
        if (!host || host.c?.key !== c?.key || !host.action.current()) hosts.set(root, { c, action: A.generation() });
        let state = rows.get(row);
        if (state && state.c?.key === c?.key && state.action.current()) { paintRow(state); return; }
        if (state) disposeRow(state);
        row.querySelectorAll('.je-actions-row, .je-actions-wide-more, .je-actions-adapted').forEach(n => n.remove());
        row.querySelectorAll('.je-actions-original').forEach(n => n.classList.remove('je-actions-original'));
        A.styles(); state = { row, root, c, widths: new WeakMap(), externalSources: new Set(), owned: new Set() };
        const mine = state;
        state.action = A.generation(() => !disposed && enabled() && rows.get(row) === mine && row.isConnected && hostShows(root, c));
        rows.set(row, state);
        if (root.matches('.je-more-info-modal')) {
            // The window's action mount has one home; a copy the host put in its narrow place keeps it.
            if (row.parentElement?.matches('.header-info') && row.parentElement.parentElement?.matches('.header-section'))
                homes.set(root, { parent: row.parentElement, next: row.nextSibling });
            const home = homes.get(root);
            if (home && (row.parentElement === home.parent || row.parentElement === home.parent.parentElement)) state.rowHome = home;
        }
        const more = button('more', JE.t('title_actions_more'), 'more_horiz'); more.className = 'button-flat detailButton emby-button je-actions-wide-more';
        more.onclick = e => { if (JE.ownerOf(e)) openRow(state, more); }; state.more = more; row.append(more);
        paintRow(state);
        if (c) setupRow(state);
    }

    /** Adds the provider's adapted controls; every continuation stops once the row's generation is stale. */
    function setupRow(state) {
        const { row, root, c, action } = state;
        // Subscribed before the setup reads the title's status (D46S2-R8-5): a change landing between that read and the
        // Request it decides is reconciled once the Request exists. Only where the setup can add one (JE mode).
        if (c.absent && JE.arrAsk?.enabled?.() && JE.arrStatus?.enabled?.()) followStatus(state);
        (async () => {
            try { if (!await A.admit(c, action) && c.absent) return []; }
            // A cancelled admission ends the setup; a refused one leaves a library row its native controls.
            catch (error) { if (A.cancelled(error) || c.absent) return []; }
            if (!action.current()) return [];
            return A.entries(c, { action, root, surface: 'details', reconcile: true });
        })().then(entries => {
            if (!action.current()) return;
            for (const entry of entries) {
                if (entry.source && !row.contains(entry.source) && ['guard', 'hide', 'follow', 'manage'].includes(entry.id)) {
                    state.externalSources.add(entry.source);
                    // The host's own Guard/Hide outside the row (More Info's secondary actions) confirm too.
                    if (['guard', 'hide'].includes(entry.id)) A.bindPress(entry.source, action, { native: true });
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
                    node.onclick = e => {
                        // Only a press someone made is the row's operation (D46S2-R11-1).
                        if (!JE.ownerOf(e) || !action.current()) return;
                        const operation = A.generation(() => action.current());
                        A.invoke(c, entry, node, operation).catch(() => { if (operation.current()) JE.toast?.(JE.t('title_actions_failed')); });
                    };
                } else A.bindPress(node, action);
                ours.add(node);
                // The JE-mode Request is reconciled with the title's status on every pass (reconcileRequest).
                if (entry.id === 'request' && 'askable' in entry) { state.request = { node, askable: entry.askable }; if (state.statusChanged) state.refreshStatus?.(); continue; }
                state.owned.add(node); row.append(node);
                if (entry.id === 'report' && entry.control) JE.jellyseerrIssueReporter?.applyIssueIndicator?.(node, c.tmdbId, c.type, action.current);
            }
            // No adapted Request to keep current: the subscription goes.
            if (!state.request) { state.unsubscribe?.(); state.unsubscribe = null; }
            paintRow(state);
        }).catch(() => {});
    }

    /**
     * Keeps the row's Request on the newest status (D46S2-R7-5): every change of the title (the change feed, or an ask
     * or cancel here, which refresh it) re-reads its status for the row's generation; only the newest read decides,
     * and a read that fails keeps what the row shows. Subscribed before the row's setup reads the status (D46S2-R8-5):
     * a change that arrives before the setup has made the Request is remembered and re-read once it exists.
     */
    function followStatus(state) {
        const { c, action } = state;
        if (!c?.titleKey || !JE.arrStatus?.subscribe || !JE.arrStatus.fetchKey) return;
        const reads = JE.latestIntent();
        state.refreshStatus = async () => {
            if (!action.current()) return;
            if (!state.request) { state.statusChanged = true; return; }
            state.statusChanged = false;
            const newest = reads(action);
            const status = await JE.arrStatus.fetchKey(c.titleKey).catch(() => null);
            if (!status || !newest() || rows.get(state.row) !== state || !state.request) return;
            state.request.askable = JE.internals?.arrAskSheet?.askable?.(status.items?.[0]) !== false;
            paintRow(state);
        };
        state.unsubscribe = JE.arrStatus.subscribe([c.titleKey], state.refreshStatus);
    }

    /** Removes only this row's owned UI and restores original controls. */
    function disposeRow(state) {
        state.unsubscribe?.(); state.unsubscribe = null;
        state.request?.node.remove(); state.request = null;
        state.row.classList.remove('je-actions-compact');
        state.row.parentElement?.classList.remove('je-actions-ribbon');
        state.externalSources.forEach(node => node.classList.remove('je-actions-external-original'));
        if (state.rowHome) {
            const { parent, next } = state.rowHome;
            parent.parentElement?.classList.remove('je-actions-modal-header');
            // Only a row still in the document returns home; a row the host replaced stays detached.
            if (state.row.isConnected && state.row.parentElement !== parent) parent.insertBefore(state.row, next?.parentNode === parent ? next : null);
        }
        state.row.querySelectorAll('.je-actions-original').forEach(n => n.classList.remove('je-actions-original'));
        // Adapter nodes (and host copies of them) never outlive their generation; native originals stay.
        state.row.querySelectorAll('.je-actions-row, .je-actions-wide-more, .je-actions-adapted').forEach(n => n.remove());
        state.owned?.forEach(n => n.remove()); state.owned?.clear();
        state.compact = null;
        if (rows.get(state.row) === state) rows.delete(state.row);
        A.close(false, state.action);
    }

    /** Bounded DOM reconciliation, triggered by host navigation and external mutations. */
    function scan() {
        queued = false;
        if (disposed) return;
        // The action bar going off ends every operation it started, for good.
        if (!enabled()) { if (active) { active = false; A.end(); } A.close(false); rows.forEach(disposeRow); hosts.clear(); removeCards(); JE.endScopes?.(); return; }
        active = true;
        reconcileCards();
        A.prune?.();
        for (const [root, host] of hosts) {
            if (!host.action.current() || !hostShows(root, host.c)) { hosts.delete(root); continue; }
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
        // A mount that went (a row re-rendered, a card recycled) ended its operations: their UI closes now.
        JE.endScopes?.();
    }

    /** The document is leaving (pagehide, freeze): its operations have ended; the hosts it shows are kept for a restore. */
    function departed() {
        parked = new Map([...(parked || []), ...[...hosts].map(([root, host]) => [root, host.c])]);
        A.close(false);
    }

    /** The document came back (pageshow from the cache, resume): every host still shown gets fresh controls at once. */
    function restored() {
        for (const [root, c] of parked || []) if (hostShows(root, c)) hosts.set(root, { c, action: A.generation() });
        parked = null;
        if (started && !disposed) scan();
    }

    /** A host copy of an adapter node (our classes, not one of ours) needs reconciling. */
    const copied = r => r.type === 'childList' && [...r.addedNodes].some(n => n.nodeType === 1 && !ours.has(n) &&
        (n.matches?.('.je-actions-row, .je-actions-wide-more, .je-card-more, .je-actions-adapted') || r.target.matches?.('.je-actions-row')));

    /** The classes of a class value that are not ours (je-actions-*), in order. */
    const hostClasses = value => String(value || '').split(/\s+/).filter(name => name && !name.startsWith('je-actions-')).sort().join(' ');
    /** A class change that only added or removed our own classes (marking a card ours queues no other pass). */
    const ownClassChange = r => r.type === 'attributes' && r.attributeName === 'class' && hostClasses(r.oldValue) === hostClasses(r.target.getAttribute?.('class'));

    /** Coalesces unrelated changes; mutations inside our own controls never queue another pass. */
    /** Status decorations do not change native action hosts or their capabilities. */
    const STATUS_UI = '.je-arr-status, .je-arr-art, .je-arr-chip, .je-arr-chip-row, .je-arr-banner, .je-arr-badge, .je-ask-ring';

    /**
     * Recognizes status-only mutation batches before scheduling a global action reconciliation.
     * @param {MutationRecord} record Mutation.
     * @returns {boolean} Only status-owned UI changed.
     */
    function statusOnly(record) {
        if (record.target.closest?.(STATUS_UI)) return true;
        if (record.type !== 'childList') return false;
        const elements = [...record.addedNodes, ...record.removedNodes].filter(node => node.nodeType === 1);
        return elements.length > 0 && elements.every(node => node.matches(STATUS_UI));
    }

    function schedule(records) {
        if (records && !records.some(r => !statusOnly(r) && !ownClassChange(r) && (copied(r) || (!r.target.closest?.('.je-actions-row, .je-actions-backdrop, .je-card-more') &&
            (r.type !== 'childList' || r.target.closest?.('.je-actions-original') || [...r.addedNodes, ...r.removedNodes].some(n => n.nodeType === 1 && !n.matches?.('.je-actions-row, .je-actions-wide-more, .je-card-more'))))))) return;
        if (queued || disposed) return; queued = true; frame = requestAnimationFrame(scan);
    }

    /** The observer's callback: incarnations end first (every record), then a pass is queued for what changed. */
    function observed(records) { noteMutations(records); schedule(records); }

    /**
     * Ends the incarnation of every drawn card `records` show removed (itself or an ancestor), or re-identified (an
     * identity attribute changed, or an element carrying one was added or removed inside it) — D46S2-R14-3. Our own
     * adapter nodes and every other change (classes, images, text) leave it alone.
     */
    function noteMutations(records) {
        const endCard = card => { if (card) cards.get(card)?.mount.end(); };
        for (const r of records) {
            if (r.type === 'attributes') { if (IDENTITY.includes(r.attributeName)) endCard(r.target.closest?.(CARD)); continue; }
            if (r.type !== 'childList') continue;
            for (const node of r.removedNodes) {
                if (node.nodeType !== 1 || ours.has(node)) continue;
                if (cards.has(node)) endCard(node);
                else node.querySelectorAll?.(CARD).forEach(endCard);
            }
            const holder = r.target.nodeType === 1 ? r.target.closest?.(CARD) : null;
            if (holder && [...r.addedNodes, ...r.removedNodes].some(n => n.nodeType === 1 && !ours.has(n) && (n.matches(identityNodes) || n.querySelector(identityNodes))))
                endCard(holder);
        }
    }

    /** Takes the observer's pending records into account now (before a long press or an opening acts). */
    function settleMutations() {
        const pending = observer?.takeRecords();
        if (pending?.length) observed(pending);
    }

    /** Stops a long press when scrolling, releasing or cancelling the pointer. */
    function cancelTouch() { if (touch) clearTimeout(touch.timer); touch = null; }

    /** Starts host hooks after the bundle has initialized its existing feature owners. */
    function initialize() {
        if (started) return; started = true;
        observer = new MutationObserver(observed); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: [...IDENTITY, 'disabled', 'aria-pressed', 'aria-label', 'title', 'class'] });
        document.addEventListener('contextmenu', e => {
            const card = e.target.closest?.(CARD); if (!enabled() || !cardContext(card) || !JE.ownerOf(e)) return;
            e.preventDefault(); e.stopImmediatePropagation(); cancelTouch(); openCard(card);
        }, true);
        document.addEventListener('pointerdown', e => {
            // A new gesture never belongs to the previous long press, even if the host reuses its pointer id.
            consumed = null;
            if (e.pointerType === 'mouse' || !enabled()) return;
            const card = e.target.closest?.(CARD); if (!cardContext(card) || (e.target.closest('button') && !e.target.closest('.je-discover-poster-box'))) return;
            // The long press is the viewer's gesture: its menu opens 550 ms later only while that gesture's owner is
            // still current (the same page, session and document; D46S2-R11), and only for the card as it was pressed
            // (D46S2-R13-2): its mount and title, captured now. A card the host recycled meanwhile (another title, even
            // back to this one; a change still pending included) or removed opens nothing.
            const owner = JE.ownerOf(e);
            if (!owner) return;
            settleMutations();
            mountCard(card);
            const record = cards.get(card);
            if (!record) return;
            cancelTouch(); touch = { x: e.clientX, y: e.clientY, timer: setTimeout(() => {
                cancelTouch();
                if (!JE.effectOwner(owner, 'a long press')) return;
                // Changes still pending end the incarnation first (a removal, a recycle — even back to this title).
                settleMutations();
                if (cards.get(card) !== record || !record.mount.current()) return;
                consumed = { card, pointerId: e.pointerId }; openCard(card, null, record);
            }, 550) };
        }, true);
        document.addEventListener('pointermove', e => { if (touch && Math.hypot(e.clientX - touch.x, e.clientY - touch.y) > 10) cancelTouch(); }, true);
        ['pointerup', 'pointercancel', 'scroll'].forEach(name => document.addEventListener(name, cancelTouch, true));
        document.addEventListener('click', e => {
            // Chromium can retarget the release click to the sheet's covering backdrop. It is still the same
            // touch gesture, consumed once; the next pointerdown clears it before any deliberate new tap.
            if (consumed && (consumed.card.contains(e.target) ||
                (e.pointerType === 'touch' && Number.isFinite(e.pointerId) && e.pointerId === consumed.pointerId))) { e.preventDefault(); e.stopImmediatePropagation(); consumed = null; return; }
            consumed = null;
            const nativeMenu = e.target.closest?.('[data-action="menu"], .btnCardMenu, .cardMenuButton');
            const card = nativeMenu?.closest(CARD);
            if (enabled() && cardContext(card) && JE.ownerOf(e)) { e.preventDefault(); e.stopImmediatePropagation(); openCard(card, card.querySelector('.je-card-more')); }
        }, true);
        document.addEventListener('keydown', e => {
            const card = e.target.closest?.(CARD);
            if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && enabled() && cardContext(card) && JE.ownerOf(e)) { e.preventDefault(); e.stopImmediatePropagation(); openCard(card); }
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
            const action = A.generation(() => !disposed && page.isConnected);
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
        JE.session?.onUserChange?.('title-actions', () => { A.close(false); rows.forEach(disposeRow); hosts.clear(); removeCards(); cancelTouch(); receiving = null; schedule(); sharedLink(); });
        JE.arrNotify?.onChange?.(what => { if (what === 'follows') schedule(); });
        scan(); sharedLink();
    }

    /** Handles authenticated share navigation once per URL/session; no sender data is restored. */
    async function sharedLink() {
        const key = new URLSearchParams(location.hash.split('?')[1] || '').get('jeTitle');
        if (!key || !ApiClient.getCurrentUserId() || receiving === key) return;
        receiving = key;
        const owner = A.generation();
        if (await A.receive(key)) return;
        if (owner.current()) JE.toast?.(JE.t('title_actions_unavailable'));
        // Left before it resolved: coming back to the link resolves it again.
        else if (receiving === key) receiving = null;
    }
    /** Releases the global observer and queued paint when the owning document is disposed. */
    function dispose() {
        disposed = true; A.end(); observer?.disconnect(); cancelAnimationFrame(frame); queued = false;
        cancelTouch(); A.close(false); rows.forEach(disposeRow); hosts.clear(); removeCards();
    }
    Object.assign(A, { enabled, scan, mountRow, cardContext, initialize, dispose, departed, restored });
    JE.initializeTitleActions = initialize;
})(window.JellyfinEnhanced);
