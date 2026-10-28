using System;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

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
        // Lock order: the configuration lock is outer and the backend monitor inner (configuration writers and
        // SeerrMigration.SettleHandover read the backend while holding it), so take it before CommitEffective's monitor.
        internal T Publish<T>(Func<T> effect, Func<T> refused)
        {
            // Same neutral dependency owner used by Publication.EnlistEffective; retain this
            // read's original snapshot in the enclosing composition and eventual HTTP stamp.
            EffectiveReadScope.Enlist(EffectiveRequestsBackend.Shared, Backend.Epoch);
            var configuration = JellyfinEnhanced.AnalyticsCredentialLock;
            // A caller already inside the backend monitor (a nested facts publication) never waits for the outer lock:
            // it publishes when the lock is free now, and is refused, as for a changed configuration, when it isn't.
            var waits = !EffectiveRequestsBackend.Shared.HoldsGate;
            var entered = false;
            try
            {
                if (waits) Monitor.Enter(configuration, ref entered);
                else if (!(entered = Monitor.TryEnter(configuration))) return refused();
                return EffectiveRequestsBackend.Shared.CommitEffective(Backend.Epoch, () => IsCurrent ? effect() : refused());
            }
            catch (BackendDisabledException) { return refused(); }
            finally { if (entered) Monitor.Exit(configuration); }
        }
    }
}
