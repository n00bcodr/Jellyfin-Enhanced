# Frequently Asked Questions

## General Questions

### What is Jellyfin Enhanced?

Jellyfin Enhanced is a comprehensive plugin that bundles advanced features and customizations for Jellyfin. It adds keyboard shortcuts, visual enhancements, Jellyseerr integration, custom pause screens, quality tags, and much more - all in one convenient package.

### Can I customize the keyboard shortcuts?

Yes! Open the Jellyfin Enhanced panel by clicking the menu item in the sidebar or pressing `?`, then go to the **Shortcuts** tab. Click on any key to set a custom shortcut. Changes save automatically.

### Does this work on mobile apps?

Yes, the plugin works on the official Jellyfin Android and iOS apps, as well as desktop and web UIs. All features are available as long as the app uses Jellyfin's embedded web UI.

### Does this work on Android TV or other TV platforms?

No, the plugin does not work on Android TV or other native TV apps. It only functions on clients that use Jellyfin's embedded web UI, such as the official web, desktop, and mobile apps.

### Is this plugin affiliated with Jellyseerr?

No, this plugin is not affiliated with Jellyseerr/Seerr. Jellyseerr is an independent project, and this plugin simply integrates with it to enhance the Jellyfin experience. Please report plugin issues to this repository, not to the Jellyseerr team.

### How do I change the plugin's language?

The plugin automatically uses the language set in your Jellyfin user profile. If your language isn't available, it defaults to English. See the [Contributing Translations](#contributing-translations) section to help add your language!

### Where is the userscript version?

The userscript has been discontinued as the plugin functionality has grown significantly. The last version is available [here](https://github.com/n00bcodr/Jellyfin-Enhanced/raw/05dd5b54802f149e45c76102dabf6235aaf7a5fb/jf_enhanced.user.js) if you only need basic keyboard shortcuts.

---

## Installation & Setup

### Plugin not appearing after installation?

**Check Installation:**
1. Go to **Dashboard** → **Plugins** → **My Plugins**
2. Verify "Jellyfin Enhanced" is listed and enabled
3. Check version number matches latest release

**Run Startup Task:**
1. Go to **Dashboard** → **Scheduled Tasks**
2. Find "Jellyfin Enhanced Startup" task
3. Click **Run** to execute manually
4. Refresh browser (Ctrl+F5)

**Clear Browser Cache:**
1. Press Ctrl+Shift+Delete (Windows/Linux) or Cmd+Shift+Delete (Mac)
2. Select "Cached images and files"
3. Clear cache and refresh

**Restart Server:**
1. Go to **Dashboard** → **Advanced** → **Restart**
2. Wait for full restart
3. Refresh browser

### I see permission denied errors in logs

This is common with Docker installations or restrictive file permissions.

**Solution 1 (Recommended):**
Install the [file-transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) to handle file modifications safely.

**Solution 2 (Windows):**
1. Navigate to Jellyfin installation folder
2. Right-click → Properties → Security
3. Grant "NETWORK SERVICE" Read and Write permissions
4. Apply to all subfolders
5. Restart Jellyfin service

**Solution 3 (Linux):**
```bash
sudo chown -R jellyfin:jellyfin /usr/lib/jellyfin/
sudo chmod -R 755 /usr/lib/jellyfin/
```

**Solution 4 (Docker):**
Follow the Docker installation workaround in the [Installation Guide](installation.md#docker-installation).

### Scripts not loading after installation?

**Check Scheduled Task:**
1. **Dashboard** → **Scheduled Tasks**
2. Look for "Jellyfin Enhanced Startup"
3. Verify it has trigger "On application startup"
4. If missing, add trigger manually
5. Run task manually

**Check Browser Console:**
1. Press F12 to open developer tools
2. Go to Console tab
3. Filter by "Jellyfin Enhanced"
4. Look for errors (red text)
5. Report errors on GitHub if found

**Force Reload:**
1. Clear all browser cache
2. Close all Jellyfin tabs
3. Restart browser
4. Open Jellyfin fresh
5. Hard refresh (Ctrl+F5)

### Update not working properly?

**Clean Update Process:**
1. **Dashboard** → **Plugins** → **My Plugins**
2. Find Jellyfin Enhanced
3. Click **Uninstall**
4. Restart server
5. Clear browser cache
6. Reinstall from Catalog
7. Restart server again
8. Hard refresh browser (Ctrl+F5)

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
- Play a video with known intro
- Look for "Skip Intro" button
- If button appears, detection works
- If no button, run intro detection again

### Jellyseerr integration not connecting?

![Jellyseerr Settings](../images/jellyseerr.png)

**Check Configuration:**
1. Verify Jellyseerr URL is correct and accessible
2. Verify API key is correct (from Jellyseerr Settings → General)
3. Click "Test Connection" in plugin settings
4. Check icon status on search page:
   - 🟢 Active = Working
   - 🔴 No Access = User not imported
   - ⚫ Offline = Cannot connect

**Enable Jellyfin Sign-In:**
1. In Jellyseerr, go to Settings → Users
2. Enable "Enable Jellyfin Sign-In"
3. Import your Jellyfin users

![Jellyfin Sign-In](../images/jellyfin-signin.png)

**Import Users:**
1. In Jellyseerr, go to Users page
2. Click "Import Jellyfin Users"
3. Select users to import
4. Save changes

**User Access:**
- Users WITH access: ![Users with access](../images/users-with-access.png)
- Users WITHOUT access: ![Users without access](../images/users-no-access.png)

**Check Logs:**
1. Browser console (F12) for client errors
2. Jellyfin server logs for proxy errors
3. Jellyseerr logs for API errors

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

Bookmarks are stored server-side but settings are per-browser.

**How Bookmarks Work:**
- Bookmark data stored on Jellyfin server
- Settings stored in browser localStorage
- Each browser has independent settings
- Same user can access bookmarks from any device

**Sync Bookmarks:**
1. Bookmarks automatically sync via server
2. Settings must be configured per browser
3. Use same Jellyfin user account
4. Bookmarks appear on all devices

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
- Must be in fullscreen or theater mode
- Pause video (press Space)
- Screen should appear after brief delay

**Customize Elements:**
See [Pause Screen CSS](features.md#pause-screen-css) for hiding/styling elements.

### Reviews, Elsewhere, or Jellyseerr icons not working?

This is usually due to TMDB API access issues.

**TMDB API Blocked:**
- TMDB API may be blocked in your region
- Check Jellyseerr troubleshooting: [TMDB Access](https://docs.seerr.dev/troubleshooting#tmdb-failed-to-retrievefetch-xxx)
- Use VPN or proxy if needed
- Contact your ISP about API access

**Check Connection:**
1. Open browser console (F12)
2. Look for TMDB-related errors
3. Check network tab for failed requests
4. Verify Jellyseerr can access TMDB

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

**Hide Quality Tag:**
```css
.quality-overlay-label[data-quality="H264"] {
    display: none !important;
}
```

**Change Tag Color:**
```css
.quality-overlay-label[data-quality="4K"] {
    background-color: purple !important;
}
```

**Adjust Tag Size:**
```css
.quality-overlay-label {
    font-size: 0.9rem !important;
    padding: 4px 8px !important;
}
```

See [Features Guide](features.md#custom-styling) for complete CSS documentation.

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
5. Click **Save**
6. Force refresh (Ctrl+F5)

**Image Requirements:**
- PNG or SVG format recommended
- Transparent backgrounds for logos
- Appropriate dimensions for each type
- Files stored in plugin config folder

### Can I change tag positions?

Yes, via Enhanced panel settings:

1. Open Enhanced panel (press `?`)
2. Go to Settings tab
3. Find tag position options
4. Select position (top-left, top-right, bottom-left, bottom-right)
5. Changes apply immediately

**Advanced Positioning:**
Use Custom CSS for precise control:

```css
.quality-overlay-container {
    top: 10px !important;
    right: 10px !important;
}
```

---

## Troubleshooting

### How do I gather logs for bug reports?

**Browser Console Logs:**
1. Press F12 to open developer tools
2. Go to Console tab
3. Filter by "🪼Jellyfin Enhanced"
4. Look for errors (red text)
5. Copy error messages
6. Include in bug report

**Network Logs:**
1. Press F12 → Network tab
2. Filter by "JellyfinEnhanced"
3. Look for failed requests (red)
4. Check status codes
5. Include in bug report

**Server Logs:**
1. Go to **Dashboard** → **Logs**
2. Look for "JellyfinEnhanced" entries
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
| `Access to the path '/jellyfin/jellyfin-web/index.html' is denied.` | Install [file-transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) or follow [Docker workaround](installation.md#docker-installation) |
| `Access to the path 'C:\Program Files\Jellyfin\Server\jellyfin-web\index.html' is denied.` | Grant "NETWORK SERVICE" Read/Write permissions to Jellyfin folder |
| Plugin installed but scripts don't load | Run "Jellyfin Enhanced Startup" scheduled task, verify trigger exists |
| Reviews/Elsewhere/Jellyseerr icons not working | TMDB API may be blocked in your region, see [Jellyseerr troubleshooting](https://docs.seerr.dev/troubleshooting#tmdb-failed-to-retrievefetch-xxx) |
| Jellyseerr search not working | Enable "Jellyfin Sign-In" in Jellyseerr, import users |
| Tags not appearing | Enable in settings, clear cache, verify metadata exists |
| Bookmarks not saving | Check server logs, verify user data folder permissions |

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
- Jellyseerr discovery pages (many API calls)
- People tags (age calculations)
- Multiple tag types enabled
- Large bookmark collections

**Improve Performance:**
- Enable only needed features
- Use tag filters to reduce display
- Clear old bookmarks
- Limit Jellyseerr results

---

## Contributing

### How can I contribute translations?

**Add New Language:**
1. Go to `Jellyfin.Plugin.JellyfinEnhanced/js/locales/`
2. Copy `en.json`
3. Rename to your language code (e.g., `es.json`)
4. Translate all English text
5. Submit pull request

**Update Existing Translation:**
1. Find your language file in `js/locales/`
2. Update translations
3. Submit pull request

**Translation Updates:**
- Fetched from GitHub on first load
- Cached for 24 hours
- Available immediately after merge
- No plugin update needed

### How can I report bugs?

**Before Reporting:**
1. Check [existing issues](https://github.com/n00bcodr/Jellyfin-Enhanced/issues)
2. Verify plugin is up to date
3. Test with clean browser profile
4. Gather logs (see above)

**Create Issue:**
1. Go to [GitHub Issues](https://github.com/n00bcodr/Jellyfin-Enhanced/issues/new)
2. Use bug report template
3. Include all requested information
4. Add logs and screenshots
5. Submit issue

**Good Bug Reports Include:**
- Clear description
- Steps to reproduce
- Expected vs actual behavior
- Plugin version
- Jellyfin version
- Browser and OS
- Console/server logs
- Screenshots

### How can I request features?

**Feature Requests:**
1. Check [existing requests](https://github.com/n00bcodr/Jellyfin-Enhanced/issues?q=is%3Aissue+label%3Aenhancement)
2. Go to [GitHub Issues](https://github.com/n00bcodr/Jellyfin-Enhanced/issues/new)
3. Use feature request template
4. Describe feature clearly
5. Explain use case
6. Submit request

**Good Feature Requests:**
- Clear description
- Use case explanation
- Mockups/examples if applicable
- Consider existing features
- Be open to discussion

---

## Support & Community

### Where can I get help?

**Official Channels:**
- [GitHub Issues](https://github.com/n00bcodr/Jellyfin-Enhanced/issues) - Bug reports and feature requests
- [GitHub Discussions](https://github.com/n00bcodr/Jellyfin-Enhanced/discussions) - General questions and discussion
- [Discord Community](https://discord.com/channels/1381737066366242896/1442128048873930762) - Real-time chat and support

**Before Asking:**
1. Read this FAQ
2. Check [Installation Guide](installation.md)
3. Review [Features Guide](features.md)
4. Search existing issues
5. Check browser console for errors

**When Asking for Help:**
- Describe the problem clearly
- Include plugin and Jellyfin versions
- Provide browser and OS info
- Share relevant logs
- Include screenshots if helpful
- Be patient and respectful

### Is there a roadmap?

Check the [GitHub Projects](https://github.com/n00bcodr/Jellyfin-Enhanced/projects) page for planned features and development status.

**Stay Updated:**
- Watch the repository on GitHub
- Join Discord community
- Check release notes
- Follow discussions

---

## Related Projects

### Other projects by the developer

- [Jellyfin-Elsewhere](https://github.com/n00bcodr/Jellyfin-Elsewhere) - Streaming provider lookup (standalone)
- [Jellyfin-Tweaks](https://github.com/n00bcodr/JellyfinTweaks) - Additional tweaks plugin
- [Jellyfin-JavaScript-Injector](https://github.com/n00bcodr/Jellyfin-JavaScript-Injector) - Custom script injection
- [Jellyfish](https://github.com/n00bcodr/Jellyfish/) - Custom Jellyfin theme

### Recommended plugins

- [Intro Skipper](https://github.com/intro-skipper/intro-skipper) - Auto-skip intros/outros
- [File Transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) - Safe file modifications
- [Custom Tabs](https://github.com/randalsgi ft/CustomTabs) - Custom navigation tabs
- [Kefin Tweaks](https://github.com/ranaldsgift/KefinTweaks) - Watchlist and more

---

## Still Have Questions?

If your question isn't answered here:

1. Search [GitHub Discussions](https://github.com/n00bcodr/Jellyfin-Enhanced/discussions)
2. Ask in [Discord Community](https://discord.com/channels/1381737066366242896/1442128048873930762)
3. Create a [GitHub Issue](https://github.com/n00bcodr/Jellyfin-Enhanced/issues/new)

**Made with 💜 for Jellyfin and the community**