using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Http;
using System.Security.Claims;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using Moq;

namespace JE.Tests;

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
        { row.GetProperty("path").GetString(), row.GetProperty("source").GetString(), row.GetProperty("edition").GetString() }).ToArray();
    }

    [Theory]
    [MemberData(nameof(Names))]
    public void NamingTable(string path, string? source, string? edition)
    {
        Assert.Equal(new MediaNamingTags(source, edition), MediaNamingTags.FromPath(path));
    }

    public static IEnumerable<object[]> QualityTokens() => QualityTagRules.ResolutionTokens
        .Concat(QualityTagRules.CodecTokens).Distinct().Select(token => new object[] { token });

    [Theory]
    [MemberData(nameof(QualityTokens))]
    public void BareWebAcceptsEveryQualityRuleTokenWithTokenBoundaries(string token)
    {
        foreach (var spelling in new[] { token, token.ToUpperInvariant() })
        {
            Assert.Equal("WEB", MediaNamingTags.FromPath($"Movie.2020.WEB.{spelling}.mkv").Source);
            Assert.Equal("WEB", MediaNamingTags.FromPath($"Movie 2020 [WEB] [{spelling}].mkv").Source);
            Assert.Null(MediaNamingTags.FromPath($"Movie.2020.WEB.{spelling}ish.mkv").Source);
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
    [InlineData("/private/Film.{edition-Criterion}/Film.1080p.WEB-DL.mkv")]
    [InlineData(@"C:\private\Film.{edition-Criterion}\Film.1080p.WEB-DL.mkv")]
    public void CacheBuildsNamingFactsBeforeTrimmingPathsAndIncludesThemInChangeDetection(string path)
    {
        using var fixture = new ApiPluginFixture();
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Film", Path = path };
        movie.Sources = [Version(movie.Path, 1080)];
        using var cache = new TagCacheService(Mock.Of<ILibraryManager>(), fixture.Core.Paths.Object, Mock.Of<ILocalizationManager>(), fixture.Core.Logger,
            new Jellyfin.Plugin.JellyfinEnhanced.Helpers.MatroskaLanguageCache(fixture.Core.Paths.Object, fixture.Core.Logger));
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
        var users = new Mock<IUserManager>(); users.Setup(x => x.GetUserById(user.Id)).Returns(user);
        var library = new Mock<ILibraryManager>(); library.Setup(x => x.GetItemById<BaseItem>(movie.Id, user)).Returns(movie);
        using var cache = new TagCacheService(library.Object, fixture.Core.Paths.Object, Mock.Of<ILocalizationManager>(), fixture.Core.Logger,
            new Jellyfin.Plugin.JellyfinEnhanced.Helpers.MatroskaLanguageCache(fixture.Core.Paths.Object, fixture.Core.Logger));
        var controller = ApiAssetTests.Controller(fixture.Core, users.Object, library.Object, cache);
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", user.Id.ToString())], "test"));
        JsonElement Read(string? version)
        {
            var result = Assert.IsType<OkObjectResult>(controller.GetTagData(user.Id, [movie.Id.ToString()], mediaSourceId: version));
            var json = JsonSerializer.Serialize(result.Value);
            Assert.DoesNotContain("/private", json);
            return JsonDocument.Parse(json).RootElement.GetProperty("Items")[0];
        }
        var best = Read(null); Assert.Equal("REMUX", best.GetProperty("Source").GetString()); Assert.Equal("Extended", best.GetProperty("Edition").GetString());
        var selected = Read("low"); Assert.Equal("WEB", selected.GetProperty("Source").GetString()); Assert.Equal(JsonValueKind.Null, selected.GetProperty("Edition").ValueKind);
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
        Assert.IsType<OkObjectResult>(controller.GetUserSettingsSettings(userId));
        var seeded = fixture.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(userId, "settings.json");
        Assert.False(seeded.ShowEditionTag); Assert.True(seeded.ShowLowQualitySourceTag); Assert.Equal(2, seeded.EditionTagOrder);
        config.ShowEditionTag = true; config.ShowLowQualitySourceTag = false; config.EditionTagOrder = 7;
        Assert.IsType<OkObjectResult>(controller.ResetAllUsersSettings());
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
            new Jellyfin.Plugin.JellyfinEnhanced.Helpers.MatroskaLanguageCache(fixture.Core.Paths.Object, fixture.Core.Logger));
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
        var inherited = PosterTagSettings.FromUserSettings(new() { QualityTagsEnabled = true }, config);
        Assert.False(inherited.ShowEditionTag); Assert.True(inherited.ShowLowQualitySourceTag); Assert.Equal(3, inherited.EditionTagOrder);
        var seeded = PosterTagSettings.FromSettingsJson(null, config);
        Assert.Equal(inherited.Digest, seeded.Digest);
        Assert.NotEqual(inherited.Digest, PosterTagSettings.FromUserSettings(new() { QualityTagsEnabled = true, ShowEditionTag = true, ShowLowQualitySourceTag = false }, config).Digest);
        foreach (var label in new[] { "REMUX", "WEB", "CAM", "TS", "TC", "SCR", "Director's Cut", "Extended", "Unrated", "Theatrical", "Remastered", "Criterion", "Uncut", "Final Cut", "Special Edition" })
            Assert.True(TagStyleCatalog.IsLabel("quality", label), label);
    }
}
