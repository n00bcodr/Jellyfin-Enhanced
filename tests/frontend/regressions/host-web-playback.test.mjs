// The host's OWN web client PLAYS JE's projected items (D46 review round 20): jellyfin-web's real playback functions,
// taken verbatim from the 12.2 and 10.11.11 web bundles (tests/fixtures/host-web/<host>, made by
// tests/host/web-bundle/extract.mjs): the playback manager's direct-play decision for a media source (it reads
// RequiredHttpHeaders.length), createStreamInfo (the stream URL from the source's TranscodingUrl or the static stream
// route, and the text tracks from each external subtitle's DeliveryUrl), and the HTML video player's audio stream list.
// They run on the playback answers JE delivers to a viewer who guards the playing episode's series, for an HTTP source
// and a file source with transcoding and a sidecar subtitle (tests/fixtures/host-web/playback/<host>.json, kept current
// by PrivacyReviewRound20Tests). Every function must run (no throw), give the same stream URL, play method and text
// tracks as on the host's own answer, and carry no protected text; an HTTP source whose URL is withheld is streamed through
// the host's route instead of being direct-played from that URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { repositoryRoot } from '../helpers/discovery.mjs';

const fixtures = repositoryRoot + 'tests/fixtures/';
const read = path => readFileSync(fixtures + path, 'utf8');

/** The source of the balanced {...} block that starts at the first '{' at or after `from` (strings skipped). */
function block(source, from) {
  let depth = 0, quote = null, escaped = false;
  for (let i = source.indexOf('{', from); i < source.length; i++) {
    const c = source[i];
    if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return source.slice(from, i + 1);
  }
  throw new Error('unbalanced block');
}

/** A value that answers any property and any call (unrelated collaborators: backdrop URLs, settings). */
function inert() {
  const f = function () { return inert(); };
  return new Proxy(f, { get: (t, k) => k === Symbol.toPrimitive ? () => '' : k === 'length' ? 0 : inert() });
}

/**
 * Evaluates one function extracted from a bundle module: its free names resolve to `bindings`, then to the module's
 * own named functions (by name), then to inert collaborators; JavaScript's globals stay themselves.
 */
function evaluate(source, moduleText, bindings) {
  const resolved = {};
  const scope = new Proxy({}, {
    has: (_, k) => typeof k === 'string' && (k in bindings || !(k in globalThis)),
    get: (_, k) => {
      if (k === Symbol.unscopables) return undefined;
      if (k in bindings) return bindings[k];
      if (!(k in resolved)) {
        const at = moduleText.indexOf('function ' + k + '(');
        resolved[k] = at >= 0 ? new Function('scope', 'with (scope) { return (' + block(moduleText, at) + '); }')(scope) : inert();
      }
      return resolved[k];
    },
  });
  return new Function('scope', 'with (scope) { return (' + source + '); }')(scope);
}

/** The innermost named function of `text` whose body contains `needle`. */
function enclosing(text, needle) {
  const at = text.indexOf(needle);
  assert.ok(at > 0, 'not in the bundle: ' + needle);
  let found = null;
  for (const m of text.matchAll(/function [\w$]+\([\w$,]*\)\{/g)) {
    if (m.index > at) break;
    const source = block(text, m.index);
    if (m.index + source.length > at) found = source;
  }
  assert.ok(found, 'no function around ' + needle);
  return found;
}

function host(name) {
  const manager = read(`host-web/${name}/playback-manager.module.js`);
  const supportsSource = enclosing(manager, 'RequiredHttpHeaders.length');
  const createSource = enclosing(manager, 'useFullSubtitleUrls');
  const tracksSource = enclosing(manager, '"External"===e.DeliveryMethod');
  // The app host ("can this client play remote video?") and the local-item check, by the names this bundle gives them.
  const [, appVar, appExport, featureVar, featureExport] = /IsRemote&&!([\w$]+)\.([\w$]+)\.supports\(([\w$]+)\.([\w$]+)\.RemoteVideo\)/.exec(supportsSource);
  const [, localVar, localExport] = /([\w$]+)\.([\w$]+)\.isLocalItem\(/.exec(tracksSource);
  const bindings = {
    [appVar]: { [appExport]: { supports: () => true } },
    [featureVar]: { [featureExport]: { RemoteVideo: 'remotevideo' } },
    [localVar]: { [localExport]: { isLocalItem: () => false } },
  };
  const supportsDirectPlay = evaluate(supportsSource, manager, bindings);
  const createStreamInfo = evaluate(createSource, manager, bindings);
  // The HTML video player's audio stream list (a class method of its chunk).
  const player = read(`host-web/${name}/htmlVideoPlayer-plugin.chunk.js`);
  const at = player.indexOf('{key:"getSupportedAudioStreams",value:');
  assert.ok(at > 0, name + ': getSupportedAudioStreams');
  const audioSource = block(player, player.indexOf('function', at));
  const [, privateGet] = /=([\w$]+)\([\w$]+,this\)/.exec(audioSource);
  const getSupportedAudioStreams = evaluate(audioSource, player, { [privateGet]: () => null });
  return { supportsDirectPlay, createStreamInfo, getSupportedAudioStreams };
}

/** The API client the playback manager asks for URLs, the device and the token (the caller the payload was built for). */
function apiClient(caller) {
  return {
    getUrl: (path, params) => '/base/' + String(path).replace(/^\//, '') + (params ? '?' + Object.entries(params).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&') : ''),
    deviceId: () => caller.deviceId,
    accessToken: () => caller.token,
    getEndpointInfo: () => Promise.resolve({ IsInNetwork: true, IsLocal: true }),
    serverId: () => 'server',
  };
}

const copy = value => JSON.parse(JSON.stringify(value));

/** Everything the player is handed for one source: the direct-play decision, the stream info and the audio list. */
async function play(h, api, item, source) {
  const directPlay = await h.supportsDirectPlay(api, item, copy(source));
  // As the playback manager does: the direct-play answer decides whether createStreamInfo hands the player Path.
  const info = h.createStreamInfo(api, 'Video', item, { ...copy(source), enableDirectPlay: directPlay }, 0, { useFullSubtitleUrls: true });
  const audio = h.getSupportedAudioStreams.call({ _currentPlayOptions: { mediaSource: copy(source) }, isAudioStreamSupported: () => true });
  return {
    directPlay,
    url: info.url, playMethod: info.playMethod, mimeType: info.mimeType,
    tracks: info.textTracks.map(t => ({ url: t.url, index: t.index, format: t.format, language: t.language })),
    audio: audio.map(s => s.Index),
    text: JSON.stringify({ url: info.url, tracks: info.textTracks, title: info.title }),
  };
}

for (const name of ['12.2', '10.11.11']) {
  const h = host(name);
  const payload = JSON.parse(read(`host-web/playback/${name}.json`));
  const api = apiClient(payload.caller);
  const own = payload.cases.find(c => c.rule === 'none');

  test(`${name}: jellyfin-web plays the host's own answer, and an HTTP source without its header collection throws (harness control)`, async () => {
    for (const source of own.playback.MediaSources) {
      const played = await play(h, api, own.item, source);
      assert.ok(played.url, source.Protocol + ': a stream URL');
    }
    const http = own.playback.MediaSources.find(s => s.Protocol === 'Http');
    // The shape the round-20 review found: RequiredHttpHeaders dropped to null makes the direct-play check throw.
    await assert.rejects(async () => h.supportsDirectPlay(api, own.item, { ...copy(http), RequiredHttpHeaders: null }), /length/);
  });

  for (const c of payload.cases.filter(c => c.rule !== 'none')) {
    test(`${name} ${c.id}: jellyfin-web plays every projected source (HTTP and file) as it plays the host's own, with no protected text`, async () => {
      assert.equal(c.playback.MediaSources.length, own.playback.MediaSources.length);
      for (const [i, source] of c.playback.MediaSources.entries()) {
        const label = `${source.Protocol} source`;
        const played = await play(h, api, c.item, source);
        const expected = await play(h, api, own.item, own.playback.MediaSources[i]);
        if (source.Protocol !== 'File' && source.Path == null) {
          // A remote source whose URL Spoiler Guard withholds: the player streams it through the host's own route (the server
          // proxies it) instead of being handed the remote URL, which the host's own answer direct-plays.
          assert.equal(expected.directPlay, true, label + ': the host\'s own answer direct-plays the remote URL (control)');
          assert.equal(played.directPlay, false, label + ': not direct-played from a withheld URL');
          assert.match(played.url, new RegExp('^/base/Videos/' + c.item.Id + '/stream\\.' + source.Container + '\\?Static=true&'), label + ': the host\'s stream route');
          assert.equal(played.playMethod, 'DirectStream', label + ': play method');
        } else {
          assert.equal(played.directPlay, expected.directPlay, label + ': direct-play decision');
          assert.equal(played.url, expected.url, label + ': stream URL');
          assert.equal(played.playMethod, expected.playMethod, label + ': play method');
        }
        assert.equal(played.mimeType, expected.mimeType, label + ': MIME type');
        assert.deepEqual(played.tracks, expected.tracks, label + ': text tracks (sidecar subtitles)');
        assert.deepEqual(played.audio, expected.audio, label + ': audio streams');
        for (const text of c.protected) assert.ok(!played.text.includes(text), `${label}: the player is handed "${text}"`);
      }
      for (const text of c.protected) assert.ok(!JSON.stringify(c.playback).includes(text), `the answer carries "${text}"`);
      assert.ok(c.playback.MediaSources.some(s => s.Protocol === 'Http') && c.playback.MediaSources.some(s => s.Protocol === 'File'));
      assert.ok(c.playback.MediaSources.some(s => s.MediaStreams.some(m => m.Type === 'Subtitle' && m.DeliveryMethod === 'External')), 'a sidecar subtitle');
    });
  }
}
