using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Http;
using System.Security.Claims;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags.Resolution;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using Moq;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Admin.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Settings;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Maintenance;

namespace JE.Tests.Features.MediaTags;

[Collection("Plugin singleton")]
public class SourceEditionTagsTests
{
    private sealed class Movie : MediaBrowser.Controller.Entities.Movies.Movie
    {
        public List<MediaSourceInfo> Sources { get; set; } = [];
        public override List<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution) => Sources;
    }

    public static IEnumerable<object?[]> Names()
    {
        using var stream = typeof(SourceEditionTagsTests).Assembly.GetManifestResourceStream("SourceEditionNames.json")!;
        using var document = JsonDocument.Parse(stream);
        return document.RootElement.EnumerateArray().Select(row => new object?[]
        {
            row.GetProperty("path").GetString(), row.GetProperty("source").GetString(), row.GetProperty("edition").GetString(),
            row.TryGetProperty("itemName", out var name) ? name.GetString() : null,
            row.TryGetProperty("originalTitle", out var original) ? original.GetString() : null,
        }).ToArray();
    }

    [Theory]
    [MemberData(nameof(Names))]
    public void NamingTable(string path, string? source, string? edition, string? itemName, string? originalTitle)
    {
        Assert.Equal(new MediaNamingTags(source, edition), MediaNamingTags.FromPath(path, itemName, originalTitle));
    }

    public static IEnumerable<object[]> QualityTokens() => QualityTagRules.ResolutionTokens
        .Concat(QualityTagRules.CodecTokens).Distinct().Select(token => new object[] { token });

    [Theory]
    [MemberData(nameof(QualityTokens))]
    public void BareWebIsAWholeWordWhateverFollowsIt(string token)
    {
        foreach (var spelling in new[] { token, token.ToUpperInvariant() })
        {
            Assert.Equal("WEB", MediaNamingTags.FromPath($"Movie.2020.WEB.{spelling}.mkv").Source);
            Assert.Equal("WEB", MediaNamingTags.FromPath($"Movie 2020 [WEB] [{spelling}].mkv").Source);
            Assert.Equal("WEB", MediaNamingTags.FromPath($"Movie.2020.WEB.{spelling}ish.mkv").Source);
            Assert.Null(MediaNamingTags.FromPath($"Movie.2020.WEBSITE.{spelling}.mkv").Source);
            Assert.Null(MediaNamingTags.FromPath($"Webb.{spelling}.mkv").Source);
        }
    }

    private static MediaSourceInfo Version(string path, int height) => new()
    {
        Path = path, MediaStreams = [new() { Type = MediaStreamType.Video, Height = height, Codec = "h264" }],
    };

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(" \t")]
    public void MissingSourcePathFallsBackToItemPath(string? sourcePath)
    {
        var source = Version("unused", 1080);
        source.Path = sourcePath;
        Assert.Equal(new("WEB", "Extended"), MediaNamingTags.Detect("Film.2020.WEB.1080p.{edition-Extended}.mkv", [source]));
        Assert.Equal(new MediaNamingTags(), MediaNamingTags.Detect(null, [source]));
    }

    [Fact]
    public void HighestResolutionThenSourceQualitySelectsOneVersionAndItsEdition()
    {
        var lower = Version("/private/Film.BluRay.{edition-Unrated}/Film.1080p.REMUX.mkv", 1080);
        var best = Version("/private/Film.{edition-Extended}/Film.2160p.WEB-DL.mkv", 2160);
        Assert.Equal(new("WEB", "Extended"), MediaNamingTags.Detect(lower.Path, [lower, best]));
        Assert.Equal(new("WEB", "Extended"), MediaNamingTags.Detect(lower.Path, [best, lower]));
        lower.MediaStreams[0].Height = 2160;
        Assert.Equal(new("REMUX", "Unrated"), MediaNamingTags.Detect(best.Path, [best, lower]));
        Assert.Equal("DVD", MediaNamingTags.Detect("Film.DVD.disc", [best, lower]).Source);
        Assert.Equal("BluRay", MediaNamingTags.Detect("Film.disc", [new() { Path = "Film.disc", Name = "BluRay" }]).Source);
        Assert.Equal("VHS", MediaNamingTags.Detect("Film.disc", [], "Film VHS").Source);
    }

    [Theory]
    [InlineData("https://cdn.example.invalid/Film.2020.WEB.H264.mkv?label=IMAX")]
    [InlineData("https://cdn.example.invalid/Film.2020.WEB.H264.mkv?mode=3d.hsbs#IMAX")]
    public void ARemoteAddressQueryNeverReachesTheCachedNameAsAFormatSignal(string url)
    {
        using var fixture = new ApiPluginFixture();
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Film", Path = "/movies/Film.2020.WEB.strm" };
        movie.Sources = [Version(url, 1080)];
        using var cache = new TagCacheService(Mock.Of<ILibraryManager>(), fixture.Core.Paths.Object, Mock.Of<ILocalizationManager>(), fixture.Core.Logger,
            new Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services.MatroskaLanguageCache(fixture.Core.Paths.Object, fixture.Core.Logger));
        var entry = Assert.IsType<TagCacheEntry>(cache.BuildEntryOnDemand(movie));
        Assert.Equal("Film.2020.WEB.H264.mkv", entry.StreamData!.Sources![0].Path);
        var labels = QualityTagRules.Detect(entry.StreamData, null);
        Assert.DoesNotContain("IMAX", labels);
        Assert.DoesNotContain("3D", labels);
        Assert.Equal("WEB", entry.Source);
    }

    [Theory]
    [InlineData("/private/Film.{edition-Criterion}/Film.1080p.WEB-DL.mkv")]
    [InlineData(@"C:\private\Film.{edition-Criterion}\Film.1080p.WEB-DL.mkv")]
    public void CacheBuildsNamingFactsBeforeTrimmingPathsAndIncludesThemInChangeDetection(string path)
    {
        using var fixture = new ApiPluginFixture();
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Film", Path = path };
        movie.Sources = [Version(movie.Path, 1080)];
        using var cache = new TagCacheService(Mock.Of<ILibraryManager>(), fixture.Core.Paths.Object, Mock.Of<ILocalizationManager>(), fixture.Core.Logger,
            new Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services.MatroskaLanguageCache(fixture.Core.Paths.Object, fixture.Core.Logger));
        var entry = Assert.IsType<TagCacheEntry>(cache.BuildEntryOnDemand(movie));
        Assert.Equal("WEB", entry.Source); Assert.Equal("Criterion", entry.Edition);
        Assert.DoesNotContain("private", JsonSerializer.Serialize(entry));
        var copy = entry.Clone(); Assert.True(TagCacheEntry.ContentEquals(entry, copy));
        copy.Source = "REMUX"; Assert.False(TagCacheEntry.ContentEquals(entry, copy));
        copy = entry.Clone(); copy.Edition = "Extended"; Assert.False(TagCacheEntry.ContentEquals(entry, copy));
    }

    [Fact]
    public void BatchDataUsesTheSameNamingSelectionAndNeverReturnsDirectories()
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.SpoilerBlurEnabled = false;
        var user = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Film", Path = "/private/library/Film.WEB-DL.mkv" };
        movie.Sources = [Version(movie.Path, 720), Version("/private/library/Film.{edition-Extended}/Film.REMUX.mkv", 2160)];
        movie.Sources[0].Id = "low"; movie.Sources[1].Id = "best";
        movie.Sources[0].MediaStreams[0].Width = 1920; movie.Sources[1].MediaStreams[0].Width = 3840;
        var users = new Mock<IUserManager>(); users.Setup(x => x.GetUserById(user.Id)).Returns(user);
        var library = new Mock<ILibraryManager>(); library.Setup(x => x.GetItemById<BaseItem>(movie.Id, user)).Returns(movie);
        using var cache = new TagCacheService(library.Object, fixture.Core.Paths.Object, Mock.Of<ILocalizationManager>(), fixture.Core.Logger,
            new Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services.MatroskaLanguageCache(fixture.Core.Paths.Object, fixture.Core.Logger));
        var controller = ApiAssetTests.Controller(fixture.Core, users.Object, library.Object, cache);
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", user.Id.ToString())], "test"));
        JsonElement Read(string? version)
        {
            var result = Assert.IsType<OkObjectResult>(ApiAssetTests.SiblingOf<JeMediaTagsController>(controller).GetTagData(user.Id, [movie.Id.ToString()], mediaSourceId: version));
            var json = JsonSerializer.Serialize(result.Value);
            Assert.DoesNotContain("/private", json);
            return JsonDocument.Parse(json).RootElement.GetProperty("Items")[0];
        }
        var best = Read(null); Assert.Equal("REMUX", best.GetProperty("Source").GetString()); Assert.Equal("Extended", best.GetProperty("Edition").GetString());
        Assert.Equal("low", best.GetProperty("MediaStreams")[0].GetProperty("SourceId").GetString());
        Assert.Equal("best", best.GetProperty("MediaSources")[1].GetProperty("Id").GetString());
        var selected = Read("low"); Assert.Equal(1920, selected.GetProperty("MediaStreams")[0].GetProperty("Width").GetInt32()); Assert.Equal("WEB", selected.GetProperty("Source").GetString()); Assert.Equal(JsonValueKind.Null, selected.GetProperty("Edition").ValueKind);
    }

    [Fact]
    public void CacheBuildRetainsVersionIdentityWidthAndDistinctTrackSets()
    {
        using var fixture = new ApiPluginFixture();
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Film", Path = "/private/Film.WEB-DL.mkv" };
        movie.Sources = [Version(movie.Path, 800), Version("/private/Film.REMUX.{edition-Extended}.mkv", 1600)];
        movie.Sources[0].Id = "first"; movie.Sources[1].Id = "second";
        movie.Sources[0].MediaStreams[0].Width = 1920; movie.Sources[1].MediaStreams[0].Width = 3840;
        using var cache = new TagCacheService(Mock.Of<ILibraryManager>(), fixture.Core.Paths.Object, Mock.Of<ILocalizationManager>(), fixture.Core.Logger,
            new Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services.MatroskaLanguageCache(fixture.Core.Paths.Object, fixture.Core.Logger));
        var entry = cache.BuildEntryOnDemand(movie)!;
        var data = entry.StreamData!;
        Assert.Equal(new[] { "first", "second" }, data.Streams!.Select(s => s.SourceId));
        Assert.Equal(new int?[] { 1920, 3840 }, data.Streams!.Select(s => s.Width));
        Assert.Equal("WEB", data.Sources![0].Source); Assert.Equal("Extended", data.Sources[1].Edition);
        Assert.All(data.DistinctQualities!, q => Assert.Contains(q.SourceId, new[] { "first", "second" }));
        Assert.DoesNotContain("/private", JsonSerializer.Serialize(entry));
    }

    [Fact]
    public void SourceEditionDefaultsReachPublicConfigNewUsersAndBulkReset()
    {
        using var fixture = new ApiPluginFixture();
        var config = fixture.Plugin.Configuration;
        config.ShowEditionTag = false; config.ShowLowQualitySourceTag = true; config.EditionTagOrder = 2;
        var userId = Guid.NewGuid().ToString("N");
        var controller = ApiAssetTests.Controller(fixture.Core, fixture.Core.Manager,
            new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), fixture.Core.Paths.Object, fixture.Core.Logger));
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", userId), new Claim(ClaimTypes.Role, "Administrator")], "test"));
        var publicConfig = JsonSerializer.SerializeToElement(Assert.IsType<JsonResult>(controller.GetPublicConfig()).Value);
        Assert.False(publicConfig.GetProperty("ShowEditionTag").GetBoolean());
        Assert.True(publicConfig.GetProperty("ShowLowQualitySourceTag").GetBoolean());
        Assert.Equal(2, publicConfig.GetProperty("EditionTagOrder").GetInt32());
        Assert.IsType<OkObjectResult>(ApiAssetTests.Sibling<JeSettingsController>(controller, fixture.Core, fixture.Core.Manager).GetUserSettingsSettings(userId));
        var seeded = fixture.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(userId, "settings.json");
        Assert.False(seeded.ShowEditionTag); Assert.True(seeded.ShowLowQualitySourceTag); Assert.Equal(2, seeded.EditionTagOrder);
        config.ShowEditionTag = true; config.ShowLowQualitySourceTag = false; config.EditionTagOrder = 7;
        Assert.IsType<OkObjectResult>(ApiAssetTests.Sibling<JeSettingsController>(controller, fixture.Core, fixture.Core.Manager).ResetAllUsersSettings());
        var reset = fixture.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(userId, "settings.json");
        Assert.True(reset.ShowEditionTag); Assert.False(reset.ShowLowQualitySourceTag); Assert.Equal(7, reset.EditionTagOrder);
    }

    [Fact]
    public void Schema13SnapshotsAreDiscardedRatherThanServingEntriesWithoutNamingFacts()
    {
        using var fixture = new ApiPluginFixture();
        Directory.CreateDirectory(fixture.Core.ConfigRoot);
        File.WriteAllText(Path.Combine(fixture.Core.ConfigRoot, "tag-cache.json"), JsonSerializer.Serialize(new
        { SchemaVersion = 13, Version = 8, Items = new Dictionary<string, TagCacheEntry> { [Guid.NewGuid().ToString("N")] = new() { Type = "Movie" } } }));
        using var cache = new TagCacheService(Mock.Of<ILibraryManager>(), fixture.Core.Paths.Object, Mock.Of<ILocalizationManager>(), fixture.Core.Logger,
            new Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services.MatroskaLanguageCache(fixture.Core.Paths.Object, fixture.Core.Logger));
        cache.LoadFromDisk();
        Assert.Equal(0, cache.Count);
    }

    [Theory]
    [InlineData("CAM")][InlineData("TS")][InlineData("TC")][InlineData("SCR")]
    public void LowSourcesRequireOptInAndStillRespectSourceCategory(string source)
    {
        var entry = new TagCacheEntry { Source = source, Edition = "Extended" };
        PosterTagLayout? Resolve(string json) => PosterTagResolver.Resolve(entry,
            PosterTagSettings.FromSettingsJson(json, new PluginConfiguration()), new("Movie", false, null, null, null), false);
        var defaultTags = Resolve("{qualityTagsEnabled:true}")!.Groups.SelectMany(g => g.Tags).OfType<QualityTag>();
        Assert.Equal("Extended", Assert.Single(defaultTags).Label);
        var all = Resolve("{qualityTagsEnabled:true,showLowQualitySourceTag:true,editionTagOrder:1}")!.Groups.SelectMany(g => g.Tags).OfType<QualityTag>().ToArray();
        Assert.Equal(new[] { "Extended", source }, all.Select(q => q.Label));
        Assert.Equal(new[] { "edition", "source" }, all.Select(q => q.Category));
        Assert.Null(Resolve("{qualityTagsEnabled:true,showLowQualitySourceTag:true,showSourceTag:false,showEditionTag:false}"));
    }

    [Fact]
    public void EditionImaxDoesNotDuplicateSpecialFormatButCanBeShownOnItsOwn()
    {
        var entry = new TagCacheEntry { Source = "REMUX", Edition = "IMAX", StreamData = new() { ItemName = "Film.IMAX", Streams = [] } };
        QualityTag[] Resolve(bool special) => PosterTagResolver.Resolve(entry,
            PosterTagSettings.FromUserSettings(new() { QualityTagsEnabled = true, ShowSpecialFormatTag = special }, new()),
            new("Movie", false, null, null, null), false)!.Groups.SelectMany(g => g.Tags).OfType<QualityTag>().Where(q => q.Label == "IMAX").ToArray();
        Assert.Equal("specialFormat", Assert.Single(Resolve(true)).Category);
        Assert.Equal("edition", Assert.Single(Resolve(false)).Category);
    }

    [Fact]
    public void NewSettingsInheritAdminDefaultsAndParticipateInNativeDigest()
    {
        var config = new PluginConfiguration { ShowEditionTag = false, EditionTagOrder = 3, ShowLowQualitySourceTag = true, QualityTagsEnabled = true };
        var inherited = PosterTagSettings.FromUserSettings(new() { QualityTagsEnabled = true, TagLayoutSettingsVersion = 1 }, config);
        Assert.False(inherited.ShowEditionTag); Assert.True(inherited.ShowLowQualitySourceTag); Assert.Equal(3, inherited.EditionTagOrder);
        var seeded = PosterTagSettings.FromSettingsJson(null, config);
        Assert.Equal(inherited.Digest, seeded.Digest);
        Assert.NotEqual(seeded.Digest, PosterTagSettings.FromUserSettings(new() { QualityTagsEnabled = true }, config).Digest);
        Assert.NotEqual(inherited.Digest, PosterTagSettings.FromUserSettings(new() { QualityTagsEnabled = true, ShowEditionTag = true, ShowLowQualitySourceTag = false }, config).Digest);
        foreach (var label in new[] { "REMUX", "WEB", "CAM", "TS", "TC", "SCR", "Director's Cut", "Extended", "Unrated", "Theatrical", "Remastered", "Criterion", "Uncut", "Final Cut", "Special Edition", "Redux", "Ultimate", "Collector's Edition", "Anniversary", "Uncensored", "Open Matte", "DTS-HD" })
            Assert.True(TagStyleCatalog.IsLabel("quality", label), label);
    }
}

/// <summary>Jellyfin's own disc and 3D facts stand in where the names say nothing.</summary>
public class StructuredSourceFactsTests
{
    [Theory]
    [InlineData(VideoType.BluRay, null, "BluRay")]
    [InlineData(VideoType.Dvd, null, "DVD")]
    [InlineData(VideoType.Iso, IsoType.BluRay, "BluRay")]
    [InlineData(VideoType.Iso, IsoType.Dvd, "DVD")]
    [InlineData(VideoType.VideoFile, null, null)]
    public void ADiscStructureNamesItsSource(VideoType type, IsoType? iso, string? expected)
    {
        var source = new MediaSourceInfo { Id = "a", Path = "/movies/Movie (2020)/Movie (2020)", VideoType = type, IsoType = iso };
        Assert.Equal(expected, MediaNamingTags.Detect(source.Path, new[] { source }, "Movie").Source);
    }

    [Fact]
    public void ANamedSourceStillWinsOverTheDiscStructure()
    {
        var source = new MediaSourceInfo { Id = "a", Path = "/movies/Movie (2020) 1080p REMUX/Movie (2020) 1080p REMUX", VideoType = VideoType.BluRay };
        Assert.Equal("REMUX", MediaNamingTags.Detect(source.Path, new[] { source }, "Movie").Source);
    }

    [Fact]
    public void JellyfinsThreeDimensionalFormatMarksAVersion3D()
    {
        var streams = new List<TagMediaStream> { new() { Type = "Video", Height = 1080, Width = 1920, Codec = "h264" } };
        Assert.Contains("3D", QualityTagRules.Detect(new TagStreamData { Streams = streams, Sources = [new() { Id = "a", Path = "Movie.mkv", Is3D = true }] }, null));
        Assert.DoesNotContain("3D", QualityTagRules.Detect(new TagStreamData { Streams = streams, Sources = [new() { Id = "a", Path = "Movie.mkv" }] }, null));
    }

    [Fact]
    public void ARemoteVersionWhoseAddressNamesNothingKeepsTheWrapperName()
    {
        var remote = new MediaBrowser.Model.Dto.MediaSourceInfo { Id = "remote", Path = "https://cdn.example.invalid/stream/123?sig=example", MediaStreams = [] };
        var tags = MediaNamingTags.Detect("/Movies/Film.2020.WEB.{edition-Extended}.strm", [remote], "Film");
        Assert.Equal("WEB", tags.Source);
        Assert.Equal("Extended", tags.Edition);
        // A remote address that names its own release still speaks for itself.
        var named = new MediaBrowser.Model.Dto.MediaSourceInfo { Id = "named", Path = "https://cdn.example.invalid/Film.2020.1080p.BluRay.x264-CAM.mkv?sig=example", MediaStreams = [] };
        Assert.Equal("BluRay", MediaNamingTags.Detect("/Movies/Film.2020.WEB.strm", [named], "Film").Source);
    }

    [Theory]
    [InlineData("/Movies/Film/Film.2020.1080p.H264-IMAX.mkv", "/Movies/Film/Film.2020.1080p.H264.mkv")]
    [InlineData("/Movies/Film/Film.2020.IMAX.1080p.H264-GRP.mkv", "/Movies/Film/Film.2020.IMAX.1080p.H264.mkv")]
    [InlineData("/Movies/Film/Film.2007.HD-DVD.mkv", "/Movies/Film/Film.2007.HD-DVD.mkv")]
    [InlineData("https://cdn.example.invalid/Film.2020.WEB.H264-IMAX.mkv?sig=1", "https://cdn.example.invalid/Film.2020.WEB.H264.mkv")]
    public void AReleaseGroupIsNoIMAXClaim(string path, string expected)
    {
        Assert.Equal(expected, MediaNamingTags.WithoutReleaseGroup(path));
        var data = new TagStreamData
        {
            Sources = [new() { Id = "a", Path = path }],
            Streams = [new() { Type = "Video", SourceId = "a", Width = 1920, Height = 1080, Codec = "h264", VideoRangeType = "SDR" }],
            ItemName = "Film",
        };
        Assert.Equal(expected.Contains("IMAX", StringComparison.Ordinal), QualityTagRules.Detect(data, null).Contains("IMAX"));
    }

    [Theory]
    [InlineData("/Movies/3 Days to Kill (2014)/3Days.To.Kill.2014.1080p.H264-MVC.mkv", false)]
    [InlineData("/Movies/Film (2014)/Film.2014.1080p.3D.HSBS.x264.mkv", true)]
    [InlineData("/Movies/Film (2014)/Film.2014.3D.1080p.BluRay.MVC-GRP.mkv", true)]
    [InlineData("/Movies/Film (2014)/Film.2014.3Dimension.HSBS.mkv", false)]
    public void ThreeDNeedsWholeReleaseWordsOutsideTheReleaseGroup(string path, bool threeD)
    {
        var data = new TagStreamData
        {
            Sources = [new() { Id = "a", Path = path }],
            Streams = [new() { Type = "Video", SourceId = "a", Width = 1920, Height = 1080, Codec = "h264", VideoRangeType = "SDR" }],
        };
        Assert.Equal(threeD, QualityTagRules.Detect(data, null).Contains("3D"));
    }

    [Fact]
    public void AVersionRevisionFollowsEveryFactJellyfinHasForTheFile()
    {
        MediaSourceInfo Version(Action<MediaBrowser.Model.Entities.MediaStream>? change = null)
        {
            var video = new MediaBrowser.Model.Entities.MediaStream { Index = 0, Type = MediaBrowser.Model.Entities.MediaStreamType.Video, Codec = "h264", CodecTag = "avc1", Width = 1920, Height = 1080, BitDepth = 8, BitRate = 8_000_000, RealFrameRate = 24 };
            change?.Invoke(video);
            return new MediaSourceInfo { Id = "s1", Path = "/movies/Film.mkv", Container = "mkv", Size = 1000, MediaStreams = [video] };
        }
        var baseline = TagCacheService.MediaRevision(Version());
        Assert.Matches("^[0-9a-f]{12}$", baseline);
        Assert.Equal(baseline, TagCacheService.MediaRevision(Version()));
        foreach (var change in new Action<MediaBrowser.Model.Entities.MediaStream>[]
        {
            v => v.IsInterlaced = true, v => v.RealFrameRate = 60, v => v.CodecTag = "avc3",
            v => v.BitRate = 100_000_000, v => v.BitDepth = 10, v => v.Level = 51, v => v.Profile = "High 10",
        })
            Assert.NotEqual(baseline, TagCacheService.MediaRevision(Version(change)));
        Assert.Equal(baseline, TagCacheService.MediaRevision(Version(v => v.Title = "Main video")));
    }

    [Fact]
    public void TheRevisionHashesTheSharedDirectPlayInputListInOrderAndEachOneInvalidatesIt()
    {
        using var resource = typeof(SourceEditionTagsTests).Assembly.GetManifestResourceStream("DirectPlayInputs.json")!;
        using var document = System.Text.Json.JsonDocument.Parse(resource);
        var fixture = document.RootElement;
        Assert.Equal(fixture.GetProperty("source").EnumerateArray().Select(v => v.GetString()), TagCacheService.DirectPlaySourceFields);
        Assert.Equal(fixture.GetProperty("stream").EnumerateArray().Select(v => v.GetString()), TagCacheService.DirectPlayStreamFields);
        foreach (var name in TagCacheService.DirectPlaySourceFields) Assert.NotNull(typeof(MediaSourceInfo).GetProperty(name));
        foreach (var name in TagCacheService.DirectPlayStreamFields) Assert.NotNull(typeof(MediaBrowser.Model.Entities.MediaStream).GetProperty(name));

        MediaSourceInfo Version()
        {
            var video = new MediaBrowser.Model.Entities.MediaStream { Index = 0, Type = MediaBrowser.Model.Entities.MediaStreamType.Video, Codec = "hevc", CodecTag = "hvc1", Profile = "Main 10", Level = 150, BitDepth = 10, BitRate = 40_000_000, Width = 3840, Height = 2160, RealFrameRate = 23.976f, AverageFrameRate = 23.976f, ColorTransfer = "smpte2084", ColorPrimaries = "bt2020", ColorSpace = "bt2020nc", PixelFormat = "yuv420p10le", DvProfile = 8, DvLevel = 6, DvBlSignalCompatibilityId = 1, RpuPresentFlag = 1, BlPresentFlag = 1, NalLengthSize = "4", IsDefault = true, RefFrames = 1 };
            var audio = new MediaBrowser.Model.Entities.MediaStream { Index = 1, Type = MediaBrowser.Model.Entities.MediaStreamType.Audio, Codec = "truehd", Channels = 8, ChannelLayout = "7.1", SampleRate = 48_000, Language = "eng", IsDefault = true };
            var subtitle = new MediaBrowser.Model.Entities.MediaStream { Index = 2, Type = MediaBrowser.Model.Entities.MediaStreamType.Subtitle, Codec = "srt", Language = "eng", IsExternal = true, Path = "/movies/Film.en.srt" };
            return new MediaSourceInfo { Id = "s1", Path = "/movies/Film.mkv", Container = "mkv", Size = 50_000_000_000, Bitrate = 60_000_000, RunTimeTicks = 72_000_000_000, Protocol = MediaBrowser.Model.MediaInfo.MediaProtocol.File, DefaultAudioStreamIndex = 1, MediaStreams = [video, audio, subtitle] };
        }

        // The text hashed before the list existed, field by field: a revision computed by an earlier build stays
        // valid, so upgrading re-stamps no entry.
        static string N(object? value) => value is IFormattable f ? f.ToString(null, System.Globalization.CultureInfo.InvariantCulture) : value?.ToString() ?? string.Empty;
        var legacy = Version();
        var text = new System.Text.StringBuilder();
        text.Append(legacy.Id).Append('|').Append(legacy.Path).Append('|').Append(legacy.Container).Append('|').Append(N(legacy.Size))
            .Append('|').Append(N(legacy.Bitrate)).Append('|').Append(N(legacy.RunTimeTicks)).Append('|').Append(N(legacy.Video3DFormat))
            .Append('|').Append(N(legacy.Protocol)).Append('|').Append(N(legacy.Timestamp)).Append('|').Append(N(legacy.DefaultAudioStreamIndex));
        foreach (var s in legacy.MediaStreams)
        {
            text.Append('\n').AppendJoin('|', N(s.Index), N(s.Type), s.Codec, s.CodecTag, s.Profile, N(s.Level), N(s.BitDepth), N(s.BitRate),
                N(s.Width), N(s.Height), N(s.IsInterlaced), N(s.RealFrameRate), N(s.AverageFrameRate), N(s.Channels), s.ChannelLayout,
                N(s.SampleRate), N(s.VideoRangeType), s.ColorTransfer, s.PixelFormat, s.Language, N(s.IsDefault), N(s.IsForced), N(s.IsExternal),
                N(s.IsAnamorphic), N(s.RefFrames), N(s.PacketLength), N(s.IsAVC), N(s.Rotation), N(s.NalLengthSize),
                N(s.DvProfile), N(s.DvLevel), N(s.DvBlSignalCompatibilityId), N(s.BlPresentFlag), N(s.ElPresentFlag), N(s.RpuPresentFlag),
                N(s.Hdr10PlusPresentFlag), s.ColorPrimaries, s.ColorSpace, s.ColorRange, N(s.IsHearingImpaired), s.Path);
        }
        var baseline = TagCacheService.MediaRevision(Version());
        Assert.Equal(Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(text.ToString())))[..12], baseline);

        // Each listed fact, changed alone on the version or on any of its streams, changes the revision.
        static object? Other(Type type, object? value)
        {
            var t = Nullable.GetUnderlyingType(type) ?? type;
            if (t == typeof(string)) return (value as string ?? "x") + "-changed";
            if (t == typeof(bool)) return !(value as bool? ?? false);
            if (t == typeof(int)) return (value as int? ?? 0) + 7;
            if (t == typeof(long)) return (value as long? ?? 0) + 7;
            if (t == typeof(float)) return (value as float? ?? 0) + 7.5f;
            if (t == typeof(double)) return (value as double? ?? 0) + 7.5;
            if (t.IsEnum) return Enum.GetValues(t).Cast<object>().First(v => !v.Equals(value));
            throw new InvalidOperationException($"no change rule for {t}");
        }
        foreach (var name in TagCacheService.DirectPlaySourceFields)
        {
            var version = Version();
            var property = typeof(MediaSourceInfo).GetProperty(name)!;
            property.SetValue(version, Other(property.PropertyType, property.GetValue(version)));
            Assert.True(baseline != TagCacheService.MediaRevision(version), $"source {name}");
        }
        for (var index = 0; index < 3; index++)
        {
            foreach (var name in TagCacheService.DirectPlayStreamFields)
            {
                var version = Version();
                var property = typeof(MediaBrowser.Model.Entities.MediaStream).GetProperty(name)!;
                var stream = version.MediaStreams[index];
                if (!property.CanWrite) continue;
                property.SetValue(stream, Other(property.PropertyType, property.GetValue(stream)));
                Assert.True(baseline != TagCacheService.MediaRevision(version), $"stream {index} {name}");
            }
        }
    }

    // Every input Jellyfin's ConditionProcessor can test against a device profile, mapped to the change of
    // one media fact it reads. A new ProfileConditionValue in a Jellyfin update fails the inventory check until
    // it is mapped here (and hashed by MediaRevision if it reads a new fact). The enum differs by target:
    // Jellyfin 12's VideoRotation profile condition is covered alongside the stream rotation input.
    private static readonly Dictionary<string, Action<MediaSourceInfo, MediaBrowser.Model.Entities.MediaStream, MediaBrowser.Model.Entities.MediaStream>> ConditionInputs = new()
    {
        ["AudioChannels"] = (_, _, a) => a.Channels = 8,
        ["AudioBitrate"] = (_, _, a) => a.BitRate = 3_000_000,
        ["AudioProfile"] = (_, _, a) => a.Profile = "LC",
        ["Width"] = (_, v, _) => v.Width = 1440,
        ["Height"] = (_, v, _) => v.Height = 816,
        ["Has64BitOffsets"] = (s, _, _) => s.Container = "mp4",
        ["PacketLength"] = (_, v, _) => v.PacketLength = 192,
        ["VideoBitDepth"] = (_, v, _) => v.BitDepth = 10,
        ["VideoBitrate"] = (_, v, _) => v.BitRate = 40_000_000,
        ["VideoFramerate"] = (_, v, _) => v.AverageFrameRate = 23.976f,
        ["VideoLevel"] = (_, v, _) => v.Level = 52,
        ["VideoProfile"] = (_, v, _) => v.Profile = "Main 10",
        ["VideoTimestamp"] = (s, _, _) => s.Timestamp = MediaBrowser.Model.MediaInfo.TransportStreamTimestamp.Valid,
        ["IsAnamorphic"] = (_, v, _) => v.IsAnamorphic = true,
        ["RefFrames"] = (_, v, _) => v.RefFrames = 16,
        ["NumAudioStreams"] = (s, _, _) => s.MediaStreams = [.. s.MediaStreams, new MediaBrowser.Model.Entities.MediaStream { Index = 2, Type = MediaBrowser.Model.Entities.MediaStreamType.Audio, Codec = "aac", Channels = 2 }],
        ["NumVideoStreams"] = (s, _, _) => s.MediaStreams = [.. s.MediaStreams, new MediaBrowser.Model.Entities.MediaStream { Index = 2, Type = MediaBrowser.Model.Entities.MediaStreamType.Video, Codec = "mjpeg" }],
        ["IsSecondaryAudio"] = (s, _, _) => s.DefaultAudioStreamIndex = 1,
        ["VideoCodecTag"] = (_, v, _) => v.CodecTag = "hvc1",
        ["IsAvc"] = (_, v, _) => v.IsAVC = true,
        ["IsInterlaced"] = (_, v, _) => v.IsInterlaced = true,
        ["AudioSampleRate"] = (_, _, a) => a.SampleRate = 96_000,
        ["AudioBitDepth"] = (_, _, a) => a.BitDepth = 24,
        ["VideoRangeType"] = (_, v, _) => { v.ColorTransfer = "smpte2084"; v.ColorPrimaries = "bt2020"; },
        ["NumStreams"] = (s, _, _) => s.MediaStreams = [.. s.MediaStreams, new MediaBrowser.Model.Entities.MediaStream { Index = 2, Type = MediaBrowser.Model.Entities.MediaStreamType.Subtitle, Codec = "srt" }],
        ["VideoRotation"] = (_, v, _) => v.Rotation = 90,
    };

    [Fact]
    public void EveryDeviceProfileConditionInputIsMapped()
    {
        Assert.Equal(
            Enum.GetNames<MediaBrowser.Model.Dlna.ProfileConditionValue>().OrderBy(n => n, StringComparer.Ordinal),
            ConditionInputs.Keys.OrderBy(n => n, StringComparer.Ordinal));
    }

    public static TheoryData<string> ConditionInputNames()
    {
        var data = new TheoryData<string>();
        foreach (var name in ConditionInputs.Keys) data.Add(name);
        return data;
    }

    [Theory]
    [MemberData(nameof(ConditionInputNames))]
    public void AVersionRevisionChangesWithEachDeviceProfileConditionInput(string input)
    {
        MediaSourceInfo Version(bool change)
        {
            var video = new MediaBrowser.Model.Entities.MediaStream { Index = 0, Type = MediaBrowser.Model.Entities.MediaStreamType.Video, Codec = "h264", CodecTag = "avc1", Width = 1920, Height = 1080, BitDepth = 8, BitRate = 8_000_000, Level = 41, Profile = "High", RealFrameRate = 24, AverageFrameRate = 24, IsAnamorphic = false, RefFrames = 4 };
            var audio = new MediaBrowser.Model.Entities.MediaStream { Index = 1, Type = MediaBrowser.Model.Entities.MediaStreamType.Audio, Codec = "ac3", Channels = 6, BitRate = 640_000, SampleRate = 48_000 };
            var source = new MediaSourceInfo { Id = "s1", Path = "/movies/Film.mkv", Container = "mkv", Size = 1000, DefaultAudioStreamIndex = 0, MediaStreams = [video, audio] };
            if (change) ConditionInputs[input](source, video, audio);
            return source;
        }
        Assert.NotEqual(TagCacheService.MediaRevision(Version(false)), TagCacheService.MediaRevision(Version(true)));
    }
}
