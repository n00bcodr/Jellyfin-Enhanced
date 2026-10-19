using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Rig = JE.Tests.IntegrationEditionAvailabilityTests.Rig;
using Layout = JE.Tests.IntegrationEditionAvailabilityTests.Layout;
using Has = JE.Tests.IntegrationEditionAvailabilityTests.Has;

namespace JE.Tests;

/// <summary>
/// Edition round 11 (D53: the same fact reads the same on every surface). A queue row of an episode the viewer already
/// plays is an upgrade ("Ready · a better copy is coming"), never a download, on every surface that summarizes a series or
/// season: the series card, the season card, the series and season pages, the series by key (cards, the Requests page,
/// the alerts' watch) and the admin lines. The pages' per-episode reading decides it on all of them.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEditionUpgradeCountTests
{
    private static readonly TitleKey Firefly = TitleKey.Parse("tv:tvdb:78874")!;

    /// <summary>
    /// TV and TV 4K both play S1E1 and S1E2; both Sonarrs know S1E3 (aired, monitored, no file) and count 3 episodes,
    /// 2 with a file. <paramref name="standard"/> and <paramref name="fourK"/> name the episodes each Sonarr is downloading
    /// (an episode with a file is an upgrade); <paramref name="stalled"/> makes every row a stalled download.
    /// </summary>
    private static Rig FireflyRig(int[] standard, int[] fourK, bool stalled = false)
    {
        var rig = new Rig(Layout.SeparateLibraries, Has.Both, movie: false);
        foreach (var (sonarr, rows, tag) in new[] { (rig.Sonarr, standard, "dl"), (rig.Sonarr4k!, fourK, "dl4k") })
        {
            sonarr.Series[0]["seasons"] = new JsonArray(new JsonObject
            {
                ["seasonNumber"] = 1, ["monitored"] = true,
                ["statistics"] = new JsonObject { ["episodeCount"] = 3, ["episodeFileCount"] = 2, ["totalEpisodeCount"] = 3 },
            });
            sonarr.Episodes.Add(new JsonObject { ["id"] = 103, ["seriesId"] = 1, ["seasonNumber"] = 1, ["episodeNumber"] = 3, ["airDateUtc"] = "2002-09-23T00:00:00Z", ["hasFile"] = false, ["monitored"] = true });
            foreach (var e in rows)
            {
                var row = FakeArr.SonarrQueueRow(100 + e, tag + (100 + e), 1, e, "Firefly", 78874);
                if (stalled)
                {
                    row["trackedDownloadStatus"] = "warning";
                    row["statusMessages"] = new JsonArray(new JsonObject { ["title"] = "x", ["messages"] = new JsonArray("Stalled") });
                }
                sonarr.Queue.Add(row);
            }
        }
        return rig;
    }

    private sealed record Pages(Guid Series, Guid Season, Guid Episode2);

    private static Pages PagesOf(Rig rig, Guid series)
    {
        var season = Guid.NewGuid();
        rig.View.AddItem(new JfItemRef { ItemId = season, Kind = "season", Key = Firefly.WithSeason(1), SeriesId = series, Season = 1 });
        rig.View.Rev++;
        var episode2 = rig.View.Episodes(series, 1, rig.Admin, includeVirtual: false).Single(e => e.Episode == 2).ItemId;
        return new Pages(series, season, episode2);
    }

    private static List<JsonElement> Items(StatusBody body)
    {
        using var doc = JsonDocument.Parse(body.Json);
        return doc.RootElement.GetProperty("items").EnumerateArray().Select(e => e.Clone()).ToList();
    }

    /// <summary>A card (poster) as a page of posters asks for it; asked twice, so the arr reads it started have landed.</summary>
    private static async Task<JsonElement> Card(Rig rig, StatusViewer viewer, Guid id)
    {
        await rig.Service.ForBatchAsync(viewer, new[] { id }, Array.Empty<TitleKey>(), default);
        await Task.Delay(20);
        return Assert.Single(Items(await rig.Service.ForBatchAsync(viewer, new[] { id }, Array.Empty<TitleKey>(), default)));
    }

    private static async Task<JsonElement> ByKey(Rig rig, StatusViewer viewer)
        => Assert.Single(Items(await rig.Service.ForBatchAsync(viewer, Array.Empty<Guid>(), new[] { Firefly }, default)));

    private static async Task<JsonElement> Page(Rig rig, StatusViewer viewer, Guid id)
    {
        await rig.Service.ForItemAsync(viewer, id, default);
        await Task.Delay(20);
        return Assert.Single(Items(await rig.Service.ForItemAsync(viewer, id, default)));
    }

    private static int Summary(JsonElement status, string field)
        => status.TryGetProperty("summary", out var summary) && summary.TryGetProperty(field, out var n) ? n.GetInt32() : 0;

    private static string Stage(JsonElement status) => status.GetProperty("stage").GetString()!;

    private static string Code(JsonElement status) => status.GetProperty("reason").GetProperty("code").GetString()!;

    /// <summary>The admin line of an instance (not a problem line), if the status has one.</summary>
    private static JsonElement? Line(JsonElement status, string instance)
    {
        if (!status.TryGetProperty("admin", out var admin) || !admin.TryGetProperty("variants", out var variants)) return null;
        foreach (var v in variants.EnumerateArray())
        {
            if (v.GetProperty("instance").GetString() == instance && !v.TryGetProperty("scope", out _)) return v;
        }
        return null;
    }

    private static int Problems(JsonElement status)
        => status.TryGetProperty("admin", out var admin) && admin.TryGetProperty("variants", out var variants)
            ? variants.EnumerateArray().Count(v => v.TryGetProperty("scope", out _))
            : 0;

    // ------------------------------------------------------------------ one Sonarr: the card counts what the pages count

    [Theory]
    [InlineData("mixed")]          // the finding: S1E2 (has a file) upgrading + S1E3 (missing) downloading
    [InlineData("missingOnly")]    // control: only S1E3 downloading
    [InlineData("upgradesOnly")]   // control: only upgrades (S1E1, S1E2); S1E3 missing, nothing grabbed
    [InlineData("stalledUpgrade")] // control: S1E2's upgrade is stalled (a problem for a download, not for an upgrade)
    public async Task ASeriesAndSeasonCardCountAnUpgradeAsTheirPagesDoNeverAsADownload(string shape)
    {
        var queued = shape switch { "mixed" => new[] { 2, 3 }, "missingOnly" => new[] { 3 }, "upgradesOnly" => new[] { 1, 2 }, _ => new[] { 2 } };
        using var rig = FireflyRig(queued, Array.Empty<int>(), stalled: shape == "stalledUpgrade");
        var hd = PagesOf(rig, rig.HdCopy);
        var downloading = queued.Count(e => e == 3);
        var missing = downloading == 0 ? 1 : 0;
        var upgrading = queued.Any(e => e != 3);

        foreach (var viewer in new[] { rig.Member, rig.Admin })
        {
            rig.Service.Cache.Clear();
            // The member's season card comes before any page read Sonarr's episode list: it counts from Sonarr's statistics
            // and the queue (the admin's after, from the list: both must read as the page).
            var seasonCard = await Card(rig, viewer, hd.Season);
            var seasonPage = await Page(rig, viewer, hd.Season);
            var seriesPage = await Page(rig, viewer, hd.Series);
            var seriesCard = await Card(rig, viewer, hd.Series);
            var warmSeasonCard = await Card(rig, viewer, hd.Season);
            var key = await ByKey(rig, viewer);
            var episode = await Page(rig, viewer, hd.Episode2);
            var who = viewer.IsAdmin ? "admin" : "member";

            // The pages (the reference): an upgrade is Ready, a better copy coming.
            Assert.Equal((downloading, missing), (Summary(seriesPage, "downloading"), Summary(seriesPage, "missing")));
            Assert.Equal((downloading, missing), (Summary(seasonPage, "downloading"), Summary(seasonPage, "missing")));
            Assert.Equal(upgrading ? StatusReasonCode.Upgrading : StatusReasonCode.Ready, Code(episode));
            Assert.Equal(0, Summary(seriesPage, "attention"));

            // The series card: the same downloads, no problem, no download stage or ring for an upgrade.
            Assert.True(Summary(seriesCard, "downloading") == downloading, $"{shape}/{who}: series card downloading {Summary(seriesCard, "downloading")}, pages {downloading}");
            Assert.Equal(Summary(seriesPage, "attention"), Summary(seriesCard, "attention"));
            Assert.Equal(downloading > 0, Stage(seriesCard) == StatusStage.Downloading);
            Assert.Equal(downloading == 1, seriesCard.TryGetProperty("progress", out _));
            Assert.False(seriesCard.GetProperty("attention").GetBoolean(), $"{shape}/{who}: series card attention");

            // The season card, cold (Sonarr's statistics) and warm (Sonarr's episode list), reads as its page.
            foreach (var (card, when) in new[] { (seasonCard, "cold"), (warmSeasonCard, "warm") })
            {
                Assert.True(Summary(card, "downloading") == downloading, $"{shape}/{who}/{when}: season card downloading {Summary(card, "downloading")}, pages {downloading}");
                Assert.True(Summary(card, "missing") == missing, $"{shape}/{who}/{when}: season card missing {Summary(card, "missing")}, pages {missing}");
                Assert.Equal((Summary(seasonPage, "ready"), Summary(seasonPage, "aired")), (Summary(card, "ready"), Summary(card, "aired")));
                Assert.Equal(Stage(seasonPage), Stage(card));
                Assert.Equal(0, Summary(card, "attention"));
            }

            // The series by key (cards of titles, the Requests page, the alerts' watch): never "downloading" for upgrades.
            Assert.Equal(downloading > 0, Stage(key) == StatusStage.Downloading);
            Assert.False(key.GetProperty("attention").GetBoolean(), $"{shape}/{who}: by key attention");
            if (viewer.IsAdmin)
            {
                Assert.Equal(0, Problems(seriesCard));
                Assert.Equal(0, Problems(seriesPage));
            }
        }
    }

    [Theory]
    [InlineData("mixed", 1)]
    [InlineData("upgradesOnly", 0)]
    public async Task ARequestedSeasonCountsAnUpgradeAsItsPageDoes(string shape, int downloading)
    {
        // The alerts' watch and the Requests page read a requested season by key, often with no episode list in memory.
        using var rig = FireflyRig(shape == "mixed" ? new[] { 2, 3 } : new[] { 1, 2 }, Array.Empty<int>());
        var scopes = new Dictionary<TitleKey, ArrStatusService.RequestScope> { [Firefly] = new(new[] { 1 }, false, null) };
        await rig.Service.ComposeForAsync(rig.Member, new[] { Firefly }, scopes, default);
        await Task.Delay(20);
        var cold = Assert.Single(await rig.Service.ComposeForAsync(rig.Member, new[] { Firefly }, scopes, default));
        var warm = Assert.Single(await rig.Service.ComposeForAsync(rig.Member, new[] { Firefly }, scopes, default, loadEpisodes: true));
        foreach (var (status, when) in new[] { (cold.Status, "cold"), (warm.Status, "warm") })
        {
            Assert.True(status.Summary?.Downloading == downloading, $"{shape}/{when}: requested season downloading {status.Summary?.Downloading}");
            Assert.Equal(downloading > 0, status.Stage == StatusStage.Downloading);
            Assert.Equal(1 - downloading, status.Summary?.Missing);
        }
        var whole = Assert.Single(await rig.Service.ComposeForAsync(rig.Member, new[] { Firefly }, null, default));
        Assert.Equal(downloading > 0, whole.Status.Stage == StatusStage.Downloading);
    }

    // ------------------------------------------------------------------ two Sonarrs: 4K and standard are kept apart

    [Theory]
    [InlineData(true)]  // the standard Sonarr downloads S1E3, the 4K Sonarr upgrades S1E2
    [InlineData(false)] // the standard Sonarr upgrades S1E2, the 4K Sonarr downloads S1E3
    public async Task FourKAndStandardCopiesEachCountTheirOwnUpgradesAndDownloads(bool standardDownloads)
    {
        using var rig = standardDownloads ? FireflyRig(new[] { 3 }, new[] { 2 }) : FireflyRig(new[] { 2 }, new[] { 3 });
        var hd = PagesOf(rig, rig.HdCopy);
        var uhd = PagesOf(rig, rig.UhdCopy);
        foreach (var (pages, sonarr, other, downloads) in new[] { (hd, "SonarrZ", "Sonarr4kZ", standardDownloads), (uhd, "Sonarr4kZ", "SonarrZ", !standardDownloads) })
        {
            var n = downloads ? 1 : 0;
            foreach (var viewer in new[] { rig.Member, rig.Admin })
            {
                var seasonCard = await Card(rig, viewer, pages.Season);
                var seriesPage = await Page(rig, viewer, pages.Series);
                var seasonPage = await Page(rig, viewer, pages.Season);
                var seriesCard = await Card(rig, viewer, pages.Series);
                var episode = await Page(rig, viewer, pages.Episode2);
                Assert.Equal(n, Summary(seriesPage, "downloading"));
                Assert.Equal(n, Summary(seasonPage, "downloading"));
                Assert.True(Summary(seriesCard, "downloading") == n, $"{sonarr}/{(viewer.IsAdmin ? "admin" : "member")}: series card downloading {Summary(seriesCard, "downloading")}, pages {n}");
                Assert.Equal(n, Summary(seasonCard, "downloading"));
                Assert.Equal(downloads, Stage(seriesCard) == StatusStage.Downloading);
                Assert.Equal(downloads ? StatusReasonCode.Ready : StatusReasonCode.Upgrading, Code(episode));
                if (!viewer.IsAdmin) continue;

                // The admin lines: this copy's Sonarr, and the other copy's (each by its own copy's files).
                Assert.Equal(downloads, Line(seriesPage, sonarr)?.GetProperty("stage").GetString() == StatusStage.Downloading);
                var otherLine = Line(seriesPage, other);
                Assert.NotNull(otherLine);
                Assert.True((otherLine!.Value.GetProperty("stage").GetString() == StatusStage.Downloading) == !downloads, $"{sonarr} page: {other} line {otherLine.Value.GetProperty("stage").GetString()}");
                var otherSeasonLine = Line(seasonPage, other);
                Assert.NotNull(otherSeasonLine);
                Assert.Equal(!downloads, otherSeasonLine!.Value.GetProperty("stage").GetString() == StatusStage.Downloading);
                // The episode page lists the other Sonarr only for a download of that episode: S1E2 is the other's upgrade.
                var otherEpisodeLine = Line(episode, other);
                if (downloads)
                {
                    Assert.NotNull(otherEpisodeLine);
                    Assert.Equal((StatusStage.Ready, StatusReasonCode.Upgrading), (otherEpisodeLine!.Value.GetProperty("stage").GetString(), otherEpisodeLine.Value.GetProperty("reason").GetProperty("code").GetString()));
                }
                else
                {
                    Assert.Null(otherEpisodeLine);
                }
            }
        }

        // By key the admin sees each Sonarr's line: a download only where one is.
        var key = await ByKey(rig, rig.Admin);
        Assert.Equal(standardDownloads, Line(key, "SonarrZ")?.GetProperty("stage").GetString() == StatusStage.Downloading);
        Assert.Equal(!standardDownloads, Line(key, "Sonarr4kZ")?.GetProperty("stage").GetString() == StatusStage.Downloading);
        Assert.Equal(standardDownloads, Stage(await ByKey(rig, rig.Member)) == StatusStage.Downloading);
    }

    [Fact]
    public async Task AStalledUpgradeOnTheOtherSonarrIsNoProblemLineOnTheCardOrThePage()
    {
        // The 4K Sonarr's S1E2 upgrade is stalled: the 4K copy plays S1E2, so it is an upgrade there, as the 4K pages say.
        using var rig = FireflyRig(new[] { 3 }, new[] { 2 }, stalled: true);
        var hd = PagesOf(rig, rig.HdCopy);
        var uhd = PagesOf(rig, rig.UhdCopy);
        var uhdPage = await Page(rig, rig.Admin, uhd.Series);
        Assert.Equal(0, Summary(uhdPage, "attention"));
        var hdCard = await Card(rig, rig.Admin, hd.Series);
        var hdPage = await Page(rig, rig.Admin, hd.Series);
        // The standard Sonarr's own S1E3 is stalled too (a download's problem): one problem line, S1E3, on both.
        Assert.Equal(Problems(hdPage), Problems(hdCard));
        Assert.Equal(1, Problems(hdCard));
    }
}
