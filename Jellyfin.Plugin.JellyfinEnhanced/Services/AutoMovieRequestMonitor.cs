using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
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
    // Monitors playback events to automatically request next movies in collections.
    // The playback handler only hands a trigger to a bounded queue (constant time, no I/O, no await);
    // the recipe worker runs the lookups and records the request, behind a single-flight trigger gate.
    public class AutoMovieRequestMonitor : IDisposable
    {
        private readonly PlaybackTriggerChannel _triggers;
        private readonly PlaybackTriggerGate _gate;
        private readonly ISessionManager _sessionManager;
        private readonly AutoMovieRequestService _autoMovieRequestService;
        private readonly AutoRequestRecorder? _recorder;
        private readonly Logger _logger;

        public AutoMovieRequestMonitor(
            ISessionManager sessionManager,
            IUserManager userManager,
            ILibraryManager libraryManager,
            AutoMovieRequestService autoMovieRequestService,
            Logger logger,
            AutoRequestRecorder? recorder = null)
            : this(sessionManager, autoMovieRequestService, logger, recorder, PlaybackTriggerGate.Default())
        {
        }

        internal AutoMovieRequestMonitor(ISessionManager sessionManager, AutoMovieRequestService autoMovieRequestService, Logger logger, AutoRequestRecorder? recorder, PlaybackTriggerGate gate)
        {
            _sessionManager = sessionManager;
            _autoMovieRequestService = autoMovieRequestService;
            _recorder = recorder;
            _logger = logger;
            _gate = gate;
            _triggers = new PlaybackTriggerChannel(PlaybackTriggerChannel.DefaultCapacity, ProcessAsync, message => _logger.Warning("[Auto-Movie-Request] " + message));
        }

        // True when the feature can act: Seerr requests (phase 3 off) or the request ledger (phase 3 on).
        private bool CanRun(PluginConfiguration? config)
            => config is { AutoMovieRequestEnabled: true } && ((EffectiveRequestsBackend.AllowsSeerr(config) && config.JellyseerrEnabled) || (_recorder != null && AutoRequestRecorder.Active(config)));

        private readonly object _subscriptionLock = new();
        private bool _subscribed;

        // Start monitoring playback events. Always subscribed: each event checks the settings, so turning the feature
        // on (or its Seerr / request-ledger prerequisite) applies right away, without a restart.
        public void Initialize()
        {
            lock (_subscriptionLock)
            {
                if (_subscribed) return;
                _sessionManager.PlaybackProgress += OnPlaybackProgress;
                _subscribed = true;
            }

            _logger.Info("[Auto-Movie-Request] Subscribed to playback events (" + (CanRun(JellyfinEnhanced.Instance?.Configuration) ? "on" : "off until enabled") + ")");
        }

        /// <summary>
        /// The trigger a progress event makes, or null: a movie at its start (under 5 minutes and 5%) and/or
        /// past the configured minutes watched, per the trigger type. Pure arithmetic, safe on the event thread.
        /// </summary>
        internal static PlaybackTrigger? Trigger(PlaybackProgressEventArgs e, PluginConfiguration? config)
        {
            if (config == null || e.Item?.GetBaseItemKind() != BaseItemKind.Movie || e.Session?.UserId is not Guid userId || userId == Guid.Empty) return null;
            if (!e.PlaybackPositionTicks.HasValue || !e.Item.RunTimeTicks.HasValue || e.Item.RunTimeTicks.Value <= 0) return null;
            var progressPercentage = (double)e.PlaybackPositionTicks.Value / e.Item.RunTimeTicks.Value;
            var progressMinutes = TimeSpan.FromTicks(e.PlaybackPositionTicks.Value).TotalMinutes;
            var atStart = progressMinutes <= 5 && progressPercentage < 0.05;
            var watched = progressMinutes >= config.AutoMovieRequestMinutesWatched;
            var shouldTrigger = (config.AutoMovieRequestTriggerType ?? "Both") switch
            {
                "OnStart" => atStart,
                "OnMinutesWatched" => watched,
                "Both" => atStart || watched,
                _ => false,
            };
            return shouldTrigger ? new PlaybackTrigger($"movie|{userId:N}|{e.Item.Id:N}", userId, e.Session.UserName, e.Item) : null;
        }

        // Handle playback progress events to detect when user starts watching a movie. Runs on Jellyfin's
        // session thread: a constant-time hand-off, no I/O and no await.
        private void OnPlaybackProgress(object? sender, PlaybackProgressEventArgs e)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (!CanRun(config)) return;
            var trigger = Trigger(e, config);
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
                _logger.Info($"[Auto-Movie-Request] Movie '{trigger.Item.Name ?? "Unknown"}' started by {trigger.UserName ?? "Unknown"}, checking for collection");
                outcome = await _autoMovieRequestService.CheckMovieForCollectionRequestAsync(trigger.Item, trigger.UserId, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                outcome = AutoRequestOutcome.Cancelled("shutdown");
            }
            catch (Exception ex)
            {
                _logger.Error($"[Auto-Movie-Request] Error in OnPlaybackProgress: {ex.Message}");
                outcome = AutoRequestOutcome.Failed("unexpected_error");
            }
            finally
            {
                _gate.Complete(trigger.Key, outcome);
                _recorder?.Log(AutoMovieRequestService.Recipe, trigger.UserId, outcome);
            }
        }

        // Cleanup when the plugin is disposed.
        public void Dispose()
        {
            _logger.Info("[Auto-Movie-Request] Unsubscribing from playback events");

            _sessionManager.PlaybackProgress -= OnPlaybackProgress;
            _triggers.Dispose();

            GC.SuppressFinalize(this);
        }
    }
}
