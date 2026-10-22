import test from 'node:test';
import assert from 'node:assert/strict';
import { configPage, applyConfigPatch } from '../helpers/config-page.mjs';

// Stage 1 fix round 12: an administrator's action on the configuration page belongs to the administrator who started it,
// from the click on, and the configuration's runtime effects follow the configuration the server holds now.
// RBS1-R12-1: Apply to all users saved the configuration as administrator A; with the save's answer held, the page signed
// in as B; on release, the maintenance and reset-all-users requests went out with B's credentials (the page's inline
// scripts sent outside the session-bound send). RBS1-R12-4: A stored Enable and its answer waited; B stored Disable and
// turned maintenance off; A's late answer then turned maintenance back on from the snapshot it carried.

for (const host of ['10.11', '12.2']) {
  test(`R12-1 ${host}: Apply to all users must not continue as the next admin after its save`, async t => {
    const p = configPage(t, { config: { ToastDuration: 1500, HelpPanelAutocloseDelay: 15000, Shortcuts: [], JellyseerrUrls: '', JellyseerrUrlMappings: '' } });
    let user = 'admin-a';
    const sent = [];
    const ac = p.window.ApiClient;
    ac.getCurrentUserId = () => user;
    ac.accessToken = () => user;
    const ajax = ac.ajax;
    ac.ajax = request => { if (request.type && request.type !== 'GET') sent.push({ user, url: request.url }); return ajax(request); };
    await p.pageshow();
    const release = p.server.holdWrite();
    p.$('#resetAllUserSettingsBtn').click();
    await p.flush();
    assert.ok(sent.some(s => s.user === 'admin-a' && s.url.endsWith('/configuration')));
    user = 'admin-b';
    release();
    await p.flush(60);
    assert.deepEqual(sent.filter(s => s.user === 'admin-b'), [], 'no continuation of A\'s action may be sent as B');
  });
}

test('R12-4: an older configuration answer cannot re-enable maintenance after a newer admin disabled it', async t => {
  const server = { config: { ToastDuration: 1500, HelpPanelAutocloseDelay: 15000, Shortcuts: [], JellyseerrUrls: '', JellyseerrUrlMappings: '', MaintenanceModeEnabled: false, MaintenanceModeAffectedUsers: 'all', MaintenanceModeAction: 'block_playback' } };
  let release, reached;
  const held = new Promise(r => { release = r; });
  const arrived = new Promise(r => { reached = r; });
  const a = configPage(t, { server, overrides: {
    configPatch: [(kind, url, req) => req?.type === 'PATCH' && url.endsWith('/configuration'), async req => {
      const applied = applyConfigPatch(server.config, JSON.parse(req.data));
      server.config = applied.next;
      const answer = { success: true, configuration: structuredClone(applied.next) };
      reached(); await held; return answer;
    }]
  } });
  await a.pageshow();
  a.choose('#maintenanceModeEnabled', true);
  a.$('#JellyfinEnhancedForm').dispatchEvent(new a.window.Event('submit', { cancelable: true }));
  await arrived;
  assert.equal(server.config.MaintenanceModeEnabled, true);
  const b = configPage(t, { server });
  await b.pageshow();
  b.choose('#maintenanceModeEnabled', false);
  await b.save();
  assert.equal(server.config.MaintenanceModeEnabled, false);
  assert.ok(b.posts.some(x => x.url.includes('/MaintenanceMode/Disable')), 'newer save turned maintenance off');
  release();
  await a.flush(35);
  assert.ok(!a.posts.some(x => x.url.endsWith('/MaintenanceMode/Enable')), 'the older save must not turn maintenance back on');
  // The same, for the confirmation the page sends now (it names the generation it confirms: a query string).
  assert.ok(!a.posts.some(x => /\/MaintenanceMode\/Enable(\?|$)/.test(x.url)), 'no Enable of any form from the older save');
});

const BASE_CONFIG = { ToastDuration: 1500, HelpPanelAutocloseDelay: 15000, Shortcuts: [], JellyseerrUrls: '', JellyseerrUrlMappings: '' };
const alertText = alert => typeof alert === 'string' ? alert : `${alert?.title || ''} ${alert?.message || ''}`;

// P03: Import Users Now saves the page first; the import after that save is the clicking administrator's, never the next.
test('Import Users Now waiting for its save is never sent as the next administrator', async t => {
  const p = configPage(t, { config: { ...BASE_CONFIG, JellyseerrEnabled: true } });
  let user = 'admin-a';
  const sent = [];
  const ac = p.window.ApiClient;
  ac.getCurrentUserId = () => user;
  ac.accessToken = () => user;
  for (const name of ['ajax', 'fetch']) {
    const original = ac[name];
    ac[name] = request => { if (request.type && request.type !== 'GET') sent.push({ user, url: request.url }); return original(request); };
  }
  await p.pageshow();
  // A change to save first (the import saves the page before it runs).
  p.choose('#jellyseerrAutoImportUsers', true);
  // The fixture's Seerr section waits behind its dependency banner; the click handler is what is tested.
  p.$('#btnImportJellyseerrUsers').disabled = false;
  const release = p.server.holdWrite();
  p.$('#btnImportJellyseerrUsers').click();
  await p.flush();
  assert.ok(sent.some(s => s.user === 'admin-a' && s.url.endsWith('/configuration')), 'its save is out as A');
  user = 'admin-b';
  release();
  await p.flush(60);
  assert.deepEqual(sent.filter(s => s.url.includes('import-users')), [], "A's import is cancelled, never sent as B");
});

// P06/P24: an inline command or save whose answer was lost may be stored: never "failed".
test('a cache clear signal whose answer was lost is said as unconfirmed, never as failed', async t => {
  const p = configPage(t, { config: BASE_CONFIG, overrides: {
    configPatch: [(kind, url, req) => req?.type === 'PATCH' && url.endsWith('/configuration'), async () => { throw new TypeError('connection lost'); }]
  } });
  await p.pageshow();
  p.$('#clearTagsCacheBtn').click();
  await p.flush(20);
  const said = p.alerts.map(alertText).join('\n');
  assert.doesNotMatch(said, /Failed to set cache clear timestamp/);
  assert.match(said, /Could not confirm/);
});

test('control: a cache clear signal the server refused is said as failed', async t => {
  const p = configPage(t, { config: BASE_CONFIG, overrides: {
    configPatch: [(kind, url, req) => req?.type === 'PATCH' && url.endsWith('/configuration'), async () => { throw Object.assign(new Error('refused'), { status: 400 }); }]
  } });
  await p.pageshow();
  p.$('#clearTagsCacheBtn').click();
  await p.flush(20);
  assert.match(p.alerts.map(alertText).join('\n'), /Failed to set cache clear timestamp/);
});

test('a configuration save whose answer was lost is said as unconfirmed, and the page reads what the server holds', async t => {
  let reads = 0;
  const server = { config: { ...BASE_CONFIG } };
  const p = configPage(t, { server, overrides: {
    pluginConfig: [(kind) => kind === 'getPluginConfiguration', () => { reads++; return structuredClone(server.config); }],
    configPatch: [(kind, url, req) => req?.type === 'PATCH' && url.endsWith('/configuration'), async req => {
      server.config = applyConfigPatch(server.config, JSON.parse(req.data)).next;
      throw new TypeError('connection lost after commit');
    }]
  } });
  await p.pageshow();
  const before = reads;
  p.choose('#jellyseerrAutoImportUsers', true);
  await p.save().catch(() => {});
  await p.flush(20);
  const said = p.alerts.map(alertText).join('\n');
  assert.doesNotMatch(said, /Save failed|Error saving/i);
  assert.match(said, /Could not confirm the save/);
  assert.ok(reads > before, 'the stored configuration is read again');
});
