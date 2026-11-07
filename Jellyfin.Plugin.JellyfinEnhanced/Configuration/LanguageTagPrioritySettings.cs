using System;
using System.Collections.Frozen;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>Validates personal language priorities without copying the administrator's live policy.</summary>
    public static class LanguageTagPriority
    {
        /// <summary>Maximum number of posted language entries, before equivalence deduplication.</summary>
        public const int MaxEntries = 12;

        // Assigned ISO 639-1/639-2 codes, including bibliographic spellings (iso-codes 639-2 registry).
        // Canonical forms are read through the existing audio-equivalence tables.
        private static readonly FrozenSet<string> Codes = (
            "aa aar ab abk ace ach ada ady ae af afa afh afr ain ak aka akk alb ale alg alt am amh an ang anp apa ar ara arc arg arm arn arp art arw as asm ast ath aus av ava ave awa ay aym az aze ba bad bai bak bal bam ban baq bas bat be bej bel bem ben ber bg bho bi bih bik bin bis bla bm bn bnt bo bod bos br bra bre bs btk bua bug bul bur byn ca cad cai car cat cau ce ceb cel ces ch cha chb che chg chi chk chm chn cho chp chr chu chv chy cmc cnr co cop cor cos cpe cpf cpp cr cre crh crp cs csb cu cus cv cy cym cze da dak dan dar day de del den deu dgr din div doi dra dsb dua dum dut dv dyu dz dzo ee efi egy eka el ell elx en eng enm eo epo es est et eu eus ewe ewo fa fan fao fas fat ff fi fij fil fin fiu fj fo fon fr fra fre frm fro frr frs fry ful fur fy ga gaa gay gba gd gem geo ger gez gil gl gla gle glg glv gmh gn goh gon gor got grb grc gre grn gsw gu guj gv gwi ha hai hat hau haw he heb her hi hil him hin hit hmn hmo ho hr hrv hsb ht hu hun hup hy hye hz ia iba ibo ice id ido ie ig ii iii ijo ik iku ile ilo ina inc ind ine inh io ipk ira iro is isl it ita iu ja jav jbo jpn jpr jrb jv ka kaa kab kac kal kam kan kar kas kat kau kaw kaz kbd kg kha khi khm kho ki kik kin kir kj kk kl km kmb kn ko kok kom kon kor kos kpe kr krc krl kro kru ks ku kua kum kur kut kv kw ky la lad lah lam lao lat lav lb lez lg li lim lin lit ln lo lol loz lt ltz lu lua lub lug lui lun luo lus lv mac mad mag mah mai mak mal man mao map mar mas may mdf mdr men mg mga mh mi mic min mis mk mkd mkh ml mlg mlt mn mnc mni mno moh mon mos mr mri ms msa mt mul mun mus mwl mwr my mya myn myv na nah nai nap nau nav nb nbl nd nde ndo nds ne nep new ng nia nic niu nl nld nn nno no nob nog non nor nqo nr nso nub nv nwc ny nya nym nyn nyo nzi oc oci oj oji om or ori orm os osa oss ota oto pa paa pag pal pam pan pap pau peo per phi phn pi pl pli pol pon por pra pro ps pt pus qu que raj rap rar rm rn ro roa roh rom ron ru rum run rup rus rw sa sad sag sah sai sal sam san sas sat sc scn sco sd se sel sem sg sga sgn shn si sid sin sio sit sk sl sla slk slo slv sm sma sme smi smj smn smo sms sn sna snd snk so sog som son sot spa sq sqi sr srd srn srp srr ss ssa ssw st su suk sun sus sux sv sw swa swe syc syr ta tah tai tam tat te tel tem ter tet tg tgk tgl th tha ti tib tig tir tiv tk tkl tl tlh tli tmh tn to tog ton tpi tr ts tsi tsn tso tt tuk tum tup tur tut tvl tw twi ty tyv udm ug uga uig uk ukr umb und ur urd uz uzb vai ve ven vi vie vo vol vot wa wak wal war was wel wen wln wo wol xal xh xho yao yap yi yid yo yor ypk za zap zbl zen zgh zh zha zho znd zu zul zun zxx zza").Split(' ').ToFrozenSet(StringComparer.Ordinal);

        /// <summary>Canonical audio-equivalent base, or null for a name, region, unknown or non-ISO code.</summary>
        public static string? NormalizeCode(string? value)
        {
            var code = value?.Trim().ToLowerInvariant();
            if (code is null || code.Length is < 2 or > 3 || code.Any(c => c is < 'a' or > 'z')) return null;
            if (!Codes.Contains(code)) return null;
            // und/mul describe unspecified/multiple languages rather than a selectable language.
            if (code is "und" or "mul") return null;
            return LanguageFlagRules.CanonicalBase(code);
        }

        /// <summary>Validate all entries before saving; reject invalid/oversized lists without changing the document.</summary>
        public static bool TryNormalize(string[]? entries, out string[]? normalized)
        {
            normalized = null;
            if (entries is null) return true;
            if (entries.Length > MaxEntries) return false;
            var values = new List<string>(entries.Length);
            foreach (var entry in entries)
            {
                var code = NormalizeCode(entry);
                if (code is null) return false;
                if (!values.Contains(code, StringComparer.Ordinal)) values.Add(code);
            }
            normalized = values.ToArray();
            return true;
        }
    }
}
