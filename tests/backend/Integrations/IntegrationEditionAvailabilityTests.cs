using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace JE.Tests;

/// <summary>
/// Edition availability (D44): one source-level answer to "does the viewer have edition E of this scope". A 4K
/// request is Ready only with an accessible, playable 4K SOURCE (a media source or an item with 4K dimensions), never
/// because a 4K arr owns the title or shares a folder or library with the standard copy; a standard request takes
/// any playable copy, or only a non-4K one with the administrator's switch. Judged per media source and per item,
/// across every copy the viewer can open (separate libraries, the folders automatic series grouping presents as one
/// show, each episode by its own sources), honouring the copy a page is pinned to. The table runs scope × edition ×
/// layout against Jellyfin fakes that hold versions the way the build's Jellyfin does (12.x: an episode's second file
/// is a version of one item; 10.11: a second episode item).
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEditionAvailabilityTests
{
    private static readonly TitleKey Sintel = TitleKey.Parse("movie:tmdb:45745")!;
    private static readonly TitleKey Firefly = TitleKey.Parse("tv:tvdb:78874")!;

    /// <summary>How the copies of a title sit in Jellyfin and the arrs.</summary>
    public enum Layout
    {
        /// <summary>One item (movie, or one series folder) holding every version as its media sources.</summary>
        OneItem,

        /// <summary>A standard library and a 4K library, one copy in each.</summary>
        SeparateLibraries,

        /// <summary>Two folders of one series in one library, which Jellyfin's automatic grouping shows as one show.</summary>
        GroupedFolders,

        /// <summary>The 4K arr and the standard arr share the title's folder (one item), and the 4K arr says it has a file.</summary>
        SharedFolder4kArr,

        /// <summary>No 4K arr in Jellyfin Enhanced; Seerr says the 4K copy is available and names the item.</summary>
        NoFourKArrSeerr,
    }

    /// <summary>What Jellyfin has.</summary>
    public enum Has
    {
        /// <summary>Only a 1080p version.</summary>
        Hd,

        /// <summary>Only a 2160p version.</summary>
        Uhd,

        /// <summary>Both.</summary>
        Both,
    }

    /// <summary>The part asked for.</summary>
    public enum Part
    {
        /// <summary>The movie.</summary>
        Movie,

        /// <summary>Season 1 (E1 and E2).</summary>
        Season,

        /// <summary>S1E2 on its own.</summary>
        Episode,

        /// <summary>S1E2 on its own, which Jellyfin has as one S01E01-E02 file.</summary>
        MultiEpisode,
    }

    private const int HdWidth = 1920;
    private const int HdHeight = 1080;
    private const int UhdWidth = 3840;
    private const int UhdHeight = 2160;

    /// <summary>A Jellyfin + Radarr/Sonarr (standard and 4K) rig laid out one way.</summary>
    internal sealed class Rig : IDisposable
    {
        public FakeArr Arr { get; } = new();
        public FakeArr.Host Radarr { get; }
        public FakeArr.Host? Radarr4k { get; }
        public FakeArr.Host Sonarr { get; }
        public FakeArr.Host? Sonarr4k { get; }
        public ArrStateStore Store { get; }
        public FakeJellyfinView View { get; } = new();
        public ArrStatusService Service { get; }
        public StatusViewer Admin { get; }
        public StatusViewer Member { get; }
        public Layout Layout { get; }
        public DateTime Now => Arr.Now.UtcDateTime;

        /// <summary>The standard copy's item (movie) or series item; with one item, the only one.</summary>
        public Guid HdCopy { get; } = Guid.NewGuid();

        /// <summary>The 4K copy's item (movie) or series item; with one item, the same as <see cref="HdCopy"/>.</summary>
        public Guid UhdCopy { get; }

        public Rig(Layout layout, Has has, bool movie, bool multiEpisode = false)
        {
            Layout = layout;
            UhdCopy = layout is Layout.SeparateLibraries or Layout.GroupedFolders ? Guid.NewGuid() : HdCopy;
            var fourK = layout != Layout.NoFourKArrSeerr;
            Radarr = Arr.Add("radarr.lan", "Radarr");
            Sonarr = Arr.Add("sonarr.lan", "Sonarr");
            var rows = new List<(string, ArrKind, string, string)>
            {
                ("RadarrZ", ArrKind.Radarr, "http://radarr.lan:7878", "RADARR-KEY-0123456789"),
                ("SonarrZ", ArrKind.Sonarr, "http://sonarr.lan:8989", "SONARR-KEY-0123456789"),
            };
            if (fourK)
            {
                Radarr4k = Arr.Add("radarr4k.lan", "Radarr");
                Sonarr4k = Arr.Add("sonarr4k.lan", "Sonarr");
                rows.Add(("Radarr4kZ", ArrKind.Radarr, "http://radarr4k.lan:7878", "RADARR4K-KEY-0123456789"));
                rows.Add(("Sonarr4kZ", ArrKind.Sonarr, "http://sonarr4k.lan:8989", "SONARR4K-KEY-0123456789"));
            }
            Arr.Configure(rows.ToArray());
            var c = Arr.Plugin.Plugin.Configuration;
            c.RadarrInstances = WithRole(c.RadarrInstances, "Radarr4kZ");
            c.SonarrInstances = WithRole(c.SonarrInstances, "Sonarr4kZ");
            c.ArrIntegrationEnabled = true;
            c.ArrPhase1Enabled = true;
            c.ArrStandardNeedsNonFourK = false;

            var hd = has is Has.Hd or Has.Both;
            var uhd = has is Has.Uhd or Has.Both;
            var shared = layout == Layout.SharedFolder4kArr;
            // The arrs: the standard one has a file when Jellyfin has the HD version; the 4K one when it has the 4K
            // version, or always when it shares the folder (it owns the title, and the HD file sits there).
            Radarr.Movies.Add(FakeArr.Movie(1, 45745, "Sintel", hasFile: hd, path: "/data/movies/Sintel (2010)"));
            Radarr4k?.Movies.Add(FakeArr.Movie(1, 45745, "Sintel", hasFile: uhd || shared, path: shared ? "/data/movies/Sintel (2010)" : "/data/movies4k/Sintel (2010)"));
            Sonarr.Series.Add(Series("/data/tv/Firefly"));
            Sonarr4k?.Series.Add(Series(shared ? "/data/tv/Firefly" : "/data/tv4k/Firefly"));
            for (var e = 1; e <= 2; e++)
            {
                Sonarr.Episodes.Add(Episode(100 + e, 1, e, hd));
                Sonarr4k?.Episodes.Add(Episode(100 + e, 1, e, uhd || shared));
            }

            Store = Arr.Store();
            Service = new ArrStatusService(Store, View, new NoRequestFacts(), () => Arr.Plugin.Plugin.Configuration, () => Arr.Now);
            Admin = View.AddUser(admin: true, policy: "same");
            Member = View.AddUser(admin: false, policy: "same");

            if (movie) FillMovie(hd, uhd);
            else FillSeries(hd, uhd, multiEpisode);
        }

        /// <summary>The 4K instance's role, and every instance's path mapping (the arrs' /data is Jellyfin's /media), as on the rig.</summary>
        private static string WithRole(string json, string name)
        {
            var rows = JsonNode.Parse(json)!.AsArray();
            foreach (var row in rows)
            {
                if ((string?)row!["Name"] == name) row["Role"] = "4k";
                row["PathMappings"] = new JsonArray(new JsonObject { ["ArrPath"] = "/data", ["JellyfinPath"] = "/media" });
            }
            return rows.ToJsonString();
        }

        private static JsonObject Series(string path)
        {
            var series = FakeArr.SeriesRow(1, 78874, "Firefly");
            series["path"] = path;
            series["seasons"] = new JsonArray(new JsonObject { ["seasonNumber"] = 1, ["monitored"] = true });
            return series;
        }

        private static JsonObject Episode(int id, int season, int number, bool hasFile)
            => new() { ["id"] = id, ["seriesId"] = 1, ["seasonNumber"] = season, ["episodeNumber"] = number, ["airDateUtc"] = $"2002-09-2{number}T00:00:00Z", ["hasFile"] = hasFile, ["monitored"] = true };

        private void FillMovie(bool hd, bool uhd)
        {
            if (Layout == Layout.SeparateLibraries)
            {
                if (hd) MovieCopy(HdCopy, "/media/movies/Sintel (2010)/Sintel (2010) - 1080p.mkv", "Movies", (HdWidth, HdHeight));
                if (uhd) MovieCopy(UhdCopy, "/media/movies4k/Sintel (2010)/Sintel (2010) - 2160p.mkv", "Movies 4K", (UhdWidth, UhdHeight));
                return;
            }
            // One item: Jellyfin keeps every file of the folder as a version of one movie.
            var versions = new List<(int, int)>();
            if (uhd) versions.Add((UhdWidth, UhdHeight));
            if (hd) versions.Add((HdWidth, HdHeight));
            MovieCopy(HdCopy, "/media/movies/Sintel (2010)/Sintel (2010) - " + (uhd ? "2160p" : "1080p") + ".mkv", "Movies", versions.ToArray());
        }

        public void MovieCopy(Guid id, string path, string library, params (int Width, int Height)[] versions)
        {
            View.AddItem(new JfItemRef { ItemId = id, Kind = "movie", Key = Sintel, Path = path, LibraryId = library, LibraryName = library, DateCreated = Now.AddDays(-1), Versions = versions.Length });
            View.AddCopy(Sintel, new JfCopy { ItemId = id, Path = path, LibraryId = library, LibraryName = library, DateCreated = Now.AddDays(-1) });
            foreach (var (w, h) in versions) View.AddSource(id, w, h, path, Now.AddDays(-1));
        }

        private void FillSeries(bool hd, bool uhd, bool multiEpisode)
        {
            var separate = Layout is Layout.SeparateLibraries or Layout.GroupedFolders;
            SeriesCopy(HdCopy, "/media/tv/Firefly", "TV");
            if (separate) SeriesCopy(UhdCopy, "/media/tv4k/Firefly", Layout == Layout.GroupedFolders ? "TV" : "TV 4K");
            if (Layout == Layout.GroupedFolders) View.GroupSeries(HdCopy, UhdCopy);
            foreach (var (on, copy, w, h) in new[] { (hd, HdCopy, HdWidth, HdHeight), (uhd, UhdCopy, UhdWidth, UhdHeight) })
            {
                if (!on) continue;
                if (multiEpisode) View.AddEpisodeFile(copy, Firefly, 1, 1, w, h, Now.AddDays(-1), episodeEnd: 2);
                else for (var e = 1; e <= 2; e++) View.AddEpisodeFile(copy, Firefly, 1, e, w, h, Now.AddDays(-1));
            }
        }

        public void SeriesCopy(Guid id, string path, string library)
        {
            View.AddItem(new JfItemRef { ItemId = id, Kind = "series", Key = Firefly, Path = path });
            View.AddCopy(Firefly, new JfCopy { ItemId = id, Path = path, LibraryId = library, LibraryName = library });
            View.AddSeason(id, new JfSeason { ItemId = Guid.NewGuid(), Season = 1 });
        }

        /// <summary>The request status of a part asked for (as the Requests page and fulfilment judge it).</summary>
        public async Task<ArrStatusService.KeyedStatus> Requested(Part part, bool fourK, StatusViewer? viewer = null)
        {
            var key = part == Part.Movie ? Sintel : Firefly;
            var seerr = Layout == Layout.NoFourKArrSeerr && fourK;
            var scope = new ArrStatusService.RequestScope(
                part == Part.Season ? new[] { 1 } : Array.Empty<int>(),
                fourK,
                null,
                Available: seerr,
                AvailableAt: seerr ? Now.AddHours(-1) : null,
                JellyfinItemId: seerr ? HdCopy : null,
                Episodes: part is Part.Episode or Part.MultiEpisode ? new[] { (1, 2) } : null);
            var scopes = new Dictionary<TitleKey, ArrStatusService.RequestScope> { [key] = scope };
            var who = viewer ?? Member;
            await Service.ComposeForAsync(who, new[] { key }, scopes, default, loadEpisodes: true);
            await Task.Delay(20);
            var composed = await Service.ComposeForAsync(who, new[] { key }, scopes, default, loadEpisodes: true);
            return Assert.Single(composed);
        }

        public void Dispose() => Arr.Dispose();
    }

    // ------------------------------------------------------------------ the table: scope × edition × layout

    public static TheoryData<Layout, Part, Has> Table()
    {
        var data = new TheoryData<Layout, Part, Has>();
        foreach (var layout in Enum.GetValues<Layout>())
        {
            foreach (var part in Enum.GetValues<Part>())
            {
                // Movies don't group.
                if (part == Part.Movie && layout == Layout.GroupedFolders) continue;
                foreach (var has in Enum.GetValues<Has>()) data.Add(layout, part, has);
            }
        }
        return data;
    }

    [Theory]
    [MemberData(nameof(Table))]
    public async Task EachEditionIsReadyExactlyWhenAPlayableSourceOfItIsThere(Layout layout, Part part, Has has)
    {
        using var rig = new Rig(layout, has, movie: part == Part.Movie, multiEpisode: part == Part.MultiEpisode);
        var hd = has is Has.Hd or Has.Both;
        var uhd = has is Has.Uhd or Has.Both;
        var where = $"{layout}/{part}/{has} (episode versions on one item: {FakeJellyfinView.EpisodeVersionsOnOneItem})";

        // 4K: only a 4K source. Never the 4K arr's word, a shared folder or library, or Seerr's "available".
        var fourK = await rig.Requested(part, fourK: true);
        Assert.True(uhd == (fourK.Status.Stage == StatusStage.Ready), $"4K {where}: {fourK.Status.Stage}/{fourK.Status.Reason.Code}");
        if (uhd)
        {
            // Play opens the copy with the 4K source, never the standard one.
            Assert.Equal(rig.UhdCopy, fourK.Visible?.ItemId);
            Assert.NotNull(fourK.ArrivedAt);
            Assert.False(fourK.Guessed, where);
        }

        // Standard (the default): any playable copy, a 4K one included.
        var standard = await rig.Requested(part, fourK: false);
        Assert.True(standard.Status.Stage == StatusStage.Ready, $"standard {where}: {standard.Status.Stage}/{standard.Status.Reason.Code}");

        // Standard with "Standard requests need a non-4K copy": only a source known not to be 4K.
        rig.Arr.Plugin.Plugin.Configuration.ArrStandardNeedsNonFourK = true;
        var nonFourK = await rig.Requested(part, fourK: false);
        Assert.True(hd == (nonFourK.Status.Stage == StatusStage.Ready), $"standard (non-4K) {where}: {nonFourK.Status.Stage}/{nonFourK.Status.Reason.Code}");
        if (hd) Assert.Equal(rig.HdCopy, nonFourK.Visible?.ItemId);
        rig.Arr.Plugin.Plugin.Configuration.ArrStandardNeedsNonFourK = false;

        // The service's own answer agrees, for the scope and across the copies.
        var editions = rig.Service.Editions;
        var scope = part == Part.Movie ? Sintel : part == Part.Season ? Firefly.WithSeason(1) : Firefly.WithEpisode(1, 2);
        Assert.Equal(uhd, editions.Available(rig.Member, scope, Edition.FourK));
        Assert.True(editions.Available(rig.Member, scope, Edition.Standard), where);
        if (part != Part.Movie)
        {
            Assert.Equal(uhd, editions.AvailableRange(rig.Member, Firefly, 1, 1, 2, Edition.FourK));
            Assert.Equal(hd || uhd, editions.AvailableRange(rig.Member, Firefly, 1, 1, 2, Edition.Standard));
        }
    }

    // ------------------------------------------------------------------ S1: 4K Ready only with a 4K source

    [Fact]
    public async Task AFourKRequestForAnHdOnlyTitleIsNotReadyUntilA4kVersionJoinsTheSameItem()
    {
        // Radarr and Radarr 4K share the movie folder; Radarr 4K says it has a file (it owns the title), but Jellyfin
        // has only the 1080p file. Before: "4K Ready" (the HD item matched the 4K arr by folder).
        using var rig = new Rig(Layout.SharedFolder4kArr, Has.Hd, movie: true);
        var before = await rig.Requested(Part.Movie, fourK: true);
        Assert.NotEqual(StatusStage.Ready, before.Status.Stage);
        Assert.Null(before.Visible);
        Assert.Null(before.ArrivedAt);

        // The 2160p file lands in the same folder: Jellyfin adds it as a version of the same movie.
        var arrived = rig.Now.AddMinutes(-5);
        rig.View.AddSource(rig.HdCopy, UhdWidth, UhdHeight, "/media/movies/Sintel (2010)/Sintel (2010) - 2160p.mkv", arrived);
        var after = await rig.Requested(Part.Movie, fourK: true);
        Assert.Equal(StatusStage.Ready, after.Status.Stage);
        Assert.Equal(rig.HdCopy, after.Visible?.ItemId);
        Assert.Equal(arrived, after.ArrivedAt);
    }

    [Fact]
    public async Task WithNo4kArrAFourKRequestReadsTheLocal4kSourcesNotOnlySeerr()
    {
        // No 4K Radarr in Jellyfin Enhanced. Seerr hasn't said the 4K copy is available, but a 4K copy is in Movies 4K.
        using var rig = new Rig(Layout.NoFourKArrSeerr, Has.Hd, movie: true);
        var uhd = Guid.NewGuid();
        rig.MovieCopy(uhd, "/media/movies4k/Sintel (2010)/Sintel.mkv", "Movies 4K", (UhdWidth, UhdHeight));
        var scope = new ArrStatusService.RequestScope(Array.Empty<int>(), true, null);
        var composed = Assert.Single(await rig.Service.ComposeForAsync(rig.Member, new[] { Sintel }, new Dictionary<TitleKey, ArrStatusService.RequestScope> { [Sintel] = scope }, default));
        Assert.Equal((StatusStage.Ready, (Guid?)uhd), (composed.Status.Stage, composed.Visible?.ItemId));

        // Seerr saying "available" for an item that holds no 4K source is not enough.
        rig.View.Items.Remove(uhd);
        rig.View.CopiesByKey[Sintel.ToString()].RemoveAll(c => c.Copy.ItemId == uhd);
        rig.View.Rev++;
        var seerr = scope with { Available = true, AvailableAt = rig.Now, JellyfinItemId = rig.HdCopy };
        composed = Assert.Single(await rig.Service.ComposeForAsync(rig.Member, new[] { Sintel }, new Dictionary<TitleKey, ArrStatusService.RequestScope> { [Sintel] = seerr }, default));
        Assert.NotEqual(StatusStage.Ready, composed.Status.Stage);
        Assert.Null(composed.Visible);
    }

    [Fact]
    public async Task AFourKSourceInALibraryTheViewerCantOpenIsNotTheirs()
    {
        using var rig = new Rig(Layout.SeparateLibraries, Has.Hd, movie: true);
        var uhd = Guid.NewGuid();
        rig.View.AddItem(new JfItemRef { ItemId = uhd, Kind = "movie", Key = Sintel, Path = "/media/private/Sintel.mkv" }, rig.Admin.UserId);
        rig.View.AddCopy(Sintel, new JfCopy { ItemId = uhd, Path = "/media/private/Sintel.mkv", LibraryName = "Private" }, rig.Admin.UserId);
        rig.View.AddSource(uhd, UhdWidth, UhdHeight);
        Assert.False(rig.Service.Editions.Available(rig.Member, Sintel, Edition.FourK));
        Assert.True(rig.Service.Editions.Available(rig.Admin, Sintel, Edition.FourK));
        Assert.NotEqual(StatusStage.Ready, (await rig.Requested(Part.Movie, fourK: true)).Status.Stage);
    }

    [Fact]
    public void AFileJellyfinHasntReadYetIsPlayableButNeitherEditionInParticular()
    {
        using var rig = new Rig(Layout.OneItem, Has.Hd, movie: true);
        var unread = new JfSource { SourceId = Guid.NewGuid(), ItemId = rig.HdCopy };
        var editions = rig.Service.Editions;
        Assert.True(editions.Qualifies(unread, Edition.Standard));
        Assert.False(editions.Qualifies(unread, Edition.FourK));
        rig.Arr.Plugin.Plugin.Configuration.ArrStandardNeedsNonFourK = true;
        Assert.False(editions.Qualifies(unread, Edition.Standard));
        // 4K by width (UHD, DCI, cropped scope) or by height; 1440p is not.
        Assert.True(EditionAvailability.IsFourK(3840, 1600));
        Assert.True(EditionAvailability.IsFourK(4096, 1716));
        Assert.True(EditionAvailability.IsFourK(null, 2160));
        Assert.False(EditionAvailability.IsFourK(2560, 1440));
        Assert.False(EditionAvailability.IsFourK(null, null));
    }

    // ------------------------------------------------------------------ S4: grouped series

    [Fact]
    public async Task InAGroupedSeriesTheHdFoldersEpisodesNeverSatisfyAFourKRequest()
    {
        // Firefly in two folders of one library (grouped: Jellyfin lists both folders' episodes for either). Only the
        // standard folder has S1. A 4K request for S1 stays open until the 4K folder has its own 4K episodes.
        using var rig = new Rig(Layout.GroupedFolders, Has.Hd, movie: false);
        var before = await rig.Requested(Part.Season, fourK: true);
        Assert.NotEqual(StatusStage.Ready, before.Status.Stage);
        Assert.Null(before.ArrivedAt);

        rig.View.AddEpisodeFile(rig.UhdCopy, Firefly, 1, 1, UhdWidth, UhdHeight, rig.Now);
        Assert.NotEqual(StatusStage.Ready, (await rig.Requested(Part.Season, fourK: true)).Status.Stage);
        rig.View.AddEpisodeFile(rig.UhdCopy, Firefly, 1, 2, UhdWidth, UhdHeight, rig.Now);
        var after = await rig.Requested(Part.Season, fourK: true);
        Assert.Equal((StatusStage.Ready, (Guid?)rig.UhdCopy), (after.Status.Stage, after.Visible?.ItemId));
    }

    // ------------------------------------------------------------------ D44 switch on the standard edition

    [Fact]
    public async Task AFourKOnlyArrivalSatisfiesAStandardRequestUnlessTheSwitchSaysOtherwise()
    {
        using var rig = new Rig(Layout.OneItem, Has.Uhd, movie: true);
        Assert.Equal(StatusStage.Ready, (await rig.Requested(Part.Movie, fourK: false)).Status.Stage);
        rig.Arr.Plugin.Plugin.Configuration.ArrStandardNeedsNonFourK = true;
        var held = await rig.Requested(Part.Movie, fourK: false);
        Assert.NotEqual(StatusStage.Ready, held.Status.Stage);
        Assert.Null(held.Visible);
        // A 1080p version joins: Ready again.
        rig.View.AddSource(rig.HdCopy, HdWidth, HdHeight);
        Assert.Equal(StatusStage.Ready, (await rig.Requested(Part.Movie, fourK: false)).Status.Stage);
    }

    // ------------------------------------------------------------------ S3: arr facts of the page's own copy

    [Fact]
    public async Task AFourKCopysEpisodePageReadsTheFourKSonarrNotTheStandardOne()
    {
        // TV and TV 4K. The standard Sonarr has S1E3 (a file, and a download of a better E1); the 4K Sonarr has neither.
        using var rig = new Rig(Layout.SeparateLibraries, Has.Uhd, movie: false);
        rig.Sonarr.Episodes.Add(new JsonObject { ["id"] = 103, ["seriesId"] = 1, ["seasonNumber"] = 1, ["episodeNumber"] = 3, ["airDateUtc"] = "2002-09-23T00:00:00Z", ["hasFile"] = true, ["monitored"] = true });
        rig.Sonarr4k!.Episodes.Add(new JsonObject { ["id"] = 103, ["seriesId"] = 1, ["seasonNumber"] = 1, ["episodeNumber"] = 3, ["airDateUtc"] = "2002-09-23T00:00:00Z", ["hasFile"] = false, ["monitored"] = true });
        var row = FakeArr.SonarrQueueRow(101, "dl101", 1, 1, "Firefly", 78874);
        rig.Sonarr.Queue.Add(row);
        var missing = Guid.NewGuid();
        rig.View.AddItem(new JfItemRef { ItemId = missing, Kind = "episode", Key = Firefly.WithEpisode(1, 3), SeriesId = rig.UhdCopy, Season = 1, Episode = 3, Virtual = true });
        rig.View.AddEpisode(rig.UhdCopy, new JfEpisode { ItemId = missing, Season = 1, Episode = 3, Virtual = true });
        var e1 = rig.View.EpisodesBySeries[rig.UhdCopy].First(e => e.Episode.Episode == 1 && !e.Episode.Virtual).Episode.ItemId;

        await Item(rig, rig.Member, missing);
        await Task.Delay(20);
        var page = Items(await Item(rig, rig.Member, missing))[0];
        // Not "Almost ready" from the standard Sonarr's file: the 4K Sonarr has nothing for it.
        Assert.NotEqual(StatusStage.AlmostReady, page.GetProperty("stage").GetString());
        Assert.NotEqual(StatusStage.Ready, page.GetProperty("stage").GetString());
        // Not "Upgrading" from the standard Sonarr's download of E1.
        var ready = Items(await Item(rig, rig.Member, e1))[0];
        Assert.Equal((StatusStage.Ready, StatusReasonCode.Ready), (ready.GetProperty("stage").GetString(), ready.GetProperty("reason").GetProperty("code").GetString()));
        // The standard copy's own page still reads the standard Sonarr.
        var standardMissing = Guid.NewGuid();
        rig.View.AddItem(new JfItemRef { ItemId = standardMissing, Kind = "episode", Key = Firefly.WithEpisode(1, 3), SeriesId = rig.HdCopy, Season = 1, Episode = 3, Virtual = true });
        rig.View.AddEpisode(rig.HdCopy, new JfEpisode { ItemId = standardMissing, Season = 1, Episode = 3, Virtual = true });
        rig.View.Rev++;
        Assert.Equal(StatusStage.AlmostReady, Items(await Item(rig, rig.Member, standardMissing))[0].GetProperty("stage").GetString());
    }

    // ------------------------------------------------------------------ N1: an unpinned page searches every copy

    [Fact]
    public void AnUnpinnedScopeFindsTheEpisodeInWhicheverCopyHasItAndAPinnedOneKeepsItsCopy()
    {
        // Firefly in TV (no S1E5 at all) and TV 4K (S1E5 with a file); Jellyfin lists the TV copy first.
        using var rig = new Rig(Layout.SeparateLibraries, Has.Hd, movie: false);
        var e5 = rig.View.AddEpisodeFile(rig.UhdCopy, Firefly, 1, 5, UhdWidth, UhdHeight);
        Assert.Equal(e5, rig.Service.ScopeItem(rig.Member, Firefly.WithEpisode(1, 5))?.ItemId);
        Assert.Null(rig.Service.ScopeItem(rig.Member, Firefly.WithEpisode(1, 5), rig.HdCopy));
        // A missing episode in the first copy and the file in the second: the file.
        var virtualE6 = Guid.NewGuid();
        rig.View.AddItem(new JfItemRef { ItemId = virtualE6, Kind = "episode", Key = Firefly.WithEpisode(1, 6), SeriesId = rig.HdCopy, Season = 1, Episode = 6, Virtual = true });
        rig.View.AddEpisode(rig.HdCopy, new JfEpisode { ItemId = virtualE6, Season = 1, Episode = 6, Virtual = true });
        var e6 = rig.View.AddEpisodeFile(rig.UhdCopy, Firefly, 1, 6, UhdWidth, UhdHeight);
        Assert.Equal(e6, rig.Service.ScopeItem(rig.Member, Firefly.WithEpisode(1, 6))?.ItemId);
        Assert.Equal(virtualE6, rig.Service.ScopeItem(rig.Member, Firefly.WithEpisode(1, 6), rig.HdCopy)?.ItemId);
        // Only a missing one anywhere: that one.
        var virtualE7 = Guid.NewGuid();
        rig.View.AddItem(new JfItemRef { ItemId = virtualE7, Kind = "episode", Key = Firefly.WithEpisode(1, 7), SeriesId = rig.UhdCopy, Season = 1, Episode = 7, Virtual = true });
        rig.View.AddEpisode(rig.UhdCopy, new JfEpisode { ItemId = virtualE7, Season = 1, Episode = 7, Virtual = true });
        Assert.Equal(virtualE7, rig.Service.ScopeItem(rig.Member, Firefly.WithEpisode(1, 7))?.ItemId);
    }

    // ------------------------------------------------------------------ R1: Get 4K with a 4K copy elsewhere

    [Fact]
    public async Task AMoviePageSaysWhenA4kCopyTheViewerCanOpenIsAlreadyElsewhere()
    {
        using var rig = new Rig(Layout.SeparateLibraries, Has.Hd, movie: true);
        var page = Items(await Item(rig, rig.Member, rig.HdCopy))[0];
        Assert.False(page.TryGetProperty("fourK", out _), "no 4K copy anywhere: Get 4K stays");
        // A 4K copy in a library only the admin can open: still nothing for the member.
        var hidden = Guid.NewGuid();
        rig.View.AddItem(new JfItemRef { ItemId = hidden, Kind = "movie", Key = Sintel, Path = "/media/private/Sintel.mkv" }, rig.Admin.UserId);
        rig.View.AddCopy(Sintel, new JfCopy { ItemId = hidden, Path = "/media/private/Sintel.mkv", LibraryName = "Private" }, rig.Admin.UserId);
        rig.View.AddSource(hidden, UhdWidth, UhdHeight);
        Assert.False(Items(await Item(rig, rig.Member, rig.HdCopy))[0].TryGetProperty("fourK", out _));
        Assert.True(Items(await Item(rig, rig.Admin, rig.HdCopy))[0].GetProperty("fourK").GetBoolean());
        // A 4K copy in Movies 4K: the member's HD page knows.
        rig.MovieCopy(rig.UhdCopy, "/media/movies4k/Sintel (2010)/Sintel.mkv", "Movies 4K", (UhdWidth, UhdHeight));
        Assert.True(Items(await Item(rig, rig.Member, rig.HdCopy))[0].GetProperty("fourK").GetBoolean());
    }

    // ------------------------------------------------------------------ Q-ARRIVE-15: the grouped sibling

    [Fact]
    public void WhenJellyfinDeletesTheShownMissingEpisodeTheGroupedSiblingsFileIsTheArrival()
    {
        // Grouped Firefly: the standard folder shows a missing S1E3; only the 4K folder gets the file. Jellyfin then
        // deletes the standard folder's missing episode itself (one show, and the slot has a file).
        using var rig = new Rig(Layout.GroupedFolders, Has.Hd, movie: false);
        var key = Firefly.WithEpisode(1, 3);
        var shown = Guid.NewGuid();
        rig.View.AddItem(new JfItemRef { ItemId = shown, Kind = "episode", Key = key, SeriesId = rig.HdCopy, Season = 1, Episode = 3, Virtual = true });
        rig.View.AddEpisode(rig.HdCopy, new JfEpisode { ItemId = shown, Season = 1, Episode = 3, Virtual = true });
        var file = rig.View.AddEpisodeFile(rig.UhdCopy, Firefly, 1, 3, UhdWidth, UhdHeight);

        // While the shown item exists, the page stays in its own copy.
        Assert.Null(rig.Service.ArrivedItem(rig.Member, key, shown, rig.HdCopy));
        rig.View.Items.Remove(shown);
        rig.View.EpisodesBySeries[rig.HdCopy].RemoveAll(e => e.Episode.ItemId == shown);
        rig.View.Rev++;
        Assert.Equal(file, rig.Service.ArrivedItem(rig.Member, key, shown, rig.HdCopy));
        // Its own copy's file wins once it has one.
        var own = rig.View.AddEpisodeFile(rig.HdCopy, Firefly, 1, 3, HdWidth, HdHeight);
        Assert.Equal(own, rig.Service.ArrivedItem(rig.Member, key, shown, rig.HdCopy));
    }

    [Fact]
    public void ASeparateLibrarysCopyIsNoGroupedSiblingToFollow()
    {
        using var rig = new Rig(Layout.SeparateLibraries, Has.Hd, movie: false);
        var key = Firefly.WithEpisode(1, 3);
        var gone = Guid.NewGuid();
        rig.View.AddEpisodeFile(rig.UhdCopy, Firefly, 1, 3, UhdWidth, UhdHeight);
        Assert.Null(rig.Service.ArrivedItem(rig.Member, key, gone, rig.HdCopy));
    }

    // ------------------------------------------------------------------ the consumer contract (lists, badges, home rows, hub)

    [Fact]
    public void AHitNamesTheExactVersionItemThatPlaysItAndTheLogicalItemItBelongsTo()
    {
        // One movie item: the 1080p file is the item's own, the 2160p one a version with its own item.
        using var rig = new Rig(Layout.OneItem, Has.Hd, movie: true);
        var uhd = rig.View.AddSource(rig.HdCopy, UhdWidth, UhdHeight, "/media/movies/Sintel (2010)/Sintel (2010) - 2160p.mkv");
        var hit = Assert.Single(rig.Service.Editions.Scope(rig.Member, Sintel, Edition.FourK));
        Assert.Equal((rig.HdCopy, rig.HdCopy, uhd.BackingItemId), (hit.CopyId, hit.ItemId, hit.PlayableItemId));
        Assert.NotEqual(rig.HdCopy, hit.PlayableItemId);
        Assert.Null(hit.SeriesId);
        // A standard request prefers the file that isn't 4K (listed after the 4K one here), and takes the 4K one too.
        var standard = rig.Service.Editions.Scope(rig.Member, Sintel, Edition.Standard);
        Assert.Equal(new[] { rig.HdCopy, uhd.BackingItemId }, standard.Select(h => h.PlayableItemId));
    }

    [Fact]
    public void AGroupedEpisodesHitKeepsItsOwnPhysicalSeriesAndAPinnedSeriesNeverBorrowsASiblings()
    {
        using var rig = new Rig(Layout.GroupedFolders, Has.Both, movie: false);
        var editions = rig.Service.Editions;
        var fourK = editions.Scope(rig.Member, Firefly.WithEpisode(1, 2), Edition.FourK);
        Assert.All(fourK, h => Assert.Equal(rig.UhdCopy, h.SeriesId));
        Assert.NotEmpty(fourK);
        // Pinned to the HD folder: its own files only, never the 4K folder's.
        Assert.Empty(editions.Scope(rig.Member, Firefly.WithEpisode(1, 2), Edition.FourK, rig.HdCopy));
        Assert.All(editions.Scope(rig.Member, Firefly.WithSeason(1), Edition.Standard, rig.HdCopy), h => Assert.Equal(rig.HdCopy, h.SeriesId));
        // A whole series: every qualifying episode, each with the series item to link (a 4K collection picks that one).
        Assert.Equal(new[] { rig.UhdCopy }, editions.Scope(rig.Member, Firefly, Edition.FourK).Select(h => h.SeriesId!.Value).Distinct());
    }

    [Fact]
    public void EveryViewerOfASharedListMustBeAbleToOpenTheSourceAndTheLibraryContextSeesAll()
    {
        using var rig = new Rig(Layout.SeparateLibraries, Has.Hd, movie: true);
        var hidden = Guid.NewGuid();
        rig.View.AddItem(new JfItemRef { ItemId = hidden, Kind = "movie", Key = Sintel, Path = "/media/private/Sintel.mkv" }, rig.Admin.UserId);
        rig.View.AddCopy(Sintel, new JfCopy { ItemId = hidden, Path = "/media/private/Sintel.mkv", LibraryName = "Private" }, rig.Admin.UserId);
        rig.View.AddSource(hidden, UhdWidth, UhdHeight);
        var editions = rig.Service.Editions;
        Assert.Single(editions.ScopeForAll(new[] { rig.Admin }, Sintel, Edition.FourK));
        Assert.Empty(editions.ScopeForAll(new[] { rig.Admin, rig.Member }, Sintel, Edition.FourK));
        Assert.Equal(rig.HdCopy, Assert.Single(editions.ScopeForAll(new[] { rig.Admin, rig.Member }, Sintel, Edition.Standard)).PlayableItemId);
        // No viewers: the server's library context, every copy.
        Assert.Equal(hidden, Assert.Single(editions.ScopeForAll(Array.Empty<StatusViewer>(), Sintel, Edition.FourK)).PlayableItemId);
    }

    // ------------------------------------------------------------------ the production filter on Jellyfin's own items

    [Fact]
    public void AnEditionsEpisodesAreOnlyEverOneSeriesItemsOwnPlayablePrimaryEpisodes()
    {
        // ArrJellyfinView.EpisodeSources keeps, of the episodes under a series item's folders: its own (never another
        // grouped folder's), with a file, numbered, of the season asked for, and never a second version of an
        // episode as an item of its own (12.x: the version is a source of its primary; 10.11 lists it as an episode).
        var series = Guid.NewGuid();
        var other = Guid.NewGuid();
        const string presentation = "78874-en-library";
        MediaBrowser.Controller.Entities.TV.Episode Ep(Guid of, int season, int? number, bool missing = false)
            => new() { Id = Guid.NewGuid(), SeriesId = of, SeriesPresentationUniqueKey = presentation, ParentIndexNumber = season, IndexNumber = number, IsVirtualItem = missing, Path = missing ? null : $"/media/{of:N}/S{season}E{number}.mkv" };
        var own = Ep(series, 1, 3);
        var version = Ep(series, 1, 3);
        version.OwnerId = own.Id;
#if NET10_0_OR_GREATER
        version.PrimaryVersionId = own.Id;
#else
        version.PrimaryVersionId = own.Id.ToString("N");
#endif
        Assert.True(ArrJellyfinView.OwnPlayableEpisode(own, series, 1));
        Assert.True(ArrJellyfinView.OwnPlayableEpisode(own, series, null));
        Assert.False(ArrJellyfinView.OwnPlayableEpisode(own, series, 2));
        Assert.False(ArrJellyfinView.OwnPlayableEpisode(own, other, 1));
        Assert.False(ArrJellyfinView.OwnPlayableEpisode(Ep(other, 1, 3), series, 1));
        Assert.False(ArrJellyfinView.OwnPlayableEpisode(Ep(series, 1, 3, missing: true), series, 1));
        Assert.False(ArrJellyfinView.OwnPlayableEpisode(Ep(series, 1, null), series, 1));
        Assert.False(ArrJellyfinView.OwnPlayableEpisode(version, series, 1));
        Assert.False(ArrJellyfinView.OwnPlayableEpisode(own, Guid.Empty, 1));
    }

    // ------------------------------------------------------------------ helpers

    private static async Task<string> Item(Rig rig, StatusViewer viewer, Guid id)
        => System.Text.Encoding.UTF8.GetString((await rig.Service.ForItemAsync(viewer, id, default)).Json);

    private static List<JsonElement> Items(string body)
    {
        using var doc = JsonDocument.Parse(body);
        return doc.RootElement.GetProperty("items").EnumerateArray().Select(e => e.Clone()).ToList();
    }
}
