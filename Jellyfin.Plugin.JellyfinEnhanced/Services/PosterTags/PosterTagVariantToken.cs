using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using MediaBrowser.Common.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags
{
    /// <summary>Bits carried in a variant token. They are covered by its MAC.</summary>
    [Flags]
    public enum PosterTagVariantFlags
    {
        /// <summary>No flags.</summary>
        None = 0,

        /// <summary>The card shows a played or unplayed-count indicator, so top-right tags move down (web rule).</summary>
        TopRightOffset = 1,

        /// <summary>
        /// The image owner was under the user's Spoiler Guard when the token was minted. The URL changes when
        /// Spoiler Guard is switched on or off for the item, and the image filter serves a URL carrying this
        /// bit no-store: what it draws depends on spoiler state the URL doesn't carry (prefs, strip toggles,
        /// watched state), so no client may keep it.
        /// </summary>
        SpoilerScoped = 2,
    }

    /// <summary>A parsed variant token.</summary>
    /// <param name="Flags">Flag bits.</param>
    /// <param name="DataHash">6 hex of the owner's tag data when minted, or <see cref="PosterTagVariantToken.WeakDataHash"/>.</param>
    /// <param name="Mac">16 hex of the HMAC.</param>
    public readonly record struct PosterTagVariant(PosterTagVariantFlags Flags, string DataHash, string Mac)
    {
        /// <summary>True when the token does not pin the tag data (server tag cache off or no entry yet).</summary>
        public bool IsWeak => string.Equals(DataHash, PosterTagVariantToken.WeakDataHash, StringComparison.Ordinal);
    }

    // The "-jet" segment native poster tags adds to a Primary image tag (see
    // ImageTagDecoration for where it sits). It is what turns an anonymous image
    // request into "draw THIS user's tags with THESE settings on THIS item":
    //
    //   {flags:1 hex}{dataHash:6 hex}{mac:16 hex}
    //   mac = HMAC-SHA256(secret, "jet1|user|item|settingsDigest|rendererVersion|flags|dataHash")[..8 bytes]
    //
    // Spoiler Guard's -jeu marker is deliberately unkeyed (forging it only
    // self-spoils). Tag data is different: without a keyed token anyone who
    // knows a user id and item ids could have that user's tag settings baked
    // into anonymous images. The MAC binds the user AND the item, so a token
    // can't be moved to another user or another item, and it binds the
    // settings digest and the pixel version (callers pass
    // PosterTagComposer.PixelVersion: renderer + composition versions; the
    // resolver version is inside the digest), so a settings change or a
    // drawing update makes old URLs fall back to original artwork until the
    // client refreshes metadata (no stale composites under a "current" URL).
    //
    // The secret is 32 random bytes in the plugin's data directory, created
    // atomically with owner-only permissions on first use. Losing it only
    // resets poster URLs; it grants nothing else.
    public sealed class PosterTagVariantToken
    {
        /// <summary>Data hash used when the tag data is not pinned (weak token).</summary>
        public const string WeakDataHash = "000000";

        /// <summary>Bumped when the token's meaning changes, to retire every issued URL.</summary>
        public const string TokenVersion = "jet1";

        private const int SecretLength = 32;
        private const int MacHexLength = 16;
        private const string SecretFileName = "native-poster-tags.key";

        private readonly string _secretPath;
        private readonly Action<string> _warn;
        private readonly object _secretLock = new();
        private volatile byte[]? _secret;

        public PosterTagVariantToken(IApplicationPaths applicationPaths, Logger logger)
            : this(Path.Combine(applicationPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced", SecretFileName), logger.Warning)
        {
        }

        private PosterTagVariantToken(string secretPath, Action<string> warn)
        {
            _secretPath = secretPath;
            _warn = warn;
        }

        /// <summary>An instance keeping its secret at <paramref name="secretPath"/> (test harness).</summary>
        public static PosterTagVariantToken CreateForPath(string secretPath, Action<string> warn) => new(secretPath, warn);

        /// <summary>Mints the token for one user, image owner and settings digest.</summary>
        public string Mint(Guid userId, Guid itemId, string settingsDigest, string rendererVersion, PosterTagVariantFlags flags, string dataHash)
        {
            if (!IsDataHash(dataHash)) throw new ArgumentException("Data hash must be 6 lowercase hex characters.", nameof(dataHash));
            var flagsHex = FlagsHex(flags);
            var mac = ComputeMac(GetSecret(), userId, itemId, settingsDigest, rendererVersion, flagsHex, dataHash);
            return flagsHex + dataHash + mac;
        }

        /// <summary>
        /// Checks a token against the CURRENT settings digest and renderer version for this user and item.
        /// Constant-time on the MAC.
        /// </summary>
        public bool Verify(string token, Guid userId, Guid itemId, string settingsDigest, string rendererVersion, out PosterTagVariant variant)
        {
            if (!TryParse(token, out variant)) return false;
            var expected = ComputeMac(GetSecret(), userId, itemId, settingsDigest, rendererVersion, token.Substring(0, 1), variant.DataHash);
            return CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(expected),
                Encoding.ASCII.GetBytes(variant.Mac));
        }

        /// <summary>Parses the fixed-width token shape without verifying it.</summary>
        public static bool TryParse(string? token, out PosterTagVariant variant)
        {
            variant = default;
            if (token == null || token.Length != ImageTagDecoration.VariantHexLength) return false;
            foreach (var c in token)
            {
                if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
            }

            var flags = (PosterTagVariantFlags)Convert.ToInt32(token.Substring(0, 1), 16);
            // Unknown bits come from a newer token format: never accept them.
            if ((flags & ~(PosterTagVariantFlags.TopRightOffset | PosterTagVariantFlags.SpoilerScoped)) != 0) return false;
            variant = new PosterTagVariant(flags, token.Substring(1, 6), token.Substring(7, MacHexLength));
            return true;
        }

        /// <summary>The MAC for the given inputs (pure; exposed for the test harness).</summary>
        public static string ComputeMac(byte[] secret, Guid userId, Guid itemId, string settingsDigest, string rendererVersion, string flagsHex, string dataHash)
        {
            var input = TokenVersion + "|" + userId.ToString("N") + "|" + itemId.ToString("N") + "|" + settingsDigest
                + "|" + rendererVersion + "|" + flagsHex + "|" + dataHash;
            var mac = HMACSHA256.HashData(secret, Encoding.UTF8.GetBytes(input));
            return Convert.ToHexString(mac, 0, MacHexLength / 2).ToLowerInvariant();
        }

        /// <summary>True for a 6-character lowercase hex data hash.</summary>
        public static bool IsDataHash(string? value)
        {
            if (value == null || value.Length != 6) return false;
            foreach (var c in value)
            {
                if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
            }

            return true;
        }

        /// <summary>The single hex digit for a flag set.</summary>
        public static string FlagsHex(PosterTagVariantFlags flags) => ((int)flags & 0xF).ToString("x1", System.Globalization.CultureInfo.InvariantCulture);

        private byte[] GetSecret()
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
                if (File.Exists(_secretPath))
                {
                    var existing = File.ReadAllBytes(_secretPath);
                    if (existing.Length == SecretLength)
                    {
                        TightenPermissions(_secretPath);
                        return existing;
                    }

                    _warn($"Native poster tags: {SecretFileName} has an unexpected length; replacing it (issued poster URLs fall back to original artwork until clients refresh).");
                }

                var fresh = RandomNumberGenerator.GetBytes(SecretLength);
                WriteSecretAtomically(fresh, overwrite: File.Exists(_secretPath));
                // Another JE instance sharing the config dir may have won the
                // create race; whatever is on disk now is the shared secret.
                var onDisk = File.ReadAllBytes(_secretPath);
                return onDisk.Length == SecretLength ? onDisk : fresh;
            }
            catch (Exception ex)
            {
                // Unwritable config dir: keep working with a process-lifetime
                // secret. Poster URLs then change on every restart, nothing else.
                _warn($"Native poster tags: could not persist the token secret ({ex.Message}); using an in-memory secret until restart.");
                return RandomNumberGenerator.GetBytes(SecretLength);
            }
        }

        // Temp file created owner-only from the start (no window where the
        // secret is world-readable), flushed, then moved into place.
        private void WriteSecretAtomically(byte[] secret, bool overwrite)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_secretPath)!);
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

                try
                {
                    File.Move(temp, _secretPath, overwrite);
                }
                catch (IOException) when (!overwrite && File.Exists(_secretPath))
                {
                    // Lost a create race: keep the winner's secret.
                }
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
