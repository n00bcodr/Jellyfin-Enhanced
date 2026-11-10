// Feed actual controller serialization through the shipped Spoiler Guard state entry.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHarness} from '../helpers/harness.mjs';
const value=JSON.parse(readFileSync(0,'utf8'));
const prefetched=process.argv[2]==='bootstrap';
const state=prefetched?value.Prefetched.SpoilerBlurSeries:value;
assert.ok(state && Object.hasOwn(state,'Series'), JSON.stringify({mode:process.argv[2],state}));
let requests=0;
const h=createHarness({JE:{pluginConfig:{SpoilerBlurEnabled:true},
 takePrefetched:()=>prefetched?state:undefined,
 core:{api:{plugin:async()=>{requests++;return state;}}}}});
try {
 for(const entry of ['navigation','session','lifecycle']) h.load(`core/${entry}.js`);
 h.load('enhanced/spoilerguard/ids.js');h.load('enhanced/spoilerguard/state.js');
 const sg=h.JE.internals.spoilerGuard;
 await sg.whenLoaded();assert.equal(sg.isLoadOk(),true);
 assert.equal(requests,prefetched?0:1);
 for(const [key,value] of Object.entries(state.Prefs)) assert.equal(sg.getUserPrefs()[key],value);
 for(const id of Object.keys(state.Series)) assert.equal(sg.isEnabledFor(id),true);
 for(const id of Object.keys(state.Movies)) assert.equal(sg.isMovieEnabledFor(id),true);
 for(const id of Object.keys(state.Collections)) assert.equal(sg.isCollectionEnabledFor(id),true);
 for(const key of Object.keys(state.PendingTmdb)) {const [type,id]=key.split(':');assert.equal(sg.isTmdbPending(type,id),true);}
} finally {h.close();}
