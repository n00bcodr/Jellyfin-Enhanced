// /js/others/doesthedogdie.js
// Content warnings (DoesTheDogDie votes) on item-details pages, with a per-user trigger picker.
(function (JE) {
    'use strict';

    JE.initializeDoesTheDogDieScript = function () {
        if (!JE.pluginConfig?.DoesTheDogDieEnabled) {
            console.log('🪼 Jellyfin Enhanced: DoesTheDogDie feature disabled.');
            return;
        }

        const logPrefix = '🪼 Jellyfin Enhanced: DoesTheDogDie:';
        const SECTION_CLASS = 'je-ddd-section';
        // A topic counts as present when at least this share of votes say yes.
        // Wording required by DoesTheDogDie, so not translated.
        const POWERED_BY = 'Powered by DoesTheDogDie.com';
        const PRESENT_PCT = 50;
        // Topics the user didn't pick need a few votes, so one stray vote doesn't headline.
        const MIN_VOTES = 3;

        let picked = null;       // Set of topic ids, loaded once per session
        let catalogPromise = null;

        function injectCss() {
            const styleId = 'je-ddd-styles';
            if (document.getElementById(styleId)) return;
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .je-ddd-section { display: flex !important; flex-direction: column; width: 100%; min-width: 0; margin: 1.5em 0; }
                .je-ddd-section > summary { cursor: pointer; display: flex; align-items: center; gap: .5em; }
                .je-ddd-gear { margin-left: auto; opacity: .75; cursor: pointer; font-size: 1.2em; padding: .2em; border-radius: 50%; }
                .je-ddd-gear:hover { opacity: 1; background: rgba(255,255,255,.1); }
                .je-ddd-section .expand-icon { transition: transform .2s ease-in-out; }
                .je-ddd-section[open] > summary .expand-icon { transform: rotate(180deg); }
                .je-ddd-sum { margin: .6em 0 .8em; font-size: .95em; }
                .je-ddd-grid { display: flex; flex-wrap: wrap; gap: .5em; margin-bottom: .5em; }
                .je-ddd-chip { display: inline-flex; align-items: center; gap: .5em; padding: .4em .75em; border-radius: 999px; font-size: .88em; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); }
                .je-ddd-chip small { opacity: .7; }
                .je-ddd-dot { width: .55em; height: .55em; border-radius: 50%; background: currentColor; flex: none; }
                .je-ddd-hi { background: rgba(229,57,53,.2); border-color: rgba(229,57,53,.6); } .je-ddd-hi .je-ddd-dot { color: #e53935; }
                .je-ddd-mid { background: rgba(251,140,0,.17); border-color: rgba(251,140,0,.5); } .je-ddd-mid .je-ddd-dot { color: #fb8c00; }
                .je-ddd-low { background: rgba(253,216,53,.12); border-color: rgba(253,216,53,.4); } .je-ddd-low .je-ddd-dot { color: #fdd835; }
                .je-ddd-clear { background: rgba(76,175,80,.14); border-color: rgba(76,175,80,.45); } .je-ddd-clear .je-ddd-dot { color: #4caf50; }
                .je-ddd-more { cursor: pointer; background: none; border: 1px dashed rgba(255,255,255,.3); color: inherit; border-radius: 999px; padding: .4em .85em; font-size: .88em; font-family: inherit; }
                .je-ddd-more:hover { background: rgba(255,255,255,.08); }
                .je-ddd-label { font-size: .75em; opacity: .6; margin: .8em 0 .4em; text-transform: uppercase; letter-spacing: .06em; }
                .je-ddd-foot { margin-top: .8em; font-size: .8em; opacity: .8; }
                .je-ddd-foot a { color: inherit; text-decoration: underline; }
                .je-ddd-modal { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 100000; display: flex; align-items: center; justify-content: center; }
                .je-ddd-box { background: #1c1c1c; color: #fff; border-radius: 10px; padding: 20px; width: min(460px, 92vw); max-height: 85vh; display: flex; flex-direction: column; gap: 10px; }
                .je-ddd-box h3 { margin: 0; }
                .je-ddd-box input[type=text] { padding: 10px; border: 1px solid #444; border-radius: 6px; background: #2a2a2a; color: #fff; }
                .je-ddd-list { overflow: auto; border: 1px solid #333; border-radius: 6px; max-height: 340px; min-height: 120px; }
                .je-ddd-group { position: sticky; top: 0; background: #262626; padding: 6px 10px; font-size: .75em; text-transform: uppercase; letter-spacing: .06em; opacity: .85; }
                .je-ddd-row { display: flex; gap: 10px; align-items: center; padding: 8px 10px; cursor: pointer; }
                .je-ddd-row:hover { background: #2a2a2a; }
                .je-ddd-btns { display: flex; justify-content: flex-end; gap: 8px; }
                .je-ddd-btns button { padding: 9px 16px; border-radius: 6px; border: 1px solid #444; background: #2a2a2a; color: #fff; cursor: pointer; }
                .je-ddd-btns button.je-ddd-save { background: #0078d4; border: none; }
            `;
            document.head.appendChild(style);
        }

        function el(tag, className, text) {
            const node = document.createElement(tag);
            if (className) node.className = className;
            if (text != null) node.textContent = text;
            return node;
        }

        const capitalize = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
        const pctOf = (t) => Math.round((t.Yes / (t.Yes + t.No)) * 100);
        const tone = (pct) => (pct >= 90 ? 'je-ddd-hi' : pct >= 75 ? 'je-ddd-mid' : 'je-ddd-low');

        async function loadPicked() {
            if (picked) return picked;
            picked = new Set();
            try {
                const userId = ApiClient.getCurrentUserId();
                const doc = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/ddd-triggers.json?_=${Date.now()}`),
                    dataType: 'json'
                });
                (doc?.Triggers || []).forEach((id) => picked.add(id));
            } catch (e) {
                console.warn(`${logPrefix} Could not load your triggers.`, e);
            }
            return picked;
        }

        function chip(topic) {
            const pct = pctOf(topic);
            const node = el('span', `je-ddd-chip ${tone(pct)}`);
            node.title = `${topic.Yes} / ${topic.No}`;
            node.append(el('span', 'je-ddd-dot'), el('b', null, capitalize(topic.Name)), el('small', null, `${pct}% · ${(topic.Yes + topic.No).toLocaleString()}`));
            return node;
        }

        function clearChip(topic) {
            const node = el('span', 'je-ddd-chip je-ddd-clear');
            node.title = `${topic.Yes} / ${topic.No}`;
            node.append(el('span', 'je-ddd-dot'), el('b', null, capitalize(topic.Name)), el('small', null, JE.t('ddd_not_reported')));
            return node;
        }

        function buildSection(entry, rebuild) {
            const topics = entry.Topics || [];
            const votes = (t) => t.Yes + t.No;
            const present = topics.filter((t) => pctOf(t) >= PRESENT_PCT && votes(t) >= MIN_VOTES).sort((a, b) => votes(b) - votes(a));
            const hasPicks = picked.size > 0;
            const mine = hasPicks ? topics.filter((t) => picked.has(t.Id)) : [];
            const hits = mine.filter((t) => pctOf(t) >= PRESENT_PCT).sort((a, b) => votes(b) - votes(a));
            const misses = mine.filter((t) => pctOf(t) < PRESENT_PCT);
            const rest = hasPicks ? present.filter((t) => !picked.has(t.Id)) : [];

            const section = el('details', `detailSection ${SECTION_CLASS}`);
            section.open = true;

            const summary = el('summary', 'sectionTitle', JE.t('ddd_title'));
            const gear = el('i', 'material-icons je-ddd-gear', 'settings');
            gear.title = JE.t('ddd_choose_triggers');
            gear.setAttribute('role', 'button');
            gear.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openPicker(rebuild); });
            summary.append(gear, el('i', 'material-icons expand-icon', 'expand_more'));
            section.appendChild(summary);

            let expanded = false;
            const body = el('div');
            section.appendChild(body);

            function render() {
                body.replaceChildren();
                const sum = el('div', 'je-ddd-sum');
                if (!hasPicks) {
                    sum.textContent = present.length
                        ? JE.t('ddd_summary_all', { count: present.length })
                        : JE.t('ddd_summary_none');
                } else {
                    sum.textContent = JE.t('ddd_summary_mine', { hits: hits.length, total: mine.length });
                }
                body.appendChild(sum);

                const grid = el('div', 'je-ddd-grid');
                (hasPicks ? hits : present).forEach((t) => grid.appendChild(chip(t)));
                misses.forEach((t) => grid.appendChild(clearChip(t)));
                body.appendChild(grid);

                if (rest.length) {
                    const more = el('button', 'je-ddd-more', expanded
                        ? JE.t('ddd_hide_others')
                        : JE.t('ddd_show_others', { count: rest.length }));
                    more.type = 'button';
                    more.addEventListener('click', () => { expanded = !expanded; render(); });
                    body.appendChild(more);
                    if (expanded) {
                        body.appendChild(el('div', 'je-ddd-label', JE.t('ddd_other_label')));
                        const other = el('div', 'je-ddd-grid');
                        rest.forEach((t) => other.appendChild(chip(t)));
                        body.appendChild(other);
                    }
                }

                const foot = el('div', 'je-ddd-foot');
                const link = JE.helpers?.createExternalLink
                    ? JE.helpers.createExternalLink(`https://www.doesthedogdie.com/media/${entry.ItemId}`, { text: POWERED_BY, resetStyle: true })
                    : Object.assign(el('a', null, POWERED_BY), { href: `https://www.doesthedogdie.com/media/${entry.ItemId}`, target: '_blank', rel: 'noopener noreferrer' });
                foot.appendChild(link);
                body.appendChild(foot);
            }

            render();
            return section;
        }

        function getCatalog() {
            if (!catalogPromise) {
                catalogPromise = JE.core.api.plugin('/ddd/topics', { cacheKey: 'ddd:topics' }).catch((e) => {
                    catalogPromise = null;
                    throw e;
                });
            }
            return catalogPromise;
        }

        async function openPicker(onSaved) {
            const modal = el('div', 'je-ddd-modal');
            const box = el('div', 'je-ddd-box');
            const search = el('input');
            search.type = 'text';
            search.placeholder = JE.t('ddd_picker_search');
            const list = el('div', 'je-ddd-list');
            list.innerHTML = JE.core.ui.skeletonGridHtml(6, { minWidth: '100%', height: '2em', label: JE.t('ddd_picker_loading') });
            const cancel = el('button', null, JE.t('elsewhere_settings_cancel'));
            const save = el('button', 'je-ddd-save', JE.t('elsewhere_settings_save'));
            cancel.type = save.type = 'button';
            box.append(el('h3', null, JE.t('ddd_picker_title')), search, list, el('div', 'je-ddd-btns'));
            box.lastChild.append(cancel, save);
            modal.appendChild(box);
            document.body.appendChild(modal);

            const close = () => modal.remove();
            cancel.addEventListener('click', close);
            modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

            const draft = new Set(picked);
            let topics = [];
            try {
                topics = (await getCatalog())?.Topics || [];
            } catch (e) {
                list.textContent = JE.t('ddd_picker_failed');
                return;
            }

            function fill(query) {
                list.replaceChildren();
                const q = query.trim().toLowerCase();
                let lastGroup = null;
                topics
                    .filter((t) => !q || t.Name.toLowerCase().includes(q) || t.Category.toLowerCase().includes(q))
                    .sort((a, b) => a.Group.localeCompare(b.Group) || a.Category.localeCompare(b.Category) || a.Name.localeCompare(b.Name))
                    .forEach((t) => {
                        const group = t.Category ? `${t.Group} / ${t.Category}` : t.Group;
                        if (group !== lastGroup) {
                            list.appendChild(el('div', 'je-ddd-group', group));
                            lastGroup = group;
                        }
                        const row = el('label', 'je-ddd-row');
                        const box = el('input');
                        box.type = 'checkbox';
                        box.checked = draft.has(t.Id);
                        box.addEventListener('change', () => { box.checked ? draft.add(t.Id) : draft.delete(t.Id); });
                        row.append(box, el('span', null, capitalize(t.Name)));
                        list.appendChild(row);
                    });
            }
            fill('');
            search.addEventListener('input', () => fill(search.value));

            save.addEventListener('click', async () => {
                picked = draft;
                close();
                await JE.saveUserSettings('ddd-triggers.json', { Triggers: Array.from(draft) });
                onSaved();
            });
        }

        function removeSection(page) {
            const root = page || document.querySelector('#itemDetailPage:not(.hide)') || document;
            root.querySelectorAll(`.${SECTION_CLASS}`).forEach((n) => n.remove());
        }

        function insertSection(page, section) {
            removeSection(page);
            // Above Reviews, else the same anchors Awards uses.
            const reviews = page.querySelector('.tmdb-reviews-section');
            if (reviews?.parentNode) {
                reviews.parentNode.insertBefore(section, reviews);
                return;
            }
            const afterAnchor = page.querySelector('.streaming-lookup-container')
                || page.querySelector('.itemExternalLinks')
                || page.querySelector('.tagline');
            if (afterAnchor?.parentNode) {
                afterAnchor.parentNode.insertBefore(section, afterAnchor.nextSibling);
                return;
            }
            const beforeAnchor = page.querySelector('#similarCollapsible');
            if (beforeAnchor?.parentNode) beforeAnchor.parentNode.insertBefore(section, beforeAnchor);
        }

        async function fetchEntry(type, tmdbId) {
            try {
                const cacheKey = `ddd:/${type}/${tmdbId}`;
                const data = await JE.core.api.plugin(`/ddd/${type}/${tmdbId}`, { cacheKey });
                if (data && data.Confirmed === false) JE.core.api.manager.clearCacheMatching(cacheKey);
                return data;
            } catch (e) {
                console.warn(`${logPrefix} Failed to fetch content warnings.`, e);
                return null;
            }
        }

        async function processPage(page) {
            try {
                const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
                const userId = ApiClient.getCurrentUserId();
                if (!itemId || !userId) return;

                const getItem = (id) => (JE.helpers?.getItemCached
                    ? JE.helpers.getItemCached(id, { userId })
                    : ApiClient.getItem(userId, id));
                const item = await getItem(itemId);

                let tmdbId = null;
                let type;
                if (item?.Type === 'Movie') {
                    tmdbId = item.ProviderIds?.Tmdb;
                    type = 'movie';
                } else if (item?.Type === 'Series' || item?.Type === 'Season' || item?.Type === 'Episode') {
                    // Seasons and episodes use their series' TMDB id.
                    if (item.Type === 'Series') tmdbId = item.ProviderIds?.Tmdb;
                    else if (item.SeriesId) {
                        try { tmdbId = (await getItem(item.SeriesId))?.ProviderIds?.Tmdb; } catch (_) { /* no series */ }
                    }
                    type = 'tv';
                }

                if (!tmdbId) { removeSection(page); return; }

                const entry = await fetchEntry(type, String(tmdbId));
                if (!entry?.Found || !entry.Topics?.length) { removeSection(page); return; }

                await loadPicked();
                const rebuild = () => insertSection(page, buildSection(entry, rebuild));
                rebuild();
            } catch (error) {
                console.error(`${logPrefix} Error processing page:`, error);
            }
        }

        injectCss();

        const unregister = JE.helpers.onViewPage(async (view, element, hash) => {
            if (!JE?.pluginConfig?.DoesTheDogDieEnabled) {
                unregister();
                return;
            }

            const hasItemId = window.location.hash.includes('id=') || (hash && hash.includes('id='));
            const isItemDetailElement = element && (element.id === 'itemDetailPage' || element.classList?.contains('itemDetailPage'));
            if (!hasItemId && !isItemDetailElement) return;

            await new Promise((resolve) => setTimeout(resolve, 150));
            const visiblePage = document.querySelector('#itemDetailPage:not(.hide)');
            if (visiblePage) {
                processPage(visiblePage);
            } else {
                setTimeout(() => {
                    const retryPage = document.querySelector('#itemDetailPage:not(.hide)');
                    if (retryPage) processPage(retryPage);
                }, 500);
            }
        }, {
            pages: null,
            fetchItem: false,
            immediate: true
        });
    };
})(window.JellyfinEnhanced);
