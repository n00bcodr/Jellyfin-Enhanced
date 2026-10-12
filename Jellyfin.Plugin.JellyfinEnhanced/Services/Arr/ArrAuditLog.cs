using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using MediaBrowser.Common.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr
{
    /// <summary>One audited arr action (or refused attempt). Never holds credentials.</summary>
    public sealed class ArrAuditEntry
    {
        /// <summary>Entry id.</summary>
        [JsonPropertyName("id")] public string Id { get; init; } = Guid.NewGuid().ToString("N");

        /// <summary>When the action finished (UTC).</summary>
        [JsonPropertyName("time")] public DateTimeOffset Time { get; init; }

        /// <summary>Jellyfin user who asked.</summary>
        [JsonPropertyName("userId")] public string UserId { get; init; } = string.Empty;

        /// <summary>Their display name at the time.</summary>
        [JsonPropertyName("userName")] public string? UserName { get; init; }

        /// <summary>Action name, e.g. "movie.search".</summary>
        [JsonPropertyName("action")] public string Action { get; init; } = string.Empty;

        /// <summary>1 safe, 2 change, 3 destructive.</summary>
        [JsonPropertyName("tier")] public int Tier { get; init; }

        /// <summary>Instance id.</summary>
        [JsonPropertyName("instanceId")] public string InstanceId { get; init; } = string.Empty;

        /// <summary>What was acted on, e.g. "movie:123".</summary>
        [JsonPropertyName("target")] public string Target { get; init; } = string.Empty;

        /// <summary>succeeded / failed / unknown / rejected (or "started" in the file, before the result is known).</summary>
        [JsonPropertyName("outcome")] public string Outcome { get; init; } = string.Empty;

        /// <summary>Read-back summary ("queue row gone").</summary>
        [JsonPropertyName("readBack")] public string? ReadBack { get; init; }

        /// <summary>Error kind when not succeeded.</summary>
        [JsonPropertyName("error")] public string? Error { get; init; }

        /// <summary>Error or refusal message.</summary>
        [JsonPropertyName("message")] public string? Message { get; init; }

        /// <summary>Wall time of the upstream call(s).</summary>
        [JsonPropertyName("durationMs")] public long DurationMs { get; init; }

        /// <summary>Extra non-secret context (title, options).</summary>
        [JsonPropertyName("details")] public IReadOnlyDictionary<string, string>? Details { get; init; }
    }

    /// <summary>
    /// Append-only JSONL audit file for arr actions (<c>arr-audit.jsonl</c> in the JE data folder,
    /// owner-only). Rotates by size into <c>.1</c> … <c>.N</c>. Thread-safe.
    /// </summary>
    public sealed class ArrAuditLog
    {
        /// <summary>File name inside the JE data folder.</summary>
        public const string FileName = "arr-audit.jsonl";

        /// <summary>
        /// Outcome of the line written before an action runs. <see cref="ReadRecent"/> folds it into
        /// the action's result line (same id); one without a result shows as "unknown".
        /// </summary>
        public const string StartedOutcome = "started";

        private static readonly JsonSerializerOptions Json = new() { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };
        private readonly string _path;
        private readonly long _maxBytes;
        private readonly int _keep;
        private readonly Action<string> _warn;
        private readonly object _lock = new();

        /// <summary>Audit log for a Jellyfin installation (5 MiB per file, 5 rotated files).</summary>
        public ArrAuditLog(IApplicationPaths paths, Logger logger)
            : this(Path.Combine(paths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced", FileName), 5L * 1024 * 1024, 5, logger.Warning)
        {
        }

        /// <summary>Audit log at an explicit path (tests).</summary>
        internal ArrAuditLog(string path, long maxBytes, int keep, Action<string>? warn = null)
        {
            _path = path;
            _maxBytes = Math.Max(1024, maxBytes);
            _keep = Math.Max(1, keep);
            _warn = warn ?? (_ => { });
        }

        /// <summary>Path of the current file.</summary>
        public string FilePath => _path;

        /// <summary>
        /// Raised after an action's result line (not its "started" line) was written, outside the
        /// file lock. Handlers must be quick and must not throw (exceptions are swallowed).
        /// </summary>
        public event Action<ArrAuditEntry>? Appended;

        /// <summary>Appends one entry (rotating first when the file is full). Never throws; false when it could not be written.</summary>
        public bool Append(ArrAuditEntry entry)
        {
            var line = JsonSerializer.Serialize(entry, Json) + "\n";
            var bytes = Encoding.UTF8.GetBytes(line);
            lock (_lock)
            {
                try
                {
                    var dir = Path.GetDirectoryName(_path);
                    if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                    if (File.Exists(_path) && new FileInfo(_path).Length + bytes.Length > _maxBytes) Rotate();

                    var options = new FileStreamOptions { Mode = FileMode.Append, Access = FileAccess.Write, Share = FileShare.Read };
                    if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
                    using (var stream = new FileStream(_path, options))
                    {
                        stream.Write(bytes, 0, bytes.Length);
                        stream.Flush(true);
                    }
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    _warn($"Arr audit: could not write {FileName}: {ex.Message}");
                    return false;
                }
            }
            if (entry.Outcome != StartedOutcome && Appended is { } handlers)
            {
                foreach (var handler in handlers.GetInvocationList().Cast<Action<ArrAuditEntry>>())
                {
                    try
                    {
                        handler(entry);
                    }
                    catch (Exception)
                    {
                        // An observer (the activity log mirror) never breaks the audit.
                    }
                }
            }
            return true;
        }

        /// <summary>
        /// The newest entries first, across the current and rotated files: one per action (its result
        /// line), and an action that started but has no result line as "unknown".
        /// </summary>
        public IReadOnlyList<ArrAuditEntry> ReadRecent(int max)
        {
            var result = new List<ArrAuditEntry>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            lock (_lock)
            {
                foreach (var file in new[] { _path }.Concat(Enumerable.Range(1, _keep).Select(i => _path + "." + i)))
                {
                    if (result.Count >= max) break;
                    if (!File.Exists(file)) continue;
                    string[] lines;
                    try { lines = File.ReadAllLines(file); }
                    catch (IOException) { continue; }
                    for (var i = lines.Length - 1; i >= 0 && result.Count < max; i--)
                    {
                        if (string.IsNullOrWhiteSpace(lines[i])) continue;
                        try
                        {
                            var entry = JsonSerializer.Deserialize<ArrAuditEntry>(lines[i], Json);
                            if (entry == null || !seen.Add(entry.Id)) continue;   // newest line per id wins
                            if (entry.Outcome == StartedOutcome)
                            {
                                entry = new ArrAuditEntry
                                {
                                    Id = entry.Id, Time = entry.Time, UserId = entry.UserId, UserName = entry.UserName, Action = entry.Action, Tier = entry.Tier,
                                    InstanceId = entry.InstanceId, Target = entry.Target, Details = entry.Details,
                                    Outcome = "unknown",
                                    Message = "No result was recorded (still running, or Jellyfin stopped during the action). Check the instance.",
                                };
                            }
                            result.Add(entry);
                        }
                        catch (JsonException)
                        {
                            // A torn last line after a crash; skip it.
                        }
                    }
                }
            }
            return result;
        }

        private void Rotate()
        {
            var oldest = _path + "." + _keep;
            if (File.Exists(oldest)) File.Delete(oldest);
            for (var i = _keep - 1; i >= 1; i--)
            {
                var from = _path + "." + i;
                if (File.Exists(from)) File.Move(from, _path + "." + (i + 1));
            }
            File.Move(_path, _path + ".1");
        }
    }
}
