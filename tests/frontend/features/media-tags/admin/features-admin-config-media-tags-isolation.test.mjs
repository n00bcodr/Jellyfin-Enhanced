// The schema-driven admin config page (configPage.html + jeAdmin.js + Configuration/admin/*.js) must never write a
// Media Tags field: those belong to the page's Media Tags tab (#media-tags, after the form), which saves them one field at
// a time. This runs the real page script against a recording ApiClient, changes every Media Tags field on the server after
// the page loaded (as the Media Tags tab would, or another administrator), then saves the page, applies the changed
// settings to all users and applies all plugin settings: every configuration it sends must carry the server's newer Media
// Tags values. (features-admin-config-media-tags-tab.test.mjs runs the same page with the tab open and edited.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..', '..');
const config = join(repo, 'Jellyfin.Plugin.JellyfinEnhanced', 'Configuration');
const MEDIA_TAGS_FIELDS = JSON.parse(readFileSync(join(repo, 'tests', 'fixtures', 'admin-tags-page-fields.json'), 'utf8')).fields;
const DEFAULTS = JSON.parse(readFileSync(join(repo, 'docs', 'advanced', 'config-flag-groups.json'), 'utf8')).defaults;

const clone = (v) => JSON.parse(JSON.stringify(v));

/** A value of the same shape that differs from `v` (so a stale copy is told apart from the server's). */
function changed(name, v, round) {
    if (typeof v === 'boolean') return !v;
    if (typeof v === 'number') return v + 7 * round;
    if (typeof v === 'string') return `${name}-from-media-tags-page-${round}`;
    return { from: 'media-tags-page', field: name, round };
}

async function settle(window, rounds = 30) {
    for (let i = 0; i < rounds; i++) await new Promise((r) => window.setTimeout(r, 0));
}

function bootPage(t) {
    const html = readFileSync(join(config, 'configPage.html'), 'utf8');
    // The page logs its own warnings (no plugins installed, no Seerr): keep the run quiet, but record errors.
    const logged = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('error', (...a) => logged.push(a.map(String).join(' ')));
    virtualConsole.on('jsdomError', (e) => logged.push(String(e && e.stack || e)));
    const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole, url: 'http://jf.test/web/#/configurationpage?name=Jellyfin%20Enhanced' });
    t.after(() => dom.window.close());
    const { window } = dom;
    const server = { config: clone(DEFAULTS) };
    MEDIA_TAGS_FIELDS.forEach((f) => { if (!(f in server.config)) server.config[f] = null; });
    const puts = [];
    const posts = [];
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    window.scrollTo = () => {};
    window.jeCdnUrl = (subpath) => 'http://jf.test/JellyfinEnhanced/cdn/' + subpath;
    window.HTMLElement.prototype.scrollIntoView = function () {};
    window.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
    window.ApiClient = {
        getUrl: (path, query) => 'http://jf.test' + (path.startsWith('/') ? '' : '/') + path + (query ? '?' + new URLSearchParams(query) : ''),
        getPluginConfiguration: async () => clone(server.config),
        updatePluginConfiguration: async (id, body) => { puts.push(clone(body)); server.config = clone(body); return {}; },
        ajax: async (o) => {
            const body = o && typeof o.data === 'string' ? (() => { try { return JSON.parse(o.data); } catch { return o.data; } })() : o && o.data;
            posts.push({ type: o.type, url: o.url, body });
            if (/apply-user-settings/.test(o.url)) return { applied: (body.properties || []).length, userCount: 1, unsupported: [] };
            // Lists (plugins, cultures, users, libraries) come back empty; everything else as an empty object.
            return o.type === 'GET' || !o.type ? [] : {};
        },
        getJSON: async () => [],
        fetch: async () => ({}),
        getCurrentUserId: () => 'admin',
        accessToken: () => 'token',
        serverAddress: () => 'http://jf.test',
        serverId: () => 'server',
        getCurrentUser: async () => ({ Id: 'admin', Policy: { IsAdministrator: true } }),
        getUsers: async () => [],
        getServerConfiguration: async () => ({}),
        getInstalledPlugins: async () => [],
        getPluginConfigurationPages: async () => [],
        getPlugins: async () => [],
    };
    window.Dashboard = { showLoadingMsg() {}, hideLoadingMsg() {}, processPluginConfigurationUpdateResult() {}, alert() {}, confirm() {}, navigate() {} };
    window.eval(readFileSync(join(config, 'jeAdmin.js'), 'utf8'));
    for (const name of readdirSync(join(config, 'admin')).filter((f) => f.endsWith('.js')).sort()) window.eval(readFileSync(join(config, 'admin', name), 'utf8'));
    // Every confirmation is accepted.
    window.JEAdmin.confirm = async () => true;
    window.JEAdmin.alert = async () => {};
    const errors = [];
    window.addEventListener('error', (e) => errors.push(e.error || e.message));
    const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
    window.eval(script);
    return { window, document: window.document, server, puts, posts, errors, logged };
}

function assertMediaTagsKept(sent, expected, what) {
    const clobbered = MEDIA_TAGS_FIELDS.filter((f) => JSON.stringify(sent[f]) !== JSON.stringify(expected[f]));
    assert.deepEqual(clobbered, [], `${what} wrote Media Tags fields with stale or form values`);
}

test('the form holds no control for a Media Tags field; the Display card opens the Media Tags tab, which sits after the form', () => {
    const dom = new JSDOM(readFileSync(join(config, 'configPage.html'), 'utf8'), { runScripts: 'outside-only' });
    try {
        dom.window.eval(readFileSync(join(config, 'jeAdmin.js'), 'utf8'));
        for (const name of readdirSync(join(config, 'admin')).filter((f) => f.endsWith('.js')).sort()) dom.window.eval(readFileSync(join(config, 'admin', name), 'utf8'));
        const fields = [];
        const walk = (items) => items.forEach((i) => (i.type === 'group' ? walk(i.items) : i.id && fields.push(i)));
        Object.values(dom.window.JEAdmin.sections).forEach((s) => walk(s.items || s.fields || []));
        const owned = new Set(MEDIA_TAGS_FIELDS);
        // Manual fields and linked copies have no prop: the engine capitalises the id (as admin/per-user.js does).
        const propOf = (f) => { const id = f.id.replace(/--mirror$/, ''); return f.prop || id[0].toUpperCase() + id.slice(1); };
        assert.deepEqual(fields.filter((f) => owned.has(propOf(f))).map((f) => f.id), []);
        dom.window.JEAdmin.mount(dom.window.document, { shell: false });
        const document = dom.window.document;
        const card = document.getElementById('mediaTagsCard');
        assert.ok(card, 'the Media Tags card is on the page');
        assert.equal(card.querySelectorAll('input, select, textarea').length, 0, 'the card has no controls');
        assert.equal(card.querySelector('.je-media-tags-open').getAttribute('href'), '#/configurationpage?name=Jellyfin%20Enhanced&jeSection=media-tags');
        // The tab: a tab button, and its content after the form (the form's Save, unsaved badge and search never see it).
        assert.ok(document.querySelector('.jellyfin-tab-button[data-tab="media-tags"]'));
        const tab = document.getElementById('media-tags');
        assert.ok(tab && tab.classList.contains('jellyfin-tab-content'));
        assert.equal(tab.closest('form'), null);
        assert.equal(tab.querySelectorAll('input, select, textarea').length, 0, 'drawn only once it opens');
        // No element of the form carries the id of a Media Tags control from the old main form.
        const oldIds = Object.keys(JSON.parse(readFileSync(join(here, 'features-admin-tags-page.old-form-fields.json'), 'utf8')).fields);
        const form = document.getElementById('JellyfinEnhancedForm');
        assert.deepEqual(oldIds.filter((id) => form.querySelector('#' + id)), []);
        assert.deepEqual(oldIds.filter((id) => document.getElementById(id)), [], 'and none on the page until the tab draws');
        // The page script reads none of those ids (the tab owns them once drawn).
        const html = readFileSync(join(config, 'configPage.html'), 'utf8');
        const script = html.slice(html.indexOf('<script type="text/javascript">'));
        assert.deepEqual(oldIds.filter((id) => new RegExp(`['"#]${id}['"\\]]`).test(script)), []);
    } finally { dom.window.close(); }
});

test('Save, Apply the above and Apply all plugin settings keep Media Tags fields changed meanwhile by the Media Tags tab', async (t) => {
    const h = bootPage(t);
    const { window, document, server } = h;
    MEDIA_TAGS_FIELDS.forEach((f) => { server.config[f] = changed(f, server.config[f], 1); });
    server.config.ShowFileSizes = false;
    document.getElementById('JellyfinEnhancedPage').dispatchEvent(new window.Event('pageshow'));
    await settle(window);
    assert.equal(document.getElementById('showFileSizes').checked, false, 'the page loaded the server configuration');
    assert.ok(document.getElementById('jeMediaTagsCardFacts').children.length > 0, 'the Media Tags card shows its summary');

    // Meanwhile, the Media Tags tab (or another administrator) saves every one of its fields.
    MEDIA_TAGS_FIELDS.forEach((f) => { server.config[f] = changed(f, server.config[f], 2); });
    let expected = clone(server.config);

    // 1. Save, with a main-page setting changed.
    const toggle = document.getElementById('showFileSizes');
    toggle.checked = true;
    toggle.dispatchEvent(new window.Event('change', { bubbles: true }));
    document.getElementById('JellyfinEnhancedForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await settle(window);
    assert.ok(h.puts.length >= 1, 'Save sent the configuration');
    assert.equal(h.puts[0].ShowFileSizes, true, 'Save wrote the main-page change');
    h.puts.forEach((sent, i) => assertMediaTagsKept(sent, expected, `Save (write ${i + 1})`));

    // 2. Apply the above (a per-user setting changed), after another Media Tags edit.
    MEDIA_TAGS_FIELDS.forEach((f) => { server.config[f] = changed(f, server.config[f], 3); });
    expected = clone(server.config);
    const before = h.puts.length;
    // Show file sizes is still changed from what the page loaded; change a second per-user setting too.
    const audio = document.getElementById('showAudioLanguages');
    const audioWas = audio.checked;
    audio.checked = !audioWas;
    audio.dispatchEvent(new window.Event('change', { bubbles: true }));
    await settle(window, 5);
    const applySelected = audio.closest('fieldset').querySelector('.jea-apply-sel');
    assert.ok(applySelected, 'the per-user banner offers Apply the above');
    applySelected.click();
    await settle(window);
    const applied = h.posts.filter((p) => /apply-user-settings/.test(p.url));
    assert.equal(applied.length, 1, 'Apply the above called apply-user-settings');
    assert.deepEqual([...applied[0].body.properties].sort(), ['ShowAudioLanguages', 'ShowFileSizes']);
    assert.ok(h.puts.length > before, 'Apply the above saved first');
    h.puts.slice(before).forEach((sent, i) => assertMediaTagsKept(sent, expected, `Apply the above (write ${i + 1})`));
    assert.equal(h.puts.at(-1).ShowAudioLanguages, !audioWas);

    // 3. Apply all plugin settings (Overview quick action), after another Media Tags edit.
    MEDIA_TAGS_FIELDS.forEach((f) => { server.config[f] = changed(f, server.config[f], 4); });
    expected = clone(server.config);
    const beforeAll = h.puts.length;
    document.getElementById('resetAllUserSettingsBtn').click();
    await settle(window);
    assert.ok(h.posts.some((p) => /reset-all-users-settings/.test(p.url)), 'Apply all called reset-all-users-settings');
    assert.ok(h.puts.length > beforeAll, 'Apply all saved first');
    h.puts.slice(beforeAll).forEach((sent, i) => assertMediaTagsKept(sent, expected, `Apply all plugin settings (write ${i + 1})`));
    assert.deepEqual(h.errors, []);
});
