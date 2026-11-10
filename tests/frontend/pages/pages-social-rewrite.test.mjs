import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {createHarness,deferred} from '../helpers/harness.mjs';
async function navigate(h,hash){const changed=new Promise(resolve=>{const listener=e=>{if(new URL(e.newURL).hash===hash){h.window.removeEventListener('hashchange',listener);resolve();}};h.window.addEventListener('hashchange',listener);});h.window.location.hash=hash;await changed;await tick();}
const movie=id=>({Id:id,Name:id,Type:'Movie',ImageTags:{Primary:'poster'}});
function setup(t,{jf,plugin,admin=false}={}) {
 let epoch=0,user='alice',server='http://one.test';const callbacks=new Map(),calls=[],toasts=[];
 const h=createHarness({html:'<main></main>',JE:{pluginConfig:{CatchUpEnabled:true,ActivityFeedEnabled:true,ActivityFeedShowWatched:true,ActivityFeedShowReviewed:true},internals:{},t:()=>'',toast:m=>toasts.push(m),session:{getEpoch:()=>epoch,isCurrent:e=>e===epoch,onUserChange:(k,f)=>callbacks.set(k,f)},core:{api:{jf:async(path,options)=>{calls.push({path,options});return path==='/Users/Me'?{Policy:{IsAdministrator:admin}}:jf?jf(path,options):{Items:[movie('a'),movie('b'),movie('c')]};},plugin:async(path,options)=>{calls.push({path,options});return plugin?plugin(path,options):{items:[]};}},ui:{skeletonGridHtml:()=>''}}},apiClient:{getCurrentUserId:()=>user,getUrl:path=>{if(!path)throw Error('Url name cannot be empty');return server+path;},getImageUrl:()=>''}});
 t.after(()=>h.close());
 for(const file of ['core','styles','deck','activity','page'])h.load(`enhanced/catchup/catchup-${file}.js`);
 const S=h.JE.internals.catchUp,host=h.document.querySelector('main');
 const change=(next='bob',nextServer=server)=>{epoch++;user=next;server=nextServer;callbacks.forEach(f=>f());};
 return {...h,S,host,calls,toasts,change,render:async()=>{h.JE.catchUpPage.renderPage(host);await tick();},button:cls=>h.document.querySelector(`.je-catchup-buttons .${cls}`),top:()=>[...h.document.querySelectorAll('.je-catchup-card:not(.leaving)')].at(-1)?.item};
}
test('Catch Up generated deck progresses, persists dismissal, rewinds and watches',async t=>{
 const h=setup(t);await h.render();assert.equal(h.top().Id,'a');
 h.button('l').click();await tick();assert.equal(h.top().Id,'b');assert.ok(h.S.state.dismissed.has('a'));
 assert.match(h.window.localStorage.getItem('je-catchup-dismissed-alice:http%3A%2F%2Fone.test%2F'),/a/);
 h.button('z').click();await tick();assert.equal(h.top().Id,'a');assert.equal(h.S.state.dismissed.size,0);
 h.button('r').click();await tick();assert.equal(h.top().Id,'b');assert.ok(h.calls.some(c=>c.path==='/Users/alice/PlayedItems/a'&&c.options.method==='POST'));
 h.button('u').click();await tick();assert.ok(h.calls.some(c=>c.path==='/Users/alice/Items/b/Rating?likes=true'));
 h.button('d').click();assert.equal(h.window.location.hash,'#!/details?id=c');
});
test('Catch Up failed action reconciles and does not create a successful undo',async t=>{
 const h=setup(t,{jf:async(path,options)=>{if(options?.method)throw Error('offline');return {Items:[movie('a'),movie('b')]};}});await h.render();h.button('r').click();await tick();
 assert.equal(h.S.state.undoStack.length,0);assert.equal(h.top().Id,'a');assert.match(h.toasts[0],/offline/);
});
test('Catch Up pending action cannot be duplicated or undone before acknowledgement',async t=>{
 const pending=deferred();const h=setup(t,{jf:async(path,options)=>options?.method?pending.promise:{Items:[movie('a'),movie('b')]}});await h.render();
 h.button('r').click();h.button('r').click();h.button('z').click();assert.equal(h.calls.filter(c=>c.options?.method).length,1);assert.equal(h.top().Id,'a');
 pending.resolve({});await tick();assert.equal(h.top().Id,'b');assert.equal(h.S.state.undoStack.length,1);
});
test('Catch Up repeated mounts own one keyboard listener and singleton state',async t=>{
 const h=setup(t);const original=h.S;h.load('enhanced/catchup/catchup-core.js');assert.equal(h.JE.internals.catchUp,original);
 await h.render();await h.render();await h.render();h.document.dispatchEvent(new h.window.KeyboardEvent('keydown',{key:'ArrowRight'}));await tick();
 assert.equal(h.calls.filter(c=>c.options?.method==='POST'&&c.path.includes('/PlayedItems/')).length,1);
 h.host.remove();await tick();assert.equal(h.S.state.queue.length,0);
});
test('Catch Up stale initial response and old-account actions never paint or log into a new account',async t=>{
 const pending=deferred();let delayed=true;const h=setup(t,{jf:async(path,options)=>delayed?pending.promise:{Items:[movie('new')]}});
 h.JE.catchUpPage.renderPage(h.host);h.change();delayed=false;await h.render();pending.resolve({Items:[movie('private')]});await tick();assert.equal(h.top().Id,'new');assert.doesNotMatch(h.host.textContent,/private/);
 const action=deferred();h.JE.core.api.jf=async(path,opts)=>opts?.method?action.promise:{Items:[movie('next')]};h.button('r').click();h.change('carol');await h.render();action.resolve({});await tick();
 assert.equal(h.top().Id,'next');assert.equal(h.S.state.undoStack.length,0);assert.equal(h.calls.filter(c=>c.path==='/catchup/event').length,0);
});
test('Catch Up late action after navigation reloads current server truth',async t=>{
 const pending=deferred();let watched=false;const h=setup(t,{jf:async(path,options)=>{if(options?.method){await pending.promise;watched=true;return {};}return {Items:[movie(watched?'b':'a')]};}});
 await h.render();h.button('r').click();await h.render();assert.equal(h.top().Id,'a');pending.resolve({});await tick();await tick();assert.equal(h.top().Id,'b');
});
test('Catch Up malformed list is an error, not an empty successful deck',async t=>{
 const h=setup(t,{jf:async()=>({Items:'invalid'})});await h.render();assert.match(h.document.querySelector('.je-catchup-empty').textContent,/Failed/);assert.equal(h.top(),undefined);
});
test('Catch Up failed or stale season picker never swipes replacement card',async t=>{
 const pending=deferred();const h=setup(t,{jf:async path=>path.includes('/Seasons?')?pending.promise:{Items:[{...movie('series'),Type:'Series'}]}});await h.render();h.document.querySelector('[data-mode="Series"]').click();await tick();h.button('r').click();
 await h.render();pending.resolve({Items:[{Id:'s1',Name:'One',IndexNumber:1},{Id:'s2',Name:'Two',IndexNumber:2}]});await tick();assert.equal(h.S.state.pickerOpen,false);assert.notEqual(h.document.querySelector('.je-catchup-modal').style.display,'flex');
});
test('Catch Up season selection selects predecessors and submits selected ids',async t=>{
 const h=setup(t,{jf:async(path,options)=>options?.method?{}:path.includes('/Seasons?')?{Items:[1,2,3].map(n=>({Id:`s${n}`,Name:`Season ${n}`,IndexNumber:n,ChildCount:10,UserData:{UnplayedItemCount:5}}))}:{Items:[{...movie('series'),Type:'Series'}]}});
 await h.render();h.document.querySelector('[data-mode="Series"]').click();await tick();h.button('r').click();await tick();const picks=h.document.querySelectorAll('.je-catchup-grid button');picks[1].click();assert.equal(h.document.querySelectorAll('.je-catchup-grid .on').length,2);h.document.querySelector('.je-catchup-modal .primary').click();await tick();
 assert.deepEqual(h.calls.filter(c=>c.path.includes('/PlayedItems/')).map(c=>c.path),['/Users/alice/PlayedItems/s1','/Users/alice/PlayedItems/s2']);
});
test('Catch Up preserves legacy dismissals once and isolates subsequent server/account state',async t=>{
 const h=setup(t);h.window.localStorage.setItem('je-catchup-dismissed-alice','["a"]');await h.render();assert.equal(h.top().Id,'b');assert.equal(h.window.localStorage.getItem('je-catchup-dismissed-alice'),'["a"]');h.change('alice','http://two.test');await h.render();assert.equal(h.top().Id,'a');h.change('alice','http://one.test');await h.render();assert.equal(h.top().Id,'b');
});
const entry=(n,type='Watched')=>({ActivityType:type,UserId:'u',UserName:'Viewer',Timestamp:n,Item:{Id:String(n),Name:`Movie ${n}`}});
test('Activity generated assets filter, increase bounded page size and refresh',async t=>{
 const h=setup(t,{plugin:async path=>({items:Array.from({length:path.includes('100')?100:50},(_,n)=>entry(n,n%2?'Reviewed':'Watched'))})});h.load('extras/activity-page.js');await h.JE.activityPage.renderForCustomTab(h.host);
 assert.equal(h.document.querySelectorAll('.je-activity-row').length,50);h.document.querySelector('.je-activity-more').click();await tick();assert.ok(h.calls.some(c=>c.path==='/activity?limit=100'));assert.equal(h.document.querySelectorAll('.je-activity-row').length,100);
 const filter=h.document.querySelector('.je-activity-filter');filter.value='Reviewed';filter.dispatchEvent(new h.window.Event('change'));assert.equal(h.document.querySelectorAll('.je-activity-section:not([hidden]) .je-activity-row').length,50);
 h.document.querySelector('.je-activity-refresh-btn').click();await tick();assert.equal(filter.value,'Reviewed');
});
test('Activity malformed response errors and pending old-account response cannot repopulate',async t=>{
 const pending=deferred();let mode='bad';const h=setup(t,{plugin:async()=>mode==='bad'?{items:{}}:pending.promise});h.load('extras/activity-page.js');await h.JE.activityPage.renderForCustomTab(h.host);assert.equal(h.document.querySelectorAll('.je-activity-error').length,2);
 mode='pending';const load=h.JE.activityPage.renderForCustomTab(h.host);h.change();pending.resolve({items:[entry(1)]});await load;assert.equal(h.document.querySelectorAll('.je-activity-row').length,0);assert.equal(h.host.textContent,'');
});
test('Catch Up admin filters reject out-of-order replies and normal users have no panel',async t=>{
 const pending=deferred();const h=setup(t,{admin:true,plugin:async path=>path.includes('action=')?pending.promise:{users:['Admin'],events:[]}});await h.render();h.document.querySelector('.je-catchup-headbtns button').click();await tick();assert.ok(h.document.querySelector('.je-catchup-activity'));
 h.document.querySelector('.fchips button').click();h.document.querySelector('[data-v="summary"]').click();await tick();pending.resolve({users:['Secret'],events:[]});await tick();assert.doesNotMatch(h.host.textContent,/Secret/);
 h.change();await tick();assert.equal(h.document.querySelector('.je-catchup-activity'),null);
 const normal=setup(t);await normal.render();assert.equal(normal.document.querySelector('.je-catchup-activity'),null);
});
test('Catch Up partial season failure waits for every sent write before reloading',async t=>{
 const late=deferred();let loads=0;const h=setup(t,{jf:async(path,options)=>{if(options?.method){if(path.endsWith('s1'))throw Error('denied');return late.promise;}if(path.includes('/Seasons?'))return {Items:[1,2,3].map(n=>({Id:`s${n}`,Name:`Season ${n}`,IndexNumber:n}))};loads++;return {Items:[{...movie('series'),Type:'Series'}]};}});
 await h.render();h.document.querySelector('[data-mode="Series"]').click();await tick();h.button('r').click();await tick();h.document.querySelectorAll('.je-catchup-grid button')[1].click();const before=loads;h.document.querySelector('.je-catchup-modal .primary').click();await tick();assert.equal(loads,before);late.resolve({});await tick();assert.ok(loads>before);assert.equal(h.S.state.undoStack.length,0);
});
test('Catch Up failed undo reconciles without falsely restoring the old card',async t=>{
 let watched=false;const h=setup(t,{jf:async(path,options)=>{if(options?.method==='DELETE')throw Error('undo denied');if(options?.method==='POST'){watched=true;return {};}return {Items:watched?[movie('b')]:[movie('a'),movie('b')]};}});
 await h.render();h.button('r').click();await tick();h.button('z').click();await tick();assert.equal(h.top().Id,'b');assert.match(h.toasts[0],/undo denied/);
});
test('Activity older refresh cannot overwrite newer paging response and failed page can retry',async t=>{
 const old=deferred();let calls=0,fail=false;const h=setup(t,{plugin:async path=>{calls++;if(calls===2)return old.promise;if(fail)throw Error('offline');return {items:Array.from({length:path.includes('100')?100:50},(_,n)=>entry(n))};}});h.load('extras/activity-page.js');await h.JE.activityPage.renderForCustomTab(h.host);
 h.document.querySelector('.je-activity-refresh-btn').click();h.document.querySelector('.je-activity-more').click();await tick();assert.equal(h.document.querySelectorAll('.je-activity-row').length,100);old.resolve({items:[entry(999)]});await tick();assert.doesNotMatch(h.host.textContent,/Movie 999/);
 fail=true;h.document.querySelector('.je-activity-more').click();await tick();assert.ok(h.document.querySelector('.je-activity-error'));fail=false;h.document.querySelector('.je-activity-more').click();await tick();assert.equal(h.calls.filter(c=>c.path==='/activity?limit=150').length,2);
});
test('Activity malformed streams display an error; authorization denial alone removes section',async t=>{
 const h=setup(t,{plugin:async path=>path.includes('sessions')?{}:{items:[]}});Object.assign(h.JE.pluginConfig,{ActiveStreamsEnabled:true,ActivityFeedShowActiveStreams:true});h.load('extras/activity-page.js');await h.JE.activityPage.renderForCustomTab(h.host);assert.equal(h.document.querySelectorAll('.je-activity-section').length,3);assert.ok(h.document.querySelector('.je-activity-error'));
});
test('colored Activity icons retain multilingual matching and initialize/stop without duplicate watchers',async t=>{
 let subscriptions=0,teardowns=0;const h=createHarness({html:'<a href="#/dashboard/activity"><div class="MuiTypography-body1">User has successfully authenticated</div><div class="MuiAvatar-root"><svg></svg></div></a>',JE:{helpers:{onBodyMutation:()=>{subscriptions++;return {unsubscribe(){subscriptions--;}};}},core:{lifecycle:{register:()=>({track(){},teardown(){teardowns++;}})},navigation:{onNavigate:()=>()=>{}}}}});t.after(()=>h.close());h.load('extras/colored-activity-icons.js');h.JE.initializeActivityIcons();assert.equal(h.document.querySelector('.material-icons').textContent,'key');h.JE.initializeActivityIcons();assert.equal(subscriptions,1);h.JE.stopActivityIconsMonitoring();assert.equal(subscriptions,0);assert.equal(teardowns,2);
});
test('a created user gets a real Material icon in each of the fourteen languages',async t=>{
 const created=['User alice has been created',"S'ha creat l'usuari alice",'Użytkownik alice został utworzony','Benutzer alice wurde erstellt',"L'utilisateur alice a été créé",'El usuario alice ha sido creado',"L'utente alice è stato creato",'ユーザー alice が作成されました','Пользователь alice был создан','O usuário alice foi criado','Gebruiker alice is aangemaakt','사용자 alice 생성됨','Användaren alice har skapats','alice kullanıcısı oluşturuldu'];
 const h=createHarness({html:created.map(text=>`<a href="#/dashboard/activity"><div class="MuiTypography-body1">${text}</div><div class="MuiAvatar-root"><svg></svg></div></a>`).join(''),JE:{helpers:{onBodyMutation:()=>({unsubscribe(){}})},core:{lifecycle:{register:()=>({track(){},teardown(){}})},navigation:{onNavigate:()=>()=>{}}}}});t.after(()=>h.close());h.load('extras/colored-activity-icons.js');h.JE.initializeActivityIcons();
 const avatars=[...h.document.querySelectorAll('.MuiAvatar-root')];
 // "plus" is not a Material Icons name: the font has no glyph for it, so the avatar was drawn empty.
 assert.deepEqual(avatars.map(avatar=>avatar.querySelector('.material-icons')?.textContent),created.map(()=>'person_add'));
 assert.deepEqual([...new Set(avatars.map(avatar=>avatar.getAttribute('data-jellyfin-enhanced-activity-icon')))],['#2ed62eff']);
 h.JE.stopActivityIconsMonitoring();
});
test('Catch Up rejects an old response even after returning to the original account',async t=>{
 const pending=deferred();let waiting=true;const h=setup(t,{jf:async()=>waiting?pending.promise:{Items:[movie('current')]}});h.JE.catchUpPage.renderPage(h.host);h.change();h.change('alice');waiting=false;await h.render();pending.resolve({Items:[movie('obsolete')]});await tick();assert.equal(h.top().Id,'current');
});
test('Catch Up route disposal rejects pending picker even when its host stays connected',async t=>{
 const pending=deferred();const h=setup(t,{jf:async path=>path.includes('/Seasons?')?pending.promise:{Items:[{...movie('show'),Type:'Series'}]}});await h.render();h.document.querySelector('[data-mode="Series"]').click();await tick();h.button('r').click();await navigate(h,'#/details?id=other');pending.resolve({Items:[]});await tick();assert.equal(h.document.querySelector('.je-catchup-card'),null);assert.equal(h.calls.filter(c=>c.options?.method).length,0);
});
test('Catch Up summary accepts deleted title names and malformed feed is an error',async t=>{
 const h=setup(t,{admin:true,plugin:async path=>path==='/catchup/summary'?{users:[{user:'Admin',watched:2,dismiss:1,watchlist:0,lastSeen:null}],topWatched:[{itemId:'deleted',name:null,count:2,users:['Admin']}],topDismissed:[],topWatchlisted:[]}:{events:{},users:[]}});await h.render();h.document.querySelector('.je-catchup-headbtns button').click();await tick();assert.match(h.document.querySelector('.abody').textContent,/Failed/);h.document.querySelector('[data-v="summary"]').click();await tick();assert.match(h.document.querySelector('.tops').textContent,/deleted/);assert.equal(h.document.querySelectorAll('.ucard').length,1);
});
test('Activity route change invalidates pending feed while retained host stays connected',async t=>{
 const pending=deferred();const h=setup(t,{plugin:()=>pending.promise});h.load('extras/activity-page.js');const render=h.JE.activityPage.renderForCustomTab(h.host);await navigate(h,'#/details?id=other');pending.resolve({items:[entry(10)]});await render;assert.equal(h.document.querySelectorAll('.je-activity-row').length,0);
});
test('native and custom page placements remount only the active home tab',async t=>{
 const h=setup(t);h.window.location.hash='#/home';h.host.innerHTML='<div class="jellyfinenhanced catchup"></div><div class="jellyfinenhanced activity"></div>';
 const watch=new Map(),registrations=[];h.JE.helpers={isActiveTabContainer:node=>!node.hidden,observeTabContainers:(id,selector,fn)=>watch.set(id,fn)};h.JE.nativeTabs={register:(id,title,mount)=>{registrations.push(id);const panel=h.document.createElement('aside');mount(panel);assert.equal(panel.firstElementChild.className,`jellyfinenhanced ${id}`);}};
 Object.assign(h.JE.pluginConfig,{CatchUpUseNativeTab:true,ActivityFeedUseNativeTab:true});h.load('extras/activity-page.js');
 const timers=[];h.window.setInterval=fn=>{timers.push(fn);return timers.length;};h.window.clearInterval=()=>{};
 h.load('enhanced/catchup/catchup-custom-tab.js');h.load('extras/activity-custom-tab.js');timers.forEach(fn=>fn());await tick();assert.deepEqual(registrations,['catchup','activity']);assert.ok(h.document.querySelector('#je-catchup-container-tab .je-catchup'));assert.ok(h.document.querySelector('#je-activity-container-tab .je-activity-feed'));
 const marker=h.document.querySelector('.jellyfinenhanced.catchup');const old=marker.firstChild;marker.hidden=true;watch.get('catchup-custom-tab')();marker.hidden=false;watch.get('catchup-custom-tab')();await tick();assert.notEqual(marker.firstChild,old);
 await navigate(h,'#/details?id=a');assert.equal(h.document.querySelector('.je-catchup-card'),null);
});
test('Catch Up drag cancellation cannot send a mutation; completed drag progresses',async t=>{
 const h=setup(t);await h.render();const card=h.document.querySelector('.je-catchup-card:not(.back)');card.setPointerCapture=()=>{};
 const pointer=(type,x)=>{const e=new h.window.MouseEvent(type,{clientX:x,clientY:0,bubbles:true});Object.defineProperty(e,'pointerId',{value:1});card.dispatchEvent(e);};
 pointer('pointerdown',0);pointer('pointermove',200);pointer('pointercancel',200);await tick();assert.equal(h.calls.filter(c=>c.options?.method).length,0);assert.equal(h.top().Id,'a');pointer('pointerdown',0);pointer('pointerup',200);await tick();assert.equal(h.top().Id,'b');
});
test('Activity filtering does not disguise a failed load as a successful empty feed',async t=>{
 const h=setup(t,{plugin:async()=>({items:null})});h.load('extras/activity-page.js');await h.JE.activityPage.renderForCustomTab(h.host);const filter=h.document.querySelector('.je-activity-filter');filter.value='Reviewed';filter.dispatchEvent(new h.window.Event('change'));assert.equal(h.document.querySelectorAll('.je-activity-error').length,2);assert.equal(h.document.querySelectorAll('.je-activity-empty').length,0);
});
