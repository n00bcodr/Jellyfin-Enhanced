using System.IO.Compression;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Backup;

namespace JE.Tests;

/// <summary>
/// The Requests &amp; downloads database in JE backups: exported through SQLite's online backup (a
/// consistent copy of the live database; its WAL and pre-migration copies stay out), and restored
/// by swapping the live database under its writer lock, so the running server reads the restored
/// rows at once.
/// </summary>
[Collection("Plugin singleton")]
public class CoreAcquireDatabaseBackupTests
{
    [Fact]
    public void TheDatabaseIsBackedUpConsistentlyAndRestoredLive()
    {
        using var fixture = new ApiPluginFixture();
        var data = fixture.Core.ConfigRoot;
        Directory.CreateDirectory(data);
        using var db = new AcquireDatabase(fixture.Core.Paths.Object, fixture.Core.Logger);
        Assert.Same(db, AcquireDatabase.Shared);
        Assert.Equal(Path.Combine(data, AcquireDatabase.FileName), db.FilePath);
        var store = new NotifyStore(db);
        var user = Guid.NewGuid();
        store.SetFollow(user, "movie:tmdb:1", "title", false, false, DateTimeOffset.UtcNow);
        File.WriteAllText(Path.Combine(data, AcquireDatabase.FileName + ".pre-v0.20260101"), "old copy");
        var service = new JeBackupService(data, Path.Combine(fixture.Core.Root, "none.xml"), () => fixture.Plugin.Secrets, fixture.Core.Logger);

        using var zip = new MemoryStream();
        var manifest = service.Export(zip, JeBackupSecrets.Exclude, null);
        var names = manifest.Files.Select(f => f.Path).ToList();
        Assert.Contains("data/" + AcquireDatabase.FileName, names);
        Assert.DoesNotContain(names, n => n.Contains("-wal", StringComparison.Ordinal) || n.Contains("-shm", StringComparison.Ordinal) || n.Contains(".pre-v", StringComparison.Ordinal));

        // After the backup: a change, then the restore brings the backed-up rows back into the live database.
        store.SetFollow(user, "movie:tmdb:2", "title", false, false, DateTimeOffset.UtcNow);
        Assert.Equal(2, store.Follows(user).Count);
        zip.Position = 0;
        service.Restore(zip, null);
        Assert.Equal(new[] { "movie:tmdb:1" }, store.Follows(user).Select(f => f.Key));
        Assert.True(db.Available);
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
    }
}
