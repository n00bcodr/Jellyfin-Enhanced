import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

const remote = 'https://requests.example.test';
const local = 'https://seerr.homelab';
const mappings = `https://watch.example.test|${remote}\nhttps://jellyfin.homelab|${local}`;
const moduleName = 'jellyseerr/seerr-iframe-mapping.js';

function setup(t, { html = '', config = {}, address = 'https://jellyfin.homelab', apiClient = {} } = {}) {
  const resets = new Map();
  const h = createHarness({ html, apiClient: { serverAddress: () => address, ...apiClient }, JE: {
    pluginConfig: { JellyseerrEnabled: true, JellyseerrBaseUrl: remote, JellyseerrUrlMappings: mappings, ...config },
    session: { onUserChange: (name, callback) => { resets.set(name, callback); return () => resets.delete(name); } }
  }});
  t.after(() => h.close());
  h.load('core/dom-observer.js');
  h.load('core/lifecycle.js');
  h.load('jellyseerr/api.js');
  h.load(moduleName);
  return {
    ...h,
    frame: () => h.document.querySelector('iframe'),
    changeUser() { resets.get('seerr-iframe-mapping')(); },
    refresh() { h.document.dispatchEvent(new h.window.CustomEvent('je:user-data-loaded')); },
    async flush() { await Promise.resolve(); await Promise.resolve(); }
  };
}

function appendFrame(h, src) {
  const frame = h.document.createElement('iframe');
  if (src !== undefined) frame.src = src;
  h.document.body.append(frame);
  return frame;
}

test('existing custom iframe follows local mapping and preserves deep link, query and hash', t => {
  const h = setup(t, { html: `<div class="sections"><iframe class="requestIframe" src="${remote}/movie/42?language=he%2DIL#Cast"></iframe></div>` });
  assert.equal(h.frame().src, `${local}/movie/42?language=he%2DIL#Cast`);
});

test('public mapping is used when accessing the public Jellyfin address', t => {
  const h = setup(t, { address: 'https://watch.example.test', html: `<iframe src="${local}/tv/42"></iframe>` });
  assert.equal(h.frame().src, `${remote}/tv/42`);
});

test('unmatched client uses the existing resolver fallback', t => {
  const h = setup(t, { address: 'https://other.example.test', html: `<iframe src="${local}/"></iframe>` });
  assert.equal(h.frame().src, `${remote}/`);
});

test('resolver keeps case/trailing-slash normalization and first matching line', t => {
  const h = setup(t, { address: 'https://JELLYFIN.HOMELAB///', config: {
    JellyseerrUrlMappings: `\nmissing delimiter\n|${remote}\nhttps://jellyfin.homelab|${local}/\nhttps://jellyfin.homelab|https://ignored.test`
  }, html: `<iframe src="${remote}/"></iframe>` });
  assert.equal(h.frame().src, `${local}/`);
});

test('uses browser origin when ApiClient has no serverAddress', t => {
  const h = setup(t, { apiClient: { serverAddress: undefined }, config: {
    JellyseerrUrlMappings: `http://jellyfin.test|${local}`
  }, html: `<iframe src="${remote}/"></iframe>` });
  assert.equal(h.frame().src, `${local}/`);
});

test('lazy mounted nested iframe, empty src then assignment, and later src changes are mapped', async t => {
  const h = setup(t);
  const wrapper = h.document.createElement('section');
  wrapper.innerHTML = `<div><iframe src="${remote}/tv/1"></iframe></div>`;
  h.document.body.append(wrapper);
  const empty = appendFrame(h);
  await h.flush();
  assert.equal(wrapper.querySelector('iframe').src, `${local}/tv/1`);
  empty.src = `${remote}/movie/2`;
  await h.flush();
  assert.equal(empty.src, `${local}/movie/2`);
  empty.src = `${remote}/movie/3`;
  await h.flush();
  assert.equal(empty.src, `${local}/movie/3`);
});

test('already-correct iframe is not reassigned or reloaded on unrelated mutations', async t => {
  const h = setup(t);
  const frame = appendFrame(h, `${local}/movie/42`);
  let changes = 0;
  const observer = new h.window.MutationObserver(records => { changes += records.length; });
  observer.observe(frame, { attributes: true, attributeFilter: ['src'] });
  await h.flush();
  h.document.body.append(h.document.createElement('div'));
  await h.flush();
  assert.equal(changes, 0);
  observer.disconnect();
});

test('source and destination base paths are replaced, not duplicated, most-specific first', async t => {
  const h = setup(t, { config: {
    JellyseerrBaseUrl: `${remote}////////`,
    JellyseerrUrlMappings: `https://watch.example.test|${remote}/Seerr/\nhttps://jellyfin.homelab|${local}/Requests/`
  }, html: `<iframe src="${remote}/Seerr/movie/42?query=a%2Fb#Cast"></iframe>` });
  assert.equal(h.frame().src, `${local}/Requests/movie/42?query=a%2Fb#Cast`);
  const root = appendFrame(h, `${remote}/Seerr`);
  await h.flush();
  assert.equal(root.src, `${local}/Requests`);
  await h.flush();
  assert.equal(h.frame().src, `${local}/Requests/movie/42?query=a%2Fb#Cast`);
});

test('same-origin source and destination paths do not cause a remapping loop', async t => {
  const h = setup(t, { config: {
    JellyseerrUrlMappings: `https://watch.example.test|${remote}\nhttps://jellyfin.homelab|${remote}/seerr`
  }, html: `<iframe src="${remote}/movie/42"></iframe>` });
  assert.equal(h.frame().src, `${remote}/seerr/movie/42`);
  await h.flush();
  assert.equal(h.frame().src, `${remote}/seerr/movie/42`);
});

for (const src of [
  'https://unrelated.example.test/seerr/movie/42',
  'https://requests.example.test.evil.test/seerr/movie/42',
  'https://requests.example.test:8443/seerr/movie/42',
  'https://requests.example.test/seerr-other/movie/42',
  'https://requests.example.test/SEERR/movie/42',
  'http://requests.example.test/seerr/movie/42',
  'https://user:password@requests.example.test/seerr/movie/42',
  'about:blank', 'data:text/html,hello', 'javascript:void(0)'
]) test(`unrelated or unsafe iframe is untouched: ${src}`, t => {
  const h = setup(t, { config: {
    JellyseerrBaseUrl: `${remote}/seerr`,
    JellyseerrUrlMappings: `https://watch.example.test|${remote}/seerr\nhttps://jellyfin.homelab|${local}`
  }, html: `<iframe src="${src}"></iframe>` });
  assert.equal(h.frame().getAttribute('src'), src);
});

test('srcdoc frames are left alone until srcdoc is removed', async t => {
  const h = setup(t, { html: `<iframe src="${remote}/movie/42" srcdoc="Inline content"></iframe>` });
  assert.equal(h.frame().src, `${remote}/movie/42`);
  h.frame().removeAttribute('srcdoc');
  await h.flush();
  assert.equal(h.frame().src, `${local}/movie/42`);
});

for (const config of [
  { JellyseerrEnabled: false },
  { JellyseerrUrlMappings: '' },
  { JellyseerrUrlMappings: '  \n ' },
  { JellyseerrBaseUrl: '', JellyseerrUrlMappings: 'invalid line' },
  { JellyseerrUrlMappings: 'https://jellyfin.homelab|javascript:alert(1)' },
  { JellyseerrUrlMappings: 'https://jellyfin.homelab|not-an-absolute-url' },
  { JellyseerrUrlMappings: 'https://jellyfin.homelab|https://user:password@seerr.homelab' },
  { JellyseerrUrlMappings: 'https://jellyfin.homelab|https://seerr.homelab/?token=secret' }
]) test(`disabled or invalid mapping does not rewrite or install observers: ${JSON.stringify(config)}`, t => {
  const h = setup(t, { config, html: `<iframe src="${remote}/"></iframe>` });
  assert.equal(h.frame().src, `${remote}/`);
  assert.equal(h.JE.core.dom.getBodySubscriberCount(), 0);
});

test('detached iframe stops being observed and a replacement is mapped', async t => {
  const h = setup(t, { html: `<iframe src="${remote}/"></iframe>` });
  const old = h.frame();
  old.remove();
  const replacement = appendFrame(h, `${remote}/tv/2`);
  await h.flush();
  old.src = `${remote}/movie/1`;
  await h.flush();
  assert.equal(old.src, `${remote}/movie/1`);
  assert.equal(replacement.src, `${local}/tv/2`);
});

test('identity reset stops mapping until fresh data arrives; repeated refreshes keep one subscription', async t => {
  const h = setup(t, { html: `<iframe src="${remote}/"></iframe>` });
  h.changeUser();
  assert.equal(h.JE.core.dom.getBodySubscriberCount(), 0);
  h.frame().src = `${remote}/movie/1`;
  await h.flush();
  assert.equal(h.frame().src, `${remote}/movie/1`);
  h.refresh(); h.refresh();
  assert.equal(h.frame().src, `${local}/movie/1`);
  assert.equal(h.JE.core.dom.getBodySubscriberCount(), 1);
  h.JE.pluginConfig.JellyseerrEnabled = false;
  h.refresh();
  assert.equal(h.JE.core.dom.getBodySubscriberCount(), 0);
});

test('lifecycle teardown disconnects body and per-frame observers', async t => {
  const h = setup(t, { html: `<iframe src="${remote}/"></iframe>` });
  h.JE.core.lifecycle.get('seerr-iframe-mapping').teardown();
  assert.equal(h.JE.core.dom.getBodySubscriberCount(), 0);
  h.frame().src = `${remote}/movie/42`;
  await h.flush();
  assert.equal(h.frame().src, `${remote}/movie/42`);
  h.refresh();
  await h.flush();
  assert.equal(h.JE.core.dom.getBodySubscriberCount(), 0);
});
