using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Platform.Services;

namespace JE.Tests;

// canopy K1: GET /JellyfinEnhanced/bundle.js(.map) on the wire: pre-compressed br or gzip per Accept-Encoding,
// Vary: Accept-Encoding, a strong ETag per representation and 304 for a matching If-None-Match. The decoded body is
// always the identity body, byte for byte.
[Collection("Plugin singleton")]
public class BundleServingTests
{
    private static byte[] Decode(byte[] body, string? encoding)
    {
        if (encoding == null) return body;
        using var input = new MemoryStream(body);
        using Stream decoder = encoding == "br" ? new BrotliStream(input, CompressionMode.Decompress) : new GZipStream(input, CompressionMode.Decompress);
        using var output = new MemoryStream();
        decoder.CopyTo(output);
        return output.ToArray();
    }

    private static async Task<HttpResponseMessage> Get(HttpClient client, string path, string? acceptEncoding = null, string? ifNoneMatch = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        if (acceptEncoding != null) request.Headers.TryAddWithoutValidation("Accept-Encoding", acceptEncoding);
        if (ifNoneMatch != null) request.Headers.TryAddWithoutValidation("If-None-Match", ifNoneMatch);
        return await client.SendAsync(request);
    }

    [Theory]
    [InlineData("/JellyfinEnhanced/bundle.js", "application/javascript")]
    [InlineData("/JellyfinEnhanced/bundle.js.map", "application/json")]
    public async Task EachEncodingDecodesToTheIdentityBodyWithItsOwnValidator(string path, string mime)
    {
        using var fixture = new ApiPluginFixture();
        using var server = BundleServer.Create(fixture);
        using var client = server.CreateClient();
        using var identity = await Get(client, path);
        Assert.Equal(HttpStatusCode.OK, identity.StatusCode);
        var plain = await identity.Content.ReadAsByteArrayAsync();
        var tags = new Dictionary<string, HashSet<string>>();
        foreach (var (accept, expected) in new (string?, string?)[]
        {
            (null, null), ("identity", null), ("gzip, deflate, br, zstd", "br"), ("gzip", "gzip"), ("br;q=0, gzip", "gzip"),
            ("br;q=0.5, gzip;q=0.8", "gzip"), ("*", "br"), ("gzip;q=0, br;q=0", null), ("x-gzip", "gzip"),
        })
        {
            using var response = await Get(client, path, accept);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal(mime, response.Content.Headers.ContentType!.MediaType);
            Assert.Equal(expected, response.Content.Headers.ContentEncoding.SingleOrDefault());
            Assert.Contains("Accept-Encoding", response.Headers.Vary);
            Assert.Equal("public, max-age=31536000, immutable", response.Headers.CacheControl!.ToString());
            var etag = response.Headers.ETag!;
            Assert.False(etag.IsWeak);
            var body = await response.Content.ReadAsByteArrayAsync();
            Assert.Equal(plain, Decode(body, expected));
            if (expected != null) Assert.True(body.Length < plain.Length / 3, $"{accept}: {body.Length} of {plain.Length} bytes");
            (tags.TryGetValue(expected ?? "identity", out var set) ? set : tags[expected ?? "identity"] = new HashSet<string>()).Add(etag.Tag);
        }
        // A validator belongs to one representation, never shared between encodings. (The brotli one may change
        // during the test, when the background quality-11 upgrade lands.)
        Assert.Equal(3, tags.Count);
        Assert.Equal(tags.Values.Sum(t => t.Count), tags.Values.SelectMany(t => t).Distinct().Count());
    }

    [Fact]
    public async Task MatchingIfNoneMatchGets304ForTheSameRepresentationOnly()
    {
        using var fixture = new ApiPluginFixture();
        using var server = BundleServer.Create(fixture);
        using var client = server.CreateClient();
        using var gzip = await Get(client, "/JellyfinEnhanced/bundle.js", "gzip");
        var tag = gzip.Headers.ETag!.Tag;
        using var notModified = await Get(client, "/JellyfinEnhanced/bundle.js", "gzip", tag);
        Assert.Equal(HttpStatusCode.NotModified, notModified.StatusCode);
        Assert.Empty(await notModified.Content.ReadAsByteArrayAsync());
        Assert.Equal(tag, notModified.Headers.ETag!.Tag);
        Assert.Contains("Accept-Encoding", notModified.Headers.Vary);
        using var weak = await Get(client, "/JellyfinEnhanced/bundle.js", "gzip", $"\"other\", W/{tag}");
        Assert.Equal(HttpStatusCode.NotModified, weak.StatusCode);
        // The gzip tag does not validate the identity representation.
        using var identity = await Get(client, "/JellyfinEnhanced/bundle.js", null, tag);
        Assert.Equal(HttpStatusCode.OK, identity.StatusCode);
        Assert.NotEqual(tag, identity.Headers.ETag!.Tag);
    }

    // perf-runtime: bundle.js.map (about 11 MB, built by parsing two embedded maps per module) is built when it is first
    // requested. Serving bundle.js must not build it: the first page load after every server start waited for that
    // build (385 ms against upstream's 71 ms for the first bundle.js), and every server then kept the map in memory
    // although only a browser with developer tools open ever asks for it.
    [Fact]
    public async Task ServingTheScriptDoesNotBuildTheSourceMap()
    {
        using var fixture = new ApiPluginFixture();
        using var server = BundleServer.Create(fixture);
        using var client = server.CreateClient();
        // Drop whatever an earlier test cached under the plugin's key, so the first request below builds the bundle.
        ClientScriptBundle.GetServedBundle("drop-the-cached-bundle", rebuild: true, fixture.Core.Logger);
        foreach (var accept in new[] { "gzip, deflate, br, zstd", "gzip", null })
        {
            using var script = await Get(client, "/JellyfinEnhanced/bundle.js", accept);
            Assert.Equal(HttpStatusCode.OK, script.StatusCode);
        }

        var key = Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.Instance!.ScriptCacheKey;
        var bundle = ClientScriptBundle.GetServedBundle(key, rebuild: false, fixture.Core.Logger);
        Assert.False(bundle.Map.IsValueCreated, "GET /JellyfinEnhanced/bundle.js built the source map.");
        using var map = await Get(client, "/JellyfinEnhanced/bundle.js.map", "gzip");
        Assert.Equal(HttpStatusCode.OK, map.StatusCode);
        Assert.True(bundle.Map.IsValueCreated);
        Assert.Same(bundle, ClientScriptBundle.GetServedBundle(key, rebuild: false, fixture.Core.Logger));
        Assert.Same(bundle.SourceMap, bundle.SourceMap);
    }

    // perf-runtime: every module function runs exactly once, at boot. Parenthesized, V8 compiles it with the script
    // (off the main thread while the script streams in); bare, it was compiled lazily on the main thread at its call,
    // which the CPU profile showed as about 7 ms of every page load.
    [Fact]
    public void EveryModuleFunctionIsParenthesizedSoItIsCompiledWithTheScript()
    {
        using var fixture = new CoreFixture();
        var lines = Encoding.UTF8.GetString(ClientScriptBundle.BuildUncached("wrapper-check", fixture.Logger).Script).Split('\n');
        var opened = 0;
        for (var i = 0; i < lines.Length; i++)
        {
            if (!lines[i].StartsWith("/* ---- js/", StringComparison.Ordinal)) continue;
            Assert.Equal("(function () {", lines[i + 1]);
            opened++;
        }

        Assert.Equal(ClientScriptBundle.GetComponentScripts().Count, opened);
        Assert.Equal(opened, lines.Count(line => line == "}),"));
        Assert.DoesNotContain("function () {", lines);
    }

    [Fact]
    public async Task BrotliIsUpgradedInTheBackgroundToASmallerBodyWithANewValidator()
    {
        using var fixture = new CoreFixture();
        var script = Encoding.UTF8.GetBytes(string.Concat(Enumerable.Range(0, 20000).Select(i => $"function f{i % 977}() {{ return '{i % 131}'; }}\n")));
        var file = new ServedFile(script, ServedFile.ScriptLevels, upgradeBrotli: true, fixture.Logger);
        var first = file.Brotli;
        await file.BrotliUpgrade;
        var upgraded = file.Brotli;
        Assert.Equal(script, Decode(first.Bytes, "br"));
        Assert.Equal(script, Decode(upgraded.Bytes, "br"));
        Assert.True(upgraded.Bytes.Length <= first.Bytes.Length);
        Assert.NotSame(first, upgraded);
        Assert.Same(file.Gzip, file.Gzip);
        var fixed9 = new ServedFile(script, ServedFile.ScriptLevels, upgradeBrotli: false, fixture.Logger);
        Assert.Same(fixed9.Brotli, fixed9.Brotli);
        Assert.Same(Task.CompletedTask, fixed9.BrotliUpgrade);
    }
}
