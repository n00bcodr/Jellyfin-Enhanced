using System.Security.Claims;
using System.Text.Json;
using System.Xml.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Globalization;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class CoreTagLookSettingsTests
{
    private const string User = "abcdefabcdefabcdefabcdefabcdefab";
    private const string Library = "0123456789abcdef0123456789abcdef";

    private static TagLookCondition When(string field, string value) => new() { Field = field, Value = value };

    private static TagLookRule Rule(string id, string layout, params TagLookCondition[] when) =>
        new() { Id = id, Layout = layout, Density = "compact", When = when.ToList() };

    [Fact]
    public void NewDocumentsHaveNoRulesOrLocks()
    {
        var user = new JellyfinEnhancedUserSettings();
        Assert.Null(user.TagLookRules);
        Assert.Null(user.TagLayoutLocks);
        Assert.Null(new PluginConfiguration().TagLookRules);
    }

    [Fact]
    public void RulesDropUnknownFieldsBadIdsAndUnknownLayoutsWithoutRejectingTheRest()
    {
        var rules = TagLookValidation.NormalizeRules(new[]
        {
            Rule("kids", " CAPTION ", When("LIBRARY", "01234567-89AB-CDEF-0123-456789ABCDEF"), When("type", "episode"), When("mood", "sad")),
            Rule("bad-library", "bands", When("library", "Kids")),
            Rule("bad-layout", "grid", When("type", "Movie")),
            new TagLookRule { Id = "bad-density", Layout = "bands", Density = "tiny", When = [When("type", "Movie")] },
            Rule("bad-type", "bands", When("type", "Person")),
            Rule("kids", "minimal", When("genre", " Animation "), When("ageRating", "PG")),
            new TagLookRule { Id = "no-density", Layout = "summary", Density = "", Enabled = false, When = [When("ageRating", "TV-MA")], ColourPreset = "Not A Preset!", Slots = [new() { Group = "agerating", Slot = "pill" }, new() { Group = "genre", Slot = "dots" }] },
            null,
        })!;

        // The first "kids" rule has an unknown condition (mood): dropping only that condition would
        // widen the rule to every episode in the library, so the whole rule goes.
        Assert.Equal(2, rules.Count);
        Assert.Equal("kids", rules[0].Id);
        Assert.Equal("minimal", rules[0].Layout);
        Assert.Equal(new[] { "kids", "rule-2", "rule-3" }, TagLookValidation.NormalizeRules(new[] { Rule("kids", "caption", When("type", "Movie")), Rule("kids", "bands", When("type", "Movie")), Rule("", "bands", When("type", "Movie")) })!.Select(r => r.Id));
        Assert.Equal(new[] { ("library", Library), ("type", "Episode") }, TagLookValidation.NormalizeRules(new[] { Rule("kids", " CAPTION ", When("LIBRARY", "01234567-89AB-CDEF-0123-456789ABCDEF"), When("type", "episode")) })!.Single().When.Select(c => (c.Field, c.Value)));
        Assert.Equal(new[] { ("genre", "Animation"), ("ageRating", "PG") }, rules[0].When.Select(c => (c.Field, c.Value)));
        Assert.Equal("full", rules[1].Density);
        Assert.False(rules[1].Enabled);
        Assert.Null(rules[1].ColourPreset);
        Assert.Equal(("ageRating", "pill"), (rules[1].Slots!.Single().Group, rules[1].Slots!.Single().Slot));

        Assert.Null(TagLookValidation.NormalizeRules(null));
        Assert.Empty(TagLookValidation.NormalizeRules(Array.Empty<TagLookRule>())!);
    }

    [Fact]
    public void RulesAreCappedAtFiftyWithFiveConditionsEach()
    {
        var many = Enumerable.Range(0, 60).Select(i => Rule("r" + i, "bands",
            Enumerable.Range(0, TagLookValidation.MaxConditions).Select(j => When("genre", "G" + j)).ToArray()));
        var rules = TagLookValidation.NormalizeRules(many)!;
        Assert.Equal(TagLookValidation.MaxRules, rules.Count);
        Assert.All(rules, r => Assert.Equal(TagLookValidation.MaxConditions, r.When.Count));
        Assert.Equal("r49", rules[^1].Id);
        // A rule with more conditions than allowed is dropped rather than cut short (which would widen it).
        Assert.Empty(TagLookValidation.NormalizeRules(new[] { Rule("six", "bands", Enumerable.Range(0, TagLookValidation.MaxConditions + 1).Select(j => When("genre", "G" + j)).ToArray()) })!);
    }

    [Fact]
    public void LocksValidateIdsAndValuesAndKeepTheNewestFiveHundred()
    {
        var locks = TagLookValidation.NormalizeLocks(new Dictionary<string, TagLayoutLock?>
        {
            ["Abcdefabcdefabcdefabcdefabcdefab"] = new() { Layout = "caption", Density = "compact", LockedAt = 5, Slots = [new() { Group = "status", Slot = "poster" }, new() { Group = "quality", Slot = "tl" }] },
            ["abcdefab-cdef-abcd-efab-cdefabcdefab"] = new() { Layout = "bands", LockedAt = 3 },
            ["not-an-id"] = new() { Layout = "bands", LockedAt = 9 },
            ["11111111111111111111111111111111"] = new() { Layout = "grid", LockedAt = 9 },
            ["22222222222222222222222222222222"] = new() { Layout = "minimal", Density = "huge", LockedAt = 9 },
            ["33333333333333333333333333333333"] = null,
        })!;
        var only = Assert.Single(locks);
        Assert.Equal("abcdefabcdefabcdefabcdefabcdefab", only.Key);
        Assert.Equal("caption", only.Value.Layout); // the newer of the two spellings of one id
        Assert.Equal(("status", "poster"), (only.Value.Slots!.Single().Group, only.Value.Slots!.Single().Slot));

        var many = Enumerable.Range(0, 520).ToDictionary(i => i.ToString("x32"), i => (TagLayoutLock?)new TagLayoutLock { Layout = "bands", LockedAt = i });
        var capped = TagLookValidation.NormalizeLocks(many)!;
        Assert.Equal(TagLookValidation.MaxLocks, capped.Count);
        Assert.DoesNotContain(19.ToString("x32"), capped.Keys);
        Assert.Contains(20.ToString("x32"), capped.Keys);
        Assert.Null(TagLookValidation.NormalizeLocks(null));
    }

    [Fact]
    public void PostedDocumentBindsCamelCaseRulesAndPascalCaseLockKeysThenNormalizes()
    {
        // The client converts top-level and object keys to PascalCase (so lock ids
        // arrive with a capital first letter) but never array items (rules arrive
        // camelCase); model binding is case-insensitive.
        const string posted = "{\"TagLookRules\":[{\"id\":\"a\",\"enabled\":true,\"when\":[{\"field\":\"type\",\"value\":\"Movie\"}],\"layout\":\"caption\",\"density\":\"compact\",\"colourPreset\":null,\"slots\":null}],"
            + "\"TagLayoutLocks\":{\"Abcdefabcdefabcdefabcdefabcdefab\":{\"Layout\":\"bands\",\"Density\":\"full\",\"Slots\":[{\"group\":\"quality\",\"slot\":\"top\"}],\"LockedAt\":7}}}";
        var bound = JsonSerializer.Deserialize<JellyfinEnhancedUserSettings>(posted, new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
        TagLookValidation.Normalize(bound);
        var rule = Assert.Single(bound.TagLookRules!);
        Assert.Equal(("a", "caption", "compact"), (rule.Id, rule.Layout, rule.Density));
        var (id, lockValue) = Assert.Single(bound.TagLayoutLocks!);
        Assert.Equal("abcdefabcdefabcdefabcdefabcdefab", id);
        Assert.Equal("top", lockValue.Slots!.Single().Slot);

        using var f = new CoreFixture();
        f.Manager.SaveUserConfiguration(User, "settings.json", bound);
        var loaded = f.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(User, "settings.json");
        Assert.Equal("caption", loaded.TagLookRules!.Single().Layout);
        Assert.Equal(7, loaded.TagLayoutLocks!["abcdefabcdefabcdefabcdefabcdefab"].LockedAt);
    }

    [Fact]
    public void AdminDefaultRulesSeedNewUsersRoundTripTheXmlAndArePublishedNormalized()
    {
        var config = new PluginConfiguration
        {
            TagLookRules = [Rule("kids", "caption", When("library", Library)), Rule("junk", "grid", When("type", "Movie"))],
        };
        var user = new JellyfinEnhancedUserSettings { TagLayoutLocks = new() { [User] = new TagLayoutLock { Layout = "bands" } } };
        TagLookValidation.ApplyDefaults(user, config);
        Assert.Equal("kids", Assert.Single(user.TagLookRules!).Id);
        Assert.Null(user.TagLayoutLocks); // locks are personal

        var serializer = new XmlSerializer(typeof(PluginConfiguration));
        using var stream = new MemoryStream();
        serializer.Serialize(stream, config);
        stream.Position = 0;
        var loaded = (PluginConfiguration)serializer.Deserialize(stream)!;
        Assert.Equal(new[] { "kids", "junk" }, loaded.TagLookRules!.Select(r => r.Id));
        Assert.Equal(Library, loaded.TagLookRules![0].When.Single().Value);

        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.TagLookRules = config.TagLookRules;
        var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), fixture.Core.Paths.Object, fixture.Core.Logger);
        var controller = ApiAssetTests.Controller(fixture.Core, maintenance);
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.Role, "User")], "test"));
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(Assert.IsType<JsonResult>(controller.GetPublicConfig()).Value));
        var published = document.RootElement.GetProperty("TagLookRules");
        Assert.Equal("kids", Assert.Single(published.EnumerateArray()).GetProperty("Id").GetString());
    }

    // GetBaseItemKind() reads the type name, so the stand-ins keep Jellyfin's.
    private sealed class Episode : MediaBrowser.Controller.Entities.TV.Episode
    {
        public override List<MediaBrowser.Model.Dto.MediaSourceInfo> GetMediaSources(bool enablePathSubstitution) => [];
    }

    private sealed class Movie : MediaBrowser.Controller.Entities.Movies.Movie
    {
        public override List<MediaBrowser.Model.Dto.MediaSourceInfo> GetMediaSources(bool enablePathSubstitution) => [];
    }

    [Fact]
    public void SeasonsAndEpisodesKeepTheirOwnScoresAndOnlyBorrowWhenTheyHaveNone()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        var series = new Series { Id = Guid.NewGuid(), Name = "Series", CommunityRating = 8, CriticRating = 90 };
        var season = new Season { Id = Guid.NewGuid(), ParentId = series.Id, SeriesId = series.Id, IndexNumber = 1, Name = "Season 1", CriticRating = 20 };
        var critic = new Episode { Id = Guid.NewGuid(), ParentId = season.Id, SeriesId = series.Id, SeasonId = season.Id, IndexNumber = 1, ParentIndexNumber = 1, Name = "Critic only", CriticRating = 20 };
        var bare = new Episode { Id = Guid.NewGuid(), ParentId = season.Id, SeriesId = series.Id, SeasonId = season.Id, IndexNumber = 2, ParentIndexNumber = 1, Name = "No scores" };
        var all = new BaseItem[] { series, season, critic, bare };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => all.SingleOrDefault(i => i.Id == id));
        library.Setup(l => l.GetItemById<BaseItem>(It.IsAny<Guid>())).Returns((Guid id) => all.SingleOrDefault(i => i.Id == id));
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new List<BaseItem>());
        library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns(new List<Guid>());
        library.Setup(l => l.GetCollectionFolders(It.IsAny<BaseItem>())).Returns(new List<Folder>());
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));

        foreach (var child in new BaseItem[] { season, critic })
        {
            var entry = cache.BuildEntryOnDemand(child)!;
            Assert.Null(entry.CommunityRating); // never the series' 8 next to the child's own critic score
            Assert.Equal(20, entry.CriticRating);
        }
        var borrowed = cache.BuildEntryOnDemand(bare)!;
        Assert.Equal(8, borrowed.CommunityRating);
        Assert.Equal(90, borrowed.CriticRating);
    }

    [Fact]
    public void CacheEntriesCarryTheLibraryOfTheItemOrItsSeries()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        var movies = new CollectionFolder { Id = Guid.NewGuid(), Name = "Movies" };
        var shows = new CollectionFolder { Id = Guid.NewGuid(), Name = "Shows" };
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Movie" };
        var loose = new Movie { Id = Guid.NewGuid(), Name = "Outside every library" };
        var series = new Series { Id = Guid.NewGuid(), Name = "Series" };
        var season = new Season { Id = Guid.NewGuid(), ParentId = series.Id, SeriesId = series.Id, IndexNumber = 1, Name = "Season 1" };
        var episode = new Episode { Id = Guid.NewGuid(), ParentId = season.Id, SeriesId = series.Id, SeasonId = season.Id, IndexNumber = 1, ParentIndexNumber = 1, Name = "Pilot" };
        var all = new BaseItem[] { movie, loose, series, season, episode };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => all.SingleOrDefault(i => i.Id == id));
        library.Setup(l => l.GetItemById<BaseItem>(It.IsAny<Guid>())).Returns((Guid id) => all.SingleOrDefault(i => i.Id == id));
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new List<BaseItem>());
        library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns(new List<Guid>());
        // Only the movie and the series answer for themselves: a season or
        // episode must be resolved through its series.
        library.Setup(l => l.GetCollectionFolders(It.IsAny<BaseItem>())).Returns((BaseItem item) =>
            item.Id == movie.Id ? [movies] : item.Id == series.Id ? [shows] : new List<Folder>());
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));

        Assert.Equal(movies.Id.ToString("N"), cache.BuildEntryOnDemand(movie)!.LibraryId);
        Assert.Equal(shows.Id.ToString("N"), cache.BuildEntryOnDemand(series)!.LibraryId);
        Assert.Equal(shows.Id.ToString("N"), cache.BuildEntryOnDemand(season)!.LibraryId);
        Assert.Equal(shows.Id.ToString("N"), cache.BuildEntryOnDemand(episode)!.LibraryId);
        var outside = cache.BuildEntryOnDemand(loose)!;
        Assert.Null(outside.LibraryId);
        Assert.DoesNotContain("LibraryId", JsonSerializer.Serialize(outside, new JsonSerializerOptions { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull }));

        // A library move is a content change, and copies keep the field.
        var entry = cache.BuildEntryOnDemand(movie)!;
        var moved = entry.Clone();
        Assert.Equal(entry.LibraryId, moved.LibraryId);
        moved.LibraryId = shows.Id.ToString("N");
        Assert.False(TagCacheEntry.ContentEquals(entry, moved));

        // A failing lookup never fails the entry.
        library.Setup(l => l.GetCollectionFolders(It.IsAny<BaseItem>())).Throws(new InvalidOperationException("boom"));
        Assert.Null(cache.BuildEntryOnDemand(movie)!.LibraryId);
    }

    [Theory]
    [InlineData(9)]
    [InlineData(10)]
    [InlineData(11)]
    [InlineData(20)]
    [InlineData(23)]
    [InlineData(51)] // a development build's snapshot
    public void OlderSnapshotsAreDiscardedForRebuild(int oldSchema)
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        Directory.CreateDirectory(f.Core.ConfigRoot);
        var items = new Dictionary<string, TagCacheEntry> { [Guid.NewGuid().ToString("N")] = new() { Type = "Movie", Genres = ["Drama"], LastUpdated = 100 } };
        var path = Path.Combine(f.Core.ConfigRoot, "tag-cache.json");
        var library = new Mock<ILibraryManager>();
        TagCacheService Create() => new(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));

        File.WriteAllText(path, JsonSerializer.Serialize(new { SchemaVersion = oldSchema, Version = 7, LastModified = 200, Items = items }));
        using (var old = Create())
        {
            old.LoadFromDisk();
            Assert.Equal(0, old.Count);
        }

        File.WriteAllText(path, JsonSerializer.Serialize(new { SchemaVersion = TagCacheService.CurrentCacheSchemaVersion, Version = 7, LastModified = 200, Items = items }));
        using var current = Create();
        current.LoadFromDisk();
        Assert.Equal(1, current.Count);
    }
}
