using System;
using System.Collections.Generic;
using Microsoft.Data.Sqlite;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>
    /// One first-content-arrival fact, shared by home rows and acquisition stamps. An edition fulfils an edition
    /// request; it does not create new content. Legacy home and stamp keys are folded onto the same movie or episode.
    /// History is permanent, including after a file is removed, a badge expires or the database is restored.
    /// </summary>
    internal static class ContentArrivalHistory
    {
        internal const string Tables = @"
CREATE TABLE IF NOT EXISTS home_arrivals (content TEXT PRIMARY KEY, first_at INTEGER NOT NULL);";

        internal static string ContentKey(string key)
        {
            if (key.EndsWith("|std", StringComparison.Ordinal)) key = key[..^4];
            else if (key.EndsWith("|4k", StringComparison.Ordinal)) key = key[..^3];
            if (key.StartsWith("m|", StringComparison.Ordinal)) return key[2..];
            if (key.StartsWith("e|", StringComparison.Ordinal))
            {
                var split = key.LastIndexOf('|');
                if (split > 2)
                {
                    var part = key[(split + 1)..];
                    var e = part.IndexOf('e');
                    if (part.StartsWith('s') && e > 1) return key[2..split] + ":" + part[..e] + ":" + part[e..];
                }
            }
            return key;
        }

        internal static void Record(SqliteConnection c, SqliteTransaction t, string content, long at)
        {
            using var cmd = c.CreateCommand();
            cmd.Transaction = t;
            cmd.CommandText = "INSERT INTO home_arrivals(content,first_at) VALUES($c,$at) ON CONFLICT(content) DO UPDATE SET first_at=MIN(first_at,excluded.first_at)";
            cmd.Parameters.AddWithValue("$c", ContentKey(content));
            cmd.Parameters.AddWithValue("$at", at);
            cmd.ExecuteNonQuery();
        }

        // Called on every supported start, including after a restore. Keep all legacy rows for compatibility; neither
        // version numbers nor existing arrival dates are reset. Canonical rows only ever move earlier.
        internal static void Ensure(SqliteConnection c)
        {
            using var t = c.BeginTransaction(deferred: false);
            using var cmd = c.CreateCommand();
            cmd.Transaction = t;
            cmd.CommandText = Tables;
            cmd.ExecuteNonQuery();
            cmd.CommandText = "SELECT content,first_at FROM home_arrivals UNION ALL SELECT part_key,first_at FROM acquisition_arrivals";
            var rows = new List<(string, long)>();
            using (var reader = cmd.ExecuteReader())
            {
                while (reader.Read()) rows.Add((reader.GetString(0), reader.GetInt64(1)));
            }
            foreach (var (key, at) in rows)
                if (!key.StartsWith("src|", StringComparison.Ordinal)) Record(c, t, key, at);
            t.Commit();
        }

        // Millisecond precision matches the durable fact. Even a version added one second later is an upgrade;
        // media-probe settling is separate and must not turn edition fulfilment into a second content arrival.
        internal static bool IsLaterVersion(DateTime first, DateTime copy) => Ms(first) < Ms(copy);

        internal static bool InterestPrecedes(DateTime since, DateTime first) => Ms(since) <= Ms(first);

        internal static long Ms(DateTime at) => new DateTimeOffset(DateTime.SpecifyKind(at, DateTimeKind.Utc)).ToUnixTimeMilliseconds();
    }
}
