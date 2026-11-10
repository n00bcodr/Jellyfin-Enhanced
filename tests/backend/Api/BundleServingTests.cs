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
