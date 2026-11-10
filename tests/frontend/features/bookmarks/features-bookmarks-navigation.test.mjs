import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from '../../helpers/harness.mjs';
import {installJellyfinRouter} from '../../helpers/jellyfin-router.mjs';
// The standalone Bookmarks page with the real navigation core and all eight entries in manifest order.
async function setup(t) {
 const h=createHarness({url:'http://jellyfin.test/web/index.html#/home',JE:{
  pluginConfig:{BookmarksEnabled:true},userConfig:{bookmark:{bookmarks:{}}},
  t:k=>k,toast:()=>{},escapeHtml:v=>String(v??''),
  session:{getEpoch:()=>0,isCurrent:e=>e===0,onUserChange:()=>()=>{}},
  helpers:{isActiveTabContainer:()=>false,onSidebarRebuilt:()=>()=>{},observeTabContainers:()=>({teardown(){}})},core:{api:{fetch:async()=>({Items:[]})}}
 },apiClient:{getItem:async(_user,id)=>({Id:id,Name:id,Type:'Movie'}),getImageUrl:()=>''}});
 t.after(()=>h.close());
 const router=installJellyfinRouter(h);
 h.load('core/navigation.js');h.load('enhanced/bookmarks/bookmarks.js');
 for(const name of ['styles','page','render','items','modals','replacements','init'])h.load('enhanced/bookmarks/bookmarks-library-'+name+'.js');
 await new Promise(r=>setTimeout(r,130)); // the init entry's 100 ms readiness check
 return {...h,router};
}
test('in-app navigation to Bookmarks keeps it over the router\'s Page not found page by hash or router, and leaving still hides it',async t=>{
 const {router}=await setup(t);
 await router.go('#/bookmarks');assert.deepEqual(router.seen(),{visible:['je-bookmarks-standalone-page'],title:'Bookmarks'});
 await router.go('#/home');assert.deepEqual(router.seen(),{visible:['indexPage'],title:'Home'});
 await router.push('#/bookmarks');assert.deepEqual(router.seen(),{visible:['je-bookmarks-standalone-page'],title:'Bookmarks'});
 await router.push('#/home');assert.deepEqual(router.seen(),{visible:['indexPage'],title:'Home'});
});
