/** Native Dashboard user-tab DOM adapter; native nodes and handlers remain owned by Jellyfin. */
(function (JE) {
    'use strict';
    const legacyRoots = { profile: 'editUserPage', access: 'userLibraryAccessPage', parentalcontrol: 'userParentalControlPage', password: 'userPasswordPage' };
    /** Construct a supported, bookmarkable user-tab URL for either Jellyfin router. */
    function href(family, id, tab) {
        const native = tab === 'jellyfinenhanced' ? 'access' : tab;
        return (family === '12' ? '#/dashboard/users/' + id + '/' + native : '#/dashboard/users/' + native + '?userId=' + id)
            + (tab === 'jellyfinenhanced' ? (family === '12' ? '?' : '&') + 'jeTab=jellyfinenhanced' : '');
    }
    /** Keep one injected tab and reversible native selection/content overrides per editor mount. */
    function create(schedule) {
        let owned = null, host = null, currentRoute = null, observer = null;
        const hidden = new Map(), attributes = new Map(), indicators = new Map();
        /** Change attributes only when necessary so observers settle after one paint. */
        function attr(node, key, value) { if (node.getAttribute(key) !== value) node.setAttribute(key, value); }
        /** Remember native state once before temporarily overriding its selection. */
        function remember(node) {
            if (!attributes.has(node)) attributes.set(node, ['class', 'aria-selected', 'tabindex', 'aria-current'].map(key => [key, node.getAttribute(key)]));
        }
        /** Restore the native tab state and native content without replacing React nodes. */
        function restore() {
            for (const [node, values] of attributes) for (const [key, value] of values) {
                if (value === null) { if (node.hasAttribute(key)) node.removeAttribute(key); } else attr(node, key, value);
            }
            attributes.clear();
            for (const [node, wasHidden] of hidden) if (node.hidden !== wasHidden) node.hidden = wasHidden;
            hidden.clear();
            for (const [node, css] of indicators) if (node.style.cssText !== css) node.style.cssText = css;
            indicators.clear();
        }
        /** Remove only JE DOM and listener ownership. */
        function reset() {
            observer?.disconnect(); observer = null; host?.closest('.MuiTabs-root')?.removeAttribute('data-je-user-tabs'); restore(); owned?.remove(); owned = null;
            host?.removeEventListener('keydown', keys, true); host?.removeEventListener('click', nativeClick, true); host = null;
        }
        /** The hidden Access component remains React-selected; explicitly leave JE through a native route. */
        function nativeClick(event) {
            if (!currentRoute?.enhanced || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button) return;
            const target = event.target.closest('[role="tab"],a');
            if (!target || target === owned) return;
            const tabs = Array.from(host.children).filter(n => n !== owned && n.matches('[role="tab"],a'));
            const name = ['profile', 'access', 'parentalcontrol', 'password'][tabs.indexOf(target)];
            if (!name) return;
            event.preventDefault(); event.stopPropagation(); location.hash = href(currentRoute.family, currentRoute.id, name);
        }
        /** Focus tabs in their visual order; activation still goes through each native click handler. */
        function keys(event) {
            const target = event.target.closest('[role="tab"],a');
            if (!target || target.parentElement !== host) return;
            const entries = Array.from(host.children).filter(n => n.matches('[role="tab"],a') && !n.disabled);
            const index = entries.indexOf(target), rtl = getComputedStyle(host).direction === 'rtl';
            let next;
            if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = entries.length - 1;
            else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') next = (index + ((event.key === 'ArrowRight') !== rtl ? 1 : -1) + entries.length) % entries.length;
            else if (target === owned && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); owned.click(); return; }
            else return;
            event.preventDefault(); event.stopPropagation(); entries[next]?.focus();
        }
        /** Attach/reconcile after React mounts or replaces its tab strip. Returns the JE panel's native parent. */
        function update(route) {
            currentRoute = route;
            const root = document.getElementById(route.family === '12' ? 'usersEditPage' : legacyRoots[route.tab]);
            const strip = root?.querySelector(route.family === '12' ? '[role="tablist"]' : '.localnav[data-role="controlgroup"]');
            if (!strip) { reset(); return null; }
            if (host !== strip || !owned?.isConnected) {
                reset(); host = strip;
                host.closest('.MuiTabs-root')?.setAttribute('data-je-user-tabs', '');
                const siblings = Array.from(host.children).filter(n => n.matches(route.family === '12' ? '[role="tab"]' : 'a'));
                if (siblings.length !== 4) return null;
                owned = siblings[1].cloneNode(true);
                owned.removeAttribute('id'); owned.removeAttribute('aria-controls'); owned.removeAttribute('aria-current');
                owned.textContent = JE.t('arr_user_tab'); owned.dataset.jeUserTab = '';
                owned.classList.remove('Mui-selected', 'ui-btn-active');
                owned.id = 'je-admin-user-tab'; owned.setAttribute('role', 'tab');
                if (owned.tagName === 'A') owned.href = href(route.family, route.id, 'jellyfinenhanced');
                else owned.type = 'button';
                owned.addEventListener('click', event => {
                    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button) return;
                    event.preventDefault(); location.hash = href(currentRoute.family, currentRoute.id, 'jellyfinenhanced');
                });
                host.insertBefore(owned, siblings[2]); host.addEventListener('keydown', keys, true); host.addEventListener('click', nativeClick, true);
                observer = new MutationObserver(schedule);
                observer.observe(host.closest('.MuiTabs-root') || host, { attributes: true, subtree: true, attributeFilter: ['class', 'aria-selected', 'tabindex', 'style'] });
            }
            if (owned.tagName === 'A') {
                const url = href(route.family, route.id, 'jellyfinenhanced');
                if (owned.getAttribute('href') !== url) owned.href = url;
            }
            const natives = Array.from(host.children).filter(n => n !== owned && n.matches('[role="tab"],a'));
            if (natives.length === 4 && owned.nextElementSibling !== natives[2]) host.insertBefore(owned, natives[2]);
            const active = route.enhanced;
            attr(owned, 'aria-selected', String(active)); attr(owned, 'tabindex', active ? '0' : '-1');
            const activeClass = route.family === '12' ? 'Mui-selected' : 'ui-btn-active';
            if (owned.classList.contains(activeClass) !== active) owned.classList.toggle(activeClass, active);
            if (!active) { restore(); owned.removeAttribute('aria-controls'); return null; }
            attr(owned, 'aria-controls', 'je-admin-user-panel');
            for (const tab of Array.from(host.children).filter(n => n !== owned && n.matches('[role="tab"],a'))) {
                remember(tab); attr(tab, 'aria-selected', 'false'); attr(tab, 'tabindex', '-1'); tab.removeAttribute('aria-current');
                for (const name of ['Mui-selected', 'ui-btn-active']) if (tab.classList.contains(name)) tab.classList.remove(name);
            }
            // Native12 places tabs and panel inside a Stack. Legacy keeps navigation outside content-primary.
            let anchor = host;
            const content = root.querySelector('.content-primary') || root;
            while (anchor.parentElement && anchor.parentElement !== content && anchor.parentElement.children.length === 1) anchor = anchor.parentElement;
            // MUI's indicator/scroll wrappers are all inside MuiTabs-root.
            anchor = host.closest('.MuiTabs-root') || anchor;
            const parent = content.contains(anchor) ? anchor.parentElement : content;
            const candidates = content.contains(anchor) ? Array.from(parent.children).slice(Array.from(parent.children).indexOf(anchor) + 1) : Array.from(content.children);
            for (const node of candidates) {
                if (node.matches('[data-je-admin-user]') || node.contains(host) || node.matches('h1,.localnav')) continue;
                if (!hidden.has(node)) hidden.set(node, node.hidden);
                if (!node.hidden) node.hidden = true;
            }
            const indicator = host.closest('.MuiTabs-root')?.querySelector('.MuiTabs-indicator');
            if (indicator) {
                if (!indicators.has(indicator)) indicators.set(indicator, indicator.style.cssText);
                const tabRect = owned.getBoundingClientRect(), stripRect = host.getBoundingClientRect();
                const rtl = getComputedStyle(host).direction === 'rtl', side = rtl ? 'right' : 'left', opposite = rtl ? 'left' : 'right';
                const offset = (rtl ? stripRect.right - tabRect.right : tabRect.left - stripRect.left) + 'px', width = tabRect.width + 'px';
                if (indicator.style[opposite]) indicator.style[opposite] = '';
                if (indicator.style[side] !== offset) indicator.style[side] = offset;
                if (indicator.style.width !== width) indicator.style.width = width;
            }
            return parent;
        }
        window.addEventListener('resize', schedule);
        return { update, reset, dispose() { reset(); window.removeEventListener('resize', schedule); } };
    }
    JE.arrAdminUserTabs = { create, href };
})(window.JellyfinEnhanced);
