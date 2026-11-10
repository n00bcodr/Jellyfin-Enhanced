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
  var export42 = /* @__PURE__ */ sharedExport(shared2, "isRecord");
  var export9 = /* @__PURE__ */ sharedExport(shared2, "own");
  var export10 = /* @__PURE__ */ sharedExport(shared2, "record");
  var export11 = /* @__PURE__ */ sharedExport(shared2, "records");
  var export12 = /* @__PURE__ */ sharedExport(shared2, "stringList");

  // client/src/features/media-tags/types/direct-play/device-profile.ts
  function profileWindow() {
    return window;
  }
  function browserFlags(userAgent) {
    const nav = typeof navigator !== "undefined" ? navigator : {};
    const raw = userAgent ?? nav.userAgent ?? "";
    const ua = raw.toLowerCase().replace(/(motorola edge)/, "").trim();
    const match = /(edg)[ /]([\w.]+)/.exec(ua) || /(edga)[ /]([\w.]+)/.exec(ua) || /(edgios)[ /]([\w.]+)/.exec(ua) || /(edge)[ /]([\w.]+)/.exec(ua) || /(titanos)[ /]([\w.]+)/.exec(ua) || /(opera)[ /]([\w.]+)/.exec(ua) || /(opr)[ /]([\w.]+)/.exec(ua) || /(chrome)[ /]([\w.]+)/.exec(ua) || /(safari)[ /]([\w.]+)/.exec(ua) || /(firefox)[ /]([\w.]+)/.exec(ua) || !ua.includes("compatible") && /(mozilla)(?:.*? rv:([\w.]+)|)/.exec(ua) || [];
    const versionMatch = /(version)[ /]([\w.]+)/.exec(ua);
    let platform = (/(ipad)/.exec(ua) || /(iphone)/.exec(ua) || /(windows)/.exec(ua) || /(android)/.exec(ua) || /(titanos)/.exec(ua) || [])[0] || "";
    let name = match[1] || "";
    if (name === "edge") platform = "";
    if (name === "opr") name = "opera";
    const version = (versionMatch && versionMatch.length > 2 ? versionMatch[2] : null) || match[2] || "0";
    const b = {};
    if (name) {
      b[name] = true;
      b.versionMajor = parseInt(version.split(".")[0] ?? "", 10) || 0;
    }
    if (platform) b[platform] = true;
    b.edgeChromium = !!(b.edg || b.edga || b.edgios);
    if (!b.chrome && !b.edgeChromium && !b.edge && !b.opera && ua.includes("webkit")) b.safari = true;
    b.osx = ua.includes("mac os x");
    if (b.osx && !b.iphone && !b.ipod && !b.ipad && (nav.maxTouchPoints || 0) > 1) b.ipad = true;
    b.mobile = ["mobi", "ipad", "iphone", "ipod", "silk", "gt-p1000", "nexus 7", "kindle fire", "opera mini"].some((t) => ua.includes(t));
    b.ps4 = ua.includes("playstation 4");
    b.xboxOne = ua.includes("xbox");
    b.tizen = ua.includes("tizen") || typeof window !== "undefined" && profileWindow().tizen != null;
    b.vidaa = ua.includes("vidaa");
    b.web0s = ua.includes("netcast") || ua.includes("web0s");
    b.tv = b.ps4 || ua.includes("kepler") || b.xboxOne || !ua.includes("oculusbrowser") && (ua.includes("tv") || ua.includes("samsungbrowser") || ua.includes("viera") || ua.includes("titanos") || b.web0s);
    b.edgeUwp = (b.edge || b.edgeChromium) && (ua.includes("msapphost") || ua.includes("webview"));
    if (b.web0s || b.tizen) {
      delete b.chrome;
      delete b.safari;
    }
    b.iOS = !!(b.ipad || b.iphone || b.ipod);
    if (b.iOS) {
      const os = /OS (\d+)_(\d+)_?(\d+)?/.exec(nav.appVersion || raw) || /Version\/(\d+)/.exec(nav.appVersion || raw);
      if (os) b.iOSVersion = parseInt(os[1] ?? "", 10) + parseInt(os[2] || "0", 10) / 10;
    }
    return b;
  }
  function flag(value, fallback) {
    return value === "true" ? true : value === "false" ? false : fallback;
  }
  function can(el, type) {
    try {
      return !!(el && typeof el.canPlayType === "function" && String(el.canPlayType(type)).replace(/no/, ""));
    } catch {
      return false;
    }
  }
  function webProfile(settings, options = {}, b = browserFlags()) {
    const versionMajor = b.versionMajor ?? Number.NaN;
    const iOSVersion = b.iOSVersion ?? Number.NaN;
    const doc = typeof document !== "undefined" ? document : null;
    const v = doc ? doc.createElement("video") : null;
    const audioEl = doc ? doc.createElement("audio") : null;
    const has = (type) => can(v, type);
    const canPlayHevc = () => {
      if (b.tizen || b.xboxOne || b.web0s || options.supportsHevc) return true;
      if (b.ps4) return false;
      return has('video/mp4; codecs="hvc1.1.L120"') || has('video/mp4; codecs="hev1.1.L120"') || has('video/mp4; codecs="hvc1.1.0.L120"') || has('video/mp4; codecs="hev1.1.0.L120"');
    };
    const canPlayAv1 = () => b.xboxOne ? false : has('video/mp4; codecs="av01.0.15M.08"') && has('video/mp4; codecs="av01.0.15M.10"');
    const canPlayNativeHls = () => b.tizen || has("application/x-mpegURL") || has("application/vnd.apple.mpegURL");
    const canPlayHls = canPlayNativeHls() || typeof window !== "undefined" && window.MediaSource != null;
    const canPlayNativeHlsInFmp4 = () => b.iOS && iOSVersion >= 11 || b.osx;
    const supportsAc3 = () => b.edgeUwp || b.tizen || b.web0s ? true : b.iOS && iOSVersion < 11 ? false : has('audio/mp4; codecs="ac-3"');
    const supportsEac3 = () => b.tizen || b.web0s ? true : b.iOS && iOSVersion < 11 ? false : has('audio/mp4; codecs="ec-3"');
    const canPlayDts = () => has('video/mp4; codecs="dts-"') || has('video/mp4; codecs="dts+"') ? true : null;
    const supportsAc3InHls = () => b.tizen || b.web0s ? true : has('application/x-mpegurl; codecs="avc1.42E01E, ac-3"') || has('application/vnd.apple.mpegURL; codecs="avc1.42E01E, ac-3"');
    const supportsMp3InHls = () => has('application/x-mpegurl; codecs="avc1.64001E, mp4a.40.34"') || has('application/vnd.apple.mpegURL; codecs="avc1.64001E, mp4a.40.34"');
    const canPlayAudioFormat = (format) => {
      let type;
      if (format === "flac" || format === "asf") {
        if (b.tizen || b.web0s || b.edgeUwp) return true;
      } else if (format === "wma") {
        if (b.tizen || b.edgeUwp) return true;
      } else if (format === "opus") {
        if (b.web0s) return false;
        if (b.xboxOne) return false;
        type = 'audio/ogg; codecs="opus"';
      } else if (format === "alac") {
        if (b.iOS || b.osx && b.safari) return true;
      } else if (format === "mp2") return false;
      if (format === "webma") type = "audio/webm";
      else if (!type) type = "audio/" + format;
      return can(audioEl, type);
    };
    const canPlayMkv = (() => {
      if (b.vidaa) return false;
      if (b.tizen || b.web0s) return true;
      if (b.firefox) return false;
      if (has("video/x-matroska") || has("video/mkv")) return true;
      if (b.edgeChromium && b.windows) return true;
      return !!b.edgeUwp;
    })();
    const supportsMpeg2Video = () => b.tizen || b.web0s || b.edgeUwp;
    const supportsVc1 = () => b.tizen || b.web0s || b.edgeUwp || has('video/mp4; codecs="vc-1"');
    const supportsHdr10 = options.supportsHdr10 ?? !!(b.vidaa || b.tizen || b.web0s || b.safari && (b.iOS && iOSVersion >= 11 || b.osx) || b.edgeChromium && versionMajor >= 121 || b.chrome && !b.mobile || b.firefox && b.osx && !b.iphone && !b.ipod && !b.ipad && versionMajor >= 100);
    const supportsHlg = options.supportsHlg ?? supportsHdr10;
    const supportsDolbyVision = options.supportsDolbyVision ?? !!(b.safari && (b.iOS && iOSVersion >= 13 || b.osx));
    const supportsAnamorphic = !!(b.chrome || b.firefox || b.safari || b.edgeChromium || b.edgeUwp || b.iOS || b.android);
    const supportsTextTracks = b.tizen || (v ? v.textTracks != null : false);
    const supportsCanvas2D = () => {
      try {
        return !!doc?.createElement("canvas").getContext("2d");
      } catch {
        return false;
      }
    };
    const supportsSecondaryAudio = !!(v && "audioTracks" in v && v.audioTracks) && !b.firefox;
    const allowedChannels = parseInt(settings.user("allowedAudioChannels") || "-1", 10);
    const physicalAudioChannels = (() => {
      if (allowedChannels > 0) return allowedChannels;
      if (options.audioChannels) return options.audioChannels;
      const surround = b.safari || b.chrome || b.edgeChromium || b.firefox || b.tv || b.ps4 || b.xboxOne;
      const speakers2 = speakerCount();
      if ((supportsAc3() || supportsEac3()) && surround) return speakers2 > 6 ? speakers2 : 6;
      if (speakers2 > 2) return surround ? speakers2 : 2;
      if (speakers2 > 0) return speakers2;
      return surround ? 6 : 2;
    })();
    const bitrateSetting = 12e7;
    const canPlayVp8 = has('video/webm; codecs="vp8"');
    const canPlayVp9 = has('video/webm; codecs="vp9"');
    const safariSupportsOpus = !!b.safari && versionMajor >= 17 && can(audioEl, 'audio/x-caf; codecs="opus"');
    const webmAudioCodecs = ["vorbis"];
    const directPlay = [];
    const transcoding = [];
    const codecProfiles = [];
    const subtitleProfiles = [];
    const profile = {
      MaxStreamingBitrate: bitrateSetting,
      MaxStaticBitrate: 1e8,
      MusicStreamingTranscodingBitrate: Math.min(bitrateSetting, 384e3),
      DirectPlayProfiles: directPlay,
      TranscodingProfiles: transcoding,
      ContainerProfiles: [],
      CodecProfiles: codecProfiles,
      SubtitleProfiles: subtitleProfiles,
      ResponseProfiles: [{ Type: "Video", Container: "m4v", MimeType: "video/mp4" }]
    };
    let videoAudioCodecs = [];
    let hlsInTsVideoAudioCodecs = [];
    let hlsInFmp4VideoAudioCodecs = [];
    const supportsMp3VideoAudio = has('video/mp4; codecs="avc1.640029, mp4a.69"') || has('video/mp4; codecs="avc1.640029, mp4a.6B"') || has('video/mp4; codecs="avc1.640029, mp3"');
    let supportsMp2VideoAudio = options.supportsMp2VideoAudio;
    if (supportsMp2VideoAudio == null) {
      supportsMp2VideoAudio = !!(b.edgeUwp || b.tizen || b.web0s);
      if (supportsMp3VideoAudio && (b.chrome || b.edgeChromium || b.firefox && versionMajor >= 83)) supportsMp2VideoAudio = true;
      if (b.android) supportsMp2VideoAudio = false;
    }
    let maxVideoWidth = b.xboxOne ? typeof screen !== "undefined" ? screen.width : null : null;
    if (options.maxVideoWidth) maxVideoWidth = options.maxVideoWidth;
    if (has('video/mp4; codecs="avc1.640029, mp4a.40.2"')) {
      videoAudioCodecs.push("aac");
      hlsInTsVideoAudioCodecs.push("aac");
      hlsInFmp4VideoAudioCodecs.push("aac");
    }
    if (supportsMp3VideoAudio) videoAudioCodecs.push("mp3");
    if (b.safari || supportsMp3VideoAudio && !b.ps4) hlsInTsVideoAudioCodecs.push("mp3");
    if (supportsMp3InHls()) hlsInFmp4VideoAudioCodecs.push("mp3");
    if (supportsAc3()) {
      videoAudioCodecs.push("ac3");
      if (b.edgeChromium) hlsInFmp4VideoAudioCodecs.push("ac3");
      if (supportsEac3()) {
        videoAudioCodecs.push("eac3");
        if (b.edgeChromium) hlsInFmp4VideoAudioCodecs.push("eac3");
      }
      if (supportsAc3InHls()) {
        hlsInTsVideoAudioCodecs.push("ac3");
        hlsInFmp4VideoAudioCodecs.push("ac3");
        if (supportsEac3()) {
          hlsInTsVideoAudioCodecs.push("eac3");
          hlsInFmp4VideoAudioCodecs.push("eac3");
        }
      }
    }
    if (supportsMp2VideoAudio) {
      videoAudioCodecs.push("mp2");
      hlsInTsVideoAudioCodecs.push("mp2");
      hlsInFmp4VideoAudioCodecs.push("mp2");
    }
    let supportsDts = flag(settings.app("enableDts"), false) || options.supportsDts;
    if (supportsDts == null) supportsDts = canPlayDts();
    if (supportsDts) videoAudioCodecs.push("dca", "dts");
    if (b.tizen || b.web0s) videoAudioCodecs.push("pcm_s16le", "pcm_s24le");
    if (flag(settings.app("enableTrueHd"), false) || options.supportsTrueHd) videoAudioCodecs.push("truehd");
    if (b.tizen) videoAudioCodecs.push("aac_latm");
    if (canPlayAudioFormat("opus")) {
      videoAudioCodecs.push("opus");
      webmAudioCodecs.push("opus");
      if (b.tizen) hlsInTsVideoAudioCodecs.push("opus");
      hlsInFmp4VideoAudioCodecs.push("opus");
    } else if (safariSupportsOpus) {
      videoAudioCodecs.push("opus");
      webmAudioCodecs.push("opus");
      hlsInFmp4VideoAudioCodecs.push("opus");
    }
    if (canPlayAudioFormat("flac") && !b.tizen) {
      videoAudioCodecs.push("flac");
      hlsInFmp4VideoAudioCodecs.push("flac");
    }
    if (canPlayAudioFormat("alac")) {
      videoAudioCodecs.push("alac");
      hlsInFmp4VideoAudioCodecs.push("alac");
    }
    const disabled = options.disableVideoAudioCodecs || [];
    const disabledHls = options.disableHlsVideoAudioCodecs || [];
    videoAudioCodecs = videoAudioCodecs.filter((c) => !disabled.includes(c));
    hlsInTsVideoAudioCodecs = hlsInTsVideoAudioCodecs.filter((c) => !disabledHls.includes(c));
    hlsInFmp4VideoAudioCodecs = hlsInFmp4VideoAudioCodecs.filter((c) => !disabledHls.includes(c));
    const mp4VideoCodecs = [];
    const webmVideoCodecs = [];
    const hlsInTsVideoCodecs = [];
    const hlsInFmp4VideoCodecs = [];
    if (canPlayAv1() && (b.safari || b.tizen || b.web0s || !b.mobile && (b.edgeChromium || b.firefox || b.chrome || b.opera))) hlsInFmp4VideoCodecs.push("av1");
    if (canPlayHevc() && (b.edgeChromium || b.safari || b.tizen || b.web0s || b.chrome && (!b.android || versionMajor >= 105) || b.opera && !b.mobile || b.firefox && versionMajor >= 134)) hlsInFmp4VideoCodecs.push("hevc");
    if (has('video/mp4; codecs="avc1.42E01E, mp4a.40.2"')) {
      mp4VideoCodecs.push("h264");
      hlsInTsVideoCodecs.push("h264");
      hlsInFmp4VideoCodecs.push("h264");
    }
    if (canPlayHevc()) {
      mp4VideoCodecs.push("hevc");
      if (b.tizen || b.web0s || b.vidaa) hlsInTsVideoCodecs.push("hevc");
    }
    if (supportsMpeg2Video()) mp4VideoCodecs.push("mpeg2video");
    if (supportsVc1()) mp4VideoCodecs.push("vc1");
    if (b.tizen) mp4VideoCodecs.push("msmpeg4v2");
    if (canPlayVp8) webmVideoCodecs.push("vp8");
    if (canPlayVp9) {
      if (!b.iOS && !(b.firefox && b.osx)) mp4VideoCodecs.push("vp9");
      if (b.safari || b.edgeChromium || b.chrome || b.firefox) hlsInFmp4VideoCodecs.push("vp9");
      if (!b.safari || versionMajor >= 15 && versionMajor < 17) webmVideoCodecs.push("vp9");
    }
    if (canPlayAv1()) {
      mp4VideoCodecs.push("av1");
      if (!b.safari || versionMajor >= 15 && versionMajor < 17) webmVideoCodecs.push("av1");
    }
    if (!b.safari && canPlayVp8 || b.tizen) videoAudioCodecs.push("vorbis");
    if (webmVideoCodecs.length) directPlay.push({ Container: "webm", Type: "Video", VideoCodec: webmVideoCodecs.join(","), AudioCodec: webmAudioCodecs.join(",") });
    if (mp4VideoCodecs.length) directPlay.push({ Container: "mp4,m4v", Type: "Video", VideoCodec: mp4VideoCodecs.join(","), AudioCodec: videoAudioCodecs.join(",") });
    if (canPlayMkv && mp4VideoCodecs.length) directPlay.push({ Container: "mkv", Type: "Video", VideoCodec: mp4VideoCodecs.join(","), AudioCodec: videoAudioCodecs.join(",") });
    for (const container of ["m2ts", "wmv", "ts", "asf", "avi", "mpg", "mpeg", "flv", "3gp", "mts", "trp", "vob", "vro", "mov"]) {
      let supported = false;
      let name = container;
      let audio = videoAudioCodecs;
      const codecs = [];
      if (container === "asf" || container === "wmv") {
        supported = b.tizen || b.web0s || b.edgeUwp;
        audio = [];
      } else if (["avi", "mpg", "mpeg", "m2ts"].includes(container)) supported = b.tizen || b.web0s || b.edgeUwp;
      else if (["flv", "3gp", "mts", "trp", "vob", "vro"].includes(container)) supported = b.tizen;
      else if (container === "mov") {
        supported = b.safari || b.tizen || b.web0s || b.chrome || b.edgeChromium || b.edgeUwp;
        codecs.push("h264");
      } else if (container === "ts") {
        supported = b.tizen || b.web0s || b.edgeUwp;
        codecs.push("h264");
        if ((b.tizen || b.web0s) && canPlayHevc()) codecs.push("hevc");
        name = "ts,mpegts";
      }
      if (container === "m2ts" || container === "ts") {
        if (container === "m2ts") codecs.push("h264");
        if (supportsVc1()) codecs.push("vc1");
        if (supportsMpeg2Video()) codecs.push("mpeg2video");
      }
      if (supported) directPlay.push({ Container: name, Type: "Video", VideoCodec: codecs.join(","), AudioCodec: audio.join(",") });
    }
    const mp3InHls = supportsMp3InHls();
    for (const format of ["opus", "mp3", "mp2", "aac", "flac", "alac", "webma", "wma", "wav", "ogg", "oga"].filter(canPlayAudioFormat)) {
      if (format === "mp3" && !mp3InHls) directPlay.push({ Container: "ts", AudioCodec: "mp3", Type: "Audio" });
      if (format === "flac" && flag(settings.app("alwaysRemuxFlac"), false)) directPlay.push({ Container: "mp4", AudioCodec: "flac", Type: "Audio" });
      else if (format !== "mp3" || !flag(settings.app("alwaysRemuxMp3"), false)) directPlay.push({ Container: format, Type: "Audio" });
      if (format === "opus" || format === "webma") directPlay.push({ Container: "webm", AudioCodec: format, Type: "Audio" });
      if (format === "aac" || format === "alac") directPlay.push({ Container: "m4a", AudioCodec: format, Type: "Audio" }, { Container: "m4b", AudioCodec: format, Type: "Audio" });
    }
    if (safariSupportsOpus) directPlay.push({ Container: "mp4", AudioCodec: "opus", Type: "Audio" });
    const breakOnNonKeyFrames = !!(b.iOS || b.osx || b.edge || !canPlayNativeHls());
    let fmp4Hls = flag(settings.user("preferFmp4HlsContainer"), !!(b.safari || b.firefox || b.chrome || b.edgeChromium));
    if ((b.safari || b.tizen || b.web0s) && !canPlayNativeHlsInFmp4()) fmp4Hls = false;
    if (b.firefox && versionMajor === 149) fmp4Hls = false;
    const minSegments = b.iOS || b.osx ? "2" : "1";
    const channels = physicalAudioChannels.toString();
    if (canPlayHls) transcoding.push({ Container: fmp4Hls ? "mp4" : "ts", Type: "Audio", AudioCodec: "aac", Context: "Streaming", Protocol: "hls", MaxAudioChannels: channels, MinSegments: minSegments, BreakOnNonKeyFrames: breakOnNonKeyFrames, EnableAudioVbrEncoding: !flag(settings.app("disableVbrAudio"), false) });
    for (const format of ["aac", "mp3", "opus", "wav"].filter(canPlayAudioFormat)) transcoding.push({ Container: format, Type: "Audio", AudioCodec: format, Context: "Streaming", Protocol: "http", MaxAudioChannels: channels });
    for (const format of ["opus", "mp3", "aac", "wav"].filter(canPlayAudioFormat)) transcoding.push({ Container: format, Type: "Audio", AudioCodec: format, Context: "Static", Protocol: "http", MaxAudioChannels: channels });
    if (canPlayHls && options.enableHls !== false) {
      const segmentLength = flag(settings.user("limitSegmentLength"), false) ? 1 : void 0;
      if (hlsInFmp4VideoCodecs.length && hlsInFmp4VideoAudioCodecs.length && fmp4Hls) {
        directPlay.push({ Container: "hls", Type: "Video", VideoCodec: hlsInFmp4VideoCodecs.join(","), AudioCodec: hlsInFmp4VideoAudioCodecs.join(",") });
        transcoding.push({ Container: "mp4", Type: "Video", AudioCodec: hlsInFmp4VideoAudioCodecs.join(","), VideoCodec: hlsInFmp4VideoCodecs.join(","), Context: "Streaming", Protocol: "hls", MaxAudioChannels: channels, MinSegments: minSegments, BreakOnNonKeyFrames: breakOnNonKeyFrames, SegmentLength: segmentLength });
      }
      if (hlsInTsVideoCodecs.length && hlsInTsVideoAudioCodecs.length) {
        directPlay.push({ Container: "hls", Type: "Video", VideoCodec: hlsInTsVideoCodecs.join(","), AudioCodec: hlsInTsVideoAudioCodecs.join(",") });
        transcoding.push({ Container: "ts", Type: "Video", AudioCodec: hlsInTsVideoAudioCodecs.join(","), VideoCodec: hlsInTsVideoCodecs.join(","), Context: "Streaming", Protocol: "hls", MaxAudioChannels: channels, MinSegments: minSegments, BreakOnNonKeyFrames: breakOnNonKeyFrames, SegmentLength: segmentLength });
      }
    }
    const cond = (Condition, Property, Value, IsRequired = false) => ({ Condition, Property, Value, IsRequired });
    const aacConditions = [];
    if (!has('video/mp4; codecs="avc1.640029, mp4a.40.5"')) aacConditions.push({ Condition: "NotEquals", Property: "AudioProfile", Value: "HE-AAC" });
    if (!supportsSecondaryAudio) aacConditions.push(cond("Equals", "IsSecondaryAudio", "false"));
    if (aacConditions.length) codecProfiles.push({ Type: "VideoAudio", Codec: "aac", Conditions: aacConditions });
    const audioConditions = [];
    const videoAudioConditions = [];
    if (allowedChannels > 0) {
      audioConditions.push(cond("LessThanEqual", "AudioChannels", channels));
      videoAudioConditions.push(cond("LessThanEqual", "AudioChannels", channels));
    }
    if (!supportsSecondaryAudio) videoAudioConditions.push(cond("Equals", "IsSecondaryAudio", "false"));
    if (audioConditions.length) codecProfiles.push({ Type: "Audio", Conditions: audioConditions });
    if (videoAudioConditions.length) codecProfiles.push({ Type: "VideoAudio", Conditions: videoAudioConditions });
    if (safariSupportsOpus) {
      const opus = [cond("LessThanEqual", "AudioChannels", "2")];
      codecProfiles.push({ Type: "VideoAudio", Codec: "opus", Conditions: opus });
      const split = [];
      for (const tp of transcoding) {
        if (tp.Type !== "Video") continue;
        const codecs = tp.AudioCodec.split(",");
        if (!codecs.includes("opus")) continue;
        split.push({ ...tp, AudioCodec: "opus", ApplyConditions: [...tp.ApplyConditions || [], ...opus] });
        tp.AudioCodec = codecs.filter((c) => c !== "opus").join(",");
      }
      transcoding.push(...split);
    }
    let maxH264Level = 42;
    let h264Profiles = "high|main|baseline|constrained baseline";
    if (b.tizen || b.web0s || has('video/mp4; codecs="avc1.640833"')) maxH264Level = 51;
    if (has('video/mp4; codecs="avc1.640834"')) maxH264Level = 52;
    if (has('video/mp4; codecs="avc1.6e0033"') && !b.safari && !b.iOS && !b.web0s && !b.edge && !b.mobile && !b.tizen) h264Profiles += "|high 10";
    let maxHevcLevel = 120;
    let hevcProfiles = "main";
    const hevc = (tag) => has(`video/mp4; codecs="hvc1.${tag}"`) || has(`video/mp4; codecs="hev1.${tag}"`);
    if (hevc("1.4.L123")) maxHevcLevel = 123;
    for (const [tag, level] of [["2.4.L123", 123], ["2.4.L153", 153], ["2.4.L183", 183], ["2.4.L186", 186]]) {
      if (hevc(tag)) {
        maxHevcLevel = level;
        hevcProfiles = "main|main 10";
      }
    }
    let maxAv1Level = 15;
    for (const level of [16, 17, 18, 19]) {
      if (has(`video/mp4; codecs="av01.0.${level}M.08"`) && has(`video/mp4; codecs="av01.0.${level}M.10"`)) maxAv1Level = level;
    }
    let hevcRanges = "SDR";
    let vp9Ranges = "SDR";
    let av1Ranges = "SDR";
    const webOsWithoutDv = b.web0s && !supportsDolbyVision;
    if (webOsWithoutDv) hevcRanges += "|DOVIWithSDR";
    if (supportsHdr10) {
      hevcRanges += "|HDR10|HDR10Plus";
      vp9Ranges += "|HDR10|HDR10Plus";
      av1Ranges += "|HDR10|HDR10Plus";
      if (b.vidaa || webOsWithoutDv) {
        hevcRanges += "|DOVIWithHDR10|DOVIWithHDR10Plus|DOVIWithEL|DOVIWithELHDR10Plus|DOVIInvalid";
        av1Ranges += "|DOVIWithHDR10|DOVIWithHDR10Plus|DOVIWithEL|DOVIWithELHDR10Plus|DOVIInvalid";
      }
    }
    if (supportsHlg) {
      hevcRanges += "|HLG";
      vp9Ranges += "|HLG";
      av1Ranges += "|HLG";
      if (webOsWithoutDv) hevcRanges += "|DOVIWithHLG";
    }
    if (supportsDolbyVision) {
      const dv = [];
      if (b.xboxOne) dv.push(5, 8);
      else {
        if (has('video/mp4; codecs="dvh1.05.06"')) dv.push(5);
        if (has('video/mp4; codecs="dvh1.08.06"')) dv.push(8);
      }
      if (dv.includes(5)) hevcRanges += "|DOVI";
      if (dv.includes(8)) hevcRanges += "|DOVIWithHDR10|DOVIWithHLG|DOVIWithSDR|DOVIWithHDR10Plus";
      if (b.web0s) hevcRanges += "|DOVIWithEL|DOVIWithELHDR10Plus|DOVIInvalid";
      if (has('video/mp4; codecs="dav1.10.06"')) {
        av1Ranges += "|DOVI|DOVIWithHDR10|DOVIWithHLG|DOVIWithSDR|DOVIWithHDR10Plus";
        if (b.web0s) av1Ranges += "|DOVIWithEL|DOVIWithELHDR10Plus|DOVIInvalid";
      }
    }
    const h264 = [cond("EqualsAny", "VideoProfile", h264Profiles), cond("EqualsAny", "VideoRangeType", "SDR"), cond("LessThanEqual", "VideoLevel", String(maxH264Level))];
    const hevcConds = [cond("EqualsAny", "VideoProfile", hevcProfiles), cond("EqualsAny", "VideoRangeType", hevcRanges), cond("LessThanEqual", "VideoLevel", String(maxHevcLevel))];
    const vp9 = [cond("EqualsAny", "VideoRangeType", vp9Ranges)];
    const av1 = [cond("EqualsAny", "VideoProfile", "main"), cond("EqualsAny", "VideoRangeType", av1Ranges), cond("LessThanEqual", "VideoLevel", String(maxAv1Level))];
    if (!supportsAnamorphic) for (const list of [h264, hevcConds, av1]) list.push(cond("NotEquals", "IsAnamorphic", "true"));
    if (!b.edgeUwp && !b.tizen && !b.web0s) for (const list of [h264, hevcConds]) list.push(cond("NotEquals", "IsInterlaced", "true"));
    if (maxVideoWidth) for (const list of [h264, hevcConds, av1]) list.push(cond("LessThanEqual", "Width", String(maxVideoWidth)));
    const globalMaxVideoBitrate = String(options.globalMaxVideoBitrate || (b.ps4 ? 8e6 : "") || "");
    if (globalMaxVideoBitrate) for (const list of [h264, hevcConds, av1]) list.push(cond("LessThanEqual", "VideoBitrate", globalMaxVideoBitrate, true));
    if (b.safari) hevcConds.push(cond("EqualsAny", "VideoCodecTag", "hvc1|dvh1", true), cond("LessThanEqual", "VideoFramerate", "60", true));
    if (b.iOS && iOSVersion < 13) {
      for (const container of ["ts", "mp4"]) codecProfiles.push({ Type: "Video", Codec: "h264", Container: container, Conditions: [...h264.filter((c) => c.Property !== "VideoLevel"), cond("LessThanEqual", "VideoLevel", "42")] });
    }
    if (b.safari && flag(settings.app("enableHi10p"), false)) codecProfiles.push({ Type: "Video", Container: "hls", SubContainer: "mp4", Codec: "h264", Conditions: [cond("EqualsAny", "VideoProfile", h264Profiles + "|high 10")] });
    codecProfiles.push({ Type: "Video", Codec: "h264", Conditions: h264 });
    codecProfiles.push({ Type: "Video", Codec: "hevc", Conditions: hevcConds });
    codecProfiles.push({ Type: "Video", Codec: "vp9", Conditions: vp9 });
    codecProfiles.push({ Type: "Video", Codec: "av1", Conditions: av1 });
    const globalVideo = [];
    if (globalMaxVideoBitrate) globalVideo.push({ Condition: "LessThanEqual", Property: "VideoBitrate", Value: globalMaxVideoBitrate });
    if (maxVideoWidth) globalVideo.push(cond("LessThanEqual", "Width", String(maxVideoWidth)));
    if (globalVideo.length) codecProfiles.push({ Type: "Video", Conditions: globalVideo });
    const burnIn = settings.app("subtitleburnin");
    const renderPgs = settings.app("subtitlerenderpgs") === "true";
    if (burnIn !== "all") {
      if (supportsTextTracks) subtitleProfiles.push({ Format: "vtt", Method: "External" });
      if (options.enableSsaRender !== false && !options.isRetry && burnIn !== "allcomplexformats") subtitleProfiles.push({ Format: "ass", Method: "External" }, { Format: "ssa", Method: "External" });
      if (renderPgs && options.enablePgsRender !== false && !options.isRetry && burnIn !== "allcomplexformats" && burnIn !== "onlyimageformats" && supportsCanvas2D()) {
        subtitleProfiles.push({ Format: "pgssub", Method: "External" }, { Format: "vobsub", Container: "mks", Method: "External" });
      }
    }
    return profile;
  }
  var speakers = null;
  function speakerCount() {
    if (speakers !== null) return speakers;
    speakers = -1;
    try {
      const Ctx = typeof window !== "undefined" ? window.AudioContext || profileWindow().webkitAudioContext : null;
      if (Ctx) {
        const ctx = new Ctx();
        speakers = ctx.destination.maxChannelCount;
        ctx.close?.().catch?.(() => {
        });
      }
    } catch {
    }
    return speakers;
  }
  function withHostSettings(settings, profile, b) {
    const maxVideoWidth = parseInt(settings.app("maxVideoWidth") || "0", 10) || 0;
    let width = maxVideoWidth;
    if (maxVideoWidth < 0) {
      const host = typeof window !== "undefined" ? profileWindow().NativeShell?.AppHost : null;
      let s = null;
      try {
        s = typeof host?.screen === "function" ? host.screen() : typeof screen !== "undefined" && !b.tv ? { width: Math.floor(screen.width * (window.devicePixelRatio || 1)), height: Math.floor(screen.height * (window.devicePixelRatio || 1)) } : null;
      } catch {
        s = null;
      }
      width = s ? Math.max(s.width, s.height) : 0;
    }
    if (width) {
      const condition = { Condition: "LessThanEqual", Property: "Width", Value: width.toString(), IsRequired: false };
      if (flag(settings.app("limitSupportedVideoResolution"), false)) (profile.CodecProfiles ?? (profile.CodecProfiles = [])).push({ Type: "Video", Conditions: [condition] });
      for (const tp of profile.TranscodingProfiles || []) {
        if (tp.Type !== "Video") continue;
        tp.Conditions = (tp.Conditions || []).filter((c) => c.Property !== "Width");
        tp.Conditions.push(condition);
      }
    }
    for (const [setting, field] of [["preferredTranscodeVideoCodec", "VideoCodec"], ["preferredTranscodeVideoAudioCodec", "AudioCodec"]]) {
      const preferred = settings.app(setting);
      if (!preferred) continue;
      for (const tp of profile.TranscodingProfiles || []) {
        const list = tp[field];
        if (tp.Type !== "Video" || typeof list !== "string") continue;
        const codecs = list.split(",");
        const i = codecs.indexOf(preferred);
        if (i !== -1) {
          codecs.splice(i, 1);
          codecs.unshift(preferred);
          tp[field] = codecs.join(",");
        }
      }
    }
    return profile;
  }
  function baseOptions(b) {
    const nativeHls = b.tizen || (() => {
      try {
        const v = document.createElement("video");
        return can(v, "application/x-mpegURL") || can(v, "application/vnd.apple.mpegURL");
      } catch {
        return false;
      }
    })();
    const hlsJs = typeof window !== "undefined" && window.MediaSource != null && !b.iOS && !b.tizen && !b.web0s && (!nativeHls || b.android || b.chrome || b.edgeChromium || b.opera);
    const disableHlsVideoAudioCodecs = [];
    if (hlsJs) {
      if (b.edge) disableHlsVideoAudioCodecs.push("mp3");
      if (!b.edgeChromium) disableHlsVideoAudioCodecs.push("ac3", "eac3");
      if (!(b.chrome || b.edgeChromium || b.firefox)) disableHlsVideoAudioCodecs.push("opus");
    }
    return { enableMkvProgressive: false, disableHlsVideoAudioCodecs };
  }

  // client/src/features/media-tags/types/direct-play/tag-direct-play.ts
  function isTimedOut(error) {
    return export42(error) && error.timedOut === true;
  }
  function storedResult(value) {
    return {
      directPlay: value.directPlay === true,
      remux: value.remux === true,
      reasons: export12(value.reasons),
      container: typeof value.container === "string" ? value.container : null,
      video: typeof value.video === "string" ? value.video : null,
      audio: typeof value.audio === "string" ? value.audio : null
    };
  }
  function createDirectPlay(JE) {
    const logPrefix = "🪼 Jellyfin Enhanced: Direct play:";
    const TTL_MS = 24 * 60 * 60 * 1e3;
    const RETRY_MS = 10 * 60 * 1e3;
    const DEADLINE_MS = 15 * 1e3;
    const SLICE_LAUNCHES = 4;
    const MAX_IN_FLIGHT = 2;
    const STEP_MIN_MS = 4;
    const SLICE_BUDGET_MS = 8;
    const MEMORY_CAP = 3e3;
    const STORE_CAP = 2e3;
    const PERSIST_DELAY_MS = 2e3;
    const DEFAULT_BITRATE = 12e7;
    const REASONS = {
      ContainerNotSupported: ["status_tag_dp_reason_container", "container"],
      VideoCodecNotSupported: ["status_tag_dp_reason_video_codec", "video"],
      VideoCodecTagNotSupported: ["status_tag_dp_reason_video_codec", "video"],
      AudioCodecNotSupported: ["status_tag_dp_reason_audio_codec", "audio"],
      ContainerBitrateExceedsLimit: ["status_tag_dp_reason_bitrate"],
      VideoBitrateNotSupported: ["status_tag_dp_reason_bitrate"],
      AudioBitrateNotSupported: ["status_tag_dp_reason_bitrate"],
      SubtitleCodecNotSupported: ["status_tag_dp_reason_subtitles"],
      VideoRangeTypeNotSupported: ["status_tag_dp_reason_range"],
      VideoProfileNotSupported: ["status_tag_dp_reason_video_format"],
      VideoLevelNotSupported: ["status_tag_dp_reason_video_format"],
      VideoResolutionNotSupported: ["status_tag_dp_reason_video_format"],
      VideoBitDepthNotSupported: ["status_tag_dp_reason_video_format"],
      VideoFramerateNotSupported: ["status_tag_dp_reason_video_format"],
      RefFramesNotSupported: ["status_tag_dp_reason_video_format"],
      AnamorphicVideoNotSupported: ["status_tag_dp_reason_video_format"],
      InterlacedVideoNotSupported: ["status_tag_dp_reason_video_format"],
      AudioChannelsNotSupported: ["status_tag_dp_reason_audio_format"],
      AudioProfileNotSupported: ["status_tag_dp_reason_audio_format"],
      AudioSampleRateNotSupported: ["status_tag_dp_reason_audio_format"],
      AudioBitDepthNotSupported: ["status_tag_dp_reason_audio_format"],
      SecondaryAudioNotSupported: ["status_tag_dp_reason_audio_format"]
    };
    const memory = /* @__PURE__ */ new Map();
    const queue = /* @__PURE__ */ new Map();
    const inFlight = /* @__PURE__ */ new Map();
    const network = /* @__PURE__ */ new Set();
    let tracked = /* @__PURE__ */ new WeakMap();
    const visible = /* @__PURE__ */ new Set();
    const unsaved = /* @__PURE__ */ new Map();
    const pendingNotify = /* @__PURE__ */ new Set();
    let observer = null;
    let sliceScheduled = false;
    let generation = 0;
    let persistTimer = 0;
    let retryTimer = 0;
    let retryAt = 0;
    let override = null;
    let built = null;
    let builds = 0;
    let reading = null;
    let settingsChecked = false;
    let rated = null;
    let nativePending = null;
    let primed = null;
    let primedKey = "";
    let primedSettled = false;
    let sessionHooked = false;
    const counters = { slices: 0, launched: 0, answered: 0, failed: 0, timedOut: 0, fromMemory: 0, maxSliceMs: 0 };
    const INPUTS = Object.freeze({
      source: Object.freeze(["Id", "Path", "Container", "Size", "Bitrate", "RunTimeTicks", "Video3DFormat", "Protocol", "Timestamp", "DefaultAudioStreamIndex"]),
      stream: Object.freeze([
        "Index",
        "Type",
        "Codec",
        "CodecTag",
        "Profile",
        "Level",
        "BitDepth",
        "BitRate",
        "Width",
        "Height",
        "IsInterlaced",
        "RealFrameRate",
        "AverageFrameRate",
        "Channels",
        "ChannelLayout",
        "SampleRate",
        "VideoRangeType",
        "ColorTransfer",
        "PixelFormat",
        "Language",
        "IsDefault",
        "IsForced",
        "IsExternal",
        "IsAnamorphic",
        "RefFrames",
        "PacketLength",
        "IsAVC",
        "Rotation",
        "NalLengthSize",
        "DvProfile",
        "DvLevel",
        "DvBlSignalCompatibilityId",
        "BlPresentFlag",
        "ElPresentFlag",
        "RpuPresentFlag",
        "Hdr10PlusPresentFlag",
        "ColorPrimaries",
        "ColorSpace",
        "ColorRange",
        "IsHearingImpaired",
        "Path"
      ])
    });
    function itemKey(entry) {
      return entry.source ? `${entry.id}@${entry.source}` : entry.id;
    }
    function scope() {
      const server = JE.session?.getServerId?.() || export1() && export0().serverId?.() || "";
      const user = JE.session?.getUserId?.() || export1() && export0().getCurrentUserId?.() || "";
      return server && user ? `${server}:${user}` : "";
    }
    function storedSetting(name) {
      try {
        return localStorage.getItem(name);
      } catch {
        return null;
      }
    }
    function appSetting(name) {
      const value = storedSetting(name);
      if (reading && !reading.has(name)) reading.set(name, value);
      return value;
    }
    function currentUser() {
      return export1() && export0().getCurrentUserId?.() || JE.session?.getUserId?.() || "";
    }
    const profileSettings = { app: appSetting, user: userSetting };
    function userSetting(name) {
      const user = currentUser();
      return user ? appSetting(`${user}-${name}`) : null;
    }
    function inputsOf(user, values) {
      let text = user;
      for (const [name, value] of values) text += `
${name}=${value}`;
      return text;
    }
    function settingsOf(names) {
      const values = /* @__PURE__ */ new Map();
      for (const name of names) values.set(name, storedSetting(name));
      return inputsOf(currentUser(), values);
    }
    function userBitrate(profile) {
      let inNetwork = {};
      try {
        inNetwork = export1() && export0().getSavedEndpointInfo?.() || {};
      } catch {
        inNetwork = {};
      }
      const net = String(export10(inNetwork).IsInNetwork);
      const saved = parseInt(appSetting(`maxbitrate-Video-${net}`) || "0", 10) || 0;
      if (saved > 0) return saved;
      return flag(appSetting(`enableautobitratebitrate-Video-${net}`), true) ? profile.MaxStreamingBitrate || DEFAULT_BITRATE : 15e5;
    }
    function hashOf(profile) {
      const text = JSON.stringify(profile);
      let h = 2166136261;
      for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
      return h.toString(16).padStart(8, "0");
    }
    function clone(profile) {
      const copy = JSON.parse(JSON.stringify(profile));
      return isProfile(copy) ? copy : profile;
    }
    function isProfile(p) {
      return export42(p) && Array.isArray(p.DirectPlayProfiles);
    }
    function build() {
      const b = browserFlags();
      const own = ++builds;
      const user = currentUser();
      const reads = /* @__PURE__ */ new Map();
      const recording = (fn) => {
        const outer = reading;
        reading = reads;
        try {
          return fn();
        } finally {
          reading = outer;
        }
      };
      const builder = (options) => recording(() => webProfile(profileSettings, options || {}, b));
      const finish = (profile2) => ({ profile: profile2, hash: hashOf(profile2), reads: [...reads.keys()], settings: inputsOf(user, reads) });
      let profile = null;
      try {
        const shell = typeof window !== "undefined" ? profileWindow().NativeShell?.AppHost : null;
        const version = export1() && export0().appVersion?.() || "";
        const native = typeof shell?.getDeviceProfile === "function" ? shell.getDeviceProfile(builder, version) : null;
        if (export42(native) && typeof native.then === "function") {
          const pending = Promise.resolve(native).then((answer) => {
            if (!isProfile(answer) || own !== builds) return;
            const profile2 = recording(() => withHostSettings(profileSettings, clone(answer), b));
            if (settingsOf(reads.keys()) !== inputsOf(user, reads)) {
              rebuild();
              return;
            }
            built = finish(profile2);
            primed = null;
          }, () => {
          }).finally(() => {
            if (nativePending === pending) nativePending = null;
            scheduleSlice();
          });
          nativePending = pending;
        } else if (isProfile(native)) profile = clone(native);
      } catch {
      }
      const final = finish(recording(() => withHostSettings(profileSettings, profile || webProfile(profileSettings, baseOptions(b), b), b)));
      built = final;
      return final;
    }
    function settingsChanged() {
      if (!built || settingsChecked) return false;
      settingsChecked = true;
      queueMicrotask(() => {
        settingsChecked = false;
      });
      return settingsOf(built.reads) !== built.settings;
    }
    function rebuild() {
      builds++;
      nativePending = null;
      const hash = rated?.value.hash;
      if (hash) {
        for (const key of [...memory.keys()]) if (key.startsWith(`${hash}|`)) memory.delete(key);
      }
      built = null;
      rated = null;
      primed = null;
      primedKey = "";
    }
    function current() {
      if (!override && settingsChanged()) rebuild();
      const base = override || built || build();
      const bitrate = userBitrate(base.profile);
      if (rated?.base === base && rated.bitrate === bitrate) return rated.value;
      const value = { profile: base.profile, bitrate, hash: hashOf({ profile: base.hash, bitrate }) };
      rated = { base, bitrate, value };
      return value;
    }
    function classify(info, sourceId = "") {
      const answers = export10(info).MediaSources;
      const sources = Array.isArray(answers) ? answers : [];
      const source = sourceId && export11(sources).find((s) => s.Id === sourceId) || sources[0] || null;
      if (!export42(source)) return null;
      let reasons = Array.isArray(source.TranscodeReasons) ? export12(source.TranscodeReasons) : typeof source.TranscodeReasons === "string" ? source.TranscodeReasons.split(/[,\s]+/).filter(Boolean) : [];
      if (!reasons.length && typeof source.TranscodingUrl === "string") {
        const match = /[?&]TranscodeReasons=([^&]+)/i.exec(source.TranscodingUrl);
        if (match?.[1]) reasons = decodeURIComponent(match[1]).split(",").filter(Boolean);
      }
      const streams = export11(source.MediaStreams);
      const video = streams.find((s) => s.Type === "Video");
      const audio = streams.find((s) => s.Type === "Audio" && s.Index === source.DefaultAudioStreamIndex) || streams.find((s) => s.Type === "Audio");
      const directPlay = source.SupportsDirectPlay === true;
      const containerOnly = reasons.length > 0 && reasons.every((r) => r === "ContainerNotSupported");
      return {
        directPlay,
        remux: !directPlay && (containerOnly || reasons.length === 0 && source.SupportsDirectStream === true),
        reasons: [...new Set(reasons)].slice(0, 12),
        container: typeof source.Container === "string" ? source.Container : null,
        video: typeof video?.Codec === "string" ? video.Codec : null,
        audio: typeof audio?.Codec === "string" ? audio.Codec : null
      };
    }
    function describe(result, label) {
      const parts = [];
      for (const reason of result.reasons) {
        const [key, fact] = export9(REASONS, reason) || ["status_tag_dp_reason_other"];
        const text = JE.t(key, { value: fact && result[fact] || "" }).trim();
        if (text && !parts.includes(text)) parts.push(text);
      }
      return parts.length ? `${label}: ${parts.join(", ")}` : label;
    }
    function prime() {
      const s = scope();
      const { hash } = current();
      const key = `${s}|${hash}`;
      if (primed && primedKey === key) return primed;
      primedKey = key;
      primedSettled = false;
      const gen = generation;
      const store = JE.tagCacheStore;
      primedSettled = !s || !store?.available?.() || typeof store.getDirectPlay !== "function";
      const loading = (async () => {
        if (primedSettled || !store) return;
        try {
          const stored = await store.getDirectPlay(s, hash);
          if (gen !== generation || primedKey !== key) return;
          const now = Date.now();
          let loaded = 0;
          for (const [id, value] of stored) {
            const memoryKey = `${hash}|${id}`;
            if (!memory.has(memoryKey) && value && now - value.t < TTL_MS) {
              memory.set(memoryKey, { r: storedResult(value.r), t: value.t, ...typeof value.m === "string" ? { m: value.m } : {} });
              loaded++;
            }
          }
          if (!loaded) return;
          for (const card of visible) {
            const entry = tracked.get(card);
            if (!entry) continue;
            const memoryKey = `${hash}|${itemKey(entry)}`;
            const known = memory.get(memoryKey);
            if (known && !inFlight.has(memoryKey) && sameMedia(known, entry.media)) {
              queue.delete(memoryKey);
              pendingNotify.add(entry.onResult);
            }
          }
          scheduleSlice();
        } catch {
        }
      })();
      primed = loading;
      return loading;
    }
    function persistSoon() {
      if (persistTimer) return;
      const gen = generation;
      persistTimer = setTimeout(() => {
        persistTimer = 0;
        if (gen !== generation) {
          if (unsaved.size) persistSoon();
          return;
        }
        const batch = new Map(unsaved);
        unsaved.clear();
        const store = JE.tagCacheStore;
        const s = scope();
        if (!s || !store?.available?.() || typeof store.putDirectPlay !== "function") return;
        const byHash = /* @__PURE__ */ new Map();
        for (const [memoryKey] of batch) {
          const value = memory.get(memoryKey);
          if (!value || value.r === null) continue;
          const [hash = "", id = ""] = memoryKey.split("|");
          const answers = byHash.get(hash) ?? /* @__PURE__ */ new Map();
          answers.set(id, value);
          byHash.set(hash, answers);
        }
        for (const [hash, values] of byHash) store.putDirectPlay(s, hash, values, STORE_CAP).catch(() => {
        });
      }, PERSIST_DELAY_MS);
    }
    function remember(key, value) {
      memory.delete(key);
      memory.set(key, value);
      if (memory.size > MEMORY_CAP) {
        const [oldest] = memory.keys();
        if (oldest !== void 0) memory.delete(oldest);
      }
    }
    function peek(itemId, media, source = "") {
      const value = memory.get(`${current().hash}|${itemKey({ id: itemId, source })}`);
      if (!value || value.r === null || !sameMedia(value, media) || Date.now() - value.t >= TTL_MS) return null;
      return value.r;
    }
    function sameMedia(value, media) {
      return media === void 0 || value.m === media;
    }
    function due(key, media) {
      const value = memory.get(key);
      if (!value || !sameMedia(value, media)) return true;
      return Date.now() - value.t >= (value.r === null ? RETRY_MS : TTL_MS);
    }
    function watcher() {
      if (observer || typeof IntersectionObserver === "undefined") return observer;
      const own = new IntersectionObserver((entries) => {
        if (observer !== own) return;
        for (const { target, isIntersecting } of entries) {
          if (!(target instanceof HTMLElement)) continue;
          const card = target;
          if (!tracked.has(card) || !card.isConnected) {
            untrack(card);
            continue;
          }
          if (isIntersecting) {
            visible.add(card);
            enqueue(card);
          } else visible.delete(card);
        }
        scheduleSlice();
        armRetry();
      }, { rootMargin: "200px 0px" });
      observer = own;
      return observer;
    }
    function enqueue(card) {
      const entry = tracked.get(card);
      if (!entry) return;
      const key = `${current().hash}|${itemKey(entry)}`;
      const media = entry.media || "";
      const running = inFlight.get(key);
      if (running && running.media === media) {
        running.cards.add(card);
        return;
      }
      if (!inFlight.has(key) && !due(key, media)) {
        counters.fromMemory++;
        return;
      }
      const job = queue.get(key) || { id: entry.id, source: entry.source || "", cards: /* @__PURE__ */ new Set(), media };
      job.media = media;
      job.cards.add(card);
      queue.set(key, job);
    }
    function track(card, itemId, onResult, media = "", source = "") {
      hookSession();
      const previous = tracked.get(card);
      tracked.set(card, { id: itemId, onResult, media, source });
      prime();
      if (previous && previous.id === itemId && (previous.source || "") === source) {
        if (visible.has(card)) {
          enqueue(card);
          scheduleSlice();
        }
        return;
      }
      if (previous) visible.delete(card);
      const io = watcher();
      if (io) io.observe(card);
      else {
        visible.add(card);
        enqueue(card);
        scheduleSlice();
      }
    }
    function untrack(card) {
      if (!tracked.has(card)) return;
      tracked.delete(card);
      visible.delete(card);
      observer?.unobserve(card);
      for (const [key, job] of queue) {
        job.cards.delete(card);
        if (!job.cards.size) queue.delete(key);
      }
    }
    function scheduleSlice() {
      if (sliceScheduled) return;
      sliceScheduled = true;
      if (typeof requestIdleCallback === "function") requestIdleCallback(runSlice, { timeout: 1e3 });
      else setTimeout(() => runSlice(), 16);
    }
    function runSlice(deadline) {
      sliceScheduled = false;
      const started = performance.now();
      const left = typeof deadline?.timeRemaining === "function" ? () => deadline.timeRemaining() : () => SLICE_BUDGET_MS - (performance.now() - started);
      const late = !deadline || !!deadline.didTimeout;
      current();
      if (nativePending) return;
      prime();
      if (primed && !primedSettled) {
        primed.then(() => {
          primedSettled = true;
          scheduleSlice();
        });
        return;
      }
      const hash = current().hash;
      for (const [key, job] of [...queue]) {
        if (key.startsWith(`${hash}|`)) continue;
        queue.delete(key);
        for (const card of job.cards) enqueue(card);
      }
      const notify = [...pendingNotify];
      pendingNotify.clear();
      for (const fn of notify) {
        try {
          fn();
        } catch (e) {
          console.warn(`${logPrefix} A badge pass failed.`, e);
        }
      }
      let launched = 0;
      for (const [key, job] of queue) {
        if (network.size >= MAX_IN_FLIGHT || launched >= SLICE_LAUNCHES) break;
        if (!(left() >= STEP_MIN_MS || late && launched === 0)) break;
        queue.delete(key);
        for (const card of [...job.cards]) {
          const entry = tracked.get(card);
          if (!card.isConnected || !visible.has(card) || !entry || itemKey(entry) !== itemKey(job)) job.cards.delete(card);
        }
        if (!job.cards.size) continue;
        launched++;
        launch(key, job);
      }
      counters.slices++;
      counters.maxSliceMs = Math.max(counters.maxSliceMs, performance.now() - started);
      if (pendingNotify.size || queue.size && network.size < MAX_IN_FLIGHT) scheduleSlice();
    }
    function requestHeaders() {
      const headers = { Accept: "application/json", "Content-Type": "application/json" };
      const client = export0();
      if (typeof client.setRequestHeaders === "function") {
        client.setRequestHeaders(headers);
        return headers;
      }
      const fields = [["Client", export0().appName?.()], ["Device", export0().deviceName?.()], ["DeviceId", export0().deviceId?.()], ["Version", export0().appVersion?.()], ["Token", export0().accessToken?.()]].filter(([, value]) => value).map(([name, value]) => `${name}="${value}"`);
      if (fields.length) headers.Authorization = `MediaBrowser ${fields.join(", ")}`;
      return headers;
    }
    function askPlaybackInfo(url, body) {
      const controller = new AbortController();
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error("PlaybackInfo timed out"), { timedOut: true }));
        }, DEADLINE_MS);
      });
      const work = (async () => {
        const response = await fetch(url, { method: "POST", headers: requestHeaders(), body, signal: controller.signal });
        if (!response.ok) throw new Error(`PlaybackInfo answered ${response.status}`);
        return response.json();
      })();
      work.catch(() => {
      });
      return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
    }
    async function launch(key, job) {
      if (!export1()) return;
      const gen = generation;
      const { profile, bitrate } = current();
      const userId = export0().getCurrentUserId?.() || JE.session?.getUserId?.() || "";
      const request = {};
      job.prior = memory.get(key);
      inFlight.set(key, job);
      network.add(request);
      counters.launched++;
      let value;
      try {
        const info = await askPlaybackInfo(
          export0().getUrl(`Items/${encodeURIComponent(job.id)}/PlaybackInfo`, { UserId: userId, StartTimeTicks: 0, IsPlayback: false, AutoOpenLiveStream: false, MaxStreamingBitrate: bitrate, ...job.source ? { MediaSourceId: job.source } : {} }),
          JSON.stringify({ UserId: userId, DeviceProfile: profile, MaxStreamingBitrate: bitrate, EnableDirectPlay: true, EnableDirectStream: true, EnableTranscoding: true, AllowVideoStreamCopy: true, AllowAudioStreamCopy: true, IsPlayback: false, AutoOpenLiveStream: false, ...job.source ? { MediaSourceId: job.source } : {} })
        );
        value = { r: classify(info, job.source), t: Date.now(), m: job.media || "" };
        counters.answered++;
      } catch (e) {
        value = { r: null, t: Date.now(), m: job.media || "" };
        counters.failed++;
        if (isTimedOut(e)) counters.timedOut++;
      } finally {
        network.delete(request);
        if (gen === generation && inFlight.get(key) === job) inFlight.delete(key);
      }
      if (gen !== generation) {
        if (queue.size) scheduleSlice();
        return;
      }
      const newer = memory.get(key);
      const running = inFlight.get(key);
      const superseded = running !== void 0 && (running.media || "") !== (job.media || "") || newer !== void 0 && newer !== job.prior && (newer.m || "") !== (job.media || "");
      if (superseded) {
        scheduleSlice();
        return;
      }
      remember(key, value);
      if (value.r) {
        unsaved.set(key, value.t);
        persistSoon();
      }
      armRetry();
      for (const card of job.cards) {
        const entry = tracked.get(card);
        if (entry && itemKey(entry) === itemKey(job)) pendingNotify.add(entry.onResult);
      }
      scheduleSlice();
    }
    function nextRetryAt() {
      const { hash } = current();
      let earliest = 0;
      for (const card of visible) {
        const entry = tracked.get(card);
        if (!entry) continue;
        const key = `${hash}|${itemKey(entry)}`;
        const value = memory.get(key);
        if (!value || value.r !== null || inFlight.has(key) || queue.has(key)) continue;
        const at = value.t + RETRY_MS;
        if (!earliest || at < earliest) earliest = at;
      }
      return earliest;
    }
    function armRetry() {
      const at = nextRetryAt();
      if (retryTimer && at === retryAt) return;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = 0;
      retryAt = at;
      if (!at) return;
      retryTimer = setTimeout(() => {
        retryTimer = 0;
        retryAt = 0;
        for (const card of visible) enqueue(card);
        scheduleSlice();
        armRetry();
      }, Math.max(0, at - Date.now()));
    }
    function reset() {
      generation++;
      for (const card of [...visible]) untrack(card);
      visible.clear();
      tracked = /* @__PURE__ */ new WeakMap();
      queue.clear();
      inFlight.clear();
      pendingNotify.clear();
      observer?.disconnect();
      observer = null;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = 0;
      retryAt = 0;
    }
    function hookSession() {
      if (sessionHooked) return;
      sessionHooked = true;
      JE.session?.onUserChange?.("direct-play", () => {
        reset();
        memory.clear();
        unsaved.clear();
        rebuild();
      });
    }
    const api = {
      INPUTS,
      track,
      untrack,
      peek,
      describe,
      classify,
      reset,
      /** @returns The device profile in use. */
      profile: () => current().profile,
      /** @returns The hash of the profile and bitrate (part of every cache key). */
      profileHash: () => current().hash,
      /** @returns The bitrate lookups ask with. */
      bitrate: () => current().bitrate,
      /**
       * The ported jellyfin-web builder for a user agent (tests compare it
       * with the real client's profile).
       * */
      webProfile: (options, userAgent) => webProfile(profileSettings, options, browserFlags(userAgent)),
      /**
       * Use this profile instead of the browser's (null: back to it). Tests
       * and the lab probe force a restrictive one; answers are kept per hash.
       */
      setProfile(profile) {
        override = profile ? { profile, hash: hashOf(profile) } : null;
        if (!profile) built = null;
        primed = null;
      },
      /** @returns Slice and request counters. */
      stats: () => ({ ...counters, queued: queue.size, inFlight: network.size, memory: memory.size })
    };
    JE.tagDirectPlay = api;
    return api;
  }

  // client/src/features/media-tags/types/direct-play/tag-direct-play-entry.ts
  createDirectPlay(export4());
})();
})();
//# sourceMappingURL=tag-direct-play.js.map
