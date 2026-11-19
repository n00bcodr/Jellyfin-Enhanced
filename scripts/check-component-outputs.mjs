#!/usr/bin/env node
// Gate FE G: js/component-scripts.json and every client/entries output key against restructure-base, plus the
// additions scripts/component-outputs-approved.json lists. Nothing restructure-base has may be removed, renamed or
// reordered; a module it lacks must be on the list, sit right after the entry the list names, and be keyed in the
// manifest the list names. An approved addition that is not (yet) present is fine: the check only refuses what is
// there and not approved.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST = 'Jellyfin.Plugin.JellyfinEnhanced/js/component-scripts.json';
export const APPROVED = 'scripts/component-outputs-approved.json';
const SHA = /^[0-9a-f]{40}$/;

/** The approved additions, checked for shape. Throws on a malformed list. */
export function readApproved(list) {
  if (!list || !Array.isArray(list.additions)) throw new Error(`${APPROVED}: expected an object with an "additions" array`);
  const seen = new Set();
  return list.additions.map((entry, index) => {
    const where = `${APPROVED}: additions[${index}]`;
    for (const key of ['module', 'after', 'manifest', 'upstream', 'why']) {
      if (typeof entry?.[key] !== 'string' || !entry[key].trim()) throw new Error(`${where} has no "${key}"`);
    }
    if (!SHA.test(entry.upstream)) throw new Error(`${where}: "upstream" must be a full 40-character commit id`);
    if (entry.why.trim().length < 40) throw new Error(`${where}: "why" must say why in a sentence`);
    if (!/^client\/entries\/[A-Za-z0-9_-]+\.json$/.test(entry.manifest)) throw new Error(`${where}: "manifest" must be a client/entries/*.json file`);
    if (seen.has(entry.module)) throw new Error(`${where}: ${entry.module} is listed twice`);
    seen.add(entry.module);
    return entry;
  });
}

/**
 * The problems with the current outputs. `baseScripts`/`scripts`: the parsed component-scripts.json arrays (notes
 * included); `baseEntries`/`entries`: { "client/entries/<name>.json": [output keys] }; `approved`: readApproved's list.
 * @returns {string[]}
 */
export function componentOutputProblems({ baseScripts, scripts, baseEntries, entries, approved }) {
  const problems = [];
  const byModule = new Map(approved.map(entry => [entry.module, entry]));
  if (!Array.isArray(scripts)) return [`${MANIFEST} is not a JSON array`];
  // The manifest: drop the approved additions, and what is left must be restructure-base's list exactly.
  const kept = [];
  scripts.forEach((path, index) => {
    const entry = typeof path === 'string' ? byModule.get(path) : undefined;
    if (!entry) { kept.push(path); return; }
    if (scripts.indexOf(path) !== index) problems.push(`${MANIFEST}: approved addition ${path} is listed more than once`);
    else if (scripts[index - 1] !== entry.after) problems.push(`${MANIFEST}: ${path} must come right after ${entry.after} (its place in upstream ${entry.upstream.slice(0, 8)}), found after ${JSON.stringify(scripts[index - 1] ?? null)}`);
  });
  const base = new Set(baseScripts.filter(path => typeof path === 'string'));
  for (const path of kept) if (typeof path === 'string' && !base.has(path)) problems.push(`${MANIFEST}: ${path} is not in restructure-base and not an approved addition (${APPROVED})`);
  for (const path of baseScripts) if (typeof path === 'string' && !kept.includes(path)) problems.push(`${MANIFEST}: ${path} (in restructure-base) was removed or renamed`);
  if (!problems.length && JSON.stringify(kept) !== JSON.stringify(baseScripts)) {
    const at = kept.findIndex((path, index) => path !== baseScripts[index]);
    problems.push(`${MANIFEST}: entries are reordered from restructure-base (first difference at entry ${at}: ${JSON.stringify(kept[at])}, restructure-base has ${JSON.stringify(baseScripts[at])})`);
  }
  // Output keys: per manifest file, restructure-base's keys plus the approved additions keyed there.
  for (const file of new Set([...Object.keys(baseEntries), ...Object.keys(entries)])) {
    if (!(file in baseEntries)) { problems.push(`${file}: a manifest restructure-base does not have`); continue; }
    if (!(file in entries)) { problems.push(`${file}: removed (restructure-base has it)`); continue; }
    const baseKeys = new Set(baseEntries[file]);
    for (const key of baseEntries[file]) if (!entries[file].includes(key)) problems.push(`${file}: output key ${key} was removed or renamed`);
    for (const key of entries[file]) {
      if (baseKeys.has(key)) continue;
      const entry = key.startsWith('js/') ? byModule.get(key.slice(3)) : undefined;
      if (!entry) problems.push(`${file}: output key ${key} is not in restructure-base and not an approved addition (${APPROVED})`);
      else if (entry.manifest !== file) problems.push(`${file}: output key ${key} is approved for ${entry.manifest}, not here`);
    }
  }
  // An approved module that is shipped needs its output key, and a key needs its module in the manifest.
  for (const entry of approved) {
    const listed = scripts.includes(entry.module);
    const keyed = (entries[entry.manifest] ?? []).includes(`js/${entry.module}`);
    if (listed !== keyed) problems.push(`${entry.module}: ${listed ? `in ${MANIFEST} without its output key in ${entry.manifest}` : `keyed in ${entry.manifest} but not in ${MANIFEST}`}`);
  }
  return problems;
}

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Read both sides from a checkout (restructure-base from git) and check them. */
export function checkCheckout(root, base = 'restructure-base') {
  const approved = readApproved(JSON.parse(readFileSync(join(root, APPROVED), 'utf8')));
  const entryFiles = dir => readdirSync(join(root, dir)).filter(name => name.endsWith('.json')).map(name => `${dir}/${name}`);
  const baseFiles = git(root, 'ls-tree', '--name-only', `${base}:client/entries`).split('\n').filter(name => name.endsWith('.json')).map(name => `client/entries/${name}`);
  const keys = text => Object.keys(JSON.parse(text)).sort();
  const problems = componentOutputProblems({
    baseScripts: JSON.parse(git(root, 'show', `${base}:${MANIFEST}`)),
    scripts: JSON.parse(readFileSync(join(root, MANIFEST), 'utf8')),
    baseEntries: Object.fromEntries(baseFiles.map(file => [file, keys(git(root, 'show', `${base}:${file}`))])),
    entries: Object.fromEntries(entryFiles('client/entries').map(file => [file, keys(readFileSync(join(root, file), 'utf8'))])),
    approved,
  });
  const notes = [];
  for (const entry of approved) {
    // The upstream commit must add the module; checked where the commit has been fetched.
    let added;
    try { added = git(root, 'show', '--diff-filter=A', '--name-only', '--format=', entry.upstream); } catch { added = null; }
    if (added === null) notes.push(`note: upstream ${entry.upstream.slice(0, 8)} is not fetched here; not checked that it adds ${entry.module}`);
    else if (!added.split('\n').includes(`Jellyfin.Plugin.JellyfinEnhanced/js/${entry.module}`)) problems.push(`${APPROVED}: upstream ${entry.upstream.slice(0, 8)} does not add js/${entry.module}`);
  }
  return { problems, notes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  if (!existsSync(join(root, MANIFEST))) { console.error(`missing ${MANIFEST}`); process.exit(2); }
  const { problems, notes } = checkCheckout(root);
  for (const note of notes) console.log(note);
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(`component-scripts.json and client/entries output keys: restructure-base plus approved additions (${APPROVED})`);
}
