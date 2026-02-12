# Installation Guide

## Prerequisites

- Jellyfin server version 10.11.x
- Admin access to your Jellyfin server
- Modern web browser (Chrome, Firefox, Edge, Safari)

## Standard Installation

### Step 1: Add Plugin Repository

1. In Jellyfin, navigate to **Dashboard** → **Plugins** → **Catalog** → ⚙️ (Settings icon)
2. Click **➕** (Add button) to add a new repository
3. Give the repository a name (e.g., "Jellyfin Enhanced")
4. Set the **Repository URL** to:

```
https://raw.githubusercontent.com/n00bcodr/jellyfin-plugins/main/10.11/manifest.json
```

5. Click **Save**

### Step 2: Install Plugin

1. Go to the **Catalog** tab
2. Find **Jellyfin Enhanced** in the plugin list
3. Click **Install**
4. Wait for the installation to complete

### Step 3: Restart Server

1. **Restart** your Jellyfin server to complete the installation
2. This is required for the plugin to activate

### Step 4: Verify Installation

After restart:

1. Refresh your browser (Ctrl+F5 or Cmd+Shift+R)
2. Look for **Jellyfin Enhanced** menu item in the sidebar
3. Click it or press `?` to open the settings panel
4. If you see the panel, installation was successful!

## Recommended: Install File Transformation Plugin

> **IMPORTANT:** It is highly recommended to install the [file-transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) to avoid permission issues when modifying Jellyfin's web interface.

### Why File Transformation?

The file-transformation plugin helps avoid permission issues while modifying `index.html` on any kind of installation (Docker, Windows, Linux). Without it, you may encounter permission errors.

### How to Install

1. In the **Catalog** tab, search for "file-transformation"
2. Install the **File Transformation** plugin
3. Restart your Jellyfin server
4. Then install Jellyfin Enhanced normally

## Docker Installation

### Recommended Method (with file-transformation)

If you're running Jellyfin through Docker, install the file-transformation plugin first (see above), then install Jellyfin Enhanced normally.

### Manual Method (NOT RECOMMENDED)

If you cannot use file-transformation and see permission errors like:

```
System.UnauthorizedAccessException: Access to the path '/jellyfin/jellyfin-web/index.html' is denied.
```

You'll need to manually map the `index.html` file:

1. Copy the index.html file from your container:

```bash
docker cp jellyfin:/jellyfin/jellyfin-web/index.html /path/to/your/jellyfin/config/index.html
```

2. Add volume mapping to your Docker run command:

```bash
-v /path/to/your/jellyfin/config/index.html:/jellyfin/jellyfin-web/index.html
```

3. Or for Docker Compose, add to volumes section:

```yaml
services:
  jellyfin:
    volumes:
      - /path/to/your/jellyfin/config:/config
      - /path/to/your/jellyfin/config/index.html:/jellyfin/jellyfin-web/index.html
```

## Platform-Specific Notes

### Windows

If you see permission denied errors:

1. Navigate to your Jellyfin installation folder (usually `C:\Program Files\Jellyfin\Server`)
2. Right-click the folder → Properties → Security
3. Grant "NETWORK SERVICE" **Read** and **Write** permissions
4. Apply to all subfolders and files
5. Restart Jellyfin service

### Linux

If you encounter permission issues:

```bash
sudo chown -R jellyfin:jellyfin /usr/lib/jellyfin/
sudo chmod -R 755 /usr/lib/jellyfin/
```

## Troubleshooting Installation

### Plugin Not Appearing After Installation

**Check Installation Status:**
1. Go to **Dashboard** → **Plugins** → **My Plugins**
2. Verify "Jellyfin Enhanced" is listed
3. Check that it's enabled (not disabled)

**Run Startup Task:**
1. Go to **Dashboard** → **Scheduled Tasks**
2. Find "Jellyfin Enhanced Startup" task
3. Click **Run** to execute it manually
4. Refresh your browser (Ctrl+F5)

**Clear Browser Cache:**
1. Press Ctrl+Shift+Delete (Windows/Linux) or Cmd+Shift+Delete (Mac)
2. Select "Cached images and files"
3. Clear cache
4. Refresh the page

**Restart Server:**
1. Go to **Dashboard** → **Advanced** → **Restart**
2. Wait for server to fully restart
3. Refresh browser

### Permission Errors in Logs

If you see errors like:

```
Access to the path '/jellyfin/jellyfin-web/index.html' is denied.
```

**Solution:**
- Install [file-transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) (recommended)
- Or follow platform-specific permission fixes above

### Scripts Not Loading

**Check Scheduled Task:**
1. **Dashboard** → **Scheduled Tasks**
2. Look for "Jellyfin Enhanced Startup"
3. Verify it has a trigger for "On application startup"
4. If missing, add the trigger manually

**Check Browser Console:**
1. Press F12 to open developer tools
2. Go to Console tab
3. Look for errors mentioning "Jellyfin Enhanced"
4. Report errors on GitHub if found

### Update Not Working

**Clean Update Process:**
1. Go to **Dashboard** → **Plugins** → **My Plugins**
2. Find Jellyfin Enhanced
3. Click **Uninstall**
4. Restart server
5. Reinstall from Catalog
6. Restart server again
7. Clear browser cache (Ctrl+F5)

## Verification Checklist

After installation, verify these work:

- [ ] Plugin menu item appears in sidebar
- [ ] Pressing `?` opens the settings panel
- [ ] Keyboard shortcuts work
- [ ] Tags appear on media posters (if enabled)
- [ ] No errors in browser console (F12)
- [ ] No errors in server logs

## Getting Help

If you encounter issues:

1. Check the [FAQ](faq.md) for common solutions
2. Search [GitHub Issues](https://github.com/n00bcodr/Jellyfin-Enhanced/issues)
3. Join the [Discord Community](https://discord.gg/HKA2QNYJ6)
4. Create a new issue with logs and details