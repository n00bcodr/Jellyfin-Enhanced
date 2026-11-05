/* Jellyfin Enhanced admin UI: schema-driven sections.
 * Section definitions live in Configuration/admin/*.js (all embedded and served concatenated after this file) and call
 * JEAdmin.define({ key: spec }). A <div data-je-section="key"> placeholder in configPage.html is replaced by the rendered
 * fieldset. Markup keeps the ids and class names the legacy page code keys on (.checkboxContainer, .inputContainer,
 * .je-setting-description[data-desc-for], fieldset/.sectionTitle), so search, NEW badges and the overview keep working.
 * A field here owns its load and save: delete the matching lines from configPage.html when adding one.
 *
 * Section: { title, icon?, items: [item] }          (`fields` is accepted as an alias of `items`)
 * Item is one of:
 *   field  { id, prop, type, label, desc?, descClass?, default?, main?, perUser?, showIf?, ...type options }
 *            type 'toggle'                          main: true = the section's master switch, later items hide while it is off
 *            type 'text' | 'password'               placeholder
 *            type 'number'                          min, max, step; saved as a Number (default when blank)
 *            type 'textarea'                        rows, placeholder
 *            type 'select'                          options: [[value, label]]
 *            toConfig(uiValue, config) / fromConfig(configValue, config) override the default conversion
 *            perUser: users hold a personal copy (see ResetAllUsersSettings); shows a badge and an apply-to-all banner
 *            showIf: 'otherToggleId' | { id, equals }  hides this field while the condition is false
 *   { type: 'note', html, tone?: 'info'|'warn' }     inline banner (trusted static markup)
 *   { type: 'html', html }                           raw markup, e.g. legacy widgets whose handlers bind by id
 *   { type: 'button', id, label, hint?, variant?: 'primary'|'danger' }   action button; handlers bind by id as before
 *   { type: 'custom', html, init?(rootDocument) }    raw markup plus a callback run right after the section is in the DOM
 * Any field also takes: manual: true (rendered only; load/save stay in configPage.html, so no prop is needed),
 *   attrs / rowAttrs / descAttrs: { 'data-x': 'y' } extra attributes on the control, its row, its description,
 *   rowClass: extra class on the row.
 * Section also takes: id, class, attrs (on the fieldset, e.g. { 'data-dep-setup': '' }), icon (Material) or iconImg
 *   ('selfhst/svg/sonarr.svg', a path under the plugin CDN route), main-less sections simply show every item.
 *   { type: 'group', title, open?, items: [item] }   collapsible block
 * Descriptions and notes are trusted static markup written in source, never user data. */
(function () {
    'use strict';
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const sections = {};
    // A section with mirrorOf renders a linked copy of another section: same fields under suffixed ids, kept in step with the
    // originals (which keep the load/save), so a card can appear in a second tab without duplicate ids.
    const MIRROR = '--mirror';
    const mirrorCond = (c) => (typeof c === 'string' ? c + MIRROR : Object.assign({}, c, { id: c.id + MIRROR }));
    const mirrorItems = (src) => {
        const walk = (items) => items.map((i) => {
            const c = Object.assign({}, i);
            if (c.type === 'group') c.items = walk(c.items);
            if (c.id) { c.id += MIRROR; c.manual = true; delete c.prop; delete c.toConfig; delete c.fromConfig; delete c.perUser; }
            if (c.showIf) c.showIf = mirrorCond(c.showIf);
            if (c.html) c.html = c.html.replace(/\b(id|for)="([^"]+)"/g, (m, k, v) => k + '="' + v + MIRROR + '"');
            delete c.init;
            return c;
        });
        return walk(src.items || src.fields || []);
    };
    const itemsOf = (s) => (s.mirrorOf ? mirrorItems(sections[s.mirrorOf]) : (s.items || s.fields || []));
    const flat = (items) => items.flatMap((i) => (i.type === 'group' ? flat(i.items) : [i]));
    const NON_FIELD = ['note', 'html', 'button', 'custom', 'group'];
    // Every item with an id (including manual ones); auto-load/save only covers those with a prop and not manual.
    const fieldsOf = (s) => flat(itemsOf(s)).filter((i) => i.id && !NON_FIELD.includes(i.type));
    const all = () => Object.values(sections).flatMap(fieldsOf);
    const bound = () => all().filter((f) => f.prop && !f.manual);
    const attrs = (o) => Object.entries(o || {}).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
    const pendingInits = [];
    // Filled by admin/per-user.js (generated from the controller). Manual fields have no prop, so the id is capitalised.
    const perUserProps = new Set();
    const propOf = (f) => f.prop || (f.id ? f.id[0].toUpperCase() + f.id.slice(1) : '');
    const isPU = (f) => f.perUser === true || (f.perUser !== false && perUserProps.has(propOf(f)));
    const BADGE = '<i class="material-icons jea-badge" aria-label="Per-user setting" title="Each user has a personal copy. Existing users keep theirs until you overwrite it.">group</i>';

    // A long description reads as a wall of text, so each sentence gets its own line (unless the author already structured it).
    function breakLines(html) {
        if (!html || html.length < 140 || /<(br|ul|li|p)\b/i.test(html)) return html;
        return html.replace(/([.!?])\s+(?=[A-Z])/g, (m, p, off, str) => (/(e\.g|i\.e|etc|vs|cf)\.$/i.test(str.slice(Math.max(0, off - 5), off + 1)) ? m : p + '<br>'));
    }

    function descHtml(f) {
        return f.desc
            ? `<div class="je-setting-description" data-desc-for="${f.id}"${attrs(f.descAttrs)}><div class="fieldDescription${f.descClass ? ' ' + f.descClass : ''}">${breakLines(f.desc)}</div></div>`
            : '';
    }

    function fieldHtml(f) {
        const desc = descHtml(f);
        if (f.type === 'toggle') {
            return `<div class="checkboxContainer jea-row${f.main ? ' je-main-feature' : ''}${f.rowClass ? ' ' + f.rowClass : ''}"${attrs(f.rowAttrs)}><label class="jea-toggle"><input id="${f.id}" type="checkbox" class="jea-switch"${attrs(f.attrs)}/><span>${esc(f.label)}</span>${isPU(f) ? BADGE : ''}</label></div>${desc}`;
        }
        if (f.type === 'position') {
            // Same 2x2 corner picker as the Enhanced panel. A hidden <select> with the same id keeps load/save working.
            const cells = ['top-left', 'top-right', 'bottom-left', 'bottom-right'].map((p) => `<button type="button" class="jea-pos-cell" data-pos="${p}" title="${p.replace('-', ' ')}" aria-label="${p.replace('-', ' ')}"></button>`).join('');
            return `<div class="checkboxContainer jea-row jea-pos-row${f.rowClass ? ' ' + f.rowClass : ''}"${attrs(f.rowAttrs)}><label class="jea-pos-label" for="${f.id}">${esc(f.label || 'Position')}</label><div class="jea-pos" role="group" aria-label="${esc(f.label || 'Position')}" data-for="${f.id}">${cells}</div><select id="${f.id}" name="${f.id}" hidden${attrs(f.attrs)}>${f.options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select></div>${desc}`;
        }
        const label = `<label class="inputLabel" for="${f.id}">${esc(f.label)}${isPU(f) ? BADGE : ''}</label>`;
        let ctl;
        if (f.type === 'select') {
            ctl = `<select id="${f.id}" name="${f.id}" class="jea-input"${attrs(f.attrs)}>${f.options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`;
        } else if (f.type === 'textarea') {
            ctl = `<textarea id="${f.id}" name="${f.id}" class="jea-input"${attrs(f.attrs)} rows="${f.rows || 3}" placeholder="${esc(f.placeholder || '')}"></textarea>`;
        } else if (f.type === 'number') {
            ctl = `<input id="${f.id}" name="${f.id}" type="number" class="jea-input"${attrs(f.attrs)} ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''} ${f.step !== undefined ? `step="${f.step}"` : ''} placeholder="${esc(f.placeholder || '')}"/>`;
        } else {
            ctl = `<input id="${f.id}" name="${f.id}" type="${f.type === 'password' ? 'password' : 'text'}" class="jea-input"${attrs(f.attrs)} autocomplete="off" placeholder="${esc(f.placeholder || '')}"/>`;
        }
        const inline = f.type === 'number' || f.type === 'select';
        return `<div class="inputContainer jea-row${inline ? ' jea-inline' : ''}${f.rowClass ? ' ' + f.rowClass : ''}"${attrs(f.rowAttrs)}>${label}${ctl}</div>${desc}`;
    }

    function itemHtml(i) {
        const h = rawItemHtml(i);
        return i.showIf && NON_FIELD.includes(i.type) ? `<div data-jea-showif="${esc(typeof i.showIf === 'string' ? i.showIf : i.showIf.id)}"${i.showIf.equals !== undefined ? ` data-jea-equals="${esc(i.showIf.equals)}"` : ''}>${h}</div>` : h;
    }

    function rawItemHtml(i) {
        if (i.type === 'note') return `<div class="jea-note jea-note-${i.tone || 'info'}">${i.html}</div>`;
        if (i.type === 'html') return i.html;
        if (i.type === 'custom') { if (i.init) pendingInits.push(i.init); return i.html; }
        if (i.type === 'button') return `<div class="jea-actions"><button type="button" id="${i.id}" class="jea-btn${i.variant ? ' jea-btn-' + i.variant : ''}">${esc(i.label)}</button>${i.hint ? `<span class="jea-hint">${i.hint}</span>` : ''}</div>`;
        if (i.type === 'group') return `<details class="jea-group"${i.open ? ' open' : ''}><summary>${esc(i.title)}</summary><div class="jea-group-body">${i.items.map(itemHtml).join('')}</div></details>`;
        return fieldHtml(i);
    }

    function sectionHtml(s) {
        if (s.mirrorOf) s = Object.assign({}, sections[s.mirrorOf], { items: itemsOf(s), id: undefined, class: ((sections[s.mirrorOf].class || '') + ' jea-mirror').trim() });
        const icon = s.iconImg ? `<img class="je-legend-icon-img" data-je-cdn="${esc(s.iconImg)}" alt="">`
            : (s.icon ? `<i class="material-icons je-legend-icon" aria-hidden="true">${s.icon}</i>` : '');
        const items = itemsOf(s);
        // The main toggle stays visible; everything after it sits in .jea-sub, which collapses while the main toggle is off.
        const mainIdx = items.findIndex((i) => i.main);
        const top = mainIdx < 0 ? [] : items.slice(0, mainIdx + 1);
        const rest = mainIdx < 0 ? items : items.slice(mainIdx + 1);
        const body = top.map(itemHtml).join('') + (rest.length ? `<div class="jea-sub">${rest.map(itemHtml).join('')}</div>` : '');
        const banner = fieldsOf(s).some(isPU)
            ? '<div class="jea-apply" hidden><div class="jea-apply-text"></div><span class="jea-apply-actions"><button type="button" class="jea-btn jea-btn-primary jea-apply-sel" title="Copies only the settings listed here into the personal settings of every user">Apply the above</button><button type="button" class="jea-btn jea-apply-btn" title="Copies every plugin setting that users also hold personally into every user, replacing their own values">Apply all plugin settings</button></span></div>' : '';
        return `<fieldset class="jea-section${s.class ? ' ' + s.class : ''}"${s.id ? ` id="${s.id}"` : ''}${attrs(s.attrs)}><legend class="sectionTitle">${icon}${esc(s.title)}</legend><div class="configSection">${body}</div>${banner}</fieldset>`;
    }

    const read = (f) => { const el = document.getElementById(f.id); return el ? (f.type === 'toggle' ? el.checked : el.value) : undefined; };
    const base = {};

    // A section whose main toggle is off hides its sub-settings (search mode and the main toggle itself keep them reachable).
    function syncCollapse() {
        document.querySelectorAll('.jea-section').forEach((fs) => {
            const main = fs.querySelector('.je-main-feature input');
            fs.classList.toggle('jea-off', !!main && !main.checked);
        });
    }

    // Per-field showIf: hide the row and its description until the controlling toggle (or select value) matches.
    function syncShowIf() {
        document.querySelectorAll('[data-jea-showif]').forEach((w) => {
            const el = document.getElementById(w.dataset.jeaShowif);
            const on = !el ? true : (w.dataset.jeaEquals !== undefined ? el.value === w.dataset.jeaEquals : (el.type === 'checkbox' ? el.checked : !!el.value));
            w.classList.toggle('jea-dep-hidden', !on);
        });
        all().forEach((f) => {
            if (!f.showIf) return;
            const cond = typeof f.showIf === 'string' ? { id: f.showIf } : f.showIf;
            const el = document.getElementById(cond.id);
            const on = !el ? true : (cond.equals !== undefined ? el.value === String(cond.equals) : (el.type === 'checkbox' ? el.checked : !!el.value));
            const ctl = document.getElementById(f.id);
            const row = ctl && ctl.closest('.jea-row');
            if (row) row.classList.toggle('jea-dep-hidden', !on);
            const d = document.querySelector('.je-setting-description[data-desc-for="' + f.id + '"]');
            if (d) d.classList.toggle('jea-dep-hidden', !on);
        });
    }

    // Show the banner in each section with per-user fields that differ from the last loaded or applied values.
    function syncPos() {
        document.querySelectorAll('.jea-pos').forEach((g) => {
            const sel = document.getElementById(g.dataset.for);
            g.querySelectorAll('.jea-pos-cell').forEach((c) => c.classList.toggle('on', !!sel && sel.value === c.dataset.pos));
        });
    }

    const isField = (el) => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
    const sourceOf = (m) => document.getElementById(m.id.slice(0, -MIRROR.length));
    function copyValue(src, m) {
        if (m.type === 'checkbox') m.checked = src.checked;
        else {
            if (src.tagName === 'SELECT' && m.innerHTML !== src.innerHTML) m.innerHTML = src.innerHTML;
            if (m.value !== src.value) m.value = src.value;
        }
        m.disabled = src.disabled;
    }
    function copyLeaf(src, m) {
        if (m.children.length) return;
        m.className = src.className;
        m.style.cssText = src.style.cssText;
        const html = src.innerHTML.replace(/\sid="[^"]*"/g, '');
        if (m.innerHTML !== html) m.innerHTML = html;
    }
    // Originals can change without an event (the page script loads values straight in), so copy them across now and then.
    function syncMirrors() {
        document.querySelectorAll('[id$="' + MIRROR + '"]').forEach((m) => {
            const src = sourceOf(m);
            if (!src) return;
            if (isField(m)) copyValue(src, m);
            else if (m.tagName !== 'BUTTON') copyLeaf(src, m);
        });
    }
    function wireMirrors() {
        document.querySelectorAll('[id$="' + MIRROR + '"]').forEach((m) => {
            const src = sourceOf(m);
            if (!src || m._mirrored) return;
            m._mirrored = true;
            if (isField(m)) {
                const toSource = (e) => {
                    if (m.type === 'checkbox') src.checked = m.checked; else src.value = m.value;
                    src.dispatchEvent(new Event(e.type, { bubbles: true }));
                };
                m.addEventListener('input', toSource);
                m.addEventListener('change', toSource);
                const toMirror = () => copyValue(src, m);
                src.addEventListener('input', toMirror);
                src.addEventListener('change', toMirror);
            } else if (m.tagName === 'BUTTON') {
                m.addEventListener('click', () => src.click());
            } else {
                new MutationObserver(() => copyLeaf(src, m)).observe(src, { attributes: true, childList: true, characterData: true, subtree: true });
            }
        });
        syncMirrors();
    }

    function refresh() {
        syncMirrors();
        syncCollapse();
        syncPos();
        syncShowIf();
        Object.values(sections).forEach((s) => {
            const fields = fieldsOf(s);
            const first = fields[0] && document.getElementById(fields[0].id);
            const box = first && first.closest('fieldset');
            const banner = box && box.querySelector('.jea-apply');
            if (!banner) return;
            const changed = fields.filter((f) => isPU(f) && base[f.id] !== undefined && read(f) !== base[f.id]);
            banner.hidden = !changed.length;
            banner._changed = changed;
            banner.querySelector('.jea-apply-text').innerHTML = '<strong>' + 'Save and apply the changes below to all users' + '</strong>'
                + '<ul>' + changed.map((f) => '<li>' + esc(f.label) + '</li>').join('') + '</ul>'
                + '<span class="jea-apply-hint">Users keep their own values until you apply this.</span>';
        });
    }

    // Sidebar groups. Tabs not listed (e.g. ones added by Custom Tabs) stay at the end, ungrouped.
    const NAV_GROUPS = [
        ['Appearance', ['display', 'elsewhere']],
        ['Behaviour', ['playback', 'pages', 'extras', 'keyboard']],
        ['Connections', ['services', 'seerr', 'arr']],
        ['Server', ['admin']],
        ['About', ['about', 'docs']]
    ];

    // Turn the horizontal tab strip into a grouped sidebar (a menu on phones). Moves existing nodes, so the page's
    // own tab, drag and search handlers keep working; they all look elements up by selector.
    function mountShell() {
        const bar = document.querySelector('.je-tab-bar');
        const header = document.querySelector('.je-sticky-header');
        const form = document.getElementById('JellyfinEnhancedForm');
        if (!bar || !header || !form || document.querySelector('.jea-layout')) return;
        const layout = document.createElement('div');
        layout.className = 'jea-layout';
        const nav = document.createElement('nav');
        nav.className = 'jea-nav';
        nav.setAttribute('aria-label', 'Settings sections');
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'jea-nav-toggle';
        toggle.setAttribute('aria-expanded', 'false');
        toggle.innerHTML = '<i class="material-icons" aria-hidden="true">menu</i><span class="jea-nav-current"></span>';
        const main = document.createElement('div');
        main.className = 'jea-main';
        const ver = (document.querySelector('script[plugin="Jellyfin Enhanced"]') || {}).getAttribute && document.querySelector('script[plugin="Jellyfin Enhanced"]').getAttribute('version');
        const title = header.querySelector('h2.sectionTitle');
        if (ver && title && !title.querySelector('.jea-ver')) {
            const chip = document.createElement('span');
            chip.className = 'jea-ver';
            chip.textContent = 'v' + ver.split('-')[0];
            title.appendChild(chip);
        }
        header.parentNode.insertBefore(layout, header.nextSibling);
        layout.append(nav, main);
        nav.append(toggle, bar);
        while (layout.nextSibling) main.appendChild(layout.nextSibling);

        // Insert a heading before each group's first tab and gather the group's other tabs after it, in listed order.
        NAV_GROUPS.forEach(([name, ids]) => {
            const btns = ids.map((id) => bar.querySelector('[data-tab="' + id + '"]')).filter(Boolean);
            if (!btns.length) return;
            const h = document.createElement('div');
            h.className = 'jea-nav-group';
            h.textContent = name;
            bar.appendChild(h);
            btns.forEach((b) => bar.appendChild(b));
        });
        // Overview (and anything unlisted) goes first.
        const grouped = new Set(NAV_GROUPS.flatMap((g) => g[1]));
        [...bar.querySelectorAll('.jellyfin-tab-button')].reverse().forEach((b) => { if (!grouped.has(b.dataset.tab)) bar.prepend(b); });

        buildTree(bar);

        // Phone drawer: dimmed backdrop, a header with a close button, and the page behind is locked while it is open.
        const backdrop = document.createElement('div');
        backdrop.className = 'jea-nav-backdrop';
        nav.appendChild(backdrop);
        const head = document.createElement('div');
        head.className = 'jea-drawer-head';
        head.innerHTML = '<span>Settings</span><button type="button" class="jea-drawer-close" aria-label="Close menu"><i class="material-icons" aria-hidden="true">close</i></button>';
        bar.prepend(head);

        const locked = [];
        const scrollParent = () => {
            for (let p = nav.parentElement; p; p = p.parentElement) {
                const o = getComputedStyle(p).overflowY;
                if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p;
            }
            return document.scrollingElement;
        };
        const lock = (on) => {
            if (on) {
                [scrollParent(), document.documentElement, document.body].forEach((el) => {
                    if (el && !locked.some((l) => l.el === el)) { locked.push({ el, prev: el.style.overflow }); el.style.overflow = 'hidden'; }
                });
            } else {
                while (locked.length) { const l = locked.pop(); l.el.style.overflow = l.prev; }
            }
        };
        const setOpen = (open) => {
            nav.classList.toggle('jea-open', open);
            toggle.setAttribute('aria-expanded', String(open));
            lock(open);
        };
        backdrop.addEventListener('click', () => setOpen(false));
        head.querySelector('.jea-drawer-close').addEventListener('click', () => setOpen(false));
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && nav.classList.contains('jea-open')) setOpen(false); });
        // Leaving the phone layout (rotate, resize) must not leave the page locked.
        window.addEventListener('resize', () => { if (window.innerWidth > 900 && nav.classList.contains('jea-open')) setOpen(false); });

        const label = () => { const a = bar.querySelector('.jellyfin-tab-button.active'); toggle.querySelector('.jea-nav-current').textContent = a ? [...a.querySelector('h3').childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim() : 'Settings'; };
        label();
        toggle.addEventListener('click', () => setOpen(!nav.classList.contains('jea-open')));
        // Tab clicks are handled by the page; close the phone menu after the active class has moved.
        bar.addEventListener('click', (e) => { if (e.target.closest('.jea-drawer-head')) return; setTimeout(() => { label(); setOpen(false); syncMirrors(); }, 0); });
    }

    // Sidebar tree: under the active tab, one link per card on that tab. Clicking jumps to the card; the one in view is highlighted.
    function sectionTitle(fs) {
        const lg = fs.querySelector(':scope > legend');
        return lg ? [...lg.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim() : '';
    }

    // Focus mode: picking a card (or a group inside it) in the sidebar shows only that on screen; picking the tab itself shows everything.
    function showAll(tab) {
        if (!tab) return;
        const bt = document.querySelector('.jellyfin-tab-button[data-tab="' + tab.id + '"]');
        if (bt && bt.nextElementSibling) bt.nextElementSibling.querySelectorAll('.jea-nav-leaf.on').forEach((l) => l.classList.remove('on'));
        tab.classList.remove('jea-focused');
        tab.querySelectorAll(':scope > fieldset.jea-focus').forEach((f) => f.classList.remove('jea-focus'));
    }

    function focusCard(tab, fs, group) {
        tab.classList.add('jea-focused');
        tab.querySelectorAll(':scope > fieldset').forEach((f) => f.classList.toggle('jea-focus', f === fs));
        if (group) {
            fs.querySelectorAll('.jea-group').forEach((g) => { g.open = g === group; });
            group.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    }

    function topGroups(fs) {
        return [...fs.querySelectorAll('.jea-group')].filter((g) => !g.parentElement.closest('.jea-group'));
    }

    function buildTree(bar) {
        bar.querySelectorAll('.jellyfin-tab-button').forEach((btn) => {
            const tab = document.getElementById(btn.dataset.tab);
            if (!tab) return;
            btn.addEventListener('click', () => showAll(tab));
            const cards = [...tab.querySelectorAll(':scope > fieldset')].filter((f) => sectionTitle(f));
            if (cards.length < 2) return;
            const tree = document.createElement('div');
            tree.className = 'jea-nav-tree';
            const open = (fn) => { if (btn.classList.contains('active')) fn(); else { btn.click(); setTimeout(fn, 350); } };
            const mark = (leaf, sub) => {
                tree.querySelectorAll('.jea-nav-leaf').forEach((l) => l.classList.toggle('on', l === leaf || l === sub));
            };
            cards.forEach((fs) => {
                const a = document.createElement('a');
                a.href = '#';
                a.className = 'jea-nav-leaf';
                a.textContent = sectionTitle(fs);
                a._card = fs;
                a.addEventListener('click', (e) => { e.preventDefault(); open(() => { focusCard(tab, fs); mark(a); }); });
                tree.appendChild(a);
                const groups = topGroups(fs);
                if (groups.length >= 2) {
                    const sub = document.createElement('div');
                    sub.className = 'jea-nav-subtree';
                    groups.forEach((g) => {
                        const sa = document.createElement('a');
                        sa.href = '#';
                        sa.className = 'jea-nav-leaf jea-nav-sub';
                        sa.textContent = (g.querySelector(':scope > summary') || { textContent: '' }).textContent.trim();
                        sa.addEventListener('click', (e) => { e.preventDefault(); open(() => { focusCard(tab, fs, g); mark(a, sa); }); });
                        sub.appendChild(sa);
                    });
                    tree.appendChild(sub);
                }
            });
            btn.after(tree);
        });
        const search = document.getElementById('settingsSearchInput');
        if (search) search.addEventListener('input', () => { if (search.value) document.querySelectorAll('.jellyfin-tab-content.jea-focused').forEach(showAll); });
    }

    // ---- Our own dialogs (replace Jellyfin's Dashboard.alert / Dashboard.confirm and the browser confirm) ----
    // Messages may carry a few trusted formatting tags; everything else is escaped.
    function safeHtml(text) {
        return esc(text == null ? '' : text)
            .replace(/&lt;(\/?(?:br|b|strong|em|i|code|ul|li|p))\s*\/?&gt;/gi, '<$1>')
            .replace(/\r?\n/g, '<br>');
    }

    function dialog({ title, message, confirmLabel, cancelLabel, danger }) {
        return new Promise((resolve) => {
            const prev = document.activeElement;
            const wrap = document.createElement('div');
            wrap.className = 'jea-dialog-backdrop';
            wrap.innerHTML = `<div class="jea-dialog" role="dialog" aria-modal="true" aria-label="${esc(title || 'Message')}">`
                + `<h3 class="jea-dialog-title">${esc(title || '')}</h3>`
                + `<div class="jea-dialog-body">${safeHtml(message)}</div>`
                + `<div class="jea-dialog-actions">${cancelLabel ? `<button type="button" class="jea-btn" data-r="0">${esc(cancelLabel)}</button>` : ''}`
                + `<button type="button" class="jea-btn ${danger ? 'jea-btn-danger' : 'jea-btn-primary'}" data-r="1">${esc(confirmLabel || 'OK')}</button></div></div>`;
            const done = (v) => { document.removeEventListener('keydown', onKey, true); wrap.remove(); if (prev && prev.focus) prev.focus(); resolve(v); };
            const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
            wrap.addEventListener('click', (e) => {
                const b = e.target.closest('[data-r]');
                if (b) done(b.dataset.r === '1');
                else if (e.target === wrap && !cancelLabel) done(true);
            });
            document.addEventListener('keydown', onKey, true);
            (document.getElementById('JellyfinEnhancedPage') || document.body).appendChild(wrap);
            wrap.querySelector('[data-r="1"]').focus();
        });
    }

    const alertBox = (o) => {
        const opts = typeof o === 'string' ? { message: o } : (o || {});
        return dialog({ title: opts.title, message: opts.message || opts.text }).then(() => { if (typeof opts.callback === 'function') opts.callback(); });
    };
    const confirmBox = (message, title, danger) => dialog({ title: title || 'Please confirm', message, confirmLabel: 'Confirm', cancelLabel: 'Cancel', danger: !!danger });

    // ---- Packed columns that stay put ----
    // Each card is given a column once (shortest column first, when a tab is shown, resized, or leaves search/focus mode) and keeps it.
    // Rows are 1px tracks, so a card spans its own height: when one grows, only the cards below it in the same column move.
    const GAP = 20;
    const MIN_COL = 500;
    const isWide = (el) => el.tagName !== 'FIELDSET' || el.matches('.je-fieldset-wide, .je-overview-section');
    const tall = (el) => el.getBoundingClientRect().height;

    function unpack(tab) {
        if (!tab.classList.contains('jea-masonry')) return;
        tab.classList.remove('jea-masonry');
        tab.style.removeProperty('--jea-cols');
        [...tab.children].forEach((el) => { el.style.gridColumn = ''; el.style.gridRow = ''; });
    }

    function layoutTab(tab, repack) {
        const form = document.getElementById('JellyfinEnhancedForm');
        if (!tab.classList.contains('active') || tab.id === 'docs' || tab.classList.contains('jea-focused') || (form && form.classList.contains('je-search-mode'))) { unpack(tab); return; }
        const cols = Math.max(1, Math.floor((tab.clientWidth + GAP) / (MIN_COL + GAP)));
        if (tab._jeaCols !== cols) { repack = true; tab._jeaCols = cols; }
        if (!tab.classList.contains('jea-masonry')) tab.classList.add('jea-masonry');
        tab.style.setProperty('--jea-cols', cols);
        const items = [...tab.children].filter((el) => getComputedStyle(el).display !== 'none');
        if (repack) items.forEach((el) => { el.style.gridColumn = isWide(el) ? '1 / -1' : '1'; el.style.gridRow = 'auto'; delete el._jeaCol; });
        const ends = new Array(cols).fill(0);
        items.forEach((el) => {
            const h = Math.ceil(tall(el));
            if (isWide(el)) {
                const start = Math.max(...ends);
                el.style.gridColumn = '1 / -1';
                el.style.gridRow = (start + 1) + ' / span ' + (h + GAP);
                ends.fill(start + h + GAP);
                return;
            }
            if (el._jeaCol === undefined) {
                el._jeaCol = ends.indexOf(Math.min(...ends));
                el.style.gridColumn = String(el._jeaCol + 1);
            }
            el.style.gridRow = (ends[el._jeaCol] + 1) + ' / span ' + (h + GAP);
            ends[el._jeaCol] += h + GAP;
        });
    }

    function initMasonry() {
        const form = document.getElementById('JellyfinEnhancedForm');
        if (!form || form._jeaMasonry || typeof ResizeObserver === 'undefined') return;
        form._jeaMasonry = true;
        let pending = null;
        const schedule = (tab, repack) => {
            if (pending) { pending.repack = pending.repack || repack; return; }
            pending = { repack };
            requestAnimationFrame(() => { const p = pending; pending = null; form.querySelectorAll('.jellyfin-tab-content.active').forEach((t) => layoutTab(t, p.repack)); });
        };
        const ro = new ResizeObserver(() => schedule(null, false));
        const watch = (tab) => [...tab.children].forEach((el) => { if (!el._jeaWatched) { el._jeaWatched = true; ro.observe(el); } });
        form.querySelectorAll('.jellyfin-tab-content').forEach((tab) => {
            watch(tab);
            // Showing, focusing or unfocusing a tab repacks it before the browser paints.
            let sig = tab.className.replace(/jea-masonry/g, '').trim();
            new MutationObserver(() => {
                // Our own jea-masonry class change must not retrigger the layout.
                const now = tab.className.replace(/jea-masonry/g, '').trim();
                if (now !== sig) { sig = now; layoutTab(tab, true); }
            }).observe(tab, { attributes: true, attributeFilter: ['class'] });
            // Late additions (dependency banners, dashboards) join the flow.
            new MutationObserver(() => { watch(tab); schedule(tab, false); }).observe(tab, { childList: true });
        });
        new MutationObserver(() => form.querySelectorAll('.jellyfin-tab-content.active').forEach((t) => layoutTab(t, true))).observe(form, { attributes: true, attributeFilter: ['class'] });
        let timer;
        window.addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(() => schedule(null, true), 120); });
        form.querySelectorAll('.jellyfin-tab-content.active').forEach((t) => layoutTab(t, true));
    }

    window.JEAdmin = {
        sections,
        mountShell,
        alert: alertBox,
        confirm: confirmBox,
        dashboardShim(real) {
            return new Proxy(real || {}, {
                get(t, k) {
                    if (k === 'alert') return (o) => alertBox(o);
                    if (k === 'confirm') return (m, title, cb) => confirmBox(m, title).then((v) => { if (typeof cb === 'function') cb(v); return v; });
                    const v = t[k];
                    return typeof v === 'function' ? v.bind(t) : v;
                }
            });
        },
        // Register section definitions (called by Configuration/admin/*.js).
        define(defs) { Object.assign(sections, defs); },
        // Replace every <div data-je-section="key"> with its rendered fieldset. Run before the page script queries ids.
        // opts.shell === false renders the sections only (no sidebar, no event wiring): used to read the finished page offline.
        mount(root, opts) {
            (root || document).querySelectorAll('[data-je-section]').forEach((el) => {
                const s = sections[el.getAttribute('data-je-section')];
                if (s) el.outerHTML = sectionHtml(s);
                else console.warn('[JE] No section definition for', el.getAttribute('data-je-section'));
            });
            while (pendingInits.length) pendingInits.shift()(document);
            if (opts && opts.shell === false) return;
            document.addEventListener('click', (e) => {
                const c = e.target.closest && e.target.closest('.jea-pos-cell');
                if (!c) return;
                const sel = document.getElementById(c.parentElement.dataset.for);
                if (!sel) return;
                sel.value = c.dataset.pos;
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                syncPos();
            });
            mountShell();
            wireMirrors();
            initMasonry();
            document.querySelectorAll('.jea-section').forEach((fs) => {
                fs.addEventListener('change', refresh);
                fs.addEventListener('input', refresh);
                const btn = fs.querySelector('.jea-apply-btn');
                // Reuses the Overview quick action, which saves first and asks for confirmation.
                if (btn) btn.addEventListener('click', () => document.getElementById('resetAllUserSettingsBtn').click());
                const sel = fs.querySelector('.jea-apply-sel');
                // Hands the changed settings to the page script, which saves and calls apply-user-settings.
                if (sel) sel.addEventListener('click', () => {
                    const changed = (fs.querySelector('.jea-apply') || {})._changed || [];
                    if (changed.length) document.dispatchEvent(new CustomEvent('jea-apply-selected', { detail: { props: changed.map(propOf), labels: changed.map((f) => f.label) } }));
                });
            });
        },
        load(config) {
            bound().forEach((f) => {
                const el = document.getElementById(f.id);
                if (!el) return;
                const raw = config[f.prop];
                const v = f.fromConfig ? f.fromConfig(raw, config) : raw;
                if (f.type === 'toggle') el.checked = f.default === true ? v !== false : v === true;
                else el.value = (v === undefined || v === null || v === '') ? (f.default !== undefined ? f.default : '') : v;
                base[f.id] = read(f);
            });
            refresh();
            // Manual fields are loaded by configPage.html right after this call; once they have, record their baselines
            // (for the per-user banner) and re-sync collapse.
            setTimeout(() => { all().forEach((f) => { if (f.manual) base[f.id] = read(f); }); refresh(); }, 0);
        },
        collect(config) {
            bound().forEach((f) => {
                const el = document.getElementById(f.id);
                if (!el) return;
                let v;
                if (f.type === 'toggle') v = el.checked;
                else if (f.type === 'number') v = el.value === '' ? (f.default !== undefined ? f.default : 0) : Number(el.value);
                else v = el.value || (f.default !== undefined ? f.default : '');
                config[f.prop] = f.toConfig ? f.toConfig(v, config) : v;
            });
            return config;
        },
        // Call after the overwrite succeeds so the banners clear.
        markApplied() { all().forEach((f) => { base[f.id] = read(f); }); refresh(); },
        setPerUser(list) { list.forEach((p) => perUserProps.add(p)); }
    };
})();
