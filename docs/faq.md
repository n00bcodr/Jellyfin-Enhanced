# Frequently Asked Questions

## General

### Can I customize the keyboard shortcuts?

Yes! Open the Jellyfin Enhanced panel by clicking the menu item or pressing `?`, then go to the Shortcuts tab. Click on any key to set a custom shortcut.

### Does this work on mobile apps?

Yes, the plugin works on the official Jellyfin Android and iOS apps, as well as desktop and web UIs.

### Does this work on Android TV?

No, the plugin does not work on Android TV or other native TV apps. It only functions on clients that use Jellyfin's embedded web UI.

## Installation

### Plugin not appearing after installation?

1. Verify it's installed in **Dashboard** → **Plugins** → **My Plugins**
2. Check scheduled tasks: **Dashboard** → **Scheduled Tasks** → "Jellyfin Enhanced Startup"
3. Clear browser cache (Ctrl+F5)
4. Restart Jellyfin server

### I see permission denied errors

This is common with Docker installations. Install the [file-transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) to resolve this.

## Features

### Auto-skip not working?

Auto-skip requires the [Intro Skipper plugin](https://github.com/intro-skipper/intro-skipper) to be installed and intro segments to be detected for your media.

### Jellyseerr integration not connecting?

1. Verify your Jellyseerr URL and API key in plugin settings
2. Ensure "Enable Jellyfin Sign-In" is enabled in Jellyseerr settings
3. Import your Jellyfin users into Jellyseerr
4. Click "Test Connection" in plugin settings

### Tags not showing on posters?

1. Ensure the feature is enabled in settings or Jellyfin Enhanced Panel
2. Clear browser cache (Ctrl+F5)
3. Verify media has the required metadata

## Troubleshooting

### How do I gather logs?

**Browser Console:**
1. Press F12 to open developer tools
2. Go to Console tab
3. Filter by "Jellyfin Enhanced"
4. Look for errors

**Server Logs:**
1. Go to **Dashboard** → **Logs**
2. Look for "JellyfinEnhanced" entries

### Scripts not loading?

1. Clear browser cache completely
2. Do a hard refresh: Ctrl+F5 (Windows/Linux) or Cmd+Shift+R (Mac)
3. Check browser console for errors
4. Verify scheduled task ran successfully

## Support

### Where can I get help?

- [GitHub Issues](https://github.com/n00bcodr/Jellyfin-Enhanced/issues)
- [Discord Community](https://discord.com/channels/1381737066366242896/1442128048873930762)
- [GitHub Discussions](https://github.com/n00bcodr/Jellyfin-Enhanced/discussions)

### How can I contribute?

Contributions are welcome! You can:
- Report bugs or suggest features on GitHub
- Add translations for your language
- Contribute to documentation
- Submit pull requests

See the [GitHub repository](https://github.com/n00bcodr/Jellyfin-Enhanced) for details.