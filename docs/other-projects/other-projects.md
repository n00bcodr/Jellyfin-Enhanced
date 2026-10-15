# Related Projects

Explore companion plugins, scripts and themes by n00bcodr. For Jellyfin Enhanced itself, start at the [documentation index](../index.md) or [installation guide](../installation/installation.md).

## Jellyfin plugins

### Jellyfin Tweaks

[Jellyfin Tweaks](https://github.com/n00bcodr/JellyfinTweaks) adds controls for Jellyfin playback, display and user defaults. Use its own documentation to decide which settings to manage alongside JE. Check its [releases](https://github.com/n00bcodr/JellyfinTweaks/releases) for current compatibility.

### Jellyfin JavaScript Injector

[JavaScript Injector](https://github.com/n00bcodr/Jellyfin-JavaScript-Injector) lets you add your own JavaScript to Jellyfin's web interface. Use it for standalone customizations and script testing. Follow that project's setup instructions and [release requirements](https://github.com/n00bcodr/Jellyfin-JavaScript-Injector/releases).

!!! note

    JE already loads its own scripts as the server serves the web interface. You do not need JavaScript Injector to install JE. Avoid loading another copy of JE's client through an injector.

## Standalone scripts

### Jellyfin Elsewhere

[Jellyfin Elsewhere](https://github.com/n00bcodr/Jellyfin-Elsewhere) is the standalone streaming-provider lookup project. JE includes Elsewhere functionality with regional and per-season provider lookup; use the [JE Elsewhere guide](../elsewhere/elsewhere-features.md) when running the plugin.

Consult the standalone repository for its maintenance status, setup and limits.

!!! note

    Do not run both versions of Elsewhere on the same web interface.

## Themes

### Jellyfish

[Jellyfish](https://github.com/n00bcodr/Jellyfish/) is a Jellyfin CSS theme with color stylesheets. JE's color selector lets you choose a color in the web interface.

**How to use:**

1. Follow Jellyfish's [installation instructions](https://github.com/n00bcodr/Jellyfish/#installation) for the base theme and any optional components.
2. Open JE's administrator configuration and select **Extras**.
3. Turn on **Theme Selector (Jellyfish)** and save. Users can then choose a color from the web interface.

Administrator setting:

| Setting | Default | What it does |
| --- | --- | --- |
| **Theme Selector (Jellyfish)** | Off | Adds a Jellyfish color selector. |

??? info "How it works"

    The selector loads color CSS through JE's local CDN route. Your choice is saved in browser storage under your Jellyfin user ID and does not synchronize across devices. The random daily color preference starts off.

See [customization & extras](../other/other-features.md) and [settings](../other/other-settings.md).

!!! note

    Turning on the color selector does not install the base Jellyfish theme. CSS themes and custom rules can change the appearance of JE. Check the theme's own compatibility guidance, and use the [CSS customization guide](../advanced/css-customization.md) when adjusting JE's styles.

## Installing plugins

Install JE, Jellyfin Tweaks and JavaScript Injector from the shared repository.

1. Open **Dashboard → Plugins → Repositories** and click **➕**.
2. Enter a name, paste this repository URL, then save:

    ```text
    https://raw.githubusercontent.com/n00bcodr/jellyfin-plugins/main/manifest.json
    ```

3. Open **Catalog**, select the desired plugin and click **Install**.
4. Restart Jellyfin and refresh the web interface.

See [JE installation](../installation/installation.md) for the full workflow and [compatibility](../getting-started/compatibility.md) for dependencies. Install File Transformation when an optional companion requires it; JE itself does not need it.

## Compatibility

Choose the JE build for your Jellyfin version. Current builds target Jellyfin 12.x and 10.11.x.

| Project | Jellyfin 12.x | Jellyfin 10.11.x | Older servers |
| --- | --- | --- | --- |
| Jellyfin Enhanced | Current build | Current build | 10.10: archived at JE 10.11.1.0 |
| Jellyfin Tweaks | Check [release requirements](https://github.com/n00bcodr/JellyfinTweaks/releases) | Check release requirements | Use that project's release information |
| JavaScript Injector | Check [release requirements](https://github.com/n00bcodr/Jellyfin-JavaScript-Injector/releases) | Check release requirements | Use that project's release information |
| Jellyfish | Check [theme documentation](https://github.com/n00bcodr/Jellyfish/#installation) | Check theme documentation | Use the theme's own compatibility guidance |

??? note "Details"

    The shared manifest contains separate builds; one DLL does not serve every Jellyfin version. The Jellyfin 10.10 build is archived at JE 10.11.1.0.

## Support & community

Report a problem to the project that owns the feature:

- [Jellyfin Enhanced issues](../faq-support/report-issues.md).
- [Jellyfin Tweaks issues](https://github.com/n00bcodr/JellyfinTweaks/issues).
- [JavaScript Injector issues](https://github.com/n00bcodr/Jellyfin-JavaScript-Injector/issues).
- [Jellyfish issues](https://github.com/n00bcodr/Jellyfish/issues).
- [Discord community](https://discord.gg/EYNFf7y4CG).

Use each project's releases for updates and its contribution guide before submitting changes. JE is GPL-3.0; consult each companion repository's own license rather than assuming they all share the same license.
