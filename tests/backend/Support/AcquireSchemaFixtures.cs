using Microsoft.Data.Sqlite;

namespace JE.Tests;

/// <summary>Older acquire.db layouts built from a current database file, for upgrade tests.</summary>
internal static class AcquireSchemaFixtures
{
    /// <summary>
    /// Turns a current acquire.db file back into schema 2 (an installation from before phase 4): the phase-4 origin
    /// columns, operations and automation tables removed and <c>user_version</c> 2, so opening it runs the schema-3
    /// migration (and its pre-migration copy) like a real upgrade.
    /// </summary>
    /// <param name="path">The database file (not open anywhere).</param>
    internal static void ToSchemaTwo(string path)
    {
        using var c = new SqliteConnection("Data Source=" + path + ";Pooling=False");
        c.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "DROP INDEX IF EXISTS wants_operation; ALTER TABLE wants DROP COLUMN origin_detail; ALTER TABLE wants DROP COLUMN operation_id; " +
            "DROP TABLE request_operations; DROP TABLE automation_budget; DROP TABLE automation_decisions; DROP TABLE automation_grants; DROP TABLE automation_breakers; PRAGMA user_version=2;";
        cmd.ExecuteNonQuery();
    }
}
