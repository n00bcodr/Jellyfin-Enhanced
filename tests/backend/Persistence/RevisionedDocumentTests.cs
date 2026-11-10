using System.Security.Cryptography;
using System.Text;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Persistence;
using Newtonsoft.Json.Linq;

namespace JE.Tests.Persistence;

public class RevisionedDocumentTests
{
    private const string User = "abcdefabcdefabcdefabcdefabcdefab";
    private const string FileName = "settings.json";

    [Fact]
    public async Task OnlyOneConcurrentExpectedRevisionWriteWinsAcrossManagersAndAliases()
    {
        using var f = new CoreFixture();
        f.Write(User, "{\"Count\":0,\"future\":{\"opaque\":[null,\"2026-01-01T00:00:00Z\",true]}}");
        var other = new UserConfigurationManager(f.Paths.Object, f.Logger);
        var initial = f.Manager.ReadUserConfigurationDocument(User, FileName);
        using var start = new Barrier(2);
        var invoked = 0;
        Task<bool> Run(UserConfigurationManager manager, string user) => Task.Run(() =>
        {
            Assert.True(start.SignalAndWait(TimeSpan.FromSeconds(10)));
            return manager.TryUpdateUserConfigurationDocument(user, FileName, initial.Revision, document =>
            {
                Interlocked.Increment(ref invoked);
                var obj = Assert.IsType<JObject>(document);
                obj["Count"] = 1;
                return obj;
            }, out _);
        });
        var results = await Task.WhenAll(Run(f.Manager, User), Run(other, Guid.Parse(User).ToString("D").ToUpperInvariant()));
        Assert.Single(results, won => won);
        Assert.Equal(1, invoked);
        var stored = f.Manager.ReadUserConfigurationDocument(User, FileName);
        Assert.True(JToken.DeepEquals(initial.Document?["future"], stored.Document?["future"]));
        Assert.Equal(1, stored.Document?["Count"]?.Value<int>());
        Assert.Empty(Directory.GetFiles(f.ConfigRoot, "*.tmp.*", SearchOption.AllDirectories));
    }

    [Fact]
    public void RejectedWriteLeavesOriginalBytesAndEventsUntouched()
    {
        using var f = new CoreFixture();
        var path = f.Write(User, " { \"Count\" : 5 }\n");
        var original = File.ReadAllBytes(path);
        var events = 0;
        f.Manager.UserConfigurationSaved += (_, _) => events++;
        Assert.False(f.Manager.TryUpdateUserConfigurationDocument(User, FileName, "wrong", _ => throw new Exception("must not run"), out var current));
        Assert.Equal(original, File.ReadAllBytes(path));
        Assert.Equal(0, events);
        Assert.Equal("sha256:" + Convert.ToHexStringLower(SHA256.HashData(original)), current.Revision);
        Assert.Throws<InvalidOperationException>(() => f.Manager.TryUpdateUserConfigurationDocument(User, FileName, current.Revision, document =>
        {
            Assert.IsType<JObject>(document)["Count"] = 999;
            throw new InvalidOperationException("validation failed");
        }, out _));
        Assert.Equal(original, File.ReadAllBytes(path));
        Assert.Equal(0, events);
    }

    [Fact]
    public void RevisionIsReconstructedFromBytesAndEveryOrdinaryContentChangeInvalidatesIt()
    {
        using var f = new CoreFixture();
        var path = f.Write(User, "{\"Count\":1}");
        var revision = f.Manager.ReadUserConfigurationDocument(User, FileName).Revision;
        Assert.Equal(revision, new UserConfigurationManager(f.Paths.Object, f.Logger).ReadUserConfigurationDocument(User, FileName).Revision);
        for (var count = 2; count < 5; count++)
        {
            f.Manager.SaveUserConfiguration(User, FileName, new CorePersistenceTests.Counter { Count = count });
            Assert.False(f.Manager.TryUpdateUserConfigurationDocument(User, FileName, revision, _ => throw new Exception("stale"), out var current));
            Assert.NotEqual(revision, current.Revision);
            revision = current.Revision;
        }
        File.AppendAllText(path, "\n");
        Assert.NotEqual(revision, f.Manager.ReadUserConfigurationDocument(User, FileName).Revision);
        Assert.Single(Directory.GetFiles(Path.GetDirectoryName(path)!));
    }

    [Fact]
    public void MissingIsExplicitAndCanBeCreatedWithCompareAndSwap()
    {
        using var f = new CoreFixture();
        var missing = f.Manager.ReadUserConfigurationDocument(User, FileName);
        Assert.False(missing.Exists);
        Assert.Null(missing.Document);
        Assert.Equal(UserConfigurationDocument.MissingRevision, missing.Revision);
        Assert.True(f.Manager.TryUpdateUserConfigurationDocument(User, FileName, missing.Revision, document =>
        {
            Assert.Null(document);
            return new JObject { ["Count"] = 1 };
        }, out var created));
        Assert.True(created.Exists);
        Assert.Equal(created.Revision, f.Manager.ReadUserConfigurationDocument(User, FileName).Revision);
        Assert.False(f.Manager.TryUpdateUserConfigurationDocument(User, FileName, missing.Revision, _ => new JObject(), out _));
    }

    [Theory]
    [InlineData("")][InlineData(" ")][InlineData("null")][InlineData("{broken")]
    [InlineData("{} {}")][InlineData("{\"a\":1,\"a\":2}")][InlineData("{\"a\":undefined}")]
    public void CorruptionIsNotMissingAndNewReadsAndWritesNeverQuarantineIt(string text)
    {
        using var f = new CoreFixture();
        var path = f.Write(User, text);
        Assert.Throws<InvalidDataException>(() => f.Manager.ReadUserConfigurationDocument(User, FileName));
        Assert.Throws<InvalidDataException>(() => f.Manager.TryUpdateUserConfigurationDocument(User, FileName, UserConfigurationDocument.MissingRevision, _ => new JObject(), out _));
        Assert.Equal(text, File.ReadAllText(path));
        Assert.Single(Directory.GetFiles(Path.GetDirectoryName(path)!));
    }

    [Fact]
    public void Utf8BomIsAcceptedAndIncludedInRevision()
    {
        using var f = new CoreFixture();
        var path = f.Write(User, "{}");
        File.WriteAllText(path, "{\"future\":null}", new UTF8Encoding(true));
        var document = f.Manager.ReadUserConfigurationDocument(User, FileName);
        Assert.Equal("sha256:" + Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(path))), document.Revision);
        Assert.Equal(JTokenType.Null, document.Document?["future"]?.Type);
    }

    [Fact]
    public async Task BlindSaveCannotEnterDuringRevisionMutationOrLegacyRmw()
    {
        using var f = new CoreFixture();
        var other = new UserConfigurationManager(f.Paths.Object, f.Logger);
        foreach (var revisioned in new[] { true, false })
        {
            f.Manager.SaveUserConfiguration(User, FileName, new CorePersistenceTests.Counter());
            using var insideMutation = new ManualResetEventSlim();
            using var releaseMutation = new ManualResetEventSlim();
            using var writerStarted = new ManualResetEventSlim();
            using var writerFinished = new ManualResetEventSlim();
            var mutation = Task.Run(() =>
            {
                void Wait()
                {
                    insideMutation.Set();
                    Assert.True(releaseMutation.Wait(TimeSpan.FromSeconds(10)));
                }
                if (revisioned)
                {
                    var revision = f.Manager.ReadUserConfigurationDocument(User, FileName).Revision;
                    Assert.True(f.Manager.TryUpdateUserConfigurationDocument(User, FileName, revision, _ =>
                    {
                        Wait();
                        return new JObject { ["Count"] = 1 };
                    }, out _));
                }
                else f.Manager.RmwUserConfiguration<CorePersistenceTests.Counter>(User, FileName, value => { Wait(); value.Count = 1; return 1; });
            });
            Assert.True(insideMutation.Wait(TimeSpan.FromSeconds(10)));
            var writer = Task.Run(() =>
            {
                writerStarted.Set();
                other.SaveUserConfiguration(User, FileName, new CorePersistenceTests.Counter { Count = 2 });
                writerFinished.Set();
            });
            try
            {
                Assert.True(writerStarted.Wait(TimeSpan.FromSeconds(10)));
                Assert.False(writerFinished.Wait(TimeSpan.FromMilliseconds(150)));
            }
            finally { releaseMutation.Set(); }
            await Task.WhenAll(mutation, writer);
            Assert.Equal(2, f.Manager.GetUserConfiguration<CorePersistenceTests.Counter>(User, FileName).Count);
        }
    }

    [Fact]
    public void SubscriberExceptionsDoNotSkipLaterInvalidationsForEitherSaveApi()
    {
        using var f = new CoreFixture();
        var notified = new List<string>();
        f.Manager.UserConfigurationSaved += (_, _) => throw new Exception("first failed");
        f.Manager.UserConfigurationSaved += (user, file) => notified.Add(user + "/" + file);
        f.Manager.UserConfigurationSaved += (_, _) => throw new Exception("third failed");
        f.Manager.UserConfigurationSaved += (_, _) => notified.Add("last");
        var alias = Guid.Parse(User).ToString("D").ToUpperInvariant();
        f.Manager.SaveUserConfiguration(alias, FileName, new JObject());
        var revision = f.Manager.ReadUserConfigurationDocument(User, FileName).Revision;
        Assert.True(f.Manager.TryUpdateUserConfigurationDocument(alias, FileName, revision, _ => new JObject { ["a"] = 1 }, out _));
        Assert.Equal(new[] { User + "/" + FileName, "last", User + "/" + FileName, "last" }, notified);
    }

    [Theory]
    [InlineData("../outside", "settings.json")][InlineData("foo/../bar", "settings.json")]
    [InlineData(".", "settings.json")][InlineData("", "settings.json")]
    [InlineData(User, "../outside.json")][InlineData(User, "foo/bar.json")][InlineData(User, "foo\\bar.json")]
    public void EveryRevisionOperationAndLockRejectPathEscapes(string user, string file)
    {
        using var f = new CoreFixture();
        Assert.ThrowsAny<Exception>(() => f.Manager.GetUserFileLock(user, file));
        Assert.ThrowsAny<Exception>(() => f.Manager.ReadUserConfigurationDocument(user, file));
        Assert.ThrowsAny<Exception>(() => f.Manager.TryUpdateUserConfigurationDocument(user, file, "missing", _ => new JObject(), out _));
    }

    [Fact]
    public void StoreRootsAreIsolatedAndNormalizedPathAliasesShareALock()
    {
        using var first = new CoreFixture();
        using var second = new CoreFixture();
        Assert.NotSame(first.Manager.GetUserFileLock(User, FileName), second.Manager.GetUserFileLock(User, FileName));
        var paths = new Moq.Mock<MediaBrowser.Common.Configuration.IApplicationPaths>();
        paths.SetupGet(p => p.PluginsPath).Returns(Path.Combine(first.Root, "."));
        var alias = new UserConfigurationManager(paths.Object, first.Logger);
        Assert.Same(first.Manager.GetUserFileLock(User, FileName), alias.GetUserFileLock(Guid.Parse(User).ToString("D").ToUpperInvariant(), FileName));
    }

    [Theory]
    [InlineData("0.1234567890123456789012345678")]
    [InlineData("0.123456789012345678901234567890123456789")]
    [InlineData("1e400")]
    [InlineData("1e-400")]
    [InlineData("123456789012345678901234567890123456789")]
    public void UnknownNumbersSurviveUnrelatedRawMutationsWithoutPrecisionOrTypeLoss(string literal)
    {
        using var f = new CoreFixture();
        var text = "{\"future\":[{\"number\":" + literal + "}],\"Count\":0}";
        var path = f.Write(User, text);
        var original = f.Manager.ReadUserConfigurationDocument(User, FileName);
        Assert.True(f.Manager.TryUpdateUserConfigurationDocument(User, FileName, original.Revision, document =>
        {
            var obj = Assert.IsType<JObject>(document);
            obj["Count"] = obj["Count"]!.Value<int>() + 1;
            return obj;
        }, out var committed));
        using var before = System.Text.Json.JsonDocument.Parse(text);
        using var after = System.Text.Json.JsonDocument.Parse(File.ReadAllText(path));
        var expected = before.RootElement.GetProperty("future");
        var actual = after.RootElement.GetProperty("future");
        Assert.Equal(System.Text.Json.JsonValueKind.Number, actual[0].GetProperty("number").ValueKind);
        Assert.True(System.Text.Json.JsonElement.DeepEquals(expected, actual));
        Assert.Equal(1, committed.Document?["Count"]?.Value<int>());
    }

    [Fact]
    public void NonFiniteClrMutationAndInvalidUtf8LeaveOriginalBytesUntouched()
    {
        using var f = new CoreFixture();
        var path = f.Write(User, "{}");
        var revision = f.Manager.ReadUserConfigurationDocument(User, FileName).Revision;
        foreach (var number in new[] { double.NaN, double.PositiveInfinity, double.NegativeInfinity })
            Assert.Throws<InvalidDataException>(() => f.Manager.TryUpdateUserConfigurationDocument(User, FileName, revision,
                _ => new JObject { ["nested"] = new JArray(number) }, out _));
        Assert.Equal("{}", File.ReadAllText(path));
        byte[] invalid = { (byte)'{', (byte)'"', (byte)'a', (byte)'"', (byte)':', (byte)'"', 0xff, (byte)'"', (byte)'}' };
        File.WriteAllBytes(path, invalid);
        Assert.Throws<InvalidDataException>(() => f.Manager.ReadUserConfigurationDocument(User, FileName));
        Assert.Equal(invalid, File.ReadAllBytes(path));
    }

    [Fact]
    public async Task TrustedStoreRootSymlinkAliasesUseOneLockAndOneCasWinner()
    {
        using var f = new CoreFixture();
        var link = f.Root + "-alias";
        Directory.CreateSymbolicLink(link, f.Root);
        try
        {
            var paths = new Moq.Mock<MediaBrowser.Common.Configuration.IApplicationPaths>();
            paths.SetupGet(p => p.PluginsPath).Returns(link);
            var alias = new UserConfigurationManager(paths.Object, f.Logger);
            Assert.Same(f.Manager.GetUserFileLock(User, FileName), alias.GetUserFileLock(User, FileName));
            f.Write(User, "{\"Count\":0}");
            var revision = f.Manager.ReadUserConfigurationDocument(User, FileName).Revision;
            using var start = new Barrier(2);
            Task<bool> Save(UserConfigurationManager manager, int count) => Task.Run(() =>
            {
                Assert.True(start.SignalAndWait(TimeSpan.FromSeconds(10)));
                return manager.TryUpdateUserConfigurationDocument(User, FileName, revision,
                    _ => new JObject { ["Count"] = count }, out _);
            });
            var winners = await Task.WhenAll(Save(f.Manager, 1), Save(alias, 2));
            Assert.Single(winners, value => value);
        }
        finally { Directory.Delete(link); }
    }

    [Fact]
    public void FailedReplacementCleansTemporaryFileAndEmitsNoEvent()
    {
        using var f = new CoreFixture();
        var path = f.Write(User, "{}");
        File.Delete(path);
        Directory.CreateDirectory(path);
        var events = 0;
        f.Manager.UserConfigurationSaved += (_, _) => events++;
        Assert.ThrowsAny<IOException>(() => f.Manager.SaveUserConfiguration(User, FileName, new JObject()));
        Assert.True(Directory.Exists(path));
        Assert.Empty(Directory.GetFiles(f.ConfigRoot, "*.tmp.*", SearchOption.AllDirectories));
        Assert.Equal(0, events);
    }

    [Fact]
    public void SymlinkedUserAndDocumentCannotEscapeOrAliasLocks()
    {
        using var f = new CoreFixture();
        var outside = Path.Combine(f.Root, "outside");
        Directory.CreateDirectory(outside);
        Directory.CreateSymbolicLink(Path.Combine(f.ConfigRoot, User), outside);
        Assert.Throws<InvalidOperationException>(() => f.Manager.SaveUserConfiguration(User, FileName, new JObject()));
        Assert.Empty(Directory.GetFiles(outside));
        Directory.Delete(Path.Combine(f.ConfigRoot, User));
        var path = f.Write(User, "{}");
        File.Delete(path);
        File.CreateSymbolicLink(path, Path.Combine(outside, FileName));
        Assert.Throws<InvalidOperationException>(() => f.Manager.ReadUserConfigurationDocument(User, FileName));
        Assert.Throws<InvalidOperationException>(() => f.Manager.SaveUserConfiguration(User, FileName, new JObject()));
    }
}
