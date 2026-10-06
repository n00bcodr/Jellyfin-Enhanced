import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, jsRoot } from '../helpers/harness.mjs';

// The production bundle runs every js/component-scripts.json entry in order, each wrapped
// in its own function (Services/ClientScriptBundle.cs); the harness load() uses that
// wrapper. Host stubs are only what plugin.js provides before the component stage.
test('every manifest module loads in bundle order without load-time errors', async t => {
  const manifest = JSON.parse(readFileSync(resolve(jsRoot, 'component-scripts.json'), 'utf8'))
    .filter(entry => !entry.startsWith('//'));
  assert.ok(manifest.length > 100);
  const cdnUrl = (source, path) => `http://jellyfin.test/JellyfinEnhanced/cdn/${source}/${path}`;
  const h = createHarness({
    JE: {
      pluginConfig: {}, userConfig: {}, translations: {}, currentSettings: {}, state: { activeShortcuts: {} },
      t: key => key, icon: () => '', IconName: {}, escapeHtml: value => String(value ?? ''),
      cdn: { url: cdnUrl, selfhst: file => cdnUrl('selfhst', file), flagPng: code => cdnUrl('flagcdn', code), flagSvg: code => cdnUrl('flag-icons', code), font: name => `http://jellyfin.test/JellyfinEnhanced/fonts/${name}` }
    },
    // jsdom lacks ResizeObserver; every supported browser has it.
    globals: { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } }
  });
  t.after(() => h.close());
  const failures = [];
  for (const path of manifest) {
    try { h.load(path); } catch (error) { failures.push(`${path}: ${error?.message ?? error}`); }
  }
  // Let deferred startup work (timers, promise chains) run inside the window, so an error it
  // throws is reported by close() instead of being lost when the realm is torn down.
  await new Promise(done => setTimeout(done, 300));
  assert.deepEqual(failures, []);
});
