using System;
using System.Collections.Concurrent;
using System.Collections.Frozen;
using System.Collections.Generic;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution
{
    /// <summary>
    /// Port of the web's audio-language flag logic: <c>js/core/media-language.js</c> (tag parsing,
    /// flag resolution, language matching) and the server-cache path of <c>js/tags/languagetags.js</c>
    /// (dedupe, per-flag merge, partial flags, admin priority list, three-flag limit).
    /// </summary>
    internal static class LanguageFlagRules
    {
        /// <summary>The web shows at most this many flags.</summary>
        public const int MaxFlags = 3;

        /// <summary>Flag token of ISO 639-2 "zxx" (no linguistic content); the model calls it "no-dialogue".</summary>
        public const string NoDialogueToken = "zxx";

        /// <summary>Model flag code for <see cref="NoDialogueToken"/>.</summary>
        public const string NoDialogueFlagCode = "no-dialogue";

        // media-language.js baseLanguageFlags: English display names and ISO 639-1/639-2 codes.
        private static readonly FrozenDictionary<string, string> BaseLanguageFlags = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["English"] = "gb", ["eng"] = "gb", ["en"] = "gb", ["Japanese"] = "jp", ["jpn"] = "jp", ["ja"] = "jp", ["Spanish"] = "es", ["spa"] = "es", ["es"] = "es",
            ["French"] = "fr", ["fre"] = "fr", ["fra"] = "fr", ["fr"] = "fr", ["German"] = "de", ["ger"] = "de", ["deu"] = "de", ["de"] = "de",
            ["Italian"] = "it", ["ita"] = "it", ["it"] = "it", ["Korean"] = "kr", ["kor"] = "kr", ["ko"] = "kr", ["Chinese"] = "cn", ["chi"] = "cn", ["zho"] = "cn", ["zh"] = "cn",
            ["Russian"] = "ru", ["rus"] = "ru", ["ru"] = "ru", ["Portuguese"] = "pt", ["por"] = "pt", ["pt"] = "pt", ["Hindi"] = "in", ["hin"] = "in", ["hi"] = "in",
            ["Dutch"] = "nl", ["dut"] = "nl", ["nld"] = "nl", ["nl"] = "nl", ["Arabic"] = "sa", ["ara"] = "sa", ["ar"] = "sa",
            ["Bengali"] = "in", ["ben"] = "in", ["bn"] = "in", ["Czech"] = "cz", ["ces"] = "cz", ["cs"] = "cz", ["Danish"] = "dk", ["dan"] = "dk", ["da"] = "dk",
            ["Greek"] = "gr", ["ell"] = "gr", ["el"] = "gr", ["Finnish"] = "fi", ["fin"] = "fi", ["fi"] = "fi", ["Hebrew"] = "il", ["heb"] = "il", ["he"] = "il",
            ["Hungarian"] = "hu", ["hun"] = "hu", ["hu"] = "hu", ["Indonesian"] = "id", ["ind"] = "id", ["id"] = "id",
            ["Norwegian"] = "no", ["nor"] = "no", ["no"] = "no", ["Polish"] = "pl", ["pol"] = "pl", ["pl"] = "pl",
            // Bokmål and Nynorsk share Norway's flag; Cantonese, Swiss German and Irish their region's.
            ["Norwegian Bokmål"] = "no", ["nob"] = "no", ["nb"] = "no", ["Norwegian Nynorsk"] = "no", ["nno"] = "no", ["nn"] = "no",
            ["Cantonese"] = "hk", ["yue"] = "hk", ["Swiss German"] = "ch", ["gsw"] = "ch", ["Irish"] = "ie", ["gle"] = "ie", ["ga"] = "ie",
            ["Persian"] = "ir", ["per"] = "ir", ["fas"] = "ir", ["fa"] = "ir", ["Romanian"] = "ro", ["ron"] = "ro", ["rum"] = "ro", ["ro"] = "ro",
            ["Swedish"] = "se", ["swe"] = "se", ["sv"] = "se", ["Thai"] = "th", ["tha"] = "th", ["th"] = "th", ["Turkish"] = "tr", ["tur"] = "tr", ["tr"] = "tr",
            ["Ukrainian"] = "ua", ["ukr"] = "ua", ["uk"] = "ua", ["Vietnamese"] = "vn", ["vie"] = "vn", ["vi"] = "vn",
            ["Malay"] = "my", ["msa"] = "my", ["may"] = "my", ["ms"] = "my", ["Swahili"] = "ke", ["swa"] = "ke", ["sw"] = "ke",
            ["Bosnian"] = "ba", ["bos"] = "ba", ["bs"] = "ba", ["Khmer"] = "kh", ["khm"] = "kh", ["km"] = "kh", ["Lao"] = "la", ["lao"] = "la", ["lo"] = "la",
            ["Burmese"] = "mm", ["mya"] = "mm", ["bur"] = "mm", ["my"] = "mm", ["Luxembourgish"] = "lu", ["ltz"] = "lu", ["lb"] = "lu",
            ["Tagalog"] = "ph", ["tgl"] = "ph", ["tl"] = "ph", ["Filipino"] = "ph", ["fil"] = "ph", ["Tamil"] = "in", ["tam"] = "in", ["ta"] = "in",
            ["Telugu"] = "in", ["tel"] = "in", ["te"] = "in", ["Marathi"] = "in", ["mar"] = "in", ["mr"] = "in", ["Punjabi"] = "in", ["pan"] = "in", ["pa"] = "in",
            ["Urdu"] = "pk", ["urd"] = "pk", ["ur"] = "pk", ["Gujarati"] = "in", ["guj"] = "in", ["gu"] = "in", ["Kannada"] = "in", ["kan"] = "in", ["kn"] = "in",
            ["Malayalam"] = "in", ["mal"] = "in", ["ml"] = "in", ["Sinhala"] = "lk", ["sin"] = "lk", ["si"] = "lk", ["Nepali"] = "np", ["nep"] = "np", ["ne"] = "np",
            ["Pashto"] = "af", ["pus"] = "af", ["ps"] = "af", ["Kurdish"] = "iq", ["kur"] = "iq", ["ku"] = "iq", ["Slovak"] = "sk", ["slk"] = "sk", ["sk"] = "sk",
            ["Slovenian"] = "si", ["slv"] = "si", ["sl"] = "si", ["Serbian"] = "rs", ["srp"] = "rs", ["sr"] = "rs", ["Croatian"] = "hr", ["hrv"] = "hr", ["hr"] = "hr",
            ["Bulgarian"] = "bg", ["bul"] = "bg", ["bg"] = "bg", ["Macedonian"] = "mk", ["mkd"] = "mk", ["mk"] = "mk", ["Albanian"] = "al", ["sqi"] = "al", ["sq"] = "al",
            ["Estonian"] = "ee", ["est"] = "ee", ["et"] = "ee", ["Latvian"] = "lv", ["lav"] = "lv", ["lv"] = "lv", ["Lithuanian"] = "lt", ["lit"] = "lt", ["lt"] = "lt",
            ["Icelandic"] = "is", ["isl"] = "is", ["is"] = "is", ["Georgian"] = "ge", ["kat"] = "ge", ["ka"] = "ge", ["Armenian"] = "am", ["hye"] = "am", ["hy"] = "am",
            ["Mongolian"] = "mn", ["mon"] = "mn", ["mn"] = "mn", ["Kazakh"] = "kz", ["kaz"] = "kz", ["kk"] = "kz", ["Uzbek"] = "uz", ["uzb"] = "uz", ["uz"] = "uz",
            ["Azerbaijani"] = "az", ["aze"] = "az", ["az"] = "az", ["Belarusian"] = "by", ["bel"] = "by", ["be"] = "by",
            ["Amharic"] = "et", ["amh"] = "et", ["am"] = "et", ["Zulu"] = "za", ["zul"] = "za", ["zu"] = "za", ["Afrikaans"] = "za", ["afr"] = "za", ["af"] = "za",
            ["Hausa"] = "ng", ["hau"] = "ng", ["ha"] = "ng", ["Yoruba"] = "ng", ["yor"] = "ng", ["yo"] = "ng", ["Igbo"] = "ng", ["ibo"] = "ng", ["ig"] = "ng",
            ["Brazilian"] = "br", ["bra"] = "br",
            ["Catalan"] = "es-ct", ["cat"] = "es-ct", ["ca"] = "es-ct", ["Galician"] = "es-ga", ["glg"] = "es-ga", ["gl"] = "es-ga",
            ["Basque"] = "es-pv", ["eus"] = "es-pv", ["baq"] = "es-pv", ["eu"] = "es-pv",
            ["zxx"] = NoDialogueToken, ["No linguistic content"] = NoDialogueToken, ["Not applicable"] = NoDialogueToken,
        }.ToFrozenDictionary(StringComparer.Ordinal);

        // media-language.js aliasTags / regionAliases / regionOverridesByBase / scriptFlagsByBase.
        private static readonly FrozenDictionary<string, (string Base, string Region)> AliasTags = new Dictionary<string, (string, string)>(StringComparer.Ordinal)
        {
            ["pob"] = ("pt", "br"),
            ["pb"] = ("pt", "br"),
        }.ToFrozenDictionary(StringComparer.Ordinal);

        private static readonly FrozenDictionary<string, FrozenDictionary<string, string>> RegionOverridesByBase = BuildRegionOverrides();

        private static readonly FrozenSet<string> ValidRegions = ("ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bl bm bn bo bq br bs bt bv bw by bz " +
            "ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg eh er es et fi fj fk fm fo fr " +
            "ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp " +
            "ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz " +
            "na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw " +
            "sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz " +
            "ua ug um us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw").Split(' ').ToFrozenSet(StringComparer.Ordinal);

        // media-language.js iso6392To6391 (consulted before Intl canonicalization).
        private static readonly FrozenDictionary<string, string> Iso6392To6391 = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["aar"] = "aa", ["abk"] = "ab", ["afr"] = "af", ["aka"] = "ak", ["alb"] = "sq", ["amh"] = "am", ["ara"] = "ar", ["arg"] = "an",
            ["arm"] = "hy", ["asm"] = "as", ["ava"] = "av", ["ave"] = "ae", ["aym"] = "ay", ["aze"] = "az", ["bak"] = "ba", ["bam"] = "bm",
            ["baq"] = "eu", ["bel"] = "be", ["ben"] = "bn", ["bis"] = "bi", ["bod"] = "bo", ["bos"] = "bs", ["bre"] = "br", ["bul"] = "bg",
            ["bur"] = "my", ["cat"] = "ca", ["ces"] = "cs", ["cha"] = "ch", ["che"] = "ce", ["chi"] = "zh", ["chu"] = "cu", ["chv"] = "cv",
            ["cor"] = "kw", ["cos"] = "co", ["cre"] = "cr", ["cym"] = "cy", ["cze"] = "cs", ["dan"] = "da", ["deu"] = "de", ["div"] = "dv",
            ["dut"] = "nl", ["dzo"] = "dz", ["ell"] = "el", ["eng"] = "en", ["epo"] = "eo", ["est"] = "et", ["eus"] = "eu", ["ewe"] = "ee",
            ["fao"] = "fo", ["fas"] = "fa", ["fij"] = "fj", ["fin"] = "fi", ["fra"] = "fr", ["fre"] = "fr", ["fry"] = "fy", ["ful"] = "ff",
            ["geo"] = "ka", ["ger"] = "de", ["gla"] = "gd", ["gle"] = "ga", ["glg"] = "gl", ["glv"] = "gv", ["gre"] = "el", ["grn"] = "gn",
            ["guj"] = "gu", ["hat"] = "ht", ["hau"] = "ha", ["heb"] = "he", ["her"] = "hz", ["hin"] = "hi", ["hmo"] = "ho", ["hrv"] = "hr",
            ["hun"] = "hu", ["hye"] = "hy", ["ibo"] = "ig", ["ice"] = "is", ["ido"] = "io", ["iii"] = "ii", ["iku"] = "iu", ["ile"] = "ie",
            ["ina"] = "ia", ["ind"] = "id", ["ipk"] = "ik", ["isl"] = "is", ["ita"] = "it", ["jav"] = "jv", ["jpn"] = "ja", ["kal"] = "kl",
            ["kan"] = "kn", ["kas"] = "ks", ["kat"] = "ka", ["kau"] = "kr", ["kaz"] = "kk", ["khm"] = "km", ["kik"] = "ki", ["kin"] = "rw",
            ["kir"] = "ky", ["kom"] = "kv", ["kon"] = "kg", ["kor"] = "ko", ["kua"] = "kj", ["kur"] = "ku", ["lao"] = "lo", ["lat"] = "la",
            ["lav"] = "lv", ["lim"] = "li", ["lin"] = "ln", ["lit"] = "lt", ["ltz"] = "lb", ["lub"] = "lu", ["lug"] = "lg", ["mac"] = "mk",
            ["mah"] = "mh", ["mal"] = "ml", ["mao"] = "mi", ["mar"] = "mr", ["may"] = "ms", ["mkd"] = "mk", ["mlg"] = "mg", ["mlt"] = "mt",
            ["mon"] = "mn", ["mri"] = "mi", ["msa"] = "ms", ["mya"] = "my", ["nau"] = "na", ["nav"] = "nv", ["nbl"] = "nr", ["nde"] = "nd",
            ["ndo"] = "ng", ["nep"] = "ne", ["nld"] = "nl", ["nno"] = "nn", ["nob"] = "nb", ["nor"] = "no", ["nya"] = "ny", ["oci"] = "oc",
            ["oji"] = "oj", ["ori"] = "or", ["orm"] = "om", ["oss"] = "os", ["pan"] = "pa", ["per"] = "fa", ["pli"] = "pi", ["pol"] = "pl",
            ["por"] = "pt", ["pus"] = "ps", ["que"] = "qu", ["roh"] = "rm", ["ron"] = "ro", ["rum"] = "ro", ["run"] = "rn", ["rus"] = "ru",
            ["sag"] = "sg", ["san"] = "sa", ["sin"] = "si", ["slk"] = "sk", ["slo"] = "sk", ["slv"] = "sl", ["sme"] = "se", ["smo"] = "sm",
            ["sna"] = "sn", ["snd"] = "sd", ["som"] = "so", ["sot"] = "st", ["spa"] = "es", ["sqi"] = "sq", ["srd"] = "sc", ["srp"] = "sr",
            ["ssw"] = "ss", ["sun"] = "su", ["swa"] = "sw", ["swe"] = "sv", ["tah"] = "ty", ["tam"] = "ta", ["tat"] = "tt", ["tel"] = "te",
            ["tgk"] = "tg", ["tgl"] = "tl", ["tha"] = "th", ["tib"] = "bo", ["tir"] = "ti", ["ton"] = "to", ["tsn"] = "tn", ["tso"] = "ts",
            ["tuk"] = "tk", ["tur"] = "tr", ["twi"] = "tw", ["uig"] = "ug", ["ukr"] = "uk", ["urd"] = "ur", ["uzb"] = "uz", ["ven"] = "ve",
            ["vie"] = "vi", ["vol"] = "vo", ["wel"] = "cy", ["wln"] = "wa", ["wol"] = "wo", ["xho"] = "xh", ["yid"] = "yi", ["yor"] = "yo",
            ["zha"] = "za", ["zho"] = "zh", ["zul"] = "zu",
        }.ToFrozenDictionary(StringComparer.Ordinal);

        /// <summary>A parsed language tag. <see cref="Base"/> is null for the web's prototype-key quirk (see <see cref="Parse"/>).</summary>
        internal readonly record struct ParsedTag(string? Base, string? Region, string? Script);

        /// <summary>One resolved flag before the model mapping.</summary>
        internal sealed class FlagInfo
        {
            public FlagInfo(string countryCode, string code, string name, bool partial)
            {
                CountryCode = countryCode;
                Code = code;
                Partial = partial;
                AllLanguages = new List<string>(2) { name };
                AllCodes = new List<string>(2) { code };
            }

            public string CountryCode { get; }

            public string Code { get; }

            /// <summary>The grouping key: the country, or <c>code:</c> and the language identity for a code chip.</summary>
            public string Key { get; init; } = string.Empty;

            /// <summary>Drawn as a code chip: Codes style, or a language without a flag in Flags style.</summary>
            public bool AsCode { get; init; }

            public bool Partial { get; set; }

            public List<string> AllLanguages { get; }

            /// <summary>Every language code that resolved to this flag (web <c>allCodes</c>), first one in <see cref="Code"/>.</summary>
            public List<string> AllCodes { get; }

            /// <summary>
            /// True for the web quirk where a language code or name equal to an Object.prototype key
            /// ("constructor", "__proto__") resolves to a non-string "flag"; rendering it throws.
            /// </summary>
            public bool IsBroken => CountryCode.Length > 0 && CountryCode[0] == '\0';
        }

        /// <summary>
        /// media-language.js parseLanguageTag. Returns false when the web returns null.
        /// </summary>
        internal static bool Parse(string? raw, out ParsedTag tag)
        {
            tag = default;
            if (raw is null) return false;
            var normalized = JsText.ToLower(JsText.Trim(raw)).Replace('_', '-');
            if (normalized.Length == 0) return false;

            if (AliasTags.TryGetValue(normalized, out var alias))
            {
                tag = new ParsedTag(alias.Base, alias.Region, null);
                return true;
            }

            // aliasTags is a plain object: a lowercased tag equal to an Object.prototype key finds a
            // truthy inherited member, and the web proceeds with an undefined base and region.
            if (JsText.ObjectPrototypeKeys.Contains(normalized))
            {
                tag = new ParsedTag(null, null, null);
                return true;
            }

            var subtags = normalized.Split('-');
            var baseCode = subtags[0];
            if (baseCode.Length is < 2 or > 3 || !IsLowerAlpha(baseCode)) return false;

            string? region = null;
            string? script = null;
            for (var i = 1; i < subtags.Length; i++)
            {
                var subtag = subtags[i];
                if (subtag.Length == 1) break;
                if (subtag.Length == 2 && IsLowerAlpha(subtag) && region is null) region = subtag;
                else if (subtag.Length == 3 && IsDigits(subtag) && region is null) region = subtag;
                else if (subtag.Length == 4 && IsLowerAlpha(subtag) && script is null) script = subtag;
            }

            tag = new ParsedTag(baseCode, region, script);
            return true;
        }

        /// <summary>
        /// media-language.js resolveFlag({ name, code }). Returns null when the web returns null; a
        /// broken token (leading NUL) for the Object.prototype quirk.
        /// </summary>
        internal static string? ResolveFlag(string code, string name, bool mergeRegions = false)
        {
            if (Parse(code, out var parsed))
            {
                string? baseFlag = null;
                // The code itself, else its canonical language (ISO 639-2/B "gre" is "el"): the flag never depends on a
                // display name, which follows the viewer's language.
                if (parsed.Base is not null && !BaseLanguageFlags.TryGetValue(parsed.Base, out baseFlag)
                    && CanonicalBase(parsed.Base) is { } canonical) BaseLanguageFlags.TryGetValue(canonical, out baseFlag);
                if (mergeRegions && baseFlag is not null) return baseFlag;
                if (baseFlag == NoDialogueToken) return baseFlag;
                if (parsed.Region is not null && baseFlag is not null)
                {
                    string? region = parsed.Region;
                    if (parsed.Base is not null && RegionOverridesByBase.TryGetValue(parsed.Base, out var overrides) && overrides.TryGetValue(region, out var overridden))
                    {
                        region = overridden;
                    }
                    else if (region == "uk")
                    {
                        region = "gb";
                    }
                    else if (region.Length == 3 && IsDigits(region))
                    {
                        region = null;
                    }

                    if (region is not null && ValidRegions.Contains(region))
                    {
                        if (baseFlag == region || baseFlag.StartsWith(region + "-", StringComparison.Ordinal)) return baseFlag;
                        return region;
                    }
                }

                if (parsed.Script is not null && parsed.Base is "zh" or "zho" or "chi")
                {
                    if (parsed.Script == "hant") return "tw";
                    if (parsed.Script == "hans") return "cn";
                }

                if (baseFlag is not null) return baseFlag;
            }

            return LookupName(name) ?? LookupName(code);
        }

        /// <summary>
        /// media-language.js matchesLanguage(stream, preferred, { requireRegion }).
        /// </summary>
        internal static bool MatchesLanguage(string? streamLanguage, string? preferred, bool requireRegion)
        {
            if (!Parse(streamLanguage, out var stream) || !Parse(preferred, out var wanted)) return false;
            if (!string.Equals(CanonicalBase(stream.Base), CanonicalBase(wanted.Base), StringComparison.Ordinal)) return false;
            if (wanted.Region is null) return true;
            var streamRegion = stream.Region is null ? null : (stream.Region == "uk" ? "gb" : stream.Region);
            var wantedRegion = wanted.Region == "uk" ? "gb" : wanted.Region;
            if (requireRegion) return streamRegion == wantedRegion;
            return streamRegion is null || streamRegion == wantedRegion;
        }

        /// <summary>
        /// The server-cache path of languagetags.js: AudioLanguages (+ PartialAudioLanguages) to at
        /// most <paramref name="cap"/> flags (the layout's language cap, three by default; 0 = all)
        /// in display order. Null when the web renders no language container (nothing resolved, or
        /// the web would throw while building it).
        /// </summary>
        internal static List<FlagInfo>? Resolve(string?[]? codes, string?[]? partialCodes, IReadOnlyList<string> priorityTerms, bool strict, bool mergeRegions = false, int cap = MaxFlags, bool codesStyle = false, bool validateFlags = true, bool canonicalPriority = false)
        {
            if (codes is null || codes.Length == 0) return null;

            // renderFromServerCache: name from Intl, upper-cased code when Intl throws. A null code
            // throws in the fallback (null.toUpperCase()) and aborts the whole container.
            foreach (var code in codes)
            {
                if (code is null) return null;
            }

            // normalizeLanguages: drop empty codes, dedupe by lowercased code|name.
            HashSet<string>? seen = null;
            var flags = new List<FlagInfo>(MaxFlags + 1);
            foreach (var code in codes)
            {
                if (code!.Length == 0) continue;
                var info = Describe(code);
                var flag = mergeRegions ? info.MergedFlag : info.Flag;
                if (codes.Length > 1 && !(seen ??= new HashSet<string>(StringComparer.Ordinal)).Add(info.DedupeKey)) continue;

                var partial = partialCodes is not null && Array.IndexOf(partialCodes, code) >= 0;
                var name = info.Name;
                var countryCode = flag;
                // A language without a flag keeps a code chip in Flags style rather than vanishing.
                var asCode = codesStyle || countryCode is null;
                if (asCode && ShortCode(code).Length == 0) continue;
                var key = asCode ? "code:" + CodeIdentity(code, mergeRegions) : countryCode!;
                var existing = flags.Find(f => f.Key == key);
                if (existing is null)
                {
                    flags.Add(new FlagInfo(countryCode ?? string.Empty, code, name, partial) { Key = key, AsCode = asCode });
                }
                else
                {
                    if (!existing.AllCodes.Contains(code)) existing.AllCodes.Add(code);
                    if (!existing.AllLanguages.Contains(name)) existing.AllLanguages.Add(name);
                    existing.Partial = existing.Partial && partial;
                }
            }

            // Full-series flags first (stable), then the admin priority list, then the limit.
            var ordered = flags.Where(f => !f.Partial).Concat(flags.Where(f => f.Partial)).ToList();
            ordered = OrderByPriority(ordered, priorityTerms, strict, canonicalPriority);
            if (cap > 0 && ordered.Count > cap) ordered.RemoveRange(cap, ordered.Count - cap);

            // A visible broken token throws (countryCode.toLowerCase is not a function): no container.
            if (validateFlags && !codesStyle && ordered.Exists(f => f.IsBroken)) return null;
            return ordered.Count == 0 ? null : ordered;
        }

        /// <summary>ISO 639-1 code, or the original three-letter fallback, independent of audio equivalence.</summary>
        internal static string ShortCode(string code) => Parse(code, out var parsed) && parsed.Base is not null
            ? JsText.ToUpper(Iso6392To6391.GetValueOrDefault(parsed.Base, parsed.Base)) : string.Empty;

        /// <summary>Codes retain explicit regional/script variants unless the administrator merges them.</summary>
        private static string CodeIdentity(string code, bool mergeRegions)
        {
            Parse(code, out var parsed);
            return CanonicalBase(parsed.Base) + (mergeRegions ? string.Empty : ":" + (parsed.Region ?? parsed.Script ?? string.Empty));
        }

        /// <summary>Known canonical ISO codes for the language colour editor (no translated strings).</summary>
        internal static IReadOnlyList<(string Key, string Name)> StyleLabels => BaseLanguageFlags.Keys
            .Where(k => k.Length is 2 or 3 && k.All(c => c is >= 'a' and <= 'z'))
            .Select(CanonicalBase).OfType<string>().Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal)
            .Select(code => (code, code.ToUpperInvariant())).ToArray();

        /// <summary>Language chips in the combined cap order: badge, audio, subtitles.</summary>
        internal static List<PosterTag>? ResolveGroup(Model.TagCacheEntry entry, PosterTagSettings settings)
        {
            bool codes = settings.LanguageStyle == "codes";
            List<FlagInfo>? ResolveTracks(string[]? tracks, string[]? partial, bool asCodes) => Resolve(
                tracks, partial, settings.LanguagePriorityTerms, settings.LanguagePriorityStrict,
                settings.LanguageMergeRegions, cap: 0, codesStyle: asCodes, validateFlags: false, canonicalPriority: settings.LanguagePriorityIsPersonal);
            var audio = settings.LanguageShowAudio ? ResolveTracks(entry.AudioLanguages, entry.PartialAudioLanguages, codes) : null;
            var subtitles = settings.LanguageShowSubtitles ? ResolveTracks(entry.SubtitleLanguages, null, codes) : null;
            var count = settings.LanguageShowAudio && settings.LanguageCountBadge != "off"
                ? ResolveTracks(entry.AudioLanguages, entry.PartialAudioLanguages, true)?.Select(f => { Parse(f.Code, out var parsed); return CanonicalBase(parsed.Base); }).Where(c => c != "zxx").Distinct().Count() ?? 0 : 0;
            bool badge = settings.LanguageCountBadge != "off" && count >= 2;
            var tags = new List<PosterTag>();
            // The style key stays Dual/Multi; the text is the shared vocabulary in the user's language.
            if (badge) tags.Add(new LanguageTag(string.Empty, string.Empty, false)
            {
                CountBadge = count == 2 ? "Dual" : "Multi",
                CountBadgeText = StatusRules.Text(count == 2 ? "language_tags_dual" : "language_tags_multi", settings.StatusCulture),
            });
            void Add(List<FlagInfo>? flags, bool subtitle)
            {
                foreach (var flag in flags ?? new List<FlagInfo>())
                {
                    tags.Add(new LanguageTag(ToFlagCode(flag.CountryCode), string.Join(", ", flag.AllLanguages), flag.Partial)
                    { Subtitle = subtitle, Sdh = subtitle && flag.AllCodes.Any(code => (entry.SdhSubtitleLanguages ?? Array.Empty<string>()).Any(sdh => MatchesLanguage(code, sdh, requireRegion: true))), Code = codes || flag.AsCode ? ShortCode(flag.Code) : null, StyleLabel = codes || subtitle || flag.AsCode ? ShortCode(flag.Code).ToLowerInvariant() : null });
                }
            }
            if (!badge || settings.LanguageCountBadge != "only") Add(audio, false);
            Add(subtitles, true);
            if (settings.LanguageCap > 0 && tags.Count > settings.LanguageCap) tags.RemoveRange(settings.LanguageCap, tags.Count - settings.LanguageCap);
            if (!codes && tags.OfType<LanguageTag>().Any(t => t.FlagCode.StartsWith("\0", StringComparison.Ordinal))) return null;
            return tags.Count > 0 ? tags : null;
        }

        /// <summary>
        /// Name, dedupe key and flag of one code. Everything here depends on the code alone, so it
        /// is memoized (libraries carry a few hundred distinct codes; the memo stops growing at
        /// <see cref="MaxMemoEntries"/>).
        /// </summary>
        private static CodeInfo Describe(string code)
        {
            if (Memo.TryGetValue(code, out var cached)) return cached;
            var name = LanguageNames.Of(code) ?? JsText.ToUpper(code);
            var info = new CodeInfo(name, JsText.ToLower(code) + "|" + JsText.ToLower(name), ResolveFlag(code, name), ResolveFlag(code, name, mergeRegions: true));
            if (Memo.Count < MaxMemoEntries) Memo.TryAdd(code, info);
            return info;
        }

        private const int MaxMemoEntries = 4096;

        private static readonly ConcurrentDictionary<string, CodeInfo> Memo = new(StringComparer.Ordinal);

        private sealed record CodeInfo(string Name, string DedupeKey, string? Flag, string? MergedFlag);

        /// <summary>The model flag code for a resolved country code.</summary>
        internal static string ToFlagCode(string countryCode) => countryCode == NoDialogueToken ? NoDialogueFlagCode : countryCode;

        /// <summary>languagetags.js getPriorityTerms over the admin LanguageTagsPriority string.</summary>
        internal static IReadOnlyList<string> ParsePriorityTerms(string? raw)
        {
            if (string.IsNullOrEmpty(raw)) return Array.Empty<string>();
            var terms = new List<string>();
            foreach (var part in raw.Split(','))
            {
                var term = JsText.ToLower(JsText.Trim(part));
                if (term.Length > 0) terms.Add(term);
            }

            return terms;
        }

        /// <summary>
        /// languagetags.js orderByPriority. A personal (canonical) list matches the canonical base of any
        /// of the flag's codes. A server term matches a flag by exact code, base code or display name, or
        /// when <see cref="MatchesLanguage"/> accepts any of the flag's codes for it: "en" matches "eng",
        /// "en-US" and "en-GB", and "pt-BR" still matches a bare "pt" (#993).
        /// </summary>
        private static List<FlagInfo> OrderByPriority(List<FlagInfo> flags, IReadOnlyList<string> priority, bool strict, bool canonicalPriority)
        {
            if (priority.Count == 0) return flags;

            int Rank(FlagInfo flag)
            {
                if (canonicalPriority)
                {
                    var rank = -1;
                    foreach (var raw in flag.AllCodes)
                    {
                        if (Parse(raw, out var parsed) && CanonicalBase(parsed.Base) is { } canonical)
                            rank = Best(rank, IndexOf(priority, canonical));
                    }
                    return rank;
                }
                var code = JsText.ToLower(flag.Code);
                var dash = code.IndexOf('-');
                var baseCode = dash < 0 ? code : code.Substring(0, dash);
                var best = -1;
                for (var idx = 0; idx < priority.Count; idx++)
                {
                    if (best != -1 && idx >= best) break;
                    var term = priority[idx];
                    if (string.Equals(term, code, StringComparison.Ordinal) || string.Equals(term, baseCode, StringComparison.Ordinal))
                    {
                        best = idx;
                        continue;
                    }

                    foreach (var name in flag.AllLanguages)
                    {
                        if (string.Equals(term, JsText.ToLower(name), StringComparison.Ordinal))
                        {
                            best = idx;
                            break;
                        }
                    }

                    if (best == idx) continue;
                    foreach (var flagCode in flag.AllCodes)
                    {
                        if (MatchesLanguage(flagCode, term, requireRegion: false))
                        {
                            best = idx;
                            break;
                        }
                    }
                }

                return best;
            }

            var ranked = new List<(FlagInfo Flag, int Index, int Rank)>(flags.Count);
            for (var i = 0; i < flags.Count; i++)
            {
                var rank = Rank(flags[i]);
                if (strict && rank == -1) continue;
                ranked.Add((flags[i], i, rank == -1 ? priority.Count : rank));
            }

            return ranked.OrderBy(r => r.Rank).ThenBy(r => r.Index).Select(r => r.Flag).ToList();
        }

        private static int Best(int best, int index) => index != -1 && (best == -1 || index < best) ? index : best;

        private static int IndexOf(IReadOnlyList<string> list, string value)
        {
            for (var i = 0; i < list.Count; i++)
            {
                if (string.Equals(list[i], value, StringComparison.Ordinal)) return i;
            }

            return -1;
        }

        /// <summary>media-language.js canonicalBase (undefined base stays undefined).</summary>
        internal static string? CanonicalBase(string? baseCode)
        {
            if (baseCode is null) return null;
            if (baseCode is "tl" or "tgl") return "fil";
            if (baseCode is "nb" or "nob" or "nn" or "nno") return "no";
            return Iso6392To6391.TryGetValue(baseCode, out var mapped) ? mapped : LanguageNames.CanonicalLanguage(baseCode);
        }

        /// <summary>baseLanguageFlags[key] as a JS property read, including inherited Object.prototype members.</summary>
        private static string? LookupName(string key)
        {
            if (BaseLanguageFlags.TryGetValue(key, out var flag)) return flag;
            // Inherited members are distinct objects per key; "\0" marks the token as unrenderable.
            return JsText.ObjectPrototypeKeys.Contains(key) ? "\0" + key : null;
        }

        private static FrozenDictionary<string, FrozenDictionary<string, string>> BuildRegionOverrides()
        {
            var latinAmericaSpanish = new Dictionary<string, string>(StringComparer.Ordinal) { ["la"] = "mx", ["419"] = "mx" }.ToFrozenDictionary(StringComparer.Ordinal);
            var latinAmericaPortuguese = new Dictionary<string, string>(StringComparer.Ordinal) { ["la"] = "br", ["419"] = "br" }.ToFrozenDictionary(StringComparer.Ordinal);
            return new Dictionary<string, FrozenDictionary<string, string>>(StringComparer.Ordinal)
            {
                ["es"] = latinAmericaSpanish,
                ["spa"] = latinAmericaSpanish,
                ["pt"] = latinAmericaPortuguese,
                ["por"] = latinAmericaPortuguese,
            }.ToFrozenDictionary(StringComparer.Ordinal);
        }

        private static bool IsLowerAlpha(string value)
        {
            foreach (var c in value)
            {
                if (c < 'a' || c > 'z') return false;
            }

            return true;
        }

        private static bool IsDigits(string value)
        {
            foreach (var c in value)
            {
                if (c < '0' || c > '9') return false;
            }

            return true;
        }
    }
}
