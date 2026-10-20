using System.Text.Json;
using System.Text.Json.Nodes;
using MediaBrowser.Model.Dto;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

/// <summary>
/// Review round 18's findings on the hosts' captured answers (round 19 captures: tests/fixtures/host-shapes/*/*r19*):
/// a guarded episode with incomplete numbering (no episode number; no numbers at all) kept its title, original title and
/// sort title wherever it was answered, REST and WebSocket (D46-R18-1: title suppression was conditional on optional
/// metadata); a hidden now-playing item became a stub without the fields the host's own remote control needs, so
/// jellyfin-web's remote-control page threw and its audio/subtitle menus vanished (D46-R18-2). Uses only the gate's and
/// filters' existing surface, so the same file runs against the pre-fix build. The projected sessions this file delivers
/// are also what tests/frontend/regressions/host-web-now-playing.test.mjs drives jellyfin-web's real functions with.
/// </summary>
[Collection("Plugin singleton")]
public class PrivacyReviewRound18Tests
{
    private static readonly JsonSerializerOptions Json = Jellyfin.Extensions.Json.JsonDefaults.Options;

    private static PrivacyHostShapeModelTests.Shot Shot(string file) => PrivacyHostShapeModelTests.Data.Shots.Single(s => s.File == file);

    private static Guid Role(string role) => PrivacyHostShapeModelTests.G(PrivacyHostShapeModelTests.Data.Roles[role]);

    private static PrivacyHostShapeModelTests.Rule Rule(string id) => PrivacyHostShapeModelTests.Rules.Single(r => r.Id == id);

    private static string N(Guid id) => id.ToString("N");

    private static string? Id(JsonNode? node) => node?["Id"]?.ToString().Replace("-", "", StringComparison.Ordinal);

    // ---------------------------------------------------------------------------------------------------------------
    // D46-R18-1: a protected episode loses every name field whatever its numbering.

    public static IEnumerable<object[]> EpisodeAnswers() => new[]
    {
        "Session.GetSessions.admin-r19.json", "Session.WebSocket.admin-r19.json", "TvShows.GetEpisodes.r19.json", "UserLibrary.GetItem.r19-e3.json", "Search.GetSearchHints.r19.json",
    }.Select(f => new object[] { f });

    [Theory]
    [MemberData(nameof(EpisodeAnswers))]
    public async Task AGuardedEpisodeWithIncompleteNumberingLosesEveryNameFieldAndGetsItsNeutralName(string file)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(Rule("sg-r19-series"), rig.Admin);
        var (result, body) = await PrivacyHostShapeModelTests.Deliver(rig, Shot(file));
        Assert.IsAssignableFrom<ObjectResult>(result);
        foreach (var text in Rule("sg-r19-series").Subject) Assert.DoesNotContain(text, body);
        // Each numbering gets the neutral name it can have.
        var expected = new Dictionary<string, string>
        {
            [N(Role("episode:r19-e1"))] = "Season 1, Episode 1",
            [N(Role("episode:r19-e2"))] = "Season 1, Episode",
            [N(Role("episode:r19-e3"))] = "Episode",
        };
        var names = new Dictionary<string, string>();
        void Walk(JsonNode? node)
        {
            if (node is JsonArray array) { foreach (var child in array) Walk(child); return; }
            if (node is not JsonObject o) return;
            if (Id(o) is { } id && expected.ContainsKey(id) && o["Name"] != null) names[id] = o["Name"]!.ToString();
            foreach (var (_, child) in o) Walk(child);
        }
        Walk(JsonNode.Parse(body));
        Assert.NotEmpty(names);
        foreach (var (id, name) in names) Assert.Equal(expected[id], name);
        // The series' own title is not protected by Spoiler Guard.
        Assert.Contains("D46 R19 Show", body);
    }

    [Theory]
    [InlineData("Session.GetSessions.admin-r19.json")]
    [InlineData("Session.WebSocket.admin-r19.json")]
    public async Task AGuardedNowPlayingEpisodeKeepsItsSessionAndTracksWithoutTitles(string file)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(Rule("sg-r19-series"), rig.Admin);
        var original = JsonNode.Parse(PrivacyHostShapeModelTests.Resource(file))!.AsArray();
        var (_, body) = await PrivacyHostShapeModelTests.Deliver(rig, Shot(file));
        var delivered = JsonNode.Parse(body)!.AsArray();
        Assert.Equal(original.Count, delivered.Count);
        foreach (var episode in new[] { "episode:r19-e2", "episode:r19-e3" })
        {
            var before = original.Single(s => Id(s!["NowPlayingItem"]) == N(Role(episode)))!["NowPlayingItem"]!;
            var after = delivered.Single(s => Id(s!["NowPlayingItem"]) == N(Role(episode)))!["NowPlayingItem"]!;
            Assert.Equal(Streams(before).Select(s => s.Key), Streams(after).Select(s => s.Key));
            Assert.All(Streams(after), s => Assert.DoesNotContain("Secret ending r19", s.Display));
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // D46-R18-2: a hidden now-playing item keeps what the host's remote control needs, and no title.

    private static IReadOnlyList<(string Key, string Display)> Streams(JsonNode item)
        => (item["MediaStreams"] as JsonArray ?? []).Select(s => (string.Join('|', s!["Type"], s["Index"], s["Codec"], s["Language"], s["IsExternal"], s["IsDefault"]), s["DisplayTitle"]?.ToString() ?? "")).ToArray();

    /// <summary>Fields the host's clients never need to drive a session and that describe the title: a stub has none.</summary>
    private static readonly string[] Describing = ["Overview", "Path", "Taglines", "Genres", "GenreItems", "Studios", "People", "Chapters", "ExternalUrls", "ProviderIds", "ImageTags",
        "BackdropImageTags", "ProductionYear", "OriginalTitle", "SortName", "Tags", "MediaSources", "Trickplay", "ImageBlurHashes"];

    [Theory]
    [InlineData("Session.GetSessions.admin-r19.json")]
    [InlineData("Session.WebSocket.admin-r19.json")]
    public async Task AHiddenNowPlayingItemKeepsEverythingTheHostsRemoteControlNeedsAndNoTitle(string file)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(Rule("hc-r19-movie"), rig.Admin);
        var original = JsonNode.Parse(PrivacyHostShapeModelTests.Resource(file))!.AsArray();
        var (_, body) = await PrivacyHostShapeModelTests.Deliver(rig, Shot(file));
        Assert.DoesNotContain("D46 R19 Hidden", body);
        var delivered = JsonNode.Parse(body)!.AsArray();
        var hidden = N(Role("movie:r19-hidden"));
        var before = original.Single(s => Id(s!["NowPlayingItem"]) == hidden)!;
        var after = delivered.Single(s => Id(s!["NowPlayingItem"]) == hidden)!;
        var item = after["NowPlayingItem"]!.AsObject();
        // What the remote-control page and the remote session player index.
        foreach (var field in new[] { "Id", "ServerId", "Type", "MediaType", "IsFolder", "RunTimeTicks" })
            Assert.Equal(before["NowPlayingItem"]![field]?.ToJsonString(), item[field]?.ToJsonString());
        Assert.False(string.IsNullOrWhiteSpace(item["Name"]?.ToString()), "the host's now-playing names need a name");
        Assert.Equal(Streams(before["NowPlayingItem"]!).Select(s => s.Key), Streams(item).Select(s => s.Key));
        Assert.Contains(Streams(item), s => s.Key.StartsWith("Audio|", StringComparison.Ordinal));
        Assert.All(Streams(item), s => Assert.False(string.IsNullOrWhiteSpace(s.Display)));
        foreach (var stream in (JsonArray)item["MediaStreams"]!)
            foreach (var field in new[] { "Title", "Comment", "Path" }) Assert.Null(stream![field]);
        foreach (var field in Describing) Assert.Null(item[field]);
        // The session and its controls are the host's own.
        foreach (var control in new[] { "PlayState", "SupportsRemoteControl", "SupportsMediaControl", "Capabilities", "NowPlayingQueue", "PlaylistItemId" })
            Assert.True(JsonNode.DeepEquals(before[control], after[control]), control + " changed");
        // 10.11 also lists the queue's items: a hidden one is a stub too, never a gap.
        if (before["NowPlayingQueueFullItems"] is JsonArray queue)
        {
            var kept = (JsonArray)after["NowPlayingQueueFullItems"]!;
            Assert.Equal(queue.Select(Id), kept.Select(Id));
            Assert.All(kept.Where(q => Id(q) == hidden), q => Assert.NotNull(q!["MediaStreams"]));
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // The payloads jellyfin-web's real functions run on (tests/fixtures/host-web/projected/<host>.json).

    private static readonly (string Rule, string File)[] WebCases =
    [
        ("none", "Session.GetSessions.admin-r19.json"),
        ("hc-r19-movie", "Session.GetSessions.admin-r19.json"), ("hc-r19-movie", "Session.WebSocket.admin-r19.json"),
        ("sg-r19-series", "Session.GetSessions.admin-r19.json"), ("sg-r19-series", "Session.WebSocket.admin-r19.json"),
    ];

    /// <summary>The sessions the admin receives under each rule, REST and WebSocket, as the web client gets them.</summary>
    internal static async Task<string> WebPayloads()
    {
        var cases = new JsonArray();
        foreach (var (ruleId, file) in WebCases)
        {
            using var rig = new PrivacyHostShapeModelTests.Rig();
            if (ruleId != "none") rig.Commit(Rule(ruleId), rig.Admin);
            var (_, body) = await PrivacyHostShapeModelTests.Deliver(rig, Shot(file));
            var sessions = JsonNode.Parse(body)!.AsArray();
            var playing = new JsonArray(sessions.Where(s => s?["NowPlayingItem"] != null).Select(s => s!.DeepClone()).ToArray());
            cases.Add(new JsonObject
            {
                ["id"] = ruleId + "/" + (file.Contains("WebSocket", StringComparison.Ordinal) ? "socket" : "rest"),
                ["rule"] = ruleId,
                ["protected"] = new JsonArray((ruleId == "none" ? [] : Rule(ruleId).Subject).Select(t => (JsonNode?)t).ToArray()),
                ["original"] = file,
                ["sessions"] = playing,
            });
        }
        return new JsonObject { ["host"] = PrivacyHostShapeModelTests.HostName, ["cases"] = cases }.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n";
    }

    /// <summary>
    /// The checked-in payloads are exactly what this build delivers (set JE_HOST_WEB_PROJECTED to a directory to rewrite
    /// them), so the frontend test runs jellyfin-web on this build's projection.
    /// </summary>
    [Fact]
    public async Task TheWebClientsTestPayloadsAreWhatThisBuildDelivers()
    {
        var current = await WebPayloads();
        if (Environment.GetEnvironmentVariable("JE_HOST_WEB_PROJECTED") is { Length: > 0 } dir)
            await File.WriteAllTextAsync(Path.Combine(dir, PrivacyHostShapeModelTests.HostName + ".json"), current);
        using var stream = typeof(PrivacyReviewRound18Tests).Assembly.GetManifestResourceStream("JE.Tests.HostWebProjected." + PrivacyHostShapeModelTests.HostName)!;
        Assert.NotNull(stream);
        var committed = await new StreamReader(stream).ReadToEndAsync();
        Assert.Equal(committed.ReplaceLineEndings("\n"), current.ReplaceLineEndings("\n"));
    }
}
