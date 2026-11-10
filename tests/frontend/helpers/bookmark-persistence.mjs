import assert from 'node:assert/strict';
import {plain} from './harness.mjs';

// Explicit fixture for legacy UI/queue tests. Responses model the guarded route;
// invalid-response tests use their own ajax implementation, never this fixture.
export function installBookmarkPersistenceFixture(h, save) {
 let revision = 'fixture:0', sequence = 0;
 h.JE.userConfig.bookmarkRevision = revision;
 const ajax = h.window.ApiClient.ajax?.bind(h.window.ApiClient) ?? (request => { throw new Error(`Unexpected request: ${request.url}`); });
 h.window.ApiClient.ajax = async request => {
  if (request.type !== 'POST' || !request.url.endsWith('/bookmark-document')) return ajax(request);
  const body = JSON.parse(request.data);
  assert.equal(body.Revision, revision);
  assert.ok(Array.isArray(body.Operations) && body.Operations.length > 0);
  assert.equal('Document' in body, false);
  await save('bookmark.json', plain(h.JE.userConfig.bookmark), {throwOnError:true});
  revision = `fixture:${++sequence}`;
  return {Revision: revision};
 };
 return () => { h.JE.userConfig.bookmarkRevision = revision; };
}
