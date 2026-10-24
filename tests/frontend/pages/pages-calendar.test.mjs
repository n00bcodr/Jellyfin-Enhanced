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
  return { ...h, get NATIVE() { return h.NATIVE; }, P: h.JE.internals.calendarPage, requests, notices, switchUser: () => {epoch++; change();}};
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
  // 'upcoming' has no Jellyfin item yet (not in any library), so the access check must keep it.
  const events = [{id:'a',itemId:'1',hasFile:true},{id:'b',itemId:'2'}, {id:'denied',itemId:'3',hasFile:true},{id:'upcoming'}];
  s.activeFilters.add('Watchlist'); s.activeFilters.add('Available');
  assert.deepEqual(plain(h.P.filterEvents(events)).map(x=>x.id), ['a']);
  s.activeFilters.add('Watched');
  assert.deepEqual(plain(h.P.filterEvents(events)).map(x=>x.id), ['a','b']);
  s.filterMatchMode='all'; assert.equal(h.P.filterEvents(events).length,0);
  s.activeFilters.clear(); assert.deepEqual(plain(h.P.filterEvents(events)).map(x=>x.id), ['a','b','upcoming']);
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

test('calendar events, instance errors and failures from before an account switch never reach the new account', async t => {
  const late=[deferred(),deferred()]; let calls=0;
  const fresh={events:[{id:'b-event',releaseDate:'2026-02-02'}]};
  const h=setup(t,{core:{api:{plugin:()=>{calls++; return calls===1?late[0].promise:calls===3?late[1].promise:Promise.resolve(fresh);}}}});
  const start=new Date('2026-02-01'); const end=new Date('2026-02-28');
  h.P.state.events=[{id:'a-event',releaseDate:'2026-02-01'}]; h.P.state.userDataMap.set('a-event',{isFavorite:true});
  const lateSuccess=h.P.fetchCalendarEvents(start,end); h.switchUser();
  assert.equal(h.P.state.events.length,0); assert.equal(h.P.state.userDataMap.size,0);
  await h.P.fetchCalendarEvents(start,end);
  late[0].resolve({events:[{id:'a-private',releaseDate:'2026-02-03'}],errors:[{source:'Sonarr',instanceName:'A only',reason:'down'}]});
  assert.equal(await lateSuccess,null);
  assert.deepEqual(plain(h.P.state.events).map(x=>x.id),['b-event']); assert.equal(h.notices.length,0);
  h.expectConsoleError('Calendar Page: Failed to fetch calendar events: Error: offline');
  const lateFailure=h.P.fetchCalendarEvents(start,end); h.switchUser();
  await h.P.fetchCalendarEvents(start,end);
  late[1].reject(new Error('offline')); assert.equal(await lateFailure,null);
  assert.deepEqual(plain(h.P.state.events).map(x=>x.id),['b-event']);
});

for (const outcome of ['resolve','reject']) {
  test(`calendar user-data ${outcome==='resolve'?'responses':'failures'} arriving after account switch keep the new account map`, async t => {
    const pending=deferred(); const h=setup(t,{core:{api:{plugin:()=>pending.promise}}});
    h.P.state.settings.highlightFavorites=true; h.P.state.events=[{id:'old',title:'Old'}];
    const run=h.P.fetchUserData(); h.switchUser();
    h.P.state.userDataMap.set('new',{isFavorite:true});
    if (outcome==='resolve') pending.resolve({results:[{id:'old',isFavorite:true}]}); else pending.reject(new Error('offline'));
    await run;
    assert.deepEqual([...h.P.state.userDataMap.keys()],['new']);
  });
}

test('calendar requests paginate, normalize type, deduplicate and load only once', async t => {
  const calls=[];
  const h=setup(t,{pluginConfig:{JellyseerrEnabled:true},core:{api:{plugin:async path=>{
    calls.push(path); return {totalPages:2,requests: calls.length===1 ? [{type:'TV',tmdbId:7},{type:'tv',tmdbId:7},{type:'movie'}] : [{type:'Movie',tmdbId:8}]};
  }}}});
  await h.P.ensureRequestData(); await h.P.ensureRequestData();
  assert.deepEqual([...h.P.state.requestedItems],['tv:7','movie:8']);
  assert.equal(calls.length,2); assert.equal(new URL(calls[1],'http://test').searchParams.get('skip'),'200');
  assert.equal(new URL(calls[0],'http://test').searchParams.get('userOnly'),'true');
  // The next user starts empty and loads their own requests.
  h.switchUser();
  assert.equal(h.P.state.requestedItems.size,0); assert.equal(h.P.state.requestedLoaded,false);
  await h.P.ensureRequestData(); assert.equal(calls.length,4);
});

test('calendar pending requests cannot install previous account state', async t => {
  const pending=deferred(); let calls=0;
  const h=setup(t,{pluginConfig:{JellyseerrEnabled:true},core:{api:{plugin:()=>++calls===1?pending.promise:Promise.resolve({requests:[{type:'movie',tmdbId:2}]})}}});
  const run=h.P.ensureRequestData(); h.switchUser();
  // The previous user's in-flight load must not block the new user's.
  assert.equal(h.P.state.requestedLoading,false);
  await h.P.ensureRequestData(); assert.equal(calls,2);
  assert.deepEqual([...h.P.state.requestedItems],['movie:2']);
  pending.resolve({requests:[{type:'movie',tmdbId:1}]}); await run;
  assert.deepEqual([...h.P.state.requestedItems],['movie:2']);
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
  h.load('core/mutation-queue.js');h.load('arr/calendar/calendar-page-actions.js');return {...h,get NATIVE(){return h.NATIVE;},saved};
}
test('Play of an episode the server found by its number opens that episode, not the series', async t => {
  const h = actions(t);
  // The server answers with the playable episode item it found (by season and episode number) as the event's Play target.
  h.P.state.events = [{ id: 'by-number', type: 'Series', hasFile: true, itemId: 'series-id', itemEpisodeId: 'episode-id',
    tvdbId: 501, episodeTvdbId: 9042, seasonNumber: 1, episodeNumber: 1 }];
  h.JE.core.api.plugin = async () => null;
  h.document.body.innerHTML = '<button class="je-calendar-play-btn" data-event-id="by-number"></button>';
  h.document.body.addEventListener('click', h.P.handleEventClick);
  h.document.querySelector('button').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.window.location.hash, '#/details?id=episode-id');
});
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

test('with native details on, a title without a file opens its page by key (the episode from Play, the series from the card)', async t => {
  const h = actions(t);
  const keyed = [];
  h.JE.titleDetails = { available: () => true, openKey: async (key, o) => { keyed.push({ key, ...o }); return true; } };
  h.P.state.events = [
    {id: 'movie', type: 'Movie', hasFile: false, tmdbId: 438631},
    {id: 'ep', type: 'Series', hasFile: false, tvdbId: 393189, tmdbId: 83867, seasonNumber: 1, episodeNumber: 3},
    {id: 'imdb', type: 'Movie', hasFile: false, imdbId: 'tt0111161'}
  ];
  h.document.body.innerHTML = '<div class="je-calendar-card" data-event-id="movie"></div><div class="je-calendar-card" data-event-id="ep"></div><div class="je-calendar-card" data-event-id="imdb"></div>';
  h.document.body.addEventListener('click', h.P.handleEventClick);
  // The series card: no file anywhere, the provider lookup finds no item → the series page.
  h.JE.core.api.plugin = async () => { throw Object.assign(new Error('HTTP 400'), {status: 400}); };
  for (const id of ['movie', 'ep', 'imdb']) h.document.querySelector(`[data-event-id="${id}"]`).click();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(keyed.length, 3);
  assert.ok(keyed.some(k => k.key === 'movie:tmdb:438631' && k.mediaType === 'movie'));
  assert.ok(keyed.some(k => k.key === 'movie:imdb:tt0111161'));
  assert.ok(keyed.some(k => k.key === 'tv:tvdb:393189' && k.season === undefined), 'the card opens the series');
  // Play on an episode whose file Jellyfin hasn't got for this viewer: that episode's page.
  keyed.length = 0;
  h.P.state.events.push({id: 'epfile', type: 'Series', hasFile: true, tvdbId: 393189, seasonNumber: 1, episodeNumber: 3});
  h.document.body.insertAdjacentHTML('beforeend', '<div class="je-calendar-card" data-event-id="epfile"><button class="je-calendar-play-btn" data-event-id="epfile"></button></div>');
  h.document.querySelector('[data-event-id="epfile"] button').click();
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(keyed.map(k => [k.key, k.season, k.episode]), [['tv:tvdb:393189', 1, 3]]);
  // Native details off: nothing opens for a title without a file (as before).
  keyed.length = 0;
  h.JE.titleDetails.available = () => false;
  h.document.querySelector('[data-event-id="movie"]').click();
  await new Promise(r => setTimeout(r, 5));
  assert.equal(keyed.length, 0);
});

test('a date-only release is on its own day west of UTC, with no clock time, and the request names the viewer\'s days', async t => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; });
  let asked = null;
  const data = {events: [
    {id: 'movie', type: 'Movie', releaseType: 'DigitalRelease', releaseDate: '2026-10-20T00:00:00.0000000Z', dateOnly: true, releaseDateLocal: '2026-10-20'},
    {id: 'episode', type: 'Series', releaseType: 'Episode', releaseDate: '2026-10-21T02:00:00.0000000Z'}
  ], errors: []};
  const h = setup(t, {core: {api: {plugin: async path => {asked = path; return data;}}}});
  await h.P.fetchCalendarEvents(new h.window.Date(2026, 9, 1), new h.window.Date(2026, 9, 31, 23, 59));
  const query = new URLSearchParams(asked.slice(asked.indexOf('?') + 1));
  assert.equal(query.get('startDay'), '2026-10-01');
  assert.equal(query.get('endDay'), '2026-10-31');
  const grouped = plain(h.P.groupEventsByDate(h.P.state.events));
  // The release day stays the 20th (read as midnight UTC it would be the 19th at 5 PM here); the
  // timed episode (02:00 UTC on the 21st) is the evening of the 20th here.
  assert.deepEqual(Object.keys(grouped).sort(), ['2026-10-20']);
  assert.deepEqual(grouped['2026-10-20'].map(e => e.id).sort(), ['episode', 'movie']);
  const movie = h.P.state.events.find(e => e.id === 'movie');
  const local = new h.window.Date(movie.releaseDate);
  assert.deepEqual([local.getHours(), local.getMinutes()], [0, 0]);
  assert.equal(movie.releaseDateUtc, '2026-10-20T00:00:00.0000000Z');
});

// ---------------------------------------------------------------- a failed load says so (C53)
function page(t, api) {
  const h=setup(t,{t:key=>key,escapeHtml:value=>String(value??''),cdn:{selfhst:path=>`https://icons.test/${path}`},core:{api:{plugin:(...args)=>api(...args)}}});
  h.window.ApiClient.getImageUrl=id=>`http://jellyfin.test/Items/${id}/Images/Primary`;
  h.load('arr/calendar/calendar-page-render-events.js');
  h.load('arr/calendar/calendar-page-render-views.js');
  h.load('arr/calendar/calendar-page-actions.js');
  const box=h.document.createElement('div');h.document.body.appendChild(box);
  h.P.renderPage(box);
  return {...h,get NATIVE(){return h.NATIVE;},box,alert:()=>box.querySelector('[role="alert"]')};
}
for (const view of ['month','week','agenda','day']) {
  test(`calendar ${view} view shows the load error with a retry, never "No upcoming releases"`, async t=>{
    let fail=true; const calls=[];
    const h=page(t,async path=>{calls.push(path); if(fail) throw new Error('offline'); return {events:[],errors:[]};});
    h.expectConsoleError('Calendar Page: Failed to fetch calendar events: Error: offline');
    h.P.state.viewMode=view;
    await h.P.loadAllData();
    assert.ok(h.alert(),'role=alert box');
    assert.match(h.alert().textContent,/calendar_load_error/);
    assert.equal(h.alert().querySelector('button').textContent,'arr_hub_retry');
    assert.match(h.alert().querySelector('button').getAttribute('onclick'),/calendarPage\.retry\(\)/);
    assert.doesNotMatch(h.box.innerHTML,/calendar_no_releases/);
    // Retry reads again; an empty answer is "No upcoming releases".
    fail=false; await h.P.retry();
    assert.equal(h.alert(),null); assert.match(h.box.innerHTML,/calendar_no_releases/);
    assert.equal(calls.length,2);
  });
}
test('retrying a failed calendar load keeps opaque row ids and restores date-only releases on their local day', async t => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; });
  let fail = true;
  const h = page(t, async () => {
    if (fail) throw new Error('offline');
    return { events: [{ id: 'radarr|instance-a|42-DigitalRelease', title: 'Film', type: 'Movie',
      releaseType: 'DigitalRelease', monitored: true, dateOnly: true,
      releaseDate: '2026-10-20T00:00:00Z', releaseDateLocal: '2026-10-20' }], errors: [] };
  });
  h.P.state.currentDate = new h.window.Date(2026, 9, 20);
  h.expectConsoleError('Calendar Page: Failed to fetch calendar events: Error: offline');
  await h.P.loadAllData();
  assert.ok(h.alert());
  fail = false;
  await h.P.retry();
  assert.equal(h.alert(), null);
  const event = h.P.state.events[0];
  assert.equal(event.id, 'radarr|instance-a|42-DigitalRelease');
  assert.equal(event.releaseDateUtc, '2026-10-20T00:00:00Z');
  assert.equal(new h.window.Date(event.releaseDate).getHours(), 0);
  assert.deepEqual(Object.keys(plain(h.P.groupEventsByDate(h.P.state.events))), ['2026-10-20']);
});
test('calendar retry ignores clicks while a load runs; per-instance errors and a failed next range', async t=>{
  let answer=()=>Promise.resolve({events:[],errors:[{source:'Sonarr',instanceName:'TV',reason:'timeout'}]}); const calls=[];
  const h=page(t,async path=>{calls.push(path); return answer();});
  await h.P.loadAllData();
  // An instance that couldn't be read is a toast, not the load error (the other instances' rows show).
  assert.equal(h.alert(),null); assert.equal(h.notices.length,1); assert.match(h.box.innerHTML,/calendar_no_releases/);
  const slow=deferred(); answer=()=>slow.promise;
  const loading=h.P.retry(); assert.equal(h.P.state.isLoading,true);
  assert.equal(h.P.retry(),undefined); assert.equal(calls.length,2);       // a second click starts nothing
  slow.resolve({events:[{id:'sonarr|a|1',title:'Show',releaseDate:new Date().toISOString(),type:'Series',releaseType:'Episode',monitored:true}],errors:[]}); await loading;
  assert.equal(h.P.state.events.length,1);
  // The next range fails: its error replaces the rows (they belong to the other range).
  h.expectConsoleError('Calendar Page: Failed to fetch calendar events: Error: offline');
  answer=()=>Promise.reject(new Error('offline'));
  h.P.shiftPeriod('next'); await new Promise(resolve=>setTimeout(resolve,0));
  assert.ok(h.alert()); assert.equal(h.P.state.events.length,0);
  // Another user starts without the previous user's error.
  h.switchUser(); assert.equal(h.P.state.eventsError,false);
});
test('a late failure from before an account switch leaves the new account without the error', async t=>{
  const late=deferred(); let calls=0;
  const h=page(t,()=>++calls===1?late.promise:Promise.resolve({events:[],errors:[]}));
  h.expectConsoleError('Calendar Page: Failed to fetch calendar events: Error: offline');
  const run=h.P.fetchCalendarEvents(new Date(),new Date()); h.switchUser();
  late.reject(new Error('offline')); await run;
  assert.equal(h.P.state.eventsError,false);
});

// ---------------------------------------------------------------- row ids are opaque and per instance (C111)
test('calendar rows with the same arr id on two instances keep their own flags and open their own title', async t=>{
  const h=actions(t);
  const a={id:'sonarr|inst-a|42',type:'Series',hasFile:true,itemId:'series-a',releaseType:'Episode',monitored:true};
  const b={id:'sonarr|inst-b|42',type:'Series',hasFile:true,itemId:'series-b',releaseType:'Episode',monitored:true};
  h.P.state.events=[a,b];
  h.P.state.userDataMap.set(a.id,{isFavorite:true,isWatched:false});
  h.P.state.userDataMap.set(b.id,{isFavorite:false,isWatched:true});
  h.P.state.activeFilters.add('Watchlist');
  assert.deepEqual(plain(h.P.filterEvents(h.P.state.events)).map(e=>e.itemId),['series-a']);
  h.P.state.activeFilters.clear(); h.P.state.activeFilters.add('Watched');
  assert.deepEqual(plain(h.P.filterEvents(h.P.state.events)).map(e=>e.itemId),['series-b']);
  h.document.body.innerHTML=h.P.renderCardItems([a,b]);
  h.document.body.addEventListener('click',h.P.handleEventClick);
  h.document.querySelector(`.je-calendar-card[data-event-id="${b.id}"]`).click();
  assert.equal(h.window.location.hash,'#/details?id=series-b');
  h.document.querySelector(`.je-calendar-card[data-event-id="${a.id}"]`).click();
  assert.equal(h.window.location.hash,'#/details?id=series-a');
});

test('the "Filter by Library Access" setting says how upcoming titles are placed and how to fix hidden ones', async () => {
  const {readFileSync} = await import('node:fs');
  const {resolve} = await import('node:path');
  const {repositoryRoot} = await import('../helpers/discovery.mjs');
  const page = readFileSync(resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/Configuration/configPage.html'), 'utf8');
  const block = page.slice(page.indexOf('data-desc-for="calendarFilterByLibraryAccess"'));
  const text = block.slice(0, block.indexOf('</div>')).replace(/\s+/g, ' ');
  // Fail closed: titles whose library can't be told are hidden, and the fix is named.
  assert.match(text, /linked to its Sonarr\/Radarr instance/);
  assert.match(text, /path mappings/);
  assert.match(text, /hidden from them: set a path mapping or link libraries on the instance/);
  assert.doesNotMatch(text, /filtered based on their Sonarr\/Radarr root folder/);
});

test('the calendar takes over when Jellyfin answers its own #/calendar route with another page', t => {
  const h = createHarness({
    html: '<div class="mainAnimatedPage" id="homePage">home</div>',
    url: 'http://jellyfin.test/web/index.html#/home',
    JE: { pluginConfig: { CalendarPageEnabled: true }, t: key => key, helpers: { onSidebarRebuilt: () => () => {} }, core: { lifecycle: { register: () => ({ track: f => f, untrack: () => {} }) }, navigation: { onNavigate: () => () => {} } } },
  });
  t.after(() => h.close());
  h.JE.internals = h.JE.internals || {};
  const P = h.JE.internals.calendarPage = { state: { pageVisible: false, isLoading: true } };
  let loads = 0;
  Object.assign(P, {
    injectStyles: () => {}, loadSettings: () => {}, renderPage: () => {}, loadAllData: () => { loads++; }, handleEventClick: () => {},
    createPageContainer: () => {
      let page = h.document.getElementById('je-calendar-page');
      if (!page) { page = h.document.createElement('div'); page.id = 'je-calendar-page'; page.className = 'mainAnimatedPage hide'; h.document.body.appendChild(page); }
      return page;
    },
  });
  h.load('arr/calendar/calendar-page-init.js');
  h.JE.calendarPage.initialize?.();
  // A hash change to #/calendar inside the app: Jellyfin's router shows its own "Page not found" page.
  h.window.history.replaceState(null, '', '#/calendar');
  const notFound = h.document.createElement('div');
  notFound.className = 'mainAnimatedPage';
  notFound.textContent = 'Page not found';
  h.document.body.appendChild(notFound);
  h.document.getElementById('homePage').classList.add('hide');
  notFound.dispatchEvent(new h.window.CustomEvent('viewshow', { bubbles: true }));
  const calendar = h.document.getElementById('je-calendar-page');
  assert.ok(calendar && !calendar.classList.contains('hide'), 'the calendar shows');
  assert.ok(notFound.classList.contains('hide'), 'Jellyfin\'s page for the route is hidden');
  // Another route's page still hides the calendar as before.
  h.window.history.replaceState(null, '', '#/home');
  const home = h.document.getElementById('homePage');
  home.classList.remove('hide');
  home.dispatchEvent(new h.window.CustomEvent('viewshow', { bubbles: true }));
  assert.ok(calendar.classList.contains('hide'));
});
