# Spoiler Guard Lite for Jellyfin

A focused, lightweight server-side spoiler protection plugin for **Jellyfin Server 12.2+**, optimized for native clients like **Moonfin**.

---

## Features

- **Server-Side Episode Thumbnail Blurring:** Automatically blurs episode thumbnails for unwatched media directly in Jellyfin's response stream.
- **Spoiler Metadata Stripping:** Hides episode titles, summaries, and overviews for unwatched content until played.
- **Moonfin / Trickplay Scrubbing Bypass:** Timeline scrubbing tiles (`/Videos/{itemId}/Trickplay/...`) bypass blur filters so scrubber previews work smoothly without spoiling episode stills.
- **Pure Backend Architecture:** Zero client-side JavaScript injection, zero CSS hacks, and no web bundle bloat.
- **Scheduled Library Scans:** Native scheduled task to apply spoiler rules across existing library titles.

---

## Compatibility

- **Jellyfin Server:** v12.2+ (Target ABI `12.0.0.0`)
- **Clients:** Fully compatible with all native Jellyfin clients (Moonfin, Swiftfin, official web/desktop/mobile clients).

---

## Configuration

Navigate to **Jellyfin Dashboard → Plugins → Spoiler Guard Lite**:

- **Exempt Trickplay / Timeline Scrubbing Images:** Toggle whether video scrubber timeline tiles bypass the blur filter.
- **Spoiler Rules:** Customize blur behavior, unwatched thresholds, and metadata stripping.

### Existing Library Items
To scan and protect existing media already in your library, run the scheduled task:
**Jellyfin Dashboard → Scheduled Tasks → "Spoiler Guard: Apply to Existing Titles"**.

---

## Attribution & License

- Forked and distilled from the Spoiler Guard component of [Jellyfin-Enhanced](https://github.com/n00bcodr/Jellyfin-Enhanced) by n00bcodr.
- Licensed under the original license terms (see [LICENSE](LICENSE)).
