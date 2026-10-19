using System;
using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Model.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks
{
    /// <summary>
    /// Arms Spoiler Guard for titles that were already in the library, using
    /// the saved auto-enable scope (see <see cref="SpoilerExistingTitlesApplier"/>).
    /// Manual only: no default triggers, because an unattended re-run would
    /// re-arm titles users have since switched off. Started from Dashboard >
    /// Scheduled Tasks or from the "Apply to existing titles now" button on the
    /// plugin config page (which also passes the run's options).
    /// </summary>
    public class SpoilerApplyExistingTitlesTask : IScheduledTask, IConfigurableScheduledTask
    {
        private readonly SpoilerExistingTitlesApplier _applier;

        public SpoilerApplyExistingTitlesTask(SpoilerExistingTitlesApplier applier)
        {
            _applier = applier;
        }

        public string Name => "Spoiler Guard: apply to existing titles";

        public string Key => "JellyfinEnhancedSpoilerApplyExistingTitles";

        public string Description => "Turns Spoiler Guard on for every show and movie already in the library that is inside the auto-enable scope (content types and libraries), for every user who can see it. Titles a user already has, or has fully watched, are skipped. Run it by hand; rescans never do this.";

        public string Category => "Jellyfin Enhanced";

        internal static bool IsFeatureEnabled([NotNullWhen(true)] Configuration.PluginConfiguration? config) => config != null && config.SpoilerBlurEnabled;

        public bool IsHidden => !IsFeatureEnabled(JellyfinEnhanced.Instance?.Configuration);

        public bool IsEnabled => true;

        public bool IsLogged => true;

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            return Enumerable.Empty<TaskTriggerInfo>();
        }

        public Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            // Jellyfin's task worker already runs this on a pool thread.
            _applier.Run(_applier.TakePendingOptions(), progress, cancellationToken);
            return Task.CompletedTask;
        }
    }
}
