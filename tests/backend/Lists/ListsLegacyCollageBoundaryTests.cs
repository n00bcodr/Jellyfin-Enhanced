using System.Net.WebSockets;
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
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Net;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Search;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace JE.Tests;

// The pieces every delivery path shares: one projection (its wire form takes out exactly what its typed form does),
// the library folder kinds a tile can belong to, the WebSocket socket (fragments, non-JSON, other frames) and its
// registration, and the tile record's clock (a list that changed while nobody looked, a record JE can't read or write).
public class ListsLegacyCollageBoundaryTests : IDisposable
{
    private const string Blur = "LEHV6nWB2yk8pyo0adR*.7kCMdnj";
    private readonly string _root = Path.Combine(Path.GetTempPath(), "je-legacy-boundary-" + Guid.NewGuid().ToString("N"));
    private readonly IReadOnlyList<string> _dirs;
    private readonly Dictionary<Guid, BaseItem> _items = new();
    private readonly Mock<ILibraryManager> _library = new();
    private DateTime _now = DateTime.UtcNow;
    private readonly List<string> _warnings = new();

    public ListsLegacyCollageBoundaryTests()
    {
        _dirs = LegacyCollageWithhold.MarkerDirectories(Path.Combine(_root, "configurations", "Jellyfin.Plugin.JellyfinEnhanced"));
        foreach (var dir in _dirs) Directory.CreateDirectory(dir);
        _library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => _items.GetValueOrDefault(id));
    }

    public void Dispose()
    {
        foreach (var path in Directory.EnumerateFileSystemEntries(_root, "*", SearchOption.AllDirectories).Prepend(_root))
            if (!OperatingSystem.IsWindows()) try { File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute); } catch (IOException) { }
        Directory.Delete(_root, recursive: true);
    }

    private LegacyCollageWithhold New() => new(_dirs, _library.Object, () => _now, _warnings.Add);

    private static byte[] Bytes(int seed)
    {
        var bytes = new byte[512];
        new Random(seed).NextBytes(bytes);
        return bytes;
    }

    private static string Sha(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private T Item<T>(T item, byte[] image, ImageType type = ImageType.Primary, DateTime? written = null) where T : BaseItem
    {
        item.Id = Guid.NewGuid();
        item.Name = typeof(T).Name;
        var path = Path.Combine(_root, "metadata", item.Id.ToString("N"), type + ".jpg");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllBytes(path, image);
        File.SetLastWriteTimeUtc(path, written ?? new DateTime(2025, 6, 1, 0, 0, 0, DateTimeKind.Utc));
        item.ImageInfos = new[] { new ItemImageInfo { Path = path, Type = type, DateModified = File.GetLastWriteTimeUtc(path) } };
        _items[item.Id] = item;
        return item;
    }

    private static void Replace(BaseItem item, byte[] bytes, DateTime written)
    {
        File.WriteAllBytes(item.ImageInfos[0].Path, bytes);
        File.SetLastWriteTimeUtc(item.ImageInfos[0].Path, written);
        item.ImageInfos[0].DateModified = written;
    }

    private void Marker(BaseItem list, byte[] collage) => File.WriteAllText(Path.Combine(_dirs[0], list.Id.ToString("N") + ".json"), JsonSerializer.Serialize(new { listId = list.Id.ToString("N"), sha256 = Sha(collage) }));

    private string StatePath => Path.Combine(Path.GetDirectoryName(_dirs[0])!, LegacyCollageWithhold.TileStateFileName);

    // ── one projection ─────────────────────────────────────────────────

    private static BaseItemDto Dto(BaseItem item, Guid? parent = null, Guid? thumbParent = null) => new()
    {
        Id = item.Id,
        Name = item.Name,
        Type = item.GetBaseItemKind(),
        CollectionType = (item as IHasCollectionType)?.CollectionType,
        ImageTags = new Dictionary<ImageType, string> { [ImageType.Primary] = "p" + item.Id.ToString("N")[..6], [ImageType.Thumb] = "t" + item.Id.ToString("N")[..6], [ImageType.Backdrop] = "b" },
        ImageBlurHashes = new Dictionary<ImageType, Dictionary<string, string>>
        {
            [ImageType.Primary] = new() { ["p" + item.Id.ToString("N")[..6]] = Blur, ["pp"] = Blur },
            [ImageType.Thumb] = new() { ["t" + item.Id.ToString("N")[..6]] = Blur, ["tt"] = Blur },
        },
        PrimaryImageAspectRatio = 1,
        ParentPrimaryImageItemId = parent,
        ParentPrimaryImageTag = parent == null ? null : "pp",
        ParentThumbItemId = thumbParent,
        ParentThumbImageTag = thumbParent == null ? null : "tt",
        BackdropImageTags = new[] { "b" },
    };

    // What the rule takes out of a DTO, written out by hand: the expectation the projection is held to.
    private static BaseItemDto Without(BaseItemDto dto, bool primary = false, bool thumb = false, bool parentPrimary = false, bool parentThumb = false)
    {
        if (primary)
        {
            dto.ImageTags!.Remove(ImageType.Primary);
            dto.ImageBlurHashes!.Remove(ImageType.Primary);
            dto.PrimaryImageAspectRatio = null;
        }

        if (thumb)
        {
            dto.ImageTags!.Remove(ImageType.Thumb);
            dto.ImageBlurHashes!.Remove(ImageType.Thumb);
        }

        if (parentPrimary)
        {
            dto.ImageBlurHashes!.GetValueOrDefault(ImageType.Primary)?.Remove(dto.ParentPrimaryImageTag!);
            dto.ParentPrimaryImageItemId = null;
            dto.ParentPrimaryImageTag = null;
        }

        if (parentThumb)
        {
            dto.ImageBlurHashes!.GetValueOrDefault(ImageType.Thumb)?.Remove(dto.ParentThumbImageTag!);
            dto.ParentThumbItemId = null;
            dto.ParentThumbImageTag = null;
        }

        return dto;
    }

    private static JsonNode? Projected(byte[] json, LegacyCollageWithhold withhold, out LegacyCollageProjected outcome)
    {
        outcome = LegacyCollageProjection.Project(json, withhold.Begin(), out var projected);
        return JsonNode.Parse(projected ?? json);
    }

    [Fact]
    public void TheProjectionTakesOutExactlyTheRulesFieldsInBothOfTheHostsJsonProfiles()
    {
        var legacy = Item(new Playlist(), Bytes(1));
        Marker(legacy, Bytes(1));
        var set = Item(new BoxSet(), Bytes(2));
        Marker(set, Bytes(20));
        var library = Item(new CollectionFolder { CollectionType = CollectionType.playlists }, Bytes(3));
        var view = Item(new UserView { ViewType = CollectionType.playlists }, Bytes(4), ImageType.Thumb);
        var movies = Item(new CollectionFolder { CollectionType = CollectionType.movies }, Bytes(5));
        var movie = Item(new Movie(), Bytes(6));
        // (DTO, expected): the legacy list loses its Primary; the playlists library and view (built while it is a
        // collage) lose Primary and Thumb; a movie pointing at them loses the references.
        var cases = new (Func<BaseItemDto> Make, Func<BaseItemDto, BaseItemDto> Expect)[]
        {
            (() => Dto(legacy), d => Without(d, primary: true)),
            (() => Dto(set), d => d),
            (() => Dto(library), d => Without(d, primary: true, thumb: true)),
            (() => Dto(view, library.Id, library.Id), d => Without(d, primary: true, thumb: true, parentPrimary: true, parentThumb: true)),
            (() => Dto(movies), d => d),
            (() => Dto(movie, legacy.Id, view.Id), d => Without(d, parentPrimary: true, parentThumb: true)),
            (() => Dto(movie, set.Id, movies.Id), d => d),
            (() => Dto(movie), d => d),
        };
        var withhold = New();
        foreach (var options in new[] { JsonDefaults.PascalCaseOptions, JsonDefaults.CamelCaseOptions })
        {
            foreach (var (make, expect) in cases)
            {
                var json = JsonSerializer.SerializeToUtf8Bytes(make(), options);
                var actual = Projected(json, withhold, out var outcome);
                var expected = expect(make());
                Assert.True(JsonNode.DeepEquals(JsonNode.Parse(JsonSerializer.Serialize(expected, options)), actual), expected.Name + ": " + actual!.ToJsonString());
                Assert.Equal(JsonSerializer.Serialize(expected, options) == JsonSerializer.Serialize(make(), options) ? LegacyCollageProjected.Unchanged : LegacyCollageProjected.Changed, outcome);
            }
        }

        // And a search hint.
        var hint = new SearchHint { Id = legacy.Id, Type = BaseItemKind.Playlist, PrimaryImageTag = "p", PrimaryImageAspectRatio = 1, ThumbImageItemId = library.Id.ToString("N"), ThumbImageTag = "t", BackdropImageTag = "b" };
        var hintJson = Projected(JsonSerializer.SerializeToUtf8Bytes(hint, JsonDefaults.PascalCaseOptions), withhold, out _)!;
        Assert.Null(hintJson["PrimaryImageTag"]);
        Assert.Null(hintJson["PrimaryImageAspectRatio"]);
        Assert.Null(hintJson["ThumbImageItemId"]);
        Assert.Null(hintJson["ThumbImageTag"]);
        Assert.Equal("b", hintJson["BackdropImageTag"]!.GetValue<string>());
    }

    [Fact]
    public void JesOwnShapesLoseTheFlagsAndTagsOfAWithheldImageByTheirExactNames()
    {
        var legacy = Item(new Playlist(), Bytes(7));
        Marker(legacy, Bytes(7));
        var plain = Item(new Playlist(), Bytes(8));
        var json = JsonSerializer.SerializeToUtf8Bytes(new object[]
        {
            new { Id = legacy.Id.ToString("N"), Type = "Playlist", HasPrimaryImage = true, HasThumbImage = true },
            new { id = legacy.Id.ToString("D"), type = "playlist", imageTags = new Dictionary<string, string> { ["Primary"] = "x", ["Logo"] = "l" } },
            new { Id = plain.Id.ToString("N"), Type = "Playlist", HasPrimaryImage = true, ImageTags = new Dictionary<string, string> { ["Primary"] = "y" } },
        });
        var node = Projected(json, New(), out var outcome)!;
        Assert.Equal(LegacyCollageProjected.Changed, outcome);
        Assert.False(node[0]!["HasPrimaryImage"]!.GetValue<bool>());
        // A list never withholds its Thumb (only its Primary was ever a collage).
        Assert.True(node[0]!["HasThumbImage"]!.GetValue<bool>());
        Assert.False(node[1]!["imageTags"]!.AsObject().ContainsKey("Primary"));
        Assert.Equal("l", node[1]!["imageTags"]!["Logo"]!.GetValue<string>());
        Assert.True(node[2]!["HasPrimaryImage"]!.GetValue<bool>());
        Assert.Equal("y", node[2]!["ImageTags"]!["Primary"]!.GetValue<string>());
    }

    [Fact]
    public void EveryLibraryFolderKindATileCanBeComposedForIsOneTheProjectionKnows()
    {
        // Every non-abstract BaseItem type with a collection type (lists aside): its DTOs carry that kind.
        var kinds = typeof(BaseItem).Assembly.GetTypes()
            .Where(t => t.IsClass && !t.IsAbstract && typeof(BaseItem).IsAssignableFrom(t) && typeof(IHasCollectionType).IsAssignableFrom(t) && t != typeof(Playlist) && t != typeof(BoxSet) && t.GetConstructor(Type.EmptyTypes) != null)
            .Select(t => ((BaseItem)Activator.CreateInstance(t)!).GetBaseItemKind()).Distinct().ToList();
        Assert.NotEmpty(kinds);
        Assert.All(kinds, k => Assert.Contains(k, LegacyCollageProjection.HolderKinds));
    }

    // ── WebSocket socket ─────────────────────────────────────────────────

    private sealed class Recording : WebSocket
    {
        public List<(byte[] Bytes, WebSocketMessageType Type, bool End)> Sent { get; } = new();
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
            Sent.Add((buffer.ToArray(), messageType, endOfMessage));
            return Task.CompletedTask;
        }
    }

    private Logger Logger()
    {
        var paths = new Mock<IApplicationPaths>();
        paths.SetupGet(p => p.LogDirectoryPath).Returns(_root);
        return new Logger(paths.Object, NullLoggerFactory.Instance);
    }

    [Fact]
    public async Task TheSocketChecksFragmentsAsOneMessageSendsNoMessageItCantCheckAndPassesOtherFrames()
    {
        var legacy = Item(new Playlist(), Bytes(9));
        Marker(legacy, Bytes(9));
        var inner = new Recording();
        var socket = new LegacyCollageSockets.ProjectingSocket(inner, New(), Logger());
        var message = Encoding.UTF8.GetBytes("{\"MessageType\":\"Sessions\",\"Data\":[{\"NowViewingItem\":{\"Id\":\"" + legacy.Id.ToString("N") + "\",\"Type\":\"Playlist\",\"ImageTags\":{\"Primary\":\"x\"}}}]}");
        // In two fragments: nothing leaves until the whole message is checked.
        await socket.SendAsync(new ArraySegment<byte>(message, 0, 40), WebSocketMessageType.Text, false, CancellationToken.None);
        Assert.Empty(inner.Sent);
        await socket.SendAsync(message.AsMemory(40), WebSocketMessageType.Text, true, CancellationToken.None);
        var sent = Assert.Single(inner.Sent);
        Assert.True(sent.End);
        Assert.DoesNotContain("Primary", Encoding.UTF8.GetString(sent.Bytes), StringComparison.Ordinal);

        // Not JSON: not sent. Binary: passed through as is.
        await socket.SendAsync(Encoding.UTF8.GetBytes("{\"Id\":"), WebSocketMessageType.Text, true, CancellationToken.None);
        Assert.Single(inner.Sent);
        await socket.SendAsync(new byte[] { 1, 2, 3 }, WebSocketMessageType.Binary, WebSocketMessageFlags.EndOfMessage, CancellationToken.None);
        Assert.Equal(new byte[] { 1, 2, 3 }, inner.Sent[^1].Bytes);

        // A message naming nothing withheld leaves byte for byte.
        var other = Encoding.UTF8.GetBytes("{\"MessageType\":\"KeepAlive\",  \"Data\":1}");
        await socket.SendAsync(other, WebSocketMessageType.Text, true, CancellationToken.None);
        Assert.Equal(other, inner.Sent[^1].Bytes);
    }

    [Fact]
    public async Task WithNothingToWithholdTheSocketSendsTheHostsBytesUntouched()
    {
        var inner = new Recording();
        var socket = new LegacyCollageSockets.ProjectingSocket(inner, New(), Logger());
        await socket.SendAsync(Encoding.UTF8.GetBytes("not json at all"), WebSocketMessageType.Text, true, CancellationToken.None);
        Assert.Equal("not json at all", Encoding.UTF8.GetString(Assert.Single(inner.Sent).Bytes));
    }

    private sealed class HostManager : IWebSocketManager
    {
        public HttpContext? Seen { get; private set; }

        public Task WebSocketRequestHandler(HttpContext context)
        {
            Seen = context;
            return Task.CompletedTask;
        }
    }

    private sealed class Feature : IHttpWebSocketFeature
    {
        public bool IsWebSocketRequest => true;
        public Task<WebSocket> AcceptAsync(WebSocketAcceptContext context) => Task.FromResult<WebSocket>(new Recording());
    }

    [Theory]
    [InlineData("type")]
    [InlineData("factory")]
    [InlineData("instance")]
    public async Task TheHostsWebSocketManagerIsWrappedHoweverItWasRegistered(string how)
    {
        var host = new HostManager();
        var services = new ServiceCollection();
        switch (how)
        {
            case "type": services.AddSingleton<IWebSocketManager, HostManager>(); break;
            case "factory": services.AddSingleton<IWebSocketManager>(_ => host); break;
            default: services.AddSingleton<IWebSocketManager>(host); break;
        }

        services.AddSingleton(New());
        services.AddSingleton(Logger());
        Assert.True(LegacyCollageSockets.Decorate(services));
        Assert.Single(services, d => d.ServiceType == typeof(IWebSocketManager));
        await using var provider = services.BuildServiceProvider();
        var manager = provider.GetRequiredService<IWebSocketManager>();
        Assert.IsType<LegacyCollageSockets.Manager>(manager);
        var context = new DefaultHttpContext();
        context.Features.Set<IHttpWebSocketFeature>(new Feature());
        await manager.WebSocketRequestHandler(context);
        var accepted = await context.WebSockets.AcceptWebSocketAsync();
        Assert.IsType<LegacyCollageSockets.ProjectingSocket>(accepted);
        if (how != "type") Assert.Same(context, host.Seen);

        Assert.False(LegacyCollageSockets.Decorate(new ServiceCollection()));
    }

    // ── listings ─────────────────────────────────────────────────────────

    [Fact]
    public void AMarkerIsSeenAtOnceAndEvenUnderAForgedFolderTimeWithinTheReuseBound()
    {
        var old = DateTime.UtcNow.AddMinutes(-5);
        foreach (var dir in _dirs) File.SetLastWriteTimeUtc(dir, old);
        var first = Item(new Playlist(), Bytes(30));
        var withhold = New();
        Assert.True(withhold.NoMarkers());

        // A marker written the usual way changes the folder's time: seen on the next answer.
        Marker(first, Bytes(30));
        Assert.Equal(LegacyCollageVerdict.Collage, withhold.Classify(first));

        // One whose folder time is set back to what it was: seen once the listing is older than the reuse bound.
        File.SetLastWriteTimeUtc(_dirs[0], old);
        Assert.False(withhold.NoMarkers());
        var second = Item(new Playlist(), Bytes(31));
        Marker(second, Bytes(31));
        File.SetLastWriteTimeUtc(_dirs[0], old);
        Thread.Sleep(LegacyCollageWithhold.ListingReuse + TimeSpan.FromMilliseconds(200));
        Assert.Equal(LegacyCollageVerdict.Collage, withhold.Classify(second));
    }

    // ── the tile record's clock ──────────────────────────────────────────

    [Fact]
    public void AListThatChangedWhileNobodyLookedRestartsTheWaitForItsTiles()
    {
        var list = Item(new Playlist(), Bytes(10));
        Marker(list, Bytes(11));
        var tile = Item(new CollectionFolder { CollectionType = CollectionType.playlists }, Bytes(12));
        var withhold = New();
        // First look (history unknown): the old tile waits; the host regenerates it; served.
        Assert.True(withhold.Withholds(tile, ImageType.Primary));
        Replace(tile, Bytes(13), _now.AddMinutes(5));
        _now = _now.AddMinutes(10);
        Assert.False(withhold.Withholds(tile, ImageType.Primary));

        // Unseen: the collage came back, the host rebuilt the tile from it, the owner set an image again.
        Replace(tile, Bytes(14), _now.AddMinutes(1));
        Replace(list, Bytes(15), _now.AddMinutes(2));
        _now = _now.AddMinutes(3);
        Assert.Equal(LegacyCollageVerdict.Superseded, withhold.Classify(list));
        Assert.True(withhold.Withholds(tile, ImageType.Primary));
        Assert.True(New().Withholds(tile, ImageType.Primary));
        Replace(tile, Bytes(16), _now.AddMinutes(5));
        _now = _now.AddMinutes(10);
        Assert.False(New().Withholds(tile, ImageType.Primary));

        // A tile written within the margin of the moment JE looked may straddle it: it waits too.
        Replace(list, Bytes(17), _now);
        Assert.True(withhold.Withholds(tile, ImageType.Primary));
        Replace(tile, Bytes(18), _now + LegacyCollageTiles.RegenerationMargin);
        Assert.True(withhold.Withholds(tile, ImageType.Primary));
        Replace(tile, Bytes(19), _now + LegacyCollageTiles.RegenerationMargin + TimeSpan.FromSeconds(1));
        Assert.False(withhold.Withholds(tile, ImageType.Primary));
    }

    [Fact]
    public void ARecordThatCantBeReadWithholdsEveryTileUntilRegeneratedEvenWithoutMarkers()
    {
        var playlists = Item(new CollectionFolder { CollectionType = CollectionType.playlists }, Bytes(20));
        var collections = Item(new CollectionFolder { CollectionType = CollectionType.boxsets }, Bytes(21));
        Assert.True(New().NoMarkers());
        Assert.False(New().Withholds(playlists, ImageType.Primary));
        File.WriteAllText(StatePath, "{ not a record");
        var withhold = New();
        Assert.False(withhold.Begin().Idle);
        Assert.True(withhold.Withholds(playlists, ImageType.Primary));
        Assert.False(withhold.Withholds(collections, ImageType.Thumb)); // no Thumb: nothing to serve
        Assert.True(withhold.Withholds(collections, ImageType.Primary));
        Assert.Contains(_warnings, w => w.Contains("couldn't be read", StringComparison.Ordinal));
        Replace(playlists, Bytes(22), _now.AddMinutes(5));
        _now = _now.AddMinutes(10);
        Assert.False(withhold.Withholds(playlists, ImageType.Primary));
        Assert.True(withhold.Withholds(collections, ImageType.Primary));
    }

    [Fact]
    public void ARecordThatCantBeWrittenStillWithholdsAndAfterARestartTheTilesWaitAgain()
    {
        if (Environment.UserName == "root" || OperatingSystem.IsWindows()) return;
        var list = Item(new BoxSet(), Bytes(23));
        Marker(list, Bytes(23));
        var tile = Item(new CollectionFolder { CollectionType = CollectionType.boxsets }, Bytes(24));
        var lists = Path.GetDirectoryName(_dirs[0])!;
        File.SetUnixFileMode(lists, UnixFileMode.UserRead | UnixFileMode.UserExecute);
        try
        {
            var withhold = New();
            Assert.True(withhold.Withholds(tile, ImageType.Primary));
            Assert.Contains(_warnings, w => w.Contains("Could not save", StringComparison.Ordinal));
            Replace(list, Bytes(25), _now);
            Assert.True(withhold.Withholds(tile, ImageType.Primary));
            Assert.False(File.Exists(StatePath));
        }
        finally
        {
            File.SetUnixFileMode(lists, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        // Nothing was kept: after a restart the history is unknown, and the old tile waits for the host.
        Assert.True(New().Withholds(tile, ImageType.Primary));
    }
}
