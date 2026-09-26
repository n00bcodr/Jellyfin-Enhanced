using System;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Drives the daily maintenance window (MaintenanceScheduleEnabled / Start / End) and expires
    /// timed manual windows. A plain 30-second timer rather than an IScheduledTask: Jellyfin logs
    /// every scheduled-task run at Info level, which would spam the log twice a minute for what
    /// is almost always a no-op tick.
    ///
    /// Rules per tick:
    ///   - an active window whose EndsAt has passed is disabled (manual or scheduled);
    ///   - schedule off  + active scheduled window  -> disable (this is how an admin ends a window early);
    ///   - schedule on   + inside the window        -> enable as "schedule" unless a manual window is
    ///                                                 already active (manual always wins);
    ///   - schedule on   + outside the window       -> disable only if the active window is scheduled.
    /// Times are server-local, so a window of 22:00-06:00 crosses midnight as expected.
    /// </summary>
    public sealed class MaintenanceScheduleService : IHostedService, IDisposable
    {
        private static readonly TimeSpan TickInterval = TimeSpan.FromSeconds(30);

        private readonly MaintenanceModeService _maintenance;
        private readonly Logger _logger;
        private Timer? _timer;
        private int _ticking;
        private string? _lastInvalidWindowWarned;

        public MaintenanceScheduleService(MaintenanceModeService maintenance, Logger logger)
        {
            _maintenance = maintenance;
            _logger = logger;
        }

        public Task StartAsync(CancellationToken cancellationToken)
        {
            _timer = new Timer(_ => _ = TickAsync(), null, TimeSpan.FromSeconds(15), TickInterval);
            return Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken cancellationToken)
        {
            _timer?.Change(Timeout.Infinite, Timeout.Infinite);
            return Task.CompletedTask;
        }

        public void Dispose() => _timer?.Dispose();

        private async Task TickAsync()
        {
            // Skip a tick that overlaps a slow one (user policy updates can take a moment).
            if (Interlocked.Exchange(ref _ticking, 1) == 1) return;
            try
            {
                var cfg = JellyfinEnhanced.Instance?.Configuration;
                if (cfg == null) return;

                var state = await _maintenance.ExpireIfDueAsync().ConfigureAwait(false);

                if (!cfg.MaintenanceScheduleEnabled)
                {
                    if (state.IsActive && state.Source == "schedule")
                    {
                        _logger.Info("[Maintenance] Schedule turned off - ending the scheduled window.");
                        await _maintenance.DisableAsync().ConfigureAwait(false);
                    }
                    return;
                }

                if (!TryParseWindow(cfg.MaintenanceScheduleStart, cfg.MaintenanceScheduleEnd, out var start, out var end))
                {
                    var key = $"{cfg.MaintenanceScheduleStart}-{cfg.MaintenanceScheduleEnd}";
                    if (_lastInvalidWindowWarned != key)
                    {
                        _lastInvalidWindowWarned = key;
                        _logger.Warning($"[Maintenance] Scheduled window '{key}' is invalid (expected HH:mm-HH:mm with different times) - schedule ignored.");
                    }
                    return;
                }

                var window = CurrentWindow(start, end, DateTime.Now);
                if (window == null)
                {
                    if (state.IsActive && state.Source == "schedule")
                    {
                        _logger.Info("[Maintenance] Scheduled window ended.");
                        await _maintenance.DisableAsync().ConfigureAwait(false);
                    }
                    return;
                }

                // A manual window (toggle or API) takes precedence over the schedule.
                if (state.IsActive && state.Source != "schedule") return;

                var windowEndUtc = window.Value.End.ToUniversalTime();
                var wasActive = state.IsActive;
                await _maintenance.EnableScheduledAsync(
                    cfg.MaintenanceScheduleMessage,
                    cfg.MaintenanceScheduleNotificationMessage,
                    string.IsNullOrWhiteSpace(cfg.MaintenanceScheduleAction) ? "none" : cfg.MaintenanceScheduleAction,
                    MaintenanceModeService.ParseAffectedUsersSetting(cfg.MaintenanceModeAffectedUsers),
                    windowEndUtc).ConfigureAwait(false);

                if (!wasActive)
                {
                    _logger.Info($"[Maintenance] Scheduled window started ({window.Value.Start:HH:mm} - {window.Value.End:HH:mm} server time).");
                    var text = FirstNonBlank(cfg.MaintenanceScheduleNotificationMessage, cfg.MaintenanceScheduleMessage, MaintenanceModeService.DefaultNotificationText);
                    var result = await _maintenance.BroadcastAsync(MaintenanceModeService.DefaultHeader, text, 30000, string.Empty).ConfigureAwait(false);
                    _logger.Info($"[Maintenance] Window-start notification sent to {result.Sent} session(s), skipped {result.Skipped}.");
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"[Maintenance] Schedule tick failed: {ex.Message}");
            }
            finally
            {
                Interlocked.Exchange(ref _ticking, 0);
            }
        }

        /// <summary>Parses "HH:mm" start/end; false when either is malformed or they are equal.</summary>
        public static bool TryParseWindow(string? startText, string? endText, out TimeSpan start, out TimeSpan end)
        {
            start = end = TimeSpan.Zero;
            if (!TimeSpan.TryParseExact((startText ?? string.Empty).Trim(), @"h\:mm", CultureInfo.InvariantCulture, out start)) return false;
            if (!TimeSpan.TryParseExact((endText ?? string.Empty).Trim(), @"h\:mm", CultureInfo.InvariantCulture, out end)) return false;
            return start != end;
        }

        /// <summary>
        /// The occurrence of the daily window that contains <paramref name="nowLocal"/>, or null when
        /// outside it. Checks today's and yesterday's start so a window crossing midnight is found
        /// after 00:00 as well.
        /// </summary>
        public static (DateTime Start, DateTime End)? CurrentWindow(TimeSpan start, TimeSpan end, DateTime nowLocal)
        {
            var length = end > start ? end - start : end - start + TimeSpan.FromDays(1);
            if (length <= TimeSpan.Zero) return null;
            for (var dayOffset = 0; dayOffset >= -1; dayOffset--)
            {
                var windowStart = nowLocal.Date.AddDays(dayOffset) + start;
                var windowEnd = windowStart + length;
                if (nowLocal >= windowStart && nowLocal < windowEnd) return (windowStart, windowEnd);
            }
            return null;
        }

        private static string FirstNonBlank(params string?[] values)
        {
            foreach (var v in values)
            {
                if (!string.IsNullOrWhiteSpace(v)) return v.Trim();
            }
            return string.Empty;
        }
    }
}
