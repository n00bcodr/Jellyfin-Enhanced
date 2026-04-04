## How can I contribute translations?

### Translate on Weblate (Recommended)

Use Weblate for all translation work:

<a href="https://hosted.weblate.org/engage/jellyfinenhanced/">
<img src="https://hosted.weblate.org/widget/jellyfinenhanced/287x66-grey.png" alt="Translation status" />
</a>

- https://hosted.weblate.org/projects/jellyfinenhanced/

1. Open the Jellyfin Enhanced project in Weblate
2. Select your language (or request a new one)
3. Translate strings in the web editor
4. Save your changes

### Why Weblate?

- No local setup required
- Translation quality checks are built in
- Faster review and sync workflow
- Keeps all language work in one place

### Maintainer Fallback: Manual JSON Changes

If Weblate is temporarily unavailable, maintainers can still update locale files directly:

1. Go to `Jellyfin.Plugin.JellyfinEnhanced/js/locales/`
2. Copy `en.json`
3. Rename to your language code (e.g., `es.json`)
4. Translate all English text
5. Run translation validation script
6. Submit a Pull Request

### Translation Updates

- Synced from repository updates (including Weblate commits)
- Cached for 24 hours
- Available immediately after merge
- No plugin update needed
