using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Model;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class IntegrationD46PolicyBytesTests
{
    [Fact]
    public void PolicyFingerprintMemoIsBoundedAcrossUsers()
    {
        using var f = new CoreFixture();
        for (var i = 0; i < 48; i++)
        {
            var user = Guid.NewGuid().ToString("N");
            var state = new UserHiddenContent();
            f.Manager.SaveUserConfiguration(user, "hidden-content.json", state);
            using var scope = PrivacyReadSet.Begin();
            f.Manager.RecordPolicyRead(user, "hidden-content.json", state);
            Assert.True(scope.Reads.Valid());
        }
        Assert.InRange(f.Manager.PolicyMemoSize.Entries, 1, 32);
        Assert.InRange(f.Manager.PolicyMemoSize.Bytes, 1, 32 * 1024 * 1024);
    }

    [Theory]
    [InlineData("same-metadata")]
    [InlineData("rename")]
    [InlineData("delete")]
    [InlineData("recreate")]
    [InlineData("bad-json")]
    [InlineData("empty")]
    [InlineData("null")]
    public void EveryCheckReadsBytesEvenWithoutAPluginSave(string replacement)
    {
        using var f = new CoreFixture();
        var user = Guid.NewGuid().ToString("N");
        var state = new UserHiddenContent { Items = { ["one"] = new HiddenContentItem { ItemId = "one", Type = "Movie" } } };
        f.Manager.SaveUserConfiguration(user, "hidden-content.json", state);
        var path = Path.Combine(f.ConfigRoot, user, "hidden-content.json");
        using var scope = PrivacyReadSet.Begin();
        f.Manager.RecordPolicyRead(user, "hidden-content.json", state);
        Assert.True(scope.Reads.Valid(), scope.Reads.Failure);
        Assert.True(scope.Reads.Valid(), scope.Reads.Failure);
        Assert.Equal(1, f.Manager.PolicyNormalizations);
        var before = File.ReadAllText(path);
        var stamp = File.GetLastWriteTimeUtc(path);
        var changed = before.Replace("one", "two", StringComparison.Ordinal);
        Assert.Equal(before.Length, changed.Length);
        switch (replacement)
        {
            case "same-metadata":
                File.WriteAllText(path, changed);
                File.SetLastWriteTimeUtc(path, stamp);
                break;
            case "rename":
                File.WriteAllText(path + ".new", changed);
                File.Move(path + ".new", path, overwrite: true);
                break;
            case "delete": File.Delete(path); break;
            case "recreate": File.Delete(path); File.WriteAllText(path, changed); break;
            case "bad-json": File.WriteAllText(path, "{broken"); break;
            case "empty": File.WriteAllText(path, " "); break;
            case "null": File.WriteAllText(path, "null"); break;
        }
        Assert.False(scope.Reads.Valid(), "Fresh policy bytes changed outside JE's save path");
    }

    [Theory]
    [InlineData("")]
    [InlineData("null")]
    [InlineData("{broken")]
    public void LenientDefaultIsUnavailableEvidenceInsideAPrivacyAnswer(string invalid)
    {
        using var f = new CoreFixture();
        var user = Guid.NewGuid().ToString("N");
        f.Manager.SaveUserConfiguration(user, "hidden-content.json", new UserHiddenContent());
        var path = Path.Combine(f.ConfigRoot, user, "hidden-content.json");
        File.WriteAllText(path, invalid);
        using var scope = PrivacyReadSet.Begin();
        Assert.NotNull(f.Manager.GetUserConfiguration<UserHiddenContent>(user, "hidden-content.json"));
        Assert.False(scope.Reads.Valid(), "A lenient default must not authorize an unrecorded empty privacy policy");
        Assert.Equal(invalid, File.ReadAllText(path));
    }

    [Fact]
    public void EqualBytesInDifferentStoresAndUsersNeverBorrowAnotherPolicy()
    {
        using var a = new CoreFixture();
        using var b = new CoreFixture();
        var user = Guid.NewGuid().ToString("N");
        var state = new UserHiddenContent();
        a.Manager.SaveUserConfiguration(user, "hidden-content.json", state);
        b.Manager.SaveUserConfiguration(user, "hidden-content.json", state);
        using var first = PrivacyReadSet.Begin();
        a.Manager.RecordPolicyRead(user, "hidden-content.json", state);
        Assert.True(first.Reads.Valid());
        using var second = PrivacyReadSet.Begin();
        b.Manager.RecordPolicyRead(user, "hidden-content.json", state);
        Assert.True(second.Reads.Valid());
        Assert.Equal(1, a.Manager.PolicyNormalizations);
        Assert.Equal(1, b.Manager.PolicyNormalizations);
        File.WriteAllText(Path.Combine(b.ConfigRoot, user, "hidden-content.json"), "{broken");
        Assert.False(second.Reads.Valid());
        Assert.True(first.Reads.Valid());
    }
    [Fact]
    public async Task ConcurrentFreshByteChecksShareOneNormalization()
    {
        using var f = new CoreFixture();
        var user = Guid.NewGuid().ToString("N");
        var state = new UserHiddenContent();
        for (var i = 0; i < 100; i++)
        {
            var id = Guid.NewGuid().ToString("N");
            state.Items[id] = new HiddenContentItem { ItemId = id, Type = "Movie", HideScope = "global" };
        }
        f.Manager.SaveUserConfiguration(user, "hidden-content.json", state);
        var go = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var readers = Enumerable.Range(0, 8).Select(async _ =>
        {
            using var scope = PrivacyReadSet.Begin();
            f.Manager.RecordPolicyRead(user, "hidden-content.json", state);
            await go.Task.ConfigureAwait(false);
            Assert.True(scope.Reads.Valid(), scope.Reads.Failure);
        }).ToArray();
        go.SetResult();
        await Task.WhenAll(readers).WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(1, f.Manager.PolicyNormalizations);
        Assert.Equal(1, f.Manager.PolicyMemoSize.Entries);
    }

}
