using System;
using System.Security.Cryptography;
using System.Text;
using MediaBrowser.Common.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Persistence;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags
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

        /// <summary>The viewer had watched all of the image owner when the token was minted (hides its "New Episode" badge).</summary>
        WatchedAll = 4,
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
    // Without a keyed token anyone who knows a user id and item ids could have
    // that user's tag settings baked into anonymous images. The MAC binds the user AND the item, so a token
    // can't be moved to another user or another item, and it binds the
    // settings digest and the pixel version (callers pass
    // PosterTagComposer.PixelVersion: renderer + composition versions; the
    // resolver version is inside the digest), so a settings change or a
    // drawing update makes old URLs fall back to original artwork until the
    // client refreshes metadata (no stale composites under a "current" URL).
    //
    // The secret is the plugin's server secret (PluginSecretFile).
    public sealed class PosterTagVariantToken
    {
        /// <summary>Data hash used when the tag data is not pinned (weak token).</summary>
        public const string WeakDataHash = "000000";

        /// <summary>Bumped when the token's meaning changes, to retire every issued URL.</summary>
        public const string TokenVersion = "jet1";

        private const int MacHexLength = 16;

        private readonly PluginSecretFile _secret;

        public PosterTagVariantToken(IApplicationPaths applicationPaths, Logger logger)
            : this(PluginSecretFile.DefaultPath(applicationPaths), logger.Warning)
        {
        }

        private PosterTagVariantToken(string secretPath, Action<string> warn)
        {
            _secret = new PluginSecretFile(secretPath, warn);
        }

        /// <summary>Runs after the first existence check, before the create lock (lets tests force a create race).</summary>
        internal Action? BeforeSecretWriteForTest
        {
            get => _secret.BeforeSecretWriteForTest;
            set => _secret.BeforeSecretWriteForTest = value;
        }

        /// <summary>An instance keeping its secret at <paramref name="secretPath"/> (test harness).</summary>
        public static PosterTagVariantToken CreateForPath(string secretPath, Action<string> warn) => new(secretPath, warn);

        /// <summary>Mints the token for one user, image owner and settings digest.</summary>
        public string Mint(Guid userId, Guid itemId, string settingsDigest, string rendererVersion, PosterTagVariantFlags flags, string dataHash)
        {
            if (!IsDataHash(dataHash)) throw new ArgumentException("Data hash must be 6 lowercase hex characters.", nameof(dataHash));
            var flagsHex = FlagsHex(flags);
            var mac = ComputeMac(_secret.Get(), userId, itemId, settingsDigest, rendererVersion, flagsHex, dataHash);
            return flagsHex + dataHash + mac;
        }

        /// <summary>
        /// Checks a token against the CURRENT settings digest and renderer version for this user and item.
        /// Constant-time on the MAC.
        /// </summary>
        public bool Verify(string token, Guid userId, Guid itemId, string settingsDigest, string rendererVersion, out PosterTagVariant variant)
        {
            if (!TryParse(token, out variant)) return false;
            var expected = ComputeMac(_secret.Get(), userId, itemId, settingsDigest, rendererVersion, token.Substring(0, 1), variant.DataHash);
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
            if ((flags & ~(PosterTagVariantFlags.TopRightOffset | PosterTagVariantFlags.SpoilerScoped | PosterTagVariantFlags.WatchedAll)) != 0) return false;
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
    }
}
