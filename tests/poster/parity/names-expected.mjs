#!/usr/bin/env node
// Builds data/names-expected.json: Intl.DisplayNames(['en'], {type: 'language'})
// for every audio language code in the fetched tag caches and the synthetic
// entries, plus a broad matrix (every bare 2-3 letter code, flag languages x
// every region, scripts, aliases, invalid tags), so `PosterTagParity names`
// can check the C# LanguageNames port against the real Intl.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, 'data');
const dn = new Intl.DisplayNames(['en'], { type: 'language' });
const codes = new Set();

for (const file of readdirSync(join(dataDir, 'inputs')).filter((f) => f.startsWith('tagcache-'))) {
    for (const entry of Object.values(JSON.parse(readFileSync(join(dataDir, 'inputs', file), 'utf8')))) {
        for (const code of entry.AudioLanguages || []) codes.add(code);
    }
}
for (const entry of Object.values(JSON.parse(readFileSync(join(dataDir, 'synthetic', 'entries.json'), 'utf8')))) {
    for (const code of entry.AudioLanguages || []) if (code !== null) codes.add(code);
}

const A = 'abcdefghijklmnopqrstuvwxyz';
for (const a of A) {
    for (const b of A) {
        for (const code of [a + b, ...[...A].map((c) => a + b + c)]) {
            codes.add(code);
            codes.add(`${code}-US`);
            codes.add(`${code}-Latn`);
        }
    }
}
const variants = ['1901', '1994', 'valencia', 'posix', 'lojban', 'arevela', 'arevmda', 'heploc', 'baku1926', 'pinyin', 'scouse', 'rozaj', 'biske', 'guoyu', 'hakka', 'xiang', 'gaulish', 'abcde', 'fonipa', 'aaland'];
for (const lang of ['en', 'de', 'ca', 'sl', 'zh', 'hy', 'arm', 'art', 'cel', 'prs', 'cnr', 'bh', 'tw', 'sh', 'iw', 'aa', 'und', 'xyz', 'sr', 'az', 'ja']) {
    for (const variant of variants) {
        codes.add(`${lang}-${variant}`);
        codes.add(`${lang}-US-${variant}`);
        codes.add(`${lang}-Latn-${variant}`);
        codes.add(`${lang}-${variant}-scouse`);
        codes.add(`${lang}-pinyin-${variant}`);
    }
}

// Extensions: Intl accepts only a trailing -u-va-posix (ICU turns it into the POSIX variant).
const extensions = ['u-va-posix', 'U-VA-POSIX', 'u-va-posix-x-a', 'u-ca-gregory', 'u-va-posixx', 'u-va', 'u-va-posix-u-va-posix',
    'a-foo-u-va-posix', 'u-va-posix-a-foo', 't-de', 'x-u-va-posix', 'u-vt-posix', 'u-va-posix-ca-gregory', 'u-attr-va-posix'];
for (const lang of ['en', 'de', 'ja', 'prs', 'cnr', 'sh', 'iw', 'zh', 'und', 'xyz', 'art', 'bh']) {
    for (const prefix of [lang, `${lang}-US`, `${lang}-Latn`, `${lang}-Latn-US`, `${lang}-1901`, `${lang}-US-scouse`, `${lang}-posix`,
        `${lang}-baku1926`, `${lang}-pinyin`, `${lang}-lojban`, `${lang}-419`, `${lang}-UK`]) {
        for (const extension of extensions) codes.add(`${prefix}-${extension}`);
    }
}

const regions = [];
for (const a of A) for (const b of A) regions.push((a + b).toUpperCase());
regions.push('419', '001', '150', '826', '840', '030', '999');
const flagLanguages = ['en', 'eng', 'es', 'spa', 'pt', 'por', 'fr', 'fre', 'de', 'ger', 'zh', 'chi', 'ja', 'ar', 'nl', 'it', 'ru', 'sv', 'nb', 'no', 'sr', 'hi', 'fa', 'sw', 'ro', 'ca', 'iw', 'in', 'tl', 'sh', 'mo', 'cnr', 'zxx', 'und', 'xyz', 'tw', 'yue', 'cmn'];
const scripts = ['Latn', 'Cyrl', 'Hans', 'Hant', 'Arab', 'Deva', 'Jpan', 'Kore', 'Zzzz', 'Qaaa', 'Guru', 'Ethi'];
for (const lang of flagLanguages) {
    for (const region of regions) {
        codes.add(`${lang}-${region}`);
        codes.add(`${lang}-${region.toLowerCase()}`);
    }
    for (const script of scripts) {
        codes.add(`${lang}-${script}`);
        codes.add(`${lang}-${script.toLowerCase()}`);
        for (const region of ['US', 'CN', 'TW', 'HK', 'RS', 'BR', 'IN', '419', 'ZZ']) codes.add(`${lang}-${script}-${region}`);
    }
}
for (const code of ['pt_BR', 'root', 'e', 'en--us', '-en', 'en-', 'x-klingon', 'i-klingon', 'en-u-ca-gregory', 'en-x-foo', 'zh-min-nan',
    'abcdefghi', 'english', 'English', 'EN-US', 'En-Us', 'sgn-be-fr', 'art-lojban', 'en-gb-oed', 'de-1901-1901', 'en-abcde', 'en-us-abcde-fghij',
    'zh-hant-abcde', 'en-1abc', 'en-12ab', 'en-latn-us-abcde', ' en', 'en ', '', 'eng-', 'q', '123', 'en-123', 'en-12', 'en-1234']) {
    codes.add(code);
}

// baku1926 becomes the Baku script only when no other variant becomes alalc97 or a region.
for (const lang of ['az', 'tk', 'en', 'sh', 'prs', 'sgn', 'und']) {
    for (const tail of ['baku1926-heploc', 'heploc-baku1926', 'baku1926-alalc97', 'alalc97-baku1926', 'baku1926-aaland', 'aaland-baku1926',
        'baku1926-aaland-heploc', 'baku1926-heploc-fonipa', 'baku1926-fonipa', 'US-baku1926-heploc', 'Latn-baku1926-heploc']) {
        codes.add(`${lang}-${tail}`);
    }
}

const expected = {};
for (const code of codes) {
    let name;
    try { name = dn.of(code); } catch { name = null; }
    expected[code] = name;
}
writeFileSync(join(dataDir, 'names-expected.json'), JSON.stringify(expected));
console.log(`names: ${codes.size} codes`);
