/**
 * @file Centralized helper utilities for Jellyfin Enhanced
 *
 * The navigation, DOM-observer and CSS/escaping primitives that used to live
 * here moved to js/core/ (navigation.js, dom-observer.js, ui-kit.js).
 * JE.helpers keeps thin aliases so unmigrated callers work unchanged; new
 * code should use JE.core.* directly.
 */
(function(JE) {
    'use strict';

    // Tracks whether the MUI-toolbar button-sizing CSS fix has been injected (see
    // getHeaderRightContainer below) so it's only added once.
    let muiHeaderButtonCSSInjected = false;

    // ── Admin check ──────────────────────────────────────────────────────────
    // Single source of truth for "is the current user an administrator?".
    // Sourced from JE.currentSettings.isAdmin, which the server computes fresh
    // from the authenticated caller on every settings.json GET and never
    // persists to the file (see GetUserSettingsSettings in
    // JellyfinEnhancedController.cs). This is a UX gate only: every admin-only
    // endpoint enforces access independently server-side.
    /**
     * @returns {boolean}
     */
    function isAdmin() {
        return JE.currentSettings?.isAdmin === true;
    }

    // Shared cache for item payloads to deduplicate cross-module ApiClient.getItem calls
    const itemCache = new Map();
    const ITEM_CACHE_TTL_MS = 30000; // 30s -- long enough for batch prefetch to warm cache before tag systems scan

    // Protected Seerr avatars require authenticated blob fetches because a
    // plain <img> cannot attach Jellyfin auth headers. Keep one shared cache
    // for the Requests page and Seerr More Info modal.
    const avatarObjectUrlCache = new Map();
    const avatarFetchPromises = new Map();

    function getAvatarAuthHeaders() {
        const token = ApiClient.accessToken ? ApiClient.accessToken() : '';
        return {
            'Authorization': 'MediaBrowser Token="' + token + '"',
            'X-MediaBrowser-Token': token,
        };
    }

    function isSafeAvatarUrl(url) {
        if (!url || typeof url !== 'string') return false;
        if (url.startsWith('/') || url.startsWith('blob:')) return true;

        try {
            const parsed = new URL(url, window.location.origin);
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return true;
            if (parsed.protocol === 'data:') return /^data:image\//i.test(url);
        } catch {
            return false;
        }
        return false;
    }

    async function resolveProtectedAvatarUrl(avatarUrl) {
        if (!isSafeAvatarUrl(avatarUrl)) return '';
        if (!avatarUrl.startsWith('/JellyfinEnhanced/proxy/avatar')) return avatarUrl;
        if (avatarObjectUrlCache.has(avatarUrl)) return avatarObjectUrlCache.get(avatarUrl);
        if (avatarFetchPromises.has(avatarUrl)) return avatarFetchPromises.get(avatarUrl);

        const fetchPromise = (async () => {
            try {
                const response = await fetch(ApiClient.getUrl(avatarUrl), { headers: getAvatarAuthHeaders() });
                if (!response.ok) return '';
                const objectUrl = URL.createObjectURL(await response.blob());
                avatarObjectUrlCache.set(avatarUrl, objectUrl);
                return objectUrl;
            } catch {
                return '';
            } finally {
                avatarFetchPromises.delete(avatarUrl);
            }
        })();

        avatarFetchPromises.set(avatarUrl, fetchPromise);
        return fetchPromise;
    }

    function hydrateAvatarImages(container) {
        const avatarImgs = container.querySelectorAll('img.je-request-avatar[data-avatar-src]');
        avatarImgs.forEach(async (img) => {
            const sourceUrl = img.getAttribute('data-avatar-src');
            if (!sourceUrl) {
                img.style.display = 'none';
                return;
            }

            const resolvedUrl = await resolveProtectedAvatarUrl(sourceUrl);
            if (!img.isConnected) return;
            if (!resolvedUrl || !isSafeAvatarUrl(resolvedUrl)) {
                img.style.display = 'none';
                return;
            }

            img.src = resolvedUrl;
            img.style.display = '';
        });
    }

    function clearAvatarObjectUrlCache(includeInFlight) {
        avatarObjectUrlCache.forEach((objectUrl) => URL.revokeObjectURL(objectUrl));
        avatarObjectUrlCache.clear();
        if (includeInFlight) avatarFetchPromises.clear();
    }

    // Item lookups are keyed `${userId}:${itemId}` so they can't collide
    // across users, but flush anyway on a switch (frees memory and drops
    // entries fetched with a token that is about to be revoked). Avatars are
    // the Seerr-linked user's own.
    JE.session?.onUserChange('helpers', () => {
        itemCache.clear();
        clearAvatarObjectUrlCache(true);
    });

    /**
     * Deduplicated item fetch with short TTL cache.
     * Prevents multiple modules from requesting the same item concurrently on detail page navigation.
     * @param {string} itemId
     * @param {Object} [options]
     * @param {string} [options.userId]
     * @param {number} [options.ttlMs]
     * @param {boolean} [options.forceRefresh]
     * @returns {Promise<object|null>}
     */
    async function getItemCached(itemId, options = {}) {
        if (!itemId) return null;

        const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : ITEM_CACHE_TTL_MS;
        const userId = options.userId || ApiClient.getCurrentUserId();
        const key = `${userId}:${itemId}`;
        const now = Date.now();
        const entry = itemCache.get(key);

        if (!options.forceRefresh && entry) {
            if (entry.promise) {
                return entry.promise;
            }
            if (entry.item && (now - entry.ts) < ttlMs) {
                return entry.item;
            }
        }

        const promise = ApiClient.getItem(userId, itemId)
            .then((item) => {
                itemCache.set(key, { item, ts: Date.now(), promise: null });
                return item;
            })
            .catch((err) => {
                itemCache.delete(key);
                throw err;
            });

        itemCache.set(key, { item: null, ts: now, promise });
        return promise;
    }


    /**
     * Debounce a function call
     * @param {Function} func - The function to debounce
     * @param {number} wait - Wait time in ms
     * @returns {Function}
     */
    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    /**
     * Throttle a function call
     * @param {Function} func - The function to throttle
     * @param {number} limit - Time limit in ms
     * @returns {Function}
     */
    function throttle(func, limit) {
        let inThrottle;
        return function(...args) {
            if (!inThrottle) {
                func.apply(this, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    }

    /**
     * Retry a function with exponential backoff
     * @param {Function} fn - The async function to retry
     * @param {number} maxAttempts - Maximum retry attempts (default: 5)
     * @param {number} baseDelay - Base delay in ms (default: 1000)
     * @returns {Promise<any>}
     */
    async function retry(fn, maxAttempts = 5, baseDelay = 1000) {
        let lastError;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;

                if (attempt === maxAttempts) {
                    console.error(`🪼 Jellyfin Enhanced: Failed after ${maxAttempts} attempts:`, error);
                    throw error;
                }

                const delay = baseDelay * Math.pow(2, attempt - 1);
                console.warn(`🪼 Jellyfin Enhanced: Attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms...`, error);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        throw lastError;
    }

    /**
     * Check if an element is visible in the viewport
     * @param {HTMLElement} element - The element to check
     * @returns {boolean}
     */
    function isElementVisible(element) {
        if (!element) return false;

        const rect = element.getBoundingClientRect();
        return (
            rect.top >= 0 &&
            rect.left >= 0 &&
            rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
            rect.right <= (window.innerWidth || document.documentElement.clientWidth)
        );
    }

    /**
     * Finds (or creates) the container plugin buttons should be injected into.
     *
     * Jellyfin 12's "experimental" layout (now the default) replaces the legacy
     * AngularJS header with a React/MUI AppBar+Toolbar. The legacy `.headerRight`
     * element is still present in the DOM for backwards compatibility, but it sits
     * inside a `display:none` wrapper, so injecting into it silently produces
     * invisible buttons. When that's detected, this reuses the toolbar's own
     * SyncPlay/RemotePlay/Search button tray (a `flexGrow:1; justifyContent:flex-end`
     * Box) as the container — it's the functional equivalent of `.headerRight`, and
     * injecting into it (rather than next to it) keeps plugin buttons right-aligned
     * with the native ones instead of stranding them as a separate flex item further
     * left in the toolbar.
     * @returns {HTMLElement|null} The container, or null if no header is ready yet.
     */
    function getHeaderRightContainer() {
        const legacy = document.querySelector('.headerRight');
        if (legacy && legacy.offsetParent !== null) return legacy;

        const userMenuButton = document.querySelector('[aria-controls="app-user-menu"]');
        const toolbar = userMenuButton?.closest('.MuiToolbar-root') || document.querySelector('.MuiAppBar-root .MuiToolbar-root');
        if (!toolbar) return null;

        // The legacy .headerButton/.paper-icon-button-light classes size themselves
        // with `em` units relative to the *inherited* font-size, which was tuned for
        // the old .skinHeader context. Inside the MUI toolbar the ambient font-size is
        // different, so the icons come out oversized/misaligned next to the native MUI
        // IconButtons. Pin them to MUI's own ~48px button / 24px icon convention instead.
        // !important is needed because some callers (e.g. active-streams.js) set their
        // own fixed-size CSS via an #id selector, which otherwise outranks this rule's
        // specificity regardless of declaration order.
        if (!muiHeaderButtonCSSInjected) {
            addCSS('je-mui-header-button-fix', `
                .MuiToolbar-root .headerButton.paper-icon-button-light {
                    display: inline-flex !important;
                    align-items: center !important;
                    justify-content: center !important;
                    box-sizing: border-box !important;
                    width: 48px !important;
                    height: 48px !important;
                    padding: 0 !important;
                    margin: 0 !important;
                    font-size: 16px !important;
                }
                .MuiToolbar-root .headerButton.paper-icon-button-light > .material-icons {
                    font-size: 24px !important;
                }
            `);
            muiHeaderButtonCSSInjected = true;
        }

        let userMenuBox = userMenuButton;
        while (userMenuBox && userMenuBox.parentElement !== toolbar) {
            userMenuBox = userMenuBox.parentElement;
        }
        const buttonsTray = userMenuBox?.previousElementSibling;
        if (buttonsTray) return buttonsTray;

        // No user-menu available (e.g. public/video pages) - fall back to a
        // synthetic container appended to the toolbar itself.
        let container = toolbar.querySelector(':scope > .headerRight');
        if (!container) {
            container = document.createElement('div');
            container.className = 'headerRight';
            toolbar.appendChild(container);
        }
        return container;
    }

    // Tracks whether the header-tray collapse CSS has been set up (see
    // getHeaderButtonTray below) so it's only added once.
    let headerTrayCSSInjected = false;

    /**
     * Finds (or creates) the container that JE's native-tabs fallback links
     * (Calendar/Requests/Recommendations/Hidden Content/Bookmarks) should be
     * injected into, instead of appending directly to getHeaderRightContainer().
     * Below a breakpoint they collapse behind a single "more" icon, styled as
     * a real native action sheet, instead of cramming the header row full of
     * icons on narrow viewports. Native Jellyfin buttons (search, cast, the
     * avatar) are untouched. The random button and active-streams icon
     * deliberately stay out of this tray (they use getHeaderRightContainer()
     * directly) and remain their own always-visible header icons.
     *
     * DOM mirrors the real native action sheet: .je-header-tray-dialog (gets
     * the native dialog/actionSheet classes) > .je-header-tray-content (gets
     * actionSheetContent) > .je-header-buttons-tray (gets actionSheetScroller;
     * this is what's returned, callers append into it exactly like they used
     * to with getHeaderRightContainer()). All three collapse to display:contents
     * on desktop so the tray behaves as a plain inline icon row with no wrapper
     * overhead; only while actually collapsed do the native classes get added,
     * so any active theme styles the dropdown automatically.
     *
     * Two things are deliberately still driven from JS as inline `!important`
     * styles rather than left to CSS/native classes:
     *  - Visibility (toggle/tray/wrapper display, dropdown position) -- has to
     *    win regardless of what a theme or the native (partly lazy-loaded,
     *    unverified) action-sheet CSS does for these same classes.
     *  - Row/icon sizing -- rows keep their original .headerButton.paper-icon-
     *    button-light classes underneath the native ones added here, so the
     *    MUI-toolbar sizing fix above (and any theme targeting that same
     *    selector, e.g. Jellyfish's 12_fixes.css) still forces a fixed 48x48
     *    square, 24px icon, zero padding, and centered content unless overridden.
     * @returns {HTMLElement|null} The tray to append buttons into, or null if the header isn't ready yet.
     */
    function getHeaderButtonTray() {
        const headerRight = getHeaderRightContainer();
        if (!headerRight) return null;

        if (!headerTrayCSSInjected) {
            addCSS('je-header-tray-css', `
                .je-header-buttons-group { position: relative; display: flex; align-items: center; }
                .je-header-tray-dialog { display: contents; }
                .je-header-tray-dialog.dialog {
                    display: block;
                    position: fixed !important;
                    z-index: 10000;
                }
                .je-header-tray-content { display: contents; }
                .je-header-tray-content.actionSheetContent { display: flex; }
                .je-header-buttons-tray { display: flex; align-items: center; }
                .je-header-buttons-tray.actionSheetScroller {
                    flex-direction: column;
                    align-items: stretch;
                    gap: 2px;
                    min-width: 190px;
                    max-width: calc(100vw - 24px);
                    max-height: 70vh;
                    overflow-y: auto;
                }
                /* native-tabs.js gives this group an inline row layout (order:-1)
                   for its original always-horizontal headerRight context; force
                   it to stack in the tray's column instead. */
                .je-header-buttons-tray.actionSheetScroller #je-native-tabs-group {
                    flex-direction: column !important;
                    align-items: stretch !important;
                }
                /* Its separator sets display via inline style, which beats a
                   plain CSS rule -- needs !important to actually hide it. */
                .je-header-buttons-tray.actionSheetScroller #je-native-tabs-separator { display: none !important; }
            `);
            headerTrayCSSInjected = true;
        }

        let group = headerRight.querySelector(':scope > #je-header-buttons-group');
        if (group) return group.querySelector('.je-header-buttons-tray');

        group = document.createElement('div');
        group.id = 'je-header-buttons-group';
        group.className = 'je-header-buttons-group';

        const dialogWrapper = document.createElement('div');
        dialogWrapper.className = 'je-header-tray-dialog';

        const content = document.createElement('div');
        content.className = 'je-header-tray-content';

        const tray = document.createElement('div');
        tray.className = 'je-header-buttons-tray';

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.setAttribute('is', 'paper-icon-button-light');
        toggle.className = 'headerButton headerButtonRight paper-icon-button-light je-header-more-toggle';
        toggle.title = 'More';
        toggle.innerHTML = '<i class="material-icons">more_vert</i>';

        // The MUI toolbar's own drawer-toggle button only exists in the DOM at
        // all below its internal breakpoint, so its presence is a more reliable
        // "are we narrow" signal than guessing a pixel breakpoint of our own.
        // The legacy layout's hamburger has no such guarantee (its visibility
        // is a page-type/settings toggle, not a viewport breakpoint), so that
        // case falls back to a plain width check.
        const isCollapsed = () => {
            if (document.querySelector('[aria-label="Open Menu"]')) return true;
            if (document.querySelector('.MuiAppBar-root .MuiToolbar-root')) return false;
            return window.matchMedia('(max-width: 760px)').matches;
        };
        let isOpen = false;

        // Restyles a JE header button (icon-only) to look like a real
        // actionSheetMenuItem row: native classes for theme-styled background/
        // hover/spacing, a visible label from the button's own tooltip text,
        // and inline overrides only for what the MUI-toolbar/theme fix still
        // forces via .headerButton.paper-icon-button-light (see doc comment
        // above) plus one native quirk: mobile action sheets scale listItemBody
        // via transform for large-font mode, which we don't have the matching
        // modifier class/layout for, so it's neutralized rather than left to
        // balloon the label over adjacent rows.
        const setRowCollapsedStyle = (row, collapsed) => {
            if (collapsed) {
                row.classList.add('listItem', 'listItem-button', 'actionSheetMenuItem', 'emby-button');
                const icon = row.querySelector(':scope > .material-icons');
                if (icon) {
                    icon.classList.add('actionsheetMenuItemIcon', 'listItemIcon', 'listItemIcon-transparent');
                    icon.style.setProperty('font-size', '1.3em', 'important');
                }

                let label = row.querySelector('.je-header-tray-label');
                if (!label) {
                    label = document.createElement('div');
                    label.className = 'je-header-tray-label listItemBody actionsheetListItemBody';
                    label.innerHTML = '<div class="listItemBodyText actionSheetItemText"></div>';
                    row.appendChild(label);
                    label.style.setProperty('transform', 'none', 'important');
                }
                // Only touch the text node when it actually changes -- this runs
                // from a MutationObserver watching this same subtree, and
                // .textContent = always creates a fresh text node (a childList
                // mutation) even when the string is unchanged, which would
                // re-trigger that observer forever otherwise.
                const textEl = label.querySelector('.actionSheetItemText');
                const desiredText = row.title || '';
                if (textEl.textContent !== desiredText) textEl.textContent = desiredText;

                row.style.setProperty('width', '100%', 'important');
                row.style.setProperty('height', 'auto', 'important');
                row.style.setProperty('box-sizing', 'border-box', 'important');
                row.style.setProperty('padding', '.25em .25em .25em .5em', 'important');
                row.style.setProperty('justify-content', 'flex-start', 'important');
                row.style.setProperty('font-size', '.93em', 'important');
            } else {
                row.classList.remove('listItem', 'listItem-button', 'actionSheetMenuItem', 'emby-button');
                const icon = row.querySelector(':scope > .material-icons');
                if (icon) {
                    icon.classList.remove('actionsheetMenuItemIcon', 'listItemIcon', 'listItemIcon-transparent');
                    icon.style.removeProperty('font-size');
                }
                row.querySelector('.je-header-tray-label')?.remove();
                ['width', 'height', 'box-sizing', 'padding', 'justify-content', 'font-size']
                    .forEach((prop) => row.style.removeProperty(prop));
            }
        };

        // Anchors the dropdown from the toggle's actual on-screen position,
        // clamped to the viewport -- the group's position *within the header
        // row* doesn't tell you where it lands on screen (it can sit well past
        // the left edge), so a fixed CSS anchor reliably overflows one side.
        const positionTray = () => {
            const rect = toggle.getBoundingClientRect();
            const trayWidth = Math.min(dialogWrapper.offsetWidth || 260, window.innerWidth - 24);
            let left = rect.right - trayWidth;
            left = Math.max(12, Math.min(left, window.innerWidth - trayWidth - 12));
            dialogWrapper.style.setProperty('top', (rect.bottom + 8) + 'px', 'important');
            dialogWrapper.style.setProperty('left', left + 'px', 'important');
        };

        // Classes the real native action-sheet wrapper carries, adopted
        // wholesale so any active theme's own styling applies automatically.
        const DIALOG_CLASSES = ['focuscontainer', 'dialog', 'actionsheet-not-fullscreen', 'actionSheet', 'centeredDialog'];

        const applyState = () => {
            const collapsed = isCollapsed();
            toggle.style.setProperty('display', collapsed ? 'inline-flex' : 'none', 'important');
            content.classList.toggle('actionSheetContent', collapsed);
            tray.classList.toggle('actionSheetScroller', collapsed);
            tray.classList.toggle('scrollY', collapsed);
            if (collapsed) {
                dialogWrapper.classList.add(...DIALOG_CLASSES);
                dialogWrapper.classList.toggle('opened', isOpen);
                dialogWrapper.style.setProperty('display', isOpen ? 'block' : 'none', 'important');
                if (isOpen) positionTray();
            } else {
                isOpen = false;
                dialogWrapper.classList.remove(...DIALOG_CLASSES, 'opened');
                dialogWrapper.style.removeProperty('display');
            }
            tray.querySelectorAll('.headerButton.paper-icon-button-light').forEach((row) => setRowCollapsedStyle(row, collapsed));
        };

        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            isOpen = !isOpen;
            applyState();
        });
        window.addEventListener('resize', debounce(applyState, 150));
        document.addEventListener('click', (e) => {
            if (isOpen && !group.contains(e.target)) {
                isOpen = false;
                applyState();
            }
        });
        // New buttons (native-tabs registers more tabs later) need the same
        // collapsed-row styling applied once they land, not just whatever was
        // present at open time.
        new MutationObserver(() => {
            if (isCollapsed()) {
                tray.querySelectorAll('.headerButton.paper-icon-button-light').forEach((row) => setRowCollapsedStyle(row, true));
            }
        }).observe(tray, { childList: true, subtree: true });

        applyState();

        content.appendChild(tray);
        dialogWrapper.appendChild(content);
        group.appendChild(dialogWrapper);
        group.appendChild(toggle);
        // Leftmost, ahead of the native SyncPlay/Cast/Search buttons -- matches
        // where native-tabs.js's group used to place itself (order:-1) before
        // this tray existed.
        headerRight.prepend(group);

        return tray;
    }

    /**
     * Finds the container plugin sidebar nav links should be injected into.
     *
     * The legacy `.mainDrawer-scrollContainer` is hidden the same way `.headerRight`
     * is under Jellyfin 12's experimental layout (both live inside the
     * `display:none`-wrapped legacy AppHeader). Unlike the header, there's no
     * always-present replacement: the new drawer (`AppDrawer`/`MainDrawerContent`,
     * a MUI `SwipeableDrawer`) is itself only ever rendered at all on narrow/mobile
     * viewports - desktop has no drawer in the new layout at all, nav lives inline
     * in the toolbar instead (see getHeaderRightContainer). So on desktop there is
     * no sidebar equivalent to fall back to; this returns null there, same as if
     * nothing existed yet, and callers' existing "wait and retry" logic covers it.
     * @returns {HTMLElement|null}
     */
    function getSidebarContainer() {
        const legacy = document.querySelector('.mainDrawer-scrollContainer');
        if (legacy && legacy.offsetParent !== null) return legacy;

        // The dashboard/settings pages render their own MUI drawer (admin nav),
        // which also matches `.MuiDrawer-paper` - there's nothing in the class
        // name that distinguishes it from the home/library drawer. Plugin nav
        // links belong in the home sidebar only, so bail out here rather than
        // injecting into the admin drawer.
        if (document.body.classList.contains('dashboardDocument')) {
            return null;
        }

        // MUI's global stable class for the drawer's sliding panel. `keepMounted`
        // on the SwipeableDrawer means this exists in the DOM even while closed.
        const muiDrawerPanel = document.querySelector('.MuiDrawer-paper');
        if (!muiDrawerPanel) return null;

        return muiDrawerPanel.querySelector('[role="presentation"]') || muiDrawerPanel;
    }

    /**
     * Wait for a condition to be true
     * @param {Function} condition - Function that returns boolean
     * @param {number} timeout - Maximum wait time in ms (default: 5000)
     * @param {number} interval - Check interval in ms (default: 100)
     * @returns {Promise<boolean>}
     */
    function waitForCondition(condition, timeout = 5000, interval = 100) {
        return new Promise((resolve) => {
            const startTime = Date.now();

            const checkCondition = () => {
                if (condition()) {
                    resolve(true);
                    return;
                }

                if (Date.now() - startTime >= timeout) {
                    console.warn('🪼 Jellyfin Enhanced: Timeout waiting for condition');
                    resolve(false);
                    return;
                }

                setTimeout(checkCondition, interval);
            };

            checkCondition();
        });
    }

    /**
     * Add custom CSS to the page (alias of JE.core.ui.injectCss).
     * @param {string} id - Unique ID for the style element
     * @param {string} css - The CSS content
     */
    function addCSS(id, css) {
        JE.core.ui.injectCss(id, css);
    }

    /**
     * Creates an external-link <a> that Jellyfin's native apps open in the system
     * browser (iOS SFSafariViewController, Android Custom Tabs) via `is="emby-linkbutton"`.
     *
     * Use this for every external URL in the plugin — one place, consistent behaviour.
     *
     * @param {string} url
     * @param {object} [options]
     * @param {string}   [options.text]       - Text content.
     * @param {string}   [options.title]      - Tooltip.
     * @param {string}   [options.className]  - CSS class(es).
     * @param {boolean}  [options.resetStyle] - Strip emby-button chrome for plain-link appearance.
     * @param {Function} [options.setup]      - Callback(el) for extra DOM work.
     * @returns {HTMLAnchorElement}
     */
    function createExternalLink(url, options = {}) {
        const a = document.createElement('a');
        // This attribute is what tells Jellyfin's native app shell to open the URL
        // in the system browser instead of the in-app WebView.
        a.setAttribute('is', 'emby-linkbutton');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        if (options.title)     a.title = options.title;
        if (options.className) a.className = options.className;
        if (options.text)      a.textContent = options.text;
        if (options.resetStyle) {
            // Strip the default emby-button chrome (padding, background, border-radius)
            // so the element renders as a plain unstyled link.
            a.style.cssText = 'padding:0;background:none;border-radius:0;min-width:0;';
        }
        if (typeof options.setup === 'function') options.setup(a);
        return a;
    }

    // Icon-only buttons we inject into .itemExternalLinks (Letterboxd, Seerr,
    // Radarr/Sonarr/Bazarr) need to match the height of Jellyfin's native
    // text-only IMDb/TMDB/Trakt buttons there — a fixed px/em guess only fits
    // one theme, so measure the real native button instead. Reads rendered
    // box height, not font-size/line-height: some themes give these buttons
    // an explicit height while zeroing out font-size/color on the label
    // itself (rendering it some other way), which would read as 0.
    const ownExternalLinkClasses = ['letterboxd-link', 'seerr-link', 'arr-link', 'arr-tag-link'];

    /**
     * Px content height Jellyfin's native external-link buttons (IMDb/TMDB/Trakt)
     * currently render at, so icon-only buttons in the same row can match it.
     * @param {number} [fallback=18] - px to use if no native button is found yet.
     * @returns {number}
     */
    function getExternalLinkIconSize(fallback = 18) {
        const container = document.querySelector('#itemDetailPage:not(.hide) .itemExternalLinks');
        if (!container) return fallback;
        const native = [...container.querySelectorAll('a')].find(a =>
            !ownExternalLinkClasses.some(cls => a.classList.contains(cls))
        );
        if (!native) return fallback;
        const rect = native.getBoundingClientRect();
        const cs = getComputedStyle(native);
        const verticalChrome = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
            + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
        const contentHeight = rect.height - (Number.isFinite(verticalChrome) ? verticalChrome : 0);
        return Number.isFinite(contentHeight) && contentHeight > 0 ? contentHeight : fallback;
    }

    /**
     * Bumps one opt-in usage-analytics counter (e.g. "seerr.request_submitted").
     * Fire-and-forget: no-ops client-side when analytics/usage-counts aren't
     * both enabled (avoiding a pointless network call from the majority of
     * installs, which have this off by default), and the server independently
     * no-ops the same way, so this is always safe to call unconditionally
     * from any feature module without checking config first.
     * @param {string} key - feature_key, e.g. "seerr.request_submitted".
     *   Server-side validated as ^[a-z0-9_.]{1,64}$ AND against the allowlist
     *   in UsageEventCounterService.KnownKeys -- a new key must be added there
     *   in the same change that starts emitting it, or the endpoint rejects it.
     */
    function trackUsage(key) {
        try {
            if (!JE.pluginConfig?.AnalyticsEnabled || !JE.pluginConfig?.AnalyticsShareUsageCounts) return;
            ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl('/JellyfinEnhanced/usage/track'),
                data: JSON.stringify({ key }),
                contentType: 'application/json'
            }).catch(() => { /* best-effort; never surface analytics failures */ });
        } catch { /* best-effort */ }
    }

    // Expose helpers. Entries marked (core) are thin aliases over JE.core.*
    // kept for the frozen JE.helpers contract — new code should call core
    // directly.
    JE.helpers = {
        onViewPage: (callback, options) => JE.core.navigation.onViewPage(callback, options), // (core)
        onNavigate: (callback) => JE.core.navigation.onNavigate(callback), // (core)
        getItemCached,
        getCurrentView: () => JE.core.navigation.getCurrentView(), // (core)
        createObserver: (id, callback, target, config) => JE.core.dom.createObserver(id, callback, target, config), // (core)
        onBodyMutation: (id, callback, options) => JE.core.dom.onBodyMutation(id, callback, options), // (core)
        removeBodySubscriber: (id) => JE.core.dom.removeBodySubscriber(id), // (core)
        disconnectObserver: (id) => JE.core.dom.disconnectObserver(id), // (core)
        disconnectAllObservers: () => JE.core.dom.disconnectAllObservers(), // (core)
        getHeaderRightContainer,
        getHeaderButtonTray,
        getSidebarContainer,
        waitForElement: (selector, timeout) => JE.core.dom.waitForElement(selector, timeout), // (core)
        waitForCondition,
        debounce,
        throttle,
        retry,
        isElementVisible,
        addCSS, // (core)
        removeCSS: (id) => JE.core.ui.removeCss(id), // (core)
        escHtml: (s) => JE.core.ui.escapeHtml(s), // (core)
        createExternalLink,
        getExternalLinkIconSize,
        isSafeAvatarUrl,
        resolveProtectedAvatarUrl,
        hydrateAvatarImages,
        clearAvatarObjectUrlCache,
        trackUsage,
        getHandlerCount: () => JE.core.navigation.getViewHandlerCount(), // (core)
        getObserverCount: () => JE.core.dom.getObserverCount(), // (core)
        getBodySubscriberCount: () => JE.core.dom.getBodySubscriberCount(), // (core)
        isAdmin
    };

    console.log('🪼 Jellyfin Enhanced: Helpers initialized successfully');

})(window.JellyfinEnhanced);
