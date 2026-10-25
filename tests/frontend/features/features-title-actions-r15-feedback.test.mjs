import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, delivered, moreInfo, mount, press, remount } from '../helpers/title-actions-scopes.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Hides through the managed row, real HC modules and transport fixture; retains its Undo. */
async function hide(t, onPage = false, via = 'more') {
  const h = setup(t, { asks: false });
  h.JE.pluginConfig.JellyseerrEnabled = false;
  h.JE.userConfig = { hiddenContent: { items: {}, settings: { enabled: true, showHideButtons: true, showButtonDetails: true, showButtonJellyseerr: true, showHideConfirmation: true } } };
  h.load('enhanced/hiddencontent/hidden-content-data.js');
  h.load('enhanced/hiddencontent/hidden-content-dialogs.js');
  const hc = h.JE.internals.hiddenContent;
  hc.refreshNativeCardVisibility = () => {};
  h.JE.hiddenContent = { buildTitleControl: hc.buildTitleControl };
  const expiry = [];
  const timer = h.window.setTimeout;
  h.window.setTimeout = (fn, ms, ...args) => ms === 8000 ? (expiry.push(fn), 0) : timer.call(h.window, fn, ms, ...args);
  h.a.initialize();
  if (onPage) {
    let original;
    if(via==='original') {original=hc.buildTitleControl({mediaType:'movie',tmdbId:603,name:'The Matrix'}); h.row().append(original);}
    mount(h); await delivered();
    if(original) h.click(original); else await press(h, 'hide');
    h.click(h.document.querySelector('.je-hide-confirm-hide')); await delivered();
    const undo = h.document.querySelector('.je-undo-btn'); assert.ok(undo);
    assert.equal(undo.parentElement.parentElement, h.document.body);
    assert.equal(h.sent('PUT', '/user-settings/').length, 1);
    return { h, undo, expire: expiry[0] };
  }
  // More Info metadata/admission are the existing helper's labelled fetch fixtures; HC uses the real writer.
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE);
  await wait(30); await delivered(); h.a.scan(); await delivered();
  const info = moreInfo(h); assert.ok(info);
  if(via==='original') h.click(info.querySelector('[data-mount="je-secondary-actions"] .je-detail-hide-btn'));
  else {h.click(info.querySelector('.je-actions-wide-more, .je-actions-more')); await delivered();
   h.click(h.document.querySelector('.je-actions-entry[data-action="hide"]'));}
  await delivered();
  h.click(h.document.querySelector('.je-hide-confirm-hide')); await delivered();
  assert.equal(h.sent('PUT', '/user-settings/').length, 1);
  const undo = info.querySelector('.je-undo-btn'); assert.ok(undo);
  assert.equal(h.JE.isCovered(undo), false);
  assert.equal(expiry.length, 1);
  return { h, info, undo, expire: expiry[0] };
}

test('a page title-action Undo is gone after its route ends, and its old node cannot unhide on the next page', async t => {
  const { h, undo } = await hide(t, true);
  await h.leave('#/movies');
  console.log(JSON.stringify({ step: 'after page navigation', connected: undo.isConnected, currentRoute: h.window.location.hash }));
  h.click(undo); await delivered();
  assert.deepEqual({ connected: undo.isConnected, deletes: h.sent('DELETE', '/user-settings/').length }, { connected: false, deletes: 0 });
});

for (const terminal of ['expiry', 'successful Undo']) {
  for (const moved of [false, true]) {
    test(`${terminal}: ${moved ? 'preserve deliberate other focus' : 'focused Undo must leave focus inside More Info'}`, async t => {
      const { h, info, undo, expire } = await hide(t);
      undo.focus(); assert.equal(h.document.activeElement, undo);
      const other = info.querySelector('.modal-refresh') || info.querySelector('button');
      if (terminal === 'successful Undo') { h.click(undo); await delivered(); }
      if (moved) { other.focus(); assert.equal(h.document.activeElement, other); }
      if (terminal === 'expiry') expire();
      await wait(370); await delivered();
      assert.equal(undo.isConnected, false);
      assert.equal(moreInfo(h), info);
      assert.equal(h.sent('DELETE', '/user-settings/').length, terminal === 'expiry' ? 0 : 1);
      console.log(JSON.stringify({ terminal, moved, focus: h.document.activeElement?.tagName, focusClass: h.document.activeElement?.className, focusInInfo: info.contains(h.document.activeElement) }));
      if (moved) assert.equal(h.document.activeElement, other);
      else assert.equal(info.contains(h.document.activeElement), true, 'the modal is still open; its focused actionable feedback must not drop focus onto body');
    });
  }
}

// The same accepted Hide is retained while its actionable feedback ends with its producer.
for (const transition of ['row', 'pagehide', 'freeze', 'feature-off', 'user', 'expiry']) {
 test(`R15-B1 page feedback ends on ${transition}`, async t => {
  const {h,undo,expire}=await hide(t,true);
  if(transition==='row') remount(h);
  if(transition==='pagehide') h.pagehide();
  if(transition==='freeze') h.freeze();
  if(transition==='feature-off') { h.JE.pluginConfig.NativeAbsentDetailsEnabled=false; h.a.scan(); }
  if(transition==='user') h.switchUser();
  if(transition==='expiry') expire();
  await wait(330); await delivered();
  assert.equal(undo.isConnected,false);
  h.click(undo); await delivered();
  assert.equal(h.sent('DELETE','/user-settings/').length,0);
  assert.equal(h.sent('PUT','/user-settings/').length,1,'accepted Hide is not cancelled or replayed');
 });
}

test('R15-B1 live page Undo retains the original account and target', async t=>{
 const {h,undo}=await hide(t,true); h.click(undo); await delivered();
 const writes=h.sent('DELETE','/user-settings/'); assert.equal(writes.length,1);
 assert.equal(writes[0][0],'user-a'); assert.match(writes[0][2],/movie%3Atmdb%3A603$/);
});

test('R15-B1 stale feedback is refused before the lifecycle sweep',async t=>{
 const {h,undo}=await hide(t,true);
 h.window.history.replaceState(null,'','#/movies'); h.click(undo); await delivered();
 assert.equal(h.sent('DELETE','/user-settings/').length,0); assert.equal(undo.isConnected,false);
});

for(const transition of ['route','expiry','user']) {
 test(`R15-B1 intentional ownerless library feedback: ${transition}`,async t=>{
  const h=setup(t,{asks:false});
  h.JE.userConfig={hiddenContent:{items:{},settings:{enabled:true}}};
  h.load('enhanced/hiddencontent/hidden-content-data.js'); h.load('enhanced/hiddencontent/hidden-content-dialogs.js');
  const hc=h.JE.internals.hiddenContent; hc.refreshNativeCardVisibility=()=>{};
  const expiry=[];const timer=h.window.setTimeout;
  h.window.setTimeout=(fn,ms,...args)=>ms===8000?(expiry.push(fn),0):timer.call(h.window,fn,ms,...args);
  hc.showUndoToast('Library title','movie:tmdb:603'); const undo=h.document.querySelector('.je-undo-btn'); assert.ok(undo);
  if(transition==='route') await h.leave();
  if(transition==='user') h.switchUser();
  if(transition==='expiry') { expiry[0]();await wait(330); }
  h.click(undo);await delivered();
  assert.equal(h.sent('DELETE','/user-settings/').length,transition==='route'?1:0);
 });
}

test('R15-C1 an expiring Undo never takes focus from a newer modal',async t=>{
 const {h,info,undo,expire}=await hide(t);undo.focus();
 const form=h.JE.jellyseerrModal.create({title:'Newer',bodyHtml:'<input autofocus>',onSave(){},operation:h.JE.scopeOf(info)});form.show();await delivered();
 const focused=h.document.activeElement;assert.ok(form.modalElement.contains(focused));expire();await wait(330);await delivered();
 assert.equal(h.document.activeElement,focused);assert.equal(undo.isConnected,false);
});

for(const onPage of [false,true]) {
 test(`R15-B1 managed original ${onPage?'page':'modal'} feedback ends with its route`,async t=>{
  const {h,undo}=await hide(t,onPage,'original');await h.leave();h.click(undo);await delivered();
  assert.equal(undo.isConnected,false);assert.equal(h.sent('DELETE','/user-settings/').length,0);assert.equal(h.sent('PUT','/user-settings/').length,1);
 });
}

/** Draws the production Discover card used by the reviewer witness. */
function card(h) {
  h.JE.pluginConfig.JellyseerrEnabled = false;
  h.load('arr/hub/hub-discover.js');
  const node = h.JE.internals.arrDiscover.buildCard({ key: 'movie:tmdb:603', kind: 'movie', tmdbId: 603, title: 'Original', inLibrary: false }, { caps: { canRequest: false }, surface: 'discover' });
  h.document.body.append(node);
  assert.equal(node.dataset.key, 'movie:tmdb:603');
  assert.equal(node.hasAttribute('data-je-hide-title'), false);
  return node;
}


for(const transition of ['remove','recycle']) {
 test(`R15-B1 actual Discover More feedback ends on ${transition}`,async t=>{
  const h=setup(t,{asks:false});h.JE.userConfig={hiddenContent:{items:{},settings:{enabled:true,showHideButtons:true,showButtonJellyseerr:true,showHideConfirmation:true}}};
  h.load('enhanced/hiddencontent/hidden-content-data.js');h.load('enhanced/hiddencontent/hidden-content-dialogs.js');
  const hc=h.JE.internals.hiddenContent;hc.refreshNativeCardVisibility=()=>{};h.JE.hiddenContent={buildTitleControl:hc.buildTitleControl};
  const node=card(h);h.a.initialize();await delivered();
  h.click(node.querySelector('.je-card-more'));await delivered();
  h.click(h.document.querySelector('.je-actions-entry[data-action="hide"]'));await delivered();
  h.click(h.document.querySelector('.je-hide-confirm-hide'));await delivered();
  const undo=h.document.querySelector('.je-undo-btn');assert.ok(undo);
  if(transition==='remove')node.remove();else {

      node.dataset.key = 'movie:tmdb:604';
      node.dataset.key = 'movie:tmdb:603';

  }
  await delivered();h.a.scan();await delivered();h.click(undo);await delivered();
  assert.equal(undo.isConnected,false);assert.equal(h.sent('DELETE','/user-settings/').length,0);assert.equal(h.sent('PUT','/user-settings/').length,1);
 });
}

test('R15-B1 expiry ends activation before the fade finishes',async t=>{
 const {h,undo,expire}=await hide(t,true);expire();h.click(undo);await delivered();
 assert.equal(h.sent('DELETE','/user-settings/').length,0);
 await wait(330);assert.equal(undo.isConnected,false);
});

for (const owned of [false, true]) {
 test(`R15-B1 library Hide forwards ${owned ? 'its supplied feedback owner' : 'the intentional ownerless lifetime'}`, async t => {
  const h=setup(t,{asks:false});h.JE.userConfig={hiddenContent:{items:{},settings:{enabled:true}}};
  h.load('enhanced/hiddencontent/hidden-content-data.js');h.load('enhanced/hiddencontent/hidden-content-dialogs.js');
  const hc=h.JE.internals.hiddenContent;let saves=0;hc.debouncedSave=()=>{saves++;};hc.refreshNativeCardVisibility=()=>{};
  h.a.initialize();
  hc.hideItem({itemId:'library-1',name:'Library title',type:'Movie'},owned?h.a.generation():null);
  const undo=h.document.querySelector('.je-undo-btn');assert.ok(undo);assert.equal(saves,1);
  await h.leave();assert.equal(undo.isConnected,!owned);
  h.click(undo);await delivered();assert.equal(saves,owned?1:2);
 });
}
