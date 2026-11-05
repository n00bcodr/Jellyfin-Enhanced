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
        // Bokmål and Nynorsk share Norway's flag; Cantonese, Swiss German and Irish their region's.
        'Norwegian Bokmål': 'no', nob: 'no', nb: 'no', 'Norwegian Nynorsk': 'no', nno: 'no', nn: 'no',
        Cantonese: 'hk', yue: 'hk', 'Swiss German': 'ch', gsw: 'ch', Irish: 'ie', gle: 'ie', ga: 'ie',
        Persian: 'ir', per: 'ir', fas: 'ir', fa: 'ir', Romanian: 'ro', ron: 'ro', rum: 'ro', ro: 'ro',
        Swedish: 'se', swe: 'se', sv: 'se', Thai: 'th', tha: 'th', th: 'th', Turkish: 'tr', tur: 'tr', tr: 'tr',
        Ukrainian: 'ua', ukr: 'ua', uk: 'ua', Vietnamese: 'vn', vie: 'vn', vi: 'vn',
        Malay: 'my', msa: 'my', may: 'my', ms: 'my', Swahili: 'ke', swa: 'ke', sw: 'ke',
        Bosnian: 'ba', bos: 'ba', bs: 'ba', Khmer: 'kh', khm: 'kh', km: 'kh', Lao: 'la', lao: 'la', lo: 'la',
        Burmese: 'mm', mya: 'mm', bur: 'mm', my: 'mm', Luxembourgish: 'lu', ltz: 'lu', lb: 'lu',
        Tagalog: 'ph', tgl: 'ph', tl: 'ph', Filipino: 'ph', fil: 'ph', Tamil: 'in', tam: 'in', ta: 'in',
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
        Basque: 'es-pv', eus: 'es-pv', baq: 'es-pv', eu: 'es-pv',
        Cantonese: 'hk', yue: 'hk', Maori: 'nz', 'Māori': 'nz', mao: 'nz', mri: 'nz', mi: 'nz',
        'Egyptian Arabic': 'eg', arz: 'eg', 'Central Kurdish': 'iq', ckb: 'iq',
        // ISO 639-2 `zxx` = "no linguistic content": silent films, and films
        // with a score/sound design but no dialogue. Not a country, so it
        // resolves to a synthetic token rendered from `specialFlags` below
        // rather than to a flag-icons code.
        zxx: 'zxx', 'No linguistic content': 'zxx', 'Not applicable': 'zxx'
    };

    /**
     * Flag tokens that are NOT flag-icons codes and therefore cannot be built
     * into a CDN URL. Values are self-contained data URIs, so they cost no
     * request and cannot 404. Keep the artwork 4:3 to match the flag set —
     * the overlay sizes by width and lets height follow.
     */
    const specialFlags = {
        // Crossed-out speech bubble: "no dialogue". Deliberately not a flag,
        // because no country is being claimed.
        zxx: 'data:image/svg+xml,' + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480">' +
            '<rect width="640" height="480" fill="#3d4552"/>' +
            '<path d="M150 130H490A40 40 0 0 1 530 170V300A40 40 0 0 1 490 340H300L210 420V340H150A40 40 0 0 1 110 300V170A40 40 0 0 1 150 130Z" fill="#fff"/>' +
            '<path d="M140 380L500 100" stroke="#e5484d" stroke-width="52" stroke-linecap="round"/>' +
            '</svg>'
        )
    };

    /**
     * Turn a flag token from `resolveFlag` into an `img.src`. Real flag-icons
     * codes go through the plugin's local CDN route as before; synthetic
     * tokens (`zxx`) render from the inline table above.
     * @param {string} flagCode
     * @returns {string}
     */
    function flagSrc(flagCode) {
        return specialFlags[flagCode] || JE.cdn.flagSvg(flagCode);
    }
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
     * When the admin Merge Regional Variants setting is on, every tag with a
     * known base language resolves straight to that base flag.
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
            // The code itself, else its canonical language (ISO 639-2/B "gre" is "el"): the flag never depends
            // on a display name, which follows the viewer's language.
            // A BCP 47 extended language subtag names the language itself (zh-yue is Cantonese).
            const extlang = /^[a-z]{2,3}[-_]([a-z]{3})(?![a-z])/i.exec(code.trim())?.[1].toLowerCase();
            const baseFlag = (extlang && Object.hasOwn(baseLanguageFlags, extlang) ? baseLanguageFlags[extlang] : null)
                || baseLanguageFlags[parsed.base] || baseLanguageFlags[canonicalBase(parsed.base)] || null;
            if (JE.pluginConfig?.LanguageTagsMergeRegions && baseFlag) return baseFlag;
            // A synthetic token is not a country and cannot be refined by a
            // region or script: `zxx-US` still means "no dialogue", not US.
            if (baseFlag && specialFlags[baseFlag]) return baseFlag;
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
            const scripts = scriptFlagsByBase[parsed.base] || scriptFlagsByBase[canonicalBase(parsed.base)];
            if (parsed.script && scripts && scripts[parsed.script]) return scripts[parsed.script];
            if (baseFlag) return baseFlag;
        }
        // Name lookup last: catches English display names ("Portuguese") and
        // legacy cache entries whose code was already stripped.
        return baseLanguageFlags[name] || baseLanguageFlags[code] || null;
    }

    /**
     * Human-readable English name for a language code. `zxx` has no Intl
     * display name, so it gets a localized "No dialogue" label instead.
     * @param {string} code
     * @returns {string}
     */
    function displayName(code) {
        if (parseLanguageTag(code)?.base === 'zxx') return JE.t('audio_language_no_dialogue');
        return new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
    }

    /**
     * ISO 639-2 (bibliographic and terminologic) → ISO 639-1 for the
     * languages with a 639-1 equivalent (ISO 639-2 alpha-3 and bibliographic
     * spellings). Display conversion must preserve TL, NB and NN. Consulted before
     * `Intl` so the everyday cases (`eng`/`en`, `ger`/`deu`/`de`) compare
     * equal even on an engine whose ICU data predates those aliases.
     */
    const iso6392To6391 = {
        aar: 'aa', abk: 'ab', afr: 'af', aka: 'ak', alb: 'sq', amh: 'am', ara: 'ar', arg: 'an',
        arm: 'hy', asm: 'as', ava: 'av', ave: 'ae', aym: 'ay', aze: 'az', bak: 'ba', bam: 'bm',
        baq: 'eu', bel: 'be', ben: 'bn', bis: 'bi', bod: 'bo', bos: 'bs', bre: 'br', bul: 'bg',
        bur: 'my', cat: 'ca', ces: 'cs', cha: 'ch', che: 'ce', chi: 'zh', chu: 'cu', chv: 'cv',
        cor: 'kw', cos: 'co', cre: 'cr', cym: 'cy', cze: 'cs', dan: 'da', deu: 'de', div: 'dv',
        dut: 'nl', dzo: 'dz', ell: 'el', eng: 'en', epo: 'eo', est: 'et', eus: 'eu', ewe: 'ee',
        fao: 'fo', fas: 'fa', fij: 'fj', fin: 'fi', fra: 'fr', fre: 'fr', fry: 'fy', ful: 'ff',
        geo: 'ka', ger: 'de', gla: 'gd', gle: 'ga', glg: 'gl', glv: 'gv', gre: 'el', grn: 'gn',
        guj: 'gu', hat: 'ht', hau: 'ha', heb: 'he', her: 'hz', hin: 'hi', hmo: 'ho', hrv: 'hr',
        hun: 'hu', hye: 'hy', ibo: 'ig', ice: 'is', ido: 'io', iii: 'ii', iku: 'iu', ile: 'ie',
        ina: 'ia', ind: 'id', ipk: 'ik', isl: 'is', ita: 'it', jav: 'jv', jpn: 'ja', kal: 'kl',
        kan: 'kn', kas: 'ks', kat: 'ka', kau: 'kr', kaz: 'kk', khm: 'km', kik: 'ki', kin: 'rw',
        kir: 'ky', kom: 'kv', kon: 'kg', kor: 'ko', kua: 'kj', kur: 'ku', lao: 'lo', lat: 'la',
        lav: 'lv', lim: 'li', lin: 'ln', lit: 'lt', ltz: 'lb', lub: 'lu', lug: 'lg', mac: 'mk',
        mah: 'mh', mal: 'ml', mao: 'mi', mar: 'mr', may: 'ms', mkd: 'mk', mlg: 'mg', mlt: 'mt',
        mon: 'mn', mri: 'mi', msa: 'ms', mya: 'my', nau: 'na', nav: 'nv', nbl: 'nr', nde: 'nd',
        ndo: 'ng', nep: 'ne', nld: 'nl', nno: 'nn', nob: 'nb', nor: 'no', nya: 'ny', oci: 'oc',
        oji: 'oj', ori: 'or', orm: 'om', oss: 'os', pan: 'pa', per: 'fa', pli: 'pi', pol: 'pl',
        por: 'pt', pus: 'ps', que: 'qu', roh: 'rm', ron: 'ro', rum: 'ro', run: 'rn', rus: 'ru',
        sag: 'sg', san: 'sa', sin: 'si', slk: 'sk', slo: 'sk', slv: 'sl', sme: 'se', smo: 'sm',
        sna: 'sn', snd: 'sd', som: 'so', sot: 'st', spa: 'es', sqi: 'sq', srd: 'sc', srp: 'sr',
        ssw: 'ss', sun: 'su', swa: 'sw', swe: 'sv', tah: 'ty', tam: 'ta', tat: 'tt', tel: 'te',
        tgk: 'tg', tgl: 'tl', tha: 'th', tib: 'bo', tir: 'ti', ton: 'to', tsn: 'tn', tso: 'ts',
        tuk: 'tk', tur: 'tr', twi: 'tw', uig: 'ug', ukr: 'uk', urd: 'ur', uzb: 'uz', ven: 've',
        vie: 'vi', vol: 'vo', wel: 'cy', wln: 'wa', wol: 'wo', xho: 'xh', yid: 'yi', yor: 'yo',
        zha: 'za', zho: 'zh', zul: 'zu',
    };

    /**
     * ISO display code, independent of audio equivalence and CLDR macrolanguages.
     * @param {string} code - Raw language tag.
     * @returns {string} Uppercase 639-1 code or the original three-letter base.
     */
    function displayCode(code) {
        const base = parseLanguageTag(code)?.base;
        return base ? (iso6392To6391[base] || base).toUpperCase() : '';
    }

    /** Memo for `canonicalBase`: it runs per audio stream per card. */
    const canonicalBaseCache = new Map();

    /**
     * Canonical form of a parsed base language: the ISO 639-1 code where one
     * exists (`eng` → `en`; `ger`, `deu` and `de` all yield `de`), via the table above and then
     * ICU's CLDR aliases (`tl`/`tgl` → `fil`, `iw` → `he`) where the engine
     * offers `Intl.getCanonicalLocales`. Unknown codes come back unchanged so
     * two equal unknowns still match each other.
     * @param {string} base - Lowercased ISO 639 base from `parseLanguageTag`.
     * @returns {string}
     */
    function canonicalBase(base) {
        // Audio equivalence is broader than ISO display identity.
        if (['tl', 'tgl'].includes(base)) return 'fil';
        if (['nb', 'nob', 'nn', 'nno'].includes(base)) return 'no';
        if (iso6392To6391[base]) return iso6392To6391[base];
        const memo = canonicalBaseCache.get(base);
        if (memo !== undefined) return memo;
        let canonical = base;
        if (typeof Intl !== 'undefined' && typeof Intl.getCanonicalLocales === 'function') {
            try {
                const locale = Intl.getCanonicalLocales(base)[0];
                if (locale) canonical = locale.split('-')[0].toLowerCase();
            } catch (e) { /* not a well-formed tag — keep the raw base */ }
        }
        canonicalBaseCache.set(base, canonical);
        return canonical;
    }

    /**
     * Whether a media stream's language tag denotes the language the user
     * asked for. Base languages are compared canonically (`deu` matches
     * `de` and `ger`), regions after `regionAliases` (`en-UK` is `en-GB`);
     * a region on the preference (`pt-BR`) only excludes a
     * stream that carries a *different* region (`pt-PT`) — a bare `pt`
     * stream still matches, since it may well be Brazilian. Pass
     * `requireRegion` to demand the region as well, for a strict first pass.
     * @param {string} streamLanguage - Tag on the media stream.
     * @param {string} preferred - The user's preferred language tag.
     * @param {{requireRegion?: boolean}} [options]
     * @returns {boolean}
     */
    function matchesLanguage(streamLanguage, preferred, options = {}) {
        const stream = parseLanguageTag(streamLanguage);
        const wanted = parseLanguageTag(preferred);
        if (!stream || !wanted) return false;
        if (canonicalBase(stream.base) !== canonicalBase(wanted.base)) return false;
        if (!wanted.region) return true;
        const streamRegion = stream.region && (regionAliases[stream.region] || stream.region);
        const wantedRegion = regionAliases[wanted.region] || wanted.region;
        if (options.requireRegion) return streamRegion === wantedRegion;
        return !streamRegion || streamRegion === wantedRegion;
    }

    // Assigned ISO 639-1/639-2 codes, including bibliographic spellings (iso-codes 639-2 registry).
    // Keep this registry in step with Configuration/LanguageTagPrioritySettings.cs.
    const priorityIsoCodes = new Set(("aa aar ab abk ace ach ada ady ae af afa afh afr ain ak aka akk alb ale alg alt am amh an ang anp apa ar ara arc arg arm arn arp art arw as asm ast ath aus av ava ave awa ay aym az aze ba bad bai bak bal bam ban baq bas bat be bej bel bem ben ber bg bho bi bih bik bin bis bla bm bn bnt bo bod bos br bra bre bs btk bua bug bul bur byn ca cad cai car cat cau ce ceb cel ces ch cha chb che chg chi chk chm chn cho chp chr chu chv chy cmc cnr co cop cor cos cpe cpf cpp cr cre crh crp cs csb cu cus cv cy cym cze da dak dan dar day de del den deu dgr din div doi dra dsb dua dum dut dv dyu dz dzo ee efi egy eka el ell elx en eng enm eo epo es est et eu eus ewe ewo fa fan fao fas fat ff fi fij fil fin fiu fj fo fon fr fra fre frm fro frr frs fry ful fur fy ga gaa gay gba gd gem geo ger gez gil gl gla gle glg glv gmh gn goh gon gor got grb grc gre grn gsw gu guj gv gwi ha hai hat hau haw he heb her hi hil him hin hit hmn hmo ho hr hrv hsb ht hu hun hup hy hye hz ia iba ibo ice id ido ie ig ii iii ijo ik iku ile ilo ina inc ind ine inh io ipk ira iro is isl it ita iu ja jav jbo jpn jpr jrb jv ka kaa kab kac kal kam kan kar kas kat kau kaw kaz kbd kg kha khi khm kho ki kik kin kir kj kk kl km kmb kn ko kok kom kon kor kos kpe kr krc krl kro kru ks ku kua kum kur kut kv kw ky la lad lah lam lao lat lav lb lez lg li lim lin lit ln lo lol loz lt ltz lu lua lub lug lui lun luo lus lv mac mad mag mah mai mak mal man mao map mar mas may mdf mdr men mg mga mh mi mic min mis mk mkd mkh ml mlg mlt mn mnc mni mno moh mon mos mr mri ms msa mt mul mun mus mwl mwr my mya myn myv na nah nai nap nau nav nb nbl nd nde ndo nds ne nep new ng nia nic niu nl nld nn nno no nob nog non nor nqo nr nso nub nv nwc ny nya nym nyn nyo nzi oc oci oj oji om or ori orm os osa oss ota oto pa paa pag pal pam pan pap pau peo per phi phn pi pl pli pol pon por pra pro ps pt pus qu que raj rap rar rm rn ro roa roh rom ron ru rum run rup rus rw sa sad sag sah sai sal sam san sas sat sc scn sco sd se sel sem sg sga sgn shn si sid sin sio sit sk sl sla slk slo slv sm sma sme smi smj smn smo sms sn sna snd snk so sog som son sot spa sq sqi sr srd srn srp srr ss ssa ssw st su suk sun sus sux sv sw swa swe syc syr ta tah tai tam tat te tel tem ter tet tg tgk tgl th tha ti tib tig tir tiv tk tkl tl tlh tli tmh tn to tog ton tpi tr ts tsi tsn tso tt tuk tum tup tur tut tvl tw twi ty tyv udm ug uga uig uk ukr umb und ur urd uz uzb vai ve ven vi vie vo vol vot wa wak wal war was wel wen wln wo wol xal xh xho yao yap yi yid yo yor ypk za zap zbl zen zgh zh zha zho znd zu zul zun zxx zza").split(' '));
    // English names from the same ISO 639-2 registry. Some browser ICU builds
    // return a code instead of a name; retain that language's searchable name.
    // Alias names (Tagalog/Filipino, Norwegian variants) remain searchable too.
    const priorityIsoNames = {
        "aar": "Afar",
        "abk": "Abkhazian",
        "ace": "Achinese",
        "ach": "Acoli",
        "ada": "Adangme",
        "ady": "Adyghe; Adygei",
        "afa": "Afro-Asiatic languages",
        "afh": "Afrihili",
        "afr": "Afrikaans",
        "ain": "Ainu",
        "aka": "Akan",
        "akk": "Akkadian",
        "ale": "Aleut",
        "alg": "Algonquian languages",
        "alt": "Southern Altai",
        "amh": "Amharic",
        "ang": "English, Old (ca. 450-1100)",
        "anp": "Angika",
        "apa": "Apache languages",
        "ara": "Arabic",
        "arc": "Official Aramaic (700-300 BCE); Imperial Aramaic (700-300 BCE)",
        "arg": "Aragonese",
        "arn": "Mapudungun; Mapuche",
        "arp": "Arapaho",
        "art": "Artificial languages",
        "arw": "Arawak",
        "asm": "Assamese",
        "ast": "Asturian; Bable; Leonese; Asturleonese",
        "ath": "Athapascan languages",
        "aus": "Australian languages",
        "ava": "Avaric",
        "ave": "Avestan",
        "awa": "Awadhi",
        "aym": "Aymara",
        "aze": "Azerbaijani",
        "bad": "Banda languages",
        "bai": "Bamileke languages",
        "bak": "Bashkir",
        "bal": "Baluchi",
        "bam": "Bambara",
        "ban": "Balinese",
        "bas": "Basa",
        "bat": "Baltic languages",
        "bej": "Beja; Bedawiyet",
        "bel": "Belarusian",
        "bem": "Bemba",
        "ben": "Bengali",
        "ber": "Berber languages",
        "bho": "Bhojpuri",
        "bih": "Bihari languages",
        "bik": "Bikol",
        "bin": "Bini; Edo",
        "bis": "Bislama",
        "bla": "Siksika",
        "bnt": "Bantu languages",
        "bod": "Tibetan",
        "bos": "Bosnian",
        "bra": "Braj",
        "bre": "Breton",
        "btk": "Batak languages",
        "bua": "Buriat",
        "bug": "Buginese",
        "bul": "Bulgarian",
        "byn": "Blin; Bilin",
        "cad": "Caddo",
        "cai": "Central American Indian languages",
        "car": "Galibi Carib",
        "cat": "Catalan; Valencian",
        "cau": "Caucasian languages",
        "ceb": "Cebuano",
        "cel": "Celtic languages",
        "ces": "Czech",
        "cha": "Chamorro",
        "chb": "Chibcha",
        "che": "Chechen",
        "chg": "Chagatai",
        "chk": "Chuukese",
        "chm": "Mari",
        "chn": "Chinook jargon",
        "cho": "Choctaw",
        "chp": "Chipewyan; Dene Suline",
        "chr": "Cherokee",
        "chu": "Church Slavic; Old Slavonic; Church Slavonic; Old Bulgarian; Old Church Slavonic",
        "chv": "Chuvash",
        "chy": "Cheyenne",
        "cmc": "Chamic languages",
        "cnr": "Montenegrin",
        "cop": "Coptic",
        "cor": "Cornish",
        "cos": "Corsican",
        "cpe": "Creoles and pidgins, English based",
        "cpf": "Creoles and pidgins, French-based",
        "cpp": "Creoles and pidgins, Portuguese-based",
        "cre": "Cree",
        "crh": "Crimean Tatar; Crimean Turkish",
        "crp": "Creoles and pidgins",
        "csb": "Kashubian",
        "cus": "Cushitic languages",
        "cym": "Welsh",
        "dak": "Dakota",
        "dan": "Danish",
        "dar": "Dargwa",
        "day": "Land Dayak languages",
        "del": "Delaware",
        "den": "Slave (Athapascan)",
        "deu": "German",
        "dgr": "Tlicho; Dogrib",
        "din": "Dinka",
        "div": "Divehi; Dhivehi; Maldivian",
        "doi": "Dogri",
        "dra": "Dravidian languages",
        "dsb": "Lower Sorbian",
        "dua": "Duala",
        "dum": "Dutch, Middle (ca. 1050-1350)",
        "dyu": "Dyula",
        "dzo": "Dzongkha",
        "efi": "Efik",
        "egy": "Egyptian (Ancient)",
        "eka": "Ekajuk",
        "ell": "Greek, Modern (1453-)",
        "elx": "Elamite",
        "eng": "English",
        "enm": "English, Middle (1100-1500)",
        "epo": "Esperanto",
        "est": "Estonian",
        "eus": "Basque",
        "ewe": "Ewe",
        "ewo": "Ewondo",
        "fan": "Fang",
        "fao": "Faroese",
        "fas": "Persian",
        "fat": "Fanti",
        "fij": "Fijian",
        "fil": "Filipino; Pilipino",
        "fin": "Finnish",
        "fiu": "Finno-Ugrian languages",
        "fon": "Fon",
        "fra": "French",
        "frm": "French, Middle (ca. 1400-1600)",
        "fro": "French, Old (842-ca. 1400)",
        "frr": "Northern Frisian",
        "frs": "Eastern Frisian",
        "fry": "Western Frisian",
        "ful": "Fulah",
        "fur": "Friulian",
        "gaa": "Ga",
        "gay": "Gayo",
        "gba": "Gbaya",
        "gem": "Germanic languages",
        "gez": "Geez",
        "gil": "Gilbertese",
        "gla": "Gaelic; Scottish Gaelic",
        "gle": "Irish",
        "glg": "Galician",
        "glv": "Manx",
        "gmh": "German, Middle High (ca. 1050-1500)",
        "goh": "German, Old High (ca. 750-1050)",
        "gon": "Gondi",
        "gor": "Gorontalo",
        "got": "Gothic",
        "grb": "Grebo",
        "grc": "Greek, Ancient (to 1453)",
        "grn": "Guarani",
        "gsw": "Swiss German; Alemannic; Alsatian",
        "guj": "Gujarati",
        "gwi": "Gwich'in",
        "hai": "Haida",
        "hat": "Haitian; Haitian Creole",
        "hau": "Hausa",
        "haw": "Hawaiian",
        "heb": "Hebrew",
        "her": "Herero",
        "hil": "Hiligaynon",
        "him": "Himachali languages; Western Pahari languages",
        "hin": "Hindi",
        "hit": "Hittite",
        "hmn": "Hmong; Mong",
        "hmo": "Hiri Motu",
        "hrv": "Croatian",
        "hsb": "Upper Sorbian",
        "hun": "Hungarian",
        "hup": "Hupa",
        "hye": "Armenian",
        "iba": "Iban",
        "ibo": "Igbo",
        "ido": "Ido",
        "iii": "Sichuan Yi; Nuosu",
        "ijo": "Ijo languages",
        "iku": "Inuktitut",
        "ile": "Interlingue; Occidental",
        "ilo": "Iloko",
        "ina": "Interlingua (International Auxiliary Language Association)",
        "inc": "Indic languages",
        "ind": "Indonesian",
        "ine": "Indo-European languages",
        "inh": "Ingush",
        "ipk": "Inupiaq",
        "ira": "Iranian languages",
        "iro": "Iroquoian languages",
        "isl": "Icelandic",
        "ita": "Italian",
        "jav": "Javanese",
        "jbo": "Lojban",
        "jpn": "Japanese",
        "jpr": "Judeo-Persian",
        "jrb": "Judeo-Arabic",
        "kaa": "Kara-Kalpak",
        "kab": "Kabyle",
        "kac": "Kachin; Jingpho",
        "kal": "Kalaallisut; Greenlandic",
        "kam": "Kamba",
        "kan": "Kannada",
        "kar": "Karen languages",
        "kas": "Kashmiri",
        "kat": "Georgian",
        "kau": "Kanuri",
        "kaw": "Kawi",
        "kaz": "Kazakh",
        "kbd": "Kabardian",
        "kha": "Khasi",
        "khi": "Khoisan languages",
        "khm": "Central Khmer",
        "kho": "Khotanese; Sakan",
        "kik": "Kikuyu; Gikuyu",
        "kin": "Kinyarwanda",
        "kir": "Kirghiz; Kyrgyz",
        "kmb": "Kimbundu",
        "kok": "Konkani",
        "kom": "Komi",
        "kon": "Kongo",
        "kor": "Korean",
        "kos": "Kosraean",
        "kpe": "Kpelle",
        "krc": "Karachay-Balkar",
        "krl": "Karelian",
        "kro": "Kru languages",
        "kru": "Kurukh",
        "kua": "Kuanyama; Kwanyama",
        "kum": "Kumyk",
        "kur": "Kurdish",
        "kut": "Kutenai",
        "lad": "Ladino",
        "lah": "Lahnda",
        "lam": "Lamba",
        "lao": "Lao",
        "lat": "Latin",
        "lav": "Latvian",
        "lez": "Lezghian",
        "lim": "Limburgan; Limburger; Limburgish",
        "lin": "Lingala",
        "lit": "Lithuanian",
        "lol": "Mongo",
        "loz": "Lozi",
        "ltz": "Luxembourgish; Letzeburgesch",
        "lua": "Luba-Lulua",
        "lub": "Luba-Katanga",
        "lug": "Ganda",
        "lui": "Luiseno",
        "lun": "Lunda",
        "luo": "Luo (Kenya and Tanzania)",
        "lus": "Lushai",
        "mad": "Madurese",
        "mag": "Magahi",
        "mah": "Marshallese",
        "mai": "Maithili",
        "mak": "Makasar",
        "mal": "Malayalam",
        "man": "Mandingo",
        "map": "Austronesian languages",
        "mar": "Marathi",
        "mas": "Masai",
        "mdf": "Moksha",
        "mdr": "Mandar",
        "men": "Mende",
        "mga": "Irish, Middle (900-1200)",
        "mic": "Mi'kmaq; Micmac",
        "min": "Minangkabau",
        "mis": "Uncoded languages",
        "mkd": "Macedonian",
        "mkh": "Mon-Khmer languages",
        "mlg": "Malagasy",
        "mlt": "Maltese",
        "mnc": "Manchu",
        "mni": "Manipuri",
        "mno": "Manobo languages",
        "moh": "Mohawk",
        "mon": "Mongolian",
        "mos": "Mossi",
        "mri": "Maori",
        "msa": "Malay",
        "mul": "Multiple languages",
        "mun": "Munda languages",
        "mus": "Creek",
        "mwl": "Mirandese",
        "mwr": "Marwari",
        "mya": "Burmese",
        "myn": "Mayan languages",
        "myv": "Erzya",
        "nah": "Nahuatl languages",
        "nai": "North American Indian languages",
        "nap": "Neapolitan",
        "nau": "Nauru",
        "nav": "Navajo; Navaho",
        "nbl": "South Ndebele",
        "nde": "North Ndebele",
        "ndo": "Ndonga",
        "nds": "Low German; Low Saxon; German, Low; Saxon, Low",
        "nep": "Nepali",
        "new": "Nepal Bhasa; Newar; Newari",
        "nia": "Nias",
        "nic": "Niger-Kordofanian languages",
        "niu": "Niuean",
        "nld": "Dutch; Flemish",
        "nno": "Norwegian Nynorsk",
        "nob": "Norwegian Bokmål",
        "nog": "Nogai",
        "non": "Norse, Old",
        "nor": "Norwegian",
        "nqo": "N'Ko",
        "nso": "Pedi; Sepedi; Northern Sotho",
        "nub": "Nubian languages",
        "nwc": "Classical Newari; Old Newari; Classical Nepal Bhasa",
        "nya": "Chichewa; Chewa; Nyanja",
        "nym": "Nyamwezi",
        "nyn": "Nyankole",
        "nyo": "Nyoro",
        "nzi": "Nzima",
        "oci": "Occitan (post 1500)",
        "oji": "Ojibwa",
        "ori": "Oriya",
        "orm": "Oromo",
        "osa": "Osage",
        "oss": "Ossetian; Ossetic",
        "ota": "Turkish, Ottoman (1500-1928)",
        "oto": "Otomian languages",
        "paa": "Papuan languages",
        "pag": "Pangasinan",
        "pal": "Pahlavi",
        "pam": "Pampanga; Kapampangan",
        "pan": "Panjabi; Punjabi",
        "pap": "Papiamento",
        "pau": "Palauan",
        "peo": "Persian, Old (ca. 600-400 B.C.)",
        "phi": "Philippine languages",
        "phn": "Phoenician",
        "pli": "Pali",
        "pol": "Polish",
        "pon": "Pohnpeian",
        "por": "Portuguese",
        "pra": "Prakrit languages",
        "pro": "Provençal, Old (to 1500); Occitan, Old (to 1500)",
        "pus": "Pushto; Pashto",
        "que": "Quechua",
        "raj": "Rajasthani",
        "rap": "Rapanui",
        "rar": "Rarotongan; Cook Islands Maori",
        "roa": "Romance languages",
        "roh": "Romansh",
        "rom": "Romany",
        "ron": "Romanian; Moldavian; Moldovan",
        "run": "Rundi",
        "rup": "Aromanian; Arumanian; Macedo-Romanian",
        "rus": "Russian",
        "sad": "Sandawe",
        "sag": "Sango",
        "sah": "Yakut",
        "sai": "South American Indian languages",
        "sal": "Salishan languages",
        "sam": "Samaritan Aramaic",
        "san": "Sanskrit",
        "sas": "Sasak",
        "sat": "Santali",
        "scn": "Sicilian",
        "sco": "Scots",
        "sel": "Selkup",
        "sem": "Semitic languages",
        "sga": "Irish, Old (to 900)",
        "sgn": "Sign Languages",
        "shn": "Shan",
        "sid": "Sidamo",
        "sin": "Sinhala; Sinhalese",
        "sio": "Siouan languages",
        "sit": "Sino-Tibetan languages",
        "sla": "Slavic languages",
        "slk": "Slovak",
        "slv": "Slovenian",
        "sma": "Southern Sami",
        "sme": "Northern Sami",
        "smi": "Sami languages",
        "smj": "Lule Sami",
        "smn": "Inari Sami",
        "smo": "Samoan",
        "sms": "Skolt Sami",
        "sna": "Shona",
        "snd": "Sindhi",
        "snk": "Soninke",
        "sog": "Sogdian",
        "som": "Somali",
        "son": "Songhai languages",
        "sot": "Sotho, Southern",
        "spa": "Spanish; Castilian",
        "sqi": "Albanian",
        "srd": "Sardinian",
        "srn": "Sranan Tongo",
        "srp": "Serbian",
        "srr": "Serer",
        "ssa": "Nilo-Saharan languages",
        "ssw": "Swati",
        "suk": "Sukuma",
        "sun": "Sundanese",
        "sus": "Susu",
        "sux": "Sumerian",
        "swa": "Swahili",
        "swe": "Swedish",
        "syc": "Classical Syriac",
        "syr": "Syriac",
        "tah": "Tahitian",
        "tai": "Tai languages",
        "tam": "Tamil",
        "tat": "Tatar",
        "tel": "Telugu",
        "tem": "Timne",
        "ter": "Tereno",
        "tet": "Tetum",
        "tgk": "Tajik",
        "tgl": "Tagalog",
        "tha": "Thai",
        "tig": "Tigre",
        "tir": "Tigrinya",
        "tiv": "Tiv",
        "tkl": "Tokelau",
        "tlh": "Klingon; tlhIngan-Hol",
        "tli": "Tlingit",
        "tmh": "Tamashek",
        "tog": "Tonga (Nyasa)",
        "ton": "Tonga (Tonga Islands)",
        "tpi": "Tok Pisin",
        "tsi": "Tsimshian",
        "tsn": "Tswana",
        "tso": "Tsonga",
        "tuk": "Turkmen",
        "tum": "Tumbuka",
        "tup": "Tupi languages",
        "tur": "Turkish",
        "tut": "Altaic languages",
        "tvl": "Tuvalu",
        "twi": "Twi",
        "tyv": "Tuvinian",
        "udm": "Udmurt",
        "uga": "Ugaritic",
        "uig": "Uighur; Uyghur",
        "ukr": "Ukrainian",
        "umb": "Umbundu",
        "und": "Undetermined",
        "urd": "Urdu",
        "uzb": "Uzbek",
        "vai": "Vai",
        "ven": "Venda",
        "vie": "Vietnamese",
        "vol": "Volapük",
        "vot": "Votic",
        "wak": "Wakashan languages",
        "wal": "Wolaitta; Wolaytta",
        "war": "Waray",
        "was": "Washo",
        "wen": "Sorbian languages",
        "wln": "Walloon",
        "wol": "Wolof",
        "xal": "Kalmyk; Oirat",
        "xho": "Xhosa",
        "yao": "Yao",
        "yap": "Yapese",
        "yid": "Yiddish",
        "yor": "Yoruba",
        "ypk": "Yupik languages",
        "zap": "Zapotec",
        "zbl": "Blissymbols; Blissymbolics; Bliss",
        "zen": "Zenaga",
        "zgh": "Standard Moroccan Tamazight",
        "zha": "Zhuang; Chuang",
        "zho": "Chinese",
        "znd": "Zande languages",
        "zul": "Zulu",
        "zun": "Zuni",
        "zxx": "No linguistic content; Not applicable",
        "zza": "Zaza; Dimili; Dimli; Kirdki; Kirmanjki; Zazaki",
    };

    const MAX_PRIORITY_LANGUAGES = 12;

    /**
     * A personal ISO 639 base code, canonicalized through the shared audio equivalences.
     * Names, regional tags and unknown codes are rejected; und/mul do not name a language.
     * @param {*} value
     * @returns {string|null}
     */
    function priorityCode(value) {
        const code = typeof value === 'string' ? value.trim().toLowerCase() : '';
        return /^[a-z]{2,3}$/.test(code) && priorityIsoCodes.has(code) && !['und', 'mul'].includes(code)
            ? canonicalBase(code) : null;
    }

    /**
     * Normalize a personal list; null follows the server, [] means no priorities.
     * Invalid hand-edited documents fall back to server policy, as native reading does.
     * @param {*} value
     * @returns {string[]|null}
     */
    function priorityList(value) {
        if (!Array.isArray(value) || value.length > MAX_PRIORITY_LANGUAGES) return null;
        const codes = value.map(priorityCode);
        return codes.includes(null) ? null : Array.from(new Set(codes));
    }

    /**
     * Effective personal/server priority policy. Strict inheritance stays nullable on disk.
     * @param {Object} [settings]
     * @param {Object} [plugin]
     * @returns {{terms: string[], personal: boolean, strict: boolean}}
     */
    function priorityPolicy(settings = JE.currentSettings || {}, plugin = JE.pluginConfig || {}) {
        const own = priorityList(settings.languageTagsPriority);
        return {
            terms: own ?? String(plugin.LanguageTagsPriority || '').split(',').map(c => c.trim().toLowerCase()).filter(Boolean),
            personal: own !== null,
            strict: typeof settings.languageTagsPriorityStrict === 'boolean' ? settings.languageTagsPriorityStrict : !!plugin.LanguageTagsPriorityStrict,
        };
    }

    /** @type {Array<{code: string, name: string, aliases: string[]}>|null} Immutable-by-convention session catalog. */
    let priorityChoicesCache = null;

    /**
     * Searchable canonical ISO choices for the hub, with all equivalent input codes.
     * Built once from the bundled ISO names; codes use the shared audio equivalences.
     * @returns {Array<{code: string, name: string, aliases: string[]}>}
     */
    function priorityChoices() {
        if (priorityChoicesCache) return priorityChoicesCache;
        const choices = new Map();
        // Use the bundled ISO names, including every alias name, rather than
        // hundreds of synchronous ICU display-name lookups each time a panel opens.
        for (const raw of priorityIsoCodes) {
            const code = priorityCode(raw);
            if (!code) continue;
            if (!choices.has(code)) choices.set(code, { code, name: code.toUpperCase(), aliases: [] });
            choices.get(code).aliases.push(raw);
        }
        for (const [raw, name] of Object.entries(priorityIsoNames)) {
            const code = priorityCode(raw);
            const choice = choices.get(code);
            if (!choice) continue;
            choice.aliases.push(name);
            // Prefer the canonical language's name over an equivalent variant:
            // Norwegian rather than Nynorsk, Filipino rather than Tagalog.
            if (choice.name === code.toUpperCase() || displayCode(raw).toLowerCase() === code) {
                choice.name = code === 'zxx' ? JE.t('audio_language_no_dialogue') : name.split(';')[0].trim();
            }
        }
        priorityChoicesCache = Array.from(choices.values()).sort((a, b) => a.name.localeCompare(b.name));
        return priorityChoicesCache;
    }

    /**
     * The locale tag text follows: the user's Jellyfin display language (the one JE's strings
     * follow), else JE's display language setting, else the page's; undefined lets Intl use the
     * browser's. statustags.js dateLocale reads the same sources for dates.
     * @returns {string|undefined}
     */
    function uiLocale() {
        let uiLanguage = null;
        try {
            const userId = JE.session?.getUserId?.();
            if (userId) uiLanguage = localStorage.getItem(`${userId}-language`);
        } catch {
            // Storage blocked: fall through to the other sources.
        }
        for (const candidate of [uiLanguage, JE.currentSettings?.displayLanguage, document.documentElement?.getAttribute('lang')]) {
            if (!candidate) continue;
            try {
                if (Intl.NumberFormat.supportedLocalesOf(candidate).length > 0) return candidate;
            } catch {
                // Not a valid language tag; try the next one.
            }
        }
        return undefined;
    }

    /** @type {Map<string, {decimal: string, digits: string[]}>} */
    const numberFormats = new Map();

    /**
     * A score text ("8.1", "81%") with the locale's decimal separator and digits ("8,1" in German,
     * Arabic-Indic digits where the locale uses them). Native posters use the same ICU data
     * (Services/PosterTags/Resolution/ScoreNumbers.cs, scripts/generate_score_numbers.mjs).
     * @param {string} text Text with ASCII digits and an optional full stop.
     * @returns {string}
     */
    function formatNumberText(text) {
        const locale = uiLocale();
        let format = numberFormats.get(locale || '');
        if (!format) {
            const formatter = new Intl.NumberFormat(locale, { useGrouping: false });
            format = { decimal: formatter.formatToParts(1.5).find(p => p.type === 'decimal')?.value || '.', digits: Array.from({ length: 10 }, (_, i) => formatter.format(i)) };
            numberFormats.set(locale || '', format);
        }
        if (format.decimal === '.' && format.digits.join('') === '0123456789') return String(text);
        return String(text).replace(/[0-9.]/g, c => (c === '.' ? format.decimal : format.digits[Number(c)]));
    }

    /** @type {Map<string, string>} */
    const localNames = new Map();

    /**
     * A language's name in the user's language for tooltips and screen readers ("Japonais" in
     * French). Matching and grouping keep the English names (displayName).
     * @param {string} code
     * @returns {string} The name, or '' when the tag has none.
     */
    function localName(code) {
        const locale = uiLocale() || 'en';
        const key = `${locale}|${code}`;
        let name = localNames.get(key);
        if (name === undefined) {
            // A malformed tag (PT_BR) has no name; the caller keeps its own English name.
            try {
                name = parseLanguageTag(code)?.base === 'zxx' ? JE.t('audio_language_no_dialogue')
                    : new Intl.DisplayNames([locale, 'en'], { type: 'language' }).of(code) || '';
            } catch {
                name = '';
            }
            localNames.set(key, name);
        }
        return name;
    }

    /**
     * Whether a stream language names no language a viewer could pick: empty,
     * und (undetermined), root, mul (several), mis (uncoded) or ISO 639-2's
     * local-use range qaa–qtz (DVB's "original version" is qaa), with or
     * without a region. The server's NormalizeStreamLanguage drops the same.
     * @param {string} code
     * @returns {boolean}
     */
    function isLanguageless(code) {
        const base = String(code || '').toLowerCase().split(/[-_]/)[0];
        return !base || ['und', 'root', 'mul', 'mis'].includes(base) || /^q[a-t][a-z]$/.test(base);
    }

    /**
     * A commentary or audio-description audio track is not a dub or the main soundtrack
     * (Helpers/TrackRoles.cs on the server).
     * @param {Object} stream Audio stream.
     * @returns {boolean} True when the track's title names that role.
     */
    function isSecondaryAudio(stream) {
        const text = `${stream?.Title || ''} | ${stream?.DisplayTitle || ''}`;
        // Word stems in English, French, Italian, Dutch, German, Nordic, Spanish, Portuguese, Polish,
        // Czech, Hungarian, Estonian, Finnish, Russian, Ukrainian, Greek, Turkish, Arabic, Hebrew,
        // Japanese, Chinese and Korean, matched inside longer words too ("Audiokommentar", "音声解説").
        return /comment|kommentar|kommentár|kommentaar|comentari|comentári|komentar|komentář|kommentti|комментар|коментар|σχόλι|yorum|تعليق|פרשנות|解説|解说|解說|评论|評論|コメンタリー|코멘터리|해설|audio[ -]?descri|audio[ -]?deskri|description[ -]audio|described[ -]video|descriptive[ -](?:audio|video|track)|visually[ -]impaired|hörfilm|syntolk|synstolk|kuvailutulk|аудиоопис|аудіоопис|sesli betimleme|音声ガイド|口述影像|音频描述|音訊描述/i.test(text)
            || /(?<![A-Za-z0-9])AD(?![A-Za-z0-9])/.test(text);
    }

    JE.core.mediaLanguage = {
        isSecondaryAudio,
        isLanguageless,
        uiLocale,
        formatNumberText,
        localName,
        parseLanguageTag,
        canonicalBase,
        displayCode,
        displayName,
        resolveFlag,
        flagSrc,
        matchesLanguage,
        priorityCode,
        priorityList,
        priorityPolicy,
        priorityChoices,
        MAX_PRIORITY_LANGUAGES,
        baseLanguageFlags,
        specialFlags
    };

    console.log('🪼 Jellyfin Enhanced: Media language core initialized');
 
})(window.JellyfinEnhanced);
