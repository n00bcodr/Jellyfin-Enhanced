using System.Collections;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Model.Activity;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace JE.Tests;

/// <summary>
/// Review round 17's findings on the hosts' captured answers (tests/fixtures/host-shapes, 12.2 under jf12 and 10.11.11
/// under jf10): a session playing a Live TV channel carries the channel's CurrentProgram inside its NowPlayingItem, over
/// REST and over the dashboard's WebSocket (D46-R17-1: projection is a recursive walk); an activity entry's text was
/// recorded with the names of its moment, so a rename or a localized refresh afterwards must not let the old title through
/// (D46-R17-2: free text is constructed, never patched). Uses only the filters' and gate's existing surface, so the same
/// file runs against the pre-fix build.
/// </summary>
[Collection("Plugin singleton")]
public class PrivacyReviewRound17Tests
{
    private static PrivacyHostShapeModelTests.Shot Shot(string file) => PrivacyHostShapeModelTests.Data.Shots.Single(s => s.File == file);

    private static Guid Role(string role) => PrivacyHostShapeModelTests.G(PrivacyHostShapeModelTests.Data.Roles[role]);

    private static PrivacyHostShapeModelTests.Rule Rule(string id) => PrivacyHostShapeModelTests.Rules.Single(r => r.Id == id);

    private static readonly JsonSerializerOptions Json = Jellyfin.Extensions.Json.JsonDefaults.Options;

    // ---------------------------------------------------------------------------------------------------------------
    // Rule 1: the whole graph, at any depth.

    /// <summary>
    /// An independent walk over EVERY public member of a value (object-typed members, dictionaries' values and sequences
    /// included), recording each BaseItemDto with its path and depth. Deliberately not the production walker.
    /// </summary>
    internal static List<(BaseItemDto Dto, string Path, int Depth)> Everything(object? value)
    {
        var found = new List<(BaseItemDto, string, int)>();
        var seen = new HashSet<object>(ReferenceEqualityComparer.Instance);
        void Walk(object? node, string path, int depth, int titles)
        {
            if (node == null || depth > 24 || node is string || node.GetType().IsPrimitive || node.GetType().IsEnum || node is Guid or DateTime or DateTimeOffset or TimeSpan or decimal) return;
            if (!node.GetType().IsValueType && !seen.Add(node)) return;
            if (node is BaseItemDto dto) { found.Add((dto, path, titles)); titles++; }
            if (node is IDictionary map)
            {
                foreach (DictionaryEntry pair in map) Walk(pair.Value, path + "[" + pair.Key + "]", depth + 1, titles);
                return;
            }
            if (node is IEnumerable list)
            {
                var i = 0;
                foreach (var child in list) Walk(child, path + "[" + i++ + "]", depth + 1, titles);
                return;
            }
            if (node.GetType().Namespace?.StartsWith("System", StringComparison.Ordinal) == true && !node.GetType().IsGenericType) return;
            foreach (var property in node.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance).Where(p => p.GetIndexParameters().Length == 0))
                Walk(property.GetValue(node), path + "." + property.Name, depth + 1, titles);
        }
        Walk(value, "$", 0, 0);
        return found;
    }

    /// <summary>The answer's own listed items (the walker's roots), by reference.</summary>
    private static HashSet<object> Listed(object value) => (value switch
    {
        AllThemeMediaResult all => NativePrivacyProjection.ThemeItems(all).Cast<object>(),
        IEnumerable<RecommendationDto> categories => categories.SelectMany(c => c.Items ?? []).Cast<object>(),
        _ => NativePrivacyProjection.Items(value).Cast<object>()
    }).ToHashSet(ReferenceEqualityComparer.Instance);

    public static IEnumerable<object[]> Files() => PrivacyHostShapeModelTests.Data.Shots.Where(s => !s.Endpoint.StartsWith("User.Authenticate", StringComparison.Ordinal))
        .Select(s => new object[] { s.File });

    /// <summary>
    /// Every title member reachable anywhere in every captured answer (REST and WebSocket) is either one of the answer's
    /// own listed items or a member the gate's projection walks: nothing at any depth escapes the walk.
    /// </summary>
    [Theory]
    [MemberData(nameof(Files))]
    public void TheProjectionWalksEveryTitleMemberOfEveryCapturedAnswerAtAnyDepth(string file)
    {
        var value = PrivacyHostShapeModelTests.Value(Shot(file));
        var listed = Listed(value);
        var walked = NativePrivacyProjection.Nested(value).Select(n => n.Dto).ToHashSet(ReferenceEqualityComparer.Instance);
        var missed = Everything(value).Where(d => !listed.Contains(d.Dto) && !walked.Contains(d.Dto)).Select(d => d.Path + " " + d.Dto.Type + " " + d.Dto.Name).ToArray();
        Assert.True(missed.Length == 0, file + ": not walked: " + string.Join("; ", missed));
    }

    /// <summary>
    /// The generic oracle over every captured file × every rule: after the requesting viewer's rule, no title member at
    /// ANY depth of the delivered value carries the rule's protected text (unless the endpoint opens that very item).
    /// </summary>
    [Theory]
    [MemberData(nameof(PrivacyHostShapeModelTests.Cells), MemberType = typeof(PrivacyHostShapeModelTests))]
    public async Task NoProtectedTitleMemberSurvivesAtAnyDepth(string file, string ruleId, string moment)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var shot = Shot(file);
        var rule = Rule(ruleId);
        var viewer = shot.Viewer == "viewer" ? rig.Viewer : rig.Admin;
        if (moment == "before") rig.Commit(rule, viewer);
        var (result, _) = await PrivacyHostShapeModelTests.Deliver(rig, shot, moment == "in-flight" ? () => rig.Commit(rule, viewer) : null);
        var delivered = Assert.IsAssignableFrom<ObjectResult>(result).Value;
        var opened = PrivacyHostShapeModelTests.Opened(shot);
        foreach (var (dto, path, depth) in Everything(delivered))
        {
            if (rule.Id.StartsWith("hc-", StringComparison.Ordinal) && dto.Id == opened && dto.Id == Role(rule.Role)) continue;
            // Only this DTO's own text (its nested members are judged on their own).
            var node = JsonNode.Parse(JsonSerializer.Serialize(dto, Json))!.AsObject();
            node.Remove("CurrentProgram");
            var own = node.ToJsonString();
            foreach (var text in rule.Subject) Assert.False(own.Contains(text, StringComparison.Ordinal), $"{file} {path} (depth {depth}) still carries \"{text}\"");
        }
    }

    [Theory]
    [InlineData("Session.GetSessions.admin.json")]
    [InlineData("Session.WebSocket.admin.json")]
    [InlineData("Session.WebSocket.viewer.json")]
    public async Task ASessionPlayingAChannelLosesTheProgrammeTheViewerHidAndKeepsTheChannelAndItsControls(string file)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var shot = Shot(file);
        var viewer = shot.Viewer == "viewer" ? rig.Viewer : rig.Admin;
        rig.Commit(Rule("hc-program-now"), viewer);
        var sessions = (List<SessionInfoDto>)PrivacyHostShapeModelTests.Value(shot);
        var channel = sessions.Single(s => s.NowPlayingItem?.Id == Role("channel:r17"));
        // The host's own (shared) now-playing channel keeps its programme: only the delivered copy changes.
        var shared = channel.NowPlayingItem!;
        var delivered = shot.Socket
            ? JsonSerializer.Serialize(rig.Gate().ProjectSessions(sessions, viewer), Json)
            : (await PrivacyHostShapeModelTests.Deliver(rig, shot)).Body;
        Assert.DoesNotContain("D46 R17 Program Now", delivered);
        Assert.DoesNotContain("Secret plot r17 program now", delivered);
        var row = JsonNode.Parse(delivered)!.AsArray().Single(s => s!["NowPlayingItem"]?["Id"]?.ToString().Replace("-", "") == Role("channel:r17").ToString("N"))!;
        Assert.Equal("D46 R17 Channel", row["NowPlayingItem"]!["Name"]!.ToString());
        Assert.NotNull(row["PlayState"]);
        Assert.Equal(sessions.Count, JsonNode.Parse(delivered)!.AsArray().Count);
        if (shot.Socket) Assert.Equal("D46 R17 Program Now", shared.CurrentProgram?.Name);
    }

    [Fact]
    public async Task ASignInWhoseSessionIsPlayingAChannelIsProjectedNotLeakedOrWithheld()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(Rule("hc-program-now"), rig.Viewer);
        var signIn = PrivacyHostShapeModelTests.Data.Shots.Single(s => s.Endpoint == "User.AuthenticateUserByName");
        var answer = (MediaBrowser.Controller.Authentication.AuthenticationResult)PrivacyHostShapeModelTests.Value(signIn);
        var sessions = (List<SessionInfoDto>)PrivacyHostShapeModelTests.Value(Shot("Session.GetSessions.admin.json"));
        // Three levels below the answer: sign-in → its session → the now-playing channel → the programme airing now.
        answer.SessionInfo!.NowPlayingItem = sessions.Single(s => s.NowPlayingItem?.Id == Role("channel:r17")).NowPlayingItem;
        var context = PrivacyHostShapeModelTests.Context(signIn, rig.Viewer);
        var delivery = new ResultExecutingContext(context, new List<IFilterMetadata>(), new ObjectResult(answer), new object());
        rig.Gate().OnResultExecuting(delivery);
        var result = Assert.IsAssignableFrom<ObjectResult>(delivery.Result);
        var body = JsonSerializer.Serialize(result.Value, result.Value!.GetType(), Json);
        Assert.DoesNotContain("D46 R17 Program Now", body);
        Assert.Contains("D46 R17 Channel", body);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Rule 2: free text is constructed, never patched.

    private static async Task<QueryResult<ActivityLogEntry>> Activity(PrivacyHostShapeModelTests.Rig rig, Action? before = null)
    {
        before?.Invoke();
        var (result, _) = await PrivacyHostShapeModelTests.Deliver(rig, Shot("ActivityLog.GetLogEntries.json"));
        return Assert.IsType<QueryResult<ActivityLogEntry>>(Assert.IsAssignableFrom<ObjectResult>(result).Value);
    }

    private static bool About(ActivityLogEntry entry, string role) => Guid.TryParse(entry.ItemId, out var id) && id == Role(role);

    [Theory]
    [InlineData("rename")]
    [InlineData("localized")]
    public async Task AGuardedEpisodesActivityEntryIsRebuiltWhateverTheLibraryCallsItNow(string change)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(Rule("sg-series"), rig.Admin);
        var episode = rig.Items[Role("episode:show-e1")];
        // After the entry was recorded the episode was renamed, or its metadata refreshed in another language.
        episode.Name = change == "rename" ? "Renamed r18 E1" : "Folge eins r18";
        var page = await Activity(rig);
        var rows = page.Items.Where(e => About(e, "episode:show-e1")).ToArray();
        Assert.NotEmpty(rows);
        foreach (var entry in rows)
        {
            var text = entry.Name + "|" + entry.ShortOverview + "|" + entry.Overview;
            Assert.DoesNotContain("Secret ending r17", text);
            Assert.DoesNotContain(episode.Name, text);
            Assert.Contains("Season 1, Episode 1", entry.Name);
        }
    }

    [Fact]
    public void AnEntryRecordedInAnotherWordingIsRebuiltNotPatched()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(Rule("sg-series"), rig.Admin);
        var shot = Shot("ActivityLog.GetLogEntries.json");
        var page = (QueryResult<ActivityLogEntry>)PrivacyHostShapeModelTests.Value(shot);
        // The server's language changed after the entry was recorded: the stored text is not the host's current wording.
        foreach (var entry in page.Items.Where(e => About(e, "episode:show-e1")))
        {
            entry.Name = "real-viewer spielt Secret ending r17 E1 (D46 R17 Show) auf cli";
            entry.ShortOverview = "Secret ending r17 E1";
        }
        var context = PrivacyHostShapeModelTests.Context(shot, rig.Admin);
        var delivery = new ResultExecutingContext(context, new List<IFilterMetadata>(), new ObjectResult(page), new object());
        rig.Gate().OnResultExecuting(delivery);
        var body = JsonSerializer.Serialize(Assert.IsAssignableFrom<ObjectResult>(delivery.Result).Value, Json);
        Assert.DoesNotContain("Secret ending r17", body);
    }

    [Fact]
    public async Task AnEntryAboutAnItemTheLibraryNoLongerHasIsNotTrustedWhileAPolicyApplies()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(Rule("sg-series"), rig.Admin);
        // The episode left the library after its entry was recorded: its stored text can't be judged.
        rig.Items.Remove(Role("episode:show-e1"));
        var page = await Activity(rig);
        Assert.Contains(page.Items, e => About(e, "episode:show-e1"));
        Assert.DoesNotContain(page.Items, e => (e.Name + e.ShortOverview + e.Overview).Contains("Secret ending r17", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ControlsAWatchedEpisodeAndAViewerWithoutRulesKeepTheHostsText()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var original = ((QueryResult<ActivityLogEntry>)PrivacyHostShapeModelTests.Value(Shot("ActivityLog.GetLogEntries.json"))).Items
            .Where(e => About(e, "episode:show-e1")).Select(e => e.Name).ToArray();
        var none = await Activity(rig);
        Assert.Equal(original, none.Items.Where(e => About(e, "episode:show-e1")).Select(e => e.Name).ToArray());
        rig.Commit(Rule("sg-series"), rig.Admin);
        rig.Played.Add((rig.Admin, Role("episode:show-e1")));
        var watched = await Activity(rig);
        Assert.Equal(original, watched.Items.Where(e => About(e, "episode:show-e1")).Select(e => e.Name).ToArray());
    }

    [Fact]
    public async Task AHiddenTitlesEntriesAreLeftOutAndOtherEntriesKeepTheirText()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(Rule("hc-movie"), rig.Admin);
        var page = await Activity(rig);
        Assert.DoesNotContain(page.Items, e => About(e, "movie:hidden"));
        Assert.Contains(page.Items, e => e.Name.Contains("Secret ending r17 E1", StringComparison.Ordinal));
    }
}
