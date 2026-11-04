using System.Reflection;
using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Globalization;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering;
using Microsoft.AspNetCore.Mvc;
using Moq;
using SkiaSharp;

namespace JE.Tests;

/// <summary>
/// Custom tag group: rule validation and normalisation, the matcher, and the
/// CustomTags cache field (full build, incremental updates, rule changes).
/// </summary>
[Collection("Plugin singleton")]
public class CustomTagRulesTests
{
    private static CustomTagRule Rule(string match, string value, string label, string? icon = null) =>
        new() { Match = match, Value = value, Label = label, Icon = icon };

    /// <summary>A rule's id under the test configuration's (empty) key.</summary>
    private static string Id(string match, string value, string? key = null) => CustomTagRuleSet.RuleId(Rule(match, value, "x"), key);

    [Fact]
    public void NormalizeDropsUnknownMatchTypesTrimsLabelsAndCollapsesDuplicates()
    {
        var rules = CustomTagRuleSet.Normalize(new CustomTagRule?[]
        {
            Rule(" TAG ", "  4K   Remaster ", "  Remaster  ", "AUTO_AWESOME"),
            Rule("genre", "Drama", "Drama"),
            Rule("collection", "Criterion Collection", "A label that is far longer than twenty-four characters"),
            Rule("tag", "4k remaster", "Duplicate"),
            Rule("collection", "Criterion Collection", "Duplicate collection"),
            Rule("tag", "   ", "Empty value"),
            Rule("tag", "Signed", "   "),
            Rule("tag", "Bad icon", "Bad icon", "<script>"),
            null,
        });

        Assert.Equal(3, rules.Count);
        Assert.Equal(("tag", "4K Remaster", "Remaster", "auto_awesome"), (rules[0].Match, rules[0].Value, rules[0].Label, rules[0].Icon));
        Assert.Equal("collection", rules[1].Match);
        Assert.Equal(CustomTagRuleSet.MaxLabelLength, rules[1].Label.Length);
        Assert.Equal("A label that is far long", rules[1].Label);
        Assert.Null(rules[2].Icon);
        // Ids name the match type but not the value: a keyed hash, the same for any case of it.
        Assert.Matches("^tag:[0-9a-f]{16}$", CustomTagRuleSet.RuleId(rules[0], "key"));
        Assert.Matches("^collection:[0-9a-f]{16}$", CustomTagRuleSet.RuleId(rules[1], "key"));
        Assert.DoesNotContain("criterion", CustomTagRuleSet.RuleId(rules[1], "key"), StringComparison.OrdinalIgnoreCase);
        Assert.Equal(CustomTagRuleSet.RuleId(rules[0], "key"), CustomTagRuleSet.RuleId(Rule("tag", "4k REMASTER", "Other"), "key"));
        Assert.NotEqual(CustomTagRuleSet.RuleId(rules[0], "key"), CustomTagRuleSet.RuleId(rules[0], "other key"));
        Assert.Empty(CustomTagRuleSet.Normalize(null));
    }

    [Fact]
    public void PunctuationOnlyLabelsAreReservedForRulesAndTagStylesAlike()
    {
        // "*" is Tag Styles' whole-group key: a rule labelled "*" could never have a colour of its own.
        var rules = CustomTagRuleSet.Normalize(new[] { Rule("tag", "A", "*"), Rule("tag", "B", " !? "), Rule("tag", "C", "+"), Rule("tag", "D", "*Star*") });
        Assert.Equal(new[] { "+", "*Star*" }, rules.Select(r => r.Label));
        Assert.False(TagStyleSet.TryValidate("{\"v\":2,\"labels\":{\"custom:!?\":{\"text\":\"#fff\"}}}", "default", out _, out _));
        Assert.True(TagStyleSet.TryValidate("{\"v\":2,\"labels\":{\"custom:*Star*\":{\"text\":\"#fff\"}}}", "default", out _, out var error), error);
    }

    [Fact]
    public void NormalizeKeepsAtMostTwentyRules()
    {
        var rules = CustomTagRuleSet.Normalize(Enumerable.Range(0, 30).Select(i => Rule("tag", "Tag " + i, "Label " + i)));
        Assert.Equal(CustomTagRuleSet.MaxRules, rules.Count);
        Assert.Equal("Tag 19", rules[^1].Value);
    }

    [Fact]
    public void MatcherReturnsRuleIdsInTableOrderIgnoringCaseAndWhitespace()
    {
        var matcher = new CustomTagMatcher(new[]
        {
            Rule("collection", "Criterion", "Criterion"),
            Rule("tag", "4K Remaster", "Remaster"),
            Rule("tag", "Signed", "Signed"),
        });

        Assert.True(matcher.HasCollectionRules);
        Assert.True(matcher.IsRuleCollection("  CRITERION "));
        Assert.Equal(new[] { Id("collection", "criterion"), Id("tag", "4k remaster") }, matcher.Match(new[] { "4k  remaster", "other" }, new[] { "criterion" }));
        Assert.Null(matcher.Match(new[] { "other" }, null));
        Assert.Null(new CustomTagMatcher(null).Match(new[] { "4K Remaster" }, null));
        Assert.Equal("Remaster", matcher.Find(Id("tag", "4k remaster"))?.Label);
        Assert.Null(matcher.Find("tag:unknown"));
    }

    [Fact]
    public void MatchFingerprintIgnoresLabelsIconsAndOrder()
    {
        var a = CustomTagRuleSet.MatchFingerprint(new[] { Rule("tag", "A", "One"), Rule("collection", "B", "Two") }, "key");
        var b = CustomTagRuleSet.MatchFingerprint(new[] { Rule("collection", "b", "Changed", "star"), Rule("tag", "a", "Other") }, "key");
        Assert.Equal(a, b);
        Assert.NotEqual(a, CustomTagRuleSet.MatchFingerprint(new[] { Rule("tag", "A", "One") }, "key"));
        Assert.NotEqual(a, CustomTagRuleSet.MatchFingerprint(new[] { Rule("tag", "A", "One"), Rule("collection", "B", "Two") }, "new key"));
        Assert.Equal(string.Empty, CustomTagRuleSet.MatchFingerprint(null, "key"));
    }

    [Theory]
    [InlineData("Remaster", true)]
    [InlineData("Criterion: Spine", true)]
    [InlineData(" padded", false)]
    [InlineData("", false)]
    [InlineData("tab\tinside", false)]
    [InlineData("twenty-five characters!!!", false)]
    [InlineData("*", false)]
    [InlineData("?! -", false)]
    [InlineData("+", true)]
    [InlineData("*Star*", true)]
    public void LabelValidationMatchesTheRuleLabels(string label, bool valid) =>
        Assert.Equal(valid, CustomTagRuleSet.IsValidLabel(label));

    /// <summary>The label cases the rules table is checked against too (features-custom-tags.test.mjs).</summary>
    public static IEnumerable<object[]> SharedLabels()
    {
        using var stream = typeof(CustomTagRulesTests).Assembly.GetManifestResourceStream("CustomTagLabels.json")!;
        using var document = JsonDocument.Parse(stream);
        return document.RootElement.EnumerateArray().Select(row => new object[]
        { row.GetProperty("label").GetString()!, row.GetProperty("stored").GetString()!, row.GetProperty("kept").GetBoolean(), row.GetProperty("note").GetString()! }).ToArray();
    }

    [Theory]
    [MemberData(nameof(SharedLabels))]
    public void ReservedLabelsAreClassifiedByUnicodeScalarValueLikeTheRulesTable(string label, string stored, bool kept, string note)
    {
        // U+10100 is one punctuation scalar value: its two surrogates are not punctuation
        // chars, which kept a rule the rules table drops (and Tag Styles accepted its label).
        var saved = CustomTagRuleSet.Normalize([Rule("tag", "Value", label)]);
        Assert.True(kept == (saved.Count == 1), note);
        if (kept) Assert.Equal(stored, saved[0].Label);
        Assert.True(kept == CustomTagRuleSet.IsValidLabel(stored), note);
        Assert.True(kept == TagStyleCatalog.IsLabel(TagStyleKeys.Custom, stored), note);
    }

    [Fact]
    public void ConfigurationSavesStoreNormalizedRules()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.UpdateConfiguration(new PluginConfiguration
        {
            CustomTagRules = new List<CustomTagRule> { Rule("Tag", " Signed ", " Signed "), Rule("unknown", "x", "x"), Rule("tag", "SIGNED", "Again") },
        });
        var saved = Assert.Single(f.Plugin.Configuration.CustomTagRules);
        Assert.Equal(("tag", "Signed", "Signed"), (saved.Match, saved.Value, saved.Label));
    }

    [Fact]
    public void CustomTagsTakePartInContentEqualityAndClones()
    {
        var a = new TagCacheEntry { Type = "Movie", CustomTags = [Id("tag", "signed")] };
        var b = a.Clone();
        Assert.Equal(a.CustomTags, b.CustomTags);
        Assert.True(TagCacheEntry.ContentEquals(a, b));
        b.CustomTags = [Id("tag", "signed"), Id("collection", "criterion")];
        Assert.False(TagCacheEntry.ContentEquals(a, b));
    }

    private sealed class Library
    {
        public readonly List<BaseItem> Items = new();
        public readonly Mock<ILibraryManager> Mock = new();
        /// <summary>Items a user's queries (their access set) do not return, by user id.</summary>
        public readonly Dictionary<Guid, HashSet<Guid>> HiddenFrom = new();

        public Library()
        {
            IEnumerable<BaseItem> Select(InternalItemsQuery q)
            {
                IEnumerable<BaseItem> selected = Items;
                if (q.User != null && HiddenFrom.TryGetValue(q.User.Id, out var hidden)) selected = selected.Where(i => !hidden.Contains(i.Id));
                if (q.ItemIds?.Length > 0) selected = selected.Where(i => q.ItemIds.Contains(i.Id));
                else if (q.IncludeItemTypes?.Length > 0) selected = selected.Where(i => q.IncludeItemTypes.Contains(i.GetBaseItemKind()));
                if (q.ParentId != Guid.Empty) selected = selected.Where(i => i.ParentId == q.ParentId || (i is Episode e && e.SeriesId == q.ParentId));
                return selected.Skip(q.StartIndex ?? 0).Take(q.Limit ?? int.MaxValue).ToArray();
            }

            Mock.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => Select(q).Select(i => i.Id).ToArray());
            Mock.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => Select(q).ToArray());
            Mock.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => Items.SingleOrDefault(i => i.Id == id));
            Mock.Setup(l => l.GetItemById<BaseItem>(It.IsAny<Guid>())).Returns((Guid id) => Items.SingleOrDefault(i => i.Id == id));
        }
    }

    private static void Flush(TagCacheService cache) =>
        typeof(TagCacheService).GetMethod("FlushPending", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(cache, null);

    private static string[]? TagsOf(TagCacheService cache, BaseItem item) =>
        cache.TryGetEntry(item.Id, out var entry) ? entry.CustomTags : throw new InvalidOperationException("no entry for " + item.Name);

    [Fact]
    public void ASeriesOnlyEditReachesTheScoresAndRatingItsChildrenInherit()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        var library = new Library();
        var previous = BaseItem.LibraryManager;
        BaseItem.LibraryManager = library.Mock.Object;
        try
        {
            var series = new Series { Id = Guid.NewGuid(), Name = "Show", CommunityRating = 8, CriticRating = 90, OfficialRating = "TV-14" };
            var season = new Season { Id = Guid.NewGuid(), Name = "Season 1", ParentId = series.Id, SeriesId = series.Id, IndexNumber = 1 };
            var episode = new Episode { Id = Guid.NewGuid(), Name = "Pilot", ParentId = season.Id, SeasonId = season.Id, SeriesId = series.Id, IndexNumber = 1, ParentIndexNumber = 1 };
            var own = new Episode { Id = Guid.NewGuid(), Name = "Own", ParentId = season.Id, SeasonId = season.Id, SeriesId = series.Id, IndexNumber = 2, ParentIndexNumber = 1, CriticRating = 40, OfficialRating = "TV-PG" };
            library.Items.AddRange(new BaseItem[] { series, season, episode, own });
            using var cache = new TagCacheService(library.Mock.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
            cache.BuildFullCache(null, CancellationToken.None);
            (float?, float?, string?) Facts(BaseItem item) => cache.TryGetEntry(item.Id, out var entry) ? (entry.CommunityRating, entry.CriticRating, entry.OfficialRating) : throw new InvalidOperationException(item.Name);
            Assert.Equal((8f, 90f, "TV-14"), Facts(episode));
            Assert.Equal((8f, 90f, "TV-14"), Facts(season));

            // Only the series is saved and queued (as Jellyfin does for a series metadata edit).
            series.CommunityRating = 5; series.CriticRating = 20; series.OfficialRating = "TV-MA";
            cache.EnqueueUpdate(series.Id);
            Flush(cache);
            Assert.Equal((5f, 20f, "TV-MA"), Facts(series));
            Assert.Equal((5f, 20f, "TV-MA"), Facts(season));
            Assert.Equal((5f, 20f, "TV-MA"), Facts(episode));
            Assert.Equal((null, 40f, "TV-PG"), Facts(own)); // its own scores and rating stay
            Assert.Equal(Facts(episode), (cache.BuildEntryOnDemand(episode)!.CommunityRating, cache.BuildEntryOnDemand(episode)!.CriticRating, cache.BuildEntryOnDemand(episode)!.OfficialRating));
        }
        finally
        {
            BaseItem.LibraryManager = previous;
        }
    }

    [Fact]
    public void CombinedEpisodeFilesCoverTheirRangeInTheFullBuildAsOnDemand()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        var library = new Library();
        var previous = BaseItem.LibraryManager;
        BaseItem.LibraryManager = library.Mock.Object;
        try
        {
            var series = new Series { Id = Guid.NewGuid(), Name = "Show" };
            var season = new Season { Id = Guid.NewGuid(), Name = "Season 1", ParentId = series.Id, SeriesId = series.Id, IndexNumber = 1 };
            library.Items.AddRange(new BaseItem[] { series, season });
            for (var start = 1; start <= 9; start += 2)
                library.Items.Add(new Episode { Id = Guid.NewGuid(), Name = $"E{start}", ParentId = season.Id, SeasonId = season.Id, SeriesId = series.Id,
                    ParentIndexNumber = 1, IndexNumber = start, IndexNumberEnd = start + 1, DateCreated = DateTime.UtcNow.AddDays(-1), PremiereDate = DateTime.UtcNow.AddDays(-30 + start) });
            using var cache = new TagCacheService(library.Mock.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
            cache.BuildFullCache(null, CancellationToken.None);
            Assert.True(cache.TryGetEntry(season.Id, out var built));
            Assert.Equal(10, built.SeasonAddedSpan?.CoveredThrough);
            Assert.Equal(10, built.LatestEpisodeIndex?.Episode);
            Assert.Equal(built.SeasonAddedSpan, cache.BuildEntryOnDemand(season)!.SeasonAddedSpan);
        }
        finally
        {
            BaseItem.LibraryManager = previous;
        }
    }

    [Fact]
    public void PublicationStampsNeverRepeatEvenWithinOneMillisecond()
    {
        // A delta returns entries strictly after the client's cursor: a second publication in the same millisecond
        // must still get a later stamp, or a browser that read the first would never see it.
        using var f = new ApiPluginFixture();
        var library = new Library();
        using var cache = new TagCacheService(library.Mock.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
        var stamps = Enumerable.Range(0, 5000).Select(_ => cache.NextStamp()).ToArray();
        Assert.All(stamps.Zip(stamps.Skip(1)), pair => Assert.True(pair.Second > pair.First));
        Assert.True(stamps[^1] - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() <= 5000); // never far ahead of the clock
    }

    [Fact]
    public void ASeriesGenreEditReachesASeasonThatTookItsGenres()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        var library = new Library();
        var previous = BaseItem.LibraryManager;
        BaseItem.LibraryManager = library.Mock.Object;
        try
        {
            var series = new Series { Id = Guid.NewGuid(), Name = "Show", Genres = ["Drama"] };
            var season = new Season { Id = Guid.NewGuid(), Name = "Season 1", ParentId = series.Id, SeriesId = series.Id, IndexNumber = 1 };
            var own = new Season { Id = Guid.NewGuid(), Name = "Season 2", ParentId = series.Id, SeriesId = series.Id, IndexNumber = 2, Genres = ["Documentary"] };
            library.Items.AddRange(new BaseItem[] { series, season, own });
            using var cache = new TagCacheService(library.Mock.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
            cache.BuildFullCache(null, CancellationToken.None);
            string[]? Genres(BaseItem item) => cache.TryGetEntry(item.Id, out var entry) ? entry.Genres : throw new InvalidOperationException(item.Name);
            Assert.Equal(["Drama"], Genres(season));

            series.Genres = ["Comedy"];
            cache.EnqueueUpdate(series.Id);
            Flush(cache);
            Assert.Equal(["Comedy"], Genres(season));
            Assert.Equal(["Documentary"], Genres(own)); // its own genres stay
        }
        finally
        {
            BaseItem.LibraryManager = previous;
        }
    }

    [Fact]
    public void ARestrictedUsersSeriesLanguagesComeOnlyFromEpisodesTheyCanSee()
    {
        using var f = new ApiPluginFixture();
        var library = new Library();
        using var cache = new TagCacheService(library.Mock.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
        var english = new TagCacheEntry { Type = "Episode", SeasonNumber = 1, AudioLanguages = ["en"], SubtitleLanguages = ["en"] };
        var japanese = new TagCacheEntry { Type = "Episode", SeasonNumber = 1, AudioLanguages = ["ja"], SubtitleLanguages = ["ja"] };
        var series = new TagCacheEntry { Type = "Series", QualityEpisodeIds = ["e1", "e2"], AudioLanguages = ["en", "ja"], PartialAudioLanguages = ["en", "ja"], SubtitleLanguages = ["en", "ja"] };
        var entries = new Dictionary<string, TagCacheEntry> { ["e1"] = english, ["e2"] = japanese };
        var filter = typeof(TagCacheService).GetMethod("FilterQuality", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var filtered = (TagCacheEntry)filter.Invoke(cache, new object?[] { series, new HashSet<string> { "e1" }, entries, null, null })!;
        Assert.Equal(["en"], filtered.AudioLanguages);
        Assert.Null(filtered.PartialAudioLanguages); // English is on every episode this user can see
        Assert.Equal(["en"], filtered.SubtitleLanguages);
        var everyone = (TagCacheEntry)filter.Invoke(cache, new object?[] { series, new HashSet<string> { "e1", "e2" }, entries, null, null })!;
        Assert.Same(series, everyone);
    }

    [Fact]
    public async Task ASeriesEditDropsItsChildrenFromTheNativeOnDemandMemo()
    {
        // Cache off: native posters build entries on demand and keep them for a while.
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = false;
        var library = new Library();
        var previous = BaseItem.LibraryManager;
        BaseItem.LibraryManager = library.Mock.Object;
        try
        {
            var series = new Series { Id = Guid.NewGuid(), Name = "Show", CommunityRating = 8, CriticRating = 90, OfficialRating = "TV-14" };
            var season = new Season { Id = Guid.NewGuid(), Name = "Season 1", ParentId = series.Id, SeriesId = series.Id, IndexNumber = 1 };
            var episode = new Episode { Id = Guid.NewGuid(), Name = "Pilot", ParentId = season.Id, SeasonId = season.Id, SeriesId = series.Id, IndexNumber = 1, ParentIndexNumber = 1 };
            library.Items.AddRange(new BaseItem[] { series, season, episode });
            using var cache = new TagCacheService(library.Mock.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
            using var native = new PosterTagDataProvider(cache, library.Mock.Object, null!, null!, null!, f.Core.Logger);
            var get = typeof(PosterTagDataProvider).GetMethod("GetOrBuildAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
            async Task<TagCacheEntry?> Entry(BaseItem item) => await (Task<TagCacheEntry?>)get.Invoke(native, new object[] { item, CancellationToken.None })!;
            Assert.Equal(8f, (await Entry(episode))!.CommunityRating);

            series.CommunityRating = 5; series.CriticRating = 20; series.OfficialRating = "TV-MA";
            library.Mock.Raise(l => l.ItemUpdated += null, library.Mock.Object, new ItemChangeEventArgs { Item = series });
            var rebuilt = (await Entry(episode))!;
            Assert.Equal((5f, 20f, "TV-MA"), (rebuilt.CommunityRating, rebuilt.CriticRating, rebuilt.OfficialRating));
            Assert.Equal("TV-MA", (await Entry(season))!.OfficialRating);
        }
        finally
        {
            BaseItem.LibraryManager = previous;
        }
    }

    [Fact]
    public void TheCacheMatchesTagsInheritedTagsAndCollectionsAndFollowsLibraryChanges()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        f.Plugin.Configuration.CustomTagRules = CustomTagRuleSet.Normalize(new[]
        {
            Rule("collection", "Criterion", "Criterion"),
            Rule("tag", "4K Remaster", "Remaster", "auto_awesome"),
        });
        var library = new Library();
        var previous = BaseItem.LibraryManager;
        BaseItem.LibraryManager = library.Mock.Object;
        try
        {
            var tagged = new Movie { Id = Guid.NewGuid(), Name = "Tagged", Tags = ["4k remaster"] };
            var member = new Movie { Id = Guid.NewGuid(), Name = "Member" };
            var plain = new Movie { Id = Guid.NewGuid(), Name = "Plain", Tags = ["Other"] };
            var series = new Series { Id = Guid.NewGuid(), Name = "Show", Tags = ["4K Remaster"] };
            var season = new Season { Id = Guid.NewGuid(), Name = "Season 1", ParentId = series.Id, SeriesId = series.Id, IndexNumber = 1 };
            var episode = new Episode { Id = Guid.NewGuid(), Name = "Pilot", ParentId = season.Id, SeasonId = season.Id, SeriesId = series.Id, IndexNumber = 1, ParentIndexNumber = 1 };
            var boxSet = new BoxSet { Id = Guid.NewGuid(), Name = "Criterion", LinkedChildren = [new LinkedChild { ItemId = member.Id }] };
            library.Items.AddRange(new BaseItem[] { tagged, member, plain, series, season, episode, boxSet });

            using var cache = new TagCacheService(library.Mock.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
            cache.BuildFullCache(null, CancellationToken.None);

            Assert.Equal(new[] { Id("tag", "4k remaster") }, TagsOf(cache, tagged));
            Assert.Equal(new[] { Id("collection", "criterion") }, TagsOf(cache, member));
            Assert.Null(TagsOf(cache, plain));
            // Seasons and episodes take their series' tags.
            foreach (var item in new BaseItem[] { series, season, episode }) Assert.Equal(new[] { Id("tag", "4k remaster") }, TagsOf(cache, item));
            Assert.Equal(cache.BuildEntryOnDemand(member)!.CustomTags, TagsOf(cache, member));

            // A collection change re-reads membership and patches old and new members.
            boxSet.LinkedChildren = [new LinkedChild { ItemId = plain.Id }];
            cache.EnqueueUpdate(boxSet.Id);
            Flush(cache);
            Assert.Null(TagsOf(cache, member));
            Assert.Equal(new[] { Id("collection", "criterion") }, TagsOf(cache, plain));

            // A series whose own tags change patches its seasons and episodes.
            series.Tags = [];
            cache.EnqueueUpdate(series.Id);
            Flush(cache);
            foreach (var item in new BaseItem[] { series, season, episode }) Assert.Null(TagsOf(cache, item));

            // A series added to the collection: the series and its children match it.
            boxSet.LinkedChildren = [new LinkedChild { ItemId = plain.Id }, new LinkedChild { ItemId = series.Id }];
            cache.EnqueueUpdate(boxSet.Id);
            Flush(cache);
            foreach (var item in new BaseItem[] { series, season, episode }) Assert.Equal(new[] { Id("collection", "criterion") }, TagsOf(cache, item));

            // A removed collection drops its members' matches.
            library.Items.Remove(boxSet);
            cache.EnqueueRemoval(boxSet.Id);
            Flush(cache);
            Assert.Null(TagsOf(cache, plain));
            Assert.Null(TagsOf(cache, episode));
        }
        finally
        {
            BaseItem.LibraryManager = previous;
        }
    }

    [Fact]
    public void CollectionMatchesOnlyReachUsersWhoCanAccessTheCollection()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        f.Plugin.Configuration.CustomTagRules = CustomTagRuleSet.Normalize(new[] { Rule("collection", "Hidden Box", "Boxed"), Rule("tag", "Signed", "Signed") });
        var library = new Library();
        var previous = BaseItem.LibraryManager;
        BaseItem.LibraryManager = library.Mock.Object;
        try
        {
            var member = new Movie { Id = Guid.NewGuid(), Name = "Member", Tags = ["Signed"] };
            var series = new Series { Id = Guid.NewGuid(), Name = "Show" };
            var episode = new Episode { Id = Guid.NewGuid(), Name = "Pilot", SeriesId = series.Id, ParentId = series.Id, IndexNumber = 1, ParentIndexNumber = 1 };
            var box = new BoxSet { Id = Guid.NewGuid(), Name = "Hidden Box", LinkedChildren = [new LinkedChild { ItemId = member.Id }, new LinkedChild { ItemId = series.Id }] };
            library.Items.AddRange(new BaseItem[] { member, series, episode, box });
            var admin = new User("admin", "default", "default") { Id = Guid.NewGuid() };
            var viewer = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
            library.HiddenFrom[viewer.Id] = [];

            using var cache = new TagCacheService(library.Mock.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
            cache.BuildFullCache(null, CancellationToken.None);
            var both = new[] { Id("collection", "Hidden Box"), Id("tag", "Signed") };
            Assert.Equal(both, TagsOf(cache, member));

            // The viewer can see the collection: same matches, and a browser copy exists under this revision.
            var visible = cache.GetCacheForUser(viewer, out _, out _, out var visibleRevision);
            Assert.Equal(both, visible[member.Id.ToString("N")].CustomTags);

            // The collection is blocked for the viewer (the member stays visible): the projection, the
            // batch endpoint and native posters drop the collection match, the shared entry keeps it,
            // and the revision changes, so the stored copy is replaced rather than patched.
            library.HiddenFrom[viewer.Id].Add(box.Id);
            cache.InvalidateUserAccess();
            var hidden = cache.GetCacheForUser(viewer, out _, out _, out var hiddenRevision);
            Assert.NotEqual(visibleRevision, hiddenRevision);
            Assert.Equal(new[] { Id("tag", "Signed") }, hidden[member.Id.ToString("N")].CustomTags);
            Assert.Null(hidden[episode.Id.ToString("N")].CustomTags);
            Assert.Equal(both, TagsOf(cache, member));
            Assert.Equal(both, cache.GetCacheForUser(admin, out _, out _, out var adminRevision)[member.Id.ToString("N")].CustomTags);
            Assert.NotEqual(adminRevision, hiddenRevision);
            Assert.Equal(new[] { Id("tag", "Signed") }, cache.GetCustomTags(member, viewer));
            Assert.Null(cache.GetCustomTags(episode, viewer));
            Assert.Equal(both, cache.GetCustomTags(member, admin));
            Assert.Equal(new[] { Id("collection", "Hidden Box") }, cache.GetCustomTags(episode, admin));
            Assert.True(cache.TryGetEntry(member.Id, out var shared));
            Assert.Equal(new[] { Id("tag", "Signed") }, cache.FilterCustomTagsForUser(shared, member.Id, viewer).CustomTags);

            // A delta with nothing new still reports the viewer's current revision.
            var cursor = cache.GetCacheForUser(viewer, out _, out var timestamp, out _).Values.Max(e => e.LastUpdated);
            cache.GetCacheForUser(viewer, out _, out _, out var deltaRevision, since: cursor);
            Assert.Equal(hiddenRevision, deltaRevision);

            // Shared serialized bytes are never served across the two access sets.
            var adminItems = cache.GetShareableCacheForUser(admin, out _, out _, out _, out var shareKey);
            Assert.NotNull(shareKey);
            cache.StoreSerializedItems(shareKey!, JsonSerializer.SerializeToUtf8Bytes(adminItems), adminItems.Count);
            Assert.False(cache.TryGetSerializedItems(viewer, out _, out _, out var sharedRevision, out _, out _, out _));
            Assert.Equal(hiddenRevision, sharedRevision);

            // Native posters: the pinned data (and so the poster cache identity) follows the viewer's access.
            var resolver = new SpoilerUserResolver(f.Core.Manager, library.Mock.Object, f.Core.Logger, null!);
            using var native = new PosterTagDataProvider(cache, library.Mock.Object, new SpoilerTagDataStripper(library.Mock.Object, Mock.Of<IUserDataManager>(), resolver), resolver,
                new PosterTagReviewRatings(f.Core.Manager, new PosterTagUserCache(Mock.Of<IUserManager>()), f.Core.Logger), f.Core.Logger);
            var viewerPinned = native.GetPinnedSnapshot(member.Id, viewer)!;
            var adminPinned = native.GetPinnedSnapshot(member.Id, admin)!;
            Assert.Equal(new[] { Id("tag", "Signed") }, viewerPinned.Entry.CustomTags);
            Assert.Equal(both, adminPinned.Entry.CustomTags);
            Assert.NotEqual(adminPinned.PinnedHash, viewerPinned.PinnedHash);
        }
        finally
        {
            BaseItem.LibraryManager = previous;
        }
    }

    private static class Held
    {
        /// <summary>A movie whose media read can be held, to edit rules while its native build is in flight (named Movie: GetBaseItemKind reads the class name).</summary>
        public sealed class Movie : MediaBrowser.Controller.Entities.Movies.Movie
        {
            public ManualResetEventSlim? Hold { get; set; }
            public ManualResetEventSlim Reading { get; } = new();
            public override List<MediaBrowser.Model.Dto.MediaSourceInfo> GetMediaSources(bool enablePathSubstitution)
            {
                Reading.Set();
                Hold?.Wait(TimeSpan.FromSeconds(10));
                return [];
            }
        }
    }

    [Fact]
    public async Task RuleEditsReachNativeOnDemandEntriesWithTheCacheOffIncludingBuildsInFlight()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = false;
        f.Plugin.Configuration.CustomTagsEnabled = true;
        f.Plugin.Configuration.CustomTagRuleKey = "fixture-key";
        f.Plugin.Configuration.CustomTagRules = [];
        var movie = new Held.Movie { Id = Guid.NewGuid(), Name = "Synthetic", Tags = ["festival"] };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById(movie.Id)).Returns(movie);
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
        using var native = new PosterTagDataProvider(cache, library.Object, null!, null!, null!, f.Core.Logger);
        var getOrBuild = typeof(PosterTagDataProvider).GetMethod("GetOrBuildAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
        Task<TagCacheEntry?> Native() => (Task<TagCacheEntry?>)getOrBuild.Invoke(native, [movie, CancellationToken.None])!;
        void Patch(params CustomTagRule[] rules)
        {
            var result = PluginConfigurationPatch.Apply(f.Plugin, new Dictionary<string, JsonElement> { ["CustomTagRules"] = JsonSerializer.SerializeToElement(rules) }, null, MediaTagsPageFields.Allowed);
            Assert.Null(result.Error);
        }

        var before = await Native();
        Assert.Null(before!.CustomTags);
        // A rule added through the real field patch: the very next native read has the tag.
        Patch(Rule("tag", "festival", "Festival"));
        var added = await Native();
        Assert.Equal(new[] { Id("tag", "festival", "fixture-key") }, added!.CustomTags);
        Assert.Same(added, await Native());
        // A label or icon edit matches the same items: the entry is kept as it is.
        Patch(Rule("tag", "festival", "Festival!", "auto_awesome"));
        Assert.Same(added, await Native());
        // Retargeted: the tag goes.
        Patch(Rule("tag", "premiere", "Premiere"));
        Assert.Null((await Native())!.CustomTags);

        // A build in flight while the rule changes answers (and memoizes) the new matches.
        movie.Hold = new ManualResetEventSlim();
        var other = new Held.Movie { Id = Guid.NewGuid(), Name = "Other", Tags = ["festival"], Hold = movie.Hold };
        library.Setup(l => l.GetItemById(other.Id)).Returns(other);
        var inFlight = (Task<TagCacheEntry?>)getOrBuild.Invoke(native, [other, CancellationToken.None])!;
        Assert.True(other.Reading.Wait(TimeSpan.FromSeconds(10)));
        Patch(Rule("tag", "festival", "Festival"));
        movie.Hold.Set();
        Assert.Equal(new[] { Id("tag", "festival", "fixture-key") }, (await inFlight)!.CustomTags);
        Assert.Equal(new[] { Id("tag", "festival", "fixture-key") }, ((Task<TagCacheEntry?>)getOrBuild.Invoke(native, [other, CancellationToken.None])!).Result!.CustomTags);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void ThePublicConfigurationNamesNoRuleSourceAndAdminsGetThemPrivately(bool authenticated, bool admin)
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.UpdateConfiguration(new PluginConfiguration
        {
            CustomTagRules = [Rule("collection", "Secret Collection", "Boxed", "star"), Rule("tag", "secret-tag", "Signed", "auto_awesome")],
        });
        var config = fixture.Plugin.Configuration;
        Assert.Matches("^[0-9a-f]{32}$", config.CustomTagRuleKey);
        var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), fixture.Core.Paths.Object, fixture.Core.Logger);
        var controller = ApiAssetTests.Controller(fixture.Core, maintenance);
        var privateController = ApiAssetTests.Controller(fixture.Core, Mock.Of<IUserManager>());
        foreach (var c in new[] { controller, privateController })
        {
            c.HttpContext.User = new ClaimsPrincipal(authenticated
                ? new ClaimsIdentity([new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test")
                : new ClaimsIdentity());
        }

        var json = JsonSerializer.Serialize(Assert.IsType<JsonResult>(controller.GetPublicConfig()).Value);
        Assert.DoesNotContain("secret", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(config.CustomTagRuleKey, json);
        using (var document = JsonDocument.Parse(json))
        {
            var rules = document.RootElement.GetProperty("CustomTagRules").EnumerateArray().ToList();
            Assert.Equal(2, rules.Count);
            Assert.Equal(new[] { "Id", "Label", "Icon" }, rules[0].EnumerateObject().Select(p => p.Name));
            Assert.Equal(CustomTagMatcher.For(config).Ids, rules.Select(r => r.GetProperty("Id").GetString()));
            Assert.Equal(new[] { "Boxed", "Signed" }, rules.Select(r => r.GetProperty("Label").GetString()));
        }

        var privateJson = JsonSerializer.Serialize(Assert.IsType<JsonResult>(privateController.GetPrivateConfig()).Value);
        Assert.DoesNotContain(config.CustomTagRuleKey, privateJson);
        if (!admin)
        {
            Assert.Equal("{}", privateJson);
            return;
        }

        using var privateDocument = JsonDocument.Parse(privateJson);
        var sources = privateDocument.RootElement.GetProperty("CustomTagRuleSources").EnumerateArray().ToList();
        Assert.Equal(new[] { ("collection", "Secret Collection"), ("tag", "secret-tag") }, sources.Select(r => (r.GetProperty("Match").GetString()!, r.GetProperty("Value").GetString()!)));
        Assert.Equal(CustomTagMatcher.For(config).Ids, sources.Select(r => r.GetProperty("Id").GetString()));

        // The key stays the server's: a later save (posting another key or none) keeps it.
        var key = config.CustomTagRuleKey;
        fixture.Plugin.UpdateConfiguration(new PluginConfiguration { CustomTagRules = [Rule("tag", "secret-tag", "Signed")], CustomTagRuleKey = "posted" });
        Assert.Equal(key, fixture.Plugin.Configuration.CustomTagRuleKey);
    }

    [Fact]
    public void RuleChangesReMatchTheCacheAndTheSnapshotRemembersItsRules()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        Directory.CreateDirectory(f.Core.ConfigRoot);
        var library = new Library();
        var signed = new Movie { Id = Guid.NewGuid(), Name = "Signed", Tags = ["Signed"] };
        library.Items.Add(signed);
        TagCacheService Create() => new(library.Mock.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
        var refreshAll = typeof(TagCacheService).GetMethod("RefreshAllCustomTags", BindingFlags.Instance | BindingFlags.NonPublic)!;

        using (var cache = Create())
        {
            cache.BuildFullCache(null, CancellationToken.None);
            Assert.Null(TagsOf(cache, signed));
            var version = cache.Version;
            long Stamp() => cache.TryGetEntry(signed.Id, out var entry) ? entry.LastUpdated : 0;
            var before = Stamp();

            // An added rule re-matches every entry; the change reaches clients as a delta (the version stays).
            f.Plugin.Configuration.CustomTagRules = CustomTagRuleSet.Normalize(new[] { Rule("tag", "signed", "Signed copy") });
            refreshAll.Invoke(cache, null);
            Assert.Equal(new[] { Id("tag", "signed") }, TagsOf(cache, signed));
            Assert.True(Stamp() > before);
            Assert.Equal(version, cache.Version);
            // A label or icon edit matches the same items: nothing to re-match.
            var afterAdd = Stamp();
            f.Plugin.Configuration.CustomTagRules = CustomTagRuleSet.Normalize(new[] { Rule("tag", "Signed", "Autographed", "star") });
            refreshAll.Invoke(cache, null);
            Assert.Equal(afterAdd, Stamp());
            cache.SaveToDisk();
        }

        var path = Path.Combine(f.Core.ConfigRoot, "tag-cache.json");
        using (var doc = JsonDocument.Parse(File.ReadAllText(path)))
        {
            Assert.Equal(Id("tag", "signed"), doc.RootElement.GetProperty("CustomTagsFingerprint").GetString());
        }

        // A collection a rule names, removed right after a snapshot load, still clears its members'
        // matches: with nothing else in between, after an on-demand entry read the (already changed)
        // membership, and with an unrelated rebuild in the same batch. A read before the collection
        // pass must not make the snapshot's matches count as reconciled.
        f.Plugin.Configuration.CustomTagRules = CustomTagRuleSet.Normalize(new[] { Rule("tag", "signed", "Signed copy"), Rule("collection", "Box", "Box") });
        var boxed = new Movie { Id = Guid.NewGuid(), Name = "Boxed" };
        var other = new Movie { Id = Guid.NewGuid(), Name = "Other" };
        var box = new BoxSet { Id = Guid.NewGuid(), Name = "Box", LinkedChildren = [new LinkedChild { ItemId = boxed.Id }] };
        var unreconciled = typeof(TagCacheService).GetField("_collectionMatchesUnreconciled", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var previous = BaseItem.LibraryManager;
        BaseItem.LibraryManager = library.Mock.Object;
        try
        {
            foreach (var variant in new[] { "alone", "on-demand read", "same batch" })
            {
                library.Items.AddRange(new BaseItem[] { boxed, other, box });
                using (var built = Create())
                {
                    built.BuildFullCache(null, CancellationToken.None);
                    Assert.Equal(new[] { Id("collection", "box") }, TagsOf(built, boxed));
                }

                using var loaded = Create();
                loaded.LoadFromDisk();
                Assert.True((bool)unreconciled.GetValue(loaded)!);
                library.Items.Remove(box);
                if (variant == "on-demand read") Assert.Null(loaded.BuildEntryOnDemand(other)!.CustomTags);
                if (variant == "same batch") loaded.EnqueueUpdate(other.Id);
                loaded.EnqueueRemoval(box.Id);
                Flush(loaded);
                Assert.True(TagsOf(loaded, boxed) == null, variant);
                Assert.False((bool)unreconciled.GetValue(loaded)!, variant);
                library.Items.Remove(boxed);
                library.Items.Remove(other);
            }
        }
        finally
        {
            BaseItem.LibraryManager = previous;
            library.Items.Remove(boxed);
            library.Items.Remove(other);
            library.Items.Remove(box);
        }

        // Loaded under other rules, the snapshot is re-matched in the background.
        f.Plugin.Configuration.CustomTagRules = new List<CustomTagRule>();
        using var reloaded = Create();
        reloaded.LoadFromDisk();
        Assert.True(reloaded.TryGetEntry(signed.Id, out _));
        Assert.True(SpinWait.SpinUntil(() => TagsOf(reloaded, signed) == null, TimeSpan.FromSeconds(10)));
    }

    private static PluginConfiguration NativeConfig() => new()
    {
        CustomTagRules = CustomTagRuleSet.Normalize(new[]
        {
            Rule("collection", "Criterion", "Criterion"),
            Rule("tag", "4K Remaster", "Remaster", "auto_awesome"),
            Rule("tag", "Signed", "Signed"),
        }),
    };

    private static PosterTagItemContext Movie() => new("Movie", false, null, null, null);

    [Fact]
    public void NativePostersDrawTheMatchedRulesInRuleOrderWithTheirIconsAndCap()
    {
        var config = NativeConfig();
        var settings = PosterTagSettings.FromSettingsJson("{customTagsEnabled:true,tagLayoutSettingsVersion:1,tagGroupCaps:{custom:2}}", config);
        var entry = new TagCacheEntry { Type = "Movie", CustomTags = [Id("tag", "signed"), Id("collection", "criterion"), "tag:gone", Id("tag", "4k remaster")] };
        var layout = PosterTagResolver.Resolve(entry, settings, Movie(), false)!;

        var group = Assert.Single(layout.Groups);
        Assert.Equal(PosterTagGroup.Custom, group.Group);
        Assert.Equal(PosterTagCorner.TopLeft, group.Corner);
        // The configured rule order, whatever order the entry stored; an id with no rule any more is
        // skipped; the cap keeps two.
        Assert.Equal(new[] { ("Criterion", (string?)null), ("Remaster", "auto_awesome") }, group.Tags.Cast<CustomTag>().Select(t => (t.Label, t.Icon)));

        // Reordering the rules changes the first chip at once: the cached ids are a set, no re-match.
        var reversed = new PluginConfiguration { CustomTagRules = Enumerable.Reverse(config.CustomTagRules).ToList() };
        var capOne = PosterTagSettings.FromSettingsJson("{customTagsEnabled:true,tagLayoutSettingsVersion:1,tagGroupCaps:{custom:1}}", reversed);
        Assert.Equal("Signed", Assert.IsType<CustomTag>(Assert.Single(Assert.Single(PosterTagResolver.Resolve(entry, capOne, Movie(), false)!.Groups).Tags)).Label);

        var icon = PosterTagResolver.Resolve(new TagCacheEntry { Type = "Movie", CustomTags = [Id("tag", "4k remaster")] }, settings, Movie(), false)!;
        Assert.Equal("auto_awesome", Assert.IsType<CustomTag>(Assert.Single(Assert.Single(icon.Groups).Tags)).Icon);
        Assert.Null(PosterTagResolver.Resolve(new TagCacheEntry { Type = "Movie" }, settings, Movie(), false));
    }

    [Fact]
    public void NativeCustomTagsFollowTheCornersProfileAndStayOutOfTheDigestWhileOff()
    {
        var config = NativeConfig();
        var off = PosterTagSettings.FromSettingsJson("{qualityTagsEnabled:true}", config);
        var noRules = PosterTagSettings.FromSettingsJson("{qualityTagsEnabled:true}", new PluginConfiguration());
        Assert.False(off.Shows(PosterTagGroup.Custom));
        // Rules alone never change the cache key of posters that do not show the group.
        Assert.Equal(noRules.Digest, off.Digest);

        var on = PosterTagSettings.FromSettingsJson("{qualityTagsEnabled:true,customTagsEnabled:true,customTagsPosition:'bottom-right'}", config);
        Assert.NotEqual(off.Digest, on.Digest);
        Assert.Equal("bottom-right", on.PositionOf(PosterTagGroup.Custom));
        Assert.Equal(3, on.CapOf(PosterTagGroup.Custom));
        var relabelled = new PluginConfiguration { CustomTagRules = CustomTagRuleSet.Normalize(new[] { Rule("collection", "Criterion", "Criterion Collection") }) };
        Assert.NotEqual(on.Digest, PosterTagSettings.FromSettingsJson("{qualityTagsEnabled:true,customTagsEnabled:true,customTagsPosition:'bottom-right'}", relabelled).Digest);

        var hidden = PosterTagSettings.FromSettingsJson("{customTagsEnabled:true,tagLayoutSettingsVersion:1,tagLayouts:{corners:{groups:[{group:'custom',slot:'off'}]}}}", config);
        Assert.False(hidden.Shows(PosterTagGroup.Custom));
        Assert.False(hidden.AnyGroupEnabled);
        var moved = PosterTagSettings.FromSettingsJson("{customTagsEnabled:true,tagLayoutSettingsVersion:1,tagLayouts:{corners:{groups:[{group:'custom',slot:'tr'}]}}}", config);
        Assert.Equal("top-right", moved.PositionOf(PosterTagGroup.Custom));
        Assert.True(moved.HasTopRightGroup);
    }

    [Fact]
    public void NativeCustomChipsArePaintedWithAndWithoutAnIcon()
    {
        using var renderer = new PosterTagRenderer();
        foreach (var icon in new[] { null, "auto_awesome" })
        {
            using var source = new SKBitmap(180, 270);
            source.Erase(SKColors.Navy);
            var layout = new PosterTagLayout([new(PosterTagGroup.Custom, PosterTagCorner.TopLeft, [new CustomTag("Remaster", icon, Id("tag", "4k remaster"))])], false, false);
            using var output = renderer.Render(source, layout);
            Assert.NotNull(output);
            Assert.Contains(Enumerable.Range(4, 30).SelectMany(y => Enumerable.Range(4, 90).Select(x => output.GetPixel(x, y))), p => p != SKColors.Navy);
            Assert.All(Enumerable.Range(120, 50).SelectMany(x => Enumerable.Range(200, 60).Select(y => output.GetPixel(x, y))), p => Assert.Equal(SKColors.Navy, p));
        }
    }

    [Fact]
    public void TagStylesAcceptCustomLabelsAndServeThemToTheWeb()
    {
        var doc = "{\"v\":2,\"preset\":\"default\",\"groups\":{\"custom\":{\"background\":\"#112233\"}},\"labels\":{\"custom:Remaster\":{\"text\":\"#ffd166\"}}}";
        Assert.True(TagStyleSet.TryValidate(doc, "default", out var set, out var error), error);
        Assert.Equal("rgba(255, 209, 102, 1)", set.Resolve(TagStyleKeys.Custom, "Remaster").Text);
        Assert.Equal("rgba(17, 34, 51, 1)", set.Resolve(TagStyleKeys.Custom, "Other").Background);
        Assert.False(TagStyleSet.TryValidate("{\"v\":2,\"labels\":{\"custom:*\":{\"text\":\"#fff\"}}}", "default", out _, out _));
        Assert.False(TagStyleSet.TryValidate("{\"v\":2,\"labels\":{\"custom:twenty-five characters!!!\":{\"text\":\"#fff\"}}}", "default", out _, out _));

        using var web = JsonDocument.Parse(JsonSerializer.Serialize(set.ToWebModel()));
        var custom = web.RootElement.GetProperty("custom");
        Assert.Equal("rgba(17, 34, 51, 1)", custom.GetProperty("*").GetProperty("background").GetString());
        Assert.Equal("rgba(255, 209, 102, 1)", custom.GetProperty("Remaster").GetProperty("color").GetString());
        // Presets reach custom chips too.
        Assert.NotNull(TagStyleSet.Parse(null, "glass").Resolve(TagStyleKeys.Custom, "Anything").Background);
    }
}
