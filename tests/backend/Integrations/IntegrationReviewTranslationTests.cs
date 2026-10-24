using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services;

namespace JE.Tests;

public class IntegrationReviewTranslationTests
{
    private static string Languages() => JsonSerializer.Serialize(new object[]
    {
        new { code = "en", name = "English", targets = new[] { "de", "fr" } },
        new { code = "de", name = "German", targets = new[] { "en" } },
    });

    [Fact]
    public async Task TargetLanguagesAreEnglishTargetsAndCached()
    {
        using var env = new IntegrationEnvironment();
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response(Languages())));
        var service = new ReviewTranslationService(transport, env.Logger);
        Assert.Equal(new[] { "de", "fr" }, await service.GetTargetLanguagesAsync("http://lt", default));
        await service.GetTargetLanguagesAsync("http://lt", default);
        Assert.Equal(1, transport.Calls);
    }

    [Fact]
    public async Task TranslationSendsEnglishSourceKeepsBlankLinesAndIsCached()
    {
        using var env = new IntegrationEnvironment();
        using var transport = new IntegrationTransport((request, _) =>
        {
            using var doc = JsonDocument.Parse(request.Content!.ReadAsStringAsync().Result);
            var root = doc.RootElement;
            Assert.Equal("http://lt/translate", request.RequestUri!.ToString());
            Assert.Equal("en", root.GetProperty("source").GetString());
            Assert.Equal("de", root.GetProperty("target").GetString());
            Assert.Equal("secret", root.GetProperty("api_key").GetString());
            var q = root.GetProperty("q").EnumerateArray().Select(x => x.GetString()!).ToArray();
            Assert.Equal(new[] { "One", "Two" }, q);
            return Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new { translatedText = q.Select(x => x + "!").ToArray() })));
        });
        var service = new ReviewTranslationService(transport, env.Logger);
        Assert.Equal("One!\n\nTwo!", await service.TranslateAsync("http://lt", "secret", "One\n\nTwo", "de", default));
        Assert.Equal("One!\n\nTwo!", await service.TranslateAsync("http://lt", "secret", "One\n\nTwo", "de", default));
        Assert.Equal(1, transport.Calls);
    }

    [Fact]
    public async Task MismatchedResponseAndServerErrorsThrow()
    {
        using var env = new IntegrationEnvironment();
        using var short_ = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("{\"translatedText\":[]}")));
        await Assert.ThrowsAsync<InvalidOperationException>(() => new ReviewTranslationService(short_, env.Logger).TranslateAsync("http://lt", "", "Hi", "de", default));
        using var down = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("{}", 503)));
        await Assert.ThrowsAsync<HttpRequestException>(() => new ReviewTranslationService(down, env.Logger).TranslateAsync("http://lt", "", "Hi", "de", default));
    }
}
