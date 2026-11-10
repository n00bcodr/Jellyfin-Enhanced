import type { PageModules } from './modules';
import { asHtml, closestTo, needHtml, plainLabel } from './dom';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type TabsDeps = Pick<PageModules, 'context' | 'mediaTagsTab'>;

export function createTabs(m: TabsDeps) {
    const { form, lifecycle, page } = m.context;

            const tabs = document.querySelectorAll<HTMLElement>('.jellyfin-tab-button');

            const tabContents = document.querySelectorAll<HTMLElement>('.jellyfin-tab-content');

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

            let _jePrevTabId: string | null = null;

            function _jeGetScrollTop() : number {
                return window.scrollY
                    || document.documentElement.scrollTop
                    || document.body.scrollTop
                    || 0;
            }

            function _jeSetScrollTop(y: number) : void {
                try { window.scrollTo({ top: y, behavior: 'instant' }); }
                catch (e) {
                    // Old Safari missing behavior:'instant' or iframe contexts.
                    window.scrollTo(0, y);
                }
            }

            function activateTab(tabId: string) : void {
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
                // The Media Tags tab draws itself the first time it opens, and reloads its settings when it opens again.
                if (page) page.classList.toggle('je-mt-active', tabId === m.mediaTagsTab.JE_MT_TAB);
                if (tabId === m.mediaTagsTab.JE_MT_TAB) m.mediaTagsTab.jeMountMediaTags();
                // Lazy-load the Docs iframe the first time the user opens
                // the Docs tab. Using `about:blank` as the initial src
                // prevents the GitHub Pages fetch for admins who never
                // click into it. We set the real src once and never
                // reset it, so subsequent tab switches re-reveal the
                // already-loaded page (keeps the admin's scroll position
                // and any in-page nav state).
                if (tabId === 'docs') {
                    try {
                        const frame = document.getElementById('docsFrame');
                        const f = frame instanceof HTMLIFrameElement ? frame : null;
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

            /** Scrolls a fieldset's top just below .je-sticky-header (sticky title/search/tab bar). */
            function jeScrollFieldsetIntoView(fieldset: HTMLElement) : void {
                const headerEl = asHtml(document.querySelector('.je-sticky-header'));
                const offset = (headerEl ? headerEl.offsetHeight : 0) + 12;
                const targetY = window.scrollY + fieldset.getBoundingClientRect().top - offset;
                window.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
            }

            /** Flash the rounded card wrapping a control, not the bare control itself. */
            function jeResolveFlashTarget(rawEl: HTMLElement | null) : HTMLElement | null {
                return (rawEl && rawEl.tagName !== 'FIELDSET')
                    ? (rawEl.closest('.checkboxContainer, .inputContainer, .selectContainer') || rawEl)
                    : rawEl;
            }

            function jeFlashElement(el: HTMLElement) : void {
                el.classList.add('je-jump-flash');
                setTimeout(() => el.classList.remove('je-jump-flash'), 3000);
            }

            /** Switches to tabId, scrolls to selector, and flashes it plus every element in extraSelectors. */
            function jeJumpToTab(tabId: string, selector?: string | null, extraSelectors?: readonly string[] | null) : void {
                const tabBtn = asHtml(document.querySelector('.jellyfin-tab-button[data-tab="' + tabId + '"]'));
                if (tabBtn) tabBtn.click();
                if (!selector) return;
                // Double rAF: lands after activateTab's own scroll-memory restore.
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        // Open any collapsed expander hiding a target so it can be scrolled to and flashed.
                        const openAncestors = (el: Element | null): void => {
                            for (let d = el && el.closest('details'); d; d = d.parentElement ? d.parentElement.closest('details') : null) d.open = true;
                        };
                        const rawTarget = asHtml(document.querySelector(selector));
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
                            const rawExtra = asHtml(document.querySelector(extraSelector));
                            openAncestors(rawExtra);
                            const extraTarget = jeResolveFlashTarget(rawExtra);
                            if (extraTarget && extraTarget !== target) jeFlashElement(extraTarget);
                        });
                    });
                });
            }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {
            // Drag-to-scroll on the tab bar so mouse users can pan the tab strip
            // the same way touch users do on mobile (the overflow-x auto strip
            // has no visible scrollbar). Threshold at 5 px before we consider it
            // a drag, so a normal click through to a tab still registers.
            (function wireTabBarDrag() {
                const bar = asHtml(document.querySelector('.je-tab-bar'));
                if (!bar) return;
                let isDown = false;
                let startX = 0;
                let startScroll = 0;
                let dragged = false;

                // Edge fade: signals there are more tabs to scroll to, since the strip's scrollbar is hidden.
                function updateScrollFade(): void {
                    if (!bar) return;
                    const maxScroll = bar.scrollWidth - bar.clientWidth;
                    bar.classList.toggle('je-scroll-fade-left', bar.scrollLeft > 1);
                    bar.classList.toggle('je-scroll-fade-right', bar.scrollLeft < maxScroll - 1);
                }
                bar.addEventListener('scroll', updateScrollFade, { passive: true });
                window.addEventListener('resize', updateScrollFade, { signal: lifecycle.signal });
                // First check in the next frame, before it paints: run here, in
                // the middle of jellyfin-web inserting the page, it forced a full
                // layout of the whole settings page (~0.5 s on first open) that
                // the page's first paint then does anyway.
                requestAnimationFrame(updateScrollFade);
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

            tabs.forEach(tab => {
                tab.addEventListener('click', () => {
                    const tabId = tab.dataset.tab ?? '';
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
                    const fieldsets = Array.from(tabContent.querySelectorAll<HTMLElement>(':scope > fieldset'))
                        .filter(fs => asHtml(fs.querySelector(':scope > legend.sectionTitle')));
                    if (fieldsets.length < MIN_SECTIONS) return;

                    const nav = document.createElement('div');
                    nav.className = 'je-section-nav';
                    fieldsets.forEach((fieldset, i) => {
                        const legend = needHtml(fieldset.querySelector(':scope > legend.sectionTitle'));
                        const label = plainLabel(legend);
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
                    const intro = asHtml(tabContent.querySelector(':scope > .je-info-banner'));
                    if (intro) {
                        intro.insertAdjacentElement('afterend', nav);
                    } else {
                        tabContent.insertBefore(nav, tabContent.firstChild);
                    }
                });
            })();

            // Cross-tab "jump to X" links inside banners, delegated so future ones need no extra wiring.
            form.addEventListener('click', (e) => {
                const link = closestTo(e, '.je-jump-link');
                if (!link) return;
                e.preventDefault();
                jeJumpToTab(link.dataset.jumpTab ?? '', link.dataset.jumpTarget);
            });
    }

    return {
        wire,
        activateTab,
        jeJumpToTab,
        tabContents,
        tabs,
    };
}
