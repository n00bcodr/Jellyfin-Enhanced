import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, jsRoot, plain } from '../../../helpers/harness.mjs';
import { readAll } from '../../../helpers/admin-tags-declarations.mjs';
import { BASE, boot, setup, TWO_PAGES } from '../../../helpers/admin-tags-page.mjs';

// The Media Tags admin tab (js/enhanced/admintags/*) is generated from strict TypeScript
// (client/src/features/media-tags/admin). These tests drive the generated scripts: the text contract
// the server and the docs generator read, the public facade, and the faults the rewrite fixed
// (docs/rewrite/admin-tags.md, artifacts/rewrite-admin-tags/bugs.json).

const sectionsDir = resolve(jsRoot, 'enhanced/admintags/sections');
const sectionFiles = () => readdirSync(sectionsDir).filter((f) => f.endsWith('.js')).sort();
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

test('the server, What\'s New and the docs generator read the same declarations from the generated modules as from the hand-written ones', () => {
  const baseline = JSON.parse(readFileSync(new URL('./admin-tags-rewrite.declarations.json', import.meta.url), 'utf8'));
  const now = readAll(Object.fromEntries(sectionFiles().map((f) => [f, readFileSync(resolve(sectionsDir, f), 'utf8')])));
  // Shared/MediaTags/MediaTagsPageFields.cs: the field patch's allowlist (a missing field is refused, an extra one writable).
  assert.deepEqual(now.allowed, baseline.allowed);
  assert.ok(now.allowed.length > 100);
  assert.deepEqual(now.settingIds, baseline.settingIds, 'Features/Admin/Services/WhatsNewService.cs setting ids');
  assert.deepEqual(now.locations, baseline.locations, 'What\'s New locations on the tab');
  assert.deepEqual(now.docs, baseline.docs, 'scripts/generate_config_flag_groups.py fields, groups and labels');
});

test('each module\'s lexical index names exactly the sections, fields and writes it registers', (t) => {
  const h = createHarness({ JE: {} });
  t.after(() => h.close());
  h.load('enhanced/admintags/admin-tags.js');
  const A = h.JE.adminTags;
  for (const file of sectionFiles()) {
    const before = new Set(A.sections.map((s) => s.id));
    h.load(`enhanced/admintags/sections/${file}`);
    const added = A.sections.filter((s) => !before.has(s.id));
    assert.ok(added.length, `${file} registers a section`);
    const index = /\/\*! Lexical index[\s\S]*?\*\//.exec(readFileSync(resolve(sectionsDir, file), 'utf8'))[0];
    const unquote = (text) => text.replaceAll("\\'", "'");
    const listed = [...index.matchAll(/^\s*\{ id: '(\w+)', key: '(\w+)', type: '(\w+)', (?:orderKey: '(\w+)', )?label: '((?:[^'\\]|\\.)*)' \},$/gm)]
      .map((m) => [m[1], m[2], m[3], m[4] ?? null, unquote(m[5])]).sort();
    const registered = added.flatMap((s) => (s.fields || []).map((f) => [f.id, f.key, f.type, f.orderKey ?? null, f.label])).sort();
    assert.deepEqual(listed, plain(registered), `${file} fields`);
    const writes = [...index.matchAll(/^\s*writes: \[([^\]]*)\],$/gm)].flatMap((m) => [...m[1].matchAll(/'(\w+)'/g)].map((q) => q[1])).sort();
    assert.deepEqual(writes, plain(added.flatMap((s) => s.writes || [])).sort(), `${file} writes`);
    const titles = [...index.matchAll(/^\s*title: '((?:[^'\\]|\\.)*)',$/gm)].map((m) => unquote(m[1])).sort();
    assert.deepEqual(titles, plain(added.map((s) => s.title)).sort(), `${file} titles`);
    const groups = [...index.matchAll(/^\s*group: \{ id: '(\w+)' \},$/gm)].map((m) => m[1]).sort();
    assert.deepEqual(groups, plain(added.filter((s) => s.group).map((s) => s.group.id)).sort(), `${file} groups`);
    const tabs = new Set([...index.matchAll(/^\s*tab: '(\w+)',$/gm)].map((m) => m[1]));
    assert.deepEqual([...tabs].sort(), plain([...new Set(added.map((s) => s.tab))]).sort(), `${file} tabs`);
  }
});

test('the facade, module order and section order are the hand-written tab\'s', (t) => {
  const h = createHarness({ JE: {} });
  t.after(() => h.close());
  h.load('enhanced/admintags/admin-tags.js');
  const A = h.JE.adminTags;
  for (const file of A.SECTION_FILES) h.load(`enhanced/admintags/${file}`);
  for (const key of ['fmt', 'WORDS', 'TABS', 'SECTION_FILES', 'SEEDED_KEYS', 'MAIN_PAGE_NAME', 'TAB_ID', 'LEGACY_PAGE_NAME', 'PLUGIN_ID', 'sections',
    'registerSection', 'pageFields', 'seedUser', 'pageUrl', 'mainPageUrl', 'fieldHtml', 'fieldsHtml', 'redrawList', 'fieldValue', 'controlValue',
    'createPage', 'mountTab', 'activate', 'holdSaves', 'current', 'requestedTarget', 'pendingState', 'leaveWithPending',
    'EDITOR_HTML', 'createTagStylesEditor', 'CUSTOM_HTML', 'createCustomTagRules', 'GROUP_SWITCHES', 'cacheSummary', 'rebuildCache',
    'ratingData', 'layoutData', 'rulesData']) assert.ok(key in A, `JE.adminTags.${key}`);
  assert.deepEqual(plain(A.SECTION_FILES), ['tag-styles-editor.js', 'custom-rules-editor.js', 'sections/overview.js', 'sections/layout.js', 'sections/quality.js',
    'sections/genre.js', 'sections/language.js', 'sections/rating.js', 'sections/agerating.js', 'sections/status.js', 'sections/people.js', 'sections/awards.js',
    'sections/logos.js', 'sections/custom.js', 'sections/rules.js', 'sections/colours.js', 'sections/badges.js', 'sections/server.js', 'sections/portable.js']);
  assert.deepEqual(plain(A.sections.map((s) => `${s.tab}/${s.id}`)), ['overview/overview', 'layout/layout-look', 'layout/layout-groups', 'layout/layout-shapes',
    'layout/layout-display', 'groups/group-quality', 'groups/group-genre', 'groups/group-language', 'groups/group-rating', 'groups/group-age-rating',
    'groups/group-status', 'groups/group-awards', 'groups/group-people', 'groups/group-logos', 'groups/group-custom', 'rules/rules', 'rules/item-looks',
    'rules/rules-locks', 'colours/colours', 'badges/badges-families', 'badges/badges-collections', 'badges/badges-windows', 'badges/badges-tmdb', 'badges/badges-leaving',
    'server/server-cache', 'server/server-native', 'server/server-portable', 'server/server-presets']);
  // A section module loaded on its own (no tab core) does nothing, as before.
  const lone = createHarness({ JE: {} });
  try {
    lone.load('enhanced/admintags/sections/genre.js');
    assert.equal(lone.JE.adminTags, undefined);
  } finally { lone.close(); }
});

test('ADMIN-TAGS-01: the Leaving soon state chip is on when up to date and off without a source, not always a warning', async (t) => {
  const good = { Collections: 1, CollectionsFound: 1, Items: 4, Dated: 3, LastSuccess: Date.UTC(2026, 9, 30, 9), NextRefresh: Date.UTC(2026, 9, 30, 15), LastError: null };
  const h = setup(t, { config: { LeavingSoonCollections: 'Leaving Soon' }, routes: { '/admin/leaving-soon': () => good } });
  await settle();
  assert.equal(h.$('[data-leaving-state]').textContent, 'Up to date');
  assert.equal(h.$('[data-leaving-state]').dataset.state, 'on');
  const empty = setup(t, { routes: { '/admin/leaving-soon': () => good } });
  await settle();
  assert.equal(empty.$('[data-leaving-state]').textContent, 'No source set');
  assert.equal(empty.$('[data-leaving-state]').dataset.state, 'off');
  const failing = setup(t, { config: { LeavingSoonCollections: 'Leaving Soon' }, routes: { '/admin/leaving-soon': () => ({ ...good, LastError: 'timeout' }) } });
  await settle();
  assert.equal(failing.$('[data-leaving-state]').textContent, 'Last refresh failed: timeout');
  assert.equal(failing.$('[data-leaving-state]').dataset.state, 'warn');
});

test('ADMIN-TAGS-02: every listener a page puts on its kept root ends with the page, so rebuilt views never double them', (t) => {
  const h = boot(t, { server: structuredClone(BASE) });
  const root = h.document.getElementById('jeTaRoot');
  const unowned = [];
  const add = root.addEventListener.bind(root);
  root.addEventListener = (type, listener, options) => {
    if (!(options && typeof options === 'object' && options.signal)) unowned.push(type);
    return add(type, listener, options);
  };
  const first = h.A.createPage(root, structuredClone(BASE), { confirm: () => true });
  first.dispose();
  const second = h.A.createPage(root, structuredClone(BASE), { confirm: () => true });
  h.cleanup.push(() => second.dispose());
  // Section bodies are redrawn with each view; the root itself is not.
  assert.deepEqual(unowned, [], 'listeners on the root without the page lifetime');
  // A scope switch still saves through the live view only.
  const box = root.querySelector('#jeTaScope-genre-movies');
  box.checked = false;
  box.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  assert.deepEqual(plain(h.A.pendingState().fields), ['TagGroupScopes']);
});

for (const [name, answer] of [['null', async () => null], ['an array', async () => [1, 2]], ['a rejection without a reason', () => Promise.reject(undefined)]]) {
  test(`ADMIN-TAGS-03: a configuration answer that is ${name} shows the load error, never an empty settings page`, async (t) => {
    const h = boot(t, { server: structuredClone(BASE), apiClient: { getPluginConfiguration: answer } });
    h.expectConsoleError('could not load the Media Tags settings');
    h.document.body.innerHTML = TWO_PAGES;
    const page = h.document.querySelector('.page');
    const ctx = await h.A.activate(page);
    assert.equal(ctx, null);
    assert.equal(h.A.current(), null);
    assert.ok(page.querySelector('.je-ta-load-error'), 'the load error with Retry');
    assert.equal(page.querySelector('[data-je-setting-id]'), null, 'no controls drawn over missing settings');
  });
}

test('ADMIN-TAGS-03: a malformed reload keeps the page and what it shows', async (t) => {
  let answer = async () => structuredClone(BASE);
  const h = boot(t, { server: structuredClone(BASE), apiClient: { getPluginConfiguration: () => answer() } });
  h.document.body.innerHTML = TWO_PAGES;
  const page = h.document.querySelector('.page');
  const ctx = await h.A.activate(page);
  h.cleanup.push(() => ctx.dispose());
  answer = async () => 'not a configuration';
  h.allowConsoleError('not a settings document');
  const again = await h.A.activate(page);
  assert.equal(again, ctx, 'the same view');
  assert.equal(page.querySelector('.je-ta-load-error'), null);
  assert.equal(ctx.config.TagLayout, 'corners');
  assert.ok(page.querySelector('#tagsHideOnHover'));
});

test('ADMIN-TAGS-04: a 409 whose conflicts are not an object fails the save once instead of resending it forever', async (t) => {
  let calls = 0;
  const h = setup(t, { patch: () => { calls++; throw { status: 409, json: async () => ({ conflicts: 'TagsHideOnHover' }) }; } });
  h.expectConsoleError('could not save the Media Tags settings');
  h.change(h.$('#tagsHideOnHover'), true);
  const saved = await Promise.race([h.ctx.flush(), new Promise((r) => setTimeout(() => r('looping'), 200))]);
  assert.equal(saved, false);
  assert.equal(calls, 1, 'one request');
  assert.deepEqual(plain(h.A.pendingState()), { state: 'error', fields: ['TagsHideOnHover'], failed: ['TagsHideOnHover'] });
  assert.equal(h.ctx.config.TagsHideOnHover, true, 'the edit is kept for Retry');
});

test('preservation: unknown server fields reload untouched and never go out; an edit pending across a reload is kept', async (t) => {
  const h = setup(t, { config: { SomeFutureField: { nested: [1, 'x'] } }, patch: () => new Promise(() => {}) });
  h.change(h.$('#tagsHideOnHover'), true);
  h.server.SomeFutureField = { nested: [2] };
  h.server.TagsHideOnHover = false;
  h.ctx.reload(structuredClone(h.server));
  assert.deepEqual(plain(h.ctx.config.SomeFutureField), { nested: [2] });
  assert.equal(h.ctx.config.TagsHideOnHover, true, 'the pending edit wins over the reload');
  await new Promise((r) => setTimeout(r, 450));
  assert.ok(h.patches.length >= 1);
  for (const body of h.patches) assert.ok(!('SomeFutureField' in body.Changes) && !('SomeFutureField' in body.Expected));
});
