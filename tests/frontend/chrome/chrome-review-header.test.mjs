// Native Home tabs and the adaptive header tray: identity-scoped caches and lifecycle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../helpers/harness.mjs';
import { chromeJs, until } from './helpers.mjs';

const strip = '<div is="emby-tabs"><div class="emby-tabs-slider"><button class="emby-tab-button emby-tab-button-active" data-index="0"></button><button class="emby-tab-button" data-index="1"></button></div></div>';
const homePage = '<div class="page" id="indexPage"><div class="tabContent pageTabContent is-active" data-index="0"></div><div class="tabContent pageTabContent" data-index="1"></div></div>';

function tabs(t, { hash = '#/home', configs = async () => [], items } = {}) {
  let user = 'user-a', server = 'server-a';
  const requests = [], itemCalls = [];
  const h = createHarness({ url: `http://jellyfin.test/web/index.html${hash}`, JE: { pluginConfig: {} },
    html: `<div class="backgroundContainer"></div><div class="backdropContainer"></div>${strip}${homePage}`,
    apiClient: { getCurrentUserId: () => user, serverId: () => server,
      fetch: request => { requests.push(server); return configs(server, request); },
      getItems: (userId, query) => { itemCalls.push(userId); return items ? items(userId, query) : Promise.resolve({ Items: [] }); },
      getImageUrl: (id, options) => `http://jellyfin.test/Items/${id}/Images/${options.type}?tag=${options.tag}` } });
  t.after(() => h.close());
  Object.defineProperty(h.window.HTMLElement.prototype, 'offsetParent', { configurable: true, get() { return this.parentElement; } });
  for (const file of ['core/navigation.js', 'core/lifecycle.js', 'core/dom-observer.js', 'core/ui-kit.js', 'enhanced/helpers.js']) h.load(file);
  h.load(chromeJs('enhanced/native-tabs.js'));
  const tabsEl = h.document.querySelector('[is="emby-tabs"]');
  tabsEl.refresh = () => {};
  tabsEl.selectedTabIndex = 0;
  tabsEl.selectedIndex = function(index) {
    if (index === undefined) return this.selectedTabIndex;
    this.selectedTabIndex = index;
    h.document.querySelectorAll('.emby-tab-button')[index]?.classList.add('emby-tab-button-active');
    h.document.querySelector('#indexPage').querySelectorAll('.tabContent')[index]?.classList.add('is-active');
  };
  const reconcile = () => h.window.history.replaceState({}, '', h.window.location.href);
  return { ...h, requests, itemCalls, reconcile, signIn(nextUser, nextServer = server) { user = nextUser; server = nextServer; },
    button: id => h.document.getElementById(`je-native-tab-btn-${id}`), panel: id => h.document.getElementById(`je-native-tab-panel-${id}`) };
}


test('CHR-R1-005 never-settling optional Custom Tabs request leaves JE tabs usable',async t=>{
 const h=tabs(t,{configs:()=>new Promise(()=>{})});
 h.JE.nativeTabs.register('requests','Requests',()=>{});
 await until(()=>h.requests.length===1);
 for(let i=0;i<5;i++) {h.reconcile(); await new Promise(r=>h.JE.core.dom.afterNextPaint(r));}
 assert.ok(h.button('requests')); assert.ok(h.panel('requests'));
});

test('CHR-R1-005: a late optional count relabels the already mounted JE tab',async t=>{
 const pending=deferred();const h=tabs(t,{configs:()=>pending.promise});
 let mounts=0;h.JE.nativeTabs.register('requests','Requests',()=>{mounts++;});
 await until(()=>h.button('requests'));const panel=h.panel('requests');
 assert.equal(h.button('requests').dataset.index,'2');
 pending.resolve([{},{}]);await until(()=>h.button('requests').dataset.index==='4');
 assert.equal(h.panel('requests'),panel);assert.equal(mounts,1);
});
