#!/usr/bin/env node
// Builds data/casing-expected.json: String.prototype.toLowerCase() / toUpperCase() for every
// code point the two change, plus Final_Sigma contexts (capital sigma before and after every
// cased or case-ignorable code point), so `PosterTagParity casing` can check JsText against the
// real JS. Rows are [input, lower, upper].
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rows = [];
const add = (s) => rows.push([s, s.toLowerCase(), s.toUpperCase()]);
const context = /^[\p{Cased}\p{Case_Ignorable}]$/u;
for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    if (ch.toLowerCase() !== ch || ch.toUpperCase() !== ch) add(ch);
    if (context.test(ch)) {
        add(`${ch}Σ`);
        add(`A${ch}Σ`);
        add(`AΣ${ch}`);
        add(`AΣ${ch}b`);
    }
}
for (const s of ['\u03a3', 'A\u03a3', '\u03a3A', 'A\u03a3 b', 'A.\u03a3', '\ud801\udc00\u03a3', 'Stra\u00dfe \u0130 \u0149 \u01f0']) add(s);
writeFileSync(join(here, 'data', 'casing-expected.json'), JSON.stringify(rows));
console.log(`casing: ${rows.length} strings`);
