using System;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Secrets
{
    /// <summary>
    /// The placeholder values a credential field can hold once its real value lives in the
    /// <see cref="SecretsStore"/>. The plugin XML, the dashboard's configuration endpoint and every
    /// JE response only ever carry one of these, never the credential itself:
    /// <list type="bullet">
    /// <item><description>a <b>mask</b> (<c>••••••••3f9a</c>): a credential is stored; the last four
    /// characters are kept so an admin can tell keys apart;</description></item>
    /// <item><description>an <b>import handle</b> (<c>••••••••seerr-…</c>): a credential read server-side
    /// (Import from Seerr) that is not saved yet; the save resolves it;</description></item>
    /// <item><description>the <b>clear token</b>: the admin asked for the stored credential to be removed.</description></item>
    /// </list>
    /// On save, a mask, a blank value or an expired handle means "unchanged", so the config page's
    /// whole-object POST can neither wipe nor overwrite a stored credential by accident.
    /// </summary>
    public static class SecretValue
    {
        /// <summary>Eight bullets (U+2022). Real API keys never contain this character.</summary>
        public const string MaskPrefix = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";

        /// <summary>Marks an import handle after <see cref="MaskPrefix"/>.</summary>
        public const string HandleMarker = "seerr-";

        /// <summary>Posted by the config page's Clear button: remove the stored credential.</summary>
        public const string ClearToken = "__je_clear_secret__";

        /// <summary>
        /// ASCII stand-in for "the saved key" in an HTTP header (Test buttons): browsers refuse header
        /// values outside Latin-1, so the mask itself can't be sent there. See <see cref="FromWire"/>.
        /// </summary>
        public const string SavedToken = "__je_saved_secret__";

        /// <summary>ASCII stand-in for an import handle in an HTTP header, followed by the handle id.</summary>
        public const string HandleTokenPrefix = "__je_handle__:";

        /// <summary>Credentials at least this long show their last four characters in the mask.</summary>
        private const int MinLengthForHint = 12;

        /// <summary>The mask for a stored value ("" when the value is empty).</summary>
        public static string Mask(string? value)
        {
            if (string.IsNullOrEmpty(value)) return string.Empty;
            return value.Length >= MinLengthForHint ? MaskPrefix + value.Substring(value.Length - 4) : MaskPrefix;
        }

        /// <summary>True for any placeholder produced by this class (mask or import handle).</summary>
        public static bool IsPlaceholder(string? value)
            => value != null && value.StartsWith(MaskPrefix, StringComparison.Ordinal);

        /// <summary>True for an import handle (<see cref="CreateHandle"/>).</summary>
        public static bool IsHandle(string? value)
            => value != null && value.StartsWith(MaskPrefix + HandleMarker, StringComparison.Ordinal);

        /// <summary>True for the explicit clear request.</summary>
        public static bool IsClear(string? value) => string.Equals(value, ClearToken, StringComparison.Ordinal);

        /// <summary>The public form of an import handle id.</summary>
        public static string CreateHandle(string handleId) => MaskPrefix + HandleMarker + handleId;

        /// <summary>The handle id inside an import handle, or null.</summary>
        public static string? HandleId(string? value)
            => IsHandle(value) ? value!.Substring(MaskPrefix.Length + HandleMarker.Length) : null;

        /// <summary>
        /// Maps the ASCII header forms a config page sends (<see cref="SavedToken"/>,
        /// <see cref="HandleTokenPrefix"/>) to the placeholder they stand for; anything else is
        /// returned unchanged.
        /// </summary>
        public static string? FromWire(string? value)
        {
            if (value == null) return null;
            var trimmed = value.Trim();
            if (string.Equals(trimmed, SavedToken, StringComparison.Ordinal)) return MaskPrefix;
            if (trimmed.StartsWith(HandleTokenPrefix, StringComparison.Ordinal) && trimmed.Length > HandleTokenPrefix.Length)
                return CreateHandle(trimmed.Substring(HandleTokenPrefix.Length));
            return value;
        }

        /// <summary>
        /// The short, display-only hint for a stored value ("ends 3f9a"), or "" when it is too short
        /// to reveal anything safely.
        /// </summary>
        public static string Hint(string? value)
            => !string.IsNullOrEmpty(value) && value.Length >= MinLengthForHint ? "ends " + value.Substring(value.Length - 4) : string.Empty;
    }
}
