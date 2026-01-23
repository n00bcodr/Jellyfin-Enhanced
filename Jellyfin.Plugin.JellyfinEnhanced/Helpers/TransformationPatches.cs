using System;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    public static class TransformationPatches
    {
        public static string IndexHtml(PatchRequestPayload content)
        {
            if (string.IsNullOrEmpty(content.Contents))
            {
                return content.Contents ?? string.Empty;
            }

            var pluginName = "Jellyfin Enhanced";
            var pluginVersion = JellyfinEnhanced.Instance?.Version.ToString() ?? "unknown";

            var scriptUrl = "../JellyfinEnhanced/script";
            var scriptTag = $"<script plugin=\"{pluginName}\" version=\"{pluginVersion}\" src=\"{scriptUrl}\" defer></script>";

            var regex = new Regex($"<script[^>]*plugin=[\"']{pluginName}[\"'][^>]*>\\s*</script>\\n?");
            var updatedContent = regex.Replace(content.Contents, string.Empty);

            // 3. Inject the new script tag.
            if (updatedContent.Contains("</body>"))
            {
                return updatedContent.Replace("</body>", $"{scriptTag}\n</body>");
            }

            return updatedContent;
        }

        public static Task IconTransparent(string path, Stream contents) => ReplaceImageAsync(path, "icon-transparent.png", contents);

        public static Task BannerLight(string path, Stream contents) => ReplaceImageAsync(path, "banner-light.png", contents);

        public static Task BannerDark(string path, Stream contents) => ReplaceImageAsync(path, "banner-dark.png", contents);

        public static Task Favicon(string path, Stream contents) => ReplaceImageAsync(path, "favicon.ico", contents);

        public static Task AppleIcon(string path, Stream contents) => ReplaceImageAsync(path, "apple-touch-icon.png", contents);

        public static Task AppleIcon144(string path, Stream contents) => ReplaceImageAsync(path, "apple-touch-icon-144.png", contents);

        private static async Task ReplaceImageAsync(string requestPath, string fileName, Stream stream)
        {
            if (stream == null)
            {
                return;
            }

            if (!TryGetCustomImageBytes(fileName, out var bytes))
            {
                // File not found is normal - custom image may not be uploaded yet
                return;
            }

            try
            {
                stream.SetLength(0);
                stream.Seek(0, SeekOrigin.Begin);
                await stream.WriteAsync(bytes, 0, bytes.Length).ConfigureAwait(false);
                stream.Seek(0, SeekOrigin.Begin);
            }
            catch (Exception ex)
            {
                // Log error but don't crash the transformation pipeline
                System.Diagnostics.Debug.WriteLine($"Error replacing image for {requestPath}: {ex.Message}");
            }
        }

        private static bool TryGetCustomImageBytes(string fileName, out byte[] bytes)
        {
            bytes = Array.Empty<byte>();

            try
            {
                var brandingDirectory = JellyfinEnhanced.BrandingDirectory;
                if (string.IsNullOrWhiteSpace(brandingDirectory))
                {
                    return false;
                }

                var filePath = Path.Combine(brandingDirectory, fileName);

                if (!File.Exists(filePath))
                {
                    return false;
                }

                bytes = File.ReadAllBytes(filePath);
                return bytes.Length > 0;
            }
            catch (Exception ex)
            {
                // Silently fail - file not found is expected when no custom image is uploaded
                System.Diagnostics.Debug.WriteLine($"Error reading branding image {fileName}: {ex.Message}");
                return false;
            }
        }
    }
}