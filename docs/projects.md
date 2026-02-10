# Other Projects

Related projects by n00bcodr for Jellyfin customization and enhancement.

## Jellyfin Plugins

### Jellyfin Enhanced
**Type:** Plugin
**Repository:** [github.com/n00bcodr/Jellyfin-Enhanced](https://github.com/n00bcodr/Jellyfin-Enhanced)

The essential enhancement suite for Jellyfin, bundling advanced features and customizations into one convenient plugin.

**Features:**
- Keyboard shortcuts and playback controls
- Jellyseerr integration
- Visual tags (quality, genre, language, rating)
- Custom pause screen
- Bookmarks and timestamps
- ARR integration
- And much more...

**Status:** ✅ Active Development

---

### Jellyfin Tweaks
**Type:** Plugin
**Repository:** [github.com/n00bcodr/JellyfinTweaks](https://github.com/n00bcodr/JellyfinTweaks)

Additional tweaks and enhancements for Jellyfin that complement Jellyfin Enhanced.

**Features:**
- Additional UI tweaks
- Performance optimizations
- Extra customization options
- Complementary to Jellyfin Enhanced

**Status:** ✅ Active Development

---

### Jellyfin JavaScript Injector
**Type:** Plugin
**Repository:** [github.com/n00bcodr/Jellyfin-JavaScript-Injector](https://github.com/n00bcodr/Jellyfin-JavaScript-Injector)

Inject custom JavaScript into Jellyfin web interface without modifying core files.

**Features:**
- Safe JavaScript injection
- No core file modifications
- Easy script management
- Perfect for custom scripts

**Use Cases:**
- Testing custom scripts
- Running standalone enhancements
- Prototyping new features
- Custom integrations

**Status:** ✅ Active Development

---

## Standalone Scripts

### Jellyfin Elsewhere
**Type:** JavaScript
**Repository:** [github.com/n00bcodr/Jellyfin-Elsewhere](https://github.com/n00bcodr/Jellyfin-Elsewhere)

Standalone version of the Elsewhere feature for streaming provider lookup.

**Features:**
- Discover where media is available to stream
- Multi-region support
- Buy, rent, and stream options
- TMDB integration

**Use Cases:**
- Use without full Jellyfin Enhanced plugin
- Lighter alternative
- Custom implementations
- Testing and development

**Status:** ❌ Inactive

**Note:** Functionality is now a part of Jellyfin Enhanced plugin.

---

## Themes

### Jellyfish
**Type:** CSS Theme
**Repository:** [github.com/n00bcodr/Jellyfish](https://github.com/n00bcodr/Jellyfish/)

A beautiful, modern theme for Jellyfin with multiple color variants.

**Features:**
- Clean, modern design
- Multiple color palettes
- Responsive layout
- Optimized for readability
- Custom animations
- Enhanced visual hierarchy

**Color Variants:**
- Aurora
- Jellyblue
- Ocean
- Sunset
- Forest
- And more...

**Installation:**
1. Go to **Dashboard** → **General** → **Custom CSS**
2. Add Jellyfish CSS URL
3. Save and refresh

**Status:** ✅ Active Development

**Compatibility:** Works great with Jellyfin Enhanced!

---

## Installation Guide

### Installing Plugins

**From Repository:**
1. Go to **Dashboard** → **Plugins** → **Catalog** → ⚙️
2. Add repository URL
3. Install desired plugin
4. Restart Jellyfin server

**Repository URL:** Unified Manigest for all plugins `https://raw.githubusercontent.com/n00bcodr/jellyfin-plugins/main/10.11/manifest.json`

### Installing Themes

**Jellyfish Theme:**
1. Go to **Dashboard** → **General** → **Custom CSS**
2. Add theme CSS URL from repository
3. Save and refresh browser


---

## Compatibility

### Plugin Compatibility

| Plugin | Jellyfin 10.11 | Jellyfin 10.10 | Notes |
|--------|----------------|----------------|-------|
| Jellyfin Enhanced | ✅ | ❌ | Use 10.11 manifest |
| Jellyfin Tweaks | ✅ | ✅ | |
| JS Injector | ✅ | ✅ |  |

### Theme Compatibility

| Theme | Jellyfin Enhanced | Notes |
|-------|-------------------|-------|
| Jellyfish | ✅ Recommended | Designed to work together |
| Other Themes | ✅ Compatible | May need adjustments |

---

## Support & Community

### Getting Help

**For Jellyfin Enhanced:**
- [GitHub Issues](https://github.com/n00bcodr/Jellyfin-Enhanced/issues)
- [Discord Community](https://discord.com/channels/1381737066366242896/1442128048873930762)
- [Discussions](https://github.com/n00bcodr/Jellyfin-Enhanced/discussions)

**For Jellyfin Tweaks:**
- [GitHub Issues](https://github.com/n00bcodr/JellyfinTweaks/issues)
- [Discord Community](https://discord.com/channels/1381737066366242896/1442128048873930762)

**For JavaScript Injector:**
- [GitHub Issues](https://github.com/n00bcodr/Jellyfin-JavaScript-Injector/issues)
- [Discord Community](https://discord.com/channels/1381737066366242896/1442128048873930762)



### Contributing

Contributions welcome on all projects!

**Ways to Contribute:**
- Report bugs
- Suggest features
- Submit pull requests
- Add translations
- Improve documentation
- Share feedback

**Before Contributing:**
1. Check existing issues
2. Read contribution guidelines
3. Test your changes
4. Follow code style
5. Submit detailed PR


---

## Frequently Asked Questions


### Are these official Jellyfin projects?

No, these are community projects by n00bcodr. They are not officially affiliated with Jellyfin, but are designed to enhance the Jellyfin experience. For any support kindly approach Jellyfin Community Discord!

### Will these break my Jellyfin?

No, these projects are designed to be safe:
- No core file modifications (with file-transformation plugin - highly recommended)
- Easy to uninstall
- Active maintenance

---

## Stay Updated

### Follow Development

- **GitHub:** Watch repositories for updates
- **Discord:** Join community for announcements
- **Releases:** Check release notes for changes

---

## Credits & Acknowledgments

### Special Thanks

- **Jellyfin Team** - For the amazing media server
- **[BobHasNoSoul](https://github.com/BobHasNoSoul/)** - Huge inspiration for getting into modding Jellyfin
- **[IAmParadox27](https://github.com/IAmParadox27/)** - Inspiration for making Jellyfin Enhanced as a plugin from a user script.
- **Community Contributors** - Translations, bug reports, and feedback
- **Plugin Developers** - Intro Skipper, Custom Tabs, Plugin Pages, and more


---

## License

All projects are open source under GPL-3.0 license unless otherwise specified.

See individual repositories for detailed license information.

---

**Made with 💜 for Jellyfin and the community**

[Back to Home](index.md) | [Installation Guide](installation.md) | [FAQ](faq.md)
