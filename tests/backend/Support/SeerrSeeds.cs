using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;

namespace JE.Tests;

/// <summary>Entries of the Seerr proxy's account caches as a read made now would keep them (tests that seed them).</summary>
internal static class SeerrSeeds
{
    /// <summary>A held account id for <paramref name="jellyfinUserId"/>, read now under their current Seerr account authority.</summary>
    public static (string JellyseerrUserId, long ReadAt, SeerrAccountAuthority.Ticket Authority) Id(string jellyfinUserId, string id)
        => (id, MonotonicClock.Now(), SeerrAccountAuthority.Capture(Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.Instance?.Configuration, jellyfinUserId));

    /// <summary>The key the routes keep a person's asked-for proof under (their Seerr account authority and the Seerr address).</summary>
    public static string ProofKey(string jellyfinUserId, string urls)
        => SeerrAccountAuthority.Capture(Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.Instance?.Configuration, jellyfinUserId).Key + "|" + urls.Trim();
}
