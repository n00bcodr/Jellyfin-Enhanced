using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services;

namespace JE.Tests;

public class IntegrationWatchProvidersTests
{
    [Theory]
    [InlineData("US", true)][InlineData("AU", true)][InlineData("us", false)]
    [InlineData("US\n", false)][InlineData("US\r\n", false)][InlineData(" US", false)]
    [InlineData("USA", false)][InlineData("", false)][InlineData(null, false)]
    public void RegionRequiresExactlyTwoUppercaseLetters(string? value, bool expected) => Assert.Equal(expected, WatchProvidersBatch.IsValidRegion(value));

    [Fact]
    public void BatchCanonicalizesIdsDeduplicatesInFirstSeenOrderAndSkipsMalformedEntries()
    {
        Assert.True(WatchProvidersBatch.TryParseItems(" movie:001,tv:2,movie:1,tv:2,bad,movie:0,movie:-2,movie:1234567890,TV:1,movie:3 ", out var items, out var error));
        Assert.Equal(new[] { "movie:1", "tv:2", "movie:3" }, items.Select(x => x.Key));
        Assert.Equal("tv/2/watch/providers", items[1].ApiPath);
        Assert.Equal("", error);
    }

    [Theory]
    [InlineData(null)][InlineData("")][InlineData("  ")][InlineData("movie:0,tv:-1,person:2")]
    public void BatchRejectsMissingOrEntirelyInvalidInput(string? value)
    {
        Assert.False(WatchProvidersBatch.TryParseItems(value, out var items, out var error));
        Assert.Empty(items); Assert.NotEmpty(error);
    }

    [Fact]
    public void BatchAcceptsMaximumDistinctIdsButRejectsOneMoreAndOversizedInput()
    {
        var maximum = string.Join(',', Enumerable.Range(1, WatchProvidersBatch.MaxItems).Select(x => "movie:" + x));
        Assert.True(WatchProvidersBatch.TryParseItems(maximum + ",movie:1", out var parsed, out _));
        Assert.Equal(100, parsed.Count);
        Assert.False(WatchProvidersBatch.TryParseItems(maximum + ",movie:101", out _, out _));
        Assert.False(WatchProvidersBatch.TryParseItems(new string('x', 2049), out _, out _));
    }

    [Theory]
    [InlineData("/logo.png", true)][InlineData("/logo.WEBP", true)]
    [InlineData("/logo.png\n", false)][InlineData("https://evil.invalid/logo.png", false)]
    [InlineData("/../logo.png", false)][InlineData("/logo.svg", false)]
    public void ProviderLogoMustBeSafeSingleTmdbImagePath(string path, bool expected)
    {
        var json = JsonSerializer.Serialize(new { results = new { US = new { flatrate = new[] { new { provider_id = 7, provider_name = "Provider", logo_path = path } } } } });
        Assert.Equal(expected ? 1 : 0, WatchProvidersBatch.ExtractFlatrate(json, "US")!.Count);
    }

    [Fact]
    public void OutputDistinguishesProviderAbsenceFromFailedLookupAndEscapesNames()
    {
        var providers = WatchProvidersBatch.ExtractFlatrate("{\"results\":{\"US\":{\"flatrate\":[{\"provider_id\":7,\"provider_name\":\"A & 日本語\",\"logo_path\":\"/a.png\"}],\"rent\":[{}]},\"AU\":{\"flatrate\":[{}]}}}", "US")!;
        Assert.Equal("A & 日本語", Assert.Single(providers).ProviderName);
        Assert.Empty(WatchProvidersBatch.ExtractFlatrate("{}", "US")!);
        Assert.Null(WatchProvidersBatch.ExtractFlatrate("{", "US"));
        Assert.Null(WatchProvidersBatch.ExtractFlatrate("[]", "US"));
        var items = new[] { new WatchProvidersBatch.Item("movie", 1), new WatchProvidersBatch.Item("tv", 2), new WatchProvidersBatch.Item("tv", 3) };
        using var result = JsonDocument.Parse(WatchProvidersBatch.Serialize("US", items, new Dictionary<string, List<WatchProvidersBatch.Provider>?> { ["movie:1"] = providers, ["tv:2"] = [] }));
        Assert.Equal("A & 日本語", result.RootElement.GetProperty("results").GetProperty("movie:1")[0].GetProperty("provider_name").GetString());
        Assert.Equal(0, result.RootElement.GetProperty("results").GetProperty("tv:2").GetArrayLength());
        Assert.Equal(JsonValueKind.Null, result.RootElement.GetProperty("results").GetProperty("tv:3").ValueKind);
    }
}
