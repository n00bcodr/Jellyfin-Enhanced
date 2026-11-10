import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'Jellyfin.Plugin.JellyfinEnhanced');
const config = join(root, 'Configuration');

// The admin config page as the browser builds it: configPage.html plus every schema section rendered into its placeholder.
function renderPage() {
    const dom = new JSDOM(readFileSync(join(config, 'configPage.html'), 'utf8'), { runScripts: 'outside-only' });
    dom.window.eval(readFileSync(join(config, 'jeAdmin.js'), 'utf8'));
    const files = readdirSync(join(config, 'admin')).filter((f) => f.endsWith('.js')).sort();
    for (const name of files) dom.window.eval(readFileSync(join(config, 'admin', name), 'utf8'));
    const placeholders = [...dom.window.document.querySelectorAll('[data-je-section]')].map((e) => e.getAttribute('data-je-section'));
    dom.window.JEAdmin.mount(dom.window.document, { shell: false });
    return { dom, doc: dom.window.document, JEAdmin: dom.window.JEAdmin, placeholders };
}

test('every section placeholder has a definition and every definition has a placeholder', (t) => {
    const { dom, JEAdmin, placeholders } = renderPage();
    t.after(() => dom.window.close());
    const defined = Object.keys(JEAdmin.sections);
    assert.deepEqual(placeholders.filter((k) => !defined.includes(k)), [], 'placeholder with no definition');
    assert.deepEqual(defined.filter((k) => !placeholders.includes(k)), [], 'definition with no placeholder');
    assert.equal(new Set(placeholders).size, placeholders.length, 'a section is placed twice');
});

test('the rendered page has no duplicate ids, no leftover placeholders and no Jellyfin emby elements', (t) => {
    const { dom, doc } = renderPage();
    t.after(() => dom.window.close());
    const seen = new Map();
    doc.querySelectorAll('[id]').forEach((el) => seen.set(el.id, (seen.get(el.id) || 0) + 1));
    assert.deepEqual([...seen].filter(([, n]) => n > 1).map(([id]) => id), []);
    assert.equal(doc.querySelectorAll('[data-je-section]').length, 0);
    assert.equal(doc.querySelectorAll('[is^="emby-"]').length, 0);
});

test('every schema field renders its control, and toggles render as switches', (t) => {
    const { dom, doc, JEAdmin } = renderPage();
    t.after(() => dom.window.close());
    const missing = [];
    const walk = (items) => items.forEach((i) => {
        if (i.type === 'group') return walk(i.items);
        if (i.id && !['note', 'html', 'custom'].includes(i.type) && !doc.getElementById(i.id)) missing.push(i.id);
        if (i.type === 'toggle') assert.equal(doc.getElementById(i.id)?.type, 'checkbox', i.id);
    });
    Object.values(JEAdmin.sections).forEach((s) => walk(s.items || s.fields || []));
    assert.deepEqual(missing, []);
});

test('load and collect round-trip a section without touching its manual fields', (t) => {
    const { dom, doc, JEAdmin } = renderPage();
    t.after(() => dom.window.close());
    JEAdmin.load({ ShowFileSizes: true, WatchProgressDefaultMode: 'time', UseIcons: false, IconStyle: 'mui' });
    assert.equal(doc.getElementById('showFileSizes').checked, true);
    assert.equal(doc.getElementById('watchProgressDefaultMode').value, 'time');
    assert.equal(doc.getElementById('useIcons').checked, false);
    const out = JEAdmin.collect({ Untouched: 'kept' });
    assert.equal(out.ShowFileSizes, true);
    assert.equal(out.WatchProgressDefaultMode, 'time');
    assert.equal(out.UseIcons, false);
    assert.equal(out.IconStyle, 'mui');
    assert.equal(out.Untouched, 'kept');
});

// The per-user list drives the icon and the apply-to-all banner. It is generated from ResetAllUsersSettings and
// BuildHcDefaultSettings; this fails when either changed and scripts/generate_per_user_props.py was not run.
test('the per-user setting list matches the controller', () => {
    const controller = readFileSync(join(root, 'Features', 'Settings', 'JeSettingsController.cs'), 'utf8');
    const defaults = readFileSync(join(root, 'Shared', 'HiddenContent', 'HiddenContentDefaults.cs'), 'utf8');
    const a = controller.indexOf('[HttpPost("reset-all-users-settings")]');
    const b = controller.indexOf('Reset settings for', a);
    const c = defaults.indexOf('public static HiddenContentSettings BuildHcDefaultSettings');
    const d = defaults.indexOf('\n        }\n', c);
    assert.ok(a >= 0 && b > a && c >= 0 && d > c, 'the reset-all-users-settings or BuildHcDefaultSettings block was not found');
    const expected = new Set([
        ...controller.slice(a, b).matchAll(/=\s*defaultConfig\.(\w+)/g),
        ...defaults.slice(c, d).matchAll(/=\s*src\.(\w+)/g)
    ].map((m) => m[1]));
    assert.ok(expected.size >= 98, `expected at least 98 per-user settings, found ${expected.size}`);
    const generated = readFileSync(join(root, '..', 'client', 'src', 'admin', 'config', 'per-user-props.ts'), 'utf8');
    const actual = new Set([...generated.matchAll(/^\s+'(\w+)',?$/gm)].map((m) => m[1]));
    assert.deepEqual([...actual].sort(), [...expected].sort(), 'run: python scripts/generate_per_user_props.py');
    // The script the page runs carries the same list.
    const emitted = readFileSync(join(config, 'admin', 'per-user.js'), 'utf8');
    assert.deepEqual([...emitted.matchAll(/"(\w+)"/g)].map((m) => m[1]).sort(), [...expected].sort(), 'run: npm run client:build');
});

test('per-user settings show the personal-copy icon', (t) => {
    const { dom, doc, JEAdmin } = renderPage();
    t.after(() => dom.window.close());
    const row = doc.getElementById('showFileSizes').closest('.jea-row');
    assert.ok(row.querySelector('.jea-badge'), 'showFileSizes is per-user');
    assert.equal(doc.getElementById('DefaultLanguage').closest('.jea-row').querySelector('.jea-badge') !== null, true);
    assert.equal(doc.getElementById('useIcons').closest('.jea-row').querySelector('.jea-badge'), null);
    assert.ok(JEAdmin.sections['ui-preferences']);
});

test('a linked copy (Services tab) follows its original in both directions', (t) => {
    const dom = new JSDOM(readFileSync(join(config, 'configPage.html'), 'utf8'), { runScripts: 'outside-only' });
    t.after(() => dom.window.close());
    dom.window.eval(readFileSync(join(config, 'jeAdmin.js'), 'utf8'));
    for (const name of readdirSync(join(config, 'admin')).filter((f) => f.endsWith('.js')).sort()) dom.window.eval(readFileSync(join(config, 'admin', name), 'utf8'));
    dom.window.JEAdmin.mount(dom.window.document); // full mount: wires the copies
    const doc = dom.window.document;
    const original = doc.getElementById('doesTheDogDieApiKey');
    const copy = doc.getElementById('doesTheDogDieApiKey--mirror');
    assert.ok(original && copy, 'both exist with distinct ids');
    let seen = 0;
    original.addEventListener('input', () => { seen++; });
    copy.value = 'abc';
    copy.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(original.value, 'abc');
    assert.equal(seen, 1, 'the original handlers still run');
    original.value = 'xyz';
    original.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(copy.value, 'xyz');
    const toggle = doc.getElementById('mdblistRatingsEnabled--mirror');
    toggle.checked = true;
    toggle.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.equal(doc.getElementById('mdblistRatingsEnabled').checked, true);
});
