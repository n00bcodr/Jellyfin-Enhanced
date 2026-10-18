using System;
using System.Collections.Generic;
using System.Globalization;
using Microsoft.Data.Sqlite;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready
{
    /// <summary>
    /// The Ready playlist's tables in <c>acquire.db</c> (schema step 8, D47): one constant for the step-8 migration and for
    /// the start-up ensure, which runs on every supported start and after every restore. The ensure creates what is
    /// missing (tables, indexes), never seeds an opt-in, never resets a timestamp or a deletion, and never touches
    /// Jellyfin. It also applies the restore policy: a database a JE restore put in place needs each person to turn the
    /// Ready playlist on again before anything changes (pending native messages from it are never sent).
    /// </summary>
    internal static class ReadyTables
    {
        /// <summary>The meta key <see cref="AcquireDatabase.ReplaceWith"/> stamps a restored database with (a fresh value per restore).</summary>
        internal const string RestoredKey = "restored_marker";

        /// <summary>The meta key the ensure records the restore it has applied the policy for under.</summary>
        internal const string RestoreSeenKey = "ready_restore_seen";

        /// <summary>The meta key the ensure sets once every table, column and index is there.</summary>
        internal const string SchemaKey = "ready_schema";

        /// <summary>
        /// The tables. <c>ready_playlists</c>: one row per server and owner (consent, epoch, state, the managed playlist and
        /// its create marker, the membership journal). <c>ready_entries</c>: one row per interest and content coordinate
        /// (the version chosen, when it became ready, when it leaves, and whether it was watched or expired; several
        /// interests may point at one version). <c>ready_message_attempts</c>: a native message's claim before it is sent and
        /// whether Jellyfin accepted it (never whether a client showed it).
        /// </summary>
        internal const string Sql = @"
CREATE TABLE IF NOT EXISTS ready_playlists (
    server_id TEXT NOT NULL, user_id TEXT NOT NULL, opted_in INTEGER NOT NULL DEFAULT 0, opt_in_epoch INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'off', playlist_id TEXT, create_marker TEXT, pending_op TEXT, confirmed TEXT, confirmed_at INTEGER,
    missing_since INTEGER, missing_count INTEGER NOT NULL DEFAULT 0, reason TEXT, revision INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, user_id));
CREATE UNIQUE INDEX IF NOT EXISTS ready_playlists_playlist ON ready_playlists(server_id, playlist_id) WHERE playlist_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ready_playlists_user ON ready_playlists(user_id);
CREATE TABLE IF NOT EXISTS ready_entries (
    server_id TEXT NOT NULL, user_id TEXT NOT NULL, interest TEXT NOT NULL, part TEXT NOT NULL, title_key TEXT NOT NULL,
    edition TEXT NOT NULL, logical_id TEXT NOT NULL, series_id TEXT, playable_id TEXT, ready_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, disposition TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, user_id, interest, part));
CREATE INDEX IF NOT EXISTS ready_entries_user ON ready_entries(user_id);
CREATE TABLE IF NOT EXISTS ready_message_attempts (
    delivery_id INTEGER PRIMARY KEY REFERENCES deliveries(id) ON DELETE CASCADE, user_id TEXT NOT NULL, session TEXT,
    state TEXT NOT NULL, attempted_at INTEGER NOT NULL, accepted_at INTEGER, outcome TEXT);
CREATE INDEX IF NOT EXISTS ready_message_attempts_user ON ready_message_attempts(user_id, attempted_at);
";

        // Every column each table must have (a partial earlier ensure or a prototype is repaired, never rewritten).
        private static readonly (string Table, string Column, string Definition)[] Columns =
        {
            ("ready_playlists", "opted_in", "INTEGER NOT NULL DEFAULT 0"), ("ready_playlists", "opt_in_epoch", "INTEGER NOT NULL DEFAULT 0"),
            ("ready_playlists", "state", "TEXT NOT NULL DEFAULT 'off'"), ("ready_playlists", "playlist_id", "TEXT"),
            ("ready_playlists", "create_marker", "TEXT"), ("ready_playlists", "pending_op", "TEXT"), ("ready_playlists", "confirmed", "TEXT"),
            ("ready_playlists", "confirmed_at", "INTEGER"), ("ready_playlists", "missing_since", "INTEGER"),
            ("ready_playlists", "missing_count", "INTEGER NOT NULL DEFAULT 0"), ("ready_playlists", "reason", "TEXT"),
            ("ready_playlists", "revision", "INTEGER NOT NULL DEFAULT 0"), ("ready_playlists", "updated_at", "INTEGER NOT NULL DEFAULT 0"),
            ("ready_entries", "series_id", "TEXT"), ("ready_entries", "playable_id", "TEXT"),
            ("ready_entries", "disposition", "TEXT NOT NULL DEFAULT 'ready'"), ("ready_entries", "updated_at", "INTEGER NOT NULL DEFAULT 0"),
            ("ready_message_attempts", "session", "TEXT"), ("ready_message_attempts", "accepted_at", "INTEGER"), ("ready_message_attempts", "outcome", "TEXT"),
        };

        /// <summary>
        /// Creates whatever of the tables is missing and applies the restore policy, in one immediate transaction (under the
        /// database's initialization lock). Idempotent: a second run changes nothing.
        /// </summary>
        /// <param name="c">An open connection to a database at schema 8 or later.</param>
        internal static void Ensure(SqliteConnection c)
        {
            using var t = c.BeginTransaction(deferred: false);
            using var cmd = c.CreateCommand();
            cmd.Transaction = t;
            cmd.CommandText = Sql;
            cmd.ExecuteNonQuery();
            foreach (var (table, column, definition) in Columns)
            {
                cmd.CommandText = "SELECT COUNT(*) FROM pragma_table_info('" + table + "') WHERE name='" + column + "'";
                if (Convert.ToInt32(cmd.ExecuteScalar(), CultureInfo.InvariantCulture) == 0)
                {
                    cmd.CommandText = "ALTER TABLE " + table + " ADD COLUMN " + column + " " + definition;
                    cmd.ExecuteNonQuery();
                }
            }

            // The restore policy (D47): a database a restore put in place (stamped by ReplaceWith, inside its copy) needs
            // every person to turn the playlist on again before JE touches a restored binding, and its pending native
            // messages are never sent. Checked here as well as by the restore listener, so a stop between the copy and
            // the listener can't skip it.
            var restored = Meta(cmd, RestoredKey);
            if (restored != null && restored != Meta(cmd, RestoreSeenKey))
            {
                cmd.CommandText = "UPDATE ready_playlists SET opted_in=0, pending_op=NULL, missing_since=NULL, missing_count=0, revision=revision+1, "
                    + "state=CASE WHEN state IN ('active','privacy') THEN 'renew' ELSE state END, "
                    + "reason=CASE WHEN state IN ('active','privacy') THEN 'restored' ELSE reason END";
                cmd.ExecuteNonQuery();
                cmd.CommandText = "UPDATE deliveries SET status='suppressed', last_error='Restored from a backup: not sent.' WHERE channel='" + Notify.NotifyChannel.DisplayMessage + "' AND status='pending'";
                cmd.ExecuteNonQuery();
                SetMeta(cmd, RestoreSeenKey, restored);
            }

            SetMeta(cmd, SchemaKey, "1");
            t.Commit();
        }

        /// <summary>The tables, columns and indexes the ensure guarantees (tests compare a database against it).</summary>
        internal static IReadOnlyList<string> Objects { get; } = new[]
        {
            "ready_playlists", "ready_playlists_playlist", "ready_playlists_user", "ready_entries", "ready_entries_user",
            "ready_message_attempts", "ready_message_attempts_user",
        };

        private static string? Meta(SqliteCommand cmd, string key)
        {
            cmd.Parameters.Clear();
            cmd.CommandText = "SELECT value FROM meta WHERE key=$k";
            cmd.Parameters.AddWithValue("$k", key);
            var value = cmd.ExecuteScalar() as string;
            cmd.Parameters.Clear();
            return value;
        }

        private static void SetMeta(SqliteCommand cmd, string key, string value)
        {
            cmd.Parameters.Clear();
            cmd.CommandText = "INSERT INTO meta(key,value) VALUES($k,$v) ON CONFLICT(key) DO UPDATE SET value=excluded.value";
            cmd.Parameters.AddWithValue("$k", key);
            cmd.Parameters.AddWithValue("$v", value);
            cmd.ExecuteNonQuery();
            cmd.Parameters.Clear();
        }
    }
}
