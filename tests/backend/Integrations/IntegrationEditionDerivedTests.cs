using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Rig = JE.Tests.IntegrationEditionAvailabilityTests.Rig;
using Layout = JE.Tests.IntegrationEditionAvailabilityTests.Layout;
using Has = JE.Tests.IntegrationEditionAvailabilityTests.Has;
using M = JE.Tests.IntegrationEditionMaskedTests;

namespace JE.Tests;

/// <summary>
/// Edition round 15 (D53: aggregates derived, never subtracted; playable means playable; one binding decides wording and
/// action). Every count and date a viewer is shown for a Sonarr copy comes from the episodes of the bound copy they may see:
/// Sonarr's own season statistics only where no part of the season is hidden from them, else derived from the visible
/// episodes of Sonarr's list, else not given. Another copy "plays" an episode only through a playable source. A copy-qualified
/// season page names the copy its actions reach, and whether a request or a household Search can reach it.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEditionDerivedTests
{
    private static readonly TitleKey Firefly = TitleKey.Parse("tv:tvdb:78874")!;

    private static string Utc(DateTime d) => d.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);

    /// <summary>Season 1's statistics on the standard Sonarr (and the series' next airing).</summary>
    private static void Statistics(Rig rig, int files, int aired, int total, DateTime? next = null)
    {
        var series = rig.Sonarr.Series[0];
        var season = series["seasons"]!.AsArray().Single(s => (int)s!["seasonNumber"]! == 1)!;
        season["statistics"] = new JsonObject
        {
            ["episodeFileCount"] = files, ["episodeCount"] = aired, ["totalEpisodeCount"] = total,
            ["nextAiring"] = next is DateTime n ? Utc(n) : null,
        };
        series["nextAiring"] = next is DateTime s ? Utc(s) : null;
    }

    /// <summary>S1E3 of the standard copy as a missing (virtual) Jellyfin episode, hidden from <paramref name="hiddenFrom"/> when given.</summary>
    private static void VirtualE3(Rig rig, StatusViewer? hiddenFrom, params StatusViewer[] sees)
    {
        var episode = new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 3, Virtual = true };
        if (hiddenFrom == null) rig.View.AddEpisode(rig.HdCopy, episode);
        else rig.View.AddEpisode(rig.HdCopy, episode, sees.Select(v => v.UserId).Append(rig.Admin.UserId).ToArray());
        rig.View.Rev++;
    }

    private static async Task<TitleStatus> RequestedSeason(Rig rig, StatusViewer viewer, bool load)
    {
        var request = new RequestFacts { Pending = true, AskedAt = rig.Now.AddDays(-2), AskedByViewer = true };
        var scopes = new Dictionary<TitleKey, ArrStatusService.RequestScope> { [Firefly] = new(new[] { 1 }, false, request) };
        await rig.Service.ComposeForAsync(viewer, new[] { Firefly }, scopes, default, loadEpisodes: load);
        await Task.Delay(20);
        return Assert.Single(await rig.Service.ComposeForAsync(viewer, new[] { Firefly }, scopes, default, loadEpisodes: load)).Status;
    }

    // ------------------------------------------------------------------ ED-R15-1: files of hidden episodes

    [Theory]
    [InlineData(true, false)]  // the finding: E3 is a missing episode Jellyfin hides from the kid; Sonarr's statistics count its file
    [InlineData(true, true)]   // the same with Sonarr's episode list in memory (derived from the visible episodes)
    [InlineData(false, false)] // control: someone who sees E3 hears that it is on its way into the library
    public async Task AHiddenEpisodesSonarrFileNeverMakesTheSeasonAlmostReady(bool kid, bool load)
    {
        using var rig = new Rig(Layout.SeparateLibraries, Has.Hd, movie: false);
        var viewer = kid ? rig.View.AddUser(admin: false, parental: true) : rig.View.AddUser(admin: false, policy: "same");
        rig.Sonarr.Episodes.Add(new JsonObject { ["id"] = 103, ["seriesId"] = 1, ["seasonNumber"] = 1, ["episodeNumber"] = 3, ["airDateUtc"] = "2002-09-23T00:00:00Z", ["hasFile"] = true, ["monitored"] = true });
        Statistics(rig, files: 3, aired: 3, total: 3);
        VirtualE3(rig, kid ? viewer : null, rig.Member);
        var status = await RequestedSeason(rig, viewer, load);
        var where = $"kid {kid}, list {load}: requested season 1 {status.Stage}/{status.Reason.Code}, almost ready {status.Summary?.AlmostReady}, aired {status.Summary?.Aired}";
        if (kid)
            Assert.True(status.Stage != StatusStage.AlmostReady && (status.Summary?.AlmostReady ?? 0) == 0, where);
        else
            Assert.True(status.Stage == StatusStage.AlmostReady && status.Summary?.AlmostReady == 1, where);
    }

    // ------------------------------------------------------------------ ED-R15-2: next airing of hidden episodes

    [Theory]
    [InlineData(true)]  // the finding: the next episode (E3, in five days) is hidden from the kid
    [InlineData(false)] // control: someone who sees it is told when it airs
    public async Task AHiddenUpcomingEpisodeNeverGivesTheNextAirDate(bool kid)
    {
        using var rig = new Rig(Layout.SeparateLibraries, Has.Hd, movie: false);
        var viewer = kid ? rig.View.AddUser(admin: false, parental: true) : rig.View.AddUser(admin: false, policy: "same");
        var airs = rig.Now.Date.AddDays(5).AddHours(20);
        rig.Sonarr.Episodes.Add(new JsonObject { ["id"] = 103, ["seriesId"] = 1, ["seasonNumber"] = 1, ["episodeNumber"] = 3, ["airDateUtc"] = Utc(airs), ["hasFile"] = false, ["monitored"] = true });
        Statistics(rig, files: 2, aired: 2, total: 3, next: airs);
        VirtualE3(rig, kid ? viewer : null, rig.Member);

        var requested = await RequestedSeason(rig, viewer, load: false);
        await rig.Service.ForItemAsync(viewer, rig.HdCopy, default);
        await Task.Delay(20);
        var page = Assert.Single(M.Items(await rig.Service.ForItemAsync(viewer, rig.HdCopy, default)));
        DateTime? Next(JsonElement e) => e.TryGetProperty("nextDate", out var d) && d.ValueKind == JsonValueKind.String ? d.GetDateTime().ToUniversalTime() : null;
        DateTime? SummaryNext(JsonElement e) => e.TryGetProperty("summary", out var s) && s.TryGetProperty("nextAir", out var d) && d.ValueKind == JsonValueKind.String ? d.GetDateTime().ToUniversalTime() : null;
        var where = $"kid {kid}: Requests page next {requested.NextDate}/{requested.Summary?.NextAir}; series page next {Next(page)}/{SummaryNext(page)}";
        if (kid)
        {
            Assert.True(requested.NextDate == null && requested.Summary?.NextAir == null, where);
            Assert.True(Next(page) == null && SummaryNext(page) == null, where);
        }
        else
        {
            Assert.True(Next(page) == airs && SummaryNext(page) == airs, where);
        }
    }

    // ------------------------------------------------------------------ ED-R15-5: played elsewhere means playable there

    [Fact]
    public async Task APlaceholderInAnotherCopyIsNotAnEpisodeItPlays()
    {
        using var rig = M.OneLibrary(grouped: true);
        rig.Sonarr.Episodes.Add(M.Aired(103, 3));
        rig.Sonarr.Episodes.Add(M.Aired(104, 4));
        // The 4K folder holds a stub for E3 (Jellyfin lists it, it plays nothing) and a real file for E4.
        rig.View.Placeholders.Add(rig.View.AddEpisodeFile(rig.UhdCopy, Firefly, 1, 3, null, null, rig.Now.AddDays(-1)));
        rig.View.AddEpisodeFile(rig.UhdCopy, Firefly, 1, 4, 3840, 2160, rig.Now.AddDays(-1));
        var standard = await M.Page(rig, rig.Member, M.SeasonPage(rig, rig.HdCopy));
        Assert.True(M.GapOf(M.EpisodeOf(standard, 3)) == null, $"E3 (a placeholder in the 4K folder) {M.EpisodeOf(standard, 3)}");
        Assert.Equal("standard", M.GapOf(M.EpisodeOf(standard, 4)));
    }

    [Fact]
    public async Task APlaceholderInThePagesOwnCopyIsNotReady()
    {
        // The same invariant on the page's own copy: the 4K folder's E3 is a stub (it plays nothing), so the 4K page says where
        // its Sonarr has got to, never "Ready".
        using var rig = M.OneLibrary(grouped: false);
        rig.Sonarr4k!.Episodes.Add(M.Aired(103, 3));
        rig.View.Placeholders.Add(rig.View.AddEpisodeFile(rig.UhdCopy, Firefly, 1, 3, null, null, rig.Now.AddDays(-1)));
        var fourK = await M.Page(rig, rig.Member, M.SeasonPage(rig, rig.UhdCopy));
        var e3 = M.EpisodeOf(fourK, 3);
        Assert.True(e3.GetProperty("stage").GetString() != StatusStage.Ready, $"4K E3 (a placeholder) {e3}");
        Assert.Equal(StatusStage.Ready, M.EpisodeOf(fourK, 1).GetProperty("stage").GetString());
    }

    // ------------------------------------------------------------------ ED-R15-4: the copy binding a season page acts on

    private static JsonElement? CopyOf(JsonElement season) => season.TryGetProperty("copy", out var copy) ? copy : null;

    private static string Describe(JsonElement? copy) => copy?.ToString() ?? "(none)";

    [Fact]
    public async Task ACopyQualifiedPageSaysWhichCopyItsActionsReach()
    {
        using var rig = M.OneLibrary(grouped: true);
        rig.Sonarr.Episodes.Add(M.Aired(103, 3));
        rig.Sonarr4k!.Episodes.Add(M.Aired(103, 3));
        rig.View.AddEpisodeFile(rig.UhdCopy, Firefly, 1, 3, 3840, 2160, rig.Now.AddDays(-1));
        rig.Sonarr4k.Episodes.Single(e => (int)e["id"]! == 103)["hasFile"] = true;
        // Jellyfin Enhanced's own transport: a request goes to the edition's default Sonarr (Seerr mode is proven by Seerr's own
        // servers, IntegrationEditionReferenceTests).
        rig.Arr.Plugin.Plugin.Configuration.ArrRequestBackend = "je";

        // The standard page: a request (standard) and a household Search reach the standard Sonarr. Family members get no instance.
        var standard = CopyOf(await M.Page(rig, rig.Member, M.SeasonPage(rig, rig.HdCopy)));
        Assert.True(standard is { } s && s.GetProperty("role").GetString() == "standard" && s.GetProperty("variant").GetString() == "standard"
            && s.GetProperty("ask").GetBoolean() && s.GetProperty("search").GetBoolean() && !s.TryGetProperty("instanceId", out _), "standard page copy " + Describe(standard));

        // The 4K page: a 4K request reaches the 4K Sonarr; a household Search never does (it searches standard copies only).
        var fourK = CopyOf(await M.Page(rig, rig.Member, M.SeasonPage(rig, rig.UhdCopy)));
        Assert.True(fourK is { } k && k.GetProperty("role").GetString() == "4k" && k.GetProperty("variant").GetString() == "4k"
            && k.GetProperty("ask").GetBoolean() && !k.GetProperty("search").GetBoolean(), "4K page copy " + Describe(fourK));

        // An administrator's Search runs on the page's own instance.
        var admin = CopyOf(await M.Page(rig, rig.Admin, M.SeasonPage(rig, rig.UhdCopy)));
        var sonarr4k = JsonNode.Parse(rig.Arr.Plugin.Plugin.Configuration.SonarrInstances)!.AsArray().Single(r => (string?)r!["Name"] == "Sonarr4kZ")!["Id"]!.GetValue<string>();
        Assert.True(admin is { } a && a.GetProperty("instanceId").GetString() == sonarr4k, "admin 4K page copy " + Describe(admin));
    }

    [Fact]
    public async Task ACopyNoRequestCanReachIsNeverOfferedAnAskUnderItsName()
    {
        using var rig = M.OneLibrary(grouped: true);
        // The second Sonarr is an anime instance: a request (standard) goes to the standard Sonarr, never to it.
        var config = rig.Arr.Plugin.Plugin.Configuration;
        var rows = JsonNode.Parse(config.SonarrInstances)!.AsArray();
        rows.Single(r => (string?)r!["Name"] == "Sonarr4kZ")!["Role"] = "anime";
        config.SonarrInstances = rows.ToJsonString();
        rig.Sonarr.Episodes.Add(M.Aired(103, 3));
        rig.Sonarr4k!.Episodes.Add(M.Aired(103, 3));
        rig.View.AddEpisodeFile(rig.HdCopy, Firefly, 1, 3, 1920, 1080, rig.Now.AddDays(-1));
        var anime = await M.Page(rig, rig.Member, M.SeasonPage(rig, rig.UhdCopy));
        var copy = CopyOf(anime);
        Assert.True(copy is { } c && c.GetProperty("role").GetString() == "anime" && !c.GetProperty("ask").GetBoolean() && !c.GetProperty("search").GetBoolean(),
            "anime page copy " + Describe(copy) + " gaps " + M.GapOf(M.EpisodeOf(anime, 3)));
    }

    // ------------------------------------------------------------------ Q-EDFIX16-1: the summary says what the rows say

    [Fact]
    public async Task TheSeasonSummaryCountsACopysOwnGapsAsThatCopysGaps()
    {
        using var rig = M.OneLibrary(grouped: true);
        rig.Sonarr.Episodes.Add(M.Aired(103, 3));
        rig.Sonarr.Episodes.Add(M.Aired(104, 4));
        rig.View.AddEpisodeFile(rig.UhdCopy, Firefly, 1, 3, 3840, 2160, rig.Now.AddDays(-1));
        var standard = await M.Page(rig, rig.Member, M.SeasonPage(rig, rig.HdCopy));
        var summary = standard.GetProperty("summary");
        // E3 ("Missing in standard") and E4 ("Missing") are both missing for a long while: one of them is this copy's gap.
        Assert.True(summary.GetProperty("longMissing").GetInt32() == 2 && summary.TryGetProperty("missingInCopy", out var inCopy) && inCopy.GetInt32() == 1,
            "summary " + summary);
    }
}
