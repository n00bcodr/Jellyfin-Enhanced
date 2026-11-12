using System.Text.Json;
using System.Xml.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution;

namespace JE.Tests;

/// <summary>
/// Hidden tags (#1043, TagHiddenValues): the administrator hides Tag Styles labels (the tiles of the Colours tag
/// list), and native posters drop exactly the chips each label colours, at the same point the web does: genres
/// and logos before the limit (the next ones take their places), quality after the best resolution is chosen,
/// languages from the flags but not the Dual/Multi count. A configuration that hides nothing keeps its digest.
/// </summary>
public class CoreTagHiddenValuesTests
{
    private static JellyfinEnhancedUserSettings User() => new()
    {
        TagLayoutSettingsVersion = 1, QualityTagsEnabled = true, GenreTagsEnabled = true, AgeRatingTagsEnabled = true, LanguageTagsEnabled = true,
        RatingTagsEnabled = true, LogoTagsEnabled = true, AwardsTagsEnabled = true, CustomTagsEnabled = true,
    };

    private static PluginConfiguration Config(TagHiddenValues? hidden = null) => new() { TagHiddenValues = hidden, AwardsTagsEnabled = true, LogoTagsMaxLogos = 2 };

    private static PosterTagLayout? Resolve(TagCacheEntry entry, PluginConfiguration config, JellyfinEnhancedUserSettings? user = null)
        => PosterTagResolver.Resolve(entry, PosterTagSettings.FromUserSettings(user ?? User(), config), new(entry.Type ?? "Movie", false, null, null, null), false);

    private static List<PosterTag> Chips(PosterTagLayout? layout, PosterTagGroup group)
        => layout?.Groups.FirstOrDefault(g => g.Group == group)?.Tags.ToList() ?? new List<PosterTag>();

    public static IEnumerable<object[]> LabelCases()
    {
        using var stream = typeof(CoreTagHiddenValuesTests).Assembly.GetManifestResourceStream("HiddenTagLabels.json")!;
        using var doc = JsonDocument.Parse(stream);
        foreach (var row in doc.RootElement.GetProperty("cases").EnumerateArray())
            yield return new object[] { row[0].GetString()!, row[1].GetString()!, row[2].GetString()! };
    }

    [Theory]
    [MemberData(nameof(LabelCases))]
    public void ChipsTakeTheLabelTheSharedFixtureNames(string group, string value, string label)
    {
        var actual = group switch
        {
            "genre" => TagHiddenRules.GenreLabel(value),
            "quality" => TagHiddenRules.QualityLabel(new QualityTag(value, QualityTagRules.CategoryOf(value))),
            _ => TagHiddenRules.LanguageLabel(value),
        };
        Assert.Equal(label, actual);
    }

    [Fact]
    public void OnlyCatalogLabelsAreKept()
    {
        var normalized = TagHiddenRules.Normalize(new TagHiddenValues
        {
            Genre = new[] { "drama", "drama", "Reality", "other" },
            Language = new[] { "en", "flag", "code", "subtitles", "dual" },
            AgeRating = new[] { TagHiddenRules.AgeBoard("PG-13")!, "PG-13" },
            Logos = new[] { "provider", "Netflix" },
            Quality = Array.Empty<string>(),
        })!;
        Assert.Equal(new[] { "drama", "other" }, normalized.Genre);
        Assert.Equal(new[] { "en", "subtitles", "dual" }, normalized.Language);
        Assert.Equal(new[] { TagHiddenRules.AgeBoard("PG-13") }, normalized.AgeRating);
        Assert.Equal(new[] { "provider" }, normalized.Logos);
        Assert.Null(normalized.Quality);
        Assert.Null(TagHiddenRules.Normalize(new TagHiddenValues { Genre = new[] { "Reality" } }));
        Assert.Contains("PG-13", TagHiddenRules.HiddenAgeRatings(normalized));
    }

    [Fact]
    public void AHiddenGenreLabelHidesEverySpellingBeforeTheCap()
    {
        var entry = new TagCacheEntry { Type = "Movie", Genres = new[] { "Fantasy", "Drame", "Comedy", "Family" } };
        Assert.Equal(new[] { "Fantasy", "Drame", "Comedy" }, Chips(Resolve(entry, Config()), PosterTagGroup.Genre).Cast<GenreTag>().Select(g => g.Genre));
        var hidden = Resolve(entry, Config(new TagHiddenValues { Genre = new[] { "drama", "comedy" } }));
        Assert.Equal(new[] { "Fantasy", "Family" }, Chips(hidden, PosterTagGroup.Genre).Cast<GenreTag>().Select(g => g.Genre));
        var other = new TagCacheEntry { Type = "Movie", Genres = new[] { "Reality", "Talk", "Drama" } };
        Assert.Equal(new[] { "Drama" }, Chips(Resolve(other, Config(new TagHiddenValues { Genre = new[] { "other" } })), PosterTagGroup.Genre).Cast<GenreTag>().Select(g => g.Genre));
    }

    [Fact]
    public void AgeBoardsRatingsStatusAwardsLogosAndCustomHideByTheirLabel()
    {
        var config = Config(new TagHiddenValues
        {
            AgeRating = new[] { TagHiddenRules.AgeBoard("PG-13")! }, Rating = new[] { "community" }, Awards = new[] { "oscar" },
            Logos = new[] { "company" }, Custom = new[] { "Kids" },
        });
        config.CustomTagRules = new List<CustomTagRule> { new() { Match = "tag", Value = "kids", Label = "Kids" }, new() { Match = "tag", Value = "classic", Label = "Classic" } };
        var ids = CustomTagMatcher.For(config).Ids;
        var entry = new TagCacheEntry
        {
            Type = "Movie", OfficialRating = "PG-13", CommunityRating = 7.5f, CriticRating = 90f,
            Logos = new[] { new TagLogo { Kind = "network", Name = "HBO", Logo = "/hbo.png" }, new TagLogo { Kind = "provider", Name = "Netflix", Logo = "/n.png" }, new TagLogo { Kind = "provider", Name = "Max", Logo = "/m.png" } },
            Awards = new TagAwards { OscarWinner = true, EmmyWinner = true }, CustomTags = ids.ToArray(),
        };
        var user = User();
        user.RatingTagsShowCommunity = true;
        user.RatingTagsShowCritic = true;
        var layout = Resolve(entry, config, user);
        Assert.Empty(Chips(layout, PosterTagGroup.AgeRating));
        Assert.DoesNotContain(Chips(layout, PosterTagGroup.Rating), t => t is RatingTag { SourceId: "community" });
        Assert.Equal(new[] { "Netflix", "Max" }, Chips(layout, PosterTagGroup.Logos).Cast<LogoTag>().Select(l => l.Name));
        Assert.Equal(new[] { "emmy" }, Chips(layout, PosterTagGroup.Awards).Cast<AwardTag>().Select(a => a.Id));
        Assert.Equal(new[] { "Classic" }, Chips(layout, PosterTagGroup.Custom).Cast<CustomTag>().Select(c => c.Label));
        var plain = Resolve(entry, Config(), user);
        Assert.Single(Chips(plain, PosterTagGroup.AgeRating));
        Assert.Contains(Chips(plain, PosterTagGroup.Rating), t => t is RatingTag { SourceId: "community" });
    }

    [Fact]
    public void QualityHidesByItsColourLabelAfterTheBestResolutionIsChosen()
    {
        var entry = new TagCacheEntry
        {
            Type = "Movie",
            StreamData = new TagStreamData { Streams = [new() { Type = "Video", Codec = "hevc", Width = 3840, Height = 2160 }, new() { Type = "Audio", Codec = "eac3", Channels = 6 }] },
        };
        var plain = Chips(Resolve(entry, Config()), PosterTagGroup.Quality).Cast<QualityTag>().Select(q => q.Label).ToList();
        Assert.Contains("4K", plain);
        Assert.Contains("HEVC", plain);
        var hidden = Chips(Resolve(entry, Config(new TagHiddenValues { Quality = new[] { "4K", "HEVC", "Dolby Digital+" } })), PosterTagGroup.Quality)
            .Cast<QualityTag>().Select(q => q.Label).ToList();
        Assert.DoesNotContain("4K", hidden);
        Assert.DoesNotContain("HEVC", hidden);
        Assert.DoesNotContain(hidden, l => l.StartsWith("Dolby Digital+", StringComparison.Ordinal));
        Assert.DoesNotContain(hidden, l => l is "1080p" or "720p" or "SD");
    }

    [Fact]
    public void HiddenLanguagesLeaveTheFlagsButTheDualBadgeStillCountsThem()
    {
        var entry = new TagCacheEntry { Type = "Movie", AudioLanguages = new[] { "eng", "jpn" }, SubtitleLanguages = new[] { "fre" } };
        var user = User();
        user.LanguageTagsCountBadge = "both";
        user.LanguageTagsShowSubtitles = true;
        var tags = Chips(Resolve(entry, Config(new TagHiddenValues { Language = new[] { "en", "subtitles" } }), user), PosterTagGroup.Language).Cast<LanguageTag>().ToList();
        Assert.Equal("Dual", tags[0].CountBadge);
        Assert.Equal(new[] { "jp" }, tags.Skip(1).Select(t => t.FlagCode));
        var noBadge = Chips(Resolve(entry, Config(new TagHiddenValues { Language = new[] { "dual" } }), user), PosterTagGroup.Language).Cast<LanguageTag>().ToList();
        Assert.DoesNotContain(noBadge, t => t.CountBadge is not null);
    }

    [Fact]
    public void NothingHiddenKeepsTheDigestAndAListRetiresPosterUrls()
    {
        var plain = PosterTagSettings.FromUserSettings(User(), Config()).Digest;
        Assert.Equal(plain, PosterTagSettings.FromUserSettings(User(), Config(new TagHiddenValues { Genre = Array.Empty<string>() })).Digest);
        Assert.Equal(plain, PosterTagSettings.FromUserSettings(User(), Config(new TagHiddenValues { Genre = new[] { "Reality" } })).Digest);
        Assert.NotEqual(plain, PosterTagSettings.FromUserSettings(User(), Config(new TagHiddenValues { Genre = new[] { "drama" } })).Digest);
        var off = User();
        off.GenreTagsEnabled = false;
        Assert.Equal(PosterTagSettings.FromUserSettings(off, Config()).Digest, PosterTagSettings.FromUserSettings(off, Config(new TagHiddenValues { Genre = new[] { "drama" } })).Digest);
    }

    [Fact]
    public void TheListRoundTripsThroughTheServerConfigurationAndThePage()
    {
        var config = new PluginConfiguration { TagHiddenValues = new TagHiddenValues { Genre = new[] { "drama" } } };
        using var writer = new StringWriter();
        new XmlSerializer(typeof(PluginConfiguration)).Serialize(writer, config);
        using var reader = new StringReader(writer.ToString());
        var xml = (PluginConfiguration)new XmlSerializer(typeof(PluginConfiguration)).Deserialize(reader)!;
        Assert.Equal(new[] { "drama" }, xml.TagHiddenValues!.Genre);
        Assert.Null(new PluginConfiguration().TagHiddenValues);
        Assert.Contains("TagHiddenValues", MediaTagsPageFields.Allowed);
        Assert.DoesNotContain("TagHiddenValues", MediaTagsPortable.UserFields);
        Assert.True(MediaTagsPageFields.TryNormalize("TagHiddenValues", new TagHiddenValues { Genre = new[] { "drama", "drama", "Reality" } }, out var normalized, out _));
        Assert.Equal(new[] { "drama" }, ((TagHiddenValues)normalized!).Genre);
    }
}
