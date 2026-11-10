import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness, plain} from '../../helpers/harness.mjs';
const itemId = 'a'.repeat(32);
function setup(t, settings = {tagLayoutSettingsVersion:1,tagLayout:'bands'}, plugin = {}) {
 const h=createHarness({JE:{core:{},currentSettings:settings,pluginConfig:plugin,t:key=>key}});
 t.after(()=>h.close());
 h.load('core/tag-layout.js');h.load('core/tag-look.js');return h;
}
for (const kind of ['Response','inherited']) {
 test(`item-look conflict retries from fresh state for a ${kind} transport error`, async t=>{
  const h=setup(t);let gets=0;const patches=[];
  const changed={ItemId:itemId,Layout:'minimal'};
  const api={get:async()=>({TagLookItemOverrides:++gets===1?[]:[changed]}),patch:async patch=>{
   patches.push(plain(patch));
   if(patches.length===1)throw kind==='Response'?new Response('',{status:409}):Object.create({status:409});
   return {values:{TagLookItemOverrides:[]}};
  }};
  assert.equal(await h.JE.core.tagLook.saveItemOverride(itemId,{layout:'bands'},{api}),true);
  assert.equal(gets,2);assert.equal(patches.length,2);
  assert.equal(patches[0].TagLookItemOverrides.Expected[itemId],null);
  assert.deepEqual(patches[1].TagLookItemOverrides.Expected[itemId],changed);
 });
}
for (const status of [403,500,409]) {
 test(`item-look ${status} failure has a bounded retry count`,async t=>{
  const h=setup(t);let gets=0,patches=0;
  const api={get:async()=>{gets++;return {};},patch:async()=>{patches++;throw new Response('',{status});}};
  assert.equal(await h.JE.core.tagLook.saveItemOverride(itemId,{layout:'bands'},{api}),false);
  assert.equal(gets,status===409?2:1);assert.equal(patches,gets);
 });
}
test('layout facade treats explicit null as current and administrator settings',t=>{
 const h=setup(t,undefined,{TagLayout:'minimal'}), layout=h.JE.core.tagLayout;
 assert.deepEqual(plain(layout.normalizeSettings(null)),plain(layout.normalizeSettings()));
 assert.equal(layout.isLegacySettings(null),false);
 assert.deepEqual(plain(layout.normalizeSettings({},null)),plain(layout.normalizeSettings({})));
 h.JE.currentSettings={tagLayout:'bands'};
 assert.equal(layout.isLegacySettings(null),true);
 assert.equal(layout.promoteLegacySettings(null),true);
 assert.equal(h.JE.currentSettings.tagLayoutSettingsVersion,1);
});
