import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from '../helpers/harness.mjs';
import {chromeJs,settle} from './helpers.mjs';
test('CHR-R1-002 integrated: replaced credentials cannot send an old administrator form',async t=>{
 let user='admin-a',token='old-token';const posts=[];
 const h=createHarness({html:'<div id="tray"></div>',apiClient:{getCurrentUserId:()=>user,accessToken:()=>token},globals:{AbortController,AbortSignal},
 fetch:async(url,options)=>{if(options.method==='POST')posts.push(options.headers);return new Response(JSON.stringify(options.method==='POST'?{sent:1,skipped:0,errors:[]}:[{RemoteEndPoint:'10.0.0.5',NowPlayingItem:{Id:'m',Name:'movie'}}]),{headers:{'Content-Type':'application/json'}})},
 JE:{pluginConfig:{ActiveStreamsEnabled:true},helpers:{isAdmin:()=>true,getHeaderButtonTray:()=>h.document.getElementById('tray'),onBodyMutation:()=>({unsubscribe(){}})},core:{lifecycle:{register:()=>({track:r=>r,teardown(){}})},navigation:{onNavigate:()=>()=>{}}}}});
 t.after(()=>h.close());h.load('core/session.js');h.load('core/api-client.js');h.load(chromeJs('extras/active-streams.js'));
 h.JE.activeStreams.initialize();await settle();h.document.getElementById('je-active-streams').click();await settle();
 assert.ok(h.document.body.textContent.includes('10.0.0.5'));
 token='replacement-token';h.window.ApiClient={...h.window.ApiClient};
 h.document.querySelector('.je-as-broadcast-btn').click();h.document.querySelector('.je-as-broadcast-textarea').value='old form';h.document.querySelector('.je-as-broadcast-send').click();await settle();
 assert.equal(posts.length,0);
 assert.equal(h.document.getElementById('je-active-streams-panel'),null);
});
