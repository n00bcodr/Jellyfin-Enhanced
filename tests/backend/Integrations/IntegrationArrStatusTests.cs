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
    private static readonly TitleKey ShowKey = TitleKey.Parse("tv:tvdb:279121")!;

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
        // One precedence table: a finished download the arr warns about is waiting to import (never
        // "downloading" with no attention), and a state the table doesn't know never looks like progress.
        ("finished, still 'downloading' with a warning (can't import)", () => Copy(Movie(), queue: new[] { Row(status: "completed", state: "downloading", tracked: "warning", left: 0, messages: new[] { "Not a valid local path" }) }), StatusStage.AlmostReady, StatusReasonCode.ImportBlocked, true),
        ("download client unavailable (no tracked fields)", () => Copy(Movie(), queue: new[] { Bare("downloadClientUnavailable") }), StatusStage.Downloading, StatusReasonCode.ClientUnavailable, true),
        ("fallback (delay profile)", () => Copy(Movie(), queue: new[] { Row(status: "fallback") }), StatusStage.Downloading, StatusReasonCode.DelayHeld, false),
        ("paused with a warning", () => Copy(Movie(), queue: new[] { Row(status: "paused", tracked: "warning") }), StatusStage.Downloading, StatusReasonCode.Stalled, true),
        ("a future state the table doesn't know", () => Copy(Movie(), queue: new[] { Row(status: "futureState", state: "futureState") }), StatusStage.Downloading, StatusReasonCode.Queued, false),
        ("finished but ignored", () => Copy(Movie(), queue: new[] { Row(status: "completed", state: "ignored") }), StatusStage.Downloading, StatusReasonCode.Queued, false),
        ("states in other letter cases", () => Copy(Movie(), queue: new[] { Row(status: "Completed", state: "ImportBlocked", tracked: "Warning") }), StatusStage.AlmostReady, StatusReasonCode.ImportBlocked, true),
    };

    /// <summary>The table rows whose status carries progress (only an explicit "downloading").</summary>
    private static readonly HashSet<string> RowsWithProgress = new() { "downloading", "stalled (arr warning)" };

    /// <summary>A queue row with only a client status (no tracked state or health, nothing downloaded).</summary>
    private static ArrQueueEntry Bare(string status)
        => new() { Id = 9, DownloadId = "dl9", Status = status, Size = 1000, SizeLeft = 1000, TimeLeft = "00:10:00", MovieId = 7, Added = Now.AddMinutes(-30) };

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
        Assert.True(RowsWithProgress.Contains(scenario) == (status.Progress != null), $"{scenario}: progress {status.Progress?.Percent}");
        Assert.Null(status.Admin);
        // The Overview's Needs attention list reads the same rows by the same table.
        if (copy?.Queue.Count > 0)
        {
            var q = copy.Queue[0];
            Assert.True(row.Attention == (NeedsAttention.ProblemOf(q.TrackedDownloadState, q.TrackedDownloadStatus, q.Status) != null), $"{scenario}: Needs attention disagrees");
        }
    }

    [Fact]
    public void TheBestRowOfSeveralIsChosenByTheSameTable()
    {
        // A finished download the arr can't import outranks a healthy one further along (less left).
        var healthy = Row(left: 10);
        var stuck = Row(status: "completed", state: "downloading", tracked: "warning", left: 500);
        var status = StatusComposer.Movie(MovieFacts(Copy(Movie(), queue: new[] { healthy, stuck })), null, Array.Empty<JfCopy>(), Ctx(), false);
        Assert.Equal((StatusStage.AlmostReady, StatusReasonCode.ImportBlocked, true), Of(status));
        var admin = StatusComposer.Movie(MovieFacts(Copy(Movie(), queue: new[] { Bare("downloadClientUnavailable") })), null, Array.Empty<JfCopy>(), Ctx(Admin), false);
        Assert.Equal(StatusFix.CheckClient, Assert.Single(admin.Admin!.Variants).Fix);
    }

    [Fact]
    public void ProblemsAreTimedFromWhenJeFirstSawThemWaitingDownloadsFromTheGrab()
    {
        // Added 30 min ago, first seen blocked 20 min ago: the reason's "since" is JE's first sight.
        var blocked = Row(status: "completed", state: "importBlocked", tracked: "warning");
        var seenAt = Now.AddMinutes(-20);
        var copy = new ArrCopyFacts(Radarr) { Movie = Movie(), Queue = new[] { blocked }, Seen = r => new ArrQueueSeen(ArrQueueClass.ImportBlocked, seenAt, seenAt) };
        var status = StatusComposer.Movie(MovieFacts(copy), null, Array.Empty<JfCopy>(), Ctx(Admin), false);
        Assert.Equal("2026-10-12T11:40:00Z", status.Reason.Params!["since"]);
        Assert.Equal(seenAt, Assert.Single(status.Admin!.Variants).Since);
        // A clock for another class (the row changed since it was stamped): first seen now.
        var stale = new ArrCopyFacts(Radarr) { Movie = Movie(), Queue = new[] { blocked }, Seen = r => new ArrQueueSeen(ArrQueueClass.Downloading, seenAt, null) };
        Assert.Equal(Now, Assert.Single(StatusComposer.Movie(MovieFacts(stale), null, Array.Empty<JfCopy>(), Ctx(Admin), false).Admin!.Variants).Since);
        // No stamp yet: first seen now.
        var none = new ArrCopyFacts(Radarr) { Movie = Movie(), Queue = new[] { blocked }, Seen = r => null };
        Assert.Equal(Now, Assert.Single(StatusComposer.Movie(MovieFacts(none), null, Array.Empty<JfCopy>(), Ctx(Admin), false).Admin!.Variants).Since);
        // A download waiting in line keeps the grab time.
        var queued = new ArrCopyFacts(Radarr) { Movie = Movie(), Queue = new[] { Row(status: "queued") }, Seen = r => new ArrQueueSeen(ArrQueueClass.Queued, seenAt, null) };
        Assert.Equal(Now.AddMinutes(-30), Assert.Single(StatusComposer.Movie(MovieFacts(queued), null, Array.Empty<JfCopy>(), Ctx(Admin), false).Admin!.Variants).Since);
    }

    [Fact]
    public void TheFirstSeenClockKeepsRunningThroughProblemsAndStartsAgainAfterHealth()
    {
        var t0 = Now;
        var blocked = ArrStateStore.Advance(null, ArrQueueClass.ImportBlocked, t0);
        Assert.Equal((t0, (DateTime?)t0), (blocked.ReasonSince, blocked.AttentionSince));
        // Repeated reads keep it; stalled -> blocked is the same trouble.
        Assert.Same(blocked, ArrStateStore.Advance(blocked, ArrQueueClass.ImportBlocked, t0.AddHours(1)));
        var stalled = ArrStateStore.Advance(null, ArrQueueClass.Warned, t0);
        var then = ArrStateStore.Advance(stalled, ArrQueueClass.ImportBlocked, t0.AddHours(2));
        Assert.Equal((ArrQueueClass.ImportBlocked, t0, (DateTime?)t0), (then.Class, then.ReasonSince, then.AttentionSince));
        // Blocked -> healthy -> blocked starts again.
        var healthy = ArrStateStore.Advance(then, ArrQueueClass.Importing, t0.AddHours(3));
        Assert.Null(healthy.AttentionSince);
        var again = ArrStateStore.Advance(healthy, ArrQueueClass.ImportBlocked, t0.AddHours(4));
        Assert.Equal(t0.AddHours(4), again.AttentionSince);
    }

    [Fact]
    public void AnExpiredQueueIsUnknownNeverLookingOrAFrozenDownload()
    {
        // The instance's queue is past its longest serve time and can't be read: its rows are gone
        // from the facts, and the title isn't "looking" (nor "not in any arr").
        var unknown = new ArrCopyFacts(Radarr) { Movie = Movie(), QueueUnknown = true };
        var status = StatusComposer.Movie(MovieFacts(unknown), null, Array.Empty<JfCopy>(), Ctx(), false);
        Assert.Equal(StatusReasonCode.ServiceDown, status.Reason.Code);
        Assert.Null(status.Progress);
        // The library still says the file is there: almost ready, as before.
        Assert.Equal(StatusReasonCode.LibraryPending, StatusComposer.Movie(MovieFacts(new ArrCopyFacts(Radarr) { Movie = Movie(hasFile: true), QueueUnknown = true }), null, Array.Empty<JfCopy>(), Ctx(), false).Reason.Code);
        // A Ready title stays Ready (no "a better copy is coming" from an expired queue).
        var item = new JfItemRef { ItemId = Guid.NewGuid(), Kind = "movie", Key = MovieKey, DateCreated = Now.AddDays(-40) };
        Assert.Equal(StatusReasonCode.Ready, StatusComposer.Movie(MovieFacts(new ArrCopyFacts(Radarr) { Movie = Movie(hasFile: true), QueueUnknown = true }), item, null, Ctx(), false).Reason.Code);
        // An episode of an expired Sonarr that has aired and isn't here: can't be checked, and the
        // series isn't "Ready" for it.
        var series = new ArrSeriesEntry { Id = 3, TvdbId = 279121, Title = "Show", Monitored = true };
        var episodes = new ArrEpisodesSnapshot(3, new[] { new ArrEpisodeEntry { Id = 31, SeasonNumber = 1, EpisodeNumber = 1, AirDateUtc = Now.AddDays(-3), Monitored = true } });
        var sonarr = new ArrCopyFacts(Sonarr) { Series = series, Episodes = episodes, QueueUnknown = true };
        Assert.Equal(StatusReasonCode.ServiceDown, StatusComposer.EpisodeFromArr(sonarr, 1, 1, episodes.Find(1, 1), Ctx()).Reason);
    }

    [Fact]
    public void TheTimeLeftCountsFromWhenTheQueueWasReadAndGoesOnceItIsStale()
    {
        var row = new ArrQueueEntry { Id = 1, Status = "downloading", TrackedDownloadState = "downloading", TrackedDownloadStatus = "ok", Size = 100, SizeLeft = 75, TimeLeft = "00:10:00", MovieId = 7 };
        var read4MinAgo = new ArrCopyFacts(Radarr) { Movie = Movie(), QueueLoadedAt = Now.AddMinutes(-4) };
        Assert.Equal(360L, StatusComposer.Progress(row, Ctx(), read4MinAgo)!.EtaSeconds);
        var stale = new ArrCopyFacts(Radarr) { Movie = Movie(), QueueLoadedAt = Now.AddMinutes(-4), QueueStale = true };
        var progress = StatusComposer.Progress(row, Ctx(), stale)!;
        Assert.Equal((25, (long?)null), (progress.Percent, progress.EtaSeconds));
    }

    [Fact]
    public void AnOkdRequestIsOverdueOnlyForAVariantJeWatches()
    {
        var ctx = new ComposeContext(Admin, Now, 24) { HandoffGrace = TimeSpan.FromMinutes(15) };
        var approved = Now.AddHours(-1);
        // Only a standard Radarr is watched; only a 4K request was OK'd: no verdict ("not in any arr" stays).
        var facts = MovieFacts();
        facts.Checked.Add(Radarr);
        facts.Request = new RequestFacts { ApprovedAt = approved, Approved4kAt = approved };
        Assert.Equal(StatusReasonCode.Approved, StatusComposer.Movie(facts, null, Array.Empty<JfCopy>(), ctx, false).Reason.Code);
        // The standard request is judged on the standard Radarr.
        facts.Request = new RequestFacts { ApprovedAt = approved, ApprovedStandardAt = approved };
        Assert.Equal(StatusReasonCode.ApprovedNotInArr, StatusComposer.Movie(facts, null, Array.Empty<JfCopy>(), ctx, false).Reason.Code);
        // With a 4K Radarr watched too, a 4K request's verdict comes from it (a stale 4K read: none).
        facts.Checked.Add(Radarr4k);
        facts.Request = new RequestFacts { ApprovedAt = approved, Approved4kAt = approved };
        Assert.Equal(StatusReasonCode.ApprovedNotInArr, StatusComposer.Movie(facts, null, Array.Empty<JfCopy>(), ctx, false).Reason.Code);
        facts.Stale.Add(Radarr4k);
        Assert.Equal(StatusReasonCode.Approved, StatusComposer.Movie(facts, null, Array.Empty<JfCopy>(), ctx, false).Reason.Code);
    }

    [Fact]
    public void DateOnlyReleaseDaysAreSentAsDaysEpisodeTimesAsInstants()
    {
        var notOut = StatusComposer.Movie(MovieFacts(Copy(Movie(available: false, cinemas: new DateTime(2026, 11, 14, 0, 0, 0, DateTimeKind.Utc)))), null, Array.Empty<JfCopy>(), Ctx(), false);
        Assert.Equal(("2026-11-14", "2026-11-14"), (notOut.Reason.Params!["date"], notOut.NextDay));
        var series = new ArrSeriesEntry { Id = 3, TvdbId = 279121, Title = "Show", Monitored = true };
        var timed = new ArrEpisodeEntry { Id = 31, SeasonNumber = 1, EpisodeNumber = 1, AirDateUtc = new DateTime(2026, 11, 14, 2, 0, 0, DateTimeKind.Utc), Monitored = true };
        var dayOnly = new ArrEpisodeEntry { Id = 32, SeasonNumber = 1, EpisodeNumber = 2, AirDateUtc = new DateTime(2026, 11, 21, 0, 0, 0, DateTimeKind.Utc), AirDateIsDay = true, Monitored = true };
        var copy = new ArrCopyFacts(Sonarr) { Series = series, Episodes = new ArrEpisodesSnapshot(3, new[] { timed, dayOnly }) };
        Assert.Equal("2026-11-14T02:00:00Z", StatusComposer.Episode(EpisodeFacts(copy), Virtual(1, 1), Ctx(), false).Reason.Params!["date"]);
        var day = StatusComposer.Episode(EpisodeFacts(copy), Virtual(1, 2), Ctx(), false);
        Assert.Equal(("2026-11-21", "2026-11-21"), (day.Reason.Params!["date"], day.NextDay));

        static TitleFacts EpisodeFacts(ArrCopyFacts c)
        {
            var f = new TitleFacts(ShowKey);
            f.Copies.Add(c);
            return f;
        }

        static JfItemRef Virtual(int s, int e) => new() { ItemId = Guid.NewGuid(), Kind = "episode", Key = ShowKey.WithEpisode(s, e), Season = s, Episode = e, Virtual = true };
    }

    [Fact]
    public void ADateOnlyNextEpisodeStaysADayOnTheSeasonTheSeriesAndARequestedSeason()
    {
        // Sonarr gave only the air date of S2E1 (no time): the season, the series and a request for
        // Season 2 carry it as a day, never as the instant midnight UTC (a day early west of UTC).
        var series = new ArrSeriesEntry
        {
            Id = 3, TvdbId = 279121, Title = "Show", Monitored = true, Added = Now.AddDays(-100),
            Seasons = new[] { new ArrSeasonEntry { SeasonNumber = 1, Monitored = true, TotalEpisodeCount = 1 }, new ArrSeasonEntry { SeasonNumber = 2, Monitored = true, TotalEpisodeCount = 1 } },
        };
        var aired = new ArrEpisodeEntry { Id = 11, SeasonNumber = 1, EpisodeNumber = 1, AirDateUtc = Now.AddDays(-30), HasFile = true, Monitored = true };
        var dayOnly = new ArrEpisodeEntry { Id = 21, SeasonNumber = 2, EpisodeNumber = 1, AirDateUtc = new DateTime(2026, 11, 21, 0, 0, 0, DateTimeKind.Utc), AirDateIsDay = true, Monitored = true };
        var facts = new TitleFacts(ShowKey);
        facts.Copies.Add(new ArrCopyFacts(Sonarr) { Series = series, Episodes = new ArrEpisodesSnapshot(3, new[] { aired, dayOnly }) });
        var jf = new List<JfEpisode> { new() { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = Now.AddDays(-29) } };
        var season = StatusComposer.Season(facts, new JfItemRef { ItemId = Guid.NewGuid(), Kind = "season", Key = ShowKey.WithSeason(2), SeriesId = SeriesItem, Season = 2 }, jf, Ctx(), detail: false);
        Assert.Equal(("2026-11-21", true), (season.NextDay, season.Summary!.NextAirIsDay));
        var whole = StatusComposer.Series(facts, new JfItemRef { ItemId = SeriesItem, Kind = "series", Key = ShowKey }, jf, null, Ctx(), detail: false);
        Assert.Equal("2026-11-21", whole.NextDay);
        var copies = new[] { new JfCopy { ItemId = SeriesItem, Visible = true, Path = "/data/tv/Show" } };
        var (requested, _) = StatusComposer.RequestedSeasons(facts, whole, new[] { 2 }, jf, copies, Ctx());
        Assert.Equal((StatusStage.NotOut, "2026-11-21", "2026-11-21"), (requested.Stage, requested.Reason.Params!["date"], requested.NextDay));
        // A timed episode stays an instant.
        var timedFacts = new TitleFacts(ShowKey);
        timedFacts.Copies.Add(new ArrCopyFacts(Sonarr) { Series = series, Episodes = new ArrEpisodesSnapshot(3, new[] { aired, new ArrEpisodeEntry { Id = 21, SeasonNumber = 2, EpisodeNumber = 1, AirDateUtc = new DateTime(2026, 11, 21, 2, 0, 0, DateTimeKind.Utc), Monitored = true } }) });
        Assert.Null(StatusComposer.Series(timedFacts, new JfItemRef { ItemId = SeriesItem, Kind = "series", Key = ShowKey }, jf, null, Ctx(), detail: false).NextDay);
    }

    [Fact]
    public void ARequestedSeasonWithNothingHereYetIsLookingNotSomeEpisodesHere()
    {
        // Season 2 asked for: Sonarr has its three aired episodes monitored, none on disk, none in
        // Jellyfin. Nothing is here, so it is never "Some episodes here, looking for the rest".
        var series = new ArrSeriesEntry { Id = 3, TvdbId = 279121, Title = "Show", Monitored = true, Added = Now.AddHours(-2) };
        var episodes = new ArrEpisodesSnapshot(3, new[]
        {
            new ArrEpisodeEntry { Id = 11, SeasonNumber = 1, EpisodeNumber = 1, AirDateUtc = Now.AddDays(-300), HasFile = true, Monitored = true },
            new ArrEpisodeEntry { Id = 21, SeasonNumber = 2, EpisodeNumber = 1, AirDateUtc = Now.AddDays(-30), Monitored = true },
            new ArrEpisodeEntry { Id = 22, SeasonNumber = 2, EpisodeNumber = 2, AirDateUtc = Now.AddDays(-23), Monitored = true },
            new ArrEpisodeEntry { Id = 23, SeasonNumber = 2, EpisodeNumber = 3, AirDateUtc = Now.AddDays(-16), Monitored = true },
        });
        var facts = new TitleFacts(ShowKey);
        facts.Copies.Add(new ArrCopyFacts(Sonarr) { Series = series, Episodes = episodes });
        var jf = new List<JfEpisode> { new() { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = Now.AddDays(-299) } };
        var copies = new[] { new JfCopy { ItemId = SeriesItem, Visible = true, Path = "/data/tv/Show" } };
        var whole = StatusComposer.Series(facts, new JfItemRef { ItemId = SeriesItem, Kind = "series", Key = ShowKey }, jf, null, Ctx(), detail: false);
        var (requested, _) = StatusComposer.RequestedSeasons(facts, whole, new[] { 2 }, jf, copies, Ctx());
        Assert.Equal((StatusStage.Looking, StatusReasonCode.Looking), (requested.Stage, requested.Reason.Code));
        var season = StatusComposer.Season(facts, new JfItemRef { ItemId = Guid.NewGuid(), Kind = "season", Key = ShowKey.WithSeason(2), SeriesId = SeriesItem, Season = 2 }, jf, Ctx(), detail: false);
        Assert.Equal(StatusReasonCode.Looking, season.Reason.Code);
        // One of them here: now some are.
        jf.Add(new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 1, DateCreated = Now.AddDays(-1) });
        var (partial, _) = StatusComposer.RequestedSeasons(facts, whole, new[] { 2 }, jf, copies, Ctx());
        Assert.Equal(StatusReasonCode.Partial, partial.Reason.Code);
    }

    [Fact]
    public void ASeriesSeasonOrRequestWhoseMissingEpisodesAreAllMissingForALongWhileReadsMissing()
    {
        // Season 2's three aired, monitored episodes have had nothing grabbed for weeks (each reads "Missing" on its
        // episode page). The season, the series (nothing of it here) and a request for Season 2 (the Household card)
        // read "Missing" too, not "Looking for it", with the earliest "missing since".
        var series = new ArrSeriesEntry
        {
            Id = 3, TvdbId = 279121, Title = "Show", Monitored = true, Added = Now.AddDays(-100),
            Seasons = new[] { new ArrSeasonEntry { SeasonNumber = 2, Monitored = true, TotalEpisodeCount = 3 } },
        };
        var list = new[]
        {
            new ArrEpisodeEntry { Id = 21, SeasonNumber = 2, EpisodeNumber = 1, AirDateUtc = Now.AddDays(-30), Monitored = true },
            new ArrEpisodeEntry { Id = 22, SeasonNumber = 2, EpisodeNumber = 2, AirDateUtc = Now.AddDays(-23), Monitored = true },
            new ArrEpisodeEntry { Id = 23, SeasonNumber = 2, EpisodeNumber = 3, AirDateUtc = Now.AddDays(-16), Monitored = true },
        };
        TitleFacts Facts(IReadOnlyList<ArrEpisodeEntry> episodes, RequestFacts? request = null, IReadOnlyList<ArrQueueEntry>? queue = null)
        {
            var f = new TitleFacts(ShowKey) { Request = request };
            f.Copies.Add(new ArrCopyFacts(Sonarr) { Series = series, Episodes = new ArrEpisodesSnapshot(3, episodes), Queue = queue ?? Array.Empty<ArrQueueEntry>() });
            return f;
        }
        var seriesItem = new JfItemRef { ItemId = SeriesItem, Kind = "series", Key = ShowKey };
        var seasonItem = new JfItemRef { ItemId = Guid.NewGuid(), Kind = "season", Key = ShowKey.WithSeason(2), SeriesId = SeriesItem, Season = 2 };
        var copies = new[] { new JfCopy { ItemId = SeriesItem, Visible = true, Path = "/data/tv/Show" } };
        var jf = new List<JfEpisode>();
        var facts = Facts(list);
        var whole = StatusComposer.Series(facts, seriesItem, jf, null, Ctx(), detail: true);
        var season = StatusComposer.Season(facts, seasonItem, jf, Ctx(), detail: false);
        var (requested, _) = StatusComposer.RequestedSeasons(facts, whole, new[] { 2 }, jf, copies, Ctx());
        var (single, _) = StatusComposer.RequestedSeasons(facts, whole, Array.Empty<int>(), jf, copies, Ctx(), episodes: new[] { (2, 2) });
        foreach (var status in new[] { whole, season, requested, single })
        {
            Assert.Equal((StatusStage.Looking, StatusReasonCode.NoReleaseYet, false), Of(status));
            Assert.False(status.Reason.Params?.ContainsKey("sent") == true);
        }
        Assert.Equal((StatusStage.Looking, 3), (Assert.Single(whole.Seasons!).Stage, whole.Seasons![0].Summary.LongMissing));
        Assert.Equal(("2026-09-12T12:00:00Z", 3), (whole.Reason.Params!["since"], whole.Summary!.LongMissing));
        Assert.Equal("2026-09-19T12:00:00Z", single.Reason.Params!["since"]);
        using (var json = JsonDocument.Parse(Json(requested)))
            Assert.Equal(3, json.RootElement.GetProperty("summary").GetProperty("longMissing").GetInt32());

        // A request that went out for all of them more than the looking hours ago: plain Search (sent), as on the
        // episode page. One that sent only some: a Search would ask for the rest, so no `sent`.
        var sentAll = new RequestFacts { Sent = new[] { new RequestSentPart(false, 2, null, Now.AddHours(-30)) } };
        Assert.Equal("1", StatusComposer.RequestedSeasons(Facts(list, sentAll), whole, new[] { 2 }, jf, copies, Ctx()).Status.Reason.Params!["sent"]);
        Assert.Equal("1", StatusComposer.Season(Facts(list, sentAll), seasonItem, jf, Ctx(), detail: false).Reason.Params!["sent"]);
        var sentOne = new RequestFacts { Sent = new[] { new RequestSentPart(false, 2, 1, Now.AddHours(-30)) } };
        Assert.False(StatusComposer.Season(Facts(list, sentOne), seasonItem, jf, Ctx(), detail: false).Reason.Params!.ContainsKey("sent"));

        // One of them is still fresh (a request for it went out an hour ago): the scope is still "Looking for it".
        var fresh = new RequestFacts { Sent = new[] { new RequestSentPart(false, 2, 3, Now.AddHours(-1)) } };
        Assert.Equal(StatusReasonCode.Looking, StatusComposer.Season(Facts(list, fresh), seasonItem, jf, Ctx(), detail: false).Reason.Code);
        Assert.Equal(StatusReasonCode.Looking, StatusComposer.RequestedSeasons(Facts(list, fresh), whole, new[] { 2 }, jf, copies, Ctx()).Status.Reason.Code);
        // One downloading: Downloading, never Missing.
        var downloading = Facts(list, queue: new[] { Row(episodeId: 21, season: 2, episode: 1) });
        Assert.Equal(StatusStage.Downloading, StatusComposer.Season(downloading, seasonItem, jf, Ctx(), detail: false).Stage);
        // Some of it here: the scope as a whole isn't missing ("Some episodes here"); the missing episodes' own states say Missing.
        jf.Add(new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 1, DateCreated = Now.AddDays(-1) });
        Assert.Equal(StatusReasonCode.Partial, StatusComposer.Season(facts, seasonItem, jf, Ctx(), detail: false).Reason.Code);
        Assert.Equal(StatusReasonCode.Partial, StatusComposer.Series(facts, seriesItem, jf, null, Ctx(), detail: false).Reason.Code);
        Assert.Equal(StatusReasonCode.Partial, StatusComposer.RequestedSeasons(facts, whole, new[] { 2 }, jf, copies, Ctx()).Status.Reason.Code);
    }

    [Fact]
    public void ASeriesWhoseDownloadsCantBeCheckedIsServiceDownNotPartial()
    {
        // Sonarr's queue expired: its six aired, wanted episodes that aren't here can't be checked;
        // four are in Jellyfin. The season, the series and the request say "can't be checked".
        var series = new ArrSeriesEntry { Id = 3, TvdbId = 279121, Title = "Show", Monitored = true, Added = Now.AddDays(-100) };
        var list = Enumerable.Range(1, 10).Select(n => new ArrEpisodeEntry { Id = 100 + n, SeasonNumber = 1, EpisodeNumber = n, AirDateUtc = Now.AddDays(-20 + n), HasFile = n <= 4, Monitored = true }).ToArray();
        var facts = new TitleFacts(ShowKey);
        facts.Copies.Add(new ArrCopyFacts(Sonarr) { Series = series, Episodes = new ArrEpisodesSnapshot(3, list), QueueUnknown = true });
        var jf = Enumerable.Range(1, 4).Select(n => new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = n, DateCreated = Now.AddDays(-10) }).ToList();
        var copies = new[] { new JfCopy { ItemId = SeriesItem, Visible = true, Path = "/data/tv/Show" } };
        var whole = StatusComposer.Series(facts, new JfItemRef { ItemId = SeriesItem, Kind = "series", Key = ShowKey }, jf, null, Ctx(), detail: false);
        Assert.Equal((StatusStage.Looking, StatusReasonCode.ServiceDown), (whole.Stage, whole.Reason.Code));
        var season = StatusComposer.Season(facts, new JfItemRef { ItemId = Guid.NewGuid(), Kind = "season", Key = ShowKey.WithSeason(1), SeriesId = SeriesItem, Season = 1 }, jf, Ctx(), detail: false);
        Assert.Equal(StatusReasonCode.ServiceDown, season.Reason.Code);
        var (requested, _) = StatusComposer.RequestedSeasons(facts, whole, new[] { 1 }, jf, copies, Ctx());
        Assert.Equal(StatusReasonCode.ServiceDown, requested.Reason.Code);
        foreach (var status in new[] { whole, season, requested })
        {
            using var json = JsonDocument.Parse(Json(status));
            var summary = json.RootElement.GetProperty("summary");
            Assert.Equal(6, summary.GetProperty("missing").GetInt32());
            Assert.Equal(summary.GetProperty("missing").GetInt32(), summary.GetProperty("unknown").GetInt32());
        }
        // Readable again: some here, looking for the rest.
        var readable = new TitleFacts(ShowKey);
        readable.Copies.Add(new ArrCopyFacts(Sonarr) { Series = series, Episodes = new ArrEpisodesSnapshot(3, list) });
        Assert.Equal(StatusReasonCode.Partial, StatusComposer.Series(readable, new JfItemRef { ItemId = SeriesItem, Kind = "series", Key = ShowKey }, jf, null, Ctx(), detail: false).Reason.Code);
    }

    [Fact]
    public void AnOverdueVariantIsFlaggedForAdminsEvenWhileTheOtherVariantsCopyLeadsTheTitle()
    {
        var ctx = new ComposeContext(Admin, Now, 24) { HandoffGrace = TimeSpan.FromMinutes(15) };
        var approved = Now.AddDays(-2);
        // Both OK'd two days ago; Radarr 4K has it (looking), the standard Radarr JE watches doesn't.
        var facts = MovieFacts(Copy(Movie(), Radarr4k));
        facts.Checked.Add(Radarr);
        facts.Checked.Add(Radarr4k);
        facts.Request = new RequestFacts { ApprovedAt = approved, ApprovedStandardAt = approved, Approved4kAt = approved };
        var status = StatusComposer.Movie(facts, null, Array.Empty<JfCopy>(), ctx, false);
        Assert.Equal(StatusStage.Looking, status.Stage);
        Assert.Equal((approved, (bool?)null), (status.Admin!.ApprovedNotInArrSince!.Value, status.Admin.ApprovedNotIn4k));
        // The other way round: the standard copy leads, the 4K variant is the overdue one.
        var other = MovieFacts(Copy(Movie()));
        other.Checked.Add(Radarr);
        other.Checked.Add(Radarr4k);
        other.Request = facts.Request;
        var flagged = StatusComposer.Movie(other, null, Array.Empty<JfCopy>(), ctx, false).Admin!;
        Assert.Equal((approved, (bool?)true), (flagged.ApprovedNotInArrSince!.Value, flagged.ApprovedNotIn4k));
        // Only the standard one was asked for (and Radarr holds it): no line. A family member never gets one.
        other.Request = new RequestFacts { ApprovedAt = approved, ApprovedStandardAt = approved };
        Assert.Null(StatusComposer.Movie(other, null, Array.Empty<JfCopy>(), ctx, false).Admin!.ApprovedNotInArrSince);
        Assert.Null(StatusComposer.Movie(facts, null, Array.Empty<JfCopy>(), new ComposeContext(Member, Now, 24) { HandoffGrace = TimeSpan.FromMinutes(15) }, false).Admin);
    }

    [Fact]
    public void AMovieMissingForALongWhileTellsAdminsWhenTheArrLastSearchedForIt()
    {
        var searched = Now.AddHours(-5);
        var movie = new ArrMovieEntry
        {
            Id = 7, TmdbId = 693134, Title = "Dune: Part Two", Monitored = true, IsAvailable = true, Added = Now.AddHours(-30),
            MinimumAvailability = "released", Path = "/data/movies/Dune Part Two (2024)", LastSearchTime = searched,
        };
        var admin = StatusComposer.Movie(MovieFacts(Copy(movie)), null, Array.Empty<JfCopy>(), Ctx(Admin), false);
        Assert.Equal((StatusStage.Looking, StatusReasonCode.NoReleaseYet), (admin.Stage, admin.Reason.Code));
        var variant = Assert.Single(admin.Admin!.Variants);
        Assert.Equal((searched, StatusFix.SearchNow), (variant.LastSearch, variant.Fix));
        // Never searched (the arr says nothing): no time. Family members get no admin block at all.
        var never = StatusComposer.Movie(MovieFacts(Copy(Movie(added: Now.AddHours(-30)))), null, Array.Empty<JfCopy>(), Ctx(Admin), false);
        Assert.Null(Assert.Single(never.Admin!.Variants).LastSearch);
        Assert.Null(StatusComposer.Movie(MovieFacts(Copy(movie)), null, Array.Empty<JfCopy>(), Ctx(), false).Admin);
        // A copy downloading has no "last searched" line.
        var downloading = StatusComposer.Movie(MovieFacts(Copy(movie, queue: new[] { Row() })), null, Array.Empty<JfCopy>(), Ctx(Admin), false);
        Assert.Null(Assert.Single(downloading.Admin!.Variants).LastSearch);
    }

    [Fact]
    public void SummariesCountTheMissingEpisodesThatAreMissingForALongWhile()
    {
        // E4 was asked for ten minutes ago (being looked for now), E5 is missing for a long while (Search):
        // both are missing, only E5 is long missing, so a series page offers nothing to ask for E4 alone.
        var series = new ArrSeriesEntry
        {
            Id = 3, TvdbId = 279121, Title = "Show", Monitored = true, Added = Now.AddDays(-400),
            Seasons = new[] { new ArrSeasonEntry { SeasonNumber = 1, Monitored = true, EpisodeCount = 2, TotalEpisodeCount = 2 } },
        };
        var e4 = new ArrEpisodeEntry { Id = 104, SeasonNumber = 1, EpisodeNumber = 4, AirDateUtc = Now.AddDays(-300), Monitored = true };
        var e5 = new ArrEpisodeEntry { Id = 105, SeasonNumber = 1, EpisodeNumber = 5, AirDateUtc = Now.AddDays(-293), Monitored = true };
        var show = new TitleFacts(ShowKey) { Request = new RequestFacts { Sent = new[] { new RequestSentPart(false, 1, 4, Now.AddMinutes(-10)) } } };
        show.Copies.Add(new ArrCopyFacts(Sonarr) { Series = series, Episodes = new ArrEpisodesSnapshot(3, new[] { e4, e5 }) });
        var seasonItem = new JfItemRef { ItemId = Guid.NewGuid(), Kind = "season", Key = TitleKey.Parse("tv:tvdb:279121:s1")!, Season = 1 };
        var season = StatusComposer.Season(show, seasonItem, Array.Empty<JfEpisode>(), Ctx(), detail: true);
        Assert.Equal((2, 1), (season.Summary!.Missing, season.Summary.LongMissing));
        var item = new JfItemRef { ItemId = Guid.NewGuid(), Kind = "series", Key = ShowKey };
        var whole = StatusComposer.Series(show, item, Array.Empty<JfEpisode>(), null, Ctx(), detail: true);
        Assert.Equal((2, 1), (whole.Summary!.Missing, whole.Summary.LongMissing));
        Assert.Equal(1, Assert.Single(whole.Seasons!).Summary!.LongMissing);
        // Both asked for a moment ago: none is long missing.
        show.Request = new RequestFacts { Sent = new[] { new RequestSentPart(false, 1, null, Now.AddMinutes(-10)) } };
        var fresh = StatusComposer.Season(show, seasonItem, Array.Empty<JfEpisode>(), Ctx(), detail: true).Summary!;
        Assert.Equal((2, 0), (fresh.Missing, fresh.LongMissing));
    }

    [Fact]
    public void ARequestGoingOutRestartsTheStillLookingClockOfThePartItCovers()
    {
        // A movie Radarr listed 30 h ago with nothing grabbed: missing for a long while (Search)...
        var movie = Movie(added: Now.AddHours(-30));
        Assert.Equal(StatusReasonCode.NoReleaseYet, StatusComposer.Movie(MovieFacts(Copy(movie)), null, Array.Empty<JfCopy>(), Ctx(), false).Reason.Code);
        // ...unless a request for it went out two hours ago: still looking (no Search yet).
        var facts = MovieFacts(Copy(movie));
        facts.Request = new RequestFacts { Sent = new[] { new RequestSentPart(false, null, null, Now.AddHours(-2)) } };
        var fresh = StatusComposer.Movie(facts, null, Array.Empty<JfCopy>(), Ctx(), false);
        Assert.Equal((StatusStage.Looking, StatusReasonCode.Looking), (fresh.Stage, fresh.Reason.Code));
        // A request for the 4K copy leaves the standard copy's clock alone; one older than the looking hours too.
        facts.Request = new RequestFacts { Sent = new[] { new RequestSentPart(true, null, null, Now.AddHours(-2)), new RequestSentPart(false, null, null, Now.AddHours(-25)) } };
        Assert.Equal(StatusReasonCode.NoReleaseYet, StatusComposer.Movie(facts, null, Array.Empty<JfCopy>(), Ctx(), false).Reason.Code);

        // Episodes of a series Sonarr has listed for a year: only the parts a request covers start again.
        var series = new ArrSeriesEntry { Id = 3, TvdbId = 279121, Title = "Show", Monitored = true, Added = Now.AddDays(-400) };
        var e4 = new ArrEpisodeEntry { Id = 104, SeasonNumber = 1, EpisodeNumber = 4, AirDateUtc = Now.AddDays(-300), Monitored = true };
        var e5 = new ArrEpisodeEntry { Id = 105, SeasonNumber = 1, EpisodeNumber = 5, AirDateUtc = Now.AddDays(-293), Monitored = true };
        var copy = new ArrCopyFacts(Sonarr) { Series = series, Episodes = new ArrEpisodesSnapshot(3, new[] { e4, e5 }) };
        Assert.Equal(StatusReasonCode.NoReleaseYet, StatusComposer.EpisodeFromArr(copy, 1, 4, e4, Ctx()).Reason);
        var oneEpisode = new RequestFacts { Sent = new[] { new RequestSentPart(false, 1, 4, Now.AddMinutes(-10)) } };
        Assert.Equal(StatusReasonCode.Looking, StatusComposer.EpisodeFromArr(copy, 1, 4, e4, Ctx(), oneEpisode).Reason);
        Assert.Equal(StatusReasonCode.NoReleaseYet, StatusComposer.EpisodeFromArr(copy, 1, 5, e5, Ctx(), oneEpisode).Reason);
        Assert.Equal(new[] { StatusReasonCode.Looking, StatusReasonCode.NoReleaseYet },
            StatusComposer.EpisodeStates(copy, 1, null, Ctx(), null, oneEpisode).Select(r => r.State.Reason).ToArray());
        // A season request covers its episodes until the looking hours have passed since it went out.
        var season = new RequestFacts { Sent = new[] { new RequestSentPart(false, 1, null, Now.AddHours(-23)) } };
        Assert.Equal(StatusReasonCode.Looking, StatusComposer.EpisodeFromArr(copy, 1, 5, e5, Ctx(), season).Reason);
        Assert.Equal(StatusReasonCode.NoReleaseYet, StatusComposer.EpisodeFromArr(copy, 1, 5, e5, new ComposeContext(Member, Now.AddHours(2), 24), season).Reason);
        // The series page's whole-series state and a season page read the request too.
        var show = new TitleFacts(ShowKey) { Request = season };
        show.Copies.Add(copy);
        var seasonItem = new JfItemRef { ItemId = Guid.NewGuid(), Kind = "season", Key = TitleKey.Parse("tv:tvdb:279121:s1")!, Season = 1 };
        var seasonStatus = StatusComposer.Season(show, seasonItem, Array.Empty<JfEpisode>(), Ctx(), detail: true);
        Assert.DoesNotContain(seasonStatus.Episodes!, e => e.Reason.Code == StatusReasonCode.NoReleaseYet);

        // Where the times come from: a sent want's parts (JE mode) at the time something covering each went out to
        // the want's target; Seerr's OK'd requests (Seerr mode).
        var at = new DateTimeOffset(2026, 10, 12, 11, 0, 0, TimeSpan.Zero);
        const string Target = "[\"je\",\"sonarr\",\"g1\",null]";
        Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestWant Want(Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.MutationInput input)
            => new("w", "a", Guid.NewGuid(), "c", "f", input, "sent", "looking", 0, "null", at.AddHours(-1), at.AddHours(5), TargetKey: Target);
        Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestDispatch Went(Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.MutationInput input, DateTimeOffset when, string target = Target)
            => new(target, input, when);
        var episodes = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.MutationInput { Key = "tv:tvdb:279121", Scope = "episodes", Episodes = new[] { new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestEpisode(1, 4), new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestEpisode(2, 1) } };
        var seasonTwo = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.MutationInput { Key = "tv:tvdb:279121", Scope = "seasons", Seasons = new[] { 2 } };
        // Each part from what covered it (S1E4 by the episode ask, S2E1 by a later season ask), never the want's last change;
        // a send to another target, or of another edition, doesn't count.
        Assert.Equal(new[] { new RequestSentPart(false, 1, 4, at.UtcDateTime), new RequestSentPart(false, 2, 1, at.AddHours(2).UtcDateTime) },
            Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.LedgerRequestFacts.SentParts(Want(episodes), new[] { Went(episodes, at), Went(seasonTwo, at.AddHours(2)), Went(episodes, at.AddHours(9), "[\"seerr\",\"\",\"\",\"s\"]"), Went(episodes with { Variant = "4k" }, at.AddHours(9)) }).ToArray());
        var future = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.MutationInput { Key = "tv:tvdb:279121", Scope = "future", Variant = "4k", Seasons = new[] { 3 } };
        Assert.Equal(new[] { new RequestSentPart(true, 3, null, at.UtcDateTime) },
            Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.LedgerRequestFacts.SentParts(Want(future), new[] { Went(future, at) }).ToArray());
        var film = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.MutationInput { Key = "movie:tmdb:693134" };
        Assert.Equal(new[] { new RequestSentPart(false, null, null, at.UtcDateTime) },
            Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.LedgerRequestFacts.SentParts(Want(film), new[] { Went(film, at) }).ToArray());
        // Nothing went out for it (yet): no time, whatever the want's own times say.
        Assert.Empty(Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.LedgerRequestFacts.SentParts(Want(film), Array.Empty<Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestDispatch>()));
        var seerr = SeerrRequestReadModel.FactsOf(new[]
        {
            new SeerrRequestRecord { Id = 1, IsMovie = false, TvdbId = 279121, Status = SeerrRequestStatus.Approved, Seasons = new[] { 1 }, CreatedAt = Now.AddHours(-3), UpdatedAt = Now.AddHours(-2) },
            new SeerrRequestRecord { Id = 2, IsMovie = false, TvdbId = 279121, Status = SeerrRequestStatus.Pending, Seasons = new[] { 2 }, CreatedAt = Now.AddHours(-1) },
        }, Member.UserId)!;
        Assert.Equal(Now.AddHours(-2), seerr.SentFor(false, 1, 5));
        Assert.Equal(Now.AddHours(-2), seerr.SentFor(false, null, null));
        Assert.Null(seerr.SentFor(true, 1, 5));
        Assert.Null(seerr.SentFor(false, 2, 1));
    }

    [Fact]
    public void AFinishedRequestIsNeverOverdueOnATitleThatIsHere()
    {
        var ctx = new ComposeContext(Admin, Now, 24) { HandoffGrace = TimeSpan.FromMinutes(15) };
        var approved = Now.AddDays(-2);
        // The movie is in Jellyfin; the standard Radarr JE watches (read) no longer holds it (removed
        // after import, or Seerr sent it to a Radarr JE doesn't watch). Seerr marked the request done.
        var hd = new JfCopy { ItemId = Guid.NewGuid(), Visible = true, Path = "/media/movies/Dune Part Two (2024)/Dune.mkv", DateCreated = Now.AddDays(-1) };
        SeerrRequestRecord Record(int status, int media) => new() { Id = 1, IsMovie = true, TmdbId = 693134, Status = status, MediaStatus = media, CreatedAt = approved.AddMinutes(-5), UpdatedAt = approved };
        var facts = MovieFacts();
        facts.Checked.Add(Radarr);
        facts.Request = SeerrRequestReadModel.FactsOf(new[] { Record(SeerrRequestStatus.Completed, 5) }, Admin.UserId);
        var ready = StatusComposer.Movie(facts, null, new[] { hd }, ctx, false);
        Assert.Equal(StatusStage.Ready, ready.Stage);
        Assert.Null(ready.Admin!.ApprovedNotInArrSince);
        // Available in Seerr while the request still reads "OK'd": done too.
        facts.Request = SeerrRequestReadModel.FactsOf(new[] { Record(SeerrRequestStatus.Approved, 5) }, Admin.UserId);
        Assert.Null(StatusComposer.Movie(facts, null, new[] { hd }, ctx, false).Admin!.ApprovedNotInArrSince);
        // Not here and not done (Seerr still processing it): the line is about a real stuck handoff.
        facts.Request = SeerrRequestReadModel.FactsOf(new[] { Record(SeerrRequestStatus.Approved, 3) }, Admin.UserId);
        var stuck = StatusComposer.Movie(facts, null, Array.Empty<JfCopy>(), ctx, false);
        Assert.Equal((StatusReasonCode.ApprovedNotInArr, approved), (stuck.Reason.Code, stuck.Admin!.ApprovedNotInArrSince!.Value));
        // A series by key and on its page follow the same rule.
        var show = new TitleFacts(ShowKey) { Request = SeerrRequestReadModel.FactsOf(new[] { new SeerrRequestRecord { Id = 2, TmdbId = 1, TvdbId = 279121, Status = SeerrRequestStatus.Completed, MediaStatus = 5, CreatedAt = approved, UpdatedAt = approved, Seasons = new[] { 1 } } }, Admin.UserId) };
        show.Checked.Add(Sonarr);
        var series = new JfCopy { ItemId = Guid.NewGuid(), Visible = true, Path = "/media/tv/Show", DateCreated = Now.AddDays(-1) };
        Assert.Null(StatusComposer.SeriesByKey(show, new[] { series }, ctx).Admin?.ApprovedNotInArrSince);
        var episodes = new[] { new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = Now.AddDays(-1) } };
        Assert.Null(StatusComposer.Series(show, new JfItemRef { ItemId = series.ItemId, Kind = "series", Key = ShowKey }, episodes, null, ctx, detail: false).Admin?.ApprovedNotInArrSince);
    }

    [Fact]
    public void AFourKOnlyRequestNoRadarrHoldsSaysItIsAboutTheFourKRequest()
    {
        // Only a 4K request, OK'd two days ago; both Radarrs were read and hold nothing.
        var ctx = new ComposeContext(Admin, Now, 24) { HandoffGrace = TimeSpan.FromMinutes(15) };
        var approved = Now.AddDays(-2);
        var facts = MovieFacts();
        facts.Checked.Add(Radarr);
        facts.Checked.Add(Radarr4k);
        facts.Request = new RequestFacts { AskedAt = approved, ApprovedAt = approved, Approved4kAt = approved };
        var status = StatusComposer.Movie(facts, null, Array.Empty<JfCopy>(), ctx, false);
        Assert.Equal(StatusReasonCode.ApprovedNotInArr, status.Reason.Code);
        Assert.Equal((approved, (bool?)true), (status.Admin!.ApprovedNotInArrSince!.Value, status.Admin.ApprovedNotIn4k));
        // A standard request in the same place reads as one.
        facts.Request = new RequestFacts { AskedAt = approved, ApprovedAt = approved, ApprovedStandardAt = approved };
        Assert.Null(StatusComposer.Movie(facts, null, Array.Empty<JfCopy>(), ctx, false).Admin!.ApprovedNotIn4k);
    }

    [Fact]
    public void AFourKRequestHeldOnlyByTheFourKRadarrNeverTakesTheStandardCopyForIts()
    {
        // Only Radarr 4K (root /movies4k, no links or mappings) has Dune; Jellyfin has only the HD copy.
        var hd = new JfCopy { ItemId = Guid.NewGuid(), Visible = true, Path = "/media/movies/Dune Part Two (2024)/Dune.mkv", DateCreated = Now.AddDays(-2) };
        var facts = MovieFacts(Copy(Movie(hasFile: true, path: "/movies4k/Dune Part Two (2024)"), Radarr4k));
        var placeholder = new TitleStatus { Key = MovieKey.ToString(), Kind = "movie" };
        var (status, arrived, shown) = StatusComposer.Requested4k(facts, placeholder, new[] { hd }, Ctx());
        Assert.NotEqual(StatusStage.Ready, status.Stage);
        Assert.Null(arrived);
        Assert.Null(shown);
        // Seerr's own 4K item, when the viewer can open it, is the 4K copy.
        var uhd = new JfCopy { ItemId = Guid.NewGuid(), Visible = true, Path = "/srv/uhd/Dune.mkv", DateCreated = Now.AddDays(-1) };
        var (seerr, seerrArrived, seerrShown) = StatusComposer.Requested4k(facts, placeholder, new[] { hd, uhd }, Ctx(), uhd);
        Assert.Equal((StatusStage.Ready, uhd.ItemId), (seerr.Stage, seerrShown!.ItemId));
        Assert.Equal(uhd.DateCreated, seerrArrived);
        // The whole title still counts the HD copy (it is there).
        Assert.Equal(StatusStage.Ready, StatusComposer.Movie(facts, null, new[] { hd }, Ctx(), false).Stage);
    }

    [Fact]
    public void DatesProgressAndEtaAreCarriedAsFamilySafeParameters()
    {
        var notOut = StatusComposer.Movie(MovieFacts(Copy(Movie(available: false, cinemas: Now.AddDays(-10), digital: Now.AddDays(33)))), null, Array.Empty<JfCopy>(), Ctx(), false);
        Assert.Equal(Now.AddDays(33), notOut.NextDate);
        // Radarr's release dates are calendar days: sent as the day, so no time zone moves them.
        Assert.Equal("2026-11-14", notOut.Reason.Params!["date"]);
        Assert.Equal("2026-11-14", notOut.NextDay);

        var downloading = StatusComposer.Movie(MovieFacts(Copy(Movie(), queue: new[] { Row() })), null, Array.Empty<JfCopy>(), Ctx(), false);
        Assert.Equal(42, downloading.Progress!.Percent);
        Assert.Equal(720, downloading.Progress.EtaSeconds);

        // No estimated completion: the arr's "timeleft" is used.
        var row = new ArrQueueEntry { Id = 1, Status = "downloading", TrackedDownloadState = "downloading", TrackedDownloadStatus = "ok", Size = 100, SizeLeft = 75, TimeLeft = "00:05:00", MovieId = 7 };
        Assert.Equal((25, 300L), (StatusComposer.Progress(row, Ctx())!.Percent, StatusComposer.Progress(row, Ctx())!.EtaSeconds!.Value));
    }

    [Fact]
    public void ADateOnlyReleaseOrAirDayStaysTheDateWhileThatDayLastsSomewhere()
    {
        var day = new DateTime(2026, 10, 13, 0, 0, 0, DateTimeKind.Utc);
        var early = day.AddHours(1); // still the 12th west of UTC
        // Radarr: in cinemas, digital release on the 13th, not available yet.
        var movie = MovieFacts(Copy(Movie(available: false, cinemas: day.AddDays(-30), digital: day)));
        var notOut = StatusComposer.Movie(movie, null, Array.Empty<JfCopy>(), new ComposeContext(Member, early, 24), false);
        Assert.Equal((StatusReasonCode.InCinemas, "2026-10-13"), (notOut.Reason.Code, notOut.NextDay));
        Assert.Null(StatusComposer.Movie(movie, null, Array.Empty<JfCopy>(), new ComposeContext(Member, day.AddHours(37), 24), false).NextDay);

        // A cinema-only release is a calendar day too: it hasn't begun everywhere at 01:00 UTC.
        var cinema = MovieFacts(Copy(Movie(available: false, cinemas: day)));
        var notInCinemas = StatusComposer.Movie(cinema, null, Array.Empty<JfCopy>(), new ComposeContext(Member, early, 24), false);
        Assert.Equal((StatusStage.NotOut, StatusReasonCode.NotReleased, "2026-10-13"), (notInCinemas.Stage, notInCinemas.Reason.Code, notInCinemas.NextDay));
        Assert.Equal(StatusReasonCode.InCinemas, StatusComposer.Movie(cinema, null, Array.Empty<JfCopy>(), new ComposeContext(Member, day.AddHours(37), 24), false).Reason.Code);

        // Sonarr: an episode with an air day and no time (no airDateUtc).
        var series = new ArrSeriesEntry { Id = 3, TvdbId = 279121, Title = "Show", Monitored = true, Added = day.AddDays(-100) };
        var list = new[]
        {
            new ArrEpisodeEntry { Id = 101, SeasonNumber = 1, EpisodeNumber = 1, AirDateUtc = day.AddDays(-7), HasFile = true, Monitored = true },
            new ArrEpisodeEntry { Id = 102, SeasonNumber = 1, EpisodeNumber = 2, AirDateUtc = day, AirDateIsDay = true, Monitored = true },
        };
        var show = new TitleFacts(ShowKey);
        show.Copies.Add(new ArrCopyFacts(Sonarr) { Series = series, Episodes = new ArrEpisodesSnapshot(3, list) });
        var jf = new List<JfEpisode> { new() { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = day.AddDays(-6) } };
        var item = new JfItemRef { ItemId = Guid.NewGuid(), Kind = "series", Key = ShowKey };
        var airing = StatusComposer.Series(show, item, jf, null, new ComposeContext(Member, early, 24), detail: false);
        Assert.Equal("2026-10-13", airing.NextDay);
        Assert.Equal(0, airing.Summary!.Missing);
        var episode = StatusComposer.EpisodeFromArr(show.Copies[0], 1, 2, list[1], new ComposeContext(Member, early, 24));
        Assert.Equal((StatusReasonCode.NotAired, "2026-10-13"), (episode.Reason, episode.Day));
        // Once the day is over everywhere: aired, and wanted.
        var later = new ComposeContext(Member, day.AddHours(37), 24);
        Assert.Equal(StatusStage.Looking, StatusComposer.EpisodeFromArr(show.Copies[0], 1, 2, list[1], later).Stage);
        Assert.Equal(1, StatusComposer.Series(show, item, jf, null, later, detail: false).Summary!.Missing);
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
        var std = At(Radarr, "/data/media/movies/Sintel (2010) [tmdbid-45745]");
        var uhd = At(Radarr4k, "/data/media/movies4k/Sintel (2010) [tmdbid-45745]");
        var both = new[] { std, uhd };
        // Folder names (no mapping configured): "movies/Sintel…" vs "movies4k/Sintel…".
        Assert.Equal(jf[0].ItemId, Assert.Single(StatusComposer.MatchCopies(std, jf, both)).ItemId);
        Assert.Equal(jf[1].ItemId, Assert.Single(StatusComposer.MatchCopies(uhd, jf, both)).ItemId);
        // Linked libraries win over paths.
        var linked = At(new ArrConnection { Id = Radarr.Id, Kind = ArrKind.Radarr, Name = "x", Role = "standard", LinkedLibraryIds = new[] { "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2" } }, "/data/media/movies/Sintel (2010) [tmdbid-45745]");
        Assert.Equal(jf[1].ItemId, Assert.Single(StatusComposer.MatchCopies(linked, jf, new[] { linked, uhd })).ItemId);
        // Path mappings.
        var mapped = At(new ArrConnection { Id = Radarr.Id, Kind = ArrKind.Radarr, Name = "x", Role = "standard", PathMappings = new[] { new Jellyfin.Plugin.JellyfinEnhanced.Model.Arr.ArrPathMapping { ArrPath = "/srv/uhd", JellyfinPath = "/rigmedia/movies4k" } } }, "/srv/uhd/Sintel (2010) [tmdbid-45745]");
        Assert.Equal(jf[1].ItemId, Assert.Single(StatusComposer.MatchCopies(mapped, jf, new[] { mapped, std })).ItemId);
        // One instance only: every copy is its copy; two instances and nothing matches: none.
        var elsewhere = At(Radarr, "/elsewhere/Sintel");
        Assert.Equal(2, StatusComposer.MatchCopies(elsewhere, jf, new[] { elsewhere }).Count);
        Assert.Empty(StatusComposer.MatchCopies(elsewhere, jf, new[] { elsewhere, uhd }));
    }

    [Fact]
    public void CopyMatchingRespectsFolderBoundariesTheLongestMappingAndAmbiguousFolders()
    {
        var movies = new JfCopy { ItemId = Guid.NewGuid(), Path = "/media/movies/Sintel (2010)/Sintel.mkv" };
        var movies4k = new JfCopy { ItemId = Guid.NewGuid(), Path = "/media/movies4k/Sintel (2010)/Sintel.2160p.mkv" };
        var jf = new[] { movies, movies4k };
        ArrCopyFacts At(ArrConnection instance, string path) => Copy(Movie(path: path), instance);
        ArrConnection Mapped(ArrConnection like, params (string Arr, string Jf)[] maps) => new()
        {
            Id = like.Id, Kind = like.Kind, Name = like.Name, Role = like.Role,
            PathMappings = maps.Select(m => new Jellyfin.Plugin.JellyfinEnhanced.Model.Arr.ArrPathMapping { ArrPath = m.Arr, JellyfinPath = m.Jf }).ToArray(),
        };

        // A folder boundary: a mapping to /media/movies never takes /media/movies4k/… (no StartsWith).
        var std = At(Mapped(Radarr, ("/data", "/media/movies")), "/data/Sintel (2010)");
        var uhd = At(Mapped(Radarr4k, ("/data4k", "/media/movies4k")), "/data4k/Sintel (2010)");
        Assert.Equal(movies.ItemId, Assert.Single(StatusComposer.MatchCopies(std, jf, new[] { std, uhd })).ItemId);
        Assert.Equal(movies4k.ItemId, Assert.Single(StatusComposer.MatchCopies(uhd, jf, new[] { std, uhd })).ItemId);

        // Overlapping mappings: the longest whose arr side holds the folder wins.
        var nested = At(Mapped(Radarr4k, ("/data", "/media/movies"), ("/data/uhd", "/media/movies4k")), "/data/uhd/Sintel (2010)");
        Assert.Equal(movies4k.ItemId, Assert.Single(StatusComposer.MatchCopies(nested, jf, new[] { nested, std })).ItemId);

        // Once a mapping applies, its answer is final: the 4K copy has no file in Jellyfin yet, so it
        // matches nothing (it never falls through to the folder names and pairs with the HD copy).
        var noFile = At(Mapped(Radarr4k, ("/movies", "/media/uhd")), "/movies/Sintel (2010)");
        var stdPlain = At(Radarr, "/films/Sintel (2010)");
        Assert.Empty(StatusComposer.MatchCopies(noFile, new[] { movies }, new[] { stdPlain, noFile }));

        // Two hosts both rooted at /movies (no mappings): which Jellyfin copy is whose can't be told, so
        // neither copy claims one by folder name (the 4K copy never borrows the standard copy).
        var hostA = At(Radarr, "/movies/Sintel (2010)");
        var hostB = At(Radarr4k, "/movies/Sintel (2010)");
        var shared = new JfCopy { ItemId = Guid.NewGuid(), Path = "/movies/Sintel (2010)/Sintel.mkv" };
        Assert.Empty(StatusComposer.MatchCopies(hostB, new[] { shared }, new[] { hostA, hostB }));
        Assert.Empty(StatusComposer.MatchCopies(hostA, new[] { shared }, new[] { hostA, hostB }));

        // A copy a sibling claims by its mapping is not up for the folder-name match.
        var claimer = At(Mapped(Radarr4k, ("/uhd", "/media/movies")), "/uhd/Sintel (2010)");
        var byName = At(Radarr, "/srv/movies/Sintel (2010)");
        Assert.Empty(StatusComposer.MatchCopies(byName, new[] { movies }, new[] { byName, claimer }));
        Assert.Equal(movies.ItemId, Assert.Single(StatusComposer.MatchCopies(byName, new[] { movies }, new[] { byName })).ItemId);
    }

    [Fact]
    public void AFourKOnlyMovieWhoseCopyMatchesNothingNeverBorrowsTheStandardCopy()
    {
        // Radarr and Radarr 4K on two hosts, both rooted at /movies; Jellyfin has only the HD copy.
        var hd = new JfCopy { ItemId = Guid.NewGuid(), Visible = true, Path = "/movies/Dune Part Two (2024)/Dune.mkv", DateCreated = Now.AddDays(-2) };
        var facts = MovieFacts(Copy(Movie(hasFile: true, path: "/movies/Dune Part Two (2024)")), Copy(Movie(path: "/movies/Dune Part Two (2024)"), Radarr4k));
        var placeholder = new TitleStatus { Key = MovieKey.ToString(), Kind = "movie" };
        var (status, arrived, shown) = StatusComposer.Requested4k(facts, placeholder, new[] { hd }, Ctx());
        Assert.NotEqual(StatusStage.Ready, status.Stage);
        Assert.Null(arrived);
        Assert.Null(shown);
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
        facts.Unreadable.Add(new UnreadableArr(Radarr, "Radarr (lab) (Unreachable)"));
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

        Assert.Equal("tv:tvdb:279121:s9", status.Key);
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
        Assert.Equal("tv:tvdb:279121:s9:e1", ready.Key);
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
        Assert.Equal("tv:tvdb:78874:s1:e2", TitleKey.Parse("tv:tvdb:78874:s1:e2")!.ToString());
        Assert.Equal("tv:tvdb:78874", TitleKey.Parse("tv:tvdb:78874:s1:e2")!.Title.ToString());
        Assert.Equal("movie:imdb:tt0133093", TitleKey.ForMovie(null, "tt0133093")!.ToString());
        Assert.Equal("tv:tmdb:1437", TitleKey.ForSeries(" ", "1437", "tt0303461")!.ToString());
        foreach (var bad in new[] { "", "movie:tvdb:1", "movie:tmdb:1:s1", "tv:imdb:123", "movie:tmdb:tt1", "movie:tmdb:0", "x:tmdb:1", "movie:tmdb:1<script>", new string('1', 80) })
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
        foreach (var bad in new[] { "tv:tvdb:5:s\u0661", "tv:tvdb:5:s1:e\u0662", "movie:tmdb:\u0661\u0662", "movie:imdb:tt\u0661" })
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
    public void AHiddenLongCombinedFileHidesItsTailUnlessAnotherCopyIsVisible()
    {
        var (_, hidden) = StatusComposer.SplitHidden(new[]
        {
            new JfEpisode { Season = 1, Episode = 1, EpisodeEnd = 60, Hidden = true },
            new JfEpisode { Season = 1, Episode = 55, EpisodeEnd = 56, ItemId = Guid.NewGuid() },
        }, null);
        Assert.Equal(58, hidden.Episodes.Count);
        Assert.True(hidden.Hides(1, 54));
        Assert.False(hidden.Hides(1, 55));
        Assert.False(hidden.Hides(1, 56));
        Assert.True(hidden.Hides(1, 60));
        Assert.True(hidden.WithFile.Contains((1, 60)));
        Assert.False(hidden.Hides(1, 61));
        var copy = new ArrCopyFacts(Sonarr) { Series = new ArrSeriesEntry { Id = 1, TvdbId = 100, Title = "Show" } };
        var states = StatusComposer.EpisodeStates(copy, 1,
            new[] { new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, EpisodeEnd = 60 } }, Ctx());
        Assert.Equal(60, states.Count);
        Assert.Equal(StatusStage.Ready, Assert.Single(states, row => row.Episode == 55).State.Stage);
        Assert.All(states, row => Assert.Equal(StatusStage.Ready, row.State.Stage));
        // A reversed range is one episode, and the final int never wraps the iterator.
        Assert.Equal(new[] { 5 }, new EpisodeRange(5, 4).Numbers(EpisodeRange.MaxSyntheticEpisodes));
        Assert.Equal(new[] { int.MaxValue }, new EpisodeRange(int.MaxValue, int.MaxValue).Numbers(EpisodeRange.MaxSyntheticEpisodes));
    }

    [Theory]
    [InlineData(int.MaxValue)]
    [InlineData(100000)]
    public void EnormousHiddenCombinedFilesHideRelevantTailNumbersWithoutExpansion(int end)
    {
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var jf = new[] { new JfEpisode { Season = 1, Episode = 1, EpisodeEnd = end, Hidden = true } };
        var (visible, hidden) = StatusComposer.SplitHidden(jf, null);
        Assert.True(hidden.Hides(1, 60));
        Assert.True(hidden.Hides(1, 5000));
        Assert.Equal((long)end, hidden.WithFile.CountInSeason(1));
        var series = new ArrSeriesEntry { Id = 1, TvdbId = 279121, Title = "Show", Seasons = new[]
        {
            new ArrSeasonEntry { SeasonNumber = 1, EpisodeCount = 2, EpisodeFileCount = 2 },
        } };
        var facts = new TitleFacts(ShowKey);
        var queue = new[] { Row(episodeId: 60, season: 1, episode: 60), Row(episodeId: 5000, season: 1, episode: 5000) };
        facts.Copies.Add(new ArrCopyFacts(Sonarr)
        {
            Series = series, Queue = queue,
            Episodes = new ArrEpisodesSnapshot(1, new[]
            {
                new ArrEpisodeEntry { Id = 60, SeasonNumber = 1, EpisodeNumber = 60, Monitored = true },
                new ArrEpisodeEntry { Id = 5000, SeasonNumber = 1, EpisodeNumber = 5000, Monitored = true },
            }),
        });
        Assert.Empty(StatusComposer.EpisodeStates(facts.Copies[0], 1, visible, Ctx(), hidden));
        var item = new JfItemRef { ItemId = Guid.NewGuid(), Kind = "season", Season = 1, Key = ShowKey.WithSeason(1) };
        var status = StatusComposer.Season(facts, item, jf, Ctx(), detail: true);
        Assert.Empty(status.Episodes!);
        Assert.Equal(0, status.Summary!.Downloading);
        // Also exercise the statistics-only path: no hidden file or queue count is exposed.
        facts.Copies[0] = new ArrCopyFacts(Sonarr) { Series = series, Queue = queue };
        status = StatusComposer.Season(facts, item, jf, Ctx(), detail: false);
        Assert.Equal((0, 0, 0), (status.Summary!.Aired, status.Summary.Ready, status.Summary.AlmostReady));
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(5));
    }

    [Theory]
    [InlineData(int.MaxValue)]
    [InlineData(100000)]
    public void EnormousVisibleCombinedFilesBoundSyntheticRowsAndMatchActualTailNumbers(int end)
    {
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var jf = new[] { new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, EpisodeEnd = end } };
        // A visible file covers the entire hidden range, including far beyond synthetic rows.
        var (_, hidden) = StatusComposer.SplitHidden(jf.Concat(new[]
        {
            new JfEpisode { Season = 1, Episode = 1, EpisodeEnd = end, Hidden = true },
        }).ToArray(), null);
        Assert.False(hidden.Hides(1, 5000));
        var copy = new ArrCopyFacts(Sonarr) { Series = new ArrSeriesEntry { Id = 1, TvdbId = 279121, Title = "Show" } };
        Assert.Equal(EpisodeRange.MaxSyntheticEpisodes, StatusComposer.EpisodeStates(copy, 1, jf, Ctx()).Count);
        var facts = new TitleFacts(ShowKey);
        facts.Copies.Add(copy);
        var card = StatusComposer.Season(facts,
            new JfItemRef { ItemId = Guid.NewGuid(), Kind = "season", Season = 1, Key = ShowKey.WithSeason(1) },
            jf, Ctx(), detail: false);
        Assert.Equal(end, card.Summary!.Ready); // statistics count intervals, never synthetic rows
        copy = new ArrCopyFacts(Sonarr) { Series = copy.Series, Episodes = new ArrEpisodesSnapshot(1, new[]
        {
            new ArrEpisodeEntry { Id = 5000, SeasonNumber = 1, EpisodeNumber = 5000, Monitored = true },
        }) };
        var rows = StatusComposer.EpisodeStates(copy, 1, jf, Ctx());
        Assert.Equal(StatusStage.Ready, Assert.Single(rows, r => r.Episode == 5000).State.Stage);
        Assert.Equal(EpisodeRange.MaxSyntheticEpisodes + 1, rows.Count);
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(5));
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
