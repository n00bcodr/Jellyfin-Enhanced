using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;

namespace JE.Tests;

/// <summary>
/// Native Poster Tags and the tag layout settings: native output stays corner-based for every web
/// layout, but honours the corners profile's "off" slots and corner picks, the explicit priority
/// order, the per-group caps and the rating include switches.
/// </summary>
public class PosterLayoutTests
{
    private const string AllOn = "qualityTagsEnabled:true,genreTagsEnabled:true,languageTagsEnabled:true,ratingTagsEnabled:true,ageRatingTagsEnabled:true";
    private const string AllBottomLeft = "qualityTagsPosition:'bottom-left',genreTagsPosition:'bottom-left',languageTagsPosition:'bottom-left',ratingTagsPosition:'bottom-left',ageRatingTagsPosition:'bottom-left'";

    private static PosterTagSettings Settings(string json, PluginConfiguration? config = null) => PosterTagSettings.FromSettingsJson(json, config ?? new PluginConfiguration());

    private static PosterTagItemContext Context(int? reviews = null, double? average = null) => new("Movie", false, null, average, reviews);

    /// <summary>An entry every group has something to draw for.</summary>
    private static TagCacheEntry Entry() => new()
    {
        Type = "Movie",
        TmdbId = "603",
        Genres = ["Action", "Science Fiction", "Thriller", "Drama", "Comedy"],
        CommunityRating = 8.1f,
        CriticRating = 88,
        OfficialRating = "PG-13",
        AudioLanguages = ["eng", "jpn", "fre", "ger", "spa"],
        StreamData = new()
        {
            Streams =
            [
                new() { Type = "Video", Height = 2160, Codec = "hevc", VideoRangeType = "DOVI" },
                new() { Type = "Audio", Codec = "truehd", Channels = 8, Profile = "Dolby TrueHD + Dolby Atmos" },
            ],
        },
    };

    private static PosterTagGroupLayout GroupOf(PosterTagLayout layout, PosterTagGroup group) => layout.Groups.Single(g => g.Group == group);

    [Fact]
    public void Corners_profile_off_hides_the_group_and_its_review_chip()
    {
        var settings = Settings("{" + AllOn + ",tagLayoutSettingsVersion:1,tagLayouts:{corners:{groups:[{group:'genre',slot:'off'},{group:'rating',slot:'off'}]}}}", new PluginConfiguration { ShowUserReviews = true, ShowUserRatingOnPosters = true });
        var layout = PosterTagResolver.Resolve(Entry(), settings, Context(2, 4.5), false)!;

        Assert.DoesNotContain(layout.Groups, g => g.Group is PosterTagGroup.Genre or PosterTagGroup.Rating);
        Assert.False(settings.UserReviewChipEnabled);
        Assert.True(settings.GenreTagsEnabled); // the switch itself is untouched
        Assert.False(settings.Shows(PosterTagGroup.Genre));
    }

    [Fact]
    public void Every_group_off_draws_nothing()
    {
        var groups = string.Join(",", new[] { "quality", "genre", "rating", "ageRating", "language" }.Select(g => "{group:'" + g + "',slot:'off'}"));
        var settings = Settings("{" + AllOn + ",tagLayoutSettingsVersion:1,tagLayouts:{corners:{groups:[" + groups + "]}}}");
        Assert.False(settings.AnyGroupEnabled);
        Assert.Null(PosterTagResolver.Resolve(Entry(), settings, Context(), false));
    }

    [Fact]
    public void Corners_profile_slot_wins_over_the_position_setting()
    {
        var settings = Settings("{" + AllOn + ",qualityTagsPosition:'top-left',tagLayout:'caption',tagLayoutSettingsVersion:1,tagLayouts:{corners:{groups:[{group:'quality',slot:'br'}]},bands:{groups:[{group:'quality',slot:'top'}]}}}");
        var layout = PosterTagResolver.Resolve(Entry(), settings, Context(), false)!;
        Assert.Equal(PosterTagCorner.BottomRight, GroupOf(layout, PosterTagGroup.Quality).Corner);
        Assert.Equal("bottom-right", settings.QualityTagsPosition);
    }

    [Fact]
    public void Explicit_order_sets_the_stacking_order()
    {
        var settings = Settings("{" + AllOn + "," + AllBottomLeft + ",tagLayoutSettingsVersion:1,tagGroupOrder:['language','status','rating','genre']}");
        var layout = PosterTagResolver.Resolve(Entry(), settings, Context(), false)!;
        // Listed groups first, the rest in the default order (quality before ageRating).
        Assert.Equal(new[] { PosterTagGroup.Language, PosterTagGroup.Rating, PosterTagGroup.Genre, PosterTagGroup.Quality, PosterTagGroup.AgeRating }, layout.Groups.Select(g => g.Group));
    }

    [Fact]
    public void Admin_order_is_never_inherited_only_an_own_order_restacks()
    {
        // The admin order reaches users only by being copied in (new-user seeding, apply to all, Reset).
        var config = new PluginConfiguration { TagGroupOrder = ["ageRating", "genre"] };
        var arrival = new[] { PosterTagGroup.Quality, PosterTagGroup.Genre, PosterTagGroup.Rating, PosterTagGroup.AgeRating, PosterTagGroup.Language };
        var normalized = PosterTagResolver.Resolve(Entry(), Settings("{" + AllOn + "," + AllBottomLeft + ",tagLayoutSettingsVersion:1}", config), Context(), false)!;
        Assert.Equal(arrival, normalized.Groups.Select(g => g.Group));

        var legacy = PosterTagResolver.Resolve(Entry(), Settings("{" + AllOn + "," + AllBottomLeft + ",tagGroupOrder:['language']}", config), Context(), false)!;
        Assert.Equal(arrival, legacy.Groups.Select(g => g.Group));
        Assert.Null(Settings("{tagLayoutSettingsVersion:1}", config).GroupOrder);
    }

    /// <summary>What a poster draws, group by group: its corner and its tags, in stacking order.</summary>
    private static List<string> Drawn(PosterTagLayout layout) =>
        layout.Groups.Select(g => $"{g.Group}@{g.Corner}: {string.Join(" | ", g.Tags.Select(t => t.ToString()))}").ToList();

    /// <summary>
    /// A version-0 document whose groups share corners, and the same document after the web's first
    /// layout edit promoted it (core/tag-layout.js promoteLegacySettings: corners, full labels, the
    /// legacy limits as explicit caps, no order) plus that one edit.
    /// </summary>
    private const string LegacyDoc = AllOn + ",qualityTagsPosition:'bottom-left',languageTagsPosition:'bottom-left',ratingTagsPosition:'bottom-left',genreTagsPosition:'top-right',ageRatingTagsPosition:'bottom-right'";
    private const string Promoted = ",tagLayoutSettingsVersion:1,tagLayout:'corners',tagLabelDensity:'full',tagGroupOrder:null";
    private const string LegacyCaps = "quality:0,genre:3,language:3,rating:0,ageRating:1,status:1";

    [Theory]
    [InlineData(",ageRatingTagsPosition:'top-left',tagGroupCaps:{" + LegacyCaps + "},tagLayouts:{corners:{groups:[{group:'ageRating',slot:'tl'}]}}", PosterTagGroup.AgeRating)]
    [InlineData(",tagGroupCaps:{quality:0,genre:2,language:3,rating:0,ageRating:1,status:1}", PosterTagGroup.Genre)]
    [InlineData(",tagLabelDensity:'compact',tagGroupCaps:{" + LegacyCaps + "}", null)]
    public void Promoting_a_document_from_before_layouts_changes_only_the_edited_group(string edit, PosterTagGroup? changed)
    {
        // Admin defaults that would restack and cap every shared corner if they leaked in.
        var config = new PluginConfiguration { TagGroupOrder = ["genre", "rating"], TagGroupCaps = new TagGroupCaps { Quality = 1, Language = 1 }, TagLayout = "bands", TagLabelDensity = "compact" };
        var before = Drawn(PosterTagResolver.Resolve(Entry(), Settings("{" + LegacyDoc + "}", config), Context(), false)!);
        var after = Drawn(PosterTagResolver.Resolve(Entry(), Settings("{" + LegacyDoc + Promoted + edit + "}", config), Context(), false)!);

        var name = changed?.ToString() + "@";
        Assert.Equal(before.Where(d => changed is null || !d.StartsWith(name, StringComparison.Ordinal)), after.Where(d => changed is null || !d.StartsWith(name, StringComparison.Ordinal)));
        if (changed is not null) Assert.NotEqual(before.Single(d => d.StartsWith(name, StringComparison.Ordinal)), after.Single(d => d.StartsWith(name, StringComparison.Ordinal)));
    }

    [Fact]
    public void Caps_limit_each_group_and_default_to_the_original_limits()
    {
        var defaults = PosterTagResolver.Resolve(Entry(), Settings("{" + AllOn + "}"), Context(), false)!;
        Assert.Equal(3, GroupOf(defaults, PosterTagGroup.Genre).Tags.Count);
        Assert.Equal(3, GroupOf(defaults, PosterTagGroup.Language).Tags.Count);
        var allQuality = GroupOf(defaults, PosterTagGroup.Quality).Tags.Cast<QualityTag>().Select(t => t.Label).ToList();
        Assert.True(allQuality.Count >= 3); // quality is unlimited by default

        var capped = PosterTagResolver.Resolve(Entry(), Settings("{" + AllOn + ",tagLayoutSettingsVersion:1,tagGroupCaps:{quality:2,genre:1,language:5,rating:1}}"), Context(), false)!;
        Assert.Equal(allQuality.Take(2), GroupOf(capped, PosterTagGroup.Quality).Tags.Cast<QualityTag>().Select(t => t.Label));
        Assert.Equal("Action", Assert.IsType<GenreTag>(Assert.Single(GroupOf(capped, PosterTagGroup.Genre).Tags)).Genre);
        Assert.Equal(5, GroupOf(capped, PosterTagGroup.Language).Tags.Count);
        Assert.Equal(PosterRatingSource.Critic, Assert.IsType<RatingTag>(Assert.Single(GroupOf(capped, PosterTagGroup.Rating).Tags)).Source);

        var unlimited = PosterTagResolver.Resolve(Entry(), Settings("{" + AllOn + ",tagLayoutSettingsVersion:1}", new PluginConfiguration { TagGroupCaps = new TagGroupCaps { Genre = 0 } }), Context(), false)!;
        Assert.Equal(5, GroupOf(unlimited, PosterTagGroup.Genre).Tags.Count);

        // A document from before layouts keeps the original limits whatever it or the admin says.
        var legacy = Settings("{" + AllOn + ",tagGroupCaps:{genre:1}}", new PluginConfiguration { TagGroupCaps = new TagGroupCaps { Genre = 5 } });
        Assert.Equal(3, legacy.GenreCap);
    }

    [Fact]
    public void A_null_genre_anywhere_drops_the_genre_group_as_the_web_does()
    {
        var entry = Entry();
        entry.Genres = ["Action", "Drama", "Comedy", null!];
        var layout = PosterTagResolver.Resolve(entry, Settings("{genreTagsEnabled:true}"), Context(), false);
        Assert.Null(layout);
    }

    [Fact]
    public void Rating_include_switches_drop_scores_and_leave_the_review_chip()
    {
        var config = new PluginConfiguration { ShowUserReviews = true, ShowUserRatingOnPosters = true };
        var communityOnly = PosterTagResolver.Resolve(Entry(), Settings("{ratingTagsEnabled:true,ratingTagsShowCritic:false}"), Context(), false)!;
        Assert.Equal(PosterRatingSource.Community, Assert.IsType<RatingTag>(Assert.Single(GroupOf(communityOnly, PosterTagGroup.Rating).Tags)).Source);

        var reviewOnly = PosterTagResolver.Resolve(Entry(), Settings("{ratingTagsEnabled:true,ratingTagsShowCritic:false,ratingTagsShowCommunity:false}", config), Context(2, 4.5), false)!;
        Assert.Equal(PosterRatingSource.UserReview, Assert.IsType<RatingTag>(Assert.Single(GroupOf(reviewOnly, PosterTagGroup.Rating).Tags)).Source);

        Assert.Null(PosterTagResolver.Resolve(Entry(), Settings("{ratingTagsEnabled:true,ratingTagsShowCritic:false,ratingTagsShowCommunity:false}"), Context(), false));
    }

    [Fact]
    public void New_users_inherit_the_admin_rating_includes_and_layout_defaults()
    {
        var config = new PluginConfiguration { RatingTagsShowCritic = false, TagGroupOrder = ["rating"], TagGroupCaps = new TagGroupCaps { Genre = 1 } };
        var settings = PosterTagSettings.FromSettingsJson(null, config);
        Assert.False(settings.RatingTagsShowCritic);
        Assert.True(settings.RatingTagsShowCommunity);
        Assert.Equal(PosterTagGroup.Rating, settings.GroupOrder![0]);
        Assert.Equal(1, settings.GenreCap);
    }

    [Fact]
    public void Digest_follows_every_new_effective_input()
    {
        var baseline = Settings("{" + AllOn + ",tagLayoutSettingsVersion:1}").Digest;
        Assert.NotEqual(baseline, Settings("{" + AllOn + ",tagLayoutSettingsVersion:1,tagGroupOrder:['genre']}").Digest);
        Assert.NotEqual(baseline, Settings("{" + AllOn + ",tagLayoutSettingsVersion:1,tagGroupCaps:{genre:2}}").Digest);
        Assert.NotEqual(baseline, Settings("{" + AllOn + ",tagLayoutSettingsVersion:1,ratingTagsShowCritic:false}").Digest);
        Assert.NotEqual(baseline, Settings("{" + AllOn + ",tagLayoutSettingsVersion:1,ratingTagsShowCommunity:false}").Digest);
        Assert.NotEqual(baseline, Settings("{" + AllOn + ",tagLayoutSettingsVersion:1,tagLayouts:{corners:{groups:[{group:'genre',slot:'off'}]}}}").Digest);

        // The web layout and slots of other layouts never change native pixels.
        Assert.Equal(baseline, Settings("{" + AllOn + ",tagLayoutSettingsVersion:1,tagLayout:'summary',tagLabelDensity:'compact',tagLayouts:{bands:{groups:[{group:'genre',slot:'top'}]}}}").Digest);

        // Values of a disabled group still stay out.
        Assert.Equal(Settings("{tagLayoutSettingsVersion:1}").Digest, Settings("{tagLayoutSettingsVersion:1,tagGroupCaps:{genre:2}}").Digest);
    }
}
