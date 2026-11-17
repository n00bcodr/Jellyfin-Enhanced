// The Elsewhere custom branding icon on the administrator page (upstream c8625921): an upload slot beside the URL
// setting, the slot's accepted types, the server's reason when an upload is refused, and a warning when the URL
// cannot be loaded by a browser. Driven through the generated page, as the dashboard runs it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootGenerated, settle } from '../../helpers/admin-config-page.mjs';

const ICON_TYPES = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml';
const SLOTS = ['icon-transparent.png', 'banner-light.png', 'banner-dark.png', 'favicon.ico', 'apple-touch-icon.png', 'elsewhere-icon.png'];
const debounce = () => new Promise(resolve => setTimeout(resolve, 600));

/**
 * The page with its branding requests answered here. `stored` lists the slots that hold an image; `loads` decides
 * whether a browser could load an address (the URL check's Image). Every request and every image load is recorded.
 */
async function boot(t, { saved = {}, stored = [], loads = () => false, upload } = {}) {
  const h = bootGenerated({ engine: 'hold', saved });
  t.after(() => h.close());
  const requests = [];
  const images = [];
  const answer = (status, body = '') => ({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body), text: async () => body, blob: async () => new h.window.Blob(['x']) });
  h.window.fetch = async (url, init = {}) => {
    url = String(url);
    requests.push({ url, method: init.method || 'GET', body: init.body });
    if (url.includes('/JellyfinEnhanced/BrandingStatus')) return answer(200, JSON.stringify(Object.fromEntries(SLOTS.map(s => [s, stored.includes(s)]))));
    if (url.includes('/JellyfinEnhanced/BrandingImage')) {
      const name = new URL(url).searchParams.get('fileName');
      return stored.includes(name) ? answer(200) : answer(404);
    }
    if (url.includes('/JellyfinEnhanced/UploadBrandingImage')) return upload ? upload(init.body) : answer(200, '"File uploaded successfully"');
    return answer(200, '{}');
  };
  h.window.URL.createObjectURL = () => 'blob:preview';
  h.window.URL.revokeObjectURL = () => {};
  h.window.Image = class {
    set src(value) {
      this._src = value;
      images.push(value);
      h.window.setTimeout(() => (loads(value) ? this.onload : this.onerror)?.call(this), 0);
    }
    get src() { return this._src; }
  };
  h.held.release();
  await h.ready();
  h.show();
  await settle(h.window);
  const $ = id => h.document.getElementById(id);
  return { h, requests, images, $, uploads: () => requests.filter(r => r.url.includes('/UploadBrandingImage')) };
}

const elsewhereOn = { ElsewhereEnabled: true, ElsewhereCustomBrandingText: 'Only on My Server' };
const file = (h, name, type) => new h.window.File(['x'], name, { type });
function drop(h, zone, dropped) {
  const event = new h.window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: [dropped] } });
  zone.dispatchEvent(event);
}

test('Elsewhere icon: the Custom Branding group has its own upload slot, read with the other slots\' status', async t => {
  const { $, requests, h } = await boot(t);
  const zone = $('elsewhereIconDropZone');
  assert.ok(zone, 'the upload slot exists');
  assert.ok($('ElsewhereCustomBrandingImageUrl').closest('[data-je-tab], fieldset, section').contains(zone), 'next to the icon URL setting');
  assert.equal($('elsewhereIconInput').getAttribute('accept'), ICON_TYPES);
  assert.equal($('elsewhereIconPlaceholder').style.display, 'block', 'nothing stored: the placeholder shows');
  assert.equal(requests.filter(r => r.url.includes('/BrandingStatus')).length, 1, 'one status request for every slot');
  assert.equal(requests.filter(r => r.url.includes('/BrandingImage')).length, 0, 'known-empty slots are not probed');
  assert.ok(h.document.getElementById('je-elsewhere-icon-warning'), 'the URL warning has its place');
});

test('Elsewhere icon: a picked icon is uploaded to the elsewhere-icon.png slot', async t => {
  const { $, uploads, h } = await boot(t);
  const input = $('elsewhereIconInput');
  Object.defineProperty(input, 'files', { value: [file(h, 'logo.svg', 'image/svg+xml')] });
  input.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await settle(h.window);
  assert.equal(uploads().length, 1);
  assert.equal(uploads()[0].body.get('fileName'), 'elsewhere-icon.png');
  assert.equal(uploads()[0].body.get('file').name, 'elsewhere-icon.png');
  assert.equal($('elsewhereIconStatus').textContent, '✓ Uploaded');
});

test('Elsewhere icon: a dropped file of a type the slot does not take is refused before any request; other slots are unchanged', async t => {
  const { $, uploads, h } = await boot(t);
  drop(h, $('elsewhereIconDropZone'), file(h, 'logo.bmp', 'image/bmp'));
  await settle(h.window);
  assert.equal(uploads().length, 0);
  assert.equal($('elsewhereIconStatus').textContent, '✗ Use a PNG, JPG, GIF, WebP or SVG image');
  drop(h, $('faviconDropZone'), file(h, 'favicon.bmp', 'image/bmp'));
  await settle(h.window);
  assert.equal(uploads().length, 1, 'a slot that takes any image still does');
});

test('Branding uploads: a refused upload shows the server\'s reason without its JSON quoting, then what is stored', async t => {
  const reason = 'The Elsewhere icon file isn\'t a readable PNG, JPEG, GIF, WebP or SVG image';
  const { $, requests, h } = await boot(t, { stored: ['favicon.ico'], upload: async () => ({ ok: false, status: 400, text: async () => JSON.stringify(reason) }) });
  const before = requests.filter(r => r.url.includes('/BrandingImage')).length;
  drop(h, $('faviconDropZone'), file(h, 'favicon.png', 'image/png'));
  await settle(h.window);
  assert.equal($('faviconStatus').textContent, '✗ ' + reason);
  assert.equal(requests.filter(r => r.url.includes('/BrandingImage')).length, before + 1, 'the preview is read again, not left on the refused file');
  assert.equal($('faviconPreview').style.display, 'block');
});

test('Elsewhere icon URL: one a browser cannot load is flagged under the field, and a server path is named as such', async t => {
  const { $, images } = await boot(t, { saved: { ...elsewhereOn, ElsewhereCustomBrandingImageUrl: '/config/data/logo.png' } });
  await debounce();
  const warning = $('je-elsewhere-icon-warning');
  assert.notEqual(warning.style.display, 'none');
  assert.match(warning.textContent, /^This icon can't be loaded\. It looks like a file path on the server\. Viewers' browsers load the icon over the web/);
  assert.deepEqual(images, ['/config/data/logo.png'], 'tested once, as written');
});

test('Elsewhere icon URL: a path to Jellyfin\'s own routes is tested through ApiClient, and a working one shows no warning', async t => {
  const { $, images, h } = await boot(t, { saved: { ...elsewhereOn, ElsewhereCustomBrandingImageUrl: '/web/missing.png' }, loads: url => url.startsWith('https://') });
  await debounce();
  assert.deepEqual(images, ['http://jf.test/web/missing.png']);
  const warning = $('je-elsewhere-icon-warning');
  assert.notEqual(warning.style.display, 'none');
  assert.doesNotMatch(warning.textContent, /file path/);
  const field = $('ElsewhereCustomBrandingImageUrl');
  field.value = 'https://example.com/logo.png';
  field.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  await debounce();
  assert.equal(warning.style.display, 'none', 'a URL that loads clears the warning');
});

test('Elsewhere icon URL: no check while an icon is uploaded, Elsewhere is off, or there is no message', async t => {
  for (const [what, options] of [
    ['an uploaded icon', { stored: ['elsewhere-icon.png'], saved: { ...elsewhereOn, ElsewhereCustomBrandingImageUrl: '/config/logo.png' } }],
    ['Elsewhere off', { saved: { ...elsewhereOn, ElsewhereEnabled: false, ElsewhereCustomBrandingImageUrl: '/config/logo.png' } }],
    ['no message', { saved: { ...elsewhereOn, ElsewhereCustomBrandingText: '', ElsewhereCustomBrandingImageUrl: '/config/logo.png' } }],
  ]) {
    const { $, images } = await boot(t, options);
    await debounce();
    assert.equal($('je-elsewhere-icon-warning').style.display, 'none', what);
    assert.deepEqual(images.filter(src => src.includes('logo.png')), [], what + ': the URL is not loaded');
  }
});
