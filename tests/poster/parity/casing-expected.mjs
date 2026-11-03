#!/usr/bin/env node
// Builds data/casing-expected.json: String.prototype.toLowerCase() / toUpperCase() for every
// code point the two change, plus Final_Sigma contexts (capital sigma before and after every
// cased or case-ignorable code point), so `PosterTagParity casing` can check JsText against the
// real JS. Rows are [input, lower, upper].
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// JsText cases through .NET, which on Linux uses the host's system ICU, while Node bundles its
// own (newer) ICU. Ubuntu 24.04, the CI runner, has ICU 74 (Unicode 15.1), so a string whose
// input or result involves a character added later can't match there: U+019B gained the
// uppercase U+A7DC in Unicode 16, for example. These are the cased or case-ignorable code
// points added in Unicode 16.0 and 17.0 (DerivedAge.txt 17.0.0); 15.1 added none. Extend the
// list when Node moves to a newer Unicode version.
const newerThanUnicode15_1 = [
    [0x0897, 0x0897], [0x1c89, 0x1c8a], [0xa7cb, 0xa7cd], [0xa7da, 0xa7dc], [0x10d40, 0x10d65],
    [0x10d69, 0x10d85], [0x10efc, 0x10efc], [0x113b7, 0x113c0], [0x113cc, 0x113d5], [0x113e1, 0x113e2],
    [0x11f5a, 0x11f5a], [0x16100, 0x16139], [0x16d40, 0x16d79], [0x1e5d0, 0x1e5fa], // 16.0
    [0x1acf, 0x1add], [0x1ae0, 0x1aeb], [0xa7ce, 0xa7cf], [0xa7d2, 0xa7d2], [0xa7d4, 0xa7d4],
    [0xa7f1, 0xa7f1], [0x10ec5, 0x10ec7], [0x10efa, 0x10efb], [0x11b60, 0x11b67], [0x11db0, 0x11ddb],
    [0x16ea0, 0x16eb8], [0x16ebb, 0x16ed3], [0x16ff2, 0x16ff6], [0x1e6e0, 0x1e6f5], [0x1e6fe, 0x1e6ff], // 17.0
];
const isNewer = (s) => [...s].some((ch) => {
    const cp = ch.codePointAt(0);
    return newerThanUnicode15_1.some(([from, to]) => cp >= from && cp <= to);
});

const rows = [];
let skipped = 0;
const add = (s) => {
    const row = [s, s.toLowerCase(), s.toUpperCase()];
    if (row.some(isNewer)) skipped++;
    else rows.push(row);
};
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
for (const s of ['Σ', 'AΣ', 'ΣA', 'AΣ b', 'A.Σ', '𐐀Σ', 'Straße İ ŉ ǰ']) add(s);
writeFileSync(join(here, 'data', 'casing-expected.json'), JSON.stringify(rows));
console.log(`casing: ${rows.length} strings (${skipped} skipped: characters newer than Unicode 15.1)`);
