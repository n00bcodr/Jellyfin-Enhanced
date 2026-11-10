import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHarness } from '../../helpers/harness.mjs';

// Independent expected labels (not web/native agreement): tests/fixtures/quality-detection-truth.json.
const truth = JSON.parse(readFileSync(new URL('../../../fixtures/quality-detection-truth.json', import.meta.url)));

/** The real quality renderer with only pipeline discovery stubbed. */
function setup(t, settings) {
  let renderer = null;
  const h = createHarness({ html: '<div class="card"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div></div></div></div>',
    JE: { t: key => key,
      currentSettings: { qualityTagsEnabled: true, qualityTagsPreferredAudioLanguage: 'none', tagLabelDensity: 'full', tagLayout: 'corners', ...settings },
      pluginConfig: { TagCacheServerMode: true },
      session: { getUserId: () => 'a', getServerId: () => 's', onUserChange() {} },
      _cacheManager: { register() {}, markDirty() {} },
      tagPipeline: { tagStripRevision: () => 'none', registerRenderer: (key, value) => { if (key === 'quality') renderer = value; }, clearProcessed() {}, scheduleScan() {} } } });
  t.after(() => h.close());
  for (const file of ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/qualitytags.js']) h.load(file);
  h.JE.initializeQualityTags();
  const card = h.document.querySelector('.cardImageContainer');
  return streams => {
    h.JE.core.tagLayout.clearCard(card);
    delete h.document.querySelector('.card').dataset.jeQualityTagged;
    renderer.renderFromServerCache(card, { Type: 'Movie', StreamData: { Streams: structuredClone(streams), Sources: [] } }, 'truth');
    return [...h.document.querySelectorAll('.quality-overlay-label')].map(el => el.textContent);
  };
}

const all = { qualityAudioDisplayMode: 'all', qualityVideoCodecDisplayMode: 'all', qualityHdrDisplayMode: 'all' };
for (const row of truth.cases) {
  test(`truth: ${row.name} (Highest)`, t => {
    assert.deepEqual(setup(t, { tagLayoutSettingsVersion: 1 })(row.streams), row.highest);
  });
  test(`truth: ${row.name} (All)`, t => {
    assert.deepEqual(setup(t, { tagLayoutSettingsVersion: 1, ...all })(row.streams), row.all);
  });
  if (row.legacy) test(`truth: ${row.name} (version-0 settings)`, t => {
    assert.deepEqual(setup(t, { tagLayoutSettingsVersion: 0 })(row.streams), row.legacy);
  });
}
