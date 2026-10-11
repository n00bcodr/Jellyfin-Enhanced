using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace JE.Tests;

/// <summary>
/// The native poster path reads settings.json through the settings resolver (design item C1). For a
/// legacy file (no "_je" block) that is a no-op: every digest equals the golden recorded before the
/// resolver was inserted, for each legacy fixture file and admin config, with native poster tags on
/// and off. <see cref="PosterTagSettings.ResolverVersion"/> is not bumped, so cached composites and
/// variant tokens survive the upgrade.
/// </summary>
public class PosterLegacyDigestTests
{
    private static IEnumerable<(string Name, Action<PluginConfiguration> Configure)> Configs()
    {
        foreach (var config in CoreSettingsDefaultsTests.ReadFixture("admin-configs.json").Properties())
        {
            foreach (var native in new[] { false, true })
            {
                yield return ($"{config.Name}, native {(native ? "on" : "off")}", c =>
                {
                    JsonConvert.PopulateObject(config.Value.ToString(), c);
                    c.NativePosterTagsEnabled = native;
                });
            }
        }
    }

    // Legacy whole documents with every card tag group on, so the digest covers real tag values.
    private static readonly (string Name, string Stored)[] TaggedFiles =
    {
        ("every group on, custom order and positions", "{\"QualityTagsEnabled\":true,\"GenreTagsEnabled\":true,\"LanguageTagsEnabled\":true,\"RatingTagsEnabled\":true,\"AgeRatingTagsEnabled\":true,\"ShowSourceTag\":false,\"ResolutionTagOrder\":3,\"AudioInfoTagOrder\":1,\"QualityTagsPosition\":\"bottom-right\",\"GenreTagsPosition\":\"\",\"QualityTagsPreferredAudioLanguage\":\"auto\",\"RatingTagsOnEpisodes\":false,\"UseNativePosterTags\":true}"),
        ("every group on, native tags switched off", "{\"QualityTagsEnabled\":true,\"GenreTagsEnabled\":true,\"LanguageTagsEnabled\":true,\"RatingTagsEnabled\":true,\"AgeRatingTagsEnabled\":true,\"UseNativePosterTags\":false}"),
    };

    [Fact]
    public void LegacyFilesKeepTheirPosterDigests()
    {
        var cases = (JObject)CoreSettingsDefaultsTests.ReadFixture("legacy-partial-files.json")["Cases"]!;
        var digests = new JObject();
        foreach (var (name, configure) in Configs())
        {
            var config = new PluginConfiguration();
            configure(config);
            var perFile = new JObject
            {
                ["(no file)"] = PosterTagSettings.FromSettingsJson(null, config, "eng").Digest,
                ["(unreadable)"] = PosterTagSettings.FromSettingsJson(string.Empty, config, "eng").Digest,
            };
            foreach (var entry in cases.Properties())
            {
                var stored = entry.Value.Value<string>("Stored")!;
                perFile[entry.Name] = PosterTagSettings.FromSettingsJson(stored, config, "eng").Digest;
            }
            foreach (var (fileName, stored) in TaggedFiles)
            {
                perFile[fileName] = PosterTagSettings.FromSettingsJson(stored, config, "eng").Digest;
            }
            digests[name] = perFile;
        }
        CoreSettingsDefaultsTests.MatchGolden("poster-digests-legacy.json", digests);
    }
}
