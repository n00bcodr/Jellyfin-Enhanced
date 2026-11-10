import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,deferred,plain} from '../helpers/harness.mjs';
const entries=['styles','data','render-events','render-views','actions','init'];
function setup(t, api=async()=>({events:[]})) {
 let epoch=0,server='one';const resets=new Map(),lives=new Map();
 const h=createHarness({url:'http://jellyfin.test/web/index.html#/home',JE:{currentSettings:{},pluginConfig:{CalendarPageEnabled:true},
 session:{getEpoch:()=>epoch,isCurrent:e=>e===epoch,getServerId:()=>server,userScopedKey:k=>`${k}:u`,onUserChange:(k,f)=>{resets.set(k,f);return()=>resets.delete(k);}},
 t:k=>k,escapeHtml:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),cdn:{selfhst:p=>'https://icons.test/'+p},
 helpers:{onNavigate:()=>()=>{},onSidebarRebuilt:()=>()=>{},isActiveTabContainer:el=>el.isConnected&&!el.closest('.hide')},
 core:{api:{plugin:api},ui:{injectCss:()=>{},skeletonGridHtml:()=>'<div>loading</div>'},lifecycle:{register:key=>{
 if(lives.has(key))return lives.get(key);const resources=[];const life={track:r=>(resources.push(r),r),untrack:r=>{const i=resources.indexOf(r);if(i>=0)resources.splice(i,1);},teardown:()=>{for(const f of resources.splice(0))f();},addListener:(el,type,fn,capture)=>{el.addEventListener(type,fn,capture);resources.push(()=>el.removeEventListener(type,fn,capture));}};lives.set(key,life);return life;
 }}}}});
 t.after(()=>{for(const l of lives.values())l.teardown();h.close();});
 for(const entry of entries)h.load(`arr/calendar/calendar-page-${entry}.js`);
 return {...h,P:h.JE.internals.calendarPage,change:(s=server)=>{epoch++;server=s;resets.forEach(f=>f());},lives};
}
const event=(id,date='2026-03-08')=>({id,title:id,releaseDate:date,type:'Series',source:'Sonarr',releaseType:'Episode',seasonNumber:1,episodeNumber:1});
test('generated assets retain one shared owner when data is evaluated twice',t=>{
 const h=setup(t);const state=h.P.state;state.events=[event('one')];h.load('arr/calendar/calendar-page-data.js');assert.equal(h.P.state,state);assert.equal(state.events[0].id,'one');
});
test('server-scoped preferences migrate once and filters reload after identity switches',t=>{
 const h=setup(t);h.window.localStorage.setItem('je.calendar.showUnmonitored:u','true');h.P.loadSettings();assert.equal(h.P.state.settings.showUnmonitored,true);
 h.P.state.activeFilters.add('Episode');h.P.saveFilters();assert.equal(h.window.localStorage.getItem('je.calendar.showUnmonitored:u'),null);
 h.change('two');h.P.loadSettings();assert.equal(h.P.state.settings.showUnmonitored,false);assert.equal(h.P.state.activeFilters.size,0);
 h.change('one');h.P.loadSettings();assert.equal(h.P.state.settings.showUnmonitored,true);assert.deepEqual([...h.P.state.activeFilters],['Episode']);
});
test('overlapping refresh rejects old events and old completion rendering',async t=>{
 const slow=deferred();let count=0;const h=setup(t,()=>++count===1?slow.promise:Promise.resolve({events:[event('new')]}));
 const old=h.P.loadAllData();await h.P.loadAllData();slow.resolve({events:[event('old')]});await old;
 assert.equal(h.P.state.events[0].id,'new');assert.equal(h.P.state.isLoading,false);assert.match(h.document.body.textContent,/new/);assert.equal(h.document.querySelector('[data-event-id=old]'),null);
});
test('malformed responses show an error instead of a successful empty calendar',async t=>{
 const h=setup(t,async()=>({events:[{...event('bad'),hasFile:'true'}]}));await h.P.loadAllData();assert.equal(h.P.state.events.length,0);assert.match(h.document.querySelector('[role=alert]').textContent,/could not be loaded/);assert.equal(h.document.querySelector('.je-calendar-empty'),null);
});
test('failed requests remain retryable and never install a partial pagination result',async t=>{
 let calls=0,fail=true;const h=setup(t,async()=>{calls++;if(fail&&calls===2)throw Error('offline');return {requests:[{type:'tv',tmdbId:7}],totalPages:fail?2:1};});h.JE.pluginConfig.JellyseerrEnabled=true;
 await h.P.ensureRequestData();assert.equal(h.P.state.requestedLoaded,false);assert.equal(h.P.state.requestedItems.size,0);assert.ok(h.P.state.requestError);
 fail=false;await h.P.ensureRequestData();assert.equal(h.P.state.requestedLoaded,true);assert.deepEqual([...h.P.state.requestedItems],['tv:7']);assert.equal(h.P.state.requestError,null);
});
test('request pagination stops on a server switch',async t=>{
 const slow=deferred();let calls=0;const h=setup(t,()=>{calls++;return slow.promise;});h.JE.pluginConfig.JellyseerrEnabled=true;
 const run=h.P.ensureRequestData();h.change('two');slow.resolve({requests:[],totalPages:8});await run;assert.equal(calls,1);assert.equal(h.P.state.requestedLoaded,false);
});
test('civil dates and DST boundaries hold in UTC, New York and Perth',t=>{
 const previousTimezone=process.env.TZ;
 try {
  for(const timezone of ['UTC','America/New_York','Australia/Perth']) {
   process.env.TZ=timezone;
   const h=setup(t),dateOnly=event('date-only');
   assert.equal(h.P.eventHasTime(dateOnly),false);
   assert.deepEqual(Object.keys(h.P.groupEventsByDate([dateOnly])),['2026-03-08'],timezone);
   const timestamped=event('timestamped','2026-03-08T01:00:00Z');
   assert.deepEqual(Object.keys(h.P.groupEventsByDate([timestamped])),[timezone==='America/New_York'?'2026-03-07':'2026-03-08'],timezone);
   for(const [date,hours] of [[new Date(2026,2,8,12),timezone==='America/New_York'?23:24],[new Date(2026,10,1,12),timezone==='America/New_York'?25:24]]) {
    const range=h.P.getRangeForView(date,'day');
    assert.equal(range.start.getHours(),0,timezone);assert.equal(range.end.getHours(),23,timezone);
    assert.equal(range.end-range.start+1,hours*60*60*1000,timezone);
   }
  }
 } finally {
  if(previousTimezone===undefined)delete process.env.TZ;else process.env.TZ=previousTimezone;
 }
});
test('episode collapsing follows local day and expands via the generated click handler',t=>{
 const h=setup(t);h.P.loadSettings();const events=[event('one','2026-03-08T23:30:00-04:00'),{...event('two','2026-03-08T23:45:00-04:00'),title:'one',episodeNumber:2}];h.P.state.events=events;
 const grouped=h.P.collapseEpisodes(events);assert.equal(grouped.length,1);assert.equal(grouped[0].groupMembers.length,2);
 h.P.state.expandedGroups.add(grouped[0].groupKey);assert.equal(h.P.collapseEpisodes(events).length,2);
});
test('delayed provider navigation cannot cross account switch',async t=>{
 const slow=deferred();const h=setup(t,()=>slow.promise);h.P.state.events=[{...event('one'),hasFile:true,tmdbId:7}];
 h.document.body.innerHTML='<div class="je-calendar-card" data-event-id="one"></div>';h.document.addEventListener('click',h.P.handleEventClick);h.document.querySelector('.je-calendar-card').click();
 h.change();slow.resolve('private-item');await new Promise(r=>setImmediate(r));assert.equal(h.window.location.hash,'#/home');
});
test('custom target disappearance invalidates pending data and teardown removes navigation listeners',async t=>{
 const slow=deferred();const h=setup(t,()=>slow.promise);h.JE.calendarPage.initialize();const target=h.document.createElement('div');h.document.body.appendChild(target);h.JE.calendarPage.renderForCustomTab(target);target.remove();
 slow.resolve({events:[event('stale')]});await new Promise(r=>setImmediate(r));assert.equal(h.P.state.events.length,0);
 h.lives.get('arr-calendar-page').teardown();h.window.history.replaceState(null,'','#/calendar');h.window.dispatchEvent(new h.window.HashChangeEvent('hashchange'));assert.equal(h.P.state.pageVisible,false);
});
test('custom/native tab watcher remounts replaced nodes, invalidates inactive views and disposes resources',async t=>{
 const h=setup(t);h.JE.pluginConfig.CalendarUseNativeTab=true;let reconcile,stops=0,registered=0;
 h.JE.nativeTabs={register:(id,title,mount)=>{registered++;const panel=h.document.createElement('div');h.document.body.appendChild(panel);mount(panel);}};
 h.JE.helpers.observeTabContainers=(id,selector,callback)=>{reconcile=callback;return{teardown:()=>stops++};};
 h.load('arr/calendar/calendar-custom-tab.js');await new Promise(r=>setImmediate(r));assert.equal(registered,1);assert.ok(h.P.state._customTabContainer?.isConnected);
 const first=h.P.state._customTabContainer;first.parentElement.remove();reconcile();assert.equal(h.P.state._customTabContainer,null);
 const replacement=h.document.createElement('div');replacement.className='jellyfinenhanced calendar';h.document.body.appendChild(replacement);reconcile();await new Promise(r=>setImmediate(r));assert.notEqual(h.P.state._customTabContainer,first);
 h.window.history.replaceState(null,'','#/details?id=x');reconcile();assert.equal(h.P.state._customTabContainer,null);
 h.lives.get('arr-calendar-custom-owner').teardown();assert.equal(stops,1);
});
test('UI teardown and reinitialization retains identity invalidation',t=>{
 const h=setup(t);h.JE.calendarPage.initialize();h.lives.get('arr-calendar-page').teardown();h.JE.calendarPage.initialize();h.P.state.events=[event('private')];h.change();assert.equal(h.P.state.events.length,0);
});
test('logout and return to the same server rejects a prior session continuation',async t=>{
 const slow=deferred();const h=setup(t,()=>slow.promise);const pending=h.P.fetchCalendarEvents(new Date(),new Date());h.change();h.change();h.P.state.events=[event('current')];slow.resolve({events:[event('old')]});assert.equal(await pending,null);assert.equal(h.P.state.events[0].id,'current');
});
test('interrupted preference migration preserves legacy data for retry',t=>{
 const h=setup(t);const storage=h.window.localStorage;storage.setItem('je.calendar.collapseEpisodes:u','false');const prototype=Object.getPrototypeOf(storage),original=prototype.setItem;prototype.setItem=()=>{throw new Error('quota');};
 h.P.loadSettings();assert.equal(storage.getItem('je.calendar.collapseEpisodes:u'),'false');prototype.setItem=original;
 h.P.loadSettings();assert.equal(h.P.state.settings.collapseEpisodes,false);assert.equal(storage.getItem('je.calendar.collapseEpisodes:u'),null);assert.equal(storage.getItem('je.calendar.collapseEpisodes:u:server:one'),'false');
});
