#!/usr/bin/env node
// Generates Services/PosterTags/Resolution/ResolutionData.g.cs: the English
// language display names (what the web reads from Intl.DisplayNames) and the
// JavaScript full case mappings the native poster tag resolver needs to match
// the web's tag logic without ICU.
//
//   node tests/poster/parity/gen-resolution-data.mjs          # write
//   node tests/poster/parity/gen-resolution-data.mjs --check  # verify
//
// The output depends on the ICU/CLDR data of the Node that runs it; the header
// records the versions. --check fails when the committed file differs, which
// is expected after a Node upgrade with new CLDR data (regenerate then).
import { readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', '..', '..', 'Jellyfin.Plugin.JellyfinEnhanced', 'Services', 'PosterTags', 'Resolution', 'ResolutionData.g.cs');

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });

// Region and script names as they appear inside a composed language name
// ("Afar (Cocos [Keeling] Islands)", "Chinese (Simplified, China)"), which can
// differ from the stand-alone region/script names. Read them through the
// root locale: "und-CC" -> "root (Cocos [Keeling] Islands)".
const ROOT_PREFIX = `${languageNames.of('und')} (`;
function contextName(subtag) {
    const name = languageNames.of(`und-${subtag}`);
    if (!name.startsWith(ROOT_PREFIX) || !name.endsWith(')')) throw new Error(`unexpected root name ${name}`);
    return name.slice(ROOT_PREFIX.length, -1);
}
const ALPHA = 'abcdefghijklmnopqrstuvwxyz';

function* codes(length, alphabet = ALPHA) {
    if (length === 0) { yield ''; return; }
    for (const head of alphabet) for (const tail of codes(length - 1, alphabet)) yield head + tail;
}

const stripRegion = (tag) => tag.split('-').filter((p) => !(/^[A-Z]{2}$/.test(p) || /^\d{3}$/.test(p))).join('-');

// Worker side of scanInWorkers: canonicalize a slice of codes and report the exceptions.
function scan(kind, slice, ctx) {
    const composite = new Map(ctx.compositeAliases);
    const aliases = new Map(ctx.languageAliases);
    const generic = new Map(ctx.genericVariantAliases || []);
    const found = [];
    for (const code of slice) {
        const base = composite.get(code) || stripRegion(aliases.get(code) || code);
        if (kind === 'languageRegion') {
            for (const region of ctx.canonicalRegions) {
                const canonical = Intl.getCanonicalLocales(`${code}-${region}`)[0];
                if (canonical !== `${base}-${region}`) found.push([`${code}-${region}`, canonical]);
            }
        } else {
            for (const variant of ctx.variants) {
                const actual = Intl.getCanonicalLocales(`${code}-${variant}`)[0];
                const replacement = generic.has(variant) ? generic.get(variant) : variant;
                const expected = replacement ? `${base}-${replacement}` : base;
                if (actual !== expected) found.push([`${code}-${variant}`, actual]);
            }
        }
    }
    return found;
}

if (!isMainThread) {
    parentPort.postMessage(scan(workerData.kind, workerData.slice, workerData.ctx));
    process.exit(0);
}

async function scanInWorkers(kind, all, ctx) {
    const workers = Math.max(1, Math.min(16, availableParallelism()));
    const size = Math.ceil(all.length / workers);
    const jobs = [];
    for (let i = 0; i < all.length; i += size) {
        const slice = all.slice(i, i + size);
        jobs.push(new Promise((resolve, reject) => {
            const worker = new Worker(new URL(import.meta.url), { workerData: { kind, slice, ctx } });
            worker.once('message', resolve);
            worker.once('error', reject);
        }));
    }
    return (await Promise.all(jobs)).flat();
}

// 1. Bare 2-3 letter language codes Intl knows (name differs from the code).
const languages = new Map();
for (const len of [2, 3]) {
    for (const code of codes(len)) {
        const name = languageNames.of(code);
        if (name !== code) languages.set(code, name);
    }
}

// 2. Language aliases: what Intl canonicalizes a bare code to (iw -> he, eng -> en, sh -> sr-Latn).
const languageAliases = new Map();
for (const len of [2, 3]) {
    for (const code of codes(len)) {
        const canonical = Intl.getCanonicalLocales(code)[0];
        if (canonical !== code) languageAliases.set(code, canonical);
    }
}

// 3. Regions: ISO 3166 alpha-2 and UN M.49 numeric codes with a name, plus aliases (UK -> GB, 826 -> GB).
const regionCodes = [...codes(2)].map((c) => c.toUpperCase());
for (let i = 0; i < 1000; i++) regionCodes.push(String(i).padStart(3, '0'));
const regions = new Map();
const regionAliases = new Map();
for (const region of regionCodes) {
    const canonical = Intl.getCanonicalLocales(`und-${region}`)[0].split('-')[1] || region;
    if (canonical !== region) regionAliases.set(region, canonical);
    const name = contextName(region);
    if (name !== region) regions.set(region, name);
}

// 4. Scripts (ISO 15924, title case).
const scripts = new Map();
for (const code of codes(4)) {
    const script = code[0].toUpperCase() + code.slice(1);
    const name = contextName(script);
    if (name !== script) scripts.set(script, name);
}

// 5. Dialect names: language-Region / language-Script pairs Intl names as a
//    whole ("American English") instead of "Language (Region)".
const canonicalLanguages = [...languages.keys()].filter((code) => !languageAliases.has(code));
const canonicalRegions = [...regions.keys()].filter((code) => !regionAliases.has(code));
const dialects = new Map();
for (const lang of canonicalLanguages) {
    const base = languages.get(lang);
    for (const region of canonicalRegions) {
        const tag = `${lang}-${region}`;
        const name = languageNames.of(tag);
        if (name !== `${base} (${regions.get(region)})`) dialects.set(tag, name);
    }
    for (const [script, scriptName] of scripts) {
        const tag = `${lang}-${script}`;
        const name = languageNames.of(tag);
        if (name !== `${base} (${scriptName})`) dialects.set(tag, name);
    }
}

// 6. Languages whose alias differs once the tag has more subtags ("bh" stays "bh",
//    but "bh-IN" becomes "bho-IN"; "tw-GH" becomes "ak-GH").
const compositeAliases = new Map();
for (const len of [2, 3]) {
    for (const code of codes(len)) {
        const composite = Intl.getCanonicalLocales(`${code}-US`)[0];
        if (!composite.endsWith('-US')) continue;
        const prefix = composite.slice(0, -3);
        if (prefix !== stripRegion(languageAliases.get(code) || code)) compositeAliases.set(code, prefix);
    }
}

// 7. Language+region pairs with their own canonical form (sgn-US -> ase). This scan
//    (every code x every region) is the slow part, so it runs on worker threads.
const allCodes = [...codes(2), ...codes(3)];
const languageRegionAliases = new Map(await scanInWorkers('languageRegion', allCodes, {
    compositeAliases: [...compositeAliases], languageAliases: [...languageAliases], canonicalRegions,
}));

// 8. Variant subtags: IANA-registered variants (vendored list, language-subtag-registry
//    2023-10-16) plus CLDR's "posix". Names as used inside a language name, the
//    language-independent variant aliases (und-heploc -> und-alalc97, und-lojban -> und,
//    CLDR's und-aaland -> und-AX region alias), and the language+variant pairs Intl
//    canonicalizes beyond those (art-lojban -> jbo).
const VARIANTS = ('1606nict 1694acad 1901 1959acad 1994 1996 abl1943 akuapem alalc97 aluku ao1990 aranes arevela arevmda arkaika asante ' +
    'auvern baku1926 balanka barla basiceng bauddha bciav bcizbl biscayan biske blasl bohoric boont bornholm cisaup colb1945 cornu creiss ' +
    'dajnko ekavsk emodeng fonipa fonkirsh fonnapa fonupa fonxsamp gallo gascon grclass grital grmistr hepburn heploc hognorsk hsistemo ' +
    'ijekavsk itihasa ivanchov jauer jyutping kkcor kociewie kscor laukika lemosin lengadoc lipaw ltg1929 ltg2007 luna1918 metelko monoton ' +
    'ndyuka nedis newfound nicard njiva nulik osojs oxendict pahawh2 pahawh3 pahawh4 pamaka peano petr1708 pinyin polyton provenc puter ' +
    'rigik rozaj rumgr scotland scouse simple solba sotav spanglis surmiran sursilv sutsilv synnejyl tarask tongyong tunumiit uccor ucrcor ' +
    'ulster unifon vaidika valencia vallader vecdruka vivaraup wadegile xsistemo posix lojban guoyu hakka xiang gaulish aaland').split(' ');
const variantNames = new Map();
const genericVariantAliases = new Map();
const VARIANT_PREFIX = `${ROOT_PREFIX}${contextName('ZZ')}, `;
for (const variant of VARIANTS) {
    const canonical = Intl.getCanonicalLocales(`und-${variant}`)[0];
    if (canonical !== `und-${variant}`) genericVariantAliases.set(variant, canonical.slice(3).replace(/^-/, ''));
    // Read through a region so script-type aliases (baku1926 -> Baku) do not apply.
    const name = languageNames.of(`und-ZZ-${variant}`);
    if (name.startsWith(VARIANT_PREFIX) && name.endsWith(')')) {
        const inner = name.slice(VARIANT_PREFIX.length, -1);
        if (inner !== variant.toUpperCase()) variantNames.set(variant, inner);
    }
}
const variantAliases = new Map(await scanInWorkers('variant', allCodes, {
    compositeAliases: [...compositeAliases], languageAliases: [...languageAliases], variants: VARIANTS, genericVariantAliases: [...genericVariantAliases],
}));

// 9. JavaScript full case mappings that expand to more than one UTF-16 unit
//    (String.prototype.toUpperCase / toLowerCase use SpecialCasing; .NET's
//    invariant casing is per character).
const upperSpecial = new Map();
const lowerSpecial = new Map();
for (let cp = 0; cp <= 0xffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCharCode(cp);
    const upper = ch.toUpperCase();
    if (upper.length > 1) upperSpecial.set(ch, upper);
    const lower = ch.toLowerCase();
    if (lower.length > 1) lowerSpecial.set(ch, lower);
}

// 10. The Unicode properties behind toLowerCase()'s one contextual rule, Final_Sigma (capital
//     sigma lowercases to final sigma after a cased letter, skipping case-ignorable characters,
//     unless a cased letter follows): code point ranges, start TAB end, six-digit hex.
function propertyRanges(regex) {
    const ranges = new Map();
    let start = -1;
    for (let cp = 0; cp <= 0x110000; cp++) {
        const inside = cp <= 0x10ffff && regex.test(String.fromCodePoint(cp));
        if (inside && start < 0) start = cp;
        if (!inside && start >= 0) {
            const hex = (n) => n.toString(16).toUpperCase().padStart(6, '0');
            ranges.set(hex(start), hex(cp - 1));
            start = -1;
        }
    }
    return ranges;
}
const casedRanges = propertyRanges(/^\p{Cased}$/u);
const caseIgnorableRanges = propertyRanges(/^\p{Case_Ignorable}$/u);

function csString(text) {
    let out = '';
    for (const ch of text) {
        const cp = ch.codePointAt(0);
        if (ch === '"') out += '\\"';
        else if (ch === '\\') out += '\\\\';
        else if (ch === '\n') out += '\\n';
        else if (ch === '\t') out += '\\t';
        else if (cp >= 0x20 && cp < 0x7f) out += ch;
        else if (cp > 0xffff) {
            const s = ch;
            out += `\\u${s.charCodeAt(0).toString(16).padStart(4, '0')}\\u${s.charCodeAt(1).toString(16).padStart(4, '0')}`;
        } else out += `\\u${cp.toString(16).padStart(4, '0')}`;
    }
    return out;
}

function table(name, map, summary) {
    const rows = [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const lines = rows.map(([k, v], i) => `            "${csString(k)}\\t${csString(v)}${i === rows.length - 1 ? '' : '\\n'}"`);
    return `        /// <summary>${summary} ${rows.length} rows of key TAB value, newline separated.</summary>
        internal const string ${name} =
${lines.join(' +\n')};
`;
}

const header = `// <auto-generated>
// Generated by tests/poster/parity/gen-resolution-data.mjs. Do not edit by hand.
// Source: Node ${process.versions.node}, ICU ${process.versions.icu}, CLDR ${process.versions.cldr}, Unicode ${process.versions.unicode}.
// </auto-generated>
`;

const body = `${header}
namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution
{
    /// <summary>
    /// Locale data the web reads from the browser's ICU (Intl.DisplayNames in English, String case
    /// mapping), captured so the native resolver produces identical language names without ICU.
    /// </summary>
    internal static class ResolutionData
    {
${table('LanguageNames', languages, 'English names of bare ISO 639 codes, as Intl.DisplayNames(["en"]).of(code) returns them.')}
${table('LanguageAliases', languageAliases, 'Canonical form Intl gives a bare language code (iw -> he, eng -> en, sh -> sr-Latn).')}
${table('RegionNames', regions, 'English region names (as used inside a language name) by ISO 3166-1 alpha-2 / UN M.49 code.')}
${table('RegionAliases', regionAliases, 'Canonical region for deprecated or numeric region codes (UK -> GB, 826 -> GB).')}
${table('ScriptNames', scripts, 'English ISO 15924 script names (as used inside a language name).')}
${table('DialectNames', dialects, 'Whole-tag dialect names for language-Region / language-Script pairs ("American English").')}
${table('LanguageRegionAliases', languageRegionAliases, 'Language+region pairs Intl canonicalizes to another language (sgn-US -> ase).')}
${table('CompositeLanguageAliases', compositeAliases, 'Language alias applied when the tag has further subtags and it differs from the bare alias (bh-IN -> bho-IN).')}
${table('VariantNames', variantNames, 'English variant subtag names (as used inside a language name).')}
${table('GenericVariantAliases', genericVariantAliases, 'Language-independent variant aliases: replacement subtags, empty when the variant is dropped.')}
${table('VariantAliases', variantAliases, 'Language+variant pairs Intl canonicalizes beyond the generic rules (art-lojban -> jbo).')}
${table('UpperCaseSpecial', upperSpecial, 'Characters whose JavaScript toUpperCase() expands to several UTF-16 units (SpecialCasing).')}
${table('LowerCaseSpecial', lowerSpecial, 'Characters whose JavaScript toLowerCase() expands to several UTF-16 units (SpecialCasing).')}
${table('CasedRanges', casedRanges, 'Code point ranges with the Unicode Cased property (Final_Sigma context).')}
${table('CaseIgnorableRanges', caseIgnorableRanges, 'Code point ranges with the Unicode Case_Ignorable property (Final_Sigma context).')}
    }
}
`;

if (process.argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(target, 'utf8'); } catch { /* missing */ }
    if (current !== body) {
        console.error(`${target} is out of date (or was generated by a different ICU). Re-run without --check.`);
        process.exit(1);
    }
    console.log('ResolutionData.g.cs is up to date.');
} else {
    writeFileSync(target, body);
    console.log(`Wrote ${target}: ${languages.size} languages, ${languageAliases.size} aliases, ${regions.size} regions, ${regionAliases.size} region aliases, ${scripts.size} scripts, ${dialects.size} dialects, ${compositeAliases.size} composite aliases, ${languageRegionAliases.size} language+region aliases, ${variantNames.size} variants, ${genericVariantAliases.size}/${variantAliases.size} variant aliases, ${upperSpecial.size}/${lowerSpecial.size} special case mappings, ${casedRanges.size}/${caseIgnorableRanges.size} cased/case-ignorable ranges.`);
}
