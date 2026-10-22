using System.Reflection;
using System.Runtime.CompilerServices;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;

namespace JE.Tests;

/// <summary>
/// Stage 1 fix round 12: a per-user document and its revision are one snapshot, taken under the document's lock
/// (RBS1-R12-6). The read sampled the revision, read, sampled again and, when a write had landed in between, read once more
/// without the lock and paired that document with the second sample: a second writer could then make one revision name
/// both an intermediate and the final document.
/// </summary>
[Collection("Plugin singleton")]
public class ApiDocumentSnapshotTests
{
    [Fact]
    public void ARevisionMustNotNameBothTheIntermediateAndTheFinalDocument()
    {
        using var f = new CoreFixture();
        var id = Guid.NewGuid().ToString("N");
        const string file = "elsewhere.json";
        void Put(string value) => f.Manager.RmwUserConfiguration<ElsewhereSettings>(id, file, d => { d.Region = value; return 1; });
        Put("US");
        var controller = (JellyfinEnhancedController)RuntimeHelpers.GetUninitializedObject(typeof(JellyfinEnhancedController));
        typeof(JellyfinEnhancedController).GetField("_userConfigurationManager", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(controller, f.Manager);
        var method = typeof(JellyfinEnhancedController).GetMethod("ReadWithRevision", BindingFlags.Instance | BindingFlags.NonPublic)!.MakeGenericMethod(typeof(ElsewhereSettings));
        int reads = 0;
        var tags = new Dictionary<string, string> { [f.Manager.RevisionOf(id, file)] = "US" };
        var writers = new List<Thread>();
        bool ConcurrentWrite(string value)
        {
            var thread = new Thread(() => Put(value));
            writers.Add(thread);
            thread.Start();
            // A correct reader holds the document lock: the other thread then waits and this read answers its old pair.
            // Without the lock, the write completes here and deterministically lands in the read's race window.
            if (!thread.Join(500)) return false;
            tags[f.Manager.RevisionOf(id, file)] = value;
            return true;
        }
        Func<ElsewhereSettings> read = () =>
        {
            var value = f.Manager.GetUserConfiguration<ElsewhereSettings>(id, file);
            if (++reads == 1)
            {
                ConcurrentWrite("DE");
                return value;
            }
            ConcurrentWrite("NZ");
            return f.Manager.GetUserConfiguration<ElsewhereSettings>(id, file);
        };
        var result = ((ElsewhereSettings Document, string Revision))method.Invoke(controller, new object[] { id, file, read })!;
        foreach (var thread in writers) Assert.True(thread.Join(3000));
        Assert.True(tags.TryGetValue(result.Revision, out var named), "the revision must name an observed document");
        Assert.Equal(named, result.Document.Region);
    }

    private static (T Document, string Revision) Read<T>(CoreFixture f, string id, string file, Func<T> read)
    {
        var controller = (JellyfinEnhancedController)RuntimeHelpers.GetUninitializedObject(typeof(JellyfinEnhancedController));
        typeof(JellyfinEnhancedController).GetField("_userConfigurationManager", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(controller, f.Manager);
        var method = typeof(JellyfinEnhancedController).GetMethod("ReadWithRevision", BindingFlags.Instance | BindingFlags.NonPublic)!.MakeGenericMethod(typeof(T));
        return ((T Document, string Revision))method.Invoke(controller, new object[] { id, file, read })!;
    }

    [Fact]
    public void AFirstReadsDefaultsAreStoredInsideTheSnapshotAndAnsweredWithTheirRevision()
    {
        using var f = new CoreFixture();
        var id = Guid.NewGuid().ToString("N");
        const string file = UserConfigurationManager.SettingsFileName;
        Thread? writer = null;
        var result = Read(f, id, file, () =>
        {
            // The defaults of a first read are stored by the read itself; a writer arriving meanwhile waits for the snapshot.
            f.Manager.SeedUserSettings(id, new JellyfinEnhancedUserSettings { AutoPauseEnabled = true });
            writer = new Thread(() => f.Manager.RmwUserConfiguration<JellyfinEnhancedUserSettings>(id, file, d => { d.AutoPauseEnabled = false; return 1; }));
            writer.Start();
            Assert.False(writer.Join(300), "the writer waits for the document's lock");
            return f.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(id, file);
        });
        var seeded = result.Revision;
        Assert.True(result.Document.AutoPauseEnabled, "the answered document is the seeded one");
        Assert.True(writer!.Join(3000));
        var after = f.Manager.RevisionOf(id, file);
        Assert.NotEqual(seeded, after);
        Assert.False(f.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(id, file).AutoPauseEnabled);
        // A read now names the writer's document with the writer's revision.
        var again = Read(f, id, file, () => f.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(id, file));
        Assert.Equal(after, again.Revision);
        Assert.False(again.Document.AutoPauseEnabled);
    }

    [Fact]
    public void ReadsRacingAWriterAlwaysPairEachDocumentWithItsOwnRevision()
    {
        using var f = new CoreFixture();
        var id = Guid.NewGuid().ToString("N");
        const string file = "elsewhere.json";
        f.Manager.RmwUserConfiguration<ElsewhereSettings>(id, file, d => { d.Region = "R0"; return 1; });
        var named = new System.Collections.Concurrent.ConcurrentDictionary<string, string>();
        named[f.Manager.RevisionOf(id, file)] = "R0";
        var stop = false;
        var writer = new Thread(() =>
        {
            for (var n = 1; n <= 40 && !Volatile.Read(ref stop); n++)
            {
                var region = "R" + n;
                lock (f.Manager.GetUserFileLock(id, file))
                {
                    f.Manager.RmwUserConfiguration<ElsewhereSettings>(id, file, d => { d.Region = region; return 1; });
                    named[f.Manager.RevisionOf(id, file)] = region;
                }
            }
        });
        writer.Start();
        var pairs = new List<(string Revision, string Region)>();
        for (var i = 0; i < 40; i++)
        {
            var read = Read(f, id, file, () => f.Manager.GetUserConfiguration<ElsewhereSettings>(id, file));
            pairs.Add((read.Revision, read.Document.Region));
        }
        Volatile.Write(ref stop, true);
        Assert.True(writer.Join(5000));
        foreach (var (revision, region) in pairs)
        {
            Assert.True(named.TryGetValue(revision, out var expected), $"revision {revision} names a document that was stored");
            Assert.Equal(expected, region);
        }
    }
}
