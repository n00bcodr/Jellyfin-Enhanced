import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness, deferred, plain} from '../helpers/harness.mjs';

function setup(t, extra = {}) {
  let epoch = 0;
  let change;
  const requests = [];
  const notices = [];
  const h = createHarness({JE: {
    currentSettings: {}, pluginConfig: {},
    session: {userScopedKey: key => `${key}:user-${epoch}`, onUserChange: (_key, fn) => {change = fn;}, getEpoch: () => epoch, isCurrent: e => epoch === e},
    core: {api: {plugin: async (...args) => {requests.push(args); return {};}}},
    toast: text => notices.push(text), ...extra
  }});
  t.after(() => h.close());
  h.load('arr/calendar/calendar-page-data.js');
  return {...h, P: h.JE.internals.calendarPage, requests, notices, switchUser: () => {epoch++; change();}};
}

test('calendar migrates legacy preference once and isolates subsequent users', t => {
  const h = setup(t);
  h.window.localStorage.setItem('je.calendar.showUnmonitored', 'true');
  h.P.loadSettings();
  assert.equal(h.P.state.settings.showUnmonitored, true);
  assert.equal(h.window.localStorage.getItem('je.calendar.showUnmonitored'), null);
  // User 0 keeps the non-default true, so reading its key after the switch would show.
  assert.equal(h.window.localStorage.getItem('je.calendar.showUnmonitored:user-0'), 'true');
  h.switchUser(); h.P.loadSettings();
  assert.equal(h.P.state.settings.showUnmonitored, false);
  h.P.setStoredShowUnmonitored(false);
  assert.equal(h.window.localStorage.getItem('je.calendar.showUnmonitored:user-1'), 'false');
  assert.equal(h.window.localStorage.getItem('je.calendar.showUnmonitored:user-0'), 'true');
});

test('calendar mandatory requests filter cannot be bypassed by inverted interactive filters', t => {
  const h = setup(t, {pluginConfig: {CalendarForceOnlyRequested: true, CalendarShowOnlyRequested: true}});
  const s = h.P.state;
  s.activeFilters.add('Requests'); h.P.loadSettings();
  assert.equal(s.activeFilters.has('Requests'), false);
  s.requestedItems.add('tv:42');
  const events = [
    {id:'requested', type:'Series',tmdbId:42, releaseType:'Episode'},
    {id:'other', type:'Movie',tmdbId:42, releaseType:'DigitalRelease'},
    {id:'unmonitored', type:'Series',tmdbId:42,monitored:false},
  ];
  assert.deepEqual(plain(h.P.filterEvents(events)).map(x=>x.id), ['requested']);
  s.activeFilters.add('Available'); s.filterInvert = true;
  assert.deepEqual(plain(h.P.filterEvents(events)).map(x=>x.id), ['requested']);
});

test('calendar any/all filters honor favorites, watched, availability and library access', t => {
  const h = setup(t); h.P.loadSettings(); const s = h.P.state;
  s.userDataMap.set('a', {isFavorite:true,isWatched:false});
  s.userDataMap.set('b', {isFavorite:false,isWatched:true});
  const events = [{id:'a',itemId:'1',hasFile:true},{id:'b',itemId:'2'}, {id:'denied',itemId:'3',hasFile:true}];
  s.activeFilters.add('Watchlist'); s.activeFilters.add('Available');
  assert.deepEqual(plain(h.P.filterEvents(events)).map(x=>x.id), ['a']);
  s.activeFilters.add('Watched');
  assert.deepEqual(plain(h.P.filterEvents(events)).map(x=>x.id), ['a','b']);
  s.filterMatchMode='all'; assert.equal(h.P.filterEvents(events).length,0);
  s.activeFilters.clear(); assert.deepEqual(plain(h.P.filterEvents(events)).map(x=>x.id), ['a','b']);
});

test('calendar errors are escaped, deduplicated and shown again after recovery', async t => {
  const error = {source:'<img>',instanceName:'" onmouseover="bad',reason:"<script>alert('x')</script>"};
  let data = {events:[null,{}, {id:'ok',releaseDate:'2026-02-01'}],errors:[error]};
  const h = setup(t,{core:{api:{plugin:async()=>data}}});
  const start = new Date('2026-02-01'); const end = new Date('2026-02-28');
  await h.P.fetchCalendarEvents(start,end); await h.P.fetchCalendarEvents(start,end);
  assert.equal(h.P.state.events.length,1); assert.equal(h.notices.length,1);
  assert.ok(!h.notices[0].includes('<script>')); assert.ok(h.notices[0].includes('&lt;script&gt;'));
  data={events:[],errors:[]}; await h.P.fetchCalendarEvents(start,end);
  data={errors:[error]}; await h.P.fetchCalendarEvents(start,end); assert.equal(h.notices.length,2);
  h.expectConsoleError('Calendar Page: Failed to fetch calendar events: Error: offline');
  h.JE.core.api.plugin=async()=>{throw Error('offline');};
  assert.equal(await h.P.fetchCalendarEvents(start,end),null); assert.equal(h.P.state.events.length,0);
});

test('calendar drops user-data responses arriving after account switch', async t => {
  const pending=deferred(); const h=setup(t,{core:{api:{plugin:()=>pending.promise}}});
  h.P.state.settings.highlightFavorites=true; h.P.state.events=[{id:'old',title:'Old'}];
  const run=h.P.fetchUserData(); h.switchUser();
  h.P.state.userDataMap.set('new',{isFavorite:true});
  pending.resolve({results:[{id:'old',isFavorite:true}]}); await run;
  assert.deepEqual([...h.P.state.userDataMap.keys()],['new']);
});

test('calendar requests paginate, normalize type, deduplicate and load only once', async t => {
  const calls=[];
  const h=setup(t,{pluginConfig:{JellyseerrEnabled:true},core:{api:{plugin:async path=>{
    calls.push(path); return {totalPages:2,requests: calls.length===1 ? [{type:'TV',tmdbId:7},{type:'tv',tmdbId:7},{type:'movie'}] : [{type:'Movie',tmdbId:8}]};
  }}}});
  await h.P.ensureRequestData(); await h.P.ensureRequestData();
  assert.deepEqual([...h.P.state.requestedItems],['tv:7','movie:8']);
  assert.equal(calls.length,2); assert.equal(new URL(calls[1],'http://test').searchParams.get('skip'),'200');
  assert.equal(new URL(calls[0],'http://test').searchParams.get('userOnly'),'true');
});

test('calendar pending requests cannot install previous account state', async t => {
  const pending=deferred(); const h=setup(t,{pluginConfig:{JellyseerrEnabled:true},core:{api:{plugin:()=>pending.promise}}});
  const run=h.P.ensureRequestData(); h.switchUser(); pending.resolve({requests:[{type:'movie',tmdbId:1}]}); await run;
  assert.equal(h.P.state.requestedItems.size,0); assert.equal(h.P.state.requestedLoaded,false);
});

test('calendar Shoko lookup tries episode then series after a missing match and supports series preference', async t=>{
  const calls=[]; const h=setup(t,{core:{api:{plugin:async path=>{calls.push(new URL(path,'http://test')); if(calls.length===1) throw {status:404}; return 'series-id';}}}});
  const event={type:'Series',shokoEpisodeId:10,shokoSeriesId:20};
  assert.equal(await h.P.searchFromProviders(event),'series-id');
  assert.equal(calls[0].searchParams.get('providers[Shoko Episode]'),'10');
  assert.equal(calls[0].searchParams.get('types'),'Episode');
  assert.equal(calls[1].searchParams.get('types'),'Series');
  calls.length=0;
  await h.P.searchFromProviders(event,{preferSeries:true});
  assert.equal(calls.length,1); assert.equal(calls[0].searchParams.get('types'),'Series');
  assert.equal(await h.P.searchFromProviders({}),null);
});

function rendering(t) {
  const h=setup(t,{escapeHtml: value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),cdn:{selfhst:path=>`https://icons.test/${path}`},t:key=>key,pluginConfig:{ShokoUrl:'http://internal-shoko/',ShokoUrlMappings:'http://jellyfin.test | https://public.test/shoko/'}});
  h.window.ApiClient.getImageUrl=id=>`http://jellyfin.test/Items/${id}/Images/Primary`;
  h.load('arr/calendar/calendar-page-render-events.js');return h;
}
test('calendar date ranges include leap day, week boundary, and thirty agenda days',t=>{
  const h=rendering(t);const d=new Date(2024,1,29,12);
  const month=h.P.getRangeForView(d,'month');assert.equal(month.start.getDate(),1);assert.equal(month.end.getDate(),29);assert.equal(month.end.getHours(),23);
  const week=h.P.getRangeForView(new Date(2024,2,3),'week');assert.equal(week.start.getDate(),26);assert.equal(week.start.getMonth(),1);assert.equal(week.end.getDate(),3);
  const agenda=h.P.getRangeForView(d,'agenda');assert.equal(agenda.end.getMonth(),2);assert.equal(agenda.end.getDate(),29);
  const day=h.P.getRangeForView(d,'day');assert.equal(day.start.getHours(),0);assert.equal(day.end.getMilliseconds(),999);
});
test('calendar Shoko cards escape metadata, map public URLs, and use Jellyfin posters',t=>{
  const h=rendering(t);const event={id:'x" onclick="bad',title:'<img src=x onerror=bad>',subtitle:'<script>bad</script>',source:'Shoko',instanceName:'<b>anime</b>',alsoInInstances:['Other'],type:'Series',releaseType:'Anime',releaseDate:'2026-02-01',shokoSeriesId:42,itemId:'safe-id'};
  h.document.body.innerHTML=h.P.renderCardItems([event]);
  assert.equal(h.document.querySelector('script'),null);assert.equal(h.document.querySelector('[onerror]'),null);
  assert.equal(h.document.querySelector('.je-calendar-card').getAttribute('data-event-id'),event.id);
  assert.equal(h.document.querySelector('.je-calendar-card-title-text').textContent,event.title);
  assert.equal(h.document.querySelector('.je-calendar-shoko-link').href,'https://public.test/shoko/webui/collection/series/42');
  assert.match(h.document.body.innerHTML,/Items\/safe-id\/Images\/Primary/);
  assert.equal(h.document.querySelector('.je-arr-badge').textContent,'<b>anime</b>, Other');
});

function actions(t){
  const h=rendering(t);const saved=[];h.JE.saveUserSettings=(file,settings)=>saved.push({file,settings:{...settings}});
  h.P.renderPage=()=>{};h.P.syncPageModeClasses=()=>{};h.P.updateDisplayModeButtons=()=>{};h.P.toggleSidebarCollapsed=()=>{};
  h.load('arr/calendar/calendar-page-actions.js');return {...h,saved};
}
test('calendar view and display controls persist user preferences without redundant saves',async t=>{
  const h=actions(t);h.P.setDisplayMode('grid');h.P.setDisplayMode('grid');assert.equal(h.saved.length,1);assert.equal(h.saved[0].settings.calendarDisplayMode,'grid');
  h.P.setViewMode('week');h.P.setViewMode('week');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.saved.length,2);assert.equal(h.saved[1].settings.calendarDefaultViewMode,'week');assert.equal(h.P.state.isLoading,false);
  h.P.toggleShowUnmonitored();assert.equal(h.window.localStorage.getItem('je.calendar.showUnmonitored:user-0'),'true');
});
test('calendar month navigation clamps anchor before shifting from month end',async t=>{
  const h=actions(t);h.P.state.viewMode='month';h.P.state.currentDate=new Date(2024,0,31);
  h.P.shiftPeriod('next');await new Promise(resolve=>setImmediate(resolve));assert.equal(h.P.state.currentDate.getMonth(),1);assert.equal(h.P.state.currentDate.getDate(),1);
  h.P.shiftPeriod('previous');await new Promise(resolve=>setImmediate(resolve));assert.equal(h.P.state.currentDate.getMonth(),0);
});
test('calendar card navigates to series while play button targets episode and unavailable movie stays put',t=>{
  const h=actions(t);h.P.state.events=[{id:'episode',type:'Series',hasFile:true,itemId:'series-id',itemEpisodeId:'episode-id'},{id:'movie',type:'Movie',hasFile:false,itemId:'movie-id'}];
  h.document.body.innerHTML='<div class="je-calendar-card" data-event-id="episode"><button class="je-calendar-play-btn" data-event-id="episode"></button></div><div class="je-calendar-card" data-event-id="movie"></div>';
  h.document.body.addEventListener('click',h.P.handleEventClick);
  h.document.querySelector('.je-calendar-card').click();assert.equal(h.window.location.hash,'#/details?id=series-id');
  h.document.querySelector('button').click();assert.equal(h.window.location.hash,'#/details?id=episode-id');
  h.document.querySelector('[data-event-id="movie"]').click();assert.equal(h.window.location.hash,'#/details?id=episode-id');
});
