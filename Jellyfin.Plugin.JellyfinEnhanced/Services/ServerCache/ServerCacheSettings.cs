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
    /// Jellyfin's own data, metadata, cache, log, configuration, program or plugin folders. The plugin's
    /// own data folder is always allowed (the default lives there).
    /// </summary>
    public sealed class ServerCacheLocation
    {
        // Folder names compare as the file system does (case-insensitively on Windows).
        private static readonly StringComparison PathComparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

        private readonly string _ownDataFolder;
        private readonly IReadOnlyList<string> _forbidden;

        /// <summary>Creates the rules.</summary>
        /// <param name="ownDataFolder">The plugin's data folder (allowed, and home of the default folder).</param>
        /// <param name="forbidden">Jellyfin's own folders.</param>
        public ServerCacheLocation(string ownDataFolder, IEnumerable<string?> forbidden)
        {
            _ownDataFolder = Normalize(ownDataFolder);
            _forbidden = forbidden.Where(f => !string.IsNullOrWhiteSpace(f) && Path.IsPathFullyQualified(f!))
                .Select(f => Normalize(f!)).Distinct(OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal).ToList();
        }

        /// <summary>The default folder (<c>server-cache</c> in the plugin's data folder).</summary>
        public string DefaultFolder => Path.Combine(_ownDataFolder, ServerBlobCache.DefaultFolderName);

        /// <summary>Resolves a configured folder (empty: the default) or says why it can't be used.</summary>
        /// <param name="configured">The setting's value.</param>
        /// <param name="full">The normalized absolute folder.</param>
        /// <returns>Null when allowed, else a message for the admin.</returns>
        public string? Resolve(string? configured, out string full)
        {
            full = string.Empty;
            var value = (configured ?? string.Empty).Trim();
            if (value.Length == 0)
            {
                full = DefaultFolder;
                return null;
            }

            if (value.IndexOfAny(Path.GetInvalidPathChars()) >= 0 || value.Contains('\0', StringComparison.Ordinal))
                return "The folder contains characters that aren't allowed in a path.";
            if (!Path.IsPathFullyQualified(value)) return "Use a full path, for example /srv/jellyfin-enhanced-cache.";
            string normalized;
            try
            {
                normalized = Normalize(value);
            }
            catch (Exception)
            {
                return "The folder isn't a valid path.";
            }

            if (Inside(normalized, _ownDataFolder))
            {
                // The data folder itself would mix the cache with the plugin's own files.
                if (string.Equals(normalized, _ownDataFolder, PathComparison)) return "Pick a folder inside the plugin's data folder, not the data folder itself.";
                full = normalized;
                return null;
            }

            if (Path.GetPathRoot(normalized) is { } root && string.Equals(Normalize(root), normalized, PathComparison))
                return "Pick a folder, not the root of a drive.";
            // Name the closest of Jellyfin's folders it is in or holds.
            var clash = _forbidden.Where(f => Inside(normalized, f) || Inside(f, normalized)).OrderByDescending(f => f.Length).FirstOrDefault();
            if (clash != null) return "That folder is (or holds) one of Jellyfin's own folders (" + clash + "). Pick a separate folder.";

            full = normalized;
            return null;
        }

        /// <summary>
        /// Creates <paramref name="folder"/> when missing and checks a file can be written to it.
        /// </summary>
        /// <param name="folder">A resolved folder.</param>
        /// <returns>Null when writable, else a message for the admin.</returns>
        public static string? CheckWritable(string folder)
        {
            try
            {
                Directory.CreateDirectory(folder);
                var probe = Path.Combine(folder, ".je-write-check-" + Guid.NewGuid().ToString("N") + ".tmp");
                using (new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose))
                {
                }

                return null;
            }
            catch (UnauthorizedAccessException)
            {
                return "Jellyfin can't write to that folder (permission denied).";
            }
            catch (Exception)
            {
                return "Jellyfin can't create or write to that folder.";
            }
        }

        /// <summary>True when <paramref name="path"/> is <paramref name="folder"/> or inside it.</summary>
        internal static bool Inside(string path, string folder)
            => string.Equals(path, folder, PathComparison)
               || path.StartsWith(folder.EndsWith(Path.DirectorySeparatorChar) ? folder : folder + Path.DirectorySeparatorChar, PathComparison);

        private static string Normalize(string path)
        {
            var full = Path.GetFullPath(path);
            var root = Path.GetPathRoot(full) ?? string.Empty;
            return full.Length > root.Length ? full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) : full;
        }
    }
}
