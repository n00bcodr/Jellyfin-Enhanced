// /js/core/media-language.js
// Shared audio-language → flag resolution for the Language Tags overlay
// (js/tags/languagetags.js) and the details-page audio-language row
// (js/enhanced/itemdetails/features-details-media-info.js). Single source of
// truth so the two features can never disagree about which flag a language
// gets.
//
// The resolver understands region subtags: a stream tagged `pt-BR` gets the
// Brazilian flag while `pt` / `pt-PT` keep the Portuguese one, `es-419` and
// `es-MX` get the Mexican flag while `es` stays Spain, `zh-Hant` maps to the
// Taiwanese flag, and so on. A region flag is shown only when the media
// explicitly carries one — a bare `pt` or `es` is never "guessed" into a
// regional variant.
(function(JE) {
    'use strict';

    JE.core = JE.core || {};

    /**
     * Language name/ISO-code → flag code, for languages WITHOUT an explicit
     * region subtag. Values are flag-icons codes (ISO 3166-1 alpha-2, plus
     * subdivision codes like `es-ct` which the flag-icons set also ships).
     * Keys cover English display names (as produced by Intl.DisplayNames) and
     * ISO 639-1/639-2 codes as they appear in real-world media containers.
     */
    const baseLanguageFlags = {
        English: 'gb', eng: 'gb', en: 'gb', Japanese: 'jp', jpn: 'jp', ja: 'jp', Spanish: 'es', spa: 'es', es: 'es',
        French: 'fr', fre: 'fr', fra: 'fr', fr: 'fr', German: 'de', ger: 'de', deu: 'de', de: 'de',
        Italian: 'it', ita: 'it', it: 'it', Korean: 'kr', kor: 'kr', ko: 'kr', Chinese: 'cn', chi: 'cn', zho: 'cn', zh: 'cn',
        Russian: 'ru', rus: 'ru', ru: 'ru', Portuguese: 'pt', por: 'pt', pt: 'pt', Hindi: 'in', hin: 'in', hi: 'in',
        Dutch: 'nl', dut: 'nl', nld: 'nl', nl: 'nl', Arabic: 'sa', ara: 'sa', ar: 'sa',
        Bengali: 'in', ben: 'in', bn: 'in', Czech: 'cz', ces: 'cz', cs: 'cz', Danish: 'dk', dan: 'dk', da: 'dk',
        Greek: 'gr', ell: 'gr', el: 'gr', Finnish: 'fi', fin: 'fi', fi: 'fi', Hebrew: 'il', heb: 'il', he: 'il',
        Hungarian: 'hu', hun: 'hu', hu: 'hu', Indonesian: 'id', ind: 'id', id: 'id',
        Norwegian: 'no', nor: 'no', no: 'no', Polish: 'pl', pol: 'pl', pl: 'pl',
        Persian: 'ir', per: 'ir', fas: 'ir', fa: 'ir', Romanian: 'ro', ron: 'ro', rum: 'ro', ro: 'ro',
        Swedish: 'se', swe: 'se', sv: 'se', Thai: 'th', tha: 'th', th: 'th', Turkish: 'tr', tur: 'tr', tr: 'tr',
        Ukrainian: 'ua', ukr: 'ua', uk: 'ua', Vietnamese: 'vn', vie: 'vn', vi: 'vn',
        Malay: 'my', msa: 'my', may: 'my', ms: 'my', Swahili: 'ke', swa: 'ke', sw: 'ke',
        Tagalog: 'ph', tgl: 'ph', tl: 'ph', Filipino: 'ph', Tamil: 'in', tam: 'in', ta: 'in',
        Telugu: 'in', tel: 'in', te: 'in', Marathi: 'in', mar: 'in', mr: 'in', Punjabi: 'in', pan: 'in', pa: 'in',
        Urdu: 'pk', urd: 'pk', ur: 'pk', Gujarati: 'in', guj: 'in', gu: 'in', Kannada: 'in', kan: 'in', kn: 'in',
        Malayalam: 'in', mal: 'in', ml: 'in', Sinhala: 'lk', sin: 'lk', si: 'lk', Nepali: 'np', nep: 'np', ne: 'np',
        Pashto: 'af', pus: 'af', ps: 'af', Kurdish: 'iq', kur: 'iq', ku: 'iq', Slovak: 'sk', slk: 'sk', sk: 'sk',
        Slovenian: 'si', slv: 'si', sl: 'si', Serbian: 'rs', srp: 'rs', sr: 'rs', Croatian: 'hr', hrv: 'hr', hr: 'hr',
        Bulgarian: 'bg', bul: 'bg', bg: 'bg', Macedonian: 'mk', mkd: 'mk', mk: 'mk', Albanian: 'al', sqi: 'al', sq: 'al',
        Estonian: 'ee', est: 'ee', et: 'ee', Latvian: 'lv', lav: 'lv', lv: 'lv', Lithuanian: 'lt', lit: 'lt', lt: 'lt',
        Icelandic: 'is', isl: 'is', is: 'is', Georgian: 'ge', kat: 'ge', ka: 'ge', Armenian: 'am', hye: 'am', hy: 'am',
        Mongolian: 'mn', mon: 'mn', mn: 'mn', Kazakh: 'kz', kaz: 'kz', kk: 'kz', Uzbek: 'uz', uzb: 'uz', uz: 'uz',
        Azerbaijani: 'az', aze: 'az', az: 'az', Belarusian: 'by', bel: 'by', be: 'by',
        Amharic: 'et', amh: 'et', am: 'et', Zulu: 'za', zul: 'za', zu: 'za', Afrikaans: 'za', afr: 'za', af: 'za',
        Hausa: 'ng', hau: 'ng', ha: 'ng', Yoruba: 'ng', yor: 'ng', yo: 'ng', Igbo: 'ng', ibo: 'ng', ig: 'ng',
        Brazilian: 'br', bra: 'br',
        Catalan: 'es-ct', cat: 'es-ct', ca: 'es-ct', Galician: 'es-ga', glg: 'es-ga', gl: 'es-ga',
        Basque: 'es-pv', eus: 'es-pv', baq: 'es-pv', eu: 'es-pv'
    };

    /**
     * Non-standard codes seen in real media that already IMPLY a region.
     * `pob`/`pb` are the de-facto Brazilian Portuguese codes used by
     * OpenSubtitles-era tooling and MKV muxers.
     */
    const aliasTags = {
        pob: { base: 'pt', region: 'br' },
        pb: { base: 'pt', region: 'br' }
    };

    /**
     * Region spellings seen in the wild that are not the ISO 3166-1 code the
     * flag set uses. `en-UK` is common; flag-icons only ships `gb`.
     */
    const regionAliases = { uk: 'gb' };

    /**
     * Per-base-language region conventions — deliberately NOT global, so
     * other languages can't inherit them (`en-419` must fall back to gb):
     * `es-419` (UN M.49 Latin America) uses the Mexican flag per the
     * community convention — most Latin-American dubs are produced there and
     * there is no pan-Latin-America flag. `es-LA`/`pt-LA` are widespread
     * non-ISO "Latin America" tags; taken literally the region would be Laos.
     */
    const regionOverridesByBase = {
        es: { la: 'mx', '419': 'mx' },
        spa: { la: 'mx', '419': 'mx' },
        pt: { la: 'br', '419': 'br' },
        por: { la: 'br', '419': 'br' }
    };

    /**
     * ISO 15924 script subtags that imply a flag — Chinese only (all its ISO
     * 639 spellings). Applying hant/hans to other languages (ja-Hans,
     * sr-Hant) would be wrong.
     */
    const chineseScriptFlags = { hant: 'tw', hans: 'cn' };
    const scriptFlagsByBase = { zh: chineseScriptFlags, zho: chineseScriptFlags, chi: chineseScriptFlags };

    /**
     * Every ISO 3166-1 alpha-2 region code. An alpha-2 subtag outside this
     * set (private-use `pt-XA`, withdrawn codes) is ignored so the resolver
     * falls back to the base language's flag instead of pointing the flag CDN
     * at a code it cannot have.
     */
    const validRegions = new Set(('ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bl bm bn bo bq br bs bt bv bw by bz ' +
        'ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg eh er es et fi fj fk fm fo fr ' +
        'ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ' +
        'ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz ' +
        'na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw ' +
        'sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ' +
        'ua ug um us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw').split(' '));

    /**
     * Parse a raw language tag into subtags. Accepts BCP-47 (`pt-BR`),
     * underscore variants (`pt_BR`) and bare ISO 639 codes, case-insensitive.
     * @param {string} raw
     * @returns {{base: string, region: string|null, script: string|null}|null}
     */
    function parseLanguageTag(raw) {
        if (!raw || typeof raw !== 'string') return null;
        const normalized = raw.trim().toLowerCase().replace(/_/g, '-');
        if (!normalized) return null;

        const alias = aliasTags[normalized];
        if (alias) return { base: alias.base, region: alias.region, script: null };

        const subtags = normalized.split('-');
        const base = subtags[0];
        // Base must look like an ISO 639 code; anything else (display names,
        // junk) is not parseable as a tag and is handled by the name map.
        if (!/^[a-z]{2,3}$/.test(base)) return null;

        let region = null;
        let script = null;
        for (const subtag of subtags.slice(1)) {
            // A single-letter subtag starts a BCP-47 extension or private-use
            // section (en-u-ca-gregory, en-x-us); nothing after it is a
            // region or script, so stop scanning entirely.
            if (subtag.length === 1) break;
            if (/^[a-z]{2}$/.test(subtag) && !region) {
                region = subtag; // ISO 3166-1 alpha-2 region (br, mx, us…)
            } else if (/^\d{3}$/.test(subtag) && !region) {
                region = subtag; // UN M.49 numeric region (419…)
            } else if (/^[a-z]{4}$/.test(subtag) && !script) {
                script = subtag; // ISO 15924 script (hant, hans…)
            }
        }
        return { base, region, script };
    }

    /**
     * Resolve the flag code for a language entry.
     *
     * Resolution order:
     *  1. Explicit, VALID region subtag → that country's flag (`pt-BR` → br),
     *     after alias/convention normalization (`en-UK` → gb, `es-LA` → mx,
     *     `es-419` → mx). Exception: when the base language's curated flag is
     *     a subdivision of that same region (`ca-ES` → the Catalan flag
     *     es-ct, not the Spanish one), the curated flag wins — the region
     *     adds no information the map didn't already encode more precisely.
     *  2. Script subtag, Chinese only (`zh-Hant` → tw, `zh-Hans` → cn).
     *  3. The base-language default from the shared map (`pt` → pt). Unknown
     *     or private-use regions (`pt-XA`) land here instead of producing a
     *     broken flag.
     *  4. The language *name* (covers cache entries and display names).
     *
     * @param {{name?: string, code?: string}|string} lang - A language entry
     *   ({name, code}) or a bare code string.
     * @returns {string|null} A flag-icons code, or null when unknown.
     */
    function resolveFlag(lang) {
        const code = typeof lang === 'string' ? lang : (lang && (lang.code || lang.Code)) || '';
        const name = (typeof lang === 'object' && lang && (lang.name || lang.Name)) || '';

        const parsed = parseLanguageTag(code);
        if (parsed) {
            const baseFlag = baseLanguageFlags[parsed.base] || null;
            // A region only refines a language we know (pt-BR). For an
            // unmapped base ('und-419', 'eo-FR') the region alone proves
            // nothing about the audio language — stay flagless, exactly as
            // the pre-region behavior did.
            if (parsed.region && baseFlag) {
                let region = parsed.region;
                const overrides = regionOverridesByBase[parsed.base];
                if (overrides && overrides[region]) {
                    region = overrides[region];
                } else if (regionAliases[region]) {
                    region = regionAliases[region];
                } else if (/^\d{3}$/.test(region)) {
                    // A numeric region with no per-language convention names
                    // an area, not a country — no flag; use the base's.
                    region = null;
                }
                if (region && validRegions.has(region)) {
                    // Curated-subdivision guard: es-ct/es-ga/es-pv are more
                    // specific than the es the region would give.
                    if (baseFlag && (baseFlag === region || baseFlag.indexOf(region + '-') === 0)) {
                        return baseFlag;
                    }
                    return region;
                }
            }
            const scripts = scriptFlagsByBase[parsed.base];
            if (parsed.script && scripts && scripts[parsed.script]) return scripts[parsed.script];
            if (baseFlag) return baseFlag;
        }
        // Name lookup last: catches English display names ("Portuguese") and
        // legacy cache entries whose code was already stripped.
        return baseLanguageFlags[name] || baseLanguageFlags[code] || null;
    }

    JE.core.mediaLanguage = {
        parseLanguageTag,
        resolveFlag,
        baseLanguageFlags
    };

    console.log('🪼 Jellyfin Enhanced: Media language core initialized');

})(window.JellyfinEnhanced);
