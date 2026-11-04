using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class AwardTagsTests
{
    [Theory]
    [InlineData("123", true)] [InlineData("owner/chart-250", true)]
    [InlineData("https://example.com", false)] [InlineData("a/../b", false)]
    [InlineData("a/b?apikey=x", false)] [InlineData("", false)]
    public void ListConfigurationCannotEscapeProviderPath(string id, bool valid) => Assert.Equal(valid, AwardTagsService.IsListId(id));

    [Fact]
    public void UnrelatedAdminSavesDoNotRepublishAwardsOrWaitForTheCacheRebuildLock()
    {
        var config = new PluginConfiguration();
        var before = AwardTagsService.ConfigurationIdentity(config);
        config.TagLayout = "caption";
        Assert.Equal(before, AwardTagsService.ConfigurationIdentity(config));
        config.AwardsTagsEnabled = true;
        Assert.NotEqual(before, AwardTagsService.ConfigurationIdentity(config));
        before = AwardTagsService.ConfigurationIdentity(config);
        config.AwardsTagsImdbList = "123";
        Assert.NotEqual(before, AwardTagsService.ConfigurationIdentity(config));
    }

    [Fact]
    public void CacheCloneValueComparisonNativeHashAndStylesIncludeAwards()
    {
        var entry = new TagCacheEntry { Type = "Movie", Awards = new() { ImdbRank = 12, OscarWinner = true, OscarYear = 2024 } };
        var copy = entry.Clone();
        Assert.Equal(entry.Awards, copy.Awards);
        Assert.True(TagCacheEntry.ContentEquals(entry, copy));
        copy.Awards = copy.Awards! with { ImdbRank = 11 };
        Assert.False(TagCacheEntry.ContentEquals(entry, copy));
        Assert.NotEqual(PosterTagDataProvider.ContentHash(entry), PosterTagDataProvider.ContentHash(copy));
        Assert.Contains("Awards", JsonSerializer.Serialize(entry));
        var set = TagStyleSet.Parse("{\"v\":2,\"groups\":{\"awards\":{\"text\":\"#ffffff\"}},\"labels\":{\"awards:oscar\":{\"background\":\"#123456\"}}}", "default");
        Assert.NotNull(set.Resolve("awards", "oscar").Background);
        Assert.Contains("awards", JsonSerializer.Serialize(set.ToWebModel()));
    }

    [Fact]
    public void NativeAwardCaptionsComeFromTheWebVocabularyInTheSavedLanguage()
    {
        var entry = new TagCacheEntry { Type = "Movie", Awards = new() { ImdbRank = 12, CertifiedFresh = true, OscarWinner = true, EmmyWinner = true, LetterboxdRank = 24 } };
        PosterTagSettings Settings(string? locale) => PosterTagSettings.FromUserSettings(new() { AwardsTagsEnabled = true, TagLayoutSettingsVersion = 1, TagGroupCaps = new() { Awards = 0 }, NativePosterDateLocale = locale }, new PluginConfiguration { AwardsTagsEnabled = true });
        string[] Captions(PosterTagSettings settings) => Assert.Single(PosterTagResolver.Resolve(entry, settings, new("Movie", false, null, null, null), false)!.Groups).Tags.Cast<AwardTag>().Select(t => t.Text).ToArray();
        Assert.Equal(new[] { "Top 250", "Certified Fresh", "Oscar winner", "Emmy winner", "Top 250" }, Captions(Settings(null)));
        var german = Settings("de-DE");
        var keys = new[] { "awards_tags_label_imdbTop250", "awards_tags_label_certifiedFresh", "awards_tags_oscar", "awards_tags_emmy", "awards_tags_label_imdbTop250" };
        Assert.Equal(keys.Select(key => StatusRules.Text(key, german.StatusCulture)), Captions(german));
        Assert.Equal(Settings(null).Digest, Settings("en-GB").Digest); // English posters keep their tokens
        Assert.NotEqual(Settings(null).Digest, german.Digest);
    }

    [Fact]
    public void NativeCapsCornerOrderIncludeSwitchesAndEveryLogoMatchWeb()
    {
        var config = new PluginConfiguration { AwardsTagsEnabled = true };
        var user = new JellyfinEnhancedUserSettings { AwardsTagsEnabled = true, TagLayoutSettingsVersion = 1,
            TagGroupCaps = new() { Awards = 0 }, TagLayouts = new() { Corners = new() { Groups = [new() { Group = "awards", Slot = "bc" }] } } };
        var settings = PosterTagSettings.FromUserSettings(user, config);
        var entry = new TagCacheEntry { Type = "Movie", Awards = new() { ImdbRank = 12, CertifiedFresh = true, OscarWinner = true, EmmyWinner = true, LetterboxdRank = 24 } };
        var layout = PosterTagResolver.Resolve(entry, settings, new("Movie", false, null, null, null), false)!;
        var group = Assert.Single(layout.Groups);
        Assert.Equal(PosterTagCorner.BottomCenter, group.Corner);
        Assert.Equal(new[] { "imdbTop250", "certifiedFresh", "oscar", "emmy", "letterboxdTop250" }, group.Tags.Cast<AwardTag>().Select(t => t.Id));
        using var assets = PosterTagAssets.Load();
        using var renderer = new PosterTagRenderer();
        using var bitmap = new SkiaSharp.SKBitmap(360, 540); bitmap.Erase(SkiaSharp.SKColors.Gray);
        foreach (var id in group.Tags.Cast<AwardTag>().Select(t => t.Id)) Assert.NotNull(assets.GetVectorIcon("award-" + id));
        using var rendered = renderer.Render(bitmap, layout); Assert.NotNull(rendered);
        Assert.NotEqual(bitmap.Pixels, rendered.Pixels);
        user.TagGroupCaps.Awards = 2;
        var capped = PosterTagSettings.FromUserSettings(user, config);
        Assert.NotEqual(settings.Digest, capped.Digest);
        Assert.Equal(2, Assert.Single(PosterTagResolver.Resolve(entry, capped, new("Movie", false, null, null, null), false)!.Groups).Tags.Count);
        config.AwardsTagsEnabled = false;
        Assert.False(PosterTagSettings.FromUserSettings(user, config).AnyGroupEnabled);
    }

    [Fact]
    public void WinnerProjectionRejectsNominationsAndPreservesUnknownYears()
    {
        var awards = new AwardsCacheEntry { Confirmed = true, Awards = [
            new() { Name = "Academy Award for Best Picture", Result = "Nominated", Year = 2025 },
            new() { Name = "Primetime Emmy Award for Drama", Result = "Won", Year = 2024 },
            new() { Name = "Academy Award for Best Editing", Result = "Won" },
            new() { Name = "Unrelated award", Result = "Won", Year = 2026 }] };
        var result = AwardTagsService.MergeWinners(new(), awards, new PluginConfiguration());
        Assert.True(result.OscarWinner); Assert.Null(result.OscarYear);
        Assert.True(result.EmmyWinner); Assert.Equal(2024, result.EmmyYear);
    }

    [Fact]
    public void ChartParserSeparatesMediaTypesAndNeverMatchesInternalIdsOrOutOfChartRanks()
    {
        using var json = JsonDocument.Parse("{\"movies\":[{\"id\":999,\"ids\":{\"tmdb\":42},\"rank\":12},{\"id\":888,\"rank\":1},{\"ids\":{\"tmdb\":43},\"rank\":251}],\"shows\":[{\"ids\":{\"tmdb\":42},\"rank\":3}]}");
        var ranks = AwardTagsService.ParseList(json.RootElement);
        Assert.Equal(2, ranks.Count); Assert.Equal(12, ranks["movie:42"]); Assert.Equal(3, ranks["tv:42"]);
    }

    [Fact]
    public async Task NoKeyNeverCallsMdblistAndMasterOffDoesNoNetworkWork()
    {
        using var env = new ApiPluginFixture();
        using var transport = new IntegrationTransport((request, _) => {
            Assert.Equal("query.wikidata.org", request.RequestUri!.Host);
            return Task.FromResult(IntegrationTransport.Response("{\"results\":{\"bindings\":[]}}"));
        });
        using var mdblist = new MdblistService(transport, env.Core.Paths.Object, env.Core.Logger);
        using var wiki = new WikidataAwardsService(transport, env.Core.Paths.Object, env.Core.Logger);
        var service = new AwardTagsService(transport, env.Core.Paths.Object, mdblist, wiki, env.Core.Logger);
        var config = env.Plugin.Configuration;
        await service.RefreshAsync([("movie", "42")], config, null, default);
        Assert.Equal(0, transport.Calls);
        config.AwardsTagsEnabled = true;
        await Task.WhenAll(service.RefreshAsync([("movie", "42")], config, null, default), service.RefreshAsync([("movie", "42")], config, null, default));
        Assert.Equal(1, transport.Calls);
        Assert.Null(service.GetCached("movie", "42", config)!.ImdbRank);
        var reopened = new AwardTagsService(transport, env.Core.Paths.Object, mdblist, wiki, env.Core.Logger);
        await reopened.RefreshAsync([("movie", "42")], config, null, default);
        Assert.Equal(1, transport.Calls);
    }

    [Fact]
    public async Task ListsCertificationFailuresAndTtlUseDeterministicTransport()
    {
        using var env = new ApiPluginFixture();
        var config = env.Plugin.Configuration;
        config.AwardsTagsEnabled = true; config.MdblistApiKey = "fixture-key";
        config.AwardsTagsOscar = false; config.AwardsTagsEmmy = false;
        var fail = false;
        using var transport = new IntegrationTransport((request, _) => {
            var path = request.RequestUri!.AbsolutePath;
            if (path == "/user") return Task.FromResult(IntegrationTransport.Response("{\"rate_limit\":1000,\"rate_limit_remaining\":1000}"));
            if (fail) return Task.FromResult(IntegrationTransport.Response("{}", 503));
            if (path.StartsWith("/lists/")) return Task.FromResult(IntegrationTransport.Response("{\"movies\":[{\"ids\":{\"tmdb\":42},\"rank\":12}]}"));
            return Task.FromResult(IntegrationTransport.Response("[{\"ids\":{\"tmdb\":42},\"ratings\":[{\"source\":\"tomatoes\",\"score\":99,\"fresh\":1,\"certified\":true}]}]"));
        });
        using var mdblist = new MdblistService(transport, env.Core.Paths.Object, env.Core.Logger);
        using var wiki = new WikidataAwardsService(transport, env.Core.Paths.Object, env.Core.Logger);
        var service = new AwardTagsService(transport, env.Core.Paths.Object, mdblist, wiki, env.Core.Logger);
        await service.RefreshAsync([("movie", "42")], config, null, default);
        var facts = service.GetCached("movie", "42", config)!;
        Assert.Equal(12, facts.ImdbRank); Assert.Equal(12, facts.LetterboxdRank); Assert.True(facts.CertifiedFresh);
        var calls = transport.Calls;
        await service.RefreshAsync([("movie", "42")], config, null, default); Assert.Equal(calls, transport.Calls);
        // Expire the persisted refresh TTL, then exercise the one-hour failure backoff.
        var path = Path.Combine(env.Core.ConfigRoot, "award-tags.json");
        var disk = JsonSerializer.Deserialize<AwardTagsService.Disk>(File.ReadAllText(path))!;
        foreach (var title in disk.Titles.Values) title.NextRefresh = 0;
        foreach (var list in disk.Lists.Values) list.NextRefresh = 0;
        File.WriteAllText(path, JsonSerializer.Serialize(disk));
        fail = true;
        var retry = new AwardTagsService(transport, env.Core.Paths.Object, mdblist, wiki, env.Core.Logger);
        await retry.RefreshAsync([("movie", "42")], config, null, default);
        Assert.Equal(facts, retry.GetCached("movie", "42", config));
        calls = transport.Calls;
        await retry.RefreshAsync([("movie", "42")], config, null, default); Assert.Equal(calls, transport.Calls);
        config.MdblistApiKey = ""; Assert.Null(retry.GetCached("movie", "42", config));
        Assert.DoesNotContain("fixture-key", File.ReadAllText(path));
    }

    [Fact]
    public async Task CancellationPropagatesWithoutCachingAnUnconfirmedWikidataMiss()
    {
        using var env = new ApiPluginFixture();
        env.Plugin.Configuration.AwardsTagsEnabled = true;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var transport = new IntegrationTransport(async (_, token) => { entered.TrySetResult(); await Task.Delay(Timeout.Infinite, token); return IntegrationTransport.Response(); });
        using var mdblist = new MdblistService(transport, env.Core.Paths.Object, env.Core.Logger);
        using var wiki = new WikidataAwardsService(transport, env.Core.Paths.Object, env.Core.Logger);
        var service = new AwardTagsService(transport, env.Core.Paths.Object, mdblist, wiki, env.Core.Logger);
        using var cancel = new CancellationTokenSource();
        var pending = service.RefreshAsync([("movie", "42")], env.Plugin.Configuration, null, cancel.Token);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5)); cancel.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
        Assert.Null(service.GetCached("movie", "42", env.Plugin.Configuration));
    }
}
