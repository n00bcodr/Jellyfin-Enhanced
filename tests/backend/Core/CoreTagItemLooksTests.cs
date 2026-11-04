using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using System.Security.Claims;
using System.Text.Json;
using System.Xml.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

/// <summary>
/// Per-item looks (the item editor): the richer lock document (caps, size, gap, edge
/// spacing, scope), the administrator's server-wide item looks
/// (<see cref="PluginConfiguration.TagLookItemOverrides"/>) and their precedence on native
/// posters (<see cref="PosterTagSettings.ForItem(string, string?)"/>).
/// </summary>
[Collection("Plugin singleton")]
public class CoreTagItemLooksTests
{
    private const string Movie = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string Series = "cccccccccccccccccccccccccccccccc";
    private const string Episode = "dddddddddddddddddddddddddddddddd";
    private const string Other = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    [Fact]
    public void LocksKeepTheirCapsSizeGapEdgeAndScopeAndDropUnknownValues()
    {
        var locks = TagLookValidation.NormalizeLocks(new Dictionary<string, TagLayoutLock?>
        {
            [Movie] = new TagLayoutLock
            {
                Layout = "Corners", Density = "compact", Caps = new TagGroupCaps { Genre = 1, Quality = 99 },
                TagScale = "Larger", TagGap = "roomy", EdgeSpacing = "FLUSH", Scope = "Item", LockedAt = 3,
            },
            [Other] = new TagLayoutLock { Layout = "bands", TagScale = "huge", TagGap = "wide", EdgeSpacing = "nowhere", Scope = "series" },
        })!;
        var movie = locks[Movie];
        Assert.Equal(("corners", "compact", 1, 10), (movie.Layout, movie.Density, movie.Caps!.Genre, movie.Caps.Quality));
        Assert.Equal(("larger", "roomy", "flush", "item"), (movie.TagScale, movie.TagGap, movie.EdgeSpacing, movie.Scope));
        var other = locks[Other];
        Assert.Null(other.TagScale);
        Assert.Null(other.TagGap);
        Assert.Null(other.EdgeSpacing);
        Assert.Null(other.Scope);
        Assert.Null(other.Caps);
    }

    [Fact]
    public void ItemLooksNormalizeLikeLocksNewestFirstCappedAndNullWhenEmpty()
    {
        Assert.Null(TagLookValidation.NormalizeItemOverrides(null));
        Assert.Null(TagLookValidation.NormalizeItemOverrides([]));
        Assert.Null(TagLookValidation.NormalizeItemOverrides([new TagLookItemOverride { ItemId = "nope", Layout = "bands" }]));
        var looks = TagLookValidation.NormalizeItemOverrides(
        [
            new TagLookItemOverride { ItemId = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", Layout = "bands", LockedAt = 1 },
            new TagLookItemOverride { ItemId = Movie, Layout = "caption", LockedAt = 5 },
            new TagLookItemOverride { ItemId = Series, Layout = "minimal", Scope = "item", LockedAt = 3 },
            new TagLookItemOverride { ItemId = Other, Layout = "grid", LockedAt = 9 },
        ])!;
        Assert.Equal([Movie, Series], looks.Select(l => l.ItemId));
        Assert.Equal("caption", looks[0].Layout); // a repeated id keeps its newest look
        Assert.Equal("item", looks[1].Scope);

        var many = Enumerable.Range(0, TagLookValidation.MaxItemOverrides + 20)
            .Select(i => new TagLookItemOverride { ItemId = i.ToString("x32"), Layout = "bands", LockedAt = i }).ToList();
        var capped = TagLookValidation.NormalizeItemOverrides(many)!;
        Assert.Equal(TagLookValidation.MaxItemOverrides, capped.Count);
        Assert.Equal((TagLookValidation.MaxItemOverrides + 19).ToString("x32"), capped[0].ItemId);
        Assert.DoesNotContain(capped, l => l.LockedAt < 20); // the oldest went
    }

    [Fact]
    public void ItemLooksRoundTripTheXmlAndAreNotPublishedWithoutAUser()
    {
        var config = new PluginConfiguration
        {
            TagLookItemOverrides = [new TagLookItemOverride { ItemId = Movie, Layout = "bands", Density = "compact", Caps = new TagGroupCaps { Rating = 2 }, EdgeSpacing = "tight", LockedAt = 4, Slots = [new TagLayoutGroupSlot { Group = "quality", Slot = "top" }] }],
        };
        Assert.Null(new PluginConfiguration().TagLookItemOverrides);
        var serializer = new XmlSerializer(typeof(PluginConfiguration));
        using var stream = new MemoryStream();
        serializer.Serialize(stream, config);
        stream.Position = 0;
        var loaded = ((PluginConfiguration)serializer.Deserialize(stream)!).TagLookItemOverrides!.Single();
        Assert.Equal((Movie, "bands", "compact", 2, "tight", 4L, "top"), (loaded.ItemId, loaded.Layout, loaded.Density, loaded.Caps!.Rating!.Value, loaded.EdgeSpacing, loaded.LockedAt, loaded.Slots!.Single().Slot));

        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.TagLookItemOverrides = config.TagLookItemOverrides;
        var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), fixture.Core.Paths.Object, fixture.Core.Logger);
        var controller = ApiAssetTests.Controller(fixture.Core, maintenance);
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.Role, "User")], "test"));
        using (var document = JsonDocument.Parse(JsonSerializer.Serialize(Assert.IsType<JsonResult>(controller.GetPublicConfig()).Value)))
        {
            Assert.Equal(JsonValueKind.Null, document.RootElement.GetProperty("TagLookItemOverrides").ValueKind);
        }

        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity());
        using (var anonymous = JsonDocument.Parse(JsonSerializer.Serialize(Assert.IsType<JsonResult>(controller.GetPublicConfig()).Value)))
        {
            Assert.Equal(JsonValueKind.Null, anonymous.RootElement.GetProperty("TagLookItemOverrides").ValueKind);
        }
    }

    [Theory]
    [InlineData("alice", false)]
    [InlineData("bob", false)]
    [InlineData("admin", true)]
    public void PublicItemLooksAreFilteredByLibraryAccessForEveryCaller(string name, bool admin)
    {
        using var fixture = new ApiPluginFixture();
        var user = new User(name, "test", "test") { Id = Guid.NewGuid() };
        var users = new Mock<IUserManager>();
        users.Setup(m => m.GetUserById(user.Id)).Returns(user);
        var library = new Mock<ILibraryManager>();
        var movie = new MediaBrowser.Controller.Entities.Movies.Movie { Id = Guid.Parse(Movie) };
        var series = new MediaBrowser.Controller.Entities.TV.Series { Id = Guid.Parse(Series) };
        library.Setup(m => m.GetItemById<BaseItem>(movie.Id, user)).Returns(name != "bob" ? movie : null);
        library.Setup(m => m.GetItemById<BaseItem>(series.Id, user)).Returns(name != "alice" ? series : null);
        fixture.Plugin.Configuration.TagLookItemOverrides =
        [
            new() { ItemId = Movie, Layout = "bands", LockedAt = 1 },
            new() { ItemId = Series, Layout = "caption", LockedAt = 2 },
            new() { ItemId = Other, Layout = "minimal", LockedAt = 3 }, // deleted or inaccessible
        ];
        var maintenance = new MaintenanceModeService(users.Object, Mock.Of<ISessionManager>(), fixture.Core.Paths.Object, fixture.Core.Logger);
        var controller = ApiAssetTests.Controller(fixture.Core, maintenance, users.Object, library.Object);
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(
            [new Claim("Jellyfin-UserId", user.Id.ToString()), new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test"));
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(Assert.IsType<JsonResult>(controller.GetPublicConfig()).Value));
        var ids = document.RootElement.GetProperty("TagLookItemOverrides").EnumerateArray().Select(e => e.GetProperty("ItemId").GetString()).ToArray();
        Assert.Equal(admin ? [Series, Movie] : name == "alice" ? [Movie] : new[] { Series }, ids);
        library.Verify(m => m.GetItemById<BaseItem>(It.IsAny<Guid>(), user), Times.Exactly(3));
    }

    private static PluginConfiguration Config(params TagLookItemOverride[] looks) => new()
    {
        TagLookItemOverrides = looks.Length == 0 ? null : looks.ToList(),
    };

    private const string NormalizedUser = "{qualityTagsEnabled:true,ratingTagsEnabled:true,tagLayoutSettingsVersion:1,tagLayout:'corners',qualityTagsPosition:'top-left'";

    [Theory]
    [InlineData(false, 1)]
    [InlineData(true, 1)]
    [InlineData(false, 2)]
    [InlineData(true, 2)]
    public void FlushItemVariantsApplySingleChipCapsWithoutRewritingLooks(bool personal, int maximum)
    {
        var look = new TagLookItemOverride { ItemId = Movie, Layout = "corners", Density = "compact", EdgeSpacing = "flush",
            Caps = new TagGroupCaps { Status = 9, AgeRating = 0, Logos = 8 }, LockedAt = 1 };
        var config = Config(personal ? [] : [look]);
        config.LogoTagsMaxLogos = maximum;
        var user = new JellyfinEnhancedUserSettings { TagLayoutSettingsVersion = 1, AgeRatingTagsEnabled = true };
        if (personal) user.TagLayoutLocks = new() { [Movie] = look };
        var settings = PosterTagSettings.FromUserSettings(user, config).ForItem(Movie, null);
        Assert.Equal("flush", settings.EdgeSpacing);
        Assert.Equal(1, settings.AgeRatingCap);
        Assert.Equal(maximum == 1 ? 1 : 8, settings.LogoCap);
        Assert.Equal((9, 0, 8), (look.Caps.Status, look.Caps.AgeRating, look.Caps.Logos));
        var entry = new Jellyfin.Plugin.JellyfinEnhanced.Model.TagCacheEntry { Type = "Movie", OfficialRating = "PG-13" };
        var layout = PosterTagResolver.Resolve(entry, settings, new("Movie", false, null, null, null), false)!;
        using var renderer = new Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering.PosterTagRenderer();
        Assert.Contains(renderer.Plan(180, 270, layout).Groups.SelectMany(g => g.Items), i => i.FlushEdges != 0);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ItemVariantAudioGateAndDigestFollowTheOriginalDocumentVersion(bool personal)
    {
        var look = new TagLookItemOverride { ItemId = Movie, Layout = "corners", Density = "full", EdgeSpacing = "flush", LockedAt = 1 };
        var config = Config(personal ? [] : [look]);
        var user = new JellyfinEnhancedUserSettings { QualityTagsEnabled = true };
        if (personal) user.TagLayoutLocks = new() { [Movie] = look };
        var legacy = PosterTagSettings.FromUserSettings(user, config).ForItem(Movie, null);
        user.TagLayoutSettingsVersion = 1;
        var current = PosterTagSettings.FromUserSettings(user, config).ForItem(Movie, null);
        Assert.True(legacy.LegacyAudioFacts);
        Assert.False(current.LegacyAudioFacts);
        Assert.NotEqual(legacy.Digest, current.Digest);
        Assert.Equal("30", PosterTagSettings.ResolverVersion);
        Assert.Equal("flush", legacy.EdgeSpacing);
    }

    [Fact]
    public void NativeItemsWithoutALookShareTheUsersSettings()
    {
        var settings = PosterTagSettings.FromSettingsJson(NormalizedUser + "}", Config());
        Assert.False(settings.HasItemLooks);
        Assert.Same(settings, settings.ForItem(Movie, null));
        var withLook = PosterTagSettings.FromSettingsJson(NormalizedUser + "}", Config(new TagLookItemOverride { ItemId = Series, Layout = "bands", LockedAt = 1 }));
        Assert.True(withLook.HasItemLooks);
        Assert.Same(withLook, withLook.ForItem(Movie, null));
        Assert.Equal(settings.Digest, withLook.Digest); // an item look elsewhere never moves anyone else's posters
    }

    [Fact]
    public void NativeLookOrderIsTheUsersLockThenTheItemLookThenTheUsersSettings()
    {
        var config = Config(new TagLookItemOverride { ItemId = Movie, Layout = "bands", Density = "compact", LockedAt = 1 });
        var user = PosterTagSettings.FromSettingsJson(NormalizedUser + "}", config);
        var item = user.ForItem(Movie, null);
        Assert.True(item.Bands);
        Assert.True(item.CompactBands);
        Assert.NotEqual(user.Digest, item.Digest);
        Assert.Same(item, user.ForItem(Movie, null)); // memoised per look

        var locked = PosterTagSettings.FromSettingsJson(NormalizedUser + $",tagLayoutLocks:{{'{Movie}':{{layout:'corners',density:'full',caps:{{quality:1}},tagScale:'largest',edgeSpacing:'flush',slots:[{{group:'quality',slot:'br'}},{{group:'rating',slot:'off'}}],lockedAt:2}}}}}}", config);
        var mine = locked.ForItem(Movie, null);
        Assert.False(mine.Bands); // the user's lock wins over the item look
        Assert.Equal(("bottom-right", 1, "largest", "flush"), (mine.QualityTagsPosition, mine.QualityCap, mine.TagScale, mine.EdgeSpacing));
        Assert.Contains(PosterTagGroup.Rating, mine.OffGroups);
        Assert.False(locked.ForItem(Other, null).Bands);
        Assert.Equal(locked.Digest, locked.ForItem(Other, null).Digest);
    }

    [Fact]
    public void NativeSeasonsAndEpisodesInheritTheirSeriesLookUnlessItStaysOnTheSeries()
    {
        var series = PosterTagSettings.FromSettingsJson(NormalizedUser + "}", Config(new TagLookItemOverride { ItemId = Series, Layout = "bands", LockedAt = 1 }));
        Assert.True(series.ForItem(Series, null).Bands);
        Assert.True(series.ForItem(Episode, "cccccccc-cccc-cccc-cccc-cccccccccccc").Bands);
        Assert.Equal(series.ForItem(Series, null).Digest, series.ForItem(Episode, Series).Digest); // one look, one variant

        var poster = PosterTagSettings.FromSettingsJson(NormalizedUser + "}", Config(new TagLookItemOverride { ItemId = Series, Layout = "bands", Scope = "item", LockedAt = 1 }));
        Assert.True(poster.ForItem(Series, null).Bands);
        Assert.False(poster.ForItem(Episode, Series).Bands);

        // The episode's own look wins over its series'; the user's lock on the series wins over the item look on the episode.
        var mixed = PosterTagSettings.FromSettingsJson(
            NormalizedUser + $",tagLayoutLocks:{{'{Series}':{{layout:'corners',density:'full',tagScale:'smaller',lockedAt:1}}}}}}",
            Config(new TagLookItemOverride { ItemId = Episode, Layout = "bands", LockedAt = 1 }));
        Assert.Equal("smaller", mixed.ForItem(Episode, Series).TagScale);
        Assert.False(mixed.ForItem(Episode, Series).Bands);
    }

    [Theory]
    [InlineData("caption", false)]
    [InlineData("summary", false)]
    [InlineData("minimal", false)]
    [InlineData("caption", true)]
    [InlineData("summary", true)]
    [InlineData("minimal", true)]
    public void NativeFallbackItemLooksKeepExplicitOffGroupsAndTheVisibleCornerPositions(string layout, bool personal)
    {
        var look = new TagLookItemOverride
        {
            ItemId = Movie, Layout = layout, LockedAt = 1,
            Slots = [new() { Group = "quality", Slot = "off" }, new() { Group = "genre", Slot = "off" }, new() { Group = "rating", Slot = "off" }],
        };
        var config = Config(personal ? [] : [look]);
        var json = NormalizedUser + ",genreTagsEnabled:true,languageTagsEnabled:true,tagLayouts:{corners:{groups:[{group:'language',slot:'bc'}]}}";
        if (personal) json += $",tagLayoutLocks:{{'{Movie}':" + JsonSerializer.Serialize(look) + "}";
        var settings = PosterTagSettings.FromSettingsJson(json + "}", config);
        var item = settings.ForItem(Movie, null);
        Assert.False(item.Bands);
        Assert.Equal("bottom-center", item.LanguageTagsPosition);
        Assert.True(item.Shows(PosterTagGroup.Language));
        foreach (var group in new[] { PosterTagGroup.Quality, PosterTagGroup.Genre, PosterTagGroup.Rating })
        {
            Assert.Contains(group, item.OffGroups);
            Assert.False(item.Shows(group));
            Assert.True(settings.Shows(group)); // deriving an item never mutates the base profile
        }
        Assert.NotEqual(settings.Digest, item.Digest);
    }

    [Fact]
    public void NativeItemLooksOnLegacyDocumentsKeepWhatTheLookDoesNotSet()
    {
        var config = Config(new TagLookItemOverride { ItemId = Movie, Layout = "corners", Density = "full", Caps = new TagGroupCaps { Genre = 1 }, LockedAt = 1 });
        config.TagGroupCaps = new TagGroupCaps { Language = 1, Genre = 5 };
        config.TagScale = "largest";
        config.TagEdgeSpacing = "flush";
        var legacy = PosterTagSettings.FromSettingsJson("{qualityTagsEnabled:true,genreTagsEnabled:true,languageTagsEnabled:true,genreTagsPosition:'bottom-left'}", config);
        var item = legacy.ForItem(Movie, null);
        Assert.Equal(1, item.GenreCap);
        Assert.Equal(3, item.LanguageCap); // the built-in limit, never the administrator's
        Assert.Equal("default", item.TagScale);
        Assert.Equal("default", item.EdgeSpacing);
        Assert.Equal("bottom-left", item.GenreTagsPosition);
        Assert.Null(item.GroupOrder); // arrival order
        Assert.Equal(legacy.GenreTagsPosition, item.GenreTagsPosition);
    }
}
