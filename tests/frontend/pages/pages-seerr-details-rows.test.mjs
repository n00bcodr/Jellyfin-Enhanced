import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as settle} from 'node:timers/promises';
import {createHarness,deferred} from '../helpers/harness.mjs';

// item-details.js: the Seerr Recommended and Similar rows on a details page. When the Seerr data
// comes back before Jellyfin has rendered the item, the rows wait behind an empty marker and are
// built with Jellyfin's render of the item's name, before that render is painted. Otherwise (and
// as a fallback) they are inserted at once, exactly as before.
const MARKER='je-seerr-rows-pending';
const SECONDARY='<div class="detailPageSecondaryContainer"><div id="similarCollapsible" class="verticalSection detailVerticalSection hide"><h2 class="sectionTitle">More Like This</h2><div is="emby-scroller"><div is="emby-itemscontainer" class="itemsContainer similarContent"></div></div></div>__AFTER__</div>';
const page=({id='itemDetailPage',name=true,after='',outside=''}={})=>`<div id="${id}" class="page libraryPage itemDetailPage"><div class="detailPageWrapperContainer"><div class="detailPagePrimaryContainer">${name?'<div class="nameContainer"></div>':''}</div>${SECONDARY.replace('__AFTER__',after)}</div>${outside}</div>`;
const results=(kind,n=25,extra=()=>({}))=>({results:Array.from({length:n},(_,i)=>({id:i,mediaType:'movie',title:`${kind} ${i}`,...extra(i)}))});

const MOVIE={Type:'Movie',Name:'Movie',ProviderIds:{Tmdb:'42'}};
// Two titles with their own Seerr answers, already in the client caches: movie-1 is A (TMDB 1), movie-2 is B (TMDB 2).
const TWO={item:id=>({...MOVIE,ProviderIds:{Tmdb:id==='movie-1'?'1':'2'}}),data:(kind,tmdb)=>results(`${tmdb===1?'A':'B'} ${kind}`)};

function setup(t,{html=page(),config={},status={active:true},card,item=()=>MOVIE,data}={}){
 const frames=[],timers=new Map(),navs=[],views=[],teardowns=[],ends=[];
 const network={similar:0,recommended:0},waiting={similar:[],recommended:[]},cache={};
 const counts={status:0,item:0,cards:0,released:0};let timerId=0,epoch=0;
 const globals={
  requestAnimationFrame:fn=>{frames.push(fn);return frames.length;},
  setTimeout:(fn,ms=0)=>{timers.set(++timerId,{fn,ms});return timerId;},
  clearTimeout:id=>{timers.delete(id);}
 };
 // A client cache in front of the Seerr requests: a response is reused, a request is counted once.
 // With `data`, each title's answers are already in it.
 const related=kind=>tmdb=>{
  if(data)return Promise.resolve(data(kind,tmdb));
  if(cache[kind])return Promise.resolve(cache[kind]);
  network[kind]++;const d=deferred();waiting[kind].push(d);return d.promise;
 };
 const h=createHarness({html,url:'http://jellyfin.test/web/index.html#!/details?id=movie-1',globals,
  JE:{pluginConfig:{JellyseerrShowSimilar:true,JellyseerrShowRecommended:true,...config},
   t:key=>({jellyseerr_recommended_title:'Recommended',jellyseerr_similar_title:'Similar'})[key],
   seerrStatus:{MEDIA:{BLOCKED:6}},
   session:{getEpoch:()=>epoch,isCurrent:e=>e===epoch},
   requestManager:{metrics:{enabled:true},startMeasurement:()=>{},endMeasurement:name=>ends.push({name,marker:!!h.document.querySelector(`.${MARKER}`),cards:counts.cards})},
   helpers:{getItemCached:async id=>{counts.item++;return item(id);},onBodyMutation:()=>({unsubscribe(){}})},
   jellyseerrAPI:{checkUserStatus:async()=>{counts.status++;return status;},
    fetchSimilarMovies:related('similar'),fetchRecommendedMovies:related('recommended')},
   jellyseerrUI:{releasePosters:()=>{counts.released++;},
    createJellyseerrCard:item=>{if(card)card(item);counts.cards++;const el=h.document.createElement('div');el.className='card';el.textContent=item.title;return el;}},
   core:{lifecycle:{register:()=>({onTeardown:fn=>teardowns.push(fn),teardownOn:()=>{}})},
    navigation:{onNavigate:fn=>navs.push(fn),onViewPage:fn=>views.push(fn)}}}});
 t.after(()=>h.close());
 h.load('jellyseerr/item-details.js');
 const view=h.document.querySelector('.libraryPage');
 return {...h,counts,network,timers,ends,view,
  anchor:(v=view)=>v.querySelector('#similarCollapsible'),
  marker:()=>h.document.querySelector(`.${MARKER}`),
  /** Element siblings after More Like This: the marker, the rows by title, anything else by id. */
  after(v=view){const out=[];for(let el=this.anchor(v).nextElementSibling;el;el=el.nextElementSibling)out.push(el.classList.contains(MARKER)?'marker':el.classList.contains('jellyseerr-details-section')?el.querySelector('h2').textContent:el.id||el.tagName);return out;},
  cards:(v=view)=>[...v.querySelectorAll('.jellyseerr-details-section')].map(s=>s.querySelectorAll('.card').length),
  /** The rows' first cards, which name the title they are for (see `data`). */
  firsts:(v=view)=>[...v.querySelectorAll('.jellyseerr-details-section')].map(s=>s.querySelector('.card').textContent),
  /** The items of the waiting builds' markers, in DOM order. */
  markers:(v=view)=>[...v.querySelectorAll(`.${MARKER}`)].map(m=>m.dataset.itemId),
  frame(){const pending=frames.splice(0);for(const fn of pending)fn();},
  /** The Seerr data; an `uncached` kind is answered but not kept, as a failed request's empty answer. */
  async respond({similar=results('Similar'),recommended=results('Recommended'),uncached=[]}={}){
   if(!uncached.includes('similar'))cache.similar=similar;if(!uncached.includes('recommended'))cache.recommended=recommended;
   for(const d of waiting.similar.splice(0))d.resolve(similar);for(const d of waiting.recommended.splice(0))d.resolve(recommended);
   await this.flush();
  },
  /** The first frame, then the Seerr data. */
  async start(options){this.frame();await this.flush();await this.respond(options);},
  async flush(){for(let i=0;i<5;i++)await settle();},
  /**
   * Jellyfin renders the item in one task: its name, then More Like This shown (and optionally
   * filled or hidden again). Only microtasks follow, as before the browser paints that task.
   */
  async render({v=view,card:withCard=true,hide=false}={}){
   v.querySelector('.nameContainer')?.insertAdjacentHTML('beforeend','<h1 class="itemName infoText"><bdi>Movie</bdi></h1>');
   const anchor=this.anchor(v);anchor.classList.remove('hide');
   if(withCard)anchor.querySelector('.similarContent').insertAdjacentHTML('beforeend','<div class="card">Jellyfin</div>');
   if(hide)anchor.classList.add('hide');
   for(let i=0;i<5;i++)await null;
  },
  async fill(v=view){this.anchor(v).querySelector('.similarContent').insertAdjacentHTML('beforeend','<div class="card">Jellyfin</div>');await this.flush();},
  /** Runs the timers due after `ms`, or only the first one scheduled. */
  timer(ms,{once=false}={}){for(const [id,entry] of [...timers])if(entry.ms===ms){timers.delete(id);entry.fn();if(once)return;}},
  delays:()=>[...timers.values()].map(entry=>entry.ms).sort((a,b)=>a-b),
  bumpEpoch(){epoch++;},
  /** With an `id`, Jellyfin's viewshow on view `v`, which carries the URL's parameters. */
  async viewshow({v=view,id}={}){
   let raw=null;if(id){raw=new h.window.CustomEvent('viewshow',{bubbles:true,detail:{params:{id},isRestored:false}});v.dispatchEvent(raw);}
   for(const fn of views)fn(undefined,undefined,h.window.location.hash,null,raw);this.frame();await this.flush();
  },
  // pushState, as Jellyfin's router does (setting location.hash would queue jsdom's hashchange on the faked timers).
  navigate(hash){h.window.history.pushState(null,'',hash);for(const fn of teardowns)fn();for(const fn of navs)fn();}
 };
}

test('data before Jellyfin: only a marker until the name renders; the rows are in place before that render paints',async t=>{
 const h=setup(t);await h.start();
 assert.deepEqual(h.after(),['marker']);assert.equal(h.counts.cards,0);assert.equal(h.marker().getAttribute('aria-hidden'),'true');
 assert.deepEqual(h.delays(),[5000]);
 // More Like This is shown, still loading: the page could already be scrolled to its end.
 await h.render({card:false});
 assert.deepEqual(h.after(),['Recommended','Similar']);assert.deepEqual(h.cards(),[20,20]);assert.equal(h.marker(),null);
 assert.deepEqual(h.delays(),[],'nothing left waiting');assert.deepEqual(h.network,{similar:1,recommended:1});
 await h.fill();assert.deepEqual(h.after(),['Recommended','Similar']);assert.equal(h.counts.cards,40);
 // More Like This without results (hidden again), or filled in the same task: the same.
 for(const options of [{card:false,hide:true},{card:true}]){
  const other=setup(t);await other.start();await other.render(options);assert.deepEqual(other.after(),['Recommended','Similar']);
 }
});

test('a page Jellyfin never renders gets the rows after 5 s',async t=>{
 const h=setup(t);await h.start();assert.deepEqual(h.delays(),[5000]);
 h.timer(5000);assert.deepEqual(h.after(),['Recommended','Similar']);assert.equal(h.marker(),null);
 await h.render();assert.equal(h.counts.cards,40,'once');
});

test('data after Jellyfin rendered, or a view that already has rows: inserted at once, as before',async t=>{
 const h=setup(t);h.frame();await h.flush();await h.render();await h.respond();
 assert.deepEqual(h.after(),['Recommended','Similar']);assert.deepEqual(h.cards(),[20,20]);assert.equal(h.marker(),null);
 // More Like This still loading.
 const loading=setup(t);loading.frame();await loading.flush();await loading.render({card:false});await loading.respond();
 assert.deepEqual(loading.after(),['Recommended','Similar']);assert.equal(loading.marker(),null);assert.equal(loading.timers.size,0);
 const old='<div class="verticalSection jellyseerr-details-section"><h2>Old</h2></div>';
 const restored=setup(t,{html:page({after:old})});restored.frame();await restored.flush();
 await restored.render({card:false});await restored.respond();
 assert.deepEqual(restored.after(),['Recommended','Similar'],'the old rows are replaced in place');assert.equal(restored.counts.released,1);
 assert.equal(restored.marker(),null);
});

test('anything after More Like This keeps the immediate insert and its order',async t=>{
 // A div after More Like This, even a hidden one, puts Similar first (:last-of-type).
 for(const after of ['<div id="extra"></div>','<div id="extra" class="hide"></div>']){
  const h=setup(t,{html:page({after})});await h.start();
  assert.deepEqual(h.after(),['Similar','Recommended','extra']);assert.equal(h.timers.size,0);
 }
 // Something visible after the content.
 const below=setup(t,{html:page({outside:'<div id="below"></div>'})});await below.start();assert.deepEqual(below.after(),['Recommended','Similar']);assert.equal(below.marker(),null);
 // Hidden elements and ones that take no space do not hold the rows back.
 const quiet=setup(t,{html:page({after:'<script></script><section hidden></section>',outside:'<div class="hide"></div><style></style>'})});await quiet.start();
 assert.deepEqual(quiet.after(),['marker','SCRIPT','SECTION']);
 await quiet.render();assert.deepEqual(quiet.after(),['Recommended','Similar','SCRIPT','SECTION']);
 // Added after the marker while the rows wait: it stays after them, as it would have.
 const late=setup(t);await late.start();late.anchor().parentElement.insertAdjacentHTML('beforeend','<div id="late"></div>');
 await late.render();assert.deepEqual(late.after(),['Recommended','Similar','late']);
});

test('leaving while the rows wait builds them into the left view with its render; Back restores the view with them',async t=>{
 // Before, the rows went in with their data, so the view Jellyfin keeps had them when Back restored it.
 let lookup=()=>MOVIE;const h=setup(t,{item:()=>lookup()});await h.start();
 h.navigate('#!/home');h.view.classList.add('hide');await h.flush();
 assert.deepEqual(h.after(),['marker'],'kept for the left view');assert.deepEqual(h.delays(),[5000]);
 // Jellyfin's reload still renders the left view, now hidden.
 await h.render();assert.deepEqual(h.after(),['Recommended','Similar']);assert.deepEqual(h.cards(),[20,20]);assert.equal(h.marker(),null);
 assert.deepEqual(h.delays(),[]);h.window.dispatchEvent(new h.window.Event('beforeprint'));assert.equal(h.counts.cards,40,'once');
 // Back restores the view after the item cache expired: the rows are there while the item is looked up again.
 const pending=deferred();lookup=()=>pending.promise;
 h.navigate('#!/details?id=movie-1');h.view.classList.remove('hide');h.frame();await h.flush();
 assert.deepEqual(h.after(),['Recommended','Similar'],'from the restored view\'s first frame');assert.equal(h.counts.cards,40);
 pending.resolve(MOVIE);await h.flush();
 assert.deepEqual(h.after(),['Recommended','Similar'],'replaced in place, as before');assert.equal(h.counts.cards,80);
 assert.deepEqual(h.network,{similar:1,recommended:1});
 // A Back run that finds no item leaves them, as before.
 let found=MOVIE;const gone=setup(t,{item:()=>found});await gone.start();gone.navigate('#!/home');gone.view.classList.add('hide');await gone.render();
 found=null;gone.navigate('#!/details?id=movie-1');gone.view.classList.remove('hide');gone.frame();await gone.flush();
 assert.deepEqual(gone.after(),['Recommended','Similar']);assert.equal(gone.counts.cards,40);
});

test('a left view gets its rows after 5 s without a render, and none once it is gone or another user signed in',async t=>{
 const h=setup(t);await h.start();h.navigate('#!/home');h.view.classList.add('hide');
 h.timer(5000);assert.deepEqual(h.after(),['Recommended','Similar']);assert.equal(h.marker(),null);
 await h.render();assert.equal(h.counts.cards,40,'once');
 // Back can restore the previous details view, and hide this one, before JE sees the navigation: kept as well.
 const back=setup(t);await back.start();back.window.history.pushState(null,'','#!/details?id=movie-0');
 back.document.body.insertAdjacentHTML('beforeend',page({id:'previous'}));back.view.classList.add('hide');await back.flush();
 assert.deepEqual(back.after(),['marker']);back.navigate('#!/details?id=movie-0');
 await back.render();assert.deepEqual(back.after(),['Recommended','Similar']);
 assert.deepEqual(back.after(back.document.getElementById('previous')),[],'nothing in the other item\'s view');
 const print=x=>x.window.dispatchEvent(new x.window.Event('beforeprint'));
 const removed=setup(t);await removed.start();removed.navigate('#!/home');removed.view.remove();
 print(removed);await removed.render();removed.timer(5000);assert.equal(removed.counts.cards,0);assert.deepEqual(removed.after(),[]);
 const before=setup(t);await before.start();before.bumpEpoch();before.navigate('#!/home');
 assert.equal(before.marker(),null);assert.deepEqual(before.delays(),[]);print(before);await before.render();assert.equal(before.counts.cards,0);
 const after=setup(t);await after.start();after.navigate('#!/home');after.bumpEpoch();
 print(after);await after.render();assert.equal(after.counts.cards,0);assert.deepEqual(after.after(),[]);
});

test('a build kept for a left view still builds for printing: a view restored before its render prints the rows',async t=>{
 // Back before Jellyfin rendered the view: it is restored as it is, while the new run looks the item up again.
 let lookup=()=>MOVIE;const h=setup(t,{item:()=>lookup()});await h.start();await h.viewshow({id:'movie-1'});
 h.navigate('#!/home');h.view.classList.add('hide');await h.flush();
 const pending=deferred();lookup=()=>pending.promise;
 h.navigate('#!/details?id=movie-1');h.view.classList.remove('hide');await h.viewshow({id:'movie-1'});
 assert.deepEqual(h.after(),['marker']);
 h.window.dispatchEvent(new h.window.Event('beforeprint'));
 assert.deepEqual(h.after(),['Recommended','Similar'],'printed with the rows, as before');assert.deepEqual(h.cards(),[20,20]);
 assert.deepEqual(h.delays(),[]);
 pending.resolve(MOVIE);await h.flush();
 assert.deepEqual(h.after(),['Recommended','Similar'],'replaced in place, as before');assert.equal(h.counts.cards,80);
 assert.deepEqual(h.network,{similar:1,recommended:1});
 // Printing another page builds them into the hidden left view, which had them before; once.
 const away=setup(t);await away.start();away.navigate('#!/home');away.view.classList.add('hide');
 away.window.dispatchEvent(new away.window.Event('beforeprint'));assert.deepEqual(away.after(),['Recommended','Similar']);
 away.window.dispatchEvent(new away.window.Event('beforeprint'));await away.render();away.timer(5000);
 assert.equal(away.counts.cards,40,'once');assert.deepEqual(away.delays(),[]);
});

test('a run for the view the user came back to before its render takes over from the kept build',async t=>{
 const h=setup(t);await h.start();h.navigate('#!/home');h.view.classList.add('hide');
 h.navigate('#!/details?id=movie-1');h.view.classList.remove('hide');h.frame();await h.flush();
 assert.equal(h.document.querySelectorAll(`.${MARKER}`).length,1);
 await h.render();assert.deepEqual(h.after(),['Recommended','Similar']);assert.equal(h.counts.cards,40,'built once');
 assert.deepEqual(h.network,{similar:1,recommended:1});assert.deepEqual(h.delays(),[]);
 // The new run inserts at once (something now follows More Like This): the kept build gives way.
 const late=setup(t);await late.start();late.navigate('#!/home');late.view.classList.add('hide');
 late.anchor().parentElement.insertAdjacentHTML('beforeend','<div id="late"></div>');
 late.navigate('#!/details?id=movie-1');late.view.classList.remove('hide');late.frame();await late.flush();
 assert.deepEqual(late.after(),['Similar','Recommended','late'],'the immediate insert\'s order');assert.equal(late.marker(),null);
 await late.render();late.timer(5000);assert.equal(late.counts.cards,40);
});

test('the next item\'s run finding the left view, still shown, leaves its kept build alone',async t=>{
 const h=setup(t);await h.start();await h.viewshow({id:'movie-1'});h.navigate('#!/details?id=movie-2');h.frame();await h.flush();
 assert.deepEqual(h.after(),['marker','marker'],'the next item\'s rows wait there too, for now');
 h.document.body.insertAdjacentHTML('beforeend',page({id:'second'}));const second=h.document.getElementById('second');
 h.view.classList.add('hide');await h.flush();assert.deepEqual(h.after(),['marker']);assert.deepEqual(h.after(second),['marker']);
 await h.render();assert.deepEqual(h.after(),['Recommended','Similar'],'the left view\'s own rows');
 await h.render({v:second});assert.deepEqual(h.after(second),['Recommended','Similar']);
 assert.equal(h.counts.cards,80);assert.deepEqual(h.delays(),[]);assert.deepEqual(h.network,{similar:1,recommended:1});
});

test('the next item\'s rows waiting in the left item\'s view are dropped when the user leaves: that view keeps its own rows',async t=>{
 // A's rows wait in its view; B's come from the caches while that view is still shown. The user leaves B before
 // Jellyfin hides it, and Jellyfin's render of A stalls past 5 s.
 const h=setup(t,TWO);await h.start();await h.viewshow({id:'movie-1'});
 h.navigate('#!/details?id=movie-2');h.frame();await h.flush();assert.deepEqual(h.markers(),['movie-2','movie-1']);
 h.navigate('#!/home');h.view.classList.add('hide');await h.flush();
 assert.deepEqual(h.markers(),['movie-1'],'only the build for the view\'s own item is kept');assert.deepEqual(h.delays(),[5000]);
 h.timer(5000);assert.deepEqual(h.firsts(),['A recommended 0','A similar 0']);
 // Back: the restored view's run replaces them in place, in their order, and nothing replaces them later.
 h.navigate('#!/details?id=movie-1');h.view.classList.remove('hide');await h.viewshow({id:'movie-1'});
 assert.deepEqual(h.after(),['Recommended','Similar']);assert.deepEqual(h.firsts(),['A recommended 0','A similar 0']);
 await h.render();h.window.dispatchEvent(new h.window.Event('beforeprint'));h.timer(5000);
 assert.deepEqual(h.firsts(),['A recommended 0','A similar 0']);assert.equal(h.marker(),null);assert.deepEqual(h.delays(),[]);
 // Back to A before B's view shows: A's view is restored as it is, and only A's rows are built there.
 const back=setup(t,TWO);await back.start();await back.viewshow({id:'movie-1'});
 back.navigate('#!/details?id=movie-2');back.frame();await back.flush();
 back.navigate('#!/details?id=movie-1');await back.viewshow({id:'movie-1'});assert.deepEqual(back.markers(),['movie-1']);
 back.window.dispatchEvent(new back.window.Event('beforeprint'));assert.deepEqual(back.firsts(),['A recommended 0','A similar 0']);
 back.timer(5000);await back.render();assert.deepEqual(back.firsts(),['A recommended 0','A similar 0']);
 assert.equal(back.counts.cards,40);assert.deepEqual(back.delays(),[]);
});

test('a build kept before its view\'s viewshow checks whose view it is before building, and gives way to that view\'s item',async t=>{
 // B's run found A's view before Jellyfin's viewshow of it (a native Back or Forward during the view swap): the
 // abort cannot tell whose view it is, so it keeps the build.
 const h=setup(t,TWO);h.navigate('#!/details?id=movie-2');h.frame();await h.flush();
 h.navigate('#!/home');h.view.classList.add('hide');assert.deepEqual(h.markers(),['movie-2']);
 await h.viewshow({id:'movie-1'});h.timer(5000);await h.render();
 assert.deepEqual(h.after(),[],'nothing in the other item\'s view');assert.equal(h.counts.cards,0);
 // Its own view, shown after the run found it: built there.
 const mine=setup(t,TWO);mine.navigate('#!/details?id=movie-2');mine.frame();await mine.flush();
 mine.navigate('#!/home');mine.view.classList.add('hide');await mine.viewshow({id:'movie-2'});mine.timer(5000);
 assert.deepEqual(mine.firsts(),['B recommended 0','B similar 0']);
 // Next to A's own kept build: A's rows, inserted at once on Back, take its place and keep their order.
 const own=setup(t,TWO);await own.start();own.navigate('#!/details?id=movie-2');own.frame();await own.flush();
 own.navigate('#!/home');own.view.classList.add('hide');assert.deepEqual(own.markers(),['movie-2','movie-1']);
 own.timer(5000,{once:true});assert.deepEqual(own.after(),['marker','Recommended','Similar'],'A\'s fallback');
 own.navigate('#!/details?id=movie-1');own.view.classList.remove('hide');await own.viewshow({id:'movie-1'});
 assert.deepEqual(own.after(),['Recommended','Similar']);assert.deepEqual(own.firsts(),['A recommended 0','A similar 0']);
 own.timer(5000);await own.render();assert.deepEqual(own.firsts(),['A recommended 0','A similar 0']);assert.deepEqual(own.delays(),[]);
});

test('a viewshow while the rows wait, or after they are built, requests and builds nothing again',async t=>{
 const h=setup(t);await h.start();await h.viewshow();
 assert.equal(h.document.querySelectorAll(`.${MARKER}`).length,1);assert.equal(h.counts.status,1);
 await h.render();assert.equal(h.counts.cards,40);
 await h.viewshow();assert.equal(h.counts.cards,40);assert.equal(h.counts.status,1);assert.deepEqual(h.network,{similar:1,recommended:1});
});

test('a user switch before the build drops the rows and releases the item for a later viewshow',async t=>{
 const h=setup(t);await h.start();h.bumpEpoch();
 await h.render();assert.equal(h.counts.cards,0);assert.deepEqual(h.after(),[]);
 await h.viewshow();assert.deepEqual(h.after(),['Recommended','Similar'],'the item was released');
 assert.deepEqual(h.network,{similar:1,recommended:1});
 // The immediate path checks the identity too.
 const now=setup(t);now.frame();await now.flush();await now.render();now.bumpEpoch();await now.respond();
 assert.equal(now.counts.cards,0);await now.viewshow();assert.deepEqual(now.after(),['Recommended','Similar']);
});

test('a hidden view gets nothing; the shown details view gets the rows from the same run, asking nothing again',async t=>{
 const h=setup(t);await h.start();
 h.view.classList.add('hide');h.document.body.insertAdjacentHTML('beforeend',page({id:'second'}));
 const second=h.document.getElementById('second');await h.render({v:second});
 assert.deepEqual(h.after(),[],'nothing in the hidden view');assert.deepEqual(h.delays(),[],'with the shown view\'s render, not after 5 s');
 assert.deepEqual(h.after(second),['Recommended','Similar']);assert.deepEqual(h.cards(second),[20,20]);
 await h.viewshow();assert.equal(h.counts.cards,40);
 assert.deepEqual(h.network,{similar:1,recommended:1});assert.deepEqual([h.counts.status,h.counts.item],[1,1]);
});

test('rows waiting on the view Jellyfin leaves go to the shown view once it hides that one, not with its render',async t=>{
 // The run found the outgoing view, still shown: Jellyfin adds the new view before it hides the old one.
 const h=setup(t);await h.start();
 h.document.body.insertAdjacentHTML('beforeend',page({id:'second'}));const second=h.document.getElementById('second');
 await h.flush();assert.deepEqual(h.after(),['marker'],'both shown: still waiting');
 h.view.classList.add('hide');await h.flush();
 assert.deepEqual(h.after(),[]);assert.deepEqual(h.after(second),['marker'],'waiting for the shown view\'s render');
 await h.render({v:second});assert.deepEqual(h.after(second),['Recommended','Similar']);assert.deepEqual(h.delays(),[]);
 // The hidden view's own render, later, and the shown view's viewshow build and ask nothing more.
 await h.render();await h.viewshow();assert.equal(h.counts.cards,40);assert.deepEqual(h.after(),[]);
 assert.deepEqual(h.network,{similar:1,recommended:1});assert.deepEqual([h.counts.status,h.counts.item],[1,1]);
 // Already rendered when the old view is hidden: inserted at once.
 const rendered=setup(t);await rendered.start();
 rendered.document.body.insertAdjacentHTML('beforeend',page({id:'second'}));const b=rendered.document.getElementById('second');
 await rendered.render({v:b});assert.deepEqual(rendered.after(b),[]);
 rendered.view.classList.add('hide');await rendered.flush();assert.deepEqual(rendered.after(b),['Recommended','Similar']);
});

test('rows waiting on a view hidden or dropped before the next one shows go to it on that view\'s viewshow',async t=>{
 const h=setup(t);await h.start();
 h.view.classList.add('hide');await h.flush();
 assert.deepEqual(h.after(),['marker'],'no details view shown: still waiting, the item kept');assert.deepEqual(h.delays(),[5000]);
 h.document.body.insertAdjacentHTML('beforeend',page({id:'second'}));const second=h.document.getElementById('second');
 await h.viewshow();assert.deepEqual(h.after(),[]);assert.deepEqual(h.after(second),['marker']);
 await h.render({v:second});assert.deepEqual(h.after(second),['Recommended','Similar']);
 assert.deepEqual(h.network,{similar:1,recommended:1});assert.deepEqual([h.counts.status,h.counts.item],[1,1]);
 // Removed rather than hidden: nothing observes that, the viewshow run does.
 const removed=setup(t);await removed.start();
 removed.document.body.insertAdjacentHTML('beforeend',page({id:'second'}));const b=removed.document.getElementById('second');
 removed.view.remove();await removed.flush();assert.deepEqual(removed.after(b),[]);
 await removed.viewshow();await removed.render({v:b});assert.deepEqual(removed.after(b),['Recommended','Similar']);assert.equal(removed.counts.status,1);
});

test('data landing after its view was hidden goes to the shown view: a failed endpoint is not asked for again',async t=>{
 // The run found the old view, still shown; Jellyfin then hid it and showed the new one, and the
 // data came back before the new view's viewshow frame. Recommendations failed: an empty answer
 // the client cache does not keep, so another run would request it again.
 const h=setup(t);h.frame();await h.flush();await h.render();
 h.view.classList.add('hide');h.document.body.insertAdjacentHTML('beforeend',page({id:'second'}));const second=h.document.getElementById('second');
 await h.respond({recommended:{results:[]},uncached:['recommended']});
 assert.deepEqual(h.after(),[],'nothing in the hidden view');assert.deepEqual(h.after(second),['marker'],'waiting for its render');
 await h.viewshow();await h.render({v:second});
 assert.deepEqual(h.after(second),['Similar']);assert.deepEqual(h.cards(second),[20]);
 assert.deepEqual(h.network,{similar:1,recommended:1});assert.deepEqual([h.counts.status,h.counts.item],[1,1]);
 assert.deepEqual(h.ends.map(end=>end.name),['similar-recommended']);
});

test('a frame that comes after the URL moved on starts nothing for the old item',async t=>{
 const h=setup(t);h.window.history.pushState(null,'','#!/details?id=movie-2');h.frame();await h.flush();
 assert.equal(h.counts.status,0);assert.equal(h.counts.item,0);assert.deepEqual(h.network,{similar:0,recommended:0});
 // While the rows wait: the URL check is made again at the build.
 const moved=setup(t);await moved.start();moved.window.history.pushState(null,'','#!/details?id=movie-2');await moved.render();
 assert.equal(moved.counts.cards,0);assert.equal(moved.marker(),null);
});

test('a failing build is logged, leaves no marker and releases the item',async t=>{
 let fail=true;const h=setup(t,{card:()=>{if(fail)throw new Error('card');}});
 h.expectConsoleError(/Error rendering similar and recommended sections/);
 await h.start();await h.render();
 assert.equal(h.marker(),null);assert.deepEqual(h.cards(),[]);
 fail=false;await h.viewshow();assert.deepEqual(h.after(),['Recommended','Similar']);
});

test('a view without a name container takes the immediate path without errors',async t=>{
 const h=setup(t,{html:page({name:false})});await h.start();
 assert.deepEqual(h.after(),['Recommended','Similar']);assert.equal(h.timers.size,0);
});

test('printing builds waiting rows at once',async t=>{
 const h=setup(t);await h.start();h.window.dispatchEvent(new h.window.Event('beforeprint'));
 assert.deepEqual(h.after(),['Recommended','Similar']);assert.equal(h.timers.size,0);
 h.window.dispatchEvent(new h.window.Event('beforeprint'));assert.equal(h.counts.cards,40,'once');
});

test('switches off or Seerr inactive: no marker and no request; the filters still apply',async t=>{
 const off=setup(t,{config:{JellyseerrShowSimilar:false,JellyseerrShowRecommended:false}});off.frame();await off.flush();
 assert.equal(off.counts.status,0);assert.equal(off.marker(),null);assert.deepEqual(off.network,{similar:0,recommended:0});
 const inactive=setup(t,{status:{active:false}});inactive.frame();await inactive.flush();
 assert.equal(inactive.marker(),null);assert.deepEqual(inactive.network,{similar:0,recommended:0});
 const similarOnly=setup(t,{config:{JellyseerrShowRecommended:false}});await similarOnly.start();await similarOnly.render();
 assert.deepEqual(similarOnly.network,{similar:1,recommended:0});assert.deepEqual(similarOnly.after(),['Similar']);
 // Blocklisted and library items are left out at data time.
 const extra=i=>i<5?{mediaInfo:{status:6}}:i<10?{mediaInfo:{jellyfinMediaId:`lib-${i}`}}:{};
 const filtered=setup(t,{config:{JellyseerrExcludeBlocklistedItems:true,JellyseerrExcludeLibraryItems:true}});
 await filtered.start({similar:results('Similar',25,extra),recommended:results('Recommended',25,extra)});await filtered.render();
 assert.deepEqual(filtered.cards(),[15,15]);
 // Nothing left after filtering: no marker.
 const empty=setup(t,{config:{JellyseerrExcludeBlocklistedItems:true}});
 await empty.start({similar:results('Similar',3,()=>({mediaInfo:{status:6}})),recommended:{results:[]}});assert.equal(empty.marker(),null);
});

test('the similar-recommended measurement ends once, when the data is ready',async t=>{
 const h=setup(t);await h.start();
 assert.deepEqual(h.ends,[{name:'similar-recommended',marker:true,cards:0}]);
 await h.render();assert.equal(h.ends.length,1);assert.equal(h.counts.cards,40);
});
