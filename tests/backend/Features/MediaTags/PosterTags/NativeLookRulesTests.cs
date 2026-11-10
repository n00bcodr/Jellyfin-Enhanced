using System.Security.Claims;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using Microsoft.AspNetCore.Http;
using Moq;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard;

namespace JE.Tests.Features.MediaTags;

/// <summary>Native posters decide tag look rules the way core/tag-look.js does (lock → item look → rule → default).</summary>
[Collection("Plugin singleton")]
public class NativeLookRulesTests
{
    private const string Movie = "00000000000000000000000000000a01";
    private const string Library = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

    private static TagLookRule Rule(string id, string layout, params (string Field, string Value)[] when) => new()
    {
        Id = id, Layout = layout, Density = "compact",
        When = when.Select(w => new TagLookCondition { Field = w.Field, Value = w.Value }).ToList(),
    };

    private static PosterTagSettings Settings(List<TagLookRule>? own, List<TagLookRule>? admin = null, int version = 1, Dictionary<string, TagLayoutLock>? locks = null)
        => PosterTagSettings.FromUserSettings(new()
        {
            QualityTagsEnabled = true, GenreTagsEnabled = true, TagLayoutSettingsVersion = version, TagLookRules = own, TagLayoutLocks = locks,
        }, new PluginConfiguration { TagLookRules = admin ?? new() }, null);

    private static PosterTagLookFacts Facts(string type = "Movie", string? library = Library, string[]? genres = null, string? rating = "PG-13")
        => new(type, library, genres ?? ["Drama", "Animation"], rating);

    [Fact]
    public void AMatchingTypeRuleGivesThePosterItsLookAndHiddenGroups()
    {
        var rule = Rule("movies", "bands", ("type", "movie"));
        rule.Slots = [new() { Group = "quality", Slot = "off" }];
        var settings = Settings([rule]);
        Assert.True(settings.HasLookRules);
        var item = settings.ForItem(Movie, null, () => Facts());
        Assert.Equal(("rule:1", "bands"), (settings.ResolveLook(Movie, null, () => Facts()).Source, settings.ResolveLook(Movie, null, () => Facts()).Look!.Layout));
        Assert.True(item.Bands);
        Assert.False(item.Shows(PosterTagGroup.Quality));
        Assert.NotEqual(settings.Digest, item.Digest);
        Assert.Same(settings, settings.ForItem(Movie, null, () => Facts("Series")));
    }

    [Theory]
    [InlineData("library", Library, true)]
    [InlineData("library", "ffffffffffffffffffffffffffffffff", false)]
    [InlineData("genre", "ANIMATION", true)]
    [InlineData("genre", "Horror", false)]
    [InlineData("ageRating", "pg-13", true)]
    [InlineData("ageRating", "R", false)]
    [InlineData("type", "Episode", false)]
    public void EveryConditionFieldMatchesAsTheWebDoes(string field, string value, bool matches)
    {
        var settings = Settings([Rule("one", "bands", (field, value))]);
        Assert.Equal(matches ? "rule:1" : "default", settings.ResolveLook(Movie, null, () => Facts()).Source);
    }

    [Fact]
    public void AgeRatingsCompareAsTheAgeRatingTagsShowThem()
    {
        var settings = Settings([Rule("fsk", "bands", ("ageRating", "FSK 12"))]);
        Assert.Equal("rule:1", settings.ResolveLook(Movie, null, () => Facts(rating: "DE-12")).Source);
    }

    [Fact]
    public void TheFirstEnabledMatchWinsAndAllConditionsMustHold()
    {
        var paused = Rule("paused", "caption", ("type", "Movie"));
        paused.Enabled = false;
        var settings = Settings([paused, Rule("both", "summary", ("type", "Movie"), ("genre", "Horror")), Rule("drama", "bands", ("genre", "drama")), Rule("movies", "caption", ("type", "Movie"))]);
        Assert.Equal("rule:3", settings.ResolveLook(Movie, null, () => Facts()).Source);
    }

    [Fact]
    public void LocksAndItemLooksComeBeforeRules()
    {
        var settings = Settings([Rule("movies", "bands", ("type", "Movie"))], locks: new() { [Movie] = new TagLayoutLock { Layout = "corners", Density = "full" } });
        Assert.Equal("lock", settings.ResolveLook(Movie, null, () => Facts()).Source);
        var calls = 0;
        settings.ForItem(Movie, null, () => { calls++; return Facts(); });
        Assert.Equal(0, calls);
    }

    [Fact]
    public void AdministratorRulesApplyUnlessTheDocumentHasItsOwnListOrWasSavedBeforeLayouts()
    {
        var admin = new List<TagLookRule> { Rule("movies", "bands", ("type", "Movie")) };
        Assert.Equal("rule:1", Settings(null, admin).ResolveLook(Movie, null, () => Facts()).Source);
        Assert.Equal("default", Settings([], admin).ResolveLook(Movie, null, () => Facts()).Source);
        Assert.Equal("default", Settings(null, admin, version: 0).ResolveLook(Movie, null, () => Facts()).Source);
        Assert.Equal("rule:1", Settings(admin, null, version: 0).ResolveLook(Movie, null, () => Facts()).Source);
    }

    [Fact]
    public void FactsComeFromTheCacheEntryWithItsSeriesFallbacks()
    {
        var facts = PosterTagLookFacts.FromEntry(new TagCacheEntry { Type = "Episode", LibraryId = Library, Genres = ["Comedy"], OfficialRating = "TV-14" });
        Assert.Equal(new[] { "Comedy" }, facts.Genres);
        var settings = Settings([Rule("tv14", "bands", ("ageRating", "TV-14"), ("type", "Episode"), ("library", Library))]);
        Assert.Equal("rule:1", settings.ResolveLook(Movie, null, () => facts).Source);
        Assert.Equal("default", settings.ResolveLook(Movie, null, () => null).Source);
    }

    [Fact]
    public void HiddenByDefaultARuleRevealsTagsThroughTheStamper()
    {
        // Quality is on but hidden in the default Corners profile; a Movie rule shows it top left.
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.NativePosterTagsEnabled = true;
        f.Plugin.Configuration.NativePosterTagsWebClientNames = "";
        var user = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(user.Id)).Returns(user);
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Movie", Genres = ["Drama"] };
        var series = new Series { Id = Guid.NewGuid(), Name = "Series" };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById(movie.Id)).Returns(movie);
        library.Setup(l => l.GetItemById(series.Id)).Returns(series);
        var reveal = Rule("movies", "corners", ("type", "Movie"));
        reveal.Slots = [new() { Group = "quality", Slot = "tl" }];
        f.Core.Manager.SaveUserConfiguration(user.Id.ToString("N"), "settings.json", new JellyfinEnhancedUserSettings
        {
            QualityTagsEnabled = true, TagLayoutSettingsVersion = 1, TagLayout = "corners",
            TagLayouts = new() { Corners = new() { Groups = [new() { Group = "quality", Slot = "off" }] } },
            TagLookRules = [reveal],
        });
        var userCache = new PosterTagUserCache(users.Object);
        using var provider = new PosterTagSettingsProvider(f.Core.Manager, userCache);
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
        using var data = new PosterTagDataProvider(cache, library.Object, null!, null!, null!, f.Core.Logger);
        var tokens = PosterTagVariantToken.CreateForPath(Path.Combine(f.Core.Root, "native-key"), _ => { });
        var stamper = new NativePosterTagStamper(new NativeClientPolicy(), provider, tokens, data, new SpoilerIdentityService(users.Object, f.Core.Logger), null!, null!, userCache, library.Object);
        var settings = provider.Get(user.Id);
        Assert.False(settings.AnyGroupEnabled);
        Assert.True(settings.MayShowTags);

        var http = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-Client", "Jellyfin for Android TV")], "test")) };
        var session = stamper.Begin(http, user.Id);
        Assert.NotNull(session);
        BaseItemDto Dto(BaseItem item, BaseItemKind kind) => new() { Id = item.Id, Type = kind, ImageTags = new() { [ImageType.Primary] = "base" } };
        var movieDto = Dto(movie, BaseItemKind.Movie);
        var seriesDto = Dto(series, BaseItemKind.Series);
        stamper.StampItem(movieDto, session!);
        stamper.StampItem(seriesDto, session!);
        // The matching movie gets a personalised poster; the series, which the rule does not reveal anything on, keeps its artwork.
        Assert.NotEqual("base", movieDto.ImageTags[ImageType.Primary]);
        Assert.Contains("-jet", movieDto.ImageTags[ImageType.Primary], StringComparison.Ordinal);
        Assert.Equal("base", seriesDto.ImageTags[ImageType.Primary]);

        // Without the rule nothing is visible, so no response is stamped at all.
        f.Core.Manager.SaveUserConfiguration(user.Id.ToString("N"), "settings.json", new JellyfinEnhancedUserSettings
        {
            QualityTagsEnabled = true, TagLayoutSettingsVersion = 1, TagLayout = "corners",
            TagLayouts = new() { Corners = new() { Groups = [new() { Group = "quality", Slot = "off" }] } },
            TagLookRules = [],
        });
        Assert.Null(stamper.Begin(http, user.Id));
    }

    // Upstream 8d91169c: a native poster learns that its viewer has watched all of the item from the DTO's own played
    // state, through one bit of the variant token. The bit is this viewer's (the token is bound to the user and the
    // item), it is only on the item's own poster, and a series image borrowed by an episode card never carries it.
    [Fact]
    public void OnlyTheOwnPosterOfAnItemItsViewerHasFinishedCarriesTheWatchedAllBit()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.NativePosterTagsEnabled = true;
        f.Plugin.Configuration.NativePosterTagsWebClientNames = "";
        var user = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(user.Id)).Returns(user);
        var series = new Series { Id = Guid.NewGuid(), Name = "Series" };
        var episode = new Episode { Id = Guid.NewGuid(), Name = "Episode", SeriesId = series.Id };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById(series.Id)).Returns(series);
        library.Setup(l => l.GetItemById(episode.Id)).Returns(episode);
        f.Core.Manager.SaveUserConfiguration(user.Id.ToString("N"), "settings.json", new JellyfinEnhancedUserSettings { StatusTagsEnabled = true, TagLayoutSettingsVersion = 1, TagLayout = "corners" });
        var userCache = new PosterTagUserCache(users.Object);
        using var provider = new PosterTagSettingsProvider(f.Core.Manager, userCache);
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
        using var data = new PosterTagDataProvider(cache, library.Object, null!, null!, null!, f.Core.Logger);
        var tokens = PosterTagVariantToken.CreateForPath(Path.Combine(f.Core.Root, "native-key"), _ => { });
        var stamper = new NativePosterTagStamper(new NativeClientPolicy(), provider, tokens, data, new SpoilerIdentityService(users.Object, f.Core.Logger), null!, null!, userCache, library.Object);
        var http = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-Client", "Jellyfin for Android TV")], "test")) };
        var session = stamper.Begin(http, user.Id);
        Assert.NotNull(session);

        static PosterTagVariantFlags Flags(string tag)
        {
            Assert.True(PosterTagVariantToken.TryParse(ImageTagDecoration.GetVariant(tag), out var variant), tag);
            return variant.Flags;
        }
        PosterTagVariantFlags Own(bool? played, int? unplayed = null)
        {
            var dto = new BaseItemDto { Id = series.Id, Type = BaseItemKind.Series, ImageTags = new() { [ImageType.Primary] = "base" },
                UserData = played is { } value ? new UserItemDataDto { Key = "k", Played = value, UnplayedItemCount = unplayed } : null };
            stamper.StampItem(dto, session!);
            return Flags(dto.ImageTags[ImageType.Primary]);
        }

        Assert.Equal(PosterTagVariantFlags.TopRightOffset | PosterTagVariantFlags.WatchedAll, Own(true));
        Assert.Equal(PosterTagVariantFlags.TopRightOffset, Own(false, 3));
        Assert.Equal(PosterTagVariantFlags.None, Own(false));
        Assert.Equal(PosterTagVariantFlags.None, Own(null));

        // A watched episode's card: its own image says so, the series image it also carries does not.
        var card = new BaseItemDto { Id = episode.Id, Type = BaseItemKind.Episode, SeriesId = series.Id, ImageTags = new() { [ImageType.Primary] = "base" },
            SeriesPrimaryImageTag = "series-base", UserData = new UserItemDataDto { Key = "k", Played = true } };
        stamper.StampItem(card, session!);
        Assert.True(Flags(card.ImageTags[ImageType.Primary]).HasFlag(PosterTagVariantFlags.WatchedAll));
        Assert.False(Flags(card.SeriesPrimaryImageTag).HasFlag(PosterTagVariantFlags.WatchedAll));
    }
}
