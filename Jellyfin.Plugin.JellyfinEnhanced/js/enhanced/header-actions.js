/**
 * Keeps Random handy and collapses the remaining JE actions into a More menu
 * when the complete header row will not fit. Original buttons stay mounted,
 * preserving feature listeners and state;
 * the labeled menu activates those originals. No scrolling is used.
 */
(function (JE) {
    'use strict';

    let tray, header, row, launcher, panel, grid, pager;
    let frame;
    let started = false;
    let pageIndex = 0;
    let compactMode = false;
    const mirrors = new Map();
    const observed = new Set();
    const resizeObserver = new ResizeObserver(schedule);
    const sourceObserver = new MutationObserver(records => {
        // The launcher's own display is managed here; observing that write
        // would schedule another layout after every layout.
        if (records.some(record => record.target !== launcher)) schedule();
    });
    const number = value => parseFloat(value) || 0;
    const sourceSelector = '.headerButton:not(.je-header-launcher)';

    function schedule() {
        if (!frame) frame = requestAnimationFrame(update);
    }

    function onBodyMutation(records) {
        // Poster rows, tab contents and our own menu mirrors cannot change the
        // header budget. ResizeObserver handles changes to its measured sizes.
        // Still discover a new/replaced header when React remounts it.
        if (!tray?.isConnected || !row?.isConnected || records.some(record =>
            row.contains(record.target) || [...record.addedNodes].some(node =>
                node.nodeType === 1 && (node.matches('.headerRight, .MuiToolbar-root') ||
                    node.querySelector('.headerRight, .MuiToolbar-root'))))) schedule();
    }

    /** Includes margins: themes may add spacing outside the clickable surface. */
    function outerWidth(element) {
        const css = getComputedStyle(element);
        return element.getBoundingClientRect().width + number(css.marginLeft) + number(css.marginRight);
    }

    function contentWidth(element) {
        const css = getComputedStyle(element);
        return element.clientWidth - number(css.paddingLeft) - number(css.paddingRight);
    }

    /** Ignore unused flex-grow space, especially the legacy .headerLeft. */
    function occupiedWidth(element) {
        const css = getComputedStyle(element);
        const children = [...element.children].filter(child => child.getClientRects().length && getComputedStyle(child).position !== 'absolute');
        if (number(css.flexGrow) > 0) {
            const chrome = number(css.paddingLeft) + number(css.paddingRight) + number(css.marginLeft) + number(css.marginRight);
            if (!children.length) return Math.min(outerWidth(element), chrome);
            if (css.display.includes('flex') && css.flexDirection.startsWith('row')) {
                const content = children.reduce((width, child) => width + outerWidth(child), 0);
                return Math.min(outerWidth(element), content + chrome + number(css.columnGap) * (children.length - 1));
            }
        }
        return outerWidth(element);
    }

    /**
     * Use the parent row's budget, never the already-overflowing tray's width.
     * Walk up through intermediate wrappers to account for native navigation,
     * logo, hamburger, avatar, gaps and theme padding exactly once.
     */
    function availableWidth() {
        let available = contentWidth(row);
        const path = [];
        for (let element = header; element && element !== row; element = element.parentElement) path.unshift(element);
        let parent = row;
        for (const element of path) {
            const siblings = [...parent.children].filter(child => child !== element && getComputedStyle(child).position !== 'absolute' && child.getClientRects().length);
            available -= siblings.reduce((width, sibling) => width + occupiedWidth(sibling), 0);
            available -= number(getComputedStyle(parent).columnGap) * siblings.length;
            const css = getComputedStyle(element);
            // Margins skipped: `margin-left: auto` resolves to the free space itself.
            available -= number(css.paddingLeft) + number(css.paddingRight);
            parent = element;
        }
        const native = [...header.children].filter(child => child !== tray && getComputedStyle(child).position !== 'absolute' && child.getClientRects().length);
        available -= native.reduce((width, child) => width + outerWidth(child), 0);
        available -= number(getComputedStyle(header).columnGap) * native.length;
        return Math.max(0, available - 2); // Allow for fractional CSS-pixel rounding.
    }

    /** Translate plain-text labels, including with older cached locale files. */
    function label(key, fallback) {
        const value = JE.t(key);
        return value && value !== key ? value : fallback;
    }

    /** Keep DOM/tab order identical to the visible order, including late arrivals. */
    function orderSources() {
        const rank = element => element.id === 'je-native-tabs-group' ? 0 :
            element.id === 'randomItemButtonContainer' ? 1 : element === launcher ? 3 : 2;
        const children = [...tray.children].sort((a, b) => rank(a) - rank(b));
        let anchor = null;
        for (const child of children.reverse()) {
            if (child.nextSibling !== anchor) tray.insertBefore(child, anchor);
            anchor = child;
        }
    }

    /** Refresh text after account/language changes without inserting locale HTML. */
    function updateLabels() {
        const title = label('header_more_actions', 'More from Jellyfin Enhanced');
        launcher.title = title;
        launcher.setAttribute('aria-label', title);
        const heading = panel.querySelector('h2');
        const text = label('header_more_title', 'More from JE');
        if (heading.textContent !== text) heading.textContent = text;
        panel.querySelector('.je-launcher-close').setAttribute('aria-label', label('awards_close', 'Close'));
        pager.querySelector('[data-previous]').setAttribute('aria-label', label('header_previous_page', 'Previous page'));
        pager.querySelector('[data-next]').setAttribute('aria-label', label('header_next_page', 'Next page'));
    }

    function closeLauncher() {
        launcher?.setAttribute('aria-expanded', 'false');
        if (panel?.open) panel.close();
    }

    function changePage(delta) {
        pageIndex += delta;
        layoutPanel();
        [...grid.children].find(button => !button.hidden && !button.disabled)?.focus();
    }

    /** Position against the visible viewport, including phone browser chrome. */
    function layoutPanel() {
        if (!panel?.open) return;
        const viewport = window.visualViewport;
        const viewportWidth = viewport?.width || window.innerWidth;
        const viewportHeight = viewport?.height || window.innerHeight;
        const offsetLeft = viewport?.offsetLeft || 0;
        const offsetTop = viewport?.offsetTop || 0;
        const width = Math.min(viewportWidth - 24, 320);
        const anchor = launcher.getBoundingClientRect();
        const edge = getComputedStyle(launcher).direction === 'rtl' ? anchor.left : anchor.right - width;
        const left = Math.max(offsetLeft + 12, Math.min(edge, offsetLeft + viewportWidth - width - 12));
        panel.style.left = left + 'px';
        panel.style.width = width + 'px';
        const focused = document.activeElement;
        const buttons = [...grid.children];
        // Measure natural row heights at the final width. Translations and large
        // text can exceed the normal 48px touch target; never divide by a fixed
        // row height. These temporary visibility changes complete before paint.
        buttons.forEach(button => { button.hidden = false; });
        pager.hidden = false;
        const panelCSS = getComputedStyle(panel);
        const chrome = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth']
            .reduce((height, property) => height + number(panelCSS[property]), 0) +
            panel.querySelector('.je-launcher-heading').getBoundingClientRect().height;
        const pagerHeight = pager.getBoundingClientRect().height + number(getComputedStyle(pager).marginTop);
        const gap = number(getComputedStyle(grid).rowGap);
        const heights = buttons.map(button => button.getBoundingClientRect().height);
        const minimumHeight = chrome + pagerHeight + Math.max(48, ...heights);
        const top = Math.max(offsetTop + 12, Math.min(anchor.bottom + 8, offsetTop + viewportHeight - minimumHeight - 12));
        panel.style.top = top + 'px';
        const available = offsetTop + viewportHeight - top - 12 - chrome;
        const totalHeight = heights.reduce((total, height) => total + height, 0) + gap * Math.max(0, buttons.length - 1);
        const paged = totalHeight > available;
        const budget = available - (paged ? pagerHeight : 0);
        const pages = [[]];
        let used = 0;
        buttons.forEach((button, index) => {
            let current = pages[pages.length - 1];
            const spacing = current.length ? gap : 0;
            if (current.length && used + spacing + heights[index] > budget) {
                current = [];
                pages.push(current);
                used = 0;
            }
            used += (current.length ? gap : 0) + heights[index];
            current.push(button);
        });
        pageIndex = Math.max(0, Math.min(pageIndex, pages.length - 1));
        const visible = new Set(pages[pageIndex]);
        buttons.forEach(button => { button.hidden = !visible.has(button); });
        pager.hidden = pages.length === 1;
        pager.querySelector('[data-previous]').disabled = pageIndex === 0;
        pager.querySelector('[data-next]').disabled = pageIndex === pages.length - 1;
        const status = pager.querySelector('[role="status"]');
        const text = `${pageIndex + 1} / ${pages.length}`;
        if (status.textContent !== text) status.textContent = text;
        if ((focused?.parentElement === grid && focused.hidden) ||
            (pager.contains(focused) && (pager.hidden || focused.disabled))) {
            (buttons.find(button => !button.hidden && !button.disabled) || panel.querySelector('.je-launcher-close')).focus();
        }
    }

    function createLauncher() {
        launcher = document.createElement('button');
        launcher.type = 'button';
        launcher.id = 'je-header-launcher';
        launcher.className = 'headerButton headerButtonRight paper-icon-button-light je-header-launcher';
        launcher.setAttribute('is', 'paper-icon-button-light');
        launcher.setAttribute('aria-haspopup', 'dialog');
        launcher.setAttribute('aria-controls', 'je-header-launcher-panel');
        launcher.setAttribute('aria-expanded', 'false');
        launcher.innerHTML = '<span class="material-icons" aria-hidden="true">more_horiz</span>';
        tray.appendChild(launcher);

        // A native modal dialog supplies the focus trap, Escape dismissal and
        // inert background. Jellyfin's dialog class lets installed themes apply.
        panel = document.createElement('dialog');
        panel.id = 'je-header-launcher-panel';
        panel.className = 'dialog je-launcher-panel';
        panel.setAttribute('aria-labelledby', 'je-launcher-title');
        panel.innerHTML = `
            <div class="je-launcher-heading">
                <h2 id="je-launcher-title"></h2>
                <button type="button" class="paper-icon-button-light je-launcher-close" autofocus><span class="material-icons" aria-hidden="true">close</span></button>
            </div>
            <div class="je-launcher-grid"></div>
            <div class="je-launcher-pager" hidden>
                <button type="button" class="paper-icon-button-light" data-previous><span class="material-icons" aria-hidden="true">chevron_left</span></button>
                <span role="status" aria-live="polite"></span>
                <button type="button" class="paper-icon-button-light" data-next><span class="material-icons" aria-hidden="true">chevron_right</span></button>
            </div>`;
        grid = panel.querySelector('.je-launcher-grid');
        pager = panel.querySelector('.je-launcher-pager');
        updateLabels();
        document.body.appendChild(panel);
        panel.querySelector('.je-launcher-close').addEventListener('click', closeLauncher);
        pager.querySelector('[data-previous]').addEventListener('click', () => changePage(-1));
        pager.querySelector('[data-next]').addEventListener('click', () => changePage(1));
        panel.addEventListener('close', () => launcher.setAttribute('aria-expanded', 'false'));
        panel.addEventListener('click', event => {
            if (event.target !== panel) return;
            const rect = panel.getBoundingClientRect();
            if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeLauncher();
        });
        grid.addEventListener('keydown', event => {
            const buttons = [...grid.children].filter(button => !button.hidden && !button.disabled);
            const index = buttons.indexOf(document.activeElement);
            if (index < 0) return;
            const rtl = getComputedStyle(grid).direction === 'rtl';
            const steps = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, ArrowDown: 1, ArrowUp: -1 };
            let next;
            if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = buttons.length - 1;
            else if (event.key in steps) next = Math.max(0, Math.min(buttons.length - 1, index + steps[event.key]));
            else return;
            event.preventDefault();
            event.stopPropagation();
            buttons[next]?.focus();
        });
        launcher.addEventListener('click', () => {
            if (panel.open) { closeLauncher(); return; }
            pageIndex = 0;
            // Native theme colors are available even while the MUI drawer is closed.
            const paper = document.querySelector('.MuiDrawer-paper');
            if (paper) {
                const theme = getComputedStyle(paper);
                panel.style.setProperty('--je-launcher-surface', theme.backgroundColor);
                panel.style.setProperty('--je-launcher-text', theme.color);
            }
            panel.showModal();
            launcher.setAttribute('aria-expanded', 'true');
            layoutPanel();
        });
    }

    function updateMirror(source) {
        let button = mirrors.get(source);
        if (!button) {
            button = document.createElement('button');
            button.type = 'button';
            button.className = 'emby-button je-launcher-action';
            button.dataset.jeHeaderAction = source.id;
            button.innerHTML = '<span class="je-launcher-icon" aria-hidden="true"></span><span class="je-launcher-label"></span>';
            button.addEventListener('click', event => {
                // Do not let this click reach the outside-click listener of a
                // feature panel that the forwarded action is about to open.
                event.preventDefault();
                event.stopPropagation();
                if (source.disabled || !source.isConnected) return;
                closeLauncher();
                source.click();
            });
            mirrors.set(source, button);
        }
        const label = source.dataset.headerLabel || source.title || source.getAttribute('aria-label') || '';
        const text = button.querySelector('.je-launcher-label');
        if (text.textContent !== label) text.textContent = label;
        if (button.title !== source.title) button.title = source.title;
        button.disabled = source.disabled;
        const icon = button.querySelector('.je-launcher-icon');
        if (icon.dataset.sourceMarkup !== source.innerHTML) {
            icon.dataset.sourceMarkup = source.innerHTML;
            icon.replaceChildren(...[...source.childNodes].map(child => child.cloneNode(true)));
            icon.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
        }
        return button;
    }

    function attachTray(current) {
        if (current !== header || !tray.isConnected) {
            closeLauncher();
            header?.classList.remove('je-header-actions-host');
            row?.classList.remove('je-header-actions-row', 'je-launcher-tight');
            header = current;
            row = header.closest('.MuiToolbar-root, .headerTop') || header.parentElement;
            header.classList.add('je-header-actions-host');
            row.classList.add('je-header-actions-row');
            header.prepend(tray);
            schedule();
        }
    }

    function update() {
        frame = null;
        if (!tray || !JE.session.getUserId()) return;
        const current = JE.helpers.getHeaderRightContainer();
        if (!current) { closeLauncher(); return; }
        attachTray(current);
        if (!row.getClientRects().length) { closeLauncher(); return; }
        orderSources();
        updateLabels();
        const sources = [...tray.querySelectorAll(sourceSelector)];
        const visibleSources = sources.filter(source => !source.hidden && source.getClientRects().length && getComputedStyle(source).display !== 'none');
        const trayCSS = getComputedStyle(tray);
        const gap = number(trayCSS.columnGap);
        const chrome = ['marginLeft', 'marginRight', 'paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth']
            .reduce((width, property) => width + number(trayCSS[property]), 0);
        // Always measure with the ordinary title restored, so a previously
        // collapsed launcher cannot keep itself stuck in the wrong state.
        if (row.classList.contains('je-launcher-tight')) row.classList.remove('je-launcher-tight');
        let available = Math.max(0, availableWidth() - chrome);
        const fullWidth = visibleSources.reduce((width, source) => width + outerWidth(source), 0) + gap * Math.max(0, visibleSources.length - 1);
        // Measure More before allocating space. This is resolved before paint.
        launcher.style.setProperty('display', 'inline-flex', 'important');
        const moreWidth = outerWidth(launcher);
        // Hide the legacy title only when even More would otherwise overflow.
        if (visibleSources.length && fullWidth > available && available < moreWidth) {
            row.classList.add('je-launcher-tight');
            available = Math.max(0, availableWidth() - chrome);
        }
        // Small hysteresis prevents repeated swaps at a fractional-width boundary,
        // without reserving an entire icon's worth of usable header space.
        const expansionSpace = compactMode ? 8 : 0;
        const collapsed = visibleSources.length > 0 && fullWidth + expansionSpace > available;
        const pinned = ['randomItemButton', 'je-active-streams']
            .map(id => visibleSources.find(source => source.id === id)).filter(Boolean);
        const inline = new Set();
        if (collapsed) {
            let remaining = Math.max(0, available - moreWidth);
            const priority = [...pinned, ...visibleSources.filter(source => !pinned.includes(source))];
            for (const source of priority) {
                const width = outerWidth(source);
                const margin = source.classList.contains('je-header-overflowed') ? 8 : 0;
                if (width + gap + margin > remaining) break;
                inline.add(source);
                remaining -= width + gap;
            }
        } else {
            visibleSources.forEach(source => inline.add(source));
        }
        compactMode = collapsed;
        launcher.style.setProperty('display', collapsed ? 'inline-flex' : 'none', 'important');
        const overflowSources = visibleSources.filter(source => !inline.has(source));
        for (const source of sources) {
            const overflowed = collapsed && !inline.has(source);
            if (overflowed && source.contains(document.activeElement)) launcher.focus();
            if (source.classList.contains('je-header-overflowed') !== overflowed) source.classList.toggle('je-header-overflowed', overflowed);
            if (overflowed && source.getAttribute('aria-hidden') !== 'true') source.setAttribute('aria-hidden', 'true');
            else if (!overflowed && source.hasAttribute('aria-hidden')) source.removeAttribute('aria-hidden');
        }
        if (!tray.dataset.ready) tray.dataset.ready = 'true';
        if (!collapsed) {
            const focused = document.activeElement;
            const target = visibleSources.find(source => source.id === focused?.dataset.jeHeaderAction) || visibleSources[0];
            const restoreFocus = panel.open || focused === launcher;
            closeLauncher();
            if (restoreFocus) (target || header.querySelector(':scope > button, :scope > a'))?.focus();
        }
        const included = new Set(overflowSources);
        for (const [source, button] of mirrors) {
            if (!included.has(source)) {
                if (button === document.activeElement) panel.querySelector('.je-launcher-close').focus();
                button.remove();
                mirrors.delete(source);
            }
        }
        let anchor = null;
        for (const source of [...overflowSources].reverse()) {
            const button = updateMirror(source);
            if (button.parentElement !== grid || button.nextSibling !== anchor) grid.insertBefore(button, anchor);
            anchor = button;
        }
        if (panel.open) layoutPanel();
        const nextObserved = new Set([row, header, ...row.children, ...[...row.children].flatMap(child => [...child.children]), ...header.children, ...sources]);
        for (const element of observed) {
            if (!nextObserved.has(element)) { resizeObserver.unobserve(element); observed.delete(element); }
        }
        for (const element of nextObserved) {
            if (!observed.has(element)) { resizeObserver.observe(element); observed.add(element); }
        }
    }

    function getTray() {
        if (!JE.session.getUserId()) return null;
        const current = JE.helpers.getHeaderRightContainer();
        if (!current) return null;
        if (!tray) {
            tray = document.createElement('div');
            tray.id = 'je-header-buttons-group';
            tray.className = 'je-header-buttons-tray';
            createLauncher();
        }
        if (!started) {
            started = true;
            JE.helpers.addCSS('je-header-actions-css', `
                .je-header-actions-row, .je-header-actions-host { flex-wrap: nowrap !important; }
                .je-header-actions-host { min-width: 0; }
                .je-header-buttons-tray { display: flex; align-items: center; flex: 0 0 auto; position: relative; }
                .je-header-buttons-tray > #randomItemButtonContainer,
                .je-header-buttons-tray > #je-native-tabs-group { display: contents !important; }
                .je-header-buttons-tray #je-native-tabs-separator { display: none !important; }
                .je-header-buttons-tray .headerButton { flex-shrink: 0; }
                #je-header-buttons-group .headerButton[hidden] { display: none !important; }
                .je-header-buttons-tray .je-header-overflowed,
                .je-header-buttons-tray:not([data-ready]) .headerButton {
                    position: absolute !important; visibility: hidden !important;
                    pointer-events: none !important; inset-inline-start: 0; top: 0;
                }
                .je-launcher-tight .headerLeft .pageTitle { display: none !important; }
                .je-header-launcher > .material-icons { font-size: 24px; width: 24px; height: 24px; }
                .je-header-launcher[aria-expanded="true"] { background: rgba(128,128,128,.2); }
                .je-launcher-panel {
                    position: fixed !important; margin: 0 !important; padding: 12px !important;
                    box-sizing: border-box; max-width: none !important; max-height: none !important;
                    min-width: 0 !important; border: 1px solid rgba(128,128,128,.25); border-radius: 8px;
                    background: var(--je-launcher-surface, var(--jf-palette-background-paper, #292929));
                    color: var(--je-launcher-text, var(--jf-palette-text-primary, #fff));
                    box-shadow: 0 8px 32px rgba(0,0,0,.45); transform: none !important;
                    overflow: visible !important; opacity: 1 !important;
                }
                .je-launcher-panel:not([open]) { display: none !important; }
                .je-launcher-panel[open] { display: block !important; }
                .je-launcher-panel::backdrop { background: rgba(0,0,0,.35); }
                .je-launcher-heading { display: flex; align-items: center; justify-content: space-between; min-height: 40px; }
                .je-launcher-heading h2 { font-size: 1rem; font-weight: 500; margin: 0 4px; }
                .je-launcher-close { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; flex-shrink: 0; padding: 0; }
                .je-launcher-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0; }
                .je-launcher-action.emby-button {
                    display: flex; align-items: center; justify-content: flex-start;
                    gap: 16px; min-height: 48px; min-width: 0; box-sizing: border-box; margin: 0; padding: 6px 12px;
                    border: 0; border-radius: 4px; color: inherit; background: transparent;
                    text-transform: none; font: inherit; cursor: pointer;
                }
                .je-launcher-action.emby-button:hover { background: rgba(128,128,128,.25); }
                .je-launcher-action:disabled { opacity: .45; cursor: default; }
                .je-launcher-panel button:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
                .je-launcher-action[hidden], .je-launcher-pager[hidden] { display: none !important; }
                .je-launcher-icon { display: inline-flex; align-items: center; justify-content: center; min-height: 24px; flex-shrink: 0; }
                .je-launcher-icon .material-icons, .je-launcher-icon svg { font-size: 24px; width: 24px; height: 24px; }
                .je-launcher-icon .je-as-sup { margin-inline-start: 4px; font-size: .7em; }
                .je-launcher-label { font-size: .875rem; line-height: 1.2; text-align: start; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
                .je-launcher-pager { display: flex; align-items: center; justify-content: space-between; height: 36px; margin-top: 8px; }
                .je-launcher-pager button { display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 36px; padding: 0; }
                .je-launcher-pager [role="status"] { font-size: .8rem; }
            `);
            JE.helpers.onBodyMutation('je-header-actions', onBodyMutation);
            sourceObserver.observe(tray, { subtree: true, childList: true, attributes: true, attributeFilter: ['title', 'aria-label', 'data-header-label', 'disabled', 'hidden', 'style'] });
            window.addEventListener('resize', schedule);
            window.visualViewport?.addEventListener('resize', schedule);
            window.visualViewport?.addEventListener('scroll', layoutPanel);
            window.addEventListener('hashchange', closeLauncher);
            document.fonts?.addEventListener('loadingdone', schedule);
        }
        // Reconnect synchronously so callers can find existing button IDs, but
        // measure only once in the next frame after all features insert theirs.
        attachTray(current);
        return tray;
    }

    JE.session.onUserChange('header-actions', () => {
        closeLauncher();
        mirrors.forEach(button => button.remove());
        mirrors.clear();
        tray?.replaceChildren(launcher);
        tray?.remove();
        header?.classList.remove('je-header-actions-host');
        row?.classList.remove('je-header-actions-row', 'je-launcher-tight');
        header = row = null;
        compactMode = false;
        resizeObserver.disconnect();
        observed.clear();
    });

    JE.headerActions = { getTray };
})(window.JellyfinEnhanced);
