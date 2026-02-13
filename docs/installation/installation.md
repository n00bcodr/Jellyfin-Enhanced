# Installation Guide

<!-- use a custom title -->
!!! info "Prerequisites"

    **Prerequisites:**

    - Jellyfin server version 10.11.x
    - Admin access to your Jellyfin server
    - Modern web browser (Chrome, Firefox, Edge, Safari)


## Standard Installation

### Step 1: Add Plugin Repository

1. In Jellyfin, navigate to **Dashboard** → **Plugins** → **Manage Repositories**
2. Click **➕** (Add button) to add a new repository
3. Give the repository a name (e.g., "Jellyfin Enhanced")
4. Set the **Repository URL** to the manifest:
   ```
   https://raw.githubusercontent.com/n00bcodr/jellyfin-plugins/main/10.11/manifest.json
   ```

5. Click **Save**

### Step 2: Install Plugin

1. Go to the **All** tab
2. Find **Jellyfin Enhanced** in the plugin list
3. Click **Install**
4. Wait for the installation to complete

### Step 2a: Install File Transformation Plugin (Recommended)

<!-- use a custom title -->
!!! info "Important"

    **It is highly recommended to install the [File Transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation)**

    Why?

    - The File Transformation plugin helps avoid permission issues while modifying `index.html`
    - Recommended on all installation types:
        - Docker
        - Windows
        - Linux
        - etc
    - Without it, you may encounter permission errors


1. In the **Catalog** tab, search for "file-transformation"
2. Install the **File Transformation** plugin
3. Restart your Jellyfin server
4. Then install Jellyfin Enhanced normally


If you do not have file-transformation installed, you might encounter permission issues. Refer [troubleshooting steps](troubleshooting.md)

### Step 3: Restart Server

1. **Restart** your Jellyfin server to complete the installation *(This is required for the plugin to take effect)*

### Step 4: Verify Installation

After restart:

1. Refresh your browser *(`Ctrl+F5` or `Cmd+Shift+R`)*
2. Access the Jellyfin Enhanced settings panel. Options:
    - In the sidebar: **Jellyfin Enhanced**
    - Press `?`
3. If you see the panel, installation was successful!