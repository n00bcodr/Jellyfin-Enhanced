// The host's OWN web client on JE's projected sessions (D46 review round 18): jellyfin-web's real remote-control page
// function that draws a remote session's now-playing item (updateNowPlayingInfo), its real now-playing names helper,
// the real remote session player's track lists and the page's real audio/subtitle menu builders, taken verbatim from
// the 12.2 and 10.11.11 web bundles (tests/fixtures/host-web/<host>, made by tests/host/web-bundle/extract.mjs), run on
// the sessions JE delivers to an administrator who hid the playing movie or guards the playing episodes' series
// (tests/fixtures/host-web/projected/<host>.json, kept current by PrivacyReviewRound18Tests). The page must render
// (no throw), show no protected text, and offer the same tracks as for the host's own answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
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

/** A value that answers any property and any call (the page's unrelated collaborators: image URLs, backdrops, api client). */
function inert() {
  const f = function () { return inert(); };
  return new Proxy(f, { get: (t, k) => k === Symbol.toPrimitive ? () => '' : k === 'length' ? 0 : inert() });
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Evaluates one function extracted from a bundle module: its free names resolve to `bindings`, then to the module's
 * own helper functions (babel helpers, by name), then to inert collaborators; JavaScript's globals stay themselves.
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

/** The webpack modules of a chunk file. */
function modules(text) {
  const self = { webpackChunk: [] };
  vm.runInNewContext(text, { self });
  return self.webpackChunk[0][1];
}

function host(name) {
  const manifest = JSON.parse(read(`host-web/${name}/manifest.json`));
  const queue = read(`host-web/${name}/playback-queue.chunk.js`);
  // The page template (its own chunk: a module whose default export is the page's HTML).
  const templateModule = Object.values(modules(read(`host-web/${name}/playback-queue-index-html.chunk.js`)))[0];
  const template = {}; templateModule({}, template, { r() {} });
  // The now-playing names helper from the main bundle; its only import is the MediaType enum (string members).
  const box = { exports: {} };
  vm.runInNewContext(read(`host-web/${name}/now-playing-names.module.js`), { module: box });
  const names = {};
  box.exports({}, names, Object.assign(() => new Proxy({}, { get: () => new Proxy({}, { get: (_, k) => k }) }),
    { d: (target, defs) => { for (const [k, get] of Object.entries(defs)) Object.defineProperty(target, k, { get, enumerable: true }); } }));
  const getNowPlayingNames = names[manifest.sources['now-playing-names.module.js'].export];
  // The page module that holds updateNowPlayingInfo.
  const anchor = queue.indexOf('function(e,t,n){var i=t.NowPlayingItem');
  assert.ok(anchor > 0, name + ': updateNowPlayingInfo');
  const moduleAt = [...queue.slice(0, anchor).matchAll(/\d+:function\(e,t,n\)\{/g)].at(-1).index;
  const moduleText = block(queue, moduleAt);
  const source = block(queue, anchor);
  const [, namesVar, namesExport, escapeVar] = /\(0,([\w$]+)\.([\w$]+)\)\(i\)\.map\(([\w$]+)\(\)\)/.exec(source);
  // The remote session player's own track methods (sessionPlayer plugin).
  const plugin = read(`host-web/${name}/sessionPlayer-plugin.chunk.js`);
  const method = key => {
    const at = plugin.indexOf(`{key:"${key}",value:`);
    assert.ok(at > 0, name + ': session player ' + key);
    return new Function('return (' + block(plugin, plugin.indexOf('function', at)) + ');')();
  };
  const playerMethods = Object.fromEntries(['audioTracks', 'getAudioStreamIndex', 'subtitleTracks', 'getSubtitleStreamIndex'].map(k => [k, method(k)]));
  // The page's audio and subtitle menu builders (their click handlers).
  const handler = button => {
    const at = moduleText.indexOf(`querySelector(".${button}").addEventListener("click",(function(e){`);
    assert.ok(at > 0, name + ': ' + button + ' handler');
    return block(moduleText, moduleText.indexOf('function(e){', at));
  };
  return { name, template: template.default, moduleText, source, namesVar, namesExport, escapeVar, getNowPlayingNames, playerMethods, audio: handler('btnAudioTracks'), subtitles: handler('btnSubtitles') };
}

/** jellyfin-web's playbackManager delegates these to a player that implements them (the remote session player does). */
const playbackManager = { audioTracks: p => p.audioTracks(), subtitleTracks: p => p.subtitleTracks(), getAudioStreamIndex: p => p.getAudioStreamIndex(), getSubtitleStreamIndex: p => p.getSubtitleStreamIndex(), setAudioStreamIndex() {}, setSubtitleStreamIndex() {} };

/** Draws the session's now-playing item with the real page function; returns the page's HTML (or the error). */
function draw(h, state) {
  const dom = new JSDOM(h.template);
  // jsdom has no innerText; the page writes names through it (a browser renders it as the element's text).
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true });
  const page = dom.window.document.querySelector('#nowPlayingPage');
  const update = evaluate(h.source, h.moduleText, { document: dom.window.document, [h.namesVar]: { [h.namesExport]: h.getNowPlayingNames }, [h.escapeVar]: () => escapeHtml });
  try { update(page, state, 'server'); return { html: page.innerHTML, page }; } catch (error) { return { error }; }
}

/** Opens the page's real audio or subtitle menu for the session player; returns the menu items it builds. */
async function menu(h, which, state) {
  const player = { lastPlayerData: state, ...h.playerMethods };
  const [, playerVar, stateVar] = /^function\(e\)\{var [\w$,]+;([\w$]+)&&null!==\(t=([\w$]+)\)/.exec(h[which]);
  const [, pmVar] = /([\w$]+)\.[\w$]+\.get(?:Audio|Subtitle)StreamIndex\(/.exec(h[which]);
  const translate = /([\w$]+)\.([\w$]+)\.translate\("Off"\)/.exec(h[which]);
  let items = null;
  const require = { bind: () => () => ({ show: options => { items = options.items; return Promise.resolve(); } }) };
  const bindings = { [playerVar]: player, [stateVar]: state, [pmVar]: new Proxy({}, { get: () => playbackManager }), n: require };
  if (translate) bindings[translate[1]] = { [translate[2]]: { translate: k => k } };
  evaluate(h[which], h.moduleText, bindings)({ target: {} });
  for (let i = 0; i < 5 && !items; i++) await new Promise(r => setTimeout(r, 0));
  return items;
}

const original = (hostName, file) => JSON.parse(read(`host-shapes/${hostName}/${file}`));

for (const name of ['12.2', '10.11.11']) {
  const h = host(name);
  const projected = JSON.parse(read(`host-web/projected/${name}.json`));

  test(`${name}: the host's own page draws a session's item from the host's own answer (harness control)`, () => {
    const none = projected.cases.find(c => c.id === 'none/rest');
    const movie = none.sessions.find(s => s.NowPlayingItem.Type === 'Movie');
    const drawn = draw(h, movie);
    assert.equal(drawn.error, undefined);
    assert.match(drawn.html, /D46 R19 Hidden/);
    const episode = none.sessions.find(s => s.NowPlayingItem.Type === 'Episode' && s.NowPlayingItem.IndexNumber == null && s.NowPlayingItem.ParentIndexNumber == null);
    assert.match(draw(h, episode).page.querySelector('.nowPlayingEpisode').textContent, /Secret ending r19 E3/);
  });

  for (const c of projected.cases.filter(c => c.rule !== 'none')) {
    test(`${name} ${c.id}: the remote-control page renders every projected session, shows no protected text and offers the host's tracks`, async () => {
      const host = original(name, c.original);
      assert.ok(c.sessions.length >= 3, 'the captured sessions');
      for (const session of c.sessions) {
        const label = `${session.DeviceId} (${session.NowPlayingItem.Type})`;
        const drawn = draw(h, session);
        assert.equal(drawn.error, undefined, `${label}: updateNowPlayingInfo threw ${drawn.error}`);
        for (const text of c.protected) assert.ok(!drawn.html.includes(text), `${label}: page shows "${text}"`);
        const own = host.find(s => s.DeviceId === session.DeviceId);
        for (const which of ['audio', 'subtitles']) {
          const items = await menu(h, which, session), expected = await menu(h, which, own);
          assert.deepEqual(items.map(i => i.id), expected.map(i => i.id), `${label}: ${which} menu offers the host's tracks`);
          for (const item of items) for (const text of c.protected) assert.ok(!String(item.name).includes(text), `${label}: ${which} menu item "${item.name}"`);
          assert.ok(items.every(i => String(i.name).trim().length > 0), `${label}: every ${which} item has a label`);
        }
        const tracks = { lastPlayerData: session, ...h.playerMethods };
        assert.equal(tracks.audioTracks().length, own.NowPlayingItem.MediaStreams.filter(s => s.Type === 'Audio').length, `${label}: audio button shown as for the host's answer`);
      }
    });
  }
}
