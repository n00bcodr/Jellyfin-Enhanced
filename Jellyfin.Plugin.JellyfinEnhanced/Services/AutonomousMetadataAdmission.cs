using System;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    internal enum AutonomousMetadataOwner { ListImport, Automation, Legacy, RequestDispatch }

    // Autonomous owners are explicit at their entry boundary. These server-wide pools are
    // independent of viewers: imports 4, playback automation 2, retained non-JE metadata 4, request dispatch 2 (matching
    // a TMDB-numbered ask's episodes to Sonarr's by id).
    // No viewer-driven JE read may select an autonomous owner as a fallback.
    internal static class AutonomousMetadataAdmission
    {
        private static readonly SemaphoreSlim Imports = new(4, 4);
        private static readonly SemaphoreSlim Automation = new(2, 2);
        private static readonly SemaphoreSlim Legacy = new(4, 4);
        private static readonly SemaphoreSlim RequestDispatch = new(2, 2);

        internal static async Task<T> RunAsync<T>(AutonomousMetadataOwner owner, Func<Task<T>> fetch, CancellationToken ct = default)
        {
            var slots = owner switch
            {
                AutonomousMetadataOwner.ListImport => Imports,
                AutonomousMetadataOwner.Automation => Automation,
                AutonomousMetadataOwner.Legacy => Legacy,
                AutonomousMetadataOwner.RequestDispatch => RequestDispatch,
                _ => throw new ArgumentOutOfRangeException(nameof(owner)),
            };
            if (!await slots.WaitAsync(TimeSpan.FromSeconds(30), ct).ConfigureAwait(false))
                throw new TimeoutException("Autonomous TMDB admission timed out.");
            try
            {
                using var admission = new MetadataAdmission(owner.ToString());
                try { return await fetch().ConfigureAwait(false); }
                finally { await admission.DrainAsync().ConfigureAwait(false); }
            }
            finally { slots.Release(); }
        }
    }
}
