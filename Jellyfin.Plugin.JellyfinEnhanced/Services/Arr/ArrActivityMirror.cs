using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Model.Activity;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr
{
    /// <summary>
    /// Copies every audited arr action (Search now, queue actions, Scan now, webhook set-up, …) into
    /// Jellyfin's own activity log (Dashboard → Activity), with who did it, what, where and how it
    /// ended. Only while "Requests &amp; downloads" phases 1 and 2 and the mirror setting are on. The
    /// JE audit file stays the record; the mirror is best effort (a failure is logged, never retried).
    /// </summary>
    public sealed class ArrActivityMirror : IHostedService
    {
        /// <summary>The activity type JE's entries carry.</summary>
        public const string ActivityType = "JellyfinEnhancedArrAction";

        /// <summary>The audit action of a call to an administrator's route by someone who isn't one.</summary>
        public const string DeniedAction = "denied";

        private readonly ArrAuditLog _audit;
        private readonly Func<ActivityLog, Task> _write;
        private readonly Func<PluginConfiguration?> _config;
        private readonly Logger? _logger;
        private int _subscribed;

        /// <summary>The mirror (DI).</summary>
        public ArrActivityMirror(ArrAuditLog audit, IActivityManager activity, Logger logger)
            : this(audit, entry => activity.CreateAsync(entry), null, logger)
        {
        }

        /// <summary>The mirror with an explicit writer and configuration (tests).</summary>
        internal ArrActivityMirror(ArrAuditLog audit, Func<ActivityLog, Task> write, Func<PluginConfiguration?>? config, Logger? logger)
        {
            _audit = audit;
            _write = write;
            _config = config ?? (() => JellyfinEnhanced.Instance?.Configuration);
            _logger = logger;
        }

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            Subscribe();
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public Task StopAsync(CancellationToken cancellationToken)
        {
            if (Interlocked.Exchange(ref _subscribed, 0) == 1) _audit.Appended -= OnAppended;
            return Task.CompletedTask;
        }

        /// <summary>Starts following the audit log (tests call it directly).</summary>
        internal void Subscribe()
        {
            if (Interlocked.Exchange(ref _subscribed, 1) == 0) _audit.Appended += OnAppended;
        }

        /// <summary>True when entries are copied.</summary>
        internal bool Enabled => _config() is { ArrIntegrationEnabled: true, ArrPhase1Enabled: true, ArrPhase2Enabled: true, ArrActivityLogMirror: true };

        private void OnAppended(ArrAuditEntry entry)
        {
            if (!Enabled) return;
            var log = ToActivity(entry);
            using (ExecutionContext.SuppressFlow())
            {
                _ = Task.Run(async () =>
                {
                    try
                    {
                        await _write(log).ConfigureAwait(false);
                    }
                    catch (Exception ex)
                    {
                        _logger?.Warning($"Arr audit: could not copy an action into Jellyfin's activity log ({ex.GetType().Name}).");
                    }
                });
            }
        }

        /// <summary>The activity log entry for an audit line ("real-admin: Remove from queue · Dune (2024) · Radarr · succeeded").</summary>
        internal static ActivityLog ToActivity(ArrAuditEntry entry)
        {
            var user = Guid.TryParse(entry.UserId, out var id) ? id : Guid.Empty;
            var title = entry.Details != null && entry.Details.TryGetValue("title", out var t) && !string.IsNullOrWhiteSpace(t) ? t
                : entry.Details != null && entry.Details.TryGetValue("key", out var k) ? k : entry.Target;
            var instance = entry.Details != null && entry.Details.TryGetValue("instance", out var n) && !string.IsNullOrWhiteSpace(n) ? n : null;
            var name = string.Join(" · ", new[] { (entry.UserName ?? "An administrator") + ": " + Label(entry.Action), title, instance, entry.Outcome }.Where(x => !string.IsNullOrWhiteSpace(x)));
            var overview = new List<string> { "Jellyfin Enhanced arr action " + entry.Action + " (tier " + entry.Tier.ToString(CultureInfo.InvariantCulture) + ") on " + entry.Target + ": " + entry.Outcome + "." };
            if (!string.IsNullOrWhiteSpace(entry.ReadBack)) overview.Add("Read back: " + entry.ReadBack);
            if (!string.IsNullOrWhiteSpace(entry.Message)) overview.Add(entry.Message!);
            overview.Add("Audit id " + entry.Id + ".");
            return new ActivityLog(Cap(name, 512), ActivityType, user)
            {
                ShortOverview = Cap(entry.Outcome + (string.IsNullOrWhiteSpace(entry.ReadBack) ? string.Empty : " · " + entry.ReadBack), 512),
                Overview = Cap(string.Join(" ", overview), 512),
                LogSeverity = entry.Outcome switch
                {
                    // Done, but its follow-up (a removal's new search) could not be started.
                    "succeeded" when entry.Details != null && entry.Details.TryGetValue("search", out var search) && search == "failed" => LogLevel.Warning,
                    "succeeded" => LogLevel.Information,
                    "unknown" or "rejected" or "denied" => LogLevel.Warning,
                    _ => LogLevel.Error,
                },
            };
        }

        private static string Label(string action) => action switch
        {
            "movie.search" or "series.search" or "season.search" or "episode.search" => "Search now",
            "queue.remove" => "Remove from queue",
            "queue.remove_with_data" => "Remove from queue and delete the download",
            "queue.retry_import" => "Retry import",
            "queue.search" => "Search again",
            "jellyfin.scan" => "Scan now",
            DeniedAction => "Refused (not an administrator)",
            _ => action,
        };

        private static string Cap(string text, int max) => text.Length <= max ? text : text[..(max - 1)] + "…";
    }
}
