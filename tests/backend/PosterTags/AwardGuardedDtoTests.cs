using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Globalization;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class AwardGuardedDtoTests
{
    [Theory]
    [InlineData("Movie", false, false)]
    [InlineData("Movie", false, true)]
    [InlineData("Movie", true, false)]
    [InlineData("Movie", true, true)]
    [InlineData("Series", false, false)]
    [InlineData("Series", false, true)]
    [InlineData("Series", true, false)]
    [InlineData("Series", true, true)]
    public async Task FallbackMatchesCacheAndNativeAwardStripping(string kind, bool guarded, bool stripRatings)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.AwardsTagsEnabled = true;
        config.AwardsTagsImdb = config.AwardsTagsLetterboxd = config.AwardsTagsCertifiedFresh = false;
        config.SpoilerBlurEnabled = guarded;
        config.SpoilerStripTags = true;
        config.SpoilerStripRatings = stripRatings;
        config.SpoilerReplaceTitle = config.SpoilerStripOverview = false;
        config.MdblistApiKey = "fixture-only";
        var user = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        BaseItem item = kind == "Series" ? new Series() : new TagCacheSubtitleLanguagesTests.Movie();
        item.Id = Guid.NewGuid();
        item.Name = "Title";
        item.CommunityRating = 8;
        item.ProviderIds = new() { ["Tmdb"] = "42" };
        var mediaType = kind == "Series" ? "tv" : "movie";
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response(
            "{\"results\":{\"bindings\":[{\"awardLabel\":{\"value\":\"Academy Award for Best Picture\"},\"result\":{\"value\":\"Won\"},\"year\":{\"value\":\"2024\"}}]}}")));
        using var mdblist = new MdblistService(transport, f.Core.Paths.Object, f.Core.Logger);
        mdblist.MergeMediaBatchIntoCache(mediaType, ["42"], new Dictionary<string, MdblistCacheEntry> {
            ["42"] = new() { Found = true, Confirmed = true, FetchedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), Ratings = [new() { Source = "imdb", Score = 81 }] } });
        using var wiki = new WikidataAwardsService(transport, f.Core.Paths.Object, f.Core.Logger);
        var awards = new AwardTagsService(transport, f.Core.Paths.Object, mdblist, wiki, f.Core.Logger);
        await awards.RefreshAsync([(mediaType, "42")], config, null, default);
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById<BaseItem>(item.Id, user)).Returns(item);
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(Array.Empty<BaseItem>());
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(user.Id)).Returns(user);
        var data = Mock.Of<IUserDataManager>();
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger,
            new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger), mdblist, awards);
        var resolver = new SpoilerUserResolver(f.Core.Manager, library.Object, f.Core.Logger, null!);
        var stripper = new SpoilerTagDataStripper(library.Object, data, resolver);
        var controller = ApiAssetTests.Controller(f.Core, users.Object, cache, library.Object, data, f.Core.Manager, resolver, stripper);
        controller.HttpContext.User = global::JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(user.Id);
        var state = new UserSpoilerBlur();
        if (kind == "Series") state.Series[item.Id.ToString("N")] = new();
        else state.Movies[item.Id.ToString("N")] = new();
        f.Core.Manager.SaveUserConfiguration(user.Id.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName, state);
        var result = Assert.IsType<OkObjectResult>(controller.GetTagData(user.Id, [item.Id.ToString()]));
        var dto = JsonSerializer.SerializeToElement(result.Value).GetProperty("Items")[0];
        var shared = new TagCacheEntry { Type = kind, Awards = cache.GetAwards(item), Ratings = cache.GetSourceRatings(item), CommunityRating = 8 };
        var policy = SpoilerTagDataStripper.CreatePolicy(config, state);
        var filtered = policy == null ? shared : stripper.StripEntry(policy, user, item, shared, out _);
        var removed = guarded && stripRatings;
        Assert.True(shared.Awards!.OscarWinner);
        Assert.Equal(removed, filtered.Awards == null);
        Assert.Equal(JsonSerializer.SerializeToElement(filtered.Awards).GetRawText(), dto.GetProperty("Awards").GetRawText());
        Assert.Equal(removed, dto.GetProperty("Ratings").ValueKind == JsonValueKind.Null);
        Assert.Equal(removed, dto.GetProperty("CommunityRating").ValueKind == JsonValueKind.Null);
        Assert.Equal(shared.Awards, cache.GetAwards(item));
    }
}
