#pragma warning disable ASPDEPR004, ASPDEPR008 // TestServer over WebHostBuilder, as the other MVC harnesses here.
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Data.Enums;
using Jellyfin.Extensions.Json;
using Jellyfin.Plugin.JellyfinEnhanced;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ApplicationParts;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace JE.Tests;

/// <summary>The answers the byte-boundary tests ask for: a list's DTO in the host's shapes and character sets, an answer
/// that waits while the test changes the evidence, a streamed one, and a very large library answer.</summary>
[Route("je-legacy-boundary")]
public sealed class LegacyBoundaryController(LegacyBoundaryScenario scenario) : ControllerBase
{
    [HttpGet("late/{id}")]
    public async Task<IActionResult> Late(Guid id)
    {
        scenario.Entered.TrySetResult();
        await scenario.Continue.Task;
        return Ok(scenario.Dto(id));
    }

    [HttpGet("dto/{variant}/{id}")]
    public IActionResult Dto(string variant, Guid id) => variant switch
    {
        "content16" => new ContentResult { Content = Encoding.UTF8.GetString(scenario.Json(id)), ContentType = "application/json; charset=utf-16" },
        "json16" => new JsonResult(new[] { scenario.Dto(id) }) { ContentType = "application/json; charset=utf-16" },
        _ => Ok(new[] { scenario.Dto(id) }),
    };

    [HttpGet("streamed/{id}")]
    public IActionResult Streamed(Guid id) => new GatedJsonResult(scenario, id);

    [HttpGet("large/{count}")]
    public IActionResult Large(int count) => Ok(Movies(count));

    [HttpGet("parts")]
    public IActionResult Parts() => Ok(scenario.Parts());

    private static async IAsyncEnumerable<BaseItemDto> Movies(int count)
    {
        var overview = new string('x', 2048);
        for (var i = 0; i < count; i++)
        {
            if (i % 10000 == 0) await Task.Yield();
            yield return new BaseItemDto { Id = new Guid(i + 1, 0, 0, new byte[8]), Type = BaseItemKind.Movie, Name = "Ordinary movie", Overview = overview, ImageTags = new() { [ImageType.Primary] = "safe" } };
        }
    }
}

/// <summary>An answer that writes its first part, then waits for the test before writing an item.</summary>
public sealed class GatedJsonResult(LegacyBoundaryScenario scenario, Guid id) : IActionResult
{
    public async Task ExecuteResultAsync(ActionContext context)
    {
        var response = context.HttpContext.Response;
        response.ContentType = "application/json; charset=utf-8";
        await response.Body.WriteAsync("{\"Items\":["u8.ToArray());
        await response.Body.FlushAsync();
        scenario.Entered.TrySetResult();
        await scenario.Continue.Task;
        await response.Body.WriteAsync(scenario.Json(id).AsMemory(1, scenario.Json(id).Length - 2));
        await response.Body.WriteAsync("]}"u8.ToArray());
    }
}

/// <summary>One test's material: lists with images, their markers, and the gates of the waiting answers.</summary>
public sealed class LegacyBoundaryScenario
{
    public required string Root { get; init; }

    public required IReadOnlyList<string> Dirs { get; init; }

    public Dictionary<Guid, BaseItem> Items { get; } = new();

    public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public TaskCompletionSource Continue { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public Guid[] PartIds { get; set; } = Array.Empty<Guid>();

    public BaseItemDto Dto(Guid id) => new()
    {
        Id = id,
        Name = "list ünïcödé ✓",
        Type = BaseItemKind.Playlist,
        ImageTags = new() { [ImageType.Primary] = "tag-" + id.ToString("N")[..8] },
        ImageBlurHashes = new() { [ImageType.Primary] = new() { ["tag-" + id.ToString("N")[..8]] = "LEHV6nWB2yk8pyo0adR*.7kCMdnj" } },
        PrimaryImageAspectRatio = 1,
    };

    public byte[] Json(Guid id) => JsonSerializer.SerializeToUtf8Bytes(new[] { Dto(id) }, JsonDefaults.PascalCaseOptions);

    // The first id's DTO, about 1.5 MiB of ordinary movies, the second id's, as much again, and the third id's.
    public IEnumerable<BaseItemDto> Parts()
    {
        var overview = new string('y', 1024);
        IEnumerable<BaseItemDto> Filler(int from) => Enumerable.Range(from, 1300).Select(i => new BaseItemDto { Id = new Guid(i + 1, 0, 0, new byte[8]), Type = BaseItemKind.Movie, Name = "Filler", Overview = overview });
        return new[] { Dto(PartIds[0]) }.Concat(Filler(0)).Append(Dto(PartIds[1])).Concat(Filler(5000)).Append(Dto(PartIds[2]));
    }

    public Playlist List(string image)
    {
        var list = new Playlist { Id = Guid.NewGuid(), Name = "list" };
        var path = Path.Combine(Root, "metadata", list.Id.ToString("N"), "folder.jpg");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, image);
        list.ImageInfos = new[] { new ItemImageInfo { Path = path, Type = ImageType.Primary, DateModified = File.GetLastWriteTimeUtc(path) } };
        Items[list.Id] = list;
        return list;
    }

    // A marker recording the list's current image as its collage.
    public void Collage(BaseItem list) => File.WriteAllText(
        Path.Combine(Dirs[0], list.Id.ToString("N") + ".json"),
        JsonSerializer.Serialize(new { listId = list.Id.ToString("N"), sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(list.ImageInfos[0].Path))).ToLowerInvariant() }));
}

// What is withheld from an answer is decided where its bytes are written, in the character set they are written in, for
// an answer of any size: evidence that appears while the action runs, or while a long answer is being written, counts.
public class ListsLegacyCollageByteBoundaryTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "je-legacy-bytes-" + Guid.NewGuid().ToString("N"));
    private readonly LegacyBoundaryScenario _scenario;
    private readonly Mock<ILibraryManager> _library = new();

    public ListsLegacyCollageByteBoundaryTests()
    {
        var dirs = LegacyCollageWithhold.MarkerDirectories(Path.Combine(_root, "configurations", "Jellyfin.Plugin.JellyfinEnhanced"));
        foreach (var dir in dirs) Directory.CreateDirectory(dir);
        _scenario = new LegacyBoundaryScenario { Root = _root, Dirs = dirs };
        _library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => _scenario.Items.GetValueOrDefault(id));
    }

    public void Dispose() => Directory.Delete(_root, recursive: true);

    private sealed class Only : IApplicationFeatureProvider<ControllerFeature>
    {
        public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature) => feature.Controllers.Add(typeof(LegacyBoundaryController).GetTypeInfo());
    }

    // The host's MVC with its JSON profile (PascalCase, UTF-8 and UTF-16 by Accept-Charset), the plugin's body boundary in
    // front when asked.
    private TestServer Server(bool filtered)
    {
        var withhold = new LegacyCollageWithhold(_scenario.Dirs, _library.Object);
        var paths = new Mock<IApplicationPaths>();
        paths.SetupGet(p => p.LogDirectoryPath).Returns(_root);
        var logger = new Logger(paths.Object, NullLoggerFactory.Instance);
        return new TestServer(new WebHostBuilder().ConfigureServices(services =>
        {
            services.AddSingleton(_scenario);
            services.AddSingleton(withhold);
            services.AddSingleton(logger);
            services.AddSingleton<LegacyCollageBody>();
            services.AddControllers(o =>
                {
                    o.RespectBrowserAcceptHeader = true;
                    if (filtered) o.Filters.AddService<LegacyCollageBody>(LegacyCollageBody.Order);
                })
                .ConfigureApplicationPartManager(p =>
                {
                    p.ApplicationParts.Clear();
                    p.ApplicationParts.Add(new AssemblyPart(typeof(LegacyBoundaryController).Assembly));
                    p.FeatureProviders.Clear();
                    p.FeatureProviders.Add(new Only());
                })
                .AddJsonOptions(o =>
                {
                    o.JsonSerializerOptions.PropertyNamingPolicy = null;
                    foreach (var c in JsonDefaults.PascalCaseOptions.Converters) o.JsonSerializerOptions.Converters.Add(c);
                });
        }).Configure(app => { app.UseRouting(); app.UseEndpoints(e => e.MapControllers()); }));
    }

    private static async Task<(int Status, byte[] Body, string? Type)> Get(HttpClient client, string path, string? charset = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.TryAddWithoutValidation("Accept", "application/json");
        if (charset != null) request.Headers.TryAddWithoutValidation("Accept-Charset", charset);
        using var response = await client.SendAsync(request);
        return ((int)response.StatusCode, await response.Content.ReadAsByteArrayAsync(), response.Content.Headers.ContentType?.ToString());
    }

    // ── a marker created while the action runs (COLLAGE-R3-1) ────────────

    [Fact]
    public async Task AMarkerCreatedWhileTheActionRunsWithholdsWhatTheAnswerWrites()
    {
        _scenario.Collage(_scenario.List("unrelated collage"));
        var list = _scenario.List("owner image");
        using var server = Server(filtered: true);
        using var client = server.CreateClient();
        var answer = Get(client, "/je-legacy-boundary/late/" + list.Id.ToString("N"));
        await _scenario.Entered.Task.WaitAsync(TimeSpan.FromSeconds(20));
        // Meanwhile the list's image turns out to be a collage.
        _scenario.Collage(list);
        _scenario.Continue.SetResult();
        var (status, body, _) = await answer;
        var text = Encoding.UTF8.GetString(body);
        Assert.Equal(200, status);
        Assert.DoesNotContain("tag-" + list.Id.ToString("N")[..8], text, StringComparison.Ordinal);
        Assert.Contains("list ünïcödé ✓", text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AMarkerCreatedWhileTheActionRunsCountsEvenWhenThereWasNothingToWithholdBefore()
    {
        var list = _scenario.List("owner image");
        using var server = Server(filtered: true);
        using var client = server.CreateClient();
        var answer = Get(client, "/je-legacy-boundary/late/" + list.Id.ToString("N"));
        await _scenario.Entered.Task.WaitAsync(TimeSpan.FromSeconds(20));
        _scenario.Collage(list);
        _scenario.Continue.SetResult();
        var (status, body, _) = await answer;
        Assert.Equal(200, status);
        Assert.DoesNotContain("tag-", Encoding.UTF8.GetString(body), StringComparison.Ordinal);
    }

    [Fact]
    public async Task AMarkerCreatedAfterAnAnswerStartedPassingCutsItOffBeforeTheItemIsWritten()
    {
        var list = _scenario.List("owner image");
        using var server = Server(filtered: true);
        using var client = server.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/je-legacy-boundary/streamed/" + list.Id.ToString("N"));
        var sending = client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
        await _scenario.Entered.Task.WaitAsync(TimeSpan.FromSeconds(20));
        // The first part went out while nothing was withheld; then the list's image turns out to be a collage.
        _scenario.Collage(list);
        _scenario.Continue.SetResult();
        var received = new MemoryStream();
        var failed = false;
        try
        {
            using var response = await sending;
            await (await response.Content.ReadAsStreamAsync()).CopyToAsync(received);
        }
        catch (Exception ex) when (ex is IOException or HttpRequestException or OperationCanceledException)
        {
            failed = true;
        }

        var text = Encoding.UTF8.GetString(received.ToArray());
        Assert.DoesNotContain("tag-", text, StringComparison.Ordinal);
        Assert.True(failed || !text.EndsWith("]}", StringComparison.Ordinal), "the answer was sent whole: " + text);
    }

    // ── a long answer is checked before each part (re-checked per flush) ──

    // Reads an answer as it arrives; once its bytes hold "seen", runs "then" (the server is held back by the reader, so
    // the rest of the answer is still to be written).
    private static async Task<(string Text, bool Failed)> Reading(HttpClient client, string path, string seen, Action then)
    {
        var received = new MemoryStream();
        var failed = false;
        var done = false;
        try
        {
            using var response = await client.GetAsync(path, HttpCompletionOption.ResponseHeadersRead);
            Assert.Equal(200, (int)response.StatusCode);
            await using var stream = await response.Content.ReadAsStreamAsync();
            var buffer = new byte[16 * 1024];
            var needle = Encoding.UTF8.GetBytes(seen);
            int read;
            while ((read = await stream.ReadAsync(buffer)) > 0)
            {
                received.Write(buffer, 0, read);
                var from = (int)Math.Max(0, received.Length - read - needle.Length);
                if (!done && received.GetBuffer().AsSpan(from, (int)received.Length - from).IndexOf(needle) >= 0)
                {
                    done = true;
                    then();
                }
            }
        }
        catch (Exception ex) when (ex is IOException or HttpRequestException or OperationCanceledException)
        {
            failed = true;
        }

        Assert.True(done, "never saw " + seen);
        return (Encoding.UTF8.GetString(received.ToArray()), failed);
    }

    [Fact]
    public async Task AnItemWithheldWhileALongAnswerIsWrittenIsTakenOutOfWhatIsStillToBeWritten()
    {
        var first = _scenario.List("first collage");
        var middle = _scenario.List("middle owner image");
        var last = _scenario.List("last owner image");
        _scenario.Collage(first);
        _scenario.PartIds = new[] { first.Id, middle.Id, last.Id };
        using var server = Server(filtered: true);
        using var client = server.CreateClient();
        // Once the middle list is out, the last list's image turns out to be a collage.
        var (text, failed) = await Reading(client, "/je-legacy-boundary/parts", "tag-" + middle.Id.ToString("N")[..8], () => _scenario.Collage(last));
        Assert.False(failed);
        Assert.DoesNotContain("tag-" + first.Id.ToString("N")[..8], text, StringComparison.Ordinal);
        Assert.Contains("tag-" + middle.Id.ToString("N")[..8], text, StringComparison.Ordinal);
        Assert.DoesNotContain("tag-" + last.Id.ToString("N")[..8], text, StringComparison.Ordinal);
        Assert.Equal(2603, JsonNode.Parse(text)!.AsArray().Count);
    }

    [Fact]
    public async Task EvidenceThatGoesAwayWhileALongAnswerIsWrittenLeavesItWholeAsItWasProjected()
    {
        var first = _scenario.List("first collage");
        var middle = _scenario.List("middle owner image");
        var last = _scenario.List("last owner image");
        _scenario.Collage(first);
        _scenario.PartIds = new[] { first.Id, middle.Id, last.Id };
        using var server = Server(filtered: true);
        using var client = server.CreateClient();
        // Once the middle list is out, the first list's marker goes: the answer still goes out whole, one projection.
        var (text, failed) = await Reading(client, "/je-legacy-boundary/parts", "tag-" + middle.Id.ToString("N")[..8], () => File.Delete(Path.Combine(_scenario.Dirs[0], first.Id.ToString("N") + ".json")));
        Assert.False(failed);
        Assert.DoesNotContain("tag-" + first.Id.ToString("N")[..8], text, StringComparison.Ordinal);
        Assert.Contains("tag-" + last.Id.ToString("N")[..8], text, StringComparison.Ordinal);
        Assert.Equal(2603, JsonNode.Parse(text)!.AsArray().Count);
    }

    [Fact]
    public async Task AnItemWithheldAfterItWasWrittenCutsTheRestOfTheAnswerOff()
    {
        var first = _scenario.List("first collage");
        var middle = _scenario.List("middle owner image");
        var last = _scenario.List("last owner image");
        _scenario.Collage(first);
        _scenario.PartIds = new[] { first.Id, middle.Id, last.Id };
        using var server = Server(filtered: true);
        using var client = server.CreateClient();
        // The middle list's DTO is already out when its image turns out to be a collage: the rest isn't sent.
        var (text, failed) = await Reading(client, "/je-legacy-boundary/parts", "tag-" + middle.Id.ToString("N")[..8], () => _scenario.Collage(middle));
        Assert.True(failed || !text.EndsWith("]", StringComparison.Ordinal), "the answer was sent whole");
        Assert.DoesNotContain("tag-" + last.Id.ToString("N")[..8], text, StringComparison.Ordinal);
    }

    // ── the character set the answer was negotiated in (COLLAGE-R3-4) ────

    [Theory]
    [InlineData("object", "utf-16")]
    [InlineData("content16", null)]
    [InlineData("json16", null)]
    public async Task AnAnswerInUtf16WithNothingWithheldIsSentByteForByte(string variant, string? charset)
    {
        _scenario.Collage(_scenario.List("unrelated collage"));
        var list = _scenario.List("owner image");
        var path = "/je-legacy-boundary/dto/" + variant + "/" + list.Id.ToString("N");
        (int Status, byte[] Body, string? Type) plain, checkedAnswer;
        using (var server = Server(filtered: false))
        using (var client = server.CreateClient())
            plain = await Get(client, path, charset);
        using (var server = Server(filtered: true))
        using (var client = server.CreateClient())
            checkedAnswer = await Get(client, path, charset);

        Assert.Equal(200, plain.Status);
        Assert.Contains("utf-16", plain.Type, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(200, checkedAnswer.Status);
        Assert.Equal(plain.Type, checkedAnswer.Type);
        Assert.Equal(plain.Body, checkedAnswer.Body);
        Assert.Contains("tag-", Encoding.Unicode.GetString(checkedAnswer.Body), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("object", "utf-16")]
    [InlineData("content16", null)]
    [InlineData("json16", null)]
    public async Task AWithheldListInAUtf16AnswerLosesItsImageAndTheAnswerStaysUtf16(string variant, string? charset)
    {
        var list = _scenario.List("legacy collage");
        _scenario.Collage(list);
        var path = "/je-legacy-boundary/dto/" + variant + "/" + list.Id.ToString("N");
        (int Status, byte[] Body, string? Type) plain, checkedAnswer;
        using (var server = Server(filtered: false))
        using (var client = server.CreateClient())
            plain = await Get(client, path, charset);
        using (var server = Server(filtered: true))
        using (var client = server.CreateClient())
            checkedAnswer = await Get(client, path, charset);

        Assert.Equal(200, checkedAnswer.Status);
        Assert.Equal(plain.Type, checkedAnswer.Type);
        // What the projection takes out of the same text in UTF-8, written back in UTF-16 (no byte order mark added).
        var utf8 = Encoding.UTF8.GetBytes(Encoding.Unicode.GetString(plain.Body));
        Assert.Equal(LegacyCollageProjected.Changed, LegacyCollageProjection.Project(utf8, new LegacyCollageWithhold(_scenario.Dirs, _library.Object).Begin(), out var projected));
        Assert.Equal(Encoding.Unicode.GetBytes(Encoding.UTF8.GetString(projected!)), checkedAnswer.Body);
        var text = Encoding.Unicode.GetString(checkedAnswer.Body);
        Assert.DoesNotContain("tag-", text, StringComparison.Ordinal);
        Assert.Equal("list ünïcödé ✓", JsonNode.Parse(text)![0]!["Name"]!.GetValue<string>());
    }

    // ── an answer of any size (COLLAGE-R3-6) ─────────────────────────────

    [Fact]
    public async Task AVeryLargeLibraryAnswerIsSentWholeWhileAnUnrelatedMarkerExists()
    {
        _scenario.Collage(_scenario.List("unrelated collage"));
        const int Movies = 30_000;
        using var server = Server(filtered: true);
        using var client = server.CreateClient();
        using var response = await client.GetAsync("/je-legacy-boundary/large/" + Movies, HttpCompletionOption.ResponseHeadersRead);
        Assert.Equal(200, (int)response.StatusCode);
        await using var stream = await response.Content.ReadAsStreamAsync();
        var buffer = new byte[1 << 16];
        var marker = "\"Type\":\"Movie\""u8.ToArray();
        long bytes = 0;
        var found = 0;
        var carry = Array.Empty<byte>();
        byte last = 0;
        int read;
        while ((read = await stream.ReadAsync(buffer)) > 0)
        {
            var window = new byte[carry.Length + read];
            carry.CopyTo(window, 0);
            Buffer.BlockCopy(buffer, 0, window, carry.Length, read);
            for (var i = window.AsSpan().IndexOf(marker); i >= 0;)
            {
                found++;
                var next = window.AsSpan(i + 1).IndexOf(marker);
                i = next < 0 ? -1 : i + 1 + next;
            }

            carry = window.Length >= marker.Length - 1 ? window[^(marker.Length - 1)..] : window;
            bytes += read;
            last = buffer[read - 1];
        }

        // Larger than any bound a held answer once had, and every item is in it.
        Assert.True(bytes > 130L * 1024 * 1024, bytes + " bytes");
        Assert.Equal(Movies, found);
        Assert.Equal((byte)']', last);
    }

    [Fact]
    public void AnAnswerWithNothingWithheldIsCheckedWithoutCopyingIt()
    {
        _scenario.Collage(_scenario.List("unrelated collage"));
        var withhold = new LegacyCollageWithhold(_scenario.Dirs, _library.Object);
        var dtos = Enumerable.Range(0, 2000).Select(i => new BaseItemDto
        {
            Id = Guid.NewGuid(), Type = BaseItemKind.Movie, Name = "Ordinary movie", Overview = new string('x', 900),
            ImageTags = new() { [ImageType.Primary] = "abc", [ImageType.Thumb] = "def" },
            ImageBlurHashes = new() { [ImageType.Primary] = new() { ["abc"] = "LEHV6nWB2yk8pyo0adR*.7kCMdnj" } },
            PrimaryImageAspectRatio = .67,
            People = Enumerable.Range(0, 10).Select(p => new BaseItemPerson { Id = Guid.NewGuid(), Name = "Person " + p, Role = "Role", PrimaryImageTag = "t" }).ToArray(),
            BackdropImageTags = new[] { "b" },
        }).ToArray();
        var json = JsonSerializer.SerializeToUtf8Bytes(new { Items = dtos }, JsonDefaults.PascalCaseOptions);
        LegacyCollageProjection.Project(json, withhold.Begin(), out _);
        var view = withhold.Begin();
        var before = GC.GetAllocatedBytesForCurrentThread();
        var outcome = LegacyCollageProjection.Project(json, view, out var projected);
        var allocated = GC.GetAllocatedBytesForCurrentThread() - before;
        Assert.Equal(LegacyCollageProjected.Unchanged, outcome);
        Assert.Null(projected);
        Assert.True(allocated < json.Length / 8, $"{allocated} bytes allocated to check {json.Length}");
    }
}
