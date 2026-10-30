using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace JE.Tests;

/// <summary>
/// F83 (live incident: TMDB's S01E01 went out as Sonarr's S01E01, another episode in TVDB order): an ask made by TMDB's episode
/// numbering is matched to the request target's Sonarr episodes by ids only (TMDB episode, its TVDB episode id, the Sonarr
/// episode with that tvdbId) at the moment the series is in Sonarr; one that can't be matched is held for an administrator and
/// they are told; titles are never compared.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEpisodeIdentityTests
{
    private const int Tvdb = 78874;   // Firefly
    private const int TmdbSeries = 1437;

    private static MutationInput Ask(params (int Season, int Episode)[] episodes)
        => new() { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = episodes.Select(e => new RequestEpisode(e.Season, e.Episode)).ToArray(), Numbering = EpisodeIdentity.Tmdb };

    // TMDB's external ids by (season, episode): the TVDB episode id, or none (null).
    private static Func<int, int, int, CancellationToken, Task<EpisodeExternalId>> Tmdb(Dictionary<(int, int), int?> ids, List<string>? asked = null)
        => (series, season, episode, _) =>
        {
            asked?.Add($"{series}:{season}x{episode}");
            return Task.FromResult(ids.TryGetValue((season, episode), out var id) ? id is int tvdb ? new EpisodeExternalId(true, tvdb) : EpisodeExternalId.None : EpisodeExternalId.None);
        };

    private static DirectArrBackend Direct(IntegrationRequestBackendsTests.Lab lab, Func<int, int, int, CancellationToken, Task<EpisodeExternalId>>? tmdb, Func<TimeSpan, CancellationToken, Task>? delay = null)
        => new(lab.Arr.Factory, lab.Store, null, delay ?? ((_, _) => Task.CompletedTask), tmdb);

    // Firefly as the lab's Sonarr lists it (TVDB order): S01E01 "Serenity" ... ; TMDB orders it by air date, so TMDB's S01E01 is
    // Sonarr's S01E02 (and so on). Each row carries a title that matches TMDB's title of a DIFFERENT episode: a title match would
    // pick the wrong one.
    private static void ExistingFirefly(IntegrationRequestBackendsTests.Lab lab, bool withTvdbIds = true)
    {
        lab.Sonarr.Series.Add(new JsonObject
        {
            ["id"] = 40, ["tvdbId"] = Tvdb, ["tmdbId"] = TmdbSeries, ["title"] = "Firefly", ["monitored"] = true, ["monitorNewItems"] = "none",
            ["seasons"] = new JsonArray(new JsonObject { ["seasonNumber"] = 0, ["monitored"] = false }, new JsonObject { ["seasonNumber"] = 1, ["monitored"] = false }),
        });
        var rows = new (int Id, int Season, int Episode, int Tvdb, string Title)[]
        {
            (4001, 1, 1, 297989, "Serenity"), (4002, 1, 2, 297990, "The Train Job"), (4003, 1, 3, 297991, "Bushwhacked"),
            (4012, 1, 12, 297999, "The Message"), (4100, 0, 1, 298100, "Here's How It Was"),
        };
        foreach (var r in rows)
        {
            var row = new JsonObject { ["id"] = r.Id, ["seriesId"] = 40, ["seasonNumber"] = r.Season, ["episodeNumber"] = r.Episode, ["title"] = r.Title, ["monitored"] = false, ["hasFile"] = false };
            if (withTvdbIds) row["tvdbId"] = r.Tvdb;
            lab.Sonarr.Episodes.Add(row);
        }
    }

    private static int[] Ids(JsonNode? array) => array!.AsArray().Select(n => (int)n!).OrderBy(n => n).ToArray();

    // The one EpisodeSearch sent: its episode ids, as "id,id".
    private static string Search(FakeArr.Host host)
    {
        var search = JsonNode.Parse(host.Writes.Single(w => w.Path == "/api/v3/command" && w.Body.Contains("EpisodeSearch", StringComparison.Ordinal)).Body)!;
        Assert.Equal("EpisodeSearch", (string)search["name"]!);
        return string.Join(",", Ids(search["episodeIds"]));
    }

    [Fact]
    public async Task ATmdbNumberedAskOnAnExistingSeriesIsSentAsTheSonarrEpisodeWithItsTvdbIdNeverByNumberOrTitle()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab();
        ExistingFirefly(lab);
        var asked = new List<string>();
        // TMDB's S01E01 is "The Train Job" (TVDB 297990): Sonarr's S01E02. Sonarr's S01E01 (another episode) must stay alone.
        var direct = Direct(lab, Tmdb(new() { [(1, 1)] = 297990 }, asked));
        var result = await direct.SendAsync(lab.Job(Ask((1, 1)), "Sonarr"), () => null, default);
        Assert.True(result.Confirmed, result.Outcome.Message);
        Assert.Equal(new[] { 4002 }, Ids(JsonNode.Parse(lab.Sonarr.Writes.Single(w => w.Path == "/api/v3/episode/monitor").Body)!["episodeIds"]));
        Assert.Equal("4002", Search(lab.Sonarr));
        Assert.Equal(new[] { 4002 }, lab.Sonarr.Episodes.Where(e => (bool)e["monitored"]!).Select(e => (int)e["id"]!).ToArray());
        // The TMDB series id came from the Sonarr series row (the key is the TVDB id) and each asked episode was read once.
        Assert.Equal(new[] { $"{TmdbSeries}:1x1" }, asked);
        // The outcome carries the renumbering for the ledger: TMDB's S01E01 is Sonarr's S01E02.
        Assert.Equal(new[] { new EpisodeRenumbering(new(1, 1), new(1, 2), 297990) }, result.Renumbered!.ToArray());
    }

    [Fact]
    public async Task ATmdbNumberedAskForANewSeriesIsMatchedRightAfterTheAddAndSendsOnlyTheMatchedEpisode()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab();
        lab.Sonarr.Lookup.Add(IntegrationRequestBackendsTests.Lab.SeriesLookup(Tvdb, "Firefly", 1));
        lab.Sonarr.Lookup[0]["tmdbId"] = TmdbSeries;
        lab.Sonarr.EpisodeList[Tvdb] = new[] { (1, 1), (1, 2), (1, 3) };
        lab.Sonarr.EpisodeTvdbIds[(Tvdb, 1, 1)] = 297989;
        lab.Sonarr.EpisodeTvdbIds[(Tvdb, 1, 2)] = 297990;
        lab.Sonarr.EpisodeTvdbIds[(Tvdb, 1, 3)] = 297991;
        var direct = Direct(lab, Tmdb(new() { [(1, 1)] = 297990 }));
        var result = await direct.SendAsync(lab.Job(Ask((1, 1)), "Sonarr"), () => null, default);
        Assert.True(result.Confirmed, result.Outcome.Message);
        Assert.Equal("accepted", result.Outcome.Outcome);
        var s1e2 = (int)lab.Sonarr.Episodes.Single(e => (int)e["episodeNumber"]! == 2)["id"]!;
        Assert.Equal(new[] { s1e2 }, lab.Sonarr.Episodes.Where(e => (bool)e["monitored"]!).Select(e => (int)e["id"]!).ToArray());
        Assert.Equal(s1e2.ToString(System.Globalization.CultureInfo.InvariantCulture), Search(lab.Sonarr));
    }

    [Fact]
    public async Task AnAskSpanningEpisodesThatSonarrNumbersInOtherSeasonsSendsEachById()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab();
        ExistingFirefly(lab);
        // TMDB files "The Message" under Specials (S00E12) and "Here's How It Was" as S01E14: Sonarr has them as S01E12 and S00E01.
        var direct = Direct(lab, Tmdb(new() { [(0, 12)] = 297999, [(1, 14)] = 298100 }));
        var result = await direct.SendAsync(lab.Job(Ask((0, 12), (1, 14)), "Sonarr"), () => null, default);
        Assert.True(result.Confirmed, result.Outcome.Message);
        // No "season not listed yet" wait for TMDB's seasons, and no number lookups: exactly the two id-matched episodes.
        Assert.Equal("4012,4100", Search(lab.Sonarr));
        Assert.Equal(new[] { new EpisodeRenumbering(new(0, 12), new(1, 12), 297999), new EpisodeRenumbering(new(1, 14), new(0, 1), 298100) }, result.Renumbered!.ToArray());
    }

    [Fact]
    public async Task AnEpisodeTmdbListsNoTvdbIdForIsHeldBeforeAnythingIsWrittenEvenForANewSeries()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab();
        lab.Sonarr.Lookup.Add(IntegrationRequestBackendsTests.Lab.SeriesLookup(Tvdb, "Firefly", 1));
        lab.Sonarr.EpisodeList[Tvdb] = new[] { (1, 1) };
        var direct = Direct(lab, Tmdb(new() { [(1, 1)] = null }));
        var result = await direct.SendAsync(lab.Job(Ask((1, 1)), "Sonarr"), () => null, default);
        Assert.True(result.Parked);
        Assert.True(result.VerifiedNotSent);
        Assert.Equal(EpisodeIdentity.Unresolved, result.Outcome.Reason);
        Assert.Empty(lab.Sonarr.Writes);
        // Without any TMDB reader (or TMDB id) nothing can be matched either: held, never sent by number.
        var blind = await Direct(lab, null).SendAsync(lab.Job(Ask((1, 1)), "Sonarr"), () => null, default);
        Assert.Equal((EpisodeIdentity.Unresolved, true), (blind.Outcome.Reason, blind.Parked));
        Assert.Empty(lab.Sonarr.Writes);
        // TMDB that can't be read now concludes nothing: tried again later, nothing written.
        var down = await Direct(lab, (_, _, _, _) => Task.FromResult(EpisodeExternalId.Unread)).SendAsync(lab.Job(Ask((1, 1)), "Sonarr"), () => null, default);
        Assert.Equal((false, true, true), (down.Parked, down.Retryable, down.VerifiedNotSent));
        Assert.Empty(lab.Sonarr.Writes);
    }

    [Fact]
    public async Task ASonarrEpisodeListWithoutTheTvdbIdIsWaitedForOnceAfterARefreshThenHeld()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab();
        ExistingFirefly(lab, withTvdbIds: false);
        var direct = Direct(lab, Tmdb(new() { [(1, 1)] = 297990 }));
        var job = lab.Job(Ask((1, 1)), "Sonarr");
        var first = await direct.SendAsync(job, () => null, default);
        // Not listed by that id yet: Sonarr is asked to refresh the series and the request is checked again shortly.
        Assert.Equal((EpisodeIdentity.Pending, false, true), (first.Outcome.Reason, first.Parked, first.Retryable));
        Assert.Equal(EpisodeIdentity.PendingWait, first.RetryAfter);
        var refresh = Assert.Single(lab.Sonarr.Writes);
        Assert.Contains("RefreshSeries", refresh.Body, StringComparison.Ordinal);
        lab.Sonarr.Writes.Clear();
        // Still not there at the next check: held for an administrator, nothing monitored or searched (never by number: S01E01 exists).
        var second = await direct.SendAsync(job with { Reason = first.Outcome.Reason }, () => null, default);
        Assert.Equal((EpisodeIdentity.Unresolved, true), (second.Outcome.Reason, second.Parked));
        Assert.Empty(lab.Sonarr.Writes);
        Assert.DoesNotContain(lab.Sonarr.Episodes, e => (bool)e["monitored"]!);
    }

    [Fact]
    public async Task ANewSeriesWhoseEpisodeIdsArriveLateIsWaitedForBoundedAndHeldAfterItsOwnAdd()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab();
        lab.Sonarr.Lookup.Add(IntegrationRequestBackendsTests.Lab.SeriesLookup(Tvdb, "Firefly", 1));
        lab.Sonarr.Lookup[0]["tmdbId"] = TmdbSeries;
        lab.Sonarr.EpisodeList[Tvdb] = new[] { (1, 1), (1, 2) };
        // Sonarr fills the episodes' TVDB ids a few reads after the add (its first refresh).
        var waits = 0;
        Task Late(TimeSpan _, CancellationToken __)
        {
            if (++waits == 3)
            {
                foreach (var e in lab.Sonarr.Episodes) e["tvdbId"] = (int)e["episodeNumber"]! == 2 ? 297990 : 297989;
            }
            return Task.CompletedTask;
        }
        var direct = Direct(lab, Tmdb(new() { [(1, 1)] = 297990 }), Late);
        var result = await direct.SendAsync(lab.Job(Ask((1, 1)), "Sonarr"), () => null, default);
        Assert.True(result.Confirmed, result.Outcome.Message);
        Assert.Equal(3, waits);
        var s1e2 = (int)lab.Sonarr.Episodes.Single(e => (int)e["episodeNumber"]! == 2)["id"]!;
        Assert.Equal(s1e2.ToString(System.Globalization.CultureInfo.InvariantCulture), Search(lab.Sonarr));

        // Ids that never arrive within the bounded wait: the add stays upstream, so the request resumes once, then is held
        // with its certainty unknown (no cancel or refund as if unsent).
        using var lab2 = new IntegrationRequestBackendsTests.Lab();
        lab2.Sonarr.Lookup.Add(IntegrationRequestBackendsTests.Lab.SeriesLookup(Tvdb, "Firefly", 1));
        lab2.Sonarr.Lookup[0]["tmdbId"] = TmdbSeries;
        lab2.Sonarr.EpisodeList[Tvdb] = new[] { (1, 1), (1, 2) };
        var counted = 0;
        var never = Direct(lab2, Tmdb(new() { [(1, 1)] = 297990 }), (_, _) => { counted++; return Task.CompletedTask; });
        var job = lab2.Job(Ask((1, 1)), "Sonarr");
        var resumed = await never.SendAsync(job, () => null, default);
        Assert.Equal((EpisodeIdentity.Pending, true, ArrActionStatus.Unknown), (resumed.Outcome.Reason, resumed.Retryable, resumed.Outcome.Certainty));
        Assert.Equal(EpisodeIdentity.PendingWait, resumed.RetryAfter);
        Assert.Equal((int)DirectArrBackend.EpisodeWait.TotalSeconds, counted);
        var held = await never.SendAsync(job with { Uncertain = true, Reason = resumed.Outcome.Reason }, () => null, default);
        Assert.Equal((EpisodeIdentity.Unresolved, true, ArrActionStatus.Unknown), (held.Outcome.Reason, held.Parked, held.Outcome.Certainty));
        Assert.Single(lab2.Sonarr.Writes, w => w.Path == "/api/v3/series");
        Assert.DoesNotContain(lab2.Sonarr.Writes, w => w.Body.Contains("EpisodeSearch", StringComparison.Ordinal));
    }

    [Fact]
    public async Task AReadBackOfAStillTmdbNumberedJobChecksTheIdMatchedEpisodes()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab();
        ExistingFirefly(lab);
        var asked = new List<string>();
        var direct = Direct(lab, Tmdb(new() { [(1, 1)] = 297990 }, asked));
        var job = lab.Job(Ask((1, 1)), "Sonarr");
        // Sonarr's own S01E01 monitored says nothing about TMDB's S01E01 (EI-7: a number-based read-back calls that "the change").
        lab.Sonarr.Episodes.Single(e => (int)e["id"]! == 4001)["monitored"] = true;
        var before = await direct.ReadBackAsync(job, default);
        Assert.False(before.Confirmed);
        Assert.True(before.Resumes);
        Assert.Contains("has part of the change", before.Outcome.Message, StringComparison.Ordinal);
        Assert.Equal(new[] { $"{TmdbSeries}:1x1" }, asked);
        lab.Sonarr.Episodes.Single(e => (int)e["id"]! == 4002)["monitored"] = true;
        var after = await direct.ReadBackAsync(job, default);
        Assert.True(after.Resumes);   // present and matched: the search is sent again to be sure
        Assert.Contains("has the change", after.Outcome.Message, StringComparison.Ordinal);
    }

    // ------------------------------------------------------------------ the ledger: noted at the ask, renumbered at the send

    private static (IntegrationRequestLedgerTests.Rig Rig, IntegrationRequestBackendsTests.Lab Lab) Ledger(IntegrationRequestBackendsTests.Lab lab, bool tmdbNumbering = true)
    {
        var r = new IntegrationRequestLedgerTests.Rig();
        r.Policy.Configuration.RadarrInstances = lab.Config.RadarrInstances;
        r.Policy.Configuration.SonarrInstances = lab.Config.SonarrInstances;
        r.Policy.Adjust = (user, input, facts) =>
        {
            var instance = lab.Instance("Sonarr");
            return facts with { InstanceId = instance.Id, ConnectionGeneration = lab.Arr.Factory.ConnectionGeneration(instance.Id) ?? string.Empty };
        };
        r.Service.Numbering = (_, _, _) => Task.FromResult((true, tmdbNumbering));
        return (r, lab);
    }

    [Fact]
    public async Task AnAskIsNotedAsTmdbNumberedByTheServerAndTheSendRenumbersItAndItsSharersToSonarrsEpisode()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab();
        ExistingFirefly(lab);
        var (r, _) = Ledger(lab);
        using var rig = r;
        // A caller can't choose the numbering: the body's note is replaced by the server's.
        var body = new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        var kid = await rig.Create(rig.Kid, body);
        var member = await rig.Create(rig.Member, body with { Numbering = "sonarr" });
        Assert.All(new[] { kid, member }, o => Assert.True(o.HttpStatus < 300, o.Reason));
        Assert.All(rig.Ledger.ForTitle("tv:tvdb:" + Tvdb), w => Assert.Equal(EpisodeIdentity.Tmdb, w.Input.Numbering));
        // A retry of the same ask (its answer lost) gets its receipt: the note isn't part of what was asked.
        var client = Guid.NewGuid().ToString("N");
        var first = await rig.Service.CreateAsync(rig.Admin, new(client, body), default);
        var again = await rig.Service.CreateAsync(rig.Admin, new(client, body), default);
        Assert.Equal(first.RequestId, again.RequestId);
        await rig.Runner(Direct(lab, Tmdb(new() { [(1, 1)] = 297990 }))).TickAsync(default);
        var wants = rig.Ledger.ForTitle("tv:tvdb:" + Tvdb);
        // Everyone's TMDB S01E01 is now Sonarr's S01E02: what went out, what arrives and what shows are one numbering.
        Assert.All(wants, w => Assert.Null(w.Input.Numbering));
        Assert.All(wants, w => Assert.Equal(new[] { new RequestEpisode(1, 2) }, w.Input.Episodes));
        Assert.Contains(wants, w => w.Status == "sent");
        var sent = rig.Ledger.Dispatches("tv:tvdb:" + Tvdb);
        Assert.NotEmpty(sent);
        Assert.All(sent, d => Assert.Equal(new[] { new RequestEpisode(1, 2) }, d.Input.Episodes));
        Assert.All(rig.Ledger.ForTitle("tv:tvdb:" + Tvdb).SelectMany(w => rig.Ledger.ForWant(w.Id)), j => Assert.Equal(j.Input.Fingerprint, j.Fingerprint));
        Assert.Equal(new[] { 4002 }, lab.Sonarr.Episodes.Where(e => (bool)e["monitored"]!).Select(e => (int)e["id"]!).ToArray());
    }

    [Fact]
    public async Task AnUnmatchableAskIsHeldWithItsReasonAndAnUnreadableLibraryRecordsNothing()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab();
        ExistingFirefly(lab);
        var (r, _) = Ledger(lab);
        using var rig = r;
        var ask = await rig.Create(rig.Admin, new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } });
        await rig.Runner(Direct(lab, Tmdb(new() { [(1, 1)] = null }))).TickAsync(default);
        var want = rig.Ledger.Find(ask.RequestId!)!;
        Assert.Equal(("pending", EpisodeIdentity.Unresolved), (want.Status, want.Reason));
        Assert.Equal("parked", rig.Ledger.ForWant(want.Id).Single().State);
        Assert.Empty(lab.Sonarr.Writes);
        // The library couldn't be read: nobody can tell which numbering the episodes are in, so nothing is recorded.
        rig.Service.Numbering = (_, _, _) => Task.FromResult((false, false));
        var unchecked_ = await rig.Create(rig.Admin, new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 3) } });
        Assert.Equal(("numbering_unchecked", 503), (unchecked_.Reason, unchecked_.HttpStatus));
        // Whole seasons are unaffected.
        var season = await rig.Create(rig.Admin, new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "seasons", Seasons = new[] { 1 } });
        Assert.True(season.HttpStatus < 300, season.Reason);
        Assert.Null(rig.Ledger.Find(season.RequestId!)!.Input.Numbering);
    }

    [Fact]
    public void EpisodeNumbersCompareOnlyWithinOneNumbering()
    {
        var tmdb = new MutationInput { Key = "tv:tvdb:1", Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) }, Numbering = EpisodeIdentity.Tmdb };
        var sonarr = tmdb with { Numbering = null };
        Assert.False(tmdb.Overlaps(sonarr));
        Assert.NotNull(tmdb.Extra(new[] { sonarr }));
        Assert.NotNull(sonarr.Extra(new[] { tmdb }));
        Assert.Null(tmdb.Extra(new[] { tmdb }));
        // EI-3: nor does a Sonarr season (TMDB's S00E12 may be Sonarr's S01E12), and a TMDB-numbered ask covers no Sonarr episode.
        Assert.NotNull(tmdb.Extra(new[] { new MutationInput { Key = "tv:tvdb:1", Scope = "seasons", Seasons = new[] { 1 } } }));
        Assert.False(tmdb.Overlaps(new MutationInput { Key = "tv:tvdb:1", Scope = "seasons", Seasons = new[] { 1 } }));
        Assert.False(tmdb.Covers(new RequestEpisode(1, 1)));
        Assert.True(sonarr.Covers(new RequestEpisode(1, 1)));
        // Only the server's own note is valid, and only on single episodes; it is not part of the fingerprint.
        Assert.Null((tmdb with { Numbering = "tvdb" }).Normalize());
        Assert.Null(new MutationInput { Key = "tv:tvdb:1", Scope = "seasons", Seasons = new[] { 1 }, Numbering = EpisodeIdentity.Tmdb }.Normalize());
        Assert.Equal(sonarr.Fingerprint, tmdb.Fingerprint);
        Assert.DoesNotContain("Numbering", sonarr.Canonical, StringComparison.Ordinal);
        Assert.Contains("\"Numbering\":\"tmdb\"", tmdb.Canonical, StringComparison.Ordinal);
    }

    [Fact]
    public void ExternalIdsAreReadFromTmdbsTvdbIdOnly()
    {
        Assert.Equal(new EpisodeExternalId(true, 297990), EpisodeIdentity.Parse("{\"id\":1,\"tvdb_id\":297990,\"imdb_id\":\"tt0579539\"}"));
        Assert.Equal(EpisodeExternalId.None, EpisodeIdentity.Parse("{\"id\":1,\"tvdb_id\":null}"));
        Assert.Equal(EpisodeExternalId.None, EpisodeIdentity.Parse("{\"id\":1,\"tvdb_id\":0}"));
        Assert.Equal(EpisodeExternalId.Unread, EpisodeIdentity.Parse("not json"));
        // Two Sonarr rows with one TVDB id, or a row without one: never matched.
        var rows = JsonSerializer.Deserialize<List<JsonElement>>("[{\"id\":1,\"seasonNumber\":1,\"episodeNumber\":1,\"tvdbId\":5},{\"id\":2,\"seasonNumber\":1,\"episodeNumber\":2,\"tvdbId\":5},{\"id\":3,\"seasonNumber\":1,\"episodeNumber\":3}]")!;
        var (matched, unmatched) = EpisodeIdentity.Match(new[] { new RequestEpisode(1, 1) }, new Dictionary<RequestEpisode, int> { [new(1, 1)] = 5 }, rows);
        Assert.Empty(matched);
        Assert.Single(unmatched);
    }

    /// <summary>
    /// No title comparison anywhere in episode identity (F83, ux-task2): the identity code reads no name, title, overview or air
    /// date of an episode, on either side; only TVDB ids, TMDB's external ids and Sonarr's own numbers.
    /// </summary>
    [Fact]
    public void EpisodeIdentityNeverReadsAnEpisodesTitleOrAnyOtherDescriptiveField()
    {
        var root = Path.Combine(IntegrationAutoRequestLedgerTests.Root(), "Jellyfin.Plugin.JellyfinEnhanced", "Services", "Acquire", "Requests");
        var identity = File.ReadAllText(Path.Combine(root, "EpisodeIdentity.cs"));
        var direct = File.ReadAllText(Path.Combine(root, "DirectArrBackend.cs"));
        // The identity paths of the executor: TvdbIdsAsync, and every block that matches by EpisodeIdentity.
        var forbidden = new Regex("\"(title|name|overview|airDate|airDateUtc|absoluteEpisodeNumber|sceneEpisodeNumber|still_path)\"", RegexOptions.IgnoreCase);
        Assert.Empty(forbidden.Matches(identity));
        Assert.DoesNotMatch(new Regex(@"\.Title\b(?!Key|Aliases)"), Regex.Replace(identity, "TitleKey|TitleAliases|key\\.Title|aliases\\?\\.Of\\(key\\.Title\\)", string.Empty));
        // (A Sonarr command's own "name" field, RefreshSeries, is the only "name" there.)
        foreach (Match block in Regex.Matches(direct, @"(?s)(TvdbIdsAsync\(TitleKey.*?\n        \})|(if \(tvdbIds != null\)\s*\{.*?\n            \})"))
            Assert.Empty(forbidden.Matches(block.Value.Replace("[\"name\"] = \"RefreshSeries\"", string.Empty, StringComparison.Ordinal)));
        Assert.True(Regex.Matches(direct, @"if \(tvdbIds != null\)").Count >= 1);
    }

    // ------------------------------------------------------------------ the administrators are told

    private sealed class Unmatched : IRequestBackend
    {
        public Task PrepareAsync(Guid user, MutationInput input, CancellationToken ct) => Task.CompletedTask;
        public RequestBackendBinding Binding(Guid user, MutationInput input) => new();
        public Task<RequestBackendResult> SendAsync(RequestJob job, Func<string?> finalGuard, CancellationToken ct)
            => Task.FromResult(finalGuard() is { } refusal ? RequestBackendResult.Hold(refusal) : BackendResults.Hold(EpisodeIdentity.Unresolved, "Sonarr has no episode with that TVDB id."));
        public Task<RequestBackendResult> ReadBackAsync(RequestJob job, CancellationToken ct) => Task.FromResult(BackendResults.NotThere("nothing"));
    }

    [Fact]
    public async Task AHeldUnmatchableEpisodeTellsTheAdministratorsOnceAndNotTheAsker()
    {
        using var rig = await IntegrationNotificationsTests.Started();
        rig.Config.ArrPhase3Enabled = true;
        rig.Config.ArrRequestBackend = "je";
        var policy = new IntegrationRequestLedgerTests.Policy();
        foreach (var (viewer, role) in new[] { (rig.Admin, "Admin"), (rig.Kid, "Kid"), (rig.Emma, "Member") })
            policy.People[viewer.UserId] = new(viewer.UserId, role, true, role == "Admin", role == "Admin", true, "p1", "je", "inst", "g1", 7, 7, 0, "{}");
        var ledger = new RequestLedger(rig.Db);
        var requests = new RequestService(ledger, policy, rig.View, rig.Feed, () => rig.Arr.Now) { Numbering = (_, _, _) => Task.FromResult((true, true)) };
        using var service = new NotificationService(rig.NotifyStore, rig.Status, rig.Requests, rig.View, rig.Feed, rig.Store, rig.Users, rig.Dispatcher, null, null, () => rig.Config, () => rig.Arr.Now, rig.Hub, rig.Bridge, ledger);
        rig.Users.Names[rig.Emma.UserId] = "Emma";
        var outbox = new RequestOutbox(ledger, policy, new Unmatched(), new RequestTitleLocks(), rig.Feed, new ArrAuditLog(Path.Combine(rig.Arr.Plugin.Core.Root, "f83-audit-" + Guid.NewGuid().ToString("N") + ".jsonl"), 100000, 1), () => rig.Arr.Now);
        var ask = await requests.CreateAsync(rig.Emma.UserId, new("emma-sev", new MutationInput { Key = "tv:tvdb:371980", Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } }), default);
        Assert.True(ask.HttpStatus < 300, ask.Reason);
        await service.DeliverRequestNoticesAsync(rig.Arr.Now, default);
        await outbox.TickAsync(default);
        Assert.Equal(("pending", EpisodeIdentity.Unresolved), (ledger.Find(ask.RequestId!)!.Status, ledger.Find(ask.RequestId!)!.Reason));
        Assert.Equal(1, await service.DeliverRequestNoticesAsync(rig.Arr.Now, default));
        var told = Assert.Single(rig.Inbox(rig.Admin), n => n.Kind == "attention");
        Assert.Equal("tv:tvdb:371980", told.Key);
        Assert.Contains("\"code\":\"" + EpisodeIdentity.Unresolved + "\"", told.Payload, StringComparison.Ordinal);
        Assert.Contains("\"user\":\"Emma\"", told.Payload, StringComparison.Ordinal);
        Assert.Empty(rig.Inbox(rig.Emma));
        Assert.Empty(rig.Inbox(rig.Kid));
        // Told once.
        Assert.Equal(0, await service.DeliverRequestNoticesAsync(rig.Arr.Now, default));
        Assert.Single(rig.Inbox(rig.Admin), n => n.Kind == "attention");
        // The words: held, why, and that it wasn't searched for.
        var payload = JsonSerializer.Deserialize<Dictionary<string, string>>(told.Payload)!;
        var words = Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify.NotifyTexts.Render("attention", payload, false);
        Assert.Contains("can't be matched to Sonarr's episodes", words.Title, StringComparison.Ordinal);
        Assert.Contains("it wasn't searched for", words.Body, StringComparison.Ordinal);
    }

    // ------------------------------------------------------------------ review round 1 (EI-1 … EI-6)

    [Fact]
    public async Task EI1_ARetryAfterAFailedSearchMatchesByIdAgainEvenWhenSonarrRenumberedMeanwhile()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab();
        ExistingFirefly(lab);
        var (r, _) = Ledger(lab);
        using var rig = r;
        var ask = await rig.Create(rig.Admin, new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } });
        var runner = rig.Runner(Direct(lab, Tmdb(new() { [(1, 1)] = 297990 })));
        lab.Sonarr.CommandFailWith = 429;
        await runner.TickAsync(default);
        // Not confirmed: the request keeps TMDB's numbering (only a confirmed send switches it).
        Assert.Equal(EpisodeIdentity.Tmdb, rig.Ledger.Find(ask.RequestId!)!.Input.Numbering);
        lab.Sonarr.CommandFailWith = 0;
        // Sonarr swaps E2 and E3 before the retry: the TVDB id still names episode 4002.
        lab.Sonarr.Episodes.Single(e => (int)e["id"]! == 4002)["episodeNumber"] = 3;
        lab.Sonarr.Episodes.Single(e => (int)e["id"]! == 4003)["episodeNumber"] = 2;
        lab.Sonarr.Writes.Clear();
        rig.Now = rig.Now.AddMinutes(10);
        await runner.TickAsync(default);
        Assert.Equal("4002", Search(lab.Sonarr));
        var want = rig.Ledger.Find(ask.RequestId!)!;
        Assert.Equal(("sent", null), (want.Status, want.Input.Numbering));
        Assert.Equal(new[] { new RequestEpisode(1, 3) }, want.Input.Episodes);
    }

    [Fact]
    public async Task EI2_AskersSharingSomeEpisodesSwitchToSonarrsNumbersTogetherOnceEveryEpisodeIsMatched()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab();
        ExistingFirefly(lab);
        var (r, _) = Ledger(lab);
        using var rig = r;
        var one = new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        var first = await rig.Create(rig.Admin, one);
        rig.Now = rig.Now.AddSeconds(1);
        var second = await rig.Create(rig.Add("Admin"), one with { Episodes = new[] { new RequestEpisode(1, 1), new RequestEpisode(1, 3) } });
        Assert.True(second.HttpStatus < 300, second.Reason);
        await rig.Runner(Direct(lab, Tmdb(new() { [(1, 1)] = 297990, [(1, 3)] = 297991 }))).TickAsync(default);
        var a = rig.Ledger.Find(first.RequestId!)!;
        var b = rig.Ledger.Find(second.RequestId!)!;
        Assert.Equal(("sent", null, "sent", null), (a.Status, a.Input.Numbering, b.Status, b.Input.Numbering));
        Assert.Equal(new[] { new RequestEpisode(1, 2) }, a.Input.Episodes);
        Assert.Equal(new[] { new RequestEpisode(1, 2), new RequestEpisode(1, 3) }, b.Input.Episodes);
        // Every job (sent or not) holds the same numbering as its ask.
        Assert.All(new[] { a, b }.SelectMany(w => rig.Ledger.ForWant(w.Id)), j => Assert.Null(j.Input.Numbering));
        Assert.All(rig.Ledger.Dispatches("tv:tvdb:" + Tvdb), d => Assert.Null(d.Input.Numbering));
    }

    [Fact]
    public async Task EI3_ASonarrSeasonAskNeverCoversATmdbEpisodeThatSonarrNumbersInAnotherSeason()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab();
        ExistingFirefly(lab);
        var (r, _) = Ledger(lab);
        using var rig = r;
        await rig.Create(rig.Admin, new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "seasons", Seasons = new[] { 0 } });
        rig.Service.Numbering = (_, _, _) => Task.FromResult((true, true));
        rig.Now = rig.Now.AddSeconds(1);
        await rig.Create(rig.Add("Admin"), new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(0, 12) } });
        await rig.Runner(Direct(lab, Tmdb(new() { [(0, 12)] = 297999 }))).TickAsync(default);
        // TMDB's S00E12 is Sonarr's S01E12: it went out by id although Sonarr's season 0 was asked for too.
        Assert.True((bool)lab.Sonarr.Episodes.Single(e => (int)e["id"]! == 4012)["monitored"]!);
    }

    [Fact]
    public async Task EI4_AHeldTmdbNumberedAskIsNeverFulfilledByAnEpisodeWithTheSameNumber()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        lab.Requests.Numbering = (_, _, _) => Task.FromResult((true, true));
        var id = await lab.Ask(lab.Admin, new MutationInput { Key = "tv:tvdb:78874", Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } });
        var runner = new RequestOutbox(lab.Ledger, lab.Policy, new Unmatched(), new RequestTitleLocks(), lab.Feed,
            new ArrAuditLog(Path.Combine(lab.Arr.Plugin.Core.Root, "ei4-audit-" + Guid.NewGuid().ToString("N") + ".jsonl"), 100000, 1), () => lab.Arr.Now);
        await runner.TickAsync(default);
        Assert.Equal(EpisodeIdentity.Unresolved, lab.Ledger.Find(id)!.Reason);
        foreach (var instance in lab.Store.Registry.All()) await lab.Store.GetLibraryAsync(instance, default);
        await lab.Fulfilment.CheckAsync(null, default);
        // Sonarr's and Jellyfin's S01E01 (another episode) is here: the held ask stays held.
        Assert.Equal(("pending", EpisodeIdentity.Unresolved), (lab.Ledger.Find(id)!.Status, lab.Ledger.Find(id)!.Reason));
    }

    [Fact]
    public async Task EI5_TheAskerSeesAnIdentityHoldAsHeldNotAsWaitingForAnOk()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        lab.Sonarr.Episodes.Single(e => (int)e["id"]! == 3104)["monitored"] = false;
        lab.Requests.Numbering = (_, _, _) => Task.FromResult((true, true));
        var id = await lab.Ask(lab.Emma, new MutationInput { Key = "tv:tvdb:78874", Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 4) } });
        var runner = new RequestOutbox(lab.Ledger, lab.Policy, new Unmatched(), new RequestTitleLocks(), lab.Feed,
            new ArrAuditLog(Path.Combine(lab.Arr.Plugin.Core.Root, "ei5-audit-" + Guid.NewGuid().ToString("N") + ".jsonl"), 100000, 1), () => lab.Arr.Now);
        await runner.TickAsync(default);
        Assert.Equal(EpisodeIdentity.Unresolved, lab.Ledger.Find(id)!.Reason);
        foreach (var instance in lab.Store.Registry.All()) await lab.Store.GetLibraryAsync(instance, default);
        var reason = (await lab.Page(lab.Emma))["tv:tvdb:78874"].GetProperty("status").GetProperty("reason");
        Assert.Equal("awaiting_approval", reason.GetProperty("code").GetString());
        // A neutral flag only: held, and the administrators were told (never why).
        Assert.Equal("told", reason.GetProperty("params").GetProperty("held").GetString());
    }

    [Fact]
    public async Task EI6_TmdbThatCantBeReadIsWaitedForBoundedlyAndAMissingKeyHoldsAtOnce()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab();
        ExistingFirefly(lab);
        var unread = Direct(lab, (_, _, _, _) => Task.FromResult(EpisodeExternalId.Unread));
        var job = lab.Job(Ask((1, 1)), "Sonarr");
        var first = await unread.SendAsync(job, () => null, default);
        Assert.Equal((EpisodeIdentity.Pending, false, true), (first.Outcome.Reason, first.Parked, first.Retryable));
        // Once waited (or after many attempts whatever the last reason was): held, nothing written.
        var again = await unread.SendAsync(job with { Reason = first.Outcome.Reason, Attempts = 2 }, () => null, default);
        Assert.Equal((EpisodeIdentity.Unresolved, true, false), (again.Outcome.Reason, again.Parked, again.Retryable));
        var late = await unread.SendAsync(job with { Attempts = 100, Reason = "backend_unavailable" }, () => null, default);
        Assert.True(late.Parked && !late.Retryable);
        // No TMDB key (or one TMDB refuses): asking again won't help.
        var unusable = await Direct(lab, (_, _, _, _) => Task.FromResult(EpisodeExternalId.Unusable)).SendAsync(job, () => null, default);
        Assert.Equal((EpisodeIdentity.Unresolved, true), (unusable.Outcome.Reason, unusable.Parked));
        Assert.Empty(lab.Sonarr.Writes);
    }

    [Fact]
    public async Task AnAdministratorResumesAnIdentityHoldOnceSonarrListsTheEpisode()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab();
        ExistingFirefly(lab, withTvdbIds: false);
        var (r, _) = Ledger(lab);
        using var rig = r;
        var ask = await rig.Create(rig.Admin, new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } });
        var runner = rig.Runner(Direct(lab, Tmdb(new() { [(1, 1)] = 297990 })));
        await runner.TickAsync(default);
        rig.Now = rig.Now.AddMinutes(3);
        await runner.TickAsync(default);
        Assert.Equal(EpisodeIdentity.Unresolved, rig.Ledger.Find(ask.RequestId!)!.Reason);
        lab.Sonarr.Episodes.Single(e => (int)e["id"]! == 4002)["tvdbId"] = 297990;
        var approved = await rig.Service.ApproveAsync(ask.RequestId!, rig.Admin, new ApproveRequest(), default);
        Assert.True(approved.HttpStatus < 300, approved.Reason);
        lab.Sonarr.Writes.Clear();
        await runner.TickAsync(default);
        Assert.Equal(("sent", null), (rig.Ledger.Find(ask.RequestId!)!.Status, rig.Ledger.Find(ask.RequestId!)!.Input.Numbering));
        Assert.Equal("4002", Search(lab.Sonarr));
    }

    // ------------------------------------------------------------------ review round 2 (EI-R2-1 … EI-R2-6)

    private static long TableCount(AcquireDatabase db, string table) => db.Read(c =>
    {
        using var cmd = c.CreateCommand(); cmd.CommandText = "SELECT COUNT(*) FROM " + table;
        return (long)cmd.ExecuteScalar()!;
    });

    [Fact]
    public async Task EIR2_UnapprovedUnmatchableSharerMustNotStrandAConfirmedEpisode()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(); ExistingFirefly(lab);
        var (r, _) = Ledger(lab); using var rig = r;
        var one = new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        var first = await rig.Create(rig.Admin, one);
        rig.Now = rig.Now.AddSeconds(1);
        var second = await rig.Create(rig.Kid, one with { Episodes = new[] { new RequestEpisode(1, 1), new RequestEpisode(1, 3) } });
        Assert.Equal("pending", rig.Ledger.Find(second.RequestId!)!.Status);
        await rig.Runner(Direct(lab, Tmdb(new() { [(1, 1)] = 297990, [(1, 3)] = null }))).TickAsync(default);
        for (var i = 0; i < 3; i++) rig.Ledger.SettleIdentity(rig.Ledger.Find(first.RequestId!)!, rig.Now.AddMinutes(i * 10));
        var a = rig.Ledger.Find(first.RequestId!)!;
        Assert.Equal("sent", a.Status);
        Assert.True(a.Input.Numbering == null, $"Confirmed ask stuck: numbering={a.Input.Numbering}; sharer={rig.Ledger.Find(second.RequestId!)!.Reason}");
    }

    [Fact]
    public async Task EIR2_AnIdentityHeldSharerDoesReleaseTheMatchedEpisode()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(); ExistingFirefly(lab);
        var (r, _) = Ledger(lab); using var rig = r;
        var one = new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        var first = await rig.Create(rig.Admin, one); rig.Now = rig.Now.AddSeconds(1);
        var second = await rig.Create(rig.Add("Admin"), one with { Episodes = new[] { new RequestEpisode(1, 1), new RequestEpisode(1, 3) } });
        await rig.Runner(Direct(lab, Tmdb(new() { [(1, 1)] = 297990, [(1, 3)] = null }))).TickAsync(default);
        Assert.Equal(EpisodeIdentity.Unresolved, rig.Ledger.Find(second.RequestId!)!.Reason);
        Assert.Null(rig.Ledger.Find(first.RequestId!)!.Input.Numbering);
    }

    [Fact]
    public async Task EIR2_AGroupMustNotSwitchUsingCoordinatesFromBeforeSonarrRenumbered()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(); ExistingFirefly(lab);
        var (r, _) = Ledger(lab); using var rig = r;
        var one = new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        var first = await rig.Create(rig.Admin, one); rig.Now = rig.Now.AddSeconds(1);
        var second = await rig.Create(rig.Add("Admin"), one with { Episodes = new[] { new RequestEpisode(1, 1), new RequestEpisode(1, 3) } });
        var available = false;
        var reader = Tmdb(new() { [(1, 1)] = 297990, [(1, 3)] = 297991 });
        var direct = Direct(lab, (series, season, episode, ct) => episode == 3 && !available ? Task.FromResult(EpisodeExternalId.Unread) : reader(series, season, episode, ct));
        var runner = rig.Runner(direct); await runner.TickAsync(default);
        // Per request: A's own match is confirmed, so A switches at once (B waits for its own E3, and blocks nobody).
        Assert.Equal(new[] { new RequestEpisode(1, 2) }, rig.Ledger.Find(first.RequestId!)!.Input.Episodes);
        Assert.Equal(EpisodeIdentity.Tmdb, rig.Ledger.Find(second.RequestId!)!.Input.Numbering);
        Assert.Equal(1, TableCount(rig.Db, "episode_identities"));
        lab.Sonarr.Episodes.Single(e => (int)e["id"]! == 4002)["episodeNumber"] = 3;
        lab.Sonarr.Episodes.Single(e => (int)e["id"]! == 4003)["episodeNumber"] = 2;
        available = true; rig.Now = rig.Now.AddMinutes(3); await runner.TickAsync(default);
        Assert.Null(rig.Ledger.Find(first.RequestId!)!.Input.Numbering);
        Assert.Equal(new[] { new RequestEpisode(1, 3) }, rig.Ledger.Find(first.RequestId!)!.Input.Episodes);
        Assert.Equal(new[] { new RequestEpisode(1, 2), new RequestEpisode(1, 3) }, rig.Ledger.Find(second.RequestId!)!.Input.Episodes);
    }

    [Fact]
    public async Task EIR2_IdentityMappingsSurviveAcquisitionMerge()
    {
        using var rig = new IntegrationRequestLedgerTests.Rig();
        rig.Service.Numbering = (_, _, _) => Task.FromResult((true, true));
        var a = await rig.Create(rig.Admin, new MutationInput { Key = "tv:tmdb:1437", Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } });
        var b = await rig.Create(rig.Add("Admin"), new MutationInput { Key = "tv:tvdb:78874", Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 3) } });
        var donor = rig.Ledger.Find(a.RequestId!)!.AcquisitionId;
        rig.Db.Write((c, t) => RequestLedger.Exec(c, t, "INSERT INTO episode_identities(acquisition_id,target_key,season,episode,to_season,to_episode,tvdb_id,learned_at) VALUES($a,$t,1,1,1,2,297990,0)", ("$a", donor), ("$t", rig.Ledger.Find(a.RequestId!)!.TargetKey)));
        Assert.Equal(1, TableCount(rig.Db, "episode_identities"));
        Assert.NotNull(rig.Ledger.Unify(new[] { "tv:tmdb:1437", "tv:tvdb:78874" }, rig.Policy, rig.Now));
        Assert.Equal(rig.Ledger.Find(a.RequestId!)!.AcquisitionId, rig.Ledger.Find(b.RequestId!)!.AcquisitionId);
        Assert.Equal(1, TableCount(rig.Db, "episode_identities"));
    }

    [Fact]
    public async Task EIR2_RetentionPrunesOldIdentityMappings()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(); ExistingFirefly(lab);
        var (r, _) = Ledger(lab); using var rig = r;
        var ask = await rig.Create(rig.Admin, new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } });
        await rig.Runner(Direct(lab, Tmdb(new() { [(1, 1)] = 297990 }))).TickAsync(default);
        Assert.True(rig.Ledger.Fulfil(ask.RequestId!, rig.Now));
        rig.Ledger.Retain(rig.Now.AddYears(2), 30);
        Assert.Equal(0, TableCount(rig.Db, "wants"));
        Assert.Equal(0, TableCount(rig.Db, "episode_identities"));
    }

    [Fact]
    public async Task EIR2_IdentityMappingsSurviveRestartAndTwoDatabaseInstances()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(); ExistingFirefly(lab);
        var (r, _) = Ledger(lab); using var rig = r;
        var ask = await rig.Create(rig.Admin, new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } });
        await rig.Runner(Direct(lab, Tmdb(new() { [(1, 1)] = 297990 }))).TickAsync(default);
        rig.Reopen();
        Assert.Equal(1, TableCount(rig.Db, "episode_identities"));
        using var other = new AcquireDatabase(Path.Combine(rig.Root, "acquire.db"));
        using var another = new AcquireDatabase(Path.Combine(rig.Root, "acquire.db"));
        var opened = await Task.WhenAll(Task.Run(() => other.Available), Task.Run(() => another.Available));
        Assert.All(opened, v => Assert.True(v));
        Assert.Equal(1, TableCount(other, "episode_identities"));
    }

    [Fact]
    public async Task EIR2_NoSentinelCoordinatesReachTheHubAndFulfilmentResumesAfterSwitch()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        lab.Requests.Numbering = (_, _, _) => Task.FromResult((true, true));
        var instance = lab.Store.Registry.All().Single(x => x.Kind == ArrKind.Sonarr);
        lab.Policy.Adjust = (_, _, facts) => facts with { InstanceId = instance.Id, ConnectionGeneration = lab.Arr.Factory.ConnectionGeneration(instance.Id) ?? string.Empty };
        lab.Sonarr.Episodes.Single(e => (int)e["id"]! == 3102)["tvdbId"] = 297990;
        var id = await lab.Ask(lab.Admin, new MutationInput { Key = "tv:tvdb:78874", Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } });
        foreach (var i in lab.Store.Registry.All()) await lab.Store.GetLibraryAsync(i, default);
        var unresolved = (await lab.Page(lab.Admin))["tv:tvdb:78874"].GetRawText();
        Assert.DoesNotMatch("\\\"(?:season|seasonNumber)\\\"\\s*:\\s*-", unresolved);
        var direct = new DirectArrBackend(lab.Arr.Factory, lab.Store, null, (_, _) => Task.CompletedTask, Tmdb(new() { [(1, 1)] = 297990 }));
        var runner = new RequestOutbox(lab.Ledger, lab.Policy, direct, new RequestTitleLocks(), lab.Feed, new ArrAuditLog(Path.Combine(lab.Arr.Plugin.Core.Root, "r2-audit-" + Guid.NewGuid().ToString("N") + ".jsonl"), 100000, 1), () => lab.Arr.Now);
        await runner.TickAsync(default);
        Assert.Null(lab.Ledger.Find(id)!.Input.Numbering);
        lab.View.AddEpisode(lab.SeriesItem, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 2, DateCreated = lab.Arr.Now.UtcDateTime });
        await lab.Fulfilment.CheckAsync(null, default);
        Assert.Equal("fulfilled", lab.Ledger.Find(id)!.Status);
    }

    [Fact]
    public async Task EIR2_SonarrSeasonCoversAnEpisodeAfterConfirmedSwitch()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(); ExistingFirefly(lab);
        var (r, _) = Ledger(lab); using var rig = r;
        var one = new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        var ask = await rig.Create(rig.Admin, one);
        await rig.Runner(Direct(lab, Tmdb(new() { [(1, 1)] = 297990 }))).TickAsync(default);
        var mapped = rig.Ledger.Find(ask.RequestId!)!.Input;
        var season = one with { Scope = "seasons", Episodes = Array.Empty<RequestEpisode>(), Seasons = new[] { 1 } };
        Assert.Null(mapped.Numbering);
        Assert.Null(mapped.Extra(new[] { season }));
        Assert.True(mapped.Overlaps(season));
        Assert.True(season.Covers(mapped.Episodes.Single()));
    }

    [Fact]
    public async Task EIR2_SettlingAJoinedRequestPublishesANewRevisionAndRequestEvent()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(); ExistingFirefly(lab);
        var (r, _) = Ledger(lab); using var rig = r;
        var one = new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        var first = await rig.Create(rig.Admin, one);
        await rig.Runner(Direct(lab, Tmdb(new() { [(1, 1)] = 297990 }))).TickAsync(default);
        Assert.Null(rig.Ledger.Find(first.RequestId!)!.Input.Numbering);
        // Asked for after A went out: A's sent episode covers it, so it has no send of its own to switch it.
        rig.Now = rig.Now.AddSeconds(1);
        var joined = await rig.Create(rig.Add("Admin"), one);
        Assert.True(joined.HttpStatus < 300, joined.Reason);
        Assert.Equal(EpisodeIdentity.Tmdb, rig.Ledger.Find(joined.RequestId!)!.Input.Numbering);
        var revision = rig.Ledger.Revision;
        var (cursor, _) = rig.Ledger.ChangedTitles(null);
        var changed = rig.Ledger.SettleIdentity(rig.Ledger.Find(joined.RequestId!)!, rig.Now);
        Assert.Single(changed);
        Assert.Equal(new[] { new RequestEpisode(1, 2) }, rig.Ledger.Find(joined.RequestId!)!.Input.Episodes);
        Assert.True(rig.Ledger.Revision > revision, "a switch without a ledger revision");
        Assert.Contains("tv:tvdb:" + Tvdb, rig.Ledger.ChangedTitles(cursor).Titles);
        // Nothing left to switch: no new revision.
        var settled = rig.Ledger.Revision;
        Assert.Empty(rig.Ledger.SettleIdentity(rig.Ledger.Find(joined.RequestId!)!, rig.Now));
        Assert.Equal(settled, rig.Ledger.Revision);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task EIR2_AnUnreadIdentityAtReadBackAlsoHasABoundedHold(bool permanent)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(); ExistingFirefly(lab);
        var direct = Direct(lab, (_, _, _, _) => Task.FromResult(permanent ? EpisodeExternalId.Unusable : EpisodeExternalId.Unread));
        var job = lab.Job(Ask((1, 1)), "Sonarr") with { Uncertain = true, Attempts = permanent ? 1 : 100 };
        var result = await direct.ReadBackAsync(job, default);
        Assert.True(result.Parked, $"Read-back at attempt {job.Attempts} never holds: reason={result.Outcome.Reason}, permanent={permanent}");
        Assert.Equal(EpisodeIdentity.Unresolved, result.Outcome.Reason);
        Assert.Equal(ArrActionStatus.Unknown, result.Outcome.Certainty);
    }

    [Fact]
    public async Task EIR2_IdentityMappingsAreIsolatedBetweenTwoSonarrTargets()
    {
        using var rig = new IntegrationRequestLedgerTests.Rig();
        rig.Service.Numbering = (_, _, _) => Task.FromResult((true, true));
        var input = new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        var first = await rig.Create(rig.Admin, input);
        var other = rig.Add("Admin");
        rig.Policy.People[other] = rig.Policy.People[other] with { InstanceId = "sonarr2" };
        var second = await rig.Create(other, input);
        var a = rig.Ledger.Find(first.RequestId!)!; var b = rig.Ledger.Find(second.RequestId!)!;
        Assert.Equal(a.AcquisitionId, b.AcquisitionId);
        Assert.NotEqual(a.TargetKey, b.TargetKey);
        rig.Db.Write((c, t) => RequestLedger.Exec(c, t, "INSERT INTO episode_identities(acquisition_id,target_key,season,episode,to_season,to_episode,tvdb_id,learned_at) VALUES($a,$ta,1,1,1,2,297990,0),($a,$tb,1,1,1,3,297991,0)", ("$a", a.AcquisitionId), ("$ta", a.TargetKey), ("$tb", b.TargetKey)));
        // Both went out (an open job would match by id itself when it goes out).
        rig.Db.Write((c, t) => RequestLedger.Exec(c, t, "UPDATE jobs SET state='succeeded' WHERE want_id IN ($x,$y)", ("$x", a.Id), ("$y", b.Id)));
        rig.Ledger.SettleIdentity(a, rig.Now); rig.Ledger.SettleIdentity(b, rig.Now);
        Assert.Equal(new[] { new RequestEpisode(1, 2) }, rig.Ledger.Find(a.Id)!.Input.Episodes);
        Assert.Equal(new[] { new RequestEpisode(1, 3) }, rig.Ledger.Find(b.Id)!.Input.Episodes);
    }

    [Fact]
    public async Task EIR2_AHistoricalMapMustNotRenumberANewUnconfirmedRetry()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(); ExistingFirefly(lab);
        var (r, _) = Ledger(lab); using var rig = r;
        var input = new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        var first = await rig.Create(rig.Admin, input);
        await rig.Runner(Direct(lab, Tmdb(new() { [(1, 1)] = 297990 }))).TickAsync(default);
        Assert.True(rig.Ledger.Fulfil(first.RequestId!, rig.Now));
        var second = await rig.Create(rig.Add("Admin"), input);
        await rig.Runner(Direct(lab, (_, _, _, _) => Task.FromResult(EpisodeExternalId.Unread))).TickAsync(default);
        var want = rig.Ledger.Find(second.RequestId!)!;
        Assert.Equal("queued", want.Status);
        Assert.Equal(EpisodeIdentity.Pending, want.Reason);
        Assert.Equal(EpisodeIdentity.Tmdb, want.Input.Numbering);
    }

    [Fact]
    public async Task EIR2_TheFifthClaimedAttemptHoldsInsteadOfWaitingAgain()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(); ExistingFirefly(lab);
        var (r, _) = Ledger(lab); using var rig = r;
        var ask = await rig.Create(rig.Admin, new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } });
        var runner = rig.Runner(Direct(lab, (_, _, _, _) => Task.FromResult(EpisodeExternalId.Unread)));
        // Four previous service failures, represented as the durable state the next outbox tick reads.
        rig.Db.Write((c, t) => RequestLedger.Exec(c, t, "UPDATE jobs SET attempts=4,reason='backend_unavailable' WHERE want_id=$w", ("$w", ask.RequestId!)));
        Assert.Equal(4, rig.Ledger.ForWant(ask.RequestId!).Single().Attempts);
        await runner.TickAsync(default);
        var job = rig.Ledger.ForWant(ask.RequestId!).Single();
        Assert.Equal(5, job.Attempts);
        Assert.True(job.State == "parked", $"Fifth actual attempt: state={job.State}, reason={job.Reason}");
        Assert.Equal(EpisodeIdentity.Unresolved, job.Reason);
    }


    // ------------------------------------------------------------------ review round 3 (EI-R3-1 … EI-R3-8)

    [Fact]
    public async Task EIR3_ClientFromCannotRewriteAnOrdinaryDestinationAsk()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(); ExistingFirefly(lab);
        var (r, _) = Ledger(lab); using var rig = r;
        var one = new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        await rig.Create(rig.Admin, one);
        var runner = rig.Runner(Direct(lab, Tmdb(new() { [(1, 1)] = 297990 })));
        await runner.TickAsync(default);
        rig.Service.Numbering = (_, _, _) => Task.FromResult((true, false));
        rig.Now = rig.Now.AddSeconds(1);
        var input = one with { Episodes = new[] { new RequestEpisode(1, 3) }, From = new[] { new RequestEpisode(1, 1) } };
        var ask = await rig.Create(rig.Member, input);
        Assert.True(ask.HttpStatus < 300, ask.Reason);
        lab.Sonarr.Writes.Clear();
        await runner.TickAsync(default);
        Assert.Equal("4003", Search(lab.Sonarr));
        // The caller asked and searched E3; a body property must never turn its durable request into E2.
        Assert.Equal(input.Episodes, rig.Ledger.Find(ask.RequestId!)!.Input.Episodes);
        Assert.Null(rig.Ledger.Find(ask.RequestId!)!.Input.From);
    }

    [Fact]
    public async Task EIR3_DroppedIdentityCannotKeepCoveringItsSourceEpisode()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(); ExistingFirefly(lab);
        var (r, _) = Ledger(lab); using var rig = r;
        var one = new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        var a = await rig.Create(rig.Admin, one);
        var runner = rig.Runner(Direct(lab, Tmdb(new() { [(1, 1)] = 297990, [(1, 3)] = 297991 })));
        await runner.TickAsync(default);
        // TVDB 297990 disappears. Another TVDB episode takes its old coordinates.
        lab.Sonarr.Episodes.Remove(lab.Sonarr.Episodes.Single(e => (int)e["id"]! == 4002));
        lab.Sonarr.Episodes.Single(e => (int)e["id"]! == 4003)["episodeNumber"] = 2;
        rig.Now = rig.Now.AddSeconds(1);
        await rig.Create(rig.Add("Admin"), one with { Episodes = new[] { new RequestEpisode(1, 3) } });
        await runner.TickAsync(default);
        Assert.Equal(1, TableCount(rig.Db, "episode_identities")); // only E3's live mapping remains
        var invalid = rig.Ledger.Find(a.RequestId!)!;
        var joined = await rig.Create(rig.Add("Member"), one);
        Assert.True(joined.HttpStatus < 300, joined.Reason);
        var follower = rig.Ledger.Find(joined.RequestId!)!;
        rig.Ledger.SettleIdentity(follower, rig.Now);
        // A's match is gone: its From coverage goes with it. A is back in TMDB's numbering with a fresh job to match it again,
        // its sent job no longer covers TMDB E1, and the new sharer waits for that job instead of counting as sent.
        Assert.Null(invalid.Input.From);
        Assert.Equal((EpisodeIdentity.Tmdb, "queued"), (invalid.Input.Numbering, invalid.Status));
        Assert.Contains(rig.Ledger.ForWant(invalid.Id), j => j.State == "queued");
        Assert.All(rig.Ledger.ForWant(invalid.Id).Where(j => j.State == "succeeded"), j => Assert.False(j.Input.Covers(new RequestEpisode(1, 1), EpisodeIdentity.Tmdb)));
        Assert.NotEqual("sent", rig.Ledger.Find(follower.Id)!.Status);
    }

    [Fact]
    public async Task EIR3_AnEmptySonarrEpisodeListIsUnreadNeverAConfirmationOrAnIdLoss()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(); ExistingFirefly(lab);
        var (r, _) = Ledger(lab); using var rig = r;
        var one = new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        var a = await rig.Create(rig.Admin, one);
        var direct = Direct(lab, Tmdb(new() { [(1, 1)] = 297990, [(1, 3)] = 297991 }));
        await rig.Runner(direct).TickAsync(default);
        Assert.Equal(new[] { new RequestEpisode(1, 2) }, rig.Ledger.Find(a.RequestId!)!.Input.Episodes);
        // Sonarr answers an empty episode list (or one whose ids aren't filled in yet): it vouches for nothing.
        lab.Sonarr.Episodes.Clear();
        rig.Now = rig.Now.AddSeconds(1);
        var next = await rig.Create(rig.Add("Admin"), one with { Episodes = new[] { new RequestEpisode(1, 3) } });
        var job = rig.Ledger.ForWant(next.RequestId!).Single();
        Assert.True(rig.Ledger.Claim(job, rig.Db.Generation, rig.Now));
        var read = await direct.ReadBackAsync(job with { Uncertain = true }, default);
        Assert.Null(read.Identity);
        Assert.False(read.Confirmed);
        Assert.True(rig.Ledger.Complete(job, rig.Db.Generation, read, rig.Now));
        // Kept matches untouched; the confirmed request keeps its episode; the new one is not switched.
        Assert.Equal(1, TableCount(rig.Db, "episode_identities"));
        Assert.Equal(new[] { new RequestEpisode(1, 2) }, rig.Ledger.Find(a.RequestId!)!.Input.Episodes);
        Assert.Equal(EpisodeIdentity.Tmdb, rig.Ledger.Find(next.RequestId!)!.Input.Numbering);
    }

    [Fact]
    public async Task EIR3_DroppingPreviewRowsDoesNotStrandAConfirmedPartialGroup()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(); ExistingFirefly(lab);
        var (r, _) = Ledger(lab); using var rig = r;
        var one = new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        var first = await rig.Create(rig.Admin, one); rig.Now = rig.Now.AddSeconds(1);
        var second = await rig.Create(rig.Add("Admin"), one with { Episodes = new[] { new RequestEpisode(1, 1), new RequestEpisode(1, 3) } });
        var available = false;
        var reader = Tmdb(new() { [(1, 1)] = 297990, [(1, 3)] = 297991 });
        var direct = Direct(lab, (series, season, episode, ct) => episode == 3 && !available ? Task.FromResult(EpisodeExternalId.Unread) : reader(series, season, episode, ct));
        await rig.Runner(direct).TickAsync(default);
        // Exact preview state before upgrade: A confirmed but still TMDB-numbered because B's E3 is pending;
        // A's succeeded job names TMDB E1 too. Its kept E1 match has no TVDB-id column.
        var old = one with { Numbering = EpisodeIdentity.Tmdb };
        rig.Db.Write((c, t) => {
            RequestLedger.Exec(c, t, "UPDATE wants SET mutation_input=$i,owned_input=$i,fingerprint=$f WHERE id=$w", ("$i", old.Canonical), ("$f", old.Fingerprint), ("$w", first.RequestId!));
            RequestLedger.Exec(c, t, "UPDATE jobs SET mutation_input=$i,fingerprint=$f WHERE want_id=$w", ("$i", old.Canonical), ("$f", old.Fingerprint), ("$w", first.RequestId!));
            RequestLedger.Exec(c, t, "ALTER TABLE episode_identities DROP COLUMN tvdb_id");
            return true;
        });
        rig.Reopen();
        Assert.Equal(0, TableCount(rig.Db, "episode_identities"));
        available = true; rig.Now = rig.Now.AddMinutes(3);
        await rig.Runner(direct).TickAsync(default);
        Assert.Equal("succeeded", rig.Ledger.ForWant(second.RequestId!).Single().State);
        for (var i = 0; i < 3; i++) rig.Ledger.SettleIdentity(rig.Ledger.Find(first.RequestId!)!, rig.Now.AddMinutes(i * 10));
        var stuck = rig.Ledger.Find(first.RequestId!)!;
        Assert.True(stuck.Input.Numbering == null || rig.Ledger.ForWant(stuck.Id).Any(j => j.State is "queued" or "retry" or "maybe_sent"), "Sent preview TMDB request lost its only match at startup and has no work to re-resolve it.");
    }

    [Fact]
    public async Task EIR3_AHeldSharerKeepsItsHoldWhileTheConfirmedSharerSwitches()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(); ExistingFirefly(lab);
        var (r, _) = Ledger(lab); using var rig = r;
        var one = new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        var first = await rig.Create(rig.Admin, one); rig.Now = rig.Now.AddSeconds(1);
        var second = await rig.Create(rig.Add("Admin"), one with { Episodes = new[] { new RequestEpisode(1, 1), new RequestEpisode(1, 3) } });
        await rig.Runner(Direct(lab, Tmdb(new() { [(1, 1)] = 297990, [(1, 3)] = null }))).TickAsync(default);
        for (var i = 0; i < 3; i++) rig.Ledger.SettleIdentity(rig.Ledger.Find(second.RequestId!)!, rig.Now.AddMinutes(i * 10));
        var a = rig.Ledger.Find(first.RequestId!)!; var b = rig.Ledger.Find(second.RequestId!)!;
        Assert.Equal(("sent", (string?)null), (a.Status, a.Input.Numbering));
        Assert.Equal(("pending", EpisodeIdentity.Unresolved, EpisodeIdentity.Tmdb), (b.Status, b.Reason, b.Input.Numbering));
        Assert.Equal("parked", rig.Ledger.ForWant(b.Id).Single().State);
        Assert.True(a.Input.Covers(new RequestEpisode(1, 1), EpisodeIdentity.Tmdb));
        var scope = LedgerRequestFacts.ScopeOf(new[] { a, b }, b.UserId, () => rig.Ledger.Dispatches(one.Key));
        Assert.Contains((1, 2), scope.Episodes!);
        Assert.Contains((-2, 1), scope.Episodes!);
        Assert.Contains((-2, 3), scope.Episodes!);
    }

    [Fact]
    public async Task EIR3_ASweepThatSwitchesAJoinedRequestFulfilsItInTheSamePass()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        lab.Requests.Numbering = (_, _, _) => Task.FromResult((true, true));
        var instance = lab.Store.Registry.All().Single(x => x.Kind == ArrKind.Sonarr);
        lab.Policy.Adjust = (_, _, facts) => facts with { InstanceId = instance.Id, ConnectionGeneration = lab.Arr.Factory.ConnectionGeneration(instance.Id) ?? string.Empty };
        lab.Sonarr.Episodes.Single(e => (int)e["id"]! == 3102)["tvdbId"] = 297990;
        var one = new MutationInput { Key = "tv:tvdb:78874", Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        var a = await lab.Ask(lab.Admin, one);
        foreach (var i in lab.Store.Registry.All()) await lab.Store.GetLibraryAsync(i, default);
        var direct = new DirectArrBackend(lab.Arr.Factory, lab.Store, null, (_, _) => Task.CompletedTask, Tmdb(new() { [(1, 1)] = 297990 }));
        var runner = new RequestOutbox(lab.Ledger, lab.Policy, direct, new RequestTitleLocks(), lab.Feed, new ArrAuditLog(Path.Combine(lab.Arr.Plugin.Core.Root, "r3-audit-" + Guid.NewGuid().ToString("N") + ".jsonl"), 100000, 1), () => lab.Arr.Now);
        await runner.TickAsync(default);
        var b = await lab.Ask(lab.Emma, one);
        Assert.Equal(EpisodeIdentity.Tmdb, lab.Ledger.Find(b)!.Input.Numbering);
        lab.View.AddEpisode(lab.SeriesItem, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 2, DateCreated = lab.Arr.Now.UtcDateTime });
        await lab.Fulfilment.CheckAsync(null, default);
        Assert.Equal("fulfilled", lab.Ledger.Find(a)!.Status);
        Assert.Null(lab.Ledger.Find(b)!.Input.Numbering);
        Assert.Equal("fulfilled", lab.Ledger.Find(b)!.Status);
    }

    [Fact]
    public async Task EIR3_AHeldRequestCannotBecomeSentButPermanentlyUnplacedWhenItsSharerSucceeds()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(); ExistingFirefly(lab);
        var (r, _) = Ledger(lab); using var rig = r;
        var one = new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        var held = await rig.Create(rig.Member, one);
        await rig.Runner(Direct(lab, (_, _, _, _) => Task.FromResult(EpisodeExternalId.Unusable))).TickAsync(default);
        Assert.Equal(("pending", EpisodeIdentity.Unresolved), (rig.Ledger.Find(held.RequestId!)!.Status, rig.Ledger.Find(held.RequestId!)!.Reason));
        rig.Now = rig.Now.AddSeconds(1);
        var successful = await rig.Create(rig.Add("Member"), one);
        await rig.Runner(Direct(lab, Tmdb(new() { [(1, 1)] = 297990 }))).TickAsync(default);
        Assert.Null(rig.Ledger.Find(successful.RequestId!)!.Input.Numbering);
        // EI-R4-1: switched with the request that sent it, its never-sent held job is cancelled (charge given back), never sent.
        Assert.Equal("cancelled", rig.Ledger.ForWant(held.RequestId!).Single().State);
        for (var i = 0; i < 3; i++) rig.Ledger.SettleIdentity(rig.Ledger.Find(held.RequestId!)!, rig.Now.AddMinutes(i * 10));
        var b = rig.Ledger.Find(held.RequestId!)!;
        var facts = LedgerRequestFacts.FactsOf(new[] { b }, b.UserId, () => rig.Ledger.Dispatches(one.Key))!;
        var attention = rig.Ledger.List(rig.Admin, true).Any(w => w.Id == b.Id);
        Assert.True(b.Input.Numbering == null || (b.Status == "pending" && b.Reason == EpisodeIdentity.Unresolved), $"Held job cannot switch; UI says {b.Status}/{b.Reason}; numbering={b.Input.Numbering}; pending={facts.Pending}; held={facts.HeldReason}; attention={attention}");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task EIR3_AliasMergeCollapsesSameIdsAndDropsBothDisagreeingIds(bool disagree)
    {
        using var rig = new IntegrationRequestLedgerTests.Rig();
        rig.Service.Numbering = (_, _, _) => Task.FromResult((true, true));
        var one = new MutationInput { Key = "tv:tmdb:1437", Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        var a = await rig.Create(rig.Admin, one);
        var b = await rig.Create(rig.Add("Admin"), one with { Key = "tv:tvdb:78874" });
        var wa = rig.Ledger.Find(a.RequestId!)!; var wb = rig.Ledger.Find(b.RequestId!)!;
        rig.Db.Write((c, t) => RequestLedger.Exec(c, t,
            "INSERT INTO episode_identities(acquisition_id,target_key,season,episode,to_season,to_episode,tvdb_id,learned_at) VALUES($a,$ta,1,1,1,2,297990,0),($b,$tb,1,1,1,3,$id,0)",
            ("$a", wa.AcquisitionId), ("$ta", wa.TargetKey), ("$b", wb.AcquisitionId), ("$tb", wb.TargetKey), ("$id", disagree ? 297991 : 297990)));
        Assert.NotNull(rig.Ledger.Unify(new[] { "tv:tmdb:1437", "tv:tvdb:78874" }, rig.Policy, rig.Now));
        Assert.Equal(disagree ? 0 : 1, TableCount(rig.Db, "episode_identities"));
    }

    [Fact]
    public async Task EIR3_ARepeatedWaitStillRechecksTheSnapshotItRead()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(); ExistingFirefly(lab);
        var (r, _) = Ledger(lab); using var rig = r;
        var one = new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        var first = await rig.Create(rig.Admin, one);
        var direct = Direct(lab, Tmdb(new() { [(1, 1)] = 297990, [(1, 3)] = 297991 }));
        await rig.Runner(direct).TickAsync(default);
        rig.Now = rig.Now.AddSeconds(1);
        var second = await rig.Create(rig.Add("Admin"), one with { Episodes = new[] { new RequestEpisode(1, 3) } });
        lab.Sonarr.Episodes.Single(e => (int)e["id"]! == 4002)["episodeNumber"] = 3;
        lab.Sonarr.Episodes.Single(e => (int)e["id"]! == 4003)["episodeNumber"] = 2;
        rig.Db.Write((c, t) => RequestLedger.Exec(c, t, "UPDATE jobs SET state='retry',reason='budget_exhausted' WHERE want_id=$w", ("$w", second.RequestId!)));
        var job = rig.Ledger.ForWant(second.RequestId!).Single();
        Assert.True(rig.Ledger.Claim(job, rig.Db.Generation, rig.Now));
        int Reads() => lab.Arr.Calls.Count(c => c.Contains("/api/v3/episode?", StringComparison.Ordinal));
        var before = Reads();
        // Budget becomes unavailable only after the series episode list was read, at the last write gate.
        var result = await direct.SendAsync(job, () => Reads() > before ? "budget_exhausted" : null, default);
        Assert.Equal("budget_exhausted", result.Outcome.Reason);
        Assert.NotNull(result.Identity);
        Assert.Equal(new RequestEpisode(1, 3), result.Identity![297990]);
        Assert.True(RequestLedger.RepeatsWait(job, result));
        Assert.True(rig.Ledger.Complete(job, rig.Db.Generation, result, rig.Now));
        Assert.Equal(new[] { new RequestEpisode(1, 3) }, rig.Ledger.Find(first.RequestId!)!.Input.Episodes);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task EIR3_TheFifthReadBackClaimHoldsAnIdentityThatCannotMatch(bool sonarrMissing)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(); ExistingFirefly(lab, withTvdbIds: !sonarrMissing);
        var (r, _) = Ledger(lab); using var rig = r;
        var one = new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        var ask = await rig.Create(rig.Admin, one);
        var outcome = JsonSerializer.Serialize(RequestBackendResult.Uncertain(ask.RequestId!).Outcome);
        rig.Db.Write((c, t) => RequestLedger.Exec(c, t, "UPDATE jobs SET state='maybe_sent',attempts=4,reason='maybe_sent',outcome=$o WHERE want_id=$w", ("$o", outcome), ("$w", ask.RequestId!)));
        var direct = Direct(lab, Tmdb(new() { [(1, 1)] = sonarrMissing ? 297990 : null }));
        await rig.Runner(direct).TickAsync(default);
        var job = rig.Ledger.ForWant(ask.RequestId!).Single();
        Assert.Equal(5, job.Attempts);
        Assert.True(job.State == "parked" && job.Reason == EpisodeIdentity.Unresolved && job.Uncertain, $"Fifth read-back: {job.State}/{job.Reason}, uncertain={job.Uncertain}, Sonarr missing={sonarrMissing}");
        Assert.Empty(lab.Sonarr.Writes);
    }


    // ------------------------------------------------------------------ review round 4 (EI-R4-1 … EI-R4-5)


    [Fact]
    public async Task EIR4_LosingSharedEpisodeMustNotSendUnchangedOwnedEpisodeTwice()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(); ExistingFirefly(lab);
        var (r, _) = Ledger(lab); using var rig = r;
        var one = new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        var a = await rig.Create(rig.Admin, one);
        rig.Now = rig.Now.AddSeconds(1);
        var b = await rig.Create(rig.Member, one with { Episodes = new[] { new RequestEpisode(1, 1), new RequestEpisode(1, 3) } });
        var runner = rig.Runner(Direct(lab, Tmdb(new() { [(1, 1)] = 297990, [(1, 3)] = 297991, [(1, 12)] = 297999 })));
        await runner.TickAsync(default);
        Assert.Equal("sent", rig.Ledger.Find(b.RequestId!)!.Status);
        Assert.Single(rig.Ledger.ForWant(b.RequestId!));
        Assert.Equal(new[] { new RequestEpisode(1, 3) }, rig.Ledger.Find(b.RequestId!)!.OwnedInput!.From);
        lab.Sonarr.Episodes.Remove(lab.Sonarr.Episodes.Single(e => (int)e["id"]! == 4002));
        rig.Now = rig.Now.AddSeconds(1);
        await rig.Create(rig.Add("Admin"), one with { Episodes = new[] { new RequestEpisode(1, 12) } });
        await runner.TickAsync(default);
        Assert.Equal(EpisodeIdentity.Tmdb, rig.Ledger.Find(b.RequestId!)!.Input.Numbering);
        lab.Sonarr.Writes.Clear();
        rig.Now = rig.Now.AddMinutes(3);
        await runner.TickAsync(default);
        var searches = lab.Sonarr.Writes.Where(w => w.Path == "/api/v3/command" && w.Body.Contains("EpisodeSearch", StringComparison.Ordinal)).Select(w => w.Body).ToArray();
        Assert.DoesNotContain(searches, s => Ids(JsonNode.Parse(s)!["episodeIds"]).Contains(4003));
    }

    [Fact]
    public async Task EIR4_ReleasedUnknownHoldKeepsItsSingleReservationAndCanFinish()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(); ExistingFirefly(lab);
        var (r, _) = Ledger(lab); using var rig = r;
        var one = new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        var ask = await rig.Create(rig.Member, one);
        var job = rig.Ledger.ForWant(ask.RequestId!).Single();
        Assert.True(rig.Ledger.Claim(job, rig.Db.Generation, rig.Now));
        Assert.True(rig.Ledger.Complete(job, rig.Db.Generation, BackendResults.HoldAfterWrite(job.WantId, EpisodeIdentity.Unresolved, "Held"), rig.Now));
        var before = rig.Db.Read(c => { using var cmd = RequestLedger.Cmd(c, null, "SELECT id||':'||state||':'||cost||':'||job_id FROM reservations WHERE want_id=$w", ("$w", ask.RequestId!)); return (string)cmd.ExecuteScalar()!; });
        var approved = await rig.Service.ApproveAsync(ask.RequestId!, rig.Admin, null, default);
        Assert.True(approved.HttpStatus < 300, approved.Reason);
        await rig.Runner(Direct(lab, Tmdb(new() { [(1, 1)] = 297990 }))).TickAsync(default);
        rig.Now = rig.Now.AddMinutes(3);
        await rig.Runner(Direct(lab, Tmdb(new() { [(1, 1)] = 297990 }))).TickAsync(default);
        Assert.Equal("sent", rig.Ledger.Find(ask.RequestId!)!.Status);
        Assert.Single(rig.Ledger.ForWant(ask.RequestId!));
        var after = rig.Db.Read(c => { using var cmd = RequestLedger.Cmd(c, null, "SELECT id||':'||state||':'||cost||':'||job_id FROM reservations WHERE want_id=$w", ("$w", ask.RequestId!)); return (string)cmd.ExecuteScalar()!; });
        Assert.Equal(before, after);
        Assert.Equal(1, TableCount(rig.Db, "reservations"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task EIR4_MalformedApprovalIsRejectedBeforeComparingProvenance(bool nullElement)
    {
        using var rig = new IntegrationRequestLedgerTests.Rig();
        var input = new MutationInput { Key = "tv:tvdb:78874", Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 2) } };
        var asked = await rig.Create(rig.Kid, input);
        var stored = rig.Ledger.Find(asked.RequestId!)!.Input with { From = new[] { new RequestEpisode(1, 1) } };
        rig.Db.Write((c,t) => RequestLedger.Exec(c,t,"UPDATE wants SET mutation_input=$i WHERE id=$w",("$i",stored.Canonical),("$w",asked.RequestId!)));
        var broken = input with { Episodes = nullElement ? new RequestEpisode[] { null! } : null! };
        var result = await rig.Controller(rig.Admin).Approve(asked.RequestId!, new ApproveRequest(broken), default);
        var approved = Assert.IsType<RequestOutcome>(Assert.IsType<Microsoft.AspNetCore.Mvc.ObjectResult>(result).Value);
        Assert.Equal((400, "invalid_input"), (approved.HttpStatus, approved.Reason));
    }

    [Fact]
    public async Task EIR4_PreviewAndBatchIgnoreCallerProvenance()
    {
        using var rig = new IntegrationRequestLedgerTests.Rig();
        var normal = new MutationInput { Key = "tv:tvdb:78874", Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 3) } };
        var forged = normal with { From = new[] { new RequestEpisode(-100, -100) }, Numbering = "bogus" };
        var baseline = await rig.Service.PreviewAsync(rig.Member, new CreateRequest("normal", normal), default);
        var preview = await rig.Service.PreviewAsync(rig.Member, new CreateRequest("forged", forged), default);
        Assert.Equal(baseline.Outcome.Reason, preview.Outcome.Reason);
        var batch = await rig.Service.PreviewBatchAsync(rig.Member, new CreateRequest?[] { new("normal", normal), new("forged", forged) }, default);
        Assert.Equal(batch[0].Outcome.Reason, batch[1].Outcome.Reason);
        Assert.Equal(0, TableCount(rig.Db, "wants"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task EIR4_StartupManyPreviewRowsIsIdempotent(bool switched)
    {
        using var rig = new IntegrationRequestLedgerTests.Rig();
        rig.Service.Numbering = (_,_,_) => Task.FromResult((true,true));
        for (var i = 0; i < 125; i++)
        {
            var input = new MutationInput { Key = "tv:tvdb:" + (80000 + i), Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
            var ask = await rig.Create(rig.Add("Admin"), input);
            Assert.True(ask.HttpStatus < 300, ask.Reason);
            var want = rig.Ledger.Find(ask.RequestId!)!;
            var persisted = switched ? want.Input with { Numbering = null, Episodes = new[] { new RequestEpisode(1, 2) }, From = want.Input.Episodes } : want.Input;
            rig.Db.Write((c,t) => {
                RequestLedger.Exec(c,t,"UPDATE wants SET mutation_input=$i,owned_input=$i,status='sent',reason='looking' WHERE id=$w",("$i",persisted.Canonical),("$w",want.Id));
                RequestLedger.Exec(c,t,"UPDATE jobs SET mutation_input=$i,fingerprint=$f,state='succeeded' WHERE want_id=$w",("$i",persisted.Canonical),("$f",persisted.Fingerprint),("$w",want.Id));
                RequestLedger.Exec(c,t,"INSERT INTO episode_identities(acquisition_id,target_key,season,episode,to_season,to_episode,tvdb_id,learned_at) VALUES($a,$t,1,1,1,2,0,0)",("$a",want.AcquisitionId),("$t",want.TargetKey));
                return true;
            });
        }
        var revision = rig.Ledger.Revision;
        var events = TableCount(rig.Db, "request_events");
        rig.Reopen();
        Assert.Equal(0, TableCount(rig.Db, "episode_identities"));
        Assert.Equal(250, TableCount(rig.Db, "jobs"));
        Assert.Equal(events + 125, TableCount(rig.Db, "request_events"));
        Assert.True(rig.Ledger.Revision > revision);
        revision = rig.Ledger.Revision;
        for (var i = 0; i < 4; i++) rig.Reopen();
        Assert.Equal(250, TableCount(rig.Db, "jobs"));
        Assert.Equal(events + 125, TableCount(rig.Db, "request_events"));
        Assert.Equal(revision, rig.Ledger.Revision);
    }

    [Fact]
    public async Task EIR4_DroppedMatchCannotConfirmTheDifferentEpisodeNowAtItsOldDestination()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(); ExistingFirefly(lab);
        var (r, _) = Ledger(lab); using var rig = r;
        var one = new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        var a = await rig.Create(rig.Admin, one);
        var runner = rig.Runner(Direct(lab, Tmdb(new() { [(1, 1)] = 297990, [(1, 12)] = 297999 })));
        await runner.TickAsync(default);
        lab.Sonarr.Episodes.Remove(lab.Sonarr.Episodes.Single(e => (int)e["id"]! == 4002));
        var replacement = lab.Sonarr.Episodes.Single(e => (int)e["id"]! == 4003);
        replacement["episodeNumber"] = 2;
        Assert.False((bool)replacement["monitored"]!);
        rig.Now = rig.Now.AddSeconds(1);
        await rig.Create(rig.Add("Admin"), one with { Episodes = new[] { new RequestEpisode(1, 12) } });
        await runner.TickAsync(default);
        Assert.Equal(EpisodeIdentity.Tmdb, rig.Ledger.Find(a.RequestId!)!.Input.Numbering);
        rig.Service.Numbering = (_,_,_) => Task.FromResult((true,false));
        var b = await rig.Create(rig.Member, one with { Episodes = new[] { new RequestEpisode(1, 2) } });
        Assert.True(b.HttpStatus < 300, b.Reason);
        var want = rig.Ledger.Find(b.RequestId!)!;
        Assert.True(want.Status != "sent" && rig.Ledger.ForWant(want.Id).Count > 0, $"Replacement episode 4003 was never monitored or searched, but request is {want.Status}/{want.Reason} with {rig.Ledger.ForWant(want.Id).Count} jobs");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task EIR4_KnownUnsentLeftoverCannotDispatchTwiceOrSurviveFulfilment(bool fulfil)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(); ExistingFirefly(lab);
        var (r, _) = Ledger(lab); using var rig = r;
        var one = new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        var b = await rig.Create(rig.Member, one);
        await rig.Runner(Direct(lab, (_,_,_,_) => Task.FromResult(EpisodeExternalId.Unusable))).TickAsync(default);
        rig.Now = rig.Now.AddSeconds(1);
        var a = await rig.Create(rig.Add("Member"), one);
        var runner = rig.Runner(Direct(lab, Tmdb(new() { [(1, 1)] = 297990 })));
        await runner.TickAsync(default);
        var want = rig.Ledger.Find(b.RequestId!)!;
        Assert.Equal("sent", want.Status);
        Assert.Null(want.Input.Numbering);
        var job = rig.Ledger.ForWant(want.Id).Single();
        Assert.Equal(new[] { new RequestEpisode(1, 2) }, job.Input.Episodes);
        // Exercise the stated allowance for a queued known-unsent leftover, already present when Ready arrives.
        rig.Db.Write((c,t) => RequestLedger.Exec(c,t,"UPDATE jobs SET state='queued',next_attempt=$at WHERE id=$j",("$at",RequestLedger.Ms(rig.Now)),("$j",job.Id)));
        if (fulfil) Assert.True(rig.Ledger.Fulfil(want.Id, rig.Now, want));
        lab.Sonarr.Writes.Clear();
        await runner.TickAsync(default);
        Assert.True(!fulfil || rig.Ledger.Find(want.Id)!.Status == "fulfilled", $"Fulfilled request became {rig.Ledger.Find(want.Id)!.Status}; leftover job={rig.Ledger.Job(job.Id)!.State}; upstream writes={lab.Sonarr.Writes.Count}");
        Assert.Empty(lab.Sonarr.Writes);
        Assert.Equal("cancelled", rig.Ledger.Job(job.Id)!.State);
    }

    [Fact]
    public async Task EIR4_AKnownUnsentHeldSharerDoesNotKeepAChargeAfterItFulfils()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(); ExistingFirefly(lab);
        var (r, _) = Ledger(lab); using var rig = r;
        var one = new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        var b = await rig.Create(rig.Member, one);
        await rig.Runner(Direct(lab, (_,_,_,_) => Task.FromResult(EpisodeExternalId.Unusable))).TickAsync(default);
        rig.Now = rig.Now.AddSeconds(1);
        await rig.Create(rig.Add("Member"), one);
        await rig.Runner(Direct(lab, Tmdb(new() { [(1, 1)] = 297990 }))).TickAsync(default);
        var want = rig.Ledger.Find(b.RequestId!)!;
        Assert.Equal("sent", want.Status);
        Assert.True(rig.Ledger.Fulfil(want.Id, rig.Now, want));
        var charged = rig.Db.Read(c => { using var cmd = RequestLedger.Cmd(c,null,"SELECT COALESCE(SUM(episode_count),0) FROM reservations WHERE want_id=$w AND state='charged'",("$w",want.Id)); return Convert.ToInt32(cmd.ExecuteScalar()); });
        Assert.True(charged == 0 && rig.Ledger.ForWant(want.Id).All(j => j.State == "cancelled"), $"Fulfilled sharer retains charged episode slots {charged} and known-unsent job {rig.Ledger.ForWant(want.Id).Single().State}; close={rig.Service.Close(want.Id,rig.Member,null).Reason}");
    }

    [Fact]
    public async Task EIR4_ParkedSharedRequestHasRecoveryAfterItsSentLeaderFulfilsAndMatchIsLost()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(); ExistingFirefly(lab);
        var (r, _) = Ledger(lab); using var rig = r;
        var one = new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        var b = await rig.Create(rig.Member, one);
        await rig.Runner(Direct(lab, (_,_,_,_) => Task.FromResult(EpisodeExternalId.Unusable))).TickAsync(default);
        rig.Now = rig.Now.AddSeconds(1);
        var a = await rig.Create(rig.Add("Member"), one);
        var runner = rig.Runner(Direct(lab, Tmdb(new() { [(1, 1)] = 297990, [(1, 12)] = 297999 })));
        await runner.TickAsync(default);
        var leader = rig.Ledger.Find(a.RequestId!)!;
        Assert.True(rig.Ledger.Fulfil(leader.Id, rig.Now, leader));
        lab.Sonarr.Episodes.Remove(lab.Sonarr.Episodes.Single(e => (int)e["id"]! == 4002));
        rig.Now = rig.Now.AddSeconds(1);
        await rig.Create(rig.Add("Admin"), one with { Episodes = new[] { new RequestEpisode(1, 12) } });
        await runner.TickAsync(default);
        var want = rig.Ledger.Find(b.RequestId!)!;
        Assert.Equal(EpisodeIdentity.Tmdb, want.Input.Numbering);
        var approved = await rig.Service.ApproveAsync(want.Id, rig.Admin, null, default);
        Assert.True(want.Status == "pending" || rig.Ledger.ForWant(want.Id).Any(j => j.State is "queued" or "retry" or "maybe_sent"), $"Lost match leaves {want.Status}/{want.Reason}, parked leftover, approve={approved.Reason}, no leader recovery");
    }

    [Theory]
    [InlineData("interactive")]
    [InlineData("list")]
    [InlineData("automation")]
    [InlineData("sync")]
    public async Task EIR4_AllAskOriginsStripCallerProvenance(string kind)
    {
        using var rig = new IntegrationRequestLedgerTests.Rig();
        var forged = new MutationInput { Key = "tv:tvdb:78874", Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 3) }, From = new[] { new RequestEpisode(-100, -100) }, Numbering = "forged" };
        var origin = kind == "interactive" ? null : new RequestOrigin(kind, kind == "automation" ? "next-season" : "list:review");
        var ask = await rig.Service.CreateAsync(rig.Member, new CreateRequest("origin-" + kind, forged), default, origin);
        Assert.True(ask.HttpStatus < 300, ask.Reason);
        var want = rig.Ledger.Find(ask.RequestId!)!;
        Assert.Equal(kind, want.OriginKind);
        Assert.Null(want.Input.From);
        Assert.Null(want.Input.Numbering);
        Assert.Equal(forged.Episodes, want.Input.Episodes);
        Assert.All(rig.Ledger.ForWant(want.Id), j => Assert.Null(j.Input.From));
    }

    [Fact]
    public async Task EIR4_UnchangedApprovalKeepsStoredProvenanceIgnoringForgedFrom()
    {
        using var rig = new IntegrationRequestLedgerTests.Rig();
        var input = new MutationInput { Key = "tv:tvdb:78874", Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 2) } };
        var ask = await rig.Create(rig.Kid, input);
        var stored = rig.Ledger.Find(ask.RequestId!)!.Input with { From = new[] { new RequestEpisode(1, 1) } };
        rig.Db.Write((c,t) => RequestLedger.Exec(c,t,"UPDATE wants SET mutation_input=$i WHERE id=$w",("$i",stored.Canonical),("$w",ask.RequestId!)));
        var approved = await rig.Service.ApproveAsync(ask.RequestId!, rig.Admin, new ApproveRequest(input with { From = new[] { new RequestEpisode(1, 99) } }), default);
        Assert.True(approved.HttpStatus < 300, approved.Reason);
        Assert.Equal(stored.From, rig.Ledger.Find(ask.RequestId!)!.Input.From);
        Assert.All(rig.Ledger.ForWant(ask.RequestId!), j => Assert.Equal(stored.From, j.Input.From));
    }

    private sealed class EIR4Activator(IntegrationRequestLedgerTests.Rig rig) : Microsoft.AspNetCore.Mvc.Controllers.IControllerActivator
    {
        public object Create(Microsoft.AspNetCore.Mvc.ControllerContext context)
        {
            var controller = rig.Controller(rig.Admin);
            controller.ControllerContext = context;
            return controller;
        }
        public void Release(Microsoft.AspNetCore.Mvc.ControllerContext context, object controller) { }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task EIR4_MalformedApprovalThroughRealMvcIsA400(bool nullElement)
    {
        using var rig = new IntegrationRequestLedgerTests.Rig();
        var input = new MutationInput { Key = "tv:tvdb:78874", Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 2) } };
        var asked = await rig.Create(rig.Kid, input);
        var stored = rig.Ledger.Find(asked.RequestId!)!.Input with { From = new[] { new RequestEpisode(1, 1) } };
        rig.Db.Write((c,t) => RequestLedger.Exec(c,t,"UPDATE wants SET mutation_input=$i WHERE id=$w",("$i",stored.Canonical),("$w",asked.RequestId!)));
        Exception? actionError = null;
#pragma warning disable ASPDEPR004, ASPDEPR008
        using var server = new TestServer(new WebHostBuilder().ConfigureServices(services => {
            services.AddRouting(); services.AddAuthorization();
            services.AddControllers().AddApplicationPart(typeof(Jellyfin.Plugin.JellyfinEnhanced.Controllers.AcquireRequestsController).Assembly);
            services.AddSingleton<Microsoft.AspNetCore.Mvc.Controllers.IControllerActivator>(new EIR4Activator(rig));
        }).Configure(app => {
            app.UseRouting();
            app.Use(async (ctx,next) => {
                ctx.User = TestCallers.Principal(rig.Admin,true);
                try { await next(); } catch(Exception ex) { actionError = ex; ctx.Response.StatusCode = 500; }
            });
            app.UseAuthorization(); app.UseEndpoints(e => e.MapControllers());
        }));
#pragma warning restore ASPDEPR004, ASPDEPR008
        using var client = server.CreateClient();
        var body = new ApproveRequest(input with { Episodes = nullElement ? new RequestEpisode[] { null! } : null! });
        using var response = await client.PostAsync("/JellyfinEnhanced/acquire/requests/" + asked.RequestId + "/approve", new StringContent(JsonSerializer.Serialize(body), System.Text.Encoding.UTF8,"application/json"));
        Assert.True((int)response.StatusCode == 400, $"MVC status={(int)response.StatusCode}; action error={actionError?.GetType().Name}: {actionError?.Message}");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task EIR4_ReadBackPermanentIdentityFailureHoldsOnFirstAttempt(bool noId)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(); ExistingFirefly(lab);
        var direct = Direct(lab, (_,_,_,_) => Task.FromResult(noId ? EpisodeExternalId.None : EpisodeExternalId.Unusable));
        var job = lab.Job(Ask((1, 1)), "Sonarr") with { Attempts = 0, Uncertain = true };
        var result = await direct.ReadBackAsync(job, default);
        Assert.True(result.Parked);
        Assert.Equal(EpisodeIdentity.Unresolved, result.Outcome.Reason);
        Assert.Equal(ArrActionStatus.Unknown, result.Outcome.Certainty);
        Assert.False(result.VerifiedNotSent);
        Assert.Empty(lab.Sonarr.Writes);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task EIR4_ReadBackTransientIdentityFailureWaitsOnceThenHolds(bool missing)
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(); ExistingFirefly(lab, withTvdbIds: !missing);
        var direct = Direct(lab, (_,_,_,_) => Task.FromResult(missing ? new EpisodeExternalId(true,297990) : EpisodeExternalId.Unread));
        var job = lab.Job(Ask((1, 1)), "Sonarr") with { Attempts = 0, Uncertain = true };
        var result = await direct.ReadBackAsync(job, default);
        Assert.Equal(EpisodeIdentity.Pending, result.Outcome.Reason);
        Assert.True(result.Resumes);
        Assert.Equal(ArrActionStatus.Unknown, result.Outcome.Certainty);
        var second = await direct.ReadBackAsync(job with { Attempts = 1, Reason = result.Outcome.Reason }, default);
        Assert.True(second.Parked);
        Assert.Equal(EpisodeIdentity.Unresolved, second.Outcome.Reason);
        Assert.Equal(ArrActionStatus.Unknown, second.Outcome.Certainty);
        Assert.Empty(lab.Sonarr.Writes);
    }

    [Fact]
    public async Task EIR4_StartupPreviewRecoveryDoesNotRequeueAnotherTargetsValidMatch()
    {
        using var rig = new IntegrationRequestLedgerTests.Rig();
        var secondUser = rig.Add("Admin");
        rig.Policy.Adjust = (user,input,facts) => facts with { InstanceId = user == secondUser ? "sonarr-second" : "sonarr-first", ConnectionGeneration = "generation" };
        rig.Service.Numbering = (_,_,_) => Task.FromResult((true,true));
        var input = new MutationInput { Key = "tv:tvdb:78874", Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        var a = await rig.Create(rig.Admin,input);
        var b = await rig.Create(secondUser,input);
        var wa = rig.Ledger.Find(a.RequestId!)!;
        var wb = rig.Ledger.Find(b.RequestId!)!;
        Assert.Equal(wa.AcquisitionId,wb.AcquisitionId);
        Assert.NotEqual(wa.TargetKey,wb.TargetKey);
        foreach(var want in new[] {wa,wb})
        {
            var valid = want.Id == wb.Id;
            var switched = want.Input with { Numbering = null, From = input.Episodes, Episodes = new[] {new RequestEpisode(1,valid ? 3 : 2)} };
            rig.Db.Write((c,t) => {
                RequestLedger.Exec(c,t,"UPDATE wants SET mutation_input=$i,owned_input=$i,status='sent',reason='looking' WHERE id=$w",("$i",switched.Canonical),("$w",want.Id));
                RequestLedger.Exec(c,t,"UPDATE jobs SET mutation_input=$i,fingerprint=$f,state='succeeded' WHERE want_id=$w",("$i",switched.Canonical),("$f",switched.Fingerprint),("$w",want.Id));
                RequestLedger.Exec(c,t,"INSERT INTO episode_identities(acquisition_id,target_key,season,episode,to_season,to_episode,tvdb_id,learned_at) VALUES($a,$t,1,1,1,$e,$id,0)",("$a",want.AcquisitionId),("$t",want.TargetKey),("$e",valid ? 3 : 2),("$id",valid ? 297990 : 0));
                return true;
            });
        }
        rig.Reopen();
        Assert.Equal(1,TableCount(rig.Db,"episode_identities"));
        var kept = rig.Ledger.Find(wb.Id)!;
        Assert.True(kept.Status == "sent" && kept.Input.Numbering == null && rig.Ledger.ForWant(wb.Id).Count == 1,$"Unchanged second-target mapping remains, but request={kept.Status}/{kept.Input.Numbering}, jobs={rig.Ledger.ForWant(wb.Id).Count}");
        Assert.Equal(new[] {new RequestEpisode(1,3)},kept.Input.Episodes);
    }

    [Fact]
    public async Task EIR4_QueuedLeftoverCannotSearchTheWrongEpisodeAfterItsLeaderFulfilsAndTheMatchIsLost()
    {
        using var lab = new IntegrationRequestBackendsTests.Lab(); ExistingFirefly(lab);
        var (r, _) = Ledger(lab); using var rig = r;
        var one = new MutationInput { Key = "tv:tvdb:" + Tvdb, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        var b = await rig.Create(rig.Member, one);
        await rig.Runner(Direct(lab, (_,_,_,_) => Task.FromResult(EpisodeExternalId.Unusable))).TickAsync(default);
        rig.Now = rig.Now.AddSeconds(1);
        var a = await rig.Create(rig.Add("Member"), one);
        var runner = rig.Runner(Direct(lab, Tmdb(new() { [(1, 1)] = 297990, [(1, 12)] = 297999 })));
        await runner.TickAsync(default);
        var leftover = rig.Ledger.ForWant(b.RequestId!).Single();
        // The supported sent + queued-known-unsent state, not a post-fulfilment job resurrection.
        rig.Db.Write((c,t) => RequestLedger.Exec(c,t,"UPDATE jobs SET state='queued',next_attempt=$at WHERE id=$j",("$at",RequestLedger.Ms(rig.Now.AddMinutes(1))),("$j",leftover.Id)));
        var leader = rig.Ledger.Find(a.RequestId!)!;
        Assert.True(rig.Ledger.Fulfil(leader.Id, rig.Now, leader));
        lab.Sonarr.Episodes.Remove(lab.Sonarr.Episodes.Single(e => (int)e["id"]! == 4002));
        lab.Sonarr.Episodes.Single(e => (int)e["id"]! == 4003)["episodeNumber"] = 2;
        rig.Now = rig.Now.AddSeconds(1);
        await rig.Create(rig.Add("Admin"), one with { Episodes = new[] { new RequestEpisode(1, 12) } });
        await runner.TickAsync(default);
        Assert.Equal(EpisodeIdentity.Tmdb,rig.Ledger.Find(b.RequestId!)!.Input.Numbering);
        lab.Sonarr.Writes.Clear();
        rig.Now = rig.Now.AddMinutes(2);
        await runner.TickAsync(default);
        var searches = lab.Sonarr.Writes.Where(w => w.Path == "/api/v3/command" && w.Body.Contains("EpisodeSearch",StringComparison.Ordinal)).Select(w => w.Body).ToArray();
        Assert.True(!searches.Any(s => Ids(JsonNode.Parse(s)!["episodeIds"]).Contains(4003)), $"TMDB E1 lost TVDB 297990, but leftover searched replacement episode 4003; job numbering={rig.Ledger.Job(leftover.Id)!.Input.Numbering ?? "Sonarr"}");
    }
}
