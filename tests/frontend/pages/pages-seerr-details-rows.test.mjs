import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as settle} from 'node:timers/promises';
import {createHarness,deferred} from '../helpers/harness.mjs';

// item-details.js: the Seerr Recommended and Similar rows on a details page. When the Seerr data
// comes back before Jellyfin has rendered the item, the rows wait for Jellyfin's own rows above
// them, then for the viewport to come within a screen (or for idle), behind an empty marker.
// Otherwise (and as a fallback) they are inserted at once, exactly as before.
const MARKER='je-seerr-rows-pending';
const SECONDARY='<div class="detailPageSecondaryContainer"><div id="similarCollapsible" class="verticalSection detailVerticalSection hide"><h2 class="sectionTitle">More Like This</h2><div is="emby-scroller"><div is="emby-itemscontainer" class="itemsContainer similarContent"></div></div></div>__AFTER__</div>';
const page=({id='itemDetailPage',name=true,after='',outside=''}={})=>`<div id="${id}" class="page libraryPage itemDetailPage"><div class="detailPageWrapperContainer"><div class="detailPagePrimaryContainer">${name?'<div class="nameContainer"></div>':''}</div>${SECONDARY.replace('__AFTER__',after)}</div>${outside}</div>`;
const results=(kind,n=25,extra=()=>({}))=>({results:Array.from({length:n},(_,i)=>({id:i,mediaType:'movie',title:`${kind} ${i}`,...extra(i)}))});

function setup(t,{html=page(),config={},status={active:true},io=true,idle=true,near=false,card}={}){
 const frames=[],timers=new Map(),idles=new Map(),observers=[],navs=[],views=[],teardowns=[],ends=[];
 const network={similar:0,recommended:0},waiting={similar:[],recommended:[]},cache={};
 const counts={status:0,item:0,cards:0,released:0};let timerId=0,idleId=0,epoch=0;
 const geometry={top:near?300:5000,rects:1};
 class FakeIntersectionObserver{
  constructor(callback,options){this.callback=callback;this.options=options;this.targets=[];this.disconnected=false;observers.push(this);}
  observe(el){this.targets.push(el);}unobserve(){}disconnect(){this.disconnected=true;this.targets=[];}
  fire(isIntersecting=true){this.callback(this.targets.map(target=>({target,isIntersecting})),this);}
 }
 const globals={
  requestAnimationFrame:fn=>{frames.push(fn);return frames.length;},
  setTimeout:(fn,ms=0)=>{timers.set(++timerId,{fn,ms});return timerId;},
  clearTimeout:id=>{timers.delete(id);}
 };
 if(io)globals.IntersectionObserver=FakeIntersectionObserver;
 if(idle){globals.requestIdleCallback=(fn,options)=>{idles.set(++idleId,{fn,options});return idleId;};globals.cancelIdleCallback=id=>{idles.delete(id);};}
 // A client cache in front of the Seerr requests: a response is reused, a request is counted once.
 const related=kind=>()=>{
  if(cache[kind])return Promise.resolve(cache[kind]);
  network[kind]++;const d=deferred();waiting[kind].push(d);return d.promise;
 };
 const h=createHarness({html,url:'http://jellyfin.test/web/index.html#!/details?id=movie-1',globals,
  JE:{pluginConfig:{JellyseerrShowSimilar:true,JellyseerrShowRecommended:true,...config},
   t:key=>({jellyseerr_recommended_title:'Recommended',jellyseerr_similar_title:'Similar'})[key],
   seerrStatus:{MEDIA:{BLOCKED:6}},
   session:{getEpoch:()=>epoch,isCurrent:e=>e===epoch},
   requestManager:{metrics:{enabled:true},startMeasurement:()=>{},endMeasurement:name=>ends.push({name,marker:!!h.document.querySelector(`.${MARKER}`),io:observers.length,idle:idles.size})},
   helpers:{getItemCached:async()=>{counts.item++;return {Type:'Movie',Name:'Movie',ProviderIds:{Tmdb:'42'}};},onBodyMutation:()=>({unsubscribe(){}})},
   jellyseerrAPI:{checkUserStatus:async()=>{counts.status++;return status;},
    fetchSimilarMovies:related('similar'),fetchRecommendedMovies:related('recommended')},
   jellyseerrUI:{releasePosters:()=>{counts.released++;},
    createJellyseerrCard:item=>{if(card)card(item);counts.cards++;const el=h.document.createElement('div');el.className='card';el.textContent=item.title;return el;}},
   core:{lifecycle:{register:()=>({onTeardown:fn=>teardowns.push(fn),teardownOn:()=>{}})},
    navigation:{onNavigate:fn=>navs.push(fn),onViewPage:fn=>views.push(fn)}}}});
 t.after(()=>h.close());
 // The marker's position; the rows' own layout is never read.
 const proto=h.window.Element.prototype,rects=proto.getClientRects,box=proto.getBoundingClientRect;
 proto.getClientRects=function(){return this.classList.contains(MARKER)?Array.from({length:geometry.rects},()=>({top:geometry.top})):rects.call(this);};
 proto.getBoundingClientRect=function(){return this.classList.contains(MARKER)?{top:geometry.top,bottom:geometry.top,height:0}:box.call(this);};
 h.load('jellyseerr/item-details.js');
 const view=h.document.querySelector('.libraryPage');
 return {...h,counts,network,observers,timers,idles,ends,geometry,view,
  anchor:(v=view)=>v.querySelector('#similarCollapsible'),
  marker:()=>h.document.querySelector(`.${MARKER}`),
  /** Element siblings after More Like This: the marker, the rows by title, anything else by id. */
  after(v=view){const out=[];for(let el=this.anchor(v).nextElementSibling;el;el=el.nextElementSibling)out.push(el.classList.contains(MARKER)?'marker':el.classList.contains('jellyseerr-details-section')?el.querySelector('h2').textContent:el.id||el.tagName);return out;},
  cards:(v=view)=>[...v.querySelectorAll('.jellyseerr-details-section')].map(s=>s.querySelectorAll('.card').length),
  frame(){const pending=frames.splice(0);for(const fn of pending)fn();},
  async respond({similar=results('Similar'),recommended=results('Recommended')}={}){
   cache.similar=similar;cache.recommended=recommended;
   for(const d of waiting.similar.splice(0))d.resolve(similar);for(const d of waiting.recommended.splice(0))d.resolve(recommended);
   await this.flush();
  },
  /** The first frame, then the Seerr data. */
  async start(options){this.frame();await this.flush();await this.respond(options);},
  async flush(){for(let i=0;i<5;i++)await settle();},
  /** Jellyfin renders the item: its name, then More Like This shown and (optionally) filled or hidden again. */
  async render({v=view,card:withCard=true,hide=false}={}){
   v.querySelector('.nameContainer')?.insertAdjacentHTML('beforeend','<h1 class="itemName infoText"><bdi>Movie</bdi></h1>');
   const anchor=this.anchor(v);anchor.classList.remove('hide');
   if(withCard)anchor.querySelector('.similarContent').insertAdjacentHTML('beforeend','<div class="card">Jellyfin</div>');
   if(hide)anchor.classList.add('hide');
   await this.flush();
  },
  async fill(v=view){this.anchor(v).querySelector('.similarContent').insertAdjacentHTML('beforeend','<div class="card">Jellyfin</div>');await this.flush();},
  timer(ms){for(const [id,entry] of [...timers])if(entry.ms===ms){timers.delete(id);entry.fn();}},
  idle(){for(const [id,entry] of [...idles]){idles.delete(id);entry.fn({didTimeout:false,timeRemaining:()=>10});}},
  delays:()=>[...timers.values()].map(entry=>entry.ms).sort((a,b)=>a-b),
  bumpEpoch(){epoch++;},
  async viewshow(){for(const fn of views)fn();this.frame();await this.flush();},
  // pushState, as Jellyfin's router does (setting location.hash would queue jsdom's hashchange on the faked timers).
  navigate(hash){h.window.history.pushState(null,'',hash);for(const fn of teardowns)fn();for(const fn of navs)fn();}
 };
}

test('data before Jellyfin: only a marker until the rows come near, then both rows in place of it',async t=>{
 const h=setup(t);await h.start();
 assert.deepEqual(h.after(),['marker']);assert.equal(h.counts.cards,0);assert.equal(h.marker().getAttribute('aria-hidden'),'true');
 assert.deepEqual(h.delays(),[5000]);assert.equal(h.observers.length,0,'no observer before Jellyfin has rendered');
 await h.render();
 assert.equal(h.observers.length,1);const [io]=h.observers;
 assert.equal(io.options.rootMargin,'768px 0px');assert.deepEqual(io.targets,[h.marker()]);
 assert.equal(h.idles.size,1);assert.equal([...h.idles.values()][0].options.timeout,2000);
 assert.deepEqual(h.delays(),[],'the gate timers are cleared once armed');assert.equal(h.counts.cards,0);
 h.geometry.top=1200;io.fire();
 assert.deepEqual(h.after(),['Recommended','Similar']);assert.deepEqual(h.cards(),[20,20]);assert.equal(h.marker(),null);
 assert.equal(io.disconnected,true);assert.equal(h.idles.size,0,'the idle build is cancelled');
 assert.deepEqual(h.network,{similar:1,recommended:1});
});

test('rows within a screen are built as soon as More Like This fills, without an observer',async t=>{
 const h=setup(t,{near:true});await h.start();
 await h.render({card:false});assert.equal(h.counts.cards,0,'More Like This is still loading');assert.deepEqual(h.delays(),[500]);
 await h.fill();
 assert.deepEqual(h.after(),['Recommended','Similar']);assert.equal(h.observers.length,0);assert.equal(h.idles.size,0);assert.deepEqual(h.delays(),[]);
});

test('an observer hit is re-checked against the marker\'s current position',async t=>{
 const h=setup(t);await h.start();await h.render();const [io]=h.observers;
 io.fire();assert.equal(h.counts.cards,0,'the page grew since the hit was computed');assert.deepEqual(io.targets,[h.marker()]);assert.equal(io.disconnected,false);
 io.fire(false);assert.equal(h.counts.cards,0);
 h.geometry.top=-500;io.fire();assert.deepEqual(h.after(),['Recommended','Similar']);
});

test('far rows are built at idle, or on the next task without requestIdleCallback',async t=>{
 const h=setup(t);await h.start();await h.render();
 h.idle();assert.deepEqual(h.after(),['Recommended','Similar']);assert.equal(h.observers[0].disconnected,true);
 const webkit=setup(t,{idle:false});await webkit.start();await webkit.render();
 assert.equal(webkit.observers.length,1);assert.deepEqual(webkit.delays(),[0]);
 webkit.timer(0);assert.deepEqual(webkit.after(),['Recommended','Similar']);assert.equal(webkit.observers[0].disconnected,true);
});

test('without IntersectionObserver the rows are built at the gate',async t=>{
 const h=setup(t,{io:false});await h.start();assert.deepEqual(h.after(),['marker']);
 await h.render();assert.deepEqual(h.after(),['Recommended','Similar']);assert.equal(h.idles.size,0);
});

test('a failed More Like This is waited for 500 ms after the name; a page that never renders, 5 s',async t=>{
 const failed=setup(t,{near:true});await failed.start();
 await failed.render({card:false});assert.deepEqual(failed.delays(),[500],'the 5 s wait is replaced');assert.equal(failed.counts.cards,0);
 failed.timer(500);assert.deepEqual(failed.after(),['Recommended','Similar']);
 const never=setup(t,{near:true});await never.start();assert.deepEqual(never.delays(),[5000]);
 never.timer(5000);assert.deepEqual(never.after(),['Recommended','Similar']);
 // No More Like This results: Jellyfin hides it again, which passes the gate as well.
 const hidden=setup(t,{near:true});await hidden.start();await hidden.render({card:false,hide:true});assert.deepEqual(hidden.after(),['Recommended','Similar']);
});

test('data after Jellyfin rendered, or a view that already has rows: inserted at once, as before',async t=>{
 const h=setup(t);h.frame();await h.flush();await h.render();await h.respond();
 assert.deepEqual(h.after(),['Recommended','Similar']);assert.deepEqual(h.cards(),[20,20]);assert.equal(h.observers.length,0);assert.equal(h.marker(),null);
 const old='<div class="verticalSection jellyseerr-details-section"><h2>Old</h2></div>';
 const restored=setup(t,{html:page({after:old})});restored.frame();await restored.flush();
 await restored.render({card:false});await restored.respond();
 assert.deepEqual(restored.after(),['Recommended','Similar'],'the old rows are replaced in place');assert.equal(restored.counts.released,1);
 assert.equal(restored.observers.length,0);assert.equal(restored.marker(),null);
});

test('anything after More Like This keeps the immediate insert and its order',async t=>{
 // A div after More Like This, even a hidden one, puts Similar first (:last-of-type).
 for(const after of ['<div id="extra"></div>','<div id="extra" class="hide"></div>']){
  const h=setup(t,{html:page({after})});await h.start();
  assert.deepEqual(h.after(),['Similar','Recommended','extra']);assert.equal(h.observers.length+h.timers.size,0);
 }
 // Something visible after the content.
 const below=setup(t,{html:page({outside:'<div id="below"></div>'})});await below.start();assert.deepEqual(below.after(),['Recommended','Similar']);assert.equal(below.marker(),null);
 // Hidden elements and ones that take no space do not hold the rows back.
 const quiet=setup(t,{html:page({after:'<script></script><section hidden></section>',outside:'<div class="hide"></div><style></style>'})});await quiet.start();
 assert.deepEqual(quiet.after(),['marker','SCRIPT','SECTION']);
 quiet.geometry.top=100;await quiet.render();assert.deepEqual(quiet.after(),['Recommended','Similar','SCRIPT','SECTION']);
 // Added after the marker while the rows wait: it stays after them, as it would have.
 const late=setup(t);await late.start();late.anchor().parentElement.insertAdjacentHTML('beforeend','<div id="late"></div>');
 late.geometry.top=100;await late.render();assert.deepEqual(late.after(),['Recommended','Similar','late']);
});

test('leaving while the rows wait drops them; nothing is inserted later and Back inserts at once',async t=>{
 const h=setup(t);await h.start();await h.render();const [io]=h.observers;
 h.navigate('#!/home');
 assert.equal(h.marker(),null);assert.equal(io.disconnected,true);assert.equal(h.idles.size,0);assert.equal(h.timers.size,0);
 h.geometry.top=100;io.callback([{target:h.anchor(),isIntersecting:true}]);h.window.dispatchEvent(new h.window.Event('beforeprint'));
 assert.equal(h.counts.cards,0);assert.deepEqual(h.after(),[]);
 // Back to the cached view, which Jellyfin had rendered meanwhile.
 h.navigate('#!/details?id=movie-1');h.frame();await h.flush();
 assert.deepEqual(h.after(),['Recommended','Similar']);assert.deepEqual(h.network,{similar:1,recommended:1});
 // Leaving before Jellyfin rendered: the timers go too.
 const early=setup(t);await early.start();early.navigate('#!/home');assert.equal(early.timers.size,0);assert.equal(early.marker(),null);
 await early.render();assert.equal(early.observers.length,0);assert.equal(early.counts.cards,0);
});

test('a viewshow while the rows wait, or after they are built, requests and builds nothing again',async t=>{
 const h=setup(t);await h.start();await h.viewshow();
 assert.equal(h.document.querySelectorAll(`.${MARKER}`).length,1);assert.equal(h.counts.status,1);
 h.geometry.top=100;await h.render();assert.equal(h.counts.cards,40);
 await h.viewshow();assert.equal(h.counts.cards,40);assert.equal(h.counts.status,1);assert.deepEqual(h.network,{similar:1,recommended:1});
});

test('a user switch before the build drops the rows and releases the item for a later viewshow',async t=>{
 const h=setup(t);await h.start();await h.render();h.bumpEpoch();
 h.idle();assert.equal(h.counts.cards,0);assert.deepEqual(h.after(),[]);
 await h.viewshow();assert.deepEqual(h.after(),['Recommended','Similar'],'the item was released');
 assert.deepEqual(h.network,{similar:1,recommended:1});
 // The immediate path checks the identity too.
 const now=setup(t);now.frame();await now.flush();await now.render();now.bumpEpoch();await now.respond();
 assert.equal(now.counts.cards,0);await now.viewshow();assert.deepEqual(now.after(),['Recommended','Similar']);
});

test('a hidden view gets nothing; the shown details view gets the rows from the cached data',async t=>{
 const h=setup(t);await h.start();await h.render();
 h.view.classList.add('hide');h.document.body.insertAdjacentHTML('beforeend',page({id:'second'}));
 const second=h.document.getElementById('second');await h.render({v:second});
 h.idle();assert.deepEqual(h.after(),[],'nothing in the hidden view');assert.equal(h.counts.cards,0);
 h.frame();await h.flush();
 assert.deepEqual(h.after(second),['Recommended','Similar']);assert.deepEqual(h.network,{similar:1,recommended:1});
});

test('a frame that comes after the URL moved on starts nothing for the old item',async t=>{
 const h=setup(t);h.window.history.pushState(null,'','#!/details?id=movie-2');h.frame();await h.flush();
 assert.equal(h.counts.status,0);assert.equal(h.counts.item,0);assert.deepEqual(h.network,{similar:0,recommended:0});
 // While the rows wait: the URL check is made again at the build.
 const moved=setup(t);await moved.start();await moved.render();moved.window.history.pushState(null,'','#!/details?id=movie-2');moved.idle();
 assert.equal(moved.counts.cards,0);assert.equal(moved.marker(),null);
});

test('a failing build is logged, leaves no marker and releases the item',async t=>{
 let fail=true;const h=setup(t,{card:()=>{if(fail)throw new Error('card');}});
 h.expectConsoleError(/Error rendering similar and recommended sections/);
 await h.start();await h.render();h.idle();
 assert.equal(h.marker(),null);assert.deepEqual(h.cards(),[]);
 fail=false;await h.viewshow();assert.deepEqual(h.after(),['Recommended','Similar']);
});

test('a view without a name container takes the immediate path without errors',async t=>{
 const h=setup(t,{html:page({name:false})});await h.start();
 assert.deepEqual(h.after(),['Recommended','Similar']);assert.equal(h.observers.length+h.timers.size,0);
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
 const similarOnly=setup(t,{config:{JellyseerrShowRecommended:false},near:true});await similarOnly.start();await similarOnly.render();
 assert.deepEqual(similarOnly.network,{similar:1,recommended:0});assert.deepEqual(similarOnly.after(),['Similar']);
 // Blocklisted and library items are left out at data time.
 const extra=i=>i<5?{mediaInfo:{status:6}}:i<10?{mediaInfo:{jellyfinMediaId:`lib-${i}`}}:{};
 const filtered=setup(t,{config:{JellyseerrExcludeBlocklistedItems:true,JellyseerrExcludeLibraryItems:true},near:true});
 await filtered.start({similar:results('Similar',25,extra),recommended:results('Recommended',25,extra)});await filtered.render();
 assert.deepEqual(filtered.cards(),[15,15]);
 // Nothing left after filtering: no marker.
 const empty=setup(t,{config:{JellyseerrExcludeBlocklistedItems:true}});
 await empty.start({similar:results('Similar',3,()=>({mediaInfo:{status:6}})),recommended:{results:[]}});assert.equal(empty.marker(),null);
});

test('the similar-recommended measurement ends once, when the data is ready',async t=>{
 const h=setup(t);await h.start();
 assert.deepEqual(h.ends,[{name:'similar-recommended',marker:true,io:0,idle:0}]);
 await h.render();h.idle();assert.equal(h.ends.length,1);assert.equal(h.counts.cards,40);
});
