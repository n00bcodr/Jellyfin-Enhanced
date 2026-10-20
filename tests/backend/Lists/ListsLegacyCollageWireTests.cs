using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace JE.Tests;

// The projection works on the payload as the host wrote it: exact keys (the host's spelling and its camelCase
// profile's), only the recognized image fields of withheld items, every other byte as it was, and no payload makes it
// throw or drop a message that has nothing withheld in it.
public class ListsLegacyCollageWireTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "je-legacy-wire-" + Guid.NewGuid().ToString("N"));
    private readonly IReadOnlyList<string> _dirs;
    private readonly Dictionary<Guid, BaseItem> _items = new();
    private readonly Mock<ILibraryManager> _library = new();
    private readonly Playlist _legacy;
    private readonly Playlist _owner;

    public ListsLegacyCollageWireTests()
    {
        _dirs = LegacyCollageWithhold.MarkerDirectories(Path.Combine(_root, "configurations", "Jellyfin.Plugin.JellyfinEnhanced"));
        foreach (var dir in _dirs) Directory.CreateDirectory(dir);
        _library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => _items.GetValueOrDefault(id));
        // A list whose image is its collage, and one whose owner set an image later: both have markers, so every
        // payload naming either is looked at.
        _legacy = List(1, collage: true);
        _owner = List(2, collage: false);
    }

    public void Dispose() => Directory.Delete(_root, recursive: true);

    private Playlist List(int seed, bool collage)
    {
        var list = new Playlist { Id = Guid.NewGuid(), Name = "list" };
        var bytes = new byte[256];
        new Random(seed).NextBytes(bytes);
        var path = Path.Combine(_root, "metadata", list.Id.ToString("N"), "folder.jpg");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllBytes(path, bytes);
        list.ImageInfos = new[] { new ItemImageInfo { Path = path, Type = ImageType.Primary } };
        var sha = Convert.ToHexString(SHA256.HashData(collage ? bytes : new byte[] { 1 })).ToLowerInvariant();
        File.WriteAllText(Path.Combine(_dirs[0], list.Id.ToString("N") + ".json"), JsonSerializer.Serialize(new { listId = list.Id.ToString("N"), sha256 = sha }));
        _items[list.Id] = list;
        return list;
    }

    private LegacyCollageWithhold New() => new(_dirs, _library.Object);

    private Logger Logger()
    {
        var paths = new Mock<IApplicationPaths>();
        paths.SetupGet(p => p.LogDirectoryPath).Returns(_root);
        return new Logger(paths.Object, NullLoggerFactory.Instance);
    }

    private sealed class Recording : WebSocket
    {
        public List<byte[]> Sent { get; } = new();
        public override WebSocketCloseStatus? CloseStatus => null;
        public override string? CloseStatusDescription => null;
        public override WebSocketState State => WebSocketState.Open;
        public override string? SubProtocol => null;
        public override void Abort() { }
        public override Task CloseAsync(WebSocketCloseStatus closeStatus, string? statusDescription, CancellationToken cancellationToken) => Task.CompletedTask;
        public override Task CloseOutputAsync(WebSocketCloseStatus closeStatus, string? statusDescription, CancellationToken cancellationToken) => Task.CompletedTask;
        public override void Dispose() { }
        public override Task<WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> buffer, CancellationToken cancellationToken) => throw new NotSupportedException();
        public override Task SendAsync(ArraySegment<byte> buffer, WebSocketMessageType messageType, bool endOfMessage, CancellationToken cancellationToken)
        {
            Sent.Add(buffer.ToArray());
            return Task.CompletedTask;
        }
    }

    // What JE's socket sends for one host message.
    private async Task<List<byte[]>> Through(string message)
    {
        var inner = new Recording();
        var socket = new LegacyCollageSockets.ProjectingSocket(inner, New(), Logger());
        await socket.SendAsync(Encoding.UTF8.GetBytes(message), WebSocketMessageType.Text, true, CancellationToken.None);
        return inner.Sent;
    }

    private string N(BaseItem item) => item.Id.ToString("N");

    // ── COLLAGE-R2-4 ─────────────────────────────────────────────────────

    [Fact]
    public async Task ADashboardMessageWhoseArgumentsDifferOnlyInCaseLeavesByteForByte()
    {
        var message = "{\"MessageType\":\"GeneralCommand\",\"MessageId\":\"0a1b2c3d4e5f40618293a4b5c6d7e8f9\",\"Data\":{\"Name\":\"DisplayMessage\",\"ControllingUserId\":\"4f0c0a1a6d554c349a8d3b1b2c5d6e7f\",\"Arguments\":{\"Header\":\"Notice\",\"Text\":\"Maintenance\",\"text\":\"twin\",\"TimeoutMs\":\"5000\"}}}";
        var sent = Assert.Single(await Through(message));
        Assert.Equal(message, Encoding.UTF8.GetString(sent));
    }

    [Theory]
    // Keys that differ only in case, in item objects too.
    [InlineData("{\"Data\":{\"Id\":\"{owner}\",\"id\":\"{owner}\",\"ImageTags\":{\"Primary\":\"a\",\"primary\":\"b\"}}}")]
    // The same key twice (a client reading it keeps the last).
    [InlineData("{\"Data\":{\"Id\":\"{owner}\",\"Id\":\"{owner}\",\"ImageTags\":{\"Primary\":\"a\"}}}")]
    // Escapes, white space, number spellings and text a re-encoding would change.
    [InlineData("{ \"Data\" : [ {\"\\u0049d\":\"{owner}\", \"Name\":\"Am\\u00e9lie \\ud83c\\udfac <b>&amp;</b>\", \"N\":1.50e+2, \"M\":-0.0, \"ImageTags\":{\"Primary\":\"a\"}} ] }\n")]
    // An escaped lone surrogate, deep nesting, empty containers.
    [InlineData("{\"Data\":{\"Name\":\"\\ud800\",\"Deep\":[[[[[[[[[[[[[[[[[[[[{\"Id\":\"{owner}\"}]]]]]]]]]]]]]]]]]]]],\"E\":{},\"A\":[]}}")]
    // Not an item id at all, and ids in other spellings.
    [InlineData("{\"Id\":7,\"ParentPrimaryImageItemId\":null,\"ThumbImageItemId\":\"{owner-D}\",\"ParentThumbItemId\":\"{owner-B}\"}")]
    public async Task APayloadWithNothingWithheldLeavesByteForByteWhateverItsJson(string template)
    {
        var message = template.Replace("{owner}", N(_owner), StringComparison.Ordinal).Replace("{owner-D}", _owner.Id.ToString("D"), StringComparison.Ordinal).Replace("{owner-B}", _owner.Id.ToString("B"), StringComparison.Ordinal);
        var sent = Assert.Single(await Through(message));
        Assert.Equal(message, Encoding.UTF8.GetString(sent));
    }

    [Fact]
    public async Task AWithheldListLosesOnlyItsRecognizedImageFieldsAndEveryOtherByteStays()
    {
        var message = "{ \"MessageType\" : \"Sessions\", \"Data\": [ {\"NowViewingItem\": {\"Name\":\"Am\\u00e9lie ✓ <b>&</b>\", \"Id\":\"" + N(_legacy)
            + "\", \"Type\":\"Playlist\", \"Score\": 1.50e+2, \"ImageTags\":{\"Primary\":\"p\",\"Backdrop\":\"b\"}, \"PrimaryImageAspectRatio\":1.0, \"BackdropImageTags\":[\"b\"]}} ] }";
        var expected = message.Replace("\"Primary\":\"p\",", string.Empty, StringComparison.Ordinal).Replace("\"PrimaryImageAspectRatio\":1.0, ", string.Empty, StringComparison.Ordinal);
        Assert.Equal(expected, Encoding.UTF8.GetString(Assert.Single(await Through(message))));
    }

    [Fact]
    public async Task AWithheldListKeepsEveryByteOutsideTheObjectThatNamesIt()
    {
        var other = "{\"Name\":\"Am\\u00e9lie ✓\",\"N\":1.50e+2,\"Id\":\"" + N(_owner) + "\",\"ImageTags\":{\"Primary\":\"o\"}}";
        var message = "{ \"Data\" : [ " + other + " , {\"Id\":\"" + N(_legacy) + "\",\"ImageTags\":{\"Primary\":\"p\"}} ] }";
        var text = Encoding.UTF8.GetString(Assert.Single(await Through(message)));
        Assert.StartsWith("{ \"Data\" : ", text, StringComparison.Ordinal);
        Assert.Contains(other, text, StringComparison.Ordinal);
        Assert.Contains("{\"Id\":\"" + N(_legacy) + "\",\"ImageTags\":{}}", text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task KeysAreMatchedInTheHostsSpellingAndItsCamelCaseProfilesOnly()
    {
        var message = "[{\"ID\":\"" + N(_legacy) + "\",\"IMAGETAGS\":{\"Primary\":\"a\"}},"
            + "{\"id\":\"" + N(_legacy) + "\",\"imageTags\":{\"Primary\":\"b\",\"primary\":\"c\"},\"primaryImageAspectRatio\":1,\"hasPrimaryImage\":true},"
            + "{\"Id\":\"" + N(_legacy) + "\",\"ImageBlurHashes\":{\"Primary\":{\"t\":\"h\"},\"PRIMARY\":{\"t\":\"h\"}},\"PrimaryImageTag\":\"t\"}]";
        var text = Encoding.UTF8.GetString(Assert.Single(await Through(message)));
        Assert.Equal(
            "[{\"ID\":\"" + N(_legacy) + "\",\"IMAGETAGS\":{\"Primary\":\"a\"}},"
            + "{\"id\":\"" + N(_legacy) + "\",\"imageTags\":{\"primary\":\"c\"},\"hasPrimaryImage\":false},"
            + "{\"Id\":\"" + N(_legacy) + "\",\"ImageBlurHashes\":{\"PRIMARY\":{\"t\":\"h\"}}}]",
            text);
    }

    [Fact]
    public async Task AnEscapedKeyIsReadAsTheClientReadsIt()
    {
        var message = "{\"\\u0049d\":\"" + N(_legacy) + "\",\"Image\\u0054ags\":{\"Prim\\u0061ry\":\"p\"}}";
        Assert.Equal("{\"\\u0049d\":\"" + N(_legacy) + "\",\"Image\\u0054ags\":{}}", Encoding.UTF8.GetString(Assert.Single(await Through(message))));
    }

    // ── never throws ─────────────────────────────────────────────────────

    [Fact]
    public async Task NoPayloadMakesTheProjectionThrowAndEveryValidOneIsSent()
    {
        var seeds = new[]
        {
            "{\"MessageType\":\"Sessions\",\"Data\":[{\"NowViewingItem\":{\"Id\":\"" + N(_legacy) + "\",\"Type\":\"Playlist\",\"ImageTags\":{\"Primary\":\"p\"},\"ImageBlurHashes\":{\"Primary\":{\"p\":\"h\"}},\"ParentPrimaryImageItemId\":\"" + N(_legacy) + "\",\"ParentPrimaryImageTag\":\"p\"}}]}",
            "{\"Data\":{\"Arguments\":{\"Text\":\"a\",\"text\":\"b\",\"TEXT\":\"c\"},\"Id\":\"" + N(_owner) + "\"}}",
            "[1,2.5e-3,true,false,null,\"\\ud800\",{\"a\":{\"b\":[{\"Id\":\"" + N(_legacy) + "\",\"HasPrimaryImage\":true}]}}]",
        };
        var random = new Random(4711);
        var withhold = New();
        var tried = 0;
        var valid = 0;
        foreach (var seed in seeds)
        {
            for (var round = 0; round < 400; round++)
            {
                var bytes = Mutate(Encoding.UTF8.GetBytes(seed), random);
                tried++;
                // The projection itself: an outcome, never an exception.
                var outcome = LegacyCollageProjection.Project(bytes, withhold.Begin(), out var projected);
                var isJson = IsJson(bytes);
                Assert.True(isJson == (outcome != LegacyCollageProjected.NotJson), Encoding.UTF8.GetString(bytes));
                if (outcome == LegacyCollageProjected.Changed) Assert.True(IsJson(projected!), Encoding.UTF8.GetString(projected!));
                if (outcome == LegacyCollageProjected.Unchanged) Assert.Null(projected);

                // The socket: a valid message is always sent, one way or the other.
                var inner = new Recording();
                var socket = new LegacyCollageSockets.ProjectingSocket(inner, withhold, Logger());
                await socket.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
                if (isJson)
                {
                    valid++;
                    Assert.Single(inner.Sent);
                }
            }
        }

        Assert.True(valid > tried / 4, $"{valid} of {tried} mutations were valid JSON");
    }

    private static bool IsJson(byte[] bytes)
    {
        try
        {
            // As a fetch() client reads it: a leading byte order mark is skipped.
            var start = bytes.AsSpan().StartsWith(new byte[] { 0xEF, 0xBB, 0xBF }) ? 3 : 0;
            var reader = new Utf8JsonReader(bytes.AsSpan(start), new JsonReaderOptions { MaxDepth = LegacyCollageProjection.MaxDepth });
            while (reader.Read()) { }
            return reader.BytesConsumed > 0;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static readonly string[] Pieces = { "{", "}", "[", "]", ",", ":", "\"", "\\", "\\u", "\\ud800", "null", "true", "1e9", "-0", " ", "\"Id\"", "\"id\"", "\"ImageTags\"", "\"Primary\"", "\u00e9", "\uFEFF" };

    private static byte[] Mutate(byte[] seed, Random random)
    {
        var text = Encoding.UTF8.GetString(seed);
        switch (random.Next(6))
        {
            case 0: return seed; // as it is
            case 1:
                // Duplicate an existing member (same key twice).
                var at = text.IndexOf(",\"", StringComparison.Ordinal);
                var end = at < 0 ? -1 : text.IndexOf(",\"", at + 1, StringComparison.Ordinal);
                return Encoding.UTF8.GetBytes(at < 0 || end < 0 ? text : text[..end] + text[at..end] + text[end..]);
            case 2: return Encoding.UTF8.GetBytes(text[..random.Next(text.Length)]); // truncated
            case 3:
                var i = random.Next(text.Length);
                return Encoding.UTF8.GetBytes(text[..i] + Pieces[random.Next(Pieces.Length)] + text[i..]);
            case 4: return Encoding.UTF8.GetBytes(string.Concat(Enumerable.Repeat("[", random.Next(200, 300))) + text + string.Concat(Enumerable.Repeat("]", random.Next(200, 300))));
            default:
                var bytes = (byte[])seed.Clone();
                bytes[random.Next(bytes.Length)] = (byte)random.Next(256);
                return bytes;
        }
    }

    // ── the answer body boundary ─────────────────────────────────────────

    [Theory]
    [InlineData("application/json", "Json")]
    [InlineData("application/json; charset=utf-8; profile=\"CamelCase\"", "Json")]
    [InlineData("text/json", "Json")]
    [InlineData("application/problem+json", "Json")]
    [InlineData("text/plain; charset=utf-8", "Text")]
    [InlineData(null, "Text")]
    [InlineData("", "Text")]
    [InlineData("not a media type", "Text")]
    [InlineData("image/jpeg", "Pass")]
    [InlineData("application/javascript", "Pass")]
    [InlineData("text/html", "Pass")]
    [InlineData("application/octet-stream", "Pass")]
    public void AnAnswerIsHeldForCheckingByWhatItsContentTypeSaysItIs(string? contentType, string handling)
        => Assert.Equal(handling, LegacyCollageBody.HandlingOf(contentType).ToString());
}
