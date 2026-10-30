import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

const STORE = 'JE_panelSize_user-a';

/**
 * The real panel host (ui-panel.js) and the real size module around a small
 * panel frame built with the module's own header controls and handles; the
 * other sections are stubbed. jsdom has no layout, so the panel's box is
 * computed from its inline style (and box model) the way a browser would, and the window
 * size and the 900px media query are driven by the test.
 * @param {import('node:test').TestContext} t
 * @param {{width?: number, height?: number, stored?: string|null, storage?: object}} [options]
 */
function setup(t, { width = 1400, height = 900, stored = null, storage } = {}) {
  const queries = [];
  const view = { width, height };
  const matchMedia = (query) => {
    const listeners = new Set();
    const mql = {
      query,
      get matches() { const min = /min-width:\s*(\d+)px/.exec(query); const max = /max-width:\s*(\d+)px/.exec(query); return min ? view.width >= +min[1] : max ? view.width <= +max[1] : false; },
      addEventListener: (type, fn) => listeners.add(fn),
      removeEventListener: (type, fn) => listeners.delete(fn),
      fire: () => listeners.forEach(fn => fn({ matches: mql.matches })),
      listeners,
    };
    queries.push(mql);
    return mql;
  };
  const h = createHarness({
    html: '<button id="opener">open</button>',
    JE: {
      pluginConfig: { HelpPanelAutocloseDelay: 60000 },
      userConfig: { settings: {}, shortcuts: { Shortcuts: [] } },
      currentSettings: {},
      t: (key, params) => key === 'panel_size_status' ? `Panel size ${params.width} × ${params.height}` : key === 'panel_size_maximum' ? 'Maximum size reached' : key,
      keyListener() {}, initializeShortcuts() {}, state: { activeShortcuts: { x: 1 } },
      themer: { getThemeVariables: () => ({ panelBg: '#000', secondaryBg: '#111', primaryAccent: '#0af', altAccent: '#222', blur: '0px', textColor: '#fff', logo: '' }) },
    },
    apiClient: { ajax: async () => null },
    globals: { matchMedia },
  });
  t.after(() => h.close());
  const { window } = h;
  const setView = (w, hgt) => {
    view.width = w; view.height = hgt;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: hgt });
  };
  setView(width, height);
  if (storage) Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  else if (stored !== null) window.localStorage.setItem(STORE, stored);

  // The panel's box from its inline style: px, or the built-in min(…) default.
  const length = (value, viewport) => {
    if (value.endsWith('px')) return parseFloat(value);
    const m = /^min\((\d+)px, (\d+)v[wh]\)$/.exec(value);
    if (m) return Math.min(+m[1], viewport * m[2] / 100);
    throw new Error(`unexpected length ${value}`);
  };
  window.Element.prototype.getClientRects = function () { return [{ width: 1, height: 1 }]; };
  const baseRect = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = function () {
    if (this.id !== 'jellyfin-enhanced-panel') return baseRect.call(this);
    // The panel has a 1px border: a content-box size measures 2px larger.
    const border = this.style.boxSizing === 'border-box' ? 0 : 2;
    const w = length(this.style.width, view.width) + border, hh = length(this.style.height, view.height) + border;
    const moved = this.style.transform === 'none';
    const left = moved ? parseFloat(this.style.left) : (view.width - w) / 2;
    const top = moved ? parseFloat(this.style.top) : (view.height - hh) / 2;
    return { left, top, width: w, height: hh, right: left + w, bottom: top + hh, x: left, y: top };
  };

  for (const file of ['core/ui-kit.js', 'enhanced/config.js']) h.load(file);
  h.JE.currentSettings = h.JE.loadSettings();
  h.JE.escapeHtml = h.JE.core.ui.escapeHtml;
  h.load('enhanced/settingspanel/ui-panel-resize.js');
  const ui = h.JE.internals.enhancedUi;
  ui.buildPanelHtml = () => `<div class="panel-header"><div id="jePanelTitle">JE</div>${ui.buildPanelSizeControlsHtml()}<button id="closeSettingsPanel">x</button></div>`
    + '<div class="je-panel-body"><nav class="je-panel-nav"><input id="jePanelSearch" type="search"><ul id="jePanelSearchResults" hidden></ul><div class="je-panel-nav-items"></div></nav>'
    + '<div class="je-panel-main"><button id="jePanelBack"></button><section class="je-pane" data-pane="ui"><h3 class="je-pane-title">UI</h3><input type="checkbox" id="someToggle"></section></div></div>'
    + `<div class="panel-footer">footer</div>${ui.buildPanelResizeHandlesHtml()}`;
  for (const name of ['wireShortcutEditor', 'wireSettingsListeners', 'wireHiddenContentListeners', 'wireMiscSettingsControls', 'wireTagGroupEditor', 'wireLanguageControls']) ui[name] = () => {};
  h.load('enhanced/settingspanel/ui-panel.js');

  const $ = selector => h.document.querySelector(selector);
  const panel = () => $('#jellyfin-enhanced-panel');
  /** Synthetic pointer event (jsdom has no PointerEvent). */
  const pointer = (el, type, x, y, init = {}) => {
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...init });
    Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 });
    el.dispatchEvent(event);
    return event;
  };
  return {
    ...h, $, panel, queries,
    async open() { await h.JE.showEnhancedPanel(); },
    close() { $('#closeSettingsPanel').click(); },
    size: () => { const r = panel().getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; },
    stored: () => window.localStorage.getItem(STORE),
    pressed: () => Array.from(h.document.querySelectorAll('[data-je-panel-size]')).filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.jePanelSize),
    preset: name => $(`[data-je-panel-size="${name}"]`),
    reset: () => $('[data-je-panel-size-reset]'),
    grip: () => $('.je-panel-grip'),
    edge: axis => $(`.je-panel-edge--${axis}`),
    key(el, key, init = {}) { el.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); },
    drag(handle, dx, dy, from = [1000, 800]) {
      pointer(handle, 'pointerdown', from[0], from[1]);
      pointer(handle, 'pointermove', from[0] + dx / 2, from[1] + dy / 2);
      pointer(handle, 'pointermove', from[0] + dx, from[1] + dy);
      pointer(handle, 'pointerup', from[0] + dx, from[1] + dy);
    },
    pointer,
    resizeWindow(w, hgt) {
      const wasWide = view.width >= 900;
      setView(w, hgt);
      if (wasWide !== (w >= 900)) queries.filter(q => q.query.includes('900px')).forEach(q => q.fire());
      window.dispatchEvent(new window.Event('resize'));
    },
  };
}

test('desktop: the size group, presets and grip show; nothing stored means the built-in size', async t => {
  const h = setup(t);
  await h.open();
  const group = h.$('.je-panel-size');
  assert.equal(group.hidden, false);
  assert.equal(group.getAttribute('role'), 'group');
  assert.equal(group.getAttribute('aria-label'), 'panel_size_label');
  assert.deepEqual(Array.from(group.querySelectorAll('button'), b => b.tagName + ':' + b.type), ['BUTTON:button', 'BUTTON:button', 'BUTTON:button', 'BUTTON:button']);
  assert.deepEqual(h.pressed(), ['default']);
  assert.equal(h.reset().hidden, true, 'Reset size only once a dragged size is stored');
  assert.equal(h.grip().hidden, false);
  assert.equal(h.grip().getAttribute('aria-label'), 'panel_size_grip');
  assert.equal(h.edge('x'), null, 'no resize zone over the scrollbar');
  assert.equal(h.edge('y').hidden, false);
  assert.equal(h.panel().style.width, 'min(1040px, 94vw)');
  assert.equal(h.panel().style.height, 'min(720px, 90vh)');
  assert.deepEqual(h.size(), [1042, 722]);
  assert.equal(h.stored(), null);
});

for (const [w, hgt, large, fill] of [[1400, 900, [1260, 810], [1352, 852]], [1920, 1080, [1728, 972], [1872, 1032]]]) {
  test(`at ${w}×${hgt} Large is 90% of the window and Fill the window minus 24px a side; each is stored per user`, async t => {
    const h = setup(t, { width: w, height: hgt });
    await h.open();
    h.preset('large').click();
    assert.deepEqual(h.size(), large);
    assert.deepEqual(h.pressed(), ['large']);
    assert.equal(h.stored(), '{"preset":"large"}');
    assert.equal(h.panel().style.maxWidth, 'calc(100vw - 48px)', 'the built-in 94vw cap no longer limits Fill');
    h.preset('fill').click();
    assert.deepEqual(h.size(), fill);
    assert.deepEqual(h.pressed(), ['fill']);
    assert.equal(h.stored(), '{"preset":"fill"}');
    h.preset('default').click();
    assert.deepEqual(h.size(), [1042, 722]);
    assert.equal(h.stored(), null, 'Default removes the entry');
  });
}

test('close and reopen restores the chosen size; a preset follows the window it opens in', async t => {
  const h = setup(t);
  await h.open();
  h.preset('fill').click();
  h.close();
  assert.equal(h.panel(), null);
  h.resizeWindow(1920, 1080);
  await h.open();
  assert.deepEqual(h.size(), [1872, 1032]);
  assert.deepEqual(h.pressed(), ['fill']);
});

test('a stored size larger than the window is clamped on open and live on window resize, without rewriting it', async t => {
  const stored = '{"preset":"custom","width":3000,"height":2000}';
  const h = setup(t, { stored });
  await h.open();
  assert.deepEqual(h.size(), [1352, 852]);
  assert.deepEqual(h.pressed(), [], 'no preset is pressed for a dragged size');
  assert.equal(h.reset().hidden, false);
  h.resizeWindow(1000, 700);
  assert.deepEqual(h.size(), [952, 652]);
  h.resizeWindow(1920, 1080);
  assert.deepEqual(h.size(), [1872, 1032], 'the stored size comes back in a larger window');
  assert.equal(h.stored(), stored);
});

test('a stored size below 720×480 opens at the minimum', async t => {
  const h = setup(t, { stored: '{"preset":"custom","width":100,"height":50}' });
  await h.open();
  assert.deepEqual(h.size(), [720, 480]);
});

for (const corrupt of ['not json', '{"preset":"huge"}', '{"preset":"custom","width":"wide","height":600}', '{"preset":"custom","width":-5,"height":600}', 'null', '[]']) {
  test(`a corrupt stored value (${corrupt}) falls back to the built-in size`, async t => {
    const h = setup(t, { stored: corrupt });
    await h.open();
    assert.deepEqual(h.size(), [1042, 722]);
    assert.deepEqual(h.pressed(), ['default']);
    assert.equal(h.reset().hidden, true);
  });
}

test('storage that throws on every access leaves the panel usable at the built-in size', async t => {
  const fail = () => { throw new Error('SecurityError'); };
  const h = setup(t, { storage: { getItem: fail, setItem: fail, removeItem: fail } });
  await h.open();
  assert.deepEqual(h.size(), [1042, 722]);
  h.preset('large').click();
  assert.deepEqual(h.size(), [1260, 810], 'the size still applies for this session');
  h.drag(h.grip(), 20, 20);
  assert.deepEqual(h.size(), [1300, 850]);
  h.close();
  await h.open();
  assert.deepEqual(h.size(), [1042, 722], 'nothing was stored, so the next open is the built-in size');
});

test('dragging the grip grows a centred panel on both sides, stores the size and offers Reset size', async t => {
  const h = setup(t);
  await h.open();
  h.drag(h.grip(), 50, 30);
  assert.deepEqual(h.size(), [1142, 782], 'the corner follows the pointer: twice the distance on a centred panel');
  assert.equal(h.stored(), '{"preset":"custom","width":1142,"height":782}');
  assert.equal(h.panel().style.boxSizing, 'border-box', 'the set size is the measured (border-included) size');
  assert.deepEqual(h.pressed(), []);
  assert.equal(h.reset().hidden, false);
  assert.equal(h.panel().classList.contains('je-panel-resizing'), false);
  h.reset().click();
  assert.deepEqual(h.size(), [1042, 722]);
  assert.equal(h.stored(), null);
  assert.equal(h.panel().style.boxSizing, '', 'Default keeps the built-in box model');
  assert.equal(h.reset().hidden, true);
  assert.equal(h.document.activeElement, h.preset('default'), 'focus stays in the group when Reset hides itself');
});

test('a drag stays inside the bounds and each edge changes only its own dimension', async t => {
  const h = setup(t);
  await h.open();
  h.drag(h.grip(), 2000, 2000);
  assert.deepEqual(h.size(), [1352, 852], 'never past the window minus 24px a side');
  h.drag(h.grip(), -2000, -2000);
  assert.deepEqual(h.size(), [720, 480], 'never under 720×480');
  h.drag(h.grip(), 100, 0);
  assert.deepEqual(h.size(), [920, 480]);
  h.drag(h.edge('y'), 300, 100);
  assert.deepEqual(h.size(), [920, 680]);
  assert.equal(h.stored(), '{"preset":"custom","width":920,"height":680}');
});

test('while dragging, text selection is blocked and the panel carries the resizing state; a click without moving stores nothing', async t => {
  const h = setup(t);
  await h.open();
  const down = h.pointer(h.grip(), 'pointerdown', 10, 10);
  assert.equal(down.defaultPrevented, true);
  assert.equal(h.panel().classList.contains('je-panel-resizing'), true);
  assert.equal(h.panel().dataset.jeResizeAxis, 'both');
  const select = new h.window.Event('selectstart', { bubbles: true, cancelable: true });
  h.document.body.dispatchEvent(select);
  assert.equal(select.defaultPrevented, true);
  h.pointer(h.grip(), 'pointermove', 30, 30, { pointerId: 7 });
  assert.deepEqual(h.size(), [1042, 722], 'another pointer does not resize');
  h.pointer(h.grip(), 'pointercancel', 10, 10);
  assert.equal(h.panel().classList.contains('je-panel-resizing'), false);
  assert.equal(h.stored(), null);
  const after = new h.window.Event('selectstart', { bubbles: true, cancelable: true });
  h.document.body.dispatchEvent(after);
  assert.equal(after.defaultPrevented, false);
  h.pointer(h.grip(), 'pointerdown', 10, 10, { button: 2 });
  assert.equal(h.panel().classList.contains('je-panel-resizing'), false, 'only the primary button resizes');
});

test('a panel moved by its header resizes from its top-left corner and never past the window edge', async t => {
  const h = setup(t);
  await h.open();
  Object.assign(h.panel().style, { left: '200px', top: '60px', transform: 'none' });
  h.drag(h.grip(), 50, 30);
  assert.deepEqual(h.size(), [1092, 752], 'the corner follows the pointer one to one');
  h.drag(h.grip(), 500, 0);
  assert.deepEqual(h.size(), [1176, 752], 'stops at the window minus 24px');
  assert.equal(h.panel().style.left, '200px');
  h.preset('fill').click();
  assert.equal(h.panel().style.transform, 'translate(-50%, -50%)', 'a preset centres the panel again');
  assert.deepEqual(h.size(), [1352, 852]);
});

test('arrow keys on the grip resize in steps (Shift for big steps) and store the size; Escape still closes', async t => {
  const h = setup(t);
  await h.open();
  const grip = h.grip();
  grip.focus();
  let outside = 0;
  h.document.addEventListener('keydown', () => outside++);
  h.key(grip, 'ArrowRight');
  assert.deepEqual(h.size(), [1058, 722]);
  h.key(grip, 'ArrowDown', { shiftKey: true });
  assert.deepEqual(h.size(), [1058, 786]);
  h.key(grip, 'ArrowLeft');
  h.key(grip, 'ArrowUp');
  assert.deepEqual(h.size(), [1042, 770], 'exact steps: no drift by the border width');
  assert.equal(outside, 0, 'handled arrows do not reach page shortcuts');
  assert.equal(h.stored(), '{"preset":"custom","width":1042,"height":770}');
  h.key(grip, 'Escape');
  assert.equal(h.panel(), null);
});

test('below 900px the controls and grip are hidden and the built-in size applies; widening brings the stored size back', async t => {
  const h = setup(t, { width: 420, height: 800, stored: '{"preset":"large"}' });
  await h.open();
  assert.equal(h.$('.je-panel-size').hidden, true);
  assert.equal(h.grip().hidden, true);
  assert.equal(h.edge('x'), null);
  assert.equal(h.edge('y').hidden, true);
  assert.equal(h.panel().style.width, 'min(1040px, 94vw)');
  h.pointer(h.grip(), 'pointerdown', 10, 10);
  assert.equal(h.panel().classList.contains('je-panel-resizing'), false);
  h.key(h.grip(), 'ArrowRight');
  assert.equal(h.stored(), '{"preset":"large"}', 'the phone never changes the stored choice');
  h.resizeWindow(1400, 900);
  assert.equal(h.$('.je-panel-size').hidden, false);
  assert.deepEqual(h.size(), [1260, 810]);
  h.resizeWindow(899, 900);
  assert.equal(h.grip().hidden, true);
  assert.equal(h.panel().style.width, 'min(1040px, 94vw)');
});

test('focus containment holds with the new controls: Tab wraps from the grip to the first preset and back', async t => {
  const h = setup(t);
  const opener = h.$('#opener');
  opener.focus();
  await h.open();
  const panel = h.panel();
  assert.equal(h.document.activeElement, panel);
  const grip = h.grip();
  const first = h.preset('default');
  grip.focus();
  h.key(grip, 'Tab');
  assert.equal(h.document.activeElement, first, 'Tab past the grip wraps to the first control');
  h.key(first, 'Tab', { shiftKey: true });
  assert.equal(h.document.activeElement, grip, 'Shift+Tab before the first control wraps to the grip');
  // From the dialog itself, Shift+Tab goes to the last control (the hidden Reset size is skipped).
  h.key(panel, 'Tab', { shiftKey: true });
  assert.equal(h.document.activeElement, grip);
  h.key(first, '?');
  assert.equal(h.panel(), null, '? on a preset button still closes');
  assert.equal(h.document.activeElement, opener);
});

test('the page behind is inert while the dialog is open: outside focus comes back, the grip stays in the trap, close releases it', async t => {
  const h = setup(t);
  const opener = h.$('#opener');
  opener.focus();
  await h.open();
  const panel = h.panel();
  assert.equal(opener.hasAttribute('inert'), true, 'the page behind is inert');
  assert.equal(panel.hasAttribute('inert'), false);
  assert.equal(panel.closest('[inert]'), null, 'the dialog itself is not');
  assert.equal(h.grip().closest('[inert]'), null, 'the grip is inside the dialog');
  assert.equal(h.preset('large').closest('[inert]'), null, 'so are the size presets');

  // A script (or a browser without inert) focusing the page behind: focus comes back to where it was.
  const grip = h.grip();
  grip.focus();
  opener.focus();
  assert.equal(h.document.activeElement, grip, 'focus returns to the last control inside');
  const press = new h.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  opener.dispatchEvent(press);
  assert.equal(press.defaultPrevented, true, 'a press on the page behind does not blur the dialog');
  const inside = new h.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  h.preset('large').dispatchEvent(inside);
  assert.equal(inside.defaultPrevented, false, 'presses inside the dialog are untouched');
  // Tab containment still runs through the grip.
  h.key(grip, 'Tab');
  assert.equal(h.document.activeElement, h.preset('default'));

  // Something the panel opens later (release notes card, toasts) is not held.
  const card = h.document.createElement('button');
  h.document.body.appendChild(card);
  card.focus();
  assert.equal(h.document.activeElement, card);

  h.close();
  assert.equal(opener.hasAttribute('inert'), false, 'close releases the page');
  assert.equal(h.document.activeElement, opener, 'focus goes back to the opener');
  card.focus();
  opener.focus();
  assert.equal(h.document.activeElement, opener, 'the page is focusable again');
  const after = new h.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  opener.dispatchEvent(after);
  assert.equal(after.defaultPrevented, false, 'and its presses are no longer guarded');
});

test('an element that was already inert before the panel opened stays inert after it closes', async t => {
  const h = setup(t);
  const already = h.document.createElement('div');
  already.setAttribute('inert', '');
  h.document.body.appendChild(already);
  await h.open();
  await h.JE.showEnhancedPanel(); // the toggle closes it
  assert.equal(h.panel(), null);
  assert.equal(already.hasAttribute('inert'), true);
  assert.equal(h.$('#opener').hasAttribute('inert'), false);
});

test('closing drops the window listeners: a resize after close changes nothing and a new panel wires its own', async t => {
  const h = setup(t);
  await h.open();
  const media = h.queries.find(q => q.query.includes('900px'));
  assert.equal(media.listeners.size, 1);
  h.close();
  assert.equal(media.listeners.size, 0);
  h.resizeWindow(800, 600);
  h.resizeWindow(1400, 900);
  await h.open();
  h.preset('large').click();
  assert.deepEqual(h.size(), [1260, 810]);
});


for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) test(`second pointer cannot replace or end a drag through ${event}`, async t => {
  const h = setup(t);
  await h.open();
  const grip = h.grip();
  h.pointer(grip, 'pointerdown', 10, 10);
  h.pointer(grip, 'pointerdown', 100, 100, { pointerId: 2 });
  h.pointer(grip, 'pointermove', 200, 200, { pointerId: 2 });
  h.pointer(grip, event, 200, 200, { pointerId: 2 });
  assert.equal(h.panel().classList.contains('je-panel-resizing'), true);
  h.pointer(grip, 'pointermove', 20, 20);
  assert.deepEqual(h.size(), [1062, 742], 'first pointer retains its original origin');
  h.pointer(grip, event, 20, 20);
  assert.equal(h.panel().classList.contains('je-panel-resizing'), false);
  assert.equal(JSON.parse(h.stored()).width, 1062);
});


test('a moved panel re-centres fully on screen when entering narrow mode', async t => {
  const h = setup(t);
  await h.open();
  Object.assign(h.panel().style, { left: '1000px', top: '700px', transform: 'none' });
  h.resizeWindow(850, 700);
  assert.equal(h.panel().style.transform, 'translate(-50%, -50%)');
  const rect = h.panel().getBoundingClientRect();
  assert.ok(rect.left >= 0 && rect.top >= 0 && rect.right <= 850 && rect.bottom <= 700);
});


for (const width of [850, 1000]) test(`viewport resize to ${width}px cancels capture, restores selection and clamps immediately`, async t => {
  const h = setup(t);
  await h.open();
  const grip = h.grip();
  let captured = null;
  grip.setPointerCapture = id => { captured = id; };
  grip.hasPointerCapture = id => captured === id;
  grip.releasePointerCapture = () => { captured = null; };
  h.pointer(grip, 'pointerdown', 10, 10);
  h.pointer(grip, 'pointermove', 80, 50);
  h.resizeWindow(width, 650);
  assert.equal(captured, null);
  assert.equal(h.panel().classList.contains('je-panel-resizing'), false);
  const select = new h.window.Event('selectstart', { bubbles: true, cancelable: true });
  h.document.dispatchEvent(select);
  assert.equal(select.defaultPrevented, false);
  const size = h.size();
  assert.ok(size[0] <= width && size[1] <= 650);
  h.pointer(grip, 'pointermove', 900, 900);
  h.pointer(grip, 'pointerup', 900, 900);
  assert.deepEqual(h.size(), size, 'captured moves cannot revive the drag');
  assert.equal(h.stored(), null, 'a cancelled drag does not overwrite the chosen size');
});


for (const notify of [true, false]) test(`identity switch closes the old panel without writing the incoming user's size (event=${notify})`, async t => {
  const h = setup(t, { stored: '{"preset":"large"}' });
  const nextKey = 'JE_panelSize_user-b';
  h.window.localStorage.setItem(nextKey, '{"preset":"fill"}');
  await h.open();
  const stalePreset = h.preset('large');
  h.pointer(h.grip(), 'pointerdown', 10, 10);
  h.pointer(h.grip(), 'pointermove', 20, 20);
  h.window.ApiClient.getCurrentUserId = () => 'user-b';
  if (notify) h.document.dispatchEvent(new h.window.CustomEvent('je:user-changed'));
  else h.pointer(h.grip(), 'pointermove', 30, 30);
  assert.equal(h.panel(), null);
  stalePreset.click();
  assert.equal(h.window.localStorage.getItem(nextKey), '{"preset":"fill"}');
  assert.equal(h.stored(), '{"preset":"large"}');
  await h.open();
  assert.deepEqual(h.pressed(), ['fill'], 'incoming identity reads its own choice');
});


test('scrollbar pointer input cannot start a resize at Fill', async t => {
  const h = setup(t);
  await h.open();
  h.preset('fill').click();
  const scroller = h.$('.je-panel-main');
  const rect = h.panel().getBoundingClientRect();
  const down = h.pointer(scroller, 'pointerdown', rect.right - 2, rect.top + 100);
  assert.equal(down.defaultPrevented, false);
  assert.equal(h.panel().classList.contains('je-panel-resizing'), false);
  assert.equal(h.$('[data-je-resize="x"]'), null);
});


test('grip announces keyboard size and maximum through its polite localized status', async t => {
  const h = setup(t);
  await h.open();
  const status = h.$('#jePanelSizeStatus');
  assert.equal(h.grip().getAttribute('aria-describedby'), status.id);
  assert.equal(status.getAttribute('aria-live'), 'polite');
  assert.equal(status.getAttribute('aria-atomic'), 'true');
  h.key(h.grip(), 'ArrowRight');
  assert.equal(status.textContent, 'Panel size 1058 × 722');
  h.preset('fill').click();
  h.key(h.grip(), 'ArrowRight');
  assert.equal(status.textContent, 'Panel size 1352 × 852. Maximum size reached');
});

test('pointer announcements coalesce for 250ms and discard pending updates on close', async t => {
  const h = setup(t);
  await h.open();
  const status = h.$('#jePanelSizeStatus');
  const initial = status.textContent;
  h.pointer(h.grip(), 'pointerdown', 10, 10);
  h.pointer(h.grip(), 'pointermove', 20, 20);
  h.pointer(h.grip(), 'pointermove', 30, 30);
  assert.equal(status.textContent, initial);
  await new Promise(resolve => setTimeout(resolve, 280));
  assert.equal(status.textContent, 'Panel size 1082 × 762');
  h.pointer(h.grip(), 'pointermove', 40, 40);
  h.close();
  await new Promise(resolve => setTimeout(resolve, 280));
  assert.equal(status.textContent, 'Panel size 1082 × 762', 'no announcement after teardown');
});
