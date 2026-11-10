using System;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.Text
{
    /// <summary>ISO-8601 date parsing shared by several features (restructure S2.0b, moved verbatim from JellyfinEnhancedController).</summary>
    public static class IsoDates
    {
        public static DateTime? TryParseIso(string? s)
        {
            if (string.IsNullOrWhiteSpace(s)) return null;
            return DateTime.TryParse(s, System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.RoundtripKind, out var dt) ? (DateTime?)dt : null;
        }
    }
}
