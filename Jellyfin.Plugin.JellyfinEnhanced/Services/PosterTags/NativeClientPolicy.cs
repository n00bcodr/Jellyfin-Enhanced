using System;
using System.Collections.Generic;
using System.Security.Claims;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags
{
    // Decides, at metadata time, whether the client asking for item DTOs gets
    // native poster tags stamped into its image tags. Clients that load the
    // server's jellyfin-web run JE's own JS overlays; stamping their DTOs would
    // draw every tag twice. The decision is made only here: an image URL
    // without the -jet segment is never overlaid, so image requests need no
    // client heuristics at all.
    //
    // Matching is on the exact Jellyfin-Client claim (from the client's
    // authorization header), never prefix/contains: "Jellyfin for Android"
    // (a WebView of the server's web UI, runs JE) vs "Jellyfin for Android TV"
    // (native, doesn't) differ only by a suffix. Admins add names for forks or
    // shells that load the server web UI via NativePosterTagsWebClientNames.
    //
    // An empty client name is treated as a web client (no stamping): every
    // real native client identifies itself, and the safe failure is original
    // artwork rather than double tags.
    public sealed class NativeClientPolicy
    {
        /// <summary>Clients that load the server's jellyfin-web and therefore already run JE's overlays.</summary>
        public static readonly IReadOnlyList<string> BuiltInWebClients = new[]
        {
            "Jellyfin Web",
            "Jellyfin Media Player",
            "Jellium Desktop",
            "Jellyfin Desktop",
            "Jellyfin for WebOS",
            "Jellyfin for Android",
        };

        private const string ClientClaim = "Jellyfin-Client";

        private sealed record ParsedNames(string Raw, HashSet<string> Names);

        private volatile ParsedNames? _parsed;

        /// <summary>True when the authenticated request comes from a client that should get stamped tags.</summary>
        public bool IsNativeClient(ClaimsPrincipal principal)
        {
            var client = UserHelper.GetClaimValue(principal, ClientClaim);
            return IsNativeClient(client, GetWebClientNames());
        }

        /// <summary>Pure decision used by <see cref="IsNativeClient(ClaimsPrincipal)"/> (exposed for the test harness).</summary>
        public static bool IsNativeClient(string? clientName, IReadOnlySet<string> webClientNames)
        {
            var name = clientName?.Trim();
            if (string.IsNullOrEmpty(name)) return false;
            return !webClientNames.Contains(name);
        }

        /// <summary>
        /// The built-in web client names plus admin extras separated by new lines or commas.
        /// Case-insensitive exact names.
        /// </summary>
        public static HashSet<string> ParseWebClientNames(string? extraNames)
        {
            var names = new HashSet<string>(BuiltInWebClients, StringComparer.OrdinalIgnoreCase);
            if (string.IsNullOrWhiteSpace(extraNames)) return names;
            foreach (var raw in extraNames.Split(new[] { '\n', '\r', ',' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                names.Add(raw);
            }

            return names;
        }

        private HashSet<string> GetWebClientNames()
        {
            var raw = JellyfinEnhanced.Instance?.Configuration?.NativePosterTagsWebClientNames ?? string.Empty;
            var parsed = _parsed;
            if (parsed != null && string.Equals(parsed.Raw, raw, StringComparison.Ordinal)) return parsed.Names;
            parsed = new ParsedNames(raw, ParseWebClientNames(raw));
            _parsed = parsed;
            return parsed.Names;
        }
    }
}
