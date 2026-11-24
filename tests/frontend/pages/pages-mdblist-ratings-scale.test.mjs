import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

const entry = {
  Found: true,
  Ratings: [
    { Source: 'imdb', Score: 64, Value: 6.4 },
    { Source: 'tomatoes', Score: 85, Value: 85 },
    { Source: 'rogerebert', Value: 3.5 },
  ],
};

async function badges(t, config) {
  let hook;
  const h = createHarness({
    html: '<div id="itemDetailPage"><div class="mediaInfoItem mediaInfoOfficialRating">PG</div><div class="itemExternalLinks"></div></div>',
    url: 'http://jellyfin.test/web/index.html#!/details?id=item',
    apiClient: { getItem: async () => ({ Type: 'Movie', Name: 'Film', ProviderIds: { Tmdb: '603' } }) },
    JE: {
      pluginConfig: { MdblistRatingsEnabled: true, MdblistRatingsShowOnItemDetails: true, ...config },
      escapeHtml: value => String(value ?? ''),
      t: key => key,
      cdn: { url: (_source, path) => `https://cdn.test/${path}` },
      helpers: { onViewPage: fn => { hook = fn; return () => {}; } },
      core: { api: { plugin: async () => entry, manager: { clearCacheMatching() {} } } },
    },
  });
  t.after(() => h.close());
  h.load('others/mdblist-ratings.js');
  h.JE.initializeMdblistRatingsScript();
  await hook({}, h.document.getElementById('itemDetailPage'), '#!/details?id=item');
  await new Promise(resolve => setTimeout(resolve, 400));
  return [...h.document.querySelectorAll('.je-mdblist-badge')].map(b => b.textContent.trim());
}

test('details ratings keep the 0-100 score by default and for unknown scales', async t => {
  assert.deepEqual(await badges(t, {}), ['85', '64', '3.5']);
  assert.deepEqual(await badges(t, { MdblistRatingsScale: '7' }), ['85', '64', '3.5']);
  assert.deepEqual(await badges(t, { MdblistRatingsShowPercentSymbol: true }), ['85%', '64%', '3.5']);
});

test('details ratings rescale MDBList scores to 0-10 and 0-5 with one decimal and no % symbol', async t => {
  assert.deepEqual(await badges(t, { MdblistRatingsScale: '10', MdblistRatingsShowPercentSymbol: true }), ['8.5', '6.4', '3.5']);
  assert.deepEqual(await badges(t, { MdblistRatingsScale: '5' }), ['4.3', '3.2', '3.5']);
});
