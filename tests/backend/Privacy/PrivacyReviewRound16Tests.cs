using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace JE.Tests;

/// <summary>
/// Review round 16's findings on the hosts' captured answers (tests/fixtures/host-shapes): an administrator's sessions
/// carrying another account's hidden movie and guarded episode (D46-R16-1), and theme extras / featurettes owned through
/// their envelope or their library owner rather than a DTO's SeriesId (D46-R16-2). Uses only the filters' and gate's
/// existing surface, so the same file runs against the pre-fix build.
/// </summary>
[Collection("Plugin singleton")]
public class PrivacyReviewRound16Tests
{
    private static PrivacyHostShapeModelTests.Shot Shot(string file) => PrivacyHostShapeModelTests.Data.Shots.Single(s => s.File == file);

    private static Guid Role(string role) => PrivacyHostShapeModelTests.G(PrivacyHostShapeModelTests.Data.Roles[role]);

    private static PrivacyHostShapeModelTests.Rule Rule(string id) => PrivacyHostShapeModelTests.Rules.Single(r => r.Id == id);

    private static readonly JsonSerializerOptions Json = Jellyfin.Extensions.Json.JsonDefaults.Options;

    /// <summary>The final gate alone over a given value (the endpoint's real answer object).</summary>
    private static string Gate(PrivacyHostShapeModelTests.Rig rig, PrivacyHostShapeModelTests.Shot shot, object value, Guid viewer)
    {
        var context = PrivacyHostShapeModelTests.Context(shot, viewer);
        var delivery = new ResultExecutingContext(context, new List<IFilterMetadata>(), new ObjectResult(value), new object());
        rig.Gate().OnResultExecuting(delivery);
        var delivered = Assert.IsAssignableFrom<ObjectResult>(delivery.Result).Value!;
        return JsonSerializer.Serialize(delivered, delivered.GetType(), Json);
    }

    [Fact]
    public async Task AnAdministratorsSessionsLoseAnotherAccountsHiddenTitleAndKeepEverySessionAndItsControls()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(Rule("hc-movie"), rig.Admin);
        var (_, delivered) = await PrivacyHostShapeModelTests.Deliver(rig, Shot("Session.GetSessions.admin.json"));
        Assert.DoesNotContain("D46 R17 Hidden", delivered);
        var sessions = JsonNode.Parse(delivered)!.AsArray();
        var playing = sessions.Single(s => s!["NowPlayingItem"]?["Id"]?.ToString().Replace("-", "") == Role("movie:hidden").ToString("N"));
        Assert.NotNull(playing!["PlayState"]);
        Assert.Equal(Role("user:viewer").ToString("N"), playing["UserId"]!.ToString().Replace("-", ""));
        // Another session's title and the session's viewing item are untouched.
        Assert.Contains("Secret ending r17 E1", delivered);
        Assert.Contains("D46 R17 Guarded", delivered);
    }

    [Fact]
    public async Task AGuardedEpisodeAnotherAccountPlaysIsJudgedByTheAdministratorsOwnWatchedState()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(Rule("sg-series"), rig.Admin);
        // The account playing it has watched it; the administrator has not: still guarded for the administrator.
        rig.Played.Add((rig.Viewer, Role("episode:show-e1")));
        var (_, unwatched) = await PrivacyHostShapeModelTests.Deliver(rig, Shot("Session.GetSessions.admin.json"));
        Assert.DoesNotContain("Secret ending r17", unwatched);
        Assert.DoesNotContain("Secret plot r17 episode", unwatched);
        rig.Played.Add((rig.Admin, Role("episode:show-e1")));
        var (_, watched) = await PrivacyHostShapeModelTests.Deliver(rig, Shot("Session.GetSessions.admin.json"));
        Assert.Contains("Secret ending r17 E1", watched);
    }

    [Fact]
    public void TheHostsSharedNowPlayingItemIsNeverChanged()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(Rule("sg-series"), rig.Admin);
        var shot = Shot("Session.GetSessions.admin.json");
        var sessions = (List<SessionInfoDto>)PrivacyHostShapeModelTests.Value(shot);
        // The host's SessionInfo keeps these objects: every DTO it builds for any viewer references the same item.
        var shared = sessions.Select(s => s.NowPlayingItem).Where(i => i != null).ToArray();
        var before = shared.Select(i => JsonSerializer.Serialize(i, Json)).ToArray();
        var delivered = Gate(rig, shot, sessions, rig.Admin);
        Assert.DoesNotContain("Secret ending r17", delivered);
        Assert.Equal(before, shared.Select(i => JsonSerializer.Serialize(i, Json)).ToArray());
    }

    [Fact]
    public async Task AViewerWithNoRuleGetsEveryCapturedAnswerUnchanged()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        foreach (var shot in PrivacyHostShapeModelTests.Data.Shots.Where(s => !s.Endpoint.StartsWith("User.Authenticate", StringComparison.Ordinal)))
        {
            var original = JsonSerializer.Serialize(PrivacyHostShapeModelTests.Value(shot), PrivacyHostShapeModelTests.Declared(shot.Endpoint), Json);
            var (_, delivered) = await PrivacyHostShapeModelTests.Deliver(rig, shot);
            Assert.True(original == delivered, shot.File);
        }
    }

    [Theory]
    [InlineData("Library.GetThemeSongs.movie.json", "sg-movie")]
    [InlineData("Library.GetThemeVideos.movie.json", "sg-movie")]
    [InlineData("Library.GetThemeMedia.movie.json", "sg-movie")]
    [InlineData("Library.GetThemeSongs.series.json", "sg-series")]
    [InlineData("Library.GetThemeMedia.series.json", "sg-series")]
    [InlineData("Library.GetThemeSongs.episode-inherited.json", "sg-series")]
    public async Task ThemeExtrasFollowTheirEnvelopesOwnerEvenWhenTheLibraryCannotResolveThem(string file, string rule)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        // The envelope's OwnerId is the host's own owner fact: it decides even for an extra the library lookup misses.
        foreach (var extra in PrivacyHostShapeModelTests.Data.Roles.Where(r => r.Key.StartsWith("extra:", StringComparison.Ordinal))) rig.Items.Remove(PrivacyHostShapeModelTests.G(extra.Value));
        rig.Commit(Rule(rule), rig.Admin);
        var (_, delivered) = await PrivacyHostShapeModelTests.Deliver(rig, Shot(file));
        foreach (var text in Rule(rule).Subject) Assert.DoesNotContain(text, delivered);
    }

    [Fact]
    public async Task AnEpisodesOwnershipComesFromTheLibraryNotFromTheDtosSeriesId()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(Rule("sg-series"), rig.Admin);
        var shot = Shot("TvShows.GetEpisodes.json");
        // The DTO names another (unguarded) series; the library says the episode belongs to the guarded one.
        var page = (QueryResult<BaseItemDto>)PrivacyHostShapeModelTests.Value(shot);
        foreach (var item in page.Items) item.SeriesId = Guid.NewGuid();
        Assert.DoesNotContain("Secret ending r17", Gate(rig, shot, page, rig.Admin));
        // And the reverse: a DTO naming the guarded series does not guard an episode the library gives another series.
        using var other = new PrivacyHostShapeModelTests.Rig();
        other.Commit(Rule("sg-series"), other.Admin);
        foreach (var episode in other.Items.Values.OfType<MediaBrowser.Controller.Entities.TV.Episode>()) episode.SeriesId = Guid.NewGuid();
        var unguarded = (QueryResult<BaseItemDto>)PrivacyHostShapeModelTests.Value(shot);
        Assert.Contains("Secret ending r17", Gate(other, shot, unguarded, other.Admin));
        await Task.CompletedTask;
    }
}
