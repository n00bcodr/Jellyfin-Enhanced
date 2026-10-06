import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,deferred,jsonResponse} from '../helpers/harness.mjs';
function setup(t,{item={Type:'Movie',ProviderIds:{Tmdb:'42'}},data={},fetch,getItem}={}){
 let itemCalls=0,fetchCalls=0;const h=createHarness({html:'<div id="info"></div>',apiClient:{getItem:async(...args)=>{itemCalls++;return getItem?getItem(...args):item;}},fetch:async(...args)=>{fetchCalls++;return fetch?fetch(...args):jsonResponse(data);},globals:{requestAnimationFrame:fn=>{fn();return 1;}},JE:{pluginConfig:{DEFAULT_REGION:'AU'},t:key=>key,helpers:{addCSS:()=>{}}}});
 t.after(()=>h.close());h.load('enhanced/itemdetails/features-release-dates.js');return {...h,api:h.JE.internals.features,container:h.document.getElementById('info'),counts:()=>({itemCalls,fetchCalls}),async settle(){await new Promise(done=>setImmediate(done));}};
}
test('release chips deduplicate in-flight requests and resolve regional theatrical/digital/physical dates',async t=>{
 const pending=deferred();const h=setup(t,{fetch:()=>pending.promise});h.api.displayReleaseDate('movie',h.container);h.api.displayReleaseDate('movie',h.container);
 pending.resolve(jsonResponse({results:[{iso_3166_1:'AU',release_dates:[{type:3,release_date:'2025-03-01'},{type:2,release_date:'2025-02-01'}]},{iso_3166_1:'US',release_dates:[{type:4,release_date:'2025-04-01'}]},{iso_3166_1:'GB',release_dates:[{type:5,release_date:'2025-05-01'}]}]}));await h.settle();
 assert.equal(h.container.querySelectorAll('.mediaInfoItem-releaseDate').length,3);assert.match(h.container.querySelector('.je-release-date-cinema').textContent,/Feb/);assert.deepEqual(h.counts(),{itemCalls:1,fetchCalls:1});
 h.container.replaceChildren();h.api.displayReleaseDate('movie',h.container);assert.equal(h.container.children.length,3);assert.deepEqual(h.counts(),{itemCalls:1,fetchCalls:1});
});
test('episode premiere date bypasses external TMDB request',async t=>{
 const h=setup(t,{getItem:async(_user,id)=>id==='series'?{Type:'Series',ProviderIds:{Tmdb:'42'}}:{Type:'Episode',SeriesId:'series',PremiereDate:'2025-02-03T00:00:00Z'}});h.api.displayReleaseDate('episode',h.container);await h.settle();assert.equal(h.container.children.length,1);assert.equal(h.counts().fetchCalls,0);
});
test('missing metadata produces no placeholder or external request',async t=>{
 const h=setup(t,{item:{Type:'Movie'}});h.api.displayReleaseDate('movie',h.container);await h.settle();assert.equal(h.container.children.length,0);assert.equal(h.counts().fetchCalls,0);
});
test('release-date network failure removes placeholder and logs expected diagnostic',async t=>{
 const h=setup(t,{fetch:async()=>jsonResponse({},503)});h.expectConsoleError(/TMDB request failed/);h.api.displayReleaseDate('movie',h.container);await h.settle();assert.equal(h.container.children.length,0);
});
test('release response arriving after navigation does not recreate removed chips',async t=>{
 const response=deferred();const h=setup(t,{fetch:()=>response.promise});h.api.displayReleaseDate('movie',h.container);await Promise.resolve();
 const placeholder=h.container.querySelector('.mediaInfoItem-releaseDate');assert.ok(placeholder);h.container.replaceChildren();
 response.resolve(jsonResponse({results:[{iso_3166_1:'US',release_dates:[{type:3,release_date:'2025-01-01'}]}]}));await h.settle();
 assert.equal(h.container.children.length,0);assert.equal(placeholder.childNodes.length,0);assert.equal(placeholder.textContent,'');
});
test('calendar dates show the same day west of UTC',async t=>{
 // Runners pin TZ=UTC; switch this process to a zone behind UTC for the duration of the test.
 const previous=process.env.TZ;process.env.TZ='America/Los_Angeles';
 t.after(()=>{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;});
 assert.ok(new Date(2025,1,1).getTimezoneOffset()>0);
 const h=setup(t,{data:{results:[{iso_3166_1:'AU',release_dates:[{type:3,release_date:'2025-02-01T00:00:00.000Z'},{type:4,release_date:'2025-03-01'}]}]}});
 h.api.displayReleaseDate('movie',h.container);await h.settle();
 const format=(year,month,day)=>new Date(year,month-1,day).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});
 assert.equal(h.container.querySelector('.je-release-date-cinema').textContent.slice('local_movies'.length),format(2025,2,1));
 assert.equal(h.container.querySelector('.je-release-date-digital').textContent.slice('ondemand_video'.length),format(2025,3,1));
 const episode=setup(t,{getItem:async(_user,id)=>id==='series'?{Type:'Series',ProviderIds:{Tmdb:'42'}}:{Type:'Episode',SeriesId:'series',PremiereDate:'2025-02-03T00:00:00.0000000Z'}});
 episode.api.displayReleaseDate('episode',episode.container);await episode.settle();
 assert.equal(episode.container.textContent.slice('tv_guide'.length),format(2025,2,3));
});
test('malformed external release date cannot inject HTML into details',async t=>{
 const malicious='<img src=x onerror="alert(1)">';const h=setup(t,{data:{results:[{iso_3166_1:'US',release_dates:[{type:3,release_date:malicious}]}]}});h.api.displayReleaseDate('movie',h.container);await h.settle();assert.equal(h.container.querySelector('img'),null);assert.ok(h.container.textContent.includes(malicious));
});
