import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

// Subtitle search and sync (#1061): enhanced/player/subtitle-search.js driven through its real
// entry points (the OSD button, JE.toggleSubtitleSearch, the shortcut in events.js) with the real
// playback.js (JE.setSubtitleOffset, the own-session probe) and auto-skip.js (source parsing).

const TICKS = 10000000;
const ev = (start, end, text) => ({ Id: String(start), Text: text, StartPositionTicks: Math.round(start * TICKS), EndPositionTicks: Math.round(end * TICKS) });
const STREAM = {
  TrackEvents: [
    ev(22.981, 25.734, '<i>The outcome was never</i>\nin our favor, Gary.'),
    ev(26.359, 27.652, '[Gary] Cut it to me straight, HUE.'),
    ev(56.0, 58.0, 'You are really buttering me up\nwith fantastic news.'),
    ev(60.1, 61.0, "[HUE] I'm afraid, Gary,"),
    ev(64.0, 66.5, 'These tickets suck...\\Nright in the nosebleeds.'),
    ev(67.2, 69.0, '{\\an8}[theme music playing]'),
    ev(110.3, 111.0, 'Aah!')
  ]
};

/** JE.keyCombo as enhanced/config.js defines it. */
function keyCombo(e) {
  const key = e.key;
  const isLetter = /^[a-zA-Z]$/.test(key);
  const isShiftedSymbol = key.length === 1 && key !== ' ' && !isLetter;
  return (e.metaKey ? 'Meta+' : '') + (e.ctrlKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') +
    (e.shiftKey && !isShiftedSymbol ? 'Shift+' : '') + (isLetter ? key.toUpperCase() : key);
}

/** Copies a value out of the page realm so deepEqual compares structure, not prototypes. */
const plain = v => JSON.parse(JSON.stringify(v));

const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(done => setImmediate(done)); };

/**
 * A player page with jellyfin-web's OSD buttons, its hidden subtitle sync control, a video at
 * `time` and (optionally) the cue track jellyfin-web fills.
 */
function setup(t, {
  enabled = true, playState = {}, nowPlaying = {}, stream = { Type: 'Subtitle', Index: 2, DisplayTitle: 'English - SRT', IsTextSubtitleStream: true },
  data = STREAM, cues = 'match', time = 64.98, slider = '0', sessions, renderer = 'cues', jf, src = ''
} = {}) {
  const toasts = [];
  const requests = [];
  const offsets = [];
  let paused = false;
  const session = {
    Id: 'session-1', DeviceId: 'device-1',
    NowPlayingItem: { Id: 'item1', MediaStreams: [], ...nowPlaying },
    PlayState: { IsPaused: true, SubtitleStreamIndex: 2, MediaSourceId: 'src1', ...playState }
  };
  const answers = sessions ? [...sessions] : null;
  const JE = {
    currentSettings: { subtitleSearchButtonEnabled: enabled },
    t: key => key,
    toast: text => toasts.push(text),
    isVideoPage: () => true,
    keyCombo,
    state: { activeShortcuts: { SubtitleSearch: 'Shift+S', SubtitleMenu: 'S' } },
    core: { api: { jf: jf || (async (path, opts) => { requests.push({ path, opts }); return structuredClone(data); }) } }
  };
  const h = createHarness({
    html: `
      <div class="videoOsdBottom"><div class="buttons focuscontainer-x">
        <button class="btnSubtitles autoSize"></button><button class="btnAudio"></button><button class="btnVideoOsdSettings"></button>
      </div></div>
      <div class="videoPlayerContainer"><video></video></div>
      <div class="subtitleSync"><div class="subtitleSyncContainer hide">
        <div class="subtitleSyncTextField">0s</div>
        <input type="range" class="subtitleSyncSlider" step="0.1" min="-30" max="30" value="${slider}">
      </div></div>`,
    url: 'http://jellyfin.test/web/index.html#/video',
    JE,
    apiClient: {
      deviceId: () => 'device-1',
      getItem: async (userId, id) => ({ Id: id, MediaSources: [{ Id: 'src1', MediaStreams: stream ? [stream] : [] }] }),
      ajax: async (req) => {
        if (String(req.url).includes('/Sessions')) {
          const s = answers ? (answers.length > 1 ? answers.shift() : answers[0]) : session;
          return s ? [s] : [];
        }
        throw new Error('unexpected ajax ' + req.url);
      }
    }
  });
  t.after(() => h.close());
  const { window, document } = h;
  window.HTMLElement.prototype.scrollIntoView = function () {};
  const video = document.querySelector('video');
  Object.defineProperty(video, 'paused', { get: () => paused });
  Object.defineProperty(video, 'currentSrc', { get: () => src });
  video.pause = () => { paused = true; };
  video.play = () => { paused = false; return Promise.resolve(); };
  video.currentTime = time;
  const listeners = [];
  const tracks = [];
  if (renderer === 'cues') {
    const cueList = cues === 'match'
      ? STREAM.TrackEvents.map(e => ({ startTime: e.StartPositionTicks / TICKS - Number(slider), text: e.Text.replace(/\\N/g, '\n').replace(/\{\\[^}]*\}/g, '') }))
      : cues;
    tracks.push({ label: 'manualTrack', mode: 'showing', cues: cueList });
  } else if (renderer === 'ass') {
    const parent = document.createElement('div');
    parent.className = 'libassjs-canvas-parent';
    video.parentElement.append(parent);
  }
  Object.defineProperty(video, 'textTracks', { value: Object.assign(tracks, { addEventListener: (n, fn) => listeners.push(fn), removeEventListener() {} }) });
  const sliderEl = document.querySelector('.subtitleSyncSlider');
  sliderEl.updateOffset = function (v) { offsets.push(v); this.value = String(v); };
  h.load('enhanced/player/playback.js');
  h.load('enhanced/player/auto-skip.js');
  h.load('enhanced/player/subtitle-search.js');
  const api = h.JE.internals.subtitleSearch;
  const overlay = () => document.getElementById('je-subtitle-search');
  const text = sel => overlay()?.querySelector(sel)?.textContent;
  const rows = () => [...overlay().querySelectorAll('.je-subsearch-row')];
  const row = startText => rows().find(r => r.textContent.includes(startText));
  return { ...h, api, video, toasts, requests, offsets, overlay, text, rows, row, sliderEl, isPaused: () => paused, setPaused: v => { paused = v; } };
}

// ── Pure helpers ──────────────────────────────────────────────────────────────────────────

test('subtitle lines lose ASS overrides and HTML tags, keep line breaks', t => {
  const { api } = setup(t);
  assert.equal(api.cleanLineText('{\\an8}<i>Hello</i>\\Nthere  you\\hare'), 'Hello\nthere you are');
  assert.equal(api.cleanLineText('<font color="#ff0">Loud</font>\r\n  \n quiet '), 'Loud\nquiet');
  assert.equal(api.cleanLineText('I <3 you & a < b'), 'I <3 you & a < b');
  assert.equal(api.cleanLineText(null), '');
});

test('track events become sorted lines in seconds, empty and broken events skipped', t => {
  const { api } = setup(t);
  const lines = api.parseTrackEvents({ TrackEvents: [ev(5, 6, 'second'), ev(1, 2, 'first'), ev(3, 4, '{\\an8}'), { Text: 'no start' }, null, ev(7, 6, 'bad end')] });
  assert.deepEqual(plain(lines.map(l => [l.index, l.start, l.text])), [[0, 1, 'first'], [1, 5, 'second'], [2, 7, 'bad end']]);
  assert.equal(lines[2].end, 7);
  assert.deepEqual(plain(api.parseTrackEvents({})), []);
  assert.deepEqual(plain(api.parseTrackEvents(null)), []);
});

test('search matches every word, ignoring case, accents and punctuation', t => {
  const { api } = setup(t);
  const lines = api.parseTrackEvents({ TrackEvents: [ev(1, 2, "Don't go, Gary!"), ev(2, 3, 'Café crème'), ev(3, 4, 'Gary goes home'), ev(4, 5, '東京へ行く')] });
  const find = q => plain(api.filterLines(lines, q).map(l => l.text));
  assert.deepEqual(find('dont'), ["Don't go, Gary!"]);
  assert.deepEqual(find("DON'T gary"), ["Don't go, Gary!"]);
  assert.deepEqual(find('cafe CREME'), ['Café crème']);
  assert.deepEqual(find('gary go'), ["Don't go, Gary!", 'Gary goes home']);
  assert.deepEqual(find('東京'), ['東京へ行く']);
  assert.deepEqual(find('   '), plain(lines.map(l => l.text)));
  assert.deepEqual(find('nothing here'), []);
});

test('sync offset is line start minus the moment heard, on the 0.1 s step and within ±30 s', t => {
  const { api } = setup(t);
  // jellyfin-web shows a line at start - offset: a line heard 6.3 s after its start needs -6.3.
  assert.equal(api.syncOffsetFor(56.0, 62.3), -6.3);
  assert.equal(api.syncOffsetFor(64.04, 62.0), 2);
  assert.equal(api.syncOffsetFor(10, 10.04), 0);
  assert.ok(Object.is(api.roundOffset(-0.04), 0));
  assert.equal(api.offsetInRange(30), true);
  assert.equal(api.offsetInRange(-30), true);
  assert.equal(api.offsetInRange(30.1), false);
  assert.equal(api.offsetInRange(NaN), false);
  assert.equal(api.formatOffset(-6.3), '-6.3 s');
  assert.equal(api.formatOffset(2), '+2.0 s');
  assert.equal(api.formatTime(64.98), '1:04');
  assert.equal(api.formatTime(3725), '1:02:05');
});

test('the line on screen is the last one started with the offset applied', t => {
  const { api } = setup(t);
  const lines = api.parseTrackEvents(STREAM);
  assert.equal(lines[api.lineIndexAt(lines, 64.98, 0)].text.startsWith('These tickets'), true);
  assert.equal(lines[api.lineIndexAt(lines, 64.98, 5)].text.startsWith('[theme'), true);
  assert.equal(api.lineIndexAt(lines, 1, 0), -1);
});

test('cue comparison measures the applied offset and tells another track apart', t => {
  const { api } = setup(t);
  const lines = api.parseTrackEvents(STREAM);
  const sample = shift => lines.map(l => ({ start: l.start - shift, key: l.search }));
  assert.equal(api.measureOffset(lines, sample(-6.3)), -6.3);
  assert.equal(api.measureOffset(lines, sample(0)), 0);
  const other = lines.map((l, i) => ({ start: l.start, key: 'andere zeile ' + i }));
  assert.equal(api.measureOffset(lines, other), 'mismatch');
  assert.equal(api.measureOffset(lines, null), null);
  assert.equal(api.measureOffset(lines, [{ start: 1, key: '' }]), null);
});

// ── The OSD button ───────────────────────────────────────────────────────────────────────────

test('the button sits after Subtitles only while the setting is on', t => {
  const h = setup(t, { enabled: false });
  h.JE.addSubtitleSearchButton();
  assert.equal(h.document.getElementById('je-subtitle-search-btn'), null);
  h.JE.currentSettings.subtitleSearchButtonEnabled = true;
  h.JE.addSubtitleSearchButton();
  h.JE.addSubtitleSearchButton();
  const buttons = h.document.querySelectorAll('#je-subtitle-search-btn');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].previousElementSibling.className.includes('btnSubtitles'), true);
  assert.equal(buttons[0].getAttribute('aria-label'), 'Search subtitles');
  // It hides with jellyfin-web's Subtitles button (items without subtitles).
  assert.match(h.document.getElementById('je-subtitle-search-style').textContent, /\.btnSubtitles\.hide \+ #je-subtitle-search-btn/);
  h.JE.currentSettings.subtitleSearchButtonEnabled = false;
  h.JE.addSubtitleSearchButton();
  assert.equal(h.document.getElementById('je-subtitle-search-btn'), null);
});

// ── Sync, jump and the cases that can't sync ─────────────────────────────────────────────────

test('choosing a line syncs it to the moment the dialog opened and resumes playback', async t => {
  const h = setup(t);
  h.JE.addSubtitleSearchButton();
  h.document.getElementById('je-subtitle-search-btn').click();
  assert.equal(h.isPaused(), true, 'the dialog pauses playback');
  await flush();
  assert.deepEqual(h.requests.map(r => r.path), ['/Videos/item1/src1/Subtitles/2/0/Stream.js']);
  assert.equal(h.requests[0].opts.timeoutMs > 0 && !!h.requests[0].opts.signal, true);
  assert.equal(h.rows().length, 7);
  assert.equal(h.text('.je-subsearch-track'), 'English - SRT');
  assert.equal(h.text('.je-subsearch-anchor'), 'Heard at 1:04');
  assert.equal(h.text('.je-subsearch-offset'), 'Offset 0.0 s');
  assert.match(h.overlay().querySelector('.is-current').textContent, /These tickets suck\.\.\.\nright in the nosebleeds/);
  assert.equal(h.text('.je-subsearch-foot'), '7 of 7 lines');
  h.row('buttering me up').querySelector('.je-subsearch-line').click();
  assert.deepEqual(h.offsets, [-9]);
  assert.equal(h.overlay(), null);
  assert.equal(h.isPaused(), false, 'resumed because the dialog paused it');
  assert.equal(h.toasts.length, 1);
  assert.equal(h.document.querySelector('.subtitleSyncContainer').classList.contains('hide'), false, 'jellyfin-web\'s offset panel flashes');
});

test('a line more than 30 s away is refused and nothing changes', async t => {
  const h = setup(t);
  h.JE.toggleSubtitleSearch();
  await flush();
  h.row('outcome was never').querySelector('.je-subsearch-line').click();
  assert.deepEqual(h.offsets, []);
  assert.ok(h.overlay(), 'the dialog stays open');
  assert.match(h.text('.je-subsearch-status'), /That line is -42\.0 s away\. Jellyfin can shift subtitles by up to 30 seconds/);
  assert.equal(h.isPaused(), true);
});

test('the jump button seeks to where the line shows with the current offset', async t => {
  const h = setup(t, { slider: '2' });
  h.JE.toggleSubtitleSearch();
  await flush();
  assert.equal(h.text('.je-subsearch-offset'), 'Offset +2.0 s');
  assert.equal(h.row('Aah!').querySelector('.je-subsearch-time').textContent, '1:48');
  h.row('Aah!').querySelector('.je-subsearch-jump').click();
  assert.ok(Math.abs(h.video.currentTime - 108.3) < 1e-9);
  assert.deepEqual(h.offsets, []);
  assert.equal(h.overlay(), null);
  assert.equal(h.isPaused(), false);
});

test('a progressive transcode seeks on the element clock', async t => {
  const h = setup(t, { renderer: 'none', src: 'http://jellyfin.test/Videos/item1/stream.mp4?StartTimeTicks=600000000', time: 4.98 });
  h.JE.toggleSubtitleSearch();
  await flush();
  assert.equal(h.text('.je-subsearch-anchor'), 'Heard at 1:04');
  h.row('Aah!').querySelector('.je-subsearch-jump').click();
  assert.ok(Math.abs(h.video.currentTime - 50.3) < 1e-9);
});

test('burned-in subtitles list lines but choosing one jumps, as the hint says', async t => {
  const h = setup(t, { renderer: 'none' });
  h.JE.toggleSubtitleSearch();
  await flush();
  assert.match(h.text('.je-subsearch-hint'), /part of the video picture/);
  h.row('Aah!').querySelector('.je-subsearch-line').click();
  assert.deepEqual(h.offsets, []);
  assert.ok(Math.abs(h.video.currentTime - 110.3) < 1e-9);
});

test('ASS subtitles drawn by libass can be synced', async t => {
  const h = setup(t, { renderer: 'ass' });
  h.JE.toggleSubtitleSearch();
  await flush();
  assert.match(h.text('.je-subsearch-hint'), /sync the subtitles/);
  h.row("I'm afraid").querySelector('.je-subsearch-line').click();
  assert.deepEqual(h.offsets, [-4.9]);
});

test('image subtitles, no subtitles and an unknown session explain themselves without a lines request', async t => {
  const image = setup(t, { stream: { Type: 'Subtitle', Index: 2, Codec: 'PGSSUB', DisplayTitle: 'English - PGSSUB', IsTextSubtitleStream: false } });
  image.JE.toggleSubtitleSearch();
  await flush();
  assert.match(image.text('.je-subsearch-status'), /made of images/);
  assert.deepEqual(image.requests, []);
  assert.equal(image.text('.je-subsearch-offset'), '');

  const off = setup(t, { playState: { SubtitleStreamIndex: -1 } });
  let menuOpened = 0;
  off.document.querySelector('.btnSubtitles').addEventListener('click', () => menuOpened++);
  off.JE.toggleSubtitleSearch();
  await flush();
  assert.match(off.text('.je-subsearch-status'), /Turn on a subtitle track first/);
  off.overlay().querySelector('.je-subsearch-status button').click();
  assert.equal(menuOpened, 1);
  assert.equal(off.overlay(), null);

  const other = setup(t, { src: 'http://jellyfin.test/Videos/aaaaaaaabbbbccccddddeeeeeeeeeeee/stream.mp4?Static=true' });
  other.JE.toggleSubtitleSearch();
  await flush();
  assert.match(other.text('.je-subsearch-status'), /Couldn't tell which subtitles are playing/);
  assert.deepEqual(other.requests, []);
});

test('a failed lines request offers a retry that loads them', async t => {
  let calls = 0;
  const h = setup(t, { jf: async () => { calls++; if (calls === 1) throw new Error('500'); return structuredClone(STREAM); } });
  h.allowConsoleError(/./);
  h.JE.toggleSubtitleSearch();
  await flush();
  assert.match(h.text('.je-subsearch-status'), /Couldn't load the subtitle lines/);
  h.overlay().querySelector('.je-subsearch-status button').click();
  await flush();
  assert.equal(h.rows().length, 7);
  assert.equal(h.text('.je-subsearch-status'), '');
});

test('the track is read after the server shows the pause, so a just-chosen track is used', async t => {
  const stale = { Id: 'session-1', DeviceId: 'device-1', NowPlayingItem: { Id: 'item1', MediaStreams: [] }, PlayState: { IsPaused: false, SubtitleStreamIndex: -1, MediaSourceId: 'src1' } };
  const fresh = { ...stale, PlayState: { IsPaused: true, SubtitleStreamIndex: 2, MediaSourceId: 'src1' } };
  const h = setup(t, { sessions: [stale, fresh] });
  h.JE.toggleSubtitleSearch();
  await flush();
  await new Promise(done => setTimeout(done, 500));
  await flush();
  assert.equal(h.rows().length, 7);
  assert.deepEqual(h.requests.map(r => r.path), ['/Videos/item1/src1/Subtitles/2/0/Stream.js']);
});

test('lines that do not match the cues on screen are not offered', async t => {
  const cues = [1, 2, 3, 4, 5].map(i => ({ startTime: i * 10, text: 'Zeile ' + i + ' auf Deutsch' }));
  const h = setup(t, { cues });
  h.JE.toggleSubtitleSearch();
  await flush();
  assert.match(h.text('.je-subsearch-status'), /don't match the subtitles on screen/);
  assert.equal(h.overlay().querySelectorAll('.je-subsearch-row').length, 0);
});

test('the offset shown is the one on the cues, not a slider left over from another track', async t => {
  // jellyfin-web resets the offset to 0 on a track switch but leaves its hidden slider at -6.3.
  const h = setup(t, { slider: '0' });
  h.sliderEl.value = '-6.3';
  h.JE.toggleSubtitleSearch();
  await flush();
  assert.equal(h.text('.je-subsearch-offset'), 'Offset 0.0 s');
  assert.equal(h.overlay().querySelector('.je-subsearch-meta .je-subsearch-reset').hidden, true);
  h.row('Aah!').querySelector('.je-subsearch-jump').click();
  assert.ok(Math.abs(h.video.currentTime - 110.3) < 1e-9);
});

test('searching hides other rows and counts matches', async t => {
  const h = setup(t);
  h.JE.toggleSubtitleSearch();
  await flush();
  const input = h.overlay().querySelector('.je-subsearch-input');
  assert.equal(h.document.activeElement, input);
  input.value = 'GARY';
  input.dispatchEvent(new h.window.Event('input'));
  await new Promise(done => setTimeout(done, 120));
  assert.deepEqual(h.rows().filter(r => !r.hidden).map(r => r.dataset.index), ['0', '1', '3']);
  assert.equal(h.text('.je-subsearch-foot'), '3 of 7 lines');
  input.value = 'zzz';
  input.dispatchEvent(new h.window.Event('input'));
  await new Promise(done => setTimeout(done, 120));
  assert.equal(h.text('.je-subsearch-empty'), 'No lines match your search.');
});

test('the [ and ] offset nudges still step from jellyfin-web\'s slider', async t => {
  const h = setup(t, { slider: '1.2' });
  h.JE.adjustSubtitleOffset(0.1);
  h.JE.adjustSubtitleOffset(-0.3);
  assert.deepEqual(plain(h.offsets), [1.3, 1]);
  assert.equal(h.document.querySelector('.subtitleSyncContainer').classList.contains('hide'), false);
  h.sliderEl.remove();
  h.JE.adjustSubtitleOffset(0.1);
  assert.equal(h.toasts.at(-1), 'Subtitle offset is not available');
  assert.equal(h.JE.setSubtitleOffset(2), false);
});

// ── Keys, closing and stale answers ──────────────────────────────────────────────────────────

test('keys typed in the dialog never reach the player; Escape closes and resumes', async t => {
  const h = setup(t);
  h.load('enhanced/events.js');
  const reached = [];
  h.document.addEventListener('keydown', e => reached.push(e.key)); // jellyfin-web's player keys
  h.document.addEventListener('keydown', h.JE.keyListener, true);
  let menuOpened = 0;
  h.document.querySelector('.btnSubtitles').addEventListener('click', () => menuOpened++);
  h.document.body.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'S', shiftKey: true, bubbles: true }));
  assert.ok(h.overlay(), 'Shift+S opens the dialog');
  assert.equal(menuOpened, 0);
  await flush();
  const input = h.overlay().querySelector('.je-subsearch-input');
  input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(h.document.activeElement.closest('.je-subsearch-row').classList.contains('is-current'), true, 'ArrowDown enters the list at the highlighted line');
  // A row button has focus: JE's own S (Subtitle Menu) must not fire either.
  h.document.activeElement.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 's', bubbles: true }));
  assert.equal(menuOpened, 0);
  assert.deepEqual(reached, [], 'no key reached the player\'s own listener');
  h.document.activeElement.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(h.overlay(), null);
  assert.equal(h.isPaused(), false);
});

test('the shortcut closes the dialog from a line', async t => {
  const h = setup(t);
  h.JE.toggleSubtitleSearch();
  await flush();
  const line = h.overlay().querySelector('.je-subsearch-line');
  line.focus();
  line.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'S', shiftKey: true, bubbles: true }));
  assert.equal(h.overlay(), null);
});

test('a dialog opened on paused playback leaves it paused', async t => {
  const h = setup(t);
  h.setPaused(true);
  h.JE.toggleSubtitleSearch();
  await flush();
  h.row('buttering me up').querySelector('.je-subsearch-line').click();
  assert.deepEqual(h.offsets, [-9]);
  assert.equal(h.isPaused(), true);
});

test('an answer that arrives after the dialog closed or the video changed is dropped', async t => {
  let release;
  const h = setup(t, { jf: () => new Promise(resolve => { release = () => resolve(structuredClone(STREAM)); }) });
  h.JE.toggleSubtitleSearch();
  await flush();
  h.JE.toggleSubtitleSearch(); // close while the lines are loading
  assert.equal(h.overlay(), null);
  release();
  await flush();
  assert.equal(h.document.querySelector('.je-subsearch-row'), null);

  const v = setup(t);
  v.JE.toggleSubtitleSearch();
  v.video.dispatchEvent(new v.window.Event('emptied')); // the source changed (next episode)
  await flush();
  assert.equal(v.overlay(), null);
  assert.equal(v.isPaused(), true, 'not resumed onto a different source');
});

test('leaving the player closes the dialog without resuming', async t => {
  const h = setup(t);
  h.JE.toggleSubtitleSearch();
  await flush();
  h.window.location.hash = '#/home';
  h.window.dispatchEvent(new h.window.HashChangeEvent('hashchange'));
  assert.equal(h.overlay(), null);
  assert.equal(h.isPaused(), true);
});
