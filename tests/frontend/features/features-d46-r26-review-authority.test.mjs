import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness, deferred} from '../helpers/harness.mjs';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const item = {Id:'one',Type:'Movie',ProviderIds:{Tmdb:'42'}};
function setup(t, read) {
    let user='a';
    const h=createHarness({html:'<div id="host"></div>', JE:{
        pluginConfig:{ShowUserReviews:true,ShowUserRatingOnPosters:true,ShowUserRatingDash:false},
        currentSettings:{ratingTagsEnabled:true},
        session:{getEpoch:()=>0,isCurrent:()=>true,onUserChange(){}},
        tagPipeline:{captureAuthority:()=>({identity:user,epoch:0,privacy:0}),authorityHolds:owner=>owner?.identity===user},
        core:{api:{plugin:()=>read(user)}}
    }});
    t.after(()=>h.close());h.load('tags/userreviewtags.js');
    return {...h,switchAccount(){user='b';},host:h.document.querySelector('#host')};
}
test('a review lookup completed after the live account changes cannot paint its original card',async t=>{
    const old=deferred();let calls=0;
    const h=setup(t,()=>{calls++;return old.promise;});
    h.JE.appendUserRatingToContainer(h.host,item);await wait(50);assert.equal(calls,1);
    h.switchAccount();old.resolve({ratings:{'movie:42':{average:4.5}}});await wait(10);
    assert.equal(h.host.querySelector('.je-userreview-tag'),null);
});
test('a warm review memo cannot supply the next live account before session polling',async t=>{
    let calls=0;
    const h=setup(t,user=>{calls++;return Promise.resolve({ratings:user==='a'?{'movie:42':{average:4.5}}:{}});});
    h.JE.appendUserRatingToContainer(h.host,item);await wait(50);
    assert.ok(h.host.querySelector('.je-userreview-tag'),'first-account positive control');
    h.switchAccount();h.host.replaceChildren();h.JE.appendUserRatingToContainer(h.host,item);
    assert.equal(h.host.querySelector('.je-userreview-tag'),null,'no synchronous old-memo paint');
    await wait(50);assert.equal(calls,2);assert.equal(h.host.querySelector('.je-userreview-tag'),null);
});
