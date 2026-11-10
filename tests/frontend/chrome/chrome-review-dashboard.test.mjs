// Theme selector, plugin icons and plugin revisions (preferences/dashboard chrome).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../helpers/harness.mjs';
import { chromeJs, fakeClock, until } from './helpers.mjs';

function icons(t, { html, config = async () => ({ CustomPluginLinks: 'Alpha|star' }), session } = {}) {
  const clock = fakeClock();
  let server = 'server-a';
  const calls = [];
  const h = createHarness({ html: html ?? `<ul aria-labelledby="plugins-subheader">
      <a href="#/configurationpage?name=Jellyfin%20Enhanced"><div class="MuiListItemIcon-root"><svg></svg></div></a>
      <a href="#/configurationpage?name=Intro%20Skipper"><div class="MuiListItemIcon-root"><span class="material-icons">folder</span></div></a>
    </ul>`, globals: clock.globals,
    apiClient: { serverId: () => server, getPluginConfiguration: id => { calls.push([server, id]); return config(server); } },
    JE: { cdn: { url: (source, path) => `/cdn/${source}/${path}` }, ...(session ? { session } : {}),
      core: { lifecycle: { register: () => ({ track: r => r, teardown() {} }) }, navigation: { onNavigate: () => () => {} } },
      helpers: { onBodyMutation: (id, callback) => { const mo = new h.window.MutationObserver(callback); mo.observe(h.document.body, { childList: true, subtree: true }); return { unsubscribe: () => mo.disconnect() }; } } } });
  t.after(() => { h.JE.stopPluginIconsMonitoring?.(); h.close(); });
  h.document.body.classList.add('dashboardDocument');
  h.load(chromeJs('extras/plugin-icons.js'));
  return { ...h, clock, calls, switchServer(next) { server = next; },
    link: name => [...h.document.querySelectorAll('[data-jellyfin-enhanced-plugin-id]')].find(a => a.querySelector('.MuiListItemText-primary')?.textContent === name) };
}


test('CHR-R1-004 retained dashboard reconciles custom links across server switch', async t => {
 const h=icons(t,{config:async server=>({CustomPluginLinks:server==='server-a'?'Alpha|star':'Beta|bolt'})});
 await h.JE.initializePluginIcons(); await h.clock.advance(500); assert.ok(h.link('Alpha'));
 h.switchServer('server-b'); h.JE.customPlugins.refresh(); await h.clock.advance(500);
 assert.deepEqual(h.calls.map(([server])=>server),['server-a','server-b']);
 assert.equal(h.link('Alpha'),undefined); assert.ok(h.link('Beta'));
});

test('CHR-ICONS-2: refresh removes deleted rows without replacing stable saved links',async t=>{
 let text='Alpha|star\nBeta|bolt';const h=icons(t,{config:async()=>({CustomPluginLinks:text})});
 await h.JE.initializePluginIcons();await h.clock.advance(500);const alpha=h.link('Alpha');
 text='Alpha|star';h.JE.customPlugins.refresh();await h.clock.advance(500);
 assert.equal(h.link('Alpha'),alpha);assert.equal(h.link('Beta'),undefined);
});
test('CHR-ICONS-2: transient failed refresh preserves same-owner saved links',async t=>{
 let fail=false;const h=icons(t,{config:async()=>{if(fail)throw Error('offline');return {CustomPluginLinks:'Alpha|star'};}});
 await h.JE.initializePluginIcons();await h.clock.advance(500);const alpha=h.link('Alpha');
 fail=true;h.JE.customPlugins.refresh();await h.clock.advance(500);assert.equal(h.link('Alpha'),alpha);
});
