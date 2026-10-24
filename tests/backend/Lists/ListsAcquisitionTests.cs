using System.Globalization;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

// Asking for list entries (4c1): preview writes nothing; per-entry outcomes; list skip reasons; hidden entries answer
// like missing ones; one durable operation per confirmation with replay/conflict; wants carry the list origin and
// provenance; links per person. Plus the request input an entry asks with (ListRules.RequestInput / TitleKeyOf / EditionOf).
[Collection("Plugin singleton")]
public class ListsAcquisitionTests
{
    private static readonly CancellationToken None = CancellationToken.None;
    private const string Past = "2020-01-01";

    internal sealed class Rig : IDisposable
    {
        public ListsHarness H { get; } = new(seerr: true);
        public IntegrationRequestLedgerTests.Policy Policy { get; } = new();
        public RequestLedger Ledger { get; }
        public RequestService Requests { get; }
        public RequestOperations Operations { get; }
        public ListLinks Links { get; }
        public ListAcquisition Acquisition { get; }
        public DateTimeOffset Now { get; set; } = new(2026, 10, 13, 12, 0, 0, TimeSpan.Zero);
        public User Owner { get; }
        public FakeListHost.FakeList Playlist { get; }

        public Rig()
        {
            Ledger = new RequestLedger(H.Database);
            Requests = new RequestService(Ledger, Policy, new FakeJellyfinView(), new ArrChangeFeed(), () => Now);
            Operations = new RequestOperations(H.Database);
            Links = new ListLinks(H.Database);
            Acquisition = new ListAcquisition(H.Store, H.Access, Requests, Operations, Links, H.Plugin.Core.Logger) { Now = () => Now };
            Owner = Person("owner");
            Playlist = H.Host.AddPlaylist(Owner, openAccess: true);
        }

        public string ListIdN => Playlist.Info.Id.ToString("N");

        public User Person(string name, string role = "Member", int? maxRating = null)
        {
            var user = H.NewUser(name, admin: role == "Admin", maxRating: maxRating);
            Policy.People[user.Id] = new RequestPolicyFacts(user.Id, role, role != "Watcher", role is "Manager" or "Admin", role == "Admin", true, "p1", "je", "r1", "g1", 7, 7, 0, "{\"score\":5}");
            return user;
        }

        public ListAccess As(User user) => H.AccessFor(Playlist, user);

        public async Task Seed(params Placeholder[] items)
        {
            using (await H.Store.LockAsync(ListIdN))
            {
                var doc = H.Store.LoadForUpdate(ListIdN, ListKinds.Playlist);
                foreach (var item in items)
                {
                    doc.Items.Add(item);
                    doc.Order.Add(P(item.Id));
                }

                H.Store.Save(doc);
            }
        }

        public long Rows(string table) => H.Database.Read(c =>
        {
            using var cmd = RequestLedger.Cmd(c, null, "SELECT COUNT(*) FROM " + table);
            return Convert.ToInt64(cmd.ExecuteScalar(), CultureInfo.InvariantCulture);
        });

        public (long Wants, long Jobs, long Operations, long Links, long Inputs) Counts() =>
            (Rows("wants"), Rows("jobs"), Rows("request_operations"), Rows("list_links"), Rows("request_inputs"));

        public void Dispose() => H.Dispose();
    }

    private static Placeholder Released(int tmdb) => Movie(tmdb, Past);

    private static Placeholder SeasonPh(int tmdb, int season, int? tvdb = null, string? releaseDate = Past) =>
        Ph($"{{\"kind\":\"season\",\"tmdbId\":{tmdb}{(tvdb == null ? string.Empty : ",\"tvdbId\":" + tvdb)},\"seasonNumber\":{season},\"title\":\"Show S{season}\"{(releaseDate == null ? string.Empty : ",\"releaseDate\":\"" + releaseDate + "\"")}}}");

    private static Placeholder SeriesPh(int tmdb, int? tvdb = null, string? releaseDate = Past) =>
        Ph($"{{\"kind\":\"series\",\"tmdbId\":{tmdb}{(tvdb == null ? string.Empty : ",\"tvdbId\":" + tvdb)},\"title\":\"Show\"{(releaseDate == null ? string.Empty : ",\"releaseDate\":\"" + releaseDate + "\"")}}}");

    private static Placeholder EpisodesPh(int tmdb, int season, params int[] episodes) =>
        Ph($"{{\"kind\":\"episodes\",\"tmdbId\":{tmdb},\"seasonNumber\":{season},\"title\":\"Show\",\"releaseDate\":\"{Past}\",\"episodes\":[{string.Join(',', episodes.Select(e => $"{{\"s\":{season},\"e\":{e}}}"))}]}}");

    private static Placeholder Custom(string title) => Ph($"{{\"kind\":\"custom\",\"title\":\"{title}\"}}");

    private static ListRequestPreviewItemDto Item(ListRequestPreviewDto preview, Placeholder p) => preview.Items.Single(i => i.PlaceholderId == p.Id);

    private static RequestOutcome Result(ListRequestSubmitDto submit, Placeholder p) =>
        Assert.IsType<RequestOutcome>(submit.Results.Single(r => r.PlaceholderId == p.Id).Result);

    // ── preview ───────────────────────────────────────────────────────

    [Fact]
    public async Task APreviewWritesNothingAndMapsEveryEntryToAnOutcomeOrAListSkipReason()
    {
        using var r = new Rig();
        var member = r.Person("member");
        var movie = Released(603);
        var season = SeasonPh(1399, 1, tvdb: 121361);
        var custom = Custom("Home video");
        var future = Movie(700, "2099-01-01");
        var tba = Movie(701);
        var seriesUnknown = SeriesPh(1400);
        await r.Seed(movie, season, custom, future, tba, seriesUnknown);
        var before = r.Counts();

        var preview = Ok<ListRequestPreviewDto>(await r.Acquisition.PreviewAsync(r.As(member), new[] { movie.Id, season.Id, custom.Id, future.Id, tba.Id, seriesUnknown.Id }, false, None));

        Assert.Equal(before, r.Counts());
        Assert.Equal(new[] { movie.Id, season.Id, custom.Id, future.Id, tba.Id, seriesUnknown.Id }, preview.Items.Select(i => i.PlaceholderId));
        Assert.Equal(("request", "request"), (Item(preview, movie).Outcome, Item(preview, season).Outcome));
        Assert.Equal(("skip", "custom"), (Item(preview, custom).Outcome, Item(preview, custom).Reason));
        Assert.Equal(("skip", "not_released"), (Item(preview, future).Outcome, Item(preview, future).Reason));
        Assert.Equal(("skip", "not_released"), (Item(preview, tba).Outcome, Item(preview, tba).Reason));
        Assert.Equal(("skip", "scope_unknown"), (Item(preview, seriesUnknown).Outcome, Item(preview, seriesUnknown).Reason));
        Assert.Equal(2, preview.Askable);
        Assert.Equal(RequestOperations.MaxBatch, preview.MaxBatch);
        Assert.True(preview.Cost > 0);

        // Request all missing looks at every non-custom entry, in list order, and still writes nothing.
        var all = Ok<ListRequestPreviewDto>(await r.Acquisition.PreviewAsync(r.As(member), null, true, None));
        Assert.Equal(new[] { movie.Id, season.Id, future.Id, tba.Id, seriesUnknown.Id }, all.Items.Select(i => i.PlaceholderId));
        Assert.Equal(before, r.Counts());
    }

    [Fact]
    public async Task APreviewSaysFollowAlreadyAndApprovalForWhatTheAskWouldBe()
    {
        using var r = new Rig();
        var first = r.Person("first");
        var second = r.Person("second");
        var kid = r.Person("kid", "Kid");
        var movie = Released(603);
        var other = Released(604);
        await r.Seed(movie, other);
        Ok<ListRequestSubmitDto>(await r.Acquisition.SubmitAsync(r.As(first), "confirm-1", new[] { movie.Id }, None));
        var before = r.Counts();

        var mine = Ok<ListRequestPreviewDto>(await r.Acquisition.PreviewAsync(r.As(first), new[] { movie.Id }, false, None));
        Assert.Equal("already", Item(mine, movie).Outcome);
        Assert.Equal(0, mine.Askable);

        var theirs = Ok<ListRequestPreviewDto>(await r.Acquisition.PreviewAsync(r.As(second), new[] { movie.Id, other.Id }, false, None));
        Assert.Equal(("follow", "request"), (Item(theirs, movie).Outcome, Item(theirs, other).Outcome));
        Assert.Equal(2, theirs.Askable);

        var kids = Ok<ListRequestPreviewDto>(await r.Acquisition.PreviewAsync(r.As(kid), new[] { other.Id }, false, None));
        Assert.Equal("approval", Item(kids, other).Outcome);

        Assert.Equal(before, r.Counts());
    }

    [Fact]
    public async Task ARefusedAskIsASkipWithTheRequestReason()
    {
        using var r = new Rig();
        var watcher = r.Person("watcher", "Watcher");
        var movie = Released(603);
        await r.Seed(movie);

        var preview = Ok<ListRequestPreviewDto>(await r.Acquisition.PreviewAsync(r.As(watcher), new[] { movie.Id }, false, None));

        Assert.Equal("skip", Item(preview, movie).Outcome);
        Assert.False(string.IsNullOrEmpty(Item(preview, movie).Reason));
        Assert.NotEqual("not_requestable", Item(preview, movie).Reason);
        Assert.Equal(0, preview.Askable);
    }

    [Fact]
    public async Task AnEntryTheParentalFilterHidesAnswersLikeAMissingOneAndIsNeverAsked()
    {
        using var r = new Rig();
        r.H.MovieCertifications[1] = "G";
        r.H.MovieCertifications[2] = "R";
        var kid = r.Person("kid", maxRating: 10);
        var allowed = Released(1);
        var blocked = Released(2);
        await r.Seed(allowed, blocked);
        var before = r.Counts();

        var missing = Error(await r.Acquisition.SubmitAsync(r.As(kid), "c-missing", new[] { Guid.NewGuid().ToString("N") }, None), 404, "not_found");
        var hidden = Error(await r.Acquisition.SubmitAsync(r.As(kid), "c-hidden", new[] { allowed.Id, blocked.Id }, None), 404, "not_found");
        Assert.Equal(missing.Message, hidden.Message);
        Error(await r.Acquisition.PreviewAsync(r.As(kid), new[] { blocked.Id }, false, None), 404, "not_found");
        Assert.Equal(before, r.Counts());

        // Request all missing simply leaves it out.
        var all = Ok<ListRequestPreviewDto>(await r.Acquisition.PreviewAsync(r.As(kid), null, true, None));
        Assert.Equal(new[] { allowed.Id }, all.Items.Select(i => i.PlaceholderId));
    }

    // ── submit ────────────────────────────────────────────────────────

    [Fact]
    public async Task ASubmitOfMoreThanTwentyEntriesOrNoneIsRefused()
    {
        using var r = new Rig();
        var member = r.Person("member");
        var ids = Enumerable.Range(0, RequestOperations.MaxBatch + 1).Select(_ => Guid.NewGuid().ToString("N")).ToList();

        Error(await r.Acquisition.SubmitAsync(r.As(member), "c1", ids, None), 400, "batch_too_large");
        Error(await r.Acquisition.SubmitAsync(r.As(member), "c2", Array.Empty<string>(), None), 400, "batch_too_large");
        Assert.Equal(0, r.Rows("request_operations"));
    }

    [Fact]
    public async Task ASubmitAsksOncePerEntryAsTheCallerWithTheListOriginProvenanceAndLinks()
    {
        using var r = new Rig();
        var member = r.Person("member");
        var movie = Released(603);
        var season = SeasonPh(1399, 2, tvdb: 121361);
        var episodes = EpisodesPh(1399, 3, 1, 2);
        var custom = Custom("Not a title");
        await r.Seed(movie, season, episodes, custom);
        var rev = r.H.Store.Load(r.ListIdN)!.Rev;

        var submit = Ok<ListRequestSubmitDto>(await r.Acquisition.SubmitAsync(r.As(member), "confirm-1", new[] { movie.Id, season.Id, episodes.Id, custom.Id }, None));

        Assert.False(submit.Replayed);
        Assert.Equal(new[] { movie.Id, season.Id, episodes.Id, custom.Id }, submit.Results.Select(x => x.PlaceholderId));
        Assert.Equal(("denied", "custom", 422), (Result(submit, custom).Outcome, Result(submit, custom).Reason, Result(submit, custom).HttpStatus));
        var operation = r.Operations.Find(submit.OperationId)!;
        Assert.Equal((member.Id, RequestOperations.RequestBatch, "confirm-1", "list:" + r.ListIdN, 4, "completed"),
            (operation.UserId, operation.Kind, operation.ClientId, operation.Subject, operation.Size, operation.State));

        Assert.Equal(3, r.Rows("wants"));
        foreach (var entry in new[] { movie, season, episodes })
        {
            var outcome = Result(submit, entry);
            Assert.Equal(201, outcome.HttpStatus);
            var want = r.Ledger.Find(outcome.RequestId!)!;
            Assert.Equal(member.Id, want.UserId);
            Assert.Equal((RequestOrigin.ListKind, "list:" + r.ListIdN, submit.OperationId), (want.OriginKind, want.OriginSource, want.OperationId));
            var provenance = RequestOriginDetail.Read(want.OriginDetail)!.Provenance!;
            Assert.Equal((r.ListIdN, entry.Id, (long?)rev, submit.OperationId), (provenance.ListId, provenance.EntryId, provenance.ListRevision, provenance.OperationId));
            Assert.StartsWith("op:", want.ClientRequestId, StringComparison.Ordinal);
            Assert.Equal(ListRules.RequestInput(entry)!.Canonical, want.Input.Canonical);
        }

        // Exact scopes: the season, and only the two listed episodes.
        Assert.Equal(new[] { 2 }, r.Ledger.Find(Result(submit, season).RequestId!)!.Input.Seasons);
        Assert.Equal(new[] { new RequestEpisode(3, 1), new RequestEpisode(3, 2) }, r.Ledger.Find(Result(submit, episodes).RequestId!)!.Input.Episodes);

        var links = r.Links.ForList(r.ListIdN);
        Assert.Equal(3, links.Count);
        foreach (var entry in new[] { movie, season, episodes })
        {
            var link = links.Single(l => l.PlaceholderId == entry.Id);
            var input = ListRules.RequestInput(entry)!;
            Assert.Equal((member.Id, Result(submit, entry).RequestId, submit.OperationId, input.Key, input.Canonical, "standard"),
                (link.UserId, link.WantId, link.OperationId, link.TitleKey, link.Scope, link.Edition));
        }
    }

    [Fact]
    public async Task TwoPeopleAskingForOneEntryGetTwoLinksAndShareOneAcquisition()
    {
        using var r = new Rig();
        var a = r.Person("a");
        var b = r.Person("b");
        var movie = Released(603);
        await r.Seed(movie);

        var first = Result(Ok<ListRequestSubmitDto>(await r.Acquisition.SubmitAsync(r.As(a), "press-a", new[] { movie.Id }, None)), movie);
        var second = Result(Ok<ListRequestSubmitDto>(await r.Acquisition.SubmitAsync(r.As(b), "press-b", new[] { movie.Id }, None)), movie);

        Assert.NotEqual(first.RequestId, second.RequestId);
        var wa = r.Ledger.Find(first.RequestId!)!;
        var wb = r.Ledger.Find(second.RequestId!)!;
        Assert.Equal(wa.AcquisitionId, wb.AcquisitionId);
        Assert.True(wb.Follower);
        Assert.Equal(1, r.Rows("jobs"));
        var links = r.Links.ForList(r.ListIdN);
        Assert.Equal(2, links.Count);
        Assert.Contains(links, l => l.UserId == a.Id && l.WantId == first.RequestId && l.PlaceholderId == movie.Id);
        Assert.Contains(links, l => l.UserId == b.Id && l.WantId == second.RequestId && l.PlaceholderId == movie.Id);
    }

    [Fact]
    public async Task TheSameConfirmationIsReplayedWithTheSameRequestsAndAnotherOneForOtherEntriesIsAConflict()
    {
        using var r = new Rig();
        var member = r.Person("member");
        var movie = Released(603);
        var season = SeasonPh(1399, 1, tvdb: 121361);
        var other = Released(604);
        await r.Seed(movie, season, other);

        var first = Ok<ListRequestSubmitDto>(await r.Acquisition.SubmitAsync(r.As(member), "confirm-1", new[] { movie.Id, season.Id }, None));
        var counts = r.Counts();

        var again = Ok<ListRequestSubmitDto>(await r.Acquisition.SubmitAsync(r.As(member), "confirm-1", new[] { movie.Id, season.Id }, None));
        Assert.True(again.Replayed);
        Assert.Equal(first.OperationId, again.OperationId);
        Assert.Equal(first.Results.Select(x => ((RequestOutcome)x.Result!).RequestId), again.Results.Select(x => ((RequestOutcome)x.Result!).RequestId));
        Assert.All(again.Results, x => Assert.Equal(200, ((RequestOutcome)x.Result!).HttpStatus));
        Assert.Equal(counts, r.Counts());

        Error(await r.Acquisition.SubmitAsync(r.As(member), "confirm-1", new[] { movie.Id, other.Id }, None), 409, "idempotency_conflict");
        Assert.Equal(counts, r.Counts());
    }

    [Fact]
    public async Task ReplayingAConfirmationAfterTheTargetChangedAsksWithTheOriginalIdsAndNothingTwice()
    {
        using var r = new Rig();
        var member = r.Person("member");
        var movie = Released(603);
        var season = SeasonPh(1399, 1, tvdb: 121361);
        await r.Seed(movie, season);

        var first = Ok<ListRequestSubmitDto>(await r.Acquisition.SubmitAsync(r.As(member), "confirm-1", new[] { movie.Id, season.Id }, None));
        var counts = r.Counts();
        var inputs = r.H.Database.Read(c =>
        {
            using var cmd = RequestLedger.Cmd(c, null, "SELECT client_request_id FROM request_inputs ORDER BY client_request_id");
            using var reader = cmd.ExecuteReader();
            var ids = new List<string>();
            while (reader.Read())
            {
                ids.Add(reader.GetString(0));
            }

            return ids;
        });

        // The backend target moves (another instance and connection generation) before the retry arrives.
        r.Policy.People[member.Id] = r.Policy.People[member.Id] with { InstanceId = "r2", ConnectionGeneration = "g2" };
        var again = Ok<ListRequestSubmitDto>(await r.Acquisition.SubmitAsync(r.As(member), "confirm-1", new[] { movie.Id, season.Id }, None));

        Assert.True(again.Replayed);
        Assert.Equal(first.OperationId, again.OperationId);
        Assert.Equal(first.Results.Select(x => ((RequestOutcome)x.Result!).RequestId), again.Results.Select(x => ((RequestOutcome)x.Result!).RequestId));
        Assert.All(again.Results, x => Assert.Equal(200, ((RequestOutcome)x.Result!).HttpStatus));
        // No second want, job (send), input or link.
        Assert.Equal(counts, r.Counts());
        Assert.Equal(inputs.Count, r.Rows("request_inputs"));
    }

    // Review round 2 (4c1-B1-r2): the confirmation stores each entry's normalised input, target and request id before
    // anything is asked. Execution stops after the first ask; then the series entry's metadata grows (a second season is
    // expected). The retry of the same confirmation resumes from what was stored: the movie is answered from its first
    // ask, the series is asked with the scope that was confirmed, and nothing is asked twice.
    [Fact]
    public async Task AConfirmationRetriedAfterAnEntrysMetadataGrewResumesWithWhatWasConfirmed()
    {
        using var r = new Rig();
        var member = r.Person("member");
        var movie = Released(603);
        var series = SeriesPh(1399, tvdb: 121361);
        series.Expected = new List<PlaceholderEpisode> { new() { S = 1, E = 1, AirDate = Past }, new() { S = 1, E = 2, AirDate = Past } };
        ReconcileSeries(series, 2);
        await r.Seed(movie, series);
        using var stop = new CancellationTokenSource();
        var asks = 0;
        r.Policy.Before = (_, _) =>
        {
            // The process dies while the second ask is on its way (the first one is in).
            if (++asks == 2)
            {
                stop.Cancel();
                stop.Token.ThrowIfCancellationRequested();
            }

            return Task.CompletedTask;
        };
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => r.Acquisition.SubmitAsync(r.As(member), "confirm-grow", new[] { movie.Id, series.Id }, stop.Token));
        r.Policy.Before = null;
        Assert.Equal(1, r.Rows("wants"));
        var firstWant = r.H.Database.Read(c =>
        {
            using var cmd = RequestLedger.Cmd(c, null, "SELECT id FROM wants");
            return (string)cmd.ExecuteScalar()!;
        });

        // Seerr now knows a second season of the series.
        using (await r.H.Store.LockAsync(r.ListIdN))
        {
            var doc = r.H.Store.LoadForUpdate(r.ListIdN, ListKinds.Playlist);
            var grown = doc.Items.Single(p => p.Id == series.Id);
            ReconcileSeries(grown, 2, 1);
            Assert.Equal(new[] { 1, 2 }, ListRules.RequestInput(grown)!.Seasons);
            r.H.Store.Save(doc);
        }

        var resumed = Ok<ListRequestSubmitDto>(await r.Acquisition.SubmitAsync(r.As(member), "confirm-grow", new[] { movie.Id, series.Id }, None));

        Assert.True(resumed.Replayed);
        Assert.Equal(firstWant, Result(resumed, movie).RequestId);
        Assert.Equal(201, Result(resumed, series).HttpStatus);
        Assert.Equal(2, r.Rows("wants"));
        var scope = r.Ledger.ForTitle("tv:tvdb:121361").Single();
        Assert.Equal(new[] { 1 }, scope.Input.Seasons);
    }

    [Fact]
    public async Task AShareRevokedWhileAConfirmationAsksStopsTheAsksNotYetMade()
    {
        using var r = new Rig();
        var member = r.Person("member");
        var first = Released(603);
        var second = Released(604);
        await r.Seed(first, second);
        // The playlist is public when the confirmation is checked and private from the first ask on.
        r.Policy.Before = (_, _) =>
        {
            r.Playlist.Info = r.Playlist.Info with { OpenAccess = false };
            return Task.CompletedTask;
        };

        var submit = Ok<ListRequestSubmitDto>(await r.Acquisition.SubmitAsync(r.As(member), "confirm-revoked", new[] { first.Id, second.Id }, None));

        Assert.Equal(201, Result(submit, first).HttpStatus);
        Assert.Equal(("not_found", 404), (Result(submit, second).Reason, Result(submit, second).HttpStatus));
        Assert.Equal(1, r.Rows("wants"));
    }

    [Fact]
    public async Task AShareRevokedWhileAPreviewRanAnswersNotFound()
    {
        using var r = new Rig();
        var member = r.Person("member");
        var movie = Released(603);
        await r.Seed(movie);
        r.Policy.Before = (_, _) =>
        {
            r.Playlist.Info = r.Playlist.Info with { OpenAccess = false };
            return Task.CompletedTask;
        };

        Error(await r.Acquisition.PreviewAsync(r.As(member), new[] { movie.Id }, false, None), 404, "not_found");
    }

    [Fact]
    public async Task ANewConfirmationForTheSameEntryIsANewOperationThatTheLedgerMergesWithoutASecondSend()
    {
        using var r = new Rig();
        var member = r.Person("member");
        var movie = Released(603);
        await r.Seed(movie);

        var first = Ok<ListRequestSubmitDto>(await r.Acquisition.SubmitAsync(r.As(member), "press-1", new[] { movie.Id }, None));
        var jobs = r.Rows("jobs");
        var second = Ok<ListRequestSubmitDto>(await r.Acquisition.SubmitAsync(r.As(member), "press-2", new[] { movie.Id }, None));

        Assert.False(second.Replayed);
        Assert.NotEqual(first.OperationId, second.OperationId);
        Assert.Equal(2, r.Rows("request_operations"));
        Assert.Equal(Result(first, movie).RequestId, Result(second, movie).RequestId);
        Assert.Equal(200, Result(second, movie).HttpStatus);
        Assert.Equal(1, r.Rows("wants"));
        Assert.Equal(jobs, r.Rows("jobs"));
        // The link is per person and request: the second confirmation adds no second link for the same request.
        var link = Assert.Single(r.Links.ForList(r.ListIdN));
        Assert.Equal((Result(first, movie).RequestId, first.OperationId), (link.WantId, link.OperationId));
    }

    [Fact]
    public async Task ASplitAskLinksBothTheRequestThatWentAheadAndTheOneThatWaits()
    {
        using var r = new Rig();
        r.Policy.Configuration.ArrRequestSeriesThreshold = 2;
        var member = r.Person("member");
        var series = SeriesPh(1399, tvdb: 121361);
        series.Expected = Enumerable.Range(1, 4).Select(s => new PlaceholderEpisode { S = s, E = 1 }).ToList();
        Assert.Null(ListRules.RequestInput(series)); // display facts alone cannot confer acquisition authority
        ReconcileSeries(series, 1, 1, 1, 1);
        await r.Seed(series);

        var outcome = Result(Ok<ListRequestSubmitDto>(await r.Acquisition.SubmitAsync(r.As(member), "split", new[] { series.Id }, None)), series);

        Assert.Equal("split", outcome.Outcome);
        Assert.NotNull(outcome.HeldRequestId);
        var links = r.Links.ForList(r.ListIdN);
        Assert.Equal(new[] { outcome.RequestId, outcome.HeldRequestId }.OrderBy(x => x), links.Select(l => (string?)l.WantId).OrderBy(x => x));
        Assert.All(links, l => Assert.Equal(series.Id, l.PlaceholderId));
    }

    [Fact]
    public async Task OrphanLinksArePrunedAndLinksOfLiveRequestsStay()
    {
        using var r = new Rig();
        var member = r.Person("member");
        var movie = Released(603);
        await r.Seed(movie);
        var outcome = Result(Ok<ListRequestSubmitDto>(await r.Acquisition.SubmitAsync(r.As(member), "c", new[] { movie.Id }, None)), movie);
        r.Links.Add(new ListLink(r.ListIdN, movie.Id, member.Id, "gone-want", null, "movie:tmdb:603", "{}", "standard"), r.Now);

        Assert.Equal(1, r.Links.PruneOrphans());
        Assert.Equal(new[] { outcome.RequestId }, r.Links.ForList(r.ListIdN).Select(l => (string?)l.WantId));
    }

    // ── the request input of an entry ─────────────────────────────────

    [Fact]
    public void AMovieAsksForTheMovieInItsEdition()
    {
        var movie = Movie(603);
        var input = ListRules.RequestInput(movie)!;
        Assert.Equal(("movie:tmdb:603", "movie", "standard"), (input.Key, input.Scope, input.Variant));
        Assert.Equal("standard", ListRules.EditionOf(movie));

        movie.Edition = ListRules.FourK;
        var fourK = ListRules.RequestInput(movie)!;
        Assert.Equal(("movie:tmdb:603", "movie", "4k"), (fourK.Key, fourK.Scope, fourK.Variant));
        Assert.Equal("4k", ListRules.EditionOf(movie));
        movie.Edition = "8k";
        Assert.Equal("standard", ListRules.EditionOf(movie));
    }

    [Fact]
    public void TvEntriesAskForTheirExactScopeKeyedByTvdbThenTmdb()
    {
        var season = SeasonPh(1399, 2, tvdb: 121361);
        var input = ListRules.RequestInput(season)!;
        Assert.Equal(("tv:tvdb:121361", "seasons", "standard"), (input.Key, input.Scope, input.Variant));
        Assert.Equal(new[] { 2 }, input.Seasons);
        Assert.Equal("tv:tmdb:1399", ListRules.TitleKeyOf(SeasonPh(1399, 2))!.ToString());

        var episodes = EpisodesPh(1399, 3, 5, 1, 2);
        var exact = ListRules.RequestInput(episodes)!;
        Assert.Equal(("tv:tmdb:1399", "episodes"), (exact.Key, exact.Scope));
        Assert.Equal(new[] { new RequestEpisode(3, 1), new RequestEpisode(3, 2), new RequestEpisode(3, 5) }, exact.Episodes);
        Assert.Empty(exact.Seasons);

        var series = SeriesPh(1399, tvdb: 121361);
        Assert.Null(ListRules.RequestInput(series)); // seasons not known yet
        series.Expected = new List<PlaceholderEpisode> { new() { S = 0, E = 1 }, new() { S = 2, E = 1 }, new() { S = 1, E = 1 }, new() { S = 2, E = 2 } };
        Assert.Null(ListRules.RequestInput(series)); // legacy raw expectations are still unknown
        ReconcileSeries(series, 1, 2);
        series.Expected.Insert(0, new PlaceholderEpisode { S = 0, E = 1 }); // stale/display special stays irrelevant
        var whole = ListRules.RequestInput(series)!;
        Assert.Equal(("tv:tvdb:121361", "seasons"), (whole.Key, whole.Scope));
        Assert.Equal(new[] { 1, 2 }, whole.Seasons); // regular seasons only
        Assert.Equal(new[] { 1, 2, 3 }, ListRules.RequestInput(series, new[] { 3, 0, 2, 1 })!.Seasons);
        Assert.Null(ListRules.RequestInput(SeriesPh(1399), new[] { 0 }));

        season.Edition = ListRules.FourK;
        Assert.Equal("4k", ListRules.RequestInput(season)!.Variant);
    }

    [Fact]
    public void ACustomEntryHasNoKeyAndNoRequest()
    {
        var custom = Custom("Home video");
        Assert.Null(ListRules.TitleKeyOf(custom));
        Assert.Null(ListRules.RequestInput(custom));
        var noId = Movie(603);
        noId.TmdbId = null;
        Assert.Null(ListRules.RequestInput(noId));
        noId.ImdbId = "tt0133093";
        Assert.Equal("movie:imdb:tt0133093", ListRules.TitleKeyOf(noId)!.ToString());
    }
}
