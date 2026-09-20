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

    // Containers with the mobile-drawer-auto-close listener already attached.
    const drawerAutoCloseContainers = new WeakSet();

    /**
     * Closes jellyfin-web's mobile nav drawer (SwipeableDrawer) if open, so
     * tapping a header icon doesn't leave it open behind the action. Scoped
     * below the `md` (900px) breakpoint since `.MuiDrawer-paper` at/above it
     * belongs to the unrelated permanent sidebar drawer.
     */
    function closeMobileDrawerIfOpen() {
        if (window.matchMedia('(min-width: 900px)').matches) return;
        const paper = document.querySelector('.MuiDrawer-paper');
        if (!paper) return;
        // A kept-mounted drawer can retain a positive right edge while hidden.
        // Check visibility as well as position before toggling its backdrop.
        if (getComputedStyle(paper).visibility === 'hidden' ||
            paper.closest('.MuiModal-hidden') || paper.getBoundingClientRect().right <= 0) return;
        // onOpen/onClose both just flip one boolean, so clicking the
        // backdrop (what a real outside click does) toggles it closed --
        // only safe because we've confirmed it's open above.
        paper.closest('.MuiModal-root')?.querySelector(':scope > .MuiBackdrop-root')?.click();
    }

    /**
     * Wires closeMobileDrawerIfOpen() into a header-icon container via a
     * capturing listener, so any button inside it closes the drawer first.
     * @param {HTMLElement|null} container
     */
    function attachDrawerAutoClose(container) {
        if (!container || drawerAutoCloseContainers.has(container)) return;
        drawerAutoCloseContainers.add(container);
        container.addEventListener('click', (event) => {
            // Launcher actions close their dialog before forwarding the action.
            // Do not toggle an unrelated drawer while forwarding that click.
            if (!event.target.closest('.je-header-overflowed')) closeMobileDrawerIfOpen();
        }, true);
    }

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
        if (legacy && legacy.offsetParent !== null) {
            attachDrawerAutoClose(legacy);
            return legacy;
        }

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
        // header-actions.js budgets this tray against the whole toolbar before
        // keeping the JE group inline when it fits beside Jellyfin's controls.
        if (buttonsTray) {
            attachDrawerAutoClose(buttonsTray);
            return buttonsTray;
        }

        // No user-menu available (e.g. public/video pages) - fall back to a
        // synthetic container appended to the toolbar itself.
        let container = toolbar.querySelector(':scope > .headerRight');
        if (!container) {
            container = document.createElement('div');
            container.className = 'headerRight';
            toolbar.appendChild(container);
        }
        attachDrawerAutoClose(container);
        return container;
    }

    /** Return the shared adaptive JE header actions tray. */
    function getHeaderButtonTray() {
        return JE.headerActions?.getTray() || null;
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
