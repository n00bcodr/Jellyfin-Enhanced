using System.Security.Claims;
using System.Text.Json;
using System.Text.RegularExpressions;
using Jellyfin.Extensions.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Mvc;
using Moq;
using Newtonsoft.Json.Linq;

namespace JE.Tests;

/// <summary>
/// The UserSettingDefaults block of the public config (design B3, 7.4 and 7.8): registry-generated,
/// sent only to signed-in callers (public-config and bootstrap), limited to bool, int and
/// choice-constrained values of non-secret admin fields, and equal to what a new user is seeded with.
/// Anonymous callers get the payload exactly as before.
/// </summary>
[Collection("Plugin singleton")]
public class CoreUserSettingDefaultsTests
{
    private static readonly Guid UserA = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");

    // Admin field names that may hold credentials or network topology; none may feed the block.
    private static readonly Regex Sensitive = new("ApiKey|Secret|Token|Password|Instances|Url|Mapping|Host|Path", RegexOptions.IgnoreCase);

    // The golden key set: every settings.json key the block carries for a valid admin config.
    // Adding a [UserSetting] admin default changes it; review the new key against the rules above.
    private static readonly string[] GoldenKeys =
    {
        "AutoPauseEnabled", "AutoResumeEnabled", "AutoPipEnabled", "LongPress2xEnabled", "PauseScreenEnabled", "PauseScreenDelaySeconds",
        "AutoSkipIntro", "AutoSkipOutro", "DisableCustomSubtitleStyles",
        "SelectedStylePresetIndex", "SelectedFontSizePresetIndex", "SelectedFontFamilyPresetIndex", "SelectedTextEffectPresetIndex",
        "RandomButtonEnabled", "RandomUnwatchedOnly", "RandomIncludeMovies", "RandomIncludeShows", "RandomScopeCurrentContainer",
        "ShowWatchProgress", "WatchProgressMode", "WatchProgressTimeFormat", "ShowFileSizes", "ShowAudioLanguages",
        "QualityTagsEnabled", "ShowResolutionTag", "ShowSourceTag", "ShowDynamicRangeTag", "ShowSpecialFormatTag", "ShowVideoCodecTag", "ShowAudioInfoTag",
        "ResolutionTagOrder", "SourceTagOrder", "DynamicRangeTagOrder", "SpecialFormatTagOrder", "VideoCodecTagOrder", "AudioInfoTagOrder",
        "GenreTagsEnabled", "LanguageTagsEnabled", "RatingTagsEnabled", "AgeRatingTagsEnabled", "PeopleTagsEnabled", "TagsHideOnHover",
        "QualityTagsPosition", "GenreTagsPosition", "LanguageTagsPosition", "RatingTagsPosition",
        "RatingTagsOnMovies", "RatingTagsOnSeries", "RatingTagsOnSeasons", "RatingTagsOnEpisodes", "RatingTagsOnContinueWatching", "RatingTagsOnNextUp",
        "AgeRatingTagsPosition", "ShowRatingInPlayer", "RemoveContinueWatchingEnabled", "ReviewsExpandedByDefault",
    };

    // Admin defaults deliberately left out of the block, with the reason.
    private static readonly Dictionary<string, string> LeftOut = new()
    {
        [nameof(UserSettings.DisplayLanguage)] = "free-form language code (no Choices); config.js reads DefaultLanguage",
        [nameof(UserSettings.QualityTagsPreferredAudioLanguage)] = "the seed writes the sentinel \"\", never the admin value",
    };

    public static IEnumerable<object[]> Seeds() => Enumerable.Range(0, 32).Select(seed => new object[] { seed });

    private static JellyfinEnhancedController Controller(ApiPluginFixture fixture, bool? admin)
    {
        var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), fixture.Core.Paths.Object, fixture.Core.Logger);
        var controller = ApiAssetTests.Controller(fixture.Core, fixture.Core.Manager, Mock.Of<IUserManager>(), maintenance);
        controller.HttpContext.User = new ClaimsPrincipal(admin == null
            ? new ClaimsIdentity()
            : new ClaimsIdentity([new Claim("Jellyfin-UserId", UserA.ToString()), new Claim(ClaimTypes.Role, admin.Value ? "Administrator" : "User")], "test"));
        return controller;
    }

    private static JObject PublicConfig(ApiPluginFixture fixture, bool? admin, JsonSerializerOptions? options = null)
        => JObject.Parse(JsonSerializer.Serialize(Assert.IsType<JsonResult>(Controller(fixture, admin).GetPublicConfig()).Value, options));

    /// <summary>Every published value is a bool, an int or one of the key's Choices.</summary>
    private static void AssertPublishable(IReadOnlyDictionary<string, object> published)
    {
        foreach (var (key, value) in published)
        {
            Assert.True(UserSettingsRegistry.TryGet(key, out var descriptor), $"{key} is not a registry key");
            Assert.True(UserSettingsRegistry.IsPublicDefault(descriptor), $"{key} is not a public default");
            switch (value)
            {
                case bool:
                case int:
                    break;
                case string text:
                    Assert.Contains(text, descriptor.Setting.Choices!);
                    break;
                default:
                    Assert.Fail($"{key}: {value.GetType().Name} is not a bool, int or choice");
                    break;
            }
        }
    }

    [Fact]
    public void NoPublicDefaultComesFromASecretOrTopologyField()
    {
        foreach (var descriptor in UserSettingsRegistry.All.Where(UserSettingsRegistry.IsPublicDefault))
        {
            Assert.DoesNotMatch(Sensitive, descriptor.Setting.AdminDefault!);
            Assert.DoesNotMatch(Sensitive, descriptor.Key);
        }
    }

    [Fact]
    public void EveryPublicDefaultIsABoolIntOrChoiceConstrainedString()
    {
        foreach (var descriptor in UserSettingsRegistry.All.Where(UserSettingsRegistry.IsPublicDefault))
        {
            // A sentinel default is not the admin value, so publishing the admin value would be wrong.
            Assert.False(descriptor.Setting.DefaultIsSentinel, $"{descriptor.Key}: its seed is a sentinel, not the admin value");
            var type = descriptor.AdminProperty!.PropertyType;
            Assert.True(type == typeof(bool) || type == typeof(int) || (type == typeof(string) && descriptor.Setting.Choices is { Length: > 0 }),
                $"{descriptor.Key}: admin default {descriptor.Setting.AdminDefault} is {type.Name}, not bool, int or a Choices-constrained string");
        }
    }

    [Fact]
    public void PublishedKeysMatchTheGoldenListAndEveryOtherAdminDefaultIsLeftOutOnPurpose()
    {
        Assert.Equal(GoldenKeys, UserSettingsRegistry.PublicDefaults(new PluginConfiguration()).Keys);
        var adminDefaults = UserSettingsRegistry.All.Where(d => d.AdminProperty != null).Select(d => d.Key);
        Assert.Equal(adminDefaults.Order(), GoldenKeys.Concat(LeftOut.Keys).Order());
    }

    [Theory]
    [MemberData(nameof(Seeds))]
    public void PublishedValuesAreTheNewUserSeedForRandomizedConfigs(int seed)
    {
        // Randomized configs hold blank strings and strings outside every Choices list.
        var config = new PluginConfiguration();
        CoreUserSettingsBuilderTests.Randomize(config, seed);
        var published = UserSettingsRegistry.PublicDefaults(config);
        AssertPublishable(published);
        var defaults = UserSettingsRegistry.BuildDefaults(config);
        foreach (var key in GoldenKeys)
        {
            Assert.True(UserSettingsRegistry.TryGet(key, out var descriptor));
            var seeded = descriptor.Property.GetValue(defaults);
            if (published.TryGetValue(key, out var value)) Assert.Equal(seeded, value);
            else Assert.True(seeded is string text && !descriptor.Setting.Choices!.Contains(text), $"{key}: valid seed value {seeded} was not published");
        }
    }

    [Fact]
    public void BlankAndInvalidAdminChoicesFollowTheSeedOrAreLeftOut()
    {
        var config = new PluginConfiguration
        {
            WatchProgressDefaultMode = " ",
            WatchProgressTimeFormat = "",
            QualityTagsPosition = "center<script>",
            GenreTagsPosition = "",
            DefaultSubtitleStyle = 3,
            ResolutionTagOrder = 6,
        };
        var published = UserSettingsRegistry.PublicDefaults(config);
        Assert.Equal("percentage", published[nameof(UserSettings.WatchProgressMode)]);
        Assert.Equal("hours", published[nameof(UserSettings.WatchProgressTimeFormat)]);
        Assert.False(published.ContainsKey(nameof(UserSettings.QualityTagsPosition)));
        Assert.Equal("", published[nameof(UserSettings.GenreTagsPosition)]);
        Assert.Equal(3, published[nameof(UserSettings.SelectedStylePresetIndex)]);
        Assert.Equal(6, published[nameof(UserSettings.ResolutionTagOrder)]);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void SignedInPublicConfigAndBootstrapCarryTheBlock(bool admin)
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.DefaultSubtitleSize = 4;
        fixture.Plugin.Configuration.QualityTagsPosition = "bottom-right";
        var expected = JObject.Parse(JsonSerializer.Serialize(UserSettingsRegistry.PublicDefaults(fixture.Plugin.Configuration)));
        Assert.Equal(4, expected.Value<int>(nameof(UserSettings.SelectedFontSizePresetIndex)));

        foreach (var options in new JsonSerializerOptions?[] { null, JsonDefaults.PascalCaseOptions })
        {
            var block = (JObject)PublicConfig(fixture, admin, options)["UserSettingDefaults"]!;
            Assert.True(JToken.DeepEquals(expected, block), block.ToString());
        }

        var bootstrap = JObject.Parse(JsonSerializer.Serialize(Assert.IsType<JsonResult>(Controller(fixture, admin).GetBootstrap()).Value, JsonDefaults.PascalCaseOptions));
        Assert.True(JToken.DeepEquals(expected, bootstrap["PublicConfig"]!["UserSettingDefaults"]));
    }

    [Fact]
    public void AnonymousPublicConfigIsUnchangedAndDiffersOnlyByTheBlockAndSeerrFields()
    {
        using var fixture = new ApiPluginFixture();
        // Seerr fields empty, so the authenticated payload has nothing extra to unredact.
        fixture.Plugin.Configuration.JellyseerrUrls = string.Empty;
        fixture.Plugin.Configuration.JellyseerrUrlMappings = string.Empty;
        foreach (var options in new JsonSerializerOptions?[] { null, JsonDefaults.PascalCaseOptions })
        {
            var anonymous = PublicConfig(fixture, null, options);
            Assert.False(anonymous.ContainsKey("UserSettingDefaults"));
            Assert.DoesNotContain("UserSettingDefaults", anonymous.ToString(), StringComparison.Ordinal);

            var signedIn = PublicConfig(fixture, false, options);
            Assert.True(signedIn.Remove("UserSettingDefaults"));
            // Same fields, same order, same values: the signed-in payload is the anonymous one plus the block.
            Assert.Equal(anonymous.Properties().Select(p => p.Name), signedIn.Properties().Select(p => p.Name));
            Assert.True(JToken.DeepEquals(anonymous, signedIn));
        }
    }
}
