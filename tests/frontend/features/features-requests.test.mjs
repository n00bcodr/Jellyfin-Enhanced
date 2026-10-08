import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from '../helpers/harness.mjs';
function setup(t,downloads=[]){
 const state={downloads,downloadsActiveTab:'all',downloadsSearchQuery:''};
 const h=createHarness({JE:{internals:{requestsPage:{state}}}});t.after(()=>h.close());h.load('arr/requests/requests-page-render-helpers.js');
 return {...h,state,api:h.JE.internals.requestsPage};
}
const episode=(number,overrides={})=>({source:'Sonarr',title:'Show',seasonNumber:1,episodeNumber:number,progress:0.5,instanceName:'primary',status:'Downloading',...overrides});
test('download grouping collapses packs, preserves singles and separates instances, seasons and progress',t=>{
 const h=setup(t);const entries=[episode(3),episode(1),episode(2),episode(4,{instanceName:'other'}),episode(5,{progress:0.8}),episode(1,{seasonNumber:2}),{source:'Radarr',title:'Film'}];
 const result=h.api.groupDownloads(entries);const packs=result.filter(e=>e.type==='seasonPack');
 assert.equal(packs.length,1);assert.equal(packs[0].episodeRange,'E01-E03');assert.equal(packs[0].episodeCount,3);assert.equal(result.length,5);assert.equal(entries.length,7);
});
test('download statuses count collapsed packs once',t=>{
 const h=setup(t,[episode(1),episode(2),episode(3),episode(5,{status:'Queued',progress:0})]);
 assert.deepEqual(Array.from(h.api.getDownloadStatuses(),pair=>Array.from(pair)),[['Downloading',1],['Queued',1]]);
});
test('request filtering applies hidden policy before status and case-insensitive search',t=>{
 const h=setup(t,[{title:'Hidden',status:'Downloading'},{title:'Movie',subtitle:'Special EDITION',status:'Downloading'},{title:'Other',instanceName:'Remote',status:'Queued'}]);
 h.JE.hiddenContent={filterRequestItems:items=>items.filter(item=>item.title!=='Hidden')};
 assert.equal(h.api.getFilteredDownloads().length,2);
 h.state.downloadsActiveTab='Downloading';h.state.downloadsSearchQuery='edition';
 assert.deepEqual(Array.from(h.api.getFilteredDownloads(),x=>x.title),['Movie']);
 h.state.downloadsActiveTab='all';h.state.downloadsSearchQuery='REMOTE';
 assert.deepEqual(Array.from(h.api.getFilteredDownloads(),x=>x.title),['Other']);
});
for(const [value,expected] of [[null,''],['00:00:05','5s'],['00:02:05','2m 5s'],['01:02:03','1h 2m 3s'],['unknown','unknown']]){
 test(`download remaining time ${value}`,t=>{const h=setup(t);assert.equal(h.api.formatTimeRemaining(value),expected);});
}
