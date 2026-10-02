#!/usr/bin/env node
// Builds the parity profiles: one per real user fetched by fetch-inputs.mjs
// (their own settings, tag cache, UserData and review averages) plus synthetic
// profiles that exercise every toggle, position, order and admin key, run over
// the admin's tag cache plus hand-made edge-case entries.
//
// Output: data/profiles.json and data/synthetic/{entries,userdata,reviews}.json.
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

writeFileSync(join(dataDir, 'profiles.json'), JSON.stringify(profiles, null, 1));
console.log(`${profiles.length} profiles (${users.length} real users), ${Object.keys(syntheticEntries).length} synthetic entries, ${Object.keys(syntheticReviews).length} synthetic review keys`);
