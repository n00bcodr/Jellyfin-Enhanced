/// <reference lib="es2021.intl" />
export interface LanguageSettings {
    languageTagsPriority?: unknown;
    languageTagsPriorityStrict?: unknown;
    displayLanguage?: unknown;
}
export interface LanguageConfig {
    LanguageTagsPriority?: unknown;
    LanguageTagsPriorityStrict?: unknown;
    LanguageTagsMergeRegions?: unknown;
}
export interface AudioRole {
    Role?: unknown;
    Title?: unknown;
    DisplayTitle?: unknown;
}
export type LanguageInput = string | {
    code?: string;
    Code?: string;
    name?: string;
    Name?: string;
} | null | undefined;
export interface PriorityChoice {
    code: string;
    name: string;
    aliases: string[];
}
export interface LanguageHost {
    translate(key: string): string;
    flagSvg(code: string): string;
    localeCandidates(): unknown[];
    settings(): LanguageSettings;
    config(): LanguageConfig;
}
export const baseLanguageFlags: Readonly<Record<string, string>> = {
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
    Maori: 'nz', 'Māori': 'nz', mao: 'nz', mri: 'nz', mi: 'nz',
    'Egyptian Arabic': 'eg', arz: 'eg', 'Central Kurdish': 'iq', ckb: 'iq',
    // ISO 639-2 `zxx` = "no linguistic content": silent films, and films
    // with a score/sound design but no dialogue. Not a country, so it
    // resolves to a synthetic token rendered from `specialFlags` below
    // rather than to a flag-icons code.
    zxx: 'zxx', 'No linguistic content': 'zxx', 'Not applicable': 'zxx'
};
export const specialFlags: Readonly<Record<string, string>> = {
    // Crossed-out speech bubble: "no dialogue". Deliberately not a flag,
    // because no country is being claimed.
    zxx: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480">' +
        '<rect width="640" height="480" fill="#3d4552"/>' +
        '<path d="M150 130H490A40 40 0 0 1 530 170V300A40 40 0 0 1 490 340H300L210 420V340H150A40 40 0 0 1 110 300V170A40 40 0 0 1 150 130Z" fill="#fff"/>' +
        '<path d="M140 380L500 100" stroke="#e5484d" stroke-width="52" stroke-linecap="round"/>' +
        '</svg>')
};
export const aliasTags: Readonly<Record<string, {
    base: string;
    region: string;
}>> = {
    pob: { base: 'pt', region: 'br' },
    pb: { base: 'pt', region: 'br' }
};
export const regionAliases: Readonly<Record<string, string>> = { uk: 'gb' };
export const regionOverridesByBase: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    es: { la: 'mx', '419': 'mx' },
    spa: { la: 'mx', '419': 'mx' },
    pt: { la: 'br', '419': 'br' },
    por: { la: 'br', '419': 'br' }
};
export const chineseScriptFlags: Readonly<Record<string, string>> = { hant: 'tw', hans: 'cn' };
export const scriptFlagsByBase: Readonly<Record<string, Readonly<Record<string, string>>>> = { zh: chineseScriptFlags, zho: chineseScriptFlags, chi: chineseScriptFlags };
export const validRegions = new Set(('ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bl bm bn bo bq br bs bt bv bw by bz ' +
    'ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg eh er es et fi fj fk fm fo fr ' +
    'ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ' +
    'ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz ' +
    'na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw ' +
    'sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ' +
    'ua ug um us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw').split(' '));
export function parseLanguageTag(raw: unknown) {
    if (!raw || typeof raw !== 'string')
        return null;
    const normalized = raw.trim().toLowerCase().replace(/_/g, '-');
    if (!normalized)
        return null;
    const alias = lookup(aliasTags, normalized);
    if (alias)
        return { base: alias.base, region: alias.region, script: null };
    const subtags = normalized.split('-');
    const base = subtags[0] || '';
    // Base must look like an ISO 639 code; anything else (display names,
    // junk) is not parseable as a tag and is handled by the name map.
    if (!/^[a-z]{2,3}$/.test(base))
        return null;
    let region: string | null = null;
    let script: string | null = null;
    for (const subtag of subtags.slice(1)) {
        // A single-letter subtag starts a BCP-47 extension or private-use
        // section (en-u-ca-gregory, en-x-us); nothing after it is a
        // region or script, so stop scanning entirely.
        if (subtag.length === 1)
            break;
        if (/^[a-z]{2}$/.test(subtag) && !region) {
            region = subtag; // ISO 3166-1 alpha-2 region (br, mx, us…)
        }
        else if (/^\d{3}$/.test(subtag) && !region) {
            region = subtag; // UN M.49 numeric region (419…)
        }
        else if (/^[a-z]{4}$/.test(subtag) && !script) {
            script = subtag; // ISO 15924 script (hant, hans…)
        }
    }
    return { base, region, script };
}
export function resolveFlag(lang: LanguageInput, mergeRegions = false) {
    const code = typeof lang === 'string' ? lang : (lang && (lang.code || lang.Code)) || '';
    const name = (typeof lang === 'object' && lang && (lang.name || lang.Name)) || '';
    const parsed = parseLanguageTag(code);
    if (parsed) {
        // The code itself, else its canonical language (ISO 639-2/B "gre" is "el"): the flag never depends
        // on a display name, which follows the viewer's language.
        // A BCP 47 extended language subtag names the language itself (zh-yue is Cantonese).
        const extlang = /^[a-z]{2,3}[-_]([a-z]{3})(?![a-z])/i.exec(code.trim())?.[1]?.toLowerCase();
        const baseFlag = (extlang && Object.prototype.hasOwnProperty.call(baseLanguageFlags, extlang) ? lookup(baseLanguageFlags, extlang) : null)
            || lookup(baseLanguageFlags, parsed.base) || lookup(baseLanguageFlags, canonicalBase(parsed.base)) || null;
        if (mergeRegions && baseFlag)
            return baseFlag;
        // A synthetic token is not a country and cannot be refined by a
        // region or script: `zxx-US` still means "no dialogue", not US.
        if (baseFlag && lookup(specialFlags, baseFlag))
            return baseFlag;
        // A region only refines a language we know (pt-BR). For an
        // unmapped base ('und-419', 'eo-FR') the region alone proves
        // nothing about the audio language — stay flagless, exactly as
        // the pre-region behavior did.
        if (parsed.region && baseFlag) {
            let region: string | null = parsed.region;
            const overrides = lookup(regionOverridesByBase, parsed.base);
            if (overrides && overrides[region]) {
                region = overrides[region] || region;
            }
            else if (lookup(regionAliases, region)) {
                region = lookup(regionAliases, region) || region;
            }
            else if (/^\d{3}$/.test(region)) {
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
        const scripts = lookup(scriptFlagsByBase, parsed.base) || lookup(scriptFlagsByBase, canonicalBase(parsed.base));
        if (parsed.script && scripts && scripts[parsed.script])
            return scripts[parsed.script];
        if (baseFlag)
            return baseFlag;
    }
    // Name lookup last: catches English display names ("Portuguese") and
    // legacy cache entries whose code was already stripped.
    return lookup(baseLanguageFlags, name) || lookup(baseLanguageFlags, code) || null;
}
export const iso6392To6391: Readonly<Record<string, string>> = {
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
export function displayCode(code: string) {
    const base = parseLanguageTag(code)?.base;
    return base ? (lookup(iso6392To6391, base) || base).toUpperCase() : '';
}
export const canonicalBaseCache = new Map<string, string>();
export function canonicalBase(base: string) {
    // Audio equivalence is broader than ISO display identity.
    if (['tl', 'tgl'].includes(base))
        return 'fil';
    if (['nb', 'nob', 'nn', 'nno'].includes(base))
        return 'no';
    if (lookup(iso6392To6391, base))
        return lookup(iso6392To6391, base) || base;
    const memo = canonicalBaseCache.get(base);
    if (memo !== undefined)
        return memo;
    let canonical = base;
    if (typeof Intl !== 'undefined' && typeof Intl.getCanonicalLocales === 'function') {
        try {
            const locale = Intl.getCanonicalLocales(base)[0];
            if (locale)
                canonical = (locale.split('-')[0] || base).toLowerCase();
        }
        catch (e) { /* not a well-formed tag — keep the raw base */ }
    }
    canonicalBaseCache.set(base, canonical);
    return canonical;
}
export function matchesLanguage(streamLanguage: unknown, preferred: unknown, options: {
    requireRegion?: boolean;
} = {}) {
    const stream = parseLanguageTag(streamLanguage);
    const wanted = parseLanguageTag(preferred);
    if (!stream || !wanted)
        return false;
    if (canonicalBase(stream.base) !== canonicalBase(wanted.base))
        return false;
    if (!wanted.region)
        return true;
    const streamRegion = stream.region && (lookup(regionAliases, stream.region) || stream.region);
    const wantedRegion = lookup(regionAliases, wanted.region) || wanted.region;
    if (options.requireRegion)
        return streamRegion === wantedRegion;
    return !streamRegion || streamRegion === wantedRegion;
}
export const priorityIsoCodes = new Set(("aa aar ab abk ace ach ada ady ae af afa afh afr ain ak aka akk alb ale alg alt am amh an ang anp apa ar ara arc arg arm arn arp art arw as asm ast ath aus av ava ave awa ay aym az aze ba bad bai bak bal bam ban baq bas bat be bej bel bem ben ber bg bho bi bih bik bin bis bla bm bn bnt bo bod bos br bra bre bs btk bua bug bul bur byn ca cad cai car cat cau ce ceb cel ces ch cha chb che chg chi chk chm chn cho chp chr chu chv chy cmc cnr co cop cor cos cpe cpf cpp cr cre crh crp cs csb cu cus cv cy cym cze da dak dan dar day de del den deu dgr din div doi dra dsb dua dum dut dv dyu dz dzo ee efi egy eka el ell elx en eng enm eo epo es est et eu eus ewe ewo fa fan fao fas fat ff fi fij fil fin fiu fj fo fon fr fra fre frm fro frr frs fry ful fur fy ga gaa gay gba gd gem geo ger gez gil gl gla gle glg glv gmh gn goh gon gor got grb grc gre grn gsw gu guj gv gwi ha hai hat hau haw he heb her hi hil him hin hit hmn hmo ho hr hrv hsb ht hu hun hup hy hye hz ia iba ibo ice id ido ie ig ii iii ijo ik iku ile ilo ina inc ind ine inh io ipk ira iro is isl it ita iu ja jav jbo jpn jpr jrb jv ka kaa kab kac kal kam kan kar kas kat kau kaw kaz kbd kg kha khi khm kho ki kik kin kir kj kk kl km kmb kn ko kok kom kon kor kos kpe kr krc krl kro kru ks ku kua kum kur kut kv kw ky la lad lah lam lao lat lav lb lez lg li lim lin lit ln lo lol loz lt ltz lu lua lub lug lui lun luo lus lv mac mad mag mah mai mak mal man mao map mar mas may mdf mdr men mg mga mh mi mic min mis mk mkd mkh ml mlg mlt mn mnc mni mno moh mon mos mr mri ms msa mt mul mun mus mwl mwr my mya myn myv na nah nai nap nau nav nb nbl nd nde ndo nds ne nep new ng nia nic niu nl nld nn nno no nob nog non nor nqo nr nso nub nv nwc ny nya nym nyn nyo nzi oc oci oj oji om or ori orm os osa oss ota oto pa paa pag pal pam pan pap pau peo per phi phn pi pl pli pol pon por pra pro ps pt pus qu que raj rap rar rm rn ro roa roh rom ron ru rum run rup rus rw sa sad sag sah sai sal sam san sas sat sc scn sco sd se sel sem sg sga sgn shn si sid sin sio sit sk sl sla slk slo slv sm sma sme smi smj smn smo sms sn sna snd snk so sog som son sot spa sq sqi sr srd srn srp srr ss ssa ssw st su suk sun sus sux sv sw swa swe syc syr ta tah tai tam tat te tel tem ter tet tg tgk tgl th tha ti tib tig tir tiv tk tkl tl tlh tli tmh tn to tog ton tpi tr ts tsi tsn tso tt tuk tum tup tur tut tvl tw twi ty tyv udm ug uga uig uk ukr umb und ur urd uz uzb vai ve ven vi vie vo vol vot wa wak wal war was wel wen wln wo wol xal xh xho yao yap yi yid yo yor ypk za zap zbl zen zgh zh zha zho znd zu zul zun zxx zza").split(' '));
export const priorityIsoNames: Readonly<Record<string, string>> = {
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
export const MAX_PRIORITY_LANGUAGES = 12;
export function priorityCode(value: unknown) {
    const code = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return /^[a-z]{2,3}$/.test(code) && priorityIsoCodes.has(code) && !['und', 'mul'].includes(code)
        ? canonicalBase(code) : null;
}
export function priorityList(value: unknown) {
    if (!Array.isArray(value) || value.length > MAX_PRIORITY_LANGUAGES)
        return null;
    const codes = value.map(priorityCode);
    return codes.includes(null) ? null : Array.from(new Set(codes.filter((code): code is string => code !== null)));
}
export function priorityPolicy(settings: LanguageSettings = {}, plugin: LanguageConfig = {}) {
    const own = priorityList(settings.languageTagsPriority);
    return {
        terms: own ?? String(plugin.LanguageTagsPriority || '').split(',').map(c => c.trim().toLowerCase()).filter(Boolean),
        personal: own !== null,
        strict: typeof settings.languageTagsPriorityStrict === 'boolean' ? settings.languageTagsPriorityStrict : !!plugin.LanguageTagsPriorityStrict,
    };
}
export function isLanguageless(code: unknown) {
    const base = String(code || '').toLowerCase().split(/[-_]/)[0];
    return !base || ['und', 'root', 'mul', 'mis'].includes(base) || /^q[a-t][a-z]$/.test(base);
}
export function isSecondaryAudio(stream: AudioRole | null | undefined) {
    if (stream?.Role === 'secondary')
        return true;
    const text = `${stream?.Title || ''} | ${stream?.DisplayTitle || ''}`;
    // Word stems in English, French, Italian, Dutch, German, Nordic, Spanish, Portuguese, Polish,
    // Czech, Hungarian, Estonian, Finnish, Russian, Ukrainian, Greek, Turkish, Arabic, Hebrew,
    // Japanese, Chinese and Korean, matched inside longer words too ("Audiokommentar", "音声解説").
    return /comment|kommentar|kommentár|kommentaar|comentari|comentári|komentar|komentář|kommentti|комментар|коментар|σχόλι|yorum|تعليق|פרשנות|解説|解说|解說|评论|評論|コメンタリー|코멘터리|해설|audio[ -]?descri|audio[ -]?deskri|description[ -]audio|described[ -]video|descriptive[ -](?:audio|video|track)|visually[ -]impaired|hörfilm|syntolk|synstolk|kuvailutulk|аудиоопис|аудіоопис|sesli betimleme|音声ガイド|口述影像|音频描述|音訊描述/i.test(text)
        || /(?<![A-Za-z0-9])AD(?![A-Za-z0-9])/.test(text);
}
export function createMediaLanguage(host: LanguageHost) {
    function flagSrc(flagCode: string) {
        return lookup(specialFlags, flagCode) || host.flagSvg(flagCode);
    }
    function displayName(code: string) {
        if (parseLanguageTag(code)?.base === 'zxx')
            return host.translate('audio_language_no_dialogue');
        return new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
    }
    let priorityChoicesCache: PriorityChoice[] | null = null;
    function priorityChoices() {
        if (priorityChoicesCache)
            return priorityChoicesCache;
        const choices = new Map<string, PriorityChoice>();
        // Use the bundled ISO names, including every alias name, rather than
        // hundreds of synchronous ICU display-name lookups each time a panel opens.
        for (const raw of priorityIsoCodes) {
            const code = priorityCode(raw);
            if (!code)
                continue;
            if (!choices.has(code))
                choices.set(code, { code, name: code.toUpperCase(), aliases: [] });
            choices.get(code)?.aliases.push(raw);
        }
        for (const [raw, name] of Object.entries(priorityIsoNames)) {
            const code = priorityCode(raw);
            const choice = code ? choices.get(code) : undefined;
            if (!choice || !code)
                continue;
            choice.aliases.push(name);
            // Prefer the canonical language's name over an equivalent variant:
            // Norwegian rather than Nynorsk, Filipino rather than Tagalog.
            if (choice.name === code.toUpperCase() || displayCode(raw).toLowerCase() === code) {
                choice.name = code === 'zxx' ? host.translate('audio_language_no_dialogue') : (name.split(';')[0] || name).trim();
            }
        }
        priorityChoicesCache = Array.from(choices.values()).sort((a, b) => a.name.localeCompare(b.name));
        return priorityChoicesCache;
    }
    function uiLocale(): string | undefined {
        for (const candidate of host.localeCandidates()) {
            if (typeof candidate !== 'string' || !candidate)
                continue;
            try {
                if (Intl.NumberFormat.supportedLocalesOf(candidate).length)
                    return candidate;
            }
            catch { /* Try the next source. */ }
        }
        return undefined;
    }
    const numberFormats = new Map<string, {
        decimal: string;
        digits: string[];
    }>();
    function formatNumberText(text: string) {
        const locale = uiLocale();
        let format = numberFormats.get(locale || '');
        if (!format) {
            const formatter = new Intl.NumberFormat(locale, { useGrouping: false });
            format = { decimal: formatter.formatToParts(1.5).find(p => p.type === 'decimal')?.value || '.', digits: Array.from({ length: 10 }, (_, i) => formatter.format(i)) };
            numberFormats.set(locale || '', format);
        }
        if (format.decimal === '.' && format.digits.join('') === '0123456789')
            return String(text);
        return String(text).replace(/[0-9.]/g, c => (c === '.' ? format.decimal : format.digits[Number(c)] || c));
    }
    const localNames = new Map<string, string>();
    function localName(code: string) {
        const locale = uiLocale() || 'en';
        const key = `${locale}|${code}`;
        let name = localNames.get(key);
        if (name === undefined) {
            // A malformed tag (PT_BR) has no name; the caller keeps its own English name.
            try {
                name = parseLanguageTag(code)?.base === 'zxx' ? host.translate('audio_language_no_dialogue')
                    : new Intl.DisplayNames([locale, 'en'], { type: 'language' }).of(code) || '';
            }
            catch {
                name = '';
            }
            localNames.set(key, name);
        }
        return name;
    }
    return {
        isSecondaryAudio,
        isLanguageless,
        uiLocale,
        formatNumberText,
        localName,
        parseLanguageTag,
        canonicalBase,
        displayCode,
        displayName,
        resolveFlag: (lang: LanguageInput) => resolveFlag(lang, !!host.config().LanguageTagsMergeRegions),
        flagSrc,
        matchesLanguage,
        priorityCode,
        priorityList,
        priorityPolicy: (settings = host.settings(), plugin = host.config()) => priorityPolicy(settings, plugin),
        priorityChoices,
        MAX_PRIORITY_LANGUAGES,
        baseLanguageFlags,
        specialFlags
    };
}
export type MediaLanguage = ReturnType<typeof createMediaLanguage>;
function lookup<T>(table: Readonly<Record<string, T>>, key: string): T | undefined { return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined; }
