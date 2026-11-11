using System;
using System.IO;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Platform.Services
{
    /// <summary>
    /// The splash screen's stock image. Its stored default, /web/assets/img/banner-light.png, is where older web
    /// clients kept the banner; Jellyfin 12's web client ships it only under a content-hashed name at its root
    /// (banner-light.&lt;hash&gt;.png). That default is answered with the banner the hosted web client really has,
    /// found in its folder; an administrator's own image is never changed.
    /// </summary>
    internal static class SplashImage
    {
        internal const string StoredDefault = "/web/assets/img/banner-light.png";

        // The web client's files change only with a Jellyfin upgrade, which restarts the server.
        private static (string WebPath, string Url)? _found;

        internal static string Resolve(string configured, string? webPath)
        {
            if (!string.Equals(configured, StoredDefault, StringComparison.Ordinal) || string.IsNullOrEmpty(webPath))
            {
                return configured;
            }

            if (_found is { } found && found.WebPath == webPath)
            {
                return found.Url;
            }

            var url = configured;
            try
            {
                if (!File.Exists(Path.Combine(webPath, "assets", "img", "banner-light.png")))
                {
                    var banner = Directory.EnumerateFiles(webPath, "banner-light.*.png").Select(Path.GetFileName).Order(StringComparer.Ordinal).FirstOrDefault();
                    if (banner != null)
                    {
                        url = "/web/" + Uri.EscapeDataString(banner);
                    }
                }
            }
            catch (Exception)
            {
                // No web client folder to read (hosted elsewhere, no access): keep the stored value.
            }

            _found = (webPath, url);
            return url;
        }
    }
}
