using System.Text.Json;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using MediaBrowser.Controller.Library;
using Moq;

namespace JE.Tests;

/// <summary>
/// The status composer's derivation table: every stop of the status language (Asked, OK'd, Not out
/// yet, Looking, Downloading, Almost ready, Ready) and the reason codes behind them, for movies,
/// series, seasons and episodes; family vs admin shapes; which copy a family member follows; and
/// that the family shape never carries an instance, path, client, release or the arr's own words.
/// </summary>
public class IntegrationArrStatusTests
{
    private static readonly DateTime Now = new(2026, 10, 12, 12, 0, 0, DateTimeKind.Utc);
    private static readonly ArrConnection Radarr = new() { Id = "6d0b7d1c-0000-4000-8000-0000000000a1", Kind = ArrKind.Radarr, Name = "Radarr (lab)", Url = "http://radarr.lan:7878", Role = "standard" };
    private static readonly ArrConnection Radarr4k = new() { Id = "6d0b7d1c-0000-4000-8000-0000000000a2", Kind = ArrKind.Radarr, Name = "Radarr 4K (lab)", Url = "http://radarr4k.lan:7878", Role = "4k" };
    private static readonly ArrConnection Sonarr = new() { Id = "6d0b7d1c-0000-4000-8000-0000000000a3", Kind = ArrKind.Sonarr, Name = "Sonarr (lab)", Url = "http://sonarr.lan:8989", Role = "standard" };
    private static readonly StatusViewer Member = new() { UserId = Guid.NewGuid(), IsAdmin = false, PolicyRevision = "m" };
    private static readonly StatusViewer Admin = new() { UserId = Guid.NewGuid(), IsAdmin = true, PolicyRevision = "a" };
    private static readonly TitleKey MovieKey = TitleKey.Parse("movie:tmdb:693134")!;
    private static readonly TitleKey ShowKey = TitleKey.Parse("series:tvdb:279121")!;

    private static ComposeContext Ctx(StatusViewer? viewer = null) => new(viewer ?? Member, Now, 24);

    private static ArrMovieEntry Movie(bool monitored = true, bool hasFile = false, bool available = true, DateTime? added = null, DateTime? cinemas = null, DateTime? digital = null, string path = "/data/movies/Dune Part Two (2024)")
        => new()
        {
            Id = 7, TmdbId = 693134, Title = "Dune: Part Two", Monitored = monitored, HasFile = hasFile, IsAvailable = available,
            Added = added ?? Now.AddHours(-2), InCinemas = cinemas, DigitalRelease = digital, MinimumAvailability = "released", Path = path,
        };

    private static ArrQueueEntry Row(string status = "downloading", string state = "downloading", string tracked = "ok", double size = 1000, double left = 580, int? episodeId = null, int? season = null, int? episode = null, string[]? messages = null)
        => new()
        {
            Id = 1 + (episodeId ?? 0), DownloadId = "dl" + (episodeId ?? 0), Status = status, TrackedDownloadState = state, TrackedDownloadStatus = tracked,
            Size = size, SizeLeft = left, EstimatedCompletionTime = Now.AddMinutes(12), MovieId = episodeId == null ? 7 : null, SeriesId = episodeId == null ? null : 3,
            EpisodeId = episodeId, SeasonNumber = season, EpisodeNumber = episode, StatusMessages = messages ?? Array.Empty<string>(), DownloadClient = "Mock SABnzbd",
            Quality = "Bluray-1080p", CustomFormatScore = 100, ReleaseTitle = "Dune.Part.Two.2024.1080p.BluRay-MOCKHD", Added = Now.AddMinutes(-30),
        };

    private static ArrHistoryEntry Event(string type, DateTime at, int? episodeId = null) => new() { Id = Random.Shared.Next(), EventType = type, Date = at, MovieId = episodeId == null ? 7 : null, EpisodeId = episodeId };

    private static TitleFacts MovieFacts(params ArrCopyFacts[] copies)
    {
        var facts = new TitleFacts(MovieKey);
        facts.Copies.AddRange(copies);
        return facts;
    }

    private static ArrCopyFacts Copy(ArrMovieEntry movie, ArrConnection? instance = null, IReadOnlyList<ArrQueueEntry>? queue = null, IReadOnlyList<ArrHistoryEntry>? history = null)
        => new(instance ?? Radarr) { Movie = movie, Queue = queue ?? Array.Empty<ArrQueueEntry>(), History = history ?? Array.Empty<ArrHistoryEntry>() };

    private static (string Stage, string Code, bool Attention) Of(TitleStatus s) => (s.Stage, s.Reason.Code, s.Attention);

    // ------------------------------------------------------------------ movies by key (not in Jellyfin)

    private static readonly (string Name, Func<ArrCopyFacts?> Copy, string Stage, string Code, bool Attention)[] MovieTable =
    {
        ("not in any Radarr", () => null, StatusStage.NotHere, StatusReasonCode.NotInArr, false),
        ("unmonitored", () => Copy(Movie(monitored: false)), StatusStage.NotHere, StatusReasonCode.Unmonitored, false),
        ("announced, cinemas ahead", () => Copy(Movie(available: false, cinemas: Now.AddDays(30))), StatusStage.NotOut, StatusReasonCode.NotReleased, false),
        ("in cinemas, digital ahead", () => Copy(Movie(available: false, cinemas: Now.AddDays(-10), digital: Now.AddDays(33))), StatusStage.NotOut, StatusReasonCode.InCinemas, false),
        ("looking (2 h)", () => Copy(Movie()), StatusStage.Looking, StatusReasonCode.Looking, false),
        ("still looking (30 h)", () => Copy(Movie(added: Now.AddHours(-30))), StatusStage.Looking, StatusReasonCode.NoReleaseYet, false),
        ("downloading", () => Copy(Movie(), queue: new[] { Row() }), StatusStage.Downloading, StatusReasonCode.Downloading, false),
        ("queued in the client", () => Copy(Movie(), queue: new[] { Row(status: "queued") }), StatusStage.Downloading, StatusReasonCode.Queued, false),
        ("held by a delay profile", () => Copy(Movie(), queue: new[] { Row(status: "delay") }), StatusStage.Downloading, StatusReasonCode.DelayHeld, false),
        ("stalled (arr warning)", () => Copy(Movie(), queue: new[] { Row(tracked: "warning", messages: new[] { "client reports no peers" }) }), StatusStage.Downloading, StatusReasonCode.Stalled, true),
        ("failed (queue)", () => Copy(Movie(), queue: new[] { Row(state: "failedPending", tracked: "error") }), StatusStage.Looking, StatusReasonCode.Failed, true),
        ("failed (history, 1 h ago)", () => Copy(Movie(), history: new[] { Event("downloadFailed", Now.AddHours(-1)), Event("grabbed", Now.AddHours(-2)) }), StatusStage.Looking, StatusReasonCode.Failed, true),
        ("importing", () => Copy(Movie(), queue: new[] { Row(status: "completed", state: "importPending") }), StatusStage.AlmostReady, StatusReasonCode.Importing, false),
        ("import pending with a warning (sample)", () => Copy(Movie(), queue: new[] { Row(status: "completed", state: "importPending", tracked: "warning", messages: new[] { "Sample" }) }), StatusStage.AlmostReady, StatusReasonCode.ImportBlocked, true),
        ("import blocked", () => Copy(Movie(), queue: new[] { Row(status: "completed", state: "importBlocked", tracked: "warning", messages: new[] { "Manual Import required." }) }), StatusStage.AlmostReady, StatusReasonCode.ImportBlocked, true),
        ("imported, not in Jellyfin", () => Copy(Movie(hasFile: true)), StatusStage.AlmostReady, StatusReasonCode.LibraryPending, false),
        ("imported (history ahead of a stale index)", () => Copy(Movie(), history: new[] { Event("downloadFolderImported", Now.AddMinutes(-3)), Event("grabbed", Now.AddMinutes(-10)) }), StatusStage.AlmostReady, StatusReasonCode.LibraryPending, false),
    };

    public static TheoryData<string> MovieRows()
    {
        var data = new TheoryData<string>();
        foreach (var row in MovieTable) data.Add(row.Name);
        return data;
    }

    [Theory]
    [MemberData(nameof(MovieRows))]
    public void AMovieNotInJellyfinReadsWhereTheArrHasGotTo(string scenario)
    {
        var row = MovieTable.Single(r => r.Name == scenario);
        var copy = row.Copy();
        var facts = copy == null ? MovieFacts() : MovieFacts(copy);
        var status = StatusComposer.Movie(facts, null, Array.Empty<JfCopy>(), Ctx(), detail: false);
        Assert.True((row.Stage, row.Code, row.Attention) == Of(status), $"{scenario}: got {Of(status)}");
        Assert.Null(status.Admin);
    }

    [Fact]
    public void DatesProgressAndEtaAreCarriedAsFamilySafeParameters()
    {
        var notOut = StatusComposer.Movie(MovieFacts(Copy(Movie(available: false, cinemas: Now.AddDays(-10), digital: Now.AddDays(33)))), null, Array.Empty<JfCopy>(), Ctx(), false);
        Assert.Equal(Now.AddDays(33), notOut.NextDate);
        Assert.Equal("2026-11-14T12:00:00Z", notOut.Reason.Params!["date"]);

        var downloading = StatusComposer.Movie(MovieFacts(Copy(Movie(), queue: new[] { Row() })), null, Array.Empty<JfCopy>(), Ctx(), false);
        Assert.Equal(42, downloading.Progress!.Percent);
        Assert.Equal(720, downloading.Progress.EtaSeconds);

        // No estimated completion: the arr's "timeleft" is used.
        var row = new ArrQueueEntry { Id = 1, Status = "downloading", TrackedDownloadState = "downloading", TrackedDownloadStatus = "ok", Size = 100, SizeLeft = 75, TimeLeft = "00:05:00", MovieId = 7 };
        Assert.Equal((25, 300L), (StatusComposer.Progress(row, Ctx())!.Percent, StatusComposer.Progress(row, Ctx())!.EtaSeconds!.Value));
    }

    [Fact]
    public void ReadyMeansAJellyfinItemThisViewerCanOpen()
    {
        var facts = MovieFacts(Copy(Movie(hasFile: true)));
        var visible = new JfCopy { ItemId = Guid.NewGuid(), Visible = true, Path = "/media/movies/Dune Part Two (2024)/Dune.mkv", LibraryName = "Movies", DateCreated = Now.AddDays(-30) };
        Assert.Equal((StatusStage.Ready, StatusReasonCode.Ready, false), Of(StatusComposer.Movie(facts, null, new[] { visible }, Ctx(), false)));

        // The only copy is in a library the viewer can't open: treated as not here for them (the
        // answer of a title nobody has), "grant access" for an admin.
        var hidden = new JfCopy { ItemId = Guid.NewGuid(), Visible = false, Path = visible.Path, LibraryName = "Movies 4K" };
        var family = StatusComposer.Movie(facts, null, new[] { hidden }, Ctx(), false);
        Assert.Equal((StatusStage.NotHere, StatusReasonCode.NotInArr), (family.Stage, family.Reason.Code));
        var admin = StatusComposer.Movie(facts, null, new[] { hidden }, Ctx(Admin), false);
        var variant = Assert.Single(admin.Admin!.Variants);
        Assert.Equal((StatusReasonCode.NotVisibleToUser, StatusFix.GrantAccess, "Movies 4K"), (variant.Reason.Code, variant.Fix, variant.Library));
    }

    [Fact]
    public void AFamilyMemberFollowsTheStandardCopyAnAdminSeesEveryCopy()
    {
        // Only the 4K instance has it and it is downloading: a family member is not told about a copy
        // that would land in a library they may not open; an admin sees it.
        var only4k = MovieFacts(Copy(Movie(path: "/data/movies4k/Dune Part Two (2024)"), Radarr4k, queue: new[] { Row() }));
        Assert.Equal(StatusStage.NotHere, StatusComposer.Movie(only4k, null, Array.Empty<JfCopy>(), Ctx(), false).Stage);
        Assert.Equal(StatusStage.Downloading, StatusComposer.Movie(only4k, null, Array.Empty<JfCopy>(), Ctx(Admin), false).Stage);

        // On the standard item's page while the 4K copy downloads: the family pill is quiet (it is
        // ready and nothing new), the admin sees both copies with their libraries.
        var standardItem = new JfItemRef { ItemId = Guid.NewGuid(), Kind = "movie", Key = MovieKey, Path = "/media/movies/Dune Part Two (2024)/Dune Part Two (2024) Bluray-1080p.mkv", DateCreated = Now.AddDays(-20) };
        var copies = new[] { new JfCopy { ItemId = standardItem.ItemId, Visible = true, Path = standardItem.Path, LibraryName = "Movies", DateCreated = standardItem.DateCreated } };
        var both = MovieFacts(
            Copy(Movie(hasFile: true, path: "/data/movies/Dune Part Two (2024)")),
            Copy(Movie(path: "/data/movies4k/Dune Part Two (2024)"), Radarr4k, queue: new[] { Row() }));
        var family = StatusComposer.Movie(both, standardItem, copies, Ctx(), detail: true);
        Assert.Equal((StatusStage.Ready, StatusReasonCode.Ready, true), (family.Stage, family.Reason.Code, family.Quiet));
        Assert.Null(family.Admin);
        var admin = StatusComposer.Movie(both, standardItem, copies, Ctx(Admin), detail: true);
        Assert.False(admin.Quiet);
        Assert.Equal(new[] { ("Radarr (lab)", StatusStage.Ready, "Movies"), ("Radarr 4K (lab)", StatusStage.Downloading, (string?)null) },
            admin.Admin!.Variants.Select(v => (v.Instance, v.Stage, v.Library)).ToArray());
        Assert.Equal(42, admin.Admin.Variants[1].Progress!.Percent);
    }

    [Fact]
    public void ACopyIsMatchedToItsJellyfinItemByLinkedLibraryPathMappingOrFolderNames()
    {
        var jf = new[]
        {
            new JfCopy { ItemId = Guid.NewGuid(), Path = "/rigmedia/movies/Sintel (2010) [tmdbid-45745]/Sintel (2010) Bluray-1080p.mkv", LibraryId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1" },
            new JfCopy { ItemId = Guid.NewGuid(), Path = "/rigmedia/movies4k/Sintel (2010) [tmdbid-45745]/Sintel (2010) Remux-2160p.mkv", LibraryId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2" },
        };
        ArrCopyFacts At(ArrConnection instance, string path) => Copy(Movie(path: path), instance);
        // Folder names (no mapping configured): "movies/Sintel…" vs "movies4k/Sintel…".
        Assert.Equal(jf[0].ItemId, Assert.Single(StatusComposer.MatchCopies(At(Radarr, "/data/media/movies/Sintel (2010) [tmdbid-45745]"), jf, 2)).ItemId);
        Assert.Equal(jf[1].ItemId, Assert.Single(StatusComposer.MatchCopies(At(Radarr4k, "/data/media/movies4k/Sintel (2010) [tmdbid-45745]"), jf, 2)).ItemId);
        // Linked libraries win over paths.
        var linked = new ArrConnection { Id = Radarr.Id, Kind = ArrKind.Radarr, Name = "x", Role = "standard", LinkedLibraryIds = new[] { "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2" } };
        Assert.Equal(jf[1].ItemId, Assert.Single(StatusComposer.MatchCopies(At(linked, "/data/media/movies/Sintel (2010) [tmdbid-45745]"), jf, 2)).ItemId);
        // Path mappings.
        var mapped = new ArrConnection { Id = Radarr.Id, Kind = ArrKind.Radarr, Name = "x", Role = "standard", PathMappings = new[] { new Jellyfin.Plugin.JellyfinEnhanced.Model.Arr.ArrPathMapping { ArrPath = "/srv/uhd", JellyfinPath = "/rigmedia/movies4k" } } };
        Assert.Equal(jf[1].ItemId, Assert.Single(StatusComposer.MatchCopies(At(mapped, "/srv/uhd/Sintel (2010) [tmdbid-45745]"), jf, 2)).ItemId);
        // One instance only: every copy is its copy; two instances and nothing matches: none.
        Assert.Equal(2, StatusComposer.MatchCopies(At(Radarr, "/elsewhere/Sintel"), jf, 1).Count);
        Assert.Empty(StatusComposer.MatchCopies(At(Radarr, "/elsewhere/Sintel"), jf, 2));
    }

    [Fact]
    public void AReadyItemWithADownloadOnItIsUpgradingAndARecentArrivalIsNotQuiet()
    {
        var item = new JfItemRef { ItemId = Guid.NewGuid(), Kind = "movie", Key = MovieKey, Path = "/media/Dune/Dune.mkv", DateCreated = Now.AddDays(-40) };
        var upgrading = StatusComposer.Movie(MovieFacts(Copy(Movie(hasFile: true), queue: new[] { Row() })), item, null, Ctx(), false);
        Assert.Equal((StatusStage.Ready, StatusReasonCode.Upgrading, false), (upgrading.Stage, upgrading.Reason.Code, upgrading.Quiet));

        var arrived = new JfItemRef { ItemId = item.ItemId, Kind = "movie", Key = MovieKey, Path = item.Path, DateCreated = Now.AddMinutes(-2) };
        var history = new[] { Event("downloadFolderImported", Now.AddMinutes(-5)), Event("grabbed", Now.AddMinutes(-40)) };
        var fresh = StatusComposer.Movie(MovieFacts(Copy(Movie(hasFile: true, added: Now.AddHours(-3)), history: history)), arrived, null, Ctx(), detail: true);
        Assert.False(fresh.Quiet);
        Assert.Equal(new[] { (StatusStage.Looking, "done"), (StatusStage.Downloading, "done"), (StatusStage.AlmostReady, "done"), (StatusStage.Ready, "current") },
            fresh.Journey!.Select(j => (j.Stage, j.State)).ToArray());

        var old = StatusComposer.Movie(MovieFacts(Copy(Movie(hasFile: true))), item, null, Ctx(), false);
        Assert.True(old.Quiet);
    }

    [Fact]
    public void TheJourneyShowsWhatHappenedTheCurrentStopAndWhatIsStillToCome()
    {
        var requests = new RequestFacts { AskedAt = Now.AddDays(-1), AskedByViewer = false, ApprovedAt = Now.AddHours(-20) };
        var facts = MovieFacts(Copy(Movie(added: Now.AddHours(-20)), queue: new[] { Row() }, history: new[] { Event("grabbed", Now.AddHours(-19.9)) }));
        facts.Request = requests;
        var status = StatusComposer.Movie(facts, null, Array.Empty<JfCopy>(), Ctx(), detail: true);
        // Added and grabbed within minutes: "Looking" is skipped, as in "Asked → OK'd → Downloading".
        Assert.Equal(new[] { (StatusStage.Asked, "done"), (StatusStage.Approved, "done"), (StatusStage.Downloading, "current"), (StatusStage.AlmostReady, "next"), (StatusStage.Ready, "next") },
            status.Journey!.Select(j => (j.Stage, j.State)).ToArray());
        Assert.False(status.Journey![0].ByYou);
    }

    [Fact]
    public void ADownloadThatJustLeftTheQueueIsAlmostReadyUntilTheLibraryIsReadAgain()
    {
        var left = Now.AddSeconds(-20);
        ArrCopyFacts Departed(DateTime libraryAt) => new(Radarr) { Movie = Movie(), LibraryLoadedAt = libraryAt, LeftQueue = (m, e) => m == 7 ? left : null };
        Assert.Equal((StatusStage.AlmostReady, StatusReasonCode.Importing, false), Of(StatusComposer.Movie(MovieFacts(Departed(Now.AddMinutes(-5))), null, Array.Empty<JfCopy>(), Ctx(), false)));
        // The library was read after it left and still has no file (removed, not imported): looking again.
        Assert.Equal((StatusStage.Looking, StatusReasonCode.Looking, false), Of(StatusComposer.Movie(MovieFacts(Departed(Now)), null, Array.Empty<JfCopy>(), Ctx(), false)));

        var (facts, _) = FlashSeason(virtualRows: true);
        var copy = facts.Copies[0];
        var withDeparture = new TitleFacts(ShowKey);
        withDeparture.Copies.Add(new ArrCopyFacts(Sonarr) { Series = copy.Series, Episodes = copy.Episodes, EpisodesLoadedAt = Now.AddMinutes(-5), LeftQueue = (m, e) => e == 902 ? left : null });
        var episode = new JfItemRef { ItemId = Guid.NewGuid(), Kind = "episode", Key = ShowKey.WithEpisode(9, 2), SeriesId = SeriesItem, Season = 9, Episode = 2, Virtual = true };
        Assert.Equal((StatusStage.AlmostReady, StatusReasonCode.Importing, false), Of(StatusComposer.Episode(withDeparture, episode, Ctx(), false)));
    }

    [Fact]
    public void RequestFactsGiveAskedOkdAndDeclinedBeforeAnyArrHasTheTitle()
    {
        TitleStatus With(RequestFacts r)
        {
            var facts = MovieFacts();
            facts.Request = r;
            return StatusComposer.Movie(facts, null, Array.Empty<JfCopy>(), Ctx(), false);
        }
        Assert.Equal((StatusStage.Asked, StatusReasonCode.AwaitingApproval, false), Of(With(new RequestFacts { Pending = true, AskedAt = Now })));
        Assert.Equal((StatusStage.Approved, StatusReasonCode.Approved, false), Of(With(new RequestFacts { ApprovedAt = Now })));
        Assert.Equal((StatusStage.NotHere, StatusReasonCode.Declined, false), Of(With(new RequestFacts { Declined = true })));
    }

    [Fact]
    public void AnUnreadableInstanceIsServiceDownNotNotHere()
    {
        var facts = MovieFacts();
        facts.Unreadable.Add("Radarr (lab) (Unreachable)");
        Assert.Equal((StatusStage.None, StatusReasonCode.ServiceDown, false), Of(StatusComposer.Movie(facts, null, Array.Empty<JfCopy>(), Ctx(), false)));
        var admin = StatusComposer.Movie(facts, null, Array.Empty<JfCopy>(), Ctx(Admin), false);
        Assert.Equal("Radarr (lab) (Unreachable)", Assert.Single(admin.Admin!.Unreadable!));
    }

    [Fact]
    public void AdminFixHintsFollowTheReason()
    {
        var expected = new Dictionary<string, string?>
        {
            [StatusReasonCode.NotReleased] = StatusFix.ChangeMinAvailability, [StatusReasonCode.Looking] = StatusFix.SearchNow,
            [StatusReasonCode.NoReleaseYet] = StatusFix.SearchNow, [StatusReasonCode.DelayHeld] = StatusFix.GrabNow,
            [StatusReasonCode.Stalled] = StatusFix.RemoveAndSearch, [StatusReasonCode.Failed] = StatusFix.Research,
            [StatusReasonCode.ImportBlocked] = StatusFix.ManualImport, [StatusReasonCode.LibraryPending] = StatusFix.ScanNow,
            [StatusReasonCode.NotVisibleToUser] = StatusFix.GrantAccess, [StatusReasonCode.Unmonitored] = StatusFix.MonitorAndSearch,
            [StatusReasonCode.ServiceDown] = StatusFix.Health, [StatusReasonCode.Downloading] = null, [StatusReasonCode.Ready] = null,
        };
        foreach (var (code, fix) in expected) Assert.Equal(fix, StatusComposer.FixFor(code));
    }

    // ------------------------------------------------------------------ series, seasons, episodes

    private static readonly Guid SeriesItem = Guid.NewGuid();

    private static ArrSeriesEntry Series(bool monitored = true, string path = "/data/tv/The Flash (2014)") => new()
    {
        Id = 3, TvdbId = 279121, Title = "The Flash", Monitored = monitored, Path = path, Added = Now.AddDays(-400), EpisodeFileCount = 9, EpisodeCount = 12,
        Seasons = new[]
        {
            new ArrSeasonEntry { SeasonNumber = 0, TotalEpisodeCount = 2 },
            new ArrSeasonEntry { SeasonNumber = 8, Monitored = true, EpisodeCount = 2, EpisodeFileCount = 2, TotalEpisodeCount = 2 },
            new ArrSeasonEntry { SeasonNumber = 9, Monitored = true, EpisodeCount = 6, EpisodeFileCount = 3, TotalEpisodeCount = 7, NextAiring = Now.AddDays(3) },
        },
    };

    private static ArrEpisodeEntry Ep(int season, int number, DateTime air, bool hasFile = false, bool monitored = true)
        => new() { Id = season * 100 + number, SeasonNumber = season, EpisodeNumber = number, AirDateUtc = air, HasFile = hasFile, Monitored = monitored };

    /// <summary>
    /// Season 9: E1 ready in Jellyfin; E2 missing with a virtual row; E3 downloading; E4 imported but
    /// not in Jellyfin; E5 a problem (import blocked); E6 aired, unmonitored; E7 airs in 3 days. Season 8 complete.
    /// </summary>
    private static (TitleFacts Facts, List<JfEpisode> Jf) FlashSeason(bool virtualRows)
    {
        var episodes = new ArrEpisodesSnapshot(3, new[]
        {
            Ep(8, 1, Now.AddDays(-400), true), Ep(8, 2, Now.AddDays(-393), true),
            Ep(9, 1, Now.AddDays(-30), true), Ep(9, 2, Now.AddDays(-23)), Ep(9, 3, Now.AddDays(-16)), Ep(9, 4, Now.AddDays(-9), true),
            Ep(9, 5, Now.AddDays(-2)), Ep(9, 6, Now.AddDays(-1), monitored: false), Ep(9, 7, Now.AddDays(3)),
        });
        var queue = new[]
        {
            Row(episodeId: 903, season: 9, episode: 3, left: 400),
            Row(status: "completed", state: "importBlocked", tracked: "warning", episodeId: 905, season: 9, episode: 5, messages: new[] { "Found matching series via grab history, but release was matched to series by ID. Automatic import is not possible." }),
        };
        var facts = new TitleFacts(ShowKey);
        facts.Copies.Add(new ArrCopyFacts(Sonarr) { Series = Series(), Episodes = episodes, Queue = queue });
        var jf = new List<JfEpisode>
        {
            new() { ItemId = Guid.NewGuid(), Season = 8, Episode = 1, DateCreated = Now.AddDays(-300) },
            new() { ItemId = Guid.NewGuid(), Season = 8, Episode = 2, DateCreated = Now.AddDays(-300) },
            new() { ItemId = Guid.NewGuid(), Season = 9, Episode = 1, DateCreated = Now.AddDays(-29) },
        };
        if (virtualRows)
        {
            jf.Add(new JfEpisode { ItemId = Guid.NewGuid(), Season = 9, Episode = 2, Virtual = true });
            jf.Add(new JfEpisode { ItemId = Guid.NewGuid(), Season = 9, Episode = 7, Virtual = true });
        }
        return (facts, jf);
    }

    [Fact]
    public void ASeasonPageGetsEveryEpisodesStateAndRowsOnlyWhereTheViewerHasThem()
    {
        var (facts, jf) = FlashSeason(virtualRows: true);
        var season = new JfItemRef { ItemId = Guid.NewGuid(), Kind = "season", Key = ShowKey.WithSeason(9), SeriesId = SeriesItem, Season = 9 };
        var status = StatusComposer.Season(facts, season, jf, Ctx(), detail: true);

        Assert.Equal("series:tvdb:279121:s9", status.Key);
        var byNumber = status.Episodes!.ToDictionary(e => e.Episode);
        Assert.Equal((StatusStage.Ready, true), (byNumber[1].Stage, byNumber[1].Row));
        Assert.Equal((StatusStage.Looking, StatusReasonCode.NoReleaseYet, true), (byNumber[2].Stage, byNumber[2].Reason.Code, byNumber[2].Row));
        Assert.Equal((StatusStage.Downloading, 60, false), (byNumber[3].Stage, byNumber[3].Progress!.Percent, byNumber[3].Row));
        Assert.Equal((StatusStage.AlmostReady, StatusReasonCode.LibraryPending), (byNumber[4].Stage, byNumber[4].Reason.Code));
        Assert.Equal((StatusStage.AlmostReady, StatusReasonCode.ImportBlocked, true), (byNumber[5].Stage, byNumber[5].Reason.Code, byNumber[5].Attention));
        Assert.Equal((StatusStage.NotHere, StatusReasonCode.Unmonitored), (byNumber[6].Stage, byNumber[6].Reason.Code));
        Assert.Equal((StatusStage.NotOut, StatusReasonCode.NotAired, true), (byNumber[7].Stage, byNumber[7].Reason.Code, byNumber[7].Row));

        var s = status.Summary!;
        // Missing: only E2 (wanted); E6 is not monitored, so it is not counted (it still goes in the banner).
        Assert.Equal((6, 1, 1, 2, 1, 1), (s.Aired, s.Ready, s.Downloading, s.AlmostReady, s.Missing, s.Attention));
        Assert.Equal((Now.AddDays(3), 9, 7), (s.NextAir!.Value, s.NextSeason!.Value, s.NextEpisode!.Value));
        Assert.Equal((StatusStage.Downloading, true), (status.Stage, status.Attention));
        Assert.Null(status.Admin);

        // Without virtual episodes (the user doesn't show missing episodes) nothing has a row but
        // the real one: the missing ones belong in the banner, never on a row as well.
        var (facts2, jf2) = FlashSeason(virtualRows: false);
        var banner = StatusComposer.Season(facts2, season, jf2, Ctx(), detail: true);
        Assert.Equal(new[] { 1 }, banner.Episodes!.Where(e => e.Row).Select(e => e.Episode).ToArray());

        // Admin: the import-blocked episode with the arr's own words and the fix.
        var admin = StatusComposer.Season(facts, season, jf, Ctx(Admin), detail: true);
        var problem = admin.Admin!.Variants.Single(v => v.Scope == "S09E05");
        Assert.Equal((StatusReasonCode.ImportBlocked, StatusFix.ManualImport, "importBlocked"), (problem.Reason.Code, problem.Fix, problem.ArrState));
        Assert.Contains("Automatic import is not possible", Assert.Single(problem.Messages!));
    }

    [Fact]
    public void ASeriesPageSummarisesSeasonsAndTheNextEpisode()
    {
        var (facts, jf) = FlashSeason(virtualRows: false);
        var item = new JfItemRef { ItemId = SeriesItem, Kind = "series", Key = ShowKey };
        var status = StatusComposer.Series(facts, item, jf, new[] { new JfSeason { ItemId = Guid.NewGuid(), Season = 8 }, new JfSeason { ItemId = Guid.NewGuid(), Season = 9 } }, Ctx(), detail: true);
        Assert.Equal(new[] { 8 }, status.Summary!.ReadySeasons!.ToArray());
        Assert.Equal((9, 7), (status.Summary.NextSeason!.Value, status.Summary.NextEpisode!.Value));
        Assert.Equal(new[] { (8, StatusStage.Ready), (9, StatusStage.Downloading) }, status.Seasons!.Select(s => (s.Season, s.Stage)).ToArray());
        Assert.NotNull(status.Seasons![0].ItemId);
        Assert.False(status.Quiet);

        // The poster card for the series only reads the queue.
        var card = StatusComposer.SeriesCard(facts, item, Ctx());
        Assert.Equal((StatusStage.Downloading, 1, 1, true), (card.Stage, card.Summary!.Downloading, card.Summary.AlmostReady, card.Attention));
    }

    [Fact]
    public void ASeasonCardWithoutEpisodesInMemoryUsesSonarrsStatistics()
    {
        var (facts, jf) = FlashSeason(virtualRows: false);
        var copy = facts.Copies[0];
        var noEpisodes = new TitleFacts(ShowKey);
        noEpisodes.Copies.Add(new ArrCopyFacts(Sonarr) { Series = copy.Series, Queue = copy.Queue });
        var card = StatusComposer.Season(noEpisodes, new JfItemRef { ItemId = Guid.NewGuid(), Kind = "season", Key = ShowKey.WithSeason(9), Season = 9, SeriesId = SeriesItem }, jf, Ctx(), detail: false);
        // Sonarr: 6 aired-monitored, 3 files; Jellyfin has 1; queue: 1 downloading, 1 import blocked.
        Assert.Equal((6, 1, 1, 3, 1), (card.Summary!.Aired, card.Summary.Ready, card.Summary.Downloading, card.Summary.AlmostReady, card.Summary.Attention));
        Assert.Null(card.Episodes);
        var complete = StatusComposer.Season(noEpisodes, new JfItemRef { ItemId = Guid.NewGuid(), Kind = "season", Key = ShowKey.WithSeason(8), Season = 8, SeriesId = SeriesItem }, jf, Ctx(), detail: false);
        Assert.Equal((StatusStage.Ready, 2, 2), (complete.Stage, complete.Summary!.Ready, complete.Summary.Aired));
    }

    [Fact]
    public void AVirtualEpisodePageShowsWhereSonarrHasGotToARealOneIsReady()
    {
        var (facts, _) = FlashSeason(virtualRows: true);
        JfItemRef Episode(int n, bool isVirtual) => new() { ItemId = Guid.NewGuid(), Kind = "episode", Key = ShowKey.WithEpisode(9, n), SeriesId = SeriesItem, Season = 9, Episode = n, Virtual = isVirtual, DateCreated = Now.AddDays(-29) };
        Assert.Equal((StatusStage.AlmostReady, StatusReasonCode.ImportBlocked, true), Of(StatusComposer.Episode(facts, Episode(5, true), Ctx(), true)));
        Assert.Equal((StatusStage.Downloading, StatusReasonCode.Downloading, false), Of(StatusComposer.Episode(facts, Episode(3, true), Ctx(), true)));
        Assert.Equal((StatusStage.NotOut, StatusReasonCode.NotAired, false), Of(StatusComposer.Episode(facts, Episode(7, true), Ctx(), true)));
        var ready = StatusComposer.Episode(facts, Episode(1, false), Ctx(), true);
        Assert.Equal((StatusStage.Ready, StatusReasonCode.Ready, true), (ready.Stage, ready.Reason.Code, ready.Quiet));
        Assert.Equal("series:tvdb:279121:s9e1", ready.Key);
    }

    [Fact]
    public void TheFamilyShapeNeverCarriesInstancesPathsClientsReleasesOrArrWords()
    {
        var forbidden = new[] { "Radarr (lab)", "Radarr 4K (lab)", "Sonarr (lab)", "/data/", "radarr.lan", "sonarr.lan", "Mock SABnzbd", "MOCKHD", "Bluray-1080p", "Manual Import", "Automatic import", "client reports", "\"admin\"", "instance" };
        var all = new List<TitleStatus>();
        foreach (var row in MovieTable)
        {
            var copy = row.Copy();
            all.Add(StatusComposer.Movie(copy == null ? MovieFacts() : MovieFacts(copy), null, Array.Empty<JfCopy>(), Ctx(), detail: true));
        }
        var (facts, jf) = FlashSeason(virtualRows: true);
        all.Add(StatusComposer.Season(facts, new JfItemRef { ItemId = Guid.NewGuid(), Kind = "season", Key = ShowKey.WithSeason(9), SeriesId = SeriesItem, Season = 9 }, jf, Ctx(), true));
        all.Add(StatusComposer.Series(facts, new JfItemRef { ItemId = SeriesItem, Kind = "series", Key = ShowKey }, jf, null, Ctx(), true));
        all.Add(StatusComposer.SeriesCard(facts, new JfItemRef { ItemId = SeriesItem, Kind = "series", Key = ShowKey }, Ctx()));
        var json = JsonSerializer.Serialize(all, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull });
        foreach (var word in forbidden) Assert.DoesNotContain(word, json, StringComparison.OrdinalIgnoreCase);

        // The admin shape carries them.
        var admin = JsonSerializer.Serialize(StatusComposer.Season(facts, new JfItemRef { ItemId = Guid.NewGuid(), Kind = "season", Key = ShowKey.WithSeason(9), SeriesId = SeriesItem, Season = 9 }, jf, Ctx(Admin), true));
        Assert.Contains("Sonarr (lab)", admin);
        Assert.Contains("/data/tv/The Flash (2014)", admin);
        Assert.Contains("Mock SABnzbd", admin);
    }

    [Fact]
    public void TitleKeysParseNormaliseAndRejectJunk()
    {
        Assert.Equal("movie:tmdb:603", TitleKey.Parse("MOVIE:TMDB:0603")!.ToString());
        Assert.Equal("series:tvdb:78874:s1e2", TitleKey.Parse("series:tvdb:78874:s1e2")!.ToString());
        Assert.Equal("series:tvdb:78874", TitleKey.Parse("series:tvdb:78874:s1e2")!.Title.ToString());
        Assert.Equal("movie:imdb:tt0133093", TitleKey.ForMovie(null, "tt0133093")!.ToString());
        Assert.Equal("series:tmdb:1437", TitleKey.ForSeries(" ", "1437", "tt0303461")!.ToString());
        foreach (var bad in new[] { "", "movie:tvdb:1", "movie:tmdb:1:s1", "series:imdb:123", "movie:tmdb:tt1", "movie:tmdb:0", "x:tmdb:1", "movie:tmdb:1<script>", new string('1', 80) })
            Assert.Null(TitleKey.Parse(bad));
    }

    // ------------------------------------------------------------------ review round 1

    private static string Json(TitleStatus status) => JsonSerializer.Serialize(status, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull });

    [Fact]
    public void ATitleOnlyInLibrariesTheMemberCannotOpenReadsExactlyLikeOneNobodyHas()
    {
        var hidden = new JfCopy { ItemId = Guid.NewGuid(), Visible = false, Path = "/media/adults/Dune Part Two (2024)/Dune.mkv", LibraryName = "Adults" };
        var nobody = Json(StatusComposer.Movie(MovieFacts(), null, Array.Empty<JfCopy>(), Ctx(), detail: false));
        // Whatever Radarr says about it (on disk, downloading an upgrade, both instances), a member who
        // can't open the copy hears exactly what they would about a title no arr and no library has.
        foreach (var facts in new[]
        {
            MovieFacts(Copy(Movie(hasFile: true))),
            MovieFacts(Copy(Movie(hasFile: true), queue: new[] { Row() })),
            MovieFacts(Copy(Movie(path: "/data/movies4k/Dune Part Two (2024)"), Radarr4k, queue: new[] { Row() }), Copy(Movie(hasFile: true))),
        })
        {
            var json = Json(StatusComposer.Movie(facts, null, new[] { hidden }, Ctx(), detail: false));
            Assert.Equal(nobody, json);
            Assert.DoesNotContain(StatusReasonCode.NotVisibleToUser, json);
        }

        // Same for a series by key.
        var (flash, _) = FlashSeason(virtualRows: false);
        var hiddenShow = new JfCopy { ItemId = Guid.NewGuid(), Visible = false, Path = "/media/adults/The Flash (2014)", LibraryName = "Adults" };
        Assert.Equal(Json(StatusComposer.SeriesByKey(new TitleFacts(ShowKey), Array.Empty<JfCopy>(), Ctx())), Json(StatusComposer.SeriesByKey(flash, new[] { hiddenShow }, Ctx())));
        // An admin is still told why.
        Assert.Equal(StatusReasonCode.NotVisibleToUser, Assert.Single(StatusComposer.Movie(MovieFacts(Copy(Movie(hasFile: true))), null, new[] { hidden }, Ctx(Admin), false).Admin!.Variants).Reason.Code);
    }

    [Fact]
    public void EpisodesAndSeasonsJellyfinHidesFromTheViewerAreLeftOutNotAlmostReady()
    {
        // S9E4: Sonarr has the file and Jellyfin has the episode, but this viewer may not see it
        // (its own rating). Season 8: every episode hidden (a blocked tag on the season).
        var (facts, jf) = FlashSeason(virtualRows: false);
        var withHidden = jf.Where(e => e.Season != 8).ToList();
        withHidden.Add(new JfEpisode { Season = 9, Episode = 4, Hidden = true });
        withHidden.Add(new JfEpisode { Season = 8, Episode = 1, Hidden = true });
        withHidden.Add(new JfEpisode { Season = 8, Episode = 2, Hidden = true });
        var seasonItem = new JfItemRef { ItemId = Guid.NewGuid(), Kind = "season", Key = ShowKey.WithSeason(9), SeriesId = SeriesItem, Season = 9 };

        var season = StatusComposer.Season(facts, seasonItem, withHidden, Ctx(), detail: true);
        Assert.DoesNotContain(season.Episodes!, e => e.Episode == 4);
        // E5 (import blocked) is the only one almost ready now.
        Assert.Equal((5, 1, 1, 1, 1), (season.Summary!.Aired, season.Summary.Ready, season.Summary.Downloading, season.Summary.AlmostReady, season.Summary.Missing));
        Assert.DoesNotContain("s9e4", Json(season));

        // Jellyfin reports season 8 itself hidden (the season list), season 9 visible.
        var jfSeasons = new[] { new JfSeason { Season = 8, Hidden = true }, new JfSeason { ItemId = Guid.NewGuid(), Season = 9 } };
        var series = StatusComposer.Series(facts, new JfItemRef { ItemId = SeriesItem, Kind = "series", Key = ShowKey }, withHidden, jfSeasons, Ctx(), detail: true);
        Assert.Equal(new[] { 9 }, series.Seasons!.Select(s => s.Season).ToArray());
        Assert.Equal((1, 1), (series.Summary!.AlmostReady, series.Summary.Ready));

        // From Sonarr's statistics (no episodes in memory): the hidden episode is not pending either.
        var noEpisodes = new TitleFacts(ShowKey);
        noEpisodes.Copies.Add(new ArrCopyFacts(Sonarr) { Series = facts.Copies[0].Series, Queue = facts.Copies[0].Queue });
        var card = StatusComposer.Season(noEpisodes, seasonItem, withHidden, Ctx(), detail: false);
        // 6 aired, 3 files, one of them hidden: 5 aired, 1 ready, 1 downloading, 1 (+1 blocked) almost ready.
        Assert.Equal((5, 1, 1, 2), (card.Summary!.Aired, card.Summary.Ready, card.Summary.Downloading, card.Summary.AlmostReady));
    }

    [Fact]
    public void ASeasonCardCountsATwoPartFileAsTwoReadyEpisodes()
    {
        var series = new ArrSeriesEntry
        {
            Id = 3, TvdbId = 279121, Title = "Show", Monitored = true, Path = "/data/tv/Show",
            // Sonarr counts episodes with a file: the pilot's two parts (one file) and E3.
            Seasons = new[] { new ArrSeasonEntry { SeasonNumber = 1, Monitored = true, EpisodeCount = 3, EpisodeFileCount = 3, TotalEpisodeCount = 3 } },
        };
        var facts = new TitleFacts(ShowKey);
        facts.Copies.Add(new ArrCopyFacts(Sonarr) { Series = series });
        var jf = new[]
        {
            new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, EpisodeEnd = 2 },
            new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 3 },
        };
        var card = StatusComposer.Season(facts, new JfItemRef { ItemId = Guid.NewGuid(), Kind = "season", Key = ShowKey.WithSeason(1), Season = 1, SeriesId = SeriesItem }, jf, Ctx(), detail: false);
        Assert.Equal((StatusStage.Ready, 3, 0), (card.Stage, card.Summary!.Ready, card.Summary.AlmostReady));
    }

    [Fact]
    public void AnAdminSeesProblemsOfEverySonarrHoldingTheSeries()
    {
        var sonarr4k = new ArrConnection { Id = "6d0b7d1c-0000-4000-8000-0000000000a4", Kind = ArrKind.Sonarr, Name = "Sonarr 4K (lab)", Url = "http://sonarr4k.lan:8989", Role = "4k" };
        var (facts, jf) = FlashSeason(virtualRows: false);
        var blocked = Row(status: "completed", state: "importBlocked", tracked: "warning", episodeId: 908, season: 8, episode: 2, messages: new[] { "4K: manual import required" });
        var series4k = Series(path: "/data/tv4k/The Flash (2014)");
        facts.Copies.Add(new ArrCopyFacts(sonarr4k) { Series = series4k, Queue = new[] { blocked } });
        var seasonItem = new JfItemRef { ItemId = Guid.NewGuid(), Kind = "season", Key = ShowKey.WithSeason(8), SeriesId = SeriesItem, Season = 8 };

        var admin = StatusComposer.Season(facts, seasonItem, jf, Ctx(Admin), detail: true);
        var line = admin.Admin!.Variants.Single(v => v.Scope == "S08E02");
        Assert.Equal(("Sonarr 4K (lab)", StatusReasonCode.ImportBlocked, StatusFix.ManualImport), (line.Instance, line.Reason.Code, line.Fix));
        Assert.Contains(admin.Admin.Variants, v => v.Instance == "Sonarr 4K (lab)" && v.Scope == null);
        Assert.True(admin.Attention);
        Assert.False(admin.Quiet);
        // The family shape follows the standard copy only: season 8 is complete and quiet.
        var family = StatusComposer.Season(facts, seasonItem, jf, Ctx(), detail: true);
        Assert.Equal((StatusStage.Ready, false, true), (family.Stage, family.Attention, family.Quiet));

        var page = StatusComposer.Series(facts, new JfItemRef { ItemId = SeriesItem, Kind = "series", Key = ShowKey }, jf, null, Ctx(Admin), detail: true);
        Assert.Contains(page.Admin!.Variants, v => v.Instance == "Sonarr 4K (lab)" && v.Scope == "S08E02");
        var card = StatusComposer.SeriesCard(facts, new JfItemRef { ItemId = SeriesItem, Kind = "series", Key = ShowKey }, Ctx(Admin));
        Assert.Contains(card.Admin!.Variants, v => v.Instance == "Sonarr 4K (lab)" && v.Scope == "S08E02");
        Assert.True(card.Attention);
        var byKey = StatusComposer.SeriesByKey(facts, Array.Empty<JfCopy>(), Ctx(Admin));
        Assert.Contains(byKey.Admin!.Variants, v => v.Instance == "Sonarr 4K (lab)");
        var episode = StatusComposer.Episode(facts, new JfItemRef { ItemId = Guid.NewGuid(), Kind = "episode", Key = ShowKey.WithEpisode(8, 2), SeriesId = SeriesItem, Season = 8, Episode = 2, DateCreated = Now.AddDays(-300) }, Ctx(Admin), detail: true);
        Assert.Contains(episode.Admin!.Variants, v => v.Instance == "Sonarr 4K (lab)" && v.Reason.Code == StatusReasonCode.ImportBlocked);
        Assert.True(episode.Attention);
    }

    [Fact]
    public void ABatchMovieItemIsMatchedToALinkedInstanceByItsLibrary()
    {
        var linked = new ArrConnection { Id = Radarr.Id, Kind = ArrKind.Radarr, Name = "Radarr (lab)", Role = "standard", LinkedLibraryIds = new[] { "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1" } };
        var item = new JfItemRef { ItemId = Guid.NewGuid(), Kind = "movie", Key = MovieKey, Path = "/media/movies/Dune/Dune.mkv", DateCreated = Now.AddDays(-40), LibraryId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1", LibraryName = "Movies" };
        var facts = MovieFacts(Copy(Movie(hasFile: true), linked, queue: new[] { Row() }));
        // The batch route knows only the item (copies: null); it must read like the details route.
        var batch = StatusComposer.Movie(facts, item, null, Ctx(Admin), detail: false);
        Assert.Equal((StatusStage.Ready, StatusReasonCode.Upgrading, false), (batch.Stage, batch.Reason.Code, batch.Quiet));
        Assert.Equal(("Movies", item.ItemId.ToString("N")), (batch.Admin!.Variants[0].Library, batch.Admin.Variants[0].ItemId));
    }

    [Fact]
    public void KeysWithNonAsciiDigitsAreRejectedNotAServerError()
    {
        foreach (var bad in new[] { "series:tvdb:5:s\u0661", "series:tvdb:5:s1e\u0662", "movie:tmdb:\u0661\u0662", "movie:imdb:tt\u0661" })
            Assert.Null(TitleKey.Parse(bad));
    }

    [Fact]
    public void BlockedFoldersChangeTheViewersFingerprintButAreNotAParentalLimit()
    {
        var user = new User("kid", "default", "default") { Id = Guid.NewGuid() };
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(user.Id)).Returns(user);
        using var view = new ArrJellyfinView(new Mock<ILibraryManager>().Object, users.Object);
        var before = view.Viewer(user.Id)!;
        user.SetPreference(PreferenceKind.BlockedMediaFolders, new[] { Guid.NewGuid().ToString("N") });
        var after = view.Viewer(user.Id)!;
        Assert.NotEqual(before.PolicyRevision, after.PolicyRevision);
        // Blocked folders are library access (like EnabledFolders), not a rating or tag limit: a
        // series' seasons and episodes share its library, and titles not in Jellyfin yet stay answerable.
        Assert.Equal((false, false), (before.HasParentalLimit, after.HasParentalLimit));
        user.SetPreference(PreferenceKind.BlockedTags, new[] { "horror" });
        Assert.True(view.Viewer(user.Id)!.HasParentalLimit);
    }

    // ------------------------------------------------------------------ review round 2

    /// <summary>Season 1: E1 on disk, E2 aired without a file. Season 3: E1 aired without a file. Both E2 and S3E1 downloading.</summary>
    private static TitleFacts TwoSeasonsDownloading()
    {
        var series = new ArrSeriesEntry
        {
            Id = 3, TvdbId = 279121, Title = "Show", Monitored = true, Path = "/data/tv/Show", Added = Now.AddDays(-400), EpisodeFileCount = 1, EpisodeCount = 3,
            Seasons = new[]
            {
                new ArrSeasonEntry { SeasonNumber = 1, Monitored = true, EpisodeCount = 2, EpisodeFileCount = 1, TotalEpisodeCount = 2 },
                new ArrSeasonEntry { SeasonNumber = 3, Monitored = true, EpisodeCount = 1, EpisodeFileCount = 0, TotalEpisodeCount = 1 },
            },
        };
        var facts = new TitleFacts(ShowKey);
        facts.Copies.Add(new ArrCopyFacts(Sonarr)
        {
            Series = series,
            Episodes = new ArrEpisodesSnapshot(3, new[] { Ep(1, 1, Now.AddDays(-60), true), Ep(1, 2, Now.AddDays(-53)), Ep(3, 1, Now.AddDays(-5)) }),
            Queue = new[] { Row(episodeId: 102, season: 1, episode: 2, left: 500), Row(episodeId: 301, season: 3, episode: 1, left: 300) },
        });
        return facts;
    }

    [Fact]
    public void SeasonsAreLeftOutOnlyWhenJellyfinHidesTheSeasonNotWhenItsOnlyImportedEpisodeIsHidden()
    {
        var facts = TwoSeasonsDownloading();
        // Season 1 is visible; its only imported episode (E1) is hidden by its own rating. Season 3
        // is hidden by a tag on the season and has no file yet.
        var jf = new[] { new JfEpisode { Season = 1, Episode = 1, Hidden = true } };
        var seasons = new[] { new JfSeason { ItemId = Guid.NewGuid(), Season = 1 }, new JfSeason { Season = 3, Hidden = true } };
        var series = StatusComposer.Series(facts, new JfItemRef { ItemId = SeriesItem, Kind = "series", Key = ShowKey }, jf, seasons, Ctx(), detail: true);
        var one = Assert.Single(series.Seasons!);
        Assert.Equal((1, 1, 0), (one.Season, one.Summary.Downloading, one.Summary.Ready));
        Assert.Equal((StatusStage.Downloading, 1), (series.Stage, series.Summary!.Downloading));
        Assert.Equal(50, series.Progress!.Percent);
        // The season page agrees: E2 downloading, E1 left out.
        var page = StatusComposer.Season(facts, new JfItemRef { ItemId = Guid.NewGuid(), Kind = "season", Key = ShowKey.WithSeason(1), SeriesId = SeriesItem, Season = 1 }, jf, Ctx(), detail: true);
        Assert.Equal(new[] { 2 }, page.Episodes!.Select(e => e.Episode).ToArray());
        Assert.Equal(1, page.Summary!.Downloading);
    }

    [Fact]
    public void QueueOnlySeriesSurfacesDoNotCountDownloadsOfPartsHiddenFromTheViewer()
    {
        var facts = TwoSeasonsDownloading();
        var item = new JfItemRef { ItemId = SeriesItem, Kind = "series", Key = ShowKey };
        var visibleCopy = new JfCopy { ItemId = SeriesItem, Visible = true, Path = "/media/tv/Show" };
        // S1E2 is hidden (in Jellyfin with its own tag: an upgrade) and season 3 too.
        var (_, hidden) = StatusComposer.SplitHidden(new[] { new JfEpisode { Season = 1, Episode = 2, Hidden = true } }, new[] { new JfSeason { Season = 3, Hidden = true } });
        var card = StatusComposer.SeriesCard(facts, item, Ctx(), hidden);
        Assert.Equal((StatusStage.Ready, true, 0), (card.Stage, card.Quiet, card.Summary!.Downloading));
        Assert.Null(card.Progress);
        var byKey = StatusComposer.SeriesByKey(facts, new[] { visibleCopy }, Ctx(), hidden);
        Assert.Equal((StatusStage.Ready, StatusReasonCode.Ready), (byKey.Stage, byKey.Reason.Code));
        Assert.Null(byKey.Progress);

        // Only season 3 hidden: E2's download still counts.
        var (_, season3) = StatusComposer.SplitHidden(null, new[] { new JfSeason { Season = 3, Hidden = true } });
        var partly = StatusComposer.SeriesCard(facts, item, Ctx(), season3);
        Assert.Equal((StatusStage.Downloading, 1, 50), (partly.Stage, partly.Summary!.Downloading, partly.Progress!.Percent));
        Assert.Equal(StatusStage.Downloading, StatusComposer.SeriesByKey(facts, new[] { visibleCopy }, Ctx(), season3).Stage);
        // Nothing hidden: both.
        Assert.Equal(2, StatusComposer.SeriesCard(facts, item, Ctx()).Summary!.Downloading);
    }

    [Fact]
    public void AMemberWhoCannotOpenThe4kLibraryStillFollowsTheStandardDownload()
    {
        // Mock 01: the 4K copy of Dune is in Movies 4K (Radarr 4K has the file); Emma can't open that
        // library. Radarr (standard) is downloading it: she sees the standard journey.
        var hidden4k = new JfCopy { ItemId = Guid.NewGuid(), Visible = false, Path = "/media/movies4k/Dune Part Two (2024)/Dune.mkv", LibraryName = "Movies 4K" };
        var facts = MovieFacts(
            Copy(Movie(hasFile: true, path: "/data/movies4k/Dune Part Two (2024)"), Radarr4k),
            Copy(Movie(), queue: new[] { Row() }));
        var family = StatusComposer.Movie(facts, null, new[] { hidden4k }, Ctx(), detail: false);
        Assert.Equal((StatusStage.Downloading, StatusReasonCode.Downloading, 42), (family.Stage, family.Reason.Code, family.Progress!.Percent));
        Assert.DoesNotContain(StatusReasonCode.NotVisibleToUser, Json(family));
        // The same as if the hidden 4K copy didn't exist.
        Assert.Equal(Json(StatusComposer.Movie(MovieFacts(Copy(Movie(), queue: new[] { Row() })), null, Array.Empty<JfCopy>(), Ctx(), false)), Json(family));

        // Series by key: a hidden 4K copy matched to the 4K Sonarr; the standard Sonarr is downloading.
        var sonarr4k = new ArrConnection { Id = "6d0b7d1c-0000-4000-8000-0000000000a4", Kind = ArrKind.Sonarr, Name = "Sonarr 4K (lab)", Url = "http://sonarr4k.lan:8989", Role = "4k" };
        var show = TwoSeasonsDownloading();
        var standard = show.Copies[0];
        var noFiles = new ArrSeriesEntry { Id = standard.Series!.Id, TvdbId = 279121, Title = "Show", Monitored = true, Path = "/data/tv/Show", Seasons = standard.Series.Seasons };
        show.Copies[0] = new ArrCopyFacts(Sonarr) { Series = noFiles, Queue = standard.Queue };
        show.Copies.Add(new ArrCopyFacts(sonarr4k) { Series = new ArrSeriesEntry { Id = 9, TvdbId = 279121, Title = "Show", Monitored = true, Path = "/data/tv4k/Show", EpisodeFileCount = 3 } });
        var hiddenShow = new JfCopy { ItemId = Guid.NewGuid(), Visible = false, Path = "/media/tv4k/Show", LibraryName = "TV 4K" };
        Assert.Equal(StatusStage.Downloading, StatusComposer.SeriesByKey(show, new[] { hiddenShow }, Ctx()).Stage);
    }

    [Fact]
    public void EpisodesAndSeasonsHiddenFromTheViewerAreFoundWithOrWithoutAFile()
    {
        Guid e1 = Guid.NewGuid(), e2 = Guid.NewGuid(), e3 = Guid.NewGuid(), e4 = Guid.NewGuid();
        var all = new[]
        {
            new ArrJellyfinView.EpisodeFacts(e1, 1, 1, null, false), // in the user's list
            new ArrJellyfinView.EpisodeFacts(e2, 1, 2, null, false), // real, left out: hidden
            new ArrJellyfinView.EpisodeFacts(e3, 1, 3, null, true),  // virtual, left out only because missing episodes weren't asked for
            new ArrJellyfinView.EpisodeFacts(e4, 1, 4, null, true),  // virtual and hidden (its own tag)
        };
        var reads = 0;
        var hidden = ArrJellyfinView.HiddenEpisodes(all, null, new HashSet<Guid> { e1 }, false, () => { reads++; return new HashSet<Guid> { e1, e3 }; });
        Assert.Equal(new[] { (2, false), (4, true) }, hidden.Select(h => (h.Episode, h.Virtual)).ToArray());
        Assert.All(hidden, h => Assert.True(h.Hidden && h.ItemId == Guid.Empty));
        Assert.Equal(1, reads);
        // The user's list already had missing episodes: no second read.
        Assert.Equal(new[] { 2, 4 }, ArrJellyfinView.HiddenEpisodes(all, 1, new HashSet<Guid> { e1, e3 }, true, () => throw new InvalidOperationException()).Select(h => h.Episode).ToArray());
        // No virtual episode left out: no second read either.
        Assert.Equal(new[] { 2 }, ArrJellyfinView.HiddenEpisodes(all.Take(2), null, new HashSet<Guid> { e1 }, false, () => throw new InvalidOperationException()).Select(h => h.Episode).ToArray());

        // Seasons: S2 is a missing season the user's list leaves out (missing episodes not shown) but
        // they may open it; S3 is blocked; S4 has a blocked and an open item.
        Guid s1 = Guid.NewGuid(), s2 = Guid.NewGuid(), s3 = Guid.NewGuid(), s4a = Guid.NewGuid(), s4b = Guid.NewGuid();
        var open = new HashSet<Guid> { s1, s2, s4b };
        var seasons = ArrJellyfinView.HiddenSeasonNumbers(new (Guid, int?)[] { (s1, 1), (s2, 2), (s3, 3), (s4a, 4), (s4b, 4), (Guid.NewGuid(), null) }, new[] { 1 }, open.Contains);
        Assert.Equal(new[] { 3 }, seasons.ToArray());
    }
}
