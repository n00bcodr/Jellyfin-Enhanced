# About Jellyfin Enhanced

## Project overview

Jellyfin Enhanced (JE) adds browsing and playback tools, personal settings and service integrations to Jellyfin. You install it on the server to add features to that server's web interface. Selected server features also work with native clients; see [compatibility](getting-started/compatibility.md).

JE is an independent community project by [n00bcodr](https://github.com/n00bcodr) and contributors, not an official Jellyfin or Seerr product. The [project manifest](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/main/manifest.json) describes its origins as a combination of the Jellyfin Enhanced and Jellyfin Elsewhere userscripts.

Start with the [documentation index](index.md), [quick start](getting-started/index.md) or [feature guide](enhanced/enhanced-features.md). JE is licensed under [GPL-3.0](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/main/LICENSE).

## Credits & acknowledgments

### Special thanks

- The [Jellyfin team](https://jellyfin.org/) for the open-source media server JE builds on.
- [BobHasNoSoul](https://github.com/BobHasNoSoul/) for inspiration through projects such as [Jellyfin PauseScreen](https://github.com/BobHasNoSoul/Jellyfin-PauseScreen) and [Jellyfin Quality Tags](https://github.com/BobHasNoSoul/Jellyfin-Qualitytags/).
- [IAmParadox27](https://github.com/IAmParadox27/) for inspiration through Jellyfin plugins, including [File Transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) and [Plugin Pages](https://github.com/IAmParadox27/jellyfin-plugin-pages).
- Everyone who contributes code, documentation, testing, bug reports and feature ideas.

<div align="center">
  <a href="https://github.com/n00bcodr/Jellyfin-Enhanced/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=n00bcodr/Jellyfin-Enhanced" alt="Contributors" />
  </a>
</div>

### Community translations

Community translations cover more than 30 locales. Some are incomplete; missing text falls back to English. Thank you to everyone who makes JE easier to use in their language. See [contributing translations](faq-support/contributing-translations.md) to help.

### Related projects & integrations

| Project | How it connects to JE |
| --- | --- |
| [Seerr](https://github.com/seerr-team/seerr) | Requests, discovery, recommendations, automatic requests and watchlist sync. Configure the service and link each requesting user's Seerr account. |
| Sonarr, Radarr, Bazarr and Shoko | Library-management links, tags, downloads and release-calendar data. See the [*arr guide](arr/arr-features.md). |
| [Plugin Pages](https://github.com/IAmParadox27/jellyfin-plugin-pages) | Optional delivery for Bookmarks, Calendar, Requests, Hidden Content, Recommendations, Activity and Catch Up. |
| [Custom Tabs](https://github.com/IAmParadox27/jellyfin-plugin-custom-tabs) | Optional delivery of those pages through custom Home tabs. JE also has native Home tabs that need neither companion. |
| [File Transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) | Required by optional companions such as Plugin Pages and Custom Tabs. JE itself does not require it. |
| [KefinTweaks](https://github.com/ranaldsgift/KefinTweaks) | Displays your watchlist. JE's watchlist sync works without it. |

Catch Up and Activity are built into JE. In Catch Up, you can mark unwatched titles watched, dismiss them in this browser, add them to your watchlist or open details.

??? info "How it works"

    JE adds its client scripts as the server serves the web interface. It does not require File Transformation for this.

    Watchlist sync reads and writes Jellyfin's Likes flag without requiring KefinTweaks. Catch Up's optional server activity log is separate from outbound analytics; see the [collection and privacy explanation](advanced/community-analytics.md#local-catch-up-activity-log).

See [JE pages & tabs](getting-started/pages-and-tabs.md) for page masters, delivery choices and requirements. For themes and other projects by n00bcodr, use [Related projects](other-projects/other-projects.md).

## Contributing

You can help by reporting reproducible bugs, suggesting features, translating, improving documentation, testing changes or contributing code.

- [Report issues](faq-support/report-issues.md) and [request features](faq-support/feature-requests.md).
- Read the [code contribution guide](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/main/CONTRIBUTING.md).
- Join [GitHub Discussions](https://github.com/n00bcodr/Jellyfin-Enhanced/discussions) or [Discord](https://discord.gg/EYNFf7y4CG).
- Check [installation troubleshooting](installation/troubleshooting.md) and the [FAQ](faq-support/faq.md) before reporting a setup problem.

## Support Me

If you enjoy Jellyfin Enhanced, consider supporting my work.

<div align="center">
  <a href='https://ko-fi.com/G2G51TIZF0' target='_blank'><img height='36' style='border:0px;height:36px;' src='https://storage.ko-fi.com/cdn/kofi5.png?v=6' border='0' alt='Buy Me a Coffee at ko-fi.com' /></a>
  &nbsp;&nbsp;&nbsp;
  <a href="https://www.buymeacoffee.com/n00bcodr">
    <img src="https://img.buymeacoffee.com/button-api/?text=Buy me a coffee&emoji=☕&slug=n00bcodr&button_colour=FFDD00&font_colour=000000&font_family=Ubuntu&outline_colour=000000&coffee_colour=ffffff" alt="Buy Me A Coffee" />
  </a>
</div>
<br>
<div align="center">
  <p><em>Your support helps me buy more drives, improve my hardware <br> and stay motivated to keep working on Jellyfin Enhanced!</em></p>
</div>

---


## Statistics

<div align="center">
  <a href="https://www.star-history.com/?repos=n00bcodr%2FJellyfin-Enhanced&type=date&legend=top-left">
   <picture>
     <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=n00bcodr/Jellyfin-Enhanced&type=date&theme=dark&legend=top-left&sealed_token=dHVltYjTopyABWuSHsm1qmc7Q72ljM73fNCmKNNTqhJRqfngH-60EOzWJlfunX3xrqZimaAQdy3reRT1DWP_qt8ruMBd0LwddO1DZnX5ns00uOrFW9z82w" />
     <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=n00bcodr/Jellyfin-Enhanced&type=date&legend=top-left&sealed_token=dHVltYjTopyABWuSHsm1qmc7Q72ljM73fNCmKNNTqhJRqfngH-60EOzWJlfunX3xrqZimaAQdy3reRT1DWP_qt8ruMBd0LwddO1DZnX5ns00uOrFW9z82w" />
     <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=n00bcodr/Jellyfin-Enhanced&type=date&legend=top-left&sealed_token=dHVltYjTopyABWuSHsm1qmc7Q72ljM73fNCmKNNTqhJRqfngH-60EOzWJlfunX3xrqZimaAQdy3reRT1DWP_qt8ruMBd0LwddO1DZnX5ns00uOrFW9z82w" />
   </picture>
  </a>
</div>

---

<div align="center">

**Made with 💜 for Jellyfin and the community**

</div>
