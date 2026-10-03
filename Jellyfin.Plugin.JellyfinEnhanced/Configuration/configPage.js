/*
 * Jellyfin Enhanced admin settings page logic.
 *
 * This used to be an inline <script> at the end of configPage.html. It is now
 * served on its own by GET /JellyfinEnhanced/Configuration/configPage.js
 * (JellyfinEnhancedController.GetConfigPageScript, no-cache with a content
 * ETag) so the page HTML stays small and an unchanged script costs a 304.
 *
 * configPage.html's inline script, at the old inline script's position, loads
 * this file with a synchronous request and runs it as a classic global script
 * before returning, so it still runs while jellyfin-web inserts the page: the
 * markup is in the document, the page is not shown yet and its first pageshow
 * has not been dispatched, exactly as before.
 *
 * Setting controls must stay in configPage.html's markup: WhatsNewService
 * and scripts/generate_config_flag_groups.py read their ids and labels from
 * there, not from this file.
 */
        (() => {
            const pluginId = 'f69e946a-4b3c-4e9a-8f0a-8d7c1b2c4d9b';

            const page = document.querySelector('#JellyfinEnhancedPage');
            const form = document.querySelector('#JellyfinEnhancedForm');

            // Point every CDN-backed image on this page at the local plugin CDN route.
            // Images carry a data-je-cdn="<source>/<path>" attribute instead of a hardcoded
            // external src, so the browser never contacts an external CDN. jeCdnUrl is
            // defined in the head <script> above and is base-path-safe.
            try {
                document.querySelectorAll('img[data-je-cdn]').forEach((img) => {
                    img.src = jeCdnUrl(img.getAttribute('data-je-cdn'));
                });
            } catch (e) {
                console.warn('[JE] Failed to rewrite CDN image sources', e);
            }

            // Theme detector: Jellyfin's themes hard-swap theme.css (no CSS
            // variable contract) so we infer dark vs. light from the computed
            // background-color of <html>. Dark themes return something like
            // rgb(16,16,16) (sum ~48); the Light theme returns rgb(242,242,242)
            // (sum 726). Threshold at 450 bins every shipped theme correctly.
            // We also re-run on `load` in case the theme sheet hadn't applied
            // by the time our initial check ran, and once more after ~600 ms
            // to catch late Jellyfin theme swaps during dashboard navigation.
            function _jeDetectTheme() {
                if (!page) return;
                // Wrap the read in try/catch — during SPA detach getComputedStyle
                // can throw InvalidAccessError. If anything goes wrong we fall
                // back to dark (matches the plugin's previous default) so the
                // rest of the IIFE's listener wiring isn't aborted by a throw
                // from this purely cosmetic detector.
                try {
                    var bg = getComputedStyle(document.documentElement).backgroundColor;
                    var m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
                    if (!m) {
                        // Named colors (`black`), `transparent`, or `initial`: can't
                        // tell light vs. dark reliably. Log once so a future broken
                        // theme is diagnosable rather than silently dark.
                        console.warn('[JE] theme detector: document background is unparseable (' + bg + '); defaulting to dark');
                        page.classList.remove('je-light-theme');
                        page.classList.add('je-dark-theme');
                        return;
                    }
                    var sum = (+m[1]) + (+m[2]) + (+m[3]);
                    var isLight = sum > 450;
                    page.classList.toggle('je-light-theme', isLight);
                    page.classList.toggle('je-dark-theme',  !isLight);
                } catch (e) {
                    console.warn('[JE] theme detection failed, defaulting to dark:', e);
                    page.classList.remove('je-light-theme');
                    page.classList.add('je-dark-theme');
                }
            }
            _jeDetectTheme();
            window.addEventListener('load', _jeDetectTheme);
            setTimeout(_jeDetectTheme, 600);
            const resetAllUserSettingsBtn = document.querySelector('#resetAllUserSettingsBtn');
            const clearTagsCacheBtn = document.querySelector('#clearTagsCacheBtn');

            const shortcutListContainer = document.getElementById('shortcut-list-container');
            const addShortcutSelect = document.getElementById('add-shortcut-select');
            const addShortcutKeyInput = document.getElementById('add-shortcut-key');
            const addShortcutBtn = document.getElementById('add-shortcut-btn');
            const disableShortcutBtn = document.getElementById('disable-shortcut-btn');
            const shortcutErrorComment = document.getElementById('shortcut-error-comment');

            const testJellyseerrBtn = document.getElementById('testJellyseerrBtn');
            const jellyseerrStatusIndicator = document.getElementById('jellyseerrStatusIndicator');

            const tmdbStatusIndicator = document.getElementById('tmdbStatusIndicator');

            let shortcutOverrides = [];

            const tabs = document.querySelectorAll('.jellyfin-tab-button');
            const tabContents = document.querySelectorAll('.jellyfin-tab-content');

            // Drag-to-scroll on the tab bar so mouse users can pan the tab strip
            // the same way touch users do on mobile (the overflow-x auto strip
            // has no visible scrollbar). Threshold at 5 px before we consider it
            // a drag, so a normal click through to a tab still registers.
            (function wireTabBarDrag() {
                const bar = document.querySelector('.je-tab-bar');
                if (!bar) return;
                let isDown = false;
                let startX = 0;
                let startScroll = 0;
                let dragged = false;

                // Edge fade: signals there are more tabs to scroll to, since the strip's scrollbar is hidden.
                function updateScrollFade() {
                    const maxScroll = bar.scrollWidth - bar.clientWidth;
                    bar.classList.toggle('je-scroll-fade-left', bar.scrollLeft > 1);
                    bar.classList.toggle('je-scroll-fade-right', bar.scrollLeft < maxScroll - 1);
                }
                bar.addEventListener('scroll', updateScrollFade, { passive: true });
                window.addEventListener('resize', updateScrollFade);
                updateScrollFade();
                setTimeout(updateScrollFade, 300); // re-verify after late-loading fonts/icons can change scrollWidth

                bar.addEventListener('mousedown', (e) => {
                    if (e.button !== 0) return;
                    isDown = true;
                    dragged = false;
                    startX = e.pageX;
                    startScroll = bar.scrollLeft;
                });
                bar.addEventListener('mousemove', (e) => {
                    if (!isDown) return;
                    const dx = e.pageX - startX;
                    if (!dragged && Math.abs(dx) > 5) {
                        dragged = true;
                        bar.classList.add('je-dragging');
                    }
                    if (dragged) {
                        bar.scrollLeft = startScroll - dx;
                        e.preventDefault();
                    }
                });
                const end = () => {
                    if (!isDown) return;
                    isDown = false;
                    // Keep `dragged` set briefly so the synthesized click that
                    // follows a drag-end can be suppressed by the capture-phase
                    // click listener below. Cleared on next mousedown.
                    bar.classList.remove('je-dragging');
                };
                bar.addEventListener('mouseup', end);
                bar.addEventListener('mouseleave', end);

                // Capture-phase click listener cancels the click that mouseup
                // would otherwise fire on the tab button at the cursor's final
                // position — prevents accidental tab activation at drag-end.
                bar.addEventListener('click', (e) => {
                    if (dragged) {
                        e.preventDefault();
                        e.stopPropagation();
                        dragged = false;
                    }
                }, true);
            })();

            // Docs iframe URL — kept in JS rather than hardcoded in the
            // <iframe src> attribute so we can lazy-load on first Docs
            // activation (saves the GitHub Pages fetch for admins who
            // never open this tab).
            const DOCS_URL = 'https://n00bcodr.github.io/Jellyfin-Enhanced/';

            // Per-tab scroll memory. When the admin switches tabs we save the
            // current scrollY under the outgoing tab's id, and when they come
            // back to a tab we restore whatever they were reading. Defaults to
            // scroll-to-top on first visit to a tab so the Overview / long
            // sections always start at the tab's own header.
            const _jeTabScroll = Object.create(null);
            let _jePrevTabId = null;
            function _jeGetScrollTop() {
                return window.scrollY
                    || document.documentElement.scrollTop
                    || document.body.scrollTop
                    || 0;
            }
            function _jeSetScrollTop(y) {
                try { window.scrollTo({ top: y, behavior: 'instant' }); }
                catch (e) {
                    // Old Safari missing behavior:'instant' or iframe contexts.
                    window.scrollTo(0, y);
                }
            }

            function activateTab(tabId) {
                if (_jePrevTabId && _jePrevTabId !== tabId) {
                    _jeTabScroll[_jePrevTabId] = _jeGetScrollTop();
                }
                tabs.forEach(t => {
                    const isActive = t.dataset.tab === tabId;
                    if (isActive) {
                        t.classList.add('active');
                        // Override with the live accent color — CSS fallback covers initial render
                        t.style.color = 'var(--primary-accent-color, #fff)';
                        t.style.borderBottomColor = 'var(--primary-accent-color, #fff)';
                    } else {
                        t.classList.remove('active');
                        t.style.color = '';
                        t.style.borderBottomColor = '';
                    }
                });
                tabContents.forEach(content => {
                    const isActive = content.id === tabId;
                    content.classList.toggle('active', isActive);
                });
                // Restore (or reset) the scroll position after the new tab's
                // content is in the DOM. rAF waits for the layout pass so the
                // saved scrollY actually addresses the right document height.
                // NOTE: load-bearing for the service-status card deep-link at
                // renderServiceStatusDashboard (scrollTo handler uses a
                // double-rAF to run after this restore). If this rAF goes
                // away or gains an extra frame, update that handler to match.
                const saved = _jeTabScroll[tabId];
                requestAnimationFrame(() => _jeSetScrollTop(saved || 0));
                _jePrevTabId = tabId;
                // Lazy-load the Docs iframe the first time the user opens
                // the Docs tab. Using `about:blank` as the initial src
                // prevents the GitHub Pages fetch for admins who never
                // click into it. We set the real src once and never
                // reset it, so subsequent tab switches re-reveal the
                // already-loaded page (keeps the admin's scroll position
                // and any in-page nav state).
                if (tabId === 'docs') {
                    try {
                        var f = document.getElementById('docsFrame');
                        if (f && (!f.src || f.src === 'about:blank' || /about:blank/.test(f.src))) {
                            // Set up a load-timeout fallback before assigning src so
                            // a silently-blank iframe (DNS/CSP/X-Frame-Options/CDN
                            // outage) becomes a visible "couldn't load — open in
                            // new tab" message instead of an empty gray box.
                            var loaded = false;
                            f.addEventListener('load', function onLoad() {
                                loaded = true;
                                f.removeEventListener('load', onLoad);
                            });
                            setTimeout(function() {
                                if (loaded) return;
                                var parent = f.parentNode;
                                if (!parent) return;
                                var fb = document.createElement('div');
                                fb.className = 'je-docs-fallback';
                                fb.style.cssText = 'padding: 24px; text-align: center; color: #ccc; font-size: 0.95em;';
                                var msg = document.createElement('div');
                                msg.textContent = "Couldn't load the embedded documentation. Open it in a new tab instead:";
                                msg.style.marginBottom = '12px';
                                var link = document.createElement('a');
                                link.href = DOCS_URL;
                                link.target = '_blank';
                                link.rel = 'noopener';
                                link.textContent = DOCS_URL;
                                link.style.color = 'var(--primary-accent-color, #00a4dc)';
                                fb.appendChild(msg);
                                fb.appendChild(link);
                                parent.replaceChild(fb, f);
                            }, 8000);
                            f.src = DOCS_URL;
                        }
                    } catch (e) {
                        console.warn('[JE] docs iframe lazy-load failed:', e);
                    }
                }
            }

            tabs.forEach(tab => {
                tab.addEventListener('click', () => {
                    const tabId = tab.dataset.tab;
                    activateTab(tabId);
                    // Store active tab in sessionStorage to persist across refreshes
                    try {
                        sessionStorage.setItem('jellyfinEnhancedActiveTab', tabId);
                    } catch (e) {
                        // Ignore if sessionStorage is not available
                    }
                });
            });

            // In-tab section quick-nav: a pill row built from each tab's own <legend> text, for tabs with many fieldsets.
            (function buildSectionNavs() {
                const MIN_SECTIONS = 4;
                tabContents.forEach(tabContent => {
                    const fieldsets = Array.from(tabContent.querySelectorAll(':scope > fieldset'))
                        .filter(fs => fs.querySelector(':scope > legend.sectionTitle'));
                    if (fieldsets.length < MIN_SECTIONS) return;

                    const nav = document.createElement('div');
                    nav.className = 'je-section-nav';
                    fieldsets.forEach((fieldset, i) => {
                        const legend = fieldset.querySelector(':scope > legend.sectionTitle');
                        const clone = legend.cloneNode(true);
                        clone.querySelectorAll('i.material-icons, img').forEach(el => el.remove());
                        const label = clone.textContent.trim();
                        if (!label) return;
                        if (!fieldset.id) fieldset.id = tabContent.id + '-section-' + i;

                        const chip = document.createElement('button');
                        chip.type = 'button';
                        chip.className = 'je-section-nav-chip';
                        chip.textContent = label;
                        chip.addEventListener('click', () => {
                            jeScrollFieldsetIntoView(fieldset);
                            fieldset.classList.add('je-jump-flash-nav');
                            setTimeout(() => fieldset.classList.remove('je-jump-flash-nav'), 3000);
                        });
                        nav.appendChild(chip);
                    });
                    if (nav.children.length < 2) return;

                    // Land after the tab's own intro banner when present, otherwise at the top.
                    const intro = tabContent.querySelector(':scope > .je-info-banner');
                    if (intro) {
                        intro.insertAdjacentElement('afterend', nav);
                    } else {
                        tabContent.insertBefore(nav, tabContent.firstChild);
                    }
                });
            })();

            /** Scrolls a fieldset's top just below .je-sticky-header (sticky title/search/tab bar). */
            function jeScrollFieldsetIntoView(fieldset) {
                const headerEl = document.querySelector('.je-sticky-header');
                const offset = (headerEl ? headerEl.offsetHeight : 0) + 12;
                const targetY = window.scrollY + fieldset.getBoundingClientRect().top - offset;
                window.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
            }

            /** Flash the rounded card wrapping a control, not the bare control itself. */
            function jeResolveFlashTarget(rawEl) {
                return (rawEl && rawEl.tagName !== 'FIELDSET')
                    ? (rawEl.closest('.checkboxContainer, .inputContainer, .selectContainer') || rawEl)
                    : rawEl;
            }

            function jeFlashElement(el) {
                el.classList.add('je-jump-flash');
                setTimeout(() => el.classList.remove('je-jump-flash'), 3000);
            }

            /** Switches to tabId, scrolls to selector, and flashes it plus every element in extraSelectors. */
            function jeJumpToTab(tabId, selector, extraSelectors) {
                const tabBtn = document.querySelector('.jellyfin-tab-button[data-tab="' + tabId + '"]');
                if (tabBtn) tabBtn.click();
                if (!selector) return;
                // Double rAF: lands after activateTab's own scroll-memory restore.
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        // Open any collapsed expander hiding a target so it can be scrolled to and flashed.
                        const openAncestors = (el) => {
                            for (let d = el && el.closest('details'); d; d = d.parentElement.closest('details')) d.open = true;
                        };
                        const rawTarget = document.querySelector(selector);
                        openAncestors(rawTarget);
                        const target = jeResolveFlashTarget(rawTarget);
                        if (target) {
                            if (target.tagName === 'FIELDSET') {
                                jeScrollFieldsetIntoView(target);
                            } else {
                                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }
                            jeFlashElement(target);
                        } else {
                            console.warn('[JE] jeJumpToTab: target not found:', selector);
                        }
                        (extraSelectors || []).forEach((extraSelector) => {
                            if (extraSelector === selector) return;
                            const rawExtra = document.querySelector(extraSelector);
                            openAncestors(rawExtra);
                            const extraTarget = jeResolveFlashTarget(rawExtra);
                            if (extraTarget && extraTarget !== target) jeFlashElement(extraTarget);
                        });
                    });
                });
            }

            // Cross-tab "jump to X" links inside banners, delegated so future ones need no extra wiring.
            form.addEventListener('click', (e) => {
                const link = e.target.closest('.je-jump-link');
                if (!link) return;
                e.preventDefault();
                jeJumpToTab(link.dataset.jumpTab, link.dataset.jumpTarget);
            });

            // Map legacy tab IDs (pre-redesign) to the closest new tab, so users with
            // a saved sessionStorage value from the old layout don't land on a missing tab.
            const LEGACY_TAB_MAP = {
                'enhanced': 'display',
                'jellyseerr': 'seerr',
                'arr-links': 'arr'
            };

            // Restore tab from sessionStorage on page load
            try {
                let savedTab = sessionStorage.getItem('jellyfinEnhancedActiveTab');
                if (savedTab && LEGACY_TAB_MAP[savedTab]) {
                    savedTab = LEGACY_TAB_MAP[savedTab];
                    sessionStorage.setItem('jellyfinEnhancedActiveTab', savedTab);
                }
                if (savedTab && document.getElementById(savedTab)) {
                    activateTab(savedTab);
                } else if (savedTab) {
                    // Saved tab doesn't match any current tab and isn't a legacy key —
                    // probably a tab that was later renamed or a stray value. Clear it
                    // so the user stops silently getting ignored on every page load.
                    console.info('[JE] discarding unknown saved tab: ' + savedTab);
                    sessionStorage.removeItem('jellyfinEnhancedActiveTab');
                }
            } catch (e) {
                // sessionStorage unavailable (private mode / quota / security) — skip restore.
            }

            // === Setting-description visibility toggle ===
            // Some admins want the full explanatory text under every setting;
            // others (who know the plugin) want a compact page. Persist the
            // preference in localStorage, default visible, expose a header
            // button to flip state. Visibility is driven by CSS on the body
            // class — toggling is instant and costs nothing per render.
            const descToggleBtn = document.getElementById('toggleDescriptionsBtn');
            const DESC_PREF_KEY = 'je-settings-descriptions-visible';
            function applyDescriptionVisibility(show) {
                try { document.body.classList.toggle('je-hide-descriptions', !show); } catch (e) {}
                if (descToggleBtn) {
                    descToggleBtn.setAttribute('aria-pressed', show ? 'true' : 'false');
                    descToggleBtn.classList.toggle('je-desc-toggle-off', !show);
                    const state = descToggleBtn.querySelector('.je-desc-toggle-state');
                    if (state) state.textContent = show ? 'On' : 'Off';
                }
            }
            (function initDescriptionVisibility() {
                let show = true;
                try {
                    const stored = localStorage.getItem(DESC_PREF_KEY);
                    if (stored === 'false') show = false;
                } catch (e) { /* private mode / quota — default visible */ }
                applyDescriptionVisibility(show);
            })();
            if (descToggleBtn) {
                descToggleBtn.addEventListener('click', function() {
                    const currentlyShown = !document.body.classList.contains('je-hide-descriptions');
                    const nextShown = !currentlyShown;
                    applyDescriptionVisibility(nextShown);
                    try { localStorage.setItem(DESC_PREF_KEY, nextShown ? 'true' : 'false'); }
                    catch (e) { /* private mode / quota — preference won't persist, UI still toggles */ }
                });
            }

            // === Settings Search ===
            const searchInput = document.getElementById('settingsSearchInput');
            const searchClear = document.getElementById('settingsSearchClear');
            const searchCount = document.getElementById('settingsSearchCount');

            const tabButtonsContainer = tabs[0] ? tabs[0].parentElement : null;
            let isSearchMode = false;
            const savedDetailsStates = new Map();
            const SKIP_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'SCRIPT', 'STYLE']);
            let currentMatchIdx = -1;
            let allMatches = [];

            let searchDebounce;
            searchInput.addEventListener('input', () => {
                clearTimeout(searchDebounce);
                searchDebounce = setTimeout(() => performSearch(searchInput.value), 150);
            });

            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    clearTimeout(searchDebounce);  // kill the debounce so a stale non-empty query can't re-enter search mode after we exit
                    searchInput.value = '';
                    performSearch('');
                    searchInput.blur();
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    if (allMatches.length > 0) {
                        goToMatch(currentMatchIdx + (e.shiftKey ? -1 : 1));
                    }
                }
            });

            searchClear.addEventListener('click', () => {
                clearTimeout(searchDebounce);  // kill the debounce — see Escape handler
                searchInput.value = '';
                performSearch('');
                searchInput.focus();
            });



            /**
             * Collects searchable text from an element, including IDs, names, and data attributes.
             * @param {HTMLElement} element - The DOM element to extract text from
             * @returns {string} Lowercase concatenation of text content and attribute values
             */
            function getSearchableText(element) {
                var text = element.textContent.toLowerCase();
                element.querySelectorAll('[id], [name], [data-text], [data-icon]').forEach(function(el) {
                    if (el.id) text += ' ' + el.id.toLowerCase();
                    if (el.name) text += ' ' + el.name.toLowerCase();
                    if (el.dataset.text) text += ' ' + el.dataset.text.toLowerCase();
                    if (el.dataset.icon) text += ' ' + el.dataset.icon.toLowerCase();
                });
                return text;
            }

            /**
             * Removes all search highlight marks and restores original text nodes.
             */
            function clearHighlights() {
                form.querySelectorAll('.je-search-match').forEach(mark => {
                    const parent = mark.parentNode;
                    parent.replaceChild(document.createTextNode(mark.textContent), mark);
                    parent.normalize();
                });
                // Unwrap the flex/grid protection spans added by
                // highlightTextIn. After the marks above were unwrapped,
                // the wrapper contains only text nodes — move them up to
                // the parent and drop the wrapper, so normalize() can
                // merge back into a single text node identical to before
                // the search.
                form.querySelectorAll('.je-search-wrap').forEach(wrap => {
                    const parent = wrap.parentNode;
                    while (wrap.firstChild) parent.insertBefore(wrap.firstChild, wrap);
                    parent.removeChild(wrap);
                    parent.normalize();
                });
                allMatches = [];
                currentMatchIdx = -1;
            }

            /**
             * Walks text nodes in an element and wraps query matches in highlight mark elements.
             * @param {HTMLElement} element - The container to search within
             * @param {string} query - Lowercase search term to highlight
             */
            function highlightTextIn(element, query) {
                const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
                    acceptNode: function(node) {
                        if (SKIP_TAGS.has(node.parentElement.tagName)) return NodeFilter.FILTER_REJECT;
                        if (node.parentElement.closest('.je-search-match, .je-search-tab-label, .dep-hint-text, .dep-required-icon, .je-dep-banner, [class*="parent-hint-"]'))
                            return NodeFilter.FILTER_REJECT;
                        return NodeFilter.FILTER_ACCEPT;
                    }
                });
                var textNodes = [];
                while (walker.nextNode()) textNodes.push(walker.currentNode);

                // Per-parent display cache. getComputedStyle forces style
                // recomputation and — called naively once per text node during
                // a big search — caused the settings search to feel
                // extremely laggy on every keystroke. Most matches in a
                // fieldset share a parent (e.g., all text nodes inside one
                // .fieldDescription), so a WeakMap keyed on the parent
                // element cuts the call count to one per distinct parent.
                var parentDisplayCache = new WeakMap();
                function isFlexOrGridParent(parent) {
                    if (parentDisplayCache.has(parent)) return parentDisplayCache.get(parent);
                    var d = getComputedStyle(parent).display;
                    var flex = /(flex|grid)$/.test(d);
                    parentDisplayCache.set(parent, flex);
                    return flex;
                }

                textNodes.forEach(function(node) {
                    var text = node.textContent;
                    var lower = text.toLowerCase();
                    if (!lower.includes(query)) return;

                    var frag = document.createDocumentFragment();
                    var last = 0;
                    var idx;
                    while ((idx = lower.indexOf(query, last)) !== -1) {
                        if (idx > last) frag.appendChild(document.createTextNode(text.substring(last, idx)));
                        var mark = document.createElement('mark');
                        mark.className = 'je-search-match';
                        mark.textContent = text.substring(idx, idx + query.length);
                        frag.appendChild(mark);
                        last = idx + query.length;
                    }
                    if (last < text.length) frag.appendChild(document.createTextNode(text.substring(last)));

                    // If the text node lives directly inside a flex/grid
                    // container, splitting it into mark + remainder nodes
                    // creates multiple flex/grid items. Those items then
                    // get repositioned by justify-content / align-items on
                    // the parent — e.g. a <summary> with space-between
                    // would spread the <mark> to the start and the
                    // trailing text to the end, splitting "Auto Season
                    // Requests" into "Auto Sea" . "son Requests" on a
                    // search for "auto sea". Wrap in an inline span so
                    // the parent still sees a single child.
                    //
                    // Order the checks cheap-first: childNodes.length is
                    // an O(1) lookup with no style side-effects, while
                    // isFlexOrGridParent triggers getComputedStyle on a
                    // cache miss. If the fragment has only one child
                    // (the whole text matched exactly), no splitting
                    // happens and we can skip the style check entirely.
                    var parent = node.parentNode;
                    if (frag.childNodes.length > 1 && isFlexOrGridParent(parent)) {
                        var wrapper = document.createElement('span');
                        wrapper.className = 'je-search-wrap';
                        wrapper.appendChild(frag);
                        parent.replaceChild(wrapper, node);
                    } else {
                        parent.replaceChild(frag, node);
                    }
                });
            }

            /**
             * Navigates to a specific search match by index and scrolls it into view.
             * @param {number} index - Zero-based index of the match to navigate to
             */
            function goToMatch(index) {
                if (allMatches.length === 0) return;
                if (currentMatchIdx >= 0 && currentMatchIdx < allMatches.length) {
                    allMatches[currentMatchIdx].classList.remove('je-search-match-active');
                }
                if (index >= allMatches.length) index = 0;
                if (index < 0) index = allMatches.length - 1;
                currentMatchIdx = index;
                allMatches[currentMatchIdx].classList.add('je-search-match-active');
                allMatches[currentMatchIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
                searchCount.textContent = (currentMatchIdx + 1) + ' of ' + allMatches.length;
            }

            /**
             * Enters search mode: saves detail open/closed states, hides tab buttons, and adds tab labels.
             */
            function enterSearchMode() {
                if (isSearchMode) return;
                isSearchMode = true;
                form.classList.add('je-search-mode');
                form.querySelectorAll('details').forEach(d => {
                    savedDetailsStates.set(d, d.open);
                });
                if (tabButtonsContainer) tabButtonsContainer.style.display = 'none';
                tabContents.forEach(tc => {
                    const btn = document.querySelector('.jellyfin-tab-button[data-tab="' + tc.id + '"]');
                    // btn.textContent would include Material Icons font
                    // ligature names ("dashboard", "view_list", …) which
                    // render as glyphs but read as raw strings in
                    // textContent. That leaked into tab headers like
                    // "dashboardOverview" / "view_listPages". Clone the
                    // button, strip out the icon elements, then read.
                    let label = tc.id;
                    if (btn) {
                        const clone = btn.cloneNode(true);
                        clone.querySelectorAll('i.material-icons, img').forEach(el => el.remove());
                        label = clone.textContent.trim() || tc.id;
                    }
                    const labelEl = document.createElement('div');
                    labelEl.className = 'je-search-tab-label';
                    labelEl.textContent = label;
                    tc.insertBefore(labelEl, tc.firstChild);
                });
            }

            /**
             * Exits search mode: restores tab visibility, detail states, and clears highlights.
             */
            function exitSearchMode() {
                isSearchMode = false;
                form.classList.remove('je-search-mode');
                form.querySelectorAll('.je-tab-name-match').forEach(tc => tc.classList.remove('je-tab-name-match'));
                clearHighlights();
                form.querySelectorAll('.je-search-tab-label').forEach(el => el.remove());
                if (tabButtonsContainer) tabButtonsContainer.style.display = '';
                // Clear inline display from every tab content. performSearch sets
                // `style.display = 'block'|'none'` per tab; without this reset the
                // inline value wins over `.jellyfin-tab-content.active { display: grid }`,
                // collapsing matched tabs to single-column or hiding tabs that had no
                // match the next time the user clicks them. The .active class alone
                // owns visibility outside of search mode.
                form.querySelectorAll('.jellyfin-tab-content').forEach(tc => { tc.style.display = ''; });
                form.querySelectorAll('.je-search-hidden').forEach(el => el.classList.remove('je-search-hidden'));
                form.querySelectorAll('details').forEach(d => {
                    if (savedDetailsStates.has(d)) d.open = savedDetailsStates.get(d);
                });
                savedDetailsStates.clear();
                let savedTab = 'overview';
                try {
                    savedTab = sessionStorage.getItem('jellyfinEnhancedActiveTab') || 'overview';
                    if (LEGACY_TAB_MAP[savedTab]) savedTab = LEGACY_TAB_MAP[savedTab];
                    if (!document.getElementById(savedTab)) savedTab = 'overview';
                } catch (e) {
                    // Ignore if sessionStorage is not available
                }
                activateTab(savedTab);
                searchCount.style.display = 'none';
                searchClear.style.display = 'none';
            }

            /**
             * Filters visible sections by query, highlights matches, and updates the match counter.
             * @param {string} query - The search term entered by the user
             */
            function performSearch(query) {
                query = query.toLowerCase().trim();

                if (!query) {
                    if (isSearchMode) exitSearchMode();
                    return;
                }

                // 1-character queries like "a" or "e" match ~2000–4000 text
                // nodes across the entire settings page, each triggering a
                // DOM mutation. That costs 3–6 s and feels like the page
                // froze. A 2-char minimum keeps the search responsive and
                // still lets short feature names (e.g. "ui", "tv", "4k")
                // through. If the user is mid-edit (backspaced a longer
                // query down to 1 char), exit search mode and clear stale
                // highlights, then surface a hint via the counter so the
                // search UI doesn't look broken.
                if (query.length < 2) {
                    if (isSearchMode) exitSearchMode();
                    searchCount.textContent = 'Type 2+ characters to search';
                    searchCount.style.display = 'block';
                    searchClear.style.display = 'block';
                    return;
                }

                if (!isSearchMode) enterSearchMode();

                clearHighlights();
                let sectionCount = 0;

                tabContents.forEach(tabContent => {
                    let tabHasMatch = false;
                    const fieldsets = tabContent.querySelectorAll(':scope > fieldset');

                    fieldsets.forEach(fieldset => {
                        const fullText = getSearchableText(fieldset);

                        if (!fullText.includes(query)) {
                            fieldset.classList.add('je-search-hidden');
                            return;
                        }

                        fieldset.classList.remove('je-search-hidden');
                        tabHasMatch = true;
                        sectionCount++;

                        const detailsEls = fieldset.querySelectorAll('details');
                        detailsEls.forEach(detail => {
                            if (getSearchableText(detail).includes(query)) {
                                detail.classList.remove('je-search-hidden');
                                detail.open = true;
                            } else {
                                detail.classList.add('je-search-hidden');
                            }
                        });

                        highlightTextIn(fieldset, query);
                    });

                    tabContent.style.display = tabHasMatch ? 'block' : 'none';

                    // Rank tab-contents whose tab button's label itself
                    // contains the query above tabs that matched only by
                    // buried content. Searching "elsewhere" now surfaces
                    // the Elsewhere tab first even though other tabs
                    // (Overview service-status, Seerr) reference it too.
                    // The CSS .je-tab-name-match rule (flex order: -1)
                    // does the actual reordering in the form container.
                    const btn = document.querySelector('.jellyfin-tab-button[data-tab="' + tabContent.id + '"]');
                    let tabLabel = tabContent.id.toLowerCase();
                    if (btn) {
                        const clone = btn.cloneNode(true);
                        clone.querySelectorAll('i.material-icons, img').forEach(el => el.remove());
                        tabLabel = clone.textContent.trim().toLowerCase();
                    }
                    tabContent.classList.toggle('je-tab-name-match', tabHasMatch && tabLabel.includes(query));
                });

                allMatches = Array.from(form.querySelectorAll('.je-search-match'));
                currentMatchIdx = -1;

                if (allMatches.length > 0) {
                    searchCount.textContent = '0 of ' + allMatches.length;
                } else {
                    searchCount.textContent = sectionCount > 0
                        ? sectionCount + ' section' + (sectionCount !== 1 ? 's' : '') + ' found'
                        : 'No results';
                }
                searchCount.style.display = 'block';
                searchClear.style.display = 'block';
            }

            // Unsaved-changes indicator: diffs a snapshot of every form control against the last saved snapshot.
            const saveDock = document.querySelector('.je-save-dock');
            let _jeSavedSnapshot = null;

            function jeSnapshotFormState() {
                const parts = [];
                form.querySelectorAll('input, select, textarea').forEach((el, i) => {
                    if (el.type === 'file') return; // can't be read back, and not part of the saved config shape
                    if (el.closest('.je-arr-seerr-import-picker')) return; // transient browsing state, not a form change until actually imported
                    if (el.closest('.je-spoiler-apply-existing')) return; // per-run option of an action, not a saved setting
                    const key = el.id || el.name || ('#' + i);
                    parts.push(key + '=' + (el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value));
                });
                // shortcutOverrides is JS state, not bound to persistent <input> elements.
                parts.push('shortcuts=' + JSON.stringify(shortcutOverrides));
                return parts.join('');
            }

            /** Call once the form reflects a known-saved state. */
            function jeMarkSaved() {
                _jeSavedSnapshot = jeSnapshotFormState();
                jeUpdateDirtyIndicator();
            }

            function jeUpdateDirtyIndicator() {
                const dirty = _jeSavedSnapshot !== null && jeSnapshotFormState() !== _jeSavedSnapshot;
                if (saveDock) saveDock.classList.toggle('je-dirty', dirty);
            }

            form.addEventListener('input', jeUpdateDirtyIndicator);
            form.addEventListener('change', jeUpdateDirtyIndicator);
            // Fallback poll for structural changes that don't fire input/change (adding/removing a row).
            setInterval(jeUpdateDirtyIndicator, 1000);

            window.addEventListener('beforeunload', (e) => {
                if (!saveDock || !saveDock.classList.contains('je-dirty')) return;
                e.preventDefault();
                e.returnValue = '';
            });

        const defaultShortcuts = [
            { Name: "OpenSearch", Key: "/", Label: "Open Search", Category: "Global" },
            { Name: "GoToHome", Key: "Shift+H", Label: "Go to Home", Category: "Global" },
            { Name: "GoToDashboard", Key: "D", Label: "Go to Dashboard", Category: "Global" },
            { Name: "QuickConnect", Key: "Q", Label: "Quick Connect", Category: "Global" },
            { Name: "PlayRandomItem", Key: "R", Label: "Play Random Item", Category: "Global" },
            { Name: "CycleAspectRatio", Key: "A", Label: "Cycle Aspect Ratio", Category: "Player" },
            { Name: "ShowPlaybackInfo", Key: "I", Label: "Show Playback Info", Category: "Player" },
            { Name: "SubtitleMenu", Key: "S", Label: "Subtitle Menu", Category: "Player" },
            { Name: "CycleSubtitleTracks", Key: "C", Label: "Cycle Subtitle Tracks", Category: "Player" },
            { Name: "CycleAudioTracks", Key: "V", Label: "Cycle Audio Tracks", Category: "Player" },
            { Name: "IncreasePlaybackSpeed", Key: "+", Label: "Increase Playback Speed", Category: "Player" },
            { Name: "DecreasePlaybackSpeed", Key: "-", Label: "Decrease Playback Speed", Category: "Player" },
            { Name: "ResetPlaybackSpeed", Key: "R", Label: "Reset Playback Speed", Category: "Player" },
            { Name: "BookmarkCurrentTime", Key: "B", Label: "Bookmark Current Time", Category: "Player" },
            { Name: "OpenEpisodePreview", Key: "P", Label: "Open Episode Preview", Category: "Player" },
            { Name: "SkipIntroOutro", Key: "O", Label: "Skip Intro/Outro", Category: "Player" },
            { Name: "FrameStepBack", Key: ",", Label: "Step Back One Frame", Category: "Player" },
            { Name: "FrameStepForward", Key: ".", Label: "Step Forward One Frame", Category: "Player" },
            { Name: "JumpToLastPosition", Key: "Z", Label: "Jump to Last Position", Category: "Player" },
            { Name: "JumpToPercentage", Key: "0-9", Label: "Jump to % of video", Category: "Player" }
        ];

        function renderOverrides() {
            shortcutListContainer.innerHTML = '';
            if (shortcutOverrides.length === 0) {
                shortcutListContainer.innerHTML = '<p class="fieldDescription" style="text-align: center;">No overrides configured. All shortcuts are using default values.</p>';
            }
            shortcutOverrides.forEach((shortcut, index) => {
                const row = document.createElement('div');
                row.className = 'inputContainer';
                row.style.display = 'flex';
                row.style.alignItems = 'center';
                row.style.gap = '1em';

                const label = document.createElement('label');
                label.className = 'inputLabel';
                label.textContent = shortcut.Label;
                label.style.flex = '1';

                const input = document.createElement('input');
                input.setAttribute('is', 'emby-input');
                input.type = 'text';
                input.value = shortcut.Key;
                input.style.flex = '1';
                input.style.textAlign = 'center';
                if (shortcut.Key === '') {
                    input.placeholder = 'Disabled';
                    input.style.opacity = '0.6';
                    input.title = 'This shortcut is disabled server-wide. Type a key here to re-enable it with that binding, or click Remove to revert to the default.';
                }
                input.addEventListener('input', (e) => {
                    let value = e.target.value;
                    // Automatically convert single lowercase letters to uppercase ***
                    if (value.match(/^[a-z]$/)) {
                        value = value.toUpperCase();
                        e.target.value = value;
                    }
                    input.style.opacity = value === '' ? '0.6' : '';
                    input.placeholder = value === '' ? 'Disabled' : '';
                    shortcutOverrides[index].Key = value;
                });


                const buttonContainer = document.createElement('div');
                const removeBtn = document.createElement('button');
                removeBtn.setAttribute('is', 'emby-button');
                removeBtn.type = 'button';
                removeBtn.textContent = 'Remove';
                removeBtn.className = 'raised button-cancel';
                removeBtn.style.marginLeft = '1em';
                removeBtn.addEventListener('click', () => {
                    shortcutOverrides.splice(index, 1);
                    renderOverrides();
                    populateAddShortcutDropdown();
                });

                buttonContainer.appendChild(removeBtn);
                row.appendChild(label);
                row.appendChild(input);
                row.appendChild(buttonContainer);
                shortcutListContainer.appendChild(row);
            });
        }

        function populateAddShortcutDropdown() {
            addShortcutSelect.innerHTML = '';
            const overriddenNames = shortcutOverrides.map(s => s.Name);
            const availableShortcuts = defaultShortcuts.filter(s => !overriddenNames.includes(s.Name));

            availableShortcuts.forEach(shortcut => {
                const option = document.createElement('option');
                option.value = shortcut.Name;
                option.textContent = shortcut.Label;
                addShortcutSelect.appendChild(option);
            });
            addShortcutBtn.disabled = availableShortcuts.length === 0;
            addShortcutKeyInput.disabled = availableShortcuts.length === 0;
            disableShortcutBtn.disabled = availableShortcuts.length === 0;
        }

        function showValidationError(elementToShake, message) {
            shortcutErrorComment.textContent = message;
            shortcutErrorComment.style.display = 'block';
            elementToShake.classList.add('shake');

            setTimeout(() => {
                elementToShake.classList.remove('shake');
                shortcutErrorComment.style.display = 'none';
            }, 8000);
        }

        addShortcutBtn.addEventListener('click', () => {
            const selectedName = addShortcutSelect.value;
            let newKey = addShortcutKeyInput.value.trim();

            // Automatically convert single lowercase letters to uppercase ***
            if (newKey.match(/^[a-z]$/)) {
                newKey = newKey.toUpperCase();
            }

            // Check 0: See if there is a key being added
            if (!selectedName || !newKey) {
                showValidationError(addShortcutBtn, 'Please enter a key to use as an override.');
                return;
            }

            // Check 1: See if the key is already used in another custom override.
            const overrideConflict = shortcutOverrides.find(s => s.Key.toLowerCase() === newKey.toLowerCase());

            if (overrideConflict) {
                const errorMessage = "The key '" + newKey + "' is already assigned to '" + overrideConflict.Label + "' as an override.";
                showValidationError(addShortcutKeyInput.parentElement, errorMessage);
                return;
            }

            // Check 2: See if the key is used by another default shortcut.
            const defaultConflict = defaultShortcuts.find(s => s.Key.toLowerCase() === newKey.toLowerCase() && s.Name !== selectedName);

            if (defaultConflict) {
                const errorMessage = "The key '" + newKey + "' is already used by '" + defaultConflict.Label + "'.";
                showValidationError(addShortcutKeyInput.parentElement, errorMessage);
                return;
            }

            const defaultConfig = defaultShortcuts.find(s => s.Name === selectedName);
            if (defaultConfig) {
                shortcutOverrides.push({ ...defaultConfig, Key: newKey });
                renderOverrides();
                populateAddShortcutDropdown();
                addShortcutKeyInput.value = '';
            }
        });

        disableShortcutBtn.addEventListener('click', () => {
            const selectedName = addShortcutSelect.value;
            if (!selectedName) return;

            const defaultConfig = defaultShortcuts.find(s => s.Name === selectedName);
            if (defaultConfig) {
                // An empty Key is the same "disabled" sentinel the per-user Enhanced Panel
                // uses — it can never match a real keypress, so the shortcut just no-ops.
                shortcutOverrides.push({ ...defaultConfig, Key: '' });
                renderOverrides();
                populateAddShortcutDropdown();
                addShortcutKeyInput.value = '';
            }
        });

        async function testJellyseerrConnection() {
            const urls = (document.querySelector('#jellyseerrUrls').value || '').split('\n').map(u => u.trim()).filter(Boolean);
            const apiKey = (document.querySelector('#JellyseerrApiKey').value || '').trim();

            if (!urls.length || !apiKey) {
                Dashboard.alert({ title: 'Missing Information', message: 'Please provide at least one Seerr URL and an API key to test the connection.' });
                return;
            }

            const _testToken = (typeof beginConnectionTest === 'function') ? beginConnectionTest() : undefined;
            testJellyseerrBtn.disabled = true;
            jellyseerrStatusIndicator.textContent = 'sync';
            jellyseerrStatusIndicator.classList.add('status-check');
            jellyseerrStatusIndicator.style.color = 'var(--primary-accent-color, #00a4dc)';

            let validated = false;
            let lastError = '';
            for (const url of urls) {
                try {
                    const validationUrl = ApiClient.getUrl(`/JellyfinEnhanced/jellyseerr/validate`, {
                        url: url
                    });

                    const res = await ApiClient.ajax({ type: 'GET', url: validationUrl, dataType: 'json', headers: { 'X-Arr-ApiKey': apiKey } });

                    if (res && res.ok) {
                        validated = true;
                        break;
                    }
                } catch (e) {
                    console.error(`Seerr validation failed for ${url}:`, e);
                    // Jellyfin's ApiClient.ajax rejects with the Response object
                    // (modern fetch), which doesn't expose responseText/responseJSON.
                    // Read the body asynchronously so connectionErrorMessage can
                    // surface the typed code/cfRay/message envelope.
                    if (e && typeof e.json === 'function') {
                        try { e.responseJSON = await e.clone().json(); } catch (_) { /* not JSON */ }
                    }
                    lastError = connectionErrorMessage(e, 'Seerr', url);
                }
            }

            testJellyseerrBtn.disabled = false;
            jellyseerrStatusIndicator.classList.remove('status-check');

            if (validated) {
                jellyseerrStatusIndicator.textContent = 'check_circle';
                jellyseerrStatusIndicator.style.color = '#52b54b';
                try { setConnectionTestResult('seerr', 'ok', 'Connected', _testToken); } catch (e) { /* cache is best-effort */ }
                jeTestAlert({ title: 'Success', message: 'Successfully connected to Seerr!' });
            } else {
                jellyseerrStatusIndicator.textContent = 'error';
                jellyseerrStatusIndicator.style.color = '#dc3545';
                try { setConnectionTestResult('seerr', 'error', (lastError && lastError.length < 80) ? lastError : 'Connection failed', _testToken); } catch (e) { /* cache is best-effort */ }
                jeTestAlert({ title: 'Connection Failed', message: lastError || 'Could not connect to any provided URL.' });
            }
        }

        async function testTmdbConnection(event) {
            const apiKey = (document.querySelector('#TMDB_API_KEY').value || '').trim();

            if (!apiKey) {
                Dashboard.alert({ title: 'Missing Information', message: 'Please provide a TMDB API key to test the connection.' });
                return;
            }

            const _testToken = (typeof beginConnectionTest === 'function') ? beginConnectionTest() : undefined;

            // Determine which status indicator to update based on button context
            const button = event.target.closest('button');
            const statusIndicator = button.parentElement.querySelector('.material-icons') || tmdbStatusIndicator;

            // Disable all test buttons during the test
            const allTestButtons = document.querySelectorAll('.testTmdbBtn');
            allTestButtons.forEach(btn => btn.disabled = true);

            statusIndicator.textContent = 'sync';
            statusIndicator.classList.add('status-check');
            statusIndicator.style.color = 'var(--primary-accent-color, #00a4dc)';

            try {
                const validationUrl = ApiClient.getUrl(`/JellyfinEnhanced/tmdb/validate`, { apiKey: apiKey });
                await ApiClient.ajax({ type: 'GET', url: validationUrl });

                statusIndicator.textContent = 'check_circle';
                statusIndicator.style.color = '#52b54b';
                try { setConnectionTestResult('tmdb', 'ok', 'API key valid', _testToken); } catch (err) { /* cache is best-effort */ }
                jeTestAlert({ title: 'Success', message: 'Successfully connected to TMDB!' });

            } catch (e) {
                console.error('TMDB validation failed:', e);
                var errorMessage;
                if (e.status === 401) {
                    errorMessage = 'The API key is invalid. Check that you copied it correctly.';
                } else if (e.status === 500 || e.status === 0 || !e.status) {
                    errorMessage = 'Could not reach TMDB servers. Check your network connection.';
                } else {
                    errorMessage = 'Connection failed (error ' + e.status + '). Check the key and your network.';
                }

                statusIndicator.textContent = 'error';
                statusIndicator.style.color = '#dc3545';
                try {
                    var shortDetail = e.status === 401 ? 'API key rejected'
                        : (e.status === 500 || e.status === 0 || !e.status) ? 'Unreachable'
                        : 'Error ' + e.status;
                    setConnectionTestResult('tmdb', 'error', shortDetail, _testToken);
                } catch (err) { /* cache is best-effort */ }
                jeTestAlert({ title: 'Connection Failed', message: errorMessage });
            } finally {
                allTestButtons.forEach(btn => btn.disabled = false);
                if (statusIndicator) {
                    statusIndicator.classList.remove('status-check');
                }
            }
        }

        // Plugin detection state.
        //
        // Each `hasX` is tri-state: `null` (not yet probed or probe failed),
        // `true` (installed AND Status === "Active"), `false` (not installed
        // OR installed but disabled). When the plugin is installed-but-
        // disabled, we additionally record it in `_jeDisabledPlugins` so the
        // Optional Dependencies card can surface "Installed (disabled)"
        // instead of the blunt "Not installed".
        var hasPluginPages = null;
        var hasCustomTabs = null;
        var isJellyfin12 = (function() {
            try {
                var version = typeof ApiClient !== 'undefined' && ApiClient.serverVersion && ApiClient.serverVersion();
                return parseInt((version || '').split('.')[0], 10) >= 12;
            } catch (e) {
                return false;
            }
        })();
        var hasIntroSkipper = null;
        var hasInPlayerEpisodePreview = null;
        var hasFileTransformation = null;
        var hasKefinTweaks = null;
        var _jeCurrentPluginVersion = null;
        var _jeDisabledPlugins = {}; // key -> true when installed but Status !== 'Active'
        // Tri-state compat probe result for Custom Tabs:
        //   null           — not yet probed (or Custom Tabs not installed)
        //   'ok'           — /Plugins/.../Configuration returned the expected shape
        //   'incompatible' — config read but shape doesn't match { Tabs:[{Title,ContentHtml}] }
        //   'probe-failed' — HTTP/JSON/auth error reading the config
        var customTabsCompatState = null;

        /**
         * Checks installed plugins (Plugin Pages, Custom Tabs, etc.) and updates
         * dependency state for Plugin Pages / Custom Tabs dependent settings.
         * Called during loadConfig() on page load.
         */
        function checkInstalledPlugins() {
            ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/Plugins'),
                dataType: 'json'
            }).then(function(plugins) {
                setProbeWarning('plugins', null);
                // Status-aware plugin lookup. Returns tri-state:
                //   true  → installed AND active
                //   false → either not installed OR disabled
                // When disabled, also records it in _jeDisabledPlugins[key] so
                // the Optional Dependencies card can show "Installed (disabled)".
                _jeDisabledPlugins = {};
                function probe(key, names) {
                    var match = null;
                    var lowered = names.map(function(n) { return n.toLowerCase(); });
                    for (var i = 0; i < plugins.length; i++) {
                        var nm = (plugins[i].Name || '').toLowerCase();
                        if (lowered.indexOf(nm) !== -1) { match = plugins[i]; break; }
                    }
                    if (!match) return false;
                    // Jellyfin returns Status as one of: Active, Disabled, Restart,
                    // NotSupported, Malfunctioned, Superseded. Anything else → log
                    // once and treat as disabled so the dashboard surfaces a warning
                    // rather than silently passing through. Old builds that omit
                    // Status entirely are caught here too — better to see "Installed
                    // but status unknown" than misreport as Active.
                    //
                    // Rendering note: `_jeDisabledPlugins[key]` captures the raw
                    // Status string. The Optional Dependencies dashboard renders
                    // "Installed but disabled in Dashboard > Plugins" for any
                    // non-Active value. That copy is accurate for Disabled but
                    // slightly misleading for Restart ("waiting for server restart")
                    // and Superseded ("replaced by newer version, probably still
                    // usable"). Callers wanting distinct copy per status should
                    // branch on the raw value.
                    var status = match.Status;
                    var active = status === 'Active';
                    if (!active) {
                        _jeDisabledPlugins[key] = status || 'Status unknown';
                        if (status && ['Disabled', 'Restart', 'NotSupported', 'Malfunctioned', 'Superseded'].indexOf(status) === -1) {
                            console.warn('[JE] plugin ' + match.Name + ' has unexpected Status value: ' + JSON.stringify(status));
                        }
                    }
                    return active;
                }
                hasFileTransformation = probe('fileTransformation', ['File Transformation']);
                hasPluginPages        = probe('pluginPages',        ['Plugin Pages']);
                hasCustomTabs         = probe('customTabs',         ['Custom Tabs']);
                hasIntroSkipper       = probe('introSkipper',       ['Intro Skipper', 'SkipIntro']);
                hasInPlayerEpisodePreview = probe('inPlayerEpisodePreview', ['In Player Episode Preview', 'In-Player Episode Preview', 'InPlayerEpisodePreview']);

                var self = plugins.find(function(p) { return (p.Name || '').toLowerCase() === 'jellyfin enhanced'; });
                if (self && self.Version) _jeCurrentPluginVersion = self.Version;

                // KefinTweaks installs as a web-mod (files in /config/KefinTweaks/
                // injected via File Transformation into index.html), NOT as a
                // .NET plugin — so it never appears in /Plugins. Detect it at
                // runtime instead: the injector sets `window.KefinTweaksConfig`
                // and adds script tags whose src contains "KefinTweaks".
                try {
                    hasKefinTweaks = !!(window.KefinTweaksConfig ||
                        document.querySelector('script[src*="KefinTweaks"]'));
                } catch (e) {
                    // Extremely unlikely (the selector is literal and the window
                    // read is same-origin), but a future isolation/CSP quirk could
                    // throw — log so we can distinguish "detection bug" from
                    // "legitimately not installed" in bug reports.
                    console.warn('[JE] KefinTweaks detection threw; treating as absent:', e);
                    hasKefinTweaks = false;
                }

                // Toggle body classes so descriptions hide install-only content
                // (e.g., "Install the Custom Tabs plugin...") and surface a positive
                // "detected" badge when an integration plugin is already present.
                document.body.classList.toggle('je-has-customtabs',        hasCustomTabs         === true);
                document.body.classList.toggle('je-has-pluginpages',       hasPluginPages        === true);
                document.body.classList.toggle('je-has-introskipper',      hasIntroSkipper       === true);
                document.body.classList.toggle('je-has-inplayerepisodepreview', hasInPlayerEpisodePreview === true);
                document.body.classList.toggle('je-has-kefintweaks',       hasKefinTweaks        === true);

                // If Custom Tabs is present, probe its config to decide whether the
                // schema matches what we know how to write. Only on success do we
                // reveal the "Add the Custom Tabs entry for me" toggles.
                if (hasCustomTabs === true) {
                    customTabsCompatState = null; // re-probing
                    checkCustomTabsConfigCompat();
                } else {
                    document.body.classList.remove('je-has-customtabs-compat');
                    customTabsCompatState = null;
                }

                // Re-run dependencies now that plugin info is available
                updateAllDependencies();
                checkWhatsNew();
            }).catch(function(err) {
                // Plugin list request failed (network, auth expiry, server offline, ...).
                // Leave hasPluginPages/hasIntroSkipper at null so individual deps show
                // "unknown" rather than incorrectly disabling toggles. Still refresh
                // the dashboard so cards don't sit stuck on "Checking..." forever.
                console.warn('[JE] plugin detection failed; resetting detection state to avoid stale UI:', err);
                // Reset detection state so prior-success flags don't contradict
                // the visible "couldn't reach /Plugins" warning. Body classes,
                // module flags, and dep gates all flip back to "unknown" so the
                // UI is internally consistent after a failed retry.
                hasPluginPages = null;
                hasCustomTabs = null;
                hasIntroSkipper = null;
                hasInPlayerEpisodePreview = null;
                hasFileTransformation = null;
                hasKefinTweaks = null;
                customTabsCompatState = null;
                document.body.classList.remove('je-has-customtabs', 'je-has-pluginpages', 'je-has-introskipper', 'je-has-inplayerepisodepreview', 'je-has-customtabs-compat', 'je-has-kefintweaks');
                setProbeWarning('plugins', "Couldn't reach the Jellyfin /Plugins endpoint to verify which integrations are installed (auth expiry, network, or server issue). Dependency hints and \"plugin detected\" badges are now hidden until you retry.");
                try { updateAllDependencies(); } catch (e) {
                    console.warn('[JE] updateAllDependencies threw during plugin-detect fallback:', e);
                }
                try {
                    updateStatusDashboard();
                } catch (e) {
                    console.warn('[JE] updateStatusDashboard threw during plugin-detect fallback:', e);
                }
            });
            // Probe-warning retry — re-runs plugin detection (which also re-runs
            // the Custom Tabs config probe inside its .then). One handler only;
            // checkInstalledPlugins is idempotent.
            var probeRetry = document.getElementById('je-probe-retry-btn');
            if (probeRetry && !probeRetry.dataset.jeWired) {
                probeRetry.dataset.jeWired = '1';
                probeRetry.onclick = function() {
                    setProbeWarning('plugins', null);
                    setProbeWarning('customtabs', null);
                    checkInstalledPlugins();
                };
            }
        }

        // ---------------------------------------------------------------------
        // Custom Tabs auto-management
        //
        // The Custom Tabs plugin (https://github.com/IAmParadox27/jellyfin-plugin-custom-tabs)
        // stores its tab list at /Plugins/{guid}/Configuration as
        // `{ "Tabs": [{ "Title": "...", "ContentHtml": "..." }, ...] }`.
        // We can manage individual entries on the user's behalf, but only when
        // the schema we observe matches that shape exactly. If the schema has
        // changed in a future release, every code path here bails out silently
        // and the related UI ("Add the Custom Tabs entry for me" toggles) stays
        // hidden — the user falls back to manual setup with no error noise.
        // ---------------------------------------------------------------------
        var CUSTOM_TABS_PLUGIN_ID = 'fbacd0b6fd464a05b0a42045d6a135b0';

        // Per managed Custom Tabs entry: which JE config flags drive it
        // (parent + auto-create), what Title to write, and the exact
        // ContentHtml snippet that JE's matching front-end module looks for.
        // ContentHtml strings are the SOURCE OF TRUTH for "this tab is ours" —
        // the sync logic identifies our entries by exact-string match.
        // `masterKey` is the top-level feature toggle (Enable Bookmarks / Enable
        // Hidden Content / Enable Requests Page / Enable Calendar Page). Sync
        // requires ALL THREE — masterKey, parentKey, autoKey — to be true for
        // the entry to exist. Without masterKey in the predicate, disabling the
        // master feature would leave an orphan Custom Tabs entry that opens to
        // broken/empty content (the JE module behind it is off).
        var CUSTOM_TAB_MANAGED_ENTRIES = [
            { masterKey: 'BookmarksEnabled',      parentKey: 'BookmarksUseCustomTabs',     autoKey: 'BookmarksAutoCreateCustomTab',     ownedKey: 'BookmarksCustomTabJeOwned',     title: 'Bookmarks',      html: '<div class="sections bookmarks"></div>' },
            { masterKey: 'HiddenContentEnabled',  parentKey: 'HiddenContentUseCustomTabs', autoKey: 'HiddenContentAutoCreateCustomTab', ownedKey: 'HiddenContentCustomTabJeOwned', title: 'Hidden Content', html: '<div class="jellyfinenhanced hidden-content"></div>' },
            { masterKey: 'DownloadsPageEnabled',  parentKey: 'DownloadsUseCustomTabs',     autoKey: 'DownloadsAutoCreateCustomTab',     ownedKey: 'DownloadsCustomTabJeOwned',     title: 'Requests',       html: '<div class="jellyfinenhanced requests"></div>' },
            { masterKey: 'CalendarPageEnabled',   parentKey: 'CalendarUseCustomTabs',      autoKey: 'CalendarAutoCreateCustomTab',      ownedKey: 'CalendarCustomTabJeOwned',      title: 'Calendar',       html: '<div class="jellyfinenhanced calendar"></div>' },
            { masterKey: 'RecommendationsPageEnabled', parentKey: 'RecommendationsUseCustomTabs', autoKey: 'RecommendationsAutoCreateCustomTab', ownedKey: 'RecommendationsCustomTabJeOwned', title: 'Recommendations', html: '<div class="jellyfinenhanced recommendations"></div>' },
            { masterKey: 'ActivityFeedEnabled',   parentKey: 'ActivityFeedUseCustomTabs',   autoKey: 'ActivityFeedAutoCreateCustomTab',   ownedKey: 'ActivityFeedCustomTabJeOwned',  title: 'Activity',       html: '<div class="jellyfinenhanced activity"></div>' }
        ];

        function isCustomTabsConfigShapeOk(cfg) {
            if (!cfg || typeof cfg !== 'object') {
                console.warn('[JE] Custom Tabs compat: config is not an object:', cfg);
                return false;
            }
            if (!Array.isArray(cfg.Tabs)) {
                console.warn('[JE] Custom Tabs compat: cfg.Tabs is not an array. Keys present:', Object.keys(cfg));
                return false;
            }
            for (var i = 0; i < cfg.Tabs.length; i++) {
                var t = cfg.Tabs[i];
                if (!t || typeof t !== 'object') {
                    console.warn('[JE] Custom Tabs compat: tab[' + i + '] is not an object:', t);
                    return false;
                }
                if (typeof t.Title !== 'string' || typeof t.ContentHtml !== 'string') {
                    console.warn('[JE] Custom Tabs compat: tab[' + i + '] missing expected fields. Got keys:', Object.keys(t));
                    return false;
                }
            }
            return true;
        }

        // Surfaces a single probe-failure banner above the form. Multiple probes
        // (plugin list, Custom Tabs config schema) can fail independently — the
        // banner aggregates them so the admin sees one actionable message instead
        // of nothing. Pass an empty/null msg to clear the banner for that source.
        var _jeProbeWarnings = Object.create(null);
        function setProbeWarning(source, msg) {
            if (msg) _jeProbeWarnings[source] = msg;
            else delete _jeProbeWarnings[source];
            var banner = document.getElementById('je-probe-warning');
            var msgEl = document.getElementById('je-probe-warning-msg');
            if (!banner || !msgEl) return;
            var keys = Object.keys(_jeProbeWarnings);
            if (keys.length === 0) {
                banner.style.display = 'none';
                msgEl.textContent = '';
            } else {
                msgEl.textContent = ': ' + keys.map(function(k) { return _jeProbeWarnings[k]; }).join(' / ');
                banner.style.display = '';
            }
        }

        function checkCustomTabsConfigCompat() {
            ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/Plugins/' + CUSTOM_TABS_PLUGIN_ID + '/Configuration'),
                dataType: 'json'
            }).then(function(cfg) {
                var ok = isCustomTabsConfigShapeOk(cfg);
                document.body.classList.toggle('je-has-customtabs-compat', ok);
                customTabsCompatState = ok ? 'ok' : 'incompatible';
                if (!ok) {
                    console.warn('[JE] Custom Tabs config schema not recognized; auto-manage toggles hidden.');
                    setProbeWarning('customtabs', "Custom Tabs config has an unrecognized shape. Auto-create toggles disabled until Jellyfin Enhanced supports the new schema.");
                } else {
                    setProbeWarning('customtabs', null);
                }
                try { renderOptionalPluginsDashboard(); } catch (e) {
                    console.warn('[JE] renderOptionalPluginsDashboard threw from checkCustomTabsConfigCompat (then):', e);
                }
            }).catch(function(err) {
                document.body.classList.remove('je-has-customtabs-compat');
                customTabsCompatState = 'probe-failed';
                console.warn('[JE] Custom Tabs config probe failed; auto-manage toggles hidden:', err);
                setProbeWarning('customtabs', "Couldn't read Custom Tabs config (check Jellyfin logs). Auto-create toggles disabled until the probe succeeds.");
                try { renderOptionalPluginsDashboard(); } catch (e) {
                    console.warn('[JE] renderOptionalPluginsDashboard threw from checkCustomTabsConfigCompat (catch):', e);
                }
            });
        }

        /**
         * Plan + apply Custom Tabs sync for every managed entry.
         *
         * Returns a promise resolving to `{ ok, status, detail, ownedUpdates }`:
         *  - `ok: true` → sync ran cleanly (or was a clean no-op)
         *  - `ok: false` → something failed; `detail` describes it (admin-visible)
         *  - `status: 'noop' | 'ok' | 'skipped' | 'failed'`
         *  - `ownedUpdates: [{ ownedKey, value }]` — *JE-side* flag updates the caller
         *    must persist alongside the rest of the JE config so future syncs know
         *    which entries we created vs. which the admin added manually.
         *
         * Sync rules per managed entry (uses `ownedKey` to gate destructive deletes):
         *  - shouldExist (auto+parent both on) AND no matching CT entry → ADD; owned=true
         *  - shouldExist AND a matching CT entry exists → leave entry alone; preserve owned
         *  - !shouldExist AND a matching CT entry exists AND we own it → REMOVE; owned=false
         *  - !shouldExist AND a matching CT entry exists but we don't own it → leave it
         *    (it's the admin's manually-created tab); owned stays false
         *  - !shouldExist AND no matching entry → no-op; owned=false
         *
         * The single GET → mutate → single POST sequence avoids the race where
         * multiple per-entry round-trips would clobber each other.
         */
        function syncAllManagedCustomTabs(savedConfig) {
            if (!document.body.classList.contains('je-has-customtabs-compat')) {
                // Bail early. If the admin has auto-create intent stored but we
                // can't act on it (compat probe failed / detection unknown),
                // return ok:false so the save-flow alert gate fires — otherwise
                // the green "Saved!" toast masks the dropped intent.
                // Mirror `shouldExist`: intent requires all three flags —
                // master + parent + auto. A disabled-at-master feature with
                // auto+parent still checked wouldn't have a real sync action
                // anyway, so shouldn't trigger the cosmetic "saved but CT
                // dropped your auto-create" alert.
                var anyIntent = CUSTOM_TAB_MANAGED_ENTRIES.some(function(e) {
                    return savedConfig[e.autoKey] === true
                        && savedConfig[e.parentKey] === true
                        && savedConfig[e.masterKey] === true;
                });
                // Custom Tabs definitely absent (not installed, or installed
                // but disabled): there is nothing to sync and nothing the admin
                // can fix from here, so skip cleanly. Typical after a 10.11 →
                // 12 upgrade where Custom Tabs was dropped in favour of the
                // native home tabs; the stored intent is deliberately kept so
                // the entries sync again if the plugin is reinstalled. The
                // auto-create toggles are hidden in this state, so an ok:false
                // here would re-alert on every save with no way out.
                if (hasCustomTabs === false) {
                    return Promise.resolve({
                        ok: true,
                        status: 'skipped',
                        detail: 'Custom Tabs not installed; nothing to sync.',
                        ownedUpdates: []
                    });
                }
                return Promise.resolve({
                    ok: !anyIntent, // only "skipped cleanly" when there was nothing to do
                    status: 'skipped',
                    detail: anyIntent
                        ? (hasCustomTabs === true
                            ? 'Custom Tabs is installed, but its config could not be read or has an unrecognized shape, so the auto-create entry was skipped.'
                            : 'Plugin detection did not complete, so the auto-create entry was skipped.')
                          + ' Use the Retry button on the "Plugin detection issue" banner at the top of this page (or reload the page), then save again.'
                        : 'Custom Tabs compat probe not passed; nothing to sync.',
                    ownedUpdates: []
                });
            }
            return ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/Plugins/' + CUSTOM_TABS_PLUGIN_ID + '/Configuration'),
                dataType: 'json'
            }).then(function(cfg) {
                if (!isCustomTabsConfigShapeOk(cfg)) {
                    return {
                        ok: false,
                        status: 'failed',
                        detail: 'Custom Tabs configuration shape no longer matches what Jellyfin Enhanced knows how to write; auto-manage skipped to avoid corrupting it.',
                        ownedUpdates: []
                    };
                }
                var changed = false;
                var ownedUpdates = [];
                CUSTOM_TAB_MANAGED_ENTRIES.forEach(function(entry) {
                    // ALL three gates must be on: the master feature, the
                    // Use-Custom-Tabs child toggle, and the Auto-Create
                    // opt-in. Missing the master-flag check here meant
                    // disabling the top-level feature still left an orphan
                    // CT entry that opened to broken content.
                    var shouldExist =
                        savedConfig[entry.autoKey] === true &&
                        savedConfig[entry.parentKey] === true &&
                        savedConfig[entry.masterKey] === true;
                    var isOwned = savedConfig[entry.ownedKey] === true;
                    var idx = -1;
                    for (var i = 0; i < cfg.Tabs.length; i++) {
                        if (cfg.Tabs[i].ContentHtml === entry.html) { idx = i; break; }
                    }
                    if (shouldExist && idx === -1) {
                        cfg.Tabs.push({ Title: entry.title, ContentHtml: entry.html });
                        changed = true;
                        ownedUpdates.push({ ownedKey: entry.ownedKey, value: true });
                    } else if (shouldExist /* && idx !== -1 */) {
                        // Entry already exists — preserve current owned flag. Do NOT
                        // claim ownership of an existing entry that we didn't add,
                        // so that the admin can manage it manually if they later
                        // turn auto-create off.
                        ownedUpdates.push({ ownedKey: entry.ownedKey, value: isOwned });
                    } else if (!shouldExist && idx !== -1 && isOwned) {
                        // We created this; safe to remove.
                        cfg.Tabs.splice(idx, 1);
                        changed = true;
                        ownedUpdates.push({ ownedKey: entry.ownedKey, value: false });
                    } else {
                        // !shouldExist + (no entry, OR entry but not ours) → leave alone.
                        ownedUpdates.push({ ownedKey: entry.ownedKey, value: false });
                    }
                });
                if (!changed) {
                    return { ok: true, status: 'noop', detail: 'Custom Tabs already in sync.', ownedUpdates: ownedUpdates };
                }
                return ApiClient.ajax({
                    type: 'POST',
                    url: ApiClient.getUrl('/Plugins/' + CUSTOM_TABS_PLUGIN_ID + '/Configuration'),
                    contentType: 'application/json',
                    data: JSON.stringify(cfg)
                }).then(function() {
                    return { ok: true, status: 'ok', detail: 'Custom Tabs updated.', ownedUpdates: ownedUpdates };
                }).catch(function(err) {
                    return {
                        ok: false,
                        status: 'failed',
                        detail: 'Custom Tabs update failed: ' + ((err && err.message) || 'see console'),
                        ownedUpdates: []  // do NOT persist owned flags if the POST didn't land
                    };
                });
            }).catch(function(err) {
                return {
                    ok: false,
                    status: 'failed',
                    detail: 'Could not read Custom Tabs configuration: ' + ((err && err.message) || 'see console'),
                    ownedUpdates: []
                };
            });
        }

        // Auto Movie Request - Quality Profile Mode helpers
        function clearSelectOptions(selectEl) {
            while (selectEl.options.length > 0) {
                selectEl.remove(0);
            }
        }

        function addSelectOption(selectEl, value, text) {
            var opt = document.createElement('option');
            opt.value = value;
            opt.textContent = text;
            selectEl.appendChild(opt);
        }

        function resetSelectWithMessage(selectEl, value, message) {
            clearSelectOptions(selectEl);
            addSelectOption(selectEl, value, message);
        }

        function initAutoMovieQualityMode() {
            var qualityModeSelect = document.querySelector('#autoMovieRequestQualityMode');
            var customSettingsDiv = document.querySelector('#autoMovieRequestCustomSettings');
            if (!qualityModeSelect || !customSettingsDiv) return;

            qualityModeSelect.addEventListener('change', function() {
                customSettingsDiv.style.display = (qualityModeSelect.value === 'custom') ? 'block' : 'none';
                if (qualityModeSelect.value === 'custom') {
                    loadAutoMovieRadarrServers();
                }
            });
        }

        var _autoMovieServerListenerAdded = false;
        function loadAutoMovieRadarrServers(savedConfig) {
            var serverSelect = document.querySelector('#autoMovieRequestServer');
            var profileSelect = document.querySelector('#autoMovieRequestProfile');
            var folderSelect = document.querySelector('#autoMovieRequestRootFolder');
            if (!serverSelect) return;

            resetSelectWithMessage(serverSelect, '-1', 'Loading...');

            ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/JellyfinEnhanced/jellyseerr/radarr'),
                dataType: 'json'
            }).then(function(servers) {
                resetSelectWithMessage(serverSelect, '-1', 'Select Server...');
                var serverList = Array.isArray(servers) ? servers : [servers];
                serverList.forEach(function(server) {
                    if (server && typeof server.id === 'number') {
                        addSelectOption(serverSelect, server.id, server.name || ('Server ' + server.id));
                    }
                });

                var savedServerId = savedConfig ? savedConfig.AutoMovieRequestCustomServerId : null;
                if (savedServerId !== null && savedServerId !== undefined && savedServerId >= 0) {
                    serverSelect.value = savedServerId;
                    loadAutoMovieServerDetails(savedServerId, savedConfig);
                }
            }).catch(function(err) {
                resetSelectWithMessage(serverSelect, '-1', 'Failed to load servers');
                console.warn('[Auto-Movie-Request] Failed to load Radarr servers:', err);
            });

            if (!_autoMovieServerListenerAdded) {
                _autoMovieServerListenerAdded = true;
                serverSelect.addEventListener('change', function() {
                    var serverId = parseInt(serverSelect.value);
                    if (!isNaN(serverId) && serverId >= 0) {
                        loadAutoMovieServerDetails(serverId);
                    } else {
                        resetSelectWithMessage(profileSelect, '0', 'Select a server first...');
                        resetSelectWithMessage(folderSelect, '', 'Select a server first...');
                    }
                });
            }
        }

        function loadAutoMovieServerDetails(serverId, savedConfig) {
            var profileSelect = document.querySelector('#autoMovieRequestProfile');
            var folderSelect = document.querySelector('#autoMovieRequestRootFolder');
            if (!profileSelect || !folderSelect) return;

            resetSelectWithMessage(profileSelect, '0', 'Loading...');
            resetSelectWithMessage(folderSelect, '', 'Loading...');

            ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/JellyfinEnhanced/jellyseerr/radarr/' + serverId),
                dataType: 'json'
            }).then(function(details) {
                resetSelectWithMessage(profileSelect, '0', 'Select Profile...');
                (details.profiles || []).forEach(function(profile) {
                    addSelectOption(profileSelect, profile.id, profile.name || ('Profile ' + profile.id));
                });

                resetSelectWithMessage(folderSelect, '', 'Select Folder...');
                (details.rootFolders || []).forEach(function(folder) {
                    addSelectOption(folderSelect, folder.path, folder.path);
                });

                var savedProfileId = (savedConfig && savedConfig.AutoMovieRequestCustomProfileId) || 0;
                if (savedProfileId > 0) profileSelect.value = savedProfileId;
                var savedRootFolder = (savedConfig && savedConfig.AutoMovieRequestCustomRootFolder) || '';
                if (savedRootFolder) folderSelect.value = savedRootFolder;
            }).catch(function(err) {
                resetSelectWithMessage(profileSelect, '0', 'Failed to load');
                resetSelectWithMessage(folderSelect, '', 'Failed to load');
                console.warn('[Auto-Movie-Request] Failed to load server details:', err);
            });
        }

        // ==================== Multi-Instance Arr Management ====================

        function createEl(tag, attrs, children) {
            var el = document.createElement(tag);
            if (attrs) {
                Object.keys(attrs).forEach(function(k) {
                    if (k === 'textContent') el.textContent = attrs[k];
                    else if (k === 'style') el.setAttribute('style', attrs[k]);
                    else if (k === 'className') el.className = attrs[k];
                    else el.setAttribute(k, attrs[k]);
                });
            }
            if (children) {
                children.forEach(function(c) { if (c) el.appendChild(c); });
            }
            return el;
        }

        function createInstanceCard(type, instance, startOpen) {
            var defaultName = type === 'sonarr' ? 'Sonarr' : 'Radarr';
            var namePlaceholder = type === 'sonarr' ? 'e.g., TV Shows, Anime' : 'e.g., Movies, 4K Movies';
            var urlPlaceholder = type === 'sonarr' ? 'e.g., http://192.168.1.100:8989' : 'e.g., http://192.168.1.100:7878';

            // Default Enabled to true when the stored JSON omits the field (backwards compat with
            // configs written before the Enabled flag existed).
            var initiallyEnabled = instance.Enabled !== false;

            // Enabled toggle lives in the summary row so admins can flip it without expanding
            // the card. stopPropagation on pointer events prevents the <details> from toggling
            // open/closed when the user clicks the checkbox itself.
            // Styled via .arr-instance-enabled CSS (see configPage.css). We intentionally
            // do NOT use is="emby-checkbox" — that custom element expects a <label> wrapper
            // with a sibling <span>, which we can't provide inside a <details><summary> row
            // without breaking the flex layout of the name/URL/disabled chip.
            var ariaName = (instance.Name || '').trim() || defaultName;
            var enabledCheckbox = createEl('input', {
                type: 'checkbox',
                className: 'arr-instance-enabled',
                'aria-label': 'Enable ' + ariaName + ' instance',
                title: 'Uncheck to skip this instance in all fan-out paths (links, calendar, queue, tag sync) without deleting its URL/API key'
            });
            if (initiallyEnabled) enabledCheckbox.checked = true;
            ['click', 'mousedown', 'keydown'].forEach(function(evt) {
                enabledCheckbox.addEventListener(evt, function(e) { e.stopPropagation(); });
            });

            // Summary row (visible when collapsed). Order: [▶ disclosure] [☑ enabled] [name] [(disabled)] [url]
            var summaryDisabledSpan = createEl('span', {
                className: 'arr-instance-summary-disabled',
                textContent: '(disabled)',
                style: 'color: #e5a00d; font-size: 0.85em; margin-right: 0.5em; display: ' + (initiallyEnabled ? 'none' : 'inline')
            });
            var summaryNameSpan = createEl('span', { className: 'arr-instance-summary-name', textContent: instance.Name || defaultName });
            var summaryUrlSpan = createEl('span', { className: 'arr-instance-summary-url', textContent: instance.Url || '' });
            var summaryEl = document.createElement('summary');
            summaryEl.appendChild(enabledCheckbox);
            summaryEl.appendChild(summaryNameSpan);
            summaryEl.appendChild(summaryDisabledSpan);
            summaryEl.appendChild(summaryUrlSpan);

            // Body header: [name input (flex:1)] [Remove]. The Enabled toggle used to live here
            // too, which crowded the row and left the name input pinched against it. Moved to
            // the summary above so this row has only the rename + remove affordances.
            var nameInput = createEl('input', { className: 'arr-instance-name emby-input', type: 'text', placeholder: namePlaceholder, value: instance.Name || '', style: 'flex:1' });
            var removeBtn = createEl('button', { className: 'arr-instance-remove', type: 'button', title: 'Remove instance', textContent: 'Remove' });
            var header = createEl('div', { className: 'arr-instance-header' }, [nameInput, removeBtn]);

            var urlLabel = createEl('label', { className: 'inputLabel inputLabelUnfocused', textContent: 'URL' });
            var urlInput = createEl('input', { className: 'arr-instance-url emby-input', type: 'text', placeholder: urlPlaceholder, value: instance.Url || '' });
            var defaultPort = type === 'sonarr' ? '8989' : '7878';
            var urlDesc = createEl('div', { className: 'fieldDescription', textContent: 'The Jellyfin server uses this URL to talk to ' + (type === 'sonarr' ? 'Sonarr' : 'Radarr') + ' directly. If your public URL sits behind an auth proxy (Authentik, Authelia, Cloudflare Access, etc.), put the INTERNAL address here (e.g. http://' + type + ':' + defaultPort + ' or http://192.168.x.y:' + defaultPort + ') and use the URL Mappings below to redirect user-facing links to the public URL.' });
            var urlContainer = createEl('div', { className: 'inputContainer', style: 'margin-top: 0.5em;' }, [urlLabel, urlInput, urlDesc]);

            var apiLabel = createEl('label', { className: 'inputLabel inputLabelUnfocused', textContent: 'API Key' });
            var apiInput = createEl('input', { className: 'arr-instance-apikey emby-input', type: 'text', autocomplete: 'off', placeholder: 'API key (find in Settings > General > Security)', value: instance.ApiKey || '' });
            var statusIcon = createEl('span', { className: 'material-icons arr-instance-status', style: 'transition: color 0.3s ease;' });
            var testBtn = createEl('button', { className: 'emby-button raised arr-instance-test', type: 'button' });
            testBtn.appendChild(createEl('span', { textContent: 'Test' }));
            var apiRow = createEl('div', { style: 'display: flex; align-items: center; gap: 1em;' }, [apiInput, statusIcon, testBtn]);
            var apiDesc = createEl('div', { className: 'fieldDescription', textContent: 'Find this in ' + (type === 'sonarr' ? 'Sonarr' : 'Radarr') + ' under Settings > General > Security > API Key' });
            var apiContainer = createEl('div', { className: 'inputContainer', style: 'margin-top: 0.5em;' }, [apiLabel, apiRow, apiDesc]);

            // URL Mappings shown inline (no nested <details>) — the whole card already
            // expands behind its own <details>, so doubling up on collapses hides a
            // frequently-edited field one extra click deep.
            var mappingsLabel = createEl('label', { className: 'inputLabel inputLabelUnfocused', textContent: 'URL Mappings (optional)' });
            var mappingsTextarea = createEl('textarea', { className: 'arr-instance-urlmappings emby-textarea emby-input', style: 'display:block; height: 8vh !important; margin-top: 0.25em;', placeholder: 'jellyfin_url|arr_url (one per line)' });
            mappingsTextarea.value = instance.UrlMappings || '';
            var mappingsDesc = createEl('div', { className: 'fieldDescription', textContent: 'Map Jellyfin access URLs to this instance\'s URL. Format: jellyfin_url|arr_url (one per line). Useful for reverse-proxy setups.' });
            var mappingsContainer = createEl('div', { className: 'inputContainer', style: 'margin-top: 0.5em;' }, [mappingsLabel, mappingsTextarea, mappingsDesc]);

            var body = createEl('div', { className: 'arr-instance-card-body' }, [header, urlContainer, apiContainer, mappingsContainer]);

            // The card is a <details> element
            var card = document.createElement('details');
            card.className = 'arr-instance-card';
            if (!initiallyEnabled) card.classList.add('arr-instance-disabled');
            card.dataset.type = type;
            if (startOpen) card.open = true;
            card.appendChild(summaryEl);
            card.appendChild(body);

            // Keep summary text in sync with name/url inputs
            nameInput.addEventListener('input', function() {
                var n = nameInput.value.trim() || defaultName;
                summaryNameSpan.textContent = n;
                enabledCheckbox.setAttribute('aria-label', 'Enable ' + n + ' instance');
            });
            urlInput.addEventListener('input', function() {
                summaryUrlSpan.textContent = urlInput.value.trim();
            });

            // Toggle visual dim state + summary "(disabled)" chip when the Enabled checkbox
            // changes. The backend is the authority — this is UI feedback only until Save.
            // Also re-renders the Overview Service Status card so a disabled instance
            // instantly shows as "Disabled" instead of a stale red/green badge.
            //
            // setBodyDisabled marks every form control inside the card body read-only when
            // the toggle is off so edits can't silently persist — collectInstancesFromDom
            // reads input values directly and respects the Enabled flag on save.
            function setBodyDisabled(disabled) {
                body.querySelectorAll('input, textarea, button, select').forEach(function(el) {
                    if (disabled) {
                        el.setAttribute('disabled', '');
                    } else {
                        el.removeAttribute('disabled');
                    }
                });
            }
            setBodyDisabled(!initiallyEnabled);
            enabledCheckbox.addEventListener('change', function() {
                var en = enabledCheckbox.checked;
                summaryDisabledSpan.style.display = en ? 'none' : 'inline';
                card.classList.toggle('arr-instance-disabled', !en);
                setBodyDisabled(!en);
                try { renderServiceStatusDashboard(); } catch (e) {
                    console.warn('[JE] renderServiceStatusDashboard threw from arr-instance enable-toggle:', e);
                }
            });

            // Confirm before removing
            removeBtn.addEventListener('click', function(e) {
                e.preventDefault();
                var instName = nameInput.value.trim() || defaultName;
                Dashboard.confirm('Remove "' + instName + '" from the instance list? The change takes effect when you click Save. If you leave the page without saving, the instance is kept.\n\nTip: If you just want to stop using it temporarily, uncheck Enabled instead; that preserves the URL and API key.', 'Remove Instance', function(confirmed) {
                    if (confirmed) {
                        card.remove();
                        updateAllDependencies();
                    }
                });
            });

            testBtn.addEventListener('click', function() { testInstanceConnection(card); });
            apiInput.style.flex = '1';
            return card;
        }

        // Tracks whether each instance-list JSON parsed cleanly on load.
        // When false, saveArrInstances refuses to overwrite the stored value and legacy fields
        // to avoid turning a read-side corruption into permanent data loss.
        var _arrParseOK = { sonarr: true, radarr: true };

        function tryParseInstanceList(raw, type, container) {
            if (!raw) { _arrParseOK[type] = true; return []; }
            try {
                var parsed = JSON.parse(raw);
                if (!Array.isArray(parsed)) throw new Error(type + 'Instances JSON is not an array');
                _arrParseOK[type] = true;
                return parsed;
            } catch (e) {
                _arrParseOK[type] = false;
                console.error('[JE Config] Failed to parse ' + type + 'Instances — refusing to overwrite on save:', e, raw);
                insertCorruptBanner(container, type);
                return [];
            }
        }

        function insertCorruptBanner(container, type) {
            var label = type === 'sonarr' ? 'Sonarr' : 'Radarr';
            var banner = document.createElement('div');
            banner.className = 'arr-corrupt-banner';
            banner.setAttribute('data-arr-corrupt', type);
            banner.style.cssText = 'padding: 0.8em 1em; margin-bottom: 1em; border: 1px solid #dc3545; background: rgba(220,53,69,0.15); border-radius: 4px;';

            var heading = document.createElement('strong');
            heading.textContent = '⚠ Stored ' + label + ' instance configuration is corrupted.';
            var detail = document.createElement('div');
            detail.style.marginTop = '0.3em';
            detail.textContent = 'The saved JSON could not be parsed. Saving this page will NOT overwrite the stored value or the legacy ' +
                label + ' URL/API key, so existing configuration is preserved. To recover: either fix the stored JSON directly in Jellyfin\'s plugin config, ' +
                'or click the button below to reset this list (destroys the unreadable value).';
            banner.appendChild(heading);
            banner.appendChild(detail);

            var resetBtn = document.createElement('button');
            resetBtn.className = 'emby-button raised';
            resetBtn.style.marginTop = '0.6em';
            resetBtn.type = 'button';
            resetBtn.textContent = 'Reset ' + label + ' instances (clears stored value)';
            resetBtn.addEventListener('click', function() {
                Dashboard.confirm(
                    'Reset the corrupt ' + label + ' instance configuration? The stored JSON is unreadable so any instances it contained cannot be recovered. You will need to add them again. The reset takes effect when you click Save.',
                    'Reset Instances',
                    function(confirmed) {
                        if (!confirmed) return;
                        _arrParseOK[type] = true;
                        banner.remove();
                        // On next Save, the empty array will be written and legacy fields cleared normally.
                    }
                );
            });
            banner.appendChild(resetBtn);

            container.appendChild(banner);
        }

        function loadArrInstances(config) {
            var sonarrList = document.querySelector('#sonarrInstancesList');
            var radarrList = document.querySelector('#radarrInstancesList');
            sonarrList.textContent = '';
            radarrList.textContent = '';
            _arrParseOK = { sonarr: true, radarr: true };

            var sonarrInstances = tryParseInstanceList(config.SonarrInstances, 'sonarr', sonarrList);
            var radarrInstances = tryParseInstanceList(config.RadarrInstances, 'radarr', radarrList);

            // Migration: only when parse succeeded AND no instances but legacy fields are populated.
            // Skip migration when parse failed — the legacy fields may be stale or already migrated.
            if (_arrParseOK.sonarr && sonarrInstances.length === 0 && config.SonarrUrl && config.SonarrApiKey) {
                sonarrInstances.push({
                    Name: 'Sonarr',
                    Url: config.SonarrUrl,
                    ApiKey: config.SonarrApiKey,
                    UrlMappings: config.SonarrUrlMappings || ''
                });
            }
            if (_arrParseOK.radarr && radarrInstances.length === 0 && config.RadarrUrl && config.RadarrApiKey) {
                radarrInstances.push({
                    Name: 'Radarr',
                    Url: config.RadarrUrl,
                    ApiKey: config.RadarrApiKey,
                    UrlMappings: config.RadarrUrlMappings || ''
                });
            }

            sonarrInstances.forEach(function(inst) {
                sonarrList.appendChild(createInstanceCard('sonarr', inst));
            });
            radarrInstances.forEach(function(inst) {
                radarrList.appendChild(createInstanceCard('radarr', inst));
            });
        }

        // Requests Page requirements line — hides once at least one of Sonarr/Radarr
        // AND Seerr have URL + API key configured (Sonarr and Radarr are each optional
        // on their own — the backend just skips whichever one is unconfigured — but at
        // least one of the two is needed for the page to show anything). Shows a dynamic
        // list of what's still missing otherwise. The surrounding info banner itself
        // stays visible; only the "Requirements:" sentence toggles. Runs off the live DOM
        // so typing a URL/API key updates immediately without needing a save-and-reload.
        function updateRequestsRequirementsBanner() {
            var line = document.getElementById('requestsPageRequirementsLine');
            if (!line) return;
            var list = document.getElementById('requestsPageRequirementsList');

            function hasCompleteInstance(listId) {
                var root = document.getElementById(listId);
                if (!root) return false;
                // Walk each instance card (the <details class="arr-instance-card"> element
                // built by createInstanceCard). Matching on the real card wrapper avoids
                // closest() landing on the inner .inputContainer div, which only contains
                // the URL input and misses the API-key sibling.
                var cards = root.querySelectorAll('.arr-instance-card');
                for (var i = 0; i < cards.length; i++) {
                    var urlEl = cards[i].querySelector('.arr-instance-url');
                    var apiEl = cards[i].querySelector('.arr-instance-apikey');
                    var url = urlEl ? (urlEl.value || '').trim() : '';
                    var api = apiEl ? (apiEl.value || '').trim() : '';
                    if (url && api) return true;
                }
                return false;
            }

            var sonarrOK = hasCompleteInstance('sonarrInstancesList');
            var radarrOK = hasCompleteInstance('radarrInstancesList');
            var seerrUrlsEl = document.getElementById('jellyseerrUrls');
            var seerrKeyEl = document.getElementById('JellyseerrApiKey');
            var seerrOK = seerrUrlsEl && (seerrUrlsEl.value || '').trim().length > 0 &&
                          seerrKeyEl && (seerrKeyEl.value || '').trim().length > 0;

            if ((sonarrOK || radarrOK) && seerrOK) {
                line.style.display = 'none';
                return;
            }

            var missing = [];
            if (!sonarrOK && !radarrOK) missing.push('Sonarr or Radarr');
            if (!seerrOK) missing.push('Seerr');
            var missingText;
            if (missing.length === 1) {
                missingText = missing[0] + ' (URL and API key)';
            } else {
                missingText = missing.join(' and ') + ' (URL and API key each)';
            }
            if (list) list.textContent = 'Still to configure: ' + missingText + '.';
            line.style.display = '';
        }

        function collectInstancesFromDom(selector, defaultName) {
            var out = [];
            var incomplete = [];
            document.querySelectorAll(selector).forEach(function(card) {
                var url = card.querySelector('.arr-instance-url').value.trim();
                var apiKey = card.querySelector('.arr-instance-apikey').value.trim();
                if (url && apiKey) {
                    var enabledCb = card.querySelector('.arr-instance-enabled');
                    out.push({
                        Name: card.querySelector('.arr-instance-name').value.trim() || defaultName,
                        Url: url,
                        ApiKey: apiKey,
                        UrlMappings: card.querySelector('.arr-instance-urlmappings').value || '',
                        // Default to true when the checkbox is missing (shouldn't happen, but
                        // guards against DOM surgery from another script).
                        Enabled: enabledCb ? enabledCb.checked : true
                    });
                } else if (url && !apiKey) {
                    // Card has a URL but no API key — it would be silently dropped. Collect the
                    // name so we can warn the admin before the save commits.
                    incomplete.push(card.querySelector('.arr-instance-name').value.trim() || defaultName);
                }
            });
            return { instances: out, incomplete: incomplete };
        }

        function saveArrInstances(config) {
            // Only overwrite stored state when the load parse succeeded. Otherwise leave the stored
            // JSON AND legacy fields untouched so the admin can recover the original value.
            var incompleteWarnings = [];

            if (_arrParseOK.sonarr) {
                var sonarrResult = collectInstancesFromDom('#sonarrInstancesList .arr-instance-card', 'Sonarr');
                var sonarrInstances = sonarrResult.instances;
                sonarrResult.incomplete.forEach(function(name) {
                    incompleteWarnings.push('Sonarr instance "' + name + '" has a URL but no API key, so it was not saved.');
                });
                config.SonarrInstances = JSON.stringify(sonarrInstances);
                if (sonarrInstances.length > 0) {
                    config.SonarrUrl = sonarrInstances[0].Url;
                    config.SonarrApiKey = sonarrInstances[0].ApiKey;
                    config.SonarrUrlMappings = sonarrInstances[0].UrlMappings;
                } else {
                    config.SonarrUrl = '';
                    config.SonarrApiKey = '';
                    config.SonarrUrlMappings = '';
                }
            }

            if (_arrParseOK.radarr) {
                var radarrResult = collectInstancesFromDom('#radarrInstancesList .arr-instance-card', 'Radarr');
                var radarrInstances = radarrResult.instances;
                radarrResult.incomplete.forEach(function(name) {
                    incompleteWarnings.push('Radarr instance "' + name + '" has a URL but no API key, so it was not saved.');
                });
                config.RadarrInstances = JSON.stringify(radarrInstances);
                if (radarrInstances.length > 0) {
                    config.RadarrUrl = radarrInstances[0].Url;
                    config.RadarrApiKey = radarrInstances[0].ApiKey;
                    config.RadarrUrlMappings = radarrInstances[0].UrlMappings;
                } else {
                    config.RadarrUrl = '';
                    config.RadarrApiKey = '';
                    config.RadarrUrlMappings = '';
                }
            }

            return incompleteWarnings;
        }

        // Bind add-instance buttons
        document.querySelector('#addSonarrInstance').addEventListener('click', function() {
            document.querySelector('#sonarrInstancesList').appendChild(
                createInstanceCard('sonarr', { Name: '', Url: '', ApiKey: '', UrlMappings: '' }, true)
            );
            updateAllDependencies();
        });
        document.querySelector('#addRadarrInstance').addEventListener('click', function() {
            document.querySelector('#radarrInstancesList').appendChild(
                createInstanceCard('radarr', { Name: '', Url: '', ApiKey: '', UrlMappings: '' }, true)
            );
            updateAllDependencies();
        });

        /** Reconstructs a Sonarr/Radarr instance's own URL from Seerr's settings shape. */
        function buildArrUrlFromSeerrInstance(inst) {
            var scheme = inst.useSsl ? 'https://' : 'http://';
            var base = (inst.baseUrl || '').trim();
            if (base && base.charAt(0) !== '/') base = '/' + base;
            return scheme + inst.hostname + ':' + inst.port + base;
        }

        /**
         * Wires the "Import from Seerr" button for one *arr type: fetches
         * Seerr's own configured instances (admin-only endpoint, since the
         * response includes each instance's real API key) and shows an
         * inline checklist to import from, skipping ones already present by
         * matching on the reconstructed URL.
         */
        function wireSeerrArrImport(type) {
            var label = type === 'sonarr' ? 'Sonarr' : 'Radarr';
            var importBtn = document.getElementById('import' + label + 'FromSeerr');
            var picker = document.getElementById(type + 'SeerrImportPicker');
            var list = document.getElementById(type + 'InstancesList');
            if (!importBtn || !picker || !list) return;

            importBtn.addEventListener('click', function() {
                // Second click while open just closes it.
                if (picker.style.display !== 'none') {
                    picker.style.display = 'none';
                    picker.innerHTML = '';
                    return;
                }

                picker.innerHTML = '';
                picker.style.display = 'block';
                picker.appendChild(createEl('div', { className: 'fieldDescription', textContent: 'Fetching instances from Seerr...' }));

                Promise.all([
                    ApiClient.ajax({
                        type: 'GET',
                        url: ApiClient.getUrl('/JellyfinEnhanced/jellyseerr/settings/' + type),
                        dataType: 'json'
                    }),
                    ApiClient.ajax({
                        type: 'GET',
                        url: ApiClient.getUrl('/JellyfinEnhanced/jellyfin-urls'),
                        dataType: 'json'
                    }).catch(function() { return {}; }) // best-effort; falls back to an editable guess below
                ]).then(function(results) {
                    var instances = results[0];
                    var jellyfinExternalUrl = results[1] && results[1].externalUrl;
                    var jellyfinInternalUrl = results[1] && results[1].internalUrl;
                    picker.innerHTML = '';
                    if (!Array.isArray(instances) || instances.length === 0) {
                        picker.appendChild(createEl('div', { className: 'fieldDescription', textContent: 'Seerr has no ' + label + ' instances configured.' }));
                        return;
                    }

                    var existingUrls = Array.from(list.querySelectorAll('.arr-instance-url')).map(function(el) { return el.value.trim(); });
                    var rows = [];

                    instances.forEach(function(inst) {
                        var url = buildArrUrlFromSeerrInstance(inst);
                        var alreadyImported = existingUrls.indexOf(url) !== -1;

                        var checkbox = createEl('input', { type: 'checkbox' });
                        checkbox.checked = !alreadyImported;
                        checkbox.disabled = alreadyImported;

                        var title = (inst.name || label) + (inst.is4k ? ' (4K)' : '') + (alreadyImported ? ' (already imported)' : '');
                        var details = url + (inst.activeProfileName ? ' · ' + inst.activeProfileName : '');

                        var textChildren = [
                            createEl('div', { className: 'je-arr-seerr-import-row-title', textContent: title }),
                            createEl('div', { className: 'je-arr-seerr-import-row-summary', textContent: details })
                        ];
                        if (inst.externalUrl) {
                            textChildren.push(createEl('div', { className: 'je-arr-seerr-import-row-summary', textContent: 'public: ' + inst.externalUrl }));
                        }

                        // Seerr's settings endpoint gives us both sides of the arr instance
                        // (internal hostname/port/baseUrl AND externalUrl), so mirror that
                        // with both sides of the Jellyfin URL Mapping too: internal Jellyfin
                        // URL -> internal arr URL, external Jellyfin URL -> external arr URL.
                        // Both prefer values read from Jellyfin's own server-side network
                        // detection (LAN bind address / Published Server URIs) over guessing
                        // from the admin's current browser origin; still editable either way.
                        var jellyfinInternalInput = null;
                        var jellyfinExternalInput = null;
                        if (!alreadyImported) {
                            function mappingCell(defaultValue, placeholder) {
                                return createEl('input', { type: 'text', value: defaultValue, placeholder: placeholder });
                            }

                            jellyfinInternalInput = mappingCell(jellyfinInternalUrl || window.location.origin, 'Your Jellyfin internal/LAN URL');
                            var internalRow = createEl('tr', {}, [
                                createEl('td', { className: 'je-arr-seerr-mapping-row-label', textContent: 'Internal' }),
                                createEl('td', {}, [jellyfinInternalInput]),
                                createEl('td', { className: 'je-arr-seerr-mapping-target', textContent: url })
                            ]);

                            var tableRows = [internalRow];
                            if (inst.externalUrl) {
                                jellyfinExternalInput = mappingCell(jellyfinExternalUrl || window.location.origin, 'Your Jellyfin external/public URL');
                                tableRows.push(createEl('tr', {}, [
                                    createEl('td', { className: 'je-arr-seerr-mapping-row-label', textContent: 'External' }),
                                    createEl('td', {}, [jellyfinExternalInput]),
                                    createEl('td', { className: 'je-arr-seerr-mapping-target', textContent: inst.externalUrl })
                                ]));
                            }

                            var instanceName = inst.name || label;
                            var autoFilledSomething = (jellyfinInternalUrl ? 1 : 0) + (inst.externalUrl && jellyfinExternalUrl ? 1 : 0) > 0;
                            var mappingNote = autoFilledSomething
                                ? 'Auto-filled from Jellyfin\'s network config. Confirm before saving!'
                                : 'Could not auto-detect. Please confirm both URLs before saving.';

                            textChildren.push(createEl('table', { className: 'je-arr-seerr-mapping-table' }, [
                                createEl('thead', {}, [createEl('tr', {}, [
                                    createEl('th', {}),
                                    createEl('th', { textContent: 'Jellyfin' }),
                                    createEl('th', { textContent: instanceName })
                                ])]),
                                createEl('tbody', {}, tableRows)
                            ]));
                            textChildren.push(createEl('div', { className: 'je-arr-seerr-mapping-note', textContent: mappingNote }));
                            textChildren.push(createEl('div', { className: 'je-arr-seerr-mapping-note', textContent: 'You can add more or edit these even after importing.' }));
                        }

                        var rowLabel = createEl('label', {
                            className: 'je-arr-seerr-import-row',
                            style: alreadyImported ? 'opacity:0.55;cursor:default;' : 'cursor:pointer;'
                        }, [checkbox, createEl('div', { className: 'je-arr-seerr-import-row-text' }, textChildren)]);

                        rows.push({ checkbox: checkbox, inst: inst, url: url, jellyfinInternalInput: jellyfinInternalInput, jellyfinExternalInput: jellyfinExternalInput });
                        picker.appendChild(rowLabel);
                    });

                    var importSelectedBtn = createEl('button', { type: 'button', className: 'emby-button raised', textContent: 'Import Selected' });
                    var cancelBtn = createEl('button', { type: 'button', className: 'emby-button raised', textContent: 'Cancel' });
                    picker.appendChild(createEl('div', { style: 'display:flex;gap:0.75em;margin-top:0.75em;' }, [importSelectedBtn, cancelBtn]));

                    cancelBtn.addEventListener('click', function() {
                        picker.style.display = 'none';
                        picker.innerHTML = '';
                    });

                    importSelectedBtn.addEventListener('click', function() {
                        var imported = 0;
                        rows.forEach(function(row) {
                            if (row.checkbox.disabled || !row.checkbox.checked) return;
                            // One line per side the admin confirmed/edited: internal
                            // Jellyfin URL -> internal arr URL, external Jellyfin URL ->
                            // external arr URL. Mirrors the two sides Seerr's own settings
                            // endpoint gave us for the arr instance.
                            var mappingLines = [];
                            var jellyfinInternalUrl = row.jellyfinInternalInput ? row.jellyfinInternalInput.value.trim() : '';
                            if (jellyfinInternalUrl) mappingLines.push(jellyfinInternalUrl + '|' + row.url);
                            var jellyfinExternalUrl = row.jellyfinExternalInput ? row.jellyfinExternalInput.value.trim() : '';
                            if (row.inst.externalUrl && jellyfinExternalUrl) mappingLines.push(jellyfinExternalUrl + '|' + row.inst.externalUrl);
                            var urlMappings = mappingLines.join('\n');
                            list.appendChild(createInstanceCard(type, {
                                Name: row.inst.name || label,
                                Url: row.url,
                                ApiKey: row.inst.apiKey || '',
                                UrlMappings: urlMappings
                            }, false));
                            imported++;
                        });
                        picker.style.display = 'none';
                        picker.innerHTML = '';
                        updateAllDependencies();
                        if (imported > 0) {
                            try {
                                Dashboard.alert({ title: 'Imported', message: imported + ' instance(s) imported from Seerr. Review the URL/API key below, then click Save.' });
                            } catch (e) { /* Dashboard.alert unavailable, non-fatal */ }
                        }
                    });
                }).catch(function(err) {
                    // Same responseText-parsing convention as connectionErrorMessage()
                    // above -- ApiClient.ajax errors expose responseText, not responseJSON.
                    var message = 'Could not fetch instances from Seerr.';
                    try {
                        var txt = err && (err.responseText || (err.response && err.response.text)) || '';
                        if (typeof txt === 'string' && txt.trim().charAt(0) === '{') {
                            var body = JSON.parse(txt);
                            if (body && body.error) message = body.error;
                        }
                    } catch (parseErr) { /* not JSON, use default message */ }
                    picker.innerHTML = '';
                    picker.appendChild(createEl('div', { className: 'fieldDescription', style: 'color:#ff6b6b;', textContent: message }));
                    console.warn('[JE] Seerr ' + type + ' settings import failed:', err);
                });
            });
        }

        wireSeerrArrImport('sonarr');
        wireSeerrArrImport('radarr');

        // ==================== End Multi-Instance Arr Management ====================

        // Cache of the four "JE owns this Custom Tabs entry" booleans from the
        // most recently loaded config. Sync uses these to decide whether a
        // matching CT entry was created by JE (safe to delete) or by the admin
        // (must not touch). saveConfig writes the updated values back as part
        // of its single config write.
        var _jeCustomTabOwnedCache = Object.create(null);

        // Tracks whether the most recent `renderQualityCatOrderAdmin` call ran
        // to completion. If false at save time, we skip writing positional
        // *Order values back to config so a render failure can't clobber the
        // user's saved order with default DOM positions.
        var _qualityCatRenderOK = false;

        // Reorders the admin quality-category rows to match the saved *Order values from the plugin config
        function renderQualityCatOrderAdmin(config) {
            _qualityCatRenderOK = false;
            try {
                var container = document.getElementById('qualityCategoriesAdmin');
                if (!container) return;
                var rows = Array.from(container.querySelectorAll('.je-quality-cat-admin-row'));
                rows.sort(function (a, b) {
                    var aOrder = parseInt(config[a.dataset.orderKey], 10);
                    var bOrder = parseInt(config[b.dataset.orderKey], 10);
                    if (!Number.isFinite(aOrder)) aOrder = parseInt(a.dataset.defaultOrder, 10);
                    if (!Number.isFinite(bOrder)) bOrder = parseInt(b.dataset.defaultOrder, 10);
                    if (aOrder !== bOrder) return aOrder - bOrder;
                    return parseInt(a.dataset.defaultOrder, 10) - parseInt(b.dataset.defaultOrder, 10);
                });
                rows.forEach(function (row) { container.appendChild(row); });
                refreshQualityCatAdminArrows(container);
                _qualityCatRenderOK = true;
            } catch (err) {
                console.error('Jellyfin Enhanced: renderQualityCatOrderAdmin failed; will skip *Order save', err);
            }
        }

        // Updates the disabled/opacity styling on the up/down buttons so the
        // top row can't go up and the bottom row can't go down.
        function refreshQualityCatAdminArrows(container) {
            var rows = container.querySelectorAll('.je-quality-cat-admin-row');
            rows.forEach(function (row, idx) {
                var up = row.querySelector('.je-cat-up');
                var down = row.querySelector('.je-cat-down');
                var first = idx === 0;
                var last = idx === rows.length - 1;
                if (up) {
                    up.disabled = first;
                    up.style.opacity = first ? '0.4' : '1';
                    up.style.cursor = first ? 'not-allowed' : 'pointer';
                }
                if (down) {
                    down.disabled = last;
                    down.style.opacity = last ? '0.4' : '1';
                    down.style.cursor = last ? 'not-allowed' : 'pointer';
                }
            });
        }

        // Wire up/down arrow clicks for the admin quality-category list.
        // Uses event delegation on the container so this only registers once.
        (function () {
            document.addEventListener('click', function (e) {
                var btn = e.target.closest && e.target.closest('#qualityCategoriesAdmin .je-cat-up, #qualityCategoriesAdmin .je-cat-down');
                if (!btn || btn.disabled) return;
                e.preventDefault();
                var row = btn.closest('.je-quality-cat-admin-row');
                if (!row) return;
                var parent = row.parentNode;
                if (!parent) return;
                var isUp = btn.classList.contains('je-cat-up');
                var sibling = isUp ? row.previousElementSibling : row.nextElementSibling;
                if (!sibling || !sibling.classList.contains('je-quality-cat-admin-row')) return;
                if (isUp) {
                    parent.insertBefore(row, sibling);
                } else {
                    parent.insertBefore(sibling, row);
                }
                refreshQualityCatAdminArrows(parent);
            });
        })();

        // MDBList rating sources: key (matches the API's source string), display
        // label, and logo filename (served via the "mdblist-logos" CDN source,
        // see CdnAssetService.cs).
        var MDBLIST_SOURCES = [
            { key: 'tmdb', label: 'TMDB', logo: 'tmdb.png' },
            { key: 'tomatoes', label: 'RT Critic', logo: 'rottentomatoes.png' },
            { key: 'popcorn', label: 'RT Audience', logo: 'rottentomatoes_audience.png' },
            { key: 'imdb', label: 'IMDb', logo: 'imdb.png' },
            { key: 'trakt', label: 'Trakt', logo: 'trakt.png' },
            { key: 'metacritic', label: 'Metascore', logo: 'metacritic.png' },
            { key: 'metacriticuser', label: 'Metacritic User', logo: 'metacritic_audience.png' },
            { key: 'letterboxd', label: 'Letterboxd', logo: 'letterboxd.png' },
            { key: 'rogerebert', label: 'Roger Ebert', logo: 'rogerebert.png' },
            { key: 'myanimelist', label: 'MAL', logo: 'myanimelist.png' },
            { key: 'anilist', label: 'AniList', logo: 'anilist.png' },
            { key: 'master', label: 'Master', logo: 'master.png' },
        ];

        // Builds the checkbox+logo+reorder row list from the saved
        // MdblistRatingsSources comma string; empty means every source is
        // checked, in MDBLIST_SOURCES' built-in order. Rebuilt fresh on every
        // load (unlike the quality-category rows, which reorder fixed static
        // HTML) since the row set itself doesn't otherwise exist in the DOM.
        function renderMdblistSourcesAdmin(config) {
            var container = document.getElementById('mdblistRatingsSourcesAdmin');
            if (!container) return;

            var configured = (config.MdblistRatingsSources || '').split(',')
                .map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
            var knownKeys = MDBLIST_SOURCES.map(function (s) { return s.key; });
            var order = configured.length
                ? configured.filter(function (k) { return knownKeys.indexOf(k) !== -1; })
                : knownKeys.slice();
            // Any known source the admin's saved list doesn't mention (e.g. added
            // to MDBLIST_SOURCES after they last saved) still shows, unchecked if
            // the admin has an explicit (non-empty) list, checked otherwise.
            knownKeys.forEach(function (k) { if (order.indexOf(k) === -1) order.push(k); });

            container.innerHTML = '';
            order.forEach(function (key) {
                var meta = MDBLIST_SOURCES.filter(function (s) { return s.key === key; })[0];
                if (!meta) return;
                var checked = configured.length === 0 || configured.indexOf(key) !== -1;

                var row = document.createElement('div');
                row.className = 'je-quality-cat-admin-row';
                row.dataset.sourceKey = key;

                var checkboxContainer = document.createElement('div');
                checkboxContainer.className = 'checkboxContainer';
                var label = document.createElement('label');
                var checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'je-mdblist-source-toggle';
                checkbox.checked = checked;
                var img = document.createElement('img');
                img.src = jeCdnUrl('mdblist-logos/' + meta.logo);
                img.alt = '';
                img.style.cssText = 'height:16px;vertical-align:middle;margin:0 8px;';
                var span = document.createElement('span');
                span.textContent = meta.label;
                label.appendChild(checkbox);
                label.appendChild(img);
                label.appendChild(span);
                checkboxContainer.appendChild(label);
                row.appendChild(checkboxContainer);

                var upBtn = document.createElement('button');
                upBtn.type = 'button';
                upBtn.className = 'raised raised-mini je-cat-up';
                upBtn.setAttribute('aria-label', 'Move up');
                upBtn.innerHTML = '<i class="material-icons" aria-hidden="true">arrow_upward</i>';
                var downBtn = document.createElement('button');
                downBtn.type = 'button';
                downBtn.className = 'raised raised-mini je-cat-down';
                downBtn.setAttribute('aria-label', 'Move down');
                downBtn.innerHTML = '<i class="material-icons" aria-hidden="true">arrow_downward</i>';
                row.appendChild(upBtn);
                row.appendChild(downBtn);

                container.appendChild(row);
            });
            refreshQualityCatAdminArrows(container);
        }

        // Reads the current row order + checked state back into the
        // comma-separated MdblistRatingsSources string at save time.
        function computeMdblistRatingsSources() {
            var container = document.getElementById('mdblistRatingsSourcesAdmin');
            if (!container) return '';
            var rows = Array.from(container.querySelectorAll('.je-quality-cat-admin-row'));
            return rows.filter(function (row) {
                var cb = row.querySelector('.je-mdblist-source-toggle');
                return cb && cb.checked;
            }).map(function (row) { return row.dataset.sourceKey; }).join(',');
        }

        // Wire up/down arrow clicks for the MDBList sources list (delegated,
        // mirrors the quality-category handler above -- reuses the same
        // refreshQualityCatAdminArrows for the disabled-at-the-ends styling).
        (function () {
            document.addEventListener('click', function (e) {
                var btn = e.target.closest && e.target.closest('#mdblistRatingsSourcesAdmin .je-cat-up, #mdblistRatingsSourcesAdmin .je-cat-down');
                if (!btn || btn.disabled) return;
                e.preventDefault();
                var row = btn.closest('.je-quality-cat-admin-row');
                if (!row) return;
                var parent = row.parentNode;
                if (!parent) return;
                var isUp = btn.classList.contains('je-cat-up');
                var sibling = isUp ? row.previousElementSibling : row.nextElementSibling;
                if (!sibling || !sibling.classList.contains('je-quality-cat-admin-row')) return;
                if (isUp) { parent.insertBefore(row, sibling); } else { parent.insertBefore(sibling, row); }
                refreshQualityCatAdminArrows(parent);
            });
        })();

        // Fallback used only if the CDN regions.txt fetch fails - mirrors js/elsewhere/elsewhere.js's fallback list.
        var JE_FALLBACK_REGIONS = {
            'US': 'United States', 'GB': 'United Kingdom', 'IN': 'India', 'CA': 'Canada',
            'DE': 'Germany', 'FR': 'France', 'JP': 'Japan', 'AU': 'Australia',
            'BR': 'Brazil', 'MX': 'Mexico', 'IE': 'Ireland', 'IT': 'Italy',
            'ES': 'Spain', 'NL': 'Netherlands', 'SE': 'Sweden', 'NO': 'Norway',
            'DK': 'Denmark', 'FI': 'Finland'
        };

        // Renders the Default Region <select> from a {code: name} map, preserving whichever
        // code should end up selected. Only falls back to 'US' when there was no existing
        // selection to preserve - an existing valid-but-uncommon code (e.g. one missing from
        // the small hardcoded fallback list, or if the CDN regions.txt is unreachable) is kept
        // as a synthetic option rather than silently swapped for 'US' and lost on next Save.
        function renderRegionOptions(regionsMap, selectedCode) {
            const select = document.querySelector('#DEFAULT_REGION');
            if (!select) return;
            const wanted = selectedCode ? selectedCode.toUpperCase() : 'US';
            const map = regionsMap[wanted] ? regionsMap : { ...regionsMap, [wanted]: wanted };
            while (select.firstChild) select.removeChild(select.firstChild);
            Object.entries(map)
                .sort((a, b) => a[1].localeCompare(b[1]))
                .forEach(([code, name]) => {
                    const option = document.createElement('option');
                    option.value = code;
                    option.textContent = name;
                    select.appendChild(option);
                });
            select.value = wanted;
        }

        // Populates the Default Region dropdown from the same CDN resource js/elsewhere/elsewhere.js
        // uses for its per-item region picker, so admins can only ever pick a code that TMDB's
        // watch/providers response is actually keyed by - no more free-text region typos.
        function populateRegionSelect(selectedCode) {
            renderRegionOptions(JE_FALLBACK_REGIONS, selectedCode);
            fetch(jeCdnUrl('elsewhere-res/regions.txt'))
                .then(response => response.ok ? response.text() : Promise.reject())
                .then(text => {
                    const regionsMap = {};
                    text.trim().split('\n').forEach(line => {
                        if (line.startsWith('#')) return;
                        const [code, name] = line.split('\t');
                        if (code && name) regionsMap[code] = name;
                    });
                    renderRegionOptions(regionsMap, selectedCode);
                })
                .catch(() => {
                    // Already rendered with JE_FALLBACK_REGIONS above.
                });
        }

        /**
         * Selects `value` in the sound-tag audio language dropdown. A code the
         * culture list does not offer (a hand-edited pt-BR, or the list has not
         * loaded / failed to load) is parked as a bare option so it stays
         * selected and a save cannot silently reset it to "no preference".
         * @param {HTMLSelectElement|null} select
         * @param {string} value
         */
        function applyQualityAudioLanguage(select, value) {
            if (!select) return;
            const saved = value || '';
            if (saved && !Array.from(select.options).some(o => o.value === saved)) {
                const option = document.createElement('option');
                option.value = saved;
                option.textContent = saved;
                option.dataset.jePlaceholder = '1';
                select.appendChild(option);
            }
            select.value = saved;
        }

        // SpoilerAutoEnableLibraryIds as loaded, and whether the checkbox
        // list has been rendered from it yet. Until it has (VirtualFolders
        // still loading, or failed) a save round-trips the stored value
        // untouched instead of silently resetting it to "every library".
        var _spoilerAutoEnableLibrariesRaw = '';
        var _spoilerAutoEnableLibrariesRendered = false;

        /**
         * Renders the Spoiler Guard auto-enable library allow-list as one
         * checkbox per movie / TV / mixed library, pre-ticking the ids stored
         * in SpoilerAutoEnableLibraryIds (comma-separated). Ids that no longer
         * resolve to a library are flagged and dropped on the next save.
         * @param {string} selectedRaw - Stored comma-separated library ids
         */
        function renderSpoilerAutoEnableLibraries(selectedRaw) {
            var host = document.getElementById('spoilerAutoEnableLibraryList');
            if (!host) return;
            _spoilerAutoEnableLibrariesRaw = String(selectedRaw || '');
            _spoilerAutoEnableLibrariesRendered = false;
            var selected = _spoilerAutoEnableLibrariesRaw.split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
            ApiClient.getJSON(ApiClient.getUrl('Library/VirtualFolders')).then(function (folders) {
                host.innerHTML = '';
                var eligible = (folders || []).filter(function (f) {
                    var t = (f.CollectionType || '').toLowerCase();
                    // Untyped ("mixed") libraries can hold both shows and movies.
                    return f.ItemId && (t === 'tvshows' || t === 'movies' || t === '');
                });
                var known = {};
                eligible.forEach(function (f) {
                    var id = String(f.ItemId).replace(/-/g, '').toLowerCase();
                    known[id] = true;
                    var wrap = document.createElement('div');
                    wrap.className = 'checkboxContainer';
                    var label = document.createElement('label');
                    var input = document.createElement('input');
                    input.setAttribute('is', 'emby-checkbox');
                    input.type = 'checkbox';
                    input.className = 'spoilerAutoEnableLibrary';
                    input.setAttribute('data-library-id', f.ItemId);
                    input.checked = selected.indexOf(id) !== -1;
                    var span = document.createElement('span');
                    var type = (f.CollectionType || '').toLowerCase();
                    span.textContent = f.Name + (type === 'tvshows' ? ' (TV shows)' : type === 'movies' ? ' (Movies)' : ' (Mixed)');
                    label.appendChild(input);
                    label.appendChild(span);
                    wrap.appendChild(label);
                    host.appendChild(wrap);
                });
                if (!eligible.length) {
                    host.innerHTML = '<div class="fieldDescription">No movie or TV libraries found.</div>';
                }
                // Ids saved earlier whose library has since been deleted: the
                // server can't match them (so, if they were the only ones,
                // nothing auto-enables) until the admin saves again.
                var stale = selected.filter(function (id) { return !known[id]; });
                if (stale.length) {
                    var note = document.createElement('div');
                    note.className = 'fieldDescription';
                    note.textContent = stale.length === 1
                        ? '1 previously selected library no longer exists and will be dropped when you save.'
                        : stale.length + ' previously selected libraries no longer exist and will be dropped when you save.';
                    host.appendChild(note);
                }
                _spoilerAutoEnableLibrariesRendered = true;
            }).catch(function () {
                host.innerHTML = '<div class="fieldDescription">Could not load the library list. Saving keeps the current selection.</div>';
            });
        }

        /**
         * Collects the ticked auto-enable libraries back into the stored
         * comma-separated form (dashless lowercase ids, matching Jellyfin's
         * VirtualFolders ItemId format). Empty string = every library. If the
         * list hasn't rendered, returns the stored value unchanged.
         * @returns {string}
         */
        function collectSpoilerAutoEnableLibraries() {
            if (!_spoilerAutoEnableLibrariesRendered) return _spoilerAutoEnableLibrariesRaw;
            var ids = [];
            document.querySelectorAll('#spoilerAutoEnableLibraryList input.spoilerAutoEnableLibrary').forEach(function (el) {
                if (el.checked) ids.push(String(el.getAttribute('data-library-id') || '').replace(/-/g, '').toLowerCase());
            });
            return ids.filter(Boolean).join(',');
        }

        /**
         * Plain-text summary of an "apply to existing titles" run from the
         * server (SpoilerExistingTitlesApplier.Summary, PascalCase like the
         * rest of Jellyfin's JSON).
         * @param {Object} s - Run summary
         * @returns {string}
         */
        function describeSpoilerApplyExistingRun(s) {
            var armed = (s.SeriesArmed || 0) + (s.MoviesArmed || 0);
            var parts = [armed + ' Spoiler Guard entr' + (armed === 1 ? 'y' : 'ies') + ' added (' + (s.SeriesArmed || 0) + ' series, ' + (s.MoviesArmed || 0) + ' movies) for ' + (s.UsersAffected || 0) + ' user' + (s.UsersAffected === 1 ? '' : 's')];
            parts.push((s.AlreadyArmed || 0) + ' already guarded');
            parts.push((s.SkippedWatched || 0) + ' fully watched');
            if (s.SkipStarted) parts.push((s.SkippedStarted || 0) + ' started');
            var text = parts.join(', ') + ' skipped.';
            if (s.UsersFailed) text += ' ' + s.UsersFailed + ' user' + (s.UsersFailed === 1 ? '' : 's') + ' could not be updated (see the server log).';
            return text;
        }

        /**
         * Joins plain-text lines into the HTML body Jellyfin's alert/confirm
         * dialogs render (they treat the message as sanitized HTML, so plain
         * newlines collapse). Each line is escaped; user names come from the server.
         * @param {string[]} lines - Plain-text lines ('' = blank line)
         * @returns {string}
         */
        function spoilerApplyExistingLinesHtml(lines) {
            var div = document.createElement('div');
            return lines.map(function (line) {
                div.textContent = line;
                return div.innerHTML;
            }).join('<br>');
        }

        /**
         * Resolves to the `message` of a failed JellyfinEnhanced API call
         * (ApiClient rejects with the fetch Response), or null.
         * @param {*} err - Rejection value from ApiClient.getJSON / ajax
         * @returns {Promise<string|null>}
         */
        function spoilerApplyExistingErrorMessage(err) {
            if (!err || typeof err.json !== 'function') return Promise.resolve(null);
            return err.json().then(function (body) { return (body && body.message) || null; }, function () { return null; });
        }

        /**
         * Polls the apply-to-existing-titles status until the run started by
         * this page has finished, mirroring progress and then the result into
         * the status line under the button.
         * @param {number} completedRunsBefore - Server's finished-run counter just before this run started
         */
        function pollSpoilerApplyExisting(completedRunsBefore) {
            var statusEl = document.getElementById('spoilerApplyExistingStatus');
            var btn = document.getElementById('spoilerApplyExistingBtn');
            var idleTicks = 0;
            var tick = function () {
                ApiClient.getJSON(ApiClient.getUrl('JellyfinEnhanced/spoiler-blur/apply-existing/status')).then(function (st) {
                    var finished = st.completedRuns > completedRunsBefore && st.lastRun;
                    if (!finished) {
                        // Idle without a new result for a while: the task
                        // never ran (or the server restarted); stop polling.
                        idleTicks = st.state === 'Idle' ? idleTicks + 1 : 0;
                        if (idleTicks > 10) {
                            btn.disabled = false;
                            statusEl.textContent = 'The run did not report back; check Dashboard > Scheduled Tasks and the server log.';
                            return;
                        }
                        statusEl.textContent = 'Applying… ' + (typeof st.progress === 'number' ? Math.round(st.progress) + '%' : '');
                        setTimeout(tick, 1000);
                        return;
                    }
                    var last = st.lastRun;
                    btn.disabled = false;
                    if (last.Error) {
                        statusEl.textContent = 'Apply failed: ' + last.Error;
                    } else if (last.Cancelled) {
                        statusEl.textContent = 'Cancelled. Users processed before the cancel keep their new entries; run it again to finish (nothing is added twice).';
                    } else {
                        statusEl.textContent = 'Done in ' + (last.ElapsedMs / 1000).toFixed(1) + ' s. ' + describeSpoilerApplyExistingRun(last);
                    }
                }).catch(function () {
                    btn.disabled = false;
                    statusEl.textContent = 'Lost track of the run; check Dashboard > Scheduled Tasks and the server log.';
                });
            };
            tick();
        }

        /**
         * "Apply to existing titles now…": dry-runs the saved auto-enable
         * scope, shows what would be armed, and on confirmation starts the
         * "Spoiler Guard: apply to existing titles" scheduled task.
         */
        (function wireSpoilerApplyExisting() {
            var btn = document.getElementById('spoilerApplyExistingBtn');
            var statusEl = document.getElementById('spoilerApplyExistingStatus');
            if (!btn || !statusEl) return;
            btn.addEventListener('click', function () {
                if (document.querySelector('.je-save-dock.je-dirty')) {
                    Dashboard.alert({ title: 'Save first', message: 'This uses the saved auto-enable settings. Save your changes, then try again.' });
                    return;
                }
                var skipStarted = !!(document.getElementById('spoilerApplyExistingSkipStarted') || {}).checked;
                btn.disabled = true;
                statusEl.textContent = 'Counting titles…';
                var previewUrl = ApiClient.getUrl('JellyfinEnhanced/spoiler-blur/apply-existing/preview', { skipStarted: skipStarted });
                ApiClient.getJSON(previewUrl).then(function (p) {
                    statusEl.textContent = '';
                    var armed = (p.SeriesArmed || 0) + (p.MoviesArmed || 0);
                    var scope = 'In the saved scope: ' + p.SeriesInScope + ' series and ' + p.MoviesInScope + ' movies.';
                    var skipped = 'Skipped: ' + (p.AlreadyArmed || 0) + ' already guarded, ' + (p.SkippedWatched || 0) + ' fully watched' + (p.SkipStarted ? ', ' + (p.SkippedStarted || 0) + ' started' : '') + '.'
                        + (p.UsersFailed ? ' ' + p.UsersFailed + ' user' + (p.UsersFailed === 1 ? '' : 's') + ' could not be read (see the server log).' : '');
                    if (armed === 0) {
                        btn.disabled = false;
                        Dashboard.alert({ title: 'Nothing to apply', message: spoilerApplyExistingLinesHtml([scope, '', 'Every user who can see them already has them guarded or has watched them.', skipped]) });
                        return;
                    }
                    var lines = [
                        scope,
                        '',
                        'This adds ' + armed + ' Spoiler Guard entr' + (armed === 1 ? 'y' : 'ies') + ', one per title per user (' + p.SeriesArmed + ' series, ' + p.MoviesArmed + ' movies), for ' + p.UsersAffected + ' user' + (p.UsersAffected === 1 ? '' : 's') + ':'
                    ];
                    (p.PerUser || []).forEach(function (u) {
                        var n = u.Series + u.Movies;
                        if (n > 0) lines.push('• ' + u.UserName + (u.IsDisabled ? ' (disabled)' : '') + ': ' + n + ' (' + u.Series + ' series, ' + u.Movies + ' movies)');
                    });
                    lines.push('');
                    lines.push(skipped);
                    lines.push('Users can switch it off again per title. Running this again later re-arms titles they switched off, unless they have watched them.');
                    Dashboard.confirm(spoilerApplyExistingLinesHtml(lines), 'Apply Spoiler Guard to existing titles?', function (confirmed) {
                        if (!confirmed) { btn.disabled = false; return; }
                        statusEl.textContent = 'Starting…';
                        ApiClient.ajax({
                            type: 'POST',
                            url: ApiClient.getUrl('JellyfinEnhanced/spoiler-blur/apply-existing', { skipStarted: skipStarted }),
                            dataType: 'json'
                        }).then(function (res) {
                            if (res && typeof res.completedRuns === 'number') {
                                pollSpoilerApplyExisting(res.completedRuns);
                            } else {
                                btn.disabled = false;
                                statusEl.textContent = 'Started. Follow it in Dashboard > Scheduled Tasks.';
                            }
                        }).catch(function (err) {
                            spoilerApplyExistingErrorMessage(err).then(function (msg) {
                                btn.disabled = false;
                                statusEl.textContent = 'Could not start the run: ' + (msg || 'see Dashboard > Scheduled Tasks and the server log.');
                            });
                        });
                    });
                }).catch(function (err) {
                    spoilerApplyExistingErrorMessage(err).then(function (msg) {
                        btn.disabled = false;
                        statusEl.textContent = 'Could not count titles: ' + (msg || 'check the server log.');
                    });
                });
            });
        })();

        function loadConfig() {
            Dashboard.showLoadingMsg();
            checkInstalledPlugins();
            ApiClient.getPluginConfiguration(pluginId).then((config) => {
                CUSTOM_TAB_MANAGED_ENTRIES.forEach(function(entry) {
                    _jeCustomTabOwnedCache[entry.ownedKey] = config[entry.ownedKey] === true;
                });
                const savedShortcuts = (config.Shortcuts && config.Shortcuts.length > 0) ? config.Shortcuts : defaultShortcuts;
                shortcutOverrides = savedShortcuts.filter(saved => {
                    const def = defaultShortcuts.find(d => d.Name === saved.Name);
                    return !def || saved.Key !== def.Key;
                });

                renderOverrides();
                populateAddShortcutDropdown();

                // Load all other settings
                document.querySelector('#devMode').checked = config.DevMode;
                document.querySelector('#maintenanceModeEnabled').checked = config.MaintenanceModeEnabled || false;
                document.querySelector('#maintenanceModeEnabled').dataset.jeLoaded = String(config.MaintenanceModeEnabled === true);
                document.querySelector('#maintenanceModeMessage').value = config.MaintenanceModeMessage || '';
                document.querySelector('#maintenanceModeNotificationMessage').value = config.MaintenanceModeNotificationMessage || '';
                document.querySelector('#maintenanceModeDurationMinutes').value = config.MaintenanceModeDurationMinutes || 0;
                document.querySelector('#maintenanceModeRemindOnPlayback').checked = config.MaintenanceModeRemindOnPlayback || false;
                document.querySelector('#maintenanceScheduleEnabled').checked = config.MaintenanceScheduleEnabled || false;
                document.querySelector('#maintenanceScheduleStart').value = config.MaintenanceScheduleStart || '00:00';
                document.querySelector('#maintenanceScheduleEnd').value = config.MaintenanceScheduleEnd || '08:00';
                updateMaintenanceScheduleWarning();
                refreshMaintenanceServerTime();
                document.querySelector('#maintenanceScheduleMessage').value = config.MaintenanceScheduleMessage || '';
                document.querySelector('#maintenanceScheduleNotificationMessage').value = config.MaintenanceScheduleNotificationMessage || '';
                const savedSchedAction = config.MaintenanceScheduleAction || 'none';
                document.getElementById('mmSchedAction_accounts').checked = savedSchedAction === 'disable_accounts' || savedSchedAction === 'both';
                document.getElementById('mmSchedAction_remote').checked   = savedSchedAction === 'disable_remote'   || savedSchedAction === 'both';
                // Restore action checkboxes
                const savedAction = config.MaintenanceModeAction || 'disable_accounts';
                document.getElementById('mmAction_accounts').checked = savedAction === 'disable_accounts' || savedAction === 'both';
                document.getElementById('mmAction_remote').checked   = savedAction === 'disable_remote'   || savedAction === 'both';
                // Restore user selection radio + checkboxes
                const savedUsers = config.MaintenanceModeAffectedUsers || 'all';
                if (savedUsers === 'all') {
                    document.querySelector('#mmUsers_all').checked = true;
                    document.getElementById('je-mm-user-list').style.display = 'none';
                } else {
                    document.querySelector('#mmUsers_select').checked = true;
                    document.getElementById('je-mm-user-list').style.display = '';
                    // Preselected IDs will be applied after the user list loads
                    document.getElementById('je-mm-user-list').dataset.preselect = savedUsers;
                }
                loadMaintenanceUsers();
                document.querySelector('#enableCustomSplashScreen').checked = config.EnableCustomSplashScreen;
                document.querySelector('#splashScreenImageUrl').value = config.SplashScreenImageUrl;
                document.querySelector('#disableAllShortcuts').checked = config.DisableAllShortcuts;
                document.querySelector('#ToastDuration').value = config.ToastDuration;
                document.querySelector('#HelpPanelAutocloseDelay').value = config.HelpPanelAutocloseDelay;
                document.querySelector('#elsewhereEnabled').checked = config.ElsewhereEnabled;
                document.querySelector('#TMDB_API_KEY').value = config.TMDB_API_KEY;
                populateRegionSelect(config.DEFAULT_REGION);
                document.querySelector('#DEFAULT_PROVIDERS').value = config.DEFAULT_PROVIDERS;
                document.querySelector('#IGNORE_PROVIDERS').value = config.IGNORE_PROVIDERS;
                document.querySelector('#ElsewhereCustomBrandingText').value = config.ElsewhereCustomBrandingText || '';
                document.querySelector('#ElsewhereCustomBrandingImageUrl').value = config.ElsewhereCustomBrandingImageUrl || '';
                document.querySelector('#jellyseerr_TMDB_API_KEY').value = config.TMDB_API_KEY;

                // Set up bidirectional sync between TMDB API key fields
                const tmdbKeyField = document.querySelector('#TMDB_API_KEY');
                const jellyseerrTmdbKeyField = document.querySelector('#jellyseerr_TMDB_API_KEY');

                tmdbKeyField.addEventListener('input', function() {
                    jellyseerrTmdbKeyField.value = this.value;
                });

                jellyseerrTmdbKeyField.addEventListener('input', function() {
                    tmdbKeyField.value = this.value;
                });
                document.querySelector('#autoPauseEnabled').checked = config.AutoPauseEnabled;
                document.querySelector('#autoResumeEnabled').checked = config.AutoResumeEnabled;
                document.querySelector('#autoPipEnabled').checked = config.AutoPipEnabled;
                document.querySelector('#autoSkipIntro').checked = config.AutoSkipIntro;
                document.querySelector('#autoSkipOutro').checked = config.AutoSkipOutro;
                document.querySelector('#longPress2xEnabled').checked = config.LongPress2xEnabled;
                document.querySelector('#randomButtonEnabled').checked = config.RandomButtonEnabled;
                document.querySelector('#randomIncludeMovies').checked = config.RandomIncludeMovies;
                document.querySelector('#randomIncludeShows').checked = config.RandomIncludeShows;
                document.querySelector('#randomUnwatchedOnly').checked = config.RandomUnwatchedOnly;
                document.querySelector('#randomScopeCurrentContainer').checked = config.RandomScopeCurrentContainer;
                document.querySelector('#showWatchProgress').checked = config.ShowWatchProgress;
                document.querySelector('#watchProgressDefaultMode').value = (config.WatchProgressDefaultMode || 'percentage');
                document.querySelector('#watchProgressTimeFormat').value = (config.WatchProgressTimeFormat || 'hours');
                document.querySelector('#showFileSizes').checked = config.ShowFileSizes;
                document.querySelector('#showAudioLanguages').checked = config.ShowAudioLanguages;
                document.querySelector('#removeContinueWatchingEnabled').checked = config.RemoveContinueWatchingEnabled;
                document.querySelector('#qualityTagsEnabled').checked = config.QualityTagsEnabled;
                document.querySelector('#showResolutionTag').checked = config.ShowResolutionTag !== false;
                document.querySelector('#showSourceTag').checked = config.ShowSourceTag !== false;
                document.querySelector('#showDynamicRangeTag').checked = config.ShowDynamicRangeTag !== false;
                document.querySelector('#showSpecialFormatTag').checked = config.ShowSpecialFormatTag !== false;
                document.querySelector('#showVideoCodecTag').checked = config.ShowVideoCodecTag !== false;
                document.querySelector('#showAudioInfoTag').checked = config.ShowAudioInfoTag !== false;
                // Restore stack order: rows are visually reordered to match
                // current saved order values (ties broken by default order).
                if (typeof renderQualityCatOrderAdmin === 'function') renderQualityCatOrderAdmin(config);
                document.querySelector('#genreTagsEnabled').checked = config.GenreTagsEnabled;
                document.querySelector('#peopleTagsEnabled').checked = config.PeopleTagsEnabled;
                const qPos = (config.QualityTagsPosition || 'top-left');
                const gPos = (config.GenreTagsPosition || 'top-right');
                const lPos = (config.LanguageTagsPosition || 'bottom-left');
                const rPos = (config.RatingTagsPosition || 'bottom-right');
                const arPos = (config.AgeRatingTagsPosition || 'bottom-right');
                const langEnabled = !!config.LanguageTagsEnabled;
                const ratingEnabled = !!config.RatingTagsEnabled;
                const ageRatingEnabled = !!config.AgeRatingTagsEnabled;
                const peopleEnabled = !!config.PeopleTagsEnabled;
                const showRatingInPlayer = config.ShowRatingInPlayer !== false;
                const qSel = document.querySelector('#qualityTagsPosition');
                const gSel = document.querySelector('#genreTagsPosition');
                const lSel = document.querySelector('#languageTagsPosition');
                const rSel = document.querySelector('#ratingTagsPosition');
                const arSel = document.querySelector('#ageRatingTagsPosition');
                const lChk = document.querySelector('#languageTagsEnabled');
                const rChk = document.querySelector('#ratingTagsEnabled');
                const arChk = document.querySelector('#ageRatingTagsEnabled');
                const rPlayerChk = document.querySelector('#showRatingInPlayer');
                if (qSel) qSel.value = qPos;
                if (gSel) gSel.value = gPos;
                if (lSel) lSel.value = lPos;
                if (rSel) rSel.value = rPos;
                if (arSel) arSel.value = arPos;
                if (lChk) lChk.checked = langEnabled;
                document.querySelector('#languageTagsPriority').value = config.LanguageTagsPriority || '';
                document.querySelector('#languageTagsPriorityStrict').checked = config.LanguageTagsPriorityStrict === true;
                const qualityAudioLangSelect = document.querySelector('#qualityTagsPreferredAudioLanguage');
                // The culture list loads asynchronously; keep the value so it can be re-applied once the options exist.
                qualityAudioLangSelect.dataset.savedValue = config.QualityTagsPreferredAudioLanguage || '';
                applyQualityAudioLanguage(qualityAudioLangSelect, qualityAudioLangSelect.dataset.savedValue);
                document.querySelector('#qualityTagsAudioLanguageFromUser').checked = config.QualityTagsAudioLanguageFromUser === true;
                if (rChk) rChk.checked = ratingEnabled;
                if (arChk) arChk.checked = ageRatingEnabled;
                const pChk = document.querySelector('#peopleTagsEnabled');
                if (pChk) pChk.checked = peopleEnabled;
                if (rPlayerChk) rPlayerChk.checked = showRatingInPlayer;
                document.querySelector('#disableTagsOnSearchPage').checked = config.DisableTagsOnSearchPage === true;
                document.querySelector('#tagsHideOnHover').checked = config.TagsHideOnHover === true;
                document.querySelector('#ratingTagsOnMovies').checked = config.RatingTagsOnMovies !== false;
                document.querySelector('#ratingTagsOnSeries').checked = config.RatingTagsOnSeries !== false;
                document.querySelector('#ratingTagsOnSeasons').checked = config.RatingTagsOnSeasons !== false;
                document.querySelector('#ratingTagsOnEpisodes').checked = config.RatingTagsOnEpisodes !== false;
                document.querySelector('#ratingTagsOnContinueWatching').checked = config.RatingTagsOnContinueWatching !== false;
                document.querySelector('#ratingTagsOnNextUp').checked = config.RatingTagsOnNextUp !== false;
                document.querySelector('#tagCacheServerMode').checked = config.TagCacheServerMode !== false;
                document.querySelector('#enableTagsLocalStorageFallback').checked = config.EnableTagsLocalStorageFallback === true;
                document.querySelector('#tagsCacheTtlDays').value = config.TagsCacheTtlDays || 30;
                document.querySelector('#pauseScreenEnabled').checked = config.PauseScreenEnabled;
                document.querySelector('#showPlaybackRatingBadge').checked = config.ShowPlaybackRatingBadge === true;
                document.querySelector('#showReviews').checked = config.ShowReviews;
                document.querySelector('#showAwards').checked = !!config.ShowAwards;
                document.querySelector('#mdblistRatingsEnabled').checked = !!config.MdblistRatingsEnabled;
                document.querySelector('#mdblistApiKey').value = config.MdblistApiKey || '';
                document.querySelector('#mdblistRatingsShowOnItemDetails').checked = config.MdblistRatingsShowOnItemDetails !== false;
                document.querySelector('#mdblistRatingsFetchEnabled').checked = !!config.MdblistRatingsFetchEnabled;
                document.querySelector('#mdblistFetchReserve').value = config.MdblistFetchReserve || 400;
                document.querySelector('#mdblistRatingsAutoSyncEnabled').checked = !!config.MdblistRatingsAutoSyncEnabled;
                document.querySelector('#mdblistRatingsOverwriteExisting').checked = !!config.MdblistRatingsOverwriteExisting;
                if (typeof renderMdblistSourcesAdmin === 'function') renderMdblistSourcesAdmin(config);
                document.querySelector('#mdblistRatingsShowPercentSymbol').checked = !!config.MdblistRatingsShowPercentSymbol;
                if (config.MdblistApiKey && typeof checkMdblistStatus === 'function') checkMdblistStatus();
                document.querySelector('#showUserReviews').checked = !!config.ShowUserReviews;
                document.querySelector('#reviewsExpandedByDefault').checked = config.ReviewsExpandedByDefault;
                document.querySelector('#showReleaseDate').checked = !!config.ShowReleaseDates;
                document.querySelector('#hideReviewsFromHiddenUsers').checked = config.HideReviewsFromHiddenUsers !== false;
                document.querySelector('#hideReviewsFromDisabledUsers').checked = config.HideReviewsFromDisabledUsers !== false;
                document.querySelector('#showUserRatingDash').checked = config.ShowUserRatingDash !== false;
                document.querySelector('#showUserRatingOnPosters').checked = config.ShowUserRatingOnPosters === true;
                document.querySelector('#jellyseerrEnabled').checked = config.JellyseerrEnabled;
                document.querySelector('#showCollectionsInSearch').checked = config.ShowCollectionsInSearch !== false;
                document.querySelector('#jellyseerrShowSearchResults').checked = config.JellyseerrShowSearchResults !== false;
                document.querySelector('#jellyseerrSearchExcludeLibraryItems').checked = config.JellyseerrSearchExcludeLibraryItems === true;
                document.querySelector('#jellyseerrEnable4kRequests').checked = !!config.JellyseerrEnable4KRequests;
                document.querySelector('#jellyseerrEnable4kTvRequests').checked = !!config.JellyseerrEnable4KTvRequests;
                document.querySelector('#jellyseerrUseMoreInfoModal').checked = !!config.JellyseerrUseMoreInfoModal;
                document.querySelector('#jellyseerrAvailablePosterLinksToJellyfin').checked = !!config.JellyseerrAvailablePosterLinksToJellyfin;
                document.querySelector('#jellyseerrShowAdvanced').checked = config.JellyseerrShowAdvanced;
                document.querySelector('#jellyseerrShowQuotaInfo').checked = config.JellyseerrShowQuotaInfo !== false;
                document.querySelector('#jellyseerrShowSimilar').checked = config.JellyseerrShowSimilar !== false;
                document.querySelector('#jellyseerrShowRecommended').checked = config.JellyseerrShowRecommended !== false;
                document.querySelector('#jellyseerrShowRequestMoreOnSeries').checked = config.JellyseerrShowRequestMoreOnSeries !== false;
                document.querySelector('#jellyseerrExcludeLibraryItems').checked = config.JellyseerrExcludeLibraryItems !== false;
                document.querySelector('#jellyseerrShowNetworkDiscovery').checked = config.JellyseerrShowNetworkDiscovery !== false;
                document.querySelector('#jellyseerrShowGenreDiscovery').checked = config.JellyseerrShowGenreDiscovery !== false;
                document.querySelector('#jellyseerrShowTagDiscovery').checked = config.JellyseerrShowTagDiscovery !== false;
                document.querySelector('#jellyseerrShowPersonDiscovery').checked = config.JellyseerrShowPersonDiscovery !== false;
                document.querySelector('#jellyseerrShowCollectionDiscovery').checked = config.JellyseerrShowCollectionDiscovery !== false;
                document.querySelector('#jellyseerrShowReportButton').checked = !!config.JellyseerrShowReportButton;
                document.querySelector('#jellyseerrShowIssueIndicator').checked = !!config.JellyseerrShowIssueIndicator;
                document.querySelector('#jellyseerrShowDetailPageLink').checked = config.JellyseerrShowDetailPageLink !== false;
                document.querySelector('#jellyseerrShowDetailPageLinkAsText').checked = !!config.JellyseerrShowDetailPageLinkAsText;
                document.querySelector('#jellyseerrExcludeBlocklistedItems').checked = !!config.JellyseerrExcludeBlocklistedItems;
                document.querySelector('#jellyseerrDisableCache').checked = !!config.JellyseerrDisableCache;
                document.querySelector('#jellyseerrResponseCacheTtlMinutes').value = config.JellyseerrResponseCacheTtlMinutes || 10;
                document.querySelector('#jellyseerrUserIdCacheTtlMinutes').value = config.JellyseerrUserIdCacheTtlMinutes || 30;
                document.querySelector('#showElsewhereOnJellyseerr').checked = config.ShowElsewhereOnJellyseerr;
                document.querySelector('#jellyseerrUrls').value = config.JellyseerrUrls;
                document.querySelector('#JellyseerrApiKey').value = config.JellyseerrApiKey;
                document.querySelector('#jellyseerrUrlMappings').value = config.JellyseerrUrlMappings || '';
                document.querySelector('#jellyseerr_TMDB_API_KEY').value = config.TMDB_API_KEY;
                document.querySelector('#autoSeasonRequestEnabled').checked = config.AutoSeasonRequestEnabled || false;
                document.querySelector('#autoSeasonRequestRequireAllWatched').checked = config.AutoSeasonRequestRequireAllWatched || false;
                document.querySelector('#autoSeasonRequestThresholdValue').value = config.AutoSeasonRequestThresholdValue || 2;
                document.querySelector('#autoMovieRequestEnabled').checked = config.AutoMovieRequestEnabled || false;
                const triggerType = config.AutoMovieRequestTriggerType || 'OnMinutesWatched';
                document.querySelector('#autoMovieRequestTriggerOnStart').checked = (triggerType === 'OnStart' || triggerType === 'Both');
                document.querySelector('#autoMovieRequestTriggerOnMinutesWatched').checked = (triggerType === 'OnMinutesWatched' || triggerType === 'Both');
                document.querySelector('#autoMovieRequestMinutesWatched').value = config.AutoMovieRequestMinutesWatched || 20;
                document.querySelector('#autoMovieRequestCheckReleaseDate').checked = config.AutoMovieRequestCheckReleaseDate !== false;
                document.querySelector('#autoMovieRequestQualityMode').value = config.AutoMovieRequestQualityMode || 'default';
                document.querySelector('#autoMovieRequestFallbackOn4k').checked = config.AutoMovieRequestFallbackOn4k !== false;
                if ((config.AutoMovieRequestQualityMode || 'default') === 'custom') {
                    document.querySelector('#autoMovieRequestCustomSettings').style.display = 'block';
                    loadAutoMovieRadarrServers(config);
                }
                document.querySelector('#addRequestedMediaToWatchlist').checked = config.AddRequestedMediaToWatchlist || false;
                document.querySelector('#syncJellyseerrWatchlist').checked = config.SyncJellyseerrWatchlist || false;
                document.querySelector('#syncJellyfinWatchlistToSeerr').checked = config.SyncJellyfinWatchlistToSeerr || false;
                document.querySelector('#jellyseerrAutoImportUsers').checked = config.JellyseerrAutoImportUsers || false;
                document.querySelector('#jellyseerrImportBlockedUsers').value = config.JellyseerrImportBlockedUsers || '';
                loadBlockedUsersList(config.JellyseerrImportBlockedUsers || '');
                document.querySelector('#preventWatchlistReAddition').checked = config.PreventWatchlistReAddition !== false;
                document.querySelector('#watchlistMemoryRetentionDays').value = config.WatchlistMemoryRetentionDays || 365;
                document.querySelector('#triggerSeerrScanOnItemAdded').checked = config.TriggerSeerrScanOnItemAdded === true;
                document.querySelector('#seerrScanDebounceSeconds').value = config.SeerrScanDebounceSeconds || 60;
                document.querySelector('#bookmarksEnabled').checked = config.BookmarksEnabled !== false;
                document.querySelector('#bookmarksUsePluginPages').checked = config.BookmarksUsePluginPages === true;
                document.querySelector('#bookmarksUseNativeTab').checked = config.BookmarksUseNativeTab === true;
                document.querySelector('#bookmarksUseCustomTabs').checked = config.BookmarksUseCustomTabs === true;
                var __bAuto = document.querySelector('#bookmarksAutoCreateCustomTab');
                if (__bAuto) __bAuto.checked = config.BookmarksAutoCreateCustomTab === true;
                document.querySelector('#useIcons').checked = config.UseIcons !== false;
                document.querySelector('#iconStyle').value = config.IconStyle || 'emoji';
                document.querySelector('#arrLinksEnabled').checked = config.ArrLinksEnabled;
                document.querySelector('#bazarrUrlMappings').value = config.BazarrUrlMappings || '';
                document.querySelector('#bazarrUrl').value = config.BazarrUrl;
                document.querySelector('#shokoUrlMappings').value = config.ShokoUrlMappings || '';
                document.querySelector('#shokoUrl').value = config.ShokoUrl;
                document.querySelector('#shokoApiKey').value = config.ShokoApiKey;
                document.querySelector('#shokoShowEpisodes').checked = config.ShokoShowEpisodes !== false;
                document.querySelector('#shokoShowSpecials').checked = config.ShokoShowSpecials === true;
                document.querySelector('#shokoShowCredits').checked = config.ShokoShowCredits === true;
                document.querySelector('#shokoShowTrailers').checked = config.ShokoShowTrailers === true;
                document.querySelector('#shokoShowParodies').checked = config.ShokoShowParodies === true;
                document.querySelector('#shokoShowOther').checked = config.ShokoShowOther === true;
                document.querySelector('#showArrLinksAsText').checked = config.ShowArrLinksAsText;
                document.querySelector('#arrLinksShowStatusSingle').checked = config.ArrLinksShowStatusSingle;
                document.querySelector('#arrTagsSyncEnabled').checked = config.ArrTagsSyncEnabled;

                // Load multi-instance Sonarr/Radarr
                loadArrInstances(config);
                document.querySelector('#arrTagsPrefix').value = config.ArrTagsPrefix || 'Requested by: ';
                document.querySelector('#arrTagsClearOldTags').checked = config.ArrTagsClearOldTags !== false;
                document.querySelector('#arrTagsShowAsLinks').checked = config.ArrTagsShowAsLinks !== false;
                document.querySelector('#arrTagsSyncFilter').value = config.ArrTagsSyncFilter || '';
                document.querySelector('#arrTagsLinksFilter').value = config.ArrTagsLinksFilter || '';
                document.querySelector('#arrTagsLinksHideFilter').value = config.ArrTagsLinksHideFilter || '';
                document.querySelector('#DefaultSubtitleStyle').value = config.DefaultSubtitleStyle;
                document.querySelector('#DefaultSubtitleSize').value = config.DefaultSubtitleSize;
                document.querySelector('#DefaultSubtitleFont').value = config.DefaultSubtitleFont;
                document.querySelector('#DefaultSubtitleTextEffect').value = config.DefaultSubtitleTextEffect ?? 0;
                document.querySelector('#disableCustomSubtitleStyles').checked = config.DisableCustomSubtitleStyles;
                document.querySelector('#DefaultLanguage').value = config.DefaultLanguage || '';
                document.querySelector('#letterboxdEnabled').checked = config.LetterboxdEnabled;
                document.querySelector('#showLetterboxdLinkAsText').checked = config.ShowLetterboxdLinkAsText;
                const metadataIconsChk = document.querySelector('#metadataIconsEnabled');
                if (metadataIconsChk) metadataIconsChk.checked = !!config.MetadataIconsEnabled;
                // Tie icon display settings
                if (config.MetadataIconsEnabled) {
                    // Force icon display where applicable
                    const showLbText = document.querySelector('#showLetterboxdLinkAsText');
                    const showArrText = document.querySelector('#showArrLinksAsText');
                    if (showLbText) showLbText.checked = false;
                    if (showArrText) showArrText.checked = false;
                }

                // Load extras settings
                document.querySelector('#coloredRatingsEnabled').checked = config.ColoredRatingsEnabled;
                document.querySelector('#themeSelectorEnabled').checked = config.ThemeSelectorEnabled;
                document.querySelector('#coloredActivityIconsEnabled').checked = config.ColoredActivityIconsEnabled;
                document.querySelector('#pluginIconsEnabled').checked = config.PluginIconsEnabled;
                document.querySelector('#activeStreamsEnabled').checked = config.ActiveStreamsEnabled || false;
                document.querySelector('#activeStreamsAllUsers').checked = config.ActiveStreamsAllUsers || false;
                document.getElementById('activeStreamsAllUsersContainer').style.display = config.ActiveStreamsEnabled ? '' : 'none';
                document.querySelector('#activeStreamsEnabled').addEventListener('change', function() {
                    document.getElementById('activeStreamsAllUsersContainer').style.display = this.checked ? '' : 'none';
                });

                // Usage Statistics (opt-in analytics)
                (function() {
                    var masterEl = document.querySelector('#analyticsEnabled');
                    var subContainer = document.getElementById('analyticsSubOptionsContainer');
                    var flagsEl = document.querySelector('#analyticsShareFeatureFlags');
                    var countsEl = document.querySelector('#analyticsShareUsageCounts');
                    var sizesEl = document.querySelector('#analyticsShareDataSizes');
                    var intervalEl = document.querySelector('#analyticsReportIntervalDays');
                    var previewBtn = document.getElementById('analyticsPreviewBtn');
                    var previewContainer = document.getElementById('analyticsPreviewContainer');
                    var previewJson = document.getElementById('analyticsPreviewJson');
                    var lastSentEl = document.getElementById('analyticsLastSent');

                    masterEl.checked = config.AnalyticsEnabled || false;
                    flagsEl.checked = config.AnalyticsShareFeatureFlags !== false;
                    countsEl.checked = config.AnalyticsShareUsageCounts !== false;
                    sizesEl.checked = config.AnalyticsShareDataSizes !== false;
                    intervalEl.value = config.AnalyticsReportIntervalDays || 15;
                    subContainer.style.display = masterEl.checked ? '' : 'none';

                    if (config.AnalyticsLastReportedAt) {
                        var d = new Date(config.AnalyticsLastReportedAt);
                        lastSentEl.textContent = 'Last report sent: ' + formatDateTimeDMY(d);
                    } else {
                        lastSentEl.textContent = 'No report has been sent yet.';
                    }

                    masterEl.addEventListener('change', function() {
                        subContainer.style.display = this.checked ? '' : 'none';
                        // Once the admin has turned the master on this session,
                        // the save handler must persist AnalyticsHasBeenConfigured
                        // EVEN IF the master is off again at save time — otherwise
                        // an enable -> uncheck a category -> disable -> save
                        // sequence stores the unchecks with the flag still false,
                        // and the next session's enable re-cascades all three
                        // over a recorded opt-out. dataset (not a closure var)
                        // because the save handler lives outside this IIFE.
                        if (this.checked) masterEl.dataset.jeTouched = '1';
                        // First time the admin ever turns this on, default every
                        // sub-category to shared; after that, leave their choices alone.
                        if (this.checked && !config.AnalyticsHasBeenConfigured) {
                            flagsEl.checked = true;
                            countsEl.checked = true;
                            sizesEl.checked = true;
                            // One-shot: mark configured on the page copy too, or an
                            // off/on toggle in the same session re-forces all three
                            // and silently reverts a deliberate uncheck (the server
                            // copy only updates on save, the closure never does).
                            config.AnalyticsHasBeenConfigured = true;
                            // The programmatic .checked writes above fire no change
                            // events, so refresh an open preview by hand — it must
                            // never show less than what would now be sent.
                            if (previewContainer.style.display !== 'none') runPreview();
                        }
                    });

                    // Monotonic token: runPreview has several auto-triggers
                    // (button, sub-toggle changes, the first-enable cascade),
                    // and overlapping responses would otherwise race
                    // last-write-wins — the preview could show a payload
                    // contradicting the current checkboxes.
                    var previewSeq = 0;
                    async function runPreview() {
                        var seq = ++previewSeq;
                        previewBtn.disabled = true;
                        try {
                            var res = await ApiClient.ajax({
                                type: 'POST',
                                url: ApiClient.getUrl('/JellyfinEnhanced/usage/preview'),
                                data: JSON.stringify({
                                    shareFeatureFlags: flagsEl.checked,
                                    shareUsageCounts: countsEl.checked,
                                    shareDataSizes: sizesEl.checked
                                }),
                                contentType: 'application/json',
                                dataType: 'json'
                            });
                            if (seq !== previewSeq) return; // superseded by a newer preview
                            previewJson.textContent = JSON.stringify(res.Payload, null, 2);
                            previewContainer.style.display = '';
                        } catch (err) {
                            if (seq !== previewSeq) return; // superseded by a newer preview
                            // ApiClient.ajax rejects with the fetch Response on a
                            // non-2xx (no .message), so build something readable
                            // instead of "[object Response]".
                            var reason = (err && err.message)
                                || (err && err.status ? 'HTTP ' + err.status + (err.statusText ? ' ' + err.statusText : '') : 'check server logs');
                            previewJson.textContent = 'Failed to build preview: ' + reason;
                            previewContainer.style.display = '';
                        } finally {
                            if (seq === previewSeq) previewBtn.disabled = false;
                        }
                    }

                    previewBtn.addEventListener('click', runPreview);
                    // Re-run automatically once a preview has been shown, so toggling a
                    // sub-option updates it live instead of looking stuck until re-clicked.
                    [flagsEl, countsEl, sizesEl].forEach(function(el) {
                        el.addEventListener('change', function() {
                            if (previewContainer.style.display !== 'none') runPreview();
                        });
                    });
                })();

                document.querySelector('#activityFeedEnabled').checked = config.ActivityFeedEnabled || false;
                document.querySelector('#activityFeedShowWatched').checked = config.ActivityFeedShowWatched !== false;
                document.querySelector('#activityFeedShowFavorited').checked = config.ActivityFeedShowFavorited !== false;
                document.querySelector('#activityFeedShowReviewed').checked = config.ActivityFeedShowReviewed !== false;
                document.querySelector('#activityFeedShowActiveStreams').checked = config.ActivityFeedShowActiveStreams !== false;
                document.querySelector('#activityFeedUseNativeTab').checked = config.ActivityFeedUseNativeTab === true;
                document.querySelector('#activityFeedUsePluginPages').checked = config.ActivityFeedUsePluginPages === true;
                document.querySelector('#activityFeedUseCustomTabs').checked = config.ActivityFeedUseCustomTabs === true;
                var __aAuto = document.querySelector('#activityFeedAutoCreateCustomTab');
                if (__aAuto) __aAuto.checked = config.ActivityFeedAutoCreateCustomTab === true;

                // Requests Page settings
                document.querySelector('#downloadsPageEnabled').checked = config.DownloadsPageEnabled !== false;
                document.querySelector('#showDownloadsInRequests').checked = config.ShowDownloadsInRequests !== false;
                document.querySelector('#downloadsFilterByUserRequests').checked = config.DownloadsFilterByUserRequests !== false;
                document.querySelector('#downloadsPageShowIssues').checked = config.DownloadsPageShowIssues === true;
                document.querySelector('#downloadsShowHistory').checked = config.DownloadsShowHistory !== false;
                document.querySelector('#downloadsHistoryAdminOnly').checked = config.DownloadsHistoryAdminOnly === true;
                document.querySelector('#downloadsUsePluginPages').checked = config.DownloadsUsePluginPages !== false;
                document.querySelector('#downloadsUseNativeTab').checked = config.DownloadsUseNativeTab === true;
                document.querySelector('#downloadsUseCustomTabs').checked = config.DownloadsUseCustomTabs === true;
                var __dAuto = document.querySelector('#downloadsAutoCreateCustomTab');
                if (__dAuto) __dAuto.checked = config.DownloadsAutoCreateCustomTab === true;
                document.querySelector('#downloadsPagePollingEnabled').checked = config.DownloadsPagePollingEnabled !== false;
                document.querySelector('#downloadsPollIntervalSeconds').value = (config.DownloadsPollIntervalSeconds !== undefined && config.DownloadsPollIntervalSeconds !== null) ? config.DownloadsPollIntervalSeconds : 30;

                // Calendar Page settings
                document.querySelector('#calendarPageEnabled').checked = config.CalendarPageEnabled !== false;
                document.querySelector('#calendarUseCustomTabs').checked = config.CalendarUseCustomTabs === true;
                document.querySelector('#calendarUseNativeTab').checked = config.CalendarUseNativeTab === true;
                var __cAuto = document.querySelector('#calendarAutoCreateCustomTab');
                if (__cAuto) __cAuto.checked = config.CalendarAutoCreateCustomTab === true;
                document.querySelector('#calendarUsePluginPages').checked = config.CalendarUsePluginPages !== false;
                document.querySelector('#calendarFirstDayOfWeek').value = config.CalendarFirstDayOfWeek || 'Monday';
                document.querySelector('#calendarTimeFormat').value = config.CalendarTimeFormat || '5pm/5:30pm';
                document.querySelector('#calendarHighlightFavorites').checked = config.CalendarHighlightFavorites || false;
                document.querySelector('#calendarHighlightWatchedSeries').checked = config.CalendarHighlightWatchedSeries || false;
                document.querySelector('#calendarFilterByLibraryAccess').checked = config.CalendarFilterByLibraryAccess !== false;
                document.querySelector('#calendarShowOnlyRequested').checked = config.CalendarShowOnlyRequested || false;
                document.querySelector('#calendarForceOnlyRequested').checked = config.CalendarForceOnlyRequested || false;

                // Recommendations Page settings
                document.querySelector('#recommendationsPageEnabled').checked = config.RecommendationsPageEnabled === true;
                document.querySelector('#recommendationsUseNativeTab').checked = config.RecommendationsUseNativeTab === true;
                document.querySelector('#recommendationsUsePluginPages').checked = config.RecommendationsUsePluginPages === true;
                document.querySelector('#recommendationsUseCustomTabs').checked = config.RecommendationsUseCustomTabs === true;
                var __rAuto = document.querySelector('#recommendationsAutoCreateCustomTab');
                if (__rAuto) __rAuto.checked = config.RecommendationsAutoCreateCustomTab === true;

                // Hidden Content settings
                document.querySelector('#hiddenContentEnabled').checked = config.HiddenContentEnabled || false;
                document.querySelector('#hiddenContentUsePluginPages').checked = config.HiddenContentUsePluginPages === true;
                document.querySelector('#hiddenContentUseNativeTab').checked = config.HiddenContentUseNativeTab === true;
                document.querySelector('#hiddenContentUseCustomTabs').checked = config.HiddenContentUseCustomTabs === true;
                // Admin cross-user view + management; default on for existing configs.
                document.querySelector('#hiddenContentAdmin').checked = config.HiddenContentAdmin !== false;
                var __hAuto = document.querySelector('#hiddenContentAutoCreateCustomTab');
                if (__hAuto) __hAuto.checked = config.HiddenContentAutoCreateCustomTab === true;

                // Hidden Content per-user defaults, same name as on the user side, prefixed HiddenContentDefault*.
                var __hcDefaults = [
                    ['hiddenContentDefaultEnabled', 'HiddenContentDefaultEnabled', true],
                    ['hiddenContentDefaultShowHideButtons', 'HiddenContentDefaultShowHideButtons', true],
                    ['hiddenContentDefaultShowHideConfirmation', 'HiddenContentDefaultShowHideConfirmation', true],
                    ['hiddenContentDefaultShowButtonJellyseerr', 'HiddenContentDefaultShowButtonJellyseerr', true],
                    ['hiddenContentDefaultShowButtonLibrary', 'HiddenContentDefaultShowButtonLibrary', false],
                    ['hiddenContentDefaultShowButtonDetails', 'HiddenContentDefaultShowButtonDetails', true],
                    ['hiddenContentDefaultShowButtonCast', 'HiddenContentDefaultShowButtonCast', false],
                    ['hiddenContentDefaultFilterLibrary', 'HiddenContentDefaultFilterLibrary', true],
                    ['hiddenContentDefaultFilterDiscovery', 'HiddenContentDefaultFilterDiscovery', true],
                    ['hiddenContentDefaultFilterSearch', 'HiddenContentDefaultFilterSearch', false],
                    ['hiddenContentDefaultFilterCalendar', 'HiddenContentDefaultFilterCalendar', true],
                    ['hiddenContentDefaultFilterUpcoming', 'HiddenContentDefaultFilterUpcoming', true],
                    ['hiddenContentDefaultFilterRecommendations', 'HiddenContentDefaultFilterRecommendations', true],
                    ['hiddenContentDefaultFilterRequests', 'HiddenContentDefaultFilterRequests', true],
                    ['hiddenContentDefaultFilterNextUp', 'HiddenContentDefaultFilterNextUp', true],
                    ['hiddenContentDefaultFilterContinueWatching', 'HiddenContentDefaultFilterContinueWatching', true],
                    ['hiddenContentDefaultExperimentalHideCollections', 'HiddenContentDefaultExperimentalHideCollections', false],
                ];
                __hcDefaults.forEach(function(t) {
                    var el = document.querySelector('#' + t[0]);
                    if (!el) return;
                    var v = config[t[1]];
                    el.checked = (v === undefined || v === null) ? t[2] : !!v;
                });

                // Spoiler Guard settings
                document.querySelector('#spoilerBlurEnabled').checked = config.SpoilerBlurEnabled === true;
                var __sbSigma = document.querySelector('#spoilerBlurIntensity');
                if (__sbSigma) __sbSigma.value = (config.SpoilerBlurIntensity >= 5 && config.SpoilerBlurIntensity <= 100) ? config.SpoilerBlurIntensity : 40;
                var __sbMode = document.querySelector('#spoilerBlurMode');
                if (__sbMode) __sbMode.value = (config.SpoilerBlurMode === 'blur') ? 'blur' : 'hide';
                // Field-strip toggles. Defaults match PluginConfiguration:
                // every hide toggle defaults ON (strictest sensible posture
                // when the admin enables Spoiler Guard); the artwork +
                // auto-enable toggles default OFF.
                [
                    // A null value means this config predates the independent
                    // Series switch. Mirror the old episode-overview value on
                    // first load so upgrading does not silently change policy.
                    ['spoilerStripSeriesOverview',  'SpoilerStripSeriesOverview',  config.SpoilerStripOverview !== false],
                    ['spoilerStripOverview',        'SpoilerStripOverview',        true],
                    ['spoilerStripTags',            'SpoilerStripTags',            true],
                    ['spoilerStripChapters',        'SpoilerStripChapters',        true],
                    ['spoilerStripTaglines',        'SpoilerStripTaglines',        true],
                    ['spoilerStripRatings',         'SpoilerStripRatings',         true],
                    ['spoilerStripPremiereDate',    'SpoilerStripPremiereDate',    true],
                    ['spoilerReplaceTitle',         'SpoilerReplaceTitle',         true],
                    ['spoilerStripCast',            'SpoilerStripCast',            true],
                    ['spoilerStripReviews',         'SpoilerStripReviews',         true],
                    ['spoilerBlurArtwork',          'SpoilerBlurArtwork',          false],
                    ['spoilerAutoEnableOnFirstPlay','SpoilerAutoEnableOnFirstPlay',false],
                    ['spoilerAutoEnableOnSeerrRequest','SpoilerAutoEnableOnSeerrRequest',false],
                    ['spoilerAutoEnableOnLibraryAdd','SpoilerAutoEnableOnLibraryAdd',false],
                    // Auto-enable scope defaults to everything so upgrading
                    // doesn't narrow the existing first-play / Seerr modes.
                    ['spoilerAutoEnableSeries',     'SpoilerAutoEnableSeries',     true],
                    ['spoilerAutoEnableMovies',     'SpoilerAutoEnableMovies',     true],
                    ['spoilerBlurStrictRefresh',    'SpoilerBlurStrictRefresh',    false],
                    ['spoilerKeepMoviePosters',     'SpoilerKeepMoviePosters',     true],
                    // Advanced per-category reveals. The master switch is off
                    // for existing installs; the category masks keep the
                    // strictest posture except the next-episode title, which
                    // is the reveal advanced mode exists for.
                    ['spoilerAdvancedMode',              'SpoilerAdvancedMode',              false],
                    ['spoilerNextEpisodeStripTitle',     'SpoilerNextEpisodeStripTitle',     false],
                    ['spoilerNextEpisodeStripOverview',  'SpoilerNextEpisodeStripOverview',  true],
                    ['spoilerNextEpisodeStripRatings',   'SpoilerNextEpisodeStripRatings',   true],
                    ['spoilerNextEpisodeStripImage',     'SpoilerNextEpisodeStripImage',     true],
                    ['spoilerCurrentSeasonStripTitle',   'SpoilerCurrentSeasonStripTitle',   true],
                    ['spoilerCurrentSeasonStripOverview','SpoilerCurrentSeasonStripOverview',true],
                    ['spoilerCurrentSeasonStripRatings', 'SpoilerCurrentSeasonStripRatings', true],
                ].forEach(function (t) {
                    var el = document.querySelector('#' + t[0]);
                    if (!el) return;
                    var v = config[t[1]];
                    el.checked = (v === undefined || v === null) ? t[2] : !!v;
                });
                var __sbCastMode = document.querySelector('#spoilerStripCastMode');
                if (__sbCastMode) __sbCastMode.value = config.SpoilerStripCastMode === 'All' ? 'All' : 'GuestStars';
                var __sbPlaceholder = document.querySelector('#spoilerOverviewPlaceholder');
                if (__sbPlaceholder) __sbPlaceholder.value = config.SpoilerOverviewPlaceholder || 'Spoiler Guard activated';
                renderSpoilerAutoEnableLibraries(config.SpoilerAutoEnableLibraryIds || '');

                document.querySelector('#loginImageEnabled').checked = config.EnableLoginImage || false;
                document.querySelector('#customPluginLinks').value = config.CustomPluginLinks || '';

                // Set up event handler for watchlist prevention checkbox
                function toggleWatchlistRetentionVisibility() {
                    const preventionEnabled = document.querySelector('#preventWatchlistReAddition').checked;
                    const retentionContainer = document.querySelector('#watchlistMemoryRetentionDays').closest('.inputContainer');
                    if (retentionContainer) {
                        retentionContainer.style.display = preventionEnabled ? 'block' : 'none';
                    }
                }

                // Set initial visibility
                toggleWatchlistRetentionVisibility();

                // Add event listener
                document.querySelector('#preventWatchlistReAddition').addEventListener('change', toggleWatchlistRetentionVisibility);

                // Update TMDB-dependent settings after config is loaded
                updateAllDependencies();

                // Refresh the Requests Page requirements banner off freshly-
                // rendered instance cards and loaded Seerr fields.
                updateRequestsRequirementsBanner();

                Dashboard.hideLoadingMsg();
                // Delay so late-finishing sub-populations (maintenance users, branding previews) settle first.
                setTimeout(jeMarkSaved, 500);
            });
        }

        async function buildConfigFromForm() {
            const config = await ApiClient.getPluginConfiguration(pluginId);
            const finalShortcuts = [...defaultShortcuts];
            shortcutOverrides.forEach(override => {
                const index = finalShortcuts.findIndex(s => s.Name === override.Name);
                if (index !== -1) finalShortcuts[index] = override;
            });
            config.Shortcuts = finalShortcuts;
            config.DevMode = document.querySelector('#devMode').checked;
            // A timed window switches maintenance off by itself (and another admin or the API can
            // flip it) while this page is open. When the toggle was not touched since it was loaded,
            // keep the server's current value so saving unrelated settings never quietly starts a
            // new window or ends someone else's.
            const mmToggle = document.querySelector('#maintenanceModeEnabled');
            const mmServerEnabled = String(config.MaintenanceModeEnabled === true);
            if (String(mmToggle.checked) === mmToggle.dataset.jeLoaded && mmServerEnabled !== mmToggle.dataset.jeLoaded) {
                mmToggle.checked = config.MaintenanceModeEnabled === true;
            }
            mmToggle.dataset.jeLoaded = String(mmToggle.checked);
            config.MaintenanceModeEnabled = mmToggle.checked;
            config.MaintenanceModeMessage = document.querySelector('#maintenanceModeMessage').value;
            config.MaintenanceModeNotificationMessage = document.querySelector('#maintenanceModeNotificationMessage').value;
            // Clamped (0 .. one year): a value past int range would fail the whole config save.
            config.MaintenanceModeDurationMinutes = Math.min(525600, Math.max(0, parseInt(document.querySelector('#maintenanceModeDurationMinutes').value, 10) || 0));
            config.MaintenanceModeRemindOnPlayback = document.querySelector('#maintenanceModeRemindOnPlayback').checked;
            config.MaintenanceScheduleEnabled = document.querySelector('#maintenanceScheduleEnabled').checked;
            config.MaintenanceScheduleStart = document.querySelector('#maintenanceScheduleStart').value || '00:00';
            config.MaintenanceScheduleEnd = document.querySelector('#maintenanceScheduleEnd').value || '08:00';
            config.MaintenanceScheduleMessage = document.querySelector('#maintenanceScheduleMessage').value;
            config.MaintenanceScheduleNotificationMessage = document.querySelector('#maintenanceScheduleNotificationMessage').value;
            const mmSchedAccounts = document.getElementById('mmSchedAction_accounts').checked;
            const mmSchedRemote   = document.getElementById('mmSchedAction_remote').checked;
            config.MaintenanceScheduleAction = (mmSchedAccounts && mmSchedRemote) ? 'both'
                                             : mmSchedAccounts                    ? 'disable_accounts'
                                             : mmSchedRemote                      ? 'disable_remote'
                                             :                                      'none';
            const mmAccounts = document.getElementById('mmAction_accounts').checked;
            const mmRemote   = document.getElementById('mmAction_remote').checked;
            config.MaintenanceModeAction = (mmAccounts && mmRemote) ? 'both'
                                         : mmAccounts               ? 'disable_accounts'
                                         : mmRemote                 ? 'disable_remote'
                                         :                            'none';
            const mmUsersMode = (document.querySelector('input[name="maintenanceModeUsers"]:checked') || {}).value || 'all';
            if (mmUsersMode === 'all') {
                config.MaintenanceModeAffectedUsers = 'all';
            } else {
                const checked = Array.from(document.querySelectorAll('.je-mm-user-cb:checked')).map(cb => cb.value);
                config.MaintenanceModeAffectedUsers = JSON.stringify(checked);
            }
            config.EnableCustomSplashScreen = document.querySelector('#enableCustomSplashScreen').checked;
            config.SplashScreenImageUrl = document.querySelector('#splashScreenImageUrl').value;
            config.DisableAllShortcuts = document.querySelector('#disableAllShortcuts').checked;
            config.ToastDuration = parseInt(document.querySelector('#ToastDuration').value, 10);
            config.HelpPanelAutocloseDelay = parseInt(document.querySelector('#HelpPanelAutocloseDelay').value, 10);
            config.ElsewhereEnabled = document.querySelector('#elsewhereEnabled').checked;
            config.TMDB_API_KEY = document.querySelector('#TMDB_API_KEY').value;
            config.DEFAULT_REGION = document.querySelector('#DEFAULT_REGION').value;
            config.DEFAULT_PROVIDERS = document.querySelector('#DEFAULT_PROVIDERS').value;
            config.IGNORE_PROVIDERS = document.querySelector('#IGNORE_PROVIDERS').value;
            config.ElsewhereCustomBrandingText = document.querySelector('#ElsewhereCustomBrandingText').value;
            config.ElsewhereCustomBrandingImageUrl = document.querySelector('#ElsewhereCustomBrandingImageUrl').value;
            config.AutoPauseEnabled = document.querySelector('#autoPauseEnabled').checked;
            config.AutoResumeEnabled = document.querySelector('#autoResumeEnabled').checked;
            config.AutoPipEnabled = document.querySelector('#autoPipEnabled').checked;
            config.AutoSkipIntro = document.querySelector('#autoSkipIntro').checked;
            config.AutoSkipOutro = document.querySelector('#autoSkipOutro').checked;
            config.LongPress2xEnabled = document.querySelector('#longPress2xEnabled').checked;
            config.RandomButtonEnabled = document.querySelector('#randomButtonEnabled').checked;
            config.RandomIncludeMovies = document.querySelector('#randomIncludeMovies').checked;
            config.RandomIncludeShows = document.querySelector('#randomIncludeShows').checked;
            config.RandomUnwatchedOnly = document.querySelector('#randomUnwatchedOnly').checked;
            config.RandomScopeCurrentContainer = document.querySelector('#randomScopeCurrentContainer').checked;
            config.ShowWatchProgress = document.querySelector('#showWatchProgress').checked;
            config.WatchProgressDefaultMode = document.querySelector('#watchProgressDefaultMode').value;
            config.WatchProgressTimeFormat = document.querySelector('#watchProgressTimeFormat').value;
            config.ShowFileSizes = document.querySelector('#showFileSizes').checked;
            config.ShowAudioLanguages = document.querySelector('#showAudioLanguages').checked;
            config.RemoveContinueWatchingEnabled = document.querySelector('#removeContinueWatchingEnabled').checked;
            config.QualityTagsEnabled = document.querySelector('#qualityTagsEnabled').checked;
            config.ShowResolutionTag = document.querySelector('#showResolutionTag').checked;
            config.ShowSourceTag = document.querySelector('#showSourceTag').checked;
            config.ShowDynamicRangeTag = document.querySelector('#showDynamicRangeTag').checked;
            config.ShowSpecialFormatTag = document.querySelector('#showSpecialFormatTag').checked;
            config.ShowVideoCodecTag = document.querySelector('#showVideoCodecTag').checked;
            config.ShowAudioInfoTag = document.querySelector('#showAudioInfoTag').checked;
            // Persist current visual stack order. Each admin row reads its current
            // DOM position (1-based) into the corresponding *Order config key.
            // Skipped if the load-time render failed — otherwise we'd clobber the
            // user's saved order with default DOM positions.
            if (_qualityCatRenderOK) {
                const adminCatRows = document.querySelectorAll('#qualityCategoriesAdmin .je-quality-cat-admin-row');
                adminCatRows.forEach((row, idx) => {
                    const orderKey = row.dataset.orderKey;
                    if (orderKey) config[orderKey] = idx + 1;
                });
            }
            config.GenreTagsEnabled = document.querySelector('#genreTagsEnabled').checked;
            config.LanguageTagsEnabled = document.querySelector('#languageTagsEnabled').checked;
            config.RatingTagsEnabled = document.querySelector('#ratingTagsEnabled').checked;
            config.AgeRatingTagsEnabled = document.querySelector('#ageRatingTagsEnabled').checked;
            config.PeopleTagsEnabled = document.querySelector('#peopleTagsEnabled').checked;
            config.DisableTagsOnSearchPage = document.querySelector('#disableTagsOnSearchPage').checked;
            config.TagsHideOnHover = document.querySelector('#tagsHideOnHover').checked;
            config.RatingTagsOnMovies = document.querySelector('#ratingTagsOnMovies').checked;
            config.RatingTagsOnSeries = document.querySelector('#ratingTagsOnSeries').checked;
            config.RatingTagsOnSeasons = document.querySelector('#ratingTagsOnSeasons').checked;
            config.RatingTagsOnEpisodes = document.querySelector('#ratingTagsOnEpisodes').checked;
            config.RatingTagsOnContinueWatching = document.querySelector('#ratingTagsOnContinueWatching').checked;
            config.RatingTagsOnNextUp = document.querySelector('#ratingTagsOnNextUp').checked;
            config.TagCacheServerMode = document.querySelector('#tagCacheServerMode').checked;
            config.EnableTagsLocalStorageFallback = config.TagCacheServerMode
                ? document.querySelector('#enableTagsLocalStorageFallback').checked
                : true;
            config.QualityTagsPosition = document.querySelector('#qualityTagsPosition').value;
            config.GenreTagsPosition = document.querySelector('#genreTagsPosition').value;
            config.LanguageTagsPosition = document.querySelector('#languageTagsPosition').value;
            config.LanguageTagsPriority = document.querySelector('#languageTagsPriority').value.trim();
            config.LanguageTagsPriorityStrict = document.querySelector('#languageTagsPriorityStrict').checked;
            config.QualityTagsPreferredAudioLanguage = document.querySelector('#qualityTagsPreferredAudioLanguage').value || '';
            config.QualityTagsAudioLanguageFromUser = document.querySelector('#qualityTagsAudioLanguageFromUser').checked;
            config.RatingTagsPosition = document.querySelector('#ratingTagsPosition').value;
            config.AgeRatingTagsPosition = document.querySelector('#ageRatingTagsPosition').value;
            config.ShowRatingInPlayer = document.querySelector('#showRatingInPlayer').checked;
            config.TagsCacheTtlDays = parseInt(document.querySelector('#tagsCacheTtlDays').value, 10) || 30;
            config.PauseScreenEnabled = document.querySelector('#pauseScreenEnabled').checked;
            config.ShowPlaybackRatingBadge = document.querySelector('#showPlaybackRatingBadge').checked;
            config.ShowReviews = document.querySelector('#showReviews').checked;
            config.ShowAwards = document.querySelector('#showAwards').checked;
            config.MdblistRatingsEnabled = document.querySelector('#mdblistRatingsEnabled').checked;
            config.MdblistApiKey = document.querySelector('#mdblistApiKey').value.trim();
            config.MdblistRatingsShowOnItemDetails = document.querySelector('#mdblistRatingsShowOnItemDetails').checked;
            config.MdblistRatingsFetchEnabled = document.querySelector('#mdblistRatingsFetchEnabled').checked;
            config.MdblistFetchReserve = parseInt(document.querySelector('#mdblistFetchReserve').value, 10) || 400;
            config.MdblistRatingsAutoSyncEnabled = document.querySelector('#mdblistRatingsAutoSyncEnabled').checked;
            config.MdblistRatingsOverwriteExisting = document.querySelector('#mdblistRatingsOverwriteExisting').checked;
            config.MdblistRatingsSources = (typeof computeMdblistRatingsSources === 'function') ? computeMdblistRatingsSources() : '';
            config.MdblistRatingsShowPercentSymbol = document.querySelector('#mdblistRatingsShowPercentSymbol').checked;
            config.ShowUserReviews = document.querySelector('#showUserReviews').checked;
            config.ReviewsExpandedByDefault = document.querySelector('#reviewsExpandedByDefault').checked;
            config.ShowReleaseDates = document.querySelector('#showReleaseDate').checked;
            config.HideReviewsFromHiddenUsers = document.querySelector('#hideReviewsFromHiddenUsers').checked;
            config.HideReviewsFromDisabledUsers = document.querySelector('#hideReviewsFromDisabledUsers').checked;
            config.ShowUserRatingDash = document.querySelector('#showUserRatingDash').checked;
            config.ShowUserRatingOnPosters = document.querySelector('#showUserRatingOnPosters').checked;
            config.JellyseerrEnabled = document.querySelector('#jellyseerrEnabled').checked;
            config.JellyseerrShowSearchResults = document.querySelector('#jellyseerrShowSearchResults').checked;
            config.JellyseerrSearchExcludeLibraryItems = document.querySelector('#jellyseerrSearchExcludeLibraryItems').checked;
            config.ShowCollectionsInSearch = document.querySelector('#showCollectionsInSearch').checked;
            config.JellyseerrEnable4KRequests = document.querySelector('#jellyseerrEnable4kRequests').checked;
            config.JellyseerrEnable4KTvRequests = document.querySelector('#jellyseerrEnable4kTvRequests').checked;
            config.JellyseerrUseMoreInfoModal = document.querySelector('#jellyseerrUseMoreInfoModal').checked;
            config.JellyseerrAvailablePosterLinksToJellyfin = document.querySelector('#jellyseerrAvailablePosterLinksToJellyfin').checked;
            config.JellyseerrShowAdvanced = document.querySelector('#jellyseerrShowAdvanced').checked;
            config.JellyseerrShowQuotaInfo = document.querySelector('#jellyseerrShowQuotaInfo').checked;
            config.JellyseerrShowSimilar = document.querySelector('#jellyseerrShowSimilar').checked;
            config.JellyseerrShowRecommended = document.querySelector('#jellyseerrShowRecommended').checked;
            config.JellyseerrShowRequestMoreOnSeries = document.querySelector('#jellyseerrShowRequestMoreOnSeries').checked;
            config.JellyseerrExcludeLibraryItems = document.querySelector('#jellyseerrExcludeLibraryItems').checked;
            config.JellyseerrExcludeBlocklistedItems = document.querySelector('#jellyseerrExcludeBlocklistedItems').checked;
            config.JellyseerrDisableCache = document.querySelector('#jellyseerrDisableCache').checked;
            config.JellyseerrResponseCacheTtlMinutes = parseInt(document.querySelector('#jellyseerrResponseCacheTtlMinutes').value, 10) || 10;
            config.JellyseerrUserIdCacheTtlMinutes = parseInt(document.querySelector('#jellyseerrUserIdCacheTtlMinutes').value, 10) || 30;
            config.JellyseerrShowNetworkDiscovery = document.querySelector('#jellyseerrShowNetworkDiscovery').checked;
            config.JellyseerrShowGenreDiscovery = document.querySelector('#jellyseerrShowGenreDiscovery').checked;
            config.JellyseerrShowTagDiscovery = document.querySelector('#jellyseerrShowTagDiscovery').checked;
            config.JellyseerrShowPersonDiscovery = document.querySelector('#jellyseerrShowPersonDiscovery').checked;
            config.JellyseerrShowCollectionDiscovery = document.querySelector('#jellyseerrShowCollectionDiscovery').checked;
            config.JellyseerrShowReportButton = document.querySelector('#jellyseerrShowReportButton').checked;
            config.JellyseerrShowIssueIndicator = document.querySelector('#jellyseerrShowIssueIndicator').checked;
            config.JellyseerrShowDetailPageLink = document.querySelector('#jellyseerrShowDetailPageLink').checked;
            config.JellyseerrShowDetailPageLinkAsText = document.querySelector('#jellyseerrShowDetailPageLinkAsText').checked;
            config.ShowElsewhereOnJellyseerr = document.querySelector('#showElsewhereOnJellyseerr').checked;
            // validate scheme on save. Lines that don't parse as
            // http(s) are dropped with a warning so we never persist garbage
            // like "seerr.local" (no scheme) — which downstream string-concats
            // produce malformed URIs and a confusing UriFormatException buried
            // in logs. Empty textarea remains valid (Seerr can be disabled).
            (function () {
                const raw = (document.querySelector('#jellyseerrUrls').value || '').split('\n').map(u => u.trim()).filter(Boolean);
                const valid = [];
                const invalid = [];
                for (const line of raw) {
                    try {
                        const u = new URL(line);
                        if (u.protocol === 'http:' || u.protocol === 'https:') {
                            valid.push(line);
                        } else {
                            invalid.push(line);
                        }
                    } catch (_) {
                        invalid.push(line);
                    }
                }
                if (invalid.length > 0) {
                    console.warn('Jellyfin Enhanced: dropping invalid Seerr URL(s) on save (must start with http:// or https://):', invalid);
                    if (typeof Dashboard !== 'undefined' && Dashboard.alert) {
                        Dashboard.alert({
                            title: 'Invalid Seerr URL(s)',
                            message: 'These lines were dropped because they do not start with http:// or https://:\n\n' + invalid.join('\n')
                        });
                    }
                }
                config.JellyseerrUrls = valid.join('\n');
            })();
            config.JellyseerrApiKey = (document.querySelector('#JellyseerrApiKey').value || '').replace(/\s/g, '');
            config.JellyseerrUrlMappings = (document.querySelector('#jellyseerrUrlMappings').value || '').split('\n').map(u => u.trim()).filter(Boolean).join('\n');
            config.TMDB_API_KEY = document.querySelector('#jellyseerr_TMDB_API_KEY').value;
            config.AutoSeasonRequestEnabled = document.querySelector('#autoSeasonRequestEnabled').checked;
            config.AutoSeasonRequestRequireAllWatched = document.querySelector('#autoSeasonRequestRequireAllWatched').checked;
            config.AutoSeasonRequestThresholdValue = parseInt(document.querySelector('#autoSeasonRequestThresholdValue').value, 10) || 2;
            config.AutoMovieRequestEnabled = document.querySelector('#autoMovieRequestEnabled').checked;
            const onStart = document.querySelector('#autoMovieRequestTriggerOnStart').checked;
            const onMinutes = document.querySelector('#autoMovieRequestTriggerOnMinutesWatched').checked;
            if (onStart && onMinutes) {
                config.AutoMovieRequestTriggerType = 'Both';
            } else if (onStart) {
                config.AutoMovieRequestTriggerType = 'OnStart';
            } else if (onMinutes) {
                config.AutoMovieRequestTriggerType = 'OnMinutesWatched';
            } else {
                config.AutoMovieRequestTriggerType = 'OnMinutesWatched'; // Default to minutes watched if nothing selected
            }
            const minutesValue = parseInt(document.querySelector('#autoMovieRequestMinutesWatched').value, 10);
            config.AutoMovieRequestMinutesWatched = isNaN(minutesValue) || minutesValue < 1 ? 20 : Math.min(minutesValue, 180);
            config.AutoMovieRequestCheckReleaseDate = document.querySelector('#autoMovieRequestCheckReleaseDate').checked;
            config.AutoMovieRequestQualityMode = document.querySelector('#autoMovieRequestQualityMode').value || 'default';
            config.AutoMovieRequestFallbackOn4k = document.querySelector('#autoMovieRequestFallbackOn4k').checked;
            var serverVal = parseInt(document.querySelector('#autoMovieRequestServer').value);
            config.AutoMovieRequestCustomServerId = (!isNaN(serverVal) && serverVal >= 0) ? serverVal : -1;
            var profileVal = parseInt(document.querySelector('#autoMovieRequestProfile').value);
            config.AutoMovieRequestCustomProfileId = (!isNaN(profileVal) && profileVal > 0) ? profileVal : 0;
            config.AutoMovieRequestCustomRootFolder = document.querySelector('#autoMovieRequestRootFolder').value || '';
            config.AddRequestedMediaToWatchlist = document.querySelector('#addRequestedMediaToWatchlist').checked;
            config.SyncJellyseerrWatchlist = document.querySelector('#syncJellyseerrWatchlist').checked;
            config.SyncJellyfinWatchlistToSeerr = document.querySelector('#syncJellyfinWatchlistToSeerr').checked;
            config.JellyseerrAutoImportUsers = document.querySelector('#jellyseerrAutoImportUsers').checked;
            syncBlockedUsersToHiddenInput();
            config.JellyseerrImportBlockedUsers = document.querySelector('#jellyseerrImportBlockedUsers').value || '';
            config.PreventWatchlistReAddition = document.querySelector('#preventWatchlistReAddition').checked;

            const retentionDays = parseInt(document.querySelector('#watchlistMemoryRetentionDays').value);
            config.WatchlistMemoryRetentionDays = isNaN(retentionDays) || retentionDays < 1 ? 365 : Math.min(retentionDays, 3650);
            config.TriggerSeerrScanOnItemAdded = document.querySelector('#triggerSeerrScanOnItemAdded').checked;
            const seerrScanDebounce = parseInt(document.querySelector('#seerrScanDebounceSeconds').value);
            config.SeerrScanDebounceSeconds = isNaN(seerrScanDebounce) || seerrScanDebounce < 5 ? 60 : Math.min(seerrScanDebounce, 3600);
            config.BookmarksEnabled = document.querySelector('#bookmarksEnabled').checked;
            config.BookmarksUsePluginPages = document.querySelector('#bookmarksUsePluginPages').checked;
            config.BookmarksUseNativeTab = document.querySelector('#bookmarksUseNativeTab').checked;
            config.BookmarksUseCustomTabs = document.querySelector('#bookmarksUseCustomTabs').checked;
            var __bAutoSave = document.querySelector('#bookmarksAutoCreateCustomTab');
            config.BookmarksAutoCreateCustomTab = !!(__bAutoSave && __bAutoSave.checked);
            config.UseIcons = document.querySelector('#useIcons').checked;
            config.IconStyle = document.querySelector('#iconStyle').value;

            config.ArrLinksEnabled = document.querySelector('#arrLinksEnabled').checked;
            config.BazarrUrlMappings = document.querySelector('#bazarrUrlMappings').value || '';
            config.BazarrUrl = document.querySelector('#bazarrUrl').value;
            config.ShokoUrlMappings = document.querySelector('#shokoUrlMappings').value || '';
            config.ShokoUrl = document.querySelector('#shokoUrl').value;
            config.ShokoApiKey = (document.querySelector('#shokoApiKey').value || '').replace(/\s/g, '');
            config.ShokoShowEpisodes = document.querySelector('#shokoShowEpisodes').checked;
            config.ShokoShowSpecials = document.querySelector('#shokoShowSpecials').checked;
            config.ShokoShowCredits = document.querySelector('#shokoShowCredits').checked;
            config.ShokoShowTrailers = document.querySelector('#shokoShowTrailers').checked;
            config.ShokoShowParodies = document.querySelector('#shokoShowParodies').checked;
            config.ShokoShowOther = document.querySelector('#shokoShowOther').checked;
            config.ShowArrLinksAsText = document.querySelector('#showArrLinksAsText').checked;
            config.ArrLinksShowStatusSingle = document.querySelector('#arrLinksShowStatusSingle').checked;
            config.ArrTagsSyncEnabled = document.querySelector('#arrTagsSyncEnabled').checked;

            // Save multi-instance Sonarr/Radarr
            var arrIncompleteWarnings = saveArrInstances(config);
            if (arrIncompleteWarnings.length > 0) {
                // Surface each incomplete-card warning to the admin before the save completes.
                arrIncompleteWarnings.forEach(function(msg) {
                    Dashboard.alert({ title: '⚠ Incomplete *arr instance', message: msg });
                });
            }
            config.ArrTagsPrefix = document.querySelector('#arrTagsPrefix').value || 'Requested by: ';
            config.ArrTagsClearOldTags = document.querySelector('#arrTagsClearOldTags').checked;
            config.ArrTagsShowAsLinks = document.querySelector('#arrTagsShowAsLinks').checked;
            config.ArrTagsSyncFilter = document.querySelector('#arrTagsSyncFilter').value || '';
            config.ArrTagsLinksFilter = document.querySelector('#arrTagsLinksFilter').value || '';
            config.ArrTagsLinksHideFilter = document.querySelector('#arrTagsLinksHideFilter').value || '';
            config.DefaultSubtitleStyle = parseInt(document.querySelector('#DefaultSubtitleStyle').value, 10);
            config.DefaultSubtitleSize = parseInt(document.querySelector('#DefaultSubtitleSize').value, 10);
            config.DefaultSubtitleFont = parseInt(document.querySelector('#DefaultSubtitleFont').value, 10);
            config.DefaultSubtitleTextEffect = parseInt(document.querySelector('#DefaultSubtitleTextEffect').value, 10);
            config.DisableCustomSubtitleStyles = document.querySelector('#disableCustomSubtitleStyles').checked;
            config.DefaultLanguage = document.querySelector('#DefaultLanguage').value || '';
            config.LetterboxdEnabled = document.querySelector('#letterboxdEnabled').checked;
            config.ShowLetterboxdLinkAsText = document.querySelector('#showLetterboxdLinkAsText').checked;
            config.MetadataIconsEnabled = document.querySelector('#metadataIconsEnabled').checked;
            // If metadata icons are enabled, ensure icons are shown for Letterboxd and *arr links
            if (config.MetadataIconsEnabled) {
                config.ShowLetterboxdLinkAsText = false;
                config.ShowArrLinksAsText = false;
            }

            // Extras settings
            config.ColoredRatingsEnabled = document.querySelector('#coloredRatingsEnabled').checked;
            config.ThemeSelectorEnabled = document.querySelector('#themeSelectorEnabled').checked;
            config.ColoredActivityIconsEnabled = document.querySelector('#coloredActivityIconsEnabled').checked;
            config.PluginIconsEnabled = document.querySelector('#pluginIconsEnabled').checked;
            config.ActiveStreamsEnabled = document.querySelector('#activeStreamsEnabled').checked;
            config.ActiveStreamsAllUsers = document.querySelector('#activeStreamsAllUsers').checked;

            // Usage Statistics
            config.AnalyticsEnabled = document.querySelector('#analyticsEnabled').checked;
            config.AnalyticsShareFeatureFlags = document.querySelector('#analyticsShareFeatureFlags').checked;
            config.AnalyticsShareUsageCounts = document.querySelector('#analyticsShareUsageCounts').checked;
            config.AnalyticsShareDataSizes = document.querySelector('#analyticsShareDataSizes').checked;
            var analyticsIntervalRaw = parseInt(document.querySelector('#analyticsReportIntervalDays').value, 10);
            config.AnalyticsReportIntervalDays = isNaN(analyticsIntervalRaw) ? 15 : Math.min(30, Math.max(7, analyticsIntervalRaw));
            // Persist "configured" when saving with the master ON, and also
            // when the admin turned it on at any point this session (dataset
            // flag set by the master toggle handler) even if it's off again
            // now — their sub-category choices from that interaction are being
            // saved and must not be re-cascaded over on the next enable.
            if (config.AnalyticsEnabled || document.querySelector('#analyticsEnabled').dataset.jeTouched === '1') {
                config.AnalyticsHasBeenConfigured = true;
            }

            config.ActivityFeedEnabled = document.querySelector('#activityFeedEnabled').checked;
            config.ActivityFeedShowWatched = document.querySelector('#activityFeedShowWatched').checked;
            config.ActivityFeedShowFavorited = document.querySelector('#activityFeedShowFavorited').checked;
            config.ActivityFeedShowReviewed = document.querySelector('#activityFeedShowReviewed').checked;
            config.ActivityFeedShowActiveStreams = document.querySelector('#activityFeedShowActiveStreams').checked;
            config.ActivityFeedUseNativeTab = document.querySelector('#activityFeedUseNativeTab').checked;
            config.ActivityFeedUsePluginPages = document.querySelector('#activityFeedUsePluginPages').checked;
            config.ActivityFeedUseCustomTabs = document.querySelector('#activityFeedUseCustomTabs').checked;
            var __aAutoSave = document.querySelector('#activityFeedAutoCreateCustomTab');
            config.ActivityFeedAutoCreateCustomTab = !!(__aAutoSave && __aAutoSave.checked);

            // Requests Page settings
            config.DownloadsPageEnabled = document.querySelector('#downloadsPageEnabled').checked;
            config.ShowDownloadsInRequests = document.querySelector('#showDownloadsInRequests').checked;
            config.DownloadsFilterByUserRequests = document.querySelector('#downloadsFilterByUserRequests').checked;
            config.DownloadsPageShowIssues = document.querySelector('#downloadsPageShowIssues').checked;
            config.DownloadsShowHistory = document.querySelector('#downloadsShowHistory').checked;
            config.DownloadsHistoryAdminOnly = document.querySelector('#downloadsHistoryAdminOnly').checked;
            config.DownloadsUsePluginPages = document.querySelector('#downloadsUsePluginPages').checked;
            config.DownloadsPagePollingEnabled = document.querySelector('#downloadsPagePollingEnabled').checked;
            const pollInterval = parseInt(document.querySelector('#downloadsPollIntervalSeconds').value, 10);
            config.DownloadsPollIntervalSeconds = pollInterval >= 30 ? pollInterval : 30;
            config.DownloadsUseCustomTabs = document.querySelector('#downloadsUseCustomTabs').checked;
            config.DownloadsUseNativeTab = document.querySelector('#downloadsUseNativeTab').checked;
            var __dAutoSave = document.querySelector('#downloadsAutoCreateCustomTab');
            config.DownloadsAutoCreateCustomTab = !!(__dAutoSave && __dAutoSave.checked);

            // Calendar Page settings
            config.CalendarPageEnabled = document.querySelector('#calendarPageEnabled').checked;
            config.CalendarUseCustomTabs = document.querySelector('#calendarUseCustomTabs').checked;
            config.CalendarUseNativeTab = document.querySelector('#calendarUseNativeTab').checked;
            var __cAutoSave = document.querySelector('#calendarAutoCreateCustomTab');
            config.CalendarAutoCreateCustomTab = !!(__cAutoSave && __cAutoSave.checked);
            config.CalendarUsePluginPages = document.querySelector('#calendarUsePluginPages').checked;
            config.CalendarFirstDayOfWeek = document.querySelector('#calendarFirstDayOfWeek').value || 'Monday';
            config.CalendarTimeFormat = document.querySelector('#calendarTimeFormat').value || '5pm/5:30pm';
            config.CalendarHighlightFavorites = document.querySelector('#calendarHighlightFavorites').checked;
            config.CalendarHighlightWatchedSeries = document.querySelector('#calendarHighlightWatchedSeries').checked;
            config.CalendarFilterByLibraryAccess = document.querySelector('#calendarFilterByLibraryAccess').checked;
            config.CalendarShowOnlyRequested = document.querySelector('#calendarShowOnlyRequested').checked;
            config.CalendarForceOnlyRequested = document.querySelector('#calendarForceOnlyRequested').checked;

            // Recommendations Page settings
            config.RecommendationsPageEnabled = document.querySelector('#recommendationsPageEnabled').checked;
            config.RecommendationsUseNativeTab = document.querySelector('#recommendationsUseNativeTab').checked;
            config.RecommendationsUsePluginPages = document.querySelector('#recommendationsUsePluginPages').checked;
            config.RecommendationsUseCustomTabs = document.querySelector('#recommendationsUseCustomTabs').checked;
            var __rAutoSave = document.querySelector('#recommendationsAutoCreateCustomTab');
            config.RecommendationsAutoCreateCustomTab = !!(__rAutoSave && __rAutoSave.checked);

            // Hidden Content settings
            config.HiddenContentEnabled = document.querySelector('#hiddenContentEnabled').checked;
            config.HiddenContentUsePluginPages = document.querySelector('#hiddenContentUsePluginPages').checked;
            config.HiddenContentUseNativeTab = document.querySelector('#hiddenContentUseNativeTab').checked;
            config.HiddenContentUseCustomTabs = document.querySelector('#hiddenContentUseCustomTabs').checked;
            config.HiddenContentAdmin = document.querySelector('#hiddenContentAdmin').checked;
            var __hAutoSave = document.querySelector('#hiddenContentAutoCreateCustomTab');
            config.HiddenContentAutoCreateCustomTab = !!(__hAutoSave && __hAutoSave.checked);

            // Hidden Content per-user defaults
            [
                'hiddenContentDefaultEnabled',
                'hiddenContentDefaultShowHideButtons',
                'hiddenContentDefaultShowHideConfirmation',
                'hiddenContentDefaultShowButtonJellyseerr',
                'hiddenContentDefaultShowButtonLibrary',
                'hiddenContentDefaultShowButtonDetails',
                'hiddenContentDefaultShowButtonCast',
                'hiddenContentDefaultFilterLibrary',
                'hiddenContentDefaultFilterDiscovery',
                'hiddenContentDefaultFilterSearch',
                'hiddenContentDefaultFilterCalendar',
                'hiddenContentDefaultFilterUpcoming',
                'hiddenContentDefaultFilterRecommendations',
                'hiddenContentDefaultFilterRequests',
                'hiddenContentDefaultFilterNextUp',
                'hiddenContentDefaultFilterContinueWatching',
                'hiddenContentDefaultExperimentalHideCollections',
            ].forEach(function(id) {
                var el = document.querySelector('#' + id);
                if (!el) return;
                var pascal = id.charAt(0).toUpperCase() + id.slice(1);
                config[pascal] = !!el.checked;
            });

            // Spoiler Guard settings
            config.SpoilerBlurEnabled = document.querySelector('#spoilerBlurEnabled').checked;
            var __sbSigmaSave = document.querySelector('#spoilerBlurIntensity');
            if (__sbSigmaSave) {
                var __sbSigmaVal = parseInt(__sbSigmaSave.value, 10);
                if (!isFinite(__sbSigmaVal) || __sbSigmaVal < 5) __sbSigmaVal = 5;
                if (__sbSigmaVal > 100) __sbSigmaVal = 100;
                config.SpoilerBlurIntensity = __sbSigmaVal;
            }
            // Field-strip toggles
            [
                'spoilerStripSeriesOverview', 'spoilerStripOverview',
                'spoilerStripTags', 'spoilerStripChapters',
                'spoilerStripTaglines', 'spoilerStripRatings',
                'spoilerStripPremiereDate',
                'spoilerReplaceTitle', 'spoilerStripCast', 'spoilerStripReviews',
                'spoilerBlurArtwork', 'spoilerAutoEnableOnFirstPlay',
                'spoilerAutoEnableOnSeerrRequest', 'spoilerAutoEnableOnLibraryAdd',
                'spoilerAutoEnableSeries', 'spoilerAutoEnableMovies',
                'spoilerBlurStrictRefresh',
                'spoilerKeepMoviePosters',
                'spoilerAdvancedMode',
                'spoilerNextEpisodeStripTitle', 'spoilerNextEpisodeStripOverview',
                'spoilerNextEpisodeStripRatings', 'spoilerNextEpisodeStripImage',
                'spoilerCurrentSeasonStripTitle', 'spoilerCurrentSeasonStripOverview',
                'spoilerCurrentSeasonStripRatings',
            ].forEach(function (id) {
                var el = document.querySelector('#' + id);
                if (!el) return;
                var pascal = id.charAt(0).toUpperCase() + id.slice(1);
                config[pascal] = !!el.checked;
            });
            config.SpoilerAutoEnableLibraryIds = collectSpoilerAutoEnableLibraries();
            var __sbCastModeSave = document.querySelector('#spoilerStripCastMode');
            config.SpoilerStripCastMode = (__sbCastModeSave && __sbCastModeSave.value === 'All') ? 'All' : 'GuestStars';
            var __sbModeSave = document.querySelector('#spoilerBlurMode');
            config.SpoilerBlurMode = (__sbModeSave && __sbModeSave.value === 'blur') ? 'blur' : 'hide';
            var __sbPlaceholderSave = document.querySelector('#spoilerOverviewPlaceholder');
            if (__sbPlaceholderSave) {
                // Remove every character that could open a tag, attribute or
                // template context so this stored placeholder can't become markup
                // in a JE consumer that uses innerHTML on Overview (the server
                // inserts it into BaseItemDto.Overview; defense-in-depth). A single
                // character-class strip is complete — unlike a tag-shaped regex it
                // can't be bypassed by nested or split tags.
                var __raw = (__sbPlaceholderSave.value || 'Spoiler Guard activated').slice(0, 200);
                __raw = __raw.replace(/[<>"'`]/g, '');
                config.SpoilerOverviewPlaceholder = __raw || 'Spoiler Guard activated';
            }

            config.EnableLoginImage = document.querySelector('#loginImageEnabled').checked;
            config.CustomPluginLinks = document.querySelector('#customPluginLinks').value || '';

            // Carry the cached "JE owns this Custom Tabs entry" flags through any
            // round-trip; sync may overwrite specific keys after computing actions.
            CUSTOM_TAB_MANAGED_ENTRIES.forEach(function(entry) {
                config[entry.ownedKey] = _jeCustomTabOwnedCache[entry.ownedKey] === true;
            });

            return config;
        }

        /**
         * Run sync, then if any owned-flag updates were produced, persist them
         * back to JE config in a second write so future saves see the new state.
         * Returns the (possibly downgraded) sync result so the caller can surface
         * any failure to the admin.
         *
         * Cache discipline: `_jeCustomTabOwnedCache` is mutated ONLY after the
         * server confirms the owned-flag write. On failure we re-read the live
         * config and restore the cache to ground truth — otherwise a partial
         * write would leave the in-memory cache disagreeing with what the next
         * page-load will see, causing JE to silently orphan its own tabs on
         * future cleanup. The downgraded result tells `saveConfig` to surface
         * the partial-success to the admin.
         */
        async function runCustomTabsSync(config) {
            const syncResult = await syncAllManagedCustomTabs(config);
            if (!syncResult || !Array.isArray(syncResult.ownedUpdates) || syncResult.ownedUpdates.length === 0) {
                return syncResult;
            }
            // Detect changes against the cache, but DO NOT mutate the cache yet.
            const pendingUpdates = syncResult.ownedUpdates.filter(function(u) {
                return _jeCustomTabOwnedCache[u.ownedKey] !== u.value;
            });
            if (pendingUpdates.length === 0) {
                return syncResult;
            }
            // Narrow second-write: fetch the latest config from the server first,
            // then apply ONLY the owned-flag delta. This minimizes the race window
            // where an interleaving save (double-click, "Apply to all users", or
            // a concurrent admin in another browser tab) would otherwise be lost
            // if we replayed the form's stale snapshot on top. Any unrelated
            // fields the other save wrote are preserved because we only mutate
            // the `*CustomTabJeOwned` keys on the fresh copy.
            let fresh;
            try {
                fresh = await ApiClient.getPluginConfiguration(pluginId);
            } catch (fetchErr) {
                console.error('[JE] Could not re-fetch config for owned-flag persist:', fetchErr);
                fresh = null;
            }
            const target = fresh || config; // fall back to form state if fetch fails
            pendingUpdates.forEach(function(u) { target[u.ownedKey] = u.value; });
            try {
                await ApiClient.updatePluginConfiguration(pluginId, target);
                // Server confirmed — commit cache.
                pendingUpdates.forEach(function(u) {
                    _jeCustomTabOwnedCache[u.ownedKey] = u.value;
                });
                return syncResult;
            } catch (persistErr) {
                console.error('[JE] Failed to persist Custom Tabs owned-flag updates:', persistErr);
                // Roll cache back to ground truth so the next save's plan
                // computes against the actual server state, not a poisoned cache.
                try {
                    const fresh = await ApiClient.getPluginConfiguration(pluginId);
                    CUSTOM_TAB_MANAGED_ENTRIES.forEach(function(entry) {
                        _jeCustomTabOwnedCache[entry.ownedKey] = fresh[entry.ownedKey] === true;
                    });
                } catch (reloadErr) {
                    console.error('[JE] Cache rollback after owned-flag persist failure also failed:', reloadErr);
                }
                // Downgrade the result so saveConfig's check surfaces the partial.
                // The recovery message has to be specific because the trivial "re-save"
                // path does not actually repair the state: post-rollback the cache and
                // server agree on owned=false, the CT entry exists, and the next sync's
                // shouldExist+entry-exists branch will preserve owned=false (no second
                // write fires). Real recovery is to delete the CT entry from the
                // Custom Tabs plugin UI and then re-save here so the next sync ADDs
                // a fresh entry and stamps it owned=true.
                return Object.assign({}, syncResult, {
                    ok: false,
                    status: 'partial',
                    detail: (syncResult.detail ? syncResult.detail + ': ' : '') +
                            "Custom Tabs has the new entry, but Jellyfin Enhanced could not save its ownership record. " +
                            "JE will not be able to clean this entry up on a later toggle change. " +
                            "To restore JE management: open the Custom Tabs plugin, delete the JE-managed entry there, then save this page again; JE will recreate it and record ownership properly."
                });
            }
        }

        // Re-entrancy guard. `Dashboard.showLoadingMsg()` provides only a visual
        // overlay, not an input block, so two rapid Enter presses or a second
        // click on the save dock can still fire saveConfig in parallel — the
        // second one's `buildConfigFromForm` reads a server state that the
        // first one has already mutated, and Save#1's deferred owned-flag write
        // (step 2) can land after Save#2 and silently revert the admin's
        // between-save form changes. Treat saves as serial.
        var _jeSaveInFlight = false;

        async function saveConfig(e) {
            e.preventDefault();
            if (_jeSaveInFlight) return false;
            _jeSaveInFlight = true;
            Dashboard.showLoadingMsg();
            var saveBtns = document.querySelectorAll('.je-save-dock-btn');
            saveBtns.forEach(function(b) { b.disabled = true; });

            try {
                const config = await buildConfigFromForm();
                const result = await ApiClient.updatePluginConfiguration(pluginId, config);
                // After JE config is persisted, sync any managed Custom Tabs entries.
                // We surface non-OK results to the admin via Dashboard.alert so a
                // partial failure doesn't hide behind the green "saved" toast.
                const syncResult = await runCustomTabsSync(config);

                // Apply maintenance mode: enable/disable users to match the toggle
                try {
                    if (config.MaintenanceModeEnabled) {
                        const affectedIds = config.MaintenanceModeAffectedUsers === 'all'
                            ? []
                            : JSON.parse(config.MaintenanceModeAffectedUsers || '[]');
                        await ApiClient.ajax({
                            type: 'POST',
                            url: ApiClient.getUrl('/JellyfinEnhanced/MaintenanceMode/Enable'),
                            contentType: 'application/json',
                            data: JSON.stringify({
                                message: config.MaintenanceModeMessage || '',
                                notificationMessage: config.MaintenanceModeNotificationMessage || '',
                                durationMinutes: config.MaintenanceModeDurationMinutes || 0,
                                action: config.MaintenanceModeAction || 'disable_accounts',
                                affectedUserIds: affectedIds
                            })
                        });
                        // Broadcast a native Jellyfin message to all active sessions
                        // (reaches non-web clients like TV apps too — works regardless of Active Streams setting)
                        const mmMsg = (config.MaintenanceModeNotificationMessage || '').trim()
                            || (config.MaintenanceModeMessage || '').trim()
                            || 'Server maintenance is starting. Please finish up and try again later.';
                        try {
                            await ApiClient.ajax({
                                type: 'POST',
                                url: ApiClient.getUrl('/JellyfinEnhanced/MaintenanceMode/Broadcast'),
                                contentType: 'application/json',
                                data: JSON.stringify({
                                    header: 'Server Maintenance',
                                    text: mmMsg,
                                    timeoutMs: 30000
                                })
                            });
                        } catch (bcErr) {
                            console.warn('[JE] Maintenance broadcast failed (no active sessions?):', bcErr);
                        }
                    } else {
                        // With the daily schedule on, "manual off" must leave a scheduled window running;
                        // with it off, nothing should be active, so end a scheduled window right away too.
                        await ApiClient.ajax({
                            type: 'POST',
                            url: ApiClient.getUrl('/JellyfinEnhanced/MaintenanceMode/Disable', {
                                includeScheduled: !config.MaintenanceScheduleEnabled
                            })
                        });
                    }
                } catch (mmErr) {
                    console.warn('[JE] Maintenance mode apply failed:', mmErr);
                }

                Dashboard.processPluginConfigurationUpdateResult(result);
                // The form now is the just-saved state, so re-snapshot immediately.
                jeMarkSaved();
                if (syncResult && syncResult.ok === false) {
                    try {
                        Dashboard.alert({
                            title: 'Custom Tabs sync issue',
                            message: 'Your Jellyfin Enhanced settings were saved, but the Custom Tabs entry could not be updated.\n\n' +
                                     (syncResult.detail || 'See browser console for details.')
                        });
                    } catch (alertErr) { console.warn('[JE] Dashboard.alert threw:', alertErr); }
                }
            } catch (saveErr) {
                Dashboard.hideLoadingMsg();
                console.error('[JE] saveConfig failed:', saveErr);
                try {
                    Dashboard.alert({
                        title: 'Save failed',
                        message: 'Could not save Jellyfin Enhanced settings. Check the browser console and server logs, then try again.'
                    });
                } catch (alertErr) { console.warn('[JE] Dashboard.alert threw:', alertErr); }
            } finally {
                _jeSaveInFlight = false;
                saveBtns.forEach(function(b) { b.disabled = false; });
            }
            return false;
        }

        // Saves current config and applies it to all users
        async function resetAllUserSettings() {
            if (confirm("Are you sure?\n\nThis saves the current configuration, then copies these Display/Playback/etc. values into every user's Enhanced Panel settings, replacing anything they've customized for themselves. This cannot be undone per-user; each user would have to re-apply their own preferences afterward.")) {
                Dashboard.showLoadingMsg();
                try {
                    // First, save the current configuration
                    const config = await buildConfigFromForm();
                    await ApiClient.updatePluginConfiguration(pluginId, config);
                    jeMarkSaved();

                    // Sync managed Custom Tabs entries — same flow as a normal save,
                    // so "Apply to all users" doesn't silently skip the side-effect.
                    const syncResult = await runCustomTabsSync(config);

                    // Then reset all user settings to match the saved config
                    await ApiClient.ajax({
                        type: 'POST',
                        url: ApiClient.getUrl('/JellyfinEnhanced/reset-all-users-settings'),
                        dataType: 'json'
                    });

                    Dashboard.hideLoadingMsg();
                    let msg = 'Configuration saved and applied to all users successfully!\n\nSettings will take effect after users refresh their browsers.';
                    if (syncResult && syncResult.ok === false) {
                        msg += '\n\n(Custom Tabs sync did not complete: ' + (syncResult.detail || 'see console') + ')';
                    }
                    Dashboard.alert({ title: 'Success', message: msg });
                } catch (e) {
                    Dashboard.hideLoadingMsg();
                    console.error('Failed to save and apply settings:', e);
                    Dashboard.alert({
                        title: 'Error',
                        message: 'Failed to save and apply settings to all users. Check server logs for details.'
                    });
                }
            }
        }

        // ── Maintenance mode: user checklist ─────────────────────────────────────

        function loadMaintenanceUsers() {
            ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/JellyfinEnhanced/MaintenanceMode/Users'),
                dataType: 'json'
            }).then(function(users) {
                const inner = document.getElementById('je-mm-users-inner');
                if (!inner) return;
                inner.innerHTML = '';

                if (!users || users.length === 0) {
                    const msg = document.createElement('div');
                    msg.style.cssText = 'opacity:0.55;font-size:0.875em;';
                    msg.textContent = 'No non-admin users found.';
                    inner.appendChild(msg);
                    return;
                }

                // Collect any pre-selected IDs stored on the container by loadConfig
                const listEl = document.getElementById('je-mm-user-list');
                let preselect = [];
                try { preselect = JSON.parse(listEl.dataset.preselect || '[]'); } catch (e) {}
                const preselectAll = preselect.length === 0;

                // 3-column grid
                const grid = document.createElement('div');
                grid.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:0.2em 0.75em;';

                users.forEach(function(u) {
                    // Handle both camelCase and PascalCase from the API
                    const uid  = u.id  || u.Id  || '';
                    const uname = u.username || u.Username || uid;

                    const checked = preselectAll || preselect.indexOf(uid) !== -1;

                    const label = document.createElement('label');
                    label.style.cssText = 'display:flex;align-items:center;gap:0.45em;padding:0.3em 0.2em;cursor:pointer;border-radius:4px;min-width:0;';

                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.className = 'je-mm-user-cb';
                    cb.value = uid;
                    cb.checked = checked;
                    cb.style.flexShrink = '0';

                    const avatar = document.createElement('span');
                    avatar.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;' +
                        'width:26px;height:26px;border-radius:50%;background:rgba(255,255,255,0.15);' +
                        'font-size:0.7em;font-weight:700;flex-shrink:0;overflow:hidden;';
                    const fallbackLetter = document.createTextNode((uname || '?').charAt(0).toUpperCase());
                    // Users without a profile picture get the letter straight
                    // away instead of an image request that can only 404 (an
                    // older server omits hasImage: try the picture as before).
                    const hasImage = u.hasImage !== undefined ? u.hasImage : u.HasImage;
                    if (hasImage === false) {
                        avatar.appendChild(fallbackLetter);
                    } else {
                        // Try to load the user's actual Jellyfin profile picture
                        const img = document.createElement('img');
                        img.style.cssText = 'width:26px;height:26px;border-radius:50%;object-fit:cover;display:block;';
                        img.src = ApiClient.getUrl('/Users/' + uid + '/Images/Primary', { width: 26 });
                        img.alt = '';
                        img.onerror = function() {
                            this.style.display = 'none';
                            avatar.appendChild(fallbackLetter);
                        };
                        avatar.appendChild(img);
                    }

                    const name = document.createElement('span');
                    name.style.cssText = 'font-size:0.875em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                    name.textContent = uname;

                    label.appendChild(cb);
                    label.appendChild(avatar);
                    label.appendChild(name);
                    grid.appendChild(label);
                });

                inner.appendChild(grid);
            }).catch(function() {
                const inner = document.getElementById('je-mm-users-inner');
                if (!inner) return;
                inner.innerHTML = '';
                const msg = document.createElement('div');
                msg.style.cssText = 'opacity:0.55;font-size:0.875em;';
                msg.textContent = 'Failed to load users.';
                inner.appendChild(msg);
            });
        }

        /** Shows the inline warning when the daily window's start and end time are equal. */
        function updateMaintenanceScheduleWarning() {
            const start = document.getElementById('maintenanceScheduleStart').value;
            const end = document.getElementById('maintenanceScheduleEnd').value;
            document.getElementById('mmScheduleSameTimeWarning').style.display = start && start === end ? '' : 'none';
        }

        /**
         * Shows the server's current time under the daily window: the window runs on the server's
         * clock, which in containers is often UTC rather than the admin's time zone.
         */
        function refreshMaintenanceServerTime() {
            ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/JellyfinEnhanced/MaintenanceMode/Status'),
                dataType: 'json'
            }).then(function(status) {
                const el = document.getElementById('mmServerTimeHint');
                if (!el || !status || !status.ServerLocalTime) return;
                el.textContent = 'Server time is now ' + status.ServerLocalTime + ' (UTC' + status.ServerUtcOffset + '). Set the window in this time zone.';
            }).catch(function() { /* hint only */ });
        }

        function setupMaintenanceModeControls() {
            ['maintenanceScheduleStart', 'maintenanceScheduleEnd'].forEach(function(id) {
                document.getElementById(id).addEventListener('input', updateMaintenanceScheduleWarning);
            });

            // Show/hide user checklist based on radio selection
            document.querySelectorAll('input[name="maintenanceModeUsers"]').forEach(function(radio) {
                radio.addEventListener('change', function() {
                    const listEl = document.getElementById('je-mm-user-list');
                    if (this.value === 'select') {
                        listEl.style.display = '';
                        loadMaintenanceUsers();
                    } else {
                        listEl.style.display = 'none';
                    }
                });
            });

            // Select All / Deselect All buttons
            document.getElementById('je-mm-select-all').addEventListener('click', function() {
                document.querySelectorAll('.je-mm-user-cb').forEach(function(cb) { cb.checked = true; });
            });
            document.getElementById('je-mm-deselect-all').addEventListener('click', function() {
                document.querySelectorAll('.je-mm-user-cb').forEach(function(cb) { cb.checked = false; });
            });
        }

        // Setup branding file uploads and previews
        async function setupBrandingUploads() {
            const uploadConfigs = [
                { inputId: 'iconTransparentInput', dropZoneId: 'iconTransparentDropZone', statusId: 'iconTransparentStatus', fileName: 'icon-transparent.png', previewId: 'iconTransparentPreview', placeholderId: 'iconTransparentPlaceholder', deleteId: 'iconTransparentDelete', dimensionsId: 'iconTransparentDimensions' },
                { inputId: 'faviconInput', dropZoneId: 'faviconDropZone', statusId: 'faviconStatus', fileName: 'favicon.ico', previewId: 'faviconPreview', placeholderId: 'faviconPlaceholder', deleteId: 'faviconDelete', dimensionsId: 'faviconDimensions' },
                { inputId: 'bannerLightInput', dropZoneId: 'bannerLightDropZone', statusId: 'bannerLightStatus', fileName: 'banner-light.png', previewId: 'bannerLightPreview', placeholderId: 'bannerLightPlaceholder', deleteId: 'bannerLightDelete', dimensionsId: 'bannerLightDimensions' },
                { inputId: 'bannerDarkInput', dropZoneId: 'bannerDarkDropZone', statusId: 'bannerDarkStatus', fileName: 'banner-dark.png', previewId: 'bannerDarkPreview', placeholderId: 'bannerDarkPlaceholder', deleteId: 'bannerDarkDelete', dimensionsId: 'bannerDarkDimensions' },
                { inputId: 'touchiconInput', dropZoneId: 'touchiconDropZone', statusId: 'touchiconStatus', fileName: 'apple-touch-icon.png', previewId: 'touchiconPreview', placeholderId: 'touchiconPlaceholder', deleteId: 'touchiconDelete', dimensionsId: 'touchiconDimensions' }
            ];

            // Which slots have a custom image, in one request, so we don't probe
            // all five individually (and 404 on every empty one).
            let brandingStatus = null;
            try {
                const token = ApiClient.accessToken ? ApiClient.accessToken() : '';
                const statusResponse = await fetch(ApiClient.getUrl('/JellyfinEnhanced/BrandingStatus'), {
                    headers: { 'Authorization': 'MediaBrowser Token="' + token + '"', 'X-MediaBrowser-Token': token }
                });
                if (statusResponse.ok) {
                    brandingStatus = await statusResponse.json();
                }
            } catch (err) {
                brandingStatus = null;
            }

            uploadConfigs.forEach(config => {
                const input = document.getElementById(config.inputId);
                const dropZone = document.getElementById(config.dropZoneId);
                const statusDiv = document.getElementById(config.statusId);
                const deleteButton = document.getElementById(config.deleteId);

                if (!input || !dropZone || !statusDiv) return;

                // Handle file selection
                input.addEventListener('change', (e) => {
                    if (e.target.files.length > 0) {
                        uploadBrandingImage(e.target.files[0], config, statusDiv);
                    }
                });

                // Drag and drop
                dropZone.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    dropZone.style.borderColor = 'var(--primary-accent-color, #00a4dc)';
                    dropZone.style.backgroundColor = 'color-mix(in srgb, var(--primary-accent-color, #00a4dc) 10%, transparent)';
                });

                dropZone.addEventListener('dragleave', (e) => {
                    e.preventDefault();
                    dropZone.style.borderColor = 'color-mix(in srgb, var(--primary-accent-color, #00a4dc) 50%, transparent)';
                    dropZone.style.backgroundColor = 'rgba(255,255,255,0.05)';
                });

                dropZone.addEventListener('drop', (e) => {
                    e.preventDefault();
                    dropZone.style.borderColor = 'color-mix(in srgb, var(--primary-accent-color, #00a4dc) 50%, transparent)';
                    dropZone.style.backgroundColor = 'rgba(255,255,255,0.05)';
                    if (e.dataTransfer.files.length > 0) {
                        uploadBrandingImage(e.dataTransfer.files[0], config, statusDiv);
                    }
                });

                if (deleteButton) {
                    deleteButton.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        deleteBrandingImage(config, statusDiv);
                    });
                }

                // Known-empty slots skip the network probe entirely.
                if (brandingStatus && brandingStatus[config.fileName] === false) {
                    const previewImg = document.getElementById(config.previewId);
                    const placeholder = document.getElementById(config.placeholderId);
                    if (previewImg) previewImg.style.display = 'none';
                    if (placeholder) placeholder.style.display = 'block';
                    if (deleteButton) deleteButton.style.display = 'none';
                } else {
                    refreshBrandingPreview(config);
                }
            });
        }

        async function uploadBrandingImage(file, config, statusDiv) {
            // Validate that it's an image file
            if (!file.type || !file.type.startsWith('image/')) {
                statusDiv.textContent = '✗ Only image files allowed';
                statusDiv.style.color = '#ff6b6b';
                return;
            }

            const maxFileSize = 10 * 1024 * 1024; // 10MB
            if (file.size > maxFileSize) {
                statusDiv.textContent = `✗ File too large (max ${maxFileSize / (1024 * 1024)}MB)`;
                statusDiv.style.color = '#ff6b6b';
                return;
            }

            // Show image preview and dimensions
            const previewImg = document.getElementById(config.previewId);
            const dimensionsDiv = document.getElementById(config.dimensionsId);
            const placeholder = document.getElementById(config.placeholderId);

            if (previewImg) {
                const objectUrl = URL.createObjectURL(file);
                previewImg.src = objectUrl;
                previewImg.style.display = 'block';
                if (placeholder) placeholder.style.display = 'none';

                // Get image dimensions
                previewImg.onload = function() {
                    const img = new Image();
                    img.onload = function() {
                        if (dimensionsDiv) {
                            dimensionsDiv.textContent = `${img.width} × ${img.height}px`;
                            dimensionsDiv.style.display = 'block';
                        }
                        URL.revokeObjectURL(objectUrl);
                    };
                    img.src = objectUrl;
                };
            }

            statusDiv.textContent = 'Uploading...';
            statusDiv.style.color = '#ffa500';

            try {
                const formData = new FormData();
                const renamedFile = new File([file], config.fileName, { type: file.type });
                formData.append('file', renamedFile);
                formData.append('fileName', config.fileName);

                const token = ApiClient.accessToken ? ApiClient.accessToken() : '';
                const response = await fetch(ApiClient.getUrl('/JellyfinEnhanced/UploadBrandingImage'), {
                    method: 'POST',
                    body: formData,
                    headers: {
                        // Jellyfin 12 authenticates from the Authorization header; the
                        // legacy X-MediaBrowser-Token is kept for 10.11 back-compat.
                        'Authorization': 'MediaBrowser Token="' + token + '"',
                        'X-MediaBrowser-Token': token
                    }
                });

                if (response.ok) {
                    statusDiv.textContent = '✓ Uploaded';
                    statusDiv.style.color = '#51cf66';
                    await refreshBrandingPreview(config);
                    setTimeout(() => { statusDiv.textContent = ''; }, 3000);
                } else {
                    const error = await response.text();
                    statusDiv.textContent = `✗ ${error || 'Upload failed'}`;
                    statusDiv.style.color = '#ff6b6b';
                }
            } catch (error) {
                console.error('Upload exception:', error);
                statusDiv.textContent = `✗ ${error.message || 'Upload error'}`;
                statusDiv.style.color = '#ff6b6b';
            }
        }

        async function refreshBrandingPreview(config) {
            const previewImg = document.getElementById(config.previewId);
            const placeholder = document.getElementById(config.placeholderId);
            const deleteButton = document.getElementById(config.deleteId);
            const dimensionsDiv = document.getElementById(config.dimensionsId);
            if (!previewImg) return;

            const token = ApiClient.accessToken ? ApiClient.accessToken() : '';
            try {
                const response = await fetch(ApiClient.getUrl('/JellyfinEnhanced/BrandingImage', { fileName: config.fileName, t: Date.now() }), {
                    // Jellyfin 12 authenticates from the Authorization header; the
                    // legacy X-MediaBrowser-Token is kept for 10.11 back-compat.
                    headers: { 'Authorization': 'MediaBrowser Token="' + token + '"', 'X-MediaBrowser-Token': token }
                });

                if (!response.ok) {
                    previewImg.style.display = 'none';
                    if (placeholder) placeholder.style.display = 'block';
                    if (deleteButton) deleteButton.style.display = 'none';
                    if (dimensionsDiv) dimensionsDiv.style.display = 'none';
                    return;
                }

                const blob = await response.blob();
                const objectUrl = URL.createObjectURL(blob);
                previewImg.src = objectUrl;
                previewImg.style.display = 'block';
                if (placeholder) placeholder.style.display = 'none';
                if (deleteButton) deleteButton.style.display = 'inline-block';

                // Show dimensions for existing images
                if (dimensionsDiv) {
                    previewImg.onload = function() {
                        dimensionsDiv.textContent = previewImg.naturalWidth + ' × ' + previewImg.naturalHeight + 'px';
                        dimensionsDiv.style.display = 'block';
                    };
                }
            } catch (err) {
                previewImg.style.display = 'none';
                if (placeholder) placeholder.style.display = 'block';
                if (deleteButton) deleteButton.style.display = 'none';
                if (dimensionsDiv) dimensionsDiv.style.display = 'none';
            }
        }

        async function deleteBrandingImage(config, statusDiv) {
            statusDiv.textContent = 'Deleting...';
            statusDiv.style.color = '#ffa500';

            const formData = new FormData();
            formData.append('fileName', config.fileName);
            const token = ApiClient.accessToken ? ApiClient.accessToken() : '';

            try {
                const response = await fetch(ApiClient.getUrl('/JellyfinEnhanced/DeleteBrandingImage'), {
                    method: 'POST',
                    body: formData,
                    // Jellyfin 12 authenticates from the Authorization header; the
                    // legacy X-MediaBrowser-Token is kept for 10.11 back-compat.
                    headers: { 'Authorization': 'MediaBrowser Token="' + token + '"', 'X-MediaBrowser-Token': token }
                });

                if (response.ok) {
                    statusDiv.textContent = '✓ Deleted';
                    statusDiv.style.color = '#51cf66';

                    // Hide dimensions when image is deleted
                    const dimensionsDiv = document.getElementById(config.dimensionsId);
                    if (dimensionsDiv) dimensionsDiv.style.display = 'none';

                    await refreshBrandingPreview(config);
                    setTimeout(() => { statusDiv.textContent = ''; }, 2000);
                } else {
                    const error = await response.text();
                    statusDiv.textContent = `✗ ${error || 'Delete failed'}`;
                    statusDiv.style.color = '#ff6b6b';
                }
            } catch (err) {
                statusDiv.textContent = `✗ ${err.message || 'Delete error'}`;
                statusDiv.style.color = '#ff6b6b';
            }
        }

        setupBrandingUploads();
        setupMaintenanceModeControls();

        // Jellyfin's culture list feeds both the UI language and the sound-tag audio language dropdowns.
        const culturesPromise = ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('/Localization/Cultures'), dataType: 'json' });

        // Populate language options dynamically
        (async () => {
            const defaultLanguageSelect = document.getElementById('DefaultLanguage');
            if (!defaultLanguageSelect) return;

            const CUSTOM_DISPLAY_NAMES = {
                'pr': 'Pirate',
                'en-GB': 'English (United Kingdom)',
                'en-US': 'English (United States)',
                'zh-CN': 'Chinese (Simplified)',
                'zh-HK': 'Chinese (Hong Kong)',
                'pt-BR': 'Portuguese (Brazil)'
            };

            try {
                const [localeCodes, cultures] = await Promise.all([
                    ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('/JellyfinEnhanced/locales'), dataType: 'json' }),
                    culturesPromise
                ]);

                // Check GitHub for any new locale files added since the last plugin release (1 request)
                try {
                    const ghResp = await fetch('https://api.github.com/repos/n00bcodr/Jellyfin-Enhanced/contents/Jellyfin.Plugin.JellyfinEnhanced/js/locales');
                    if (ghResp.ok) {
                        const files = await ghResp.json();
                        const serverSet = new Set(localeCodes.map(c => c.toLowerCase()));
                        files.forEach(f => {
                            if (f.name.endsWith('.json') && f.name !== 'en.json') {
                                const code = f.name.replace('.json', '');
                                if (!serverSet.has(code.toLowerCase())) {
                                    localeCodes.push(code);
                                }
                            }
                        });
                    }
                } catch (_) { /* GitHub unavailable, server list is sufficient */ }

                const cultureMap = {};
                cultures.forEach(c => {
                    cultureMap[c.TwoLetterISOLanguageName.toLowerCase()] = c;
                });

                const localeSet = new Set(localeCodes.map(c => c.toLowerCase()));
                const options = localeCodes.map(code => {
                    let displayName = CUSTOM_DISPLAY_NAMES[code]
                        || cultureMap[code.toLowerCase()]?.DisplayName;
                    if (!displayName && code.includes('-')) {
                        const baseName = cultureMap[code.split('-')[0].toLowerCase()]?.DisplayName;
                        displayName = baseName && localeSet.has(code.split('-')[0].toLowerCase())
                            ? `${baseName} (${code.split('-')[1]})`
                            : baseName;
                    }
                    return { code, displayName: displayName || code };
                });

                options.sort((a, b) => a.displayName.localeCompare(b.displayName));
                options.forEach(({ code, displayName }) => {
                    const option = document.createElement('option');
                    option.value = code;
                    option.textContent = displayName;
                    defaultLanguageSelect.appendChild(option);
                });
            } catch (err) {
                console.warn('Jellyfin Enhanced: Failed to load language options:', err);
            }
        })();

        // Preferred audio language for sound tags: every Jellyfin culture, by name. Kept apart from
        // the UI language list so a slow GitHub probe or a failed locales request cannot hold it up.
        (async () => {
            const qualityAudioLangSelect = document.getElementById('qualityTagsPreferredAudioLanguage');
            if (!qualityAudioLangSelect) return;
            try {
                const cultures = await culturesPromise;
                // loadConfig may have run first and parked the saved code as a bare option; the named list replaces it.
                qualityAudioLangSelect.querySelectorAll('option[data-je-placeholder]').forEach(o => o.remove());
                const seen = new Set();
                cultures
                    .map(c => ({ code: c.TwoLetterISOLanguageName || c.ThreeLetterISOLanguageName, name: c.DisplayName || c.Name }))
                    .filter(o => o.code && o.name && !seen.has(o.code) && seen.add(o.code))
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .forEach(({ code, name }) => {
                        const option = document.createElement('option');
                        option.value = code;
                        option.textContent = name;
                        qualityAudioLangSelect.appendChild(option);
                    });
                applyQualityAudioLanguage(qualityAudioLangSelect, qualityAudioLangSelect.dataset.savedValue);
            } catch (err) {
                // loadConfig parks the saved code as a bare option, so a save still keeps it.
                console.warn('Jellyfin Enhanced: Failed to load audio language options:', err);
            }
        })();

        page.addEventListener('pageshow', loadConfig);
        form.addEventListener('submit', saveConfig);
        resetAllUserSettingsBtn.addEventListener('click', resetAllUserSettings);
        initAutoMovieQualityMode();

        // Live-update the Requests Page requirements banner AND the dependency
        // gates as the admin types into Seerr fields or adds/edits/removes/
        // toggles *arr instances. Without this, the *arr UI Links / Tags Sync
        // gate banners would stay up until the next form save + reload even
        // though hasAnyArrService() is already true.
        (function wireRequestsBannerReactive() {
            var formEl = document.getElementById('JellyfinEnhancedForm');
            if (!formEl) {
                console.error('[JE] #JellyfinEnhancedForm missing — reactive dep updates disabled');
                return;
            }
            function relevant(target) {
                if (!target) return false;
                if (target.id === 'jellyseerrUrls' || target.id === 'JellyseerrApiKey') return true;
                if (!target.classList) return false;
                return target.classList.contains('arr-instance-url')
                    || target.classList.contains('arr-instance-apikey')
                    || target.classList.contains('arr-instance-enabled');
            }
            function refresh() {
                try {
                    updateRequestsRequirementsBanner();
                    debouncedUpdateDeps();
                } catch (err) {
                    // Observer + listener callbacks must never throw — a throw
                    // here would leave gate banners frozen in their last state
                    // and keep firing on every subsequent mutation.
                    console.error('[JE] dep refresh failed', err);
                }
            }
            // `input` covers all relevant cases: per-keystroke for text/api-key
            // fields, and bubbled-from-checkbox for `.arr-instance-enabled`
            // clicks/keyboard toggles. We deliberately skip a parallel `change`
            // listener — native checkboxes fire BOTH events per toggle, which
            // would double-fire refresh() (debouncedUpdateDeps collapses it,
            // but the synchronous updateRequestsRequirementsBanner pass would
            // run twice).
            formEl.addEventListener('input', function(e) {
                if (relevant(e.target)) refresh();
            });
            // Instance add/remove happens via button clicks that mutate
            // #sonarrInstancesList / #radarrInstancesList. Observe both so the
            // banner updates immediately on remove (no input event fires).
            ['sonarrInstancesList', 'radarrInstancesList'].forEach(function(id) {
                var root = document.getElementById(id);
                if (!root) return;
                new MutationObserver(refresh).observe(root, { childList: true, subtree: true });
            });
        })();

        // Apply the blurred background to .je-sticky-header only when the
        // surrounding scroll container has actually scrolled — at scrollTop=0
        // the header stays transparent so it doesn't cover the Jellyfin top
        // bar / user avatar. We don't know ahead of time which element
        // actually scrolls (Jellyfin's layout has several candidates: the
        // page view wrapper, body, and window — and Jellyfin's `.scrollY`
        // utility class decorates some non-scrolling nodes), so we attach
        // scroll listeners to every reasonable candidate (matching ancestor
        // + window) and read whichever reports a non-zero scroll position.
        // This IIFE runs once at script parse; the listeners persist across
        // SPA navigation since Jellyfin keeps the config page DOM alive.
        (function wireStickyHeaderScroll() {
            var header = document.querySelector('.je-sticky-header');
            if (!header) return;
            // Collect all overflow-y:auto|scroll ancestors as scroll-candidate
            // nodes. We don't trust scrollHeight>clientHeight at bind time
            // (async content hasn't landed yet); we don't pick just the
            // first match (Jellyfin's .scrollY utility flags decorative
            // containers that don't actually scroll). Listening on all
            // matches plus window means whichever actually scrolls drives
            // the class toggle.
            function findScrollCandidates(el) {
                var nodes = [];
                var node = el && el.parentNode;
                while (node && node !== document.body && node.nodeType === 1) {
                    var oy = getComputedStyle(node).overflowY;
                    if (oy === 'auto' || oy === 'scroll') nodes.push(node);
                    node = node.parentNode;
                }
                return nodes;
            }
            var candidates = findScrollCandidates(header);
            var ticking = false;
            function currentScrollTop() {
                var winTop = window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
                var contTop = 0;
                for (var i = 0; i < candidates.length; i++) {
                    var n = candidates[i];
                    // Skip detached nodes: their scrollTop freezes at the last
                    // value, which would incorrectly pin `.je-is-scrolled` on
                    // after the live scroller returns to top.
                    if (!n.isConnected) continue;
                    var t = n.scrollTop || 0;
                    if (t > contTop) contTop = t;
                }
                return winTop > contTop ? winTop : contTop;
            }
            function read() {
                try {
                    header.classList.toggle('je-is-scrolled', currentScrollTop() > 4);
                } catch (e) {
                    console.warn('[JE] sticky-header read failed:', e);
                } finally {
                    // Guarantees the rAF pipeline doesn't wedge on `ticking` if read() throws.
                    ticking = false;
                }
            }
            function onScroll() {
                if (ticking) return;
                ticking = true;
                requestAnimationFrame(read);
            }
            // Always listen on window (document-scrolling layouts) and on
            // each overflow-declared ancestor (mid-tree scrollers).
            window.addEventListener('scroll', onScroll, { passive: true });
            if (candidates.length === 0) {
                console.warn('[JE] sticky-header: no overflow:auto|scroll ancestors found; relying on window scroll only.');
            }
            candidates.forEach(function(n) {
                n.addEventListener('scroll', onScroll, { passive: true });
            });
            read();
        })();

        // ================================
        // SETTING DEPENDENCY SYSTEM
        // ================================

        /**
         * Checks whether a TMDB API key is configured in either input field.
         * @returns {boolean} True if a non-empty TMDB key exists
         */
        function hasTmdbKey() {
            return document.querySelector('#TMDB_API_KEY').value.trim().length > 0
                || document.querySelector('#jellyseerr_TMDB_API_KEY').value.trim().length > 0;
        }

        function isMetadataIconsEnabled() {
            var el = document.getElementById('metadataIconsEnabled');
            return !!(el && el.checked);
        }

        /**
         * Returns true iff at least one configured Seerr URL parses as an
         * http(s) URL. A non-empty textarea full of garbage like "seerr.local"
         * (no scheme) used to evaluate truthy here, so the dependency banner
         * would hide and Seerr feature toggles would unlock — features that
         * could never actually work.          */
        function hasAtLeastOneValidSeerrUrl(value) {
            if (!value) return false;
            const lines = String(value).split('\n').map(s => s.trim()).filter(Boolean);
            for (const line of lines) {
                try {
                    const u = new URL(line);
                    if (u.protocol === 'http:' || u.protocol === 'https:') {
                        return true;
                    }
                } catch (_) {
                    // not a valid URL — try next line
                }
            }
            return false;
        }

        /**
         * Checks whether Jellyseerr is enabled with both a URL and API key configured.
         * @returns {boolean} True if Jellyseerr is fully configured
         */
        function hasJellyseerrConfigured() {
            return document.querySelector('#jellyseerrEnabled').checked
                && hasAtLeastOneValidSeerrUrl(document.querySelector('#jellyseerrUrls').value)
                && document.querySelector('#JellyseerrApiKey').value.trim().length > 0;
        }

        /**
         * Checks whether at least one ENABLED arr service (Sonarr or Radarr) has a URL and API key.
         * Disabled instances are skipped — they're stored config but the fan-out callers
         * (controller endpoints, scheduled tag sync) skip them, so gating dependent
         * features behind a disabled-only set would be misleading.
         * @returns {boolean} True if any enabled arr service is fully configured
         */
        function hasAnyArrService() {
            var cards = document.querySelectorAll('#sonarrInstancesList .arr-instance-card, #radarrInstancesList .arr-instance-card');
            for (var i = 0; i < cards.length; i++) {
                var url = cards[i].querySelector('.arr-instance-url');
                var key = cards[i].querySelector('.arr-instance-apikey');
                var enabled = cards[i].querySelector('.arr-instance-enabled');
                // Treat missing checkbox as enabled (defensive — every card should have one)
                if (enabled && !enabled.checked) continue;
                if (url && url.value.trim() && key && key.value.trim()) return true;
            }
            return false;
        }

        // Setup fieldsets that hold the connection inputs are tagged with
        // `data-dep-setup` directly in the HTML — `updateSectionDep` walks
        // every fieldset and gates only the ones WITHOUT that marker, so
        // admins can always edit Sonarr/Radarr/Bazarr/Seerr setup boxes
        // regardless of what else is configured.
        var SECTION_DEPS = [
            {
                tabSelector: '#seerr',
                checkFn: hasJellyseerrConfigured,
                bannerIcon: 'link_off',
                bannerTitle: 'Enable "Seerr integration" to configure',
                bannerHint: 'Provide a Seerr URL and API key in the Setup section above, then enable the integration.',
                bannerId: 'dep-banner-jellyseerr'
            },
            {
                tabSelector: '#arr',
                checkFn: hasAnyArrService,
                bannerIcon: 'link_off',
                bannerTitle: 'Enable a *arr service to configure',
                bannerHint: 'Add a URL and API key for Sonarr or Radarr above to enable these features.',
                bannerId: 'dep-banner-arr'
            }
        ];

        var INDIVIDUAL_DEPS = [
            { id: 'elsewhereEnabled',         checkFn: hasTmdbKey, hint: 'Add a TMDB API Key to enable', icon: 'key' },
            { id: 'showReviews',              checkFn: hasTmdbKey, hint: 'Add a TMDB API Key to enable', icon: 'key' },
            { id: 'showElsewhereOnJellyseerr', checkFn: hasTmdbKey, hint: 'Add a TMDB API Key to enable', icon: 'key' },
            { id: 'autoMovieRequestEnabled',   checkFn: hasTmdbKey, hint: 'Add a TMDB API Key to enable', icon: 'key' },
            { id: 'autoSkipIntro',                 checkFn: function() { return hasIntroSkipper !== false; }, hint: 'Install Intro Skipper plugin to enable', icon: 'extension' },
            { id: 'autoSkipOutro',                 checkFn: function() { return hasIntroSkipper !== false; }, hint: 'Install Intro Skipper plugin to enable', icon: 'extension' },
            { id: 'bookmarksUsePluginPages',       checkFn: function() { return hasPluginPages !== false; }, hint: 'Install Plugin Pages plugin to enable', icon: 'extension' },
            { id: 'hiddenContentUsePluginPages',   checkFn: function() { return hasPluginPages !== false; }, hint: 'Install Plugin Pages plugin to enable', icon: 'extension' },
            { id: 'downloadsUsePluginPages',       checkFn: function() { return hasPluginPages !== false; }, hint: 'Install Plugin Pages plugin to enable', icon: 'extension' },
            { id: 'calendarUsePluginPages',        checkFn: function() { return hasPluginPages !== false; }, hint: 'Install Plugin Pages plugin to enable', icon: 'extension' },
            { id: 'recommendationsUsePluginPages', checkFn: function() { return hasPluginPages !== false; }, hint: 'Install Plugin Pages plugin to enable', icon: 'extension' },
            { id: 'activityFeedUsePluginPages',    checkFn: function() { return hasPluginPages !== false; }, hint: 'Install Plugin Pages plugin to enable', icon: 'extension' },
            { id: 'bookmarksUseCustomTabs',        checkFn: function() { return hasCustomTabs !== false; }, hint: 'Install Custom Tabs plugin to enable', icon: 'extension' },
            { id: 'hiddenContentUseCustomTabs',    checkFn: function() { return hasCustomTabs !== false; }, hint: 'Install Custom Tabs plugin to enable', icon: 'extension' },
            { id: 'downloadsUseCustomTabs',        checkFn: function() { return hasCustomTabs !== false; }, hint: 'Install Custom Tabs plugin to enable', icon: 'extension' },
            { id: 'calendarUseCustomTabs',         checkFn: function() { return hasCustomTabs !== false; }, hint: 'Install Custom Tabs plugin to enable', icon: 'extension' },
            { id: 'recommendationsUseCustomTabs',  checkFn: function() { return hasCustomTabs !== false; }, hint: 'Install Custom Tabs plugin to enable', icon: 'extension' },
            { id: 'activityFeedUseCustomTabs',     checkFn: function() { return hasCustomTabs !== false; }, hint: 'Install Custom Tabs plugin to enable', icon: 'extension' },
            { id: 'showLetterboxdLinkAsText', checkFn: function() { return !isMetadataIconsEnabled(); }, hint: 'Forced to icon mode while Metadata Icons (Druidblack) is enabled', icon: 'block' },
            { id: 'showArrLinksAsText',       checkFn: function() { return !isMetadataIconsEnabled(); }, hint: 'Forced to icon mode while Metadata Icons (Druidblack) is enabled', icon: 'block' }
        ];

        // Informational only (unlike INDIVIDUAL_DEPS) — Native Tab is more
        // reliable than Custom Tabs on Jellyfin 12, but Custom Tabs still works.
        var CUSTOM_TABS_V12_HINTS = [
            { customId: 'bookmarksUseCustomTabs',       nativeId: 'bookmarksUseNativeTab',       bannerId: 'je-v12-hint-bookmarks' },
            { customId: 'hiddenContentUseCustomTabs',   nativeId: 'hiddenContentUseNativeTab',   bannerId: 'je-v12-hint-hiddenContent' },
            { customId: 'downloadsUseCustomTabs',       nativeId: 'downloadsUseNativeTab',       bannerId: 'je-v12-hint-downloads' },
            { customId: 'calendarUseCustomTabs',        nativeId: 'calendarUseNativeTab',        bannerId: 'je-v12-hint-calendar' },
            { customId: 'recommendationsUseCustomTabs', nativeId: 'recommendationsUseNativeTab', bannerId: 'je-v12-hint-recommendations' },
            { customId: 'activityFeedUseCustomTabs',    nativeId: 'activityFeedUseNativeTab',     bannerId: 'je-v12-hint-activityFeed' }
        ];

        /**
         * Shows the `je-note-banner` under a `*UseCustomTabs` checkbox, on
         * Jellyfin 12, when it's checked and its Native Tab counterpart isn't.
         * @param {Object} dep - Entry from CUSTOM_TABS_V12_HINTS
         */
        function updateCustomTabsV12Hint(dep) {
            var checkbox = document.getElementById(dep.customId);
            var banner = document.getElementById(dep.bannerId);
            if (!checkbox || !banner) return;
            var nativeCheckbox = document.getElementById(dep.nativeId);
            var shouldWarn = isJellyfin12 && checkbox.checked && !(nativeCheckbox && nativeCheckbox.checked);
            banner.style.display = shouldWarn ? '' : 'none';
        }

        /**
         * Shows the warning under "Exclude search items already in library"
         * only while that checkbox is checked.
         */
        function updateSearchExcludeLibraryWarning() {
            var checkbox = document.getElementById('jellyseerrSearchExcludeLibraryItems');
            var banner = document.getElementById('je-search-exclude-library-warning');
            if (!checkbox || !banner) return;
            banner.style.display = checkbox.checked ? '' : 'none';
        }

        /**
         * Adds a dependency tag to an element's comma-separated data-dep-disabled attribute.
         * @param {HTMLElement} el - The element to tag
         * @param {string} tag - The dependency tag to add
         */
        function addDepTag(el, tag) {
            var existing = (el.getAttribute('data-dep-disabled') || '').split(',').filter(Boolean);
            if (existing.indexOf(tag) === -1) existing.push(tag);
            el.setAttribute('data-dep-disabled', existing.join(','));
        }

        /**
         * Removes a dependency tag from an element; returns true if all tags are cleared.
         * @param {HTMLElement} el - The element to update
         * @param {string} tag - The dependency tag to remove
         * @returns {boolean} True if no dependency tags remain on the element
         */
        function removeDepTag(el, tag) {
            var existing = (el.getAttribute('data-dep-disabled') || '').split(',').filter(Boolean);
            var filtered = existing.filter(function(t) { return t !== tag; });
            if (filtered.length) {
                el.setAttribute('data-dep-disabled', filtered.join(','));
                return false;
            }
            el.removeAttribute('data-dep-disabled');
            return true;
        }

        /**
         * Creates an orange warning banner DOM element for a missing section dependency.
         * @param {Object} dep - Dependency rule with bannerIcon, bannerTitle, and bannerHint
         * @returns {HTMLElement} The constructed banner element
         */
        function createDepBanner(dep) {
            var banner = document.createElement('div');
            banner.id = dep.bannerId;
            banner.className = 'je-dep-banner';
            var icon = document.createElement('i');
            icon.className = 'material-icons je-dep-banner-icon';
            icon.textContent = dep.bannerIcon;
            var textDiv = document.createElement('div');
            textDiv.className = 'je-dep-banner-text';
            var strong = document.createElement('strong');
            strong.textContent = dep.bannerTitle;
            var br = document.createElement('br');
            var span = document.createElement('span');
            span.className = 'je-dep-banner-hint';
            span.textContent = dep.bannerHint;
            textDiv.appendChild(strong);
            textDiv.appendChild(br);
            textDiv.appendChild(span);
            banner.appendChild(icon);
            banner.appendChild(textDiv);
            return banner;
        }

        /**
         * Evaluates one section-level dependency rule, showing/hiding banners and disabling inputs.
         * @param {Object} dep - Section dependency rule with checkFn, tabSelector, and banner config
         */
        function updateSectionDep(dep) {
            var isMet = dep.checkFn();
            var tab = document.querySelector(dep.tabSelector);
            if (!tab) return;
            var fieldsets = tab.querySelectorAll(':scope > fieldset');
            var targets = [];
            for (var i = 0; i < fieldsets.length; i++) {
                // Setup fieldsets (Sonarr/Radarr/Bazarr config, Seerr connection setup)
                // are always editable so admins can add a connection without first
                // having one — they carry `data-dep-setup` directly in the HTML.
                if (fieldsets[i].hasAttribute('data-dep-setup')) continue;
                targets.push(fieldsets[i]);
            }

            targets.forEach(function(fieldset) {
                var bannerId = dep.bannerId + '-' + Array.prototype.indexOf.call(fieldsets, fieldset);
                var banner = document.getElementById(bannerId);
                if (!isMet) {
                    if (!banner) {
                        var b = createDepBanner(dep);
                        b.id = bannerId;
                        var legend = fieldset.querySelector('legend');
                        if (legend) { legend.after(b); } else { fieldset.prepend(b); }
                        banner = b;
                    }
                    banner.classList.remove('je-hidden');
                    banner.classList.add('je-dep-banner'); // ensure class present if banner was pre-existing
                    fieldset.querySelectorAll('input, select, textarea, button').forEach(function(el) {
                        if (banner.contains(el)) return;
                        el.disabled = true;
                        addDepTag(el, dep.bannerId);
                    });
                    fieldset.querySelectorAll('label, .inputLabel, .selectLabel').forEach(function(el) {
                        el.style.opacity = '0.5';
                        el.style.cursor = 'not-allowed';
                        addDepTag(el, dep.bannerId);
                    });
                    fieldset.querySelectorAll('.fieldDescription').forEach(function(el) {
                        el.style.opacity = '0.5';
                        addDepTag(el, dep.bannerId);
                    });
                } else {
                    if (banner) banner.classList.add('je-hidden');
                    fieldset.querySelectorAll('[data-dep-disabled]').forEach(function(el) {
                        var allClear = removeDepTag(el, dep.bannerId);
                        if (allClear) {
                            if (typeof el.disabled !== 'undefined' && el.tagName !== 'LABEL' && el.tagName !== 'DIV') {
                                el.disabled = false;
                            }
                            el.style.opacity = '';
                            el.style.cursor = '';
                        }
                    });
                }
            });
        }

        /**
         * Evaluates one individual setting dependency, disabling checkbox and showing hint when unmet.
         * @param {Object} dep - Individual dependency rule with id, checkFn, hint, and icon
         */
        function updateIndividualDep(dep) {
            var checkbox = document.getElementById(dep.id);
            if (!checkbox) return;
            var label = checkbox.closest('label');
            if (!label) return;
            var isMet = dep.checkFn();
            var tag = 'ind-' + dep.id;

            if (!isMet) {
                checkbox.disabled = true;
                addDepTag(checkbox, tag);
                label.style.opacity = '0.5';
                label.style.cursor = 'not-allowed';
                label.title = dep.hint;
                addDepTag(label, tag);
                var span = label.querySelector('span');
                if (span && !label.querySelector('.dep-required-icon')) {
                    var icon = document.createElement('i');
                    icon.className = 'material-icons dep-required-icon';
                    icon.textContent = dep.icon || 'key';
                    icon.style.cssText = 'font-size: 16px; vertical-align: middle; margin-left: 8px; color: #ff9800;';
                    icon.title = dep.hint;
                    span.appendChild(icon);
                }
                if (span && !label.querySelector('.dep-hint-text')) {
                    var hintEl = document.createElement('span');
                    hintEl.className = 'dep-hint-text';
                    hintEl.textContent = dep.hint;
                    span.appendChild(hintEl);
                }
            } else {
                var allClear = removeDepTag(checkbox, tag);
                if (allClear) checkbox.disabled = false;
                var labelClear = removeDepTag(label, tag);
                if (labelClear) {
                    label.style.opacity = '';
                    label.style.cursor = '';
                    label.title = '';
                }
                var reqIcon = label.querySelector('.dep-required-icon');
                if (reqIcon) reqIcon.remove();
                var hintText = label.querySelector('.dep-hint-text');
                if (hintText) hintText.remove();
            }
        }

        var PARENT_DEPS = [
            { parent: 'elsewhereEnabled', label: 'Enable Elsewhere', children: ['DEFAULT_REGION', 'DEFAULT_PROVIDERS', 'IGNORE_PROVIDERS', 'ElsewhereCustomBrandingText', 'ElsewhereCustomBrandingImageUrl', 'showReviews', 'reviewsExpandedByDefault'] },
            { parent: 'mdblistRatingsEnabled', label: 'Enable MDBList Ratings', children: ['mdblistApiKey', 'mdblistRatingsShowOnItemDetails', 'mdblistRatingsFetchEnabled', 'mdblistFetchReserve', 'mdblistRatingsAutoSyncEnabled', 'mdblistRatingsOverwriteExisting', 'mdblistRatingsShowPercentSymbol'] },
            { parent: 'showReviews', label: 'Show Reviews', children: ['reviewsExpandedByDefault'] },
            { parent: 'showUserReviews', label: 'Enable User Reviews', children: ['hideReviewsFromHiddenUsers', 'hideReviewsFromDisabledUsers', 'showUserRatingDash', 'showUserRatingOnPosters'] },
            { parent: 'randomButtonEnabled', label: 'Enable Random Button', children: ['randomUnwatchedOnly', 'randomIncludeMovies', 'randomIncludeShows', 'randomScopeCurrentContainer'] },
            { parent: 'showWatchProgress', label: 'Show watch progress', children: ['watchProgressDefaultMode', 'watchProgressTimeFormat'] },
            { parent: 'qualityTagsEnabled', label: 'Enable Quality Tags', children: ['qualityTagsPosition', 'showResolutionTag', 'showSourceTag', 'showDynamicRangeTag', 'showSpecialFormatTag', 'showVideoCodecTag', 'showAudioInfoTag', 'qualityTagsPreferredAudioLanguage', 'qualityTagsAudioLanguageFromUser'], noHint: true },
            { parent: 'genreTagsEnabled', label: 'Enable Genre Tags', children: ['genreTagsPosition'], noHint: true },
            { parent: 'languageTagsEnabled', label: 'Enable Language Tags', children: ['languageTagsPosition', 'languageTagsPriority', 'languageTagsPriorityStrict'], noHint: true },
            { parent: 'ratingTagsEnabled', label: 'Enable Rating Tags', children: ['ratingTagsPosition', 'ratingTagsOnMovies', 'ratingTagsOnSeries', 'ratingTagsOnSeasons', 'ratingTagsOnEpisodes', 'ratingTagsOnContinueWatching', 'ratingTagsOnNextUp'], noHint: true },
            { parent: 'ageRatingTagsEnabled', label: 'Enable Age Rating Tags', children: ['ageRatingTagsPosition'], noHint: true },
            { parent: 'useIcons', label: 'Use Icons', children: ['iconStyle'] },
            { parent: 'letterboxdEnabled', label: 'Enable Letterboxd', children: ['showLetterboxdLinkAsText'] },
            { parent: 'enableCustomSplashScreen', label: 'Enable Custom Splash Screen', children: ['splashScreenImageUrl'] },
            { parent: 'jellyseerrShowSearchResults', label: 'Show Seerr Results in Search', children: ['showCollectionsInSearch'] },
            { parent: 'jellyseerrShowReportButton', label: 'Show Report Issue button', children: ['jellyseerrShowIssueIndicator'] },
            { parent: 'jellyseerrShowDetailPageLink', label: 'Show Seerr link on item detail pages', children: ['jellyseerrShowDetailPageLinkAsText'] },
            { parent: 'downloadsPageEnabled', label: 'Enable Requests Page', children: ['showDownloadsInRequests', 'downloadsPageShowIssues', 'downloadsShowHistory', 'downloadsUsePluginPages', 'downloadsUseNativeTab', 'downloadsUseCustomTabs', 'downloadsPagePollingEnabled'] },
            { parent: 'showDownloadsInRequests', label: 'Show Downloads in Requests Page', children: ['downloadsFilterByUserRequests'] },
            { parent: 'downloadsShowHistory', label: 'Show Download History Section', children: ['downloadsHistoryAdminOnly'] },
            { parent: 'downloadsPagePollingEnabled', label: 'Enable Auto-Refresh', children: ['downloadsPollIntervalSeconds'] },
            { parent: 'arrLinksEnabled', label: 'Enable *arr Links', children: ['showArrLinksAsText', 'arrLinksShowStatusSingle'] },
            { parent: 'arrTagsSyncEnabled', label: 'Enable *arr Tags Sync', children: ['arrTagsPrefix', 'arrTagsClearOldTags', 'arrTagsShowAsLinks', 'arrTagsSyncFilter'] },
            { parent: 'arrTagsShowAsLinks', label: 'Show synced tags as links', children: ['arrTagsLinksFilter', 'arrTagsLinksHideFilter'] },
            { parent: 'calendarPageEnabled', label: 'Enable Calendar Page', children: ['calendarUsePluginPages', 'calendarUseNativeTab', 'calendarUseCustomTabs', 'calendarFirstDayOfWeek', 'calendarTimeFormat', 'calendarHighlightFavorites', 'calendarHighlightWatchedSeries', 'calendarFilterByLibraryAccess', 'calendarShowOnlyRequested', 'calendarForceOnlyRequested'] },
            { parent: 'recommendationsPageEnabled', label: 'Enable Recommendations Page', children: ['recommendationsUseNativeTab', 'recommendationsUsePluginPages', 'recommendationsUseCustomTabs', 'recommendationsAutoCreateCustomTab'] },
            { parent: 'activityFeedEnabled', label: 'Enable Activity Feed', children: ['activityFeedShowWatched', 'activityFeedShowFavorited', 'activityFeedShowReviewed', 'activityFeedShowActiveStreams', 'activityFeedUseNativeTab', 'activityFeedUsePluginPages', 'activityFeedUseCustomTabs', 'activityFeedAutoCreateCustomTab'] },
            { parent: 'autoMovieRequestEnabled', label: 'Enable Automatic Movie Requests', children: ['autoMovieRequestTriggerOnStart', 'autoMovieRequestTriggerOnMinutesWatched', 'autoMovieRequestMinutesWatched', 'autoMovieRequestCheckReleaseDate', 'autoMovieRequestQualityMode', 'autoMovieRequestFallbackOn4k'] },
            { parent: 'autoSeasonRequestEnabled', label: 'Enable Automatic Season Requests', children: ['autoSeasonRequestRequireAllWatched', 'autoSeasonRequestThresholdValue'] },
            { parent: 'preventWatchlistReAddition', label: 'Prevent re-adding removed items', children: ['watchlistMemoryRetentionDays'] },
            { parent: 'triggerSeerrScanOnItemAdded', label: 'Trigger Seerr scan on item added', children: ['seerrScanDebounceSeconds'] },
            { parent: 'bookmarksEnabled', label: 'Enable Bookmarks', children: ['bookmarksUsePluginPages', 'bookmarksUseNativeTab', 'bookmarksUseCustomTabs'] },
            { parent: 'hiddenContentEnabled', label: 'Enable Hidden Content', children: ['hiddenContentUsePluginPages', 'hiddenContentUseNativeTab', 'hiddenContentUseCustomTabs'] },
            { parent: 'spoilerBlurEnabled', label: 'Enable Spoiler Guard', children: ['spoilerBlurIntensity', 'spoilerBlurArtwork', 'spoilerStripSeriesOverview', 'spoilerStripOverview', 'spoilerOverviewPlaceholder', 'spoilerStripTags', 'spoilerStripChapters', 'spoilerStripTaglines', 'spoilerStripRatings', 'spoilerStripPremiereDate', 'spoilerReplaceTitle', 'spoilerStripCast', 'spoilerAutoEnableOnFirstPlay', 'spoilerAutoEnableOnSeerrRequest', 'spoilerAutoEnableOnLibraryAdd', 'spoilerAutoEnableSeries', 'spoilerAutoEnableMovies', 'spoilerBlurStrictRefresh', 'spoilerKeepMoviePosters', 'spoilerAdvancedMode'] },
            { parent: 'spoilerStripCast',     label: 'Hide cast on unwatched episodes', children: ['spoilerStripCastMode'] },
            { parent: 'spoilerAdvancedMode',  label: 'Enable advanced per-category reveals', children: ['spoilerNextEpisodeStripTitle', 'spoilerNextEpisodeStripOverview', 'spoilerNextEpisodeStripRatings', 'spoilerNextEpisodeStripImage', 'spoilerCurrentSeasonStripTitle', 'spoilerCurrentSeasonStripOverview', 'spoilerCurrentSeasonStripRatings'] }
        ];

        /**
         * Evaluates one parent-child dependency, disabling children when the parent is unchecked.
         * @param {Object} dep - Parent dependency rule with parent id, label, and children ids
         */
        function updateParentDep(dep) {
            var parent = document.getElementById(dep.parent);
            if (!parent) return;
            var isEnabled = parent.checked;
            var tag = 'parent-' + dep.parent;
            var hintClass = 'parent-hint-' + dep.parent;

            dep.children.forEach(function(childId) {
                var child = document.getElementById(childId);
                if (!child) return;
                var container = child.closest('.checkboxContainer, .inputContainer, .selectContainer')
                             || child.closest('label');

                if (!isEnabled) {
                    child.disabled = true;
                    addDepTag(child, tag);
                    if (container) {
                        container.style.opacity = '0.5';
                        container.style.cursor = 'not-allowed';
                        addDepTag(container, tag);
                        // Add hint unless the dependency opted out (e.g. tag-position
                        // dropdowns, where the disabled styling next to the parent
                        // checkbox already makes the relationship obvious).
                        if (!dep.noHint && !container.querySelector('.' + hintClass)) {
                            var hint = document.createElement('div');
                            hint.className = 'dep-hint-text ' + hintClass;
                            hint.textContent = 'Enable "' + dep.label + '" to configure';
                            container.appendChild(hint);
                        }
                    }
                } else {
                    var allClear = removeDepTag(child, tag);
                    if (allClear) child.disabled = false;
                    if (container) {
                        var cc = removeDepTag(container, tag);
                        if (cc) { container.style.opacity = ''; container.style.cursor = ''; }
                        // Remove hint
                        var hint = container.querySelector('.' + hintClass);
                        if (hint) hint.remove();
                    }
                }
            });
        }

        // ==============================================================
        // Connection-test cache + Integration Health checklist (phase 4).
        // The checklist on Overview is a live health view of every
        // integration the admin has turned on. It renders rows purely
        // from (live config) + (cached test results), so it doesn't
        // hammer external services on every render. TTL keeps results
        // fresh without forcing probes on every click. The "Re-test all"
        // Quick Action clears the cache and re-invokes every test.
        // ==============================================================
        var CONNECTION_TEST_CACHE_TTL_MS = 5 * 60 * 1000;
        var _jeConnectionTestCache = new Map();

        // Generation counter for the cache. Every clear bumps it; any
        // write that was captured (via beginConnectionTest) at a prior
        // generation is dropped. Closes the race where a user clicks a
        // per-service Test button, then clicks Re-test-all, then the
        // original click's async result resolves and writes a stale
        // ok/error over the fresh result. See design review H2.
        var _jeCacheGeneration = 0;

        /**
         * Capture the current cache generation. Tests call this at START
         * and pass the returned token to setConnectionTestResult. A token
         * older than the current generation means the cache was cleared
         * mid-test and this write is stale — it gets dropped.
         */
        function beginConnectionTest() {
            return _jeCacheGeneration;
        }

        // When true, per-service tests skip their own Dashboard.alert
        // success/failure dialog. The Re-test-all Quick Action sets this
        // for the duration of a batch and shows a single aggregate dialog
        // at the end, instead of stacking 8+ modal prompts the admin has
        // to dismiss one by one.
        var _jeSuppressTestAlerts = false;

        /**
         * Dashboard.alert that respects the batch-mode suppression flag.
         * Use inside any per-service test function where a Dashboard.alert
         * is part of the individual-test UX but would spam the admin when
         * the test fires as part of a batch re-test.
         */
        function jeTestAlert(opts) {
            if (_jeSuppressTestAlerts) return;
            try { Dashboard.alert(opts); } catch (e) {
                console.warn('[JE] Dashboard.alert threw:', e);
            }
        }

        /**
         * Write a test result into the cache and refresh the checklist.
         * Safe to call multiple times; last write wins within the same
         * generation. Cache-refresh is guarded against exceptions so a
         * bug in renderChecklist can't cascade and break the actual
         * test flow.
         * @param {string} key  e.g. 'tmdb', 'seerr', 'sonarr:<normalizedUrl>'
         * @param {'ok'|'error'} status
         * @param {string} detail short human message shown in the row
         * @param {number} [token] optional generation token from
         *   beginConnectionTest; stale tokens are silently dropped.
         */
        function setConnectionTestResult(key, status, detail, token) {
            if (token !== undefined && token !== _jeCacheGeneration) {
                // Stale write from a test that was issued before the last
                // cache clear. Drop it so a fresher (in-flight) test's
                // result isn't overwritten by a stale ok/error.
                return;
            }
            var now = Date.now();
            _jeConnectionTestCache.set(key, {
                status: status,
                detail: detail || '',
                at: now
            });
            // Also persist to localStorage so the checklist can show "Last
            // tested <date>" after a page reload, instead of falling back
            // to "Configured — not yet verified" as if nothing was ever
            // checked. Wrapped in try/catch because localStorage is
            // best-effort (private mode, quota, disabled storage, etc.).
            try {
                localStorage.setItem('je_conn_test_' + key, JSON.stringify({
                    status: status,
                    detail: detail || '',
                    at: now
                }));
            } catch (e) { /* persistence is best-effort */ }
            try { renderChecklist(); } catch (e) {
                console.warn('[JE] renderChecklist threw after setConnectionTestResult:', e);
            }
        }

        /**
         * Read a previously-persisted test result for a connection key.
         * Returns null if no record, malformed JSON, or storage unavailable.
         * Unlike the in-memory cache there is NO TTL — the persisted entry
         * is meant to outlive page reloads so the admin always sees the
         * date of the most recent verification, however long ago it was.
         */
        function getPersistedTestResult(key) {
            var storageKey = 'je_conn_test_' + key;
            try {
                var raw = localStorage.getItem(storageKey);
                if (!raw) return null;
                var rec = JSON.parse(raw);
                if (!rec || typeof rec.at !== 'number' || typeof rec.status !== 'string') {
                    // Self-heal: drop the bad entry so subsequent renders don't keep
                    // re-parsing it and so the row falls cleanly back to "not tested".
                    try { localStorage.removeItem(storageKey); } catch (e) {}
                    return null;
                }
                return rec;
            } catch (e) {
                // Parse error → treat as corrupt and remove.
                try { localStorage.removeItem(storageKey); } catch (rmErr) {}
                return null;
            }
        }

        /**
         * Format a timestamp for the checklist's "Last tested" line:
         *   - same day  → "Last tested 3:45 PM"
         *   - other day → "Last tested Apr 20, 2026"
         */
        function formatLastTested(ts) {
            var d = new Date(ts);
            var now = new Date();
            if (d.toDateString() === now.toDateString()) {
                return 'Last tested ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            }
            return 'Last tested ' + formatDateDMY(d);
        }

        /**
         * Build a checklist row from cached / persisted test data.
         *  - Fresh in-memory hit  → row reflects the live status + detail
         *  - Persisted-only hit   → row keeps the last known state but
         *    swaps the detail line for "Last tested <date>"
         *  - No data              → row stays 'pending' with the supplied
         *    fallback text
         */
        function checklistRowState(cacheKey, fallbackDetail) {
            var live = getConnectionTestResult(cacheKey);
            if (live) return { state: live.status, detail: live.detail };
            var persisted = getPersistedTestResult(cacheKey);
            if (persisted) return { state: persisted.status, detail: formatLastTested(persisted.at) };
            return { state: 'pending', detail: fallbackDetail };
        }

        /**
         * Read a test result from the cache. Returns null on miss OR on
         * expiry — callers render the row as "pending" in that case.
         */
        function getConnectionTestResult(key) {
            var entry = _jeConnectionTestCache.get(key);
            if (!entry) return null;
            if (Date.now() - entry.at > CONNECTION_TEST_CACHE_TTL_MS) {
                _jeConnectionTestCache.delete(key);
                return null;
            }
            return entry;
        }

        /**
         * Drop every cached result. Used by the Re-test-all Quick Action
         * so rows immediately show "pending" while tests fire.
         */
        function clearConnectionTestCache() {
            _jeConnectionTestCache.clear();
            _jeCacheGeneration++;
            // Also drop persisted entries; otherwise checklistRowState falls back
            // to the "Last tested <date>" line and rows stay green/red instead of
            // showing pending while the new tests fire.
            try {
                var doomed = [];
                for (var i = 0; i < localStorage.length; i++) {
                    var k = localStorage.key(i);
                    if (k && k.indexOf('je_conn_test_') === 0) doomed.push(k);
                }
                doomed.forEach(function(k) { localStorage.removeItem(k); });
            } catch (e) { /* private mode / quota — best-effort */ }
            try { renderChecklist(); } catch (e) {
                console.warn('[JE] renderChecklist threw after clearConnectionTestCache:', e);
            }
        }

        /**
         * Drop the persisted "Last tested <date>" entry for a given service when
         * the inputs that produced that test result change (new TMDB key, new Seerr
         * URL, etc.) — otherwise the checklist would keep claiming the old key
         * worked. Wired up in the load/change handlers for the relevant inputs.
         */
        function invalidatePersistedTest(key) {
            try { localStorage.removeItem('je_conn_test_' + key); } catch (e) {}
            // Clear in-memory copy too so the row immediately drops to pending.
            _jeConnectionTestCache.delete(key);
            try { renderChecklist(); } catch (e) {}
        }

        /**
         * Normalize an arr-instance URL into a cache key fragment.
         * Trim, lowercase, strip trailing slashes so minor differences
         * don't fork the cache.
         */
        function _jeNormalizeArrUrl(url) {
            return (url || '').trim().toLowerCase().replace(/\/+$/, '');
        }

        /**
         * Build the Integration Health checklist inside #je-checklist.
         *
         * Row rules:
         *   - Only render a row when the integration is enabled.
         *   - Row state: 'ok' (green), 'amber' (warn), 'error' (red),
         *     'pending' (grey — enabled + complete config but no cached
         *     test result within TTL).
         *   - Zero rows is a valid outcome — render the empty hint.
         *   - Clicking a row jumps to the target tab.
         *
         * No HTML is injected from runtime data — every row is built with
         * createElement + textContent so untrusted instance names / URLs
         * can never inject markup into the checklist.
         */
        function renderChecklist() {
            // Thin delegator: the Integration Health checklist was merged into
            // Service Status, but multiple callers still reference this name —
            // keep the symbol to avoid breaking them. The original per-row
            // construction (#je-checklist + .je-checklist-* classes) was
            // removed along with its DOM host and CSS.
            renderServiceStatusDashboard();
        }

        // What's New: settings the server detected as newly added, powered
        // by WhatsNewService.CheckForNewSettings on the backend.

        /** camelCase/PascalCase id -> "Camel Case Id" for display. */
        function jeHumanizeSettingId(id) {
            var spaced = id.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
            return spaced.charAt(0).toUpperCase() + spaced.slice(1);
        }

        function checkWhatsNew() {
            ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/JellyfinEnhanced/whats-new'),
                dataType: 'json'
            }).then(function(data) {
                var pluginVersion = data && data.pluginVersion;
                if (!pluginVersion) return;

                // Drop ids that no longer exist in this build (renamed/removed).
                var newSettings = (data && data.newSettings) || {};
                var perSetting = Object.keys(newSettings).map(function(id) {
                    var el = document.getElementById(id);
                    var tabContent = el ? el.closest('.jellyfin-tab-content') : null;
                    return tabContent ? { id: id, tab: tabContent.id, selector: '#' + id, title: jeHumanizeSettingId(id), version: newSettings[id] } : null;
                }).filter(Boolean);

                var distinctVersions = new Set(perSetting.map(function(f) { return f.version; }));
                var singleVersion = distinctVersions.size === 1 ? perSetting[0].version : null;

                renderWhatsNewBanner(perSetting.length ? groupWhatsNewByFieldset(perSetting) : [], pluginVersion, singleVersion);
                renderWhatsNewBadges(perSetting);
            }).catch(function(err) {
                console.warn('[JE] whats-new check failed:', err);
            });
        }

        var _jeAutoFieldsetIdCounter = 0;

        /** Tab content id (e.g. "seerr") -> its visible nav label (e.g. "Seerr"), read straight off the tab button so it never drifts from what's on screen. */
        function jeTabLabel(tabId) {
            var btn = document.querySelector('.jellyfin-tab-button[data-tab="' + tabId + '"] h3');
            if (!btn) return tabId;
            var clone = btn.cloneNode(true);
            clone.querySelectorAll('i.material-icons, img').forEach(function(el) { el.remove(); });
            var text = clone.textContent.trim();
            return text || tabId;
        }

        /** Collapses new settings to one banner entry per fieldset, so a whole new feature reads as one line, not a wall of chips. */
        function groupWhatsNewByFieldset(perSetting) {
            var newIdSet = new Set(perSetting.map(function(f) { return f.id; }));
            var groups = {};
            var order = [];
            perSetting.forEach(function(f) {
                var fieldset = document.querySelector(f.selector).closest('fieldset');
                var legend = fieldset ? fieldset.querySelector(':scope > legend.sectionTitle') : null;
                var title = f.title;
                if (legend) {
                    var clone = legend.cloneNode(true);
                    clone.querySelectorAll('i.material-icons, img').forEach(function(el) { el.remove(); });
                    var legendText = clone.textContent.trim();
                    if (legendText) title = legendText;
                }
                var key = f.tab + ':' + title;
                if (!groups[key]) {
                    // Flash the whole fieldset only when every control in it is new;
                    // otherwise flash each new control individually.
                    var selector = f.selector;
                    var isWholeFieldset = false;
                    if (fieldset) {
                        var allIds = Array.from(fieldset.querySelectorAll('input[id], select[id], textarea[id], button[id]')).map(function(el) { return el.id; });
                        var allNew = allIds.length > 0 && allIds.every(function(id) { return newIdSet.has(id); });
                        if (allNew) {
                            if (!fieldset.id) fieldset.id = 'je-fieldset-auto-' + (++_jeAutoFieldsetIdCounter);
                            selector = '#' + fieldset.id;
                            isWholeFieldset = true;
                        }
                    }
                    groups[key] = {
                        tab: f.tab,
                        tabLabel: jeTabLabel(f.tab),
                        selector: selector,
                        title: title,
                        isWholeFieldset: isWholeFieldset,
                        flashSelectors: [isWholeFieldset ? selector : f.selector]
                    };
                    order.push(key);
                } else if (!groups[key].isWholeFieldset) {
                    groups[key].flashSelectors.push(f.selector);
                }
            });
            return order.map(function(key) { return groups[key]; });
        }

        function dismissWhatsNew() {
            ApiClient.ajax({ type: 'POST', url: ApiClient.getUrl('/JellyfinEnhanced/whats-new/dismiss') })
                .catch(function(err) { console.warn('[JE] whats-new dismiss failed:', err); });
            renderWhatsNewBanner([]);
            renderWhatsNewBadges([]);
        }

        function renderWhatsNewBanner(unseen, pluginVersion, singleVersion) {
            var existing = document.getElementById('je-whats-new-banner');
            if (existing) existing.remove();
            if (!pluginVersion) return;

            var banner = document.createElement('div');
            banner.id = 'je-whats-new-banner';
            banner.className = 'je-info-banner je-fieldset-wide je-whats-new-banner';

            var closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.className = 'je-whats-new-close';
            closeBtn.title = 'Dismiss';
            closeBtn.setAttribute('aria-label', 'Dismiss');
            closeBtn.innerHTML = '&#x2715;';
            closeBtn.addEventListener('click', dismissWhatsNew);
            banner.appendChild(closeBtn);

            var icon = document.createElement('i');
            icon.className = 'material-icons je-info-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = 'auto_awesome';
            banner.appendChild(icon);

            var body = document.createElement('div');

            var headingRow = document.createElement('div');
            headingRow.className = 'je-whats-new-heading-row';
            // Every pending setting comes from the same version (the common
            // case, and always true for the first release with this feature)
            // -> name it and deep-link that tag. Spanning several undismissed
            // releases falls back to a version-neutral heading and the full
            // release list, since each badge states its own version anyway.
            var heading = document.createElement('strong');
            heading.textContent = unseen.length === 0
                ? ("No new settings in v" + pluginVersion + '.')
                : (singleVersion ? ("What's new in v" + singleVersion + ':') : "What's new since you last checked:");
            headingRow.appendChild(heading);
            if (pluginVersion) {
                var releaseLink = document.createElement('a');
                releaseLink.href = unseen.length === 0
                    ? 'https://github.com/n00bcodr/Jellyfin-Enhanced/releases/tag/' + encodeURIComponent(pluginVersion)
                    : (singleVersion
                        ? 'https://github.com/n00bcodr/Jellyfin-Enhanced/releases/tag/' + encodeURIComponent(singleVersion)
                        : 'https://github.com/n00bcodr/Jellyfin-Enhanced/releases');
                releaseLink.target = '_blank';
                releaseLink.rel = 'noopener noreferrer';
                releaseLink.className = 'je-whats-new-release-link';
                var releaseLinkIcon = document.createElement('i');
                releaseLinkIcon.className = 'material-icons';
                releaseLinkIcon.setAttribute('aria-hidden', 'true');
                releaseLinkIcon.textContent = 'open_in_new';
                releaseLink.appendChild(releaseLinkIcon);
                releaseLink.appendChild(document.createTextNode('Read the release notes for entire changelog'));
                headingRow.appendChild(releaseLink);
            }
            body.appendChild(headingRow);

            if (unseen.length > 0) {
                var list = document.createElement('div');
                list.className = 'je-whats-new-list';
                unseen.forEach(function(f) {
                    var chip = document.createElement('button');
                    chip.type = 'button';
                    chip.className = 'je-whats-new-chip';
                    chip.textContent = f.tabLabel + ' > ' + f.title;
                    chip.addEventListener('click', function() {
                        jeJumpToTab(f.tab, f.selector, f.flashSelectors);
                    });
                    list.appendChild(chip);
                });
                body.appendChild(list);
            }

            banner.appendChild(body);
            var overview = document.getElementById('overview');
            if (overview) overview.insertBefore(banner, overview.firstChild);
        }

        function jeAppendNewBadge(container, version) {
            if (!container) return;
            var badge = document.createElement('span');
            badge.className = 'je-new-badge';
            var badgeIcon = document.createElement('i');
            badgeIcon.className = 'material-icons';
            badgeIcon.setAttribute('aria-hidden', 'true');
            badgeIcon.textContent = 'auto_awesome';
            badge.appendChild(badgeIcon);
            badge.appendChild(document.createTextNode(version ? ('New in v' + version) : 'New'));
            container.appendChild(badge);
        }

        /** When a whole fieldset (or expander) is new, badge just its legend (or summary) instead of every control inside it. Each badge uses its own setting's first-detected version. */
        function renderWhatsNewBadges(perSetting) {
            document.querySelectorAll('.je-new-badge').forEach(function(b) { b.remove(); });
            var newIdSet = new Set(perSetting.map(function(f) { return f.id; }));
            var versionById = new Map(perSetting.map(function(f) { return [f.id, f.version]; }));

            var byFieldset = new Map();
            var noFieldset = [];
            perSetting.forEach(function(f) {
                var el = document.getElementById(f.id);
                if (!el) return;
                var fieldset = el.closest('fieldset');
                if (!fieldset) { noFieldset.push(el); return; }
                if (!byFieldset.has(fieldset)) byFieldset.set(fieldset, []);
                byFieldset.get(fieldset).push(el);
            });

            noFieldset.forEach(function(el) {
                jeAppendNewBadge(el.closest('label') || el.parentElement, versionById.get(el.id));
            });

            byFieldset.forEach(function(newEls, fieldset) {
                if (jeAllControlsNew(fieldset, newIdSet)) {
                    jeAppendNewBadge(fieldset.querySelector(':scope > legend.sectionTitle'), versionById.get(newEls[0].id));
                } else {
                    newEls.forEach(function(el) {
                        // Same rule one level down: an expander whose controls are all new gets
                        // one badge on its summary, and a tag row (Enable + Position) one on its label.
                        var details = el.closest('details');
                        var host = (details && jeAllControlsNew(details, newIdSet))
                            ? details.querySelector(':scope > summary')
                            : (el.closest('.je-tag-row') ? el.closest('.je-tag-row').querySelector('label') : (el.closest('label') || el.parentElement));
                        if (!host || host.querySelector(':scope > .je-new-badge')) return;
                        jeAppendNewBadge(host, versionById.get(el.id));
                    });
                }
            });
        }

        /** True when every control inside container is a newly added setting. */
        function jeAllControlsNew(container, newIdSet) {
            var ids = Array.from(container.querySelectorAll('input[id], select[id], textarea[id], button[id]')).map(function(el) { return el.id; });
            return ids.length > 0 && ids.every(function(id) { return newIdSet.has(id); });
        }

        /**
         * Overview → Optional Dependencies
         * Renders a card per optional plugin with its detected state.
         * Sources the booleans populated by checkInstalledPlugins() —
         * `null` means the /Plugins probe hasn't completed (or failed),
         * rendered as "Checking…" rather than asserting missing.
         */
        var OPTIONAL_PLUGINS = [
            { key: 'fileTransformation', name: 'File Transformation', icon: 'transform',       url: 'https://github.com/IAmParadox27/jellyfin-plugin-file-transformation', purpose: 'Required by Custom Tabs, Plugin Pages, and other plugins that modify the web client.', getFlag: function(){ return hasFileTransformation; } },
            { key: 'pluginPages',        name: 'Plugin Pages',        icon: 'view_list',       url: 'https://github.com/IAmParadox27/jellyfin-plugin-pages',               purpose: 'Sidebar pages for Bookmarks, Hidden Content, Requests, Calendar.',                   getFlag: function(){ return hasPluginPages; } },
            { key: 'customTabs',         name: 'Custom Tabs',         icon: 'tab',             url: 'https://github.com/IAmParadox27/jellyfin-plugin-custom-tabs',         purpose: 'Home-page tab entries for Bookmarks, Hidden Content, Requests, Calendar.',          getFlag: function(){ return hasCustomTabs; } },
            { key: 'introSkipper',       name: 'Intro Skipper',       icon: 'skip_next',       url: 'https://github.com/intro-skipper/intro-skipper',                      purpose: 'Source of timestamps for Auto-skip Intro / Auto-skip Outro.',                        getFlag: function(){ return hasIntroSkipper; } },
            { key: 'inPlayerEpisodePreview', name: 'In-Player Episode Preview', icon: 'movie_filter', url: 'https://github.com/Namo2/InPlayerEpisodePreview',            purpose: 'Enables the in-player Episode Preview keyboard shortcut.',                           getFlag: function(){ return hasInPlayerEpisodePreview; } },
            { key: 'kefinTweaks',        name: 'KefinTweaks',         icon: 'bookmark_border', url: 'https://github.com/ranaldsgift/KefinTweaks',                          purpose: 'Renders the Watchlist UI in Jellyfin. Required to view watchlisted items from the Seerr Watchlist features. Installs as a web-mod (not a normal plugin), detected via its injected scripts.', getFlag: function(){ return hasKefinTweaks; } }
        ];
        function renderOptionalPluginsDashboard() {
            var root = document.getElementById('je-optional-plugins');
            if (!root) return;
            root.textContent = '';
            OPTIONAL_PLUGINS.forEach(function(dep) {
                var flag = dep.getFlag();
                var state, statusText;
                if (flag === true)       { state = 'installed'; statusText = 'Installed'; }
                else if (flag === false) { state = 'missing';   statusText = 'Not installed'; }
                else                     { state = 'unknown';   statusText = 'Checking…'; }

                // When the plugin is installed-but-disabled (status ≠ Active),
                // flip to an amber "disabled" state so the admin knows to
                // re-enable it rather than wonder why features don't work.
                if (flag === false && _jeDisabledPlugins[dep.key]) {
                    state = 'warn';
                    statusText = 'Installed but disabled in Dashboard > Plugins';
                }

                // Only surface a compat warning for Custom Tabs when we've
                // actually completed the probe — not while it's still pending
                // (customTabsCompatState === null). This avoids a transient
                // "incompatible" flash during the initial load.
                if (dep.key === 'customTabs' && flag === true) {
                    if (customTabsCompatState === 'incompatible') {
                        state = 'warn';
                        statusText = 'Installed, config shape not recognized (auto-create disabled)';
                    } else if (customTabsCompatState === 'probe-failed') {
                        state = 'warn';
                        statusText = "Installed, couldn't read config (auto-create disabled)";
                    } else if (customTabsCompatState === null) {
                        statusText = 'Installed, checking config…';
                    }
                }
                var card = document.createElement('div');
                card.className = 'je-optional-plugin-card je-state-' + state;
                var icon = document.createElement('i');
                icon.className = 'material-icons je-optional-plugin-icon';
                icon.setAttribute('aria-hidden', 'true');
                icon.textContent = state === 'installed' ? 'check_circle'
                                 : state === 'warn'      ? 'warning'
                                 : state === 'unknown'   ? 'help_outline'
                                 : 'radio_button_unchecked';
                card.appendChild(icon);
                var body = document.createElement('div');
                body.className = 'je-optional-plugin-body';
                var name = document.createElement('div');
                name.className = 'je-optional-plugin-name';
                name.textContent = dep.name;
                body.appendChild(name);
                var status = document.createElement('div');
                status.className = 'je-optional-plugin-status';
                status.textContent = statusText;
                body.appendChild(status);
                var purpose = document.createElement('div');
                purpose.className = 'je-optional-plugin-purpose';
                purpose.textContent = dep.purpose;
                body.appendChild(purpose);
                card.appendChild(body);

                // External link icon in the top-right — opens the plugin's
                // home repo in a new tab. noopener/noreferrer both for security
                // and so the opened page can't manipulate this window.
                if (dep.url) {
                    var link = document.createElement('a');
                    link.className = 'je-optional-plugin-link';
                    link.href = dep.url;
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';
                    link.title = 'Open ' + dep.name + ' on GitHub';
                    link.setAttribute('aria-label', 'Open ' + dep.name + ' on GitHub');
                    var linkIcon = document.createElement('i');
                    linkIcon.className = 'material-icons';
                    linkIcon.setAttribute('aria-hidden', 'true');
                    linkIcon.textContent = 'open_in_new';
                    link.appendChild(linkIcon);
                    card.appendChild(link);
                }

                root.appendChild(card);
            });
        }

        /**
         * Overview → Features
         * Renders a row per JE feature with one of three states:
         *   - on   (green)   : enabled and all required deps/config present
         *   - warn (amber)   : enabled but missing a dep or required config
         *   - off  (faded)   : disabled
         * Clicking a row jumps to the tab where the feature lives.
         *
         * Rules reference form inputs (live DOM) rather than a snapshot so this
         * updates correctly after every dependency re-evaluation.
         */
        function renderFeaturesDashboard() {
            var root = document.getElementById('je-features-dashboard');
            if (!root) return;

            function bool(id) {
                var el = document.getElementById(id);
                return !!(el && el.checked);
            }
            function val(id) {
                var el = document.getElementById(id);
                return el ? (el.value || '').trim() : '';
            }
            function anyArrConfigured() {
                var cards = document.querySelectorAll('#sonarrInstancesList .arr-instance-card, #radarrInstancesList .arr-instance-card');
                for (var i = 0; i < cards.length; i++) {
                    var url = cards[i].querySelector('.arr-instance-url');
                    var key = cards[i].querySelector('.arr-instance-apikey');
                    if (url && key && url.value.trim() && key.value.trim()) return true;
                }
                return false;
            }
            function seerrConfigured() {
                return !!val('jellyseerrUrls') && !!val('JellyseerrApiKey');
            }

            var features = [];
            function feat(name, enabled, tab, detail, warn) {
                if (!enabled) { features.push({ name: name, state: 'off', tab: tab, detail: 'Disabled' }); return; }
                features.push({ name: name, state: warn ? 'warn' : 'on', tab: tab, detail: detail });
            }

            // Display
            feat('Remove from Continue Watching', bool('removeContinueWatchingEnabled'), 'display', 'Enabled');
            var tagCount = ['qualityTagsEnabled','genreTagsEnabled','languageTagsEnabled','ratingTagsEnabled','ageRatingTagsEnabled','peopleTagsEnabled'].filter(bool).length;
            feat('Media Tags', tagCount > 0, 'display', tagCount + ' tag type(s) enabled');
            feat('Random Button', bool('randomButtonEnabled'), 'display', 'Enabled');

            // Playback
            feat('Custom Pause Screen', bool('pauseScreenEnabled'), 'playback', 'Enabled');
            feat('Age Rating on Playback Start', bool('showPlaybackRatingBadge'), 'playback', 'Enabled');
            feat('Long press for 2x speed', bool('longPress2xEnabled'), 'playback', 'Enabled (touch devices)');
            var autoSkip = bool('autoSkipIntro') || bool('autoSkipOutro');
            var autoSkipWarn = autoSkip && hasIntroSkipper !== true;
            feat('Auto-skip Intro/Outro', autoSkip, 'playback',
                autoSkipWarn ? 'Enabled but Intro Skipper plugin is missing' : 'Enabled',
                autoSkipWarn);
            var tabSwitch = bool('autoPauseEnabled') || bool('autoResumeEnabled') || bool('autoPipEnabled');
            feat('Tab-switch actions', tabSwitch, 'playback', 'Auto-pause / resume / PiP');

            // Pages
            var bookmarksWarn = bool('bookmarksEnabled') && (
                (bool('bookmarksUsePluginPages') && hasPluginPages !== true) ||
                (bool('bookmarksUseCustomTabs')  && hasCustomTabs  !== true)
            );
            feat('Bookmarks', bool('bookmarksEnabled'), 'pages',
                bookmarksWarn ? 'Missing required integration plugin' : 'Enabled',
                bookmarksWarn);
            var hcWarn = bool('hiddenContentEnabled') && (
                (bool('hiddenContentUsePluginPages') && hasPluginPages !== true) ||
                (bool('hiddenContentUseCustomTabs')  && hasCustomTabs  !== true)
            );
            feat('Hidden Content', bool('hiddenContentEnabled'), 'pages',
                hcWarn ? 'Missing required integration plugin' : 'Enabled',
                hcWarn);
            var reqWarn = bool('downloadsPageEnabled') && !seerrConfigured() && !anyArrConfigured();
            feat('Requests Page', bool('downloadsPageEnabled'), 'pages',
                reqWarn ? 'Enabled but neither Seerr nor *arr is configured' : 'Enabled',
                reqWarn);
            var calWarn = bool('calendarPageEnabled') && !anyArrConfigured();
            feat('Calendar Page', bool('calendarPageEnabled'), 'pages',
                calWarn ? 'Enabled but no *arr instance is configured' : 'Enabled',
                calWarn);

            // Custom splash screen / branding. Both the splash screen and the
            // branding image uploads (icons/favicon/logos) are handled by Jellyfin
            // Enhanced itself at request time, so no extra plugin is required.
            var splashOn = bool('enableCustomSplashScreen');
            feat('Custom splash / branding', splashOn, 'extras', 'Enabled', false);

            // Extras
            var elsewhereWarn = bool('elsewhereEnabled') && !val('TMDB_API_KEY');
            feat('Elsewhere (streaming providers)', bool('elsewhereEnabled'), 'elsewhere',
                elsewhereWarn ? 'Enabled but TMDB API key is missing' : 'Enabled',
                elsewhereWarn);

            // Seerr
            var seerrWarn = bool('jellyseerrEnabled') && !seerrConfigured();
            feat('Seerr integration', bool('jellyseerrEnabled'), 'seerr',
                seerrWarn ? 'Enabled but Seerr URL or API key missing' : 'Enabled',
                seerrWarn);

            var seerrLinkOn = bool('jellyseerrEnabled') && bool('jellyseerrShowDetailPageLink');
            var seerrLinkWarn = seerrLinkOn && !seerrConfigured();
            feat('Seerr detail-page link', seerrLinkOn, 'seerr',
                seerrLinkWarn ? 'Enabled but Seerr URL or API key missing' : 'Enabled',
                seerrLinkWarn);

            // Watchlist (Seerr tab). Sync and "add requested → watchlist" both
            // need KefinTweaks to actually render the watchlist UI in Jellyfin;
            // the feature writes the data either way, but the user can't see
            // it without KefinTweaks.
            var watchlistAny = bool('addRequestedMediaToWatchlist') || bool('syncJellyseerrWatchlist');
            var watchlistWarn = watchlistAny && hasKefinTweaks !== true;
            feat('Watchlist sync', watchlistAny, 'seerr',
                watchlistWarn ? 'Enabled but KefinTweaks plugin not installed (watchlist UI won\'t render)' : 'Enabled',
                watchlistWarn);

            // *arr
            var arrLinksWarn = bool('arrLinksEnabled') && !anyArrConfigured();
            feat('*arr detail-page links', bool('arrLinksEnabled'), 'arr',
                arrLinksWarn ? 'Enabled but no *arr instance is configured' : 'Enabled',
                arrLinksWarn);
            var tagsSyncWarn = bool('arrTagsSyncEnabled') && !anyArrConfigured();
            feat('*arr tags sync', bool('arrTagsSyncEnabled'), 'arr',
                tagsSyncWarn ? 'Enabled but no *arr instance is configured' : 'Enabled',
                tagsSyncWarn);

            // Stable ordering: warnings first, then on, then off
            features.sort(function(a, b) {
                var ord = { warn: 0, on: 1, off: 2 };
                return ord[a.state] - ord[b.state];
            });

            root.textContent = '';
            if (features.length === 0) {
                var empty = document.createElement('div');
                empty.className = 'je-checklist-empty';
                empty.textContent = 'No features configured yet.';
                root.appendChild(empty);
                return;
            }
            features.forEach(function(f) {
                var row = document.createElement('button');
                row.type = 'button';
                row.className = 'je-feature-row je-state-' + f.state;
                row.setAttribute('data-target', f.tab);
                var icon = document.createElement('i');
                icon.className = 'material-icons je-feature-icon';
                icon.setAttribute('aria-hidden', 'true');
                icon.textContent = f.state === 'on'   ? 'check_circle'
                                 : f.state === 'warn' ? 'warning'
                                 : 'radio_button_unchecked';
                row.appendChild(icon);
                var body = document.createElement('div');
                body.className = 'je-feature-body';
                var name = document.createElement('div');
                name.className = 'je-feature-name';
                name.textContent = f.name;
                body.appendChild(name);
                var detail = document.createElement('div');
                detail.className = 'je-feature-detail';
                detail.textContent = f.detail;
                body.appendChild(detail);
                row.appendChild(body);
                row.addEventListener('click', function() {
                    var targetTab = f.tab;
                    var tabBtn = document.querySelector('.jellyfin-tab-button[data-tab="' + targetTab + '"]');
                    if (tabBtn) tabBtn.click();
                });
                root.appendChild(row);
            });
        }

        // ==============================================================
        // Gated help (phase 5). Any setup-instruction block that only
        // applies when a specific toggle is on lives under a
        // [data-gated-by="<checkbox-id>"] attribute. Hidden when the
        // toggle is off; visible when on. Transitions from off→on also
        // auto-open the accordion so the admin doesn't have to hunt
        // for the freshly-revealed help.
        //
        // Declarative tag + generic dispatcher = no per-section wiring.
        // Adding a new gated help block means: drop data-gated-by on
        // the element + add the checkbox id below to GATED_HELP_IDS.
        // ==============================================================

        // Track prior checked state per gated-help parent so we can
        // detect an off→on transition in the change listener and
        // auto-expand the just-revealed accordion.
        var _jeGatedHelpState = Object.create(null);

        /**
         * Syncs visibility of every [data-gated-by] element to its
         * parent checkbox's checked state. If autoExpandOnRise is true
         * AND a parent just went from unchecked to checked, the gated
         * `<details>` is auto-opened.
         */
        function applyGatedHelp(autoExpandOnRise) {
            var gated = document.querySelectorAll('[data-gated-by]');
            gated.forEach(function(el) {
                var parentAttr = el.getAttribute('data-gated-by');
                if (!parentAttr) return;
                // Allow comma-separated IDs: ALL listed parents must be checked
                // for the gated element to show. Used by Custom Tabs auto-manage
                // toggles which depend on BOTH `*UseCustomTabs` AND the master
                // `*Enabled` toggle for the feature.
                var parentIds = parentAttr.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
                var allOn = true;
                var anyRise = false;
                parentIds.forEach(function(parentId) {
                    var parent = document.getElementById(parentId);
                    if (!parent) { allOn = false; return; }
                    var thisOn = !!parent.checked;
                    if (!thisOn) allOn = false;
                    var wasOn = _jeGatedHelpState[parentId] === true;
                    if (thisOn && !wasOn) anyRise = true;
                    _jeGatedHelpState[parentId] = thisOn;
                });
                el.hidden = !allOn;
                if (autoExpandOnRise && allOn && anyRise && el.tagName === 'DETAILS') {
                    el.open = true;
                }
            });
        }

        // Wire one change listener per unique parent id referenced by
        // [data-gated-by]. A single bulk dispatch refreshes every gated
        // element regardless of which parent fired.
        //
        // We also prime `_jeGatedHelpState` with each parent's current
        // checked value at wire time. Without priming, the first user
        // click on a gated parent that was already checked (e.g. after a
        // config load flipped the DOM state out of band) would be read
        // as `wasOn === undefined (falsy) → isOn === true`, i.e. a rise,
        // and auto-expand when it shouldn't. Priming closes that hole
        // for the initial render AND for any parent the config loader
        // set programmatically (programmatic `.checked = true` does NOT
        // fire a change event, so the listener wouldn't see it).
        (function wireGatedHelp() {
            var gated = document.querySelectorAll('[data-gated-by]');
            var uniqueParents = Object.create(null);
            gated.forEach(function(el) {
                var attr = el.getAttribute('data-gated-by');
                if (!attr) return;
                attr.split(',').map(function(s) { return s.trim(); }).filter(Boolean).forEach(function(id) {
                    uniqueParents[id] = true;
                });
            });
            Object.keys(uniqueParents).forEach(function(id) {
                var parent = document.getElementById(id);
                if (!parent) {
                    console.warn('[JE] gated-help: parent checkbox #' + id + ' not found — help will stay hidden');
                    return;
                }
                _jeGatedHelpState[id] = !!parent.checked;
                parent.addEventListener('change', function() {
                    try { applyGatedHelp(true); } catch (e) {
                        console.warn('[JE] applyGatedHelp threw in change handler:', e);
                    }
                });
            });
            // Reflect initial visibility once so the DOM matches the primed
            // state immediately (no flicker when loadConfig eventually
            // triggers updateAllDependencies → applyGatedHelp(false)).
            try { applyGatedHelp(false); } catch (e) {
                console.warn('[JE] applyGatedHelp threw during init:', e);
            }
        })();

        /**
         * Orchestrator: evaluates all section, individual, and parent dependency rules.
         * Each step is isolated so a throw in the status dashboard (which reads a lot
         * of field values) can't cascade and break dependency updates.
         */
        function updateAllDependencies() {
            SECTION_DEPS.forEach(updateSectionDep);
            INDIVIDUAL_DEPS.forEach(updateIndividualDep);
            CUSTOM_TABS_V12_HINTS.forEach(updateCustomTabsV12Hint);
            updateSearchExcludeLibraryWarning();
            PARENT_DEPS.forEach(updateParentDep);
            updateClientTagCacheControlsVisibility();
            // `updateStatusDashboard` and the legacy `renderChecklist` both
            // now delegate to `renderServiceStatusDashboard`. Calling both
            // here would rebuild the service grid TWICE per dependency tick
            // (~30 times during a TMDB key rotation). One call is enough.
            try {
                renderServiceStatusDashboard();
            } catch (e) {
                console.warn('[JE] renderServiceStatusDashboard threw; dashboard may be stale:', e);
            }
            try {
                renderOptionalPluginsDashboard();
            } catch (e) {
                console.warn('[JE] renderOptionalPluginsDashboard threw:', e);
            }
            try {
                renderFeaturesDashboard();
            } catch (e) {
                console.warn('[JE] renderFeaturesDashboard threw:', e);
            }
            try {
                // Re-sync banner parent gating. loadConfig sets .checked
                // programmatically, which DOESN'T fire the change event our
                // banner listener uses — so we need an explicit refresh here.
                if (typeof syncAllBannerParents === 'function') syncAllBannerParents();
            } catch (e) {
                console.warn('[JE] syncAllBannerParents threw:', e);
            }
            try {
                // Don't auto-expand when triggered by a bulk dep sync —
                // that would fire `open = true` on every tick the parent
                // is checked, which is noisy. Real off→on transitions
                // go through the dedicated change listener above.
                applyGatedHelp(false);
            } catch (e) {
                console.warn('[JE] applyGatedHelp threw; gated help may be stale:', e);
            }
        }

        /**
         * Reads `.value` from a selector, returning '' if the element is missing.
         * Logs once per missing selector so DOM/JS mismatches surface in devtools
         * instead of throwing silently through a querySelector chain.
         * @param {string} sel - CSS selector
         * @returns {string} Trimmed value, or '' if element not found
         */
        var _jeMissingSelectorsWarned = Object.create(null);
        function readFieldValue(sel) {
            var el = document.querySelector(sel);
            if (!el) {
                if (!_jeMissingSelectorsWarned[sel]) {
                    _jeMissingSelectorsWarned[sel] = true;
                    console.warn('[JE] status dashboard: selector "' + sel + '" not found');
                }
                return '';
            }
            return (el.value || '').trim();
        }

        /**
         * Counts configured arr instance cards for a given type (sonarr|radarr).
         * An instance is "configured" when both URL and API key are non-empty.
         * Returns -1 (not 0) if the instance list container is missing, so callers
         * can distinguish "user configured zero" from "DOM not ready / mismatched."
         * @param {string} type - 'sonarr' or 'radarr'
         * @returns {number} Count of fully-configured instances, or -1 if list missing
         */
        var _jeMissingListWarned = Object.create(null);
        function countArrInstances(type) {
            var listId = type === 'sonarr' ? 'sonarrInstancesList' : 'radarrInstancesList';
            var list = document.getElementById(listId);
            if (!list) {
                if (!_jeMissingListWarned[listId]) {
                    _jeMissingListWarned[listId] = true;
                    console.warn('[JE] status dashboard: #' + listId + ' not found');
                }
                return -1;
            }
            var cards = list.querySelectorAll('.arr-instance-card');
            var count = 0;
            for (var i = 0; i < cards.length; i++) {
                var url = cards[i].querySelector('.arr-instance-url');
                var key = cards[i].querySelector('.arr-instance-apikey');
                if (url && url.value.trim() && key && key.value.trim()) count++;
            }
            return count;
        }

        /**
         * Merged Service Status renderer.
         *
         * Replaces the legacy status-card grid + Integration Health checklist
         * with a single card list that sources:
         *   - config state from the live form (key/URL/API-key presence, *arr
         *     instance counts, Seerr URL list),
         *   - test-result state from the connection-test cache (so a green
         *     "connected" or red "failed" card reflects the latest probe).
         *
         * Card states (drive the left-border accent and icon):
         *   - 'ok'      green    — configured; latest test passed (or no test
         *                           run yet but no negative signal)
         *   - 'warn'    amber    — configured partially (e.g. Seerr URL but no
         *                           API key) OR connection-test returned
         *                           amber (reachable but not healthy)
         *   - 'error'   red      — connection-test returned error
         *   - 'pending' grey dot — enabled + complete config, no cached result
         *   - 'off'     faded    — disabled / no config entered yet
         *
         * Each card is a <button> that jumps to the relevant settings tab.
         */
        function renderServiceStatusDashboard() {
            var root = document.getElementById('je-service-dashboard');
            if (!root) return;

            var cards = [];
            function pushCard(opts) { cards.push(opts); }

            // TMDB — no dedicated test endpoint; presence-based state only.
            var tmdbKey = readFieldValue('#TMDB_API_KEY');
            pushCard({
                id: 'tmdb',
                name: 'TMDB',
                tab: 'elsewhere',
                scrollTo: '#TMDB_API_KEY',
                state: tmdbKey ? 'ok' : 'off',
                detail: tmdbKey ? 'API key set' : 'No API key',
                icon: 'vpn_key'
            });

            // Seerr
            var seerrEnabled = document.getElementById('jellyseerrEnabled');
            var seerrUrls = readFieldValue('#jellyseerrUrls');
            var seerrKey = readFieldValue('#JellyseerrApiKey');
            if (seerrEnabled && seerrEnabled.checked) {
                if (seerrUrls && seerrKey) {
                    var r = checklistRowState('seerr', 'Configured, not yet verified');
                    var urlCount = seerrUrls.split(/\r?\n/).filter(function(u) { return u.trim(); }).length;
                    pushCard({
                        id: 'seerr', name: 'Seerr', tab: 'seerr', icon: 'bolt',
                        state: r.state === 'amber' ? 'warn' : r.state === 'pending' ? 'pending' : r.state,
                        detail: r.detail + (urlCount > 1 ? ' · ' + urlCount + ' URLs' : '')
                    });
                } else {
                    pushCard({
                        id: 'seerr', name: 'Seerr', tab: 'seerr', icon: 'bolt', state: 'warn',
                        detail: !seerrUrls && !seerrKey ? 'Enabled but URL and API key missing'
                            : !seerrUrls ? 'URL missing' : 'API key missing'
                    });
                }
            } else if (seerrUrls || seerrKey) {
                pushCard({
                    id: 'seerr', name: 'Seerr', tab: 'seerr', icon: 'bolt', state: 'off',
                    detail: 'Configured but integration disabled'
                });
            }

            // Sonarr / Radarr — one card per instance, reusing test-cache keys
            ['sonarr', 'radarr'].forEach(function(type) {
                var list = document.getElementById(type + 'InstancesList');
                if (!list) return;
                var arrCards = list.querySelectorAll('.arr-instance-card');
                arrCards.forEach(function(card) {
                    var urlEl = card.querySelector('.arr-instance-url');
                    var keyEl = card.querySelector('.arr-instance-apikey');
                    var nameEl = card.querySelector('.arr-instance-name');
                    if (!urlEl || !keyEl) return;
                    var urlVal = (urlEl.value || '').trim();
                    var keyVal = (keyEl.value || '').trim();
                    if (!urlVal && !keyVal) return;
                    var nameVal = (nameEl && nameEl.value ? nameEl.value.trim() : '')
                                  || (type === 'sonarr' ? 'Sonarr' : 'Radarr');
                    var cacheKey = type + ':' + _jeNormalizeArrUrl(urlVal);
                    var icon = type === 'sonarr' ? 'tv' : 'movie';

                    // Disabled instances (Enabled checkbox unchecked) render as
                    // a grayed-out "Disabled" card regardless of test-cache
                    // state — a stale red/green badge on a disabled entry is
                    // misleading because the instance isn't being used.
                    var enCb = card.querySelector('.arr-instance-enabled');
                    var isDisabled = enCb && !enCb.checked;
                    if (isDisabled) {
                        pushCard({
                            id: cacheKey, name: nameVal, tab: 'arr', icon: icon, state: 'off',
                            detail: 'Disabled'
                        });
                        return;
                    }

                    if (!urlVal || !keyVal) {
                        pushCard({
                            id: cacheKey, name: nameVal, tab: 'arr', icon: icon, state: 'warn',
                            detail: !urlVal ? 'URL missing' : 'API key missing'
                        });
                        return;
                    }
                    var r = checklistRowState(cacheKey, 'Configured, not yet verified');
                    pushCard({
                        id: cacheKey, name: nameVal, tab: 'arr', icon: icon,
                        state: r.state === 'amber' ? 'warn' : r.state === 'pending' ? 'pending' : r.state,
                        detail: r.detail
                    });
                });
            });

            // Bazarr — no test endpoint; URL presence is the best signal
            var bazarrUrl = readFieldValue('#bazarrUrl');
            var bazarrMappings = readFieldValue('#bazarrUrlMappings');
            if (bazarrUrl || bazarrMappings) {
                pushCard({
                    id: 'bazarr', name: 'Bazarr', tab: 'arr', icon: 'subtitles',
                    state: bazarrUrl ? 'ok' : 'warn',
                    detail: bazarrUrl ? 'URL configured' : 'Only URL mappings set'
                });
            }

            // Shoko — no test endpoint; URL + API key presence is the best signal
            var shokoUrl = readFieldValue('#shokoUrl');
            var shokoApiKey = readFieldValue('#shokoApiKey');
            if (shokoUrl || shokoApiKey) {
                pushCard({
                    id: 'shoko', name: 'Shoko', tab: 'arr', icon: 'live_tv',
                    state: (shokoUrl && shokoApiKey) ? 'ok' : 'warn',
                    detail: (shokoUrl && shokoApiKey) ? 'URL and API key configured' : (!shokoUrl ? 'URL missing' : 'API key missing')
                });
            }

            root.textContent = '';
            if (cards.length === 0) {
                var empty = document.createElement('div');
                empty.className = 'je-checklist-empty';
                empty.textContent = 'Configure TMDB, Seerr, or an *arr instance to see its status here.';
                root.appendChild(empty);
                return;
            }

            // Order: warn/error first, then pending, then ok, then off (faded)
            var ord = { error: 0, warn: 1, pending: 2, ok: 3, off: 4 };
            cards.sort(function(a, b) { return (ord[a.state] || 99) - (ord[b.state] || 99); });

            cards.forEach(function(c) {
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'je-service-card je-state-' + c.state;
                btn.setAttribute('data-target', c.tab);
                btn.setAttribute('data-status-id', c.id);
                var iconEl = document.createElement('i');
                iconEl.className = 'material-icons je-service-icon';
                iconEl.setAttribute('aria-hidden', 'true');
                iconEl.textContent = c.state === 'ok'      ? 'check_circle'
                                   : c.state === 'warn'    ? 'warning'
                                   : c.state === 'error'   ? 'error'
                                   : c.state === 'pending' ? 'hourglass_empty'
                                   : (c.icon || 'radio_button_unchecked');
                btn.appendChild(iconEl);
                var body = document.createElement('div');
                body.className = 'je-service-body';
                var nameEl = document.createElement('div');
                nameEl.className = 'je-service-name';
                nameEl.textContent = c.name;
                body.appendChild(nameEl);
                var detail = document.createElement('div');
                detail.className = 'je-service-detail';
                detail.textContent = c.detail;
                body.appendChild(detail);
                btn.appendChild(body);
                btn.addEventListener('click', function() {
                    jeJumpToTab(c.tab, c.scrollTo);
                });
                root.appendChild(btn);
            });
        }

        // Back-compat: older code paths still call these by name. Delegate both
        // to the unified renderer instead of maintaining dead duplicates.
        function updateStatusDashboard() { renderServiceStatusDashboard(); }

        /**
         * Shows clear-client-cache controls only when server-side tag cache is disabled.
         */
        function updateClientTagCacheControlsVisibility() {
            var serverModeCheckbox = document.getElementById('tagCacheServerMode');
            var controls = document.getElementById('clientTagCacheControls');
            var serverControls = document.getElementById('serverTagCacheControls');
            var localStorageFallbackContainer = document.getElementById('tagsLocalStorageFallbackContainer');
            var localStorageFallbackCheckbox = document.getElementById('enableTagsLocalStorageFallback');
            if (!serverModeCheckbox || !controls) return;

            if (serverControls) {
                serverControls.style.display = serverModeCheckbox.checked ? '' : 'none';
            }

            if (localStorageFallbackContainer) {
                var hide = serverModeCheckbox.checked ? 'none' : '';
                localStorageFallbackContainer.style.display = hide;
                var localStorageFallbackDesc = document.querySelector('[data-desc-for="enableTagsLocalStorageFallback"]');
                if (localStorageFallbackDesc) localStorageFallbackDesc.style.display = hide;
            }

            if (!serverModeCheckbox.checked && localStorageFallbackCheckbox) {
                localStorageFallbackCheckbox.checked = true;
            }

            controls.style.display = serverModeCheckbox.checked ? 'none' : '';
            updateClearTagCachesQuickBtnVisibility();
        }

        // Reactive dependency updates (debounced for text inputs, immediate for checkboxes)
        var depDebounce;
        /** Debounced wrapper that delays updateAllDependencies by 150ms. */
        function debouncedUpdateDeps() {
            clearTimeout(depDebounce);
            depDebounce = setTimeout(updateAllDependencies, 150);
        }
        ['#TMDB_API_KEY', '#jellyseerr_TMDB_API_KEY'].forEach(function(sel) {
            document.querySelector(sel).addEventListener('input', debouncedUpdateDeps);
        });
        document.querySelector('#jellyseerrEnabled').addEventListener('change', updateAllDependencies);
        document.querySelector('#tagCacheServerMode').addEventListener('change', updateAllDependencies);
        document.querySelector('#metadataIconsEnabled').addEventListener('change', updateAllDependencies);
        ['#jellyseerrUrls', '#JellyseerrApiKey'].forEach(function(sel) {
            document.querySelector(sel).addEventListener('input', debouncedUpdateDeps);
        });

        // Drop persisted "Last tested <date>" entries when the inputs that produced
        // those tests change — otherwise an admin who rotated their TMDB API key or
        // changed Seerr URLs would keep seeing a green checkmark from the previous
        // credentials. The next test (or page render) re-establishes the row.
        function _wireInvalidate(sel, key) {
            var el = document.querySelector(sel);
            if (!el) return;
            var lastValue = el.value;
            // Use 'change' (fires on blur/commit) rather than 'input' (fires per
            // keystroke). Input-per-keystroke would invalidate + rebuild the
            // service-status grid 30+ times during a TMDB key rotation, causing
            // visible lag on slower machines. Change-on-commit gets the same
            // correctness outcome without the churn.
            el.addEventListener('change', function() {
                if (el.value !== lastValue) {
                    invalidatePersistedTest(key);
                    lastValue = el.value;
                }
            });
        }
        _wireInvalidate('#TMDB_API_KEY',         'tmdb');
        _wireInvalidate('#jellyseerr_TMDB_API_KEY', 'tmdb');
        _wireInvalidate('#jellyseerrUrls',       'seerr');
        _wireInvalidate('#JellyseerrApiKey',     'seerr');

        // Parent checkbox change listeners
        var parentIds = {};
        PARENT_DEPS.forEach(function(dep) { parentIds[dep.parent] = true; });
        Object.keys(parentIds).forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.addEventListener('change', updateAllDependencies);
        });
        CUSTOM_TABS_V12_HINTS.forEach(function(dep) {
            [dep.customId, dep.nativeId].forEach(function(id) {
                var el = document.getElementById(id);
                if (el) el.addEventListener('change', function() { updateCustomTabsV12Hint(dep); });
            });
        });
        var searchExcludeLibraryCheckbox = document.getElementById('jellyseerrSearchExcludeLibraryItems');
        if (searchExcludeLibraryCheckbox) searchExcludeLibraryCheckbox.addEventListener('change', updateSearchExcludeLibraryWarning);

        var originalTestTmdb = testTmdbConnection;
        testTmdbConnection = async function(event) {
            await originalTestTmdb(event);
            updateAllDependencies();
        };

        // === Arr Service Test Buttons ===

        /**
         * Produces a user-friendly error message from a connection test failure.
         * @param {Object} error - The ajax error object with a status property
         * @param {string} serviceName - Display name of the service
         * @param {string} url - The URL that was tested
         * @returns {string} Human-readable error message
         */
        function connectionErrorMessage(error, serviceName, url) {
            // surface backend's typed code/cf-ray so admins
            // see actionable messages (HtmlResponse, Cloudflare5xx, etc.)
            // instead of "API key rejected" for everything.
            // Jellyfin's ApiClient.ajax errors don't expose responseJSON;
            // they expose responseText. Parse it ourselves.
            var body = error && (error.responseJSON || (function () {
                try {
                    var txt = error.responseText || (error.response && error.response.text) || '';
                    if (typeof txt === 'string' && txt.length > 0 && txt.trim().charAt(0) === '{') {
                        return JSON.parse(txt);
                    }
                } catch (_) { /* not JSON, fall through */ }
                return null;
            })());
            if (body && body.code && body.message) {
                var prefix = body.cfRay ? '[' + serviceName + ' cf-ray=' + body.cfRay + '] ' : '';
                return prefix + body.message;
            }
            if (error.status === 502) return 'Could not reach ' + url + '. Check the URL is correct and ' + serviceName + ' is running.';
            if (error.status === 504) return 'Connection timed out. The server may be unreachable.';
            if (error.status === 401) return 'The API key was rejected. Check the key is correct.';
            if (error.status === 403) return 'Permission denied. Check the API key has the correct permissions, or that CSRF protection is not enabled in ' + serviceName + '.';
            if (error.status === 400) return 'Missing URL or API key.';
            if (error.status === 404) return 'The URL responded but did not look like a valid ' + serviceName + ' instance (HTTP 404 on /api/v1/user). It may be a reverse-proxy auth challenge.';
            return 'Connection to ' + serviceName + ' failed (error ' + (error.status || 'unknown') + ').';
        }

        async function testInstanceConnection(card) {
            var type = card.dataset.type;
            var urlVal = (card.querySelector('.arr-instance-url').value || '').trim();
            var apiKeyVal = (card.querySelector('.arr-instance-apikey').value || '').trim();
            var nameVal = card.querySelector('.arr-instance-name').value.trim() || (type === 'sonarr' ? 'Sonarr' : 'Radarr');
            var btn = card.querySelector('.arr-instance-test');
            var indicator = card.querySelector('.arr-instance-status');

            if (!urlVal || !apiKeyVal) {
                Dashboard.alert({ title: 'Missing Information', message: 'Please provide both a URL and API key to test the connection.' });
                return;
            }

            var _testToken = (typeof beginConnectionTest === 'function') ? beginConnectionTest() : undefined;
            btn.disabled = true;
            indicator.textContent = 'sync';
            // Don't wipe the indicator's class wholesale with `className = ...` —
            // that drops `arr-instance-status`, the identifier used to re-query
            // this element on subsequent Test clicks. classList.add leaves the
            // identifier class intact so repeated tests on the same card work.
            indicator.classList.add('status-check');
            indicator.style.color = 'var(--primary-accent-color, #00a4dc)';

            var arrCacheKey = type + ':' + _jeNormalizeArrUrl(urlVal);
            try {
                var endpoint = type === 'sonarr' ? 'sonarr' : 'radarr';
                var validationUrl = ApiClient.getUrl('/JellyfinEnhanced/arr/validate/' + endpoint, { url: urlVal });
                await ApiClient.ajax({ type: 'GET', url: validationUrl, dataType: 'json', headers: { 'X-Arr-ApiKey': apiKeyVal } });

                indicator.textContent = 'check_circle';
                indicator.style.color = '#52b54b';
                indicator.classList.remove('status-check');
                try { setConnectionTestResult(arrCacheKey, 'ok', 'Connected', _testToken); } catch (err) { /* cache is best-effort */ }
                jeTestAlert({ title: 'Success', message: 'Successfully connected to ' + nameVal + '!' });
            } catch (e) {
                indicator.classList.remove('status-check');
                indicator.textContent = 'error';
                indicator.style.color = '#dc3545';

                var msg = connectionErrorMessage(e, nameVal, urlVal);
                try {
                    var shortArrDetail = e && e.status === 401 ? 'API key rejected'
                        : e && (e.status === 500 || e.status === 0 || !e.status) ? 'Unreachable'
                        : 'Error ' + (e && e.status ? e.status : '?');
                    setConnectionTestResult(arrCacheKey, 'error', shortArrDetail, _testToken);
                } catch (err) { /* cache is best-effort */ }
                jeTestAlert({ title: 'Connection Failed', message: msg });
            } finally {
                btn.disabled = false;
            }

            updateAllDependencies();
        }

        // === URL Mapping Validation ===
        /**
         * Appends an issue message div to a validation result container.
         * @param {HTMLElement} container - The container element to append to
         * @param {string} text - The issue message text
         */
        function addIssue(container, text) {
            var div = document.createElement('div');
            div.style.cssText = 'margin-bottom: 0.5em;';
            div.textContent = text;
            container.appendChild(div);
        }

        /**
         * Validates URL mapping entries for syntactic correctness.
         * @param {Array<Object>} mappingDefs - Array of mapping definitions with inputId and expectedService
         * @param {string} btnId - DOM id of the validate button
         * @param {string} resultDivId - DOM id of the results container
         */
        async function validateMappingSet(mappingDefs, btnId, resultDivId) {
            var btn = document.getElementById(btnId);
            var resultDiv = document.getElementById(resultDivId);
            // Update button label safely whether the markup wraps the text
            // in a <span> (legacy emby-button pattern) or has bare text content.
            // The previous implementation assumed a <span> always existed and
            // threw `Cannot set properties of null` when it didn't, which silently
            // killed the rest of validation (button stayed disabled, result div
            // stayed empty, no error surfaced to the admin).
            function setBtnLabel(text) {
                var span = btn.querySelector('span');
                if (span) span.textContent = text;
                else btn.textContent = text;
            }
            btn.disabled = true;
            setBtnLabel('Validating...');
            resultDiv.textContent = '';
            resultDiv.style.display = 'block';
            resultDiv.style.backgroundColor = 'color-mix(in srgb, var(--primary-accent-color, #00a4dc) 10%, transparent)';
            resultDiv.style.borderLeft = '4px solid var(--primary-accent-color, #00a4dc)';
            resultDiv.textContent = 'Testing URLs...';

            // Collect all pairs with basic format validation first
            var pairs = [];
            var formatIssues = [];

            mappingDefs.forEach(function(m) {
                var textarea = document.getElementById(m.id);
                if (!textarea) return;
                textarea.value.split('\n').forEach(function(line, idx) {
                    var trimmed = line.trim();
                    if (!trimmed) return;
                    var lineLabel = m.service + ' line ' + (idx + 1);
                    var parts = trimmed.split('|');
                    if (parts.length !== 2) {
                        formatIssues.push(lineLabel + ': Invalid format. Use jellyfin_url|' + m.service.toLowerCase() + '_url separated by a pipe (|).');
                        return;
                    }
                    var left = parts[0].trim();
                    var right = parts[1].trim();
                    if (!left || !right) {
                        formatIssues.push(lineLabel + ': Both sides of the pipe must have a URL.');
                        return;
                    }
                    if (!left.match(/^https?:\/\//i)) {
                        formatIssues.push(lineLabel + ': Left side (' + left + ') should start with http:// or https://.');
                        return;
                    }
                    if (!right.match(/^https?:\/\//i)) {
                        formatIssues.push(lineLabel + ': Right side (' + right + ') should start with http:// or https://.');
                        return;
                    }
                    pairs.push({ left: left, right: right, service: m.service, label: lineLabel });
                });
            });

            if (formatIssues.length > 0 && pairs.length === 0) {
                resultDiv.textContent = '';
                resultDiv.style.backgroundColor = 'rgba(220, 53, 69, 0.15)';
                resultDiv.style.borderLeft = '4px solid #dc3545';
                formatIssues.forEach(function(i) { addIssue(resultDiv, i); });
                btn.disabled = false;
                setBtnLabel('Validate Mappings');
                return;
            }

            if (pairs.length === 0 && formatIssues.length === 0) {
                resultDiv.style.display = 'none';
                btn.disabled = false;
                setBtnLabel('Validate Mappings');
                return;
            }

            // Syntax-only validation: ensure each URL parses as a valid URL
            // and that the two sides of a mapping aren't identical. We used to
            // probe each URL server-side (and fall back to a browser probe) and
            // identify whether the far end was actually Sonarr/Radarr/Jellyfin/…
            // but mappings are only used to rewrite link hrefs, so "is this
            // URL parseable and distinct from its pair" is the only thing that
            // actually needs to hold. Probing breaks for anyone behind an auth
            // proxy (Authentik, Authelia, Cloudflare Access, …) because the
            // backend never reaches the service to identify it.
            var issues = formatIssues.slice();
            var warnings = [];
            var good = 0;

            pairs.forEach(function(p) {
                var leftTrim  = p.left.replace(/\/+$/, '');
                var rightTrim = p.right.replace(/\/+$/, '');

                function urlOk(u) {
                    try { var parsed = new URL(u); return !!parsed.host; }
                    catch (e) { return false; }
                }

                if (!urlOk(p.left)) {
                    issues.push(p.label + ': Left side (' + p.left + ') is not a valid URL.');
                    return;
                }
                if (!urlOk(p.right)) {
                    issues.push(p.label + ': Right side (' + p.right + ') is not a valid URL.');
                    return;
                }
                if (leftTrim.toLowerCase() === rightTrim.toLowerCase()) {
                    issues.push(p.label + ': Both sides are the same URL. Left should be Jellyfin, right should be ' + p.service + '.');
                    return;
                }

                good++;
            });

            // Display results
            resultDiv.textContent = '';
            if (issues.length === 0 && warnings.length === 0) {
                resultDiv.style.backgroundColor = 'rgba(82, 181, 75, 0.15)';
                resultDiv.style.borderLeft = '4px solid #52b54b';
                var icon = document.createElement('i');
                icon.className = 'material-icons';
                icon.style.cssText = 'vertical-align: middle; color: #52b54b; margin-right: 0.5em;';
                icon.textContent = 'check_circle';
                resultDiv.appendChild(icon);
                resultDiv.appendChild(document.createTextNode(good + ' mapping' + (good !== 1 ? 's' : '') + ' verified.'));
            } else {
                if (issues.length > 0) {
                    resultDiv.style.backgroundColor = 'rgba(220, 53, 69, 0.15)';
                    resultDiv.style.borderLeft = '4px solid #dc3545';
                    issues.forEach(function(i) { addIssue(resultDiv, i); });
                } else {
                    resultDiv.style.backgroundColor = 'rgba(255, 193, 7, 0.15)';
                    resultDiv.style.borderLeft = '4px solid #ffc107';
                }
                warnings.forEach(function(w) { addIssue(resultDiv, w); });
                if (good > 0) {
                    addIssue(resultDiv, good + ' other mapping' + (good !== 1 ? 's' : '') + ' verified.');
                }
            }

            btn.disabled = false;
            setBtnLabel('Validate Mappings');
        }

        // Per-service mapping validation helpers. Each service's Validate button
        // collects only its own instances' mappings (plus Bazarr's single field),
        // feeds them through validateMappingSet, and cleans up any temp textareas
        // it creates. Split from the old "validate everything" button so results
        // land next to the service being tested.
        function _jeValidateInstanceMappings(type, btnId, resultId, displayName) {
            var mappingDefs = [];
            var createdTempIds = [];
            // Wipe orphan temp textareas from a prior run (lets us also accept
            // those leftover from a previous failed validation with the same
            // prefix).
            document.querySelectorAll('textarea[data-arr-validate-temp-' + type + '="true"]').forEach(function(el) { el.remove(); });

            var listId = type + 'InstancesList';
            document.querySelectorAll('#' + listId + ' .arr-instance-card').forEach(function(card, idx) {
                var name = card.querySelector('.arr-instance-name').value.trim() || (displayName + ' ' + (idx + 1));
                var textarea = card.querySelector('.arr-instance-urlmappings');
                if (textarea && textarea.value.trim()) {
                    var tempId = 'arr-validate-' + type + '-' + idx;
                    var temp = document.createElement('textarea');
                    temp.id = tempId;
                    temp.value = textarea.value;
                    temp.style.display = 'none';
                    temp.setAttribute('data-arr-validate-temp-' + type, 'true');
                    document.body.appendChild(temp);
                    createdTempIds.push(tempId);
                    mappingDefs.push({ id: tempId, service: name });
                }
            });

            if (mappingDefs.length === 0) {
                Dashboard.alert({ title: 'No Mappings', message: 'No URL mappings configured for ' + displayName + '. Expand an instance card and fill in the URL Mappings field to validate.' });
                return;
            }
            var cleanup = function() {
                createdTempIds.forEach(function(id) {
                    var el = document.getElementById(id);
                    if (el) el.remove();
                });
            };
            validateMappingSet(mappingDefs, btnId, resultId)
                .finally(cleanup)
                .catch(function(err) {
                    // Without an explicit .catch, a thrown rejection (missing btn
                    // node, pre-await TypeError, failed Promise.all inside the
                    // validator) would leave the Validate button stuck on its
                    // disabled/"Validating..." state and the admin with no visible
                    // signal beyond an Uncaught (in promise) message in devtools.
                    console.error('[JE] mapping validation crashed:', err);
                    var btn = document.getElementById(btnId);
                    if (btn) {
                        btn.disabled = false;
                        var span = btn.querySelector('span');
                        if (span) span.textContent = 'Validate Mappings';
                        else btn.textContent = 'Validate Mappings';
                    }
                    try {
                        Dashboard.alert({ title: 'Validation error', message: 'Mapping validation crashed unexpectedly, check the browser console for details.' });
                    } catch (alertErr) {
                        console.warn('[JE] Dashboard.alert threw during validation-error notify:', alertErr);
                        try { window.alert('Validation error: ' + ((err && err.message) || err)); } catch (_) { /* last-resort notify — if alert() itself throws we've given up */ }
                    }
                });
        }

        var validateSonarrMappingsBtn = document.getElementById('validateSonarrMappingsBtn');
        if (validateSonarrMappingsBtn) {
            validateSonarrMappingsBtn.addEventListener('click', function() {
                _jeValidateInstanceMappings('sonarr', 'validateSonarrMappingsBtn', 'sonarrMappingsValidationResult', 'Sonarr');
            });
        }
        var validateRadarrMappingsBtn = document.getElementById('validateRadarrMappingsBtn');
        if (validateRadarrMappingsBtn) {
            validateRadarrMappingsBtn.addEventListener('click', function() {
                _jeValidateInstanceMappings('radarr', 'validateRadarrMappingsBtn', 'radarrMappingsValidationResult', 'Radarr');
            });
        }
        // Safety-net wrapper used by the three mapping-validate buttons.
        // Mirrors the .catch + button-reset handler inside _jeValidateInstanceMappings
        // so Bazarr/Seerr direct callers get the same treatment. Without this,
        // a rejected validateMappingSet() promise would leave the button stuck on
        // "Validating..." with only an Uncaught (in promise) in devtools.
        function _jeRunMappingValidation(mappingDefs, btnId, resultId) {
            validateMappingSet(mappingDefs, btnId, resultId).catch(function(err) {
                console.error('[JE] mapping validation crashed:', err);
                var b = document.getElementById(btnId);
                if (b) {
                    b.disabled = false;
                    var span = b.querySelector('span');
                    if (span) span.textContent = 'Validate Mappings';
                    else b.textContent = 'Validate Mappings';
                }
                try {
                    Dashboard.alert({ title: 'Validation error', message: 'Mapping validation crashed unexpectedly, check the browser console for details.' });
                } catch (alertErr) {
                    console.warn('[JE] Dashboard.alert threw during validation-error notify:', alertErr);
                    try { window.alert('Validation error: ' + ((err && err.message) || err)); } catch (_) { /* last-resort notify — if alert() itself throws we've given up */ }
                }
            });
        }

        var validateBazarrMappingsBtn = document.getElementById('validateBazarrMappingsBtn');
        if (validateBazarrMappingsBtn) {
            validateBazarrMappingsBtn.addEventListener('click', function() {
                var mappings = document.getElementById('bazarrUrlMappings');
                if (!mappings || !mappings.value.trim()) {
                    Dashboard.alert({ title: 'No Mappings', message: 'No Bazarr URL mappings configured. Fill in the Bazarr URL Mappings field above to validate.' });
                    return;
                }
                _jeRunMappingValidation(
                    [{ id: 'bazarrUrlMappings', service: 'Bazarr' }],
                    'validateBazarrMappingsBtn', 'bazarrMappingsValidationResult'
                );
            });
        }

        var validateShokoMappingsBtn = document.getElementById('validateShokoMappingsBtn');
        if (validateShokoMappingsBtn) {
            validateShokoMappingsBtn.addEventListener('click', function() {
                var mappings = document.getElementById('shokoUrlMappings');
                if (!mappings || !mappings.value.trim()) {
                    Dashboard.alert({ title: 'No Mappings', message: 'No Shoko URL mappings configured. Fill in the Shoko URL Mappings field above to validate.' });
                    return;
                }
                _jeRunMappingValidation(
                    [{ id: 'shokoUrlMappings', service: 'Shoko' }],
                    'validateShokoMappingsBtn', 'shokoMappingsValidationResult'
                );
            });
        }

        var validateSeerrMappingsBtn = document.getElementById('validateSeerrMappingsBtn');
        if (validateSeerrMappingsBtn) {
            validateSeerrMappingsBtn.addEventListener('click', function() {
                _jeRunMappingValidation(
                    [{ id: 'jellyseerrUrlMappings', service: 'Seerr' }],
                    'validateSeerrMappingsBtn', 'seerrMappingsValidationResult'
                );
            });
        }

        clearTagsCacheBtn.addEventListener('click', async () => {
            if (confirm("Clear all client caches?\n\nThis will force all clients to clear their quality and genre tag caches on next page load.")) {
                Dashboard.showLoadingMsg();
                try {
                    const config = await ApiClient.getPluginConfiguration(pluginId);
                    config.ClearLocalStorageTimestamp = Date.now();
                    await ApiClient.updatePluginConfiguration(pluginId, config);
                    Dashboard.hideLoadingMsg();
                    Dashboard.alert({
                        title: 'Success',
                        message: 'Cache clear signal sent. All clients will clear their caches on next page load.'
                    });
                } catch (e) {
                    Dashboard.hideLoadingMsg();
                    console.error('Failed to set cache clear timestamp:', e);
                    Dashboard.alert({
                        title: 'Error',
                        message: 'Failed to set cache clear timestamp. Check server logs for details.'
                    });
                }
            }
        });
        var rebuildTagCacheBtn = document.querySelector('#rebuildTagCacheBtn');
        if (rebuildTagCacheBtn) {
            rebuildTagCacheBtn.addEventListener('click', async () => {
                if (!confirm("Rebuild the server tag cache?\n\nThis re-scans the whole library in the background and may take a few minutes. Tags keep serving from the existing cache until the rebuild finishes.")) {
                    return;
                }
                rebuildTagCacheBtn.disabled = true;
                try {
                    const url = ApiClient.getUrl('/JellyfinEnhanced/tag-cache/rebuild');
                    const res = await ApiClient.ajax({ type: 'POST', url: url, dataType: 'json' });
                    Dashboard.alert({
                        title: 'Rebuild Started',
                        message: (res && res.message) || 'Rebuilding the tag cache in the background. Check the server logs for progress and completion.'
                    });
                } catch (e) {
                    console.error('Failed to start tag cache rebuild:', e);
                    var message = 'Failed to start the rebuild. Check server logs for details.';
                    if (e && e.status === 409) {
                        message = 'A tag cache rebuild is already in progress.';
                    } else if (e && e.status === 400) {
                        message = 'Enable Server-Side Tag Cache first.';
                    }
                    Dashboard.alert({ title: 'Error', message: message });
                } finally {
                    rebuildTagCacheBtn.disabled = false;
                }
            });
        }

        testJellyseerrBtn.addEventListener('click', testJellyseerrConnection);

        async function triggerSeerrScanNow() {
            const urls = (document.querySelector('#jellyseerrUrls').value || '').split('\n').map(u => u.trim()).filter(Boolean);
            const apiKey = (document.querySelector('#JellyseerrApiKey').value || '').trim();
            const btn = document.querySelector('#triggerSeerrScanNowBtn');
            const status = document.querySelector('#triggerSeerrScanNowStatus');

            if (!urls.length || !apiKey) {
                Dashboard.alert({ title: 'Missing Information', message: 'Please provide at least one Seerr URL and an API key in the Setup section above.' });
                return;
            }

            btn.disabled = true;
            status.textContent = 'sync';
            status.className = 'material-icons status-check';
            status.style.color = '#00a4dc';

            let triggered = false;
            let lastError = '';
            for (const url of urls) {
                try {
                    const triggerUrl = ApiClient.getUrl('/JellyfinEnhanced/jellyseerr/trigger-recently-added-scan', { url: url });
                    const res = await ApiClient.ajax({ type: 'POST', url: triggerUrl, dataType: 'json', headers: { 'X-Arr-ApiKey': apiKey } });
                    if (res && res.ok) {
                        triggered = true;
                        break;
                    }
                } catch (e) {
                    console.error('Seerr scan trigger failed for ' + url + ':', e);
                    lastError = connectionErrorMessage(e, 'Seerr', url);
                }
            }

            btn.disabled = false;
            status.classList.remove('status-check');

            if (triggered) {
                status.textContent = 'check_circle';
                status.style.color = '#52b54b';
                Dashboard.alert({ title: 'Scan Triggered', message: 'Triggered "Jellyfin Recently Added Scan" in Seerr' });
            } else {
                status.textContent = 'error';
                status.style.color = '#dc3545';
                Dashboard.alert({ title: 'Trigger Failed', message: lastError || 'Could not trigger a scan against any provided URL.' });
            }
        }

        document.querySelector('#triggerSeerrScanNowBtn').addEventListener('click', triggerSeerrScanNow);

        /**
         * Quick Action: re-test every external-service connection by proxying
         * clicks to the existing per-service test buttons. Preserves the per-
         * button UX (spinners, toasts, status-card updates) without duplicating
         * logic. Does NOT fabricate a cache — Phase 4 layers a real test cache
         * on top.
         *
         * Services invoked:
         *   - TMDB: one `.testTmdbBtn` click (multiple copies exist across tabs
         *     but any one test updates the shared status card)
         *   - Seerr: `#testJellyseerrBtn` when Seerr is enabled + URL + key set
         *   - Sonarr / Radarr: every `.arr-instance-test` inside the instance
         *     lists that has a URL + API key populated
         *
         * Skipping an unconfigured service is intentional — clicking a test
         * button with empty fields would pop a Dashboard.alert per service,
         * which is noisy for a "one-shot retest" action.
         */
        // Client-side throttle + in-flight lock for the Re-test-all batch.
        // The button is disabled for the full cooldown window so rapid
        // clicks can't fire ~8 parallel external-API tests per click. This
        // is NOT a security boundary — a determined user could still spam
        // via devtools — it's a guardrail against well-intentioned double-
        // clicks and page-reload retries.
        // Minimum time the Re-test-all button stays disabled even if every
        // test finishes instantly. Acts as the rate-limit floor so rapid
        // re-clicks can't fire dozens of external API tests per second.
        var RETEST_ALL_MIN_COOLDOWN_MS = 4 * 1000;
        // Hard upper bound for the polling loop. If a test still hasn't
        // resolved after this long, we force-release anyway so the UI
        // doesn't sit "Retesting…" forever on a hung connection.
        var RETEST_ALL_MAX_WAIT_MS = 25 * 1000;
        var _jeRetestAllCooldownUntil = 0;
        var _jeRetestAllReenableTimer = null;
        var _jeRetestAllPollTimer = null;

        function _setRetestAllButtonLabel(btn, text) {
            if (!btn) return;
            var labelEl = btn.querySelector('.je-quick-action-title');
            if (labelEl) labelEl.textContent = text;
        }

        var retestAllConnectionsBtn = document.getElementById('retestAllConnectionsBtn');
        if (retestAllConnectionsBtn) {
            var _retestAllOriginalLabel = retestAllConnectionsBtn.querySelector('.je-quick-action-title');
            _retestAllOriginalLabel = _retestAllOriginalLabel ? _retestAllOriginalLabel.textContent : 'Re-test all service connections';

            retestAllConnectionsBtn.addEventListener('click', function() {
                // Throttle: block rapid re-clicks within the cooldown window.
                var now = Date.now();
                if (now < _jeRetestAllCooldownUntil) {
                    var remainSec = Math.ceil((_jeRetestAllCooldownUntil - now) / 1000);
                    try {
                        Dashboard.alert({
                            title: 'Please wait',
                            message: 'Re-test is rate-limited. Try again in ' + remainSec + ' s.'
                        });
                    } catch (e) { /* ignore */ }
                    return;
                }

                // Invalidate the cache up front so every checklist row flips
                // to "pending" immediately; the individual test handlers will
                // repopulate it as they finish.
                try { clearConnectionTestCache(); } catch (e) { /* renderChecklist logs */ }

                // Suppress per-test Dashboard.alert dialogs for the duration
                // of this batch — per-service indicators + the Integration
                // Health rows already communicate results.
                _jeSuppressTestAlerts = true;
                _jeRetestAllCooldownUntil = now + RETEST_ALL_MIN_COOLDOWN_MS;
                retestAllConnectionsBtn.disabled = true;
                _setRetestAllButtonLabel(retestAllConnectionsBtn, 'Retesting…');

                var tested = 0;

                // TMDB — one click is enough; pages share the same backing key
                var tmdbBtn = document.querySelector('.testTmdbBtn');
                if (tmdbBtn && !tmdbBtn.disabled) { tmdbBtn.click(); tested++; }

                // Seerr — only if enabled with a URL + key (otherwise button
                // would show a "missing info" toast, which is noisy for a
                // batch re-test action).
                var seerrEnabled = document.querySelector('#jellyseerrEnabled');
                var seerrUrls = document.querySelector('#jellyseerrUrls');
                var seerrKey = document.querySelector('#JellyseerrApiKey');
                if (seerrEnabled && seerrEnabled.checked
                    && seerrUrls && seerrUrls.value.trim()
                    && seerrKey && seerrKey.value.trim()
                    && testJellyseerrBtn && !testJellyseerrBtn.disabled) {
                    testJellyseerrBtn.click();
                    tested++;
                }

                // Sonarr / Radarr — per-instance tests. The per-instance test
                // function itself guards against empty URL/API-key, so we
                // don't need to re-check here; we just skip already-disabled
                // buttons (mid-flight tests).
                var arrBtns = document.querySelectorAll('.arr-instance-test');
                arrBtns.forEach(function(btn) {
                    var card = btn.closest('.arr-instance-card');
                    if (!card) return;
                    var urlEl = card.querySelector('.arr-instance-url');
                    var keyEl = card.querySelector('.arr-instance-apikey');
                    if (!urlEl || !keyEl) return;
                    if (!urlEl.value.trim() || !keyEl.value.trim()) return;
                    if (btn.disabled) return;
                    btn.click();
                    tested++;
                });

                // Always refresh the dashboard dots so the user sees feedback
                // even when no service was re-tested.
                try { updateStatusDashboard(); } catch (e) { /* logged inside */ }

                if (tested === 0) {
                    _jeSuppressTestAlerts = false;
                    retestAllConnectionsBtn.disabled = false;
                    _setRetestAllButtonLabel(retestAllConnectionsBtn, _retestAllOriginalLabel);
                    _jeRetestAllCooldownUntil = 0; // reset cooldown — nothing fired
                    try {
                        Dashboard.alert({
                            title: 'Nothing to re-test',
                            message: 'Enable and configure at least one service (TMDB, Seerr, Sonarr, or Radarr) before running a re-test.'
                        });
                    } catch (e) { /* ignore */ }
                    return;
                }

                // The individual test functions don't return promises
                // (they're event handlers fired via .click()), so we poll
                // the DOM for the "in-flight" signal each test sets on
                // start: the `.status-check` class on its status indicator.
                // When no indicators still carry that class, every test
                // has resolved — release the button immediately. Falls
                // back to a hard max-wait so a hung request doesn't leave
                // the button stuck on "Retesting…".
                clearTimeout(_jeRetestAllReenableTimer);
                clearInterval(_jeRetestAllPollTimer);
                var batchStartedAt = Date.now();
                function releaseRetestBatch() {
                    clearInterval(_jeRetestAllPollTimer);
                    clearTimeout(_jeRetestAllReenableTimer);
                    _jeSuppressTestAlerts = false;
                    retestAllConnectionsBtn.disabled = false;
                    _setRetestAllButtonLabel(retestAllConnectionsBtn, _retestAllOriginalLabel);
                    try { renderChecklist(); } catch (e) { /* logged */ }
                }
                _jeRetestAllPollTimer = setInterval(function() {
                    var elapsed = Date.now() - batchStartedAt;
                    // `.status-check` is applied on test START and removed on
                    // test RESOLVE (success or failure), so it's an accurate
                    // "in-flight" signal for the three test functions.
                    var inFlight = document.querySelectorAll('.status-check').length;
                    // Release when BOTH:
                    //  - no tests still in flight (UI has caught up), and
                    //  - the min-cooldown floor has elapsed (rate limit).
                    // The floor ensures a user who hits retest-all with zero
                    // real tests configured still has the button disabled long
                    // enough to prevent double-run, and covers the first-tick
                    // race where indicators haven't swapped to 'sync' yet.
                    if (inFlight === 0 && elapsed >= RETEST_ALL_MIN_COOLDOWN_MS) {
                        releaseRetestBatch();
                    } else if (elapsed >= RETEST_ALL_MAX_WAIT_MS) {
                        console.warn('[JE] retest-all: giving up on ' + inFlight + ' in-flight test(s) after ' + elapsed + 'ms');
                        releaseRetestBatch();
                    }
                }, 300);
                // Hard-stop safety net in case setInterval is suspended
                // (backgrounded tab, browser throttling, etc.).
                _jeRetestAllReenableTimer = setTimeout(releaseRetestBatch, RETEST_ALL_MAX_WAIT_MS + 500);
            });
        }

        /**
         * Quick Action: proxy the "Clear client tag caches" button from the
         * Display tab. Keeps the canonical clear-flow in one place while
         * giving the action a home on Overview.
         */
        var clearTagCachesQuickBtn = document.getElementById('clearTagCachesQuickBtn');
        if (clearTagCachesQuickBtn && clearTagsCacheBtn) {
            clearTagCachesQuickBtn.addEventListener('click', function() {
                clearTagsCacheBtn.click();
            });
        }

        /**
         * Syncs the "Clear all client tag caches" quick-action button visibility
         * with the server-mode toggle — it's only relevant when server-side cache
         * is disabled.
         */
        function updateClearTagCachesQuickBtnVisibility() {
            var serverModeCheckbox = document.getElementById('tagCacheServerMode');
            if (!clearTagCachesQuickBtn || !serverModeCheckbox) return;
            clearTagCachesQuickBtn.style.display = serverModeCheckbox.checked ? 'none' : '';
        }

        /**
         * Updates the blocked users count badge in the collapsible summary.
         */
        function updateBlockedUsersCount() {
            const total = document.querySelectorAll('.blockedUserCheckbox:checked').length;
            const countEl = document.getElementById('blockedUsersCount');
            if (countEl) {
                countEl.textContent = total > 0 ? '(' + total + ' blocked)' : '(none)';
            }
        }

        /**
         * Loads all Jellyfin users and renders a checkbox list for the blocklist.
         * Pre-checks users whose IDs appear in the saved blocklist config.
         * @param {string} blockedIdsString - Comma-separated dashless user IDs to pre-select.
         */
        // Tracks whether the most recent loadBlockedUsersList successfully rendered
        // checkboxes. If /Users API fails, syncBlockedUsersToHiddenInput must not
        // run — otherwise it would wipe the entire blocklist on save.
        let _blockedUsersLoaded = false;

        async function loadBlockedUsersList(blockedIdsString) {
            const container = document.getElementById('blockedUsersContainer');
            const blockedSet = new Set(
                (blockedIdsString || '').split(/[,\r\n]+/).map(id => id.trim().replace(/-/g, '').toLowerCase()).filter(Boolean)
            );

            _blockedUsersLoaded = false;
            try {
                const users = await ApiClient.getUsers();
                container.textContent = '';
                users.sort((a, b) => a.Name.localeCompare(b.Name));
                users.forEach(user => {
                    const normalizedId = user.Id.replace(/-/g, '').toLowerCase();
                    const div = document.createElement('div');
                    div.className = 'checkboxContainer';
                    div.style.marginBottom = '0.3em';

                    const label = document.createElement('label');
                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    checkbox.setAttribute('is', 'emby-checkbox');
                    checkbox.className = 'blockedUserCheckbox';
                    checkbox.dataset.userid = normalizedId;
                    checkbox.checked = blockedSet.has(normalizedId);
                    checkbox.addEventListener('change', updateBlockedUsersCount);

                    const span = document.createElement('span');
                    span.textContent = user.Name;

                    label.appendChild(checkbox);
                    label.appendChild(span);
                    div.appendChild(label);
                    container.appendChild(div);
                });
                updateBlockedUsersCount();
                _blockedUsersLoaded = true;

                // Show scroll hint if content overflows, hide it once user scrolls to bottom
                const scrollHint = document.getElementById('blockedUsersScrollHint');
                if (scrollHint) {
                    const updateHint = () => {
                        const atBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 4;
                        scrollHint.style.display = (container.scrollHeight > container.clientHeight && !atBottom) ? 'block' : 'none';
                    };
                    // Check after render
                    requestAnimationFrame(updateHint);
                    container.addEventListener('scroll', updateHint);
                }
            } catch (e) {
                container.textContent = 'Could not load users.';
                console.error('Failed to load users for blocklist:', e);
                _blockedUsersLoaded = false;
            }
        }

        /**
         * Syncs checked blocked-user checkboxes into the hidden input for config save.
         * Skipped if loadBlockedUsersList failed — otherwise we'd wipe the whole
         * blocklist on save.
         */
        function syncBlockedUsersToHiddenInput() {
            if (!_blockedUsersLoaded) {
                console.warn('Jellyfin Enhanced: skipping blocklist sync — user list failed to load. Existing config preserved.');
                return;
            }
            const checkboxes = document.querySelectorAll('.blockedUserCheckbox:checked');
            const ids = Array.from(checkboxes).map(cb => cb.dataset.userid);
            document.querySelector('#jellyseerrImportBlockedUsers').value = ids.join(',');
        }

        document.getElementById('btnImportJellyseerrUsers').addEventListener('click', async () => {
            const btn = document.getElementById('btnImportJellyseerrUsers');
            const resultDiv = document.getElementById('importUsersResult');
            btn.disabled = true;
            btn.textContent = 'Saving config...';
            resultDiv.style.display = 'none';

            try {
                // Save config first so the server uses the current blocklist
                await saveConfig(new Event('submit'));
            } catch (e) {
                resultDiv.style.display = 'block';
                resultDiv.textContent = 'Could not save config. Import was not attempted.';
                resultDiv.style.color = '#f44336';
                console.error('Config save failed before import:', e);
                btn.disabled = false;
                btn.textContent = 'Import Users Now';
                return;
            }

            try {
                btn.textContent = 'Importing...';
                const response = await ApiClient.fetch({
                    url: ApiClient.getUrl('JellyfinEnhanced/jellyseerr/import-users'),
                    type: 'POST',
                    dataType: 'json'
                });

                // Handle different response shapes defensively (object, wrapped object, or JSON string)
                let payload = response;
                if (typeof payload === 'string') {
                    try {
                        payload = JSON.parse(payload);
                    } catch (_) {
                        payload = {};
                    }
                }
                if (payload && payload.data && typeof payload.data === 'object') {
                    payload = payload.data;
                }

                const usersImported = Number(payload && payload.usersImported);
                const totalUsers = Number(payload && payload.totalUsers);
                const importedCount = Number.isFinite(usersImported) ? usersImported : 0;
                const totalCount = Number.isFinite(totalUsers) ? totalUsers : 0;
                const errors = Array.isArray(payload && payload.errors) ? payload.errors : [];

                resultDiv.style.display = 'block';
                // surface backend errors[] so the admin sees WHY
                // partial imports failed (email collision, 401, etc.) instead
                // of a flat "Imported 0 new users" with no diagnosis.
                while (resultDiv.firstChild) resultDiv.removeChild(resultDiv.firstChild);
                const summary = document.createElement('div');
                summary.textContent = 'Imported ' + importedCount + ' new user(s) out of ' + totalCount + ' total.';
                summary.style.color = errors.length > 0 ? '#ff9800' : '#4caf50';
                resultDiv.appendChild(summary);
                if (errors.length > 0) {
                    const list = document.createElement('ul');
                    list.style.marginTop = '6px';
                    list.style.color = '#f44336';
                    list.style.fontSize = '0.9em';
                    for (const err of errors) {
                        const li = document.createElement('li');
                        li.textContent = String(err);
                        list.appendChild(li);
                    }
                    resultDiv.appendChild(list);
                }
            } catch (e) {
                resultDiv.style.display = 'block';
                while (resultDiv.firstChild) resultDiv.removeChild(resultDiv.firstChild);
                const msg = document.createElement('div');
                msg.textContent = 'Import failed. Check Seerr configuration and API key permissions.';
                msg.style.color = '#f44336';
                resultDiv.appendChild(msg);
                // Show response.errors[] when the server returned 502 with structured errors.
                const detailErrors = e && e.responseJSON && Array.isArray(e.responseJSON.errors) ? e.responseJSON.errors : [];
                if (detailErrors.length > 0) {
                    const list = document.createElement('ul');
                    list.style.marginTop = '6px';
                    list.style.color = '#f44336';
                    list.style.fontSize = '0.9em';
                    for (const err of detailErrors) {
                        const li = document.createElement('li');
                        li.textContent = String(err);
                        list.appendChild(li);
                    }
                    resultDiv.appendChild(list);
                }
                console.error('User import failed:', e);
            } finally {
                btn.disabled = false;
                btn.textContent = 'Import Users Now';
            }
        });

        // Permission Audit — admin scans every Jellyfin user for missing Seerr
        // permissions required by the features the admin has currently enabled.
        // GETs /JellyfinEnhanced/jellyseerr/permission-audit which returns
        // [{ jellyfinUsername, linked, issues:[...] }]. We render a summary
        // line + a table of users with gaps (warnings/unlinked first, then
        // a collapsed "OK" group). Errors surface inline in the result div
        // and are also logged to console.error so the admin can debug.
        (function wirePermissionAudit() {
            var btn = document.getElementById('btnPermissionAudit');
            if (!btn) return;
            // Resilient label setter (mirrors the validate-mapping fix): some
            // emby-button markup wraps text in a <span>, some places it bare.
            function setBtnLabel(text) {
                var span = btn.querySelector('span');
                if (span) span.textContent = text;
                else btn.textContent = text;
            }
            btn.addEventListener('click', async function() {
                var resultDiv = document.getElementById('permissionAuditResult');
                btn.disabled = true;
                setBtnLabel('Running…');
                resultDiv.style.display = 'none';
                resultDiv.innerHTML = '';
                try {
                    var data = await ApiClient.ajax({
                        type: 'GET',
                        url: ApiClient.getUrl('/JellyfinEnhanced/jellyseerr/permission-audit'),
                        dataType: 'json'
                    });
                    var withIssues = data.filter(function(u) { return u.linked && u.issues && u.issues.length > 0; });
                    var ok         = data.filter(function(u) { return u.linked && (!u.issues || u.issues.length === 0); });
                    var unlinked   = data.filter(function(u) { return !u.linked; });

                    // Summary panel with a title line and chip-based counts
                    var summaryEl = document.createElement('div');
                    summaryEl.className = 'je-audit-summary';
                    var summaryTitle = document.createElement('div');
                    summaryTitle.className = 'je-audit-summary-title';
                    if (withIssues.length === 0 && unlinked.length === 0) {
                        summaryTitle.textContent = '✅ All ' + ok.length + ' linked user(s) have the required permissions.';
                        summaryEl.appendChild(summaryTitle);
                    } else {
                        summaryTitle.textContent = 'Audit complete, review the users below.';
                        summaryEl.appendChild(summaryTitle);
                        var chips = document.createElement('div');
                        chips.className = 'je-audit-summary-chips';
                        function chip(kind, icon, count, label) {
                            if (!count) return;
                            var c = document.createElement('span');
                            c.className = 'je-audit-chip je-audit-chip-' + kind;
                            var i = document.createElement('i');
                            i.className = 'material-icons';
                            i.setAttribute('aria-hidden', 'true');
                            i.textContent = icon;
                            c.appendChild(i);
                            c.appendChild(document.createTextNode(count + ' ' + label));
                            chips.appendChild(c);
                        }
                        chip('warn',     'warning',        withIssues.length, withIssues.length === 1 ? 'with gaps' : 'with gaps');
                        chip('unlinked', 'link_off',       unlinked.length,   'not linked');
                        chip('ok',       'check_circle',   ok.length,         'OK');
                        summaryEl.appendChild(chips);
                    }
                    resultDiv.appendChild(summaryEl);

                    // Build one card per user with issues or unlinked status
                    if (withIssues.length > 0 || unlinked.length > 0) {
                        var cards = document.createElement('div');
                        cards.className = 'je-audit-cards';
                        function buildCard(u) {
                            var card = document.createElement('div');
                            card.className = 'je-audit-card ' + (u.linked ? 'je-audit-card-warn' : 'je-audit-card-unlinked');
                            var header = document.createElement('div');
                            header.className = 'je-audit-card-header';
                            var userEl = document.createElement('span');
                            userEl.className = 'je-audit-card-user';
                            var userIcon = document.createElement('i');
                            userIcon.className = 'material-icons';
                            userIcon.setAttribute('aria-hidden', 'true');
                            userIcon.textContent = u.linked ? 'person' : 'person_off';
                            userEl.appendChild(userIcon);
                            userEl.appendChild(document.createTextNode(u.jellyfinUsername));
                            header.appendChild(userEl);
                            var statusChip = document.createElement('span');
                            statusChip.className = 'je-audit-chip ' + (u.linked ? 'je-audit-chip-warn' : 'je-audit-chip-unlinked');
                            var statusIcon = document.createElement('i');
                            statusIcon.className = 'material-icons';
                            statusIcon.setAttribute('aria-hidden', 'true');
                            statusIcon.textContent = u.linked ? 'warning' : 'link_off';
                            statusChip.appendChild(statusIcon);
                            statusChip.appendChild(document.createTextNode(u.linked ? 'Permissions Missing' : 'Not linked'));
                            header.appendChild(statusChip);
                            card.appendChild(header);
                            if (u.issues && u.issues.length > 0) {
                                var ul = document.createElement('ul');
                                ul.className = 'je-audit-card-issues';
                                u.issues.forEach(function(issue) {
                                    var li = document.createElement('li');
                                    li.textContent = issue;
                                    ul.appendChild(li);
                                });
                                card.appendChild(ul);
                            }
                            return card;
                        }
                        withIssues.forEach(function(u) { cards.appendChild(buildCard(u)); });
                        unlinked.forEach(function(u) { cards.appendChild(buildCard(u)); });
                        resultDiv.appendChild(cards);
                    }

                    // Collapsed list of OK users rendered as name pills so many names
                    // wrap naturally instead of pushing the table layout wide
                    if (ok.length > 0 && (withIssues.length > 0 || unlinked.length > 0)) {
                        var details = document.createElement('details');
                        details.className = 'je-audit-ok-section';
                        var summary = document.createElement('summary');
                        summary.textContent = 'Show ' + ok.length + ' user(s) with no issues';
                        details.appendChild(summary);
                        var nameList = document.createElement('ul');
                        nameList.className = 'je-audit-ok-names';
                        ok.forEach(function(u) {
                            var li = document.createElement('li');
                            li.textContent = u.jellyfinUsername;
                            nameList.appendChild(li);
                        });
                        details.appendChild(nameList);
                        resultDiv.appendChild(details);
                    }
                    resultDiv.style.display = 'block';
                } catch (err) {
                    // Build the error node with createElement + textContent so any
                    // server-supplied message can't smuggle HTML into the page.
                    var errEl = document.createElement('div');
                    errEl.className = 'je-audit-error';
                    errEl.textContent = 'Audit failed: ' + ((err && err.message) || 'Check server logs.');
                    resultDiv.appendChild(errEl);
                    resultDiv.style.display = 'block';
                    console.error('[JE] Permission ', err);
                } finally {
                    btn.disabled = false;
                    setBtnLabel('Run Audit');
                }
            });
        })();

        // Shortcuts Panel & Toast timing previews — lets admins see how long
        // their chosen durations feel without leaving the settings page. Both
        // previews read the CURRENT (unsaved) input value so you can tweak the
        // number, click preview, and immediately see the result.
        //   - Shortcuts panel preview: full-screen overlay with a live countdown
        //     that self-dismisses at the configured delay (Esc / click-outside /
        //     Close-now also dismiss).
        //   - Toast preview: replicates the in-app toast styling at bottom-center
        //     and fades out at the configured duration.
        (function wireTimingPreviews() {
            var panelBtn = document.getElementById('jeTestShortcutsPanel');
            var toastBtn = document.getElementById('jeTestToast');
            var panelInput = document.getElementById('HelpPanelAutocloseDelay');
            var toastInput = document.getElementById('ToastDuration');

            // Clamp to a sane window: at least 200 ms (anything shorter is a flash
            // that the user can't see), at most 120 s (prevents stuck overlays
            // from fat-fingered values). Fallback if the field is blank/invalid.
            function readMs(input, fallback) {
                var raw = parseInt(input && input.value, 10);
                if (!Number.isFinite(raw) || raw < 200) return fallback;
                return Math.min(raw, 120000);
            }

            function fmtSeconds(ms) {
                return (ms / 1000).toFixed(1) + 's';
            }

            // Active-preview cleanup tracking — otherwise repeated clicks leak
            // setIntervals, setTimeouts, and document-level keydown listeners
            // because simply removing the prior overlay's DOM node never calls
            // its enclosing cleanup() closure.
            var _activePanelPreviewCleanup = null;

            if (panelBtn && panelInput && !panelBtn.dataset.jeWired) {
                panelBtn.dataset.jeWired = '1';
                panelBtn.addEventListener('click', function() {
                    // Dismiss any previous preview FULLY — cleanup clears the
                    // interval/timeout/keydown handler in addition to removing
                    // the DOM node.
                    if (_activePanelPreviewCleanup) _activePanelPreviewCleanup();

                    var ms = readMs(panelInput, 15000);
                    var overlay = document.createElement('div');
                    overlay.className = 'je-preview-panel-overlay';

                    var card = document.createElement('div');
                    card.className = 'je-preview-panel-card';

                    var title = document.createElement('div');
                    title.className = 'je-preview-panel-title';
                    title.innerHTML = '<i class="material-icons" aria-hidden="true">keyboard</i>Shortcuts Panel preview';
                    card.appendChild(title);

                    var body = document.createElement('div');
                    body.className = 'je-preview-panel-body';
                    var countdown = document.createElement('span');
                    countdown.className = 'je-preview-panel-countdown';
                    countdown.textContent = fmtSeconds(ms);
                    body.appendChild(document.createTextNode('This is how long the real shortcuts/settings panel (opened with the '));
                    var kbd = document.createElement('kbd');
                    kbd.textContent = '?';
                    body.appendChild(kbd);
                    body.appendChild(document.createTextNode(' key in the main Jellyfin UI) will stay open without interaction. Auto-closes in '));
                    body.appendChild(countdown);
                    body.appendChild(document.createTextNode('.'));
                    card.appendChild(body);

                    var actions = document.createElement('div');
                    actions.className = 'je-preview-panel-actions';
                    var closeBtn = document.createElement('button');
                    closeBtn.type = 'button';
                    closeBtn.className = 'emby-button raised raised-mini';
                    closeBtn.textContent = 'Close now';
                    actions.appendChild(closeBtn);
                    card.appendChild(actions);

                    // Minimal dialog-style a11y: screen readers announce as dialog,
                    // title serves as accessible name, closeBtn gets initial focus.
                    overlay.setAttribute('role', 'dialog');
                    overlay.setAttribute('aria-modal', 'true');
                    title.id = 'je-preview-panel-title';
                    overlay.setAttribute('aria-labelledby', 'je-preview-panel-title');
                    overlay.appendChild(card);
                    document.body.appendChild(overlay);
                    try { closeBtn.focus(); } catch (e) { /* focus may fail in rare host conditions */ }

                    var startTs = Date.now();
                    var isActive = true;
                    var intervalId = setInterval(function() {
                        if (!isActive) return;
                        var remaining = Math.max(0, ms - (Date.now() - startTs));
                        countdown.textContent = fmtSeconds(remaining);
                        if (remaining <= 0) cleanup();
                    }, 100);
                    var timeoutId = setTimeout(cleanup, ms);

                    function cleanup() {
                        if (!isActive) return;
                        isActive = false;
                        clearInterval(intervalId);
                        clearTimeout(timeoutId);
                        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
                        document.removeEventListener('keydown', onKey);
                        if (_activePanelPreviewCleanup === cleanup) _activePanelPreviewCleanup = null;
                    }
                    function onKey(e) {
                        if (e.key === 'Escape') {
                            e.stopPropagation();
                            cleanup();
                        }
                    }
                    closeBtn.addEventListener('click', cleanup);
                    overlay.addEventListener('click', function(e) {
                        if (e.target === overlay) cleanup();
                    });
                    document.addEventListener('keydown', onKey);
                    _activePanelPreviewCleanup = cleanup;
                });
            }

            if (toastBtn && toastInput && !toastBtn.dataset.jeWired) {
                toastBtn.dataset.jeWired = '1';
                toastBtn.addEventListener('click', function() {
                    // Clear any prior preview toasts AND their still-pending timers
                    // (otherwise rapid-fire clicks leave detached toasts with pending
                    // slide-in/out/remove setTimeouts that would fire against removed
                    // DOM — harmless but wasteful).
                    document.querySelectorAll('.je-preview-toast').forEach(function(el) {
                        if (el._jeShowTimer)   clearTimeout(el._jeShowTimer);
                        if (el._jeHideTimer)   clearTimeout(el._jeHideTimer);
                        if (el._jeRemoveTimer) clearTimeout(el._jeRemoveTimer);
                        el.remove();
                    });
                    var ms = readMs(toastInput, 3000);
                    var toast = document.createElement('div');
                    toast.className = 'je-preview-toast';
                    toast.setAttribute('role', 'status');
                    toast.setAttribute('aria-live', 'polite');
                    toast.textContent = 'Example toast, disappears in ' + fmtSeconds(ms);
                    document.body.appendChild(toast);
                    // Mirror real JE.toast(): slide in from the right after a tick,
                    // stay for `ms`, then slide back out by removing the .je-shown class.
                    toast._jeShowTimer = setTimeout(function() { toast.classList.add('je-shown'); }, 10);
                    toast._jeHideTimer = setTimeout(function() {
                        toast.classList.remove('je-shown');
                        toast._jeRemoveTimer = setTimeout(function() {
                            if (toast && toast.parentNode) toast.parentNode.removeChild(toast);
                        }, 350);
                    }, ms);
                });
            }
        })();

        // Collapsible info banners
        //
        // When the "Descriptions" toggle is off, every inline info banner is
        // folded into a small (i) icon next to its anchor (fieldset legend, or
        // the parent container of the checkbox the banner describes). Clicking
        // the icon toggles the banner(s) open in place; clicking outside closes
        // them. Multiple banners sharing an anchor toggle together under a
        // single icon.
        //
        // Anchor detection:
        //  - Banner inside a <div class="je-setting-description" data-desc-for="id">
        //    → anchor is the nearest .checkboxContainer / .inputContainer that
        //      contains the input with that id. We attach to the container (as a
        //      sibling of the <label>) so clicking the trigger can't forward to
        //      the checkbox via the label's click behavior.
        //  - Otherwise → anchor is the nearest <legend class="sectionTitle">
        //    inside the same <fieldset>.
        //
        // All banners matching are marked .je-banner-managed; the CSS in
        // configPage.css handles visibility keyed off body.je-hide-descriptions
        // and the .je-banner-open toggle.
        // Tracks every wired banner group so we can re-sync the parent-
        // checkbox gating (see below) when loadConfig runs AFTER wiring.
        var _jeBannerGroups = [];

        /**
         * Re-syncs every gated banner group's parent-off state. Called from
         * updateAllDependencies so programmatic `checkbox.checked = x` applied
         * during loadConfig picks up correctly (a direct assignment doesn't
         * fire the 'change' event we listen to otherwise).
         */
        function syncAllBannerParents() {
            _jeBannerGroups.forEach(function(group) {
                if (!group.parentCheckbox) return;
                _jeSyncBannerParent(group);
            });
        }

        function _jeSyncBannerParent(group) {
            var off = !group.parentCheckbox.checked;
            group.banners.forEach(function(b) {
                b.classList.toggle('je-banner-parent-off', off);
                if (off) b.classList.remove('je-banner-open');
            });
            group.trigger.classList.toggle('je-banner-parent-off', off);
            if (off) group.trigger.setAttribute('aria-expanded', 'false');
        }

        (function wireCollapsibleBanners() {
            var banners = document.querySelectorAll('.je-info-banner-inline, .je-info-banner-inline-center');
            if (!banners.length) return;

            function findAnchor(banner) {
                // Explicit overrides on the banner itself:
                //   data-banner-anchor="legend"       → force fieldset legend
                //   data-banner-anchor="#elementId"   → force arbitrary element
                // Used for banners that live inside one setting's description
                // wrapper but are semantically about the whole fieldset (e.g.
                // "How to Use Bookmarks:" under bookmarksUseCustomTabs).
                var override = banner.getAttribute('data-banner-anchor');
                if (override === 'legend') {
                    var fsOverride = banner.closest('fieldset');
                    if (fsOverride) {
                        var legendOverride = fsOverride.querySelector('legend.sectionTitle');
                        if (legendOverride) return legendOverride;
                    }
                } else if (override && override.charAt(0) === '#') {
                    var el = document.querySelector(override);
                    if (el) return el;
                }

                var descWrapper = banner.closest('.je-setting-description[data-desc-for]');
                if (descWrapper) {
                    var targetId = descWrapper.getAttribute('data-desc-for');
                    var target = document.getElementById(targetId);
                    if (target) {
                        var container = target.closest('.checkboxContainer, .inputContainer');
                        if (container) return container;
                    }
                }
                var fieldset = banner.closest('fieldset');
                if (fieldset) {
                    var legend = fieldset.querySelector('legend.sectionTitle');
                    if (legend) return legend;
                }
                return null;
            }

            // Find the parent checkbox whose "checked" state gates this banner
            // (auto-detect via nearest .je-setting-description[data-desc-for="X"]
            // where #X is a checkbox). Explicit opt-out: data-banner-no-gate="true"
            // on the banner disables the gating for that specific banner.
            function findParentCheckbox(banner) {
                if (banner.getAttribute('data-banner-no-gate') === 'true') return null;
                var descWrapper = banner.closest('.je-setting-description[data-desc-for]');
                if (!descWrapper) return null;
                var targetId = descWrapper.getAttribute('data-desc-for');
                var target = document.getElementById(targetId);
                if (target && target.type === 'checkbox') return target;
                return null;
            }

            // Group banners by anchor; also capture the shared parent checkbox
            // (we assume all banners under one anchor share the same gate —
            // currently true because they live in the same .je-setting-description).
            var anchorMap = new Map();
            banners.forEach(function(banner, idx) {
                banner.classList.add('je-banner-managed');
                if (!banner.id) banner.id = 'je-banner-' + idx + '-' + Math.random().toString(36).slice(2, 8);
                var anchor = findAnchor(banner);
                if (!anchor) {
                    // Future contributors adding a banner outside a fieldset / outside
                    // any .je-setting-description[data-desc-for] will end up here —
                    // the banner gets `je-banner-managed` (so CSS hides it when
                    // descriptions-off) but no trigger icon. Without a log, the
                    // banner would just disappear when the admin toggles
                    // descriptions off with no way to get it back.
                    console.warn('[JE] banner has no anchor — collapse trigger will not be wired:', banner.id || banner);
                    return;
                }
                if (!anchorMap.has(anchor)) {
                    anchorMap.set(anchor, { banners: [], parentCheckbox: findParentCheckbox(banner) });
                }
                anchorMap.get(anchor).banners.push(banner);
            });

            anchorMap.forEach(function(data, anchor) {
                if (anchor.dataset.jeBannerWired === '1') return;
                anchor.dataset.jeBannerWired = '1';

                var trigger = document.createElement('button');
                trigger.type = 'button';
                trigger.className = 'je-banner-trigger';
                trigger.setAttribute('aria-expanded', 'false');
                var labelText = data.banners.length > 1 ? 'Show ' + data.banners.length + ' info panels' : 'Show info';
                trigger.setAttribute('aria-label', labelText);
                trigger.title = labelText;
                var icon = document.createElement('i');
                icon.className = 'material-icons';
                icon.setAttribute('aria-hidden', 'true');
                icon.textContent = 'info';
                trigger.appendChild(icon);
                anchor.appendChild(trigger);

                var group = { banners: data.banners, trigger: trigger, parentCheckbox: data.parentCheckbox };
                _jeBannerGroups.push(group);

                trigger.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    var nextOpen = trigger.getAttribute('aria-expanded') !== 'true';
                    trigger.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
                    data.banners.forEach(function(b) {
                        b.classList.toggle('je-banner-open', nextOpen);
                    });
                });

                // Gate on the parent checkbox: when unchecked, hide banners
                // and surface the trigger icon (same UX as descriptions-off
                // mode). Initial sync runs here; syncAllBannerParents() is
                // also called from updateAllDependencies so loadConfig's
                // programmatic .checked assignments pick up correctly.
                if (data.parentCheckbox) {
                    _jeSyncBannerParent(group);
                    data.parentCheckbox.addEventListener('change', function() {
                        _jeSyncBannerParent(group);
                    });
                }
            });

            // Outside-click closes every open banner. Clicks inside an open
            // banner (e.g. code copy button, links) don't close it.
            document.addEventListener('click', function(e) {
                if (!e.target) return;
                if (e.target.closest('.je-banner-trigger, .je-banner-managed')) return;
                document.querySelectorAll('.je-banner-trigger[aria-expanded="true"]').forEach(function(t) {
                    t.setAttribute('aria-expanded', 'false');
                });
                document.querySelectorAll('.je-banner-managed.je-banner-open').forEach(function(b) {
                    b.classList.remove('je-banner-open');
                });
            });
        })();

        // Custom Plugin Links functionality
        const testCustomPluginLinksBtn = document.getElementById('testCustomPluginLinksBtn');
        const customPluginLinksTextarea = document.getElementById('customPluginLinks');

        if (testCustomPluginLinksBtn) {
            testCustomPluginLinksBtn.addEventListener('click', async () => {
                const linksText = customPluginLinksTextarea.value.trim();
                if (!linksText) {
                    Dashboard.alert({
                        title: 'No Links',
                        message: 'Please add some custom plugin links first.'
                    });
                    return;
                }

                // Parse and validate the links
                const lines = linksText.split('\n');
                const validLinks = [];
                const invalidLines = [];

                lines.forEach((line, index) => {
                    const trimmedLine = line.trim();
                    if (!trimmedLine) return;

                    const parts = trimmedLine.split('|').map(part => part.trim());
                    if (parts.length >= 2 && parts[0] && parts[1]) {
                        validLinks.push({ name: parts[0], icon: parts[1] });
                    } else {
                        invalidLines.push(`Line ${index + 1}: "${trimmedLine}"`);
                    }
                });

                if (invalidLines.length > 0) {
                    Dashboard.alert({
                        title: 'Invalid Format',
                        message: `The following lines have invalid format:\n\n${invalidLines.join('\n')}\n\nPlease use the format: Configuration Page Name | icon_name`
                    });
                    return;
                }

                if (validLinks.length === 0) {
                    Dashboard.alert({
                        title: 'No Valid Links',
                        message: 'No valid plugin links found. Please check the format.'
                    });
                    return;
                }

                // Test the links by temporarily adding them to the sidebar
                // Trigger the plugin icons script to refresh with test data
                if (window.JellyfinEnhanced && window.JellyfinEnhanced.customPlugins) {
                    // Temporarily store test data
                    window.testCustomPluginLinks = validLinks;
                    window.JellyfinEnhanced.customPlugins.refresh();
                }
            });
        }

        // click handlers to all TMDB test buttons
        document.querySelectorAll('.testTmdbBtn').forEach(btn => {
            btn.addEventListener('click', testTmdbConnection);
        });

        // Shared date formatting for the whole config page, explicit instead
        // of toLocaleString()/toLocaleDateString() so display doesn't vary by
        // the admin's browser locale. Function declarations hoist through this
        // file's single top-level IIFE, so these are callable from anywhere in
        // it regardless of where they're defined relative to the call site.
        var JE_DATE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

        /** Formats a Date as "DD-MMM-YYYY" (e.g. "28-Aug-2026"). */
        function formatDateDMY(d) {
            var day = String(d.getDate()).padStart(2, '0');
            var month = JE_DATE_MONTHS[d.getMonth()];
            return day + '-' + month + '-' + d.getFullYear();
        }

        /** Formats a Date as "DD-MMM-YYYY, HH:MM AM/PM" (e.g. "28-Aug-2026, 12:02 AM"). */
        function formatDateTimeDMY(d) {
            var hours24 = d.getHours();
            var ampm = hours24 >= 12 ? 'PM' : 'AM';
            var hours12 = hours24 % 12 || 12;
            var minutes = String(d.getMinutes()).padStart(2, '0');
            return formatDateDMY(d) + ', ' + hours12 + ':' + minutes + ' ' + ampm;
        }

        /**
         * Fetches and displays live MDBList account/quota status. Tests
         * whatever's currently typed in the API key field (even if unsaved),
         * mirroring testTmdbConnection -- lets the admin verify a key before
         * hitting Save. Falls back to the saved key if the field is empty.
         */
        async function checkMdblistStatus() {
            const statusLine = document.getElementById('mdblistStatusLine');
            const statusIndicator = document.getElementById('mdblistStatusIndicator');
            const apiKey = (document.querySelector('#mdblistApiKey')?.value || '').trim();

            if (statusIndicator) {
                statusIndicator.textContent = 'sync';
                statusIndicator.classList.add('status-check');
                statusIndicator.style.color = 'var(--primary-accent-color, #00a4dc)';
            }
            if (statusLine) statusLine.textContent = 'Checking...';

            try {
                const url = ApiClient.getUrl('/JellyfinEnhanced/mdblist-ratings/account-status', apiKey ? { apiKey: apiKey } : {});
                const status = await ApiClient.ajax({ type: 'GET', url: url, dataType: 'json' });

                if (statusIndicator) {
                    statusIndicator.textContent = 'check_circle';
                    statusIndicator.style.color = '#52b54b';
                }
                if (statusLine) {
                    var remaining = (status && status.RateLimitRemaining != null) ? status.RateLimitRemaining : '?';
                    var limit = (status && status.RateLimit != null) ? status.RateLimit : '?';
                    var plan = (status && status.Plan) ? status.Plan : 'Free';
                    var resetSeconds = (status && status.RateLimitResetUnixSeconds) ? status.RateLimitResetUnixSeconds : 0;
                    var resetDate = new Date(resetSeconds * 1000);
                    var resetText = (isFinite(resetDate.getTime()) && resetSeconds > 0) ? formatDateTimeDMY(resetDate) : 'unknown';
                    statusLine.textContent = remaining + ' / ' + limit + ' requests remaining today (' + plan + ' plan) · resets ' + resetText;
                }
            } catch (e) {
                if (statusIndicator) {
                    statusIndicator.textContent = 'error';
                    statusIndicator.style.color = '#dc3545';
                }
                if (statusLine) {
                    statusLine.textContent = (e && e.status === 503)
                        ? 'Enter an API key to check status.'
                        : (e && e.status === 502)
                            ? 'Could not reach MDBList - key may be invalid.'
                            : 'Could not check MDBList account status.';
                }
            } finally {
                if (statusIndicator) statusIndicator.classList.remove('status-check');
            }
        }

        document.getElementById('checkMdblistStatusBtn')?.addEventListener('click', checkMdblistStatus);

        // Copy button handler for HTML code snippets
        document.querySelectorAll('.je-copy-html-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();

                const htmlCode = this.getAttribute('data-copy-text');
                const btnText = this.querySelector('.copy-btn-text');

                // Try clipboard API first
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(htmlCode).then(function() {
                        btnText.textContent = 'Copied!';
                        btn.style.color = '#4CAF50';
                        setTimeout(function() {
                            btnText.textContent = 'Copy';
                            btn.style.color = '';
                        }, 2000);
                    }).catch(function(err) {
                        console.error('Clipboard API failed: ', err);
                        fallbackCopy(htmlCode, btn, btnText);
                    });
                } else {
                    // Fallback for older browsers
                    fallbackCopy(htmlCode, btn, btnText);
                }
            });
        });

        // Fallback copy method
        function fallbackCopy(text, btn, btnText) {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            try {
                document.execCommand('copy');
                btnText.textContent = 'Copied!';
                btn.style.color = '#4CAF50';
                setTimeout(function() {
                    btnText.textContent = 'Copy';
                    btn.style.color = '';
                }, 2000);
            } catch (err) {
                console.error('Fallback copy failed: ', err);
                alert('Failed to copy to clipboard');
            }
            document.body.removeChild(textarea);
        }
    })();
