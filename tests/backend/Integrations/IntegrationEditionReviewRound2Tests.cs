using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Rig = JE.Tests.IntegrationEditionAvailabilityTests.Rig;
using Layout = JE.Tests.IntegrationEditionAvailabilityTests.Layout;
using Has = JE.Tests.IntegrationEditionAvailabilityTests.Has;

namespace JE.Tests;

/// <summary>
/// Edition availability, review round 2: the Requests page never fails with an error when its viewer changes or goes
/// away while it is prepared (it is prepared again, or answers as for a viewer who isn't there); a series copy's page
/// and card read only the Sonarr that owns that copy for sure, and folder names count only when they tell the copies
/// apart (one copy with one Sonarr keeps its facts however its folders are named); a whole-series 4K request with no
/// 4K seasons to follow is Ready from the 4K episodes the viewer can open, not on Seerr's word.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEditionReviewRound2Tests
{
    private const string Matrix = "movie:tmdb:603";
    private static readonly TitleKey Firefly = TitleKey.Parse("tv:tvdb:78874")!;

    // ------------------------------------------------------------------ r2-1: the Requests page's viewer changes or goes

    [Fact]
    public async Task ARequestsPageWhoseViewerIsRemovedWhileItIsPreparedAnswersAsForNobody()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        await lab.Warm();
        await lab.Ask(lab.Emma, new MutationInput { Key = Matrix });
        await lab.Outbox.TickAsync(default);
        Assert.NotNull(await lab.Hub.ForViewerAsync(lab.Emma, default));

        // Emma is deleted (or disabled: Jellyfin no longer gives her) while her page reads the arrs.
        var reads = 0;
        lab.View.OnCopies = () =>
        {
            if (reads++ > 0) return;
            lab.View.Users.Remove(lab.Emma.UserId);
            lab.View.Rev++;
        };
        Assert.Null(await lab.Hub.ForViewerAsync(lab.Emma, default));
    }

    [Fact]
    public async Task ARequestsPageWhoseViewerKeepsChangingFailsClosedAfterItsAttempts()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        await lab.Warm();
        await lab.Ask(lab.Emma, new MutationInput { Key = Matrix });
        await lab.Outbox.TickAsync(default);

        // Her policy changes during every preparation (up to 30 times): prepared again a bounded number of times, then
        // nothing (an endless retry would outlast the changes and answer).
        var changes = 0;
        lab.View.OnCopies = () =>
        {
            if (changes >= 30) return;
            changes++;
            lab.View.Revoke(lab.View.Users[lab.Emma.UserId]);
            lab.View.Rev++;
        };
        Assert.Null(await lab.Hub.ForViewerAsync(lab.Emma, default));
        Assert.InRange(changes, ArrStatusService.GateAttempts, 29);

        // Changed once: prepared again for her as she is now, and answered.
        changes = 29;
        Assert.NotNull(await lab.Hub.ForViewerAsync(lab.View.Users[lab.Emma.UserId], default));
    }

    // ------------------------------------------------------------------ r2-2 / r2-3: whose Sonarr a series copy reads

    /// <summary>Drops every Sonarr's path mapping (Jellyfin and the arrs see different roots, nothing maps them).</summary>
    private static void Unmapped(Rig rig)
    {
        var c = rig.Arr.Plugin.Plugin.Configuration;
        var rows = JsonNode.Parse(c.SonarrInstances)!.AsArray();
        foreach (var row in rows) row!["PathMappings"] = new JsonArray();
        c.SonarrInstances = rows.ToJsonString();
    }

    private static void LinkSonarrsTo(Rig rig, string library)
    {
        var c = rig.Arr.Plugin.Plugin.Configuration;
        var rows = JsonNode.Parse(c.SonarrInstances)!.AsArray();
        foreach (var row in rows) row!["LinkedLibraryIds"] = new JsonArray(library);
        c.SonarrInstances = rows.ToJsonString();
    }

    /// <summary>Moves the title's Jellyfin series copies (standard, then 4K) and the Sonarrs' series folders.</summary>
    private static void Place(Rig rig, string hd, string? uhd, string sonarr, string? sonarr4k)
    {
        var list = rig.View.CopiesByKey[Firefly.ToString()];
        for (var i = 0; i < list.Count; i++)
        {
            var (copy, to) = list[i];
            var path = copy.ItemId == rig.HdCopy ? hd : uhd!;
            list[i] = (new JfCopy { ItemId = copy.ItemId, Path = path, LibraryId = copy.LibraryId, LibraryName = copy.LibraryName, DateCreated = copy.DateCreated }, to);
            var item = rig.View.Items[copy.ItemId].Ref;
            rig.View.Items[copy.ItemId] = new FakeJellyfinView.Item(new JfItemRef { ItemId = item.ItemId, Kind = item.Kind, Key = item.Key, Path = path }, null);
        }
        rig.Sonarr.Series[0]["path"] = sonarr;
        if (sonarr4k != null) rig.Sonarr4k!.Series[0]["path"] = sonarr4k;
        rig.View.Rev++;
    }

    /// <summary>
    /// The standard Sonarr's own facts: S1E3's file (a missing S1E3 page reads "Almost ready") and a download of S1E4
    /// (a card reads "Downloading"). The 4K Sonarr has neither.
    /// </summary>
    private static void StandardFacts(Rig rig)
    {
        rig.Sonarr.Episodes.Add(SonarrEpisode(103, 3, hasFile: true));
        rig.Sonarr.Episodes.Add(SonarrEpisode(104, 4, hasFile: false));
        rig.Sonarr.Queue.Add(FakeArr.SonarrQueueRow(104, "dl104", 1, 4, "Firefly", 78874));
        rig.Sonarr4k?.Episodes.Add(SonarrEpisode(103, 3, hasFile: false));
        rig.Sonarr4k?.Episodes.Add(SonarrEpisode(104, 4, hasFile: false));
    }

    private static JsonObject SonarrEpisode(int id, int number, bool hasFile)
        => new() { ["id"] = id, ["seriesId"] = 1, ["seasonNumber"] = 1, ["episodeNumber"] = number, ["airDateUtc"] = "2002-09-23T00:00:00Z", ["hasFile"] = hasFile, ["monitored"] = true };

    private static Guid MissingEpisode(Rig rig, Guid series, int episode)
    {
        var id = Guid.NewGuid();
        rig.View.AddItem(new JfItemRef { ItemId = id, Kind = "episode", Key = Firefly.WithEpisode(1, episode), SeriesId = series, Season = 1, Episode = episode, Virtual = true });
        rig.View.AddEpisode(series, new JfEpisode { ItemId = id, Season = 1, Episode = episode, Virtual = true });
        rig.View.Rev++;
        return id;
    }

    /// <summary>What a copy shows: its missing S1E3 page, its series page's admin line and its series card.</summary>
    private sealed record Shown(string EpisodeStage, string? EpisodeInstance, string? SeriesInstance, string CardStage);

    private static async Task<Shown> ShownFor(Rig rig, Guid series, Guid missing)
    {
        var episode = Items(await Page(rig, rig.Admin, missing))[0];
        var page = Items(await Page(rig, rig.Admin, series))[0];
        var card = Items(Encoding(await rig.Service.ForBatchAsync(rig.Member, new[] { series }, Array.Empty<TitleKey>(), default)))[0];
        return new Shown(episode.GetProperty("stage").GetString()!, FirstInstance(episode), FirstInstance(page), card.GetProperty("stage").GetString()!);
    }

    private static string? FirstInstance(JsonElement status)
        => status.TryGetProperty("admin", out var admin) && admin.TryGetProperty("variants", out var variants) && variants.GetArrayLength() > 0
            ? variants[0].GetProperty("instance").GetString()
            : null;

    private static async Task<(Guid Hd, Guid Uhd)> Warm(Rig rig)
    {
        var hd = MissingEpisode(rig, rig.HdCopy, 3);
        var uhd = MissingEpisode(rig, rig.UhdCopy, 3);
        await Page(rig, rig.Admin, uhd);
        await rig.Service.ForBatchAsync(rig.Member, new[] { rig.UhdCopy }, Array.Empty<TitleKey>(), default);
        await Task.Delay(20);
        return (hd, uhd);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task TwoCopiesUnderTheSameFolderNamesWithNoMappingReadNoSonarrsFacts(bool linked)
    {
        // A standard and a 4K folder of Firefly, grouped in one TV library, under the same root and title folder names
        // (".../TV/Firefly"); each Sonarr's folder ends the same way too, and nothing maps the arrs' paths to Jellyfin's.
        // Which Sonarr holds which copy can't be told: neither copy reads either Sonarr's files, downloads or upgrades.
        using var rig = new Rig(Layout.GroupedFolders, Has.Hd, movie: false);
        Unmapped(rig);
        if (linked) LinkSonarrsTo(rig, "TV");
        Place(rig, "/mnt/disk1/TV/Firefly", "/mnt/disk2/TV/Firefly", "/standard/TV/Firefly", "/4k/TV/Firefly");
        StandardFacts(rig);
        var (hd, uhd) = await Warm(rig);

        foreach (var (series, missing) in new[] { (rig.UhdCopy, uhd), (rig.HdCopy, hd) })
        {
            var shown = await ShownFor(rig, series, missing);
            Assert.NotEqual(StatusStage.AlmostReady, shown.EpisodeStage);
            Assert.NotEqual("SonarrZ", shown.EpisodeInstance);
            Assert.NotEqual("SonarrZ", shown.SeriesInstance);
            Assert.NotEqual(StatusStage.Downloading, shown.CardStage);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task EachCopyReadsItsOwnSonarrWhenTheFoldersTellThemApart(bool linked)
    {
        // The arrs' paths equal Jellyfin's (no mapping needed), though the folder names are the same.
        using (var rig = new Rig(Layout.GroupedFolders, Has.Hd, movie: false))
        {
            Unmapped(rig);
            if (linked) LinkSonarrsTo(rig, "TV");
            Place(rig, "/mnt/disk1/TV/Firefly", "/mnt/disk2/TV/Firefly", "/mnt/disk1/TV/Firefly", "/mnt/disk2/TV/Firefly");
            StandardFacts(rig);
            await AssertOwn(rig, await Warm(rig));
        }

        // Different roots and no mapping, but distinct root folder names ("tv" and "tv4k"), each matching one copy.
        using (var rig = new Rig(Layout.GroupedFolders, Has.Hd, movie: false))
        {
            Unmapped(rig);
            if (linked) LinkSonarrsTo(rig, "TV");
            Place(rig, "/media/tv/Firefly", "/media/tv4k/Firefly", "/data/tv/Firefly", "/data/tv4k/Firefly");
            StandardFacts(rig);
            await AssertOwn(rig, await Warm(rig));
        }

        // The rig's mapping (/data is Jellyfin's /media).
        using (var rig = new Rig(Layout.GroupedFolders, Has.Hd, movie: false))
        {
            if (linked) LinkSonarrsTo(rig, "TV");
            StandardFacts(rig);
            await AssertOwn(rig, await Warm(rig));
        }

        static async Task AssertOwn(Rig rig, (Guid Hd, Guid Uhd) missing)
        {
            var fourK = await ShownFor(rig, rig.UhdCopy, missing.Uhd);
            Assert.NotEqual(StatusStage.AlmostReady, fourK.EpisodeStage);
            Assert.Equal("Sonarr4kZ", fourK.EpisodeInstance);
            Assert.Equal("Sonarr4kZ", fourK.SeriesInstance);
            Assert.NotEqual(StatusStage.Downloading, fourK.CardStage);
            var standard = await ShownFor(rig, rig.HdCopy, missing.Hd);
            Assert.Equal(StatusStage.AlmostReady, standard.EpisodeStage);
            Assert.Equal("SonarrZ", standard.EpisodeInstance);
            Assert.Equal("SonarrZ", standard.SeriesInstance);
            Assert.Equal(StatusStage.Downloading, standard.CardStage);
        }
    }

    [Theory]
    [InlineData("/data/tv/Firefly", true)]
    [InlineData("/volume1/Series/Firefly", false)]
    [InlineData("/data/TV/FIREFLY", false)]
    [InlineData("/data/tv/Firefly (2002)", false)]
    [InlineData("/data/tv/Firefly - Serenity's Crew!", false)]
    [InlineData("/data/tv/Serenity", false)]
    public async Task OneCopyWithOneSonarrKeepsItsFactsHoweverTheFoldersAreNamed(string sonarrPath, bool mapped)
    {
        // Q-VER-14: one Jellyfin copy (/media/tv/Firefly) and one Sonarr, whose folder differs in root, case, year
        // suffix, punctuation or name, with or without a mapping. The copy is the Sonarr's: its page and card read it.
        using var rig = new Rig(Layout.NoFourKArrSeerr, Has.Hd, movie: false);
        if (!mapped) Unmapped(rig);
        rig.Sonarr.Series[0]["path"] = sonarrPath;
        StandardFacts(rig);
        var missing = MissingEpisode(rig, rig.HdCopy, 3);
        await Page(rig, rig.Admin, missing);
        await Task.Delay(20);

        var shown = await ShownFor(rig, rig.HdCopy, missing);
        Assert.Equal((StatusStage.AlmostReady, "SonarrZ", "SonarrZ", StatusStage.Downloading), (shown.EpisodeStage, shown.EpisodeInstance, shown.SeriesInstance, shown.CardStage));
    }

    [Fact]
    public async Task AFourKSeriesCardReadsTheFourKSonarrNotTheStandardOnesDownload()
    {
        // TV and TV 4K (separate libraries, the rig's mapping): the standard Sonarr is downloading S1E4.
        using var rig = new Rig(Layout.SeparateLibraries, Has.Hd, movie: false);
        StandardFacts(rig);
        await rig.Service.ForBatchAsync(rig.Member, new[] { rig.UhdCopy, rig.HdCopy }, Array.Empty<TitleKey>(), default);
        await Task.Delay(20);
        var cards = Items(Encoding(await rig.Service.ForBatchAsync(rig.Member, new[] { rig.UhdCopy, rig.HdCopy }, Array.Empty<TitleKey>(), default)));
        var byId = cards.ToDictionary(c => Guid.Parse(c.GetProperty("itemId").GetString()!), c => c);
        Assert.NotEqual(StatusStage.Downloading, byId[rig.UhdCopy].GetProperty("stage").GetString());
        Assert.False(byId[rig.UhdCopy].TryGetProperty("progress", out _));
        Assert.Equal(StatusStage.Downloading, byId[rig.HdCopy].GetProperty("stage").GetString());
    }

    // ------------------------------------------------------------------ beh r2-1: a whole-series 4K request with no 4K seasons to follow

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WithNo4kSeasonsToFollowAWholeSeries4kRequestReadsTheLocal4kEpisodesNotOnlySeerr(bool fourKSonarr)
    {
        // A whole-series 4K request (no seasons or episodes named). Either no 4K Sonarr in Jellyfin Enhanced, or one
        // that monitors no season. Seerr hasn't said the 4K copy is available, but TV 4K has 2160p episodes.
        using var rig = new Rig(fourKSonarr ? Layout.SeparateLibraries : Layout.NoFourKArrSeerr, Has.Hd, movie: false);
        var uhd = rig.UhdCopy;
        if (fourKSonarr)
        {
            rig.Sonarr4k!.Series[0]["seasons"] = new JsonArray(new JsonObject { ["seasonNumber"] = 1, ["monitored"] = false });
        }
        else
        {
            uhd = Guid.NewGuid();
            rig.SeriesCopy(uhd, "/media/tv4k/Firefly", "TV 4K");
        }
        var first = rig.Now.AddDays(-3);
        var last = rig.Now.AddHours(-2);
        rig.View.AddEpisodeFile(uhd, Firefly, 1, 1, 3840, 2160, first);
        rig.View.AddEpisodeFile(uhd, Firefly, 1, 2, 3840, 2160, last);
        var scope = new ArrStatusService.RequestScope(Array.Empty<int>(), true, null);
        var composed = await Whole(rig, scope);
        Assert.Equal((StatusStage.Ready, (Guid?)uhd), (composed.Status.Stage, composed.Visible?.ItemId));
        // It arrived when the newest 4K episode did, not when Seerr says.
        Assert.Equal(last, composed.ArrivedAt);
        var seerr = await Whole(rig, scope with { Available = true, AvailableAt = rig.Now.AddMinutes(-1), JellyfinItemId = uhd });
        Assert.Equal((StatusStage.Ready, (DateTime?)last), (seerr.Status.Stage, seerr.ArrivedAt));

        // Seerr saying "available" for a copy that holds no 4K episode is not enough.
        rig.View.Items.Remove(uhd);
        rig.View.CopiesByKey[Firefly.ToString()].RemoveAll(c => c.Copy.ItemId == uhd);
        rig.View.Rev++;
        var none = await Whole(rig, scope with { Available = true, AvailableAt = rig.Now, JellyfinItemId = rig.HdCopy });
        Assert.NotEqual(StatusStage.Ready, none.Status.Stage);
        Assert.Null(none.ArrivedAt);
    }

    [Fact]
    public async Task A4kEpisodeWithNoArrivalTimeTakesSeerrsTime()
    {
        using var rig = new Rig(Layout.NoFourKArrSeerr, Has.Hd, movie: false);
        var uhd = Guid.NewGuid();
        rig.SeriesCopy(uhd, "/media/tv4k/Firefly", "TV 4K");
        rig.View.AddEpisodeFile(uhd, Firefly, 1, 1, 3840, 2160, created: null);
        var at = rig.Now.AddHours(-5);
        var composed = await Whole(rig, new ArrStatusService.RequestScope(Array.Empty<int>(), true, null, Available: true, AvailableAt: at));
        Assert.Equal((StatusStage.Ready, (DateTime?)at), (composed.Status.Stage, composed.ArrivedAt));
    }

    // ------------------------------------------------------------------ helpers

    private static async Task<ArrStatusService.KeyedStatus> Whole(Rig rig, ArrStatusService.RequestScope scope)
    {
        var scopes = new Dictionary<TitleKey, ArrStatusService.RequestScope> { [Firefly] = scope };
        await rig.Service.ComposeForAsync(rig.Member, new[] { Firefly }, scopes, default, loadEpisodes: true);
        await Task.Delay(20);
        return Assert.Single(await rig.Service.ComposeForAsync(rig.Member, new[] { Firefly }, scopes, default, loadEpisodes: true));
    }

    private static async Task<string> Page(Rig rig, StatusViewer viewer, Guid id)
        => Encoding(await rig.Service.ForItemAsync(viewer, id, default));

    private static string Encoding(StatusBody body) => System.Text.Encoding.UTF8.GetString(body.Json);

    private static List<JsonElement> Items(string body)
    {
        using var doc = JsonDocument.Parse(body);
        return doc.RootElement.GetProperty("items").EnumerateArray().Select(e => e.Clone()).ToList();
    }
}
