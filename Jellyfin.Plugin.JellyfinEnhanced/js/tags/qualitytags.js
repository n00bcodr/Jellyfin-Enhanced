(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/generated-shared/stub/client/src/features/media-tags/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/media-tags/host");
  var export0 = /* @__PURE__ */ sharedExport(shared, "apiClient");
  var export1 = /* @__PURE__ */ sharedExport(shared, "hasApiClient");
  var export4 = /* @__PURE__ */ sharedExport(shared, "tagRuntimeHost");

  // client/generated-shared/stub/client/src/features/media-tags/pipeline/dto.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/media-tags/pipeline/dto");
  var export2 = /* @__PURE__ */ sharedExport(shared2, "finite");
  var export42 = /* @__PURE__ */ sharedExport(shared2, "isRecord");
  var export5 = /* @__PURE__ */ sharedExport(shared2, "memberRecord");
  var export6 = /* @__PURE__ */ sharedExport(shared2, "memberText");
  var export7 = /* @__PURE__ */ sharedExport(shared2, "members");
  var export9 = /* @__PURE__ */ sharedExport(shared2, "own");
  var export10 = /* @__PURE__ */ sharedExport(shared2, "record");
  var export11 = /* @__PURE__ */ sharedExport(shared2, "records");
  var export12 = /* @__PURE__ */ sharedExport(shared2, "stringList");
  var export13 = /* @__PURE__ */ sharedExport(shared2, "text");

  // client/src/features/media-tags/types/quality/quality-data.ts
  var resolutionOrder = ["8K", "4K", "1440p", "1080p", "1080i", "720p", "576p", "576i", "480p", "480i", "LOW-RES", "SD"];
  var sourceOrder = ["REMUX", "BluRay", "WEB", "HD DVD", "DVD", "VHS", "HDTV", "SDTV", "Physical", "CAM", "TS", "TC", "SCR"];
  var EDITION_PREFIX = "edition:";
  var editionOrder = [];
  var dynamicRangeOrder = ["Dolby Vision", "HDR10+", "HDR10", "HLG", "HDR", "SDR"];
  var specialFormatOrder = ["IMAX", "3D"];
  var codecOrder = ["VVC", "AV1", "HEVC", "H265", "VP9", "H264", "VP8", "XVID", "DIVX", "VC-1", "WMV", "MPEG2", "MPEG4", "MJPEG", "THEORA", "ProRes"];
  var audioOrder = ["TRUEHD ATMOS", "DTS-X", "ATMOS", "DD+ ATMOS", "TRUEHD", "DTS-HD MA", "PCM", "FLAC", "DTS-HD HRA", "DTS-HD", "Dolby Digital+", "DTS", "Dolby Digital", "7.1", "6.1", "5.1"];
  var CATEGORIES = [
    { key: "resolution", items: resolutionOrder, settingKey: "showResolutionTag", pluginKey: "ShowResolutionTag", orderUserKey: "resolutionTagOrder", orderPluginKey: "ResolutionTagOrder", defaultOrder: 1 },
    { key: "source", items: sourceOrder, settingKey: "showSourceTag", pluginKey: "ShowSourceTag", orderUserKey: "sourceTagOrder", orderPluginKey: "SourceTagOrder", defaultOrder: 2 },
    { key: "dynamicRange", items: dynamicRangeOrder, settingKey: "showDynamicRangeTag", pluginKey: "ShowDynamicRangeTag", orderUserKey: "dynamicRangeTagOrder", orderPluginKey: "DynamicRangeTagOrder", defaultOrder: 3 },
    { key: "specialFormat", items: specialFormatOrder, settingKey: "showSpecialFormatTag", pluginKey: "ShowSpecialFormatTag", orderUserKey: "specialFormatTagOrder", orderPluginKey: "SpecialFormatTagOrder", defaultOrder: 4 },
    { key: "videoCodec", items: codecOrder, settingKey: "showVideoCodecTag", pluginKey: "ShowVideoCodecTag", orderUserKey: "videoCodecTagOrder", orderPluginKey: "VideoCodecTagOrder", defaultOrder: 5 },
    { key: "audio", items: audioOrder, settingKey: "showAudioInfoTag", pluginKey: "ShowAudioInfoTag", orderUserKey: "audioInfoTagOrder", orderPluginKey: "AudioInfoTagOrder", defaultOrder: 6 },
    { key: "edition", items: editionOrder, settingKey: "showEditionTag", pluginKey: "ShowEditionTag", orderUserKey: "editionTagOrder", orderPluginKey: "EditionTagOrder", defaultOrder: 7 },
    { key: "runtime", items: [], settingKey: "showRuntimeTag", pluginKey: "ShowRuntimeTag", orderUserKey: "runtimeTagOrder", orderPluginKey: "RuntimeTagOrder", defaultOrder: 8, fallback: false },
    { key: "aspectRatio", items: [], settingKey: "showAspectRatioTag", pluginKey: "ShowAspectRatioTag", orderUserKey: "aspectRatioTagOrder", orderPluginKey: "AspectRatioTagOrder", defaultOrder: 9, fallback: false },
    { key: "frameRate", items: [], settingKey: "showFrameRateTag", pluginKey: "ShowFrameRateTag", orderUserKey: "frameRateTagOrder", orderPluginKey: "FrameRateTagOrder", defaultOrder: 10, fallback: false },
    { key: "versions", items: [], settingKey: "showVersionsTag", pluginKey: "ShowVersionsTag", orderUserKey: "versionsTagOrder", orderPluginKey: "VersionsTagOrder", defaultOrder: 11, fallback: false }
  ];
  var TAG_TO_CATEGORY = /* @__PURE__ */ new Map();
  for (const cat of CATEGORIES) {
    for (const item of cat.items) TAG_TO_CATEGORY.set(item, cat.key);
  }
  var CATEGORY_BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));
  var qualityColors = {
    "8K": { bg: "rgba(220, 20, 60, 0.95)", text: "#ffffff" },
    "4K": { bg: "rgba(189, 5, 232, 0.95)", text: "#ffffff" },
    "1440p": { bg: "rgba(255, 20, 147, 0.9)", text: "#ffffff" },
    "1080p": { bg: "rgba(0, 160, 230, 0.9)", text: "#ffffff" },
    "1080i": { bg: "rgba(0, 160, 230, 0.9)", text: "#ffffff" },
    "720p": { bg: "rgba(255, 165, 0, 0.9)", text: "#000000" },
    "576p": { bg: "rgba(255, 179, 0, 0.85)", text: "#000000" },
    "576i": { bg: "rgba(255, 179, 0, 0.85)", text: "#000000" },
    "480p": { bg: "rgba(255, 193, 7, 0.85)", text: "#000000" },
    "480i": { bg: "rgba(255, 193, 7, 0.85)", text: "#000000" },
    "SD": { bg: "rgba(108, 117, 125, 0.85)", text: "#ffffff" },
    "SDR": { bg: "rgba(84, 110, 122, 0.9)", text: "#ffffff" },
    "HDR": { bg: "rgba(255, 215, 0, 0.95)", text: "#000000" },
    "HDR10": { bg: "rgba(255, 215, 0, 0.95)", text: "#000000" },
    "HDR10+": { bg: "rgba(255, 215, 0, 0.95)", text: "#000000" },
    "HLG": { bg: "rgba(255, 215, 0, 0.95)", text: "#000000" },
    "Dolby Vision": { bg: "rgba(139, 69, 19, 0.95)", text: "#ffffff" },
    "IMAX": { bg: "rgba(0, 114, 206, 0.9)", text: "#ffffff" },
    "ATMOS": { bg: "rgba(0, 100, 255, 0.9)", text: "#ffffff" },
    "TRUEHD ATMOS": { bg: "rgba(0, 100, 255, 0.9)", text: "#ffffff" },
    "DD+ ATMOS": { bg: "rgba(0, 100, 255, 0.9)", text: "#ffffff" },
    "DTS-X": { bg: "rgba(255, 100, 0, 0.9)", text: "#ffffff" },
    "DTS-HD MA": { bg: "rgba(245, 130, 0, 0.85)", text: "#ffffff" },
    "DTS-HD HRA": { bg: "rgba(245, 130, 0, 0.85)", text: "#ffffff" },
    "DTS-HD": { bg: "rgba(245, 130, 0, 0.85)", text: "#ffffff" },
    "Dolby Digital": { bg: "rgba(0, 150, 136, 0.9)", text: "#ffffff" },
    "DTS": { bg: "rgba(245, 130, 0, 0.85)", text: "#ffffff" },
    "Dolby Digital+": { bg: "rgba(0, 150, 136, 0.9)", text: "#ffffff" },
    "TRUEHD": { bg: "rgba(76, 175, 80, 0.9)", text: "#ffffff" },
    "PCM": { bg: "rgba(46, 125, 50, 0.9)", text: "#ffffff" },
    "FLAC": { bg: "rgba(46, 125, 50, 0.9)", text: "#ffffff" },
    "7.1": { bg: "rgba(156, 39, 176, 0.9)", text: "#ffffff" },
    "6.1": { bg: "rgba(126, 87, 194, 0.9)", text: "#ffffff" },
    "5.1": { bg: "rgba(103, 58, 183, 0.9)", text: "#ffffff" },
    "3D": { bg: "rgba(0, 150, 255, 0.9)", text: "#ffffff" },
    "VVC": { bg: "rgba(230, 74, 25, 0.95)", text: "#ffffff" },
    "AV1": { bg: "rgba(255, 87, 34, 0.95)", text: "#ffffff" },
    "HEVC": { bg: "rgba(33, 150, 243, 0.9)", text: "#ffffff" },
    "H265": { bg: "rgba(63, 81, 181, 0.9)", text: "#ffffff" },
    "VP9": { bg: "rgba(156, 39, 176, 0.9)", text: "#ffffff" },
    "H264": { bg: "rgba(76, 175, 80, 0.9)", text: "#ffffff" },
    "VP8": { bg: "rgba(121, 85, 72, 0.9)", text: "#ffffff" },
    "XVID": { bg: "rgba(255, 152, 0, 0.9)", text: "#000000" },
    "DIVX": { bg: "rgba(255, 193, 7, 0.9)", text: "#000000" },
    "VC-1": { bg: "rgba(0, 188, 212, 0.9)", text: "#000000" },
    "WMV": { bg: "rgba(0, 188, 212, 0.9)", text: "#000000" },
    "MPEG2": { bg: "rgba(96, 125, 139, 0.9)", text: "#ffffff" },
    "MPEG4": { bg: "rgba(158, 158, 158, 0.9)", text: "#ffffff" },
    "MJPEG": { bg: "rgba(233, 30, 99, 0.9)", text: "#ffffff" },
    "THEORA": { bg: "rgba(139, 195, 74, 0.9)", text: "#000000" },
    "ProRes": { bg: "rgba(96, 125, 139, 0.9)", text: "#ffffff" },
    "REMUX": { bg: "rgba(13, 71, 161, 0.95)", text: "#ffffff" },
    "WEB": { bg: "rgba(0, 121, 107, 0.95)", text: "#ffffff" },
    "CAM": { bg: "rgba(183, 28, 28, 0.95)", text: "#ffffff" },
    "TS": { bg: "rgba(183, 28, 28, 0.95)", text: "#ffffff" },
    "TC": { bg: "rgba(183, 28, 28, 0.95)", text: "#ffffff" },
    "SCR": { bg: "rgba(183, 28, 28, 0.95)", text: "#ffffff" },
    "Director's Cut": { bg: "rgba(106, 27, 154, 0.95)", text: "#ffffff" },
    "Extended": { bg: "rgba(106, 27, 154, 0.95)", text: "#ffffff" },
    "Unrated": { bg: "rgba(106, 27, 154, 0.95)", text: "#ffffff" },
    "Theatrical": { bg: "rgba(106, 27, 154, 0.95)", text: "#ffffff" },
    "Remastered": { bg: "rgba(106, 27, 154, 0.95)", text: "#ffffff" },
    "Criterion": { bg: "rgba(106, 27, 154, 0.95)", text: "#ffffff" },
    "Uncut": { bg: "rgba(106, 27, 154, 0.95)", text: "#ffffff" },
    "Final Cut": { bg: "rgba(106, 27, 154, 0.95)", text: "#ffffff" },
    "Special Edition": { bg: "rgba(106, 27, 154, 0.95)", text: "#ffffff" },
    "Redux": { bg: "rgba(106, 27, 154, 0.95)", text: "#ffffff" },
    "Ultimate": { bg: "rgba(106, 27, 154, 0.95)", text: "#ffffff" },
    "Collector's Edition": { bg: "rgba(106, 27, 154, 0.95)", text: "#ffffff" },
    "Anniversary": { bg: "rgba(106, 27, 154, 0.95)", text: "#ffffff" },
    "Uncensored": { bg: "rgba(106, 27, 154, 0.95)", text: "#ffffff" },
    "Open Matte": { bg: "rgba(106, 27, 154, 0.95)", text: "#ffffff" },
    "Rogue Cut": { bg: "rgba(106, 27, 154, 0.95)", text: "#ffffff" },
    "Producer's Cut": { bg: "rgba(106, 27, 154, 0.95)", text: "#ffffff" },
    "Alternate Cut": { bg: "rgba(106, 27, 154, 0.95)", text: "#ffffff" },
    "Assembly Cut": { bg: "rgba(106, 27, 154, 0.95)", text: "#ffffff" },
    "International Cut": { bg: "rgba(106, 27, 154, 0.95)", text: "#ffffff" },
    "Restored": { bg: "rgba(106, 27, 154, 0.95)", text: "#ffffff" },
    "Hybrid": { bg: "rgba(106, 27, 154, 0.95)", text: "#ffffff" },
    "Roadshow": { bg: "rgba(106, 27, 154, 0.95)", text: "#ffffff" },
    "Despecialized": { bg: "rgba(106, 27, 154, 0.95)", text: "#ffffff" },
    "Fan Edit": { bg: "rgba(106, 27, 154, 0.95)", text: "#ffffff" },
    "Black and Chrome": { bg: "rgba(106, 27, 154, 0.95)", text: "#ffffff" },
    "Masters of Cinema": { bg: "rgba(106, 27, 154, 0.95)", text: "#ffffff" },
    "BluRay": { bg: "rgba(0, 102, 204, 0.95)", text: "#ffffff" },
    "HD DVD": { bg: "rgba(128, 0, 32, 0.95)", text: "#ffffff" },
    "DVD": { bg: "rgba(102, 102, 102, 0.95)", text: "#ffffff" },
    "VHS": { bg: "rgba(139, 69, 19, 0.95)", text: "#ffffff" },
    "HDTV": { bg: "rgba(69, 90, 100, 0.95)", text: "#ffffff" },
    "SDTV": { bg: "rgba(69, 90, 100, 0.95)", text: "#ffffff" },
    "Physical": { bg: "rgba(102, 102, 102, 0.9)", text: "#ffffff" },
    "Mixed": { bg: "#546e7a", text: "#ffffff" }
  };
  var audioBases = ["TRUEHD ATMOS", "DD+ ATMOS", "Dolby Digital+", "Dolby Digital", "ATMOS", "DTS-X", "TRUEHD", "DTS-HD MA", "DTS-HD HRA", "DTS-HD", "DTS", "PCM", "FLAC"];
  var AUDIO_BASES = audioBases;
  var EDITIONS = { "Director's Cut": ["quality_edition_directors_cut", "DC"], "Extended": ["quality_edition_extended", "Ext"], "Unrated": ["quality_edition_unrated", "Unr"], "Theatrical": ["quality_edition_theatrical", null], "IMAX": [null, "IMAX"], "Remastered": ["quality_edition_remastered", "Rem"], "Criterion": [null, "CC"], "Uncut": ["quality_edition_uncut", null], "Final Cut": ["quality_edition_final_cut", null], "Special Edition": ["quality_edition_special", "quality_edition_special_compact"], "Redux": [null, "Redux"], "Ultimate": ["quality_edition_ultimate", "Ult"], "Collector's Edition": ["quality_edition_collectors", "CE"], "Anniversary": ["quality_edition_anniversary", "Anniv"], "Uncensored": ["quality_edition_uncensored", "Unc"], "Open Matte": [null, "OM"], "Rogue Cut": [null, "Rogue"], "Producer's Cut": ["quality_edition_producers_cut", "PC"], "Alternate Cut": ["quality_edition_alternate_cut", "Alt"], "Assembly Cut": ["quality_edition_assembly_cut", "Asm"], "International Cut": ["quality_edition_international_cut", "Intl"], "Restored": ["quality_edition_restored", "Rest"], "Hybrid": ["quality_edition_hybrid", "Hyb"], "Black and Chrome": [null, "B&C"], "Masters of Cinema": [null, "MoC"], "Roadshow": ["quality_edition_roadshow", "Road"], "Despecialized": [null, "Despec"], "Fan Edit": ["quality_edition_fan_edit", "Fan"] };
  var aspectRatios = /* @__PURE__ */ (() => {
    const ratios = [[1.3333333333333333, 0.025, "4:3"], [1.43, 0.015, "1.43:1"], [1.66, 0.02, "1.66:1"], [1.7777777777777777, 0.025, "16:9"], [1.85, 0.025, "1.85:1"], [1.9, 0.02, "1.90:1"], [2, 0.025, "2:1"], [2.2, 0.025, "2.20:1"], [2.35, 0.019, "2.35:1"], [2.39, 0.025, "2.39:1"], [2.76, 0.025, "2.76:1"]];
    return ratios;
  })();
  function qualityCss(overlayClass, containerClass, chipBaseCss) {
    const rules = Object.entries(qualityColors).map(([k, v]) => {
      return chipBaseCss(`.${overlayClass}`) + `.${containerClass} .${overlayClass}[data-quality="${k}"] {
                    background: ${v.bg} !important;
                    color: ${v.text} !important;
                }`;
    }).join("\n");
    return `
                .${containerClass} {
                    display: flex;
                    flex-direction: column;
                    gap: calc(4px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    align-items: flex-start;
                    z-index: 100;
                    max-width: calc(100% - 12px);
                    max-height: 90%;
                    overflow: hidden;
                    pointer-events: none;
                }


                .layout-mobile .${containerClass} {
                    gap: calc(2px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                }
                @media (min-width: 1440px) {

                    .${containerClass} {
                        gap: calc(6px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    }
                }
                @media (max-width: 768px) {

                    .${containerClass} {
                        gap: calc(1px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    }
                }
                @media (max-width: 480px) {

                    .${containerClass} {
                        gap: calc(1px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                        max-height: 85%;
                    }
                }
                /* Generic style for low resolution content */
                .${containerClass} .${overlayClass}[data-quality="LOW-RES"] {
                    background: rgba(128, 128, 128, 0.8) !important;
                    color: #ffffff !important;
                }
                .${overlayClass}[data-je-quality-category] {
                    background: rgba(55, 71, 79, 0.95) !important;
                    color: #ffffff !important;
                }
                ${rules}
                .${containerClass} .${overlayClass}[data-je-edition] {
                    background: rgba(106, 27, 154, 0.95) !important;
                    color: #ffffff !important;
                }
            `;
  }

  // client/src/features/media-tags/types/quality/quality-rules.ts
  function listed(value) {
    return value ? export7(value).map((member) => member === null || member === void 0 ? null : export10(member)) : null;
  }
  function createQualityRules(host) {
    function selectAudioStreamsForLanguage(audioStreams, preferred) {
      const secondary = host.language()?.isSecondaryAudio;
      if (typeof secondary === "function" && audioStreams.some((s) => !secondary(s))) audioStreams = audioStreams.filter((s) => !secondary(s));
      const match = host.language()?.matchesLanguage;
      if (!preferred || !audioStreams.length || typeof match !== "function") return audioStreams;
      const exact = audioStreams.filter((s) => match(s.Language, preferred, { requireRegion: true }));
      if (exact.length) return exact;
      const loose = audioStreams.filter((s) => match(s.Language, preferred));
      return loose.length ? loose : audioStreams;
    }
    function normalizeQualityLabel(label) {
      if (!label) return label;
      for (const base of AUDIO_BASES) {
        if (label === base || label.startsWith(`${base} `)) {
          return base;
        }
      }
      return label;
    }
    const LEGACY_STANDS_FOR = {
      "ATMOS": ["TRUEHD ATMOS", "DD+ ATMOS", "ATMOS"],
      "TRUEHD": ["TRUEHD", "TRUEHD ATMOS"],
      "DTS-X": ["DTS-X"],
      "DTS": ["DTS", "DTS-HD", "DTS-HD MA", "DTS-HD HRA", "DTS-X"],
      "Dolby Digital+": ["Dolby Digital+", "DD+ ATMOS"]
    };
    const LEGACY_BUCKETS = ["2.0", "5.1", "7.1"];
    const LEGACY_NAME = {
      "TRUEHD ATMOS": "ATMOS",
      "DD+ ATMOS": "ATMOS",
      "ATMOS": "ATMOS",
      "DTS-X": "DTS-X",
      "TRUEHD": "TRUEHD",
      "DTS-HD MA": "DTS",
      "DTS-HD HRA": "DTS",
      "DTS-HD": "DTS",
      "DTS": "DTS",
      "Dolby Digital+": "Dolby Digital+"
    };
    function legacyBucket(layout) {
      const total = String(layout || "").split(".").reduce((sum, part) => sum + (Number(part) || 0), 0);
      return total >= 8 ? "7.1" : total >= 6 ? "5.1" : total >= 2 ? "2.0" : null;
    }
    function truthfulLegacyAudio(codec, channels, streams) {
      const tracks = streams.map((stream) => ({ label: detectCurrentAudioCodec([stream]), bucket: legacyBucket(trackChannels(stream)), stream }));
      const holds = (track) => (codec === null || track.label !== null && (export9(LEGACY_STANDS_FOR, codec) || []).includes(track.label)) && (channels === null || LEGACY_BUCKETS.indexOf(track.bucket ?? "") >= LEGACY_BUCKETS.indexOf(channels));
      if (tracks.some(holds)) return { codec, channels };
      let best = null;
      for (const track of tracks) {
        const label = trackAudioLabel(track.stream);
        if (label && (best === null || distinctRank(label, "audio") < distinctRank(best.text, "audio"))) best = { text: label, track };
      }
      if (!best) return { codec: null, channels: null };
      return { codec: best.track.label === null ? null : export9(LEGACY_NAME, best.track.label) ?? null, channels: best.track.bucket };
    }
    function getChannelTag(audioStreams) {
      if (audioStreams.length === 0) return null;
      const rank = (tag) => tag === "7.1" ? 3 : tag === "5.1" ? 2 : 1;
      let maxChannels = 0;
      let detectedLayoutTag = null;
      for (const stream of audioStreams) {
        const channels = export2(stream.Channels) ?? 0;
        if (channels > maxChannels) {
          maxChannels = channels;
        }
        const layoutSignals = `${String(stream.ChannelLayout || "")} ${String(stream.DisplayTitle || "")}`.toLowerCase();
        let tag = null;
        if (/\b7[. ]?1\b/.test(layoutSignals)) {
          tag = "7.1";
        } else if (/\b5[. ]?1\b/.test(layoutSignals)) {
          tag = "5.1";
        } else if (/\bstereo\b|\b2[. ]?0\b/.test(layoutSignals)) {
          tag = "2.0";
        }
        const needs = tag === "7.1" ? 8 : tag === "5.1" ? 6 : 2;
        if (tag && channels > 0 && channels < needs) tag = null;
        if (tag && (!detectedLayoutTag || rank(tag) > rank(detectedLayoutTag))) {
          detectedLayoutTag = tag;
        }
      }
      if (detectedLayoutTag) {
        return detectedLayoutTag;
      }
      if (maxChannels >= 8) return "7.1";
      if (maxChannels >= 6) return "5.1";
      if (maxChannels >= 2) return "2.0";
      return null;
    }
    function versionCount(streams, sources) {
      const listed2 = new Set((sources || []).map((s) => s?.Id).filter(Boolean));
      return listed2.size || new Set((streams || []).map((s) => s?.SourceId).filter(Boolean)).size;
    }
    function technicalLabels(ticks, video) {
      const labels = [];
      const minutes = Math.floor(Number(ticks) / 6e8);
      if (Number.isFinite(minutes) && minutes > 0) labels.push("runtime:" + (minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`));
      if (!video) return labels;
      const parts = String(video.AspectRatio || "").trim().split(/[:/]/).map(Number);
      let ratio = parts.length === 1 ? parts[0] ?? 0 : parts.length === 2 ? (parts[0] ?? 0) / (parts[1] ?? 1) : 0;
      const width = export2(video.Width) ?? 0;
      const height = export2(video.Height) ?? 0;
      if (!Number.isFinite(ratio) || ratio <= 0) ratio = width > 0 && height > 0 ? width / height : 0;
      if (ratio >= 0.5 && ratio <= 4) {
        const snap = aspectRatios.filter(([value, tolerance]) => Math.abs(value - ratio) <= tolerance).sort((a, b) => Math.abs(a[0] - ratio) - Math.abs(b[0] - ratio))[0];
        labels.push("aspectRatio:" + (snap?.[2] || ratio.toFixed(2) + ":1"));
      }
      const real = Number(video.RealFrameRate);
      const rate = Number.isFinite(real) && real > 0 ? real : Number(video.AverageFrameRate);
      if (Number.isFinite(rate) && rate > 0 && rate <= 240) {
        const value = rate * (video.IsInterlaced === true ? 2 : 1);
        const snap = [24, 25, 30, 48, 50, 60, 100, 120, 144, 240].find((common) => Math.abs(value - common) <= 0.15);
        labels.push("frameRate:" + (snap || Number(value.toFixed(2))) + (video.IsInterlaced === true ? "i" : "p"));
      }
      return labels;
    }
    const AUDIO_ALIASES = [
      [/(?:^|[^a-z0-9_])(?:atmos|ddpa|joc)(?![a-z_])/, "ATMOS"],
      [/(?:^|[^a-z0-9_])true[ .-]?hd(?![a-z_])/, "TRUEHD"],
      [/(?:^|[^a-z0-9_])dts[-_.: ]?x7?(?![a-z_])(?![-_. ]?26[456])/, "DTS-X"],
      [/(?:^|[^a-z0-9_])dts[-_. ]?(?:hd[-_. ]?)?(?:hra?|hi|high[ -]?resolution)(?![a-z_])/, "DTS-HD HRA"],
      [/(?:^|[^a-z0-9_])dts[-_. ]?(?:hd[-_. ]?)?(?:ma|xll|master[ -]?audio)(?![a-z_])/, "DTS-HD MA"],
      [/(?:^|[^a-z0-9_])dts[-_. ]?hd(?![a-z_])/, "DTS-HD"],
      [/(?:^|[^a-z0-9_])dts[-_. ]?es(?![a-z_])/, "DTS"],
      [/(?:^|[^a-z0-9_])(?:dts|dca)(?![a-z_])/, "DTS"],
      [/(?:^|[^a-z0-9_])(?:ddp(?:lus)?|dd\+|e[-_. ]?ac-?3|dolby\s*digital(?:\s*plus|\s*\+))(?![a-z_])/, "Dolby Digital+"],
      [/(?:^|[^a-z0-9_])(?:dd(?!\s*\+)|dolby\s*digital(?!\s*(?:plus|\+)))(?![a-z_])|(?:^|[^a-z0-9_-])ac-?3(?![a-z_])/, "Dolby Digital"],
      [/(?:^|[^a-z0-9_])flac(?![a-z_])/, "FLAC"],
      [/(?:^|[^a-z0-9_])l?pcm(?![a-z])/, "PCM"]
    ];
    function audioCodecFromText(source) {
      const value = String(source || "").toLowerCase();
      return AUDIO_ALIASES.find(([pattern]) => pattern.test(value))?.[1] || null;
    }
    function detectCurrentAudioCodec(streams) {
      for (const stream of streams) {
        const title = audioCodecFromText(stream.DisplayTitle);
        if (!title) continue;
        const profile = audioCodecFromText([stream.Codec, stream.Profile].filter(Boolean).join(" "));
        const refined = profile !== null && DTS_PROFILES.includes(profile) && DTS_TITLES.includes(title) ? profile : audioCodecFromText([stream.DisplayTitle, stream.Codec, stream.Profile].filter(Boolean).join(" ")) || title;
        const label = [refined, title].map((candidate) => atmosCarrier(candidate, stream)).find((candidate) => carrierAllows(candidate, stream.Codec));
        if (label) return label;
      }
      for (const stream of streams) {
        const label = [audioCodecFromText([stream.Codec, stream.Profile].filter(Boolean).join(" ")), audioCodecFromText(stream.Codec)].filter((candidate) => !!candidate).map((candidate) => atmosCarrier(candidate, stream)).find((candidate) => carrierAllows(candidate, stream.Codec));
        if (label) return label;
      }
      return null;
    }
    const DTS_PROFILES = ["DTS-HD MA", "DTS-HD HRA"];
    const DTS_TITLES = ["DTS", "DTS-HD", "DTS-HD MA", "DTS-HD HRA"];
    const CARRIERS = [
      [/^(?:e-?ac-?3|ddp)/, ["Dolby Digital+", "DD+ ATMOS"]],
      [/^ac-?3$/, ["Dolby Digital"]],
      [/^(?:truehd|mlp)/, ["TRUEHD", "TRUEHD ATMOS"]],
      [/^(?:dts|dca)/, ["DTS", "DTS-HD", "DTS-HD MA", "DTS-HD HRA", "DTS-X"]],
      [/^flac/, ["FLAC"]],
      [/^pcm/, ["PCM"]],
      [/^(?:aac|opus|mp[23]|vorbis|alac|wmav)/, []]
    ];
    function carrierAllows(label, codec) {
      const known = CARRIERS.find(([pattern]) => pattern.test(String(codec || "").toLowerCase()));
      return !known || known[1].includes(label);
    }
    function atmosCarrier(label, stream) {
      if (label !== "ATMOS") return label;
      const codec = String(stream.Codec || "").toLowerCase();
      if (/^(?:truehd|mlp)/.test(codec)) return "TRUEHD ATMOS";
      if (/^(?:e-?ac-?3|ddp)/.test(codec)) return "DD+ ATMOS";
      const text = [stream.Codec, stream.Profile, stream.DisplayTitle].filter(Boolean).join(" ").toLowerCase();
      if (/(?:^|[^a-z0-9_])(?:true[ .-]?hd|mlp)(?![a-z_])/.test(text)) return "TRUEHD ATMOS";
      if (/(?:^|[^a-z0-9_])(?:e[-_. ]?ac-?3|ddp(?:a|lus)?|dd\+|dolby\s*digital\s*(?:plus|\+))(?![a-z_])/.test(text)) return "DD+ ATMOS";
      return label;
    }
    const NAMED_LAYOUTS = { mono: "1.0", stereo: "2.0", quad: "4.0", hexagonal: "6.0", octagonal: "8.0" };
    const COUNT_LAYOUTS = { 1: "1.0", 2: "2.0", 6: "5.1", 7: "6.1", 8: "7.1" };
    function trackChannels(stream) {
      const count = Number(stream.Channels) > 0 ? Number(stream.Channels) : 0;
      const agrees = (found) => {
        const [bed = 0, lfe = 0, height = 0] = found.split(".").map(Number);
        return !count || bed + lfe === count || bed + lfe + height === count;
      };
      const layout = String(stream.ChannelLayout || "").toLowerCase().replace(/\(.*\)$/, "").trim();
      const namedLayout = export9(NAMED_LAYOUTS, layout);
      if (namedLayout && agrees(namedLayout)) return namedLayout;
      const numeric = /^(\d)\.(\d)(?:\.(\d))?$/.exec(layout);
      if (numeric && agrees(numeric.slice(1).filter(Boolean).join("."))) return numeric.slice(1).filter(Boolean).join(".");
      const title = String(stream.DisplayTitle || "").toLowerCase();
      const named = /(?:^|[^a-z0-9_])([1-7])[. ]([01])(?:\.([246]))?(?![a-z0-9_])/.exec(title);
      const fromTitle = named ? named.slice(1).filter(Boolean).join(".") : /(?:^|[^a-z0-9_])stereo(?![a-z0-9_])/.test(title) ? "2.0" : /(?:^|[^a-z0-9_])mono(?![a-z0-9_])/.test(title) ? "1.0" : null;
      if (fromTitle && agrees(fromTitle)) return fromTitle;
      return export9(COUNT_LAYOUTS, String(stream.Channels)) || null;
    }
    function trackAudioLabel(stream) {
      const codec = detectCurrentAudioCodec([stream]);
      const channels = trackChannels(stream);
      if (!codec) {
        const bed = channels?.slice(0, 3);
        return bed && ["7.1", "6.1", "5.1"].includes(bed) ? bed : null;
      }
      return channels && !codec.includes(channels) ? `${codec} ${channels}` : codec;
    }
    function bestAudioLabel(streams) {
      let best = null;
      for (const stream of streams) {
        const label = trackAudioLabel(stream);
        if (label && (best === null || distinctRank(label, "audio") < distinctRank(best, "audio"))) best = label;
      }
      return best;
    }
    const RANGE_TYPES = {
      sdr: { range: null, base: null, sdr: true },
      hdr10: { range: "HDR10", base: null, sdr: false },
      hdr10plus: { range: "HDR10+", base: null, sdr: false },
      hlg: { range: "HLG", base: null, sdr: false },
      dovi: { range: "Dolby Vision", base: null, sdr: false },
      doviwithhdr10: { range: "Dolby Vision", base: "HDR10", sdr: false },
      doviwithhdr10plus: { range: "Dolby Vision", base: "HDR10+", sdr: false },
      doviwithhlg: { range: "Dolby Vision", base: "HLG", sdr: false },
      doviwithsdr: { range: "Dolby Vision", base: "SDR", sdr: false },
      doviwithel: { range: "Dolby Vision", base: "HDR10", sdr: false },
      doviwithelhdr10plus: { range: "Dolby Vision", base: "HDR10+", sdr: false }
    };
    function videoRangeFacts(video) {
      const type = String(video?.VideoRangeType || "").toLowerCase();
      const known = export9(RANGE_TYPES, type);
      if (known) return known;
      const title = `${String(video?.DisplayTitle || "")} ${type}`.toLowerCase();
      const word = (pattern) => new RegExp(`(?:^|[^a-z0-9_])(?:${pattern})(?![a-z0-9_])`).test(title);
      const hdr10Plus = /(?:^|[^a-z0-9_])hdr10(?:\+|plus(?![a-z0-9_]))/.test(title);
      if (type !== "doviinvalid" && word("dolby\\s*vision|dovi|dv")) {
        return { range: "Dolby Vision", base: hdr10Plus ? "HDR10+" : word("hdr10") ? "HDR10" : word("hlg") ? "HLG" : word("sdr") ? "SDR" : null, sdr: false };
      }
      if (hdr10Plus) return { range: "HDR10+", base: null, sdr: false };
      if (word("hdr10")) return { range: "HDR10", base: null, sdr: false };
      if (word("hlg")) return { range: "HLG", base: null, sdr: false };
      if (word("hdr")) return { range: "HDR", base: null, sdr: false };
      const coarse = String(video?.VideoRange || "").toLowerCase();
      if (coarse === "hdr") return { range: "HDR", base: null, sdr: false };
      return { range: null, base: null, sdr: word("sdr") || coarse === "sdr" };
    }
    function codecTitle(title) {
      return String(title || "").toLowerCase().replace(
        /(?<![a-z0-9])(h)[. ](26[456])(?![0-9])|(?<![a-z0-9])(vc|mpeg|vp)[-. ]([1-9])(?![a-z0-9])/g,
        (_, h, hn, w, wn) => h ? h + hn : w + wn
      );
    }
    function detectVideoCodec(video) {
      const current = [
        ["vvc", "VVC"],
        ["h266", "VVC"],
        ["hevc", "HEVC"],
        ["h265", "H265"],
        ["h264", "H264"],
        ["avc", "H264"],
        ["av1", "AV1"],
        ["vp9", "VP9"],
        ["vp8", "VP8"],
        ["xvid", "XVID"],
        ["divx", "DIVX"],
        ["wmv", "WMV"],
        ["vc1", "VC-1"],
        ["mpeg2", "MPEG2"],
        ["mpeg4", "MPEG4"],
        ["mjpeg", "MJPEG"],
        ["theora", "THEORA"],
        ["prores", "ProRes"]
      ];
      const codec = String(video.Codec || "").toLowerCase();
      const codecTag = String(video.CodecTag || "").toLowerCase();
      for (const [needle, label] of current) {
        if (codec.includes(needle)) return label;
        if (needle === "avc" && codecTag.includes("avc")) return label;
        if (needle === "xvid" && codecTag.includes("xvid")) return label;
        if (needle === "divx" && /divx|dx50|div[3-6]/.test(codecTag)) return label;
      }
      const displayTitle = codecTitle(video.DisplayTitle);
      return current.find(([needle]) => new RegExp(`(?:^|[^a-z0-9])${needle}(?![a-z0-9])`).test(displayTitle))?.[1] || null;
    }
    const RELEASE_GROUP = /(?<=(?:^|[. _\-[\](){}])(?:[xh]\.?26[45]|hevc|avc|av1|vp9|xvid|divx|mpeg2|aac|ac3|e?ac3|dts|ma|ddp?|flac|opus|atmos|truehd|\d\.\d|\d{3,4}p|web|webrip|web[. _\-[\]()]*dl|bluray|remux|hdtv|dvdrip|10bit|hdr|hdr10|dv|sdr))-[A-Za-z0-9]{2,}$/i;
    function withoutReleaseGroup(path) {
      if (!path) return path;
      const bare = (path.includes("://") ? path.split(/[?#]/)[0] : path) ?? path;
      const slash = bare.replace(/\\/g, "/").lastIndexOf("/");
      const file = bare.slice(slash + 1);
      const dot = file.lastIndexOf(".");
      const extension = dot > 0 && file.length - dot >= 2 && file.length - dot <= 5 ? file.slice(dot) : "";
      const stem = extension ? file.slice(0, -extension.length) : file;
      return bare.slice(0, slash + 1) + stem.replace(RELEASE_GROUP, "") + extension;
    }
    function interlacedLabel(tag, video) {
      return ["1080p", "576p", "480p"].includes(tag) && video?.IsInterlaced === true ? tag.slice(0, -1) + "i" : tag;
    }
    function getEnhancedQuality(rawStreams, rawSources, input = null, singleTrack = false, sourceId = "") {
      let itemData = input;
      if (!rawStreams && !rawSources && !itemData?.Source && !itemData?.Edition) return [];
      let mediaStreams = listed(rawStreams);
      let mediaSources = listed(rawSources);
      const versions = versionCount(mediaStreams, mediaSources);
      const probed = (id) => !!id && (mediaStreams?.some((s) => s?.SourceId === id && (s.Type === "Video" || s.Type === "Audio")) || export11(mediaSources?.find((s) => s?.Id === id)?.MediaStreams).some((s) => s.Type === "Video" || s.Type === "Audio"));
      const versionId = sourceId && (mediaStreams?.some((s) => s?.SourceId === sourceId) || mediaSources?.some((s) => s?.Id === sourceId)) ? sourceId : mediaSources?.find((s) => probed(s?.Id))?.Id || mediaSources?.find((s) => s?.Id)?.Id || mediaStreams?.find((s) => s?.SourceId)?.SourceId;
      if (versionId) {
        const version = mediaSources?.find((s) => s?.Id === versionId);
        const tagged = mediaStreams?.some((s) => s?.SourceId);
        if (tagged) mediaStreams = mediaStreams?.filter((s) => s?.SourceId === versionId) ?? null;
        else if (version?.MediaStreams) mediaStreams = listed(version.MediaStreams);
        if (version) mediaSources = [version];
        itemData = {
          ...itemData,
          ...version ? {
            Path: version.Path,
            RunTimeTicks: version.RunTimeTicks ?? itemData?.RunTimeTicks,
            Source: version.Source,
            Edition: version.Edition
          } : {},
          DistinctQualities: itemData?.DistinctQualities ? export7(itemData.DistinctQualities).map(export5).filter((q) => q.SourceId === versionId) : void 0
        };
      }
      const qualities = /* @__PURE__ */ new Set();
      let videoStreams = [];
      let audioStreams = [];
      if (mediaStreams) {
        const streams = mediaStreams.map(export5);
        videoStreams = streams.filter((s) => s.Type === "Video");
        audioStreams = streams.filter((s) => s.Type === "Audio");
      }
      if (mediaSources?.[0]?.MediaStreams) {
        const sourceStreams = export7(mediaSources[0].MediaStreams).map(export5);
        videoStreams = videoStreams.concat(sourceStreams.filter((s) => s.Type === "Video"));
        audioStreams = audioStreams.concat(sourceStreams.filter((s) => s.Type === "Audio"));
      }
      audioStreams = selectAudioStreamsForLanguage(audioStreams, host.preferredAudioLanguage());
      const primaryVideoStream = videoStreams[0];
      const legacyAudio = legacyFullAudio();
      for (const label of technicalLabels(itemData?.RunTimeTicks, primaryVideoStream)) qualities.add(label);
      const imaxSignals = [];
      if (itemData) {
        imaxSignals.push(
          itemData.Name || "",
          itemData.OriginalTitle || "",
          itemData.SortName || "",
          itemData.EditionTitle || "",
          itemData.ForcedSortName || ""
        );
      }
      if (Array.isArray(mediaSources)) {
        mediaSources.forEach((source) => {
          imaxSignals.push(withoutReleaseGroup(String(source?.Path || "")), source?.Name || "");
        });
      }
      if (Array.isArray(mediaStreams)) {
        mediaStreams.filter((stream) => stream?.Type === "Video").forEach((stream) => {
          imaxSignals.push(stream?.DisplayTitle || "", stream?.Title || "");
        });
      }
      const imaxContext = imaxSignals.filter(Boolean).join(" | ");
      const nonImaxRegex = /\bNON[ ._-]?IMAX\b/i;
      const imaxRegex = /\bIMAX(?:[ ._-]?ENHANCED)?\b/i;
      if (imaxContext && imaxRegex.test(imaxContext) && !nonImaxRegex.test(imaxContext)) {
        qualities.add("IMAX");
      }
      let resolutionTag = null;
      if (primaryVideoStream) {
        const displayTitle = String(primaryVideoStream.DisplayTitle || "");
        const resolutionRegex = /\b(8k|4320p|4k|2160p|1440p|1080p|1080i|720p|576p|576i|480p|480i|360p|404p|384p|520p)\b/i;
        const resolutionMatch = displayTitle.match(resolutionRegex);
        const streamHeight = export2(primaryVideoStream.Height) ?? 0;
        const streamWidth = export2(primaryVideoStream.Width) ?? 0;
        const knownSize = streamHeight > 0 || streamWidth > 0;
        if (resolutionMatch && !knownSize) {
          const found = (resolutionMatch[1] ?? "").toLowerCase();
          if (found === "8k" || found === "4320p") {
            resolutionTag = "8K";
          } else if (found === "4k" || found === "2160p") {
            resolutionTag = "4K";
          } else if (found === "1440p") {
            resolutionTag = "1440p";
          } else if (found === "1080p") {
            resolutionTag = "1080p";
          } else if (found === "720p") {
            resolutionTag = "720p";
          } else if (found === "576p") {
            resolutionTag = "576p";
          } else if (found === "480p") {
            resolutionTag = "480p";
          } else if (["1080i", "576i", "480i"].includes(found)) {
            resolutionTag = found;
          } else if (["360p", "404p", "384p", "520p"].includes(found)) {
            resolutionTag = "LOW-RES";
          }
          if (resolutionTag) qualities.add(interlacedLabel(resolutionTag, primaryVideoStream));
        } else {
          const portrait = streamHeight > streamWidth && streamWidth > 0;
          const height = portrait ? streamWidth : streamHeight;
          const width = portrait ? streamHeight : streamWidth;
          if (height >= 3e3 && (width >= 5e3 || width <= 0) || width >= 7e3) {
            resolutionTag = "8K";
          } else if (height >= 1550 && (width >= 2700 || width <= 0) || width >= 3500) {
            resolutionTag = "4K";
          } else if (height >= 1250) {
            resolutionTag = "1440p";
          } else if (height >= 1e3 || width >= 1800) {
            resolutionTag = "1080p";
          } else if (height >= 700 || width >= 1200) {
            resolutionTag = "720p";
          } else if (height >= 528) {
            resolutionTag = "576p";
          } else if (height >= 400 || width >= 640) {
            resolutionTag = "480p";
          } else if (height > 0) {
            resolutionTag = "LOW-RES";
          }
          if (resolutionTag) {
            qualities.add(interlacedLabel(resolutionTag, primaryVideoStream));
          }
        }
      }
      if (primaryVideoStream) {
        const detectedCodec = detectVideoCodec(primaryVideoStream);
        if (detectedCodec) qualities.add(detectedCodec);
      }
      if (primaryVideoStream) {
        const range = videoRangeFacts(primaryVideoStream).range;
        if (range) qualities.add(range);
      }
      let audioTag = null;
      if (!legacyAudio) {
        audioTag = bestAudioLabel(audioStreams);
        if (audioTag) qualities.add(audioTag);
      } else {
        for (let i = 0; i < audioStreams.length; i++) {
          const stream = export10(audioStreams[i]);
          const displayTitle = String(stream.DisplayTitle || "");
          const atmosRegex = /atmos/i;
          const truehd = /truehd/i;
          const dtsxRegex = /dts-x/i;
          const dtsRegex = /\bdts\b/i;
          const ddpRegex = /dolby\s*digital\+/i;
          const legacyAllows = (tag) => carrierAllows(tag === "ATMOS" ? "DD+ ATMOS" : tag, stream.Codec) || tag === "ATMOS" && carrierAllows("TRUEHD ATMOS", stream.Codec);
          const atmosMatch = displayTitle.match(atmosRegex);
          const truehdMatch = displayTitle.match(truehd);
          const dtsxMatch = displayTitle.match(dtsxRegex);
          const dtsMatch = displayTitle.match(dtsRegex);
          const ddpMatch = displayTitle.match(ddpRegex);
          const titled = atmosMatch ? "ATMOS" : truehdMatch ? "TRUEHD" : dtsxMatch ? "DTS-X" : dtsMatch ? "DTS" : ddpMatch ? "Dolby Digital+" : null;
          if (titled && legacyAllows(titled)) {
            audioTag = titled;
            break;
          }
        }
        if (!audioTag) {
          for (let i = 0; i < audioStreams.length; i++) {
            const stream = export10(audioStreams[i]);
            const codec = String(stream.Codec || "").toLowerCase();
            const profile = String(stream.Profile || "").toLowerCase();
            if (codec.includes("truehd") || profile.includes("truehd")) {
              if (codec.includes("atmos") || profile.includes("atmos")) {
                audioTag = "ATMOS";
              } else {
                audioTag = "TRUEHD";
              }
              break;
            } else if (codec.includes("dts")) {
              if (/(?:^|[^a-z0-9_])dts[-_.: ]?x(?![a-z0-9_])/.test(`${codec} ${profile}`)) {
                audioTag = "DTS-X";
              } else {
                audioTag = "DTS";
              }
              break;
            } else if (codec.includes("eac3") || codec.includes("ddp")) {
              audioTag = "Dolby Digital+";
              break;
            }
          }
        }
        let channelTag = getChannelTag(audioStreams);
        ({ codec: audioTag, channels: channelTag } = truthfulLegacyAudio(audioTag, channelTag, audioStreams));
        if (audioTag) {
          if (channelTag && !audioTag.includes(channelTag)) {
            audioTag = `${audioTag} ${channelTag}`;
          }
          qualities.add(audioTag);
        } else if (channelTag === "7.1" || channelTag === "5.1") {
          qualities.add(channelTag);
        }
      }
      if (mediaSources) {
        for (const member of mediaSources) {
          const source = export5(member);
          const path = withoutReleaseGroup(String(source.Path || "")).toLowerCase();
          const has3D = /(?:^|[^a-z0-9])3d(?![a-z0-9])/.test(path);
          const has3DFormat = /(?:^|[^a-z0-9])(?:hsbs|fsbs|htab|ftab|mvc)(?![a-z0-9])/.test(path);
          if (source.Is3D === true || source.Video3DFormat || has3D && has3DFormat) {
            qualities.add("3D");
            break;
          }
        }
      }
      const stubSignals = [];
      if (itemData) {
        stubSignals.push(
          itemData.Name || "",
          itemData.Path || ""
        );
      }
      if (Array.isArray(mediaSources)) {
        mediaSources.forEach((source) => {
          stubSignals.push(source?.Path || "", source?.Name || "");
        });
      }
      const stubContext = stubSignals.filter(Boolean).join(" | ").toLowerCase();
      if (/\.disc(?:$|\s*\|)/.test(stubContext)) {
        const blurayRegex = /bluray|blu-ray|bdrip|bd-rip|bdremux/;
        const hddvdRegex = /hddvd|hd-dvd|hd dvd/;
        const dvdRegex = /dvd|dvdrip|dvd-rip|dvdremux/;
        const vhsRegex = /vhs/;
        const hdtvRegex = /hdtv/;
        if (blurayRegex.test(stubContext)) {
          qualities.add("BluRay");
        } else if (hddvdRegex.test(stubContext)) {
          qualities.add("HD DVD");
        } else if (dvdRegex.test(stubContext)) {
          qualities.add("DVD");
        } else if (vhsRegex.test(stubContext)) {
          qualities.add("VHS");
        } else if (hdtvRegex.test(stubContext)) {
          qualities.add("HDTV");
        } else {
          qualities.add("Physical");
        }
      }
      const namedSource = export13(itemData?.Source);
      if (namedSource && sourceOrder.includes(namedSource)) {
        for (const source of sourceOrder) qualities.delete(source);
        qualities.add(namedSource);
      }
      if (itemData?.Edition) qualities.add(EDITION_PREFIX + String(itemData.Edition));
      if (!singleTrack && versions > 1) qualities.add(`versions:${versions}`);
      if (!singleTrack && displayModeKey() !== "000") {
        const distinct = itemData?.DistinctQualities ? export7(itemData.DistinctQualities) : distinctQualities(videoStreams, audioStreams);
        for (const category of ["audio", "videoCodec", "dynamicRange"]) {
          if (!allValues(category)) continue;
          for (const label of qualities) if (categorize(label) === category) qualities.delete(label);
          const facts = category === "audio" && legacyAudio ? distinctQualities([], audioStreams) : distinct;
          let values = facts.map(export5).filter((value) => value.Category === (category === "audio" ? "audioInfo" : category));
          if (category === "audio" && host.preferredAudioLanguage()) {
            const languages = new Set(audioStreams.map((stream) => stream.Language || null));
            values = values.filter((value) => languages.has(value.Language || null));
          }
          for (const value of values) qualities.add(export6(value.Label));
        }
      }
      return Array.from(qualities);
    }
    function allValues(category) {
      const key = category === "audio" ? "qualityAudioDisplayMode" : category === "videoCodec" ? "qualityVideoCodecDisplayMode" : category === "dynamicRange" ? "qualityHdrDisplayMode" : null;
      return !!key && host.setting(key) === "all";
    }
    function displayModeKey() {
      return ["audio", "videoCodec", "dynamicRange"].map((category) => allValues(category) ? "1" : "0").join("");
    }
    function distinctQualities(videos, audio) {
      const values = [];
      for (const stream of [...videos, ...audio]) {
        const labels = getEnhancedQuality([stream], null, null, true);
        const categories = stream.Type === "Video" ? ["videoCodec", "dynamicRange"] : ["audio"];
        for (const label of labels) {
          const category = categorize(label);
          if (category && categories.includes(category)) values.push({ Category: category === "audio" ? "audioInfo" : category, Label: label, Language: stream.Language });
        }
        if (stream.Type === "Video") {
          const facts = videoRangeFacts(stream);
          if (facts.base) values.push({ Category: "dynamicRange", Label: facts.base });
          else if (!facts.range && facts.sdr) values.push({ Category: "dynamicRange", Label: "SDR" });
        }
      }
      return values;
    }
    function distinctRank(label, category) {
      const index = CATEGORY_BY_KEY.get(category)?.items.indexOf(normalizeQualityLabel(label)) ?? -1;
      const layout = /(\d)\.(\d)(?:\.(\d))?$/.exec(label);
      const channels = layout ? layout.slice(1).reduce((sum, part) => sum + Number(part || 0), 0) : 0;
      if (category !== "audio") return (index < 0 ? 999 : index) * 100;
      const lossy = audioOrder.indexOf("Dolby Digital+");
      if (index >= lossy) return lossy * 100 + (99 - Math.min(channels, 99)) * 10 + (index - lossy);
      return (index < 0 ? 99900 : index * 100) + 99 - Math.min(channels, 99);
    }
    function meetsMinimum(label) {
      const threshold = host.setting("qualityMinimumResolution");
      const last = resolutionOrder.indexOf(threshold === "4k" ? "4K" : threshold === "1080p" ? "1080i" : threshold === "720p" ? "720p" : "");
      const index = resolutionOrder.indexOf(label);
      return last < 0 || index >= 0 && index <= last;
    }
    function aggregationPolicy() {
      const policy = host.setting("seriesQualityAggregation");
      return typeof policy === "string" && ["latest", "best", "shared", "mixed"].includes(policy) ? policy : "representative";
    }
    function aggregateQualities(entry, representative) {
      const policy = aggregationPolicy();
      const summary = entry.QualitySummary;
      if (entry.Type !== "Series" && entry.Type !== "Season" || !export42(summary) || policy === "representative") return representative;
      const categoryKeys = { resolution: "resolution", source: "source", dynamicRange: "dynamicRange", videoCodec: "videoCodec", audioInfo: "audio" };
      const qualities = (policy === "latest" ? export7(summary.LatestExtras) : representative.filter((label) => !Object.values(categoryKeys).includes(categorize(label) ?? ""))).map(export6).filter((label) => !label.startsWith("versions:"));
      const preferred = host.preferredAudioLanguage();
      const match = host.language()?.matchesLanguage;
      const audioVariants = Object.entries(export10(legacyFullAudio() ? summary.LegacyAudioByLanguage : summary.AudioByLanguage));
      const regionalFallbacks = Object.entries(export10(legacyFullAudio() ? summary.LegacyAudioRegionFallback : summary.AudioRegionFallback));
      const audio = preferred && typeof match === "function" ? (audioVariants.find(([language]) => match(language, preferred, { requireRegion: true })) || regionalFallbacks.find(([language]) => match(language, preferred)) || audioVariants.find(([language]) => !language.includes("-") && match(language, preferred)))?.[1] : null;
      let mixed = false;
      for (const [key, category] of Object.entries(export10(summary.Categories))) {
        const facts = export5(key === "audioInfo" ? audio || (legacyFullAudio() ? summary.LegacyAudio : category) || {} : category);
        const categoryKey = export9(categoryKeys, key) ?? "";
        const cat = CATEGORY_BY_KEY.get(categoryKey);
        if (allValues(categoryKey)) {
          qualities.push(...export7(policy === "latest" ? facts.LatestAll : policy === "shared" ? facts.Shared : facts.All).map(export6));
          mixed || (mixed = !facts.AllSetsAgree && !!cat && readBool(cat.settingKey, cat.fallback ?? true));
          continue;
        }
        const value = policy === "latest" ? facts.Latest : policy === "shared" && !facts.AllAgree ? null : facts.Best;
        if (typeof value === "string" && value) qualities.push(value);
        mixed || (mixed = !facts.AllAgree && !!cat && readBool(cat.settingKey, cat.fallback ?? true));
      }
      if (policy === "mixed" && Number(summary.EpisodeCount) > 1 && mixed) qualities.push("Mixed");
      return qualities;
    }
    function legacyFullAudio() {
      return host.legacyAudio();
    }
    function aggregationCategoriesKey() {
      return CATEGORIES.map((cat) => readBool(cat.settingKey, cat.fallback ?? true) ? "1" : "0").join("");
    }
    function readBool(userKey, fallback) {
      const userVal = host.setting(userKey);
      if (typeof userVal === "boolean") return userVal;
      return fallback;
    }
    function readInt(userKey, fallback) {
      const userVal = export2(host.setting(userKey));
      if (userVal !== null) return userVal;
      return fallback;
    }
    function categorize(tag) {
      for (const cat of CATEGORIES) if (!cat.items.length && tag.startsWith(cat.key + ":")) return cat.key;
      const norm = normalizeQualityLabel(tag);
      const direct = TAG_TO_CATEGORY.get(norm);
      if (direct) return direct;
      if (/^\d+\.\d+$/.test(tag)) return "audio";
      return null;
    }
    return { aggregateQualities, aggregationCategoriesKey, aggregationPolicy, allValues, categorize, displayModeKey, distinctRank, getEnhancedQuality, legacyFullAudio, meetsMinimum, normalizeQualityLabel, readBool, readInt };
  }

  // client/src/features/media-tags/types/quality/qualitytags.ts
  var CACHE_NAMING_VERSION = 26;
  function createQualityTags(JE) {
    const rules = createQualityRules({
      setting: (key) => JE.currentSettings?.[key] ?? JE.pluginConfig?.[key.charAt(0).toUpperCase() + key.slice(1)],
      preferredAudioLanguage: resolvePreferredAudioLanguage,
      legacyAudio: () => JE.core.tagLayout?.isLegacySettings() ?? true,
      language: () => JE.core.mediaLanguage
    });
    const { aggregateQualities, aggregationCategoriesKey, aggregationPolicy, allValues, categorize, displayModeKey, distinctRank, getEnhancedQuality, legacyFullAudio, meetsMinimum, normalizeQualityLabel, readBool, readInt } = rules;
    const logPrefix = "🪼 Jellyfin Enhanced: Quality Tags:";
    const overlayClass = "quality-overlay-label";
    const containerClass = "quality-overlay-container";
    const serverQualityCache = /* @__PURE__ */ new Map();
    let jellyfinAudioPreference = null;
    let jellyfinAudioPreferenceUserId = null;
    let jellyfinAudioPreferencePromise = null;
    let jellyfinAudioPreferencePromiseUserId = null;
    const currentUserId = () => export1() ? export0().getCurrentUserId?.() || null : null;
    function resolvePreferredAudioLanguage() {
      const choice = String(JE.currentSettings?.qualityTagsPreferredAudioLanguage || "").trim();
      const lowered = choice.toLowerCase();
      if (lowered === "none") return null;
      const userId = currentUserId();
      const jellyfinPref = userId && userId === jellyfinAudioPreferenceUserId ? jellyfinAudioPreference : null;
      if (lowered === "auto") return jellyfinPref;
      if (choice) return choice;
      if (JE.pluginConfig?.QualityTagsAudioLanguageFromUser && jellyfinPref) return jellyfinPref;
      return String(JE.pluginConfig?.QualityTagsPreferredAudioLanguage || "").trim() || null;
    }
    function usesJellyfinAudioPreference() {
      const choice = String(JE.currentSettings?.qualityTagsPreferredAudioLanguage || "").trim().toLowerCase();
      if (choice === "auto") return true;
      return !choice && !!JE.pluginConfig?.QualityTagsAudioLanguageFromUser;
    }
    function primeJellyfinAudioPreference() {
      const userId = currentUserId();
      if (!userId || !usesJellyfinAudioPreference()) return Promise.resolve();
      if (jellyfinAudioPreferencePromise && jellyfinAudioPreferencePromiseUserId === userId) {
        return jellyfinAudioPreferencePromise;
      }
      const request = Promise.resolve().then(() => export0().getUser(userId)).then((user) => {
        if (currentUserId() !== userId) return;
        jellyfinAudioPreference = String(export10(export10(user).Configuration).AudioLanguagePreference || "").trim() || null;
        jellyfinAudioPreferenceUserId = userId;
      }).catch((err) => {
        console.warn(`${logPrefix} Could not read the Jellyfin audio language preference`, err);
        if (currentUserId() === userId && jellyfinAudioPreferenceUserId !== userId) {
          jellyfinAudioPreference = null;
          jellyfinAudioPreferenceUserId = userId;
        }
      }).finally(() => {
        if (jellyfinAudioPreferencePromise === request) {
          jellyfinAudioPreferencePromise = null;
          jellyfinAudioPreferencePromiseUserId = null;
        }
      });
      jellyfinAudioPreferencePromise = request;
      jellyfinAudioPreferencePromiseUserId = userId;
      return request;
    }
    function isAudioPreferencePending() {
      const userId = currentUserId();
      return !!userId && jellyfinAudioPreferencePromiseUserId === userId && jellyfinAudioPreferenceUserId !== userId && usesJellyfinAudioPreference();
    }
    let playbackPreferencesWatched = false;
    function watchPlaybackPreferencesPage() {
      if (playbackPreferencesWatched || typeof JE.core?.navigation?.onNavigate !== "function") return;
      playbackPreferencesWatched = true;
      const isPlaybackPreferences = () => /mypreferencesplayback/i.test(window.location.href);
      let onPage = isPlaybackPreferences();
      JE.core.navigation.onNavigate(() => {
        const wasOnPage = onPage;
        onPage = isPlaybackPreferences();
        if (!wasOnPage || onPage) return;
        if (!JE.currentSettings?.qualityTagsEnabled || !usesJellyfinAudioPreference()) return;
        const before = resolvePreferredAudioLanguage();
        primeJellyfinAudioPreference().then(() => {
          if (resolvePreferredAudioLanguage() !== before) JE.core.tagRenderer.reinitialize("quality", spec);
        });
      });
    }
    function audioPreferenceKey() {
      return resolvePreferredAudioLanguage() || "";
    }
    function matchesAudioPreference(entry) {
      return entry.namingVersion === CACHE_NAMING_VERSION && entry.legacyAudio === legacyFullAudio() && entry.displayModeKey === displayModeKey() && (entry.audioLang || "") === audioPreferenceKey();
    }
    const SOURCE_PREF_KEY = "je-quality-source";
    const SOURCE_PREF_MAX = 500;
    function sourcePrefKey() {
      const userId = JE.session?.getUserId?.() || "";
      return userId ? `${SOURCE_PREF_KEY}:${JE.session?.getServerId?.() || ""}:${userId}` : "";
    }
    function normItemId(id) {
      return String(id || "").toLowerCase().replace(/[^0-9a-f]/g, "");
    }
    let sourcePrefs = /* @__PURE__ */ new Map();
    let sourcePrefsMemoryOnly = false;
    let sourcePrefsOwner = null;
    function readSourcePrefs() {
      const key = sourcePrefKey();
      if (key !== sourcePrefsOwner) {
        sourcePrefsOwner = key;
        sourcePrefs = /* @__PURE__ */ new Map();
        sourcePrefsMemoryOnly = !key;
        try {
          localStorage.removeItem(SOURCE_PREF_KEY);
        } catch {
        }
      }
      if (sourcePrefsMemoryOnly) return sourcePrefs;
      try {
        const parsed = JSON.parse(localStorage.getItem(key) || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          sourcePrefs = /* @__PURE__ */ new Map();
          for (const [key2, value] of Object.entries(parsed)) {
            if (typeof value !== "string" || ["__proto__", "constructor", "prototype"].includes(key2.toLowerCase())) continue;
            const id = normItemId(key2);
            if (id) sourcePrefs.set(id, value);
          }
        }
        return sourcePrefs;
      } catch {
        return sourcePrefs;
      }
    }
    function selectedSourceFor(itemId) {
      const id = normItemId(itemId);
      return id ? readSourcePrefs().get(id) || "" : "";
    }
    JE.selectedMediaSource = selectedSourceFor;
    function rememberSource(itemId, sourceId) {
      const id = normItemId(itemId);
      if (!id) return;
      const prefs = readSourcePrefs();
      prefs.delete(id);
      prefs.set(id, sourceId);
      for (const oldest of prefs.keys()) {
        if (prefs.size <= SOURCE_PREF_MAX) break;
        prefs.delete(oldest);
      }
      if (sourcePrefsMemoryOnly || !sourcePrefsOwner) return;
      try {
        localStorage.setItem(sourcePrefsOwner, JSON.stringify(Object.fromEntries(prefs)));
      } catch {
        sourcePrefsMemoryOnly = true;
      }
    }
    function matchesCache(entry, itemId) {
      return matchesAudioPreference(entry) && (entry.srcId || "") === selectedSourceFor(itemId);
    }
    function createResponsiveLabel(label) {
      const normalizedLabel = normalizeQualityLabel(label);
      const badge = document.createElement("div");
      const category = categorize(label);
      const technical = category !== null && ["runtime", "aspectRatio", "frameRate", "versions"].includes(category);
      const edition = label.startsWith(EDITION_PREFIX);
      const displayLabel = edition || technical ? label.slice(label.indexOf(":") + 1) : label;
      badge.textContent = edition ? editionLabel(displayLabel) : category === "versions" ? versionsText(displayLabel) : category === "runtime" ? runtimeText(displayLabel, false) : displayLabel;
      if (technical && category) {
        badge.dataset.jeQualityCategory = category;
        badge.dataset.jeCompact = category === "versions" ? `×${displayLabel}` : compactTechnical(displayLabel, category);
        badge.title = badge.textContent;
      }
      badge.className = overlayClass;
      if (label === "Mixed") badge.textContent = JE.t("series_quality_mixed");
      if (label === "Mixed") {
        badge.classList.add("mixed");
        badge.dataset.jeCompact = JE.t("series_quality_mixed_compact");
        badge.title = JE.t("series_quality_mixed");
      }
      if (resolutionOrder.includes(normalizedLabel)) {
        badge.classList.add("resolution");
      } else if (codecOrder.includes(normalizedLabel)) {
        badge.classList.add("video-format");
      } else if (dynamicRangeOrder.includes(normalizedLabel) || specialFormatOrder.includes(normalizedLabel)) {
        badge.classList.add("video-codec");
      } else if (audioOrder.includes(normalizedLabel)) {
        badge.classList.add("audio-codec");
      } else {
        badge.classList.add("other-quality");
      }
      badge.dataset.quality = (technical ? category : edition ? displayLabel : normalizedLabel) ?? "";
      if (edition) {
        badge.dataset.jeEdition = "true";
        badge.dataset.jeCompact = compactEditionLabel(displayLabel);
      }
      return badge;
    }
    function editionLabel(label) {
      const row = export9(EDITIONS, label);
      return row?.[0] ? JE.t(row[0]) : label;
    }
    function compactEditionLabel(label) {
      const row = export9(EDITIONS, label);
      return row?.[1] ? row[1].startsWith("quality_") ? JE.t(row[1]) : row[1] : editionLabel(label);
    }
    function versionsText(count) {
      const n = Number(count);
      const text = JE.t("quality_versions_count", { count: Number.isFinite(n) ? n : count });
      return (text === "quality_versions_count" ? "{count} versions" : text).replace("{count}", count);
    }
    function runtimeText(label, compact) {
      const say = (key, params, fallback) => {
        const text = JE.t(key, params);
        return text === key ? fallback : Object.entries(params).reduce((out, [name, value]) => out.replace(`{${name}}`, value), text);
      };
      const hours = /^(\d+)h (\d+)m$/.exec(label);
      if (hours?.[1] && hours[2]) return say(compact ? "quality_runtime_hours_compact" : "quality_runtime_hours", { hours: hours[1], minutes: hours[2] }, compact ? `${hours[1]}h${hours[2]}` : label);
      const minutes = /^(\d+)m$/.exec(label);
      return minutes?.[1] ? say("quality_runtime_minutes", { minutes: minutes[1] }, label) : label;
    }
    function compactTechnical(label, category) {
      if (category === "runtime") return runtimeText(label, true);
      if (category === "aspectRatio") return label.replace(/^IMAX /, "").replace(/:1$/, "");
      return label;
    }
    function qualitiesFromCache(cached, itemId) {
      if (!export42(cached) || !matchesCache(cached, itemId)) return null;
      if (cached.aggregationPolicy === aggregationPolicy() && cached.aggregationCategories === aggregationCategoriesKey() || cached.type && cached.type !== "Series" && cached.type !== "Season") return export12(cached.qualities);
      if (!cached.qualitySummary) return null;
      return aggregateQualities({ Type: cached.type, QualitySummary: cached.qualitySummary }, export12(cached.representativeQualities));
    }
    function insertOverlay(ctx, container, qualities) {
      if (!container) return;
      ctx.removeExistingOverlay(container);
      const buckets = /* @__PURE__ */ new Map();
      const otherBucket = [];
      for (const q of new Set(qualities)) {
        if (q === "SDR" && readBool("qualityHideSdr", false)) continue;
        if (categorize(q) === "resolution" && !meetsMinimum(q)) continue;
        if (["CAM", "TS", "TC", "SCR"].includes(q) && !readBool("showLowQualitySourceTag", false)) continue;
        if (q === EDITION_PREFIX + "IMAX" && qualities.includes("IMAX") && readBool("showSpecialFormatTag", true)) continue;
        const catKey = categorize(q);
        if (catKey) {
          const cat = CATEGORY_BY_KEY.get(catKey);
          if (cat && !readBool(cat.settingKey, cat.fallback ?? true)) continue;
          const bucket = buckets.get(catKey);
          if (bucket) bucket.push(q);
          else buckets.set(catKey, [q]);
        } else {
          otherBucket.push(q);
        }
      }
      if (buckets.size === 0 && otherBucket.length === 0) {
        const card = container.closest(".card");
        if (card instanceof HTMLElement) delete card.dataset[ctx.taggedAttr];
        return;
      }
      for (const [catKey, tags] of buckets) {
        const cat = CATEGORY_BY_KEY.get(catKey);
        tags.sort((a, b) => {
          if (allValues(catKey)) return distinctRank(a, catKey) - distinctRank(b, catKey) || (a < b ? -1 : a > b ? 1 : 0);
          const aKey = normalizeQualityLabel(a);
          const bKey = normalizeQualityLabel(b);
          const aIdx = cat?.items.indexOf(aKey) ?? -1;
          const bIdx = cat?.items.indexOf(bKey) ?? -1;
          return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
        });
        if (catKey === "resolution" && tags.length > 1) tags.length = 1;
      }
      const categoriesSorted = [...buckets.keys()].map((key) => {
        const cat = CATEGORY_BY_KEY.get(key);
        const defaultOrder = cat?.defaultOrder ?? 0;
        return { key, defaultOrder, order: cat ? readInt(cat.orderUserKey, defaultOrder) : defaultOrder };
      }).sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return a.defaultOrder - b.defaultOrder;
      });
      if (container.style.position !== "relative") container.style.position = "relative";
      const qualityContainer = document.createElement("div");
      qualityContainer.className = containerClass;
      for (const { key } of categoriesSorted) {
        for (const q of buckets.get(key) ?? []) {
          qualityContainer.appendChild(createResponsiveLabel(q));
        }
      }
      for (const q of otherBucket) {
        qualityContainer.appendChild(createResponsiveLabel(q));
      }
      ctx.commitOverlay(container, qualityContainer);
    }
    const spec = {
      logPrefix,
      settingKey: "qualityTagsEnabled",
      containerClass,
      taggedAttr: "jeQualityTagged",
      styleId: "quality-tag-enhanced-style",
      position: { userKey: "qualityTagsPosition", pluginKey: "QualityTagsPosition", fallback: "top-left" },
      cache: {
        // Static cache key (not version-based) to persist across plugin updates
        key: "JellyfinEnhanced-qualityTagsCache",
        legacyPrefix: "qualityOverlayCache",
        hotBucket: "quality",
        pruneOnSave: true
      },
      buildCss() {
        return qualityCss(overlayClass, containerClass, JE.core.tagRenderer.chipBaseCss);
      },
      pipeline: {
        needsFirstEpisode: true,
        needsParentSeries: false,
        render(ctx, el, item, extras) {
          if (ctx.shouldIgnore(el)) return;
          if (ctx.isTagged(el)) return;
          if (el.closest(".je-hidden")) return;
          if (isAudioPreferencePending()) return;
          const itemId = String(item.Id);
          const hot = export10(ctx.hot?.get(itemId));
          const hotQualities = typeof hot.timestamp === "number" && Date.now() - hot.timestamp < ctx.cacheTtl ? qualitiesFromCache(hot, itemId) : null;
          if (hotQualities) {
            if (hotQualities.length) insertOverlay(ctx, el, hotQualities);
            return;
          }
          let qualities = [];
          const srcId = selectedSourceFor(itemId);
          if (item.Type === "Series" || item.Type === "Season") {
            if (extras.firstEpisode) {
              qualities = getEnhancedQuality(extras.firstEpisode.MediaStreams, extras.firstEpisode.MediaSources, extras.firstEpisode).filter((label) => !label.startsWith("versions:"));
            }
          } else {
            qualities = getEnhancedQuality(item.MediaStreams, item.MediaSources, item, false, srcId);
          }
          const representativeQualities = qualities;
          qualities = aggregateQualities(item, qualities);
          {
            const audioLang = audioPreferenceKey();
            const record = {
              qualities,
              representativeQualities,
              type: item.Type,
              qualitySummary: item.QualitySummary,
              namingVersion: CACHE_NAMING_VERSION,
              legacyAudio: legacyFullAudio(),
              displayModeKey: displayModeKey(),
              timestamp: Date.now(),
              audioLang,
              srcId,
              aggregationPolicy: aggregationPolicy(),
              aggregationCategories: aggregationCategoriesKey()
            };
            ctx.setPersistent(itemId, record);
            ctx.hot?.set(itemId, record);
            if (qualities.length) insertOverlay(ctx, el, qualities);
          }
        },
        renderFromCache(ctx, el, itemId) {
          if (ctx.isTagged(el)) return true;
          if (ctx.shouldIgnore(el)) return true;
          if (el.closest(".je-hidden")) return true;
          if (isAudioPreferencePending()) return true;
          const hot = ctx.hot?.get(itemId);
          const cached = hot || ctx.getPersistent(itemId);
          const qualities = qualitiesFromCache(cached, itemId);
          if (qualities) {
            if (qualities.length) insertOverlay(ctx, el, qualities);
            return true;
          }
          return false;
        },
        renderFromServerCache(ctx, el, entry, itemId) {
          if (ctx.isTagged(el)) return;
          if (ctx.shouldIgnore(el)) return;
          if (isAudioPreferencePending()) return;
          const cached = serverQualityCache.get(itemId);
          if (cached && cached.entry === entry && matchesCache(cached, itemId) && cached.aggregationPolicy === aggregationPolicy() && cached.aggregationCategories === aggregationCategoriesKey()) {
            if (cached.qualities.length > 0) insertOverlay(ctx, el, cached.qualities);
            return;
          }
          const audioLang = audioPreferenceKey();
          const srcId = selectedSourceFor(itemId);
          const sd = export10(entry.StreamData);
          const representative = getEnhancedQuality(sd.Streams, sd.Sources, { Name: sd.ItemName, Path: sd.ItemPath, RunTimeTicks: sd.RunTimeTicks, Source: entry.Source, Edition: entry.Edition, DistinctQualities: sd.DistinctQualities }, false, srcId).filter((label) => !(entry.Type === "Series" || entry.Type === "Season") || !label.startsWith("versions:"));
          const qualities = aggregateQualities(entry, representative);
          serverQualityCache.set(itemId, { audioLang, srcId, qualities, entry, namingVersion: CACHE_NAMING_VERSION, legacyAudio: legacyFullAudio(), displayModeKey: displayModeKey(), aggregationPolicy: aggregationPolicy(), aggregationCategories: aggregationCategoriesKey() });
          if (qualities.length > 0) insertOverlay(ctx, el, qualities);
        },
        onServerCacheRefresh(ctx, updatedIds) {
          if (!updatedIds) {
            serverQualityCache.clear();
            return;
          }
          updatedIds.forEach(function(id) {
            serverQualityCache.delete(id);
          });
        }
      }
    };
    function withJellyfinAudioPreference(render) {
      if (!usesJellyfinAudioPreference()) {
        render();
        return;
      }
      primeJellyfinAudioPreference().then(render);
    }
    let versionPickerWatched = false;
    let versionPickerTimer;
    function watchVersionPicker() {
      if (versionPickerWatched) return;
      versionPickerWatched = true;
      const detailId = () => new URLSearchParams(location.hash.split("?")[1] || "").get("id");
      JE.session?.onUserChange?.("quality-version-picker", () => clearInterval(versionPickerTimer));
      document.addEventListener("change", (e) => {
        const select = e.target;
        if (!(select instanceof HTMLSelectElement) || !select.classList.contains("selectSource") || !select.value) return;
        const id = detailId();
        if (!id || selectedSourceFor(id) === select.value) return;
        rememberSource(id, select.value);
        JE.core.tagRenderer.reinitialize("quality", spec);
      });
      document.addEventListener("viewshow", () => {
        clearInterval(versionPickerTimer);
        const id = detailId();
        const want = id && selectedSourceFor(id);
        if (!want) return;
        const owner = sourcePrefKey();
        let tries = 0;
        const timer = versionPickerTimer = setInterval(() => {
          if (detailId() !== id || sourcePrefKey() !== owner) {
            clearInterval(timer);
            return;
          }
          const select = document.querySelector("#itemDetailPage:not(.hide) .selectSource");
          if (select && select.options.length > 1) {
            clearInterval(timer);
            if (select.value !== want && [...select.options].some((o) => o.value === want)) {
              select.value = want;
              select.dispatchEvent(new Event("change", { bubbles: true }));
            }
          } else if (++tries > 20) {
            clearInterval(timer);
          }
        }, 300);
      });
    }
    JE.initializeQualityTags = function() {
      watchPlaybackPreferencesPage();
      watchVersionPicker();
      withJellyfinAudioPreference(() => JE.core.tagRenderer.register("quality", spec));
    };
    JE.reinitializeQualityTags = function() {
      watchPlaybackPreferencesPage();
      withJellyfinAudioPreference(() => JE.core.tagRenderer.reinitialize("quality", spec));
    };
    JE.core.tagRenderer.registerStyles(spec);
  }

  // client/src/features/media-tags/types/quality/qualitytags-entry.ts
  createQualityTags(export4());
})();
})();
//# sourceMappingURL=qualitytags.js.map
