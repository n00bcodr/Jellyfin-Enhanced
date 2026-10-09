#!/usr/bin/env node
// Compares data/out/web-<profile>.json (real JS) with data/out/cs-<profile>.json
// (C# PosterTagResolver): effective settings, then per entry the ordered list of
// tag groups (group, corner, top-right offset, tags). Prints a summary per
// profile and per item type, and the first differences. Exit code 1 on any diff.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, 'data');
const outDir = join(dataDir, 'out');
const read = (...p) => JSON.parse(readFileSync(join(dataDir, ...p), 'utf8'));
const profiles = read('profiles.json');
const showLimit = Number(process.argv[2] || 8);

let totalDiffs = 0;
const report = [];
const rows = [];
for (const profile of profiles) {
    const webFile = join(outDir, `web-${profile.name}.json`);
    const csFile = join(outDir, `cs-${profile.name}.json`);
    if (!existsSync(webFile) || !existsSync(csFile)) {
        report.push(`${profile.name}: missing output`);
        totalDiffs++;
        continue;
    }
    const web = JSON.parse(readFileSync(webFile, 'utf8'));
    const cs = JSON.parse(readFileSync(csFile, 'utf8'));
    const entries = { ...read('inputs', `tagcache-${profile.user}.json`), ...(profile.synthetic ? read('synthetic', 'entries.json') : {}) };

    const settingDiffs = [];
    for (const key of new Set([...Object.keys(web.settings), ...Object.keys(cs.settings)])) {
        if (JSON.stringify(web.settings[key]) !== JSON.stringify(cs.settings[key])) {
            settingDiffs.push(`${key}: web=${JSON.stringify(web.settings[key])} cs=${JSON.stringify(cs.settings[key])}`);
        }
    }

    const itemDiffs = [];
    const byType = {};
    let tagged = 0;
    let groups = 0;
    let tags = 0;
    for (const id of new Set([...Object.keys(web.items), ...Object.keys(cs.items)])) {
        const type = entries[id]?.Type || '?';
        const stats = (byType[type] ||= { items: 0, tagged: 0, diffs: 0 });
        stats.items++;
        const w = JSON.stringify(web.items[id] ?? null);
        const c = JSON.stringify(cs.items[id] ?? null);
        if ((web.items[id] || []).length) {
            stats.tagged++;
            tagged++;
            groups += web.items[id].length;
            tags += web.items[id].reduce((n, g) => n + g.t.length, 0);
        }
        if (w !== c) {
            stats.diffs++;
            itemDiffs.push({ id, type, web: w, cs: c });
        }
    }

    totalDiffs += settingDiffs.length + itemDiffs.length;
    const typeSummary = Object.entries(byType).map(([t, s]) => `${t} ${s.tagged}/${s.items}${s.diffs ? ` (${s.diffs} diff)` : ''}`).join(', ');
    rows.push({ profile: profile.name, items: Object.keys(web.items).length, tagged, groups, tags, settingDiffs: settingDiffs.length, itemDiffs: itemDiffs.length, types: typeSummary, digest: cs.digest });
    if (settingDiffs.length || itemDiffs.length) {
        report.push(`\n== ${profile.name}: ${settingDiffs.length} setting diffs, ${itemDiffs.length} item diffs`);
        for (const d of settingDiffs) report.push(`  setting ${d}`);
        for (const d of itemDiffs.slice(0, showLimit)) report.push(`  ${d.type} ${d.id}\n    web ${d.web}\n    cs  ${d.cs}`);
    }
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad('profile', 32)} ${pad('items', 6)} ${pad('tagged', 7)} ${pad('groups', 7)} ${pad('tags', 7)} ${pad('diffs', 6)} types (tagged/items)`);
for (const r of rows) {
    console.log(`${pad(r.profile, 32)} ${pad(r.items, 6)} ${pad(r.tagged, 7)} ${pad(r.groups, 7)} ${pad(r.tags, 7)} ${pad(r.settingDiffs + r.itemDiffs, 6)} ${r.types}`);
}
for (const line of report) console.log(line);
writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ totalDiffs, rows }, null, 1));
console.log(`\nTotal differences: ${totalDiffs}`);
process.exit(totalDiffs ? 1 : 0);
