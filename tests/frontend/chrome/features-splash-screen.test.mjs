import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

/** The splash module over a page that already holds another plugin's loaders. */
function splash(t, html) {
  const h = createHarness({ html, JE: { pluginConfig: { EnableCustomSplashScreen: true } } });
  t.after(() => h.close());
  h.load('others/splashscreen.js');
  return h;
}

test('a competing splash is removed wherever it sits; JE\'s own loader and other elements stay', t => {
  const h = splash(t, '<div id="page-loader"></div><section><div class="bar-loading" id="deep"></div><div id="page-loader" data-second></div></section>'
    + '<div class="bar-loading je-loading" id="ours"></div><div class="bar" id="other"></div>');
  h.JE.initializeSplashScreen();
  assert.equal(h.document.querySelectorAll('#page-loader').length, 0, 'every element with the id, not only the first');
  assert.equal(h.document.getElementById('deep'), null);
  assert.ok(h.document.getElementById('ours'), 'a .bar-loading that is JE\'s own stays');
  assert.ok(h.document.getElementById('other'));
});

test('a competing splash added after the first look is still found by the next one', t => {
  const h = splash(t, '<section id="host"></section>');
  h.JE.initializeSplashScreen();
  // Nested, so the body-level blocker does not see it; the next look does (the same collection, kept live).
  h.document.getElementById('host').innerHTML = '<div class="bar-loading" id="late"></div><div id="page-loader"></div>';
  h.JE.initializeSplashScreen();
  assert.equal(h.document.getElementById('late'), null);
  assert.equal(h.document.getElementById('page-loader'), null);
});
