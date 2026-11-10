// canopy K1: one featureContext for every feature script. core/ui-kit.js publishes it on JE.core; feature hosts
// (client/src/host/context.ts featureContext) call that copy instead of inlining their own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

// The real provider order, without the harness's own install (featureContext: false).
function setup(t) {
  const h = createHarness({
    featureContext: false,
    JE: { cdn: { url: () => '/JellyfinEnhanced/cdn/jellyfish/colors/' }, helpers: { onBodyMutation: () => ({ unsubscribe() {} }) } },
  });
  t.after(() => h.close());
  return h;
}

test('core/ui-kit.js publishes featureContext once, non-enumerable, and a feature script loaded after it uses it', t => {
  const h = setup(t);
  h.load('core/ui-kit.js');
  const shared = h.JE.core.featureContext;
  assert.equal(typeof shared, 'function');
  assert.equal(Object.keys(h.JE.core).includes('featureContext'), false, 'a walk of JE.core must not see it');
  h.load('core/ui-kit.js');
  assert.equal(h.JE.core.featureContext, shared, 'a second load keeps the published copy');
  let calls = 0;
  h.JE.core.featureContext = (...args) => { calls++; return shared(...args); };
  h.load('extras/theme-selector.js');
  assert.equal(calls, 1, 'the feature host built its context with the shared copy');
  assert.equal(typeof h.JE.initializeThemeSelector, 'function', 'the facade published through ctx.own reached JE');
});

test('a feature script loaded without the provider fails with an error naming the load order', t => {
  const h = setup(t);
  assert.throws(() => h.load('extras/theme-selector.js'), /chrome: JE\.core\.featureContext is missing; core\/ui-kit\.js must load before feature scripts/);
  assert.equal(h.JE.initializeThemeSelector, undefined);
});
