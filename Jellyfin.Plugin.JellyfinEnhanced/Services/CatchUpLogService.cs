using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using MediaBrowser.Common.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>One line of the Catch Up activity log (catchup-log.jsonl).</summary>
    public class CatchUpEvent
    {
        [JsonPropertyName("ts")] public string Ts { get; set; } = string.Empty;
        [JsonPropertyName("userId")] public string UserId { get; set; } = string.Empty;
        [JsonPropertyName("user")] public string User { get; set; } = string.Empty;
        /// <summary>Always "swipe".</summary>
        [JsonPropertyName("type")] public string Type { get; set; } = string.Empty;
        /// <summary>watched | dismiss | watchlist | open | undo (swipe events only).</summary>
        [JsonPropertyName("action")] public string? Action { get; set; }
        /// <summary>For action == "undo": the action that was reverted.</summary>
        [JsonPropertyName("undoOf")] public string? UndoOf { get; set; }
        [JsonPropertyName("itemId")] public string? ItemId { get; set; }
        /// <summary>Looked up from ItemId on the server.</summary>
        [JsonPropertyName("itemName")] public string? ItemName { get; set; }
        [JsonPropertyName("kind")] public string? Kind { get; set; }
        [JsonPropertyName("ok")] public bool? Ok { get; set; }
        /// <summary>Season numbers marked watched; a single "all" entry means the whole series.</summary>
        [JsonPropertyName("seasons")] public List<string>? Seasons { get; set; }
    }

    public class CatchUpUserSummary
    {
        [JsonPropertyName("user")] public string User { get; set; } = string.Empty;
        [JsonPropertyName("lastSeen")] public string? LastSeen { get; set; }
        [JsonPropertyName("watched")] public int Watched { get; set; }
        [JsonPropertyName("dismiss")] public int Dismiss { get; set; }
        [JsonPropertyName("watchlist")] public int Watchlist { get; set; }
    }

    public class CatchUpTopItem
    {
        [JsonPropertyName("itemId")] public string ItemId { get; set; } = string.Empty;
        [JsonPropertyName("name")] public string? Name { get; set; }
        [JsonPropertyName("kind")] public string? Kind { get; set; }
        [JsonPropertyName("count")] public int Count { get; set; }
        [JsonPropertyName("users")] public List<string> Users { get; set; } = new();
    }

    public class CatchUpSummary
    {
        [JsonPropertyName("users")] public List<CatchUpUserSummary> Users { get; set; } = new();
        [JsonPropertyName("topWatched")] public List<CatchUpTopItem> TopWatched { get; set; } = new();
        [JsonPropertyName("topDismissed")] public List<CatchUpTopItem> TopDismissed { get; set; } = new();
        [JsonPropertyName("topWatchlisted")] public List<CatchUpTopItem> TopWatchlisted { get; set; } = new();
    }

    /// <summary>
    /// Append-only JSONL log of who swiped what on the Catch Up page.
    /// Stored next to the plugin's other shared files. When the live file passes <see cref="MaxBytes"/>
    /// it moves to catchup-log.1.jsonl (replacing the older one), so history covers the last one to two files.
    /// </summary>
    public class CatchUpLogService
    {
        private const long MaxBytes = 5 * 1024 * 1024;
        private static readonly string[] Actions = { "watched", "dismiss", "watchlist", "open", "undo" };

        private readonly string _livePath;
        private readonly string _rotatedPath;
        private readonly object _lock = new();
        private readonly Logger _logger;

        public CatchUpLogService(IApplicationPaths appPaths, Logger logger)
        {
            var dir = Path.Combine(appPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced");
            Directory.CreateDirectory(dir);
            _livePath = Path.Combine(dir, "catchup-log.jsonl");
            _rotatedPath = Path.Combine(dir, "catchup-log.1.jsonl");
            _logger = logger;
        }

        public static bool IsKnownAction(string? action) => action != null && Actions.Contains(action);

        public void Append(CatchUpEvent ev)
        {
            var line = JsonSerializer.Serialize(ev) + "\n";
            lock (_lock)
            {
                try
                {
                    if (File.Exists(_livePath) && new FileInfo(_livePath).Length > MaxBytes)
                    {
                        File.Move(_livePath, _rotatedPath, overwrite: true);
                    }
                    File.AppendAllText(_livePath, line, new UTF8Encoding(false));
                }
                catch (Exception ex)
                {
                    _logger.Error($"[CatchUp] Failed to write catch up log: {ex.Message}");
                }
            }
        }

        /// <summary>All events, oldest first (rotated file, then live file). Corrupt lines are skipped.</summary>
        public List<CatchUpEvent> ReadAll()
        {
            var events = new List<CatchUpEvent>();
            lock (_lock)
            {
                foreach (var path in new[] { _rotatedPath, _livePath })
                {
                    if (!File.Exists(path)) continue;
                    try
                    {
                        foreach (var line in File.ReadLines(path))
                        {
                            if (string.IsNullOrWhiteSpace(line)) continue;
                            try
                            {
                                var ev = JsonSerializer.Deserialize<CatchUpEvent>(line);
                                if (ev != null) events.Add(ev);
                            }
                            catch (JsonException) { /* skip a broken line */ }
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger.Error($"[CatchUp] Failed to read {Path.GetFileName(path)}: {ex.Message}");
                    }
                }
            }
            return events;
        }

        /// <summary>
        /// Per-user totals (an undo cancels the earlier mark) and the most watched, dismissed and
        /// watchlisted titles. Events must be oldest first.
        /// </summary>
        public static CatchUpSummary Summarize(IReadOnlyList<CatchUpEvent> events)
        {
            var perUser = new Dictionary<string, (CatchUpUserSummary Summary, Dictionary<string, Dictionary<string, (string? Name, string? Kind)>> Sets)>(StringComparer.OrdinalIgnoreCase);
            foreach (var e in events)
            {
                if (!perUser.TryGetValue(e.User, out var u))
                {
                    u = (new CatchUpUserSummary { User = e.User }, new Dictionary<string, Dictionary<string, (string?, string?)>>
                    {
                        ["watched"] = new(), ["dismiss"] = new(), ["watchlist"] = new()
                    });
                    perUser[e.User] = u;
                }
                u.Summary.LastSeen = e.Ts;
                if (e.Type != "swipe" || e.Ok == false || string.IsNullOrEmpty(e.ItemId)) continue;

                if (e.Action != null && u.Sets.TryGetValue(e.Action, out var set))
                {
                    set[e.ItemId] = (e.ItemName, e.Kind);
                }
                else if (e.Action == "undo" && e.UndoOf != null && u.Sets.TryGetValue(e.UndoOf, out var undone))
                {
                    undone.Remove(e.ItemId);
                }
            }

            var summary = new CatchUpSummary();
            var tops = new Dictionary<string, Dictionary<string, CatchUpTopItem>>
            {
                ["watched"] = new(), ["dismiss"] = new(), ["watchlist"] = new()
            };
            foreach (var (name, (sum, sets)) in perUser.OrderBy(p => p.Key, StringComparer.OrdinalIgnoreCase))
            {
                sum.Watched = sets["watched"].Count;
                sum.Dismiss = sets["dismiss"].Count;
                sum.Watchlist = sets["watchlist"].Count;
                summary.Users.Add(sum);
                foreach (var (action, items) in sets)
                {
                    foreach (var (itemId, meta) in items)
                    {
                        if (!tops[action].TryGetValue(itemId, out var top))
                        {
                            top = new CatchUpTopItem { ItemId = itemId, Name = meta.Name, Kind = meta.Kind };
                            tops[action][itemId] = top;
                        }
                        top.Count++;
                        top.Users.Add(name);
                    }
                }
            }

            List<CatchUpTopItem> Top(string action) => tops[action].Values
                .OrderByDescending(t => t.Count).ThenBy(t => t.Name, StringComparer.OrdinalIgnoreCase).Take(15).ToList();
            summary.TopWatched = Top("watched");
            summary.TopDismissed = Top("dismiss");
            summary.TopWatchlisted = Top("watchlist");
            return summary;
        }
    }
}
