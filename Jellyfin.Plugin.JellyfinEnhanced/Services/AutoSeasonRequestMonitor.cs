using System;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.AutoRequest;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    // Monitors playback events to automatically request next seasons when threshold is reached.
    // The two playback handlers only hand a trigger to a bounded queue (constant time, no I/O, no await);
    // the recipe worker runs the lookups and records the request, behind a single-flight trigger gate.
    public class AutoSeasonRequestMonitor : IDisposable
    {
        private readonly PlaybackTriggerChannel _triggers;
        private readonly PlaybackTriggerGate _gate;
        private readonly ISessionManager _sessionManager;
        private readonly AutoSeasonRequestService _autoSeasonRequestService;
        private readonly AutoRequestRecorder? _recorder;
        private readonly Logger _logger;

        public AutoSeasonRequestMonitor(
            ISessionManager sessionManager,
            IUserManager userManager,
            ILibraryManager libraryManager,
            AutoSeasonRequestService autoSeasonRequestService,
            Logger logger,
            AutoRequestRecorder? recorder = null)
            : this(sessionManager, autoSeasonRequestService, logger, recorder, PlaybackTriggerGate.Default())
        {
        }

        internal AutoSeasonRequestMonitor(ISessionManager sessionManager, AutoSeasonRequestService autoSeasonRequestService, Logger logger, AutoRequestRecorder? recorder, PlaybackTriggerGate gate)
        {
            _sessionManager = sessionManager;
            _autoSeasonRequestService = autoSeasonRequestService;
            _recorder = recorder;
            _logger = logger;
            _gate = gate;
            _triggers = new PlaybackTriggerChannel(PlaybackTriggerChannel.DefaultCapacity, ProcessAsync, message => _logger.Warning("[Auto-Season-Request] " + message));
        }

        // True when the feature can act: Seerr requests (phase 3 off) or the request ledger (phase 3 on).
        private bool CanRun(PluginConfiguration? config)
            => config is { AutoSeasonRequestEnabled: true } && (config.JellyseerrEnabled || (_recorder != null && AutoRequestRecorder.Active(config)));

        // Initialize and start monitoring playback events.
        public void Initialize()
        {
            // Only initialize if the auto-season-request feature is enabled in plugin configuration.
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
            {
                _logger.Warning("[Auto-Season-Request] Configuration is null - skipping auto-season-request monitoring initialization");
                return;
            }

            if (!CanRun(config))
            {
                _logger.Info("[Auto-Season-Request] Auto-request monitoring is disabled in configuration - not subscribing to playback events");
                return;
            }

            // Subscribe to playback events
            _sessionManager.PlaybackStopped += OnPlaybackStopped;
            _sessionManager.PlaybackProgress += OnPlaybackProgress;

            _logger.Info("[Auto-Season-Request] Successfully subscribed to playback events");
        }

        /// <summary>The trigger a stop event makes: an episode played to completion or past 90%. Pure arithmetic.</summary>
        internal static PlaybackTrigger? StoppedTrigger(PlaybackStopEventArgs e)
        {
            if (e.Item?.GetBaseItemKind() != BaseItemKind.Episode || e.Session?.UserId is not Guid userId || userId == Guid.Empty) return null;
            var completion = e.PlaybackPositionTicks.HasValue && e.Item.RunTimeTicks is > 0 ? (double)e.PlaybackPositionTicks.Value / e.Item.RunTimeTicks.Value : 0.0;
            return e.PlayedToCompletion || completion >= 0.9 ? new PlaybackTrigger($"season-stopped|{userId:N}|{e.Item.Id:N}", userId, e.Session.UserName, e.Item) : null;
        }

        /// <summary>The trigger a progress event makes: an episode just started (under 2 minutes and 5%). Pure arithmetic.</summary>
        internal static PlaybackTrigger? StartedTrigger(PlaybackProgressEventArgs e)
        {
            if (e.Item?.GetBaseItemKind() != BaseItemKind.Episode || e.Session?.UserId is not Guid userId || userId == Guid.Empty) return null;
            if (!e.PlaybackPositionTicks.HasValue || !e.Item.RunTimeTicks.HasValue || e.Item.RunTimeTicks.Value <= 0) return null;
            var progressPercentage = (double)e.PlaybackPositionTicks.Value / e.Item.RunTimeTicks.Value;
            var progressMinutes = TimeSpan.FromTicks(e.PlaybackPositionTicks.Value).TotalMinutes;
            return progressMinutes <= 2 && progressPercentage < 0.05 ? new PlaybackTrigger($"season-started|{userId:N}|{e.Item.Id:N}", userId, e.Session.UserName, e.Item) : null;
        }

        // Handle playback stopped events to check if we should request next season. Runs on Jellyfin's
        // session thread: a constant-time hand-off, no I/O and no await.
        private void OnPlaybackStopped(object? sender, PlaybackStopEventArgs e)
        {
            if (!CanRun(JellyfinEnhanced.Instance?.Configuration)) return;
            var trigger = StoppedTrigger(e);
            if (trigger == null || _gate.IsQuiet(trigger.Key)) return;
            _triggers.TryWrite(trigger);
        }

        // Handle playback progress events to detect when user starts watching a new episode. Runs on
        // Jellyfin's session thread: a constant-time hand-off, no I/O and no await.
        private void OnPlaybackProgress(object? sender, PlaybackProgressEventArgs e)
        {
            if (!CanRun(JellyfinEnhanced.Instance?.Configuration)) return;
            var trigger = StartedTrigger(e);
            if (trigger == null || _gate.IsQuiet(trigger.Key)) return;
            _triggers.TryWrite(trigger);
        }

        // The recipe worker: one trigger at a time; the gate's cooldown starts only after a definitive outcome.
        private async Task ProcessAsync(PlaybackTrigger trigger, CancellationToken ct)
        {
            if (!_gate.TryBegin(trigger.Key)) return;
            var outcome = AutoRequestOutcome.Cancelled();
            try
            {
                var stopped = trigger.Key.StartsWith("season-stopped|", StringComparison.Ordinal);
                _logger.Info($"[Auto-Season-Request] Episode '{trigger.Item.Name ?? "Unknown"}' {(stopped ? "completed" : "started")} by {trigger.UserName ?? "Unknown"}, checking threshold");
                outcome = await _autoSeasonRequestService.CheckEpisodeCompletionAsync(trigger.Item, trigger.UserId, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                outcome = AutoRequestOutcome.Cancelled("shutdown");
            }
            catch (Exception ex)
            {
                _logger.Error($"[Auto-Season-Request] Error processing playback: {ex.Message}");
                outcome = AutoRequestOutcome.Failed("unexpected_error");
            }
            finally
            {
                _gate.Complete(trigger.Key, outcome);
                _recorder?.Log(AutoSeasonRequestService.Recipe, trigger.UserId, outcome);
            }
        }

        // Cleanup when the plugin is disposed.
        public void Dispose()
        {
            _logger.Info("[Auto-Season-Request] Unsubscribing from playback events");

            _sessionManager.PlaybackStopped -= OnPlaybackStopped;
            _sessionManager.PlaybackProgress -= OnPlaybackProgress;
            _triggers.Dispose();

            GC.SuppressFinalize(this);
        }
    }
}
