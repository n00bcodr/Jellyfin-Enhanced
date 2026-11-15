// Player shortcuts on a player without a <video> (#1062, #835): Jellyfin Desktop and Jellyfin Media
// Player play through mpv with their own jellyfin-web player plugin, so the player page has jellyfin-web's
// video OSD but no media element. The real modules run against an OSD shaped like jellyfin-web's
// (apps/legacy/controllers/playback/video/index.html): a position text, a remaining-time text, a position
// slider whose change seeks, a rating button carrying the item id and the settings button.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

/** jellyfin-web's own combo rules, as events.js expects JE.keyCombo to produce them. */
function keyCombo(e) {
  const key = e.key;
  const isLetter = /^[a-zA-Z]$/.test(key);
  const isShiftedSymbol = key.length === 1 && key !== ' ' && !isLetter;
  return (e.metaKey ? 'Meta+' : '') + (e.ctrlKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') +
    (e.shiftKey && !isShiftedSymbol ? 'Shift+' : '') + (isLetter ? key.toUpperCase() : key);
}

const ITEM_A = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(done => setTimeout(done, 5)); };

/** "m:ss" or "h:mm:ss", as jellyfin-web's getDisplayRunningTime shows whole seconds. */
function runningTime(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

const OSD = (video) => `
  <div id="videoOsdPage" data-role="page" class="page libraryPage">
    <div class="videoOsdBottom videoOsdBottom-maincontrols"><div class="osdControls">
      <div class="osdTextContainer startTimeText osdPositionText"></div>
      <input type="range" step=".01" min="0" max="100" value="0" class="osdPositionSlider">
      <div class="osdTextContainer endTimeText osdDurationText"></div>
      <div class="buttons focuscontainer-x">
        <button class="btnPause autoSize"><span class="material-icons pause"></span></button>
        <button class="btnUserRating" data-id="${ITEM_A}"></button>
        <button class="btnSubtitles"></button>
        <button class="btnVideoOsdSettings"></button>
      </div>
    </div></div>
  </div>
  <div class="videoPlayerContainer">${video ? '<video></video>' : ''}</div>`;

/**
 * A player page without a <video>. `show(position)` plays jellyfin-web's OSD update for a position;
 * the slider's change listener stands in for playbackManager.seekPercent and moves the player there.
 */
function setup(t, { video = false, duration = 1200, remaining = true, shortcuts = {}, ajax, sheets = true, clock = false } = {}) {
  const toasts = [];
  const seeks = [];
  const chosen = [];
  const JE = {
    currentSettings: {},
    t: (key, args) => (args ? `${key}:${JSON.stringify(args)}` : key),
    toast: text => toasts.push(text),
    isVideoPage: () => true,
    keyCombo,
    icons: { wrapEmoji: e => e },
    state: { activeShortcuts: { JumpToLastPosition: 'Z', JumpToPercentage: '0-9', CycleAspectRatio: 'A', IncreasePlaybackSpeed: '+', DecreasePlaybackSpeed: '-', ResetPlaybackSpeed: 'R', FrameStepForward: '.', SkipIntroOutro: 'O', ...shortcuts } },
  };
  const h = createHarness({
    html: OSD(video),
    url: 'http://jellyfin.test/web/index.html#/video',
    JE,
    apiClient: { deviceId: () => 'device-1', ajax: ajax || (async (req) => { throw new Error('unexpected ajax ' + req.url); }) },
  });
  t.after(() => h.close());
  const { document } = h;
  if (!h.window.PointerEvent) h.window.PointerEvent = h.window.MouseEvent;
  // Opt-in controlled clock: the seek history counts the time played between OSD readings.
  let now = 1_700_000_000_000;
  if (clock) h.window.Date.now = () => now;
  const advance = (ms) => { now += ms; };
  const setPaused = (paused) => {
    const icon = document.querySelector('.btnPause .material-icons');
    icon.classList.remove('play_arrow', 'pause');
    icon.classList.add(paused ? 'play_arrow' : 'pause');
  };
  const text = document.querySelector('.osdPositionText');
  const durationText = document.querySelector('.osdDurationText');
  const slider = document.querySelector('.osdPositionSlider');
  let state = { duration, position: 0 };
  const player = { moveOnSeek: true };
  const show = (position, d = state.duration) => {
    state = { duration: d, position };
    text.textContent = runningTime(position);
    durationText.textContent = remaining ? `-${runningTime(d - position)}` : runningTime(d);
    slider.value = String((position / d) * 100);
  };
  slider.addEventListener('change', () => {
    const percent = parseFloat(slider.value);
    seeks.push(percent);
    if (player.moveOnSeek) show((percent / 100) * state.duration);
  });
  if (sheets) installSettingsMenu(h, chosen);
  h.load('core/dom-observer.js');
  h.load('enhanced/player/osd-playback.js');
  h.load('enhanced/player/playback.js');
  h.load('enhanced/player/now-playing.js');
  /** The user drags or clicks the timeline: jellyfin-web's emby-slider fires change on release. */
  const dragTo = (seconds) => {
    slider.value = String((seconds / state.duration) * 100);
    slider.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  };
  return { ...h, toasts, seeks, chosen, show, slider, text, durationText, player, advance, setPaused, dragTo, state: () => state };
}

/**
 * jellyfin-web's player settings menu, as the action sheet renders it: the settings button opens a sheet
 * of items; Playback Speed and Aspect Ratio replace it with a sheet of options where only the current
 * one's check icon is visible; choosing one removes the sheet (it applies on close).
 */
function installSettingsMenu(h, chosen) {
  const { document } = h;
  const current = { playbackrate: '1', aspectratio: 'normal' };
  const lists = {
    playbackrate: [['0.5', '0.5x'], ['0.75', '0.75x'], ['1', '1x'], ['1.25', '1.25x'], ['1.5', '1.5x'], ['2', '2x']],
    aspectratio: [['normal', 'Auto'], ['zoom', 'Cover'], ['stretch', 'Fill']],
  };
  const sheet = (rows) => {
    const container = document.createElement('div');
    container.className = 'dialogContainer';
    container.innerHTML = `<div class="actionSheet"><div class="actionSheetContent">${rows}</div></div>`;
    document.body.append(container);
    return container;
  };
  document.querySelector('.btnVideoOsdSettings').addEventListener('click', () => {
    const main = sheet('<button data-id="aspectratio">Aspect Ratio</button><button data-id="playbackrate">Playback Speed</button><button data-id="stats">Playback Info</button>');
    main.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
      const menu = btn.getAttribute('data-id');
      main.remove();
      setTimeout(() => {
        const sub = sheet(lists[menu].map(([id, name]) => `<button data-id="${id}"><span class="material-icons check"${id === current[menu] ? '' : ' style="visibility:hidden;"'}></span><div class="actionSheetItemText">${name}</div></button>`).join(''));
        sub.querySelectorAll('button').forEach(option => option.addEventListener('click', () => {
          current[menu] = option.getAttribute('data-id');
          chosen.push([menu, current[menu]]);
          setTimeout(() => sub.remove(), 20);
        }));
      }, 10);
    }));
  });
}

// ── The OSD bridge ───────────────────────────────────────────────────────────────────────────────

test('OSD running times parse as jellyfin-web shows them', t => {
  const h = setup(t);
  const { parseRunningTime } = h.JE.internals.osdPlayback;
  assert.equal(parseRunningTime('2:03'), 123);
  assert.equal(parseRunningTime('1:02:03'), 3723);
  assert.equal(parseRunningTime('-21:48'), -1308);
  assert.equal(parseRunningTime(' 0:07 '), 7);
  for (const bad of ['', 'abc', '12', '1:2:3:4', null, undefined, '1:xx']) assert.equal(parseRunningTime(bad), null, String(bad));
});

test('position and duration come from the showing OSD, with total or remaining time', t => {
  const h = setup(t);
  const osd = h.JE.internals.osdPlayback;
  h.show(65.4);
  assert.equal(osd.positionSeconds(), 65);
  assert.equal(osd.durationSeconds(), 1199, 'position + remaining, each in whole seconds');
  h.durationText.textContent = '20:00';
  assert.equal(osd.durationSeconds(), 1200);
  h.text.classList.add('hide');
  assert.equal(osd.positionSeconds(), null, 'a hidden position text (live TV, not started) is no position');
  h.text.classList.remove('hide');
  h.document.getElementById('videoOsdPage').classList.add('hide');
  assert.equal(osd.positionSeconds(), null, 'a hidden earlier OSD view is not read');
});

test('seeking moves the OSD position slider and fires its change, clamped to the item', t => {
  const h = setup(t);
  const osd = h.JE.internals.osdPlayback;
  h.show(10);
  assert.equal(osd.seekTo(600), true);
  assert.ok(Math.abs(h.seeks.at(-1) - (600 / 1200) * 100) < 0.01);
  assert.equal(osd.seekToPercent(150), true);
  assert.equal(h.seeks.at(-1), 100);
  h.slider.disabled = true;
  assert.equal(osd.seekTo(30), false, 'jellyfin-web disables the slider when nothing is playing');
  h.slider.disabled = false;
  h.durationText.textContent = '';
  assert.equal(osd.seekToPercent(10), false, 'no duration shown: no seek');
});

// ── Jump to Last Position ────────────────────────────────────────────────────────────────────────

test('without a <video>, Jump to Last Position returns to where a seek left from, once', async t => {
  const h = setup(t);
  h.JE.watchOsdPosition();
  h.show(40); await flush();
  h.show(41); await flush();
  h.JE.jumpToLastPosition();
  assert.match(h.toasts.at(-1), /No previous position saved/, 'normal playback is not a seek');
  h.show(71); await flush(); // jellyfin-web's +30 s
  h.JE.jumpToLastPosition();
  assert.ok(Math.abs(h.seeks.at(-1) - (41 / 1200) * 100) < 0.01, 'jumps to the position before the seek');
  assert.equal(h.toasts.at(-1), 'toast_jumped_back:{"time":"0:41"}');
  await flush();
  h.JE.jumpToLastPosition();
  assert.match(h.toasts.at(-1), /No previous position saved/, 'the jump itself is not remembered as a seek');
});

test('without a <video>, backward seeks count, small steps and pauses do not', async t => {
  const h = setup(t);
  h.JE.watchOsdPosition();
  h.show(300); await flush();
  h.show(302); await flush(); // two seconds of playback
  h.show(301); await flush(); // the text's rounding
  h.JE.jumpToLastPosition();
  assert.match(h.toasts.at(-1), /No previous position saved/);
  h.show(291); await flush(); // jellyfin-web's -10 s
  h.JE.jumpToLastPosition();
  assert.ok(Math.abs(h.seeks.at(-1) - (301 / 1200) * 100) < 0.01);
});

test('without a <video>, another item starts a new history', async t => {
  const h = setup(t);
  h.JE.watchOsdPosition();
  h.show(100); await flush();
  h.show(500); await flush(); // a seek in item A
  h.document.querySelector('.btnUserRating').setAttribute('data-id', 'item-b');
  h.show(3, 1500); await flush(); // the next episode started
  h.JE.jumpToLastPosition();
  assert.match(h.toasts.at(-1), /No previous position saved/, 'item A\'s position is not used in item B');
});

test('without a <video>, readings of the old position while the jump lands are ignored', async t => {
  const h = setup(t);
  h.JE.watchOsdPosition();
  h.show(50); await flush();
  h.show(200); await flush();
  // The player has not moved yet when the slider changes: the next OSD update still shows the old time.
  h.player.moveOnSeek = false;
  h.JE.jumpToLastPosition();
  assert.ok(Math.abs(h.seeks.at(-1) - (50 / 1200) * 100) < 0.01);
  h.show(201); await flush();
  h.show(51); await flush(); // the jump lands
  h.show(52); await flush();
  h.JE.jumpToLastPosition();
  assert.match(h.toasts.at(-1), /No previous position saved/, 'landing is not a seek back to 200');
});

test('without a <video>, a timeline click of any length is a seek, paused or playing', async t => {
  const h = setup(t, { clock: true });
  h.JE.watchOsdPosition();
  h.show(40); await flush();
  h.setPaused(true); await flush();
  h.advance(30000);
  h.dragTo(41); await flush(); // an accidental click one second on, while paused
  h.JE.jumpToLastPosition();
  assert.ok(Math.abs(h.seeks.at(-1) - (40 / 1200) * 100) < 0.01, 'back to 0:40');
  assert.equal(h.toasts.at(-1), 'toast_jumped_back:{"time":"0:40"}');
  h.setPaused(false); await flush();
  h.advance(700); h.show(41); await flush();
  h.advance(700); h.dragTo(39); await flush(); // two seconds back while playing
  h.JE.jumpToLastPosition();
  assert.ok(Math.abs(h.seeks.at(-1) - (41 / 1200) * 100) < 0.01);
});

test('without a <video>, a key seek during a pause counts; a long gap of playback does not', async t => {
  const h = setup(t, { clock: true });
  h.JE.watchOsdPosition();
  h.show(40); await flush();
  h.setPaused(true); await flush(); // the pause is a reading: nothing plays after it
  h.advance(60000);
  h.show(50); await flush(); // jellyfin-web's +10 s while paused
  h.setPaused(false); await flush();
  h.advance(700); h.show(51); await flush();
  h.advance(10000); h.show(61); await flush(); // ten seconds of playback between two OSD updates
  h.JE.jumpToLastPosition();
  assert.ok(Math.abs(h.seeks.at(-1) - (40 / 1200) * 100) < 0.01, 'the seek from 0:40 is kept, not replaced by 0:51');
});

test('without a <video>, a saved position is dropped once another item shows, even in a new OSD view', async t => {
  const h = setup(t);
  h.JE.watchOsdPosition();
  h.show(100); await flush();
  h.dragTo(500); await flush();
  h.JE.stopWatchingOsdPosition(); // the player was left
  h.document.querySelector('.btnUserRating').setAttribute('data-id', 'ffffffffffffffffffffffffffffffff');
  h.show(3, 1500);
  h.JE.watchOsdPosition();
  h.JE.jumpToLastPosition();
  assert.match(h.toasts.at(-1), /No previous position saved/);
});

test('without a <video>, a short skip with jellyfin-web\'s keys or buttons counts as a seek', async t => {
  const h = setup(t, { clock: true });
  h.JE.watchOsdPosition();
  h.show(100); await flush();
  h.advance(1000); h.show(101); await flush();
  h.document.body.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }));
  h.advance(700); h.show(104); await flush(); // jellyfin-web skipped 3 s
  h.JE.jumpToLastPosition();
  assert.ok(Math.abs(h.seeks.at(-1) - (101 / 1200) * 100) < 0.01, 'back to 1:41');
  await flush();
  h.advance(1000); h.show(102); await flush();
  h.document.querySelector('.btnPause').insertAdjacentHTML('afterend', '<button class="btnRewind"></button>');
  h.document.querySelector('.btnRewind').click();
  h.advance(700); h.show(100); await flush(); // a 2 s rewind
  h.JE.jumpToLastPosition();
  assert.ok(Math.abs(h.seeks.at(-1) - (102 / 1200) * 100) < 0.01, 'back to 1:42');
});

test('without a <video>, a seek key that moved nothing saves nothing', async t => {
  const h = setup(t, { clock: true });
  h.JE.watchOsdPosition();
  h.show(100); await flush();
  h.document.body.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'l', code: 'KeyL', bubbles: true }));
  h.advance(700); h.show(101); await flush();
  h.advance(4000); h.show(105); await flush();
  h.JE.jumpToLastPosition();
  assert.match(h.toasts.at(-1), /No previous position saved/);
});

test('without a <video>, the time leaving an item\'s last 30 s is not taken as a seek', async t => {
  // Autoplay: jellyfin-web shows the next item's time before its id; a similar duration matches.
  const h = setup(t, { clock: true });
  h.JE.watchOsdPosition();
  h.show(1185); await flush();
  h.advance(700); h.show(2, 1199); await flush();
  h.JE.jumpToLastPosition();
  assert.match(h.toasts.at(-1), /No previous position saved/);
  assert.deepEqual(h.seeks, []);
});

test('the <video> path keeps its own history and ignores the OSD', async t => {
  const h = setup(t, { video: true });
  const video = h.document.querySelector('video');
  h.JE.attachSeekTracker(video);
  h.JE.watchOsdPosition();
  h.show(10); await flush();
  h.show(900); await flush(); // the OSD alone moving is not the element's seek
  h.JE.jumpToLastPosition();
  assert.match(h.toasts.at(-1), /No previous position saved/);
  assert.deepEqual(h.seeks, []);
});

test('with no time on the OSD, the jump says it is not available', t => {
  const h = setup(t);
  h.JE.jumpToLastPosition();
  assert.match(h.toasts.at(-1), /Not available with this player/);
});

// ── The other shortcuts ──────────────────────────────────────────────────────────────────────────

test('without a <video>, jump to a percentage uses the OSD slider; frame step is not available', t => {
  const h = setup(t);
  h.show(10);
  h.JE.jumpToPercentage(30);
  assert.equal(h.seeks.at(-1), 30);
  assert.equal(h.toasts.at(-1), 'toast_jumped_to:{"percent":30}');
  h.JE.frameStep('forward');
  assert.match(h.toasts.at(-1), /Not available with this player/);
});

test('without a <video>, speed steps through jellyfin-web\'s own list in its settings menu', async t => {
  const h = setup(t);
  h.show(10);
  h.JE.adjustPlaybackSpeed('increase');
  h.JE.adjustPlaybackSpeed('increase'); // queued: reads the first press's result
  await flush(40);
  assert.deepEqual(h.chosen, [['playbackrate', '1.25'], ['playbackrate', '1.5']]);
  h.JE.adjustPlaybackSpeed('decrease');
  await flush(20);
  h.JE.resetPlaybackSpeed();
  await flush(20);
  assert.deepEqual(h.chosen.slice(2), [['playbackrate', '1.25'], ['playbackrate', '1']]);
  assert.deepEqual(h.toasts, ['toast_speed:{"speed":1.25}', 'toast_speed:{"speed":1.5}', 'toast_speed:{"speed":1.25}', 'toast_speed_normal']);
  assert.equal(h.document.querySelectorAll('.dialogContainer').length, 0, 'no sheet is left behind');
});

test('without a <video>, aspect ratio cycles through jellyfin-web\'s list; speed stops at the ends', async t => {
  const h = setup(t);
  h.show(10);
  h.JE.cycleAspect();
  await flush(20);
  h.JE.cycleAspect();
  await flush(20);
  assert.deepEqual(h.chosen, [['aspectratio', 'zoom'], ['aspectratio', 'stretch']]);
  assert.deepEqual(h.toasts, ['toast_aspect_ratio:{"ratio":"Cover"}', 'toast_aspect_ratio:{"ratio":"Fill"}']);
  for (let i = 0; i < 5; i++) { h.JE.adjustPlaybackSpeed('decrease'); }
  await flush(80);
  assert.deepEqual(h.chosen.slice(2).map(c => c[1]), ['0.75', '0.5', '0.5', '0.5', '0.5']);
});

test('without a <video>, speed leaves a track menu that opens meanwhile alone', async t => {
  const h = setup(t);
  h.show(10);
  let foreignClicks = 0;
  // A track menu (titled, numeric stream indexes) appears while JE waits for the speed list.
  h.document.querySelector('.btnVideoOsdSettings').addEventListener('click', () => {
    setTimeout(() => {
      const audio = h.document.createElement('div');
      audio.className = 'dialogContainer';
      audio.innerHTML = '<div class="actionSheet"><h1 class="actionSheetTitle">Audio</h1><div class="actionSheetContent"><button data-id="2"><span class="material-icons check"></span>English</button><button data-id="5"><span class="material-icons check" style="visibility:hidden;"></span>German</button></div></div>';
      audio.querySelectorAll('button').forEach(b => b.addEventListener('click', () => foreignClicks++));
      h.document.body.append(audio);
    }, 2);
  });
  h.JE.adjustPlaybackSpeed('increase');
  await flush(40);
  assert.equal(foreignClicks, 0, 'no audio track was chosen');
  assert.deepEqual(h.chosen, [['playbackrate', '1.25']]);
});

test('without a <video> or a settings menu, speed and aspect say they are not available', async t => {
  const h = setup(t, { sheets: false });
  h.document.querySelector('.btnVideoOsdSettings').remove();
  h.JE.adjustPlaybackSpeed('increase');
  h.JE.cycleAspect();
  await flush(20);
  assert.equal(h.toasts.length, 2);
  for (const text of h.toasts) assert.match(text, /Not available with this player/);
});

test('without a <video>, skip intro seeks past the segment the OSD position is in', async t => {
  const requests = [];
  const h = setup(t, {
    ajax: async (req) => {
      requests.push(String(req.url));
      if (String(req.url).includes('/Sessions')) return [{ DeviceId: 'device-1', NowPlayingItem: { Id: ITEM_A, RunTimeTicks: 1200 * 1e7 } }];
      if (String(req.url).includes(`/MediaSegments/${ITEM_A}`)) return { Items: [{ Type: 'Intro', StartTicks: 30 * 1e7, EndTicks: 95 * 1e7 }] };
      throw new Error('unexpected ajax ' + req.url);
    },
  });
  h.show(40);
  h.JE.skipIntroOutro();
  await flush(10);
  assert.ok(Math.abs(h.seeks.at(-1) - (95 / 1200) * 100) < 0.01);
  assert.equal(h.toasts.at(-1), 'toast_skipped_intro');
  h.show(400);
  h.JE.skipIntroOutro();
  await flush(10);
  assert.equal(h.toasts.at(-1), 'toast_no_skip_button', 'outside a segment, and no skip button');
});

test('without a <video>, skip intro needs the session item to be the one the OSD names', async t => {
  const requests = [];
  const h = setup(t, {
    ajax: async (req) => {
      requests.push(String(req.url));
      // Another item with the same runtime is still the session's.
      if (String(req.url).includes('/Sessions')) return [{ DeviceId: 'device-1', NowPlayingItem: { Id: 'ffffffffffffffffffffffffffffffff', RunTimeTicks: 1200 * 1e7 } }];
      throw new Error('unexpected ajax ' + req.url);
    },
  });
  h.show(40);
  h.JE.skipIntroOutro();
  await flush(10);
  assert.deepEqual(h.seeks, []);
  assert.equal(requests.some(url => url.includes('/MediaSegments/')), false);
  assert.equal(h.toasts.at(-1), 'toast_no_skip_button');
});

test('without a <video>, a skip press whose item changed while it waited does nothing', async t => {
  let answer;
  const h = setup(t, {
    ajax: (req) => {
      if (String(req.url).includes('/Sessions')) return new Promise(resolve => { answer = resolve; });
      throw new Error('unexpected ajax ' + req.url);
    },
  });
  h.show(40);
  h.JE.skipIntroOutro();
  await flush();
  // The next item starts, with its own skip button showing.
  h.document.querySelector('.btnUserRating').setAttribute('data-id', 'ffffffffffffffffffffffffffffffff');
  h.show(5, 1500);
  const skip = h.document.createElement('button');
  skip.className = 'skip-button emby-button';
  skip.textContent = 'Skip Intro';
  let clicked = 0;
  skip.addEventListener('click', () => clicked++);
  h.document.body.append(skip);
  answer([{ DeviceId: 'device-1', NowPlayingItem: { Id: ITEM_A, RunTimeTicks: 1200 * 1e7 } }]);
  await flush(10);
  assert.equal(clicked, 0, 'the earlier press did not click the new item\'s button');
  assert.deepEqual(h.seeks, []);
  assert.deepEqual(h.toasts, []);
});

test('without a <video>, skip intro checks the session item against the OSD duration', async t => {
  const h = setup(t, {
    ajax: async (req) => {
      if (String(req.url).includes('/Sessions')) return [{ DeviceId: 'device-1', NowPlayingItem: { Id: 'other', RunTimeTicks: 3000 * 1e7 } }];
      throw new Error('unexpected ajax ' + req.url);
    },
  });
  h.show(40);
  h.JE.skipIntroOutro();
  await flush(10);
  assert.deepEqual(h.seeks, []);
  assert.equal(h.toasts.at(-1), 'toast_no_skip_button');
});

// ── The shortcuts reach the actions (events.js) ──────────────────────────────────────────────────

test('player shortcuts run on the player page without a <video>, and only there', async t => {
  const h = setup(t);
  h.load('enhanced/events.js');
  h.document.addEventListener('keydown', h.JE.keyListener, true);
  const reached = [];
  h.document.addEventListener('keydown', e => reached.push(e.key)); // jellyfin-web's own player keys
  h.JE.watchOsdPosition();
  h.show(40); await flush();
  h.show(100); await flush();
  h.document.body.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'z', bubbles: true }));
  assert.ok(Math.abs(h.seeks.at(-1) - (40 / 1200) * 100) < 0.01, 'Z jumped back');
  assert.deepEqual(reached, [], 'JE handled Z; jellyfin-web did not also get it');
  h.document.body.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: '.', bubbles: true }));
  assert.match(h.toasts.at(-1), /Not available with this player/);
  const seeks = h.seeks.length;
  h.JE.isVideoPage = () => false;
  h.document.body.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'z', bubbles: true }));
  assert.equal(h.seeks.length, seeks, 'off the player page the key is left alone');
  assert.deepEqual(reached, ['z']);
});
