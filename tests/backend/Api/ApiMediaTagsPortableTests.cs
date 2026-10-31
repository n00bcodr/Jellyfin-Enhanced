using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

/// <summary>
/// Media Tags import, export and presets (Helpers/MediaTagsPortable.cs): the versioned documents, field-by-field
/// validation with the save paths' validators, secret exclusion, preset caps and the administrator allowlist.
/// </summary>
[Collection("Plugin singleton")]
public class ApiMediaTagsPortableTests
{
    private static (JellyfinEnhancedController Controller, Guid User, Action<bool> SignIn) Signed(ApiPluginFixture f, bool admin = false)
    {
        var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), f.Core.Paths.Object, f.Core.Logger);
        var controller = ApiAssetTests.Controller(f.Core, maintenance, f.Core.Manager);
        var user = Guid.NewGuid();
        void SignIn(bool asAdmin) => controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = global::JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(user, asAdmin) } };
        SignIn(admin);
        return (controller, user, SignIn);
    }

    private static JsonElement Json(string text) => JsonDocument.Parse(text).RootElement.Clone();

    private static JsonElement Json(JsonNode node) => Json(node.ToJsonString());

    /// <summary>The answer of an action as JSON (the anonymous bodies the endpoints return).</summary>
    private static JsonNode Body(IActionResult result) => JsonNode.Parse(JsonSerializer.Serialize(((ObjectResult)result).Value))!;

    private static JellyfinEnhancedUserSettings Customised() => new()
    {
        QualityTagsEnabled = true,
        RatingTagsEnabled = true,
        AwardsTagsEnabled = true,
        ShowVideoCodecTag = false,
        ShowEditionTag = true,
        EditionTagOrder = 3,
        ShowRuntimeTag = true, ShowAspectRatioTag = true, ShowFrameRateTag = true,
        RuntimeTagOrder = 10, AspectRatioTagOrder = 8, FrameRateTagOrder = 9,
        QualityAudioDisplayMode = "all", QualityVideoCodecDisplayMode = "all", QualityHdrDisplayMode = "all",
        QualityMinimumResolution = "4k", QualityHideSdr = true, StatusTagsScenes = true,
        QualityTagsPosition = "top-right",
        RatingTagsSources = new[] { "imdb", "rtCritic" },
        RatingTagsMinScore = 6.5,
        LanguageTagsStyle = "codes",
        LanguageTagsPriority = new[] { "ja", "en" },
        StatusTagsTrending = false,
        TagLayout = "bands",
        TagLayoutSettingsVersion = 1,
        TagLayouts = new TagLayoutProfiles { Bands = new TagLayoutProfile { Groups = new List<TagLayoutGroupSlot> { new() { Group = "rating", Slot = "bottom" } } } },
        TagGroupOrder = new List<string> { "rating", "quality" },
        TagGroupCaps = new TagGroupCaps { Genre = 2, Quality = 0 },
        TagLabelDensity = "compact",
        TagScale = "larger",
        TagGap = "roomy",
        TagEdgeSpacing = "tight",
        TagShapeOverrides = new TagShapeOverrides { Landscape = new TagShapeLook { Layout = "minimal", Density = "compact" } },
        TagStylePreset = "glass",
        UseNativePosterTags = false,
    };

    [Fact]
    public void ExportThenImportGivesIdenticalSettings()
    {
        using var f = new ApiPluginFixture();
        var (controller, user, _) = Signed(f);
        var id = user.ToString("N");
        var source = Customised();
        f.Core.Manager.SaveUserConfiguration(id, "settings.json", source);

        var exported = (JsonObject)Body(controller.ExportUserMediaTags(id));
        Assert.Equal(1, (int)exported["v"]!);
        Assert.Equal("je-media-tags-user", (string?)exported["kind"]);
        var settings = exported["settings"]!.AsObject();
        Assert.Equal(86, MediaTagsPortable.UserFields.Count);
        Assert.Equal(MediaTagsPortable.UserFields, settings.Select(p => p.Key));

        // The same document again changes nothing and skips nothing.
        var same = Body(controller.PreviewUserMediaTags(id, Json(exported)));
        Assert.Empty(same["changes"]!.AsArray());
        Assert.Empty(same["skipped"]!.AsArray());

        // Imported into a fresh user, its settings export identically.
        var other = Guid.NewGuid().ToString("N");
        controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = global::JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(Guid.ParseExact(other, "N")) } };
        f.Core.Manager.SaveUserConfiguration(other, "settings.json", new JellyfinEnhancedUserSettings { DisplayLanguage = "fr" });
        var preview = Body(controller.PreviewUserMediaTags(other, Json(exported)));
        Assert.NotEmpty(preview["changes"]!.AsArray());
        Assert.Empty(preview["skipped"]!.AsArray());
        // What the client does: write the changed fields into its document and save it through the settings save path.
        var target = JsonNode.Parse(JsonSerializer.Serialize(f.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(other, "settings.json")))!.AsObject();
        foreach (var change in preview["changes"]!.AsArray()) target[(string)change!["field"]!] = change["to"]?.DeepClone();
        var bound = JsonSerializer.Deserialize<JellyfinEnhancedUserSettings>(target.ToJsonString(), new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
        Assert.IsType<OkObjectResult>(controller.SaveUserSettingsSettings(other, bound));
        var again = (JsonObject)Body(controller.ExportUserMediaTags(other));
        Assert.True(JsonNode.DeepEquals(exported, again), $"{exported.ToJsonString()}\n{again.ToJsonString()}");
        Assert.Equal("fr", f.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(other, "settings.json").DisplayLanguage);
    }

    [Fact]
    public void UnrelatedUserSaveAndPortableRoundTripKeepSingleChipCaps()
    {
        using var f = new ApiPluginFixture();
        var (controller, user, _) = Signed(f);
        var id = user.ToString("N");
        var source = new JellyfinEnhancedUserSettings { TagLayoutSettingsVersion = 1,
            TagGroupCaps = new() { Status = 9, AgeRating = 0, Genre = 2 } };
        f.Core.Manager.SaveUserConfiguration(id, "settings.json", source);
        source.DisplayLanguage = "fr";
        Assert.IsType<OkObjectResult>(controller.SaveUserSettingsSettings(id, source));
        var saved = f.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(id, "settings.json");
        Assert.Equal(9, saved.TagGroupCaps!.Status);
        Assert.Equal(0, saved.TagGroupCaps.AgeRating);
        Assert.Equal(2, saved.TagGroupCaps.Genre);
        var exported = Body(controller.ExportUserMediaTags(id));
        Assert.Equal(9, (int)exported["settings"]!["TagGroupCaps"]!["Status"]!);
        Assert.Equal(0, (int)exported["settings"]!["TagGroupCaps"]!["AgeRating"]!);
        var preview = MediaTagsPortable.PreviewUser(Json(exported), new JellyfinEnhancedUserSettings());
        Assert.Empty(preview.Skipped);
        var target = JsonNode.Parse(JsonSerializer.Serialize(new JellyfinEnhancedUserSettings()))!.AsObject();
        // Apply exactly the exported field values through the same import validator and save path.
        foreach (var field in exported["settings"]!.AsObject()) target[field.Key] = field.Value?.DeepClone();
        var imported = JsonSerializer.Deserialize<JellyfinEnhancedUserSettings>(target.ToJsonString())!;
        Assert.True(MediaTagsPortable.TryNormalizeUser(imported, out var error), error);
        Assert.True(JsonNode.DeepEquals(exported, MediaTagsPortable.ExportUser(imported)));
    }

    [Fact]
    public void AdminExportImportAndGenreEditKeepStoredSingleChipCaps()
    {
        using var f = new ApiPluginFixture();
        var (controller, _, _) = Signed(f, true);
        f.Plugin.Configuration.TagGroupCaps = new() { Status = 9, AgeRating = 0, Genre = 2 };
        var exported = Body(controller.ExportAdminMediaTags());
        var same = Body(controller.PreviewAdminMediaTags(Json(exported)));
        Assert.Empty(same["skipped"]!.AsArray());
        Assert.Empty(same["changes"]!.AsArray());
        f.Plugin.Configuration.TagGroupCaps = null;
        var preview = Body(controller.PreviewAdminMediaTags(Json(exported)));
        Assert.Empty(preview["skipped"]!.AsArray());
        var change = preview["changes"]!.AsArray().Single(c => (string?)c!["field"] == "TagGroupCaps")!;
        Assert.IsType<OkObjectResult>(controller.PatchConfiguration(new() { Changes = new() { ["TagGroupCaps"] = Json(change["to"]!) } }));
        Assert.True(JsonNode.DeepEquals(exported, Body(controller.ExportAdminMediaTags())));
        Assert.IsType<OkObjectResult>(controller.PatchConfiguration(new() { Changes = new() {
            ["TagGroupCaps"] = Json("{\"Status\":9,\"AgeRating\":0,\"Genre\":3}") } }));
        Assert.Equal(9, f.Plugin.Configuration.TagGroupCaps!.Status);
        Assert.Equal(0, f.Plugin.Configuration.TagGroupCaps.AgeRating);
        Assert.Equal(3, f.Plugin.Configuration.TagGroupCaps.Genre);
    }

    [Fact]
    public void IntegratedQualityFieldsUseTheSameNormalisationAndPreviewContracts()
    {
        var values = new JellyfinEnhancedUserSettings
        {
            QualityAudioDisplayMode = " ALL ", QualityVideoCodecDisplayMode = "invalid", QualityHdrDisplayMode = "ALL",
            QualityMinimumResolution = " 4K ", QualityHideSdr = true,
            ShowRuntimeTag = true, ShowAspectRatioTag = true, ShowFrameRateTag = false,
            RuntimeTagOrder = 10, AspectRatioTagOrder = 9, FrameRateTagOrder = 8, StatusTagsScenes = true,
        };
        Assert.True(MediaTagsPortable.TryNormalizeUser(values, out var error), error);
        Assert.Equal("all", values.QualityAudioDisplayMode);
        Assert.Equal("highest", values.QualityVideoCodecDisplayMode);
        Assert.Equal("all", values.QualityHdrDisplayMode);
        Assert.Equal("4k", values.QualityMinimumResolution);
        var exported = MediaTagsPortable.ExportUser(values);
        var preview = MediaTagsPortable.PreviewUser(Json(exported), new JellyfinEnhancedUserSettings());
        Assert.Empty(preview.Skipped);
        foreach (var field in new[] { "QualityAudioDisplayMode", "QualityVideoCodecDisplayMode", "QualityHdrDisplayMode", "QualityMinimumResolution", "QualityHideSdr", "ShowRuntimeTag", "ShowAspectRatioTag", "ShowFrameRateTag", "RuntimeTagOrder", "AspectRatioTagOrder", "FrameRateTagOrder", "StatusTagsScenes" })
            Assert.True(JsonNode.DeepEquals(exported["settings"]![field], preview.Imported[field]), field);
        var invalid = MediaTagsPortable.PreviewUser(Json("""
            {"v":1,"kind":"je-media-tags-user","settings":{"QualityAudioDisplayMode":"invalid","QualityVideoCodecDisplayMode":"invalid","QualityHdrDisplayMode":"invalid","QualityMinimumResolution":"8k","QualityHideSdr":"yes","ShowRuntimeTag":"yes","RuntimeTagOrder":100}}
            """), values);
        Assert.Equal(7, invalid.Skipped.Count);
        Assert.All(invalid.Skipped, skip => Assert.Equal("invalid", skip.Reason));
        Assert.Empty(invalid.Imported);
        var nullable = new JellyfinEnhancedUserSettings();
        Assert.True(MediaTagsPortable.TryNormalizeUser(nullable, out _));
        foreach (var field in new[] { "QualityAudioDisplayMode", "QualityVideoCodecDisplayMode", "QualityHdrDisplayMode", "QualityMinimumResolution", "QualityHideSdr", "ShowRuntimeTag", "ShowAspectRatioTag", "ShowFrameRateTag", "RuntimeTagOrder", "AspectRatioTagOrder", "FrameRateTagOrder" })
            Assert.Null(typeof(JellyfinEnhancedUserSettings).GetProperty(field)!.GetValue(nullable));
    }

    [Fact]
    public void InvalidUnknownAndSecretFieldsAreReportedAndNeverApplied()
    {
        using var f = new ApiPluginFixture();
        var (controller, user, _) = Signed(f);
        var id = user.ToString("N");
        f.Core.Manager.SaveUserConfiguration(id, "settings.json", new JellyfinEnhancedUserSettings { TagLayoutSettingsVersion = 1 });
        var preview = Body(controller.PreviewUserMediaTags(id, Json("""
            {"v":1,"kind":"je-media-tags-user","settings":{
              "QualityTagsEnabled":true,
              "Foo":1,
              "AutoPauseEnabled":true,
              "TagLayout":"spiral",
              "TagGroupCaps":{"Quality":99},
              "QualityTagsPosition":"middle",
              "RatingTagsMinScore":"high",
              "RatingTagsSources":["imdb","nope"],
              "LanguageTagsPriority":["Klingon"],
              "TagStylePreset":"neon",
              "ResolutionTagOrder":500,
              "CustomTagRuleKey":"abc",
              "MdblistApiKey":"k",
              "TagScale":null
            }}
            """)));
        var changes = preview["changes"]!.AsArray().Select(c => (string)c!["field"]!).ToList();
        Assert.Equal(new[] { "QualityTagsEnabled" }, changes);
        var skipped = preview["skipped"]!.AsArray().ToDictionary(s => (string)s!["field"]!, s => (string)s!["reason"]!);
        Assert.Equal("unknown", skipped["Foo"]);
        Assert.Equal("unknown", skipped["AutoPauseEnabled"]);
        foreach (var field in new[] { "TagLayout", "TagGroupCaps", "QualityTagsPosition", "RatingTagsMinScore", "RatingTagsSources", "LanguageTagsPriority", "TagStylePreset", "ResolutionTagOrder" })
            Assert.Equal("invalid", skipped[field]);
        Assert.Equal("secret", skipped["CustomTagRuleKey"]);
        Assert.Equal("secret", skipped["MdblistApiKey"]);
        Assert.False(skipped.ContainsKey("TagScale"), "null keeps its meaning: follow the administrator");
        Assert.Equal(new[] { "QualityTagsEnabled", "TagScale" }, preview["imported"]!.AsObject().Select(p => p.Key));
        // A preview writes nothing.
        Assert.False(f.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(id, "settings.json").QualityTagsEnabled);
    }

    [Theory]
    [InlineData("[]", "not-object")]
    [InlineData("{\"v\":1,\"kind\":\"something\",\"settings\":{}}", "kind")]
    [InlineData("{\"v\":1,\"kind\":\"je-media-tags-admin\",\"settings\":{}}", "kind")]
    [InlineData("{\"kind\":\"je-media-tags-user\",\"settings\":{}}", "version")]
    [InlineData("{\"v\":\"1\",\"kind\":\"je-media-tags-user\",\"settings\":{}}", "version")]
    [InlineData("{\"v\":2,\"kind\":\"je-media-tags-user\",\"settings\":{}}", "newer")]
    [InlineData("{\"v\":1,\"kind\":\"je-media-tags-user\",\"settings\":[]}", "settings")]
    public void DocumentsRefusedAsAWholeSayWhy(string document, string error)
    {
        using var f = new ApiPluginFixture();
        var (controller, user, _) = Signed(f);
        var result = Assert.IsType<BadRequestObjectResult>(controller.PreviewUserMediaTags(user.ToString("N"), Json(document)));
        Assert.Equal(error, (string?)Body(result)["error"]);
    }

    [Fact]
    public void UsersCannotReadOrPreviewAnotherUsersSettings()
    {
        using var f = new ApiPluginFixture();
        var (controller, _, _) = Signed(f);
        var other = Guid.NewGuid().ToString("N");
        Assert.IsType<ForbidResult>(controller.ExportUserMediaTags(other));
        Assert.IsType<ForbidResult>(controller.PreviewUserMediaTags(other, Json("{\"v\":1,\"kind\":\"je-media-tags-user\",\"settings\":{}}")));
        Assert.IsType<ForbidResult>(controller.GetMediaTagsPresets(other));
        Assert.IsType<ForbidResult>(controller.SaveMediaTagsPreset(other, Json("{\"v\":1,\"kind\":\"je-media-tags-preset\",\"name\":\"x\",\"settings\":{\"QualityTagsEnabled\":true}}")));
        Assert.IsType<ForbidResult>(controller.DeleteMediaTagsPreset(other, "abc"));
    }

    [Fact]
    public void SavedPresetsAreValidatedCappedAndDeletable()
    {
        using var f = new ApiPluginFixture();
        var (controller, user, _) = Signed(f);
        var id = user.ToString("N");
        // A user export with a name is a preset; unknown and invalid fields are dropped and reported.
        var saved = Body(controller.SaveMediaTagsPreset(id, Json("""
            {"v":1,"kind":"je-media-tags-user","name":"  Mine ","description":"Tidy","settings":{"TagLayout":"caption","TagScale":"giant","Foo":true}}
            """)));
        Assert.Equal("Mine", (string?)saved["preset"]!["name"]);
        Assert.Equal("{\"TagLayout\":\"caption\"}", saved["preset"]!["settings"]!.ToJsonString());
        Assert.Equal(new[] { "TagScale", "Foo" }, saved["skipped"]!.AsArray().Select(s => (string)s!["field"]!));
        var presetId = (string)saved["preset"]!["id"]!;

        foreach (var (document, error) in new[]
        {
            ("{\"v\":1,\"kind\":\"je-media-tags-preset\",\"settings\":{\"TagLayout\":\"bands\"}}", "name"),
            ($"{{\"v\":1,\"kind\":\"je-media-tags-preset\",\"name\":\"{new string('n', 61)}\",\"settings\":{{\"TagLayout\":\"bands\"}}}}", "name"),
            ($"{{\"v\":1,\"kind\":\"je-media-tags-preset\",\"name\":\"x\",\"description\":\"{new string('d', 241)}\",\"settings\":{{\"TagLayout\":\"bands\"}}}}", "description"),
            ("{\"v\":1,\"kind\":\"je-media-tags-preset\",\"name\":\"x\",\"settings\":{\"Foo\":1}}", "empty"),
        })
        {
            Assert.Equal(error, (string?)Body(Assert.IsType<BadRequestObjectResult>(controller.SaveMediaTagsPreset(id, Json(document))))["error"]);
        }

        for (var i = 2; i <= MediaTagsPortable.MaxUserPresets; i++)
            Assert.IsType<OkObjectResult>(controller.SaveMediaTagsPreset(id, Json($"{{\"v\":1,\"kind\":\"je-media-tags-preset\",\"name\":\"P{i}\",\"settings\":{{\"TagGap\":\"tight\"}}}}")));
        var full = Body(Assert.IsType<BadRequestObjectResult>(controller.SaveMediaTagsPreset(id, Json("{\"v\":1,\"kind\":\"je-media-tags-preset\",\"name\":\"P11\",\"settings\":{\"TagGap\":\"tight\"}}"))));
        Assert.Equal("full", (string?)full["error"]);
        Assert.Equal(MediaTagsPortable.MaxUserPresets, (int)full["max"]!);

        var list = Body(controller.GetMediaTagsPresets(id));
        Assert.Equal(MediaTagsPortable.MaxUserPresets, list["mine"]!.AsArray().Count);
        Assert.Equal("Mine", (string?)list["mine"]![0]!["name"]);

        Assert.IsType<OkObjectResult>(controller.DeleteMediaTagsPreset(id, presetId));
        Assert.IsType<NotFoundObjectResult>(controller.DeleteMediaTagsPreset(id, presetId));
        Assert.Equal(MediaTagsPortable.MaxUserPresets - 1, Body(controller.GetMediaTagsPresets(id))["mine"]!.AsArray().Count);
    }

    [Fact]
    public void BuiltInPresetsShipValidAndAreListed()
    {
        using var f = new ApiPluginFixture();
        var assembly = typeof(MediaTagsPortable).Assembly;
        var names = assembly.GetManifestResourceNames().Where(n => n.StartsWith("Jellyfin.Plugin.JellyfinEnhanced.Assets.TagPresets.", StringComparison.Ordinal)).ToList();
        Assert.Equal(3, names.Count);
        foreach (var name in names)
        {
            using var reader = new StreamReader(assembly.GetManifestResourceStream(name)!);
            var element = Json(reader.ReadToEnd());
            Assert.True(MediaTagsPortable.TryReadPreset(element, null, out var preset, out var skipped, out var error), $"{name}: {error}");
            Assert.Empty(skipped);
            // Shipped exactly as the server normalises them, so applying one never reports a fix-up.
            Assert.True(JsonNode.DeepEquals(JsonNode.Parse(element.GetRawText())!["settings"], preset["settings"]), name);
        }

        Assert.Equal(new[] { "cinephile", "minimal", "kids" }, MediaTagsPortable.BuiltInPresets.Select(p => (string)p["id"]!));
        var (controller, user, _) = Signed(f);
        var list = Body(controller.GetMediaTagsPresets(user.ToString("N")));
        Assert.Equal(3, list["builtIn"]!.AsArray().Count);
        Assert.Empty(list["offered"]!.AsArray());
        Assert.Empty(list["mine"]!.AsArray());
    }

    [Fact]
    public void AdminExportLeavesSecretsAndSignalsOut()
    {
        using var f = new ApiPluginFixture();
        var (controller, _, signIn) = Signed(f, admin: true);
        var config = f.Plugin.Configuration;
        config.CustomTagRuleKey = "rule-key-secret";
        config.MdblistApiKey = "mdblist-secret";
        config.JellyseerrApiKey = "seerr-secret";
        config.LeavingSoonMaintainerrApiKey = "maintainerr-secret";
        config.CustomTagRules = new List<CustomTagRule> { new() { Match = "tag", Value = "4K Remaster", Label = "Remaster" } };
        config.AwardsTagsImdbList = "ls012345";
        config.LogoTagsMovieMode = "studio";
        config.StatusTagsJustAddedDays = 9;
        config.ClearLocalStorageTimestamp = 123;

        var text = Body(controller.ExportAdminMediaTags()).ToJsonString();
        var document = JsonNode.Parse(text)!;
        Assert.Equal("je-media-tags-admin", (string?)document["kind"]);
        var settings = document["settings"]!.AsObject();
        foreach (var secret in new[] { "rule-key-secret", "mdblist-secret", "seerr-secret", "maintainerr-secret" }) Assert.DoesNotContain(secret, text);
        Assert.False(settings.ContainsKey("CustomTagRuleKey"));
        Assert.False(settings.ContainsKey("ClearLocalStorageTimestamp"));
        Assert.Equal(MediaTagsPortable.AdminFields(MediaTagsPageFields.Allowed), settings.Select(p => p.Key));
        Assert.Equal(MediaTagsPageFields.Allowed.Count - 2, settings.Count);
        Assert.Equal("Remaster", (string?)settings["CustomTagRules"]![0]!["Label"]);
        Assert.Equal("ls012345", (string?)settings["AwardsTagsImdbList"]);
        Assert.Equal("studio", (string?)settings["LogoTagsMovieMode"]);
        Assert.Equal(9, (int)settings["StatusTagsJustAddedDays"]!);
        Assert.True(settings.ContainsKey("TagStyleOverrides"));
        Assert.True(settings.ContainsKey("TagOfferedPresets"));

        signIn(false);
        Assert.IsType<ForbidResult>(controller.ExportAdminMediaTags());
        Assert.IsType<ForbidResult>(controller.PreviewAdminMediaTags(Json(text)));
    }

    [Fact]
    public void AdminImportGoesThroughTheAllowlistAndTheLockedPatch()
    {
        using var f = new ApiPluginFixture();
        var (controller, _, _) = Signed(f, admin: true);
        var config = f.Plugin.Configuration;
        config.TagLayout = "bands";
        config.StatusTagsJustAddedDays = 5;
        config.CustomTagRuleKey = "keep-me";
        var exported = Body(controller.ExportAdminMediaTags());
        var again = Body(controller.PreviewAdminMediaTags(Json(exported)));
        Assert.Empty(again["changes"]!.AsArray());
        Assert.Empty(again["skipped"]!.AsArray());

        // Someone changes things; the export brings them back.
        config.TagLayout = "minimal";
        config.StatusTagsJustAddedDays = 30;
        var document = exported.DeepClone();
        var settings = document["settings"]!.AsObject();
        settings["CustomTagRuleKey"] = "stolen";
        settings["JellyseerrApiKey"] = "x";
        settings["DevMode"] = true;
        settings["ClearLocalStorageTimestamp"] = 99;
        settings["TagCacheServerMode"] = "yes";
        settings["StatusTagsNewReleaseDays"] = 4000;
        var preview = Body(controller.PreviewAdminMediaTags(Json(document)));
        var skipped = preview["skipped"]!.AsArray().ToDictionary(s => (string)s!["field"]!, s => (string)s!["reason"]!);
        Assert.Equal("secret", skipped["CustomTagRuleKey"]);
        Assert.Equal("secret", skipped["JellyseerrApiKey"]);
        Assert.Equal("unknown", skipped["DevMode"]);
        Assert.Equal("signal", skipped["ClearLocalStorageTimestamp"]);
        Assert.Equal("invalid", skipped["TagCacheServerMode"]);
        Assert.Equal("invalid", skipped["StatusTagsNewReleaseDays"]);
        var changes = preview["changes"]!.AsArray();
        Assert.Equal(new[] { "StatusTagsJustAddedDays", "TagLayout" }, changes.Select(c => (string)c!["field"]!));

        // The page applies the changes through the field patch, expecting the values it read.
        var request = new JellyfinEnhancedController.ConfigurationPatchRequest
        {
            Changes = changes.ToDictionary(c => (string)c!["field"]!, c => Json(c!["to"]!.ToJsonString())),
            Expected = changes.ToDictionary(c => (string)c!["field"]!, c => Json(c!["from"]!.ToJsonString())),
        };
        Assert.IsType<OkObjectResult>(controller.PatchConfiguration(request));
        Assert.Equal("bands", f.Plugin.Configuration.TagLayout);
        Assert.Equal(5, f.Plugin.Configuration.StatusTagsJustAddedDays);
        Assert.Equal("keep-me", f.Plugin.Configuration.CustomTagRuleKey);
        Assert.False(f.Plugin.Configuration.DevMode);
        Assert.True(JsonNode.DeepEquals(exported, Body(controller.ExportAdminMediaTags())));

        // Applied again by a page that read the old values: another administrator's change wins nothing silently.
        f.Plugin.Configuration.TagLayout = "caption";
        Assert.IsType<ConflictObjectResult>(controller.PatchConfiguration(request));
        Assert.Equal("caption", f.Plugin.Configuration.TagLayout);
    }

    [Fact]
    public void GenreLabelColoursSurviveAnAdminExportAndImport()
    {
        using var f = new ApiPluginFixture();
        var (controller, _, _) = Signed(f, admin: true);
        // Three genres in different colours and Other, as tests/fixtures/genre-styles.json stores them.
        const string styles = "{\"v\":2,\"preset\":\"default\",\"groups\":{\"genre\":{\"border\":\"rgba(255, 255, 255, 0.6)\"}},\"labels\":{\"genre:animation\":{\"background\":\"rgba(30, 136, 229, 1)\"},\"genre:comedy\":{\"background\":\"rgba(255, 209, 102, 1)\",\"text\":\"rgba(17, 17, 17, 1)\"},\"genre:horror\":{\"background\":\"rgba(198, 40, 40, 1)\"},\"genre:other\":{\"background\":\"rgba(84, 110, 122, 1)\"}}}";
        Assert.IsType<OkObjectResult>(controller.PatchConfiguration(new JellyfinEnhancedController.ConfigurationPatchRequest { Changes = new Dictionary<string, JsonElement> { ["TagStyleOverrides"] = Json(JsonSerializer.Serialize(styles)) } }));
        Assert.Equal(styles, f.Plugin.Configuration.TagStyleOverrides);
        var exported = Body(controller.ExportAdminMediaTags());
        Assert.Equal(styles, (string?)exported["settings"]!["TagStyleOverrides"]);

        // Cleared, then the export brings every genre colour back through the page's patch.
        f.Plugin.Configuration.TagStyleOverrides = string.Empty;
        var preview = Body(controller.PreviewAdminMediaTags(Json(exported)));
        Assert.Empty(preview["skipped"]!.AsArray());
        var change = Assert.Single(preview["changes"]!.AsArray());
        Assert.Equal("TagStyleOverrides", (string?)change!["field"]);
        Assert.IsType<OkObjectResult>(controller.PatchConfiguration(new JellyfinEnhancedController.ConfigurationPatchRequest
        {
            Changes = new Dictionary<string, JsonElement> { ["TagStyleOverrides"] = Json(change["to"]!.ToJsonString()) },
            Expected = new Dictionary<string, JsonElement> { ["TagStyleOverrides"] = Json(change["from"]!.ToJsonString()) },
        }));
        Assert.Equal(styles, f.Plugin.Configuration.TagStyleOverrides);
        var set = Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.TagStyleSet.Parse(f.Plugin.Configuration.TagStyleOverrides);
        Assert.Equal("rgba(198, 40, 40, 1)", set.Resolve("genre", "horror").Background);
        Assert.Equal("rgba(17, 17, 17, 1)", set.Resolve("genre", "comedy").Text);
        Assert.Equal("rgba(84, 110, 122, 1)", set.Resolve("genre", "other").Background);
        Assert.Equal("rgba(255, 255, 255, 0.6)", set.Resolve("genre", "drama").Border);
        Assert.True(JsonNode.DeepEquals(exported, Body(controller.ExportAdminMediaTags())));

        // An export naming a genre label this version does not know is skipped as a whole value.
        var unknown = exported.DeepClone();
        unknown["settings"]!["TagStyleOverrides"] = "{\"v\":2,\"labels\":{\"genre:sci-fi\":{\"text\":\"#ffffff\"}}}";
        f.Plugin.Configuration.TagStyleOverrides = string.Empty;
        var refused = Body(controller.PreviewAdminMediaTags(Json(unknown)));
        Assert.Equal("invalid", (string?)Assert.Single(refused["skipped"]!.AsArray())!["reason"]);
    }

    [Fact]
    public void AStoredConfigurationExportsAndImportsWithoutLosses()
    {
        using var f = new ApiPluginFixture();
        var (controller, _, _) = Signed(f, admin: true);
        // As Jellyfin's XML configuration reads them back: cleared lists are empty lists, not null.
        f.Plugin.Configuration.TagGroupOrder = new List<string>();
        f.Plugin.Configuration.TagLookRules = new List<TagLookRule>();
        f.Plugin.Configuration.CustomTagRules = new List<CustomTagRule>();
        var exported = Body(controller.ExportAdminMediaTags());
        var preview = Body(controller.PreviewAdminMediaTags(Json(exported)));
        Assert.Empty(preview["skipped"]!.AsArray());
        Assert.Empty(preview["changes"]!.AsArray());
        Assert.Equal(MediaTagsPortable.AdminFields(MediaTagsPageFields.Allowed).Count, preview["imported"]!.AsObject().Count);
        // The page can write the empty order back unchanged.
        Assert.IsType<OkObjectResult>(controller.PatchConfiguration(new JellyfinEnhancedController.ConfigurationPatchRequest { Changes = new Dictionary<string, JsonElement> { ["TagGroupOrder"] = Json("[]") } }));
    }

    [Fact]
    public void OfferedPresetsAreValidatedCappedAndShownToUsers()
    {
        using var f = new ApiPluginFixture();
        var (controller, user, _) = Signed(f, admin: true);
        static string Preset(string id, string settings = "{\"TagLayout\":\"bands\"}") => $"{{\"v\":1,\"kind\":\"je-media-tags-preset\",\"id\":\"{id}\",\"name\":\"{id}\",\"description\":\"\",\"settings\":{settings}}}";
        Assert.True(MediaTagsPortable.TryNormalizeOfferedPresets(string.Empty, out var none, out _));
        Assert.Equal(string.Empty, none);
        Assert.True(MediaTagsPortable.TryNormalizeOfferedPresets($"[{Preset("family")}]", out var one, out var error), error);

        var refused = new[]
        {
            "{}",
            "not json",
            $"[{string.Join(",", Enumerable.Range(0, MediaTagsPortable.MaxOfferedPresets + 1).Select(i => Preset($"p{i}")))}]",
            $"[{Preset("same")},{Preset("same")}]",
            $"[{Preset("Bad Id")}]",
            $"[{Preset("x", "{\"TagLayout\":\"spiral\"}")}]",
            $"[{Preset("x", "{\"CustomTagRuleKey\":\"k\"}")}]",
        };
        foreach (var text in refused) Assert.False(MediaTagsPortable.TryNormalizeOfferedPresets(text, out _, out _), text);
        Assert.True(MediaTagsPortable.TryNormalizeOfferedPresets($"[{string.Join(",", Enumerable.Range(0, MediaTagsPortable.MaxOfferedPresets).Select(i => Preset($"p{i}")))}]", out _, out _));

        // Through the page's patch: refused values write nothing; an accepted one shows in every user's list.
        Assert.IsType<BadRequestObjectResult>(controller.PatchConfiguration(new JellyfinEnhancedController.ConfigurationPatchRequest { Changes = new Dictionary<string, JsonElement> { ["TagOfferedPresets"] = Json(JsonSerializer.Serialize(refused[3])) } }));
        Assert.Equal(string.Empty, f.Plugin.Configuration.TagOfferedPresets);
        Assert.IsType<OkObjectResult>(controller.PatchConfiguration(new JellyfinEnhancedController.ConfigurationPatchRequest { Changes = new Dictionary<string, JsonElement> { ["TagOfferedPresets"] = Json(JsonSerializer.Serialize(one)) } }));
        var offered = Body(controller.GetMediaTagsPresets(user.ToString("N")))["offered"]!.AsArray();
        Assert.Equal("family", (string?)Assert.Single(offered)!["id"]);
    }

    [Fact]
    public void OfferedPresetsAreCappedOnTheirCanonicalStoredText()
    {
        using var f = new ApiPluginFixture();
        var (controller, user, _) = Signed(f, admin: true);
        const int cap = MediaTagsPortable.MaxOfferedPresetsBytes;
        // Every field of a user document, as presets are offered from an export.
        var settings = MediaTagsPortable.ExportUser(Customised())["settings"]!.ToJsonString();
        // Sent unescaped ("<" is one byte); stored escaped ("\u003C", six bytes).
        var relaxed = new JsonSerializerOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
        static int Bytes(string text) => Encoding.UTF8.GetByteCount(text);
        // Names of "<" too: sent as 60 bytes, stored as 360.
        var name = new string('<', MediaTagsPortable.MaxNameLength);
        string Preset(int i, string description) => new JsonObject
        {
            ["v"] = 1, ["kind"] = "je-media-tags-preset", ["id"] = $"p{i}", ["name"] = name, ["description"] = description,
            ["settings"] = JsonNode.Parse(settings),
        }.ToJsonString(relaxed);
        string List(IReadOnlyList<string> descriptions) => $"[{string.Join(",", descriptions.Select((d, i) => Preset(i, d)))}]";
        int? Canonical(IReadOnlyList<string> descriptions)
            => MediaTagsPortable.TryNormalizeOfferedPresets(List(descriptions), out var text, out _) ? Bytes(text) : null;

        // The fewest presets whose canonical text reaches the cap with escaped descriptions, still sent under it.
        var count = Enumerable.Range(1, MediaTagsPortable.MaxOfferedPresets).First(n =>
            Bytes(List(Enumerable.Repeat(new string('<', MediaTagsPortable.MaxDescriptionLength), n).ToList())) <= cap
            && Canonical(Enumerable.Repeat(string.Empty, n).ToList()) + (n * MediaTagsPortable.MaxDescriptionLength * 6) >= cap);
        var plain = Enumerable.Repeat(string.Empty, count).ToList();
        // Fill descriptions with "<" (six stored bytes each), then letters (one byte), to exactly the cap.
        var missing = cap - Canonical(plain)!.Value;
        Assert.True(missing >= 0, $"{count} presets are over the cap without descriptions");
        var descriptions = new List<string>();
        foreach (var _ in plain)
        {
            var escaped = Math.Min(MediaTagsPortable.MaxDescriptionLength, missing / 6);
            missing -= escaped * 6;
            var letters = Math.Min(MediaTagsPortable.MaxDescriptionLength - escaped, missing);
            missing -= letters;
            descriptions.Add(new string('<', escaped) + new string('a', letters));
        }

        Assert.Equal(0, missing);
        var atCap = List(descriptions);
        Assert.True(MediaTagsPortable.TryNormalizeOfferedPresets(atCap, out var stored, out var refusal), refusal);
        Assert.Equal(cap, Bytes(stored));
        Assert.True(Bytes(atCap) < cap * 0.8, "sent well under the cap");

        // One more byte once normalised: refused, saying why, although the text as sent is far under the cap.
        var letter = descriptions.FindIndex(d => d.Length < MediaTagsPortable.MaxDescriptionLength);
        var over = descriptions.ToList();
        over[letter] += "a";
        var overText = List(over);
        Assert.True(Bytes(overText) < cap);
        Assert.False(MediaTagsPortable.TryNormalizeOfferedPresets(overText, out var none, out var error));
        Assert.Equal(string.Empty, none);
        Assert.Equal($"larger than {cap} bytes once normalised ({cap + 1} bytes); offer fewer or shorter presets", error);
        // Too large as sent: refused before it is read.
        Assert.False(MediaTagsPortable.TryNormalizeOfferedPresets($"[{new string(' ', cap)}]", out _, out var sentError));
        Assert.Equal($"larger than {cap} bytes", sentError);

        // The page's patch: the over-cap value writes nothing and names the field.
        var refused = controller.PatchConfiguration(new JellyfinEnhancedController.ConfigurationPatchRequest { Changes = new Dictionary<string, JsonElement> { ["TagOfferedPresets"] = Json(JsonSerializer.Serialize(overText)) } });
        Assert.Contains("once normalised", JsonSerializer.Serialize(((ObjectResult)refused).Value), StringComparison.Ordinal);
        Assert.IsType<BadRequestObjectResult>(refused);
        Assert.Equal(string.Empty, f.Plugin.Configuration.TagOfferedPresets);

        // The value at the cap is stored canonically and round-trips: normalised again unchanged, exported,
        // previewed with nothing skipped or changed, and shown to users.
        Assert.IsType<OkObjectResult>(controller.PatchConfiguration(new JellyfinEnhancedController.ConfigurationPatchRequest { Changes = new Dictionary<string, JsonElement> { ["TagOfferedPresets"] = Json(JsonSerializer.Serialize(atCap)) } }));
        Assert.Equal(stored, f.Plugin.Configuration.TagOfferedPresets);
        Assert.True(MediaTagsPortable.TryNormalizeOfferedPresets(stored, out var again, out var againError), againError);
        Assert.Equal(stored, again);
        var exported = Body(controller.ExportAdminMediaTags());
        Assert.Equal(stored, (string?)exported["settings"]!["TagOfferedPresets"]);
        var preview = Body(controller.PreviewAdminMediaTags(Json(exported)));
        Assert.Empty(preview["skipped"]!.AsArray());
        Assert.Empty(preview["changes"]!.AsArray());
        Assert.Equal(count, Body(controller.GetMediaTagsPresets(user.ToString("N")))["offered"]!.AsArray().Count);
    }

    [Fact]
    public void EveryCredentialFieldIsReportedAsASecret()
    {
        using var f = new ApiPluginFixture();
        var (controller, user, signIn) = Signed(f);
        var id = user.ToString("N");
        // Every configuration property named like a credential (keys, tokens, passwords, secrets), and the
        // Sonarr/Radarr instance lists that carry each instance's API key.
        var credential = new Regex("(Key|KEY|Token|Password|Secret|Instances)$");
        var fields = typeof(PluginConfiguration).GetProperties().Concat(typeof(JellyfinEnhancedUserSettings).GetProperties())
            .Select(p => p.Name).Where(n => credential.IsMatch(n)).Distinct().OrderBy(n => n, StringComparer.Ordinal).ToList();
        Assert.Contains("TMDB_API_KEY", fields);
        Assert.Equal(fields, MediaTagsPortable.Secrets.OrderBy(n => n, StringComparer.Ordinal));
        foreach (var field in fields) Assert.True(MediaTagsPortable.IsSecret(field), field);
        // Other spellings of a credential, from a hand-edited or newer document.
        foreach (var field in new[] { "tmdb_api_key", "Other-Api-Key", "AuthToken", "AdminPassword", "ClientSecretValue", "leavingsoonmaintainerrapikey", "Leaving-Soon-Maintainerr-Api-Key" })
            Assert.True(MediaTagsPortable.IsSecret(field), field);
        // No page field is one: they all export.
        Assert.Equal(new[] { "LeavingSoonMaintainerrApiKey" }, MediaTagsPageFields.Allowed.Where(MediaTagsPortable.IsSecret));

        // Both previews report every one as a secret, never as unknown, and read none of them.
        var settings = new JsonObject { ["TagGap"] = "roomy" };
        foreach (var field in fields.Concat(new[] { "leavingsoonmaintainerrapikey", "Leaving-Soon-Maintainerr-Api-Key" })) settings[field] = "x";
        f.Core.Manager.SaveUserConfiguration(id, "settings.json", new JellyfinEnhancedUserSettings { TagLayoutSettingsVersion = 1 });
        var userPreview = Body(controller.PreviewUserMediaTags(id, Json(new JsonObject { ["v"] = 1, ["kind"] = "je-media-tags-user", ["settings"] = settings.DeepClone() })));
        signIn(true);
        var adminPreview = Body(controller.PreviewAdminMediaTags(Json(new JsonObject { ["v"] = 1, ["kind"] = "je-media-tags-admin", ["settings"] = settings.DeepClone() })));
        foreach (var preview in new[] { userPreview, adminPreview })
        {
            var skipped = preview["skipped"]!.AsArray().ToDictionary(s => (string)s!["field"]!, s => (string)s!["reason"]!);
            foreach (var field in fields.Concat(new[] { "leavingsoonmaintainerrapikey", "Leaving-Soon-Maintainerr-Api-Key" })) Assert.Equal("secret", skipped[field]);
            Assert.DoesNotContain(fields, field => preview["imported"]!.AsObject().ContainsKey(field));
        }

        Assert.Equal(new[] { "TagGap" }, userPreview["imported"]!.AsObject().Select(p => p.Key));
    }
}
