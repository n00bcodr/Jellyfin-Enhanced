// Parity harness for Services/PosterTags (native poster tags): runs the C# resolver over the
// same profiles and tag-cache entries as web-expected.mjs and writes data/out/cs-<profile>.json.
//
//   dotnet run -- prepare <dataDir>   web view of synthetic settings + server-faithful synthetic entries
//   dotnet run -- resolve <dataDir> [profile]
//   dotnet run -- names   <dataDir>   LanguageNames.Of vs Intl.DisplayNames (data/names-expected.json)
//   dotnet run -- casing  <dataDir>   JsText.ToLower/ToUpper vs String.prototype (data/casing-expected.json)
using System.Globalization;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Xml.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Newtonsoft.Json.Linq;

var mode = args.Length > 0 ? args[0] : "resolve";
var dataDir = args.Length > 1 ? args[1] : Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "data");
var onlyProfile = args.Length > 2 ? args[2] : null;

// Named float literals let synthetic entries carry non-finite ratings ("Infinity", "NaN"); the web's
// Number() / parseFloat() read those strings as the same numbers.
var serverJson = new JsonSerializerOptions
{
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
};
var lenient = new Newtonsoft.Json.JsonSerializerSettings { NullValueHandling = Newtonsoft.Json.NullValueHandling.Ignore };

JsonNode ReadNode(params string[] path) => JsonNode.Parse(File.ReadAllText(Path.Combine(new[] { dataDir }.Concat(path).ToArray())))!;
T Read<T>(params string[] path) => JsonSerializer.Deserialize<T>(File.ReadAllText(Path.Combine(new[] { dataDir }.Concat(path).ToArray())), serverJson)!;

PluginConfiguration LoadConfig(JsonObject? overrides)
{
    using var stream = File.OpenRead(Path.Combine(dataDir, "inputs", "plugin-config.xml"));
    var config = (PluginConfiguration)new XmlSerializer(typeof(PluginConfiguration)).Deserialize(stream)!;
    if (overrides is null) return config;
    foreach (var (key, value) in overrides)
    {
        var property = typeof(PluginConfiguration).GetProperty(key) ?? throw new InvalidOperationException($"Unknown config key {key}");
        object? converted = value is null ? null : property.PropertyType switch
        {
            var t when t == typeof(bool) => value.GetValue<bool>(),
            var t when t == typeof(int) => value.GetValue<int>(),
            var t when t == typeof(string) => value.GetValue<string>(),
            _ => throw new InvalidOperationException($"Unsupported config type for {key}"),
        };
        property.SetValue(config, converted);
    }

    return config;
}

switch (mode)
{
    case "prepare":
        Prepare();
        break;
    case "resolve":
        ResolveAll();
        break;
    case "names":
        return CheckNames();
    case "casing":
        return CheckCasing();
    default:
        Console.Error.WriteLine($"Unknown mode {mode}");
        return 2;
}

return 0;

// ── prepare ─────────────────────────────────────────────────────────────────
void Prepare()
{
    var profiles = ReadNode("profiles.json").AsArray();
    foreach (var profileNode in profiles)
    {
        var profile = profileNode!.AsObject();
        if (profile["settingsWeb"] is not null) continue;
        var config = LoadConfig(profile["pluginOverrides"] as JsonObject);
        UserSettings userConfig;
        if (profile["settingsText"] is JsonValue textValue)
        {
            userConfig = ReadSettingsText(textValue.GetValue<string>());
        }
        else if (profile["settingsRaw"] is JsonObject raw)
        {
            // UserConfigurationManager.GetUserConfiguration<UserSettings>.
            try
            {
                userConfig = Newtonsoft.Json.JsonConvert.DeserializeObject<UserSettings>(raw.ToJsonString(), lenient) ?? new UserSettings();
            }
            catch (Exception)
            {
                userConfig = new UserSettings();
            }
        }
        else
        {
            // GET settings.json with no file: write the controller's defaults, read them back.
            var defaults = ControllerDefaults(config);
            var saved = Newtonsoft.Json.JsonConvert.SerializeObject(JToken.FromObject(defaults), Newtonsoft.Json.Formatting.Indented);
            userConfig = Newtonsoft.Json.JsonConvert.DeserializeObject<UserSettings>(saved, lenient) ?? new UserSettings();
        }

        var node = JsonSerializer.SerializeToNode(userConfig)!.AsObject();
        node["IsAdmin"] = true;
        profile["settingsWeb"] = node;
    }

    File.WriteAllText(Path.Combine(dataDir, "profiles.json"), profiles.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));

    // Synthetic entries as the server would serialize them (float shortest form, nulls omitted).
    var entries = Read<Dictionary<string, TagCacheEntry>>("synthetic", "entries.json");
    File.WriteAllText(Path.Combine(dataDir, "synthetic", "entries.json"), JsonSerializer.Serialize(entries, serverJson));
    Console.WriteLine($"prepared {profiles.Count} profiles, {entries.Count} synthetic entries");
}

// UserConfigurationManager.GetUserConfiguration<UserSettings> on an existing file, copied verbatim.
UserSettings ReadSettingsText(string json)
{
    if (string.IsNullOrWhiteSpace(json)) return new UserSettings();
    try
    {
        return Newtonsoft.Json.JsonConvert.DeserializeObject<UserSettings>(json, lenient) ?? new UserSettings();
    }
    catch (Exception)
    {
        return new UserSettings();
    }
}

// JellyfinEnhancedController.GetUserSettingsSettings default construction, copied verbatim.
static UserSettings ControllerDefaults(PluginConfiguration defaultConfig) => new()
{
    AutoPauseEnabled = defaultConfig.AutoPauseEnabled,
    AutoResumeEnabled = defaultConfig.AutoResumeEnabled,
    AutoPipEnabled = defaultConfig.AutoPipEnabled,
    LongPress2xEnabled = defaultConfig.LongPress2xEnabled,
    PauseScreenEnabled = defaultConfig.PauseScreenEnabled,
    PauseScreenDelaySeconds = defaultConfig.PauseScreenDelaySeconds,
    AutoSkipIntro = defaultConfig.AutoSkipIntro,
    AutoSkipOutro = defaultConfig.AutoSkipOutro,
    DisableCustomSubtitleStyles = defaultConfig.DisableCustomSubtitleStyles,
    SelectedStylePresetIndex = defaultConfig.DefaultSubtitleStyle,
    SelectedFontSizePresetIndex = defaultConfig.DefaultSubtitleSize,
    SelectedFontFamilyPresetIndex = defaultConfig.DefaultSubtitleFont,
    SelectedTextEffectPresetIndex = defaultConfig.DefaultSubtitleTextEffect,
    RandomButtonEnabled = defaultConfig.RandomButtonEnabled,
    RandomUnwatchedOnly = defaultConfig.RandomUnwatchedOnly,
    RandomIncludeMovies = defaultConfig.RandomIncludeMovies,
    RandomIncludeShows = defaultConfig.RandomIncludeShows,
    RandomScopeCurrentContainer = defaultConfig.RandomScopeCurrentContainer,
    ShowWatchProgress = defaultConfig.ShowWatchProgress,
    WatchProgressMode = string.IsNullOrWhiteSpace(defaultConfig.WatchProgressDefaultMode) ? "percentage" : defaultConfig.WatchProgressDefaultMode,
    WatchProgressTimeFormat = string.IsNullOrWhiteSpace(defaultConfig.WatchProgressTimeFormat) ? "hours" : defaultConfig.WatchProgressTimeFormat,
    ShowFileSizes = defaultConfig.ShowFileSizes,
    ShowAudioLanguages = defaultConfig.ShowAudioLanguages,
    SimplifyDubLanguageFlags = defaultConfig.SimplifyDubLanguageFlags,
    UseNativePosterTags = null,
    QualityTagsEnabled = defaultConfig.QualityTagsEnabled,
    ShowResolutionTag = defaultConfig.ShowResolutionTag,
    ShowSourceTag = defaultConfig.ShowSourceTag,
    ShowDynamicRangeTag = defaultConfig.ShowDynamicRangeTag,
    ShowSpecialFormatTag = defaultConfig.ShowSpecialFormatTag,
    ShowVideoCodecTag = defaultConfig.ShowVideoCodecTag,
    ShowAudioInfoTag = defaultConfig.ShowAudioInfoTag,
    ResolutionTagOrder = defaultConfig.ResolutionTagOrder,
    SourceTagOrder = defaultConfig.SourceTagOrder,
    DynamicRangeTagOrder = defaultConfig.DynamicRangeTagOrder,
    SpecialFormatTagOrder = defaultConfig.SpecialFormatTagOrder,
    VideoCodecTagOrder = defaultConfig.VideoCodecTagOrder,
    AudioInfoTagOrder = defaultConfig.AudioInfoTagOrder,
    GenreTagsEnabled = defaultConfig.GenreTagsEnabled,
    LanguageTagsEnabled = defaultConfig.LanguageTagsEnabled,
    RatingTagsEnabled = defaultConfig.RatingTagsEnabled,
    AgeRatingTagsEnabled = defaultConfig.AgeRatingTagsEnabled,
    PeopleTagsEnabled = defaultConfig.PeopleTagsEnabled,
    QualityTagsPosition = defaultConfig.QualityTagsPosition,
    GenreTagsPosition = defaultConfig.GenreTagsPosition,
    LanguageTagsPosition = defaultConfig.LanguageTagsPosition,
    RatingTagsPosition = defaultConfig.RatingTagsPosition,
    RatingTagsOnMovies = defaultConfig.RatingTagsOnMovies,
    RatingTagsOnSeries = defaultConfig.RatingTagsOnSeries,
    RatingTagsOnSeasons = defaultConfig.RatingTagsOnSeasons,
    RatingTagsOnEpisodes = defaultConfig.RatingTagsOnEpisodes,
    RatingTagsOnContinueWatching = defaultConfig.RatingTagsOnContinueWatching,
    RatingTagsOnNextUp = defaultConfig.RatingTagsOnNextUp,
    AgeRatingTagsPosition = defaultConfig.AgeRatingTagsPosition,
    ShowRatingInPlayer = defaultConfig.ShowRatingInPlayer,
    RemoveContinueWatchingEnabled = defaultConfig.RemoveContinueWatchingEnabled,
    ReviewsExpandedByDefault = defaultConfig.ReviewsExpandedByDefault,
    DisplayLanguage = defaultConfig.DefaultLanguage,
    CalendarDisplayMode = "list",
    CalendarDefaultViewMode = "agenda",
    LastOpenedTab = "shortcuts",
};

// ── resolve ─────────────────────────────────────────────────────────────────
void ResolveAll()
{
    var outDir = Path.Combine(dataDir, "out");
    Directory.CreateDirectory(outDir);
    var profiles = ReadNode("profiles.json").AsArray();
    var timings = new List<string>();
    foreach (var profileNode in profiles)
    {
        var profile = profileNode!.AsObject();
        var name = profile["name"]!.GetValue<string>();
        if (onlyProfile is not null && name != onlyProfile) continue;
        var user = profile["user"]!.GetValue<string>();
        var synthetic = profile["synthetic"]!.GetValue<bool>();
        var config = LoadConfig(profile["pluginOverrides"] as JsonObject);
        var raw = profile["settingsRaw"] is JsonObject rawObject ? (JsonObject)rawObject.DeepClone() : null;
        var audioPreference = profile["jellyfinAudioPreference"]?.GetValue<string>();
        var settings = profile["settingsText"] is JsonValue settingsText
            ? PosterTagSettings.FromSettingsJson(settingsText.GetValue<string>(), config, audioPreference)
            : PosterTagSettings.Create(raw, config, audioPreference);

        var entries = Read<Dictionary<string, TagCacheEntry>>("inputs", $"tagcache-{user}.json");
        var userData = Read<Dictionary<string, UserDataFixture>>("inputs", $"userdata-{user}.json");
        if (synthetic)
        {
            foreach (var (k, v) in Read<Dictionary<string, TagCacheEntry>>("synthetic", "entries.json")) entries[k] = v;
            foreach (var (k, v) in Read<Dictionary<string, UserDataFixture>>("synthetic", "userdata.json")) userData[k] = v;
        }

        var reviews = profile["reviews"]!.GetValue<string>() == "synthetic"
            ? Read<Dictionary<string, ReviewFixture?>>("synthetic", "reviews.json")
            : Read<Dictionary<string, ReviewFixture?>>("inputs", $"reviews-{user}.json");

        var items = new Dictionary<string, List<object>>(entries.Count);
        var contexts = new List<(string Id, TagCacheEntry Entry, PosterTagItemContext Context)>(entries.Count);
        foreach (var (id, entry) in entries)
        {
            userData.TryGetValue(id, out var ud);
            // The pipeline's convention: Movie/Series with a TMDB id are looked up (count 0 when
            // there are no visible reviews or the key is invalid); everything else has no data (null).
            double? average = null;
            int? count = null;
            if (entry.Type is "Movie" or "Series" && !string.IsNullOrEmpty(entry.TmdbId))
            {
                reviews.TryGetValue((entry.Type == "Movie" ? "movie:" : "tv:") + entry.TmdbId, out var review);
                average = review?.Average;
                count = review?.Count ?? 0;
            }

            var played = ud is not null && (ud.Played || ud.PlayedPercentage >= 100);
            contexts.Add((id, entry, new PosterTagItemContext(entry.Type ?? string.Empty, played, ud?.UnplayedItemCount, average, count)));
        }

        // Warm-up passes (JIT tiering, regex, memo), then the timed pass that also records results.
        for (var pass = 0; pass < 3; pass++)
        {
            foreach (var (_, entry, context) in contexts) PosterTagResolver.Resolve(entry, settings, context, landscape: false);
        }

        var allocatedBefore = GC.GetAllocatedBytesForCurrentThread();
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var layouts = new PosterTagLayout?[contexts.Count];
        for (var i = 0; i < contexts.Count; i++) layouts[i] = PosterTagResolver.Resolve(contexts[i].Entry, settings, contexts[i].Context, landscape: false);
        watch.Stop();
        var allocated = GC.GetAllocatedBytesForCurrentThread() - allocatedBefore;

        for (var i = 0; i < contexts.Count; i++)
        {
            var (id, entry, context) = contexts[i];
            var layout = layouts[i];
            var groups = new List<object>();
            if (layout is not null)
            {
                foreach (var group in layout.Groups)
                {
                    groups.Add(new
                    {
                        g = group.Group.ToString(),
                        c = group.Corner.ToString(),
                        o = layout.TopRightOffset && group.Corner == PosterTagCorner.TopRight,
                        t = group.Tags.Select(Describe).ToList(),
                    });
                }
            }

            items[id] = groups;
        }

        timings.Add($"{name}: {contexts.Count} entries in {watch.Elapsed.TotalMilliseconds:F1} ms ({watch.Elapsed.TotalMicroseconds / Math.Max(1, contexts.Count):F2} us/entry, {allocated / Math.Max(1, contexts.Count)} B/entry)");

        var groupOrder = new List<string>();
        if (settings.QualityTagsEnabled && !settings.UsesJellyfinAudioPreference) groupOrder.Add("quality");
        if (settings.GenreTagsEnabled) groupOrder.Add("genre");
        if (settings.RatingTagsEnabled) groupOrder.Add("rating");
        if (settings.AgeRatingTagsEnabled) groupOrder.Add("agerating");
        if (settings.LanguageTagsEnabled) groupOrder.Add("language");
        if (settings.QualityTagsEnabled && settings.UsesJellyfinAudioPreference) groupOrder.Add("quality");

        var summary = new Dictionary<string, object?>
        {
            ["qualityTagsEnabled"] = settings.QualityTagsEnabled,
            ["genreTagsEnabled"] = settings.GenreTagsEnabled,
            ["languageTagsEnabled"] = settings.LanguageTagsEnabled,
            ["ratingTagsEnabled"] = settings.RatingTagsEnabled,
            ["ageRatingTagsEnabled"] = settings.AgeRatingTagsEnabled,
            ["qualityTagsPosition"] = settings.QualityTagsPosition,
            ["genreTagsPosition"] = settings.GenreTagsPosition,
            ["languageTagsPosition"] = settings.LanguageTagsPosition,
            ["ratingTagsPosition"] = settings.RatingTagsPosition,
            ["ageRatingTagsPosition"] = settings.AgeRatingTagsPosition,
            ["showResolutionTag"] = settings.ShowResolutionTag,
            ["showSourceTag"] = settings.ShowSourceTag,
            ["showDynamicRangeTag"] = settings.ShowDynamicRangeTag,
            ["showSpecialFormatTag"] = settings.ShowSpecialFormatTag,
            ["showVideoCodecTag"] = settings.ShowVideoCodecTag,
            ["showAudioInfoTag"] = settings.ShowAudioInfoTag,
            ["resolutionTagOrder"] = settings.ResolutionTagOrder,
            ["sourceTagOrder"] = settings.SourceTagOrder,
            ["dynamicRangeTagOrder"] = settings.DynamicRangeTagOrder,
            ["specialFormatTagOrder"] = settings.SpecialFormatTagOrder,
            ["videoCodecTagOrder"] = settings.VideoCodecTagOrder,
            ["audioInfoTagOrder"] = settings.AudioInfoTagOrder,
            ["ratingTagsOnMovies"] = settings.RatingTagsOnMovies,
            ["ratingTagsOnSeries"] = settings.RatingTagsOnSeries,
            ["ratingTagsOnSeasons"] = settings.RatingTagsOnSeasons,
            ["ratingTagsOnEpisodes"] = settings.RatingTagsOnEpisodes,
            ["qualityTagsPreferredAudioLanguage"] = settings.QualityTagsPreferredAudioLanguage,
            ["useNativePosterTags"] = settings.UseNativePosterTags,
            ["nativeEnabled"] = settings.NativeEnabled,
            ["groupOrder"] = string.Join(",", groupOrder),
        };

        var document = new { settings = summary, items, digest = settings.Digest, preferredAudioLanguage = settings.PreferredAudioLanguage };
        File.WriteAllText(Path.Combine(outDir, $"cs-{name}.json"), JsonSerializer.Serialize(document));
        Console.WriteLine($"cs {name}: {items.Count} items, digest {settings.Digest}");
    }

    File.WriteAllLines(Path.Combine(outDir, "cs-timings.txt"), timings);
}

static string Describe(PosterTag tag) => tag switch
{
    QualityTag q => $"{q.Label}|{q.Category}",
    GenreTag g => $"{g.Genre}|{g.Icon}",
    LanguageTag l => $"{l.FlagCode}|{l.Language}|{(l.Partial ? "true" : "false")}",
    RatingTag r when r.Source == PosterRatingSource.Critic => $"Critic|{r.Text}|{(r.Fresh ? "fresh" : "rotten")}",
    RatingTag r => $"{r.Source}|{r.Text}",
    AgeRatingTag a => $"{a.Text}|{a.ColorKey}",
    _ => tag.ToString() ?? string.Empty,
};

// ── names ───────────────────────────────────────────────────────────────────
int CheckNames()
{
    var expected = Read<Dictionary<string, string?>>("names-expected.json");
    var of = typeof(PosterTagSettings).Assembly
        .GetType("Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution.LanguageNames", throwOnError: true)!
        .GetMethod("Of", BindingFlags.Public | BindingFlags.Static)!;
    var mismatches = new List<string>();
    foreach (var (code, name) in expected)
    {
        var actual = (string?)of.Invoke(null, new object[] { code });
        if (!string.Equals(actual, name, StringComparison.Ordinal)) mismatches.Add($"{code}: Intl={name ?? "(RangeError)"} C#={actual ?? "(null)"}");
    }

    File.WriteAllLines(Path.Combine(dataDir, "out", "names-diff.txt"), mismatches);
    Console.WriteLine($"names: {expected.Count} codes, {mismatches.Count} mismatches");
    foreach (var line in mismatches.Take(40)) Console.WriteLine("  " + line);
    return mismatches.Count == 0 ? 0 : 1;
}

// ── casing ──────────────────────────────────────────────────────────────────
int CheckCasing()
{
    var expected = Read<List<string[]>>("casing-expected.json");
    var jsText = typeof(PosterTagSettings).Assembly
        .GetType("Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution.JsText", throwOnError: true)!;
    var lower = jsText.GetMethod("ToLower", BindingFlags.NonPublic | BindingFlags.Static)!;
    var upper = jsText.GetMethod("ToUpper", BindingFlags.NonPublic | BindingFlags.Static)!;
    var mismatches = new List<string>();
    foreach (var row in expected)
    {
        var actualLower = (string)lower.Invoke(null, new object[] { row[0] })!;
        var actualUpper = (string)upper.Invoke(null, new object[] { row[0] })!;
        if (actualLower != row[1]) mismatches.Add($"lower {Hex(row[0])}: JS={Hex(row[1])} C#={Hex(actualLower)}");
        if (actualUpper != row[2]) mismatches.Add($"upper {Hex(row[0])}: JS={Hex(row[2])} C#={Hex(actualUpper)}");
    }

    File.WriteAllLines(Path.Combine(dataDir, "out", "casing-diff.txt"), mismatches);
    Console.WriteLine($"casing: {expected.Count} strings, {mismatches.Count} mismatches");
    foreach (var line in mismatches.Take(40)) Console.WriteLine("  " + line);
    return mismatches.Count == 0 ? 0 : 1;

    static string Hex(string s) => string.Join(' ', s.EnumerateRunes().Select(r => r.Value.ToString("X4", CultureInfo.InvariantCulture)));
}

internal sealed record UserDataFixture(bool Played, int? UnplayedItemCount, double? PlayedPercentage);

internal sealed record ReviewFixture(
    [property: JsonPropertyName("average")] double? Average,
    [property: JsonPropertyName("count")] int? Count);
