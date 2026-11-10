import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness, plain} from '../../helpers/harness.mjs';
function setup(t,html=''){
  let callback;let subscriptions=0;let releases=0;
  const h=createHarness({html,JE:{currentSettings:{},helpers:{onBodyMutation:(id,fn)=>{callback=fn;subscriptions++;return {unsubscribe(){releases++;}};}}}});
  t.after(()=>h.close());h.load('enhanced/player/subtitles.js');
  return {...h, mutate:node=>callback([{addedNodes:[node]}]),counts:()=>({subscriptions,releases})};
}
for(const [color,expected] of [['transparent',{swatch:'#ffffff',alphaValue:0}],['#123456',{swatch:'#123456',alphaValue:255}],['#12345680',{swatch:'#123456',alphaValue:128}],[null,{swatch:'#ffffff',alphaValue:10}],['bad',{swatch:'#ffffff',alphaValue:10}],['#"><b>x',{swatch:'#ffffff',alphaValue:10}],['#zzzzzz80',{swatch:'#ffffff',alphaValue:10}]]){
  test(`subtitle color decoding ${color}`,t=>{const h=setup(t);assert.deepEqual(plain(h.JE.decodeSubtitleColor(color,{fallbackSwatch:'#ffffff',fallbackAlphaValue:10})),expected);});
}
test('a crafted subtitle colour or font never adds a declaration to the ::cue rule or the subtitle element',t=>{
  const h=setup(t,'<video></video><div class="videoSubtitles"><div class="videoSubtitlesInner">Cue</div></div>');
  const native=h.document.createElement('style');native.id='htmlvideoplayer-cuestyle';h.document.head.append(native);
  const payload='red; background-image: url(https://tracker.invalid/x)';
  h.JE.currentSettings.customSubtitleTextColor=payload;h.JE.currentSettings.customSubtitleBgColor=payload;
  h.JE.applySavedStylesWhenReady();
  const rule=()=>h.document.getElementById('je-html-videoplayer-cuestyle').sheet.cssRules[0].cssText;
  assert.doesNotMatch(rule(),/tracker\.invalid|background-image/);
  assert.match(rule(),/color: #FFFFFFFF/i,'the default text colour instead');
  // A font value from the caller is held to the same rule.
  h.JE.applySubtitleStyles('#ffff00','transparent',1.8,'serif; background-image: url(https://tracker.invalid/f)','none');
  assert.doesNotMatch(rule(),/tracker\.invalid|background-image/);
  assert.match(rule(),/color: #ffff00/i,'a valid colour is kept');
  const inner=h.document.querySelector('.videoSubtitlesInner');
  assert.doesNotMatch(inner.getAttribute('style'),/tracker\.invalid/);
});
test('subtitle effects fall back to Auto for stale selections and honor explicit None',t=>{
  const h=setup(t);
  assert.notEqual(h.JE.getSubtitleTextShadow('transparent',999),'none');
  assert.equal(h.JE.getSubtitleTextShadow('#000000ff',999),'none');
  assert.equal(h.JE.getSubtitleTextShadow('transparent',1),'none');
  assert.match(h.JE.getSubtitleTextShadow('transparent',3),/#000/);
});
test('subtitle styling covers primary/secondary tracks and restores exact native styles when disabled',t=>{
  const h=setup(t,'<video></video><div class="videoSubtitles" style="left: 10%;"><div class="videoSubtitlesInner" style="color: red; margin-bottom: 4px;">Primary</div><div class="videoSecondarySubtitlesInner" style="margin-bottom: 8px;">Secondary</div></div><div id="untouched" class="videoSubtitlesInner" style="font-style: italic;"></div>');
  const untouched=h.document.getElementById('untouched');untouched.remove();
  const elements=[...h.document.querySelectorAll('.videoSubtitles,.videoSubtitlesInner,.videoSecondarySubtitlesInner')];
  const originals=elements.map(e=>e.getAttribute('style'));
  h.JE.applySavedStylesWhenReady();
  assert.equal(elements[0].style.bottom,'5%');
  assert.equal(elements[1].style.marginBottom,'0px');
  assert.equal(elements[2].style.marginBottom,'8px');
  assert.equal(elements[1].style.getPropertyPriority('color'),'important');
  h.JE.applySavedStylesWhenReady();
  assert.deepEqual(h.counts(),{subscriptions:2,releases:1});
  h.document.body.append(untouched);
  h.JE.currentSettings.disableCustomSubtitleStyles=true;
  h.JE.applySavedStylesWhenReady();
  assert.deepEqual(elements.map(e=>e.getAttribute('style')),originals);
  assert.equal(untouched.getAttribute('style'),'font-style: italic;');
  assert.deepEqual(h.counts(),{subscriptions:2,releases:2});
});
test('new subtitle nodes inherit chosen style and leaving playback releases observer',t=>{
  const h=setup(t,'<video></video>');
  h.JE.applySubtitleStyles('#ffff00','transparent',1.8,'sans-serif','none');
  const container=h.document.createElement('div');container.className='videoSubtitles';container.innerHTML='<div class="videoSecondarySubtitlesInner">Late cue</div>';
  h.document.body.append(container);h.mutate(container);
  assert.equal(container.firstChild.style.fontSize,'1.8vw');
  assert.equal(container.style.left,'50%');
  h.document.querySelector('video').remove();h.JE.applySavedStylesWhenReady();
  assert.deepEqual(h.counts(),{subscriptions:1,releases:1});
});
