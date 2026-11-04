using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class QualityDisplayTests
{
    private static TagStreamData Streams() => new()
    {
        Streams = [new() { Type = "Video", Height = 1080, Codec = "h264", VideoRangeType = "SDR" },
            new() { Type = "Video", Height = 2160, Codec = "hevc", VideoRangeType = "HDR10" },
            new() { Type = "Video", Height = 2160, Codec = "hevc", VideoRangeType = "HDR10" },
            new() { Type = "Audio", Language = "eng", DisplayTitle = "DTS 5.1", Channels = 6 },
            new() { Type = "Audio", Language = "eng", DisplayTitle = "ATMOS 7.1", Channels = 8 },
            new() { Type = "Audio", Language = "eng", DisplayTitle = "DTS 7.1", Channels = 8 },
            new() { Type = "Audio", Language = "deu", DisplayTitle = "TRUEHD 5.1", Channels = 6 }],
    };
    private static PosterTagSettings Settings(string policy = "representative", int cap = 0) => PosterTagSettings.FromUserSettings(new()
    {
        QualityTagsEnabled = true, QualityAudioDisplayMode = "all", QualityVideoCodecDisplayMode = "all", QualityHdrDisplayMode = "all",
        SeriesQualityAggregation = policy, TagLayoutSettingsVersion = 1, TagGroupCaps = new() { Quality = cap },
    }, new(), null);

    private static string[] Labels(TagCacheEntry entry, PosterTagSettings settings) => PosterTagResolver.Resolve(entry, settings,
        new(entry.Type ?? "Movie", false, null, null, null), false)?.Groups.SelectMany(group => group.Tags).OfType<QualityTag>().Select(tag => tag.DisplayText ?? tag.Label).ToArray() ?? [];

    [Fact]
    public void LegacyFullAudioStreamFactsKeepTheirPreviousChips()
    {
        using var stream = typeof(QualityDisplayTests).Assembly.GetManifestResourceStream("AudioStreamLabels.json")!;
        using var cases = JsonDocument.Parse(stream);
        var settings = PosterTagSettings.FromUserSettings(new() { QualityTagsEnabled = true }, new(), null);
        foreach (var row in cases.RootElement.EnumerateArray())
        {
            var track = JsonSerializer.Deserialize<TagMediaStream>(row.GetProperty("stream"))!;
            Assert.Equal(new[] { row.GetProperty("legacyFull").GetString()! }, Labels(new() { Type = "Movie", StreamData = new() { Streams = [track] } }, settings));
        }
    }

    [Fact]
    public void AudioGateUsesTheLayoutVersionInTheSharedDocuments()
    {
        using var fixture = typeof(QualityDisplayTests).Assembly.GetManifestResourceStream("AudioLegacyDocuments.json")!;
        using var cases = JsonDocument.Parse(fixture);
        foreach (var row in cases.RootElement.EnumerateArray())
        {
            var settings = PosterTagSettings.FromSettingsJson(row.GetProperty("settings").GetRawText(), new());
            Assert.Equal(row.GetProperty("legacy").GetBoolean(), settings.LegacyAudioFacts);
            Assert.Equal(row.GetProperty("density").GetString() == "compact", settings.CompactBands);
            Assert.Equal(new[] { row.GetProperty("label").GetString() }, Labels(new() { Type = "Movie", StreamData = new() {
                Streams = [new() { Type = "Audio", Codec = "ac3", Channels = 6 }] } }, settings));
        }
    }

    [Theory]
    [InlineData(null)]
    [InlineData("full")]
    [InlineData("compact")]
    public void VersionTransitionChangesTheNativeVariantEvenWhenBothLayoutsHaveFullLabels(string? density)
    {
        var document = new JellyfinEnhancedUserSettings { QualityTagsEnabled = true, TagLabelDensity = density ?? "full" };
        var legacy = PosterTagSettings.FromUserSettings(document, new(), null);
        document.TagLayoutSettingsVersion = 1; document.TagLabelDensity = "full";
        var current = PosterTagSettings.FromUserSettings(document, new(), null);
        Assert.NotEqual(legacy.Digest, current.Digest);
        var directory = Path.Combine(Path.GetTempPath(), "je-audio-token-" + Guid.NewGuid().ToString("N"));
        try
        {
            var tokens = PosterTagVariantToken.CreateForPath(Path.Combine(directory, "secret"), _ => { });
            var user = Guid.NewGuid(); var item = Guid.NewGuid();
            var token = tokens.Mint(user, item, legacy.Digest, "7.1", PosterTagVariantFlags.None, "abcdef");
            Assert.False(tokens.Verify(token, user, item, current.Digest, "7.1", out _));
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
    }

    [Fact]
    public void AudioStreamFactsReachNativeChipsInBothDensities()
    {
        using var stream = typeof(QualityDisplayTests).Assembly.GetManifestResourceStream("AudioStreamLabels.json")!;
        using var cases = JsonDocument.Parse(stream);
        foreach (var row in cases.RootElement.EnumerateArray())
        foreach (var density in new[] { "full", "compact" })
        foreach (var mode in new[] { "highest", "all" })
        {
            var track = JsonSerializer.Deserialize<TagMediaStream>(row.GetProperty("stream"))!;
            var data = new TagStreamData { Streams = [track] };
            var settings = PosterTagSettings.FromUserSettings(new() { QualityTagsEnabled = true,
                TagLayoutSettingsVersion = 1, TagLayout = "bands", TagLabelDensity = density, QualityAudioDisplayMode = mode }, new(), null);
            foreach (var cached in new[] { false, true })
            {
                data.DistinctQualities = cached ? QualityTagRules.DetectDistinct(data.Streams) : null;
                Assert.Equal(new[] { row.GetProperty(density).GetString()! }, Labels(new() { Type = "Movie", StreamData = data }, settings));
            }
        }
    }

    [Fact]
    public void TrashAudioAliasesHaveTheSamePrecedenceAcrossTitleCodecAndProfile()
    {
        using var fixture = typeof(QualityDisplayTests).Assembly.GetManifestResourceStream("AudioAliasLabels.json")!;
        using var cases = JsonDocument.Parse(fixture);
        foreach (var row in cases.RootElement.EnumerateArray())
        foreach (var density in new[] { "full", "compact" })
        foreach (var mode in new[] { "highest", "all" })
        {
            var alias = row.GetProperty("alias").GetString(); var codec = row.GetProperty("codec").GetString();
            foreach (var track in row.TryGetProperty("stream", out var custom) ? new[] { JsonSerializer.Deserialize<TagMediaStream>(custom)! } : new TagMediaStream[] {
                new() { Type = "Audio", Channels = 6, DisplayTitle = alias },
                new() { Type = "Audio", Channels = 6, Codec = alias },
                new() { Type = "Audio", Channels = 6, Profile = alias },
                new() { Type = "Audio", Channels = 6, Codec = codec, DisplayTitle = alias },
                new() { Type = "Audio", Channels = 6, Codec = codec, Profile = alias } })
            {
                var data = new TagStreamData { Streams = [track] };
                var settings = PosterTagSettings.FromUserSettings(new() { QualityTagsEnabled = true, TagLayoutSettingsVersion = 1,
                    TagLayout = "bands", TagLabelDensity = density, QualityAudioDisplayMode = mode }, new(), null);
                foreach (var cached in new[] { false, true })
                {
                    data.DistinctQualities = cached ? QualityTagRules.DetectDistinct(data.Streams) : null;
                    Assert.Equal(new[] { row.GetProperty(density).GetString() }, Labels(new() { Type = "Movie", StreamData = data }, settings));
                }
            }
        }
    }

    [Fact]
    public void DistinctFactsKeepActualTrackChannelsAndAreImmutableValueComparedCacheData()
    {
        var streams = Streams();
        streams.DistinctQualities = QualityTagRules.DetectDistinct(streams.Streams);
        Assert.Equal(8, streams.DistinctQualities.Count);
        Assert.Equal(new[] { "ATMOS 7.1", "DTS 7.1", "DTS 5.1" }, QualityTagRules.DistinctValues(streams, "audioInfo", "eng"));
        Assert.Equal(new[] { "TRUEHD 5.1" }, QualityTagRules.DistinctValues(streams, "audioInfo", "de"));
        var entry = new TagCacheEntry { Type = "Movie", StreamData = streams };
        var restored = JsonSerializer.Deserialize<TagCacheEntry>(JsonSerializer.Serialize(entry))!;
        Assert.True(TagCacheEntry.ContentEquals(entry, restored));
        restored.StreamData!.DistinctQualities!.Add(new("videoCodec", "AV1"));
        Assert.False(TagCacheEntry.ContentEquals(entry, restored));
        Assert.Same(streams, entry.Clone().StreamData);
    }

    [Theory]
    [InlineData("Dolby Digital", "DD")]
    [InlineData("Dolby Digital 5.1", "DD 5.1")]
    [InlineData("Dolby Digital+", "DD+")]
    [InlineData("Dolby Digital+ 5.1", "DD+ 5.1")]
    [InlineData("Dolby Digital+ 7.1", "DD+ 7.1")]
    [InlineData("DTS-HD MA 5.1", "DTS-HD 5.1")]
    [InlineData("DTS-HD HRA 7.1", "DTS-HD 7.1")]
    [InlineData("Dolby TrueHD 7.1", "TrueHD 7.1")]
    [InlineData("Dolby Atmos 7.1", "Atmos 7.1")]
    [InlineData("DTS:X 7.1", "DTS:X 7.1")]
    [InlineData("ATMOS 7.1", "ATMOS")]
    [InlineData("MPEG2", "MPEG2")]
    public void CompactLabelsKeepCodecIdentityAndChannels(string full, string compact)
        => Assert.Equal(compact, QualityTagRules.CompactLabel(full));

    [Theory]
    [InlineData("eng", "eng", "deu", false)]
    [InlineData("eng", "none", "deu", true)]
    [InlineData("eng", "fra", "deu", true)]
    [InlineData("en-US", "en-US", "eng", false)]
    [InlineData("eng", "en-AU", "deu", false)]
    [InlineData("deu", "en-AU", "eng", true)]
    [InlineData("eng", "eng", null, false)]
    [InlineData("eng", "none", null, false)]
    public void SoundAllSelectsRawLanguageTierBeforeLabelsForNativeAndEverySummaryPolicy(
        string language, string preferred, string? labelledLanguage, bool hasAtmos)
    {
        var data = new TagStreamData { Streams = [new() { Type = "Video", Height = 1080, Codec = "h264" },
            new() { Type = "Audio", Language = language, Codec = "aac", Channels = 2 }] };
        if (labelledLanguage != null) data.Streams.Add(new() { Type = "Audio", Language = labelledLanguage, DisplayTitle = "ATMOS 7.1", Channels = 8 });
        var expected = hasAtmos ? new[] { "ATMOS 7.1" } : Array.Empty<string>();
        var effective = preferred == "none" ? null : preferred;
        foreach (var cached in new[] { false, true })
        {
            data.DistinctQualities = cached ? QualityTagRules.DetectDistinct(data.Streams) : null;
            Assert.Equal(expected, QualityTagRules.DistinctValues(data, "audioInfo", effective));
            var summary = SeriesQualityAggregation.Build([new("first", 1, data), new("last", 2, data)], 100);
            var audio = SeriesQualityAggregation.EffectiveCategories(summary, effective).Single(pair => pair.Key == "audioInfo").Value;
            Assert.Equal(expected, audio.All);
            Assert.Equal(expected, audio.Shared);
            Assert.Equal(expected, audio.LatestAll);
            Assert.True(audio.AllSetsAgree);
            foreach (var policy in new[] { "representative", "latest", "best", "shared", "mixed" })
            {
                var settings = PosterTagSettings.FromUserSettings(new() { QualityTagsEnabled = true,
                    QualityAudioDisplayMode = "all", QualityTagsPreferredAudioLanguage = preferred, SeriesQualityAggregation = policy }, new(), null);
                foreach (var type in new[] { "Movie", "Series", "Season" })
                {
                    var entry = new TagCacheEntry { Type = type, StreamData = data, QualitySummary = summary };
                    Assert.Equal(new[] { "1080p", "H264" }.Concat(expected), Labels(entry, settings));
                }
            }
        }
    }

    [Fact]
    public void NativeAllOrderingDedupeThresholdsHideSdrAndCapsMatchWeb()
    {
        var entry = new TagCacheEntry { Type = "Movie", StreamData = Streams() };
        Assert.Equal(["1080p", "HDR10", "SDR", "HEVC", "H264", "ATMOS 7.1", "TRUEHD 5.1", "DTS 7.1", "DTS 5.1"], Labels(entry, Settings()));
        Assert.Equal(["1080p", "HDR10"], Labels(entry, Settings(cap: 2)));
        var settings = PosterTagSettings.FromUserSettings(new() { QualityTagsEnabled = true, QualityMinimumResolution = "4k", QualityHdrDisplayMode = "all", QualityHideSdr = true }, new(), null);
        Assert.Equal(["HDR10", "H264", "DTS 7.1"], Labels(entry, settings));
        var legacy = PosterTagSettings.FromUserSettings(new() { QualityTagsEnabled = true }, new(), null);
        Assert.Equal(["1080p", "H264", "DTS 7.1"], Labels(entry, legacy));
        Assert.NotEqual(legacy.Digest, Settings().Digest);
    }

    [Fact]
    public void AllDoesNotResurrectMalformedEntriesThatTheWebDetectorDrops()
    {
        var entry = new TagCacheEntry { Type = "Movie", StreamData = Streams() };
        entry.StreamData.Streams!.Add(null!);
        Assert.Empty(Labels(entry, Settings()));
        entry.StreamData = Streams(); entry.StreamData.Sources = [null!];
        Assert.Empty(Labels(entry, Settings()));
        entry.StreamData.Sources = [new() { Path = "movie.3d.hsbs.mkv" }, null!];
        Assert.Contains("HEVC", Labels(entry, Settings()));
    }

    [Theory]
    [InlineData("representative", "HEVC,H264")]
    [InlineData("latest", "AV1,HEVC")]
    [InlineData("best", "AV1,HEVC,H264")]
    [InlineData("shared", "HEVC")]
    [InlineData("mixed", "AV1,HEVC,H264")]
    public void AllSetsRespectEachContainerPolicyAndUnknownMembers(string policy, string expected)
    {
        var first = Streams();
        var last = new TagStreamData { Streams = [new() { Type = "Video", Codec = "hevc" }, new() { Type = "Video", Codec = "av1" }] };
        var summary = SeriesQualityAggregation.Build([new("first", 1, first), new("last", 2, last)], 100);
        var entry = new TagCacheEntry { Type = "Season", StreamData = first, QualitySummary = summary };
        var labels = Labels(entry, Settings(policy));
        Assert.Equal(expected.Split(','), labels.Where(label => QualityTagRules.CategoryOf(label) == "videoCodec"));
        Assert.Equal(policy == "mixed", labels.Contains("Mixed"));
        var unknown = SeriesQualityAggregation.Build([new("known", 1, first), new("unknown", 2, null)], 100);
        Assert.Empty(unknown.Categories["videoCodec"].Shared);
        Assert.Empty(unknown.Categories["videoCodec"].LatestAll);
        Assert.False(unknown.Categories["videoCodec"].AllSetsAgree);
    }

    [Theory]
    [InlineData("off", "480p", true)]
    [InlineData("720p", "720p", true)]
    [InlineData("720p", "576p", false)]
    [InlineData("1080p", "1080p", true)]
    [InlineData("1080p", "720p", false)]
    [InlineData("4k", "1080p", false)]
    [InlineData("4k", "4K", true)]
    [InlineData("4k", "8K", true)]
    public void ThresholdsAreInclusive(string minimum, string label, bool shown) => Assert.Equal(shown, QualityDisplayRules.MeetsMinimum(label, minimum));

    [Theory]
    [InlineData("QualityAudioDisplayMode", "all", "unknown")]
    [InlineData("QualityVideoCodecDisplayMode", "highest", "off")]
    [InlineData("QualityHdrDisplayMode", "ALL", "true")]
    [InlineData("QualityMinimumResolution", "4K", "720")]
    public void AdminValidatorsAcceptOnlyControlValues(string field, string valid, string invalid)
    {
        Assert.True(MediaTagsPageFields.TryNormalize(field, valid, out _, out _));
        Assert.False(MediaTagsPageFields.TryNormalize(field, invalid, out _, out _));
    }

    private static Jellyfin.Plugin.JellyfinEnhanced.Controllers.JellyfinEnhancedController Controller(ApiPluginFixture f, Claim claim)
    {
        var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), f.Core.Paths.Object, f.Core.Logger);
        var controller = ApiAssetTests.Controller(f.Core, maintenance, f.Core.Manager);
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([claim], "test"));
        return controller;
    }

    [Theory]
    [InlineData("qualityAudioDisplayMode", "all")]
    [InlineData("qualityVideoCodecDisplayMode", "all")]
    [InlineData("qualityHdrDisplayMode", "all")]
    [InlineData("qualityMinimumResolution", "4k")]
    [InlineData("qualityHideSdr", true)]
    public void AdditiveQualitySettingsChangeTheirDigestWithIntegratedResolverIdentity(string key, object value)
    {
        Assert.Equal("31", PosterTagSettings.ResolverVersion);
        var config = new PluginConfiguration();
        var baseline = PosterTagSettings.FromSettingsJson("{qualityTagsEnabled:true}", config);
        var explicitDefaults = PosterTagSettings.FromSettingsJson("{qualityTagsEnabled:true,qualityAudioDisplayMode:'highest',qualityVideoCodecDisplayMode:'highest',qualityHdrDisplayMode:'highest',qualityMinimumResolution:'off',qualityHideSdr:false}", config);
        Assert.Equal(baseline.Digest, explicitDefaults.Digest);
        var changed = new Dictionary<string, object> { ["qualityTagsEnabled"] = true, [key] = value };
        Assert.NotEqual(baseline.Digest, PosterTagSettings.FromSettingsJson(JsonSerializer.Serialize(changed), config).Digest);
        changed["qualityTagsEnabled"] = false;
        Assert.Equal(PosterTagSettings.FromSettingsJson("{qualityTagsEnabled:false}", config).Digest,
            PosterTagSettings.FromSettingsJson(JsonSerializer.Serialize(changed), config).Digest);
    }

    [Fact]
    public void SettingsSeedValidateRoundTripInheritAndApplyDefaults()
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.QualityAudioDisplayMode = "all"; config.QualityVideoCodecDisplayMode = "all"; config.QualityHdrDisplayMode = "all";
        config.QualityMinimumResolution = "4k"; config.QualityHideSdr = true;
        var id = Guid.NewGuid().ToString("N");
        var user = Controller(f, new Claim("Jellyfin-UserId", id));
        Assert.IsType<OkObjectResult>(user.GetUserSettingsSettings(id));
        var seeded = f.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(id, "settings.json");
        Assert.Equal("all", seeded.QualityAudioDisplayMode); Assert.Equal("all", seeded.QualityVideoCodecDisplayMode);
        Assert.Equal("all", seeded.QualityHdrDisplayMode); Assert.Equal("4k", seeded.QualityMinimumResolution); Assert.True(seeded.QualityHideSdr);
        seeded.QualityAudioDisplayMode = "invalid"; seeded.QualityVideoCodecDisplayMode = " ALL "; seeded.QualityHdrDisplayMode = null;
        seeded.QualityMinimumResolution = "invalid"; seeded.QualityHideSdr = null;
        Assert.IsType<OkObjectResult>(user.SaveUserSettingsSettings(id, seeded));
        var saved = f.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(id, "settings.json");
        Assert.Equal("highest", saved.QualityAudioDisplayMode); Assert.Equal("all", saved.QualityVideoCodecDisplayMode);
        Assert.Null(saved.QualityHdrDisplayMode); Assert.Equal("off", saved.QualityMinimumResolution); Assert.Null(saved.QualityHideSdr);
        Assert.Equal("all", PosterTagSettings.FromUserSettings(saved, config, null).QualityHdrDisplayMode);
        var admin = Controller(f, new Claim(ClaimTypes.Role, "Administrator"));
        Assert.IsType<OkObjectResult>(admin.ResetAllUsersSettings());
        var reset = f.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(id, "settings.json");
        Assert.Equal("all", reset.QualityAudioDisplayMode); Assert.Equal("4k", reset.QualityMinimumResolution); Assert.True(reset.QualityHideSdr);
        var legacy = new JellyfinEnhancedUserSettings();
        TagLayoutRules.Normalize(legacy);
        Assert.Equal(0, legacy.TagLayoutSettingsVersion); Assert.Null(legacy.QualityAudioDisplayMode);
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(Assert.IsType<JsonResult>(admin.GetPublicConfig()).Value));
        Assert.Equal("all", doc.RootElement.GetProperty("QualityAudioDisplayMode").GetString());
    }
}
