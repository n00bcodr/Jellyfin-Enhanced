#!/usr/bin/env node
// Reproducible large-library benchmark of the browser's tag cache load (no server, no browser needed):
//   node scripts/bench-tag-cache.mjs [entries=50000] [page=2000] [cap=20000]   (each load runs in its own process)
// It builds a deterministic synthetic cache whose entries have the shape and size of real ones (versions,
// video/audio/subtitle streams with the fields the server stores for each, distinct qualities, ratings, languages,
// series summaries and episode id lists; about 4.2 KB of JSON each, against 4.6 KB on a 3,892-entry library
// measured in November 2026; the run prints the size it built), then measures the two ways a browser can take it in:
//   - one response: the whole body as one string, one JSON.parse, one Map;
//   - pages (GET tag-cache?limit=&after=) held whole until the stored copy commits (the load before it was bounded);
//   - pages streamed (js/tags/tag-pipeline.js fetchFullPages): up to the soft cap in memory, then into the stored
//     copy as they arrive; the peak heap over the load is what is reported.
// Reported: body sizes, the longest single parse (a main-thread task), total parse time, and the heap the
// cache keeps (after a forced GC). Times depend on the machine; sizes and entry counts do not.
import { performance } from 'node:perf_hooks';

const entries = Number(process.argv[2] || 50000);
const pageSize = Number(process.argv[3] || 2000);
const softCap = Number(process.argv[4] || 20000);
const gc = globalThis.gc || (() => {});

/** A small deterministic PRNG (mulberry32), so every run builds the same library. */
function random(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = random(42);
const pick = (list) => list[Math.floor(rnd() * list.length)];
const LANGS = ['eng', 'jpn', 'fre', 'ger', 'spa', 'ita', 'kor', 'por', 'rus', 'chi'];
const GENRES = ['Drama', 'Comedy', 'Action', 'Thriller', 'Science Fiction', 'Animation', 'Documentary', 'Horror', 'Romance', 'Crime'];

function entry(i) {
  const id = i.toString(16).padStart(32, '0');
  const type = i % 10 < 6 ? 'Episode' : i % 10 < 9 ? 'Movie' : 'Series';
  const versions = rnd() < 0.08 ? 2 : 1;
  const streams = [];
  const sources = [];
  for (let v = 0; v < versions; v++) {
    const sourceId = `${id.slice(0, 24)}${String(v).padStart(8, '0')}`;
    const uhd = rnd() < 0.3;
    sources.push({ Id: sourceId, Path: `Title.${2000 + (i % 25)}.${uhd ? '2160p' : '1080p'}.${pick(['BluRay', 'WEB-DL', 'REMUX'])}.${pick(['x265', 'x264'])}-GRP${i % 97}.mkv`, Source: pick(['BluRay', 'WEB', 'REMUX']), RunTimeTicks: 30000000000 + Math.floor(rnd() * 60000000000), Revision: Math.floor(rnd() * 2 ** 48).toString(16).padStart(12, '0') });
    streams.push({ Type: 'Video', SourceId: sourceId, Codec: uhd ? 'hevc' : 'h264', Profile: uhd ? 'Main 10' : 'High', Height: uhd ? 2160 : 1080, Width: uhd ? 3840 : 1920, AspectRatio: '16:9', RealFrameRate: 23.976025, AverageFrameRate: 23.976025, IsInterlaced: false, IsHearingImpaired: false, VideoRangeType: uhd ? pick(['HDR10', 'DOVIWithHDR10', 'SDR']) : 'SDR', DisplayTitle: `${uhd ? '4K' : '1080p'} ${uhd ? 'HEVC' : 'H264'} ${uhd ? 'HDR10' : 'SDR'}` });
    const audio = 1 + Math.floor(rnd() * 3);
    for (let a = 0; a < audio; a++) streams.push({ Type: 'Audio', SourceId: sourceId, Language: pick(LANGS), Codec: pick(['truehd', 'eac3', 'ac3', 'dts', 'aac']), IsInterlaced: false, IsHearingImpaired: false, Title: a === 0 ? null : pick(['Commentary', 'European', 'Descriptive']), Channels: pick([2, 6, 8]), ChannelLayout: pick(['stereo', '5.1', '7.1']), DisplayTitle: `${pick(['English', 'Japanese', 'French'])} - ${pick(['Dolby TrueHD', 'Dolby Digital+', 'Dolby Digital'])} - ${pick(['5.1', '7.1', 'Stereo'])}${a === 0 ? ' - Default' : ''}` });
    // About ten subtitle tracks on an average item (many episodes carry a dozen languages).
    const subs = Math.floor(rnd() * 19);
    for (let s = 0; s < subs; s++) streams.push({ Type: 'Subtitle', SourceId: sourceId, Language: pick(LANGS), Codec: pick(['subrip', 'pgssub', 'ass']), IsInterlaced: false, IsHearingImpaired: rnd() < 0.1, Title: rnd() < 0.3 ? pick(['Forced', 'SDH', 'Signs & Songs']) : null, DisplayTitle: `${pick(['English', 'French', 'German'])} - ${pick(['SUBRIP', 'PGSSUB'])}${s === 0 ? ' - Default' : ''}` });
  }
  const distinct = [];
  for (const source of sources) {
    distinct.push({ Category: 'videoCodec', Label: pick(['HEVC', 'H264']), SourceId: source.Id }, { Category: 'dynamicRange', Label: pick(['SDR', 'HDR10', 'Dolby Vision']), SourceId: source.Id });
    for (const lang of [pick(LANGS), pick(LANGS)]) distinct.push({ Category: 'audioInfo', Label: pick(['Dolby Digital+ 5.1', 'TRUEHD 7.1', 'Dolby Digital 5.1']), Language: lang, SourceId: source.Id });
  }
  // Series and seasons carry their episodes' summary and the episode ids their facts came from.
  const parent = type === 'Series' || i % 17 === 0;
  const episodeIds = parent ? Array.from({ length: 30 }, (_, e) => (i * 64 + e).toString(16).padStart(32, '0')) : undefined;
  return [id, {
    Type: type, TmdbId: String(1000 + i), Genres: [pick(GENRES), pick(GENRES)], CommunityRating: Math.round(rnd() * 100) / 10, CriticRating: Math.floor(rnd() * 100),
    OfficialRating: pick(['PG-13', 'R', 'TV-MA', 'TV-14', 'PG']), AudioLanguages: [pick(LANGS), pick(LANGS)], SubtitleLanguages: [pick(LANGS), pick(LANGS), pick(LANGS)],
    Ratings: { imdb: Math.round(rnd() * 100) / 10, tmdb: Math.floor(rnd() * 100), rtCritic: Math.floor(rnd() * 100) },
    StreamData: { RunTimeTicks: sources[0].RunTimeTicks, ItemName: `Title ${i}`, DistinctQualities: distinct, Streams: streams, Sources: sources },
    LibraryId: (i % 4).toString(16).padStart(32, 'a'),
    QualitySummary: parent ? { Resolutions: ['4K', '1080p'], Sources: ['WEB'], Codecs: ['HEVC'], Audio: ['Dolby Digital+ 5.1'], Episodes: 20, Mixed: true } : undefined,
    QualityEpisodeIds: episodeIds, StatusEpisodeIds: episodeIds,
    DateCreated: 1700000000000 + i * 1000, PremiereDate: 1500000000000 + i * 1000, SeriesId: type === 'Episode' ? (i - (i % 40)).toString(16).padStart(32, '0') : undefined,
    LastUpdated: 1700000000000 + i,
  }];
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
const heap = () => { gc(); gc(); return process.memoryUsage().heapUsed; };
const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice(7);

/**
 * One measurement in this process, from an empty heap: the bodies are built and the source entries let go
 * before parsing, and the bodies are let go after, so the heap left is what the cache keeps.
 * @returns {Array<Array<string|number>>} Table rows.
 */
function measure(paged) {
  const empty = heap();
  let pairs = Array.from({ length: entries }, (_, i) => entry(i));
  const perEntry = Math.round(Buffer.byteLength(JSON.stringify(Object.fromEntries(pairs))) / entries);
  let bodies = [];
  const size = paged ? pageSize : entries;
  for (let i = 0; i < pairs.length; i += size) {
    bodies.push(JSON.stringify({ version: 1, timestamp: 1, count: Math.min(size, pairs.length - i), items: Object.fromEntries(pairs.slice(i, i + size)), next: i + size < pairs.length ? pairs[i + size - 1][0] : undefined }));
  }
  pairs = null;
  const largest = Math.max(...bodies.map((b) => Buffer.byteLength(b)));
  const total = bodies.reduce((sum, b) => sum + Buffer.byteLength(b), 0);
  let map = new Map();
  let longest = 0;
  let parseTotal = 0;
  for (let i = 0; i < bodies.length; i++) {
    const t0 = performance.now();
    const page = JSON.parse(bodies[i]);
    const took = performance.now() - t0;
    bodies[i] = null;
    longest = Math.max(longest, took);
    parseTotal += took;
    for (const pair of Object.entries(page.items)) map.set(pair[0], pair[1]);
  }
  bodies = null;
  const count = map.size;
  const rows = [[paged ? `${Math.ceil(count / pageSize)} pages of ${pageSize}` : 'one response', mb(total), mb(largest), `${longest.toFixed(0)} ms`, `${parseTotal.toFixed(0)} ms`, mb(heap() - empty), count, perEntry]];
  if (paged && count > softCap) {
    map = new Map([...map].slice(-softCap));
    rows.push([`… after the stored copy commits (soft cap ${softCap})`, '', '', '', '', mb(heap() - empty), map.size, perEntry]);
  }
  return rows;
}

/**
 * The bounded load (js/tags/tag-pipeline.js fetchFullPages): pages accumulate up to the soft cap, then what is held
 * and every later page go into the stored copy (here: structured-cloned and dropped, as IndexedDB takes a copy) and
 * memory keeps none of them. Each page is built only when it is "fetched", so the heap holds what the browser
 * would: the entries kept plus the page in hand. Reports the most heap held between pages (measured after a forced GC
 * per page, so transient garbage and IndexedDB's own copies are not counted: a browser's raw peak is higher).
 * @returns {Array<Array<string|number>>} Table rows.
 */
function measureStreamed() {
  const empty = heap();
  let held = [];
  let streaming = false;
  let peak = 0;
  let longest = 0;
  let parseTotal = 0;
  let total = 0;
  let largest = 0;
  let perEntry = 0;
  let pages = 0;
  for (let i = 0; i < entries; i += pageSize) {
    let body = JSON.stringify({ version: 1, timestamp: 1, count: Math.min(pageSize, entries - i), items: Object.fromEntries(Array.from({ length: Math.min(pageSize, entries - i) }, (_, k) => entry(i + k))) });
    const bytes = Buffer.byteLength(body);
    total += bytes; largest = Math.max(largest, bytes); pages++;
    const t0 = performance.now();
    const page = JSON.parse(body);
    const took = performance.now() - t0;
    body = null;
    longest = Math.max(longest, took); parseTotal += took;
    const pairs = Object.entries(page.items);
    if (streaming) structuredClone(pairs);
    else {
      for (const pair of pairs) held.push(pair);
      if (held.length > softCap) { structuredClone(held); held = []; streaming = true; }
    }
    peak = Math.max(peak, heap() - empty);
  }
  perEntry = Math.round(total / entries);
  return [[`${pages} pages of ${pageSize}, streamed into the stored copy past ${softCap}`, mb(total), mb(largest), `${longest.toFixed(0)} ms`, `${parseTotal.toFixed(0)} ms`, `${mb(peak)} at most between pages`, held.length, perEntry]];
}

if (mode) {
  console.log(JSON.stringify(mode === 'streamed' ? measureStreamed() : measure(mode === 'paged')));
} else {
  // Each load in its own process, so one's garbage never counts against the other.
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const run = (m) => JSON.parse(execFileSync(process.execPath, ['--expose-gc', '--max-old-space-size=8192', fileURLToPath(import.meta.url), String(entries), String(pageSize), String(softCap), `--mode=${m}`], { encoding: 'utf8', maxBuffer: 1 << 20 }).trim().split('\n').at(-1));
  const rows = [...run('one'), ...run('paged'), ...run('streamed')];
  console.log(`Synthetic library: ${entries} entries, ${rows[0][7]} bytes of JSON per entry, node ${process.version}`);
  console.log('| Load | JSON in all | Largest body | Longest parse | All parses | Heap kept | Entries in memory |');
  console.log('|---|---|---|---|---|---|---|');
  for (const row of rows) console.log(`| ${row.slice(0, 7).join(' | ')} |`);
}
