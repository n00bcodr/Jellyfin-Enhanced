// canopy K1b: a shared module (client/shared-modules.json) ships in one component script, its provider, which publishes
// it on JE.core.sharedModules before its own code; later scripts read that copy when they load. Here with a real pair:
// core/tag-layout.js provides features/media-tags/layout/layout-rules, core/tag-look.js reads it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

const ID = 'features/media-tags/layout/layout-rules';

// The real provider order, without the harness's own shared-module install (sharedModules: false).
function setup(t) {
  const h = createHarness({ sharedModules: false,
    JE: { currentSettings: {}, pluginConfig: {}, t: key => key, cdn: { flagSvg: code => `/flags/${code}.svg` } } });
  t.after(() => h.close());
  // In component-scripts.json order; tag-renderer-base.js provides the media-tags host tag-layout.js reads.
  for (const file of ['core/media-language.js', 'core/tag-renderer-base.js']) h.load(file);
  return h;
}

test('the provider publishes the module non-enumerable, and a later script reads its exports from that copy', t => {
  const h = setup(t);
  h.load('core/tag-layout.js');
  const registry = h.JE.core.sharedModules;
  assert.equal(Object.keys(h.JE.core).includes('sharedModules'), false, 'a walk of JE.core must not see it');
  const published = registry[ID];
  assert.equal(typeof published.isLayout, 'function');
  assert.equal(published.LAYOUT_SLOTS, h.JE.core.tagLayout.LAYOUT_SLOTS, 'the provider published the copy it uses itself');
  h.load('core/tag-layout.js');
  assert.equal(registry[ID], published, 'a second load keeps the published copy');
  const reads = [];
  registry[ID] = new Proxy(published, { get(target, key) { reads.push(key); return target[key]; } });
  h.load('core/tag-look.js');
  assert.ok(reads.includes('isLayout') && reads.includes('pick'), `the consumer read its imports from the published copy: ${reads.join(', ')}`);
  assert.equal(typeof h.JE.core.tagLook, 'object');
});

test('a script loaded without its provider fails with an error naming the module', t => {
  const h = setup(t);
  assert.throws(() => h.load('core/tag-look.js'),
    /features\/media-tags\/layout\/layout-rules is not in JE\.core\.sharedModules: load its provider first \(client\/shared-modules\.json\)/);
  assert.equal(h.JE.core?.tagLook, undefined);
});
