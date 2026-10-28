using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache
{
    /// <summary>The server-side cache settings as one snapshot (see <see cref="ServerBlobCache"/>).</summary>
    /// <param name="Enabled">Whether entries are read from and written to disk.</param>
    /// <param name="Folder">The configured folder; empty means the default folder in the plugin's data folder.</param>
    /// <param name="MaxBytes">Size cap in bytes; 0 = unlimited.</param>
    /// <param name="MaxAgeDays">Days an entry is kept after it was fetched; 0 = no age limit.</param>
    public sealed record ServerCacheSettings(bool Enabled, string Folder, long MaxBytes, int MaxAgeDays)
    {
        /// <summary>Highest size cap accepted, in GB.</summary>
        public const int MaxSizeGbLimit = 10000;

        /// <summary>Highest age limit accepted, in days.</summary>
        public const int MaxAgeDaysLimit = 3650;

        /// <summary>The settings of <paramref name="config"/> (null: off).</summary>
        /// <param name="config">The plugin configuration.</param>
        /// <returns>The snapshot.</returns>
        public static ServerCacheSettings From(PluginConfiguration? config)
        {
            if (config == null) return new ServerCacheSettings(false, string.Empty, 0, 0);
            var gb = double.IsFinite(config.ServerCacheMaxSizeGb) ? Math.Clamp(config.ServerCacheMaxSizeGb, 0, MaxSizeGbLimit) : 0;
            return new ServerCacheSettings(config.ServerCacheEnabled, (config.ServerCachePath ?? string.Empty).Trim(),
                (long)(gb * 1024 * 1024 * 1024), Math.Clamp(config.ServerCacheMaxAgeDays, 0, MaxAgeDaysLimit));
        }
    }

    /// <summary>
    /// Where the server-side cache may live: an absolute folder that is not inside (and does not contain)
    /// Jellyfin's own data, metadata, cache, log, configuration, program or plugin folders, judged by its path as
    /// written and by its real path (every link resolved). The plugin's own data folder is allowed (the default
    /// lives there), and so is a folder inside Jellyfin's cache folder (never the cache folder itself, nor one of
    /// Jellyfin's own folders in it), the recommended place for a large cache. Wherever it is, the folder must be
    /// the cache's own: new, empty, or holding the cache's <see cref="MarkerName"/> file.
    /// </summary>
    public sealed class ServerCacheLocation
    {
        /// <summary>The file that marks a folder as the server-side cache's (kept fresh by the sweeps).</summary>
        public const string MarkerName = ".je-server-cache";

        /// <summary>The marker's exact contents (a file of that name with anything else doesn't count).</summary>
        public const string MarkerText = "Jellyfin Enhanced server-side cache (format 2). Its files can be deleted at any time.\n";

        // Folder names compare as the file system does (case-insensitively on Windows).
        private static readonly StringComparison PathComparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        private static readonly StringComparer PathComparer = OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;

        // Jellyfin's own folders inside its cache folder, refused there by name as well as by the list it was given.
        private static readonly HashSet<string> JellyfinCacheFolders = new(StringComparer.OrdinalIgnoreCase)
        {
            "temp", "transcodes", "images", "imagesbyname", "omdb", "fontconfig", "attachments", "subtitles", "audiocache", "extracted-attachments",
        };

        private readonly string _ownDataFolder;
        private readonly string? _cacheFolder;
        private readonly IReadOnlyList<string> _forbidden;

        /// <summary>Creates the rules.</summary>
        /// <param name="ownDataFolder">The plugin's data folder (allowed, and home of the default folder).</param>
        /// <param name="forbidden">Jellyfin's own folders.</param>
        /// <param name="cacheFolder">Jellyfin's cache folder, under which a dedicated folder is allowed (null: none).</param>
        public ServerCacheLocation(string ownDataFolder, IEnumerable<string?> forbidden, string? cacheFolder = null)
        {
            _ownDataFolder = Normalize(ownDataFolder);
            _cacheFolder = string.IsNullOrWhiteSpace(cacheFolder) || !Path.IsPathFullyQualified(cacheFolder) ? null : Normalize(cacheFolder);
            var given = forbidden.Where(f => !string.IsNullOrWhiteSpace(f) && Path.IsPathFullyQualified(f!)).Select(f => Normalize(f!)).ToList();
            if (_cacheFolder != null) given.Add(_cacheFolder);
            // Each of Jellyfin's folders both as configured and as it really is (a link to it is just as much it).
            _forbidden = given.Concat(given.Select(f => TryReal(f) ?? f)).Distinct(PathComparer).ToList();
        }

        /// <summary>The default folder (<c>server-cache</c> in the plugin's data folder).</summary>
        public string DefaultFolder => Path.Combine(_ownDataFolder, ServerBlobCache.DefaultFolderName);

        /// <summary>Resolves a configured folder (empty: the default) or says why it can't be used. Creates nothing.</summary>
        /// <param name="configured">The setting's value.</param>
        /// <param name="full">The folder's real path (every link resolved), which is what the cache uses.</param>
        /// <returns>Null when allowed, else a message for the admin.</returns>
        public string? Resolve(string? configured, out string full)
        {
            full = string.Empty;
            var value = (configured ?? string.Empty).Trim();
            string normalized;
            if (value.Length == 0)
            {
                normalized = DefaultFolder;
            }
            else
            {
                if (value.IndexOfAny(Path.GetInvalidPathChars()) >= 0 || value.Contains('\0', StringComparison.Ordinal))
                    return "The folder contains characters that aren't allowed in a path.";
                if (!Path.IsPathFullyQualified(value)) return "Use a full path, for example /srv/jellyfin-enhanced-cache.";
                try
                {
                    normalized = Normalize(value);
                }
                catch (Exception)
                {
                    return "The folder isn't a valid path.";
                }
            }

            if (TryReal(normalized) is not { } real) return "The folder isn't a valid path.";
            // Both the path as written and where it really leads must be allowed.
            var error = Check(normalized) ?? Check(real);
            if (error != null) return error;
            full = real;
            return null;
        }

        private string? Check(string path)
        {
            var own = TryReal(_ownDataFolder) ?? _ownDataFolder;
            foreach (var data in new[] { _ownDataFolder, own })
            {
                if (!Inside(path, data)) continue;
                // The data folder itself would mix the cache with the plugin's own files.
                return string.Equals(path, data, PathComparison) ? "Pick a folder inside the plugin's data folder, not the data folder itself." : null;
            }

            if (Path.GetPathRoot(path) is { } root && string.Equals(Normalize(root), path, PathComparison))
                return "Pick a folder, not the root of a drive.";
            if (_cacheFolder != null && (string.Equals(path, _cacheFolder, PathComparison) || string.Equals(path, TryReal(_cacheFolder), PathComparison)))
                return "Not Jellyfin's cache folder itself: pick a folder inside it, such as " + Path.Combine(_cacheFolder, "jellyfin-enhanced") + ".";
            var cache = InCache(path);
            if (cache != null)
            {
                var first = path.Substring(cache.Length).TrimStart(Path.DirectorySeparatorChar).Split(Path.DirectorySeparatorChar)[0];
                if (JellyfinCacheFolders.Contains(first)) return "That is one of Jellyfin's own folders in its cache folder (" + Path.Combine(cache, first) + "). Pick a new folder there, such as " + Path.Combine(cache, "jellyfin-enhanced") + ".";
            }

            // Name the closest of Jellyfin's folders it is in or holds. In a dedicated folder of the cache folder,
            // the cache folder and the folders holding it don't count; Jellyfin's folders inside it still do.
            var clash = _forbidden
                .Where(f => cache == null || !Inside(cache, f))
                .Where(f => Inside(path, f) || Inside(f, path)).OrderByDescending(f => f.Length).FirstOrDefault();
            return clash == null ? null : "That folder is (or holds) one of Jellyfin's own folders (" + clash + "). Pick a separate folder.";
        }

        /// <summary>The cache folder (as configured or real) that <paramref name="path"/> is strictly inside, if any.</summary>
        private string? InCache(string path)
        {
            if (_cacheFolder == null) return null;
            foreach (var cache in new[] { _cacheFolder, TryReal(_cacheFolder) ?? _cacheFolder })
            {
                if (Inside(path, cache) && !string.Equals(path, cache, PathComparison)) return cache;
            }

            return null;
        }

        /// <summary>
        /// Gets a resolved folder ready, through the confined access only (the folder is created and checked without
        /// following a link at any step): a folder that holds anything must already be the cache's (its marker is a
        /// regular file with the marker's text); an empty or new one is marked as the cache's; a file must be writable.
        /// The checks and the marker go through one handle on the folder, and the folder's path must still lead to a
        /// folder that is the cache's afterwards, so a folder moved in under the path meanwhile is never claimed.
        /// </summary>
        /// <param name="folder">A folder from <see cref="Resolve"/>.</param>
        /// <param name="supported">False acts as a platform without the confined calls (tests).</param>
        /// <returns>Null when ready, else a message for the admin.</returns>
        public string? Prepare(string folder, bool supported = true)
        {
            const string CantCreate = "Jellyfin can't create that folder (or it is a link).";
            const string CantWrite = "Jellyfin can't write to that folder.";
            if (CacheFolderAccess.For(folder, supported) is not { } access) return Unsupported;
            if (!access.EnsureRoot()) return CantCreate;
            var error = access.WithFolder<string?>(CantCreate, cache =>
            {
                if (!cache.HasMarker())
                {
                    if (cache.IsEmpty() is not { } empty) return "Jellyfin can't read that folder.";
                    if (!empty) return "That folder already holds other files. The cache needs a folder of its own: pick a new or empty one.";
                    // Another preparation may have marked it a moment ago (its marker is then there and verified).
                    if (!cache.CreateMarker() && !cache.HasMarker()) return CantWrite;
                }

                return cache.Writable() ? null : CantWrite;
            });
            if (error != null) return error;
            return access.Owned(false, _ => true) ? null : "That folder changed while Jellyfin was getting it ready. Check it holds nothing else, then save again.";
        }

        /// <summary>Why the cache can't run on this platform.</summary>
        public const string Unsupported = "The server-side cache needs Jellyfin running on Linux (x64, x86, Arm or Arm64), where its folder can be kept confined.";

        /// <summary>True when <paramref name="path"/> is <paramref name="folder"/> or inside it.</summary>
        internal static bool Inside(string path, string folder)
            => string.Equals(path, folder, PathComparison)
               || path.StartsWith(folder.EndsWith(Path.DirectorySeparatorChar) ? folder : folder + Path.DirectorySeparatorChar, PathComparison);

        private static string? TryReal(string path)
        {
            try
            {
                return CacheFolderAccess.RealPath(path);
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static string Normalize(string path)
        {
            var full = Path.GetFullPath(path);
            var root = Path.GetPathRoot(full) ?? string.Empty;
            return full.Length > root.Length ? full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) : full;
        }
    }
}
