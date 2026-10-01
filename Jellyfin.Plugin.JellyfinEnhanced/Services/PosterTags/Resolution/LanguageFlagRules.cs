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
            ["Persian"] = "ir", ["per"] = "ir", ["fas"] = "ir", ["fa"] = "ir", ["Romanian"] = "ro", ["ron"] = "ro", ["rum"] = "ro", ["ro"] = "ro",
            ["Swedish"] = "se", ["swe"] = "se", ["sv"] = "se", ["Thai"] = "th", ["tha"] = "th", ["th"] = "th", ["Turkish"] = "tr", ["tur"] = "tr", ["tr"] = "tr",
            ["Ukrainian"] = "ua", ["ukr"] = "ua", ["uk"] = "ua", ["Vietnamese"] = "vn", ["vie"] = "vn", ["vi"] = "vn",
            ["Malay"] = "my", ["msa"] = "my", ["may"] = "my", ["ms"] = "my", ["Swahili"] = "ke", ["swa"] = "ke", ["sw"] = "ke",
            ["Tagalog"] = "ph", ["tgl"] = "ph", ["tl"] = "ph", ["Filipino"] = "ph", ["Tamil"] = "in", ["tam"] = "in", ["ta"] = "in",
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
            ["eng"] = "en", ["jpn"] = "ja", ["spa"] = "es", ["fre"] = "fr", ["fra"] = "fr", ["ger"] = "de", ["deu"] = "de", ["ita"] = "it", ["kor"] = "ko",
            ["chi"] = "zh", ["zho"] = "zh", ["rus"] = "ru", ["por"] = "pt", ["hin"] = "hi", ["dut"] = "nl", ["nld"] = "nl", ["ara"] = "ar", ["ben"] = "bn",
            ["cze"] = "cs", ["ces"] = "cs", ["dan"] = "da", ["gre"] = "el", ["ell"] = "el", ["fin"] = "fi", ["heb"] = "he", ["hun"] = "hu", ["ind"] = "id", ["nor"] = "no", ["pol"] = "pl",
            ["per"] = "fa", ["fas"] = "fa", ["ron"] = "ro", ["rum"] = "ro", ["swe"] = "sv", ["tha"] = "th", ["tur"] = "tr", ["ukr"] = "uk", ["vie"] = "vi",
            ["msa"] = "ms", ["may"] = "ms", ["swa"] = "sw", ["tam"] = "ta", ["tel"] = "te", ["mar"] = "mr", ["pan"] = "pa", ["urd"] = "ur", ["guj"] = "gu",
            ["kan"] = "kn", ["mal"] = "ml", ["sin"] = "si", ["nep"] = "ne", ["pus"] = "ps", ["kur"] = "ku", ["slo"] = "sk", ["slk"] = "sk", ["slv"] = "sl", ["srp"] = "sr",
            ["hrv"] = "hr", ["bul"] = "bg", ["mac"] = "mk", ["mkd"] = "mk", ["alb"] = "sq", ["sqi"] = "sq", ["est"] = "et", ["lav"] = "lv", ["lit"] = "lt", ["ice"] = "is", ["isl"] = "is",
            ["geo"] = "ka", ["kat"] = "ka", ["arm"] = "hy", ["hye"] = "hy", ["mon"] = "mn", ["kaz"] = "kk", ["uzb"] = "uz", ["aze"] = "az", ["bel"] = "be", ["amh"] = "am", ["zul"] = "zu", ["afr"] = "af",
            ["hau"] = "ha", ["yor"] = "yo", ["ibo"] = "ig", ["cat"] = "ca", ["glg"] = "gl", ["eus"] = "eu", ["baq"] = "eu",
            ["bur"] = "my", ["mya"] = "my", ["wel"] = "cy", ["cym"] = "cy", ["tib"] = "bo", ["bod"] = "bo", ["mao"] = "mi", ["mri"] = "mi",
            ["tgl"] = "fil", ["tl"] = "fil",
            ["nob"] = "no", ["nb"] = "no", ["nno"] = "no", ["nn"] = "no",
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
            }

            public string CountryCode { get; }

            public string Code { get; }

            public bool Partial { get; set; }

            public List<string> AllLanguages { get; }

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
        internal static string? ResolveFlag(string code, string name)
        {
            if (Parse(code, out var parsed))
            {
                string? baseFlag = null;
                if (parsed.Base is not null) BaseLanguageFlags.TryGetValue(parsed.Base, out baseFlag);
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
        /// most three flags in display order. Null when the web renders no language container
        /// (nothing resolved, or the web would throw while building it).
        /// </summary>
        internal static List<FlagInfo>? Resolve(string?[]? codes, string?[]? partialCodes, IReadOnlyList<string> priorityTerms, bool strict)
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
                if (codes.Length > 1 && !(seen ??= new HashSet<string>(StringComparer.Ordinal)).Add(info.DedupeKey)) continue;

                var partial = partialCodes is not null && Array.IndexOf(partialCodes, code) >= 0;
                var name = info.Name;
                var countryCode = info.Flag;
                if (countryCode is null) continue;
                var existing = flags.Find(f => f.CountryCode == countryCode);
                if (existing is null)
                {
                    flags.Add(new FlagInfo(countryCode, code, name, partial));
                }
                else if (!existing.AllLanguages.Contains(name))
                {
                    existing.AllLanguages.Add(name);
                    existing.Partial = existing.Partial && partial;
                }
            }

            // Full-series flags first (stable), then the admin priority list, then the limit.
            var ordered = flags.Where(f => !f.Partial).Concat(flags.Where(f => f.Partial)).ToList();
            ordered = OrderByPriority(ordered, priorityTerms, strict);
            if (ordered.Count > MaxFlags) ordered.RemoveRange(MaxFlags, ordered.Count - MaxFlags);

            // A visible broken token throws (countryCode.toLowerCase is not a function): no container.
            if (ordered.Exists(f => f.IsBroken)) return null;
            return ordered.Count == 0 ? null : ordered;
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
            var info = new CodeInfo(name, JsText.ToLower(code) + "|" + JsText.ToLower(name), ResolveFlag(code, name));
            if (Memo.Count < MaxMemoEntries) Memo.TryAdd(code, info);
            return info;
        }

        private const int MaxMemoEntries = 4096;

        private static readonly ConcurrentDictionary<string, CodeInfo> Memo = new(StringComparer.Ordinal);

        private sealed record CodeInfo(string Name, string DedupeKey, string? Flag);

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

        private static List<FlagInfo> OrderByPriority(List<FlagInfo> flags, IReadOnlyList<string> priority, bool strict)
        {
            if (priority.Count == 0) return flags;

            int Rank(FlagInfo flag)
            {
                var code = JsText.ToLower(flag.Code);
                var dash = code.IndexOf('-');
                var baseCode = dash < 0 ? code : code.Substring(0, dash);
                var best = Best(-1, IndexOf(priority, code));
                best = Best(best, IndexOf(priority, baseCode));
                foreach (var name in flag.AllLanguages)
                {
                    best = Best(best, IndexOf(priority, JsText.ToLower(name)));
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
        private static string? CanonicalBase(string? baseCode)
        {
            if (baseCode is null) return null;
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
