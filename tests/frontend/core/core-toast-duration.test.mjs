import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

function setup(t, pluginConfig) {
  const h = createHarness({ html: '<body></body>', JE: { pluginConfig } });
  t.after(() => h.close());
  for (const file of ['enhanced/config.js', 'core/ui-kit.js']) h.load(file);
  return h;
}

const toasts = h => h.document.querySelectorAll('.jellyfin-enhanced-toast').length;

test('a toast duration of 0 turns toasts off, including ones that pass their own duration', t => {
  const h = setup(t, { ToastDuration: 0 });
  assert.equal(h.JE.CONFIG.TOAST_DURATION, 0);
  h.JE.toast('hello');
  h.JE.toast('error', 6000);
  assert.equal(toasts(h), 0);
});

test('a configured duration is used as set, and a missing one falls back to 1500', t => {
  assert.equal(setup(t, { ToastDuration: 10 }).JE.CONFIG.TOAST_DURATION, 10);
  assert.equal(setup(t, { ToastDuration: 4000 }).JE.CONFIG.TOAST_DURATION, 4000);
  assert.equal(setup(t, {}).JE.CONFIG.TOAST_DURATION, 1500);
  const h = setup(t, { ToastDuration: 4000 });
  h.JE.toast('hello');
  assert.equal(toasts(h), 1);
});
