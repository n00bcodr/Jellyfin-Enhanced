import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,deferred} from '../helpers/harness.mjs';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const load=(h,name)=>h.load(name+'.js');
function core(h){for(const name of ['navigation','session','lifecycle','dom-observer','ui-kit'])load(h,'core/'+name);}

test('Requests rerender retains a valid pending avatar fetch',async t=>{
 const response=deferred();let fetched=0,created=0;
 const P={state:{requestsFilter:'all',requests:[{}],downloads:[],history:[],isLoading:false},renderRequestCard:()=>'<img class="je-request-avatar" data-avatar-src="/JellyfinEnhanced/proxy/avatar?path=one">',hydrateExternalLinks(){}};
 const h=createHarness({html:'<main id="je-downloads-container"></main>',JE:{pluginConfig:{JellyseerrEnabled:true,ShowDownloadsInRequests:false},internals:{requestsPage:P}},fetch:()=>{fetched++;return response.promise;}});t.after(()=>h.close());
 load(h,'enhanced/helpers');Object.assign(P,{clearAvatarObjectUrlCache:h.JE.helpers.clearAvatarObjectUrlCache,hydrateAvatarImages:h.JE.helpers.hydrateAvatarImages});
 h.window.URL.createObjectURL=()=>`blob:avatar-${++created}`;h.window.URL.revokeObjectURL=()=>{};
 load(h,'arr/requests/requests-page-render');P.renderPage();await tick();P.renderPage();await tick();
 assert.equal(fetched,1);response.resolve(new Response('avatar'));await tick();await tick();
 const img=h.document.querySelector('img');assert.equal(img.getAttribute('src'),'blob:avatar-1');assert.equal(img.style.display,'');assert.equal(created,1);
});

test('explicit avatar invalidation cannot hide a newer hydration of the same image',async t=>{
 const pending=[];let created=0;
 const h=createHarness({html:'<img class="je-request-avatar" data-avatar-src="/JellyfinEnhanced/proxy/avatar?path=one">',fetch:()=>{const response=deferred();pending.push(response);return response.promise;}});t.after(()=>h.close());load(h,'enhanced/helpers');
 h.window.URL.createObjectURL=()=>`blob:avatar-${++created}`;h.window.URL.revokeObjectURL=()=>{};
 const img=h.document.querySelector('img');h.JE.helpers.hydrateAvatarImages(h.document);await tick();
 h.JE.helpers.clearAvatarObjectUrlCache(true);h.JE.helpers.hydrateAvatarImages(h.document);await tick();assert.equal(pending.length,2);
 pending[1].resolve(new Response('new'));await tick();await tick();assert.equal(img.getAttribute('src'),'blob:avatar-1');
 pending[0].resolve(new Response('old'));await tick();await tick();assert.equal(img.getAttribute('src'),'blob:avatar-1');assert.equal(img.style.display,'');assert.equal(created,1);
});

test('registering the default theme replaces fallback detection and variables',t=>{
 const h=createHarness({JE:{cdn:{url:(scope,path)=>`/cdn/${scope}/${path}`}}});t.after(()=>h.close());load(h,'enhanced/themer');
 h.JE.themer.registerTheme('default',{name:'Custom default',uniqueIdentifier:null,variables:{primaryAccent:null,primaryAccentFallback:'#123456'}});
 assert.equal(h.JE.themer.detectActiveTheme().name,'Custom default');assert.equal(h.JE.themer.getThemeVariable('primaryAccent'),'#123456');
});

test('a stale item result does not cache an unsupported Letterboxd verdict',async t=>{
 const old=deferred();let fetched=0;
 const h=createHarness({url:'http://jellyfin.test/web/index.html#!/details?id=movie',html:'<main id="itemDetailPage" class="libraryPage"><div class="itemExternalLinks"></div></main>',JE:{pluginConfig:{LetterboxdEnabled:true,ShowLetterboxdLinkAsText:true},cdn:{selfhst:path=>`/cdn/${path}`}},apiClient:{getItem:()=>{fetched++;return fetched===1?old.promise:Promise.resolve({Id:'movie',Type:'Movie',ProviderIds:{Imdb:'tt67890'}});}},globals:{requestIdleCallback:callback=>setTimeout(callback,0)}});t.after(()=>h.close());core(h);load(h,'enhanced/helpers');load(h,'others/letterboxd-links');await h.JE.initializeLetterboxdLinksScript();await tick();assert.equal(fetched,1);
 h.window.dispatchEvent(new h.window.Event('je:spoiler-state-changed'));old.resolve({Id:'movie',Type:'Movie',ProviderIds:{Imdb:'tt12345'}});await tick();
 assert.equal(h.document.querySelector('.letterboxd-link'),null);
 h.document.querySelector('main').appendChild(h.document.createElement('span'));await new Promise(resolve=>setTimeout(resolve,150));
 assert.equal(h.document.querySelector('.letterboxd-link')?.href,'https://letterboxd.com/imdb/tt67890');assert.equal(fetched,2);
});
