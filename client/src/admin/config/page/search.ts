import type { PageModules } from './modules';
import { asHtml, needControl, needHtml, needInput, plainLabel } from './dom';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type SearchDeps = Pick<PageModules, 'context' | 'links' | 'tabs'>;

export function createSearch(m: SearchDeps) {
    const { form } = m.context;

            // === Settings Search ===
            const searchInput = needInput(document.getElementById('settingsSearchInput'));

            const searchClear = needHtml(document.getElementById('settingsSearchClear'));

            const searchCount = needHtml(document.getElementById('settingsSearchCount'));

            const tabButtonsContainer = m.tabs.tabs[0] ? m.tabs.tabs[0].parentElement : null;

            let isSearchMode = false;

            const savedDetailsStates = new Map<HTMLDetailsElement, boolean>();

            const SKIP_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'SCRIPT', 'STYLE']);

            let currentMatchIdx = -1;

            let allMatches: HTMLElement[] = [];

            let searchDebounce: ReturnType<typeof setTimeout> | undefined;

            /**
             * Collects searchable text from an element, including IDs, names, and data attributes.
             * @param {HTMLElement} element - The DOM element to extract text from
             * @returns {string} Lowercase concatenation of text content and attribute values
             */
            function getSearchableText(element: Element) : string {
                var text = element.textContent.toLowerCase();
                element.querySelectorAll<HTMLElement>('[id], [name], [data-text], [data-icon]').forEach(function(el) {
                    if (el.id) text += ' ' + el.id.toLowerCase();
                    const name = el.getAttribute('name');
                if (name) text += ' ' + name.toLowerCase();
                    if (el.dataset.text) text += ' ' + el.dataset.text.toLowerCase();
                    if (el.dataset.icon) text += ' ' + el.dataset.icon.toLowerCase();
                });
                return text;
            }

            /**
             * Removes all search highlight marks and restores original text nodes.
             */
            function clearHighlights() : void {
                form.querySelectorAll<HTMLElement>('.je-search-match').forEach(mark => {
                    const parent = mark.parentNode;
                    if (!parent) return;
                    parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
                    parent.normalize();
                });
                // Unwrap the flex/grid protection spans added by
                // highlightTextIn. After the marks above were unwrapped,
                // the wrapper contains only text nodes — move them up to
                // the parent and drop the wrapper, so normalize() can
                // merge back into a single text node identical to before
                // the search.
                form.querySelectorAll<HTMLElement>('.je-search-wrap').forEach(wrap => {
                    const parent = wrap.parentNode;
                    if (!parent) return;
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
            function highlightTextIn(element: Element, query: string) : void {
                const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
                    acceptNode: function(node) {
                        const owner = node.parentElement;
                        if (!owner || SKIP_TAGS.has(owner.tagName)) return NodeFilter.FILTER_REJECT;
                        if (owner.closest('.je-search-match, .je-search-tab-label, .dep-hint-text, .dep-required-icon, .je-dep-banner, [class*="parent-hint-"]'))
                            return NodeFilter.FILTER_REJECT;
                        return NodeFilter.FILTER_ACCEPT;
                    }
                });
                var textNodes: Node[] = [];
                while (walker.nextNode()) textNodes.push(walker.currentNode);

                // Per-parent display cache. getComputedStyle forces style
                // recomputation and — called naively once per text node during
                // a big search — caused the settings search to feel
                // extremely laggy on every keystroke. Most matches in a
                // fieldset share a parent (e.g., all text nodes inside one
                // .fieldDescription), so a WeakMap keyed on the parent
                // element cuts the call count to one per distinct parent.
                var parentDisplayCache = new WeakMap<Element, boolean>();
                function isFlexOrGridParent(parent: Element): boolean {
                    const cached = parentDisplayCache.get(parent);
                if (cached !== undefined) return cached;
                    var d = getComputedStyle(parent).display;
                    var flex = /(flex|grid)$/.test(d);
                    parentDisplayCache.set(parent, flex);
                    return flex;
                }

                textNodes.forEach(function(node) {
                    var text = node.textContent ?? '';
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
                    if (!parent) return;
                if (frag.childNodes.length > 1 && parent instanceof Element && isFlexOrGridParent(parent)) {
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
            function goToMatch(index: number) : void {
                if (allMatches.length === 0) return;
                if (currentMatchIdx >= 0 && currentMatchIdx < allMatches.length) {
                    allMatches[currentMatchIdx]?.classList.remove('je-search-match-active');
                }
                if (index >= allMatches.length) index = 0;
                if (index < 0) index = allMatches.length - 1;
                currentMatchIdx = index;
                const match = allMatches[currentMatchIdx];
                match?.classList.add('je-search-match-active');
                match?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                searchCount.textContent = (currentMatchIdx + 1) + ' of ' + allMatches.length;
            }

            /**
             * Enters search mode: saves detail open/closed states, hides tab buttons, and adds tab labels.
             */
            function enterSearchMode() : void {
                if (isSearchMode) return;
                isSearchMode = true;
                form.classList.add('je-search-mode');
                form.querySelectorAll<HTMLDetailsElement>('details').forEach(d => {
                    savedDetailsStates.set(d, d.open);
                });
                if (tabButtonsContainer) tabButtonsContainer.style.display = 'none';
                m.tabs.tabContents.forEach(tc => {
                    const btn = asHtml(document.querySelector('.jellyfin-tab-button[data-tab="' + tc.id + '"]'));
                    // btn.textContent would include Material Icons font
                    // ligature names ("dashboard", "view_list", …) which
                    // render as glyphs but read as raw strings in
                    // textContent. That leaked into tab headers like
                    // "dashboardOverview" / "view_listPages". Clone the
                    // button, strip out the icon elements, then read.
                    let label = tc.id;
                    if (btn) {
                        label = plainLabel(btn) || tc.id;
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
            function exitSearchMode() : void {
                isSearchMode = false;
                form.classList.remove('je-search-mode');
                form.querySelectorAll<HTMLElement>('.je-tab-name-match').forEach(tc => tc.classList.remove('je-tab-name-match'));
                clearHighlights();
                // tabContents, not the form: the Media Tags tab sits after the form and gets a label and inline display too.
                m.tabs.tabContents.forEach(tc => tc.querySelectorAll<HTMLElement>(':scope > .je-search-tab-label').forEach(el => el.remove()));
                if (tabButtonsContainer) tabButtonsContainer.style.display = '';
                // Clear inline display from every tab content. performSearch sets
                // `style.display = 'block'|'none'` per tab; without this reset the
                // inline value wins over `.jellyfin-tab-content.active { display: grid }`,
                // collapsing matched tabs to single-column or hiding tabs that had no
                // match the next time the user clicks them. The .active class alone
                // owns visibility outside of search mode.
                m.tabs.tabContents.forEach(tc => { tc.style.display = ''; });
                form.querySelectorAll<HTMLElement>('.je-search-hidden').forEach(el => el.classList.remove('je-search-hidden'));
                form.querySelectorAll<HTMLDetailsElement>('details').forEach(d => {
                    const open = savedDetailsStates.get(d);
                if (open !== undefined) d.open = open;
                });
                savedDetailsStates.clear();
                let savedTab = 'overview';
                try {
                    savedTab = sessionStorage.getItem('jellyfinEnhancedActiveTab') || 'overview';
                    savedTab = m.links.LEGACY_TAB_MAP[savedTab] ?? savedTab;
                    if (!asHtml(document.getElementById(savedTab))) savedTab = 'overview';
                } catch (e) {
                    // Ignore if sessionStorage is not available
                }
                m.tabs.activateTab(savedTab);
                searchCount.style.display = 'none';
                searchClear.style.display = 'none';
            }

            /**
             * Filters visible sections by query, highlights matches, and updates the match counter.
             * @param {string} query - The search term entered by the user
             */
            function performSearch(query: string) : void {
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

                m.tabs.tabContents.forEach(tabContent => {
                    let tabHasMatch = false;
                    const fieldsets = tabContent.querySelectorAll<HTMLElement>(':scope > fieldset');

                    fieldsets.forEach(fieldset => {
                        const fullText = getSearchableText(fieldset);

                        if (!fullText.includes(query)) {
                            fieldset.classList.add('je-search-hidden');
                            return;
                        }

                        fieldset.classList.remove('je-search-hidden');
                        tabHasMatch = true;
                        sectionCount++;

                        const detailsEls = fieldset.querySelectorAll<HTMLDetailsElement>('details');
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
                    const btn = asHtml(document.querySelector('.jellyfin-tab-button[data-tab="' + tabContent.id + '"]'));
                    let tabLabel = tabContent.id.toLowerCase();
                    if (btn) {
                        tabLabel = plainLabel(btn).toLowerCase();
                    }
                    tabContent.classList.toggle('je-tab-name-match', tabHasMatch && tabLabel.includes(query));
                });

                allMatches = Array.from(form.querySelectorAll<HTMLElement>('.je-search-match'));
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

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {
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
    }

    return {
        wire,

    };
}
