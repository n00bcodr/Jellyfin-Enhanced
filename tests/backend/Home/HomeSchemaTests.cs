using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Home;
using Microsoft.Data.Sqlite;

namespace JE.Tests;

public class HomeSchemaTests
{
    [Fact]
    public void HomeAndStampsUseTheSamePermanentFirstContentFactAcrossEditions()
    {
        using var w = new StampWorld();
        var home = new HomeArrivals(w.Db, null, null, () => true);
        var at = StampWorld.T0;
        Assert.Null(home.FirstAt("movie:tmdb:603|4k"));
        w.Store.NoteArrival(new[] { "m|movie:tmdb:603|std" }, at, Guid.NewGuid());
        Assert.Equal(at, home.FirstAt("movie:tmdb:603|4k"));
        home.Record(new[] { ("movie:tmdb:603|4k", at.AddDays(-2)) });
        Assert.Equal(at.AddDays(-2), w.Store.FirstArrival(new[] { "m|movie:tmdb:603|std" }));
        w.Store.NoteArrival(new[] { "e|tv:tvdb:1|s1e2|4k" }, at, Guid.NewGuid());
        Assert.Equal(at, home.FirstAt("tv:tvdb:1:s1:e2"));
    }

    [Fact]
    public void RestoreRepairsAnEmptyStepSixAndRejectsUnknownSchemas()
    {
        var root = Path.Combine(Path.GetTempPath(), "je-home-restore-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var path = Path.Combine(root, "source.db");
            using (var c = new SqliteConnection("Data Source=" + path + ";Pooling=False"))
            {
                c.Open();
                using var cmd = c.CreateCommand();
                cmd.CommandText = string.Join("\n", AcquireDatabase.Migrations.Where((_, i) => i != 5)) + "PRAGMA user_version=7;";
                cmd.ExecuteNonQuery();
                cmd.CommandText = "INSERT INTO acquisition_arrivals VALUES('m|movie:tmdb:603|std',42,'old')";
                cmd.ExecuteNonQuery();
            }
            using var db = new AcquireDatabase(Path.Combine(root, "live.db"));
            var arrivals = new HomeArrivals(db, null, null, () => true);
            Assert.Null(arrivals.FirstAt("movie:tmdb:603|4k"));
            db.ReplaceWith(File.ReadAllBytes(path));
            Assert.Equal(7, db.Version);
            Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(42).UtcDateTime, arrivals.FirstAt("movie:tmdb:603|4k"));
            using (var c = new SqliteConnection("Data Source=" + path + ";Pooling=False"))
            {
                c.Open();
                using var cmd = c.CreateCommand();
                cmd.CommandText = "PRAGMA user_version=999;";
                cmd.ExecuteNonQuery();
            }
            using var future = new AcquireDatabase(path);
            Assert.False(future.Available);
            using var inspect = new SqliteConnection("Data Source=" + path + ";Pooling=False");
            inspect.Open();
            using var check = inspect.CreateCommand();
            check.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE name='home_arrivals'";
            Assert.Equal(0L, check.ExecuteScalar());
            check.CommandText = "PRAGMA user_version";
            Assert.Equal(999L, check.ExecuteScalar());
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            Directory.Delete(root, true);
        }
    }

    [Theory]
    [InlineData(0, false)]
    [InlineData(6, true)]
    [InlineData(6, false)]
    [InlineData(7, false)]
    public void StartupEnsuresTheTableWithoutLosingExistingArrivalData(int version, bool table)
    {
        var root = Path.Combine(Path.GetTempPath(), "je-home-schema-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, "acquire.db");
        try
        {
            if (version > 0)
            {
                using var c = new SqliteConnection("Data Source=" + path + ";Pooling=False");
                c.Open();
                using var cmd = c.CreateCommand();
                cmd.CommandText = string.Join("\n", AcquireDatabase.Migrations.Take(version).Select((sql, i) => i == 5 && !table ? "" : sql)) + $"\nPRAGMA user_version={version};";
                cmd.ExecuteNonQuery();
                if (table)
                {
                    cmd.CommandText = "INSERT INTO home_arrivals VALUES('movie:tmdb:603|std',42)";
                    cmd.ExecuteNonQuery();
                }
            }
            for (var start = 0; start < 2; start++)
            {
                using var db = new AcquireDatabase(path);
                Assert.True(db.Available, db.UnavailableReason);
                Assert.Equal(7, db.Version);
                Assert.Equal(1L, db.Read(c => { using var cmd = c.CreateCommand(); cmd.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE name='home_arrivals'"; return (long)cmd.ExecuteScalar()!; }));
                var arrivals = new HomeArrivals(db, null, null, () => true);
                if (table) Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(42).UtcDateTime, arrivals.FirstAt("movie:tmdb:603|std"));
                var date = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
                Assert.Equal(date, arrivals.FirstAtOrRecord("movie:tmdb:1|std", date));
            }
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            Directory.Delete(root, true);
        }
    }
}
