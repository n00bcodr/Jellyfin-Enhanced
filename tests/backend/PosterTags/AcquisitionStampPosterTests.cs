using System.Security.Cryptography;
using System.Text;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;

namespace JE.Tests;

/// <summary>
/// Phase 4e on the poster side: the switches, the per-person native preference, the stamp's corner, the settings digest
/// and data hash (byte-identical to before phase 4e whenever no stamp is drawn), and the stamp group the resolver adds.
/// </summary>
public class AcquisitionStampPosterTests
{
    private static PosterTagSettings Settings(string json, PluginConfiguration config) => PosterTagSettings.FromSettingsJson(json, config);

    private static PluginConfiguration NativeOnly() => new() { NativePosterTagsEnabled = true };

    private static PluginConfiguration BadgesWithoutNativeStamps()
    {
        var config = StampWorld.On(native: false);
        config.NativePosterTagsEnabled = true;
        return config;
    }

    private static PosterTagItemContext Context(AcquisitionStamp stamp, bool played = false, string type = "Movie") => new(type, played, null, null, null, stamp);

    private static readonly AcquisitionStamp[] Stamps = { AcquisitionStamp.NewForYou, AcquisitionStamp.FourK, AcquisitionStamp.Upgraded };

    // ── 1. flags ─────────────────────────────────────────────────────────

    [Fact]
    public void BadgesNeedEveryParentSwitchAndNativeStampsAlsoNeedTheirSwitchAndNativeTags()
    {
        for (var mask = 0; mask < 64; mask++)
        {
            bool Bit(int n) => (mask & (1 << n)) != 0;
            var config = new PluginConfiguration
            {
                ArrIntegrationEnabled = Bit(0), ArrPhase1Enabled = Bit(1), ArrPhase4Enabled = Bit(2), ArrPhase4AcquisitionBadgesEnabled = Bit(3),
                ArrPhase4NativeStampsEnabled = Bit(4), NativePosterTagsEnabled = Bit(5),
            };
            var badges = Bit(0) && Bit(1) && Bit(2) && Bit(3);
            Assert.Equal(badges, AcquisitionStampFlags.Badges(config));
            Assert.Equal(badges && Bit(4) && Bit(5), AcquisitionStampFlags.NativeStamps(config));
        }

        Assert.False(AcquisitionStampFlags.Badges(null));
        Assert.False(AcquisitionStampFlags.NativeStamps(null));
        Assert.False(AcquisitionStampFlags.Badges(new PluginConfiguration()));                  // off by default
        var defaults = new PluginConfiguration();
        Assert.False(defaults.ArrPhase4AcquisitionBadgesEnabled);
        Assert.False(defaults.ArrPhase4NativeStampsEnabled);
    }

    [Theory]
    [InlineData(true, null, true)]
    [InlineData(true, true, true)]
    [InlineData(true, false, false)]
    [InlineData(false, null, false)]
    [InlineData(false, true, false)]
    [InlineData(false, false, false)]
    public void APersonsPreferenceFollowsTheAdministratorUnlessItIsFalse(bool admin, bool? preference, bool shown)
        => Assert.Equal(shown, AcquisitionStampFlags.Display(admin, preference));

    [Theory]
    [InlineData(-5, 1)]
    [InlineData(0, 1)]
    [InlineData(1, 1)]
    [InlineData(7, 7)]
    [InlineData(30, 30)]
    [InlineData(31, 30)]
    [InlineData(int.MaxValue, 30)]
    public void LifetimesAreClampedToOneToThirtyDays(int days, int expected)
    {
        var config = new PluginConfiguration { ArrAcquisitionNewDays = days, ArrAcquisitionUpgradedDays = days };
        Assert.Equal(TimeSpan.FromDays(expected), AcquisitionStampFlags.NewLifetime(config));
        Assert.Equal(TimeSpan.FromDays(expected), AcquisitionStampFlags.UpgradedLifetime(config));
    }

    [Fact]
    public void LifetimesDefaultToSevenDaysAndTheWireNamesAreFixed()
    {
        Assert.Equal(TimeSpan.FromDays(7), AcquisitionStampFlags.NewLifetime(new PluginConfiguration()));
        Assert.Equal(TimeSpan.FromDays(7), AcquisitionStampFlags.UpgradedLifetime(new PluginConfiguration()));
        Assert.Equal(TimeSpan.FromDays(7), AcquisitionStampFlags.NewLifetime(null));
        Assert.Equal(TimeSpan.FromDays(7), AcquisitionStampFlags.UpgradedLifetime(null));
        Assert.Equal("upgraded", AcquisitionStampFlags.WireName(AcquisitionStamp.Upgraded));
        Assert.Equal("new", AcquisitionStampFlags.WireName(AcquisitionStamp.NewForYou));
        Assert.Equal("fourK", AcquisitionStampFlags.WireName(AcquisitionStamp.FourK));
        Assert.Null(AcquisitionStampFlags.WireName(AcquisitionStamp.None));
    }

    [Theory]
    [InlineData(3840, 2160, true)]
    [InlineData(3200, 1340, true)]
    [InlineData(2880, 2000, true)]
    [InlineData(3199, 1999, false)]
    [InlineData(1920, 1080, false)]
    [InlineData(0, 0, false)]
    public void AFourKCopyIsAtLeast3200WideOr2000High(int width, int height, bool fourK)
    {
        Assert.Equal(fourK, AcquisitionCopyPolicy.IsFourK(width, height));
        Assert.Equal(fourK, new StampItem { Width = width, Height = height }.FourK);
    }

    // ── 2. settings ──────────────────────────────────────────────────────

    // Captured from the pre-phase-4e build (62764b25) with PosterTagSettings.FromSettingsJson(json, { NativePosterTagsEnabled = native }).
    public static TheoryData<string, bool, string> PreFourEDigests => new()
    {
        { "{}", false, "c7be7ab64e09daac" },
        { "{}", true, "c7be7ab64e09daac" },
        { "{qualityTagsEnabled:true,genreTagsEnabled:true,languageTagsEnabled:true}", true, "6e601510cd9c3dd7" },
        { "{ratingTagsEnabled:true,ratingTagsPosition:'top-left',ageRatingTagsEnabled:true}", true, "079e8f8776116293" },
    };

    [Theory]
    [MemberData(nameof(PreFourEDigests))]
    public void WithoutAStampDrawnTheDigestIsByteIdenticalToTheOnePhase4eStartedFrom(string json, bool native, string golden)
    {
        PluginConfiguration Config(Action<PluginConfiguration> set)
        {
            var c = new PluginConfiguration { NativePosterTagsEnabled = native };
            set(c);
            return c;
        }

        var cases = new List<(string Name, PosterTagSettings Settings)>
        {
            ("no 4e", Settings(json, Config(_ => { }))),
            ("parents on, switches off", Settings(json, Config(c => { c.ArrIntegrationEnabled = c.ArrPhase1Enabled = c.ArrPhase4Enabled = true; }))),
            ("badges on, native stamps off", Settings(json, Config(c => { c.ArrIntegrationEnabled = c.ArrPhase1Enabled = c.ArrPhase4Enabled = c.ArrPhase4AcquisitionBadgesEnabled = true; }))),
            ("native stamps without badges", Settings(json, Config(c => { c.ArrIntegrationEnabled = c.ArrPhase1Enabled = c.ArrPhase4Enabled = c.ArrPhase4NativeStampsEnabled = true; }))),
            ("phase 4 off", Settings(json, Config(c => { c.ArrIntegrationEnabled = c.ArrPhase1Enabled = c.ArrPhase4AcquisitionBadgesEnabled = c.ArrPhase4NativeStampsEnabled = true; }))),
            ("all on, person opted out", Settings(json.Insert(1, json.Length > 2 ? "nativeAcquisitionStamps:false," : "nativeAcquisitionStamps:false"),
                Config(c => { c.ArrIntegrationEnabled = c.ArrPhase1Enabled = c.ArrPhase4Enabled = c.ArrPhase4AcquisitionBadgesEnabled = c.ArrPhase4NativeStampsEnabled = true; }))),
            ("all on, native tags off for the person", Settings(json.Insert(1, json.Length > 2 ? "useNativePosterTags:false," : "useNativePosterTags:false"),
                Config(c => { c.ArrIntegrationEnabled = c.ArrPhase1Enabled = c.ArrPhase4Enabled = c.ArrPhase4AcquisitionBadgesEnabled = c.ArrPhase4NativeStampsEnabled = true; }))),
        };
        foreach (var (name, settings) in cases)
        {
            Assert.False(settings.AcquisitionStampsEnabled, name);
            Assert.True(golden == settings.Digest, $"{name}: {settings.Digest} != {golden}");
        }
    }

    [Fact]
    public void TheNativePreferenceIsIndependentOfTheWebPreference()
    {
        var on = StampWorld.On(native: true);
        Assert.True(Settings("{}", on).AcquisitionStampsEnabled);                                                    // null follows the admin
        Assert.True(Settings("{nativeAcquisitionStamps:null}", on).AcquisitionStampsEnabled);
        Assert.True(Settings("{nativeAcquisitionStamps:true}", on).AcquisitionStampsEnabled);
        Assert.False(Settings("{nativeAcquisitionStamps:false}", on).AcquisitionStampsEnabled);
        Assert.True(Settings("{acquisitionBadges:false}", on).AcquisitionStampsEnabled);                             // the web's switch isn't native's
        Assert.True(Settings("{acquisitionBadges:false,nativeAcquisitionStamps:true}", on).AcquisitionStampsEnabled);
        Assert.False(Settings("{acquisitionBadges:true,nativeAcquisitionStamps:false}", on).AcquisitionStampsEnabled);
        Assert.False(Settings("{useNativePosterTags:false,nativeAcquisitionStamps:true}", on).AcquisitionStampsEnabled);   // native tags off wins
        Assert.True(PosterTagSettings.FromSettingsJson(null, on).AcquisitionStampsEnabled);                          // no settings.json yet
        Assert.False(Settings("{}", StampWorld.On(native: false)).AcquisitionStampsEnabled);
    }

    [Theory]
    [InlineData("{}", "bottom-left")]
    [InlineData("{languageTagsEnabled:true,languageTagsPosition:'bottom-left'}", "bottom-right")]
    [InlineData("{languageTagsEnabled:true,languageTagsPosition:'bottom-left',ratingTagsEnabled:true,ratingTagsPosition:'bottom-right'}", "top-left")]
    [InlineData("{qualityTagsEnabled:true,qualityTagsPosition:'top-left',languageTagsEnabled:true,languageTagsPosition:'bottom-left',ratingTagsEnabled:true,ratingTagsPosition:'bottom-right'}", "top-right")]
    [InlineData("{qualityTagsEnabled:true,qualityTagsPosition:'top-left',genreTagsEnabled:true,genreTagsPosition:'top-right',languageTagsEnabled:true,languageTagsPosition:'bottom-left',ageRatingTagsEnabled:true,ageRatingTagsPosition:'bottom-right'}", "bottom-left")]
    [InlineData("{qualityTagsEnabled:false,qualityTagsPosition:'bottom-left',genreTagsEnabled:true,genreTagsPosition:'bottom-left'}", "bottom-right")]
    [InlineData("{qualityTagsEnabled:false,qualityTagsPosition:'bottom-left'}", "bottom-left")]   // a disabled group's corner is free
    public void TheStampTakesTheFirstCornerNoEnabledGroupUses(string json, string corner)
    {
        var settings = Settings(json, StampWorld.On(native: true));
        Assert.Equal(corner, settings.AcquisitionStampPosition);
        Assert.Equal(corner, settings.PositionOf(PosterTagGroup.Acquisition));
    }

    [Fact]
    public void TheDigestMovesWhenStampsTurnOnAndWithTheirCorner()
    {
        var on = StampWorld.On(native: true);
        var off = NativeOnly();
        var plain = Settings("{qualityTagsEnabled:true}", off);
        var stamped = Settings("{qualityTagsEnabled:true}", on);
        Assert.NotEqual(plain.Digest, stamped.Digest);
        Assert.Matches("^[0-9a-f]{16}$", stamped.Digest);
        Assert.Equal(stamped.Digest, Settings("{qualityTagsEnabled:true}", on).Digest);                // stable
        Assert.Equal(stamped.Digest, Settings("{qualityTagsEnabled:true,acquisitionBadges:false}", on).Digest);   // the web preference isn't drawn

        // The same group moved to the stamp's corner moves the stamp: a different digest from both the old placement and
        // the same placement without stamps.
        var moved = Settings("{qualityTagsEnabled:true,qualityTagsPosition:'bottom-left'}", on);
        Assert.Equal("bottom-right", moved.AcquisitionStampPosition);
        Assert.NotEqual(stamped.Digest, moved.Digest);
        Assert.NotEqual(Settings("{qualityTagsEnabled:true,qualityTagsPosition:'bottom-left'}", off).Digest, moved.Digest);
    }

    [Fact]
    public void StampsAloneAreContentToDraw()
    {
        Assert.False(Settings("{}", NativeOnly()).AnyContentEnabled);
        Assert.False(Settings("{}", StampWorld.On(native: true)).AnyGroupEnabled);
        Assert.True(Settings("{}", StampWorld.On(native: true)).AnyContentEnabled);
        Assert.False(Settings("{nativeAcquisitionStamps:false}", StampWorld.On(native: true)).AnyContentEnabled);
        Assert.True(Settings("{genreTagsEnabled:true}", NativeOnly()).AnyContentEnabled);
    }

    // ── 3. resolver ──────────────────────────────────────────────────────

    private static readonly TagCacheEntry Rich = new()
    {
        Type = "Movie", Genres = ["Drama", "Science Fiction"], CommunityRating = 8.2f, OfficialRating = "PG-13", AudioLanguages = ["eng", "jpn"],
        StreamData = new() { Streams = [new() { Type = "Video", Height = 2160, Codec = "hevc" }] },
    };

    private static string Describe(PosterTagLayout? layout)
        => layout == null ? "null" : string.Join(" ; ", layout.Groups.Select(g => g.Group + "@" + g.Corner + "[" + string.Join(",", g.Tags) + "]"))
            + " offset=" + layout.TopRightOffset + " landscape=" + layout.Landscape;

    [Fact]
    public void WithNoGroupsAStampIsDrawnAloneAndNoStampDrawsNothing()
    {
        var settings = Settings("{}", StampWorld.On(native: true));
        Assert.Null(PosterTagResolver.Resolve(Rich, settings, Context(AcquisitionStamp.None), false));
        foreach (var stamp in Stamps)
        {
            var layout = PosterTagResolver.Resolve(Rich, settings, Context(stamp), false)!;
            var group = Assert.Single(layout.Groups);
            Assert.Equal((PosterTagGroup.Acquisition, PosterTagCorner.BottomLeft), (group.Group, group.Corner));
            Assert.Equal(new PosterTag[] { new AcquisitionStampTag(stamp) }, group.Tags);
            Assert.False(layout.IsEmpty);
        }
    }

    [Fact]
    public void TheStampGroupComesLastInItsCorner()
    {
        var settings = Settings("{qualityTagsEnabled:true,qualityTagsPosition:'top-left',languageTagsEnabled:true,languageTagsPosition:'bottom-left',genreTagsEnabled:true,genreTagsPosition:'top-right'}", StampWorld.On(native: true));
        var layout = PosterTagResolver.Resolve(Rich, settings, Context(AcquisitionStamp.Upgraded), false)!;
        Assert.True(layout.Groups.Count >= 4);
        var last = layout.Groups[^1];
        Assert.Equal((PosterTagGroup.Acquisition, PosterTagCorner.BottomRight), (last.Group, last.Corner));
        Assert.Single(layout.Groups, g => g.Group == PosterTagGroup.Acquisition);

        // With every corner taken it stacks after the bottom-left groups.
        var full = Settings("{qualityTagsEnabled:true,qualityTagsPosition:'top-left',genreTagsEnabled:true,genreTagsPosition:'top-right',languageTagsEnabled:true,languageTagsPosition:'bottom-left',ratingTagsEnabled:true,ratingTagsPosition:'bottom-right'}", StampWorld.On(native: true));
        var stacked = PosterTagResolver.Resolve(Rich, full, Context(AcquisitionStamp.FourK), false)!;
        Assert.Equal((PosterTagGroup.Acquisition, PosterTagCorner.BottomLeft), (stacked.Groups[^1].Group, stacked.Groups[^1].Corner));
        Assert.Contains(stacked.Groups.Take(stacked.Groups.Count - 1), g => g.Corner == PosterTagCorner.BottomLeft);
    }

    [Fact]
    public void WithStampsOffTheContextsStampIsIgnored()
    {
        foreach (var settings in new[]
        {
            Settings("{}", NativeOnly()),
            Settings("{}", StampWorld.On(native: false)),
            Settings("{nativeAcquisitionStamps:false}", StampWorld.On(native: true)),
        })
        {
            foreach (var stamp in Stamps) Assert.Null(PosterTagResolver.Resolve(Rich, settings, Context(stamp), false));
        }

        var groups = Settings("{genreTagsEnabled:true}", StampWorld.On(native: false));
        Assert.All(Stamps, stamp => Assert.DoesNotContain(PosterTagResolver.Resolve(Rich, groups, Context(stamp), false)!.Groups, g => g.Group == PosterTagGroup.Acquisition));
    }

    [Fact]
    public void ATopRightStampGetsTheSamePlayedIndicatorOffsetAsOtherTopRightGroups()
    {
        // Quality, language and rating hold the other corners, but this entry has nothing for them: only the stamp draws.
        var settings = Settings("{qualityTagsEnabled:true,qualityTagsPosition:'top-left',languageTagsEnabled:true,languageTagsPosition:'bottom-left',ratingTagsEnabled:true,ratingTagsPosition:'bottom-right'}", StampWorld.On(native: true));
        Assert.Equal("top-right", settings.AcquisitionStampPosition);
        var empty = new TagCacheEntry { Type = "Movie" };

        var played = PosterTagResolver.Resolve(empty, settings, Context(AcquisitionStamp.NewForYou, played: true), false)!;
        Assert.Equal((PosterTagGroup.Acquisition, PosterTagCorner.TopRight), (Assert.Single(played.Groups).Group, played.Groups[0].Corner));
        Assert.True(played.TopRightOffset);
        Assert.False(PosterTagResolver.Resolve(empty, settings, Context(AcquisitionStamp.NewForYou, played: false), false)!.TopRightOffset);

        // Elsewhere, no offset.
        var bottomLeft = Settings("{}", StampWorld.On(native: true));
        Assert.False(PosterTagResolver.Resolve(empty, bottomLeft, Context(AcquisitionStamp.NewForYou, played: true), false)!.TopRightOffset);
    }

    // ── 16. existing tags unchanged ──────────────────────────────────────

    [Theory]
    [InlineData("{qualityTagsEnabled:true,genreTagsEnabled:true}")]
    [InlineData("{qualityTagsEnabled:true,genreTagsEnabled:true,languageTagsEnabled:true,ratingTagsEnabled:true,ageRatingTagsEnabled:true}")]
    [InlineData("{qualityTagsEnabled:true,showResolutionTag:false,genreTagsEnabled:true,genreTagsPosition:'bottom-left'}")]
    public void TheOtherTagGroupsAreTheSameWithOrWithoutAStamp(string json)
    {
        foreach (var played in new[] { false, true })
        {
            var before = Describe(PosterTagResolver.Resolve(Rich, Settings(json, NativeOnly()), Context(AcquisitionStamp.None, played), false));
            Assert.NotEqual("null", before);
            Assert.Contains("Quality@", before, StringComparison.Ordinal);
            Assert.Contains("Genre@", before, StringComparison.Ordinal);

            // Stamps off (admin or person), whatever the context carries: identical output.
            foreach (var stamp in Stamps.Append(AcquisitionStamp.None))
            {
                Assert.Equal(before, Describe(PosterTagResolver.Resolve(Rich, Settings(json, BadgesWithoutNativeStamps()), Context(stamp, played), false)));
                Assert.Equal(before, Describe(PosterTagResolver.Resolve(Rich, Settings(json.Insert(1, "nativeAcquisitionStamps:false,"), StampWorld.On(native: true)), Context(stamp, played), false)));
            }

            // Stamps on and no stamp: identical; with a stamp: the same groups, the stamp group appended last.
            var on = Settings(json, StampWorld.On(native: true));
            Assert.Equal(before, Describe(PosterTagResolver.Resolve(Rich, on, Context(AcquisitionStamp.None, played), false)));
            var withStamp = PosterTagResolver.Resolve(Rich, on, Context(AcquisitionStamp.Upgraded, played), false)!;
            var original = PosterTagResolver.Resolve(Rich, Settings(json, NativeOnly()), Context(AcquisitionStamp.None, played), false)!;
            Assert.Equal(original.Groups.Count + 1, withStamp.Groups.Count);
            Assert.Equal(Describe(original with { Groups = original.Groups, TopRightOffset = withStamp.TopRightOffset }),
                Describe(withStamp with { Groups = withStamp.Groups.Take(original.Groups.Count).ToList() }));
            Assert.Equal(PosterTagGroup.Acquisition, withStamp.Groups[^1].Group);
        }
    }

    // ── 4. data hash ─────────────────────────────────────────────────────

    /// <summary>The data hash as it was before phase 4e (the old DataKey), computed here independently.</summary>
    internal static string PreFourEHash(TagCacheEntry entry, PosterTagReviewSummary reviews)
    {
        var input = PosterTagDataProvider.ContentHash(entry) + "|r:"
            + (reviews.Count is int count ? count.ToString(System.Globalization.CultureInfo.InvariantCulture) : "-") + ":"
            + (reviews.Average is double average ? average.ToString("R", System.Globalization.CultureInfo.InvariantCulture) : "-");
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(input))).ToLowerInvariant()[..6];
        return hash == "000000" ? "000001" : hash;
    }

    public static TheoryData<int, double?, int?> Reviews => new()
    {
        { 0, null, null },
        { 1, null, 0 },
        { 2, 4.25, 3 },
        { 3, 1.0 / 3, 1 },
    };

    [Theory]
    [MemberData(nameof(Reviews))]
    public void WithoutAStampThePinnedHashIsExactlyThePreFourEHashAndEachStampHasItsOwn(int variant, double? average, int? count)
    {
        var entry = Rich.Clone();
        entry.TmdbId = "60" + variant;
        var reviews = new PosterTagReviewSummary(average, count);
        var plain = PosterTagDataProvider.PinnedHash(entry, reviews, AcquisitionStamp.None);
        Assert.Equal(PreFourEHash(entry, reviews), plain);
        Assert.Matches("^[0-9a-f]{6}$", plain);

        var all = new[] { plain }.Concat(Stamps.Select(s => PosterTagDataProvider.PinnedHash(entry, reviews, s))).ToList();
        Assert.Equal(4, all.Distinct(StringComparer.Ordinal).Count());
        Assert.All(all, h => Assert.NotEqual(PosterTagVariantToken.WeakDataHash, h));
        Assert.All(Stamps, s => Assert.Equal(PosterTagDataProvider.PinnedHash(entry, reviews, s), PosterTagDataProvider.PinnedHash(entry.Clone(), reviews, s)));   // stable
    }

    [Fact]
    public void TheStampIsAFixedFourValueEnumAndTheOnlyPhase4eInputOfTheHash()
    {
        Assert.Equal(
            new[] { (0, "None"), (1, "NewForYou"), (2, "FourK"), (3, "Upgraded") },
            Enum.GetValues<AcquisitionStamp>().Select(v => ((int)v, v.ToString())));
        Assert.Equal(4, Enum.GetValues(typeof(AcquisitionStamp)).Length);

        var method = typeof(PosterTagDataProvider).GetMethod("PinnedHash", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Public)!;
        Assert.Equal(new[] { typeof(TagCacheEntry), typeof(PosterTagReviewSummary), typeof(AcquisitionStamp) }, method.GetParameters().Select(p => p.ParameterType));
        // The snapshot pins exactly one stamp value next to the hash (no progress, no time).
        Assert.Equal(typeof(AcquisitionStamp), typeof(PosterTagDataSnapshot).GetProperty("Stamp")!.PropertyType);
        Assert.Equal(typeof(AcquisitionStamp), typeof(AcquisitionStampTag).GetProperty("Stamp")!.PropertyType);
    }
}
