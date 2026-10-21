using System.Text.Json.Nodes;

namespace JE.Tests;

// Closed PR #936 drew collages of member posters into lists' native Primary images. Those posters can be ones a viewer
// has hidden since or that Spoiler Guard covers, so the collage, everything derived from it and the library tiles the
// host composes from list images must reach nobody, on both Jellyfin versions, while every other image is served (and
// revalidated) exactly as before. Executed through the pinned release's real ImageController and SearchController
// and the plugin's real registered filter chain (LegacyCollageHost).
public class ListsLegacyCollageHostTests
{
    private static readonly string[] Withheld = { "legacy", "pending", "corrupt" };
    private static readonly string[] Served = { "custom", "unrelated", "unrelatedset", "movieslibrary" };

    private static IEnumerable<JsonObject> Images(JsonObject run, Func<JsonObject, bool> where)
        => run["images"]!.AsArray().Select(n => n!.AsObject()).Where(where);

    private static string S(JsonObject o, string key) => o[key]?.GetValue<string>() ?? string.Empty;

    private static string Describe(JsonObject r) => $"{S(r, "item")} {S(r, "imageType")} {S(r, "alias")} {S(r, "method")} {S(r, "caller")} {S(r, "conditional")} -> {r["status"]}";

    [Fact]
    public void TheHostRunIsTheRealReleaseWithThePluginsFilterChain()
    {
        var run = LegacyCollageHost.Run();
        var expected = JellyfinApiAssembly.CurrentLine == "jf12" ? "12.2" : "10.11.11";
        Assert.Equal(expected, S(run, "release"));
        Assert.StartsWith(expected == "12.2" ? "12.2." : "10.11.11", S(run, "server"));
        var filters = run["filters"]!.AsArray().Select(f => f!.GetValue<string>()).ToList();
        foreach (var name in new[] { "HiddenContentResponseFilter", "SpoilerIdentityTagFilter", "SpoilerFieldStripFilter", "PosterTagImageFilter", "SpoilerBlurImageFilter", "JellyfinUserChangeBracket" })
            Assert.Contains(filters, f => f.StartsWith(name + "@", StringComparison.Ordinal));
        Assert.True(run["filesUnchanged"]!.GetValue<bool>(), "no image or marker file may change");
    }

    [Fact]
    public void ALegacyCollageIsServedOnNoAliasMethodCallerOrConditionalAndTheHostSaysItHasNoImage()
    {
        var run = LegacyCollageHost.Run();
        var rows = Images(run, r => Withheld.Contains(S(r, "item")) && S(r, "imageType") == "Primary").ToList();
        // 3 lists × 8 aliases × GET/HEAD × 3 callers × (none, if-modified-since, + if-none-match on the 5 tagged aliases).
        Assert.Equal(3 * (8 * 2 * 3 * 2 + 5 * 2 * 3), rows.Count);
        var leaks = rows.Where(r => r["status"]!.GetValue<int>() != 404 || r["servedImage"]!.GetValue<bool>() || r["etag"] != null || r["lastModified"] != null).Select(Describe).ToList();
        Assert.True(leaks.Count == 0, "served: " + string.Join("; ", leaks.Take(12)) + (leaks.Count > 12 ? $" (+{leaks.Count - 12})" : string.Empty));
        foreach (var row in rows.Where(r => S(r, "method") == "GET"))
            Assert.Equal($"\"{S(row, "item")} list does not have an image of type Primary\"", S(row, "body"));
    }

    [Fact]
    public void EveryOtherImageIsServedAndTheHostsOwnConditionalAnswersStillComeBack()
    {
        var run = LegacyCollageHost.Run();
        var jf12 = JellyfinApiAssembly.CurrentLine == "jf12";
        var rows = Images(run, r => Served.Contains(S(r, "item"))).ToList();
        Assert.Equal(Served.Length * (8 * 2 * 3 * 2 + 5 * 2 * 3), rows.Count);
        foreach (var row in rows)
        {
            var tagged = S(row, "alias") is "tagged" or "index-tagged" or "sized" or "path-form" or "lowercase";
            // The release's own rules: 12.2's controller answers If-None-Match on the tag; 10.11.11 sends no ETag. On
            // both, If-Modified-Since gets a 304 from the controller (tagged URLs) or from MVC's physical-file executor,
            // which validates against the file's own modification time.
            var expected = S(row, "conditional") switch
            {
                "if-none-match" => jf12 ? 304 : 200,
                "if-modified-since" => 304,
                _ => 200,
            };
            Assert.True(row["status"]!.GetValue<int>() == expected, Describe(row) + " expected " + expected);
            if (expected == 200)
            {
                Assert.True(S(row, "method") == "HEAD" || row["servedImage"]!.GetValue<bool>(), Describe(row));
                Assert.NotNull(row["lastModified"]);
            }

            if (jf12 && tagged && expected == 200) Assert.NotNull(row["etag"]);
        }

        // The positive control for the withheld rows: this harness does reach the host's 304, on both releases.
        Assert.Contains(rows, r => S(r, "conditional") == "if-modified-since" && S(r, "alias") == "path-form" && r["status"]!.GetValue<int>() == 304);
        Assert.Equal(jf12, rows.Any(r => S(r, "conditional") == "if-none-match" && r["status"]!.GetValue<int>() == 304));
    }

    [Fact]
    public void ThePlaylistLibraryTilesTheHostComposesFromListImagesAreWithheldAndOtherLibrariesAreNot()
    {
        var run = LegacyCollageHost.Run();
        foreach (var row in Images(run, r => S(r, "item") is "playlistslibrary" or "playlistsview"))
        {
            Assert.True(row["status"]!.GetValue<int>() == 404 && !row["servedImage"]!.GetValue<bool>(), Describe(row));
        }

        Assert.All(Images(run, r => S(r, "item") == "movieslibrary" && S(r, "conditional") == "none"), r => Assert.Equal(200, r["status"]!.GetValue<int>()));
    }

    [Fact]
    public void ImageInfoListsNoWithheldImageNorItsPathAndKeepsEveryOther()
    {
        var run = LegacyCollageHost.Run();
        var answers = run["answers"]!.AsObject();
        foreach (var name in Withheld.Append("playlistslibrary"))
        {
            var answer = answers["infos:" + name]!.AsObject();
            Assert.Equal(200, answer["status"]!.GetValue<int>());
            var infos = JsonNode.Parse(S(answer, "body"))!.AsArray();
            Assert.DoesNotContain(infos, i => i!["ImageType"]!.GetValue<string>() is "Primary" or "Thumb");
            Assert.DoesNotContain(run["names"]![name]!.GetValue<string>(), S(answer, "body"));
        }

        foreach (var name in Served)
        {
            var infos = JsonNode.Parse(S(answers["infos:" + name]!.AsObject(), "body"))!.AsArray();
            var primary = Assert.Single(infos, i => i!["ImageType"]!.GetValue<string>() == "Primary");
            Assert.Contains(run["names"]![name]!.GetValue<string>(), primary!["Path"]!.GetValue<string>());
            Assert.False(string.IsNullOrEmpty(primary["ImageTag"]?.GetValue<string>()));
        }
    }

    [Fact]
    public void ItemDtosInEveryShapeLoseTheWithheldImagesTagsBlurHashesAndAspectRatioAndKeepTheRest()
    {
        var run = LegacyCollageHost.Run();
        var answers = run["answers"]!.AsObject();
        var names = run["names"]!.AsObject().ToDictionary(p => p.Value!.GetValue<string>(), p => p.Key);
        var dtos = new List<JsonObject>();
        foreach (var name in names.Values) dtos.Add(JsonNode.Parse(S(answers["dto:" + name]!.AsObject(), "body"))!.AsObject());
        dtos.AddRange(JsonNode.Parse(S(answers["query"]!.AsObject(), "body"))!["Items"]!.AsArray().Select(d => d!.AsObject()));
        dtos.AddRange(JsonNode.Parse(S(answers["lazy"]!.AsObject(), "body"))!.AsArray().Select(d => d!.AsObject()));
        dtos.AddRange(JsonNode.Parse(S(answers["recommendations"]!.AsObject(), "body"))![0]!["Items"]!.AsArray().Select(d => d!.AsObject()));
        Assert.Equal(names.Count * 4, dtos.Count);
        foreach (var dto in dtos)
        {
            var name = names[dto["Id"]!.GetValue<string>().Replace("-", string.Empty, StringComparison.Ordinal)];
            var tags = dto["ImageTags"]!.AsObject();
            var hashes = dto["ImageBlurHashes"]?.AsObject();
            if (Withheld.Contains(name) || name is "playlistslibrary" or "playlistsview")
            {
                Assert.False(tags.ContainsKey("Primary"), name);
                Assert.False(tags.ContainsKey("Thumb"), name);
                Assert.False(hashes?.ContainsKey("Primary") == true || hashes?.ContainsKey("Thumb") == true, name);
                Assert.Null(dto["PrimaryImageAspectRatio"]);
                Assert.Null(dto["ParentPrimaryImageItemId"]);
                Assert.Null(dto["ParentPrimaryImageTag"]);
            }
            else
            {
                Assert.True(tags.ContainsKey("Primary"), name);
                Assert.True(hashes!.ContainsKey("Primary"), name);
                Assert.Equal(1.0, dto["PrimaryImageAspectRatio"]!.GetValue<double>());
            }
        }
    }

    [Fact]
    public void SearchHintsCarryNoWithheldPrimaryTagAndKeepEveryOther()
    {
        var run = LegacyCollageHost.Run();
        var answer = run["answers"]!["search"]!.AsObject();
        Assert.Equal(200, answer["status"]!.GetValue<int>());
        var names = run["names"]!.AsObject().ToDictionary(p => p.Value!.GetValue<string>(), p => p.Key);
        var hints = JsonNode.Parse(S(answer, "body"))!["SearchHints"]!.AsArray().Select(h => h!.AsObject()).ToList();
        Assert.Equal(names.Count, hints.Count);
        foreach (var hint in hints)
        {
            var name = names[hint["Id"]!.GetValue<string>().Replace("-", string.Empty, StringComparison.Ordinal)];
            if (Withheld.Contains(name) || name is "playlistslibrary")
            {
                Assert.Null(hint["PrimaryImageTag"]);
                Assert.Null(hint["PrimaryImageAspectRatio"]);
            }
            else if (Served.Contains(name))
            {
                Assert.False(string.IsNullOrEmpty(hint["PrimaryImageTag"]?.GetValue<string>()), name);
            }

            if (name == "playlistsview") Assert.Null(hint["ThumbImageTag"]);
        }
    }

    [Fact]
    public void TheAdminPosterTagPreviewDrawsOnNoWithheldCollage()
    {
        var answers = LegacyCollageHost.Run()["answers"]!.AsObject();
        foreach (var name in Withheld)
        {
            Assert.Equal(404, answers["preview:" + name]!["status"]!.GetValue<int>());
            Assert.Contains("Item has no Primary image.", S(answers["preview:" + name]!.AsObject(), "body"));
        }

        foreach (var name in new[] { "custom", "unrelated", "unrelatedset" }) Assert.Equal(200, answers["preview:" + name]!["status"]!.GetValue<int>());
    }

    // ── every delivery path: WebSocket, JE's own answers (COLLAGE-R1-2) ──

    private static readonly string[] WithheldAnywhere = Withheld.Concat(new[] { "playlistslibrary", "playlistsview" }).ToArray();

    // Every JSON object naming an item (Id) in the frame or answer, with the item's scenario name.
    private static IEnumerable<(string Name, JsonObject Item)> Named(JsonNode? node, IReadOnlyDictionary<string, string> names)
    {
        switch (node)
        {
            case JsonObject o:
                // The host's spelling or its camelCase profile's.
                if ((o["Id"] ?? o["id"]) is JsonValue id && id.TryGetValue<string>(out var raw) && names.TryGetValue(raw.Replace("-", string.Empty, StringComparison.Ordinal), out var name)) yield return (name, o);
                foreach (var child in o.Select(p => p.Value).ToList())
                    foreach (var found in Named(child, names)) yield return found;
                break;
            case JsonArray a:
                foreach (var child in a.ToList())
                    foreach (var found in Named(child, names)) yield return found;
                break;
        }
    }

    private static Dictionary<string, string> Names(JsonObject run) => run["names"]!.AsObject().ToDictionary(p => p.Value!.GetValue<string>(), p => p.Key);

    private static JsonNode? Field(JsonObject item, string pascal) => item[pascal] ?? item[char.ToLowerInvariant(pascal[0]) + pascal[1..]];

    private static bool HasOwnImage(JsonObject item, string type)
        => (Field(item, "ImageTags") as JsonObject)?.ContainsKey(type) == true || (Field(item, "ImageBlurHashes") as JsonObject)?.ContainsKey(type) == true
            || (type == "Primary" && (Field(item, "PrimaryImageAspectRatio") != null || Field(item, "PrimaryImageTag") != null || Field(item, "HasPrimaryImage")?.GetValue<bool>() == true))
            || (type == "Thumb" && Field(item, "HasThumbImage")?.GetValue<bool>() == true);

    private static List<string> Leaks(IEnumerable<JsonNode?> nodes, IReadOnlyDictionary<string, string> names, out HashSet<string> servedSeen)
    {
        var leaks = new List<string>();
        servedSeen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in nodes)
        {
            foreach (var (name, item) in Named(node, names))
            {
                if (WithheldAnywhere.Contains(name))
                {
                    foreach (var type in new[] { "Primary", "Thumb" })
                        if (HasOwnImage(item, type)) leaks.Add(name + " " + type + ": " + item.ToJsonString());
                }
                else if (HasOwnImage(item, "Primary"))
                {
                    servedSeen.Add(name);
                }
            }
        }

        return leaks;
    }

    private static List<JsonNode?> Frames(JsonObject run) => run["socket"]!["frames"]!.AsArray().Select(f => JsonNode.Parse(f!.GetValue<string>())).ToList();

    [Fact]
    public void SessionUpdatesOverTheHostsRealWebSocketCarryNoWithheldImageAndKeepEveryOther()
    {
        var run = LegacyCollageHost.Run();
        var socket = run["socket"]!.AsObject();
        Assert.True(socket["connected"]!.GetValue<bool>(), "the host's session listener made no controller");
        Assert.True(socket["sessionsSent"]!.GetValue<bool>(), "the host's SessionInfoWebSocketListener sent no Sessions message");
        var frames = Frames(run);
        var sessions = frames.Where(f => f?["MessageType"]?.GetValue<string>() == "Sessions").ToList();
        Assert.NotEmpty(sessions);
        var names = Names(run);
        // The viewer is looking at the legacy list (NowViewingItem); the playing item is a served control.
        Assert.Contains(sessions, f => Named(f, names).Any(n => n.Name == "legacy"));
        var leaks = Leaks(sessions, names, out var served);
        Assert.True(leaks.Count == 0, string.Join("\n", leaks.Take(6)));
        Assert.Contains("unrelated", served);
    }

    [Fact]
    public void EverySessionMessageThatCanCarryAnItemArrivesWithoutAWithheldImage()
    {
        var run = LegacyCollageHost.Run();
        var socket = run["socket"]!.AsObject();
        var sent = socket["sent"]!.AsObject();
        Assert.Contains(sent, p => p.Value!.GetValue<string>() == "SessionsMessage");
        Assert.Contains(sent, p => p.Value!.GetValue<string>() == "BaseItemDto[]");
        Assert.True(socket["allReceived"]!.GetValue<bool>(), "a message the host's WebSocketController sent never arrived");
        var names = Names(run);
        var frames = Frames(run).Where(f => f?["MessageId"]?.GetValue<string>() is { } id && sent.ContainsKey(id.Replace("-", string.Empty, StringComparison.Ordinal))).ToList();
        Assert.Equal(sent.Count, frames.Count);
        var leaks = Leaks(frames, names, out var served);
        Assert.True(leaks.Count == 0, string.Join("\n", leaks.Take(6)));
        Assert.Contains("unrelated", served);
    }

    // Image-naming properties in the release's WebSocket payloads and why each is (or needs no) projection.
    private static readonly Dictionary<string, string> PayloadImageProperties = new(StringComparer.Ordinal)
    {
        ["BaseItemDto.ImageTags"] = "projected",
        ["BaseItemDto.ImageBlurHashes"] = "projected",
        ["BaseItemDto.PrimaryImageAspectRatio"] = "projected",
        ["BaseItemDto.ParentPrimaryImageItemId"] = "projected",
        ["BaseItemDto.ParentPrimaryImageTag"] = "projected",
        ["BaseItemDto.ParentThumbItemId"] = "projected",
        ["BaseItemDto.ParentThumbImageTag"] = "projected",
        // Image types no collage was drawn into and no library tile is composed as.
        ["BaseItemDto.BackdropImageTags"] = "Backdrop",
        ["BaseItemDto.ParentBackdropImageTags"] = "Backdrop",
        ["BaseItemDto.ParentBackdropItemId"] = "Backdrop",
        ["BaseItemDto.ParentArtImageTag"] = "Art",
        ["BaseItemDto.ParentArtItemId"] = "Art",
        ["BaseItemDto.ParentLogoImageTag"] = "Logo",
        ["BaseItemDto.ParentLogoItemId"] = "Logo",
        ["BaseItemDto.ScreenshotImageTags"] = "Screenshot",
        ["BaseItemDto.ImageOrientation"] = "no image content",
        // Images of items that are never a list or a library tile.
        ["BaseItemDto.AlbumPrimaryImageTag"] = "album",
        ["BaseItemDto.ChannelPrimaryImageTag"] = "channel",
        ["BaseItemDto.SeriesPrimaryImageTag"] = "series",
        ["BaseItemDto.SeriesThumbImageTag"] = "series",
        ["BaseItemPerson.HasPrimaryImage"] = "person",
        ["BaseItemPerson.ImageBlurHashes"] = "person",
        ["BaseItemPerson.PrimaryImageTag"] = "person",
        ["ChapterInfo.ImageDateModified"] = "chapter",
        ["ChapterInfo.ImagePath"] = "chapter",
        ["ChapterInfo.ImageTag"] = "chapter",
        ["TrickplayInfoDto.ThumbnailCount"] = "trickplay",
        ["PackageInfo.ImageUrl"] = "plugin",
        ["PluginInfo.HasImage"] = "plugin",
        ["ActivityLogEntry.UserPrimaryImageTag"] = "user",
        ["SessionInfoDto.UserPrimaryImageTag"] = "user",
        ["UserDto.PrimaryImageAspectRatio"] = "user",
        ["UserDto.PrimaryImageTag"] = "user",
    };

    [Fact]
    public void EveryWebSocketListenerAndMessageTypeOfTheReleaseGoesThroughTheProjection()
    {
        var run = LegacyCollageHost.Run();
        var socket = run["socket"]!.AsObject();
        var listeners = socket["listeners"]!.AsArray().Select(l => l!.GetValue<string>()).ToList();
        // A listener a Jellyfin update adds fails here until the harness runs it too.
        Assert.Equal(new[]
        {
            "Emby.Server.Implementations.Session.SessionWebSocketListener",
            "Jellyfin.Api.WebSocketListeners.ActivityLogWebSocketListener",
            "Jellyfin.Api.WebSocketListeners.ScheduledTasksWebSocketListener",
            "Jellyfin.Api.WebSocketListeners.SessionInfoWebSocketListener",
        }, listeners.OrderBy(l => l, StringComparer.Ordinal));
        // Registered: the host's listeners, with the native session updates replaced by D46's privacy projection of them
        // (it sends through the same connection, so through the collage projection too).
        var expected = listeners.Select(l => l == Jellyfin.Plugin.JellyfinEnhanced.Services.PrivacySessionsWebSocketListener.NativeTypeName
            ? typeof(Jellyfin.Plugin.JellyfinEnhanced.Services.PrivacySessionsWebSocketListener).FullName! : l);
        Assert.Equal(expected.OrderBy(l => l, StringComparer.Ordinal), socket["registered"]!.AsArray().Select(l => l!.GetValue<string>()).OrderBy(l => l, StringComparer.Ordinal));
        // Every listener writes through the one connection the host's WebSocketManager made over the accepted socket:
        // that socket is the plugin's projection.
        Assert.StartsWith("Jellyfin.Plugin.JellyfinEnhanced.", socket["socketType"]?.GetValue<string>() ?? "(none)");

        var messages = socket["messages"]!.AsArray().Select(m => m!.AsObject()).ToList();
        Assert.InRange(messages.Count, 20, 60);
        var unknown = messages.SelectMany(m => m["imageProperties"]!.AsArray().Select(p => m["name"] + ": " + p!.GetValue<string>()))
            .Where(p => !PayloadImageProperties.ContainsKey(p.Split(": ")[1])).ToList();
        Assert.True(unknown.Count == 0, "image properties no rule covers: " + string.Join(", ", unknown));
        var sent = socket["sent"]!.AsObject().Select(p => p.Value!.GetValue<string>()).ToHashSet();
        foreach (var message in messages.Where(m => m["carriesDto"]!.GetValue<bool>()))
            Assert.Contains(message["name"]!.GetValue<string>(), sent);
    }

    [Fact]
    public void JesOwnAnswersCarryNoWithheldImageAndKeepEveryOther()
    {
        var run = LegacyCollageHost.Run();
        var answers = run["answers"]!.AsObject();
        var names = Names(run);
        foreach (var key in new[] { "je:activity", "je:sessions" })
        {
            Assert.Equal(200, answers[key]!["status"]!.GetValue<int>());
            var body = JsonNode.Parse(S(answers[key]!.AsObject(), "body"));
            Assert.Equal(names.Count, Named(body, names).Count());
            var leaks = Leaks(new[] { body }, names, out var served);
            Assert.True(leaks.Count == 0, key + ": " + string.Join("\n", leaks.Take(6)));
            Assert.Contains("unrelated", served);
            Assert.Contains("custom", served);
        }
    }

    // ── contamination is sticky (COLLAGE-R1-1) ───────────────────────────

    [Fact]
    public void ATileBuiltFromACollageStaysWithheldAfterTheListIsReplacedAndARestartUntilTheHostRegeneratesIt()
    {
        var sticky = LegacyCollageHost.Run()["sticky"]!.AsObject();
        int Status(string phase, string key) => sticky[phase]![key]!.GetValue<int>();
        bool TileTagged(string phase) => JsonNode.Parse(sticky[phase]!["dto"]!.GetValue<string>())!["ImageTags"]?.AsObject().ContainsKey("Primary") == true;

        Assert.Equal(404, Status("collage", "list"));
        Assert.Equal(404, Status("collage", "tile"));
        Assert.False(TileTagged("collage"));
        // The release's own provider composed the tile from the collage (it says it updated the image).
        Assert.Equal("ImageUpdate", sticky["providerFromCollage"]!.GetValue<string>());
        Assert.Equal("ImageUpdate", sticky["providerClean"]!.GetValue<string>());
        foreach (var phase in new[] { "composedFromCollage", "listReplaced", "restarted", "touched" })
        {
            Assert.Equal(phase == "composedFromCollage" ? 404 : 200, Status(phase, "list"));
            Assert.True(Status(phase, "tile") == 404, phase + ": the tile was served");
            Assert.Equal(404, Status(phase, "tileTagged"));
            Assert.False(TileTagged(phase), phase);
        }

        Assert.Equal(200, Status("regenerated", "list"));
        Assert.Equal(200, Status("regenerated", "tile"));
        Assert.Equal(200, Status("regenerated", "tileTagged"));
        Assert.True(TileTagged("regenerated"));
    }

    // ── an image that becomes withheld while the host's action runs (COLLAGE-R3-1) ──

    [Fact]
    public void AnImageWhoseListBecomesACollageWhileTheHostsActionRunsIsNotSentInAnyForm()
    {
        var late = LegacyCollageHost.Run()["lateImage"]!.AsObject();
        Assert.Equal(4, late.Count);
        foreach (var (name, row) in late)
        {
            var answer = row!.AsObject();
            Assert.True(answer["markerAppeared"]!.GetValue<bool>(), name + ": the marker never appeared while the action ran");
            Assert.True(answer["status"]!.GetValue<int>() == 404, name + ": answered " + answer["status"]);
            Assert.False(answer["servedImage"]!.GetValue<bool>(), name);
            Assert.Null(answer["etag"]);
            if (name != "head") Assert.Equal("late list does not have an image of type Primary", S(answer, "body"));
        }
    }

    // ── the action enumeration is MVC's own (control) ────────────────────

    [Fact]
    public void TheActionsTheBoundaryWasCheckedAgainstAreExactlyTheOnesMvcDiscovers()
    {
        var results = LegacyCollageHost.Run()["results"]!.AsObject();
        string Key(JsonNode? d) => S(d!.AsObject(), "assembly") + ":" + S(d!.AsObject(), "action");
        var declared = results["declared"]!.AsArray().Select(Key).ToHashSet(StringComparer.Ordinal);
        var discovered = results["discovered"]!.AsArray().Select(Key).ToHashSet(StringComparer.Ordinal);
        Assert.True(discovered.Count > 600, discovered.Count + " actions discovered");
        Assert.Empty(discovered.Except(declared));
        Assert.Empty(declared.Except(discovered));
    }

    // ── the answer body boundary: every result type (COLLAGE-R2-1) ───────

    [Fact]
    public void EveryResultTypeTheHostOrJeCanAnswerWithIsProjectedWhereItsBodyIsWritten()
    {
        var run = LegacyCollageHost.Run();
        var results = run["results"]!.AsObject();
        var known = LegacyResultTypes.Variants.Values.Select(v => v.Type.FullName!).ToHashSet(StringComparer.Ordinal);

        // Every concrete result type of MVC and of the release's and JE's own assemblies is answered with below, or is one
        // that nothing in the host or JE can produce. A type an update adds fails here until it is.
        var universe = results["universe"]!.AsArray().Select(u => u!.GetValue<string>()).ToList();
        Assert.Contains("Microsoft.AspNetCore.Mvc.JsonResult", universe);
        Assert.Contains("Microsoft.AspNetCore.Mvc.ContentResult", universe);
        var unhandled = universe.Where(u => !known.Contains(u) && !LegacyResultTypes.Excluded.ContainsKey(u)).ToList();
        Assert.True(unhandled.Count == 0, "result types with no answer here: " + string.Join(", ", unhandled));

        // Every action of the release's and JE's controllers returns a value (an ObjectResult), ActionResult<T>, an abstract
        // result (any of the above), or a concrete type answered with below; none returns a type nobody checked.
        var declared = results["declared"]!.AsArray().Select(d => d!.AsObject()).ToList();
        Assert.Contains(declared, d => S(d, "assembly") == "Jellyfin.Api");
        Assert.Contains(declared, d => S(d, "assembly") == "Jellyfin.Plugin.JellyfinEnhanced" && S(d, "action") == "JellyfinEnhancedController.GetBootstrap");
        var bad = declared.Where(d => S(d, "kind") is var k && (k.StartsWith("IResult:", StringComparison.Ordinal)
                || (k.StartsWith("concrete:", StringComparison.Ordinal) && !known.Contains(k["concrete:".Length..]))))
            .Select(d => S(d, "action") + " " + S(d, "kind")).ToList();
        Assert.True(bad.Count == 0, "actions returning an unchecked result type: " + string.Join(", ", bad));

        var names = Names(run);
        var exact = run["exact"]!.AsObject();
        foreach (var row in results["runs"]!.AsArray().Select(r => r!.AsObject()))
        {
            var label = S(row, "variant") + "/" + S(row, "item") + " -> " + row["status"];
            var text = S(row, "text");
            JsonNode? body = null;
            try { body = text.Length > 0 ? JsonNode.Parse(text) : null; } catch (System.Text.Json.JsonException) { }
            var leaks = Leaks(new[] { body }, names, out var served);
            Assert.True(leaks.Count == 0, label + ": " + string.Join("; ", leaks));
            // The withheld ids leave nothing behind in a body JE couldn't parse either.
            Assert.DoesNotContain("\"Primary\":\"", S(row, "item") == "unrelated" ? string.Empty : text, StringComparison.Ordinal);
            if (row["contentLength"] is { } length) Assert.Equal(length.GetValue<long>(), row["length"]!.GetValue<int>());
            if (!row["body"]!.GetValue<bool>()) continue;

            // The body really carried the item (the check above isn't vacuous), and a served item keeps its image, byte
            // for byte where the test wrote the bytes.
            Assert.True(body != null && Named(body, names).Any(n => n.Name == S(row, "item")), label + ": " + text);
            if (S(row, "item") == "unrelated")
            {
                Assert.Contains("unrelated", served);
                if (exact[S(row, "variant") + "/unrelated"] is { } expected) Assert.Equal(expected.GetValue<string>(), text);
            }
        }
    }

    [Fact]
    public void JesStartUpAnswerCarriesNoWithheldImageInItsActiveSessions()
    {
        var run = LegacyCollageHost.Run();
        var answer = run["answers"]!["je:bootstrap"]!.AsObject();
        Assert.Equal(200, answer["status"]!.GetValue<int>());
        var body = JsonNode.Parse(S(answer, "body"))!;
        var sessions = body["Prefetched"]!["ActiveStreamSessions"]!.AsArray();
        var names = Names(run);
        Assert.Equal(names.Count, sessions.Count);
        var leaks = Leaks(new[] { body }, names, out var served);
        Assert.True(leaks.Count == 0, string.Join("\n", leaks.Take(6)));
        Assert.Contains("unrelated", served);
        Assert.Contains("custom", served);
    }

    // ── the WebSocket corpus (COLLAGE-R2-4) ──────────────────────────────

    [Fact]
    public void EveryOutgoingWebSocketMessageTypeWithTheHostsOwnPayloadsLeavesByteForByteWhileMarkersExist()
    {
        var corpus = LegacyCollageHost.Run()["corpus"]!.AsArray().Select(r => r!.AsObject()).ToList();
        var errors = corpus.Where(r => r["error"] != null).Select(r => S(r, "name") + ": " + S(r, "error")).ToList();
        Assert.True(errors.Count == 0, string.Join("\n", errors));
        // The projection really ran on each (JE has markers, one of them for a list the payloads name).
        Assert.All(corpus, r => Assert.False(r["idle"]!.GetValue<bool>()));
        Assert.InRange(corpus.Count, 30, 80);
        foreach (var name in new[] { "GeneralCommandMessage", "SessionsMessage", "UserDataChangedMessage", "PlayMessage", "LibraryChangedMessage", "GeneralCommand:DisplayMessage", "SyncPlayGroupUpdate:SyncPlayGroupJoinedUpdate" })
            Assert.Contains(corpus, r => S(r, "name") == name);
        var changed = corpus.Where(r => !r["equal"]!.GetValue<bool>()).Select(r => S(r, "name") + " (frames sent: " + r["sent"] + ")").ToList();
        Assert.True(changed.Count == 0, "not sent byte for byte: " + string.Join(", ", changed));

        var display = S(corpus.Single(r => S(r, "name") == "GeneralCommand:DisplayMessage"), "host");
        Assert.Contains("\"Text\":", display, StringComparison.Ordinal);
        Assert.Contains("\"text\":", display, StringComparison.Ordinal);
        // The payloads hold served items' images (what the projection must leave alone).
        Assert.Contains(corpus, r => S(r, "host").Contains("\"ImageTags\":{\"Primary\":", StringComparison.Ordinal));
    }

    [Fact]
    public void ADashboardMessageWhoseArgumentsDifferOnlyInCaseReachesTheSessionOverTheHostsRealWebSocket()
    {
        var run = LegacyCollageHost.Run();
        var socket = run["socket"]!.AsObject();
        var id = S(socket, "display");
        Assert.False(string.IsNullOrEmpty(id));
        var frame = Frames(run).SingleOrDefault(f => f?["MessageId"]?.GetValue<string>()?.Replace("-", string.Empty, StringComparison.Ordinal) == id);
        Assert.NotNull(frame);
        var arguments = frame!["Data"]!["Arguments"]!.AsObject();
        Assert.Equal("lower-case twin", arguments["text"]!.GetValue<string>());
        Assert.StartsWith("Maintenance at 22:00", arguments["Text"]!.GetValue<string>(), StringComparison.Ordinal);
        Assert.Equal("Server notice", arguments["Header"]!.GetValue<string>());
    }
}
