using Jellyfin.Plugin.JellyfinEnhanced;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Newtonsoft.Json;

namespace JE.Tests;

public class CorePersistenceTests
{
    private const string User = "abcdefabcdefabcdefabcdefabcdefab";
    public class Counter { public int Count { get; set; } }

    [Fact]
    public void CanonicalIdentityPersistsAcrossManagersAndIsolatesUsers()
    {
        using var f = new CoreFixture();
        var id = Guid.Parse(User);
        f.Manager.SaveUserConfiguration(id.ToString("D").ToUpperInvariant(), "settings.json", new UserSettings { DisplayLanguage = "日本語", AutoPauseEnabled = true });
        var reopened = new UserConfigurationManager(f.Paths.Object, f.Logger);
        Assert.Equal("日本語", reopened.GetUserConfiguration<UserSettings>(User, "settings.json").DisplayLanguage);
        Assert.False(reopened.GetUserConfiguration<UserSettings>(Guid.NewGuid().ToString("N"), "settings.json").AutoPauseEnabled);
        Assert.Same(f.Manager.GetUserFileLock(User, "settings.json"), reopened.GetUserFileLock(id.ToString("D").ToUpperInvariant(), "settings.json"));
        Assert.NotSame(f.Manager.GetUserFileLock(User, "settings.json"), reopened.GetUserFileLock(User, "other.json"));
    }

    [Theory]
    [InlineData("")][InlineData(" ")][InlineData("null")][InlineData("{broken")]
    public void CorruptReadsAreLenientButStrictReadsQuarantineExactlyOnce(string content)
    {
        using var f = new CoreFixture();
        var path = f.Write(User, content);
        Assert.Equal(5, f.Manager.GetUserConfiguration<UserSettings>(User, "settings.json").PauseScreenDelaySeconds);
        Assert.Equal(content, File.ReadAllText(path));
        Assert.ThrowsAny<Exception>(() => f.Manager.GetUserConfigurationStrict<UserSettings>(User, "settings.json"));
        Assert.False(File.Exists(path));
        Assert.Equal(content, File.ReadAllText(Assert.Single(Directory.GetFiles(Path.GetDirectoryName(path)!, "*.corrupt-*"))));
        Assert.Equal(5, f.Manager.GetUserConfigurationStrict<UserSettings>(User, "settings.json").PauseScreenDelaySeconds);
    }

    [Fact]
    public void ReadOnlyStrictCheckPreservesCorruptionAndSchemaNullsPreserveOtherValues()
    {
        using var f = new CoreFixture();
        var path = f.Write(User, "broken");
        Assert.ThrowsAny<Exception>(() => f.Manager.GetUserConfigurationStrict<UserSettings>(User, "settings.json", false));
        Assert.Equal("broken", File.ReadAllText(path));
        f.Write(User, "{\"AutoPauseEnabled\":null,\"DisplayLanguage\":\"fr\"}");
        Assert.Equal("fr", f.Manager.GetUserConfigurationStrict<UserSettings>(User, "settings.json").DisplayLanguage);
        Assert.False(f.Manager.GetUserConfiguration<UserSettings>(User, "settings.json").AutoPauseEnabled);
    }

    [Theory]
    [InlineData("../escape.json")][InlineData("/tmp/escape.json")][InlineData("a/b")][InlineData("a\\b")][InlineData("..")][InlineData("")]
    public void InvalidFilenamesCannotReadOrWriteOutsideUserDirectory(string name)
    {
        using var f = new CoreFixture();
        Assert.Throws<ArgumentException>(() => f.Manager.SaveUserConfiguration(User, name, new Counter()));
        Assert.Throws<ArgumentException>(() => f.Manager.GetUserConfiguration<Counter>(User, name));
        Assert.False(f.Manager.UserConfigurationExists(User, name));
    }

    [Theory]
    [InlineData("../outside")][InlineData("../../outside")][InlineData("/tmp/outside")][InlineData("")]
    public void EscapingUserDirectoriesAreRejected(string user)
    {
        using var f = new CoreFixture();
        Assert.Throws<InvalidOperationException>(() => f.Manager.SaveUserConfiguration(user, "settings.json", new Counter()));
    }

    [Fact]
    public void ConcurrentRmwAcrossManagersLosesNoUpdatesAndLeavesNoTemporaryFiles()
    {
        using var f = new CoreFixture();
        var other = new UserConfigurationManager(f.Paths.Object, f.Logger);
        Parallel.For(0, 100, i => (i % 2 == 0 ? f.Manager : other).RmwUserConfiguration<Counter>(User, "settings.json", c => { c.Count++; return 1; }));
        Assert.Equal(100, f.Manager.GetUserConfiguration<Counter>(User, "settings.json").Count);
        Assert.Empty(Directory.GetFiles(f.ConfigRoot, "*.tmp.*", SearchOption.AllDirectories));
        Assert.Equal(0, f.Manager.RmwUserConfiguration<Counter>(User, "unused.json", c => 0));
        Assert.False(f.Manager.UserConfigurationExists(User, "unused.json"));
    }

    public class Payload { public int Version { get; set; } public List<string> Items { get; set; } = new(); }

    [Fact]
    public async Task ConcurrentStrictReadsNeverSeeAHalfWrittenSave()
    {
        using var f = new CoreFixture();
        // Large enough that each write takes a while, so a non-atomic save would be read half-written.
        static Payload Make(int version) => new() { Version = version, Items = Enumerable.Range(0, 20000).Select(i => $"item-{version}-{i}-padding-padding-padding").ToList() };
        f.Manager.SaveUserConfiguration(User, "payload.json", Make(0));
        using var done = new CancellationTokenSource();
        var reads = 0;
        var savesStarted = false;
        // Handshakes instead of timing: the saves start only after a first read, and wait halfway
        // for a read that finished after they started, however slowly the pool schedules the reader.
        var firstRead = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var readDuringSaves = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var reader = Task.Run(() =>
        {
            while (!done.IsCancellationRequested)
            {
                // A torn read throws here (and would quarantine the user's valid file).
                var read = f.Manager.GetUserConfigurationStrict<Payload>(User, "payload.json");
                Assert.Equal(20000, read.Items.Count);
                Assert.Equal($"item-{read.Version}-19999-padding-padding-padding", read.Items[^1]);
                Interlocked.Increment(ref reads);
                firstRead.TrySetResult();
                if (Volatile.Read(ref savesStarted)) readDuringSaves.TrySetResult();
            }
        });
        try
        {
            // WhenAny with the reader so a failing first read surfaces instead of hanging.
            await Task.WhenAny(firstRead.Task, reader);
            Volatile.Write(ref savesStarted, true);
            for (var version = 1; version <= 30 && !reader.IsCompleted; version++)
            {
                f.Manager.SaveUserConfiguration(User, "payload.json", Make(version));
                if (version == 15) await Task.WhenAny(readDuringSaves.Task, reader);
            }
        }
        finally
        {
            done.Cancel();
        }
        await reader;
        Assert.True(readDuringSaves.Task.IsCompleted);
        Assert.True(Volatile.Read(ref reads) > 1);
        Assert.Empty(Directory.GetFiles(f.ConfigRoot, "*.corrupt-*", SearchOption.AllDirectories));
        Assert.Equal(30, f.Manager.GetUserConfigurationStrict<Payload>(User, "payload.json").Version);
    }

    [Fact]
    public void SaveSupportsJsonElementAndSubscriberFailuresDoNotLoseData()
    {
        using var f = new CoreFixture();
        string? notified = null;
        f.Manager.UserConfigurationSaved += (user, file) => { notified = user; throw new Exception("subscriber failure"); };
        using var document = System.Text.Json.JsonDocument.Parse("{\"Count\":42}");
        f.Manager.SaveUserConfiguration(Guid.Parse(User).ToString("D").ToUpperInvariant(), "settings.json", document.RootElement);
        Assert.Equal(User, notified);
        Assert.Equal(42, f.Manager.GetUserConfiguration<Counter>(User, "settings.json").Count);
    }

    [Fact]
    public void RawReadDistinguishesMissingEmptyAndStoredContent()
    {
        using var f = new CoreFixture();
        Assert.Null(f.Manager.TryReadUserConfigurationText(User, "settings.json"));
        f.Write(User, " \n");
        Assert.Equal("", f.Manager.TryReadUserConfigurationText(User, "settings.json"));
        f.Write(User, "{\"Count\":9}");
        Assert.Equal("{\"Count\":9}", f.Manager.TryReadUserConfigurationText(User, "settings.json"));
    }

    [Fact]
    public void CaseVariantMigrationKeepsNewerSettingsAndForensicCopyAndIsIdempotent()
    {
        using var f = new CoreFixture();
        var canonical = f.Write(User, "{\"Count\":1}");
        var variant = f.Write(Guid.Parse(User).ToString("D").ToUpperInvariant(), "{\"Count\":2}");
        File.SetLastWriteTimeUtc(canonical, new DateTime(2020, 1, 1));
        File.SetLastWriteTimeUtc(variant, new DateTime(2021, 1, 1));
        var migrated = new UserConfigurationManager(f.Paths.Object, f.Logger);
        Assert.Equal(2, migrated.GetUserConfiguration<Counter>(User, "settings.json").Count);
        Assert.Equal(new[] { User }, migrated.GetAllUserIds());
        var backups = Directory.GetDirectories(f.ConfigRoot, "*.migrated-*");
        Assert.Single(backups);
        var again = new UserConfigurationManager(f.Paths.Object, f.Logger);
        Assert.Equal(2, again.GetUserConfiguration<Counter>(User, "settings.json").Count);
        Assert.Equal(backups, Directory.GetDirectories(f.ConfigRoot, "*.migrated-*"));
    }

    [Fact]
    public void LoggerEscapesLineBreaksToPreventForgedEntries()
    {
        using var f = new CoreFixture();
        f.Logger.Warning("untrusted\r\n[INFO] forged");
        // The file name carries the date; whichever file the line landed in, it is the only one.
        var lines = File.ReadAllLines(Assert.Single(Directory.GetFiles(f.Root, "*.log")));
        Assert.Single(lines);
        Assert.Contains("untrusted\\r\\n[INFO] forged", lines[0]);
    }
}
