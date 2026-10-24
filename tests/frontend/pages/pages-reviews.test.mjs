import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createHarness} from '../helpers/harness.mjs';

async function setup(t,{item={Id:'item',Type:'Movie',ProviderIds:{Tmdb:'7'}},config={},spoilerBlur={},reviews=[],tmdb=[],anilist={Reviews:[]},admin=false,parent={Type:'Series',ProviderIds:{Tmdb:'9'}}}={}) {
  let hook;const calls=[];
  const h=createHarness({html:'<div id="itemDetailPage"><div class="mediaInfoItems"></div><div class="tagline"></div></div>',url:'http://jellyfin.test/web/index.html#!/details?id=item',apiClient:{getItem:async(_user,id)=>id==='series'?parent:item,getCurrentUser:async()=>({Id:'user-a',Policy:{IsAdministrator:admin}})},JE:{
    pluginConfig:{ShowReviews:true,TmdbEnabled:true,ShowUserReviews:true,...config},spoilerBlur,
    escapeHtml:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
    t:key=>key,icon:()=>'<span>star</span>',IconName:{STAR:'star'},
    cdn:{url:(source,file)=>`/cdn/${source}/${file}`},
    helpers:{onViewPage:fn=>{hook=fn;return ()=>{};},createExternalLink:(href,{className})=>Object.assign(h.document.createElement('a'),{href,className})},
    core:{api:{fetch:async url=>{calls.push(url);return url.includes('/anilist/reviews')?anilist:{results:tmdb};},plugin:async url=>{calls.push(url);return {reviews};}}}
  }});
  t.after(()=>h.close());
  // Advance the page-visibility delay without sleeping; promises still resolve asynchronously.
  h.window.setTimeout=fn=>{queueMicrotask(fn);return 1;};
  h.load('elsewhere/reviews.js');h.JE.initializeReviewsScript();
  async function navigate(){if(hook){await hook(null,h.document.querySelector('#itemDetailPage'),h.window.location.hash);await nextTurn();}}
  await navigate(); return {...h,calls,navigate};
}

for(const Type of ['Movie','Series','Season','Episode']) {
  // Season/Episode pages are guarded through their series; the others through their own id.
  const guardedKey=Type==='Season'||Type==='Episode'?'series':'item';
  const item={Id:'item',Type,SeriesId:'series',ProviderIds:{Tmdb:'7'},ParentIndexNumber:1,IndexNumber:2};
  const guard=key=>({whenLoaded:async()=>{},isLoadOk:()=>true,
    isEnabledFor:id=>Type!=='Movie'&&id===key,isMovieEnabledFor:id=>Type==='Movie'&&id===key});
  test(`reviews suppress guarded ${Type} pages before fetching content`,async t=>{
    const h=await setup(t,{item,config:{SpoilerBlurEnabled:true},spoilerBlur:guard(guardedKey)});
    assert.equal(h.calls.length,0);assert.equal(h.document.querySelector('.tmdb-reviews-section'),null);
  });
  test(`reviews still load on ${Type} pages when only another item is guarded`,async t=>{
    const h=await setup(t,{item,config:{SpoilerBlurEnabled:true},spoilerBlur:guard('other')});
    assert.ok(h.calls.length>0);assert.ok(h.document.querySelector('.tmdb-reviews-section'));
  });
}
test('reviews fail closed when spoiler state fails to load',async t=>{
  const h=await setup(t,{config:{SpoilerBlurEnabled:true},spoilerBlur:{whenLoaded:async()=>{},isLoadOk:()=>false}});
  assert.equal(h.calls.length,0);assert.equal(h.document.querySelector('.tmdb-reviews-section'),null);
});
test('reviews honor user opt-out of hiding reviews and render an empty writeable section once',async t=>{
  const h=await setup(t,{config:{SpoilerBlurEnabled:true},spoilerBlur:{getUserPrefs:()=>({HideReviews:false}),isMovieEnabledFor:()=>true}});
  assert.equal(h.calls.length,2);assert.ok(h.document.querySelector('.tmdb-reviews-section'));await h.navigate();assert.equal(h.calls.length,2);
});
test('episode reviews use series/season/episode key without fetching top-level TMDB reviews',async t=>{
  const h=await setup(t,{item:{Id:'episode',Type:'Episode',SeriesId:'series',ProviderIds:{Tmdb:'episode-tmdb-id'},ParentIndexNumber:0,IndexNumber:2}});
  assert.deepEqual(h.calls,['/reviews/tv/9:s0:e2']);assert.ok(h.document.querySelector('.tmdb-reviews-section'));
});
test('review cards escape user content and regular viewers cannot moderate other users',async t=>{
  const h=await setup(t,{reviews:[{userId:'other',userName:'<img src=x>',content:'<script>alert(1)</script> **Bold** [unsafe](javascript:alert(1))',rating:4}],tmdb:[{author:'<b>Author</b>',content:'Hello',author_details:{rating:8}}]});
  assert.equal(h.document.querySelectorAll('.tmdb-review-card').length,2);
  assert.equal(h.document.querySelector('.tmdb-review-author').textContent,'<img src=x>');
  assert.equal(h.document.querySelector('.tmdb-reviews-section script'),null);
  assert.equal(h.document.querySelector('a[href^="javascript:"]'),null);
  assert.equal(h.document.querySelector('.je-review-admin-delete-btn'),null);
  assert.equal(h.document.querySelector('.je-review-edit-btn'),null);assert.equal(h.document.querySelector('.je-review-delete-btn'),null);
  assert.match(h.document.querySelector('.je-avg-user-rating-chip').textContent,/8/);
});
test('AniList reviews of an anime with an AniList id render as cards with score, logo and link beside TMDB ones',async t=>{
  const Review={Author:'Kai',Summary:'Solid',Content:'Body text',Score:85,CreatedAt:'2021-04-17T13:07:24Z',Url:'https://anilist.co/review/1'};
  const h=await setup(t,{item:{Id:'item',Type:'Series',ProviderIds:{Tmdb:'7',AniList:'113415'}},config:{ShowAnilistReviews:true},anilist:{SiteUrl:'x',Reviews:[Review,{...Review,Author:'Evil',Url:'https://evil.test/x'}]},tmdb:[{author:'Tm',content:'Hello',url:'https://www.themoviedb.org/review/9'}]});
  assert.ok(h.calls.some(url=>url.endsWith('/anilist/reviews?anilistId=113415')));
  const cards=[...h.document.querySelectorAll('.je-anilist-review-card')];
  assert.equal(cards.length,2);assert.equal(h.document.querySelectorAll('.tmdb-review-card').length,3);
  assert.match(cards[0].textContent,/Kai/);assert.match(cards[0].textContent,/8\.5/);
  assert.equal(cards[0].querySelector('a.je-review-source').href,'https://anilist.co/review/1');
  assert.equal(cards[0].querySelector('.je-review-source-logo').getAttribute('src'),'/cdn/mdblist-logos/anilist.png');
  assert.equal(cards[1].querySelector('a'),null);
  const tmdb=[...h.document.querySelectorAll('.tmdb-review-card:not(.je-anilist-review-card)')].find(card=>card.textContent.includes('Tm'));
  assert.equal(tmdb.querySelector('.je-review-source-logo').getAttribute('src'),'/cdn/mdblist-logos/tmdb.png');
  assert.equal(tmdb.querySelector('a.je-review-source').href,'https://www.themoviedb.org/review/9');
});
test('AniList reviews are not requested without an AniList id',async t=>{
  const h=await setup(t,{config:{ShowAnilistReviews:true}});
  assert.ok(!h.calls.some(url=>url.includes('/anilist/reviews')));
});
test('regular viewers get edit and delete controls on their own review only',async t=>{
  const h=await setup(t,{reviews:[{userId:'other',userName:'Other',content:'Theirs',rating:3},{userId:'user-a',userName:'Me',content:'Mine',rating:4}]});
  const card=text=>[...h.document.querySelectorAll('.tmdb-review-card')].find(c=>c.textContent.includes(text));
  assert.equal(card('Theirs').querySelector('.je-review-btn'),null);
  assert.ok(card('Mine').querySelector('.je-review-edit-btn'));assert.ok(card('Mine').querySelector('.je-review-delete-btn'));
  assert.equal(card('Mine').querySelector('.je-review-admin-delete-btn'),null);
});
test('admin viewers see moderation controls and missing translations use readable fallback',async t=>{
  const h=await setup(t,{admin:true,reviews:[{userId:'other',userName:'Other',content:'Review',rating:3}]});
  assert.equal(h.document.querySelector('.je-review-admin-delete-btn').title,'Delete as admin');
});
test('review form rejects empty input, counts characters, saves trimmed content and preserves input on failure',async t=>{
  const h=await setup(t);const mutations=[];
  h.JE.core.api.plugin=async(path,options)=>{mutations.push({path,options});throw Error('offline');};
  h.document.querySelector('.je-review-write-btn').click();
  const textarea=h.document.querySelector('textarea');const submit=h.document.querySelector('.je-review-submit-btn');
  assert.equal(h.document.activeElement,textarea);assert.equal(textarea.maxLength,2000);
  submit.click();assert.equal(mutations.length,0);assert.equal(h.document.querySelector('.je-review-form-error').textContent,'reviews_form_error_empty');
  textarea.value='  Test review  ';textarea.dispatchEvent(new h.window.Event('input'));
  assert.equal(h.document.querySelector('.je-review-char-count').textContent,'15');
  submit.click();await nextTurn();
  assert.equal(mutations.length,1);assert.equal(mutations[0].path,'/reviews/movie/7');
  assert.equal(mutations[0].options.method,'POST');assert.equal(mutations[0].options.skipRetry,true);
  assert.equal(mutations[0].options.body.content,'Test review');assert.equal(mutations[0].options.body.rating,null);
  assert.equal(submit.disabled,false);assert.equal(textarea.value,'  Test review  ');
  assert.equal(h.document.querySelector('.je-review-form-error').textContent,'reviews_form_error_save');
  h.document.querySelector('.je-review-cancel-btn').click();assert.equal(h.document.querySelector('.je-review-form'),null);
});
test('review star picker supports half stars and rating-only submissions',async t=>{
  const h=await setup(t);const mutations=[];
  h.JE.core.api.plugin=async(path,options)=>{mutations.push({path,options});throw Error('offline');};
  h.document.querySelector('.je-review-write-btn').click();
  const star=h.document.querySelector('[data-value="4"]');star.getBoundingClientRect=()=>({left:100,width:20});
  star.dispatchEvent(new h.window.MouseEvent('click',{clientX:105}));
  assert.equal(h.document.querySelector('.je-star-label').textContent,'3.5/5');
  h.document.querySelector('.je-review-submit-btn').click();await nextTurn();
  assert.equal(mutations[0].options.body.rating,3.5);assert.equal(mutations[0].options.body.content,'');
  h.document.querySelector('.je-star-clear-btn').click();assert.equal(h.document.querySelector('.je-star-label').textContent,'');
});
for(const admin of [false,true]){
  test(`review deletion uses ${admin?'moderation':'own-user'} endpoint with one mutation and refresh`,async t=>{
    const h=await setup(t,{admin,reviews:[{userId:admin?'other-user':'user-a',userName:'Reviewer',content:'Delete me'}]});
    const calls=[];h.window.confirm=()=>true;
    h.JE.core.api.plugin=async(path,options)=>{calls.push({path,options});return {reviews:[]};};
    h.document.querySelector('.je-review-delete-btn').click();await nextTurn();
    assert.equal(calls[0].path,admin?'/reviews/admin/otheruser/movie/7':'/reviews/movie/7');
    assert.equal(calls[0].options.method,'DELETE');assert.equal(calls[0].options.skipRetry,true);
    assert.equal(calls.filter(c=>c.options?.method==='DELETE').length,1);
    assert.equal(h.document.querySelector('.je-user-review-card'),null);
  });
}
test('review canceled deletion makes no mutation',async t=>{
  const h=await setup(t,{reviews:[{userId:'user-a',content:'Keep me'}]});h.window.confirm=()=>false;
  const count=h.calls.length;h.document.querySelector('.je-review-delete-btn').click();await nextTurn();
  assert.equal(h.calls.length,count);assert.ok(h.document.querySelector('.je-user-review-card'));
});
test('review moderation 404 displays actionable error and refreshes actual state',async t=>{
  const h=await setup(t,{admin:true,reviews:[{userId:'other-user',content:'Old review'}]});const alerts=[];const requests=[];
  h.expectConsoleError('Reviews: Delete failed');h.window.confirm=()=>true;h.window.alert=message=>alerts.push(message);
  h.JE.core.api.plugin=async(path,options)=>{requests.push({path,options});if(options?.method==='DELETE')throw {status:404};return {reviews:[]};};
  h.document.querySelector('.je-review-delete-btn').click();await nextTurn();
  assert.equal(alerts.length,1);assert.match(alerts[0],/No matching review to delete/);
  assert.equal(requests.length,2);assert.equal(h.document.querySelector('.je-user-review-card'),null);
});
test('successful review creation refreshes persisted content and edit prepopulates and saves changes',async t=>{
  const h=await setup(t);let stored=[];const saved=[];
  h.JE.core.api.plugin=async(path,options)=>{
    if(options?.method==='POST'){saved.push(options.body);stored=[{userId:'user-a',userName:'Me',...options.body}];return {};}
    return {reviews:stored};
  };
  h.document.querySelector('.je-review-write-btn').click();
  h.document.querySelector('textarea').value='First version';h.document.querySelector('.je-review-submit-btn').click();await nextTurn();
  assert.equal(h.document.querySelector('.je-user-review-card .tmdb-review-text').textContent,'First version');
  assert.equal(h.document.querySelector('.je-review-write-btn'),null);
  h.document.querySelector('.je-review-edit-btn').click();assert.equal(h.document.querySelector('textarea').value,'First version');
  h.document.querySelector('textarea').value='Updated version';h.document.querySelector('.je-review-submit-btn').click();await nextTurn();
  assert.equal(saved.length,2);assert.equal(h.document.querySelector('.je-user-review-card .tmdb-review-text').textContent,'Updated version');
  assert.equal(h.document.querySelector('.je-review-form'),null);
});
test('review HTML becomes markup instead of showing as raw tags',async t=>{
  const html="I enjoyed <em>'The Mule'</em>. A <a href=\"https://x.test/a\" rel=\"nofollow\">real dude</a>!<br>Done <b>now</b>";
  const h=await setup(t,{tmdb:[{author:'Tm',content:html}]});
  const text=h.document.querySelector('.tmdb-review-text');
  assert.ok(!text.textContent.includes('<'));assert.ok(!text.textContent.includes('rel='));
  assert.equal(text.querySelector('a').getAttribute('href'),'https://x.test/a');
  assert.ok(text.querySelector('em'));assert.ok(text.querySelector('strong'));
});
