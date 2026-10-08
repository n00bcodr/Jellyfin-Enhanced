using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Moq;
using Xunit;

namespace JellyfinEnhanced.Tests;

public class PrivacySpoilerStripTests
{
    [Theory]
    [InlineData(false)] [InlineData(true)]
    public void GuardedEpisodeStripsOnlyUnwatchedAndDoesNotMutateSharedEntry(bool watched)
    {
        var library = new Mock<ILibraryManager>(); var userData = new Mock<IUserDataManager>();
        var user = new User("test", "default", "default") { Id = Guid.NewGuid() };
        var episode = new Episode { Id = Guid.NewGuid(), SeriesId = Guid.NewGuid() };
        userData.Setup(x => x.GetUserData(user, episode)).Returns(new UserItemData { Key = "test", Played = watched });
        var stripper = new SpoilerTagDataStripper(library.Object, userData.Object, null!);
        var state = new UserSpoilerBlur(); state.Series[episode.SeriesId.ToString("N")] = new();
        var policy = SpoilerTagDataStripper.CreatePolicy(new PluginConfiguration { SpoilerBlurEnabled = true, SpoilerStripTags = true, SpoilerStripRatings = true }, state)!;
        var source = Entry(episode.SeriesId);
        var result = stripper.StripEntry(policy, user, episode, source, out var stripped);
        Assert.Equal(!watched, stripped);
        Assert.Equal(watched ? SpoilerTagDataStub.None : SpoilerTagDataStub.Episode, stripper.GetTagDataStub(policy, user, episode));
        if (watched) Assert.Same(source, result);
        else { Assert.NotSame(source, result); Assert.Empty(result.Genres!); Assert.Null(result.AudioLanguages); Assert.Null(result.StreamData); Assert.Null(result.CommunityRating); Assert.Null(result.CriticRating); }
        Assert.Equal(new[] { "Mystery" }, source.Genres); Assert.Equal(8f, source.CommunityRating); Assert.Equal("The killer", source.StreamData!.ItemName);
        var unguarded = new UserSpoilerBlur(); unguarded.Series[Guid.NewGuid().ToString("N")] = new();
        var otherPolicy = SpoilerTagDataStripper.CreatePolicy(new PluginConfiguration { SpoilerBlurEnabled = true, SpoilerStripTags = true }, unguarded)!;
        Assert.Same(source, stripper.StripEntry(otherPolicy, user, episode, source, out var otherStripped));
        Assert.False(otherStripped);
    }

    [Fact]
    public void TitleOnlyPolicyDeepClonesAndSanitizesStreamTitlesPathsWithoutDroppingQuality()
    {
        var user = new User("test", "default", "default") { Id = Guid.NewGuid() };
        var series = new Series { Id = Guid.NewGuid() };
        var state = new UserSpoilerBlur(); state.Series[series.Id.ToString("N")] = new();
        var policy = SpoilerTagDataStripper.CreatePolicy(new PluginConfiguration { SpoilerBlurEnabled = true, SpoilerStripTags = false,
            SpoilerStripRatings = false, SpoilerReplaceTitle = true, SpoilerStripOverview = false }, state)!;
        var stripper = new SpoilerTagDataStripper(Mock.Of<ILibraryManager>(), Mock.Of<IUserDataManager>(), null!);
        var source = Entry(series.Id); source.Type = "Series";
        var result = stripper.StripEntry(policy, user, series, source, out var stripped);
        Assert.True(stripped); Assert.NotSame(source.StreamData, result.StreamData);
        Assert.Null(result.StreamData!.ItemName); Assert.Null(result.StreamData.ItemPath);
        var stream = Assert.Single(result.StreamData.Streams!); Assert.Null(stream.DisplayTitle); Assert.Equal("hevc", stream.Codec); Assert.Equal(2160, stream.Height);
        var sourceInfo = Assert.Single(result.StreamData.Sources!); Assert.Null(sourceInfo.Name); Assert.Null(sourceInfo.Path);
        Assert.Equal("Final reveal", source.StreamData!.Streams![0].DisplayTitle);
        Assert.Equal("secret.mkv", source.StreamData.Sources![0].Path);
        Assert.Equal(source.Genres, result.Genres); Assert.Equal(source.CommunityRating, result.CommunityRating);
    }

    [Fact]
    public void FailedPlayedLookupFailsClosedAndPreservesOtherUsersSource()
    {
        using var fixture = new JE.Tests.CoreFixture();
        var library = new Mock<ILibraryManager>(); var userData = new Mock<IUserDataManager>();
        var user = new User("test", "default", "default") { Id = Guid.NewGuid() };
        var episode = new Episode { Id = Guid.NewGuid(), SeriesId = Guid.NewGuid() };
        userData.Setup(x => x.GetUserData(user, episode)).Throws(new IOException("fixture failure"));
        var resolver = new SpoilerUserResolver(fixture.Manager, library.Object, fixture.Logger, null!);
        var stripper = new SpoilerTagDataStripper(library.Object, userData.Object, resolver);
        var state = new UserSpoilerBlur(); state.Series[episode.SeriesId.ToString("N")] = new();
        var policy = SpoilerTagDataStripper.CreatePolicy(new PluginConfiguration { SpoilerBlurEnabled = true, SpoilerStripTags = true }, state)!;
        var source = Entry(episode.SeriesId);
        Assert.Empty(stripper.StripEntry(policy, user, episode, source, out var stripped).Genres!);
        Assert.True(stripped); Assert.NotEmpty(source.Genres!);
    }

    [Theory]
    [InlineData(0)] [InlineData(1)]
    public void SpecialsAndFirstSeasonRetainTagsButRemoveFallbackRatings(int number)
    {
        var library = new Mock<ILibraryManager>();
        var season = new Season { Id = Guid.NewGuid(), SeriesId = Guid.NewGuid(), IndexNumber = number };
        library.Setup(x => x.GetItemById<BaseItem>(season.Id)).Returns(season);
        var state = new UserSpoilerBlur(); state.Series[season.SeriesId.ToString("N")] = new();
        var policy = SpoilerTagDataStripper.CreatePolicy(new PluginConfiguration { SpoilerBlurEnabled = true, SpoilerStripTags = true, SpoilerStripRatings = true }, state)!;
        var stripper = new SpoilerTagDataStripper(library.Object, Mock.Of<IUserDataManager>(), null!);
        var source = Entry(season.SeriesId); source.Type = "Season";
        var user = new User("test", "default", "default");
        var result = stripper.StripEntry(policy, user, season, source, out var stripped);
        Assert.True(stripped); Assert.Equal(source.Genres, result.Genres); Assert.Same(source.StreamData, result.StreamData);
        Assert.Null(result.CommunityRating); Assert.Null(result.CriticRating); Assert.Equal(8f, source.CommunityRating);
        Assert.Equal(SpoilerTagDataStub.None, stripper.GetTagDataStub(policy, user, season));
    }

    private static TagCacheEntry Entry(Guid seriesId) => new() { Type = "Episode", SeriesId = seriesId.ToString("N"), Genres = ["Mystery"],
        CommunityRating = 8, CriticRating = 90, AudioLanguages = ["en"], StreamData = new TagStreamData { ItemName = "The killer", ItemPath = "secret.mkv",
        Streams = [new TagMediaStream { Codec = "hevc", Height = 2160, DisplayTitle = "Final reveal" }], Sources = [new TagMediaSource { Name = "The killer", Path = "secret.mkv" }] } };
}
