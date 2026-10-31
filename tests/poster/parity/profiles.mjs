#!/usr/bin/env node
// Builds the parity profiles: one per real user fetched by fetch-inputs.mjs
// (their own settings, tag cache, UserData and review averages) plus synthetic
// profiles that exercise every toggle, position, order and admin key, run over
// the admin's tag cache plus hand-made edge-case entries.
//
// Output: data/profiles.json and data/synthetic/{entries,userdata,reviews}.json.
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, 'data');
const inputs = join(dataDir, 'inputs');
const syntheticDir = join(dataDir, 'synthetic');
mkdirSync(syntheticDir, { recursive: true });
const read = (file) => JSON.parse(readFileSync(join(inputs, file), 'utf8'));

const users = read('users.json');
const admin = users.find((u) => u.isAdmin) || users[0];

// ── Synthetic edge-case entries ────────────────────────────────────────────
const video = (o) => ({ Type: 'Video', Codec: 'h264', Height: 1080, VideoRangeType: 'SDR', DisplayTitle: '1080p H264 SDR', ...o });
const audio = (o) => ({ Type: 'Audio', Language: 'eng', Codec: 'aac', Channels: 2, ChannelLayout: 'stereo', DisplayTitle: 'English - AAC - Stereo', ...o });
const sd = (streams, sources = [{ Path: 'Movie (2020).mkv', Name: 'Movie (2020)' }], name = 'Movie', path = 'Movie (2020).mkv') =>
    ({ Streams: streams, Sources: sources, ItemName: name, ItemPath: path });
const movie = (o) => ({ Type: 'Movie', TmdbId: '1000', Genres: ['Drama'], CommunityRating: 7.1, CriticRating: 81, OfficialRating: 'PG-13', AudioLanguages: ['eng'], StreamData: sd([video(), audio()]), ...o });

const synthetic = {
    upstreamCropped1080: movie({ StreamData: sd([video({ Width: 1920, Height: 800, DisplayTitle: '' })]) }),
    upstreamCropped1440: movie({ StreamData: sd([video({ Width: 2560, Height: 1080, DisplayTitle: '' })]) }),
    upstreamMerged: movie({ StreamData: sd([
        video({ SourceId: 'first', Width: 1920, Height: 800, DisplayTitle: '' }), audio({ SourceId: 'first', Codec: 'ac3', Channels: 6, DisplayTitle: 'AC3 5.1' }),
        video({ SourceId: 'second', Width: 3840, Height: 1600, Codec: 'hevc', VideoRangeType: 'HDR10', DisplayTitle: '' }), audio({ SourceId: 'second', DisplayTitle: 'ATMOS 7.1', Channels: 8 }),
    ], [{ Id: 'first', Path: 'first.mkv', Source: 'WEB' }, { Id: 'second', Path: 'second.IMAX.mkv', Source: 'REMUX', Edition: 'IMAX' }]) }),
    audio0: movie({ StreamData: sd([{"Type": "Audio", "Codec": "ac3", "DisplayTitle": "English - Dolby Digital 5.1", "Profile": "", "Channels": 6}]) }),
    audio1: movie({ StreamData: sd([{"Type": "Audio", "Codec": "ac3", "DisplayTitle": "", "Profile": "", "Channels": 6}]) }),
    audio2: movie({ StreamData: sd([{"Type": "Audio", "Codec": "", "DisplayTitle": "", "Profile": "Dolby Digital", "Channels": 6}]) }),
    audio3: movie({ StreamData: sd([{"Type": "Audio", "Codec": "", "DisplayTitle": "Dolby Digital", "Profile": "", "Channels": 6}]) }),
    audio4: movie({ StreamData: sd([{"Type": "Audio", "Codec": "eac3", "DisplayTitle": "English - Dolby Digital+ 5.1", "Profile": "", "Channels": 6}]) }),
    audio5: movie({ StreamData: sd([{"Type": "Audio", "Codec": "eac3", "DisplayTitle": "", "Profile": "", "Channels": 6}]) }),
    audio6: movie({ StreamData: sd([{"Type": "Audio", "Codec": "truehd", "DisplayTitle": "Dolby TrueHD", "Profile": "", "Channels": 6}]) }),
    audio7: movie({ StreamData: sd([{"Type": "Audio", "Codec": "dts", "DisplayTitle": "DTS", "Profile": "", "Channels": 6}]) }),
    audio8: movie({ StreamData: sd([{"Type": "Audio", "Codec": "dts", "DisplayTitle": "DTS-HD MA", "Profile": "", "Channels": 6}]) }),
    audio9: movie({ StreamData: sd([{"Type": "Audio", "Codec": "dts", "DisplayTitle": "", "Profile": "DTS-HD MA", "Channels": 6}]) }),
    audio10: movie({ StreamData: sd([{"Type": "Audio", "Codec": "dts", "DisplayTitle": "DTS-HD HRA", "Profile": "", "Channels": 6}]) }),
    audio11: movie({ StreamData: sd([{"Type": "Audio", "Codec": "dts", "DisplayTitle": "DTS:X", "Profile": "", "Channels": 6}]) }),
    audio12: movie({ StreamData: sd([{"Type": "Audio", "Codec": "truehd", "DisplayTitle": "Dolby Atmos", "Profile": "", "Channels": 6}]) }),
    audio13: movie({ StreamData: sd([{"Type": "Audio", "Codec": "aac", "DisplayTitle": "AAC", "Profile": "", "Channels": 6}]) }),
    audio14: movie({ StreamData: sd([{"Type": "Audio", "Codec": "flac", "DisplayTitle": "FLAC", "Profile": "", "Channels": 6}]) }),
    audio15: movie({ StreamData: sd([{"Type": "Audio", "Codec": "opus", "DisplayTitle": "Opus", "Profile": "", "Channels": 6}]) }),
    // Quality detection
    q01: movie({ StreamData: sd([video({ DisplayTitle: '4K HEVC Dolby Vision Profile 8', Codec: 'hevc', Height: 2160, VideoRangeType: 'DOVIWithHDR10' }), audio({ DisplayTitle: 'English - TrueHD Atmos 7.1', Codec: 'truehd', Channels: 8, ChannelLayout: '7.1' })]) }),
    q02: movie({ StreamData: sd([video({ DisplayTitle: '4K HEVC HDR10', Codec: 'hevc', Height: 1080, VideoRangeType: 'HDR10' }), audio({ DisplayTitle: 'DTS-HD MA 5.1', Codec: 'dts', Profile: 'DTS-HD MA', Channels: 6, ChannelLayout: '5.1(side)' })]) }), // falsely 4K
    q03: movie({ StreamData: sd([video({ DisplayTitle: '', Codec: 'av1', Height: 3200, VideoRangeType: 'HDR10Plus' }), audio({ DisplayTitle: '', Codec: 'eac3', Channels: 6, ChannelLayout: '' })]) }),
    q04: movie({ StreamData: sd([video({ DisplayTitle: 'SD', Codec: 'mpeg2video', Height: 576 }), audio({ DisplayTitle: 'Mono', Codec: 'mp2', Channels: 1, ChannelLayout: 'mono' })]) }),
    q05: movie({ StreamData: sd([video({ DisplayTitle: '480p XviD', Codec: 'mpeg4', CodecTag: 'XVID', Height: 480 }), audio({ DisplayTitle: 'Dolby Digital+ 5.1', Codec: 'eac3', Channels: 6, ChannelLayout: '5.1' })]) }),
    q06: movie({ StreamData: sd([video({ DisplayTitle: '360p', Codec: 'vp9', Height: 360 }), audio({ DisplayTitle: 'Opus Stereo', Codec: 'opus', Channels: 2 })]) }),
    q07: movie({ StreamData: sd([video({ DisplayTitle: '', Codec: '', CodecTag: 'avc1', Height: 0 }), audio({ DisplayTitle: '', Codec: 'dts', Profile: 'DTS:X', Channels: 8, ChannelLayout: '' })]) }),
    q08: movie({ StreamData: sd([video({ DisplayTitle: 'VC-1 1080p', Codec: 'vc1', Height: 1088 }), audio({ DisplayTitle: '', Codec: 'truehd', Profile: 'Dolby TrueHD + Dolby Atmos', Channels: 8 })]) }),
    q09: movie({ StreamData: sd([video({ DisplayTitle: 'wmv3', Codec: 'wmv3', Height: 720 }), audio({ DisplayTitle: '', Codec: 'wmav2', Channels: 6 })]) }),
    q10: movie({ StreamData: sd([video({ DisplayTitle: 'MJPEG', Codec: 'mjpeg', Height: 240 }), audio({ DisplayTitle: '', Codec: 'pcm', Channels: 0 })]) }),
    q11: movie({ StreamData: sd([video({ DisplayTitle: 'Theora', Codec: 'theora', Height: 1500, VideoRangeType: 'HLG' }), audio({ DisplayTitle: 'HDR audio? no' })]) }),
    q12: movie({ StreamData: sd([video({ DisplayTitle: 'HDR 1440p', Codec: 'h265', Height: 1440 }), audio({ DisplayTitle: 'English 7 1 surround', Channels: 8 })]) }),
    q13: movie({ StreamData: sd([video({ DisplayTitle: '8K', Codec: 'hevc', Height: 4320 }), audio({ DisplayTitle: 'DTS Stereo', Codec: 'dts', Channels: 2 })]) }),
    q14: movie({ StreamData: sd([video({ DisplayTitle: '2160p', Height: 2160 }), audio({ DisplayTitle: 'Dolby  Digital+ 2.0', Codec: 'eac3' })], [{ Path: 'Avatar.2009.IMAX.Enhanced.2160p.mkv', Name: 'Avatar IMAX' }], 'Avatar', 'Avatar.2009.IMAX.Enhanced.2160p.mkv') }),
    q15: movie({ StreamData: sd([video()], [{ Path: 'Avatar.NON-IMAX.1080p.mkv', Name: 'Avatar IMAX Edition' }], 'Avatar', 'Avatar.NON-IMAX.1080p.mkv') }),
    q16: movie({ StreamData: sd([video({ DisplayTitle: '1080p H264 3D' })], [{ Path: 'Avatar.3D.HSBS.1080p.mkv', Name: 'Avatar 3D' }, { Path: 'Avatar.2D.mkv', Name: '2D' }], 'Avatar', 'Avatar.3D.HSBS.1080p.mkv') }),
    q17: movie({ StreamData: sd([], [{ Path: 'Movie.BluRay.disc', Name: 'Movie BluRay' }], 'Movie', 'Movie.BluRay.disc') }),
    q18: movie({ StreamData: sd([], [{ Path: 'Movie.HD DVD.disc', Name: 'Movie' }], 'Movie', 'Movie.disc') }),
    q19: movie({ StreamData: sd([], [{ Path: 'Movie.dvdrip.disc', Name: 'Movie' }], 'Movie', 'Movie.disc') }),
    q20: movie({ StreamData: sd([], [{ Path: 'Movie.VHS.disc', Name: 'Movie' }], 'Movie', null) }),
    q21: movie({ StreamData: sd([], [{ Path: 'Movie.HDTV.disc', Name: 'Movie' }], null, null) }),
    q22: movie({ StreamData: sd([], [{ Path: 'Movie.disc', Name: 'Movie' }], null, null) }),
    q23: movie({ StreamData: { Streams: null, Sources: [], ItemName: 'x', ItemPath: 'x' } }),
    q24: movie({ StreamData: null }),
    q25: movie({ StreamData: sd([audio({ Language: 'ger', DisplayTitle: 'Deutsch - AC3 - 5.1', Codec: 'ac3', Channels: 6 }), audio({ Language: 'eng', DisplayTitle: 'English - TrueHD Atmos 7.1', Codec: 'truehd', Channels: 8 }), video({ DisplayTitle: '1080p DV', Codec: 'hevc' })]) }),
    q26: movie({ StreamData: sd([video(), audio({ Language: 'pt-BR', DisplayTitle: 'Português - DTS 5.1', Codec: 'dts', Channels: 6 }), audio({ Language: 'por', DisplayTitle: 'Português - EAC3 2.0', Codec: 'eac3' }), audio({ Language: 'pt-PT', DisplayTitle: 'Atmos', Codec: 'eac3', Channels: 8 })]) }),
    q27: movie({ StreamData: sd([video(), audio({ Language: 'jpn', DisplayTitle: 'Japanese FLAC Stereo', Codec: 'flac' }), audio({ Language: 'en-US', DisplayTitle: 'English DTS-X 7.1', Codec: 'dts', Channels: 8 }), audio({ Language: 'fre', DisplayTitle: 'French - AC3 5.1', Codec: 'ac3', Channels: 6 })]) }),
    q28: movie({ StreamData: sd([video({ DisplayTitle: 'DVD remux', Codec: 'mpeg2video', Height: 480 }), audio()], [{ Path: 'X.mkv', Name: 'X' }], 'X', 'X.mkv') }), // "dv" in DVD
    q29: movie({ StreamData: sd([video({ Type: 'video' }), audio({ Type: 'audio' })]) }), // wrong-case types
    q30: movie({ StreamData: sd([video({ DisplayTitle: 'ＩＭＡＸ 1080p', Height: 1080 }), audio({ DisplayTitle: 'ATMOſ' })], [{ Path: 'Film.İMAX.mkv', Name: 'Film' }], 'Film', 'Film.mkv') }),
    // Word boundaries: JS \b is ASCII-only (İ is not a word character, unlike .NET's ECMAScript
    // mode); the channel scan lowercases first, where K (Kelvin) becomes k and İ becomes i + U+0307.
    q31: movie({ StreamData: sd([video({ DisplayTitle: 'İ1080p', Height: 720 }), audio()]) }),
    q32: movie({ StreamData: sd([video(), audio({ Codec: 'dts', DisplayTitle: 'K7.1', Channels: null, ChannelLayout: null })]) }),
    q33: movie({ StreamData: sd([video(), audio({ Codec: 'dts', DisplayTitle: '7.1İ', ChannelLayout: 'İ5.1' })]) }),
    q34: movie({ StreamData: sd([video({ DisplayTitle: 'HDRİ 4Kİ', Height: 2160, VideoRangeType: 'SDR' }), audio({ DisplayTitle: 'İDTSİ', Codec: 'aac' })], [{ Path: 'Film.mkv', Name: 'Film IMAXİ' }], 'Film', 'Film.mkv') }),
    q35: movie({ StreamData: sd([video(), audio({ Codec: 'eac3', DisplayTitle: 'Kstereo', Channels: 1, ChannelLayout: 'stereoK' }), audio({ Codec: 'eac3', DisplayTitle: '5 1K', Channels: 1 })]) }),
    // Null sources: the web only throws when a loop actually reaches one.
    q36: movie({ StreamData: sd([{ Type: 'Video', Height: 1080 }], [{ Path: 'movie.3d.hsbs.mkv' }, null], 'Movie', 'movie.3d.hsbs.mkv') }),
    q37: movie({ StreamData: sd([{ Type: 'Video', Height: 1080 }], [null, { Path: 'movie.3d.hsbs.mkv' }], 'Movie', 'movie.3d.hsbs.mkv') }),
    q38: movie({ StreamData: sd([video()], [{ Path: 'movie.mkv', Name: 'Movie' }, null], 'Movie', 'movie.mkv') }),
    q39: movie({ StreamData: sd([video()], [{ Name: 'Movie' }, { Path: 'x.3d.mvc.mkv' }, null], 'Movie', 'movie.mkv') }),
    q40: movie({ StreamData: sd([video(), null]) }),
    // Server-derived source and edition facts, including unprobed media and IMAX dedupe.
    ns01: movie({ Source: 'REMUX', Edition: "Director's Cut" }),
    ns02: movie({ Source: 'BluRay', Edition: 'Extended' }),
    ns03: movie({ Source: 'WEB', Edition: 'Unrated' }),
    ns04: movie({ Source: 'HDTV', Edition: 'Remastered' }),
    ns05: movie({ Source: 'DVD', Edition: 'Criterion' }),
    ns06: movie({ Source: 'CAM', Edition: 'Theatrical' }),
    ns07: movie({ Source: 'TS', Edition: 'Final Cut' }),
    ns08: movie({ Source: 'TC', Edition: 'Special Edition' }),
    ns09: movie({ Source: 'SCR', Edition: 'Uncut' }),
    ns10: movie({ Source: 'WEB', Edition: 'IMAX', StreamData: sd([], [], 'Film.IMAX') }),
    ns11: movie({ Source: 'REMUX', Edition: 'Fan Edit', StreamData: null }),
    // Display modes: multi-video/HDR and per-track audio combinations, with duplicates.
    display01: movie({ StreamData: sd([video(), video({ Codec: 'hevc', VideoRangeType: 'HDR10', DisplayTitle: '4K HDR10', Height: 2160 }),
        audio({ Codec: 'dts', DisplayTitle: 'DTS 5.1', Channels: 6, ChannelLayout: '' }),
        audio({ Codec: 'truehd', DisplayTitle: 'ATMOS 7.1', Channels: 8, ChannelLayout: '' }),
        audio({ Codec: 'dts', DisplayTitle: 'DTS 5.1', Channels: 6, ChannelLayout: '' }),
        audio({ Language: 'deu', Codec: 'eac3', DisplayTitle: 'Dolby Digital+ 5.1', Channels: 6, ChannelLayout: '' })]) }),
    display02: movie({ StreamData: { Streams: [video()], DistinctQualities: [
        { Category: 'videoCodec', Label: 'AV1' }, { Category: 'videoCodec', Label: 'H264' },
        { Category: 'dynamicRange', Label: 'HDR10' }, { Category: 'dynamicRange', Label: 'SDR' },
        { Category: 'audioInfo', Label: 'DTS 5.1', Language: 'eng' }, { Category: 'audioInfo', Label: 'ATMOS 7.1', Language: 'deu' },
    ] } }),
    // Genres
    g01: movie({ Genres: ['Science Fiction', 'Action', 'Adventure', 'Comedy'] }),
    g02: movie({ Genres: ['SCIENCE-FICTION', 'Comédie', 'Ciencia Ficción', 'Боевик'] }),
    g03: movie({ Genres: ['НФ и Фэнтези', 'Unknown Genre', ''] }),
    g04: movie({ Genres: [] }),
    g05: movie({ Genres: null }),
    g06: movie({ Genres: ['Reality-TV', 'Game Show', 'TV Movie'] }),
    // Plain-object lookup: inherited Object.prototype members become the icon text.
    g07: movie({ Genres: ['constructor', '__proto__', 'Constructor'] }),
    g08: movie({ Genres: ['toString', 'hasOwnProperty', '__PROTO__'] }),
    // Languages
    sub01: movie({ AudioLanguages: ['eng', 'en', 'jpn'], SubtitleLanguages: ['eng', 'fra', 'pt-BR'] }),
    sub02: movie({ Type: 'Series', AudioLanguages: ['hi', 'ta', 'te'], PartialAudioLanguages: ['ta'], SubtitleLanguages: ['ger', 'deu', 'fr'] }),
    sub03: movie({ AudioLanguages: [], SubtitleLanguages: ['eo', 'zxx', 'pt-br', 'pt-pt'] }),
    sub04: movie({ AudioLanguages: ['en-US', 'en-GB', 'zxx'], SubtitleLanguages: ['zh-Hant', 'zh-Hans', 'pt_BR'] }),
    l01: { Type: 'Series', TmdbId: '2000', Genres: ['Animation'], CommunityRating: 8.4, OfficialRating: 'TV-Y7', AudioLanguages: ['en', 'eng', 'en-us', 'pt-br', 'es-419', 'ja'], PartialAudioLanguages: ['en-us', 'pt-br', 'es-419'], StreamData: sd([video(), audio()]) },
    l02: { Type: 'Season', SeriesTmdbId: '2000', SeasonNumber: 2, Genres: ['Animation'], CommunityRating: 8.4, OfficialRating: 'TV-Y7', AudioLanguages: ['pt-br', 'es-419', 'nb', 'nb-no', 'zxx'], PartialAudioLanguages: ['pt-br', 'zxx'], StreamData: sd([video(), audio()]), SeriesId: 'x' },
    l03: movie({ AudioLanguages: ['pt_BR', 'zh-Hant', 'zh-hans-cn', 'es-LA', 'iw', 'gre', 'fil', 'tgl', 'cnr', 'sh', 'mo', 'in'] }),
    l04: movie({ AudioLanguages: ['und', 'root', 'xx', 'english', 'English', 'ca-ES', 'eu', 'gl', 'en-UK', 'en-001', 'es-419', 'pt-419'] }),
    l05: movie({ AudioLanguages: ['hi', 'ta', 'te', 'bn', 'mr'] }),
    l06: movie({ AudioLanguages: ['constructor', 'en'] }),
    l07: movie({ AudioLanguages: ['en', 'fr', 'de', 'constructor'] }),
    l08: movie({ AudioLanguages: ['', 'zxx-US', 'pob', 'pb', 'zh-TW', 'sr-Latn-RS', 'en-US-posix', 'de-1901'] }),
    l09: { Type: 'BoxSet', Genres: ['Action'], CommunityRating: 6.9, OfficialRating: 'PG', AudioLanguages: ['eng', 'fre', 'ger', 'ita', 'spa'], TmdbId: '3000' },
    l10: movie({ AudioLanguages: [] }),
    l11: movie({ AudioLanguages: null }),
    l12: { Type: 'Series', TmdbId: '2001', AudioLanguages: ['en', 'eng'], PartialAudioLanguages: ['eng'] },
    l13: { Type: 'Series', TmdbId: '2002', AudioLanguages: ['eng', 'en'], PartialAudioLanguages: ['eng'] },
    l14: movie({ AudioLanguages: ['  en', 'EN', 'Eng', 'ENG-us', 'kor', 'ko-KR', 'jpn', 'ja-JP', 'ara', 'ar-001'] }),
    // Intl accepts a trailing -u-va-posix (ICU folds it into the POSIX variant); other extensions throw.
    l15: movie({ AudioLanguages: ['en-US-u-va-posix', 'fr'] }),
    l16: movie({ AudioLanguages: ['EN-us-U-VA-POSIX', 'en-u-ca-gregory', 'de-u-va-posix', 'ja-Latn-JP-u-va-posix'] }),
    // Casing over whole strings: Greek final sigma, supplementary-plane letters.
    l17: movie({ AudioLanguages: ['en-ΟΣ', 'de-ΣΑ', 'fr'] }),
    l18: movie({ AudioLanguages: ['es-Α.Σ', 'it-𐐀Σ', 'ja-ΑΣ́Β'] }),
    // Ratings
    r01: movie({ CommunityRating: 0, CriticRating: null }),
    r02: movie({ CommunityRating: null, CriticRating: 59.5 }),
    r03: movie({ CommunityRating: 7.25, CriticRating: 60 }),
    r04: movie({ CommunityRating: 0.45, CriticRating: 100.4 }),
    r05: movie({ CommunityRating: 8.05, CriticRating: -3 }),
    r06: movie({ CommunityRating: 9.95, CriticRating: 0.4999 }),
    r07: movie({ CommunityRating: null, CriticRating: null, TmdbId: '1001' }),
    r08: movie({ CommunityRating: null, CriticRating: null, TmdbId: null }),
    r09: movie({ CommunityRating: null, CriticRating: null, TmdbId: 'tt1234' }),
    r10: { Type: 'Episode', SeriesTmdbId: '2000', SeasonNumber: 1, EpisodeNumber: 2, CommunityRating: 7.7, CriticRating: 88, OfficialRating: 'TV-14', SeriesId: 'x' },
    r11: { Type: 'Season', SeriesTmdbId: '2000', SeasonNumber: 1, CommunityRating: null, OfficialRating: 'TV-14', SeriesId: 'x' },
    r12: { Type: 'Video', CommunityRating: 6.6, CriticRating: 70, TmdbId: '4000' },
    r13: { Type: 'Series', TmdbId: '2003', CommunityRating: 0.05, CriticRating: 59.49 },
    r14: movie({ CommunityRating: 1e-7, CriticRating: 59.500001 }),
    // Non-finite ratings, written as named literals (JSON has none); Number() and parseFloat()
    // read "Infinity" / "-Infinity" / "NaN" as those numbers, so the web sees the same values.
    r15: movie({ CommunityRating: 'Infinity', CriticRating: 'Infinity' }),
    r16: movie({ CommunityRating: '-Infinity', CriticRating: '-Infinity' }),
    r17: movie({ CommunityRating: 'NaN', CriticRating: 'NaN' }),
    // toFixed switches to exponent notation from 1e21.
    r18: movie({ CommunityRating: 1e21, CriticRating: 1e21 }),
    r19: movie({ CommunityRating: -3e38, CriticRating: -1e21 }),
    // Seven independent sources, native units, zero, missing values and parent-series entries.
    rs01: movie({ Ratings: { imdb: 8.1, tmdb: 81, rtCritic: 92, rtAudience: 88, metacritic: 74, letterboxd: 4.1, trakt: 85 } }),
    rs02: movie({ Ratings: { imdb: 0, tmdb: null, rtAudience: 49, letterboxd: 2.5 } }),
    rs03: { Type: 'Season', SeriesTmdbId: '2000', SeasonNumber: 2, Ratings: { imdb: 8.1, rtCritic: 92 } },
    // Logos: an image logo, two logos, a long name (initialism), one word cut short,
    // an unknown kind, a malformed logo path and an empty name.
    lg01: movie({ Logos: [{ kind: 'provider', name: 'Streamflix', logo: '/synthLogo01.png' }] }),
    lg02: { Type: 'Series', TmdbId: '2000', Logos: [{ kind: 'network', name: 'Northwind Broadcasting Company' }, { kind: 'network', name: 'Harbor', logo: '/synthLogo02.png' }] },
    lg03: movie({ Logos: [{ kind: 'studio', name: 'Supercalifragilistic' }, { kind: 'studio', name: 'A24' }, { kind: 'studio', name: 'Third' }] }),
    lg04: movie({ Logos: [{ kind: 'channel', name: 'Nope' }, { kind: 'studio', name: '  ', logo: '/x.png' }, { kind: 'provider', name: 'Bad Path', logo: '../etc/passwd' }] }),
    lg05: { Type: 'Episode', SeriesTmdbId: '2000', Logos: [{ kind: 'network', name: 'Home Box Office' }] },
    // Age ratings
    a01: movie({ OfficialRating: 'DE-12' }),
    a02: movie({ OfficialRating: '  FSK   16 ' }),
    a03: movie({ OfficialRating: 'Not Rated' }),
    a04: movie({ OfficialRating: 'se-Btl' }),
    a05: movie({ OfficialRating: 'tv-ma' }),
    a06: movie({ OfficialRating: ' ' }),
    a07: movie({ OfficialRating: 'fsk18' }),
    a08: movie({ OfficialRating: 'GB-12A' }),
    a09: movie({ OfficialRating: 'Straße' }),
    a10: movie({ OfficialRating: 'passed\tnow' }),
    a11: movie({ OfficialRating: 'APPROVED' }),
    a12: movie({ OfficialRating: null }),
    a13: movie({ OfficialRating: 'unrated' }),
    a14: movie({ OfficialRating: 'PAßED' }),
    a15: movie({ OfficialRating: '𐐨' }),
    a16: movie({ OfficialRating: 'pg-𐐨𐐩 ος' }),
};
// Aggregation facts deliberately disagree with representative streams; native and web must use the policy.
for (const type of ['Series', 'Season']) {
    const facts = (best, latest = best, agree = true) => ({ Best: best, Latest: latest, Values: [best], AllAgree: agree, All: [...new Set([best, latest].filter(Boolean))], Shared: agree && best ? [best] : [], LatestAll: latest ? [latest] : [], AllSetsAgree: agree });
    const data = { Type: type, Source: 'WEB', Edition: 'Criterion', AudioLanguages: ['eng', 'jpn'], SubtitleLanguages: ['fra', 'eng'], Ratings: { imdb: 8.1, tmdb: 81, rtCritic: 92 },
        StreamData: sd([video(), audio()]), QualitySummary: { EpisodeCount: 2,
        Categories: { resolution: facts('4K', '720p', false), dynamicRange: facts('Dolby Vision', null, false), videoCodec: facts('AV1'), audioInfo: facts('ATMOS 7.1', 'DTS 5.1', false) },
        AudioByLanguage: { de: facts('DTS 5.1') }, LatestExtras: ['IMAX', 'REMUX', 'edition:Extended'] } };
    synthetic[`aggregate-${type.toLowerCase()}`] = data;
}


// ISO display identity stays distinct from audio-equivalence grouping/counting.
for (const code of ['tl', 'tgl', 'nb', 'nob', 'nn', 'nno', 'fil', 'srd', 'cmn']) {
    synthetic[`iso-${code}`] = movie({ AudioLanguages: [code], SubtitleLanguages: [code] });
}
synthetic.isoAliases = movie({ AudioLanguages: ['tgl', 'tl', 'fil', 'nob', 'nb', 'nno', 'nn', 'nor'] });
synthetic.awardsMovie = movie({ Awards: { ImdbRank: 12, CertifiedFresh: true, OscarWinner: true, OscarYear: 2024, LetterboxdRank: 24 } });
synthetic.awardsSeries = { Type: 'Series', Awards: { EmmyWinner: true, EmmyYear: 2023 } };
synthetic.awardsEmpty = movie({ Awards: { ImdbRank: 251, CertifiedFresh: false } });
// Custom tag rule matches: one chip with an icon, one without, a retired rule id, and a series.
// Rule ids are the server's keyed hash of the match type and value (CustomTagRuleSet.RuleId),
// here under the profiles' CustomTagRuleKey.
const customKey = 'parity';
const customId = (match, value) => `${match}:${createHmac('sha256', customKey).update(`${match}:${value.toLowerCase()}`).digest('hex').slice(0, 16)}`;
synthetic.custom1 = movie({ CustomTags: [customId('tag', '4K Remaster')] });
synthetic.custom2 = movie({ CustomTags: [customId('collection', 'Criterion')] });
synthetic.custom3 = movie({ CustomTags: [customId('tag', 'Signed'), customId('collection', 'Criterion'), 'tag:0000000000000000', customId('tag', '4K Remaster')] });
synthetic.custom4 = { ...movie({ CustomTags: [customId('collection', 'Criterion'), customId('tag', 'Signed')] }), Type: 'Series' };
// Shared technical formatting cases also run through the real web/native resolver harness.
for (const row of JSON.parse(readFileSync(new URL('../../fixtures/technical-quality.json', import.meta.url), 'utf8'))) {
    synthetic['technical-' + row.name] = movie({ SubtitleLanguages: ['eng'], SdhSubtitleLanguages: ['en'], StreamData: { Streams: [row.video], RunTimeTicks: row.ticks } });
}
const syntheticEntries = {};
const syntheticUserData = {};
const syntheticReviews = {};
let n = 0;
for (const [key, entry] of Object.entries(synthetic)) {
    const id = `00000000000000000000synth${key}`.slice(-32);
    syntheticEntries[id] = entry;
    // Mix of played / unplayed-count / nothing.
    const mode = n++ % 4;
    syntheticUserData[id] = { Played: mode === 1, UnplayedItemCount: mode === 2 ? 3 : (mode === 3 ? 0 : null), PlayedPercentage: null };
}

// Synthetic review averages for every movie/tv key of the admin cache + synthetic entries.
const adminCache = read(`tagcache-${admin.id}.json`);
const averages = [null, 4.5, 3, 3.6666666666666665, 2.25, 1, 5, 4.75, 3.35, 2.5];
let r = 0;
for (const entry of [...Object.values(adminCache), ...Object.values(syntheticEntries)]) {
    if ((entry.Type === 'Movie' || entry.Type === 'Series') && /^\d+$/.test(entry.TmdbId || '')) {
        const key = `${entry.Type === 'Movie' ? 'movie' : 'tv'}:${entry.TmdbId}`;
        if (key in syntheticReviews) continue;
        const average = averages[r++ % averages.length];
        syntheticReviews[key] = average === null ? null : { average, count: (r % 3) + 1 };
    }
}

writeFileSync(join(syntheticDir, 'entries.json'), JSON.stringify(syntheticEntries));
writeFileSync(join(syntheticDir, 'userdata.json'), JSON.stringify(syntheticUserData));
writeFileSync(join(syntheticDir, 'reviews.json'), JSON.stringify(syntheticReviews));

// ── Profiles ───────────────────────────────────────────────────────────────
const allOn = { QualityTagsEnabled: true, GenreTagsEnabled: true, LanguageTagsEnabled: true, RatingTagsEnabled: true, AgeRatingTagsEnabled: true };
const profiles = [];
for (const user of users) {
    profiles.push({
        name: `user-${user.name}`,
        user: user.id,
        synthetic: false,
        settingsRaw: read(`settings-raw-${user.id}.json`),
        settingsWeb: read(`settings-web-${user.id}.json`),
        pluginOverrides: {},
        jellyfinAudioPreference: user.audioPreference,
        reviews: 'user',
    });
}

const synth = (name, settingsRaw, pluginOverrides = {}, jellyfinAudioPreference = null) =>
    profiles.push({ name, user: admin.id, synthetic: true, settingsRaw, settingsWeb: null, pluginOverrides, jellyfinAudioPreference, reviews: 'synthetic' });

synth('all-on-defaults', { ...allOn });
for (const TagScale of ['smaller', 'larger', 'largest']) {
    synth(`tag-scale-${TagScale}`, { ...allOn, TagLayoutSettingsVersion: 1, TagScale });
}
for (const TagGap of ['tight', 'roomy']) {
    synth(`tag-gap-${TagGap}`, { ...allOn, TagLayoutSettingsVersion: 1, TagGap });
}
synth('tag-size-invalid-personal', { ...allOn, TagLayoutSettingsVersion: 1, TagScale: 'huge', TagGap: 'wide' }, { TagScale: 'larger', TagGap: 'roomy' });
synth('tag-size-admin-inherit', { ...allOn, TagLayoutSettingsVersion: 1 }, { TagScale: 'larger', TagGap: 'roomy' });
synth('tag-size-legacy', { ...allOn, TagScale: 'largest', TagGap: 'roomy' }, { TagScale: 'larger', TagGap: 'tight' });

synth('naming-low-source-opt-in', { QualityTagsEnabled: true, ShowLowQualitySourceTag: true, EditionTagOrder: 0 });
synth('naming-categories-off', { QualityTagsEnabled: true, ShowLowQualitySourceTag: true, ShowSourceTag: false, ShowEditionTag: false });
synth('naming-imax-edition-only', { QualityTagsEnabled: true, ShowSpecialFormatTag: false });
synth('naming-admin-defaults', { QualityTagsEnabled: true }, { ShowEditionTag: false, ShowLowQualitySourceTag: true, EditionTagOrder: 1 });
synth('naming-user-overrides', { QualityTagsEnabled: true, ShowEditionTag: true, ShowLowQualitySourceTag: false, EditionTagOrder: 7 }, { ShowEditionTag: false, ShowLowQualitySourceTag: true, EditionTagOrder: 1 });
synth('rating-sources-all', { RatingTagsEnabled: true, RatingTagsSources: ['trakt', 'imdb', 'tmdb', 'rtCritic', 'rtAudience', 'metacritic', 'letterboxd'] });
synth('rating-sources-minimum-cap', { RatingTagsEnabled: true, RatingTagsSources: ['metacritic', 'letterboxd', 'imdb', 'tmdb', 'rtCritic'], RatingTagsMinScore: 8, RatingTagsColorByScore: true, TagGroupCaps: { Rating: 2 }, TagLayoutSettingsVersion: 1 });
synth('rating-sources-empty', { RatingTagsEnabled: true, RatingTagsSources: [] });
synth('rating-sources-unknown', { RatingTagsEnabled: true, RatingTagsSources: ['invalid', 'imdb', 'imdb', 'trakt'] });
synth('logos-defaults', { LogoTagsEnabled: true });
synth('logos-with-groups', { ...allOn, LogoTagsEnabled: true, LogoTagsPosition: 'top-right' });
synth('logos-capped-ordered', { ...allOn, LogoTagsEnabled: true, TagLayoutSettingsVersion: 1, TagGroupCaps: { Logos: 1 },
    TagGroupOrder: ['logos', 'quality'], TagLayouts: { Corners: { Groups: [{ Group: 'logos', Slot: 'tl' }] } } });
synth('logos-hidden', { ...allOn, LogoTagsEnabled: true, TagLayoutSettingsVersion: 1, TagLayouts: { Corners: { Groups: [{ Group: 'logos', Slot: 'off' }] } } });
synth('logos-admin-position', { LogoTagsEnabled: true }, { LogoTagsPosition: 'bottom-center' });

for (const policy of ['representative', 'latest', 'best', 'shared', 'mixed']) {
    synth('aggregate-' + policy, { QualityTagsEnabled: true, SeriesQualityAggregation: policy });
    synth('aggregate-' + policy + '-de', { QualityTagsEnabled: true, SeriesQualityAggregation: policy, QualityTagsPreferredAudioLanguage: 'de' });
}
// Display modes independently, inherited defaults, native caps/density and all container policies.
const displayAll = { QualityTagsEnabled: true, QualityAudioDisplayMode: 'all', QualityVideoCodecDisplayMode: 'all', QualityHdrDisplayMode: 'all' };
for (const field of ['QualityAudioDisplayMode', 'QualityVideoCodecDisplayMode', 'QualityHdrDisplayMode'])
    synth('display-' + field, { QualityTagsEnabled: true, [field]: 'all' });
for (const policy of ['representative', 'latest', 'best', 'shared', 'mixed'])
    synth('display-all-' + policy, { ...displayAll, SeriesQualityAggregation: policy });
synth('display-all-language', { ...displayAll, QualityTagsPreferredAudioLanguage: 'de' });
synth('display-all-admin', { QualityTagsEnabled: true }, displayAll);
synth('display-user-highest', { QualityTagsEnabled: true, QualityAudioDisplayMode: 'highest', QualityVideoCodecDisplayMode: 'highest', QualityHdrDisplayMode: 'highest' }, displayAll);
for (const minimum of ['off', '720p', '1080p', '4k'])
    synth('display-minimum-' + minimum, { ...displayAll, QualityMinimumResolution: minimum, QualityHideSdr: true });
for (const max of [1, 2]) synth(`single-chip-caps-${max}`, { ...allOn, LogoTagsEnabled: true, TagLayoutSettingsVersion: 1,
    TagGroupCaps: { Status: 9, AgeRating: 0, Genre: 2, Logos: 9 } }, { LogoTagsMaxLogos: max });
synth('display-compact-cap', { ...displayAll, TagLayout: 'bands', TagLabelDensity: 'compact', TagLayoutSettingsVersion: 1, TagGroupCaps: { Quality: 3 } });
synth('aggregate-admin-default', { QualityTagsEnabled: true }, { SeriesQualityAggregation: 'best' });
for (const policy of ['latest', 'mixed']) {
    synth('tier1-combined-' + policy, { QualityTagsEnabled: true, RatingTagsEnabled: true,
        LanguageTagsEnabled: true, LanguageTagsShowSubtitles: true, LanguageTagsStyle: 'codes',
        SeriesQualityAggregation: policy, RatingTagsSources: ['imdb', 'tmdb', 'rtCritic'] });
}

synth('positions-centres-legacy', {
    ...allOn, QualityTagsPosition: 'top-center', GenreTagsPosition: 'center',
    LanguageTagsPosition: 'center-left', RatingTagsPosition: 'bottom-center', AgeRatingTagsPosition: 'center-right',
});
synth('positions-centres-profile', {
    ...allOn, TagLayoutSettingsVersion: 1,
    TagLayouts: { Corners: { Groups: [
        { Group: 'quality', Slot: 'tc' }, { Group: 'genre', Slot: 'c' },
        { Group: 'language', Slot: 'ml' }, { Group: 'rating', Slot: 'bc' }, { Group: 'ageRating', Slot: 'mr' },
    ] } },
});
// Edge spacing: every anchor at Tight and Flush (four corners, then the five centre
// anchors), an administrator default a normalized user inherits, and a legacy
// document that keeps the default inset whatever the administrator picks.
const cornersProfile = { Groups: [
    { Group: 'quality', Slot: 'tl' }, { Group: 'genre', Slot: 'tr' },
    { Group: 'language', Slot: 'bl' }, { Group: 'rating', Slot: 'br' }, { Group: 'ageRating', Slot: 'tr' },
] };
const centresProfile = { Groups: [
    { Group: 'quality', Slot: 'tc' }, { Group: 'genre', Slot: 'c' },
    { Group: 'language', Slot: 'ml' }, { Group: 'rating', Slot: 'bc' }, { Group: 'ageRating', Slot: 'mr' },
] };
for (const edge of ['tight', 'flush']) {
    synth(`edge-${edge}-corners`, { ...allOn, TagLayoutSettingsVersion: 1, TagEdgeSpacing: edge, TagLayouts: { Corners: cornersProfile } });
    synth(`edge-${edge}-centres`, { ...allOn, TagLayoutSettingsVersion: 1, TagEdgeSpacing: edge, TagLayouts: { Corners: centresProfile } });
}
// Fixed edge insets coexist with scaled chip and gap metrics at every anchor.
for (const edge of ['tight', 'flush']) for (const [scale, gap] of [['smaller', 'tight'], ['largest', 'roomy']]) {
    for (const [name, profile] of [['corners', cornersProfile], ['centres', centresProfile]]) {
        synth(`edge-${edge}-${scale}-${gap}-${name}`, { ...allOn, TagLayoutSettingsVersion: 1,
            TagEdgeSpacing: edge, TagScale: scale, TagGap: gap, TagLayouts: { Corners: profile } });
    }
}
synth('edge-admin-flush-inherited', { ...allOn, TagLayoutSettingsVersion: 1, TagLayouts: { Corners: cornersProfile } }, { TagEdgeSpacing: 'flush' });
synth('edge-admin-flush-user-default', { ...allOn, TagLayoutSettingsVersion: 1, TagEdgeSpacing: 'default' }, { TagEdgeSpacing: 'flush' });
synth('edge-legacy-ignores-admin', { ...allOn, TagEdgeSpacing: 'flush' }, { TagEdgeSpacing: 'tight' });
synth('positions-mirror', {
    ...allOn, QualityTagsPosition: 'bottom-right', GenreTagsPosition: 'bottom-left', RatingTagsPosition: 'top-left',
    AgeRatingTagsPosition: 'top-left', LanguageTagsPosition: 'top-right', VideoCodecTagOrder: 0,
});
synth('all-top-right', {
    ...allOn, QualityTagsPosition: 'top-right', GenreTagsPosition: 'top-right', RatingTagsPosition: 'top-right',
    AgeRatingTagsPosition: 'top-right', LanguageTagsPosition: 'top-right',
});
synth('all-bottom-left', {
    ...allOn, QualityTagsPosition: 'bottom-left', GenreTagsPosition: 'bottom-left', RatingTagsPosition: 'bottom-left',
    AgeRatingTagsPosition: 'bottom-left', LanguageTagsPosition: 'bottom-left',
});
synth('quality-toggles-orders', {
    QualityTagsEnabled: true, ShowResolutionTag: false, ShowAudioInfoTag: true, ShowVideoCodecTag: false,
    ShowDynamicRangeTag: true, ShowSpecialFormatTag: true, ShowSourceTag: true,
    ResolutionTagOrder: 6, SourceTagOrder: 1, DynamicRangeTagOrder: 2, SpecialFormatTagOrder: 2, AudioInfoTagOrder: -1, VideoCodecTagOrder: null,
}, { VideoCodecTagOrder: 3 });
synth('quality-orders-from-admin', { QualityTagsEnabled: true, ResolutionTagOrder: null, SourceTagOrder: null, DynamicRangeTagOrder: null, SpecialFormatTagOrder: null, VideoCodecTagOrder: null, AudioInfoTagOrder: null },
    { ResolutionTagOrder: 4, SourceTagOrder: 5, DynamicRangeTagOrder: 6, SpecialFormatTagOrder: 1, VideoCodecTagOrder: 2, AudioInfoTagOrder: 3, ShowSourceTag: false });
synth('audio-user-de', { QualityTagsEnabled: true, QualityTagsPreferredAudioLanguage: 'de' });
synth('audio-user-ptbr', { QualityTagsEnabled: true, LanguageTagsEnabled: true, QualityTagsPreferredAudioLanguage: ' pt-BR ' });
synth('audio-user-none-admin-fixed', { QualityTagsEnabled: true, QualityTagsPreferredAudioLanguage: 'NONE' }, { QualityTagsPreferredAudioLanguage: 'ger' });
synth('audio-auto-late-quality', { ...allOn, QualityTagsPreferredAudioLanguage: 'auto', QualityTagsPosition: 'top-right' }, {}, 'jpn');
synth('audio-auto-no-pref', { QualityTagsEnabled: true, GenreTagsEnabled: true, QualityTagsPreferredAudioLanguage: 'Auto', GenreTagsPosition: 'top-left' }, {}, null);
synth('audio-admin-from-user', { QualityTagsEnabled: true, AgeRatingTagsEnabled: true, AgeRatingTagsPosition: 'top-left' }, { QualityTagsAudioLanguageFromUser: true, QualityTagsPreferredAudioLanguage: 'spa' }, 'fre');
synth('audio-admin-from-user-no-pref', { QualityTagsEnabled: true }, { QualityTagsAudioLanguageFromUser: true, QualityTagsPreferredAudioLanguage: ' spa ' }, '  ');
synth('audio-admin-fixed', { QualityTagsEnabled: true, QualityTagsPreferredAudioLanguage: '' }, { QualityTagsPreferredAudioLanguage: 'en-GB' });
synth('language-priority', { LanguageTagsEnabled: true }, { LanguageTagsPriority: 'Japanese, en, pt-br, brazilian portuguese, Norwegian Bokmål,, ' });
synth('language-priority-strict', { LanguageTagsEnabled: true, GenreTagsEnabled: true }, { LanguageTagsPriority: 'fr,ja, Latin American Spanish', LanguageTagsPriorityStrict: true });
for (const style of ['flags', 'codes']) {
    for (const strict of [null, true, false]) {
        synth(`personal-language-${style}-strict-${strict}`, { LanguageTagsEnabled: true, LanguageTagsShowSubtitles: true,
            LanguageTagsStyle: style, LanguageTagsCountBadge: 'both', LanguageTagsPriority: ['jpn', 'eng', 'tam', 'por'], LanguageTagsPriorityStrict: strict },
            { LanguageTagsPriority: 'French', LanguageTagsPriorityStrict: true });
    }
}
synth('personal-language-empty', { LanguageTagsEnabled: true, LanguageTagsPriority: [] }, { LanguageTagsPriority: 'French', LanguageTagsPriorityStrict: true });
synth('personal-language-aliases', { LanguageTagsEnabled: true, LanguageTagsPriority: ['tl', 'fil', 'nn', 'nob'], LanguageTagsPriorityStrict: true });
synth('personal-language-follow-strict-override', { LanguageTagsEnabled: true, LanguageTagsPriorityStrict: false }, { LanguageTagsPriority: 'Japanese', LanguageTagsPriorityStrict: true });
synth('personal-language-badge-only', { LanguageTagsEnabled: true, LanguageTagsShowSubtitles: true, LanguageTagsPriority: ['ja', 'en'], LanguageTagsPriorityStrict: true, LanguageTagsCountBadge: 'only' });
synth('personal-language-invalid', { LanguageTagsEnabled: true, LanguageTagsPriority: ['Japanese'] }, { LanguageTagsPriority: 'French' });
synth('rating-scopes', { RatingTagsEnabled: true, RatingTagsOnMovies: false, RatingTagsOnSeries: true, RatingTagsOnSeasons: false, RatingTagsOnEpisodes: false, RatingTagsOnNextUp: false }, { ShowUserRatingDash: false });
synth('rating-scopes-2', { RatingTagsEnabled: true, AgeRatingTagsEnabled: true, RatingTagsOnMovies: true, RatingTagsOnSeries: false, RatingTagsOnSeasons: true, RatingTagsOnEpisodes: true, RatingTagsOnContinueWatching: false });
synth('reviews-off', { RatingTagsEnabled: true }, { ShowUserRatingOnPosters: false });
synth('reviews-disabled', { RatingTagsEnabled: true, LanguageTagsEnabled: true }, { ShowUserReviews: false });
synth('no-settings-file', null, { QualityTagsEnabled: true, LanguageTagsEnabled: true, RatingTagsEnabled: true, AgeRatingTagsEnabled: false, GenreTagsEnabled: true, QualityTagsPosition: null, GenreTagsPosition: 'bottom-right', ResolutionTagOrder: 9 });
synth('no-settings-file-defaults', null, { QualityTagsEnabled: false, GenreTagsEnabled: false, LanguageTagsEnabled: false, RatingTagsEnabled: false, AgeRatingTagsEnabled: false });
synth('empty-settings-object', {}, { ...allOn, RatingTagsPosition: 'top-right' });
synth('camel-case-and-nulls', {
    qualityTagsEnabled: true, genreTagsEnabled: 'true', languageTagsEnabled: null, ratingTagsEnabled: 1, ageRatingTagsEnabled: true,
    qualityTagsPosition: '', genreTagsPosition: null, ratingTagsPosition: 'top-right', RatingTagsPosition: 'bottom-left',
    resolutionTagOrder: '3', showSourceTag: 0, useNativePosterTags: false, SomethingUnknown: { a: 1 },
}, { GenreTagsPosition: '', QualityTagsPosition: 'bottom-right' });
synth('corrupt-settings', { QualityTagsEnabled: [1, 2], GenreTagsEnabled: true }, { ...allOn });
synth('weird-positions', { ...allOn, QualityTagsPosition: 'top', GenreTagsPosition: 'left', RatingTagsPosition: 'TOP-RIGHT', AgeRatingTagsPosition: 'middle', LanguageTagsPosition: 'top-left' });
// Native preference: on unless the user switched it off (null or missing = on); the master switch wins.
synth('native-user-off', { ...allOn, UseNativePosterTags: false }, { NativePosterTagsEnabled: true });
synth('native-user-on', { ...allOn, UseNativePosterTags: true }, { NativePosterTagsEnabled: true });
synth('native-admin-off', { ...allOn, UseNativePosterTags: true }, { NativePosterTagsEnabled: false });
synth('native-unset', { ...allOn, UseNativePosterTags: null }, { NativePosterTagsEnabled: true });
synth('native-missing', { ...allOn }, { NativePosterTagsEnabled: true });
// Strict priority terms that only match through Intl's -u-va-posix names and whole-string casing
// (final sigma, supplementary letters); flags without a match are hidden.
synth('language-priority-strict-casing', { LanguageTagsEnabled: true }, {
    LanguageTagsPriority: 'American English (Computer), German (Computer), en-ος, de-σα, es-α.ς, it-𐐨ς, ja-ασ́β',
    LanguageTagsPriorityStrict: true,
});

// Tag layouts (native posters always draw corners): the corners profile's corner slots and
// "off", the user's own priority order (stacking within a shared corner; the admin's order is
// never inherited, only copied in by seeding) and the per-group caps (admin caps fill gaps);
// a document from before layouts (version 0) ignores order and caps.
const allBottomLeft = { QualityTagsPosition: 'bottom-left', GenreTagsPosition: 'bottom-left', RatingTagsPosition: 'bottom-left', AgeRatingTagsPosition: 'bottom-left', LanguageTagsPosition: 'bottom-left' };
synth('layout-order-caps', {
    ...allOn, ...allBottomLeft, TagLayoutSettingsVersion: 1, TagLayout: 'corners',
    TagGroupOrder: ['language', 'rating', 'genre', 'quality', 'ageRating', 'status'],
    TagGroupCaps: { Quality: 2, Genre: 1, Language: 5, Rating: 1 },
});
synth('layout-corners-profile-off', {
    ...allOn, TagLayoutSettingsVersion: 1, TagLayout: 'bands',
    TagLayouts: { Corners: { Groups: [{ Group: 'genre', Slot: 'off' }, { Group: 'quality', Slot: 'br' }, { Group: 'rating', Slot: 'tr' }, { Group: 'agerating', Slot: 'bl' }] } },
});
synth('layout-admin-caps-not-order', { ...allOn, ...allBottomLeft, TagLayoutSettingsVersion: 1, TagLayout: 'corners' }, {
    TagGroupOrder: ['ageRating', 'genre', 'quality'], TagGroupCaps: { Genre: 0, Language: 0, Quality: 3 },
});
synth('layout-legacy-ignores-order', {
    ...allOn, ...allBottomLeft, TagGroupOrder: ['language', 'genre'], TagGroupCaps: { Genre: 1, Language: 1 },
}, { TagGroupOrder: ['ageRating', 'genre'], TagGroupCaps: { Genre: 5 } });
synth('layout-all-off', {
    ...allOn, TagLayoutSettingsVersion: 1,
    TagLayouts: { Corners: { Groups: ['quality', 'genre', 'rating', 'ageRating', 'language'].map((g) => ({ Group: g, Slot: 'off' })) } },
});
synth('rating-include-community-off', { RatingTagsEnabled: true, AgeRatingTagsEnabled: true, RatingTagsShowCommunity: false });
synth('rating-include-critic-off-admin', { RatingTagsEnabled: true }, { RatingTagsShowCritic: false });
synth('rating-include-none', { RatingTagsEnabled: true, RatingTagsShowCommunity: false, RatingTagsShowCritic: false, TagLayoutSettingsVersion: 1, TagGroupCaps: { Rating: 1 } });

// Raw settings.json text (the provider hands PosterTagSettings.FromSettingsJson the file as read):
// the server reads it with Newtonsoft (JSON5-ish syntax, case-insensitive keys, last duplicate wins)
// and falls back to the UserSettings defaults when it is empty, null, not an object or unreadable.
const synthText = (name, settingsText, pluginOverrides = {}) =>
    profiles.push({ name, user: admin.id, synthetic: true, settingsRaw: null, settingsText, settingsWeb: null, pluginOverrides, jellyfinAudioPreference: null, reviews: 'synthetic' });
const adminTagDefaults = { ...allOn, RatingTagsPosition: 'top-right' };
synthText('settings-text-empty', '', adminTagDefaults);
synthText('settings-text-whitespace', ' \r\n\t ', adminTagDefaults);
synthText('settings-text-null', 'null', adminTagDefaults);
synthText('settings-text-array', '[{"GenreTagsEnabled": true}]', adminTagDefaults);
synthText('settings-text-garbage', '{"GenreTagsEnabled": tru', adminTagDefaults);
synthText('settings-text-json5', "{'GenreTagsEnabled': true, RatingTagsEnabled: true, /* note */ RatingTagsPosition: 'top-left', // x\n QualityTagsEnabled: true,}", adminTagDefaults);
synthText('settings-text-duplicates', '{"GenreTagsEnabled": false, "genreTagsEnabled": true, "LanguageTagsEnabled": true, "LANGUAGETAGSENABLED": null}', adminTagDefaults);

// Language includes, codes, combined caps and badge modes over every fixture.
for (const style of ['flags', 'codes']) {
    for (const badge of ['off', 'only', 'both']) {
        synth(`language-${style}-${badge}`, { LanguageTagsEnabled: true, LanguageTagsShowSubtitles: true, LanguageTagsStyle: style, LanguageTagsCountBadge: badge });
    }
}
// Custom tags: the administrator's rules (labels and icons by rule id), the group's corner,
// arrival order next to quality and age rating, explicit order and cap, and "off" in corners.
// The server reads Match/Value (under CustomTagRuleKey); the web reads Id/Label/Icon, as the
// public configuration serves them.
const customRules = { CustomTagRuleKey: customKey, CustomTagRules: [
    { Id: customId('collection', 'Criterion'), Match: 'collection', Value: 'Criterion', Label: 'Criterion', Icon: null },
    { Id: customId('tag', '4K Remaster'), Match: 'tag', Value: '4K Remaster', Label: 'Remaster', Icon: 'auto_awesome' },
    { Id: customId('tag', 'Signed'), Match: 'tag', Value: 'Signed', Label: 'Signed', Icon: null },
] };
synth('custom-defaults', { CustomTagsEnabled: true }, customRules);
synth('custom-shared-corner', { QualityTagsEnabled: true, AgeRatingTagsEnabled: true, AgeRatingTagsPosition: 'top-left', CustomTagsEnabled: true }, customRules);
synth('custom-order-cap-position', { ...allOn, CustomTagsEnabled: true, CustomTagsPosition: 'top-right', TagLayoutSettingsVersion: 1, TagGroupOrder: ['custom', 'genre'], TagGroupCaps: { Custom: 1 } }, customRules);
synth('custom-off-in-corners', { CustomTagsEnabled: true, TagLayoutSettingsVersion: 1, TagLayouts: { Corners: { Groups: [{ Group: 'custom', Slot: 'off' }] } } }, customRules);
synth('custom-rules-group-off', { QualityTagsEnabled: true }, customRules);
synth('custom-admin-default-on', null, { ...customRules, CustomTagsEnabled: true, CustomTagsPosition: 'bottom-left' });
// Rules reordered after the entries were matched (their ids keep the old order): both sides draw the new order.
synth('custom-reordered-cap', { CustomTagsEnabled: true, TagLayoutSettingsVersion: 1, TagGroupCaps: { Custom: 1 } }, { ...customRules, CustomTagRules: [...customRules.CustomTagRules].reverse() });

synth('language-subs-only', { LanguageTagsEnabled: true, LanguageTagsShowAudio: false, LanguageTagsShowSubtitles: true, LanguageTagsStyle: 'codes' });
synth('language-subs-strict-merge', { LanguageTagsEnabled: true, LanguageTagsShowSubtitles: true, LanguageTagsStyle: 'codes', LanguageTagsCountBadge: 'both' }, { LanguageTagsPriority: 'French, English, Hindi', LanguageTagsPriorityStrict: true, LanguageTagsMergeRegions: true });

synth('awards-all', { AwardsTagsEnabled: true, TagLayoutSettingsVersion: 1, TagGroupCaps: { Awards: 0 } }, { AwardsTagsEnabled: true });
synth('awards-cap', { AwardsTagsEnabled: true, TagLayoutSettingsVersion: 1, TagGroupCaps: { Awards: 2 }, AwardsTagsPosition: 'bottom-right' }, { AwardsTagsEnabled: true });
synth('awards-disabled', { AwardsTagsEnabled: true }, { AwardsTagsEnabled: false });
synth('awards-combined', { ...allOn, AwardsTagsEnabled: true, TagLayoutSettingsVersion: 1, TagGroupOrder: ['awards', 'quality', 'rating'] }, { AwardsTagsEnabled: true, AwardsTagsCertifiedFresh: false });
// Native Bands now follows its active profile, density, order and limits.
synth('native-bands-full', { ...allOn, TagLayoutSettingsVersion: 1, TagLayout: 'bands' });
synth('native-bands-compact', { ...allOn, TagLayoutSettingsVersion: 1, TagLayout: 'bands', TagLabelDensity: 'compact' });
synth('native-bands-custom', { ...allOn, TagLayoutSettingsVersion: 1, TagLayout: 'bands', TagGroupOrder: ['language', 'quality', 'genre'], TagGroupCaps: { Quality: 2 },
    TagLayouts: { Bands: { Groups: [{ Group: 'language', Slot: 'top' }, { Group: 'quality', Slot: 'top' }, { Group: 'rating', Slot: 'off' }, { Group: 'genre', Slot: 'bottom' }] } } });
synth('native-bands-admin', { ...allOn, TagLayoutSettingsVersion: 1, TagLayout: 'bands' }, { TagLayouts: { Bands: { Groups: [{ Group: 'quality', Slot: 'top' }, { Group: 'language', Slot: 'off' }] } } });

// Integrated Awards use active Bands slots with non-default native size/gap.
for (const [scale, gap] of [['smaller', 'tight'], ['largest', 'roomy']]) {
    synth(`native-bands-integrated-${scale}`, { ...allOn, AwardsTagsEnabled: true,
        TagLayoutSettingsVersion: 1, TagLayout: 'bands', TagScale: scale, TagGap: gap,
        TagGroupOrder: ['status', 'awards', 'quality', 'rating', 'language'],
        TagLayouts: { Bands: { Groups: [{ Group: 'awards', Slot: 'top' }] } } }, { AwardsTagsEnabled: true });
}

// Both new groups participate in scale/gap, all nine edge anchors and Bands.
for (const [TagScale, TagGap] of [['smaller', 'tight'], ['largest', 'roomy']])
for (const TagLayout of ['corners', 'bands'])
for (const TagEdgeSpacing of ['tight', 'flush']) {
    synth(`logos-custom-${TagLayout}-${TagEdgeSpacing}-${TagScale}`, {
        LogoTagsEnabled: true, CustomTagsEnabled: true, TagLayoutSettingsVersion: 1,
        TagScale, TagGap, TagLayout, TagEdgeSpacing, TagGroupOrder: ['logos', 'custom'],
    }, customRules);
}

for (const density of ['full', 'compact']) for (const LanguageTagsStyle of ['flags', 'codes']) {
    synth(`technical-${density}-${LanguageTagsStyle}`, { QualityTagsEnabled: true, LanguageTagsEnabled: true,
        LanguageTagsShowSubtitles: true, LanguageTagsStyle, ShowRuntimeTag: true, ShowAspectRatioTag: true, ShowFrameRateTag: true,
        TagLayoutSettingsVersion: 1, TagLayout: 'bands', TagLabelDensity: density, TagGroupCaps: { Quality: 0 } });
}
synth('technical-reordered', { QualityTagsEnabled: true, ShowRuntimeTag: true, ShowAspectRatioTag: true, ShowFrameRateTag: true,
    RuntimeTagOrder: 1, FrameRateTagOrder: 2, AspectRatioTagOrder: 3, TagLayoutSettingsVersion: 1, TagGroupCaps: { Quality: 0 } });

writeFileSync(join(dataDir, 'profiles.json'), JSON.stringify(profiles, null, 1));
console.log(`${profiles.length} profiles (${users.length} real users), ${Object.keys(syntheticEntries).length} synthetic entries, ${Object.keys(syntheticReviews).length} synthetic review keys`);
