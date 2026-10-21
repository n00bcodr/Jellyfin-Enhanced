using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using MediaBrowser.Controller.Entities;
using Moq;
using Rig = JE.Tests.IntegrationEditionAvailabilityTests.Rig;
using Layout = JE.Tests.IntegrationEditionAvailabilityTests.Layout;
using Has = JE.Tests.IntegrationEditionAvailabilityTests.Has;
using M = JE.Tests.IntegrationEditionMaskedTests;
using N = JE.Tests.IntegrationNotificationsTests;

namespace JE.Tests;

/// <summary>
/// Edition round 20, part B (D53): no availability signal other than Jellyfin's decides "you have it" on a surface Jellyfin
/// Enhanced draws (an arr's hasFile or file count is an input to ownership and progress only; the calendar's Available and
/// Play ask the one predicate); a season is the copy's only when that copy plays an episode of it; and an arrival is an
/// observed transition with the item's current identity: an edition that became available on an existing path is an
/// arrival, and a held alert announces only episodes its items still are and play, rebuilt from those (an older alert
/// without its episode items is checked by its scope or not sent).
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEditionTransitionTests
{
    private static readonly TitleKey Firefly = TitleKey.Parse("tv:tvdb:78874")!;
    private static readonly TitleKey Severance = TitleKey.Parse("tv:tvdb:371980")!;
    private const string Dune = "movie:tmdb:693134";

    private static void SeriesRequest(N.Rig r, bool fourK)
    {
        if (fourK) N.FourKSonarr(r);
        r.Request(30, 95396, r.Emma, type: "tv", tvdb: 371980, seasons: new[] { 2 }, is4k: fourK);
    }

    private static Guid SeriesCopy(N.Rig rig, string path, string library)
    {
        var copy = Guid.NewGuid();
        rig.View.AddCopy(Severance, new JfCopy { ItemId = copy, Path = path, LibraryName = library, DateCreated = rig.Arr.Now.UtcDateTime });
        return copy;
    }

    private static async Task Arrivals(N.Rig rig, string key)
    {
        await rig.Step(key);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step();
    }

    private static void QuietAllDay(N.Rig rig) => rig.Prefs(rig.Emma, p => { p.QuietHours = true; p.QuietFrom = "00:00"; p.QuietTo = "23:59"; p.UtcOffsetMinutes = 0; });

    private static async Task QuietEnds(N.Rig rig)
    {
        rig.Prefs(rig.Emma, p => p.QuietHours = false);
        rig.Arr.Now = rig.Arr.Now.AddDays(1);
        await rig.Dispatcher.RunOnceAsync(default);
    }

    // ------------------------------------------------------------------ ED-R19-4: the calendar's Available and Play ask Jellyfin

    public static TheoryData<string, bool> CalendarCases() => new()
    {
        { "arr has the file, Jellyfin has no item", false }, // the arr's hasFile alone
        { "Jellyfin plays the episode", true },               // control
        { "Jellyfin lists only a stub", false },              // a ".disc" placeholder plays nothing
        { "Jellyfin lists the episode as missing", false },   // a virtual item
    };

    [Theory]
    [MemberData(nameof(CalendarCases))]
    public async Task ACalendarEpisodeIsAvailableOnlyWhenTheCallerHasAPlayableJellyfinItem(string jellyfin, bool available)
    {
        using var rig = new IntegrationCalendarAccessTests.CalendarRig();
        rig.Tv.Calendar[0]["hasFile"] = true;
        if (jellyfin != "arr has the file, Jellyfin has no item")
        {
            var series = new MediaBrowser.Controller.Entities.TV.Series { Id = Guid.NewGuid() };
            var episode = new MediaBrowser.Controller.Entities.TV.Episode
            {
                Id = Guid.NewGuid(), SeriesId = series.Id, ParentIndexNumber = 1, IndexNumber = 1,
                Path = jellyfin == "Jellyfin lists the episode as missing" ? null : jellyfin == "Jellyfin lists only a stub" ? "/media/tv/Show A/S01E01.disc" : "/media/tv/Show A/S01E01.mkv",
                IsPlaceHolder = jellyfin == "Jellyfin lists only a stub",
                IsVirtualItem = jellyfin == "Jellyfin lists the episode as missing",
            };
            using (var db = rig.Database.CreateDbContext())
            {
                db.BaseItemProviders.Add(new BaseItemProvider { Item = null!, ItemId = series.Id, ProviderId = "Tvdb", ProviderValue = "501" });
                db.SaveChanges();
            }
            rig.Library.Setup(l => l.GetItemById<BaseItem>(series.Id, It.IsAny<User>())).Returns(series);
            rig.Library.Setup(l => l.GetItemById<BaseItem>(series.Id)).Returns(series);
            rig.Library.Setup(l => l.GetItemById<BaseItem>(episode.Id, It.IsAny<User>())).Returns(episode);
            rig.Library.Setup(l => l.GetItemById<BaseItem>(episode.Id)).Returns(episode);
            rig.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new List<BaseItem> { episode });
        }
        foreach (var caller in new[] { TestCallers.Principal(rig.Member.Id, admin: false), TestCallers.Principal(rig.Callers.Register(Guid.NewGuid(), admin: true, "admin").Id, admin: true) })
        {
            var row = Assert.Single(await rig.Events(caller), e => e.Title == "Show A");
            Assert.True(row.HasFile == available, $"{jellyfin}: hasFile={row.HasFile} item={row.ItemEpisodeId}");
        }
    }

    // ------------------------------------------------------------------ ED-R19-5 / -6: a season is a copy's only when it plays an episode of it

    [Fact]
    public void AStubOnlySeasonIsNeitherInTheLibraryNorAnArrival()
    {
        using var r = new Rig(Layout.SeparateLibraries, Has.Hd, movie: false);
        foreach (var e in r.View.EpisodesBySeries[r.HdCopy]) r.View.Placeholders.Add(e.Episode.ItemId);
        r.View.Rev++;
        var season = M.SeasonPage(r, r.HdCopy);
        Assert.Empty(r.Service.Editions.Scope(r.Member, Firefly.WithSeason(1), Edition.Any));
        Assert.Null(r.Service.LibraryItemFor(r.Member, Firefly.WithSeason(1)));
        // The page that showed the season (pinned to its copy), and one whose virtual season item Jellyfin deleted.
        Assert.Null(r.Service.ArrivedItem(r.Member, Firefly.WithSeason(1), null, r.HdCopy));
        Assert.Null(r.Service.ArrivedItem(r.Member, Firefly.WithSeason(1), season, r.HdCopy));
        var deleted = Guid.NewGuid();
        Assert.False(r.View.ItemExists(deleted));
        Assert.Null(r.Service.ArrivedItem(r.Member, Firefly.WithSeason(1), deleted, r.HdCopy));
    }

    [Fact]
    public void TheSeasonInTheLibraryIsTheOneACopyPlaysNotTheFirstCopysStubs()
    {
        using var r = new Rig(Layout.SeparateLibraries, Has.Both, movie: false);
        foreach (var e in r.View.EpisodesBySeries[r.HdCopy]) r.View.Placeholders.Add(e.Episode.ItemId);
        r.View.Rev++;
        M.SeasonPage(r, r.HdCopy);
        var playable = M.SeasonPage(r, r.UhdCopy);
        Assert.True(r.Service.Editions.Available(r.Member, Firefly.WithSeason(1), Edition.Any));
        Assert.Equal(playable, r.Service.LibraryItemFor(r.Member, Firefly.WithSeason(1)));
        Assert.Equal(playable, r.Service.ScopeItem(r.Member, Firefly.WithSeason(1))?.ItemId);
        // Unpinned (no copy named), the arrival is the playable season too; pinned to the stub copy, it stays put.
        Assert.Equal(playable, r.Service.ArrivedItem(r.Member, Firefly.WithSeason(1), null));
        Assert.Null(r.Service.ArrivedItem(r.Member, Firefly.WithSeason(1), null, r.HdCopy));
    }

    [Fact]
    public async Task TheSeasonStatisticsOfACardNeverAddUpPastTheAiredEpisodes()
    {
        using var r = new Rig(Layout.SeparateLibraries, Has.Hd, movie: false);
        r.View.EpisodesBySeries[r.HdCopy].Clear();
        r.Sonarr.Series[0]["seasons"] = new JsonArray(new JsonObject
        {
            ["seasonNumber"] = 1, ["monitored"] = true,
            ["statistics"] = new JsonObject { ["episodeCount"] = 1, ["episodeFileCount"] = 1, ["totalEpisodeCount"] = 2 },
        });
        r.Sonarr.Queue.Add(FakeArr.SonarrQueueRow(102, "future-ep", 1, 2, "Firefly", 78874));
        var page = M.SeasonPage(r, r.HdCopy);
        await r.Service.ForBatchAsync(r.Member, new[] { page }, Array.Empty<TitleKey>(), default);
        await Task.Delay(30);
        var card = Assert.Single(M.Items(await r.Service.ForBatchAsync(r.Member, new[] { page }, Array.Empty<TitleKey>(), default)));
        var summary = card.GetProperty("summary");
        int Of(string key) => summary.TryGetProperty(key, out var n) ? n.GetInt32() : 0;
        Assert.True(Of("ready") + Of("downloading") + Of("almostReady") + Of("missing") <= Of("aired"), summary.ToString());
    }

    // ------------------------------------------------------------------ ED-R19-7 / -8: a held alert re-validates each announced episode

    [Fact]
    public async Task AHeldAlertForACombinedFileAnnouncesOnlyTheEpisodesTheItemStillCovers()
    {
        var key = Severance;
        using var r = await N.Started(r => r.Request(30, 95396, r.Emma, type: "tv", tvdb: 371980, seasons: new[] { 2 }));
        r.Phones(r.Emma);
        QuietAllDay(r);
        var copy = Guid.NewGuid();
        r.View.AddCopy(key, new JfCopy { ItemId = copy, Path = "/media/tv/Severance" });
        var file = r.View.AddEpisodeFile(copy, key, 2, 1, 1920, 1080, r.Arr.Now.UtcDateTime, episodeEnd: 2);
        await Arrivals(r, key.ToString());
        var notice = Assert.Single(r.Inbox(r.Emma));
        Assert.Equal("2", JsonSerializer.Deserialize<Dictionary<string, string>>(notice.Payload)!["count"]);
        Assert.Empty(r.Pushes);
        // A corrected scan: the same path and item cover only E1 now (it still plays).
        var item = r.View.Items[file].Ref;
        r.View.Items.Remove(file);
        r.View.AddItem(new JfItemRef { ItemId = file, Kind = "episode", Key = key.WithEpisode(2, 1), SeriesId = copy, Season = 2, Episode = 1, Path = item.Path, DateCreated = item.DateCreated });
        r.View.EpisodesBySeries[copy].Clear();
        r.View.AddEpisode(copy, new JfEpisode { ItemId = file, Season = 2, Episode = 1, DateCreated = item.DateCreated });
        r.View.Rev++;
        Assert.False(r.Status.Editions.Available(r.Emma, key.WithEpisode(2, 2), Edition.Any));
        await QuietEnds(r);
        var push = Assert.Single(r.Pushes);
        var title = (string?)push.Body["title"] ?? string.Empty;
        Assert.DoesNotContain("2 new episodes", title);
    }

    [Fact]
    public async Task AHeldAlertIsNotSentForAnEpisodeItsItemNoLongerIs()
    {
        using var rig = await N.Started(r => SeriesRequest(r, fourK: true));
        rig.Phones(rig.Emma);
        QuietAllDay(rig);
        var copy = SeriesCopy(rig, "/media/tv/Severance", "Shows");
        var item = rig.View.AddEpisodeFile(copy, Severance, 2, 1, 3840, 2160, rig.Arr.Now.UtcDateTime);
        await Arrivals(rig, Severance.ToString());
        Assert.Single(rig.Inbox(rig.Emma));
        Assert.Empty(rig.Pushes);
        // The same file is S2E2 now (a rescan renumbered it): S2E1 is no longer there.
        rig.View.EpisodesBySeries[copy].Clear();
        rig.View.AddEpisode(copy, new JfEpisode { ItemId = item, Season = 2, Episode = 2 });
        rig.View.AddItem(new JfItemRef { ItemId = item, Kind = "episode", Key = Severance.WithEpisode(2, 2), SeriesId = copy, Season = 2, Episode = 2 });
        rig.View.Rev++;
        Assert.False(rig.Status.Editions.Available(rig.Emma, Severance.WithEpisode(2, 1), Edition.FourK));
        await QuietEnds(rig);
        Assert.Empty(rig.Pushes);
    }

    [Theory]
    [InlineData(false)] // nothing of Season 2 plays for her: not sent
    [InlineData(true)]  // control: Season 2 plays: sent
    public async Task AnOlderHeldAlertWithoutItsEpisodeItemsIsCheckedByItsScope(bool plays)
    {
        using var r = await N.Started();
        r.Phones(r.Emma);
        var copy = Guid.NewGuid();
        r.View.AddCopy(Severance, new JfCopy { ItemId = copy });
        if (plays) r.View.AddEpisodeFile(copy, Severance, 2, 1, 1920, 1080, r.Arr.Now.UtcDateTime);
        Assert.Equal(plays, r.Status.Editions.Scope(r.Emma, Severance.WithSeason(2), Edition.Any).Count > 0);
        var id = r.NotifyStore.Add(r.Emma.UserId, "older-held-" + plays, NotifyKind.Episodes, Severance.ToString(), copy.ToString("N"),
            new Dictionary<string, string> { ["title"] = "Severance", ["mode"] = "single", ["count"] = "1", ["seasons"] = "2", ["season"] = "2", ["episode"] = "1" },
            new[] { (NotifyChannel.Ntfy, r.Arr.Now) }, r.Arr.Now);
        Assert.NotNull(id);
        await r.Dispatcher.RunOnceAsync(default);
        Assert.Equal(plays ? 1 : 0, r.Pushes.Count);
    }

    // ------------------------------------------------------------------ ED-R19-9: an edition that became available on an existing path is an arrival

    [Fact]
    public async Task AnOldEpisodeUpgradedToFourKInPlaceIsOneFourKArrival()
    {
        using var rig = await N.Started(r => SeriesRequest(r, fourK: true));
        var copy = SeriesCopy(rig, "/media/tv/Severance", "Shows");
        var episode = rig.View.AddEpisodeFile(copy, Severance, 2, 1, 1920, 1080, rig.Arr.Now.UtcDateTime.AddDays(-30));
        await Arrivals(rig, Severance.ToString());
        Assert.Empty(rig.Inbox(rig.Emma));
        // The same path's file is replaced by a 2160p one (Jellyfin keeps the item and its date).
        rig.View.SourcesByItem[episode].Clear();
        rig.View.AddSource(episode, 3840, 2160, created: rig.Arr.Now.UtcDateTime.AddDays(-30));
        rig.View.Rev++;
        Assert.True(rig.Status.Editions.Available(rig.Emma, Severance.WithEpisode(2, 1), Edition.FourK));
        await Arrivals(rig, Severance.ToString());
        await Arrivals(rig, Severance.ToString());
        var told = Assert.Single(rig.Inbox(rig.Emma));
        Assert.Equal("4k", JsonSerializer.Deserialize<Dictionary<string, string>>(told.Payload)!["variant"]);
    }

    [Fact]
    public async Task AnOldEpisodeThatOnlyBecameVisibleIsNoArrival()
    {
        using var rig = await N.Started(r => SeriesRequest(r, fourK: true));
        await Arrivals(rig, Severance.ToString());
        // Access to an old 4K copy is granted: nothing arrived, so nothing is announced (unchanged rule).
        var copy = SeriesCopy(rig, "/media/tv4k/Severance", "Shows 4K");
        rig.View.AddEpisodeFile(copy, Severance, 2, 1, 3840, 2160, rig.Arr.Now.UtcDateTime.AddDays(-30));
        rig.View.Rev++;
        await Arrivals(rig, Severance.ToString());
        Assert.Empty(rig.Inbox(rig.Emma));
    }

    [Fact]
    public async Task AnOldMovieUpgradedToFourKInPlaceIsAFourKArrival()
    {
        using var rig = await N.Started(r => r.Request(41, 693134, r.Emma, is4k: true));
        var item = Guid.NewGuid();
        rig.View.AddCopy(TitleKey.Parse(Dune)!, new JfCopy { ItemId = item, Path = "/media/movies/Dune Part Two/Dune.mkv", LibraryName = "Movies", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        rig.View.AddSource(item, 1920, 1080, "/media/movies/Dune Part Two/Dune.mkv", rig.Arr.Now.UtcDateTime.AddDays(-30));
        rig.View.Rev++;
        await rig.Step(Dune);
        Assert.DoesNotContain(rig.Inbox(rig.Emma), n => n.Kind == "ready");
        rig.View.SourcesByItem[item].Clear();
        rig.View.AddSource(item, 3840, 2160, "/media/movies/Dune Part Two/Dune.mkv", rig.Arr.Now.UtcDateTime.AddDays(-30));
        rig.View.Rev++;
        rig.Arr.Now = rig.Arr.Now.AddMinutes(5);
        await rig.Step(Dune);
        await rig.Step(Dune);
        var told = Assert.Single(rig.Inbox(rig.Emma), n => n.Kind == "ready");
        Assert.Equal("4k", JsonSerializer.Deserialize<Dictionary<string, string>>(told.Payload)!["variant"]);
    }

    // ------------------------------------------------------------------ the enumerating scan: arr availability signals

    /// <summary>
    /// The arr's own availability signals (a file the arr holds: <c>hasFile</c>, its episode file counts) may be read only
    /// where they are inputs to ownership, progress or an administrator's arr facts, never as "the viewer has it". A new
    /// reader anywhere else fails this until it is classified here (with its reason) or goes through the predicate.
    /// Seerr's availability (its media status) on Seerr-backed surfaces is excluded by D80 (Seerr mode keeps Seerr's own
    /// availability) and listed in the round's path table.
    /// </summary>
    private static readonly (string Pattern, string[] Allowed)[] ArrSignals =
    {
        (@"\.HasFile\b|\bHasFile\s*=|EpisodeFileCount\b", new[]
        {
            "Services/Arr/ArrStateLoaders.cs",            // the wire mapping (Radarr/Sonarr JSON → snapshot)
            "Services/Arr/ArrStateModels.cs",             // snapshot equality
            "Services/Arr/Live/ArrChangeDetector.cs",     // what changed in an arr (feed bump), never availability
            "Services/Arr/ArrLegacyViews.cs:MovieMatch",  // the arr links route: the arr's own facts, labelled as the arr's
            "Services/Arr/ArrLegacyViews.cs:SeriesMatch", // the same for Sonarr
            "Services/Arr/ArrLegacyViews.cs:CalendarItems", // the arr's fact, a tie-break input; the route answers the predicate's
            "Services/Arr/CalendarDedup.cs",              // which instance's event wins (ownership), before the predicate decides
            "Services/Acquire/StatusComposer.cs",         // progress (almost ready, library pending) and an administrator's arr line
            "Services/Acquire/ArrManageService.cs",       // the Manage drawer: the arr's facts for an administrator
            "Services/Acquire/ArrAdminHubService.cs",     // the admin hub's upcoming list: the arr's facts for an administrator
            "Services/Acquire/ArrStatusService.cs:SearchableInstance", // family Search: an arr copy WITHOUT a file may be searched (progress input)
            "Services/Acquire/Requests/RequestPolicy.cs", // disk planning: the median size of the arr's files
            "Services/Acquire/Requests/RequestPlaces.cs", // where the arr keeps a title (a folder), not availability
            "Services/Acquire/JellyfinBridge.cs",         // path doctor: arr titles with files that Jellyfin lacks (a diagnostic)
            "Controllers/JellyfinEnhancedController.cs:FetchShokoCalendar", // Shoko's own fact, replaced by the predicate's before the route answers
            "Services/Acquire/Requests/FutureSeasonCharges.cs", // which seasons Sonarr has started (a quota charge), not availability
        }),
    };

    [Fact]
    public void EveryArrAvailabilitySignalIsReadOnlyForOwnershipOrProgress()
    {
        var root = SourceRoot();
        var found = new List<string>();
        foreach (var file in Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(root, file).Replace('\\', '/');
            if (relative.StartsWith("obj/", StringComparison.Ordinal) || relative.StartsWith("bin/", StringComparison.Ordinal)) continue;
            string? method = null;
            foreach (var raw in File.ReadLines(file))
            {
                var line = raw.Trim();
                if (line.StartsWith("//", StringComparison.Ordinal) || line.StartsWith("///", StringComparison.Ordinal)) continue;
                var declared = Regex.Match(line, @"^(?:(?:public|private|internal|protected|static|async|override|sealed)\s+)+[\w<>\[\],.?() ]+?\s(\w+)\s*[(<]");
                if (declared.Success) method = declared.Groups[1].Value;
                foreach (var (pattern, allowed) in ArrSignals)
                {
                    if (!Regex.IsMatch(line, pattern)) continue;
                    if (allowed.Contains(relative) || (method != null && allowed.Contains(relative + ":" + method))) continue;
                    // The calendar's answer: the predicate's, after the arr's fact (asserted below).
                    if (relative == "Controllers/JellyfinEnhancedController.cs" && Regex.IsMatch(line, @"\bHasFile\s*=\s*CalendarPlays\(")) continue;
                    found.Add($"{relative}:{method}: {line}");
                }
            }
        }
        Assert.True(found.Count == 0, "arr availability signal read outside ownership/progress:\n" + string.Join("\n", found));
        // The calendar's answer is the predicate's: the route sets each event's hasFile from Jellyfin, after the arr's fact.
        var calendar = File.ReadAllText(Path.Combine(root, "Controllers/JellyfinEnhancedController.cs"));
        Assert.Matches(@"HasFile\s*=\s*CalendarPlays\(", calendar);
    }

    private static string SourceRoot([System.Runtime.CompilerServices.CallerFilePath] string file = "")
    {
        var root = new DirectoryInfo(Path.GetDirectoryName(file)!);
        while (root != null && !Directory.Exists(Path.Combine(root.FullName, "Jellyfin.Plugin.JellyfinEnhanced", "Services"))) root = root.Parent;
        Assert.NotNull(root);
        return Path.Combine(root!.FullName, "Jellyfin.Plugin.JellyfinEnhanced");
    }
}
