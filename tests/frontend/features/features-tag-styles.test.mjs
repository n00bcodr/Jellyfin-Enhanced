import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../helpers/harness.mjs';

const c = (background, border, color) => ({ background, border, color });
// Controls wireSettingsListeners expects (as the panel template renders them).
const toggles = ['autoPauseToggle', 'autoResumeToggle', 'autoPipToggle', 'autoSkipIntroToggle', 'autoSkipOutroToggle',
  'randomButtonToggle', 'randomUnwatchedOnly', 'randomScopeCurrentContainer', 'showWatchProgressToggle', 'showFileSizesToggle',
  'showAudioLanguagesToggle', 'removeContinueWatchingToggle', 'qualityTagsToggle', 'genreTagsToggle', 'pauseScreenToggle',
  'languageTagsToggle', 'ratingTagsToggle', 'ageRatingTagsToggle', 'statusTagsToggle', 'logoTagsToggle', 'customTagsToggle', 'peopleTagsToggle', 'tagsHideOnHoverToggle',
  'disableCustomSubtitleStyles', 'longPress2xEnabled', 'nativePosterTagsToggle', 'randomIncludeMovies', 'randomIncludeShows'];

/**
 * tag-styles.js with ui-kit's injectCss and a captured tag-styles endpoint;
 * withSession also runs the real core/session.js (signed in as user-a).
 */
function setup(t, { pluginConfig = {}, currentSettings = {}, respond, withSession = false } = {}) {
  const requests = [];
  const h = createHarness({
    JE: { pluginConfig: { TagStyleWebActive: true, ...pluginConfig }, currentSettings, t: key => key },
    apiClient: {
      getUrl: (path, params) => `http://jellyfin.test/${path}${params ? `?${new URLSearchParams(params)}` : ''}`,
      getCurrentUserId: () => 'user-a',
      ajax: async request => { requests.push(request.url); return respond ? respond(request.url) : {}; }
    }
  });
  t.after(() => h.close());
  if (withSession) {
    h.JE.core = { navigation: { onNavigate: () => {} } };
    h.load('core/session.js');
  }
  h.load('core/ui-kit.js');
  h.load('tags/tag-styles.js');
  const css = () => h.document.getElementById('je-tag-style-overrides')?.textContent ?? '';
  return { ...h, requests, css };
}

test('group and label rules cover every chip group, status and language included', async t => {
  const h = setup(t, { respond: () => ({
    quality: { '*': c('rgba(255, 0, 0, 1)', null, null), '4K': c('rgba(255, 0, 0, 1)', null, 'rgba(0, 0, 255, 1)') },
    age: [{ ratings: ['PG-13', 'TV-14'], ...c('rgba(1, 2, 3, 1)', null, null) }],
    ageDefault: c('rgba(9, 9, 9, 1)', null, null),
    rating: { community: c(null, 'rgba(255, 255, 255, 0.35)', 'rgba(255, 209, 102, 1)'), userReview: c(null, null, 'rgba(1, 1, 1, 1)') },
    genre: c(null, 'rgba(4, 4, 4, 1)', null),
    status: { trending: c(null, null, 'rgba(0, 255, 0, 1)'), added: c('rgba(5, 5, 5, 1)', null, null) },
    language: c(null, 'rgba(255, 255, 255, 0.6)', null)
  }) });
  await h.JE.initializeTagStyles();
  const raw = h.css();
  // Every page-wide selector skips chips inside a marked preview (the Media Tags admin page's).
  const guard = ':where(:not([data-je-tag-styles-scope] *))';
  for (const rule of raw.split('\n')) {
    for (const selector of rule.slice(0, rule.indexOf(' { ')).split(', ')) assert.ok(selector.endsWith(guard), selector);
  }
  const css = raw.replaceAll(guard, '');
  assert.match(css, /\.quality-overlay-label \{ background: rgba\(255, 0, 0, 1\) !important; \}/, 'the group-wide "*" rule');
  assert.match(css, /\.quality-overlay-label\[data-quality="4K"\] \{ background: rgba\(255, 0, 0, 1\) !important;color: rgba\(0, 0, 255, 1\) !important; \}/);
  assert.match(css, /\.age-rating-tag\[rating="PG-13"\], \.age-rating-overlay-container \.age-rating-tag\[rating="TV-14"\] \{ background-color: rgba\(1, 2, 3, 1\)/);
  assert.match(css, /\.age-rating-overlay-container\.age-rating-overlay-container \.age-rating-tag \{ background-color: rgba\(9, 9, 9, 1\)/);
  assert.match(css, /\.rating-tag-tmdb \{ color: rgba\(255, 209, 102, 1\) !important;outline: 1px solid rgba\(255, 255, 255, 0\.35\) !important; outline-offset: -1px !important;[^}]*\}/,
    'rating chips take the border as an inner ring');
  assert.match(css, /\.rating-tag-tmdb \.rating-star-icon \{ color: rgba\(255, 209, 102, 1\)/);
  assert.match(css, /\.rating-tag-userreview \.je-userreview-icon \{ color: rgba\(1, 1, 1, 1\)/);
  assert.doesNotMatch(css, /rating-tag-critic/, 'chips without styles get no rule');
  assert.match(css, /\.genre-tag \{ border-color: rgba\(4, 4, 4, 1\)/);
  assert.match(css, /\.status-tag\[data-je-status="trending"\] \{ color: rgba\(0, 255, 0, 1\) !important; \}/);
  assert.match(css, /\.status-tag\[data-je-status="trending"\] \.status-tag-rank \{ color: rgba\(0, 255, 0, 1\)/);
  assert.match(css, /\.status-tag\[data-je-status="added"\] \{ background-color: rgba\(5, 5, 5, 1\)/);
  assert.match(css, /\.language-flag:not\(\.language-flag-partial\) \{ outline: 1px solid rgba\(255, 255, 255, 0\.6\)/,
    'partial dubs keep their dashed outline');

  // The rules really reach the chips the renderers draw, except inside a marked preview.
  h.document.body.insertAdjacentHTML('beforeend', '<div class="status-overlay-container"><div class="status-tag status-tag--trending" data-je-status="trending">#1</div></div>'
    + '<div data-je-tag-styles-scope><div class="status-overlay-container"><div class="status-tag status-tag--trending" data-je-status="trending" id="scoped">#1</div></div></div>');
  assert.equal(h.window.getComputedStyle(h.document.querySelector('.status-tag')).color, 'rgb(0, 255, 0)');
  assert.notEqual(h.window.getComputedStyle(h.document.getElementById('scoped')).color, 'rgb(0, 255, 0)');
});

test('nothing but a colour reaches the stylesheet', async t => {
  const evil = 'red; } body { display: none } .x {';
  const h = setup(t, { respond: () => ({
    quality: { '4K"] , body, [x="': c('rgba(1, 1, 1, 1)', null, null), HDR: c(evil, 'url(javascript:alert(1))', 'rgba(1,1,1,1) !important; x: y') },
    age: [{ ratings: ['PG"]{} body{display:none} x["'], ...c(evil, null, null) }],
    rating: { critic: c(null, evil, null) },
    status: { trending: c(evil, null, null), '<script>': c('rgba(1, 1, 1, 1)', null, null) },
    language: c(null, evil, null)
  }) });
  await h.JE.initializeTagStyles();
  const css = h.css();
  assert.doesNotMatch(css, /display: none|javascript|x: y|<script/i);
  assert.match(css, /\[data-quality="4K\\"\] , body, \[x=\\""\]/, 'quotes in a label stay inside the attribute string');
  assert.doesNotMatch(css, /HDR/, 'a chip whose every value is rejected gets no rule');
  const sheet = h.document.getElementById('je-tag-style-overrides').sheet;
  assert.ok(sheet.cssRules.length >= 1);
  for (const rule of sheet.cssRules) assert.doesNotMatch(rule.selectorText, /^body$/);
});

test('buildCss accepts one element id as its scope and nothing wider', async t => {
  const h = setup(t, { respond: () => ({}) });
  const model = { quality: { '*': c('rgba(1, 1, 1, 1)', null, null) } };
  const scoped = h.JE.tagStyles.buildCss(model, '#tagStylePreview');
  assert.match(scoped, /^#tagStylePreview \.quality-overlay-container/);
  assert.doesNotMatch(scoped, /:where/, 'a scoped sheet needs no guard');
  for (const bad of ['#tagStylePreview, body', 'body', '#a b', '#a{}', '#a>.b', '.preview', '#']) {
    assert.throws(() => h.JE.tagStyles.buildCss(model, bad), /single #id/, bad);
  }
  assert.doesNotMatch(h.JE.tagStyles.buildCss(model, ''), /^#/, 'an empty scope styles the page');
});

test('an empty model removes the stylesheet', async t => {
  let model = { genre: c('rgba(1, 1, 1, 1)', null, null) };
  const h = setup(t, { respond: () => model });
  await h.JE.initializeTagStyles();
  assert.notEqual(h.css(), '');
  model = { quality: {}, age: [], rating: {}, status: {} };
  await h.JE.initializeTagStyles();
  assert.equal(h.document.getElementById('je-tag-style-overrides'), null);
});

test('the user preset is sent only while the admin allows it, and the latest answer wins', async t => {
  const answers = [];
  const h = setup(t, {
    pluginConfig: { TagStylesAllowUserPreset: true },
    currentSettings: { tagStylePreset: 'light' },
    respond: () => { const d = deferred(); answers.push(d); return d.promise; }
  });
  const first = h.JE.initializeTagStyles();
  h.JE.currentSettings.tagStylePreset = 'mono';
  const second = h.JE.initializeTagStyles();
  assert.deepEqual(h.requests, ['http://jellyfin.test/JellyfinEnhanced/tag-styles?preset=light', 'http://jellyfin.test/JellyfinEnhanced/tag-styles?preset=mono']);
  answers[1].resolve({ genre: c('rgba(2, 2, 2, 1)', null, null) });
  await second;
  answers[0].resolve({ genre: c('rgba(1, 1, 1, 1)', null, null) });
  await first;
  assert.match(h.css(), /rgba\(2, 2, 2, 1\)/, 'a slower earlier answer cannot overwrite the newer preset');

  h.JE.pluginConfig.TagStylesAllowUserPreset = false;
  h.JE.initializeTagStyles();
  h.JE.currentSettings.tagStylePreset = 'neon';
  h.JE.pluginConfig.TagStylesAllowUserPreset = true;
  h.JE.initializeTagStyles();
  assert.deepEqual(h.requests.slice(2), ['http://jellyfin.test/JellyfinEnhanced/tag-styles', 'http://jellyfin.test/JellyfinEnhanced/tag-styles']);
  answers[2].resolve({}); answers[3].resolve({});
});

test('an answer that arrives after the styles were deactivated injects nothing', async t => {
  const answers = [];
  const h = setup(t, { respond: () => { const d = deferred(); answers.push(d); return d.promise; } });
  const first = h.JE.initializeTagStyles();
  answers[0].resolve({ genre: c('rgba(1, 1, 1, 1)', null, null) });
  await first;
  assert.notEqual(h.css(), '');

  // Admin turns web styles off while a refresh is on its way (the next user-data-loaded sees it).
  const stale = h.JE.initializeTagStyles();
  h.JE.pluginConfig.TagStyleWebActive = false;
  h.document.dispatchEvent(new h.window.CustomEvent('je:user-data-loaded', { detail: {} }));
  assert.equal(h.document.getElementById('je-tag-style-overrides'), null, 'removed synchronously');
  answers[1].resolve({ genre: c('rgba(2, 2, 2, 1)', null, null) });
  await stale;
  assert.equal(h.document.getElementById('je-tag-style-overrides'), null, 'the earlier answer is dropped');

  // A direct call while inactive deactivates too, and its stale peers stay dropped.
  h.JE.pluginConfig.TagStyleWebActive = true;
  const again = h.JE.initializeTagStyles();
  h.JE.pluginConfig.TagStyleWebActive = false;
  await h.JE.initializeTagStyles();
  answers[2].resolve({ genre: c('rgba(3, 3, 3, 1)', null, null) });
  await again;
  assert.equal(h.document.getElementById('je-tag-style-overrides'), null);
  assert.equal(h.requests.length, 3, 'an inactive call fetches nothing');
});

test('a user switch removes the styles at once and drops the previous user\'s answer', async t => {
  const answers = [];
  const h = setup(t, {
    withSession: true,
    pluginConfig: { TagStylesAllowUserPreset: true },
    currentSettings: { tagStylePreset: 'glass' },
    respond: () => { const d = deferred(); answers.push(d); return d.promise; }
  });
  const first = h.JE.initializeTagStyles();
  answers[0].resolve({ genre: c('rgba(1, 1, 1, 1)', null, null) });
  await first;
  assert.notEqual(h.css(), '');

  // user-a's preset change is still on its way when user-b signs in.
  const stale = h.JE.initializeTagStyles();
  h.window.ApiClient.getCurrentUserId = () => 'user-b';
  h.JE.session.checkNow('regression-user-switch');
  assert.equal(h.document.getElementById('je-tag-style-overrides'), null, 'removed in the reset, before any reload');
  answers[1].resolve({ genre: c('rgba(9, 9, 9, 1)', null, null) });
  await stale;
  assert.equal(h.document.getElementById('je-tag-style-overrides'), null, 'user-a\'s answer is dropped');

  // user-b's own styles still apply once their data is loaded.
  h.JE.currentSettings = { tagStylePreset: 'dark' };
  h.document.dispatchEvent(new h.window.CustomEvent('je:user-data-loaded', { detail: {} }));
  answers[2].resolve({ genre: c('rgba(2, 2, 2, 1)', null, null) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.requests.at(-1), 'http://jellyfin.test/JellyfinEnhanced/tag-styles?preset=dark');
  assert.match(h.css(), /rgba\(2, 2, 2, 1\)/);
});

test('a user switch re-applies the incoming user\'s preset', async t => {
  const h = setup(t, { pluginConfig: { TagStylesAllowUserPreset: true }, currentSettings: { tagStylePreset: 'glass' }, respond: () => ({}) });
  await h.JE.initializeTagStyles();
  h.JE.currentSettings = { tagStylePreset: 'dark' };
  h.document.dispatchEvent(new h.window.CustomEvent('je:user-data-loaded', { detail: {} }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.requests.at(-1), 'http://jellyfin.test/JellyfinEnhanced/tag-styles?preset=dark');
});

test('the Media Tags hub preset tiles save the choice and re-apply the styles', async t => {
  const writes = [], toasts = [];
  const h = createHarness({
    html: toggles.map(id => `<input type="checkbox" id="${id}">`).join('') + '<input id="pauseScreenDelayInput"><button id="releaseNotesBtn"></button>'
      + '<div id="jeTagPresetChoice" role="radiogroup"><input type="radio" name="jeTagPreset" value=""><input type="radio" name="jeTagPreset" value="mono"></div>',
    JE: { pluginConfig: { TagStylesAllowUserPreset: true }, userConfig: { settings: {}, shortcuts: { Shortcuts: [] } }, currentSettings: {}, t: key => key, toast: m => toasts.push(m) },
    apiClient: { ajax: async request => { writes.push(request); } }
  });
  t.after(() => h.close());
  h.load('core/ui-kit.js'); h.load('core/tag-renderer-base.js'); h.load('core/tag-layout.js');
  h.load('tags/rating-sources.js'); h.load('enhanced/config.js'); h.JE.currentSettings = h.JE.loadSettings();
  assert.equal(h.JE.currentSettings.tagStylePreset, null, 'no preset of their own: follow the admin');
  h.JE.toast = m => toasts.push(m);
  let applied = 0; h.JE.initializeTagStyles = () => { applied++; };
  h.load('enhanced/settingspanel/ui-panel-settings.js');
  const ctx = { createToast: () => '', resetAutoCloseTimer() {}, help: h.document.body, primaryAccentColor: '#fff' };
  h.JE.internals.enhancedUi.wireSettingsListeners(ctx);
  const pick = value => {
    const tile = h.document.querySelector(`input[name="jeTagPreset"][value="${value}"]`);
    tile.checked = true;
    tile.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  };
  pick('mono');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.parse(writes.at(-1).data).tagStylePreset, 'mono');
  assert.equal(applied, 1);
  assert.equal(toasts.at(-1), 'toast_tag_style_preset_updated');
  pick('');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.parse(writes.at(-1).data).tagStylePreset, null, 'back to the admin\'s preset');
  assert.equal(applied, 2);
});


test('Poster includes Awards and lets explicit Award colours override sampled fields', t => {
  const h = setup(t);
  const css = h.JE.tagStyles.buildCss({ preset: 'poster', awards: { oscar: c('rgba(0, 0, 255, 1)', null, 'rgba(0, 255, 0, 1)') } });
  const sampled = css.indexOf('[data-je-poster-colour] .awards-overlay-container .awards-tag');
  const own = css.indexOf('.awards-overlay-container .awards-tag[data-je-award="oscar"]');
  assert.ok(sampled >= 0 && own > sampled);
  assert.match(css.slice(sampled, own), /background: var\(--je-tag-bg\) !important/);
  assert.match(css.slice(own), /background: rgba\(0, 0, 255, 1\) !important;color: rgba\(0, 255, 0, 1\) !important/);
});

test('Poster and explicit Tier 2 colours leave the admin preview to its scoped stylesheet', t => {
  const h = setup(t);
  const chips = '<div data-je-poster-colour><div class="awards-overlay-container"><span class="awards-tag" data-je-award="oscar"></span></div><div class="logo-overlay-container"><span class="je-logo-chip" data-je-logo-style="company"></span></div><div class="custom-overlay-container"><span class="custom-tag" data-je-custom="Remaster"></span></div></div>';
  h.document.body.innerHTML = `<div id="ordinary">${chips}</div><div id="adminPreview" data-je-tag-styles-scope>${chips}</div>`;
  const model = { preset: 'poster', awards: { oscar: c('rgba(1, 2, 3, 1)', null, null) }, logos: { company: c('rgba(1, 2, 3, 1)', null, null) }, custom: { Remaster: c('rgba(1, 2, 3, 1)', null, null) } };
  for (const rule of h.JE.tagStyles.buildCss(model).split('\n')) {
    const selector = rule.slice(0, rule.indexOf(' {'));
    assert.equal(h.document.querySelector('#adminPreview').querySelectorAll(selector).length, 0, selector);
  }
  const ordinary = h.JE.tagStyles.buildCss(model).split('\n').filter(r => /awards-tag|je-logo-chip|custom-tag/.test(r));
  assert.equal(ordinary.length, 6, 'both sampled and explicit colours for all three groups');
  for (const rule of ordinary) assert.equal(h.document.querySelectorAll(rule.slice(0, rule.indexOf(' {'))).length, 1);
  for (const rule of h.JE.tagStyles.buildCss(model, '#adminPreview').split('\n').filter(r => /awards-tag|je-logo-chip|custom-tag/.test(r))) {
    const matches = h.document.querySelectorAll(rule.slice(0, rule.indexOf(' {')));
    assert.equal(matches.length, 1);
    assert.ok(matches[0].closest('#adminPreview'));
  }
});

test('a preset per group: only the groups under Poster get the artwork rules, and the whole design gets all of them', async t => {
  const h = setup(t, { respond: () => ({}) });
  const model = { quality: { '*': c('rgba(1, 1, 1, 1)', null, null) } };
  const some = h.JE.tagStyles.buildCss({ ...model, preset: 'glass', posterGroups: ['status'] });
  assert.match(some, /\[data-je-poster-colour\] \.status-overlay-container \.status-tag/, 'Status takes the artwork colours');
  assert.doesNotMatch(some, /\[data-je-poster-colour\] \.quality-overlay-container/, 'Quality does not');
  assert.doesNotMatch(some, /\.je-tag-pill/, 'the +N pill follows the whole design only');
  const none = h.JE.tagStyles.buildCss({ ...model, preset: 'glass', posterGroups: [] });
  assert.doesNotMatch(none, /data-je-poster-colour/);
  const all = h.JE.tagStyles.buildCss({ ...model, preset: 'poster', posterGroups: ['quality', 'status'] });
  assert.match(all, /\[data-je-poster-colour\] \.quality-overlay-container/);
  assert.match(all, /\.je-tag-pill/);
});

test('every status badge the server sends is styled, and an id that is not a plain word never reaches the sheet', async t => {
  const h = setup(t, { respond: () => ({}) });
  const css = h.JE.tagStyles.buildCss({ status: { added: c('rgba(1, 2, 3, 1)', null, null), seasonFinale: c('rgba(4, 5, 6, 1)', null, null), 'x"]{}': c('rgba(7, 8, 9, 1)', null, null) } });
  assert.match(css, /\.status-tag\[data-je-status="added"\]/);
  assert.match(css, /\.status-tag\[data-je-status="seasonFinale"\][^}]*rgba\(4, 5, 6, 1\)/, 'a badge outside the first five is styled too');
  assert.doesNotMatch(css, /7, 8, 9/);
});
