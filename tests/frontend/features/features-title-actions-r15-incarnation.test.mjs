import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, delivered } from '../helpers/title-actions-scopes.mjs';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
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
/** Begins a trusted touch hold on the card through the harness input adapter. */
function down(h, node) {
  const event = new h.window.Event('pointerdown', { bubbles: true, cancelable: true });
  Object.defineProperties(event, { pointerType: { value: 'touch' }, pointerId: { value: 7 }, clientX: { value: 10 }, clientY: { value: 10 } });
  h.trusted(node.querySelector('.je-discover-poster-box'), event);
}
for (const phase of ['hold', 'admission', 'entries', 'unchanged']) {
  test(`R15-S1: actual Discover card ${phase}`, async t => {
    const h = setup(t, { asks: false });
    const node = card(h);
    h.a.initialize(); await delivered();
    const gate = phase === 'admission' ? h.hold('GET', '/title-actions/movie/603') : phase === 'entries' ? h.hold('GET', '/acquire/status') : null;
    down(h, node);
    if (gate) {
      await wait(620); await delivered();
      assert.ok(h.sent('GET', phase === 'admission' ? '/title-actions/movie/603' : '/acquire/status').length > 0, 'reached the production await');
    }
    if (phase !== 'unchanged') {
      node.dataset.key = 'movie:tmdb:604';
      node.dataset.key = 'movie:tmdb:603';
      await delivered();
    }
    if (gate) gate.resolve(); else await wait(620);
    await wait(40); await delivered();
    assert.equal(!!h.document.querySelector('.je-actions-sheet'), phase === 'unchanged', 'only an uninterrupted incarnation may publish its sheet');
    if (phase !== 'unchanged') {
      down(h, node); await wait(620); await delivered();
      assert.ok(h.document.querySelector('.je-actions-sheet'), 'a fresh press on the restored production card opens');
    }
  });
}

test('R15-S1 control: a fresh press after Discover identity is restored opens in the same task',async t=>{
 const h=setup(t,{asks:false});const node=card(h);h.a.initialize();await delivered();

      node.dataset.key = 'movie:tmdb:604';
      node.dataset.key = 'movie:tmdb:603';

 down(h,node);await wait(620);await delivered();assert.ok(h.document.querySelector('.je-actions-sheet'));
});

test('R15 live control: releasing the long press cannot click its newly covering backdrop',async t=>{
 const h=setup(t,{asks:false});const node=card(h);h.a.initialize();await delivered();down(h,node);await wait(620);await delivered();
 const backdrop=h.document.querySelector('.je-actions-backdrop');assert.ok(backdrop);
 const release=h.window.MouseEvent;
 const compatibility=new release('click',{bubbles:true,cancelable:true});Object.defineProperties(compatibility,{pointerType:{value:'touch'},pointerId:{value:7}});
 h.trusted(backdrop,compatibility);assert.ok(h.document.querySelector('.je-actions-sheet'),'same pointer release is consumed even when Chromium retargets its click');
 const deliberate=new release('click',{bubbles:true,cancelable:true});Object.defineProperties(deliberate,{pointerType:{value:'touch'},pointerId:{value:8}});
 h.trusted(backdrop,deliberate);assert.equal(h.document.querySelector('.je-actions-sheet'),null,'a later deliberate backdrop tap still dismisses');
});

test('R15 live control: a new backdrop gesture may reuse a pointer id when no compatibility click followed the hold',async t=>{
 const h=setup(t,{asks:false});const node=card(h);h.a.initialize();await delivered();down(h,node);await wait(620);await delivered();
 const backdrop=h.document.querySelector('.je-actions-backdrop');assert.ok(backdrop);
 const nextDown=new h.window.Event('pointerdown',{bubbles:true,cancelable:true});Object.defineProperties(nextDown,{pointerType:{value:'touch'},pointerId:{value:7}});h.trusted(backdrop,nextDown);
 const nextClick=new h.window.MouseEvent('click',{bubbles:true,cancelable:true});Object.defineProperties(nextClick,{pointerType:{value:'touch'},pointerId:{value:7}});h.trusted(backdrop,nextClick);
 assert.equal(h.document.querySelector('.je-actions-sheet'),null);
});
