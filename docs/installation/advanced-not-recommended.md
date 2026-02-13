# Advanced Installation Methods

## Manual Installation for Docker

<!-- use a custom title -->
!!! warning "Warning"
    
    This method is not recommended. The recommended method for Docker:

    1. Install as a standard [Jellyfin Plugin](./standard-recommended.md)
    2. Use the [File Transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation)


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