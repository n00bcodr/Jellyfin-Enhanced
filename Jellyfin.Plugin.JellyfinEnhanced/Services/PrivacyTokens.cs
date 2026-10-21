using System;
using System.Collections.Frozen;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>
/// The closed formats a protected item's retained values are checked against (see <see cref="PrivacyValues"/>). The
/// token lists are the hosts' own: the names jellyfin-ffmpeg's ffprobe reports on Jellyfin 12.2 and 10.11.11 (union of
/// <c>ffprobe -codecs</c>, <c>-pix_fmts</c>, <c>-layouts</c> and <c>-formats</c>), plus the short names Jellyfin itself stores
/// (containers such as mkv, external subtitle extensions). A value outside them is not a token the host produced, so it
/// leaves a protected item. Regenerate the lists from a new host's ffprobe when its ffmpeg changes.
/// </summary>
internal static partial class PrivacyTokens
{
    private static FrozenSet<string> Set(string words) => words.Split(' ', StringSplitOptions.RemoveEmptyEntries).ToFrozenSet(StringComparer.OrdinalIgnoreCase);

    /// <summary>ffprobe codec names, and the subtitle/codec names Jellyfin stores for external files.</summary>
    private static readonly FrozenSet<string> _codecs = Set(
        "012v 4gv 4xm 8bps 8svx_exp 8svx_fib a64_multi a64_multi5 aac aac_latm aasc ac3 ac4 acelp.kelvin adpcm_4xm adpcm_adx adpcm_afc adpcm_agm adpcm_aica "
        + "adpcm_argo adpcm_circus adpcm_ct adpcm_dtk adpcm_ea adpcm_ea_maxis_xa adpcm_ea_r1 adpcm_ea_r2 adpcm_ea_r3 adpcm_ea_xas adpcm_g722 adpcm_g726 "
        + "adpcm_g726le adpcm_ima_acorn adpcm_ima_alp adpcm_ima_amv adpcm_ima_apc adpcm_ima_apm adpcm_ima_cunning adpcm_ima_dat4 adpcm_ima_dk3 adpcm_ima_dk4 "
        + "adpcm_ima_ea_eacs adpcm_ima_ea_sead adpcm_ima_escape adpcm_ima_hvqm2 adpcm_ima_hvqm4 adpcm_ima_iss adpcm_ima_magix adpcm_ima_moflex adpcm_ima_mtf "
        + "adpcm_ima_oki adpcm_ima_pda adpcm_ima_qt adpcm_ima_rad adpcm_ima_smjpeg adpcm_ima_ssi adpcm_ima_wav adpcm_ima_ws adpcm_ima_xbox adpcm_ms adpcm_mtaf "
        + "adpcm_n64 adpcm_psx adpcm_psxc adpcm_sanyo adpcm_sbpro_2 adpcm_sbpro_3 adpcm_sbpro_4 adpcm_swf adpcm_thp adpcm_thp_le adpcm_vima adpcm_xa adpcm_xmd "
        + "adpcm_yamaha adpcm_zork agm ahx aic alac alias_pix amr_nb amr_wb amv anm ansi anull apac ape apng aptx aptx_hd apv arbc argo arib_caption ass asv1 "
        + "asv2 atrac1 atrac3 atrac3al atrac3p atrac3pal atrac9 aura aura2 av1 avc avrn avrp avs avs2 avs3 avui bethsoftvid bfi bin_data binkaudio_dct "
        + "binkaudio_rdft binkvideo bintext bitpacked bmp bmv_audio bmv_video bonk brender_pix c93 cavs cbd2_dpcm cdgraphics cdtoons cdxl celt cfhd cinepak "
        + "clearvideo cljr cllc cmv codec2 comfortnoise cook cpia cri cscd cyuv daala dds derf_dpcm dfa dfpwm dirac dnxhd dnxuc dolby_e dpx dsd_lsbf "
        + "dsd_lsbf_planar dsd_msbf dsd_msbf_planar dsicinaudio dsicinvideo dss_sp dst dts dvaudio dvb_subtitle dvb_teletext dvd_nav_packet dvd_subtitle dvvideo "
        + "dxa dxtory dxv eac3 eia_608 epg escape124 escape130 evc evrc exr fastaudio ffv1 ffvhuff fic fits flac flashsv flashsv2 flic flv1 fmvc fraps frwu ftr "
        + "g2m g723_1 g728 g729 gdv gem gif gremlin_dpcm gsm gsm_ms h261 h263 h263i h263p h264 hap hca hcom hdmv_pgs_subtitle hdmv_text_subtitle hdr hevc "
        + "hnm4video hq_hqa hqx huffyuv hymt iac idcin idf iff_ilbm ilbc imc imm4 imm5 indeo2 indeo3 indeo4 indeo5 interplay_dpcm interplayacm interplayvideo ipu "
        + "ivtv_vbi jacosub jpeg2000 jpegls jpegxl jpegxl_anim jpegxs jv kgv1 klv kmvc lagarith lc3 lcevc lead ljpeg loco lscr m101 mace3 mace6 mad magicyuv mdec "
        + "media100 metasound microdvd mimic misc4 mjpeg mjpegb mlp mmvideo mobiclip motionpixels mov_text mp1 mp2 mp3 mp3adu mp3on4 mp4als mpeg1video mpeg2video "
        + "mpeg4 mpegh_3d_audio mpegts mpl2 msa1 mscc msmpeg4v1 msmpeg4v2 msmpeg4v3 msnsiren msp2 msrle mss1 mss2 msvideo1 mszh mts2 musepack7 musepack8 mv30 "
        + "mvc1 mvc2 mvdv mvha mwsc mxpeg nellymoser notchlc nuv opus osq otf paf_audio paf_video pam pbm pcm_alaw pcm_bluray pcm_dvd pcm_f16le pcm_f24le "
        + "pcm_f32be pcm_f32le pcm_f64be pcm_f64le pcm_lxf pcm_mulaw pcm_s16be pcm_s16be_planar pcm_s16le pcm_s16le_planar pcm_s24be pcm_s24daud pcm_s24le "
        + "pcm_s24le_planar pcm_s32be pcm_s32le pcm_s32le_planar pcm_s64be pcm_s64le pcm_s8 pcm_s8_planar pcm_sga pcm_u16be pcm_u16le pcm_u24be pcm_u24le "
        + "pcm_u32be pcm_u32le pcm_u8 pcm_vidc pcx pdv pfm pgm pgmyuv pgx phm photocd pictor pixlet pjs png ppm prores prores_raw prosumer psd ptx qcelp qdm2 "
        + "qdmc qdraw qoa qoi qpeg qtrle r10k r210 ra_144 ra_288 ralf rasc rawvideo realtext rka rl2 roq roq_dpcm rpza rscc rtv1 rv10 rv20 rv30 rv40 rv60 s302m "
        + "sami sanm sbc scpr screenpresso scte_35 sdx2_dpcm sga sgi sgirle sheervideo shorten simbiosis_imx sipr siren smackaudio smackvideo smc smpte_2038 "
        + "smpte_436m_anc smv smvjpeg snow sol_dpcm sonic sonicls sp5x speedhq speex srgc srt ssa stl subrip subviewer subviewer1 sunrast svg svq1 svq3 tak targa "
        + "targa_y216 tdsc text tgq tgv theora thp tiertexseqvideo tiff timed_id3 tmv tqi truehd truemotion1 truemotion2 truemotion2rt truespeech tscc tscc2 tta "
        + "ttf ttml twinvq txd ulti utvideo v210 v210x v308 v408 v410 vb vble vbn vc1 vc1image vcr1 vixl vmdaudio vmdvideo vmix vmnc vnull vorbis vp3 vp4 vp5 vp6 "
        + "vp6a vp6f vp7 vp8 vp9 vplayer vqc vvc wady_dpcm wavarc wavesynth wavpack wbmp wcmv webp webvtt westwood_snd1 wmalossless wmapro wmav1 wmav2 wmavoice "
        + "wmv1 wmv2 wmv3 wmv3image wnv1 wrapped_avframe ws_vqa xan_dpcm xan_wc3 xan_wc4 xbin xbm xface xma1 xma2 xpm xsub xwd y41p ylc yop yuv4 zerocodec zlib "
        + "zmbv "
        + " srt sub smi sami vtt ssa idx sup pgs pgssub dvdsub dvbsub ttf otf ");

    /// <summary>Codec profile names (libavcodec's profile tables, as Jellyfin stores them).</summary>
    private static readonly FrozenSet<string> _profiles = new[]
    {
        "Main", "LC", "SSR", "LTP", "HE-AAC", "HE-AACv2", "LD", "ELD", "xHE-AAC", "Main 10", "Main 12", "Main Still Picture", "Rext", "SCC", "Multiview Main",
        "Main 4:4:4", "Main 4:4:4 10", "Main 10 4:4:4", "Baseline", "Constrained Baseline", "Extended", "High", "High 10", "High 10 Intra", "High 4:2:2", "High 4:2:2 Intra",
        "High 4:4:4", "High 4:4:4 Predictive", "High 4:4:4 Intra", "CAVLC 4:4:4", "CAVLC 4:4:4 Intra", "Multiview High", "Stereo High", "Professional",
        "Profile 0", "Profile 1", "Profile 2", "Profile 3", "Simple", "Complex", "Advanced", "422", "4:2:2", "Spatially Scalable", "SNR Scalable",
        "Simple Profile", "Simple Scalable Profile", "Core Profile", "Main Profile", "N-bit Profile", "Scalable Texture Profile", "Simple Face Animation Profile",
        "Basic Animated Texture Profile", "Hybrid Profile", "Advanced Real Time Simple Profile", "Core Scalable Profile", "Advanced Coding Efficiency Profile",
        "Advanced Core Profile", "Advanced Scalable Texture Profile", "Simple Studio Profile", "Advanced Simple Profile", "DTS", "DTS-ES", "DTS 96/24",
        "DTS-HD HRA", "DTS-HD MA", "DTS-HD MA + DTS:X", "DTS-HD MA + DTS:X IMAX", "DTS Express", "Dolby Digital Plus + Dolby Atmos", "Dolby TrueHD + Dolby Atmos",
        "Dolby Digital Plus + JOC", "DNXHD", "DNXHR LB", "DNXHR SQ", "DNXHR HQ", "DNXHR HQX", "DNXHR 444", "Proxy", "LT", "Standard", "HQ", "4444", "XQ",
        "Sequential", "Progressive", "Lossless", "JPEG-LS", "MPEG-H 3D Audio Low Complexity", "Synchronous", "Asynchronous", "Baseline Profile",
    }.ToFrozenSet(StringComparer.OrdinalIgnoreCase);

    /// <summary>ffprobe pixel format names.</summary>
    private static readonly FrozenSet<string> _pixelFormats = Set(
        "0bgr 0rgb abgr amf argb ayuv ayuv64be ayuv64le bayer_bggr16be bayer_bggr16le bayer_bggr8 bayer_gbrg16be bayer_gbrg16le bayer_gbrg8 bayer_grbg16be "
        + "bayer_grbg16le bayer_grbg8 bayer_rggb16be bayer_rggb16le bayer_rggb8 bgr0 bgr24 bgr4 bgr444be bgr444le bgr48be bgr48le bgr4_byte bgr555be bgr555le "
        + "bgr565be bgr565le bgr8 bgra bgra64be bgra64le cuda d3d11 d3d11va_vld d3d12 drm_prime dxva2_vld gbrap gbrap10be gbrap10le gbrap12be gbrap12le gbrap14be "
        + "gbrap14le gbrap16be gbrap16le gbrap32be gbrap32le gbrapf16be gbrapf16le gbrapf32be gbrapf32le gbrp gbrp10be gbrp10le gbrp10msbbe gbrp10msble gbrp12be "
        + "gbrp12le gbrp12msbbe gbrp12msble gbrp14be gbrp14le gbrp16be gbrp16le gbrp9be gbrp9le gbrpf16be gbrpf16le gbrpf32be gbrpf32le gray gray10be gray10le "
        + "gray12be gray12le gray14be gray14le gray16be gray16le gray32be gray32le gray9be gray9le grayf16be grayf16le grayf32be grayf32le mediacodec mmal monob "
        + "monow nv12 nv15 nv16 nv20 nv20be nv20le nv21 nv24 nv42 ohcodec opencl p010be p010le p012be p012le p016be p016le p210be p210le p212be p212le p216be "
        + "p216le p410be p410le p412be p412le p416be p416le pal8 qsv rgb0 rgb24 rgb4 rgb444be rgb444le rgb48be rgb48le rgb4_byte rgb555be rgb555le rgb565be "
        + "rgb565le rgb8 rgb96be rgb96le rgba rgba128be rgba128le rgba64be rgba64le rgbaf16be rgbaf16le rgbaf32be rgbaf32le rgbf16be rgbf16le rgbf32be rgbf32le "
        + "uyva uyvy422 uyyvyy411 v30xbe v30xle vaapi vdpau videotoolbox_vld vulkan vuya vuyx vyu444 x2bgr10be x2bgr10le x2rgb10be x2rgb10le xv30be xv30le xv36be "
        + "xv36le xv48be xv48le xyz12be xyz12le y210be y210le y212be y212le y216be y216le ya16be ya16le ya8 yaf16be yaf16le yaf32be yaf32le yuv410p yuv411p "
        + "yuv420p yuv420p10be yuv420p10le yuv420p12be yuv420p12le yuv420p14be yuv420p14le yuv420p16be yuv420p16le yuv420p9be yuv420p9le yuv422p yuv422p10be "
        + "yuv422p10le yuv422p12be yuv422p12le yuv422p14be yuv422p14le yuv422p16be yuv422p16le yuv422p9be yuv422p9le yuv440p yuv440p10be yuv440p10le yuv440p12be "
        + "yuv440p12le yuv444p yuv444p10be yuv444p10le yuv444p10msbbe yuv444p10msble yuv444p12be yuv444p12le yuv444p12msbbe yuv444p12msble yuv444p14be "
        + "yuv444p14le yuv444p16be yuv444p16le yuv444p9be yuv444p9le yuva420p yuva420p10be yuva420p10le yuva420p16be yuva420p16le yuva420p9be yuva420p9le "
        + "yuva422p yuva422p10be yuva422p10le yuva422p12be yuva422p12le yuva422p16be yuva422p16le yuva422p9be yuva422p9le yuva444p yuva444p10be yuva444p10le "
        + "yuva444p12be yuva444p12le yuva444p16be yuva444p16le yuva444p9be yuva444p9le yuvj411p yuvj420p yuvj422p yuvj440p yuvj444p yuyv422 yvyu422 ");

    /// <summary>ffprobe channel layout names.</summary>
    private static readonly FrozenSet<string> _layouts = Set(
        "2.1 22.2 3.0 3.0(back) 3.1 3.1.2 4.0 4.1 5.0 5.0(side) 5.1 5.1(side) 5.1.2 5.1.2(back) 5.1.4 6.0 6.0(front) 6.1 6.1(back) 6.1(front) 7.0 7.0(front) "
        + "7.1 7.1(wide) 7.1(wide-side) 7.1.2 7.1.4 7.2.3 9.1.4 9.1.6 binaural cube downmix hexadecagonal hexagonal mono octagonal quad quad(side) stereo ");

    /// <summary>ffprobe container (format) names, and the short container names Jellyfin stores.</summary>
    private static readonly FrozenSet<string> _containers = Set(
        "3dostr 3g2 3gp 4xm a64 aa aac aax ac3 ac4 ace acm act adf adp ads adts adx aea afc aiff aix alaw alias_pix alp amr amrnb amrwb amv anm apac apc ape "
        + "apm apng aptx aptx_hd apv aqtitle argo_asf argo_brp argo_cvg asf asf_o asf_stream ass ast au av1 avi avif avm2 avr avs avs2 avs3 bethsoftvid bfi bfstm "
        + "bin bink binka bit bitpacked bmp_pipe bmv boa bonk brender_pix brstm c93 caf cavsvideo cdg cdxl chromaprint cine codec2 codec2raw concat crc cri_pipe "
        + "d dash data daud dcstr dds_pipe derf dfa dfpwm dhav dirac dnxhd dpx_pipe dsf dsicin dss dts dtshd dv dvbsub dvbtxt dvd dxa ea ea_cdata eac3 epaf evc "
        + "exr_pipe f32be f32le f4v f64be f64le fbdev ffmetadata fifo film_cpk filmstrip fits flac flic flv framecrc framehash framemd5 frm fsb fwse g722 g723_1 "
        + "g726 g726le g728 g729 gdv gem_pipe genh gif gif_pipe gsm gxf h261 h263 h264 hash hca hcom hdr_pipe hds hevc hls hnm hxvs iamf ico idcin idf iff ifv "
        + "ilbc image2 image2pipe imf ingenient ipmovie ipod ipu ircam ismv iss iv8 ivf ivr j2k_pipe jacosub jpeg_pipe jpegls_pipe jpegxl_anim jpegxl_pipe "
        + "jpegxs_pipe jv kux kvag laf latm lc3 libopenmpt live_flv lmlm4 loas lrc luodat lvf lxf m4a m4v matroska mca mcc md5 mgsts microdvd mj2 mjpeg "
        + "mjpeg_2000 mkvtimestamp_v2 mlp mlv mm mmf mods moflex mov mp2 mp3 mp4 mpc mpc8 mpeg mpeg1video mpeg2video mpegts mpegtsraw mpegvideo mpjpeg mpl2 mpsub "
        + "msf msnwctcp msp mtaf mtv mulaw musx mv mvi mxf mxf_d10 mxf_opatom mxg nc nistsphere nsp nsv null nut nuv obu oga ogg ogv oma opus osq oss paf "
        + "pam_pipe pbm_pipe pcx_pipe pdv pfm_pipe pgm_pipe pgmyuv_pipe pgx_pipe phm_pipe photocd_pipe pictor_pipe pjs pmp png_pipe pp_bnk ppm_pipe psd_pipe psp "
        + "psxstr pva pvf qcp qdraw_pipe qoa qoi_pipe r3d rawvideo rcwt realtext redspark rka rl2 rm roq rpl rsd rso rtp rtp_mpegts rtsp s16be s16le s24be s24le "
        + "s32be s32le s337m s8 sami sap sbc sbg scc scd sdns sdp sdr2 sds sdx segment ser sga sgi_pipe shn siff simbiosis_imx sln smjpeg smk smoothstreaming "
        + "smush sol sox spdif spx srt ssegment stl stream_segment streamhash subviewer subviewer1 sunrast_pipe sup svag svcd svg_pipe svs swf tak tedcaptions "
        + "tee thp tiertexseq tiff_pipe tmv truehd tta ttml tty txd ty u16be u16le u24be u24le u32be u32le u8 uncodedframecrc usm v210 v210x v4l2 vag vbn_pipe "
        + "vc1 vc1test vcd vidc video4linux2 vividas vivo vmd vob vobsub voc vpk vplayer vqf vvc w64 wady wav wavarc wc3movie webm webm_chunk webm_dash_manifest "
        + "webp webp_pipe webvtt whip wsaud wsd wsvqa wtv wv wve xa xbin xbm_pipe xmd xmv xpm_pipe xvag xwd_pipe xwma yop yuv4mpegpipe "
        + " mkv mk3d mka m4v m2ts mts ts wmv wma ogv oga webma divx xvid iso bluray dvd vob strm m3u8 hls mpegts mpg mpeg mp4 m4a mov ");

    /// <summary>ffprobe colour names (primaries, transfer characteristics, matrix, range).</summary>
    private static readonly FrozenSet<string> _colors = Set(
        "bt709 unknown reserved bt470m bt470bg smpte170m smpte240m film bt2020 smpte428 smpte428_1 smpte431 smpte432 ebu3213 jedec-p22 gamma22 gamma28 linear "
        + "log log100 log_sqrt log316 iec61966-2-4 iec61966_2_4 bt1361e bt1361 iec61966-2-1 iec61966_2_1 bt2020-10 bt2020_10bit bt2020-12 bt2020_12bit smpte2084 "
        + "smpte428 arib-std-b67 gbr fcc ycgco ycocg bt2020nc bt2020_ncl bt2020c bt2020_cl smpte2085 chroma-derived-nc chroma-derived-c ictcp ipt-c2 ycgco-re "
        + "ycgco-ro tv pc mpeg jpeg limited full unspecified");

    /// <summary>Attachment MIME types (fonts and images, as Matroska attachments carry them).</summary>
    private static readonly FrozenSet<string> _mimeTypes = Set(
        "application/x-truetype-font application/x-font-ttf application/x-font-otf application/x-font-opentype application/vnd.ms-opentype application/font-sfnt "
        + "application/font-woff font/ttf font/otf font/sfnt font/woff font/woff2 font/collection image/jpeg image/png image/webp image/gif image/bmp "
        + "application/octet-stream text/plain text/xml application/xml");

    /// <summary>The table's own entry for a value (its canonical spelling), or null when the table has no such entry.</summary>
    private static string? Entry(FrozenSet<string> table, string? value) => value != null && table.TryGetValue(value, out var entry) ? entry : null;

    /// <summary>A comma-separated list whose every part is a table entry: the entries, joined as the host joins them; else null.</summary>
    private static string? Entries(FrozenSet<string> table, string? value)
    {
        if (string.IsNullOrEmpty(value) || value.Length > 512) return null;
        var parts = value.Split(',');
        var entries = new string[parts.Length];
        for (var i = 0; i < parts.Length; i++)
            if ((entries[i] = Entry(table, parts[i])!) == null) return null;
        return string.Join(',', entries);
    }

    /// <summary>The codec table's entry (or a comma-separated list of entries, as ffprobe names some formats).</summary>
    public static string? Codec(string? value) => Entry(_codecs, value) ?? Entries(_codecs, value);

    /// <summary>The profile table's entry.</summary>
    public static string? Profile(string? value) => Entry(_profiles, value);

    /// <summary>The pixel-format table's entry.</summary>
    public static string? PixelFormat(string? value) => Entry(_pixelFormats, value);

    /// <summary>The channel-layout table's entry, or ffprobe's "N channels" for an unnamed layout (rebuilt from its number).</summary>
    public static string? Layout(string? value)
        => Entry(_layouts, value) ?? (value != null && ChannelCount().Match(value) is { Success: true } m ? string.Create(CultureInfo.InvariantCulture, $"{int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture)} channels") : null);

    /// <summary>A container: the table's entry, or a comma-separated list of entries.</summary>
    public static string? Container(string? value) => Entry(_containers, value) ?? Entries(_containers, value);

    /// <summary>The colour table's entry.</summary>
    public static string? Color(string? value) => Entry(_colors, value);

    /// <summary>The attachment MIME table's entry.</summary>
    public static string? MimeType(string? value) => Entry(_mimeTypes, value);

    /// <summary>A hexadecimal id (32 hex digits, the host's "N" GUID form) or a GUID in any form.</summary>
    public static bool Id(string? value) => value != null && (HexId().IsMatch(value) || Guid.TryParse(value, out _));

    /// <summary>An id rebuilt from its parsed value, in the layout it came in (the host's "N" form or the dashed "D" form).</summary>
    public static string? IdOf(string? value)
        => value != null && value.Length is 32 or 36 && Guid.TryParse(value, out var id) ? id.ToString(value.Length == 32 ? "N" : "D", CultureInfo.InvariantCulture) : null;

    /// <summary>
    /// An image tag or ETag: hex, as the host writes it, with Spoiler Guard's (sb-) and JE's (-jeu) cache-bust parts, or JE's
    /// own signed artwork grant for an absent title ("na1." hex payload "." hex signature).
    /// </summary>
    public static bool Tag(string? value) => value != null && ImageTag().IsMatch(value);

    /// <summary>A BlurHash: base-83 digits whose length matches the component count its first digit encodes.</summary>
    public static bool BlurHash(string? value)
    {
        const string digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";
        if (value is not { Length: >= 6 } || value.Any(c => digits.IndexOf(c, StringComparison.Ordinal) < 0)) return false;
        var size = digits.IndexOf(value[0], StringComparison.Ordinal);
        var (x, y) = (size % 9 + 1, size / 9 + 1);
        return value.Length == 4 + 2 * x * y;
    }

    /// <summary>A ratio of numbers ("16:9", "2.39:1").</summary>
    public static bool Ratio(string? value) => value != null && RatioPattern().IsMatch(value);

    /// <summary>A rational time base ("1/24000").</summary>
    public static bool Rational(string? value) => value != null && RationalPattern().IsMatch(value);

    /// <summary>Digits with dot, dash or space separators (a channel number "4.1", a NAL length).</summary>
    public static bool Number(string? value) => value != null && NumberPattern().IsMatch(value);

    /// <summary>A four-character codec tag, a hex tag, or ffprobe's bracketed bytes.</summary>
    public static bool FourCc(string? value) => value != null && FourCcPattern().IsMatch(value);

    /// <summary>A clock time ("20:00", "8:00 PM").</summary>
    public static bool Time(string? value) => value != null && TimePattern().IsMatch(value);

    /// <summary>
    /// An identifier a client or provider assigned: digits with up to four leading letters ("tt0111161", "EP0123", "p0",
    /// "playlistItem" is the web client's own prefix), or an id.
    /// </summary>
    public static bool IdShaped(string? value) => value != null && (Id(value) || IdShapedPattern().IsMatch(value) || value.StartsWith("playlistItem", StringComparison.Ordinal) && Number(value["playlistItem".Length..]));

    /// <summary>A user-data key: an id (optionally with the episode's season/episode digits) or provider digits.</summary>
    public static bool UserDataKey(string? value) => value != null && (IdShaped(value) || UserDataKeyPattern().IsMatch(value));

    /// <summary>One of the named values: the list's own entry.</summary>
    public static string? OneOf(string? value, params string[] names)
    {
        if (value == null) return null;
        foreach (var name in names) if (string.Equals(name, value, StringComparison.OrdinalIgnoreCase)) return name;
        return null;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // URLs, rebuilt from the hosts' own route templates: named parameters only, each value rebuilt by its own rule, the
    // host's fixed file names; never a segment or parameter of the original copied as text.

    /// <summary>The request a projection answers: its device id and access token (the values the host put into its URLs).</summary>
    public readonly record struct Caller(string? DeviceId, string? Token);

    /// <summary>
    /// A media stream's or attachment's delivery URL, rebuilt from the host's templates (StreamInfo's subtitle URL and
    /// MediaInfoHelper's attachment URL, the same on 12.2 and 10.11.11): "/Videos/{item}/{source}/Subtitles/{index}/{ticks}/Stream.{format}",
    /// "?ApiKey=" the caller's own token, and "/Videos/{item}/{source}/Attachments/{index}". The file name is always the host's
    /// "Stream"; anything else is null.
    /// </summary>
    public static string? DeliveryUrl(string? value, Caller caller)
    {
        if (value == null || value.Length > 1024) return null;
        if (AttachmentRoute().Match(value) is { Success: true } a)
        {
            var item = IdOf(a.Groups["item"].Value);
            var source = SourceId(a.Groups["source"].Value);
            var index = Int(a.Groups["index"].Value);
            return item == null || source == null || index == null ? null : "/" + RouteRoot(a.Groups["root"].Value) + "/" + item + "/" + source + "/Attachments/" + index;
        }
        if (SubtitleRoute().Match(value) is not { Success: true } m) return null;
        var id = IdOf(m.Groups["item"].Value);
        var sourceId = SourceId(m.Groups["source"].Value);
        var stream = Int(m.Groups["index"].Value);
        var ticks = m.Groups["ticks"].Success ? Long(m.Groups["ticks"].Value) : null;
        var format = Codec(m.Groups["format"].Value);
        if (id == null || sourceId == null || stream == null || format == null || m.Groups["ticks"].Success && ticks == null) return null;
        var url = "/" + RouteRoot(m.Groups["root"].Value) + "/" + id + "/" + sourceId + "/Subtitles/" + stream + (ticks != null ? "/" + ticks : "") + "/Stream." + format;
        // The host appends "?ApiKey=" with the caller's token; it is the caller's own value, never the original's.
        return m.Groups["query"].Success && Query(m.Groups["query"].Value).Any(p => string.Equals(p.Key, "ApiKey", StringComparison.OrdinalIgnoreCase)) && Token(caller.Token) is { } token
            ? url + "?ApiKey=" + token : url;
    }

    /// <summary>
    /// A transcoding URL, rebuilt from the host's template (StreamInfo.ToUrl and MediaInfoHelper's additions, 12.2 and
    /// 10.11.11): "/videos|/audio/{item}/master.m3u8|main.m3u8|stream[.{container}]", then the host's named parameters in
    /// their original order, each value rebuilt by its own rule (ids from their parsed value, numbers, flags and enum names
    /// from their tables, codec and container lists from the token tables, the device id and access token from the caller);
    /// an unknown parameter, or one whose value its rule does not accept, is left out. 10.11's leading empty parameter
    /// ("master.m3u8?&DeviceId=…") is kept as the host writes it.
    /// </summary>
    public static string? TranscodingUrl(string? value, Caller caller)
    {
        if (value == null || value.Length > 8192 || TranscodingRoute().Match(value) is not { Success: true } m) return null;
        var item = IdOf(m.Groups["item"].Value);
        var file = m.Groups["file"].Value;
        string? name = file.ToLowerInvariant() switch
        {
            "master.m3u8" => "master.m3u8",
            "main.m3u8" => "main.m3u8",
            "stream" => "stream",
            _ => file.StartsWith("stream.", StringComparison.OrdinalIgnoreCase) && Container(file[7..]) is { } container ? "stream." + container : null,
        };
        if (item == null || name == null) return null;
        var url = "/" + m.Groups["kind"].Value.ToLowerInvariant() + "/" + item + "/" + name;
        if (!m.Groups["query"].Success) return url;
        var query = m.Groups["query"].Value;
        var kept = new List<string>();
        foreach (var (key, raw) in Query(query))
        {
            if (key.Length == 0) continue;
            if (Parameter(key, raw, caller) is { } rebuilt) kept.Add(rebuilt);
        }
        if (kept.Count == 0) return url;
        return url + (query.StartsWith('&') ? "?&" : "?") + string.Join('&', kept);
    }

    /// <summary>A query's parameters in order (the separator '&amp;'; a parameter without '=' has an empty value).</summary>
    private static IEnumerable<(string Key, string Value)> Query(string query)
        => query.Split('&').Select(p => p.IndexOf('=', StringComparison.Ordinal) is var at && at >= 0 ? (p[..at], p[(at + 1)..]) : (p, ""));

    private delegate string? ValueRule(string value, Caller caller);

    private static readonly string[] _flags = ["true", "false", "True", "False"];

    /// <summary>The host's transcoding parameters (StreamInfo.ToUrl, both lines, and MediaInfoHelper), each with its value rule.</summary>
    private static readonly Dictionary<string, ValueRule> _parameters = new(StringComparer.OrdinalIgnoreCase)
    {
        ["DeviceProfileId"] = (v, _) => IdOf(v),
        ["DeviceId"] = (v, c) => CallerValue(v, c.DeviceId, 512),
        ["MediaSourceId"] = (v, _) => SourceId(v),
        ["Static"] = (v, _) => Flag(v),
        ["VideoCodec"] = (v, _) => Codec(v),
        ["AudioCodec"] = (v, _) => Codec(v),
        ["SubtitleCodec"] = (v, _) => Codec(v),
        ["AudioStreamIndex"] = (v, _) => Int(v),
        ["SubtitleStreamIndex"] = (v, _) => Int(v),
        ["VideoBitrate"] = (v, _) => Long(v),
        ["AudioBitrate"] = (v, _) => Long(v),
        ["AudioSampleRate"] = (v, _) => Long(v),
        ["MaxFramerate"] = (v, _) => Decimal(v),
        ["MaxWidth"] = (v, _) => Long(v),
        ["MaxHeight"] = (v, _) => Long(v),
        ["SegmentContainer"] = (v, _) => Container(v),
        ["SegmentLength"] = (v, _) => Long(v),
        ["MinSegments"] = (v, _) => Long(v),
        ["StartTimeTicks"] = (v, _) => Long(v),
        ["PlaySessionId"] = (v, _) => IdOf(v),
        ["ApiKey"] = (v, c) => Token(c.Token) is { } token && v.Length > 0 ? token : null,
        ["LiveStreamId"] = (v, _) => SourceId(v),
        ["RequireNonAnamorphic"] = (v, _) => Flag(v),
        ["TranscodingMaxAudioChannels"] = (v, _) => Long(v),
        ["EnableSubtitlesInManifest"] = (v, _) => Flag(v),
        ["EnableMpegtsM2TsMode"] = (v, _) => Flag(v),
        ["EstimateContentLength"] = (v, _) => Flag(v),
        ["TranscodeSeekInfo"] = (v, _) => EnumName<MediaBrowser.Model.Dlna.TranscodeSeekInfo>(v),
        ["CopyTimestamps"] = (v, _) => Flag(v),
        ["BreakOnNonKeyFrames"] = (v, _) => Flag(v),
        ["RequireAvc"] = (v, _) => Flag(v),
        ["EnableAudioVbrEncoding"] = (v, _) => Flag(v),
        ["Tag"] = (v, _) => Tag(v) ? v : null,
        ["SubtitleMethod"] = (v, _) => EnumName<MediaBrowser.Model.Dlna.SubtitleDeliveryMethod>(v),
        ["TranscodeReasons"] = (v, _) => EnumNames<MediaBrowser.Model.Session.TranscodeReason>(v),
        ["allowVideoStreamCopy"] = (v, _) => Flag(v),
        ["allowAudioStreamCopy"] = (v, _) => Flag(v),
        ["alwaysBurnInSubtitleWhenTranscoding"] = (v, _) => Flag(v),
    };

    /// <summary>Profile names as StreamBuilder writes them into a URL: lower case, spaces removed.</summary>
    private static readonly FrozenSet<string> _optionProfiles = _profiles.Select(p => p.ToLowerInvariant().Replace(" ", "", StringComparison.Ordinal))
        .Concat(["constrainedbaseline", "main10", "high10", "mainstillpicture", "lc", "he-aac", "he-aacv2", "ltp", "ssr", "ld", "eld", "xhe-aac", "high444", "highprofile"])
        .ToFrozenSet(StringComparer.Ordinal);

    /// <summary>The per-codec options StreamBuilder sets ("{codec}-{option}"), each with its value rule.</summary>
    private static readonly Dictionary<string, Func<string, string?>> _codecOptions = new(StringComparer.OrdinalIgnoreCase)
    {
        ["profile"] = v => List(v, p => Entry(_optionProfiles, p)),
        ["level"] = v => List(v, Decimal),
        ["rangetype"] = v => List(v, EnumName<Jellyfin.Data.Enums.VideoRangeType>),
        ["codectag"] = v => List(v, t => FourCcPattern().IsMatch(t) && t.Length == 4 ? t : null),
        ["deinterlace"] = Flag,
        ["audiochannels"] = v => List(v, Long),
        ["maxrefframes"] = v => List(v, Long),
        ["videobitdepth"] = v => List(v, Long),
        ["audiobitdepth"] = v => List(v, Long),
        ["rotation"] = v => List(v, Long),
    };

    private static string? Parameter(string key, string value, Caller caller)
    {
        if (_parameters.TryGetValue(key, out var rule))
        {
            var name = _parameters.Keys.First(k => string.Equals(k, key, StringComparison.OrdinalIgnoreCase));
            return rule(value, caller) is { } rebuilt ? name + "=" + rebuilt : null;
        }
        // "{codec}-{option}" (StreamInfo.StreamOptions): a codec from the codec table and an option from StreamBuilder's own.
        var dash = key.LastIndexOf('-');
        if (dash <= 0 || Codec(key[..dash]) is not { } codec || !_codecOptions.TryGetValue(key[(dash + 1)..], out var option)) return null;
        var optionName = _codecOptions.Keys.First(k => string.Equals(k, key[(dash + 1)..], StringComparison.OrdinalIgnoreCase));
        return option(value) is { } kept ? codec + "-" + optionName + "=" + kept : null;
    }

    /// <summary>The caller's own value for a parameter the host fills from the request (escaped when the original was).</summary>
    private static string? CallerValue(string original, string? own, int max)
    {
        if (string.IsNullOrEmpty(original) || string.IsNullOrEmpty(own) || own.Length > max) return null;
        return original.Contains('%', StringComparison.Ordinal) ? Uri.EscapeDataString(own) : own;
    }

    /// <summary>An access token as the host issues it (32 hex digits).</summary>
    private static string? Token(string? token) => token != null && HexId().IsMatch(token) ? token : null;

    /// <summary>A media source or live stream id: an id, or hex runs joined by underscores (the host's live-stream ids).</summary>
    private static string? SourceId(string value)
        => IdOf(value) ?? (value.Length is > 0 and <= 200 && value.Split('_').All(part => part.Length > 0 && part.All(Uri.IsHexDigit)) ? string.Join('_', value.Split('_').Select(p => p.ToLowerInvariant())) : null);

    private static string? Flag(string value) => _flags.FirstOrDefault(f => string.Equals(f, value, StringComparison.Ordinal));

    private static string? Int(string value) => value.Length <= 11 && int.TryParse(value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var n) ? n.ToString(CultureInfo.InvariantCulture) : null;

    private static string? Long(string value) => value.Length <= 20 && long.TryParse(value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var n) ? n.ToString(CultureInfo.InvariantCulture) : null;

    private static string? Decimal(string value)
        => value.Length <= 24 && decimal.TryParse(value, NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var n) ? n.ToString(CultureInfo.InvariantCulture) : null;

    private static string? EnumName<T>(string value) where T : struct, Enum
        => Enum.GetNames<T>().FirstOrDefault(n => string.Equals(n, value, StringComparison.Ordinal));

    private static string? EnumNames<T>(string value) where T : struct, Enum => List(value, EnumName<T>);

    private static string? List(string value, Func<string, string?> each)
    {
        if (value.Length == 0 || value.Length > 1024) return null;
        var parts = value.Split(',');
        var rebuilt = new string[parts.Length];
        for (var i = 0; i < parts.Length; i++)
            if ((rebuilt[i] = each(parts[i])!) == null) return null;
        return string.Join(',', rebuilt);
    }

    private static string RouteRoot(string root) => root.ToLowerInvariant() switch { "audio" => "Audio", "items" => "Items", _ => "Videos" };

    // Compiled once, not source-generated: the plugin compiles without generators (the scan walks compile its sources
    // with Roslyn alone).
    private static readonly Regex _channelCount = new(@"^(\d{1,2}) channels$", RegexOptions.Compiled);

    private static Regex ChannelCount() => _channelCount;

    private static readonly Regex _hexId = new("^[0-9a-fA-F]{32}$", RegexOptions.Compiled);

    private static Regex HexId() => _hexId;

    private static readonly Regex _imageTag = new(@"^(sb-[0-9a-f]{8}-)?([0-9a-fA-F]{6,64}(-jeu[0-9a-f]{1,32})?|na1\.[0-9a-f]{2,1800}\.[0-9a-f]{32})$", RegexOptions.Compiled);

    private static Regex ImageTag() => _imageTag;

    private static readonly Regex _ratioPattern = new(@"^\d{1,5}(\.\d{1,4})?:\d{1,5}(\.\d{1,4})?$", RegexOptions.Compiled);

    private static Regex RatioPattern() => _ratioPattern;

    private static readonly Regex _rationalPattern = new(@"^\d{1,12}/\d{1,12}$", RegexOptions.Compiled);

    private static Regex RationalPattern() => _rationalPattern;

    private static readonly Regex _numberPattern = new(@"^\d{1,10}([.\- ]\d{1,10}){0,3}$", RegexOptions.Compiled);

    private static Regex NumberPattern() => _numberPattern;

    private static readonly Regex _fourCcPattern = new(@"^([A-Za-z0-9]{4}|0x[0-9a-fA-F]{1,8}|(\[\d{1,3}\]){1,4})$", RegexOptions.Compiled);

    private static Regex FourCcPattern() => _fourCcPattern;

    private static readonly Regex _timePattern = new(@"^\d{1,2}:\d{2}( ?[AaPp][Mm])?$", RegexOptions.Compiled);

    private static Regex TimePattern() => _timePattern;

    private static readonly Regex _idShapedPattern = new(@"^[A-Za-z]{0,4}\d{1,20}([._-]\d{1,20}){0,3}$", RegexOptions.Compiled);

    private static Regex IdShapedPattern() => _idShapedPattern;

    private static readonly Regex _userDataKeyPattern = new(@"^([0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\d{0,12}$", RegexOptions.Compiled);

    private static Regex UserDataKeyPattern() => _userDataKeyPattern;

    private static readonly Regex _subtitleRoute = new(@"^/(?<root>Videos|Audio|Items)/(?<item>[0-9a-fA-F-]{32,36})/(?<source>[0-9a-fA-F_-]{1,200})/Subtitles/(?<index>\d{1,4})(/(?<ticks>\d{1,20}))?/(?<file>[^/?]{1,200})\.(?<format>[A-Za-z0-9]{1,16})(\?(?<query>[^?]{0,1024}))?$", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static Regex SubtitleRoute() => _subtitleRoute;

    private static readonly Regex _attachmentRoute = new(@"^/(?<root>Videos|Audio|Items)/(?<item>[0-9a-fA-F-]{32,36})/(?<source>[0-9a-fA-F_-]{1,200})/Attachments/(?<index>\d{1,4})$", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static Regex AttachmentRoute() => _attachmentRoute;

    private static readonly Regex _transcodingRoute = new(@"^/(?<kind>videos|audio)/(?<item>[0-9a-fA-F-]{32,36})/(?<file>[A-Za-z0-9_.]{1,40})(\?(?<query>[^?#]{0,8000}))?$", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static Regex TranscodingRoute() => _transcodingRoute;
}
