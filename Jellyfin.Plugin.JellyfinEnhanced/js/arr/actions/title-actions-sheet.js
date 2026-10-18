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
@media(max-width:600px){.detailRibbon.je-actions-ribbon{padding-left:16px!important;padding-right:16px!important;flex-direction:column;align-items:stretch}.detailRibbon.je-actions-ribbon>.infoWrapper{width:100%;flex:none;min-width:0}.detailRibbon.je-actions-ribbon .mainDetailButtons{flex:none}.je-actions-backdrop{align-items:flex-end}.je-actions-sheet{border-radius:20px 20px 0 0;max-height:94dvh;padding-bottom:max(20px,env(safe-area-inset-bottom))}}
@media(max-width:600px){
.je-actions-phone-page>.detailPageWrapperContainer{display:block;margin-top:-56px!important}
.je-actions-phone-page .detailPagePrimaryContainer{display:grid!important;grid-template-columns:112px minmax(0,1fr);gap:20px 16px;padding:0 16px!important;box-sizing:border-box;width:100%}
.je-actions-phone-page .detailImageContainer{grid-column:1;grid-row:1;width:112px!important;height:168px!important;margin:0!important;padding:0!important;display:block!important}
.je-actions-phone-page .detailImageContainer>.card{width:112px!important;max-width:none!important;margin:0!important;left:0!important;top:0!important}
.je-actions-phone-page .detailRibbon.je-actions-ribbon{display:contents!important;height:auto!important;margin:0!important;padding:0!important}
.je-actions-phone-page .detailRibbon.je-actions-ribbon>.infoWrapper{grid-column:2;grid-row:1;align-self:start;padding-top:64px;width:auto!important;min-width:0;overflow:hidden}
.je-actions-phone-page .infoWrapper .itemName{font-size:24px!important;line-height:1.2;white-space:normal!important;text-overflow:clip}
.je-actions-phone-page .infoWrapper .originalTitle{font-size:14px!important;white-space:normal!important}
.je-actions-phone-page .infoWrapper .miscInfo{display:flex;flex-wrap:wrap;gap:6px}
.je-actions-phone-page .mainDetailButtons.je-actions-compact{grid-column:1/-1;grid-row:2;margin:0!important;max-width:100%!important}
.je-actions-phone-page .detailPagePrimaryContent{grid-column:1/-1;grid-row:3;margin:0!important;padding:0!important;width:100%!important;min-width:0}
}
@media(max-width:600px){.je-actions-phone-page .infoWrapper>.detailImageContainer{display:none!important}.je-actions-phone-page .infoWrapper .itemMiscInfo{display:flex;flex-wrap:wrap;gap:6px}}
@media(max-width:360px){.je-actions-row .je-actions-primary{padding:0 6px;gap:4px}.je-actions-row .je-actions-primary>.material-icons{font-size:20px}.je-more-info-modal .je-actions-row .je-actions-primary{padding:0 3px}}
.je-more-info-modal .header-section.je-actions-modal-header{flex-wrap:wrap}.je-more-info-modal .je-actions-modal-header>.je-more-info-actions{flex:0 0 100%;width:100%;max-width:100%!important;margin:0}
.layout-tv .je-actions-sheet{max-height:95dvh;width:min(680px,100%)}.layout-tv .je-actions-entry{min-height:60px}
`;
        document.head.append(node);
    }

    /** Material icons already supplied by the host; no new subset dependency. */
    function icon(name) {
        const node = el('span', 'material-icons', name || 'more_horiz'); node.setAttribute('aria-hidden', 'true'); return node;
    }

    /** Closes the current sheet and restores a live opener, including a row replaced by the host. */
    function close(restore = true) {
        if (!current) return;
        const state = current; current = null;
        state.lease.open = false; state.release?.(); state.observer.disconnect(); state.backdrop.remove();
        for (const [node, before] of state.inert) node.inert = before;
        if (restore && state.action.current()) {
            const target = state.opener?.isConnected ? state.opener : state.returnHost?.querySelector('.je-actions-more, .je-card-more');
            target?.focus();
        }
    }

    /** Synchronizes labels and state from original native/JE controls, including issue counts. */
    function sync(entry, button) {
        const source = entry.source || entry.control;
        const label = entry.label || source?.getAttribute('aria-label') || source?.title || source?.textContent || '';
        let text = entry.fixedLabel ? label : source?.getAttribute('aria-label') || source?.title || label;
        if (entry.id === 'hide') text = text === JE.t('hidden_content_unhide') ? text : JE.t('title_actions_hide');
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

    /** Opens one sheet, with visible focus and keyboard/remote Back and directional navigation. */
    function show(c, entries, opener = document.activeElement) {
        close(false); styles();
        const lease = { open: true };
        const action = JE.createSessionAction();
        const backdrop = el('div', 'je-actions-backdrop');
        const sheet = el('section', 'je-actions-sheet focuscontainer');
        sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-label', JE.t('title_actions_more'));
        const head = el('div', 'je-actions-head');
        const heading = el('div', 'je-actions-heading'); heading.append(el('h2', '', JE.t('title_actions_more')), el('div', 'je-actions-subtitle', c.name));
        const dismiss = el('button', 'je-actions-close', '×'); dismiss.type = 'button'; dismiss.setAttribute('aria-label', JE.t('title_actions_close'));
        dismiss.onclick = () => close(); head.append(heading, dismiss); sheet.append(el('div', 'je-actions-handle'), head);
        const pairs = [];
        for (const group of groups) {
            const order = { watch: ['trailer', 'played', 'open'], view: ['guard', 'hide'], requests: ['report', 'follow', 'request', 'manage'], other: ['share', 'native-more'] }[group];
            const rank = id => order.includes(id) ? order.indexOf(id) : 100;
            const rows = entries.filter(e => (e.group || 'other') === group).sort((a, b) => rank(a.id) - rank(b.id));
            if (!rows.length) continue;
            sheet.append(el('div', 'je-actions-group', JE.t('title_actions_group_' + group)));
            for (const entry of rows) {
                const button = el('button', 'je-actions-entry'); button.type = 'button'; button.dataset.action = entry.id;
                const label = el('span', 'je-actions-entry-label'); label.append(document.createTextNode(entry.label || ''));
                const owner = entry.source || entry.control;
                const disabled = entry.disabled || owner?.disabled || owner?.getAttribute('aria-disabled') === 'true';
                const reason = entry.reason || owner?.dataset.jeActionReason || owner?.title;
                if (reason && disabled) label.append(el('span', 'je-actions-reason', reason));
                button.append(icon(entry.icon), label, el('span', 'je-actions-state'));
                if (entry.control) { entry.control.classList.add('je-actions-control'); sheet.append(entry.control); }
                sync(entry, button); pairs.push([entry, button]);
                button.onclick = async () => {
                    if (!action.current() || button.disabled) return;
                    const source = entry.source || entry.control;
                    // Close before opening the owner's modal; that modal owns focus from this point.
                    try {
                        const pending = A.invoke(c, { ...entry, ...(source ? { source } : {}), valid: () => lease.open, beforeRun: () => close() }, opener, action);
                        await pending;
                    }
                    catch (_) { if (action.current()) JE.toast?.(JE.t('title_actions_failed')); }
                };
                sheet.append(button);
            }
        }
        backdrop.append(sheet);
        const inert = [...document.body.children].filter(n => n.tagName !== 'SCRIPT' && n.tagName !== 'STYLE').map(n => [n, n.inert]);
        inert.forEach(([n]) => { n.inert = true; });
        document.body.append(backdrop);
        pairs.forEach(([entry]) => {
            if (entry.id === 'report' && entry.control) JE.jellyseerrIssueReporter?.applyIssueIndicator?.(entry.control, c.tmdbId, c.type);
        });
        const observer = new MutationObserver(() => pairs.forEach(([entry, button]) => sync(entry, button)));
        pairs.forEach(([entry]) => { const source = entry.source || entry.control; if (source) observer.observe(source, { subtree: true, childList: true, attributes: true }); });
        current = { backdrop, opener, action, observer, inert, lease, returnHost: opener?.closest('.mainDetailButtons, .detailButtons, .card, .jellyseerr-card'), release: action.onCancel(() => close(false)) };
        dismiss.onclick = () => close();
        backdrop.onclick = e => { if (e.target === backdrop) close(); };
        sheet.addEventListener('keydown', e => {
            if (['Escape', 'BrowserBack', 'GoBack'].includes(e.key) || e.keyCode === 461 || e.keyCode === 10009) { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
            if (!['Tab', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
            const buttons = [...sheet.querySelectorAll('button:not(:disabled)')].filter(n => !n.closest('.je-actions-control'));
            const index = buttons.indexOf(document.activeElement);
            const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.shiftKey || ['ArrowUp', 'ArrowLeft'].includes(e.key) ? -1 : 1) + buttons.length) % buttons.length;
            e.preventDefault(); e.stopImmediatePropagation(); buttons[next]?.focus();
        });
        sheet.querySelector('.je-actions-entry:not(:disabled)')?.focus();
    }

    /** Supplies a selectable link when neither Web Share nor the clipboard is available. */
    function showLink(url) {
        show({}, [], document.activeElement);
        const input = el('input', 'je-actions-link'); input.readOnly = true; input.value = url;
        input.setAttribute('aria-label', JE.t('title_actions_share')); current.backdrop.querySelector('section').append(input); input.focus(); input.select();
    }
    Object.assign(A, { show, close, styles, icon, showLink });
})(window.JellyfinEnhanced);
