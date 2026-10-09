using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;

namespace JE.Tests;

public class IntegrationAwardsTests
{
    private static object Row(string award, string result, string detail, int year) => new { awardLabel = new { value = award }, result = new { value = result }, personLabel = new { value = detail }, workLabel = new { value = detail }, year = new { value = year.ToString() } };
    private static string Body(params object[] rows) => JsonSerializer.Serialize(new { results = new { bindings = rows } });

    [Theory]
    [InlineData("movie", "P4947")][InlineData("tv", "P4983")][InlineData("person", "P4985")]
    public async Task AwardsGroupRecipientsMergeNominationsIntoWinsAndDiscardUnlabelledEntities(string type, string property)
    {
        using var env = new IntegrationEnvironment();
        using var transport = new IntegrationTransport((request, _) =>
        {
            Assert.Contains("wdt:" + property, Uri.UnescapeDataString(request.RequestUri!.Query));
            Assert.NotEmpty(request.Headers.UserAgent);
            Assert.Equal("application/sparql-results+json", Assert.Single(request.Headers.Accept).MediaType);
            return Task.FromResult(IntegrationTransport.Response(Body(Row("Best Picture", "Won", "Alice", 2025), Row("Best Picture", "Won", "Alice", 2025), Row("Best Picture", "Nominated", "Bob", 2025), Row("Other", "Nominated", "Q123", 2024), Row("Q1234", "Won", "Ignored", 2023))));
        });
        using var service = new WikidataAwardsService(transport, env.Paths.Object, env.Logger);
        var result = await service.GetAwardsAsync(type, "1", default);
        Assert.True(result.Found); Assert.True(result.Confirmed);
        Assert.Equal(1, result.Wins); Assert.Equal(1, result.Nominations);
        Assert.Equal("Best Picture", result.Awards[0].Name);
        Assert.Equal(new[] { "Alice", "Bob" }, type == "person" ? result.Awards[0].Works : result.Awards[0].Recipients);
        Assert.Empty(type == "person" ? result.Awards[0].Recipients : result.Awards[0].Works);
        Assert.Empty(result.Awards[1].Recipients); Assert.Empty(result.Awards[1].Works);
        Assert.Same(result, await service.GetAwardsAsync(type, "1", default));
        Assert.Equal(1, transport.Calls);
    }

    [Theory]
    [InlineData(200, "{\"results\":{\"bindings\":[]}}", true)]
    [InlineData(429, "{}", false)][InlineData(503, "{}", false)]
    [InlineData(200, "{", false)][InlineData(200, "{}", false)]
    public async Task FailuresAreUnconfirmedButValidEmptyResponseIsConfirmed(int status, string body, bool confirmed)
    {
        using var env = new IntegrationEnvironment();
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response(body, status)));
        using var service = new WikidataAwardsService(transport, env.Paths.Object, env.Logger);
        var result = await service.GetAwardsAsync("movie", "1", default);
        Assert.False(result.Found); Assert.Equal(confirmed, result.Confirmed);
        Assert.Same(result, await service.GetAwardsAsync("movie", "1", default));
        Assert.Equal(1, transport.Calls);
    }

    [Fact]
    public async Task ConcurrentLookupsShareFetchAndResultsSurviveRestartWithMediaIsolation()
    {
        using var env = new IntegrationEnvironment();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var transport = new IntegrationTransport(async (_, ct) => { await release.Task.WaitAsync(ct); return IntegrationTransport.Response(Body(Row("Award", "Won", "A", 2025))); });
        using (var service = new WikidataAwardsService(transport, env.Paths.Object, env.Logger))
        {
            var pending = Enumerable.Range(0, 15).Select(_ => service.GetAwardsAsync("movie", "1", default)).ToArray();
            release.SetResult();
            Assert.All(await Task.WhenAll(pending), r => Assert.Equal(1, r.Wins));
            Assert.Equal(1, transport.Calls);
        }
        using var restarted = new WikidataAwardsService(transport, env.Paths.Object, env.Logger);
        Assert.Equal(1, (await restarted.GetAwardsAsync("movie", "1", default)).Wins);
        Assert.Equal(1, transport.Calls);
        await restarted.GetAwardsAsync("tv", "1", default);
        Assert.Equal(2, transport.Calls);
    }

    [Theory]
    [InlineData(true, true, 179, false)][InlineData(true, true, 181, true)]
    [InlineData(false, true, 29, false)][InlineData(false, true, 31, true)]
    [InlineData(false, false, 0.02, false)][InlineData(false, false, 0.05, true)]
    public async Task PersistedCacheAppliesDifferentPositiveNegativeAndRetryLifetimes(bool found, bool confirmed, double days, bool fetch)
    {
        using var env = new IntegrationEnvironment();
        var path = Path.Combine(env.Root, "configurations/Jellyfin.Plugin.JellyfinEnhanced/awards.json");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, JsonSerializer.Serialize(new AwardsCacheDiskFormat { SchemaVersion = 1, Items = new() { ["movie-1"] = new() { Found = found, Confirmed = confirmed, FetchedAtUnixMs = DateTimeOffset.UtcNow.AddDays(-days).ToUnixTimeMilliseconds() } } }));
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response(Body())));
        using var service = new WikidataAwardsService(transport, env.Paths.Object, env.Logger);
        await service.GetAwardsAsync("movie", "1", default);
        Assert.Equal(fetch ? 1 : 0, transport.Calls);
    }
}
