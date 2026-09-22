# Branding image regression checks

Run the dependency-free checks with the .NET 10 SDK:

```sh
dotnet run --project tests/BrandingImageContentType
```

They cover SVG stored under all five fixed branding filenames, XML declarations,
comments, BOMs, external DTDs, malformed XML, non-SVG documents, and the existing
PNG/ICO fallback. Detection must preserve bytes and release the file handle.

## Browser reproduction

Tested with LinuxServer Jellyfin `12.1ubu2604-ls50` (server/web 12.1.0),
Jellyfin Enhanced 12.8.0.0, File Transformation 3.0.1.0, and Chromium.
Use a disposable server with no custom theme or branding.

1. Save the following as `logo.svg`:

   ```xml
   <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="orange"/></svg>
   ```

2. Upload it as **Icon Transparent** in Enhanced's branding settings.
3. Clear the browser cache and open the dashboard.
4. Inspect the `icon-transparent.<hash>.png` request and the dashboard image's
   `naturalWidth`. Before the fix, upload succeeds but the response has
   `Content-Type: image/png` and `naturalWidth` is zero.
5. Install the fixed plugin and restart Jellyfin, keeping the existing upload.
   The same URL now returns `image/svg+xml`, and the orange icon renders with
   `naturalWidth` 64. The branding settings preview also renders.
6. Replace the upload with a PNG, then delete it. The replacement should render;
   deletion should restore Jellyfin's stock icon. Custom asset requests retain
   `Cache-Control: no-cache`, HEAD responses have no body, and an unchanged ETag
   produces a 304 response.
7. Upload the SVG as **Banner Light** and verify the dark theme's
   `.pageTitleWithLogo` background image after clearing the cache. This uses a
   separate banner URL, so an Icon Transparent upload does not replace it.

Both the official and LinuxServer 12.1 builds use an `img` for the dashboard icon
and a CSS background image for the legacy page header. PNG branding worked
before this change, including with File Transformation installed. This change
addresses the SVG MIME mismatch in both image-serving paths.
