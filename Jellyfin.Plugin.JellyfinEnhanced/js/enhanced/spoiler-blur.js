(function (JE) {
    'use strict';

    var logPrefix = '🪼 Jellyfin Enhanced [SpoilerBlur]:';

    // In-memory cache of series IDs the current user has spoiler mode enabled for.
    // Populated once on init from the server's spoilerblur.json. The image filter
    // runs on the server so cards that are already displayed will be re-fetched
    // on next navigation; this cache only drives the per-show toggle button UI.
    var enabledSeries = new Set();
    var loaded = false;

    /**
     * Normalize a series ID to "N" format (no dashes, lowercase).
     * Server stores keys this way for deterministic comparison.
     * @param {string} id
     * @returns {string}
     */
    function normalizeId(id) {
        if (!id) return '';
        return String(id).replace(/-/g, '').toLowerCase();
    }

    /**
     * Fetch the user's enabled-series list from the server.
     * @returns {Promise<void>}
     */
    function loadState() {
        return ApiClient.ajax({
            url: ApiClient.getUrl('JellyfinEnhanced/spoiler-blur/series'),
            type: 'GET',
            dataType: 'json',
        }).then(function (data) {
            enabledSeries.clear();
            if (data && data.Series) {
                Object.keys(data.Series).forEach(function (key) {
                    enabledSeries.add(normalizeId(key));
                });
            }
            loaded = true;
        }).catch(function (err) {
            console.warn(logPrefix, 'Failed to load spoiler-blur state:', err);
            loaded = true;
        });
    }

    /**
     * Returns true when the current user has spoiler mode enabled for this series.
     * @param {string} seriesId
     * @returns {boolean}
     */
    function isEnabledFor(seriesId) {
        return enabledSeries.has(normalizeId(seriesId));
    }

    /**
     * Enable spoiler mode for a series.
     * @param {string} seriesId
     * @returns {Promise<void>}
     */
    function enableForSeries(seriesId) {
        var normalized = normalizeId(seriesId);
        return ApiClient.ajax({
            url: ApiClient.getUrl('JellyfinEnhanced/spoiler-blur/series/' + encodeURIComponent(normalized)),
            type: 'POST',
            dataType: 'json',
        }).then(function () {
            enabledSeries.add(normalized);
        });
    }

    /**
     * Disable spoiler mode for a series.
     * @param {string} seriesId
     * @returns {Promise<void>}
     */
    function disableForSeries(seriesId) {
        var normalized = normalizeId(seriesId);
        return ApiClient.ajax({
            url: ApiClient.getUrl('JellyfinEnhanced/spoiler-blur/series/' + encodeURIComponent(normalized)),
            type: 'DELETE',
            dataType: 'json',
        }).then(function () {
            enabledSeries.delete(normalized);
        });
    }

    /**
     * Inserts a "Spoiler Mode" toggle button into a series detail page's
     * action button row. Idempotent: re-running on the same page reuses the
     * existing button and just refreshes its state.
     * @param {string} itemId Series ID.
     * @param {HTMLElement} visiblePage The visible #itemDetailPage element.
     */
    function addSpoilerBlurButton(itemId, visiblePage) {
        // Admin-level kill switch.
        if (!JE.pluginConfig || JE.pluginConfig.SpoilerBlurEnabled !== true) return;
        if (!itemId || !visiblePage) return;
        if (!loaded) return;

        var existing = visiblePage.querySelector('.je-spoiler-blur-btn');

        var selectors = [
            '.detailButtons',
            '.itemActionsBottom',
            '.mainDetailButtons',
            '.detailButtonsContainer',
        ];
        var container = null;
        for (var i = 0; i < selectors.length; i++) {
            var found = visiblePage.querySelector(selectors[i]);
            if (found) { container = found; break; }
        }
        if (!container) return;

        var enabled = isEnabledFor(itemId);
        var newState = enabled ? 'on' : 'off';

        if (!existing) {
            existing = document.createElement('button');
            existing.setAttribute('is', 'emby-button');
            existing.className = 'button-flat detailButton emby-button je-spoiler-blur-btn';
            existing.type = 'button';
            container.appendChild(existing);
            existing.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                onToggleClicked(existing, itemId);
            });
            existing.setAttribute('data-je-spoiler-state', newState);
            renderButton(existing, enabled);
            return;
        }

        // Idempotent: skip the DOM mutation when state hasn't changed.
        // Otherwise the body MutationObserver retriggers handleItemDetails
        // on every fired mutation, which re-enters this function and
        // re-renders, producing an unbounded loop. (See series-page network
        // spam reproduced via Playwright on 2026-05-06.)
        if (existing.getAttribute('data-je-spoiler-state') !== newState) {
            existing.setAttribute('data-je-spoiler-state', newState);
            renderButton(existing, enabled);
        }
    }

    /**
     * Render the button content + tooltip for the given enabled state.
     * @param {HTMLButtonElement} button
     * @param {boolean} enabled
     */
    function renderButton(button, enabled) {
        var label = enabled
            ? JE.t('spoiler_blur_button_on')
            : JE.t('spoiler_blur_button_off');

        button.classList.toggle('je-spoiler-blur-on', enabled);
        button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        button.title = label;
        button.setAttribute('aria-label', label);

        button.replaceChildren();
        var content = document.createElement('div');
        content.className = 'detailButton-content';

        var icon = document.createElement('span');
        icon.className = 'material-icons detailButton-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = enabled ? 'blur_on' : 'blur_off';
        content.appendChild(icon);

        var textSpan = document.createElement('span');
        textSpan.className = 'detailButton-icon-text';
        textSpan.textContent = label;
        content.appendChild(textSpan);

        button.appendChild(content);
    }

    /**
     * Click handler: flips spoiler mode for the series and refreshes the button.
     * Toasts on success/failure. We deliberately do NOT force a page reload —
     * users will see the blur next time they navigate to or refresh the show,
     * which is what Jellyfin's image cache requires anyway.
     * @param {HTMLButtonElement} button
     * @param {string} seriesId
     */
    function onToggleClicked(button, seriesId) {
        var willBeEnabled = !isEnabledFor(seriesId);
        button.disabled = true;
        var promise = willBeEnabled ? enableForSeries(seriesId) : disableForSeries(seriesId);
        promise.then(function () {
            renderButton(button, willBeEnabled);
            var msg = willBeEnabled
                ? JE.t('spoiler_blur_enabled_toast')
                : JE.t('spoiler_blur_disabled_toast');
            if (JE.toast) JE.toast(msg);
        }).catch(function (err) {
            console.error(logPrefix, 'Toggle failed:', err);
            if (JE.toast) JE.toast(JE.t('spoiler_blur_error_toast'));
        }).finally(function () {
            button.disabled = false;
        });
    }

    /**
     * Patches the SRC / backgroundImage setters globally so every image URL
     * that points at Jellyfin's /Items/{id}/Images/{type} endpoint gets an
     * `api_key=<accessToken>` query param appended. Without this, browser
     * <img> requests are anonymous (Jellyfin's image endpoint is public-
     * accessible by design) and the server-side spoiler-blur action filter
     * has no way to identify which user is requesting the image, so it can't
     * decide whether to blur. Adding api_key flips those requests into
     * authenticated ones and the filter starts firing.
     *
     * Idempotent — calling this twice is harmless.
     */
    function patchImageUrlsForAuth() {
        if (window.__je_spoilerBlurUrlPatchInstalled) return;
        window.__je_spoilerBlurUrlPatchInstalled = true;

        // Path-shape regex. Used as a cheap pre-filter before the costlier
        // origin check in safelyPatchUrl().
        var IMAGE_PATH_RE = /\/Items\/[a-f0-9-]+\/Images\//i;
        var HAS_KEY_RE = /[?&](api_key|ApiKey)=/i;

        // Capture the Jellyfin origin once at install time. Compared against
        // every candidate URL — H1: never append api_key to a non-Jellyfin
        // origin even if the path happens to match /Items/.../Images/.
        // Tolerates Jellyfin reverse-proxy mounts (BaseUrl) by letting any
        // path on the same origin through.
        var jfOrigin = (function () {
            try {
                if (typeof ApiClient !== 'undefined' && typeof ApiClient.serverAddress === 'function') {
                    var addr = ApiClient.serverAddress();
                    if (addr) return new URL(addr, location.href).origin;
                }
            } catch (e) {
                // R2-L1: surface — same-origin fallback might be wrong on a
                // BaseUrl-mounted reverse-proxy install.
                console.warn(logPrefix, 'ApiClient.serverAddress() failed; falling back to location.origin:', e);
            }
            return location.origin;
        })();

        function getToken() {
            try {
                if (typeof ApiClient !== 'undefined' && typeof ApiClient.accessToken === 'function') {
                    return ApiClient.accessToken() || '';
                }
            } catch (e) {
                // R2-L1: surface — without a token we won't append api_key
                // and the web client will see unblurred images.
                console.warn(logPrefix, 'ApiClient.accessToken() failed:', e);
            }
            return '';
        }

        // Returns true when the URL is for the same Jellyfin origin AND
        // matches the /Items/.../Images/ path shape AND doesn't already
        // carry api_key. Anchored on origin to prevent token leakage to
        // attacker-controlled hosts (security findings H1 + H3).
        function shouldPatchUrl(url) {
            if (typeof url !== 'string' || !url) return false;
            if (!IMAGE_PATH_RE.test(url)) return false;
            if (HAS_KEY_RE.test(url)) return false;
            try {
                var parsed = new URL(url, location.href);
                if (parsed.origin !== jfOrigin) return false;
            } catch (e) {
                return false;
            }
            return true;
        }

        function patchUrl(url) {
            if (!shouldPatchUrl(url)) return url;
            var token = getToken();
            if (!token) return url;
            return url + (url.indexOf('?') === -1 ? '?' : '&') + 'api_key=' + encodeURIComponent(token);
        }

        // Patch HTMLImageElement.src — covers <img> tags everywhere.
        var imgDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
        if (imgDesc && imgDesc.set) {
            Object.defineProperty(HTMLImageElement.prototype, 'src', {
                configurable: true,
                enumerable: imgDesc.enumerable,
                get: imgDesc.get,
                set: function (value) { return imgDesc.set.call(this, patchUrl(value)); },
            });
        }

        // CSS properties on CSSStyleDeclaration are NOT regular accessor
        // properties on the prototype — they're handled via WebIDL bindings
        // and `Object.getOwnPropertyDescriptor(prototype, 'backgroundImage')`
        // returns undefined in Chrome/Firefox. Patch `setProperty` (the
        // underlying API for CSS property writes) AND use a MutationObserver
        // on style-attribute changes as a backstop for `el.style.background-
        // Image = ...` writes that bypass setProperty.
        var origSetProp = CSSStyleDeclaration.prototype.setProperty;
        CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) {
            if (typeof value === 'string'
                && (name === 'background-image' || name === 'background')
                && value.indexOf('/Items/') !== -1) {
                value = value.replace(/url\((["']?)([^"')]+)\1\)/gi, function (m, q, u) {
                    return 'url(' + q + patchUrl(u) + q + ')';
                });
            }
            return origSetProp.call(this, name, value, priority);
        };

        // MutationObserver: when an element's style attribute changes and
        // contains an unpatched /Items/.../Images/ url(...), rewrite it.
        // Catches `el.style.backgroundImage = "url(...)"` (which goes through
        // a non-public WebIDL setter that we cannot intercept directly).
        function rewriteStyleBgIfNeeded(el) {
            try {
                var bg = el.style && el.style.backgroundImage;
                if (!bg || bg.indexOf('/Items/') === -1) return;
                var rewritten = bg.replace(/url\((["']?)([^"')]+)\1\)/gi, function (m, q, u) {
                    return 'url(' + q + patchUrl(u) + q + ')';
                });
                if (rewritten !== bg) {
                    // Use the original setter to bypass our setProperty patch
                    // so we don't double-process.
                    origSetProp.call(el.style, 'background-image', rewritten);
                }
            } catch (e) {
                // H5: surface failures so we don't silently fall back to
                // unblurred (which would mean every user sees every spoiler
                // with no console signal). Rate-limited per element so a
                // persistently-broken element doesn't spam the console.
                if (!el.__jeSpoilerWarned) {
                    el.__jeSpoilerWarned = true;
                    console.warn(logPrefix, 'rewriteStyleBgIfNeeded failed:', e, el);
                }
            }
        }

        // Initial pass over already-rendered cards.
        var existingCards = document.querySelectorAll('[style*="/Items/"]');
        for (var i = 0; i < existingCards.length; i++) rewriteStyleBgIfNeeded(existingCards[i]);

        var styleObserver = new MutationObserver(function (mutations) {
            for (var i = 0; i < mutations.length; i++) {
                var mut = mutations[i];
                if (mut.type === 'attributes' && mut.attributeName === 'style') {
                    rewriteStyleBgIfNeeded(mut.target);
                } else if (mut.type === 'childList') {
                    // New nodes may have inline style with unpatched URLs.
                    for (var j = 0; j < mut.addedNodes.length; j++) {
                        var node = mut.addedNodes[j];
                        if (node.nodeType !== 1) continue;
                        if (node.style) rewriteStyleBgIfNeeded(node);
                        // descendants
                        if (node.querySelectorAll) {
                            var descs = node.querySelectorAll('[style*="/Items/"]');
                            for (var k = 0; k < descs.length; k++) rewriteStyleBgIfNeeded(descs[k]);
                        }
                    }
                }
            }
        });
        styleObserver.observe(document.documentElement || document.body, {
            attributes: true,
            attributeFilter: ['style'],
            childList: true,
            subtree: true,
        });

        // Also rewrite static `src` / `style="background-image: ..."` attribute
        // setters (some code uses setAttribute/style.cssText, which bypasses
        // the property setters above). M4: early-out when the value can't
        // possibly be a Jellyfin image URL — runs on every setAttribute call
        // across the whole app, so the pre-filter matters.
        var origSetAttr = Element.prototype.setAttribute;
        Element.prototype.setAttribute = function (name, value) {
            if (typeof value === 'string') {
                if (this.tagName === 'IMG' && name === 'src') {
                    value = patchUrl(value);
                } else if (name === 'style' && value.indexOf('/Items/') !== -1) {
                    value = value.replace(/url\((["']?)([^"')]+)\1\)/gi, function (m, q, u) {
                        return 'url(' + q + patchUrl(u) + q + ')';
                    });
                }
            }
            return origSetAttr.call(this, name, value);
        };
    }

    // H2: when the URL patcher fails to install, the user gets unblurred
    // images silently. Surface the failure so they know something is wrong.
    var patcherFailed = false;

    /**
     * Module init. Loads server state, then exposes toggle APIs.
     */
    function init() {
        if (!JE.pluginConfig || JE.pluginConfig.SpoilerBlurEnabled !== true) return;
        // Install the URL patcher BEFORE loading state. We want any image
        // request that fires while we're still loading state to already be
        // authenticated; otherwise the filter sees `userId=null` and the
        // image is permanently cached as pass-through in the browser.
        try {
            patchImageUrlsForAuth();
        } catch (e) {
            patcherFailed = true;
            console.error(logPrefix, 'URL patcher install failed — web client will see unblurred images:', e);
            if (JE.toast) {
                JE.toast(JE.t('spoiler_blur_patcher_failed_toast'), 5000);
            }
        }
        loadState();
    }

    JE.spoilerBlur = {
        init: init,
        addSpoilerBlurButton: addSpoilerBlurButton,
        isEnabledFor: isEnabledFor,
        enableForSeries: enableForSeries,
        disableForSeries: disableForSeries,
        // Used by tests / management UI.
        getEnabledSet: function () { return new Set(enabledSeries); },
    };
})(window.JellyfinEnhanced);
