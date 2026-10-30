using System.Reflection;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Globalization;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering;
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
        Assert.Equal("tag:4k remaster", CustomTagRuleSet.RuleId(rules[0]));
        Assert.Equal("collection:criterion collection", CustomTagRuleSet.RuleId(rules[1]));
        Assert.Empty(CustomTagRuleSet.Normalize(null));
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
        Assert.Equal(new[] { "collection:criterion", "tag:4k remaster" }, matcher.Match(new[] { "4k  remaster", "other" }, new[] { "criterion" }));
        Assert.Null(matcher.Match(new[] { "other" }, null));
        Assert.Null(new CustomTagMatcher(null).Match(new[] { "4K Remaster" }, null));
        Assert.Equal("Remaster", matcher.Find("tag:4k remaster")?.Label);
        Assert.Null(matcher.Find("tag:unknown"));
    }

    [Fact]
    public void MatchFingerprintIgnoresLabelsIconsAndOrder()
    {
        var a = CustomTagRuleSet.MatchFingerprint(new[] { Rule("tag", "A", "One"), Rule("collection", "B", "Two") });
        var b = CustomTagRuleSet.MatchFingerprint(new[] { Rule("collection", "b", "Changed", "star"), Rule("tag", "a", "Other") });
        Assert.Equal(a, b);
        Assert.NotEqual(a, CustomTagRuleSet.MatchFingerprint(new[] { Rule("tag", "A", "One") }));
        Assert.Equal(string.Empty, CustomTagRuleSet.MatchFingerprint(null));
    }

    [Theory]
    [InlineData("Remaster", true)]
    [InlineData("Criterion: Spine", true)]
    [InlineData(" padded", false)]
    [InlineData("", false)]
    [InlineData("tab\tinside", false)]
    [InlineData("twenty-five characters!!!", false)]
    public void LabelValidationMatchesTheRuleLabels(string label, bool valid) =>
        Assert.Equal(valid, CustomTagRuleSet.IsValidLabel(label));

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
        var a = new TagCacheEntry { Type = "Movie", CustomTags = ["tag:signed"] };
        var b = a.Clone();
        Assert.Equal(a.CustomTags, b.CustomTags);
        Assert.True(TagCacheEntry.ContentEquals(a, b));
        b.CustomTags = ["tag:signed", "collection:criterion"];
        Assert.False(TagCacheEntry.ContentEquals(a, b));
    }

    private sealed class Library
    {
        public readonly List<BaseItem> Items = new();
        public readonly Mock<ILibraryManager> Mock = new();

        public Library()
        {
            IEnumerable<BaseItem> Select(InternalItemsQuery q)
            {
                IEnumerable<BaseItem> selected = Items;
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

            Assert.Equal(new[] { "tag:4k remaster" }, TagsOf(cache, tagged));
            Assert.Equal(new[] { "collection:criterion" }, TagsOf(cache, member));
            Assert.Null(TagsOf(cache, plain));
            // Seasons and episodes take their series' tags.
            foreach (var item in new BaseItem[] { series, season, episode }) Assert.Equal(new[] { "tag:4k remaster" }, TagsOf(cache, item));
            Assert.Equal(cache.BuildEntryOnDemand(member)!.CustomTags, TagsOf(cache, member));

            // A collection change re-reads membership and patches old and new members.
            boxSet.LinkedChildren = [new LinkedChild { ItemId = plain.Id }];
            cache.EnqueueUpdate(boxSet.Id);
            Flush(cache);
            Assert.Null(TagsOf(cache, member));
            Assert.Equal(new[] { "collection:criterion" }, TagsOf(cache, plain));

            // A series whose own tags change patches its seasons and episodes.
            series.Tags = [];
            cache.EnqueueUpdate(series.Id);
            Flush(cache);
            foreach (var item in new BaseItem[] { series, season, episode }) Assert.Null(TagsOf(cache, item));

            // A series added to the collection: the series and its children match it.
            boxSet.LinkedChildren = [new LinkedChild { ItemId = plain.Id }, new LinkedChild { ItemId = series.Id }];
            cache.EnqueueUpdate(boxSet.Id);
            Flush(cache);
            foreach (var item in new BaseItem[] { series, season, episode }) Assert.Equal(new[] { "collection:criterion" }, TagsOf(cache, item));

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

            // An added rule re-matches every entry.
            f.Plugin.Configuration.CustomTagRules = CustomTagRuleSet.Normalize(new[] { Rule("tag", "signed", "Signed copy") });
            refreshAll.Invoke(cache, null);
            Assert.Equal(new[] { "tag:signed" }, TagsOf(cache, signed));
            Assert.True(cache.Version > version);
            // A label or icon edit matches the same items: nothing to re-match.
            var afterAdd = cache.Version;
            f.Plugin.Configuration.CustomTagRules = CustomTagRuleSet.Normalize(new[] { Rule("tag", "Signed", "Autographed", "star") });
            refreshAll.Invoke(cache, null);
            Assert.Equal(afterAdd, cache.Version);
            cache.SaveToDisk();
        }

        var path = Path.Combine(f.Core.ConfigRoot, "tag-cache.json");
        using (var doc = JsonDocument.Parse(File.ReadAllText(path)))
        {
            Assert.Equal("tag:signed", doc.RootElement.GetProperty("CustomTagsFingerprint").GetString());
        }

        // A collection a rule names, removed right after a snapshot load (before anything read the
        // collections), still clears its members' matches.
        f.Plugin.Configuration.CustomTagRules = CustomTagRuleSet.Normalize(new[] { Rule("tag", "signed", "Signed copy"), Rule("collection", "Box", "Box") });
        var boxed = new Movie { Id = Guid.NewGuid(), Name = "Boxed" };
        var box = new BoxSet { Id = Guid.NewGuid(), Name = "Box", LinkedChildren = [new LinkedChild { ItemId = boxed.Id }] };
        library.Items.AddRange(new BaseItem[] { boxed, box });
        var previous = BaseItem.LibraryManager;
        BaseItem.LibraryManager = library.Mock.Object;
        try
        {
            using (var built = Create())
            {
                built.BuildFullCache(null, CancellationToken.None);
                Assert.Equal(new[] { "collection:box" }, TagsOf(built, boxed));
            }

            using var loaded = Create();
            loaded.LoadFromDisk();
            library.Items.Remove(box);
            loaded.EnqueueRemoval(box.Id);
            Flush(loaded);
            Assert.Null(TagsOf(loaded, boxed));
        }
        finally
        {
            BaseItem.LibraryManager = previous;
            library.Items.Remove(boxed);
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
        var entry = new TagCacheEntry { Type = "Movie", CustomTags = ["tag:signed", "collection:criterion", "tag:gone", "tag:4k remaster"] };
        var layout = PosterTagResolver.Resolve(entry, settings, Movie(), false)!;

        var group = Assert.Single(layout.Groups);
        Assert.Equal(PosterTagGroup.Custom, group.Group);
        Assert.Equal(PosterTagCorner.TopLeft, group.Corner);
        // The server listed the ids in rule order; an id with no rule any more is skipped; the cap keeps two.
        Assert.Equal(new[] { ("Signed", (string?)null), ("Criterion", null) }, group.Tags.Cast<CustomTag>().Select(t => (t.Label, t.Icon)));

        var icon = PosterTagResolver.Resolve(new TagCacheEntry { Type = "Movie", CustomTags = ["tag:4k remaster"] }, settings, Movie(), false)!;
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
            var layout = new PosterTagLayout([new(PosterTagGroup.Custom, PosterTagCorner.TopLeft, [new CustomTag("Remaster", icon, "tag:4k remaster")])], false, false);
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
