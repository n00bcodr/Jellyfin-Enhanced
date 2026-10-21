using System.Security.Claims;
using System.Text.Json;
using System.Text.RegularExpressions;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using MediaBrowser.Controller.Entities;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;
using N = JE.Tests.IntegrationNotificationsTests;

namespace JE.Tests;

/// <summary>
/// Edition round 21 (D53): one availability rule everywhere, and arrivals are changes of what backs an item. The calendar's
/// Available, Play and time come from the shared viewer-aware availability boundary across every copy the caller may open
/// (current library membership included), and Play opens the qualifying movie or episode item. An upgrade in place is a
/// change of an item's backing source (its version, path or quality); a version that only became visible is no arrival. A
/// held alert is checked and linked as a whole against the target it was rebuilt for, and every episode count goes through
/// the one interval-coverage helper (a combined E1–E2 file is two episodes).
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEditionSourceTests
{
    private static readonly TitleKey Severance = TitleKey.Parse("tv:tvdb:371980")!;

    private static StatusViewer ViewerOf(FakeJellyfinView view, User user, bool admin)
    {
        var viewer = new StatusViewer { UserId = user.Id, IsAdmin = admin, PolicyRevision = "p" + (admin ? "A" : "U"), Handle = user };
        view.Users[user.Id] = viewer;
        return viewer;
    }

    private static async Task Arrivals(N.Rig rig, string key)
    {
        await rig.Step(key);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step();
    }

    // ------------------------------------------------------------------ the calendar on the one availability rule

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ACalendarMovieIsAvailableOnlyWhileItsLibraryIsCurrent(bool removed)
    {
        using var native = new IntegrationEditionOrphanTests.Library();
        using var rig = new IntegrationCalendarAccessTests.CalendarRig();
        var admin = rig.Callers.Register(Guid.NewGuid(), admin: true, "admin");
        native.Person(new StatusViewer { UserId = admin.Id, IsAdmin = true, Handle = admin });
        rig.Radarr.Calendar[0]["tmdbId"] = 603;
        rig.Radarr.Calendar[0]["title"] = "The Matrix";
        using (var db = rig.Database.CreateDbContext())
        {
            db.BaseItemProviders.Add(new BaseItemProvider { Item = null!, ItemId = native.Uhd.Id, ProviderId = "Tmdb", ProviderValue = "603" });
            db.SaveChanges();
        }
        var controller = ApiAssetTests.Controller(rig.R.Arr.Plugin.Core, rig.R.Arr.Transport, rig.R.Store, rig.R.Arr.Factory,
            rig.Database, rig.Callers.Users.Object, native.Manager.Object, rig.UserData.Object, rig.R.Resolver, native.View);
        controller.HttpContext.User = TestCallers.Principal(admin.Id, admin: true);
        controller.Request.QueryString = new QueryString("?start=2026-10-12&end=2026-10-31");
        // The 4K library is removed from Jellyfin while its item still answers a lookup by id (the host keeps orphans).
        if (removed) native.Change("removed");
        var result = JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(await controller.GetCalendarEvents()).Value);
        var row = Assert.Single(result.GetProperty("events").EnumerateArray(), e => e.GetProperty("title").GetString() == "The Matrix");
        Assert.True(row.GetProperty("hasFile").GetBoolean() == !removed, row.ToString());
        if (!removed) Assert.Equal(native.Uhd.Id, row.GetProperty("itemId").GetGuid());
    }

    [Fact]
    public async Task ACalendarMovieIsAvailableWhenAnyCopyPlaysAndPlayOpensThatCopy()
    {
        using var r = new IntegrationCalendarAccessTests.CalendarRig();
        var view = new FakeJellyfinView();
        r.View = view;
        r.Radarr.Calendar[0]["hasFile"] = true;
        // Jellyfin lists a ".disc" stub copy first and a playable 4K copy second.
        var stub = new MediaBrowser.Controller.Entities.Movies.Movie { Id = Guid.Parse("00000000-0000-0000-0000-000000000001"), Name = "Dune", Path = "/media/movies/Dune/Dune.disc", IsPlaceHolder = true };
        var movie = new MediaBrowser.Controller.Entities.Movies.Movie { Id = Guid.Parse("00000000-0000-0000-0000-000000000002"), Name = "Dune", Path = "/media/movies4k/Dune/Dune.mkv" };
        using (var db = r.Database.CreateDbContext())
        {
            foreach (var item in new BaseItem[] { stub, movie })
                db.BaseItemProviders.Add(new BaseItemProvider { Item = null!, ItemId = item.Id, ProviderId = "Tmdb", ProviderValue = "438631" });
            db.SaveChanges();
        }
        foreach (var item in new BaseItem[] { stub, movie })
        {
            r.Library.Setup(l => l.GetItemById<BaseItem>(item.Id)).Returns(item);
            r.Library.Setup(l => l.GetItemById<BaseItem>(item.Id, It.IsAny<User>())).Returns(item);
        }
        var dune = TitleKey.Parse("movie:tmdb:438631")!;
        view.AddCopy(dune, new JfCopy { ItemId = stub.Id, Path = stub.Path });
        view.Placeholders.Add(stub.Id);
        view.AddCopy(dune, new JfCopy { ItemId = movie.Id, Path = movie.Path });
        view.AddSource(movie.Id, 3840, 2160, movie.Path);
        var admin = r.Callers.Register(Guid.NewGuid(), admin: true, "admin");
        ViewerOf(view, admin, admin: true);
        var row = Assert.Single(await r.Events(TestCallers.Principal(admin.Id, true)), e => e.Title == "Dune");
        Assert.True(row.HasFile && row.ItemId == movie.Id, $"the playable copy {movie.Id}; the calendar said {row.ItemId}, hasFile={row.HasFile}");
    }

    [Fact]
    public async Task ACalendarEpisodeFoundByItsNumberPlaysThatEpisode()
    {
        using var r = new IntegrationCalendarAccessTests.CalendarRig();
        var view = new FakeJellyfinView();
        r.View = view;
        r.R.Arr.Plugin.Plugin.Configuration.CalendarFilterByLibraryAccess = false;
        var series = new MediaBrowser.Controller.Entities.TV.Series { Id = Guid.NewGuid() };
        var episode = new MediaBrowser.Controller.Entities.TV.Episode { Id = Guid.NewGuid(), SeriesId = series.Id, ParentIndexNumber = 1, IndexNumber = 1, Path = "/media/tv/Show A/S01E01.mkv" };
        using (var db = r.Database.CreateDbContext())
        {
            db.BaseItemProviders.Add(new BaseItemProvider { Item = null!, ItemId = series.Id, ProviderId = "Tvdb", ProviderValue = "501" });
            db.SaveChanges();
        }
        foreach (var item in new BaseItem[] { series, episode })
        {
            r.Library.Setup(l => l.GetItemById<BaseItem>(item.Id)).Returns(item);
            r.Library.Setup(l => l.GetItemById<BaseItem>(item.Id, It.IsAny<User>())).Returns(item);
        }
        r.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new List<BaseItem> { episode });
        var show = TitleKey.Parse("tv:tvdb:501")!;
        view.AddCopy(show, new JfCopy { ItemId = series.Id, Path = "/media/tv/Show A" });
        view.AddItem(new JfItemRef { ItemId = episode.Id, Kind = "episode", Key = show.WithEpisode(1, 1), SeriesId = series.Id, Season = 1, Episode = 1, Path = episode.Path });
        view.AddEpisode(series.Id, new JfEpisode { ItemId = episode.Id, Season = 1, Episode = 1 });
        view.AddSource(episode.Id, 1920, 1080, episode.Path);
        var admin = r.Callers.Register(Guid.NewGuid(), admin: true, "admin");
        ViewerOf(view, admin, admin: true);
        var row = Assert.Single(await r.Events(TestCallers.Principal(admin.Id, true)), e => e.Title == "Show A");
        Assert.True(row.HasFile, "the episode plays");
        Assert.Equal(episode.Id, row.ItemEpisodeId);
    }

    // ------------------------------------------------------------------ arrivals are changes of the backing source

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AccessToAnOldVersionOfAnItemIsNoArrival(bool movie)
    {
        using var r = await N.Started(x =>
        {
            if (movie) x.Request(41, 693134, x.Emma, is4k: true);
            else
            {
                N.FourKSonarr(x);
                x.Request(30, 95396, x.Emma, type: "tv", tvdb: 371980, seasons: new[] { 2 }, is4k: true);
            }
        });
        var title = movie ? TitleKey.Parse("movie:tmdb:693134")! : Severance;
        // Like Jellyfin: each version of an episode is opened only where its own item may be opened.
        r.View.EpisodeVersionsFollowAccess = true;
        var copy = Guid.NewGuid();
        var old = r.Arr.Now.UtcDateTime.AddDays(-30);
        r.View.AddCopy(title, new JfCopy { ItemId = copy, Path = movie ? "/media/movies/Dune/Dune.mkv" : "/media/tv/Severance", DateCreated = old });
        Guid item;
        if (movie)
        {
            item = copy;
            r.View.AddSource(item, 1920, 1080, created: old);
        }
        else item = r.View.AddEpisodeFile(copy, title, 2, 1, 1920, 1080, old);
        var hidden = r.View.AddSource(item, 3840, 2160, created: old);
        var restricted = r.View.Revoke(r.Emma, hide: hidden.BackingItemId);
        Assert.Empty(r.Status.Editions.Item(restricted, item, Edition.FourK));
        await Arrivals(r, title.ToString());
        Assert.Empty(r.Inbox(r.Emma));
        // Only access to the existing old 4K version is granted: no file, path or quality changed.
        r.View.HiddenForPolicy[restricted.PolicyRevision].Remove(hidden.BackingItemId);
        r.View.Rev++;
        Assert.NotEmpty(r.Status.Editions.Item(restricted, item, Edition.FourK));
        await Arrivals(r, title.ToString());
        await Arrivals(r, title.ToString());
        Assert.Empty(r.Inbox(r.Emma));
    }

    // ------------------------------------------------------------------ held alerts: rebuilt and linked as a whole, counted by coverage

    [Fact]
    public async Task AHeldAlertRebuiltForItsSurvivorIsSentAfterItsSeasonItemWasDeleted()
    {
        using var r = await N.Started(x => x.Request(30, 95396, x.Emma, type: "tv", tvdb: 371980, seasons: new[] { 2 }));
        r.Phones(r.Emma);
        r.Prefs(r.Emma, p => { p.QuietHours = true; p.QuietFrom = "00:00"; p.QuietTo = "23:59"; p.UtcOffsetMinutes = 0; });
        var copy = Guid.NewGuid();
        r.View.AddCopy(Severance, new JfCopy { ItemId = copy, Path = "/media/tv/Severance" });
        var season = Guid.NewGuid();
        r.View.AddSeason(copy, new JfSeason { ItemId = season, Season = 2 });
        r.Sonarr.Series[0]["seasons"] = new System.Text.Json.Nodes.JsonArray(new System.Text.Json.Nodes.JsonObject
        {
            ["seasonNumber"] = 2, ["monitored"] = true,
            ["statistics"] = new System.Text.Json.Nodes.JsonObject { ["episodeCount"] = 2, ["totalEpisodeCount"] = 2, ["episodeFileCount"] = 0 },
        });
        await r.Store.RefreshLibraryNowAsync(r.Arr.Instance("SonarrZ"), default);
        var first = r.View.AddEpisodeFile(copy, Severance, 2, 1, 1920, 1080, r.Arr.Now.UtcDateTime);
        var survivor = r.View.AddEpisodeFile(copy, Severance, 2, 2, 1920, 1080, r.Arr.Now.UtcDateTime);
        await r.Step(Severance.ToString());
        r.Arr.Now = r.Arr.Now.AddMinutes(11);
        await r.Step();
        var notice = Assert.Single(r.Inbox(r.Emma));
        Assert.Equal(season.ToString("N"), notice.ItemId);
        Assert.Empty(r.Pushes);
        // A rescan removes the season item and E1; E2 still plays.
        r.View.SeasonsBySeries[copy].Clear();
        r.View.Items.Remove(first);
        r.View.EpisodesBySeries[copy].RemoveAll(e => e.Episode.ItemId == first);
        r.View.SourcesByItem.Remove(first);
        r.View.Rev++;
        r.Prefs(r.Emma, p => p.QuietHours = false);
        r.Arr.Now = r.Arr.Now.AddDays(1);
        await r.Dispatcher.RunOnceAsync(default);
        var push = Assert.Single(r.Pushes);
        Assert.Equal("https://jf.example/web/#/details?id=" + survivor.ToString("N"), (string)push.Body["click"]!);
    }

    [Fact]
    public async Task AnOlderHeldAlertCountsTheEpisodesACombinedFileCovers()
    {
        using var r = await N.Started();
        r.Phones(r.Emma);
        var copy = Guid.NewGuid();
        r.View.AddCopy(Severance, new JfCopy { ItemId = copy });
        // One E1–E2 file: two episodes.
        r.View.AddEpisodeFile(copy, Severance, 2, 1, 1920, 1080, r.Arr.Now.UtcDateTime, episodeEnd: 2);
        Assert.True(r.Status.Editions.Available(r.Emma, Severance.WithEpisode(2, 1), Edition.Any));
        Assert.True(r.Status.Editions.Available(r.Emma, Severance.WithEpisode(2, 2), Edition.Any));
        r.NotifyStore.Add(r.Emma.UserId, "older-combined", NotifyKind.Episodes, Severance.ToString(), copy.ToString("N"),
            new Dictionary<string, string> { ["title"] = "Severance", ["mode"] = "many", ["count"] = "2", ["seasons"] = "2" },
            new[] { (NotifyChannel.Ntfy, r.Arr.Now) }, r.Arr.Now);
        await r.Dispatcher.RunOnceAsync(default);
        Assert.Single(r.Pushes);
    }

    // ------------------------------------------------------------------ enumerating scans

    /// <summary>
    /// Direct playability shortcuts on Jellyfin items (a placeholder or virtual flag, the view's "plays a file" rule, a
    /// resolved item judged "plays" by itself) belong to the availability owner: the view that reads them and the edition
    /// predicate. Anything else either goes through that predicate or is listed here with why it isn't availability.
    /// The arr's own file signals keep their scan (<see cref="IntegrationEditionTransitionTests"/>).
    /// </summary>
    private static readonly (string Pattern, string[] Allowed)[] PlayabilityShortcuts =
    {
        (@"\bPlaysItem\s*\(|\.IsPlaceHolder\b|\.IsVirtualItem\b|\bIsMissingEpisode\b|ArrJellyfinView\.Playable\s*\(|\.Playable\b", new[]
        {
            "Services/Acquire/ArrJellyfinView.cs",            // the owner: reads Jellyfin's items into the view's facts
            "Services/Acquire/EditionAvailability.cs",        // the owner: the one availability predicate over the view
            "Services/Acquire/JellyfinLibraryAccess.cs:IsMissingTwin",       // Jellyfin's own housekeeping rule (missing twins a file fills), not availability
            "Services/Acquire/JellyfinLibraryAccess.cs:RemoveMissingTwins",  // the same housekeeping: the file's own episode item
            "Services/NativeDetails/NativeDetailsLibrary.cs", // which existing Jellyfin item a native page's row links to, not "you have it"
            "Services/NativeDetails/NativeDetailsDtos.cs",    // a synthetic page's own virtual marker (written, not read)
            "Services/Acquire/Stamps/AcquisitionStampSources.cs:From", // a badge's own source identity (which item a stamp is about), not "you have it"
            "Services/Acquire/Lists/ListEditionAvailability.cs:AddSources", // lists' own source adapter (4c), until it is replaced by EditionAvailability
            "Services/Acquire/Lists/ListHost.cs",             // lists' Jellyfin host (4c): reads Jellyfin's items into list facts, like the view
            "Services/Acquire/Home/HomeArrivals.cs:ContentOf", // which content an item carries for its arrival history (identity, not "you have it")
            "Services/Acquire/Ready/ReadyJellyfin.cs:Check",   // Ready's physical-version check of one item (4f), not availability
            "Services/Arr/Live/ArrChangeTracker.cs:OnItemRemoved", // the change feed's key for a removed item (which title to look at again)
        }),
    };

    [Fact]
    public void EveryDirectPlayabilityShortcutIsTheAvailabilityOwnersOrNotAvailability()
    {
        var found = Scan(PlayabilityShortcuts);
        Assert.True(found.Count == 0, "a playability shortcut outside the availability owner:\n" + string.Join("\n", found));
    }

    /// <summary>
    /// Episodes Jellyfin plays are counted by the episodes their files cover (a combined E1–E2 file is two; overlaps once),
    /// through the one interval-coverage helper; counting distinct starting numbers anywhere else fails this.
    /// </summary>
    private static readonly (string Pattern, string[] Allowed)[] StartingNumberCounts =
    {
        (@"\(\s*\w+\.Season\s*,\s*\w+\.Episode\s*\)\s*\)\s*\.Distinct\(\)\s*\.Count\(|\.Select\(\s*\w+\s*=>\s*\w+\.Episode\s*\)\s*\.Distinct\(\)\s*\.Count\(|DistinctBy\([^)]*\.Episode\)?\)\s*\.Count\(", new[]
        {
            "Services/Acquire/EpisodeRange.cs",               // the owner: interval coverage
        }),
    };

    [Fact]
    public void NoEpisodeCountIsTakenFromStartingNumbers()
    {
        var found = Scan(StartingNumberCounts);
        Assert.True(found.Count == 0, "an episode count by starting number outside the coverage helper:\n" + string.Join("\n", found));
    }

    private static List<string> Scan((string Pattern, string[] Allowed)[] rules)
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
                if (line.StartsWith("//", StringComparison.Ordinal)) continue;
                var declared = Regex.Match(line, @"^(?:(?:public|private|internal|protected|static|async|override|sealed)\s+)+[\w<>\[\],.?() ]+?\s(\w+)\s*[(<]");
                if (declared.Success) method = declared.Groups[1].Value;
                foreach (var (pattern, allowed) in rules)
                {
                    if (!Regex.IsMatch(line, pattern)) continue;
                    if (allowed.Contains(relative) || (method != null && allowed.Contains(relative + ":" + method))) continue;
                    found.Add($"{relative}:{method}: {line}");
                }
            }
        }
        return found;
    }

    private static string SourceRoot([System.Runtime.CompilerServices.CallerFilePath] string file = "")
    {
        var root = new DirectoryInfo(Path.GetDirectoryName(file)!);
        while (root != null && !Directory.Exists(Path.Combine(root.FullName, "Jellyfin.Plugin.JellyfinEnhanced", "Services"))) root = root.Parent;
        Assert.NotNull(root);
        return Path.Combine(root!.FullName, "Jellyfin.Plugin.JellyfinEnhanced");
    }
}
