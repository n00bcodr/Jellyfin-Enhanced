# Jellyfin Enhanced

<p align="center">
  <img src="https://img.shields.io/github/last-commit/n00bcodr/Jellyfin-Enhanced/main?logo=semantic-release&logoColor=white&label=Last%20Updated&labelColor=black&color=AA5CC3&cacheSeconds=3600" alt="Last Updated">
  <img src="https://img.shields.io/github/commit-activity/w/n00bcodr/Jellyfin-Enhanced?logo=git&label=Commit%20Activity&labelColor=black&color=00A4DC&cacheSeconds=600" alt="Commit Activity">
  <img src="https://img.shields.io/badge/Jellyfin%20Version-10.11-AA5CC3?logo=jellyfin&logoColor=00A4DC&labelColor=black" alt="Jellyfin Version">
  <br><br>
  <img alt="GitHub Downloads" src="https://img.shields.io/github/downloads/n00bcodr/Jellyfin-Enhanced/latest/Jellyfin.Plugin.JellyfinEnhanced_10.11.0.zip?displayAssetName=false&label=10.11%20Downloads%40Latest&labelColor=black&color=AA5CC3&cacheSeconds=60">
  <br><br>
  <a href="https://discord.gg/HKA2QNYJ6"><img alt="Discord" src="https://img.shields.io/badge/Jellyfin%20Enhanced%20-%20Jellyfin%20Community?&logo=discord&logoColor=white&style=for-the-badge&label=Jellyfin%20Community&labelColor=5865F2&color=black"></a>
</p>

<br>

The essential enhancement suite for Jellyfin, bundling advanced features and customizations into one convenient plugin.

<div align="center">
  <video src="https://github.com/user-attachments/assets/c3fed9fe-63c4-4e26-b2b6-73c4817613aa"></video>
</div>

<br>

## 📚 Documentation

**Complete documentation is available at: [https://n00bcodr.github.io/Jellyfin-Enhanced/](https://n00bcodr.github.io/Jellyfin-Enhanced/)**

Quick links:
- [Installation Guide](https://n00bcodr.github.io/Jellyfin-Enhanced/installation/installation/)
- [Features Overview](https://n00bcodr.github.io/Jellyfin-Enhanced/enhanced/enhanced-features/)
- [Jellyseerr Integration](https://n00bcodr.github.io/Jellyfin-Enhanced/jellyseerr/jellyseerr-features/)
- [ARR Integration](https://n00bcodr.github.io/Jellyfin-Enhanced/arr/arr-features/)
- [FAQ & Troubleshooting](https://n00bcodr.github.io/Jellyfin-Enhanced/faq-support/faq/)
- [CSS Customization](https://n00bcodr.github.io/Jellyfin-Enhanced/advanced/css-customization/)

<br>

## 🚀 Quick Start

### Installation

1. In Jellyfin, go to **Dashboard** → **Plugins** → **Repositories**
2. Click **➕** and add the repository:
   ```
   https://raw.githubusercontent.com/n00bcodr/jellyfin-plugins/main/10.11/manifest.json
   ```
3. Go to **Catalog** tab, find **Jellyfin Enhanced**, and click **Install**
4. **Restart** your Jellyfin server

> [!IMPORTANT]
> **Jellyfin 10.11+ Required** - This plugin only supports Jellyfin 10.11 and newer.

> [!TIP]
> **Highly Recommended:** Install the [File Transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) to avoid permission issues on all installation types (Docker, Windows, Linux, etc.).

For detailed installation instructions and troubleshooting, see the [Installation Guide](https://n00bcodr.github.io/Jellyfin-Enhanced/installation/installation/).

<br>

## ✨ Features Highlights

### 🎬 Enhanced Playback
- **Advanced Keyboard Shortcuts** - Comprehensive hotkeys for navigation and playback
- **Smart Bookmarks** - Save and jump to timestamps with visual markers
- **Custom Pause Screen** - Beautiful overlay with media info
- **Auto-Skip Intros/Outros** - Seamless binge-watching (requires Intro Skipper plugin)
- **Custom Subtitle Colors** - Full color customization with alpha support

### 🙈 Content Management (New in v11)
- **Hidden Content System** - Per-user content hiding with server-side storage
- **Granular Filtering** - Control visibility across library, discovery, search, and more
- **Management Panel** - Search, unhide, and bulk operations

### 🪼 Jellyseerr Integration
- **Search & Request** - Request media directly from Jellyfin search
- **Item Details** - Recommendations and similar items on detail pages
- **Discovery Pages** - Browse by genre, network, person, or tag
- **Issue Reporting** - Report problems directly to Jellyseerr
- **Watchlist Sync** - Auto-sync with Jellyfin watchlist

### 🔗 *arr Integration
- **Quick Links** - Jump to Sonarr, Radarr, Bazarr pages (admin only)
- **Tag Links** - Display and filter *arr tags
- **Calendar View** - Upcoming releases from Sonarr/Radarr
- **Requests Page** - Monitor download queue and status

### 🏷️ Visual Enhancements
- **Quality Tags** - 4K, HDR, Atmos, and more on posters
- **Genre Tags** - Themed icons for instant genre identification
- **Language Tags** - Country flags for available audio languages
- **Rating Tags** - TMDB and Rotten Tomatoes ratings at a glance
- **People Tags** - Age and birthplace info for cast members

### 🔍 Discovery
- **Elsewhere Integration** - See where media is available to stream
- **TMDB Reviews** - Display user reviews from TMDB
- **Random Button** - Discover content in your library

### 🎨 Customization
- **Custom Branding** - Upload your own logos, banners, and favicon
- **Theme Selector** - Choose from multiple color variants
- **Extensive CSS Options** - Customize every visual element
- **Multi-language Support** - Available in 15+ languages

[View all features →](https://n00bcodr.github.io/Jellyfin-Enhanced/enhanced/enhanced-features/)

<br>

## 🧪 Compatibility

| Platform | Support | Notes |
|----------|---------|-------|
| Jellyfin Web UI | ✅ Full | All features available |
| Android App | ✅ Full | Official app with embedded web UI |
| iOS App | ✅ Full | Official app with embedded web UI |
| Desktop Apps | ✅ Full | JMP, Jellyfin Desktop v2.0.0+ |
| Android TV | ❌ Not Supported | Native app, no web UI |
| Third-party Apps | ❌ Not Supported | Depends on embedded web UI |

<br>

## 📸 Screenshots

<table>
  <tr>
    <th>Shortcuts</th>
    <th>Settings</th>
  </tr>
  <tr>
    <td><img src="docs/images/shortcuts.png" width="400" /></td>
    <td><img src="docs/images/settings.png" width="400" /></td>
  </tr>
  <tr>
    <th>Pause Screen</th>
    <th>Elsewhere</th>
  </tr>
  <tr>
    <td><img src="docs/images/pausescreen.png" width="400" /></td>
    <td><img src="docs/images/elsewhere.png" width="400" /></td>
  </tr>
  <tr>
    <th>Jellyseerr</th>
    <th>Ratings</th>
  </tr>
  <tr>
    <td><img src="docs/images/jellyseerr.png" width="400" /></td>
    <td><img src="docs/images/ratings.png" width="400" /></td>
  </tr>
</table>

<br>

## 🌍 Contributing

### Translations

Help translate Jellyfin Enhanced into your language!

1. Copy `en.json` from `Jellyfin.Plugin.JellyfinEnhanced/js/locales/`
2. Rename to your language code (e.g., `es.json`)
3. Translate the text
4. Submit a pull request

Translations are available immediately after merge!

[Translation Guide →](https://n00bcodr.github.io/Jellyfin-Enhanced/faq-support/contributing-translations/)

### Bug Reports & Feature Requests

- [Report Issues](https://github.com/n00bcodr/Jellyfin-Enhanced/issues)
- [Feature Requests](https://github.com/n00bcodr/Jellyfin-Enhanced/discussions)
- [Discord Community](https://discord.gg/HKA2QNYJ6)

<br>

## 💡 Support

Need help? Check these resources:

- [FAQ](https://n00bcodr.github.io/Jellyfin-Enhanced/faq-support/faq/)
- [Troubleshooting Guide](https://n00bcodr.github.io/Jellyfin-Enhanced/installation/troubleshooting/)
- [GitHub Discussions](https://github.com/n00bcodr/Jellyfin-Enhanced/discussions)
- [Discord Community](https://discord.gg/HKA2QNYJ6)

<br>

## 🎯 Related Projects

Other projects by n00bcodr:

- [Jellyfin-Elsewhere](https://github.com/n00bcodr/Jellyfin-Elsewhere) - Streaming provider lookup (standalone)
- [Jellyfin-Tweaks](https://github.com/n00bcodr/JellyfinTweaks) - Additional tweaks plugin
- [Jellyfin-JavaScript-Injector](https://github.com/n00bcodr/Jellyfin-JavaScript-Injector) - Custom script injection
- [Jellyfish](https://github.com/n00bcodr/Jellyfish/) - Custom Jellyfin theme

Recommended plugins:

- [Intro Skipper](https://github.com/intro-skipper/intro-skipper) - Auto-skip intros/outros
- [File Transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) - Safe file modifications
- [Custom Tabs](https://github.com/randalsgift/CustomTabs) - Custom navigation tabs
- [Kefin Tweaks](https://github.com/ranaldsgift/KefinTweaks) - Watchlist and more

<br>

## ⭐ Star History

<a href="https://star-history.com/#n00bcodr/Jellyfin-Enhanced&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=n00bcodr/Jellyfin-Enhanced&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=n00bcodr/Jellyfin-Enhanced&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=n00bcodr/Jellyfin-Enhanced&type=Date" />
 </picture>
</a>

<br>

## 📄 License

This project is licensed under the [GNU General Public License v3.0](LICENSE).

<br>

---

<div align="center">

### Enjoying Jellyfin Enhanced?

If this plugin has enhanced your Jellyfin experience, consider:
- ⭐ Starring the repository
- 🐛 Reporting bugs or suggesting features
- 🌍 Contributing translations
- 💬 Joining our [Discord community](https://discord.gg/HKA2QNYJ6)

Made with 💜 for Jellyfin and the community

</div>
