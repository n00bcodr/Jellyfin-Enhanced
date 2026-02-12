# Troubleshooting Installation

## Plugin Not Appearing After Installation

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

## Permission Errors in Logs

If you see errors like:

```
Access to the path '/jellyfin/jellyfin-web/index.html' is denied.
```

**Solution:**
- Install [file-transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) (recommended)
- Or follow platform-specific permission fixes above

## Scripts Not Loading

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

## Update Not Working

**Clean Update Process:**
1. Go to **Dashboard** → **Plugins** → **My Plugins**
2. Find Jellyfin Enhanced
3. Click **Uninstall**
4. Restart server
5. Reinstall from Catalog
6. Restart server again
7. Clear browser cache (Ctrl+F5)

# Verification Checklist

After installation, verify these work:

- [ ] Plugin menu item appears in sidebar
- [ ] Pressing `?` opens the settings panel
- [ ] Keyboard shortcuts work
- [ ] Tags appear on media posters (if enabled)
- [ ] No errors in browser console (F12)
- [ ] No errors in server logs

# Getting Help

If you encounter issues:

1. Check the [FAQ](faq.md) for common solutions
2. Search [GitHub Issues](https://github.com/n00bcodr/Jellyfin-Enhanced/issues)
3. Join the [Discord Community](https://discord.gg/HKA2QNYJ6)
4. Create a new issue with logs and details


# Platform-Specific Issues

## Windows

If you see permission denied errors:

1. Navigate to your Jellyfin installation folder (usually `C:\Program Files\Jellyfin\Server`)
2. Right-click the folder → Properties → Security
3. Grant "NETWORK SERVICE" **Read** and **Write** permissions
4. Apply to all subfolders and files
5. Restart Jellyfin service

## Linux

If you encounter permission issues, this is a known solution 

Bash:

```bash
sudo chown -R jellyfin:jellyfin /usr/lib/jellyfin/
sudo chmod -R 755 /usr/lib/jellyfin/
```