/** Design B's grouped, focus-contained More sheet; native entries proxy their live source controls. */
(function (JE) {
    'use strict';
    const A = JE.titleActions;
    let current = null;
    const groups = ['watch', 'view', 'requests', 'other'];

    /** Creates a text-only element (provider metadata is never interpolated as markup). */
    function el(tag, cls, text) {
        const node = document.createElement(tag);
        node.className = cls || '';
        if (text != null) node.textContent = text;
        return node;
    }

    /** Adds Design B styles once. Native owners retain their own DOM and visibility decisions. */
    function styles() {
        if (document.getElementById('je-title-actions-style')) return;
        const node = el('style'); node.id = 'je-title-actions-style';
        node.textContent = `
.je-actions-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:1000001;display:flex;align-items:center;justify-content:center;color:#fff;font-family:inherit}
.je-actions-sheet{box-sizing:border-box;background:#1c1c1c;border-radius:20px;width:min(460px,100%);max-height:90dvh;overflow:auto;padding:8px 0 20px;box-shadow:0 12px 64px #0008}
.je-actions-handle{width:36px;height:4px;border-radius:2px;background:#5a5a5a;margin:0 auto}
.je-actions-head{display:flex;gap:12px;align-items:center;padding:12px 16px 8px}.je-actions-heading{flex:1;min-width:0}.je-actions-heading h2{font-size:18px;margin:0}.je-actions-subtitle{font-size:13px;color:#a8a8a8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px}
.je-actions-sheet button,.je-actions-row button{border:0;font:inherit;color:inherit;cursor:pointer}.je-actions-close{width:44px;height:44px;border-radius:22px;background:none;flex-shrink:0}
.je-actions-group{padding:14px 16px 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#a8a8a8}
.je-actions-entry{display:flex;align-items:center;gap:16px;width:calc(100% - 12px);margin:0 6px;min-height:48px;padding:8px 10px;background:none;border-radius:10px;text-align:start;font-size:15px!important}
.je-actions-entry-label{flex:1;min-width:0}.je-actions-state{font-size:13px;color:#c4c4c4}.je-actions-reason{display:block;font-size:12px;color:#a8a8a8;margin-top:3px}.je-actions-entry:disabled{opacity:.6;cursor:default}
.je-actions-entry:focus-visible,.je-actions-close:focus-visible,.je-actions-row button:focus-visible,.je-card-more:focus-visible{outline:2px solid #fff!important;outline-offset:-2px;background-color:#2a2a2a}
.je-actions-control,.je-actions-external-original{display:none!important}.je-actions-row{display:flex;align-items:center;gap:10px;min-width:0;width:100%;box-sizing:border-box}
.je-actions-row button{display:flex;align-items:center;justify-content:center;gap:8px;height:52px;min-width:52px;width:52px;flex:0 0 52px;border-radius:26px;background:#1c1c1c;padding:0;position:relative}
.je-actions-row .je-actions-primary{flex:1 1 0;width:auto;min-width:0;background:#0077a8;color:#fff;font-size:16px;font-weight:700;padding:0 12px;overflow:hidden}.je-actions-primary-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.je-actions-row .material-icons{font-size:24px}.je-actions-row .je-actions-report{color:#ff8a3d}.je-actions-badge{position:absolute;top:2px;right:2px;min-width:18px;height:18px;box-sizing:border-box;border-radius:9px;padding:0 4px;background:#b84a00;color:#fff;font-size:11px;display:flex;align-items:center;justify-content:center}
.je-actions-compact{min-width:0!important;max-width:calc(100vw - 32px)!important;width:100%}.je-actions-compact>:not(.je-actions-row){display:none!important}.je-actions-wide-more{display:inline-flex}.je-actions-compact>.je-actions-wide-more{display:none!important}
.je-actions-card .je-hide-btn{top:calc(var(--je-title-menu-top,6px) + 50px)}.je-card-more{position:absolute;top:var(--je-title-menu-top,6px);right:6px;width:44px;height:44px;display:flex!important;align-items:center;justify-content:center;border:0;border-radius:22px;background:#1c1c1ce6;color:white;z-index:11;cursor:pointer}.je-actions-card{position:relative}
.je-actions-link{box-sizing:border-box;width:100%;padding:12px;background:#101010;color:white;border:1px solid #555}
@media(max-width:600px){.je-actions-backdrop{align-items:flex-end}.je-actions-sheet{border-radius:20px 20px 0 0;max-height:94dvh;padding-bottom:max(20px,env(safe-area-inset-bottom))}}
@media(max-width:600px){.layout-desktop .detailRibbon.je-actions-ribbon{flex-direction:column;align-items:stretch;height:auto!important;padding-left:16px!important;padding-right:16px!important}.layout-desktop .detailRibbon.je-actions-ribbon>.infoWrapper{width:auto;min-width:0}}
@media(max-width:360px){.je-actions-row{gap:8px}.je-actions-row button{height:48px;min-width:48px;width:48px;flex-basis:48px;border-radius:24px}.je-actions-row .je-actions-primary{padding:0 6px;gap:4px}.je-actions-row .je-actions-primary>.material-icons{font-size:20px}.je-more-info-modal .je-actions-row .je-actions-primary{padding:0 3px}}
.je-actions-row.je-actions-fit-1>.je-actions-report{display:none!important}.je-actions-row.je-actions-fit-2 .je-actions-primary-label{white-space:normal;text-overflow:clip;overflow-wrap:break-word;font-size:14px;line-height:1.1;text-align:center}
.je-more-info-modal .header-section.je-actions-modal-header{flex-wrap:wrap}.je-more-info-modal .je-actions-modal-header>.je-more-info-actions{flex:0 0 100%;width:100%;max-width:100%!important;margin:0}
.layout-tv .je-actions-sheet{max-height:95dvh;width:min(680px,100%)}.layout-tv .je-actions-entry{min-height:60px}
`;
        document.head.append(node);
    }

    /** Material icons already supplied by the host; no new subset dependency. */
    function icon(name) {
        const node = el('span', 'material-icons', name || 'more_horiz'); node.setAttribute('aria-hidden', 'true'); return node;
    }

    /**
     * Closes the current sheet (only when `owner` opened it, if given). The stack restores the page behind it and then
     * focus (its opener while live, else the nearest live part of the page: D46S2-R12-10); its offer finishes.
     */
    function close(_restore = true, owner) {
        if (!current || (owner && current.owner !== owner)) return;
        const state = current; current = null;
        state.lease.open = false; state.release?.();
        state.releaseScope?.(); state.observer.disconnect(); state.backdrop.remove();
        A.finish(state.action);
        state.onClose?.();
    }

    /** Closes one particular sheet if it is still the open one (a later sheet is left alone). */
    function closeLease(lease, restore = true) {
        if (current?.lease === lease) close(restore);
    }

    /**
     * Synchronizes labels and state from original native/JE controls, including issue counts. A title that is not in
     * the library (`c.absent`) is hidden as a title (its provider-title rule), not "from my library".
     */
    function sync(entry, button, c) {
        const source = entry.source || entry.control;
        const label = entry.label || source?.getAttribute('aria-label') || source?.title || source?.textContent || '';
        let text = entry.fixedLabel ? label : source?.getAttribute('aria-label') || source?.title || label;
        if (entry.id === 'hide') text = text === JE.t('hidden_content_unhide') ? text : JE.t(c?.absent ? 'title_actions_hide_title' : 'title_actions_hide');
        if (entry.id === 'guard') text = JE.t('title_actions_guard');
        if (entry.id === 'follow') text = JE.t('title_actions_follow');
        if (entry.id === 'report') text = JE.t('jellyseerr_report_issue_button');
        button.querySelector('.je-actions-entry-label').firstChild.textContent = text;
        button.disabled = entry.disabled === true || source?.disabled === true || source?.getAttribute('aria-disabled') === 'true';
        const pressed = source?.getAttribute('aria-pressed') ?? (entry.pressed == null ? null : String(entry.pressed));
        if (pressed != null) button.setAttribute('aria-pressed', pressed);
        const state = button.querySelector('.je-actions-state');
        state.textContent = entry.state || (pressed == null ? '' : JE.t(pressed === 'true' ? 'title_actions_on' : 'title_actions_off'));
        const badge = source?.querySelector('.jellyseerr-issue-count-badge');
        if (badge && badge.textContent.trim() && parseInt(badge.textContent, 10) > 0) state.textContent = JE.t('title_actions_open_issues', { n: badge.textContent });
    }

    /**
     * Opens one sheet, with visible focus and keyboard/remote Back and directional navigation. The sheet
     * is the OFFER: a press counts only while it is open, its session and route are current and its
     * owning host (a row or card: `owner`, required, D46S2-R6) is still current. The press starts an OPERATION
     * owned by the session, the route and that host, so it outlives the sheet (D53). The opening is admitted first
     * (D46S2 audit S2): an owner that is not current opens nothing and leaves the current sheet alone (false).
     */
    function show(c, entries, opener, owner, { mount = null, onClose = null } = {}) {
        const host = JE.admitSurface(owner, 'the title actions sheet');
        if (!host) return false;
        close(false); styles();
        opener = opener || document.activeElement;
        const lease = { open: true };
        const action = A.generation(() => lease.open && host.current() !== false);
        // What a press submits belongs to the stable mount the offer was shown for (a card's or a row's), not to the
        // offer: it outlives the sheet closing (D46S2-R12-8).
        const base = mount || host;
        const backdrop = el('div', 'je-actions-backdrop');
        const sheet = el('section', 'je-actions-sheet focuscontainer');
        sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-label', JE.t('title_actions_more'));
        const head = el('div', 'je-actions-head');
        const heading = el('div', 'je-actions-heading'); heading.append(el('h2', '', JE.t('title_actions_more')), el('div', 'je-actions-subtitle', c.name));
        const dismiss = el('button', 'je-actions-close', '×'); dismiss.type = 'button'; dismiss.setAttribute('aria-label', JE.t('title_actions_close'));
        dismiss.onclick = () => close(); head.append(heading, dismiss); sheet.append(el('div', 'je-actions-handle'), head);
        const pairs = [];
        for (const group of groups) {
            const order = { watch: ['replay', 'shuffle', 'instant-mix', 'trailer', 'played', 'open'], view: ['guard', 'hide'], requests: ['report', 'follow', 'request', 'request-4k', 'manage'], other: ['share', 'native-more'] }[group];
            const rank = id => order.includes(id) ? order.indexOf(id) : 100;
            const rows = entries.filter(e => (e.group || 'other') === group).sort((a, b) => rank(a.id) - rank(b.id));
            if (!rows.length) continue;
            sheet.append(el('div', 'je-actions-group', JE.t('title_actions_group_' + group)));
            for (const entry of rows) {
                const button = el('button', 'je-actions-entry'); button.type = 'button'; button.dataset.action = entry.id;
                const label = el('span', 'je-actions-entry-label'); label.append(document.createTextNode(entry.label || ''));
                const control = entry.source || entry.control;
                const disabled = entry.disabled || control?.disabled || control?.getAttribute('aria-disabled') === 'true';
                const reason = entry.reason || control?.dataset.jeActionReason || control?.title;
                if (reason && disabled) label.append(el('span', 'je-actions-reason', reason));
                button.append(icon(entry.icon), label, el('span', 'je-actions-state'));
                if (entry.control) { entry.control.classList.add('je-actions-control'); sheet.append(entry.control); }
                sync(entry, button, c); pairs.push([entry, button]);
                button.onclick = async e => {
                    // Only a press someone made is an operation (D46S2-R11-1: a script's click names no owner).
                    if (!JE.ownerOf(e) || !action.current() || button.disabled) return;
                    const operation = A.generation(() => base.current() !== false);
                    // Close before opening the owner's modal; that modal owns focus from this point.
                    try { await A.invoke(c, { ...entry, ...(control ? { source: control } : {}), beforeRun: () => closeLease(lease) }, opener, operation); }
                    catch (_) { if (operation.current()) JE.toast?.(JE.t('title_actions_failed')); }
                };
                sheet.append(button);
            }
        }
        backdrop.append(sheet);
        // The page behind is covered by the surface stack (inert, out of the accessibility tree, D46S2-R12-11).
        document.body.append(backdrop);
        pairs.forEach(([entry]) => {
            if (entry.id === 'report' && entry.control) JE.jellyseerrIssueReporter?.applyIssueIndicator?.(entry.control, c.tmdbId, c.type, action.current);
        });
        const observer = new MutationObserver(() => pairs.forEach(([entry, button]) => sync(entry, button, c)));
        pairs.forEach(([entry]) => { const source = entry.source || entry.control; if (source) observer.observe(source, { subtree: true, childList: true, attributes: true }); });
        current = { backdrop, opener, action, owner: host, observer, lease, onClose, release: action.onCancel(() => close(false)) };
        dismiss.onclick = () => close();
        backdrop.onclick = e => { if (e.target === backdrop) close(); };
        // The offer's scope: once it has ended (its page, row, card, user or document went) it takes no more presses
        // and closes. Once closed it is detached, and a press inside it is a submitted operation's own (its owned control).
        current.releaseScope = JE.openSurface(backdrop, () => closeLease(lease, false), action, { opener, dismiss: () => close() });
        if (!current.releaseScope) { close(false); return false; }
        // Escape and every Back key reach the sheet through the surface stack only (the topmost surface, the viewer's key).
        sheet.addEventListener('keydown', e => {
            if (!['Tab', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
            // Only the topmost surface moves focus, and only for the viewer's key (D46S2-R12-6).
            if (!JE.surfaceInput(backdrop, e)) return;
            const buttons = [...sheet.querySelectorAll('button:not(:disabled)')].filter(n => !n.closest('.je-actions-control'));
            const index = buttons.indexOf(document.activeElement);
            const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.shiftKey || ['ArrowUp', 'ArrowLeft'].includes(e.key) ? -1 : 1) + buttons.length) % buttons.length;
            e.preventDefault(); e.stopImmediatePropagation(); buttons[next]?.focus();
        });
        sheet.querySelector('.je-actions-entry:not(:disabled)')?.focus();
        return true;
    }

    /**
     * Supplies a selectable link when neither Web Share nor the clipboard is available (or either refused). `owner`
     * (required): the Share operation, which the link sheet belongs to and closes with (D46S2-R6-4).
     */
    function showLink(url, owner) {
        if (!show({}, [], document.activeElement, owner)) return;
        const input = el('input', 'je-actions-link'); input.readOnly = true; input.value = url;
        input.setAttribute('aria-label', JE.t('title_actions_share')); current.backdrop.querySelector('section').append(input); input.focus(); input.select();
    }
    Object.assign(A, { show, close, styles, icon, showLink });
})(window.JellyfinEnhanced);
