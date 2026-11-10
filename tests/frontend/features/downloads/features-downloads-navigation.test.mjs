import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from '../../helpers/harness.mjs';
import {installJellyfinRouter} from '../../helpers/jellyfin-router.mjs';
const files=['styles','data','render-helpers','render-cards','render','actions','init'];
function setup(t){
 const h=createHarness({url:'http://jellyfin.test/web/index.html#/home',JE:{internals:{},pluginConfig:{DownloadsPageEnabled:true},t:()=>'',escapeHtml:s=>String(s??''),cdn:{selfhst:()=>''},toast:()=>{},
  session:{getEpoch:()=>0,isCurrent:e=>e===0,onUserChange:()=>()=>{}},
  helpers:{clearAvatarObjectUrlCache(){},hydrateAvatarImages(){},isAdmin:()=>false,onSidebarRebuilt(){},onNavigate:()=>()=>{}},
  core:{api:{plugin:async p=>p==='/arr/queue'?{items:[]}:{requests:[],items:[]}},ui:{injectCss(){},skeletonGridHtml:()=>'',isTvLayout:()=>false},lifecycle:{register:()=>({track:r=>r,untrack(){}})}}},
  apiClient:{ajax:async()=>({results:[]}),getUrl:p=>p,serverAddress:()=>'http://server'}});
 t.after(()=>h.close());
 for(const f of files)h.load('arr/requests/requests-page-'+f+'.js');
 return h;
}
test('in-app navigation to Downloads keeps it over the router\'s Page not found page by hash or router, and leaving still hides it',async t=>{
 const h=setup(t);const router=installJellyfinRouter(h);h.JE.downloadsPage.initialize();
 await router.go('#/downloads');assert.deepEqual(router.seen(),{visible:['je-downloads-page'],title:'Requests'});
 await router.go('#/home');assert.deepEqual(router.seen(),{visible:['indexPage'],title:'Home'});
 await router.push('#/downloads');assert.deepEqual(router.seen(),{visible:['je-downloads-page'],title:'Requests'});
 await router.push('#/home');assert.deepEqual(router.seen(),{visible:['indexPage'],title:'Home'});
});
