# Installation

## Prerequisites

- Jellyfin server version 10.11.x
- Admin access to your Jellyfin server

## Standard Installation

1. In Jellyfin, go to **Dashboard** → **Plugins** → **Catalog** → ⚙️
2. Click **➕** and add repository
3. Set **Repository URL** based on your Jellyfin version:

=== "Jellyfin 10.11"

    ```
    https://raw.githubusercontent.com/n00bcodr/jellyfin-plugins/main/10.11/manifest.json
    ```

4. Click **Save**
5. Go to **Catalog** tab, find **Jellyfin Enhanced**, click **Install**
6. **Restart** your Jellyfin server

## Verify Installation

After restart:

1. Refresh your browser (or press Ctrl+F5)
2. Look for **Jellyfin Enhanced** menu item in the sidebar
3. Click it or press `?` to open the settings panel

## Docker Installation

!!! warning "Docker Permission Issues"
    Docker installations may need the [file-transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) to avoid permission errors.

### Install file-transformation plugin

1. In **Catalog** tab, search for "file-transformation"
2. Install the **File Transformation** plugin
3. Restart your server
4. Then install Jellyfin Enhanced normally

## Troubleshooting

### Plugin Not Appearing

1. Check **Dashboard** → **Plugins** → **My Plugins** to verify installation
2. Check **Dashboard** → **Scheduled Tasks** → Run "Jellyfin Enhanced Startup"
3. Clear browser cache (Ctrl+F5)
4. Restart Jellyfin server

### Permission Errors

If you see permission denied errors:

**Windows:**
- Grant "NETWORK SERVICE" read/write permissions to Jellyfin folder

**Linux:**
```bash
sudo chown -R jellyfin:jellyfin /usr/lib/jellyfin/
```

**Docker:**
- Install [file-transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) (recommended)
- Or map the index.html file manually

## Next Steps

- [Explore Features](features.md)
- [Read FAQ](faq.md)
- Configure settings via the Jellyfin Enhanced panel