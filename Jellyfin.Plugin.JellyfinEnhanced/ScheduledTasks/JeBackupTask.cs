using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Backup;
using MediaBrowser.Model.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks
{
    /// <summary>
    /// Writes a Jellyfin Enhanced backup (configuration, user settings, JE stores; credentials only
    /// when the admin chose to encrypt them) to the backup folder and keeps the newest N copies.
    /// No default trigger: the admin schedules it under Dashboard → Scheduled Tasks.
    /// </summary>
    public class JeBackupTask : IScheduledTask
    {
        private readonly JeBackupService _backup;
        private readonly Logger _logger;

        /// <summary>Creates the task.</summary>
        public JeBackupTask(JeBackupService backup, Logger logger)
        {
            _backup = backup;
            _logger = logger;
        }

        /// <inheritdoc />
        public string Name => "Back up Jellyfin Enhanced data";

        /// <inheritdoc />
        public string Key => "JellyfinEnhancedBackup";

        /// <inheritdoc />
        public string Description => "Saves Jellyfin Enhanced's settings, every user's Jellyfin Enhanced settings and its stores to the backup folder set on the plugin's Admin tab (Jellyfin's own backups don't include plugin data). Add a trigger to run it on a schedule.";

        /// <inheritdoc />
        public string Category => "Jellyfin Enhanced";

        /// <inheritdoc />
        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers() => Array.Empty<TaskTriggerInfo>();

        /// <inheritdoc />
        public Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null) return Task.CompletedTask;
            progress?.Report(0);

            var secrets = JeBackupSecrets.Exclude;
            string? passphrase = null;
            if (config.BackupIncludeSecrets)
            {
                passphrase = config.GetBackupPassphrase();
                if (string.IsNullOrEmpty(passphrase) || passphrase.Length < JeBackupService.MinPassphraseLength)
                {
                    // Fail loudly rather than quietly writing a backup without the credentials the admin asked for.
                    throw new InvalidOperationException($"Backups are set to include credentials, but no passphrase of at least {JeBackupService.MinPassphraseLength} characters is saved. Set one on the plugin's Admin tab.");
                }
                secrets = JeBackupSecrets.Encrypt;
            }

            var folder = _backup.BackupFolder(config);
            var keep = Math.Clamp(config.BackupCopiesToKeep, 1, 100);
            var path = _backup.WriteToFolder(folder, secrets, passphrase, keep);
            _logger.Info($"JE backup written: {path} (credentials {(secrets == JeBackupSecrets.Encrypt ? "included, encrypted" : "left out")}; keeping {keep} copies).");
            progress?.Report(100);
            return Task.CompletedTask;
        }
    }
}
