using System.Net;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders.Services;

namespace JE.Tests.Features.DetailsProviders;

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

    /// <summary>A LibreTranslate stand-in that records every q array and translates each entry with <paramref name="translate"/>.</summary>
    private static IntegrationTransport Recording(List<string[]> sent, Func<string, string>? translate = null) => new((request, _) =>
    {
        using var doc = JsonDocument.Parse(request.Content!.ReadAsStringAsync().Result);
        var q = doc.RootElement.GetProperty("q").EnumerateArray().Select(x => x.GetString()!).ToArray();
        sent.Add(q);
        return Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new { translatedText = q.Select(translate ?? (x => x)).ToArray() })));
    });

    private static string Sentences(int count) => string.Join(" ", Enumerable.Range(0, count).Select(i => $"Sentence number {i:000} says something about the film, and it goes on a while."));

    [Theory]
    [InlineData(1)]
    [InlineData(ReviewTranslationService.MaxChunkLength - 1)]
    [InlineData(ReviewTranslationService.MaxChunkLength)]
    public async Task ParagraphsUpToTheLimitAreSentWhole(int length)
    {
        using var env = new IntegrationEnvironment();
        var sent = new List<string[]>();
        using var transport = Recording(sent, x => x.ToUpperInvariant());
        var paragraph = string.Concat(Enumerable.Repeat("word. ", length / 6 + 1))[..length];
        var text = "Short first line\n\n" + paragraph;
        var result = await new ReviewTranslationService(transport, env.Logger).TranslateAsync("http://lt", "", text, "de", default);
        Assert.Equal(new[] { "Short first line", paragraph }, Assert.Single(sent));
        Assert.Equal("SHORT FIRST LINE\n\n" + paragraph.ToUpperInvariant(), result);
    }

    [Fact]
    public async Task LongParagraphIsSplitAfterSentencesInOrderWithItsSpacing()
    {
        using var env = new IntegrationEnvironment();
        var sent = new List<string[]>();
        using var transport = Recording(sent, x => "<" + x + ">");
        // Two spaces after sentence 025, where the first cut falls (26 sentences fit in 2,000 characters), to check the original spacing comes back.
        var paragraph = Sentences(60).Replace("025 says something about the film, and it goes on a while. ", "025 says something about the film, and it goes on a while.  ", StringComparison.Ordinal);
        Assert.True(paragraph.Length > 2 * ReviewTranslationService.MaxChunkLength);
        var text = "Intro.\n\n" + paragraph + "\nOutro.";

        var result = await new ReviewTranslationService(transport, env.Logger).TranslateAsync("http://lt", "", text, "de", default);

        var q = Assert.Single(sent);
        Assert.Equal("Intro.", q[0]);
        Assert.Equal("Outro.", q[^1]);
        var chunks = q[1..^1];
        Assert.Equal(3, chunks.Length);
        Assert.All(chunks, c => Assert.True(c.Length <= ReviewTranslationService.MaxChunkLength, c.Length.ToString()));
        Assert.All(chunks, c => Assert.EndsWith("while.", c));
        Assert.All(chunks, c => Assert.False(char.IsWhiteSpace(c[0])));
        Assert.StartsWith("Sentence number 000 ", chunks[0]);
        Assert.Equal(paragraph, string.Join(" ", chunks).Replace("025 says something about the film, and it goes on a while. ", "025 says something about the film, and it goes on a while.  ", StringComparison.Ordinal));

        // Translations come back in order, joined by the whitespace that separated the pieces.
        var separators = new List<string>();
        var rest = paragraph;
        foreach (var chunk in chunks[..^1])
        {
            rest = rest[chunk.Length..];
            var gap = new string(rest.TakeWhile(char.IsWhiteSpace).ToArray());
            separators.Add(gap);
            rest = rest[gap.Length..];
        }
        Assert.Equal(new[] { "  ", " " }, separators);
        var expected = "<" + chunks[0] + ">" + separators[0] + "<" + chunks[1] + ">" + separators[1] + "<" + chunks[2] + ">";
        Assert.Equal("<Intro.>\n\n" + expected + "\n<Outro.>", result);
    }

    [Theory]
    [InlineData("sentences")]
    [InlineData("words")]
    [InlineData("unbroken")]
    [InlineData("surrogates")]
    [InlineData("leading-spaces")]
    public async Task SplitTextRoundTripsExactlyThroughAnIdentityTranslator(string shape)
    {
        using var env = new IntegrationEnvironment();
        var sent = new List<string[]>();
        using var transport = Recording(sent);
        var text = shape switch
        {
            "sentences" => Sentences(80) + "\n\n" + Sentences(3) + " \n" + Sentences(40),
            "words" => string.Join("  ", Enumerable.Range(0, 900).Select(i => "word" + i)),
            "unbroken" => new string('a', 4500),
            "surrogates" => "a" + string.Concat(Enumerable.Repeat("😀", 2500)),
            _ => new string(' ', 2500) + Sentences(30),
        };

        Assert.Equal(text, await new ReviewTranslationService(transport, env.Logger).TranslateAsync("http://lt", "", text, "de", default));
        var q = Assert.Single(sent);
        Assert.All(q, c => Assert.InRange(c.Length, 1, ReviewTranslationService.MaxChunkLength));
        Assert.All(q, c => Assert.False(string.IsNullOrWhiteSpace(c)));
        if (shape == "words")
        {
            Assert.All(q, c => Assert.Matches("^word\\d+( +word\\d+)*$", c));
        }
        if (shape == "unbroken")
        {
            Assert.Equal(new[] { 2000, 2000, 500 }, q.Select(c => c.Length));
        }
        if (shape == "surrogates")
        {
            Assert.All(q, c => Assert.False(char.IsHighSurrogate(c[^1]), "a chunk ends between the halves of an emoji"));
        }
    }

    [Theory]
    [InlineData(429, "30", 30)]
    [InlineData(429, null, null)]
    [InlineData(403, null, null)]
    public async Task RateLimitAndRefusalThrowADistinctErrorAndAreNotCached(int status, string? retryAfter, int? expectedSeconds)
    {
        using var env = new IntegrationEnvironment();
        using var transport = new IntegrationTransport((_, _) =>
        {
            var response = IntegrationTransport.Response("{\"error\":\"Slowdown: 10 per 1 minute\"}", status);
            if (retryAfter != null) response.Headers.Add("Retry-After", retryAfter);
            return Task.FromResult(response);
        });
        var service = new ReviewTranslationService(transport, env.Logger);
        var ex = await Assert.ThrowsAsync<TranslationLimitException>(() => service.TranslateAsync("http://lt", "", "Hi", "de", default));
        Assert.Equal((HttpStatusCode)status, ex.StatusCode);
        Assert.Equal((double?)expectedSeconds, ex.RetryAfter?.TotalSeconds);
        Assert.Contains(status == 429 ? "rate limiting" : "refused", ex.Message);
        await Assert.ThrowsAsync<TranslationLimitException>(() => service.TranslateAsync("http://lt", "", "Hi", "de", default));
        Assert.Equal(2, transport.Calls);
    }
}
