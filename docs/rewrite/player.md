# Player TypeScript replacement

The seven existing ordered `enhanced/player/*.js` entry points now compile from
`client/entries/player.json`. The loader order and public `JE` methods are retained.
`playback.js` publishes `JE.internals.player`; `now-playing.js` publishes
`JE.internals.nowPlaying` before auto-skip and the rating/pause consumers load.
Each entry owns its state once. Imported controller factories do not instantiate
another player or copy another entry's mutable state.

## Boundaries and behavior

`client/src/features/player/host.ts` enumerates the player settings, host operations,
legacy facades and sibling interfaces. API operations read the currently active
Jellyfin client on each call. `wire.ts` projects unknown Jellyfin responses into
narrow item, stream, session and media-segment records, rejecting malformed scalar
values. No settings keys or persisted documents are renamed or migrated.

Playback controls are separated into frame/seek, segment skip, native menu,
serialized track commands, aspect, playback statistics and long-press controllers.
Auto-skip keeps its boundary/backward-entry/replay engine separate from the host.
Pause rendering and CSS, advisory ranking and lifetime ownership have separate
modules. Public method names and `internals.autoSkip` inspection hooks remain.

Preserved behavior includes speed steps/reset, percentage seeking, FPS lookup and
fallback, last-position jump-back, native Media Segments and visible-button skip
fallback, per-kind serialized track commands and localized native-menu fallback,
native aspect storage/canvas fit, local/session playback statistics, and long-press
speed restoration. Subtitle presets, custom colors/fonts/effects/positions, both
subtitle tracks, native cue CSS and exact original inline-style restoration remain.
Now-playing, series rating fallbacks, badge advisory ranking, pause metadata/images,
progress, delay/idle tracking, focus restoration and remote keyboard controls remain.

Navigation and account leases invalidate pending work. Cleanup removes owned
playback overlays, cue styles, seek listeners and timers. Account changes clear
metadata caches and reset track queues. Long-press cleanup restores the original
boosted element even if Jellyfin has replaced it. Pause destruction releases its
keyboard/interaction/body subscriptions and user-reset handler; source changes
abort pending image probes. Persistent playing/body/navigation subscriptions are
entry-level observers: they must remain available because the host initializes
these features once, before subsequent player mounts.

Auto pause/resume and automatic PiP are still owned by `enhanced/events.js`, outside
this slice. That owner and its calls into these facades were not changed.

## Validation and remaining host checks

Focused existing/new compiled-output tests:

```
node --test --test-concurrency=1 tests/frontend/features/player/features-playback.test.mjs tests/frontend/features/player/features-autoskip.test.mjs tests/frontend/features/player/features-subtitles.test.mjs tests/frontend/features/player/features-pause.test.mjs tests/frontend/features/player/features-player-rewrite.test.mjs
```

50 tests pass. The dedicated `tests/browser/player-rewrite.spec.cjs` runs native DOM,
MutationObserver, media-rate and storage checks with an intercepted local fixture;
it opens no live Jellyfin connection. Six cases pass across Chromium and Firefox.
Strict shared typechecking, the serialized builder and generated-output freshness
check pass. Exact logs and file hashes are under ignored `artifacts/player-rewrite`.

This is not a real-host playback certification. Parent integration must run the
full suites and Jellyfin 12 Modern/Legacy layouts, real audio/subtitle remote
commands and menus, SyncPlay, HLS/native Safari cues, progressive transcodes,
next-episode transitions, mobile gesture/autoplay restrictions, fullscreen/PiP,
TV remote devices and real server/user changes. Segment seeks still use the local
media element: progressive transcodes can stall outside produced data and SyncPlay
peers do not follow the local seek. Those baseline limits are preserved.
