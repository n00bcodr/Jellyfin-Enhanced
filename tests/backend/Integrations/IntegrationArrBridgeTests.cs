using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.Tasks;
using Moq;

namespace JE.Tests;

/// <summary>
/// The Jellyfin bridge (Requests &amp; downloads, phase 2): path mapping, the targeted-refresh path
/// selection (the nearest folder Jellyfin has, non-recursive, only the new paths; never a TV
/// library's root), refreshes after an arr import (debounced, serialised, waiting for Jellyfin's
/// own scan, off with its switch), "in Sonarr/Radarr, not in Jellyfin" with why, Scan now, and the
/// path doctor (root folders, compared titles, a learned mapping).
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationArrBridgeTests
{
    private static readonly IReadOnlyList<ArrPathMapping> Maps = new[]
    {
        new ArrPathMapping { ArrPath = "/data/media", JellyfinPath = "/media" },
        new ArrPathMapping { ArrPath = "/data/media/movies4k", JellyfinPath = "/uhd" },
    };

    // ------------------------------------------------------------------ pure path rules

    [Theory]
    [InlineData("/data/media/movies/Dune (2021)/Dune.mkv", "/media/movies/Dune (2021)/Dune.mkv", "/data/media")]
    [InlineData("/data/media/movies4k/Dune (2021)/Dune.mkv", "/uhd/Dune (2021)/Dune.mkv", "/data/media/movies4k")]
    [InlineData("/data/media/movies4kx/Dune.mkv", "/media/movies4kx/Dune.mkv", "/data/media")]
    [InlineData("/elsewhere/Dune.mkv", "/elsewhere/Dune.mkv", null)]
    [InlineData("C:\\data\\media\\x.mkv", "C:/data/media/x.mkv", null)]
    public void ArrPathsMapThroughTheLongestMatchingMappingOrStayTheSame(string arr, string expected, string? mapping)
    {
        var (path, used) = BridgePaths.Map(arr, Maps);
        Assert.Equal(expected, path);
        Assert.Equal(mapping, used?.ArrPath);
    }

    [Fact]
    public void FolderTestsDoNotConfuseSiblingPrefixes()
    {
        Assert.True(BridgePaths.IsUnder("/movies/a.mkv", "/movies"));
        Assert.True(BridgePaths.IsUnder("/movies", "/movies/"));
        Assert.False(BridgePaths.IsUnder("/movies4k/a.mkv", "/movies"));
        var libs = new[] { new JfLibraryRoot { Name = "Movies", Locations = new[] { "/movies" } }, new JfLibraryRoot { Name = "4K", Locations = new[] { "/movies4k" } } };
        Assert.Equal("4K", BridgePaths.LibraryOf("/movies4k/x/y.mkv", libs).Library?.Name);
        Assert.Null(BridgePaths.LibraryOf("/tv/x.mkv", libs).Library);
    }

    private static FakeLibraryAccess Library()
    {
        var lib = new FakeLibraryAccess();
        lib.AddLibrary("Movies", "movies", "/media/movies");
        lib.AddLibrary("Shows", "tvshows", "/media/tv");
        lib.AddLibrary("Home", "mixed", "/media/home");
        lib.AddFolder("/media/tv/Firefly (2002)", "series");
        lib.AddFolder("/media/tv/Firefly (2002)/Season 01", "season");
        return lib;
    }

    public static TheoryData<string, string, string?, string[]> PlanRows() => new()
    {
        // An episode into a season Jellyfin has: that season, only the new file.
        { "/media/tv/Firefly (2002)/Season 01/Firefly - S01E04.mkv", RefreshOutcome.Refresh, "/media/tv/Firefly (2002)/Season 01", new[] { "/media/tv/Firefly (2002)/Season 01/Firefly - S01E04.mkv" } },
        // A new season folder: the series, the file and the new folder.
        { "/media/tv/Firefly (2002)/Season 02/Firefly - S02E01.mkv", RefreshOutcome.Refresh, "/media/tv/Firefly (2002)", new[] { "/media/tv/Firefly (2002)/Season 02/Firefly - S02E01.mkv", "/media/tv/Firefly (2002)/Season 02" } },
        // A new movie folder: the movie library's own folder (non-recursive with only the new paths).
        { "/media/movies/Dune (2021)/Dune (2021).mkv", RefreshOutcome.Refresh, "/media/movies", new[] { "/media/movies/Dune (2021)/Dune (2021).mkv", "/media/movies/Dune (2021)" } },
        // A new series folder: its nearest existing folder is the TV root, which is never refreshed.
        { "/media/tv/Spaced (1999)/Season 01/Spaced - S01E01.mkv", RefreshOutcome.LibraryRoot, "/media/tv", new[] { "/media/tv/Spaced (1999)/Season 01/Spaced - S01E01.mkv", "/media/tv/Spaced (1999)/Season 01", "/media/tv/Spaced (1999)" } },
        // Nor the root of a mixed library.
        { "/media/home/Clip/clip.mkv", RefreshOutcome.LibraryRoot, "/media/home", new[] { "/media/home/Clip/clip.mkv", "/media/home/Clip" } },
        // Outside every library.
        { "/srv/other/x.mkv", RefreshOutcome.OutsideLibrary, null, Array.Empty<string>() },
    };

    [Theory]
    [MemberData(nameof(PlanRows))]
    public void TheTargetedRefreshPicksTheNearestFolderAndNeverATvRoot(string file, string outcome, string? folder, string[] paths)
    {
        var lib = Library();
        var plan = BridgePaths.Plan(file, lib.Libraries(), lib.FindByPath);
        Assert.Equal(outcome, plan.Outcome);
        Assert.Equal(folder, plan.Ancestor);
        Assert.Equal(paths, plan.RefreshPaths);
        if (outcome == RefreshOutcome.Refresh) Assert.NotEqual("/media/tv", plan.Ancestor);
    }

    [Fact]
    public void OnAWindowsServerBridgePathsReachJellyfinInItsOwnFormWithBackslashes()
    {
        // Jellyfin stores "D:\TV\…" and matches item paths exactly; the bridge works with '/'.
        var library = new Mock<ILibraryManager>();
        var season = new Season { Id = Guid.NewGuid() };
        var episode = new Episode { Id = Guid.NewGuid() };
        library.Setup(m => m.FindByPath(@"D:\TV\Firefly (2002)\Season 01", It.IsAny<bool?>())).Returns(season);
        library.Setup(m => m.FindByPath(@"D:\TV\Firefly (2002)\Season 01\E03.mkv", It.IsAny<bool?>())).Returns(episode);
        var monitor = new Mock<ILibraryMonitor>();
        var access = new JellyfinLibraryAccess(library.Object, Mock.Of<IProviderManager>(), Mock.Of<IFileSystem>(), Mock.Of<ITaskManager>(), monitor.Object, '\\');
        var libs = new[] { new JfLibraryRoot { Id = "tv", Name = "Shows", CollectionType = "tvshows", Locations = new[] { @"D:\TV" } } };

        // A new episode: its season folder is found and refreshed (not "no ancestor").
        var plan = BridgePaths.Plan(BridgePaths.Norm(@"D:\TV\Firefly (2002)\Season 01\E04.mkv"), libs, access.FindByPath);
        Assert.Equal((RefreshOutcome.Refresh, season.Id), (plan.Outcome, plan.AncestorId));
        // An episode Jellyfin has is "present", not "not in Jellyfin".
        Assert.Equal(RefreshOutcome.Present, BridgePaths.Plan("D:/TV/Firefly (2002)/Season 01/E03.mkv", libs, access.FindByPath).Outcome);
        // Paths handed to Jellyfin's monitor and refresh options are native too.
        access.ReportChanged("D:/TV/Spaced (1999)");
        monitor.Verify(m => m.ReportFileSystemChanged(@"D:\TV\Spaced (1999)"), Times.Once);
        Assert.Equal(@"D:\TV\Spaced (1999)\Season 01", JellyfinLibraryAccess.ToNative("D:/TV/Spaced (1999)/Season 01", '\\'));
        Assert.Equal("/media/tv/Spaced (1999)", JellyfinLibraryAccess.ToNative("/media/tv/Spaced (1999)", '/'));
    }

    [Fact]
    public void OnWindowsAPathDifferingOnlyInCaseIsInsideTheLibraryAndReachesJellyfinInItsOwnCase()
    {
        var lib = new FakeLibraryAccess();
        lib.AddLibrary("Movies", "movies", "D:/Media/Movies");
        lib.AddLibrary("Shows", "tvshows", "//NAS/TV");
        lib.AddFolder("//NAS/TV/Firefly (2002)", "series");
        // Radarr's root folder is "d:\media\movies": the same NTFS folder as Jellyfin's "D:\Media\Movies".
        var plan = BridgePaths.Plan(BridgePaths.Norm(@"d:\media\movies\Dune (2021)\Dune.mkv"), lib.Libraries(), lib.FindByPath);
        Assert.Equal((RefreshOutcome.Refresh, "D:/Media/Movies", "D:/Media/Movies/Dune (2021)/Dune.mkv"), (plan.Outcome, plan.Ancestor, plan.File));
        Assert.Equal(new[] { "D:/Media/Movies/Dune (2021)/Dune.mkv", "D:/Media/Movies/Dune (2021)" }, plan.RefreshPaths);
        // A UNC share too (its series folder is found, so the TV root is never the one refreshed).
        var episode = BridgePaths.Plan("//nas/tv/Firefly (2002)/Season 01/E1.mkv", lib.Libraries(), lib.FindByPath);
        Assert.Equal((RefreshOutcome.Refresh, "//NAS/TV/Firefly (2002)"), (episode.Outcome, episode.Ancestor));
        Assert.True(BridgePaths.SamePath("d:/media/movies/", @"D:\Media\Movies"));
        // POSIX paths stay case-sensitive (two folders on Linux).
        Assert.False(BridgePaths.IsUnder("/Movies/a.mkv", "/movies"));
        Assert.False(BridgePaths.SamePath("/media/Movies", "/media/movies"));
        Assert.Equal(RefreshOutcome.OutsideLibrary, BridgePaths.Plan("/media/Movies/x.mkv", Library().Libraries(), lib.FindByPath).Outcome);
    }

    [Fact]
    public async Task AWindowsImportWhoseRootFolderDiffersInCaseIsRefreshedIntoJellyfin()
    {
        using var rig = new Rig(mappings: false);
        rig.Library.AddLibrary("Films", "movies", "D:/Media/Movies");
        const string File = "D:/Media/Movies/Dune (2021)/Dune (2021).mkv";
        rig.Library.AddFile(File, indexed: false, kind: "movie");
        await rig.History(rig.Radarr, "RadarrZ");
        rig.Radarr.History.Add(Rig.Import(9, rig.Arr.Now.UtcDateTime, @"d:\media\movies\Dune (2021)\Dune (2021).mkv", movie: 1));
        await rig.History(rig.Radarr, "RadarrZ");
        await Until(() => rig.Bridge.Recent().Count >= 1);
        var record = Assert.Single(rig.Bridge.Recent());
        Assert.Equal((RefreshOutcome.Refresh, File, true), (record.Outcome, record.JellyfinPath, record.Found));
        Assert.Equal(rig.Library.Items["D:/Media/Movies"].Id, Assert.Single(rig.Library.Refreshes).Folder);
        Assert.Empty(rig.Bridge.NotInJellyfin());
    }

    [Fact]
    public void AFileJellyfinAlreadyHasNeedsNoRefreshAndAMissingLibraryFolderStopsTheWalk()
    {
        var lib = Library();
        lib.AddFile("/media/tv/Firefly (2002)/Season 01/E1.mkv", indexed: true);
        Assert.Equal(RefreshOutcome.Present, BridgePaths.Plan("/media/tv/Firefly (2002)/Season 01/E1.mkv", lib.Libraries(), lib.FindByPath).Outcome);
        lib.Items.Remove("/media/movies");
        var plan = BridgePaths.Plan("/media/movies/New (2024)/New.mkv", lib.Libraries(), lib.FindByPath);
        Assert.Equal(RefreshOutcome.NoAncestor, plan.Outcome);
        Assert.Null(plan.AncestorId);
    }

    [Theory]
    [InlineData("/data/media/movies/Sintel (2010)", "/rigmedia/movies/Sintel (2010)", "/data/media", "/rigmedia")]
    [InlineData("/movies/Sintel", "/movies/Sintel", null, null)]
    [InlineData("/data/movies/Sintel", "/srv/Other Name", null, null)]
    // Windows: a drive, a UNC share and an arr on Windows keep their root form (no "/D:", no "/nas").
    [InlineData("/data/tv/Show", "D:\\Media\\TV\\Show", "/data/tv", "D:/Media/TV")]
    [InlineData("/data/tv/Show", "\\\\nas\\series\\Show", "/data/tv", "//nas/series")]
    [InlineData("C:/arr/Movies/Sintel", "/rigmedia/Movies/Sintel", "C:/arr", "/rigmedia")]
    [InlineData("/data/Show", "D:/Show", "/data", "D:/")]
    public void ThePathDoctorLearnsAMappingFromTitlesBothSidesHave(string arr, string jf, string? arrHead, string? jfHead)
    {
        var learned = BridgePaths.LearnMapping(new[] { (arr, jf) });
        Assert.Equal(arrHead, learned?.ArrPath);
        Assert.Equal(jfHead, learned?.JellyfinPath);
        if (learned is { } m)
        {
            // The suggestion works when applied: the arr path maps onto the Jellyfin one.
            var mapped = BridgePaths.Map(arr, new[] { new Jellyfin.Plugin.JellyfinEnhanced.Model.Arr.ArrPathMapping { ArrPath = m.ArrPath, JellyfinPath = m.JellyfinPath } });
            Assert.Equal(BridgePaths.Norm(jf), mapped.Path);
        }
        // Two titles that disagree on the head learn nothing.
        Assert.Null(BridgePaths.LearnMapping(new[] { ("/a/movies/X", "/b/movies/X"), ("/a/movies/Y", "/c/movies/Y") }));
        Assert.Equal("/m/Dune (2021)", BridgePaths.ItemFolder("/m/Dune (2021)/Dune.mkv"));
        Assert.Equal("/tv/Firefly", BridgePaths.ItemFolder("/tv/Firefly"));
    }

    // ------------------------------------------------------------------ the bridge over the store

    private sealed class Rig : IDisposable
    {
        public FakeArr Arr { get; } = new();
        public FakeArr.Host Sonarr { get; }
        public FakeArr.Host Radarr { get; }
        public ArrStateStore Store { get; }
        public FakeLibraryAccess Library { get; } = Library();
        public JellyfinBridge Bridge { get; }

        public Rig(bool mappings = true)
        {
            Sonarr = Arr.Add("sonarr.lan", "Sonarr");
            Radarr = Arr.Add("radarr.lan", "Radarr");
            Arr.Configure(("SonarrZ", ArrKind.Sonarr, "http://sonarr.lan:8989", "SONARR-KEY-0123456789"), ("RadarrZ", ArrKind.Radarr, "http://radarr.lan:7878", "RADARR-KEY-0123456789"));
            var c = Arr.Plugin.Plugin.Configuration;
            if (mappings)
            {
                c.SonarrInstances = WithMapping(c.SonarrInstances, "/data/tv", "/media/tv");
                c.RadarrInstances = WithMapping(c.RadarrInstances, "/data/movies", "/media/movies");
            }
            c.ArrIntegrationEnabled = true;
            c.ArrPhase1Enabled = true;
            c.ArrPhase2Enabled = true;
            Sonarr.Series.Add(FakeArr.SeriesRow(1, 78874, "Firefly"));
            Radarr.Movies.Add(FakeArr.Movie(1, 438631, "Dune", path: "/data/movies/Dune (2021)"));
            Store = Arr.Store();
            Bridge = new JellyfinBridge(Store, Library, null, () => Arr.Plugin.Plugin.Configuration, () => Arr.Now, null) { Debounce = TimeSpan.FromMilliseconds(20), NewFolderFollowUp = TimeSpan.FromMilliseconds(300) };
            Bridge.Subscribe();
        }

        public ArrConnection Instance(string name) => Arr.Instance(name);

        public static string WithMapping(string json, string arr, string jf)
        {
            var rows = JsonNode.Parse(json)!.AsArray();
            foreach (var row in rows) row!["PathMappings"] = new JsonArray(new JsonObject { ["ArrPath"] = arr, ["JellyfinPath"] = jf });
            return rows.ToJsonString();
        }

        public static JsonObject Import(int id, DateTime at, string path, int? season = 1, int? episode = 4, int movie = 0)
        {
            var row = movie > 0 ? FakeArr.HistoryRow(id, "downloadFolderImported", at, "dl" + id, 438631, "Dune") : FakeArr.HistoryRow(id, "downloadFolderImported", at, "dl" + id, 1, "Firefly", season, episode);
            if (movie > 0) row["movieId"] = movie;
            else
            {
                row["seriesId"] = 1;
                row["episodeId"] = 100 + id;
            }
            row["data"] = new JsonObject { ["importedPath"] = path };
            return row;
        }

        /// <summary>Reads the instance's history: the first time a load, then a refresh (as a live hint does).</summary>
        public async Task History(FakeArr.Host host, string name)
        {
            var instance = Instance(name);
            if (Store.PeekHistory(instance.Id) == null) await Store.GetHistoryAsync(instance, default);
            else await Store.RefreshForEventAsync(instance.Id, ArrSnapshotKind.History, force: true);
        }

        public void Dispose()
        {
            Bridge.Dispose();
            Arr.Dispose();
        }
    }

    private static async Task Until(Func<bool> check, int ms = 3000)
    {
        var end = DateTime.UtcNow.AddMilliseconds(ms);
        while (!check() && DateTime.UtcNow < end) await Task.Delay(10);
    }

    [Fact]
    public async Task AnImportRefreshesOnlyItsSeasonFolderAndOnlyForImportsNewSinceTheLastRead()
    {
        using var rig = new Rig();
        // In the history before the first read: one Jellyfin already lists (replayed, nothing to do,
        // no trace) and one older than half an hour (Jellyfin's to find; not replayed).
        rig.Library.AddFile("/media/tv/Firefly (2002)/Season 01/E1.mkv", indexed: true);
        rig.Sonarr.History.Add(Rig.Import(1, rig.Arr.Now.UtcDateTime.AddMinutes(-5), "/data/tv/Firefly (2002)/Season 01/E1.mkv", episode: 1));
        rig.Sonarr.History.Add(Rig.Import(4, rig.Arr.Now.UtcDateTime.AddMinutes(-45), "/data/tv/Firefly (2002)/Season 01/E2.mkv", episode: 2));
        await rig.History(rig.Sonarr, "SonarrZ");
        await Task.Delay(100);
        Assert.Empty(rig.Library.Refreshes);
        Assert.Empty(rig.Bridge.Recent());

        // Two new imports into the same season: one refresh of that season with both files, and with
        // any other new file there (E3, whose import the arr reported elsewhere), so none is added half-done.
        rig.Library.AddFile("/media/tv/Firefly (2002)/Season 01/E3.mkv", indexed: false);
        rig.Library.AddFile("/media/tv/Firefly (2002)/Season 01/E4.mkv", indexed: false);
        rig.Library.AddFile("/media/tv/Firefly (2002)/Season 01/E5.mkv", indexed: false);
        rig.Sonarr.History.Add(Rig.Import(2, rig.Arr.Now.UtcDateTime.AddSeconds(-2), "/data/tv/Firefly (2002)/Season 01/E4.mkv"));
        rig.Sonarr.History.Add(Rig.Import(3, rig.Arr.Now.UtcDateTime.AddSeconds(-1), "/data/tv/Firefly (2002)/Season 01/E5.mkv", episode: 5));
        await rig.History(rig.Sonarr, "SonarrZ");
        await Until(() => rig.Bridge.Recent().Count >= 2);
        var refresh = Assert.Single(rig.Library.Refreshes);
        Assert.Equal(rig.Library.Items["/media/tv/Firefly (2002)/Season 01"].Id, refresh.Folder);
        Assert.Equal(new[] { "/media/tv/Firefly (2002)/Season 01/E3.mkv", "/media/tv/Firefly (2002)/Season 01/E4.mkv", "/media/tv/Firefly (2002)/Season 01/E5.mkv" }, refresh.Paths.OrderBy(p => p));
        Assert.All(rig.Bridge.Recent(), r => Assert.True(r.Found && r.Outcome == RefreshOutcome.Refresh));
        Assert.Equal((1L, 2L), rig.Bridge.Stats);
    }

    [Fact]
    public async Task AnUpgradeImportedAtAPathJellyfinAlreadyHasIsReadAgainOnce()
    {
        using var rig = new Rig();
        // Jellyfin has E1 and the movie; their imports from before the first read are replayed and left alone.
        rig.Library.AddFile("/media/tv/Firefly (2002)/Season 01/E1.mkv", indexed: true);
        rig.Library.AddFile("/media/tv/Firefly (2002)/Season 01/E2-E3.mkv", indexed: true);
        rig.Library.AddFolder("/media/movies/Dune (2021)", "folder");
        rig.Library.AddFile("/media/movies/Dune (2021)/Dune (2021).mkv", indexed: true, kind: "movie");
        rig.Sonarr.History.Add(Rig.Import(1, rig.Arr.Now.UtcDateTime.AddMinutes(-5), "/data/tv/Firefly (2002)/Season 01/E1.mkv", episode: 1));
        await rig.History(rig.Sonarr, "SonarrZ");
        await rig.History(rig.Radarr, "RadarrZ");
        await Task.Delay(100);
        Assert.Empty(rig.Library.FileRefreshes);

        // Sonarr upgrades E1 and the E2-E3 file in place (one import per episode), Radarr the movie: the same paths.
        rig.Sonarr.History.Add(Rig.Import(2, rig.Arr.Now.UtcDateTime.AddSeconds(-3), "/data/tv/Firefly (2002)/Season 01/E1.mkv", episode: 1));
        rig.Sonarr.History.Add(Rig.Import(3, rig.Arr.Now.UtcDateTime.AddSeconds(-2), "/data/tv/Firefly (2002)/Season 01/E2-E3.mkv", episode: 2));
        rig.Sonarr.History.Add(Rig.Import(4, rig.Arr.Now.UtcDateTime.AddSeconds(-2), "/data/tv/Firefly (2002)/Season 01/E2-E3.mkv", episode: 3));
        rig.Radarr.History.Add(Rig.Import(5, rig.Arr.Now.UtcDateTime.AddSeconds(-1), "/data/movies/Dune (2021)/Dune (2021).mkv", movie: 1));
        await rig.History(rig.Sonarr, "SonarrZ");
        await rig.History(rig.Radarr, "RadarrZ");
        await Until(() => rig.Library.FileRefreshes.Count >= 3);
        await Task.Delay(100);
        // Each item once, never a folder refresh: Jellyfin reads the changed file (its media info) again.
        var expected = new[] { "/media/tv/Firefly (2002)/Season 01/E1.mkv", "/media/tv/Firefly (2002)/Season 01/E2-E3.mkv", "/media/movies/Dune (2021)/Dune (2021).mkv" }
            .Select(p => rig.Library.Items[p].Id).OrderBy(i => i).ToList();
        Assert.Equal(expected, rig.Library.FileRefreshes.OrderBy(i => i).ToList());
        Assert.Empty(rig.Library.Refreshes);
        Assert.Contains(rig.Bridge.Recent(), r => r.Outcome == RefreshOutcome.Present && r.Found);

        // With targeted refresh switched off, nothing is asked of Jellyfin.
        rig.Arr.Plugin.Plugin.Configuration.ArrTargetedRefreshEnabled = false;
        rig.Sonarr.History.Add(Rig.Import(6, rig.Arr.Now.UtcDateTime, "/data/tv/Firefly (2002)/Season 01/E1.mkv", episode: 1));
        await rig.History(rig.Sonarr, "SonarrZ");
        await Task.Delay(200);
        Assert.Equal(3, rig.Library.FileRefreshes.Count);
    }

    [Fact]
    public async Task AnImportedEpisodeReplacesTheMissingEpisodeJellyfinStillListsForItsSlot()
    {
        using var rig = new Rig();
        // Jellyfin shows missing episodes: E4 is listed as missing; its file arrives in the existing season folder.
        rig.Library.AddFile("/media/tv/Firefly (2002)/Season 01/E1.mkv", indexed: true);
        rig.Library.AddFile("/media/tv/Firefly (2002)/Season 01/E4.mkv", indexed: false);
        rig.Library.AddFile("/media/tv/Firefly (2002)/Season 01/E5.mkv", indexed: false);
        rig.Library.MissingTwins["/media/tv/Firefly (2002)/Season 01/E4.mkv"] = 1;
        await rig.History(rig.Sonarr, "SonarrZ");
        rig.Sonarr.History.Add(Rig.Import(2, rig.Arr.Now.UtcDateTime.AddSeconds(-2), "/data/tv/Firefly (2002)/Season 01/E4.mkv"));
        await rig.History(rig.Sonarr, "SonarrZ");
        await Until(() => rig.Bridge.Recent().Count >= 1 && rig.Library.TwinRemovals.Count >= 1);
        // Once Jellyfin has the file, the missing episode of its slot goes.
        Assert.Contains("/media/tv/Firefly (2002)/Season 01/E4.mkv", rig.Library.TwinRemovals);
        Assert.False(rig.Library.MissingTwins.ContainsKey("/media/tv/Firefly (2002)/Season 01/E4.mkv"));

        // A file the refresh didn't bring in leaves the missing episode alone.
        rig.Library.RefreshFinds = false;
        rig.Library.AddFile("/media/tv/Firefly (2002)/Season 01/E6.mkv", indexed: false);
        rig.Library.MissingTwins["/media/tv/Firefly (2002)/Season 01/E6.mkv"] = 1;
        rig.Sonarr.History.Add(Rig.Import(3, rig.Arr.Now.UtcDateTime.AddSeconds(-1), "/data/tv/Firefly (2002)/Season 01/E6.mkv", episode: 6));
        await rig.History(rig.Sonarr, "SonarrZ");
        await Until(() => rig.Bridge.Recent().Any(r => r.JellyfinPath.EndsWith("E6.mkv", StringComparison.Ordinal)));
        await Task.Delay(100);
        Assert.DoesNotContain("/media/tv/Firefly (2002)/Season 01/E6.mkv", rig.Library.TwinRemovals);
        Assert.True(rig.Library.MissingTwins.ContainsKey("/media/tv/Firefly (2002)/Season 01/E6.mkv"));
    }

    [Fact]
    public async Task AMultiEpisodeFileHasItsMissingTwinsRemovedOnceThoughSonarrReportsOneImportPerEpisode()
    {
        using var rig = new Rig();
        rig.Bridge.MissingTwinWaits = new[] { TimeSpan.FromMilliseconds(30), TimeSpan.FromMilliseconds(30) };
        rig.Library.AddFile("/media/tv/Firefly (2002)/Season 01/E1.mkv", indexed: true);
        rig.Library.AddFile("/media/tv/Firefly (2002)/Season 01/E4-E5.mkv", indexed: false);
        rig.Library.MissingTwins["/media/tv/Firefly (2002)/Season 01/E4-E5.mkv"] = 2;
        // Jellyfin numbers the episode a moment after adding it: the first look finds nothing to tell apart yet.
        rig.Library.NumberedLater.Add("/media/tv/Firefly (2002)/Season 01/E4-E5.mkv");
        await rig.History(rig.Sonarr, "SonarrZ");
        // Sonarr's history has the S01E04-E05 file twice: once for E04, once for E05.
        rig.Sonarr.History.Add(Rig.Import(2, rig.Arr.Now.UtcDateTime.AddSeconds(-2), "/data/tv/Firefly (2002)/Season 01/E4-E5.mkv", episode: 4));
        rig.Sonarr.History.Add(Rig.Import(3, rig.Arr.Now.UtcDateTime.AddSeconds(-2), "/data/tv/Firefly (2002)/Season 01/E4-E5.mkv", episode: 5));
        await rig.History(rig.Sonarr, "SonarrZ");
        await Until(() => rig.Library.MissingTwins.Count == 0);
        await Task.Delay(200);
        // One look, then one look again once numbered: the second import neither looks nor starts its own retries.
        Assert.Equal(2, rig.Library.TwinRemovals.Count);

        // Done with it: a later import of the same file (an upgrade) is handled again.
        rig.Library.MissingTwins["/media/tv/Firefly (2002)/Season 01/E4-E5.mkv"] = 1;
        rig.Sonarr.History.Add(Rig.Import(4, rig.Arr.Now.UtcDateTime.AddSeconds(-1), "/data/tv/Firefly (2002)/Season 01/E4-E5.mkv", episode: 4));
        await rig.History(rig.Sonarr, "SonarrZ");
        await Until(() => rig.Library.MissingTwins.Count == 0);
        Assert.Equal(3, rig.Library.TwinRemovals.Count);
    }

    [Fact]
    public void AMissingEpisodeIsATwinByJellyfinsOwnRuleAndNothingElseIs()
    {
        // The rule the bridge removes missing episodes by (JellyfinLibraryAccess.RemoveMissingTwins), on Jellyfin's
        // own items: the missing episodes of the same series and season whose number the file's episode contains
        // (Episode.ContainsEpisodeNumber, IndexNumber..IndexNumberEnd), as Jellyfin's series refresh removes them.
        var series = Guid.NewGuid();
        Episode File(int season, int number, int? end = null) => new() { Id = Guid.NewGuid(), SeriesId = series, ParentIndexNumber = season, IndexNumber = number, IndexNumberEnd = end, Path = $"/media/tv/Firefly (2002)/Season 0{season}/E{number}.mkv" };
        // As Jellyfin adds a missing episode: no path, IsVirtualItem.
        Episode Missing(int season, int? number, Guid? of = null) => new() { Id = Guid.NewGuid(), SeriesId = of ?? series, ParentIndexNumber = season, IndexNumber = number, IsVirtualItem = true };

        bool Twin(Episode file, BaseItem candidate) => JellyfinLibraryAccess.IsMissingTwin(file, series, candidate);

        // An S01E04-E05 file fills both missing slots.
        var double45 = File(1, 4, 5);
        Assert.True(Twin(double45, Missing(1, 4)));
        Assert.True(Twin(double45, Missing(1, 5)));
        Assert.False(Twin(double45, Missing(1, 3)));
        Assert.False(Twin(double45, Missing(1, 6)));
        var single = File(1, 3);
        Assert.True(Twin(single, Missing(1, 3)));
        Assert.False(Twin(single, Missing(1, 4)));

        // Never another season, another series, an unnumbered missing episode, an episode with a file (the
        // file's own included), or anything that isn't an episode.
        Assert.False(Twin(double45, Missing(2, 4)));
        Assert.False(Twin(double45, Missing(1, 4, Guid.NewGuid())));
        Assert.False(Twin(double45, Missing(1, null)));
        Assert.False(Twin(double45, File(1, 4)));
        Assert.False(Twin(double45, File(1, 5)));
        Assert.False(Twin(double45, double45));
        Assert.False(JellyfinLibraryAccess.IsMissingTwin(double45, Guid.Empty, Missing(1, 4)));
        var flagged = File(1, 4);
        flagged.IsVirtualItem = true;
        Assert.False(Twin(double45, flagged));
        Assert.False(Twin(double45, new Season { Id = Guid.NewGuid(), SeriesId = series, IndexNumber = 1 }));
        // A file Jellyfin hasn't numbered yet fills nothing (the bridge looks again later).
        Assert.False(Twin(new Episode { Id = Guid.NewGuid(), SeriesId = series, ParentIndexNumber = 1, Path = "/media/tv/x.mkv" }, Missing(1, 4)));
    }

    [Fact]
    public void TheCleanupNeverTouchesAnotherGroupedFolderOrAnyVersionWithAFile()
    {
        // Automatic series grouping: the "4K" folder of the same series is another series item with the same
        // presentation key (Jellyfin's grouped lists show both). Its missing episode is never the file's twin.
        var series = Guid.NewGuid();
        var other = Guid.NewGuid();
        const string presentation = "78874-en-library";
        var file = new Episode { Id = Guid.NewGuid(), SeriesId = series, SeriesPresentationUniqueKey = presentation, ParentIndexNumber = 1, IndexNumber = 3, Path = "/media/tv/Firefly/Season 01/S01E03 - 1080p.mkv" };
        var ownMissing = new Episode { Id = Guid.NewGuid(), SeriesId = series, SeriesPresentationUniqueKey = presentation, ParentIndexNumber = 1, IndexNumber = 3, IsVirtualItem = true };
        var otherMissing = new Episode { Id = Guid.NewGuid(), SeriesId = other, SeriesPresentationUniqueKey = presentation, ParentIndexNumber = 1, IndexNumber = 3, IsVirtualItem = true };
        Assert.True(JellyfinLibraryAccess.IsMissingTwin(file, series, ownMissing));
        Assert.False(JellyfinLibraryAccess.IsMissingTwin(file, series, otherMissing));
        Assert.False(JellyfinLibraryAccess.IsMissingTwin(file, other, otherMissing), "never with another series item than the file's own");

        // Multiple versions: a second file of the same episode (Jellyfin 12 groups it as a version of the first,
        // owned by it), and the first file itself, have paths; neither is ever removed, by either file.
        var version = new Episode { Id = Guid.NewGuid(), SeriesId = series, ParentIndexNumber = 1, IndexNumber = 3, Path = "/media/tv/Firefly/Season 01/S01E03 - 2160p.mkv", OwnerId = file.Id };
#if NET10_0_OR_GREATER
        version.PrimaryVersionId = file.Id;
#else
        version.PrimaryVersionId = file.Id.ToString("N");
#endif
        Assert.False(JellyfinLibraryAccess.IsMissingTwin(file, series, version));
        Assert.False(JellyfinLibraryAccess.IsMissingTwin(version, series, file));
        Assert.True(JellyfinLibraryAccess.IsMissingTwin(version, series, ownMissing));
        // Even a version Jellyfin flags missing keeps its file.
        var flagged = new Episode { Id = Guid.NewGuid(), SeriesId = series, ParentIndexNumber = 1, IndexNumber = 3, Path = "/media/tv/Firefly/Season 01/S01E03 - 720p.mkv", IsVirtualItem = true };
        Assert.False(JellyfinLibraryAccess.IsMissingTwin(file, series, flagged));
    }

    [Fact]
    public void ASeriesPartIsOnlyEverOneOfThatSeriesItemsOwnPrimaryItems()
    {
        // The production filter behind arrival successors (ArrJellyfinView.SeriesParts), on Jellyfin's own items:
        // the series item's own season or episodes covering the number, never another grouped folder's (same
        // presentation key, another SeriesId), never a second version of an episode, never another kind.
        var series = Guid.NewGuid();
        var other = Guid.NewGuid();
        const string presentation = "78874-en-library";
        Episode Ep(Guid of, int season, int number, int? end = null, bool missing = false)
            => new() { Id = Guid.NewGuid(), SeriesId = of, SeriesPresentationUniqueKey = presentation, ParentIndexNumber = season, IndexNumber = number, IndexNumberEnd = end, IsVirtualItem = missing, Path = missing ? null : $"/media/{of:N}/S{season}E{number}.mkv" };
        var otherFile = Ep(other, 1, 3);
        var ownMissing = Ep(series, 1, 3, missing: true);
        var ownFile = Ep(series, 1, 3);
        var double45 = Ep(series, 1, 4, 5);
        var version = Ep(series, 1, 3);
        version.OwnerId = ownFile.Id;
#if NET10_0_OR_GREATER
        version.PrimaryVersionId = ownFile.Id;
#else
        version.PrimaryVersionId = ownFile.Id.ToString("N");
#endif
        var otherSeason = new Season { Id = Guid.NewGuid(), SeriesId = other, SeriesPresentationUniqueKey = presentation, IndexNumber = 1 };
        var ownSeason = new Season { Id = Guid.NewGuid(), SeriesId = series, SeriesPresentationUniqueKey = presentation, IndexNumber = 1 };
        var ownSeason2 = new Season { Id = Guid.NewGuid(), SeriesId = series, IndexNumber = 2 };
        BaseItem[] items = [otherFile, otherSeason, ownMissing, version, ownFile, double45, ownSeason, ownSeason2, Ep(series, 2, 3)];

        Assert.Equal(new[] { ownMissing.Id, ownFile.Id }, ArrJellyfinView.SeriesPartIds(items, series, 1, 3));
        Assert.Equal(new[] { double45.Id }, ArrJellyfinView.SeriesPartIds(items, series, 1, 5));
        Assert.Equal(new[] { ownSeason.Id }, ArrJellyfinView.SeriesPartIds(items, series, 1, null));
        Assert.Equal(new[] { otherFile.Id }, ArrJellyfinView.SeriesPartIds(items, other, 1, 3));
        Assert.Equal(new[] { otherSeason.Id }, ArrJellyfinView.SeriesPartIds(items, other, 1, null));
        Assert.Empty(ArrJellyfinView.SeriesPartIds(items, series, 1, 9));
        Assert.Empty(ArrJellyfinView.SeriesPartIds(items, Guid.Empty, 1, 3));
    }

    [Fact]
    public async Task AnEpisodeJellyfinHasntNumberedYetHasItsMissingTwinRemovedOnceItIs()
    {
        using var rig = new Rig();
        rig.Bridge.MissingTwinWaits = new[] { TimeSpan.FromMilliseconds(30), TimeSpan.FromMilliseconds(30) };
        rig.Library.AddFile("/media/tv/Firefly (2002)/Season 01/E1.mkv", indexed: true);
        rig.Library.AddFile("/media/tv/Firefly (2002)/Season 01/E4.mkv", indexed: false);
        rig.Library.MissingTwins["/media/tv/Firefly (2002)/Season 01/E4.mkv"] = 1;
        // Jellyfin's resolver adds the episode without its numbers; its metadata numbers it a moment later.
        rig.Library.NumberedLater.Add("/media/tv/Firefly (2002)/Season 01/E4.mkv");
        await rig.History(rig.Sonarr, "SonarrZ");
        rig.Sonarr.History.Add(Rig.Import(2, rig.Arr.Now.UtcDateTime.AddSeconds(-2), "/data/tv/Firefly (2002)/Season 01/E4.mkv"));
        await rig.History(rig.Sonarr, "SonarrZ");
        await Until(() => rig.Library.MissingTwins.Count == 0);
        Assert.Empty(rig.Library.MissingTwins);
        Assert.Equal(2, rig.Library.TwinRemovals.Count);
        // Nothing more once it is done (no twin left: no retries).
        await Task.Delay(150);
        Assert.Equal(2, rig.Library.TwinRemovals.Count);
    }

    [Fact]
    public async Task AfterARestartTheBridgeReadsTheHistoryItselfAndRefreshesTheLastHalfHoursImports()
    {
        using var rig = new Rig();
        rig.Library.AddFile("/media/tv/Firefly (2002)/Season 01/E2.mkv", indexed: false);
        rig.Library.AddFile("/media/tv/Firefly (2002)/Season 01/E3.mkv", indexed: true);
        rig.Library.AddFile("/media/tv/Firefly (2002)/Season 01/E4.mkv", indexed: false);
        // Imported 45 minutes ago (Jellyfin's to find), while Jellyfin restarted (5 minutes ago, not
        // listed: real-time monitoring off), 3 minutes ago (listed already), and now.
        rig.Sonarr.History.Add(Rig.Import(1, rig.Arr.Now.UtcDateTime.AddMinutes(-45), "/data/tv/Firefly (2002)/Season 01/E1.mkv", episode: 1));
        rig.Sonarr.History.Add(Rig.Import(2, rig.Arr.Now.UtcDateTime.AddMinutes(-5), "/data/tv/Firefly (2002)/Season 01/E2.mkv", episode: 2));
        rig.Sonarr.History.Add(Rig.Import(3, rig.Arr.Now.UtcDateTime.AddMinutes(-3), "/data/tv/Firefly (2002)/Season 01/E3.mkv", episode: 3));
        rig.Sonarr.History.Add(Rig.Import(5, rig.Arr.Now.UtcDateTime, "/data/tv/Firefly (2002)/Season 01/E4.mkv"));
        // Only the library is read (as at start-up); no page reads the history.
        await rig.Store.GetLibraryAsync(rig.Instance("SonarrZ"), default);
        await Until(() => rig.Bridge.Recent().Count >= 2);
        await Task.Delay(100);
        Assert.NotNull(rig.Store.PeekHistory(rig.Instance("SonarrZ").Id));
        Assert.Equal(new[] { ("/media/tv/Firefly (2002)/Season 01/E2.mkv", true), ("/media/tv/Firefly (2002)/Season 01/E4.mkv", true) }, rig.Bridge.Recent().Select(r => (r.JellyfinPath, r.Found)).OrderBy(r => r.JellyfinPath));
        // One refresh of the season for both; the old import stays Jellyfin's.
        var refresh = Assert.Single(rig.Library.Refreshes);
        Assert.DoesNotContain("/media/tv/Firefly (2002)/Season 01/E1.mkv", refresh.Paths);
    }

    [Fact]
    public async Task ANewSeriesFolderIsLeftToJellyfinsMonitorAndANewMovieRefreshesTheMovieRoot()
    {
        using var rig = new Rig();
        rig.Library.SetRealtime("Shows", true);
        await rig.History(rig.Sonarr, "SonarrZ");
        await rig.History(rig.Radarr, "RadarrZ");
        // A season pack of a new series: three files, one new series folder.
        for (var e = 1; e <= 3; e++) rig.Sonarr.History.Add(Rig.Import(4 + e, rig.Arr.Now.UtcDateTime, $"/data/tv/Spaced (1999)/Season 01/S01E0{e}.mkv", episode: e));
        rig.Radarr.History.Add(Rig.Import(9, rig.Arr.Now.UtcDateTime, "/data/movies/Dune (2021)/Dune (2021).mkv", movie: 1));
        await rig.History(rig.Sonarr, "SonarrZ");
        await rig.History(rig.Radarr, "RadarrZ");
        await Until(() => rig.Bridge.Recent().Count >= 4);
        // The TV root was not refreshed; Jellyfin's own monitor got the new series folder, once.
        var tvRoot = rig.Library.Items["/media/tv"].Id;
        Assert.DoesNotContain(rig.Library.Refreshes, r => r.Folder == tvRoot);
        Assert.Equal(new[] { "/media/tv/Spaced (1999)" }, rig.Library.Reported);
        // Once Jellyfin's monitor has added the series, that one series gets one metadata refresh
        // (not one per imported file).
        var spaced = rig.Library.AddFolder("/media/tv/Spaced (1999)", "series");
        await Until(() => rig.Library.ItemRefreshes.Count > 0);
        await Task.Delay(400);
        Assert.Equal(new[] { spaced.Id }, rig.Library.ItemRefreshes);
        Assert.Single(rig.Bridge.Recent(), r => r.Outcome == "new_folder_refresh");
        Assert.Contains(rig.Bridge.Recent(), r => r.Outcome == RefreshOutcome.LibraryRoot && r.Folder == "/media/tv");
        // The movie root was refreshed non-recursively with the new movie's paths.
        var movie = Assert.Single(rig.Library.Refreshes);
        Assert.Equal(rig.Library.Items["/media/movies"].Id, movie.Folder);
        Assert.Contains("/media/movies/Dune (2021)", movie.Paths);
    }

    [Fact]
    public async Task ANewSeriesInALibraryWithoutRealtimeMonitoringIsNotReportedToJellyfinsMonitor()
    {
        // Jellyfin acts on a reported path whatever the library's setting, by validating the
        // nearest item it has (the TV root) recursively: a whole-library scan per new series.
        using var rig = new Rig();
        await rig.History(rig.Sonarr, "SonarrZ");
        rig.Library.AddFile("/media/tv/Spaced (1999)/Season 01/S01E01.mkv", indexed: false);
        rig.Sonarr.History.Add(Rig.Import(5, rig.Arr.Now.UtcDateTime, "/data/tv/Spaced (1999)/Season 01/S01E01.mkv", episode: 1));
        await rig.History(rig.Sonarr, "SonarrZ");
        await Until(() => rig.Bridge.Recent().Count >= 1);
        await Task.Delay(400);
        Assert.Empty(rig.Library.Reported);
        Assert.Empty(rig.Library.Refreshes);
        Assert.Empty(rig.Library.ItemRefreshes);
        var left = Assert.Single(rig.Bridge.Recent());
        Assert.Equal((JellyfinBridge.LeftToScan, "/media/tv", false), (left.Outcome, left.Folder, left.Found));
        // It is listed as not in Jellyfin (with Scan now) until the next library scan.
        Assert.Contains(rig.Bridge.NotInJellyfin(), m => m.JellyfinPath == "/media/tv/Spaced (1999)/Season 01/S01E01.mkv" && m.Problem == "not_scanned");
    }

    [Fact]
    public async Task AnEpisodeInANewSeasonFolderIsFoundByRefreshingTheSeriesThenTheNewSeason()
    {
        using var rig = new Rig();
        await rig.History(rig.Sonarr, "SonarrZ");
        const string file = "/media/tv/Firefly (2002)/Season 02/Firefly - S02E01.mkv";
        rig.Library.AddFile(file, indexed: false);
        rig.Sonarr.History.Add(Rig.Import(5, rig.Arr.Now.UtcDateTime, "/data/tv/Firefly (2002)/Season 02/Firefly - S02E01.mkv", season: 2, episode: 1));
        await rig.History(rig.Sonarr, "SonarrZ");
        await Until(() => rig.Bridge.Recent().Count >= 1);
        // The series (adds the season folder), then the new season (adds the episode); never the TV root.
        Assert.Equal(2, rig.Library.Refreshes.Count);
        Assert.Equal(rig.Library.Items["/media/tv/Firefly (2002)"].Id, rig.Library.Refreshes[0].Folder);
        Assert.Equal(rig.Library.Items["/media/tv/Firefly (2002)/Season 02"].Id, rig.Library.Refreshes[1].Folder);
        Assert.Equal(new[] { file }, rig.Library.Refreshes[1].Paths);
        var record = Assert.Single(rig.Bridge.Recent());
        Assert.True(record.Found);
        Assert.Equal((RefreshOutcome.Refresh, "/media/tv/Firefly (2002)/Season 02"), (record.Outcome, record.Folder));
        Assert.Equal((2L, 1L), rig.Bridge.Stats);

        // Scan now does the same for a file in another new season folder.
        const string other = "/media/tv/Firefly (2002)/Season 03/Firefly - S03E01.mkv";
        rig.Library.AddFile(other, indexed: false);
        var scan = await rig.Bridge.ScanNowAsync(rig.Instance("SonarrZ"), "/data/tv/Firefly (2002)/Season 03/Firefly - S03E01.mkv", default);
        Assert.Equal(("refreshed", true, "/media/tv/Firefly (2002)/Season 03"), (scan.Outcome, scan.Found, scan.Folder));
        // Its two refreshes (series, then the new season) and its file count in the System tab's summary.
        Assert.Equal((4L, 2L), rig.Bridge.Stats);
    }

    [Fact]
    public async Task RefreshesOfOneFolderNeverOverlapEvenWhenSeveralWaitForTheSameOne()
    {
        using var rig = new Rig();
        var sonarr = rig.Instance("SonarrZ");
        for (var e = 4; e <= 6; e++) rig.Library.AddFile($"/media/tv/Firefly (2002)/Season 01/E{e}.mkv", indexed: false);
        var gate = new TaskCompletionSource();
        var active = 0;
        var most = 0;
        var first = true;
        rig.Library.DuringRefresh = async _ =>
        {
            var now = Interlocked.Increment(ref active);
            lock (rig) most = Math.Max(most, now);
            if (first)
            {
                first = false;
                await gate.Task;
            }
            await Task.Delay(80);
            Interlocked.Decrement(ref active);
        };
        var a = rig.Bridge.ScanNowAsync(sonarr, "/data/tv/Firefly (2002)/Season 01/E4.mkv", default);
        await Until(() => rig.Library.Refreshes.Count == 1);
        // Two more for the same folder while the first runs: the second joins the one waiting
        // behind it (one refresh with both paths), so one runs and one waits.
        var b = rig.Bridge.ScanNowAsync(sonarr, "/data/tv/Firefly (2002)/Season 01/E5.mkv", default);
        var c = rig.Bridge.ScanNowAsync(sonarr, "/data/tv/Firefly (2002)/Season 01/E6.mkv", default);
        await Task.Delay(100);
        gate.SetResult();
        await Task.WhenAll(a, b, c);
        Assert.True((await b).Found && (await c).Found);
        await Until(() => rig.Library.Refreshes.Count == 2 && Volatile.Read(ref active) == 0);
        await Task.Delay(100);
        Assert.Equal(2, rig.Library.Refreshes.Count);
        // The summary counts refreshes run, not requests (three asked, two ran).
        Assert.Equal(2L, rig.Bridge.Stats.Refreshes);
        Assert.Equal(new[] { "/media/tv/Firefly (2002)/Season 01/E5.mkv", "/media/tv/Firefly (2002)/Season 01/E6.mkv" }, rig.Library.Refreshes[1].Paths.Where(p => p.EndsWith("E5.mkv", StringComparison.Ordinal) || p.EndsWith("E6.mkv", StringComparison.Ordinal)).OrderBy(p => p));
        Assert.Equal(1, most);
    }

    [Fact]
    public async Task AWaitingRefreshNeverStartsWhileTheOneBeforeItStillRunsHoweverLongThatTakes()
    {
        using var rig = new Rig();
        // A short budget: the running refresh (a slow metadata provider that ignores cancellation)
        // outlives it many times over; nothing for the folder may start until it has ended.
        rig.Bridge.RefreshBudget = TimeSpan.FromMilliseconds(150);
        var sonarr = rig.Instance("SonarrZ");
        for (var e = 4; e <= 7; e++) rig.Library.AddFile($"/media/tv/Firefly (2002)/Season 01/E{e}.mkv", indexed: false);
        var gate = new TaskCompletionSource();
        var active = 0;
        var most = 0;
        var first = true;
        rig.Library.DuringRefresh = async _ =>
        {
            var now = Interlocked.Increment(ref active);
            lock (rig) most = Math.Max(most, now);
            if (first)
            {
                first = false;
                await gate.Task;
            }
            else
            {
                await Task.Delay(50);
            }

            Interlocked.Decrement(ref active);
        };
        var a = rig.Bridge.ScanNowAsync(sonarr, "/data/tv/Firefly (2002)/Season 01/E4.mkv", default);
        await Until(() => rig.Library.Refreshes.Count == 1);
        var b = rig.Bridge.ScanNowAsync(sonarr, "/data/tv/Firefly (2002)/Season 01/E5.mkv", default);
        await Task.Delay(500);
        var c = rig.Bridge.ScanNowAsync(sonarr, "/data/tv/Firefly (2002)/Season 01/E6.mkv", default);
        await Task.Delay(500);
        Assert.Single(rig.Library.Refreshes);
        gate.SetResult();
        await Task.WhenAll(a, b, c);
        await Until(() => rig.Library.Refreshes.Count == 2 && Volatile.Read(ref active) == 0);
        // One more after the waiting one started: it waits behind that one.
        var d = rig.Bridge.ScanNowAsync(sonarr, "/data/tv/Firefly (2002)/Season 01/E7.mkv", default);
        Assert.True((await d).Found);
        await Until(() => rig.Library.Refreshes.Count == 3 && Volatile.Read(ref active) == 0);
        Assert.Equal(1, most);
        Assert.Contains("/media/tv/Firefly (2002)/Season 01/E5.mkv", rig.Library.Refreshes[1].Paths);
        Assert.Contains("/media/tv/Firefly (2002)/Season 01/E6.mkv", rig.Library.Refreshes[1].Paths);
        Assert.Contains("/media/tv/Firefly (2002)/Season 01/E7.mkv", rig.Library.Refreshes[2].Paths);
    }

    /// <summary>
    /// A Scan now of a Season 02 file whose series refresh is held at <paramref name="gate"/> (a slow
    /// metadata provider that ignores cancellation), then a Season 03 file added meanwhile.
    /// </summary>
    private static async Task<(Task<BridgeScanResult> First, string Second)> SeriesRefreshHeld(Rig rig, Task gate)
    {
        var sonarr = rig.Instance("SonarrZ");
        var first = true;
        rig.Library.DuringRefresh = async _ =>
        {
            if (!first) return;
            first = false;
            await gate;
        };
        rig.Library.AddFile("/media/tv/Firefly (2002)/Season 02/E1.mkv", indexed: false);
        var a = rig.Bridge.ScanNowAsync(sonarr, "/data/tv/Firefly (2002)/Season 02/E1.mkv", default);
        await Until(() => rig.Library.Refreshes.Count == 1);
        const string second = "/media/tv/Firefly (2002)/Season 03/E1.mkv";
        rig.Library.AddFile(second, indexed: false);
        return (a, second);
    }

    [Fact]
    public async Task ScanNowWaitsFromWhenItsRefreshStartsNotWhileItIsQueuedBehindAnother()
    {
        using var rig = new Rig();
        rig.Bridge.ScanNowWait = TimeSpan.FromMilliseconds(200);
        rig.Bridge.ScanNowQueueWait = TimeSpan.FromSeconds(5);
        var gate = new TaskCompletionSource();
        var (a, second) = await SeriesRefreshHeld(rig, gate.Task);
        var b = rig.Bridge.ScanNowAsync(rig.Instance("SonarrZ"), "/data/tv/Firefly (2002)/Season 03/E1.mkv", default);
        // The series refresh before it runs well past Scan now's 200 ms wait.
        await Task.Delay(600);
        Assert.False(b.IsCompleted);
        gate.SetResult();
        // Its own series refresh adds Season 03, then Season 03's adds the episode: both levels.
        var result = await b;
        Assert.Equal(("refreshed", true, "/media/tv/Firefly (2002)/Season 03"), (result.Outcome, result.Found, result.Folder));
        Assert.NotNull(rig.Library.FindByPath(second));
        await a;
    }

    [Fact]
    public async Task AScanNowThatGaveUpWaitingInTheQueueIsFollowedThroughOnceTheRefreshRuns()
    {
        using var rig = new Rig();
        rig.Bridge.ScanNowWait = TimeSpan.FromMilliseconds(200);
        rig.Bridge.ScanNowQueueWait = TimeSpan.FromMilliseconds(300);
        var gate = new TaskCompletionSource();
        var (a, second) = await SeriesRefreshHeld(rig, gate.Task);
        var b = await rig.Bridge.ScanNowAsync(rig.Instance("SonarrZ"), "/data/tv/Firefly (2002)/Season 03/E1.mkv", default);
        // The answer went back while the refresh before it still ran: not listed yet.
        Assert.Equal(("refreshed", false), (b.Outcome, b.Found));
        Assert.False((await a).Found);
        gate.SetResult();
        // Once it has run, the new season folder is refreshed in turn and the episode lists.
        await Until(() => rig.Library.FindByPath(second) != null && rig.Library.FindByPath("/media/tv/Firefly (2002)/Season 02/E1.mkv") != null);
        Assert.NotNull(rig.Library.FindByPath(second));
        Assert.NotNull(rig.Library.FindByPath("/media/tv/Firefly (2002)/Season 02/E1.mkv"));
        await Until(() => rig.Bridge.Recent().Any(r => r.JellyfinPath == second && r.Found));
        Assert.Contains(rig.Bridge.Recent(), r => r.JellyfinPath == second && r.Found);
    }

    [Fact]
    public async Task AnImportQueuedBehindARefreshThatOverranItsBudgetStillReachesJellyfin()
    {
        using var rig = new Rig();
        await rig.History(rig.Sonarr, "SonarrZ");
        // The batch gives up after the budget; the series refresh before it ignores cancellation.
        rig.Bridge.RefreshBudget = TimeSpan.FromMilliseconds(150);
        var gate = new TaskCompletionSource();
        var (a, second) = await SeriesRefreshHeld(rig, gate.Task);
        rig.Sonarr.History.Add(Rig.Import(9, rig.Arr.Now.UtcDateTime, "/data/tv/Firefly (2002)/Season 03/E1.mkv", season: 3, episode: 1));
        await rig.History(rig.Sonarr, "SonarrZ");
        await Until(() => rig.Bridge.Recent().Any(r => r.JellyfinPath == second));
        Assert.Null(rig.Library.FindByPath(second));
        await Task.Delay(300);
        gate.SetResult();
        await a;
        await Until(() => rig.Library.FindByPath(second) != null);
        Assert.NotNull(rig.Library.FindByPath(second));
    }

    [Fact]
    public async Task AnImportRefreshStillWaitingWhenTargetedRefreshIsSwitchedOffNeverRunsButScanNowDoes()
    {
        using var rig = new Rig();
        await rig.History(rig.Sonarr, "SonarrZ");
        var gate = new TaskCompletionSource();
        var (a, second) = await SeriesRefreshHeld(rig, gate.Task);
        // An import into the same series: its refresh waits behind the held Scan now.
        rig.Sonarr.History.Add(Rig.Import(9, rig.Arr.Now.UtcDateTime, "/data/tv/Firefly (2002)/Season 03/E1.mkv", season: 3, episode: 1));
        await rig.History(rig.Sonarr, "SonarrZ");
        await Task.Delay(200);
        Assert.Single(rig.Library.Refreshes);
        // The administrator switches targeted refresh off meanwhile (phase 2 stays on).
        rig.Arr.Plugin.Plugin.Configuration.ArrTargetedRefreshEnabled = false;
        gate.SetResult();
        // Scan now, an administrator's click, still goes the rest of its way (Season 02).
        Assert.True((await a).Found);
        await Until(() => rig.Bridge.Recent().Any(r => r.JellyfinPath == second));
        await Task.Delay(300);
        var skipped = Assert.Single(rig.Bridge.Recent(), r => r.JellyfinPath == second);
        Assert.Equal((JellyfinBridge.SwitchedOff, false), (skipped.Outcome, skipped.Found));
        // The series and Season 02 for Scan now; nothing for the import (no series refresh, no Season 03).
        Assert.Equal(2, rig.Library.Refreshes.Count);
        Assert.Null(rig.Library.FindByPath("/media/tv/Firefly (2002)/Season 03"));
        Assert.Null(rig.Library.FindByPath(second));
    }

    [Fact]
    public async Task TheBridgeWaitsForJellyfinsScanAndDoesNothingWithItsSwitchOff()
    {
        using var rig = new Rig();
        await rig.History(rig.Sonarr, "SonarrZ");
        var c = rig.Arr.Plugin.Plugin.Configuration;
        c.ArrTargetedRefreshEnabled = false;
        rig.Sonarr.History.Add(Rig.Import(7, rig.Arr.Now.UtcDateTime, "/data/tv/Firefly (2002)/Season 01/E7.mkv", episode: 7));
        await rig.History(rig.Sonarr, "SonarrZ");
        await Task.Delay(150);
        Assert.Empty(rig.Library.Refreshes);
        Assert.Empty(rig.Bridge.Recent());

        c.ArrTargetedRefreshEnabled = true;
        rig.Library.ScanRunning = true;
        var instance = rig.Instance("SonarrZ");
        await rig.Bridge.RunBatchAsync(new[] { new JellyfinBridge.Pending(instance, "/data/tv/Firefly (2002)/Season 01/E8.mkv", 0) });
        Assert.Empty(rig.Library.Refreshes);
        // After the last allowed wait it gives up (recorded), never refreshing during a scan.
        await rig.Bridge.RunBatchAsync(new[] { new JellyfinBridge.Pending(instance, "/data/tv/Firefly (2002)/Season 01/E9.mkv", 20) });
        Assert.Contains(rig.Bridge.Recent(), r => r.Outcome == "scan_running");
        Assert.Empty(rig.Library.Refreshes);
    }

    [Fact]
    public async Task RecentImportsJellyfinDoesntHaveAreListedWithWhy()
    {
        using var rig = new Rig();
        // This is the missing-list query, before any targeted refresh indexes the imports.
        rig.Arr.Plugin.Plugin.Configuration.ArrTargetedRefreshEnabled = false;
        var now = rig.Arr.Now.UtcDateTime;
        rig.Library.AddFile("/media/tv/Firefly (2002)/Season 01/E1.mkv", indexed: false);   // not scanned
        rig.Sonarr.History.Add(Rig.Import(1, now.AddMinutes(-20), "/data/tv/Firefly (2002)/Season 01/E1.mkv", episode: 1));
        rig.Sonarr.History.Add(Rig.Import(2, now.AddMinutes(-20), "/data/tv/Firefly (2002)/Season 01/E2.mkv", episode: 2));   // no file Jellyfin can see
        rig.Sonarr.History.Add(Rig.Import(3, now.AddMinutes(-20), "/srv/elsewhere/Firefly/E3.mkv", episode: 3));   // outside every library
        rig.Library.AddFile("/media/tv/Firefly (2002)/Season 01/E6.mkv", indexed: true);   // in Jellyfin: not listed
        rig.Sonarr.History.Add(Rig.Import(4, now.AddMinutes(-20), "/data/tv/Firefly (2002)/Season 01/E6.mkv", episode: 6));
        // Imported, then the file was deleted: the newest event decides, not listed.
        rig.Sonarr.History.Add(Rig.Import(5, now.AddMinutes(-30), "/data/tv/Firefly (2002)/Season 01/E9.mkv", episode: 9));
        var deleted = FakeArr.HistoryRow(6, "episodeFileDeleted", now.AddMinutes(-10), null, 1, "Firefly", 1, 9);
        deleted["episodeId"] = 105;
        rig.Sonarr.History.Add(deleted);
        // Imported (Jellyfin missed it), then a newer grab of an upgrade: the file is still the
        // imported one, so it stays listed.
        rig.Library.AddFile("/media/tv/Firefly (2002)/Season 01/E10.mkv", indexed: false);
        rig.Sonarr.History.Add(Rig.Import(7, now.AddMinutes(-40), "/data/tv/Firefly (2002)/Season 01/E10.mkv", episode: 10));
        var grabbed = FakeArr.HistoryRow(8, "grabbed", now.AddMinutes(-5), "dl8", 1, "Firefly", 1, 10);
        grabbed["episodeId"] = 107;
        rig.Sonarr.History.Add(grabbed);
        await rig.History(rig.Sonarr, "SonarrZ");

        var missing = rig.Bridge.NotInJellyfin();
        Assert.Equal(new[] { ("E1.mkv", "not_scanned"), ("E10.mkv", "not_scanned"), ("E2.mkv", "not_visible"), ("E3.mkv", "outside_library") },
            missing.Select(m => (Path.GetFileName(m.ArrPath), m.Problem)).OrderBy(x => x.Item1).ToArray());
        var first = missing.Single(m => m.Problem == "not_scanned" && m.Episode == 1);
        Assert.Equal(("tv:tvdb:100:s1:e1", "Shows"), (first.Key, first.Library));
        Assert.Equal("/media/tv/Firefly (2002)/Season 01/E1.mkv", first.JellyfinPath);
    }

    [Fact]
    public async Task ScanNowRefreshesTheFolderQueuesALibraryScanForATvRootAndRefusesOutsidePaths()
    {
        using var rig = new Rig();
        var sonarr = rig.Instance("SonarrZ");
        rig.Library.AddFile("/media/tv/Firefly (2002)/Season 01/E4.mkv", indexed: false);
        var refreshed = await rig.Bridge.ScanNowAsync(sonarr, "/data/tv/Firefly (2002)/Season 01/E4.mkv", default);
        Assert.Equal(("refreshed", true, "/media/tv/Firefly (2002)/Season 01"), (refreshed.Outcome, refreshed.Found, refreshed.Folder));
        // Asked again for a file Jellyfin has: its folder is refreshed anyway (repairs an item added
        // without metadata), and the answer waits for that refresh.
        var repaired = false;
        rig.Library.DuringRefresh = async _ =>
        {
            await Task.Delay(150);
            repaired = true;
        };
        var again = await rig.Bridge.ScanNowAsync(sonarr, "/data/tv/Firefly (2002)/Season 01/E4.mkv", default);
        Assert.True(repaired);
        rig.Library.DuringRefresh = null;
        Assert.Equal(("refreshed", true, "/media/tv/Firefly (2002)/Season 01"), (again.Outcome, again.Found, again.Folder));
        Assert.Contains("/media/tv/Firefly (2002)/Season 01/E4.mkv", rig.Library.Refreshes[1].Paths);

        var series = await rig.Bridge.ScanNowAsync(sonarr, "/data/tv/Spaced (1999)/Season 01/E1.mkv", default);
        Assert.Equal(("library", "Shows"), (series.Outcome, series.Library));
        Assert.Equal(rig.Library.Libs.Single(l => l.Name == "Shows").Id, Assert.Single(rig.Library.Scans));
        Assert.DoesNotContain(rig.Library.Refreshes, r => r.Folder == rig.Library.Items["/media/tv"].Id);

        var outside = await rig.Bridge.ScanNowAsync(sonarr, "/srv/elsewhere/E1.mkv", default);
        Assert.Equal(("refused", "outside_library"), (outside.Outcome, outside.Reason));
    }

    [Fact]
    public async Task AnItemCountsAsFoundWhenJellyfinIndexesItNotWhenItsMetadataIsDone()
    {
        using var rig = new Rig();
        var sonarr = rig.Instance("SonarrZ");
        const string file = "/media/tv/Firefly (2002)/Season 01/E4.mkv";
        rig.Library.AddFile(file, indexed: false);
        var release = new TaskCompletionSource();
        // Jellyfin indexes the file at once, then spends long on metadata inside the same call.
        rig.Library.DuringRefresh = async _ =>
        {
            rig.Library.Items[file] = new JfPathItem { Id = Guid.NewGuid(), Kind = "episode" };
            await release.Task;
        };
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var result = await rig.Bridge.ScanNowAsync(sonarr, "/data/tv/Firefly (2002)/Season 01/E4.mkv", default);
        Assert.True(result.Found);
        Assert.True(watch.ElapsedMilliseconds < 3000, $"{watch.ElapsedMilliseconds} ms");
        // A second refresh of the same folder waits for the running one (one at a time per folder).
        rig.Library.AddFile("/media/tv/Firefly (2002)/Season 01/E5.mkv", indexed: false);
        rig.Library.DuringRefresh = null;
        var second = rig.Bridge.ScanNowAsync(sonarr, "/data/tv/Firefly (2002)/Season 01/E5.mkv", default);
        await Task.Delay(150);
        Assert.Single(rig.Library.Refreshes);
        release.SetResult();
        Assert.True((await second).Found);
        Assert.Equal(2, rig.Library.Refreshes.Count);
    }

    [Fact]
    public async Task ThePathDoctorExplainsRootsAndSuggestsTheMappingTheTitlesShow()
    {
        using var rig = new Rig(mappings: false);
        rig.Radarr.RootFolders.Add(new JsonObject { ["path"] = "/data/movies", ["freeSpace"] = 100L, ["accessible"] = true });
        rig.Library.PathsByProvider["movie:tmdb:438631"] = "/media/movies/Dune (2021)/Dune (2021).mkv";
        var radarr = rig.Instance("RadarrZ");
        await rig.Store.GetSystemAsync(radarr, default);
        await rig.Store.GetLibraryAsync(radarr, default);

        var before = rig.Bridge.PathDoctor().Single(d => d.InstanceId == radarr.Id);
        Assert.Equal("problem", before.Verdict);
        var root = Assert.Single(before.Roots);
        Assert.Equal(("/data/movies", false, "not_visible"), (root.JellyfinPath, root.Mapped, root.Problem));
        var sample = Assert.Single(before.Samples);
        Assert.Equal(("/data/movies/Dune (2021)", "/media/movies/Dune (2021)", false), (sample.Expected, sample.Actual, sample.Match));
        Assert.Equal(("/data", "/media"), (before.Suggestion!.ArrPath, before.Suggestion.JellyfinPath));

        var c = rig.Arr.Plugin.Plugin.Configuration;
        c.RadarrInstances = Rig.WithMapping(c.RadarrInstances, "/data/movies", "/media/movies");
        var after = rig.Bridge.PathDoctor().Single(d => d.InstanceId == radarr.Id);
        Assert.Equal("ok", after.Verdict);
        Assert.Equal(("/media/movies", true, "Movies", (string?)null), (after.Roots[0].JellyfinPath, after.Roots[0].Mapped, after.Roots[0].Library, after.Roots[0].Problem));
        Assert.True(Assert.Single(after.Samples).Match);
        Assert.Null(after.Suggestion);
    }

    [Fact]
    public async Task ThePathDoctorSaysPathsMatchWhenTheRootFoldersDoBeforeAnyTitleCanBeCompared()
    {
        using var rig = new Rig();
        rig.Sonarr.RootFolders.Add(new JsonObject { ["path"] = "/data/tv", ["freeSpace"] = 100L, ["accessible"] = true });
        var sonarr = rig.Instance("SonarrZ");
        await rig.Store.GetSystemAsync(sonarr, default);
        await rig.Store.GetLibraryAsync(sonarr, default);
        var doctor = rig.Bridge.PathDoctor().Single(d => d.InstanceId == sonarr.Id);
        Assert.Empty(doctor.Samples);
        Assert.Null(Assert.Single(doctor.Roots).Problem);
        Assert.Equal("ok", doctor.Verdict);
        // Nothing read yet (no root folders, no titles): nothing to compare.
        Assert.Equal("unknown", rig.Bridge.PathDoctor().Single(d => d.InstanceId == rig.Instance("RadarrZ").Id).Verdict);
    }

    [Fact]
    public async Task TitlesWithFilesJellyfinDoesntListAtAllAreCountedPerInstance()
    {
        using var rig = new Rig();
        rig.Radarr.Movies.Add(FakeArr.Movie(2, 45745, "Sintel", path: "/data/movies/Sintel (2010)"));
        rig.Radarr.Movies.Add(FakeArr.Movie(3, 999, "Not Downloaded", hasFile: false));
        rig.Library.MovieIds.Add("tmdb:45745");
        var radarr = rig.Instance("RadarrZ");
        await rig.Store.GetLibraryAsync(radarr, default);
        var titles = rig.Bridge.MissingTitles();
        var dune = Assert.Single(titles.Titles);
        Assert.Equal(("Dune", "/media/movies/Dune (2021)", "not_visible"), (dune.Title, dune.JellyfinPath, dune.Problem));
        Assert.Equal(1, titles.Counts[radarr.Id]);
    }

    [Fact]
    public async Task AQuickFollowUpThatEndedDoesNotFreeTheGuardOfTheNewerOneStillRunning()
    {
        // The first follow-up of a folder ends at once; the next one waits. The first caller looks at
        // its work only after it ended and the next one started: it must not free the next one's
        // guard, or a third would run beside it.
        using var rig = new Rig();
        var sonarr = rig.Instance("SonarrZ");
        var gate = new TaskCompletionSource();
        var waits = 0;
        using var bridge = new JellyfinBridge(rig.Store, rig.Library, null, () => rig.Arr.Plugin.Plugin.Configuration, () => rig.Arr.Now, (_, ct) => Interlocked.Increment(ref waits) == 1 ? Task.CompletedTask : gate.Task.WaitAsync(ct));
        const string folder = "/media/tv/Spaced (1999)";
        var interleaved = false;
        bridge.AfterStart = first =>
        {
            if (interleaved) return;
            interleaved = true;
            Assert.True(first.Wait(TimeSpan.FromSeconds(10)));
            bridge.FollowUpNewFolder(sonarr, "/data/tv/Spaced (1999)/S01E01.mkv", folder);
        };
        bridge.FollowUpNewFolder(sonarr, "/data/tv/Spaced (1999)/S01E01.mkv", folder);
        bridge.AfterStart = null;
        await Until(() => Volatile.Read(ref waits) == 2);
        Assert.Equal(1, bridge.WorkInFlight);
        // The second is still running: a third is refused.
        bridge.FollowUpNewFolder(sonarr, "/data/tv/Spaced (1999)/S01E02.mkv", folder);
        await Task.Delay(200);
        Assert.Equal(2, Volatile.Read(ref waits));
        Assert.Equal(1, bridge.WorkInFlight);
        gate.SetResult();
        await Until(() => bridge.WorkInFlight == 0);
        // Ended: the next one runs.
        bridge.FollowUpNewFolder(sonarr, "/data/tv/Spaced (1999)/S01E03.mkv", folder);
        await Until(() => Volatile.Read(ref waits) == 3);
        Assert.Equal(3, Volatile.Read(ref waits));
        // Stopped: refused, and its guard is freed (nothing runs to free it).
        await bridge.StopAsync(default);
        bridge.FollowUpNewFolder(sonarr, "/data/tv/Spaced (1999)/S01E04.mkv", folder);
        Assert.Equal(0, bridge.FollowUpsHeld);
    }

    [Fact]
    public async Task StoppingCancelsAndWaitsForTheRefreshInFlightAndQueuesNothingAfterwards()
    {
        using var rig = new Rig();
        var sonarr = rig.Instance("SonarrZ");
        rig.Library.AddFile("/media/tv/Firefly (2002)/Season 01/E4.mkv", indexed: false);
        rig.Library.AddFile("/media/tv/Firefly (2002)/Season 01/E5.mkv", indexed: false);
        var entered = new TaskCompletionSource();
        var release = new TaskCompletionSource();
        rig.Library.DuringRefresh = async _ =>
        {
            entered.TrySetResult();
            await release.Task;
        };
        rig.Bridge.Enqueue(sonarr, "/data/tv/Firefly (2002)/Season 01/E4.mkv", 0);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.True(rig.Bridge.WorkInFlight > 0);
        using var patience = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var stop = rig.Bridge.StopAsync(patience.Token);
        await Task.Delay(300);
        Assert.False(stop.IsCompleted);
        release.SetResult();
        await stop.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.True(rig.Bridge.Stopped);
        // Nothing new after the stop: an import seen now is not queued.
        rig.Library.DuringRefresh = null;
        var refreshes = rig.Library.Refreshes.Count;
        rig.Bridge.Enqueue(sonarr, "/data/tv/Firefly (2002)/Season 01/E5.mkv", 0);
        await Task.Delay(300);
        Assert.Equal(refreshes, rig.Library.Refreshes.Count);
        Assert.Equal(0, rig.Bridge.WorkInFlight);
        rig.Bridge.Dispose();
        rig.Bridge.Dispose();
    }
}
