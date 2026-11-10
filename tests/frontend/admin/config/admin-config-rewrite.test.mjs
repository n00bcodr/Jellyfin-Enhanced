import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { bootGenerated, config, pageHtml, repo, servedEngine, settle } from '../../helpers/admin-config-page.mjs';

const require = createRequire(import.meta.url);
const baseline = JSON.parse(readFileSync(join(repo, 'tests/fixtures/admin-config-baseline.json'), 'utf8'));

/** A domain module, bundled from its TypeScript source, as the page bundles it. */
async function domain(path) {
  const { outputFiles } = require('esbuild').buildSync({ entryPoints: [join(repo, 'client/src/admin/config/domain', path)], bundle: true, write: false, format: 'esm', platform: 'neutral' });
  return import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
}

const boot = (t, options) => { const h = bootGenerated(options); t.after(() => h.close()); return h; };

test('ADMIN-CONFIG-01: the page never blocks on a synchronous request and starts when the engine arrives', async t => {
  const h = boot(t, { engine: 'hold', saved: { ShowFileSizes: true } });
  await settle(h.window);
  assert.equal(h.calls.xhr, 0, 'no XMLHttpRequest at all');
  assert.equal(h.calls.engineRequests, 1, 'one request for the engine');
  assert.equal(h.page().getAttribute('aria-busy'), 'true', 'the wait is announced');
  assert.equal(h.document.querySelector('[data-role="content"]').style.visibility, 'hidden', 'no half-built page is shown');
  assert.ok(h.document.querySelector('[data-je-section]'), 'not mounted yet');
  h.held.release();
  await h.ready();
  assert.equal(h.document.querySelector('[data-je-section]'), null, 'every section is mounted');
  assert.equal(h.page().hasAttribute('aria-busy'), false);
  assert.equal(h.document.querySelector('[data-role="content"]').style.visibility, '');
  assert.ok(h.document.getElementById('showFileSizes'), 'controls exist');
});

test('ADMIN-CONFIG-01: a page shown before the engine arrives still loads its settings', async t => {
  const h = boot(t, { engine: 'hold', saved: { ShowFileSizes: true, TMDB_API_KEY: 'k' } });
  await settle(h.window);
  h.show();
  await settle(h.window);
  assert.equal(h.calls.gets, 0, 'nothing can load yet');
  h.held.release();
  await h.ready();
  assert.equal(h.calls.gets, 1, 'the show is replayed once');
  assert.equal(h.document.getElementById('showFileSizes').checked, true);
  assert.equal(h.document.getElementById('TMDB_API_KEY').value, 'k');
});

for (const [engine, what] of [['missing', 'a failed request'], ['empty', 'an empty answer'], ['partial', 'an engine with no sections']]) {
  test(`ADMIN-CONFIG-01: ${what} for the engine says so, with Retry, and writes nothing`, async t => {
    const h = boot(t, { engine, saved: { ShowFileSizes: true } });
    const reports = [];
    h.window.console.error = (...args) => reports.push(args.map(String).join(' '));
    await h.ready();
    if (engine === 'partial') assert.match(reports.join(' '), /defined no sections/, 'refused before mounting anything');
    const banner = h.document.querySelector('.je-admin-load-error');
    assert.ok(banner, 'the failure is visible');
    assert.equal(banner.getAttribute('role'), 'alert');
    assert.match(banner.textContent, /Saved settings are not affected/);
    assert.equal(h.document.querySelector('[data-role="content"]').style.visibility, '', 'the message is not hidden with the page');
    h.document.querySelector('#JellyfinEnhancedForm').dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle(h.window);
    assert.equal(h.calls.puts.length, 0);
    // The next attempt works.
    h.state.engine = 'ok';
    banner.querySelector('button').click();
    await h.ready();
    await settle(h.window);
    assert.equal(h.document.querySelector('.je-admin-load-error'), null);
    assert.ok(h.document.querySelector('.jea-layout'), 'the page started');
  });
}

test('ADMIN-CONFIG-01: a view dropped during the wait does not start', async t => {
  const h = boot(t, { engine: 'hold' });
  await settle(h.window);
  const view = h.page();
  view.remove();
  const reports = [];
  h.window.console.error = (...args) => reports.push(args);
  h.held.release();
  await settle(h.window, 80);
  assert.equal(h.calls.gets, 0);
  assert.equal(h.document.querySelector('.jea-layout'), null);
  assert.deepEqual(reports, [], 'a dropped view is not a failure');
  assert.equal(view.querySelector('.je-admin-load-error'), null);
});

test('ADMIN-CONFIG-02: a failed read hides the spinner, says so, and Save cannot write the empty form over the saved settings', async t => {
  let fail = true;
  const h = boot(t, { saved: { ShowFileSizes: true, TMDB_API_KEY: 'keep-me', Unknown: 1 }, getConfig: async () => { if (fail) throw new Error('offline'); return { ShowFileSizes: true, TMDB_API_KEY: 'keep-me', Unknown: 1 }; } });
  await h.ready();
  h.window.console.error = () => {};
  h.show();
  await settle(h.window);
  assert.equal(h.calls.hidden, h.calls.loading, 'the spinner is not left running');
  const warning = h.document.getElementById('je-probe-warning');
  assert.notEqual(warning.style.display, 'none', 'the failure is visible');
  assert.match(h.document.getElementById('je-probe-warning-msg').textContent, /saving is disabled/);
  h.document.querySelector('#JellyfinEnhancedForm').dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(h.window);
  assert.equal(h.calls.puts.length, 0, 'nothing was written');
  assert.match(h.document.querySelector('.jea-dialog').textContent, /nothing was saved/, 'the administrator is told why');
  h.document.querySelector('.jea-dialog [data-r="1"]').click();
  // Retry reads again, and Save works.
  fail = false;
  h.document.getElementById('je-probe-retry-btn').click();
  await settle(h.window);
  assert.equal(h.document.getElementById('TMDB_API_KEY').value, 'keep-me');
  assert.equal(warning.style.display, 'none');
  h.document.querySelector('#JellyfinEnhancedForm').dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(h.window, 120);
  assert.equal(h.calls.puts.length, 1);
  assert.equal(h.calls.puts[0].TMDB_API_KEY, 'keep-me');
  assert.equal(h.calls.puts[0].Unknown, 1, 'fields this page does not know survive a save');
});

test('ADMIN-CONFIG-02: Apply all plugin settings cannot write the empty form either', async t => {
  const h = boot(t, { getConfig: async n => { if (n === 1) throw new Error('offline'); return { TMDB_API_KEY: 'keep-me' }; } });
  await h.ready();
  h.window.console.error = () => {};
  h.show();
  await settle(h.window);
  h.window.JEAdmin.confirm = async () => true;
  h.document.getElementById('resetAllUserSettingsBtn').click();
  await settle(h.window, 80);
  assert.equal(h.calls.puts.length, 0);
  assert.equal(h.calls.ajax.filter(r => /reset-all-users-settings/.test(r.url)).length, 0);
});

test('ADMIN-CONFIG-03: showing the page again does not stack handlers on its own controls', async t => {
  const h = boot(t, { saved: {} });
  await h.ready();
  for (let i = 0; i < 4; i++) { h.show(); await settle(h.window); }
  const previews = () => h.calls.ajax.filter(r => /usage\/preview/.test(r.url)).length;
  h.document.getElementById('analyticsPreviewBtn').click();
  await settle(h.window);
  assert.equal(previews(), 1, 'one click, one preview request');
});

test('ADMIN-CONFIG-04: dropping the view releases what it registered outside its own elements', async t => {
  const h = boot(t, { saved: { ShowFileSizes: false } });
  await h.ready();
  h.show();
  await settle(h.window);
  const unload = () => { const e = new h.window.Event('beforeunload', { cancelable: true }); h.window.dispatchEvent(e); return e.defaultPrevented; };
  h.document.querySelector('.je-save-dock').classList.add('je-dirty');
  assert.equal(unload(), true, 'unsaved changes warn while the view is live');
  h.page().dispatchEvent(new h.window.Event('viewdestroy'));
  assert.equal(unload(), false, 'a dropped view no longer blocks leaving');
  // The in-page link handler is gone with it: a link is left to the browser.
  const a = h.document.createElement('a');
  a.href = '#/configurationpage?name=Jellyfin%20Enhanced&tab=display';
  h.document.body.appendChild(a);
  const click = new h.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  a.dispatchEvent(click);
  assert.equal(click.defaultPrevented, false);
});

test('ADMIN-CONFIG-08: an older read finishing last does not overwrite a newer one', async t => {
  const answers = [];
  const h = boot(t, { getConfig: () => new Promise(resolve => answers.push(resolve)) });
  await h.ready();
  h.show();
  await settle(h.window);
  h.show();
  await settle(h.window);
  assert.equal(answers.length, 2);
  answers[1]({ TMDB_API_KEY: 'newer' });
  await settle(h.window);
  answers[0]({ TMDB_API_KEY: 'older' });
  await settle(h.window);
  assert.equal(h.document.getElementById('TMDB_API_KEY').value, 'newer');
});

test('ADMIN-CONFIG-05: a failing service sorts first on the status dashboard', async t => {
  const h = boot(t, { saved: { MdblistRatingsEnabled: true, MdblistApiKey: 'k' }, ajax: r => { if (/mdblist-ratings\/account-status/.test(r.url)) throw Object.assign(new Error('x'), { status: 502 }); return undefined; } });
  await h.ready();
  h.show();
  await settle(h.window, 120);
  const cards = [...h.document.querySelectorAll('#je-service-dashboard .je-service-card')];
  assert.ok(cards.length > 1, 'other services are listed too');
  assert.ok(cards[0].classList.contains('je-state-error'), cards.map(c => c.className).join(' | '));
  assert.match(cards[0].textContent, /Could not reach MDBList/);
});

test('ADMIN-CONFIG-06: Seerr import errors from the server reach the page', async t => {
  const h = boot(t, { saved: { JellyseerrEnabled: true, JellyseerrUrls: 'http://seerr.test', JellyseerrApiKey: 'k' } });
  await h.ready();
  h.show();
  await settle(h.window);
  h.window.console.error = () => {};
  h.window.ApiClient.fetch = async () => { throw { status: 502, responseText: JSON.stringify({ errors: ['seerr answered 500'] }) }; };
  h.document.getElementById('btnImportJellyseerrUsers').click();
  const result = h.document.getElementById('importUsersResult');
  for (let i = 0; i < 200 && !/seerr answered/.test(result.textContent); i++) await settle(h.window, 5);
  assert.match(result.textContent, /Import failed/);
  assert.match(result.textContent, /seerr answered 500/);
});

test('the older Media Tags address forwards with its tab and group, and other addresses stay', async t => {
  const html = readFileSync(join(config, 'mediaTagsPage.html'), 'utf8');
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const { JSDOM } = require('jsdom');
  // The real address and the real location.replace: a change of hash is a navigation jsdom performs.
  const run = hash => {
    const dom = new JSDOM('<!doctype html>', { runScripts: 'outside-only', url: 'http://jf.test/web/' + hash });
    t.after(() => dom.window.close());
    dom.window.eval(script);
    return dom.window.location.hash;
  };
  // What ApiMediaTagsPageTests reads from the embedded page.
  assert.ok(html.includes('jeSection=media-tags'));
  assert.ok(html.includes('window.location.replace('));
  assert.equal(run('#/configurationpage?name=JellyfinEnhancedMediaTags&tab=groups&group=rating'), '#/configurationpage?name=Jellyfin%20Enhanced&jeSection=media-tags&tab=groups&group=rating');
  assert.equal(run('#/configurationpage?name=JellyfinEnhancedMediaTags'), '#/configurationpage?name=Jellyfin%20Enhanced&jeSection=media-tags');
  assert.equal(run('#/configurationpage?name=Jellyfin%20Enhanced'), '#/configurationpage?name=Jellyfin%20Enhanced', 'other addresses stay');
});

test('preservation: the page keeps every control, section, per-user flag and setting id of the baseline', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(pageHtml(), { runScripts: 'outside-only' });
  try {
    dom.window.eval(servedEngine());
    dom.window.JEAdmin.mount(dom.window.document, { shell: false });
    const doc = dom.window.document;
    const ids = [...doc.querySelectorAll('[id]')].map(e => e.id).filter(id => id !== 'jeAdminCss').sort();
    assert.deepEqual(ids, baseline.renderedIds);
    assert.deepEqual(Object.keys(dom.window.JEAdmin.sections), baseline.sections);
    assert.deepEqual([...doc.querySelectorAll('.jea-badge')].map(b => b.closest('.jea-row').querySelector('input,select,textarea')?.id).sort(), baseline.perUserBadges);
    assert.deepEqual([...doc.querySelectorAll('.je-main-feature input')].map(e => e.id).sort(), baseline.mainToggles);
  } finally { dom.window.close(); }
});

test('preservation: defaults, conversions and field order survive collect', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(pageHtml(), { runScripts: 'outside-only' });
  try {
    dom.window.eval(servedEngine());
    dom.window.JEAdmin.mount(dom.window.document, { shell: false });
    dom.window.JEAdmin.load({});
    const out = dom.window.JEAdmin.collect({ Kept: 'x' });
    assert.deepEqual(JSON.parse(JSON.stringify(out)), baseline.collectedFromEmpty);
    // A cleared number takes its default, not zero.
    const fields = [];
    const walk = items => items.forEach(i => (i.type === 'group' ? walk(i.items) : fields.push(i)));
    Object.values(dom.window.JEAdmin.sections).forEach(s => walk(s.items || s.fields || []));
    const numbers = fields.filter(f => f.type === 'number' && f.prop && !f.manual && f.default && !f.toConfig);
    assert.ok(numbers.length > 0);
    numbers.forEach(f => { dom.window.document.getElementById(f.id).value = ''; });
    const cleared = dom.window.JEAdmin.collect({});
    numbers.forEach(f => assert.equal(cleared[f.prop], f.default, f.prop));
  } finally { dom.window.close(); }
});

test('the generated page has no handwritten script, no synchronous load and no literal the host would rewrite', () => {
  const html = pageHtml();
  assert.equal((html.match(/<script>/g) || []).length, 2, 'startup and page');
  assert.equal(/XMLHttpRequest/.test(html), false);
  assert.equal(/<script[^>]+type=/.test(html), false);
  assert.equal(/\son[a-z]+="/.test(html.replace(/<script>[\s\S]*?<\/script>/g, '')), false);
  assert.match(html.slice(0, html.indexOf('<div class="je-sticky-header">')), /<style>/, 'the page keeps its own style block');
});

test('Custom Tabs sync plan: adds, keeps, removes only what JE owns', async () => {
  const { planCustomTabsSync, CUSTOM_TAB_MANAGED_ENTRIES: E, anyCustomTabIntent, isCustomTabsConfigShapeOk } = await domain('custom-tabs.ts');
  const e = E[0];
  const on = { [e.masterKey]: true, [e.parentKey]: true, [e.autoKey]: true };
  // Unknown fields on tabs and on the document are the plugin's and stay.
  const cfg = { Other: 1, Tabs: [{ Title: 'Mine', ContentHtml: '<b/>', Extra: true }] };
  let r = planCustomTabsSync(cfg, on);
  assert.equal(r.changed, true);
  assert.deepEqual(cfg.Tabs.map(x => x.Title), ['Mine', e.title]);
  assert.deepEqual(r.ownedUpdates.find(u => u.ownedKey === e.ownedKey), { ownedKey: e.ownedKey, value: true });
  // Existing entry the administrator made: not claimed.
  r = planCustomTabsSync(cfg, on);
  assert.equal(r.changed, false);
  assert.equal(r.ownedUpdates.find(u => u.ownedKey === e.ownedKey).value, false);
  // Not owned: never removed.
  r = planCustomTabsSync(cfg, {});
  assert.equal(cfg.Tabs.length, 2);
  // Owned and no longer wanted: removed; the master flag alone turns it off.
  r = planCustomTabsSync(cfg, { [e.parentKey]: true, [e.autoKey]: true, [e.ownedKey]: true });
  assert.equal(r.changed, true);
  assert.deepEqual(cfg.Tabs.map(x => x.Title), ['Mine']);
  assert.equal(cfg.Tabs[0].Extra, true);
  assert.equal(anyCustomTabIntent(on), true);
  assert.equal(anyCustomTabIntent({ [e.autoKey]: true }), false);
  assert.equal(isCustomTabsConfigShapeOk({ Tabs: [{ Title: 'a', ContentHtml: 'b' }] }), true);
  for (const bad of [null, 'x', {}, { Tabs: 'x' }, { Tabs: [null] }, { Tabs: [{ Title: 1, ContentHtml: 'b' }] }]) {
    const warn = console.warn; console.warn = () => {};
    try { assert.equal(isCustomTabsConfigShapeOk(bad), false); } finally { console.warn = warn; }
  }
});

test('shortcut rules: stored names, taken keys and clashes', async () => {
  const { shortcutCombo: c, shortcutClash, shortcutEntries, DEFAULT_SHORTCUTS: all } = await domain('shortcuts.ts');
  const k = (key, more = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...more });
  assert.equal(c(k('a')), 'A');
  assert.equal(c(k('H', { shiftKey: true })), 'Shift+H');
  assert.equal(c(k('?', { shiftKey: true })), '?', 'a symbol already says Shift');
  assert.equal(c(k('a', { ctrlKey: true, altKey: true, metaKey: true })), 'Meta+Ctrl+Alt+A');
  const keyOf = e => e.Key;
  const speed = all.find(e => e.Name === 'ShowPlaybackInfo');
  assert.equal(shortcutClash(speed, speed.Key, all, keyOf), null, 'its own key');
  assert.match(shortcutClash(speed, 'K', all, keyOf), /Jellyfin player/);
  assert.match(shortcutClash(speed, '/', all, keyOf), /Open Search/);
  assert.equal(shortcutClash(all.find(e => e.Name === 'OpenSearch'), 'K', all, keyOf), null, 'player keys stay free for global shortcuts');
  assert.deepEqual(shortcutEntries([{ Name: 'a', Key: 'b', Extra: 1 }, { Name: 1 }, null]), [{ Name: 'a', Key: 'b', Extra: 1 }]);
  assert.deepEqual(shortcutEntries('nope'), []);
});

test('configuration values keep their mapping and bounds', async () => {
  const { autoMovieTrigger: t, clampedInt: n, httpUrls, lines, maintenanceAction: a } = await domain('config-values.ts');
  assert.deepEqual([a(true, true), a(true, false), a(false, true), a(false, false)], ['both', 'disable_accounts', 'disable_remote', 'none']);
  assert.deepEqual([t(true, true), t(true, false), t(false, true), t(false, false)], ['Both', 'OnStart', 'OnMinutesWatched', 'OnMinutesWatched']);
  assert.deepEqual(httpUrls(lines(' http://a\n\nseerr.local\nftp://b\nhttps://c ')), { valid: ['http://a', 'https://c'], invalid: ['seerr.local', 'ftp://b'] });
  assert.deepEqual([n('', 20, 1, 180), n('0', 20, 1, 180), n('999', 20, 1, 180), n('30', 20, 1, 180)], [20, 20, 180, 30]);
});

test('request failures read only what is there', async () => {
  const { requestFailure, failureDescription, failureMessage } = await domain('http.ts');
  assert.deepEqual(requestFailure(null), {});
  assert.deepEqual(requestFailure('text'), {});
  assert.equal(requestFailure({ status: 'x' }).status, undefined);
  assert.deepEqual(requestFailure({ status: 502, responseText: '{"code":"Cloudflare5xx","message":"m"}' }).body, { code: 'Cloudflare5xx', message: 'm' });
  assert.equal(requestFailure({ responseText: '{broken' }).body, undefined);
  assert.equal(requestFailure({ response: { text: '{"a":1}' } }).body.a, 1);
  assert.equal(failureMessage({ message: 'boom' }, 'f'), 'boom');
  assert.equal(failureMessage(undefined, 'f'), 'f');
  assert.equal(failureDescription({ status: 503 }, 'f'), 'HTTP 503');
  assert.equal(failureDescription({}, 'f'), 'f');
});

test('What\'s New lists new Media Tags settings with a link to their tab', async () => {
  const { humanizeSettingId, mediaTagsWhatsNewEntries, mediaTagsLocations } = await domain('whats-new.ts');
  const page0 = 'JellyfinEnhancedMediaTags';
  const where = mediaTagsLocations({
    tagLayout: { page: page0, tab: 'layout', group: null },
    tagsHideOnHover: { page: page0, tab: 'layout', group: null },
    ratingTagsOnNextUp: { page: page0, tab: 'groups', group: 'rating' },
    ageRatingTagsEnabled: { page: page0, tab: 'groups', group: 'ageRating' },
    // A setting new in a later release, on a tab this build has no name for.
    tagFutureThing: { page: page0, tab: 'extras', group: null },
    broken: 'not a place',
  });
  assert.equal(where.broken, undefined);
  const base = '#/configurationpage?name=Jellyfin%20Enhanced&jeSection=media-tags&tab=';
  assert.deepEqual(mediaTagsWhatsNewEntries(Object.keys(where).concat('notOnAnyPage'), where), [
    { tab: 'media-tags', tabLabel: 'Media Tags', title: 'Layout defaults', href: `${base}layout`, mediaTags: { section: 'layout', group: null }, ids: ['tagLayout', 'tagsHideOnHover'] },
    { tab: 'media-tags', tabLabel: 'Media Tags', title: 'Groups \u203a Rating', href: `${base}groups&group=rating`, mediaTags: { section: 'groups', group: 'rating' }, ids: ['ratingTagsOnNextUp'] },
    { tab: 'media-tags', tabLabel: 'Media Tags', title: 'Groups \u203a Age Rating', href: `${base}groups&group=ageRating`, mediaTags: { section: 'groups', group: 'ageRating' }, ids: ['ageRatingTagsEnabled'] },
    { tab: 'media-tags', tabLabel: 'Media Tags', title: 'Extras', href: `${base}extras`, mediaTags: { section: 'extras', group: null }, ids: ['tagFutureThing'] },
  ]);
  assert.equal(typeof humanizeSettingId('tagLayout'), 'string');
});

test('What\'s New on the live page routes Media Tags settings through the tab', async t => {
  const h = boot(t, { saved: {}, ajax: r => {
    if (/whats-new/.test(r.url) && r.type === 'GET') return { pluginVersion: '1.2', newSettings: { showFileSizes: '1.2', tagLayout: '1.2' }, mediaTags: { tagLayout: { page: 'x', tab: 'layout', group: null } } };
    if (/\/Plugins$/.test(r.url)) return [];
    return undefined;
  } });
  await h.ready();
  h.show();
  await settle(h.window, 100);
  const banner = h.document.getElementById('je-whats-new-banner');
  assert.ok(banner, 'the banner is drawn');
  assert.match(banner.textContent, /Layout defaults/);
  assert.ok(h.document.querySelector('.je-new-badge'), 'the setting on the main page gets its badge');
});

test('What\'s New: the server\'s text readers find exactly the baseline ids in the generated files', () => {
  // Features/Admin/Services/WhatsNewService.cs, SchemaIdRegex and SettingIdRegex, unchanged: renaming a declaration here would re-announce or lose a setting.
  const type = 'toggle|text|password|number|textarea|select|position|button';
  const schema = new RegExp(`\\bid:\\s*'([^']+)'(?=[^{}]*\\btype:\\s*'(?:${type})')`
    + `|\\btype:\\s*'(?:${type})'[^{}]*?\\bid:\\s*'([^']+)'`
    + `|\\b(?:tog|sel|pos|T)\\('([^']+)'`, 'g');
  const found = new Set();
  for (const file of ['admin/per-user.js', 'admin/sections.js']) {
    for (const m of readFileSync(join(config, file), 'utf8').matchAll(schema)) found.add(m[1] || m[2] || m[3]);
  }
  assert.deepEqual([...found].sort(), baseline.whatsNewSchemaIds);
  const markup = [...pageHtml().matchAll(/<(?:input|select|textarea|button)\b[^>]*\bid="([^"]+)"/gi)].map(m => m[1]);
  assert.deepEqual([...new Set(markup)].sort(), baseline.whatsNewHtmlIds);
});

test('the served script is the engine, then the per-user list, then the sections, and says so in its text', () => {
  const served = servedEngine();
  const engine = served.indexOf('window.JEAdmin = ');
  const perUser = served.indexOf('JEAdmin.setPerUser(');
  const sections = served.indexOf('JEAdmin.define(');
  assert.ok(engine >= 0 && engine < perUser && perUser < sections, `${engine} ${perUser} ${sections}`);
});

test('What\'s New: a new schema setting has to join the lexical index', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(pageHtml(), { runScripts: 'outside-only' });
  try {
    dom.window.eval(servedEngine());
    const ids = [];
    const walk = items => items.forEach(item => { if (item.type === 'group') walk(item.items); else if (item.id) ids.push(item.id); });
    Object.values(dom.window.JEAdmin.sections).forEach(section => walk(section.items || section.fields || []));
    const known = new Set([...baseline.whatsNewSchemaIds, ...baseline.schemaIdsNeverAnnounced]);
    assert.deepEqual(ids.filter(id => !id.endsWith('--mirror') && !known.has(id)), [], 'add these to the index in client/src/admin/config/sections-entry.ts');
  } finally { dom.window.close(); }
});

/** A page whose settings are loaded, with Seerr usable and confirmations held open by the test. */
async function loadedPage(t, options = {}) {
  const h = boot(t, { saved: { JellyseerrEnabled: true, JellyseerrUrls: 'http://seerr.test', JellyseerrApiKey: 'k', TMDB_API_KEY: 'stored' }, ...options });
  await h.ready();
  h.show();
  await settle(h.window);
  h.confirmations = [];
  h.window.JEAdmin.confirm = () => new Promise(resolve => h.confirmations.push(resolve));
  h.writes = () => ({ puts: h.calls.puts.length, posts: h.calls.ajax.filter(r => r.type === 'POST').map(r => new URL(r.url).pathname) });
  h.dialogs = () => [...h.document.querySelectorAll('.jea-dialog')].map(d => d.textContent);
  h.submit = () => h.document.querySelector('#JellyfinEnhancedForm').dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
  return h;
}

const SWITCHES = {
  token: h => { h.identity.token = 'token-b'; },
  user: h => { h.identity.userId = 'user-b'; },
  'server id': h => { h.identity.serverId = 'server-b'; },
  'server address': h => { h.identity.serverAddress = 'http://other.test'; },
  'replaced client': h => { h.window.ApiClient = { ...h.window.ApiClient }; },
};

for (const [name, change] of Object.entries(SWITCHES)) {
  test(`ATB-R2-001: Apply all plugin settings resumed after a change of ${name} sends nothing and says nothing`, async t => {
    const h = await loadedPage(t);
    h.document.getElementById('resetAllUserSettingsBtn').click();
    await settle(h.window);
    assert.equal(h.confirmations.length, 1, 'the confirmation is open');
    change(h);
    h.confirmations[0](true);
    await settle(h.window, 60);
    assert.deepEqual(h.writes(), { puts: 0, posts: [] });
    assert.deepEqual(h.dialogs(), [], 'no notice for the old account');
    assert.equal(h.calls.hidden, h.calls.loading, 'no spinner left behind');
  });
}

test('ATB-R2-001 control: the same account confirming Apply all plugin settings still saves, resets and reports', async t => {
  const h = await loadedPage(t);
  h.document.getElementById('resetAllUserSettingsBtn').click();
  await settle(h.window);
  h.confirmations[0](true);
  await settle(h.window, 80);
  assert.equal(h.writes().puts, 1);
  assert.ok(h.writes().posts.includes('/JellyfinEnhanced/reset-all-users-settings'));
  assert.match(h.dialogs().join(), /saved and applied to all users successfully/);
});

test('ATB-R2-001: Apply the above resumed after an account change sends nothing and says nothing; the same account applies', async t => {
  const apply = h => h.document.dispatchEvent(new h.window.CustomEvent('jea-apply-selected', { detail: { props: ['ShowFileSizes'], labels: ['Show file sizes'] } }));
  const h = await loadedPage(t);
  apply(h);
  await settle(h.window);
  h.identity.token = 'token-b';
  h.confirmations[0](true);
  await settle(h.window, 60);
  assert.deepEqual(h.writes(), { puts: 0, posts: [] });
  assert.deepEqual(h.dialogs(), []);
  // Control.
  h.identity.token = 'token-a';
  apply(h);
  await settle(h.window);
  h.confirmations[1](true);
  await settle(h.window, 80);
  assert.equal(h.writes().puts, 1);
  assert.deepEqual(h.writes().posts.filter(p => /apply-user-settings/.test(p)).length, 1);
  assert.match(h.dialogs().join(), /Applied/);
});

for (const [action, start] of [
  ['Apply all plugin settings', h => h.document.getElementById('resetAllUserSettingsBtn').click()],
  ['Apply the above', h => h.document.dispatchEvent(new h.window.CustomEvent('jea-apply-selected', { detail: { props: ['ShowFileSizes'], labels: ['x'] } }))],
]) {
  test(`ATB-R2-001: an account change while ${action} reads the configuration stays silent`, async t => {
    let release;
    const h = await loadedPage(t, { getConfig: async n => { if (n === 2) await new Promise(r => { release = r; }); return { TMDB_API_KEY: 'stored' }; } });
    start(h);
    await settle(h.window);
    h.confirmations[0](true);
    await settle(h.window);
    h.identity.token = 'token-b';
    release();
    await settle(h.window, 60);
    assert.deepEqual(h.writes(), { puts: 0, posts: [] });
    assert.deepEqual(h.dialogs(), [], 'no error notice for the old account');
    assert.equal(h.calls.hidden, h.calls.loading, 'the spinner is cleared');
  });
}

test('ATB-R2-001: an account change while Save reads the configuration writes nothing', async t => {
  let current;
  const h = await loadedPage(t, { getConfig: async n => { if (n === 2) { await new Promise(r => { current = r; }); } return { TMDB_API_KEY: 'stored' }; } });
  h.submit();
  await settle(h.window);
  h.identity.token = 'token-b';
  current();
  await settle(h.window, 60);
  assert.deepEqual(h.writes(), { puts: 0, posts: [] });
  assert.deepEqual(h.dialogs(), []);
  // Save is usable again for whoever is signed in.
  assert.equal(h.document.querySelector('.je-save-dock-btn').disabled, false);
});

test('ATB-R2-001: an account change after the configuration write stops every follow-on write and notice', async t => {
  let h;
  h = await loadedPage(t, { onPut: () => { h.identity.token = 'token-b'; } });
  h.document.getElementById('maintenanceModeEnabled').checked = true;
  h.document.body.classList.add('je-has-customtabs-compat');
  const dirty = h.document.querySelector('.je-save-dock');
  dirty.classList.add('je-dirty');
  h.submit();
  await settle(h.window, 80);
  assert.equal(h.writes().puts, 1, 'the write that was already sent');
  assert.deepEqual(h.writes().posts, [], 'no Custom Tabs write, no maintenance switch or broadcast');
  assert.deepEqual(h.dialogs(), []);
  assert.equal(h.calls.ajax.filter(r => /\/Plugins\/fbacd0b6/.test(r.url)).length, 0, 'not even the Custom Tabs read');
});

test('ATB-R2-001: an account change during the maintenance switch stops its broadcast', async t => {
  let h;
  h = await loadedPage(t, { ajax: r => { if (/MaintenanceMode\/Enable/.test(r.url)) h.identity.token = 'token-b'; return undefined; } });
  h.document.getElementById('maintenanceModeEnabled').checked = true;
  h.submit();
  await settle(h.window, 80);
  assert.deepEqual(h.writes().posts, ['/JellyfinEnhanced/MaintenanceMode/Enable']);
  assert.deepEqual(h.dialogs(), []);
});

test('ATB-R2-001: work waiting in the save queue keeps the account that asked for it', async t => {
  let start;
  const queue = new Promise(resolve => { start = resolve; });
  const h = await loadedPage(t, { globals: { JellyfinEnhanced: { adminTags: { holdSaves: async fn => { await queue; return fn(); } } } } });
  h.submit();
  await settle(h.window);
  h.identity.token = 'token-b';
  start();
  await settle(h.window, 60);
  assert.deepEqual(h.writes(), { puts: 0, posts: [] });
  assert.deepEqual(h.dialogs(), []);
});

test('ATB-R2-001 control: the same account saving maintenance mode still reaches every follow-on write', async t => {
  const h = await loadedPage(t);
  h.document.getElementById('maintenanceModeEnabled').checked = true;
  h.submit();
  await settle(h.window, 120);
  assert.equal(h.writes().puts, 1);
  assert.deepEqual(h.writes().posts, ['/JellyfinEnhanced/MaintenanceMode/Enable', '/JellyfinEnhanced/MaintenanceMode/Broadcast']);
});

test('ATB-R2-001: an account change during the Custom Tabs read leaves the tab list alone', async t => {
  let h;
  const tabs = { Tabs: [] };
  h = await loadedPage(t, { ajax: r => { if (/\/Plugins\/fbacd0b6/.test(r.url) && r.type === 'GET' && h?.armed) { h.identity.token = 'token-b'; return tabs; } return undefined; } });
  h.document.body.classList.add('je-has-customtabs-compat');
  h.armed = true;
  h.submit();
  await settle(h.window, 80);
  assert.deepEqual(h.writes().posts.filter(p => /fbacd0b6/.test(p)), []);
  assert.deepEqual(h.writes().posts.filter(p => /MaintenanceMode/.test(p)), []);
  assert.deepEqual(h.dialogs(), [], 'not reported as a Custom Tabs failure');
});

test('ATB-R2-001: clearing client caches resumed after an account change writes nothing', async t => {
  const h = await loadedPage(t);
  h.document.getElementById('clearTagCachesQuickBtn').click();
  await settle(h.window);
  h.identity.token = 'token-b';
  h.confirmations[0](true);
  await settle(h.window, 60);
  assert.deepEqual(h.writes(), { puts: 0, posts: [] });
  assert.deepEqual(h.dialogs(), []);
});

test('ATB-R2-001: the Seerr import after a save does not run as the next account, and shows it nothing', async t => {
  let h;
  h = await loadedPage(t, { onPut: () => { h.identity.token = 'token-b'; } });
  let imports = 0;
  h.window.ApiClient.fetch = async () => { imports++; return {}; };
  const result = h.document.getElementById('importUsersResult');
  const button = h.document.getElementById('btnImportJellyseerrUsers');
  button.click();
  await settle(h.window, 100);
  assert.equal(imports, 0);
  assert.equal(result.textContent, '');
  assert.equal(button.textContent, 'Import Users Now', 'the button is usable again');
  assert.equal(button.disabled, false);
});

test('ATB-R2-001: the Seerr import stops when the account changes as its save finishes', async t => {
  const h = await loadedPage(t);
  let imports = 0;
  h.window.ApiClient.fetch = async () => { imports++; return {}; };
  h.window.Dashboard.processPluginConfigurationUpdateResult = () => { h.identity.token = 'token-b'; };
  h.document.getElementById('btnImportJellyseerrUsers').click();
  await settle(h.window, 100);
  assert.equal(imports, 0);
  assert.equal(h.document.getElementById('importUsersResult').textContent, '');
  assert.equal(h.document.getElementById('btnImportJellyseerrUsers').textContent, 'Import Users Now');
});

for (const [name, answer] of [['answer', async h => { h.identity.token = 'token-b'; return { usersImported: 3, totalUsers: 3 }; }], ['failure', async h => { h.identity.token = 'token-b'; throw { status: 502 }; }]]) {
  test(`ATB-R2-001: an import ${name} that arrives for the previous account is not shown`, async t => {
    const h = await loadedPage(t);
    h.window.ApiClient.fetch = () => answer(h);
    h.window.console.error = () => {};
    const result = h.document.getElementById('importUsersResult');
    h.document.getElementById('btnImportJellyseerrUsers').click();
    await settle(h.window, 100);
    assert.equal(result.textContent, '');
    assert.equal(result.style.display, 'none');
  });
}

test('ATB-R2-001 control: the same account still sees its import result', async t => {
  const h = await loadedPage(t);
  h.window.ApiClient.fetch = async () => ({ usersImported: 3, totalUsers: 4, errors: [] });
  const result = h.document.getElementById('importUsersResult');
  h.document.getElementById('btnImportJellyseerrUsers').click();
  for (let i = 0; i < 100 && !result.textContent; i++) await settle(h.window, 5);
  assert.match(result.textContent, /Imported 3 new user\(s\) out of 4/);
});

test('a scope from the Media Tags tab decides too, and no-argument tabs still get the page\'s own check', async t => {
  let stale = false;
  const scope = { isCurrent: () => !stale, throwIfStale() { if (stale) throw Object.assign(new Error('old'), { name: 'AbortError' }); } };
  const h = await loadedPage(t, { globals: { JellyfinEnhanced: { adminTags: { holdSaves: fn => fn(scope) } } } });
  h.document.getElementById('resetAllUserSettingsBtn').click();
  await settle(h.window);
  stale = true;
  h.confirmations[0](true);
  await settle(h.window, 60);
  assert.deepEqual(h.writes(), { puts: 0, posts: [] }, 'the tab\'s scope alone expired');
  assert.deepEqual(h.dialogs(), []);
  // A tab that passes no scope.
  const old = await loadedPage(t, { globals: { JellyfinEnhanced: { adminTags: { holdSaves: fn => fn() } } } });
  old.document.getElementById('resetAllUserSettingsBtn').click();
  await settle(old.window);
  old.identity.userId = 'user-b';
  old.confirmations[0](true);
  await settle(old.window, 60);
  assert.deepEqual(old.writes(), { puts: 0, posts: [] });
});

test('work the Media Tags tab refuses before it starts ends silently and writes nothing', async t => {
  const refused = async () => { throw Object.assign(new Error('Media Tags action belongs to a previous session'), { name: 'AbortError' }); };
  const h = await loadedPage(t, { globals: { JellyfinEnhanced: { adminTags: { holdSaves: refused } } } });
  h.submit();
  await settle(h.window);
  h.document.getElementById('resetAllUserSettingsBtn').click();
  await settle(h.window);
  h.document.dispatchEvent(new h.window.CustomEvent('jea-apply-selected', { detail: { props: ['ShowFileSizes'], labels: ['x'] } }));
  await settle(h.window);
  assert.deepEqual(h.writes(), { puts: 0, posts: [] });
  assert.deepEqual(h.dialogs(), []);
});

test('a write scope expires with its origin, with the tab\'s scope, and on completion', async () => {
  const { createWriteScope, sameWriteOrigin } = await domain('write-scope.ts');
  const client = {};
  const origin = { client, serverAddress: 'a', serverId: 's', userId: 'u', token: 't' };
  for (const field of Object.keys(origin)) assert.equal(sameWriteOrigin(origin, { ...origin, [field]: field === 'client' ? {} : 'other' }), false, field);
  assert.equal(sameWriteOrigin(origin, { ...origin }), true);
  let now = origin;
  const scope = createWriteScope(origin, () => now);
  assert.equal(scope.isCurrent(), true);
  assert.doesNotThrow(() => scope.throwIfStale());
  now = { ...origin, token: 'b' };
  assert.equal(scope.isCurrent(), false);
  assert.throws(() => scope.throwIfStale(), { name: 'AbortError' });
  now = origin;
  assert.equal(scope.isCurrent(), true, 'the same account again');
  scope.finish();
  assert.equal(scope.isCurrent(), false);
  assert.throws(() => scope.throwIfStale(), { name: 'AbortError' });
  const held = createWriteScope(origin, () => origin, { isCurrent: () => false, throwIfStale() { throw Object.assign(new Error('x'), { name: 'AbortError' }); } });
  assert.equal(held.isCurrent(), false);
  assert.throws(() => held.throwIfStale(), { name: 'AbortError' });
});

test('a failure that is not a refusal is not reported as one', async () => {
  const { isAbortError } = await domain('http.ts');
  assert.equal(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' })), true);
  for (const other of [new Error('x'), { name: 'TypeError' }, null, 'AbortError', undefined]) assert.equal(isAbortError(other), false);
});

// Upstream af5f9678: the preview follows the real toast: 0 means off, any other value is used as typed.
test('the toast preview uses the typed duration, and says toasts are off at 0', async t => {
  const h = await loadedPage(t);
  const preview = value => {
    h.document.getElementById('ToastDuration').value = value;
    h.document.getElementById('jeTestToast').click();
    const shown = h.document.querySelectorAll('.je-preview-toast');
    assert.equal(shown.length, 1, 'one preview at a time');
    return shown[0].textContent;
  };
  assert.equal(preview('0'), 'Toasts are turned off (0 ms). Nothing will pop up.');
  assert.equal(preview('50'), 'Example toast, disappears in 0.1s');
  assert.equal(preview('4000'), 'Example toast, disappears in 4.0s');
  assert.equal(preview(''), 'Example toast, disappears in 3.0s');
  assert.equal(preview('-20'), 'Example toast, disappears in 3.0s');
  assert.equal(preview('999999'), 'Example toast, disappears in 120.0s');
  assert.match(h.document.querySelector('[data-desc-for="ToastDuration"]').textContent, /Set to 0 to turn toasts off\./);
});

// Upstream 2e1f123d (#1032): "Don't re-add" and its days only apply when removals are Seerr decides or Never.
test('the watchlist re-add rows follow the removal mode and the toggle, and stay that way through other dependency passes', async t => {
  const h = await loadedPage(t);
  const doc = h.document;
  const mode = doc.getElementById('watchlistRemovalSync'), toggle = doc.getElementById('preventWatchlistReAddition'), days = doc.getElementById('watchlistMemoryRetentionDays');
  const hidden = el => el.classList.contains('jea-dep-hidden') || el.style.display === 'none';
  const state = () => ({
    toggleRow: !hidden(toggle.closest('.checkboxContainer, .inputContainer, .selectContainer') || toggle.closest('label')),
    daysRow: !hidden(days.closest('.inputContainer')),
    daysDescription: !hidden(doc.querySelector('.je-setting-description[data-desc-for="watchlistMemoryRetentionDays"]')),
  });
  const set = (el, change) => { change(el); el.dispatchEvent(new h.window.Event('change', { bubbles: true })); };
  assert.equal(mode.value, 'jellyfin', 'the default mode');
  assert.deepEqual([...mode.options].map(o => o.value), ['jellyfin', 'seerr', 'both', 'off']);
  assert.deepEqual(state(), { toggleRow: false, daysRow: false, daysDescription: false }, 'Jellyfin decides: nothing to re-add');
  // Any other parent toggle reruns every dependency rule; the rows must not come back.
  set(doc.getElementById('syncJellyseerrWatchlist'), el => { el.checked = !el.checked; });
  assert.deepEqual(state(), { toggleRow: false, daysRow: false, daysDescription: false }, 'after an unrelated dependency pass');
  for (const [value, shown] of [['seerr', true], ['both', false], ['off', true], ['jellyfin', false]]) {
    set(mode, el => { el.value = value; });
    assert.deepEqual(state(), { toggleRow: shown, daysRow: shown, daysDescription: shown }, value);
  }
  set(mode, el => { el.value = 'seerr'; });
  set(toggle, el => { el.checked = false; });
  assert.deepEqual(state(), { toggleRow: true, daysRow: false, daysDescription: false }, 'toggle off hides only the days');
  set(toggle, el => { el.checked = true; });
  assert.deepEqual(state(), { toggleRow: true, daysRow: true, daysDescription: true });
});

test('the removal mode is saved as chosen and loaded back', async t => {
  const h = await loadedPage(t, { saved: { JellyseerrEnabled: true, JellyseerrUrls: 'http://seerr.test', JellyseerrApiKey: 'k', TMDB_API_KEY: 'stored', WatchlistRemovalSync: 'both' } });
  assert.equal(h.document.getElementById('watchlistRemovalSync').value, 'both');
  h.document.getElementById('watchlistRemovalSync').value = 'off';
  h.submit();
  await settle(h.window, 80);
  assert.equal(h.calls.puts.length, 1);
  assert.equal(h.calls.puts[0].WatchlistRemovalSync, 'off');
});

// Upstream 19cfe99a (#1036): the Custom Tabs copy snippet escapes quotes as well as angle brackets.
test('the Custom Tabs copy snippets escape their quotes in the markup and still copy the plain HTML', async t => {
  const h = await loadedPage(t);
  const markup = [];
  const walk = value => {
    if (typeof value === 'string') { if (value.includes('je-copy-html-btn')) markup.push(value); return; }
    if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(h.window.JEAdmin.sections);
  const snippets = markup.flatMap(html => [...html.matchAll(/data-copy-text='([^']*)'/g)].map(m => m[1]));
  assert.ok(snippets.length >= 5, `found ${snippets.length} snippets`);
  for (const snippet of snippets) {
    assert.match(snippet, /^&lt;div class=&quot;[a-z0-9 -]+&quot;&gt;&lt;\/div&gt;$/, snippet);
  }
  const buttons = [...h.document.querySelectorAll('.je-copy-html-btn')];
  assert.equal(buttons.length, snippets.length);
  for (const button of buttons) {
    assert.match(button.dataset.copyText, /^<div class="[a-z0-9 -]+"><\/div>$/);
    assert.equal(button.parentElement.querySelector('code').textContent, button.dataset.copyText);
  }
});
