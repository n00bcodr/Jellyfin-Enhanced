## Installation troubleshooting

### Plugin Not Appearing After Installation

**Check Installation Status:**

1. Go to `Dashboard` → `Plugins`
2. Verify `Jellyfin Enhanced` is listed under `Installed`
3. Check that it's enabled (not disabled)

**Run Startup Task:**

1. Go to `Dashboard` → `Scheduled Tasks`
2. Under `Jellyfin Enhanced`, find the task: `Jellyfin Enhanced Startup`
3. Execute the task manually *(click the button: `▶︎`)*
4. Refresh your browser ++ctrl+f5++

**Clear Browser Cache:**

1. Open menu: 
  * Windows/Linux: ++ctrl+shift+delete++
  * MacOS: ++command+shift+delete++
2. Select "Cached images and files" *(or similar)*
3. Clear cache
4. Refresh browser

**Restart Server:**

1. In Jellyfin, go to: `Dashboard` → `Restart`
2. Wait for server to fully restart
3. Refresh browser

### Permission Errors in Logs

If you see errors like this:

```text
Access to the path '/jellyfin/jellyfin-web/index.html' is denied.
```

**Solution:**

- Install [file-transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) *(recommended)*

- Or, try [platform-specific permission fixes](#platform-specific-issues)

### Scripts Not Loading

**Check Scheduled Task:**

1. Jellyfin: `Dashboard` → `Scheduled Tasks`
2. Look for the tasks under `Jellyfin Enhanced` — mainly `Jellyfin Enhanced Startup`
3. `Jellyfin Enhanced Startup` should have the trigger: `On application startup`
4. If missing, add the trigger manually

**Check Browser Console:**

1. Press ++f12++ to open developer tools
2. Go to `Console` tab
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
7. Clear browser cache ++ctrl+f5++


## Platform-Specific Issues

### Docker

#### Permission issues 

Example of a common error:

```text title="Bash"
System.UnauthorizedAccessException: Access to the path '/jellyfin/jellyfin-web/index.html' is denied.
```

If you are **^^not^^ using the [file-transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) plugin**, you'll need to manually map the `index.html` file 

1. Copy the `index.html` file from your container:
  ```bash title="Bash"
  docker cp jellyfin:/jellyfin/jellyfin-web/index.html /path/to/your/jellyfin/config/index.html
  ```

2. Add volume mapping:
  ```bash title="Docker Run"
  -v /path/to/your/jellyfin/config/index.html:/jellyfin/jellyfin-web/index.html
  ```
  or...
  ```yaml title="Docker Compose"
  services:
    jellyfin:
      volumes:
        # volume mapping
        - /path/to/your/jellyfin/config:/config
        - /path/to/your/jellyfin/config/index.html:/jellyfin/jellyfin-web/index.html
  ```

<!-- use a custom title -->
!!! warning "Warning"

    This method is not recommended and won't survive a `jellyfin-web` upgrade. The recommended method for Docker:

    1. Install the [File Transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation)
    2. Follow the standard installation process

### Windows

**Permission denied errors / permission issues**

Known solution: 

1. Navigate to your Jellyfin installation folder (usually `C:\Program Files\Jellyfin\Server`)
2. Right-click the folder → `Properties` → `Security`
3. Grant `NETWORK SERVICE` **Read** and **Write** permissions
4. Apply to all subfolders and files
5. Restart Jellyfin service

### Linux

**Permission issues**

Known solution:

```bash title="Bash"
sudo chown -R jellyfin:jellyfin /usr/lib/jellyfin/
sudo chmod -R 755 /usr/lib/jellyfin/
```


## Getting Help

If you encounter issues:

1. Check the [FAQ](../faq-support/faq) for common solutions
2. [GitHub Issues](https://github.com/n00bcodr/Jellyfin-Enhanced/issues)
    - Search existing issues
    - Create a new issue *(please include log and details)*
3. Join the [Discord Community](https://discord.gg/8wk3q74s)