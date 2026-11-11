using System;
using System.IO;
using System.Security.Cryptography;
using System.Threading;
using MediaBrowser.Common.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Persistence
{
    // The plugin's server secret: 32 random bytes in the plugin's data directory,
    // created atomically with owner-only permissions on first use (instances
    // sharing the directory serialize creation through "<key file>.lock").
    // Native poster tag tokens and Spoiler Guard's per-user image markers are
    // HMACs under it. Losing it only changes those image URLs; it grants
    // nothing else.
    public sealed class PluginSecretFile
    {
        /// <summary>The key file. Native poster tags created it first, so installs already hold their secret under this name.</summary>
        public const string SecretFileName = "native-poster-tags.key";

        private const int SecretLength = 32;

        private readonly string _secretPath;
        private readonly Action<string> _warn;
        private readonly object _secretLock = new();
        private volatile byte[]? _secret;

        public PluginSecretFile(string secretPath, Action<string> warn)
        {
            _secretPath = secretPath;
            _warn = warn;
        }

        /// <summary>Where the plugin keeps its secret.</summary>
        public static string DefaultPath(IApplicationPaths applicationPaths)
            => Path.Combine(applicationPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced", SecretFileName);

        /// <summary>Runs after the first existence check, before the create lock (lets tests force a create race).</summary>
        internal Action? BeforeSecretWriteForTest { get; set; }

        /// <summary>The secret, read or created on first use.</summary>
        public byte[] Get()
        {
            var secret = _secret;
            if (secret != null) return secret;
            lock (_secretLock)
            {
                return _secret ??= LoadOrCreateSecret();
            }
        }

        private byte[] LoadOrCreateSecret()
        {
            try
            {
                var existing = TryReadSecret();
                if (existing != null) return existing;

                BeforeSecretWriteForTest?.Invoke();
                // Creating is serialized through an exclusive lock file, and the
                // secret is re-read under it: another JE instance sharing the config
                // dir may have created it since the check above and already minted
                // URLs with it, so a valid secret is never replaced. (File.Move
                // without overwrite cannot guarantee that: on Unix it checks the
                // destination and then renames.)
                using (AcquireCreateLock())
                {
                    existing = TryReadSecret();
                    if (existing != null) return existing;

                    if (File.Exists(_secretPath))
                    {
                        _warn($"Native poster tags: {SecretFileName} has an unexpected length; replacing it (issued poster URLs fall back to original artwork until clients refresh).");
                    }

                    var fresh = RandomNumberGenerator.GetBytes(SecretLength);
                    WriteSecretAtomically(fresh);
                    return fresh;
                }
            }
            catch (Exception ex)
            {
                // Unwritable config dir: keep working with a process-lifetime
                // secret. Poster URLs then change on every restart, nothing else.
                _warn($"Native poster tags: could not persist the token secret ({ex.Message}); using an in-memory secret until restart.");
                return RandomNumberGenerator.GetBytes(SecretLength);
            }
        }

        /// <summary>The persisted secret, or null when it is missing or has the wrong length.</summary>
        private byte[]? TryReadSecret()
        {
            if (!File.Exists(_secretPath)) return null;
            var existing = File.ReadAllBytes(_secretPath);
            if (existing.Length != SecretLength) return null;
            TightenPermissions(_secretPath);
            return existing;
        }

        // Exclusive across processes as well (FileShare.None takes an flock on
        // Unix). The lock file is left in place: deleting it while another
        // instance waits on it would let two creators hold "the" lock.
        private FileStream AcquireCreateLock()
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_secretPath)!);
            var options = new FileStreamOptions { Mode = FileMode.OpenOrCreate, Access = FileAccess.ReadWrite, Share = FileShare.None };
            if (!OperatingSystem.IsWindows())
            {
                options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            }

            for (var attempt = 0; ; attempt++)
            {
                try
                {
                    return new FileStream(_secretPath + ".lock", options);
                }
                catch (IOException) when (attempt < 200)
                {
                    Thread.Sleep(25);
                }
            }
        }

        // Temp file created owner-only from the start (no window where the
        // secret is world-readable), flushed, then moved into place. Callers
        // hold the create lock.
        private void WriteSecretAtomically(byte[] secret)
        {
            var temp = _secretPath + ".tmp." + Guid.NewGuid().ToString("N");
            try
            {
                var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None };
                if (!OperatingSystem.IsWindows())
                {
                    options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
                }

                using (var stream = new FileStream(temp, options))
                {
                    stream.Write(secret, 0, secret.Length);
                    stream.Flush(true);
                }

                File.Move(temp, _secretPath, overwrite: true);
            }
            finally
            {
                try { if (File.Exists(temp)) File.Delete(temp); }
                catch (Exception) { /* best effort */ }
            }
        }

        private void TightenPermissions(string path)
        {
            if (OperatingSystem.IsWindows()) return;
            try
            {
                const UnixFileMode ownerOnly = UnixFileMode.UserRead | UnixFileMode.UserWrite;
                if ((File.GetUnixFileMode(path) & ~ownerOnly) != 0)
                {
                    File.SetUnixFileMode(path, ownerOnly);
                }
            }
            catch (Exception ex)
            {
                _warn($"Native poster tags: could not restrict permissions of {SecretFileName}: {ex.Message}");
            }
        }
    }
}
