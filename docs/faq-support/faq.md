# Frequently Asked Questions

## General Questions

<!-- todo: make these collapsible  -->

### What is Jellyfin Enhanced?

Jellyfin Enhanced is a comprehensive plugin that bundles advanced features and customizations for Jellyfin. It adds keyboard shortcuts, visual enhancements, Seerr integration, custom pause screens, quality tags, and much more — all in one convenient package.

### Can I customize the keyboard shortcuts?

Yes! Open the Jellyfin Enhanced panel by clicking the menu item in the sidebar or pressing `?`, then go to the **Shortcuts** tab. Click on any key to set a custom shortcut. Changes save automatically.

### Does this work on mobile apps?

Yes, the plugin works on the official Jellyfin Android and iOS apps, as well as desktop and web UIs. All features are available as long as the app uses Jellyfin's embedded web UI.

### Does this work on Android TV or other TV platforms?

No, the plugin does not work on Android TV or other native TV apps. It only functions on clients that use Jellyfin's embedded web UI, such as the official web, desktop, and mobile apps.

### Is this plugin affiliated with Seerr?

No, this plugin is not affiliated with Seerr. Seerr is an independent project, and this plugin simply integrates with it to enhance the Jellyfin experience. **Please report plugin issues to this repository, not to the Seerr team**.

### How do I change the plugin's language?

The plugin automatically uses the language set in your Jellyfin user profile. If your language isn't available, it defaults to English. See the [Contributing Translations](contributing-translations.md) section to help add your language!

### Where is the userscript version?

The userscript has been discontinued as the plugin functionality has grown significantly. The last version is available [here](https://github.com/n00bcodr/Jellyfin-Enhanced/raw/05dd5b54802f149e45c76102dabf6235aaf7a5fb/jf_enhanced.user.js) if you only need basic keyboard shortcuts.

---

## Installation & Setup

### Plugin Compatibility

| Plugin | Jellyfin 10.11 | Jellyfin 10.10 | Notes |
|--------|----------------|----------------|-------|
| Jellyfin Enhanced | ✅ | ❌ | Use 10.11 manifest |

### Plugin not appearing after installation?

**See [this page in Installation Troubleshooting](../installation/troubleshooting.md/#plugin-not-appearing-after-installation)**

### Scripts not loading after installation

**See [this page in Installation Troubleshooting](../installation/troubleshooting.md/#scripts-not-loading)**

### Update not working properly?

**See this page in [Installation Troubleshooting](../installation/troubleshooting.md/#update-not-working)**


### I see "permission denied" errors in logs!!

**See this page in [Installation Troubleshooting, regarding permission issuses](../installation/troubleshooting.md#permission-issues)**


---

## Features & Functionality

### Auto-skip intros not working?

Auto-skip requires the [Intro Skipper plugin](https://github.com/intro-skipper/intro-skipper) to be installed and configured.

**Requirements:**

1. Install Intro Skipper plugin

2. Enable intro detection in Intro Skipper settings

3. Run intro detection on your library

4. Enable auto-skip in Jellyfin Enhanced settings

5. Intro segments must be detected for your media

**Check Detection:**

- [x] Play a video with known intro

- [x] Look for "Skip Intro" button

- [x] If button appears, detection works

- [x] If no button, run intro detection again


### Seerr integration not connecting?

<!-- todo -->
<!-- ![Seerr Settings](../images/jellyseerr.png) -->

**Check Configuration:**

1. Verify Seerr URL is correct and accessible

2. Verify API key is correct (from Seerr Settings → General)

3. Click "Test Connection" in plugin settings

4. Check icon status on search page:

   - 🟢 Active = Working
   - 🔴 No Access = User not imported
   - ⚫ Offline = Cannot connect

**Enable Jellyfin Sign-In:**

1. In Seerr, go to Settings → Users

2. Enable "Enable Jellyfin Sign-In"

3. Import your Jellyfin users

<!-- todo -->
<!-- ![Jellyfin Sign-In](../images/jellyfin-signin.png) -->

**Import Users:**

Option A (automatic, recommended):

1. In Jellyfin, go to Dashboard -> Plugins -> Jellyfin Enhanced -> Seerr Settings

2. Enable "Auto import Jellyfin users to Seerr"

3. Optional: click "Import Users Now" to run bulk import immediately

Option B (manual in Seerr):

1. In Seerr, go to Users page

2. Click "Import Jellyfin Users"

3. Select users to import

4. Save changes

**User Access:**

- Users WITH access: ![Users with access](../images/users-with-access.png)

- Users WITHOUT access: ![Users without access](../images/users-no-access.png)
<!-- todo -->

**Check Logs:**

1. Browser console (F12) for client errors

2. Jellyfin server logs for proxy errors

3. Seerr logs for API errors

### Tags not showing on posters?

**Enable Feature:**

1. Open Enhanced panel (press `?`)

2. Go to Settings tab

3. Enable desired tags:

   - Quality Tags
   - Genre Tags
   - Language Tags
   - Rating Tags

4. Adjust position if needed

**Clear Cache:**

1. Hard refresh browser (Ctrl+F5)

2. Clear all browser cache

3. Restart browser

**Check Metadata:**

- Quality tags require media file metadata

- Genre tags require genre information

- Language tags require audio track data

- Rating tags require TMDB/RT ratings

**Check Console:**

1. Press F12 → Console

2. Look for tag-related errors

3. Report issues on GitHub

### Bookmarks not syncing across devices?


!!!  "How it works"

    Bookmarks are stored server-side but settings are per-browser.

    - Bookmark data stored on Jellyfin server

    - Settings stored in browser `localStorage`

    - Each browser has independent settings

    - Same user can access bookmarks from any device

**Syncing Bookmarks:**

- Bookmarks automatically sync via server

- Settings must be configured per browser

- Use same Jellyfin user account

- Bookmarks appear on all devices

**Troubleshooting:**

- Verify same user account

- Check bookmark file exists on server

- Look in `/config/data/users/{userId}/jellyfin-enhanced/bookmarks.json`

- Check browser console for errors

### Pause screen not appearing?


**Enable Feature:**

1. Open Enhanced panel

2. Go to Settings tab

3. Enable "Custom Pause Screen"

4. Adjust settings as desired

**Check Playback:**

- [x] Must be in fullscreen or theater mode

- [ ] Pause video (press Space)

- [ ] Screen should appear after brief delay

**Customize Elements:**

<!-- * EXAMPLE OF A LINK! -->
See [Pause Screen CSS](../advanced/css-customization.md#pause-screen) for hiding/styling elements.

### Reviews, Elsewhere, or Seerr icons not working?

This is usually due to TMDB API access issues.

**TMDB API Blocked:**

- TMDB API may be blocked in your region

- Check Seerr troubleshooting: [TMDB Access](https://docs.seerr.dev/troubleshooting#tmdb-failed-to-retrievefetch-xxx)

- Use VPN or proxy if needed

- Contact your ISP about API access

**Check Connection:**

1. Open browser console ++f12++

2. Look for TMDB-related errors

3. Check network tab for failed requests

4. Verify Seerr can access TMDB

### "Remove from Continue Watching" is destructive?

Yes, this feature resets playback progress to zero.

**How It Works:**

- Removes item from Continue Watching list
- Resets watch progress to 0%
- Marks item as unwatched
- Cannot be undone

**Use Cases:**

- Remove items you don't want to continue
- Clean up Continue Watching section
- Reset progress for rewatching

**Alternative:**

- Mark as played to remove from list
- Keep progress intact
- Use Jellyfin's built-in "Mark Played" feature

---

## Customization

### How do I customize tag appearance?

Use Custom CSS in Jellyfin settings:

1. Go to **Dashboard** → **General** → **Custom CSS**
2. Add your custom styles
3. Click **Save**
4. Refresh browser (Ctrl+F5)

**Examples:**

```css title="Hide Quality Tag"
.quality-overlay-label[data-quality="H264"] {
    display: none !important;
}
```

```css title="Change Tag Color"
.quality-overlay-label[data-quality="4K"] {
    background-color: purple !important;
}
```

```css title="Adjust Tag Size"
.quality-overlay-label {
    font-size: 0.9rem !important;
    padding: 4px 8px !important;
}
```

See [CSS Customization Guide](../advanced/css-customization.md) for complete CSS documentation.

### How do I upload custom branding?

**Requirements:**

- [file-transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) installed
- Admin access to Jellyfin

**Steps:**

1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**

2. Navigate to **Other Settings** tab

3. Find **Custom Branding** section

4. Upload your images:

   - Icon Transparent (header logo)
   - Banner Light (dark theme splash)
   - Banner Dark (light theme splash)
   - Favicon (browser icon)

5. Click `Save`

6. Force refresh ++ctrl+f5++

**Image Requirements:**

- [x] PNG or SVG format recommended

- [x] Transparent backgrounds for logos

- [x] Appropriate dimensions for each type

- [x] Files stored in plugin config folder

### Can I change tag positions?

Yes, via Enhanced panel settings:

1. Open Enhanced panel (press ++question-mark++)

2. Go to Settings tab

3. Find tag position options

4. Select position (top-left, top-right, bottom-left, bottom-right)

5. Changes apply immediately

**Advanced Positioning:**

```css title="Change tag positions"
.quality-overlay-container {
    top: 10px !important;
    right: 10px !important;
}
```

---

## Troubleshooting

### How do I gather logs for bug reports?

**Browser Console Logs:**

1. Press ++f12++ to open developer tools

2. Go to Console tab

3. Filter by `🪼Jellyfin Enhanced`

4. Look for errors (red text)

5. Copy error messages

6. Include in bug report

**Network Logs:**

1. Press ++f12++ → `Network` tab

2. Filter by `JellyfinEnhanced`

3. Look for failed requests (red)

4. Check status codes

5. Include in bug report

**Server Logs:**

1. Go to **Dashboard** → **Logs**

2. Look for `JellyfinEnhanced` entries

3. Check log files: `JellyfinEnhanced_yyyy-mm-dd.log`

4. Copy relevant errors

5. Include in bug report

**What to Include:**

- Plugin version

- Jellyfin version

- Browser and version

- Operating system

- Steps to reproduce

- Console errors

- Server log errors

- Screenshots if applicable

### Common error messages and solutions

| Error | Solution |
|-------|----------|
| `Access to the path '/jellyfin/jellyfin-web/index.html' is denied.` | Install [file-transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) or follow [Docker workaround](../installation/troubleshooting.md#docker) |
| `Access to the path 'C:\Program Files\Jellyfin\Server\jellyfin-web\index.html' is denied.` | Grant "NETWORK SERVICE" Read/Write permissions to Jellyfin folder |
| Plugin installed but scripts don't load | Run "Jellyfin Enhanced Startup" scheduled task, verify trigger exists |
| Reviews/Elsewhere/Seerr icons not working | TMDB API may be blocked in your region, see [Seerr troubleshooting](https://docs.seerr.dev/troubleshooting#tmdb-failed-to-retrievefetch-xxx) |
| Seerr search not working | Enable "Jellyfin Sign-In" in Seerr. Then either enable plugin auto import and run "Import Users Now", or import users manually in Seerr. Also verify user is not in blocked users list. |
| Tags not appearing | Enable in settings, clear cache, verify metadata exists |
| Bookmarks not saving | Check server logs, verify user data folder permissions |
| Admin config page tabs not switching | May be caused by Cloudflare Rocket Loader — try disabling it for your Jellyfin domain. See [troubleshooting](../installation/troubleshooting.md#admin-config-page-tabs-not-switching) |
| Calendar/Requests custom tab shows blank screen | Disable Cloudflare Rocket Loader for your Jellyfin domain. See [arr troubleshooting](../arr/troubleshooting-support.md#calendar-not-loading) |

### Plugin conflicts?

**Known Conflicts:**

- None currently documented

**Potential Issues:**

- Multiple JavaScript injection plugins

- Custom CSS overriding plugin styles

- Browser extensions blocking scripts


**Troubleshooting:**

1. Disable other plugins temporarily

2. Test with clean browser profile

3. Check for CSS conflicts

4. Disable browser extensions

5. Report conflicts on GitHub

### Performance issues?

**Optimization Tips:**

1. Disable unused features in settings

2. Reduce number of visible tags

3. Clear browser cache regularly

4. Use modern browser version

5. Check server resources

**Heavy Features:**

- Seerr discovery pages (many API calls)

- People tags (age calculations)

- Multiple tag types enabled

- Large bookmark collections

**Improve Performance:**

- Enable only needed features

- Use tag filters to reduce display

- Clear old bookmarks

- Limit Seerr results

---


## [How can I contribute translations?](../faq-support/contributing-translations.md)

## [How can I request features?](../faq-support/feature-requests.md)

## [How can I report bugs?](../faq-support/report-issues.md)


---

## Support & Community

### Where can I get help?

**Official Channels:**

- [GitHub Issues](https://github.com/n00bcodr/Jellyfin-Enhanced/issues) - Bug reports and feature requests
- [GitHub Discussions](https://github.com/n00bcodr/Jellyfin-Enhanced/discussions) - General questions and discussion
- [Discord Community](https://discord.gg/EYNFf7y4CG) - Real-time chat and support

**Before Asking:**

1. Read this FAQ
2. Check [Installation Guide](../installation/installation.md)
3. Review [Enhanced Features Guide](../enhanced/enhanced-features.md)
4. Search existing issues
5. Check browser console for errors

**When Asking for Help:**

- Describe the problem clearly
- Include plugin and Jellyfin versions
- Provide browser and OS info
- Share relevant logs
- Include screenshots if helpful
- Be patient and respectful


## Related Projects

### Other projects by n00bcodr

- [Jellyfin-Elsewhere](https://github.com/n00bcodr/Jellyfin-Elsewhere) - Streaming provider lookup (standalone)
- [Jellyfin-Tweaks](https://github.com/n00bcodr/JellyfinTweaks) - Additional tweaks plugin
- [Jellyfin-JavaScript-Injector](https://github.com/n00bcodr/Jellyfin-JavaScript-Injector) - Custom script injection
- [Jellyfish](https://github.com/n00bcodr/Jellyfish/) - Custom Jellyfin theme

### Recommended plugins

- [File Transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) - Safe file modifications
- [Custom Tabs](https://github.com/IAmParadox27/jellyfin-plugin-custom-tabs) - Custom navigation tabs
- [Plugin Pages](https://github.com/IAmParadox27/jellyfin-plugin-pages) - Helps Plugins create custom pages for settings and info
- [Kefin Tweaks](https://github.com/ranaldsgift/KefinTweaks) - Watchlist and more

---

## Still Have Questions?

If your question isn't answered here:

1. Search [GitHub Discussions](https://github.com/n00bcodr/Jellyfin-Enhanced/discussions)
2. Ask in [Discord Community](https://discord.gg/EYNFf7y4CG)
3. Create a [GitHub Issue](https://github.com/n00bcodr/Jellyfin-Enhanced/issues/new)