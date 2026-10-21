#!/usr/bin/env node
// Copies the parts of a Jellyfin host's own web client (jellyfin-web, as shipped in the official image) that turn the
// viewer's keys, remote buttons and gamepad into actions: keyboardNavigation (the key → command map and its window
// keydown listener), inputManager (commands: Back → the router, select → click() on the focused element), focusManager
// (the D-pad's focus moves and their containers), serverNotifications (the server's WebSocket messages: another client's
// remote-control commands → the input manager) and the gamepad-to-key chunk (a gamepad's buttons → key events, and its
// OK → click() on the focused element). The frontend tests run them, verbatim, against JE's surfaces
// (tests/frontend/helpers/host-input.mjs). Regenerate for a new Jellyfin release:
//   id=$(docker create jellyfin/jellyfin:12.2) && docker cp "$id":/jellyfin/jellyfin-web ./web-12.2 && docker rm "$id"
//   node tests/host/web-bundle/extract-input.mjs ./web-12.2 tests/fixtures/host-input/12.2 jellyfin/jellyfin:12.2
// jellyfin-web is GPL-2.0-or-later (see tests/fixtures/host-input/README.md): every licence sidecar a copied file refers
// to is copied with it, and a missing one fails the extraction.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** The source of the balanced {...} block that starts at the first '{' at or after `from` (as extract.mjs). */
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

const [web, out, image] = process.argv.slice(2);
if (!web || !out) throw new Error('usage: extract-input.mjs <jellyfin-web dir> <out dir> [image]');
const files = readdirSync(web);
const sha256 = text => createHash('sha256').update(text).digest('hex');
mkdirSync(out, { recursive: true });
const manifest = { image: image || null, sources: {}, licenses: {} };
const licenses = text => {
  for (const [, sidecar] of text.matchAll(/For license information please see ([\w.-]+\.LICENSE\.txt)/g)) {
    if (!existsSync(join(web, sidecar))) throw new Error(`referenced licence file ${sidecar} is missing from ${web}`);
    const notice = readFileSync(join(web, sidecar), 'utf8');
    writeFileSync(join(out, sidecar), notice);
    manifest.licenses[sidecar] = { sha256: sha256(notice) };
  }
};

// The main bundle's modules, found by what they are (their module ids are the bundle's own).
const MODULES = {
  'keyboard-navigation': '10009:"Back"',
  'input-manager': '.dialogContainer .dialog.opened',
  'focus-manager': '"focuscontainer-x"',
  // The server's remote-control commands (another Jellyfin client's Select, Back, …) → the input manager.
  'server-notifications': 'case"Select":',
  // The host's event helper (Events.on/trigger) the server's messages travel through on 10.11.
  'events': '"obj cannot be null!"',
};
const main = files.find(f => f === 'main.jellyfin.bundle.js');
if (!main) throw new Error('no main.jellyfin.bundle.js in ' + web);
const bundle = readFileSync(join(web, main), 'utf8');
licenses(bundle.slice(0, 400));
const mainLicense = /For license information please see ([\w.-]+\.LICENSE\.txt)/.exec(bundle.slice(0, 400))?.[1];
for (const [name, signature] of Object.entries(MODULES)) {
  const at = bundle.indexOf(signature);
  if (at < 0) throw new Error(`${name}: "${signature}" is not in ${main}`);
  // The module that contains it: the last `<id>:function(` before it whose block reaches past it.
  let start = -1, id = null;
  for (const m of bundle.slice(0, at).matchAll(/[{,](\d+):function\(/g)) {
    const from = m.index + 1 + m[1].length + 1;
    if (from + block(bundle, from).length > at) { start = from; id = m[1]; }
  }
  if (start < 0) throw new Error(`${name}: no module around "${signature}" in ${main}`);
  const source = block(bundle, start);
  const file = `${name}.module.js`;
  writeFileSync(join(out, file), `// Module ${id} of ${main} (jellyfin-web's ${name}), verbatim.${mainLicense ? ` For license information please see ${mainLicense}` : ''}\nmodule.exports = { id: ${id}, module: ${source} };\n`);
  manifest.sources[file] = { file: main, module: Number(id), sha256: sha256(source) };
}
// The gamepad-to-key chunk, verbatim (the bundle loads it once a gamepad connects).
const gamepad = files.filter(f => /\.chunk\.js$/.test(f) && readFileSync(join(web, f), 'utf8').includes('"GamepadA",13'));
if (gamepad.length !== 1) throw new Error(`expected one gamepad chunk, found ${gamepad.join(', ') || 'none'}`);
const chunk = readFileSync(join(web, gamepad[0]), 'utf8');
writeFileSync(join(out, 'gamepadtokey.chunk.js'), chunk);
manifest.sources['gamepadtokey.chunk.js'] = { file: gamepad[0], sha256: sha256(chunk) };
licenses(chunk);
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(out, Object.keys(manifest.sources).join(' '));
