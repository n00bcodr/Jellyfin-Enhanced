using System;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
using System.Security.Cryptography;
using System.Text;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    // One consumer publication fence, shared with every real configuration commit. No lock crosses an await.
    // Preserve the original effective snapshot through every cache read and publication.
    internal sealed record ListMetadataEpoch(JellyfinEnhanced? Plugin, long Generation, string Identity, EffectiveBackendSnapshot Backend)
    {
        internal static ListMetadataEpoch Capture()
        {
            var backend = EffectiveRequestsBackend.Shared.Current;
            lock (JellyfinEnhanced.AnalyticsCredentialLock)
            {
                var plugin = JellyfinEnhanced.Instance;
                var c = plugin?.Configuration;
                var identity = string.Join('|', c?.ArrRequestBackend, c?.ArrIntegrationEnabled, c?.ArrPhase1Enabled,
                    c?.ArrPhase3Enabled, c?.JellyseerrEnabled, Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(c?.GetTmdbApiKey() ?? string.Empty))),
                    SeerrAddresses.Identity(SeerrAddresses.Parse(c?.JellyseerrUrls), c?.GetJellyseerrApiKey() ?? string.Empty));
                return new(plugin, c?.ConfigurationGeneration ?? 0, identity, backend);
            }
        }

        internal bool IsCurrent => Equals(Capture());

        // The comparison and effect are indivisible relative to configuration replacement and saved generations.
        // Lifecycle precedes this lock when both are needed; configuration commits never acquire Lifecycle.
        internal T Publish<T>(Func<T> effect, Func<T> refused)
        {
            using var publication = SeerrFacts.BeginPublication();
            publication.EnlistEffective(Backend);
            try
            {
                return publication.Publish(() =>
                {
                    lock (JellyfinEnhanced.AnalyticsCredentialLock)
                        return IsCurrent ? effect() : refused();
                });
            }
            catch (BackendDisabledException) { return refused(); }
        }
    }
}
