using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;

namespace JE.Tests;

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
}
