import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createHarness,deferred} from '../helpers/harness.mjs';
function setup(t,{config={},api=async()=>({items:[]})}={}){
  const calls=[];const timers=new Map();let timerId=0;
  const h=createHarness({html:'<main></main>',JE:{pluginConfig:{ActivityFeedEnabled:true,ActivityFeedShowWatched:true,ActivityFeedShowReviewed:true,...config},t:()=>'',core:{api:{plugin:async path=>{calls.push(path);return api(path);}}}},apiClient:{getImageUrl:(id,options)=>`http://jellyfin.test/Images/${id}/${options.type}`}});
  h.window.setInterval=fn=>{timers.set(++timerId,fn);return timerId;};h.window.clearInterval=id=>timers.delete(id);
  t.after(()=>h.close());h.load('extras/activity-page.js');
  return {...h,calls,timers,host:h.document.querySelector('main'),P:h.JE.activityPage};
}
const entry=(type,name,timestamp=0)=>({ActivityType:type,UserId:'u',UserName:'<img src=x>',Timestamp:timestamp,Item:{Id:name,Name:name},Content:'<script>unsafe</script>',Rating:3.5});

test('activity disabled module registers nothing and makes no requests',t=>{
  const h=setup(t,{config:{ActivityFeedEnabled:false}});assert.equal(h.P,undefined);assert.equal(h.calls.length,0);
});
test('activity renders separated watch and chronological review/favorite sections with escaped data',async t=>{
  const h=setup(t,{api:async()=>({items:[{...entry('Watched','Partial'),Progress:0.42},{...entry('Watched','Complete'),Completed:true},entry('Reviewed','Older',100),entry('Favorited','Newer',200),entry('Ignored','Ignore')]})});
  await h.P.renderForCustomTab(h.host);
  assert.deepEqual([...h.document.querySelectorAll('.je-activity-item-name')].map(n=>n.textContent),['Partial','Complete','Newer','Older']);
  assert.equal(h.document.querySelector('script'),null);assert.equal(h.document.querySelector('.je-activity-user').textContent,'<img src=x>');
  assert.equal(h.document.querySelectorAll('.je-activity-progress-fill').length,1);
  assert.equal(h.document.querySelector('.je-activity-progress-fill').style.width,'42%');
  h.document.querySelector('.je-activity-item-name').click();assert.equal(h.window.location.hash,'#!/details?id=Partial');
});
test('activity escapes user and item names in every section, active streams included',async t=>{
  const hostile=label=>`<img src=x data-from="${label}"><script>${label}</script>`;
  const row=(type,label,extra={})=>({ActivityType:type,UserId:'u',UserName:hostile(`${label}-user`),Timestamp:0,Item:{Id:label,Name:hostile(`${label}-item`)},...extra});
  const session={UserId:'u',UserName:hostile('stream-user'),PlayState:{PositionTicks:50},NowPlayingItem:{Id:'stream',Name:hostile('stream-item'),RunTimeTicks:100}};
  const h=setup(t,{config:{ActiveStreamsEnabled:true,ActivityFeedShowActiveStreams:true},api:async path=>path==='/active-streams/sessions'?[session]
    :{items:[row('Watched','partial',{Progress:0.5}),row('Watched','complete',{Completed:true}),row('Reviewed','review',{Rating:4,Content:'fine'}),row('Favorited','favorite')]}});
  await h.P.renderForCustomTab(h.host);
  assert.equal(h.document.querySelectorAll('.je-activity-section').length,3);
  assert.equal(h.document.querySelector('img[data-from]'),null);assert.equal(h.document.querySelector('script'),null);
  const labels=['stream','partial','complete','review','favorite'];
  assert.deepEqual([...h.document.querySelectorAll('.je-activity-user')].map(n=>n.textContent),labels.map(label=>hostile(`${label}-user`)));
  assert.deepEqual([...h.document.querySelectorAll('.je-activity-item-name')].map(n=>n.textContent),labels.map(label=>hostile(`${label}-item`)));
  h.P.stopPolling();
});
test('activity empty and failed responses show explicit state and refresh recovers',async t=>{
  let failing=true;const h=setup(t,{api:async()=>{if(failing)throw Error('offline');return {items:[]};}});
  await h.P.renderForCustomTab(h.host);assert.equal(h.document.querySelectorAll('.je-activity-error').length,2);
  failing=false;h.document.querySelector('.je-activity-refresh-btn').click();await nextTurn();
  assert.equal(h.document.querySelectorAll('.je-activity-error').length,0);assert.equal(h.document.querySelectorAll('.je-activity-empty').length,2);
  assert.equal(h.document.querySelector('.je-activity-refresh-btn').disabled,false);
});
test('activity refresh coalesces repeated clicks while response is pending',async t=>{
  const pending=deferred();let loads=0;const h=setup(t,{api:async()=>{loads++;return loads===1?{items:[]}:pending.promise;}});
  await h.P.renderForCustomTab(h.host);const button=h.document.querySelector('.je-activity-refresh-btn');button.click();button.click();
  assert.equal(loads,2);assert.equal(button.disabled,true);pending.resolve({items:[]});await nextTurn();assert.equal(button.disabled,false);
});
test('activity active stream polling ignores idle sessions and cleans up when remounted or detached',async t=>{
  const h=setup(t,{config:{ActiveStreamsEnabled:true,ActivityFeedShowActiveStreams:true,ActivityFeedShowWatched:false,ActivityFeedShowReviewed:false},api:async()=>[{UserName:'Idle'},{UserId:'u',UserName:'Viewer',PlayState:{IsPaused:true,PositionTicks:200},NowPlayingItem:{Id:'movie',Name:'Movie',RunTimeTicks:100}}]});
  await h.P.renderForCustomTab(h.host);assert.equal(h.document.querySelectorAll('.je-activity-row').length,1);assert.match(h.host.textContent,/paused watching/);assert.equal(h.document.querySelector('.je-activity-progress-fill').style.width,'100%');
  assert.equal(h.timers.size,1);await h.P.renderForCustomTab(h.host);assert.equal(h.timers.size,1);
  h.host.remove();[...h.timers.values()][0]();assert.equal(h.timers.size,0);
});
test('activity stopped pending initial load cannot restart its poller',async t=>{
  const pending=deferred();const h=setup(t,{config:{ActiveStreamsEnabled:true,ActivityFeedShowActiveStreams:true,ActivityFeedShowWatched:false,ActivityFeedShowReviewed:false},api:()=>pending.promise});
  const render=h.P.renderForCustomTab(h.host);h.P.stopPolling();pending.resolve([]);await render;assert.equal(h.timers.size,0);
});
test('activity unauthorized active streams removes section and never polls',async t=>{
  const h=setup(t,{config:{ActiveStreamsEnabled:true,ActivityFeedShowActiveStreams:true,ActivityFeedShowWatched:false,ActivityFeedShowReviewed:false},api:async()=>{throw {status:403};}});
  await h.P.renderForCustomTab(h.host);assert.equal(h.document.querySelector('.je-activity-section'),null);assert.equal(h.timers.size,0);
});
