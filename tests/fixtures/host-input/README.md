# Host input fixtures (third-party code)

The files under `12.2/` and `10.11.11/` are unmodified excerpts of **jellyfin-web**, the Jellyfin project's web client,
as shipped in the official `jellyfin/jellyfin:12.2` and `jellyfin/jellyfin:10.11.11` container images (jellyfin-web
12.2.0 and 10.11.11): its keyboard navigation, input manager, focus manager, server notifications and events helper
modules (from `main.jellyfin.bundle.js`) and its gamepad-to-key chunk. They are copied by `tests/host/web-bundle/extract-input.mjs`; each directory's
`manifest.json` records the source file name, module id and SHA-256 of every excerpt and of every licence file it
carries. The frontend tests run them verbatim (`tests/frontend/helpers/host-input.mjs`) to check how Jellyfin
Enhanced's surfaces meet the host's own Back keys, remote buttons, D-pad focus moves and gamepad OK.

- **Upstream project:** jellyfin-web, https://github.com/jellyfin/jellyfin-web
- **Licence:** GPL-2.0-or-later, as stated in the upstream repository's `package.json` and `LICENSE` (GNU General Public
  License, version 2) at the shipped versions (tags `v12.2` and `v10.11.11`). `gamepadtokey` additionally carries its
  own MIT notice (Microsoft, 2016) in the upstream source.
- **Corresponding source:** https://github.com/jellyfin/jellyfin-web/tree/v12.2 and
  https://github.com/jellyfin/jellyfin-web/tree/v10.11.11 (`src/scripts/keyboardNavigation.js`,
  `src/scripts/inputManager.js`, `src/components/focusManager.js`, `src/scripts/serverNotifications.js`,
  `src/utils/events.ts`, `src/scripts/gamepadtokey.js`; the bundles are
  webpack builds of those trees).
- **Bundled third-party notices:** `main.jellyfin.bundle.js.LICENSE.txt` is the licence sidecar the main bundle refers
  to, copied verbatim.
