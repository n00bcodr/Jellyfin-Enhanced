using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Backup;
using Microsoft.Extensions.Logging;
using Moq;

namespace JE.Tests;

/// <summary>
/// Stage 1 fix round 11: a person's document is moved aside as corrupt only under its document lock, and only while it is
/// still the file that was read (RBS1-R11-8: a read that found it corrupt without the lock moved aside the document a
/// restore had just put in place); the start-up folder migration places files under the same locks; and a document's file
/// changed past JE's writers (its folder removed and made again, a file put back by hand) spends the revision handed out
/// before, like any write.
/// </summary>
[Collection("Plugin singleton")]
public class ApiDocumentFileIdentityTests
{
    private const string Hidden = "hidden-content.json";

    private static UserHiddenContent Doc(params string[] keys)
    {
        var doc = new UserHiddenContent();
        foreach (var key in keys) doc.Items[key] = new HiddenContentItem { ItemId = key };
        return doc;
    }

    // Stops the read that logs a corrupt spoilerblur.json until released (the read has found it corrupt, not acted yet).
    private sealed class StopAtCorruptRead(ManualResetEventSlim reached, ManualResetEventSlim release) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel level) => true;
        public void Log<TState>(LogLevel level, EventId id, TState state, Exception? ex, Func<TState, Exception?, string> format)
        {
            if (level != LogLevel.Error || !format(state, ex).StartsWith("Failed to parse 'spoilerblur.json'", StringComparison.Ordinal)) return;
            reached.Set();
            if (!release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException();
        }
    }

    [Fact]
    public async Task ADocumentRestoredWhileAReadFoundItCorruptIsAnsweredNotMovedAside()
    {
        using var f = new CoreFixture();
        using var reached = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var factory = new Mock<ILoggerFactory>();
        factory.Setup(x => x.CreateLogger(It.IsAny<string>())).Returns(new StopAtCorruptRead(reached, release));
        var manager = new UserConfigurationManager(f.Paths.Object, new Jellyfin.Plugin.JellyfinEnhanced.Logger(f.Paths.Object, factory.Object));
        var id = Guid.NewGuid().ToString("N");
        const string file = "spoilerblur.json";
        manager.SaveUserConfiguration(id, file, new UserSpoilerBlur { Prefs = new SpoilerBlurUserPrefs { HideCast = false } });
        var backup = new JeBackupService(f.ConfigRoot, Path.Combine(f.Root, "no-configuration.xml"), () => null, f.Logger);
        using var zip = new MemoryStream();
        backup.Export(zip, JeBackupSecrets.Exclude, null);
        File.WriteAllText(Path.Combine(f.ConfigRoot, id, file), "{bad-json");

        var read = Task.Run(() => manager.GetUserConfigurationStrict<UserSpoilerBlur>(id, file));
        Assert.True(reached.Wait(TimeSpan.FromSeconds(5)));
        try
        {
            zip.Position = 0;
            backup.Restore(zip, null);
            Assert.Equal(false, manager.GetUserConfiguration<UserSpoilerBlur>(id, file).Prefs.HideCast);
        }
        finally { release.Set(); }

        // The read answers the document now stored; nothing was moved aside.
        Assert.Equal(false, (await read).Prefs.HideCast);
        Assert.Equal(false, manager.GetUserConfiguration<UserSpoilerBlur>(id, file).Prefs.HideCast);
        Assert.Empty(Directory.GetFiles(Path.Combine(f.ConfigRoot, id), file + ".corrupt-*"));
    }

    [Fact]
    public void ADocumentStillCorruptUnderItsLockIsMovedAside()
    {
        using var f = new CoreFixture();
        var id = Guid.NewGuid().ToString("N");
        f.Manager.SaveUserConfiguration(id, Hidden, Doc("a"));
        File.WriteAllText(Path.Combine(f.ConfigRoot, id, Hidden), "{bad-json");
        Assert.ThrowsAny<Exception>(() => f.Manager.GetUserConfigurationStrict<UserHiddenContent>(id, Hidden));
        Assert.Single(Directory.GetFiles(Path.Combine(f.ConfigRoot, id), Hidden + ".corrupt-*"));
        Assert.Empty(f.Manager.GetUserConfigurationStrict<UserHiddenContent>(id, Hidden).Items);
    }

    [Fact]
    public async Task TheStartUpFolderMigrationWaitsForASaveInProgressAndItsDocumentStays()
    {
        using var f = new CoreFixture();
        var person = Guid.NewGuid();
        var user = person.ToString("N");
        f.Manager.SaveUserConfiguration(user, Hidden, Doc("old"));
        var before = f.Manager.RevisionOf(user, Hidden);
        // Another spelling of the person's folder, holding a newer copy (the migration merges it in: newer wins).
        var variant = Path.Combine(f.ConfigRoot, person.ToString("D"));
        Directory.CreateDirectory(variant);
        var variantFile = Path.Combine(variant, Hidden);
        File.WriteAllText(variantFile, System.Text.Json.JsonSerializer.Serialize(Doc("restored")));
        File.SetLastWriteTimeUtc(variantFile, DateTime.UtcNow.AddMinutes(1));
        using var reached = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        f.Manager.Saving = (_, name) =>
        {
            if (name != Hidden) return;
            reached.Set();
            if (!release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException();
        };
        var save = Task.Run(() => f.Manager.RmwUserConfiguration<UserHiddenContent>(user, Hidden, doc =>
        {
            doc.Items["local"] = new HiddenContentItem { ItemId = "local" };
            return 1;
        }));
        Assert.True(reached.Wait(TimeSpan.FromSeconds(5)));
        // Constructing the manager is the migration's production entry point (each server start).
        var migration = Task.Run(() => new UserConfigurationManager(f.Paths.Object, f.Logger));
        await Task.WhenAny(migration, Task.Delay(300));
        release.Set();
        await save;
        await migration;
        f.Manager.Saving = null;
        // The migration placed its (newer) copy after the save, not under it: the placed document is what is stored.
        Assert.Contains("restored", f.Manager.GetUserConfiguration<UserHiddenContent>(user, Hidden).Items.Keys);
        Assert.NotEqual(before, f.Manager.RevisionOf(user, Hidden));
    }

    [Fact]
    public void AFolderRemovedAndMadeAgainSpendsTheRevisionOfItsDocument()
    {
        using var f = new CoreFixture();
        var user = Guid.NewGuid().ToString("N");
        f.Manager.SaveUserConfiguration(user, Hidden, Doc("a"));
        var tag = f.Manager.RevisionOf(user, Hidden);
        Directory.Delete(Path.Combine(f.ConfigRoot, user), true);
        Directory.CreateDirectory(Path.Combine(f.ConfigRoot, user));
        var current = f.Manager.RevisionOf(user, Hidden);
        Assert.NotEqual(tag, current);
        var outcome = f.Manager.ReplaceUserDocument(user, Hidden, Doc("stale"), "\"" + tag + "\"");
        Assert.Equal(UserConfigurationManager.DocumentWrite.Conflict, outcome.Outcome);
    }

    [Fact]
    public void ADocumentPutBackByHandSpendsTheRevisionHandedOutBefore()
    {
        using var f = new CoreFixture();
        var user = Guid.NewGuid().ToString("N");
        f.Manager.SaveUserConfiguration(user, Hidden, Doc("a"));
        var tag = f.Manager.RevisionOf(user, Hidden);
        var path = Path.Combine(f.ConfigRoot, user, Hidden);
        File.WriteAllText(path, System.Text.Json.JsonSerializer.Serialize(Doc("a", "by-hand")));
        File.SetLastWriteTimeUtc(path, DateTime.UtcNow.AddSeconds(5));
        var outcome = f.Manager.ReplaceUserDocument(user, Hidden, Doc("a", "stale"), "\"" + tag + "\"");
        Assert.Equal(UserConfigurationManager.DocumentWrite.Conflict, outcome.Outcome);
        Assert.Contains("by-hand", f.Manager.GetUserConfiguration<UserHiddenContent>(user, Hidden).Items.Keys);
        // Unchanged since: the revision stays (a read and a write with it agree).
        var now = f.Manager.RevisionOf(user, Hidden);
        Assert.Equal(now, f.Manager.RevisionOf(user, Hidden));
        Assert.Equal(UserConfigurationManager.DocumentWrite.Saved, f.Manager.ReplaceUserDocument(user, Hidden, Doc("a", "next"), "\"" + now + "\"").Outcome);
    }
}
