using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Xml;
using System.Xml.Linq;
using System.Xml.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Secrets;
using MediaBrowser.Common.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Backup
{
    /// <summary>How a backup treats stored credentials (API keys, passwords).</summary>
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public enum JeBackupSecrets
    {
        /// <summary>Left out: the backup holds placeholders only; keys are entered again after a restore elsewhere.</summary>
        Exclude,
        /// <summary>Included, encrypted with an admin passphrase (AES-256-GCM, PBKDF2-SHA256 key).</summary>
        Encrypt,
    }

    /// <summary>The manifest at the root of a JE backup zip.</summary>
    public sealed class JeBackupManifest
    {
        /// <summary>Always <see cref="JeBackupService.FormatName"/>.</summary>
        [JsonPropertyName("format")] public string Format { get; set; } = string.Empty;

        /// <summary>Format version.</summary>
        [JsonPropertyName("version")] public int Version { get; set; }

        /// <summary>When it was made (UTC).</summary>
        [JsonPropertyName("createdAt")] public DateTimeOffset CreatedAt { get; set; }

        /// <summary>JE version that made it.</summary>
        [JsonPropertyName("pluginVersion")] public string? PluginVersion { get; set; }

        /// <summary>jf12 or jf10 build.</summary>
        [JsonPropertyName("jellyfinTarget")] public string? JellyfinTarget { get; set; }

        /// <summary>exclude or encrypt.</summary>
        [JsonPropertyName("secrets")] public JeBackupSecrets Secrets { get; set; }

        /// <summary>Names of the credentials inside (encrypted mode; never values).</summary>
        [JsonPropertyName("secretNames")] public List<string> SecretNames { get; set; } = new();

        /// <summary>Every file with its size and SHA-256.</summary>
        [JsonPropertyName("files")] public List<JeBackupFile> Files { get; set; } = new();
    }

    /// <summary>One file in a backup.</summary>
    public sealed class JeBackupFile
    {
        /// <summary>Entry path inside the zip ("config/…" or "data/…").</summary>
        [JsonPropertyName("path")] public string Path { get; set; } = string.Empty;

        /// <summary>Bytes.</summary>
        [JsonPropertyName("size")] public long Size { get; set; }

        /// <summary>Lowercase hex SHA-256.</summary>
        [JsonPropertyName("sha256")] public string Sha256 { get; set; } = string.Empty;
    }

    /// <summary>What a backup holds (for the restore preview).</summary>
    public sealed class JeBackupSummary
    {
        /// <summary>The manifest.</summary>
        [JsonPropertyName("manifest")] public JeBackupManifest Manifest { get; init; } = new();

        /// <summary>Per-user folders (user settings) inside.</summary>
        [JsonPropertyName("userFolders")] public int UserFolders { get; init; }

        /// <summary>Data files inside (user settings and JE stores).</summary>
        [JsonPropertyName("dataFiles")] public int DataFiles { get; init; }

        /// <summary>True when the plugin configuration is inside.</summary>
        [JsonPropertyName("hasConfiguration")] public bool HasConfiguration { get; init; }

        /// <summary>Encrypted credentials are inside.</summary>
        [JsonPropertyName("hasSecrets")] public bool HasSecrets { get; init; }

        /// <summary>The passphrase given opens them (null when no passphrase was given or none is needed).</summary>
        [JsonPropertyName("passphraseOk")] public bool? PassphraseOk { get; init; }
    }

    /// <summary>The outcome of a restore.</summary>
    public sealed class JeRestoreResult
    {
        /// <summary>Data files written.</summary>
        [JsonPropertyName("filesRestored")] public int FilesRestored { get; init; }

        /// <summary>Credentials written to the secrets store.</summary>
        [JsonPropertyName("secretsRestored")] public int SecretsRestored { get; init; }

        /// <summary>The plugin configuration was replaced.</summary>
        [JsonPropertyName("configurationRestored")] public bool ConfigurationRestored { get; init; }

        /// <summary>
        /// Saved credentials the restored configuration refers to that can't be used here (enter them
        /// again): not stored, or the backup points them at another server than the stored key was for.
        /// </summary>
        [JsonPropertyName("missingCredentials")] public List<string> MissingCredentials { get; init; } = new();

        /// <summary>File name of the safety copy taken before restoring (in <c>backups</c> in the JE data folder).</summary>
        [JsonPropertyName("safetyBackup")] public string? SafetyBackup { get; init; }

        /// <summary>Some services cache settings: restart Jellyfin so everything reads the restored data.</summary>
        [JsonPropertyName("restartRecommended")] public bool RestartRecommended { get; init; } = true;
    }

    /// <summary>A backup that can't be used (bad zip, wrong passphrase, tampered file, ...). The message is safe to show admins.</summary>
    public sealed class JeBackupException : Exception
    {
        /// <summary>Creates the exception.</summary>
        public JeBackupException(string code, string message)
            : base(message)
        {
            Code = code;
        }

        /// <summary>Stable code (invalid_backup, passphrase_required, wrong_passphrase, ...).</summary>
        public string Code { get; }
    }

    /// <summary>
    /// Export, scheduled copies and restore of Jellyfin Enhanced's own data. Jellyfin's built-in backup
    /// (12.2) does not include plugin data, so without this the JE configuration, every user's JE
    /// settings and JE's stores would be lost with the server.
    /// <list type="bullet">
    /// <item><description>A backup is one zip: <c>manifest.json</c> (sizes and SHA-256 of every file),
    /// <c>config/</c> the plugin XML, <c>data/</c> the JE data folder (user settings, reviews, hidden
    /// content, bookmarks, branding, audit log, ...) without caches, and optionally <c>secrets.enc</c>.</description></item>
    /// <item><description>Credentials are either left out (the XML only ever holds placeholders, and any
    /// stray plain value is blanked in the copy) or encrypted with a passphrase. The install's analytics
    /// identity is never exported or restored.</description></item>
    /// <item><description>Restore checks everything before writing anything, takes a safety copy of the
    /// current state first (always inside the JE data folder), keeps this install's arr audit log, and
    /// replaces the configuration in place (no restart needed for it). A stored key is only kept for
    /// the server it was saved for.</description></item>
    /// </list>
    /// </summary>
    public sealed class JeBackupService
    {
        /// <summary>Manifest format name.</summary>
        public const string FormatName = "jellyfin-enhanced-backup";

        /// <summary>Current format version.</summary>
        public const int FormatVersion = 1;

        /// <summary>File name prefix of scheduled backups (used for rotation).</summary>
        public const string ScheduledPrefix = "jellyfin-enhanced-backup-";

        /// <summary>File name prefix of the safety copies taken before a restore.</summary>
        public const string SafetyPrefix = "jellyfin-enhanced-pre-restore-";

        /// <summary>Minimum passphrase length.</summary>
        public const int MinPassphraseLength = 12;

        /// <summary>
        /// Default folder for scheduled backups, and always the folder of the safety copies taken before a
        /// restore (inside the JE data folder, next to the secrets file; never backed up itself).
        /// </summary>
        public const string DefaultFolderName = "backups";

        internal const int Pbkdf2Iterations = 600_000;
        private const string ConfigEntry = "config/Jellyfin.Plugin.JellyfinEnhanced.xml";
        private const string ManifestEntry = "manifest.json";
        private const string SecretsEntry = "secrets.enc";
        private const string DataPrefix = "data/";
        private const long MaxFileBytes = 64L * 1024 * 1024;
        private const long MaxTotalBytes = 512L * 1024 * 1024;
        private const int SafetyCopiesKept = 3;
        private static readonly byte[] Aad = Encoding.UTF8.GetBytes("jellyfin-enhanced-backup/v1/secrets");

        // Caches and regenerable state stay out of backups (they are rebuilt on their own).
        private static readonly HashSet<string> ExcludedDirectories = new(StringComparer.OrdinalIgnoreCase)
        {
            "cdn-cache", ArrStateStore.CacheFolderName, DefaultFolderName,
        };

        private static readonly HashSet<string> ExcludedFiles = new(StringComparer.OrdinalIgnoreCase)
        {
            SecretsStore.FileName, "tag-cache.json", "tmdb-cache.json", "awards.json", "mdblist-ratings.json", "config-schema-snapshot.json",
        };

        // The arr action audit log (and its rotated copies) is this install's history: exported, but
        // never overwritten by a restore (that would roll back or replace the trail).
        internal static bool IsInstallHistory(string relative)
            => !relative.Contains('/') && (string.Equals(relative, ArrAuditLog.FileName, StringComparison.OrdinalIgnoreCase)
                || relative.StartsWith(ArrAuditLog.FileName + ".", StringComparison.OrdinalIgnoreCase));

        // Credentials that belong to this install, never to a backup.
        private static readonly HashSet<string> InstallOnlySecrets = new(StringComparer.Ordinal)
        {
            nameof(PluginConfiguration.AnalyticsInstallSecret),
        };

        private static readonly JsonSerializerOptions ManifestJson = new() { WriteIndented = true };

        private readonly string _dataFolder;
        private readonly string _configPath;
        private readonly Func<SecretsStore?> _secrets;
        private readonly Logger? _logger;

        /// <summary>The service for a Jellyfin installation (DI).</summary>
        public JeBackupService(IApplicationPaths paths, Logger logger)
            : this(
                Path.Combine(paths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced"),
                Path.Combine(paths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced.xml"),
                () => JellyfinEnhanced.Instance?.Secrets,
                logger)
        {
        }

        /// <summary>A service over explicit paths (tests).</summary>
        internal JeBackupService(string dataFolder, string configPath, Func<SecretsStore?> secrets, Logger? logger)
        {
            _dataFolder = dataFolder;
            _configPath = configPath;
            _secrets = secrets;
            _logger = logger;
        }

        /// <summary>Applies the configuration from a restore (the plugin replaces it in place). Tests replace it.</summary>
        internal Func<PluginConfiguration, IReadOnlyCollection<string>, SecretsMigration.Report?> ApplyConfiguration { get; set; } = (config, restoredSecretNames) => JellyfinEnhanced.Instance?.RestoreConfiguration(config, restoredSecretNames);

        /// <summary>The folder scheduled backups go to: the configured one, else <c>backups</c> in the JE data folder.</summary>
        public string BackupFolder(PluginConfiguration? config)
            => string.IsNullOrWhiteSpace(config?.BackupFolder) ? Path.Combine(_dataFolder, DefaultFolderName) : Path.GetFullPath(config!.BackupFolder.Trim());

        /// <summary>Writes a backup zip to <paramref name="output"/>.</summary>
        /// <exception cref="JeBackupException">A passphrase is missing or too short, or the credentials can't be read.</exception>
        public JeBackupManifest Export(Stream output, JeBackupSecrets secrets, string? passphrase)
        {
            var store = _secrets();
            Dictionary<string, string>? secretValues = null;
            if (secrets == JeBackupSecrets.Encrypt)
            {
                if (string.IsNullOrEmpty(passphrase) || passphrase.Length < MinPassphraseLength)
                    throw new JeBackupException("passphrase_too_short", $"Use a passphrase of at least {MinPassphraseLength} characters to include credentials.");
                if (store == null || !store.IsAvailable)
                    throw new JeBackupException("secrets_unavailable", "The stored credentials can't be read right now (see the server log), so they can't be included. Back up without them, or fix the secrets file first.");
                secretValues = store.Names()
                    .Where(n => !InstallOnlySecrets.Contains(n))
                    .Select(n => (Name: n, Value: store.Get(n)))
                    .Where(p => !string.IsNullOrEmpty(p.Value))
                    .ToDictionary(p => p.Name, p => p.Value!, StringComparer.Ordinal);
            }

            var manifest = new JeBackupManifest
            {
                Format = FormatName,
                Version = FormatVersion,
                CreatedAt = DateTimeOffset.UtcNow,
                PluginVersion = JellyfinEnhanced.Instance?.Version?.ToString(),
#if JF12
                JellyfinTarget = "jf12",
#else
                JellyfinTarget = "jf10",
#endif
                Secrets = secrets,
                SecretNames = secretValues?.Keys.OrderBy(k => k, StringComparer.Ordinal).ToList() ?? new List<string>(),
            };

            using var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true);
            long total = 0;
            if (File.Exists(_configPath))
            {
                var xml = ScrubConfigurationXml(File.ReadAllBytes(_configPath));
                AddEntry(zip, manifest, ConfigEntry, xml, ref total);
            }
            var backupFolder = Path.GetFullPath(BackupFolder(JellyfinEnhanced.Instance?.Configuration)).TrimEnd(Path.DirectorySeparatorChar);
            foreach (var (relative, full) in DataFiles(backupFolder))
            {
                byte[] bytes;
                try
                {
                    // The Requests & downloads database is copied through SQLite (a consistent
                    // snapshot of a live database), never as raw file bytes; its WAL and copies stay out.
                    if (Acquire.AcquireDatabase.IsDatabaseFile(relative))
                    {
                        if (!relative.Equals(Acquire.AcquireDatabase.FileName, StringComparison.OrdinalIgnoreCase)) continue;
                        bytes = DatabaseSnapshot(full) ?? File.ReadAllBytes(full);
                    }
                    else
                    {
                        bytes = File.ReadAllBytes(full);
                    }
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    _logger?.Warning($"JE backup: skipped {relative} ({ex.Message}).");
                    continue;
                }
                AddEntry(zip, manifest, DataPrefix + relative, bytes, ref total);
            }
            if (secretValues != null)
            {
                var sealedSecrets = Seal(JsonSerializer.SerializeToUtf8Bytes(secretValues), passphrase!);
                var entry = zip.CreateEntry(SecretsEntry, CompressionLevel.Optimal);
                using var s = entry.Open();
                s.Write(sealedSecrets);
            }

            var manifestEntry = zip.CreateEntry(ManifestEntry, CompressionLevel.Optimal);
            using (var m = manifestEntry.Open())
            {
                JsonSerializer.Serialize(m, manifest, ManifestJson);
            }
            return manifest;
        }

        /// <summary>
        /// Writes a backup file to the backup folder (owner-only permissions) and removes the oldest
        /// scheduled backups beyond <paramref name="keep"/>. Returns the file written.
        /// </summary>
        public string WriteToFolder(string folder, JeBackupSecrets secrets, string? passphrase, int keep, string prefix = ScheduledPrefix)
        {
            Directory.CreateDirectory(folder);
            var name = prefix + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss", System.Globalization.CultureInfo.InvariantCulture) + ".zip";
            var path = Path.Combine(folder, name);
            var temp = path + ".tmp";
            try
            {
                using (var stream = CreatePrivateFile(temp))
                {
                    Export(stream, secrets, passphrase);
                }
                File.Move(temp, path, overwrite: true);
            }
            finally
            {
                if (File.Exists(temp)) File.Delete(temp);
            }

            var old = Directory.EnumerateFiles(folder, prefix + "*.zip")
                .Select(f => new FileInfo(f))
                .OrderByDescending(f => f.Name, StringComparer.Ordinal)
                .Skip(Math.Max(1, keep))
                .ToList();
            foreach (var f in old)
            {
                try
                {
                    f.Delete();
                }
                catch (IOException ex)
                {
                    _logger?.Warning($"JE backup: could not remove old copy {f.Name}: {ex.Message}");
                }
            }
            return path;
        }

        /// <summary>Checks a backup and describes it without changing anything.</summary>
        /// <exception cref="JeBackupException">The file is not a usable JE backup.</exception>
        public JeBackupSummary Inspect(Stream backup, string? passphrase)
        {
            using var zip = OpenZip(backup);
            var (manifest, files) = ReadVerified(zip);
            var hasSecrets = zip.GetEntry(SecretsEntry) != null;
            bool? passphraseOk = null;
            if (hasSecrets && !string.IsNullOrEmpty(passphrase))
            {
                try
                {
                    OpenSecrets(zip, passphrase);
                    passphraseOk = true;
                }
                catch (JeBackupException)
                {
                    passphraseOk = false;
                }
            }
            return new JeBackupSummary
            {
                Manifest = manifest,
                HasConfiguration = files.ContainsKey(ConfigEntry),
                HasSecrets = hasSecrets,
                PassphraseOk = passphraseOk,
                DataFiles = files.Keys.Count(k => k.StartsWith(DataPrefix, StringComparison.Ordinal)),
                UserFolders = files.Keys
                    .Where(k => k.StartsWith(DataPrefix, StringComparison.Ordinal))
                    .Select(k => k.Substring(DataPrefix.Length).Split('/'))
                    .Where(p => p.Length > 1 && IsUserFolderName(p[0]))
                    .Select(p => p[0])
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .Count(),
            };
        }

        /// <summary>
        /// Restores a backup: verifies it completely, takes a safety copy of the current state, writes
        /// the data files (files not in the backup are left alone), stores the credentials (encrypted
        /// backups) and replaces the plugin configuration.
        /// </summary>
        /// <exception cref="JeBackupException">The file is not a usable JE backup or the passphrase is wrong; nothing was changed.</exception>
        public JeRestoreResult Restore(Stream backup, string? passphrase)
        {
            using var zip = OpenZip(backup);
            var (_, files) = ReadVerified(zip);

            Dictionary<string, string>? secrets = null;
            if (zip.GetEntry(SecretsEntry) != null)
            {
                if (string.IsNullOrEmpty(passphrase))
                    throw new JeBackupException("passphrase_required", "This backup contains encrypted credentials: enter its passphrase.");
                secrets = OpenSecrets(zip, passphrase)
                    .Where(p => !InstallOnlySecrets.Contains(p.Key))
                    .ToDictionary(p => p.Key, p => p.Value, StringComparer.Ordinal);
            }

            PluginConfiguration? restoredConfig = null;
            if (files.TryGetValue(ConfigEntry, out var xml))
            {
                restoredConfig = ParseConfiguration(xml);
            }

            var store = _secrets();
            if (secrets != null && (store == null || !store.IsAvailable))
                throw new JeBackupException("secrets_unavailable", "The secrets file can't be written right now (see the server log); nothing was restored.");

            // Everything checked: keep a copy of what is about to be replaced.
            string? safety = null;
            try
            {
                safety = Path.GetFileName(TakeSafetyCopy(store));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JeBackupException)
            {
                throw new JeBackupException("safety_copy_failed", "Could not save a copy of the current data before restoring, so nothing was restored: " + ex.Message);
            }

            var written = 0;
            var keptHistory = 0;
            foreach (var (entry, bytes) in files)
            {
                if (!entry.StartsWith(DataPrefix, StringComparison.Ordinal)) continue;
                if (IsInstallHistory(entry.Substring(DataPrefix.Length)))
                {
                    keptHistory++;
                    continue;
                }
                var target = TargetPath(entry.Substring(DataPrefix.Length));
                if (Acquire.AcquireDatabase.Shared is { } database && string.Equals(Path.GetFullPath(target), Path.GetFullPath(database.FilePath), StringComparison.Ordinal))
                {
                    // The live database: copied in through SQLite while its reads and writes wait.
                    database.ReplaceWith(bytes);
                    written++;
                    continue;
                }
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                var temp = target + ".tmp." + Guid.NewGuid().ToString("N");
                try
                {
                    File.WriteAllBytes(temp, bytes);
                    File.Move(temp, target, overwrite: true);
                }
                finally
                {
                    if (File.Exists(temp)) File.Delete(temp);
                }
                written++;
            }

            if (secrets != null && secrets.Count > 0)
            {
                store!.Apply(secrets);
            }

            var missing = new List<string>();
            if (restoredConfig != null)
            {
                // Keys from the backup's own encrypted credentials belong to the restored addresses;
                // any other placeholder only keeps this install's key if its address is unchanged.
                var report = ApplyConfiguration(restoredConfig, secrets?.Keys.ToList() ?? new List<string>());
                if (report != null) missing.AddRange(report.Missing.Concat(report.NeedsReentry).Distinct(StringComparer.Ordinal));
            }

            _logger?.Info($"JE backup: restored {written} data file(s), {secrets?.Count ?? 0} credential(s), configuration {(restoredConfig != null ? "replaced" : "not in backup")}; safety copy {safety}"
                + (keptHistory > 0 ? $"; this install's arr audit log was kept ({keptHistory} audit file(s) in the backup were not restored)." : "."));
            return new JeRestoreResult
            {
                FilesRestored = written,
                SecretsRestored = secrets?.Count ?? 0,
                ConfigurationRestored = restoredConfig != null,
                MissingCredentials = missing,
                SafetyBackup = safety,
            };
        }

        /// <summary>
        /// Reads a plugin configuration XML the way Jellyfin does, keeping only the backup's own
        /// shortcut list (the serializer appends saved rows to the constructor defaults).
        /// </summary>
        internal static PluginConfiguration ParseConfiguration(byte[] xml)
        {
            try
            {
                var doc = XDocument.Load(new MemoryStream(xml), LoadOptions.None);
                var savedShortcuts = doc.Root?.Element("Shortcuts")?.Elements().Count();
                var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null };
                using var reader = XmlReader.Create(new MemoryStream(xml), settings);
                var config = (PluginConfiguration?)new XmlSerializer(typeof(PluginConfiguration)).Deserialize(reader)
                    ?? throw new JeBackupException("invalid_backup", "The configuration in this backup is empty.");
                if (savedShortcuts is int n && config.Shortcuts != null && config.Shortcuts.Count > n)
                {
                    config.Shortcuts = config.Shortcuts.Skip(config.Shortcuts.Count - n).ToList();
                }
                return config;
            }
            catch (Exception ex) when (ex is XmlException or InvalidOperationException)
            {
                throw new JeBackupException("invalid_backup", "The configuration in this backup can't be read.");
            }
        }

        /// <summary>
        /// Blanks every credential that is stored in plain text in the configuration XML (placeholders
        /// stay), and replaces an unreadable instance list with the corrupt-list marker: only possible
        /// while the secrets store could not be written, but never exported.
        /// </summary>
        internal static byte[] ScrubConfigurationXml(byte[] xml)
        {
            XDocument doc;
            try
            {
                doc = XDocument.Load(new MemoryStream(xml), LoadOptions.PreserveWhitespace);
            }
            catch (XmlException)
            {
                throw new JeBackupException("invalid_configuration", "The plugin configuration file can't be read.");
            }
            var root = doc.Root;
            if (root == null) return xml;
            var changed = false;
            foreach (var field in PluginConfiguration.StoredSecretFields)
            {
                var el = root.Element(field);
                if (el == null || string.IsNullOrEmpty(el.Value) || SecretValue.IsPlaceholder(el.Value)) continue;
                el.Value = string.Empty;
                changed = true;
            }
            foreach (var listField in new[] { nameof(PluginConfiguration.SonarrInstances), nameof(PluginConfiguration.RadarrInstances) })
            {
                var el = root.Element(listField);
                if (el == null || string.IsNullOrWhiteSpace(el.Value)) continue;
                var rows = ArrRegistryMigration.Parse(el.Value);
                if (rows == null)
                {
                    // Unreadable (left as is when the store could not take its text): it may hold
                    // plain keys, so the copy gets the marker every reader treats as corrupt.
                    if (string.Equals(el.Value, SecretsMigration.CorruptListMarker, StringComparison.Ordinal)) continue;
                    el.Value = SecretsMigration.CorruptListMarker;
                    changed = true;
                    continue;
                }
                if (!rows.Any(r => !string.IsNullOrEmpty(r.ApiKey) && !SecretValue.IsPlaceholder(r.ApiKey))) continue;
                foreach (var row in rows)
                {
                    if (!string.IsNullOrEmpty(row.ApiKey) && !SecretValue.IsPlaceholder(row.ApiKey)) row.ApiKey = string.Empty;
                }
                el.Value = ArrRegistryMigration.Serialize(rows);
                changed = true;
            }
            if (!changed) return xml;
            using var ms = new MemoryStream();
            doc.Save(ms, SaveOptions.DisableFormatting);
            return ms.ToArray();
        }

        /// <summary>Encrypts with a key derived from the passphrase. Layout: JSON with salt, nonce, tag and ciphertext.</summary>
        internal static byte[] Seal(byte[] plaintext, string passphrase, int iterations = Pbkdf2Iterations)
        {
            var salt = RandomNumberGenerator.GetBytes(16);
            var nonce = RandomNumberGenerator.GetBytes(12);
            var key = Rfc2898DeriveBytes.Pbkdf2(passphrase, salt, iterations, HashAlgorithmName.SHA256, 32);
            var cipher = new byte[plaintext.Length];
            var tag = new byte[16];
            using (var aes = new AesGcm(key, 16))
            {
                aes.Encrypt(nonce, plaintext, cipher, tag, Aad);
            }
            CryptographicOperations.ZeroMemory(key);
            return JsonSerializer.SerializeToUtf8Bytes(new SealedBox
            {
                Kdf = "PBKDF2-SHA256",
                Iterations = iterations,
                Cipher = "AES-256-GCM",
                Salt = Convert.ToBase64String(salt),
                Nonce = Convert.ToBase64String(nonce),
                Tag = Convert.ToBase64String(tag),
                Ciphertext = Convert.ToBase64String(cipher),
            });
        }

        /// <summary>Decrypts <see cref="Seal"/> output.</summary>
        /// <exception cref="JeBackupException">Wrong passphrase or damaged data.</exception>
        internal static byte[] Open(byte[] sealedBytes, string passphrase)
        {
            SealedBox? box;
            try
            {
                box = JsonSerializer.Deserialize<SealedBox>(sealedBytes);
            }
            catch (JsonException)
            {
                box = null;
            }
            if (box == null || box.Kdf != "PBKDF2-SHA256" || box.Cipher != "AES-256-GCM" || box.Iterations is < 100_000 or > 10_000_000)
                throw new JeBackupException("invalid_backup", "The encrypted credentials in this backup are damaged.");
            byte[] key = Array.Empty<byte>();
            try
            {
                var salt = Convert.FromBase64String(box.Salt ?? string.Empty);
                var nonce = Convert.FromBase64String(box.Nonce ?? string.Empty);
                var tag = Convert.FromBase64String(box.Tag ?? string.Empty);
                var cipher = Convert.FromBase64String(box.Ciphertext ?? string.Empty);
                key = Rfc2898DeriveBytes.Pbkdf2(passphrase, salt, box.Iterations, HashAlgorithmName.SHA256, 32);
                var plain = new byte[cipher.Length];
                using var aes = new AesGcm(key, 16);
                aes.Decrypt(nonce, cipher, tag, plain, Aad);
                return plain;
            }
            catch (Exception ex) when (ex is CryptographicException or FormatException or ArgumentException)
            {
                throw new JeBackupException("wrong_passphrase", "The passphrase is wrong (or the backup is damaged).");
            }
            finally
            {
                CryptographicOperations.ZeroMemory(key);
            }
        }

        private static ZipArchive OpenZip(Stream backup)
        {
            try
            {
                return new ZipArchive(backup, ZipArchiveMode.Read, leaveOpen: true);
            }
            catch (InvalidDataException)
            {
                throw new JeBackupException("invalid_backup", "This is not a zip file.");
            }
        }

        // The manifest plus every listed file, read with size caps and checked against its SHA-256.
        private static (JeBackupManifest Manifest, Dictionary<string, byte[]> Files) ReadVerified(ZipArchive zip)
        {
            var manifestEntry = zip.GetEntry(ManifestEntry) ?? throw new JeBackupException("invalid_backup", "This is not a Jellyfin Enhanced backup (no manifest).");
            JeBackupManifest? manifest;
            try
            {
                manifest = JsonSerializer.Deserialize<JeBackupManifest>(ReadCapped(manifestEntry, 8L * 1024 * 1024));
            }
            catch (JsonException)
            {
                manifest = null;
            }
            if (manifest == null || manifest.Format != FormatName)
                throw new JeBackupException("invalid_backup", "This is not a Jellyfin Enhanced backup.");
            if (manifest.Version > FormatVersion)
                throw new JeBackupException("newer_backup", "This backup was made by a newer Jellyfin Enhanced; update the plugin first.");

            var files = new Dictionary<string, byte[]>(StringComparer.Ordinal);
            long total = 0;
            foreach (var f in manifest.Files)
            {
                if (!IsSafeEntryName(f.Path))
                    throw new JeBackupException("invalid_backup", "The backup lists a file outside the allowed folders.");
                var entry = zip.GetEntry(f.Path) ?? throw new JeBackupException("invalid_backup", "The backup is incomplete (a listed file is missing).");
                var bytes = ReadCapped(entry, MaxFileBytes);
                total += bytes.Length;
                if (total > MaxTotalBytes)
                    throw new JeBackupException("invalid_backup", "The backup is larger than Jellyfin Enhanced restores.");
                if (bytes.Length != f.Size || !string.Equals(Convert.ToHexString(SHA256.HashData(bytes)), f.Sha256, StringComparison.OrdinalIgnoreCase))
                    throw new JeBackupException("invalid_backup", "The backup is damaged (a file does not match its checksum).");
                if (!files.TryAdd(f.Path, bytes))
                    throw new JeBackupException("invalid_backup", "The backup lists a file twice.");
            }
            // Anything in the zip the manifest doesn't list is ignored, never extracted.
            return (manifest, files);
        }

        private static Dictionary<string, string> OpenSecrets(ZipArchive zip, string passphrase)
        {
            var entry = zip.GetEntry(SecretsEntry)!;
            var plain = Open(ReadCapped(entry, 4L * 1024 * 1024), passphrase);
            try
            {
                return JsonSerializer.Deserialize<Dictionary<string, string>>(plain) ?? new Dictionary<string, string>();
            }
            catch (JsonException)
            {
                throw new JeBackupException("invalid_backup", "The encrypted credentials in this backup are damaged.");
            }
            finally
            {
                CryptographicOperations.ZeroMemory(plain);
            }
        }

        private static byte[] ReadCapped(ZipArchiveEntry entry, long cap)
        {
            if (entry.Length > cap) throw new JeBackupException("invalid_backup", "A file in the backup is too large.");
            using var s = entry.Open();
            using var ms = new MemoryStream();
            var buffer = new byte[81920];
            int n;
            while ((n = s.Read(buffer, 0, buffer.Length)) > 0)
            {
                ms.Write(buffer, 0, n);
                if (ms.Length > cap) throw new JeBackupException("invalid_backup", "A file in the backup is too large.");
            }
            return ms.ToArray();
        }

        // "config/<the plugin xml>" or "data/<relative path>" with plain segments only.
        internal static bool IsSafeEntryName(string name)
        {
            if (name == ConfigEntry) return true;
            if (!name.StartsWith(DataPrefix, StringComparison.Ordinal)) return false;
            var parts = name.Substring(DataPrefix.Length).Split('/');
            if (parts.Length == 0) return false;
            foreach (var p in parts)
            {
                if (p.Length == 0 || p == "." || p == ".." || p.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || p.Contains('\\') || p.Contains(':')) return false;
            }
            // Never restore what is excluded on export (caches, the secrets file, backups themselves).
            if (parts.Length > 1 && ExcludedDirectories.Contains(parts[0])) return false;
            if (parts.Length == 1 && ExcludedFiles.Contains(parts[0])) return false;
            return true;
        }

        private string TargetPath(string relative)
        {
            var full = Path.GetFullPath(Path.Combine(_dataFolder, relative.Replace('/', Path.DirectorySeparatorChar)));
            var root = Path.GetFullPath(_dataFolder + Path.DirectorySeparatorChar);
            if (!full.StartsWith(root, StringComparison.Ordinal))
                throw new JeBackupException("invalid_backup", "The backup lists a file outside the data folder.");
            return full;
        }

        private IEnumerable<(string Relative, string Full)> DataFiles(string backupFolder)
        {
            if (!Directory.Exists(_dataFolder)) yield break;
            var root = new DirectoryInfo(_dataFolder);
            var pending = new Stack<(DirectoryInfo Dir, string Prefix)>();
            pending.Push((root, string.Empty));
            while (pending.Count > 0)
            {
                var (dir, prefix) = pending.Pop();
                foreach (var sub in dir.EnumerateDirectories().OrderBy(d => d.Name, StringComparer.Ordinal))
                {
                    if (sub.LinkTarget != null) continue;
                    if (prefix.Length == 0 && ExcludedDirectories.Contains(sub.Name)) continue;
                    // A backup folder chosen inside the data folder is never backed up itself.
                    if (string.Equals(sub.FullName.TrimEnd(Path.DirectorySeparatorChar), backupFolder, StringComparison.Ordinal)) continue;
                    pending.Push((sub, prefix + sub.Name + "/"));
                }
                foreach (var file in dir.EnumerateFiles().OrderBy(f => f.Name, StringComparer.Ordinal))
                {
                    if (file.LinkTarget != null) continue;
                    if (prefix.Length == 0 && ExcludedFiles.Contains(file.Name)) continue;
                    if (file.Name.Contains(".tmp", StringComparison.OrdinalIgnoreCase)) continue;
                    if (file.Name.StartsWith(ScheduledPrefix, StringComparison.Ordinal) || file.Name.StartsWith(SafetyPrefix, StringComparison.Ordinal)) continue;
                    if (file.Length > MaxFileBytes)
                    {
                        _logger?.Warning($"JE backup: skipped {prefix}{file.Name} ({file.Length / (1024 * 1024)} MiB is over the per-file limit).");
                        continue;
                    }
                    var relative = prefix + file.Name;
                    if (!IsSafeEntryName(DataPrefix + relative)) continue;
                    yield return (relative, file.FullName);
                }
            }
        }

        // A consistent copy of the live Requests & downloads database (null: read the file as is).
        private static byte[]? DatabaseSnapshot(string full)
        {
            var database = Acquire.AcquireDatabase.Shared;
            if (database == null || !string.Equals(Path.GetFullPath(full), Path.GetFullPath(database.FilePath), StringComparison.Ordinal)) return null;
            return database.Snapshot();
        }

        private static void AddEntry(ZipArchive zip, JeBackupManifest manifest, string name, byte[] bytes, ref long total)
        {
            total += bytes.Length;
            if (total > MaxTotalBytes)
                throw new JeBackupException("too_large", "Jellyfin Enhanced's data is larger than a backup can hold.");
            var entry = zip.CreateEntry(name, CompressionLevel.Optimal);
            using (var s = entry.Open())
            {
                s.Write(bytes);
            }
            manifest.Files.Add(new JeBackupFile { Path = name, Size = bytes.Length, Sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant() });
        }

        // Before a restore: the current configuration and data (credentials left out) plus a copy of
        // secrets.json next to it, both owner-only, the newest three kept. Always in "backups" inside
        // the JE data folder, whatever backup folder is configured: secrets.json is plain JSON, so its
        // copy must stay where the original is (never on a backup share, which may ignore 0600).
        private string TakeSafetyCopy(SecretsStore? store)
        {
            var folder = Path.Combine(_dataFolder, DefaultFolderName);
            var path = WriteToFolder(folder, JeBackupSecrets.Exclude, null, SafetyCopiesKept, SafetyPrefix);
            if (store != null && File.Exists(store.FilePath))
            {
                var copy = Path.ChangeExtension(path, ".secrets.json");
                using (var target = CreatePrivateFile(copy))
                using (var source = File.OpenRead(store.FilePath))
                {
                    source.CopyTo(target);
                }
                foreach (var stale in Directory.EnumerateFiles(folder, SafetyPrefix + "*.secrets.json")
                    .OrderByDescending(f => f, StringComparer.Ordinal).Skip(SafetyCopiesKept))
                {
                    File.Delete(stale);
                }
            }
            return path;
        }

        private static FileStream CreatePrivateFile(string path)
        {
            var options = new FileStreamOptions { Mode = FileMode.Create, Access = FileAccess.Write, Share = FileShare.None };
            if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            return new FileStream(path, options);
        }

        private static bool IsUserFolderName(string name) => name.Length == 32 && name.All(Uri.IsHexDigit);

        private sealed class SealedBox
        {
            [JsonPropertyName("kdf")] public string? Kdf { get; set; }

            [JsonPropertyName("iterations")] public int Iterations { get; set; }

            [JsonPropertyName("cipher")] public string? Cipher { get; set; }

            [JsonPropertyName("salt")] public string? Salt { get; set; }

            [JsonPropertyName("nonce")] public string? Nonce { get; set; }

            [JsonPropertyName("tag")] public string? Tag { get; set; }

            [JsonPropertyName("ciphertext")] public string? Ciphertext { get; set; }
        }
    }
}
