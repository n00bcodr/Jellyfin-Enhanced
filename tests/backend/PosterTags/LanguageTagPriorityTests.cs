using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using MediaBrowser.Controller.Library;
using Moq;

namespace JE.Tests;

public class LanguageTagPriorityTests
{
    private static LanguageTag[] Tags(PosterTagSettings settings, string[]? audio = null, string[]? subtitles = null, string[]? partial = null) =>
        PosterTagResolver.Resolve(new TagCacheEntry { Type = "Series", AudioLanguages = audio ?? ["eng", "jpn", "fra"], SubtitleLanguages = subtitles, PartialAudioLanguages = partial },
            settings, new PosterTagItemContext("Series", false, null, null, null), false)?.Groups.Single().Tags.Cast<LanguageTag>().ToArray() ?? [];

    [Theory]
    [InlineData(null, true, "jp")]
    [InlineData(false, false, "jp,gb,fr")]
    [InlineData(true, true, "jp")]
    public void PersonalListWinsOverAdminAndStrictInheritsUnlessOverridden(bool? strict, bool effective, string flags)
    {
        var config = new PluginConfiguration { LanguageTagsPriority = "French", LanguageTagsPriorityStrict = true };
        var json = System.Text.Json.JsonSerializer.Serialize(new JellyfinEnhancedUserSettings { LanguageTagsEnabled = true, LanguageTagsPriority = ["jpn"], LanguageTagsPriorityStrict = strict });
        var settings = PosterTagSettings.FromSettingsJson(json, config);
        Assert.True(settings.LanguagePriorityIsPersonal);
        Assert.Equal(effective, settings.LanguagePriorityStrict);
        Assert.Equal(new[] { "ja" }, settings.LanguagePriorityTerms);
        Assert.Equal(flags.Split(','), Tags(settings).Select(t => t.FlagCode));
    }

    [Fact]
    public void CanonicalMatchingIncludesAllLanguagesSharingAFlagAndEveryRegion()
    {
        var settings = PosterTagSettings.FromSettingsJson("{\"LanguageTagsEnabled\":true,\"LanguageTagsPriority\":[\"tam\",\"eng\",\"por\"],\"LanguageTagsPriorityStrict\":true,\"TagLayoutSettingsVersion\":1,\"TagGroupCaps\":{\"Language\":0}}", new PluginConfiguration());
        var tags = Tags(settings, ["hin", "tam", "eng", "en-US", "pt-BR", "por"], partial: ["tam"]);
        Assert.Equal(new[] { "in", "gb", "us", "br", "pt" }, tags.Select(t => t.FlagCode));
        Assert.Contains("Tamil", tags[0].Language);
        Assert.False(tags[0].Partial);
        Assert.Equal(new[] { "jp", "gb", "fr" }, Tags(PosterTagSettings.FromSettingsJson("{\"LanguageTagsEnabled\":true,\"LanguageTagsPriority\":[\"ja\"]}", new PluginConfiguration()), partial: ["jpn"]).Select(t => t.FlagCode));
    }

    [Fact]
    public void SubtitlesAndCountBadgeUseTheSameFilteredPolicyBeforeTheCombinedCap()
    {
        var config = new PluginConfiguration { LanguageTagsPriorityStrict = true };
        var settings = PosterTagSettings.FromSettingsJson("{\"LanguageTagsEnabled\":true,\"LanguageTagsShowSubtitles\":true,\"LanguageTagsCountBadge\":\"only\",\"LanguageTagsPriority\":[\"ja\",\"fr\"]}", config);
        var tags = Tags(settings, subtitles: ["eng", "fra", "jpn"]);
        Assert.Equal("Dual", tags[0].CountBadge);
        Assert.Equal(new[] { "jp", "fr" }, tags.Skip(1).Select(t => t.FlagCode));
        Assert.All(tags.Skip(1), t => Assert.True(t.Subtitle));
    }

    [Fact]
    public void FollowingServerKeepsLegacyMatchingAndEmptyPersonalListRemovesItsFiltering()
    {
        var config = new PluginConfiguration { LanguageTagsPriority = "French", LanguageTagsPriorityStrict = true };
        var baseline = PosterTagSettings.FromSettingsJson("{\"LanguageTagsEnabled\":true}", config);
        var follow = PosterTagSettings.FromSettingsJson("{\"LanguageTagsEnabled\":true,\"LanguageTagsPriority\":null,\"LanguageTagsPriorityStrict\":null}", config);
        Assert.Equal(baseline.Digest, follow.Digest);
        Assert.False(follow.LanguagePriorityIsPersonal);
        Assert.Equal(new[] { "fr" }, Tags(follow).Select(t => t.FlagCode));
        var empty = PosterTagSettings.FromSettingsJson("{\"LanguageTagsEnabled\":true,\"LanguageTagsPriority\":[]}", config);
        Assert.Equal(new[] { "gb", "jp", "fr" }, Tags(empty).Select(t => t.FlagCode));
        Assert.NotEqual(follow.Digest, empty.Digest);
        config.LanguageTagsPriority = "Japanese";
        Assert.Equal(new[] { "jp" }, Tags(PosterTagSettings.FromSettingsJson("{\"LanguageTagsEnabled\":true}", config)).Select(t => t.FlagCode));
    }

    [Fact]
    public void EquivalentListsShareADigestButPersonalOrderAndStrictModeChangeTokens()
    {
        var config = new PluginConfiguration { LanguageTagsPriority = "ja,en" };
        PosterTagSettings Read(string extra) => PosterTagSettings.FromSettingsJson("{\"LanguageTagsEnabled\":true," + extra + "}", config);
        var a = Read("\"LanguageTagsPriority\":[\"jpn\",\"eng\"]");
        Assert.Equal(a.Digest, Read("\"LanguageTagsPriority\":[\"ja\",\"en\",\"eng\"]").Digest);
        var b = Read("\"LanguageTagsPriority\":[\"en\",\"ja\"]");
        var strict = Read("\"LanguageTagsPriority\":[\"ja\",\"en\"],\"LanguageTagsPriorityStrict\":true");
        Assert.NotEqual(a.Digest, b.Digest);
        Assert.NotEqual(a.Digest, strict.Digest);
        Assert.NotEqual(a.Digest, Read("\"LanguageTagsPriority\":null").Digest);
        var directory = Path.Combine(Path.GetTempPath(), "je-language-priority-" + Guid.NewGuid().ToString("N"));
        try
        {
            var tokens = PosterTagVariantToken.CreateForPath(Path.Combine(directory, "key"), _ => { });
            var user = Guid.NewGuid(); var item = Guid.NewGuid();
            var token = tokens.Mint(user, item, a.Digest, PosterTagComposer.PixelVersion, PosterTagVariantFlags.None, "abcdef");
            Assert.True(tokens.Verify(token, user, item, a.Digest, PosterTagComposer.PixelVersion, out _));
            Assert.False(tokens.Verify(token, user, item, b.Digest, PosterTagComposer.PixelVersion, out _));
            Assert.False(tokens.Verify(token, user, item, strict.Digest, PosterTagComposer.PixelVersion, out _));
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
    }

    [Theory]
    [InlineData("[\"Japanese\"]")]
    [InlineData("[\"ja-JP\"]")]
    [InlineData("[null]")]
    public void InvalidHandEditedListsSafelyFollowServer(string list)
    {
        var settings = PosterTagSettings.FromSettingsJson("{\"LanguageTagsEnabled\":true,\"LanguageTagsPriority\":" + list + "}", new PluginConfiguration { LanguageTagsPriority = "French", LanguageTagsPriorityStrict = true });
        Assert.False(settings.LanguagePriorityIsPersonal);
        Assert.Equal(new[] { "fr" }, Tags(settings).Select(t => t.FlagCode));
    }
}

[Collection("Plugin singleton")]
public class LanguageTagPriorityCacheTests
{
    [Fact]
    public void PersonalSaveInvalidatesTheUserSnapshotAndDoesNotChangeAnotherUsersDigest()
    {
        using var f = new ApiPluginFixture();
        using var provider = new PosterTagSettingsProvider(f.Core.Manager, new PosterTagUserCache(Mock.Of<IUserManager>()));
        var alice = Guid.NewGuid(); var bob = Guid.NewGuid();
        f.Core.Manager.SaveUserConfiguration(alice.ToString("N"), "settings.json", new JellyfinEnhancedUserSettings { LanguageTagsEnabled = true });
        f.Core.Manager.SaveUserConfiguration(bob.ToString("N"), "settings.json", new JellyfinEnhancedUserSettings { LanguageTagsEnabled = true });
        var before = provider.Get(alice); var other = provider.Get(bob);
        f.Core.Manager.SaveUserConfiguration(alice.ToString("N"), "settings.json", new JellyfinEnhancedUserSettings { LanguageTagsEnabled = true, LanguageTagsPriority = ["ja", "en"] });
        var after = provider.Get(alice);
        Assert.NotSame(before, after);
        Assert.NotEqual(before.Digest, after.Digest);
        Assert.Equal(new[] { "ja", "en" }, after.LanguagePriorityTerms);
        Assert.Equal(other.Digest, provider.Get(bob).Digest);
        Assert.False(provider.Get(bob).LanguagePriorityIsPersonal);
    }
}
