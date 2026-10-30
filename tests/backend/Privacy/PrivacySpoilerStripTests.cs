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
        else { Assert.NotSame(source, result); Assert.Empty(result.Genres!); Assert.Null(result.Logos); Assert.Null(result.AudioLanguages); Assert.Null(result.SubtitleLanguages); Assert.Null(result.StreamData); Assert.Null(result.CommunityRating); Assert.Null(result.CriticRating); Assert.Null(result.Ratings); Assert.Null(result.QualitySummary); Assert.Null(result.QualityEpisodeIds); }
        Assert.Equal(new[] { "Mystery" }, source.Genres); Assert.Equal(8f, source.CommunityRating); Assert.Equal("The killer", source.StreamData!.ItemName); Assert.NotNull(source.Logos);
        Assert.NotNull(source.QualitySummary); Assert.NotNull(source.QualityEpisodeIds);
        var unguarded = new UserSpoilerBlur(); unguarded.Series[Guid.NewGuid().ToString("N")] = new();
        var otherPolicy = SpoilerTagDataStripper.CreatePolicy(new PluginConfiguration { SpoilerBlurEnabled = true, SpoilerStripTags = true }, unguarded)!;
        Assert.Same(source, stripper.StripEntry(otherPolicy, user, episode, source, out var otherStripped));
        Assert.False(otherStripped);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void TitleOnlyPolicyDeepClonesAndSanitizesStreamTitlesPathsWithoutDroppingQuality(bool hasStreams)
    {
        var user = new User("test", "default", "default") { Id = Guid.NewGuid() };
        var series = new Series { Id = Guid.NewGuid() };
        var state = new UserSpoilerBlur(); state.Series[series.Id.ToString("N")] = new();
        var policy = SpoilerTagDataStripper.CreatePolicy(new PluginConfiguration { SpoilerBlurEnabled = true, SpoilerStripTags = false,
            SpoilerStripRatings = false, SpoilerReplaceTitle = true, SpoilerStripOverview = false }, state)!;
        var stripper = new SpoilerTagDataStripper(Mock.Of<ILibraryManager>(), Mock.Of<IUserDataManager>(), null!);
        var source = Entry(series.Id); source.Type = "Series"; source.Source = "WEB"; source.Edition = "Custom episode reveal";
        source.QualitySummary = new TagQualitySummary
        {
            EpisodeCount = 2, NextPremiere = 999,
            Categories = new() { ["resolution"] = new() { Best = "4K", Latest = "4K", Values = ["4K"], AllAgree = true } },
            LatestExtras = ["WEB", "edition:Custom episode reveal", "IMAX", "3D"],
        };
        if (!hasStreams) source.StreamData = null;
        var result = stripper.StripEntry(policy, user, series, source, out var stripped);
        Assert.True(stripped);
        Assert.NotSame(source.QualitySummary, result.QualitySummary);
        Assert.Equal(new[] { "IMAX", "3D" }, result.QualitySummary!.LatestExtras);
        Assert.Equal(new[] { "WEB", "edition:Custom episode reveal", "IMAX", "3D" }, source.QualitySummary.LatestExtras);
        Assert.Same(source.QualitySummary.Categories, result.QualitySummary.Categories);
        Assert.Equal(source.QualitySummary.NextPremiere, result.QualitySummary.NextPremiere);
        Assert.Equal(source.QualitySummary.EpisodeCount, result.QualitySummary.EpisodeCount);
        Assert.Equal(source.SubtitleLanguages, result.SubtitleLanguages);
        var labels = Jellyfin.Plugin.JellyfinEnhanced.Services.SeriesQualityAggregation.Resolve(result, "latest", null);
        Assert.Contains("4K", labels); Assert.Contains("IMAX", labels);
        Assert.DoesNotContain("WEB", labels); Assert.DoesNotContain("edition:Custom episode reveal", labels);
        Assert.Null(result.Source); Assert.Null(result.Edition);
        Assert.Equal("WEB", source.Source); Assert.Equal("Custom episode reveal", source.Edition);
        if (!hasStreams) { Assert.Null(result.StreamData); return; }
        Assert.NotSame(source.StreamData, result.StreamData);
        Assert.Null(result.StreamData!.ItemName); Assert.Null(result.StreamData.ItemPath);
        var stream = Assert.Single(result.StreamData.Streams!); Assert.Null(stream.DisplayTitle); Assert.Equal("hevc", stream.Codec); Assert.Equal(2160, stream.Height);
        var sourceInfo = Assert.Single(result.StreamData.Sources!); Assert.Null(sourceInfo.Name); Assert.Null(sourceInfo.Path);
        Assert.Equal("Final reveal", source.StreamData!.Streams![0].DisplayTitle);
        Assert.Equal("secret.mkv", source.StreamData.Sources![0].Path);
        Assert.Equal(source.Genres, result.Genres); Assert.Equal(source.CommunityRating, result.CommunityRating);
        Assert.Same(source.Logos, result.Logos);
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
        Assert.True(stripped); Assert.Equal(source.Genres, result.Genres); Assert.Same(source.StreamData, result.StreamData); Assert.Same(source.Logos, result.Logos);
        Assert.Null(result.CommunityRating); Assert.Null(result.CriticRating); Assert.Null(result.Ratings); Assert.Equal(8f, source.CommunityRating);
        Assert.Equal(SpoilerTagDataStub.None, stripper.GetTagDataStub(policy, user, season));
    }

    [Theory]
    [InlineData(true, false)] [InlineData(false, true)] [InlineData(true, true)]
    public void NativeAndSharedStripDropsLogosExactlyWhenTagsAreHidden(bool stripTags, bool optOut)
    {
        // The poster path (StripEntry) and the shared cache use the same field strip.
        var user = new User("test", "default", "default") { Id = Guid.NewGuid() };
        var episode = new Episode { Id = Guid.NewGuid(), SeriesId = Guid.NewGuid() };
        var userData = new Mock<IUserDataManager>();
        userData.Setup(x => x.GetUserData(user, episode)).Returns(new UserItemData { Key = "test", Played = false });
        var state = new UserSpoilerBlur(); state.Series[episode.SeriesId.ToString("N")] = new();
        if (optOut) state.Prefs = new SpoilerBlurUserPrefs { HideTags = false };
        var policy = SpoilerTagDataStripper.CreatePolicy(new PluginConfiguration { SpoilerBlurEnabled = true, SpoilerStripTags = stripTags, SpoilerStripRatings = true }, state)!;
        var source = Entry(episode.SeriesId);
        var result = new SpoilerTagDataStripper(Mock.Of<ILibraryManager>(), userData.Object, null!).StripEntry(policy, user, episode, source, out var stripped);
        Assert.True(stripped);
        if (stripTags && !optOut) Assert.Null(result.Logos); else Assert.Same(source.Logos, result.Logos);
        Assert.Null(result.CommunityRating);
        Assert.Equal("Northwind", Assert.Single(source.Logos!).Name);
    }

    private static TagCacheEntry Entry(Guid seriesId) => new() { Type = "Episode", SeriesId = seriesId.ToString("N"), Genres = ["Mystery"], Logos = [new TagLogo { Kind = "network", Name = "Northwind", Logo = "/nw.png" }],
        QualitySummary = new TagQualitySummary { EpisodeCount = 2 }, QualityEpisodeIds = ["contributor"],
        CommunityRating = 8, CriticRating = 90, Ratings = new() { Imdb = 8.1 }, AudioLanguages = ["en"], SubtitleLanguages = ["fr"], StreamData = new TagStreamData { ItemName = "The killer", ItemPath = "secret.mkv",
        Streams = [new TagMediaStream { Codec = "hevc", Height = 2160, DisplayTitle = "Final reveal" }], Sources = [new TagMediaSource { Name = "The killer", Path = "secret.mkv" }] } };
}
