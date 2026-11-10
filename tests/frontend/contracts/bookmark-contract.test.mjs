import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const context=vm.createContext({window:{}});
vm.runInContext(readFileSync(new URL('../../../Jellyfin.Plugin.JellyfinEnhanced/js/contracts/bootstrap.js',import.meta.url),'utf8'),context);
const parse=context.window.__JE_BOOTSTRAP_CONTRACT__.parseBookmarkDocument;
for(const document of ['null','[]','broken','{"bookmarks":null}','{"bookmarks":[]}','{"bookmarks":{},"Bookmarks":{}}']) {
 test(`bookmark contract rejects corrupt document ${document}`,()=>assert.throws(()=>parse({Revision:'sha256:example',Document:document})));
}
for(const value of [{},{Revision:1,Document:'{}'},{Revision:'',Document:'{}'},{Revision:'loaded',Document:{}},{Revision:'loaded',Document:'{}',unexpected:true}]) {
 test(`bookmark contract rejects invalid envelope ${JSON.stringify(value)}`,()=>assert.throws(()=>parse(value)));
}
test('bookmark transport retains extreme JSON literal text and case-sensitive record identity',()=>{
 const document='{"future":1e400,"Bookmarks":{"Bm_UPPER":{"timestamp":2.5,"tiny":1e-400}}}';
 assert.equal(parse({Revision:'loaded',Document:document}).Document,document);
});
