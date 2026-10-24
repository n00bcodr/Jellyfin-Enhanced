using System;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    // Consumer provenance, retained beyond the HTTP lifetime (in particular while waiting for a list lock).
    // E1 join: capture EffectiveRequestsBackend.Shared.Current.Epoch and compare that epoch in IsCurrent. Actual Seerr
    // sends additionally require CheckSeerr(SeerrUse.Metadata, capturedEpoch) and transport marking. Keep these consumer
    // checks even with E1's cancellable transport admissions. Until that join,
    // ConfigurationGeneration fences even a saved Seerr -> JE -> Seerr round trip with no intervening reader.
    internal sealed record ListMetadataEpoch(JellyfinEnhanced? Plugin, long Generation, string Identity)
    {
        internal static ListMetadataEpoch Capture()
        {
            var plugin = JellyfinEnhanced.Instance;
            var c = plugin?.Configuration;
            var identity = string.Join('|', c?.ArrRequestBackend, c?.ArrIntegrationEnabled, c?.ArrPhase1Enabled,
                c?.ArrPhase3Enabled, c?.JellyseerrEnabled,
                SeerrAddresses.Identity(SeerrAddresses.Parse(c?.JellyseerrUrls), c?.GetJellyseerrApiKey() ?? string.Empty));
            return new(plugin, c?.ConfigurationGeneration ?? 0, identity);
        }

        internal bool IsCurrent => Equals(Capture());
    }
}
