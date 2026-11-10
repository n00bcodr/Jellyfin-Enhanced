import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,deferred} from '../helpers/harness.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
function setup(t,{api=async()=>({events:[]}),settings=false}={}) {
 const posts=[];
 const h=createHarness({url:'http://jellyfin.test/web/index.html#/home',JE:{
  currentSettings:{},userConfig:{settings:{},settingsRevision:'r1'},pluginConfig:{CalendarPageEnabled:true},
  t:k=>k,escapeHtml:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),cdn:{selfhst:p=>'https://icons.test/'+p},
  helpers:{onNavigate:()=>()=>{},onSidebarRebuilt:()=>()=>{},isActiveTabContainer:el=>el.isConnected&&!el.closest('.hide')},
  core:{api:{plugin:api},ui:{injectCss:()=>{},skeletonGridHtml:()=>'<div>loading</div>'},lifecycle:{register:()=>({track:r=>r,untrack:()=>{},teardown:()=>{},addListener:()=>{}})}}
 },apiClient:{ajax:async req=>{posts.push(JSON.parse(req.data));return {Revision:'r2'};}}});
 t.after(()=>h.close());
 if(settings){h.load('enhanced/config.js');h.JE.currentSettings=h.JE.loadSettings();}
 for(const part of ['styles','data','render-events','render-views','actions','init']){
  const path=`arr/calendar/calendar-page-${part}.js`;
  h.load(path);
 }
 const P=h.JE.internals.calendarPage;P.loadSettings();return {...h,P,posts};
}
const event=(id,extra={})=>({id,title:'Same series',type:'Series',releaseType:'Episode',source:'Sonarr',releaseDate:'2026-11-07T12:00:00Z',seasonNumber:1,episodeNumber:1,...extra});

for (const [action, value] of [['setDisplayMode','cards'], ['setViewMode','week']]) {
 test(`calendar ${action} saves with inherited preferences and date context intact`, async t => {
  const h=setup(t,{settings:true});
  h.JE.currentSettings.statusTagsEnabled=true;
  h.JE.getStatusDateContext=()=>({locale:'en-AU',timeZone:'Australia/Perth'});
  assert.equal(h.JE.isSettingInherited(h.JE.currentSettings,'showEditionTag'),true);
  h.P[action](value);await tick();
  assert.equal(h.posts.length,1);
  const body=h.posts[0].Settings;
  assert.equal(body.showEditionTag,null);
  assert.equal(body.useNativePosterTags,null);
  assert.equal(body.nativePosterDateLocale,'en-AU');
  assert.equal(body.nativePosterTimeZone,'Australia/Perth');
  assert.equal(body[action==='setViewMode'?'calendarDefaultViewMode':'calendarDisplayMode'],value);
 });
 test(`calendar ${action} cannot save a previous identity's settings`, async t => {
  const h=setup(t,{settings:true});
  h.window.ApiClient.getCurrentUserId=()=> 'user-b';
  h.JE.userConfig={settings:{},settingsRevision:'user-b-revision'};
  h.P[action](value);await tick();
  assert.equal(h.posts.length,0);
 });
}
test('collapsed calendar group uses the lowest numbered episode and its metadata',t=>{
 const h=setup(t);
 const input=[event('episode-2',{episodeNumber:2,hasFile:false,releaseDate:'2026-11-07T10:00:00Z'}),event('episode-1',{hasFile:true})];
 const [group]=h.P.collapseEpisodes(input);
 assert.equal(group.id,'episode-1');assert.equal(group.hasFile,true);assert.equal(group.releaseDate,input[1].releaseDate);
 assert.deepEqual(Array.from(group.groupMembers,e=>e.id),['episode-1','episode-2']);
 h.P.state.expandedGroups.add(group.groupKey);
 assert.deepEqual(Array.from(h.P.collapseEpisodes(input),e=>e.id),['episode-1','episode-2']);
});
function click(h,id) {
 const card=h.document.createElement('div');card.className='je-calendar-card';card.dataset.eventId=id;
 h.document.body.append(card);card.click();
}
for (const [action,value] of [['shiftPeriod','next'],['setViewMode','week'],['goToday'],['loadAllData'],['setDisplayMode','cards'],['toggleFilter','Movie'],['toggleCollapseEpisodes'],['toggleShowUnmonitored']]) {
 test(`calendar ${action} cancels delayed navigation while new work remains usable`,async t=>{
  const pending=deferred();let lookups=0;
  const h=setup(t,{api:path=>path.startsWith('/items/')?(++lookups===1?pending.promise:Promise.resolve('new-item')):Promise.resolve({events:[]})});
  h.P.state.events=[event('clicked',{tmdbId:7,hasFile:true})];
  h.document.addEventListener('click',h.P.handleEventClick);click(h,'clicked');
  h.P[action](value);await tick();
  pending.resolve('old-period-item');await tick();
  assert.equal(h.window.location.hash,'#/home');assert.equal(h.P.state.isLoading,false);
  h.P.state.events=[event('new',{tmdbId:8,hasFile:true})];click(h,'new');await tick();
  assert.equal(h.window.location.hash,'#/details?id=new-item');
 });
}
test('new calendar item click wins when provider lookups resolve in reverse order',async t=>{
 const first=deferred(),second=deferred();let lookups=0;
 const h=setup(t,{api:path=>path.startsWith('/items/')?(++lookups===1?first.promise:second.promise):Promise.resolve({events:[]})});
 h.P.state.events=[event('first',{tmdbId:7,hasFile:true}),event('second',{tmdbId:8,hasFile:true})];
 h.document.addEventListener('click',h.P.handleEventClick);click(h,'first');click(h,'second');
 second.resolve('second-item');await tick();first.resolve('first-item');await tick();
 assert.equal(h.window.location.hash,'#/details?id=second-item');
});
