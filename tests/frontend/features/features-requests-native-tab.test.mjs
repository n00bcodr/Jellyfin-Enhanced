import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

/** Loads the Requests page's native Home tab with the given config and returns the label it registered. */
function registeredLabel(t, config) {
  const h = createHarness({ JE: { pluginConfig: { DownloadsPageEnabled: true, DownloadsUseNativeTab: true, ...config } } });
  t.after(() => h.close());
  const strings = { requests_requests: 'Solicitudes', requests_downloads: 'Descargas' };
  h.JE.t = key => strings[key] || key;
  const labels = [];
  h.JE.nativeTabs = { register: (id, label) => labels.push([id, label]) };
  h.load('arr/requests/requests-custom-tab.js');
  return labels;
}

test('the Requests page\'s native Home tab uses its localized name', t => {
  assert.deepEqual(registeredLabel(t, {}), [['requests', 'Solicitudes']]);
});

test('with the new Requests page on, the old page\'s native Home tab is Downloads, as its sidebar link says', t => {
  assert.deepEqual(registeredLabel(t, { ArrRequestsHubEnabled: true }), [['requests', 'Descargas']]);
});
