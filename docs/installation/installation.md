# Installation Guide

Install Jellyfin Enhanced (JE) through Jellyfin's plugin manager, then restart the server and reload the web client.

## Requirements

!!! note "Before you install"

    - You need Jellyfin Server 12.x or 10.11.x and administrator access.
    - Use a browser with the web interface served by that Jellyfin server.
    - The account running Jellyfin needs write access to plugin configuration/data storage and Jellyfin log storage.

See [Compatibility](../getting-started/compatibility.md) for supported clients, layouts, historical Jellyfin releases, companion plugins, and external services.

??? info "How it works"

    JE normally adds its script when the server serves the web page. It does not need to modify the web directory or require File Transformation.

    If you host the web interface separately from Jellyfin, check that it loads JE's scripts. JE cannot automatically add them to a page served elsewhere.

## Standard Installation

Add the repository so Jellyfin can offer the JE build that matches your server. Then install the plugin and restart Jellyfin.

### Step 1: Add Plugin Repository

1. Sign in as an administrator and open Jellyfin's plugin repository management screen.
2. Add a repository named **Jellyfin Enhanced** with this URL:

    ```text
    https://raw.githubusercontent.com/n00bcodr/jellyfin-plugins/main/manifest.json
    ```

3. Save the repository.

??? note "Details"

    The shared manifest lets Jellyfin select the build that matches your server. The plugin version and its Jellyfin build target are separate: one JE release supplies builds for both supported server lines.

### Step 2: Install Plugin

1. Open the plugin catalog and select **Jellyfin Enhanced**.
2. Install the release offered for your server.
3. Wait for installation to finish.

### Step 3: Restart Server

Restart the Jellyfin server to load the plugin. A browser refresh alone cannot load a newly installed server plugin.

### Step 4: Verify Installation

1. Confirm **Jellyfin Enhanced** appears in Jellyfin's installed plugins and open its administrator configuration page.
2. Reload the web client with ++ctrl+f5++ on Windows/Linux or ++command+shift+r++ on macOS.
3. Open your personal panel using one of these entries:

    - Press ++question++ while focus is outside an input or text area.
    - In a layout with a sidebar, select **Jellyfin Enhanced** → **Enhanced Panel**.
    - In the Jellyfin 12 profile menu, select **Jellyfin Enhanced**.
    - In the user preferences menu, select **Jellyfin Enhanced - User Settings**.
    - In mobile or TV web layouts, use the player button titled **Jellyfin Enhanced** when the player controls are available. Desktop layouts hide it.

If the panel opens, JE's client interface loaded successfully.

??? note "Details"

    Configure and test optional integrations separately. Opening the panel does not verify service connectivity, account permissions, background tasks, or library metadata.

If the plugin appears but the panel does not open, use [Scripts Not Loading](troubleshooting.md#scripts-not-loading). If the plugin itself is missing, use [Plugin Not Appearing After Installation](troubleshooting.md#plugin-not-appearing-after-installation).

## First settings

The administrator configuration page controls server features and the starting values for personal preferences. Your **Enhanced Panel** controls your account's personal preferences. See [Settings Overview](../getting-started/settings-overview.md) for the distinction and [Quick start](../getting-started/index.md) for what to try first.

You can also read **Documentation** in the administrator **Docs** tab. It loads the hosted docs site, so your browser needs access to that site. Select **Open in new tab** if it cannot load inside the settings. See [Settings Overview](../getting-started/settings-overview.md) for the admin tabs.

## Optional integrations

Install companions or configure services only for the features you want. Check [Compatibility](../getting-started/compatibility.md) for requirements and [JE Pages & Tabs](../getting-started/pages-and-tabs.md) for page placement. Follow the [Seerr settings](../seerr/seerr-settings.md), [*arr settings](../arr/arr-settings.md), and [Elsewhere settings](../elsewhere/elsewhere-settings.md) guides for their integrations.

## Updates and backups

Back up JE's configuration and data before an update or server migration. Follow [Settings Overview](../getting-started/settings-overview.md) for backup instructions.

1. Update through Jellyfin's plugin manager.
2. Restart the server.
3. Hard-refresh your web clients.

If the running version or behavior is still wrong, see [Update Not Working](troubleshooting.md#update-not-working).
