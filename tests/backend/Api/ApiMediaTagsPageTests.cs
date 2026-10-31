using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Globalization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;
using Newtonsoft.Json;
using JsonElement = System.Text.Json.JsonElement;
using StjSerializer = System.Text.Json.JsonSerializer;

namespace JE.Tests;

/// <summary>
/// The Media Tags admin page: its registration and files, the cache summary
/// it reads, and What's New still tracking the settings it took over from
/// the main configuration page.
/// </summary>
[Collection("Plugin singleton")]
public class ApiMediaTagsPageTests
{
    [Fact]
    public async Task PageIsRegisteredOutsideTheMenuAndServesItsModules()
    {
        using var f = new ApiPluginFixture();
        var page = Assert.Single(f.Plugin.GetPages(), p => p.Name == "JellyfinEnhancedMediaTags");
        Assert.False(page.EnableInMainMenu);
        using (var stream = typeof(Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced).Assembly.GetManifestResourceStream(page.EmbeddedResourcePath))
        {
            Assert.NotNull(stream);
            var html = await new StreamReader(stream!).ReadToEndAsync();
            Assert.Contains("id=\"JellyfinEnhancedMediaTagsPage\"", html);
            Assert.Contains("/JellyfinEnhanced/js/enhanced/admintags/admin-tags.js", html);
        }

        var controller = ApiAssetTests.Controller(f.Core);
        foreach (var (path, type) in new[] { ("enhanced/admintags/admin-tags.js", "application/javascript"), ("enhanced/admintags/admin-tags.css", "text/css"), ("enhanced/admintags/sections/layout.js", "application/javascript") })
        {
            var result = Assert.IsType<FileStreamResult>(controller.GetScript(path));
            Assert.Equal(type, result.ContentType);
        }
    }

    [Fact]
    public void CacheSummaryIsAdminOnlyAndReportsTheCache()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.TagCacheServerMode = true;
        using var cache = new TagCacheService(Mock.Of<ILibraryManager>(), f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
        var controller = ApiAssetTests.Controller(f.Core, cache);
        void SignIn(bool admin) => controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = global::JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(Guid.NewGuid(), admin) } };

        SignIn(admin: false);
        Assert.IsType<ForbidResult>(controller.GetTagCacheSummary());

        SignIn(admin: true);
        var body = JsonConvert.SerializeObject(Assert.IsType<OkObjectResult>(controller.GetTagCacheSummary()).Value);
        Assert.Equal("{\"enabled\":true,\"entries\":0,\"lastModified\":0,\"rebuilding\":false}", body);

        f.Plugin.Configuration.TagCacheServerMode = false;
        body = JsonConvert.SerializeObject(Assert.IsType<OkObjectResult>(controller.GetTagCacheSummary()).Value);
        Assert.Equal("{\"enabled\":false,\"entries\":0,\"lastModified\":0,\"rebuilding\":false}", body);
    }

    [Fact]
    public void WhatsNewTracksTheSettingsOnTheMediaTagsPage()
    {
        using var f = new ApiPluginFixture();
        var service = new WhatsNewService(f.Core.Paths.Object, f.Core.Logger);
        service.CheckForNewSettings();
        var path = Path.Combine(f.Core.ConfigRoot, "config-schema-snapshot.json");
        var ids = JsonConvert.DeserializeObject<ConfigSchemaSnapshot>(File.ReadAllText(path))!.SettingIds;
        // Moved off configPage.html, declared by the page's section modules under their old ids.
        foreach (var id in new[] { "qualityTagsEnabled", "showResolutionTag", "tagLayout", "statusTagsJustAddedDays", "tagStylesEnabled", "tagCacheServerMode", "nativePosterTagsWebClientNames", "tagLookRulesJson", "tagScale", "tagGap", "tagEdgeSpacing", "awardsTagsEnabled", "awardsTagsImdbList", "awardsTagsRefreshHours", "logoTagsMovieMode", "logoTagsSeriesMode", "logoTagsRegion", "logoTagsMaxLogos", "customTagRules" })
        {
            Assert.Contains(id, ids);
        }

        // Still on the main page.
        Assert.Contains("devMode", ids);
        Assert.Equal(ids.Count, ids.Distinct().Count());
    }

    /// <summary>The admin page's field patch: per-field writes on top of the live configuration.</summary>
    private static (JellyfinEnhancedController Controller, Action<bool> SignIn) PatchController(ApiPluginFixture f)
    {
        var controller = ApiAssetTests.Controller(f.Core);
        void SignIn(bool admin) => controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = global::JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(Guid.NewGuid(), admin) } };
        SignIn(true);
        return (controller, SignIn);
    }

    private static JellyfinEnhancedController.ConfigurationPatchRequest Patch(object changes, object? expected = null) => new()
    {
        Changes = StjSerializer.Deserialize<Dictionary<string, JsonElement>>(StjSerializer.Serialize(changes)),
        Expected = expected == null ? null : StjSerializer.Deserialize<Dictionary<string, JsonElement>>(StjSerializer.Serialize(expected)),
    };

    [Fact]
    public void TwoAdministratorsEditingDifferentFieldsBothPersist()
    {
        using var f = new ApiPluginFixture();
        var (controller, _) = PatchController(f);
        f.Plugin.Configuration.DevMode = true;
        // Both pages read the configuration before either saved.
        var a = controller.PatchConfiguration(Patch(new { TagsHideOnHover = true }, new { TagsHideOnHover = false }));
        var b = controller.PatchConfiguration(Patch(new { DisableTagsOnSearchPage = true }, new { DisableTagsOnSearchPage = false }));
        Assert.IsType<OkObjectResult>(a);
        Assert.IsType<OkObjectResult>(b);
        Assert.True(f.Plugin.Configuration.TagsHideOnHover);
        Assert.True(f.Plugin.Configuration.DisableTagsOnSearchPage);
        Assert.True(f.Plugin.Configuration.DevMode, "fields nobody patched keep the server value");
    }

    [Fact]
    public void TwoAdministratorsEditingTheSameFieldGetAConflictAndNothingIsOverwritten()
    {
        using var f = new ApiPluginFixture();
        var (controller, _) = PatchController(f);
        f.Plugin.Configuration.StatusTagsJustAddedDays = 7;
        Assert.IsType<OkObjectResult>(controller.PatchConfiguration(Patch(new { StatusTagsJustAddedDays = 8 }, new { StatusTagsJustAddedDays = 7 })));
        // B read 7 too and saves 9 together with an unrelated field: refused as a whole.
        var refused = Assert.IsType<ConflictObjectResult>(controller.PatchConfiguration(Patch(new { StatusTagsJustAddedDays = 9, TagsHideOnHover = true }, new { StatusTagsJustAddedDays = 7, TagsHideOnHover = false })));
        Assert.Equal("{\"conflicts\":{\"StatusTagsJustAddedDays\":8}}", StjSerializer.Serialize(refused.Value));
        Assert.Equal(8, f.Plugin.Configuration.StatusTagsJustAddedDays);
        Assert.False(f.Plugin.Configuration.TagsHideOnHover, "a refused patch writes nothing");
        // Keep mine: the same edit against the value now on the server.
        Assert.IsType<OkObjectResult>(controller.PatchConfiguration(Patch(new { StatusTagsJustAddedDays = 9 }, new { StatusTagsJustAddedDays = 8 })));
        Assert.Equal(9, f.Plugin.Configuration.StatusTagsJustAddedDays);
        // Both choosing the same value is not a conflict.
        Assert.IsType<OkObjectResult>(controller.PatchConfiguration(Patch(new { StatusTagsJustAddedDays = 9 }, new { StatusTagsJustAddedDays = 3 })));
    }

    [Fact]
    public void PatchKeepsObjectFieldsComparesThemByValueAndReturnsTheStoredValues()
    {
        using var f = new ApiPluginFixture();
        var (controller, _) = PatchController(f);
        var order = new List<string> { "quality", "genre" };
        Assert.IsType<OkObjectResult>(controller.PatchConfiguration(Patch(new { TagGroupOrder = order }, new { TagGroupOrder = (object?)null })));
        Assert.Equal(order, f.Plugin.Configuration.TagGroupOrder);
        // An equal list read back from the API is not a conflict; the server stores the canonical spelling.
        var ok = Assert.IsType<OkObjectResult>(controller.PatchConfiguration(Patch(new { TagGroupOrder = new[] { "Genre" }, TagLayout = " Bands " }, new { TagGroupOrder = new[] { "quality", "genre" } })));
        Assert.Equal("{\"values\":{\"TagGroupOrder\":[\"genre\"],\"TagLayout\":\"bands\"}}", StjSerializer.Serialize(ok.Value));
        Assert.Equal("bands", f.Plugin.Configuration.TagLayout);
    }

    [Fact]
    public void PatchIsAdminOnlyAndRefusesUnknownFieldsAndBadValues()
    {
        using var f = new ApiPluginFixture();
        var (controller, signIn) = PatchController(f);
        signIn(false);
        Assert.IsType<ForbidResult>(controller.PatchConfiguration(Patch(new { TagsHideOnHover = true })));
        Assert.False(f.Plugin.Configuration.TagsHideOnHover);
        signIn(true);
        Assert.IsType<BadRequestObjectResult>(controller.PatchConfiguration(Patch(new { NoSuchField = 1 })));
        Assert.IsType<BadRequestObjectResult>(controller.PatchConfiguration(Patch(new { TagsHideOnHover = "maybe" })));
        Assert.IsType<BadRequestObjectResult>(controller.PatchConfiguration(new JellyfinEnhancedController.ConfigurationPatchRequest()));
        Assert.False(f.Plugin.Configuration.TagsHideOnHover);
    }

    /// <summary>The page's fields (tests/fixtures/admin-tags-page-fields.json, which the page's own list must equal too).</summary>
    private static List<string> PageFields()
    {
        using var stream = typeof(ApiMediaTagsPageTests).Assembly.GetManifestResourceStream("AdminTagsPageFields.json")!;
        using var json = System.Text.Json.JsonDocument.Parse(stream);
        return json.RootElement.GetProperty("fields").EnumerateArray().Select(e => e.GetString()!).ToList();
    }

    [Fact]
    public void ThePatchAcceptsExactlyTheFieldsTheSectionModulesDeclare()
    {
        Assert.Equal(PageFields().OrderBy(x => x, StringComparer.Ordinal), MediaTagsPageFields.Allowed.OrderBy(x => x, StringComparer.Ordinal));
        // The declarations are read lexically: key, an ordered field's orderKey, and a section's writes.
        const string module = """
            A.registerSection({
                id: 'x',
                tab: 'groups',
                writes: ['TagLayouts', 'TagGroupCaps'],
                fields: [
                    { id: 'showResolutionTag', key: 'ShowResolutionTag', type: 'ordered', orderKey: 'ResolutionTagOrder', label: 'y' },
                ],
            });
            """;
        Assert.Equal(new[] { "ResolutionTagOrder", "ShowResolutionTag", "TagGroupCaps", "TagLayouts" }, MediaTagsPageFields.Parse(new[] { module }).OrderBy(x => x, StringComparer.Ordinal));
    }

    [Fact]
    public void EveryPageFieldIsAcceptedWithItsStoredValue()
    {
        using var f = new ApiPluginFixture();
        var (controller, _) = PatchController(f);
        var stored = System.Text.Json.Nodes.JsonNode.Parse(StjSerializer.Serialize(f.Plugin.Configuration, Jellyfin.Extensions.Json.JsonDefaults.Options))!.AsObject();
        foreach (var field in PageFields())
        {
            var request = new JellyfinEnhancedController.ConfigurationPatchRequest { Changes = new() { [field] = StjSerializer.SerializeToElement(stored[field]) } };
            var result = controller.PatchConfiguration(request);
            Assert.True(result is OkObjectResult, $"{field}: {StjSerializer.Serialize((result as ObjectResult)?.Value)}");
        }
    }

    [Fact]
    public void TierTwoPortsNormalizeAndSaveWithoutExposingServerState()
    {
        using var f = new ApiPluginFixture();
        var (controller, _) = PatchController(f);
        var result = controller.PatchConfiguration(Patch(new {
            TagScale = " LARGER ", TagGap = " Roomy ", TagEdgeSpacing = " FLUSH ",
            AwardsTagsEnabled = true, AwardsTagsImdbList = "12345", AwardsTagsLetterboxdList = "owner/list", AwardsTagsRefreshHours = 12,
            LogoTagsMovieMode = " STUDIO ", LogoTagsSeriesMode = " PROVIDER ", LogoTagsRegion = " au ", LogoTagsMaxLogos = 2,
            CustomTagRules = new[] { new { Match = " TAG ", Value = " Remaster ", Label = " Remaster ", Icon = " theaters " } }
        }));
        Assert.IsType<OkObjectResult>(result);
        var c = f.Plugin.Configuration;
        Assert.Equal("larger", c.TagScale); Assert.Equal("roomy", c.TagGap); Assert.Equal("flush", c.TagEdgeSpacing);
        Assert.Equal("studio", c.LogoTagsMovieMode); Assert.Equal("provider", c.LogoTagsSeriesMode); Assert.Equal("AU", c.LogoTagsRegion);
        Assert.Equal("Remaster", Assert.Single(c.CustomTagRules).Value);
        Assert.DoesNotContain("CustomTagRuleKey", StjSerializer.Serialize(((OkObjectResult)result).Value));
        Assert.IsType<OkObjectResult>(controller.PatchConfiguration(Patch(new { LogoTagsRegion = "" })));
        Assert.Equal("", f.Plugin.Configuration.LogoTagsRegion);
        var tooMany = Enumerable.Range(0, 21).Select(i => new { Match = "tag", Value = "Tag " + i, Label = "Label " + i }).ToArray();
        Assert.IsType<BadRequestObjectResult>(controller.PatchConfiguration(Patch(new { CustomTagRules = tooMany })));
    }

    [Fact]
    public void FieldsThePageDoesNotOwnAreRefusedAndNothingIsWritten()
    {
        using var f = new ApiPluginFixture();
        var (controller, _) = PatchController(f);
        f.Plugin.Configuration.TMDB_API_KEY = "server-key";
        foreach (var (field, value) in new (string, object)[] { ("DevMode", true), ("TMDB_API_KEY", "posted-key"), ("MdblistApiKey", "posted-key"), ("AnalyticsInstallSecret", "posted"), ("AnalyticsEnabled", true), ("CustomTagRuleKey", "posted"), ("CustomTagRuleSources", "posted") })
        {
            var refused = Assert.IsType<BadRequestObjectResult>(controller.PatchConfiguration(new JellyfinEnhancedController.ConfigurationPatchRequest
            {
                // With a page field in the same request: refused as a whole.
                Changes = new() { ["TagsHideOnHover"] = StjSerializer.SerializeToElement(true), [field] = StjSerializer.SerializeToElement(value) },
            }));
            Assert.Contains($"'{field}' is not a Media Tags setting", JsonConvert.SerializeObject(refused.Value), StringComparison.Ordinal);
        }

        Assert.False(f.Plugin.Configuration.TagsHideOnHover);
        Assert.False(f.Plugin.Configuration.DevMode);
        Assert.Equal("server-key", f.Plugin.Configuration.TMDB_API_KEY);
        Assert.False(f.Plugin.Configuration.AnalyticsEnabled);
    }

    [Theory]
    // Tier 2 ports use the same normalisers as their original branches.
    [InlineData("TagScale", "\"\"", "must be one of")]
    [InlineData("TagGap", "\"wide\"", "must be one of")]
    [InlineData("TagEdgeSpacing", "\"unknown\"", "must be one of")]
    [InlineData("LogoTagsMovieMode", "\"network\"", "must be one of")]
    [InlineData("LogoTagsSeriesMode", "\"studio\"", "must be one of")]
    [InlineData("LogoTagsRegion", "\"USA\"", "valid two-letter")]
    [InlineData("LogoTagsMaxLogos", "3", "must be between")]
    [InlineData("AwardsTagsRefreshHours", "169", "must be between")]
    [InlineData("AwardsTagsImdbList", "\"https://example.com/list\"", "numeric list id or owner/slug")]
    [InlineData("AwardsTagsLetterboxdList", "\"0\"", "numeric list id or owner/slug")]
    [InlineData("CustomTagRules", "[{\"Match\":\"tag\",\"Value\":\"Remaster\",\"Label\":\"*\"}]", "complete distinct rules")]
    [InlineData("CustomTagRules", "[{\"Match\":\"other\",\"Value\":\"Remaster\",\"Label\":\"Remaster\"}]", "complete distinct rules")]
    [InlineData("CustomTagRules", "[{\"Match\":\"tag\",\"Value\":\"Remaster\",\"Label\":\"Remaster\",\"Icon\":\"bad\"}]", "complete distinct rules")]
    // Values outside a known set.
    [InlineData("TagLayout", "\"not-a-layout\"", "must be one of corners, bands, caption, summary, minimal")]
    [InlineData("TagLabelDensity", "\"huge\"", "must be one of full, compact")]
    [InlineData("LanguageTagsCountBadge", "\"sometimes\"", "must be one of off, only, both")]
    [InlineData("SeriesQualityAggregation", "\"worst\"", "must be one of")]
    [InlineData("TagStyleTarget", "\"tv\"", "must be one of web, native, both")]
    [InlineData("QualityTagsPosition", "\"middle-ish\"", "must be one of")]
    [InlineData("TagStylePreset", "\"neon\"", "unknown preset")]
    [InlineData("RatingTagsSources", "[\"imdb\",\"imdb\"]", "must name distinct sources")]
    [InlineData("RatingTagsSources", "[\"rotten\"]", "must name distinct sources")]
    [InlineData("TagGroupOrder", "[\"quality\",\"cast\"]", "must name distinct groups")]
    [InlineData("TagCacheExcludedLibraryIds", "\"movies,shows\"", "must be library ids")]
    [InlineData("TagStyleOverrides", "\"{not json\"", "document is not valid JSON")]
    [InlineData("TagLookRules", "[{\"Layout\":\"nowhere\",\"When\":[]}]", "every rule needs")]
    // Numbers outside their range.
    [InlineData("TagsCacheTtlDays", "-2147483648", "must be between 1 and 365")]
    [InlineData("TagsCacheTtlDays", "0", "must be between 1 and 365")]
    [InlineData("StatusTagsJustAddedDays", "366", "must be between 1 and 365")]
    [InlineData("ResolutionTagOrder", "-1", "must be between 1 and 99")]
    [InlineData("RatingTagsMinScore", "11", "must be between 0 and 10")]
    [InlineData("ClearLocalStorageTimestamp", "-5", "must not be negative")]
    [InlineData("TagGroupCaps", "{\"Quality\":-1}", "caps must be between 0 and 10")]
    // Text that is not nullable.
    [InlineData("LanguageTagsPriority", "null", "must not be null")]
    public void OutOfContractValuesAreRefusedWithTheReasonAndNothingIsWritten(string field, string json, string reason)
    {
        using var f = new ApiPluginFixture();
        var (controller, _) = PatchController(f);
        var before = StjSerializer.Serialize(f.Plugin.Configuration);
        var refused = Assert.IsType<BadRequestObjectResult>(controller.PatchConfiguration(new JellyfinEnhancedController.ConfigurationPatchRequest
        {
            Changes = new() { ["TagsHideOnHover"] = StjSerializer.SerializeToElement(true), [field] = StjSerializer.Deserialize<JsonElement>(json) },
        }));
        var error = JsonConvert.SerializeObject(refused.Value);
        Assert.Contains($"Invalid value for '{field}'", error, StringComparison.Ordinal);
        Assert.Contains(reason, error, StringComparison.Ordinal);
        Assert.Equal(before, StjSerializer.Serialize(f.Plugin.Configuration));
    }

    [Fact]
    public void OversizedTextAndBodiesAreRefused()
    {
        using var f = new ApiPluginFixture();
        var (controller, _) = PatchController(f);
        // A correctly typed 1 MiB string, and one just over a field's own limit.
        foreach (var (field, length, limit) in new[] { ("NativePosterTagsWebClientNames", 1024 * 1024, 4096), ("LanguageTagsPriority", 257, 256), ("QualityTagsPreferredAudioLanguage", 33, 32) })
        {
            var refused = Assert.IsType<BadRequestObjectResult>(controller.PatchConfiguration(new JellyfinEnhancedController.ConfigurationPatchRequest
            {
                Changes = new() { [field] = StjSerializer.SerializeToElement(new string('a', length)) },
            }));
            Assert.Contains($"longer than {limit} characters", JsonConvert.SerializeObject(refused.Value), StringComparison.Ordinal);
        }

        Assert.Equal(string.Empty, f.Plugin.Configuration.LanguageTagsPriority);
        Assert.IsType<OkObjectResult>(controller.PatchConfiguration(new JellyfinEnhancedController.ConfigurationPatchRequest
        {
            Changes = new() { ["NativePosterTagsWebClientNames"] = StjSerializer.SerializeToElement(new string('a', 4096)) },
        }));
        // The body itself: reading past the action's limit fails before the action runs (Jellyfin then answers 500).
        // 256 KB: an imported settings document sends every field it changes, with the values read before, in one patch.
        var bodyLimit = typeof(JellyfinEnhancedController).GetMethod(nameof(JellyfinEnhancedController.PatchConfiguration))!
            .GetCustomAttributes(typeof(RequestSizeLimitAttribute), false).Cast<RequestSizeLimitAttribute>().Single();
        Assert.Equal(256 * 1024, ((Microsoft.AspNetCore.Http.Metadata.IRequestSizeLimitMetadata)bodyLimit).MaxRequestBodySize);
    }

    /// <summary>Every field whose value is one of a known set (none of them has an empty "inherit" value).</summary>
    public static TheoryData<string, string> EnumFieldsWithValuesOutsideTheirSet()
    {
        var data = new TheoryData<string, string>();
        foreach (var field in new[]
        {
            "TagLayout", "TagLabelDensity", "LanguageTagsStyle", "LanguageTagsCountBadge", "SeriesQualityAggregation", "TagStyleTarget", "TagStylePreset",
            "QualityTagsPosition", "GenreTagsPosition", "LanguageTagsPosition", "RatingTagsPosition", "AgeRatingTagsPosition", "StatusTagsPosition",
        })
        {
            foreach (var value in new[] { "", "   ", "unknown-value" }) data.Add(field, value);
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(EnumFieldsWithValuesOutsideTheirSet))]
    public void EmptyBlankAndUnknownEnumValuesAreRefusedAndNothingIsWritten(string field, string value)
    {
        using var f = new ApiPluginFixture();
        var (controller, _) = PatchController(f);
        Assert.False(MediaTagsPageFields.TryNormalize(field, value, out var stored, out _), $"'{value}' accepted for {field} as '{stored}'");
        var before = StjSerializer.Serialize(f.Plugin.Configuration);
        var refused = Assert.IsType<BadRequestObjectResult>(controller.PatchConfiguration(new JellyfinEnhancedController.ConfigurationPatchRequest
        {
            Changes = new() { ["TagsHideOnHover"] = StjSerializer.SerializeToElement(true), [field] = StjSerializer.SerializeToElement(value) },
        }));
        var reason = JsonConvert.SerializeObject(refused.Value);
        Assert.Contains($"Invalid value for '{field}': ", reason, StringComparison.Ordinal);
        if (string.IsNullOrWhiteSpace(value)) Assert.Contains("must be one of", reason, StringComparison.Ordinal);
        Assert.Equal(before, StjSerializer.Serialize(f.Plugin.Configuration));
    }

    [Theory]
    [InlineData("QualityTagsPosition", " Top-Right ", "top-right")]
    [InlineData("TagStyleTarget", " BOTH ", "both")]
    [InlineData("TagStylePreset", " Glass ", "glass")]
    [InlineData("TagLayout", "Bands", "bands")]
    public void KnownEnumValuesAreStoredInTheirCanonicalSpelling(string field, string value, string stored)
    {
        Assert.True(MediaTagsPageFields.TryNormalize(field, value, out var normalized, out var error), error);
        Assert.Equal(stored, normalized);
    }

    [Fact]
    public void DocumentsAreStoredNormalisedAndNullStillInherits()
    {
        using var f = new ApiPluginFixture();
        var (controller, _) = PatchController(f);
        // An unknown group and a slot the layout has not: dropped, as when the server reads the defaults.
        var ok = Assert.IsType<OkObjectResult>(controller.PatchConfiguration(new JellyfinEnhancedController.ConfigurationPatchRequest
        {
            Changes = new()
            {
                ["TagLayouts"] = StjSerializer.Deserialize<JsonElement>("{\"Bands\":{\"Groups\":[{\"Group\":\"Quality\",\"Slot\":\"top\"},{\"Group\":\"genre\",\"Slot\":\"tl\"}]}}"),
                ["TagShapeOverrides"] = StjSerializer.Deserialize<JsonElement>("null"),
                ["TagGroupCaps"] = StjSerializer.Deserialize<JsonElement>("{\"Quality\":2}"),
            },
        }));
        using var values = System.Text.Json.JsonDocument.Parse(StjSerializer.Serialize(ok.Value));
        var layouts = values.RootElement.GetProperty("values").GetProperty("TagLayouts");
        Assert.Equal("[{\"Group\":\"quality\",\"Slot\":\"top\"}]", layouts.GetProperty("Bands").GetProperty("Groups").GetRawText());
        Assert.Equal(System.Text.Json.JsonValueKind.Null, values.RootElement.GetProperty("values").GetProperty("TagShapeOverrides").ValueKind);
        Assert.Null(f.Plugin.Configuration.TagShapeOverrides);
        Assert.Equal(2, f.Plugin.Configuration.TagGroupCaps!.Quality);
    }

    /// <summary>A full save as the main configuration page posts it: the whole configuration it read, with its edits.</summary>
    private static Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration MainPageSave(ApiPluginFixture f, Action<Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration> edit)
    {
        var read = StjSerializer.Deserialize<Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration>(StjSerializer.Serialize(f.Plugin.Configuration))!;
        edit(read);
        return read;
    }

    /// <summary>Waits until <paramref name="thread"/> is blocked (on the configuration write lock).</summary>
    private static void WaitUntilBlocked(Thread thread)
        => Assert.True(SpinWait.SpinUntil(() => thread.ThreadState.HasFlag(ThreadState.WaitSleepJoin), 5000), "the patch is waiting for the lock");

    [Fact]
    public void AMainPageSaveCommittedWhileThePatchWaitsIsNotPutBackByThePatch()
    {
        using var f = new ApiPluginFixture();
        var (controller, _) = PatchController(f);
        IActionResult? result = null;
        var patch = new Thread(() => result = controller.PatchConfiguration(Patch(new { TagsHideOnHover = true }, new { TagsHideOnHover = false })));
        // Another save holds the configuration write lock: the patch arrives and waits for it.
        lock (Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.AnalyticsCredentialLock)
        {
            patch.Start();
            WaitUntilBlocked(patch);
            // The main configuration page's full save commits meanwhile (Monitor is reentrant on this thread).
            f.Plugin.UpdateConfiguration(MainPageSave(f, c => c.DisableTagsOnSearchPage = true));
            Assert.True(f.Plugin.Configuration.DisableTagsOnSearchPage);
        }

        Assert.True(patch.Join(5000));
        Assert.Equal("{\"values\":{\"TagsHideOnHover\":true}}", StjSerializer.Serialize(Assert.IsType<OkObjectResult>(result).Value));
        Assert.True(f.Plugin.Configuration.TagsHideOnHover);
        Assert.True(f.Plugin.Configuration.DisableTagsOnSearchPage, "the patch keeps the field the main page saved while it waited");
    }

    [Fact]
    public void APatchArrivingDuringAMainPageSaveWaitsAndBuildsOnIt()
    {
        using var f = new ApiPluginFixture();
        var (controller, _) = PatchController(f);
        IActionResult? result = null;
        var patch = new Thread(() => result = controller.PatchConfiguration(Patch(new { TagsHideOnHover = true }, new { TagsHideOnHover = false })));
        // The reverse order: the main page's save is in its critical section first.
        f.Plugin.UpdateConfiguration(
            current =>
            {
                patch.Start();
                WaitUntilBlocked(patch);
                Assert.False(f.Plugin.Configuration.TagsHideOnHover, "the patch does not write inside another save");
                return MainPageSave(f, c => c.DisableTagsOnSearchPage = true);
            });
        Assert.True(patch.Join(5000));
        Assert.IsType<OkObjectResult>(result);
        Assert.True(f.Plugin.Configuration.TagsHideOnHover);
        Assert.True(f.Plugin.Configuration.DisableTagsOnSearchPage, "the patch is applied on top of the save that went first");
    }

    [Fact]
    public async Task ServerWritesDuringAPatchAreKeptByThePatch()
    {
        using var f = new ApiPluginFixture();
        var users = new Mock<IUserManager>();
#if NET9_0
        users.SetupGet(x => x.Users).Returns(Array.Empty<Jellyfin.Database.Implementations.Entities.User>());
#else
        users.Setup(x => x.GetUsers()).Returns(Array.Empty<Jellyfin.Database.Implementations.Entities.User>());
#endif
        var sessions = new Mock<MediaBrowser.Controller.Session.ISessionManager>();
        sessions.SetupGet(x => x.Sessions).Returns(Array.Empty<MediaBrowser.Controller.Session.SessionInfo>());
        var maintenance = new MaintenanceModeService(users.Object, sessions.Object, f.Core.Paths.Object, f.Core.Logger);
        // A manual maintenance window the administrator turned on with the page's toggle.
        f.Plugin.Configuration.MaintenanceModeEnabled = true;
        f.Plugin.Configuration.ClearTranslationCacheTimestamp = 1;
        await maintenance.EnableAsync("", 0, "none", null);

        // The patch's critical section, as PluginConfigurationPatch.Apply builds it: a shallow copy of the
        // stored configuration with the patched field, swapped in when the builder returns. Meanwhile the
        // maintenance window ends (clearing the toggle) and the translation refresh task sets its signal.
        var ending = new Thread(() => maintenance.DisableAsync().GetAwaiter().GetResult());
        var refreshing = new Thread(() => new Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks.ClearTranslationCacheTask(f.Core.Logger).ExecuteAsync(new Progress<double>(), default).GetAwaiter().GetResult());
        Assert.True(f.Plugin.UpdateConfiguration(current =>
        {
            var next = (Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration)typeof(object)
                .GetMethod("MemberwiseClone", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.Invoke(current, null)!;
            next.TagsHideOnHover = true;
            foreach (var writer in new[] { ending, refreshing })
            {
                writer.Start();
                // Each writer either waits for the configuration write lock or (without it) finishes its write now.
                Assert.True(SpinWait.SpinUntil(() => (writer.ThreadState & (ThreadState.WaitSleepJoin | ThreadState.Stopped)) != 0, 5000));
            }

            return next;
        }));

        Assert.True(ending.Join(5000));
        Assert.True(refreshing.Join(5000));
        Assert.True(f.Plugin.Configuration.TagsHideOnHover);
        // Both writes are kept: the toggle the ended window cleared, and the translation refresh signal.
        Assert.Equal(
            new { MaintenanceModeEnabled = false, SignalKept = true },
            new { f.Plugin.Configuration.MaintenanceModeEnabled, SignalKept = f.Plugin.Configuration.ClearTranslationCacheTimestamp > 1 });
        Assert.False(maintenance.GetStatus().IsActive);
    }

    [Fact]
    public void SectionModulesNameTheTabAndGroupOfEachSetting()
    {
        // A synthetic module with a setting that is new in this build.
        const string module = """
            const SHARED_FIELDS = [
                { id: 'awardsTagsOscar', key: 'AwardsTagsOscar', type: 'switch', place: 'section', label: 'z' },
            ];
            A.registerSection({
                id: 'badges-awards',
                tab: 'badges',
                fields: SHARED_FIELDS,
            });
            A.registerSection({
                id: 'group-awards',
                tab: 'groups',
                order: 80,
                group: {
                    id: 'awards',
                    summary(ctx) { return ''; },
                },
                fields: [
                    { id: 'awardsTagsEnabled', key: 'AwardsTagsEnabled', type: 'enable', label: 'x' },
                ],
            });
            A.registerSection({
                id: 'layout-extra',
                tab: 'layout',
                fields: [
                    { id: 'tagScale', key: 'TagScale', type: 'select', label: 'y' },
                ],
            });
            """;
        var parsed = WhatsNewService.ParseSectionModule(module).ToList();
        Assert.Equal(new MediaTagsLocation("groups", "awards"), Assert.Single(parsed, p => p.Key == "awardsTagsEnabled").Value);
        Assert.Equal(new MediaTagsLocation("layout", null), Assert.Single(parsed, p => p.Key == "tagScale").Value);
        Assert.Equal(new MediaTagsLocation("badges", null), Assert.Single(parsed, p => p.Key == "awardsTagsOscar").Value);
        Assert.Equal(3, parsed.Count);
    }

    [Fact]
    public void WhatsNewRoutesNewMediaTagsSettingsToTheirTabWithoutReannouncingTheBaseline()
    {
        using var f = new ApiPluginFixture();
        var service = new WhatsNewService(f.Core.Paths.Object, f.Core.Logger);
        var controller = ApiAssetTests.Controller(f.Core, service);
        controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = global::JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(Guid.NewGuid(), true) } };
        // An acknowledged baseline announces nothing again.
        service.Dismiss();
        service.CheckForNewSettings();
        Assert.Null(service.GetState());
        // Three Media Tags settings new since that baseline, and one main-page setting.
        var path = Path.Combine(f.Core.ConfigRoot, "config-schema-snapshot.json");
        var baseline = JsonConvert.DeserializeObject<ConfigSchemaSnapshot>(File.ReadAllText(path))!;
        var fresh = new[] { "tagLayout", "statusTagsJustAddedDays", "ratingTagsOnNextUp", "devMode" };
        baseline.SettingIds.RemoveAll(fresh.Contains);
        File.WriteAllText(path, JsonConvert.SerializeObject(baseline));
        service.CheckForNewSettings();
        Assert.Equal(fresh.OrderBy(x => x), service.GetState()!.NewSettings.Keys.OrderBy(x => x));
        var body = System.Text.Json.JsonSerializer.Serialize(Assert.IsType<OkObjectResult>(controller.GetWhatsNew()).Value);
        using var json = System.Text.Json.JsonDocument.Parse(body);
        var mediaTags = json.RootElement.GetProperty("mediaTags");
        Assert.Equal("{\"page\":\"JellyfinEnhancedMediaTags\",\"tab\":\"layout\",\"group\":null}", mediaTags.GetProperty("tagLayout").GetRawText());
        Assert.Equal("badges", mediaTags.GetProperty("statusTagsJustAddedDays").GetProperty("tab").GetString());
        Assert.Equal("rating", mediaTags.GetProperty("ratingTagsOnNextUp").GetProperty("group").GetString());
        Assert.False(mediaTags.TryGetProperty("devMode", out _), "main-page settings keep their badges there");
    }

    [Fact]
    public void UpgradingFromTheSeedBaselineLeavesNoPendingSettingWithoutAPlaceToShowIt()
    {
        using var f = new ApiPluginFixture();
        // An existing install (other plugin data on disk) with no snapshot yet falls back to the release seed.
        File.WriteAllText(Path.Combine(f.Core.ConfigRoot, "reviews.json"), "{}");
        var service = new WhatsNewService(f.Core.Paths.Object, f.Core.Logger);
        service.CheckForNewSettings();
        var pending = service.GetState()!.NewSettings.Keys.ToList();
        var locations = service.GetMediaTagsLocations();
        Assert.Contains("tagLayout", pending);
        Assert.Equal(new MediaTagsLocation("badges", null), locations["statusTagsJustAdded"]);
        Assert.Equal(new MediaTagsLocation("groups", "quality"), locations["showResolutionTag"]);
        foreach (var id in new[] { "awardsTagsPosition", "logoTagsPosition", "customTagsPosition" })
            Assert.Equal(new MediaTagsLocation("layout", null), locations[id]);
        using var stream = typeof(Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced).Assembly.GetManifestResourceStream("Jellyfin.Plugin.JellyfinEnhanced.Configuration.configPage.html")!;
        var html = new StreamReader(stream).ReadToEnd();
        foreach (var id in pending)
        {
            Assert.True(html.Contains($"id=\"{id}\"", StringComparison.Ordinal) || locations.ContainsKey(id), $"{id} has a control on the main page or a Media Tags location");
        }
    }
}
