import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { createHarness, deferred } from '../helpers/harness.mjs';

const card = '<div class="card" data-id="AA-BB" data-type="Episode"><div class="cardScalable"><div class="cardImageContainer"></div><div class="cardOverlayContainer"></div></div></div>';

/**
 * The real tag pipeline in batch mode with a stand-in layout controller that
 * records what item data reaches it, and when.
 */
function setup(t) {
  const idle = [], timers = new Map(), events = [];
  let seq = 0;
  const response = deferred();
  const h = createHarness({
    html: card,
    globals: { requestIdleCallback: fn => idle.push(fn), setTimeout: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq; }, clearTimeout: id => timers.delete(id) },
    apiClient: { ajax: () => response.promise },
    JE: {
      pluginConfig: { TagCacheServerMode: false }, currentSettings: {}, session: { onUserChange() {} },
      core: {
        tagRenderer: { applyCornerStacking() {}, scheduleCornerStacking() {} },
        tagLayout: { prepareCard() {}, setCardContext: (target, item, itemId) => events.push(['context', target.className, item.LibraryId, itemId]) },
      },
    },
  });
  t.after(() => h.close());
  h.load('tags/tag-pipeline.js');
  h.JE.tagPipeline.registerRenderer('probe', { isEnabled: () => true, render: (host, item) => events.push(['render', item.Id]) });
  return Object.assign(h, { events, response, scan() { while (idle.length) idle.shift()({ timeRemaining: () => 50 }); },
    fetch() { for (const [id, timer] of [...timers]) if (timer.ms === 150) { timers.delete(id); timer.fn(); } } });
}

test('the batch path hands the item data (library id included) to the layout controller before the renderers run', async t => {
  const h = setup(t);
  h.scan();
  h.fetch();
  h.response.resolve({ Items: [{ Id: 'aabb', Type: 'Episode', LibraryId: '22222222222222222222222222222222', SeriesId: 'cc' }] });
  await settle();
  assert.deepEqual(h.events, [['context', 'je-tag-host', '22222222222222222222222222222222', 'aabb'], ['render', 'aabb']]);
  assert.equal(h.JE.tagPipeline.peekServerEntry('aabb'), null, 'no server cache in batch mode');
  assert.deepEqual(Array.from(h.JE.tagPipeline.serverEntries()), []);
});
