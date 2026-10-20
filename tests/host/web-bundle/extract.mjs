#!/usr/bin/env node
// Copies the parts of a Jellyfin host's own web client (jellyfin-web, as shipped in the official image) that draw a
// remote session's now-playing item: the remote-control ("now playing") page and its template, the remote session
// player, and the now-playing names helper from the main bundle; and the parts that PLAY an item: the playback manager
// module of the main bundle (direct-play decision, stream URL and text tracks) and the HTML video player chunk. The
// frontend tests tests/frontend/regressions/host-web-now-playing.test.mjs and host-web-playback.test.mjs run those real
// functions on the payloads JE's privacy projection delivers (tests/fixtures/host-web/projected/ and playback/).
// Regenerate for a new Jellyfin release:
//   id=$(docker create jellyfin/jellyfin:12.2) && docker cp "$id":/jellyfin/jellyfin-web ./web-12.2 && docker rm "$id"
//   node tests/host/web-bundle/extract.mjs ./web-12.2 tests/fixtures/host-web/12.2 jellyfin/jellyfin:12.2
// jellyfin-web is GPL-2.0-or-later (see tests/fixtures/host-web/README.md): every licence sidecar a copied file refers
// to ("For license information please see X.LICENSE.txt") is copied with it, and a missing one fails the extraction.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const [web, out, image] = process.argv.slice(2);
if (!web || !out) throw new Error('usage: extract.mjs <jellyfin-web dir> <out dir> [image]');
const files = readdirSync(web);
const one = prefix => {
  const found = files.filter(f => f.startsWith(prefix) && f.endsWith('.chunk.js') && /^[a-z-]+\.[0-9a-f]+\.chunk\.js$/i.test(f.slice(0)));
  if (found.length !== 1) throw new Error(`expected one ${prefix}* chunk, found ${found.join(', ') || 'none'}`);
  return found[0];
};

/** The source of the balanced {...} block that starts at the first '{' at or after `from`. */
export function block(source, from) {
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

mkdirSync(out, { recursive: true });
const manifest = { image: image || null, sources: {}, licenses: {} };
const sha256 = text => createHash('sha256').update(text).digest('hex');
/** Copies every licence sidecar the text refers to, verbatim and under its own name; a missing one is an error. */
const licenses = text => {
  for (const [, sidecar] of text.matchAll(/For license information please see ([\w.-]+\.LICENSE\.txt)/g)) {
    if (!existsSync(join(web, sidecar))) throw new Error(`referenced licence file ${sidecar} is missing from ${web}`);
    const notice = readFileSync(join(web, sidecar), 'utf8');
    writeFileSync(join(out, sidecar), notice);
    manifest.licenses[sidecar] = { sha256: sha256(notice) };
  }
};
const copy = (prefix, name) => {
  const file = one(prefix), text = readFileSync(join(web, file), 'utf8');
  writeFileSync(join(out, name), text);
  manifest.sources[name] = { file, sha256: sha256(text) };
  licenses(text);
  return text;
};
const queue = copy('playback-queue.', 'playback-queue.chunk.js');
copy('playback-queue-index-html.', 'playback-queue-index-html.chunk.js');
copy('sessionPlayer-plugin.', 'sessionPlayer-plugin.chunk.js');
// The names helper the page calls as (0,X.Y)(item): its module id comes from the page module's own import of X.
const at = queue.indexOf('function(e,t,n){var i=t.NowPlayingItem');
const call = /\(0,([\w$]+)\.([\w$]+)\)\(i\)\.map\(/.exec(queue.slice(at, at + 200));
const moduleStart = queue.lastIndexOf(':function(e,t,n){', at);
const imports = queue.slice(moduleStart, at);
const id = new RegExp('[,\\s]' + call[1].replace('$', '\\$') + '=n\\((\\d+)\\)').exec(imports)[1];
const main = files.find(f => /^main\.jellyfin\.bundle\.js$/.test(f));
const bundle = readFileSync(join(web, main), 'utf8');
// The names module is part of the main bundle: its licence sidecar comes with it.
licenses(bundle.slice(0, 400));
const start = bundle.indexOf(id + ':function(');
if (start < 0) throw new Error('names module ' + id + ' not in ' + main);
const names = block(bundle, start + id.length + 1);
const mainLicense = /For license information please see ([\w.-]+\.LICENSE\.txt)/.exec(bundle.slice(0, 400))?.[1];
writeFileSync(join(out, 'now-playing-names.module.js'), `// Module ${id} of ${main} (jellyfin-web's getNowPlayingNames), verbatim.${mainLicense ? ` For license information please see ${mainLicense}` : ''}\nmodule.exports = ${names};\n`);
manifest.sources['now-playing-names.module.js'] = { file: main, module: Number(id), export: call[2], sha256: createHash('sha256').update(names).digest('hex') };

/** The webpack module of the bundle whose function body contains `needle`: its id and source. */
export function moduleAround(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0) throw new Error('not in the bundle: ' + needle);
  let found = null;
  for (const m of source.matchAll(/(\d+):function\([\w$,]*\)\{/g)) {
    if (m.index > at) break;
    const text = block(source, m.index + m[1].length + 1);
    if (m.index + m[1].length + 1 + text.length > at) found = { id: m[1], text };
  }
  if (!found) throw new Error('no module around ' + needle);
  return found;
}

// The playback manager (getPlaybackInfo's direct-play decision, createStreamInfo, getTextTracks): one module of the main
// bundle, found by the check that reads a media source's RequiredHttpHeaders.
const playback = moduleAround(bundle, 'RequiredHttpHeaders.length');
writeFileSync(join(out, 'playback-manager.module.js'), `// Module ${playback.id} of ${main} (jellyfin-web's playback manager), verbatim.${mainLicense ? ` For license information please see ${mainLicense}` : ''}\nmodule.exports = ${playback.text};\n`);
manifest.sources['playback-manager.module.js'] = { file: main, module: Number(playback.id), sha256: sha256(playback.text) };
copy('htmlVideoPlayer-plugin.', 'htmlVideoPlayer-plugin.chunk.js');
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(out, Object.keys(manifest.sources).join(' '));
