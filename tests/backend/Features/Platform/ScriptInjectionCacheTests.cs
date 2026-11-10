using System.IO.Compression;
using System.Text;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Platform.Services;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

namespace JE.Tests.Features.Platform;

/// <summary>
/// Canopy K3a: index.html injection keeps compression and working validators, caches the
/// injected page by the source's validators, never changes what is injected, and bounds
/// the memory it uses.
/// </summary>
[Collection("Plugin singleton")]
public class ScriptInjectionCacheTests
{
    // A page shaped like jellyfin-web 12.4's index.html (5,441 bytes on the HOST image).
    private const string Shell = "<!doctype html><html class=\"preload\" dir=\"ltr\"><head><meta charset=\"utf-8\"><title>Jellyfin</title>"
        + "<link href=\"main.jellyfin.bundle.css\" rel=\"stylesheet\"></head><body dir=\"ltr\"><div class=\"backdropContainer\"></div>"
        + "<div class=\"mainAnimatedPages skinBody\"></div><div class=\"mainDrawerHandle\"></div>"
        + "<script defer=\"defer\" src=\"main.jellyfin.bundle.js\"></script></body></html>";

    /// <summary>A stand-in for the static-file handler: validators, conditional GET, and what it was asked.</summary>
    private sealed class StaticShell
    {
        public string Content = Shell;
        public string ETag = "\"1dd658fb311d8c1\"";
        public string LastModified = "Mon, 26 Oct 2026 21:19:35 GMT";
        public int Calls;
        public int BodiesSent;
        public List<Dictionary<string, string>> Seen = new();

        public async Task Handle(HttpContext c)
        {
            Calls++;
            Seen.Add(c.Request.Headers.ToDictionary(h => h.Key, h => h.Value.ToString(), StringComparer.OrdinalIgnoreCase));
            c.Response.Headers.ETag = ETag;
            c.Response.Headers.LastModified = LastModified;
            c.Response.Headers.CacheControl = "no-cache";
            c.Response.Headers.AcceptRanges = "bytes";
            if (c.Request.Headers.IfNoneMatch.ToString() == ETag)
            {
                c.Response.StatusCode = 304;
                return;
            }

            var bytes = Encoding.UTF8.GetBytes(Content);
            c.Response.ContentType = "text/html";
            c.Response.ContentLength = bytes.Length;
            BodiesSent++;
            // Written in small chunks, as SendFileAsync does.
            for (var i = 0; i < bytes.Length; i += 1024)
            {
                await c.Response.Body.WriteAsync(bytes.AsMemory(i, Math.Min(1024, bytes.Length - i)));
            }
        }
    }

    private static async Task<HttpContext> Get(ScriptInjectionStartupFilter filter, RequestDelegate downstream, string path = "/web/index.html", string? acceptEncoding = null, string? ifNoneMatch = null, string? ifMatch = null, Stream? body = null)
    {
        using var services = new ServiceCollection().AddLogging().BuildServiceProvider();
        var app = new ApplicationBuilder(services);
        filter.Configure(a => a.Run(downstream))(app);
        var context = new DefaultHttpContext();
        context.Request.Path = path;
        context.Request.Method = "GET";
        context.Response.Body = body ?? new MemoryStream();
        if (acceptEncoding != null) context.Request.Headers.AcceptEncoding = acceptEncoding;
        if (ifNoneMatch != null) context.Request.Headers.IfNoneMatch = ifNoneMatch;
        if (ifMatch != null) context.Request.Headers.IfMatch = ifMatch;
        await app.Build()(context);
        return context;
    }

    private static byte[] Raw(HttpContext c) => ((MemoryStream)c.Response.Body).ToArray();

    private static string Decoded(HttpContext c)
    {
        var raw = Raw(c);
        Stream decoder = c.Response.Headers.ContentEncoding.ToString() switch
        {
            "br" => new BrotliStream(new MemoryStream(raw), CompressionMode.Decompress),
            "gzip" => new GZipStream(new MemoryStream(raw), CompressionMode.Decompress),
            "" => new MemoryStream(raw),
            var other => throw new InvalidOperationException("unexpected encoding " + other),
        };
        using (decoder)
        using (var output = new MemoryStream())
        {
            decoder.CopyTo(output);
            return Encoding.UTF8.GetString(output.ToArray());
        }
    }

    // The pre-K3a rewrite, verbatim: the tag goes just before the last </body>, then a newline.
    private static string Expected(string html, string tag)
    {
        var bodyClose = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        return html.Substring(0, bodyClose) + tag + "\n" + html.Substring(bodyClose);
    }

    [Theory]
    [InlineData("br, gzip, deflate", "br")]
    [InlineData("gzip, deflate, br;q=0.5", "gzip")]
    [InlineData("gzip", "gzip")]
    [InlineData("br", "br")]
    [InlineData("*", "br")]
    [InlineData("identity", "")]
    [InlineData(null, "")]
    public async Task CompressionIsNegotiatedFromTheClientsAcceptEncoding(string? acceptEncoding, string expected)
    {
        using var f = new ApiPluginFixture();
        var shell = new StaticShell();
        var context = await Get(new ScriptInjectionStartupFilter(f.Core.Logger), shell.Handle, acceptEncoding: acceptEncoding);

        Assert.Equal(200, context.Response.StatusCode);
        Assert.Equal(expected, context.Response.Headers.ContentEncoding.ToString());
        Assert.Equal("Accept-Encoding", context.Response.Headers.Vary.ToString());
        Assert.Equal(Raw(context).Length, context.Response.ContentLength);
        Assert.Equal(Expected(Shell, f.Plugin.BuildScriptTag()), Decoded(context));
        // The static handler is always asked for the plain file, so nothing has to be decoded.
        Assert.False(shell.Seen.Single().ContainsKey("Accept-Encoding"));
        // ... and the client's request is left as it sent it.
        Assert.Equal(acceptEncoding ?? string.Empty, context.Request.Headers.AcceptEncoding.ToString());
        if (expected.Length > 0) Assert.True(Raw(context).Length < Encoding.UTF8.GetByteCount(Decoded(context)));
    }

    [Fact]
    public async Task EachRepresentationHasItsOwnStrongETagAndAnswers304()
    {
        using var f = new ApiPluginFixture();
        var shell = new StaticShell();
        var filter = new ScriptInjectionStartupFilter(f.Core.Logger);

        var br = await Get(filter, shell.Handle, acceptEncoding: "br");
        var gzip = await Get(filter, shell.Handle, acceptEncoding: "gzip");
        var identity = await Get(filter, shell.Handle);
        var tags = new[] { br, gzip, identity }.Select(c => c.Response.Headers.ETag.ToString()).ToArray();
        Assert.Equal(3, tags.Distinct().Count());
        Assert.All(tags, t => Assert.Matches("^\"[0-9a-f]{32}\"$", t));
        Assert.All(new[] { br, gzip, identity }, c =>
        {
            Assert.Equal(0, c.Response.Headers.LastModified.Count);
            Assert.Equal(0, c.Response.Headers.AcceptRanges.Count);
            Assert.Equal("no-cache", c.Response.Headers.CacheControl.ToString());
        });

        var notModified = await Get(filter, shell.Handle, acceptEncoding: "br", ifNoneMatch: tags[0]);
        Assert.Equal(304, notModified.Response.StatusCode);
        Assert.Empty(Raw(notModified));
        Assert.Equal(tags[0], notModified.Response.Headers.ETag.ToString());
        Assert.Equal("Accept-Encoding", notModified.Response.Headers.Vary.ToString());
        Assert.Equal(0, notModified.Response.Headers.ContentEncoding.Count);
        Assert.Null(notModified.Response.ContentLength);

        // Weak comparison (an intermediary may weaken the tag) and lists.
        Assert.Equal(304, (await Get(filter, shell.Handle, acceptEncoding: "gzip", ifNoneMatch: "\"x\", W/" + tags[1])).Response.StatusCode);
        Assert.Equal(304, (await Get(filter, shell.Handle, ifNoneMatch: "*")).Response.StatusCode);
        // The brotli tag does not validate the gzip representation.
        var other = await Get(filter, shell.Handle, acceptEncoding: "gzip", ifNoneMatch: tags[0]);
        Assert.Equal(200, other.Response.StatusCode);
        Assert.Equal(tags[1], other.Response.Headers.ETag.ToString());

        // If-Match is evaluated against the injected page, strongly.
        Assert.Equal(200, (await Get(filter, shell.Handle, acceptEncoding: "br", ifMatch: tags[0])).Response.StatusCode);
        Assert.Equal(412, (await Get(filter, shell.Handle, acceptEncoding: "br", ifMatch: "\"stale\"")).Response.StatusCode);
    }

    [Fact]
    public async Task WarmRequestsRevalidateTheSourceWithoutABodyAndSurviveARestart()
    {
        using var f = new ApiPluginFixture();
        var shell = new StaticShell();
        var filter = new ScriptInjectionStartupFilter(f.Core.Logger);

        var first = await Get(filter, shell.Handle, acceptEncoding: "br");
        var etag = first.Response.Headers.ETag.ToString();
        Assert.False(shell.Seen[0].ContainsKey("If-None-Match"));
        Assert.Equal(1, shell.BodiesSent);

        // Warm: the client's validator (for the injected page) never reaches the static handler;
        // the source validator the entry was built from does, and the source answers 304.
        var warm = await Get(filter, shell.Handle, acceptEncoding: "br", ifNoneMatch: etag);
        Assert.Equal(304, warm.Response.StatusCode);
        Assert.Equal(shell.ETag, shell.Seen[1]["If-None-Match"]);
        Assert.Equal(shell.LastModified, shell.Seen[1]["If-Modified-Since"]);
        Assert.Equal(1, shell.BodiesSent);
        // A warm request without validators gets the cached page, still without a source body.
        var cached = await Get(filter, shell.Handle, acceptEncoding: "br");
        Assert.Equal(200, cached.Response.StatusCode);
        Assert.Equal(Raw(first), Raw(cached));
        Assert.Equal(1, shell.BodiesSent);
        // The client's own request headers are restored after the pipeline ran.
        Assert.Equal(etag, warm.Request.Headers.IfNoneMatch.ToString());

        // A restart (new filter, cold cache) gives the same ETag for the same page, so the
        // browser's cached copy still validates.
        var restarted = new ScriptInjectionStartupFilter(f.Core.Logger);
        var cold = await Get(restarted, shell.Handle, acceptEncoding: "br", ifNoneMatch: etag);
        Assert.Equal(304, cold.Response.StatusCode);
        Assert.False(shell.Seen[3].ContainsKey("If-None-Match"));

        // A changed index.html (jellyfin-web update) is a 200 with a new ETag, and replaces the entry.
        shell.Content = Shell.Replace("Jellyfin</title>", "Jellyfin 12.5</title>");
        shell.ETag = "\"2ee\"";
        var changed = await Get(filter, shell.Handle, acceptEncoding: "br", ifNoneMatch: etag);
        Assert.Equal(200, changed.Response.StatusCode);
        Assert.NotEqual(etag, changed.Response.Headers.ETag.ToString());
        Assert.Contains("Jellyfin 12.5", Decoded(changed));
        Assert.Contains(f.Plugin.BuildScriptTag(), Decoded(changed));
    }

    [Fact]
    public async Task ANewScriptTagIsNotServedFromAnEntryBuiltForTheOldOne()
    {
        using var f = new ApiPluginFixture();
        var shell = new StaticShell();
        var filter = new ScriptInjectionStartupFilter(f.Core.Logger);
        var before = await Get(filter, shell.Handle);
        f.Plugin.Configuration.DevMode = !f.Plugin.Configuration.DevMode;   // changes BuildScriptTag's dev="…"
        var after = await Get(filter, shell.Handle, ifNoneMatch: before.Response.Headers.ETag.ToString());
        Assert.Equal(200, after.Response.StatusCode);
        Assert.Equal(Expected(Shell, f.Plugin.BuildScriptTag()), Decoded(after));
        Assert.False(shell.Seen[1].ContainsKey("If-None-Match"));
    }

    [Theory]
    [InlineData("<html><body>日本語</body></html>")]
    [InlineData("<html><BODY>a</body><p>b</p></BODY></html>")]
    [InlineData("<body><script src='../JellyfinEnhanced/script?v=old'></script></body>")]
    [InlineData("<html>No body closing tag</html>")]
    [InlineData(Shell)]
    public async Task InjectedContentIsByteForByteThePreK3aRewriteInEveryEncoding(string page)
    {
        using var f = new ApiPluginFixture();
        var shell = new StaticShell { Content = page };
        var filter = new ScriptInjectionStartupFilter(f.Core.Logger);
        var tag = f.Plugin.BuildScriptTag();
        var expected = page.Contains("/JellyfinEnhanced/script", StringComparison.OrdinalIgnoreCase) || !page.Contains("</body>", StringComparison.OrdinalIgnoreCase)
            ? page
            : Expected(page, tag);
        foreach (var encoding in new[] { "br", "gzip", null })
        {
            var context = await Get(filter, shell.Handle, acceptEncoding: encoding);
            Assert.Equal(expected, Decoded(context));
            Assert.Equal("text/html;charset=utf-8", context.Response.ContentType);
        }

        Assert.True(expected.Split(tag).Length <= 2, "the tag is injected at most once");
    }

    [Fact]
    public async Task ASourceLargerThanTheCaptureLimitStreamsThroughUnchangedWithoutBeingBuffered()
    {
        using var f = new ApiPluginFixture();
        var chunk = Encoding.UTF8.GetBytes(new string('x', 64 * 1024));
        var total = ScriptInjectionStartupFilter.MaxCaptureBytes + 3 * chunk.Length;
        var real = new MemoryStream();
        var realLengthWhileCapturing = new List<long>();
        var filter = new ScriptInjectionStartupFilter(f.Core.Logger);
        var context = await Get(filter, async c =>
        {
            c.Response.ContentType = "text/html";
            c.Response.Headers.ETag = "\"big\"";
            for (var written = 0; written < total; written += chunk.Length)
            {
                await c.Response.Body.WriteAsync(chunk);
                realLengthWhileCapturing.Add(real.Length);
            }

            await c.Response.Body.WriteAsync(Encoding.UTF8.GetBytes("</body>"));
        }, body: real);

        // Nothing reaches the real stream while under the limit; from the first write past it,
        // every byte written so far is on the real stream: at most MaxCaptureBytes were ever held.
        var underLimit = ScriptInjectionStartupFilter.MaxCaptureBytes / chunk.Length;
        Assert.All(realLengthWhileCapturing.Take(underLimit), length => Assert.Equal(0, length));
        Assert.All(realLengthWhileCapturing.Skip(underLimit).Select((length, i) => (length, i)),
            x => Assert.Equal((long)(underLimit + x.i + 1) * chunk.Length, x.length));
        Assert.Equal(total + 7, real.Length);
        Assert.DoesNotContain("JellyfinEnhanced/script", Encoding.UTF8.GetString(real.ToArray()));
        Assert.Equal("\"big\"", context.Response.Headers.ETag.ToString());
        Assert.Equal(0, filter.CachedEntryCount);
    }

    [Fact]
    public async Task TheCacheHoldsABoundedNumberOfEntriesAndNeverAnIncompleteOrUnvalidatablePage()
    {
        using var f = new ApiPluginFixture();
        var shell = new StaticShell();
        var filter = new ScriptInjectionStartupFilter(f.Core.Logger);
        foreach (var prefix in Enumerable.Range(0, 3 * ScriptInjectionStartupFilter.MaxCachedEntries))
        {
            await Get(filter, shell.Handle, path: $"/base{prefix}/web/");
        }

        Assert.Equal(ScriptInjectionStartupFilter.MaxCachedEntries, filter.CachedEntryCount);

        // A body shorter than its Content-Length (a send cut short) is served but not cached.
        var cut = new ScriptInjectionStartupFilter(f.Core.Logger);
        await Get(cut, async c =>
        {
            c.Response.ContentType = "text/html";
            c.Response.Headers.ETag = "\"cut\"";
            c.Response.ContentLength = 10_000;
            await c.Response.WriteAsync(Shell);
        });
        Assert.Equal(0, cut.CachedEntryCount);

        // A source without ETag or Last-Modified cannot be revalidated, so it is not cached.
        var bare = new ScriptInjectionStartupFilter(f.Core.Logger);
        var served = await Get(bare, async c => { c.Response.ContentType = "text/html"; await c.Response.WriteAsync(Shell); }, acceptEncoding: "br");
        Assert.Equal("br", served.Response.Headers.ContentEncoding.ToString());
        Assert.Equal(0, bare.CachedEntryCount);
    }
}
