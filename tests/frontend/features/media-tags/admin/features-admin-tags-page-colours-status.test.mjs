import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { jsRoot, deferred } from '../../../helpers/harness.mjs';
import { BASE, same, boot, setup, TWO_PAGES } from '../../../helpers/admin-tags-page.mjs';

test('Colours: editor edits save the Tag Styles document; Reset all asks, saves and can be undone', async t => {
  const stored = JSON.stringify({ v: 2, preset: 'default', groups: { quality: { background: 'rgba(255, 0, 0, 1)' } } });
  const h = setup(t, { config: { TagStyleOverrides: stored } });
  await h.settle(); await h.settle();
  h.$('#jeTaTab-colours').click();
  h.$('.je-ts-preset[data-preset="glass"]').click();
  await h.save();
  assert.equal(h.server.TagStylePreset, 'glass');
  assert.equal(JSON.parse(h.server.TagStyleOverrides).preset, 'glass');
  h.$('#tagStyleResetAll').click();
  await h.settle();
  await h.save();
  assert.deepEqual(h.confirms, ['Reset all colours']);
  assert.equal(h.server.TagStyleOverrides, '');
  assert.equal(h.server.TagStylePreset, 'default');
  h.$('.je-ta-snack .je-ta-button').click();
  await h.save();
  assert.equal(JSON.parse(h.server.TagStyleOverrides).groups.quality.background, 'rgba(255, 0, 0, 1)');
  assert.equal(h.server.TagStylePreset, 'glass');
  // Off hides the editor; Apply to is disabled with it.
  h.change(h.$('#tagStylesEnabled'), false);
  assert.equal(h.$('#tagStylesBody').style.display, 'none');
  assert.ok([...h.$$('#tagStyleTarget input')].every((r) => r.disabled));
});

test('Status badges: family switches and windows (clamped to 1-365)', async t => {
  const h = setup(t, { config: { StatusTagsEnabled: false } });
  assert.equal(h.$('[data-badges-off]').hidden, false);
  h.change(h.$('#statusTagsSeriesStatus'), true);
  h.change(h.$('#statusTagsJustAddedDays'), '500');
  h.change(h.$('#statusTagsNewReleaseDays'), '0');
  await h.save();
  assert.equal(h.server.StatusTagsSeriesStatus, true);
  assert.equal(h.server.StatusTagsJustAddedDays, 365);
  assert.equal(h.server.StatusTagsNewReleaseDays, 1);
  assert.equal(h.$('#statusTagsJustAddedDays').value, '365');
});

test('Status badges › Collections: one switch between the families and the windows, on until the administrator turns it off for everyone', async t => {
  const h = setup(t, { config: { StatusTagsOnCollections: true } });
  const cards = [...h.$$('#jeTaPanel-badges [data-section]')].map((s) => s.dataset.section);
  assert.deepEqual(cards.slice(0, 3), ['badges-families', 'badges-collections', 'badges-windows']);
  const card = h.$('[data-section="badges-collections"]');
  assert.equal(card.querySelector('.je-ta-card-title').textContent.trim(), 'Collections');
  assert.equal(card.querySelector('.je-ta-hint').textContent.trim(), 'This applies to everyone.');
  const box = h.$('#statusTagsOnCollections');
  assert.equal(box.type, 'checkbox');
  assert.equal(box.checked, true);
  const row = h.$('[data-field-row="statusTagsOnCollections"]');
  assert.match(row.textContent, /Show status badges on collections/);
  assert.match(row.textContent, /Turn this off to keep status badges off collections\./);
  h.change(box, false);
  await h.save();
  assert.equal(h.server.StatusTagsOnCollections, false);
  assert.deepEqual(h.patches.at(-1), { Changes: { StatusTagsOnCollections: false }, Expected: { StatusTagsOnCollections: true } });
});

test('Status badges › Leaving soon: shows the live state and the home row, links to the Maintainerr settings, and edits only the collections list', async t => {
  const status = { Configured: true, Maintainerr: true, Actions: true, HomeRow: 'registered', Collections: 1, CollectionsFound: 1, Items: 4, Dated: 3, LastSuccess: Date.UTC(2026, 9, 30, 9), NextRefresh: Date.UTC(2026, 9, 30, 15), LastError: null };
  const h = setup(t, { config: { LeavingSoonMaintainerrUrl: 'http://maintainerr:6246', LeavingSoonCollections: 'Leaving Soon', LeavingSoonMaintainerrApiKey: 'stored-key-canary' }, routes: { '/admin/leaving-soon': () => status } });
  await h.settle(); await h.settle();
  assert.equal(h.$('[data-leaving-state]').textContent, 'Up to date');
  assert.match(h.$('[data-leaving-detail]').textContent, /^4 items leaving \(3 with a date\) · .* · 1 of 1 collections found$/);
  assert.equal(h.$('[data-leaving-row]').textContent, 'Item-menu actions: on. Home row: registered with Home Screen Sections.');
  // The Maintainerr source belongs to the Services tab now: nothing here edits it or shows the key.
  for (const id of ['leavingSoonMaintainerrUrl', 'leavingSoonMaintainerrApiKey', 'leavingSoonRefreshHours', 'leavingSoonMaintainerrActions', 'leavingSoonHomeRow']) assert.equal(h.$('#' + id), null, id);
  assert.equal(h.$('#leavingSoonCollections').value, 'Leaving Soon', 'the collections list is the one source field kept here');
  assert.ok(!h.document.body.textContent.includes('stored-key-canary'), 'the key is not shown on this page');
  assert.match(h.$('.je-ta-link[href*="arr"]')?.getAttribute('href') || '', /tab=arr|section=arr|arr/);
  h.change(h.$('#leavingSoonCollections'), 'Leaving Soon\nGone Next Week');
  await h.save();
  assert.equal(h.server.LeavingSoonCollections, 'Leaving Soon\nGone Next Week');
  // Refresh asks the server straight away (there are no unsaved source edits on this page).
  h.$('#leavingSoonRefreshBtn').click();
  await h.settle(); await h.settle(); await h.settle();
  assert.deepEqual(h.posts.filter((p) => p.includes('leaving-soon')), ['/JellyfinEnhanced/admin/leaving-soon/refresh']);
  assert.equal(h.$('.je-ta-snack')?.textContent, 'Leaving soon refreshed');
  // Without a source the button is off.
  h.ctx.reload({ ...h.server, LeavingSoonMaintainerrUrl: '', LeavingSoonCollections: '' });
  await h.settle();
  assert.equal(h.$('#leavingSoonRefreshBtn').disabled, true);
  assert.equal(h.$('[data-leaving-state]').textContent, 'No source set');
});

// Upstream 189a0a26: long values keep a wide box, and a key is dots until hovered or focused without being a password field.
test('boxes for long values (URLs, keys, lists) are wide, short ones are not, and the stylesheet draws both the width and the mask', async t => {
  const h = setup(t);
  await h.settle(); await h.settle();
  const control = (id) => h.$('#' + id).parentElement.getAttribute('class');
  // (Upstream 481a10ee moved the Maintainerr URL and key, the page's only masked field, to the Services tab.)
  for (const id of ['awardsTagsImdbList', 'awardsTagsLetterboxdList', 'languageTagsPriority']) {
    assert.equal(control(id), 'je-ta-field-control je-ta-field-control--wide', id);
  }
  for (const id of ['awardsTagsRefreshHours']) assert.equal(control(id), 'je-ta-field-control', id);
  assert.equal(h.$('#awardsTagsImdbList').hasAttribute('class'), false, 'only a key is masked');
  const css = readFileSync(resolve(jsRoot, 'enhanced/admintags/admin-tags.css'), 'utf8');
  assert.match(css, /\.je-ta-field-control--wide \{ flex: 0 1 28em; \}/);
  assert.match(css, /\.je-ta-field-control--wide input \{ width: 100%; \}/);
  assert.match(css, /\.je-ta-masked \{ -webkit-text-security: disc; text-security: disc; \}/);
  assert.match(css, /\.je-ta-masked:is\(:hover, :focus\) \{ -webkit-text-security: none; text-security: none; \}/);
});

test('Status badges › Leaving soon: says which plugin is missing for the home row', async t => {
  for (const [row, text] of [['hss-missing', 'Home Screen Sections is not installed'], ['ft-missing', 'File Transformation is not installed'], ['failed', 'registration failed']]) {
    const h = setup(t, { config: { LeavingSoonMaintainerrUrl: 'http://maintainerr:6246' }, routes: { '/admin/leaving-soon': () => ({ Configured: true, Maintainerr: true, Actions: false, HomeRow: row, Items: 0, Dated: 0, LastSuccess: Date.UTC(2026, 9, 30, 9), LastError: null }) } });
    await h.settle(); await h.settle();
    assert.match(h.$('[data-leaving-row]').textContent, new RegExp('^Item-menu actions: off\\. Home row: .*' + text));
  }
});

for (const outcome of ['answer', 'rejection']) {
  test(`Status badges › Leaving soon: a replacement view loads its own status; the old view's late ${outcome} changes nothing`, async t => {
    const requests = [];
    const server = { ...BASE, LeavingSoonCollections: 'Leaving Soon' };
    const h = boot(t, { server, routes: { '/admin/leaving-soon': () => { const d = deferred(); requests.push(d); return d.promise; } } });
    h.document.body.innerHTML = TWO_PAGES;
    const pages = h.document.querySelectorAll('.page');
    const first = await h.A.activate(pages[0]);
    // Jellyfin builds another Media Tags page while the first view's status is on its way.
    const second = await h.A.activate(pages[1]);
    h.cleanup.push(() => second.dispose());
    await h.settle();
    assert.equal(first.disposed, true);
    assert.equal(requests.length, 2, 'the new view asks for itself');
    const view = (sel) => pages[1].querySelector(sel);
    assert.equal(view('#leavingSoonRefreshBtn').disabled, true, 'busy while its own request runs');
    requests[1].resolve({ Configured: true, Items: 2, Dated: 1, LastSuccess: Date.UTC(2026, 9, 30, 9), LastError: null });
    for (let n = 0; n < 5; n++) await h.settle();
    assert.equal(view('[data-leaving-state]').textContent, 'Up to date');
    assert.equal(view('#leavingSoonRefreshBtn').disabled, false);
    // The old view's request settles last: the new view keeps its own answer and stays usable.
    if (outcome === 'answer') requests[0].resolve({ Configured: true, Items: 9, LastError: 'old view' });
    else requests[0].reject({ status: 500 });
    for (let n = 0; n < 5; n++) await h.settle();
    assert.equal(view('[data-leaving-state]').textContent, 'Up to date');
    assert.match(view('[data-leaving-detail]').textContent, /^2 items leaving \(1 with a date\) · /);
    assert.equal(view('#leavingSoonRefreshBtn').disabled, false);
    // Its Refresh starts and finishes on its own.
    view('#leavingSoonRefreshBtn').click();
    for (let n = 0; n < 5; n++) await h.settle();
    assert.deepEqual(h.posts.filter((p) => p.includes('leaving-soon')), ['/JellyfinEnhanced/admin/leaving-soon/refresh']);
    assert.equal(view('#leavingSoonRefreshBtn').disabled, false);
  });
}

test('the preview draws the saved server Tag Styles, scoped to it, whatever this browser\'s own styles are', async t => {
  const server = structuredClone({ ...BASE, TagStylesEnabled: true, TagStylePreset: 'default' });
  let fetches = 0;
  const h = boot(t, {
    server,
    // GET tag-styles without a preset: the server's model for its own preset (empty while Tag Styles are off).
    routes: { '/JellyfinEnhanced/tag-styles': () => { fetches++; return server.TagStylesEnabled ? { quality: { '4K': { color: server.TagStylePreset === 'glass' ? 'rgba(10, 20, 30, 1)' : 'rgba(40, 50, 60, 1)' } } } : {}; } },
  });
  h.load('tags/tag-styles.js');
  h.load('enhanced/settingspanel/ui-panel-tag-preview.js');
  // The signed-in administrator's own page-wide styles (their preset): red 4K chips.
  h.JE.core.ui.injectCss('je-tag-style-overrides', h.JE.tagStyles.buildCss({ quality: { '4K': { color: 'rgba(255, 0, 0, 1)' } } }));
  h.document.body.insertAdjacentHTML('beforeend', '<div class="quality-overlay-container"><span class="quality-overlay-label resolution" data-quality="4K" id="libraryChip">4K</span></div>');
  const root = h.document.getElementById('jeTaRoot');
  const ctx = h.A.createPage(root, structuredClone(server), { confirm: () => true });
  h.cleanup.push(() => ctx.dispose());
  await h.settle(); await h.settle();
  const chip = () => root.querySelector('#jeTaPreviewBody [data-sample="movie"] .quality-overlay-label[data-quality="4K"]');
  const colour = (el) => h.window.getComputedStyle(el).color;
  assert.ok(chip(), 'the preview draws a 4K chip');
  assert.equal(fetches, 1);
  assert.match(h.document.getElementById('je-tag-admin-preview-styles').textContent, /^#jeTaPreviewBody \.quality-overlay-container/);
  assert.equal(colour(chip()), 'rgb(40, 50, 60)', 'the server default, not the browser\'s red');
  assert.equal(colour(h.document.getElementById('libraryChip')), 'rgb(255, 0, 0)', 'the page-wide styles are untouched');
  // A Colours save refreshes the preview's styles.
  root.querySelector('#jeTaTab-colours').click();
  await h.settle(); await h.settle();
  root.querySelector('.je-ts-preset[data-preset="glass"]').click();
  await ctx.flush();
  await h.settle();
  assert.equal(server.TagStylePreset, 'glass');
  assert.equal(fetches, 2);
  assert.equal(colour(chip()), 'rgb(10, 20, 30)');
  // Tag Styles off: no preview styles, and the browser's own still stay out of the preview.
  h.change(root.querySelector('#tagStylesEnabled'), false);
  await ctx.flush();
  await h.settle();
  assert.equal(h.document.getElementById('je-tag-admin-preview-styles'), null);
  assert.notEqual(colour(chip()), 'rgb(255, 0, 0)');
  assert.equal(colour(h.document.getElementById('libraryChip')), 'rgb(255, 0, 0)');
  // A save of an unrelated field fetches nothing.
  h.change(root.querySelector('#tagsHideOnHover'), true);
  await ctx.flush();
  await h.settle();
  assert.equal(fetches, 3);
});

test('a returning view, and Take theirs, draw the preview with Tag Styles saved elsewhere', async t => {
  const server = structuredClone({ ...BASE, TagStylesEnabled: true, TagStylePreset: 'default' });
  let fetches = 0;
  const h = boot(t, {
    server,
    routes: { '/JellyfinEnhanced/tag-styles': () => { fetches++; return server.TagStylesEnabled ? { quality: { '4K': { color: server.TagStylePreset === 'glass' ? 'rgba(10, 20, 30, 1)' : 'rgba(40, 50, 60, 1)' } } } : {}; } },
  });
  h.load('tags/tag-styles.js');
  h.load('enhanced/settingspanel/ui-panel-tag-preview.js');
  h.document.body.innerHTML = TWO_PAGES;
  const page = h.document.querySelector('.page');
  const ctx = await h.A.activate(page);
  h.cleanup.push(() => ctx.dispose());
  await h.settle(); await h.settle();
  const chip = () => page.querySelector('#jeTaPreviewBody [data-sample="movie"] .quality-overlay-label[data-quality="4K"]');
  const colour = () => h.window.getComputedStyle(chip()).color;
  assert.equal(fetches, 1);
  assert.equal(colour(), 'rgb(40, 50, 60)');
  // Glass saved elsewhere (another administrator, the API) while the page was away; Jellyfin shows the same view again.
  server.TagStylePreset = 'glass';
  assert.equal(await h.A.activate(page), ctx);
  await h.settle(); await h.settle();
  assert.equal(ctx.config.TagStylePreset, 'glass', 'the editor has the new preset');
  assert.equal(fetches, 2);
  assert.equal(colour(), 'rgb(10, 20, 30)', 'and so does the preview');
  // Another administrator changes the same field and the preset back: Take theirs redraws with their styles.
  h.change(page.querySelector('#statusTagsJustAddedDays'), '8');
  server.StatusTagsJustAddedDays = 9;
  server.TagStylePreset = 'default';
  await ctx.flush();
  assert.equal(page.querySelector('#jeTaSaved').dataset.state, 'conflict');
  page.querySelector('[data-je-theirs]').click();
  await ctx.flush();
  await h.settle(); await h.settle();
  assert.equal(fetches, 3);
  assert.equal(colour(), 'rgb(40, 50, 60)');
  assert.equal(server.StatusTagsJustAddedDays, 9);
});

/** WCAG 2 contrast for the page's colour tokens (admin-tags.css), dark and light. */
function themeTokens(css, light) {
  const block = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, selector);
    const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
    return Object.fromEntries([...body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  };
  const tokens = { ...block('.je-tag-admin'), ...(light ? block('.je-tag-admin.je-ta-light') : {}) };
  const resolve = (value) => value.replace(/var\((--[\w-]+)(?:,\s*([^)]+))?\)/g, (m, name, fallback) => (tokens[name] ? resolve(tokens[name]) : fallback.trim()));
  return (name) => resolve(tokens[name] ?? assert.fail(`${name} is defined`));
}
function rgba(value) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, '$&$&') : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1);
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(value);
  assert.ok(m, `a colour: ${value}`);
  const parts = m[1].split(',').map(Number);
  return parts.length === 3 ? [...parts, 1] : parts;
}
/** @returns {number[]} fg drawn over an opaque bg. */
const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
const luminance = (c) => c.slice(0, 3).map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('selected pills, tabs, status text and the preview\'s captions are legible in the dark and light themes', () => {
  const css = readFileSync(resolve(jsRoot, 'enhanced/admintags/admin-tags.css'), 'utf8');
  // The selected controls draw from the checked tokens.
  assert.match(css, /\.je-ta-pill:has\(input:checked\)[^{]*\{ background: var\(--je-ta-selected-bg\); border-color: var\(--je-ta-selected-bg\); color: var\(--je-ta-selected-text\);/);
  assert.match(css, /\.je-ts-pill\.active \{ background: var\(--je-ta-selected-bg\);[^}]*color: var\(--je-ta-selected-text\);/);
  assert.match(css, /\.je-ta-tab\[aria-selected="true"\] \{ color: var\(--je-ta-accent-text\); \}/);
  for (const light of [false, true]) {
    const theme = light ? 'light' : 'dark';
    const token = themeTokens(css, light);
    const page = rgba(token('--je-ta-page-bg'));
    const card = over(rgba(token('--je-ta-surface')), page);   // cards and the preview column
    const on = (name, bg) => over(rgba(token(name)), bg);
    const check = (fg, bg, min, what) => {
      const ratio = contrast(fg, bg);
      assert.ok(ratio >= min, `${theme}: ${what} ${ratio.toFixed(2)}:1 < ${min}:1`);
    };
    const selected = on('--je-ta-selected-bg', card);
    check(on('--je-ta-selected-text', selected), selected, 4.5, 'selected pill text');
    check(selected, page, 3, 'selected pill against the page');
    check(selected, card, 3, 'selected pill against a card');
    check(on('--je-ta-accent', card), card, 3, 'accent outline against a card');
    check(on('--je-ta-accent', page), page, 3, 'accent outline against the page');
    check(on('--je-ta-accent-text', page), page, 4.5, 'selected tab text');
    for (const name of ['--je-ta-text', '--je-ta-muted', '--je-ta-faint', '--je-ta-bad', '--je-ta-warn']) {
      check(on(name, card), card, 4.5, `${name} on a card`);
      check(on(name, page), page, 4.5, `${name} on the page`);
    }
    for (const name of ['--je-mtp-text', '--je-mtp-muted', '--je-mtp-strong', '--je-mtp-lock', '--je-mtp-rule']) check(on(name, card), card, 4.5, `preview ${name}`);
    const pressed = on('--je-mtp-pressed-bg', card);
    check(on('--je-mtp-pressed-text', pressed), pressed, 4.5, 'preview Resting/Hover pressed');
  }
  // The shared preview's captions take those tokens (no fixed white text on the admin page).
  const preview = readFileSync(resolve(jsRoot, 'enhanced/settingspanel/ui-panel-tag-preview.js'), 'utf8');
  const sheet = preview.slice(preview.indexOf('const PREVIEW_CSS'), preview.indexOf('function spotlightCss'));
  for (const m of sheet.matchAll(/(?<![-\w])color: ([^;]+);/g)) assert.match(m[1], /^var\(--je-mtp-/, `preview text colour ${m[1]}`);
});


test('Scenes-only admin preview follows saved server defaults without changing personal settings', async t => {
  const h = setup(t, { config: { StatusTagsEnabled: true, StatusTagsScenes: true, StatusTagsTrending: false,
    StatusTagsNewRelease: false, StatusTagsJustAdded: false, StatusTagsSchedule: false,
    StatusTagsMilestones: false, StatusTagsSeriesStatus: false } });
  const own = h.JE.currentSettings;
  const english = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
  h.JE.t = key => english[key] || key;
  h.load('enhanced/settingspanel/ui-panel-tag-preview.js');
  await h.settle();
  // A returning view mounts the shared preview through the real admin page lifecycle.
  h.ctx.dispose();
  const ctx = h.A.createPage(h.root, h.server);
  h.cleanup.push(() => ctx.dispose());
  await h.settle();
  const movie = () => h.$('[data-sample="movie"] .status-tag');
  assert.equal(movie()?.textContent, 'Post-credits');
  assert.equal(h.JE.currentSettings, own);
  h.change(h.$('#statusTagsScenes'), false);
  await ctx.flush();
  await h.settle();
  assert.equal(h.server.StatusTagsScenes, false);
  assert.equal(movie(), null);
  h.change(h.$('#statusTagsScenes'), true);
  await ctx.flush();
  await h.settle();
  assert.equal(movie()?.textContent, 'Post-credits');
  assert.equal(h.JE.currentSettings, own);
});
